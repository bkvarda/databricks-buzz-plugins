// Databricks Knowledge (bkvarda.databricks-knowledge) — built by databricks-buzz-plugins. Apache-2.0.

// packages/core/src/react.ts
var React = void 0;
function bindReact(instance) {
  React = instance;
}

// packages/core/src/sse.ts
var SseParser = class {
  constructor(onEvent) {
    this.onEvent = onEvent;
  }
  buffer = "";
  data = [];
  event = "";
  id;
  push(chunk) {
    this.buffer += chunk;
    let index = this.buffer.search(/\r\n|\r|\n/);
    while (index !== -1) {
      const line = this.buffer.slice(0, index);
      const newline = this.buffer.startsWith("\r\n", index) ? 2 : 1;
      this.buffer = this.buffer.slice(index + newline);
      this.line(line);
      index = this.buffer.search(/\r\n|\r|\n/);
    }
  }
  /** Dispatches a final event that was not followed by a blank line. */
  end() {
    if (this.buffer) this.line(this.buffer);
    this.buffer = "";
    this.line("");
  }
  line(line) {
    if (line === "") {
      if (this.data.length) {
        this.onEvent({
          event: this.event || "message",
          data: this.data.join("\n"),
          ...this.id !== void 0 && { id: this.id }
        });
      }
      this.data = [];
      this.event = "";
      return;
    }
    if (line.startsWith(":")) return;
    const colon = line.indexOf(":");
    const field = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? "" : line.slice(colon + 1);
    if (value.startsWith(" ")) value = value.slice(1);
    if (field === "data") this.data.push(value);
    else if (field === "event") this.event = value;
    else if (field === "id") this.id = value;
  }
};
function parseSse(body) {
  const events = [];
  const parser = new SseParser((event) => events.push(event));
  parser.push(body);
  parser.end();
  return events;
}

// packages/core/src/client.ts
var DatabricksApiError = class extends Error {
  constructor(status, errorCode2, message, body) {
    super(message);
    this.status = status;
    this.errorCode = errorCode2;
    this.body = body;
    this.name = "DatabricksApiError";
  }
  get isPermission() {
    return this.status === 403 || this.errorCode === "PERMISSION_DENIED";
  }
  get isNotFound() {
    return this.status === 404 || this.errorCode === "RESOURCE_DOES_NOT_EXIST" || this.errorCode === "NOT_FOUND";
  }
  get isFeatureDisabled() {
    return this.errorCode === "FEATURE_DISABLED" || this.errorCode === "NOT_IMPLEMENTED" || /not enabled|feature.*disabled|preview/i.test(this.message);
  }
};
function apiError(response) {
  let code;
  let message = `Databricks returned HTTP ${response.status}`;
  try {
    const parsed = JSON.parse(response.body);
    code = parsed.error_code ?? (typeof parsed.error === "object" ? parsed.error?.code : void 0);
    message = parsed.message ?? (typeof parsed.error === "object" ? parsed.error?.message : parsed.error) ?? parsed.error_description ?? message;
  } catch {
    const text2 = response.body.trim();
    if (text2 && text2.length < 400 && !text2.startsWith("<")) message = text2;
  }
  return new DatabricksApiError(response.status, code, message, response.body);
}

// packages/core/src/api/mcp.ts
var PROTOCOL_VERSION = "2025-06-18";
var McpError = class extends Error {
  constructor(message, code, data) {
    super(message);
    this.code = code;
    this.data = data;
    this.name = "McpError";
  }
};
var McpClient = class {
  constructor(client, path, query = {}) {
    this.client = client;
    this.path = path;
    this.query = query;
  }
  session;
  initializing;
  nextId = 1;
  toolsCache;
  serverInfo;
  instructions;
  async listTools(signal) {
    if (this.toolsCache && Date.now() - this.toolsCache.at < 5 * 6e4) return this.toolsCache.tools;
    const tools = [];
    let cursor;
    do {
      const page = await this.call("tools/list", cursor ? { cursor } : {}, signal);
      tools.push(...page.tools ?? []);
      cursor = page.nextCursor;
    } while (cursor);
    this.toolsCache = { at: Date.now(), tools };
    return tools;
  }
  callTool(name, args, options = {}) {
    return this.call(
      "tools/call",
      { name, arguments: args, ...options.meta && { _meta: options.meta } },
      options.signal,
      options.timeoutMs
    );
  }
  async readResource(uri, signal) {
    return await this.call("resources/read", { uri }, signal);
  }
  async ensureSession(signal) {
    if (this.session) return;
    this.initializing ??= (async () => {
      const result = await this.send(
        {
          jsonrpc: "2.0",
          id: this.nextId++,
          method: "initialize",
          params: {
            protocolVersion: PROTOCOL_VERSION,
            capabilities: {},
            clientInfo: { name: "databricks-buzz-plugins", version: "0.1.0" }
          }
        },
        signal,
        true
      );
      this.serverInfo = result?.serverInfo;
      this.instructions = result?.instructions;
      await this.send({ jsonrpc: "2.0", method: "notifications/initialized" }, signal).catch(() => {
      });
    })().finally(() => {
      this.initializing = void 0;
    });
    await this.initializing;
  }
  async call(method, params, signal, timeoutMs) {
    await this.ensureSession(signal);
    try {
      return await this.send({ jsonrpc: "2.0", id: this.nextId++, method, params }, signal, false, timeoutMs);
    } catch (error) {
      if (error.status === 404 && this.session) {
        this.session = void 0;
        await this.ensureSession(signal);
        return this.send({ jsonrpc: "2.0", id: this.nextId++, method, params }, signal, false, timeoutMs);
      }
      throw error;
    }
  }
  async send(message, signal, initializing = false, timeoutMs = 12e4) {
    const response = await this.client.request(this.path, {
      method: "POST",
      query: this.query,
      body: message,
      timeoutMs,
      ...signal && { signal },
      headers: {
        Accept: "application/json, text/event-stream",
        ...!initializing && { "MCP-Protocol-Version": PROTOCOL_VERSION },
        ...this.session && { "Mcp-Session-Id": this.session }
      }
    });
    const session = response.headers["mcp-session-id"];
    if (session) this.session = session;
    if (message.id === void 0) return void 0;
    if (response.status === 202) return void 0;
    if (response.status < 200 || response.status >= 300) throw apiError(response);
    const type = response.headers["content-type"] ?? "";
    const payloads = type.includes("text/event-stream") ? parseSse(response.body).map((event) => event.data) : [response.body];
    for (const payload of payloads) {
      let parsed;
      try {
        parsed = JSON.parse(payload);
      } catch {
        continue;
      }
      if (parsed.id !== message.id) continue;
      if (parsed.error)
        throw new McpError(parsed.error.message ?? "MCP error", parsed.error.code, parsed.error.data);
      return parsed.result;
    }
    throw new McpError(`No response to ${message.method}`);
  }
};
function resultText(result) {
  return (result.content ?? []).map((item) => item.type === "text" ? String(item.text) : "").filter(Boolean).join("\n\n");
}

// packages/core/src/api/skills.ts
var skillFullName = (nameOrFull) => nameOrFull.replace(/^skills\//, "");
function splitFullName(fullName) {
  const parts = skillFullName(fullName).split(".");
  if (parts.length !== 3 || parts.some((part) => !part)) throw new Error(`A skill's full name is catalog.schema.skill, not "${fullName}".`);
  return { catalog: parts[0], schema: parts[1], skill: parts[2] };
}
var validSkillId = (id) => /^[a-z0-9][a-z0-9_-]{0,63}$/.test(id);
function skillIdFrom(text2) {
  const slug = text2.toLowerCase().normalize("NFKD").replace(/[^\w\s-]/g, " ").replace(/[\s_]+/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "").slice(0, 64).replace(/-$/, "");
  return slug || "skill";
}
var yamlString = (value) => JSON.stringify(value.replace(/\s+/g, " ").trim());
function skillMarkdown(skill) {
  return `---
name: ${skill.name}
description: ${yamlString(skill.description)}
---

${skill.body.trim()}
`;
}
function parseSkillMarkdown(text2) {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(text2);
  if (!match) return { body: text2 };
  const fields = {};
  for (const line of match[1].split(/\r?\n/)) {
    const field = /^([A-Za-z_][\w-]*):\s*(.*)$/.exec(line);
    if (!field) continue;
    let value = field[2].trim();
    if (/^".*"$/.test(value)) {
      try {
        value = JSON.parse(value);
      } catch {
        value = value.slice(1, -1);
      }
    } else if (/^'.*'$/.test(value)) value = value.slice(1, -1).replace(/''/g, "'");
    fields[field[1]] = value;
  }
  return { ...fields.name && { name: fields.name }, ...fields.description && { description: fields.description }, body: match[2].replace(/^\s*\n/, "") };
}
function skillFilesPath(fullName, path = "") {
  const { catalog, schema: schema2, skill } = splitFullName(fullName);
  const clean = path.replace(/^\/+/, "");
  if (clean.split("/").some((part) => part === ".." || part === ".")) throw new Error("Skill file paths cannot contain . or ..");
  return ["Skills", catalog, schema2, skill, ...clean.split("/").filter(Boolean)].map(encodeURIComponent).join("/");
}
var SkillExistsError = class extends Error {
  constructor(fullName) {
    super(`There's already a skill named ${fullName}. Pick another name, or choose to replace it.`);
    this.fullName = fullName;
  }
  name = "SkillExistsError";
};
var isSkillExists = (error) => error instanceof Error && error.name === "SkillExistsError";
var SKILL_TOOL = /^skill_(.+\..+\..+)$/;
var Skills = class {
  constructor(client) {
    this.client = client;
  }
  /** Every finalized and unfinalized skill in one schema. */
  async list(catalog, schema2, signal) {
    const skills = [];
    let pageToken;
    for (let page = 0; page < 50; page++) {
      const response = await this.client.get("/api/2.1/unity-catalog/skills", {
        query: { parent: `schemas/${catalog}.${schema2}`, page_token: pageToken },
        ...signal && { signal }
      });
      skills.push(...response.skills ?? []);
      pageToken = response.next_page_token;
      if (!pageToken) break;
    }
    return skills;
  }
  get(fullName, signal) {
    return this.client.get(`/api/2.1/unity-catalog/skills/${skillFullName(fullName)}`, signal ? { signal } : {});
  }
  /** An empty skill; it can't be used until its files are uploaded and it's finalized. */
  create(catalog, schema2, id, comment) {
    if (!validSkillId(id)) throw new Error(`"${id}" isn't a valid skill name: use lowercase letters, digits, hyphens and underscores.`);
    return this.client.post("/api/2.1/unity-catalog/skills", comment ? { comment } : {}, { query: { parent: `schemas/${catalog}.${schema2}`, skill_id: id } });
  }
  async upload(fullName, file, signal) {
    const response = await this.client.request(`/api/2.0/fs/files/${skillFilesPath(fullName, file.path)}`, {
      method: "PUT",
      body: file.content,
      query: { overwrite: "true" },
      headers: { "Content-Type": "application/octet-stream" },
      timeoutMs: 6e4,
      ...signal && { signal }
    });
    if (response.status < 200 || response.status >= 300) throw apiError(response);
  }
  /** Checks SKILL.md and sets bundle_name and description from it. */
  finalize(fullName) {
    return this.client.post(`/api/2.1/unity-catalog/skills/${skillFullName(fullName)}/finalize`, {});
  }
  /**
   * Creates the skill (or reuses one with that name), uploads its files and
   * finalizes it. SKILL.md is required. Files already there and not in
   * `files` are left alone.
   */
  async publish(target, files, options = {}) {
    const markdown = files.find((file) => file.path.replace(/^\/+/, "") === "SKILL.md");
    if (!markdown) throw new Error("A skill needs a SKILL.md.");
    const parsed = parseSkillMarkdown(markdown.content);
    if (!parsed.name || !parsed.description) throw new Error("SKILL.md must start with frontmatter that sets name and description.");
    const fullName = `${target.catalog}.${target.schema}.${target.id}`;
    let created = false;
    try {
      await this.create(target.catalog, target.schema, target.id, target.comment);
      created = true;
    } catch (error) {
      const code = error.errorCode;
      if (code !== "ALREADY_EXISTS" && code !== "RESOURCE_ALREADY_EXISTS") throw error;
      if (!options.replace) throw new SkillExistsError(fullName);
    }
    try {
      for (const file of files) await this.upload(fullName, file, options.signal);
      return { skill: await this.finalize(fullName), created };
    } catch (error) {
      if (created) await this.delete(fullName).catch(() => {
      });
      throw error;
    }
  }
  delete(fullName) {
    return this.client.json(`/api/2.1/unity-catalog/skills/${skillFullName(fullName)}`, { method: "DELETE" });
  }
  /** Every file's path, relative to the skill's folder. */
  async files(fullName, signal) {
    const root = `/${skillFilesPath(fullName)}/`;
    const found = [];
    const walk = async (relative, depth) => {
      let pageToken;
      do {
        const response = await this.client.get(
          `/api/2.0/fs/directories/${skillFilesPath(fullName, relative)}/`,
          { query: { page_token: pageToken }, ...signal && { signal } }
        );
        for (const entry of response.contents ?? []) {
          const path = decodeURIComponent(entry.path.replace(/\/$/, "")).replace(decodeURIComponent(root), "");
          if (entry.is_directory) {
            if (depth < 6) await walk(path, depth + 1);
          } else found.push(path);
        }
        pageToken = response.next_page_token;
      } while (pageToken && found.length < 500);
    };
    await walk("", 0);
    return found.sort();
  }
  /** One file's text. */
  async read(fullName, path, signal) {
    const response = await this.client.request(`/api/2.0/fs/files/${skillFilesPath(fullName, path)}`, {
      method: "GET",
      headers: { Accept: "application/octet-stream" },
      timeoutMs: 6e4,
      ...signal && { signal }
    });
    if (response.status < 200 || response.status >= 300) throw apiError(response);
    return response.body;
  }
  /** Grants privileges on a skill, e.g. READ VOLUME to share it. */
  grant(fullName, principal, privileges = ["READ_VOLUME"]) {
    return this.client.json(`/api/2.1/unity-catalog/permissions/skill/${skillFullName(fullName)}`, {
      method: "PATCH",
      body: { changes: [{ principal, add: privileges }] }
    });
  }
  /**
   * Every finalized skill in these schemas, from one registry call (chunked
   * for long lists). A schema that doesn't exist or isn't readable is skipped
   * by the registry, not an error.
   */
  async registry(schemas, signal) {
    const found = /* @__PURE__ */ new Map();
    for (let start = 0; start < schemas.length; start += 40) {
      const query = schemas.slice(start, start + 40).map((schema2) => `schema=${encodeURIComponent(schema2)}`).join("&");
      const mcp = new McpClient(this.client, `/ai-gateway/skills/?${query}`, this.client.workspaceId ? { o: this.client.workspaceId } : {});
      for (const tool of await mcp.listTools(signal)) {
        const match = SKILL_TOOL.exec(tool.name);
        if (!match) continue;
        const fullName = match[1];
        found.set(fullName, { fullName, description: (tool.description ?? "").replace(/^\[[^\]]*\]\s*/, "").trim() });
      }
    }
    return [...found.values()].sort((a, b) => a.fullName.localeCompare(b.fullName));
  }
  /** SKILL.md as the registry serves it to agents, ready to follow. */
  async load(fullName, signal) {
    const mcp = new McpClient(this.client, "/ai-gateway/skills/", this.client.workspaceId ? { o: this.client.workspaceId } : {});
    const result = await mcp.callTool("load_skill", { full_name: skillFullName(fullName) }, signal ? { signal } : {});
    if (result.isError) throw new Error(resultText(result) || `Couldn't load ${fullName}.`);
    return resultText(result);
  }
};
function searchSkills(skills, query, limit = 20) {
  const words = query.toLowerCase().split(/[^a-z0-9]+/).filter((word) => word.length > 1);
  if (!words.length) return skills.slice(0, limit);
  const scored = skills.map((skill) => {
    const leaf = skill.fullName.split(".").pop().toLowerCase();
    const where = skill.fullName.toLowerCase();
    const text2 = skill.description.toLowerCase();
    let score = 0;
    if (leaf === words.join("-")) score += 20;
    for (const word of words) {
      if (leaf.includes(word)) score += 6;
      else if (where.includes(word)) score += 3;
      if (new RegExp(`\\b${word}`).test(text2)) score += 2;
      else if (text2.includes(word)) score += 1;
    }
    return { skill, score };
  });
  return scored.filter((entry) => entry.score > 0).sort((a, b) => b.score - a.score || a.skill.fullName.localeCompare(b.skill.fullName)).slice(0, limit).map((entry) => entry.skill);
}

