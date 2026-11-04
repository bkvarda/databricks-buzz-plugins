// Genie One through its managed MCP server on Unity Gateway:
//   /ai-gateway/mcp-services/system.ai.genie_one_mcp?o=<workspace-id>
//
// Polling flow, as the server documents it:
//   genie_ask {question, conversation_id?}          → {conversation_id, response_id, status: "in_progress"}
//   genie_poll_response {conversation_id, response_id} every 2–5 s
//                                                   → {status, final_answer, progress_steps, query_items, deep_link}
//   genie_get_query_result {conversation_id, response_id, item_id}
//                                                   → {ready, columns[{name, type_text}], rows, total_row_count, truncated}
//   genie_cancel_response {conversation_id}         (best effort)
// Results come back in `structuredContent`; the text content carries the same
// answer as Markdown for models.
import { gatewayMcpPath, McpClient, resultJson, resultText } from "@dbx/core/api/mcp";
import { resultBlock, resultSet, type ResultSet, toMarkdown } from "@dbx/core/result";
import type { DatabricksService } from "@dbx/core/service";

export const GENIE_ONE = "system.ai.genie_one_mcp";

type Status = "in_progress" | "completed" | "incomplete" | "failed" | "unknown";

type AskResult = Readonly<{ conversation_id?: string; response_id?: string; status?: Status }>;

export type PollResult = Readonly<{
  conversation_id?: string;
  response_id?: string;
  status?: Status;
  deep_link?: string | null;
  final_answer?: string | null;
  progress_steps?: readonly string[] | null;
  query_items?: readonly { item_id: string; sql?: string | null }[] | null;
}>;

export type QueryResult = Readonly<{
  ready?: boolean;
  statement_state?: string;
  columns?: readonly { name: string; type_text?: string | null }[];
  rows?: readonly (readonly unknown[])[];
  total_row_count?: number | null;
  truncated?: boolean;
}>;

export type GenieOneAnswer = Readonly<{
  conversationId: string;
  responseId: string;
  status: Status;
  /** Genie's final answer text. */
  text: string;
  /** The server's Markdown rendering (answer, tables, links), for models. */
  markdown: string;
  steps: readonly string[];
  results: readonly ResultSet[];
  sql: readonly string[];
  deepLink?: string;
}>;

const POLL_MS = 3000;
const MAX_RESULTS = 3;

const cell = (value: unknown): string | null =>
  value === null || value === undefined ? null : typeof value === "object" ? JSON.stringify(value) : String(value);

/** A Genie One query result as a ResultSet. */
export function toResultSet(result: QueryResult): ResultSet | undefined {
  if (!result.ready || !result.columns?.length) return undefined;
  const rows = (result.rows ?? []).map((row) => row.map(cell));
  const total = result.total_row_count ?? undefined;
  return resultSet(
    result.columns.map((column) => ({ name: column.name, ...(column.type_text && { type: column.type_text }) })),
    rows,
    {
      ...(total !== undefined && { totalRows: total }),
      truncated: Boolean(result.truncated) || (total !== undefined && total > rows.length),
    },
  );
}

