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
import { type DatabricksService, describeError, isApiError } from "@dbx/core/service";

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
    // Stopped already (say, while being told about this wait): don't wait at all.
    if (signal?.aborted) {
      reject(signal.reason);
      return;
    }
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

/**
 * How long to wait before each retry while Databricks rate-limits Genie One,
 * about half a minute in all: enough to ride out a short burst, not so long
 * that the person is left wondering. Each wait varies by ±20%.
 */
export const RATE_LIMIT_WAITS_MS: readonly number[] = [2_000, 4_000, 8_000, 15_000];

const RATE_LIMITED = /REQUEST_LIMIT_EXCEEDED|TOO_MANY_REQUESTS|rate[- ]?limit/i;

/** True for a rate-limit refusal: an HTTP 429, or the error text Genie One and the gateway use. */
export function isRateLimited(error: unknown): boolean {
  if (isApiError(error) && (error.status === 429 || error.errorCode === "REQUEST_LIMIT_EXCEEDED" || error.errorCode === "TOO_MANY_REQUESTS")) return true;
  return error instanceof Error && RATE_LIMITED.test(error.message);
}

/** Told before each wait: which retry is next, how long until it, and what Databricks said. */
export type RetryNotice = Readonly<{
  attempt: number;
  waitMs: number;
  reason: string;
  /** True when the question is asked again (its earlier answer failed), so progress starts over. */
  restarted: boolean;
}>;

/** A wait as a progress line: "Rate-limited by Databricks: trying again in 4 s". */
export const retryLine = (notice: RetryNotice) =>
  `Rate-limited by Databricks: ${notice.restarted ? "asking again" : "trying again"} in ${Math.max(1, Math.round(notice.waitMs / 1000))} s`;

/** A rate-limited Genie One call, failed after its retries, or a response that failed because of one. */
class RateLimited extends Error {
  constructor(
    message: string,
    readonly conversationId?: string,
  ) {
    super(message);
    this.name = "RateLimited";
  }
}

/** A short pause that varies a little, so retries from several agents don't line up. */
const jittered = (ms: number) => Math.round(ms * (0.8 + Math.random() * 0.4));

/**
 * Runs `run` again after each of RATE_LIMIT_WAITS_MS while it's rate-limited;
 * any other failure, a Stop, or the last refusal goes to the caller.
 */
async function withBackoff<T>(
  run: () => Promise<T>,
  options: Readonly<{ signal?: AbortSignal; retryable?(error: unknown): boolean; onRetry?(notice: Omit<RetryNotice, "restarted">): void }>,
): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await run();
    } catch (error) {
      const wait = RATE_LIMIT_WAITS_MS[attempt];
      if (wait === undefined || options.signal?.aborted || !(options.retryable ?? isRateLimited)(error)) throw error;
      const waitMs = jittered(wait);
      options.onRetry?.({ attempt: attempt + 1, waitMs, reason: error instanceof Error ? error.message : String(error) });
      await sleep(waitMs, options.signal);
    }
  }
}

/** What a Genie One check found: ready, or why not, in words for the person. */
export type GenieOneCheck = Readonly<{ ok: true }> | Readonly<{ ok: false; reason: string; busy?: boolean }>;

/** How long a check waits for Genie One's tool list before saying so. */
export const CHECK_TIMEOUT_MS = 20_000;

class CheckTimeout extends Error {}

/** Why Genie One can't be used, from what the check ran into. */
export function checkFailure(error: unknown): string {
  if (error instanceof CheckTimeout) return `Genie One didn't answer within ${CHECK_TIMEOUT_MS / 1000} seconds.`;
  if (isRateLimited(error)) return "Databricks is rate-limiting Genie One for your organization right now. Try again in a minute.";
  if (isApiError(error) && error.isNotFound) return `Genie One isn't set up in this workspace. ${error.message}`;
  return describeError(error);
}

export class GenieOne {
  private clients = new Map<string, McpClient>();
  private checks = new Map<string, Promise<GenieOneCheck>>();
  private revision = 0;
  private listeners = new Set<() => void>();

