// Databricks from inside the Sandbox, as its owner: the Sandbox's own
// credential (its DEFAULT profile, which Databricks refreshes) over fetch,
// shaped like the suite's `databricks` service so the Genie code runs as is.
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { DatabricksClient } from "@dbx/core/client";
import type { HttpRequest, HttpResponse } from "@dbx/core/curl";
import type { DatabricksService } from "@dbx/core/service";

/** The DEFAULT profile's host and token; re-read so a refreshed token is picked up. */
function profile(): { host: string; token: string } {
  const text = readFileSync(join(homedir(), ".databrickscfg"), "utf8");
  let section = "";
  const values: Record<string, string> = {};
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    const header = /^\[(.+)\]$/.exec(line);
    if (header) {
      section = header[1]!;
      continue;
    }
    const pair = /^([a-z_]+)\s*=\s*(.*)$/.exec(line);
    if (pair && section === "DEFAULT") values[pair[1]!] = pair[2]!;
  }
  if (!values.host || !values.token) throw new Error("The Sandbox has no Databricks credential.");
  return { host: values.host.replace(/\/+$/, ""), token: values.token };
}

async function fetchTransport(request: HttpRequest): Promise<HttpResponse> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new DOMException("Timed out", "TimeoutError")), request.timeoutMs ?? 60_000);
  const stop = () => controller.abort(request.signal?.reason);
  request.signal?.addEventListener("abort", stop, { once: true });
  try {
    const response = await fetch(request.url, {
      method: request.method ?? "GET",
      ...(request.headers && { headers: request.headers }),
      ...(request.body !== undefined && { body: request.body }),
      signal: controller.signal,
    });
    const headers: Record<string, string> = {};
    response.headers.forEach((value, key) => (headers[key.toLowerCase()] = value));
    let body = "";
    if (response.body) {
      const decoder = new TextDecoder();
      const reader = response.body.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        const chunk = decoder.decode(value, { stream: true });
        body += chunk;
        request.onBody?.(chunk);
      }
      const tail = decoder.decode();
      if (tail) {
        body += tail;
        request.onBody?.(tail);
      }
    }
    return { status: response.status, headers, body };
  } finally {
    clearTimeout(timer);
    request.signal?.removeEventListener("abort", stop);
  }
}

/** The Sandbox's Databricks connection, as a `databricks` service for Genie. */
export function sandboxService(): DatabricksService {
  const { host } = profile();
  const client = new DatabricksClient({ host, transport: fetchTransport, token: async () => profile().token });
  const snapshot = {
    status: "connected" as const,
    profile: { name: "DEFAULT", host },
    user: { userName: "" },
    profiles: [],
  };
  const service = {
    version: 1 as const,
    snapshot: () => snapshot,
    subscribe: () => () => {},
    client: () => client,
    ready: async () => client,
    workspaceUrl: (path: string) => new URL(path, host).toString(),
    profiles: () => [],
    openSettings: () => {},
    signIn: async () => {},
    preferences: { get: () => undefined, set: () => {}, subscribe: () => () => {} },
  };
  return service as unknown as DatabricksService;
}