/** Drops the server's HTML comments (notes addressed to its own tool flow). */
export const stripComments = (markdown: string) =>
  markdown
    .replace(/<!--[\s\S]*?--\s*>/g, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

/**
 * Genie One's answer text, made Buzz-native: no comments, no `:citation[…]`
 * directives, no links that only point at an embedded result.
 */
export function cleanAnswer(text: string): string {
  return stripComments(text)
    .replace(/\s*:citation\[[^\]]*\]/g, "")
    .replace(/\s*\[Query Result\]\([^)\s]*#embed-[^)\s]*\)/g, "")
    // Citations of the space's instructions point nowhere a reader can open.
    .replace(/\s*\[Knowledge snippets?\]\([^)]*\)/gi, "")
    .replace(/([.!?)])[ \t]+Knowledge snippets?(?=[ \t]*(\n|$))/gi, "$1")
    // "`samples.nyctaxi.trips` [samples.nyctaxi.trips](…)" reads as one link.
    .replace(/`([^`]+)`\s*\[\1\]\(/g, "[$1](")
    .replace(/[ \t]+$/gm, "")
    .trim();
}

/** Shortens Markdown tables to `maxRows` body rows, for chat messages. */
export function trimTables(markdown: string, maxRows = 12): string {
  const lines = markdown.split("\n");
  const out: string[] = [];
  const row = /^\s*\|.*\|\s*$/;
  for (let i = 0; i < lines.length; i++) {
    if (row.test(lines[i] ?? "") && /^\s*\|?\s*:?-{2,}/.test(lines[i + 1] ?? "")) {
      out.push(lines[i] ?? "", lines[i + 1] ?? "");
      let body = 0;
      i += 2;
      for (; i < lines.length && row.test(lines[i] ?? ""); i++, body++) if (body < maxRows) out.push(lines[i] ?? "");
      if (body > maxRows) out.push("", `_${body - maxRows} more rows in Databricks._`);
      i--;
      continue;
    }
    out.push(lines[i] ?? "");
  }
  return out.join("\n");
}

/**
 * Genie One can't draw charts over MCP and says so; Buzz draws them, so those
 * sentences go when a chart is shown.
 */
export function withoutChartCaveats(markdown: string): string {
  const visual = String.raw`(?:charts?|graphs?|plots?|visuali[sz]ations?)`;
  // A match runs from the previous sentence's end; keep the space before it.
  const lead = (match: string) => /^[ \t]*/.exec(match)?.[0] ?? "";
  return markdown
    .replace(new RegExp(String.raw`[^.!?\n]*\b(?:can(?:'|’)?t|cannot|can not|unable to|not able to)\b[^.!?\n]*\b${visual}\b[^.!?\n]*[.!?][ \t]*`, "gi"), lead)
    .replace(new RegExp(String.raw`[^.!?\n]*\b(?:to (?:turn|make|build|create) (?:this|it|these|the results?) into an? ${visual}|you can (?:chart|plot|graph) (?:this|it|them|directly))\b[^.!?\n]*[.!?][ \t]*`, "gi"), lead)
    .replace(/[ \t]+$/gm, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

const cells = (line: string) =>
  line
    .trim()
    .replace(/^\|/, "")
    .replace(/\|$/, "")
    .split("|")
    .map((cell) => cell.replace(/\*\*|__|`/g, "").trim());

const key = (name: string) => name.toLowerCase().replace(/[^a-z0-9]/g, "");

/**
 * The answer as a chat message: each Markdown table becomes a result block in
 * place (Genie One's typed rows when they match), so Buzz draws it as a chart.
 * With no table in the text, the last result with more than one row follows it.
 */
export function answerMarkdown(answer: Pick<GenieOneAnswer, "text" | "results">, maxRows = 200): string {
  const lines = cleanAnswer(answer.text).split("\n");
  const unused = [...answer.results];
  const take = (header: readonly string[], rowCount: number) => {
    const names = header.map(key).join("|");
    let index = unused.findIndex((result) => result.columns.map((column) => key(column.name)).join("|") === names);
    if (index < 0) index = unused.findIndex((result) => result.columns.length === header.length && result.rows.length === rowCount);
    return index < 0 ? undefined : unused.splice(index, 1)[0];
  };
  const out: string[] = [];
  let blocks = 0;
  const row = /^\s*\|.*\|\s*$/;
  for (let i = 0; i < lines.length; i++) {
    if (row.test(lines[i] ?? "") && /^\s*\|?\s*:?-{2,}/.test(lines[i + 1] ?? "")) {
      const header = cells(lines[i] ?? "");
      const body: (string | null)[][] = [];
      for (i += 2; i < lines.length && row.test(lines[i] ?? ""); i++) body.push(cells(lines[i] ?? "").map((cell) => cell || null));
      i--;
      const result = take(header, body.length) ?? resultSet(header.map((name) => ({ name })), body);
      out.push("", resultBlock(result, maxRows), "");
      blocks++;
      continue;
    }
    out.push(lines[i] ?? "");
  }
  let text = out.join("\n").replace(/\n{3,}/g, "\n\n").trim();
  if (!blocks) {
    const last = answer.results[answer.results.length - 1];
    if (last?.columns.length && (last.rows.length > 1 || !text)) {
      text = [text, resultBlock(last, maxRows)].filter(Boolean).join("\n\n");
      blocks++;
    }
  }
  return blocks ? withoutChartCaveats(text) : text;
}

const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        reject(signal.reason);
      },
      { once: true },
    );
  });

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
        .catch(() => false)
        .then((ok) => {
          // Don't remember a failure; the next look tries again.
          if (!ok) this.availability.delete(key);
          return ok;
        });
      this.availability.set(key, check);
    }
    return check;
  }

  async ask(
    question: string,
    options: Readonly<{ conversationId?: string; signal?: AbortSignal; onProgress?(steps: readonly string[]): void }> = {},
  ): Promise<GenieOneAnswer> {
    const { signal } = options;
    const mcp = await this.mcp();
    const asked = await mcp.callTool(
      "genie_ask",
      { question, ...(options.conversationId && { conversation_id: options.conversationId }) },
      { ...(signal && { signal }), timeoutMs: 170_000 },
    );
    if (asked.isError) throw new Error(resultText(asked) || "Genie One couldn't take the question.");
    const started = resultJson<AskResult & PollResult>(asked) ?? {};
    const conversationId = started.conversation_id ?? options.conversationId ?? "";
    const responseId = started.response_id ?? "";
    if (!conversationId || !responseId) throw new Error("Genie One didn't return a conversation.");

    let state: PollResult = started;
    let markdown = resultText(asked);
    let unknowns = 0;
    // The server clears progress_steps once the response is done; keep the last ones.
    let steps: readonly string[] = [];
    const deadline = Date.now() + 10 * 60_000;
    try {
      while (!state.status || state.status === "in_progress" || (state.status === "unknown" && unknowns < 5)) {
        if (Date.now() > deadline) throw new Error("Genie One didn't finish within 10 minutes.");
        await sleep(POLL_MS, signal);
        const polled = await mcp.callTool(
          "genie_poll_response",
          { conversation_id: conversationId, response_id: responseId },
          { ...(signal && { signal }), timeoutMs: 60_000 },
        );
        if (polled.isError) throw new Error(resultText(polled) || "Genie One failed.");
        state = resultJson<PollResult>(polled) ?? { status: "unknown" };
        markdown = resultText(polled);
        unknowns = state.status === "unknown" ? unknowns + 1 : 0;
        if (state.progress_steps?.length) {
          steps = state.progress_steps;
          options.onProgress?.(steps);
        }
      }
    } catch (error) {
      if (signal?.aborted)
        void mcp.callTool("genie_cancel_response", { conversation_id: conversationId }).catch(() => undefined);
      throw error;
    }
    if (state.status === "failed") throw new Error(markdown.trim() || "Genie One couldn't answer that.");

    const items = (state.query_items ?? []).slice(0, MAX_RESULTS);
    const results = (
      await Promise.all(
        items.map((item) =>
          mcp
            .callTool(
              "genie_get_query_result",
              { conversation_id: conversationId, response_id: responseId, item_id: item.item_id },
              { ...(signal && { signal }), timeoutMs: 60_000 },
            )
            .then((fetched) => (fetched.isError ? undefined : toResultSet(resultJson<QueryResult>(fetched) ?? {})))
            .catch(() => undefined),
        ),
      )
    ).filter((result): result is ResultSet => result !== undefined);

    return {
      conversationId,
      responseId,
      status: state.status ?? "completed",
      text: (state.final_answer ?? "").trim(),
      markdown: markdown.trim(),
      steps,
      results,
      sql: items.flatMap((item) => (item.sql ? [item.sql] : [])),
      ...(state.deep_link && { deepLink: state.deep_link }),
    };
  }

  /** Plain text for agents: the answer (with its tables and links), the SQL and the deep link. */
  format(answer: GenieOneAnswer): string {
    const lines = ["Genie One", `conversation_id: ${answer.conversationId}`];
    if (answer.status === "incomplete") lines.push("(Genie One stopped before finishing; the answer may be partial.)");
    const text = cleanAnswer(answer.text);
    if (text) lines.push("", text);
    else for (const result of answer.results) lines.push("", toMarkdown(result, 20));
    for (const statement of answer.sql.slice(0, 2)) lines.push("", "SQL Genie One ran:", "```sql", statement.trim(), "```");
    if (answer.deepLink) lines.push("", `[Explore in Databricks](${answer.deepLink})`);
    return lines.join("\n");
  }
}
