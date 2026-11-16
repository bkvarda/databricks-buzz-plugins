// The Databricks App agent type: a Buzz identity for code that runs as a
// Databricks App, the way a Slack app has a bot user. The app runs as its own
// service principal, so it reaches only what that principal is granted, and
// it can answer anyone in the channels it's in.
//
// Buzz calls `provision`: we make (or find) the app, make the identity's key
// and keep it in a Unity Catalog secret that only the app's service principal
// can read (besides its creator), grant that, and put the code in a workspace
// folder. Then `activate`: we add the owner's attestation and the community to
// the secret, and deploy the starter app. The app's library (../app/sdk.ts)
// reads the secret, signs in and keeps its profile up to date.
import type { Agents, AgentType } from "@buzz/author";
import { generateSecretKey, getPublicKey } from "nostr-tools/pure";
import { APP_NAME, Apps, type DatabricksApp, ensureSchema, grantPrivileges, listCatalogs, UcSecrets, wait, writeWorkspaceFiles } from "@dbx/core/api/apps";
import { React } from "@dbx/core/react";
import { type DatabricksService, describeError, isApiError, useAsync, useConnection } from "@dbx/core/service";
import { Badge, Button, CodeView, DbxRoot, databricksIcon, Field, Notice, openExternal, Spinner, Stack, StatusDot, Text } from "@dbx/core/ui/components";
import { Lakebase } from "@dbx/core/api/workspace";
import { APP_SHA, INDEXER, SDK, STARTER } from "virtual:buzz-app";
import { activated, type AppIdentity, type Answers, appYaml, identitySecretName, parseIdentity, SEARCH_APP_PREFIX } from "./app-identity";
import { cachedList, NeedsConnection, SinglePicker, useAgentService, WorkspaceField } from "./ui";

export const APP_TYPE_ID = "databricks-app";
const RECORD_PREFIX = "bkvarda.databricks-app.v1:";
const DEFAULT_SCHEMA = "buzz_apps";

export type AppMode = "starter" | "own";
/** What "deploy for me" deploys: the starter bot, or the search index. */
export type AppTemplate = "starter" | "search";
/** A Lakebase database, as full resource names (`projects/…/branches/…` and `…/databases/…`). */
export type AppDatabase = { project: string; branch: string; database: string };

export type AppTypeConfig = {
  /** A CLI profile for another workspace; unset uses Buzz's connection. */
  profile?: string;
  /** Deploy a template into a new app, or connect an app that's there. */
  mode: AppMode;
  template: AppTemplate;
  /** The search index's database. */
  lakebase?: AppDatabase;
  app: string;
  /** `catalog.schema` for its key. */
  schema: string;
  answers: Answers;
};

export function normalizeAppConfig(value: unknown): AppTypeConfig {
  const config = (value ?? {}) as Partial<AppTypeConfig>;
  const lakebase = config.lakebase;
  return {
    mode: config.mode === "own" ? "own" : "starter",
    template: config.template === "search" ? "search" : "starter",
    ...(lakebase && typeof lakebase.branch === "string" && typeof lakebase.database === "string" && typeof lakebase.project === "string" && { lakebase: { project: lakebase.project, branch: lakebase.branch, database: lakebase.database } }),
    app: typeof config.app === "string" ? config.app.trim().toLowerCase() : "",
    schema: typeof config.schema === "string" ? config.schema.trim() : "",
    answers: config.answers === "owner" ? "owner" : "everyone",
    ...(typeof config.profile === "string" && config.profile && { profile: config.profile }),
  };
}

const SCHEMA = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_]+$/;

/** Why the Create form can't go ahead yet, if it can't. */
export function appConfigProblem(config: AppTypeConfig): string | undefined {
  if (!config.app) return config.mode === "own" ? "Pick the app." : "Name the app.";
  if (!APP_NAME.test(config.app)) return "App names use lowercase letters, numbers and hyphens (at most 30), and start and end with a letter or number.";
  if (!SCHEMA.test(config.schema)) return "Pick where its key is kept: a catalog and a schema.";
  if (isSearch(config) && !config.lakebase) return "Pick the Lakebase project for its index.";
  return undefined;
}

/** A search index the plugin deploys. */
export const isSearch = (config: Pick<AppTypeConfig, "mode" | "template">) => config.mode === "starter" && config.template === "search";

/** The code a template's folder gets. Edits to the starter's app.mjs and app.yaml are kept; the search index is replaced on each deploy. */
function templateFiles(config: AppTypeConfig, secret: string, source: string): { files: Record<string, string>; keep: string[] } {
  if (isSearch(config)) return { files: { "app.mjs": INDEXER, "app.yaml": appYaml({ secret, source, lakebase: true }) }, keep: [] };
  return { files: { "buzz-app.mjs": SDK, "app.mjs": STARTER, "app.yaml": appYaml({ secret, source }) }, keep: ["app.mjs", "app.yaml"] };
}

