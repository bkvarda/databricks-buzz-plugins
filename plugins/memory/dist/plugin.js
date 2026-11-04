// Databricks Memory (bkvarda.databricks-memory) — built by databricks-buzz-plugins. Apache-2.0.

// packages/core/src/api/memory.ts
var entryId = (entry) => entry.name?.split("/").pop() ?? "";
var validStoreId = (id) => /^[a-z][a-z0-9-]{1,54}[a-z0-9]$/.test(id);
function normalizePath(path) {
  const trimmed = path.trim().replace(/\\/g, "/").replace(/\/{2,}/g, "/");
  const absolute = trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
  if (absolute.split("/").some((part) => part === ".." || part === ".")) throw new Error("Memory paths cannot contain . or ..");
  return absolute;
}
var store = (id) => `/api/2.0/agents/memory-stores/${encodeURIComponent(id)}`;
var Memory = class {
  constructor(client) {
    this.client = client;
  }
  async stores(signal) {
    const response = await this.client.get(
      "/api/2.0/agents/memory-stores",
      signal ? { signal } : {}
    );
    return response.memory_stores ?? response.managed_memory_stores ?? [];
  }
  getStore(id, signal) {
    return this.client.get(store(id), signal ? { signal } : {});
  }
  createStore(id, description) {
    return this.client.post("/api/2.0/agents/memory-stores", { description }, { query: { managed_memory_store_id: id } });
  }
  /** Creates the store when it does not exist yet. */
  async ensureStore(id, description) {
    try {
      return await this.getStore(id);
    } catch (error) {
      if (error.status !== 404) throw error;
      try {
        return await this.createStore(id, description);
      } catch (createError) {
        if (createError.status === 409) return this.getStore(id);
        throw createError;
      }
    }
  }
  async search(storeId, actorId, query, limit = 10, signal) {
    const response = await this.client.post(
      `${store(storeId)}/entries:search`,
      { actor_id: actorId, query, ...limit && { limit } },
      signal ? { signal } : {}
    );
    if (response.results?.length)
      return response.results.flatMap((hit) => {
        const entry = hit.managed_memory_entry ?? hit.entry;
        return entry ? [{ ...entry, ...hit.score !== void 0 && { score: hit.score } }] : [];
      }).slice(0, limit);
    return (response.managed_memory_entries ?? response.entries ?? []).slice(0, limit);
  }
  /**
   * Entries for an actor. `path` matches one path exactly; `prefix` matches
   * everything under a folder such as /projects/.
   */
  async list(storeId, actorId, options = {}) {
    const out = [];
    let pageToken;
    for (let page = 0; page < 20; page++) {
      const response = await this.client.get(
        `${store(storeId)}/entries`,
        {
          query: {
            actor_id: actorId,
            path: options.path && normalizePath(options.path),
            path_prefix: options.prefix && normalizePath(options.prefix),
            page_size: 100,
            page_token: pageToken
          },
          ...options.signal && { signal: options.signal }
        }
      );
      out.push(...response.managed_memory_entries ?? response.entries ?? []);
      pageToken = response.next_page_token;
      if (!pageToken) break;
    }
    return out;
  }
  /** The entry at `path` outside any session, if there is one. */
  async get(storeId, actorId, path, signal) {
    const entries = await this.list(storeId, actorId, { path, ...signal && { signal } });
    const normalized = normalizePath(path);
    return entries.find((entry) => entry.path === normalized && !entry.session_id) ?? entries.find((entry) => entry.path === normalized);
  }
  /** Creates or replaces the entry at `path`. */
  async put(storeId, entry) {
    const path = normalizePath(entry.path);
    const existing = await this.get(storeId, entry.actorId, path);
    if (existing && entryId(existing)) {
      const mask = entry.description !== void 0 ? "content,description" : "content";
      return this.client.json(`${store(storeId)}/entries/${encodeURIComponent(entryId(existing))}`, {
        method: "PATCH",
        query: { update_mask: mask },
        body: { content: entry.content, ...entry.description !== void 0 && { description: entry.description } }
      });
    }
    try {
      return await this.client.post(`${store(storeId)}/entries`, {
        actor_id: entry.actorId,
        path,
        content: entry.content,
        ...entry.description && { description: entry.description }
      });
    } catch (error) {
      const existingId = /existing entry id: ([\w-]+)/.exec(error.message ?? "")?.[1];
      if (error.status !== 409 || !existingId) throw error;
      return this.client.json(`${store(storeId)}/entries/${encodeURIComponent(existingId)}`, {
        method: "PATCH",
        query: { update_mask: "content" },
        body: { content: entry.content }
      });
    }
  }
  async remove(storeId, actorId, path) {
    const existing = await this.get(storeId, actorId, path);
    if (!existing || !entryId(existing)) return false;
    await this.client.json(`${store(storeId)}/entries/${encodeURIComponent(entryId(existing))}`, { method: "DELETE" });
    return true;
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

// packages/core/src/react.ts
var React = void 0;
function bindReact(instance) {
  React = instance;
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
[data-dbx] .dbx-card { background: var(--dbx-surface); border: 1px solid var(--dbx-border); border-radius: var(--dbx-radius-card); }
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
function ensureStyles(doc = globalThis.document) {
  if (!doc || doc.getElementById(STYLE_ID)) return;
  const style = doc.createElement("style");
  style.id = STYLE_ID;
  style.textContent = STYLESHEET;
  doc.head.appendChild(style);
}
var DATABRICKS_MARK_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 300 331" fill="none"><path fill="#FF3621" d="M283.923 136.449L150.144 213.624L6.88995 131.168L0 134.982V194.844L150.144 281.115L283.923 204.234V235.926L150.144 313.1L6.88995 230.644L0 234.458V244.729L150.144 331L300 244.729V184.867L293.11 181.052L150.144 263.215L16.0766 186.334V154.643L150.144 231.524L300 145.253V86.2713L292.536 81.8697L150.144 163.739L22.9665 90.9663L150.144 17.8998L254.641 78.055L263.828 72.773V65.4371L150.144 0L0 86.2713V95.6613L150.144 181.933L283.923 104.758V136.449Z"/></svg>`;
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
function Field(props) {
  return /* @__PURE__ */ React.createElement("label", { style: { display: "flex", flexDirection: "column", gap: 4, minWidth: 0 }, htmlFor: props.id }, /* @__PURE__ */ React.createElement(Text, { size: "sm", weight: 500 }, props.label), props.children, props.hint && /* @__PURE__ */ React.createElement(Text, { size: "xs", tone: "subtle", as: "div" }, props.hint));
}
function SectionHeader(props) {
  return /* @__PURE__ */ React.createElement("div", { style: { display: "flex", alignItems: "flex-end", justifyContent: "space-between", gap: 12 } }, /* @__PURE__ */ React.createElement(Stack, { gap: 2 }, /* @__PURE__ */ React.createElement(Text, { as: "h3", size: "md", weight: 500 }, props.title), props.description && /* @__PURE__ */ React.createElement(Text, { tone: "subtle", size: "sm", as: "div" }, props.description)), props.action);
}
function ago(ms, now = Date.now()) {
  const s = Math.max(0, Math.round((now - ms) / 1e3));
  if (s < 45) return "just now";
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.round(h / 24)}d ago`;
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

// plugins/memory/src/index.tsx
var inject = ["react", "settingsCards"];
var DEFAULT_STORE = "buzz-agent-memory";
var STORE_PREF = "memoryStore";
async function context(service) {
  const client = await service.ready();
  const snapshot = service.snapshot();
  if (snapshot.status !== "connected") throw new Error("Databricks is not connected.");
  const store2 = service.preferences.get(STORE_PREF) ?? DEFAULT_STORE;
  const memory = new Memory(client);
  if (store2 === DEFAULT_STORE) await ensured(memory, store2);
  return { memory, store: store2, actor: snapshot.user.userName };
}
var ensuredStores = /* @__PURE__ */ new Map();
function ensured(memory, store2) {
  let promise = ensuredStores.get(store2);
  if (!promise) {
    promise = memory.ensureStore(store2, "Long-term memory for Buzz agents (databricks-buzz-plugins).").catch((error) => {
      ensuredStores.delete(store2);
      throw error;
    });
    ensuredStores.set(store2, promise);
  }
  return promise;
}
var line = (entry, excerpt = 300) => `- ${entry.path}${entry.description ? ` \u2014 ${entry.description}` : ""}${entry.content ? `
  ${entry.content.replace(/\s+/g, " ").slice(0, excerpt)}${entry.content.length > excerpt ? "\u2026" : ""}` : ""}`;
function memoryTools(service) {
  return [
    {
      name: "databricks_memory_search",
      description: "Searches the owner's long-term memory in Databricks (semantic + keyword) and returns the best matching entries. Search before answering questions about the owner's preferences, projects, people or past decisions. This memory is shared by all of the owner's agents.",
      inputSchema: schema.object(
        { query: schema.string("What to look for, in natural language."), limit: schema.integer("Max entries (default 8, max 25).") },
        ["query"]
      ),
      async call(_client, _context, args) {
        const { memory, store: store2, actor } = await context(service);
        const entries = await memory.search(store2, actor, stringArg(args, "query"), numberArg(args, "limit", 8, 1, 25));
        return entries.length ? entries.map((entry) => line(entry, 600)).join("\n") : "No matching memories.";
      }
    },
    {
      name: "databricks_memory_read",
      description: "Reads one memory entry by its path, e.g. /preferences/writing-style.md.",
      inputSchema: schema.object({ path: schema.string("The entry's path.") }, ["path"]),
      async call(_client, _context, args) {
        const { memory, store: store2, actor } = await context(service);
        const entry = await memory.get(store2, actor, stringArg(args, "path"));
        if (!entry) return `There is no memory at ${normalizePath(stringArg(args, "path"))}.`;
        return `${entry.path}${entry.description ? ` \u2014 ${entry.description}` : ""}

${entry.content ?? ""}`;
      }
    },
    {
      name: "databricks_memory_write",
      description: "Creates or replaces a memory entry. Use file-like paths that group related facts (/people/alex.md, /projects/q3-launch.md, /preferences/formatting.md) and keep one topic per entry. Rewrite the whole entry when updating it; read it first so nothing is lost. Never store secrets.",
      inputSchema: schema.object(
        {
          path: schema.string("File-like path, e.g. /projects/q3-launch.md"),
          content: schema.string("The complete entry text (Markdown)."),
          description: schema.string("One line describing the entry, used in search results.")
        },
        ["path", "content"]
      ),
      async call(_client, _context, args) {
        const content = stringArg(args, "content");
        if (/(dapi[0-9a-f]{32}|-----BEGIN [A-Z ]*PRIVATE KEY|nsec1[0-9a-z]{20,})/i.test(content)) throw new Error("That looks like a secret; memories must not contain credentials.");
        if (content.length > 32e3) throw new Error("Keep entries under 32,000 characters; split the topic into several entries.");
        const { memory, store: store2, actor } = await context(service);
        const description = stringArg(args, "description", false);
        const entry = await memory.put(store2, { actorId: actor, path: stringArg(args, "path"), content, ...description && { description } });
        return `Saved ${entry.path ?? normalizePath(stringArg(args, "path"))}.`;
      }
    },
    {
      name: "databricks_memory_list",
      description: "Lists memory entry paths, optionally under a path prefix such as /projects/.",
      inputSchema: schema.object({ prefix: schema.string("Only paths starting with this.") }),
      async call(_client, _context, args) {
        const { memory, store: store2, actor } = await context(service);
        const prefix = stringArg(args, "prefix", false);
        const entries = await memory.list(store2, actor, prefix ? { prefix } : {});
        if (!entries.length) return prefix ? `No memories under ${prefix}.` : "No memories yet.";
        return entries.sort((a, b) => a.path.localeCompare(b.path)).map((entry) => `- ${entry.path}${entry.description ? ` \u2014 ${entry.description}` : ""}`).join("\n");
      }
    },
    {
      name: "databricks_memory_delete",
      description: "Deletes the memory entry at a path. Use when the owner asks to forget something or an entry is wrong.",
      inputSchema: schema.object({ path: schema.string("The entry's path.") }, ["path"]),
      async call(_client, _context, args) {
        const { memory, store: store2, actor } = await context(service);
        const removed = await memory.remove(store2, actor, stringArg(args, "path"));
        return removed ? `Deleted ${normalizePath(stringArg(args, "path"))}.` : "There was no entry at that path.";
      }
    }
  ];
}
function MemorySettings(props) {
  const { service } = props;
  const snapshot = useConnection(service);
  const [store2, setStore] = usePreference(service, STORE_PREF);
  const [draft, setDraft] = React.useState(store2 ?? DEFAULT_STORE);
  const [query, setQuery] = React.useState("");
  const [submitted, setSubmitted] = React.useState("");
  const [message, setMessage] = React.useState();
  const entries = useAsync(
    async () => {
      const { memory, store: id, actor } = await context(service);
      return submitted ? memory.search(id, actor, submitted, 25) : memory.list(id, actor);
    },
    [snapshot.status, store2, submitted]
  );
  const stores = useAsync(async (signal) => new Memory(await service.ready(signal)).stores(signal), [snapshot.status]);
  if (snapshot.status !== "connected")
    return /* @__PURE__ */ React.createElement(Notice, { title: "Connect Databricks", action: /* @__PURE__ */ React.createElement(Button, { variant: "brand", onClick: () => service.openSettings() }, "Connect") }, "Memory lives in your Databricks workspace.");
  return /* @__PURE__ */ React.createElement(Stack, { gap: 24 }, /* @__PURE__ */ React.createElement(Stack, { gap: 6 }, /* @__PURE__ */ React.createElement(Text, { as: "h2", size: "xl", weight: 500 }, "Databricks Memory"), /* @__PURE__ */ React.createElement(Text, { tone: "subtle" }, "Your agents remember across conversations with Databricks managed memory. Memories belong to ", snapshot.user.userName, "; every agent you run here shares them.")), /* @__PURE__ */ React.createElement(Stack, { gap: 10 }, /* @__PURE__ */ React.createElement(SectionHeader, { title: "Memory store", description: "Use the same store as your Databricks agents to share memory with them." }), /* @__PURE__ */ React.createElement(Field, { label: "Store ID", hint: `Lowercase letters, digits and hyphens. The default, ${DEFAULT_STORE}, is created on first use.` }, /* @__PURE__ */ React.createElement(Stack, { direction: "row", gap: 8 }, /* @__PURE__ */ React.createElement("input", { className: "dbx-input", list: "dbx-memory-stores", value: draft, onChange: (event) => setDraft(event.target.value.trim()), style: { maxWidth: 320 } }), /* @__PURE__ */ React.createElement("datalist", { id: "dbx-memory-stores" }, (stores.data ?? []).map((candidate) => {
    const id = candidate.name?.split("/").pop() ?? "";
    return /* @__PURE__ */ React.createElement("option", { key: id, value: id });
  })), /* @__PURE__ */ React.createElement(
    Button,
    {
      disabled: !validStoreId(draft) || draft === (store2 ?? DEFAULT_STORE),
      onClick: () => {
        setStore(draft === DEFAULT_STORE ? void 0 : draft);
        setMessage(`Agents now use ${draft}.`);
      }
    },
    "Use store"
  ))), message && /* @__PURE__ */ React.createElement(Text, { tone: "success", size: "sm" }, message)), /* @__PURE__ */ React.createElement(Stack, { gap: 10 }, /* @__PURE__ */ React.createElement(SectionHeader, { title: "Memories" }), /* @__PURE__ */ React.createElement("form", { onSubmit: (event) => {
    event.preventDefault();
    setSubmitted(query.trim());
  } }, /* @__PURE__ */ React.createElement(Stack, { direction: "row", gap: 8 }, /* @__PURE__ */ React.createElement("input", { className: "dbx-input", placeholder: "Search memories", value: query, onChange: (event) => setQuery(event.target.value), style: { maxWidth: 420 } }), /* @__PURE__ */ React.createElement(Button, { type: "submit" }, "Search"), submitted && /* @__PURE__ */ React.createElement(Button, { variant: "ghost", onClick: () => {
    setQuery("");
    setSubmitted("");
  } }, "Show all"))), entries.loading && /* @__PURE__ */ React.createElement(Stack, { direction: "row", gap: 8, align: "center" }, /* @__PURE__ */ React.createElement(Spinner, { size: 12 }), /* @__PURE__ */ React.createElement(Text, { tone: "subtle", size: "sm" }, "Loading\u2026")), entries.error && /* @__PURE__ */ React.createElement(Notice, { tone: "danger", title: "Couldn't read memory" }, describeError(entries.error)), !entries.loading && !entries.error && !entries.data?.length && /* @__PURE__ */ React.createElement(Text, { tone: "subtle" }, submitted ? "Nothing matches." : "No memories yet. Agents save what they learn here."), (entries.data ?? []).map((entry) => /* @__PURE__ */ React.createElement("div", { key: entryId(entry) || entry.path, className: "dbx-card", style: { padding: 12 } }, /* @__PURE__ */ React.createElement(Stack, { gap: 4 }, /* @__PURE__ */ React.createElement(Stack, { direction: "row", align: "center", justify: "space-between", gap: 8 }, /* @__PURE__ */ React.createElement(Text, { weight: 500, mono: true, size: "sm" }, entry.path), /* @__PURE__ */ React.createElement(Stack, { direction: "row", gap: 6, align: "center" }, entry.update_time && /* @__PURE__ */ React.createElement(Text, { tone: "tertiary", size: "xs" }, ago(Date.parse(entry.update_time))), /* @__PURE__ */ React.createElement(
    Button,
    {
      size: "sm",
      variant: "danger",
      onClick: async () => {
        try {
          const { memory, store: id, actor } = await context(service);
          await memory.remove(id, actor, entry.path);
          entries.reload();
        } catch (error) {
          setMessage(describeError(error));
        }
      }
    },
    "Forget"
  ))), entry.description && /* @__PURE__ */ React.createElement(Text, { tone: "subtle", size: "sm" }, entry.description), entry.content && /* @__PURE__ */ React.createElement(Text, { size: "sm", as: "div", style: { whiteSpace: "pre-wrap", maxHeight: 120, overflow: "hidden" } }, entry.content))))));
}
function apply(ctx) {
  bindReact(ctx.react);
  const live = attach(ctx, { id: "bkvarda.databricks-memory", name: "Databricks Memory" }, (scope, databricks) => {
    scope.inject(["agents"], (agents) => {
      for (const tool of memoryTools(databricks)) agents.agents.addTool(tool);
    });
    return databricks;
  });
  ctx.settingsCards.register({
    id: "memory",
    title: "Databricks Memory",
    component: () => {
      const service = useLive(live);
      return service ? /* @__PURE__ */ React.createElement(DbxRoot, null, /* @__PURE__ */ React.createElement(MemorySettings, { service })) : /* @__PURE__ */ React.createElement(MissingCore, { ctx, feature: "Databricks Memory" });
    }
  });
}
export {
  DEFAULT_STORE,
  apply,
  inject,
  memoryTools
};
