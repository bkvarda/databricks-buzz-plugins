// Omnigent (Databricks' meta-harness, in Beta) as a hosted agent's engine.
// Each Buzz conversation is an Omnigent session on a Databricks Sandbox that
// Omnigent manages ("managed" host), so its work and history live in the
// workspace and the owner can open and continue it in the browser
// (<workspace>/omnigent/c/<session>). Omnigent starts a stopped session
// Sandbox again when a message arrives, so only the agent's own small Sandbox,
// which listens to Buzz, has to stay up.
//
// The API (<workspace>/api/2.0/omnigent): POST /v1/sessions makes a session
// for an agent, POST /v1/sessions/{id}/events sends a message or an interrupt,
// GET /v1/sessions/{id} has its status and GET /v1/sessions/{id}/items its
// history. Requests about a session carry its host as a routing key; a replica
// that doesn't hold that host answers `wrong_replica`, and the request is sent
// again without the key, as Omnigent's own clients do.
import { apiError, type DatabricksClient } from "@dbx/core/client";
import { describeStep, snippet, type Step } from "./activity";

export const OMNIGENT_API = "/api/2.0/omnigent";
const SLICE_KEY = "X-Databricks-Omnigent-Slice-Key";
const POLL_MS = 2500;
/** A new session's Sandbox usually starts within a minute or two. */
const READY_TIMEOUT_MS = 8 * 60_000;
/** An accepted message that nothing picks up within this long is reported, not waited on forever. */
const START_TIMEOUT_MS = 3 * 60_000;
/** An approval request still open after this long ends the turn with a link to answer it. */
const APPROVAL_GRACE_MS = 30_000;
/** Polls to wait, once the session is idle, for a reply that hasn't been saved yet. */
const SETTLE_POLLS = 3;

/** The agent to use when none was chosen. */
export const DEFAULT_OMNIGENT_AGENT = "claude-native-ui";

/** Built-in Omnigent agents that run in Omnigent's Databricks Sandboxes, in the order offered. */
const KNOWN_AGENTS: Readonly<Record<string, { label: string; detail: string }>> = {
  "claude-native-ui": { label: "Claude Code", detail: "Claude Code, with models from AI Gateway." },
  "codex-native-ui": { label: "Codex", detail: "OpenAI's Codex, with models from AI Gateway." },
  "pi-native-ui": { label: "Pi", detail: "The Pi coding agent, with models from AI Gateway." },
  polly: { label: "Polly", detail: "Hands larger coding tasks to other coding agents, with an independent reviewer checking their work." },
  debby: { label: "Debby", detail: "A brainstorming partner that answers with Claude's and GPT's views side by side." },
};
/** Harnesses Omnigent runs in a Databricks Sandbox with models from AI Gateway; the rest need their own sign-in. */
const SANDBOX_HARNESSES = new Set(["claude-native", "codex-native", "pi-native", "claude-sdk", "codex", "pi"]);

export type OmnigentAgent = Readonly<{ id: string; name: string; harness: string; label: string; detail?: string }>;

export const omnigentAgentLabel = (name: string) => KNOWN_AGENTS[name]?.label ?? name.replace(/-native-ui$/, "").replace(/[-_]+/g, " ");

type Item = Readonly<{
  id: string;
  type: string;
  role?: string;
  content?: readonly Readonly<{ type?: string; text?: string | null }>[] | null;
  summary?: readonly Readonly<{ type?: string; text?: string | null }>[] | null;
  name?: string;
  arguments?: string;
  item?: Readonly<Record<string, unknown>>;
  input?: string | null;
  message?: string;
  title?: string | null;
  source?: string;
}>;

type Snapshot = Readonly<{
  id: string;
  status: string;
  host_id?: string | null;
  runner_online?: boolean | null;
  host_resumable?: boolean;
  sandbox_status?: Readonly<{ stage: string; error?: string | null; details?: string | null }> | null;
  last_task_error?: Readonly<Record<string, unknown>> | null;
  pending_elicitations?: readonly unknown[];
  failed_inputs?: readonly Readonly<Record<string, unknown>>[];
}>;

