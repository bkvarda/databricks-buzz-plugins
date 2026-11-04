// The Databricks agent's creation and settings form. One agent type with a
// kind: a Sandbox agent (a model with its own Sandbox and the tools you pick),
// Genie One (nothing to set up), or a custom agent you already have on
// Databricks. Every kind can work in its own workspace.
import { Ai, type ChatModel, DEFAULT_MODELS } from "@dbx/core/api/ai";
import { Genie } from "@dbx/core/api/genie";
import { functionsServer, McpCatalog, type McpServer } from "@dbx/core/api/mcp-catalog";
import { Sandboxes } from "@dbx/core/api/sandbox";
import { React } from "@dbx/core/react";
import { type DatabricksService, describeError, useAsync, useConnection } from "@dbx/core/service";
import { Badge, Button, DbxRoot, Field, Notice, Spinner, Stack, Text } from "@dbx/core/ui/components";
import { GENIE_ONE_CHOICE, type ToolChoice } from "./capabilities";

export type AgentKind = "sandbox" | "genie-one" | "custom";

export const KINDS: readonly Readonly<{ id: AgentKind; label: string; detail: string }>[] = [
  {
    id: "sandbox",
    label: "Sandbox agent",
    detail: "A model on AI Gateway with its own Databricks Sandbox to run code, plus Buzz's tools and the Genie and MCP servers you pick.",
  },
  {
    id: "genie-one",
    label: "Genie One",
    detail: "Answers data questions about anything you can access in the workspace, with a chart, the SQL and a link. Nothing to set up.",
  },
  {
    id: "custom",
    label: "Custom agent",
    detail: "An agent you already have on Databricks: Agent Bricks or Model Serving, a Databricks App, or a Genie agent.",
  },
];

export type CustomAgent = Readonly<{
  kind: "endpoint" | "app" | "genie";
  /** Endpoint name, app URL, or Genie space ID. */
  target: string;
  label: string;
  /** Serving endpoints: the task, which decides the request format. */
  task?: string;
}>;

export type DatabricksConfig = {
  kind: AgentKind;
  /** A CLI profile for another workspace; unset uses Buzz's connection. */
  profile?: string;
  // Sandbox agents
  model: string;
  instructions: string;
  scope: "thread" | "channel";
  /** Genie and MCP servers it can use, beyond Buzz's tools. */
  tools: ToolChoice[];
  // Custom agents
  custom?: CustomAgent;
};

type FormProps<C> = { config: C; onChange(config: C): void; disabled?: boolean };

function NeedsConnection(props: { service: DatabricksService }) {
  const snapshot = useConnection(props.service);
  if (snapshot.status === "connected") return null;
  return (
    <Notice tone="warning" title="Databricks isn't connected" action={<Button size="sm" variant="brand" onClick={() => props.service.openSettings()}>Connect</Button>}>
      These agents run on Databricks with your sign-in.
    </Notice>
  );
}

export function AgentForm(props: FormProps<DatabricksConfig> & { service: DatabricksService }) {
  const { config, onChange } = props;
  const workspace = useAgentService(props.service, config.profile);
  const kind = KINDS.find((candidate) => candidate.id === config.kind) ?? KINDS[1]!;
  return (
    <DbxRoot>
      <Stack gap={14}>
        <NeedsConnection service={props.service} />
        <Field label="Type" hint={kind.detail}>
          <select className="dbx-select" disabled={props.disabled} value={kind.id} onChange={(event) => onChange({ ...config, kind: event.target.value as AgentKind })}>
            {KINDS.map((candidate) => (
              <option key={candidate.id} value={candidate.id}>
                {candidate.label}
              </option>
            ))}
          </select>
        </Field>
        <WorkspaceField
          service={props.service}
          {...(config.profile && { profile: config.profile })}
          disabled={props.disabled}
          onChange={(profile) => {
            // Genie agents, servers and custom agents belong to a workspace; keep only Genie One.
            const { profile: _profile, custom: _custom, ...rest } = config;
            onChange({ ...rest, ...(profile && { profile }), tools: config.tools.filter((tool) => tool.kind === "genie-one") });
          }}
        />
        {kind.id === "sandbox" && <SandboxFields workspace={workspace} config={config} onChange={onChange} {...(props.disabled !== undefined && { disabled: props.disabled })} />}
        {kind.id === "custom" && (
          <CustomAgentField
            service={workspace}
            {...(config.custom && { value: config.custom })}
            {...(props.disabled !== undefined && { disabled: props.disabled })}
            onChange={(custom) => onChange({ ...config, custom })}
          />
        )}
        {kind.id !== "sandbox" && (
          <Text tone="subtle" size="sm">
            Mention it in any thread or add it to a room. Each thread keeps its own conversation for follow-ups.
          </Text>
        )}
      </Stack>
    </DbxRoot>
  );
}