// packages/core/src/result.ts
var NUMERIC_TYPES = /^(tinyint|smallint|int|integer|bigint|long|short|byte|float|double|real|decimal|numeric)/i;
var TIME_TYPES = /^(date|timestamp)/i;
var IDENTIFIER = /(^|_)(id|ids|zip|zipcode|zip_code|postal_code|postcode|code|key|year|fiscal_year|phone)$/i;
function kindOf(type, sample, name = "") {
  if (IDENTIFIER.test(name) && !TIME_TYPES.test(type ?? "") && !/^bool/i.test(type ?? "")) return "text";
  if (type) {
    if (NUMERIC_TYPES.test(type)) return "number";
    if (TIME_TYPES.test(type)) return "time";
    if (/^bool/i.test(type)) return "boolean";
    if (/^(string|varchar|char|binary|array|map|struct|interval)/i.test(type)) return "text";
  }
  const values = sample.filter((value) => value !== null && value !== "");
  if (!values.length) return "text";
  if (values.every((value) => /^-?\d+(\.\d+)?([eE][+-]?\d+)?$/.test(value))) return "number";
  if (values.every((value) => /^\d{4}-\d{2}(-\d{2})?([T ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?)?$/.test(value)))
    return "time";
  return "text";
}
function resultSet(columns, rows, extra = {}) {
  return {
    columns: columns.map((column, index) => ({
      name: column.name,
      ...column.type && { type: column.type },
      kind: kindOf(
        column.type,
        rows.slice(0, 50).map((row) => row[index] ?? null),
        column.name
      )
    })),
    rows,
    ...extra
  };
}
function fromStatement(response) {
  const columns = (response.manifest?.schema?.columns ?? []).map((column) => ({
    name: column.name,
    type: column.type_text ?? column.type_name ?? ""
  }));
  const rows = response.result?.data_array ?? [];
  const total = response.manifest?.total_row_count;
  return resultSet(columns, rows, {
    ...total !== void 0 && { totalRows: total },
    truncated: Boolean(response.manifest?.truncated) || total !== void 0 && total > rows.length
  });
}
var compact = new Intl.NumberFormat(void 0, { notation: "compact", maximumFractionDigits: 1 });
var precise = new Intl.NumberFormat(void 0, { maximumFractionDigits: 2 });

// packages/core/src/api/sql.ts
var StatementError = class extends Error {
  constructor(message, statementId, state) {
    super(message);
    this.statementId = statementId;
    this.state = state;
    this.name = "StatementError";
  }
};
var RUNNING = /* @__PURE__ */ new Set(["PENDING", "RUNNING"]);
var EXPIRED = "Databricks no longer keeps this result. Run the statement again to see it.";
var Sql = class {
  constructor(client) {
    this.client = client;
  }
  async warehouses(signal) {
    const response = await this.client.get("/api/2.0/sql/warehouses", signal ? { signal } : {});
    return response.warehouses ?? [];
  }
  /** The best default: running serverless, any serverless, running, first. */
  static pick(warehouses) {
    const score = (w) => (w.enable_serverless_compute || w.warehouse_type === "SERVERLESS" ? 2 : 0) + (w.state === "RUNNING" ? 1 : 0);
    return [...warehouses].sort((a, b) => score(b) - score(a))[0];
  }
  /** Runs a statement and waits for its first result chunk. */
  async execute(statement, options) {
    const signal = options.signal;
    let response = await this.client.post(
      "/api/2.0/sql/statements",
      {
        statement,
        warehouse_id: options.warehouseId,
        // Short, so the statement ID comes back soon: with it, a run cut off
        // (Buzz closing) can be picked up again.
        wait_timeout: "10s",
        on_wait_timeout: "CONTINUE",
        disposition: "INLINE",
        format: "JSON_ARRAY",
        row_limit: options.rowLimit ?? 1e3,
        ...options.catalog && { catalog: options.catalog },
        ...options.schema && { schema: options.schema }
      },
      { timeoutMs: 3e4, ...signal && { signal } }
    );
    options.onStatement?.(response.statement_id);
    return this.follow(response, options);
  }
  /**
   * A statement started earlier, by its ID: waits for it if it's still
   * running, then returns its first result chunk. Databricks keeps a result
   * only for a while; after that this fails with `state` CLOSED.
   */
  async resume(statementId, options = {}) {
    const signal = options.signal;
    let response;
    try {
      response = await this.client.get(`/api/2.0/sql/statements/${encodeURIComponent(statementId)}`, signal ? { signal } : {});
    } catch (error) {
      if (error.status === 404) throw new StatementError(EXPIRED, statementId, "CLOSED");
      throw error;
    }
    return this.follow(response, options);
  }
  async follow(first, options) {
    const signal = options.signal;
    let response = first;
    const deadline = Date.now() + (options.timeoutMs ?? 5 * 6e4);
    const cancel = () => void this.cancel(response.statement_id).catch(() => {
    });
    signal?.addEventListener("abort", cancel, { once: true });
    try {
      let delay = 750;
      while (RUNNING.has(response.status?.state ?? "")) {
        if (Date.now() > deadline) {
          cancel();
          throw new StatementError("The query took too long and was cancelled.", response.statement_id, "CANCELED");
        }
        await new Promise((resolve) => setTimeout(resolve, delay));
        signal?.throwIfAborted();
        delay = Math.min(3e3, delay * 1.5);
        response = await this.client.get(
          `/api/2.0/sql/statements/${encodeURIComponent(response.statement_id)}`,
          signal ? { signal } : {}
        );
      }
    } finally {
      signal?.removeEventListener("abort", cancel);
    }
    const state = response.status?.state;
    if (state === "CLOSED") throw new StatementError(EXPIRED, response.statement_id, state);
    if (state !== "SUCCEEDED")
      throw new StatementError(
        response.status?.error?.message ?? `The query ended as ${state ?? "unknown"}.`,
        response.statement_id,
        state
      );
    return { statementId: response.statement_id, result: fromStatement(response) };
  }
  cancel(statementId) {
    return this.client.post(`/api/2.0/sql/statements/${encodeURIComponent(statementId)}/cancel`, {});
  }
  catalogs(signal) {
    return this.client.get("/api/2.1/unity-catalog/catalogs", signal ? { signal } : {}).then((response) => response.catalogs ?? []);
  }
  schemas(catalog, signal) {
    return this.client.get("/api/2.1/unity-catalog/schemas", {
      query: { catalog_name: catalog },
      ...signal && { signal }
    }).then((response) => response.schemas ?? []);
  }
  tables(catalog, schema2, signal) {
    return this.client.get(
      "/api/2.1/unity-catalog/tables",
      { query: { catalog_name: catalog, schema_name: schema2, max_results: 200 }, ...signal && { signal } }
    ).then((response) => response.tables ?? []);
  }
  table(fullName, signal) {
    return this.client.get(`/api/2.1/unity-catalog/tables/${encodeURIComponent(fullName)}`, signal ? { signal } : {});
  }
};

// packages/core/src/api/tags.ts
var SKILLS_TAG = "agent_skills";
var CHANNEL_TAG = "buzz_channel";
var DOMAIN_TAG = "buzz_domain";
var quote = (value) => `'${value.replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'`;
var ident = (value) => `\`${value.replace(/`/g, "``")}\``;
var Tags = class {
  constructor(client) {
    this.client = client;
  }
  /**
   * Sets a tag on a securable. `entityType` is the API's plural name:
   * catalogs, schemas, tables, volumes, functions, skills, … A tag that's
   * already there is updated.
   */
  async assign(entityType, entityName, key, value = "") {
    const body = { entity_type: entityType, entity_name: entityName, tag_key: key, ...value && { tag_value: value } };
    try {
      return await this.client.post("/api/2.1/unity-catalog/entity-tag-assignments", body);
    } catch (error) {
      const code = error.errorCode;
      if (code !== "ALREADY_EXISTS" && code !== "RESOURCE_ALREADY_EXISTS") throw error;
      return this.client.json(
        `/api/2.1/unity-catalog/entity-tag-assignments/${entityType}/${encodeURIComponent(entityName)}/tags/${encodeURIComponent(key)}`,
        { method: "PATCH", body, query: { update_mask: "tag_value" } }
      );
    }
  }
  async list(entityType, entityName) {
    const response = await this.client.get(
      `/api/2.1/unity-catalog/entity-tag-assignments/${entityType}/${encodeURIComponent(entityName)}/tags`
    );
    return response.tag_assignments ?? [];
  }
  remove(entityType, entityName, key) {
    return this.client.json(`/api/2.1/unity-catalog/entity-tag-assignments/${entityType}/${encodeURIComponent(entityName)}/tags/${encodeURIComponent(key)}`, {
      method: "DELETE"
    });
  }
  /**
   * Every schema the person can see that carries one of these tags (with
   * `value`, only that value), across all catalogs, in one SQL query.
   */
  async schemas(warehouseId, tags, value, signal) {
    if (!tags.length) return [];
    const statement = `SELECT catalog_name, schema_name, tag_name, tag_value FROM system.information_schema.schema_tags WHERE tag_name IN (${tags.map(quote).join(", ")})` + (value !== void 0 ? ` AND tag_value = ${quote(value)}` : "") + " ORDER BY catalog_name, schema_name LIMIT 2000";
    const { result } = await new Sql(this.client).execute(statement, { warehouseId, rowLimit: 2e3, timeoutMs: 12e4, ...signal && { signal } });
    return result.rows.map((row) => ({ catalog: String(row[0]), schema: String(row[1]), tag: String(row[2]), value: row[3] == null ? "" : String(row[3]) }));
  }
  /** Tags a schema through SQL (works for plain and governed tags you may assign). */
  async tagSchema(warehouseId, catalog, schema2, tags) {
    const pairs = Object.entries(tags).map(([key, value]) => `${quote(key)} = ${quote(value)}`);
    if (!pairs.length) return;
    await new Sql(this.client).execute(`ALTER SCHEMA ${ident(catalog)}.${ident(schema2)} SET TAGS (${pairs.join(", ")})`, { warehouseId, timeoutMs: 12e4 });
  }
};

// packages/core/src/cli.ts
var EXPIRY_MARGIN_MS = 3 * 6e4;
var DEFAULT_LIFETIME_MS = 30 * 6e4;

// packages/core/src/service.ts
var SERVICE_NAME = "databricks";
var CORE_PLUGIN_ID = "bkvarda.databricks";
var SETTINGS_SECTION = `${CORE_PLUGIN_ID}/connection`;
function withDatabricks(ctx, member, apply2) {
  ctx.inject([SERVICE_NAME], (scope) => {
    const databricks = scope.databricks;
    if (!databricks || databricks.version !== 1) return;
    const leave = databricks.announce?.(member);
    if (leave) scope.effect(() => leave);
    apply2(scope, databricks);
  });
}
function useConnection(service) {
  return React.useSyncExternalStore(service.subscribe, service.snapshot);
}
function usePreference(service, name) {
  const value = React.useSyncExternalStore(
    service.preferences.subscribe,
    () => JSON.stringify(service.preferences.get(name) ?? null)
  );
  const parsed = React.useMemo(() => JSON.parse(value), [value]);
  return [parsed ?? void 0, (next) => service.preferences.set(name, next)];
}
function useAsync(load, key) {
  const [state, setState] = React.useState({ loading: true });
  const [nonce, setNonce] = React.useState(0);
  React.useEffect(() => {
    const controller = new AbortController();
    setState((previous) => ({ ...previous, loading: true }));
    load(controller.signal).then(
      (data) => {
        if (!controller.signal.aborted) setState({ data, loading: false });
      },
      (error) => {
        if (!controller.signal.aborted)
          setState({ error: error instanceof Error ? error : new Error(String(error)), loading: false });
      }
    );
    return () => controller.abort();
  }, [...key, nonce]);
  return { ...state, reload: () => setNonce((n) => n + 1) };
}
function isApiError(error) {
  return error instanceof Error && error.name === "DatabricksApiError";
}
function describeError(error) {
  if (isApiError(error)) {
    if (error.isPermission) return `You don't have access: ${error.message}`;
    if (error.isFeatureDisabled) return `This isn't enabled in your workspace: ${error.message}`;
    return error.message;
  }
  if (error instanceof Error) return error.message;
  return String(error);
}

// packages/core/src/warehouse.ts
async function resolveWarehouse(service, explicit) {
  const client = await service.ready();
  const sql = new Sql(client);
  const warehouses = await sql.warehouses();
  const preferred = explicit || service.preferences.get("warehouseId");
  const chosen = preferred && warehouses.find((w) => w.id === preferred || w.name === preferred) || Sql.pick(warehouses);
  if (!chosen) throw new Error("No SQL warehouse is available to you in this workspace.");
  return { id: chosen.id, name: chosen.name };
}