export type OmnigentTurnInput = Readonly<{
  /** The session to continue; a new one is made when there's none, or it's gone. */
  session?: string;
  /** The Omnigent agent's name, e.g. "claude-native-ui". */
  agent: string;
  /** A new session's title in Omnigent. */
  title: string;
  /** The message to send; `fresh` is true for a new session's first message. */
  text: (fresh: boolean) => string;
  signal: AbortSignal;
  onStep?: (step: Step) => void;
  onThought?: (text: string) => void;
  /** As soon as a new session exists, so a retry continues it. */
  onSession?: (id: string) => void;
}>;

export type OmnigentTurn = Readonly<{
  session: string;
  /** The agent's last message in the turn. */
  text: string;
  /** Whether the session was made for this turn. */
  fresh: boolean;
  /** The turn stopped at an approval request, which the owner answers in Omnigent. */
  waiting: boolean;
}>;

/** A JSON error body from Omnigent: {"detail": "…"} or {"error": {"code", "message"}}. */
function omnigentError(response: Readonly<{ status: number; body: string; headers: Readonly<Record<string, string>> }>): Error {
  let detail: string | undefined;
  try {
    const parsed = JSON.parse(response.body) as { detail?: unknown };
    if (typeof parsed.detail === "string") detail = parsed.detail;
  } catch {}
  const error = apiError(response);
  if (detail) error.message = detail;
  return error;
}

const textOf = (blocks: Item["content"]) =>
  (blocks ?? [])
    .map((block) => (typeof block.text === "string" ? block.text : ""))
    .filter((text) => text.trim())
    .join("\n\n");

/** What an Omnigent tool call looks like as a step: its tool, and what it's working on. */
export function omnigentStep(name: string, args: Readonly<Record<string, unknown>> = {}): Step {
  const pick = (...keys: string[]) => {
    for (const key of keys) {
      const value = args[key];
      if (typeof value === "string" && value.trim()) return value;
    }
    return undefined;
  };
  const target = pick("command", "file_path", "path", "pattern", "query", "url", "title", "description", "prompt");
  const own: Record<string, string> = {
    sys_os_shell: "Bash",
    shell: "Bash",
    exec_command: "Bash",
    sys_session_send: "Handing off to another agent",
    sys_read_inbox: "Checking on other agents",
    browser_navigate: "Opening a web page",
  };
  return describeStep(own[name] ?? name, target);
}

function stepOf(item: Item): Step | undefined {
  if (item.type === "function_call" && item.name) {
    let args: Record<string, unknown> = {};
    try {
      args = item.arguments ? (JSON.parse(item.arguments) as Record<string, unknown>) : {};
    } catch {}
    return omnigentStep(item.name, args);
  }
  if (item.type === "native_tool" && item.item) {
    const native = item.item;
    const name = [native.name, native.tool_name, native.tool, native.type].find((value): value is string => typeof value === "string" && Boolean(value));
    const input = (native.input ?? native.arguments ?? native.args) as unknown;
    const args = typeof input === "object" && input ? (input as Record<string, unknown>) : typeof input === "string" ? { command: input } : {};
    return name ? omnigentStep(name, args) : undefined;
  }
  if (item.type === "terminal_command" && item.input) return describeStep("Bash", item.input);
  return undefined;
}

const sleep = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    if (signal.aborted) return reject(signal.reason);
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", stop);
      resolve();
    }, ms);
    const stop = () => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    signal.addEventListener("abort", stop, { once: true });
  });

export class Omnigent {
  /** Each session's host, for routing requests about it. */
  private readonly hosts = new Map<string, string>();

  constructor(
    private readonly client: DatabricksClient,
    private readonly workspaceId?: string,
  ) {}

