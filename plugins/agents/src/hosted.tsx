// The hosted Databricks agent type ("Databricks (hosted)"): each agent runs in
// its own Databricks Sandbox, so it keeps answering with the owner's Buzz
// closed. Buzz calls `provision` (we make the Sandbox, which makes the agent's
// key: it never leaves Databricks) and `activate` (we hand the runner the
// owner's attestation and start it). The runner (../runner) does the rest.
//
// Nothing outside the Sandbox runs on a schedule. The owner's Buzz, while it's
// open, starts a stopped Sandbox again and restarts a long-running one at a
// quiet moment: Databricks stops a Sandbox 24 hours after it starts, so this
// gives an always-on agent a fresh day ahead whenever its owner leaves.
//
// Hosted agents run unattended, so their harnesses always use Standard
// permissions (each harness's own guarded mode) and answer only their owner.
import type { Agents, AgentType } from "@buzz/author";
import { SANDBOX_HOME, Sandboxes } from "@dbx/core/api/sandbox";
import { Skills } from "@dbx/core/api/skills";
import type { DatabricksClient } from "@dbx/core/client";
import { React } from "@dbx/core/react";
import { type DatabricksService, describeError, useAsync, useConnection } from "@dbx/core/service";
import { Button, DbxRoot, databricksIcon, Field, Notice, Spinner, Stack, Text } from "@dbx/core/ui/components";
import type { RunnerConfig } from "../runner/store";
import { uploadRunner } from "./runner-upload";
import { type ActivityLine, type ActivityTurn, turnsFromLines } from "./activity";
import { type ActivityTabProps, ActivityView } from "./activity-ui";
import { HARNESS_MODEL, HARNESSES, harnessAccepts, harnessLabel, harnessModel, permissionsHint, type RemoteHarness, shellQuote, WORK_DIR } from "./remote";
import { GENIE_ONE_CHOICE, normalizeChoices, type ToolChoice, workspaceIdOf } from "./capabilities";
import { GenieKindIcon, OmnigentKindIcon, SandboxKindIcon } from "./icons";
import { DEFAULT_OMNIGENT_AGENT, Omnigent, omnigentAgentLabel } from "./omnigent";
import { normalizeSkills, resolveSkills, type SkillsChoice, skillCatalogFor } from "./skills";
import { installSkills } from "./skills-sandbox";
import { cachedList, genieSpaces, ModelField, NeedsConnection, SinglePicker, SkillsField, ToolsField, useAgentService, WorkspaceField } from "./ui";

export const HOSTED_TYPE_ID = "databricks-hosted";
const AGENT_DIR = `${SANDBOX_HOME}/.buzz/agent`;
const RECORD_PREFIX = "bkvarda.databricks-hosted.v1:";
/** A sleeping agent stops its Sandbox after this many minutes without work (once its owner's Buzz is closed). */
const IDLE_MINUTES = 5;
/** How often the owner's open Buzz looks after its hosted agents. */
const TEND_EVERY_MS = 4 * 60_000;
/** An always-on agent's Sandbox is restarted, at a quiet moment, once it has run this long. */
export const REFRESH_AFTER_HOURS = 8;
/** "A quiet moment": no turn running and none for this long. */
const QUIET_MINUTES = 10;
/** Databricks stops a Sandbox this long after each start. */
const SANDBOX_DAY_HOURS = 24;

export type HostedKind = "genie" | "sandbox" | "omnigent";
export type Availability = "always" | "sleep";

export type HostedConfig = {
  kind: HostedKind;
  /** A CLI profile for another workspace; unset uses Buzz's connection. */
  profile?: string;
  /** A Genie agent to ask instead of Genie One. */
  genie?: { space: string; label: string };
  /** The Omnigent agent (its name, e.g. "claude-native-ui") an Omnigent agent runs as. */
  omnigent?: { agent: string; label: string };
  harness: RemoteHarness;
  model: string;
  /** A Sandbox agent's Databricks tools (Genie One, Genie agents, MCP servers), as the local type's. */
  tools: ToolChoice[];
  /** Unity Catalog skills, installed in its Sandbox. The channel's skills aren't installed for hosted agents. */
  skills?: SkillsChoice;
  availability: Availability;
  scope: "thread" | "channel";
  instructions: string;
};

