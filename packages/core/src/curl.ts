// HTTPS transport through the system `curl`, declared in the manifest as
//   { "id": "curl", "program": "curl",
//     "args": ["--silent", "--show-error", "--no-buffer", "--include",
//              "--proto", "=https", "--config", "-"] }
//
// Why not `ctx.host.request`? Buzz only lets a plugin reach origins fixed in
// its manifest, and every Databricks customer has their own workspace URL.
// curl ships with macOS, Linux and Windows 10+, streams (needed for SSE), and
// reads its whole request, including the bearer token, from a config on stdin,
// so secrets never appear in process arguments.
import type { Host } from "@buzz/author";
import { DesktopOnlyError } from "./process";

export type HttpMethod = "GET" | "HEAD" | "POST" | "PUT" | "PATCH" | "DELETE";

export type HttpRequest = Readonly<{
  url: string;
  method?: HttpMethod;
  headers?: Readonly<Record<string, string>>;
  body?: string;
  /** Overall deadline; defaults to 60 seconds. */
  timeoutMs?: number;
  signal?: AbortSignal;
  /** Receives body text as it arrives, after the status and headers. */
  onBody?(chunk: string): void;
}>;

export type HttpResponse = Readonly<{
  status: number;
  headers: Readonly<Record<string, string>>;
  body: string;
}>;

export type Transport = (request: HttpRequest) => Promise<HttpResponse>;

export class TransportError extends Error {
  constructor(
    message: string,
    readonly code: number | null,
  ) {
    super(message);
    this.name = "TransportError";
  }
}

const DEFAULT_TIMEOUT_MS = 60_000;

/** Quotes a value for a curl config file. curl unescapes \\ \" \n \r \t \v. */
export function curlQuote(value: string): string {
  return `"${value
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/\n/g, "\\n")
    .replace(/\r/g, "\\r")
    .replace(/\t/g, "\\t")
    .replace(/\v/g, "\\v")}"`;
}

const HEADER_NAME = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;

export function curlConfig(request: HttpRequest): string {
  const url = new URL(request.url);
  if (url.protocol !== "https:")
    throw new TransportError("Only HTTPS URLs are allowed", null);
  if (url.username || url.password)
    throw new TransportError("URLs must not contain credentials", null);
  const lines = [
    `url = ${curlQuote(url.toString())}`,
    `request = ${curlQuote(request.method ?? (request.body === undefined ? "GET" : "POST"))}`,
    `max-time = ${Math.ceil((request.timeoutMs ?? DEFAULT_TIMEOUT_MS) / 1000)}`,
    `connect-timeout = 15`,
    // Suppress `Expect: 100-continue`, so one header block precedes the body.
    `header = "Expect:"`,
  ];
  for (const [name, value] of Object.entries(request.headers ?? {})) {
    if (!HEADER_NAME.test(name) || /[\r\n]/.test(value))
      throw new TransportError(`Invalid header ${name}`, null);
    lines.push(`header = ${curlQuote(`${name}: ${value}`)}`);
  }
  if (request.method === "HEAD") lines.push("head");
  if (request.body !== undefined) {
    // `data-binary` reads a file when its value starts with "@"; `data-raw`
    // never does. Both send the bytes unchanged.
    lines.push(`data-raw = ${curlQuote(request.body)}`);
  }
  return `${lines.join("\n")}\n`;
}

type HeadState = { status: number; headers: Record<string, string> };

/** Splits curl `--include` output into its final header block and the rest. */
export function splitHead(
  text: string,
): { head: HeadState; rest: string } | undefined {
  let remaining = text;
  for (;;) {
    const match = /\r?\n\r?\n/.exec(remaining);
    if (!match) return undefined;
    const block = remaining.slice(0, match.index);
    remaining = remaining.slice(match.index + match[0].length);
    const [statusLine = "", ...lines] = block.split(/\r?\n/);
    const status = Number(/^HTTP\/[\d.]+\s+(\d{3})/.exec(statusLine)?.[1]);
    if (!Number.isFinite(status)) return undefined;
    if (status >= 100 && status < 200) continue;
    const headers: Record<string, string> = {};
    for (const line of lines) {
      const colon = line.indexOf(":");
      if (colon <= 0) continue;
      headers[line.slice(0, colon).trim().toLowerCase()] = line
        .slice(colon + 1)
        .trim();
    }
    return { head: { status, headers }, rest: remaining };
  }
}

export function curlTransport(host: Host, processId = "curl"): Transport {
  return async (request) => {
    if (!host.spawn) throw new DesktopOnlyError();
    request.signal?.throwIfAborted();
    const config = curlConfig(request);
    let raw = "";
    let stderr = "";
    let head: HeadState | undefined;
    let body = "";
    const child = await host.spawn(processId, {
      onStdout(data) {
        if (head) {
          body += data;
          request.onBody?.(data);
          return;
        }
        raw += data;
        const split = splitHead(raw);
        if (!split) return;
        head = split.head;
        raw = "";
        if (split.rest) {
          body += split.rest;
          request.onBody?.(split.rest);
        }
      },
      onStderr(data) {
        stderr += data;
      },
    });
    const kill = () => void child.kill().catch(() => {});
    request.signal?.addEventListener("abort", kill, { once: true });
    try {
      await child.end(config);
      const code = await child.exited;
      request.signal?.throwIfAborted();
      if (!head) {
        const message =
          stderr.trim().replace(/^curl:\s*/, "") ||
          `curl exited with ${code ?? "a signal"}`;
        throw new TransportError(message, code);
      }
      return { status: head.status, headers: head.headers, body };
    } finally {
      request.signal?.removeEventListener("abort", kill);
    }
  };
}
