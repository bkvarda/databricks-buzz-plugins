// A hosted agent's Omnigent turns against a fake Omnigent server: a new
// session on a Sandbox Omnigent runs (with Buzz's instructions in its first
// message), continuing one, one that's gone, replica routing, failures, an
// approval nobody can answer unattended, and Stop.
import { afterEach, describe, expect, it, vi } from "vitest";
import type { DatabricksClient } from "@dbx/core/client";
import { normalizeHosted, runnerConfigOf, summarizeHosted } from "../plugins/agents/src/hosted";
import { Omnigent, omnigentStep } from "../plugins/agents/src/omnigent";
import type { Step } from "../plugins/agents/src/activity";

type Item = Record<string, unknown> & { id: string; type: string };
/** What the session looks like at one poll; the last one repeats. */
type Phase = Readonly<{ status?: string; runner_online?: boolean; sandbox_status?: unknown; pending_elicitations?: unknown[]; last_task_error?: unknown; add?: (Record<string, unknown> & { type: string })[] }>;
type Call = Readonly<{ method: string; path: string; body?: any; headers: Record<string, string> }>;

const AGENTS = [
  { id: "a-grok", name: "grok", harness: "grok" },
  { id: "a-polly", name: "polly", harness: "claude-sdk", description: "orchestrator" },
  { id: "a-claude", name: "claude-native-ui", harness: "claude-native" },
  { id: "a-codex", name: "codex-native-ui", harness: "codex-native" },
];

/** `launch`: the session before the message is sent (default: ready); `phases`: after it. */
function server(options: Readonly<{ launch?: Phase[]; phases: Phase[]; existing?: Item[]; gone?: boolean; wrongReplicaOnce?: boolean; info?: { status: number; body: unknown } }>) {
  const calls: Call[] = [];
  const items: Item[] = [...(options.existing ?? [])];
  let next = items.length;
  const launch = [...(options.launch ?? [{ status: "idle", runner_online: true }])];
  const phases = [...options.phases];
  let sent = false;
  let wrongReplica = options.wrongReplicaOnce ?? false;
  const reply = (status: number, body: unknown) => ({ status, headers: {}, body: JSON.stringify(body) });
  const client = {
    host: "https://w.example",
    request: async (path: string, init: { method?: string; body?: any; headers?: Record<string, string> }) => {
      const url = new URL(path, "https://w.example");
      const route = url.pathname.replace("/api/2.0/omnigent", "");
      const method = init.method ?? "GET";
      const headers = init.headers ?? {};
      calls.push({ method, path: route + url.search, ...(init.body !== undefined && { body: init.body }), headers });
      if (wrongReplica && headers["X-Databricks-Omnigent-Slice-Key"]) {
        wrongReplica = false;
        return reply(400, { error: { code: "wrong_replica", message: "Request reached the wrong replica" } });
      }
      if (route === "/v1/info") return options.info ? reply(options.info.status, options.info.body) : reply(200, { managed_sandboxes_enabled: true });
      if (route === "/v1/agents") return reply(200, { data: AGENTS });
      if (route === "/v1/sessions" && method === "POST") return reply(200, { id: "s-new", status: "idle" });
      const session = /^\/v1\/sessions\/([^/]+)(\/.*)?$/.exec(route);
      if (!session) return reply(404, { detail: "Not Found" });
      if (options.gone && session[1] === "s-old") return reply(404, { detail: "Session not found" });
      if (session[2] === "/events") {
        if (init.body.type === "interrupt") return reply(202, { queued: false });
        const id = `i${++next}`;
        sent = true;
        items.push({ id, type: "message", role: "user", content: init.body.data.content });
        return reply(202, { queued: true, item_id: id });
      }
      if (session[2] === "/items") {
        if (url.searchParams.get("order") === "desc") return reply(200, { data: items.slice(-1), has_more: false });
        const after = url.searchParams.get("after");
        const from = after ? items.findIndex((item) => item.id === after) + 1 : 0;
        return reply(200, { data: items.slice(from), has_more: false, last_id: items.at(-1)?.id ?? null });
      }
      // A snapshot: the next phase (the last one repeats), whose items land in the history once.
      const list = sent ? phases : launch;
      const repeats = list.length <= 1;
      const current: Phase = (repeats ? list[0] : list.shift()) ?? {};
      for (const add of current.add ?? []) items.push({ id: `i${++next}`, ...add });
      if (repeats && list[0]) list[0] = { ...list[0], add: [] };
      return reply(200, { id: session[1], host_id: "h1", status: current.status ?? "idle", runner_online: current.runner_online ?? true, host_resumable: true, sandbox_status: current.sandbox_status ?? null, pending_elicitations: current.pending_elicitations ?? [], last_task_error: current.last_task_error ?? null, failed_inputs: [] });
    },
  } as unknown as DatabricksClient;
  return { omnigent: new Omnigent(client, "42"), calls, items };
}

