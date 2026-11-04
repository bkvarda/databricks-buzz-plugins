// Creation and settings forms for the Databricks agent types.
import { Ai, DEFAULT_MODELS } from "@dbx/core/api/ai";
import { Genie } from "@dbx/core/api/genie";
import { React } from "@dbx/core/react";
import { type DatabricksService, describeError, useAsync, useConnection } from "@dbx/core/service";
import { functionsServer, McpCatalog, type McpServer } from "@dbx/core/api/mcp-catalog";
import { Badge, Button, DbxRoot, Field, Notice, Spinner, Stack, Text } from "@dbx/core/ui/components";
import { GENIE_ONE_CHOICE, type ToolChoice } from "./capabilities";

export type DatabricksConfig = {
  model: string;
  instructions: string;
  scope: "thread" | "channel";
  sandbox: boolean;
  /** Genie and MCP servers it can use, beyond Buzz's tools. */
  tools: ToolChoice[];
  /** A CLI profile for another workspace; unset uses Buzz's connection. */
  profile?: string;
};
export type GenieConfig = { spaceId: string; spaceTitle: string; profile?: string };
/** GenieConfig.spaceId for Genie One (not a Genie space). */
export const GENIE_ONE_ID = "genie-one";
export type EndpointConfig = { target: string; task: string; label: string; instructions: string; profile?: string };

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

export function DatabricksForm(props: FormProps<DatabricksConfig> & { service: DatabricksService }) {
  const { config, onChange } = props;
  const workspace = useAgentService(props.service, config.profile);
  const status = useConnection(workspace).status;
  const endpoints = useAsync(async (signal) => (await new Ai(await workspace.ready(signal)).endpoints(signal)).filter((e) => /chat/.test(e.task) && !e.isAgent), [workspace, status]);
  const known = new Set<string>(DEFAULT_MODELS.map((model) => model.id));
  const options = [
    ...DEFAULT_MODELS.map((model) => ({ id: model.id, label: model.label })),
    ...(endpoints.data ?? []).filter((endpoint) => !known.has(endpoint.name)).map((endpoint) => ({ id: endpoint.name, label: `${endpoint.label} (endpoint)` })),
  ];
  if (!options.some((option) => option.id === config.model)) options.unshift({ id: config.model, label: config.model });
  return (
    <DbxRoot>
      <Stack gap={14}>
        <NeedsConnection service={props.service} />
        <WorkspaceField
          service={props.service}
          {...(config.profile && { profile: config.profile })}
          disabled={props.disabled}
          onChange={(profile) => {
            // Genie agents and servers belong to a workspace; keep only Genie One.
            const { profile: _old, ...rest } = config;
            onChange({ ...rest, ...(profile && { profile }), tools: config.tools.filter((tool) => tool.kind === "genie-one") });
          }}
        />
        <Field label="Model" hint="Served by Databricks AI Gateway, billed to your workspace.">
          <select className="dbx-select" disabled={props.disabled} value={config.model} onChange={(event) => onChange({ ...config, model: event.target.value })}>
            {options.map((option) => (
              <option key={option.id} value={option.id}>
                {option.label}
              </option>
            ))}
          </select>
        </Field>
        <label style={{ display: "flex", gap: 10, alignItems: "flex-start", fontSize: "0.8125rem" }}>
          <input type="checkbox" disabled={props.disabled} checked={config.sandbox} onChange={(event) => onChange({ ...config, sandbox: event.target.checked })} style={{ marginTop: 3 }} />
          <span>
            <Text weight={500} as="div">
              Give it a Databricks Sandbox
            </Text>
            <Text tone="subtle" size="sm" as="div">
              Its own Linux machine in Databricks to run code, with a persistent home folder, internet access and the Databricks CLI signed in as you. Created on first use.
            </Text>
          </span>
        </label>
        <ToolsField service={workspace} tools={config.tools} disabled={props.disabled} onChange={(tools) => onChange({ ...config, tools })} />
        <Field label="Conversation" hint="Thread: each thread is its own conversation. Channel: one conversation for the whole channel.">
          <select className="dbx-select" disabled={props.disabled} value={config.scope} onChange={(event) => onChange({ ...config, scope: event.target.value as DatabricksConfig["scope"] })}>
            <option value="thread">One per thread</option>
            <option value="channel">One per channel</option>
          </select>
        </Field>
        <Field label="Instructions" hint="Optional. Who it is, what it should focus on, how to answer.">
          <textarea className="dbx-textarea" rows={5} disabled={props.disabled} value={config.instructions} onChange={(event) => onChange({ ...config, instructions: event.target.value })} />
        </Field>
      </Stack>
    </DbxRoot>
  );
}

