// Databricks tools for Claude Code, Codex and Pi: the same Genie One, Genie
// agents and MCP servers a Built-in agent gets, served to the harness by the
// runner's MCP bridge (`runner.mjs mcp <tools.json>`, ../runner/bridge.ts)
// inside the Sandbox. The bridge calls Databricks with the Sandbox's own
// credential, read fresh for every call, so no token is handed to a harness.
//   Claude Code: an MCP config file (--mcp-config, --strict-mcp-config).
//   Codex:       mcp_servers.<name> config overrides (-c).
//   Pi:          an extension (-e) that starts the bridge and registers its tools.
import { SANDBOX_HOME } from "@dbx/core/api/sandbox";
import type { ToolChoice } from "./capabilities";

/** Where the plugin keeps the runner bundle in a Sandbox (hosted agents run it from here too). */
export const RUNNER_PATH = `${SANDBOX_HOME}/.buzz/agent/runner.mjs`;

/** The bridge's MCP server name: Claude Code calls its tools mcp__dbx__<tool>. */
export const BRIDGE_NAME = "dbx";

/** Claude Code prefixes `mcp__dbx__` (10 characters) and tool names stay within 64. */
export const BRIDGE_TOOL_NAME_MAX = 54;

/** What the bridge serves: the agent's tool choices, in the Sandbox's workspace. */
export type BridgeConfig = Readonly<{ workspaceId?: string; tools: readonly ToolChoice[] }>;

export const bridgeCommand = (runner: string, config: string) => ["node", runner, "mcp", config];

/** A Pi extension that starts the bridge (named by BUZZ_TOOLS_BRIDGE) and registers each of its tools. */
export const PI_EXTENSION = `// Databricks tools for Pi, written by the Databricks Agents plugin for Buzz.
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";

export default async function (pi) {
  let command = [];
  try {
    command = JSON.parse(process.env.BUZZ_TOOLS_BRIDGE || "[]");
  } catch {}
  if (!command.length) return;
  const child = spawn(command[0], command.slice(1), { stdio: ["pipe", "pipe", "inherit"] });
  const pending = new Map();
  let next = 1;
  // The bridge keeps Pi running only while a request waits on it, so Pi can exit when it's done.
  const hold = (on) => {
    for (const handle of [child, child.stdin, child.stdout]) on ? handle.ref?.() : handle.unref?.();
  };
  const settle = () => pending.size || hold(false);
  const fail = (error) => {
    for (const waiting of pending.values()) waiting.reject(error);
    pending.clear();
    settle();
  };
  child.on("error", fail);
  child.on("exit", () => fail(new Error("The Databricks tools stopped.")));
  createInterface({ input: child.stdout }).on("line", (line) => {
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      return;
    }
    const waiting = pending.get(message.id);
    if (!waiting) return;
    pending.delete(message.id);
    settle();
    if (message.error) waiting.reject(new Error(message.error.message || "The tool failed."));
    else waiting.resolve(message.result);
  });
  const send = (message) => child.stdin.write(JSON.stringify(message) + "\\n");
  const request = (method, params, signal) =>
    new Promise((resolve, reject) => {
      const id = next++;
      pending.set(id, { resolve, reject });
      hold(true);
      send({ jsonrpc: "2.0", id, method, params });
      signal?.addEventListener(
        "abort",
        () => {
          if (!pending.delete(id)) return;
          settle();
          send({ jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: id } });
          reject(new Error("Stopped."));
        },
        { once: true },
      );
    });
  const stop = () => child.kill();
  pi.on("session_shutdown", stop);
  process.on("exit", stop);
  try {
    await request("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "pi", version: "1" } });
    send({ jsonrpc: "2.0", method: "notifications/initialized" });
    const { tools = [] } = await request("tools/list", {});
    for (const tool of tools)
      pi.registerTool({
        name: tool.name,
        label: tool.title || tool.name,
        description: tool.description || tool.name,
        parameters: tool.inputSchema || { type: "object", properties: {} },
        async execute(_id, params, signal) {
          const result = await request("tools/call", { name: tool.name, arguments: params ?? {} }, signal);
          const text = (result?.content ?? []).filter((part) => part.type === "text").map((part) => part.text).join("\\n") || JSON.stringify(result?.structuredContent ?? {});
          if (result?.isError) throw new Error(text);
          return { content: [{ type: "text", text }], details: {} };
        },
      });
  } catch (error) {
    console.error("Databricks tools unavailable: " + (error?.message ?? error));
  }
}
`;

/** The files a turn with Databricks tools writes next to its prompt (paths from `runFiles`). */
export function toolFiles(
  harness: "claude" | "codex" | "pi",
  files: Readonly<{ tools: string; mcp: string; piTools: string }>,
  runner: string,
  config: BridgeConfig,
): { path: string; content: string }[] {
  const out = [{ path: files.tools, content: `${JSON.stringify(config)}\n` }];
  const [command, ...args] = bridgeCommand(runner, files.tools);
  if (harness === "claude") out.push({ path: files.mcp, content: `${JSON.stringify({ mcpServers: { [BRIDGE_NAME]: { type: "stdio", command, args } } })}\n` });
  if (harness === "pi") out.push({ path: files.piTools, content: PI_EXTENSION });
  return out;
}

/** Whether an agent's choices give a harness anything to serve. */
export const hasBridgeTools = (tools: readonly ToolChoice[] | undefined) => Boolean(tools?.length);