function SandboxFields(props: FormProps<DatabricksConfig> & { workspace: DatabricksService }) {
  const { config, onChange, workspace } = props;
  const status = useConnection(workspace).status;
  const available = useAsync(async (signal) => new Sandboxes(await workspace.ready(signal)).available(signal), [workspace, status]);
  return (
    <>
      {available.data === false && (
        <Notice tone="warning" title="Databricks Sandbox isn't on in this workspace">
          A workspace admin can turn on the Databricks Sandbox preview. Until then the agent works without running code.
        </Notice>
      )}
      <ModelField service={workspace} value={config.model} {...(props.disabled !== undefined && { disabled: props.disabled })} onChange={(model) => onChange({ ...config, model })} />
      <ToolsField service={workspace} tools={config.tools} {...(props.disabled !== undefined && { disabled: props.disabled })} onChange={(tools) => onChange({ ...config, tools })} />
      <Field label="Conversation" hint="Thread: each thread is its own conversation. Channel: one conversation for the whole channel.">
        <select className="dbx-select" disabled={props.disabled} value={config.scope} onChange={(event) => onChange({ ...config, scope: event.target.value as DatabricksConfig["scope"] })}>
          <option value="thread">One per thread</option>
          <option value="channel">One per channel</option>
        </select>
      </Field>
      <Field label="Instructions" hint="Optional. Who it is, what it should focus on, how to answer.">
        <textarea className="dbx-textarea" rows={5} disabled={props.disabled} value={config.instructions} onChange={(event) => onChange({ ...config, instructions: event.target.value })} />
      </Field>
    </>
  );
}

/** A settings tab: the form with an explicit Save. */
export function SettingsTab<C>(props: {
  service: DatabricksService;
  config: C;
  save(config: C): Promise<void>;
  Form(props: FormProps<C> & { service: DatabricksService }): React.ReactNode;
  note?: React.ReactNode;
}) {
  const [draft, setDraft] = React.useState(props.config);
  const [state, setState] = React.useState<{ saving?: boolean; error?: string; saved?: boolean }>({});
  const dirty = JSON.stringify(draft) !== JSON.stringify(props.config);
  return (
    <DbxRoot style={{ padding: "4px 0 24px" }}>
      <Stack gap={16}>
        <props.Form service={props.service} config={draft} onChange={setDraft} disabled={state.saving} />
        {props.note}
        {state.error && <Notice tone="danger">{state.error}</Notice>}
        <Stack direction="row" gap={8} justify="flex-end" align="center">
          {state.saved && !dirty && (
            <Text tone="success" size="sm">
              Saved
            </Text>
          )}
          <Button variant="ghost" disabled={!dirty || state.saving} onClick={() => setDraft(props.config)}>
            Revert
          </Button>
          <Button
            variant="primary"
            disabled={!dirty || state.saving}
            onClick={() => {
              setState({ saving: true });
              props.save(draft).then(
                () => setState({ saved: true }),
                (error: unknown) => setState({ error: describeError(error) }),
              );
            }}
          >
            {state.saving ? "Saving…" : "Save"}
          </Button>
        </Stack>
      </Stack>
    </DbxRoot>
  );
}

// ── Workspace ──

/** The service an agent form should list things from. */
export function useAgentService(service: DatabricksService, profile: string | undefined): DatabricksService {
  return React.useMemo(() => (profile && service.forProfile ? service.forProfile(profile) : service), [service, profile]);
}

const ADD = "__add__";

