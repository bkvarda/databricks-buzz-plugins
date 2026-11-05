// The runner's MCP bridge: `runner.mjs mcp <tools.json>` serves Claude Code,
// Codex or Pi (over stdio MCP) the Databricks tools a Built-in agent gets from
// the same choices: Genie One, Genie agents and the chosen MCP servers
// (../src/capabilities.ts). It calls Databricks as the Sandbox's owner, with
// the Sandbox's own credential. A server that didn't list its tools becomes
// one tool that explains why, with the login link when the owner hasn't
// logged in to it yet, so the harness can say so.
//   node runner.mjs mcp <tools.json>         the stdio MCP server
//   node runner.mjs mcp-names <tools.json>   ",name,name…" for Pi's --tools allowlist
import { readFileSync } from "node:fs";
import { createInterface } from "node:readline";
import { toolPrefix } from "@dbx/core/api/mcp-catalog";
import { genieLocalTools, mcpLocalTools, normalizeChoices, type ToolFailure } from "../src/capabilities";
import { BRIDGE_TOOL_NAME_MAX } from "../src/harness-tools";
import type { LocalTool } from "../src/loop";
import { sandboxService } from "./databricks";

const NO_ARGS = { type: "object", properties: {} } as const;

function explain(failure: ToolFailure): LocalTool {
  const { server } = failure;
  const prefix = toolPrefix(server);
  if (failure.login)
    return {
      name: `${prefix}__log_in`,
      description: `[${server.label}] Not available yet: your owner hasn't logged in to ${server.label}. If you need it, give them this link to log in, then try again: ${failure.login}`,
      parameters: NO_ARGS,
      run: async () => `Ask your owner to log in to ${server.label} at ${failure.login}, then try again.`,
    };
  return {
    name: `${prefix}__unavailable`,
    description: `[${server.label}] Didn't start this time: ${failure.message.slice(0, 300)}`,
    parameters: NO_ARGS,
    run: async () => `${server.label} isn't available right now: ${failure.message}`,
  };
}

/** The tools for a bridge config, with names short enough for every harness and unique. */
export async function bridgeTools(path: string, signal: AbortSignal): Promise<LocalTool[]> {
  const config = JSON.parse(readFileSync(path, "utf8")) as { workspaceId?: string; tools?: unknown };
  const choices = normalizeChoices(config.tools);
  const service = sandboxService(config.workspaceId);
  const listed = await mcpLocalTools(service, choices, signal);
  const used = new Set<string>();
  return [...genieLocalTools(service, choices), ...listed.tools, ...listed.failures.map(explain)].map((tool) => {
    let name = tool.name.slice(0, BRIDGE_TOOL_NAME_MAX);
    for (let n = 2; used.has(name); n++) name = `${tool.name.slice(0, BRIDGE_TOOL_NAME_MAX - 4)}_${n}`;
    used.add(name);
    return name === tool.name ? tool : { ...tool, name };
  });
}

type Message = { jsonrpc?: string; id?: string | number; method?: string; params?: Record<string, unknown> };

/** Serves the tools over stdio until the harness closes stdin. Nothing but JSON-RPC goes to stdout. */
export function serveBridge(path: string, log: (line: string) => void = (line) => console.error(line)): Promise<void> {
  const ready = bridgeTools(path, AbortSignal.timeout(120_000)).catch((error: unknown) => {
    log(`tools bridge: couldn't list the tools: ${(error as Error).message ?? error}`);
    return [] as LocalTool[];
  });
  const calls = new Map<string | number, AbortController>();
  const write = (message: Record<string, unknown>) => process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);
  const text = (value: string, isError = false) => ({ content: [{ type: "text", text: value }], ...(isError && { isError }) });

  async function handle(message: Message) {
    const { id, method, params } = message;
    if (method === "notifications/cancelled") return calls.get(params?.requestId as string | number)?.abort();
    if (id === undefined) return;
    switch (method) {
      case "initialize":
        return write({ id, result: { protocolVersion: params?.protocolVersion ?? "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "databricks", version: "1" } } });
      case "ping":
        return write({ id, result: {} });
      case "tools/list":
        return write({ id, result: { tools: (await ready).map((tool) => ({ name: tool.name, description: tool.description, inputSchema: tool.parameters })) } });
      case "tools/call": {
        const tool = (await ready).find((candidate) => candidate.name === params?.name);
        if (!tool) return write({ id, result: text(`There's no Databricks tool named ${String(params?.name)}.`, true) });
        const controller = new AbortController();
        calls.set(id, controller);
        try {
          return write({ id, result: text(await tool.run((params?.arguments ?? {}) as Record<string, unknown>, controller.signal)) });
        } catch (error) {
          return write({ id, result: text(`Error: ${(error as Error).message ?? error}`, true) });
        } finally {
          calls.delete(id);
        }
      }
      default:
        return write({ id, error: { code: -32601, message: `Unknown method: ${method}` } });
    }
  }

  return new Promise((resolve) => {
    const lines = createInterface({ input: process.stdin });
    lines.on("line", (line) => {
      let message: Message;
      try {
        message = JSON.parse(line) as Message;
      } catch {
        return;
      }
      void handle(message).catch((error: unknown) => message.id !== undefined && write({ id: message.id, error: { code: -32603, message: (error as Error).message ?? String(error) } }));
    });
    lines.on("close", () => {
      for (const controller of calls.values()) controller.abort();
      resolve();
    });
  });
}