  /** The session in the workspace's Omnigent, or Omnigent itself. */
  webUrl(session?: string): string {
    const url = new URL(`${this.client.host}/omnigent${session ? `/c/${encodeURIComponent(session)}` : ""}`);
    if (this.workspaceId) url.searchParams.set("o", this.workspaceId);
    return url.toString();
  }

  private async call<T>(method: "GET" | "POST" | "PATCH", path: string, options: Readonly<{ body?: unknown; session?: string; signal?: AbortSignal }> = {}): Promise<T> {
    const host = options.session ? this.hosts.get(options.session) : undefined;
    const send = (routed: boolean) =>
      this.client.request(`${OMNIGENT_API}${path}`, {
        method,
        ...(options.body !== undefined && { body: options.body }),
        headers: { ...(this.workspaceId && { "X-Databricks-Org-Id": this.workspaceId }), ...(routed && host && { [SLICE_KEY]: host }) },
        timeoutMs: 60_000,
        ...(options.signal && { signal: options.signal }),
      });
    let response = await send(true);
    if (response.status === 400 && host && /wrong_replica/.test(response.body)) response = await send(false);
    if (response.status < 200 || response.status >= 300) throw omnigentError(response);
    return (response.body.trim() ? JSON.parse(response.body) : {}) as T;
  }

  /** Whether this workspace has Omnigent with Sandbox sessions; the reason when it doesn't. */
  async check(signal?: AbortSignal): Promise<{ ok: true } | { ok: false; reason: string }> {
    try {
      const info = await this.call<{ managed_sandboxes_enabled?: boolean }>("GET", "/v1/info", { ...(signal && { signal }) });
      return info.managed_sandboxes_enabled === false ? { ok: false, reason: "Omnigent is on in this workspace, but not with Databricks Sandbox sessions, which hosted agents use." } : { ok: true };
    } catch (error) {
      const status = (error as { status?: number }).status;
      if (status === 404) return { ok: false, reason: "Omnigent isn't on in this workspace. A workspace admin can turn on the Omnigent preview." };
      if (status === 401 || status === 403) return { ok: false, reason: "Omnigent turned this account away; it may not be enabled for you." };
      return { ok: false, reason: (error as Error).message };
    }
  }

  /** The workspace's Omnigent agents that run in its Sandboxes, best known first. */
  async agents(signal?: AbortSignal): Promise<OmnigentAgent[]> {
    const listed = await this.call<{ data?: { id: string; name: string; harness?: string; description?: string | null }[] }>("GET", "/v1/agents?limit=200", { ...(signal && { signal }) });
    const order = Object.keys(KNOWN_AGENTS);
    return (listed.data ?? [])
      .filter((agent) => SANDBOX_HARNESSES.has(agent.harness ?? ""))
      .map((agent) => {
        const known = KNOWN_AGENTS[agent.name];
        const detail = known?.detail ?? agent.description ?? undefined;
        return { id: agent.id, name: agent.name, harness: agent.harness ?? "", label: omnigentAgentLabel(agent.name), ...(detail && { detail }) };
      })
      .sort((a, b) => (order.indexOf(a.name) + 1 || 99) - (order.indexOf(b.name) + 1 || 99) || a.label.localeCompare(b.label));
  }

  /** Makes a session for `agent` on a Sandbox that Omnigent runs. */
  async create(agent: string, title: string, signal?: AbortSignal): Promise<string> {
    const found = (await this.agents(signal)).find((candidate) => candidate.name === agent);
    if (!found) throw new Error(`This workspace's Omnigent has no agent named ${agent} that runs in a Databricks Sandbox.`);
    const created = await this.call<{ id?: string; session_id?: string }>("POST", "/v1/sessions", { body: { agent_id: found.id, host_type: "managed", title: title.slice(0, 120) }, ...(signal && { signal }) });
    const id = created.id ?? created.session_id;
    if (!id) throw new Error("Omnigent didn't return the new session.");
    return id;
  }