export function WorkspaceField(props: { service: DatabricksService; profile?: string; onChange(profile: string | undefined): void; disabled?: boolean }) {
  const main = useConnection(props.service);
  const workspace = useAgentService(props.service, props.profile);
  const current = useConnection(workspace);
  const [adding, setAdding] = React.useState(false);
  const [url, setUrl] = React.useState("");
  const [state, setState] = React.useState<{ busy?: boolean; error?: string }>({});
  if (!props.service.forProfile) return null;
  const host = (snapshot: typeof main) => ("profile" in snapshot ? new URL(snapshot.profile.host).hostname : undefined);
  const profiles = props.service.profiles();
  const mainName = main.status === "connected" ? main.profile.name : undefined;
  const signIn = async () => {
    setState({ busy: true });
    try {
      const profile = await props.service.addWorkspace!(url.trim() ? { host: url.trim() } : {});
      props.onChange(profile === mainName ? undefined : profile);
      setAdding(false);
      setUrl("");
      setState({});
    } catch (error) {
      setState({ error: describeError(error) });
    }
  };
  return (
    <Field label="Workspace" hint="The Databricks workspace it works in, with your Databricks CLI sign-in there. Same as Buzz uses Buzz's Databricks connection.">
      <Stack gap={8}>
        <select
          className="dbx-select"
          disabled={props.disabled}
          value={adding ? ADD : (props.profile ?? "")}
          onChange={(event) => {
            const value = event.target.value;
            if (value === ADD) return setAdding(true);
            setAdding(false);
            props.onChange(value && value !== mainName ? value : undefined);
          }}
        >
          <option value="">Same as Buzz{host(main) ? ` · ${host(main)}` : ""}</option>
          {profiles
            .filter((profile) => profile.name !== mainName)
            .map((profile) => (
              <option key={profile.name} value={profile.name}>
                {profile.name} · {new URL(profile.host).hostname}
              </option>
            ))}
          <option value={ADD}>Sign in to another workspace…</option>
        </select>
        {adding && (
          <Stack direction="row" gap={8} align="center">
            <input className="dbx-input" placeholder="https://… (blank to choose in the browser)" value={url} onChange={(event) => setUrl(event.target.value)} style={{ flex: 1 }} />
            <Button variant="brand" disabled={state.busy} onClick={() => void signIn()}>
              {state.busy ? <Spinner size={12} /> : null}Sign in
            </Button>
          </Stack>
        )}
        {state.error && <Text tone="danger" size="sm">{state.error}</Text>}
        {props.profile && current.status === "connecting" && (
          <Stack direction="row" gap={6} align="center">
            <Spinner size={11} />
            <Text tone="subtle" size="sm">Connecting…</Text>
          </Stack>
        )}
        {props.profile && current.status === "connected" && (
          <Text tone="subtle" size="sm">Signed in to {host(current)} as {current.user.userName}.</Text>
        )}
        {props.profile && current.status === "error" && <Text tone="danger" size="sm">{current.message}</Text>}
      </Stack>
    </Field>
  );
}

// ── Searchable pickers ──

export type PickOption = Readonly<{
  id: string;
  label: string;
  /** Options show under their group's heading, in first-seen order. */
  group: string;
  detail?: string;
  badge?: React.ReactNode;
  /** Extra words the search matches. */
  keywords?: string;
  disabled?: boolean;
}>;

/** Options matching `query` (label, detail, keywords), in group order. */
export function filterOptions(options: readonly PickOption[], query: string): PickOption[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  const matches = words.length
    ? options.filter((option) => {
        const text = `${option.label} ${option.detail ?? ""} ${option.keywords ?? ""} ${option.group}`.toLowerCase();
        return words.every((word) => text.includes(word));
      })
    : [...options];
  const order = [...new Set(options.map((option) => option.group))];
  return matches.sort((a, b) => order.indexOf(a.group) - order.indexOf(b.group));
}

