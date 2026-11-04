// Genie One through its managed MCP server on Unity Gateway:
//   /ai-gateway/mcp-services/system.ai.genie_one_mcp?o=<workspace-id>
// Tools: genie_ask → genie_poll_response (until done) → genie_get_query_result.
// Argument names come from the server's own input schemas, so small schema
// changes on the server side do not break the client.
import { gatewayMcpPath, McpClient, type McpTool, resultJson, resultText } from "@dbx/core/api/mcp";
import { resultSet, type ResultSet, toMarkdown } from "@dbx/core/result";
import type { DatabricksService } from "@dbx/core/service";

export const GENIE_ONE = "system.ai.genie_one_mcp";

export type GenieOneAnswer = Readonly<{
  conversationId?: string;
  responseId?: string;
  status: string;
  text: string;
  steps: readonly string[];
  results: readonly ResultSet[];
  links: readonly string[];
  sql: readonly string[];
}>;

type Json = Record<string, unknown>;

const DONE = /^(completed?|succeeded|success|done|failed|error|cancell?ed)$/i;
const FAILED = /^(failed|error|cancell?ed)$/i;

function propertyNames(tool: McpTool | undefined): string[] {
  const properties = (tool?.inputSchema as { properties?: Json } | undefined)?.properties;
  return properties ? Object.keys(properties) : [];
}

function pick(names: readonly string[], pattern: RegExp, fallback: string): string {
  return names.find((name) => pattern.test(name)) ?? fallback;
}

/** Depth-first search for the first value under any of `keys`. */
export function findValue(value: unknown, keys: readonly string[], depth = 0): unknown {
  if (!value || typeof value !== "object" || depth > 6) return undefined;
  for (const key of keys) if (key in (value as Json) && (value as Json)[key] != null) return (value as Json)[key];
  for (const child of Object.values(value as Json)) {
    const found = findValue(child, keys, depth + 1);
    if (found !== undefined) return found;
  }
  return undefined;
}

/** Collects tables from common result shapes (columns+rows, schema+data_array, statement_response). */
export function findTables(value: unknown, depth = 0, out: ResultSet[] = []): ResultSet[] {
  if (!value || typeof value !== "object" || depth > 7) return out;
  const object = value as Json;
  const statement = (object.statement_response ?? object) as Json;
  const manifest = statement.manifest as { schema?: { columns?: { name: string; type_text?: string; type_name?: string }[] } } | undefined;
  const dataArray = (statement.result as { data_array?: unknown } | undefined)?.data_array ?? statement.data_array;
  if (manifest?.schema?.columns && Array.isArray(dataArray)) {
    out.push(resultSet(manifest.schema.columns.map((c) => ({ name: c.name, type: c.type_text ?? c.type_name ?? "" })), dataArray as (string | null)[][]));
    return out;
  }
  const columns = object.columns;
  const rows = object.rows ?? object.data;
  if (Array.isArray(columns) && Array.isArray(rows) && columns.length) {
    const cols = columns.map((column) =>
      typeof column === "string" ? { name: column } : { name: String((column as Json).name ?? ""), type: String((column as Json).type ?? (column as Json).type_name ?? "") },
    );
    const asRows = (rows as unknown[]).map((row) =>
      Array.isArray(row)
        ? row.map((cell) => (cell == null ? null : String(cell)))
        : cols.map((column) => {
            const cell = (row as Json)[column.name];
            return cell == null ? null : String(cell);
          }),
    );
    out.push(resultSet(cols, asRows));
    return out;
  }
  for (const child of Object.values(object)) if (child && typeof child === "object") findTables(child, depth + 1, out);
  return out;
}

export class GenieOne {
  private clients = new Map<string, McpClient>();
  private availability = new Map<string, Promise<boolean>>();

  constructor(private readonly service: DatabricksService) {}

  private async mcp(): Promise<McpClient> {
    const client = await this.service.ready();
    const snapshot = this.service.snapshot();
    const workspaceId = snapshot.status === "connected" ? (snapshot.workspaceId ?? snapshot.profile.workspaceId) : undefined;
    const key = `${client.host}|${workspaceId ?? ""}`;
    let mcp = this.clients.get(key);
    if (!mcp) {
      mcp = new McpClient(client, gatewayMcpPath(GENIE_ONE), workspaceId ? { o: workspaceId } : {});
      this.clients.set(key, mcp);
    }
    return mcp;
  }

  /** Whether Genie One answers in this workspace for this user. */
  available(): Promise<boolean> {
    const snapshot = this.service.snapshot();
    const key = snapshot.status === "connected" ? snapshot.profile.host : "none";
    let check = this.availability.get(key);
    if (!check) {
      check = this.mcp()
        .then((mcp) => mcp.listTools())
        .then((tools) => tools.some((tool) => tool.name === "genie_ask"))
        .catch(() => false);
      this.availability.set(key, check);
    }
    return check;
  }