  async session(id: string, signal?: AbortSignal): Promise<Snapshot> {
    const snapshot = await this.call<Snapshot>("GET", `/v1/sessions/${encodeURIComponent(id)}`, { session: id, ...(signal && { signal }) });
    if (snapshot.host_id) this.hosts.set(id, snapshot.host_id);
    return snapshot;
  }

  /** Sends a message; resolves with its item's ID once Omnigent has accepted it. */
  async send(id: string, text: string, signal?: AbortSignal): Promise<string | undefined> {
    const accepted = await this.call<{ item_id?: string }>("POST", `/v1/sessions/${encodeURIComponent(id)}/events`, {
      session: id,
      body: { type: "message", data: { role: "user", content: [{ type: "input_text", text }] } },
      ...(signal && { signal }),
    });
    return accepted.item_id;
  }

  /** Asks the session to stop its current work. */
  async interrupt(id: string, signal?: AbortSignal): Promise<void> {
    await this.call("POST", `/v1/sessions/${encodeURIComponent(id)}/events`, { session: id, body: { type: "interrupt", data: {} }, ...(signal && { signal }) });
  }

  /** The session's items after `after` (all of them without it), oldest first. */
  async items(id: string, after: string | undefined, signal?: AbortSignal): Promise<Item[]> {
    const found: Item[] = [];
    let cursor = after;
    for (let page = 0; page < 20; page++) {
      const query = new URLSearchParams({ limit: "100", order: "asc", ...(cursor && { after: cursor }) });
      const list = await this.call<{ data?: Item[]; has_more?: boolean; last_id?: string | null }>("GET", `/v1/sessions/${encodeURIComponent(id)}/items?${query}`, { session: id, ...(signal && { signal }) });
      found.push(...(list.data ?? []));
      if (!list.has_more || !list.last_id) break;
      cursor = list.last_id;
    }
    return found;
  }

  /** The session's newest item's ID. */
  private async newest(id: string, signal?: AbortSignal): Promise<string | undefined> {
    const list = await this.call<{ data?: Item[] }>("GET", `/v1/sessions/${encodeURIComponent(id)}/items?limit=1&order=desc`, { session: id, ...(signal && { signal }) });
    return list.data?.[0]?.id;
  }

  /** Waits for a session's Sandbox: a new one has to start, and a stopped one Omnigent starts again on the next message. */
  private async ready(id: string, fresh: boolean, signal: AbortSignal, onStep?: (step: Step) => void): Promise<void> {
    const deadline = Date.now() + READY_TIMEOUT_MS;
    let stage = "";
    for (;;) {
      const snapshot = await this.session(id, signal);
      const launch = snapshot.sandbox_status;
      if (launch?.stage === "failed" || snapshot.status === "failed") throw new Error(`Omnigent couldn't start the session's Sandbox${launch?.error ? `: ${launch.error}` : "."}`);
      const launching = launch && launch.stage !== "ready";
      if (!launching && (snapshot.runner_online === true || (!fresh && snapshot.host_resumable !== false))) return;
      if (launch && launch.stage !== stage) {
        stage = launch.stage;
        onStep?.({ tool: "Starting its Omnigent Sandbox", target: launch.stage });
      }
      if (Date.now() > deadline) throw new Error("Omnigent's Sandbox for this session didn't start in time.");
      await sleep(POLL_MS, signal);
    }
  }

