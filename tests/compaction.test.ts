// Compaction: Built-in agents fold what falls out of their saved session into
// a summary, and Compact session does it on request; Claude Code and Pi
// compact their own sessions on the agent's Sandbox.
import * as ReactModule from "react";
import { describe, expect, it } from "vitest";
import type { AgentType } from "@buzz/author";
import { bindReact } from "@dbx/core/react";
import type { ChatMessage } from "@dbx/core/api/ai";
import { keepWithinBudget, summarize, summaryRequest, SUMMARY_MAX, transcript, withSummary } from "../plugins/agents/src/compaction";
import { HISTORY_CHARS } from "../plugins/agents/src/loop";
import type { Session } from "../plugins/agents/src/state";
import { splitHistory, trimHistory } from "../plugins/agents/src/loop";
import { compactCommand, compactOutcome, compactRemote } from "../plugins/agents/src/remote";
import { Sessions } from "../plugins/agents/src/state";
import { registerTypes } from "../plugins/agents/src/types";
import { fakeService } from "./fake-workspace";

// The agent type's icon is a React component.
bindReact(ReactModule as never);

const turn = (n: number, size = 10): ChatMessage[] => [
  { role: "user", content: `question ${n} ${"q".repeat(size)}` },
  { role: "assistant", content: null, tool_calls: [{ id: `c${n}`, type: "function", function: { name: "sandbox_exec", arguments: `{"command":"ls ${n}"}` } }] },
  { role: "tool", tool_call_id: `c${n}`, content: `result ${n} ${"r".repeat(size)}` },
  { role: "assistant", content: `answer ${n}` },
];

describe("what falls out of a saved session", () => {
  it("splits at user turns, so each tool result stays with its call", () => {
    const messages = [1, 2, 3, 4].flatMap((n) => turn(n, 400));
    const { kept, dropped } = splitHistory(messages, 2_500);
    expect([...dropped, ...kept]).toEqual(messages);
    expect(kept[0]).toMatchObject({ role: "user" });
    expect(dropped.length).toBeGreaterThan(0);
    expect(trimHistory(messages, 2_500)).toEqual(kept);
    // Within budget, nothing falls off.
    expect(splitHistory(messages).dropped).toEqual([]);
  });

  it("gives the summarizer who said what, with tool calls and results shortened", () => {
    const text = transcript([...turn(1), { role: "tool", tool_call_id: "x", content: "y".repeat(5_000) }]);
    expect(text).toContain("[conversation] question 1");
    expect(text).toContain('[called sandbox_exec] {"command":"ls 1"}');
    expect(text).toContain("[agent] answer 1");
    expect(text).toMatch(/\[tool result\] y{800} … \(4200 more characters\)/);
    // A very long stretch keeps its start and end.
    const long = transcript([1, 2, 3].flatMap((n) => turn(n, 2_000)), 3_000);
    expect(long).toContain("question 1");
    expect(long).toContain("answer 3");
    expect(long).toMatch(/characters left out/);
  });

  it("folds them into the previous summary, and puts the summary in the system prompt", async () => {
    const request = summaryRequest("- Chose Lakebase for the index.", turn(5));
    expect(request[0]).toMatchObject({ role: "system", content: expect.stringMatching(/running summary/) });
    expect(request[1]?.content).toMatch(/<previous_summary>\n- Chose Lakebase for the index.\n<\/previous_summary>/);
    expect(request[1]?.content).toMatch(/merging the previous summary/);
    const seen: (readonly ChatMessage[])[] = [];
    const summary = await summarize(async (messages) => (seen.push(messages), "  - Asked for X; did Y.  "), undefined, turn(1), new AbortController().signal);
    expect(summary).toBe("- Asked for X; did Y.");
    expect(seen[0]?.[1]?.content).not.toMatch(/previous_summary/);
    expect((await summarize(async () => "s".repeat(SUMMARY_MAX + 50), undefined, turn(1), new AbortController().signal)).length).toBeLessThan(SUMMARY_MAX + 40);
    await expect(summarize(async () => "  ", undefined, turn(1), new AbortController().signal)).rejects.toThrow(/empty summary/);
    expect(withSummary("SYSTEM", undefined)).toBe("SYSTEM");
    expect(withSummary("SYSTEM", "- did Y")).toMatch(/^SYSTEM\n\n<earlier_in_this_conversation>\n.*no longer fits.*\n\n- did Y\n<\/earlier_in_this_conversation>$/s);
  });
});

