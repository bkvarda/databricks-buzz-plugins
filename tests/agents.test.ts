import { describe, expect, it } from "vitest";
import type { ChatCompletion, ChatMessage } from "@dbx/core/api/ai";
import { runLoop, trimHistory } from "../plugins/agents/src/loop";
import { plainText } from "../plugins/agents/src/state";
import { normalizeDatabricks, summarize } from "../plugins/agents/src/types";
import { filterOptions, modelOptions } from "../plugins/agents/src/ui";
import { Ai, modelLabel } from "@dbx/core/api/ai";
import { fromCsv, parseCsv, RESULT_LANGUAGE, resultBlock, resultSet } from "@dbx/core/result";

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
  it("normalizes config into one of three kinds", () => {
    expect(normalizeDatabricks(undefined)).toMatchObject({ kind: "genie-one", scope: "thread", tools: [] });
    expect(normalizeDatabricks(undefined).model).toMatch(/^system\.ai\./);
    // Saved before kinds: a model agent.
    expect(normalizeDatabricks({ model: "system.ai.gpt-5-4", scope: "channel" })).toMatchObject({ kind: "sandbox", scope: "channel", instructions: "" });
    expect(normalizeDatabricks({ kind: "custom", custom: { kind: "endpoint", target: "support-agent", task: "agent/v1/responses" } }).custom).toEqual({
      kind: "endpoint",
      target: "support-agent",
      label: "support-agent",
      task: "agent/v1/responses",
    });
    expect(normalizeDatabricks({ kind: "custom", custom: { kind: "app", target: "http://plain" } }).custom).toBeUndefined();
    expect(normalizeDatabricks({ kind: "nope" }).kind).toBe("genie-one");
  });

  it("summarizes each kind", () => {
    expect(summarize(normalizeDatabricks({ kind: "genie-one", profile: "other" }))).toBe("Genie One · other");
    expect(summarize(normalizeDatabricks({ kind: "sandbox", model: "system.ai.claude-sonnet-5-5", tools: [{ id: "genie-one", kind: "genie-one", label: "Genie One" }] }))).toBe("Sandbox · Claude Sonnet 5.5 · 1 tool");
    expect(summarize(normalizeDatabricks({ kind: "sandbox", model: "system.ai.gpt-6-1-terra" }))).toBe("Sandbox · GPT-6.1 Terra");
    expect(summarize(normalizeDatabricks({ kind: "custom", custom: { kind: "genie", target: "01f0", label: "NYC Taxi Trips" } }))).toBe("NYC Taxi Trips");
    expect(summarize(normalizeDatabricks({ kind: "custom" }))).toBe("No agent chosen");
  });

  it("labels AI Gateway models and searches picker options", () => {
    expect(["system.ai.claude-opus-5-5", "system.ai.gpt-5-6-sol", "system.ai.gpt-oss-120b", "system.ai.deepseek-v4-1-flash-1017", "system.ai.meta-llama-3-3-70b-instruct"].map(modelLabel)).toEqual([
      "Claude Opus 5.5",
      "GPT-5.6 Sol",
      "GPT OSS 120B",
      "DeepSeek V4.1 Flash 1017",
      "Meta Llama 3.3 70B Instruct",
    ]);
    const options = modelOptions([
      { id: "system.ai.gemini-3-8-flash", label: "Gemini 3.8 Flash", tools: true, builtIn: true },
      { id: "system.ai.claude-sonnet-5-5", label: "Claude Sonnet 5.5", tools: true, builtIn: true },
      { id: "main.team.support_model", label: "Support Model", tools: true, builtIn: false },
    ]);
    expect(options.map((option) => [option.group, option.label])).toEqual([
      ["Recommended", "Claude Sonnet 5.5"],
      ["All Databricks models", "Gemini 3.8 Flash"],
      ["Your workspace", "Support Model"],
    ]);
    expect(filterOptions(options, "flash").map((option) => option.id)).toEqual(["system.ai.gemini-3-8-flash"]);
    expect(filterOptions(options, "team support").map((option) => option.id)).toEqual(["main.team.support_model"]);
    expect(filterOptions(options, "")).toHaveLength(3);
  });
});

import { answerParts, answerText, cleanAnswer, parseStep } from "../plugins/genie/src/genie-one-chat";
import { stripComments, toResultSet, trimTables, answerMarkdown, withoutChartCaveats } from "../plugins/genie/src/genie-one";

