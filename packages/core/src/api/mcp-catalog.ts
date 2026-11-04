// What MCP servers a workspace offers an agent, from three sources:
// - Unity Gateway MCP services (Unity Catalog securables, including the
//   Databricks-provided ones in system.ai such as dbsql, web_search, github):
//     GET /api/2.1/unity-catalog/mcp-services  →  /ai-gateway/mcp-services/<catalog>.<schema>.<name>
// - Unity Catalog HTTP connections marked as MCP (external MCP proxies):
//     GET /api/2.1/unity-catalog/connections   →  /api/2.0/mcp/external/<connection>
// - Unity Catalog functions in a schema, which the person names:
//     /api/2.0/mcp/functions/<catalog>/<schema>
// Genie agents and Genie One are offered separately (they have native tools).
import type { DatabricksClient } from "../client";
import { gatewayMcpPath } from "./mcp";

export type McpServerKind = "service" | "connection" | "functions";

export type McpServer = Readonly<{
  /** Stable ID, e.g. "service:system.ai.dbsql". */
  id: string;
  kind: McpServerKind;
  /** Short name for people and for tool prefixes. */
  label: string;
  description?: string;
  /** Path on the workspace host. */
  path: string;
  /** Whether the person must authorize a third-party account first. */
  needsLogin?: boolean;
  /** Databricks-provided (system.ai). */
  builtIn?: boolean;
}>;

type ServiceRecord = {
  name: string;
  comment?: string;
  config?: { internal?: unknown; source_connection?: { securable_kind?: string; url?: string; options?: Record<string, string> } };
};

type ConnectionRecord = {
  name: string;
  full_name?: string;
  comment?: string;
  connection_type?: string;
  options?: Record<string, string>;
};

/** Services with a native equivalent in these plugins. */
const NATIVE = new Set(["system.ai.genie_one_mcp", "system.ai.sandbox"]);

const plain = (text = "") => text.replace(/\[([^\]]+)\]\([^)]+\)/g, "$1").replace(/\s+/g, " ").trim();

