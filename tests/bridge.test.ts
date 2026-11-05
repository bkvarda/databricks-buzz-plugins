// The Databricks tools bridge that Claude Code, Codex and Pi use: the real
// runner bundle (`runner.mjs mcp`) over stdio, against a fake workspace whose
// MCP servers answer like Databricks' (one with tools, one needing a login).
import { type ChildProcessWithoutNullStreams, execFile, spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { promisify } from "node:util";
import { build } from "esbuild";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { GENIE_ONE_CHOICE } from "../plugins/agents/src/capabilities";
import { BRIDGE_NAME, PI_EXTENSION, toolFiles } from "../plugins/agents/src/harness-tools";
import { harnessCommand, remoteNote, runFiles } from "../plugins/agents/src/remote";

describe("harness commands with Databricks tools", () => {
  const files = runFiles("/home/sandbox-agent/.buzz/runs/r1");
  const tools = { runner: "/home/sandbox-agent/.buzz/agent/runner.mjs" };
  const base = { model: "system.ai.claude-sonnet-5-5", permissions: "standard" as const, files, tools };
  it("gives Claude Code the bridge as its only MCP server, allowed in Standard", () => {
    const command = harnessCommand({ ...base, harness: "claude", session: { id: "s1", resume: false } });
    expect(command).toContain(`--mcp-config '${files.mcp}' --strict-mcp-config --allowedTools mcp__${BRIDGE_NAME}`);
    expect(command).toMatch(/^MCP_TIMEOUT=\d+ MCP_TOOL_TIMEOUT=\d+ claude /);
    expect(harnessCommand({ ...base, harness: "claude", permissions: "full", session: { id: "s1", resume: false } })).not.toContain("--allowedTools");
    const { tools: _none, ...without } = base;
    expect(harnessCommand({ ...without, harness: "claude", session: { id: "s1", resume: false } })).not.toContain("mcp");
  });
  it("gives Codex the bridge as an MCP server with long timeouts", () => {
    const command = harnessCommand({ ...base, harness: "codex", model: "system.ai.gpt-5-6-sol", session: undefined });
    expect(command).toContain(`-c 'mcp_servers.${BRIDGE_NAME}.command="node"'`);
    expect(command).toContain(`-c 'mcp_servers.${BRIDGE_NAME}.args=["${tools.runner}","mcp","${files.tools}"]'`);
    expect(command).toContain("tool_timeout_sec=600");
    expect(command).toContain(`-c 'mcp_servers.${BRIDGE_NAME}.default_tools_approval_mode="approve"'`);
  });
  it("gives Pi the tools extension, and in Standard lists the bridge's tools after its file tools", () => {
    const command = harnessCommand({ ...base, harness: "pi", session: { id: "s1", resume: false } });
    expect(command).toContain(`-e '${files.piTools}'`);
    expect(command).toContain(`BUZZ_TOOLS_BRIDGE='["node","${tools.runner}","mcp","${files.tools}"]'`);
    expect(command).toContain(`--tools "read,grep,find,ls,edit,write$('node' '${tools.runner}' 'mcp-names' '${files.tools}' 2>/dev/null)"`);
    expect(harnessCommand({ ...base, harness: "pi", permissions: "full", session: { id: "s1", resume: false } })).not.toContain("--tools");
  });
  it("writes each harness's tool files and names the tools in the system note", () => {
    const config = { tools: [GENIE_ONE_CHOICE] };
    expect(toolFiles("codex", files, tools.runner, config).map((file) => file.path)).toEqual([files.tools]);
    const claude = toolFiles("claude", files, tools.runner, config);
    expect(JSON.parse(claude[1]!.content)).toEqual({ mcpServers: { [BRIDGE_NAME]: { type: "stdio", command: "node", args: [tools.runner, "mcp", files.tools] } } });
    expect(toolFiles("pi", files, tools.runner, config)[1]).toEqual({ path: files.piTools, content: PI_EXTENSION });
    expect(remoteNote("claude", "standard", [GENIE_ONE_CHOICE])).toContain("these Databricks tools, which run with their access: Genie One");
  });
});

type Rpc = { id?: number; result?: { tools?: { name: string; description: string }[]; content?: { text: string }[]; isError?: boolean }; error?: { message: string } };

describe("tools bridge against a fake workspace", () => {
  let server: Server;
  let dir: string;
  let script: string;
  let bridge: ChildProcessWithoutNullStreams;
  let env: NodeJS.ProcessEnv;
  const replies = new Map<number, (message: Rpc) => void>();
  let next = 1;
  const rpc = (method: string, params: unknown = {}) =>
    new Promise<Rpc>((resolve) => {
      const id = next++;
      replies.set(id, resolve);
      bridge.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    });
  const authorized: string[] = [];

  beforeAll(async () => {
    // Databricks' MCP endpoints: JSON-RPC over POST. One schema's functions, and a GitHub service the owner hasn't logged in to.
    server = createServer((request, response) => {
      let body = "";
      request.on("data", (chunk: Buffer) => (body += chunk));
      request.on("end", () => {
        authorized.push(String(request.headers.authorization));
        const message = JSON.parse(body) as { id?: number; method: string; params?: { name?: string; arguments?: { a: number; b: number } } };
        const send = (value: unknown) => {
          response.writeHead(200, { "content-type": "application/json", "mcp-session-id": "s1" });
          response.end(JSON.stringify({ jsonrpc: "2.0", id: message.id, ...(value as object) }));
        };
        if (message.id === undefined) return void response.writeHead(202).end();
        if (message.method === "initialize") return send({ result: { protocolVersion: "2025-06-18", capabilities: { tools: {} } } });
        if (request.url?.startsWith("/ai-gateway/mcp-services/system.ai.github")) return send({ error: { code: -32006, message: "rejected (HTTP 401)" } });
        if (message.method === "tools/list")
          return send({ result: { tools: [{ name: "add", description: "Adds two numbers", inputSchema: { type: "object", properties: { a: { type: "number" }, b: { type: "number" } } } }] } });
        const { a, b } = message.params!.arguments!;
        return send({ result: { content: [{ type: "text", text: String(a + b) }] } });
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as { port: number }).port;
    dir = mkdtempSync(join(tmpdir(), "buzz-bridge-"));
    writeFileSync(join(dir, ".databrickscfg"), `[DEFAULT]\nhost = http://127.0.0.1:${port}\ntoken = sandbox-token\n`);
    writeFileSync(
      join(dir, "tools.json"),
      JSON.stringify({
        workspaceId: "123",
        tools: [
          GENIE_ONE_CHOICE,
          { id: "functions:main.default", kind: "functions", label: "main.default", path: "/api/2.0/mcp/functions/main/default" },
          { id: "service:system.ai.github", kind: "service", label: "GitHub", path: "/ai-gateway/mcp-services/system.ai.github" },
        ],
      }),
    );
    const bundle = await build({
      entryPoints: [new URL("../plugins/agents/runner/main.ts", import.meta.url).pathname],
      bundle: true,
      format: "esm",
      platform: "node",
      target: "node22",
      write: false,
      tsconfig: new URL("../tsconfig.json", import.meta.url).pathname,
      logLevel: "silent",
    });
    script = join(dir, "runner.mjs");
    writeFileSync(script, bundle.outputFiles[0]!.text);
    env = { ...process.env, HOME: dir, BUZZ_AGENT_DIR: join(dir, "agent") };
    bridge = spawn(process.execPath, [script, "mcp", join(dir, "tools.json")], { env });
    createInterface({ input: bridge.stdout }).on("line", (line) => {
      const message = JSON.parse(line) as Rpc;
      replies.get(message.id!)?.(message);
    });
  }, 60_000);

  afterAll(async () => {
    bridge?.stdin.end();
    await new Promise<void>((resolve) => server?.close(() => resolve()));
    if (dir) rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });

  it("lists Genie One, the servers' tools, and a login explainer for a server waiting on a login", async () => {
    expect((await rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {} })).result).toMatchObject({ capabilities: { tools: {} } });
    const tools = (await rpc("tools/list")).result!.tools!;
    expect(tools.map((tool) => tool.name)).toEqual(["genie_one_ask", "main_default__add", "github__log_in"]);
    expect(tools[2]!.description).toContain("hasn't logged in to GitHub");
    expect(authorized.every((header) => header === "Bearer sandbox-token")).toBe(true);
  });

  it("calls a server's tool, and gives the login link", async () => {
    expect((await rpc("tools/call", { name: "main_default__add", arguments: { a: 2, b: 3 } })).result).toEqual({ content: [{ type: "text", text: "5" }] });
    const login = (await rpc("tools/call", { name: "github__log_in", arguments: {} })).result!.content![0]!.text;
    expect(login).toMatch(/log in to GitHub at http:\/\/127\.0\.0\.1:\d+\/mcp-service-login\?name=system\.ai\.github/);
    expect((await rpc("tools/call", { name: "nope", arguments: {} })).result).toMatchObject({ isError: true });
  });

  it("loads as a Pi extension: registers the tools, calls one, and lets the process exit", async () => {
    writeFileSync(join(dir, "databricks-tools.mjs"), PI_EXTENSION);
    // A stand-in for Pi: collects registered tools, then runs one, with nothing else keeping Node alive.
    writeFileSync(
      join(dir, "pi.mjs"),
      `const tools = [];
const pi = { registerTool: (tool) => tools.push(tool), on: () => {} };
await (await import(${JSON.stringify(join(dir, "databricks-tools.mjs"))})).default(pi);
const add = tools.find((tool) => tool.name === "main_default__add");
const result = await add.execute("call-1", { a: 20, b: 22 }, new AbortController().signal);
console.log(JSON.stringify({ names: tools.map((tool) => tool.name), text: result.content[0].text }));`,
    );
    const bridgeEnv = { ...env, BUZZ_TOOLS_BRIDGE: JSON.stringify([process.execPath, script, "mcp", join(dir, "tools.json")]) };
    const { stdout } = await promisify(execFile)(process.execPath, [join(dir, "pi.mjs")], { env: bridgeEnv, timeout: 30_000 });
    expect(JSON.parse(stdout)).toEqual({ names: ["genie_one_ask", "main_default__add", "github__log_in"], text: "42" });
  });

  it("prints the tool names for Pi's allowlist", async () => {
    const { stdout } = await promisify(execFile)(process.execPath, [script, "mcp-names", join(dir, "tools.json")], { env, timeout: 30_000 });
    expect(stdout).toBe(",genie_one_ask,main_default__add,github__log_in");
  });
});
