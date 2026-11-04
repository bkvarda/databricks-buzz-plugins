import { describe, expect, it } from "vitest";
import type { ChatCompletion, ChatMessage } from "@dbx/core/api/ai";
import { runLoop, trimHistory } from "../plugins/agents/src/loop";
import { plainText } from "../plugins/agents/src/state";
import { normalizeDatabricks } from "../plugins/agents/src/types";

function fakeBuzz(log: unknown[]) {
  return async (message: unknown) => {
    const m = message as { id: number; method: string; params?: { name: string; arguments: Record<string, unknown> } };
    log.push(m.method === "tools/call" ? m.params : m.method);
    if (m.method === "tools/list")
      return { jsonrpc: "2.0", id: m.id, result: { tools: [
        { name: "send", description: "Post a message", inputSchema: { type: "object", properties: { text: { type: "string" }, final: { type: "boolean" } } } },
        { name: "databricks_genie_ask", description: "Ask Genie", inputSchema: { type: "object", properties: { question: { type: "string" } } } },
        { name: "bad name!", description: "skipped" },
      ] } };
    if (m.params?.name === "databricks_genie_ask") return { jsonrpc: "2.0", id: m.id, result: { content: [{ type: "text", text: "Revenue was 42" }] } };
    if (m.params?.name === "send") return { jsonrpc: "2.0", id: m.id, result: { content: [{ type: "text", text: "sent" }] } };
    return { jsonrpc: "2.0", id: m.id, result: { content: [{ type: "text", text: "nope" }], isError: true } };
  };
}

const reply = (message: ChatCompletion["choices"][number]["message"]): ChatCompletion => ({ choices: [{ message }], usage: { prompt_tokens: 10, completion_tokens: 5 } });

describe("agent loop", () => {
  it("calls Buzz and local tools, then posts through send with final", async () => {
    const log: unknown[] = [];
    const seen: (readonly ChatMessage[])[] = [];
    const script = [
      reply({ role: "assistant", content: null, tool_calls: [
        { id: "1", type: "function", function: { name: "databricks_genie_ask", arguments: '{"question":"revenue?"}' } },
        { id: "2", type: "function", function: { name: "sandbox_exec", arguments: '{"command":"echo hi"}' } },
      ] }),
      reply({ role: "assistant", content: null, tool_calls: [{ id: "3", type: "function", function: { name: "send", arguments: '{"text":"Revenue was 42","final":true}' } }] }),
      reply({ role: "assistant", content: "should not be reached" }),
    ];
    const result = await runLoop({
      model: "m", system: "sys", history: [], prompt: "What was revenue?",
      buzz: fakeBuzz(log),
      local: [{ name: "sandbox_exec", description: "run", parameters: { type: "object" }, run: async (args) => `exit_code: 0\nstdout:\n${String(args.command).replace("echo ", "")}` }],
      chat: async (request) => {
        seen.push(request.messages);
        expect(request.tools.map((t) => t.function.name)).toEqual(["send", "databricks_genie_ask", "sandbox_exec"]);
        return script.shift()!;
      },
      signal: new AbortController().signal,
    });
    expect(result).toMatchObject({ posted: true, final: true, steps: 2, usage: { prompt: 20, completion: 10 } });
    expect(log).toContainEqual({ name: "databricks_genie_ask", arguments: { question: "revenue?" } });
    const toolMessages = result.messages.filter((m) => m.role === "tool");
    expect(toolMessages.map((m) => m.content)).toEqual(["Revenue was 42", "exit_code: 0\nstdout:\nhi", "sent"]);
    expect(seen[1]?.[0]).toEqual({ role: "system", content: "sys" });
  });

  it("returns plain text when the model answers without tools, and surfaces tool errors to the model", async () => {
    const script = [
      reply({ role: "assistant", content: null, tool_calls: [{ id: "1", type: "function", function: { name: "missing", arguments: "{bad json" } }] }),
      reply({ role: "assistant", content: "Here is the answer." }),
    ];
    const result = await runLoop({
      model: "m", system: "s", history: [], prompt: "hi", buzz: fakeBuzz([]),
      chat: async () => script.shift()!, signal: new AbortController().signal,
    });
    expect(result.posted).toBe(false);
    expect(result.text).toBe("Here is the answer.");
    expect(result.messages.find((m) => m.role === "tool")?.content).toMatch(/no tool named missing/);
  });

  it("stops at the step limit and honors abort", async () => {
    const looping = reply({ role: "assistant", content: null, tool_calls: [{ id: "x", type: "function", function: { name: "databricks_genie_ask", arguments: "{}" } }] });
    const result = await runLoop({ model: "m", system: "s", history: [], prompt: "p", buzz: fakeBuzz([]), chat: async () => looping, signal: new AbortController().signal, maxSteps: 3 });
    expect(result.steps).toBe(3);
    const controller = new AbortController();
    controller.abort();
    await expect(runLoop({ model: "m", system: "s", history: [], prompt: "p", chat: async () => looping, signal: controller.signal })).rejects.toThrow();
  });

  it("trims history at user turns", () => {
    const messages: ChatMessage[] = [];
    for (let i = 0; i < 10; i++) messages.push({ role: "user", content: `q${i} ${"x".repeat(100)}` }, { role: "assistant", content: `a${i}` });
    const trimmed = trimHistory(messages, 1200);
    expect(trimmed[0]?.role).toBe("user");
    expect(trimmed.length).toBeLessThan(messages.length);
    expect(trimmed.at(-1)).toEqual({ role: "assistant", content: "a9" });
  });
});

describe("agent helpers", () => {
  it("strips mentions from questions", () => {
    expect(plainText("[@Sales Genie](nostr:npub1abc0def) what were sales last week?")).toBe("what were sales last week?");
    expect(plainText("nostr:npub1qqqq  hello")).toBe("hello");
  });
  it("normalizes config", () => {
    expect(normalizeDatabricks({ scope: "channel", sandbox: true })).toMatchObject({ scope: "channel", sandbox: true, instructions: "" });
    expect(normalizeDatabricks(undefined).model).toMatch(/^system\.ai\./);
  });
});
