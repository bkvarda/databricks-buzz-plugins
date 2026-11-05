// How agents' work reads in Buzz: steps in words, thinking, and turn records.
import { describe, expect, it } from "vitest";
import { acpKind, describeStep, genieOneStep, genieStatusStep, stepText, thoughtStep, turnsFromLines } from "../plugins/agents/src/activity";
import { runLoop } from "../plugins/agents/src/loop";
import { parseEvent } from "../plugins/agents/src/remote";

describe("steps in words", () => {
  const labels = new Map([["genie_nyc_taxi_trips_ask", "NYC Taxi Trips"], ["github", "GitHub"]]);
  it("keeps the names Buzz phrases itself, and maps harness names to them", () => {
    expect(describeStep("Bash", "ls -la")).toEqual({ tool: "Bash", target: "ls -la" });
    expect(describeStep("shell", "npm test")).toEqual({ tool: "Bash", target: "npm test" });
    expect(describeStep("sandbox_read_file", "/home/x.py")).toEqual({ tool: "Read", target: "/home/x.py" });
    expect(describeStep("edit", "src/app.ts")).toEqual({ tool: "Edit", target: "src/app.ts" });
    expect(describeStep("ls")).toEqual({ tool: "ListFiles" });
  });
  it("says what Databricks tools are doing, by the owner's names for them", () => {
    expect(describeStep("genie_one_ask", "How many trips?")).toEqual({ tool: "Asking Genie One", target: "How many trips?" });
    expect(describeStep("mcp__dbx__genie_nyc_taxi_trips_ask", "How many trips?", labels)).toEqual({ tool: "Asking NYC Taxi Trips", target: "How many trips?" });
    expect(describeStep("databricks_sql_query", "\nSELECT count(*)\nFROM trips")).toEqual({ tool: "Running SQL", target: "SELECT count(*)" });
    expect(describeStep("github__search_repositories", "buzz", labels)).toEqual({ tool: "Using GitHub", target: "search repositories: buzz" });
    expect(describeStep("github__log_in", undefined, labels)).toEqual({ tool: "Checking the GitHub login" });
    expect(describeStep("sandbox", "Creating sandbox")).toEqual({ tool: "Creating its Sandbox" });
    expect(describeStep("some_other_tool")).toEqual({ tool: "some other tool" });
  });
  it("turns thinking, Genie progress and statuses into steps", () => {
    expect(thoughtStep("**Running computations**\n\nI'm comparing 391 and 399.")).toEqual({ tool: "Thinking", target: "Running computations" });
    expect(thoughtStep("I'll check the trips table first.")).toEqual({ tool: "Thinking", target: "I'll check the trips table first." });
    expect(genieOneStep("Thinking: Looking at samples.nyctaxi.trips")).toEqual({ tool: "Genie One", target: "Thinking: Looking at samples.nyctaxi.trips" });
    expect(genieStatusStep("NYC Taxi Trips", "EXECUTING_QUERY")).toEqual({ tool: "Asking NYC Taxi Trips", target: "running the query" });
  });
  it("phrases steps for the Activity tab and as ACP kinds for hosted frames", () => {
    expect(stepText({ tool: "Bash", target: "ls" })).toBe("Running ls");
    expect(stepText({ tool: "Asking Genie One", target: "How many?" })).toBe("Asking Genie One · How many?");
    expect(stepText({ tool: "Read" })).toBe("Reading a file");
    expect(acpKind({ tool: "Read", target: "a.ts" })).toBe("read");
    expect(acpKind({ tool: "Asking Genie One" })).toBe("search");
    expect(acpKind({ tool: "Thinking" })).toBe("think");
  });
  it("rebuilds turns from a runner's log, newest first", () => {
    const turns = turnsFromLines([
      { turn: "a", at: 1, type: "start", channel: "c", text: "first" },
      { turn: "a", at: 2, type: "step", text: "Running ls" },
      { turn: "a", at: 3, type: "thought", text: "Done looking." },
      { turn: "a", at: 4, type: "end", outcome: "done" },
      { turn: "b", at: 5, type: "start", channel: "c", root: "r", text: "second" },
      { turn: "b", at: 6, type: "step", text: "Running ls" },
      { turn: "b", at: 7, type: "step", text: "Running ls" },
    ]);
    expect(turns.map((turn) => turn.id)).toEqual(["b", "a"]);
    expect(turns[0]).toMatchObject({ root: "r", request: "second", items: [{ kind: "step", text: "Running ls" }] });
    expect(turns[0]!.endedAt).toBeUndefined();
    expect(turns[1]).toMatchObject({ outcome: "done", endedAt: 4, items: [{ kind: "step" }, { kind: "thought", text: "Done looking." }] });
  });
});

describe("thinking from each harness", () => {
  it("reads Claude Code's thinking blocks, Codex's reasoning and Pi's thinking", () => {
    expect(parseEvent("claude", JSON.stringify({ type: "assistant", message: { content: [{ type: "thinking", thinking: "Compare the two." }, { type: "tool_use", name: "Bash", input: { command: "ls" } }] } }))).toEqual({
      thought: "Compare the two.",
      step: { tool: "Bash", target: "ls" },
    });
    expect(parseEvent("codex", JSON.stringify({ type: "item.completed", item: { type: "reasoning", text: "**Planning**\n\nList files." } }))).toEqual({ thought: "**Planning**\n\nList files." });
    expect(parseEvent("codex", JSON.stringify({ type: "item.started", item: { type: "mcp_tool_call", server: "dbx", tool: "genie_one_ask", arguments: { question: "How many?" } } }))).toEqual({
      step: { tool: "genie_one_ask", target: "How many?" },
    });
    expect(parseEvent("codex", JSON.stringify({ type: "item.started", item: { type: "command_execution", command: `/bin/bash -lc "printf '%s\\n' * && echo \\"done\\""` } }))).toEqual({
      step: { tool: "shell", target: `printf '%s\\n' * && echo "done"` },
    });
    expect(parseEvent("pi", JSON.stringify({ type: "message_end", message: { role: "assistant", content: [{ type: "thinking", thinking: "Hmm." }, { type: "text", text: "Answer" }] } }))).toEqual({ text: "Answer", thought: "Hmm." });
  });
  it("the Built-in loop reports what the model says alongside its tool calls", async () => {
    const thoughts: string[] = [];
    let call = 0;
    await runLoop({
      model: "m",
      system: "s",
      history: [],
      prompt: "p",
      local: [{ name: "look", description: "", parameters: { type: "object" }, run: async () => "seen" }],
      chat: async () =>
        call++ === 0
          ? { choices: [{ message: { role: "assistant", content: "Let me look first.", tool_calls: [{ id: "1", type: "function", function: { name: "look", arguments: "{}" } }] } }] }
          : { choices: [{ message: { role: "assistant", content: "Done." } }] },
      signal: new AbortController().signal,
      onThought: (text) => thoughts.push(text),
    });
    expect(thoughts).toEqual(["Let me look first."]);
  });
});