/** A labelled group (not a <label>, which can't hold several controls). */
function Section(props: { label: string; hint?: React.ReactNode; children: React.ReactNode; aside?: React.ReactNode }) {
  const id = React.useId();
  return (
    <div role="group" aria-labelledby={id} style={{ display: "flex", flexDirection: "column", gap: 4, minWidth: 0 }}>
      <Stack direction="row" justify="space-between" align="center">
        <Text size="sm" weight={500} id={id}>
          {props.label}
        </Text>
        {props.aside}
      </Stack>
      {props.children}
      {props.hint && (
        <Text size="xs" tone="subtle" as="div">
          {props.hint}
        </Text>
      )}
    </div>
  );
}

function OptionList(props: {
  options: readonly PickOption[];
  query: string;
  multi?: boolean;
  isSelected(id: string): boolean;
  onPick(option: PickOption): void;
  maxHeight: number;
  disabled?: boolean;
  label: string;
}) {
  const shown = filterOptions(props.options, props.query);
  let group = "";
  return (
    <div className="dbx-picker-list" role="listbox" aria-label={props.label} aria-multiselectable={props.multi || undefined} style={{ maxHeight: props.maxHeight }}>
      {shown.length === 0 && (
        <Text tone="subtle" size="sm" as="div" style={{ padding: "8px 10px" }}>
          {props.query ? `Nothing matches “${props.query}”.` : "Nothing to choose from here."}
        </Text>
      )}
      {shown.map((option) => {
        const heading = option.group !== group ? (group = option.group) : undefined;
        const selected = props.isSelected(option.id);
        return (
          <React.Fragment key={option.id}>
            {heading && <div className="dbx-picker-group">{heading}</div>}
            <button
              type="button"
              role="option"
              aria-selected={selected}
              className="dbx-picker-option"
              disabled={props.disabled || option.disabled}
              onClick={() => props.onPick(option)}
            >
              {props.multi && <input type="checkbox" tabIndex={-1} readOnly checked={selected} aria-hidden />}
              <span style={{ minWidth: 0, flex: 1 }}>
                <Stack direction="row" gap={6} align="center" wrap>
                  <Text weight={selected ? 600 : 500}>{option.label}</Text>
                  {option.badge}
                </Stack>
                {option.detail && (
                  <Text tone="subtle" size="xs" as="div" style={{ overflow: "hidden", textOverflow: "ellipsis", display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical" }}>
                    {option.detail}
                  </Text>
                )}
              </span>
            </button>
          </React.Fragment>
        );
      })}
    </div>
  );
}

function Loading(props: { text: string }) {
  return (
    <Stack direction="row" gap={8} align="center">
      <Spinner size={12} />
      <Text tone="subtle" size="sm">
        {props.text}
      </Text>
    </Stack>
  );
}

/** One choice from a searchable list that opens under its button. */
export function SinglePicker(props: {
  label: string;
  hint?: React.ReactNode;
  value?: string;
  valueLabel?: string;
  placeholder: string;
  options: readonly PickOption[];
  loading?: string | false;
  error?: string;
  disabled?: boolean;
  onChange(option: PickOption): void;
}) {
  const [open, setOpen] = React.useState(false);
  const [query, setQuery] = React.useState("");
  const close = () => (setOpen(false), setQuery(""));
  const current = props.options.find((option) => option.id === props.value);
  return (
    <Section label={props.label} hint={props.hint}>
      <button
        type="button"
        className="dbx-select dbx-picker-trigger"
        aria-expanded={open}
        disabled={props.disabled}
        onClick={() => (open ? close() : setOpen(true))}
      >
        <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", color: props.value ? undefined : "var(--dbx-subtle)" }}>
          {current?.label ?? props.valueLabel ?? (props.value || props.placeholder)}
        </span>
        <span aria-hidden style={{ color: "var(--dbx-subtle)", fontSize: "0.7em" }}>
          {open ? "▲" : "▼"}
        </span>
      </button>
      {open && (
        <div
          className="dbx-picker"
          onKeyDown={(event) => {
            if (event.key === "Escape") (event.stopPropagation(), close());
          }}
        >
          <input
            className="dbx-input"
            autoFocus
            placeholder={`Search ${props.options.length}`}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key !== "Enter") return;
              event.preventDefault();
              const first = filterOptions(props.options, query).find((option) => !option.disabled);
              if (first) (props.onChange(first), close());
            }}
          />
          {props.loading ? (
            <div style={{ padding: "8px 10px" }}>
              <Loading text={props.loading} />
            </div>
          ) : (
            <OptionList label={props.label} options={props.options} query={query} isSelected={(id) => id === props.value} onPick={(option) => (props.onChange(option), close())} maxHeight={260} {...(props.disabled !== undefined && { disabled: props.disabled })} />
          )}
        </div>
      )}
      {props.error && <Text tone="danger" size="sm">{props.error}</Text>}
    </Section>
  );
}