// packages/core/src/skill-catalog.ts
var SKILL_LOCATIONS = "skillLocations";
var FRESH_MS = 5 * 6e4;
var IDLE = { status: "idle", schemas: [], skills: [] };
var hostOf = (service) => {
  const snapshot = service.snapshot();
  return snapshot.status === "connected" ? snapshot.profile.host : void 0;
};
var schemaOf = (fullName) => fullName.split(".").slice(0, 2).join(".");
var SkillCatalog = class {
  constructor(service) {
    this.service = service;
    service.subscribe(() => {
      const host = hostOf(service);
      if (host === this.host) return;
      this.host = host;
      this.loading = void 0;
      this.set(IDLE);
    });
    this.host = hostOf(service);
  }
  state = IDLE;
  host;
  loading;
  listeners = /* @__PURE__ */ new Set();
  snapshot = () => this.state;
  subscribe = (listener) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };
  /** Schemas the person added by hand. */
  locations() {
    return this.service.preferences.get(SKILL_LOCATIONS) ?? [];
  }
  setLocations(locations) {
    const clean = [...new Set(locations.map((location) => location.trim()).filter((location) => /^[^.\s]+\.[^.\s]+$/.test(location)))];
    this.service.preferences.set(SKILL_LOCATIONS, clean.length ? clean : void 0);
    void this.load(true);
  }
  /** Discovers schemas and lists their skills; reuses a fresh result unless `force`. */
  load(force = false) {
    if (!force && this.state.status === "ready" && this.state.at && Date.now() - this.state.at < FRESH_MS) return Promise.resolve(this.state);
    if (this.loading && !force) return this.loading;
    const host = this.host;
    this.set({ ...this.state, status: "loading" });
    let loading;
    loading = (async () => {
      try {
        const client = await this.service.ready();
        let tagged = [];
        let note;
        try {
          const warehouse = await resolveWarehouse(this.service);
          tagged = await new Tags(client).schemas(warehouse.id, [SKILLS_TAG, CHANNEL_TAG, DOMAIN_TAG]);
        } catch (error) {
          note = `Couldn't look for tagged skills schemas: ${describeError(error)}`;
        }
        const byName = /* @__PURE__ */ new Map();
        for (const row of tagged) {
          const name = `${row.catalog}.${row.schema}`;
          const entry = byName.get(name) ?? { tags: {}, source: "tag" };
          entry.tags[row.tag] = row.value;
          byName.set(name, entry);
        }
        for (const [name, entry] of byName) if (!(SKILLS_TAG in entry.tags) && !(CHANNEL_TAG in entry.tags)) byName.delete(name);
        for (const location of this.locations()) if (!byName.has(location)) byName.set(location, { tags: {}, source: "added" });
        const schemas = [...byName].map(([schema2, entry]) => ({ schema: schema2, ...entry })).sort((a, b) => a.schema.localeCompare(b.schema));
        const skills = schemas.length ? await this.listSkills(schemas.map((entry) => entry.schema)) : [];
        const next = { status: "ready", schemas, skills, at: Date.now(), ...note && { note } };
        if (host === this.host) this.set(next);
        return next;
      } catch (error) {
        const next = { status: "error", schemas: [], skills: [], error: describeError(error) };
        if (host === this.host) this.set(next);
        return next;
      } finally {
        if (this.loading === loading) this.loading = void 0;
      }
    })();
    this.loading = loading;
    return loading;
  }
  /** All skills in these schemas: the registry first, the REST API if it fails. */
  async listSkills(schemas) {
    const skills = new Skills(await this.service.ready());
    try {
      return await skills.registry(schemas);
    } catch {
      const lists = await Promise.all(
        schemas.map(async (schema2) => {
          const [catalog, name] = schema2.split(".");
          return (await skills.list(catalog, name).catch(() => [])).filter((skill) => skill.finalize_time || skill.bundle_name);
        })
      );
      return lists.flat().map((skill) => ({ fullName: skill.name.replace(/^skills\//, ""), description: skill.description ?? skill.comment ?? "" })).sort((a, b) => a.fullName.localeCompare(b.fullName));
    }
  }
  async search(query, limit = 20) {
    const state = await this.load();
    return { skills: searchSkills(state.skills, query, limit), state };
  }
  /** The schema linked to a Buzz channel, if anyone set one up. */
  async channel(channelId) {
    const find = (state2) => {
      const entry = state2.schemas.find((schema2) => schema2.tags[CHANNEL_TAG] === channelId);
      return entry && { schema: entry.schema, channelId, ...entry.tags[DOMAIN_TAG] && { domainId: entry.tags[DOMAIN_TAG] } };
    };
    const state = await this.load();
    const found = find(state);
    if (found || !state.at || Date.now() - state.at < 6e4) return found;
    return find(await this.load(true));
  }
  /** The skills in a channel's schema. */
  async channelSkills(channelId) {
    const link = await this.channel(channelId);
    if (!link) return [];
    return this.state.skills.filter((skill) => schemaOf(skill.fullName) === link.schema);
  }
  set(state) {
    this.state = state;
    for (const listener of [...this.listeners]) listener();
  }
};

// packages/core/src/host-types.ts
function optionalService(ctx, name) {
  try {
    return ctx.reflect?.get?.(name);
  } catch {
    return void 0;
  }
}
var schema = {
  object(properties, required = []) {
    return { type: "object", properties, required, additionalProperties: false };
  },
  string(description, extra = {}) {
    return { type: "string", description, ...extra };
  },
  integer(description, extra = {}) {
    return { type: "integer", description, ...extra };
  },
  boolean(description) {
    return { type: "boolean", description };
  }
};
function stringArg(args, name, required = true) {
  const value = args[name];
  if (typeof value === "string" && value.trim()) return value.trim();
  if (required) throw new Error(`${name} is required.`);
  return "";
}
function numberArg(args, name, fallback, min, max) {
  const value = args[name];
  const parsed = typeof value === "number" ? value : typeof value === "string" ? Number(value) : Number.NaN;
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, Math.round(parsed)));
}

// packages/core/src/ui/theme.ts
var BRAND = {
  lava: "#FF3621",
  lavaStrong: "#E5301D",
  navy: "#0B2026",
  oat: "#F9F7F4",
  oatMedium: "#EEEDE9",
  green: "#00A972",
  amber: "#FBB300",
  blue: "#4462C9",
  teal: "#1B5162"
};
var STYLE_ID = "dbx-buzz-plugins-style-v1";
var STYLESHEET = `
[data-dbx] {
  --dbx-lava: ${BRAND.lava};
  --dbx-lava-strong: ${BRAND.lavaStrong};
  --dbx-lava-text: #C4290F;
  --dbx-brand-tint: rgba(255, 54, 33, 0.08);
  --dbx-brand-tint-strong: rgba(255, 54, 33, 0.16);
  --dbx-ink: var(--text-standard, #0F0F0F);
  --dbx-subtle: var(--text-subtle, #5D6670);
  --dbx-tertiary: var(--text-tertiary, var(--text-subtle, #7A828A));
  --dbx-border: var(--border-standard, #E4E2DD);
  --dbx-border-strong: var(--border-prominent, #C4CCD6);
  --dbx-surface: var(--surface-panel, #FFFFFF);
  --dbx-inset: var(--surface-inset, #F6F5F2);
  --dbx-popover: var(--surface-popover, #FFFFFF);
  --dbx-success: var(--text-success, #00804F);
  --dbx-warning: var(--text-warning, #9A6A00);
  --dbx-danger: var(--text-danger, #C4290F);
  --dbx-chart-1: #FF3621; --dbx-chart-2: #4462C9; --dbx-chart-3: #00A972;
  --dbx-chart-4: #FBB300; --dbx-chart-5: #FF7033; --dbx-chart-6: #003159;
  --dbx-chart-7: #A0AEC0; --dbx-chart-8: #98102A;
  --dbx-radius: var(--radius-control, 8px);
  --dbx-radius-card: var(--radius-card, 12px);
  color: var(--dbx-ink);
}
.dark [data-dbx] {
  --dbx-lava-text: #FF7A66;
  --dbx-brand-tint: rgba(255, 90, 71, 0.14);
  --dbx-brand-tint-strong: rgba(255, 90, 71, 0.24);
  --dbx-chart-6: #6FA8BA; --dbx-chart-8: #E0607A;
}
[data-dbx] *, [data-dbx] *::before, [data-dbx] *::after { box-sizing: border-box; }
[data-dbx] .dbx-btn {
  display: inline-flex; align-items: center; justify-content: center; gap: 6px;
  min-height: 28px; padding: 0 12px; border-radius: var(--dbx-radius);
  border: 1px solid transparent; font: inherit; font-size: 0.8125rem; font-weight: 500;
  cursor: pointer; white-space: nowrap; transition: background-color 120ms ease, border-color 120ms ease;
  background: var(--affordance-subtle, #EFEFEF); color: var(--dbx-ink);
}
[data-dbx] .dbx-btn:hover:not(:disabled) { background: var(--affordance-subtle-hover, #E5E5E5); }
[data-dbx] .dbx-btn:focus-visible { outline: 2px solid var(--border-focus, #4462C9); outline-offset: 2px; }
[data-dbx] .dbx-btn:disabled { cursor: default; opacity: 0.55; }
[data-dbx] .dbx-btn[data-variant="primary"] { background: var(--affordance-prominent, #0F0F0F); color: var(--text-on-prominent, #FFF); }
[data-dbx] .dbx-btn[data-variant="primary"]:hover:not(:disabled) { background: var(--affordance-prominent-hover, #2A2A2A); }
[data-dbx] .dbx-btn[data-variant="brand"] { background: var(--dbx-lava-strong); color: #FFFFFF; }
[data-dbx] .dbx-btn[data-variant="brand"]:hover:not(:disabled) { background: #C4290F; }
[data-dbx] .dbx-btn[data-variant="ghost"] { background: transparent; }
[data-dbx] .dbx-btn[data-variant="ghost"]:hover:not(:disabled) { background: var(--affordance-subtle-hover, #EFEFEF); }
[data-dbx] .dbx-btn[data-variant="danger"] { background: transparent; color: var(--dbx-danger); border-color: var(--dbx-border); }
[data-dbx] .dbx-btn[data-size="sm"] { min-height: 24px; padding: 0 8px; font-size: 0.75rem; }
[data-dbx] .dbx-icon-btn { padding: 0; width: 28px; }
[data-dbx] .dbx-input, [data-dbx] .dbx-select, [data-dbx] .dbx-textarea {
  width: 100%; font: inherit; font-size: 0.8125rem; color: var(--dbx-ink);
  background: var(--surface-composer, var(--dbx-surface)); border: 1px solid var(--dbx-border);
  border-radius: var(--dbx-radius); padding: 6px 10px; min-height: 30px;
}
[data-dbx] .dbx-textarea { resize: vertical; line-height: 1.45; }
[data-dbx] .dbx-input:focus, [data-dbx] .dbx-select:focus, [data-dbx] .dbx-textarea:focus {
  outline: none; border-color: var(--border-focus, #4462C9); box-shadow: 0 0 0 1px var(--border-focus, #4462C9);
}
[data-dbx] select.dbx-select, [data-dbx] .dbx-picker-trigger {
  -webkit-appearance: none; appearance: none; padding-right: 30px; line-height: 1.3;
  background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='10' height='6' viewBox='0 0 10 6'%3E%3Cpath d='M1 1l4 4 4-4' fill='none' stroke='%238A9199' stroke-width='1.5' stroke-linecap='round' stroke-linejoin='round'/%3E%3C/svg%3E");
  background-repeat: no-repeat; background-position: right 11px center; background-size: 10px 6px;
}
[data-dbx] .dbx-picker-trigger { display: flex; align-items: center; gap: 8px; text-align: left; cursor: pointer; }
[data-dbx] .dbx-picker-trigger > span { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
[data-dbx] .dbx-picker-anchor { position: relative; }
[data-dbx] .dbx-picker[data-floating] { position: absolute; top: calc(100% + 4px); left: 0; right: 0; z-index: 30; box-shadow: 0 8px 24px rgba(15, 15, 15, 0.12), 0 1px 3px rgba(15, 15, 15, 0.08); }
[data-dbx] .dbx-picker-trigger:disabled { cursor: default; opacity: 0.6; }
[data-dbx] .dbx-picker { border: 1px solid var(--dbx-border); border-radius: var(--dbx-radius); background: var(--dbx-popover); overflow: hidden; }
[data-dbx] .dbx-picker > .dbx-input { border: 0; border-bottom: 1px solid var(--dbx-border); border-radius: 0; box-shadow: none; }
[data-dbx] .dbx-picker-list { overflow: auto; overscroll-behavior: contain; padding: 4px 0; }
[data-dbx] .dbx-picker-group { position: sticky; top: -4px; z-index: 1; background: var(--dbx-popover); padding: 6px 10px 3px; font-size: 0.6875rem; font-weight: 500; color: var(--dbx-tertiary); text-transform: uppercase; letter-spacing: 0.03em; }
[data-dbx] .dbx-picker-option { display: flex; gap: 8px; align-items: flex-start; width: 100%; margin: 0; padding: 6px 10px; border: 0; border-radius: 0; background: transparent; font: inherit; font-size: 0.8125rem; line-height: 1.4; color: var(--dbx-ink); text-align: left; cursor: pointer; box-shadow: none; }
[data-dbx] .dbx-picker-option > .dbx-picker-text { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 1px; }
[data-dbx] .dbx-picker-option .dbx-picker-meta { flex: none; max-width: 45%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-family: var(--font-mono, ui-monospace, monospace); font-size: 0.6875rem; color: var(--dbx-tertiary); padding-top: 2px; }
[data-dbx] .dbx-picker-option .dbx-picker-check { flex: none; width: 14px; color: var(--dbx-lava-text); font-weight: 600; }
[data-dbx] .dbx-picker-option:hover, [data-dbx] .dbx-picker-option:focus-visible { background: var(--dbx-inset); outline: none; }
[data-dbx] .dbx-picker-option[aria-selected="true"] { background: var(--dbx-brand-tint); }
[data-dbx] .dbx-picker-option:disabled { cursor: default; opacity: 0.55; }
[data-dbx] .dbx-picker-option input { margin: 3px 0 0; flex: none; pointer-events: none; }
[data-dbx] .dbx-chip { display: inline-flex; align-items: center; gap: 4px; max-width: 100%; padding: 2px 4px 2px 8px; border: 1px solid var(--dbx-border); border-radius: 999px; background: var(--dbx-inset); font-size: 0.75rem; }
[data-dbx] .dbx-chip > span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
[data-dbx] .dbx-chip button { border: 0; background: transparent; color: var(--dbx-subtle); cursor: pointer; padding: 0 3px; font: inherit; line-height: 1; }
[data-dbx] .dbx-card { background: var(--dbx-surface); border: 1px solid var(--dbx-border); border-radius: var(--dbx-radius-card); }
dialog.dbx-modal { padding: 0; border: 1px solid var(--border-standard, #E0E0E0); border-radius: 12px; background: var(--surface-panel, #FFFFFF); color: var(--text-standard, #161616); width: min(640px, calc(100vw - 32px)); max-height: 86vh; box-shadow: 0 16px 48px rgba(0, 0, 0, 0.25); }
dialog.dbx-modal::backdrop { background: rgba(0, 0, 0, 0.35); }
[data-dbx] .dbx-row:hover { background: var(--affordance-row-hover, var(--affordance-subtle-hover, #F2F2F2)); }
[data-dbx] .dbx-row[aria-selected="true"] { background: var(--affordance-selected, var(--affordance-subtle, #EDEDED)); }
[data-dbx] .dbx-mono { font-family: var(--font-mono, ui-monospace, SFMono-Regular, Menlo, monospace); }
[data-dbx] .dbx-table { border-collapse: separate; border-spacing: 0; width: 100%; font-size: 0.75rem; }
[data-dbx] .dbx-table th { position: sticky; top: 0; z-index: 1; background: var(--dbx-inset); text-align: left; font-weight: 500; color: var(--dbx-subtle); }
[data-dbx] .dbx-table th, [data-dbx] .dbx-table td { padding: 5px 10px; border-bottom: 1px solid var(--dbx-border); white-space: nowrap; max-width: 320px; overflow: hidden; text-overflow: ellipsis; }
[data-dbx] .dbx-table td[data-numeric="true"], [data-dbx] .dbx-table th[data-numeric="true"] { text-align: right; font-variant-numeric: tabular-nums; }
[data-dbx] .dbx-table tbody tr:hover td { background: var(--affordance-row-hover, rgba(127,127,127,0.06)); }
[data-dbx] .dbx-link { color: var(--text-link, #2272B4); text-decoration: none; cursor: pointer; background: none; border: 0; padding: 0; font: inherit; }
[data-dbx] .dbx-link:hover { text-decoration: underline; }
[data-dbx] .dbx-md a.dbx-link { text-decoration: underline; text-decoration-color: color-mix(in srgb, currentColor 40%, transparent); text-underline-offset: 2px; }
[data-dbx] .dbx-md a.dbx-link:hover { text-decoration-color: currentColor; }
[data-dbx] .dbx-md p { margin: 0 0 8px; }
[data-dbx] .dbx-md p:last-child { margin-bottom: 0; }
[data-dbx] .dbx-md ul, [data-dbx] .dbx-md ol { margin: 0 0 8px; padding-left: 20px; }
[data-dbx] .dbx-md code { font-family: var(--font-mono, ui-monospace, monospace); font-size: 0.92em; background: var(--dbx-inset); padding: 1px 4px; border-radius: 4px; }
[data-dbx] .dbx-md pre { background: var(--dbx-inset); padding: 10px 12px; border-radius: var(--dbx-radius); overflow: auto; }
[data-dbx] .dbx-md pre code { background: none; padding: 0; }
@keyframes dbx-spin { to { transform: rotate(360deg); } }
@keyframes dbx-pulse { 0%, 100% { opacity: 0.35; } 50% { opacity: 1; } }
@media (prefers-reduced-motion: reduce) { [data-dbx] * { animation-duration: 0s !important; transition: none !important; } }
`;
function styleHash(text2) {
  let hash = 5381;
  for (let i = 0; i < text2.length; i++) hash = (hash << 5) + hash + text2.charCodeAt(i) | 0;
  return (hash >>> 0).toString(36);
}
var STYLE_ELEMENT_ID = `${STYLE_ID}-${styleHash(STYLESHEET)}`;
function ensureStyles(doc = globalThis.document) {
  if (!doc || doc.getElementById(STYLE_ELEMENT_ID)) return;
  const style = doc.createElement("style");
  style.id = STYLE_ELEMENT_ID;
  style.textContent = STYLESHEET;
  doc.head.appendChild(style);
}
var DATABRICKS_MARK_PATH = "M283.923 136.449L150.144 213.624L6.88995 131.168L0 134.982V194.844L150.144 281.115L283.923 204.234V235.926L150.144 313.1L6.88995 230.644L0 234.458V244.729L150.144 331L300 244.729V184.867L293.11 181.052L150.144 263.215L16.0766 186.334V154.643L150.144 231.524L300 145.253V86.2713L292.536 81.8697L150.144 163.739L22.9665 90.9663L150.144 17.8998L254.641 78.055L263.828 72.773V65.4371L150.144 0L0 86.2713V95.6613L150.144 181.933L283.923 104.758V136.449Z";
var DATABRICKS_MARK_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 300 331" fill="none"><path fill="#FF3621" d="${DATABRICKS_MARK_PATH}"/></svg>`;
var DATABRICKS_MARK_MONO_SVG = DATABRICKS_MARK_SVG.replace(
  'fill="#FF3621"',
  'fill="currentColor"'
);
var svgDataUri = (svg) => `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`;
var DATABRICKS_ICON = svgDataUri(DATABRICKS_MARK_SVG);
var DATABRICKS_ICON_MONO = svgDataUri(DATABRICKS_MARK_MONO_SVG);

// packages/core/src/ui/components.tsx
function DbxRoot(props) {
  ensureStyles();
  return /* @__PURE__ */ React.createElement("div", { "data-dbx": "", className: props.className, style: props.style }, props.children);
}
function DatabricksMark(props) {
  const size = props.size ?? 16;
  const svg = props.color === "current" ? DATABRICKS_MARK_SVG.replace('fill="#FF3621"', 'fill="currentColor"') : DATABRICKS_MARK_SVG;
  return /* @__PURE__ */ React.createElement(
    "span",
    {
      role: props.title ? "img" : void 0,
      "aria-label": props.title,
      "aria-hidden": props.title ? void 0 : true,
      style: { display: "inline-flex", width: size, height: size * 1.1, flex: "none" },
      dangerouslySetInnerHTML: { __html: svg.replace("<svg ", `<svg width="${size}" height="${size * 1.1}" `) }
    }
  );
}
function Button(props) {
  return /* @__PURE__ */ React.createElement(
    "button",
    {
      type: props.type ?? "button",
      className: `dbx-btn${props.icon ? " dbx-icon-btn" : ""}`,
      "data-variant": props.variant ?? "default",
      "data-size": props.size ?? "md",
      disabled: props.disabled,
      onClick: props.onClick,
      title: props.title,
      "aria-label": props["aria-label"],
      style: props.style
    },
    props.children
  );
}
function Spinner(props) {
  const size = props.size ?? 14;
  return /* @__PURE__ */ React.createElement(
    "span",
    {
      role: "status",
      "aria-label": props.label ?? "Loading",
      style: {
        display: "inline-block",
        width: size,
        height: size,
        borderRadius: "50%",
        border: "2px solid var(--dbx-border-strong)",
        borderTopColor: "var(--dbx-lava)",
        animation: "dbx-spin 0.8s linear infinite",
        flex: "none"
      }
    }
  );
}
function Stack(props) {
  return /* @__PURE__ */ React.createElement(
    "div",
    {
      style: {
        display: "flex",
        flexDirection: props.direction ?? "column",
        gap: props.gap ?? 8,
        alignItems: props.align,
        justifyContent: props.justify,
        flexWrap: props.wrap ? "wrap" : void 0,
        minWidth: 0,
        ...props.style
      }
    },
    props.children
  );
}
function Text(props) {
  const color = {
    standard: "var(--dbx-ink)",
    subtle: "var(--dbx-subtle)",
    tertiary: "var(--dbx-tertiary)",
    danger: "var(--dbx-danger)",
    success: "var(--dbx-success)",
    warning: "var(--dbx-warning)",
    brand: "var(--dbx-lava-text)"
  }[props.tone ?? "standard"];
  const fontSize = { xs: "0.6875rem", sm: "0.75rem", md: "0.8125rem", lg: "0.9375rem", xl: "1.125rem" }[props.size ?? "md"];
  const Tag = props.as ?? "span";
  return React.createElement(
    Tag,
    {
      id: props.id,
      className: props.mono ? "dbx-mono" : void 0,
      style: {
        margin: 0,
        color,
        fontSize,
        fontWeight: props.weight ?? (Tag.startsWith("h") ? 500 : 400),
        lineHeight: 1.45,
        ...props.style
      }
    },
    props.children
  );
}
function Card(props) {
  return /* @__PURE__ */ React.createElement("div", { className: "dbx-card", style: { padding: props.padding ?? 16, ...props.style } }, props.children);
}
function openExternal(url, doc = document) {
  const link = doc.createElement("a");
  link.href = url;
  link.target = "_blank";
  link.rel = "noreferrer";
  link.style.display = "none";
  doc.body.appendChild(link);
  link.click();
  link.remove();
}
function Notice(props) {
  const tone = props.tone ?? "info";
  const accent = {
    info: "var(--dbx-border-strong)",
    warning: "var(--dbx-warning)",
    danger: "var(--dbx-danger)",
    success: "var(--dbx-success)"
  }[tone];
  return /* @__PURE__ */ React.createElement(
    "div",
    {
      role: tone === "danger" ? "alert" : "status",
      style: {
        display: "flex",
        gap: 12,
        alignItems: "flex-start",
        justifyContent: "space-between",
        padding: "10px 12px",
        borderRadius: "var(--dbx-radius)",
        border: "1px solid var(--dbx-border)",
        background: "var(--dbx-inset)",
        boxShadow: `inset 3px 0 0 ${accent}`
      }
    },
    /* @__PURE__ */ React.createElement(Stack, { gap: 2, style: { minWidth: 0 } }, props.title && /* @__PURE__ */ React.createElement(Text, { weight: 500, size: "md" }, props.title), props.children && /* @__PURE__ */ React.createElement(Text, { tone: "subtle", size: "sm", as: "div" }, props.children)),
    props.action && /* @__PURE__ */ React.createElement("div", { style: { flex: "none" } }, props.action)
  );
}
function EmptyState(props) {
  return /* @__PURE__ */ React.createElement(
    Stack,
    {
      align: "center",
      gap: 10,
      style: { textAlign: "center", padding: "40px 24px", maxWidth: 420, margin: "0 auto" }
    },
    props.mark !== false && /* @__PURE__ */ React.createElement(DatabricksMark, { size: 28 }),
    /* @__PURE__ */ React.createElement(Text, { as: "h3", size: "lg", weight: 500 }, props.title),
    props.children && /* @__PURE__ */ React.createElement(Text, { tone: "subtle", as: "div" }, props.children),
    props.action
  );
}
function Badge(props) {
  const tone = props.tone ?? "neutral";
  const color = {
    neutral: "var(--dbx-subtle)",
    brand: "var(--dbx-lava-text)",
    success: "var(--dbx-success)",
    warning: "var(--dbx-warning)",
    danger: "var(--dbx-danger)"
  }[tone];
  return /* @__PURE__ */ React.createElement(
    "span",
    {
      title: props.title,
      style: {
        display: "inline-flex",
        alignItems: "center",
        gap: 4,
        padding: "1px 7px",
        borderRadius: 999,
        fontSize: "0.6875rem",
        fontWeight: 500,
        lineHeight: 1.6,
        color,
        background: tone === "brand" ? "var(--dbx-brand-tint)" : "var(--dbx-inset)",
        border: "1px solid var(--dbx-border)",
        whiteSpace: "nowrap"
      }
    },
    props.children
  );
}
function Field(props) {
  return /* @__PURE__ */ React.createElement("label", { style: { display: "flex", flexDirection: "column", gap: 4, minWidth: 0 }, htmlFor: props.id }, /* @__PURE__ */ React.createElement(Text, { size: "sm", weight: 500 }, props.label), props.children, props.hint && /* @__PURE__ */ React.createElement(Text, { size: "xs", tone: "subtle", as: "div" }, props.hint));
}
function SectionHeader(props) {
  return /* @__PURE__ */ React.createElement("div", { style: { display: "flex", alignItems: "flex-end", justifyContent: "space-between", gap: 12 } }, /* @__PURE__ */ React.createElement(Stack, { gap: 2 }, /* @__PURE__ */ React.createElement(Text, { as: "h3", size: "md", weight: 500 }, props.title), props.description && /* @__PURE__ */ React.createElement(Text, { tone: "subtle", size: "sm", as: "div" }, props.description)), props.action);
}
function CopyButton(props) {
  const [copied, setCopied] = React.useState(false);
  return /* @__PURE__ */ React.createElement(
    Button,
    {
      size: "sm",
      variant: "ghost",
      onClick: () => {
        void navigator.clipboard?.writeText(props.text).then(() => {
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        });
      }
    },
    copied ? "Copied" : props.label ?? "Copy"
  );
}
function CodeView(props) {
  return /* @__PURE__ */ React.createElement("div", { style: { position: "relative" } }, /* @__PURE__ */ React.createElement(
    "pre",
    {
      className: "dbx-mono",
      style: {
        margin: 0,
        padding: "10px 12px",
        background: "var(--dbx-inset)",
        border: "1px solid var(--dbx-border)",
        borderRadius: "var(--dbx-radius)",
        fontSize: "0.75rem",
        lineHeight: 1.5,
        overflow: "auto",
        maxHeight: props.maxHeight ?? 260,
        whiteSpace: "pre"
      }
    },
    /* @__PURE__ */ React.createElement("code", null, props.code)
  ), props.copy !== false && /* @__PURE__ */ React.createElement("div", { style: { position: "absolute", top: 4, right: 4 } }, /* @__PURE__ */ React.createElement(CopyButton, { text: props.code })));
}
function Disclosure(props) {
  return /* @__PURE__ */ React.createElement("details", { open: props.defaultOpen }, /* @__PURE__ */ React.createElement("summary", { style: { cursor: "pointer", fontSize: "0.75rem", color: "var(--dbx-subtle)", userSelect: "none" } }, props.summary), /* @__PURE__ */ React.createElement("div", { style: { marginTop: 8 } }, props.children));
}
function Modal(props) {
  const ref = React.useRef(null);
  const onClose = React.useRef(props.onClose);
  onClose.current = props.onClose;
  React.useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (!dialog.open) {
      if (typeof dialog.showModal === "function") dialog.showModal();
      else dialog.setAttribute("open", "");
    }
    const cancel = (event) => {
      event.preventDefault();
      onClose.current();
    };
    dialog.addEventListener("cancel", cancel);
    return () => {
      dialog.removeEventListener("cancel", cancel);
      if (dialog.open && typeof dialog.close === "function") dialog.close();
    };
  }, []);
  ensureStyles();
  return /* @__PURE__ */ React.createElement("dialog", { ref, className: "dbx-modal", "aria-label": props.title }, /* @__PURE__ */ React.createElement(DbxRoot, { style: { padding: 20, overflow: "auto" } }, /* @__PURE__ */ React.createElement(Stack, { gap: 14 }, /* @__PURE__ */ React.createElement(Stack, { direction: "row", justify: "space-between", align: "center", gap: 8 }, /* @__PURE__ */ React.createElement(Text, { as: "h2", size: "xl", weight: 500 }, props.title), /* @__PURE__ */ React.createElement(Button, { variant: "ghost", size: "sm", "aria-label": "Close", onClick: () => onClose.current() }, "\u2715")), props.children)));
}

// packages/core/src/suite.tsx
var REPOSITORY = "https://github.com/bkvarda/databricks-buzz-plugins";
var Live = class {
  value;
  listeners = /* @__PURE__ */ new Set();
  snapshot = () => this.value;
  subscribe = (listener) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };
  set(value) {
    this.value = value;
    for (const listener of [...this.listeners]) listener();
  }
};
function attach(ctx, member, apply2) {
  const live = new Live();
  withDatabricks(ctx, member, (scope, databricks) => {
    live.set(apply2(scope, databricks));
    scope.effect(() => () => live.set(void 0));
  });
  return live;
}
function useLive(live) {
  return React.useSyncExternalStore(live.subscribe, live.snapshot);
}
function MissingCore(props) {
  const [message, setMessage] = React.useState();
  const add = async () => {
    const installer = optionalService(props.ctx, "pluginInstaller");
    if (!installer) {
      setMessage("Add it from Settings \u2192 Plugins \u2192 Manage plugins \u2192 Add, using github.com/bkvarda/databricks-buzz-plugins.");
      return;
    }
    const outcome = await installer.requestInstall({ repository: REPOSITORY, reference: "main", path: "plugins/databricks/dist" }).catch(() => "unavailable");
    if (outcome === "unavailable") setMessage("Close any open plugin review and try again.");
  };
  return /* @__PURE__ */ React.createElement(DbxRoot, { style: { padding: 32 } }, /* @__PURE__ */ React.createElement(
    EmptyState,
    {
      title: "Add the Databricks plugin",
      action: /* @__PURE__ */ React.createElement(Button, { variant: "brand", onClick: () => void add() }, "Add Databricks")
    },
    props.feature,
    " uses the Databricks plugin (",
    CORE_PLUGIN_ID,
    ") for sign-in. Add it, or turn it back on in Settings \u2192 Plugins.",
    message && /* @__PURE__ */ React.createElement("p", null, message)
  ));
}