  constructor(private readonly service: DatabricksService) {}

  /** Changes when the person asks to check again, so every view rechecks. */
  checkRevision = () => this.revision;
  subscribeChecks = (listener: () => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

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

  private checkKey() {
    const snapshot = this.service.snapshot();
    return snapshot.status === "connected" ? snapshot.profile.host : "none";
  }

  /**
   * Whether Genie One answers in this workspace for this person, and if not,
   * why. Views share one check per workspace; a failure isn't remembered, so
   * the next look (or `recheck`) tries again.
   */
  check(): Promise<GenieOneCheck> {
    const key = this.checkKey();
    let check = this.checks.get(key);
    if (!check) {
      check = this.listWithin(CHECK_TIMEOUT_MS)
        .then((tools): GenieOneCheck =>
          tools.some((tool) => tool.name === "genie_ask")
            ? { ok: true }
            : { ok: false, reason: "Genie One answered, but without its question tool (genie_ask)." },
        )
        .catch((error: unknown): GenieOneCheck => ({ ok: false, reason: checkFailure(error), ...(isRateLimited(error) && { busy: true }) }))
        .then((result) => {
          if (!result.ok && this.checks.get(key) === check) this.checks.delete(key);
          return result;
        });
      this.checks.set(key, check);
    }
    return check;
  }

  /** Whether Genie One answers in this workspace for this person. */
  async available(): Promise<boolean> {
    return (await this.check()).ok;
  }

  /**
   * Forgets this workspace's check, and its MCP client with the tool list it
   * caches, so the next check really asks Genie One again; every view rechecks.
   */
  recheck() {
    const host = this.checkKey();
    this.checks.delete(host);
    for (const key of [...this.clients.keys()]) if (key.startsWith(`${host}|`)) this.clients.delete(key);
    this.revision++;
    for (const listener of [...this.listeners]) listener();
  }

  /**
   * Genie One's tools, retrying while rate-limited, or a CheckTimeout after
   * `ms` even if the request itself doesn't stop. A rate limit that outlasts
   * the deadline reports as one, not as a timeout.
   */
  private async listWithin(ms: number) {
    const controller = new AbortController();
    let limited: unknown;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        reject(limited ?? new CheckTimeout());
      }, ms);
    });
    const list = this.mcp().then((mcp) =>
      withBackoff(() => mcp.listTools(controller.signal), {
        signal: controller.signal,
        onRetry: (notice) => {
          limited = new RateLimited(notice.reason);
        },
      }),
    );
    try {
      return await Promise.race([list, timeout]);
    } finally {
      clearTimeout(timer);
      list.catch(() => undefined);
    }
  }

  /**
   * One Genie One tool call, tried again while rate-limited, whether Databricks
   * refuses the request (HTTP 429) or Genie One answers with a rate-limit error.
   */
  private callTool(
    mcp: McpClient,
    name: string,
    args: Record<string, unknown>,
    options: Readonly<{ signal?: AbortSignal; timeoutMs: number; onRetry?(notice: RetryNotice): void }>,
  ) {
    const { signal, timeoutMs, onRetry } = options;
    return withBackoff(
      async () => {
        const result = await mcp.callTool(name, args, { ...(signal && { signal }), timeoutMs });
        const text = result.isError ? resultText(result) : "";
        if (text && RATE_LIMITED.test(text)) throw new RateLimited(text);
        return result;
      },
      { ...(signal && { signal }), ...(onRetry && { onRetry: (notice) => onRetry({ ...notice, restarted: false }) }) },
    );
  }

  /**
   * Asks Genie One and follows the answer to its end. While Databricks
   * rate-limits it, each call is tried again after a short wait (see
   * RATE_LIMIT_WAITS_MS), and an answer that failed because of a rate limit is
   * asked again in the same conversation. `onRetry` hears each wait.
   */
  async ask(
    question: string,
    options: Readonly<{
      conversationId?: string;
      signal?: AbortSignal;
      onProgress?(steps: readonly string[]): void;
      /** As soon as Genie One takes the question: the IDs that get its answer back later. */
      onStarted?(ids: Readonly<{ conversationId: string; responseId: string }>): void;
      onRetry?(notice: RetryNotice): void;
    }> = {},
  ): Promise<GenieOneAnswer> {
    let conversationId = options.conversationId;
    return withBackoff(
      async () => {
        try {
          return await this.askOnce(question, { ...options, ...(conversationId && { conversationId }) });
        } catch (error) {
          // Ask again where the failed answer was, so the conversation stays one.
          if (error instanceof RateLimited && error.conversationId) conversationId = error.conversationId;
          throw error;
        }
      },
      {
        ...(options.signal && { signal: options.signal }),
        // Only a failed answer is asked again here; refused calls were already retried.
        retryable: (error) => error instanceof RateLimited && error.conversationId !== undefined,
        ...(options.onRetry && { onRetry: (notice) => options.onRetry?.({ ...notice, restarted: true }) }),
      },
    );
  }

  private async askOnce(
    question: string,
    options: Parameters<GenieOne["ask"]>[1] & {},
  ): Promise<GenieOneAnswer> {
    const { signal, onRetry } = options;
    const mcp = await this.mcp();
    const asked = await this.callTool(
      mcp,
      "genie_ask",
      { question, ...(options.conversationId && { conversation_id: options.conversationId }) },
      { ...(signal && { signal }), timeoutMs: 170_000, ...(onRetry && { onRetry }) },
    );
    if (asked.isError) throw new Error(resultText(asked) || "Genie One couldn't take the question.");
    const started = resultJson<AskResult & PollResult>(asked) ?? {};
    const conversationId = started.conversation_id ?? options.conversationId ?? "";
    const responseId = started.response_id ?? "";
    if (!conversationId || !responseId) throw new Error("Genie One didn't return a conversation.");
    options.onStarted?.({ conversationId, responseId });
    return this.follow(mcp, conversationId, responseId, started, resultText(asked), options);
  }

  /**
   * An earlier response, by its IDs: Genie One keeps them, even after later
   * questions in the conversation. A response still running is followed to
   * its end.
   */
  async response(
    conversationId: string,
    responseId: string,
    options: Readonly<{ signal?: AbortSignal; onProgress?(steps: readonly string[]): void; onRetry?(notice: RetryNotice): void }> = {},
  ): Promise<GenieOneAnswer> {
    return this.follow(await this.mcp(), conversationId, responseId, {}, "", options);
  }

  private async follow(
    mcp: McpClient,
    conversationId: string,
    responseId: string,
    started: PollResult,
    startedMarkdown: string,
    options: Readonly<{ signal?: AbortSignal; onProgress?(steps: readonly string[]): void; onRetry?(notice: RetryNotice): void }>,
  ): Promise<GenieOneAnswer> {
    const { signal, onRetry } = options;
    const retry = { ...(signal && { signal }), ...(onRetry && { onRetry }) };
    let state: PollResult = started;
    let markdown = startedMarkdown;
    let unknowns = 0;
    // The server clears progress_steps once the response is done; keep the last ones.
    let steps: readonly string[] = [];
    const deadline = Date.now() + 10 * 60_000;
    try {
      while (!state.status || state.status === "in_progress" || (state.status === "unknown" && unknowns < 5)) {
        if (Date.now() > deadline) throw new Error("Genie One didn't finish within 10 minutes.");
        // A response looked up again is polled at once.
        if (state.status) await sleep(POLL_MS, signal);
        const polled = await this.callTool(
          mcp,
          "genie_poll_response",
          { conversation_id: conversationId, response_id: responseId },
          { ...retry, timeoutMs: 60_000 },
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
    if (state.status === "failed") {
      const reason = markdown.trim() || "Genie One couldn't answer that.";
      // A rate limit inside Genie One (Unity Catalog, say) fails the answer; ask() asks again.
      if (RATE_LIMITED.test(reason)) throw new RateLimited(reason, conversationId);
      throw new Error(reason);
    }

    const items = (state.query_items ?? []).slice(0, MAX_RESULTS);
    const results = (
      await Promise.all(
        items.map((item) =>
          this.callTool(
            mcp,
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
