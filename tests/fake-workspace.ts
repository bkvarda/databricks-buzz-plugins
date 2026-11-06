// A fake Databricks workspace for the skills tests. It keeps just enough state
// to run the real code end to end: schema tags (answered from the SQL
// statement API), skills with their files (create, upload, finalize, read,
// list, delete), the skills registry over MCP, domains and tag assignments.
// Every request is recorded in order, so tests can check what was sent.
import { parseSkillMarkdown } from "@dbx/core/api/skills";
import type { DatabricksClient } from "@dbx/core/client";
import type { DatabricksService } from "@dbx/core/service";

type Query = Record<string, string | undefined>;
export type Call = { method: string; path: string; query?: Query; body?: any };
type Reply = { status?: number; body?: unknown; headers?: Record<string, string> } | undefined;

export type FakeSkill = { description: string; body: string; files?: Record<string, string> };
export type FakeOptions = {
  /** Schema tags as [catalog, schema, tag, value]. */
  tags?: [string, string, string, string][];
  /** Finalized skills by full name. Their SKILL.md is `body`, with the given files. */
  skills?: Record<string, FakeSkill>;
  /** Domains by ID (`tag_key` is the governed tag). */
  domains?: Record<string, { tag_key: string }>;
  /** Makes GET /api/2.0/domains fail with this message. */
  domainError?: string;
  /** No SQL warehouse, so tag discovery can't run. */
  noWarehouse?: boolean;
  /** Creating a schema is denied. */
  denySchemas?: boolean;
};

const notFound = (path: string) => Object.assign(new Error(`no route for ${path}`), { status: 404 });
const apiError = (message: string, errorCode: string, status = 409) => Object.assign(new Error(message), { errorCode, status });

