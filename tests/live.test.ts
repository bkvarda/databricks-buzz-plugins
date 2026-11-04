// Live smoke test against a real workspace, through the same CLI + curl path
// the plugins use in Buzz. Skipped unless a profile is named explicitly:
//
//   DBX_LIVE_PROFILE=<profile> npx vitest run tests/live.test.ts
//
// It creates and then deletes a Sandbox and a memory store named
// `buzz-live-smoke`. Observed response shapes go to tmp/live-report.json.
import { mkdirSync, writeFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { DatabricksClient } from "@dbx/core/client";
import { Connection } from "@dbx/core/connection";
import { Ai, DEFAULT_MODEL, DEFAULT_MODELS, messageText } from "@dbx/core/api/ai";
import { Genie, summarize } from "@dbx/core/api/genie";
import { gatewayMcpPath, McpClient } from "@dbx/core/api/mcp";
import { createService } from "@dbx/core/provider";
import { GenieOne } from "../plugins/genie/src/genie-one";
import { runLoop } from "../plugins/agents/src/loop";
import { SANDBOX_PROMPT, sandboxFor, sandboxTools } from "../plugins/agents/src/sandbox";
import { Memory, entryId } from "@dbx/core/api/memory";
import { Sandboxes } from "@dbx/core/api/sandbox";
import { Sql } from "@dbx/core/api/sql";
import { Lakebase } from "@dbx/core/api/workspace";
import { nodeHost } from "./node-host";

const PROFILE = process.env.DBX_LIVE_PROFILE;
const SMOKE = "buzz-live-smoke";
// Sandbox IDs are unique per run: a just-deleted ID can linger.
const SANDBOX = `buzz-live-${Date.now().toString(36)}`;
const report: Record<string, unknown> = {};
const record = (key: string, value: unknown) => {
  report[key] = value;
};

describe.skipIf(!PROFILE)(`live workspace (${PROFILE})`, () => {
  const values = new Map<string, string>();
  const connection = new Connection(nodeHost(new URL("../plugins/databricks/manifest.json", import.meta.url).pathname), {
    get: (key) => values.get(key) ?? null,
    set: (key, value) => (value === null ? values.delete(key) : values.set(key, value)),
  });
  let client: DatabricksClient;
  let workspaceId: string | undefined;

  afterAll(() => {
    mkdirSync(new URL("../tmp/", import.meta.url), { recursive: true });
    writeFileSync(new URL("../tmp/live-report.json", import.meta.url), JSON.stringify(report, null, 2));
  });

  beforeAll(async () => {
    await connection.useProfile(PROFILE!);
    client = await connection.ready(undefined, 60_000);
    const snapshot = connection.snapshot();
    if (snapshot.status === "connected") workspaceId = snapshot.workspaceId;
    record("connection", { host: client.host, workspaceId, user: snapshot.status === "connected" && snapshot.user });
  }, 90_000);

  it("connects with the profile", () => {
    expect(connection.snapshot().status).toBe("connected");
    expect(workspaceId).toMatch(/^\d+$/);
  });

  it("runs SQL on a warehouse", async () => {
    const sql = new Sql(client);
    const warehouses = await sql.warehouses();
    const warehouse = Sql.pick(warehouses);
    record("sql.warehouses", warehouses.map((w) => ({ id: w.id, name: w.name, state: w.state, type: w.warehouse_type })));
    expect(warehouse).toBeDefined();
    const { result } = await sql.execute("SELECT current_user() AS me, 42 AS answer, current_date() AS today", {
      warehouseId: warehouse!.id,
      timeoutMs: 180_000,
    });
    record("sql.result", result);
    // Rows keep the API's string values; the column kind says how to read them.
    expect(result.rows[0]?.[1]).toBe("42");
    expect(result.columns.map((column) => column.kind)).toEqual(["text", "number", "time"]);
    record("sql.catalogs", (await sql.catalogs()).map((c) => c.name));
  }, 240_000);

  it("chats with a foundation model, with tool calls", async () => {
    const ai = new Ai(client);
    const endpoints = await ai.endpoints();
    record("ai.endpoints", endpoints.filter((e) => e.isChat).map((e) => e.name));
    const results: Record<string, unknown> = {};
    for (const model of DEFAULT_MODELS) {
      try {
        const reply = await ai.chat({ model: model.id, messages: [{ role: "user", content: "Reply with the word pong." }], maxTokens: 20 });
        results[model.id] = { ok: true, model: reply.model, text: messageText(reply.choices[0]!.message.content) };
      } catch (error) {
        results[model.id] = { ok: false, error: String((error as Error).message ?? error).slice(0, 300) };
      }
    }
    record("ai.models", results);
    const reply = await ai.chat({
      model: DEFAULT_MODEL,
      messages: [{ role: "user", content: "What is the weather in Paris? Use the tool." }],
      tools: [
        {
          type: "function",
          function: {
            name: "get_weather",
            description: "Current weather for a city",
            parameters: { type: "object", properties: { city: { type: "string" } }, required: ["city"] },
          },
        },
      ],
      maxTokens: 200,
    });
    record("ai.toolCall", reply.choices[0]);
    expect(reply.choices[0]?.message.tool_calls?.[0]?.function.name).toBe("get_weather");
  }, 240_000);

  it("lists Genie spaces and asks one", async () => {
    const genie = new Genie(client);
    const spaces = await genie.listSpaces();
    record("genie.spaces", spaces.map((s) => ({ id: s.space_id, title: s.title })));
    const space = spaces[0];
    if (!space) return;
    const statuses: string[] = [];
    const answer = await genie.answer(space.space_id, process.env.DBX_LIVE_GENIE_QUESTION ?? "How many rows are there?", {
      onUpdate: (message) => statuses.push(message.status),
    });
    record("genie.statuses", statuses);
    record("genie.message", answer.message);
    record("genie.summary", summarize(answer.message));
    record("genie.result", answer.result);
    expect(answer.message.status).toBe("COMPLETED");
  }, 300_000);

  it("lists Genie One MCP tools", async () => {
    const mcp = new McpClient(client, gatewayMcpPath("system.ai.genie_one_mcp"), workspaceId ? { o: workspaceId } : {});
    try {
      const tools = await mcp.listTools();
      record("genieOne.server", { serverInfo: mcp.serverInfo, instructions: mcp.instructions });
      record("genieOne.tools", tools);
      expect(tools.length).toBeGreaterThan(0);
    } catch (error) {
      record("genieOne.error", String((error as Error).message ?? error));
      throw error;
    }
  }, 120_000);

  it("asks Genie One a question end to end", async () => {
    const genieOne = new GenieOne(createService(connection, () => {}));
    expect(await genieOne.available()).toBe(true);
    const progress: string[][] = [];
    const answer = await genieOne.ask(
      process.env.DBX_LIVE_GENIE_ONE_QUESTION ?? "How many taxi trips are in samples.nyctaxi.trips, and what is the average fare?",
      { onProgress: (steps) => progress.push([...steps]) },
    );
    record("genieOne.progress", progress);
    record("genieOne.answer", answer);
    record("genieOne.formatted", genieOne.format(answer));
    expect(answer.status).toBe("completed");
    expect(answer.text.length).toBeGreaterThan(0);
  }, 600_000);

  it("creates, uses and deletes a Sandbox", async () => {
    const sandboxes = new Sandboxes(client);
    const states: string[] = [];
    try {
      const sandbox = await sandboxes.ensureRunning(SANDBOX, { displayName: "Buzz live smoke test", onState: (label, state) => states.push(`${label} (${state ?? "-"})`) });
      record("sandbox.created", sandbox);
      const exec = await sandboxes.bash(SANDBOX, "echo hello-from-sandbox; uname -sm; pwd; python3 --version");
      record("sandbox.exec", exec);
      expect(exec.stdout).toContain("hello-from-sandbox");
      await sandboxes.writeFile(SANDBOX, "/home/sandbox-agent/smoke.txt", "line one\nline \"two\"\n");
      const contents = await sandboxes.readFile(SANDBOX, "/home/sandbox-agent/smoke.txt");
      record("sandbox.read", contents);
      expect(contents).toBe("line one\nline \"two\"\n");
      // Larger than one write chunk, with multibyte characters.
      const big = "🧱 Databricks é\n".repeat(12_000);
      await sandboxes.writeFile(SANDBOX, "/home/sandbox-agent/nested/dir/big.txt", big);
      expect(await sandboxes.readFile(SANDBOX, "/home/sandbox-agent/nested/dir/big.txt")).toBe(big);
      const files = await sandboxes.listDirectory(SANDBOX, "/home/sandbox-agent");
      record("sandbox.list", files);
      expect(files.find((file) => file.name === "smoke.txt")?.size).toBe(20);
    } finally {
      record("sandbox.states", states);
      try {
        record("sandbox.delete", await sandboxes.delete(SANDBOX));
      } catch (error) {
        record("sandbox.deleteError", String((error as Error).message ?? error));
      }
    }
  }, 600_000);

  it("runs an agent turn: a Databricks model uses its Sandbox, then posts", async () => {
    const service = createService(connection, () => {});
    const pubkey = Array.from({ length: 64 }, () => "0123456789abcdef"[Math.floor(Math.random() * 16)]).join("");
    const posted: string[] = [];
    const steps: string[] = [];
    const states: string[] = [];
    const buzz = async (message: unknown) => {
      const m = message as { id: number; method: string; params?: { name: string; arguments: Record<string, unknown> } };
      if (m.method === "tools/list")
        return { jsonrpc: "2.0", id: m.id, result: { tools: [{ name: "send", description: "Post a message to the conversation. Set final: true on your last message.", inputSchema: { type: "object", properties: { text: { type: "string" }, final: { type: "boolean" } }, required: ["text"] } }] } };
      if (m.params?.name === "send") {
        posted.push(String(m.params.arguments.text));
        return { jsonrpc: "2.0", id: m.id, result: { content: [{ type: "text", text: "sent" }] } };
      }
      return { jsonrpc: "2.0", id: m.id, error: { code: -32601, message: "unknown" } };
    };
    const ai = new Ai(client);
    try {
      const result = await runLoop({
        model: DEFAULT_MODEL,
        system: `You are a helpful agent in a Buzz conversation.\n${SANDBOX_PROMPT}`,
        history: [],
        prompt: "Use Python in your sandbox to compute the sum of the squares of 1 through 100, and save the number to work/answer.txt. Then send the number with final: true.",
        buzz,
        local: sandboxTools(service, pubkey, "Live test", (state) => states.push(state)),
        chat: (request) => ai.chat(request),
        signal: new AbortController().signal,
        onStep: (tool) => steps.push(tool),
      });
      record("agent.result", { posted, steps, states, final: result.final, usage: result.usage, text: result.text });
      record("agent.messages", result.messages);
      expect(result.final).toBe(true);
      expect(posted.join(" ")).toContain("338350");
      expect(steps).toContain("sandbox_exec");
      const sandboxes = new Sandboxes(client);
      expect((await sandboxes.readFile(sandboxFor(pubkey), "/home/sandbox-agent/work/answer.txt")).trim()).toContain("338350");
      record("agent.sandbox", await sandboxes.get(sandboxFor(pubkey)));
    } finally {
      await new Sandboxes(client).delete(sandboxFor(pubkey)).catch((error) => record("agent.deleteError", String(error)));
    }
  }, 600_000);

  it("writes, searches and deletes managed memory", async () => {
    const memory = new Memory(client);
    const actor = connection.snapshot().status === "connected" ? (connection.snapshot() as { user: { userName: string } }).user.userName : "smoke";
    const store = await memory.ensureStore(SMOKE, "Buzz live smoke test");
    record("memory.store", store);
    try {
      const written = await memory.put(SMOKE, { actorId: actor, path: "/smoke/favorite-color", content: "The user's favorite color is teal." });
      record("memory.put", written);
      const updated = await memory.put(SMOKE, { actorId: actor, path: "/smoke/favorite-color", content: "The user's favorite color is lava orange." });
      record("memory.update", updated);
      expect(entryId(updated)).toBe(entryId(written));
      record("memory.list", await memory.list(SMOKE, actor));
      expect((await memory.list(SMOKE, actor, { prefix: "/smoke/" })).map((entry) => entry.path)).toEqual(["/smoke/favorite-color"]);
      expect(await memory.list(SMOKE, actor, { prefix: "/elsewhere/" })).toEqual([]);
      expect((await memory.get(SMOKE, actor, "/smoke/favorite-color"))?.content).toContain("lava orange");
      const found = await memory.search(SMOKE, actor, "what color does the user like");
      record("memory.search", found);
      expect(found[0]?.path).toBe("/smoke/favorite-color");
      expect(await memory.remove(SMOKE, actor, "/smoke/favorite-color")).toBe(true);
    } finally {
      try {
        record("memory.deleteStore", await client.json(`/api/2.0/agents/memory-stores/${SMOKE}`, { method: "DELETE" }));
      } catch (error) {
        record("memory.deleteStoreError", String((error as Error).message ?? error));
      }
    }
  }, 300_000);

  it("finds Lakebase Data API targets and reads through the Data API", async () => {
    const lakebase = new Lakebase(client);
    const projects = await lakebase.projects();
    record("lakebase.projects", projects.map((p) => p.id));
    const project = process.env.DBX_LIVE_LAKEBASE_PROJECT ?? "buzz-lab";
    const targets = await lakebase.dataApiTargets(project, workspaceId!);
    record("lakebase.targets", targets);
    expect(targets[0]?.url).toMatch(/^https:\/\/ep-[\w-]+\.database\.[\w-]+\.cloud\.databricks\.com\/api\/2\.0\/workspace\/\d+\/rest\/databricks_postgres$/);
    const table = process.env.DBX_LIVE_LAKEBASE_TABLE ?? "buzz_orders";
    try {
      const rows = await lakebase.select(targets[0]!.url, "public", table, { limit: 5 });
      record("lakebase.rows", rows);
      expect(Array.isArray(rows)).toBe(true);
    } catch (error) {
      record("lakebase.selectError", { name: (error as Error).name, message: (error as Error).message });
      // Workspaces where automation owns the project can't hand the Data API
      // a usable role for the signed-in person; the plugin explains the fix.
      if ((error as Error).name !== "DataApiRoleError" || process.env.DBX_LIVE_LAKEBASE_EXPECT_ROWS) throw error;
      console.warn(`Lakebase: ${(error as Error).message}`);
    }
  }, 120_000);
});