const HARNESS_CHOICES = HARNESSES.filter((harness): harness is (typeof HARNESSES)[number] & { id: RemoteHarness } => harness.id !== "builtin");

export function normalizeHosted(value: unknown): HostedConfig {
  const config = (value ?? {}) as Partial<HostedConfig>;
  const harness = HARNESS_CHOICES.some((choice) => choice.id === config.harness) ? (config.harness as RemoteHarness) : "claude";
  const genie = config.genie && typeof config.genie.space === "string" && config.genie.space ? { space: config.genie.space, label: String(config.genie.label || config.genie.space) } : undefined;
  const kind: HostedKind = config.kind === "sandbox" || config.kind === "omnigent" ? config.kind : "genie";
  const omnigent =
    kind === "omnigent"
      ? config.omnigent && typeof config.omnigent.agent === "string" && config.omnigent.agent
        ? { agent: config.omnigent.agent, label: String(config.omnigent.label || omnigentAgentLabel(config.omnigent.agent)) }
        : { agent: DEFAULT_OMNIGENT_AGENT, label: omnigentAgentLabel(DEFAULT_OMNIGENT_AGENT) }
      : undefined;
  return {
    kind,
    harness,
    model: typeof config.model === "string" && harnessAccepts(harness, config.model) ? config.model : HARNESS_MODEL[harness],
    // Genie One unless the owner chose otherwise (an empty list is a choice).
    tools: Array.isArray(config.tools) ? normalizeChoices(config.tools) : [GENIE_ONE_CHOICE],
    skills: normalizeSkills(config.skills),
    availability: config.availability === "always" ? "always" : "sleep",
    scope: config.scope === "channel" ? "channel" : "thread",
    instructions: typeof config.instructions === "string" ? config.instructions : "",
    ...(typeof config.profile === "string" && config.profile && { profile: config.profile }),
    ...(genie && { genie }),
    ...(omnigent && { omnigent }),
  };
}

