// The Databricks agent type: hosted, so each agent runs fully remote in its
// own Databricks Sandbox and answers with the owner's laptop off. Buzz calls
// `provision` (we make the Sandbox, which makes the agent's key: it never
// leaves Databricks) and `activate` (we hand the runner the owner's
// attestation and start it, plus a keeper job that brings it back after the
// Sandbox's 24-hour limit or a sleep). The runner (../runner) does the rest.
//
// Hosted agents run unattended, so their harnesses always use Standard
// permissions (each harness's own guarded mode) and answer only their owner.
import type { Agents, AgentType } from "@buzz/author";
import { SANDBOX_HOME, Sandboxes } from "@dbx/core/api/sandbox";
import type { DatabricksClient } from "@dbx/core/client";
import { React } from "@dbx/core/react";
import { type DatabricksService, describeError, useAsync, useConnection } from "@dbx/core/service";
import { Button, DbxRoot, databricksIcon, Field, Notice, Spinner, Stack, Text } from "@dbx/core/ui/components";
import { RUNNER, RUNNER_SHA } from "virtual:agent-runner";
import type { RunnerConfig } from "../runner/store";
import { deleteKeeper, ensureKeeper } from "./keeper";
import { HARNESS_MODEL, HARNESSES, harnessAccepts, harnessLabel, harnessModel, permissionsHint, type RemoteHarness, shellQuote, WORK_DIR } from "./remote";
import { cachedList, genieSpaces, ModelField, NeedsConnection, SinglePicker, useAgentService, WorkspaceField } from "./ui";

export const HOSTED_TYPE_ID = "databricks-hosted";
const AGENT_DIR = `${SANDBOX_HOME}/.buzz/agent`;
const RECORD_PREFIX = "bkvarda.databricks-hosted.v1:";
/** A sleeping agent stops its Sandbox after this many minutes without work. */
const IDLE_MINUTES = 5;

export type HostedKind = "genie" | "sandbox";
export type Availability = "always" | "sleep";

export type HostedConfig = {
  kind: HostedKind;
  /** A CLI profile for another workspace; unset uses Buzz's connection. */
  profile?: string;
  /** A Genie agent to ask instead of Genie One. */
  genie?: { space: string; label: string };
  harness: RemoteHarness;
  model: string;
  availability: Availability;
  scope: "thread" | "channel";
  instructions: string;
};

const HARNESS_CHOICES = HARNESSES.filter((harness): harness is (typeof HARNESSES)[number] & { id: RemoteHarness } => harness.id !== "builtin");

export function normalizeHosted(value: unknown): HostedConfig {
  const config = (value ?? {}) as Partial<HostedConfig>;
  const harness = HARNESS_CHOICES.some((choice) => choice.id === config.harness) ? (config.harness as RemoteHarness) : "claude";
  const genie = config.genie && typeof config.genie.space === "string" && config.genie.space ? { space: config.genie.space, label: String(config.genie.label || config.genie.space) } : undefined;
  return {
    kind: config.kind === "sandbox" ? "sandbox" : "genie",
    harness,
    model: typeof config.model === "string" && harnessAccepts(harness, config.model) ? config.model : HARNESS_MODEL[harness],
    availability: config.availability === "always" ? "always" : "sleep",
    scope: config.scope === "channel" ? "channel" : "thread",
    instructions: typeof config.instructions === "string" ? config.instructions : "",
    ...(typeof config.profile === "string" && config.profile && { profile: config.profile }),
    ...(genie && { genie }),
  };
}

export function summarizeHosted(config: HostedConfig): string {
  const what = config.kind === "genie" ? (config.genie ? `Genie · ${config.genie.label}` : "Genie One") : `${harnessLabel(config.harness)} · ${harnessModel(config.harness, config.model).replace(/^system\.ai\./, "")}`;
  return [what, config.availability === "always" ? "always on" : "sleeps when idle", ...(config.profile ? [config.profile] : [])].join(" · ");
}

// ── Provider records (this device) ──

