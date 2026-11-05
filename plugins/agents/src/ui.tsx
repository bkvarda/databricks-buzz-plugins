// The Databricks agent's creation and settings form. One agent type with a
// kind: a Sandbox agent (a model with its own Sandbox and the tools you pick),
// Genie One (nothing to set up), or a custom agent you already have on
// Databricks. Every kind can work in its own workspace.
import { Ai, type ChatModel, DEFAULT_MODELS } from "@dbx/core/api/ai";
import { Genie } from "@dbx/core/api/genie";
import { functionsServer, McpCatalog, type McpLoginState, mcpLoginPath, type McpServer, serviceName } from "@dbx/core/api/mcp-catalog";
import { Sandboxes } from "@dbx/core/api/sandbox";
import type { ConnectionSnapshot } from "@dbx/core/connection";
import { React } from "@dbx/core/react";
import { type DatabricksService, describeError, useAsync, useConnection } from "@dbx/core/service";
import { Badge, Button, DbxRoot, Field, Notice, openExternal, Spinner, Stack, Text } from "@dbx/core/ui/components";
import { GENIE_ONE_CHOICE, type ToolChoice } from "./capabilities";
import { HARNESS_MODEL, HARNESSES, type HarnessId, harnessAccepts, isRemote, type Permissions, permissionsHint } from "./remote";

export type AgentKind = "sandbox" | "genie-one" | "custom";

