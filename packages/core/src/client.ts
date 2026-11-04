// A Databricks REST client over a Transport and a token source. It retries
// once with a forced refresh on 401, backs off on 429/503 for idempotent
// calls, and turns Databricks error bodies into DatabricksApiError.
import type { HttpMethod, HttpResponse, Transport } from "./curl";
import { SseParser, type SseEvent } from "./sse";

export const USER_AGENT = "databricks-buzz-plugins/0.1.0";

export type TokenSource = (
  options?: Readonly<{ force?: boolean }>,
) => Promise<string>;

export type RequestInit = Readonly<{
  method?: HttpMethod;
  query?: Readonly<Record<string, string | number | boolean | undefined>>;
  /** JSON-encoded unless it is already a string. */
  body?: unknown;
  headers?: Readonly<Record<string, string>>;
  timeoutMs?: number;
  signal?: AbortSignal;
}>;

export class DatabricksApiError extends Error {
  constructor(
    readonly status: number,
    readonly errorCode: string | undefined,
    message: string,
    readonly body: string,
  ) {
    super(message);
    this.name = "DatabricksApiError";
  }
  get isPermission() {
    return this.status === 403 || this.errorCode === "PERMISSION_DENIED";
  }
  get isNotFound() {
    return (
      this.status === 404 ||
      this.errorCode === "RESOURCE_DOES_NOT_EXIST" ||
      this.errorCode === "NOT_FOUND"
    );
  }
  get isFeatureDisabled() {
    return (
      this.errorCode === "FEATURE_DISABLED" ||
      this.errorCode === "NOT_IMPLEMENTED" ||
      /not enabled|feature.*disabled|preview/i.test(this.message)
    );
  }
}

export function apiError(response: HttpResponse): DatabricksApiError {
  let code: string | undefined;
  let message = `Databricks returned HTTP ${response.status}`;
  try {
    const parsed = JSON.parse(response.body) as {
      error_code?: string;
      message?: string;
      error?: string | { message?: string; code?: string };
      error_description?: string;
    };
    code =
      parsed.error_code ??
      (typeof parsed.error === "object" ? parsed.error?.code : undefined);
    message =
      parsed.message ??
      (typeof parsed.error === "object" ? parsed.error?.message : parsed.error) ??
      parsed.error_description ??
      message;
  } catch {
    const text = response.body.trim();
    if (text && text.length < 400 && !text.startsWith("<")) message = text;
  }
  return new DatabricksApiError(response.status, code, message, response.body);
}

const IDEMPOTENT = new Set<HttpMethod>(["GET", "HEAD", "PUT", "DELETE"]);
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

export type ClientOptions = Readonly<{
  host: string;
  workspaceId?: string;
  transport: Transport;
  token: TokenSource;
  userAgent?: string;
}>;

export class DatabricksClient {
  readonly host: string;
  readonly workspaceId: string | undefined;
  constructor(private readonly options: ClientOptions) {
    this.host = options.host.replace(/\/+$/, "");
    this.workspaceId = options.workspaceId;
  }

  url(path: string, query?: RequestInit["query"]): string {
    const url = new URL(
      /^https:\/\//.test(path) ? path : `${this.host}${path.startsWith("/") ? "" : "/"}${path}`,
    );
    for (const [key, value] of Object.entries(query ?? {}))
      if (value !== undefined) url.searchParams.set(key, String(value));
    return url.toString();
  }

  /** Raw request; never throws for HTTP status. */
  async request(
    path: string,
    init: RequestInit = {},
    onBody?: (chunk: string) => void,
  ): Promise<HttpResponse> {
    const method = init.method ?? (init.body === undefined ? "GET" : "POST");
    const body =
      init.body === undefined
        ? undefined
        : typeof init.body === "string"
          ? init.body
          : JSON.stringify(init.body);
    const send = async (force: boolean) => {
      const token = await this.options.token({ force });
      return this.options.transport({
        url: this.url(path, init.query),
        method,
        headers: {
          Authorization: `Bearer ${token}`,
          "User-Agent": this.options.userAgent ?? USER_AGENT,
          Accept: "application/json",
          ...(body !== undefined && { "Content-Type": "application/json" }),
          ...(this.workspaceId && {
            "X-Databricks-Workspace-Id": this.workspaceId,
          }),
          ...init.headers,
        },
        ...(body !== undefined && { body }),
        ...(init.timeoutMs !== undefined && { timeoutMs: init.timeoutMs }),
        ...(init.signal && { signal: init.signal }),
        ...(onBody && { onBody }),
      });
    };
    let response = await send(false);
    if (response.status === 401) response = await send(true);
    for (
      let attempt = 0;
      attempt < 3 &&
      (response.status === 429 || response.status === 503) &&
      IDEMPOTENT.has(method) &&
      !onBody;
      attempt++
    ) {
      const retryAfter = Number(response.headers["retry-after"]);
      await sleep(
        Number.isFinite(retryAfter) && retryAfter > 0
          ? Math.min(retryAfter * 1000, 20_000)
          : 500 * 2 ** attempt + Math.random() * 250,
        init.signal,
      );
      response = await send(false);
    }
    return response;
  }

  async json<T = unknown>(path: string, init: RequestInit = {}): Promise<T> {
    const response = await this.request(path, init);
    if (response.status < 200 || response.status >= 300) throw apiError(response);
    if (!response.body.trim()) return {} as T;
    return JSON.parse(response.body) as T;
  }

  get<T = unknown>(path: string, init: Omit<RequestInit, "method" | "body"> = {}) {
    return this.json<T>(path, { ...init, method: "GET" });
  }
  post<T = unknown>(path: string, body?: unknown, init: Omit<RequestInit, "method" | "body"> = {}) {
    return this.json<T>(path, { ...init, method: "POST", body: body ?? {} });
  }

  /** Streams an SSE response. Resolves with the final HTTP response. */
  async stream(
    path: string,
    init: RequestInit,
    onEvent: (event: SseEvent) => void,
  ): Promise<HttpResponse> {
    const parser = new SseParser(onEvent);
    let ok = true;
    const response = await this.request(
      path,
      {
        ...init,
        headers: { Accept: "text/event-stream", ...init.headers },
      },
      (chunk) => {
        if (ok) parser.push(chunk);
      },
    );
    if (response.status < 200 || response.status >= 300) {
      ok = false;
      throw apiError(response);
    }
    parser.end();
    return response;
  }
}