/** What this device keeps for a hosted agent: enough to rebuild the runner's config. */
export type HostedRecord = {
  pubkey?: string;
  sandbox: string;
  name: string;
  picture?: string;
  config: HostedConfig;
  community?: string;
  owner?: string;
  authTag?: string[];
  jobId?: number;
  createdAt: number;
};

const recordKey = (pubkey: string) => `${RECORD_PREFIX}${pubkey}`;
const pendingKey = (community: string, name: string) => `${RECORD_PREFIX}pending:${community}:${name}`;
const parse = (raw: string | null): HostedRecord | undefined => {
  try {
    return raw ? (JSON.parse(raw) as HostedRecord) : undefined;
  } catch {
    return undefined;
  }
};

const randomHex = (bytes: number) => [...crypto.getRandomValues(new Uint8Array(bytes))].map((b) => b.toString(16).padStart(2, "0")).join("");

export function runnerConfigOf(record: HostedRecord, host?: string): RunnerConfig {
  if (!record.community || !record.owner || !record.authTag) throw new Error("This agent hasn't been activated yet.");
  const config = record.config;
  return {
    relay: record.community,
    owner: record.owner,
    authTag: record.authTag,
    name: record.name,
    ...(record.picture && { picture: record.picture }),
    kind: config.kind,
    ...(config.genie && { genieSpace: config.genie.space }),
    harness: config.harness,
    model: harnessModel(config.harness, config.model),
    // Unattended: always each harness's guarded mode.
    permissions: "standard",
    instructions: config.instructions,
    scope: config.scope,
    availability: config.availability,
    idleMinutes: IDLE_MINUTES,
    sandbox: record.sandbox,
    ...(host && { workspaceHost: host }),
  };
}

// ── Sandbox operations ──

function workspaceOf(service: DatabricksService, profile: string | undefined): DatabricksService {
  return profile && service.forProfile ? service.forProfile(profile) : service;
}

async function sandboxOf(service: DatabricksService, record: Pick<HostedRecord, "config">, signal?: AbortSignal) {
  const client = await workspaceOf(service, record.config.profile).ready(signal);
  return { client, sandboxes: new Sandboxes(client) };
}

/** A hosted agent's Sandbox never stops on idle: the runner decides when to sleep, between turns. */
const keepAwake = (client: DatabricksClient, sandbox: string, signal?: AbortSignal) =>
  client.json(`/api/2.0/lakebox/sandboxes/${encodeURIComponent(sandbox)}`, { method: "PATCH", body: { no_autostop: true }, ...(signal && { signal }) });

async function uploadRunner(sandboxes: Sandboxes, sandbox: string, signal?: AbortSignal) {
  const current = await sandboxes.bash(sandbox, `cat ${shellQuote(`${AGENT_DIR}/runner.sha`)} 2>/dev/null`, { timeoutSeconds: 30, ...(signal && { signal }) });
  if (current.stdout?.trim() === RUNNER_SHA) return;
  await sandboxes.writeFile(sandbox, `${AGENT_DIR}/runner.mjs`, RUNNER, signal);
  await sandboxes.bash(sandbox, `echo ${RUNNER_SHA} > ${shellQuote(`${AGENT_DIR}/runner.sha`)}`, { timeoutSeconds: 30, ...(signal && { signal }) });
}

async function runner(sandboxes: Sandboxes, sandbox: string, args: string, signal?: AbortSignal, timeoutSeconds = 90): Promise<string> {
  const result = await sandboxes.bash(sandbox, `node ${shellQuote(`${AGENT_DIR}/runner.mjs`)} ${args}`, { timeoutSeconds, ...(signal && { signal }) });
  if (result.exit_code !== 0) throw new Error(`The agent's runner couldn't ${args.split(" ")[0]}: ${(result.stderr || result.stdout || `exit ${result.exit_code}`).trim().slice(-400)}`);
  return (result.stdout ?? "").trim();
}