describe("Genie One rendering", () => {
  it("parses progress steps, dropping embedded tables and comment markers", () => {
    expect(parseStep("Thinking: Genie: none — user explicitly named the sample table; I'll inspect its schema next.")).toEqual({
      kind: "thought",
      text: "user explicitly named the sample table; I'll inspect its schema next.",
    });
    expect(parseStep("Running SQL: SELECT COUNT(*) FROM `samples`.`nyctaxi`.`trips`")).toEqual({ kind: "sql", text: "SELECT COUNT(*) FROM `samples`.`nyctaxi`.`trips`" });
    expect(
      parseStep("Query result: Query returned 1 rows: <!-- begin:query_5a5312 -- > | total_trips | avg_fare | | --- | --- | | 21932 | 12.35 | <!-- end:query_5a5312 -- >"),
    ).toEqual({ kind: "result", text: "Query returned 1 rows" });
  });
  it("strips comments, including the escaped `-- >` form", () => {
    expect(stripComments("a <!-- agent: note --> b <!-- x -- > c")).toBe("a  b  c");
  });
  it("drops Markdown tables from the answer when rows render natively", () => {
    const result = toResultSet({ ready: true, columns: [{ name: "n", type_text: "BIGINT" }], rows: [[21932]], total_row_count: 1 })!;
    const text = "## Trips\n\nThere are **21,932** trips.\n\n| n |\n| --- |\n| 21932 |\n\n- Sample data.";
    const answer = { conversationId: "c", responseId: "r", status: "completed" as const, text, markdown: "", steps: [], results: [result], sql: [] };
    expect(answerText(answer)).toBe("## Trips\n\nThere are **21,932** trips.\n\n- Sample data.");
    // Without typed rows, the answer's own table becomes a native result.
    const fromText = answerParts({ ...answer, results: [] });
    expect(fromText.text).toBe("## Trips\n\nThere are **21,932** trips.\n\n- Sample data.");
    expect(fromText.results[0]?.columns).toEqual([{ name: "n", kind: "number" }]);
    expect(fromText.results[0]?.rows).toEqual([["21932"]]);
    expect(result.columns[0]?.kind).toBe("number");
    expect(result.rows[0]?.[0]).toBe("21932");
  });
  it("merges a code span with the link that repeats it", () => {
    expect(cleanAnswer("Only one table, `samples.nyctaxi.trips` [samples.nyctaxi.trips](https://h/t). Done")).toBe("Only one table, [samples.nyctaxi.trips](https://h/t). Done");
  });
  it("removes citation directives and embed-only result links", () => {
    expect(cleanAnswer("**21,932** trips. :citation[sql.pub_toolu_x] [Query Result](https://h/one/chat/threads/1?o=2#embed-query_5a) [trips](https://h/explore/data/samples/nyctaxi/trips)")).toBe(
      "**21,932** trips. [trips](https://h/explore/data/samples/nyctaxi/trips)",
    );
  });
});

import { formatSql } from "../plugins/genie/src/genie-one-chat";
import { parseBlocks, renderInline } from "@dbx/core/ui/markdown";

describe("Genie One display helpers", () => {
  it("breaks one-line SQL at clauses and select items", () => {
    expect(formatSql("SELECT HOUR(`t`) AS h, COUNT(*) AS n, ROUND(AVG(`d`), 2) AS d FROM `s`.`n`.`trips` GROUP BY 1 ORDER BY 1")).toBe(
      "SELECT\n  HOUR(`t`) AS h,\n  COUNT(*) AS n,\n  ROUND(AVG(`d`), 2) AS d\nFROM `s`.`n`.`trips`\nGROUP BY 1\nORDER BY 1",
    );
    expect(formatSql("SELECT a\nFROM b")).toBe("SELECT a\nFROM b");
  });
  it("unescapes Markdown backslash escapes", () => {
    expect(renderInline("about \\~$14.80 and 2\\*3")).toEqual(["about ", "~", "$14.80 and 2", "*", "3"]);
    expect(parseBlocks("a \\~b")[0]).toEqual({ type: "p", text: "a \\~b" });
  });
});

describe("chat replies", () => {
  it("trims long Markdown tables and says how many rows were left out", () => {
    const table = ["| h | n |", "| --- | --- |", ...Array.from({ length: 15 }, (_, i) => `| ${i} | ${i * 10} |`)].join("\n");
    const trimmed = trimTables(`Intro\n\n${table}\n\nOutro`, 12).split("\n");
    expect(trimmed.filter((line) => /^\| \d/.test(line))).toHaveLength(12);
    expect(trimmed).toContain("_3 more rows in Databricks._");
    expect(trimmed[trimmed.length - 1]).toBe("Outro");
    expect(trimTables("| a |\n| --- |\n| 1 |")).toBe("| a |\n| --- |\n| 1 |");
  });
});