// packages/core/src/api/domains.ts
var domainTitle = (domain) => domain.tag_key.split("/").pop() ?? domain.tag_key;
var Domains = class {
  constructor(client) {
    this.client = client;
  }
  async list(options = {}) {
    const domains = [];
    let pageToken;
    for (let page = 0; page < 50; page++) {
      const response = await this.client.get("/api/2.0/domains", {
        query: { page_size: 100, page_token: pageToken, parent_domain_id: options.parentDomainId },
        ...options.signal && { signal: options.signal }
      });
      domains.push(...response.domains ?? []);
      pageToken = response.next_page_token;
      if (!pageToken) break;
    }
    return domains.sort((a, b) => a.tag_key.localeCompare(b.tag_key));
  }
  get(name) {
    return this.client.get(`/api/2.0/${domainName(name)}`);
  }
  /**
   * Creates a domain; `draft` defaults to true here so nothing is published by
   * surprise. A governed tag policy with the same key must exist first (else
   * "Tag policy with name X not found"); accounts have a cap on policies.
   */
  create(domain) {
    return this.client.post("/api/2.0/domains", { draft: true, ...domain });
  }
  update(name, fields, domain) {
    const mask = Object.keys(fields).join(",");
    return this.client.json(`/api/2.0/${domainName(name)}`, { method: "PATCH", body: { tag_key: domain.tag_key, ...fields }, query: { update_mask: mask } });
  }
  delete(name, force = false) {
    return this.client.json(`/api/2.0/${domainName(name)}`, { method: "DELETE", query: { force: force ? "true" : void 0 } });
  }
};
var domainName = (nameOrId) => nameOrId.startsWith("domains/") ? nameOrId : `domains/${nameOrId}`;

// packages/core/src/api/pages.ts
var quoted = (value) => `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
var Pages = class {
  constructor(client) {
    this.client = client;
  }
  /** Whether the Pages API is on in this deployment (it answers 501 when it isn't). */
  async available() {
    const response = await this.client.request("/api/2.0/knowledge/pages", { method: "GET", query: { page_size: 1 } });
    return response.status !== 501 && response.status !== 404;
  }
  /** Pages in a domain (and its subdomains), optionally in one state. */
  async list(options = {}) {
    const filter = [options.domain && `domain = ${quoted(options.domain)}`, options.state && `state = ${quoted(options.state)}`].filter(Boolean).join(" AND ");
    const pages = [];
    let pageToken;
    for (let page = 0; page < 50; page++) {
      const response = await this.client.get("/api/2.0/knowledge/pages", {
        query: { page_size: 100, page_token: pageToken, filter: filter || void 0 },
        ...options.signal && { signal: options.signal }
      });
      pages.push(...response.pages ?? []);
      pageToken = response.next_page_token;
      if (!pageToken) break;
    }
    return pages;
  }
  get(name) {
    return this.client.get(`/api/2.0/knowledge/${pageName(name)}`);
  }
  /** Creates a page; a draft unless `state` says otherwise. `requestId` makes retries safe. */
  create(page, requestId) {
    return this.client.post("/api/2.0/knowledge/pages", { state: "DRAFT", ...page }, requestId ? { query: { request_id: requestId } } : {});
  }
  update(name, fields) {
    const mask = Object.keys(fields).join(",");
    if (!mask) throw new Error("Nothing to update.");
    return this.client.json(`/api/2.0/knowledge/${pageName(name)}`, { method: "PATCH", body: fields, query: { update_mask: mask } });
  }
  /** Adds a snippet to the end of a page's body (an update replaces the whole body). */
  async append(name, snippet) {
    const page = await this.get(name);
    const body = [page.body?.trimEnd(), snippet.trim()].filter(Boolean).join("\n\n");
    return this.update(name, { body });
  }
  delete(name) {
    return this.client.json(`/api/2.0/knowledge/${pageName(name)}`, { method: "DELETE" });
  }
};
var pageName = (nameOrId) => nameOrId.startsWith("pages/") ? nameOrId : `pages/${nameOrId}`;

// plugins/knowledge/src/domain-api.ts
async function everyPage(load) {
  const items = [];
  let pageToken;
  for (let page = 0; page < 100; page++) {
    const response = await load(pageToken);
    items.push(...response.items ?? []);
    pageToken = response.next_page_token;
    if (!pageToken) break;
  }
  return items;
}
async function listCatalogs(client) {
  const catalogs = await everyPage(async (pageToken) => {
    const response = await client.get("/api/2.1/unity-catalog/catalogs", {
      query: { page_token: pageToken }
    });
    return { items: response.catalogs, next_page_token: response.next_page_token };
  });
  return catalogs.filter((catalog) => !catalog.catalog_type || catalog.catalog_type === "MANAGED_CATALOG").map((catalog) => catalog.name).sort((a, b) => a.localeCompare(b));
}
async function listSchemas(client, catalog) {
  const schemas = await everyPage(async (pageToken) => {
    const response = await client.get("/api/2.1/unity-catalog/schemas", {
      query: { catalog_name: catalog, page_token: pageToken }
    });
    return { items: response.schemas, next_page_token: response.next_page_token };
  });
  return schemas.map((schema2) => schema2.name).filter((name) => name !== "information_schema").sort((a, b) => a.localeCompare(b));
}
function errorCode(error) {
  return isApiError(error) ? error.errorCode : void 0;
}
var alreadyExists = (error) => {
  const code = errorCode(error);
  return code === "ALREADY_EXISTS" || code === "RESOURCE_ALREADY_EXISTS" || isApiError(error) && error.status === 409;
};
async function ensureTagPolicy(client, key, description) {
  try {
    await client.get(`/api/2.1/tag-policies/${encodeURIComponent(key)}`);
    return "exists";
  } catch (error) {
    if (!isApiError(error) || !error.isNotFound) throw error;
  }
  await client.post("/api/2.1/tag-policies", { tag_key: key, description });
  return "created";
}
var tagPolicyLimit = (error) => isApiError(error) && /maximum number of tag policies/i.test(error.message);

// plugins/knowledge/src/channel-setup.ts
var quoteIdent = (name) => `\`${name.replace(/`/g, "``")}\``;
var sqlPrincipal = (principal) => quoteIdent(principal);
var domainIdOf = (domain) => domain.domain_id ?? domain.name.replace(/^domains\//, "");
function refusal(error, ask, sql) {
  if (isApiError(error) && error.isPermission) return { status: "denied", detail: ask, ...sql && { sql } };
  return { status: "failed", detail: describeError(error) };
}
function schemaNameFor(channelName) {
  const base = channelName.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "") || "channel";
  return /^\d/.test(base) ? `c_${base}` : base;
}
var domainKey = (title, parent) => parent ? `${parent.tagKey}/${title}` : title;
async function domainStep(client, choice) {
  const tagKey = domainKey(choice.title, choice.parent);
  const id = "domain";
  const title = `Create the draft domain \u201C${choice.title}\u201D`;
  try {
    await ensureTagPolicy(client, tagKey, `Governs the \u201C${tagKey}\u201D domain.`);
  } catch (error) {
    if (tagPolicyLimit(error))
      return { step: { id, title, status: "failed", detail: "This account has reached its limit of tag policies, and a domain needs one. An account admin can free one up, or you can pick an existing domain." } };
    return { step: { id, title, ...refusal(error, `Creating a domain needs a tag policy named \u201C${tagKey}\u201D. Ask an account admin to create it, or pick an existing domain.`) } };
  }
  try {
    const domain = await new Domains(client).create({ tag_key: tagKey, draft: true, ...choice.description && { description: choice.description }, ...choice.parent && { parent_domain_id: choice.parent.id } });
    return { step: { id, title, status: "done", detail: "Its governed tag is ready, and nothing is published." }, domain: { id: domainIdOf(domain), tagKey } };
  } catch (error) {
    if (alreadyExists(error)) {
      try {
        const existing = (await new Domains(client).list()).find((domain) => domain.tag_key === tagKey);
        if (existing) return { step: { id, title: `Use the existing domain \u201C${choice.title}\u201D`, status: "done" }, domain: { id: domainIdOf(existing), tagKey } };
      } catch (listError) {
        return { step: { id, title, ...refusal(listError, "Finding the existing domain needs the MANAGE DISCOVERY permission. Ask an admin, or pick it from the list.") } };
      }
    }
    return { step: { id, title, ...refusal(error, `You can't create domains here. Ask an admin to create \u201C${tagKey}\u201D, or pick an existing domain.`) } };
  }
}
async function schemaStep(client, input, full) {
  const { catalog, name, create } = input.schema;
  const id = "schema";
  if (create) {
    try {
      await client.post("/api/2.1/unity-catalog/schemas", { name, catalog_name: catalog });
      return { id, title: `Create the schema ${full}`, status: "done" };
    } catch (error) {
      if (!alreadyExists(error))
        return {
          id,
          title: `Create the schema ${full}`,
          ...refusal(
            error,
            `Creating a schema needs CREATE SCHEMA on \u201C${catalog}\u201D. Ask an admin to grant it, or pick an existing schema.`,
            `GRANT CREATE SCHEMA ON CATALOG ${quoteIdent(catalog)} TO ${sqlPrincipal(input.viewer ?? "you@example.com")}`
          )
        };
    }
  }
  try {
    const current = await new Tags(client).list("schemas", full);
    const other = current.find((tag) => tag.tag_key === CHANNEL_TAG)?.tag_value;
    if (other && other !== input.channel.id)
      return { id, title: `Use ${full}`, status: "failed", detail: `${full} is already linked to another Buzz channel. Pick another schema, or unlink it in that channel first.` };
  } catch {
  }
  return { id, title: `Use the schema ${full}`, status: "done" };
}
async function setUpChannel(client, input) {
  const steps = [];
  const tags = new Tags(client);
  const full = `${input.schema.catalog}.${input.schema.name}`;
  const ask = `Tagging ${full} needs APPLY TAG on it. Ask the schema owner or an admin to grant it.`;
  const applyTag = `GRANT APPLY TAG ON SCHEMA ${quoteIdent(input.schema.catalog)}.${quoteIdent(input.schema.name)} TO ${sqlPrincipal(input.viewer ?? "you@example.com")}`;
  let domainId;
  let domainTag;
  if (input.domain.mode === "existing") {
    domainId = input.domain.id;
    domainTag = input.domain.tagKey;
    steps.push({ id: "domain", title: `Use the domain \u201C${input.domain.title}\u201D`, status: "done" });
  } else {
    const created = await domainStep(client, input.domain);
    steps.push(created.step);
    domainId = created.domain?.id;
    domainTag = created.domain?.tagKey;
  }
  const skip = (id, title, detail) => steps.push({ id, title, status: "skipped", detail });
  if (!domainId) {
    skip("schema", `Use the schema ${full}`, "Set up the domain first.");
    skip("tag-domain", "Add the schema to the domain", "No domain yet.");
    skip("tag-metadata", "Tag the schema for this channel", "No domain yet.");
    skip("link", "Link the channel", "The domain or schema isn't ready.");
    return { steps, linked: false, schema: full };
  }
  const schema2 = await schemaStep(client, input, full);
  steps.push(schema2);
  const ready = schema2.status === "done";
  if (domainTag && ready) {
    try {
      await tags.assign("schemas", full, domainTag, "");
      steps.push({ id: "tag-domain", title: "Add the schema to the domain", status: "done" });
    } catch (error) {
      steps.push({
        id: "tag-domain",
        title: "Add the schema to the domain",
        ...refusal(error, `Adding a schema to a domain needs the ASSIGN permission on its tag \u201C${domainTag}\u201D. Ask a domain admin.`)
      });
    }
  } else skip("tag-domain", "Add the schema to the domain", domainTag ? "The schema isn't ready." : "No domain yet.");
  if (ready) {
    try {
      await tags.assign("schemas", full, SKILLS_TAG, input.channel.name);
      await tags.assign("schemas", full, DOMAIN_TAG, domainId);
      steps.push({ id: "tag-metadata", title: "Tag the schema for this channel", status: "done" });
    } catch (error) {
      steps.push({ id: "tag-metadata", title: "Tag the schema for this channel", ...refusal(error, ask, applyTag) });
    }
  } else skip("tag-metadata", "Tag the schema for this channel", "The schema isn't ready.");
  let linked = false;
  if (ready) {
    try {
      await tags.assign("schemas", full, CHANNEL_TAG, input.channel.id);
      steps.push({ id: "link", title: "Link the channel", status: "done" });
      linked = true;
    } catch (error) {
      steps.push({ id: "link", title: "Link the channel", ...refusal(error, ask, applyTag) });
    }
  } else skip("link", "Link the channel", "The schema isn't ready.");
  if (input.principal && linked) {
    const principal = input.principal;
    try {
      await client.json(`/api/2.1/unity-catalog/permissions/schema/${encodeURIComponent(full)}`, {
        method: "PATCH",
        body: { changes: [{ principal, add: ["USE_SCHEMA", "READ_VOLUME"] }] }
      });
      steps.push({ id: "share-schema", title: `Let ${principal} use the skills`, status: "done" });
    } catch (error) {
      steps.push({
        id: "share-schema",
        title: `Let ${principal} use the skills`,
        ...refusal(error, `Granting access to ${full} needs MANAGE on it. Ask the schema owner or an admin.`, `GRANT USE SCHEMA, READ VOLUME ON SCHEMA ${quoteIdent(input.schema.catalog)}.${quoteIdent(input.schema.name)} TO ${sqlPrincipal(principal)}`)
      });
    }
    try {
      await client.json(`/api/2.1/unity-catalog/permissions/catalog/${encodeURIComponent(input.schema.catalog)}`, {
        method: "PATCH",
        body: { changes: [{ principal, add: ["USE_CATALOG"] }] }
      });
      steps.push({ id: "share-catalog", title: `Let ${principal} use the catalog`, status: "done" });
    } catch (error) {
      steps.push({
        id: "share-catalog",
        title: `Let ${principal} use the catalog`,
        ...refusal(error, `USE CATALOG usually needs a catalog owner or admin. Ask one to run the GRANT.`, `GRANT USE CATALOG ON CATALOG ${quoteIdent(input.schema.catalog)} TO ${sqlPrincipal(principal)}`)
      });
    }
  }
  return { steps, linked, ...domainId && { domainId }, schema: full };
}
function unlinkChannel(client, schema2) {
  return new Tags(client).remove("schemas", schema2, CHANNEL_TAG);
}