/** Starts the Sandbox if it sleeps, refreshes the runner and its config, and (re)starts it. */
async function deploy(service: DatabricksService, record: HostedRecord, options: Readonly<{ restart: boolean; publishProfile: boolean; signal?: AbortSignal }>) {
  const { client, sandboxes } = await sandboxOf(service, record, options.signal);
  await sandboxes.ensureRunning(record.sandbox, { ...(options.signal && { signal: options.signal }) });
  await uploadRunner(sandboxes, record.sandbox, options.signal);
  await sandboxes.writeFile(record.sandbox, `${AGENT_DIR}/config.json`, `${JSON.stringify(runnerConfigOf(record, client.host), null, 2)}\n`, options.signal);
  // Best effort: the relay may admit the agent only once Buzz writes its listing, after
  // activation; the runner keeps trying until the profile is accepted.
  if (options.publishProfile) await runner(sandboxes, record.sandbox, "profile", options.signal).catch(() => {});
  if (options.restart) await runner(sandboxes, record.sandbox, "stop", options.signal);
  await runner(sandboxes, record.sandbox, "start", options.signal);
  return { client, sandboxes };
}

export type HostedProvider = ReturnType<typeof hostedProvider>;

/** Provision, activate and the rest, against this device's records. */
export function hostedProvider(agents: Pick<Agents, "storage">, service: DatabricksService) {
  const storage = agents.storage;
  const read = (pubkey: string) => parse(storage.get(recordKey(pubkey)));
  const write = (record: HostedRecord) => storage.set(recordKey(record.pubkey!), JSON.stringify(record));
  const records = () =>
    storage
      .keys()
      .filter((key) => key.startsWith(RECORD_PREFIX) && !key.includes(":pending:"))
      .map((key) => parse(storage.get(key)))
      .filter((record): record is HostedRecord => Boolean(record?.pubkey));

  return {
    read,
    records,
    async provision(input: Readonly<{ name: string; picture?: string; community: string; config?: unknown; signal: AbortSignal }>) {
      const config = normalizeHosted(input.config);
      // A retried creation reuses its Sandbox, so it never makes two keys.
      const pending = pendingKey(input.community, input.name);
      const record: HostedRecord = parse(storage.get(pending)) ?? {
        sandbox: `buzz-hosted-${randomHex(5)}`,
        name: input.name,
        ...(input.picture && { picture: input.picture }),
        config,
        createdAt: Date.now(),
      };
      await storage.set(pending, JSON.stringify(record));
      const { client, sandboxes } = await sandboxOf(service, record, input.signal);
      await sandboxes.ensureRunning(record.sandbox, { displayName: `Buzz agent: ${input.name}`.slice(0, 60), tags: { created_by: "buzz", buzz_hosted: "true" }, signal: input.signal });
      await keepAwake(client, record.sandbox, input.signal);
      await sandboxes.bash(record.sandbox, `mkdir -p ${shellQuote(AGENT_DIR)} ${shellQuote(WORK_DIR)}`, { timeoutSeconds: 30, signal: input.signal });
      await uploadRunner(sandboxes, record.sandbox, input.signal);
      const { pubkey } = JSON.parse(await runner(sandboxes, record.sandbox, "keygen", input.signal)) as { pubkey: string };
      if (!/^[0-9a-f]{64}$/.test(pubkey)) throw new Error("The agent's Sandbox didn't make a key.");
      await write({ ...record, pubkey });
      return { pubkey, ...(record.picture && { picture: record.picture }) };
    },
    async activate(input: Readonly<{ pubkey: string; name: string; community: string; auth: readonly string[]; config?: unknown; signal: AbortSignal }>) {
      const found = read(input.pubkey);
      if (!found) throw new Error("This agent's Sandbox was set up from another device; remove the agent and create it again here.");
      const record: HostedRecord = {
        ...found,
        name: input.name,
        config: normalizeHosted(input.config ?? found.config),
        community: input.community,
        owner: String(input.auth[1]),
        authTag: [...input.auth].map(String),
      };
      const { client } = await deploy(service, record, { restart: true, publishProfile: true, signal: input.signal });
      record.jobId = await ensureKeeper(client, { ...(record.jobId && { jobId: record.jobId }), sandbox: record.sandbox, agentName: record.name, pubkey: input.pubkey, availability: record.config.availability, signal: input.signal });
      await write(record);
      await storage.set(pendingKey(input.community, found.name), null);
    },
    async profile(input: Readonly<{ pubkey: string; community: string; name: string; picture?: string; signal: AbortSignal }>) {
      const found = read(input.pubkey);
      if (!found) return;
      const record: HostedRecord = { ...found, name: input.name };
      if (input.picture) record.picture = input.picture;
      else delete record.picture;
      await deploy(service, record, { restart: false, publishProfile: true, signal: input.signal });
      await write(record);
    },
    async interrupt(input: Readonly<{ pubkey: string; channelId: string; threadRootId: string; signal: AbortSignal }>) {
      const record = read(input.pubkey);
      if (!record) return false;
      const { sandboxes } = await sandboxOf(service, record, input.signal);
      return (await runner(sandboxes, record.sandbox, `interrupt ${shellQuote(input.channelId)} ${shellQuote(input.threadRootId)}`, input.signal)) === "true";
    },
    async remove(input: Readonly<{ pubkey: string; signal: AbortSignal }>) {
      const record = read(input.pubkey);
      if (!record) return;
      const { client, sandboxes } = await sandboxOf(service, record, input.signal);
      if (record.jobId) await deleteKeeper(client, record.jobId, input.signal);
      try {
        await sandboxes.delete(record.sandbox);
      } catch (error) {
        if ((error as { status?: number }).status !== 404) throw error;
      }
      await storage.set(recordKey(input.pubkey), null);
    },
    /** Applies new settings from the agent's Settings tab. */
    async update(pubkey: string, config: HostedConfig, signal?: AbortSignal) {
      const found = read(pubkey);
      if (!found) throw new Error("This agent is managed from another device.");
      const record: HostedRecord = { ...found, config: { ...config, kind: found.config.kind, ...(found.config.profile ? { profile: found.config.profile } : {}) } };
      const { client } = await deploy(service, record, { restart: true, publishProfile: false, ...(signal && { signal }) });
      record.jobId = await ensureKeeper(client, { ...(record.jobId && { jobId: record.jobId }), sandbox: record.sandbox, agentName: record.name, pubkey, availability: record.config.availability, ...(signal && { signal }) });
      await write(record);
    },
    /** Wakes the agent's Sandbox now and starts its runner. */
    async wake(pubkey: string, signal?: AbortSignal) {
      const record = read(pubkey);
      if (!record) throw new Error("This agent is managed from another device.");
      const { sandboxes } = await sandboxOf(service, record, signal);
      await sandboxes.ensureRunning(record.sandbox, { ...(signal && { signal }) });
      await sandboxes.bash(record.sandbox, `touch ${shellQuote(`${AGENT_DIR}/awake`)}`, { timeoutSeconds: 30, ...(signal && { signal }) });
      await runner(sandboxes, record.sandbox, "start", signal);
    },
    async status(pubkey: string, signal?: AbortSignal) {
      const record = read(pubkey);
      if (!record) return undefined;
      const { sandboxes } = await sandboxOf(service, record, signal);
      const sandbox = await sandboxes.get(record.sandbox, signal).catch(() => undefined);
      const state = sandbox?.status?.state ?? "missing";
      if (state !== "SANDBOX_STATE_RUNNING") return { record, state, runner: undefined };
      const runnerStatus = JSON.parse(await runner(sandboxes, record.sandbox, "status", signal).catch(() => "{}")) as { running?: boolean; connected?: boolean; active?: number; lastError?: string; lastActivity?: string };
      return { record, state, runner: runnerStatus };
    },
  };
}