describe("result blocks", () => {
  const orders = [
    "I can't draw charts here, so I've split the orders out by day in a table you can chart directly.",
    "",
    "| date | web_orders | store_orders |",
    "| --- | --- | --- |",
    "| 2026-11-01 | 120.5 | 410.25 |",
    "| 2026-11-02 | 98.75 | 415.5 |",
    "",
    "- **Store orders are steady.**",
    "",
    "To turn this into a chart, you can open the result in a SQL editor or a dashboard and add a stacked bar chart: put the date on the x-axis. Daily figures use the same definition. [Knowledge snippet](#k1)",
  ].join("\n");

  it("round-trips CSV, quoting and nulls", () => {
    const result = resultSet([{ name: "city" }, { name: "trips" }], [["New York, NY", "3"], ['Say "hi"', null]]);
    const block = resultBlock(result);
    expect(block.startsWith(`\`\`\`${RESULT_LANGUAGE}\n`)).toBe(true);
    const parsed = fromCsv(block.split("\n").slice(1, -1).join("\n"));
    expect(parsed?.rows).toEqual([["New York, NY", "3"], ['Say "hi"', null]]);
    expect(parsed?.columns.map((column) => column.kind)).toEqual(["text", "number"]);
    expect(parseCsv('a,b\r\n"x\ny",2\r\n')).toEqual([["a", "b"], ["x\ny", "2"]]);
    expect(fromCsv("a,b\n1")).toBeUndefined();
    expect(fromCsv("")).toBeUndefined();
  });

  it("notes rows left out", () => {
    const result = resultSet([{ name: "n" }], [["1"], ["2"], ["3"]], { totalRows: 10 });
    expect(resultBlock(result, 2)).toContain("_Showing 2 of 10 rows._");
  });

  it("turns Genie One tables into result blocks in place and drops chart caveats", () => {
    const typed = resultSet([{ name: "date", type: "DATE" }, { name: "web_orders", type: "DOUBLE" }, { name: "store_orders", type: "DOUBLE" }], [
      ["2026-11-01", "120.5", "410.25"],
      ["2026-11-02", "98.75", "415.5"],
    ]);
    const text = answerMarkdown({ text: orders, results: [typed] });
    expect(text).not.toMatch(/can't draw|turn this into a chart|Knowledge snippet|\| --- \|/);
    expect(text.startsWith(`\`\`\`${RESULT_LANGUAGE}\ndate,web_orders,store_orders\n2026-11-01,120.5,410.25`)).toBe(true);
    expect(text).toContain("- **Store orders are steady.**");
    expect(text).toContain("Daily figures use the same definition.");
    // Without typed rows, the table's own cells become the block.
    expect(answerMarkdown({ text: orders, results: [] })).toContain("2026-11-02,98.75,415.5");
  });

  it("adds the last result after plain text, and leaves single values alone", () => {
    const rows = resultSet([{ name: "hour" }, { name: "trips" }], [["17", "1200"], ["18", "1455"]]);
    expect(answerMarkdown({ text: "6 PM is busiest.", results: [rows] })).toBe(`6 PM is busiest.\n\n${resultBlock(rows)}`);
    const one = resultSet([{ name: "trips" }], [["21932"]]);
    expect(answerMarkdown({ text: "**21,932** trips.", results: [one] })).toBe("**21,932** trips.");
    expect(withoutChartCaveats("Revenue grew 4%. I can't render a graph in chat. Ask for more.")).toBe("Revenue grew 4%. Ask for more.");
  });
});

describe("AI Gateway chat", () => {
  it("turns reasoning off for models that need it with tools, and remembers", async () => {
    const bodies: Record<string, unknown>[] = [];
    const client = {
      post: async (_path: string, body: Record<string, unknown>) => {
        bodies.push(body);
        if (body.tools && body.reasoning_effort !== "none")
          throw Object.assign(new Error("Function tools with reasoning_effort are not supported for gpt-5.6-terra in /v1/chat/completions."), { status: 400 });
        return { choices: [{ message: { role: "assistant", content: "ok" } }] };
      },
    };
    const tools = [{ type: "function" as const, function: { name: "t", parameters: {} } }];
    const ai = new Ai(client as never);
    const first = await ai.chat({ model: "system.ai.test-reasoning", messages: [{ role: "user", content: "hi" }], tools });
    expect(first.choices[0]?.message.content).toBe("ok");
    expect(bodies.map((body) => body.reasoning_effort)).toEqual([undefined, "none"]);
    await new Ai(client as never).chat({ model: "system.ai.test-reasoning", messages: [{ role: "user", content: "again" }], tools });
    expect(bodies.length).toBe(3);
    expect(bodies[2]?.reasoning_effort).toBe("none");
    // Without tools nothing changes.
    await ai.chat({ model: "system.ai.test-reasoning", messages: [{ role: "user", content: "plain" }] });
    expect(bodies[3]?.reasoning_effort).toBeUndefined();
  });
});