export function GenieForm(props: FormProps<GenieConfig> & { service: DatabricksService }) {
  const { config, onChange } = props;
  const workspace = useAgentService(props.service, config.profile);
  const status = useConnection(workspace).status;
  const spaces = useAsync(async (signal) => new Genie(await workspace.ready(signal)).listSpaces(signal), [workspace, status]);
  React.useEffect(() => {
    if (!config.spaceId) onChange({ ...config, spaceId: GENIE_ONE_ID, spaceTitle: "Genie One" });
  }, [config, onChange]);
  return (
    <DbxRoot>
      <Stack gap={14}>
        <NeedsConnection service={props.service} />
        <WorkspaceField
          service={props.service}
          {...(config.profile && { profile: config.profile })}
          disabled={props.disabled}
          onChange={(profile) => onChange({ spaceId: GENIE_ONE_ID, spaceTitle: "Genie One", ...(profile && { profile }) })}
        />
        <Field label="Answers with" hint="Mention this Buzz agent with a data question; it answers with an explanation, a table, the SQL and a link. Genie One finds the right data across the workspace; a Genie agent sticks to the data your team curated. Each thread keeps its own Genie conversation for follow-ups.">
          {spaces.loading ? (
            <Stack direction="row" gap={8} align="center">
              <Spinner size={12} />
              <Text tone="subtle" size="sm">
                Loading Genie agents…
              </Text>
            </Stack>
          ) : spaces.error ? (
            <Text tone="danger" size="sm">
              {describeError(spaces.error)}
            </Text>
          ) : (
            <select
              className="dbx-select"
              disabled={props.disabled}
              value={config.spaceId}
              onChange={(event) => {
                const keep = config.profile ? { profile: config.profile } : {};
                if (event.target.value === GENIE_ONE_ID) return onChange({ spaceId: GENIE_ONE_ID, spaceTitle: "Genie One", ...keep });
                const space = spaces.data?.find((candidate) => candidate.space_id === event.target.value);
                onChange({ spaceId: event.target.value, spaceTitle: space?.title ?? "", ...keep });
              }}
            >
              <option value={GENIE_ONE_ID}>Genie One · all your data</option>
              {(spaces.data ?? []).map((space) => (
                <option key={space.space_id} value={space.space_id}>
                  {space.title}
                </option>
              ))}
            </select>
          )}
        </Field>
      </Stack>
    </DbxRoot>
  );
}

