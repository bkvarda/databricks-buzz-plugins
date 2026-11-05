// What a Databricks agent can use beyond Buzz's own tools, as chosen in its
// settings: Genie One, specific Genie agents, and MCP servers from its
// workspace. Each becomes local tools for the agent loop, bound to the
// agent's workspace (which may differ from the one Buzz is connected to).
import { Genie } from "@dbx/core/api/genie";
import { McpClient, resultJson, resultText } from "@dbx/core/api/mcp";
import { isLoginRejection, mcpLoginPath, type McpServerKind, toolPrefix } from "@dbx/core/api/mcp-catalog";
import type { AgentTool } from "@dbx/core/host-types";
import type { DatabricksService } from "@dbx/core/service";
import { formatAnswer } from "../../genie/src/tools";
import { GenieOne } from "../../genie/src/genie-one";
import type { LocalTool } from "./loop";

export type ToolChoice = Readonly<{
  /** "genie-one", "genie:<space id>", or an McpServer ID. */
  id: string;
  kind: "genie-one" | "genie" | McpServerKind;
  label: string;
  /** MCP servers: the path on the workspace host. */
  path?: string;
}>;

export const GENIE_ONE_CHOICE: ToolChoice = { id: "genie-one", kind: "genie-one", label: "Genie One" };

const NAME = /^[a-zA-Z0-9_-]{1,64}$/;

/** Validates stored choices (they come from saved agent config). */
export function normalizeChoices(value: unknown): ToolChoice[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    const choice = item as Partial<ToolChoice>;
    if (typeof choice?.id !== "string" || typeof choice.label !== "string" || typeof choice.kind !== "string") return [];
    if (["service", "connection", "functions"].includes(choice.kind) && !(typeof choice.path === "string" && choice.path.startsWith("/"))) return [];
    return [{ id: choice.id, kind: choice.kind as ToolChoice["kind"], label: choice.label, ...(choice.path && { path: choice.path }) }];
  });
}

const slug = (text: string, max: number) =>
  (text.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "") || "x").slice(0, max).replace(/_+$/, "");

export const workspaceIdOf = (service: DatabricksService): string | undefined => {
  const snapshot = service.snapshot();
  return snapshot.status === "connected" ? (snapshot.workspaceId ?? snapshot.profile.workspaceId) : undefined;
};

/** `signal`, also aborting after `ms` (AbortSignal.any isn't in every webview). */
function withTimeout(signal: AbortSignal, ms: number): AbortSignal {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error(`No answer within ${ms / 1000} seconds`)), ms);
  const stop = () => controller.abort(signal.reason);
  if (signal.aborted) stop();
  else signal.addEventListener("abort", stop, { once: true });
  controller.signal.addEventListener("abort", () => clearTimeout(timer), { once: true });
  return controller.signal;
}

/** Plain text from a plugin AgentTool's reply. */
function replyText(reply: unknown): string {
  if (typeof reply === "string") return reply;
  const content = (reply as { content?: { type: string; text?: string }[] })?.content;
  if (Array.isArray(content)) return content.map((part) => (part.type === "text" ? (part.text ?? "") : "")).join("\n");
  return JSON.stringify(reply);
}

/** A plugin AgentTool (Buzz side) as a local loop tool. */
export function fromAgentTool(tool: AgentTool): LocalTool {
  return {
    name: tool.name,
    description: tool.description ?? "",
    parameters: (tool.inputSchema as Record<string, unknown> | undefined) ?? { type: "object", properties: {} },
    run: async (args) => replyText(await tool.call({} as never, {} as never, args as never)),
  };
}

