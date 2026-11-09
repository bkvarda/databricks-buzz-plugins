// Lakebase (bkvarda.databricks-lakebase) — built by databricks-buzz-plugins. Apache-2.0.

// packages/core/src/api/workspace.ts
var detail = (error) => {
  const body = error.body ?? "";
  try {
    const parsed = JSON.parse(body);
    return [parsed.code, parsed.message].filter(Boolean).join(": ") || `HTTP ${error.status}`;
  } catch {
    return `HTTP ${error.status}`;
  }
};
function dataApiSetupSql(user, schema2 = "public") {
  const role = `"${user.replace(/"/g, '""')}"`;
  const literal = `'${user.replace(/'/g, "''")}'`;
  return [
    "CREATE EXTENSION IF NOT EXISTS databricks_auth;",
    `SELECT databricks_create_role(${literal}, 'USER');`,
    `GRANT ${role} TO authenticator;`,
    `GRANT USAGE ON SCHEMA ${schema2} TO ${role};`,
    `GRANT SELECT ON ALL TABLES IN SCHEMA ${schema2} TO ${role};`
  ].join("\n");
}
var DataApiRoleError = class extends Error {
  constructor(cause) {
    super(
      "The Data API can't act as you yet. A Lakebase project owner needs to create your Postgres role with databricks_create_role and grant it to authenticator (Settings \u2192 Lakebase shows the SQL).",
      { cause }
    );
    this.name = "DataApiRoleError";
  }
};
function dataApiError(error, table) {
  const status = error.status;
  const message = error.message ?? String(error);
  if (status === 503 && /data api is not enabled/i.test(message))
    return new Error("The Data API isn't turned on for this Lakebase project. Turn it on in Lakebase \u2192 the project \u2192 Data API.", { cause: error });
  if (status === 404 && /PGRST205|could not find the table/i.test(`${message} ${error.body ?? ""}`))
    return new Error(`There's no table or view named ${table} that you can read. Check the name and schema, and that it's in an exposed schema.`, { cause: error });
  if (/permission denied to set role/i.test(detail(error))) return new DataApiRoleError(error);
  if (status === 401 || status === 403)
    return new Error(`Lakebase refused the request (${detail(error)}). You need a Postgres role on this branch with access to the table.`, { cause: error });
  return error instanceof Error ? error : new Error(message);
}
var Lakebase = class {
  constructor(client) {
    this.client = client;
  }
  async projects(signal) {
    const response = await this.client.get("/api/2.0/postgres/projects", signal ? { signal } : {});
    return (response.projects ?? []).map((project) => ({
      id: project.name.replace(/^projects\//, ""),
      name: project.spec?.display_name ?? project.name.replace(/^projects\//, ""),
      pgVersion: project.spec?.pg_version,
      status: project.status
    }));
  }
  async branches(projectId, signal) {
    const response = await this.client.get(
      `/api/2.0/postgres/projects/${encodeURIComponent(projectId)}/branches`,
      signal ? { signal } : {}
    );
    return response.branches ?? [];
  }
  /**
   * Data API base URLs for a project's default branch, one per database:
   * https://<read-write host>/api/2.0/workspace/<workspace-id>/rest/<database>
   */
  async dataApiTargets(projectId, workspaceId, signal) {
    const branches = await this.branches(projectId, signal);
    const branch = branches.find((candidate) => candidate.status?.default) ?? branches[0];
    if (!branch) return [];
    const opts = signal ? { signal } : {};
    const [endpoints, databases2] = await Promise.all([
      this.client.get(
        `/api/2.0/postgres/${branch.name}/endpoints`,
        opts
      ),
      this.client.get(`/api/2.0/postgres/${branch.name}/databases`, opts)
    ]);
    const host = (endpoints.endpoints ?? []).find(
      (endpoint) => endpoint.status?.endpoint_type === "ENDPOINT_TYPE_READ_WRITE" && !endpoint.status.disabled && endpoint.status.hosts?.host
    )?.status?.hosts?.host;
    if (!host) return [];
    return (databases2.databases ?? []).flatMap((database) => {
      const name = database.status?.postgres_database;
      return name ? [{ project: projectId, branch: branch.name.split("/").pop() ?? "", database: name, url: `https://${host}/api/2.0/workspace/${workspaceId}/rest/${encodeURIComponent(name)}` }] : [];
    });
  }
  /**
   * Reads rows through a Data API endpoint, e.g.
   * dataApi("https://…/api/2.0/…", "public", "orders", { select: "id,total", limit: 20 }).
   * PostgREST filters go in `filters` as column → "op.value" (e.g. "eq.42").
   */
  async select(endpoint, schema2, table, options = {}) {
    if (!/^https:\/\//.test(endpoint)) throw new Error("The Data API endpoint must be an https:// URL.");
    if (!/^[A-Za-z_][\w$]*$/.test(schema2) || !/^[A-Za-z_][\w$]*$/.test(table)) throw new Error("Invalid schema or table name.");
    try {
      return await this.client.get(`${endpoint.replace(/\/+$/, "")}/${schema2}/${table}`, {
        query: {
          select: options.select ?? "*",
          limit: Math.min(options.limit ?? 50, 1e3),
          ...options.order && { order: options.order },
          ...options.filters
        },
        headers: { "Accept-Profile": schema2 },
        ...options.signal && { signal: options.signal }
      });
    } catch (error) {
      throw dataApiError(error, table);
    }
  }
};

// packages/core/src/client.ts
var DatabricksApiError = class extends Error {
  constructor(status, errorCode, message, body) {
    super(message);
    this.status = status;
    this.errorCode = errorCode;
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
    const text = response.body.trim();
    if (text && text.length < 400 && !text.startsWith("<")) message = text;
  }
  return new DatabricksApiError(response.status, code, message, response.body);
}

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

// packages/core/src/react.ts
var React = void 0;
function bindReact(instance) {
  React = instance;
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
var compact = new Intl.NumberFormat(void 0, { notation: "compact", maximumFractionDigits: 1 });
var precise = new Intl.NumberFormat(void 0, { maximumFractionDigits: 2 });
function formatNumber(value, style = "precise") {
  if (!Number.isFinite(value)) return String(value);
  if (style === "compact" && Math.abs(value) >= 1e4) return compact.format(value);
  return precise.format(value);
}
function formatCell(value, kind) {
  if (value === null) return "null";
  if (kind === "number") {
    const parsed = Number(value);
    if (Number.isFinite(parsed) && Math.abs(parsed) < 1e15) return formatNumber(parsed);
  }
  if (kind === "time" && /T00:00:00(\.000)?(Z)?$/.test(value)) return value.slice(0, 10);
  return value;
}
function toMarkdown(result, maxRows = 20) {
  if (!result.columns.length) return "_No columns._";
  const escape = (value) => value.replace(/\|/g, "\\|").replace(/\n/g, " ");
  const head = `| ${result.columns.map((column) => escape(column.name)).join(" | ")} |`;
  const rule = `| ${result.columns.map((column) => column.kind === "number" ? "---:" : "---").join(" | ")} |`;
  const body = result.rows.slice(0, maxRows).map(
    (row) => `| ${result.columns.map((column, index) => escape(formatCell(row[index] ?? null, column.kind))).join(" | ")} |`
  );
  const total = result.totalRows ?? result.rows.length;
  const note = total > Math.min(maxRows, result.rows.length) ? `

_Showing ${Math.min(maxRows, result.rows.length)} of ${total} rows._` : "";
  return [head, rule, ...body].join("\n") + note;
}

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

// packages/core/src/installed.ts
function statusMethods(installer) {
  const get = installer?.getInstallationStatus;
  const subscribe = installer?.subscribeInstallationStatus;
  if (typeof get !== "function" || typeof subscribe !== "function") return void 0;
  return {
    get: (id) => get.call(installer, id),
    subscribe: (id, listener) => subscribe.call(installer, id, () => listener())
  };
}
function useInstallationStatus(installer, ids) {
  const key = ids.join("\n");
  const getter = React.useRef(installer);
  getter.current = installer;
  const [statuses, setStatuses] = React.useState(/* @__PURE__ */ new Map());
  React.useEffect(() => {
    const methods = statusMethods(getter.current());
    if (!methods) return;
    const list = key.split("\n");
    const read = () => {
      const next = new Map(list.map((id) => [id, methods.get(id)]));
      setStatuses((current) => sameStatuses(current, next) ? current : next);
    };
    const stops = list.map((id) => methods.subscribe(id, read));
    read();
    return () => {
      for (const stop of stops) stop();
    };
  }, [key]);
  return statuses;
}
function sameStatuses(a, b) {
  return a.size === b.size && [...b].every(([id, status]) => a.get(id) === status);
}
function openPluginDetails(ctx, id) {
  const navigation = optionalService(ctx, "navigation");
  if (!navigation) return false;
  void navigation.open({ version: 1, kind: "settings", section: "plugins", pluginId: id });
  return true;
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
function styleHash(text) {
  let hash = 5381;
  for (let i = 0; i < text.length; i++) hash = (hash << 5) + hash + text.charCodeAt(i) | 0;
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
  const installer = React.useCallback(() => optionalService(props.ctx, "pluginInstaller"), [props.ctx]);
  const installed = useInstallationStatus(installer, [CORE_PLUGIN_ID]).get(CORE_PLUGIN_ID) === "installed";
  const add = async () => {
    const service = installer();
    if (!service) {
      setMessage("Add it from Settings \u2192 Plugins \u2192 Manage plugins \u2192 Add, using github.com/bkvarda/databricks-buzz-plugins.");
      return;
    }
    const outcome = await service.requestInstall({ repository: REPOSITORY, reference: "main", path: "plugins/databricks/dist" }).catch(() => "unavailable");
    if (outcome === "unavailable") setMessage("Close any open plugin review and try again.");
  };
  if (installed)
    return /* @__PURE__ */ React.createElement(DbxRoot, { style: { padding: 32 } }, /* @__PURE__ */ React.createElement(
      EmptyState,
      {
        title: "Turn on the Databricks plugin",
        action: /* @__PURE__ */ React.createElement(
          Button,
          {
            variant: "brand",
            onClick: () => {
              if (!openPluginDetails(props.ctx, CORE_PLUGIN_ID)) setMessage("Open Settings \u2192 Plugins \u2192 Manage plugins and turn on Databricks.");
            }
          },
          "Open in Plugins"
        )
      },
      props.feature,
      " uses the Databricks plugin (",
      CORE_PLUGIN_ID,
      ") for sign-in. It's installed but turned off, or it couldn't start.",
      message && /* @__PURE__ */ React.createElement("p", null, message)
    ));
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

// plugins/lakebase/src/index.tsx
var inject = ["react", "settingsCards"];
var DATABASES = "lakebaseDatabases";
var databases = (service) => service.preferences.get(DATABASES) ?? [];
function rowsToResult(rows) {
  const columns = [...new Set(rows.flatMap((row) => Object.keys(row)))];
  return resultSet(
    columns.map((name) => ({ name })),
    rows.map((row) => columns.map((column) => row[column] == null ? null : typeof row[column] === "object" ? JSON.stringify(row[column]) : String(row[column])))
  );
}
function lakebaseTools(service) {
  return [
    {
      name: "databricks_lakebase_databases",
      description: "Lists the Lakebase (Databricks Postgres) databases the owner registered for agents, plus the Lakebase projects in the workspace. Use a registered database name with databricks_lakebase_select.",
      inputSchema: schema.object({}),
      async call() {
        const client = await service.ready();
        const registered = databases(service);
        const projects = (await new Lakebase(client).projects().catch(() => [])).filter((project) => !project.id.startsWith("databricks-internal-"));
        return [
          registered.length ? `Registered databases:
${registered.map((db) => `- ${db.name}${db.description ? `: ${db.description}` : ""}`).join("\n")}` : "No databases are registered for agents yet (the owner adds Data API endpoints in Settings \u2192 Lakebase).",
          projects.length ? `
Lakebase projects in the workspace:
${projects.map((p) => `- ${p.name} (${p.id})`).join("\n")}` : ""
        ].join("\n");
      }
    },
    {
      name: "databricks_lakebase_select",
      description: 'Reads rows from a table or view in a registered Lakebase database through the Data API (PostgREST). Filter with PostgREST operators, e.g. filters {"status": "eq.open", "amount": "gt.100"}; order like "created_at.desc". Read-only.',
      inputSchema: schema.object(
        {
          database: schema.string("A registered database name."),
          table: schema.string("Table or view name."),
          schema: schema.string("Postgres schema (default public)."),
          select: schema.string("Columns, comma separated (default *)."),
          filters: { type: "object", description: "Column \u2192 PostgREST condition such as eq.42.", additionalProperties: { type: "string" } },
          order: schema.string("Ordering, e.g. created_at.desc"),
          limit: schema.integer("Rows (default 50, max 500).")
        },
        ["database", "table"]
      ),
      async call(_client, _context, args) {
        const name = stringArg(args, "database");
        const database = databases(service).find((db) => db.name.toLowerCase() === name.toLowerCase());
        if (!database) throw new Error(`No registered database named ${name}. Call databricks_lakebase_databases.`);
        const client = await service.ready();
        const rows = await new Lakebase(client).select(database.url, stringArg(args, "schema", false) || "public", stringArg(args, "table"), {
          ...stringArg(args, "select", false) && { select: stringArg(args, "select") },
          ...args.filters && typeof args.filters === "object" ? { filters: args.filters } : {},
          ...stringArg(args, "order", false) && { order: stringArg(args, "order") },
          limit: numberArg(args, "limit", 50, 1, 500)
        });
        if (!rows.length) return "No rows.";
        return `${toMarkdown(rowsToResult(rows), 100)}

These rows came from the owner's access; everyone in this conversation can read what you post.`;
      }
    }
  ];
}
async function checkDatabase(service, url) {
  try {
    const client = await service.ready();
    const response = await client.request(`${url.replace(/\/+$/, "")}/public/buzz_connection_check`, { query: { limit: 0 }, headers: { "Accept-Profile": "public" } });
    if (response.status < 400 || /PGRST205/.test(response.body)) return { state: "ok", message: "The Data API is on and answering." };
    const error = dataApiError(apiError(response), "");
    return { state: error.name === "DataApiRoleError" ? "role" : "error", message: error.message };
  } catch (error) {
    return { state: "error", message: describeError(error) };
  }
}
function DatabaseRow(props) {
  const [check, setCheck] = React.useState({ state: "idle" });
  return /* @__PURE__ */ React.createElement("div", { className: "dbx-card", style: { padding: 12 } }, /* @__PURE__ */ React.createElement(Stack, { gap: 8 }, /* @__PURE__ */ React.createElement(Stack, { direction: "row", align: "center", justify: "space-between", gap: 10 }, /* @__PURE__ */ React.createElement(Stack, { gap: 2, style: { minWidth: 0 } }, /* @__PURE__ */ React.createElement(Text, { weight: 500 }, props.db.name), /* @__PURE__ */ React.createElement(Text, { tone: "subtle", size: "xs", mono: true, style: { overflow: "hidden", textOverflow: "ellipsis" } }, props.db.url)), /* @__PURE__ */ React.createElement(Stack, { direction: "row", gap: 6, align: "center", style: { flex: "none" } }, /* @__PURE__ */ React.createElement(Button, { size: "sm", disabled: check.state === "testing", onClick: async () => {
    setCheck({ state: "testing" });
    setCheck(await checkDatabase(props.service, props.db.url));
  } }, check.state === "testing" ? /* @__PURE__ */ React.createElement(Spinner, { size: 12 }) : null, "Test"), /* @__PURE__ */ React.createElement(Button, { size: "sm", variant: "danger", onClick: props.onRemove }, "Remove"))), check.state === "ok" && /* @__PURE__ */ React.createElement(Text, { size: "sm", tone: "success" }, check.message), check.state === "error" && /* @__PURE__ */ React.createElement(Text, { size: "sm", tone: "danger" }, check.message), /* @__PURE__ */ React.createElement(Disclosure, { summary: "Access setup for the Data API", defaultOpen: check.state === "role" }, /* @__PURE__ */ React.createElement(Stack, { gap: 8 }, /* @__PURE__ */ React.createElement(Text, { size: "sm", tone: check.state === "role" ? "warning" : "subtle", as: "div" }, check.state === "role" ? `${check.message} ` : "", "The Data API reads as you, through a Postgres role a project owner creates once in the project's SQL editor. Roles added in the Lakebase UI, and project owners themselves, can't be used."), /* @__PURE__ */ React.createElement(CodeView, { code: dataApiSetupSql(props.userName) })))));
}
function ProjectRow(props) {
  const { service, project, workspaceId } = props;
  const targets = useAsync(
    async (signal) => workspaceId ? new Lakebase(await service.ready(signal)).dataApiTargets(project.id, workspaceId, signal) : [],
    [project.id, workspaceId]
  );
  return /* @__PURE__ */ React.createElement("div", { className: "dbx-card", style: { padding: 12 } }, /* @__PURE__ */ React.createElement(Stack, { gap: 8 }, /* @__PURE__ */ React.createElement(Stack, { direction: "row", gap: 8, align: "center" }, /* @__PURE__ */ React.createElement(Text, { weight: 500 }, project.name), project.id !== project.name && /* @__PURE__ */ React.createElement(Text, { tone: "tertiary", size: "xs", mono: true }, project.id)), targets.loading && /* @__PURE__ */ React.createElement(Spinner, { size: 12 }), targets.error && /* @__PURE__ */ React.createElement(Text, { tone: "subtle", size: "sm" }, describeError(targets.error)), (targets.data ?? []).map((target) => {
    const added = props.added.includes(target.url);
    return /* @__PURE__ */ React.createElement(Stack, { key: target.url, direction: "row", gap: 8, align: "center", justify: "space-between" }, /* @__PURE__ */ React.createElement(Text, { size: "sm", mono: true }, target.branch, " / ", target.database), added ? /* @__PURE__ */ React.createElement(Badge, { tone: "success" }, "Added") : /* @__PURE__ */ React.createElement(Button, { size: "sm", onClick: () => props.onAdd(target) }, "Add for agents"));
  }), targets.data && !targets.data.length && /* @__PURE__ */ React.createElement(Text, { tone: "subtle", size: "sm" }, "No read-write compute on the default branch.")));
}
function LakebaseSettings(props) {
  const { service } = props;
  const snapshot = useConnection(service);
  const [list, setList] = usePreference(service, DATABASES);
  const [draft, setDraft] = React.useState({ name: "", url: "", description: "" });
  const [test, setTest] = React.useState({ state: "idle" });
  const projects = useAsync(
    async (signal) => (await new Lakebase(await service.ready(signal)).projects(signal)).filter((project) => !project.id.startsWith("databricks-internal-")),
    [snapshot.status]
  );
  if (snapshot.status !== "connected")
    return /* @__PURE__ */ React.createElement(Notice, { title: "Connect Databricks", action: /* @__PURE__ */ React.createElement(Button, { variant: "brand", onClick: () => service.openSettings() }, "Connect") }, "Lakebase lives in your Databricks workspace.");
  const valid = /^[a-z][\w-]{0,40}$/i.test(draft.name) && /^https:\/\//.test(draft.url);
  return /* @__PURE__ */ React.createElement(Stack, { gap: 24 }, /* @__PURE__ */ React.createElement(Stack, { gap: 6 }, /* @__PURE__ */ React.createElement(Text, { as: "h2", size: "xl", weight: 500 }, "Lakebase"), /* @__PURE__ */ React.createElement(Text, { tone: "subtle" }, "Give agents read access to operational data in Lakebase Postgres. Requests use your Databricks sign-in, so your Postgres role's grants apply.")), /* @__PURE__ */ React.createElement(Stack, { gap: 10 }, /* @__PURE__ */ React.createElement(SectionHeader, { title: "Databases for agents", description: (list ?? []).length ? "Agents can read these with databricks_lakebase_select." : "None yet. Add one from your projects below." }), (list ?? []).map((db) => /* @__PURE__ */ React.createElement(
    DatabaseRow,
    {
      key: db.name,
      service,
      db,
      userName: snapshot.user.userName,
      onRemove: () => setList((list ?? []).filter((candidate) => candidate.name !== db.name))
    }
  )), /* @__PURE__ */ React.createElement(Disclosure, { summary: "Add by Data API URL" }, /* @__PURE__ */ React.createElement(Stack, { gap: 8, style: { maxWidth: 560 } }, /* @__PURE__ */ React.createElement(Field, { label: "Name agents use" }, /* @__PURE__ */ React.createElement("input", { className: "dbx-input", value: draft.name, onChange: (event) => setDraft({ ...draft, name: event.target.value.trim() }), placeholder: "orders-db" })), /* @__PURE__ */ React.createElement(Field, { label: "Data API URL" }, /* @__PURE__ */ React.createElement("input", { className: "dbx-input", value: draft.url, onChange: (event) => setDraft({ ...draft, url: event.target.value.trim() }), placeholder: "https://\u2026" })), /* @__PURE__ */ React.createElement(Field, { label: "What's in it (optional)" }, /* @__PURE__ */ React.createElement("input", { className: "dbx-input", value: draft.description, onChange: (event) => setDraft({ ...draft, description: event.target.value }), placeholder: "Orders and fulfillment for the storefront app" })), /* @__PURE__ */ React.createElement(Stack, { direction: "row", gap: 8, align: "center" }, /* @__PURE__ */ React.createElement(
    Button,
    {
      disabled: !valid || test.state === "testing",
      onClick: async () => {
        setTest({ state: "testing" });
        const result = await checkDatabase(service, draft.url);
        setTest({ state: result.state === "ok" ? "ok" : "error", ...result.message && { message: result.message } });
      }
    },
    test.state === "testing" ? /* @__PURE__ */ React.createElement(Spinner, { size: 12 }) : null,
    "Test"
  ), /* @__PURE__ */ React.createElement(
    Button,
    {
      variant: "primary",
      disabled: !valid || (list ?? []).some((db) => db.name === draft.name),
      onClick: () => {
        setList([...list ?? [], { name: draft.name, url: draft.url.replace(/\/+$/, ""), ...draft.description?.trim() && { description: draft.description.trim() } }]);
        setDraft({ name: "", url: "", description: "" });
        setTest({ state: "idle" });
      }
    },
    "Add database"
  ), test.message && /* @__PURE__ */ React.createElement(Text, { size: "sm", tone: test.state === "ok" ? "success" : "danger" }, test.message))))), /* @__PURE__ */ React.createElement(Stack, { gap: 8 }, /* @__PURE__ */ React.createElement(SectionHeader, { title: "Lakebase projects in this workspace", description: "Add a database in one click. Agents read it through its Data API, which must be turned on for the project." }), projects.loading && /* @__PURE__ */ React.createElement(Spinner, { size: 12 }), projects.error && /* @__PURE__ */ React.createElement(Text, { tone: "subtle", size: "sm" }, describeError(projects.error)), (projects.data ?? []).map((project) => /* @__PURE__ */ React.createElement(
    ProjectRow,
    {
      key: project.id,
      service,
      project,
      workspaceId: snapshot.workspaceId ?? snapshot.profile.workspaceId,
      added: (list ?? []).map((db) => db.url),
      onAdd: (target) => {
        const taken = new Set((list ?? []).map((db) => db.name));
        let name = target.database === "databricks_postgres" ? target.project : `${target.project}-${target.database}`;
        name = name.replace(/[^\w-]/g, "-").slice(0, 40);
        for (let n = 2; taken.has(name); n++) name = `${name.replace(/-\d+$/, "")}-${n}`;
        setList([...list ?? [], { name, url: target.url, description: `Lakebase project ${project.name}, database ${target.database}` }]);
      }
    }
  )), projects.data && !projects.data.length && /* @__PURE__ */ React.createElement(Text, { tone: "subtle", size: "sm" }, "No Lakebase projects yet.")));
}
function apply(ctx) {
  bindReact(ctx.react);
  const live = attach(ctx, { id: "bkvarda.databricks-lakebase", name: "Lakebase" }, (scope, databricks) => {
    scope.inject(["agents"], (agents) => {
      for (const tool of lakebaseTools(databricks)) agents.agents.addTool(tool);
    });
    return databricks;
  });
  ctx.settingsCards.register({
    id: "lakebase",
    title: "Lakebase",
    component: () => {
      const service = useLive(live);
      return service ? /* @__PURE__ */ React.createElement(DbxRoot, null, /* @__PURE__ */ React.createElement(LakebaseSettings, { service })) : /* @__PURE__ */ React.createElement(MissingCore, { ctx, feature: "Lakebase" });
    }
  });
}
export {
  apply,
  inject,
  lakebaseTools
};
