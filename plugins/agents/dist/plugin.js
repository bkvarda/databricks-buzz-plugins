// Databricks Agents (bkvarda.databricks-agents) — built by databricks-buzz-plugins. Apache-2.0.

// packages/core/src/react.ts
var React = void 0;
function bindReact(instance) {
  React = instance;
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
  const key2 = ids.join("\n");
  const getter = React.useRef(installer);
  getter.current = installer;
  const [statuses, setStatuses] = React.useState(/* @__PURE__ */ new Map());
  React.useEffect(() => {
    const methods = statusMethods(getter.current());
    if (!methods) return;
    const list = key2.split("\n");
    const read = () => {
      const next = new Map(list.map((id) => [id, methods.get(id)]));
      setStatuses((current) => sameStatuses(current, next) ? current : next);
    };
    const stops = list.map((id) => methods.subscribe(id, read));
    read();
    return () => {
      for (const stop of stops) stop();
    };
  }, [key2]);
  return statuses;
}
function sameStatuses(a, b) {
  return a.size === b.size && [...b].every(([id, status2]) => a.get(id) === status2);
}
function openPluginDetails(ctx, id) {
  const navigation = optionalService(ctx, "navigation");
  if (!navigation) return false;
  void navigation.open({ version: 1, kind: "settings", section: "plugins", pluginId: id });
  return true;
}

// packages/core/src/cli.ts
var EXPIRY_MARGIN_MS = 3 * 6e4;
var DEFAULT_LIFETIME_MS = 30 * 6e4;

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
  constructor(status2, errorCode, message, body) {
    super(message);
    this.status = status2;
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
function useAsync(load, key2) {
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
  }, [...key2, nonce]);
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
var svgDataUri = (svg2) => `data:image/svg+xml;utf8,${encodeURIComponent(svg2)}`;
var DATABRICKS_ICON = svgDataUri(DATABRICKS_MARK_SVG);
var DATABRICKS_ICON_MONO = svgDataUri(DATABRICKS_MARK_MONO_SVG);

// packages/core/src/ui/components.tsx
function DbxRoot(props) {
  ensureStyles();
  return /* @__PURE__ */ React.createElement("div", { "data-dbx": "", className: props.className, style: props.style }, props.children);
}
function databricksIcon() {
  return React.forwardRef(function DatabricksIcon({ size = "1em", title, color: _color, ...props }, ref) {
    return /* @__PURE__ */ React.createElement("svg", { ref, viewBox: "-15.5 0 331 331", width: size, height: size, fill: "none", role: title ? "img" : void 0, "aria-hidden": title ? void 0 : true, ...props }, title && /* @__PURE__ */ React.createElement("title", null, title), /* @__PURE__ */ React.createElement("path", { fill: "#FF3621", d: DATABRICKS_MARK_PATH }));
  });
}
function DatabricksMark(props) {
  const size = props.size ?? 16;
  const svg2 = props.color === "current" ? DATABRICKS_MARK_SVG.replace('fill="#FF3621"', 'fill="currentColor"') : DATABRICKS_MARK_SVG;
  return /* @__PURE__ */ React.createElement(
    "span",
    {
      role: props.title ? "img" : void 0,
      "aria-label": props.title,
      "aria-hidden": props.title ? void 0 : true,
      style: { display: "inline-flex", width: size, height: size * 1.1, flex: "none" },
      dangerouslySetInnerHTML: { __html: svg2.replace("<svg ", `<svg width="${size}" height="${size * 1.1}" `) }
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

// packages/core/src/api/sandbox.ts
var SANDBOX_HOME = "/home/sandbox-agent";
function sandboxId(seed) {
  const cleaned = seed.toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40);
  return /^[a-z]/.test(cleaned) ? cleaned : `sb-${cleaned}`;
}
var isUnavailable = (error) => error.status === 404 && /requested API is not available/i.test(error.message ?? "");
var SandboxUnavailableError = class extends Error {
  constructor() {
    super("Databricks Sandbox isn't turned on in this workspace. A workspace admin can turn on the Databricks Sandbox preview in Settings \u2192 Previews.");
    this.name = "SandboxUnavailableError";
  }
};
var resource = (id) => id.startsWith("sandboxes/") ? id : `sandboxes/${id}`;
var Sandboxes = class {
  constructor(client) {
    this.client = client;
  }
  async list(signal) {
    const out = [];
    let pageToken;
    for (let page = 0; page < 10; page++) {
      const response = await this.client.get("/api/2.0/sandboxes", {
        query: { page_size: 100, page_token: pageToken },
        ...signal && { signal }
      });
      out.push(...response.sandboxes ?? []);
      pageToken = response.next_page_token;
      if (!pageToken) break;
    }
    return out;
  }
  /** Whether Databricks Sandbox is on in this workspace (no retries). */
  async available(signal) {
    try {
      await this.client.get("/api/2.0/sandboxes", { query: { page_size: 1 }, ...signal && { signal } });
      return true;
    } catch (error) {
      if (isUnavailable(error)) return false;
      throw error;
    }
  }
  get(id, signal) {
    return this.client.get(`/api/2.0/${resource(id)}`, signal ? { signal } : {});
  }
  create(id, options = {}) {
    return this.client.post(
      "/api/2.0/sandboxes",
      {
        ...options.displayName && { display_name: options.displayName },
        ...options.tags && { metadata: { custom_tags: options.tags } }
      },
      { query: { sandbox_id: id }, timeoutMs: 12e4 }
    );
  }
  start(id) {
    return this.client.post(`/api/2.0/${resource(id)}/start`, {}, { timeoutMs: 12e4 });
  }
  stop(id) {
    return this.client.post(`/api/2.0/${resource(id)}/stop`, {});
  }
  delete(id) {
    return this.client.json(`/api/2.0/${resource(id)}`, { method: "DELETE" });
  }
  /** Gets or creates the sandbox and waits until it is running. */
  async ensureRunning(id, options = {}) {
    let sandbox = await this.find(id, options.signal);
    if (!sandbox) {
      options.onState?.("Creating sandbox");
      try {
        sandbox = await this.create(id, options);
      } catch (error) {
        if (isUnavailable(error)) throw new SandboxUnavailableError();
        if (error.status !== 409) throw error;
        sandbox = await this.get(id, options.signal);
      }
    }
    const deadline = Date.now() + 5 * 6e4;
    let started = false;
    for (; ; ) {
      const state = sandbox?.status?.state ?? "";
      if (state === "SANDBOX_STATE_RUNNING") return sandbox;
      if (Date.now() > deadline) throw new Error(`The sandbox did not start within 5 minutes (state: ${state || "unknown"}).`);
      if (state === "SANDBOX_STATE_STOPPED" && !started) {
        options.onState?.("Starting sandbox", state);
        started = true;
        sandbox = await this.start(id);
        continue;
      }
      options.onState?.(state === "SANDBOX_STATE_STOPPING" ? "Waiting for sandbox to stop" : "Starting sandbox", state);
      if (state === "SANDBOX_STATE_STOPPED") started = false;
      await new Promise((resolve) => setTimeout(resolve, 2e3));
      options.signal?.throwIfAborted();
      sandbox = await this.find(id, options.signal) ?? sandbox;
    }
  }
  /** The sandbox, or undefined when it doesn't exist. */
  async find(id, signal) {
    for (let attempt = 0; ; attempt++) {
      try {
        return await this.get(id, signal);
      } catch (error) {
        if (isUnavailable(error) && attempt < 3) {
          await new Promise((resolve) => setTimeout(resolve, 1e3));
          continue;
        }
        if (isUnavailable(error)) throw new SandboxUnavailableError();
        if (error.status === 404) return void 0;
        throw error;
      }
    }
  }
  /** Runs a command and waits for it, up to `timeoutSeconds` (server-clamped). */
  exec(id, cmd, options = {}) {
    const timeout = options.timeoutSeconds ?? 120;
    return this.client.post(
      `/api/2.0/sandbox-exec/${resource(id)}/exec-sync`,
      {
        cmd,
        ...options.args && { args: options.args },
        ...options.env && { envs: options.env },
        execution_timeout: `${timeout}s`
      },
      { timeoutMs: (timeout + 30) * 1e3, ...options.signal && { signal: options.signal } }
    );
  }
  /** Runs a bash script in the agent's home directory. */
  bash(id, script, options = {}) {
    const cwd = options.cwd ?? SANDBOX_HOME;
    return this.exec(id, "/bin/bash", {
      args: ["-lc", `cd ${JSON.stringify(cwd)} 2>/dev/null || cd ${SANDBOX_HOME}; ${script}`],
      ...options.timeoutSeconds !== void 0 && { timeoutSeconds: options.timeoutSeconds },
      ...options.signal && { signal: options.signal }
    });
  }
  // Files go through exec-sync, the documented API: contents travel as base64
  // in environment variables, never in the command line.
  /** Reads a UTF-8 text file. */
  async readFile(id, path, signal) {
    const result = await this.exec(id, "/bin/bash", {
      args: ["-c", 'if [ -d "$P" ]; then echo "$P is a directory" >&2; exit 21; fi; base64 -w0 -- "$P"'],
      env: { P: path },
      timeoutSeconds: 60,
      ...signal && { signal }
    });
    if (result.exit_code !== 0) throw new Error(result.stderr?.trim().replace(/^base64: /, "") || `Couldn't read ${path}.`);
    if (result.truncated) throw new Error(`${path} is too large to read whole; read part of it with a command instead.`);
    return fromBase64(result.stdout ?? "");
  }
  /** Creates or replaces a file (and its parent folders). */
  async writeFile(id, path, contents, signal) {
    const encoded = toBase64(contents);
    const CHUNK = 96 * 1024;
    for (let offset = 0; offset === 0 || offset < encoded.length; offset += CHUNK) {
      const result = await this.exec(id, "/bin/bash", {
        args: ["-c", offset === 0 ? 'mkdir -p -- "$(dirname -- "$P")" && printf %s "$C" | base64 -d > "$P"' : 'printf %s "$C" | base64 -d >> "$P"'],
        env: { P: path, C: encoded.slice(offset, offset + CHUNK) },
        timeoutSeconds: 60,
        ...signal && { signal }
      });
      if (result.exit_code !== 0) throw new Error(result.stderr?.trim() || `Couldn't write ${path}.`);
    }
  }
  /** Lists a folder: directory-entries when the server offers it, else `find`. */
  async listDirectory(id, path, signal) {
    try {
      const response = await this.client.get(`/api/2.0/sandbox-files/${resource(id)}/directory-entries`, {
        query: { path, page_size: 500 },
        ...signal && { signal }
      });
      return (response.contents ?? []).map((entry) => {
        const type = entry.fileType ?? entry.file_type ?? "";
        const size = entry.size === void 0 ? void 0 : Number(entry.size);
        const modified = entry.modifyTime ?? entry.modify_time;
        return {
          name: entry.name ?? entry.path?.split("/").pop() ?? "",
          path: entry.path ?? "",
          directory: /DIRECTORY/.test(type),
          ...size !== void 0 && Number.isFinite(size) && { size },
          ...modified && { modified }
        };
      });
    } catch (error) {
      if (signal?.aborted) throw error;
      const result = await this.exec(id, "/bin/bash", {
        args: ["-c", 'find "$P" -mindepth 1 -maxdepth 1 -printf "%y\\t%s\\t%p\\n"'],
        env: { P: path },
        timeoutSeconds: 30,
        ...signal && { signal }
      });
      if (result.exit_code !== 0) throw new Error(result.stderr?.trim() || `Couldn't list ${path}.`);
      return parseFindOutput(result.stdout ?? "");
    }
  }
};
function parseFindOutput(text) {
  return text.split("\n").filter(Boolean).map((line) => {
    const [type = "", size = "", ...rest] = line.split("	");
    const path = rest.join("	");
    return {
      name: path.split("/").pop() ?? path,
      path,
      directory: type === "d",
      ...type !== "d" && Number.isFinite(Number(size)) && { size: Number(size) }
    };
  });
}
function toBase64(text) {
  const bytes = new TextEncoder().encode(text);
  let binary = "";
  for (let i = 0; i < bytes.length; i += 32768) binary += String.fromCharCode(...bytes.subarray(i, i + 32768));
  return btoa(binary);
}
function fromBase64(encoded) {
  const binary = atob(encoded.trim());
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return new TextDecoder().decode(bytes);
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
var gatewayMcpPath = (fullName) => `/ai-gateway/mcp-services/${fullName}`;
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
function resultJson(result) {
  if (result.structuredContent !== void 0) return result.structuredContent;
  for (const item of result.content ?? []) {
    if (item.type !== "text") continue;
    const text = String(item.text).trim();
    if (!text.startsWith("{") && !text.startsWith("[")) continue;
    try {
      return JSON.parse(text);
    } catch {
    }
  }
  return void 0;
}

// packages/core/src/api/skills.ts
var skillFullName = (nameOrFull) => nameOrFull.replace(/^skills\//, "");
function splitFullName(fullName) {
  const parts = skillFullName(fullName).split(".");
  if (parts.length !== 3 || parts.some((part) => !part)) throw new Error(`A skill's full name is catalog.schema.skill, not "${fullName}".`);
  return { catalog: parts[0], schema: parts[1], skill: parts[2] };
}
var validSkillId = (id) => /^[a-z0-9][a-z0-9_-]{0,63}$/.test(id);
function parseSkillMarkdown(text) {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(text);
  if (!match) return { body: text };
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
  async publish(target2, files, options = {}) {
    const markdown = files.find((file) => file.path.replace(/^\/+/, "") === "SKILL.md");
    if (!markdown) throw new Error("A skill needs a SKILL.md.");
    const parsed = parseSkillMarkdown(markdown.content);
    if (!parsed.name || !parsed.description) throw new Error("SKILL.md must start with frontmatter that sets name and description.");
    const fullName = `${target2.catalog}.${target2.schema}.${target2.id}`;
    let created = false;
    try {
      await this.create(target2.catalog, target2.schema, target2.id, target2.comment);
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
    const text = skill.description.toLowerCase();
    let score = 0;
    if (leaf === words.join("-")) score += 20;
    for (const word of words) {
      if (leaf.includes(word)) score += 6;
      else if (where.includes(word)) score += 3;
      if (new RegExp(`\\b${word}`).test(text)) score += 2;
      else if (text.includes(word)) score += 1;
    }
    return { skill, score };
  });
  return scored.filter((entry) => entry.score > 0).sort((a, b) => b.score - a.score || a.skill.fullName.localeCompare(b.skill.fullName)).slice(0, limit).map((entry) => entry.skill);
}

// virtual:agent-runner
var RUNNER = '// Databricks Agents runner for Buzz (built by databricks-buzz-plugins). Apache-2.0.\nimport{execFile as wc,spawn as xc}from"node:child_process";import{appendFileSync as Ec,existsSync as Ae,openSync as Sc,readFileSync as Qt,rmSync as ir,statSync as Lo,truncateSync as vc,writeFileSync as Ye}from"node:fs";var qo=/^(tinyint|smallint|int|integer|bigint|long|short|byte|float|double|real|decimal|numeric)/i,fr=/^(date|timestamp)/i,Go=/(^|_)(id|ids|zip|zipcode|zip_code|postal_code|postcode|code|key|year|fiscal_year|phone)$/i;function jo(t,e,n=""){if(Go.test(n)&&!fr.test(t??"")&&!/^bool/i.test(t??""))return"text";if(t){if(qo.test(t))return"number";if(fr.test(t))return"time";if(/^bool/i.test(t))return"boolean";if(/^(string|varchar|char|binary|array|map|struct|interval)/i.test(t))return"text"}let r=e.filter(s=>s!==null&&s!=="");return r.length?r.every(s=>/^-?\\d+(\\.\\d+)?([eE][+-]?\\d+)?$/.test(s))?"number":r.every(s=>/^\\d{4}-\\d{2}(-\\d{2})?([T ]\\d{2}:\\d{2}(:\\d{2}(\\.\\d+)?)?(Z|[+-]\\d{2}:?\\d{2})?)?$/.test(s))?"time":"text":"text"}function ht(t,e,n={}){return{columns:t.map((r,s)=>({name:r.name,...r.type&&{type:r.type},kind:jo(r.type,e.slice(0,50).map(o=>o[s]??null),r.name)})),rows:e,...n}}function tn(t){let e=(t.manifest?.schema?.columns??[]).map(s=>({name:s.name,type:s.type_text??s.type_name??""})),n=t.result?.data_array??[],r=t.manifest?.total_row_count;return ht(e,n,{...r!==void 0&&{totalRows:r},truncated:!!t.manifest?.truncated||r!==void 0&&r>n.length})}var zo=new Intl.NumberFormat(void 0,{notation:"compact",maximumFractionDigits:1}),Ko=new Intl.NumberFormat(void 0,{maximumFractionDigits:2});function Fo(t,e="precise"){return Number.isFinite(t)?e==="compact"&&Math.abs(t)>=1e4?zo.format(t):Ko.format(t):String(t)}function Wo(t,e){if(t===null)return"null";if(e==="number"){let n=Number(t);if(Number.isFinite(n)&&Math.abs(n)<1e15)return Fo(n)}return e==="time"&&/T00:00:00(\\.000)?(Z)?$/.test(t)?t.slice(0,10):t}function mt(t,e=20){if(!t.columns.length)return"_No columns._";let n=c=>c.replace(/\\|/g,"\\\\|").replace(/\\n/g," "),r=`| ${t.columns.map(c=>n(c.name)).join(" | ")} |`,s=`| ${t.columns.map(c=>c.kind==="number"?"---:":"---").join(" | ")} |`,o=t.rows.slice(0,e).map(c=>`| ${t.columns.map((l,d)=>n(Wo(c[d]??null,l.kind))).join(" | ")} |`),i=t.totalRows??t.rows.length,a=i>Math.min(e,t.rows.length)?`\n\n_Showing ${Math.min(e,t.rows.length)} of ${i} rows._`:"";return[r,s,...o].join(`\n`)+a}function Vo(t){let e=n=>n===null?"":/[",\\n]/.test(n)?`"${n.replace(/"/g,\'""\')}"`:n;return[t.columns.map(n=>e(n.name)).join(","),...t.rows.map(n=>n.map(e).join(","))].join(`\n`)}var nn="databricks-result";function Xe(t,e=200){let n={...t,rows:t.rows.slice(0,e)},r=Vo(n),s=r.includes("```")?"````":"```",o=t.totalRows??t.rows.length,i=o>n.rows.length?`\n\n_Showing ${n.rows.length} of ${o} rows._`:"";return`${s}${nn}\n${r}\n${s}${i}`}var Zo=new Set(["COMPLETED","FAILED","QUERY_RESULT_EXPIRED","CANCELLED"]);var pr=t=>t.message_id??t.id??"";function Yo(t){let e=t.attachments??[],n=e.map(o=>o.text?.content).filter(o=>!!o).join(`\n\n`),r=e.find(o=>o.query?.query),s=e.flatMap(o=>o.suggested_questions?.questions??[]);return{text:n,sql:r?.query?.query,queryTitle:r?.query?.title,queryDescription:r?.query?.description,queryAttachmentId:r?.attachment_id,rowCount:r?.query?.query_result_metadata?.row_count,suggestions:s,error:t.error?.error}}var Je=t=>`/api/2.0/genie/spaces/${encodeURIComponent(t)}`,fe=class{constructor(e){this.client=e}async listSpaces(e){let n=[],r;for(let s=0;s<20;s++){let o=await this.client.get("/api/2.0/genie/spaces",{query:{page_size:100,page_token:r},...e&&{signal:e}});if(n.push(...o.spaces??[]),r=o.next_page_token,!r)break}return n.sort((s,o)=>s.title.localeCompare(o.title))}getSpace(e,n){return this.client.get(Je(e),n?{signal:n}:{})}async ask(e,n,r,s){if(r){let a=await this.client.post(`${Je(e)}/conversations/${encodeURIComponent(r)}/messages`,{content:n},s?{signal:s}:{});return{...a,conversation_id:a.conversation_id??r}}let o=await this.client.post(`${Je(e)}/start-conversation`,{content:n},s?{signal:s}:{}),i=o.conversation_id??o.conversation?.id??o.message?.conversation_id??"";return{content:n,status:"SUBMITTED",...o.message,conversation_id:i,message_id:o.message_id??o.message?.message_id??o.message?.id??""}}getMessage(e,n,r,s){return this.client.get(`${Je(e)}/conversations/${encodeURIComponent(n)}/messages/${encodeURIComponent(r)}`,s?{signal:s}:{})}async wait(e,n,r,s){let o=n,i=1e3,a=Date.now()+10*6e4;for(;!Zo.has(o.status);){if(Date.now()>a)throw new Error("Genie did not answer within 10 minutes.");await new Promise(c=>setTimeout(c,i)),s?.throwIfAborted(),i=Math.min(5e3,Math.round(i*1.4)),o={...await this.getMessage(e,o.conversation_id,pr(o),s),conversation_id:o.conversation_id},r?.(o)}return o}async result(e,n,r,s){let o=`${Je(e)}/conversations/${encodeURIComponent(n.conversation_id)}/messages/${encodeURIComponent(pr(n))}/attachments/${encodeURIComponent(r)}`;try{let a=await this.client.get(`${o}/query-result`,s?{signal:s}:{});if(a.statement_response?.result||a.statement_response?.manifest)return tn(a.statement_response)}catch(a){if(a.status!==404&&a.status!==400)throw a}let i=await this.client.post(`${o}/execute-query`,{},s?{signal:s}:{});return tn(i.statement_response??{})}async answer(e,n,r={}){let s=await this.ask(e,n,r.conversationId,r.signal);r.onUpdate?.(s);let o=await this.wait(e,s,r.onUpdate,r.signal),i=Yo(o),a;return o.status==="COMPLETED"&&i.queryAttachmentId&&(a=await this.result(e,o,i.queryAttachmentId,r.signal).catch(()=>{})),{message:o,...i,result:a}}static webPath(e,n){return`/genie/rooms/${encodeURIComponent(e)}${n?`/chats/${encodeURIComponent(n)}`:""}`}};function Qe(t){return t instanceof Uint8Array||ArrayBuffer.isView(t)&&t.constructor.name==="Uint8Array"}function ie(t,e=""){if(!Number.isSafeInteger(t)||t<0){let n=e&&`"${e}" `;throw new Error(`${n}expected integer >= 0, got ${t}`)}}function D(t,e,n=""){let r=Qe(t),s=t?.length,o=e!==void 0;if(!r||o&&s!==e){let i=n&&`"${n}" `,a=o?` of length ${e}`:"",c=r?`length=${s}`:`type=${typeof t}`;throw new Error(i+"expected Uint8Array"+a+", got "+c)}return t}function Ie(t){if(typeof t!="function"||typeof t.create!="function")throw new Error("Hash must wrapped by utils.createHasher");ie(t.outputLen),ie(t.blockLen)}function Me(t,e=!0){if(t.destroyed)throw new Error("Hash instance has been destroyed");if(e&&t.finished)throw new Error("Hash#digest() has already been called")}function hr(t,e){D(t,void 0,"digestInto() output");let n=e.outputLen;if(t.length<n)throw new Error(\'"digestInto() output" expected to be of length >=\'+n)}function ge(...t){for(let e=0;e<t.length;e++)t[e].fill(0)}function yt(t){return new DataView(t.buffer,t.byteOffset,t.byteLength)}function le(t,e){return t<<32-e|t>>>e}var mr=typeof Uint8Array.from([]).toHex=="function"&&typeof Uint8Array.fromHex=="function",Xo=Array.from({length:256},(t,e)=>e.toString(16).padStart(2,"0"));function ae(t){if(D(t),mr)return t.toHex();let e="";for(let n=0;n<t.length;n++)e+=Xo[t[n]];return e}var pe={_0:48,_9:57,A:65,F:70,a:97,f:102};function gr(t){if(t>=pe._0&&t<=pe._9)return t-pe._0;if(t>=pe.A&&t<=pe.F)return t-(pe.A-10);if(t>=pe.a&&t<=pe.f)return t-(pe.a-10)}function re(t){if(typeof t!="string")throw new Error("hex string expected, got "+typeof t);if(mr)return Uint8Array.fromHex(t);let e=t.length,n=e/2;if(e%2)throw new Error("hex string expected, got unpadded hex of length "+e);let r=new Uint8Array(n);for(let s=0,o=0;s<n;s++,o+=2){let i=gr(t.charCodeAt(o)),a=gr(t.charCodeAt(o+1));if(i===void 0||a===void 0){let c=t[o]+t[o+1];throw new Error(\'hex string expected, got non-hex character "\'+c+\'" at index \'+o)}r[s]=i*16+a}return r}function Z(...t){let e=0;for(let r=0;r<t.length;r++){let s=t[r];D(s),e+=s.length}let n=new Uint8Array(e);for(let r=0,s=0;r<t.length;r++){let o=t[r];n.set(o,s),s+=o.length}return n}function yr(t,e={}){let n=(s,o)=>t(o).update(s).digest(),r=t(void 0);return n.outputLen=r.outputLen,n.blockLen=r.blockLen,n.create=s=>t(s),Object.assign(n,e),Object.freeze(n)}function he(t=32){let e=typeof globalThis=="object"?globalThis.crypto:null;if(typeof e?.getRandomValues!="function")throw new Error("crypto.getRandomValues must be defined");return e.getRandomValues(new Uint8Array(t))}var br=t=>({oid:Uint8Array.from([6,9,96,134,72,1,101,3,4,2,t])});function wr(t,e,n){return t&e^~t&n}function xr(t,e,n){return t&e^t&n^e&n}var bt=class{blockLen;outputLen;padOffset;isLE;buffer;view;finished=!1;length=0;pos=0;destroyed=!1;constructor(e,n,r,s){this.blockLen=e,this.outputLen=n,this.padOffset=r,this.isLE=s,this.buffer=new Uint8Array(e),this.view=yt(this.buffer)}update(e){Me(this),D(e);let{view:n,buffer:r,blockLen:s}=this,o=e.length;for(let i=0;i<o;){let a=Math.min(s-this.pos,o-i);if(a===s){let c=yt(e);for(;s<=o-i;i+=s)this.process(c,i);continue}r.set(e.subarray(i,i+a),this.pos),this.pos+=a,i+=a,this.pos===s&&(this.process(n,0),this.pos=0)}return this.length+=e.length,this.roundClean(),this}digestInto(e){Me(this),hr(e,this),this.finished=!0;let{buffer:n,view:r,blockLen:s,isLE:o}=this,{pos:i}=this;n[i++]=128,ge(this.buffer.subarray(i)),this.padOffset>s-i&&(this.process(r,0),i=0);for(let u=i;u<s;u++)n[u]=0;r.setBigUint64(s-8,BigInt(this.length*8),o),this.process(r,0);let a=yt(e),c=this.outputLen;if(c%4)throw new Error("_sha2: outputLen must be aligned to 32bit");let l=c/4,d=this.get();if(l>d.length)throw new Error("_sha2: outputLen bigger than state");for(let u=0;u<l;u++)a.setUint32(4*u,d[u],o)}digest(){let{buffer:e,outputLen:n}=this;this.digestInto(e);let r=e.slice(0,n);return this.destroy(),r}_cloneInto(e){e||=new this.constructor,e.set(...this.get());let{blockLen:n,buffer:r,length:s,finished:o,destroyed:i,pos:a}=this;return e.destroyed=i,e.finished=o,e.length=s,e.pos=a,s%n&&e.buffer.set(r),e}clone(){return this._cloneInto()}},me=Uint32Array.from([1779033703,3144134277,1013904242,2773480762,1359893119,2600822924,528734635,1541459225]);var Jo=Uint32Array.from([1116352408,1899447441,3049323471,3921009573,961987163,1508970993,2453635748,2870763221,3624381080,310598401,607225278,1426881987,1925078388,2162078206,2614888103,3248222580,3835390401,4022224774,264347078,604807628,770255983,1249150122,1555081692,1996064986,2554220882,2821834349,2952996808,3210313671,3336571891,3584528711,113926993,338241895,666307205,773529912,1294757372,1396182291,1695183700,1986661051,2177026350,2456956037,2730485921,2820302411,3259730800,3345764771,3516065817,3600352804,4094571909,275423344,430227734,506948616,659060556,883997877,958139571,1322822218,1537002063,1747873779,1955562222,2024104815,2227730452,2361852424,2428436474,2756734187,3204031479,3329325298]),Ee=new Uint32Array(64),rn=class extends bt{constructor(e){super(64,e,8,!1)}get(){let{A:e,B:n,C:r,D:s,E:o,F:i,G:a,H:c}=this;return[e,n,r,s,o,i,a,c]}set(e,n,r,s,o,i,a,c){this.A=e|0,this.B=n|0,this.C=r|0,this.D=s|0,this.E=o|0,this.F=i|0,this.G=a|0,this.H=c|0}process(e,n){for(let u=0;u<16;u++,n+=4)Ee[u]=e.getUint32(n,!1);for(let u=16;u<64;u++){let g=Ee[u-15],f=Ee[u-2],m=le(g,7)^le(g,18)^g>>>3,w=le(f,17)^le(f,19)^f>>>10;Ee[u]=w+Ee[u-7]+m+Ee[u-16]|0}let{A:r,B:s,C:o,D:i,E:a,F:c,G:l,H:d}=this;for(let u=0;u<64;u++){let g=le(a,6)^le(a,11)^le(a,25),f=d+g+wr(a,c,l)+Jo[u]+Ee[u]|0,w=(le(r,2)^le(r,13)^le(r,22))+xr(r,s,o)|0;d=l,l=c,c=a,a=i+f|0,i=o,o=s,s=r,r=f+w|0}r=r+this.A|0,s=s+this.B|0,o=o+this.C|0,i=i+this.D|0,a=a+this.E|0,c=c+this.F|0,l=l+this.G|0,d=d+this.H|0,this.set(r,s,o,i,a,c,l,d)}roundClean(){ge(Ee)}destroy(){this.set(0,0,0,0,0,0,0,0),ge(this.buffer)}},sn=class extends rn{A=me[0]|0;B=me[1]|0;C=me[2]|0;D=me[3]|0;E=me[4]|0;F=me[5]|0;G=me[6]|0;H=me[7]|0;constructor(){super(32)}};var ce=yr(()=>new sn,br(1));var an=BigInt(0),on=BigInt(1);function et(t,e=""){if(typeof t!="boolean"){let n=e&&`"${e}" `;throw new Error(n+"expected boolean, got type="+typeof t)}return t}function Er(t){if(typeof t=="bigint"){if(!wt(t))throw new Error("positive bigint expected, got "+t)}else ie(t);return t}function tt(t){let e=Er(t).toString(16);return e.length&1?"0"+e:e}function Sr(t){if(typeof t!="string")throw new Error("hex string expected, got "+typeof t);return t===""?an:BigInt("0x"+t)}function Se(t){return Sr(ae(t))}function cn(t){return Sr(ae(Qo(D(t)).reverse()))}function xt(t,e){ie(e),t=Er(t);let n=re(t.toString(16).padStart(e*2,"0"));if(n.length!==e)throw new Error("number too large");return n}function ln(t,e){return xt(t,e).reverse()}function Qo(t){return Uint8Array.from(t)}function vr(t){return Uint8Array.from(t,(e,n)=>{let r=e.charCodeAt(0);if(e.length!==1||r>127)throw new Error(`string contains non-ASCII character "${t[n]}" with code ${r} at position ${n}`);return r})}var wt=t=>typeof t=="bigint"&&an<=t;function ei(t,e,n){return wt(t)&&wt(e)&&wt(n)&&e<=t&&t<n}function kr(t,e,n,r){if(!ei(e,n,r))throw new Error("expected valid "+t+": "+n+" <= n < "+r+", got "+e)}function dn(t){let e;for(e=0;t>an;t>>=on,e+=1);return e}var nt=t=>(on<<BigInt(t))-on;function _r(t,e,n){if(ie(t,"hashLen"),ie(e,"qByteLen"),typeof n!="function")throw new Error("hmacFn must be a function");let r=E=>new Uint8Array(E),s=Uint8Array.of(),o=Uint8Array.of(0),i=Uint8Array.of(1),a=1e3,c=r(t),l=r(t),d=0,u=()=>{c.fill(1),l.fill(0),d=0},g=(...E)=>n(l,Z(c,...E)),f=(E=s)=>{l=g(o,E),c=g(),E.length!==0&&(l=g(i,E),c=g())},m=()=>{if(d++>=a)throw new Error("drbg: tried max amount of iterations");let E=0,b=[];for(;E<e;){c=g();let C=c.slice();b.push(C),E+=c.length}return Z(...b)};return(E,b)=>{u(),f(E);let C;for(;!(C=b(m()));)f();return u(),C}}function rt(t,e={},n={}){if(!t||typeof t!="object")throw new Error("expected valid options object");function r(o,i,a){let c=t[o];if(a&&c===void 0)return;let l=typeof c;if(l!==i||c===null)throw new Error(`param "${o}" is invalid: expected ${i}, got ${l}`)}let s=(o,i)=>Object.entries(o).forEach(([a,c])=>r(a,c,i));s(e,!1),s(n,!0)}function un(t){let e=new WeakMap;return(n,...r)=>{let s=e.get(n);if(s!==void 0)return s;let o=t(n,...r);return e.set(n,o),o}}var ne=BigInt(0),te=BigInt(1),$e=BigInt(2),Ar=BigInt(3),Ir=BigInt(4),$r=BigInt(5),ti=BigInt(7),Or=BigInt(8),ni=BigInt(9),Cr=BigInt(16);function de(t,e){let n=t%e;return n>=ne?n:e+n}function oe(t,e,n){let r=t;for(;e-- >ne;)r*=r,r%=n;return r}function Rr(t,e){if(t===ne)throw new Error("invert: expected non-zero number");if(e<=ne)throw new Error("invert: expected positive modulus, got "+e);let n=de(t,e),r=e,s=ne,o=te,i=te,a=ne;for(;n!==ne;){let l=r/n,d=r%n,u=s-i*l,g=o-a*l;r=n,n=d,s=i,o=a,i=u,a=g}if(r!==te)throw new Error("invert: does not exist");return de(s,e)}function pn(t,e,n){if(!t.eql(t.sqr(e),n))throw new Error("Cannot find square root")}function Br(t,e){let n=(t.ORDER+te)/Ir,r=t.pow(e,n);return pn(t,r,e),r}function ri(t,e){let n=(t.ORDER-$r)/Or,r=t.mul(e,$e),s=t.pow(r,n),o=t.mul(e,s),i=t.mul(t.mul(o,$e),s),a=t.mul(o,t.sub(i,t.ONE));return pn(t,a,e),a}function si(t){let e=Ue(t),n=Lr(t),r=n(e,e.neg(e.ONE)),s=n(e,r),o=n(e,e.neg(r)),i=(t+ti)/Cr;return(a,c)=>{let l=a.pow(c,i),d=a.mul(l,r),u=a.mul(l,s),g=a.mul(l,o),f=a.eql(a.sqr(d),c),m=a.eql(a.sqr(u),c);l=a.cmov(l,d,f),d=a.cmov(g,u,m);let w=a.eql(a.sqr(d),c),E=a.cmov(l,d,w);return pn(a,E,c),E}}function Lr(t){if(t<Ar)throw new Error("sqrt is not defined for small field");let e=t-te,n=0;for(;e%$e===ne;)e/=$e,n++;let r=$e,s=Ue(t);for(;Tr(s,r)===1;)if(r++>1e3)throw new Error("Cannot find square root: probably non-prime P");if(n===1)return Br;let o=s.pow(r,e),i=(e+te)/$e;return function(c,l){if(c.is0(l))return l;if(Tr(c,l)!==1)throw new Error("Cannot find square root");let d=n,u=c.mul(c.ONE,o),g=c.pow(l,e),f=c.pow(l,i);for(;!c.eql(g,c.ONE);){if(c.is0(g))return c.ZERO;let m=1,w=c.sqr(g);for(;!c.eql(w,c.ONE);)if(m++,w=c.sqr(w),m===d)throw new Error("Cannot find square root");let E=te<<BigInt(d-m-1),b=c.pow(u,E);d=m,u=c.sqr(b),g=c.mul(g,u),f=c.mul(f,b)}return f}}function oi(t){return t%Ir===Ar?Br:t%Or===$r?ri:t%Cr===ni?si(t):Lr(t)}var ii=["create","isValid","is0","neg","inv","sqrt","sqr","eql","add","sub","mul","pow","div","addN","subN","mulN","sqrN"];function gn(t){let e={ORDER:"bigint",BYTES:"number",BITS:"number"},n=ii.reduce((r,s)=>(r[s]="function",r),e);return rt(t,n),t}function ai(t,e,n){if(n<ne)throw new Error("invalid exponent, negatives unsupported");if(n===ne)return t.ONE;if(n===te)return e;let r=t.ONE,s=e;for(;n>ne;)n&te&&(r=t.mul(r,s)),s=t.sqr(s),n>>=te;return r}function Et(t,e,n=!1){let r=new Array(e.length).fill(n?t.ZERO:void 0),s=e.reduce((i,a,c)=>t.is0(a)?i:(r[c]=i,t.mul(i,a)),t.ONE),o=t.inv(s);return e.reduceRight((i,a,c)=>t.is0(a)?i:(r[c]=t.mul(i,r[c]),t.mul(i,a)),o),r}function Tr(t,e){let n=(t.ORDER-te)/$e,r=t.pow(e,n),s=t.eql(r,t.ONE),o=t.eql(r,t.ZERO),i=t.eql(r,t.neg(t.ONE));if(!s&&!o&&!i)throw new Error("invalid Legendre symbol result");return s?1:o?0:-1}function ci(t,e){e!==void 0&&ie(e);let n=e!==void 0?e:t.toString(2).length,r=Math.ceil(n/8);return{nBitLength:n,nByteLength:r}}var fn=class{ORDER;BITS;BYTES;isLE;ZERO=ne;ONE=te;_lengths;_sqrt;_mod;constructor(e,n={}){if(e<=ne)throw new Error("invalid field: expected ORDER > 0, got "+e);let r;this.isLE=!1,n!=null&&typeof n=="object"&&(typeof n.BITS=="number"&&(r=n.BITS),typeof n.sqrt=="function"&&(this.sqrt=n.sqrt),typeof n.isLE=="boolean"&&(this.isLE=n.isLE),n.allowedLengths&&(this._lengths=n.allowedLengths?.slice()),typeof n.modFromBytes=="boolean"&&(this._mod=n.modFromBytes));let{nBitLength:s,nByteLength:o}=ci(e,r);if(o>2048)throw new Error("invalid field: expected ORDER of <= 2048 bytes");this.ORDER=e,this.BITS=s,this.BYTES=o,this._sqrt=void 0,Object.preventExtensions(this)}create(e){return de(e,this.ORDER)}isValid(e){if(typeof e!="bigint")throw new Error("invalid field element: expected bigint, got "+typeof e);return ne<=e&&e<this.ORDER}is0(e){return e===ne}isValidNot0(e){return!this.is0(e)&&this.isValid(e)}isOdd(e){return(e&te)===te}neg(e){return de(-e,this.ORDER)}eql(e,n){return e===n}sqr(e){return de(e*e,this.ORDER)}add(e,n){return de(e+n,this.ORDER)}sub(e,n){return de(e-n,this.ORDER)}mul(e,n){return de(e*n,this.ORDER)}pow(e,n){return ai(this,e,n)}div(e,n){return de(e*Rr(n,this.ORDER),this.ORDER)}sqrN(e){return e*e}addN(e,n){return e+n}subN(e,n){return e-n}mulN(e,n){return e*n}inv(e){return Rr(e,this.ORDER)}sqrt(e){return this._sqrt||(this._sqrt=oi(this.ORDER)),this._sqrt(this,e)}toBytes(e){return this.isLE?ln(e,this.BYTES):xt(e,this.BYTES)}fromBytes(e,n=!1){D(e);let{_lengths:r,BYTES:s,isLE:o,ORDER:i,_mod:a}=this;if(r){if(!r.includes(e.length)||e.length>s)throw new Error("Field.fromBytes: expected "+r+" bytes, got "+e.length);let l=new Uint8Array(s);l.set(e,o?0:l.length-e.length),e=l}if(e.length!==s)throw new Error("Field.fromBytes: expected "+s+" bytes, got "+e.length);let c=o?cn(e):Se(e);if(a&&(c=de(c,i)),!n&&!this.isValid(c))throw new Error("invalid field element: outside of range 0..ORDER");return c}invertBatch(e){return Et(this,e)}cmov(e,n,r){return r?n:e}};function Ue(t,e={}){return new fn(t,e)}function Nr(t){if(typeof t!="bigint")throw new Error("field order must be bigint");let e=t.toString(2).length;return Math.ceil(e/8)}function hn(t){let e=Nr(t);return e+Math.ceil(e/2)}function St(t,e,n=!1){D(t);let r=t.length,s=Nr(e),o=hn(e);if(r<16||r<o||r>1024)throw new Error("expected "+o+"-1024 bytes of input, got "+r);let i=n?cn(t):Se(t),a=de(i,e-te)+te;return n?ln(a,s):xt(a,s)}var He=BigInt(0),Oe=BigInt(1);function st(t,e){let n=e.negate();return t?n:e}function wn(t,e){let n=Et(t.Fp,e.map(r=>r.Z));return e.map((r,s)=>t.fromAffine(r.toAffine(n[s])))}function Ur(t,e){if(!Number.isSafeInteger(t)||t<=0||t>e)throw new Error("invalid window size, expected [1.."+e+"], got W="+t)}function mn(t,e){Ur(t,e);let n=Math.ceil(e/t)+1,r=2**(t-1),s=2**t,o=nt(t),i=BigInt(t);return{windows:n,windowSize:r,mask:o,maxNumber:s,shiftBy:i}}function Pr(t,e,n){let{windowSize:r,mask:s,maxNumber:o,shiftBy:i}=n,a=Number(t&s),c=t>>i;a>r&&(a-=o,c+=Oe);let l=e*r,d=l+Math.abs(a)-1,u=a===0,g=a<0,f=e%2!==0;return{nextN:c,offset:d,isZero:u,isNeg:g,isNegF:f,offsetF:l}}var yn=new WeakMap,Hr=new WeakMap;function bn(t){return Hr.get(t)||1}function Dr(t){if(t!==He)throw new Error("invalid wNAF")}var vt=class{BASE;ZERO;Fn;bits;constructor(e,n){this.BASE=e.BASE,this.ZERO=e.ZERO,this.Fn=e.Fn,this.bits=n}_unsafeLadder(e,n,r=this.ZERO){let s=e;for(;n>He;)n&Oe&&(r=r.add(s)),s=s.double(),n>>=Oe;return r}precomputeWindow(e,n){let{windows:r,windowSize:s}=mn(n,this.bits),o=[],i=e,a=i;for(let c=0;c<r;c++){a=i,o.push(a);for(let l=1;l<s;l++)a=a.add(i),o.push(a);i=a.double()}return o}wNAF(e,n,r){if(!this.Fn.isValid(r))throw new Error("invalid scalar");let s=this.ZERO,o=this.BASE,i=mn(e,this.bits);for(let a=0;a<i.windows;a++){let{nextN:c,offset:l,isZero:d,isNeg:u,isNegF:g,offsetF:f}=Pr(r,a,i);r=c,d?o=o.add(st(g,n[f])):s=s.add(st(u,n[l]))}return Dr(r),{p:s,f:o}}wNAFUnsafe(e,n,r,s=this.ZERO){let o=mn(e,this.bits);for(let i=0;i<o.windows&&r!==He;i++){let{nextN:a,offset:c,isZero:l,isNeg:d}=Pr(r,i,o);if(r=a,!l){let u=n[c];s=s.add(d?u.negate():u)}}return Dr(r),s}getPrecomputes(e,n,r){let s=yn.get(n);return s||(s=this.precomputeWindow(n,e),e!==1&&(typeof r=="function"&&(s=r(s)),yn.set(n,s))),s}cached(e,n,r){let s=bn(e);return this.wNAF(s,this.getPrecomputes(s,e,r),n)}unsafe(e,n,r,s){let o=bn(e);return o===1?this._unsafeLadder(e,n,s):this.wNAFUnsafe(o,this.getPrecomputes(o,e,r),n,s)}createCache(e,n){Ur(n,this.bits),Hr.set(e,n),yn.delete(e)}hasCache(e){return bn(e)!==1}};function qr(t,e,n,r){let s=e,o=t.ZERO,i=t.ZERO;for(;n>He||r>He;)n&Oe&&(o=o.add(s)),r&Oe&&(i=i.add(s)),s=s.double(),n>>=Oe,r>>=Oe;return{p1:o,p2:i}}function Mr(t,e,n){if(e){if(e.ORDER!==t)throw new Error("Field.ORDER must match order: Fp == p, Fn == n");return gn(e),e}else return Ue(t,{isLE:n})}function Gr(t,e,n={},r){if(r===void 0&&(r=t==="edwards"),!e||typeof e!="object")throw new Error(`expected valid ${t} CURVE object`);for(let c of["p","n","h"]){let l=e[c];if(!(typeof l=="bigint"&&l>He))throw new Error(`CURVE.${c} must be positive bigint`)}let s=Mr(e.p,n.Fp,r),o=Mr(e.n,n.Fn,r),a=["Gx","Gy","a",t==="weierstrass"?"b":"d"];for(let c of a)if(!s.isValid(e[c]))throw new Error(`CURVE.${c} must be valid field element of CURVE.Fp`);return e=Object.freeze(Object.assign({},e)),{CURVE:e,Fp:s,Fn:o}}function kt(t,e){return function(r){let s=t(r);return{secretKey:s,publicKey:e(s)}}}var _t=class{oHash;iHash;blockLen;outputLen;finished=!1;destroyed=!1;constructor(e,n){if(Ie(e),D(n,void 0,"key"),this.iHash=e.create(),typeof this.iHash.update!="function")throw new Error("Expected instance of class which extends utils.Hash");this.blockLen=this.iHash.blockLen,this.outputLen=this.iHash.outputLen;let r=this.blockLen,s=new Uint8Array(r);s.set(n.length>r?e.create().update(n).digest():n);for(let o=0;o<s.length;o++)s[o]^=54;this.iHash.update(s),this.oHash=e.create();for(let o=0;o<s.length;o++)s[o]^=106;this.oHash.update(s),ge(s)}update(e){return Me(this),this.iHash.update(e),this}digestInto(e){Me(this),D(e,this.outputLen,"output"),this.finished=!0,this.iHash.digestInto(e),this.oHash.update(e),this.oHash.digestInto(e),this.destroy()}digest(){let e=new Uint8Array(this.oHash.outputLen);return this.digestInto(e),e}_cloneInto(e){e||=Object.create(Object.getPrototypeOf(this),{});let{oHash:n,iHash:r,finished:s,destroyed:o,blockLen:i,outputLen:a}=this;return e=e,e.finished=s,e.destroyed=o,e.blockLen=i,e.outputLen=a,e.oHash=n._cloneInto(e.oHash),e.iHash=r._cloneInto(e.iHash),e}clone(){return this._cloneInto()}destroy(){this.destroyed=!0,this.oHash.destroy(),this.iHash.destroy()}},ve=(t,e,n)=>new _t(t,e).update(n).digest();ve.create=(t,e)=>new _t(t,e);var jr=(t,e)=>(t+(t>=0?e:-e)/zr)/e;function li(t,e,n){let[[r,s],[o,i]]=e,a=jr(i*t,n),c=jr(-s*t,n),l=t-a*r-c*o,d=-a*s-c*i,u=l<ye,g=d<ye;u&&(l=-l),g&&(d=-d);let f=nt(Math.ceil(dn(n)/2))+qe;if(l<ye||l>=f||d<ye||d>=f)throw new Error("splitScalar (endomorphism): failed, k="+t);return{k1neg:u,k1:l,k2neg:g,k2:d}}function En(t){if(!["compact","recovered","der"].includes(t))throw new Error(\'Signature format must be "compact", "recovered", or "der"\');return t}function xn(t,e){let n={};for(let r of Object.keys(e))n[r]=t[r]===void 0?e[r]:t[r];return et(n.lowS,"lowS"),et(n.prehash,"prehash"),n.format!==void 0&&En(n.format),n}var Sn=class extends Error{constructor(e=""){super(e)}},ke={Err:Sn,_tlv:{encode:(t,e)=>{let{Err:n}=ke;if(t<0||t>256)throw new n("tlv.encode: wrong tag");if(e.length&1)throw new n("tlv.encode: unpadded data");let r=e.length/2,s=tt(r);if(s.length/2&128)throw new n("tlv.encode: long form length too big");let o=r>127?tt(s.length/2|128):"";return tt(t)+o+s+e},decode(t,e){let{Err:n}=ke,r=0;if(t<0||t>256)throw new n("tlv.encode: wrong tag");if(e.length<2||e[r++]!==t)throw new n("tlv.decode: wrong tlv");let s=e[r++],o=!!(s&128),i=0;if(!o)i=s;else{let c=s&127;if(!c)throw new n("tlv.decode(long): indefinite length not supported");if(c>4)throw new n("tlv.decode(long): byte length is too big");let l=e.subarray(r,r+c);if(l.length!==c)throw new n("tlv.decode: length bytes not complete");if(l[0]===0)throw new n("tlv.decode(long): zero leftmost byte");for(let d of l)i=i<<8|d;if(r+=c,i<128)throw new n("tlv.decode(long): not minimal encoding")}let a=e.subarray(r,r+i);if(a.length!==i)throw new n("tlv.decode: wrong value length");return{v:a,l:e.subarray(r+i)}}},_int:{encode(t){let{Err:e}=ke;if(t<ye)throw new e("integer: negative integers are not allowed");let n=tt(t);if(Number.parseInt(n[0],16)&8&&(n="00"+n),n.length&1)throw new e("unexpected DER parsing assertion: unpadded hex");return n},decode(t){let{Err:e}=ke;if(t[0]&128)throw new e("invalid signature integer: negative");if(t[0]===0&&!(t[1]&128))throw new e("invalid signature integer: unnecessary leading zero");return Se(t)}},toSig(t){let{Err:e,_int:n,_tlv:r}=ke,s=D(t,void 0,"signature"),{v:o,l:i}=r.decode(48,s);if(i.length)throw new e("invalid signature: left bytes after parsing");let{v:a,l:c}=r.decode(2,o),{v:l,l:d}=r.decode(2,c);if(d.length)throw new e("invalid signature: left bytes after parsing");return{r:n.decode(a),s:n.decode(l)}},hexFromSig(t){let{_tlv:e,_int:n}=ke,r=e.encode(2,n.encode(t.r)),s=e.encode(2,n.encode(t.s)),o=r+s;return e.encode(48,o)}},ye=BigInt(0),qe=BigInt(1),zr=BigInt(2),Rt=BigInt(3),di=BigInt(4);function Kr(t,e={}){let n=Gr("weierstrass",t,e),{Fp:r,Fn:s}=n,o=n.CURVE,{h:i,n:a}=o;rt(e,{},{allowInfinityPoint:"boolean",clearCofactor:"function",isTorsionFree:"function",fromBytes:"function",toBytes:"function",endo:"object"});let{endo:c}=e;if(c&&(!r.is0(o.a)||typeof c.beta!="bigint"||!Array.isArray(c.basises)))throw new Error(\'invalid endo: expected "beta": bigint and "basises": array\');let l=Wr(r,s);function d(){if(!r.isOdd)throw new Error("compression is not supported: Field does not have .isOdd()")}function u(S,h,y){let{x:p,y:v}=h.toAffine(),k=r.toBytes(p);if(et(y,"isCompressed"),y){d();let T=!r.isOdd(v);return Z(Fr(T),k)}else return Z(Uint8Array.of(4),k,r.toBytes(v))}function g(S){D(S,void 0,"Point");let{publicKey:h,publicKeyUncompressed:y}=l,p=S.length,v=S[0],k=S.subarray(1);if(p===h&&(v===2||v===3)){let T=r.fromBytes(k);if(!r.isValid(T))throw new Error("bad point: is not on curve, wrong x");let x=w(T),_;try{_=r.sqrt(x)}catch(U){let O=U instanceof Error?": "+U.message:"";throw new Error("bad point: is not on curve, sqrt error"+O)}d();let A=r.isOdd(_);return(v&1)===1!==A&&(_=r.neg(_)),{x:T,y:_}}else if(p===y&&v===4){let T=r.BYTES,x=r.fromBytes(k.subarray(0,T)),_=r.fromBytes(k.subarray(T,T*2));if(!E(x,_))throw new Error("bad point: is not on curve");return{x,y:_}}else throw new Error(`bad point: got length ${p}, expected compressed=${h} or uncompressed=${y}`)}let f=e.toBytes||u,m=e.fromBytes||g;function w(S){let h=r.sqr(S),y=r.mul(h,S);return r.add(r.add(y,r.mul(S,o.a)),o.b)}function E(S,h){let y=r.sqr(h),p=w(S);return r.eql(y,p)}if(!E(o.Gx,o.Gy))throw new Error("bad curve params: generator point");let b=r.mul(r.pow(o.a,Rt),di),C=r.mul(r.sqr(o.b),BigInt(27));if(r.is0(r.add(b,C)))throw new Error("bad curve params: a or b");function P(S,h,y=!1){if(!r.isValid(h)||y&&r.is0(h))throw new Error(`bad point coordinate ${S}`);return h}function L(S){if(!(S instanceof B))throw new Error("Weierstrass Point expected")}function F(S){if(!c||!c.basises)throw new Error("no endo");return li(S,c.basises,s.ORDER)}let j=un((S,h)=>{let{X:y,Y:p,Z:v}=S;if(r.eql(v,r.ONE))return{x:y,y:p};let k=S.is0();h==null&&(h=k?r.ONE:r.inv(v));let T=r.mul(y,h),x=r.mul(p,h),_=r.mul(v,h);if(k)return{x:r.ZERO,y:r.ZERO};if(!r.eql(_,r.ONE))throw new Error("invZ was invalid");return{x:T,y:x}}),W=un(S=>{if(S.is0()){if(e.allowInfinityPoint&&!r.is0(S.Y))return;throw new Error("bad point: ZERO")}let{x:h,y}=S.toAffine();if(!r.isValid(h)||!r.isValid(y))throw new Error("bad point: x or y not field elements");if(!E(h,y))throw new Error("bad point: equation left != right");if(!S.isTorsionFree())throw new Error("bad point: not in prime-order subgroup");return!0});function K(S,h,y,p,v){return y=new B(r.mul(y.X,S),y.Y,y.Z),h=st(p,h),y=st(v,y),h.add(y)}class B{static BASE=new B(o.Gx,o.Gy,r.ONE);static ZERO=new B(r.ZERO,r.ONE,r.ZERO);static Fp=r;static Fn=s;X;Y;Z;constructor(h,y,p){this.X=P("x",h),this.Y=P("y",y,!0),this.Z=P("z",p),Object.freeze(this)}static CURVE(){return o}static fromAffine(h){let{x:y,y:p}=h||{};if(!h||!r.isValid(y)||!r.isValid(p))throw new Error("invalid affine point");if(h instanceof B)throw new Error("projective point not allowed");return r.is0(y)&&r.is0(p)?B.ZERO:new B(y,p,r.ONE)}static fromBytes(h){let y=B.fromAffine(m(D(h,void 0,"point")));return y.assertValidity(),y}static fromHex(h){return B.fromBytes(re(h))}get x(){return this.toAffine().x}get y(){return this.toAffine().y}precompute(h=8,y=!0){return R.createCache(this,h),y||this.multiply(Rt),this}assertValidity(){W(this)}hasEvenY(){let{y:h}=this.toAffine();if(!r.isOdd)throw new Error("Field doesn\'t support isOdd");return!r.isOdd(h)}equals(h){L(h);let{X:y,Y:p,Z:v}=this,{X:k,Y:T,Z:x}=h,_=r.eql(r.mul(y,x),r.mul(k,v)),A=r.eql(r.mul(p,x),r.mul(T,v));return _&&A}negate(){return new B(this.X,r.neg(this.Y),this.Z)}double(){let{a:h,b:y}=o,p=r.mul(y,Rt),{X:v,Y:k,Z:T}=this,x=r.ZERO,_=r.ZERO,A=r.ZERO,I=r.mul(v,v),U=r.mul(k,k),O=r.mul(T,T),N=r.mul(v,k);return N=r.add(N,N),A=r.mul(v,T),A=r.add(A,A),x=r.mul(h,A),_=r.mul(p,O),_=r.add(x,_),x=r.sub(U,_),_=r.add(U,_),_=r.mul(x,_),x=r.mul(N,x),A=r.mul(p,A),O=r.mul(h,O),N=r.sub(I,O),N=r.mul(h,N),N=r.add(N,A),A=r.add(I,I),I=r.add(A,I),I=r.add(I,O),I=r.mul(I,N),_=r.add(_,I),O=r.mul(k,T),O=r.add(O,O),I=r.mul(O,N),x=r.sub(x,I),A=r.mul(O,U),A=r.add(A,A),A=r.add(A,A),new B(x,_,A)}add(h){L(h);let{X:y,Y:p,Z:v}=this,{X:k,Y:T,Z:x}=h,_=r.ZERO,A=r.ZERO,I=r.ZERO,U=o.a,O=r.mul(o.b,Rt),N=r.mul(y,k),M=r.mul(p,T),z=r.mul(v,x),V=r.add(y,p),G=r.add(k,T);V=r.mul(V,G),G=r.add(N,M),V=r.sub(V,G),G=r.add(y,v);let ee=r.add(k,x);return G=r.mul(G,ee),ee=r.add(N,z),G=r.sub(G,ee),ee=r.add(p,v),_=r.add(T,x),ee=r.mul(ee,_),_=r.add(M,z),ee=r.sub(ee,_),I=r.mul(U,G),_=r.mul(O,z),I=r.add(_,I),_=r.sub(M,I),I=r.add(M,I),A=r.mul(_,I),M=r.add(N,N),M=r.add(M,N),z=r.mul(U,z),G=r.mul(O,G),M=r.add(M,z),z=r.sub(N,z),z=r.mul(U,z),G=r.add(G,z),N=r.mul(M,G),A=r.add(A,N),N=r.mul(ee,G),_=r.mul(V,_),_=r.sub(_,N),N=r.mul(V,M),I=r.mul(ee,I),I=r.add(I,N),new B(_,A,I)}subtract(h){return this.add(h.negate())}is0(){return this.equals(B.ZERO)}multiply(h){let{endo:y}=e;if(!s.isValidNot0(h))throw new Error("invalid scalar: out of range");let p,v,k=T=>R.cached(this,T,x=>wn(B,x));if(y){let{k1neg:T,k1:x,k2neg:_,k2:A}=F(h),{p:I,f:U}=k(x),{p:O,f:N}=k(A);v=U.add(N),p=K(y.beta,I,O,T,_)}else{let{p:T,f:x}=k(h);p=T,v=x}return wn(B,[p,v])[0]}multiplyUnsafe(h){let{endo:y}=e,p=this;if(!s.isValid(h))throw new Error("invalid scalar: out of range");if(h===ye||p.is0())return B.ZERO;if(h===qe)return p;if(R.hasCache(this))return this.multiply(h);if(y){let{k1neg:v,k1:k,k2neg:T,k2:x}=F(h),{p1:_,p2:A}=qr(B,p,k,x);return K(y.beta,_,A,v,T)}else return R.unsafe(p,h)}toAffine(h){return j(this,h)}isTorsionFree(){let{isTorsionFree:h}=e;return i===qe?!0:h?h(B,this):R.unsafe(this,a).is0()}clearCofactor(){let{clearCofactor:h}=e;return i===qe?this:h?h(B,this):this.multiplyUnsafe(i)}isSmallOrder(){return this.multiplyUnsafe(i).is0()}toBytes(h=!0){return et(h,"isCompressed"),this.assertValidity(),f(B,this,h)}toHex(h=!0){return ae(this.toBytes(h))}toString(){return`<Point ${this.is0()?"ZERO":this.toHex()}>`}}let H=s.BITS,R=new vt(B,e.endo?Math.ceil(H/2):H);return B.BASE.precompute(8),B}function Fr(t){return Uint8Array.of(t?2:3)}function Wr(t,e){return{secretKey:e.BYTES,publicKey:1+t.BYTES,publicKeyUncompressed:1+2*t.BYTES,publicKeyHasPrefix:!0,signature:2*e.BYTES}}function ui(t,e={}){let{Fn:n}=t,r=e.randomBytes||he,s=Object.assign(Wr(t.Fp,n),{seed:hn(n.ORDER)});function o(f){try{let m=n.fromBytes(f);return n.isValidNot0(m)}catch{return!1}}function i(f,m){let{publicKey:w,publicKeyUncompressed:E}=s;try{let b=f.length;return m===!0&&b!==w||m===!1&&b!==E?!1:!!t.fromBytes(f)}catch{return!1}}function a(f=r(s.seed)){return St(D(f,s.seed,"seed"),n.ORDER)}function c(f,m=!0){return t.BASE.multiply(n.fromBytes(f)).toBytes(m)}function l(f){let{secretKey:m,publicKey:w,publicKeyUncompressed:E}=s;if(!Qe(f)||"_lengths"in n&&n._lengths||m===w)return;let b=D(f,void 0,"key").length;return b===w||b===E}function d(f,m,w=!0){if(l(f)===!0)throw new Error("first arg must be private key");if(l(m)===!1)throw new Error("second arg must be public key");let E=n.fromBytes(f);return t.fromBytes(m).multiply(E).toBytes(w)}let u={isValidSecretKey:o,isValidPublicKey:i,randomSecretKey:a},g=kt(a,c);return Object.freeze({getPublicKey:c,getSharedSecret:d,keygen:g,Point:t,utils:u,lengths:s})}function Vr(t,e,n={}){Ie(e),rt(n,{},{hmac:"function",lowS:"boolean",randomBytes:"function",bits2int:"function",bits2int_modN:"function"}),n=Object.assign({},n);let r=n.randomBytes||he,s=n.hmac||((y,p)=>ve(e,y,p)),{Fp:o,Fn:i}=t,{ORDER:a,BITS:c}=i,{keygen:l,getPublicKey:d,getSharedSecret:u,utils:g,lengths:f}=ui(t,n),m={prehash:!0,lowS:typeof n.lowS=="boolean"?n.lowS:!0,format:"compact",extraEntropy:!1},w=a*zr<o.ORDER;function E(y){let p=a>>qe;return y>p}function b(y,p){if(!i.isValidNot0(p))throw new Error(`invalid signature ${y}: out of range 1..Point.Fn.ORDER`);return p}function C(){if(w)throw new Error(\'"recovered" sig type is not supported for cofactor >2 curves\')}function P(y,p){En(p);let v=f.signature,k=p==="compact"?v:p==="recovered"?v+1:void 0;return D(y,k)}class L{r;s;recovery;constructor(p,v,k){if(this.r=b("r",p),this.s=b("s",v),k!=null){if(C(),![0,1,2,3].includes(k))throw new Error("invalid recovery id");this.recovery=k}Object.freeze(this)}static fromBytes(p,v=m.format){P(p,v);let k;if(v==="der"){let{r:A,s:I}=ke.toSig(D(p));return new L(A,I)}v==="recovered"&&(k=p[0],v="compact",p=p.subarray(1));let T=f.signature/2,x=p.subarray(0,T),_=p.subarray(T,T*2);return new L(i.fromBytes(x),i.fromBytes(_),k)}static fromHex(p,v){return this.fromBytes(re(p),v)}assertRecovery(){let{recovery:p}=this;if(p==null)throw new Error("invalid recovery id: must be present");return p}addRecoveryBit(p){return new L(this.r,this.s,p)}recoverPublicKey(p){let{r:v,s:k}=this,T=this.assertRecovery(),x=T===2||T===3?v+a:v;if(!o.isValid(x))throw new Error("invalid recovery id: sig.r+curve.n != R.x");let _=o.toBytes(x),A=t.fromBytes(Z(Fr((T&1)===0),_)),I=i.inv(x),U=j(D(p,void 0,"msgHash")),O=i.create(-U*I),N=i.create(k*I),M=t.BASE.multiplyUnsafe(O).add(A.multiplyUnsafe(N));if(M.is0())throw new Error("invalid recovery: point at infinify");return M.assertValidity(),M}hasHighS(){return E(this.s)}toBytes(p=m.format){if(En(p),p==="der")return re(ke.hexFromSig(this));let{r:v,s:k}=this,T=i.toBytes(v),x=i.toBytes(k);return p==="recovered"?(C(),Z(Uint8Array.of(this.assertRecovery()),T,x)):Z(T,x)}toHex(p){return ae(this.toBytes(p))}}let F=n.bits2int||function(p){if(p.length>8192)throw new Error("input is too large");let v=Se(p),k=p.length*8-c;return k>0?v>>BigInt(k):v},j=n.bits2int_modN||function(p){return i.create(F(p))},W=nt(c);function K(y){return kr("num < 2^"+c,y,ye,W),i.toBytes(y)}function B(y,p){return D(y,void 0,"message"),p?D(e(y),void 0,"prehashed message"):y}function H(y,p,v){let{lowS:k,prehash:T,extraEntropy:x}=xn(v,m);y=B(y,T);let _=j(y),A=i.fromBytes(p);if(!i.isValidNot0(A))throw new Error("invalid private key");let I=[K(A),K(_)];if(x!=null&&x!==!1){let M=x===!0?r(f.secretKey):x;I.push(D(M,void 0,"extraEntropy"))}let U=Z(...I),O=_;function N(M){let z=F(M);if(!i.isValidNot0(z))return;let V=i.inv(z),G=t.BASE.multiply(z).toAffine(),ee=i.create(G.x);if(ee===ye)return;let gt=i.create(V*i.create(O+ee*A));if(gt===ye)return;let dr=(G.x===ee?0:2)|Number(G.y&qe),ur=gt;return k&&E(gt)&&(ur=i.neg(gt),dr^=1),new L(ee,ur,w?void 0:dr)}return{seed:U,k2sig:N}}function R(y,p,v={}){let{seed:k,k2sig:T}=H(y,p,v);return _r(e.outputLen,i.BYTES,s)(k,T).toBytes(v.format)}function S(y,p,v,k={}){let{lowS:T,prehash:x,format:_}=xn(k,m);if(v=D(v,void 0,"publicKey"),p=B(p,x),!Qe(y)){let A=y instanceof L?", use sig.toBytes()":"";throw new Error("verify expects Uint8Array signature"+A)}P(y,_);try{let A=L.fromBytes(y,_),I=t.fromBytes(v);if(T&&A.hasHighS())return!1;let{r:U,s:O}=A,N=j(p),M=i.inv(O),z=i.create(N*M),V=i.create(U*M),G=t.BASE.multiplyUnsafe(z).add(I.multiplyUnsafe(V));return G.is0()?!1:i.create(G.x)===U}catch{return!1}}function h(y,p,v={}){let{prehash:k}=xn(v,m);return p=B(p,k),L.fromBytes(y,"recovered").recoverPublicKey(p).toBytes()}return Object.freeze({keygen:l,getPublicKey:d,getSharedSecret:u,utils:g,lengths:f,Point:t,sign:R,verify:S,recoverPublicKey:h,Signature:L,hash:e})}var It={p:BigInt("0xfffffffffffffffffffffffffffffffffffffffffffffffffffffffefffffc2f"),n:BigInt("0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141"),h:BigInt(1),a:BigInt(0),b:BigInt(7),Gx:BigInt("0x79be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798"),Gy:BigInt("0x483ada7726a3c4655da4fbfc0e1108a8fd17b448a68554199c47d08ffb10d4b8")},fi={beta:BigInt("0x7ae96a2b657c07106e64479eac3434e99cf0497512f58995c1396c28719501ee"),basises:[[BigInt("0x3086d221a7d46bcde86c90e49284eb15"),-BigInt("0xe4437ed6010e88286f547fa90abfe4c3")],[BigInt("0x114ca50f7a8e2f3f657c1108d9d44cfd8"),BigInt("0x3086d221a7d46bcde86c90e49284eb15")]]},pi=BigInt(0),vn=BigInt(2);function gi(t){let e=It.p,n=BigInt(3),r=BigInt(6),s=BigInt(11),o=BigInt(22),i=BigInt(23),a=BigInt(44),c=BigInt(88),l=t*t*t%e,d=l*l*t%e,u=oe(d,n,e)*d%e,g=oe(u,n,e)*d%e,f=oe(g,vn,e)*l%e,m=oe(f,s,e)*f%e,w=oe(m,o,e)*m%e,E=oe(w,a,e)*w%e,b=oe(E,c,e)*E%e,C=oe(b,a,e)*w%e,P=oe(C,n,e)*d%e,L=oe(P,i,e)*m%e,F=oe(L,r,e)*l%e,j=oe(F,vn,e);if(!Tt.eql(Tt.sqr(j),t))throw new Error("Cannot find square root");return j}var Tt=Ue(It.p,{sqrt:gi}),Ce=Kr(It,{Fp:Tt,endo:fi}),Xr=Vr(Ce,ce),Zr={};function At(t,...e){let n=Zr[t];if(n===void 0){let r=ce(vr(t));n=Z(r,r),Zr[t]=n}return ce(Z(n,...e))}var _n=t=>t.toBytes(!0).slice(1),Rn=t=>t%vn===pi;function kn(t){let{Fn:e,BASE:n}=Ce,r=e.fromBytes(t),s=n.multiply(r);return{scalar:Rn(s.y)?r:e.neg(r),bytes:_n(s)}}function Jr(t){let e=Tt;if(!e.isValidNot0(t))throw new Error("invalid x: Fail if x \\u2265 p");let n=e.create(t*t),r=e.create(n*t+BigInt(7)),s=e.sqrt(r);Rn(s)||(s=e.neg(s));let o=Ce.fromAffine({x:t,y:s});return o.assertValidity(),o}var ot=Se;function Qr(...t){return Ce.Fn.create(ot(At("BIP0340/challenge",...t)))}function Yr(t){return kn(t).bytes}function hi(t,e,n=he(32)){let{Fn:r}=Ce,s=D(t,void 0,"message"),{bytes:o,scalar:i}=kn(e),a=D(n,32,"auxRand"),c=r.toBytes(i^ot(At("BIP0340/aux",a))),l=At("BIP0340/nonce",c,o,s),{bytes:d,scalar:u}=kn(l),g=Qr(d,o,s),f=new Uint8Array(64);if(f.set(d,0),f.set(r.toBytes(r.create(u+g*i)),32),!es(f,s,o))throw new Error("sign: Invalid signature produced");return f}function es(t,e,n){let{Fp:r,Fn:s,BASE:o}=Ce,i=D(t,64,"signature"),a=D(e,void 0,"message"),c=D(n,32,"publicKey");try{let l=Jr(ot(c)),d=ot(i.subarray(0,32));if(!r.isValidNot0(d))return!1;let u=ot(i.subarray(32,64));if(!s.isValidNot0(u))return!1;let g=Qr(s.toBytes(d),_n(l),a),f=o.multiplyUnsafe(u).add(l.multiplyUnsafe(s.neg(g))),{x:m,y:w}=f.toAffine();return!(f.is0()||!Rn(w)||m!==d)}catch{return!1}}var _e=(()=>{let n=(r=he(48))=>St(r,It.n);return{keygen:kt(n,Yr),getPublicKey:Yr,sign:hi,verify:es,Point:Ce,utils:{randomSecretKey:n,taggedHash:At,lift_x:Jr,pointToBytes:_n},lengths:{secretKey:32,publicKey:32,publicKeyHasPrefix:!1,signature:64,seed:48}}})();var pl=new TextDecoder("utf-8"),mi=new TextEncoder;function yi(t){if(t.length!==64)return!1;for(let e=0;e<64;e++){let n=t.charCodeAt(e);if(isNaN(n)||n<48||n>102||n>57&&n<97)return!1}return!0}var Ge=Symbol("verified"),bi=t=>t instanceof Object;function wi(t){if(!bi(t)||typeof t.kind!="number"||typeof t.content!="string"||typeof t.created_at!="number"||typeof t.pubkey!="string"||!yi(t.pubkey)||!Array.isArray(t.tags))return!1;for(let e=0;e<t.tags.length;e++){let n=t.tags[e];if(!Array.isArray(n))return!1;for(let r=0;r<n.length;r++)if(typeof n[r]!="string")return!1}return!0}var xi=class{generateSecretKey(){return _e.utils.randomSecretKey()}getPublicKey(t){return ae(_e.getPublicKey(t))}finalizeEvent(t,e){let n=t;return n.pubkey=ae(_e.getPublicKey(e)),n.id=Tn(n),n.sig=ae(_e.sign(re(Tn(n)),e)),n[Ge]=!0,n}verifyEvent(t){if(typeof t[Ge]=="boolean")return t[Ge];try{let e=Tn(t);if(e!==t.id)return t[Ge]=!1,!1;let n=_e.verify(re(t.sig),re(e),re(t.pubkey));return t[Ge]=n,n}catch{return t[Ge]=!1,!1}}};function Ei(t){if(!wi(t))throw new Error("can\'t serialize event with wrong or missing properties");return JSON.stringify([0,t.pubkey,t.created_at,t.kind,t.tags,t.content])}function Tn(t){let e=ce(mi.encode(Ei(t)));return ae(e)}var $t=new xi,ts=$t.generateSecretKey,it=$t.getPublicKey,ns=$t.finalizeEvent,rs=$t.verifyEvent;var at=class{constructor(e){this.onEvent=e}buffer="";data=[];event="";id;push(e){this.buffer+=e;let n=this.buffer.search(/\\r\\n|\\r|\\n/);for(;n!==-1;){let r=this.buffer.slice(0,n),s=this.buffer.startsWith(`\\r\n`,n)?2:1;this.buffer=this.buffer.slice(n+s),this.line(r),n=this.buffer.search(/\\r\\n|\\r|\\n/)}}end(){this.buffer&&this.line(this.buffer),this.buffer="",this.line("")}line(e){if(e===""){this.data.length&&this.onEvent({event:this.event||"message",data:this.data.join(`\n`),...this.id!==void 0&&{id:this.id}}),this.data=[],this.event="";return}if(e.startsWith(":"))return;let n=e.indexOf(":"),r=n===-1?e:e.slice(0,n),s=n===-1?"":e.slice(n+1);s.startsWith(" ")&&(s=s.slice(1)),r==="data"?this.data.push(s):r==="event"?this.event=s:r==="id"&&(this.id=s)}};function ss(t){let e=[],n=new at(r=>e.push(r));return n.push(t),n.end(),e}var Si="databricks-buzz-plugins/0.1.0",An=class extends Error{constructor(n,r,s,o){super(s);this.status=n;this.errorCode=r;this.body=o;this.name="DatabricksApiError"}get isPermission(){return this.status===403||this.errorCode==="PERMISSION_DENIED"}get isNotFound(){return this.status===404||this.errorCode==="RESOURCE_DOES_NOT_EXIST"||this.errorCode==="NOT_FOUND"}get isFeatureDisabled(){return this.errorCode==="FEATURE_DISABLED"||this.errorCode==="NOT_IMPLEMENTED"||/not enabled|feature.*disabled|preview/i.test(this.message)}};function je(t){let e,n=`Databricks returned HTTP ${t.status}`;try{let r=JSON.parse(t.body);e=r.error_code??(typeof r.error=="object"?r.error?.code:void 0),n=r.message??(typeof r.error=="object"?r.error?.message:r.error)??r.error_description??n}catch{let r=t.body.trim();r&&r.length<400&&!r.startsWith("<")&&(n=r)}return new An(t.status,e,n,t.body)}var vi=new Set(["GET","HEAD","PUT","DELETE"]),ki=(t,e)=>new Promise((n,r)=>{let s=setTimeout(n,t);e?.addEventListener("abort",()=>{clearTimeout(s),r(e.reason)},{once:!0})}),ct=class{constructor(e){this.options=e;this.host=e.host.replace(/\\/+$/,""),this.workspaceId=e.workspaceId}host;workspaceId;url(e,n){let r=new URL(/^https:\\/\\//.test(e)?e:`${this.host}${e.startsWith("/")?"":"/"}${e}`);for(let[s,o]of Object.entries(n??{}))o!==void 0&&r.searchParams.set(s,String(o));return r.toString()}async request(e,n={},r){let s=n.method??(n.body===void 0?"GET":"POST"),o=n.body===void 0?void 0:typeof n.body=="string"?n.body:JSON.stringify(n.body),i=async c=>{let l=await this.options.token({force:c});return this.options.transport({url:this.url(e,n.query),method:s,headers:{Authorization:`Bearer ${l}`,"User-Agent":this.options.userAgent??Si,Accept:"application/json",...o!==void 0&&{"Content-Type":"application/json"},...this.workspaceId&&{"X-Databricks-Workspace-Id":this.workspaceId},...n.headers},...o!==void 0&&{body:o},...n.timeoutMs!==void 0&&{timeoutMs:n.timeoutMs},...n.signal&&{signal:n.signal},...r&&{onBody:r}})},a=await i(!1);a.status===401&&(a=await i(!0));for(let c=0;c<3&&(a.status===429||a.status===503)&&vi.has(s)&&!r;c++){let l=Number(a.headers["retry-after"]);await ki(Number.isFinite(l)&&l>0?Math.min(l*1e3,2e4):500*2**c+Math.random()*250,n.signal),a=await i(!1)}return a}async json(e,n={}){let r=await this.request(e,n);if(r.status<200||r.status>=300)throw je(r);return r.body.trim()?JSON.parse(r.body):{}}get(e,n={}){return this.json(e,{...n,method:"GET"})}post(e,n,r={}){return this.json(e,{...r,method:"POST",body:n??{}})}async stream(e,n,r){let s=new at(r),o=!0,i=await this.request(e,{...n,headers:{Accept:"text/event-stream",...n.headers}},a=>{o&&s.push(a)});if(i.status<200||i.status>=300)throw o=!1,je(i);return s.end(),i}};var os="2025-06-18",Ot=class extends Error{constructor(n,r,s){super(n);this.code=r;this.data=s;this.name="McpError"}},In=t=>`/ai-gateway/mcp-services/${t}`,ze=class{constructor(e,n,r={}){this.client=e;this.path=n;this.query=r}session;initializing;nextId=1;toolsCache;serverInfo;instructions;async listTools(e){if(this.toolsCache&&Date.now()-this.toolsCache.at<5*6e4)return this.toolsCache.tools;let n=[],r;do{let s=await this.call("tools/list",r?{cursor:r}:{},e);n.push(...s.tools??[]),r=s.nextCursor}while(r);return this.toolsCache={at:Date.now(),tools:n},n}callTool(e,n,r={}){return this.call("tools/call",{name:e,arguments:n,...r.meta&&{_meta:r.meta}},r.signal,r.timeoutMs)}async readResource(e,n){return await this.call("resources/read",{uri:e},n)}async ensureSession(e){this.session||(this.initializing??=(async()=>{let n=await this.send({jsonrpc:"2.0",id:this.nextId++,method:"initialize",params:{protocolVersion:os,capabilities:{},clientInfo:{name:"databricks-buzz-plugins",version:"0.1.0"}}},e,!0);this.serverInfo=n?.serverInfo,this.instructions=n?.instructions,await this.send({jsonrpc:"2.0",method:"notifications/initialized"},e).catch(()=>{})})().finally(()=>{this.initializing=void 0}),await this.initializing)}async call(e,n,r,s){await this.ensureSession(r);try{return await this.send({jsonrpc:"2.0",id:this.nextId++,method:e,params:n},r,!1,s)}catch(o){if(o.status===404&&this.session)return this.session=void 0,await this.ensureSession(r),this.send({jsonrpc:"2.0",id:this.nextId++,method:e,params:n},r,!1,s);throw o}}async send(e,n,r=!1,s=12e4){let o=await this.client.request(this.path,{method:"POST",query:this.query,body:e,timeoutMs:s,...n&&{signal:n},headers:{Accept:"application/json, text/event-stream",...!r&&{"MCP-Protocol-Version":os},...this.session&&{"Mcp-Session-Id":this.session}}}),i=o.headers["mcp-session-id"];if(i&&(this.session=i),e.id===void 0||o.status===202)return;if(o.status<200||o.status>=300)throw je(o);let c=(o.headers["content-type"]??"").includes("text/event-stream")?ss(o.body).map(l=>l.data):[o.body];for(let l of c){let d;try{d=JSON.parse(l)}catch{continue}if(d.id===e.id){if(d.error)throw new Ot(d.error.message??"MCP error",d.error.code,d.error.data);return d.result}}throw new Ot(`No response to ${e.method}`)}};function Re(t){return(t.content??[]).map(e=>e.type==="text"?String(e.text):"").filter(Boolean).join(`\n\n`)}function Ke(t){if(t.structuredContent!==void 0)return t.structuredContent;for(let e of t.content??[]){if(e.type!=="text")continue;let n=String(e.text).trim();if(!(!n.startsWith("{")&&!n.startsWith("[")))try{return JSON.parse(n)}catch{}}}var Tl=3*6e4,Al=30*6e4;var Ri="bkvarda.databricks",Vl=`${Ri}/connection`;function Ct(t){return t instanceof Error&&t.name==="DatabricksApiError"}function is(t){return Ct(t)?t.isPermission?`You don\'t have access: ${t.message}`:t.isFeatureDisabled?`This isn\'t enabled in your workspace: ${t.message}`:t.message:t instanceof Error?t.message:String(t)}var Ti="system.ai.genie_one_mcp",Ai=3e3,Ii=3,$i=t=>t==null?null:typeof t=="object"?JSON.stringify(t):String(t);function Oi(t){if(!t.ready||!t.columns?.length)return;let e=(t.rows??[]).map(r=>r.map($i)),n=t.total_row_count??void 0;return ht(t.columns.map(r=>({name:r.name,...r.type_text&&{type:r.type_text}})),e,{...n!==void 0&&{totalRows:n},truncated:!!t.truncated||n!==void 0&&n>e.length})}var Ci=t=>t.replace(/<!--[\\s\\S]*?--\\s*>/g,"").replace(/\\n{3,}/g,`\n\n`).trim();function ls(t){return Ci(t).replace(/\\s*:citation\\[[^\\]]*\\]/g,"").replace(/\\s*\\[Query Result\\]\\([^)\\s]*#embed-[^)\\s]*\\)/g,"").replace(/\\s*\\[Knowledge snippets?\\]\\([^)]*\\)/gi,"").replace(/([.!?)])[ \\t]+Knowledge snippets?(?=[ \\t]*(\\n|$))/gi,"$1").replace(/`([^`]+)`\\s*\\[\\1\\]\\(/g,"[$1](").replace(/[ \\t]+$/gm,"").trim()}function Bi(t){let e=String.raw`(?:charts?|graphs?|plots?|visuali[sz]ations?)`,n=r=>/^[ \\t]*/.exec(r)?.[0]??"";return t.replace(new RegExp(String.raw`[^.!?\\n]*\\b(?:can(?:\'|\u2019)?t|cannot|can not|unable to|not able to)\\b[^.!?\\n]*\\b${e}\\b[^.!?\\n]*[.!?][ \\t]*`,"gi"),n).replace(new RegExp(String.raw`[^.!?\\n]*\\b(?:to (?:turn|make|build|create) (?:this|it|these|the results?) into an? ${e}|you can (?:chart|plot|graph) (?:this|it|them|directly))\\b[^.!?\\n]*[.!?][ \\t]*`,"gi"),n).replace(/[ \\t]+$/gm,"").replace(/\\n{3,}/g,`\n\n`).trim()}var as=t=>t.trim().replace(/^\\|/,"").replace(/\\|$/,"").split("|").map(e=>e.replace(/\\*\\*|__|`/g,"").trim()),cs=t=>t.toLowerCase().replace(/[^a-z0-9]/g,"");function ds(t,e=200){let n=ls(t.text).split(`\n`),r=[...t.results],s=(l,d)=>{let u=l.map(cs).join("|"),g=r.findIndex(f=>f.columns.map(m=>cs(m.name)).join("|")===u);return g<0&&(g=r.findIndex(f=>f.columns.length===l.length&&f.rows.length===d)),g<0?void 0:r.splice(g,1)[0]},o=[],i=0,a=/^\\s*\\|.*\\|\\s*$/;for(let l=0;l<n.length;l++){if(a.test(n[l]??"")&&/^\\s*\\|?\\s*:?-{2,}/.test(n[l+1]??"")){let d=as(n[l]??""),u=[];for(l+=2;l<n.length&&a.test(n[l]??"");l++)u.push(as(n[l]??"").map(f=>f||null));l--;let g=s(d,u.length)??ht(d.map(f=>({name:f})),u);o.push("",Xe(g,e),""),i++;continue}o.push(n[l]??"")}let c=o.join(`\n`).replace(/\\n{3,}/g,`\n\n`).trim();if(!i){let l=t.results[t.results.length-1];l?.columns.length&&(l.rows.length>1||!c)&&(c=[c,Xe(l,e)].filter(Boolean).join(`\n\n`),i++)}return i?Bi(c):c}var us=(t,e)=>new Promise((n,r)=>{if(e?.aborted){r(e.reason);return}let s=setTimeout(n,t);e?.addEventListener("abort",()=>{clearTimeout(s),r(e.reason)},{once:!0})}),Li=[2e3,4e3,8e3,15e3],On=/REQUEST_LIMIT_EXCEEDED|TOO_MANY_REQUESTS|rate[- ]?limit/i;function Cn(t){return Ct(t)&&(t.status===429||t.errorCode==="REQUEST_LIMIT_EXCEEDED"||t.errorCode==="TOO_MANY_REQUESTS")?!0:t instanceof Error&&On.test(t.message)}var Be=class extends Error{constructor(n,r){super(n);this.conversationId=r;this.name="RateLimited"}},Ni=t=>Math.round(t*(.8+Math.random()*.4));async function $n(t,e){for(let n=0;;n++)try{return await t()}catch(r){let s=Li[n];if(s===void 0||e.signal?.aborted||!(e.retryable??Cn)(r))throw r;let o=Ni(s);e.onRetry?.({attempt:n+1,waitMs:o,reason:r instanceof Error?r.message:String(r)}),await us(o,e.signal)}}var fs=2e4,Bt=class extends Error{};function Pi(t){return t instanceof Bt?`Genie One didn\'t answer within ${fs/1e3} seconds.`:Cn(t)?"Databricks is rate-limiting Genie One for your organization right now. Try again in a minute.":Ct(t)&&t.isNotFound?`Genie One isn\'t set up in this workspace. ${t.message}`:is(t)}var Fe=class{constructor(e){this.service=e}clients=new Map;checks=new Map;revision=0;listeners=new Set;checkRevision=()=>this.revision;subscribeChecks=e=>(this.listeners.add(e),()=>this.listeners.delete(e));async mcp(){let e=await this.service.ready(),n=this.service.snapshot(),r=n.status==="connected"?n.workspaceId??n.profile.workspaceId:void 0,s=`${e.host}|${r??""}`,o=this.clients.get(s);return o||(o=new ze(e,In(Ti),r?{o:r}:{}),this.clients.set(s,o)),o}checkKey(){let e=this.service.snapshot();return e.status==="connected"?e.profile.host:"none"}check(){let e=this.checkKey(),n=this.checks.get(e);return n||(n=this.listWithin(fs).then(r=>r.some(s=>s.name==="genie_ask")?{ok:!0}:{ok:!1,reason:"Genie One answered, but without its question tool (genie_ask)."}).catch(r=>({ok:!1,reason:Pi(r),...Cn(r)&&{busy:!0}})).then(r=>(!r.ok&&this.checks.get(e)===n&&this.checks.delete(e),r)),this.checks.set(e,n)),n}async available(){return(await this.check()).ok}recheck(){let e=this.checkKey();this.checks.delete(e);for(let n of[...this.clients.keys()])n.startsWith(`${e}|`)&&this.clients.delete(n);this.revision++;for(let n of[...this.listeners])n()}async listWithin(e){let n=new AbortController,r,s,o=new Promise((a,c)=>{s=setTimeout(()=>{n.abort(),c(r??new Bt)},e)}),i=this.mcp().then(a=>$n(()=>a.listTools(n.signal),{signal:n.signal,onRetry:c=>{r=new Be(c.reason)}}));try{return await Promise.race([i,o])}finally{clearTimeout(s),i.catch(()=>{})}}callTool(e,n,r,s){let{signal:o,timeoutMs:i,onRetry:a}=s;return $n(async()=>{let c=await e.callTool(n,r,{...o&&{signal:o},timeoutMs:i}),l=c.isError?Re(c):"";if(l&&On.test(l))throw new Be(l);return c},{...o&&{signal:o},...a&&{onRetry:c=>a({...c,restarted:!1})}})}async ask(e,n={}){let r=n.conversationId;return $n(async()=>{try{return await this.askOnce(e,{...n,...r&&{conversationId:r}})}catch(s){throw s instanceof Be&&s.conversationId&&(r=s.conversationId),s}},{...n.signal&&{signal:n.signal},retryable:s=>s instanceof Be&&s.conversationId!==void 0,...n.onRetry&&{onRetry:s=>n.onRetry?.({...s,restarted:!0})}})}async askOnce(e,n){let{signal:r,onRetry:s}=n,o=await this.mcp(),i=await this.callTool(o,"genie_ask",{question:e,...n.conversationId&&{conversation_id:n.conversationId}},{...r&&{signal:r},timeoutMs:17e4,...s&&{onRetry:s}});if(i.isError)throw new Error(Re(i)||"Genie One couldn\'t take the question.");let a=Ke(i)??{},c=a.conversation_id??n.conversationId??"",l=a.response_id??"";if(!c||!l)throw new Error("Genie One didn\'t return a conversation.");return n.onStarted?.({conversationId:c,responseId:l}),this.follow(o,c,l,a,Re(i),n)}async response(e,n,r={}){return this.follow(await this.mcp(),e,n,{},"",r)}async follow(e,n,r,s,o,i){let{signal:a,onRetry:c}=i,l={...a&&{signal:a},...c&&{onRetry:c}},d=s,u=o,g=0,f=[],m=Date.now()+10*6e4;try{for(;!d.status||d.status==="in_progress"||d.status==="unknown"&&g<5;){if(Date.now()>m)throw new Error("Genie One didn\'t finish within 10 minutes.");d.status&&await us(Ai,a);let b=await this.callTool(e,"genie_poll_response",{conversation_id:n,response_id:r},{...l,timeoutMs:6e4});if(b.isError)throw new Error(Re(b)||"Genie One failed.");d=Ke(b)??{status:"unknown"},u=Re(b),g=d.status==="unknown"?g+1:0,d.progress_steps?.length&&(f=d.progress_steps,i.onProgress?.(f))}}catch(b){throw a?.aborted&&e.callTool("genie_cancel_response",{conversation_id:n}).catch(()=>{}),b}if(d.status==="failed"){let b=u.trim()||"Genie One couldn\'t answer that.";throw On.test(b)?new Be(b,n):new Error(b)}let w=(d.query_items??[]).slice(0,Ii),E=(await Promise.all(w.map(b=>this.callTool(e,"genie_get_query_result",{conversation_id:n,response_id:r,item_id:b.item_id},{...a&&{signal:a},timeoutMs:6e4}).then(C=>C.isError?void 0:Oi(Ke(C)??{})).catch(()=>{})))).filter(b=>b!==void 0);return{conversationId:n,responseId:r,status:d.status??"completed",text:(d.final_answer??"").trim(),markdown:u.trim(),steps:f,results:E,sql:w.flatMap(b=>b.sql?[b.sql]:[]),...d.deep_link&&{deepLink:d.deep_link}}}format(e){let n=["Genie One",`conversation_id: ${e.conversationId}`];e.status==="incomplete"&&n.push("(Genie One stopped before finishing; the answer may be partial.)");let r=ls(e.text);if(r)n.push("",r);else for(let s of e.results)n.push("",mt(s,20));for(let s of e.sql.slice(0,2))n.push("","SQL Genie One ran:","```sql",s.trim(),"```");return e.deepLink&&n.push("",`[Explore in Databricks](${e.deepLink})`),n.join(`\n`)}};var We="/home/sandbox-agent";var Di=`${We}/.buzz/agent/runner.mjs`,Te="dbx",Bn=54,Ln=(t,e)=>["node",t,"mcp",e],Mi=`// Databricks tools for Pi, written by the Databricks Agents plugin for Buzz.\nimport { spawn } from "node:child_process";\nimport { createInterface } from "node:readline";\n\nexport default async function (pi) {\n  let command = [];\n  try {\n    command = JSON.parse(process.env.BUZZ_TOOLS_BRIDGE || "[]");\n  } catch {}\n  if (!command.length) return;\n  const child = spawn(command[0], command.slice(1), { stdio: ["pipe", "pipe", "inherit"] });\n  const pending = new Map();\n  let next = 1;\n  // The bridge keeps Pi running only while a request waits on it, so Pi can exit when it\'s done.\n  const hold = (on) => {\n    for (const handle of [child, child.stdin, child.stdout]) on ? handle.ref?.() : handle.unref?.();\n  };\n  const settle = () => pending.size || hold(false);\n  const fail = (error) => {\n    for (const waiting of pending.values()) waiting.reject(error);\n    pending.clear();\n    settle();\n  };\n  child.on("error", fail);\n  child.on("exit", () => fail(new Error("The Databricks tools stopped.")));\n  createInterface({ input: child.stdout }).on("line", (line) => {\n    let message;\n    try {\n      message = JSON.parse(line);\n    } catch {\n      return;\n    }\n    const waiting = pending.get(message.id);\n    if (!waiting) return;\n    pending.delete(message.id);\n    settle();\n    if (message.error) waiting.reject(new Error(message.error.message || "The tool failed."));\n    else waiting.resolve(message.result);\n  });\n  const send = (message) => child.stdin.write(JSON.stringify(message) + "\\\\n");\n  const request = (method, params, signal) =>\n    new Promise((resolve, reject) => {\n      const id = next++;\n      pending.set(id, { resolve, reject });\n      hold(true);\n      send({ jsonrpc: "2.0", id, method, params });\n      signal?.addEventListener(\n        "abort",\n        () => {\n          if (!pending.delete(id)) return;\n          settle();\n          send({ jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: id } });\n          reject(new Error("Stopped."));\n        },\n        { once: true },\n      );\n    });\n  const stop = () => child.kill();\n  pi.on("session_shutdown", stop);\n  process.on("exit", stop);\n  try {\n    await request("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "pi", version: "1" } });\n    send({ jsonrpc: "2.0", method: "notifications/initialized" });\n    const { tools = [] } = await request("tools/list", {});\n    for (const tool of tools)\n      pi.registerTool({\n        name: tool.name,\n        label: tool.title || tool.name,\n        description: tool.description || tool.name,\n        parameters: tool.inputSchema || { type: "object", properties: {} },\n        async execute(_id, params, signal) {\n          const result = await request("tools/call", { name: tool.name, arguments: params ?? {} }, signal);\n          const text = (result?.content ?? []).filter((part) => part.type === "text").map((part) => part.text).join("\\\\n") || JSON.stringify(result?.structuredContent ?? {});\n          if (result?.isError) throw new Error(text);\n          return { content: [{ type: "text", text }], details: {} };\n        },\n      });\n  } catch (error) {\n    console.error("Databricks tools unavailable: " + (error?.message ?? error));\n  }\n}\n`;function Nn(t,e,n,r){let s=[{path:e.tools,content:`${JSON.stringify(r)}\n`}],[o,...i]=Ln(n,e.tools);return t==="claude"&&s.push({path:e.mcp,content:`${JSON.stringify({mcpServers:{[Te]:{type:"stdio",command:o,args:i}}})}\n`}),t==="pi"&&s.push({path:e.piTools,content:Mi}),s}var Pn=t=>!!t?.length;var hs=[{id:"builtin",label:"Built-in",detail:"Fastest. Uses Buzz\'s tools and the tools you pick, and runs code in the Sandbox when it needs to."},{id:"claude",label:"Claude Code",detail:"Anthropic\'s coding agent, running in the Sandbox with its own tools and the Databricks CLI signed in as you. Keeps its context between turns."},{id:"codex",label:"Codex",detail:"OpenAI\'s coding agent, running in the Sandbox with its own tools and the Databricks CLI signed in as you. Keeps its context between turns."},{id:"pi",label:"Pi",detail:"A small coding agent for Claude, GPT and Gemini models, running in the Sandbox with its own tools. Keeps its context between turns."}],id=hs.map(t=>t.id);var Ne=t=>hs.find(e=>e.id===t)?.label??t;var ms=["To show a query result or other table, put it in a fenced code block with the language",`\\`${nn}\\` whose body is CSV with a header row (up to 200 rows; quote values that contain commas).`,"Buzz draws it as an interactive chart with a table view, so you can chart data; don\'t say you can\'t.","Put the label column (such as a date or category) first and the numeric columns after it, unformatted (no $ or thousands separators)."].join(" "),ad=`${We}/.buzz/runs`,Lt=`${We}/work`,ys=t=>({dir:t,prompt:`${t}/prompt.md`,system:`${t}/system.md`,events:`${t}/events.jsonl`,stderr:`${t}/stderr.log`,exit:`${t}/exit`,pid:`${t}/pid`,script:`${t}/run.sh`,tools:`${t}/tools.json`,mcp:`${t}/mcp.json`,piTools:`${t}/databricks-tools.mjs`}),Y=t=>`\'${t.replace(/\'/g,"\'\\\\\'\'")}\'`,Ui="read,grep,find,ls,edit,write";function bs(t){let{model:e,files:n,session:r,tools:s}=t,o=t.permissions==="full",i=s?Ln(s.runner,n.tools):void 0;switch(t.harness){case"claude":{if(!r)throw new Error("Claude Code needs a session ID.");return[...i?["MCP_TIMEOUT=120000","MCP_TOOL_TIMEOUT=600000"]:[],"claude","-p","--model",Y(e),"--output-format","stream-json","--verbose","--permission-mode",o?"bypassPermissions":"auto",...i?["--mcp-config",Y(n.mcp),"--strict-mcp-config",...o?[]:["--allowedTools",`mcp__${Te}`]]:[],"--append-system-prompt-file",Y(n.system),r.resume?"--resume":"--session-id",Y(r.id),"<",Y(n.prompt)].join(" ")}case"codex":return["codex","exec",...r?["resume",Y(r.id)]:[],"--json","--skip-git-repo-check","-m",Y(e),...o?["--dangerously-bypass-approvals-and-sandbox"]:["-c",Y(\'sandbox_mode="workspace-write"\'),"-c","sandbox_workspace_write.network_access=true"],...i?["-c",Y(`mcp_servers.${Te}.command=${JSON.stringify(i[0])}`),"-c",Y(`mcp_servers.${Te}.args=${JSON.stringify(i.slice(1))}`),"-c",`mcp_servers.${Te}.startup_timeout_sec=120`,"-c",`mcp_servers.${Te}.tool_timeout_sec=600`,"-c",Y(`mcp_servers.${Te}.default_tools_approval_mode="approve"`)]:[],"-","<",Y(n.prompt)].join(" ");case"pi":{if(!r)throw new Error("Pi needs a session ID.");let a=i?`$(${[...i.slice(0,2),"mcp-names",n.tools].map(Y).join(" ")} 2>/dev/null)`:"";return[...i?[`BUZZ_TOOLS_BRIDGE=${Y(JSON.stringify(i))}`]:[],"pi","-p","--mode","json","--model",Y(e),"--session-id",Y(r.id),"--append-system-prompt",Y(n.system),...i?["-e",Y(n.piTools)]:[],...o?[]:["--tools",`"${Ui}${a}"`],Y(`@${n.prompt}`),"<","/dev/null"].join(" ")}}}var Hi=["command","cmd","file_path","path","pattern","query","question","statement","url","description","prompt"];function Le(t){if(!(!t||typeof t!="object"))for(let e of Hi){let n=t[e];if(typeof n=="string"&&n.trim())return n.length>80?`${n.slice(0,77)}\\u2026`:n}}var qi=t=>{let e=/^\\/bin\\/(?:ba)?sh -lc ([\'"])([\\s\\S]*)\\1$/.exec(t);return e?e[1]===\'"\'?e[2].replace(/\\\\(["\\\\$`])/g,"$1"):e[2]:t},ps=t=>Array.isArray(t)?t.filter(e=>!!e&&typeof e=="object"&&e.type==="thinking"&&typeof e.thinking=="string").map(e=>e.thinking.trim()).filter(Boolean).join(`\n\n`):"",gs=t=>Array.isArray(t)?t.filter(e=>!!e&&typeof e=="object"&&e.type==="text"&&typeof e.text=="string").map(e=>e.text).join(""):typeof t=="string"?t:"";function ws(t,e){let n;try{n=JSON.parse(e)}catch{return}if(!(!n||typeof n!="object")){if(t==="claude"){if(n.type==="system"&&n.subtype==="init"&&typeof n.session_id=="string")return{session:n.session_id};if(n.type==="system"&&n.subtype==="api_retry")return{step:{tool:"model",target:`retrying after ${n.error_status??"an error"}${n.error?` (${n.error})`:""}`}};if(n.type==="assistant"&&Array.isArray(n.message?.content)){let r=ps(n.message.content),s=n.message.content.find(i=>i?.type==="tool_use");if(s)return{...r&&{thought:r},step:{tool:String(s.name??"tool"),...Le(s.input)&&{target:Le(s.input)}}};let o=gs(n.message.content);return o||r?{...o&&{text:o},...r&&{thought:r}}:void 0}if(n.type==="result"){let r=typeof n.result=="string"?n.result:"";return n.is_error||n.subtype&&n.subtype!=="success"?{error:r||String(n.subtype??"Claude Code failed")}:{final:r}}return}if(t==="codex"){if(n.type==="thread.started"&&typeof n.thread_id=="string")return{session:n.thread_id};if(n.type==="turn.failed")return{error:String(n.error?.message??"Codex failed")};let r=n.item;return!r||typeof r!="object"?void 0:n.type==="item.started"?r.type==="command_execution"&&typeof r.command=="string"?{step:{tool:"shell",target:Le({command:qi(r.command)})}}:r.type==="file_change"?{step:{tool:"edit",...r.changes?.[0]?.path&&{target:String(r.changes[0].path)}}}:r.type==="mcp_tool_call"?{step:{tool:String(r.tool??"tool"),...Le(r.arguments)&&{target:Le(r.arguments)}}}:r.type==="web_search"?{step:{tool:"web search",...r.query&&{target:String(r.query)}}}:void 0:n.type==="item.completed"&&r.type==="agent_message"&&typeof r.text=="string"?{text:r.text}:n.type==="item.completed"&&r.type==="reasoning"&&typeof r.text=="string"&&r.text.trim()?{thought:r.text}:void 0}if(n.type==="session"&&typeof n.id=="string")return{session:n.id};if(n.type==="tool_execution_start")return{step:{tool:String(n.toolName??"tool"),...Le(n.args)&&{target:Le(n.args)}}};if(n.type==="message_end"&&n.message?.role==="assistant"){if(n.message.stopReason==="error"&&n.message.errorMessage)return{error:String(n.message.errorMessage)};let r=gs(n.message.content),s=ps(n.message.content);return r||s?{...r&&{text:r},...s&&{thought:s}}:void 0}}}var Gi=t=>t.replace(/\\x1b\\[[0-9;]*[A-Za-z]/g,"").replace(/[\u2502\u256D\u256E\u2570\u256F\u2500\u2714\u2022]/g,"").trim();function Dn(t){return Gi(t).split(`\n`).map(e=>e.trim()).filter(e=>e&&!/Unity Gateway|Databricks auth already|Launching |Starting |managed coding agent config|token refresh is managed|^is running\\.?$/i.test(e)).slice(-4).join(" ").slice(0,600)}function xs(t,e,n=[]){return["<databricks-sandbox>",`You are running as ${Ne(t)} inside your own Databricks Sandbox, a Linux machine in Databricks with Python, Node.js, git, the Databricks CLI (already signed in as your owner) and internet access. Your working folder is ${Lt}; files under ${We} persist across restarts.`,"Your final message is posted to the Buzz conversation as your reply, so make it the answer itself, written for the people there. You don\'t have Buzz\'s own tools in this session.",t==="pi"&&e==="standard"?"You can read, search and edit files, but you have no shell in this session.":"",n.length?`Your owner gave you these Databricks tools, which run with their access: ${n.map(r=>r.label).join(", ")}. Use them for questions about data (Genie One finds the right tables and runs the SQL). If a tool says your owner hasn\'t logged in yet, give them its login link.`:"","Never print secrets into the conversation.","</databricks-sandbox>"].filter(Boolean).join(`\n`)}var ji=new Set(["Bash","Read","Write","Edit","MultiEdit","NotebookEdit","Grep","Glob","ListFiles","WebFetch","WebSearch","Task","Agent","TodoWrite","send","send_message","read"]),Es={shell:"Bash",bash:"Bash",exec_command:"Bash",sandbox_exec:"Bash",read_file:"Read",sandbox_read_file:"Read",write:"Write",write_file:"Write",sandbox_write_file:"Write",edit:"Edit",apply_patch:"Edit",grep:"Grep",find:"Glob",glob:"Glob",ls:"ListFiles",sandbox_list:"ListFiles","web search":"WebSearch",web_search:"WebSearch",fetch:"WebFetch",web_fetch:"WebFetch",update_plan:"TodoWrite"},zi={genie_one_ask:"Asking Genie One",databricks_genie_one_ask:"Asking Genie One",databricks_genie_ask:"Asking Genie",databricks_genie_list:"Listing Genie agents",databricks_sql_query:"Running SQL",databricks_sql_warehouses:"Finding a SQL warehouse",databricks_catalog_list:"Browsing the catalog",databricks_table_describe:"Reading a table",model:"Waiting for the model"},Ki={"Creating sandbox":"Creating its Sandbox","Starting sandbox":"Starting its Sandbox","Waiting for sandbox to stop":"Waiting for its Sandbox"},lt=t=>t.replace(/[_-]+/g," ").replace(/\\s+/g," ").trim();function be(t,e=100){let n=t.replace(/\\s+/g," ").trim();return n.length>e?`${n.slice(0,e-1).trimEnd()}\\u2026`:n}function dt(t,e,n){let r=(l,d=e)=>d?{tool:l,target:be(d,120)}:{tool:l},s=t.replace(/^mcp__[a-zA-Z0-9_-]+?__/,"");if(ji.has(s))return r(s);let o=Es[s]??Es[s.toLowerCase()];if(o)return r(o);if(s==="sandbox")return{tool:Ki[e??""]??"Starting its Sandbox"};if(s==="databricks_sql_query")return r("Running SQL",e?.split(`\n`).find(l=>l.trim()));let i=zi[s];if(i)return r(i);let a=n?.get(s);if(/^genie_.+_ask$/.test(s))return r(`Asking ${a??`Genie (${lt(s.slice(6,-4))})`}`);let c=/^(.+?)__(.+)$/.exec(s);if(c){let l=n?.get(c[1])??lt(c[1]);return c[2]==="log_in"?{tool:`Checking the ${l} login`}:c[2]==="unavailable"?{tool:`${l} isn\'t available`}:r(`Using ${l}`,[lt(c[2]),e].filter(Boolean).join(": "))}return r(lt(s)||"Working")}function Ss(t){let n=/^\\s*\\*\\*(.+?)\\*\\*/.exec(t)?.[1]??t.split(`\n`).find(r=>r.trim())??"";return n.trim()?{tool:"Thinking",target:be(n,110)}:{tool:"Thinking"}}var vs=t=>t.trim()?{tool:"Genie One",target:be(t,120)}:{tool:"Asking Genie One"},ks=t=>({tool:"Rate-limited",target:`${t.restarted?"asking Genie One again":"trying again"} in ${Math.max(1,Math.round(t.waitMs/1e3))} s (retry ${t.attempt})`});function _s(t,e){let n={SUBMITTED:"sent the question",FILTERING_CONTEXT:"finding the right data",FETCHING_METADATA:"reading the tables",ASKING_AI:"writing the SQL",PENDING_WAREHOUSE:"waiting for the SQL warehouse",EXECUTING_QUERY:"running the query",COMPLETED:"answered"};return{tool:`Asking ${t}`,target:n[e]??lt(e.toLowerCase())}}function Mn(t){let e=t.target;return e?{Bash:`Running ${e}`,Read:`Reading ${e}`,Write:`Writing ${e}`,Edit:`Editing ${e}`,MultiEdit:`Editing ${e}`,Grep:`Searching for ${e}`,Glob:`Finding ${e}`,ListFiles:`Listing ${e}`,WebFetch:`Reading ${e}`,WebSearch:`Searching the web for ${e}`}[t.tool]??`${t.tool} \\xB7 ${e}`:{Bash:"Running a command",Read:"Reading a file",Write:"Writing a file",Edit:"Editing a file",Grep:"Searching files",Glob:"Finding files",ListFiles:"Listing files",WebSearch:"Searching the web",TodoWrite:"Updating its plan",send:"Sending a message",send_message:"Sending a message",read:"Reading the conversation"}[t.tool]??t.tool}function Rs(t){let e={Bash:"execute",Read:"read",Write:"edit",Edit:"edit",MultiEdit:"edit",Grep:"search",Glob:"search",ListFiles:"search",WebFetch:"fetch",WebSearch:"fetch",Thinking:"think"};return e[t.tool]?e[t.tool]:/^(Asking|Running SQL|Reading a table|Browsing|Listing|Genie One)/.test(t.tool)?"search":"other"}var Fi="/api/2.0/omnigent",Wi="X-Databricks-Omnigent-Slice-Key",Ts=2500,Vi=8*6e4,Zi=3*6e4,Yi=3e4,Xi=3,$s="claude-native-ui",Hn={"claude-native-ui":{label:"Claude Code",detail:"Claude Code, with models from AI Gateway."},"codex-native-ui":{label:"Codex",detail:"OpenAI\'s Codex, with models from AI Gateway."},"pi-native-ui":{label:"Pi",detail:"The Pi coding agent, with models from AI Gateway."},polly:{label:"Polly",detail:"Hands larger coding tasks to other coding agents, with an independent reviewer checking their work."},debby:{label:"Debby",detail:"A brainstorming partner that answers with Claude\'s and GPT\'s views side by side."}},Ji=new Set(["claude-native","codex-native","pi-native","claude-sdk","codex","pi"]),Nt=t=>Hn[t]?.label??t.replace(/-native-ui$/,"").replace(/[-_]+/g," ");function Qi(t){let e;try{let r=JSON.parse(t.body);typeof r.detail=="string"&&(e=r.detail)}catch{}let n=je(t);return e&&(n.message=e),n}var Un=t=>(t??[]).map(e=>typeof e.text=="string"?e.text:"").filter(e=>e.trim()).join(`\n\n`);function As(t,e={}){let r=((...o)=>{for(let i of o){let a=e[i];if(typeof a=="string"&&a.trim())return a}})("command","file_path","path","pattern","query","url","title","description","prompt");return dt({sys_os_shell:"Bash",shell:"Bash",exec_command:"Bash",sys_session_send:"Handing off to another agent",sys_read_inbox:"Checking on other agents",browser_navigate:"Opening a web page"}[t]??t,r)}function ea(t){if(t.type==="function_call"&&t.name){let e={};try{e=t.arguments?JSON.parse(t.arguments):{}}catch{}return As(t.name,e)}if(t.type==="native_tool"&&t.item){let e=t.item,n=[e.name,e.tool_name,e.tool,e.type].find(o=>typeof o=="string"&&!!o),r=e.input??e.arguments??e.args;return n?As(n,typeof r=="object"&&r?r:typeof r=="string"?{command:r}:{}):void 0}if(t.type==="terminal_command"&&t.input)return dt("Bash",t.input)}var Is=(t,e)=>new Promise((n,r)=>{if(e.aborted)return r(e.reason);let s=setTimeout(()=>{e.removeEventListener("abort",o),n()},t),o=()=>{clearTimeout(s),r(e.reason)};e.addEventListener("abort",o,{once:!0})}),Pt=class{constructor(e,n){this.client=e;this.workspaceId=n}hosts=new Map;webUrl(e){let n=new URL(`${this.client.host}/omnigent${e?`/c/${encodeURIComponent(e)}`:""}`);return this.workspaceId&&n.searchParams.set("o",this.workspaceId),n.toString()}async call(e,n,r={}){let s=r.session?this.hosts.get(r.session):void 0,o=a=>this.client.request(`${Fi}${n}`,{method:e,...r.body!==void 0&&{body:r.body},headers:{...this.workspaceId&&{"X-Databricks-Org-Id":this.workspaceId},...a&&s&&{[Wi]:s}},timeoutMs:6e4,...r.signal&&{signal:r.signal}}),i=await o(!0);if(i.status===400&&s&&/wrong_replica/.test(i.body)&&(i=await o(!1)),i.status<200||i.status>=300)throw Qi(i);return i.body.trim()?JSON.parse(i.body):{}}async check(e){try{return(await this.call("GET","/v1/info",{...e&&{signal:e}})).managed_sandboxes_enabled===!1?{ok:!1,reason:"Omnigent is on in this workspace, but not with Databricks Sandbox sessions, which hosted agents use."}:{ok:!0}}catch(n){let r=n.status;return r===404?{ok:!1,reason:"Omnigent isn\'t on in this workspace. A workspace admin can turn on the Omnigent preview."}:r===401||r===403?{ok:!1,reason:"Omnigent turned this account away; it may not be enabled for you."}:{ok:!1,reason:n.message}}}async agents(e){let n=await this.call("GET","/v1/agents?limit=200",{...e&&{signal:e}}),r=Object.keys(Hn);return(n.data??[]).filter(s=>Ji.has(s.harness??"")).map(s=>{let i=Hn[s.name]?.detail??s.description??void 0;return{id:s.id,name:s.name,harness:s.harness??"",label:Nt(s.name),...i&&{detail:i}}}).sort((s,o)=>(r.indexOf(s.name)+1||99)-(r.indexOf(o.name)+1||99)||s.label.localeCompare(o.label))}async create(e,n,r){let s=(await this.agents(r)).find(a=>a.name===e);if(!s)throw new Error(`This workspace\'s Omnigent has no agent named ${e} that runs in a Databricks Sandbox.`);let o=await this.call("POST","/v1/sessions",{body:{agent_id:s.id,host_type:"managed",title:n.slice(0,120)},...r&&{signal:r}}),i=o.id??o.session_id;if(!i)throw new Error("Omnigent didn\'t return the new session.");return i}async session(e,n){let r=await this.call("GET",`/v1/sessions/${encodeURIComponent(e)}`,{session:e,...n&&{signal:n}});return r.host_id&&this.hosts.set(e,r.host_id),r}async send(e,n,r){return(await this.call("POST",`/v1/sessions/${encodeURIComponent(e)}/events`,{session:e,body:{type:"message",data:{role:"user",content:[{type:"input_text",text:n}]}},...r&&{signal:r}})).item_id}async interrupt(e,n){await this.call("POST",`/v1/sessions/${encodeURIComponent(e)}/events`,{session:e,body:{type:"interrupt",data:{}},...n&&{signal:n}})}async items(e,n,r){let s=[],o=n;for(let i=0;i<20;i++){let a=new URLSearchParams({limit:"100",order:"asc",...o&&{after:o}}),c=await this.call("GET",`/v1/sessions/${encodeURIComponent(e)}/items?${a}`,{session:e,...r&&{signal:r}});if(s.push(...c.data??[]),!c.has_more||!c.last_id)break;o=c.last_id}return s}async newest(e,n){return(await this.call("GET",`/v1/sessions/${encodeURIComponent(e)}/items?limit=1&order=desc`,{session:e,...n&&{signal:n}})).data?.[0]?.id}async ready(e,n,r,s){let o=Date.now()+Vi,i="";for(;;){let a=await this.session(e,r),c=a.sandbox_status;if(c?.stage==="failed"||a.status==="failed")throw new Error(`Omnigent couldn\'t start the session\'s Sandbox${c?.error?`: ${c.error}`:"."}`);if(!(c&&c.stage!=="ready")&&(a.runner_online===!0||!n&&a.host_resumable!==!1))return;if(c&&c.stage!==i&&(i=c.stage,s?.({tool:"Starting its Omnigent Sandbox",target:c.stage})),Date.now()>o)throw new Error("Omnigent\'s Sandbox for this session didn\'t start in time.");await Is(Ts,r)}}async turn(e){let{signal:n,onStep:r,onThought:s}=e,o=e.session,i=!1;if(o)try{await this.session(o,n)}catch(d){if(d.status!==404)throw d;o=void 0}o||(r?.({tool:"Starting an Omnigent session",target:Nt(e.agent)}),o=await this.create(e.agent,e.title,n),i=!0,e.onSession?.(o)),await this.ready(o,i,n,r);let a=i?void 0:await this.newest(o,n),c=await this.send(o,e.text(i),n),l=o;try{return await this.follow(l,c??a,i,n,r,s)}catch(d){throw n.aborted&&await this.interrupt(l).catch(()=>{}),d}}async follow(e,n,r,s,o,i){let a=n,c=!1,l="",d,u=0,g,f=Date.now();for(;;){await Is(Ts,s);let m=await this.session(e,s),w=await this.items(e,a,s);for(let b of w){if(a=b.id,b.type==="message"&&b.role==="user")continue;if(c=!0,b.type==="message"&&b.role==="assistant"){let P=Un(b.content);if(!P)continue;l&&i?.(l),l=P;continue}if(b.type==="reasoning"){let P=Un(b.summary)||Un(b.content);P&&i?.(P);continue}if(b.type==="error"){d=[b.title,b.message].filter(Boolean).join(": ")||"Omnigent reported an error.";continue}let C=ea(b);C&&o?.(C)}let E=n?m.failed_inputs?.find(b=>b.id===n||b.item_id===n):void 0;if(E)throw new Error(`Omnigent couldn\'t take the message${typeof E.error=="string"?`: ${E.error}`:"."}`);if(m.status==="failed")throw new Error(d??ta(m.last_task_error)??"The Omnigent session failed.");if(m.status==="running"&&(c=!0,u=0),m.pending_elicitations?.length){if(g??=Date.now(),Date.now()-g>Yi){let b=`It\'s waiting for your approval in Omnigent before it goes on: [open the session](${this.webUrl(e)}).`;return{session:e,text:l?`${l}\n\n${b}`:b,fresh:r,waiting:!0}}continue}if(g=void 0,m.status==="idle"){if(!c){if(Date.now()-f>Zi)throw new Error("Omnigent accepted the message but didn\'t start working on it.");continue}if(l||++u>=Xi){if(!l&&d)throw new Error(d);return{session:e,text:l||"_It finished without a reply._",fresh:r,waiting:!1}}}}}};function ta(t){if(!t)return;let e=t.message??t.detail??t.error;return typeof e=="string"&&e?be(e,400):void 0}var Ve=[9,40002],na="buzz.solo",ra=48e3,Bs=/^[0-9a-f]{64}$/,sa=/^[0-9a-f]{128}$/,oa=/^(kind=|created_at<|created_at>)(0|[1-9][0-9]*)$/,ia=(t,e)=>t.tags.find(n=>n[0]===e)?.[1],aa=t=>{let e=ia(t,"h");return e&&/^[a-zA-Z0-9_-]{1,128}$/.test(e)?e:void 0};function ca(t){let e,n;for(let r of t.tags)r[0]!=="e"||!Bs.test(r[1]??"")||(r[3]==="root"?e=r[1]:r[3]==="reply"&&(n=r[1]));return e??n}var Ls=(t,e)=>Ve.includes(t.kind)&&t.pubkey!==e&&t.tags.some(n=>n[0]==="p"&&n[1]===e);function la(t){let e=t.tags.filter(a=>a[0]==="auth");if(e.length!==1)return;let[,n="",r="",s=""]=e[0];if(e[0].length!==4||!Bs.test(n)||!sa.test(s)||n===t.pubkey)return;let o=r?r.split("&"):[];if(!o.every(a=>oa.test(a)))return;for(let a of o){let c=Number(a.replace(/^[^0-9]+/,""));if(a.startsWith("kind=")&&t.kind!==c||a.startsWith("created_at<")&&!(t.created_at<c)||a.startsWith("created_at>")&&!(t.created_at>c))return}let i=ce(new TextEncoder().encode(`nostr:agent-auth:${t.pubkey}:${r}`));try{return _e.verify(Buffer.from(s,"hex"),i,Buffer.from(n,"hex"))?n:void 0}catch{return}}var Ns=(t,e)=>t.pubkey===e||la(t)===e;function Ps(t){if(!t)return{solo:!1};let[e,...n]=t.tags.flatMap(r=>r[0]==="t"&&typeof r[1]=="string"?[r[1]]:[]);return{...e&&{type:e},solo:e==="stream"&&n.includes(na)}}function qn(t,e,n){let r=aa(t);if(!r)return;let s=ca(t),o=s??t.id,i=n.type==="dm",a=n.solo,c=a||i||e==="channel";return{key:c?r:`${r}/${o}`,channel:r,root:o,topLevel:a,dm:i,fresh:!s&&!c}}function Ds(t){return t.fresh?[]:!t.topLevel&&!t.dm&&t.key!==t.channel?[{ids:[t.root],"#h":[t.channel],limit:1},{kinds:Ve,"#h":[t.channel],"#e":[t.root],limit:200}]:[{kinds:Ve,"#h":[t.channel],limit:13}]}var Os=t=>JSON.stringify(t).replace(/</g,"\\\\u003c").replace(/>/g,"\\\\u003e").replace(/&/g,"\\\\u0026"),Cs=(t,e)=>({id:t.id,pubkey:t.pubkey,...e.get(t.pubkey)&&{author:e.get(t.pubkey)},time:new Date(t.created_at*1e3).toISOString(),content:t.content});function Ms(t){let{event:e,conversation:n,names:r}=t,s=n.dm?"dm":n.key===n.channel?"channel":"thread",o=[`Scope: ${s}`,`Session scope: ${t.scope==="channel"||n.key===n.channel?"channel":"thread"} conversation`,`Channel: #${n.channel}`,...s==="thread"?[`Thread root: ${n.root}`]:[],`Agent: ${t.agent}`,"Your final message is posted as your reply in this conversation."].join(`\n`),i=s==="thread"?"thread-context":"conversation-context",a=[`<context>\n${o}\n</context>`];t.context.length&&a.push(`<${i} included="${t.context.length}" total="${t.total}" truncated="${t.total>t.context.length}">\n${Os(t.context.map(l=>Cs(l,r)))}\n</${i}>`);let c=e.tags.filter(l=>l[0]==="p").map(l=>l[1]);return a.push(`<buzz-event type="@mention">\n${Os({...Cs(e,r),channel:n.channel,kind:e.kind,...n.root!==e.id&&{thread:n.root},...c.length&&{mentions:c}})}\n</buzz-event>`),a.join(`\n\n`)}var Dt=t=>t.replace(/\\[([^\\]]*)\\]\\(nostr:[^)]+\\)/g,"").replace(/nostr:(npub|nprofile|note|nevent)1[0-9a-z]+/g,"").replace(/^\\s*@\\S+\\s*/,"").replace(/[ \\t]+/g," ").trim();function Us(t,e=ra){let n=o=>Buffer.byteLength(o);if(n(t)<=e)return[t];let r=[],s=t;for(;n(s)>e;){let o=e;for(;n(s.slice(0,o))>e;)o=Math.floor(o*.9);let i=s.slice(0,o),a=Math.max(i.lastIndexOf(`\n\n`),i.lastIndexOf(`\n`)),c=a>o/2?a:o;r.push(s.slice(0,c).trimEnd()),s=s.slice(c).trimStart()}return s&&r.push(s),r}function Hs(t){return{kind:9,created_at:Math.floor(Date.now()/1e3),content:t.content,tags:[["h",t.conversation.channel],...t.conversation.topLevel?[]:[["e",t.conversation.root,"","reply"]],...(typeof t.notify=="string"?[t.notify]:t.notify??[]).map(e=>["p",e]),[...t.authTag]]}}function Gn(t){return{kind:0,created_at:Math.floor(Date.now()/1e3),content:JSON.stringify({name:t.name,display_name:t.name,bot:!0,...t.picture&&{picture:t.picture},...t.about&&{about:t.about}}),tags:[[...t.authTag]]}}var qs="Hi! I only take requests from the person who set me up, since I work with their Databricks access, so I can\'t help with this one. I\'ve let them know you asked.",Mt=class{constructor(e=36e5,n=()=>Date.now()){this.quietMs=e;this.now=n}told=new Map;take(e,n,r){let s=this.now(),o=`${e}|${n}|${r}`,i=this.told.get(o);if(i!==void 0&&s-i<this.quietMs)return!1;if(this.told.set(o,s),this.told.size>1e3)for(let[a,c]of this.told)s-c>=this.quietMs&&this.told.delete(a);return!0}};var Gs=t=>`/mcp-service-login?name=${encodeURIComponent(t)}`,js=t=>/HTTP 401|requires authentication|not logged in|login first|Credential for user identity/i.test(t?.message??String(t));function ut(t){return((t.label||t.id).toLowerCase().replace(/[^a-z0-9]+/g,"_").replace(/^_+|_+$/g,"")||"mcp").slice(0,20).replace(/_+$/,"")}var da="Note: these results came from the owner\'s Databricks access. Everyone in this conversation can read what you post, so share only what this audience should see.";function zs(t,e,n,r){let s=[`Genie agent: ${t.title} (${t.space_id})`,`conversation_id: ${e.message.conversation_id}`,`status: ${e.message.status}`];return e.error&&s.push(`error: ${e.error}`),e.text&&s.push("",e.text),e.result?s.push("",mt(e.result,r)):e.rowCount!==void 0&&s.push("",`(The query returned ${e.rowCount} rows; the result could not be fetched.)`),e.sql&&s.push("","SQL:","```sql",e.sql.trim(),"```"),e.suggestions.length&&s.push("",`Follow-ups Genie suggests: ${e.suggestions.slice(0,3).join(" | ")}`),n&&s.push("",`Open in Genie: ${n}`),s.push("",da),s.join(`\n`)}var ua=/^[a-zA-Z0-9_-]{1,64}$/;function Fs(t){return Array.isArray(t)?t.flatMap(e=>{let n=e;return typeof n?.id!="string"||typeof n.label!="string"||typeof n.kind!="string"?[]:["service","connection","functions"].includes(n.kind)&&!(typeof n.path=="string"&&n.path.startsWith("/"))?[]:[{id:n.id,kind:n.kind,label:n.label,...n.path&&{path:n.path}}]}):[]}var Ks=(t,e)=>(t.toLowerCase().replace(/[^a-z0-9]+/g,"_").replace(/^_+|_+$/g,"")||"x").slice(0,e).replace(/_+$/,""),fa=t=>{let e=t.snapshot();return e.status==="connected"?e.workspaceId??e.profile.workspaceId:void 0};function pa(t,e){let n=new AbortController,r=setTimeout(()=>n.abort(new Error(`No answer within ${e/1e3} seconds`)),e),s=()=>n.abort(t.reason);return t.aborted?s():t.addEventListener("abort",s,{once:!0}),n.signal.addEventListener("abort",()=>clearTimeout(r),{once:!0}),n.signal}function Ws(t){let e=new Map,n=new Set;for(let r of t)r.kind==="genie"?e.set(Vs(r.label,n),r.label):r.path&&e.set(ut(r),r.label);return e}function Vs(t,e){let n=`genie_${Ks(t,40)}_ask`;for(let r=2;e.has(n);r++)n=`genie_${Ks(t,36)}_${r}_ask`;return e.add(n),n}function Zs(t,e){let n=[],r=new Set;for(let s of e)if(s.kind==="genie-one"){let o=new Fe(t);n.push({name:"genie_one_ask",description:"Asks Genie One, Databricks\' assistant for questions about any data the owner can access in this agent\'s workspace. It finds the tables, writes and runs the SQL, and answers with numbers, a table and a link. Pass conversation_id from an earlier answer to follow up. Answers can take a minute.",parameters:{type:"object",properties:{question:{type:"string",description:"The question, in plain language."},conversation_id:{type:"string"}},required:["question"]},run:async(i,a)=>{let c=typeof i.conversation_id=="string"&&i.conversation_id?i.conversation_id:void 0;return o.format(await o.ask(String(i.question??""),{signal:a,...c&&{conversationId:c}}))}})}else if(s.kind==="genie"){let o=s.id.replace(/^genie:/,""),i=Vs(s.label,r);n.push({name:i,description:`Asks the "${s.label}" Genie agent, curated by the owner\'s data team, a question about its data. It answers with an explanation, a table and the SQL. Pass conversation_id to follow up.`,parameters:{type:"object",properties:{question:{type:"string",description:"The question, in plain language."},conversation_id:{type:"string"}},required:["question"]},run:async(a,c)=>{let l=await t.ready(c),d=typeof a.conversation_id=="string"&&a.conversation_id?a.conversation_id:void 0,u=await new fe(l).answer(o,String(a.question??""),{signal:c,...d&&{conversationId:d}});return zs({title:s.label,space_id:o},u,t.workspaceUrl(fe.webPath(o,u.message.conversation_id)),30)}})}return n}async function Ys(t,e,n){let r=e.filter(u=>u.path);if(!r.length)return{tools:[],problems:[],failures:[]};let s=await t.ready(n),o=fa(t),i=[],a=[],c=await Promise.all(r.map(async u=>{let g=u.path.startsWith("/ai-gateway/")&&o?{o}:{},f=new ze(s,u.path,g);try{let m=await f.listTools(pa(n,3e4));return{server:u,mcp:f,tools:m}}catch(m){let w=u.kind==="service"&&js(m)?t.workspaceUrl(Gs(u.id.replace(/^service:/,""))):void 0;return a.push({server:u,message:m.message??String(m),...w&&{login:w}}),i.push(w?`${u.label}: your owner isn\'t logged in to ${u.label} yet. Ask them to log in at ${w}, then try again`:`${u.label}: ${m.message??m}`),{server:u,mcp:f,tools:[]}}})),l=[],d=new Set;for(let{server:u,mcp:g,tools:f}of c){let m=ut(u);for(let w of f){let E=`${m}__${w.name}`.replace(/[^a-zA-Z0-9_-]/g,"_").slice(0,64);for(let b=2;d.has(E);b++)E=`${E.slice(0,60)}_${b}`;ua.test(E)&&(d.add(E),l.push({name:E,description:`[${u.label}] ${w.description??w.title??w.name}`.slice(0,4e3),parameters:w.inputSchema??{type:"object",properties:{}},run:async(b,C)=>{let P=await g.callTool(w.name,b,{signal:C,timeoutMs:17e4}),F=Re(P)||(P.structuredContent!==void 0?JSON.stringify(Ke(P)):"OK");return P.isError?`Error from ${u.label}: ${F}`:F}}))}}return{tools:l,problems:i,failures:a}}import{appendFileSync as za,existsSync as Ka,readFileSync as Fa,statSync as Wa,writeFileSync as Va}from"node:fs";function ga(t){return t instanceof Uint8Array||ArrayBuffer.isView(t)&&t.constructor.name==="Uint8Array"}function Ut(t){if(typeof t!="boolean")throw new Error(`boolean expected, not ${t}`)}function Ht(t){if(!Number.isSafeInteger(t)||t<0)throw new Error("positive integer expected, got "+t)}function X(t,e,n=""){let r=ga(t),s=t?.length,o=e!==void 0;if(!r||o&&s!==e){let i=n&&`"${n}" `,a=o?` of length ${e}`:"",c=r?`length=${s}`:`type=${typeof t}`;throw new Error(i+"expected Uint8Array"+a+", got "+c)}return t}function jn(t,e=!0){if(t.destroyed)throw new Error("Hash instance has been destroyed");if(e&&t.finished)throw new Error("Hash#digest() has already been called")}function Xs(t,e){X(t,void 0,"output");let n=e.outputLen;if(t.length<n)throw new Error("digestInto() expects output buffer of length at least "+n)}function we(t){return new Uint32Array(t.buffer,t.byteOffset,Math.floor(t.byteLength/4))}function xe(...t){for(let e=0;e<t.length;e++)t[e].fill(0)}function ha(t){return new DataView(t.buffer,t.byteOffset,t.byteLength)}var ma=new Uint8Array(new Uint32Array([287454020]).buffer)[0]===68;function Js(t,e){if(e==null||typeof e!="object")throw new Error("options must be defined");return Object.assign(t,e)}function Qs(t,e){if(t.length!==e.length)return!1;let n=0;for(let r=0;r<t.length;r++)n|=t[r]^e[r];return n===0}var zn=(t,e)=>{function n(r,...s){if(X(r,void 0,"key"),!ma)throw new Error("Non little-endian hardware is not yet supported");if(t.nonceLength!==void 0){let d=s[0];X(d,t.varSizeNonce?void 0:t.nonceLength,"nonce")}let o=t.tagLength;o&&s[1]!==void 0&&X(s[1],void 0,"AAD");let i=e(r,...s),a=(d,u)=>{if(u!==void 0){if(d!==2)throw new Error("cipher output not supported");X(u,void 0,"output")}},c=!1;return{encrypt(d,u){if(c)throw new Error("cannot encrypt() twice with same key + nonce");return c=!0,X(d),a(i.encrypt.length,u),i.encrypt(d,u)},decrypt(d,u){if(X(d),o&&d.length<o)throw new Error(\'"ciphertext" expected length bigger than tagLength=\'+o);return a(i.decrypt.length,u),i.decrypt(d,u)}}}return Object.assign(n,t),n};function Kn(t,e,n=!0){if(e===void 0)return new Uint8Array(t);if(e.length!==t)throw new Error(\'"output" expected Uint8Array of length \'+t+", got: "+e.length);if(n&&!ya(e))throw new Error("invalid output, must be aligned");return e}function eo(t,e,n){Ut(n);let r=new Uint8Array(16),s=ha(r);return s.setBigUint64(0,BigInt(e),n),s.setBigUint64(8,BigInt(t),n),r}function ya(t){return t.byteOffset%4===0}function Ze(t){return Uint8Array.from(t)}var no=t=>Uint8Array.from(t.split(""),e=>e.charCodeAt(0)),ba=no("expand 16-byte k"),wa=no("expand 32-byte k"),xa=we(ba),Ea=we(wa);function $(t,e){return t<<e|t>>>32-e}function Fn(t){return t.byteOffset%4===0}var qt=64,Sa=16,ro=2**32-1,to=Uint32Array.of();function va(t,e,n,r,s,o,i,a){let c=s.length,l=new Uint8Array(qt),d=we(l),u=Fn(s)&&Fn(o),g=u?we(s):to,f=u?we(o):to;for(let m=0;m<c;i++){if(t(e,n,r,d,i,a),i>=ro)throw new Error("arx: counter overflow");let w=Math.min(qt,c-m);if(u&&w===qt){let E=m/4;if(m%4!==0)throw new Error("arx: invalid block position");for(let b=0,C;b<Sa;b++)C=E+b,f[C]=g[C]^d[b];m+=qt;continue}for(let E=0,b;E<w;E++)b=m+E,o[b]=s[b]^l[E];m+=w}}function Wn(t,e){let{allowShortKeys:n,extendNonceFn:r,counterLength:s,counterRight:o,rounds:i}=Js({allowShortKeys:!1,counterLength:8,counterRight:!1,rounds:20},e);if(typeof t!="function")throw new Error("core must be a function");return Ht(s),Ht(i),Ut(o),Ut(n),(a,c,l,d,u=0)=>{X(a,void 0,"key"),X(c,void 0,"nonce"),X(l,void 0,"data");let g=l.length;if(d===void 0&&(d=new Uint8Array(g)),X(d,void 0,"output"),Ht(u),u<0||u>=ro)throw new Error("arx: counter overflow");if(d.length<g)throw new Error(`arx: output (${d.length}) is shorter than data (${g})`);let f=[],m=a.length,w,E;if(m===32)f.push(w=Ze(a)),E=Ea;else if(m===16&&n)w=new Uint8Array(32),w.set(a),w.set(a,16),E=xa,f.push(w);else throw X(a,32,"arx key"),new Error("invalid key size");Fn(c)||f.push(c=Ze(c));let b=we(w);if(r){if(c.length!==24)throw new Error("arx: extended nonce must be 24 bytes");r(E,b,we(c.subarray(0,16)),b),c=c.subarray(16)}let C=16-s;if(C!==c.length)throw new Error(`arx: nonce must be ${C} or 16 bytes`);if(C!==12){let L=new Uint8Array(12);L.set(c,o?0:12-c.length),c=L,f.push(c)}let P=we(c);return va(t,E,b,P,l,d,u,i),xe(...f),d}}function Q(t,e){return t[e++]&255|(t[e++]&255)<<8}var Vn=class{blockLen=16;outputLen=16;buffer=new Uint8Array(16);r=new Uint16Array(10);h=new Uint16Array(10);pad=new Uint16Array(8);pos=0;finished=!1;constructor(e){e=Ze(X(e,32,"key"));let n=Q(e,0),r=Q(e,2),s=Q(e,4),o=Q(e,6),i=Q(e,8),a=Q(e,10),c=Q(e,12),l=Q(e,14);this.r[0]=n&8191,this.r[1]=(n>>>13|r<<3)&8191,this.r[2]=(r>>>10|s<<6)&7939,this.r[3]=(s>>>7|o<<9)&8191,this.r[4]=(o>>>4|i<<12)&255,this.r[5]=i>>>1&8190,this.r[6]=(i>>>14|a<<2)&8191,this.r[7]=(a>>>11|c<<5)&8065,this.r[8]=(c>>>8|l<<8)&8191,this.r[9]=l>>>5&127;for(let d=0;d<8;d++)this.pad[d]=Q(e,16+2*d)}process(e,n,r=!1){let s=r?0:2048,{h:o,r:i}=this,a=i[0],c=i[1],l=i[2],d=i[3],u=i[4],g=i[5],f=i[6],m=i[7],w=i[8],E=i[9],b=Q(e,n+0),C=Q(e,n+2),P=Q(e,n+4),L=Q(e,n+6),F=Q(e,n+8),j=Q(e,n+10),W=Q(e,n+12),K=Q(e,n+14),B=o[0]+(b&8191),H=o[1]+((b>>>13|C<<3)&8191),R=o[2]+((C>>>10|P<<6)&8191),S=o[3]+((P>>>7|L<<9)&8191),h=o[4]+((L>>>4|F<<12)&8191),y=o[5]+(F>>>1&8191),p=o[6]+((F>>>14|j<<2)&8191),v=o[7]+((j>>>11|W<<5)&8191),k=o[8]+((W>>>8|K<<8)&8191),T=o[9]+(K>>>5|s),x=0,_=x+B*a+H*(5*E)+R*(5*w)+S*(5*m)+h*(5*f);x=_>>>13,_&=8191,_+=y*(5*g)+p*(5*u)+v*(5*d)+k*(5*l)+T*(5*c),x+=_>>>13,_&=8191;let A=x+B*c+H*a+R*(5*E)+S*(5*w)+h*(5*m);x=A>>>13,A&=8191,A+=y*(5*f)+p*(5*g)+v*(5*u)+k*(5*d)+T*(5*l),x+=A>>>13,A&=8191;let I=x+B*l+H*c+R*a+S*(5*E)+h*(5*w);x=I>>>13,I&=8191,I+=y*(5*m)+p*(5*f)+v*(5*g)+k*(5*u)+T*(5*d),x+=I>>>13,I&=8191;let U=x+B*d+H*l+R*c+S*a+h*(5*E);x=U>>>13,U&=8191,U+=y*(5*w)+p*(5*m)+v*(5*f)+k*(5*g)+T*(5*u),x+=U>>>13,U&=8191;let O=x+B*u+H*d+R*l+S*c+h*a;x=O>>>13,O&=8191,O+=y*(5*E)+p*(5*w)+v*(5*m)+k*(5*f)+T*(5*g),x+=O>>>13,O&=8191;let N=x+B*g+H*u+R*d+S*l+h*c;x=N>>>13,N&=8191,N+=y*a+p*(5*E)+v*(5*w)+k*(5*m)+T*(5*f),x+=N>>>13,N&=8191;let M=x+B*f+H*g+R*u+S*d+h*l;x=M>>>13,M&=8191,M+=y*c+p*a+v*(5*E)+k*(5*w)+T*(5*m),x+=M>>>13,M&=8191;let z=x+B*m+H*f+R*g+S*u+h*d;x=z>>>13,z&=8191,z+=y*l+p*c+v*a+k*(5*E)+T*(5*w),x+=z>>>13,z&=8191;let V=x+B*w+H*m+R*f+S*g+h*u;x=V>>>13,V&=8191,V+=y*d+p*l+v*c+k*a+T*(5*E),x+=V>>>13,V&=8191;let G=x+B*E+H*w+R*m+S*f+h*g;x=G>>>13,G&=8191,G+=y*u+p*d+v*l+k*c+T*a,x+=G>>>13,G&=8191,x=(x<<2)+x|0,x=x+_|0,_=x&8191,x=x>>>13,A+=x,o[0]=_,o[1]=A,o[2]=I,o[3]=U,o[4]=O,o[5]=N,o[6]=M,o[7]=z,o[8]=V,o[9]=G}finalize(){let{h:e,pad:n}=this,r=new Uint16Array(10),s=e[1]>>>13;e[1]&=8191;for(let a=2;a<10;a++)e[a]+=s,s=e[a]>>>13,e[a]&=8191;e[0]+=s*5,s=e[0]>>>13,e[0]&=8191,e[1]+=s,s=e[1]>>>13,e[1]&=8191,e[2]+=s,r[0]=e[0]+5,s=r[0]>>>13,r[0]&=8191;for(let a=1;a<10;a++)r[a]=e[a]+s,s=r[a]>>>13,r[a]&=8191;r[9]-=8192;let o=(s^1)-1;for(let a=0;a<10;a++)r[a]&=o;o=~o;for(let a=0;a<10;a++)e[a]=e[a]&o|r[a];e[0]=(e[0]|e[1]<<13)&65535,e[1]=(e[1]>>>3|e[2]<<10)&65535,e[2]=(e[2]>>>6|e[3]<<7)&65535,e[3]=(e[3]>>>9|e[4]<<4)&65535,e[4]=(e[4]>>>12|e[5]<<1|e[6]<<14)&65535,e[5]=(e[6]>>>2|e[7]<<11)&65535,e[6]=(e[7]>>>5|e[8]<<8)&65535,e[7]=(e[8]>>>8|e[9]<<5)&65535;let i=e[0]+n[0];e[0]=i&65535;for(let a=1;a<8;a++)i=(e[a]+n[a]|0)+(i>>>16)|0,e[a]=i&65535;xe(r)}update(e){jn(this),X(e),e=Ze(e);let{buffer:n,blockLen:r}=this,s=e.length;for(let o=0;o<s;){let i=Math.min(r-this.pos,s-o);if(i===r){for(;r<=s-o;o+=r)this.process(e,o);continue}n.set(e.subarray(o,o+i),this.pos),this.pos+=i,o+=i,this.pos===r&&(this.process(n,0,!1),this.pos=0)}return this}destroy(){xe(this.h,this.r,this.buffer,this.pad)}digestInto(e){jn(this),Xs(e,this),this.finished=!0;let{buffer:n,h:r}=this,{pos:s}=this;if(s){for(n[s++]=1;s<16;s++)n[s]=0;this.process(n,0,!0)}this.finalize();let o=0;for(let i=0;i<8;i++)e[o++]=r[i]>>>0,e[o++]=r[i]>>>8;return e}digest(){let{buffer:e,outputLen:n}=this;this.digestInto(e);let r=e.slice(0,n);return this.destroy(),r}};function ka(t){let e=(r,s)=>t(s).update(r).digest(),n=t(new Uint8Array(32));return e.outputLen=n.outputLen,e.blockLen=n.blockLen,e.create=r=>t(r),e}var so=ka(t=>new Vn(t));function ao(t,e,n,r,s,o=20){let i=t[0],a=t[1],c=t[2],l=t[3],d=e[0],u=e[1],g=e[2],f=e[3],m=e[4],w=e[5],E=e[6],b=e[7],C=s,P=n[0],L=n[1],F=n[2],j=i,W=a,K=c,B=l,H=d,R=u,S=g,h=f,y=m,p=w,v=E,k=b,T=C,x=P,_=L,A=F;for(let U=0;U<o;U+=2)j=j+H|0,T=$(T^j,16),y=y+T|0,H=$(H^y,12),j=j+H|0,T=$(T^j,8),y=y+T|0,H=$(H^y,7),W=W+R|0,x=$(x^W,16),p=p+x|0,R=$(R^p,12),W=W+R|0,x=$(x^W,8),p=p+x|0,R=$(R^p,7),K=K+S|0,_=$(_^K,16),v=v+_|0,S=$(S^v,12),K=K+S|0,_=$(_^K,8),v=v+_|0,S=$(S^v,7),B=B+h|0,A=$(A^B,16),k=k+A|0,h=$(h^k,12),B=B+h|0,A=$(A^B,8),k=k+A|0,h=$(h^k,7),j=j+R|0,A=$(A^j,16),v=v+A|0,R=$(R^v,12),j=j+R|0,A=$(A^j,8),v=v+A|0,R=$(R^v,7),W=W+S|0,T=$(T^W,16),k=k+T|0,S=$(S^k,12),W=W+S|0,T=$(T^W,8),k=k+T|0,S=$(S^k,7),K=K+h|0,x=$(x^K,16),y=y+x|0,h=$(h^y,12),K=K+h|0,x=$(x^K,8),y=y+x|0,h=$(h^y,7),B=B+H|0,_=$(_^B,16),p=p+_|0,H=$(H^p,12),B=B+H|0,_=$(_^B,8),p=p+_|0,H=$(H^p,7);let I=0;r[I++]=i+j|0,r[I++]=a+W|0,r[I++]=c+K|0,r[I++]=l+B|0,r[I++]=d+H|0,r[I++]=u+R|0,r[I++]=g+S|0,r[I++]=f+h|0,r[I++]=m+y|0,r[I++]=w+p|0,r[I++]=E+v|0,r[I++]=b+k|0,r[I++]=C+T|0,r[I++]=P+x|0,r[I++]=L+_|0,r[I++]=F+A|0}function _a(t,e,n,r){let s=t[0],o=t[1],i=t[2],a=t[3],c=e[0],l=e[1],d=e[2],u=e[3],g=e[4],f=e[5],m=e[6],w=e[7],E=n[0],b=n[1],C=n[2],P=n[3];for(let F=0;F<20;F+=2)s=s+c|0,E=$(E^s,16),g=g+E|0,c=$(c^g,12),s=s+c|0,E=$(E^s,8),g=g+E|0,c=$(c^g,7),o=o+l|0,b=$(b^o,16),f=f+b|0,l=$(l^f,12),o=o+l|0,b=$(b^o,8),f=f+b|0,l=$(l^f,7),i=i+d|0,C=$(C^i,16),m=m+C|0,d=$(d^m,12),i=i+d|0,C=$(C^i,8),m=m+C|0,d=$(d^m,7),a=a+u|0,P=$(P^a,16),w=w+P|0,u=$(u^w,12),a=a+u|0,P=$(P^a,8),w=w+P|0,u=$(u^w,7),s=s+l|0,P=$(P^s,16),m=m+P|0,l=$(l^m,12),s=s+l|0,P=$(P^s,8),m=m+P|0,l=$(l^m,7),o=o+d|0,E=$(E^o,16),w=w+E|0,d=$(d^w,12),o=o+d|0,E=$(E^o,8),w=w+E|0,d=$(d^w,7),i=i+u|0,b=$(b^i,16),g=g+b|0,u=$(u^g,12),i=i+u|0,b=$(b^i,8),g=g+b|0,u=$(u^g,7),a=a+c|0,C=$(C^a,16),f=f+C|0,c=$(c^f,12),a=a+c|0,C=$(C^a,8),f=f+C|0,c=$(c^f,7);let L=0;r[L++]=s,r[L++]=o,r[L++]=i,r[L++]=a,r[L++]=E,r[L++]=b,r[L++]=C,r[L++]=P}var Zn=Wn(ao,{counterRight:!1,counterLength:4,allowShortKeys:!1}),Ra=Wn(ao,{counterRight:!1,counterLength:8,extendNonceFn:_a,allowShortKeys:!1});var Ta=new Uint8Array(16),oo=(t,e)=>{t.update(e);let n=e.length%16;n&&t.update(Ta.subarray(n))},Aa=new Uint8Array(32);function io(t,e,n,r,s){s!==void 0&&X(s,void 0,"AAD");let o=t(e,n,Aa),i=eo(r.length,s?s.length:0,!0),a=so.create(o);s&&oo(a,s),oo(a,r),a.update(i);let c=a.digest();return xe(o,i),c}var co=t=>(e,n,r)=>({encrypt(o,i){let a=o.length;i=Kn(a+16,i,!1),i.set(o);let c=i.subarray(0,-16);t(e,n,c,c,1);let l=io(t,e,n,c,r);return i.set(l,a),xe(l),i},decrypt(o,i){i=Kn(o.length-16,i,!1);let a=o.subarray(0,-16),c=o.subarray(-16),l=io(t,e,n,a,r);if(!Qs(c,l))throw new Error("invalid tag");return i.set(o.subarray(0,-16)),t(e,n,i,i,1),xe(l),i}}),Wd=zn({blockSize:64,nonceLength:12,tagLength:16},co(Zn)),Vd=zn({blockSize:64,nonceLength:24,tagLength:16},co(Ra));function uo(t,e,n){return Ie(t),n===void 0&&(n=new Uint8Array(t.outputLen)),ve(t,n,e)}var Yn=Uint8Array.of(0),lo=Uint8Array.of();function fo(t,e,n,r=32){Ie(t),ie(r,"length");let s=t.outputLen;if(r>255*s)throw new Error("Length must be <= 255*HashLen");let o=Math.ceil(r/s);n===void 0?n=lo:D(n,void 0,"info");let i=new Uint8Array(o*s),a=ve.create(t,e),c=a._cloneInto(),l=new Uint8Array(a.outputLen);for(let d=0;d<o;d++)Yn[0]=d+1,c.update(d===0?lo:l).update(n).update(Yn).digestInto(l),i.set(l,s*d),a._cloneInto(c);return a.destroy(),c.destroy(),ge(l,Yn),i.slice(0,r)}function go(t){return t instanceof Uint8Array||ArrayBuffer.isView(t)&&t.constructor.name==="Uint8Array"}function Ia(t){if(!go(t))throw new Error("Uint8Array expected")}function ho(t,e){return Array.isArray(e)?e.length===0?!0:t?e.every(n=>typeof n=="string"):e.every(n=>Number.isSafeInteger(n)):!1}function ft(t,e){if(typeof e!="string")throw new Error(`${t}: string expected`);return!0}function Qn(t){if(!Number.isSafeInteger(t))throw new Error(`invalid integer: ${t}`)}function Jn(t){if(!Array.isArray(t))throw new Error("array expected")}function Gt(t,e){if(!ho(!0,e))throw new Error(`${t}: array of strings expected`)}function $a(t,e){if(!ho(!1,e))throw new Error(`${t}: array of numbers expected`)}function Oa(...t){let e=o=>o,n=(o,i)=>a=>o(i(a)),r=t.map(o=>o.encode).reduceRight(n,e),s=t.map(o=>o.decode).reduce(n,e);return{encode:r,decode:s}}function Ca(t){let e=typeof t=="string"?t.split(""):t,n=e.length;Gt("alphabet",e);let r=new Map(e.map((s,o)=>[s,o]));return{encode:s=>(Jn(s),s.map(o=>{if(!Number.isSafeInteger(o)||o<0||o>=n)throw new Error(`alphabet.encode: digit index outside alphabet "${o}". Allowed: ${t}`);return e[o]})),decode:s=>(Jn(s),s.map(o=>{ft("alphabet.decode",o);let i=r.get(o);if(i===void 0)throw new Error(`Unknown letter: "${o}". Allowed: ${t}`);return i}))}}function Ba(t=""){return ft("join",t),{encode:e=>(Gt("join.decode",e),e.join(t)),decode:e=>(ft("join.decode",e),e.split(t))}}function La(t,e="="){return Qn(t),ft("padding",e),{encode(n){for(Gt("padding.encode",n);n.length*t%8;)n.push(e);return n},decode(n){Gt("padding.decode",n);let r=n.length;if(r*t%8)throw new Error("padding: invalid, string should have whole number of bytes");for(;r>0&&n[r-1]===e;r--)if((r-1)*t%8===0)throw new Error("padding: invalid, string has too much padding");return n.slice(0,r)}}}var mo=(t,e)=>e===0?t:mo(e,t%e),jt=(t,e)=>t+(e-mo(t,e)),Xn=(()=>{let t=[];for(let e=0;e<40;e++)t.push(2**e);return t})();function po(t,e,n,r){if(Jn(t),e<=0||e>32)throw new Error(`convertRadix2: wrong from=${e}`);if(n<=0||n>32)throw new Error(`convertRadix2: wrong to=${n}`);if(jt(e,n)>32)throw new Error(`convertRadix2: carry overflow from=${e} to=${n} carryBits=${jt(e,n)}`);let s=0,o=0,i=Xn[e],a=Xn[n]-1,c=[];for(let l of t){if(Qn(l),l>=i)throw new Error(`convertRadix2: invalid data word=${l} from=${e}`);if(s=s<<e|l,o+e>32)throw new Error(`convertRadix2: carry overflow pos=${o} from=${e}`);for(o+=e;o>=n;o-=n)c.push((s>>o-n&a)>>>0);let d=Xn[o];if(d===void 0)throw new Error("invalid carry");s&=d-1}if(s=s<<n-o&a,!r&&o>=e)throw new Error("Excess padding");if(!r&&s>0)throw new Error(`Non-zero padding: ${s}`);return r&&o>0&&c.push(s>>>0),c}function Na(t,e=!1){if(Qn(t),t<=0||t>32)throw new Error("radix2: bits should be in (0..32]");if(jt(8,t)>32||jt(t,8)>32)throw new Error("radix2: carry overflow");return{encode:n=>{if(!go(n))throw new Error("radix2.encode input should be Uint8Array");return po(Array.from(n),8,t,!e)},decode:n=>($a("radix2.decode",n),Uint8Array.from(po(n,t,8,e)))}}var Pa=typeof Uint8Array.from([]).toBase64=="function"&&typeof Uint8Array.fromBase64=="function",Da=(t,e)=>{ft("base64",t);let n=e?/^[A-Za-z0-9=_-]+$/:/^[A-Za-z0-9=+/]+$/,r=e?"base64url":"base64";if(t.length>0&&!n.test(t))throw new Error("invalid base64");return Uint8Array.fromBase64(t,{alphabet:r,lastChunkHandling:"strict"})},yo=Pa?{encode(t){return Ia(t),t.toBase64()},decode(t){return Da(t,!1)}}:Oa(Na(6),Ca("ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/"),La(6),Ba(""));var au=new TextDecoder("utf-8"),bo=new TextEncoder,wo=1,xo=4294967295,Eo=65536;function So(t,e){let n=Xr.getSharedSecret(t,re("02"+e)).subarray(1,33);return uo(ce,n,bo.encode("nip44-v2"))}function Ma(t,e){let n=fo(ce,t,e,76);return{chacha_key:n.subarray(0,32),chacha_nonce:n.subarray(32,44),hmac_key:n.subarray(44,76)}}function Ua(t){if(!Number.isSafeInteger(t)||t<1)throw new Error("expected positive integer");if(t<=32)return 32;let e=2**(Math.floor(Math.log2(t-1))+1),n=e<=256?32:e/8;return n*(Math.floor((t-1)/n)+1)}function Ha(t){if(!Number.isSafeInteger(t)||t<wo||t>65535)throw new Error("invalid plaintext size: must be between 1 and 65535 bytes");let e=new Uint8Array(2);return new DataView(e.buffer).setUint16(0,t,!1),e}function qa(t){if(!Number.isSafeInteger(t)||t<Eo||t>xo)throw new Error("invalid plaintext size: must be between 65536 and 4294967295 bytes");let e=new Uint8Array(4);return new DataView(e.buffer).setUint32(0,t,!1),e}function Ga(t){let e=bo.encode(t),n=e.length;if(n<wo||n>xo)throw new Error("invalid plaintext size: must be between 1 and 4294967295 bytes");let r=n>=Eo?Z(new Uint8Array([0,0]),qa(n)):Ha(n),s=new Uint8Array(Ua(n)-n);return Z(r,e,s)}function ja(t,e,n){if(n.length!==32)throw new Error("AAD associated data must be 32 bytes");let r=Z(n,e);return ve(ce,t,r)}function vo(t,e,n=he(32)){let{chacha_key:r,chacha_nonce:s,hmac_key:o}=Ma(e,n),i=Ga(t),a=Zn(r,s,i),c=ja(o,a,n);return yo.encode(Z(new Uint8Array([2]),n,a,c))}var Za=3e3,Ya=1e4,Xa=1200,Ja=8e3,zt=class{constructor(e,n,r,s){this.relay=e;this.owner=r;this.log=s;this.key=So(n,r),this.agent=it(n)}key;agent;queue=[];timer;refused=!1;send(e){this.queue.push(e),this.timer??=setTimeout(()=>void this.flush(),Xa)}async flush(){this.timer&&clearTimeout(this.timer),this.timer=void 0;let e=this.queue.splice(0);if(!e.length)return;let n=JSON.stringify(e.length===1?e[0]:{kind:"batch",payload:{events:e}});try{await this.relay.publish({kind:24200,created_at:Math.floor(Date.now()/1e3),content:vo(n,this.key),tags:[["p",this.owner],["agent",this.agent],["frame","telemetry"]]}),this.refused&&this.log("activity frames are getting through again"),this.refused=!1}catch(r){this.refused||this.log(`couldn\'t send an activity frame: ${r.message}`),this.refused=!0}}},Kt=class{constructor(e,n){this.path=e;this.observer=n;try{Ka(e)&&Wa(e).size>2*1024*1024&&Va(e,`${Fa(e,"utf8").split(`\n`).slice(-Za).join(`\n`)}`)}catch{}}write(e){try{za(this.path,`${JSON.stringify(e)}\n`)}catch{}}start(e){let n=`${Date.now().toString(36)}-${e.eventId.slice(0,8)}`,r=this.observer,s=()=>new Date().toISOString(),o=(f,m)=>r?.send({kind:f,turnId:n,channelId:e.channel,timestamp:s(),...m&&{payload:m}}),i=f=>o("acp_read",{jsonrpc:"2.0",method:"session/update",params:{sessionId:n,update:f}}),a,c=0,l=f=>{a&&i({sessionUpdate:"tool_call_update",toolCallId:a,status:f}),a=void 0};this.write({turn:n,at:Date.now(),type:"start",channel:e.channel,...e.root&&{root:e.root},text:be(e.request,300)}),r?.send({kind:"turn_started",turnId:n,channelId:e.channel,timestamp:s(),startedAt:s(),payload:{source:"mention",triggeringEventIds:[e.eventId],...e.root&&{threadRootEventId:e.root}}});let d=setInterval(()=>o("turn_liveness"),Ya);d.unref();let u=f=>{let m=Mn(f);l("completed"),a=`${n}-${++c}`;let w=Rs(f);i({sessionUpdate:"tool_call",toolCallId:a,title:m.slice(0,200),kind:w,status:"in_progress",...f.target&&{rawInput:{target:f.target}},...(w==="read"||w==="edit")&&f.target&&{locations:[{path:f.target}]}})},g=f=>{this.write({turn:n,at:Date.now(),type:"step",text:Mn(f)}),u(f)};return{tool:(f,m)=>g(dt(f,m,e.labels)),step:g,thought:f=>{f.trim()&&(this.write({turn:n,at:Date.now(),type:"thought",text:f.slice(0,4e3)}),u(Ss(f)),i({sessionUpdate:"agent_thought_chunk",content:{type:"text",text:f.slice(0,Ja)}}))},end:async(f,m)=>{clearInterval(d),l(f==="done"?"completed":"failed"),this.write({turn:n,at:Date.now(),type:"end",outcome:f,...m&&{error:be(m,500)}}),o(f==="error"?"turn_error":"turn_completed",f==="error"?{error:be(m??"failed",2e3)}:f==="stopped"?{outcome:"stopped"}:void 0),await r?.flush()}}}};import{readFileSync as rc}from"node:fs";import{createInterface as sc}from"node:readline";import{readFileSync as Qa}from"node:fs";import{homedir as ec}from"node:os";import{join as tc}from"node:path";function ko(){let t=Qa(tc(ec(),".databrickscfg"),"utf8"),e="",n={};for(let r of t.split(`\n`)){let s=r.trim(),o=/^\\[(.+)\\]$/.exec(s);if(o){e=o[1];continue}let i=/^([a-z_]+)\\s*=\\s*(.*)$/.exec(s);i&&e==="DEFAULT"&&(n[i[1]]=i[2])}if(!n.host||!n.token)throw new Error("The Sandbox has no Databricks credential.");return{host:n.host.replace(/\\/+$/,""),token:n.token}}async function nc(t){let e=new AbortController,n=setTimeout(()=>e.abort(new DOMException("Timed out","TimeoutError")),t.timeoutMs??6e4),r=()=>e.abort(t.signal?.reason);t.signal?.addEventListener("abort",r,{once:!0});try{let s=await fetch(t.url,{method:t.method??"GET",...t.headers&&{headers:t.headers},...t.body!==void 0&&{body:t.body},signal:e.signal}),o={};s.headers.forEach((a,c)=>o[c.toLowerCase()]=a);let i="";if(s.body){let a=new TextDecoder,c=s.body.getReader();for(;;){let{done:d,value:u}=await c.read();if(d)break;let g=a.decode(u,{stream:!0});i+=g,t.onBody?.(g)}let l=a.decode();l&&(i+=l,t.onBody?.(l))}return{status:s.status,headers:o,body:i}}finally{clearTimeout(n),t.signal?.removeEventListener("abort",r)}}function pt(t){let{host:e}=ko(),n=new ct({host:e,transport:nc,token:async()=>ko().token}),r={status:"connected",...t&&{workspaceId:t},profile:{name:"DEFAULT",host:e,...t&&{workspaceId:t}},user:{userName:""},profiles:[]};return{version:1,snapshot:()=>r,subscribe:()=>()=>{},client:()=>n,ready:async()=>n,workspaceUrl:o=>new URL(o,e).toString(),profiles:()=>[],openSettings:()=>{},signIn:async()=>{},preferences:{get:()=>{},set:()=>{},subscribe:()=>()=>{}}}}var _o={type:"object",properties:{}};function oc(t){let{server:e}=t,n=ut(e);return t.login?{name:`${n}__log_in`,description:`[${e.label}] Not available yet: your owner hasn\'t logged in to ${e.label}. If you need it, give them this link to log in, then try again: ${t.login}`,parameters:_o,run:async()=>`Ask your owner to log in to ${e.label} at ${t.login}, then try again.`}:{name:`${n}__unavailable`,description:`[${e.label}] Didn\'t start this time: ${t.message.slice(0,300)}`,parameters:_o,run:async()=>`${e.label} isn\'t available right now: ${t.message}`}}async function er(t,e){let n=JSON.parse(rc(t,"utf8")),r=Fs(n.tools),s=pt(n.workspaceId),o=await Ys(s,r,e),i=new Set;return[...Zs(s,r),...o.tools,...o.failures.map(oc)].map(a=>{let c=a.name.slice(0,Bn);for(let l=2;i.has(c);l++)c=`${a.name.slice(0,Bn-4)}_${l}`;return i.add(c),c===a.name?a:{...a,name:c}})}function Ro(t,e=n=>console.error(n)){let n=er(t,AbortSignal.timeout(12e4)).catch(a=>(e(`tools bridge: couldn\'t list the tools: ${a.message??a}`),[])),r=new Map,s=a=>process.stdout.write(`${JSON.stringify({jsonrpc:"2.0",...a})}\n`),o=(a,c=!1)=>({content:[{type:"text",text:a}],...c&&{isError:c}});async function i(a){let{id:c,method:l,params:d}=a;if(l==="notifications/cancelled")return r.get(d?.requestId)?.abort();if(c!==void 0)switch(l){case"initialize":return s({id:c,result:{protocolVersion:d?.protocolVersion??"2025-06-18",capabilities:{tools:{}},serverInfo:{name:"databricks",version:"1"}}});case"ping":return s({id:c,result:{}});case"tools/list":return s({id:c,result:{tools:(await n).map(u=>({name:u.name,description:u.description,inputSchema:u.parameters}))}});case"tools/call":{let u=(await n).find(f=>f.name===d?.name);if(!u)return s({id:c,result:o(`There\'s no Databricks tool named ${String(d?.name)}.`,!0)});let g=new AbortController;r.set(c,g);try{return s({id:c,result:o(await u.run(d?.arguments??{},g.signal))})}catch(f){return s({id:c,result:o(`Error: ${f.message??f}`,!0)})}finally{r.delete(c)}}default:return s({id:c,error:{code:-32601,message:`Unknown method: ${l}`}})}}return new Promise(a=>{let c=sc({input:process.stdin});c.on("line",l=>{let d;try{d=JSON.parse(l)}catch{return}i(d).catch(u=>d.id!==void 0&&s({id:d.id,error:{code:-32603,message:u.message??String(u)}}))}),c.on("close",()=>{for(let l of r.values())l.abort();a()})})}import{spawn as fc}from"node:child_process";import{mkdirSync as Oo,rmSync as Co,writeFileSync as Yt}from"node:fs";import{join as pc}from"node:path";import{createInterface as gc}from"node:readline";import{chmodSync as ic,existsSync as To,mkdirSync as ac,readFileSync as cc,renameSync as lc,rmSync as Tu,statSync as dc,writeFileSync as Ao}from"node:fs";import{homedir as uc}from"node:os";import{join as se}from"node:path";var ue=process.env.BUZZ_AGENT_DIR??se(uc(),".buzz","agent"),Ft=process.env.BUZZ_AGENT_RUN_DIR??(process.env.BUZZ_AGENT_DIR?se(ue,"run"):"/tmp/buzz-agent"),q={key:se(ue,"key.json"),config:se(ue,"config.json"),state:se(ue,"state.json"),turns:se(Ft,"turns"),pid:se(Ft,"runner.pid"),started:se(Ft,"started"),log:se(ue,"runner.log"),status:se(ue,"status.json"),activity:se(ue,"activity.jsonl"),awake:se(ue,"awake"),runs:se(ue,"runs")};function tr(){for(let t of[ue,Ft,q.turns,q.runs])ac(t,{recursive:!0,mode:448});To(q.started)||Ao(q.started,"")}function Io(){try{return new Date(dc(q.started).mtimeMs).toISOString()}catch{return}}function nr(t,e){try{return JSON.parse(cc(t,"utf8"))}catch{return e}}function Wt(t,e,n=384){let r=`${t}.tmp`;Ao(r,`${JSON.stringify(e,null,2)}\n`,{mode:n}),lc(r,t),ic(t,n)}var Vt=()=>nr(q.config,void 0),rr=()=>({sessions:{},since:0,handled:[],...nr(q.state,{})}),sr=t=>Wt(q.state,{...t,handled:t.handled.slice(-500)});function Zt(){let t=nr(q.key,void 0);return t?.secret&&/^[0-9a-f]{64}$/.test(t.secret)?Uint8Array.from(Buffer.from(t.secret,"hex")):void 0}function $o(t){if(To(q.key))throw new Error("This Sandbox already has an agent key.");Wt(q.key,{secret:Buffer.from(t).toString("hex")})}var Pe=t=>se(q.turns,Buffer.from(t).toString("base64url"));var hc=t=>/no conversation found|no (saved )?session|session[^.]* not found|thread[^.]* not found|no rollout found/i.test(t);async function or(t){try{return await Bo(t)}catch(e){if(!t.session||t.signal.aborted||!hc(e.message))throw e;let{session:n,...r}=t;return Bo(r)}}function Bo(t){let{harness:e}=t,n=crypto.randomUUID(),r=pc(q.runs,`${Date.now().toString(36)}-${n.slice(0,8)}`);Oo(r,{recursive:!0,mode:448});let s=ys(r),o=t.session?.id??(e==="codex"?void 0:crypto.randomUUID()),i=e==="codex"&&!t.session?`<instructions>\n${t.system}\n</instructions>\n\n${t.prompt}`:t.prompt;Yt(s.prompt,i,{mode:384}),Yt(s.system,t.system,{mode:384});let a=Pn(t.tools?.tools)?{runner:process.argv[1]}:void 0;if(a)for(let l of Nn(e,s,a.runner,t.tools))Yt(l.path,l.content,{mode:384});let c=bs({harness:e,model:t.model,permissions:t.permissions,session:o?{id:o,resume:!!t.session}:void 0,files:s,...a&&{tools:a}});return Oo(Lt,{recursive:!0}),new Promise((l,d)=>{let u=fc("bash",["-lc",`cd \'${Lt}\' && ${c}`],{detached:!0,stdio:["ignore","pipe","pipe"]});Yt(t.pidFile,String(u.pid??""),{mode:384});let g="",f,m,w,E="",b=!1,C=()=>{if(u.pid){try{process.kill(-u.pid,"SIGTERM")}catch{}setTimeout(()=>{try{process.kill(-u.pid,"SIGKILL")}catch{}},3e3).unref()}};t.signal.addEventListener("abort",C,{once:!0}),gc({input:u.stdout}).on("line",P=>{let L=ws(e,P);L&&(L.session&&(!b||L.session!==o)&&(o=L.session,b=!0,t.onSession?.(o)),L.thought&&t.onThought?.(L.thought),L.step&&(f&&t.onThought?.(f),f=void 0,t.onStep?.(L.step.tool,L.step.target)),L.text&&(g=f=L.text),L.final!==void 0&&(m=L.final),L.error&&(w=L.error))}),u.stderr.on("data",P=>E=`${E}${P}`.slice(-8e3)),u.on("close",P=>{if(t.signal.removeEventListener("abort",C),Co(t.pidFile,{force:!0}),Co(r,{recursive:!0,force:!0}),t.signal.aborted)return d(t.signal.reason??new DOMException("Aborted","AbortError"));if(w)return d(new Error(`${Ne(e)}: ${w}`));let L=(m??g).trim();if(P!==0||!L)return d(new Error(`${Ne(e)} stopped (exit ${P})${Dn(E)?`: ${Dn(E)}`:""}.`));if(!o)return d(new Error(`${Ne(e)} didn\'t report its session.`));l({text:L,session:o})})})}import{createHash as mc,randomUUID as yc}from"node:crypto";var bc=t=>mc("sha256").update(t).digest("hex"),Xt=class{constructor(e,n,r,s){this.url=e;this.secretKey=n;this.authTag=r;this.log=s;this.base=e.replace(/^ws/,"http").replace(/\\/+$/,"")}base;ready=!1;watching=new Set;closed=!1;sign(e){return ns(e,this.secretKey)}async post(e,n){let r=`${this.base}${e}`,s=this.sign({kind:27235,created_at:Math.floor(Date.now()/1e3),content:"",tags:[["u",r],["method","POST"],["payload",bc(n)],["nonce",yc()]]}),o=await fetch(r,{method:"POST",headers:{authorization:`Nostr ${Buffer.from(JSON.stringify(s)).toString("base64")}`,"content-type":"application/json","x-auth-tag":JSON.stringify(this.authTag)},body:n,signal:AbortSignal.timeout(2e4)}),i=await o.text();if(!o.ok)throw this.ready=!1,Object.assign(new Error(`${o.status} ${i.slice(0,300)}`.trim()),{status:o.status});return this.ready=!0,JSON.parse(i)}async publish(e){let n=e.tags.filter(o=>o[0]!=="auth"&&o[0]!=="ms");n.some(o=>o[0]==="h")&&n.push(["ms",String(Date.now()%1e3)]),n.push([...this.authTag]);let r=this.sign({...e,tags:n}),s=await this.post("/events",JSON.stringify(r));if(!s.accepted&&!s.message?.startsWith("duplicate"))throw new Error(s.message||"The community refused the event.");return r}async query(e){if(!e.length)return[];let n=await this.post("/query",JSON.stringify(e));return Array.isArray(n)?n:[]}watch(e,n,r,s=3e3){let o=new Set,i=n,a=0,c,l=async()=>{if(this.closed)return;let d=s;try{let u=await this.query([{...e,since:i-5}]);a=0;for(let g of u.sort((f,m)=>f.created_at-m.created_at))o.has(g.id)||(o.add(g.id),i=Math.max(i,g.created_at),r(g));if(o.size>2e3)for(let g of[...o].slice(0,1e3))o.delete(g)}catch(u){let g=u.message??String(u),f=/retry in (\\d+)s/.exec(g);d=f?Number(f[1])*1e3:Math.min(6e4,s*2**++a),this.log(`poll failed (${g.slice(0,160)}); next in ${Math.round(d/1e3)}s`)}this.closed||(c=setTimeout(()=>void l(),d),this.watching.add(c))};return l(),()=>{c&&clearTimeout(c)}}close(){this.closed=!0;for(let e of this.watching)clearTimeout(e)}};var Jt=30*6e4,No="A Databricks agent in its own Databricks Sandbox.";function J(t){try{Ae(q.log)&&Lo(q.log).size>5*1024*1024&&vc(q.log,0)}catch{}Ec(q.log,`${new Date().toISOString()} ${t}\n`)}function cr(t){try{return process.kill(t,0),Qt(`/proc/${t}/cmdline`,"utf8").includes("serve")}catch{return!1}}var ar=()=>{let t=Number(Ae(q.pid)?Qt(q.pid,"utf8"):"");return Number.isInteger(t)&&t>0&&cr(t)?t:void 0};function De(t,e){return t===void 0&&(console.error(`No ${e} yet.`),process.exit(2)),t}var Po=(t,e)=>new Xt(t.relay,e,t.authTag,J),lr=t=>t.omnigentAgent||$s,kc=t=>t.kind==="genie"?"Genie":t.kind==="omnigent"?`Omnigent \\xB7 ${t.omnigentLabel??Nt(lr(t))}`:Ne(t.harness),_c=["<omnigent-session>","You are running as an Omnigent agent in an Omnigent session on a Databricks Sandbox. Your owner can open this session in Omnigent and see your work.","Your final message in each turn is posted to the Buzz conversation as your reply, so make it the answer itself, written for the people there. You don\'t have Buzz\'s own tools in this session.","Never print secrets into the conversation.","</omnigent-session>"].join(`\n`);function en(t,e){return[`<identity>You are ${t.name} (pubkey ${e}), an agent in Buzz, a chat app, owned by ${t.owner}.</identity>`,"People mention you in channels, threads and Solo chats; each mention is a turn. Messages in the conversation you haven\'t seen arrive with the mention, as JSON. Your final message is posted as your reply in that conversation: make it the answer itself, in Markdown, written for the people there, without saying that you\'re posting it.",t.kind==="omnigent"?_c:xs(t.harness,"standard",t.kind==="sandbox"?t.tools??[]:[]),ms,t.instructions.trim()?`<agent-instructions>\n${t.instructions.trim()}\n</agent-instructions>`:""].filter(Boolean).join(`\n\n`)}async function Rc(t,e){let n=new Map;if(!e.length)return n;for(let r of await t.query([{kinds:[0],authors:e,limit:e.length*2}]).catch(()=>[]))try{let s=JSON.parse(r.content),o=s.display_name||s.name;o&&!n.has(r.pubkey)&&n.set(r.pubkey,String(o).slice(0,80))}catch{}return n}var Do=t=>({tools:t.tools??[],...t.workspaceId&&{workspaceId:t.workspaceId}});async function Mo(t,e,n,r,s){let o=pt(t.workspaceId),i=t.genieSpace;if(!i){s?.step({tool:"Asking Genie One",target:e});let f=0,m=await new Fe(o).ask(e,{...n&&{conversationId:n},signal:r,onProgress:b=>{for(let C of b.slice(f))s?.step(vs(C));f=Math.max(f,b.length)},onRetry:b=>{s?.step(ks(b)),b.restarted&&(f=0)}}),w=[ds(m)];m.status==="incomplete"&&w.push("_Genie One stopped early; this may be partial._");let E=m.sql[m.sql.length-1];return E&&w.push(`\\`\\`\\`sql\n${E.trim()}\n\\`\\`\\``),m.deepLink&&w.push(`[Explore in Databricks](${m.deepLink})`),{text:w.filter(Boolean).join(`\n\n`)||"Genie One had no answer.",conversation:m.conversationId}}let a=await o.ready(),c=t.genieLabel??"Genie";s?.step({tool:`Asking ${c}`,target:e});let l="",d=await new fe(a).answer(i,e,{...n&&{conversationId:n},signal:r,onUpdate:f=>{f.status!==l&&(l=f.status,s?.step(_s(c,l)))}}),u=[];d.text&&u.push(d.text),d.result?.columns.length&&u.push(Xe(d.result)),d.sql&&u.push(`\\`\\`\\`sql\n${d.sql.trim()}\n\\`\\`\\``),d.message.status!=="COMPLETED"&&u.push(`Genie stopped with status ${d.message.status}${d.error?`: ${d.error}`:""}.`),d.suggestions.length&&u.push(`_You could also ask:_ ${d.suggestions.slice(0,3).map(f=>`\\u201C${f}\\u201D`).join(" \\xB7 ")}`);let g=o.workspaceUrl(fe.webPath(i,d.message.conversation_id));return g&&u.push(`[Open in Genie](${g})`),{text:u.join(`\n\n`)||"Genie had no answer.",conversation:d.message.conversation_id}}async function Uo(t,e){let n=await pt(t.workspaceId).ready(),r=new Pt(n,t.workspaceId),s=await r.turn({...e.session&&{session:e.session},agent:lr(t),title:e.title,text:i=>i?`${e.preamble}\n\n${e.prompt}`:e.prompt,signal:e.signal,onStep:i=>{J(`  ${i.tool}${i.target?` \\xB7 ${i.target}`:""}`),e.activity?.step(i)},onThought:i=>e.activity?.thought(i),...e.onSession&&{onSession:e.onSession}}),o=s.fresh&&!s.waiting?`\n\n[Open in Omnigent](${r.webUrl(s.session)})`:"";return{text:`${s.text}${o}`,session:s.session}}var Ho=t=>`${Pe(t)}.omnigent`;async function Tc(){tr();let t=De(Vt(),"config.json"),e=De(Zt(),"agent key"),n=it(e);Ye(q.pid,String(process.pid));let r=rr(),s=new Set(r.handled),o=new Mt,i=new Map,a=new Map,c=Date.now(),l=0,d=Date.now(),u;J(`starting as ${n.slice(0,12)}\\u2026 (${kc(t)}, ${t.availability})`);let g=Po(t,e),f=new Kt(q.activity,new zt(g,e,t.owner,J)),m=Ws(t.tools??[]),w=()=>sr({...r,handled:[...s]}),E=()=>Wt(q.status,{pid:process.pid,pubkey:n,connected:g.ready,active:l,startedAt:new Date(c).toISOString(),lastActivity:new Date(d).toISOString(),since:r.since,...u&&{lastError:u}},420);async function b(R){let S=i.get(R);if(S&&Date.now()-S.at<10*6e4)return S.kind;let[h]=await g.query([{kinds:[39e3],"#d":[R],limit:1}]),y=Ps(h);return i.set(R,{at:Date.now(),kind:y}),y}async function C(R,S,h){for(let y of Us(S))await g.publish(Hs({conversation:R,content:y,authTag:t.authTag,...h&&{notify:h}}))}async function P(R,S,h,y){let p=r.sessions[S.key];if(t.kind==="genie"){let O=t.genieSpace?`genie:${t.genieSpace}`:"genie-one",N=p?.harness===O?p.id:void 0,M=await Mo(t,Dt(R.content)||"What can I ask you about?",N,h,y);return r.sessions[S.key]={harness:O,id:M.conversation,at:R.created_at},M.text}let v=t.kind==="omnigent"?`omnigent:${lr(t)}`:t.harness,k=p?.harness===v?p:void 0,T=Ds(S),_=(await g.query(T)).filter(O=>O.id!==R.id&&Ve.includes(O.kind)&&O.created_at<=R.created_at&&O.tags.some(N=>N[0]==="h"&&N[1]===S.channel)).filter(O=>O.created_at>(k?.at??0)&&O.pubkey!==n).sort((O,N)=>O.created_at-N.created_at),A=_.slice(-12),I=Ms({event:R,conversation:S,agent:n,context:A,total:_.length,names:await Rc(g,[...new Set([R.pubkey,...A.map(O=>O.pubkey)])]),scope:t.scope});if(process.env.BUZZ_RUNNER_ECHO==="1")return`echo: ${Dt(R.content)} | ${S.key} | context ${A.length} | ${I.length} chars`;if(t.kind==="omnigent"){let O=Ho(S.key);Ye(O,k?.id??"");let N=new AbortController,M=setInterval(()=>Ae(`${Pe(S.key)}.stopped`)&&N.abort(new DOMException("Stopped","AbortError")),1e3);try{let z=await Uo(t,{...k&&{session:k.id},title:`Buzz \\xB7 ${t.name} \\xB7 #${S.channel}`,prompt:I,preamble:en(t,n),signal:AbortSignal.any([h,N.signal]),activity:y,onSession:V=>{r.sessions[S.key]={harness:v,id:V,at:k?.at??0},Ye(O,V),w()}});return r.sessions[S.key]={harness:v,id:z.session,at:R.created_at},z.text}finally{clearInterval(M),ir(O,{force:!0})}}let U=await or({harness:t.harness,model:t.model,permissions:"standard",...k&&{session:{id:k.id}},prompt:I,system:en(t,n),signal:h,pidFile:Pe(S.key),...t.tools?.length&&{tools:Do(t)},onStep:(O,N)=>{J(`  ${O}${N?` \\xB7 ${N}`:""}`),y.tool(O,N)},onThought:O=>y.thought(O),onSession:O=>{r.sessions[S.key]={harness:t.harness,id:O,at:k?.at??0},w()}});return r.sessions[S.key]={harness:t.harness,id:U.session,at:R.created_at},U.text}async function L(R,S){let h=`${Pe(S.key)}.stopped`;ir(h,{force:!0}),l++,d=Date.now(),E(),J(`mention ${R.id.slice(0,8)} in ${S.key}`);let y=f.start({eventId:R.id,channel:S.channel,...S.key!==S.channel&&{root:S.root},request:Dt(R.content),labels:m}),p="done";try{let v=await P(R,S,AbortSignal.timeout(Jt),y);await C(S,v),J(`replied in ${S.key}`)}catch(v){Ae(h)?(p="stopped",J(`stopped in ${S.key}`)):(u=v.message??String(v),p="error",J(`turn failed: ${u}`),await C(S,`I couldn\'t finish that: ${u}`,t.owner).catch(k=>J(`couldn\'t post the failure: ${k.message}`)))}finally{await y.end(p,p==="error"?u:void 0),ir(h,{force:!0}),l--,d=Date.now(),r.since=Math.max(r.since,R.created_at),w(),E()}}function F(R){if(!(s.has(R.id)||!rs(R)||!Ls(R,n))){if(s.add(R.id),!Ns(R,t.owner)){J(`ignored ${R.id.slice(0,8)}: not from the owner`),W(R).catch(S=>J(`couldn\'t tell ${R.pubkey.slice(0,8)} that only the owner\'s requests are taken: ${S.message}`));return}j=j.then(async()=>{let S=R.tags.find(p=>p[0]==="h")?.[1];if(!S)return;let h=qn(R,t.scope,await b(S).catch(()=>({solo:!1})));if(!h)return;let y=(a.get(h.key)??Promise.resolve()).then(()=>L(R,h));a.set(h.key,y.catch(()=>{}))})}}let j=Promise.resolve();async function W(R){if(R.pubkey===n)return;let S=R.tags.find(y=>y[0]==="h")?.[1];if(!S)return;let h=qn(R,t.scope,await b(S).catch(()=>({solo:!1})));!h||!o.take(n,R.pubkey,h.key)||(await C(h,qs,[R.pubkey,t.owner]),J(`told ${R.pubkey.slice(0,8)} in ${h.key} that only the owner\'s requests are taken`))}let K=JSON.stringify([t.name,t.picture??""]),B=async()=>{if(r.profile!==K)try{await g.publish(Gn({name:t.name,...t.picture&&{picture:t.picture},about:No,authTag:t.authTag})),r.profile=K,w(),J("published the profile")}catch(R){J(`profile not published yet: ${R.message}`),setTimeout(()=>void B(),6e4).unref()}};B();let H=r.since?r.since-5:Math.floor(Date.now()/1e3)-60;g.watch({kinds:Ve,"#p":[n]},H,F),E(),setInterval(E,3e4).unref(),t.availability==="sleep"&&setInterval(()=>{let R=Date.now()-d>t.idleMinutes*6e4,S=Ae(q.awake)?Lo(q.awake).mtimeMs:0;l||!R||Date.now()-S<10*6e4||(J("idle with the owner\'s Buzz closed; stopping the Sandbox until Buzz wakes it"),w(),g.close(),wc("databricks",["api","post",`/api/2.0/sandboxes/${t.sandbox}/stop`,"--json","{}"],h=>{h&&J(`couldn\'t stop the Sandbox: ${h.message}`),process.exit(0)}))},6e4).unref(),process.on("SIGTERM",()=>{w(),g.close(),process.exit(0)})}async function Ac(){let[t,...e]=process.argv.slice(2);if(t==="mcp"&&(await Ro(De(e[0],"a tools config")),process.exit(0)),t==="mcp-names"){let n=(await er(De(e[0],"a tools config"),AbortSignal.timeout(12e4))).map(r=>`,${r.name}`).join("");process.stdout.write(n,()=>process.exit(0));return}switch(tr(),t){case"keygen":{let n=Zt();n||(n=ts(),$o(n)),console.log(JSON.stringify({pubkey:it(n)}));return}case"profile":{let n=De(Vt(),"config.json");await Po(n,De(Zt(),"agent key")).publish(Gn({name:n.name,...n.picture&&{picture:n.picture},about:No,authTag:n.authTag}));let s=rr();sr({...s,profile:JSON.stringify([n.name,n.picture??""])}),console.log("published");return}case"start":{if(ar())return console.log("running");let n=Sc(q.log,"a"),r=xc(process.execPath,[process.argv[1],"serve"],{detached:!0,stdio:["ignore",n,n]});return r.unref(),Ye(q.pid,String(r.pid)),console.log("started")}case"stop":{let n=ar();if(n){process.kill(n,"SIGTERM");for(let r=0;r<50&&cr(n);r++)await new Promise(s=>setTimeout(s,100));cr(n)&&process.kill(n,"SIGKILL")}return console.log(n?"stopped":"not running")}case"interrupt":{let[n="",r=""]=e;for(let s of[`${n}/${r}`,n]){let o=Pe(s);if(Ae(Ho(s)))return Ye(`${o}.stopped`,""),console.log("true");let i=Number(Ae(o)?Qt(o,"utf8"):"");if(i){Ye(`${o}.stopped`,"");try{return process.kill(-i,"SIGTERM"),console.log("true")}catch{}}}return console.log("false")}case"status":{let n=ar(),r=Ae(q.status)?JSON.parse(Qt(q.status,"utf8")):{},s=n&&r.pid===n?r:{},o=Io();return console.log(JSON.stringify({...s,running:!!n,...o&&{bootedAt:o}}))}case"ask":{let n=De(Vt(),"config.json"),r=e.join(" ")||"Say hello in one short sentence.";if(n.kind==="genie")return console.log((await Mo(n,r,void 0,AbortSignal.timeout(Jt))).text);if(n.kind==="omnigent"){let o=await Uo(n,{title:`Buzz \\xB7 ${n.name} \\xB7 diagnostic`,prompt:r,preamble:en(n,"diagnostic"),signal:AbortSignal.timeout(Jt)});return console.log(o.text)}let s=await or({harness:n.harness,model:n.model,permissions:"standard",prompt:r,system:en(n,"diagnostic"),signal:AbortSignal.timeout(Jt),pidFile:Pe("ask"),...n.tools?.length&&{tools:Do(n)},onStep:(o,i)=>console.error(`step: ${o}${i?` \\xB7 ${i}`:""}`)});return console.log(s.text)}case"serve":return Tc();default:console.error("usage: runner.mjs keygen|profile|start|serve|stop|interrupt|status|ask|mcp|mcp-names"),process.exit(2)}}Ac().catch(t=>{J(`fatal: ${t?.stack??t}`),console.error(t?.message??t),process.exit(1)});\n';
var RUNNER_SHA = "339c6741cd7d50c2";

// plugins/agents/src/harness-tools.ts
var RUNNER_PATH = `${SANDBOX_HOME}/.buzz/agent/runner.mjs`;
var BRIDGE_NAME = "dbx";
var bridgeCommand = (runner2, config) => ["node", runner2, "mcp", config];
var PI_EXTENSION = `// Databricks tools for Pi, written by the Databricks Agents plugin for Buzz.
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";

export default async function (pi) {
  let command = [];
  try {
    command = JSON.parse(process.env.BUZZ_TOOLS_BRIDGE || "[]");
  } catch {}
  if (!command.length) return;
  const child = spawn(command[0], command.slice(1), { stdio: ["pipe", "pipe", "inherit"] });
  const pending = new Map();
  let next = 1;
  // The bridge keeps Pi running only while a request waits on it, so Pi can exit when it's done.
  const hold = (on) => {
    for (const handle of [child, child.stdin, child.stdout]) on ? handle.ref?.() : handle.unref?.();
  };
  const settle = () => pending.size || hold(false);
  const fail = (error) => {
    for (const waiting of pending.values()) waiting.reject(error);
    pending.clear();
    settle();
  };
  child.on("error", fail);
  child.on("exit", () => fail(new Error("The Databricks tools stopped.")));
  createInterface({ input: child.stdout }).on("line", (line) => {
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      return;
    }
    const waiting = pending.get(message.id);
    if (!waiting) return;
    pending.delete(message.id);
    settle();
    if (message.error) waiting.reject(new Error(message.error.message || "The tool failed."));
    else waiting.resolve(message.result);
  });
  const send = (message) => child.stdin.write(JSON.stringify(message) + "\\n");
  const request = (method, params, signal) =>
    new Promise((resolve, reject) => {
      const id = next++;
      pending.set(id, { resolve, reject });
      hold(true);
      send({ jsonrpc: "2.0", id, method, params });
      signal?.addEventListener(
        "abort",
        () => {
          if (!pending.delete(id)) return;
          settle();
          send({ jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: id } });
          reject(new Error("Stopped."));
        },
        { once: true },
      );
    });
  const stop = () => child.kill();
  pi.on("session_shutdown", stop);
  process.on("exit", stop);
  try {
    await request("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "pi", version: "1" } });
    send({ jsonrpc: "2.0", method: "notifications/initialized" });
    const { tools = [] } = await request("tools/list", {});
    for (const tool of tools)
      pi.registerTool({
        name: tool.name,
        label: tool.title || tool.name,
        description: tool.description || tool.name,
        parameters: tool.inputSchema || { type: "object", properties: {} },
        async execute(_id, params, signal) {
          const result = await request("tools/call", { name: tool.name, arguments: params ?? {} }, signal);
          const text = (result?.content ?? []).filter((part) => part.type === "text").map((part) => part.text).join("\\n") || JSON.stringify(result?.structuredContent ?? {});
          if (result?.isError) throw new Error(text);
          return { content: [{ type: "text", text }], details: {} };
        },
      });
  } catch (error) {
    console.error("Databricks tools unavailable: " + (error?.message ?? error));
  }
}
`;
function toolFiles(harness, files, runner2, config) {
  const out = [{ path: files.tools, content: `${JSON.stringify(config)}
` }];
  const [command, ...args] = bridgeCommand(runner2, files.tools);
  if (harness === "claude") out.push({ path: files.mcp, content: `${JSON.stringify({ mcpServers: { [BRIDGE_NAME]: { type: "stdio", command, args } } })}
` });
  if (harness === "pi") out.push({ path: files.piTools, content: PI_EXTENSION });
  return out;
}
var hasBridgeTools = (tools) => Boolean(tools?.length);

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
function toCsv(result) {
  const quote2 = (value) => value === null ? "" : /[",\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
  return [
    result.columns.map((column) => quote2(column.name)).join(","),
    ...result.rows.map((row) => row.map(quote2).join(","))
  ].join("\n");
}
var RESULT_LANGUAGE = "databricks-result";
function resultBlock(result, maxRows = 200) {
  const shown2 = { ...result, rows: result.rows.slice(0, maxRows) };
  const csv = toCsv(shown2);
  const fence = csv.includes("```") ? "````" : "```";
  const total = result.totalRows ?? result.rows.length;
  const note = total > shown2.rows.length ? `

_Showing ${shown2.rows.length} of ${total} rows._` : "";
  return `${fence}${RESULT_LANGUAGE}
${csv}
${fence}${note}`;
}

// plugins/agents/src/remote.ts
var HARNESSES = [
  { id: "builtin", label: "Built-in", detail: "Fastest. Uses Buzz's tools and the tools you pick, and runs code in the Sandbox when it needs to." },
  { id: "claude", label: "Claude Code", detail: "Anthropic's coding agent, running in the Sandbox with its own tools and the Databricks CLI signed in as you. Keeps its context between turns." },
  { id: "codex", label: "Codex", detail: "OpenAI's coding agent, running in the Sandbox with its own tools and the Databricks CLI signed in as you. Keeps its context between turns." },
  { id: "pi", label: "Pi", detail: "A small coding agent for Claude, GPT and Gemini models, running in the Sandbox with its own tools. Keeps its context between turns." }
];
var HARNESS_IDS = HARNESSES.map((harness) => harness.id);
var isRemote = (harness) => harness !== "builtin";
var harnessLabel = (harness) => HARNESSES.find((candidate) => candidate.id === harness)?.label ?? harness;
var HARNESS_MODEL = {
  claude: "system.ai.claude-sonnet-5-5",
  codex: "system.ai.gpt-5-6-sol",
  pi: "system.ai.claude-sonnet-5-5"
};
function harnessAccepts(harness, model) {
  if (harness === "builtin") return true;
  if (!model.startsWith("system.ai.")) return false;
  const leaf = model.slice("system.ai.".length);
  if (harness === "claude") return /^claude/.test(leaf);
  if (harness === "codex") return /^gpt/.test(leaf);
  return /^(claude|gpt|gemini)/.test(leaf);
}
var harnessModel = (harness, model) => harnessAccepts(harness, model) ? model : HARNESS_MODEL[harness];
function permissionsHint(harness, permissions) {
  if (permissions === "full")
    return "Runs any command and changes any file in the Sandbox without asking. The Sandbox is separate from your computer, but it's signed in to Databricks as you and can reach the internet.";
  if (harness === "claude") return "Claude Code's auto mode: a safety check approves or blocks each action, and nothing waits for you.";
  if (harness === "codex") return "Codex can change files only in its work folder and /tmp, and can reach the internet.";
  return "Pi has no approval step, so Standard gives it file tools only (read, search, edit, write) and no shell.";
}
var RESULT_PROMPT = [
  "To show a query result or other table, put it in a fenced code block with the language",
  `\`${RESULT_LANGUAGE}\` whose body is CSV with a header row (up to 200 rows; quote values that contain commas).`,
  "Buzz draws it as an interactive chart with a table view, so you can chart data; don't say you can't.",
  "Put the label column (such as a date or category) first and the numeric columns after it, unformatted (no $ or thousands separators)."
].join(" ");
var RUNS_DIR = `${SANDBOX_HOME}/.buzz/runs`;
var WORK_DIR = `${SANDBOX_HOME}/work`;
var runFiles = (dir) => ({
  dir,
  prompt: `${dir}/prompt.md`,
  system: `${dir}/system.md`,
  events: `${dir}/events.jsonl`,
  stderr: `${dir}/stderr.log`,
  exit: `${dir}/exit`,
  pid: `${dir}/pid`,
  script: `${dir}/run.sh`,
  tools: `${dir}/tools.json`,
  mcp: `${dir}/mcp.json`,
  piTools: `${dir}/databricks-tools.mjs`
});
var shellQuote = (text) => `'${text.replace(/'/g, `'\\''`)}'`;
var PI_STANDARD_TOOLS = "read,grep,find,ls,edit,write";
function harnessCommand(input) {
  const { model, files, session, tools } = input;
  const full = input.permissions === "full";
  const bridge = tools ? bridgeCommand(tools.runner, files.tools) : void 0;
  switch (input.harness) {
    case "claude": {
      if (!session) throw new Error("Claude Code needs a session ID.");
      return [
        // A Genie answer can take minutes; the bridge lists every server before it answers.
        ...bridge ? ["MCP_TIMEOUT=120000", "MCP_TOOL_TIMEOUT=600000"] : [],
        "claude",
        "-p",
        "--model",
        shellQuote(model),
        "--output-format",
        "stream-json",
        "--verbose",
        "--permission-mode",
        full ? "bypassPermissions" : "auto",
        // The owner chose these tools, so Standard doesn't second-guess them.
        ...bridge ? ["--mcp-config", shellQuote(files.mcp), "--strict-mcp-config", ...full ? [] : ["--allowedTools", `mcp__${BRIDGE_NAME}`]] : [],
        "--append-system-prompt-file",
        shellQuote(files.system),
        session.resume ? "--resume" : "--session-id",
        shellQuote(session.id),
        "<",
        shellQuote(files.prompt)
      ].join(" ");
    }
    case "codex":
      return [
        "codex",
        "exec",
        ...session ? ["resume", shellQuote(session.id)] : [],
        "--json",
        "--skip-git-repo-check",
        "-m",
        shellQuote(model),
        ...full ? ["--dangerously-bypass-approvals-and-sandbox"] : ["-c", shellQuote('sandbox_mode="workspace-write"'), "-c", "sandbox_workspace_write.network_access=true"],
        ...bridge ? [
          "-c",
          shellQuote(`mcp_servers.${BRIDGE_NAME}.command=${JSON.stringify(bridge[0])}`),
          "-c",
          shellQuote(`mcp_servers.${BRIDGE_NAME}.args=${JSON.stringify(bridge.slice(1))}`),
          "-c",
          `mcp_servers.${BRIDGE_NAME}.startup_timeout_sec=120`,
          "-c",
          `mcp_servers.${BRIDGE_NAME}.tool_timeout_sec=600`,
          // codex exec never asks, so a tool needing approval would be refused; the owner chose these.
          "-c",
          shellQuote(`mcp_servers.${BRIDGE_NAME}.default_tools_approval_mode="approve"`)
        ] : [],
        "-",
        "<",
        shellQuote(files.prompt)
      ].join(" ");
    case "pi": {
      if (!session) throw new Error("Pi needs a session ID.");
      const names = bridge ? `$(${[...bridge.slice(0, 2), "mcp-names", files.tools].map(shellQuote).join(" ")} 2>/dev/null)` : "";
      return [
        ...bridge ? [`BUZZ_TOOLS_BRIDGE=${shellQuote(JSON.stringify(bridge))}`] : [],
        "pi",
        "-p",
        "--mode",
        "json",
        "--model",
        shellQuote(model),
        "--session-id",
        shellQuote(session.id),
        "--append-system-prompt",
        shellQuote(files.system),
        ...bridge ? ["-e", shellQuote(files.piTools)] : [],
        ...full ? [] : ["--tools", `"${PI_STANDARD_TOOLS}${names}"`],
        shellQuote(`@${files.prompt}`),
        "<",
        "/dev/null"
      ].join(" ");
    }
  }
}
function runScript(command, files) {
  return ["#!/bin/bash", `cd ${shellQuote(WORK_DIR)} || exit 1`, `${command} > ${shellQuote(files.events)} 2> ${shellQuote(files.stderr)}`, `echo $? > ${shellQuote(files.exit)}`, ""].join("\n");
}
var launchCommand = (files) => `nohup setsid bash ${shellQuote(files.script)} > /dev/null 2>&1 < /dev/null & echo $! > ${shellQuote(files.pid)}; find ${shellQuote(RUNS_DIR)} -mindepth 1 -maxdepth 1 -mmin +1440 -exec rm -rf {} + 2>/dev/null; true`;
var killCommand = (files) => `P=$(cat ${shellQuote(files.pid)} 2>/dev/null); [ -n "$P" ] && { kill -TERM -- -"$P" 2>/dev/null; sleep 2; kill -KILL -- -"$P" 2>/dev/null; }; true`;
var POLL_SEPARATOR = "@@buzz-events@@";
var pollCommand = (files, from) => `cat ${shellQuote(files.exit)} 2>/dev/null; echo; echo ${POLL_SEPARATOR}; tail -n +${from + 1} ${shellQuote(files.events)} 2>/dev/null | head -n 400 | cut -c1-262144`;
function parsePoll(stdout) {
  const at = stdout.indexOf(`
${POLL_SEPARATOR}
`);
  const head = at === -1 ? "" : stdout.slice(0, at).trim();
  const body = at === -1 ? "" : stdout.slice(at + POLL_SEPARATOR.length + 2);
  const lines = body.split("\n");
  lines.pop();
  const exit = /^\d+$/.test(head) ? Number(head) : void 0;
  return { ...exit !== void 0 && { exit }, lines };
}
var TARGET_KEYS = ["command", "cmd", "file_path", "path", "pattern", "query", "question", "statement", "url", "description", "prompt"];
function targetOf(value) {
  if (!value || typeof value !== "object") return void 0;
  for (const key2 of TARGET_KEYS) {
    const found = value[key2];
    if (typeof found === "string" && found.trim()) return found.length > 80 ? `${found.slice(0, 77)}\u2026` : found;
  }
  return void 0;
}
var shellTarget = (command) => {
  const wrapped = /^\/bin\/(?:ba)?sh -lc (['"])([\s\S]*)\1$/.exec(command);
  return wrapped ? wrapped[1] === '"' ? wrapped[2].replace(/\\(["\\$`])/g, "$1") : wrapped[2] : command;
};
var thinkingOf = (content) => Array.isArray(content) ? content.filter((part) => !!part && typeof part === "object" && part.type === "thinking" && typeof part.thinking === "string").map((part) => part.thinking.trim()).filter(Boolean).join("\n\n") : "";
var textOf = (content) => Array.isArray(content) ? content.filter((part) => !!part && typeof part === "object" && part.type === "text" && typeof part.text === "string").map((part) => part.text).join("") : typeof content === "string" ? content : "";
function parseEvent(harness, line) {
  let event;
  try {
    event = JSON.parse(line);
  } catch {
    return void 0;
  }
  if (!event || typeof event !== "object") return void 0;
  if (harness === "claude") {
    if (event.type === "system" && event.subtype === "init" && typeof event.session_id === "string") return { session: event.session_id };
    if (event.type === "system" && event.subtype === "api_retry")
      return { step: { tool: "model", target: `retrying after ${event.error_status ?? "an error"}${event.error ? ` (${event.error})` : ""}` } };
    if (event.type === "assistant" && Array.isArray(event.message?.content)) {
      const thought = thinkingOf(event.message.content);
      const tool = event.message.content.find((part) => part?.type === "tool_use");
      if (tool) return { ...thought && { thought }, step: { tool: String(tool.name ?? "tool"), ...targetOf(tool.input) && { target: targetOf(tool.input) } } };
      const text = textOf(event.message.content);
      return text || thought ? { ...text && { text }, ...thought && { thought } } : void 0;
    }
    if (event.type === "result") {
      const text = typeof event.result === "string" ? event.result : "";
      if (event.is_error || event.subtype && event.subtype !== "success") return { error: text || String(event.subtype ?? "Claude Code failed") };
      return { final: text };
    }
    return void 0;
  }
  if (harness === "codex") {
    if (event.type === "thread.started" && typeof event.thread_id === "string") return { session: event.thread_id };
    if (event.type === "turn.failed") return { error: String(event.error?.message ?? "Codex failed") };
    const item = event.item;
    if (!item || typeof item !== "object") return void 0;
    if (event.type === "item.started") {
      if (item.type === "command_execution" && typeof item.command === "string") return { step: { tool: "shell", target: targetOf({ command: shellTarget(item.command) }) } };
      if (item.type === "file_change") return { step: { tool: "edit", ...item.changes?.[0]?.path && { target: String(item.changes[0].path) } } };
      if (item.type === "mcp_tool_call") return { step: { tool: String(item.tool ?? "tool"), ...targetOf(item.arguments) && { target: targetOf(item.arguments) } } };
      if (item.type === "web_search") return { step: { tool: "web search", ...item.query && { target: String(item.query) } } };
      return void 0;
    }
    if (event.type === "item.completed" && item.type === "agent_message" && typeof item.text === "string") return { text: item.text };
    if (event.type === "item.completed" && item.type === "reasoning" && typeof item.text === "string" && item.text.trim()) return { thought: item.text };
    return void 0;
  }
  if (event.type === "session" && typeof event.id === "string") return { session: event.id };
  if (event.type === "tool_execution_start") return { step: { tool: String(event.toolName ?? "tool"), ...targetOf(event.args) && { target: targetOf(event.args) } } };
  if (event.type === "message_end" && event.message?.role === "assistant") {
    if (event.message.stopReason === "error" && event.message.errorMessage) return { error: String(event.message.errorMessage) };
    const text = textOf(event.message.content);
    const thought = thinkingOf(event.message.content);
    return text || thought ? { ...text && { text }, ...thought && { thought } } : void 0;
  }
  return void 0;
}
var sleep = (ms, signal) => new Promise((resolve, reject) => {
  const timer = setTimeout(() => {
    signal.removeEventListener("abort", stop);
    resolve();
  }, ms);
  const stop = () => {
    clearTimeout(timer);
    reject(signal.reason ?? new DOMException("Aborted", "AbortError"));
  };
  if (signal.aborted) return stop();
  signal.addEventListener("abort", stop, { once: true });
});
var plain = (text) => text.replace(/\x1b\[[0-9;]*[A-Za-z]/g, "").replace(/[│╭╮╰╯─✔•]/g, "").trim();
function stderrSummary(stderr) {
  return plain(stderr).split("\n").map((line) => line.trim()).filter((line) => line && !/Unity Gateway|Databricks auth already|Launching |Starting |managed coding agent config|token refresh is managed|^is running\.?$/i.test(line)).slice(-4).join(" ").slice(0, 600);
}
var isLostSession = (error) => /no conversation found|no (saved )?session|session[^.]* not found|thread[^.]* not found|no rollout found/i.test(error?.message ?? "");
async function runRemoteTurn(input) {
  try {
    return await runTurn(input);
  } catch (error) {
    if (!input.session || input.signal.aborted || !isLostSession(error)) throw error;
    const { session: _lost, ...fresh } = input;
    return runTurn(fresh);
  }
}
async function runTurn(input) {
  const { sandboxes, sandbox, harness, signal } = input;
  const newId = input.newId ?? (() => crypto.randomUUID());
  const files = runFiles(`${RUNS_DIR}/${Date.now().toString(36)}-${newId().slice(0, 8)}`);
  const known = input.session?.harness === harness ? input.session : void 0;
  let sessionId = known?.id ?? (harness === "codex" ? void 0 : newId());
  const tools = hasBridgeTools(input.tools?.tools) ? { runner: RUNNER_PATH } : void 0;
  const command = harnessCommand({
    harness,
    model: input.model,
    permissions: input.permissions,
    session: sessionId ? { id: sessionId, resume: Boolean(known) } : void 0,
    files,
    ...tools && { tools }
  });
  if (tools) for (const file of toolFiles(harness, files, tools.runner, input.tools)) await sandboxes.writeFile(sandbox, file.path, file.content, signal);
  const prompt = harness === "codex" && !known ? `<instructions>
${input.system}
</instructions>

${input.prompt}` : input.prompt;
  await sandboxes.writeFile(sandbox, files.prompt, prompt, signal);
  await sandboxes.writeFile(sandbox, files.system, input.system, signal);
  await sandboxes.writeFile(sandbox, files.script, runScript(command, files), signal);
  const launched = await sandboxes.bash(sandbox, launchCommand(files), { timeoutSeconds: 30, signal });
  if (launched.exit_code !== 0) throw new Error(`Couldn't start ${harnessLabel(harness)}: ${launched.stderr?.trim() || `exit ${launched.exit_code}`}`);
  input.onLaunch?.();
  let from = 0;
  let exited = false;
  let announced = false;
  let text = "";
  let final;
  let error;
  let narration;
  let failures = 0;
  try {
    for (; ; ) {
      await sleep(input.pollMs ?? 2e3, signal);
      let poll;
      try {
        const result = await sandboxes.bash(sandbox, pollCommand(files, from), { timeoutSeconds: 30, signal });
        poll = parsePoll(result.stdout ?? "");
        failures = 0;
      } catch (pollError) {
        if (signal.aborted) throw pollError;
        if (++failures >= 5) throw pollError;
        continue;
      }
      from += poll.lines.length;
      for (const line of poll.lines) {
        const event = parseEvent(harness, line);
        if (!event) continue;
        if (event.session && (!announced || event.session !== sessionId)) {
          sessionId = event.session;
          announced = true;
          input.onSession?.({ harness, id: sessionId });
        }
        if (event.thought) input.onThought?.(event.thought);
        if (event.step) {
          if (narration) input.onThought?.(narration);
          narration = void 0;
          input.onStep?.(event.step.tool, event.step.target);
        }
        if (event.text) text = narration = event.text;
        if (event.final !== void 0) final = event.final;
        if (event.error) error = event.error;
      }
      if (poll.exit !== void 0) exited = true;
      if (exited && poll.lines.length === 0) {
        if (error) throw new Error(`${harnessLabel(harness)}: ${error}`);
        const reply = (final ?? text).trim();
        if (poll.exit !== 0 || !reply) {
          const stderr = await sandboxes.readFile(sandbox, files.stderr, signal).catch(() => "");
          throw new Error(`${harnessLabel(harness)} stopped (exit ${poll.exit})${stderrSummary(stderr) ? `: ${stderrSummary(stderr)}` : reply ? "" : " without a reply"}.`);
        }
        if (!sessionId) throw new Error(`${harnessLabel(harness)} didn't report its session.`);
        return { text: reply, session: { harness, id: sessionId } };
      }
    }
  } catch (failure) {
    if (!exited) await sandboxes.bash(sandbox, killCommand(files), { timeoutSeconds: 30 }).catch(() => {
    });
    throw failure;
  } finally {
    void sandboxes.bash(sandbox, `rm -rf ${shellQuote(files.dir)}`, { timeoutSeconds: 30 }).catch(() => {
    });
  }
}
function remoteNote(harness, permissions, tools = []) {
  return [
    `<databricks-sandbox>`,
    `You are running as ${harnessLabel(harness)} inside your own Databricks Sandbox, a Linux machine in Databricks with Python, Node.js, git, the Databricks CLI (already signed in as your owner) and internet access. Your working folder is ${WORK_DIR}; files under ${SANDBOX_HOME} persist across restarts.`,
    "Your final message is posted to the Buzz conversation as your reply, so make it the answer itself, written for the people there. You don't have Buzz's own tools in this session.",
    harness === "pi" && permissions === "standard" ? "You can read, search and edit files, but you have no shell in this session." : "",
    tools.length ? `Your owner gave you these Databricks tools, which run with their access: ${tools.map((tool) => tool.label).join(", ")}. Use them for questions about data (Genie One finds the right tables and runs the SQL). If a tool says your owner hasn't logged in yet, give them its login link.` : "",
    "Never print secrets into the conversation.",
    `</databricks-sandbox>`
  ].filter(Boolean).join("\n");
}

// plugins/agents/src/runner-upload.ts
var SHA_PATH = RUNNER_PATH.replace(/\.mjs$/, ".sha");
async function uploadRunner(sandboxes, sandbox, signal) {
  const current = await sandboxes.bash(sandbox, `cat ${shellQuote(SHA_PATH)} 2>/dev/null`, { timeoutSeconds: 30, ...signal && { signal } });
  if (current.stdout?.trim() === RUNNER_SHA) return false;
  await sandboxes.writeFile(sandbox, RUNNER_PATH, RUNNER, signal);
  await sandboxes.bash(sandbox, `echo ${RUNNER_SHA} > ${shellQuote(SHA_PATH)}`, { timeoutSeconds: 30, ...signal && { signal } });
  return true;
}

// plugins/agents/src/activity.ts
var BUZZ_TOOLS = /* @__PURE__ */ new Set(["Bash", "Read", "Write", "Edit", "MultiEdit", "NotebookEdit", "Grep", "Glob", "ListFiles", "WebFetch", "WebSearch", "Task", "Agent", "TodoWrite", "send", "send_message", "read"]);
var ALIASES = {
  shell: "Bash",
  bash: "Bash",
  exec_command: "Bash",
  sandbox_exec: "Bash",
  read_file: "Read",
  sandbox_read_file: "Read",
  write: "Write",
  write_file: "Write",
  sandbox_write_file: "Write",
  edit: "Edit",
  apply_patch: "Edit",
  grep: "Grep",
  find: "Glob",
  glob: "Glob",
  ls: "ListFiles",
  sandbox_list: "ListFiles",
  "web search": "WebSearch",
  web_search: "WebSearch",
  fetch: "WebFetch",
  web_fetch: "WebFetch",
  update_plan: "TodoWrite"
};
var PHRASES = {
  genie_one_ask: "Asking Genie One",
  databricks_genie_one_ask: "Asking Genie One",
  databricks_genie_ask: "Asking Genie",
  databricks_genie_list: "Listing Genie agents",
  databricks_sql_query: "Running SQL",
  databricks_sql_warehouses: "Finding a SQL warehouse",
  databricks_catalog_list: "Browsing the catalog",
  databricks_table_describe: "Reading a table",
  model: "Waiting for the model"
};
var SANDBOX_STATES = {
  "Creating sandbox": "Creating its Sandbox",
  "Starting sandbox": "Starting its Sandbox",
  "Waiting for sandbox to stop": "Waiting for its Sandbox"
};
var humanize = (name) => name.replace(/[_-]+/g, " ").replace(/\s+/g, " ").trim();
function snippet(text, max = 100) {
  const line = text.replace(/\s+/g, " ").trim();
  return line.length > max ? `${line.slice(0, max - 1).trimEnd()}\u2026` : line;
}
function describeStep(tool, target2, labels) {
  const withTarget = (name2, value = target2) => value ? { tool: name2, target: snippet(value, 120) } : { tool: name2 };
  const name = tool.replace(/^mcp__[a-zA-Z0-9_-]+?__/, "");
  if (BUZZ_TOOLS.has(name)) return withTarget(name);
  const alias = ALIASES[name] ?? ALIASES[name.toLowerCase()];
  if (alias) return withTarget(alias);
  if (name === "sandbox") return { tool: SANDBOX_STATES[target2 ?? ""] ?? "Starting its Sandbox" };
  if (name === "databricks_sql_query") return withTarget("Running SQL", target2?.split("\n").find((line) => line.trim()));
  const phrase = PHRASES[name];
  if (phrase) return withTarget(phrase);
  const label = labels?.get(name);
  if (/^genie_.+_ask$/.test(name)) return withTarget(`Asking ${label ?? `Genie (${humanize(name.slice(6, -4))})`}`);
  const server = /^(.+?)__(.+)$/.exec(name);
  if (server) {
    const serverLabel = labels?.get(server[1]) ?? humanize(server[1]);
    if (server[2] === "log_in") return { tool: `Checking the ${serverLabel} login` };
    if (server[2] === "unavailable") return { tool: `${serverLabel} isn't available` };
    return withTarget(`Using ${serverLabel}`, [humanize(server[2]), target2].filter(Boolean).join(": "));
  }
  return withTarget(humanize(name) || "Working");
}
function thoughtStep(text) {
  const title = /^\s*\*\*(.+?)\*\*/.exec(text)?.[1];
  const line = title ?? text.split("\n").find((part) => part.trim()) ?? "";
  return line.trim() ? { tool: "Thinking", target: snippet(line, 110) } : { tool: "Thinking" };
}
var genieOneStep = (line) => line.trim() ? { tool: "Genie One", target: snippet(line, 120) } : { tool: "Asking Genie One" };
var rateLimitStep = (notice) => ({
  tool: "Rate-limited",
  target: `${notice.restarted ? "asking Genie One again" : "trying again"} in ${Math.max(1, Math.round(notice.waitMs / 1e3))} s (retry ${notice.attempt})`
});
function genieStatusStep(label, status2) {
  const phrase = {
    SUBMITTED: "sent the question",
    FILTERING_CONTEXT: "finding the right data",
    FETCHING_METADATA: "reading the tables",
    ASKING_AI: "writing the SQL",
    PENDING_WAREHOUSE: "waiting for the SQL warehouse",
    EXECUTING_QUERY: "running the query",
    COMPLETED: "answered"
  };
  return { tool: `Asking ${label}`, target: phrase[status2] ?? humanize(status2.toLowerCase()) };
}
function stepText(step) {
  const t = step.target;
  if (t) {
    const phrased = {
      Bash: `Running ${t}`,
      Read: `Reading ${t}`,
      Write: `Writing ${t}`,
      Edit: `Editing ${t}`,
      MultiEdit: `Editing ${t}`,
      Grep: `Searching for ${t}`,
      Glob: `Finding ${t}`,
      ListFiles: `Listing ${t}`,
      WebFetch: `Reading ${t}`,
      WebSearch: `Searching the web for ${t}`
    };
    return phrased[step.tool] ?? `${step.tool} \xB7 ${t}`;
  }
  const bare = {
    Bash: "Running a command",
    Read: "Reading a file",
    Write: "Writing a file",
    Edit: "Editing a file",
    Grep: "Searching files",
    Glob: "Finding files",
    ListFiles: "Listing files",
    WebSearch: "Searching the web",
    TodoWrite: "Updating its plan",
    send: "Sending a message",
    send_message: "Sending a message",
    read: "Reading the conversation"
  };
  return bare[step.tool] ?? step.tool;
}
var MAX_ITEMS = 200;
var MAX_THOUGHT = 4e3;
function addItem(turn, item) {
  const text = item.kind === "thought" ? item.text.trim().slice(0, MAX_THOUGHT) : item.text;
  if (!text) return;
  const last = turn.items[turn.items.length - 1];
  if (last && last.kind === item.kind && last.text === text) return;
  turn.items.push({ ...item, text });
  if (turn.items.length > MAX_ITEMS) turn.items.splice(0, turn.items.length - MAX_ITEMS);
}
function turnsFromLines(lines) {
  const turns = /* @__PURE__ */ new Map();
  for (const line of lines) {
    let turn = turns.get(line.turn);
    if (!turn) {
      turn = { id: line.turn, startedAt: line.at, items: [] };
      turns.set(line.turn, turn);
    }
    if (line.type === "start") {
      turn.startedAt = line.at;
      if (line.channel) turn.channelId = line.channel;
      if (line.root) turn.root = line.root;
      if (line.text) turn.request = line.text;
    } else if (line.type === "end") {
      turn.endedAt = line.at;
      turn.outcome = line.outcome ?? "done";
      if (line.error) turn.error = line.error;
    } else if (line.text) addItem(turn, { at: line.at, kind: line.type, text: line.text });
  }
  return [...turns.values()].sort((a, b) => b.startedAt - a.startedAt);
}

// plugins/agents/src/activity-ui.tsx
var LONG_THOUGHT = 280;
function when(at) {
  const date = new Date(at);
  const today = (/* @__PURE__ */ new Date()).toDateString() === date.toDateString();
  return today ? date.toLocaleTimeString([], { hour: "numeric", minute: "2-digit", second: "2-digit" }) : date.toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}
var seconds = (ms) => ms < 6e4 ? `${Math.max(1, Math.round(ms / 1e3))} s` : `${Math.floor(ms / 6e4)} min ${Math.round(ms % 6e4 / 1e3)} s`;
function status(turn) {
  if (!turn.endedAt) return `Working \xB7 ${seconds(Date.now() - turn.startedAt)}`;
  const took = seconds(turn.endedAt - turn.startedAt);
  if (turn.outcome === "stopped") return `Stopped after ${took}`;
  if (turn.outcome === "error") return `Couldn't finish (${took})`;
  return `Done in ${took}`;
}
function Thought(props) {
  const [open, setOpen] = React.useState(false);
  const long = props.item.text.length > LONG_THOUGHT;
  const text = long && !open ? `${props.item.text.slice(0, LONG_THOUGHT).trimEnd()}\u2026` : props.item.text;
  return /* @__PURE__ */ React.createElement("div", { style: { borderLeft: "2px solid var(--dbx-border)", paddingLeft: 10, margin: "2px 0" } }, /* @__PURE__ */ React.createElement(Text, { size: "xs", tone: "tertiary" }, "Thinking"), /* @__PURE__ */ React.createElement("div", { style: { whiteSpace: "pre-wrap", fontStyle: "italic", fontSize: "0.8rem", color: "var(--dbx-subtle)", lineHeight: 1.45 } }, text), long && /* @__PURE__ */ React.createElement("button", { type: "button", className: "dbx-link", style: { fontSize: "0.75rem", background: "none", border: 0, padding: 0, cursor: "pointer" }, onClick: () => setOpen(!open) }, open ? "Show less" : "Show all"));
}
function Item(props) {
  if (props.item.kind === "thought") return /* @__PURE__ */ React.createElement(Thought, { item: props.item });
  return /* @__PURE__ */ React.createElement(Stack, { direction: "row", gap: 8, align: "flex-start" }, /* @__PURE__ */ React.createElement("span", { style: { color: "var(--dbx-subtle)", fontSize: "0.7rem", minWidth: 62, paddingTop: 2 } }, new Date(props.item.at).toLocaleTimeString([], { hour: "numeric", minute: "2-digit", second: "2-digit" })), /* @__PURE__ */ React.createElement(Text, { size: "sm", tone: props.item.kind === "note" ? "subtle" : "standard" }, props.item.text));
}
function Turn(props) {
  const { turn } = props;
  const working = !turn.endedAt;
  return /* @__PURE__ */ React.createElement("div", { style: { border: "1px solid var(--dbx-border)", borderRadius: 10, padding: "10px 12px" } }, /* @__PURE__ */ React.createElement(Stack, { gap: 8 }, /* @__PURE__ */ React.createElement(Stack, { direction: "row", gap: 8, align: "center", justify: "space-between" }, /* @__PURE__ */ React.createElement(Stack, { direction: "row", gap: 6, align: "center" }, working && /* @__PURE__ */ React.createElement(Spinner, { size: 11 }), /* @__PURE__ */ React.createElement(Text, { size: "sm", weight: 500 }, status(turn)), /* @__PURE__ */ React.createElement(Text, { size: "xs", tone: "tertiary" }, when(turn.startedAt))), props.openConversation && turn.channelId && /* @__PURE__ */ React.createElement(Button, { size: "sm", variant: "ghost", onClick: () => props.openConversation(turn.channelId, turn.root) }, "Open conversation")), turn.request && /* @__PURE__ */ React.createElement(Text, { size: "sm", tone: "subtle" }, "\u201C", turn.request, "\u201D"), turn.items.length ? /* @__PURE__ */ React.createElement(Stack, { gap: 5 }, turn.items.map((item, index) => /* @__PURE__ */ React.createElement(Item, { key: `${item.at}-${index}`, item }))) : /* @__PURE__ */ React.createElement(Text, { size: "xs", tone: "tertiary" }, working ? "Starting\u2026" : "No steps were recorded."), turn.error && /* @__PURE__ */ React.createElement(Notice, { tone: "danger" }, turn.error)));
}
function ActivityView(props) {
  const { conversation } = props;
  const [, tick] = React.useState(0);
  const working = props.turns.some((turn) => !turn.endedAt);
  React.useEffect(() => {
    if (!working) return;
    const timer = setInterval(() => tick((n) => n + 1), 1e3);
    return () => clearInterval(timer);
  }, [working]);
  React.useEffect(() => props.initialTranscript?.done(), [props.initialTranscript]);
  const here = (turn) => !!conversation && turn.channelId === conversation.channelId && (conversation.rootId ? turn.root === conversation.rootId : true);
  const ordered = conversation ? [...props.turns.filter(here), ...props.turns.filter((turn) => !here(turn))] : props.turns;
  return /* @__PURE__ */ React.createElement(DbxRoot, { style: { padding: "4px 0 24px" } }, /* @__PURE__ */ React.createElement(Stack, { gap: 12 }, props.note, props.error && /* @__PURE__ */ React.createElement(Notice, { tone: "warning" }, props.error), props.loading && !props.turns.length ? /* @__PURE__ */ React.createElement(Stack, { direction: "row", gap: 8, align: "center" }, /* @__PURE__ */ React.createElement(Spinner, { size: 12 }), /* @__PURE__ */ React.createElement(Text, { size: "sm", tone: "subtle" }, "Loading activity\u2026")) : !ordered.length ? /* @__PURE__ */ React.createElement(Text, { size: "sm", tone: "subtle" }, "Nothing yet. When you mention this agent, each turn's steps and thinking appear here.") : ordered.map((turn) => /* @__PURE__ */ React.createElement(Turn, { key: turn.id, turn, ...props.openConversation && { openConversation: props.openConversation } }))));
}

// packages/core/src/api/genie.ts
var TERMINAL = /* @__PURE__ */ new Set(["COMPLETED", "FAILED", "QUERY_RESULT_EXPIRED", "CANCELLED"]);
var messageId = (message) => message.message_id ?? message.id ?? "";
function summarize(message) {
  const attachments = message.attachments ?? [];
  const text = attachments.map((attachment) => attachment.text?.content).filter((value) => Boolean(value)).join("\n\n");
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
    error: message.error?.error
  };
}
var base = (spaceId) => `/api/2.0/genie/spaces/${encodeURIComponent(spaceId)}`;
var Genie = class {
  constructor(client) {
    this.client = client;
  }
  async listSpaces(signal) {
    const spaces = [];
    let pageToken;
    for (let page = 0; page < 20; page++) {
      const response = await this.client.get(
        "/api/2.0/genie/spaces",
        { query: { page_size: 100, page_token: pageToken }, ...signal && { signal } }
      );
      spaces.push(...response.spaces ?? []);
      pageToken = response.next_page_token;
      if (!pageToken) break;
    }
    return spaces.sort((a, b) => a.title.localeCompare(b.title));
  }
  getSpace(spaceId, signal) {
    return this.client.get(base(spaceId), signal ? { signal } : {});
  }
  /** Starts a conversation (or continues one) and returns the new message. */
  async ask(spaceId, content, conversationId, signal) {
    if (conversationId) {
      const message = await this.client.post(
        `${base(spaceId)}/conversations/${encodeURIComponent(conversationId)}/messages`,
        { content },
        signal ? { signal } : {}
      );
      return { ...message, conversation_id: message.conversation_id ?? conversationId };
    }
    const started = await this.client.post(`${base(spaceId)}/start-conversation`, { content }, signal ? { signal } : {});
    const conversation = started.conversation_id ?? started.conversation?.id ?? started.message?.conversation_id ?? "";
    return {
      content,
      status: "SUBMITTED",
      ...started.message,
      conversation_id: conversation,
      message_id: started.message_id ?? started.message?.message_id ?? started.message?.id ?? ""
    };
  }
  getMessage(spaceId, conversationId, id, signal) {
    return this.client.get(
      `${base(spaceId)}/conversations/${encodeURIComponent(conversationId)}/messages/${encodeURIComponent(id)}`,
      signal ? { signal } : {}
    );
  }
  /** Polls until the message settles: 1s, backing off to 5s, up to 10 min. */
  async wait(spaceId, message, onUpdate, signal) {
    let current = message;
    let delay = 1e3;
    const deadline = Date.now() + 10 * 6e4;
    while (!TERMINAL.has(current.status)) {
      if (Date.now() > deadline) throw new Error("Genie did not answer within 10 minutes.");
      await new Promise((resolve) => setTimeout(resolve, delay));
      signal?.throwIfAborted();
      delay = Math.min(5e3, Math.round(delay * 1.4));
      current = {
        ...await this.getMessage(spaceId, current.conversation_id, messageId(current), signal),
        conversation_id: current.conversation_id
      };
      onUpdate?.(current);
    }
    return current;
  }
  /** The query attachment's result, re-running it when it expired. */
  async result(spaceId, message, attachmentId, signal) {
    const path = `${base(spaceId)}/conversations/${encodeURIComponent(message.conversation_id)}/messages/${encodeURIComponent(
      messageId(message)
    )}/attachments/${encodeURIComponent(attachmentId)}`;
    try {
      const response = await this.client.get(`${path}/query-result`, signal ? { signal } : {});
      if (response.statement_response?.result || response.statement_response?.manifest)
        return fromStatement(response.statement_response);
    } catch (error) {
      if (error.status !== 404 && error.status !== 400) throw error;
    }
    const rerun = await this.client.post(`${path}/execute-query`, {}, signal ? { signal } : {});
    return fromStatement(rerun.statement_response ?? {});
  }
  /** A full answer: waits, then fetches the query result when there is one. */
  async answer(spaceId, question, options = {}) {
    const started = await this.ask(spaceId, question, options.conversationId, options.signal);
    options.onUpdate?.(started);
    const message = await this.wait(spaceId, started, options.onUpdate, options.signal);
    const parts = summarize(message);
    let result;
    if (message.status === "COMPLETED" && parts.queryAttachmentId)
      result = await this.result(spaceId, message, parts.queryAttachmentId, options.signal).catch(() => void 0);
    return { message, ...parts, result };
  }
  /** The Genie web URL for a conversation, for "Open in Databricks". */
  static webPath(spaceId, conversationId) {
    return `/genie/rooms/${encodeURIComponent(spaceId)}${conversationId ? `/chats/${encodeURIComponent(conversationId)}` : ""}`;
  }
};

// packages/core/src/api/mcp-catalog.ts
var NATIVE = /* @__PURE__ */ new Set(["system.ai.genie_one_mcp", "system.ai.sandbox"]);
var plain2 = (text = "") => text.replace(/\[([^\]]+)\]\([^)]+\)/g, "$1").replace(/\s+/g, " ").trim();
function serviceLabel(fullName) {
  const leaf = fullName.split(".").pop() ?? fullName;
  const known = { dbsql: "Databricks SQL", github: "GitHub", gmail: "Gmail", microsoft_365: "Microsoft 365" };
  if (known[leaf]) return known[leaf];
  const words = leaf.replace(/[_-]+/g, " ").trim();
  return words.charAt(0).toUpperCase() + words.slice(1);
}
var serviceName = (server) => server.kind === "service" ? server.id.replace(/^service:/, "") : void 0;
var mcpLoginPath = (fullName) => `/mcp-service-login?name=${encodeURIComponent(fullName)}`;
var isLoginRejection = (error) => /HTTP 401|requires authentication|not logged in|login first|Credential for user identity/i.test(error?.message ?? String(error));
function functionsServer(catalog, schema2) {
  return {
    id: `functions:${catalog}.${schema2}`,
    kind: "functions",
    label: `${catalog}.${schema2} functions`,
    description: `Unity Catalog functions in ${catalog}.${schema2}`,
    path: `/api/2.0/mcp/functions/${encodeURIComponent(catalog)}/${encodeURIComponent(schema2)}`
  };
}
var McpCatalog = class {
  constructor(client) {
    this.client = client;
  }
  async services(signal) {
    const out = [];
    let pageToken;
    for (let page = 0; page < 10; page++) {
      const response = await this.client.get("/api/2.1/unity-catalog/mcp-services", {
        query: { view: "FULL", page_size: 100, page_token: pageToken },
        ...signal && { signal }
      });
      for (const service of response.mcp_services ?? []) {
        const fullName = service.name.replace(/^mcp-services\//, "");
        if (NATIVE.has(fullName)) continue;
        const kind = service.config?.source_connection?.securable_kind ?? "";
        out.push({
          id: `service:${fullName}`,
          kind: "service",
          label: serviceLabel(fullName),
          description: plain2(service.comment).replace(/ Verify that the provider's service.*$/, ""),
          path: gatewayMcpPath(fullName),
          .../U2M/.test(kind) && { needsLogin: true },
          ...fullName.startsWith("system.ai.") && { builtIn: true }
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
  async loginState(fullName, signal) {
    try {
      const response = await this.client.get(
        `/api/2.1/unity-catalog/mcp-services/${fullName}/user-credentials`,
        signal ? { signal } : {}
      );
      const state = response.provisioning_info?.state ?? response.state;
      return !state || state === "ACTIVE" ? "signed-in" : "needed";
    } catch (error) {
      return error.errorCode === "NOT_FOUND" ? "needed" : "unknown";
    }
  }
  async connections(signal) {
    const out = [];
    let pageToken;
    for (let page = 0; page < 10; page++) {
      const response = await this.client.get("/api/2.1/unity-catalog/connections", {
        query: { max_results: 500, page_token: pageToken },
        ...signal && { signal }
      });
      for (const connection of response.connections ?? []) {
        if (connection.options?.is_mcp_connection !== "true") continue;
        const host = connection.options.host?.replace(/^https?:\/\//, "");
        out.push({
          id: `connection:${connection.name}`,
          kind: "connection",
          label: connection.name,
          ...(connection.comment || host) && { description: plain2(connection.comment) || host },
          path: `/api/2.0/mcp/external/${encodeURIComponent(connection.name)}`
        });
      }
      pageToken = response.next_page_token;
      if (!pageToken) break;
    }
    return out.sort((a, b) => a.label.localeCompare(b.label));
  }
  /** Everything the person can see, built-ins first; a failing source is skipped. */
  async list(signal) {
    const errors = [];
    const [services, connections] = await Promise.all([
      this.services(signal).catch((error) => (errors.push(`MCP services: ${error.message}`), [])),
      this.connections(signal).catch((error) => (errors.push(`connections: ${error.message}`), []))
    ]);
    const builtIn = services.filter((server) => server.builtIn).sort((a, b) => a.label.localeCompare(b.label));
    const registered = services.filter((server) => !server.builtIn).sort((a, b) => a.label.localeCompare(b.label));
    return { servers: [...builtIn, ...registered, ...connections], errors };
  }
};
function toolPrefix(server) {
  const base2 = (server.label || server.id).toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
  return (base2 || "mcp").slice(0, 20).replace(/_+$/, "");
}

// plugins/genie/src/tools.ts
var AUDIENCE = "Note: these results came from the owner's Databricks access. Everyone in this conversation can read what you post, so share only what this audience should see.";
function formatAnswer(space, answer, link, maxRows) {
  const lines = [`Genie agent: ${space.title} (${space.space_id})`, `conversation_id: ${answer.message.conversation_id}`, `status: ${answer.message.status}`];
  if (answer.error) lines.push(`error: ${answer.error}`);
  if (answer.text) lines.push("", answer.text);
  if (answer.result) lines.push("", toMarkdown(answer.result, maxRows));
  else if (answer.rowCount !== void 0) lines.push("", `(The query returned ${answer.rowCount} rows; the result could not be fetched.)`);
  if (answer.sql) lines.push("", "SQL:", "```sql", answer.sql.trim(), "```");
  if (answer.suggestions.length) lines.push("", `Follow-ups Genie suggests: ${answer.suggestions.slice(0, 3).join(" | ")}`);
  if (link) lines.push("", `Open in Genie: ${link}`);
  lines.push("", AUDIENCE);
  return lines.join("\n");
}

// plugins/genie/src/genie-one.ts
var GENIE_ONE = "system.ai.genie_one_mcp";
var POLL_MS = 3e3;
var MAX_RESULTS = 3;
var cell = (value) => value === null || value === void 0 ? null : typeof value === "object" ? JSON.stringify(value) : String(value);
function toResultSet(result) {
  if (!result.ready || !result.columns?.length) return void 0;
  const rows = (result.rows ?? []).map((row) => row.map(cell));
  const total = result.total_row_count ?? void 0;
  return resultSet(
    result.columns.map((column) => ({ name: column.name, ...column.type_text && { type: column.type_text } })),
    rows,
    {
      ...total !== void 0 && { totalRows: total },
      truncated: Boolean(result.truncated) || total !== void 0 && total > rows.length
    }
  );
}
var stripComments = (markdown) => markdown.replace(/<!--[\s\S]*?--\s*>/g, "").replace(/\n{3,}/g, "\n\n").trim();
function cleanAnswer(text) {
  return stripComments(text).replace(/\s*:citation\[[^\]]*\]/g, "").replace(/\s*\[Query Result\]\([^)\s]*#embed-[^)\s]*\)/g, "").replace(/\s*\[Knowledge snippets?\]\([^)]*\)/gi, "").replace(/([.!?)])[ \t]+Knowledge snippets?(?=[ \t]*(\n|$))/gi, "$1").replace(/`([^`]+)`\s*\[\1\]\(/g, "[$1](").replace(/[ \t]+$/gm, "").trim();
}
function withoutChartCaveats(markdown) {
  const visual = String.raw`(?:charts?|graphs?|plots?|visuali[sz]ations?)`;
  const lead = (match) => /^[ \t]*/.exec(match)?.[0] ?? "";
  return markdown.replace(new RegExp(String.raw`[^.!?\n]*\b(?:can(?:'|’)?t|cannot|can not|unable to|not able to)\b[^.!?\n]*\b${visual}\b[^.!?\n]*[.!?][ \t]*`, "gi"), lead).replace(new RegExp(String.raw`[^.!?\n]*\b(?:to (?:turn|make|build|create) (?:this|it|these|the results?) into an? ${visual}|you can (?:chart|plot|graph) (?:this|it|them|directly))\b[^.!?\n]*[.!?][ \t]*`, "gi"), lead).replace(/[ \t]+$/gm, "").replace(/\n{3,}/g, "\n\n").trim();
}
var cells = (line) => line.trim().replace(/^\|/, "").replace(/\|$/, "").split("|").map((cell2) => cell2.replace(/\*\*|__|`/g, "").trim());
var key = (name) => name.toLowerCase().replace(/[^a-z0-9]/g, "");
function answerMarkdown(answer, maxRows = 200) {
  const lines = cleanAnswer(answer.text).split("\n");
  const unused = [...answer.results];
  const take = (header, rowCount) => {
    const names = header.map(key).join("|");
    let index = unused.findIndex((result) => result.columns.map((column) => key(column.name)).join("|") === names);
    if (index < 0) index = unused.findIndex((result) => result.columns.length === header.length && result.rows.length === rowCount);
    return index < 0 ? void 0 : unused.splice(index, 1)[0];
  };
  const out = [];
  let blocks = 0;
  const row = /^\s*\|.*\|\s*$/;
  for (let i = 0; i < lines.length; i++) {
    if (row.test(lines[i] ?? "") && /^\s*\|?\s*:?-{2,}/.test(lines[i + 1] ?? "")) {
      const header = cells(lines[i] ?? "");
      const body = [];
      for (i += 2; i < lines.length && row.test(lines[i] ?? ""); i++) body.push(cells(lines[i] ?? "").map((cell2) => cell2 || null));
      i--;
      const result = take(header, body.length) ?? resultSet(header.map((name) => ({ name })), body);
      out.push("", resultBlock(result, maxRows), "");
      blocks++;
      continue;
    }
    out.push(lines[i] ?? "");
  }
  let text = out.join("\n").replace(/\n{3,}/g, "\n\n").trim();
  if (!blocks) {
    const last = answer.results[answer.results.length - 1];
    if (last?.columns.length && (last.rows.length > 1 || !text)) {
      text = [text, resultBlock(last, maxRows)].filter(Boolean).join("\n\n");
      blocks++;
    }
  }
  return blocks ? withoutChartCaveats(text) : text;
}
var sleep2 = (ms, signal) => new Promise((resolve, reject) => {
  if (signal?.aborted) {
    reject(signal.reason);
    return;
  }
  const timer = setTimeout(resolve, ms);
  signal?.addEventListener(
    "abort",
    () => {
      clearTimeout(timer);
      reject(signal.reason);
    },
    { once: true }
  );
});
var RATE_LIMIT_WAITS_MS = [2e3, 4e3, 8e3, 15e3];
var RATE_LIMITED = /REQUEST_LIMIT_EXCEEDED|TOO_MANY_REQUESTS|rate[- ]?limit/i;
function isRateLimited(error) {
  if (isApiError(error) && (error.status === 429 || error.errorCode === "REQUEST_LIMIT_EXCEEDED" || error.errorCode === "TOO_MANY_REQUESTS")) return true;
  return error instanceof Error && RATE_LIMITED.test(error.message);
}
var RateLimited = class extends Error {
  constructor(message, conversationId) {
    super(message);
    this.conversationId = conversationId;
    this.name = "RateLimited";
  }
};
var jittered = (ms) => Math.round(ms * (0.8 + Math.random() * 0.4));
async function withBackoff(run, options) {
  for (let attempt = 0; ; attempt++) {
    try {
      return await run();
    } catch (error) {
      const wait = RATE_LIMIT_WAITS_MS[attempt];
      if (wait === void 0 || options.signal?.aborted || !(options.retryable ?? isRateLimited)(error)) throw error;
      const waitMs = jittered(wait);
      options.onRetry?.({ attempt: attempt + 1, waitMs, reason: error instanceof Error ? error.message : String(error) });
      await sleep2(waitMs, options.signal);
    }
  }
}
var CHECK_TIMEOUT_MS = 2e4;
var CheckTimeout = class extends Error {
};
function checkFailure(error) {
  if (error instanceof CheckTimeout) return `Genie One didn't answer within ${CHECK_TIMEOUT_MS / 1e3} seconds.`;
  if (isRateLimited(error)) return "Databricks is rate-limiting Genie One for your organization right now. Try again in a minute.";
  if (isApiError(error) && error.isNotFound) return `Genie One isn't set up in this workspace. ${error.message}`;
  return describeError(error);
}
var GenieOne = class {
  constructor(service) {
    this.service = service;
  }
  clients = /* @__PURE__ */ new Map();
  checks = /* @__PURE__ */ new Map();
  revision = 0;
  listeners = /* @__PURE__ */ new Set();
  /** Changes when the person asks to check again, so every view rechecks. */
  checkRevision = () => this.revision;
  subscribeChecks = (listener) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };
  async mcp() {
    const client = await this.service.ready();
    const snapshot = this.service.snapshot();
    const workspaceId = snapshot.status === "connected" ? snapshot.workspaceId ?? snapshot.profile.workspaceId : void 0;
    const key2 = `${client.host}|${workspaceId ?? ""}`;
    let mcp = this.clients.get(key2);
    if (!mcp) {
      mcp = new McpClient(client, gatewayMcpPath(GENIE_ONE), workspaceId ? { o: workspaceId } : {});
      this.clients.set(key2, mcp);
    }
    return mcp;
  }
  checkKey() {
    const snapshot = this.service.snapshot();
    return snapshot.status === "connected" ? snapshot.profile.host : "none";
  }
  /**
   * Whether Genie One answers in this workspace for this person, and if not,
   * why. Views share one check per workspace; a failure isn't remembered, so
   * the next look (or `recheck`) tries again.
   */
  check() {
    const key2 = this.checkKey();
    let check = this.checks.get(key2);
    if (!check) {
      check = this.listWithin(CHECK_TIMEOUT_MS).then(
        (tools) => tools.some((tool) => tool.name === "genie_ask") ? { ok: true } : { ok: false, reason: "Genie One answered, but without its question tool (genie_ask)." }
      ).catch((error) => ({ ok: false, reason: checkFailure(error), ...isRateLimited(error) && { busy: true } })).then((result) => {
        if (!result.ok && this.checks.get(key2) === check) this.checks.delete(key2);
        return result;
      });
      this.checks.set(key2, check);
    }
    return check;
  }
  /** Whether Genie One answers in this workspace for this person. */
  async available() {
    return (await this.check()).ok;
  }
  /**
   * Forgets this workspace's check, and its MCP client with the tool list it
   * caches, so the next check really asks Genie One again; every view rechecks.
   */
  recheck() {
    const host = this.checkKey();
    this.checks.delete(host);
    for (const key2 of [...this.clients.keys()]) if (key2.startsWith(`${host}|`)) this.clients.delete(key2);
    this.revision++;
    for (const listener of [...this.listeners]) listener();
  }
  /**
   * Genie One's tools, retrying while rate-limited, or a CheckTimeout after
   * `ms` even if the request itself doesn't stop. A rate limit that outlasts
   * the deadline reports as one, not as a timeout.
   */
  async listWithin(ms) {
    const controller = new AbortController();
    let limited;
    let timer;
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        reject(limited ?? new CheckTimeout());
      }, ms);
    });
    const list = this.mcp().then(
      (mcp) => withBackoff(() => mcp.listTools(controller.signal), {
        signal: controller.signal,
        onRetry: (notice) => {
          limited = new RateLimited(notice.reason);
        }
      })
    );
    try {
      return await Promise.race([list, timeout]);
    } finally {
      clearTimeout(timer);
      list.catch(() => void 0);
    }
  }
  /**
   * One Genie One tool call, tried again while rate-limited, whether Databricks
   * refuses the request (HTTP 429) or Genie One answers with a rate-limit error.
   */
  callTool(mcp, name, args, options) {
    const { signal, timeoutMs, onRetry } = options;
    return withBackoff(
      async () => {
        const result = await mcp.callTool(name, args, { ...signal && { signal }, timeoutMs });
        const text = result.isError ? resultText(result) : "";
        if (text && RATE_LIMITED.test(text)) throw new RateLimited(text);
        return result;
      },
      { ...signal && { signal }, ...onRetry && { onRetry: (notice) => onRetry({ ...notice, restarted: false }) } }
    );
  }
  /**
   * Asks Genie One and follows the answer to its end. While Databricks
   * rate-limits it, each call is tried again after a short wait (see
   * RATE_LIMIT_WAITS_MS), and an answer that failed because of a rate limit is
   * asked again in the same conversation. `onRetry` hears each wait.
   */
  async ask(question, options = {}) {
    let conversationId = options.conversationId;
    return withBackoff(
      async () => {
        try {
          return await this.askOnce(question, { ...options, ...conversationId && { conversationId } });
        } catch (error) {
          if (error instanceof RateLimited && error.conversationId) conversationId = error.conversationId;
          throw error;
        }
      },
      {
        ...options.signal && { signal: options.signal },
        // Only a failed answer is asked again here; refused calls were already retried.
        retryable: (error) => error instanceof RateLimited && error.conversationId !== void 0,
        ...options.onRetry && { onRetry: (notice) => options.onRetry?.({ ...notice, restarted: true }) }
      }
    );
  }
  async askOnce(question, options) {
    const { signal, onRetry } = options;
    const mcp = await this.mcp();
    const asked = await this.callTool(
      mcp,
      "genie_ask",
      { question, ...options.conversationId && { conversation_id: options.conversationId } },
      { ...signal && { signal }, timeoutMs: 17e4, ...onRetry && { onRetry } }
    );
    if (asked.isError) throw new Error(resultText(asked) || "Genie One couldn't take the question.");
    const started = resultJson(asked) ?? {};
    const conversationId = started.conversation_id ?? options.conversationId ?? "";
    const responseId = started.response_id ?? "";
    if (!conversationId || !responseId) throw new Error("Genie One didn't return a conversation.");
    options.onStarted?.({ conversationId, responseId });
    return this.follow(mcp, conversationId, responseId, started, resultText(asked), options);
  }
  /**
   * An earlier response, by its IDs: Genie One keeps them, even after later
   * questions in the conversation. A response still running is followed to
   * its end.
   */
  async response(conversationId, responseId, options = {}) {
    return this.follow(await this.mcp(), conversationId, responseId, {}, "", options);
  }
  async follow(mcp, conversationId, responseId, started, startedMarkdown, options) {
    const { signal, onRetry } = options;
    const retry = { ...signal && { signal }, ...onRetry && { onRetry } };
    let state = started;
    let markdown = startedMarkdown;
    let unknowns = 0;
    let steps = [];
    const deadline = Date.now() + 10 * 6e4;
    try {
      while (!state.status || state.status === "in_progress" || state.status === "unknown" && unknowns < 5) {
        if (Date.now() > deadline) throw new Error("Genie One didn't finish within 10 minutes.");
        if (state.status) await sleep2(POLL_MS, signal);
        const polled = await this.callTool(
          mcp,
          "genie_poll_response",
          { conversation_id: conversationId, response_id: responseId },
          { ...retry, timeoutMs: 6e4 }
        );
        if (polled.isError) throw new Error(resultText(polled) || "Genie One failed.");
        state = resultJson(polled) ?? { status: "unknown" };
        markdown = resultText(polled);
        unknowns = state.status === "unknown" ? unknowns + 1 : 0;
        if (state.progress_steps?.length) {
          steps = state.progress_steps;
          options.onProgress?.(steps);
        }
      }
    } catch (error) {
      if (signal?.aborted)
        void mcp.callTool("genie_cancel_response", { conversation_id: conversationId }).catch(() => void 0);
      throw error;
    }
    if (state.status === "failed") {
      const reason = markdown.trim() || "Genie One couldn't answer that.";
      if (RATE_LIMITED.test(reason)) throw new RateLimited(reason, conversationId);
      throw new Error(reason);
    }
    const items = (state.query_items ?? []).slice(0, MAX_RESULTS);
    const results = (await Promise.all(
      items.map(
        (item) => this.callTool(
          mcp,
          "genie_get_query_result",
          { conversation_id: conversationId, response_id: responseId, item_id: item.item_id },
          { ...signal && { signal }, timeoutMs: 6e4 }
        ).then((fetched) => fetched.isError ? void 0 : toResultSet(resultJson(fetched) ?? {})).catch(() => void 0)
      )
    )).filter((result) => result !== void 0);
    return {
      conversationId,
      responseId,
      status: state.status ?? "completed",
      text: (state.final_answer ?? "").trim(),
      markdown: markdown.trim(),
      steps,
      results,
      sql: items.flatMap((item) => item.sql ? [item.sql] : []),
      ...state.deep_link && { deepLink: state.deep_link }
    };
  }
  /** Plain text for agents: the answer (with its tables and links), the SQL and the deep link. */
  format(answer) {
    const lines = ["Genie One", `conversation_id: ${answer.conversationId}`];
    if (answer.status === "incomplete") lines.push("(Genie One stopped before finishing; the answer may be partial.)");
    const text = cleanAnswer(answer.text);
    if (text) lines.push("", text);
    else for (const result of answer.results) lines.push("", toMarkdown(result, 20));
    for (const statement of answer.sql.slice(0, 2)) lines.push("", "SQL Genie One ran:", "```sql", statement.trim(), "```");
    if (answer.deepLink) lines.push("", `[Explore in Databricks](${answer.deepLink})`);
    return lines.join("\n");
  }
};

// plugins/agents/src/capabilities.ts
var GENIE_ONE_CHOICE = { id: "genie-one", kind: "genie-one", label: "Genie One" };
var NAME = /^[a-zA-Z0-9_-]{1,64}$/;
function normalizeChoices(value) {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    const choice = item;
    if (typeof choice?.id !== "string" || typeof choice.label !== "string" || typeof choice.kind !== "string") return [];
    if (["service", "connection", "functions"].includes(choice.kind) && !(typeof choice.path === "string" && choice.path.startsWith("/"))) return [];
    return [{ id: choice.id, kind: choice.kind, label: choice.label, ...choice.path && { path: choice.path } }];
  });
}
var slug = (text, max) => (text.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "") || "x").slice(0, max).replace(/_+$/, "");
var workspaceIdOf = (service) => {
  const snapshot = service.snapshot();
  return snapshot.status === "connected" ? snapshot.workspaceId ?? snapshot.profile.workspaceId : void 0;
};
function withTimeout(signal, ms) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error(`No answer within ${ms / 1e3} seconds`)), ms);
  const stop = () => controller.abort(signal.reason);
  if (signal.aborted) stop();
  else signal.addEventListener("abort", stop, { once: true });
  controller.signal.addEventListener("abort", () => clearTimeout(timer), { once: true });
  return controller.signal;
}
function replyText(reply) {
  if (typeof reply === "string") return reply;
  const content = reply?.content;
  if (Array.isArray(content)) return content.map((part) => part.type === "text" ? part.text ?? "" : "").join("\n");
  return JSON.stringify(reply);
}
function fromAgentTool(tool) {
  return {
    name: tool.name,
    description: tool.description ?? "",
    parameters: tool.inputSchema ?? { type: "object", properties: {} },
    run: async (args) => replyText(await tool.call({}, {}, args))
  };
}
function toolLabels(choices) {
  const labels = /* @__PURE__ */ new Map();
  const used = /* @__PURE__ */ new Set();
  for (const choice of choices) {
    if (choice.kind === "genie") labels.set(genieToolName(choice.label, used), choice.label);
    else if (choice.path) labels.set(toolPrefix(choice), choice.label);
  }
  return labels;
}
function genieToolName(label, used) {
  let name = `genie_${slug(label, 40)}_ask`;
  for (let n = 2; used.has(name); n++) name = `genie_${slug(label, 36)}_${n}_ask`;
  used.add(name);
  return name;
}
function genieLocalTools(service, choices) {
  const tools = [];
  const used = /* @__PURE__ */ new Set();
  for (const choice of choices) {
    if (choice.kind === "genie-one") {
      const genieOne = new GenieOne(service);
      tools.push({
        name: "genie_one_ask",
        description: "Asks Genie One, Databricks' assistant for questions about any data the owner can access in this agent's workspace. It finds the tables, writes and runs the SQL, and answers with numbers, a table and a link. Pass conversation_id from an earlier answer to follow up. Answers can take a minute.",
        parameters: {
          type: "object",
          properties: { question: { type: "string", description: "The question, in plain language." }, conversation_id: { type: "string" } },
          required: ["question"]
        },
        run: async (args, signal) => {
          const conversationId = typeof args.conversation_id === "string" && args.conversation_id ? args.conversation_id : void 0;
          return genieOne.format(await genieOne.ask(String(args.question ?? ""), { signal, ...conversationId && { conversationId } }));
        }
      });
    } else if (choice.kind === "genie") {
      const spaceId = choice.id.replace(/^genie:/, "");
      const name = genieToolName(choice.label, used);
      tools.push({
        name,
        description: `Asks the "${choice.label}" Genie agent, curated by the owner's data team, a question about its data. It answers with an explanation, a table and the SQL. Pass conversation_id to follow up.`,
        parameters: {
          type: "object",
          properties: { question: { type: "string", description: "The question, in plain language." }, conversation_id: { type: "string" } },
          required: ["question"]
        },
        run: async (args, signal) => {
          const client = await service.ready(signal);
          const conversationId = typeof args.conversation_id === "string" && args.conversation_id ? args.conversation_id : void 0;
          const answer = await new Genie(client).answer(spaceId, String(args.question ?? ""), { signal, ...conversationId && { conversationId } });
          return formatAnswer({ title: choice.label, space_id: spaceId }, answer, service.workspaceUrl(Genie.webPath(spaceId, answer.message.conversation_id)), 30);
        }
      });
    }
  }
  return tools;
}
async function mcpLocalTools(service, choices, signal) {
  const servers = choices.filter((choice) => choice.path);
  if (!servers.length) return { tools: [], problems: [], failures: [] };
  const client = await service.ready(signal);
  const workspaceId = workspaceIdOf(service);
  const problems = [];
  const failures = [];
  const lists2 = await Promise.all(
    servers.map(async (server) => {
      const query = server.path.startsWith("/ai-gateway/") && workspaceId ? { o: workspaceId } : {};
      const mcp = new McpClient(client, server.path, query);
      try {
        const tools2 = await mcp.listTools(withTimeout(signal, 3e4));
        return { server, mcp, tools: tools2 };
      } catch (error) {
        const login = server.kind === "service" && isLoginRejection(error) ? service.workspaceUrl(mcpLoginPath(server.id.replace(/^service:/, ""))) : void 0;
        failures.push({ server, message: error.message ?? String(error), ...login && { login } });
        problems.push(
          login ? `${server.label}: your owner isn't logged in to ${server.label} yet. Ask them to log in at ${login}, then try again` : `${server.label}: ${error.message ?? error}`
        );
        return { server, mcp, tools: [] };
      }
    })
  );
  const tools = [];
  const names = /* @__PURE__ */ new Set();
  for (const { server, mcp, tools: listed } of lists2) {
    const prefix = toolPrefix(server);
    for (const tool of listed) {
      let name = `${prefix}__${tool.name}`.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 64);
      for (let n = 2; names.has(name); n++) name = `${name.slice(0, 60)}_${n}`;
      if (!NAME.test(name)) continue;
      names.add(name);
      tools.push({
        name,
        description: `[${server.label}] ${tool.description ?? tool.title ?? tool.name}`.slice(0, 4e3),
        parameters: tool.inputSchema ?? { type: "object", properties: {} },
        run: async (args, runSignal) => {
          const result = await mcp.callTool(tool.name, args, { signal: runSignal, timeoutMs: 17e4 });
          const text = resultText(result);
          const body = text || (result.structuredContent !== void 0 ? JSON.stringify(resultJson(result)) : "OK");
          return result.isError ? `Error from ${server.label}: ${body}` : body;
        }
      });
    }
  }
  return { tools, problems, failures };
}

// plugins/agents/src/omnigent-logo.ts
var OMNIGENT_LOGO_SVG = '<svg width="1024" height="1024" viewBox="0 0 1024 1024" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M208.314 574.639L207.775 574.256C200.279 568.835 188.565 557.989 181.44 551.295C146.313 518.29 100.931 480.158 90.8455 430.852C84.1266 398.005 107.268 372.184 138.92 367.367C172.339 362.281 200.387 376.193 231.657 384.892C266.688 394.637 313.524 404.556 348.456 390.123C386.67 374.334 398.114 315.034 408.23 278.633C412.496 263.73 416.887 248.862 421.401 234.032C434.557 189.666 457.748 108.663 511.512 98.8481C537.704 95.2681 554.804 110.543 568.668 130.231C583.499 151.286 587.863 170.243 596.376 193.36C614.434 242.395 620.239 312.72 647.301 356.702C652.208 364.709 658.611 371.695 666.16 377.278C701.071 402.818 762.618 386.831 799.582 372.604C810.401 368.413 821.107 363.934 831.682 359.172C857.388 347.543 889.292 330.628 916.148 349.956C925.853 356.942 932.715 371.654 933.473 383.419C938.309 458.672 880.367 516.694 828.371 561.885L804.227 582.642C791.561 593.479 781.987 601.127 772.211 615.046C749.499 647.394 760.027 680.915 771.659 714.956C784.409 752.252 800.162 789.474 802.52 829.328C803.928 854.006 801.851 883.098 786.177 903.439C777.085 915.244 763.713 921.657 749.022 923.069C691.683 928.018 635.234 880.581 591.446 848.996C575.758 837.682 557.176 823.356 539.688 816.667C529.716 812.762 518.907 811.499 508.308 813.01C481.254 816.756 456.192 841.906 434.594 859.038C391.171 893.491 331.131 939.08 272.085 920.838C249.715 913.93 237.89 886.456 236.686 865.189C235.154 841.695 238.73 815.601 242.662 792.35C242.177 791.976 240.904 791.359 240.328 791.167C228.207 787.093 218.215 796.752 209.381 802.944C195.642 812.575 169.172 833.066 151.552 825.577C124.923 814.268 143.15 769.769 146.622 749.165C147.382 744.671 148.893 739.806 148.244 735.321C147.709 731.612 146.163 728.127 143.778 725.237C140.235 720.868 135.317 717.865 130.829 714.236C118.261 704.077 100.06 692.281 92.8478 677.487C90.3487 672.361 90.0943 665.35 92.4409 660.181C102.426 640.088 135.569 639.035 154.679 636.566C172.695 634.237 187.362 635.644 193.133 614.812C194.091 611.356 195.963 606.973 197.169 603.489C200.545 593.727 204.056 584.05 208.314 574.639Z" fill="#F53B9D"/><path d="M208.315 574.639C209.839 569.041 218.811 557.539 224.681 554.841C240.202 547.698 250.629 557.885 257.772 570.622C268.032 588.923 270.436 609.77 281.298 627.347C283.281 630.556 288.578 633.371 292.108 634.419C301.252 636.926 310.507 636.963 319.757 637.772C333.108 638.937 351.253 641.252 362.6 648.334C366.207 650.583 369.422 654.54 371.932 657.721C373.598 668.708 373.739 674.189 366.806 683.937C361.796 690.985 355.395 696.57 349.367 702.65C345.552 705.386 343.834 706.49 340.717 709.989C314.826 730.915 318.282 734.699 327.379 766.13C330.104 775.55 330.483 784.198 332.572 793.014L333.201 798.608C332.523 802.467 331.724 809.82 330.121 812.921C320.793 829.169 305.684 826.419 290.775 820.619C283.367 818.257 265.363 806.321 258.424 801.765C252.802 798.08 249.431 794.736 242.662 792.35C242.177 791.976 240.905 791.359 240.329 791.167C228.207 787.093 218.215 796.751 209.382 802.944C195.643 812.574 169.172 833.065 151.552 825.577C124.924 814.268 143.151 769.768 146.623 749.165C147.383 744.67 148.894 739.806 148.245 735.321C147.709 731.612 146.164 728.127 143.778 725.237C140.236 720.868 135.317 717.865 130.829 714.236C118.262 704.077 100.061 692.281 92.8483 677.487C90.3493 672.361 90.0949 665.349 92.4414 660.181C102.426 640.088 135.57 639.035 154.68 636.566C172.695 634.236 187.362 635.644 193.133 614.812C194.091 611.355 195.963 606.973 197.169 603.488C200.545 593.727 204.056 584.05 208.315 574.639Z" fill="#4DC5A0"/><path d="M168.773 776.494C190.268 775.269 183.762 803.431 167.716 807.841C164.872 807.925 162.22 808.145 159.681 806.887C149.284 801.742 153.674 787.402 160.63 781.204C163.814 778.365 165.011 777.776 168.773 776.494Z" fill="#26A079"/><path d="M296.029 776.514C299.113 776.242 300.47 776.121 303.369 777.355C308.901 779.764 313.268 784.245 315.535 789.834C318.553 797.453 317.625 804.394 309.36 807.341C307.811 807.514 306.25 807.566 304.693 807.495C292.738 806.995 288.186 793.281 288.77 783.09C291.066 779.68 292.604 778.557 296.029 776.514Z" fill="#26A079"/><path d="M230.848 572.221C233.186 572.039 235.563 572.128 237.913 572.16C247.387 577.918 247.575 592.815 237.042 597.628C221.037 601.257 219.916 575.851 230.848 572.221Z" fill="#26A079"/><path d="M114.038 660.12C118.182 659.905 121.248 659.554 125.046 661.659C131.584 665.279 132.092 671.261 128.681 677.276C127.274 678.235 125.489 679.227 124.004 680.101C109.514 682.693 101.139 666.594 114.038 660.12Z" fill="#26A079"/><path d="M344.327 659.611C347.702 659.395 350.255 659.69 353.484 660.635C360.343 668.712 359.409 676.664 348.605 680.125C333.222 680.733 330.102 665.756 344.327 659.611Z" fill="#26A079"/><path d="M219.422 721.238C227.414 720.985 223.054 728.908 229.339 732.566C231.675 733.796 236.149 733.618 238.497 732.781C244.56 730.625 241.31 722.688 248.143 720.747C252.164 721.645 251.634 726.303 250.894 729.343C250.407 730.681 249.764 732.243 248.955 733.403C246.147 737.5 241.735 740.209 236.814 740.868C231.91 741.584 226.931 740.199 223.1 737.056C218.536 733.333 214.795 726.341 219.422 721.238Z" fill="black"/><path d="M230.194 603.465C234.786 603.166 240.244 603.484 242.65 607.89C246.432 614.812 243.836 620.462 237.68 623.919C235.394 624.106 233.078 623.966 230.78 623.895C223.985 620.009 224.017 617.113 224.226 609.92C226.111 606.641 227.036 605.514 230.194 603.465Z" fill="#26A079"/><path d="M279.941 756.874C290.642 755.737 292.417 762.07 291.909 771.088C289.611 773.553 288.538 774.586 285.501 776.032C281.054 776.214 276.916 775.325 274.465 771.186C273.116 768.903 272.802 766.153 273.604 763.628C274.749 759.933 276.723 758.52 279.941 756.874Z" fill="#26A079"/><path d="M184.917 756.836C196.422 756.027 197.404 761.696 196.62 771.378C194.357 773.454 192.84 774.371 190.267 776.041C176.666 776.354 173.76 763.066 184.917 756.836Z" fill="#26A079"/><path d="M141.648 670.85C153.661 670.733 155.879 683.156 145.441 688.581C143.519 688.829 141.425 688.843 139.628 688.029C137.382 686.996 135.674 685.064 134.924 682.707C134.045 680.059 134.348 677.16 135.754 674.751C137.291 672.117 138.879 671.528 141.648 670.85Z" fill="#26A079"/><path d="M321.766 670.859C322.156 670.836 322.547 670.822 322.938 670.812C331.825 670.611 332.326 676.355 332.099 683.431C329.982 686.383 329.069 687.192 325.763 688.651C324.112 688.665 322.889 688.642 321.271 688.216C318.935 687.604 316.972 686.023 315.88 683.866C312.953 678.188 316.596 673.277 321.766 670.859Z" fill="#26A079"/><path d="M330.121 812.921C351.649 827.762 346.04 854.263 333.098 872.743C322 888.589 298.34 902.284 280.221 889.847C261.55 877.027 269.439 848.094 280.395 832.944C283.6 828.51 287.566 824.796 290.775 820.62C305.684 826.419 320.793 829.17 330.121 812.921Z" fill="#E60C7F"/><path d="M332.571 793.015C332.378 788.576 332.341 785.896 334.063 781.64C337.844 772.299 345.921 766.747 356.036 766.766C368.787 766.79 378.185 777.182 377.436 789.806C376.754 803.992 365.734 813.188 351.728 811.733C343.99 810.929 340.003 807.374 335.403 801.574C334.631 800.615 333.896 799.624 333.201 798.609L332.571 793.015Z" fill="#E60C7F"/><path d="M349.366 702.65C349.073 709.245 346.033 709.03 340.716 709.989C343.833 706.49 345.552 705.387 349.366 702.65Z" fill="#E60C7F"/><path d="M721.44 807.537C744.705 804.085 765.083 831.55 767.88 852.116C770.34 870.235 763.601 888.463 743.133 890.689C730.766 890.815 726.636 889.052 716.407 882.218C691.931 865.872 682.418 811.812 721.44 807.537Z" fill="#E60C7F"/><path d="M513.098 132.984C552.826 129.498 560.305 190.521 537.414 212.767C532.358 217.685 529.173 218.896 522.419 220.389C504.529 223.385 492.424 210.736 487.42 194.923C482.662 180.347 484.028 164.462 491.208 150.913C496.423 141.111 502.578 136.148 513.098 132.984Z" fill="#E60C7F"/><path d="M883.488 373.034C932.453 371.208 913.571 443.307 865.859 450.972C854.718 451.19 842.791 448.575 838.104 436.854C827.436 410.169 857.272 374.97 883.488 373.034Z" fill="#E60C7F"/><path d="M143.248 394.964C193.554 391.929 219.573 456.112 171.828 463.485C122.154 465.224 94.9093 402.326 143.248 394.964Z" fill="#E60C7F"/><path d="M513.701 233.861C529.983 231.238 545.286 242.387 547.779 258.692C550.277 274.997 539.005 290.211 522.681 292.577C506.54 294.917 491.531 283.799 489.062 267.675C486.597 251.551 497.593 236.455 513.701 233.861Z" fill="#E60C7F"/><path d="M513.561 306.543C527.415 303.878 540.824 312.896 543.574 326.732C546.329 340.568 537.4 354.033 523.579 356.875C509.636 359.744 496.021 350.713 493.243 336.751C490.464 322.789 499.58 309.233 513.561 306.543Z" fill="#E60C7F"/><path d="M479.039 595.093C481.923 594.822 484.459 594.476 486.863 596.375C490.315 599.097 490.507 603.849 491.512 607.792C493.87 617.048 500.282 623.212 509.66 624.751C521.358 626.669 533.458 622.922 538.43 611.286C540.764 606.543 539.552 599.139 544.538 595.982C548.448 593.503 554.028 594.723 556.138 598.98C558.631 604.003 556.858 610.57 555.324 615.607C548.107 635.051 528.041 645.752 507.957 642.328C498.177 640.78 486.377 634.223 480.891 625.691C475.437 617.212 468.172 602.17 479.039 595.093Z" fill="black"/><path d="M807.225 436.948C819.938 435.444 831.472 444.519 832.997 457.23C834.521 469.941 825.462 481.486 812.754 483.031C800.017 484.579 788.441 475.497 786.912 462.758C785.382 450.018 794.484 438.456 807.225 436.948Z" fill="#E60C7F"/><path d="M648.611 720.924C661.165 720.241 671.88 729.886 672.517 742.44C673.153 754.998 663.461 765.676 650.908 766.261C638.42 766.845 627.807 757.22 627.175 744.736C626.544 732.248 636.128 721.602 648.611 720.924Z" fill="#E60C7F"/><path d="M681.16 767.186C693.339 764.46 705.43 772.088 708.218 784.254C711.005 796.414 703.442 808.547 691.291 811.4C679.055 814.267 666.815 806.639 664.008 794.384C661.197 782.135 668.891 769.932 681.16 767.186Z" fill="#E60C7F"/><path d="M383.948 721.71C396.037 718.623 408.338 725.934 411.4 738.029C414.462 750.129 407.121 762.412 395.018 765.447C382.954 768.473 370.717 761.158 367.665 749.1C364.612 737.042 371.897 724.793 383.948 721.71Z" fill="#E60C7F"/><path d="M747.081 466.845C759.059 464.286 770.846 471.905 773.428 483.876C776.014 495.847 768.418 507.65 756.454 510.26C744.452 512.877 732.605 505.255 730.014 493.248C727.423 481.241 735.07 469.411 747.081 466.845Z" fill="#E60C7F"/><path d="M221.035 442.073C233.082 441.05 243.71 449.907 244.877 461.941C246.043 473.974 237.314 484.708 225.295 486.019C217.392 486.88 209.635 483.426 204.988 476.974C200.341 470.524 199.522 462.072 202.844 454.848C206.164 447.625 213.113 442.745 221.035 442.073Z" fill="#E60C7F"/><path d="M273.457 466.429C285.414 465.832 295.572 475.085 296.089 487.046C296.607 499.008 287.287 509.104 275.322 509.542C263.469 509.977 253.487 500.763 252.974 488.912C252.462 477.062 261.61 467.019 273.457 466.429Z" fill="#E60C7F"/><path d="M614.288 449.332C653.717 446.734 687.743 476.697 690.166 516.149C692.589 555.601 662.486 589.506 623.035 591.753C583.83 593.992 550.193 564.106 547.784 524.899C545.377 485.692 575.104 451.913 614.288 449.332Z" fill="#FEFEFE"/><path d="M619.877 464.629C650.751 465.05 675.441 490.422 675.029 521.305C674.618 552.189 649.261 576.894 618.388 576.492C587.5 576.09 562.789 550.712 563.2 519.815C563.612 488.918 588.99 464.208 619.877 464.629Z" fill="black"/><path d="M595.036 483.748C604.506 482.54 613.184 489.181 614.494 498.64C615.805 508.099 609.26 516.852 599.819 518.265C593.62 519.193 587.4 516.718 583.533 511.784C579.665 506.85 578.746 500.217 581.126 494.417C583.506 488.617 588.818 484.542 595.036 483.748Z" fill="#FEFEFE"/><path d="M408.921 449.332C448.35 446.734 482.376 476.697 484.799 516.149C487.222 555.601 457.119 589.506 417.669 591.753C378.464 593.992 344.826 564.106 342.418 524.899C340.01 485.692 369.737 451.913 408.921 449.332Z" fill="#FEFEFE"/><path d="M414.511 464.629C445.384 465.05 470.074 490.422 469.663 521.305C469.251 552.189 443.895 576.894 413.021 576.492C382.133 576.09 357.422 550.712 357.834 519.815C358.245 488.918 383.623 464.208 414.511 464.629Z" fill="black"/><path d="M389.669 483.748C399.139 482.54 407.817 489.181 409.128 498.64C410.439 508.099 403.894 516.852 394.452 518.265C388.253 519.193 382.034 516.718 378.166 511.784C374.299 506.85 373.379 500.217 375.759 494.417C378.139 488.617 383.451 484.542 389.669 483.748Z" fill="#FEFEFE"/><path d="M192.439 656.54C209.889 655.39 224.948 668.65 226.021 686.111C227.093 703.571 213.77 718.576 196.311 719.571C178.96 720.562 164.073 707.335 163.007 689.983C161.942 672.632 175.098 657.682 192.439 656.54Z" fill="#FEFEFE"/><path d="M194.913 663.309C208.576 663.496 219.503 674.725 219.321 688.393C219.139 702.06 207.917 712.994 194.253 712.816C180.584 712.638 169.647 701.407 169.829 687.733C170.012 674.059 181.243 663.123 194.913 663.309Z" fill="black"/><path d="M183.919 671.771C188.11 671.236 191.951 674.176 192.531 678.362C193.111 682.548 190.214 686.422 186.036 687.047C183.292 687.458 180.54 686.363 178.828 684.179C177.116 681.995 176.71 679.06 177.763 676.493C178.816 673.926 181.167 672.123 183.919 671.771Z" fill="#FEFEFE"/><path d="M271.5 656.54C288.95 655.39 304.009 668.65 305.082 686.111C306.154 703.571 292.831 718.576 275.372 719.571C258.021 720.562 243.134 707.335 242.068 689.983C241.003 672.632 254.159 657.682 271.5 656.54Z" fill="#FEFEFE"/><path d="M273.974 663.309C287.638 663.496 298.565 674.725 298.383 688.393C298.201 702.06 286.979 712.994 273.315 712.816C259.645 712.638 248.709 701.407 248.891 687.733C249.073 674.059 260.305 663.123 273.974 663.309Z" fill="black"/><path d="M262.98 671.771C267.172 671.236 271.012 674.176 271.592 678.362C272.172 682.548 269.276 686.422 265.097 687.047C262.354 687.458 259.601 686.363 257.89 684.179C256.178 681.995 255.771 679.06 256.824 676.493C257.878 673.926 260.229 672.123 262.98 671.771Z" fill="#FEFEFE"/></svg>';

// plugins/agents/src/icons.tsx
var OMNIGENT_LOGO = svgDataUri(OMNIGENT_LOGO_SVG);
var LAVA = "#FF3621";
var svg = (size, children) => /* @__PURE__ */ React.createElement("svg", { width: size, height: size, viewBox: "0 0 24 24", fill: "none", "aria-hidden": true, focusable: "false" }, children);
function GenieKindIcon({ size = 20 }) {
  return svg(
    size,
    /* @__PURE__ */ React.createElement(React.Fragment, null, /* @__PURE__ */ React.createElement("path", { fill: LAVA, d: "M10 2.5c.7 4.4 2.8 6.6 7.2 7.3-4.4.7-6.5 2.9-7.2 7.3-.7-4.4-2.8-6.6-7.2-7.3 4.4-.7 6.5-2.9 7.2-7.3Z" }), /* @__PURE__ */ React.createElement("path", { fill: LAVA, d: "M18 14c.35 2 1.3 2.95 3.3 3.3-2 .35-2.95 1.3-3.3 3.3-.35-2-1.3-2.95-3.3-3.3 2-.35 2.95-1.3 3.3-3.3Z" }))
  );
}
function SandboxKindIcon({ size = 20 }) {
  return svg(
    size,
    /* @__PURE__ */ React.createElement(React.Fragment, null, /* @__PURE__ */ React.createElement("rect", { x: "2.5", y: "4", width: "19", height: "16", rx: "3.5", fill: LAVA }), /* @__PURE__ */ React.createElement("path", { d: "M7 9.25 10 12l-3 2.75M12.5 15h4.5", stroke: "#fff", strokeWidth: "1.8", strokeLinecap: "round", strokeLinejoin: "round" }))
  );
}
function OmnigentKindIcon({ size = 20 }) {
  return /* @__PURE__ */ React.createElement("img", { src: OMNIGENT_LOGO, width: size, height: size, alt: "", "aria-hidden": true, draggable: false, style: { display: "block" } });
}
function CustomKindIcon({ size = 20 }) {
  return svg(
    size,
    /* @__PURE__ */ React.createElement(React.Fragment, null, /* @__PURE__ */ React.createElement("rect", { x: "7.25", y: "2.75", width: "9.5", height: "8.5", rx: "2", fill: LAVA }), /* @__PURE__ */ React.createElement("rect", { x: "2.25", y: "12.75", width: "9.5", height: "8.5", rx: "2", fill: LAVA }), /* @__PURE__ */ React.createElement("rect", { x: "12.25", y: "12.75", width: "9.5", height: "8.5", rx: "2", fill: LAVA }))
  );
}

// plugins/agents/src/omnigent.ts
var OMNIGENT_API = "/api/2.0/omnigent";
var SLICE_KEY = "X-Databricks-Omnigent-Slice-Key";
var POLL_MS2 = 2500;
var READY_TIMEOUT_MS = 8 * 6e4;
var START_TIMEOUT_MS = 3 * 6e4;
var APPROVAL_GRACE_MS = 3e4;
var SETTLE_POLLS = 3;
var DEFAULT_OMNIGENT_AGENT = "claude-native-ui";
var KNOWN_AGENTS = {
  "claude-native-ui": { label: "Claude Code", detail: "Claude Code, with models from AI Gateway." },
  "codex-native-ui": { label: "Codex", detail: "OpenAI's Codex, with models from AI Gateway." },
  "pi-native-ui": { label: "Pi", detail: "The Pi coding agent, with models from AI Gateway." },
  polly: { label: "Polly", detail: "Hands larger coding tasks to other coding agents, with an independent reviewer checking their work." },
  debby: { label: "Debby", detail: "A brainstorming partner that answers with Claude's and GPT's views side by side." }
};
var SANDBOX_HARNESSES = /* @__PURE__ */ new Set(["claude-native", "codex-native", "pi-native", "claude-sdk", "codex", "pi"]);
var omnigentAgentLabel = (name) => KNOWN_AGENTS[name]?.label ?? name.replace(/-native-ui$/, "").replace(/[-_]+/g, " ");
function omnigentError(response) {
  let detail;
  try {
    const parsed = JSON.parse(response.body);
    if (typeof parsed.detail === "string") detail = parsed.detail;
  } catch {
  }
  const error = apiError(response);
  if (detail) error.message = detail;
  return error;
}
var textOf2 = (blocks) => (blocks ?? []).map((block) => typeof block.text === "string" ? block.text : "").filter((text) => text.trim()).join("\n\n");
function omnigentStep(name, args = {}) {
  const pick = (...keys) => {
    for (const key2 of keys) {
      const value = args[key2];
      if (typeof value === "string" && value.trim()) return value;
    }
    return void 0;
  };
  const target2 = pick("command", "file_path", "path", "pattern", "query", "url", "title", "description", "prompt");
  const own = {
    sys_os_shell: "Bash",
    shell: "Bash",
    exec_command: "Bash",
    sys_session_send: "Handing off to another agent",
    sys_read_inbox: "Checking on other agents",
    browser_navigate: "Opening a web page"
  };
  return describeStep(own[name] ?? name, target2);
}
function stepOf(item) {
  if (item.type === "function_call" && item.name) {
    let args = {};
    try {
      args = item.arguments ? JSON.parse(item.arguments) : {};
    } catch {
    }
    return omnigentStep(item.name, args);
  }
  if (item.type === "native_tool" && item.item) {
    const native = item.item;
    const name = [native.name, native.tool_name, native.tool, native.type].find((value) => typeof value === "string" && Boolean(value));
    const input = native.input ?? native.arguments ?? native.args;
    const args = typeof input === "object" && input ? input : typeof input === "string" ? { command: input } : {};
    return name ? omnigentStep(name, args) : void 0;
  }
  if (item.type === "terminal_command" && item.input) return describeStep("Bash", item.input);
  return void 0;
}
var sleep3 = (ms, signal) => new Promise((resolve, reject) => {
  if (signal.aborted) return reject(signal.reason);
  const timer = setTimeout(() => {
    signal.removeEventListener("abort", stop);
    resolve();
  }, ms);
  const stop = () => {
    clearTimeout(timer);
    reject(signal.reason);
  };
  signal.addEventListener("abort", stop, { once: true });
});
var Omnigent = class {
  constructor(client, workspaceId) {
    this.client = client;
    this.workspaceId = workspaceId;
  }
  /** Each session's host, for routing requests about it. */
  hosts = /* @__PURE__ */ new Map();
  /** The session in the workspace's Omnigent, or Omnigent itself. */
  webUrl(session) {
    const url = new URL(`${this.client.host}/omnigent${session ? `/c/${encodeURIComponent(session)}` : ""}`);
    if (this.workspaceId) url.searchParams.set("o", this.workspaceId);
    return url.toString();
  }
  async call(method, path, options = {}) {
    const host = options.session ? this.hosts.get(options.session) : void 0;
    const send = (routed) => this.client.request(`${OMNIGENT_API}${path}`, {
      method,
      ...options.body !== void 0 && { body: options.body },
      headers: { ...this.workspaceId && { "X-Databricks-Org-Id": this.workspaceId }, ...routed && host && { [SLICE_KEY]: host } },
      timeoutMs: 6e4,
      ...options.signal && { signal: options.signal }
    });
    let response = await send(true);
    if (response.status === 400 && host && /wrong_replica/.test(response.body)) response = await send(false);
    if (response.status < 200 || response.status >= 300) throw omnigentError(response);
    return response.body.trim() ? JSON.parse(response.body) : {};
  }
  /** Whether this workspace has Omnigent with Sandbox sessions; the reason when it doesn't. */
  async check(signal) {
    try {
      const info = await this.call("GET", "/v1/info", { ...signal && { signal } });
      return info.managed_sandboxes_enabled === false ? { ok: false, reason: "Omnigent is on in this workspace, but not with Databricks Sandbox sessions, which hosted agents use." } : { ok: true };
    } catch (error) {
      const status2 = error.status;
      if (status2 === 404) return { ok: false, reason: "Omnigent isn't on in this workspace. A workspace admin can turn on the Omnigent preview." };
      if (status2 === 401 || status2 === 403) return { ok: false, reason: "Omnigent turned this account away; it may not be enabled for you." };
      return { ok: false, reason: error.message };
    }
  }
  /** The workspace's Omnigent agents that run in its Sandboxes, best known first. */
  async agents(signal) {
    const listed = await this.call("GET", "/v1/agents?limit=200", { ...signal && { signal } });
    const order = Object.keys(KNOWN_AGENTS);
    return (listed.data ?? []).filter((agent) => SANDBOX_HARNESSES.has(agent.harness ?? "")).map((agent) => {
      const known = KNOWN_AGENTS[agent.name];
      const detail = known?.detail ?? agent.description ?? void 0;
      return { id: agent.id, name: agent.name, harness: agent.harness ?? "", label: omnigentAgentLabel(agent.name), ...detail && { detail } };
    }).sort((a, b) => (order.indexOf(a.name) + 1 || 99) - (order.indexOf(b.name) + 1 || 99) || a.label.localeCompare(b.label));
  }
  /** Makes a session for `agent` on a Sandbox that Omnigent runs. */
  async create(agent, title, signal) {
    const found = (await this.agents(signal)).find((candidate) => candidate.name === agent);
    if (!found) throw new Error(`This workspace's Omnigent has no agent named ${agent} that runs in a Databricks Sandbox.`);
    const created = await this.call("POST", "/v1/sessions", { body: { agent_id: found.id, host_type: "managed", title: title.slice(0, 120) }, ...signal && { signal } });
    const id = created.id ?? created.session_id;
    if (!id) throw new Error("Omnigent didn't return the new session.");
    return id;
  }
  async session(id, signal) {
    const snapshot = await this.call("GET", `/v1/sessions/${encodeURIComponent(id)}`, { session: id, ...signal && { signal } });
    if (snapshot.host_id) this.hosts.set(id, snapshot.host_id);
    return snapshot;
  }
  /** Sends a message; resolves with its item's ID once Omnigent has accepted it. */
  async send(id, text, signal) {
    const accepted = await this.call("POST", `/v1/sessions/${encodeURIComponent(id)}/events`, {
      session: id,
      body: { type: "message", data: { role: "user", content: [{ type: "input_text", text }] } },
      ...signal && { signal }
    });
    return accepted.item_id;
  }
  /** Asks the session to stop its current work. */
  async interrupt(id, signal) {
    await this.call("POST", `/v1/sessions/${encodeURIComponent(id)}/events`, { session: id, body: { type: "interrupt", data: {} }, ...signal && { signal } });
  }
  /** The session's items after `after` (all of them without it), oldest first. */
  async items(id, after, signal) {
    const found = [];
    let cursor = after;
    for (let page = 0; page < 20; page++) {
      const query = new URLSearchParams({ limit: "100", order: "asc", ...cursor && { after: cursor } });
      const list = await this.call("GET", `/v1/sessions/${encodeURIComponent(id)}/items?${query}`, { session: id, ...signal && { signal } });
      found.push(...list.data ?? []);
      if (!list.has_more || !list.last_id) break;
      cursor = list.last_id;
    }
    return found;
  }
  /** The session's newest item's ID. */
  async newest(id, signal) {
    const list = await this.call("GET", `/v1/sessions/${encodeURIComponent(id)}/items?limit=1&order=desc`, { session: id, ...signal && { signal } });
    return list.data?.[0]?.id;
  }
  /** Waits for a session's Sandbox: a new one has to start, and a stopped one Omnigent starts again on the next message. */
  async ready(id, fresh, signal, onStep) {
    const deadline = Date.now() + READY_TIMEOUT_MS;
    let stage = "";
    for (; ; ) {
      const snapshot = await this.session(id, signal);
      const launch = snapshot.sandbox_status;
      if (launch?.stage === "failed" || snapshot.status === "failed") throw new Error(`Omnigent couldn't start the session's Sandbox${launch?.error ? `: ${launch.error}` : "."}`);
      const launching = launch && launch.stage !== "ready";
      if (!launching && (snapshot.runner_online === true || !fresh && snapshot.host_resumable !== false)) return;
      if (launch && launch.stage !== stage) {
        stage = launch.stage;
        onStep?.({ tool: "Starting its Omnigent Sandbox", target: launch.stage });
      }
      if (Date.now() > deadline) throw new Error("Omnigent's Sandbox for this session didn't start in time.");
      await sleep3(POLL_MS2, signal);
    }
  }
  /**
   * One turn: sends the message (making the session first when needed),
   * follows the agent's work as steps and thoughts, and resolves with its last
   * message once the session is idle again. Stop (the signal) interrupts the
   * session's work.
   */
  async turn(input) {
    const { signal, onStep, onThought } = input;
    let id = input.session;
    let fresh = false;
    if (id) {
      try {
        await this.session(id, signal);
      } catch (error) {
        if (error.status !== 404) throw error;
        id = void 0;
      }
    }
    if (!id) {
      onStep?.({ tool: "Starting an Omnigent session", target: omnigentAgentLabel(input.agent) });
      id = await this.create(input.agent, input.title, signal);
      fresh = true;
      input.onSession?.(id);
    }
    await this.ready(id, fresh, signal, onStep);
    const before = fresh ? void 0 : await this.newest(id, signal);
    const sent = await this.send(id, input.text(fresh), signal);
    const session = id;
    try {
      return await this.follow(session, sent ?? before, fresh, signal, onStep, onThought);
    } catch (error) {
      if (signal.aborted) await this.interrupt(session).catch(() => {
      });
      throw error;
    }
  }
  async follow(id, after, fresh, signal, onStep, onThought) {
    let cursor = after;
    let started = false;
    let reply = "";
    let failure;
    let settle = 0;
    let approvalSince;
    const sentAt = Date.now();
    for (; ; ) {
      await sleep3(POLL_MS2, signal);
      const snapshot = await this.session(id, signal);
      const items = await this.items(id, cursor, signal);
      for (const item of items) {
        cursor = item.id;
        if (item.type === "message" && item.role === "user") continue;
        started = true;
        if (item.type === "message" && item.role === "assistant") {
          const text = textOf2(item.content);
          if (!text) continue;
          if (reply) onThought?.(reply);
          reply = text;
          continue;
        }
        if (item.type === "reasoning") {
          const text = textOf2(item.summary) || textOf2(item.content);
          if (text) onThought?.(text);
          continue;
        }
        if (item.type === "error") {
          failure = [item.title, item.message].filter(Boolean).join(": ") || "Omnigent reported an error.";
          continue;
        }
        const step = stepOf(item);
        if (step) onStep?.(step);
      }
      const failedInput = after ? snapshot.failed_inputs?.find((input) => input.id === after || input.item_id === after) : void 0;
      if (failedInput) throw new Error(`Omnigent couldn't take the message${typeof failedInput.error === "string" ? `: ${failedInput.error}` : "."}`);
      if (snapshot.status === "failed") throw new Error(failure ?? errorText(snapshot.last_task_error) ?? "The Omnigent session failed.");
      if (snapshot.status === "running") {
        started = true;
        settle = 0;
      }
      if (snapshot.pending_elicitations?.length) {
        approvalSince ??= Date.now();
        if (Date.now() - approvalSince > APPROVAL_GRACE_MS) {
          const note = `It's waiting for your approval in Omnigent before it goes on: [open the session](${this.webUrl(id)}).`;
          return { session: id, text: reply ? `${reply}

${note}` : note, fresh, waiting: true };
        }
        continue;
      }
      approvalSince = void 0;
      if (snapshot.status !== "idle") continue;
      if (!started) {
        if (Date.now() - sentAt > START_TIMEOUT_MS) throw new Error("Omnigent accepted the message but didn't start working on it.");
        continue;
      }
      if (reply || ++settle >= SETTLE_POLLS) {
        if (!reply && failure) throw new Error(failure);
        return { session: id, text: reply || "_It finished without a reply._", fresh, waiting: false };
      }
    }
  }
};
function errorText(error) {
  if (!error) return void 0;
  const message = error.message ?? error.detail ?? error.error;
  return typeof message === "string" && message ? snippet(message, 400) : void 0;
}

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
var Sql = class _Sql {
  constructor(client) {
    this.client = client;
  }
  async warehouses(signal) {
    const response = await this.client.get("/api/2.0/sql/warehouses", signal ? { signal } : {});
    return response.warehouses ?? [];
  }
  /** The best default: running serverless, any serverless, running, first. */
  static pick(warehouses) {
    return _Sql.rank(warehouses)[0];
  }
  /** Warehouses best first, in `pick`'s order. */
  static rank(warehouses) {
    const score = (w) => (w.enable_serverless_compute || w.warehouse_type === "SERVERLESS" ? 2 : 0) + (w.state === "RUNNING" ? 1 : 0);
    return [...warehouses].sort((a, b) => score(b) - score(a));
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
function isReadOnlySql(statement) {
  const stripped = statement.replace(/--[^\n]*/g, " ").replace(/\/\*[\s\S]*?\*\//g, " ").replace(/'(?:[^'\\]|\\.)*'/g, "''").replace(/`[^`]*`/g, "``").trim();
  const statements = stripped.split(";").map((part) => part.trim()).filter(Boolean);
  if (!statements.length) return false;
  return statements.every((part) => {
    const first = /^\(*\s*(\w+)/.exec(part)?.[1]?.toUpperCase();
    if (!first || !["SELECT", "WITH", "SHOW", "DESCRIBE", "DESC", "EXPLAIN", "VALUES", "TABLE", "LIST"].includes(first))
      return false;
    return !/\b(INSERT|UPDATE|DELETE|MERGE|DROP|CREATE|ALTER|TRUNCATE|GRANT|REVOKE|COPY|OPTIMIZE|VACUUM|REFRESH|RESTORE|CALL)\b/i.test(
      part.replace(/^WITH[\s\S]*?\bSELECT\b/i, "SELECT")
    );
  });
}

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
  async assign(entityType, entityName, key2, value = "") {
    const body = { entity_type: entityType, entity_name: entityName, tag_key: key2, ...value && { tag_value: value } };
    try {
      return await this.client.post("/api/2.1/unity-catalog/entity-tag-assignments", body);
    } catch (error) {
      const code = error.errorCode;
      if (code !== "ALREADY_EXISTS" && code !== "RESOURCE_ALREADY_EXISTS") throw error;
      return this.client.json(
        `/api/2.1/unity-catalog/entity-tag-assignments/${entityType}/${encodeURIComponent(entityName)}/tags/${encodeURIComponent(key2)}`,
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
  remove(entityType, entityName, key2) {
    return this.client.json(`/api/2.1/unity-catalog/entity-tag-assignments/${entityType}/${encodeURIComponent(entityName)}/tags/${encodeURIComponent(key2)}`, {
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
    const pairs = Object.entries(tags).map(([key2, value]) => `${quote(key2)} = ${quote(value)}`);
    if (!pairs.length) return;
    await new Sql(this.client).execute(`ALTER SCHEMA ${ident(catalog)}.${ident(schema2)} SET TAGS (${pairs.join(", ")})`, { warehouseId, timeoutMs: 12e4 });
  }
};

// packages/core/src/skill-catalog.ts
var SKILL_LOCATIONS = "skillLocations";
var FRESH_MS = 5 * 6e4;
var IDLE = { status: "idle", schemas: [], skills: [] };
var hostOf = (service) => {
  const snapshot = service.snapshot();
  return snapshot.status === "connected" ? snapshot.profile.host : void 0;
};
var schemaOf = (fullName) => fullName.split(".").slice(0, 2).join(".");
var refused = (error) => isApiError(error) && error.isPermission || /permission|not authorized|insufficient privileges|insufficient permissions/i.test(String(error?.message ?? error));
var SkillCatalog = class {
  constructor(service, options = {}) {
    this.service = service;
    this.options = options;
    service.subscribe(() => {
      const host = hostOf(service);
      if (host === this.host) return;
      this.host = host;
      this.loading = void 0;
      this.working = void 0;
      this.set(IDLE);
    });
    this.host = hostOf(service);
  }
  state = IDLE;
  host;
  loading;
  listeners = /* @__PURE__ */ new Set();
  /** The warehouse that last worked on Automatic, per workspace. */
  working;
  /** The warehouse chosen for this catalog, or undefined for Automatic. */
  chosenWarehouse() {
    return this.options.warehousePref ? this.service.preferences.get(this.options.warehousePref) || void 0 : void 0;
  }
  /**
   * Runs SQL work on a warehouse: the chosen one, or on Automatic the person's
   * default and then the others best first, moving on from any that refuse
   * the person. Tries at most four.
   */
  async withWarehouse(run) {
    const warehouses = await new Sql(await this.service.ready()).warehouses();
    const chosen = this.chosenWarehouse();
    if (chosen) {
      const warehouse = warehouses.find((w) => w.id === chosen || w.name === chosen);
      if (!warehouse) throw new Error("The SQL warehouse chosen for skills isn't available to you any more. Choose another in Settings \u2192 Databricks Knowledge.");
      return { result: await run(warehouse.id), warehouse: { id: warehouse.id, name: warehouse.name } };
    }
    const preferred = [this.working, this.service.preferences.get("warehouseId")].filter(Boolean);
    const ordered = [
      ...preferred.map((id) => warehouses.find((w) => w.id === id || w.name === id)).filter((w) => Boolean(w)),
      ...Sql.rank(warehouses)
    ].filter((w, index, all) => all.findIndex((other) => other.id === w.id) === index);
    if (!ordered.length) throw new Error("No SQL warehouse is available to you in this workspace.");
    let last;
    for (const warehouse of ordered.slice(0, 4)) {
      try {
        const result = await run(warehouse.id);
        this.working = warehouse.id;
        return { result, warehouse: { id: warehouse.id, name: warehouse.name } };
      } catch (error) {
        if (!refused(error)) throw error;
        last = error;
      }
    }
    throw new Error(`None of the SQL warehouses tried let you run queries (${describeError(last)}). Choose one you can use in Settings \u2192 Databricks Knowledge.`);
  }
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
        let warehouse;
        try {
          const found = await this.withWarehouse((id) => new Tags(client).schemas(id, [SKILLS_TAG, CHANNEL_TAG, DOMAIN_TAG]));
          tagged = found.result;
          warehouse = found.warehouse;
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
        const next = { status: "ready", schemas, skills, at: Date.now(), ...note && { note }, ...warehouse && { warehouse } };
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
      const lists2 = await Promise.all(
        schemas.map(async (schema2) => {
          const [catalog, name] = schema2.split(".");
          return (await skills.list(catalog, name).catch(() => [])).filter((skill) => skill.finalize_time || skill.bundle_name);
        })
      );
      return lists2.flat().map((skill) => ({ fullName: skill.name.replace(/^skills\//, ""), description: skill.description ?? skill.comment ?? "" })).sort((a, b) => a.fullName.localeCompare(b.fullName));
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

// plugins/agents/src/skills.ts
var SCHEMA = /^[^.\s]+\.[^.\s]+$/;
var SKILL = /^[^.\s]+\.[^.\s]+\.[^.\s]+$/;
function normalizeSkills(value) {
  const choice = value ?? {};
  const clean = (list, pattern) => [
    ...new Set(Array.isArray(list) ? list.filter((item) => typeof item === "string" && pattern.test(item)) : [])
  ];
  return { schemas: clean(choice.schemas, SCHEMA), names: clean(choice.names, SKILL), channel: choice.channel !== false };
}
var catalogs = /* @__PURE__ */ new WeakMap();
function skillCatalogFor(service, profile) {
  let byProfile = catalogs.get(service);
  if (!byProfile) catalogs.set(service, byProfile = /* @__PURE__ */ new Map());
  const key2 = profile ?? "";
  let catalog = byProfile.get(key2);
  if (!catalog) byProfile.set(key2, catalog = new SkillCatalog(profile && service.forProfile ? service.forProfile(profile) : service));
  return catalog;
}
async function resolveSkills(source, choice, channelId) {
  const problems = [];
  const state = await source.load();
  if (state.error) problems.push(state.error);
  else if (state.note) problems.push(state.note);
  const byName = new Map(state.skills.map((skill) => [skill.fullName, skill]));
  const picked = /* @__PURE__ */ new Map();
  for (const name of choice.names) {
    const skill = byName.get(name);
    if (skill) picked.set(name, skill);
    else if (!state.error) problems.push(`${name} isn't available to you`);
  }
  const schemas = new Set(choice.schemas);
  for (const skill of state.skills) if (schemas.has(schemaOf(skill.fullName))) picked.set(skill.fullName, skill);
  if (choice.channel && channelId) {
    try {
      for (const skill of await source.channelSkills(channelId)) picked.set(skill.fullName, skill);
    } catch (error) {
      problems.push(`Couldn't load this channel's skills: ${describeError(error)}`);
    }
  }
  return { skills: [...picked.values()].sort((a, b) => a.fullName.localeCompare(b.fullName)), problems };
}
var LISTED = 40;
var NAMES_LISTED = 100;
var DESCRIPTION_MAX = 200;
var shorten = (text, max) => {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}\u2026` : flat;
};
function skillsSection(skills) {
  if (!skills.length) return "";
  const listed = skills.slice(0, LISTED).map((skill) => `- ${skill.fullName}: ${shorten(skill.description, DESCRIPTION_MAX) || "(no description)"}`);
  const rest = skills.slice(LISTED);
  const more = rest.length ? `Also available, without descriptions: ${rest.slice(0, NAMES_LISTED).map((skill) => skill.fullName).join(", ")}${rest.length > NAMES_LISTED ? `, and ${rest.length - NAMES_LISTED} more` : ""}.` : "";
  return [
    "<databricks-skills>",
    "These skills are written instructions for particular kinds of work. Before you follow one, load it with skills_load, using its full name, and follow what it says. When it points to other files, read them with skills_read_files.",
    ...listed,
    more,
    "</databricks-skills>"
  ].filter(Boolean).join("\n");
}
function skillsNote(skills) {
  return skills.length ? "Your owner's skills are installed in your Sandbox's skill folders. When one matches the task, follow its instructions." : "";
}
var FILE_CHARS = 12e3;
var NAMES_IN_ERRORS = 60;
var clipText = (text, max) => text.length > max ? `${text.slice(0, max)}
\u2026 (${text.length - max} characters cut)` : text;
function skillTools(api, skills) {
  const byName = new Map(skills.map((skill) => [skill.fullName, skill]));
  const find = (raw) => {
    const name = typeof raw === "string" ? raw.trim() : "";
    const found = byName.get(name);
    if (found) return found;
    const names = [...byName.keys()].slice(0, NAMES_IN_ERRORS);
    return `There is no skill named "${name}". Your skills are: ${names.join(", ") || "none"}.`;
  };
  const nameParameter = { type: "string", description: "The skill's full name, as listed in your skills." };
  return [
    {
      name: "skills_load",
      description: "Loads one of your skills: its SKILL.md instructions, and the names of its other files. Load a skill before you follow it.",
      parameters: { type: "object", properties: { name: nameParameter }, required: ["name"] },
      async run(args, signal) {
        const found = find(args.name);
        if (typeof found === "string") return found;
        const skills2 = await api(signal);
        const [markdown, files] = await Promise.all([skills2.load(found.fullName, signal), skills2.files(found.fullName, signal).catch(() => [])]);
        const others = files.filter((path) => path !== "SKILL.md");
        return [
          clipText(markdown.trim(), 2e4),
          others.length ? `Other files in this skill (read them with skills_read_files): ${others.join(", ")}` : ""
        ].filter(Boolean).join("\n\n");
      }
    },
    {
      name: "skills_read_files",
      description: "Reads some of a skill's files, such as the ones its SKILL.md points to. Pass the skill's full name and the file paths that skills_load listed.",
      parameters: {
        type: "object",
        properties: { name: nameParameter, paths: { type: "array", items: { type: "string" }, description: "Up to 10 file paths, relative to the skill." } },
        required: ["name", "paths"]
      },
      async run(args, signal) {
        const found = find(args.name);
        if (typeof found === "string") return found;
        const wanted = (Array.isArray(args.paths) ? args.paths : [args.paths]).filter((path) => typeof path === "string" && path.length > 0).slice(0, 10);
        if (!wanted.length) return "Pass the paths of the files to read.";
        const skills2 = await api(signal);
        const files = new Set(await skills2.files(found.fullName, signal));
        const parts = [];
        for (const path of wanted) {
          if (!files.has(path)) {
            parts.push(`${path}: not a file in ${found.fullName}`);
            continue;
          }
          parts.push(`=== ${path} ===
${clipText(await skills2.read(found.fullName, path, signal), FILE_CHARS)}`);
        }
        return parts.join("\n\n");
      }
    }
  ];
}

// plugins/agents/src/skills-sandbox.ts
var SKILL_ROOTS = [`${SANDBOX_HOME}/.claude/skills`, `${SANDBOX_HOME}/.agents/skills`];
var SKILLS_MANIFEST = `${SANDBOX_HOME}/.buzz/skills/manifest.json`;
var SEPARATOR = "@@buzz-skills@@";
var FOLDER = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/;
var FILES_MAX = 300;
function folderOf(skill, bundle) {
  const name = bundle || skill.split(".").pop() || "";
  return FOLDER.test(name) && !name.includes("..") ? name : void 0;
}
var versionOf = (skill) => [skill.etag, skill.update_time, skill.finalize_time].filter(Boolean).join("|") || "unversioned";
function planSync(desired, installed, present) {
  const plan = { add: [], update: [], unchanged: [], remove: [], skipped: [] };
  const taken = /* @__PURE__ */ new Set();
  for (const item of desired) {
    if (taken.has(item.folder)) {
      plan.skipped.push({ skill: item.skill, reason: `another skill already uses the folder ${item.folder}` });
      continue;
    }
    taken.add(item.folder);
    const mine = installed[item.folder];
    if (!present.has(item.folder)) plan.add.push(item);
    else if (!mine) plan.skipped.push({ skill: item.skill, reason: `a folder named ${item.folder} is already there, and Buzz didn't install it` });
    else if (mine.skill !== item.skill || mine.version !== item.version) plan.update.push(item);
    else plan.unchanged.push(item);
  }
  for (const folder of Object.keys(installed)) if (!taken.has(folder)) plan.remove.push(folder);
  return plan;
}
var safePath = (path) => path.length > 0 && !path.startsWith("/") && !path.split("/").some((part) => part === "" || part === "." || part === "..");
function parseManifest(text) {
  try {
    const parsed = JSON.parse(text);
    const roots = {};
    for (const [root, entries] of Object.entries(parsed?.roots ?? {})) {
      roots[root] = {};
      for (const [folder, entry] of Object.entries(entries ?? {}))
        if (FOLDER.test(folder) && typeof entry?.skill === "string" && typeof entry.version === "string") roots[root][folder] = { skill: entry.skill, version: entry.version };
    }
    return { roots };
  } catch {
    return { roots: {} };
  }
}
async function writeSkill(sandboxes, sandbox, api, root, item, signal) {
  const dir = `${root}/${item.folder}`;
  const files = (await api.files(item.skill, signal)).filter(safePath);
  if (!files.includes("SKILL.md")) throw new Error("it has no SKILL.md");
  if (files.length > FILES_MAX) throw new Error(`it has more than ${FILES_MAX} files`);
  try {
    for (const path of files) await sandboxes.writeFile(sandbox, `${dir}/${path}`, await api.read(item.skill, path, signal), signal);
  } catch (error) {
    await sandboxes.bash(sandbox, `rm -rf -- ${shellQuote(dir)}`, { timeoutSeconds: 30 }).catch(() => {
    });
    throw error;
  }
}
var queues = /* @__PURE__ */ new Map();
function installSkills(input) {
  const previous = queues.get(input.sandbox) ?? Promise.resolve();
  const next = previous.catch(() => {
  }).then(() => syncOnce(input));
  queues.set(input.sandbox, next);
  return next;
}
async function syncOnce({ sandboxes, sandbox, api, skills, signal }) {
  const outcome = { added: /* @__PURE__ */ new Set(), updated: /* @__PURE__ */ new Set(), removed: /* @__PURE__ */ new Set(), unchanged: /* @__PURE__ */ new Set(), problems: /* @__PURE__ */ new Set() };
  const timeout = { timeoutSeconds: 60, ...signal && { signal } };
  const before = await sandboxes.bash(sandbox, `cat ${shellQuote(SKILLS_MANIFEST)} 2>/dev/null; true`, timeout);
  const manifest = parseManifest(before.stdout ?? "");
  const hasInstalled = Object.values(manifest.roots).some((entries) => Object.keys(entries).length > 0);
  if (!skills.length && !hasInstalled) return { added: [], updated: [], removed: [], unchanged: [], problems: [] };
  const present = /* @__PURE__ */ new Map();
  if (skills.length) {
    const listing = await sandboxes.bash(
      sandbox,
      SKILL_ROOTS.map((root) => `ls -1A ${shellQuote(root)} 2>/dev/null; echo ${SEPARATOR}`).join("\n"),
      timeout
    );
    const parts = (listing.stdout ?? "").split(`${SEPARATOR}
`);
    SKILL_ROOTS.forEach((root, index) => present.set(root, new Set((parts[index] ?? "").split("\n").map((line) => line.trim()).filter(Boolean))));
  }
  const versions = /* @__PURE__ */ new Map();
  const failed = /* @__PURE__ */ new Set();
  const schemas = [...new Set(skills.map((skill) => schemaOf(skill.fullName)))];
  await Promise.all(
    schemas.map(async (schema2) => {
      const [catalog, name] = schema2.split(".");
      try {
        for (const skill of await api.list(catalog, name, signal)) versions.set(skillFullName(skill.name), { ...skill.bundle_name && { bundle: skill.bundle_name }, version: versionOf(skill) });
      } catch (error) {
        failed.add(schema2);
        outcome.problems.add(`Couldn't check the skills in ${schema2}: ${describeError(error)}`);
      }
    })
  );
  const desired = [];
  for (const skill of skills) {
    const info = versions.get(skill.fullName);
    if (!info) {
      if (!failed.has(schemaOf(skill.fullName))) outcome.problems.add(`${skill.fullName} isn't listed in its schema`);
      continue;
    }
    const folder = folderOf(skill.fullName, info.bundle);
    if (!folder) {
      outcome.problems.add(`${skill.fullName} has no folder name the agent can use`);
      continue;
    }
    desired.push({ skill: skill.fullName, folder, version: info.version });
  }
  const next = { roots: {} };
  for (const root of SKILL_ROOTS) {
    const installed = manifest.roots[root] ?? {};
    const plan = planSync(desired, installed, present.get(root) ?? /* @__PURE__ */ new Set());
    for (const skipped of plan.skipped) outcome.problems.add(`${skipped.skill} isn't installed: ${skipped.reason}`);
    const kept = {};
    for (const item of plan.unchanged) {
      kept[item.folder] = { skill: item.skill, version: item.version };
      outcome.unchanged.add(item.skill);
    }
    const gone = [...plan.remove, ...plan.update.map((item) => item.folder)].filter((folder) => FOLDER.test(folder));
    const cleared = gone.length ? await sandboxes.bash(sandbox, `rm -rf -- ${gone.map((folder) => shellQuote(`${root}/${folder}`)).join(" ")}`, timeout) : { exit_code: 0 };
    const clearFailed = (cleared.exit_code ?? 0) !== 0;
    for (const folder of plan.remove) {
      if (clearFailed) kept[folder] = installed[folder];
      else outcome.removed.add(installed[folder]?.skill ?? folder);
    }
    for (const item of [...plan.add, ...plan.update]) {
      const isUpdate = plan.update.includes(item);
      try {
        await writeSkill(sandboxes, sandbox, api, root, item, signal);
        kept[item.folder] = { skill: item.skill, version: item.version };
        (isUpdate ? outcome.updated : outcome.added).add(item.skill);
      } catch (error) {
        outcome.problems.add(`Couldn't install ${item.skill}: ${describeError(error)}`);
      }
    }
    next.roots[root] = kept;
  }
  const changed = JSON.stringify(next) !== JSON.stringify(manifest);
  if (changed) await sandboxes.writeFile(sandbox, SKILLS_MANIFEST, `${JSON.stringify(next, null, 2)}
`, signal);
  return {
    added: [...outcome.added],
    updated: [...outcome.updated],
    removed: [...outcome.removed],
    unchanged: [...outcome.unchanged],
    problems: [...outcome.problems]
  };
}

// packages/core/src/api/ai.ts
var DEFAULT_MODELS = [
  { id: "system.ai.claude-sonnet-5-5", label: "Claude Sonnet 5.5" },
  { id: "system.ai.claude-opus-5-5", label: "Claude Opus 5.5" },
  { id: "system.ai.claude-haiku-5-5", label: "Claude Haiku 5.5" },
  { id: "system.ai.gpt-5-6-sol", label: "GPT-5.6 Sol" }
];
var DEFAULT_MODEL = DEFAULT_MODELS[0].id;
function messageText(content) {
  if (typeof content === "string") return content;
  if (!content) return "";
  return content.map((part) => part.text ?? "").join("");
}
var UPPER = /* @__PURE__ */ new Set(["gpt", "glm", "oss", "bge", "gte"]);
var NAMED = { deepseek: "DeepSeek", openai: "OpenAI" };
function modelLabel(name) {
  const leaf = name.split(".").pop() ?? name;
  const words = [];
  for (const token of leaf.split(/[-_]+/).filter(Boolean)) {
    const last = words.length - 1;
    if (/^\d{1,2}$/.test(token) && last >= 0 && /^[A-Z]?\d+(\.\d+)*$/.test((words[last] ?? "").split(/[ -]/).pop() ?? "")) {
      words[last] += `.${token}`;
      continue;
    }
    if (/^\d{1,2}$/.test(token) && last >= 0 && words[last] === "GPT") {
      words[last] += `-${token}`;
      continue;
    }
    const lower = token.toLowerCase();
    if (UPPER.has(lower)) words.push(lower.toUpperCase());
    else if (NAMED[lower]) words.push(NAMED[lower]);
    else if (/^\d+[a-z]$|^[a-z]\d+[a-z]?$/i.test(token)) words.push(token.toUpperCase());
    else words.push(token.charAt(0).toUpperCase() + token.slice(1));
  }
  return words.join(" ");
}
var NO_REASONING_WITH_TOOLS = /* @__PURE__ */ new Set();
var needsReasoningOff = (error) => /reasoning_effort/i.test(error?.message ?? "") && /not supported/i.test(error?.message ?? "");
var Ai = class {
  constructor(client) {
    this.client = client;
  }
  /** Remembers which chat route the workspace answers. */
  route;
  async chat(request) {
    const tools = Boolean(request.tools?.length);
    const body = {
      model: request.model,
      messages: request.messages,
      ...tools && { tools: request.tools, tool_choice: "auto" },
      max_tokens: request.maxTokens ?? 4096,
      ...request.temperature !== void 0 && { temperature: request.temperature },
      ...tools && NO_REASONING_WITH_TOOLS.has(request.model) && { reasoning_effort: "none" }
    };
    try {
      return await this.send(request.model, body, request.signal);
    } catch (error) {
      if (!tools || NO_REASONING_WITH_TOOLS.has(request.model) || !needsReasoningOff(error)) throw error;
      NO_REASONING_WITH_TOOLS.add(request.model);
      return this.send(request.model, { ...body, reasoning_effort: "none" }, request.signal);
    }
  }
  async send(model, body, signal) {
    const request = { model, signal };
    const init = { timeoutMs: 17e4, ...request.signal && { signal: request.signal } };
    if (this.route !== "serving") {
      try {
        const response = await this.client.post("/ai-gateway/mlflow/v1/chat/completions", body, init);
        this.route = "gateway";
        return response;
      } catch (error) {
        const status2 = error.status;
        if (this.route === "gateway" || status2 !== 404 && status2 !== 405) throw error;
      }
    }
    this.route = "serving";
    if (request.model.startsWith("system.ai."))
      return this.client.post("/serving-endpoints/chat/completions", body, init);
    return this.client.post(
      `/serving-endpoints/${encodeURIComponent(request.model)}/invocations`,
      { ...body, model: void 0 },
      init
    );
  }
  /**
   * Chat models in AI Gateway: the Unity Catalog model services the person can
   * use (Databricks' system.ai models and any their team registered), built-ins
   * first. Embedding-only services are left out.
   */
  async models(signal) {
    const out = [];
    let pageToken;
    for (let page = 0; page < 30; page++) {
      const response = await this.client.get("/api/2.1/unity-catalog/model-services", { query: { page_size: 100, page_token: pageToken }, ...signal && { signal } });
      for (const service of response.model_services ?? []) {
        if (!(service.supported_api_types ?? []).includes("mlflow/v1/chat/completions")) continue;
        const id = service.name.replace(/^model-services\//, "");
        out.push({ id, label: modelLabel(id), tools: service.capabilities?.function_calling !== false, builtIn: id.startsWith("system.ai.") });
      }
      pageToken = response.next_page_token;
      if (!pageToken) break;
    }
    return out.sort((a, b) => Number(b.builtIn) - Number(a.builtIn) || a.label.localeCompare(b.label, void 0, { numeric: true }));
  }
  /** Databricks Apps the person can see, for agents deployed as apps. */
  async apps(signal) {
    const out = [];
    let pageToken;
    for (let page = 0; page < 10; page++) {
      const response = await this.client.get("/api/2.0/apps", { query: { page_size: 100, page_token: pageToken }, ...signal && { signal } });
      for (const app of response.apps ?? [])
        if (app.url)
          out.push({ name: app.name, url: app.url, ...app.description && { description: app.description }, running: app.compute_status?.state === "ACTIVE" });
      pageToken = response.next_page_token;
      if (!pageToken) break;
    }
    return out.sort((a, b) => a.name.localeCompare(b.name));
  }
  /** Serving endpoints the user can see, with their task. */
  async endpoints(signal) {
    const response = await this.client.get("/api/2.0/serving-endpoints", signal ? { signal } : {});
    return (response.endpoints ?? []).map((endpoint) => ({
      name: endpoint.name,
      task: endpoint.task ?? "",
      ready: endpoint.state?.ready === "READY",
      description: endpoint.description,
      isAgent: /^agent\//.test(endpoint.task ?? "") || (endpoint.tags ?? []).some((tag) => /agent/i.test(tag.key)),
      isChat: /chat|responses/.test(endpoint.task ?? ""),
      label: endpoint.config?.served_entities?.[0]?.foundation_model?.display_name ?? endpoint.name
    }));
  }
  /**
   * Calls a custom agent with a conversation and returns its reply text.
   * `target` is a serving endpoint name, or an https:// Databricks App URL.
   */
  async invokeAgent(target2, messages, options = {}) {
    const init = { timeoutMs: 175e3, ...options.signal && { signal: options.signal } };
    if (/^https:\/\//.test(target2)) {
      const base2 = target2.replace(/\/+$/, "");
      try {
        const raw3 = await this.client.post(`${base2}/api/invocations`, {
          input: messages,
          ...options.sessionId && { session_id: options.sessionId }
        }, init);
        return { text: agentText(raw3), raw: raw3 };
      } catch (error) {
        const status2 = error.status;
        if (status2 !== 404 && status2 !== 405) throw error;
      }
      const raw2 = await this.client.post(`${base2}/responses`, { input: messages }, init);
      return { text: agentText(raw2), raw: raw2 };
    }
    const path = `/serving-endpoints/${encodeURIComponent(target2)}/invocations`;
    const task = options.task ?? "";
    const body = /responses/.test(task) ? { input: messages, ...options.sessionId && { custom_inputs: { session_id: options.sessionId } } } : { messages };
    const raw = await this.client.post(path, body, init);
    return { text: agentText(raw), raw };
  }
};
function agentText(raw) {
  if (typeof raw === "string") return raw;
  if (!raw || typeof raw !== "object") return "";
  const value = raw;
  if (Array.isArray(value.output)) {
    const texts = value.output.filter((item) => item.type === "message" || item.content).flatMap(
      (item) => Array.isArray(item.content) ? item.content.map((part) => part.text ?? "") : typeof item.content === "string" ? [item.content] : []
    );
    if (texts.join("").trim()) return texts.join("\n").trim();
  }
  if (typeof value.output_text === "string") return value.output_text;
  if (Array.isArray(value.choices)) {
    const message = value.choices[0]?.message;
    if (message) return messageText(message.content);
  }
  if (Array.isArray(value.messages)) {
    const last = [...value.messages].reverse().find((m) => m.role === "assistant");
    if (typeof last?.content === "string") return last.content;
  }
  if (Array.isArray(value.predictions)) return agentText(value.predictions[0]);
  if (typeof value.content === "string") return value.content;
  return JSON.stringify(raw).slice(0, 4e3);
}

// packages/core/src/ui/workspace.tsx
var hostname = (host) => new URL(host).hostname;
var ADD = "__add__";
function useWorkspaceService(service, profile) {
  return React.useMemo(() => profile && service.forProfile ? service.forProfile(profile) : service, [service, profile]);
}
function BrowserWait(props) {
  const { cancelSignIn } = props.service;
  return /* @__PURE__ */ React.createElement(Stack, { direction: "row", gap: 8, align: "center", justify: "space-between" }, /* @__PURE__ */ React.createElement(Stack, { direction: "row", gap: 6, align: "center" }, /* @__PURE__ */ React.createElement(Spinner, { size: 11 }), /* @__PURE__ */ React.createElement(Text, { tone: "subtle", size: "sm" }, "Finish signing in in your browser", props.host ? ` (${hostname(props.host)})` : "", ".")), cancelSignIn && /* @__PURE__ */ React.createElement(Button, { size: "sm", variant: "ghost", onClick: () => cancelSignIn() }, "Cancel"));
}
function WorkspaceStatus(props) {
  const { service, snapshot } = props;
  const signIn = (label) => service.reauthenticate ? /* @__PURE__ */ React.createElement(Button, { size: "sm", variant: "brand", onClick: () => void service.reauthenticate() }, label) : void 0;
  switch (snapshot.status) {
    case "checking":
    case "connecting":
      return /* @__PURE__ */ React.createElement(Stack, { direction: "row", gap: 6, align: "center" }, /* @__PURE__ */ React.createElement(Spinner, { size: 11 }), /* @__PURE__ */ React.createElement(Text, { tone: "subtle", size: "sm" }, "Connecting\u2026"));
    case "signing-in":
      return /* @__PURE__ */ React.createElement(BrowserWait, { service, ...snapshot.host && { host: snapshot.host } });
    case "connected":
      return /* @__PURE__ */ React.createElement(Text, { tone: "subtle", size: "sm" }, "Signed in to ", hostname(snapshot.profile.host), " as ", snapshot.user.userName, ".");
    case "error":
      return /* @__PURE__ */ React.createElement(Notice, { tone: "warning", action: signIn(snapshot.needsSignIn ? "Sign in again" : "Sign in") }, snapshot.needsSignIn ? "Your sign-in to this workspace has expired." : snapshot.message);
    case "signed-out":
      return /* @__PURE__ */ React.createElement(Notice, { tone: "warning", action: signIn("Sign in") }, snapshot.error ?? "You're not signed in to this workspace.");
    default:
      return null;
  }
}
function WorkspaceField(props) {
  const main = useConnection(props.service);
  const workspace = useWorkspaceService(props.service, props.profile);
  const current = useConnection(workspace);
  const [adding, setAdding] = React.useState(false);
  const [url, setUrl] = React.useState("");
  const [state, setState] = React.useState({});
  if (!props.service.forProfile) return null;
  const host = (snapshot) => "profile" in snapshot ? new URL(snapshot.profile.host).hostname : void 0;
  const profiles = props.service.profiles();
  const mainName = main.status === "connected" ? main.profile.name : void 0;
  const signIn = async () => {
    setState({ busy: true });
    try {
      const profile = await props.service.addWorkspace(url.trim() ? { host: url.trim() } : {});
      props.onChange(profile === mainName ? void 0 : profile);
      setAdding(false);
      setUrl("");
      setState({});
    } catch (error) {
      setState({ error: describeError(error) });
    }
  };
  return /* @__PURE__ */ React.createElement(Field, { label: "Workspace", hint: "Uses your Databricks CLI sign-in for that workspace." }, /* @__PURE__ */ React.createElement(Stack, { gap: 8 }, /* @__PURE__ */ React.createElement(
    "select",
    {
      className: "dbx-select",
      disabled: props.disabled,
      value: adding ? ADD : props.profile ?? "",
      onChange: (event) => {
        const value = event.target.value;
        if (value === ADD) return setAdding(true);
        setAdding(false);
        props.onChange(value && value !== mainName ? value : void 0);
      }
    },
    /* @__PURE__ */ React.createElement("option", { value: "" }, "Same as Buzz", host(main) ? ` \xB7 ${host(main)}` : ""),
    profiles.filter((profile) => profile.name !== mainName).map((profile) => /* @__PURE__ */ React.createElement("option", { key: profile.name, value: profile.name }, profile.name, " \xB7 ", new URL(profile.host).hostname)),
    /* @__PURE__ */ React.createElement("option", { value: ADD }, "Sign in to another workspace\u2026")
  ), adding && /* @__PURE__ */ React.createElement(Stack, { direction: "row", gap: 8, align: "center" }, /* @__PURE__ */ React.createElement("input", { className: "dbx-input", placeholder: "https://\u2026 (blank to choose in the browser)", value: url, onChange: (event) => setUrl(event.target.value), style: { flex: 1 } }), /* @__PURE__ */ React.createElement(Button, { variant: "brand", disabled: state.busy, onClick: () => void signIn() }, state.busy ? /* @__PURE__ */ React.createElement(Spinner, { size: 12 }) : null, "Sign in")), state.busy && /* @__PURE__ */ React.createElement(Text, { tone: "subtle", size: "sm" }, "Finish signing in in your browser."), state.error && /* @__PURE__ */ React.createElement(Text, { tone: "danger", size: "sm" }, state.error), props.profile && !adding && /* @__PURE__ */ React.createElement(WorkspaceStatus, { service: workspace, snapshot: current })));
}

// plugins/agents/src/ui.tsx
var KINDS = [
  {
    id: "sandbox",
    label: "Sandbox agent",
    short: "A model with its own Sandbox and the tools you pick",
    Icon: SandboxKindIcon,
    detail: "A model with its own Databricks Sandbox to run code, plus the tools you pick."
  },
  {
    id: "genie-one",
    label: "Genie One",
    short: "Answers about any data you can access",
    Icon: GenieKindIcon,
    detail: "Answers questions about any data you can access, with a chart, the SQL and a link. Nothing to set up."
  },
  {
    id: "custom",
    label: "Custom agent",
    short: "Agent Bricks, Model Serving, an App or a Genie agent",
    Icon: CustomKindIcon,
    detail: "An agent you already have: Agent Bricks or Model Serving, a Databricks App, or a Genie agent."
  }
];
var settling = (status2) => status2 === "checking" || status2 === "connecting" || status2 === "signing-in";
var loads = (status2) => status2 === "connected" || settling(status2);
function NeedsConnection(props) {
  const { service } = props;
  const snapshot = useConnection(service);
  if (snapshot.status === "signing-in") return /* @__PURE__ */ React.createElement(BrowserWait, { service, ...snapshot.host && { host: snapshot.host } });
  if (snapshot.status === "connected" || settling(snapshot.status)) return null;
  const expired = snapshot.status === "error" && snapshot.needsSignIn && service.reauthenticate;
  const action = expired ? /* @__PURE__ */ React.createElement(Button, { size: "sm", variant: "brand", onClick: () => void service.reauthenticate() }, "Sign in again") : snapshot.status === "signed-out" ? /* @__PURE__ */ React.createElement(Button, { size: "sm", variant: "brand", onClick: () => void service.signIn() }, "Sign in with Databricks") : /* @__PURE__ */ React.createElement(Button, { size: "sm", variant: "brand", onClick: () => service.openSettings() }, "Connect");
  return /* @__PURE__ */ React.createElement(Notice, { tone: "warning", title: expired ? "Your Databricks sign-in has expired" : "Databricks isn't connected", action }, snapshot.status === "signed-out" && snapshot.error ? snapshot.error : "These agents run on Databricks with your sign-in.");
}
function AgentForm(props) {
  const { config, onChange } = props;
  const workspace = useAgentService(props.service, config.profile);
  const kind = KINDS.find((candidate) => candidate.id === config.kind) ?? KINDS[1];
  return /* @__PURE__ */ React.createElement(DbxRoot, null, /* @__PURE__ */ React.createElement(Stack, { gap: 14 }, /* @__PURE__ */ React.createElement(NeedsConnection, { service: props.service }), props.intro, /* @__PURE__ */ React.createElement(
    SinglePicker,
    {
      label: "Type",
      hint: kind.detail,
      value: kind.id,
      placeholder: "Genie One",
      search: false,
      options: KINDS.map((candidate) => ({ id: candidate.id, label: candidate.label, group: "", detail: candidate.short, icon: /* @__PURE__ */ React.createElement(candidate.Icon, null) })),
      ...props.disabled !== void 0 && { disabled: props.disabled },
      onChange: (option) => onChange({ ...config, kind: option.id })
    }
  ), /* @__PURE__ */ React.createElement(
    WorkspaceField,
    {
      service: props.service,
      ...config.profile && { profile: config.profile },
      disabled: props.disabled,
      onChange: (profile) => {
        const { profile: _profile, custom: _custom, ...rest } = config;
        onChange({ ...rest, ...profile && { profile }, tools: config.tools.filter((tool) => tool.kind === "genie-one") });
      }
    }
  ), kind.id === "sandbox" && /* @__PURE__ */ React.createElement(
    SandboxFields,
    {
      service: props.service,
      workspace,
      config,
      onChange,
      ...props.disabled !== void 0 && { disabled: props.disabled }
    }
  ), kind.id === "custom" && /* @__PURE__ */ React.createElement(
    CustomAgentField,
    {
      service: workspace,
      ...config.custom && { value: config.custom },
      ...props.disabled !== void 0 && { disabled: props.disabled },
      onChange: (custom) => onChange({ ...config, custom })
    }
  ), kind.id !== "sandbox" && /* @__PURE__ */ React.createElement(Text, { tone: "subtle", size: "sm" }, "Mention it in any thread or add it to a room. Each thread keeps its own conversation for follow-ups.")));
}
function SandboxFields(props) {
  const { config, onChange, workspace } = props;
  const status2 = useConnection(workspace).status;
  const available = useAsync(() => cachedList(workspace, "sandbox", async () => new Sandboxes(await workspace.ready()).available()), [workspace, status2]);
  const harness = HARNESSES.find((candidate) => candidate.id === config.harness) ?? HARNESSES[0];
  const remote = isRemote(harness.id) ? harness.id : void 0;
  const disabled = props.disabled !== void 0 ? { disabled: props.disabled } : {};
  return /* @__PURE__ */ React.createElement(React.Fragment, null, available.data === false && /* @__PURE__ */ React.createElement(Notice, { tone: "warning" }, remote ? `Databricks Sandbox isn't on in this workspace, and ${harness.label} runs there. An admin can turn on the preview.` : "Databricks Sandbox isn't on in this workspace, so this agent can't run code until an admin turns on the preview."), /* @__PURE__ */ React.createElement(Field, { label: "Harness", hint: harness.detail }, /* @__PURE__ */ React.createElement(
    "select",
    {
      className: "dbx-select",
      ...disabled,
      value: harness.id,
      onChange: (event) => {
        const next = event.target.value;
        const model = isRemote(next) && !harnessAccepts(next, config.model) ? HARNESS_MODEL[next] : config.model;
        onChange({ ...config, harness: next, model });
      }
    },
    HARNESSES.map((candidate) => /* @__PURE__ */ React.createElement("option", { key: candidate.id, value: candidate.id }, candidate.label))
  )), /* @__PURE__ */ React.createElement(
    ModelField,
    {
      service: workspace,
      value: config.model,
      ...disabled,
      ...remote && { accepts: (id) => harnessAccepts(remote, id), hint: `Models ${harness.label} can use, from AI Gateway in this workspace.` },
      onChange: (model) => onChange({ ...config, model })
    }
  ), remote && /* @__PURE__ */ React.createElement(Field, { label: "Permissions", hint: permissionsHint(remote, config.permissions) }, /* @__PURE__ */ React.createElement("select", { className: "dbx-select", ...disabled, value: config.permissions, onChange: (event) => onChange({ ...config, permissions: event.target.value }) }, /* @__PURE__ */ React.createElement("option", { value: "standard" }, "Standard"), /* @__PURE__ */ React.createElement("option", { value: "full" }, "Full access"))), /* @__PURE__ */ React.createElement(ToolsField, { service: workspace, tools: config.tools, ...disabled, onChange: (tools) => onChange({ ...config, tools }) }), /* @__PURE__ */ React.createElement(SkillsField, { service: props.service, ...config.profile && { profile: config.profile }, value: config.skills, ...disabled, onChange: (skills) => onChange({ ...config, skills }) }), /* @__PURE__ */ React.createElement(Field, { label: "Conversation", hint: "Thread: each thread is its own conversation. Channel: one conversation for the whole channel." }, /* @__PURE__ */ React.createElement("select", { className: "dbx-select", disabled: props.disabled, value: config.scope, onChange: (event) => onChange({ ...config, scope: event.target.value }) }, /* @__PURE__ */ React.createElement("option", { value: "thread" }, "One per thread"), /* @__PURE__ */ React.createElement("option", { value: "channel" }, "One per channel"))), /* @__PURE__ */ React.createElement(Field, { label: "Instructions", hint: "Optional. Who it is, what it should focus on, how to answer." }, /* @__PURE__ */ React.createElement("textarea", { className: "dbx-textarea", rows: 5, disabled: props.disabled, value: config.instructions, onChange: (event) => onChange({ ...config, instructions: event.target.value }) })));
}
function SettingsTab(props) {
  const [draft, setDraft] = React.useState(props.config);
  const [state, setState] = React.useState({});
  const dirty = JSON.stringify(draft) !== JSON.stringify(props.config);
  return /* @__PURE__ */ React.createElement(DbxRoot, { style: { padding: "4px 0 24px" } }, /* @__PURE__ */ React.createElement(Stack, { gap: 16 }, /* @__PURE__ */ React.createElement(props.Form, { service: props.service, config: draft, onChange: setDraft, disabled: state.saving }), props.note, state.error && /* @__PURE__ */ React.createElement(Notice, { tone: "danger" }, state.error), /* @__PURE__ */ React.createElement(Stack, { direction: "row", gap: 8, justify: "flex-end", align: "center" }, state.saved && !dirty && /* @__PURE__ */ React.createElement(Text, { tone: "success", size: "sm" }, "Saved"), /* @__PURE__ */ React.createElement(Button, { variant: "ghost", disabled: !dirty || state.saving, onClick: () => setDraft(props.config) }, "Revert"), /* @__PURE__ */ React.createElement(
    Button,
    {
      variant: "primary",
      disabled: !dirty || state.saving,
      onClick: () => {
        setState({ saving: true });
        props.save(draft).then(
          () => setState({ saved: true }),
          (error) => setState({ error: describeError(error) })
        );
      }
    },
    state.saving ? "Saving\u2026" : "Save"
  ))));
}
var useAgentService = useWorkspaceService;
var LIST_TTL_MS = 5 * 6e4;
var lists = /* @__PURE__ */ new WeakMap();
function cachedList(service, key2, load) {
  let entries = lists.get(service);
  if (!entries) lists.set(service, entries = /* @__PURE__ */ new Map());
  const found = entries.get(key2);
  if (found && Date.now() - found.at < LIST_TTL_MS) return found.value;
  const value = load();
  const kept = entries;
  kept.set(key2, { at: Date.now(), value });
  value.catch(() => {
    if (kept.get(key2)?.value === value) kept.delete(key2);
  });
  return value;
}
function filterOptions(options, query) {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  const matches = words.length ? options.filter((option) => {
    const text = `${option.label} ${option.detail ?? ""} ${option.meta ?? ""} ${option.keywords ?? ""} ${option.group}`.toLowerCase();
    return words.every((word) => text.includes(word));
  }) : [...options];
  const order = [...new Set(options.map((option) => option.group))];
  return matches.sort((a, b) => order.indexOf(a.group) - order.indexOf(b.group));
}
function Section(props) {
  const id = React.useId();
  return /* @__PURE__ */ React.createElement("div", { role: "group", "aria-labelledby": id, style: { display: "flex", flexDirection: "column", gap: 4, minWidth: 0 } }, /* @__PURE__ */ React.createElement(Stack, { direction: "row", justify: "space-between", align: "center" }, /* @__PURE__ */ React.createElement(Text, { size: "sm", weight: 500, id }, props.label), props.aside), props.children, props.hint && /* @__PURE__ */ React.createElement(Text, { size: "xs", tone: "subtle", as: "div" }, props.hint));
}
var ICON_SLOT = { flex: "none", display: "inline-flex", alignItems: "center", justifyContent: "center", width: 20, height: 20 };
function OptionList(props) {
  const shown2 = filterOptions(props.options, props.query);
  let group = "";
  return /* @__PURE__ */ React.createElement("div", { className: "dbx-picker-list", role: "listbox", "aria-label": props.label, "aria-multiselectable": props.multi || void 0, style: { maxHeight: props.maxHeight } }, shown2.length === 0 && /* @__PURE__ */ React.createElement(Text, { tone: "subtle", size: "sm", as: "div", style: { padding: "8px 10px" } }, props.query ? `Nothing matches \u201C${props.query}\u201D.` : "Nothing to choose from here."), shown2.map((option) => {
    const heading = option.group !== group ? group = option.group : void 0;
    const selected = props.isSelected(option.id);
    return /* @__PURE__ */ React.createElement(React.Fragment, { key: option.id }, heading && /* @__PURE__ */ React.createElement("div", { className: "dbx-picker-group" }, heading), /* @__PURE__ */ React.createElement(
      "button",
      {
        type: "button",
        role: "option",
        "aria-selected": selected,
        className: "dbx-picker-option",
        disabled: props.disabled || option.disabled,
        onClick: () => props.onPick(option)
      },
      props.multi ? /* @__PURE__ */ React.createElement("input", { type: "checkbox", tabIndex: -1, readOnly: true, checked: selected, "aria-hidden": true }) : /* @__PURE__ */ React.createElement("span", { className: "dbx-picker-check", "aria-hidden": true }, selected ? "\u2713" : ""),
      option.icon && /* @__PURE__ */ React.createElement("span", { style: ICON_SLOT }, option.icon),
      /* @__PURE__ */ React.createElement("span", { className: "dbx-picker-text" }, /* @__PURE__ */ React.createElement("span", { style: { display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap" } }, /* @__PURE__ */ React.createElement(Text, { weight: 500 }, option.label), option.badge), option.detail && /* @__PURE__ */ React.createElement(Text, { tone: "subtle", size: "xs", as: "span", style: { overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" } }, option.detail)),
      option.meta && /* @__PURE__ */ React.createElement("span", { className: "dbx-picker-meta" }, option.meta)
    ));
  }));
}
function Loading(props) {
  return /* @__PURE__ */ React.createElement(Stack, { direction: "row", gap: 8, align: "center" }, /* @__PURE__ */ React.createElement(Spinner, { size: 12 }), /* @__PURE__ */ React.createElement(Text, { tone: "subtle", size: "sm" }, props.text));
}
function SinglePicker(props) {
  const [open, setOpen] = React.useState(false);
  const [query, setQuery] = React.useState("");
  const anchor = React.useRef(null);
  const close = React.useCallback(() => (setOpen(false), setQuery("")), []);
  React.useEffect(() => {
    if (!open) return;
    const outside = (event) => {
      if (anchor.current && !anchor.current.contains(event.target)) close();
    };
    document.addEventListener("mousedown", outside);
    return () => document.removeEventListener("mousedown", outside);
  }, [open, close]);
  const current = props.options.find((option) => option.id === props.value);
  const search = props.search !== false;
  React.useEffect(() => {
    if (!open || search) return;
    const options = anchor.current?.querySelectorAll(".dbx-picker-option");
    ([...options ?? []].find((option) => option.getAttribute("aria-selected") === "true") ?? options?.[0])?.focus();
  }, [open, search]);
  return /* @__PURE__ */ React.createElement(Section, { label: props.label, hint: props.hint }, /* @__PURE__ */ React.createElement("div", { className: "dbx-picker-anchor", ref: anchor }, /* @__PURE__ */ React.createElement(
    "button",
    {
      type: "button",
      className: "dbx-select dbx-picker-trigger",
      "aria-haspopup": "listbox",
      "aria-expanded": open,
      disabled: props.disabled,
      onClick: () => open ? close() : setOpen(true)
    },
    current?.icon && /* @__PURE__ */ React.createElement("span", { style: ICON_SLOT }, current.icon),
    /* @__PURE__ */ React.createElement("span", { style: props.value ? void 0 : { color: "var(--dbx-subtle)" } }, current?.label ?? props.valueLabel ?? (props.value || props.placeholder))
  ), open && /* @__PURE__ */ React.createElement(
    "div",
    {
      className: "dbx-picker",
      "data-floating": "",
      onKeyDown: (event) => {
        if (event.key === "Escape") event.stopPropagation(), close();
      }
    },
    search && /* @__PURE__ */ React.createElement(
      "input",
      {
        className: "dbx-input",
        autoFocus: true,
        placeholder: props.searchPlaceholder ?? "Search",
        "aria-label": `Search ${props.label.toLowerCase()}`,
        value: query,
        onChange: (event) => setQuery(event.target.value),
        onKeyDown: (event) => {
          if (event.key !== "Enter") return;
          event.preventDefault();
          const first = filterOptions(props.options, query).find((option) => !option.disabled);
          if (first) props.onChange(first), close();
        }
      }
    ),
    !(props.loading && props.options.length === 0) && /* @__PURE__ */ React.createElement(
      OptionList,
      {
        label: props.label,
        options: props.options,
        query,
        isSelected: (id) => id === props.value,
        onPick: (option) => (props.onChange(option), close()),
        maxHeight: 300,
        ...props.disabled !== void 0 && { disabled: props.disabled }
      }
    ),
    props.loading && /* @__PURE__ */ React.createElement("div", { style: { padding: "8px 12px", borderTop: props.options.length ? "1px solid var(--dbx-border)" : void 0 } }, /* @__PURE__ */ React.createElement(Loading, { text: props.loading }))
  )), props.error && /* @__PURE__ */ React.createElement(Text, { tone: "danger", size: "sm" }, props.error));
}
function MultiPicker(props) {
  const [query, setQuery] = React.useState("");
  const chosen = new Set(props.selected.map((option) => option.id));
  return /* @__PURE__ */ React.createElement(
    Section,
    {
      label: props.label,
      hint: props.hint,
      aside: /* @__PURE__ */ React.createElement(Text, { tone: "subtle", size: "xs" }, props.selected.length, " selected")
    },
    props.selected.length > 0 && /* @__PURE__ */ React.createElement("div", { style: { display: "flex", flexWrap: "wrap", gap: 6 } }, props.selected.map((option) => /* @__PURE__ */ React.createElement("span", { key: option.id, className: "dbx-chip", title: option.detail ?? option.label }, /* @__PURE__ */ React.createElement("span", null, option.label), /* @__PURE__ */ React.createElement("button", { type: "button", "aria-label": `Remove ${option.label}`, disabled: props.disabled, onClick: () => props.onToggle(option, false) }, "\xD7")))),
    props.alerts,
    /* @__PURE__ */ React.createElement("div", { className: "dbx-picker" }, /* @__PURE__ */ React.createElement("input", { className: "dbx-input", placeholder: props.searchPlaceholder ?? `Search ${props.options.length}`, "aria-label": `Search ${props.label.toLowerCase()}`, value: query, onChange: (event) => setQuery(event.target.value) }), /* @__PURE__ */ React.createElement(
      OptionList,
      {
        label: props.label,
        multi: true,
        options: props.options,
        query,
        isSelected: (id) => chosen.has(id),
        onPick: (option) => props.onToggle(option, !chosen.has(option.id)),
        maxHeight: 220,
        ...props.disabled !== void 0 && { disabled: props.disabled }
      }
    ), props.loading && /* @__PURE__ */ React.createElement("div", { style: { padding: "6px 10px", borderTop: "1px solid var(--dbx-border)" } }, /* @__PURE__ */ React.createElement(Loading, { text: props.loading }))),
    (props.notes ?? []).map((note) => /* @__PURE__ */ React.createElement(Text, { key: note, tone: "tertiary", size: "xs" }, note)),
    props.footer
  );
}
var RECOMMENDED = new Set(DEFAULT_MODELS.map((model) => model.id));
var shortId = (id) => id.replace(/^system\.ai\./, "");
function modelOptions(models) {
  const listed = models ?? DEFAULT_MODELS.map((model) => ({ id: model.id, label: model.label, tools: true, builtIn: true }));
  const byId = new Map(listed.map((model) => [model.id, model]));
  const recommended = DEFAULT_MODELS.filter((model) => !models || byId.has(model.id)).map((model) => ({ id: model.id, label: model.label, group: "Recommended", meta: shortId(model.id) }));
  const rest = listed.filter((model) => !RECOMMENDED.has(model.id)).map((model) => ({
    id: model.id,
    label: model.label,
    group: model.builtIn ? "All Databricks models" : "Your workspace",
    meta: shortId(model.id),
    keywords: model.id,
    ...!model.tools && { disabled: true, badge: /* @__PURE__ */ React.createElement(Badge, null, "No tool calling") }
  }));
  return [...recommended, ...rest];
}
function ModelField(props) {
  const status2 = useConnection(props.service).status;
  const models = useAsync(() => cachedList(props.service, "models", async () => new Ai(await props.service.ready()).models()), [props.service, status2]);
  const options = modelOptions(models.data).filter((option) => !props.accepts || props.accepts(option.id));
  return /* @__PURE__ */ React.createElement(
    SinglePicker,
    {
      label: "Model",
      hint: props.hint ?? "From AI Gateway in this workspace.",
      value: props.value,
      valueLabel: props.value,
      placeholder: "Choose a model",
      searchPlaceholder: `Search ${options.length} models`,
      options,
      loading: models.loading && !models.data && loads(status2) ? "Loading all models\u2026" : false,
      ...models.error && status2 === "connected" && { error: `Couldn't list models: ${describeError(models.error)}` },
      ...props.disabled !== void 0 && { disabled: props.disabled },
      onChange: (option) => props.onChange(option.id)
    }
  );
}
var genieSpaces = (service) => cachedList(service, "genie-spaces", async () => new Genie(await service.ready()).listSpaces());
var asChoice = (server) => ({ id: server.id, kind: server.kind, label: server.label, path: server.path });
function serverOption(server, login) {
  const badge = server.needsLogin ? login === "signed-in" ? void 0 : login === "needed" ? /* @__PURE__ */ React.createElement(Badge, { tone: "warning", title: `Log in to ${server.label} to use it` }, "Not logged in") : /* @__PURE__ */ React.createElement(Badge, null, "Needs your account") : server.id === "service:system.ai.dbsql" ? /* @__PURE__ */ React.createElement(Badge, { tone: "warning", title: "Unlike the suite's own SQL tool, this server isn't read-only" }, "Can change data") : void 0;
  return {
    id: server.id,
    label: server.label,
    group: server.builtIn ? "Databricks" : "Your workspace's MCP servers",
    keywords: server.id,
    ...server.builtIn ? server.description && { detail: server.description } : { detail: `${server.kind === "connection" ? "External MCP connection" : "MCP service"}${server.description ? ` \xB7 ${server.description}` : ""}` },
    ...badge && { badge }
  };
}
var loginStates = /* @__PURE__ */ new WeakMap();
function useMcpLogins(service, connected, servers) {
  const names = servers.filter((server) => server.needsLogin).map(serviceName).filter((name) => Boolean(name)).join(" ");
  const [states, setStates] = React.useState(() => loginStates.get(service) ?? {});
  const [waiting, setWaiting] = React.useState();
  const deadline = React.useRef(0);
  const check = React.useCallback(
    async (only) => {
      const client = service.client();
      const list = only ?? (names ? names.split(" ") : []);
      if (!client || !list.length) return;
      const catalog = new McpCatalog(client);
      const found = Object.fromEntries(await Promise.all(list.map(async (name) => [name, await catalog.loginState(name)])));
      const next = { ...loginStates.get(service), ...found };
      loginStates.set(service, next);
      setStates(next);
    },
    [service, names]
  );
  React.useEffect(() => {
    if (connected) void check();
  }, [check, connected]);
  React.useEffect(() => {
    const again = () => void check();
    globalThis.addEventListener?.("focus", again);
    return () => globalThis.removeEventListener?.("focus", again);
  }, [check]);
  React.useEffect(() => {
    if (!waiting) return;
    if (states[waiting] === "signed-in") return setWaiting(void 0);
    const timer = setInterval(() => Date.now() > deadline.current ? setWaiting(void 0) : void check([waiting]), 3e3);
    return () => clearInterval(timer);
  }, [waiting, states, check]);
  const logIn = (name) => {
    const url = service.workspaceUrl(mcpLoginPath(name));
    if (!url) return;
    openExternal(url);
    deadline.current = Date.now() + 5 * 6e4;
    setWaiting(name);
  };
  return { states, waiting, logIn, check };
}
function McpLoginNotice(props) {
  const { label } = props.server;
  return /* @__PURE__ */ React.createElement(
    Notice,
    {
      tone: "warning",
      action: props.waiting ? /* @__PURE__ */ React.createElement(Button, { size: "sm", disabled: props.disabled, onClick: props.onCheck }, "Check again") : /* @__PURE__ */ React.createElement(Button, { size: "sm", variant: "brand", disabled: props.disabled, onClick: props.onLogIn }, "Log in to ", label)
    },
    props.waiting ? /* @__PURE__ */ React.createElement(Stack, { direction: "row", gap: 6, align: "center" }, /* @__PURE__ */ React.createElement(Spinner, { size: 11 }), /* @__PURE__ */ React.createElement("span", null, "Finish logging in to ", label, " in your browser.")) : `Log in so this agent can use ${label} as you.`
  );
}
function ToolsField(props) {
  const { service } = props;
  const status2 = useConnection(service).status;
  const spaces = useAsync(() => genieSpaces(service), [service, status2]);
  const catalog = useAsync(() => cachedList(service, "mcp", async () => new McpCatalog(await service.ready()).list()), [service, status2]);
  const [schemaName, setSchemaName] = React.useState("");
  const choices = /* @__PURE__ */ new Map([[GENIE_ONE_CHOICE.id, GENIE_ONE_CHOICE]]);
  const servers = catalog.data?.servers ?? [];
  const logins = useMcpLogins(service, status2 === "connected", servers);
  const options = [{ id: GENIE_ONE_CHOICE.id, label: "Genie One", group: "Databricks", detail: "Questions about any data you can access" }];
  const loginOf = (server) => logins.states[serviceName(server) ?? ""];
  for (const server of servers.filter((candidate) => candidate.builtIn)) {
    choices.set(server.id, asChoice(server));
    options.push(serverOption(server, loginOf(server)));
  }
  for (const space of spaces.data ?? []) {
    const choice = { id: `genie:${space.space_id}`, kind: "genie", label: space.title };
    choices.set(choice.id, choice);
    options.push({ id: choice.id, label: space.title, group: "Genie agents", ...space.description && { detail: space.description }, keywords: "genie agent space" });
  }
  for (const server of servers.filter((candidate) => !candidate.builtIn)) {
    choices.set(server.id, asChoice(server));
    options.push(serverOption(server, loginOf(server)));
  }
  for (const tool of props.tools)
    if (!choices.has(tool.id)) {
      choices.set(tool.id, tool);
      options.push({ id: tool.id, label: tool.label, group: tool.kind === "functions" ? "Unity Catalog functions" : "Chosen", ...tool.kind === "functions" && { detail: "Unity Catalog functions" } });
    }
  const selected = props.tools.map((tool) => options.find((option) => option.id === tool.id)).filter(Boolean);
  const toggle = (id, on) => {
    const choice = choices.get(id);
    if (!choice) return;
    props.onChange(on ? [...props.tools.filter((tool) => tool.id !== id), choice] : props.tools.filter((tool) => tool.id !== id));
  };
  const toLogIn = servers.filter((server) => {
    const name = serviceName(server);
    return name && props.tools.some((tool) => tool.id === server.id) && (logins.states[name] === "needed" || logins.waiting === name);
  });
  const loading = !loads(status2) ? false : spaces.loading ? "Loading Genie agents\u2026" : catalog.loading ? "Finding MCP servers\u2026" : false;
  const notes = status2 !== "connected" ? [] : [
    ...spaces.error ? [`Couldn't list Genie agents: ${describeError(spaces.error)}`] : [],
    ...catalog.error ? [`Couldn't list MCP servers: ${describeError(catalog.error)}`] : [],
    ...(catalog.data?.errors ?? []).map((error) => `Couldn't list ${error}`)
  ];
  return /* @__PURE__ */ React.createElement(
    MultiPicker,
    {
      label: "Tools",
      hint: "Genie and MCP servers from this workspace. They run with your access.",
      searchPlaceholder: `Search ${options.length} tools`,
      selected,
      options,
      loading,
      notes,
      alerts: toLogIn.map((server) => {
        const name = serviceName(server);
        return /* @__PURE__ */ React.createElement(
          McpLoginNotice,
          {
            key: server.id,
            server,
            waiting: logins.waiting === name,
            onLogIn: () => logins.logIn(name),
            onCheck: () => void logins.check([name]),
            ...props.disabled !== void 0 && { disabled: props.disabled }
          }
        );
      }),
      ...props.disabled !== void 0 && { disabled: props.disabled },
      onToggle: (option, on) => toggle(option.id, on),
      footer: /* @__PURE__ */ React.createElement(Stack, { direction: "row", gap: 8, align: "center" }, /* @__PURE__ */ React.createElement(
        "input",
        {
          className: "dbx-input",
          placeholder: "Add Unity Catalog functions: catalog.schema",
          "aria-label": "Unity Catalog schema with functions",
          value: schemaName,
          onChange: (event) => setSchemaName(event.target.value.trim()),
          style: { flex: 1 }
        }
      ), /* @__PURE__ */ React.createElement(
        Button,
        {
          size: "sm",
          disabled: props.disabled || !/^[\w-]+\.[\w-]+$/.test(schemaName),
          onClick: () => {
            const [catalogName = "", schemaPart = ""] = schemaName.split(".");
            const choice = asChoice(functionsServer(catalogName, schemaPart));
            props.onChange([...props.tools.filter((tool) => tool.id !== choice.id), choice]);
            setSchemaName("");
          }
        },
        "Add functions"
      ))
    }
  );
}
function SkillsField(props) {
  const { service, profile } = props;
  const status2 = useConnection(service).status;
  const catalog = React.useMemo(() => skillCatalogFor(service, profile), [service, profile]);
  const state = React.useSyncExternalStore(catalog.subscribe, catalog.snapshot);
  React.useEffect(() => {
    if (status2 === "connected") void catalog.load();
  }, [catalog, status2]);
  const value = normalizeSkills(props.value);
  const chosenSchemas = new Set(value.schemas);
  const chosenNames = new Set(value.names);
  const bySchema = /* @__PURE__ */ new Map();
  for (const skill of state.skills) bySchema.set(schemaOf(skill.fullName), [...bySchema.get(schemaOf(skill.fullName)) ?? [], skill]);
  const schemaNames = [.../* @__PURE__ */ new Set([...state.schemas.map((entry) => entry.schema), ...bySchema.keys(), ...chosenSchemas])].sort((a, b) => a.localeCompare(b));
  const options = [];
  const listed = /* @__PURE__ */ new Set();
  for (const schema2 of schemaNames) {
    if (!chosenSchemas.has(schema2) && !bySchema.has(schema2)) continue;
    options.push({ id: `schema:${schema2}`, label: `All skills in ${schema2}`, group: schema2, detail: "Always the latest skills in this schema", keywords: "schema" });
    for (const skill of bySchema.get(schema2) ?? []) {
      listed.add(skill.fullName);
      options.push({ id: `skill:${skill.fullName}`, label: skill.fullName.split(".").pop(), group: schema2, ...skill.description && { detail: skill.description }, keywords: skill.fullName });
    }
  }
  for (const name of value.names) if (!listed.has(name)) options.push({ id: `skill:${name}`, label: name.split(".").pop(), group: "Chosen", detail: name });
  for (const schema2 of value.schemas) if (!schemaNames.includes(schema2)) options.push({ id: `schema:${schema2}`, label: `All skills in ${schema2}`, group: "Chosen" });
  const chosenIds = /* @__PURE__ */ new Set([...value.schemas.map((schema2) => `schema:${schema2}`), ...value.names.map((name) => `skill:${name}`)]);
  const selected = options.filter((option) => chosenIds.has(option.id));
  const toggle = (option, on) => {
    const separator = option.id.indexOf(":");
    const kind = option.id.slice(0, separator);
    const id = option.id.slice(separator + 1);
    if (kind === "schema") props.onChange({ ...value, schemas: on ? [...value.schemas.filter((item) => item !== id), id] : value.schemas.filter((item) => item !== id) });
    else props.onChange({ ...value, names: on ? [...value.names.filter((item) => item !== id), id] : value.names.filter((item) => item !== id) });
  };
  const notes = [state.note, state.error].filter((note) => Boolean(note));
  return /* @__PURE__ */ React.createElement(
    MultiPicker,
    {
      label: "Skills",
      hint: "Skills come from schemas tagged agent_skills or added in Settings \u2192 Databricks Knowledge.",
      searchPlaceholder: (() => {
        const skills = options.filter((option) => option.id.startsWith("skill:")).length;
        return `Search ${skills} ${skills === 1 ? "skill" : "skills"}`;
      })(),
      selected,
      options,
      loading: status2 !== "connected" ? false : state.status === "loading" ? "Finding skills\u2026" : false,
      notes,
      ...props.disabled !== void 0 && { disabled: props.disabled },
      onToggle: toggle,
      footer: /* @__PURE__ */ React.createElement("label", { style: { display: "flex", gap: 6, alignItems: "center" } }, /* @__PURE__ */ React.createElement(
        "input",
        {
          type: "checkbox",
          checked: value.channel,
          ...props.disabled !== void 0 && { disabled: props.disabled },
          onChange: (event) => props.onChange({ ...value, channel: event.target.checked })
        }
      ), /* @__PURE__ */ React.createElement(Text, { size: "sm" }, "Use the skills of the channel it's working in"))
    }
  );
}
function CustomAgentField(props) {
  const { service } = props;
  const status2 = useConnection(service).status;
  const found = useAsync(
    async () => {
      const errors = [];
      const [endpoints, apps, spaces] = await Promise.all([
        cachedList(service, "endpoints", async () => new Ai(await service.ready()).endpoints()).catch((error) => (errors.push(`serving endpoints: ${describeError(error)}`), [])),
        cachedList(service, "apps", async () => new Ai(await service.ready()).apps()).catch((error) => (errors.push(`apps: ${describeError(error)}`), [])),
        genieSpaces(service).catch((error) => (errors.push(`Genie agents: ${describeError(error)}`), []))
      ]);
      const agents = /* @__PURE__ */ new Map();
      const options = [];
      for (const endpoint of endpoints.filter((candidate) => candidate.isAgent || candidate.isChat && !candidate.name.startsWith("databricks-"))) {
        const id = `endpoint:${endpoint.name}`;
        agents.set(id, { kind: "endpoint", target: endpoint.name, label: endpoint.name, task: endpoint.task });
        options.push({
          id,
          label: endpoint.name,
          group: "Agent Bricks and Model Serving",
          detail: [endpoint.description, endpoint.task].filter(Boolean).join(" \xB7 "),
          ...!endpoint.ready && { badge: /* @__PURE__ */ React.createElement(Badge, { tone: "warning" }, "Not ready") }
        });
      }
      for (const app of apps) {
        const id = `app:${app.url}`;
        agents.set(id, { kind: "app", target: app.url, label: app.name });
        options.push({ id, label: app.name, group: "Databricks Apps", detail: app.description || new URL(app.url).hostname, ...!app.running && { badge: /* @__PURE__ */ React.createElement(Badge, null, "Stopped") } });
      }
      for (const space of spaces) {
        const id = `genie:${space.space_id}`;
        agents.set(id, { kind: "genie", target: space.space_id, label: space.title });
        options.push({ id, label: space.title, group: "Genie agents", detail: space.description || "Genie agent" });
      }
      return { agents, options, errors };
    },
    [service, status2]
  );
  const value = props.value ? `${props.value.kind}:${props.value.target}` : void 0;
  return /* @__PURE__ */ React.createElement(React.Fragment, null, /* @__PURE__ */ React.createElement(
    SinglePicker,
    {
      label: "Agent",
      hint: "Agents in this workspace. Each message in the thread goes to it, and its reply is posted as this agent.",
      searchPlaceholder: "Search agents",
      ...value && { value },
      ...props.value && { valueLabel: props.value.label },
      placeholder: "Choose an agent",
      options: found.data?.options ?? [],
      loading: found.loading && !found.data && loads(status2) ? "Finding your agents\u2026" : false,
      ...found.error && status2 === "connected" && { error: describeError(found.error) },
      ...props.disabled !== void 0 && { disabled: props.disabled },
      onChange: (option) => {
        const agent = found.data?.agents.get(option.id);
        if (agent) props.onChange(agent);
      }
    }
  ), (found.data?.errors ?? []).map((error) => /* @__PURE__ */ React.createElement(Text, { key: error, tone: "tertiary", size: "xs" }, "Couldn't list ", error)));
}

// plugins/agents/src/hosted.tsx
var HOSTED_TYPE_ID = "databricks-hosted";
var AGENT_DIR = `${SANDBOX_HOME}/.buzz/agent`;
var RECORD_PREFIX = "bkvarda.databricks-hosted.v1:";
var IDLE_MINUTES = 5;
var TEND_EVERY_MS = 4 * 6e4;
var REFRESH_AFTER_HOURS = 8;
var QUIET_MINUTES = 10;
var SANDBOX_DAY_HOURS = 24;
var HARNESS_CHOICES = HARNESSES.filter((harness) => harness.id !== "builtin");
function normalizeHosted(value) {
  const config = value ?? {};
  const harness = HARNESS_CHOICES.some((choice) => choice.id === config.harness) ? config.harness : "claude";
  const genie = config.genie && typeof config.genie.space === "string" && config.genie.space ? { space: config.genie.space, label: String(config.genie.label || config.genie.space) } : void 0;
  const kind = config.kind === "sandbox" || config.kind === "omnigent" ? config.kind : "genie";
  const omnigent = kind === "omnigent" ? config.omnigent && typeof config.omnigent.agent === "string" && config.omnigent.agent ? { agent: config.omnigent.agent, label: String(config.omnigent.label || omnigentAgentLabel(config.omnigent.agent)) } : { agent: DEFAULT_OMNIGENT_AGENT, label: omnigentAgentLabel(DEFAULT_OMNIGENT_AGENT) } : void 0;
  return {
    kind,
    harness,
    model: typeof config.model === "string" && harnessAccepts(harness, config.model) ? config.model : HARNESS_MODEL[harness],
    // Genie One unless the owner chose otherwise (an empty list is a choice).
    tools: Array.isArray(config.tools) ? normalizeChoices(config.tools) : [GENIE_ONE_CHOICE],
    skills: normalizeSkills(config.skills),
    availability: config.availability === "always" ? "always" : "sleep",
    scope: config.scope === "channel" ? "channel" : "thread",
    instructions: typeof config.instructions === "string" ? config.instructions : "",
    ...typeof config.profile === "string" && config.profile && { profile: config.profile },
    ...genie && { genie },
    ...omnigent && { omnigent }
  };
}
function summarizeHosted(config) {
  const what = config.kind === "genie" ? config.genie ? `Genie \xB7 ${config.genie.label}` : "Genie One" : config.kind === "omnigent" ? `Omnigent \xB7 ${config.omnigent?.label ?? omnigentAgentLabel(DEFAULT_OMNIGENT_AGENT)}` : `${harnessLabel(config.harness)} \xB7 ${harnessModel(config.harness, config.model).replace(/^system\.ai\./, "")}`;
  return [what, config.availability === "always" ? "always on" : "sleeps when Buzz is closed", ...config.profile ? [config.profile] : []].join(" \xB7 ");
}
var recordKey = (pubkey) => `${RECORD_PREFIX}${pubkey}`;
var pendingKey = (community, name) => `${RECORD_PREFIX}pending:${community}:${name}`;
var parse = (raw) => {
  try {
    return raw ? JSON.parse(raw) : void 0;
  } catch {
    return void 0;
  }
};
var randomHex = (bytes) => [...crypto.getRandomValues(new Uint8Array(bytes))].map((b) => b.toString(16).padStart(2, "0")).join("");
function runnerConfigOf(record, host, workspaceId) {
  if (!record.community || !record.owner || !record.authTag) throw new Error("This agent hasn't been activated yet.");
  const config = record.config;
  return {
    relay: record.community,
    owner: record.owner,
    authTag: record.authTag,
    name: record.name,
    ...record.picture && { picture: record.picture },
    kind: config.kind,
    ...config.genie && { genieSpace: config.genie.space, genieLabel: config.genie.label },
    ...config.kind === "omnigent" && config.omnigent && { omnigentAgent: config.omnigent.agent, omnigentLabel: config.omnigent.label },
    harness: config.harness,
    model: harnessModel(config.harness, config.model),
    // Unattended: always each harness's guarded mode.
    permissions: "standard",
    instructions: config.instructions,
    scope: config.scope,
    availability: config.availability,
    idleMinutes: IDLE_MINUTES,
    sandbox: record.sandbox,
    ...host && { workspaceHost: host },
    ...workspaceId && { workspaceId },
    ...config.kind === "sandbox" && config.tools.length && { tools: config.tools }
  };
}
function workspaceOf(service, profile) {
  return profile && service.forProfile ? service.forProfile(profile) : service;
}
async function sandboxOf(service, record, signal) {
  const client = await workspaceOf(service, record.config.profile).ready(signal);
  return { client, sandboxes: new Sandboxes(client) };
}
var keepAwake = (client, sandbox, signal) => client.json(`/api/2.0/lakebox/sandboxes/${encodeURIComponent(sandbox)}`, { method: "PATCH", body: { no_autostop: true }, ...signal && { signal } });
async function runner(sandboxes, sandbox, args, signal, timeoutSeconds = 90) {
  const result = await sandboxes.bash(sandbox, `node ${shellQuote(`${AGENT_DIR}/runner.mjs`)} ${args}`, { timeoutSeconds, ...signal && { signal } });
  if (result.exit_code !== 0) throw new Error(`The agent's runner couldn't ${args.split(" ")[0]}: ${(result.stderr || result.stdout || `exit ${result.exit_code}`).trim().slice(-400)}`);
  return (result.stdout ?? "").trim();
}
function shouldRefresh(status2, now = Date.now()) {
  if (!status2?.running || status2.active || !status2.bootedAt) return false;
  const booted = Date.parse(status2.bootedAt);
  const last = Math.max(booted, Date.parse(status2.lastActivity ?? "") || 0);
  return now - booted > REFRESH_AFTER_HOURS * 36e5 && now - last > QUIET_MINUTES * 6e4;
}
function hoursLeft(bootedAt, now = Date.now()) {
  const booted = Date.parse(bootedAt ?? "");
  return Number.isFinite(booted) ? Math.max(0, SANDBOX_DAY_HOURS - (now - booted) / 36e5) : void 0;
}
async function dropKeeper(client, jobId, signal) {
  try {
    await client.post("/api/2.2/jobs/delete", { job_id: jobId }, signal ? { signal } : {});
  } catch (error) {
    const status2 = error.status;
    if (status2 !== 400 && status2 !== 404) throw error;
  }
}
async function stopped(sandboxes, sandbox, signal) {
  const deadline = Date.now() + 4 * 6e4;
  for (; ; ) {
    const state = (await sandboxes.get(sandbox, signal)).status?.state;
    if (state === "SANDBOX_STATE_STOPPED") return;
    if (Date.now() > deadline) throw new Error(`The agent's Sandbox didn't stop (state: ${state ?? "unknown"}).`);
    await new Promise((resolve) => setTimeout(resolve, 3e3));
    signal?.throwIfAborted();
  }
}
async function syncHostedSkills(service, record, sandboxes, signal) {
  if (record.config.kind !== "sandbox") return;
  try {
    const workspace = workspaceOf(service, record.config.profile);
    const { skills } = await resolveSkills(skillCatalogFor(service, record.config.profile), normalizeSkills(record.config.skills));
    await installSkills({ sandboxes, sandbox: record.sandbox, api: new Skills(await workspace.ready(signal)), skills, ...signal && { signal } });
  } catch {
  }
}
async function deploy(service, record, options) {
  const { client, sandboxes } = await sandboxOf(service, record, options.signal);
  await sandboxes.ensureRunning(record.sandbox, { ...options.signal && { signal: options.signal } });
  await uploadRunner(sandboxes, record.sandbox, options.signal);
  await syncHostedSkills(service, record, sandboxes, options.signal);
  const workspaceId = workspaceIdOf(workspaceOf(service, record.config.profile));
  await sandboxes.writeFile(record.sandbox, `${AGENT_DIR}/config.json`, `${JSON.stringify(runnerConfigOf(record, client.host, workspaceId), null, 2)}
`, options.signal);
  if (options.publishProfile) await runner(sandboxes, record.sandbox, "profile", options.signal).catch(() => {
  });
  if (options.restart) await runner(sandboxes, record.sandbox, "stop", options.signal);
  await runner(sandboxes, record.sandbox, "start", options.signal);
  return { client, sandboxes };
}
function hostedProvider(agents, service) {
  const storage = agents.storage;
  const read = (pubkey) => parse(storage.get(recordKey(pubkey)));
  const write = (record) => storage.set(recordKey(record.pubkey), JSON.stringify(record));
  const records = () => storage.keys().filter((key2) => key2.startsWith(RECORD_PREFIX) && !key2.includes(":pending:")).map((key2) => parse(storage.get(key2))).filter((record) => Boolean(record?.pubkey));
  return {
    read,
    records,
    async provision(input) {
      const config = normalizeHosted(input.config);
      const pending = pendingKey(input.community, input.name);
      const record = parse(storage.get(pending)) ?? {
        sandbox: `buzz-hosted-${randomHex(5)}`,
        name: input.name,
        ...input.picture && { picture: input.picture },
        config,
        createdAt: Date.now()
      };
      await storage.set(pending, JSON.stringify(record));
      const { client, sandboxes } = await sandboxOf(service, record, input.signal);
      await sandboxes.ensureRunning(record.sandbox, { displayName: `Buzz agent: ${input.name}`.slice(0, 60), tags: { created_by: "buzz", buzz_hosted: "true" }, signal: input.signal });
      await keepAwake(client, record.sandbox, input.signal);
      await sandboxes.bash(record.sandbox, `mkdir -p ${shellQuote(AGENT_DIR)} ${shellQuote(WORK_DIR)}`, { timeoutSeconds: 30, signal: input.signal });
      await uploadRunner(sandboxes, record.sandbox, input.signal);
      const { pubkey } = JSON.parse(await runner(sandboxes, record.sandbox, "keygen", input.signal));
      if (!/^[0-9a-f]{64}$/.test(pubkey)) throw new Error("The agent's Sandbox didn't make a key.");
      await write({ ...record, pubkey });
      return { pubkey, ...record.picture && { picture: record.picture } };
    },
    async activate(input) {
      const found = read(input.pubkey);
      if (!found) throw new Error("This agent's Sandbox was set up from another device; remove the agent and create it again here.");
      const record = {
        ...found,
        name: input.name,
        config: normalizeHosted(input.config ?? found.config),
        community: input.community,
        owner: String(input.auth[1]),
        authTag: [...input.auth].map(String)
      };
      await deploy(service, record, { restart: true, publishProfile: true, signal: input.signal });
      await write(record);
      await storage.set(pendingKey(input.community, found.name), null);
    },
    async profile(input) {
      const found = read(input.pubkey);
      if (!found) return;
      const record = { ...found, name: input.name };
      if (input.picture) record.picture = input.picture;
      else delete record.picture;
      await deploy(service, record, { restart: false, publishProfile: true, signal: input.signal });
      await write(record);
    },
    async interrupt(input) {
      const record = read(input.pubkey);
      if (!record) return false;
      const { sandboxes } = await sandboxOf(service, record, input.signal);
      return await runner(sandboxes, record.sandbox, `interrupt ${shellQuote(input.channelId)} ${shellQuote(input.threadRootId)}`, input.signal) === "true";
    },
    async remove(input) {
      const record = read(input.pubkey);
      if (!record) return;
      const { client, sandboxes } = await sandboxOf(service, record, input.signal);
      if (record.jobId) await dropKeeper(client, record.jobId, input.signal);
      try {
        await sandboxes.delete(record.sandbox);
      } catch (error) {
        if (error.status !== 404) throw error;
      }
      await storage.set(recordKey(input.pubkey), null);
    },
    /** Applies new settings from the agent's Settings tab. */
    async update(pubkey, config, signal) {
      const found = read(pubkey);
      if (!found) throw new Error("This agent is managed from another device.");
      const record = { ...found, config: { ...config, kind: found.config.kind, ...found.config.profile ? { profile: found.config.profile } : {} } };
      await deploy(service, record, { restart: true, publishProfile: false, ...signal && { signal } });
      await write(record);
    },
    /**
     * Wakes the agent: starts its Sandbox if it has stopped (never making a
     * new one: a deleted Sandbox took the agent's key with it), keeps a
     * sleeping one awake, and starts the runner if it isn't running. Then,
     * for an always-on agent, restarts a long-running Sandbox at a quiet
     * moment (`shouldRefresh`) unless `refresh` is false. Resolves with the
     * runner's status.
     */
    async wake(pubkey, options = {}) {
      const { signal } = options;
      const record = read(pubkey);
      if (!record) throw new Error("This agent is managed from another device.");
      const { client, sandboxes } = await sandboxOf(service, record, signal);
      if (record.jobId) {
        await dropKeeper(client, record.jobId, signal);
        const { jobId: _old, ...rest } = record;
        await write(rest);
      }
      await sandboxes.get(record.sandbox, signal).catch((error) => {
        if (error.status === 404) throw new Error(`The agent's Sandbox ${record.sandbox} is gone; remove the agent and create it again.`);
        throw error;
      });
      const node = `node ${shellQuote(`${AGENT_DIR}/runner.mjs`)}`;
      const script = `${record.config.availability === "sleep" ? `touch ${shellQuote(`${AGENT_DIR}/awake`)} && ` : ""}${node} start >/dev/null && ${node} status`;
      const start = async () => {
        await sandboxes.ensureRunning(record.sandbox, { ...signal && { signal } });
        if (await uploadRunner(sandboxes, record.sandbox, signal)) await runner(sandboxes, record.sandbox, "stop", signal);
        await syncHostedSkills(service, record, sandboxes, signal);
        const result = await sandboxes.bash(record.sandbox, script, { timeoutSeconds: 60, ...signal && { signal } });
        if (result.exit_code !== 0) throw new Error(`The agent's runner couldn't start: ${(result.stderr || result.stdout || `exit ${result.exit_code}`).trim().slice(-400)}`);
        return JSON.parse((result.stdout ?? "").trim() || "{}");
      };
      const status2 = await start();
      if (options.refresh === false || record.config.availability !== "always" || !shouldRefresh(status2)) return status2;
      await runner(sandboxes, record.sandbox, "stop", signal);
      await sandboxes.stop(record.sandbox);
      await stopped(sandboxes, record.sandbox, signal);
      return start();
    },
    /** The agent's recent turns from its Sandbox's activity log, newest first; undefined while its Sandbox sleeps. */
    async activity(pubkey, signal) {
      const record = read(pubkey);
      if (!record) return [];
      const { sandboxes } = await sandboxOf(service, record, signal);
      const sandbox = await sandboxes.get(record.sandbox, signal).catch(() => void 0);
      if (sandbox?.status?.state !== "SANDBOX_STATE_RUNNING") return void 0;
      const result = await sandboxes.bash(record.sandbox, `tail -n 1500 ${shellQuote(`${AGENT_DIR}/activity.jsonl`)} 2>/dev/null; true`, { timeoutSeconds: 30, ...signal && { signal } });
      const lines = (result.stdout ?? "").split("\n").flatMap((line) => {
        try {
          return line.trim() ? [JSON.parse(line)] : [];
        } catch {
          return [];
        }
      });
      return turnsFromLines(lines).slice(0, 25);
    },
    async status(pubkey, signal) {
      const record = read(pubkey);
      if (!record) return void 0;
      const { sandboxes } = await sandboxOf(service, record, signal);
      const sandbox = await sandboxes.get(record.sandbox, signal).catch(() => void 0);
      const state = sandbox?.status?.state ?? "missing";
      if (state !== "SANDBOX_STATE_RUNNING") return { record, state, runner: void 0 };
      const runnerStatus = JSON.parse(await runner(sandboxes, record.sandbox, "status", signal).catch(() => "{}"));
      return { record, state, runner: runnerStatus };
    }
  };
}
function tendAgents(provider2) {
  const busy = /* @__PURE__ */ new Set();
  const beat = () => {
    for (const record of provider2.records()) {
      const pubkey = record.pubkey;
      if (!record.community || busy.has(pubkey)) continue;
      busy.add(pubkey);
      void provider2.wake(pubkey).catch(() => {
      }).finally(() => busy.delete(pubkey));
    }
  };
  const first = setTimeout(beat, 3e4);
  const timer = setInterval(beat, TEND_EVERY_MS);
  return () => {
    clearTimeout(first);
    clearInterval(timer);
  };
}
var KIND_CHOICES = [
  { id: "genie", label: "Genie", short: "Genie One or one of your Genie agents", Icon: GenieKindIcon, detail: "Answers data questions with Genie One, or with one of your Genie agents, as charts and tables." },
  { id: "sandbox", label: "Sandbox agent", short: "Claude Code, Codex or Pi in its own Sandbox", Icon: SandboxKindIcon, detail: "Claude Code, Codex or Pi, working in its own Databricks Sandbox with the Databricks CLI signed in as you." },
  {
    id: "omnigent",
    label: "Omnigent agent",
    short: "An Omnigent agent, in Omnigent sessions",
    Icon: OmnigentKindIcon,
    detail: "An Omnigent agent (Claude Code, Codex, Pi, Polly\u2026) on a Sandbox that Omnigent runs. Each conversation is an Omnigent session in this workspace, which you can open and continue in Omnigent."
  }
];
var AVAILABILITY_HINT = {
  always: `Replies within seconds, with Buzz open or closed. Databricks stops a Sandbox ${SANDBOX_DAY_HOURS} hours after it starts, so with Buzz closed it keeps answering for ${SANDBOX_DAY_HOURS - REFRESH_AFTER_HOURS} to ${SANDBOX_DAY_HOURS} hours. Your Buzz restarts it whenever it's open, and it then answers anything it missed.`,
  sleep: "Runs while your Buzz is open and finishes any work after you close it, then sleeps about 10 minutes later. Opening Buzz wakes it, and it answers anything it missed. Costs less than Always on."
};
function GenieField(props) {
  const status2 = useConnection(props.service).status;
  const spaces = useAsync(() => genieSpaces(props.service), [props.service, status2]);
  const options = [
    { id: "", label: "Genie One", group: "Databricks", detail: "Questions about any data you can access" },
    ...(spaces.data ?? []).map((space) => ({ id: space.space_id, label: space.title, group: "Genie agents", ...space.description && { detail: space.description } }))
  ];
  return /* @__PURE__ */ React.createElement(
    SinglePicker,
    {
      label: "Genie",
      hint: "Genie One finds the right data across the workspace; a Genie agent answers about the data its team set up.",
      value: props.value?.space ?? "",
      valueLabel: props.value?.label ?? "Genie One",
      placeholder: "Genie One",
      searchPlaceholder: `Search ${options.length} options`,
      options,
      loading: spaces.loading && !spaces.data ? "Loading Genie agents\u2026" : false,
      ...props.disabled !== void 0 && { disabled: props.disabled },
      onChange: (option) => props.onChange(option.id ? { space: option.id, label: option.label } : void 0)
    }
  );
}
function OmnigentField(props) {
  const status2 = useConnection(props.service).status;
  const found = useAsync(async () => {
    const omnigent = new Omnigent(await props.service.ready(), workspaceIdOf(props.service));
    const check = await omnigent.check();
    return check.ok ? { agents: await omnigent.agents(), url: omnigent.webUrl() } : { reason: check.reason };
  }, [props.service, status2]);
  const value = props.value ?? { agent: DEFAULT_OMNIGENT_AGENT, label: omnigentAgentLabel(DEFAULT_OMNIGENT_AGENT) };
  const agents = found.data && "agents" in found.data && found.data.agents || [];
  const reason = found.error ? describeError(found.error) : found.data && "reason" in found.data ? found.data.reason : void 0;
  return /* @__PURE__ */ React.createElement(Stack, { gap: 8 }, reason && /* @__PURE__ */ React.createElement(Notice, { tone: "warning" }, reason), /* @__PURE__ */ React.createElement(
    SinglePicker,
    {
      label: "Omnigent agent",
      hint: "Its sessions run on Sandboxes Omnigent makes for you, with models from AI Gateway. It answers with what Omnigent's agent can do there; your Databricks tools and skills aren't added to it.",
      value: value.agent,
      valueLabel: value.label,
      placeholder: omnigentAgentLabel(DEFAULT_OMNIGENT_AGENT),
      searchPlaceholder: `Search ${agents.length} agents`,
      options: agents.map((agent) => ({ id: agent.name, label: agent.label, group: "Omnigent", ...agent.detail && { detail: agent.detail } })),
      loading: found.loading && !found.data ? "Loading Omnigent agents\u2026" : false,
      ...props.disabled !== void 0 && { disabled: props.disabled },
      onChange: (option) => props.onChange({ agent: option.id, label: option.label })
    }
  ));
}
function HostedForm(props) {
  const { config, onChange } = props;
  const workspace = useAgentService(props.service, config.profile);
  const status2 = useConnection(workspace).status;
  const available = useAsync(() => cachedList(workspace, "sandbox", async () => new Sandboxes(await workspace.ready()).available()), [workspace, status2]);
  const kind = KIND_CHOICES.find((choice) => choice.id === config.kind) ?? KIND_CHOICES[0];
  const harness = HARNESS_CHOICES.find((choice) => choice.id === config.harness) ?? HARNESS_CHOICES[0];
  const disabled = props.disabled !== void 0 ? { disabled: props.disabled } : {};
  return /* @__PURE__ */ React.createElement(DbxRoot, null, /* @__PURE__ */ React.createElement(Stack, { gap: 14 }, /* @__PURE__ */ React.createElement(NeedsConnection, { service: props.service }), !props.locked && /* @__PURE__ */ React.createElement(Text, { tone: "subtle", size: "sm" }, "Runs in Databricks, in its own Sandbox, so it can answer with Buzz closed. It can't use Buzz's own tools, and Buzz doesn't show it working."), available.data === false && /* @__PURE__ */ React.createElement(Notice, { tone: "warning" }, "Databricks Sandbox isn't on in this workspace, and this agent runs in one. An admin can turn on the Sandbox preview."), !props.locked && /* @__PURE__ */ React.createElement(
    SinglePicker,
    {
      label: "Type",
      hint: kind.detail,
      value: kind.id,
      placeholder: "Genie",
      search: false,
      options: KIND_CHOICES.map((choice) => ({ id: choice.id, label: choice.label, group: "", detail: choice.short, icon: /* @__PURE__ */ React.createElement(choice.Icon, null) })),
      ...disabled,
      onChange: (option) => onChange(normalizeHosted({ ...config, kind: option.id }))
    }
  ), !props.locked && /* @__PURE__ */ React.createElement(
    WorkspaceField,
    {
      service: props.service,
      ...config.profile && { profile: config.profile },
      ...disabled,
      onChange: (profile) => {
        const { profile: _old, genie: _genie, ...rest } = config;
        onChange({ ...rest, ...profile && { profile }, tools: config.tools.filter((tool) => tool.kind === "genie-one") });
      }
    }
  ), config.kind === "omnigent" ? /* @__PURE__ */ React.createElement(
    OmnigentField,
    {
      service: workspace,
      ...config.omnigent && { value: config.omnigent },
      ...disabled,
      onChange: (omnigent) => onChange({ ...config, omnigent })
    }
  ) : config.kind === "genie" ? /* @__PURE__ */ React.createElement(
    GenieField,
    {
      service: workspace,
      ...config.genie && { value: config.genie },
      ...disabled,
      onChange: (genie) => {
        const { genie: _old, ...rest } = config;
        onChange({ ...rest, ...genie && { genie } });
      }
    }
  ) : /* @__PURE__ */ React.createElement(React.Fragment, null, /* @__PURE__ */ React.createElement(Field, { label: "Harness", hint: `${harness.detail} ${permissionsHint(harness.id, "standard")}` }, /* @__PURE__ */ React.createElement(
    "select",
    {
      className: "dbx-select",
      ...disabled,
      value: harness.id,
      onChange: (event) => {
        const next = event.target.value;
        onChange({ ...config, harness: next, model: harnessAccepts(next, config.model) ? config.model : HARNESS_MODEL[next] });
      }
    },
    HARNESS_CHOICES.map((choice) => /* @__PURE__ */ React.createElement("option", { key: choice.id, value: choice.id }, choice.label))
  )), /* @__PURE__ */ React.createElement(
    ModelField,
    {
      service: workspace,
      value: config.model,
      ...disabled,
      accepts: (id) => harnessAccepts(harness.id, id),
      hint: `Models ${harness.label} can use, from AI Gateway in this workspace.`,
      onChange: (model) => onChange({ ...config, model })
    }
  ), /* @__PURE__ */ React.createElement(ToolsField, { service: workspace, tools: config.tools, ...disabled, onChange: (tools) => onChange({ ...config, tools }) }), /* @__PURE__ */ React.createElement(SkillsField, { service: props.service, ...config.profile && { profile: config.profile }, value: config.skills, ...disabled, onChange: (skills) => onChange({ ...config, skills }) })), /* @__PURE__ */ React.createElement(Field, { label: "Availability", hint: AVAILABILITY_HINT[config.availability] }, /* @__PURE__ */ React.createElement("select", { className: "dbx-select", ...disabled, value: config.availability, onChange: (event) => onChange({ ...config, availability: event.target.value }) }, /* @__PURE__ */ React.createElement("option", { value: "sleep" }, "Sleep when Buzz is closed"), /* @__PURE__ */ React.createElement("option", { value: "always" }, "Always on"))), /* @__PURE__ */ React.createElement(Field, { label: "Conversation", hint: "Thread: each thread is its own conversation. Channel: one conversation for the whole channel." }, /* @__PURE__ */ React.createElement("select", { className: "dbx-select", ...disabled, value: config.scope, onChange: (event) => onChange({ ...config, scope: event.target.value }) }, /* @__PURE__ */ React.createElement("option", { value: "thread" }, "One per thread"), /* @__PURE__ */ React.createElement("option", { value: "channel" }, "One per channel"))), config.kind !== "genie" && /* @__PURE__ */ React.createElement(Field, { label: "Instructions", hint: "Optional. Who it is, what it should focus on, how to answer." }, /* @__PURE__ */ React.createElement("textarea", { className: "dbx-textarea", rows: 5, ...disabled, value: config.instructions, onChange: (event) => onChange({ ...config, instructions: event.target.value }) })), !props.locked && /* @__PURE__ */ React.createElement(Text, { tone: "tertiary", size: "xs" }, "Only your own messages reach it. Its Sandbox belongs to you in Databricks; removing the agent deletes it.")));
}
var STATE_LABEL = {
  SANDBOX_STATE_RUNNING: "Running",
  SANDBOX_STATE_STOPPING: "Stopping",
  SANDBOX_STATE_PENDING: "Starting",
  missing: "Its Sandbox is gone"
};
var stateLabel = (state, availability) => state === "SANDBOX_STATE_STOPPED" ? availability === "sleep" ? "Asleep" : "Stopped" : STATE_LABEL[state ?? ""] ?? state ?? "Unknown";
function HostedSettings(props) {
  const [nonce, setNonce] = React.useState(0);
  const status2 = useAsync(() => props.provider.status(props.pubkey), [props.pubkey, nonce]);
  const record = props.provider.read(props.pubkey);
  const [draft, setDraft] = React.useState(record?.config);
  const [busy, setBusy] = React.useState();
  const [error, setError] = React.useState();
  if (!record || !draft)
    return /* @__PURE__ */ React.createElement(DbxRoot, { style: { padding: "4px 0 24px" } }, /* @__PURE__ */ React.createElement(Notice, { tone: "info" }, "This agent was set up from another device, which manages its settings."));
  const run = (label, work) => {
    setBusy(label);
    setError(void 0);
    work().then(
      () => {
        setBusy(void 0);
        setNonce((n) => n + 1);
      },
      (cause) => {
        setBusy(void 0);
        setError(describeError(cause));
      }
    );
  };
  const state = status2.data?.state;
  const runnerState = status2.data?.runner;
  const dirty = JSON.stringify(draft) !== JSON.stringify(record.config);
  const left = hoursLeft(runnerState?.bootedAt);
  return /* @__PURE__ */ React.createElement(DbxRoot, { style: { padding: "4px 0 24px" } }, /* @__PURE__ */ React.createElement(Stack, { gap: 16 }, /* @__PURE__ */ React.createElement(
    Notice,
    {
      tone: state === "SANDBOX_STATE_RUNNING" && runnerState?.running === false ? "warning" : "info",
      title: status2.loading && !status2.data ? "Checking\u2026" : stateLabel(state, record.config.availability),
      action: /* @__PURE__ */ React.createElement(Button, { size: "sm", disabled: Boolean(busy), onClick: () => run("wake", () => props.provider.wake(props.pubkey, { refresh: false })) }, busy === "wake" ? /* @__PURE__ */ React.createElement(Spinner, { size: 11 }) : null, state === "SANDBOX_STATE_RUNNING" ? "Check again" : "Wake now")
    },
    state === "SANDBOX_STATE_RUNNING" ? runnerState?.running ? `${runnerState.connected ? "Connected to the community" : "Connecting"}${runnerState.active ? ` \xB7 working on ${runnerState.active}` : ""}${runnerState.lastError ? ` \xB7 last error: ${runnerState.lastError}` : ""}.${record.config.availability === "always" && left !== void 0 ? ` Databricks stops its Sandbox in about ${Math.max(1, Math.round(left))} h; your Buzz restarts it sooner, at a quiet moment.` : ""}` : "The Sandbox is up but the agent isn't running; Wake now starts it." : state === "SANDBOX_STATE_STOPPED" ? record.config.availability === "sleep" ? "It slept while Buzz was closed. Buzz wakes it within a few minutes, or now with Wake now." : `Databricks stops a Sandbox ${SANDBOX_DAY_HOURS} hours after it starts. Buzz starts it again within a few minutes, or now with Wake now.` : `Sandbox ${record.sandbox}.`
  ), /* @__PURE__ */ React.createElement(HostedForm, { service: props.service, config: draft, onChange: setDraft, ...busy && { disabled: true }, locked: true }), error && /* @__PURE__ */ React.createElement(Notice, { tone: "danger" }, error), /* @__PURE__ */ React.createElement(Stack, { direction: "row", gap: 8, justify: "flex-end" }, /* @__PURE__ */ React.createElement(Button, { variant: "ghost", disabled: !dirty || Boolean(busy), onClick: () => setDraft(record.config) }, "Revert"), /* @__PURE__ */ React.createElement(Button, { variant: "primary", disabled: !dirty || Boolean(busy), onClick: () => run("save", () => props.provider.update(props.pubkey, draft)) }, busy === "save" ? /* @__PURE__ */ React.createElement(Spinner, { size: 11 }) : null, "Save"))));
}
var shown = /* @__PURE__ */ new Map();
function HostedActivity(props) {
  const { provider: provider2 } = props;
  const pubkey = props.agent.pubkey;
  const [turns, setTurns] = React.useState(() => shown.get(pubkey) ?? []);
  const [state, setState] = React.useState({ loading: true });
  React.useEffect(() => {
    if (!provider2.read(pubkey)) return setState({ loading: false });
    const controller = new AbortController();
    let timer;
    const load = async () => {
      try {
        const found = await provider2.activity(pubkey, controller.signal);
        if (controller.signal.aborted) return;
        if (found) {
          shown.set(pubkey, found);
          setTurns(found);
        }
        setState({ loading: false, ...found === void 0 && { asleep: true } });
      } catch (error) {
        if (!controller.signal.aborted) setState({ loading: false, error: describeError(error) });
      }
      if (!controller.signal.aborted) timer = setTimeout(() => void load(), 4e3);
    };
    void load();
    return () => {
      controller.abort();
      if (timer) clearTimeout(timer);
    };
  }, [provider2, pubkey]);
  if (!provider2.read(pubkey))
    return /* @__PURE__ */ React.createElement(DbxRoot, { style: { padding: "4px 0 24px" } }, /* @__PURE__ */ React.createElement(Notice, { tone: "info" }, "This agent was set up from another device; its activity shows there."));
  return /* @__PURE__ */ React.createElement(
    ActivityView,
    {
      turns,
      loading: state.loading,
      ...state.error && { error: `Couldn't read its activity: ${state.error}` },
      ...props.conversation && { conversation: props.conversation },
      ...props.openConversation && { openConversation: props.openConversation },
      ...props.initialTranscript && { initialTranscript: props.initialTranscript },
      note: /* @__PURE__ */ React.createElement(Text, { tone: "tertiary", size: "xs" }, state.asleep ? "Its Sandbox is asleep, so this is what it last showed. " : "", "Each step it took in its Sandbox and its thinking, for its last 25 turns.")
    }
  );
}
function registerHostedType(agents, service) {
  const provider2 = hostedProvider(agents, service);
  const icon = databricksIcon();
  const type = {
    id: HOSTED_TYPE_ID,
    icon,
    title: "Databricks",
    description: "Runs in your Databricks workspace, so it can answer with Buzz closed: Genie, or Claude Code, Codex or Pi in its own Sandbox. No Buzz tools or working indicator.",
    defaults: () => ({ config: normalizeHosted({}) }),
    summary: (agent) => summarizeHosted(provider2.read(agent.pubkey ?? "")?.config ?? normalizeHosted(agent.config)),
    Create: (props) => /* @__PURE__ */ React.createElement(HostedForm, { service, config: normalizeHosted(props.config), onChange: props.onChange, disabled: props.disabled }),
    tabs: [
      {
        id: "settings",
        title: "Settings",
        role: "settings",
        component: (props) => /* @__PURE__ */ React.createElement(HostedSettings, { service, provider: provider2, pubkey: props.agent.pubkey })
      },
      {
        id: "activity",
        title: "Activity",
        role: "activity",
        component: (props) => /* @__PURE__ */ React.createElement(HostedActivity, { provider: provider2, ...props })
      }
    ],
    remote: {
      provision: provider2.provision,
      activate: provider2.activate,
      profile: provider2.profile,
      interrupt: provider2.interrupt,
      remove: provider2.remove
    }
  };
  agents.register(type);
  return tendAgents(provider2);
}

// plugins/agents/src/activity-log.ts
var PREFIX = "bkvarda.databricks-activity.v1:";
var KEEP = 25;
var ActivityLog = class {
  constructor(storage) {
    this.storage = storage;
  }
  cache = /* @__PURE__ */ new Map();
  listeners = /* @__PURE__ */ new Set();
  pending = /* @__PURE__ */ new Map();
  /** The agent's turns, newest first. */
  turns(agent) {
    let turns = this.cache.get(agent);
    if (!turns) {
      try {
        turns = JSON.parse(this.storage.get(PREFIX + agent) ?? "[]");
      } catch {
        turns = [];
      }
      this.cache.set(agent, turns);
    }
    return turns;
  }
  subscribe(listener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  changed(agent) {
    this.cache.set(agent, [...this.turns(agent)]);
    for (const listener of this.listeners) listener();
    if (this.pending.has(agent)) return;
    this.pending.set(
      agent,
      setTimeout(() => {
        this.pending.delete(agent);
        void this.storage.set(PREFIX + agent, JSON.stringify(this.turns(agent).slice(0, KEEP))).catch(() => {
        });
      }, 1e3)
    );
  }
  /** Starts recording a turn; its steps also go to Buzz through `delivery.step`. */
  start(delivery, init) {
    const agent = delivery.agent.pubkey;
    const turn = {
      id: crypto.randomUUID(),
      startedAt: Date.now(),
      items: [],
      ...init.channelId && { channelId: init.channelId },
      ...init.root && { root: init.root },
      ...init.request && { request: snippet(init.request, 300) }
    };
    const turns = [turn, ...this.turns(agent).filter((existing) => existing.id !== turn.id)].slice(0, KEEP);
    this.cache.set(agent, turns);
    this.changed(agent);
    const show = (step) => {
      delivery.step?.(step.tool, step.target);
      addItem(turn, { at: Date.now(), kind: "step", text: stepText(step) });
      this.changed(agent);
    };
    return {
      tool: (tool, target2) => show(describeStep(tool, target2, init.labels)),
      step: show,
      thought: (text) => {
        if (!text.trim()) return;
        const step = thoughtStep(text);
        delivery.step?.(step.tool, step.target);
        addItem(turn, { at: Date.now(), kind: "thought", text });
        this.changed(agent);
      },
      note: (text) => {
        addItem(turn, { at: Date.now(), kind: "note", text });
        this.changed(agent);
      },
      end: (outcome, error) => {
        turn.endedAt = Date.now();
        turn.outcome = outcome;
        if (error) turn.error = snippet(error, 500);
        this.changed(agent);
      }
    };
  }
};

// plugins/agents/src/outsider.ts
var OUTSIDER_QUIET_MS = 60 * 6e4;
var OUTSIDER_TEXT = "Hi! I only take requests from the person who set me up, since I work with their Databricks access, so I can't help with this one. I've let them know you asked.";
var OutsiderNotes = class {
  constructor(quietMs = OUTSIDER_QUIET_MS, now = () => Date.now()) {
    this.quietMs = quietMs;
    this.now = now;
  }
  told = /* @__PURE__ */ new Map();
  /** True, and remembered, when this agent hasn't told this person in this conversation lately. */
  take(agent, person, conversation) {
    const now = this.now();
    const key2 = `${agent}|${person}|${conversation}`;
    const at = this.told.get(key2);
    if (at !== void 0 && now - at < this.quietMs) return false;
    this.told.set(key2, now);
    if (this.told.size > 1e3) {
      for (const [old, when2] of this.told) if (now - when2 >= this.quietMs) this.told.delete(old);
    }
    return true;
  }
};
function threadRoot(event) {
  const tagged = (marker) => event.tags.find((tag) => tag[0] === "e" && tag[3] === marker)?.[1];
  return tagged("root") ?? tagged("reply") ?? event.id;
}
function outsiderNote(event, owner) {
  const channel = event.tags.find((tag) => tag[0] === "h")?.[1];
  if (!channel) return void 0;
  return {
    kind: 9,
    content: OUTSIDER_TEXT,
    tags: [
      ["h", channel],
      ["e", threadRoot(event), "", "reply"],
      ["p", event.pubkey],
      ["p", owner]
    ]
  };
}
async function noteOutsider(delivery, notes) {
  const { trigger, agent } = delivery;
  const event = trigger.type === "mention" ? trigger.event : void 0;
  if (!event || event.pubkey === agent.owner || event.pubkey === agent.pubkey) return false;
  const note = outsiderNote(event, agent.owner);
  if (!note) return false;
  const channel = note.tags[0][1];
  if (!notes.take(agent.pubkey, event.pubkey, `${channel}|${threadRoot(event)}`)) return false;
  try {
    await agent.publish(note);
    return true;
  } catch (error) {
    console.warn("A Databricks agent couldn't tell someone it only takes its owner's requests", error);
    return false;
  }
}

// plugins/agents/src/loop.ts
var MESSAGE_TOOLS = /* @__PURE__ */ new Set(["send", "reply_in_subthread"]);
var MAX_RESULT = 24e3;
var NAME2 = /^[a-zA-Z0-9_-]{1,64}$/;
var rpcId = 0;
async function rpc(handler, method, params) {
  const response = await handler({ jsonrpc: "2.0", id: ++rpcId, method, ...params !== void 0 && { params } });
  if (response?.error) throw new Error(response.error.message ?? `${method} failed`);
  return response?.result ?? {};
}
async function buzzTools(handler) {
  const listed = await rpc(handler, "tools/list");
  return (listed.tools ?? []).filter((tool) => NAME2.test(tool.name));
}
function toFunction(tool) {
  const parameters = tool.inputSchema && typeof tool.inputSchema === "object" ? tool.inputSchema : { type: "object", properties: {} };
  return {
    type: "function",
    function: {
      name: tool.name,
      description: (tool.description ?? "").slice(0, 4e3),
      parameters: { type: "object", properties: {}, ...parameters }
    }
  };
}
function clip(text) {
  return text.length > MAX_RESULT ? `${text.slice(0, MAX_RESULT)}
\u2026 (${text.length - MAX_RESULT} more characters cut)` : text;
}
function parseArgs(call) {
  try {
    const parsed = JSON.parse(call.function.arguments || "{}");
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}
async function callBuzz(handler, name, args) {
  const result = await rpc(handler, "tools/call", { name, arguments: args });
  const text = (result.content ?? []).map((part) => part.type === "text" ? part.text ?? "" : `[${part.type}]`).join("\n");
  return { text: text || (result.isError ? "Error" : "OK"), error: Boolean(result.isError) };
}
function reasoningText(content) {
  if (!Array.isArray(content)) return "";
  return content.flatMap(
    (part) => part?.type === "reasoning" ? Array.isArray(part.summary) ? part.summary.map((entry) => entry?.text ?? "") : [part.text ?? ""] : []
  ).join("\n").trim();
}
function target(args) {
  for (const key2 of ["channel", "path", "command", "agent", "statement", "question", "query", "url"]) {
    const value = args[key2];
    if (typeof value === "string" && value) return value.length > 60 ? `${value.slice(0, 57)}\u2026` : value;
  }
  return void 0;
}
async function runLoop(input) {
  const listed = (input.buzz ? await buzzTools(input.buzz) : []).filter((tool) => input.buzzFilter?.(tool.name) ?? true);
  const local = new Map((input.local ?? []).map((tool) => [tool.name, tool]));
  const buzzNames = new Set(listed.map((tool) => tool.name));
  const tools = [
    ...listed.map(toFunction),
    ...[...local.values()].filter((tool) => !buzzNames.has(tool.name)).map((tool) => ({
      type: "function",
      function: { name: tool.name, description: tool.description, parameters: tool.parameters }
    }))
  ];
  const added = [{ role: "user", content: input.prompt }];
  const usage = { prompt: 0, completion: 0 };
  let posted = false;
  let final = false;
  let text = "";
  const maxSteps = input.maxSteps ?? 24;
  let steps = 0;
  while (steps < maxSteps) {
    input.signal.throwIfAborted();
    steps++;
    const completion = await input.chat({
      model: input.model,
      messages: [{ role: "system", content: input.system }, ...input.history, ...added],
      tools,
      signal: input.signal
    });
    usage.prompt += completion.usage?.prompt_tokens ?? 0;
    usage.completion += completion.usage?.completion_tokens ?? 0;
    const choice = completion.choices[0];
    if (!choice) throw new Error("The model returned no answer.");
    const content = messageText(choice.message.content);
    const calls = choice.message.tool_calls ?? [];
    const reasoning = reasoningText(choice.message.content);
    if (reasoning) input.onThought?.(reasoning);
    if (calls.length && content.trim()) input.onThought?.(content);
    added.push({ role: "assistant", content: content || null, ...calls.length && { tool_calls: calls } });
    if (!calls.length) {
      text = content;
      break;
    }
    for (const call of calls) {
      input.signal.throwIfAborted();
      const args = parseArgs(call);
      const name = call.function.name;
      input.onStep?.(name, target(args));
      let result;
      try {
        const localTool = local.get(name);
        if (localTool && !buzzNames.has(name)) result = await localTool.run(args, input.signal);
        else if (input.buzz && buzzNames.has(name)) {
          const reply = await callBuzz(input.buzz, name, args);
          result = reply.error ? `Error: ${reply.text}` : reply.text;
          if (!reply.error && MESSAGE_TOOLS.has(name)) {
            posted = true;
            if (args.final === true) final = true;
          }
        } else result = `Error: there is no tool named ${name}.`;
      } catch (error) {
        result = `Error: ${error.message ?? String(error)}`;
      }
      added.push({ role: "tool", tool_call_id: call.id, content: clip(result) });
    }
    if (final) break;
  }
  return { text, posted, final, messages: added, steps, usage };
}
function trimHistory(messages, maxChars = 12e4, maxMessages = 120) {
  const size = (list) => list.reduce((total, message) => total + (typeof message.content === "string" ? message.content.length : 0) + 200, 0);
  let start = 0;
  while ((size(messages.slice(start)) > maxChars || messages.length - start > maxMessages) && start < messages.length) {
    const next = messages.findIndex((message, index) => index > start && message.role === "user");
    if (next === -1) break;
    start = next;
  }
  return messages.slice(start);
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

// plugins/sql/src/tools.ts
var ALLOW_WRITES = "sqlAgentWrites";
var AUDIENCE2 = "These rows came from the owner's Databricks access; everyone in this conversation can read what you post. To let readers re-run it with their own access, post the SQL in a ```sql block.";
function sqlTools(service) {
  return [
    {
      name: "databricks_sql_query",
      description: "Runs a Databricks SQL statement on a SQL warehouse and returns the result as a Markdown table (Spark SQL / Databricks SQL dialect; use three-part names catalog.schema.table). Read-only statements (SELECT, WITH, SHOW, DESCRIBE, EXPLAIN) are always allowed; statements that change data are refused unless the owner allowed them. Use databricks_catalog_list and databricks_table_describe to find tables and columns first.",
      inputSchema: schema.object(
        {
          statement: schema.string("One SQL statement."),
          warehouse: schema.string("Warehouse id or name; defaults to the owner's default warehouse."),
          catalog: schema.string("Default catalog for unqualified names."),
          schema: schema.string("Default schema for unqualified names."),
          max_rows: schema.integer("Rows to include in the reply (default 50, max 200).")
        },
        ["statement"]
      ),
      async call(_client, _context, args) {
        const statement = stringArg(args, "statement");
        if (!isReadOnlySql(statement) && !service.preferences.get(ALLOW_WRITES))
          throw new Error(
            "That statement could change data, and the owner only allows read-only SQL from agents. Ask the owner to run it, or to allow it in Settings \u2192 Databricks SQL."
          );
        const warehouse = await resolveWarehouse(service, stringArg(args, "warehouse", false) || void 0);
        const client = await service.ready();
        const catalog = stringArg(args, "catalog", false);
        const schemaName = stringArg(args, "schema", false);
        const started = Date.now();
        const { statementId, result } = await new Sql(client).execute(statement, {
          warehouseId: warehouse.id,
          rowLimit: 1e3,
          ...catalog && { catalog },
          ...schemaName && { schema: schemaName }
        });
        const total = result.totalRows ?? result.rows.length;
        return [
          `Ran on ${warehouse.name} in ${((Date.now() - started) / 1e3).toFixed(1)}s (statement ${statementId}); ${total} row${total === 1 ? "" : "s"}.`,
          "",
          toMarkdown(result, numberArg(args, "max_rows", 50, 1, 200)),
          "",
          AUDIENCE2
        ].join("\n");
      }
    },
    {
      name: "databricks_sql_warehouses",
      description: "Lists the SQL warehouses the owner can use, with their state and size.",
      inputSchema: schema.object({}),
      async call() {
        const client = await service.ready();
        const warehouses = await new Sql(client).warehouses();
        const preferred = service.preferences.get("warehouseId");
        if (!warehouses.length) return "No SQL warehouses are available to the owner.";
        return warehouses.map(
          (w) => `- ${w.name} (id ${w.id}): ${w.state ?? "unknown"}, ${w.cluster_size ?? "?"}${w.enable_serverless_compute ? ", serverless" : ""}${w.id === preferred ? " \u2014 default" : ""}`
        ).join("\n");
      }
    },
    {
      name: "databricks_catalog_list",
      description: "Browses Unity Catalog: with no arguments lists catalogs; with catalog lists its schemas; with catalog and schema lists its tables and views (with comments).",
      inputSchema: schema.object({
        catalog: schema.string("Catalog name."),
        schema: schema.string("Schema name within the catalog.")
      }),
      async call(_client, _context, args) {
        const client = await service.ready();
        const sql = new Sql(client);
        const catalog = stringArg(args, "catalog", false);
        const schemaName = stringArg(args, "schema", false);
        if (!catalog) {
          const catalogs2 = await sql.catalogs();
          return catalogs2.map((c) => `- ${c.name}${c.comment ? `: ${c.comment}` : ""}`).join("\n") || "No catalogs visible.";
        }
        if (!schemaName) {
          const schemas = await sql.schemas(catalog);
          return schemas.map((s) => `- ${s.full_name}${s.comment ? `: ${s.comment}` : ""}`).join("\n") || `No schemas visible in ${catalog}.`;
        }
        const tables = await sql.tables(catalog, schemaName);
        return tables.map((t) => `- ${t.full_name} (${(t.table_type ?? "TABLE").toLowerCase()})${t.comment ? `: ${t.comment.replace(/\s+/g, " ").slice(0, 160)}` : ""}`).join("\n") || `No tables visible in ${catalog}.${schemaName}.`;
      }
    },
    {
      name: "databricks_table_describe",
      description: "Describes a Unity Catalog table or view: its columns with types and comments, owner, type and description.",
      inputSchema: schema.object({ table: schema.string("Three-part name, catalog.schema.table.") }, ["table"]),
      async call(_client, _context, args) {
        const name = stringArg(args, "table");
        if (!/^[^.\s]+\.[^.\s]+\.[^.\s]+$/.test(name)) throw new Error("Use a three-part name: catalog.schema.table.");
        const client = await service.ready();
        const table = await new Sql(client).table(name);
        return [
          `${table.full_name} (${(table.table_type ?? "TABLE").toLowerCase()})${table.owner ? `, owned by ${table.owner}` : ""}`,
          table.comment ? `
${table.comment}` : "",
          "",
          ...(table.columns ?? []).map((c) => `- ${c.name} ${c.type_text ?? ""}${c.nullable === false ? " not null" : ""}${c.comment ? ` \u2014 ${c.comment}` : ""}`)
        ].join("\n");
      }
    }
  ];
}

// plugins/agents/src/sandbox.ts
var sandboxFor = (pubkey) => sandboxId(`buzz-agent-${pubkey.slice(0, 12)}`);
var SANDBOX_PROMPT = `<databricks-sandbox>
You have your own Databricks Sandbox: a Linux machine in Databricks with Python, Node.js, Rust, git, the Databricks CLI (already signed in as your owner) and internet access. Your working folder is ${SANDBOX_HOME}/work; relative paths in every sandbox tool are relative to it, and each sandbox_exec call is a fresh bash login shell that starts there. Files under ${SANDBOX_HOME} persist across restarts; other paths reset when the sandbox stops. Keep state in files. Use sandbox_read_file / sandbox_write_file / sandbox_list for files. Commands time out after the limit you give (default 120 seconds, up to 1800); start long jobs in the background with nohup and check on them. Never print secrets into conversations.
</databricks-sandbox>`;
var clip2 = (text, max = 2e4) => text.length > max ? `${text.slice(0, max / 2)}
\u2026 (${text.length - max} characters cut) \u2026
${text.slice(-max / 2)}` : text;
async function ensureAgentSandbox(service, pubkey, agentName, signal, onState) {
  const client = await service.ready(signal);
  const sandboxes = new Sandboxes(client);
  const id = sandboxFor(pubkey);
  await sandboxes.ensureRunning(id, {
    displayName: `Buzz agent: ${agentName}`.slice(0, 60),
    tags: { created_by: "buzz", buzz_agent: pubkey.slice(0, 16) },
    signal,
    ...onState && { onState }
  });
  await sandboxes.bash(id, `mkdir -p ${SANDBOX_HOME}/work`, { timeoutSeconds: 30, signal });
  return sandboxes;
}
function sandboxTools(service, pubkey, agentName, onState) {
  const id = sandboxFor(pubkey);
  let ready;
  const ensure = async (signal) => {
    ready ??= ensureAgentSandbox(service, pubkey, agentName, signal, onState).then(() => {
    }).catch((error) => {
      ready = void 0;
      throw error;
    });
    await ready;
    return new Sandboxes(await service.ready(signal));
  };
  return [
    {
      name: "sandbox_exec",
      description: "Runs a bash command in your Databricks Sandbox and returns its exit code, stdout and stderr.",
      parameters: {
        type: "object",
        properties: {
          command: { type: "string", description: "Bash command or script." },
          timeout_seconds: { type: "integer", description: "Limit, 1\u20131800 (default 120)." },
          cwd: { type: "string", description: `Working directory (default ${SANDBOX_HOME}/work).` }
        },
        required: ["command"]
      },
      async run(args, signal) {
        const command = String(args.command ?? "");
        if (!command.trim()) throw new Error("command is required");
        const timeout = Math.min(1800, Math.max(1, Number(args.timeout_seconds) || 120));
        const sandboxes = await ensure(signal);
        const result = await sandboxes.bash(id, command, {
          timeoutSeconds: timeout,
          cwd: typeof args.cwd === "string" && args.cwd ? args.cwd : `${SANDBOX_HOME}/work`,
          signal
        });
        const status2 = result.status?.replace("EXECUTE_COMMAND_STATUS_", "").toLowerCase() ?? "completed";
        return [
          `exit_code: ${result.exit_code ?? "unknown"} (${status2}${result.truncated ? ", output truncated" : ""})`,
          result.stdout ? `stdout:
${clip2(result.stdout)}` : "stdout: (empty)",
          result.stderr ? `stderr:
${clip2(result.stderr, 8e3)}` : ""
        ].filter(Boolean).join("\n");
      }
    },
    {
      name: "sandbox_read_file",
      description: "Reads a text file from your Databricks Sandbox.",
      parameters: { type: "object", properties: { path: { type: "string", description: "Absolute path, or relative to the work directory." } }, required: ["path"] },
      async run(args, signal) {
        const sandboxes = await ensure(signal);
        const path = String(args.path ?? "");
        return clip2(await sandboxes.readFile(id, path.startsWith("/") ? path : `${SANDBOX_HOME}/work/${path}`, signal), 6e4);
      }
    },
    {
      name: "sandbox_write_file",
      description: "Writes (replaces) a text file in your Databricks Sandbox, creating parent directories.",
      parameters: {
        type: "object",
        properties: { path: { type: "string", description: "Absolute path, or relative to the work directory." }, content: { type: "string" } },
        required: ["path", "content"]
      },
      async run(args, signal) {
        const sandboxes = await ensure(signal);
        const raw = String(args.path ?? "");
        const path = raw.startsWith("/") ? raw : `${SANDBOX_HOME}/work/${raw}`;
        const parent = path.slice(0, path.lastIndexOf("/")) || "/";
        await sandboxes.bash(id, `mkdir -p ${JSON.stringify(parent)}`, { timeoutSeconds: 30, signal });
        await sandboxes.writeFile(id, path, String(args.content ?? ""), signal);
        return `Wrote ${String(args.content ?? "").length} characters to ${path}.`;
      }
    },
    {
      name: "sandbox_list",
      description: "Lists a directory in your Databricks Sandbox.",
      parameters: { type: "object", properties: { path: { type: "string", description: `Directory (default ${SANDBOX_HOME}/work).` } } },
      async run(args, signal) {
        const sandboxes = await ensure(signal);
        const path = typeof args.path === "string" && args.path ? args.path : `${SANDBOX_HOME}/work`;
        const entries = await sandboxes.listDirectory(id, path, signal);
        return entries.sort((a, b) => Number(b.directory) - Number(a.directory) || a.name.localeCompare(b.name)).map((entry) => entry.directory ? `${entry.name}/` : `${entry.name}${entry.size !== void 0 ? `  (${entry.size} bytes)` : ""}`).join("\n") || "(empty)";
      }
    }
  ];
}

// plugins/agents/src/state.ts
var PREFIX2 = "bkvarda.databricks-agents.v1";
var Sessions = class {
  constructor(storage) {
    this.storage = storage;
  }
  key(agent, conversation) {
    return `${PREFIX2}:${agent}:${conversation}`;
  }
  get(agent, conversation) {
    try {
      const raw = this.storage.get(this.key(agent, conversation));
      const parsed = raw ? JSON.parse(raw) : void 0;
      if (parsed && Array.isArray(parsed.messages)) return parsed;
    } catch {
    }
    return { messages: [], updatedAt: 0 };
  }
  async set(agent, conversation, session) {
    await this.storage.set(this.key(agent, conversation), JSON.stringify({ ...session, updatedAt: Date.now() }));
  }
  async clear(agent, conversation) {
    await this.storage.set(this.key(agent, conversation), null);
  }
  /** Every conversation key saved for an agent, newest first. */
  list(agent) {
    const prefix = `${PREFIX2}:${agent}:`;
    return this.storage.keys().filter((key2) => key2.startsWith(prefix)).map((key2) => ({ conversation: key2.slice(prefix.length), session: this.get(agent, key2.slice(prefix.length)) })).sort((a, b) => b.session.updatedAt - a.session.updatedAt);
  }
};
function plainText(content) {
  return content.replace(/\[([^\]]*)\]\(nostr:[^)]+\)/g, "").replace(/nostr:(npub|nprofile|note|nevent)1[0-9a-z]+/g, "").replace(/^\s*@\S+\s*/, "").replace(/[ \t]+/g, " ").trim();
}

// plugins/agents/src/types.tsx
var TURN_TIMEOUT_MS = 30 * 6e4;
var Queue = class {
  tails = /* @__PURE__ */ new Map();
  running = /* @__PURE__ */ new Map();
  listeners = /* @__PURE__ */ new Set();
  run(key2, work) {
    const previous = this.tails.get(key2) ?? Promise.resolve();
    const next = previous.catch(() => {
    }).then(async () => {
      const controller = new AbortController();
      this.running.set(key2, controller);
      this.notify();
      try {
        return await work(controller.signal);
      } finally {
        if (this.running.get(key2) === controller) this.running.delete(key2);
        this.notify();
      }
    });
    this.tails.set(key2, next);
    return next;
  }
  active(key2) {
    return this.running.has(key2);
  }
  interrupt(key2) {
    this.running.get(key2)?.abort();
  }
  subscribe(listener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  notify() {
    for (const listener of [...this.listeners]) listener();
  }
};
function deliveredText(delivery) {
  const trigger = delivery.trigger;
  if (trigger.type === "mention") return plainText(trigger.event?.content ?? "");
  return trigger.text ?? "";
}
function provider(service) {
  return {
    snapshot: () => {
      const status2 = service.snapshot().status;
      if (status2 === "connected") return { readiness: "ready" };
      if (status2 === "checking" || status2 === "connecting") return { readiness: "checking" };
      return { readiness: "attention", attentionLabel: "Connect Databricks" };
    },
    subscribe: (listener) => service.subscribe(listener),
    check: () => void 0,
    attentionAction: () => service.openSettings(),
    DialogBody: () => null
  };
}
var conversationKey = (scope, place) => scope === "thread" && place.root ? `${place.channelId}/${place.root}` : place.channelId;
var KIND_IDS = ["sandbox", "genie-one", "custom"];
function normalizeCustom(value) {
  const agent = value ?? {};
  if (!agent.kind || !["endpoint", "app", "genie"].includes(agent.kind) || typeof agent.target !== "string" || !agent.target) return void 0;
  if (agent.kind === "app" && !/^https:\/\//.test(agent.target)) return void 0;
  return {
    kind: agent.kind,
    target: agent.target,
    label: typeof agent.label === "string" && agent.label ? agent.label : agent.target,
    ...typeof agent.task === "string" && agent.task && { task: agent.task }
  };
}
function normalizeDatabricks(config) {
  const value = config ?? {};
  const custom = normalizeCustom(value.custom);
  const kind = KIND_IDS.includes(value.kind) ? value.kind : typeof value.model === "string" && value.model ? "sandbox" : "genie-one";
  return {
    kind,
    harness: HARNESS_IDS.includes(value.harness) ? value.harness : "builtin",
    permissions: value.permissions === "full" ? "full" : "standard",
    model: typeof value.model === "string" && value.model ? value.model : DEFAULT_MODEL,
    instructions: typeof value.instructions === "string" ? value.instructions : "",
    scope: value.scope === "channel" ? "channel" : "thread",
    tools: normalizeChoices(value.tools),
    skills: normalizeSkills(value.skills),
    ...typeof value.profile === "string" && value.profile && { profile: value.profile },
    ...custom && { custom }
  };
}
function agentService(service, profile) {
  return profile && service.forProfile ? service.forProfile(profile) : service;
}
async function databricksTools(service, workspace, config, sandbox, signal) {
  const same = workspace === service;
  const choices = config.tools;
  const genieOne = choices.some((choice) => choice.kind === "genie-one");
  const mcp = await mcpLocalTools(workspace, choices, signal);
  const local = [...sandbox, ...genieLocalTools(workspace, choices), ...mcp.tools, ...same ? [] : sqlTools(workspace).map(fromAgentTool)];
  return {
    local,
    problems: mcp.problems,
    buzzFilter: (name) => {
      if (genieOne && name === "databricks_genie_one_ask") return false;
      if (!same && name.startsWith("databricks_") && !name.startsWith("databricks_memory_")) return false;
      return true;
    }
  };
}
function toolsNote(workspace, service, problems) {
  const lines = [RESULT_PROMPT];
  if (workspace !== service) {
    const snapshot = workspace.snapshot();
    const host = snapshot.status === "connected" ? snapshot.profile.host : "another workspace";
    lines.push(`Your Databricks tools (SQL, Genie, MCP servers, Sandbox) work in ${host}, not the workspace Buzz is connected to.`);
  }
  if (problems.length) lines.push(`These tool servers didn't answer this turn, so their tools are missing: ${problems.join("; ")}.`);
  return lines.join("\n");
}
function registerTypes(agents, kit, service) {
  const icon = databricksIcon();
  const genieOnes = /* @__PURE__ */ new WeakMap();
  const genieOneFor = (workspace) => {
    let found = genieOnes.get(workspace);
    if (!found) genieOnes.set(workspace, found = new GenieOne(workspace));
    return found;
  };
  const sandboxChecks = /* @__PURE__ */ new WeakMap();
  const sandboxOn = (workspace, signal) => {
    const known = sandboxChecks.get(workspace);
    if (known && Date.now() - known.at < 10 * 6e4) return known.on;
    const on = workspace.ready(signal).then((client) => new Sandboxes(client).available(signal)).catch(() => true);
    sandboxChecks.set(workspace, { at: Date.now(), on });
    return on;
  };
  const sessions = new Sessions(agents.storage);
  const queue = new Queue();
  const outsiderNotes = new OutsiderNotes();
  const activity = new ActivityLog(agents.storage);
  function turn(delivery, conversation, config, work) {
    delivery.acknowledged?.();
    const key2 = `${delivery.agent.key}|${conversation.key}`;
    const report = activity.start(delivery, {
      channelId: conversation.channel,
      ...conversation.root && { root: conversation.root },
      request: deliveredText(delivery),
      labels: toolLabels(config.tools)
    });
    const done = queue.run(key2, (signal) => {
      const stop = () => queue.interrupt(key2);
      delivery.signal.addEventListener("abort", stop, { once: true });
      delivery.interruptible?.(async () => stop());
      return work(signal, report).finally(() => delivery.signal.removeEventListener("abort", stop));
    }).then(
      () => {
        report.end("done");
        return { ok: true };
      },
      async (error) => {
        if (error?.name === "AbortError" || error?.name === "TimeoutError") {
          report.end("stopped");
          return { ok: true, stopped: true };
        }
        const message = describeError(error);
        report.end("error", message);
        await kit.reply(delivery.agent, conversation, `I couldn't finish that: ${message}`, { notifyOwner: true }).catch(() => {
        });
        return { ok: false, error: message };
      }
    );
    delivery.workingUntil(done);
  }
  const skillsFor = (config, channelId) => resolveSkills(skillCatalogFor(service, config.profile), normalizeSkills(config.skills), channelId);
  async function sandboxSetup(delivery, config, workspace, signal, step, channelId) {
    const on = await sandboxOn(workspace, signal);
    const sandbox = on ? sandboxTools(workspace, delivery.agent.pubkey, delivery.agent.name, step) : [];
    const tools = await databricksTools(service, workspace, config, sandbox, signal);
    const skills = await skillsFor(config, channelId).catch((error) => ({ skills: [], problems: [describeError(error)] }));
    const skillApi = async (skillSignal) => new Skills(await workspace.ready(skillSignal));
    const local = skills.skills.length ? [...tools.local, ...skillTools(skillApi, skills.skills)] : tools.local;
    const instructions = [
      config.instructions.trim(),
      on ? SANDBOX_PROMPT : "Databricks Sandbox isn't turned on in this workspace, so you can't run code or keep files this turn.",
      skillsSection(skills.skills),
      skills.problems.length ? `Skills that didn't load this turn: ${skills.problems.join("; ")}.` : "",
      toolsNote(workspace, service, tools.problems)
    ].filter(Boolean).join("\n\n");
    return { tools: { ...tools, local }, instructions, cwd: on ? `${SANDBOX_HOME}/work` : "~" };
  }
  async function sandboxTurn(delivery, config, conversation, signal, report) {
    const workspace = agentService(service, config.profile);
    const client = await workspace.ready(signal);
    const session = sessions.get(delivery.agent.key, conversation.key);
    const { tools, instructions, cwd } = await sandboxSetup(delivery, config, workspace, signal, (state) => report.tool("sandbox", state), conversation.channel);
    const system = await kit.systemPrompt(delivery, { scope: config.scope, cwd, instructions, tools: true });
    const prompt = await kit.turnPrompt(delivery, conversation, session.cursor ? { cursor: session.cursor } : {});
    const ai = new Ai(client);
    let answered = false;
    try {
      const result = await runLoop({
        model: delivery.model ?? config.model,
        system,
        history: session.messages,
        prompt: prompt.text,
        buzz: kit.tools(delivery.agent, conversation),
        buzzFilter: tools.buzzFilter,
        local: tools.local,
        chat: async (request) => {
          const completion = await ai.chat(request);
          answered = true;
          return completion;
        },
        signal,
        onStep: (tool, target2) => report.tool(tool, target2),
        onThought: (text) => report.thought(text)
      });
      if (!result.posted && result.text.trim()) await kit.reply(delivery.agent, conversation, result.text.trim());
      await sessions.set(delivery.agent.key, conversation.key, {
        ...session,
        cursor: prompt.cursor,
        messages: trimHistory([...session.messages, ...result.messages])
      });
    } catch (error) {
      if (!answered) prompt.restore();
      throw error;
    }
  }
  async function remoteTurn(delivery, config, harness, conversation, signal, report) {
    const workspace = agentService(service, config.profile);
    const client = await workspace.ready(signal);
    if (!await sandboxOn(workspace, signal))
      throw new Error(`Databricks Sandbox isn't turned on in this workspace, and ${harnessLabel(harness)} runs there. A workspace admin can turn on the Sandbox preview.`);
    const sandbox = await ensureAgentSandbox(workspace, delivery.agent.pubkey, delivery.agent.name, signal, (state) => report.tool("sandbox", state));
    const tools = config.tools.length ? { tools: config.tools, ...workspaceIdOf(workspace) && { workspaceId: workspaceIdOf(workspace) } } : void 0;
    if (tools) await uploadRunner(sandbox, sandboxFor(delivery.agent.pubkey), signal);
    const session = sessions.get(delivery.agent.key, conversation.key);
    const continued = session.remote?.harness === harness ? { harness, id: session.remote.id } : void 0;
    const skills = await skillsFor(config, conversation.channel).catch((error) => ({ skills: [], problems: [describeError(error)] }));
    const installed = await installSkills({ sandboxes: sandbox, sandbox: sandboxFor(delivery.agent.pubkey), api: new Skills(client), skills: skills.skills, signal }).catch((error) => ({
      added: [],
      updated: [],
      removed: [],
      unchanged: [],
      problems: [`Couldn't install skills: ${describeError(error)}`]
    }));
    for (const problem of [...skills.problems, ...installed.problems]) report.tool("skills", problem);
    const instructions = [config.instructions.trim(), remoteNote(harness, config.permissions, config.tools), skillsNote(skills.skills), toolsNote(workspace, service, [])].filter(Boolean).join("\n\n");
    const system = await kit.systemPrompt(delivery, { scope: config.scope, cwd: WORK_DIR, instructions, tools: false });
    const prompt = await kit.turnPrompt(delivery, conversation, continued && session.cursor ? { cursor: session.cursor } : {});
    let started = false;
    try {
      const result = await runRemoteTurn({
        sandboxes: sandbox,
        sandbox: sandboxFor(delivery.agent.pubkey),
        harness,
        model: harnessModel(harness, delivery.model ?? config.model),
        permissions: config.permissions,
        ...continued && { session: continued },
        prompt: prompt.text,
        system,
        signal,
        ...tools && { tools },
        onLaunch: () => started = true,
        onStep: (tool, target2) => report.tool(tool, target2),
        onThought: (text) => report.thought(text),
        // Kept as soon as the harness has it, so a failed turn's context isn't lost.
        onSession: (remote) => void sessions.set(delivery.agent.key, conversation.key, { ...sessions.get(delivery.agent.key, conversation.key), remote })
      });
      await kit.reply(delivery.agent, conversation, result.text);
      await sessions.set(delivery.agent.key, conversation.key, { ...sessions.get(delivery.agent.key, conversation.key), cursor: prompt.cursor, remote: result.session });
    } catch (error) {
      if (!started) prompt.restore();
      throw error;
    }
  }
  async function genieOneTurn(delivery, config, conversation, signal, report) {
    const question = deliveredText(delivery) || "What can I ask you about?";
    const session = sessions.get(delivery.agent.key, conversation.key);
    report.step({ tool: "Asking Genie One", target: question });
    let shown2 = 0;
    const answer = await genieOneFor(agentService(service, config.profile)).ask(question, {
      ...session.genieOneConversationId && { conversationId: session.genieOneConversationId },
      signal,
      // Genie One's own timeline ("Thinking: …", "Running SQL: …"), each step once.
      onProgress: (steps) => {
        for (const line of steps.slice(shown2)) report.step(genieOneStep(line));
        shown2 = Math.max(shown2, steps.length);
      },
      // Waits while Databricks rate-limits Genie One; a question asked again starts its timeline over.
      onRetry: (notice) => {
        report.step(rateLimitStep(notice));
        if (notice.restarted) shown2 = 0;
      }
    });
    const parts = [];
    const text = answerMarkdown(answer);
    if (text) parts.push(text);
    if (answer.status === "incomplete") parts.push("_Genie One stopped early; this may be partial._");
    const sql = answer.sql[answer.sql.length - 1];
    if (sql) parts.push(`\`\`\`sql
${sql.trim()}
\`\`\``);
    if (answer.deepLink) parts.push(`[Explore in Databricks](${answer.deepLink})`);
    await kit.reply(delivery.agent, conversation, parts.join("\n\n") || "Genie One had no answer.");
    await sessions.set(delivery.agent.key, conversation.key, { ...session, genieOneConversationId: answer.conversationId });
  }
  async function genieSpaceTurn(delivery, config, agent, conversation, signal, report) {
    const workspace = agentService(service, config.profile);
    const client = await workspace.ready(signal);
    const question = deliveredText(delivery) || "What can I ask you about?";
    const session = sessions.get(delivery.agent.key, conversation.key);
    report.step({ tool: `Asking ${agent.label}`, target: question });
    let status2 = "";
    const answer = await new Genie(client).answer(agent.target, question, {
      ...session.genieConversationId && { conversationId: session.genieConversationId },
      signal,
      onUpdate: (message) => {
        if (message.status === status2) return;
        status2 = message.status;
        report.step(genieStatusStep(agent.label, status2));
      }
    });
    const link = workspace.workspaceUrl(Genie.webPath(agent.target, answer.message.conversation_id));
    const parts = [];
    if (answer.text) parts.push(answer.text);
    if (answer.result?.columns.length) parts.push(resultBlock(answer.result));
    if (answer.sql) parts.push(`\`\`\`sql
${answer.sql.trim()}
\`\`\``);
    if (answer.message.status !== "COMPLETED") parts.push(`Genie stopped with status ${answer.message.status}${answer.error ? `: ${answer.error}` : ""}.`);
    if (answer.suggestions.length) parts.push(`_You could also ask:_ ${answer.suggestions.slice(0, 3).map((q) => `\u201C${q}\u201D`).join(" \xB7 ")}`);
    if (link) parts.push(`[Open in Genie](${link})`);
    await kit.reply(delivery.agent, conversation, parts.join("\n\n") || "Genie had no answer.");
    await sessions.set(delivery.agent.key, conversation.key, { ...session, genieConversationId: answer.message.conversation_id });
  }
  async function customTurn(delivery, config, conversation, signal, report) {
    const agent = config.custom;
    if (!agent) throw new Error("No agent is chosen yet. My owner can pick one in my Settings.");
    if (agent.kind === "genie") return genieSpaceTurn(delivery, config, agent, conversation, signal, report);
    const client = await agentService(service, config.profile).ready(signal);
    const session = sessions.get(delivery.agent.key, conversation.key);
    const question = deliveredText(delivery);
    const history = session.messages.filter((m) => (m.role === "user" || m.role === "assistant") && typeof m.content === "string");
    const messages = [...history, { role: "user", content: question || "Hello" }];
    report.step({ tool: `Asking ${agent.label}` });
    const reply = await new Ai(client).invokeAgent(agent.target, messages, {
      task: agent.kind === "app" ? "app" : agent.task ?? "",
      sessionId: `${delivery.agent.pubkey.slice(0, 16)}-${conversation.key}`,
      signal
    });
    await kit.reply(delivery.agent, conversation, reply.text || "(The agent returned no text.)");
    await sessions.set(delivery.agent.key, conversation.key, {
      ...session,
      messages: trimHistory([...messages, { role: "assistant", content: reply.text }], 6e4, 40)
    });
  }
  const scopeOf = (config) => config.kind === "sandbox" ? config.scope : "thread";
  const databricksType = {
    id: "databricks",
    icon,
    title: "Databricks",
    description: "Runs from your Buzz, so it answers while Buzz is open: Genie One, a Sandbox agent with Buzz's tools and the Databricks tools you pick, or an agent you built on Databricks.",
    provider: provider(service),
    // Genie One needs no setup: it finds the right data across the workspace.
    defaults: () => ({ config: normalizeDatabricks({ kind: "genie-one", tools: [GENIE_ONE_CHOICE] }) }),
    summary: (agent) => summarize2(normalizeDatabricks(agent.config)),
    adopt: (carry, config) => ({ ...config, instructions: carry.instructions ?? config.instructions }),
    carry: (config) => config.instructions.trim() ? { instructions: config.instructions } : {},
    Create: (props) => /* @__PURE__ */ React.createElement(
      AgentForm,
      {
        service,
        config: normalizeDatabricks(props.config),
        onChange: props.onChange,
        disabled: props.disabled,
        intro: /* @__PURE__ */ React.createElement(Text, { tone: "subtle", size: "sm" }, "Runs from your Buzz, so it answers while Buzz is open on this computer, with Buzz's tools. For an agent that answers with Buzz closed, pick Databricks (hosted).")
      }
    ),
    tabs: [
      {
        id: "settings",
        title: "Settings",
        role: "settings",
        component: (props) => /* @__PURE__ */ React.createElement(
          SettingsTab,
          {
            service,
            config: normalizeDatabricks(props.agent.config),
            save: props.save,
            Form: AgentForm,
            note: normalizeDatabricks(props.agent.config).kind === "sandbox" ? /* @__PURE__ */ React.createElement(SandboxNote, { service, pubkey: props.agent.pubkey }) : null
          }
        )
      },
      {
        id: "activity",
        title: "Activity",
        role: "activity",
        component: (props) => /* @__PURE__ */ React.createElement(LocalActivity, { log: activity, ...props })
      }
    ],
    models: (agent) => {
      const config = normalizeDatabricks(agent.config);
      if (config.kind !== "sandbox") return { current: "", models: [] };
      const current = isRemote(config.harness) ? harnessModel(config.harness, config.model) : config.model;
      const models = DEFAULT_MODELS.filter((model) => harnessAccepts(config.harness, model.id)).map((model) => ({ id: model.id, label: model.label, efforts: [] }));
      if (!models.some((model) => model.id === current)) models.unshift({ id: current, label: modelLabel(current), efforts: [] });
      return { current, models };
    },
    sessionControls: {
      scope: (agent) => scopeOf(normalizeDatabricks(agent.config)),
      state: (agent, place) => queue.active(`${agent.key}|${conversationKey(scopeOf(normalizeDatabricks(agent.config)), place)}`) ? "active" : "idle",
      async run(agent, place, action) {
        const config = normalizeDatabricks(agent.config);
        const key2 = conversationKey(scopeOf(config), place);
        if (action === "interrupt") return queue.interrupt(`${agent.key}|${key2}`);
        if (action === "new") return sessions.clear(agent.key, key2);
        if (config.kind !== "sandbox" || isRemote(config.harness)) return;
        const session = sessions.get(agent.key, key2);
        await sessions.set(agent.key, key2, { ...session, messages: trimHistory(session.messages, 2e4, 12) });
      },
      subscribe: (listener) => queue.subscribe(listener)
    },
    timeoutMs: TURN_TIMEOUT_MS,
    async run(delivery) {
      const config = normalizeDatabricks(delivery.config);
      const conversation = await kit.conversation(delivery, scopeOf(config));
      if (!conversation) {
        delivery.ignored?.();
        void noteOutsider(delivery, outsiderNotes);
        return;
      }
      const harness = config.harness;
      turn(
        delivery,
        conversation,
        config,
        (signal, report) => config.kind === "sandbox" ? isRemote(harness) ? remoteTurn(delivery, config, harness, conversation, signal, report) : sandboxTurn(delivery, config, conversation, signal, report) : config.kind === "custom" ? customTurn(delivery, config, conversation, signal, report) : genieOneTurn(delivery, config, conversation, signal, report)
      );
    },
    async runOnce(standalone) {
      const config = normalizeDatabricks(standalone.delivery.config);
      if (config.kind !== "sandbox") return { ok: false, error: "Watches and timers run on Sandbox agents; Genie One and custom agents answer mentions." };
      if (isRemote(config.harness))
        return { ok: false, error: `Watches and timers run on the Built-in harness for now; ${harnessLabel(config.harness)} answers mentions.` };
      const trigger = standalone.delivery.trigger;
      const report = activity.start(standalone.delivery, {
        ...standalone.delivery.channelId && { channelId: standalone.delivery.channelId },
        request: trigger.type === "watch" ? `Watch: ${trigger.slug ?? "a matching event"}` : trigger.type === "timer" ? "Timer" : deliveredText(standalone.delivery),
        labels: toolLabels(config.tools)
      });
      try {
        const prompt = await standalone.prompt();
        if (!prompt) {
          report.end("done");
          return { ok: true };
        }
        const workspace = agentService(service, config.profile);
        const client = await workspace.ready(standalone.signal);
        const { tools, instructions } = await sandboxSetup(standalone.delivery, config, workspace, standalone.signal, (state) => report.tool("sandbox", state), standalone.delivery.channelId);
        const system = await kit.systemPrompt(standalone.delivery, { scope: config.scope, cwd: "~", instructions, tools: true });
        const ai = new Ai(client);
        await runLoop({
          model: config.model,
          system,
          history: [],
          prompt,
          buzz: kit.tools(standalone.delivery.agent),
          buzzFilter: tools.buzzFilter,
          local: tools.local,
          chat: (request) => ai.chat(request),
          signal: standalone.signal,
          onStep: (tool, target2) => report.tool(tool, target2),
          onThought: (text) => report.thought(text)
        });
        report.end("done");
        return { ok: true };
      } catch (error) {
        report.end("error", describeError(error));
        return { ok: false, error: describeError(error) };
      }
    }
  };
  agents.register(databricksType);
}
function LocalActivity(props) {
  const turns = React.useSyncExternalStore(
    (listener) => props.log.subscribe(listener),
    () => props.log.turns(props.agent.pubkey)
  );
  return /* @__PURE__ */ React.createElement(
    ActivityView,
    {
      turns,
      ...props.conversation && { conversation: props.conversation },
      ...props.openConversation && { openConversation: props.openConversation },
      ...props.initialTranscript && { initialTranscript: props.initialTranscript },
      note: /* @__PURE__ */ React.createElement(Text, { tone: "tertiary", size: "xs" }, "What this agent did on this device: each step it took and its thinking, for its last 25 turns.")
    }
  );
}
function summarize2(config) {
  const where = config.profile ? [config.profile] : [];
  if (config.kind === "genie-one") return ["Genie One", ...where].join(" \xB7 ");
  if (config.kind === "custom") return [config.custom?.label ?? "No agent chosen", ...where].join(" \xB7 ");
  if (isRemote(config.harness)) {
    const id = harnessModel(config.harness, config.model);
    const model2 = DEFAULT_MODELS.find((candidate) => candidate.id === id)?.label ?? modelLabel(id);
    return ["Sandbox", harnessLabel(config.harness), model2, ...config.permissions === "full" ? ["full access"] : [], ...where].join(" \xB7 ");
  }
  const model = DEFAULT_MODELS.find((candidate) => candidate.id === config.model)?.label ?? modelLabel(config.model);
  const tools = config.tools.length ? [`${config.tools.length} ${config.tools.length === 1 ? "tool" : "tools"}`] : [];
  return ["Sandbox", model, ...tools, ...where].join(" \xB7 ");
}
function SandboxNote(props) {
  const url = props.service.workspaceUrl("/compute/sandboxes");
  return /* @__PURE__ */ React.createElement("div", { "data-dbx": "", style: { fontSize: "0.75rem", color: "var(--dbx-subtle)" } }, "Sandbox ", /* @__PURE__ */ React.createElement("span", { className: "dbx-mono" }, sandboxFor(props.pubkey)), " belongs to you in Databricks. It runs up to 24 hours per start and keeps", " ", /* @__PURE__ */ React.createElement("span", { className: "dbx-mono" }, SANDBOX_HOME), ".", " ", url && /* @__PURE__ */ React.createElement("a", { className: "dbx-link", href: url, target: "_blank", rel: "noreferrer" }, "Manage sandboxes"));
}

// plugins/agents/src/index.tsx
var inject = ["react", "agents", "settingsCards"];
function apply(ctx) {
  bindReact(ctx.react);
  const live = attach(ctx, { id: "bkvarda.databricks-agents", name: "Databricks Agents" }, (scope, databricks) => {
    const kit = scope.agents.harness;
    if (!kit) return { kit: false };
    registerTypes(scope.agents, kit, databricks);
    const stop = registerHostedType(scope.agents, databricks);
    scope.effect(() => stop);
    return { kit: true };
  });
  ctx.settingsCards.register({
    id: "agents",
    title: "Databricks Agents",
    component: () => {
      const runtime = useLive(live);
      if (!runtime) return /* @__PURE__ */ React.createElement(MissingCore, { ctx, feature: "Databricks Agents" });
      return /* @__PURE__ */ React.createElement(DbxRoot, null, /* @__PURE__ */ React.createElement(Stack, { gap: 18 }, /* @__PURE__ */ React.createElement(Stack, { gap: 6 }, /* @__PURE__ */ React.createElement(Text, { as: "h2", size: "xl", weight: 500 }, "Databricks Agents"), /* @__PURE__ */ React.createElement(Text, { tone: "subtle" }, "Agents that think on Databricks, with your access and your governance.")), !runtime.kit && /* @__PURE__ */ React.createElement(Notice, { tone: "warning", title: "Update Buzz to create Databricks agents" }, "This version of Buzz doesn't let plugins bring their own agent types yet. Update Buzz (Settings \u2192 Buzz \u2192 Updates); the Databricks types then appear in Agents."), [
        [
          "Databricks",
          "Runs from your Buzz, so it answers while Buzz is open on this computer. Genie One for data questions, a Sandbox agent (a Databricks model, or Claude Code, Codex or Pi in its Sandbox) with Buzz's tools and the Databricks tools you pick, or an agent you built on Databricks. Buzz shows it working and can stop it."
        ],
        [
          "Databricks (hosted)",
          "Runs in your Databricks workspace, in its own Sandbox, so it can answer with Buzz closed. Genie, or Claude Code, Codex or Pi in each harness's guarded mode. Always on, or asleep while Buzz is closed. It can't use Buzz's own tools, and Buzz doesn't show it working."
        ]
      ].map(([title, body]) => /* @__PURE__ */ React.createElement(Stack, { key: title, gap: 2 }, /* @__PURE__ */ React.createElement(Text, { weight: 500 }, title), /* @__PURE__ */ React.createElement(Text, { tone: "subtle", size: "sm" }, body))), /* @__PURE__ */ React.createElement(Text, { size: "sm" }, "To create one, open ", /* @__PURE__ */ React.createElement("b", null, "Agents"), ", choose ", /* @__PURE__ */ React.createElement("b", null, "New agent"), " and pick ", /* @__PURE__ */ React.createElement("b", null, "Databricks"), " or ", /* @__PURE__ */ React.createElement("b", null, "Databricks (hosted)"), " as the harness.")));
    }
  });
}
export {
  apply,
  inject
};
