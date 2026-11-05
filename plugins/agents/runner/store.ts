// The runner's files in the Sandbox's persistent home (~/.buzz/agent):
//   key.json       the agent's secret key (0600); it never leaves the Sandbox
//   config.json    what the plugin activated it with
//   state.json     harness sessions per conversation, and the last event seen
//   turns/<key>    the PID of a conversation's running harness, for Stop
//   runner.pid / runner.log / status.json
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Permissions, RemoteHarness } from "../src/remote";

export const AGENT_DIR = process.env.BUZZ_AGENT_DIR ?? join(homedir(), ".buzz", "agent");
export const paths = {
  key: join(AGENT_DIR, "key.json"),
  config: join(AGENT_DIR, "config.json"),
  state: join(AGENT_DIR, "state.json"),
  turns: join(AGENT_DIR, "turns"),
  pid: join(AGENT_DIR, "runner.pid"),
  log: join(AGENT_DIR, "runner.log"),
  status: join(AGENT_DIR, "status.json"),
  /** Touched by the owner's Buzz while it's open, so a sleeping agent stays awake. */
  awake: join(AGENT_DIR, "awake"),
  runs: join(AGENT_DIR, "runs"),
};

export type Availability = "always" | "sleep";

export type RunnerConfig = Readonly<{
  /** The community relay, `wss://…`. */
  relay: string;
  /** The owner's pubkey (hex): only their mentions, or ones they attested, are answered. */
  owner: string;
  /** The owner's NIP-OA attestation tag, attached to everything the agent signs. */
  authTag: string[];
  name: string;
  picture?: string;
  /** "genie": Genie One or a Genie agent answers; "sandbox": a coding harness does. */
  kind: "genie" | "sandbox";
  /** A Genie agent (space) to ask instead of Genie One. */
  genieSpace?: string;
  harness: RemoteHarness;
  model: string;
  permissions: Permissions;
  instructions: string;
  scope: "thread" | "channel";
  availability: Availability;
  /** Minutes without work before a sleeping agent stops its Sandbox. */
  idleMinutes: number;
  /** This Sandbox's ID, for stopping itself. */
  sandbox: string;
  workspaceHost?: string;
}>;

export type RunnerState = {
  /** Harness session per conversation key. */
  sessions: Record<string, { harness: string; id: string; at: number }>;
  /** created_at (seconds) of the newest mention handled, to catch up after sleeping. */
  since: number;
  /** IDs of events already answered, newest last. */
  handled: string[];
  /** The name and picture last published as the profile. */
  profile?: string;
};

export function ensureDirs() {
  for (const dir of [AGENT_DIR, paths.turns, paths.runs]) mkdirSync(dir, { recursive: true, mode: 0o700 });
}

function readJson<T>(path: string, fallback: T): T {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as T;
  } catch {
    return fallback;
  }
}

/** Writes through a temp file, so a crash never leaves half a file. */
export function writeJson(path: string, value: unknown, mode = 0o600) {
  const temp = `${path}.tmp`;
  writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, { mode });
  renameSync(temp, path);
  chmodSync(path, mode);
}

export const readConfig = () => readJson<RunnerConfig | undefined>(paths.config, undefined);
export const readState = (): RunnerState => ({ sessions: {}, since: 0, handled: [], ...readJson<Partial<RunnerState>>(paths.state, {}) });
export const writeState = (state: RunnerState) => writeJson(paths.state, { ...state, handled: state.handled.slice(-500) });

export function readSecretKey(): Uint8Array | undefined {
  const saved = readJson<{ secret?: string } | undefined>(paths.key, undefined);
  return saved?.secret && /^[0-9a-f]{64}$/.test(saved.secret) ? Uint8Array.from(Buffer.from(saved.secret, "hex")) : undefined;
}

export function saveSecretKey(secret: Uint8Array) {
  if (existsSync(paths.key)) throw new Error("This Sandbox already has an agent key.");
  writeJson(paths.key, { secret: Buffer.from(secret).toString("hex") });
}

export const turnPidPath = (conversation: string) => join(paths.turns, Buffer.from(conversation).toString("base64url"));
export const clearTurn = (conversation: string) => rmSync(turnPidPath(conversation), { force: true });
