// Genie Agents (formerly Genie spaces) Conversation API.
// https://docs.databricks.com/genie-agents/conversation-api
import type { DatabricksClient } from "../client";
import { fromStatement, type ResultSet } from "../result";

export type GenieSpace = Readonly<{
  space_id: string;
  title: string;
  description?: string;
  warehouse_id?: string;
}>;

export type GenieStatus =
  | "SUBMITTED"
  | "FETCHING_METADATA"
  | "FILTERING_CONTEXT"
  | "ASKING_AI"
  | "PENDING_WAREHOUSE"
  | "EXECUTING_QUERY"
  | "COMPLETED"
  | "FAILED"
  | "QUERY_RESULT_EXPIRED"
  | "CANCELLED";

export type GenieAttachment = Readonly<{
  attachment_id?: string;
  text?: { content?: string };
  query?: {
    query?: string;
    description?: string;
    title?: string;
    statement_id?: string;
    query_result_metadata?: { row_count?: number };
  };
  suggested_questions?: { questions?: readonly string[] };
}>;

export type GenieMessage = Readonly<{
  id?: string;
  message_id?: string;
  conversation_id: string;
  space_id?: string;
  content: string;
  status: GenieStatus;
  attachments?: readonly GenieAttachment[];
  error?: { error?: string; type?: string };
  created_timestamp?: number;
}>;

export const TERMINAL: ReadonlySet<GenieStatus> = new Set(["COMPLETED", "FAILED", "QUERY_RESULT_EXPIRED", "CANCELLED"]);

export const STATUS_LABEL: Record<GenieStatus, string> = {
  SUBMITTED: "Submitted",
  FETCHING_METADATA: "Reading the data model",
  FILTERING_CONTEXT: "Choosing relevant tables",
  ASKING_AI: "Writing a query",
  PENDING_WAREHOUSE: "Waiting for the SQL warehouse",
  EXECUTING_QUERY: "Running the query",
  COMPLETED: "Done",
  FAILED: "Failed",
  QUERY_RESULT_EXPIRED: "Result expired",
  CANCELLED: "Cancelled",
};

export const messageId = (message: GenieMessage) => message.message_id ?? message.id ?? "";

/** The parts of a finished message an answer is built from. */
export function summarize(message: GenieMessage) {
  const attachments = message.attachments ?? [];
  const text = attachments
    .map((attachment) => attachment.text?.content)
    .filter((value): value is string => Boolean(value))
    .join("\n\n");
  const query = attachments.find((attachment) => attachment.query?.query);
  const suggestions = attachments.flatMap((attachment) => attachment.suggested_questions?.questions ?? []);
  return {
    text,
    sql: query?.query?.query,
    queryTitle: query?.query?.title,
    queryDescription: query?.query?.description,
    queryAttachmentId: query?.attachment_id,
    rowCount: query?.query?.query_result_metadata?.row_count,
    suggestions,
    error: message.error?.error,
  };
}

const base = (spaceId: string) => `/api/2.0/genie/spaces/${encodeURIComponent(spaceId)}`;

export class Genie {
  constructor(private readonly client: DatabricksClient) {}

  async listSpaces(signal?: AbortSignal): Promise<GenieSpace[]> {
    const spaces: GenieSpace[] = [];
    let pageToken: string | undefined;
    for (let page = 0; page < 20; page++) {
      const response = await this.client.get<{ spaces?: GenieSpace[]; next_page_token?: string }>(
        "/api/2.0/genie/spaces",
        { query: { page_size: 100, page_token: pageToken }, ...(signal && { signal }) },
      );
      spaces.push(...(response.spaces ?? []));
      pageToken = response.next_page_token;
      if (!pageToken) break;
    }
    return spaces.sort((a, b) => a.title.localeCompare(b.title));
  }

  getSpace(spaceId: string, signal?: AbortSignal) {
    return this.client.get<GenieSpace>(base(spaceId), signal ? { signal } : {});
  }

  /** Starts a conversation (or continues one) and returns the new message. */
  async ask(
    spaceId: string,
    content: string,
    conversationId?: string,
    signal?: AbortSignal,
  ): Promise<GenieMessage> {
    if (conversationId) {
      const message = await this.client.post<GenieMessage>(
        `${base(spaceId)}/conversations/${encodeURIComponent(conversationId)}/messages`,
        { content },
        signal ? { signal } : {},
      );
      return { ...message, conversation_id: message.conversation_id ?? conversationId };
    }
    const started = await this.client.post<{
      conversation_id?: string;
      message_id?: string;
      message?: GenieMessage;
      conversation?: { id?: string };
    }>(`${base(spaceId)}/start-conversation`, { content }, signal ? { signal } : {});
    const conversation = started.conversation_id ?? started.conversation?.id ?? started.message?.conversation_id ?? "";
    return {
      content,
      status: "SUBMITTED",
      ...started.message,
      conversation_id: conversation,
      message_id: started.message_id ?? started.message?.message_id ?? started.message?.id ?? "",
    };
  }