export function summarizeHosted(config: HostedConfig): string {
  const what =
    config.kind === "genie"
      ? config.genie
        ? `Genie · ${config.genie.label}`
        : "Genie One"
      : config.kind === "omnigent"
        ? `Omnigent · ${config.omnigent?.label ?? omnigentAgentLabel(DEFAULT_OMNIGENT_AGENT)}`
        : `${harnessLabel(config.harness)} · ${harnessModel(config.harness, config.model).replace(/^system\.ai\./, "")}`;
  return [what, config.availability === "always" ? "always on" : "sleeps when Buzz is closed", ...(config.profile ? [config.profile] : [])].join(" · ");
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
  /** A keeper job from an earlier version of this plugin, deleted when next seen. */
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

export function runnerConfigOf(record: HostedRecord, host?: string, workspaceId?: string): RunnerConfig {
  if (!record.community || !record.owner || !record.authTag) throw new Error("This agent hasn't been activated yet.");
  const config = record.config;
  return {
    relay: record.community,
    owner: record.owner,
    authTag: record.authTag,
    name: record.name,
    ...(record.picture && { picture: record.picture }),
    kind: config.kind,
    ...(config.genie && { genieSpace: config.genie.space, genieLabel: config.genie.label }),
    ...(config.kind === "omnigent" && config.omnigent && { omnigentAgent: config.omnigent.agent, omnigentLabel: config.omnigent.label }),
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
    ...(workspaceId && { workspaceId }),
    ...(config.kind === "sandbox" && config.tools.length && { tools: config.tools }),
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

async function runner(sandboxes: Sandboxes, sandbox: string, args: string, signal?: AbortSignal, timeoutSeconds = 90): Promise<string> {
  const result = await sandboxes.bash(sandbox, `node ${shellQuote(`${AGENT_DIR}/runner.mjs`)} ${args}`, { timeoutSeconds, ...(signal && { signal }) });
  if (result.exit_code !== 0) throw new Error(`The agent's runner couldn't ${args.split(" ")[0]}: ${(result.stderr || result.stdout || `exit ${result.exit_code}`).trim().slice(-400)}`);
  return (result.stdout ?? "").trim();
}

/** What `runner.mjs status` reports. `bootedAt` is when the Sandbox started. */
export type RunnerStatus = Readonly<{ running?: boolean; connected?: boolean; active?: number; lastError?: string; lastActivity?: string; bootedAt?: string }>;

/**
 * Whether an always-on agent's Sandbox should restart now: it has run for
 * `REFRESH_AFTER_HOURS` and nothing has happened for a while. Restarting
 * resets Databricks' 24-hour clock, so the agent has most of a day ahead of
 * it whenever its owner closes Buzz.
 */
export function shouldRefresh(status: RunnerStatus | undefined, now = Date.now()): boolean {
  if (!status?.running || status.active || !status.bootedAt) return false;
  const booted = Date.parse(status.bootedAt);
  const last = Math.max(booted, Date.parse(status.lastActivity ?? "") || 0);
  return now - booted > REFRESH_AFTER_HOURS * 3_600_000 && now - last > QUIET_MINUTES * 60_000;
}

/** Hours until Databricks stops the Sandbox, from when it started. */
export function hoursLeft(bootedAt: string | undefined, now = Date.now()): number | undefined {
  const booted = Date.parse(bootedAt ?? "");
  return Number.isFinite(booted) ? Math.max(0, SANDBOX_DAY_HOURS - (now - booted) / 3_600_000) : undefined;
}

/** Deletes a keeper job an earlier version of this plugin made. Already gone counts as deleted. */
async function dropKeeper(client: DatabricksClient, jobId: number, signal?: AbortSignal) {
  try {
    await client.post("/api/2.2/jobs/delete", { job_id: jobId }, signal ? { signal } : {});
  } catch (error) {
    const status = (error as { status?: number }).status;
    if (status !== 400 && status !== 404) throw error;
  }
}

/** Waits for a Sandbox that was told to stop to finish stopping. */
async function stopped(sandboxes: Sandboxes, sandbox: string, signal?: AbortSignal) {
  const deadline = Date.now() + 4 * 60_000;
  for (;;) {
    const state = (await sandboxes.get(sandbox, signal)).status?.state;
    if (state === "SANDBOX_STATE_STOPPED") return;
    if (Date.now() > deadline) throw new Error(`The agent's Sandbox didn't stop (state: ${state ?? "unknown"}).`);
    await new Promise((resolve) => setTimeout(resolve, 3000));
    signal?.throwIfAborted();
  }
}

/**
 * Installs a sandbox agent's skills in its Sandbox, where its harness looks for
 * them. Hosted agents run unattended, so this runs when the agent is deployed
 * and whenever Buzz wakes it; a failure doesn't stop the agent.
 */
async function syncHostedSkills(service: DatabricksService, record: HostedRecord, sandboxes: Sandboxes, signal?: AbortSignal) {
  if (record.config.kind !== "sandbox") return;
  try {
    const workspace = workspaceOf(service, record.config.profile);
    const { skills } = await resolveSkills(skillCatalogFor(service, record.config.profile), normalizeSkills(record.config.skills));
    await installSkills({ sandboxes, sandbox: record.sandbox, api: new Skills(await workspace.ready(signal)), skills, ...(signal && { signal }) });
  } catch {
    // Kept for the next deploy or wake.
  }
}

/** Starts the Sandbox if it sleeps, refreshes the runner and its config, and (re)starts it. */
async function deploy(service: DatabricksService, record: HostedRecord, options: Readonly<{ restart: boolean; publishProfile: boolean; signal?: AbortSignal }>) {
  const { client, sandboxes } = await sandboxOf(service, record, options.signal);
  await sandboxes.ensureRunning(record.sandbox, { ...(options.signal && { signal: options.signal }) });
  await uploadRunner(sandboxes, record.sandbox, options.signal);
  await syncHostedSkills(service, record, sandboxes, options.signal);
  const workspaceId = workspaceIdOf(workspaceOf(service, record.config.profile));
  await sandboxes.writeFile(record.sandbox, `${AGENT_DIR}/config.json`, `${JSON.stringify(runnerConfigOf(record, client.host, workspaceId), null, 2)}\n`, options.signal);
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
      await deploy(service, record, { restart: true, publishProfile: true, signal: input.signal });
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
      if (record.jobId) await dropKeeper(client, record.jobId, input.signal);
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
      await deploy(service, record, { restart: true, publishProfile: false, ...(signal && { signal }) });
      await write(record);
    },
    /**
     * Wakes the agent: starts its Sandbox if it has stopped (never making a
     * new one: a deleted Sandbox took the agent's key with it), keeps a
     * sleeping one awake, and starts the runner if it isn't running. Then,
     * for an always-on agent, restarts a long-running Sandbox at a quiet
     * moment (`shouldRefresh`) unless `refresh` is false. Resolves with the
     * runner's status.
     */
    async wake(pubkey: string, options: Readonly<{ refresh?: boolean; signal?: AbortSignal }> = {}): Promise<RunnerStatus | undefined> {
      const { signal } = options;
      const record = read(pubkey);
      if (!record) throw new Error("This agent is managed from another device.");
      const { client, sandboxes } = await sandboxOf(service, record, signal);
      if (record.jobId) {
        await dropKeeper(client, record.jobId, signal);
        const { jobId: _old, ...rest } = record;
        await write(rest);
      }
      await sandboxes.get(record.sandbox, signal).catch((error: unknown) => {
        if ((error as { status?: number }).status === 404) throw new Error(`The agent's Sandbox ${record.sandbox} is gone; remove the agent and create it again.`);
        throw error;
      });
      const node = `node ${shellQuote(`${AGENT_DIR}/runner.mjs`)}`;
      // The heartbeat a sleeping agent checks before it sleeps, the runner (if it isn't running) and its status, in one call.
      const script = `${record.config.availability === "sleep" ? `touch ${shellQuote(`${AGENT_DIR}/awake`)} && ` : ""}${node} start >/dev/null && ${node} status`;
      const start = async () => {
        await sandboxes.ensureRunning(record.sandbox, { ...(signal && { signal }) });
        // A newer plugin brings a newer runner: put it in place and restart the runner on it.
        if (await uploadRunner(sandboxes, record.sandbox, signal)) await runner(sandboxes, record.sandbox, "stop", signal);
        await syncHostedSkills(service, record, sandboxes, signal);
        const result = await sandboxes.bash(record.sandbox, script, { timeoutSeconds: 60, ...(signal && { signal }) });
        if (result.exit_code !== 0) throw new Error(`The agent's runner couldn't start: ${(result.stderr || result.stdout || `exit ${result.exit_code}`).trim().slice(-400)}`);
        return JSON.parse((result.stdout ?? "").trim() || "{}") as RunnerStatus;
      };
      const status = await start();
      if (options.refresh === false || record.config.availability !== "always" || !shouldRefresh(status)) return status;
      // A fresh 24 hours: stop the runner cleanly, then the Sandbox, then start both again.
      await runner(sandboxes, record.sandbox, "stop", signal);
      await sandboxes.stop(record.sandbox);
      await stopped(sandboxes, record.sandbox, signal);
      return start();
    },
    /** The agent's recent turns from its Sandbox's activity log, newest first; undefined while its Sandbox sleeps. */
    async activity(pubkey: string, signal?: AbortSignal): Promise<ActivityTurn[] | undefined> {
      const record = read(pubkey);
      if (!record) return [];
      const { sandboxes } = await sandboxOf(service, record, signal);
      const sandbox = await sandboxes.get(record.sandbox, signal).catch(() => undefined);
      if (sandbox?.status?.state !== "SANDBOX_STATE_RUNNING") return undefined;
      const result = await sandboxes.bash(record.sandbox, `tail -n 1500 ${shellQuote(`${AGENT_DIR}/activity.jsonl`)} 2>/dev/null; true`, { timeoutSeconds: 30, ...(signal && { signal }) });
      const lines = (result.stdout ?? "").split("\n").flatMap((line): ActivityLine[] => {
        try {
          return line.trim() ? [JSON.parse(line) as ActivityLine] : [];
        } catch {
          return [];
        }
      });
      return turnsFromLines(lines).slice(0, 25);
    },
    async status(pubkey: string, signal?: AbortSignal) {
      const record = read(pubkey);
      if (!record) return undefined;
      const { sandboxes } = await sandboxOf(service, record, signal);
      const sandbox = await sandboxes.get(record.sandbox, signal).catch(() => undefined);
      const state = sandbox?.status?.state ?? "missing";
      if (state !== "SANDBOX_STATE_RUNNING") return { record, state, runner: undefined };
      const runnerStatus = JSON.parse(await runner(sandboxes, record.sandbox, "status", signal).catch(() => "{}")) as RunnerStatus;
      return { record, state, runner: runnerStatus };
    },
  };
}

/**
 * While this Buzz is open it looks after its hosted agents every few minutes
 * (`wake`): a stopped Sandbox starts again, a sleeping agent stays awake, and
 * an always-on agent gets a fresh 24 hours at a quiet moment. This is the
 * only thing that restarts a stopped agent; nothing runs on a schedule in
 * Databricks.
 */
export function tendAgents(provider: HostedProvider): () => void {
  const busy = new Set<string>();
  const beat = () => {
    for (const record of provider.records()) {
      const pubkey = record.pubkey!;
      if (!record.community || busy.has(pubkey)) continue;
      busy.add(pubkey);
      void provider
        .wake(pubkey)
        .catch(() => {})
        .finally(() => busy.delete(pubkey));
    }
  };
  const first = setTimeout(beat, 30_000);
  const timer = setInterval(beat, TEND_EVERY_MS);
  return () => {
    clearTimeout(first);
    clearInterval(timer);
  };
}

// ── Form ──

type FormProps = { config: HostedConfig; onChange(config: HostedConfig): void; disabled?: boolean };

// Icons are components, made into elements when the form renders: React is bound only once the plugin starts.
const KIND_CHOICES: readonly { id: HostedKind; label: string; short: string; Icon: (props: { size?: number }) => React.ReactNode; detail: string }[] = [
  { id: "genie", label: "Genie", short: "Genie One or one of your Genie agents", Icon: GenieKindIcon, detail: "Answers data questions with Genie One, or with one of your Genie agents, as charts and tables." },
  { id: "sandbox", label: "Sandbox agent", short: "Claude Code, Codex or Pi in its own Sandbox", Icon: SandboxKindIcon, detail: "Claude Code, Codex or Pi, working in its own Databricks Sandbox with the Databricks CLI signed in as you." },
  {
    id: "omnigent",
    label: "Omnigent agent",
    short: "An Omnigent agent, in Omnigent sessions",
    Icon: OmnigentKindIcon,
    detail:
      "An Omnigent agent (Claude Code, Codex, Pi, Polly…) on a Sandbox that Omnigent runs. Each conversation is an Omnigent session in this workspace, which you can open and continue in Omnigent.",
  },
];

const AVAILABILITY_HINT: Record<Availability, string> = {
  always: `Replies within seconds, with Buzz open or closed. Databricks stops a Sandbox ${SANDBOX_DAY_HOURS} hours after it starts, so with Buzz closed it keeps answering for ${SANDBOX_DAY_HOURS - REFRESH_AFTER_HOURS} to ${SANDBOX_DAY_HOURS} hours. Your Buzz restarts it whenever it's open, and it then answers anything it missed.`,
  sleep: "Runs while your Buzz is open and finishes any work after you close it, then sleeps about 10 minutes later. Opening Buzz wakes it, and it answers anything it missed. Costs less than Always on.",
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

/** One of the workspace's Omnigent agents that run in its Sandboxes, or why there are none. */
function OmnigentField(props: { service: DatabricksService; value?: { agent: string; label: string }; onChange(value: { agent: string; label: string }): void; disabled?: boolean }) {
  const status = useConnection(props.service).status;
  const found = useAsync(async () => {
    const omnigent = new Omnigent(await props.service.ready(), workspaceIdOf(props.service));
    const check = await omnigent.check();
    return check.ok ? { agents: await omnigent.agents(), url: omnigent.webUrl() } : { reason: check.reason };
  }, [props.service, status]);
  const value = props.value ?? { agent: DEFAULT_OMNIGENT_AGENT, label: omnigentAgentLabel(DEFAULT_OMNIGENT_AGENT) };
  const agents = (found.data && "agents" in found.data && found.data.agents) || [];
  const reason = found.error ? describeError(found.error) : found.data && "reason" in found.data ? found.data.reason : undefined;
  return (
    <Stack gap={8}>
      {reason && <Notice tone="warning">{reason}</Notice>}
      <SinglePicker
        label="Omnigent agent"
        hint="Its sessions run on Sandboxes Omnigent makes for you, with models from AI Gateway. It answers with what Omnigent's agent can do there; your Databricks tools and skills aren't added to it."
        value={value.agent}
        valueLabel={value.label}
        placeholder={omnigentAgentLabel(DEFAULT_OMNIGENT_AGENT)}
        searchPlaceholder={`Search ${agents.length} agents`}
        options={agents.map((agent) => ({ id: agent.name, label: agent.label, group: "Omnigent", ...(agent.detail && { detail: agent.detail }) }))}
        loading={found.loading && !found.data ? "Loading Omnigent agents…" : false}
        {...(props.disabled !== undefined && { disabled: props.disabled })}
        onChange={(option) => props.onChange({ agent: option.id, label: option.label })}
      />
    </Stack>
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
        {!props.locked && (
          <Text tone="subtle" size="sm">
            Runs in Databricks, in its own Sandbox, so it can answer with Buzz closed. It can't use Buzz's own tools, and Buzz doesn't show it working.
          </Text>
        )}
        {available.data === false && <Notice tone="warning">Databricks Sandbox isn't on in this workspace, and this agent runs in one. An admin can turn on the Sandbox preview.</Notice>}
        {!props.locked && (
          <SinglePicker
            label="Type"
            hint={kind.detail}
            value={kind.id}
            placeholder="Genie"
            search={false}
            options={KIND_CHOICES.map((choice) => ({ id: choice.id, label: choice.label, group: "", detail: choice.short, icon: <choice.Icon /> }))}
            {...disabled}
            onChange={(option) => onChange(normalizeHosted({ ...config, kind: option.id as HostedKind }))}
          />
        )}
        {!props.locked && (
          <WorkspaceField
            service={props.service}
            {...(config.profile && { profile: config.profile })}
            {...disabled}
            onChange={(profile) => {
              // Genie agents and MCP servers belong to a workspace; keep only Genie One.
              const { profile: _old, genie: _genie, ...rest } = config;
              onChange({ ...rest, ...(profile && { profile }), tools: config.tools.filter((tool) => tool.kind === "genie-one") });
            }}
          />
        )}
        {config.kind === "omnigent" ? (
          <OmnigentField
            service={workspace}
            {...(config.omnigent && { value: config.omnigent })}
            {...disabled}
            onChange={(omnigent) => onChange({ ...config, omnigent })}
          />
        ) : config.kind === "genie" ? (
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
            <ToolsField service={workspace} tools={config.tools} {...disabled} onChange={(tools) => onChange({ ...config, tools })} />
            <SkillsField service={props.service} {...(config.profile && { profile: config.profile })} value={config.skills} {...disabled} onChange={(skills) => onChange({ ...config, skills })} />
          </>
        )}
        <Field label="Availability" hint={AVAILABILITY_HINT[config.availability]}>
          <select className="dbx-select" {...disabled} value={config.availability} onChange={(event) => onChange({ ...config, availability: event.target.value as Availability })}>
            <option value="sleep">Sleep when Buzz is closed</option>
            <option value="always">Always on</option>
          </select>
        </Field>
        <Field label="Conversation" hint="Thread: each thread is its own conversation. Channel: one conversation for the whole channel.">
          <select className="dbx-select" {...disabled} value={config.scope} onChange={(event) => onChange({ ...config, scope: event.target.value as HostedConfig["scope"] })}>
            <option value="thread">One per thread</option>
            <option value="channel">One per channel</option>
          </select>
        </Field>
        {config.kind !== "genie" && (
          <Field label="Instructions" hint="Optional. Who it is, what it should focus on, how to answer.">
            <textarea className="dbx-textarea" rows={5} {...disabled} value={config.instructions} onChange={(event) => onChange({ ...config, instructions: event.target.value })} />
          </Field>
        )}
        {!props.locked && (
          <Text tone="tertiary" size="xs">
            Only your own messages reach it. Its Sandbox belongs to you in Databricks; removing the agent deletes it.
          </Text>
        )}
      </Stack>
    </DbxRoot>
  );
}

// ── Settings tab ──

const STATE_LABEL: Record<string, string> = {
  SANDBOX_STATE_RUNNING: "Running",
  SANDBOX_STATE_STOPPING: "Stopping",
  SANDBOX_STATE_PENDING: "Starting",
  missing: "Its Sandbox is gone",
};
const stateLabel = (state: string | undefined, availability: Availability) =>
  state === "SANDBOX_STATE_STOPPED" ? (availability === "sleep" ? "Asleep" : "Stopped") : (STATE_LABEL[state ?? ""] ?? state ?? "Unknown");

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
  const state = status.data?.state;
  const runnerState = status.data?.runner;
  const dirty = JSON.stringify(draft) !== JSON.stringify(record.config);
  const left = hoursLeft(runnerState?.bootedAt);
  return (
    <DbxRoot style={{ padding: "4px 0 24px" }}>
      <Stack gap={16}>
        <Notice
          tone={state === "SANDBOX_STATE_RUNNING" && runnerState?.running === false ? "warning" : "info"}
          title={status.loading && !status.data ? "Checking…" : stateLabel(state, record.config.availability)}
          action={
            <Button size="sm" disabled={Boolean(busy)} onClick={() => run("wake", () => props.provider.wake(props.pubkey, { refresh: false }))}>
              {busy === "wake" ? <Spinner size={11} /> : null}
              {state === "SANDBOX_STATE_RUNNING" ? "Check again" : "Wake now"}
            </Button>
          }
        >
          {state === "SANDBOX_STATE_RUNNING"
            ? runnerState?.running
              ? `${runnerState.connected ? "Connected to the community" : "Connecting"}${runnerState.active ? ` · working on ${runnerState.active}` : ""}${runnerState.lastError ? ` · last error: ${runnerState.lastError}` : ""}.${
                  record.config.availability === "always" && left !== undefined ? ` Databricks stops its Sandbox in about ${Math.max(1, Math.round(left))} h; your Buzz restarts it sooner, at a quiet moment.` : ""
                }`
              : "The Sandbox is up but the agent isn't running; Wake now starts it."
            : state === "SANDBOX_STATE_STOPPED"
              ? record.config.availability === "sleep"
                ? "It slept while Buzz was closed. Buzz wakes it within a few minutes, or now with Wake now."
                : `Databricks stops a Sandbox ${SANDBOX_DAY_HOURS} hours after it starts. Buzz starts it again within a few minutes, or now with Wake now.`
              : `Sandbox ${record.sandbox}.`}
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

// ── Activity tab ──

const shown = new Map<string, ActivityTurn[]>();

/** The hosted type's Activity tab: the runner's log in the agent's Sandbox, checked every few seconds while open. */
function HostedActivity(props: ActivityTabProps & { provider: HostedProvider }) {
  const { provider } = props;
  const pubkey = props.agent.pubkey;
  const [turns, setTurns] = React.useState<ActivityTurn[]>(() => shown.get(pubkey) ?? []);
  const [state, setState] = React.useState<{ loading: boolean; asleep?: boolean; error?: string }>({ loading: true });
  React.useEffect(() => {
    if (!provider.read(pubkey)) return setState({ loading: false });
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const load = async () => {
      try {
        const found = await provider.activity(pubkey, controller.signal);
        if (controller.signal.aborted) return;
        if (found) {
          shown.set(pubkey, found);
          setTurns(found);
        }
        setState({ loading: false, ...(found === undefined && { asleep: true }) });
      } catch (error) {
        if (!controller.signal.aborted) setState({ loading: false, error: describeError(error) });
      }
      if (!controller.signal.aborted) timer = setTimeout(() => void load(), 4000);
    };
    void load();
    return () => {
      controller.abort();
      if (timer) clearTimeout(timer);
    };
  }, [provider, pubkey]);
  if (!provider.read(pubkey))
    return (
      <DbxRoot style={{ padding: "4px 0 24px" }}>
        <Notice tone="info">This agent was set up from another device; its activity shows there.</Notice>
      </DbxRoot>
    );
  return (
    <ActivityView
      turns={turns}
      loading={state.loading}
      {...(state.error && { error: `Couldn't read its activity: ${state.error}` })}
      {...(props.conversation && { conversation: props.conversation })}
      {...(props.openConversation && { openConversation: props.openConversation })}
      {...(props.initialTranscript && { initialTranscript: props.initialTranscript })}
      note={
        <Text tone="tertiary" size="xs">
          {state.asleep ? "Its Sandbox is asleep, so this is what it last showed. " : ""}Each step it took in its Sandbox and its thinking, for its last 25 turns.
        </Text>
      }
    />
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
    description: "Runs in your Databricks workspace, so it can answer with Buzz closed: Genie, or Claude Code, Codex or Pi in its own Sandbox. No Buzz tools or working indicator.",
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
      {
        id: "activity",
        title: "Activity",
        role: "activity" as const,
        component: (props: ActivityTabProps) => <HostedActivity provider={provider} {...props} />,
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
  return tendAgents(provider);
}