/**
 * While this Buzz is open, its sleeping agents stay awake: every few minutes
 * it touches each one's heartbeat (starting a stopped Sandbox), so mentions
 * get answered in seconds. With the laptop off, the keeper wakes them.
 */
export function keepAgentsAwake(provider: HostedProvider): () => void {
  const beat = () => {
    for (const record of provider.records())
      if (record.config.availability === "sleep" && record.community) void provider.wake(record.pubkey!).catch(() => {});
  };
  const first = setTimeout(beat, 30_000);
  const timer = setInterval(beat, 4 * 60_000);
  return () => {
    clearTimeout(first);
    clearInterval(timer);
  };
}

// ── Form ──

type FormProps = { config: HostedConfig; onChange(config: HostedConfig): void; disabled?: boolean };

const KIND_CHOICES: readonly { id: HostedKind; label: string; detail: string }[] = [
  { id: "genie", label: "Genie", detail: "Answers data questions with Genie One, or with one of your Genie agents, as charts and tables." },
  { id: "sandbox", label: "Sandbox agent", detail: "Claude Code, Codex or Pi, working in its own Databricks Sandbox with the Databricks CLI signed in as you." },
];

const AVAILABILITY_HINT: Record<Availability, string> = {
  always: "Replies within seconds at any time. Its Sandbox runs all the time.",
  sleep: `Its Sandbox sleeps after ${IDLE_MINUTES} minutes without work. It stays awake while your Buzz is open; with your laptop off it wakes every 15 minutes, so a reply can take that long.`,
};