  async ask(
    question: string,
    options: Readonly<{ conversationId?: string; signal?: AbortSignal; onProgress?(steps: readonly string[]): void }> = {},
  ): Promise<GenieOneAnswer> {
    const mcp = await this.mcp();
    const tools = await mcp.listTools(options.signal);
    const byName = new Map(tools.map((tool) => [tool.name, tool]));
    if (!byName.has("genie_ask")) throw new Error("Genie One isn't available in this workspace (no genie_ask tool).");
    const askNames = propertyNames(byName.get("genie_ask"));
    const askArgs: Json = { [pick(askNames, /question|query|prompt|content|message|text/i, "question")]: question };
    if (options.conversationId) askArgs[pick(askNames, /conversation/i, "conversation_id")] = options.conversationId;
    const warehouseId = this.service.preferences.get<string>("warehouseId");
    const asked = await mcp.callTool("genie_ask", askArgs, {
      ...(options.signal && { signal: options.signal }),
      ...(warehouseId && { meta: { warehouse_id: warehouseId } }),
      timeoutMs: 170_000,
    });
    if (asked.isError) throw new Error(resultText(asked) || "Genie One refused the question.");
    let latest: unknown = resultJson(asked) ?? {};
    const conversationId = String(findValue(latest, ["conversation_id", "conversationId"]) ?? options.conversationId ?? "");
    const responseId = String(findValue(latest, ["response_id", "responseId", "message_id"]) ?? "");
    let status = String(findValue(latest, ["status", "state"]) ?? "");
    const texts: string[] = [];
    const firstText = resultText(asked);
    const steps: string[] = [];
    const deadline = Date.now() + 10 * 60_000;
    const pollNames = propertyNames(byName.get("genie_poll_response"));
    while (!DONE.test(status) && byName.has("genie_poll_response") && responseId) {
      if (Date.now() > deadline) throw new Error("Genie One did not finish within 10 minutes.");
      options.signal?.throwIfAborted();
      const pollArgs: Json = {
        [pick(pollNames, /conversation/i, "conversation_id")]: conversationId,
        [pick(pollNames, /response|message/i, "response_id")]: responseId,
      };
      const polled = await mcp.callTool("genie_poll_response", pollArgs, { ...(options.signal && { signal: options.signal }), timeoutMs: 170_000 });
      if (polled.isError) throw new Error(resultText(polled) || "Genie One failed.");
      latest = resultJson(polled) ?? { text: resultText(polled) };
      status = String(findValue(latest, ["status", "state"]) ?? "completed");
      const progress = findValue(latest, ["progress", "steps", "progress_steps"]);
      if (Array.isArray(progress)) {
        steps.splice(0, steps.length, ...progress.map((step) => (typeof step === "string" ? step : String((step as Json).title ?? (step as Json).description ?? (step as Json).name ?? ""))).filter(Boolean));
        options.onProgress?.(steps);
      }
      if (!DONE.test(status)) await new Promise((resolve) => setTimeout(resolve, 1500));
    }
    if (FAILED.test(status)) {
      const message = findValue(latest, ["error", "error_message", "message"]);
      throw new Error(typeof message === "string" ? message : "Genie One could not answer.");
    }
    const answer = findValue(latest, ["answer", "final_answer", "text", "content", "response"]);
    if (typeof answer === "string") texts.push(answer);
    else if (firstText && !firstText.trim().startsWith("{")) texts.push(firstText);
    const results = findTables(latest);
    // Fetch full results for any query attachments the answer references.
    if (!results.length && byName.has("genie_get_query_result")) {
      const resultNames = propertyNames(byName.get("genie_get_query_result"));
      const queryRef = findValue(latest, ["query_result_id", "attachment_id", "statement_id", "query_id"]);
      if (queryRef !== undefined) {
        const args: Json = {
          [pick(resultNames, /conversation/i, "conversation_id")]: conversationId,
          [pick(resultNames, /response|message/i, "response_id")]: responseId,
        };
        const refName = resultNames.find((name) => /attachment|statement|query/i.test(name));
        if (refName) args[refName] = queryRef;
        const fetched = await mcp.callTool("genie_get_query_result", args, options.signal ? { signal: options.signal } : {}).catch(() => undefined);
        if (fetched && !fetched.isError) results.push(...findTables(resultJson(fetched) ?? {}));
      }
    }
    const links = new Set<string>();
    const sql = new Set<string>();
    const walk = (value: unknown, depth = 0) => {
      if (!value || depth > 7) return;
      if (typeof value === "string") {
        if (/^https:\/\/\S+$/.test(value)) links.add(value);
        return;
      }
      if (typeof value !== "object") return;
      for (const [key, child] of Object.entries(value as Json)) {
        if (/^(sql|query|query_text|statement)$/i.test(key) && typeof child === "string" && /\bselect\b/i.test(child)) sql.add(child);
        walk(child, depth + 1);
      }
    };
    walk(latest);
    return {
      ...(conversationId && { conversationId }),
      ...(responseId && { responseId }),
      status: status || "completed",
      text: texts.join("\n\n").trim(),
      steps,
      results,
      links: [...links],
      sql: [...sql],
    };
  }

  format(answer: GenieOneAnswer): string {
    const lines = ["Genie One", answer.conversationId ? `conversation_id: ${answer.conversationId}` : ""].filter(Boolean);
    if (answer.text) lines.push("", answer.text);
    for (const result of answer.results) lines.push("", toMarkdown(result, 20));
    for (const statement of answer.sql.slice(0, 2)) lines.push("", "```sql", statement.trim(), "```");
    if (answer.links.length) lines.push("", `Sources: ${answer.links.slice(0, 5).join(" ")}`);
    return lines.join("\n");
  }
}