export function fakeWorkspace(options: FakeOptions = {}) {
  const calls: Call[] = [];
  const tags = [...(options.tags ?? [])];
  const skills = new Map<string, { description?: string; files: Map<string, string>; finalized: boolean }>();
  for (const [name, skill] of Object.entries(options.skills ?? {})) {
    skills.set(name, { description: skill.description, files: new Map([["SKILL.md", skill.body], ...Object.entries(skill.files ?? {})]), finalized: true });
  }
  const grants: { skill: string; principal: string; privileges: string[] }[] = [];
  const assignments: { entity_type: string; entity_name: string; tag_key: string; tag_value?: string }[] = [];
  const schemas: string[] = [];

  const finalized = (full: string) => skills.get(full)?.finalized === true;

  const route = (call: Call): Reply => {
    const url = new URL(call.path, "https://w.example");
    const path = url.pathname;
    const { method } = call;
    // Query parameters come either in the path (the registry's schema list) or in the request's query object.
    const param = (name: string) => call.query?.[name] ?? url.searchParams.get(name) ?? undefined;

    if (method === "GET" && path === "/api/2.0/sql/warehouses") return { body: { warehouses: options.noWarehouse ? [] : [{ id: "wh", name: "Serverless", state: "RUNNING", enable_serverless_compute: true }] } };

    if (method === "POST" && path === "/api/2.0/sql/statements") {
      const statement = String(call.body?.statement ?? "");
      const alter = /^ALTER SCHEMA `([^`]+)`\.`([^`]+)` SET TAGS \((.*)\)$/.exec(statement);
      if (alter) {
        for (const [, key, value] of (alter[3] ?? "").matchAll(/'([^']*)' = '([^']*)'/g)) tags.push([alter[1]!, alter[2]!, key!, value!]);
        return { body: statementResponse([], []) };
      }
      const rows = tags.map(([catalog, schema, tag, value]) => [catalog, schema, tag, value]);
      return { body: statementResponse(["catalog_name", "schema_name", "tag_name", "tag_value"], rows) };
    }

    if (method === "POST" && path === "/api/2.1/unity-catalog/schemas") {
      if (options.denySchemas) throw Object.assign(new Error("User does not have CREATE SCHEMA on Catalog"), { errorCode: "PERMISSION_DENIED", status: 403, isPermission: true });
      schemas.push(`${call.body.catalog_name}.${call.body.name}`);
      return { body: { name: call.body.name } };
    }

    if (path === "/ai-gateway/skills/") return mcpRoute(call, url, skills, finalized);

    if (path === "/api/2.1/unity-catalog/skills" && method === "POST") {
      const id = param("skill_id") ?? "";
      const parent = (param("parent") ?? "").replace(/^schemas\//, "");
      const full = `${parent}.${id}`;
      if (skills.has(full)) throw apiError(`Skill ${full} already exists`, "ALREADY_EXISTS");
      skills.set(full, { files: new Map(), finalized: false });
      return { body: { name: `skills/${full}` } };
    }

    const finalize = /^\/api\/2\.1\/unity-catalog\/skills\/([^/]+)\/finalize$/.exec(path);
    if (method === "POST" && finalize) {
      const full = decodeURIComponent(finalize[1]!);
      const skill = skills.get(full);
      if (!skill) throw notFound(path);
      const markdown = skill.files.get("SKILL.md");
      if (markdown === undefined) throw apiError("SKILL.md is missing", "INVALID_PARAMETER_VALUE", 400);
      const parsed = parseSkillMarkdown(markdown);
      skill.finalized = true;
      skill.description = parsed.description;
      return { body: { name: `skills/${full}`, bundle_name: parsed.name, description: parsed.description } };
    }

    const one = /^\/api\/2\.1\/unity-catalog\/skills\/([^/]+)$/.exec(path);
    if (method === "DELETE" && one) {
      skills.delete(decodeURIComponent(one[1]!));
      return { body: {} };
    }

    if (method === "PUT" && path.startsWith("/api/2.0/fs/files/Skills/")) {
      const [full, rel] = skillAndPath(path.slice("/api/2.0/fs/files/".length));
      const skill = skills.get(full);
      if (!skill) throw notFound(path);
      skill.files.set(rel, String(call.body ?? ""));
      return { status: 204 };
    }

    if (method === "GET" && path.startsWith("/api/2.0/fs/files/Skills/")) {
      const [full, rel] = skillAndPath(path.slice("/api/2.0/fs/files/".length));
      const text = skills.get(full)?.files.get(rel);
      if (text === undefined) throw notFound(path);
      return { body: text };
    }

    if (method === "GET" && path.startsWith("/api/2.0/fs/directories/Skills/")) {
      const [full, rel] = skillAndPath(path.slice("/api/2.0/fs/directories/".length).replace(/\/$/, ""));
      const files = skills.get(full)?.files;
      if (!files) throw notFound(path);
      const prefix = rel ? `${rel}/` : "";
      const base = `/Skills/${full.split(".").map(encodeURIComponent).join("/")}`;
      const children = new Map<string, boolean>();
      for (const file of files.keys()) {
        if (!file.startsWith(prefix)) continue;
        const [head, ...rest] = file.slice(prefix.length).split("/");
        children.set(head!, rest.length > 0);
      }
      const contents = [...children].map(([name, isDirectory]) => ({
        path: `${base}/${prefix}${name}`,
        is_directory: isDirectory,
      }));
      return { body: { contents } };
    }

    const grant = /^\/api\/2\.1\/unity-catalog\/permissions\/skill\/(.+)$/.exec(path);
    if (method === "PATCH" && grant) {
      for (const change of call.body.changes) grants.push({ skill: decodeURIComponent(grant[1]!), principal: change.principal, privileges: change.add });
      return { body: {} };
    }

    if (method === "GET" && path.startsWith("/api/2.0/domains/")) {
      if (options.domainError) throw Object.assign(new Error(options.domainError), { status: 500 });
      const id = path.slice("/api/2.0/domains/".length);
      const domain = options.domains?.[id];
      if (!domain) throw notFound(path);
      return { body: { name: `domains/${id}`, domain_id: id, tag_key: domain.tag_key } };
    }

    if (path === "/api/2.1/unity-catalog/entity-tag-assignments" && method === "POST") {
      const duplicate = assignments.find((entry) => entry.entity_name === call.body.entity_name && entry.tag_key === call.body.tag_key);
      if (duplicate) throw apiError("tag exists", "ALREADY_EXISTS");
      assignments.push(call.body);
      return { body: call.body };
    }

    return undefined;
  };

  const answer = (call: Call) => {
    calls.push(call);
    const reply = route(call);
    if (reply === undefined) throw notFound(`${call.method} ${call.path}`);
    return reply;
  };

  const client = {
    host: "https://w.example",
    workspaceId: undefined,
    async get(path: string, init: { query?: Query } = {}) {
      return answer({ method: "GET", path, query: init.query }).body;
    },
    async post(path: string, body?: unknown, init: { query?: Query } = {}) {
      return answer({ method: "POST", path, query: init.query, body }).body;
    },
    async json(path: string, init: { method?: string; body?: unknown; query?: Query } = {}) {
      return answer({ method: init.method ?? "POST", path, query: init.query, body: init.body }).body ?? {};
    },
    async request(path: string, init: { method?: string; body?: unknown; query?: Query; headers?: Record<string, string> } = {}) {
      const reply = answer({ method: init.method ?? "GET", path, query: init.query, body: init.body });
      const body = reply.body === undefined ? "" : typeof reply.body === "string" ? reply.body : JSON.stringify(reply.body);
      return { status: reply.status ?? 200, headers: reply.headers ?? {}, body };
    },
  } as unknown as DatabricksClient;

  return { client, calls, skills, grants, assignments, tags, schemas };
}

/** `/Skills/c/s/k/rel/path` (encoded segments) → [`c.s.k`, `rel/path`]. */
function skillAndPath(encoded: string): [string, string] {
  const parts = encoded.replace(/^Skills\//, "").split("/").map((part) => decodeURIComponent(part));
  return [parts.slice(0, 3).join("."), parts.slice(3).join("/")];
}

function statementResponse(columns: string[], rows: string[][]) {
  return {
    statement_id: "stmt",
    status: { state: "SUCCEEDED" },
    manifest: { schema: { columns: columns.map((name) => ({ name, type_text: "STRING" })) } },
    result: { data_array: rows },
  };
}

/** One JSON-RPC answer, echoing the request ID as the MCP client needs. */
function rpc(call: Call, result: unknown) {
  if (call.body?.id === undefined) return { status: 202 };
  return { body: { jsonrpc: "2.0", id: call.body.id, result }, headers: { "content-type": "application/json" } };
}

function mcpRoute(
  call: Call,
  url: URL,
  skills: Map<string, { description?: string; files: Map<string, string>; finalized: boolean }>,
  finalized: (full: string) => boolean,
) {
  const schemas = url.searchParams.getAll("schema");
  const inScope = [...skills.keys()].filter((full) => schemas.includes(full.split(".").slice(0, 2).join(".")) && finalized(full));
  switch (call.body?.method) {
    case "initialize":
      return rpc(call, { protocolVersion: "2025-06-18", serverInfo: { name: "skills" }, capabilities: {} });
    case "notifications/initialized":
      return rpc(call, undefined);
    case "tools/list":
      return rpc(call, {
        tools: [
          { name: "list_skills", description: "Lists skills." },
          { name: "load_skill", description: "Loads a skill." },
          ...inScope.map((full) => ({ name: `skill_${full}`, description: `[${full}] ${skills.get(full)?.description ?? ""}` })),
        ],
      });
    case "tools/call": {
      const full = String(call.body.params?.arguments?.full_name ?? "");
      const text = skills.get(full)?.files.get("SKILL.md");
      if (text === undefined || !finalized(full)) return rpc(call, { isError: true, content: [{ type: "text", text: `Skill ${full} not found.` }] });
      return rpc(call, { content: [{ type: "text", text }] });
    }
    default:
      return rpc(call, {});
  }
}

/** A connected service over a fake client. Preferences are an in-memory map; `switchTo` changes the workspace. */
export function fakeService(client: DatabricksClient, preferences: Record<string, unknown> = {}) {
  const prefs = new Map<string, unknown>(Object.entries(preferences));
  const listeners = new Set<() => void>();
  let host = "https://w.example";
  const service = {
    version: 1,
    snapshot: () => ({ status: "connected", profile: { host, name: "p" }, user: { userName: "me@example.com" } }),
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    client: () => client,
    ready: async () => client,
    workspaceUrl: (path: string) => `${host}${path}`,
    profiles: () => [],
    openSettings() {},
    signIn: async () => {},
    preferences: {
      get: <T>(name: string) => prefs.get(name) as T | undefined,
      set(name: string, value: unknown) {
        if (value === undefined) prefs.delete(name);
        else prefs.set(name, value);
        for (const listener of [...listeners]) listener();
      },
      subscribe: () => () => {},
    },
  } as unknown as DatabricksService;
  return {
    service,
    prefs,
    switchTo(next: string) {
      host = next;
      for (const listener of [...listeners]) listener();
    },
  };
}