export function EndpointForm(props: FormProps<EndpointConfig> & { service: DatabricksService }) {
  const { config, onChange } = props;
  const workspace = useAgentService(props.service, config.profile);
  const status = useConnection(workspace).status;
  const endpoints = useAsync(async (signal) => (await new Ai(await workspace.ready(signal)).endpoints(signal)).filter((e) => e.isAgent || /responses|chat/.test(e.task)), [workspace, status]);
  const isApp = /^https:\/\//.test(config.target);
  return (
    <DbxRoot>
      <Stack gap={14}>
        <NeedsConnection service={props.service} />
        <WorkspaceField
          service={props.service}
          {...(config.profile && { profile: config.profile })}
          disabled={props.disabled}
          onChange={(profile) => {
            const { profile: _old, ...rest } = config;
            onChange({ ...rest, target: "", task: "", label: "", ...(profile && { profile }) });
          }}
        />
        <Field label="Agent endpoint" hint="Agent Bricks agents, Knowledge Assistants, supervisors and custom agents you deployed to Model Serving.">
          <select
            className="dbx-select"
            disabled={props.disabled || endpoints.loading}
            value={isApp ? "" : config.target}
            onChange={(event) => {
              const endpoint = endpoints.data?.find((candidate) => candidate.name === event.target.value);
              onChange({ ...config, target: event.target.value, task: endpoint?.task ?? "", label: endpoint?.label ?? event.target.value });
            }}
          >
            <option value="">{endpoints.loading ? "Loading…" : "Choose an endpoint"}</option>
            {(endpoints.data ?? []).map((endpoint) => (
              <option key={endpoint.name} value={endpoint.name}>
                {endpoint.name}
                {endpoint.task ? ` · ${endpoint.task}` : ""}
                {endpoint.ready ? "" : " · not ready"}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Or a Databricks App URL" hint="For agents deployed on Databricks Apps (Agent Runtime), e.g. https://my-agent-123.aws.databricksapps.com">
          <input
            className="dbx-input"
            disabled={props.disabled}
            value={isApp ? config.target : ""}
            placeholder="https://…databricksapps.com"
            onChange={(event) => onChange({ ...config, target: event.target.value.trim(), task: "app", label: "Databricks App" })}
          />
        </Field>
      </Stack>
    </DbxRoot>
  );
}

/** A settings tab: the type's form with an explicit Save. */
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

// ── Workspace and tools, shared by the agent forms ──

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
    <Field label="Workspace" hint="Where this agent's Databricks work runs: models, Genie, SQL, MCP servers and its Sandbox. Uses your Databricks CLI sign-in for that workspace.">
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

function Check(props: { checked: boolean; disabled?: boolean; onChange(checked: boolean): void; title: React.ReactNode; detail?: React.ReactNode; badge?: React.ReactNode }) {
  return (
    <label style={{ display: "flex", gap: 10, alignItems: "flex-start", fontSize: "0.8125rem", cursor: props.disabled ? "default" : "pointer" }}>
      <input type="checkbox" disabled={props.disabled} checked={props.checked} onChange={(event) => props.onChange(event.target.checked)} style={{ marginTop: 3 }} />
      <span style={{ minWidth: 0 }}>
        <Stack direction="row" gap={6} align="center">
          <Text weight={500}>{props.title}</Text>
          {props.badge}
        </Stack>
        {props.detail && (
          <Text tone="subtle" size="sm" as="div">
            {props.detail}
          </Text>
        )}
      </span>
    </label>
  );
}

/** Genie and MCP servers from the agent's workspace, as checkboxes. */
export function ToolsField(props: { service: DatabricksService; tools: readonly ToolChoice[]; onChange(tools: ToolChoice[]): void; disabled?: boolean }) {
  const { service } = props;
  const status = useConnection(service).status;
  const spaces = useAsync(async (signal) => new Genie(await service.ready(signal)).listSpaces(signal), [service, status]);
  const catalog = useAsync(async (signal) => new McpCatalog(await service.ready(signal)).list(signal), [service, status]);
  const [query, setQuery] = React.useState("");
  const [schemaName, setSchemaName] = React.useState("");
  const chosen = new Set(props.tools.map((tool) => tool.id));
  const toggle = (choice: ToolChoice, on: boolean) =>
    props.onChange(on ? [...props.tools.filter((tool) => tool.id !== choice.id), choice] : props.tools.filter((tool) => tool.id !== choice.id));
  const servers = catalog.data?.servers ?? [];
  const needle = query.trim().toLowerCase();
  const visible = servers.filter((server) => chosen.has(server.id) || !needle || `${server.label} ${server.description ?? ""} ${server.id}`.toLowerCase().includes(needle));
  const builtIn = visible.filter((server) => server.builtIn);
  const others = visible.filter((server) => !server.builtIn);
  const functions = props.tools.filter((tool) => tool.kind === "functions");
  const asChoice = (server: McpServer): ToolChoice => ({ id: server.id, kind: server.kind, label: server.label, path: server.path });
  return (
    <Stack gap={14}>
      <Field label="Genie" hint="Genie One finds the right data on its own; a Genie agent answers from data your team curated.">
        <Stack gap={8}>
          <Check
            checked={chosen.has(GENIE_ONE_CHOICE.id)}
            disabled={props.disabled}
            onChange={(on) => toggle(GENIE_ONE_CHOICE, on)}
            title="Genie One"
            detail="Questions about any data you can access in this workspace."
          />
          {spaces.loading && <Spinner size={12} />}
          {(spaces.data ?? []).map((space) => (
            <Check
              key={space.space_id}
              checked={chosen.has(`genie:${space.space_id}`)}
              disabled={props.disabled}
              onChange={(on) => toggle({ id: `genie:${space.space_id}`, kind: "genie", label: space.title }, on)}
              title={space.title}
              {...(space.description && { detail: space.description })}
            />
          ))}
        </Stack>
      </Field>
      <Field label="MCP servers" hint="Tools from MCP servers in this workspace: Databricks-provided services, ones your team registered in Unity Catalog, and external MCP connections. They run with your access.">
        <Stack gap={8}>
          {catalog.loading && (
            <Stack direction="row" gap={8} align="center">
              <Spinner size={12} />
              <Text tone="subtle" size="sm">Finding MCP servers…</Text>
            </Stack>
          )}
          {catalog.error && <Text tone="danger" size="sm">{describeError(catalog.error)}</Text>}
          {(catalog.data?.errors ?? []).map((error) => (
            <Text key={error} tone="tertiary" size="xs">Couldn't list {error}</Text>
          ))}
          {servers.length > 8 && <input className="dbx-input" placeholder={`Search ${servers.length} servers`} value={query} onChange={(event) => setQuery(event.target.value)} />}
          {builtIn.length > 0 && <Text size="xs" tone="tertiary" weight={500}>Databricks</Text>}
          {builtIn.map((server) => (
            <Check
              key={server.id}
              checked={chosen.has(server.id)}
              disabled={props.disabled}
              onChange={(on) => toggle(asChoice(server), on)}
              title={server.label}
              {...(server.description && { detail: server.description })}
              {...(server.needsLogin
                ? { badge: <Badge>Needs your account</Badge> }
                : server.id === "service:system.ai.dbsql" && { badge: <Badge tone="warning" title="Unlike the suite's own SQL tool, this server isn't read-only">Can change data</Badge> })}
            />
          ))}
          {others.length > 0 && <Text size="xs" tone="tertiary" weight={500}>Your workspace</Text>}
          <div style={{ maxHeight: 260, overflow: "auto", display: "flex", flexDirection: "column", gap: 8 }}>
            {others.slice(0, needle ? 200 : 40).map((server) => (
              <Check
                key={server.id}
                checked={chosen.has(server.id)}
                disabled={props.disabled}
                onChange={(on) => toggle(asChoice(server), on)}
                title={server.label}
                detail={`${server.kind === "connection" ? "External MCP connection" : "MCP service"}${server.description ? ` · ${server.description}` : ""}`}
                {...(server.needsLogin && { badge: <Badge>Needs your account</Badge> })}
              />
            ))}
            {!needle && others.length > 40 && <Text tone="subtle" size="sm">{others.length - 40} more. Search to find them.</Text>}
          </div>
          {functions.map((tool) => (
            <Check key={tool.id} checked disabled={props.disabled} onChange={() => toggle(tool, false)} title={tool.label} detail="Unity Catalog functions" />
          ))}
          <Stack direction="row" gap={8} align="center">
            <input
              className="dbx-input"
              placeholder="catalog.schema with Unity Catalog functions"
              value={schemaName}
              onChange={(event) => setSchemaName(event.target.value.trim())}
              style={{ flex: 1 }}
            />
            <Button
              size="sm"
              disabled={props.disabled || !/^[\w-]+\.[\w-]+$/.test(schemaName)}
              onClick={() => {
                const [catalogName = "", schemaPart = ""] = schemaName.split(".");
                const server = functionsServer(catalogName, schemaPart);
                toggle(asChoice(server), true);
                setSchemaName("");
              }}
            >
              Add functions
            </Button>
          </Stack>
        </Stack>
      </Field>
    </Stack>
  );
}