/** Several choices: chips for what's chosen, then a searchable, scrolling list. */
export function MultiPicker(props: {
  label: string;
  hint?: React.ReactNode;
  selected: readonly PickOption[];
  options: readonly PickOption[];
  loading?: string | false;
  notes?: readonly string[];
  disabled?: boolean;
  onToggle(option: PickOption, on: boolean): void;
  footer?: React.ReactNode;
}) {
  const [query, setQuery] = React.useState("");
  const chosen = new Set(props.selected.map((option) => option.id));
  return (
    <Section
      label={props.label}
      hint={props.hint}
      aside={
        <Text tone="subtle" size="xs">
          {props.selected.length} selected
        </Text>
      }
    >
      {props.selected.length > 0 && (
        <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
          {props.selected.map((option) => (
            <span key={option.id} className="dbx-chip" title={option.detail ?? option.label}>
              <span>{option.label}</span>
              <button type="button" aria-label={`Remove ${option.label}`} disabled={props.disabled} onClick={() => props.onToggle(option, false)}>
                ×
              </button>
            </span>
          ))}
        </div>
      )}
      <div className="dbx-picker">
        <input className="dbx-input" placeholder={`Search ${props.options.length}`} value={query} onChange={(event) => setQuery(event.target.value)} />
        <OptionList
          label={props.label}
          multi
          options={props.options}
          query={query}
          isSelected={(id) => chosen.has(id)}
          onPick={(option) => props.onToggle(option, !chosen.has(option.id))}
          maxHeight={240}
          {...(props.disabled !== undefined && { disabled: props.disabled })}
        />
        {props.loading && (
          <div style={{ padding: "6px 10px", borderTop: "1px solid var(--dbx-border)" }}>
            <Loading text={props.loading} />
          </div>
        )}
      </div>
      {(props.notes ?? []).map((note) => (
        <Text key={note} tone="tertiary" size="xs">
          {note}
        </Text>
      ))}
      {props.footer}
    </Section>
  );
}

// ── Model, tools and custom agent ──

const RECOMMENDED = new Set<string>(DEFAULT_MODELS.map((model) => model.id));

/** Chat models from AI Gateway (Unity Catalog model services) as options. */
export function modelOptions(models: readonly ChatModel[] | undefined): PickOption[] {
  const listed = models ?? DEFAULT_MODELS.map((model) => ({ id: model.id, label: model.label, tools: true, builtIn: true }));
  const byId = new Map(listed.map((model) => [model.id, model]));
  const recommended = DEFAULT_MODELS.filter((model) => !models || byId.has(model.id)).map((model) => ({ id: model.id, label: model.label, group: "Recommended", keywords: model.id }));
  const rest = listed
    .filter((model) => !RECOMMENDED.has(model.id))
    .map((model) => ({
      id: model.id,
      label: model.label,
      group: model.builtIn ? "Databricks" : "Your workspace",
      keywords: model.id,
      ...(!model.builtIn && { detail: model.id }),
      ...(!model.tools && { disabled: true, badge: <Badge>No tool calling</Badge> }),
    }));
  return [...recommended, ...rest];
}

function ModelField(props: { service: DatabricksService; value: string; onChange(model: string): void; disabled?: boolean }) {
  const status = useConnection(props.service).status;
  const models = useAsync(async (signal) => new Ai(await props.service.ready(signal)).models(signal), [props.service, status]);
  const options = modelOptions(models.data);
  return (
    <SinglePicker
      label="Model"
      hint="AI Gateway models in this workspace, from Unity Catalog. Billed to the workspace."
      value={props.value}
      valueLabel={props.value}
      placeholder="Choose a model"
      options={options}
      loading={models.loading && !models.data ? "Loading models…" : false}
      {...(models.error && { error: `Couldn't list models: ${describeError(models.error)}` })}
      {...(props.disabled !== undefined && { disabled: props.disabled })}
      onChange={(option) => props.onChange(option.id)}
    />
  );
}