const say = (text: string) => ({ type: "message", role: "assistant", content: [{ type: "output_text", text }] });
const run = (name: string, args: unknown) => ({ type: "function_call", name, arguments: JSON.stringify(args), call_id: "c" });

/** Lets fake time run until `promise` settles. */
async function settle<T>(promise: Promise<T>): Promise<{ value?: T; error?: Error }> {
  const outcome = promise.then(
    (value) => ({ value }),
    (error: unknown) => ({ error: error as Error }),
  );
  await vi.runAllTimersAsync();
  return outcome;
}

afterEach(() => vi.useRealTimers());

describe("Omnigent turns", () => {
  it("makes a session on a Sandbox Omnigent runs, and answers with the agent's last message", async () => {
    vi.useFakeTimers();
    const { omnigent, calls } = server({
      launch: [
        { status: "idle", runner_online: false, sandbox_status: { stage: "provisioning" } },
        { status: "idle", runner_online: false, sandbox_status: { stage: "starting" } },
        { status: "idle", runner_online: true },
      ],
      phases: [
        { status: "running", add: [{ type: "reasoning", summary: [{ type: "summary_text", text: "**Checking the OS**" }] }, run("sys_os_shell", { command: "uname -s" })] },
        { status: "running", add: [say("Let me check."), { type: "function_call_output", call_id: "c", output: "Linux" }] },
        { status: "idle", add: [say("BUZZ_OK Linux")] },
      ],
    });
    const steps: Step[] = [];
    const thoughts: string[] = [];
    const sessions: string[] = [];
    const { value } = await settle(
      omnigent.turn({
        agent: "claude-native-ui",
        title: "Buzz · Probe · #general",
        text: (fresh) => (fresh ? "PREAMBLE\n\nQUESTION" : "QUESTION"),
        signal: new AbortController().signal,
        onStep: (step) => steps.push(step),
        onThought: (text) => thoughts.push(text),
        onSession: (id) => sessions.push(id),
      }),
    );
    expect(value).toMatchObject({ session: "s-new", text: "BUZZ_OK Linux", fresh: true, waiting: false });
    expect(sessions).toEqual(["s-new"]);
    const created = calls.find((call) => call.method === "POST" && call.path === "/v1/sessions")!;
    expect(created.body).toEqual({ agent_id: "a-claude", host_type: "managed", title: "Buzz · Probe · #general" });
    const sent = calls.find((call) => call.path.endsWith("/events"))!;
    expect(sent.body).toEqual({ type: "message", data: { role: "user", content: [{ type: "input_text", text: "PREAMBLE\n\nQUESTION" }] } });
    // Session requests are routed to the session's host once it's known, and name the workspace.
    expect(sent.headers).toMatchObject({ "X-Databricks-Omnigent-Slice-Key": "h1", "X-Databricks-Org-Id": "42" });
    expect(steps).toContainEqual({ tool: "Starting its Omnigent Sandbox", target: "provisioning" });
    expect(steps).toContainEqual({ tool: "Bash", target: "uname -s" });
    expect(thoughts).toEqual(["**Checking the OS**", "Let me check."]);
    expect(omnigent.webUrl("s-new")).toBe("https://w.example/omnigent/c/s-new?o=42");
  });

  it("continues a conversation's session with only the new message, and reads only this turn's items", async () => {
    vi.useFakeTimers();
    const { omnigent, calls } = server({
      existing: [{ id: "i1", type: "message", role: "user", content: [] }, { id: "i2", ...say("an old answer") }],
      phases: [{ status: "running", add: [run("Read", { file_path: "notes.md" })] }, { status: "idle", add: [say("the new answer")] }],
    });
    const steps: Step[] = [];
    const { value } = await settle(omnigent.turn({ session: "s-old", agent: "claude-native-ui", title: "t", text: (fresh) => (fresh ? "PREAMBLE" : "FOLLOW-UP"), signal: new AbortController().signal, onStep: (step) => steps.push(step) }));
    expect(value).toMatchObject({ session: "s-old", text: "the new answer", fresh: false });
    expect(calls.some((call) => call.method === "POST" && call.path === "/v1/sessions")).toBe(false);
    expect(calls.find((call) => call.path.endsWith("/events"))!.body.data.content[0].text).toBe("FOLLOW-UP");
    expect(steps).toEqual([{ tool: "Read", target: "notes.md" }]);
  });

  it("starts a new session when the saved one is gone", async () => {
    vi.useFakeTimers();
    const { omnigent } = server({ gone: true, phases: [{ status: "running" }, { status: "idle", add: [say("fresh start")] }] });
    const { value } = await settle(omnigent.turn({ session: "s-old", agent: "codex-native-ui", title: "t", text: () => "hi", signal: new AbortController().signal }));
    expect(value).toMatchObject({ session: "s-new", text: "fresh start", fresh: true });
  });

  it("sends a request again without the host key when it reached the wrong replica", async () => {
    vi.useFakeTimers();
    const { omnigent, calls } = server({ wrongReplicaOnce: true, phases: [{ status: "running" }, { status: "idle", add: [say("ok")] }] });
    const { value } = await settle(omnigent.turn({ session: "s-1", agent: "claude-native-ui", title: "t", text: () => "hi", signal: new AbortController().signal }));
    expect(value?.text).toBe("ok");
    const refused = calls.findIndex((call) => call.headers["X-Databricks-Omnigent-Slice-Key"]);
    expect(calls[refused + 1]!.path).toBe(calls[refused]!.path);
    expect(calls[refused + 1]!.headers["X-Databricks-Omnigent-Slice-Key"]).toBeUndefined();
  });

  it("passes on why a session failed", async () => {
    vi.useFakeTimers();
    const { omnigent } = server({ phases: [{ status: "running" }, { status: "failed", last_task_error: { message: "Model access denied for system.ai.claude-opus-5-5" } }] });
    const { error } = await settle(omnigent.turn({ session: "s-1", agent: "claude-native-ui", title: "t", text: () => "hi", signal: new AbortController().signal }));
    expect(error?.message).toBe("Model access denied for system.ai.claude-opus-5-5");
  });

  it("ends the turn with a link when the agent waits for an approval nobody is there to give", async () => {
    vi.useFakeTimers();
    const { omnigent } = server({ phases: [{ status: "running", add: [say("I need to run a migration.")] }, { status: "running", pending_elicitations: [{ id: "e1" }] }] });
    const { value } = await settle(omnigent.turn({ session: "s-1", agent: "claude-native-ui", title: "t", text: () => "hi", signal: new AbortController().signal }));
    expect(value?.waiting).toBe(true);
    expect(value?.text).toBe("I need to run a migration.\n\nIt's waiting for your approval in Omnigent before it goes on: [open the session](https://w.example/omnigent/c/s-1?o=42).");
  });

  it("interrupts the session's work on Stop", async () => {
    vi.useFakeTimers();
    const { omnigent, calls } = server({ phases: [{ status: "running" }] });
    const controller = new AbortController();
    const pending = omnigent.turn({ session: "s-1", agent: "claude-native-ui", title: "t", text: () => "hi", signal: controller.signal, onStep: () => {} });
    const outcome = pending.then(
      () => "answered",
      (error: Error) => error.name,
    );
    await vi.advanceTimersByTimeAsync(6000);
    controller.abort(new DOMException("Stopped", "AbortError"));
    await vi.advanceTimersByTimeAsync(10);
    expect(await outcome).toBe("AbortError");
    expect(calls.filter((call) => call.path.endsWith("/events")).map((call) => call.body.type)).toEqual(["message", "interrupt"]);
  });
});