// plugins/knowledge/src/page-draft.ts
var PAGE_LANGUAGE = "databricks-page";
var PAGE_WARNING = "Pages may be copied to other regions and aren't encrypted with your company's keys, so don't include personal data.";
var PAGES_OFF = "Pages isn't turned on in this workspace. An account admin turns it on under Previews.";
var pageBlockCode = (block) => JSON.stringify(block, null, 2);
var pageBlockFence = (block) => `\`\`\`${PAGE_LANGUAGE}
${pageBlockCode(block)}
\`\`\``;
function parsePageBlock(code) {
  let value;
  try {
    value = JSON.parse(code);
  } catch {
    return void 0;
  }
  if (!value || typeof value !== "object") return void 0;
  const block = value;
  if (typeof block.title !== "string" || !block.title.trim()) return void 0;
  if (typeof block.body !== "string" || !block.body.trim()) return void 0;
  if (typeof block.domain !== "string" || !/^domains\/[^/\s]+$/.test(block.domain)) return void 0;
  const page = typeof block.page === "string" && block.page.trim() ? pageName(block.page.trim()) : void 0;
  return {
    title: block.title.trim(),
    body: block.body,
    domain: block.domain,
    ...typeof block.domain_title === "string" && block.domain_title && { domain_title: block.domain_title },
    ...page && { page }
  };
}
function titleFrom(text2) {
  const first = text2.split("\n").map((line) => line.replace(/^[#>\s*-]+/, "").trim()).find(Boolean) ?? "";
  const title = first.length > 80 ? `${first.slice(0, 77)}\u2026` : first;
  return title || "Untitled page";
}
async function addDraft(client, block, target, requestId) {
  const pages = new Pages(client);
  if (!target.page) {
    const created = await pages.create({ domain: block.domain, display_name: block.title, body: block.body, state: "DRAFT" }, requestId);
    return { page: created.name, title: created.display_name || block.title, mode: "created" };
  }
  const existing = await pages.get(target.page);
  if (existing.state === "PUBLISHED") throw new Error("That page is published. Pick a draft page, or start a new draft.");
  await pages.append(existing.name, `### ${block.title}

${block.body.trim()}`);
  return { page: existing.name, title: existing.display_name, mode: "appended" };
}

// plugins/knowledge/src/picker.tsx
function SearchList(props) {
  const [query, setQuery] = React.useState("");
  const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  const shown = props.choices.filter((choice) => {
    const text2 = `${choice.label} ${choice.detail ?? ""}`.toLowerCase();
    return words.every((word) => text2.includes(word));
  }).slice(0, 200);
  return /* @__PURE__ */ React.createElement("div", { style: { display: "flex", flexDirection: "column", gap: 6, minWidth: 0 } }, /* @__PURE__ */ React.createElement(
    "input",
    {
      className: "dbx-input",
      type: "search",
      "aria-label": `Search ${props.label.toLowerCase()}`,
      placeholder: props.placeholder ?? "Search",
      value: query,
      onChange: (event) => setQuery(event.target.value)
    }
  ), /* @__PURE__ */ React.createElement(
    "div",
    {
      role: "listbox",
      "aria-label": props.label,
      style: { maxHeight: 220, overflowY: "auto", border: "1px solid var(--dbx-border)", borderRadius: "var(--dbx-radius)" }
    },
    shown.length ? shown.map((choice) => {
      const selected = choice.id === props.value;
      return /* @__PURE__ */ React.createElement(
        "button",
        {
          key: choice.id,
          type: "button",
          role: "option",
          "aria-selected": selected,
          disabled: choice.disabled,
          onClick: () => props.onPick(choice.id),
          style: {
            display: "flex",
            width: "100%",
            justifyContent: "space-between",
            alignItems: "baseline",
            gap: 8,
            padding: "6px 10px",
            border: 0,
            background: selected ? "var(--dbx-brand-tint)" : "transparent",
            color: "var(--dbx-ink)",
            font: "inherit",
            textAlign: "left",
            cursor: choice.disabled ? "default" : "pointer",
            opacity: choice.disabled ? 0.6 : 1
          }
        },
        /* @__PURE__ */ React.createElement("span", { style: { minWidth: 0, overflowWrap: "anywhere" } }, choice.label),
        choice.detail && /* @__PURE__ */ React.createElement(Text, { size: "xs", tone: "subtle" }, choice.detail)
      );
    }) : /* @__PURE__ */ React.createElement(Text, { tone: "subtle", size: "sm", style: { padding: "8px 10px" } }, props.emptyText ?? "Nothing matches.")
  ));
}

// plugins/knowledge/src/channel-panel.tsx
function useCatalogState(catalog) {
  return React.useSyncExternalStore(catalog.subscribe, catalog.snapshot);
}
var idOf = (domain) => domain.domain_id ?? domain.name.replace(/^domains\//, "");
var DENIED_LIST = "Listing domains needs the MANAGE DISCOVERY permission. Ask an admin, or create a new domain.";
var STEP_LABEL = { done: "Done", skipped: "Skipped", denied: "Ask an admin", failed: "Failed" };
var STEP_TONE = { done: "success", skipped: "neutral", denied: "warning", failed: "danger" };
function StepList(props) {
  return /* @__PURE__ */ React.createElement(Card, null, /* @__PURE__ */ React.createElement(Stack, { gap: 12 }, /* @__PURE__ */ React.createElement(Text, { weight: 500 }, "Set-up steps"), props.steps.map((step) => /* @__PURE__ */ React.createElement(Stack, { key: step.id, gap: 4 }, /* @__PURE__ */ React.createElement(Stack, { direction: "row", gap: 8, align: "center", wrap: true }, /* @__PURE__ */ React.createElement(Badge, { tone: STEP_TONE[step.status] }, STEP_LABEL[step.status]), /* @__PURE__ */ React.createElement(Text, { size: "sm", weight: 500 }, step.title)), step.detail && /* @__PURE__ */ React.createElement(Text, { size: "sm", tone: "subtle" }, step.detail), step.sql && /* @__PURE__ */ React.createElement(CodeView, { code: step.sql, language: "sql" })))));
}
function Linked(props) {
  const { service, catalog, state, link } = props;
  const domainId = link.tags[DOMAIN_TAG] || void 0;
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState();
  const domain = useAsync(async () => {
    if (!domainId) return { error: "No domain is set on this schema." };
    try {
      return { domain: await new Domains(await service.ready()).get(domainName(domainId)) };
    } catch (failure) {
      return { error: isApiError(failure) && failure.isPermission ? "Its details need the MANAGE DISCOVERY permission." : describeError(failure) };
    }
  }, [domainId]);
  const pages = useAsync(async () => {
    const api = new Pages(await service.ready());
    if (!await api.available()) return { on: false };
    if (!domainId) return { on: true, list: [] };
    try {
      return { on: true, list: await api.list({ domain: domainName(domainId) }) };
    } catch (failure) {
      return { on: true, error: describeError(failure) };
    }
  }, [domainId]);
  const skills = state.skills.filter((skill) => schemaOf(skill.fullName) === link.schema);
  const [catalogName, schemaName] = link.schema.split(".");
  const unlink = async () => {
    setBusy(true);
    setError(void 0);
    try {
      await unlinkChannel(await service.ready(), link.schema);
      await catalog.load(true);
      props.onUnlinked();
    } catch (failure) {
      setError(
        isApiError(failure) && failure.isPermission ? `Removing the link needs APPLY TAG on ${link.schema}. Ask the schema owner or an admin.` : describeError(failure)
      );
    } finally {
      setBusy(false);
    }
  };
  const openSchema = () => {
    const url = service.workspaceUrl(`/explore/data/${catalogName}/${schemaName}`);
    if (url) openExternal(url);
  };
  const d = domain.data?.domain;
  return /* @__PURE__ */ React.createElement(Card, null, /* @__PURE__ */ React.createElement(Stack, { gap: 14 }, /* @__PURE__ */ React.createElement(Stack, { gap: 4 }, /* @__PURE__ */ React.createElement(Text, { size: "xs", tone: "subtle" }, "Domain"), d ? /* @__PURE__ */ React.createElement(Stack, { direction: "row", gap: 8, align: "center", wrap: true }, /* @__PURE__ */ React.createElement(Text, { weight: 500 }, domainTitle(d)), /* @__PURE__ */ React.createElement(Badge, { tone: d.effective_draft ? "warning" : "success" }, d.effective_draft ? "Draft" : "Published")) : domain.loading ? /* @__PURE__ */ React.createElement(Spinner, { label: "Loading the domain" }) : /* @__PURE__ */ React.createElement(Text, { size: "sm" }, domainId), d?.description && /* @__PURE__ */ React.createElement(Text, { size: "sm", tone: "subtle" }, d.description), domain.data?.error && /* @__PURE__ */ React.createElement(Text, { size: "sm", tone: "subtle" }, domain.data.error)), /* @__PURE__ */ React.createElement(Stack, { gap: 4 }, /* @__PURE__ */ React.createElement(Text, { size: "xs", tone: "subtle" }, "Skills schema"), /* @__PURE__ */ React.createElement(Stack, { direction: "row", gap: 8, align: "center", wrap: true }, /* @__PURE__ */ React.createElement(Text, { mono: true, size: "sm" }, link.schema), /* @__PURE__ */ React.createElement(Button, { size: "sm", variant: "ghost", onClick: openSchema }, "Open in Databricks"))), /* @__PURE__ */ React.createElement(Stack, { gap: 4 }, /* @__PURE__ */ React.createElement(Text, { size: "xs", tone: "subtle" }, "Skills (", skills.length, ")"), skills.length ? skills.slice(0, 50).map((skill) => /* @__PURE__ */ React.createElement(Text, { key: skill.fullName, size: "sm" }, /* @__PURE__ */ React.createElement("span", { className: "dbx-mono" }, skill.fullName.split(".").pop()), skill.description ? ` \u2014 ${skill.description}` : "")) : /* @__PURE__ */ React.createElement(Text, { size: "sm", tone: "subtle" }, "No skills in this schema yet.")), /* @__PURE__ */ React.createElement(Stack, { gap: 4 }, /* @__PURE__ */ React.createElement(Text, { size: "xs", tone: "subtle" }, "Pages"), pages.loading && /* @__PURE__ */ React.createElement(Spinner, { label: "Loading pages" }), pages.data && !pages.data.on && /* @__PURE__ */ React.createElement(Text, { size: "sm" }, PAGES_OFF), pages.data?.error && /* @__PURE__ */ React.createElement(Text, { size: "sm", tone: "subtle" }, "Couldn't list pages: ", pages.data.error), pages.data?.on && pages.data.list && /* @__PURE__ */ React.createElement(React.Fragment, null, /* @__PURE__ */ React.createElement(Text, { size: "sm", tone: "subtle" }, pages.data.list.length ? `${pages.data.list.length} in this domain.` : "None in this domain yet."), pages.data.list.slice(0, 25).map((page) => /* @__PURE__ */ React.createElement(Text, { key: page.name, size: "sm" }, page.display_name, " ", /* @__PURE__ */ React.createElement("span", { style: { color: "var(--dbx-subtle)" } }, "(", page.state === "PUBLISHED" ? "published" : "draft", ")"))))), /* @__PURE__ */ React.createElement(Stack, { gap: 6 }, /* @__PURE__ */ React.createElement(Text, { size: "sm", tone: "subtle" }, "Unlinking keeps the domain and the schema. This channel stops using them."), /* @__PURE__ */ React.createElement(Stack, { direction: "row" }, /* @__PURE__ */ React.createElement(Button, { disabled: busy, onClick: () => void unlink() }, busy ? "Unlinking\u2026" : "Unlink channel")), error && /* @__PURE__ */ React.createElement(Notice, { tone: "danger" }, error))));
}
function SetupForm(props) {
  const { service, catalog, channel } = props;
  const [domainMode, setDomainMode] = React.useState("new");
  const [domainId, setDomainId] = React.useState("");
  const [title, setTitle] = React.useState(channel.name.replace(/\//g, " ").trim());
  const [description, setDescription] = React.useState("");
  const [parentId, setParentId] = React.useState("");
  const [catalogName, setCatalogName] = React.useState("");
  const [schemaMode, setSchemaMode] = React.useState("new");
  const [schemaPick, setSchemaPick] = React.useState("");
  const [schemaName, setSchemaName] = React.useState(schemaNameFor(channel.name));
  const [principal, setPrincipal] = React.useState("");
  const [running, setRunning] = React.useState(false);
  const [error, setError] = React.useState();
  const domains = useAsync(async () => new Domains(await service.ready()).list(), []);
  const catalogs = useAsync(async () => listCatalogs(await service.ready()), []);
  const schemas = useAsync(async () => catalogName ? listSchemas(await service.ready(), catalogName) : [], [catalogName]);
  React.useEffect(() => {
    if (!catalogName && catalogs.data?.length) setCatalogName(catalogs.data[0] ?? "");
  }, [catalogs.data, catalogName]);
  const picked = domains.data?.find((domain) => idOf(domain) === domainId);
  const parent = domains.data?.find((domain) => idOf(domain) === parentId);
  const newSchema = schemaName.trim();
  const schemaValid = /^[A-Za-z0-9_]+$/.test(newSchema);
  const canRun = !running && !!catalogName && (domainMode === "existing" ? !!picked : title.trim().length > 0) && (schemaMode === "new" ? schemaValid : !!schemaPick);
  const run = async () => {
    setRunning(true);
    setError(void 0);
    try {
      const client = await service.ready();
      const snapshot = service.snapshot();
      const domain = domainMode === "existing" && picked ? { mode: "existing", id: idOf(picked), tagKey: picked.tag_key, title: domainTitle(picked) } : {
        mode: "new",
        title: title.trim(),
        ...description.trim() && { description: description.trim() },
        ...parent && { parent: { id: idOf(parent), tagKey: parent.tag_key } }
      };
      const result = await setUpChannel(client, {
        channel,
        domain,
        schema: { catalog: catalogName, name: schemaMode === "new" ? newSchema : schemaPick, create: schemaMode === "new" },
        ...principal.trim() ? { principal: principal.trim() } : {},
        ...snapshot.status === "connected" ? { viewer: snapshot.user.userName } : {}
      });
      props.onResult(result);
      await catalog.load(true);
    } catch (failure) {
      setError(describeError(failure));
    } finally {
      setRunning(false);
    }
  };
  const domainListError = domains.error && (isApiError(domains.error) && domains.error.isPermission ? DENIED_LIST : describeError(domains.error));
  return /* @__PURE__ */ React.createElement(Card, null, /* @__PURE__ */ React.createElement(Stack, { gap: 16 }, /* @__PURE__ */ React.createElement(Stack, { gap: 8 }, /* @__PURE__ */ React.createElement(Text, { weight: 500 }, "Domain"), /* @__PURE__ */ React.createElement(Stack, { direction: "row", gap: 8, wrap: true }, /* @__PURE__ */ React.createElement(Button, { variant: domainMode === "new" ? "primary" : "default", onClick: () => setDomainMode("new") }, "Create a domain"), /* @__PURE__ */ React.createElement(Button, { variant: domainMode === "existing" ? "primary" : "default", onClick: () => setDomainMode("existing") }, "Use an existing domain")), domainMode === "new" ? /* @__PURE__ */ React.createElement(Stack, { gap: 10 }, /* @__PURE__ */ React.createElement(Field, { label: "Name", hint: "Starts as a draft. Nothing is published." }, /* @__PURE__ */ React.createElement("input", { className: "dbx-input", value: title, onChange: (event) => setTitle(event.target.value) })), /* @__PURE__ */ React.createElement(Field, { label: "Description (optional)" }, /* @__PURE__ */ React.createElement("input", { className: "dbx-input", value: description, onChange: (event) => setDescription(event.target.value) })), /* @__PURE__ */ React.createElement(Field, { label: "Parent domain (optional)", hint: "Creates a subdomain under the parent." }, /* @__PURE__ */ React.createElement("select", { className: "dbx-select", value: parentId, onChange: (event) => setParentId(event.target.value) }, /* @__PURE__ */ React.createElement("option", { value: "" }, "No parent"), (domains.data ?? []).map((domain) => /* @__PURE__ */ React.createElement("option", { key: idOf(domain), value: idOf(domain) }, domainTitle(domain)))))) : domains.loading ? /* @__PURE__ */ React.createElement(Spinner, { label: "Loading domains" }) : domainListError ? /* @__PURE__ */ React.createElement(Notice, { tone: "warning" }, domainListError) : /* @__PURE__ */ React.createElement(
    SearchList,
    {
      label: "Domains",
      placeholder: "Search domains",
      emptyText: "No domains yet. Create one instead.",
      value: domainId,
      onPick: setDomainId,
      choices: (domains.data ?? []).map((domain) => ({ id: idOf(domain), label: domainTitle(domain), detail: domain.effective_draft ? "Draft" : void 0 }))
    }
  )), /* @__PURE__ */ React.createElement(Stack, { gap: 8 }, /* @__PURE__ */ React.createElement(Text, { weight: 500 }, "Skills schema"), /* @__PURE__ */ React.createElement(Field, { label: "Catalog" }, catalogs.loading ? /* @__PURE__ */ React.createElement(Spinner, { label: "Loading catalogs" }) : catalogs.error ? /* @__PURE__ */ React.createElement(Notice, { tone: "warning" }, describeError(catalogs.error)) : /* @__PURE__ */ React.createElement("select", { className: "dbx-select", value: catalogName, onChange: (event) => setCatalogName(event.target.value) }, (catalogs.data ?? []).map((name) => /* @__PURE__ */ React.createElement("option", { key: name, value: name }, name)))), /* @__PURE__ */ React.createElement(Stack, { direction: "row", gap: 8, wrap: true }, /* @__PURE__ */ React.createElement(Button, { variant: schemaMode === "new" ? "primary" : "default", onClick: () => setSchemaMode("new") }, "Create a schema"), /* @__PURE__ */ React.createElement(Button, { variant: schemaMode === "existing" ? "primary" : "default", onClick: () => setSchemaMode("existing") }, "Use an existing schema")), schemaMode === "new" ? /* @__PURE__ */ React.createElement(Field, { label: "Schema name", hint: newSchema && !schemaValid ? "Use letters, numbers and underscores." : "Creating it needs CREATE SCHEMA on the catalog." }, /* @__PURE__ */ React.createElement("input", { className: "dbx-input", value: schemaName, onChange: (event) => setSchemaName(event.target.value) })) : schemas.loading ? /* @__PURE__ */ React.createElement(Spinner, { label: "Loading schemas" }) : schemas.error ? /* @__PURE__ */ React.createElement(Notice, { tone: "warning" }, describeError(schemas.error)) : /* @__PURE__ */ React.createElement(
    SearchList,
    {
      label: "Schemas",
      placeholder: "Search schemas",
      emptyText: "No schemas in this catalog.",
      value: schemaPick,
      onPick: setSchemaPick,
      choices: (schemas.data ?? []).map((name) => ({ id: name, label: name }))
    }
  )), /* @__PURE__ */ React.createElement(Field, { label: "Who can use the skills (optional)", hint: "A group or user. Gives USE SCHEMA and READ VOLUME on the schema, and USE CATALOG if an admin allows it." }, /* @__PURE__ */ React.createElement("input", { className: "dbx-input", value: principal, placeholder: "Group or user name", onChange: (event) => setPrincipal(event.target.value) })), error && /* @__PURE__ */ React.createElement(Notice, { tone: "danger" }, error), /* @__PURE__ */ React.createElement(Stack, { direction: "row" }, /* @__PURE__ */ React.createElement(Button, { variant: "brand", disabled: !canRun, onClick: () => void run() }, running ? "Setting up\u2026" : "Set up"))));
}
function channelSetupPanel(service, catalog) {
  return function ChannelSetupPanel({ channelContext }) {
    const connection = useConnection(service);
    const state = useCatalogState(catalog);
    const [outcome, setOutcome] = React.useState();
    React.useEffect(() => {
      if (connection.status === "connected") void catalog.load();
    }, [connection.status]);
    if (!channelContext) return /* @__PURE__ */ React.createElement(Notice, null, "Open this from a channel's menu.");
    if (connection.status !== "connected")
      return /* @__PURE__ */ React.createElement(DbxRoot, null, /* @__PURE__ */ React.createElement(Notice, { title: "Connect Databricks", action: /* @__PURE__ */ React.createElement(Button, { variant: "brand", onClick: () => service.openSettings() }, "Connect") }, "Channels link to Unity Catalog, so Databricks needs to be connected first."));
    const channel = { id: channelContext.channelId, name: channelContext.channelName };
    const found = state.schemas.find((schema2) => schema2.tags[CHANNEL_TAG] === channel.id);
    const link = found ?? (outcome?.linked ? { schema: outcome.schema, tags: { [CHANNEL_TAG]: channel.id, [DOMAIN_TAG]: outcome.domainId ?? "" }, source: "tag" } : void 0);
    const showLinked = !!link && !(outcome && !outcome.linked && !found);
    return /* @__PURE__ */ React.createElement(DbxRoot, null, /* @__PURE__ */ React.createElement("div", { style: { padding: 16 } }, /* @__PURE__ */ React.createElement(Stack, { gap: 16 }, /* @__PURE__ */ React.createElement(
      SectionHeader,
      {
        title: `Databricks for #${channel.name}`,
        description: showLinked ? "This channel's domain and skills." : "Link this channel to a domain and a skills schema."
      }
    ), state.note && /* @__PURE__ */ React.createElement(Notice, { tone: "warning" }, state.note), state.status === "error" && /* @__PURE__ */ React.createElement(Notice, { tone: "danger", action: /* @__PURE__ */ React.createElement(Button, { onClick: () => void catalog.load(true) }, "Try again") }, state.error), outcome && /* @__PURE__ */ React.createElement(StepList, { steps: outcome.steps }), !state.at && state.status !== "error" ? /* @__PURE__ */ React.createElement(Spinner, { label: "Looking for this channel's schema" }) : showLinked && link ? /* @__PURE__ */ React.createElement(Linked, { service, catalog, state, link, onUnlinked: () => setOutcome(void 0) }) : /* @__PURE__ */ React.createElement(SetupForm, { service, catalog, channel, onResult: setOutcome }))));
  };
}

// plugins/knowledge/src/channel-tools.ts
var NOT_LINKED = "This channel isn't set up with Databricks yet. Someone can open the channel's menu and choose Set up Databricks to link it to a domain and a skills schema.";
var NO_CHANNEL = "This conversation isn't in a Buzz channel, so it has no linked Databricks domain.";
var MAX_BODY = 2e4;
async function describeDomain(service, id) {
  try {
    const domain = await new Domains(await service.ready()).get(domainName(id));
    const status = domain.effective_draft ? "draft" : "published";
    return `Domain: ${domainTitle(domain)} (${status})${domain.description ? `
${domain.description}` : ""}`;
  } catch (error) {
    if (isApiError(error) && error.isPermission) return `Domain: ${id} (its details need the MANAGE DISCOVERY permission)`;
    return `Domain: ${id} (${describeError(error)})`;
  }
}
async function describePages(service, domain) {
  const pages = new Pages(await service.ready());
  if (!await pages.available()) return PAGES_OFF;
  try {
    const list = await pages.list({ domain: domainName(domain) });
    if (!list.length) return "Pages: none yet.";
    return `Pages (${list.length}):
${list.slice(0, 25).map((page) => `- ${page.display_name} (${page.name}, ${page.state === "PUBLISHED" ? "published" : "draft"})`).join("\n")}`;
  } catch (error) {
    return `Pages: couldn't list them (${describeError(error)}).`;
  }
}
var pageLine = (page) => {
  const text2 = (page.body ?? page.description ?? "").replace(/\s+/g, " ").trim();
  return `- ${page.display_name} \u2014 ${page.name} (${page.state === "PUBLISHED" ? "published" : "draft"})${text2 ? `
  ${text2.slice(0, 200)}${text2.length > 200 ? "\u2026" : ""}` : ""}`;
};
function channelTools(service, catalog) {
  return [
    {
      name: "databricks_channel_info",
      description: "Describes this channel's Databricks setup: the domain it's linked to, its skills schema, the skills in that schema, and its Pages. Use it before answering questions about this channel's skills or pages.",
      inputSchema: schema.object({}),
      async call(_client, context) {
        if (!context.channel) return NO_CHANNEL;
        const link = await catalog.channel(context.channel);
        if (!link) return NOT_LINKED;
        const skills = await catalog.channelSkills(context.channel);
        const lines = [link.domainId ? await describeDomain(service, link.domainId) : "Domain: none (the schema isn't tagged with one).", `Skills schema: ${link.schema}`];
        lines.push(
          skills.length ? `Skills (${skills.length}):
${skills.slice(0, 50).map((skill) => `- ${skill.fullName}${skill.description ? `: ${skill.description}` : ""}`).join("\n")}` : "Skills: none in this schema yet."
        );
        if (link.domainId) lines.push(await describePages(service, link.domainId));
        return lines.join("\n");
      }
    },
    {
      name: "databricks_pages_search",
      description: "Searches Databricks Pages (short Markdown pages that Genie One cites), in this channel's domain when it has one. Each word of the query must appear in a page's title, description, synonyms or body.",
      inputSchema: schema.object({ query: schema.string("What to look for.") }, ["query"]),
      async call(_client, context, args) {
        const client = await service.ready();
        const pages = new Pages(client);
        if (!await pages.available()) return PAGES_OFF;
        const link = context.channel ? await catalog.channel(context.channel) : void 0;
        const words = stringArg(args, "query").toLowerCase().split(/\s+/).filter(Boolean);
        const list = await pages.list(link?.domainId ? { domain: domainName(link.domainId) } : {});
        const matches = list.filter((page) => {
          const text2 = [page.display_name, page.description, ...page.synonyms ?? [], page.body].join(" ").toLowerCase();
          return words.every((word) => text2.includes(word));
        });
        return matches.length ? matches.slice(0, 10).map(pageLine).join("\n") : "No pages match that.";
      }
    },
    {
      name: "databricks_page_read",
      description: "Reads one Databricks page by its name (from databricks_pages_search or databricks_channel_info), including its body.",
      inputSchema: schema.object({ name: schema.string("The page's name, such as pages/abc123, or just its ID.") }, ["name"]),
      async call(_client, _context, args) {
        const pages = new Pages(await service.ready());
        if (!await pages.available()) return PAGES_OFF;
        try {
          const page = await pages.get(stringArg(args, "name"));
          const body = (page.body ?? "").slice(0, 2e4);
          return `${page.display_name} (${page.name}, ${page.state === "PUBLISHED" ? "published" : "draft"})

${body}`;
        } catch (error) {
          if (isApiError(error) && error.isNotFound) return `There's no page named ${pageName(stringArg(args, "name"))}.`;
          throw error;
        }
      }
    },
    {
      name: "databricks_page_draft",
      description: "Drafts a Databricks page for the channel's domain (or the domain given). It doesn't write anything: it returns a databricks-page block. Post the block exactly as returned, in your reply; the person adds it as a draft from the card. Use it when someone asks you to turn something into a page.",
      inputSchema: schema.object(
        {
          title: schema.string("A short title for the page."),
          body: schema.string("The page's Markdown body. No personal data."),
          page: schema.string("An existing draft page to add this to, as pages/<id>. Leave out for a new page."),
          domain: schema.string("The domain, as domains/<id>. Defaults to this channel's domain.")
        },
        ["title", "body"]
      ),
      async call(_client, context, args) {
        const title = stringArg(args, "title");
        const body = stringArg(args, "body");
        if (body.length > MAX_BODY) throw new Error("Keep a page under 20,000 characters; split it into several pages.");
        const pages = new Pages(await service.ready());
        if (!await pages.available()) return PAGES_OFF;
        let domainId = stringArg(args, "domain", false).replace(/^domains\//, "");
        if (!domainId && context.channel) domainId = (await catalog.channel(context.channel))?.domainId ?? "";
        if (!domainId)
          throw new Error(
            context.channel ? "This channel isn't set up with a domain, so there's nowhere to put the page. Set up Databricks in the channel menu, or pass a domain." : "Pass a domain, as domains/<id>; this conversation isn't in a channel."
          );
        const domain = domainName(domainId);
        const block = {
          title,
          body,
          domain,
          domain_title: await describeDomainTitle(service, domainId),
          ...stringArg(args, "page", false) && { page: pageName(stringArg(args, "page", false)) }
        };
        return `Draft page for ${block.domain_title}. Post this block exactly as written, in your reply. The person adds it as a draft from the card.

${pageBlockFence(block)}`;
      }
    }
  ];
}
async function describeDomainTitle(service, id) {
  try {
    return domainTitle(await new Domains(await service.ready()).get(domainName(id)));
  } catch {
    return id;
  }
}

// packages/core/src/ui/markdown.tsx
var SAFE_URL = /^https?:\/\//i;
function renderInline(text2, keyPrefix = "i") {
  const nodes = [];
  const pattern = /(\\[\\`*_{}[\]()#+\-.!~|<>$])|(`[^`]+`)|(\*\*[^*]+\*\*)|(__[^_]+__)|(\*[^*\s][^*]*\*)|(\[[^\]]+\]\([^)\s]+\))|(https?:\/\/[^\s)<>]+)/g;
  let last = 0;
  let match;
  let index = 0;
  while (match = pattern.exec(text2)) {
    if (match.index > last) nodes.push(text2.slice(last, match.index));
    const token = match[0];
    const key = `${keyPrefix}-${index++}`;
    if (token.length === 2 && token.startsWith("\\")) nodes.push(token.slice(1));
    else if (token.startsWith("`")) nodes.push(/* @__PURE__ */ React.createElement("code", { key }, token.slice(1, -1)));
    else if (token.startsWith("**") || token.startsWith("__"))
      nodes.push(/* @__PURE__ */ React.createElement("strong", { key }, renderInline(token.slice(2, -2), key)));
    else if (token.startsWith("*")) nodes.push(/* @__PURE__ */ React.createElement("em", { key }, renderInline(token.slice(1, -1), key)));
    else if (token.startsWith("[")) {
      const label = token.slice(1, token.indexOf("]("));
      const href = token.slice(token.indexOf("](") + 2, -1);
      nodes.push(
        SAFE_URL.test(href) ? /* @__PURE__ */ React.createElement("a", { key, href, target: "_blank", rel: "noreferrer", className: "dbx-link" }, label) : label
      );
    } else
      nodes.push(
        /* @__PURE__ */ React.createElement("a", { key, href: token, target: "_blank", rel: "noreferrer", className: "dbx-link" }, token)
      );
    last = match.index + token.length;
  }
  if (last < text2.length) nodes.push(text2.slice(last));
  return nodes;
}
var cells = (line) => line.trim().replace(/^\|/, "").replace(/\|$/, "").split("|").map((cell) => cell.trim());
function parseBlocks(source) {
  const lines = source.replace(/\r\n?/g, "\n").split("\n");
  const blocks = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i] ?? "";
    if (!line.trim()) {
      i++;
      continue;
    }
    const fence = /^```(\S*)/.exec(line);
    if (fence) {
      const body = [];
      i++;
      while (i < lines.length && !/^```/.test(lines[i] ?? "")) body.push(lines[i++] ?? "");
      i++;
      blocks.push({ type: "code", lang: fence[1] ?? "", code: body.join("\n") });
      continue;
    }
    const heading = /^(#{1,4})\s+(.*)$/.exec(line);
    if (heading) {
      blocks.push({ type: "h", level: heading[1]?.length ?? 1, text: heading[2] ?? "" });
      i++;
      continue;
    }
    if (/^\s*\|.*\|\s*$/.test(line) && /^\s*\|?\s*:?-{2,}/.test(lines[i + 1] ?? "")) {
      const header = cells(line);
      const rows = [];
      i += 2;
      while (i < lines.length && /^\s*\|.*\|\s*$/.test(lines[i] ?? "")) rows.push(cells(lines[i++] ?? ""));
      blocks.push({ type: "table", header, rows });
      continue;
    }
    const bullet = /^\s*[-*+]\s+/;
    const ordered = /^\s*\d+[.)]\s+/;
    if (bullet.test(line) || ordered.test(line)) {
      const type = bullet.test(line) ? "ul" : "ol";
      const marker = type === "ul" ? bullet : ordered;
      const items = [];
      while (i < lines.length && marker.test(lines[i] ?? "")) items.push((lines[i++] ?? "").replace(marker, ""));
      blocks.push({ type, items });
      continue;
    }
    const paragraph = [];
    while (i < lines.length && (lines[i] ?? "").trim() && !/^```|^#{1,4}\s|^\s*[-*+]\s+|^\s*\d+[.)]\s+/.test(lines[i] ?? ""))
      paragraph.push(lines[i++] ?? "");
    blocks.push({ type: "p", text: paragraph.join("\n") });
  }
  return blocks;
}
function Markdown(props) {
  const blocks = React.useMemo(() => parseBlocks(props.source), [props.source]);
  return /* @__PURE__ */ React.createElement("div", { className: "dbx-md", style: { fontSize: props.size === "sm" ? "0.75rem" : "0.8125rem", lineHeight: 1.55 } }, blocks.map((block, index) => {
    const key = `b${index}`;
    switch (block.type) {
      case "p":
        return /* @__PURE__ */ React.createElement("p", { key, style: { whiteSpace: "pre-wrap" } }, renderInline(block.text, key));
      case "h":
        return /* @__PURE__ */ React.createElement("p", { key, style: { fontWeight: 600, fontSize: block.level <= 2 ? "0.9375rem" : void 0 } }, renderInline(block.text, key));
      case "ul":
      case "ol":
        return React.createElement(
          block.type,
          { key },
          block.items.map((item, n) => /* @__PURE__ */ React.createElement("li", { key: `${key}-${n}` }, renderInline(item, `${key}-${n}`)))
        );
      case "code":
        return /* @__PURE__ */ React.createElement("pre", { key }, /* @__PURE__ */ React.createElement("code", null, block.code));
      case "table":
        return /* @__PURE__ */ React.createElement("div", { key, style: { overflow: "auto", margin: "0 0 8px" } }, /* @__PURE__ */ React.createElement("table", { className: "dbx-table" }, /* @__PURE__ */ React.createElement("thead", null, /* @__PURE__ */ React.createElement("tr", null, block.header.map((cell, n) => /* @__PURE__ */ React.createElement("th", { key: `${key}-h${n}` }, renderInline(cell))))), /* @__PURE__ */ React.createElement("tbody", null, block.rows.map((row, r) => /* @__PURE__ */ React.createElement("tr", { key: `${key}-r${r}` }, row.map((cell, n) => /* @__PURE__ */ React.createElement("td", { key: `${key}-r${r}-${n}` }, renderInline(cell))))))));
    }
    return null;
  }));
}

// plugins/knowledge/src/page-card.tsx
var added = /* @__PURE__ */ new Map();
function PageDraftCard(props) {
  const { service, code, block } = props;
  const [, refresh] = React.useState(0);
  const saved = added.get(code);
  const id = React.useId();
  const [title, setTitle] = React.useState(block.title);
  const [target, setTarget] = React.useState(block.page ? "existing" : "new");
  const [page, setPage] = React.useState(block.page ?? "");
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState();
  const pagesOn = useAsync(async () => new Pages(await service.ready()).available(), []);
  const available = pagesOn.data;
  const pages = useAsync(
    async (signal) => available ? new Pages(await service.ready()).list({ domain: block.domain, signal }) : [],
    [available, block.domain]
  );
  const domain = useAsync(async () => {
    if (block.domain_title) return block.domain_title;
    try {
      return domainTitle(await new Domains(await service.ready()).get(block.domain));
    } catch {
      return block.domain.replace(/^domains\//, "");
    }
  }, [block.domain, block.domain_title]);
  const domainLabel = domain.data ?? block.domain_title ?? block.domain.replace(/^domains\//, "");
  const add = async () => {
    setBusy(true);
    setError(void 0);
    try {
      const client = await service.ready();
      const result = await addDraft(client, { ...block, title: title.trim() || block.title }, target === "existing" ? { page } : {}, crypto.randomUUID());
      added.set(code, result);
      refresh((n) => n + 1);
    } catch (failure) {
      setError(describeError(failure));
    } finally {
      setBusy(false);
    }
  };
  return /* @__PURE__ */ React.createElement(DbxRoot, null, /* @__PURE__ */ React.createElement(Card, { padding: 14 }, /* @__PURE__ */ React.createElement(Stack, { gap: 12 }, /* @__PURE__ */ React.createElement(Stack, { gap: 2 }, /* @__PURE__ */ React.createElement(Text, { size: "xs", tone: "subtle" }, "Databricks page draft \xB7 ", domainLabel), saved ? /* @__PURE__ */ React.createElement(Text, { as: "h3", size: "md", weight: 500 }, saved.title) : /* @__PURE__ */ React.createElement(Field, { label: "Title", id: `${id}-title` }, /* @__PURE__ */ React.createElement("input", { id: `${id}-title`, className: "dbx-input", value: title, onChange: (event) => setTitle(event.target.value) }))), /* @__PURE__ */ React.createElement("div", { style: { maxHeight: 320, overflow: "auto", minWidth: 0 } }, /* @__PURE__ */ React.createElement(Markdown, { source: block.body, size: "sm" })), saved && /* @__PURE__ */ React.createElement(Notice, { tone: "success", title: "Added as a draft" }, saved.mode === "created" ? `New draft page \u201C${saved.title}\u201D.` : `Added to \u201C${saved.title}\u201D.`, " Publishing happens in Databricks."), !saved && pagesOn.loading && /* @__PURE__ */ React.createElement(Spinner, { label: "Checking Pages" }), !saved && available === false && /* @__PURE__ */ React.createElement(Notice, { title: "Pages is off" }, PAGES_OFF), !saved && pagesOn.error && /* @__PURE__ */ React.createElement(Notice, { tone: "warning" }, "Couldn't check Pages: ", describeError(pagesOn.error)), !saved && available && /* @__PURE__ */ React.createElement(Stack, { gap: 10 }, /* @__PURE__ */ React.createElement(Stack, { gap: 6 }, /* @__PURE__ */ React.createElement(Text, { size: "sm", weight: 500 }, "Where it goes"), /* @__PURE__ */ React.createElement("label", { style: { display: "flex", gap: 8, alignItems: "center", cursor: "pointer" } }, /* @__PURE__ */ React.createElement("input", { type: "radio", name: `${id}-target`, checked: target === "new", onChange: () => setTarget("new") }), /* @__PURE__ */ React.createElement(Text, { size: "sm" }, "New draft page")), /* @__PURE__ */ React.createElement("label", { style: { display: "flex", gap: 8, alignItems: "center", cursor: "pointer" } }, /* @__PURE__ */ React.createElement("input", { type: "radio", name: `${id}-target`, checked: target === "existing", onChange: () => setTarget("existing") }), /* @__PURE__ */ React.createElement(Text, { size: "sm" }, "Add to an existing page"))), target === "existing" && /* @__PURE__ */ React.createElement(React.Fragment, null, pages.loading && /* @__PURE__ */ React.createElement(Spinner, { label: "Loading pages" }), pages.error && /* @__PURE__ */ React.createElement(Notice, { tone: "warning" }, "Couldn't list pages: ", describeError(pages.error)), pages.data && /* @__PURE__ */ React.createElement(
    SearchList,
    {
      label: "Pages",
      placeholder: "Search pages",
      emptyText: "No draft pages in this domain yet.",
      value: page,
      onPick: setPage,
      choices: pages.data.map((item) => ({
        id: item.name,
        label: item.display_name,
        detail: item.state === "PUBLISHED" ? "Published" : "Draft",
        disabled: item.state === "PUBLISHED"
      }))
    }
  )), /* @__PURE__ */ React.createElement(Text, { size: "xs", tone: "subtle" }, PAGE_WARNING), error && /* @__PURE__ */ React.createElement(Notice, { tone: "danger" }, error), /* @__PURE__ */ React.createElement(Stack, { direction: "row", gap: 8, align: "center" }, /* @__PURE__ */ React.createElement(Button, { variant: "brand", disabled: busy || target === "existing" && !page || !title.trim(), onClick: () => void add() }, busy ? "Adding\u2026" : "Add as draft"), props.onClose && /* @__PURE__ */ React.createElement(Button, { onClick: props.onClose }, "Close"))), saved && props.onClose && /* @__PURE__ */ React.createElement(Stack, { direction: "row" }, /* @__PURE__ */ React.createElement(Button, { onClick: props.onClose }, "Close")))));
}
function pageCodeBlock(service) {
  return function PageCodeBlock({ code }) {
    const block = parsePageBlock(code);
    if (!block)
      return /* @__PURE__ */ React.createElement(DbxRoot, null, /* @__PURE__ */ React.createElement(Notice, { tone: "warning", title: "This page draft isn't valid" }, "It needs a title, a body and a domain. Ask for the draft again."));
    return /* @__PURE__ */ React.createElement(PageDraftCard, { service, code, block });
  };
}
function linkedDomainId(catalog, channelId) {
  if (catalog.snapshot().status !== "loading") queueMicrotask(() => void catalog.load());
  return catalog.snapshot().schemas.find((schema2) => schema2.tags[CHANNEL_TAG] === channelId)?.tags[DOMAIN_TAG] || void 0;
}
function addToPageAction(service, catalog) {
  return {
    id: "add-to-page",
    title: "Add to page",
    matches: (message) => message.content.trim().length > 0 && !!linkedDomainId(catalog, message.channelId),
    component: function AddToPage({ message, close }) {
      const domainId = linkedDomainId(catalog, message.channelId);
      if (!domainId)
        return /* @__PURE__ */ React.createElement(Modal, { title: "Add to page", onClose: close }, /* @__PURE__ */ React.createElement(Notice, null, "This channel isn't linked to a domain any more."));
      const block = { title: titleFrom(message.content), body: message.content, domain: domainName(domainId) };
      return /* @__PURE__ */ React.createElement(Modal, { title: "Add to page", onClose: close }, /* @__PURE__ */ React.createElement(PageDraftCard, { service, code: pageBlockCode(block), block, onClose: close }));
    }
  };
}

// plugins/knowledge/src/domain-settings.tsx
function DomainSettings(props) {
  const { service, catalog } = props;
  const connection = useConnection(service);
  const state = useCatalogState(catalog);
  const connected = connection.status === "connected";
  React.useEffect(() => {
    if (connected) void catalog.load();
  }, [connected]);
  const domains = useAsync(async () => {
    try {
      return { list: await new Domains(await service.ready()).list() };
    } catch (failure) {
      return { error: isApiError(failure) && failure.isPermission ? "Listing domains needs the MANAGE DISCOVERY permission." : describeError(failure) };
    }
  }, [connected]);
  const pagesOn = useAsync(async () => connected ? new Pages(await service.ready()).available() : false, [connected]);
  if (!connected) return /* @__PURE__ */ React.createElement(Notice, null, "Connect Databricks to see which channels are linked to domains.");
  const linked = state.schemas.filter((schema2) => schema2.tags[CHANNEL_TAG]);
  const titleOf = (id) => {
    if (!id) return "No domain";
    const domain = domains.data?.list?.find((item) => (item.domain_id ?? item.name.replace(/^domains\//, "")) === id);
    return domain ? domainTitle(domain) : id;
  };
  return /* @__PURE__ */ React.createElement(DbxRoot, null, /* @__PURE__ */ React.createElement(Stack, { gap: 12 }, /* @__PURE__ */ React.createElement(
    SectionHeader,
    {
      title: "Channels and domains",
      description: "Each channel links to one domain and one skills schema. Link a channel from its menu: Set up Databricks.",
      action: /* @__PURE__ */ React.createElement(Button, { size: "sm", variant: "ghost", onClick: () => void catalog.load(true) }, "Refresh")
    }
  ), state.status === "loading" && /* @__PURE__ */ React.createElement(Spinner, { label: "Looking for linked channels" }), state.note && /* @__PURE__ */ React.createElement(Notice, { tone: "warning" }, state.note), linked.length ? /* @__PURE__ */ React.createElement(Card, { padding: 0 }, linked.map((schema2, index) => /* @__PURE__ */ React.createElement(
    "div",
    {
      key: schema2.schema,
      style: { padding: "10px 14px", borderTop: index ? "1px solid var(--dbx-border)" : void 0, display: "flex", flexDirection: "column", gap: 2 }
    },
    /* @__PURE__ */ React.createElement(Text, { size: "sm", weight: 500 }, "#", schema2.tags[SKILLS_TAG] || schema2.tags[CHANNEL_TAG]),
    /* @__PURE__ */ React.createElement(Text, { size: "xs", tone: "subtle" }, titleOf(schema2.tags[DOMAIN_TAG]), " \xB7 ", schema2.schema)
  ))) : state.status !== "loading" && /* @__PURE__ */ React.createElement(Text, { tone: "subtle", size: "sm" }, "No channels are linked yet."), domains.data?.error && /* @__PURE__ */ React.createElement(Notice, { tone: "warning" }, domains.data.error, " Domains show by ID here."), /* @__PURE__ */ React.createElement(Stack, { gap: 6 }, /* @__PURE__ */ React.createElement(Text, { size: "sm", weight: 500 }, "Pages"), /* @__PURE__ */ React.createElement(Text, { size: "sm", tone: "subtle" }, pagesOn.loading ? "Checking\u2026" : pagesOn.data ? "Pages is on. Drafts go in from a channel's messages or agent drafts." : PAGES_OFF)), /* @__PURE__ */ React.createElement(Stack, { gap: 4 }, /* @__PURE__ */ React.createElement(Text, { size: "sm", weight: 500 }, "Who can do what"), /* @__PURE__ */ React.createElement(Text, { size: "sm", tone: "subtle" }, "Domains: listing needs MANAGE DISCOVERY. Creating one also needs its governed tag policy."), /* @__PURE__ */ React.createElement(Text, { size: "sm", tone: "subtle" }, "Schemas: creating one needs CREATE SCHEMA on the catalog. Tagging needs APPLY TAG."), /* @__PURE__ */ React.createElement(Text, { size: "sm", tone: "subtle" }, "Pages: anyone who can see a domain can add a draft. Publishing needs Page Manager or Domain Admin."))));
}

// plugins/knowledge/src/channels.tsx
function registerChannels(scope, service, catalog) {
  scope.panels.register({
    id: "knowledge-channel",
    title: "Databricks",
    // Opened from the channel menu only, never from a link.
    matches: () => false,
    channelMenu: { label: "Set up Databricks", eligible: (channel) => !channel.readOnly && !channel.cached },
    channelPlacement: "side",
    component: channelSetupPanel(service, catalog)
  });
  scope.conversation.registerCodeBlock({
    id: "databricks-page",
    title: "Databricks page",
    matches: (language) => language.trim() === PAGE_LANGUAGE,
    component: pageCodeBlock(service)
  });
  scope.conversation.registerMessageAction(addToPageAction(service, catalog));
  scope.inject(["agents"], (agents) => {
    for (const tool of channelTools(service, catalog)) agents.agents.addTool(tool);
  });
}

// plugins/knowledge/src/skill-draft.ts
var DRAFT_LANGUAGE = "databricks-skill";
var DEFAULT_SCHEMA_PREF = "skillsDefaultSchema";
var SKILL_FILE = "SKILL.md";
var validSchemaName = (value) => /^[^.\s]+\.[^.\s]+$/.test(value);
var text = (value) => typeof value === "string" ? value : "";
function draftBlock(draft) {
  const body = {
    name: draft.name,
    description: draft.description,
    instructions: draft.instructions,
    ...draft.files.length && { files: draft.files },
    ...draft.schema && { schema: draft.schema }
  };
  return `\`\`\`${DRAFT_LANGUAGE}
${JSON.stringify(body, null, 2)}
\`\`\``;
}
function parseDraft(source) {
  let value;
  try {
    value = JSON.parse(source.trim());
  } catch {
    throw new Error("This skill draft isn't valid JSON yet.");
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("A skill draft is a JSON object.");
  const record = value;
  const files = Array.isArray(record.files) ? record.files.flatMap((file) => {
    const entry = file;
    return entry && typeof entry.path === "string" && typeof entry.content === "string" ? [{ path: entry.path, content: entry.content }] : [];
  }) : [];
  const schema2 = text(record.schema).trim();
  return {
    name: text(record.name).trim() || text(record.id).trim(),
    description: text(record.description).trim(),
    instructions: text(record.instructions).trim(),
    files,
    ...schema2 && { schema: schema2 }
  };
}
function validateDraft(draft) {
  if (!validSkillId(draft.name)) return "The name can use lowercase letters, digits, hyphens and underscores, up to 64 characters.";
  if (!draft.description.trim()) return "Add a description so agents know when to use the skill.";
  if (!draft.instructions.trim()) return "Add the instructions.";
  for (const file of draft.files) {
    try {
      skillFilesPath("catalog.schema.skill", file.path);
    } catch (error) {
      return error instanceof Error ? error.message : String(error);
    }
  }
  return void 0;
}
function skillFiles(draft) {
  const others = draft.files.filter((file) => file.path.replace(/^\/+/, "") !== SKILL_FILE);
  return [{ path: SKILL_FILE, content: skillMarkdown({ name: draft.name, description: draft.description, body: draft.instructions }) }, ...others];
}
var clip = (value, max) => value.length > max ? `${value.slice(0, max - 1).trimEnd()}\u2026` : value;
function draftFromText(source) {
  const body = source.trim();
  const lines = body.split(/\r?\n/);
  const heading = lines.findIndex((line) => /^#{1,6}\s+\S/.test(line));
  const at = heading >= 0 ? heading : lines.findIndex((line) => line.trim());
  const title = clip(lines[at]?.replace(/^(#{1,6}\s+|[>*\-\s]+)/, "").trim() ?? "", 80) || "Untitled skill";
  const rest = lines.filter((_, index) => index !== at).join("\n").replace(/```[\s\S]*?```/g, " ").replace(/[*_`>#]+/g, "").replace(/\s+/g, " ").trim();
  const sentence = rest.split(/(?<=[.!?])\s+/).find(Boolean) ?? title;
  const words = title.replace(/[`*]/g, "").split(/\s+/).filter(Boolean);
  let name = skillIdFrom(heading >= 0 ? title : words.slice(0, 5).join(" "));
  if (name.length > 40) name = name.slice(0, name.lastIndexOf("-", 40) > 0 ? name.lastIndexOf("-", 40) : 40);
  return { name: name || "skill", description: clip(sentence, 200), instructions: body };
}

// plugins/knowledge/src/skill-publish.ts
var isAlreadyExists = isSkillExists;
function domainIdOf2(catalog, schema2) {
  return catalog.snapshot().schemas.find((entry) => entry.schema === schema2)?.tags[DOMAIN_TAG];
}
async function tagDomain(client, fullName, domainId) {
  try {
    const domain = await new Domains(client).get(domainId);
    await new Tags(client).assign("skills", fullName, domain.tag_key);
    return { status: "tagged", tag: domain.tag_key };
  } catch (error) {
    return { status: "failed", error: describeError(error) };
  }
}
async function publishDraft(service, catalog, draft, schema2, options = {}) {
  const problem = validateDraft(draft) ?? (validSchemaName(schema2) ? void 0 : "Choose the schema to publish into, as catalog.schema.");
  if (problem) throw new Error(problem);
  const client = await service.ready();
  const [catalogName, schemaName] = schema2.split(".");
  const { created } = await new Skills(client).publish({ catalog: catalogName, schema: schemaName, id: draft.name }, skillFiles(draft), {
    replace: options.replace
  });
  const fullName = `${catalogName}.${schemaName}.${draft.name}`;
  const domainId = domainIdOf2(catalog, schema2);
  const domain = domainId ? await tagDomain(client, fullName, domainId) : void 0;
  void catalog.load(true);
  return { fullName, schema: schema2, created, ...domain && { domain }, shared: [] };
}
async function shareSkill(service, fullName, principal) {
  splitFullName(fullName);
  await new Skills(await service.ready()).grant(fullName, principal, ["READ_VOLUME"]);
}

// plugins/knowledge/src/skill-card.tsx
var published = /* @__PURE__ */ new Map();
var OTHER = "__other";
var inputStyle = { width: "100%" };
function skillBlock(service, catalog) {
  return function SkillBlock(props) {
    let draft;
    let problem;
    try {
      draft = parseDraft(props.code);
    } catch (failure) {
      problem = describeError(failure);
    }
    return /* @__PURE__ */ React.createElement(DbxRoot, null, draft ? /* @__PURE__ */ React.createElement(SkillEditor, { key: props.code, storeKey: props.code, initial: draft, service, catalog }) : /* @__PURE__ */ React.createElement(Notice, { tone: "warning", title: "This skill draft isn't readable yet" }, problem));
  };
}
function SkillEditor(props) {
  const { storeKey, initial, service, catalog, onClose } = props;
  const connection = useConnection(service);
  const snapshot = React.useSyncExternalStore(catalog.subscribe, catalog.snapshot);
  const [defaultSchema] = usePreference(service, DEFAULT_SCHEMA_PREF);
  const [draft, setDraft] = React.useState(initial);
  const [editing, setEditing] = React.useState(false);
  const [schema2, setSchema] = React.useState(initial.schema ?? defaultSchema ?? "");
  const [otherSchema, setOtherSchema] = React.useState(false);
  const [result, setResult] = React.useState(() => published.get(storeKey));
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState();
  const [replaceable, setReplaceable] = React.useState(false);
  const [principal, setPrincipal] = React.useState("");
  const [shareError, setShareError] = React.useState();
  const [sharing, setSharing] = React.useState(false);
  React.useEffect(() => {
    if (connection.status === "connected") void catalog.load();
  }, [connection.status, catalog]);
  const known = snapshot.schemas.map((entry) => entry.schema);
  const choices = [...known, ...schema2 && !known.includes(schema2) ? [schema2] : []];
  const selected = otherSchema ? OTHER : schema2;
  const connected = connection.status === "connected";
  const update = (fields) => {
    setDraft((current) => ({ ...current, ...fields }));
    setReplaceable(false);
  };
  const publish = async (replace) => {
    const problem = validateDraft(draft) ?? (validSchemaName(schema2) ? void 0 : "Choose the schema to publish into, as catalog.schema.");
    if (problem) {
      setError(problem);
      return;
    }
    setBusy(true);
    setError(void 0);
    setReplaceable(false);
    try {
      const next = await publishDraft(service, catalog, draft, schema2, { replace });
      published.set(storeKey, next);
      setResult(next);
    } catch (failure) {
      setReplaceable(isAlreadyExists(failure));
      setError(describeError(failure));
    } finally {
      setBusy(false);
    }
  };
  const share = async () => {
    const who = principal.trim();
    if (!result || !who) return;
    setSharing(true);
    setShareError(void 0);
    try {
      await shareSkill(service, result.fullName, who);
      const next = { ...result, shared: [...result.shared, who] };
      published.set(storeKey, next);
      setResult(next);
      setPrincipal("");
    } catch (failure) {
      setShareError(describeError(failure));
    } finally {
      setSharing(false);
    }
  };
  const retryDomain = async () => {
    if (!result) return;
    try {
      const domainId = domainIdOf2(catalog, result.schema);
      if (!domainId) return;
      const next = { ...result, domain: await tagDomain(await service.ready(), result.fullName, domainId) };
      published.set(storeKey, next);
      setResult(next);
    } catch (failure) {
      setShareError(describeError(failure));
    }
  };
  if (result) {
    return /* @__PURE__ */ React.createElement(Stack, { gap: 14 }, /* @__PURE__ */ React.createElement(Notice, { tone: "success", title: `${result.created ? "Published" : "Replaced"} ${result.fullName}` }, result.created ? "Agents can find and load it now." : "The existing skill now has this content."), result.domain?.status === "tagged" && /* @__PURE__ */ React.createElement(Text, { tone: "subtle", size: "sm" }, "Tagged with the domain tag ", result.domain.tag, "."), result.domain?.status === "failed" && /* @__PURE__ */ React.createElement(
      Notice,
      {
        tone: "warning",
        title: "Not tagged with the domain",
        action: /* @__PURE__ */ React.createElement(Button, { size: "sm", onClick: () => void retryDomain() }, "Try again")
      },
      result.domain.error
    ), /* @__PURE__ */ React.createElement(Stack, { gap: 8 }, /* @__PURE__ */ React.createElement(Text, { weight: 500, size: "sm" }, "Share it"), /* @__PURE__ */ React.createElement(Text, { tone: "subtle", size: "sm" }, "Only you can see it until you share it. Sharing gives read access to a person or group."), /* @__PURE__ */ React.createElement(Stack, { direction: "row", gap: 8, align: "center", wrap: true }, /* @__PURE__ */ React.createElement(
      "input",
      {
        className: "dbx-input",
        "aria-label": "Person or group",
        placeholder: "Email or group name",
        value: principal,
        onChange: (event) => setPrincipal(event.target.value),
        style: { flex: "1 1 220px", minWidth: 0 }
      }
    ), /* @__PURE__ */ React.createElement(Button, { disabled: !principal.trim() || sharing, onClick: () => void share() }, sharing ? "Sharing\u2026" : "Share")), result.shared.length > 0 && /* @__PURE__ */ React.createElement(Text, { size: "sm", tone: "subtle" }, "Shared with ", result.shared.join(", "), "."), shareError && /* @__PURE__ */ React.createElement(Notice, { tone: "danger", title: "Couldn't share it" }, shareError)), onClose && /* @__PURE__ */ React.createElement(Stack, { direction: "row", justify: "flex-end" }, /* @__PURE__ */ React.createElement(Button, { variant: "primary", onClick: onClose }, "Done")));
  }
  return /* @__PURE__ */ React.createElement(Stack, { gap: 14 }, !connected && /* @__PURE__ */ React.createElement(
    Notice,
    {
      title: "Connect Databricks to publish",
      action: /* @__PURE__ */ React.createElement(Button, { size: "sm", onClick: () => service.openSettings() }, "Connect")
    },
    "A skill is published to Unity Catalog as you."
  ), editing ? /* @__PURE__ */ React.createElement(Stack, { gap: 12 }, /* @__PURE__ */ React.createElement(Field, { label: "Name", hint: "Lowercase letters, digits, hyphens and underscores. Up to 64 characters." }, /* @__PURE__ */ React.createElement("input", { className: "dbx-input dbx-mono", value: draft.name, onChange: (event) => update({ name: event.target.value.trim() }), style: inputStyle }), draft.name && !validSkillId(draft.name) && /* @__PURE__ */ React.createElement(Text, { tone: "danger", size: "xs" }, "That name won't work; use lowercase letters, digits, hyphens and underscores.")), /* @__PURE__ */ React.createElement(Field, { label: "Description", hint: "One sentence on when an agent should use it." }, /* @__PURE__ */ React.createElement("textarea", { className: "dbx-textarea", rows: 2, value: draft.description, onChange: (event) => update({ description: event.target.value }), style: inputStyle })), /* @__PURE__ */ React.createElement(Field, { label: "Instructions", hint: "Markdown. Write it so an agent can follow it alone." }, /* @__PURE__ */ React.createElement("textarea", { className: "dbx-textarea dbx-mono", rows: 12, value: draft.instructions, onChange: (event) => update({ instructions: event.target.value }), style: inputStyle }))) : /* @__PURE__ */ React.createElement(Stack, { gap: 6 }, /* @__PURE__ */ React.createElement(Text, { weight: 600, mono: true }, draft.name), /* @__PURE__ */ React.createElement(Text, { tone: "subtle" }, draft.description), /* @__PURE__ */ React.createElement(Disclosure, { summary: "Instructions" }, /* @__PURE__ */ React.createElement(Markdown, { source: draft.instructions }))), draft.files.length > 0 && /* @__PURE__ */ React.createElement(Text, { size: "xs", tone: "subtle", mono: true }, "Files: ", draft.files.map((file) => file.path).join(", ")), /* @__PURE__ */ React.createElement(Field, { label: "Publish to", hint: schema2 ? void 0 : "Pick a schema. Schemas you've set up as skills schemas are listed." }, /* @__PURE__ */ React.createElement(Stack, { direction: "row", gap: 8, wrap: true }, /* @__PURE__ */ React.createElement(
    "select",
    {
      className: "dbx-select",
      "aria-label": "Target schema",
      value: selected,
      onChange: (event) => {
        const next = event.target.value;
        setOtherSchema(next === OTHER);
        setSchema(next === OTHER ? "" : next);
      },
      style: { flex: "1 1 240px", minWidth: 0 }
    },
    /* @__PURE__ */ React.createElement("option", { value: "" }, "Choose a schema"),
    choices.map((name) => /* @__PURE__ */ React.createElement("option", { key: name, value: name }, name)),
    /* @__PURE__ */ React.createElement("option", { value: OTHER }, "Other\u2026")
  ), otherSchema && /* @__PURE__ */ React.createElement(
    "input",
    {
      className: "dbx-input",
      "aria-label": "catalog.schema",
      placeholder: "catalog.schema",
      value: schema2,
      onChange: (event) => setSchema(event.target.value.trim()),
      style: { flex: "1 1 200px", minWidth: 0 }
    }
  ))), error && /* @__PURE__ */ React.createElement(Notice, { tone: "danger", title: replaceable ? "That name is taken" : "Couldn't publish it" }, error), /* @__PURE__ */ React.createElement(Stack, { direction: "row", gap: 8, align: "center", justify: "space-between", wrap: true }, /* @__PURE__ */ React.createElement(Button, { variant: "ghost", size: "sm", onClick: () => setEditing((value) => !value) }, editing ? "Done editing" : "Edit"), /* @__PURE__ */ React.createElement(Stack, { direction: "row", gap: 8, align: "center" }, onClose && /* @__PURE__ */ React.createElement(Button, { variant: "ghost", onClick: onClose }, "Cancel"), replaceable && /* @__PURE__ */ React.createElement(Button, { disabled: busy, onClick: () => void publish(true) }, "Replace it"), /* @__PURE__ */ React.createElement(Button, { variant: "primary", disabled: busy || !connected, onClick: () => void publish(false) }, busy ? "Publishing\u2026" : "Publish skill"))));
}

// plugins/knowledge/src/skill-action.tsx
var hasText = (message) => message.content.trim().length > 0;
function makeSkillAction(service, catalog) {
  return function MakeSkill(props) {
    const { message, close } = props;
    const channel = useAsync(
      async () => (await catalog.channel(message.channelId).catch(() => void 0))?.schema,
      [message.channelId]
    );
    const initial = { ...draftFromText(message.content), files: [], ...channel.data && { schema: channel.data } };
    return /* @__PURE__ */ React.createElement(Modal, { title: "Make this a skill", onClose: close }, channel.loading ? /* @__PURE__ */ React.createElement(Stack, { direction: "row", gap: 8, align: "center" }, /* @__PURE__ */ React.createElement(Spinner, { size: 12 }), /* @__PURE__ */ React.createElement(Text, { tone: "subtle", size: "sm" }, "Getting the channel's skills schema\u2026")) : /* @__PURE__ */ React.createElement(SkillEditor, { storeKey: `message:${message.id}`, initial, service, catalog, onClose: close }));
  };
}

// plugins/knowledge/src/skill-tools.ts
var READ_BUDGET = 1e5;
var MAX_PATHS = 20;
var MAX_DRAFT_FILES = 30;
var MAX_FILE_CHARS = 2e5;
var SETTINGS_PLACE = "Settings \u2192 Databricks Knowledge";
async function resolveSkill(catalog, name) {
  if (name.includes(".")) {
    splitFullName(name);
    return skillFullName(name);
  }
  const state = await catalog.load();
  const matches = state.skills.filter((skill) => skill.fullName.split(".").pop() === name);
  if (matches.length === 1) return matches[0].fullName;
  if (!matches.length) throw new Error(`There's no skill named ${name} in the skills schemas. Search for it first.`);
  throw new Error(`${matches.length} skills are called ${name}: ${matches.map((skill) => skill.fullName).join(", ")}. Use the full catalog.schema.${name} name.`);
}
function nothingFound(query, state) {
  const count = new Set(state.schemas.map((entry) => entry.schema)).size;
  const where = count ? `Searched ${count} skills schema${count === 1 ? "" : "s"}.` : "No skills schemas were found.";
  const trouble = state.note ?? state.error;
  return [
    `No skills match "${query}".`,
    where,
    trouble,
    `Skills schemas are schemas tagged agent_skills, or ones added in ${SETTINGS_PLACE}.`
  ].filter(Boolean).join(" ");
}
function parseFiles(value) {
  if (value === void 0 || value === null) return [];
  if (!Array.isArray(value)) throw new Error("files must be a list of {path, content}.");
  if (value.length > MAX_DRAFT_FILES) throw new Error(`A draft can have at most ${MAX_DRAFT_FILES} files.`);
  return value.map((entry) => {
    const file = entry;
    if (!file || typeof file.path !== "string" || typeof file.content !== "string") throw new Error("Each file needs a path and content.");
    if (file.content.length > MAX_FILE_CHARS) throw new Error(`${file.path} is over ${MAX_FILE_CHARS.toLocaleString()} characters; split it up.`);
    return { path: file.path.trim(), content: file.content };
  });
}
function skillTools(service, catalog) {
  return [
    {
      name: "databricks_skills_search",
      description: "Searches the team's skills in Unity Catalog and returns matches as full names with what each is for. Skills are instructions for a task, such as how to answer a kind of question or run a process. Search before doing a task that a skill might cover. Skills from the channel you're in come first when they match.",
      inputSchema: schema.object(
        { query: schema.string("What the task is about, in a few words."), limit: schema.integer("Most results to return (default 10, max 50).") },
        ["query"]
      ),
      async call(_client, context, args) {
        const query = stringArg(args, "query");
        const limit = numberArg(args, "limit", 10, 1, 50);
        const state = await catalog.load();
        const here = context.channel ? await catalog.channelSkills(context.channel) : [];
        const first = searchSkills(here, query, limit);
        const taken = new Set(first.map((skill) => skill.fullName));
        const rest = searchSkills(
          state.skills.filter((skill) => !taken.has(skill.fullName)),
          query,
          limit - first.length
        );
        const found = [...first, ...rest];
        if (!found.length) return nothingFound(query, state);
        return found.map((skill) => `- ${skill.fullName}${skill.description ? ` \u2014 ${skill.description}` : ""}`).join("\n");
      }
    },
    {
      name: "databricks_skills_load",
      description: "Loads a skill's SKILL.md: the instructions to follow for the task. Also lists the skill's other files, which databricks_skills_read_files reads. Pass the full catalog.schema.skill name from a search.",
      inputSchema: schema.object({ name: schema.string("The skill's full name, catalog.schema.skill.") }, ["name"]),
      async call(_client, _context, args) {
        const fullName = await resolveSkill(catalog, stringArg(args, "name"));
        const skills = new Skills(await service.ready());
        const instructions = await skills.load(fullName);
        let others = [];
        let note = "";
        try {
          others = (await skills.files(fullName)).filter((path) => path !== "SKILL.md");
        } catch (error) {
          note = `

(Couldn't list its other files: ${describeError(error)})`;
        }
        const list = others.length ? `

Other files in ${fullName} (read them with databricks_skills_read_files):
${others.map((path) => `- ${path}`).join("\n")}` : "";
        return `Skill ${fullName}:

${instructions.trim()}${list}${note}`;
      }
    },
    {
      name: "databricks_skills_read_files",
      description: `Reads other files from a skill, such as references or scripts, by their paths from databricks_skills_load. Returns at most about ${READ_BUDGET / 1e3} KB per call; anything over is cut and says so.`,
      inputSchema: {
        type: "object",
        properties: {
          name: schema.string("The skill's full name, catalog.schema.skill."),
          paths: { type: "array", items: { type: "string" }, description: `Relative file paths, up to ${MAX_PATHS}.` }
        },
        required: ["name", "paths"],
        additionalProperties: false
      },
      async call(_client, _context, args) {
        const fullName = await resolveSkill(catalog, stringArg(args, "name"));
        const paths = Array.isArray(args.paths) ? args.paths.filter((path) => typeof path === "string").map((path) => path.trim()).filter(Boolean) : [];
        if (!paths.length) throw new Error("paths needs at least one file path from databricks_skills_load.");
        if (paths.length > MAX_PATHS) throw new Error(`Read at most ${MAX_PATHS} files at a time.`);
        const skills = new Skills(await service.ready());
        let budget = READ_BUDGET;
        const parts = [];
        const skipped = [];
        for (const path of paths) {
          if (budget <= 0) {
            skipped.push(path);
            continue;
          }
          let text2;
          try {
            text2 = await skills.read(fullName, path);
          } catch (error) {
            parts.push(`=== ${path} ===
(Couldn't read it: ${describeError(error)})`);
            continue;
          }
          const body = text2.slice(0, budget);
          budget -= body.length;
          const cut = body.length < text2.length ? `
[Cut here: ${text2.length - body.length} characters left out.]` : "";
          parts.push(`=== ${path} ===
${body}${cut}`);
        }
        if (skipped.length) parts.push(`Not read, the ${READ_BUDGET / 1e3} KB limit was reached: ${skipped.join(", ")}. Ask for them in another call.`);
        return parts.join("\n\n");
      }
    },
    {
      name: "databricks_skills_draft",
      description: "Drafts a new skill from what you learned in this conversation, for the person to review and publish. This does NOT publish anything: it returns a databricks-skill block. Post that block exactly as it is in your reply; the person sees it as a card, edits it if needed, and publishes it from the card. Write instructions an agent can follow alone: the steps, the rules, the tables and the checks. The target schema defaults to the channel's skills schema.",
      inputSchema: schema.object(
        {
          name: schema.string("Short name for the skill, e.g. quarterly-revenue. Lowercase letters, digits, hyphens."),
          description: schema.string("One sentence on when to use the skill."),
          instructions: schema.string("The skill's instructions in Markdown."),
          files: {
            type: "array",
            description: "Optional supporting files, e.g. references or examples.",
            items: {
              type: "object",
              properties: { path: { type: "string", description: "Relative path, e.g. references/tables.md" }, content: { type: "string" } },
              required: ["path", "content"],
              additionalProperties: false
            }
          },
          schema: schema.string("Optional catalog.schema to publish into. Leave it out to use the channel's skills schema.")
        },
        ["name", "description", "instructions"]
      ),
      async call(_client, context, args) {
        const name = stringArg(args, "name");
        const explicit = stringArg(args, "schema", false);
        if (explicit && !validSchemaName(explicit)) throw new Error("schema must be catalog.schema.");
        const target = explicit || await channelOrDefault(catalog, service, context.channel);
        const draft = {
          name: validSkillId(name) ? name : skillIdFrom(name),
          description: stringArg(args, "description", false),
          instructions: stringArg(args, "instructions", false),
          files: parseFiles(args.files),
          ...target && { schema: target }
        };
        const problem = validateDraft(draft);
        if (problem) throw new Error(problem);
        const where = target ? `Publishes to ${target}.` : "No schema is set, so the card asks where to publish.";
        return `Drafted ${draft.name}. ${where} Nothing is published yet.

${draftBlock(draft)}

Post that block as it is in your reply.`;
      }
    }
  ];
}
async function channelOrDefault(catalog, service, channel) {
  if (channel) {
    const link = await catalog.channel(channel);
    if (link) return link.schema;
  }
  const preferred = service.preferences.get(DEFAULT_SCHEMA_PREF);
  return preferred && validSchemaName(preferred) ? preferred : void 0;
}

// plugins/knowledge/src/skill-settings.tsx
var LIST_LIMIT = 200;
function SkillsSettings(props) {
  const { service, catalog } = props;
  const connection = useConnection(service);
  const state = React.useSyncExternalStore(catalog.subscribe, catalog.snapshot);
  const [open, setOpen] = React.useState();
  React.useEffect(() => {
    if (connection.status === "connected") void catalog.load();
  }, [connection.status, catalog]);
  if (connection.status !== "connected") {
    return /* @__PURE__ */ React.createElement(Stack, { gap: 10 }, /* @__PURE__ */ React.createElement(SectionHeader, { title: "Skills", description: "Skills are instructions your agents can search and load." }), /* @__PURE__ */ React.createElement(Notice, { title: "Connect Databricks", action: /* @__PURE__ */ React.createElement(Button, { variant: "brand", onClick: () => service.openSettings() }, "Connect") }, "Skills live in your Unity Catalog."));
  }
  if (open) return /* @__PURE__ */ React.createElement(SkillDetail, { service, fullName: open, onBack: () => setOpen(void 0) });
  return /* @__PURE__ */ React.createElement(Stack, { gap: 20 }, /* @__PURE__ */ React.createElement(Stack, { gap: 6 }, /* @__PURE__ */ React.createElement(
    SectionHeader,
    {
      title: "Skills",
      description: "Skills come from schemas tagged agent_skills and any you add here. Agents search and load them; people publish them from chat.",
      action: /* @__PURE__ */ React.createElement(Button, { size: "sm", variant: "ghost", onClick: () => void catalog.load(true) }, "Refresh")
    }
  ), state.status === "loading" && /* @__PURE__ */ React.createElement(Stack, { direction: "row", gap: 8, align: "center" }, /* @__PURE__ */ React.createElement(Spinner, { size: 12 }), /* @__PURE__ */ React.createElement(Text, { tone: "subtle", size: "sm" }, "Looking for skills\u2026")), state.note && /* @__PURE__ */ React.createElement(Notice, { tone: "warning", title: "Some schemas may be missing" }, state.note), state.error && /* @__PURE__ */ React.createElement(Notice, { tone: "danger", title: "Couldn't load skills" }, state.error)), /* @__PURE__ */ React.createElement(SchemasSection, { service, catalog, schemas: state.schemas, skills: state.skills }), /* @__PURE__ */ React.createElement(DefaultSchema, { service, schemas: state.schemas }), /* @__PURE__ */ React.createElement(SkillList, { skills: state.skills, onOpen: setOpen }));
}
function SchemasSection(props) {
  const { service, catalog, schemas, skills } = props;
  const [name, setName] = React.useState("");
  const [message, setMessage] = React.useState();
  const [busy, setBusy] = React.useState(false);
  const counts = React.useMemo(() => {
    const counted = /* @__PURE__ */ new Map();
    for (const skill of skills) counted.set(schemaOf(skill.fullName), (counted.get(schemaOf(skill.fullName)) ?? 0) + 1);
    return counted;
  }, [skills]);
  const add = () => {
    const schema2 = name.trim();
    if (!validSchemaName(schema2)) return setMessage({ tone: "danger", text: "Use catalog.schema, for example main.team_skills." });
    if (catalog.locations().includes(schema2) || schemas.some((entry) => entry.schema === schema2 && entry.source === "tag"))
      return setMessage({ tone: "danger", text: `${schema2} is already a skills schema.` });
    catalog.setLocations([...catalog.locations(), schema2]);
    setName("");
    setMessage({ tone: "success", text: `Added ${schema2}.` });
  };
  const mark = async () => {
    const schema2 = name.trim();
    if (!validSchemaName(schema2)) return setMessage({ tone: "danger", text: "Use catalog.schema, for example main.team_skills." });
    setBusy(true);
    try {
      const client = await service.ready();
      const warehouse = await resolveWarehouse(service);
      const [catalogName, schemaName] = schema2.split(".");
      await new Tags(client).tagSchema(warehouse.id, catalogName, schemaName, { [SKILLS_TAG]: "true" });
      setName("");
      setMessage({ tone: "success", text: `Marked ${schema2}. It can take a minute to show up here.` });
      void catalog.load(true);
    } catch (failure) {
      setMessage({ tone: "danger", text: describeError(failure) });
    } finally {
      setBusy(false);
    }
  };
  const create = async () => {
    const schema2 = name.trim();
    if (!validSchemaName(schema2)) return setMessage({ tone: "danger", text: "Use catalog.schema, for example main.team_skills." });
    const [catalogName, schemaName] = schema2.split(".");
    setBusy(true);
    try {
      const client = await service.ready();
      await client.post("/api/2.1/unity-catalog/schemas", { name: schemaName, catalog_name: catalogName });
      const warehouse = await resolveWarehouse(service);
      await new Tags(client).tagSchema(warehouse.id, catalogName, schemaName, { [SKILLS_TAG]: "true" });
      setName("");
      setMessage({ tone: "success", text: `Created ${schema2} as a skills schema. It can take a minute to show up here.` });
      void catalog.load(true);
    } catch (failure) {
      setMessage({ tone: "danger", text: createMessage(failure, catalogName) });
    } finally {
      setBusy(false);
    }
  };
  return /* @__PURE__ */ React.createElement(Stack, { gap: 10 }, /* @__PURE__ */ React.createElement(SectionHeader, { title: "Skills schemas", description: "Where skills are found. Tagged schemas are found everywhere; added ones are yours on this device." }), schemas.length === 0 && /* @__PURE__ */ React.createElement(Text, { tone: "subtle", size: "sm" }, "No skills schemas yet. Mark an existing schema or create one below."), schemas.map((entry) => /* @__PURE__ */ React.createElement("div", { key: entry.schema, className: "dbx-card", style: { padding: "10px 12px" } }, /* @__PURE__ */ React.createElement(Stack, { direction: "row", gap: 10, align: "center", justify: "space-between", wrap: true }, /* @__PURE__ */ React.createElement(Stack, { direction: "row", gap: 8, align: "center" }, /* @__PURE__ */ React.createElement(Text, { mono: true, size: "sm", weight: 500 }, entry.schema), /* @__PURE__ */ React.createElement(Text, { tone: "tertiary", size: "xs" }, entry.source === "tag" ? "Tagged" : "Added", " \xB7 ", counts.get(entry.schema) ?? 0, " skill", (counts.get(entry.schema) ?? 0) === 1 ? "" : "s")), entry.source === "added" && /* @__PURE__ */ React.createElement(
    Button,
    {
      size: "sm",
      variant: "ghost",
      onClick: () => {
        catalog.setLocations(catalog.locations().filter((location) => location !== entry.schema));
        setMessage({ tone: "success", text: `Removed ${entry.schema}.` });
      }
    },
    "Remove"
  )))), /* @__PURE__ */ React.createElement(Field, { label: "Schema", hint: "Add a schema that already has skills, mark an existing schema as a skills schema, or create a new one." }, /* @__PURE__ */ React.createElement(Stack, { direction: "row", gap: 8, wrap: true }, /* @__PURE__ */ React.createElement("input", { className: "dbx-input", value: name, placeholder: "catalog.schema", onChange: (event) => setName(event.target.value), style: { flex: "1 1 220px", minWidth: 0 } }))), /* @__PURE__ */ React.createElement(Stack, { direction: "row", gap: 8, wrap: true }, /* @__PURE__ */ React.createElement(Button, { onClick: add, disabled: busy }, "Add"), /* @__PURE__ */ React.createElement(Button, { onClick: () => void mark(), disabled: busy }, "Mark as a skills schema"), /* @__PURE__ */ React.createElement(Button, { onClick: () => void create(), disabled: busy }, "Create a skills schema")), message && /* @__PURE__ */ React.createElement(Text, { tone: message.tone, size: "sm" }, message.text));
}
function createMessage(failure, catalog) {
  if (isApiError(failure) && failure.isPermission)
    return `You need CREATE SCHEMA on ${catalog} to create a schema there. Ask a catalog owner, or mark an existing schema instead.`;
  if (isApiError(failure) && failure.status === 409) return "That schema already exists. Mark it as a skills schema instead.";
  return describeError(failure);
}
function DefaultSchema(props) {
  const { service, schemas } = props;
  const [value, setValue] = usePreference(service, DEFAULT_SCHEMA_PREF);
  const names = schemas.map((entry) => entry.schema);
  return /* @__PURE__ */ React.createElement(Field, { label: "Publish skills to", hint: "The schema a new skill goes to when its channel has none. Each draft still shows the schema before you publish." }, /* @__PURE__ */ React.createElement("select", { className: "dbx-select", "aria-label": "Default schema", value: value ?? "", onChange: (event) => setValue(event.target.value || void 0), style: { maxWidth: 360 } }, /* @__PURE__ */ React.createElement("option", { value: "" }, "Ask each time"), names.map((name) => /* @__PURE__ */ React.createElement("option", { key: name, value: name }, name)), value && !names.includes(value) && /* @__PURE__ */ React.createElement("option", { value }, value)));
}
function SkillList(props) {
  const [query, setQuery] = React.useState("");
  const matches = query.trim() ? searchSkills(props.skills, query, LIST_LIMIT) : props.skills.slice(0, LIST_LIMIT);
  return /* @__PURE__ */ React.createElement(Stack, { gap: 10 }, /* @__PURE__ */ React.createElement(
    SectionHeader,
    {
      title: "Skills",
      description: props.skills.length ? `${props.skills.length} in your skills schemas.` : void 0
    }
  ), /* @__PURE__ */ React.createElement("input", { className: "dbx-input", placeholder: "Search skills", "aria-label": "Search skills", value: query, onChange: (event) => setQuery(event.target.value), style: { maxWidth: 420 } }), !props.skills.length && /* @__PURE__ */ React.createElement(Text, { tone: "subtle", size: "sm" }, "No skills yet. Publish one from a message, or ask an agent to draft one."), query.trim() && !matches.length && /* @__PURE__ */ React.createElement(Text, { tone: "subtle", size: "sm" }, "Nothing matches."), matches.map((skill) => /* @__PURE__ */ React.createElement(
    "button",
    {
      key: skill.fullName,
      type: "button",
      onClick: () => props.onOpen(skill.fullName),
      className: "dbx-card",
      style: { padding: "10px 12px", textAlign: "left", cursor: "pointer", font: "inherit", color: "inherit" }
    },
    /* @__PURE__ */ React.createElement(Stack, { gap: 2 }, /* @__PURE__ */ React.createElement(Text, { mono: true, size: "sm", weight: 500 }, skill.fullName), skill.description && /* @__PURE__ */ React.createElement(Text, { tone: "subtle", size: "sm" }, skill.description))
  )), props.skills.length > LIST_LIMIT && !query.trim() && /* @__PURE__ */ React.createElement(Text, { tone: "tertiary", size: "xs" }, "Showing the first ", LIST_LIMIT, ". Search for the rest."));
}
function SkillDetail(props) {
  const { service, fullName, onBack } = props;
  const detail = useAsync(
    async (signal) => {
      const skills = new Skills(await service.ready(signal));
      const [text2, files] = await Promise.all([skills.read(fullName, "SKILL.md", signal), skills.files(fullName, signal)]);
      return { parsed: parseSkillMarkdown(text2), files: files.filter((path) => path !== "SKILL.md") };
    },
    [service, fullName]
  );
  return /* @__PURE__ */ React.createElement(DbxRoot, null, /* @__PURE__ */ React.createElement(Stack, { gap: 14 }, /* @__PURE__ */ React.createElement("div", null, /* @__PURE__ */ React.createElement(Button, { size: "sm", variant: "ghost", onClick: onBack }, "\u2190 All skills")), /* @__PURE__ */ React.createElement(Stack, { gap: 4 }, /* @__PURE__ */ React.createElement(Text, { mono: true, weight: 600 }, fullName), detail.data?.parsed.description && /* @__PURE__ */ React.createElement(Text, { tone: "subtle" }, detail.data.parsed.description)), detail.loading && /* @__PURE__ */ React.createElement(Stack, { direction: "row", gap: 8, align: "center" }, /* @__PURE__ */ React.createElement(Spinner, { size: 12 }), /* @__PURE__ */ React.createElement(Text, { tone: "subtle", size: "sm" }, "Loading\u2026")), detail.error && /* @__PURE__ */ React.createElement(Notice, { tone: "danger", title: "Couldn't read this skill" }, describeError(detail.error)), detail.data && /* @__PURE__ */ React.createElement(Markdown, { source: detail.data.parsed.body }), detail.data && /* @__PURE__ */ React.createElement(Disclosure, { summary: `Other files (${detail.data.files.length})` }, detail.data.files.length ? /* @__PURE__ */ React.createElement(Stack, { gap: 2 }, detail.data.files.map((path) => /* @__PURE__ */ React.createElement(Text, { key: path, mono: true, size: "sm" }, path))) : /* @__PURE__ */ React.createElement(Text, { tone: "subtle", size: "sm" }, "This skill has only SKILL.md."))));
}

// plugins/knowledge/src/skills.tsx
function registerSkills(scope, service, catalog) {
  scope.conversation.registerCodeBlock({
    id: "skill",
    title: "Databricks skill",
    matches: (language) => language.trim().toLowerCase() === DRAFT_LANGUAGE,
    component: skillBlock(service, catalog)
  });
  scope.conversation.registerMessageAction({
    id: "make-skill",
    title: "Make this a skill",
    matches: (message) => hasText(message),
    component: makeSkillAction(service, catalog)
  });
  scope.inject(["agents"], (agents) => {
    for (const tool of skillTools(service, catalog)) agents.agents.addTool(tool);
  });
}

// plugins/knowledge/src/index.tsx
var inject = ["react", "conversation", "panels", "settingsCards"];
function apply(ctx) {
  bindReact(ctx.react);
  const live = attach(ctx, { id: "bkvarda.databricks-knowledge", name: "Databricks Knowledge" }, (scope, databricks) => {
    const catalog = new SkillCatalog(databricks);
    registerSkills(scope, databricks, catalog);
    registerChannels(scope, databricks, catalog);
    return { databricks, catalog };
  });
  ctx.settingsCards.register({
    id: "knowledge",
    title: "Databricks Knowledge",
    component: () => {
      const runtime = useLive(live);
      return runtime ? /* @__PURE__ */ React.createElement(DbxRoot, null, /* @__PURE__ */ React.createElement(Stack, { gap: 24 }, /* @__PURE__ */ React.createElement(SkillsSettings, { service: runtime.databricks, catalog: runtime.catalog }), /* @__PURE__ */ React.createElement(DomainSettings, { service: runtime.databricks, catalog: runtime.catalog }))) : /* @__PURE__ */ React.createElement(MissingCore, { ctx, feature: "Databricks Knowledge" });
    }
  });
}
export {
  apply,
  inject
};
