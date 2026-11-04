// MCP client (Streamable HTTP, JSON-RPC over POST) for Databricks managed MCP
// servers: Unity Gateway services such as system.ai.genie_one_mcp and
// system.ai.dbsql, and workspace servers under /api/2.0/mcp/*.
import type { DatabricksClient } from "../client";
import { apiError } from "../client";
import { parseSse } from "../sse";

export const PROTOCOL_VERSION = "2025-06-18";

export type McpTool = Readonly<{
  name: string;
  title?: string;
  description?: string;
  inputSchema?: Readonly<Record<string, unknown>>;
  _meta?: Readonly<Record<string, unknown>>;
}>;

export type McpContent =
  | Readonly<{ type: "text"; text: string }>
  | Readonly<{ type: "image"; data: string; mimeType: string }>
  | Readonly<{ type: "resource"; resource: { uri: string; text?: string; mimeType?: string } }>
  | Readonly<{ type: "resource_link"; uri: string; name?: string }>
  | Readonly<{ type: string; [key: string]: unknown }>;

export type McpCallResult = Readonly<{
  content?: readonly McpContent[];
  structuredContent?: unknown;
  isError?: boolean;
  _meta?: Readonly<Record<string, unknown>>;
}>;

export class McpError extends Error {
  constructor(
    message: string,
    readonly code?: number,
    readonly data?: unknown,
  ) {
    super(message);
    this.name = "McpError";
  }
}

/** Unity Gateway MCP service URL for a full name like system.ai.dbsql. */
export const gatewayMcpPath = (fullName: string) => `/ai-gateway/mcp-services/${fullName}`;

export class McpClient {
  private session: string | undefined;
  private initializing: Promise<void> | undefined;
  private nextId = 1;
  private toolsCache: { at: number; tools: readonly McpTool[] } | undefined;
  serverInfo: { name?: string; version?: string } | undefined;
  instructions: string | undefined;

  constructor(
    private readonly client: DatabricksClient,
    private readonly path: string,
    private readonly query: Readonly<Record<string, string>> = {},
  ) {}

  async listTools(signal?: AbortSignal): Promise<readonly McpTool[]> {
    if (this.toolsCache && Date.now() - this.toolsCache.at < 5 * 60_000) return this.toolsCache.tools;
    const tools: McpTool[] = [];
    let cursor: string | undefined;
    do {
      const page = (await this.call("tools/list", cursor ? { cursor } : {}, signal)) as {
        tools?: McpTool[];
        nextCursor?: string;
      };
      tools.push(...(page.tools ?? []));
      cursor = page.nextCursor;
    } while (cursor);
    this.toolsCache = { at: Date.now(), tools };
    return tools;
  }

  callTool(
    name: string,
    args: Readonly<Record<string, unknown>>,
    options: Readonly<{ signal?: AbortSignal; meta?: Readonly<Record<string, unknown>>; timeoutMs?: number }> = {},
  ): Promise<McpCallResult> {
    return this.call(
      "tools/call",
      { name, arguments: args, ...(options.meta && { _meta: options.meta }) },
      options.signal,
      options.timeoutMs,
    ) as Promise<McpCallResult>;
  }

  async readResource(uri: string, signal?: AbortSignal) {
    return (await this.call("resources/read", { uri }, signal)) as {
      contents?: readonly { uri: string; mimeType?: string; text?: string; blob?: string }[];
    };
  }

  private async ensureSession(signal?: AbortSignal) {
    if (this.session) return;
    this.initializing ??= (async () => {
      const result = (await this.send(
        {
          jsonrpc: "2.0",
          id: this.nextId++,
          method: "initialize",
          params: {
            protocolVersion: PROTOCOL_VERSION,
            capabilities: {},
            clientInfo: { name: "databricks-buzz-plugins", version: "0.1.0" },
          },
        },
        signal,
        true,
      )) as { serverInfo?: { name?: string; version?: string }; instructions?: string };
      this.serverInfo = result?.serverInfo;
      this.instructions = result?.instructions;
      await this.send({ jsonrpc: "2.0", method: "notifications/initialized" }, signal).catch(() => {});
    })().finally(() => {
      this.initializing = undefined;
    });
    await this.initializing;
  }

  private async call(method: string, params: unknown, signal?: AbortSignal, timeoutMs?: number): Promise<unknown> {
    await this.ensureSession(signal);
    try {
      return await this.send({ jsonrpc: "2.0", id: this.nextId++, method, params }, signal, false, timeoutMs);
    } catch (error) {
      // A server that forgot our session answers 404; start a new one once.
      if ((error as { status?: number }).status === 404 && this.session) {
        this.session = undefined;
        await this.ensureSession(signal);
        return this.send({ jsonrpc: "2.0", id: this.nextId++, method, params }, signal, false, timeoutMs);
      }
      throw error;
    }
  }

  private async send(
    message: { jsonrpc: "2.0"; id?: number; method: string; params?: unknown },
    signal?: AbortSignal,
    initializing = false,
    timeoutMs = 120_000,
  ): Promise<unknown> {
    const response = await this.client.request(this.path, {
      method: "POST",
      query: this.query,
      body: message,
      timeoutMs,
      ...(signal && { signal }),
      headers: {
        Accept: "application/json, text/event-stream",
        ...(!initializing && { "MCP-Protocol-Version": PROTOCOL_VERSION }),
        ...(this.session && { "Mcp-Session-Id": this.session }),
      },
    });
    const session = response.headers["mcp-session-id"];
    if (session) this.session = session;
    if (message.id === undefined) return undefined;
    if (response.status === 202) return undefined;
    if (response.status < 200 || response.status >= 300) throw apiError(response);
    const type = response.headers["content-type"] ?? "";
    const payloads = type.includes("text/event-stream")
      ? parseSse(response.body).map((event) => event.data)
      : [response.body];
    for (const payload of payloads) {
      let parsed: { id?: number; result?: unknown; error?: { code?: number; message?: string; data?: unknown } };
      try {
        parsed = JSON.parse(payload);
      } catch {
        continue;
      }
      if (parsed.id !== message.id) continue;
      if (parsed.error)
        throw new McpError(parsed.error.message ?? "MCP error", parsed.error.code, parsed.error.data);
      return parsed.result;
    }
    throw new McpError(`No response to ${message.method}`);
  }
}

/** Joins a tool result's text content. */
export function resultText(result: McpCallResult): string {
  return (result.content ?? [])
    .map((item) => (item.type === "text" ? String((item as { text: string }).text) : ""))
    .filter(Boolean)
    .join("\n\n");
}

/** Parses JSON from structuredContent or the first JSON text block. */
export function resultJson<T = unknown>(result: McpCallResult): T | undefined {
  if (result.structuredContent !== undefined) return result.structuredContent as T;
  for (const item of result.content ?? []) {
    if (item.type !== "text") continue;
    const text = String((item as { text: string }).text).trim();
    if (!text.startsWith("{") && !text.startsWith("[")) continue;
    try {
      return JSON.parse(text) as T;
    } catch {
      // Not JSON; keep looking.
    }
  }
  return undefined;
}