  /**
   * One turn: sends the message (making the session first when needed),
   * follows the agent's work as steps and thoughts, and resolves with its last
   * message once the session is idle again. Stop (the signal) interrupts the
   * session's work.
   */
  async turn(input: OmnigentTurnInput): Promise<OmnigentTurn> {
    const { signal, onStep, onThought } = input;
    let id = input.session;
    let fresh = false;
    if (id) {
      try {
        await this.session(id, signal);
      } catch (error) {
        if ((error as { status?: number }).status !== 404) throw error;
        id = undefined;
      }
    }
    if (!id) {
      onStep?.({ tool: "Starting an Omnigent session", target: omnigentAgentLabel(input.agent) });
      id = await this.create(input.agent, input.title, signal);
      fresh = true;
      input.onSession?.(id);
    }
    await this.ready(id, fresh, signal, onStep);
    // Where this turn's items start, in case Omnigent doesn't say which item the message became.
    const before = fresh ? undefined : await this.newest(id, signal);
    const sent = await this.send(id, input.text(fresh), signal);
    const session = id;
    try {
      return await this.follow(session, sent ?? before, fresh, signal, onStep, onThought);
    } catch (error) {
      if (signal.aborted) await this.interrupt(session).catch(() => {});
      throw error;
    }
  }

  private async follow(id: string, after: string | undefined, fresh: boolean, signal: AbortSignal, onStep?: (step: Step) => void, onThought?: (text: string) => void): Promise<OmnigentTurn> {
    let cursor = after;
    let started = false;
    let reply = "";
    let failure: string | undefined;
    let settle = 0;
    let approvalSince: number | undefined;
    const sentAt = Date.now();
    for (;;) {
      await sleep(POLL_MS, signal);
      const snapshot = await this.session(id, signal);
      const items = await this.items(id, cursor, signal);
      for (const item of items) {
        cursor = item.id;
        if (item.type === "message" && item.role === "user") continue;
        started = true;
        if (item.type === "message" && item.role === "assistant") {
          const text = textOf(item.content);
          if (!text) continue;
          // An earlier message in the turn was progress, not the answer.
          if (reply) onThought?.(reply);
          reply = text;
          continue;
        }
        if (item.type === "reasoning") {
          const text = textOf(item.summary) || textOf(item.content);
          if (text) onThought?.(text);
          continue;
        }
        if (item.type === "error") {
          failure = [item.title, item.message].filter(Boolean).join(": ") || "Omnigent reported an error.";
          continue;
        }
        const step = stepOf(item);
        if (step) onStep?.(step);
      }
      const failedInput = after ? snapshot.failed_inputs?.find((input) => input.id === after || input.item_id === after) : undefined;
      if (failedInput) throw new Error(`Omnigent couldn't take the message${typeof failedInput.error === "string" ? `: ${failedInput.error}` : "."}`);
      if (snapshot.status === "failed") throw new Error(failure ?? errorText(snapshot.last_task_error) ?? "The Omnigent session failed.");
      if (snapshot.status === "running") {
        started = true;
        settle = 0;
      }
      if (snapshot.pending_elicitations?.length) {
        approvalSince ??= Date.now();
        if (Date.now() - approvalSince > APPROVAL_GRACE_MS) {
          const note = `It's waiting for your approval in Omnigent before it goes on: [open the session](${this.webUrl(id)}).`;
          return { session: id, text: reply ? `${reply}\n\n${note}` : note, fresh, waiting: true };
        }
        continue;
      }
      approvalSince = undefined;
      if (snapshot.status !== "idle") continue;
      if (!started) {
        if (Date.now() - sentAt > START_TIMEOUT_MS) throw new Error("Omnigent accepted the message but didn't start working on it.");
        continue;
      }
      // Saved history can trail the status: give the reply a moment to land.
      if (reply || ++settle >= SETTLE_POLLS) {
        if (!reply && failure) throw new Error(failure);
        return { session: id, text: reply || "_It finished without a reply._", fresh, waiting: false };
      }
    }
  }
}

function errorText(error: Snapshot["last_task_error"]): string | undefined {
  if (!error) return undefined;
  const message = error.message ?? error.detail ?? error.error;
  return typeof message === "string" && message ? snippet(message, 400) : undefined;
}