export const KINDS: readonly Readonly<{ id: AgentKind; label: string; detail: string }>[] = [
  {
    id: "sandbox",
    label: "Sandbox agent",
    detail: "A model with its own Databricks Sandbox to run code, plus the tools you pick.",
  },
  {
    id: "genie-one",
    label: "Genie One",
    detail: "Answers questions about any data you can access, with a chart, the SQL and a link. Nothing to set up.",
  },
  {
    id: "custom",
    label: "Custom agent",
    detail: "An agent you already have: Agent Bricks or Model Serving, a Databricks App, or a Genie agent.",
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
  /** What thinks: the built-in loop, or Claude Code, Codex or Pi in the Sandbox. */
  harness: HarnessId;
  /** For Claude Code, Codex and Pi: their guarded mode, or full access. */
  permissions: Permissions;
  model: string;
  instructions: string;
  scope: "thread" | "channel";
  /** Genie and MCP servers it can use, beyond Buzz's tools. */
  tools: ToolChoice[];
  // Custom agents
  custom?: CustomAgent;
};

type FormProps<C> = { config: C; onChange(config: C): void; disabled?: boolean };

/** While the connection is starting, lists show as loading rather than failed. */
const settling = (status: string) => status === "checking" || status === "connecting" || status === "signing-in";
/** Lists load while connected, or will once a starting connection finishes. */
const loads = (status: string) => status === "connected" || settling(status);

const hostname = (host: string) => new URL(host).hostname;

/** The browser is open for sign-in; the form waits, as Settings → Databricks does. */
function BrowserWait(props: { service: DatabricksService; host?: string }) {
  const { cancelSignIn } = props.service;
  return (
    <Stack direction="row" gap={8} align="center" justify="space-between">
      <Stack direction="row" gap={6} align="center">
        <Spinner size={11} />
        <Text tone="subtle" size="sm">
          Finish signing in in your browser{props.host ? ` (${hostname(props.host)})` : ""}.
        </Text>
      </Stack>
      {cancelSignIn && (
        <Button size="sm" variant="ghost" onClick={() => cancelSignIn()}>
          Cancel
        </Button>
      )}
    </Stack>
  );
}

/** Buzz's own Databricks connection, with the same sign-in Settings offers. */
export function NeedsConnection(props: { service: DatabricksService }) {
  const { service } = props;
  const snapshot = useConnection(service);
  if (snapshot.status === "signing-in") return <BrowserWait service={service} {...(snapshot.host && { host: snapshot.host })} />;
  if (snapshot.status === "connected" || settling(snapshot.status)) return null;
  const expired = snapshot.status === "error" && snapshot.needsSignIn && service.reauthenticate;
  const action = expired ? (
    <Button size="sm" variant="brand" onClick={() => void service.reauthenticate!()}>
      Sign in again
    </Button>
  ) : snapshot.status === "signed-out" ? (
    <Button size="sm" variant="brand" onClick={() => void service.signIn()}>
      Sign in with Databricks
    </Button>
  ) : (
    <Button size="sm" variant="brand" onClick={() => service.openSettings()}>
      Connect
    </Button>
  );
  return (
    <Notice tone="warning" title={expired ? "Your Databricks sign-in has expired" : "Databricks isn't connected"} action={action}>
      {snapshot.status === "signed-out" && snapshot.error ? snapshot.error : "These agents run on Databricks with your sign-in."}
    </Notice>
  );
}

/**
 * How the agent's own workspace connection is doing. An expired or missing
 * sign-in gets a button that runs the CLI's browser sign-in for that profile
 * (`databricks auth login --profile …`), the same flow as Settings.
 */
function WorkspaceStatus(props: { service: DatabricksService; snapshot: ConnectionSnapshot }) {
  const { service, snapshot } = props;
  const signIn = (label: string) =>
    service.reauthenticate ? (
      <Button size="sm" variant="brand" onClick={() => void service.reauthenticate!()}>
        {label}
      </Button>
    ) : undefined;
  switch (snapshot.status) {
    case "checking":
    case "connecting":
      return (
        <Stack direction="row" gap={6} align="center">
          <Spinner size={11} />
          <Text tone="subtle" size="sm">Connecting…</Text>
        </Stack>
      );
    case "signing-in":
      return <BrowserWait service={service} {...(snapshot.host && { host: snapshot.host })} />;
    case "connected":
      return (
        <Text tone="subtle" size="sm">
          Signed in to {hostname(snapshot.profile.host)} as {snapshot.user.userName}.
        </Text>
      );
    case "error":
      return (
        <Notice tone="warning" action={signIn(snapshot.needsSignIn ? "Sign in again" : "Sign in")}>
          {snapshot.needsSignIn ? "Your sign-in to this workspace has expired." : snapshot.message}
        </Notice>
      );
    case "signed-out":
      return (
        <Notice tone="warning" action={signIn("Sign in")}>
          {snapshot.error ?? "You're not signed in to this workspace."}
        </Notice>
      );
    default:
      return null;
  }
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
  const available = useAsync(() => cachedList(workspace, "sandbox", async () => new Sandboxes(await workspace.ready()).available()), [workspace, status]);
  const harness = HARNESSES.find((candidate) => candidate.id === config.harness) ?? HARNESSES[0]!;
  const remote = isRemote(harness.id) ? harness.id : undefined;
  const disabled = props.disabled !== undefined ? { disabled: props.disabled } : {};
  return (
    <>
      {available.data === false && (
        <Notice tone="warning">
          {remote
            ? `Databricks Sandbox isn't on in this workspace, and ${harness.label} runs there. An admin can turn on the preview.`
            : "Databricks Sandbox isn't on in this workspace, so this agent can't run code until an admin turns on the preview."}
        </Notice>
      )}
      <Field label="Harness" hint={harness.detail}>
        <select
          className="dbx-select"
          {...disabled}
          value={harness.id}
          onChange={(event) => {
            const next = event.target.value as HarnessId;
            // Each harness speaks one API; keep the model when it fits.
            const model = isRemote(next) && !harnessAccepts(next, config.model) ? HARNESS_MODEL[next] : config.model;
            onChange({ ...config, harness: next, model });
          }}
        >
          {HARNESSES.map((candidate) => (
            <option key={candidate.id} value={candidate.id}>
              {candidate.label}
            </option>
          ))}
        </select>
      </Field>
      <ModelField
        service={workspace}
        value={config.model}
        {...disabled}
        {...(remote && { accepts: (id: string) => harnessAccepts(remote, id), hint: `Models ${harness.label} can use, from AI Gateway in this workspace.` })}
        onChange={(model) => onChange({ ...config, model })}
      />
      {remote ? (
        <Field label="Permissions" hint={permissionsHint(remote, config.permissions)}>
          <select className="dbx-select" {...disabled} value={config.permissions} onChange={(event) => onChange({ ...config, permissions: event.target.value as Permissions })}>
            <option value="standard">Standard</option>
            <option value="full">Full access</option>
          </select>
        </Field>
      ) : (
        <ToolsField service={workspace} tools={config.tools} {...disabled} onChange={(tools) => onChange({ ...config, tools })} />
      )}
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

const LIST_TTL_MS = 5 * 60_000;
const lists = new WeakMap<DatabricksService, Map<string, { at: number; value: Promise<unknown> }>>();

/**
 * A workspace list (models, Genie agents, MCP servers…) loaded at most once
 * every 5 minutes and shared by every form showing it. Failures aren't kept.
 */
export function cachedList<T>(service: DatabricksService, key: string, load: () => Promise<T>): Promise<T> {
  let entries = lists.get(service);
  if (!entries) lists.set(service, (entries = new Map()));
  const found = entries.get(key);
  if (found && Date.now() - found.at < LIST_TTL_MS) return found.value as Promise<T>;
  const value = load();
  const kept = entries;
  kept.set(key, { at: Date.now(), value });
  value.catch(() => {
    if (kept.get(key)?.value === value) kept.delete(key);
  });
  return value;
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
    <Field label="Workspace" hint="Uses your Databricks CLI sign-in for that workspace.">
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
        {state.busy && <Text tone="subtle" size="sm">Finish signing in in your browser.</Text>}
        {state.error && <Text tone="danger" size="sm">{state.error}</Text>}
        {props.profile && !adding && <WorkspaceStatus service={workspace} snapshot={current} />}
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
  /** Small, dimmed text at the right, such as an ID. */
  meta?: string;
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
        const text = `${option.label} ${option.detail ?? ""} ${option.meta ?? ""} ${option.keywords ?? ""} ${option.group}`.toLowerCase();
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
              {props.multi ? (
                <input type="checkbox" tabIndex={-1} readOnly checked={selected} aria-hidden />
              ) : (
                <span className="dbx-picker-check" aria-hidden>
                  {selected ? "✓" : ""}
                </span>
              )}
              <span className="dbx-picker-text">
                <span style={{ display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap" }}>
                  <Text weight={500}>{option.label}</Text>
                  {option.badge}
                </span>
                {option.detail && (
                  <Text tone="subtle" size="xs" as="span" style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                    {option.detail}
                  </Text>
                )}
              </span>
              {option.meta && <span className="dbx-picker-meta">{option.meta}</span>}
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

/** One choice from a searchable list in a dropdown under its button. */
export function SinglePicker(props: {
  label: string;
  hint?: React.ReactNode;
  value?: string;
  valueLabel?: string;
  placeholder: string;
  searchPlaceholder?: string;
  options: readonly PickOption[];
  loading?: string | false;
  error?: string;
  disabled?: boolean;
  onChange(option: PickOption): void;
}) {
  const [open, setOpen] = React.useState(false);
  const [query, setQuery] = React.useState("");
  const anchor = React.useRef<HTMLDivElement>(null);
  const close = React.useCallback(() => (setOpen(false), setQuery("")), []);
  React.useEffect(() => {
    if (!open) return;
    const outside = (event: MouseEvent) => {
      if (anchor.current && !anchor.current.contains(event.target as Node)) close();
    };
    document.addEventListener("mousedown", outside);
    return () => document.removeEventListener("mousedown", outside);
  }, [open, close]);
  const current = props.options.find((option) => option.id === props.value);
  return (
    <Section label={props.label} hint={props.hint}>
      <div className="dbx-picker-anchor" ref={anchor}>
        <button
          type="button"
          className="dbx-select dbx-picker-trigger"
          aria-haspopup="listbox"
          aria-expanded={open}
          disabled={props.disabled}
          onClick={() => (open ? close() : setOpen(true))}
        >
          <span style={props.value ? undefined : { color: "var(--dbx-subtle)" }}>{current?.label ?? props.valueLabel ?? (props.value || props.placeholder)}</span>
        </button>
        {open && (
          <div
            className="dbx-picker"
            data-floating=""
            onKeyDown={(event) => {
              if (event.key === "Escape") (event.stopPropagation(), close());
            }}
          >
            <input
              className="dbx-input"
              autoFocus
              placeholder={props.searchPlaceholder ?? "Search"}
              aria-label={`Search ${props.label.toLowerCase()}`}
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              onKeyDown={(event) => {
                if (event.key !== "Enter") return;
                event.preventDefault();
                const first = filterOptions(props.options, query).find((option) => !option.disabled);
                if (first) (props.onChange(first), close());
              }}
            />
            {!(props.loading && props.options.length === 0) && (
              <OptionList
                label={props.label}
                options={props.options}
                query={query}
                isSelected={(id) => id === props.value}
                onPick={(option) => (props.onChange(option), close())}
                maxHeight={300}
                {...(props.disabled !== undefined && { disabled: props.disabled })}
              />
            )}
            {props.loading && (
              <div style={{ padding: "8px 12px", borderTop: props.options.length ? "1px solid var(--dbx-border)" : undefined }}>
                <Loading text={props.loading} />
              </div>
            )}
          </div>
        )}
      </div>
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
  /** Shown under the chips, for things the chosen options need. */
  alerts?: React.ReactNode;
  disabled?: boolean;
  onToggle(option: PickOption, on: boolean): void;
  footer?: React.ReactNode;
  searchPlaceholder?: string;
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
      {props.alerts}
      <div className="dbx-picker">
        <input className="dbx-input" placeholder={props.searchPlaceholder ?? `Search ${props.options.length}`} aria-label={`Search ${props.label.toLowerCase()}`} value={query} onChange={(event) => setQuery(event.target.value)} />
        <OptionList
          label={props.label}
          multi
          options={props.options}
          query={query}
          isSelected={(id) => chosen.has(id)}
          onPick={(option) => props.onToggle(option, !chosen.has(option.id))}
          maxHeight={220}
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

/** Databricks' models drop the shared "system.ai." for display. */
const shortId = (id: string) => id.replace(/^system\.ai\./, "");

/** Chat models from AI Gateway (Unity Catalog model services) as options. */
export function modelOptions(models: readonly ChatModel[] | undefined): PickOption[] {
  const listed = models ?? DEFAULT_MODELS.map((model) => ({ id: model.id, label: model.label, tools: true, builtIn: true }));
  const byId = new Map(listed.map((model) => [model.id, model]));
  const recommended = DEFAULT_MODELS.filter((model) => !models || byId.has(model.id)).map((model) => ({ id: model.id, label: model.label, group: "Recommended", meta: shortId(model.id) }));
  const rest = listed
    .filter((model) => !RECOMMENDED.has(model.id))
    .map((model) => ({
      id: model.id,
      label: model.label,
      group: model.builtIn ? "All Databricks models" : "Your workspace",
      meta: shortId(model.id),
      keywords: model.id,
      ...(!model.tools && { disabled: true, badge: <Badge>No tool calling</Badge> }),
    }));
  return [...recommended, ...rest];
}

export function ModelField(props: { service: DatabricksService; value: string; onChange(model: string): void; disabled?: boolean; accepts?(id: string): boolean; hint?: string }) {
  const status = useConnection(props.service).status;
  const models = useAsync(() => cachedList(props.service, "models", async () => new Ai(await props.service.ready()).models()), [props.service, status]);
  const options = modelOptions(models.data).filter((option) => !props.accepts || props.accepts(option.id));
  return (
    <SinglePicker
      label="Model"
      hint={props.hint ?? "From AI Gateway in this workspace."}
      value={props.value}
      valueLabel={props.value}
      placeholder="Choose a model"
      searchPlaceholder={`Search ${options.length} models`}
      options={options}
      loading={models.loading && !models.data && loads(status) ? "Loading all models…" : false}
      {...(models.error && status === "connected" && { error: `Couldn't list models: ${describeError(models.error)}` })}
      {...(props.disabled !== undefined && { disabled: props.disabled })}
      onChange={(option) => props.onChange(option.id)}
    />
  );
}

export const genieSpaces = (service: DatabricksService) => cachedList(service, "genie-spaces", async () => new Genie(await service.ready()).listSpaces());

const asChoice = (server: McpServer): ToolChoice => ({ id: server.id, kind: server.kind, label: server.label, path: server.path });

function serverOption(server: McpServer, login?: McpLoginState): PickOption {
  const badge = server.needsLogin ? (
    login === "signed-in" ? undefined : login === "needed" ? (
      <Badge tone="warning" title={`Log in to ${server.label} to use it`}>Not logged in</Badge>
    ) : (
      <Badge>Needs your account</Badge>
    )
  ) : server.id === "service:system.ai.dbsql" ? (
    <Badge tone="warning" title="Unlike the suite's own SQL tool, this server isn't read-only">
      Can change data
    </Badge>
  ) : undefined;
  return {
    id: server.id,
    label: server.label,
    group: server.builtIn ? "Databricks" : "Your workspace's MCP servers",
    keywords: server.id,
    ...(server.builtIn
      ? server.description && { detail: server.description }
      : { detail: `${server.kind === "connection" ? "External MCP connection" : "MCP service"}${server.description ? ` · ${server.description}` : ""}` }),
    ...(badge && { badge }),
  };
}

const loginStates = new WeakMap<DatabricksService, Record<string, McpLoginState>>();

/**
 * The person's logins to per-user OAuth MCP services (GitHub, Slack, …):
 * checked when the form opens, when Buzz is focused again, and every few
 * seconds while a login page is open.
 */
function useMcpLogins(service: DatabricksService, connected: boolean, servers: readonly McpServer[]) {
  const names = servers
    .filter((server) => server.needsLogin)
    .map(serviceName)
    .filter((name): name is string => Boolean(name))
    .join(" ");
  const [states, setStates] = React.useState<Readonly<Record<string, McpLoginState>>>(() => loginStates.get(service) ?? {});
  const [waiting, setWaiting] = React.useState<string>();
  const deadline = React.useRef(0);
  const check = React.useCallback(
    async (only?: readonly string[]) => {
      const client = service.client();
      const list = only ?? (names ? names.split(" ") : []);
      if (!client || !list.length) return;
      const catalog = new McpCatalog(client);
      const found = Object.fromEntries(await Promise.all(list.map(async (name) => [name, await catalog.loginState(name)] as const)));
      const next = { ...loginStates.get(service), ...found };
      loginStates.set(service, next);
      setStates(next);
    },
    [service, names],
  );
  React.useEffect(() => {
    if (connected) void check();
  }, [check, connected]);
  React.useEffect(() => {
    const again = () => void check();
    globalThis.addEventListener?.("focus", again);
    return () => globalThis.removeEventListener?.("focus", again);
  }, [check]);
  React.useEffect(() => {
    if (!waiting) return;
    if (states[waiting] === "signed-in") return setWaiting(undefined);
    const timer = setInterval(() => (Date.now() > deadline.current ? setWaiting(undefined) : void check([waiting])), 3000);
    return () => clearInterval(timer);
  }, [waiting, states, check]);
  const logIn = (name: string) => {
    const url = service.workspaceUrl(mcpLoginPath(name));
    if (!url) return;
    openExternal(url);
    deadline.current = Date.now() + 5 * 60_000;
    setWaiting(name);
  };
  return { states, waiting, logIn, check };
}

/** A chosen MCP service that needs the person's own login, with a button to the login page. */
function McpLoginNotice(props: { server: McpServer; waiting: boolean; onLogIn(): void; onCheck(): void; disabled?: boolean }) {
  const { label } = props.server;
  return (
    <Notice
      tone="warning"
      action={
        props.waiting ? (
          <Button size="sm" disabled={props.disabled} onClick={props.onCheck}>
            Check again
          </Button>
        ) : (
          <Button size="sm" variant="brand" disabled={props.disabled} onClick={props.onLogIn}>
            Log in to {label}
          </Button>
        )
      }
    >
      {props.waiting ? (
        <Stack direction="row" gap={6} align="center">
          <Spinner size={11} />
          <span>Finish logging in to {label} in your browser.</span>
        </Stack>
      ) : (
        `Log in so this agent can use ${label} as you.`
      )}
    </Notice>
  );
}

/** Genie One, Genie agents and MCP servers from the agent's workspace. */
export function ToolsField(props: { service: DatabricksService; tools: readonly ToolChoice[]; onChange(tools: ToolChoice[]): void; disabled?: boolean }) {
  const { service } = props;
  const status = useConnection(service).status;
  const spaces = useAsync(() => genieSpaces(service), [service, status]);
  const catalog = useAsync(() => cachedList(service, "mcp", async () => new McpCatalog(await service.ready()).list()), [service, status]);
  const [schemaName, setSchemaName] = React.useState("");
  const choices = new Map<string, ToolChoice>([[GENIE_ONE_CHOICE.id, GENIE_ONE_CHOICE]]);
  const servers = catalog.data?.servers ?? [];
  const logins = useMcpLogins(service, status === "connected", servers);
  // Databricks' own first (Genie One and the system.ai servers), then the
  // workspace's Genie agents and MCP servers, which can number hundreds.
  const options: PickOption[] = [{ id: GENIE_ONE_CHOICE.id, label: "Genie One", group: "Databricks", detail: "Questions about any data you can access" }];
  const loginOf = (server: McpServer) => logins.states[serviceName(server) ?? ""];
  for (const server of servers.filter((candidate) => candidate.builtIn)) {
    choices.set(server.id, asChoice(server));
    options.push(serverOption(server, loginOf(server)));
  }
  for (const space of spaces.data ?? []) {
    const choice: ToolChoice = { id: `genie:${space.space_id}`, kind: "genie", label: space.title };
    choices.set(choice.id, choice);
    options.push({ id: choice.id, label: space.title, group: "Genie agents", ...(space.description && { detail: space.description }), keywords: "genie agent space" });
  }
  for (const server of servers.filter((candidate) => !candidate.builtIn)) {
    choices.set(server.id, asChoice(server));
    options.push(serverOption(server, loginOf(server)));
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
  // Chosen services still waiting for the person's login.
  const toLogIn = servers.filter((server) => {
    const name = serviceName(server);
    return name && props.tools.some((tool) => tool.id === server.id) && (logins.states[name] === "needed" || logins.waiting === name);
  });
  const loading = !loads(status) ? false : spaces.loading ? "Loading Genie agents…" : catalog.loading ? "Finding MCP servers…" : false;
  const notes = status !== "connected" ? [] : [
    ...(spaces.error ? [`Couldn't list Genie agents: ${describeError(spaces.error)}`] : []),
    ...(catalog.error ? [`Couldn't list MCP servers: ${describeError(catalog.error)}`] : []),
    ...(catalog.data?.errors ?? []).map((error) => `Couldn't list ${error}`),
  ];
  return (
    <MultiPicker
      label="Tools"
      hint="Genie and MCP servers from this workspace. They run with your access."
      searchPlaceholder={`Search ${options.length} tools`}
      selected={selected}
      options={options}
      loading={loading}
      notes={notes}
      alerts={toLogIn.map((server) => {
        const name = serviceName(server)!;
        return (
          <McpLoginNotice
            key={server.id}
            server={server}
            waiting={logins.waiting === name}
            onLogIn={() => logins.logIn(name)}
            onCheck={() => void logins.check([name])}
            {...(props.disabled !== undefined && { disabled: props.disabled })}
          />
        );
      })}
      {...(props.disabled !== undefined && { disabled: props.disabled })}
      onToggle={(option, on) => toggle(option.id, on)}
      footer={
        <Stack direction="row" gap={8} align="center">
          <input
            className="dbx-input"
            placeholder="Add Unity Catalog functions: catalog.schema"
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
    async () => {
      const errors: string[] = [];
      const [endpoints, apps, spaces] = await Promise.all([
        cachedList(service, "endpoints", async () => new Ai(await service.ready()).endpoints()).catch((error: unknown) => (errors.push(`serving endpoints: ${describeError(error)}`), [])),
        cachedList(service, "apps", async () => new Ai(await service.ready()).apps()).catch((error: unknown) => (errors.push(`apps: ${describeError(error)}`), [])),
        genieSpaces(service).catch((error: unknown) => (errors.push(`Genie agents: ${describeError(error)}`), [])),
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
        hint="Agents in this workspace. Each message in the thread goes to it, and its reply is posted as this agent."
        searchPlaceholder="Search agents"
        {...(value && { value })}
        {...(props.value && { valueLabel: props.value.label })}
        placeholder="Choose an agent"
        options={found.data?.options ?? []}
        loading={found.loading && !found.data && loads(status) ? "Finding your agents…" : false}
        {...(found.error && status === "connected" && { error: describeError(found.error) })}
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