export function summarizeApp(config: AppTypeConfig): string {
  return [config.app || "No app yet", config.mode === "own" ? "your app" : isSearch(config) ? "search index" : "starter app", config.answers === "owner" ? "answers only you" : "answers everyone", ...(config.profile ? [config.profile] : [])].join(" · ");
}

// ── Records (this device) ──

export type AppRecord = {
  pubkey?: string;
  name: string;
  picture?: string;
  config: AppTypeConfig;
  /** The Unity Catalog secret its identity is in. */
  secret: string;
  /** The workspace folder with its code (the starter, or the files to add to your own). */
  source: string;
  /** We made the app, so removing the identity deletes it. */
  createdApp: boolean;
  servicePrincipal?: { id: string; name?: string };
  /** The plugin's template code (APP_SHA) it was last deployed with. */
  deployedSha?: string;
  host?: string;
  community?: string;
  owner?: string;
  authTag?: string[];
  createdAt: number;
};

const recordKey = (pubkey: string) => `${RECORD_PREFIX}${pubkey}`;
const pendingKey = (community: string, name: string) => `${RECORD_PREFIX}pending:${community}:${name}`;
const parse = (raw: string | null): AppRecord | undefined => {
  try {
    return raw ? (JSON.parse(raw) as AppRecord) : undefined;
  } catch {
    return undefined;
  }
};
const hex = (bytes: Uint8Array) => [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
const bytes = (text: string) => Uint8Array.from(text.match(/../g)!.map((pair) => parseInt(pair, 16)));

const workspaceOf = (service: DatabricksService, profile: string | undefined) => (profile && service.forProfile ? service.forProfile(profile) : service);

/** The person's own workspace folder for an app's code. */
async function sourceFolder(workspace: DatabricksService, app: string, signal?: AbortSignal): Promise<string> {
  const snapshot = workspace.snapshot();
  let user = snapshot.status === "connected" ? snapshot.user?.userName : undefined;
  if (!user) user = (await (await workspace.ready(signal)).get<{ userName?: string }>("/api/2.0/preview/scim/v2/Me", { ...(signal && { signal }) })).userName;
  if (!user) throw new Error("Couldn't tell who you're signed in to Databricks as.");
  return `/Workspace/Users/${user}/buzz-apps/${app}`;
}

/** Explains a grant Databricks refused. */
function grantFailed(error: unknown, what: string, principal: string): Error {
  if (isApiError(error) && error.isPermission)
    return new Error(`You can't grant access to ${what}. Pick a catalog you own or manage, or ask its owner to grant the app's service principal (${principal}) access.`);
  return error instanceof Error ? error : new Error(String(error));
}

const ACTIVE = new Set(["ACTIVE"]);

export type AppStatus = Readonly<{
  app?: DatabricksApp;
  /** What the app's own status page says, when it's running. */
  live?: Readonly<{ state?: string; lastError?: string; connected?: boolean; answered?: number; pubkey?: string; runsAs?: { applicationId: string; displayName: string } }>;
  liveError?: string;
}>;

export type AppProvider = ReturnType<typeof appProvider>;

/** Provision, activate and the rest, against this device's records. */
export function appProvider(agents: Pick<Agents, "storage">, service: DatabricksService) {
  const storage = agents.storage;
  const read = (pubkey: string) => parse(storage.get(recordKey(pubkey)));
  const records = () =>
    storage
      .keys()
      .filter((key) => key.startsWith(RECORD_PREFIX) && !key.includes(":pending:"))
      .map((key) => parse(storage.get(key)))
      .filter((record): record is AppRecord => Boolean(record?.pubkey));
  const write = (record: AppRecord) => storage.set(recordKey(record.pubkey!), JSON.stringify(record));
  const clientOf = (record: Pick<AppRecord, "config">, signal?: AbortSignal) => workspaceOf(service, record.config.profile).ready(signal);

  async function identityOf(record: AppRecord, signal?: AbortSignal): Promise<AppIdentity> {
    const identity = parseIdentity(await new UcSecrets(await clientOf(record, signal)).read(record.secret, signal));
    if (!identity) throw new Error(`The identity's key (${record.secret}) is gone; remove this agent and create it again.`);
    return identity;
  }

  async function saveIdentity(record: AppRecord, change: Partial<AppIdentity>, signal?: AbortSignal) {
    const identity = await identityOf(record, signal);
    await new UcSecrets(await clientOf(record, signal)).update(record.secret, JSON.stringify({ ...identity, ...change }), signal);
  }

  /** Deploys the app's folder once its compute is up, and waits for the deployment. */
  async function deploy(record: AppRecord, signal?: AbortSignal) {
    const client = await clientOf(record, signal);
    const apps = new Apps(client);
    let app = await apps.get(record.config.app, signal);
    if (!app) throw new Error(`The app ${record.config.app} is gone.`);
    if (["STOPPED", "ERROR"].includes(app.compute_status?.state ?? "")) app = await apps.start(record.config.app, signal);
    app = await apps.until(record.config.app, (found) => ACTIVE.has(found.compute_status?.state ?? "") || ["ERROR", "STOPPED"].includes(found.compute_status?.state ?? ""), { timeoutMs: 12 * 60_000, signal });
    if (!app || !ACTIVE.has(app.compute_status?.state ?? "")) throw new Error(`The app's compute didn't start${app?.compute_status?.message ? `: ${app.compute_status.message}` : ""}. Try again in a minute.`);
    let deployment = await apps.deploy(record.config.app, record.source, signal);
    // Its Settings tab follows a deployment that takes longer than this.
    for (const end = Date.now() + 8 * 60_000; deployment.deployment_id && deployment.status?.state === "IN_PROGRESS" && Date.now() < end; ) {
      await wait(5000, signal);
      deployment = await apps.deployment(record.config.app, deployment.deployment_id, signal);
    }
    if (deployment.status?.state === "FAILED") throw new Error(`The app's deployment failed: ${deployment.status.message ?? "no reason given"}`);
  }

  return {
    read,
    records,
    /** Whether the plugin has newer template code than the app was deployed with. */
    outdated: (record: AppRecord) => record.config.mode === "starter" && record.deployedSha !== APP_SHA,
    async provision(input: Readonly<{ name: string; picture?: string; community: string; config?: unknown; signal: AbortSignal }>) {
      const { signal } = input;
      const config = normalizeAppConfig(input.config);
      const problem = appConfigProblem(config);
      if (problem) throw new Error(problem);
      const pending = pendingKey(input.community, input.name);
      const prior = parse(storage.get(pending));
      const workspace = workspaceOf(service, config.profile);
      const client = await workspace.ready(signal);
      const apps = new Apps(client);
      const secrets = new UcSecrets(client);
      const [catalog, schema] = config.schema.split(".") as [string, string];
      const secret = identitySecretName(config.schema, config.app);
      const record: AppRecord = {
        name: input.name,
        ...(input.picture && { picture: input.picture }),
        config,
        secret,
        source: prior?.source ?? (await sourceFolder(workspace, config.app, signal)),
        createdApp: prior?.config.app === config.app && prior.createdApp,
        host: client.host,
        createdAt: prior?.createdAt ?? Date.now(),
      };
      // The app: a new one for the starter, or the one they picked.
      let app = await apps.get(config.app, signal);
      if (app && config.mode === "starter" && !record.createdApp)
        throw new Error(`There's already an app named ${config.app} in this workspace. Pick another name, or choose "Connect an app you have" to use it.`);
      if (!app) {
        if (config.mode === "own") throw new Error(`There's no app named ${config.app} in this workspace.`);
        app = await apps.create(config.app, {
          description: `${isSearch(config) ? SEARCH_APP_PREFIX : "Buzz app"}: ${input.name}`.slice(0, 200),
          ...(isSearch(config) && config.lakebase && { resources: [{ name: "postgres", description: "The search index", postgres: { branch: config.lakebase.branch, database: config.lakebase.database, permission: "CAN_CONNECT_AND_CREATE" } }] }),
          signal,
        });
        record.createdApp = true;
        await storage.set(pending, JSON.stringify(record));
      }
      if (!app.service_principal_client_id) app = (await apps.until(config.app, (found) => Boolean(found.service_principal_client_id), { timeoutMs: 90_000, intervalMs: 3000, signal })) ?? app;
      const principal = app.service_principal_client_id;
      if (!principal) throw new Error("Databricks hasn't given the app its service principal yet. Try again in a minute.");
      record.servicePrincipal = { id: principal, ...(app.service_principal_name && { name: app.service_principal_name }) };
      // The key, kept by Unity Catalog. A retried creation keeps the key it made.
      await ensureSchema(client, catalog, schema, "Buzz identities for Databricks Apps, from the Databricks Agents plugin for Buzz.", signal);
      const stored = await secrets.read(secret, signal);
      let identity = parseIdentity(stored);
      if (identity && activated(identity) && prior?.pubkey !== getPublicKey(bytes(identity.key)))
        throw new Error(`The app ${config.app} already has a Buzz identity (${secret}). Remove that agent first, or use another app.`);
      if (!identity) {
        if (stored !== undefined) throw new Error(`${secret} already exists and isn't a Buzz identity.`);
        identity = { v: 1, key: hex(generateSecretKey()), app: config.app, workspace: client.host, answers: config.answers };
        await secrets.create(secret, JSON.stringify(identity), `The Buzz identity of the Databricks App ${config.app}. Its service principal reads it to sign in to Buzz.`, signal);
      }
      const pubkey = getPublicKey(bytes(identity.key));
      record.pubkey = pubkey;
      await storage.set(pending, JSON.stringify(record));
      // Only the app's service principal reads it (besides you, its owner).
      await grantPrivileges(client, "catalog", catalog, principal, ["USE_CATALOG"], signal).catch((error) => Promise.reject(grantFailed(error, `the catalog ${catalog}`, principal)));
      await grantPrivileges(client, "schema", config.schema, principal, ["USE_SCHEMA"], signal).catch((error) => Promise.reject(grantFailed(error, `the schema ${config.schema}`, principal)));
      await grantPrivileges(client, "secret", secret, principal, ["READ_SECRET"], signal).catch((error) => Promise.reject(grantFailed(error, secret, principal)));
      // Its code: the starter, or the files to add to your own app. Edits to app.mjs and app.yaml are kept.
      const code = templateFiles(config, secret, record.source);
      await writeWorkspaceFiles(client, record.source, code.files, { keep: code.keep, signal });
      // The pending record stays until activation, so a repeated creation finds it.
      await write(record);
      return { pubkey, ...(record.picture && { picture: record.picture }) };
    },
    async activate(input: Readonly<{ pubkey: string; name: string; community: string; auth: readonly string[]; config?: unknown; signal: AbortSignal }>) {
      const found = read(input.pubkey);
      if (!found) throw new Error("This app's identity was set up from another device; remove the agent and create it again here.");
      const record: AppRecord = { ...found, name: input.name, community: input.community, owner: String(input.auth[1]), authTag: [...input.auth].map(String) };
      await saveIdentity(record, { relay: input.community, owner: record.owner!, auth: record.authTag!, name: input.name, ...(record.picture && { picture: record.picture }), answers: record.config.answers }, input.signal);
      if (record.config.mode === "starter") {
        await deploy(record, input.signal);
        record.deployedSha = APP_SHA;
      }
      await write(record);
      await storage.set(pendingKey(input.community, found.name), null);
      // The Search page (Lakebase plugin) searches the index made last, in its workspace.
      if (isSearch(record.config)) {
        service.preferences.set("buzzSearchProfile", record.config.profile);
        service.preferences.set("buzzSearchApp", record.config.app);
      }
    },
    async profile(input: Readonly<{ pubkey: string; community: string; name: string; picture?: string; signal: AbortSignal }>) {
      const found = read(input.pubkey);
      if (!found) return;
      const record: AppRecord = { ...found, name: input.name };
      if (input.picture) record.picture = input.picture;
      else delete record.picture;
      // The app reads it again within a minute and publishes its profile.
      const identity = await identityOf(record, input.signal);
      const { picture: _old, ...rest } = identity;
      await new UcSecrets(await clientOf(record, input.signal)).update(record.secret, JSON.stringify({ ...rest, name: input.name, ...(input.picture && { picture: input.picture }) }), input.signal);
      await write(record);
    },
    async remove(input: Readonly<{ pubkey: string; signal: AbortSignal }>) {
      const record = read(input.pubkey);
      if (!record) return;
      const client = await clientOf(record, input.signal);
      // Without its key the app signs out within a minute.
      await new UcSecrets(client).delete(record.secret, input.signal);
      if (record.createdApp) await new Apps(client).delete(record.config.app, input.signal);
      await storage.set(recordKey(input.pubkey), null);
    },
    /** Whose mentions it takes, from its Settings tab. */
    async setAnswers(pubkey: string, answers: Answers, signal?: AbortSignal) {
      const record = read(pubkey);
      if (!record) throw new Error("This app is managed from another device.");
      await saveIdentity(record, { answers }, signal);
      await write({ ...record, config: { ...record.config, answers } });
    },
    /** Lets everyone in the workspace use the app (for a search index: search from Buzz). */
    async allowEveryone(pubkey: string, signal?: AbortSignal) {
      const record = read(pubkey);
      if (!record) throw new Error("This app is managed from another device.");
      await new Apps(await clientOf(record, signal)).allow(record.config.app, "users", "CAN_USE", signal);
    },
    async everyoneAllowed(pubkey: string, signal?: AbortSignal): Promise<boolean> {
      const record = read(pubkey);
      if (!record) return false;
      return new Apps(await clientOf(record, signal)).allowed(record.config.app, "users", signal).catch(() => false);
    },
    /** Puts the current library in its folder and deploys the folder again. */
    async redeploy(pubkey: string, signal?: AbortSignal) {
      const record = read(pubkey);
      if (!record) throw new Error("This app is managed from another device.");
      const code = templateFiles(record.config, record.secret, record.source);
      await writeWorkspaceFiles(await clientOf(record, signal), record.source, code.files, { keep: code.keep, ...(signal && { signal }) });
      await deploy(record, signal);
      await write({ ...(read(pubkey) ?? record), deployedSha: APP_SHA });
    },
    /** The app in Databricks, and what its status page says. */
    async status(pubkey: string, signal?: AbortSignal): Promise<AppStatus> {
      const record = read(pubkey);
      if (!record) return {};
      const client = await clientOf(record, signal);
      const app = await new Apps(client).get(record.config.app, signal);
      if (!app?.url || app.app_status?.state !== "RUNNING") return { ...(app && { app }) };
      try {
        const response = await client.request(`${app.url.replace(/\/+$/, "")}/api/status`, { ...(signal && { signal }), timeoutMs: 15_000 });
        if (response.status !== 200) return { app, liveError: `Its status page answered HTTP ${response.status}.` };
        return { app, live: JSON.parse(response.body) as AppStatus["live"] };
      } catch (error) {
        return { app, liveError: describeError(error) };
      }
    },
  };
}

// ── Create form ──

const MODE_HINT: Record<AppMode, string> = {
  starter: "Makes a new app from a template. Its code goes in a folder in your workspace.",
  own: "Connects an app that's already in this workspace. You add buzz-app.mjs and one setting to its code; the agent's Settings tab shows how.",
};

function CatalogField(props: { service: DatabricksService; value: string; onChange(value: string): void; disabled?: boolean }) {
  const status = useConnection(props.service).status;
  const catalogs = useAsync(() => cachedList(props.service, "catalogs", async () => listCatalogs(await props.service.ready())), [props.service, status]);
  const [catalog = "", schema = DEFAULT_SCHEMA] = props.value.split(".");
  // Until they pick, the workspace's own catalog or the first they can see.
  React.useEffect(() => {
    if (catalog || !catalogs.data?.length) return;
    const first = catalogs.data.find((name) => name === "main") ?? catalogs.data.find((name) => name !== "samples") ?? catalogs.data[0]!;
    props.onChange(`${first}.${schema}`);
  }, [catalog, catalogs.data]);
  return (
    <Stack gap={8}>
      <SinglePicker
        label="Where its key is kept"
        hint="A Unity Catalog secret in this catalog and schema. Only the app's service principal can read it, besides you. You need to be able to grant access in this catalog."
        value={catalog}
        valueLabel={catalog || "Pick a catalog"}
        placeholder="Pick a catalog"
        searchPlaceholder={`Search ${(catalogs.data ?? []).length} catalogs`}
        options={(catalogs.data ?? []).map((name) => ({ id: name, label: name, group: "Catalogs" }))}
        loading={catalogs.loading && !catalogs.data ? "Loading catalogs…" : false}
        {...(props.disabled !== undefined && { disabled: props.disabled })}
        onChange={(option) => props.onChange(`${option.id}.${schema}`)}
      />
      <Field label="Schema" hint="Made if it isn't there.">
        <input className="dbx-input" value={schema} disabled={props.disabled} onChange={(event) => props.onChange(`${catalog}.${event.target.value.trim()}`)} />
      </Field>
    </Stack>
  );
}

const TEMPLATE_HINT: Record<AppTemplate, string> = {
  starter: "A small bot that answers mentions and says who it runs as, ready for you to change.",
  search: "Reads the community's public channels into a Lakebase database and searches them: from the Search page in Buzz, or when someone mentions it. Only public channels, which everyone in the community can read already.",
};

/** A Lakebase project for the search index: its default branch and database. */
function DatabaseField(props: { service: DatabricksService; value?: AppDatabase; onChange(value: AppDatabase | undefined): void; disabled?: boolean }) {
  const status = useConnection(props.service).status;
  const projects = useAsync(() => cachedList(props.service, "lakebase-projects", async () => new Lakebase(await props.service.ready()).projects()), [props.service, status]);
  const [error, setError] = React.useState<string>();
  const project = props.value?.project ?? "";
  return (
    <Stack gap={8}>
      <SinglePicker
        label="Lakebase project"
        hint={
          props.value
            ? `Its index goes in ${props.value.database.split("/").pop()} on ${props.value.branch.split("/").pop()}, in a buzz_search schema the app owns. Lakebase Search (lakebase_text) gives the best ranking; without it, Postgres' own full-text search is used.`
            : "The app gets access to its default branch's database and keeps its index there."
        }
        value={project}
        valueLabel={(projects.data ?? []).find((found) => found.id === project)?.name ?? (project || "Pick a project")}
        placeholder="Pick a project"
        searchPlaceholder={`Search ${(projects.data ?? []).length} projects`}
        options={(projects.data ?? []).map((found) => ({ id: found.id, label: found.name, group: "Lakebase" }))}
        loading={projects.loading && !projects.data ? "Loading Lakebase projects…" : false}
        {...(props.disabled !== undefined && { disabled: props.disabled })}
        onChange={(option) => {
          setError(undefined);
          void props.service
            .ready()
            .then((client) => new Lakebase(client).defaultDatabase(option.id))
            .then(
              (found) => {
                if (!found) setError("That project has no database on its default branch.");
                props.onChange(found ? { project: option.id, branch: found.branch, database: found.database } : undefined);
              },
              (cause: unknown) => setError(describeError(cause)),
            );
        }}
      />
      {error && <Notice tone="warning">{error}</Notice>}
    </Stack>
  );
}

function AppPicker(props: { service: DatabricksService; value: string; onChange(value: string): void; disabled?: boolean }) {
  const status = useConnection(props.service).status;
  const apps = useAsync(() => cachedList(props.service, "apps", async () => new Apps(await props.service.ready()).list()), [props.service, status]);
  return (
    <SinglePicker
      label="App"
      hint="An app in this workspace. Its code needs buzz-app.mjs; nothing is deployed to it for you."
      value={props.value}
      valueLabel={props.value || "Pick an app"}
      placeholder="Pick an app"
      searchPlaceholder={`Search ${(apps.data ?? []).length} apps`}
      options={(apps.data ?? []).map((app) => ({ id: app.name, label: app.name, group: "Apps", ...(app.description && { detail: app.description }) }))}
      loading={apps.loading && !apps.data ? "Loading apps…" : false}
      {...(props.disabled !== undefined && { disabled: props.disabled })}
      onChange={(option) => props.onChange(option.id)}
    />
  );
}

export function AppForm(props: { service: DatabricksService; config: AppTypeConfig; onChange(config: AppTypeConfig): void; onReadyChange?(ready: boolean): void; disabled?: boolean }) {
  const { config, onChange } = props;
  const workspace = useAgentService(props.service, config.profile);
  const problem = appConfigProblem(config);
  React.useEffect(() => props.onReadyChange?.(!problem), [problem]);
  const disabled = props.disabled !== undefined ? { disabled: props.disabled } : {};
  return (
    <DbxRoot>
      <Stack gap={14}>
        <NeedsConnection service={props.service} />
        <Text tone="subtle" size="sm">
          A Buzz identity for code that runs as a Databricks App, like a Slack app's bot user. It works as the app's own service principal, with only the access you grant it, so it can answer anyone in the channels it's in.
        </Text>
        <WorkspaceField
          service={props.service}
          {...(config.profile && { profile: config.profile })}
          {...disabled}
          onChange={(profile) => {
            const { profile: _old, ...rest } = config;
            onChange({ ...rest, ...(profile && { profile }), app: config.mode === "own" ? "" : config.app, schema: "" });
          }}
        />
        <Field label="App" hint={MODE_HINT[config.mode]}>
          <select className="dbx-select" {...disabled} value={config.mode} onChange={(event) => onChange({ ...config, mode: event.target.value as AppMode, app: "" })}>
            <option value="starter">Deploy a starter app for me</option>
            <option value="own">Connect an app you have</option>
          </select>
        </Field>
        {config.mode === "starter" && (
          <Field label="Template" hint={TEMPLATE_HINT[config.template]}>
            <select className="dbx-select" {...disabled} value={config.template} onChange={(event) => onChange({ ...config, template: event.target.value as AppTemplate })}>
              <option value="starter">Starter bot</option>
              <option value="search">Search index</option>
            </select>
          </Field>
        )}
        {isSearch(config) && (
          <DatabaseField
            service={workspace}
            {...(config.lakebase && { value: config.lakebase })}
            {...disabled}
            onChange={(lakebase) => {
              const { lakebase: _old, ...rest } = config;
              onChange({ ...rest, ...(lakebase && { lakebase }) });
            }}
          />
        )}
        {config.mode === "starter" ? (
          <Field label="App name" hint="Lowercase letters, numbers and hyphens. It's the app's name in Databricks and part of its URL.">
            <input className="dbx-input" placeholder="my-buzz-app" value={config.app} {...disabled} onChange={(event) => onChange({ ...config, app: event.target.value.toLowerCase().replace(/[^a-z0-9-]/g, "-") })} />
          </Field>
        ) : (
          <AppPicker service={workspace} value={config.app} {...disabled} onChange={(app) => onChange({ ...config, app })} />
        )}
        <CatalogField service={workspace} value={config.schema} {...disabled} onChange={(schema) => onChange({ ...config, schema })} />
        <Field label="Answers" hint="Everyone: anyone in a channel it's in can ask it, since it uses only its own access. Your app's code can choose otherwise.">
          <select className="dbx-select" {...disabled} value={config.answers} onChange={(event) => onChange({ ...config, answers: event.target.value as Answers })}>
            <option value="everyone">Everyone in its channels</option>
            <option value="owner">Only you</option>
          </select>
        </Field>
        {config.app && problem && <Notice tone="warning">{problem}</Notice>}
        <Text tone="tertiary" size="xs">
          {config.mode === "starter"
            ? "Removing it deletes the app it made and its key. Its code stays in your workspace folder."
            : "Removing it deletes its key, so your app signs out of Buzz; the app itself stays."}{" "}
          A running app costs about 0.5 DBU an hour.
        </Text>
      </Stack>
    </DbxRoot>
  );
}

// ── Settings tab ──

const COMPUTE_LABEL: Record<string, string> = { ACTIVE: "Running", STARTING: "Starting", STOPPED: "Stopped", STOPPING: "Stopping", UPDATING: "Updating", ERROR: "Compute error", DELETING: "Being deleted" };
const LIVE_LABEL: Record<string, string> = {
  connected: "Signed in to Buzz",
  waiting: "Waiting for Buzz to finish setting up its identity",
  connecting: "Can't reach Buzz yet",
  removed: "Its identity is gone",
  error: "Has a problem",
  starting: "Starting",
};

function Row(props: { label: string; children: React.ReactNode }) {
  return (
    <Stack direction="row" gap={12} align="baseline">
      <Text size="sm" tone="subtle" style={{ width: 140, flex: "none" }}>
        {props.label}
      </Text>
      <div style={{ minWidth: 0, overflowWrap: "anywhere" }}>{props.children}</div>
    </Stack>
  );
}

export function AppSettings(props: { service: DatabricksService; provider: AppProvider; pubkey: string }) {
  const [nonce, setNonce] = React.useState(0);
  const status = useAsync((signal) => props.provider.status(props.pubkey, signal), [props.pubkey, nonce]);
  const record = props.provider.read(props.pubkey);
  const [busy, setBusy] = React.useState<string>();
  const [error, setError] = React.useState<string>();
  React.useEffect(() => {
    const timer = setInterval(() => setNonce((n) => n + 1), 15_000);
    return () => clearInterval(timer);
  }, []);
  if (!record)
    return (
      <DbxRoot style={{ padding: "4px 0 24px" }}>
        <Notice tone="info">This app's identity was set up from another device, which manages it.</Notice>
      </DbxRoot>
    );
  const workspace = workspaceOf(props.service, record.config.profile);
  const run = (label: string, work: () => Promise<unknown>) => {
    setBusy(label);
    setError(undefined);
    work().then(
      () => {
        setBusy(undefined);
        setNonce((n) => n + 1);
      },
      (cause: unknown) => {
        setBusy(undefined);
        setError(describeError(cause));
      },
    );
  };
  const app = status.data?.app;
  const live = status.data?.live;
  const compute = app?.compute_status?.state;
  const deployment = app?.pending_deployment ?? app?.active_deployment;
  const tone = live?.state === "connected" ? "success" : live?.state === "error" || compute === "ERROR" || deployment?.status?.state === "FAILED" ? "danger" : "active";
  const headline = !status.data && status.loading ? "Checking…" : !app ? "The app is gone" : compute !== "ACTIVE" ? (COMPUTE_LABEL[compute ?? ""] ?? compute ?? "Unknown") : live ? (LIVE_LABEL[live.state ?? ""] ?? live.state) : app.app_status?.state === "RUNNING" ? "Running" : "Not running its code yet";
  const detail = live?.lastError ?? status.data?.liveError ?? (deployment?.status?.state === "FAILED" ? `Last deployment failed: ${deployment.status.message ?? ""}` : app?.app_status?.message);
  const yaml = appYaml({ secret: record.secret, source: record.source });
  return (
    <DbxRoot style={{ padding: "4px 0 24px" }}>
      <Stack gap={16}>
        <Notice
          tone={tone === "danger" ? "danger" : tone === "success" ? "info" : "warning"}
          title={headline}
          action={
            <Button size="sm" disabled={Boolean(busy)} onClick={() => setNonce((n) => n + 1)}>
              Check again
            </Button>
          }
        >
          {detail ?? (live?.state === "connected" ? `It has answered ${live.answered ?? 0} mention${live.answered === 1 ? "" : "s"} since it started.` : "")}
        </Notice>
        <Stack gap={8}>
          <Text weight={500}>How it's connected</Text>
          <Row label="Buzz identity">
            <Text size="sm" mono>
              {props.pubkey.slice(0, 16)}…
            </Text>{" "}
            <Badge>owned by you</Badge>
          </Row>
          <Row label="Databricks App">
            <Text size="sm" mono>
              {record.config.app}
            </Text>{" "}
            {app && <StatusDot tone={compute === "ACTIVE" ? "success" : compute === "ERROR" ? "danger" : "neutral"} label={COMPUTE_LABEL[compute ?? ""] ?? "unknown"} />}
          </Row>
          <Row label="Runs as">
            <Text size="sm">
              {record.servicePrincipal?.name ?? app?.service_principal_name ?? "its service principal"}{" "}
              <Text as="span" size="sm" mono tone="subtle">
                {record.servicePrincipal?.id ?? app?.service_principal_client_id}
              </Text>
            </Text>
          </Row>
          <Row label="Key">
            <Text size="sm" mono>
              {record.secret}
            </Text>
          </Row>
          <Row label="Code">
            <Text size="sm" mono>
              {record.source}
            </Text>
          </Row>
        </Stack>
        {props.provider.outdated(record) && !isSearch(record.config) && (
          <Notice tone="info" title="Newer code is available">
            This plugin has a newer buzz-app.mjs. Deploy again puts it in the app's folder and deploys it; your app.mjs stays as it is.
          </Notice>
        )}
        {isSearch(record.config) && <SearchInfo provider={props.provider} pubkey={props.pubkey} live={live} busy={Boolean(busy)} run={run} />}
        {record.config.mode === "own" && (
          <Stack gap={8}>
            <Text weight={500}>Connect your app's code</Text>
            <Text size="sm" tone="subtle">
              1. Copy buzz-app.mjs from {record.source} into your app, and use it as app.mjs there does. 2. Add this to your app.yaml (or set the environment variable). 3. Deploy your app.
            </Text>
            <CodeView code={yaml} language="yaml" copy />
          </Stack>
        )}
        <Field label="Answers" hint="Whose mentions it takes, unless its code says otherwise. It reads this again within a minute.">
          <select
            className="dbx-select"
            disabled={Boolean(busy)}
            value={record.config.answers}
            onChange={(event) => run("answers", () => props.provider.setAnswers(props.pubkey, event.target.value as Answers))}
          >
            <option value="everyone">Everyone in its channels</option>
            <option value="owner">Only you</option>
          </select>
        </Field>
        {error && <Notice tone="danger">{error}</Notice>}
        <Stack direction="row" gap={8} justify="flex-end">
          {app?.url && (
            <Button variant="ghost" onClick={() => openExternal(app.url!)}>
              Open the app
            </Button>
          )}
          {workspace.workspaceUrl(`/apps/${record.config.app}`) && (
            <Button variant="ghost" onClick={() => openExternal(workspace.workspaceUrl(`/apps/${record.config.app}`)!)}>
              Open in Databricks
            </Button>
          )}
          {record.config.mode === "starter" && (
            <Button variant="primary" disabled={Boolean(busy)} onClick={() => run("deploy", () => props.provider.redeploy(props.pubkey))}>
              {busy === "deploy" ? <Spinner size={11} /> : null}Deploy again
            </Button>
          )}
        </Stack>
      </Stack>
    </DbxRoot>
  );
}

/** A search index's progress, and who can search it. */
function SearchInfo(props: { provider: AppProvider; pubkey: string; live?: AppStatus["live"]; busy: boolean; run(label: string, work: () => Promise<unknown>): void }) {
  const allowed = useAsync((signal) => props.provider.everyoneAllowed(props.pubkey, signal), [props.pubkey, props.busy]);
  const live = props.live as (AppStatus["live"] & Record<string, unknown>) | undefined;
  const line = (label: string, value: unknown) =>
    typeof value === "string" || typeof value === "number" ? (
      <Row label={label}>
        <Text size="sm">{String(value)}</Text>
      </Row>
    ) : null;
  return (
    <Stack gap={8}>
      <Text weight={500}>Search</Text>
      {line("Index", live?.index)}
      {line("Indexed", live?.indexed)}
      {line("Self-check", live?.searchCheck)}
      {line("Reading", live?.reading)}
      <Text size="sm" tone="subtle">
        People search from the Search page in Buzz (in the Lakebase plugin), as themselves: they need Can Use on this app.{" "}
        {allowed.data ? "Everyone in the workspace has it." : "So far only you have it."} It indexes public channels only, but anyone with Can Use can search them, so give it to people in this community.
      </Text>
      {allowed.data === false && (
        <Stack direction="row" gap={8}>
          <Button size="sm" disabled={props.busy} onClick={() => props.run("allow", () => props.provider.allowEveryone(props.pubkey))}>
            Let everyone in the workspace search
          </Button>
        </Stack>
      )}
    </Stack>
  );
}

// ── The type ──

/**
 * Search indexes run only the plugin's code, so the owner's Buzz deploys the
 * newer code when the plugin updates (once, a little after it starts).
 * Starter apps may have the owner's edits: their Settings tab offers it instead.
 */
export function refreshSearchIndexes(provider: AppProvider): () => void {
  const timer = setTimeout(() => {
    for (const record of provider.records())
      if (record.community && isSearch(record.config) && provider.outdated(record)) void provider.redeploy(record.pubkey!).catch(() => {});
  }, 20_000);
  return () => clearTimeout(timer);
}

export function registerAppType(agents: Agents, service: DatabricksService): () => void {
  const provider = appProvider(agents, service);
  const icon = databricksIcon() as unknown as AgentType["icon"];
  const type = {
    id: APP_TYPE_ID,
    icon,
    title: "Databricks App",
    description: "A Buzz identity for code running as a Databricks App, like a Slack app: it works as the app's service principal and can answer anyone in its channels.",
    defaults: () => ({ config: normalizeAppConfig({}) }),
    summary: (agent: { config: unknown; pubkey?: string }) => summarizeApp(provider.read(agent.pubkey ?? "")?.config ?? normalizeAppConfig(agent.config)),
    Create: (props: { config: unknown; onChange(config: unknown): void; onReadyChange?(ready: boolean): void; disabled: boolean }) => (
      <AppForm service={service} config={normalizeAppConfig(props.config)} onChange={props.onChange} {...(props.onReadyChange && { onReadyChange: props.onReadyChange })} disabled={props.disabled} />
    ),
    tabs: [
      {
        id: "settings",
        title: "Settings",
        role: "settings" as const,
        component: (props: { agent: { pubkey: string } }) => <AppSettings service={service} provider={provider} pubkey={props.agent.pubkey} />,
      },
    ],
    remote: {
      provision: provider.provision,
      activate: provider.activate,
      profile: provider.profile,
      remove: provider.remove,
    },
  };
  agents.register(type as unknown as AgentType);
  return refreshSearchIndexes(provider);
}