describe("saving a session after a turn", () => {
  const signal = new AbortController().signal;
  // Six turns of about 25,000 characters each: past the 120,000-character budget.
  const history = [1, 2, 3, 4, 5, 6].flatMap((n) => turn(n, 12_500));

  it("summarizes what falls off, keeping everything until the summary is saved", async () => {
    const saves: Session[] = [];
    let summarizing = 0;
    await keepWithinBudget(async (next) => void saves.push(next), { messages: [], summary: "- Earlier.", cursor: "c", updatedAt: 0 }, history, async () => "- Earlier, and turn 1.", signal, () => summarizing++);
    expect(saves).toHaveLength(2);
    expect(saves[0]?.messages).toEqual(history);
    expect(saves[1]).toMatchObject({ summary: "- Earlier, and turn 1.", cursor: "c" });
    expect(saves[1]?.messages.length).toBeLessThan(history.length);
    expect(summarizing).toBe(1);
  });

  it("saves once with nothing to summarize, and keeps it all when the summary fails", async () => {
    const saves: Session[] = [];
    await keepWithinBudget(async (next) => void saves.push(next), { messages: [], updatedAt: 0 }, turn(1), async () => "unused", signal);
    expect(saves).toHaveLength(1);
    saves.length = 0;
    await keepWithinBudget(async (next) => void saves.push(next), { messages: [], summary: "- Kept.", updatedAt: 0 }, history, async () => { throw new Error("gateway down"); }, signal);
    expect(saves).toHaveLength(1);
    expect(saves[0]).toMatchObject({ messages: history, summary: "- Kept." });
    // Well past the budget, the oldest go even without a summary.
    saves.length = 0;
    const huge = Array.from({ length: 12 }, (_, n) => turn(n, 12_500)).flat();
    await keepWithinBudget(async (next) => void saves.push(next), { messages: [], updatedAt: 0 }, huge, async () => { throw new Error("gateway down"); }, signal);
    const last = saves.at(-1)!;
    expect(last.messages.length).toBeLessThan(huge.length);
    expect(last.messages.reduce((n, m) => n + (typeof m.content === "string" ? m.content.length : 0), 0)).toBeLessThan(HISTORY_CHARS * 2);
  });
});

describe("Compact session", () => {
  const setup = (answer: (body: { messages: ChatMessage[]; max_tokens: number }) => string) => {
    const store = new Map<string, string>();
    const storage = { get: (k: string) => store.get(k) ?? null, set: async (k: string, v: string | null) => void (v === null ? store.delete(k) : store.set(k, v)), keys: () => [...store.keys()] };
    let type: AgentType | undefined;
    const agents = { storage, register: (registered: AgentType) => ((type = registered), () => {}) };
    const bodies: { messages: ChatMessage[]; max_tokens: number }[] = [];
    const client = {
      post: async (path: string, body: { messages: ChatMessage[]; max_tokens: number }) => {
        expect(path).toBe("/ai-gateway/mlflow/v1/chat/completions");
        bodies.push(body);
        return { choices: [{ message: { role: "assistant", content: answer(body) } }] };
      },
    };
    registerTypes(agents as never, {} as never, fakeService(client as never).service as never);
    return { type: type!, sessions: new Sessions(storage as never), bodies };
  };
  const agent = (config: Record<string, unknown>) => ({ key: "agent-1", pubkey: "a".repeat(64), name: "RemoteAgent", config });
  const place = { channelId: "chan", root: "root" };

  it("summarizes a Built-in agent's history but its last turns, and shows it compacting meanwhile", async () => {
    let state: string | undefined;
    const { type, sessions, bodies } = setup(() => {
      state = type.sessionControls!.state(agent({ kind: "sandbox", model: "system.ai.claude-opus-5-5" }) as never, place);
      return "- Built the store; tests next.";
    });
    const history = [1, 2, 3, 4, 5, 6].flatMap((n) => turn(n, 3_000));
    await sessions.set("agent-1", "chan/root", { messages: history, summary: "- Started the plan.", updatedAt: 0 });
    await type.sessionControls!.run(agent({ kind: "sandbox", model: "system.ai.claude-opus-5-5" }) as never, place, "compact");
    expect(state).toBe("compacting");
    expect(type.sessionControls!.state(agent({ kind: "sandbox" }) as never, place)).toBe("idle");
    expect(bodies[0]).toMatchObject({ model: "system.ai.claude-opus-5-5", max_tokens: 2_000 });
    expect(bodies[0]?.messages[1]?.content).toMatch(/- Started the plan\.[\s\S]*question 1/);
    const saved = sessions.get("agent-1", "chan/root");
    expect(saved.summary).toBe("- Built the store; tests next.");
    expect(saved.messages.length).toBeLessThan(history.length);
    expect(saved.messages[0]).toMatchObject({ role: "user" });
    expect(saved.messages.at(-1)).toEqual({ role: "assistant", content: "answer 6" });
    // Short enough already: nothing to do, and no model call.
    await sessions.set("agent-1", "chan/root", { messages: turn(1), updatedAt: 0 });
    await type.sessionControls!.run(agent({ kind: "sandbox" }) as never, place, "compact");
    expect(bodies).toHaveLength(1);
  });

  it("leaves the session as it was when the summary fails, and says so", async () => {
    const { type, sessions } = setup(() => "");
    const history = [1, 2, 3, 4, 5, 6].flatMap((n) => turn(n, 3_000));
    await sessions.set("agent-1", "chan/root", { messages: history, updatedAt: 0 });
    await expect(type.sessionControls!.run(agent({ kind: "sandbox" }) as never, place, "compact")).rejects.toThrow(/empty summary/);
    expect(sessions.get("agent-1", "chan/root").messages).toEqual(history);
  });

  it("says Genie One manages its own context", async () => {
    const { type } = setup(() => "unused");
    await expect(type.sessionControls!.run(agent({ kind: "genie-one" }) as never, place, "compact")).rejects.toThrow(/Genie One keeps the conversation/);
  });
});