describe("Omnigent in a workspace", () => {
  it("offers only agents that run in its Sandboxes, best known first", async () => {
    const { omnigent } = server({ phases: [] });
    expect((await omnigent.agents()).map((agent) => [agent.name, agent.label])).toEqual([
      ["claude-native-ui", "Claude Code"],
      ["codex-native-ui", "Codex"],
      ["polly", "Polly"],
    ]);
  });

  it("says when Omnigent isn't on", async () => {
    const { omnigent } = server({ phases: [], info: { status: 404, body: { detail: "Not Found" } } });
    expect(await omnigent.check()).toEqual({ ok: false, reason: "Omnigent isn't on in this workspace. A workspace admin can turn on the Omnigent preview." });
    expect(await server({ phases: [] }).omnigent.check()).toEqual({ ok: true });
  });

  it("shows Omnigent's tools as steps", () => {
    expect(omnigentStep("sys_os_shell", { command: "ls -la" })).toEqual({ tool: "Bash", target: "ls -la" });
    expect(omnigentStep("sys_session_send", { title: "Fix the tests" })).toEqual({ tool: "Handing off to another agent", target: "Fix the tests" });
  });
});

describe("hosted Omnigent agents", () => {
  it("default to Claude Code and hand the runner the agent", () => {
    const config = normalizeHosted({ kind: "omnigent" });
    expect(config.omnigent).toEqual({ agent: "claude-native-ui", label: "Claude Code" });
    expect(summarizeHosted(config)).toBe("Omnigent · Claude Code · sleeps when Buzz is closed");
    const runner = runnerConfigOf({ sandbox: "sb", name: "O", config: normalizeHosted({ kind: "omnigent", omnigent: { agent: "polly", label: "Polly" }, availability: "always" }), community: "wss://x", owner: "o", authTag: ["auth"], createdAt: 0 });
    expect(runner).toMatchObject({ kind: "omnigent", omnigentAgent: "polly", omnigentLabel: "Polly", permissions: "standard" });
    expect(runner.tools).toBeUndefined();
    // Another kind keeps no Omnigent choice.
    expect(normalizeHosted({ kind: "genie", omnigent: { agent: "polly", label: "Polly" } }).omnigent).toBeUndefined();
  });
});
