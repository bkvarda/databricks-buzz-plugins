// The signals hub as the signed-in person: the plugin calls the hub app with
// their Databricks token (Databricks Apps signs them in and tells the hub who
// they are), and checks their sign-ins to the system.ai MCP services.
import { type DatabricksApp, Apps } from "@dbx/core/api/apps";
import { gatewayMcpPath } from "@dbx/core/api/mcp";
import type { DatabricksClient } from "@dbx/core/client";
import type { DatabricksService } from "@dbx/core/service";
import type { SourceInfo } from "../app/model";
import type { Task } from "../app/store";

/** Hub apps are made with this description, so the plugin can find them. */
export const HUB_PREFIX = "Signals hub";
export const HUB_PREFERENCE = "signalsHub";

export type SourceState = Readonly<{ source: string; enabled: boolean; last_post_at: number | null; last_count: number | null; last_error: string | null; cursor: string | null }>;
export type SignIn = "signed-in" | "needed" | "unknown";

export async function hubApps(client: DatabricksClient, signal?: AbortSignal): Promise<DatabricksApp[]> {
  return (await new Apps(client).list(signal)).filter((app) => app.description?.startsWith(HUB_PREFIX));
}

/** The hub picked before, else the only (or a running) one. */
export async function chosenHub(service: DatabricksService, signal?: AbortSignal): Promise<{ apps: DatabricksApp[]; app?: DatabricksApp }> {
  const apps = await hubApps(await service.ready(signal), signal);
  const picked = service.preferences.get<string>(HUB_PREFERENCE);
  const app = apps.find((found) => found.name === picked) ?? (apps.length === 1 ? apps[0] : apps.find((found) => found.app_status?.state === "RUNNING"));
  return { apps, ...(app && { app }) };
}

export class HubClient {
  constructor(
    private readonly client: DatabricksClient,
    readonly app: Pick<DatabricksApp, "name" | "url">,
  ) {}

  private async call<T>(method: "GET" | "POST", path: string, init: { query?: Record<string, string | number | undefined>; body?: unknown; signal?: AbortSignal } = {}): Promise<T> {
    if (!this.app.url) throw new Error(`The signals hub ${this.app.name} isn't running.`);
    const response = await this.client.request(`${this.app.url.replace(/\/+$/, "")}${path}`, {
      method,
      ...(init.query && { query: init.query }),
      ...(init.body !== undefined && { body: init.body }),
      timeoutMs: 60_000,
      ...(init.signal && { signal: init.signal }),
    });
    if (response.status === 401 || response.status === 403) throw new Error(`You can't use the signals hub ${this.app.name} yet. Ask its owner for Can Use on the app.`);
    if (!/json/.test(response.headers["content-type"] ?? "")) throw new Error(`The signals hub ${this.app.name} answered HTTP ${response.status}; it may be stopped or still starting.`);
    const body = JSON.parse(response.body) as T & { error?: string; problems?: string[] };
    if (response.status >= 400) throw new Error([body.error ?? `HTTP ${response.status}`, ...(body.problems ?? [])].join(" "));
    return body;
  }

  sources(signal?: AbortSignal) {
    return this.call<{ sources: SourceState[]; catalog: SourceInfo[] }>("GET", "/api/sources", { ...(signal && { signal }) });
  }
  setSource(source: string, enabled: boolean, forget = false) {
    return this.call<{ sources: SourceState[] }>("POST", "/api/sources", { body: { source, enabled, forget } });
  }
  tasks(filter: { open?: boolean; account?: string; channel?: string; status?: string; limit?: number } = {}, signal?: AbortSignal) {
    const query = { ...(filter.open && { open: "1" }), ...(filter.account && { account: filter.account }), ...(filter.channel && { channel: filter.channel }), ...(filter.status && { status: filter.status }), limit: filter.limit ?? 50 };
    return this.call<{ tasks: Task[] }>("GET", "/api/tasks", { query, ...(signal && { signal }) }).then((reply) => reply.tasks);
  }
  task(id: number) {
    return this.call<TaskDetail>("GET", "/api/task", { query: { id } });
  }
  updateTask(input: { id: number; status?: string; note?: string; artifact?: { url: string; title?: string; kind?: string } }) {
    return this.call<TaskDetail>("POST", "/api/task", { body: input });
  }
  events(events: readonly unknown[]) {
    return this.call<{ new: number; changed: number; same: number; skipped: number; created: number[]; updated: number[]; errors: { index: number; error: string }[] }>("POST", "/api/events", { body: { events } });
  }
}

export type TaskDetail = Readonly<{
  task: Task;
  events: { source: string; external_id: string; title?: string; url?: string; actor?: string; occurred_at: number; owner: string }[];
  activities: { at: number; actor: string; kind: string; text: string }[];
  artifacts: { at: number; actor: string; kind: string; url: string; title?: string }[];
}>;

/**
 * Whether the person signed in to a system.ai MCP service: a tools/list as
 * them. Not signed in answers HTTP 200 with JSON-RPC error -32006 (or a 401).
 */
export async function signInState(client: DatabricksClient, service: string, signal?: AbortSignal): Promise<SignIn> {
  const path = gatewayMcpPath(`system.ai.${service}`);
  const headers = { Accept: "application/json, text/event-stream" };
  try {
    const init = await client.request(path, { method: "POST", headers, body: { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "signals", version: "1" } } }, timeoutMs: 30_000, ...(signal && { signal }) });
    if (init.status === 401) return "needed";
    if (init.status === 404) return "unknown";
    const session = init.headers["mcp-session-id"];
    const list = await client.request(path, { method: "POST", headers: { ...headers, "MCP-Protocol-Version": "2025-06-18", ...(session && { "Mcp-Session-Id": session }) }, body: { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }, timeoutMs: 30_000, ...(signal && { signal }) });
    return rpcSignIn(list.status, list.body);
  } catch {
    return "unknown";
  }
}

/** Reads a tools/list reply: JSON-RPC errors come with HTTP 200. */
export function rpcSignIn(status: number, body: string): SignIn {
  if (status === 401) return "needed";
  if (status >= 400) return "unknown";
  const payload = body.includes("data:") ? body.split("\n").filter((line) => line.startsWith("data:")).map((line) => line.slice(5)).join("") : body;
  try {
    const reply = JSON.parse(payload) as { error?: { code?: number; message?: string }; result?: unknown };
    if (reply.error) return reply.error.code === -32006 || /401|not logged in|login first|Credential for user/i.test(reply.error.message ?? "") ? "needed" : "unknown";
    return reply.result ? "signed-in" : "unknown";
  } catch {
    return "unknown";
  }
}

/** Databricks' page where a person signs in to a system.ai service. */
export const signInPath = (service: string) => `/explore/mcp-services/system/ai/${service}`;