describe("compacting a harness's own session", () => {
  it("runs Claude Code's /compact, and Pi's RPC compact, in the work folder", () => {
    expect(compactCommand("claude", "system.ai.claude-sonnet-5-5", "s-1")).toBe(
      "cd '/home/sandbox-agent/work' || exit 1; printf '/compact' | claude -p --model 'system.ai.claude-sonnet-5-5' --output-format stream-json --verbose --resume 's-1' 2>/dev/null",
    );
    const pi = compactCommand("pi", "system.ai.claude-sonnet-5-5", "s-2");
    expect(pi).toMatch(/^cd '\/home\/sandbox-agent\/work' \|\| exit 1\n/);
    expect(pi).toContain(`pi --mode rpc --model 'system.ai.claude-sonnet-5-5' --session-id 's-2' < "$d/in"`);
    expect(pi).toContain(`printf '%s\\n' '{"id":"buzz-compact","type":"compact"}' >&3`);
  });

  it("reads what each says back", () => {
    const lines = (...events: unknown[]) => events.map((event) => JSON.stringify(event)).join("\n");
    expect(compactOutcome("claude", lines({ type: "system", subtype: "init" }, { type: "system", subtype: "compact_boundary", compact_metadata: { trigger: "manual", pre_tokens: 30347 } }, { type: "result", subtype: "success", result: "" }))).toEqual({ ok: true, compacted: true });
    expect(compactOutcome("claude", lines({ type: "result", subtype: "error_during_execution", is_error: true, result: "No conversation found with session ID: s-1" }))).toEqual({ ok: false, error: "No conversation found with session ID: s-1" });
    expect(compactOutcome("claude", "")).toEqual({ ok: false, error: "Claude Code didn't answer." });
    expect(compactOutcome("pi", lines({ id: "buzz-compact", type: "response", command: "compact", success: true }))).toEqual({ ok: true, compacted: true });
    expect(compactOutcome("pi", lines({ id: "buzz-compact", type: "response", command: "compact", success: false, error: "Nothing to compact (session too small)" }))).toEqual({ ok: true, compacted: false });
    expect(compactOutcome("pi", lines({ type: "response", success: false, error: "No API key" }))).toEqual({ ok: false, error: "No API key" });
  });

  it("explains Codex compacts itself, and reports a failure", async () => {
    const signal = new AbortController().signal;
    const sandboxes = (stdout: string) => ({ bash: async () => ({ stdout, exit_code: 0 }) });
    await expect(compactRemote({ sandboxes: sandboxes("") as never, sandbox: "s", harness: "codex", model: "m", session: "t", signal })).rejects.toThrow(/Codex compacts its own context/);
    await expect(compactRemote({ sandboxes: sandboxes(JSON.stringify({ type: "response", success: true })) as never, sandbox: "s", harness: "pi", model: "m", session: "t", signal })).resolves.toEqual({ compacted: true });
    await expect(compactRemote({ sandboxes: sandboxes("") as never, sandbox: "s", harness: "claude", model: "m", session: "t", signal })).rejects.toThrow(/Claude Code couldn't compact: Claude Code didn't answer/);
  });
});