const asChoice = (server: McpServer): ToolChoice => ({ id: server.id, kind: server.kind, label: server.label, path: server.path });

function serverOption(server: McpServer): PickOption {
  const badge = server.needsLogin ? (
    <Badge>Needs your account</Badge>
  ) : server.id === "service:system.ai.dbsql" ? (
    <Badge tone="warning" title="Unlike the suite's own SQL tool, this server isn't read-only">
      Can change data
    </Badge>
  ) : undefined;
  return {
    id: server.id,
    label: server.label,
    group: server.builtIn ? "Databricks" : "Your workspace",
    keywords: server.id,
    ...(server.builtIn
      ? server.description && { detail: server.description }
      : { detail: `${server.kind === "connection" ? "External MCP connection" : "MCP service"}${server.description ? ` · ${server.description}` : ""}` }),
    ...(badge && { badge }),
  };
}

/** Genie One, Genie agents and MCP servers from the agent's workspace. */
export function ToolsField(props: { service: DatabricksService; tools: readonly ToolChoice[]; onChange(tools: ToolChoice[]): void; disabled?: boolean }) {
  const { service } = props;
  const status = useConnection(service).status;
  const spaces = useAsync(async (signal) => new Genie(await service.ready(signal)).listSpaces(signal), [service, status]);
  const catalog = useAsync(async (signal) => new McpCatalog(await service.ready(signal)).list(signal), [service, status]);
  const [schemaName, setSchemaName] = React.useState("");
  const choices = new Map<string, ToolChoice>([[GENIE_ONE_CHOICE.id, GENIE_ONE_CHOICE]]);
  const options: PickOption[] = [{ id: GENIE_ONE_CHOICE.id, label: "Genie One", group: "Genie", detail: "Questions about any data you can access in this workspace." }];
  for (const space of spaces.data ?? []) {
    const choice: ToolChoice = { id: `genie:${space.space_id}`, kind: "genie", label: space.title };
    choices.set(choice.id, choice);
    options.push({ id: choice.id, label: space.title, group: "Genie", detail: space.description || "Genie agent", keywords: "genie agent space" });
  }
  for (const server of catalog.data?.servers ?? []) {
    choices.set(server.id, asChoice(server));
    options.push(serverOption(server));
  }
  // Chosen things the lists don't show (functions, or ones still loading).
  for (const tool of props.tools)
    if (!choices.has(tool.id)) {
      choices.set(tool.id, tool);
      options.push({ id: tool.id, label: tool.label, group: tool.kind === "functions" ? "Unity Catalog functions" : "Chosen", ...(tool.kind === "functions" && { detail: "Unity Catalog functions" }) });
    }
  const selected = props.tools.map((tool) => options.find((option) => option.id === tool.id)!).filter(Boolean);
  const toggle = (id: string, on: boolean) => {
    const choice = choices.get(id);
    if (!choice) return;
    props.onChange(on ? [...props.tools.filter((tool) => tool.id !== id), choice] : props.tools.filter((tool) => tool.id !== id));
  };
  const loading = spaces.loading ? "Loading Genie agents…" : catalog.loading ? "Finding MCP servers…" : false;
  const notes = [
    ...(spaces.error ? [`Couldn't list Genie agents: ${describeError(spaces.error)}`] : []),
    ...(catalog.error ? [`Couldn't list MCP servers: ${describeError(catalog.error)}`] : []),
    ...(catalog.data?.errors ?? []).map((error) => `Couldn't list ${error}`),
  ];
  return (
    <MultiPicker
      label="Tools"
      hint="Genie and MCP servers in this workspace: Databricks-provided services, ones your team registered in Unity Catalog, and external MCP connections. They run with your access."
      selected={selected}
      options={options}
      loading={loading}
      notes={notes}
      {...(props.disabled !== undefined && { disabled: props.disabled })}
      onToggle={(option, on) => toggle(option.id, on)}
      footer={
        <Stack direction="row" gap={8} align="center">
          <input
            className="dbx-input"
            placeholder="catalog.schema with Unity Catalog functions"
            aria-label="Unity Catalog schema with functions"
            value={schemaName}
            onChange={(event) => setSchemaName(event.target.value.trim())}
            style={{ flex: 1 }}
          />
          <Button
            size="sm"
            disabled={props.disabled || !/^[\w-]+\.[\w-]+$/.test(schemaName)}
            onClick={() => {
              const [catalogName = "", schemaPart = ""] = schemaName.split(".");
              const choice = asChoice(functionsServer(catalogName, schemaPart));
              props.onChange([...props.tools.filter((tool) => tool.id !== choice.id), choice]);
              setSchemaName("");
            }}
          >
            Add functions
          </Button>
        </Stack>
      }
    />
  );
}