/** Genie One, or one of the workspace's Genie agents. */
function GenieField(props: { service: DatabricksService; value?: { space: string; label: string }; onChange(value: { space: string; label: string } | undefined): void; disabled?: boolean }) {
  const status = useConnection(props.service).status;
  const spaces = useAsync(() => genieSpaces(props.service), [props.service, status]);
  const options = [
    { id: "", label: "Genie One", group: "Databricks", detail: "Questions about any data you can access" },
    ...(spaces.data ?? []).map((space) => ({ id: space.space_id, label: space.title, group: "Genie agents", ...(space.description && { detail: space.description }) })),
  ];
  return (
    <SinglePicker
      label="Genie"
      hint="Genie One finds the right data across the workspace; a Genie agent answers about the data its team set up."
      value={props.value?.space ?? ""}
      valueLabel={props.value?.label ?? "Genie One"}
      placeholder="Genie One"
      searchPlaceholder={`Search ${options.length} options`}
      options={options}
      loading={spaces.loading && !spaces.data ? "Loading Genie agents…" : false}
      {...(props.disabled !== undefined && { disabled: props.disabled })}
      onChange={(option) => props.onChange(option.id ? { space: option.id, label: option.label } : undefined)}
    />
  );
}

export function HostedForm(props: FormProps & { service: DatabricksService; locked?: boolean }) {
  const { config, onChange } = props;
  const workspace = useAgentService(props.service, config.profile);
  const status = useConnection(workspace).status;
  const available = useAsync(() => cachedList(workspace, "sandbox", async () => new Sandboxes(await workspace.ready()).available()), [workspace, status]);
  const kind = KIND_CHOICES.find((choice) => choice.id === config.kind) ?? KIND_CHOICES[0]!;
  const harness = HARNESS_CHOICES.find((choice) => choice.id === config.harness) ?? HARNESS_CHOICES[0]!;
  const disabled = props.disabled !== undefined ? { disabled: props.disabled } : {};
  return (
    <DbxRoot>
      <Stack gap={14}>
        <NeedsConnection service={props.service} />
        {available.data === false && <Notice tone="warning">Databricks Sandbox isn't on in this workspace, and this agent runs in one. An admin can turn on the Sandbox preview.</Notice>}
        {!props.locked && (
          <Field label="Type" hint={kind.detail}>
            <select className="dbx-select" {...disabled} value={kind.id} onChange={(event) => onChange({ ...config, kind: event.target.value as HostedKind })}>
              {KIND_CHOICES.map((choice) => (
                <option key={choice.id} value={choice.id}>
                  {choice.label}
                </option>
              ))}
            </select>
          </Field>
        )}
        {!props.locked && (
          <WorkspaceField
            service={props.service}
            {...(config.profile && { profile: config.profile })}
            {...disabled}
            onChange={(profile) => {
              const { profile: _old, genie: _genie, ...rest } = config;
              onChange({ ...rest, ...(profile && { profile }) });
            }}
          />
        )}
        {config.kind === "genie" ? (
          <GenieField
            service={workspace}
            {...(config.genie && { value: config.genie })}
            {...disabled}
            onChange={(genie) => {
              const { genie: _old, ...rest } = config;
              onChange({ ...rest, ...(genie && { genie }) });
            }}
          />
        ) : (
          <>
            <Field label="Harness" hint={`${harness.detail} ${permissionsHint(harness.id, "standard")}`}>
              <select
                className="dbx-select"
                {...disabled}
                value={harness.id}
                onChange={(event) => {
                  const next = event.target.value as RemoteHarness;
                  onChange({ ...config, harness: next, model: harnessAccepts(next, config.model) ? config.model : HARNESS_MODEL[next] });
                }}
              >
                {HARNESS_CHOICES.map((choice) => (
                  <option key={choice.id} value={choice.id}>
                    {choice.label}
                  </option>
                ))}
              </select>
            </Field>
            <ModelField
              service={workspace}
              value={config.model}
              {...disabled}
              accepts={(id) => harnessAccepts(harness.id, id)}
              hint={`Models ${harness.label} can use, from AI Gateway in this workspace.`}
              onChange={(model) => onChange({ ...config, model })}
            />
          </>
        )}
        <Field label="Availability" hint={AVAILABILITY_HINT[config.availability]}>
          <select className="dbx-select" {...disabled} value={config.availability} onChange={(event) => onChange({ ...config, availability: event.target.value as Availability })}>
            <option value="sleep">Sleep when idle</option>
            <option value="always">Always on</option>
          </select>
        </Field>
        <Field label="Conversation" hint="Thread: each thread is its own conversation. Channel: one conversation for the whole channel.">
          <select className="dbx-select" {...disabled} value={config.scope} onChange={(event) => onChange({ ...config, scope: event.target.value as HostedConfig["scope"] })}>
            <option value="thread">One per thread</option>
            <option value="channel">One per channel</option>
          </select>
        </Field>
        {config.kind === "sandbox" && (
          <Field label="Instructions" hint="Optional. Who it is, what it should focus on, how to answer.">
            <textarea className="dbx-textarea" rows={5} {...disabled} value={config.instructions} onChange={(event) => onChange({ ...config, instructions: event.target.value })} />
          </Field>
        )}
        {!props.locked && (
          <Text tone="tertiary" size="xs">
            Runs in Databricks, so it answers you with your laptop off. Only your own messages reach it. Its Sandbox and a small scheduled job that keeps it running belong to you in Databricks; removing the agent deletes both.
          </Text>
        )}
      </Stack>
    </DbxRoot>
  );
}

// ── Settings tab ──

const STATE_LABEL: Record<string, string> = {
  SANDBOX_STATE_RUNNING: "Running",
  SANDBOX_STATE_STOPPED: "Asleep",
  SANDBOX_STATE_STOPPING: "Going to sleep",
  SANDBOX_STATE_PENDING: "Starting",
  missing: "Its Sandbox is gone",
};

export function HostedSettings(props: { service: DatabricksService; provider: HostedProvider; pubkey: string }) {
  const [nonce, setNonce] = React.useState(0);
  const status = useAsync(() => props.provider.status(props.pubkey), [props.pubkey, nonce]);
  const record = props.provider.read(props.pubkey);
  const [draft, setDraft] = React.useState(record?.config);
  const [busy, setBusy] = React.useState<string>();
  const [error, setError] = React.useState<string>();
  if (!record || !draft)
    return (
      <DbxRoot style={{ padding: "4px 0 24px" }}>
        <Notice tone="info">This agent was set up from another device, which manages its settings.</Notice>
      </DbxRoot>
    );
  const workspace = workspaceOf(props.service, record.config.profile);
  const run = (label: string, work: () => Promise<void>) => {
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
  const state = status.data?.state;
  const runnerState = status.data?.runner;
  const dirty = JSON.stringify(draft) !== JSON.stringify(record.config);
  const job = record.jobId ? workspace.workspaceUrl(`/jobs/${record.jobId}`) : undefined;
  return (
    <DbxRoot style={{ padding: "4px 0 24px" }}>
      <Stack gap={16}>
        <Notice
          tone={state === "SANDBOX_STATE_RUNNING" && runnerState?.running === false ? "warning" : "info"}
          title={status.loading && !status.data ? "Checking…" : (STATE_LABEL[state ?? ""] ?? state ?? "Unknown")}
          action={
            <Button size="sm" disabled={Boolean(busy)} onClick={() => run("wake", () => props.provider.wake(props.pubkey))}>
              {busy === "wake" ? <Spinner size={11} /> : null}
              {state === "SANDBOX_STATE_RUNNING" ? "Check again" : "Wake now"}
            </Button>
          }
        >
          {state === "SANDBOX_STATE_RUNNING"
            ? runnerState?.running
              ? `${runnerState.connected ? "Connected to the community" : "Connecting"}${runnerState.active ? ` · working on ${runnerState.active}` : ""}${runnerState.lastError ? ` · last error: ${runnerState.lastError}` : ""}.`
              : "The Sandbox is up but the agent isn't running; Wake now starts it."
            : state === "SANDBOX_STATE_STOPPED"
              ? "It wakes on its schedule, or now with Wake now."
              : `Sandbox ${record.sandbox}.`}{" "}
          {job && (
            <a className="dbx-link" href={job} target="_blank" rel="noreferrer">
              Keeper job
            </a>
          )}
        </Notice>
        <HostedForm service={props.service} config={draft} onChange={setDraft} {...(busy && { disabled: true })} locked />
        {error && <Notice tone="danger">{error}</Notice>}
        <Stack direction="row" gap={8} justify="flex-end">
          <Button variant="ghost" disabled={!dirty || Boolean(busy)} onClick={() => setDraft(record.config)}>
            Revert
          </Button>
          <Button variant="primary" disabled={!dirty || Boolean(busy)} onClick={() => run("save", () => props.provider.update(props.pubkey, draft))}>
            {busy === "save" ? <Spinner size={11} /> : null}Save
          </Button>
        </Stack>
      </Stack>
    </DbxRoot>
  );
}

// ── The type ──

export function registerHostedType(agents: Agents, service: DatabricksService): () => void {
  const provider = hostedProvider(agents, service);
  const icon = databricksIcon() as unknown as AgentType["icon"];
  const type = {
    id: HOSTED_TYPE_ID,
    icon,
    title: "Databricks",
    description: "Genie, or Claude Code, Codex or Pi in a Databricks Sandbox. Runs in Databricks, so it answers with your laptop off.",
    defaults: () => ({ config: normalizeHosted({}) }),
    summary: (agent: { config: unknown; pubkey?: string }) => summarizeHosted(provider.read(agent.pubkey ?? "")?.config ?? normalizeHosted(agent.config)),
    Create: (props: { config: unknown; onChange(config: unknown): void; disabled: boolean }) => (
      <HostedForm service={service} config={normalizeHosted(props.config)} onChange={props.onChange} disabled={props.disabled} />
    ),
    tabs: [
      {
        id: "settings",
        title: "Settings",
        role: "settings" as const,
        component: (props: { agent: { pubkey: string } }) => <HostedSettings service={service} provider={provider} pubkey={props.agent.pubkey} />,
      },
    ],
    remote: {
      provision: provider.provision,
      activate: provider.activate,
      profile: provider.profile,
      interrupt: provider.interrupt,
      remove: provider.remove,
    },
  };
  agents.register(type as unknown as AgentType);
  return keepAgentsAwake(provider);
}