export function genieLocalTools(service: DatabricksService, choices: readonly ToolChoice[]): LocalTool[] {
  const tools: LocalTool[] = [];
  const used = new Set<string>();
  for (const choice of choices) {
    if (choice.kind === "genie-one") {
      const genieOne = new GenieOne(service);
      tools.push({
        name: "genie_one_ask",
        description:
          "Asks Genie One, Databricks' assistant for questions about any data the owner can access in this agent's workspace. It finds the tables, writes and runs the SQL, and answers with numbers, a table and a link. Pass conversation_id from an earlier answer to follow up. Answers can take a minute.",
        parameters: {
          type: "object",
          properties: { question: { type: "string", description: "The question, in plain language." }, conversation_id: { type: "string" } },
          required: ["question"],
        },
        run: async (args, signal) => {
          const conversationId = typeof args.conversation_id === "string" && args.conversation_id ? args.conversation_id : undefined;
          return genieOne.format(await genieOne.ask(String(args.question ?? ""), { signal, ...(conversationId && { conversationId }) }));
        },
      });
    } else if (choice.kind === "genie") {
      const spaceId = choice.id.replace(/^genie:/, "");
      let name = `genie_${slug(choice.label, 40)}_ask`;
      for (let n = 2; used.has(name); n++) name = `genie_${slug(choice.label, 36)}_${n}_ask`;
      used.add(name);
      tools.push({
        name,
        description: `Asks the "${choice.label}" Genie agent, curated by the owner's data team, a question about its data. It answers with an explanation, a table and the SQL. Pass conversation_id to follow up.`,
        parameters: {
          type: "object",
          properties: { question: { type: "string", description: "The question, in plain language." }, conversation_id: { type: "string" } },
          required: ["question"],
        },
        run: async (args, signal) => {
          const client = await service.ready(signal);
          const conversationId = typeof args.conversation_id === "string" && args.conversation_id ? args.conversation_id : undefined;
          const answer = await new Genie(client).answer(spaceId, String(args.question ?? ""), { signal, ...(conversationId && { conversationId }) });
          return formatAnswer({ title: choice.label, space_id: spaceId }, answer, service.workspaceUrl(Genie.webPath(spaceId, answer.message.conversation_id)), 30);
        },
      });
    }
  }
  return tools;
}

/** A chosen MCP server that didn't list its tools: why, and the login page when it's a per-user login. */
export type ToolFailure = Readonly<{ server: ToolChoice; message: string; login?: string }>;

/**
 * Lists the tools of the chosen MCP servers and wraps each as a local tool
 * named <server>__<tool>. A server that fails to answer is reported, not fatal.
 */
export async function mcpLocalTools(
  service: DatabricksService,
  choices: readonly ToolChoice[],
  signal: AbortSignal,
): Promise<{ tools: LocalTool[]; problems: string[]; failures: ToolFailure[] }> {
  const servers = choices.filter((choice) => choice.path);
  if (!servers.length) return { tools: [], problems: [], failures: [] };
  const client = await service.ready(signal);
  const workspaceId = workspaceIdOf(service);
  const problems: string[] = [];
  const failures: ToolFailure[] = [];
  const lists = await Promise.all(
    servers.map(async (server) => {
      const query: Record<string, string> = server.path!.startsWith("/ai-gateway/") && workspaceId ? { o: workspaceId } : {};
      const mcp = new McpClient(client, server.path!, query);
      try {
        const tools = await mcp.listTools(withTimeout(signal, 30_000));
        return { server, mcp, tools };
      } catch (error) {
        // A per-user OAuth service the owner hasn't logged in to: give the model the link.
        const login = server.kind === "service" && isLoginRejection(error) ? service.workspaceUrl(mcpLoginPath(server.id.replace(/^service:/, ""))) : undefined;
        failures.push({ server, message: (error as Error).message ?? String(error), ...(login && { login }) });
        problems.push(
          login
            ? `${server.label}: your owner isn't logged in to ${server.label} yet. Ask them to log in at ${login}, then try again`
            : `${server.label}: ${(error as Error).message ?? error}`,
        );
        return { server, mcp, tools: [] };
      }
    }),
  );
  const tools: LocalTool[] = [];
  const names = new Set<string>();
  for (const { server, mcp, tools: listed } of lists) {
    const prefix = toolPrefix(server);
    for (const tool of listed) {
      let name = `${prefix}__${tool.name}`.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 64);
      for (let n = 2; names.has(name); n++) name = `${name.slice(0, 60)}_${n}`;
      if (!NAME.test(name)) continue;
      names.add(name);
      tools.push({
        name,
        description: `[${server.label}] ${tool.description ?? tool.title ?? tool.name}`.slice(0, 4000),
        parameters: (tool.inputSchema as Record<string, unknown> | undefined) ?? { type: "object", properties: {} },
        run: async (args, runSignal) => {
          const result = await mcp.callTool(tool.name, args, { signal: runSignal, timeoutMs: 170_000 });
          const text = resultText(result);
          const body = text || (result.structuredContent !== undefined ? JSON.stringify(resultJson(result)) : "OK");
          return result.isError ? `Error from ${server.label}: ${body}` : body;
        },
      });
    }
  }
  return { tools, problems, failures };
}