/** Agents the person already has on Databricks, as custom agent options. */
function CustomAgentField(props: { service: DatabricksService; value?: CustomAgent; onChange(agent: CustomAgent): void; disabled?: boolean }) {
  const { service } = props;
  const status = useConnection(service).status;
  const found = useAsync(
    async (signal) => {
      const client = await service.ready(signal);
      const ai = new Ai(client);
      const errors: string[] = [];
      const [endpoints, apps, spaces] = await Promise.all([
        ai.endpoints(signal).catch((error: unknown) => (errors.push(`serving endpoints: ${describeError(error)}`), [])),
        ai.apps(signal).catch((error: unknown) => (errors.push(`apps: ${describeError(error)}`), [])),
        new Genie(client).listSpaces(signal).catch((error: unknown) => (errors.push(`Genie agents: ${describeError(error)}`), [])),
      ]);
      const agents = new Map<string, CustomAgent>();
      const options: PickOption[] = [];
      // Agents on Model Serving, and custom chat endpoints (not foundation models).
      for (const endpoint of endpoints.filter((candidate) => candidate.isAgent || (candidate.isChat && !candidate.name.startsWith("databricks-")))) {
        const id = `endpoint:${endpoint.name}`;
        agents.set(id, { kind: "endpoint", target: endpoint.name, label: endpoint.name, task: endpoint.task });
        options.push({
          id,
          label: endpoint.name,
          group: "Agent Bricks and Model Serving",
          detail: [endpoint.description, endpoint.task].filter(Boolean).join(" · "),
          ...(!endpoint.ready && { badge: <Badge tone="warning">Not ready</Badge> }),
        });
      }
      for (const app of apps) {
        const id = `app:${app.url}`;
        agents.set(id, { kind: "app", target: app.url, label: app.name });
        options.push({ id, label: app.name, group: "Databricks Apps", detail: app.description || new URL(app.url).hostname, ...(!app.running && { badge: <Badge>Stopped</Badge> }) });
      }
      for (const space of spaces) {
        const id = `genie:${space.space_id}`;
        agents.set(id, { kind: "genie", target: space.space_id, label: space.title });
        options.push({ id, label: space.title, group: "Genie agents", detail: space.description || "Genie agent" });
      }
      return { agents, options, errors };
    },
    [service, status],
  );
  const value = props.value ? `${props.value.kind}:${props.value.target}` : undefined;
  return (
    <>
      <SinglePicker
        label="Agent"
        hint="Agents you can use in this workspace. It gets each message in the thread and its reply is posted as this agent."
        {...(value && { value })}
        {...(props.value && { valueLabel: props.value.label })}
        placeholder="Choose an agent"
        options={found.data?.options ?? []}
        loading={found.loading && !found.data ? "Finding your agents…" : false}
        {...(found.error && { error: describeError(found.error) })}
        {...(props.disabled !== undefined && { disabled: props.disabled })}
        onChange={(option) => {
          const agent = found.data?.agents.get(option.id);
          if (agent) props.onChange(agent);
        }}
      />
      {(found.data?.errors ?? []).map((error) => (
        <Text key={error} tone="tertiary" size="xs">
          Couldn't list {error}
        </Text>
      ))}
    </>
  );
}