/** "system.ai.web_search" → "Web search". */
export function serviceLabel(fullName: string): string {
  const leaf = fullName.split(".").pop() ?? fullName;
  const known: Record<string, string> = { dbsql: "Databricks SQL", github: "GitHub", gmail: "Gmail", microsoft_365: "Microsoft 365" };
  if (known[leaf]) return known[leaf];
  const words = leaf.replace(/[_-]+/g, " ").trim();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/** Whether the person has logged in to a per-user OAuth MCP service. */
export type McpLoginState = "signed-in" | "needed" | "unknown";

/** "service:system.ai.github" → "system.ai.github"; undefined for other kinds. */
export const serviceName = (server: Pick<McpServer, "id" | "kind">) =>
  server.kind === "service" ? server.id.replace(/^service:/, "") : undefined;

/** Databricks' page where a person logs in to an MCP service's provider (and can log out). */
export const mcpLoginPath = (fullName: string) => `/mcp-service-login?name=${encodeURIComponent(fullName)}`;

/** An MCP rejection that means the person hasn't logged in to the provider. */
export const isLoginRejection = (error: unknown) =>
  /HTTP 401|requires authentication|not logged in|login first|Credential for user identity/i.test((error as Error)?.message ?? String(error));

export function functionsServer(catalog: string, schema: string): McpServer {
  return {
    id: `functions:${catalog}.${schema}`,
    kind: "functions",
    label: `${catalog}.${schema} functions`,
    description: `Unity Catalog functions in ${catalog}.${schema}`,
    path: `/api/2.0/mcp/functions/${encodeURIComponent(catalog)}/${encodeURIComponent(schema)}`,
  };
}

export class McpCatalog {
  constructor(private readonly client: DatabricksClient) {}

  async services(signal?: AbortSignal): Promise<McpServer[]> {
    const out: McpServer[] = [];
    let pageToken: string | undefined;
    for (let page = 0; page < 10; page++) {
      const response = await this.client.get<{ mcp_services?: ServiceRecord[]; next_page_token?: string }>("/api/2.1/unity-catalog/mcp-services", {
        query: { view: "FULL", page_size: 100, page_token: pageToken },
        ...(signal && { signal }),
      });
      for (const service of response.mcp_services ?? []) {
        const fullName = service.name.replace(/^mcp-services\//, "");
        if (NATIVE.has(fullName)) continue;
        const kind = service.config?.source_connection?.securable_kind ?? "";
        out.push({
          id: `service:${fullName}`,
          kind: "service",
          label: serviceLabel(fullName),
          description: plain(service.comment).replace(/ Verify that the provider's service.*$/, ""),
          path: gatewayMcpPath(fullName),
          ...(/U2M/.test(kind) && { needsLogin: true }),
          ...(fullName.startsWith("system.ai.") && { builtIn: true }),
        });
      }
      pageToken = response.next_page_token;
      if (!pageToken) break;
    }
    return out;
  }

  /**
   * The caller's own login to a per-user OAuth MCP service (Beta API): a
   * credential in state ACTIVE means logged in; NOT_FOUND means not yet.
   */
  async loginState(fullName: string, signal?: AbortSignal): Promise<McpLoginState> {
    try {
      const response = await this.client.get<{ provisioning_info?: { state?: string }; state?: string }>(
        `/api/2.1/unity-catalog/mcp-services/${fullName}/user-credentials`,
        signal ? { signal } : {},
      );
      const state = response.provisioning_info?.state ?? response.state;
      return !state || state === "ACTIVE" ? "signed-in" : "needed";
    } catch (error) {
      // ENDPOINT_NOT_FOUND (API not in this workspace) and the rest stay unknown.
      return (error as { errorCode?: string }).errorCode === "NOT_FOUND" ? "needed" : "unknown";
    }
  }

  async connections(signal?: AbortSignal): Promise<McpServer[]> {
    const out: McpServer[] = [];
    let pageToken: string | undefined;
    for (let page = 0; page < 10; page++) {
      const response = await this.client.get<{ connections?: ConnectionRecord[]; next_page_token?: string }>("/api/2.1/unity-catalog/connections", {
        query: { max_results: 500, page_token: pageToken },
        ...(signal && { signal }),
      });
      for (const connection of response.connections ?? []) {
        if (connection.options?.is_mcp_connection !== "true") continue;
        const host = connection.options.host?.replace(/^https?:\/\//, "");
        out.push({
          id: `connection:${connection.name}`,
          kind: "connection",
          label: connection.name,
          ...((connection.comment || host) && { description: plain(connection.comment) || host }),
          path: `/api/2.0/mcp/external/${encodeURIComponent(connection.name)}`,
        });
      }
      pageToken = response.next_page_token;
      if (!pageToken) break;
    }
    return out.sort((a, b) => a.label.localeCompare(b.label));
  }

  /** Everything the person can see, built-ins first; a failing source is skipped. */
  async list(signal?: AbortSignal): Promise<{ servers: McpServer[]; errors: string[] }> {
    const errors: string[] = [];
    const [services, connections] = await Promise.all([
      this.services(signal).catch((error: Error) => (errors.push(`MCP services: ${error.message}`), [] as McpServer[])),
      this.connections(signal).catch((error: Error) => (errors.push(`connections: ${error.message}`), [] as McpServer[])),
    ]);
    const builtIn = services.filter((server) => server.builtIn).sort((a, b) => a.label.localeCompare(b.label));
    const registered = services.filter((server) => !server.builtIn).sort((a, b) => a.label.localeCompare(b.label));
    return { servers: [...builtIn, ...registered, ...connections], errors };
  }
}

/** A tool-name prefix for a server: lowercase, [a-z0-9_], at most 20 characters. */
export function toolPrefix(server: Pick<McpServer, "label" | "id">): string {
  const base = (server.label || server.id).toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
  return (base || "mcp").slice(0, 20).replace(/_+$/, "");
}