  getMessage(spaceId: string, conversationId: string, id: string, signal?: AbortSignal) {
    return this.client.get<GenieMessage>(
      `${base(spaceId)}/conversations/${encodeURIComponent(conversationId)}/messages/${encodeURIComponent(id)}`,
      signal ? { signal } : {},
    );
  }

  /** Polls until the message settles: 1s, backing off to 5s, up to 10 min. */
  async wait(
    spaceId: string,
    message: GenieMessage,
    onUpdate?: (message: GenieMessage) => void,
    signal?: AbortSignal,
  ): Promise<GenieMessage> {
    let current = message;
    let delay = 1000;
    const deadline = Date.now() + 10 * 60_000;
    while (!TERMINAL.has(current.status)) {
      if (Date.now() > deadline) throw new Error("Genie did not answer within 10 minutes.");
      await new Promise((resolve) => setTimeout(resolve, delay));
      signal?.throwIfAborted();
      delay = Math.min(5000, Math.round(delay * 1.4));
      current = {
        ...(await this.getMessage(spaceId, current.conversation_id, messageId(current), signal)),
        conversation_id: current.conversation_id,
      };
      onUpdate?.(current);
    }
    return current;
  }

  /** The query attachment's result, re-running it when it expired. */
  async result(
    spaceId: string,
    message: GenieMessage,
    attachmentId: string,
    signal?: AbortSignal,
  ): Promise<ResultSet> {
    const path = `${base(spaceId)}/conversations/${encodeURIComponent(message.conversation_id)}/messages/${encodeURIComponent(
      messageId(message),
    )}/attachments/${encodeURIComponent(attachmentId)}`;
    type Response = { statement_response?: Parameters<typeof fromStatement>[0] };
    try {
      const response = await this.client.get<Response>(`${path}/query-result`, signal ? { signal } : {});
      if (response.statement_response?.result || response.statement_response?.manifest)
        return fromStatement(response.statement_response);
    } catch (error) {
      if ((error as { status?: number }).status !== 404 && (error as { status?: number }).status !== 400) throw error;
    }
    const rerun = await this.client.post<Response>(`${path}/execute-query`, {}, signal ? { signal } : {});
    return fromStatement(rerun.statement_response ?? {});
  }

  /** A full answer: waits, then fetches the query result when there is one. */
  async answer(
    spaceId: string,
    question: string,
    options: Readonly<{
      conversationId?: string;
      signal?: AbortSignal;
      onUpdate?: (message: GenieMessage) => void;
    }> = {},
  ) {
    const started = await this.ask(spaceId, question, options.conversationId, options.signal);
    options.onUpdate?.(started);
    const message = await this.wait(spaceId, started, options.onUpdate, options.signal);
    const parts = summarize(message);
    let result: ResultSet | undefined;
    if (message.status === "COMPLETED" && parts.queryAttachmentId)
      result = await this.result(spaceId, message, parts.queryAttachmentId, options.signal).catch(() => undefined);
    return { message, ...parts, result };
  }

  /** The Genie web URL for a conversation, for "Open in Databricks". */
  static webPath(spaceId: string, conversationId?: string) {
    return `/genie/rooms/${encodeURIComponent(spaceId)}${conversationId ? `/chats/${encodeURIComponent(conversationId)}` : ""}`;
  }
}

/** Recognizes Genie web URLs: /genie/rooms/<space>[/chats/<conversation>]. */
export function parseGenieUrl(url: string): { host: string; spaceId: string; conversationId?: string } | undefined {
  try {
    const parsed = new URL(url);
    const match = /^\/genie\/rooms\/([0-9a-f]{32}|[\w-]{8,})(?:\/chats\/([\w-]+))?/i.exec(parsed.pathname);
    if (!match?.[1]) return undefined;
    if (!/databricks|azuredatabricks/i.test(parsed.hostname)) return undefined;
    return { host: parsed.origin, spaceId: match[1], ...(match[2] && { conversationId: match[2] }) };
  } catch {
    return undefined;
  }
}
