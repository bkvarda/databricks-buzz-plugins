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
  return a.size === b.size && [...b].every(([id, status3]) => a.get(id) === status3);
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
  constructor(status3, errorCode, message, body) {
    super(message);
    this.status = status3;
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
    if (/^\s*\{/.test(message)) {
      try {
        const inner = JSON.parse(message);
        const text = inner.message ?? inner.error?.message;
        if (typeof text === "string" && text) message = text;
      } catch {
      }
    }
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
/* Markdown inside a card, the host's included: headings no bigger than bold body text. */
[data-dbx] .dbx-quiet-headings :is(h1, h2, h3, h4, h5, h6) { font-size: 1em !important; line-height: inherit !important; font-weight: 600 !important; letter-spacing: normal !important; margin: 12px 0 4px !important; padding: 0 !important; border: 0 !important; }
[data-dbx] .dbx-quiet-headings :is(h1, h2, h3, h4, h5, h6):first-child { margin-top: 0 !important; }
@keyframes dbx-spin { to { transform: rotate(360deg); } }
@keyframes dbx-pulse { 0%, 100% { opacity: 0.35; } 50% { opacity: 1; } }
@media (prefers-reduced-motion: reduce) { [data-dbx] * { animation-duration: 0s !important; transition: none !important; } }
`;
function styleHash(text) {
  let hash = 5381;
  for (let i2 = 0; i2 < text.length; i2++) hash = (hash << 5) + hash + text.charCodeAt(i2) | 0;
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
function StatusDot(props) {
  const color = {
    success: "var(--dbx-success)",
    warning: "var(--dbx-warning)",
    danger: "var(--dbx-danger)",
    neutral: "var(--dbx-tertiary)",
    active: "var(--dbx-lava)"
  }[props.tone];
  return /* @__PURE__ */ React.createElement(
    "span",
    {
      role: "img",
      "aria-label": props.label,
      title: props.label,
      style: {
        display: "inline-block",
        width: 8,
        height: 8,
        borderRadius: "50%",
        background: color,
        flex: "none",
        animation: props.tone === "active" ? "dbx-pulse 1.4s ease-in-out infinite" : void 0
      }
    }
  );
}
function Field(props) {
  return /* @__PURE__ */ React.createElement("label", { style: { display: "flex", flexDirection: "column", gap: 4, minWidth: 0 }, htmlFor: props.id }, /* @__PURE__ */ React.createElement(Text, { size: "sm", weight: 500 }, props.label), props.children, props.hint && /* @__PURE__ */ React.createElement(Text, { size: "xs", tone: "subtle", as: "div" }, props.hint));
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

// node_modules/@noble/hashes/utils.js
function isBytes(a) {
  return a instanceof Uint8Array || ArrayBuffer.isView(a) && a.constructor.name === "Uint8Array";
}
function anumber(n, title = "") {
  if (!Number.isSafeInteger(n) || n < 0) {
    const prefix = title && `"${title}" `;
    throw new Error(`${prefix}expected integer >= 0, got ${n}`);
  }
}
function abytes(value, length, title = "") {
  const bytes2 = isBytes(value);
  const len = value?.length;
  const needsLen = length !== void 0;
  if (!bytes2 || needsLen && len !== length) {
    const prefix = title && `"${title}" `;
    const ofLen = needsLen ? ` of length ${length}` : "";
    const got = bytes2 ? `length=${len}` : `type=${typeof value}`;
    throw new Error(prefix + "expected Uint8Array" + ofLen + ", got " + got);
  }
  return value;
}
function aexists(instance, checkFinished = true) {
  if (instance.destroyed)
    throw new Error("Hash instance has been destroyed");
  if (checkFinished && instance.finished)
    throw new Error("Hash#digest() has already been called");
}
function aoutput(out, instance) {
  abytes(out, void 0, "digestInto() output");
  const min = instance.outputLen;
  if (out.length < min) {
    throw new Error('"digestInto() output" expected to be of length >=' + min);
  }
}
function clean(...arrays) {
  for (let i2 = 0; i2 < arrays.length; i2++) {
    arrays[i2].fill(0);
  }
}
function createView(arr) {
  return new DataView(arr.buffer, arr.byteOffset, arr.byteLength);
}
function rotr(word, shift) {
  return word << 32 - shift | word >>> shift;
}
var hasHexBuiltin = /* @__PURE__ */ (() => (
  // @ts-ignore
  typeof Uint8Array.from([]).toHex === "function" && typeof Uint8Array.fromHex === "function"
))();
var hexes = /* @__PURE__ */ Array.from({ length: 256 }, (_, i2) => i2.toString(16).padStart(2, "0"));
function bytesToHex(bytes2) {
  abytes(bytes2);
  if (hasHexBuiltin)
    return bytes2.toHex();
  let hex2 = "";
  for (let i2 = 0; i2 < bytes2.length; i2++) {
    hex2 += hexes[bytes2[i2]];
  }
  return hex2;
}
var asciis = { _0: 48, _9: 57, A: 65, F: 70, a: 97, f: 102 };
function asciiToBase16(ch) {
  if (ch >= asciis._0 && ch <= asciis._9)
    return ch - asciis._0;
  if (ch >= asciis.A && ch <= asciis.F)
    return ch - (asciis.A - 10);
  if (ch >= asciis.a && ch <= asciis.f)
    return ch - (asciis.a - 10);
  return;
}
function hexToBytes(hex2) {
  if (typeof hex2 !== "string")
    throw new Error("hex string expected, got " + typeof hex2);
  if (hasHexBuiltin)
    return Uint8Array.fromHex(hex2);
  const hl = hex2.length;
  const al = hl / 2;
  if (hl % 2)
    throw new Error("hex string expected, got unpadded hex of length " + hl);
  const array = new Uint8Array(al);
  for (let ai = 0, hi = 0; ai < al; ai++, hi += 2) {
    const n1 = asciiToBase16(hex2.charCodeAt(hi));
    const n2 = asciiToBase16(hex2.charCodeAt(hi + 1));
    if (n1 === void 0 || n2 === void 0) {
      const char = hex2[hi] + hex2[hi + 1];
      throw new Error('hex string expected, got non-hex character "' + char + '" at index ' + hi);
    }
    array[ai] = n1 * 16 + n2;
  }
  return array;
}
function concatBytes(...arrays) {
  let sum = 0;
  for (let i2 = 0; i2 < arrays.length; i2++) {
    const a = arrays[i2];
    abytes(a);
    sum += a.length;
  }
  const res = new Uint8Array(sum);
  for (let i2 = 0, pad = 0; i2 < arrays.length; i2++) {
    const a = arrays[i2];
    res.set(a, pad);
    pad += a.length;
  }
  return res;
}
function createHasher(hashCons, info = {}) {
  const hashC = (msg, opts) => hashCons(opts).update(msg).digest();
  const tmp = hashCons(void 0);
  hashC.outputLen = tmp.outputLen;
  hashC.blockLen = tmp.blockLen;
  hashC.create = (opts) => hashCons(opts);
  Object.assign(hashC, info);
  return Object.freeze(hashC);
}
function randomBytes(bytesLength = 32) {
  const cr = typeof globalThis === "object" ? globalThis.crypto : null;
  if (typeof cr?.getRandomValues !== "function")
    throw new Error("crypto.getRandomValues must be defined");
  return cr.getRandomValues(new Uint8Array(bytesLength));
}
var oidNist = (suffix) => ({
  oid: Uint8Array.from([6, 9, 96, 134, 72, 1, 101, 3, 4, 2, suffix])
});

// node_modules/@noble/hashes/_md.js
function Chi(a, b, c) {
  return a & b ^ ~a & c;
}
function Maj(a, b, c) {
  return a & b ^ a & c ^ b & c;
}
var HashMD = class {
  blockLen;
  outputLen;
  padOffset;
  isLE;
  // For partial updates less than block size
  buffer;
  view;
  finished = false;
  length = 0;
  pos = 0;
  destroyed = false;
  constructor(blockLen, outputLen, padOffset, isLE) {
    this.blockLen = blockLen;
    this.outputLen = outputLen;
    this.padOffset = padOffset;
    this.isLE = isLE;
    this.buffer = new Uint8Array(blockLen);
    this.view = createView(this.buffer);
  }
  update(data) {
    aexists(this);
    abytes(data);
    const { view, buffer, blockLen } = this;
    const len = data.length;
    for (let pos = 0; pos < len; ) {
      const take = Math.min(blockLen - this.pos, len - pos);
      if (take === blockLen) {
        const dataView = createView(data);
        for (; blockLen <= len - pos; pos += blockLen)
          this.process(dataView, pos);
        continue;
      }
      buffer.set(data.subarray(pos, pos + take), this.pos);
      this.pos += take;
      pos += take;
      if (this.pos === blockLen) {
        this.process(view, 0);
        this.pos = 0;
      }
    }
    this.length += data.length;
    this.roundClean();
    return this;
  }
  digestInto(out) {
    aexists(this);
    aoutput(out, this);
    this.finished = true;
    const { buffer, view, blockLen, isLE } = this;
    let { pos } = this;
    buffer[pos++] = 128;
    clean(this.buffer.subarray(pos));
    if (this.padOffset > blockLen - pos) {
      this.process(view, 0);
      pos = 0;
    }
    for (let i2 = pos; i2 < blockLen; i2++)
      buffer[i2] = 0;
    view.setBigUint64(blockLen - 8, BigInt(this.length * 8), isLE);
    this.process(view, 0);
    const oview = createView(out);
    const len = this.outputLen;
    if (len % 4)
      throw new Error("_sha2: outputLen must be aligned to 32bit");
    const outLen = len / 4;
    const state = this.get();
    if (outLen > state.length)
      throw new Error("_sha2: outputLen bigger than state");
    for (let i2 = 0; i2 < outLen; i2++)
      oview.setUint32(4 * i2, state[i2], isLE);
  }
  digest() {
    const { buffer, outputLen } = this;
    this.digestInto(buffer);
    const res = buffer.slice(0, outputLen);
    this.destroy();
    return res;
  }
  _cloneInto(to) {
    to ||= new this.constructor();
    to.set(...this.get());
    const { blockLen, buffer, length, finished, destroyed, pos } = this;
    to.destroyed = destroyed;
    to.finished = finished;
    to.length = length;
    to.pos = pos;
    if (length % blockLen)
      to.buffer.set(buffer);
    return to;
  }
  clone() {
    return this._cloneInto();
  }
};
var SHA256_IV = /* @__PURE__ */ Uint32Array.from([
  1779033703,
  3144134277,
  1013904242,
  2773480762,
  1359893119,
  2600822924,
  528734635,
  1541459225
]);

// node_modules/@noble/hashes/sha2.js
var SHA256_K = /* @__PURE__ */ Uint32Array.from([
  1116352408,
  1899447441,
  3049323471,
  3921009573,
  961987163,
  1508970993,
  2453635748,
  2870763221,
  3624381080,
  310598401,
  607225278,
  1426881987,
  1925078388,
  2162078206,
  2614888103,
  3248222580,
  3835390401,
  4022224774,
  264347078,
  604807628,
  770255983,
  1249150122,
  1555081692,
  1996064986,
  2554220882,
  2821834349,
  2952996808,
  3210313671,
  3336571891,
  3584528711,
  113926993,
  338241895,
  666307205,
  773529912,
  1294757372,
  1396182291,
  1695183700,
  1986661051,
  2177026350,
  2456956037,
  2730485921,
  2820302411,
  3259730800,
  3345764771,
  3516065817,
  3600352804,
  4094571909,
  275423344,
  430227734,
  506948616,
  659060556,
  883997877,
  958139571,
  1322822218,
  1537002063,
  1747873779,
  1955562222,
  2024104815,
  2227730452,
  2361852424,
  2428436474,
  2756734187,
  3204031479,
  3329325298
]);
var SHA256_W = /* @__PURE__ */ new Uint32Array(64);
var SHA2_32B = class extends HashMD {
  constructor(outputLen) {
    super(64, outputLen, 8, false);
  }
  get() {
    const { A, B, C, D, E, F, G, H } = this;
    return [A, B, C, D, E, F, G, H];
  }
  // prettier-ignore
  set(A, B, C, D, E, F, G, H) {
    this.A = A | 0;
    this.B = B | 0;
    this.C = C | 0;
    this.D = D | 0;
    this.E = E | 0;
    this.F = F | 0;
    this.G = G | 0;
    this.H = H | 0;
  }
  process(view, offset) {
    for (let i2 = 0; i2 < 16; i2++, offset += 4)
      SHA256_W[i2] = view.getUint32(offset, false);
    for (let i2 = 16; i2 < 64; i2++) {
      const W15 = SHA256_W[i2 - 15];
      const W2 = SHA256_W[i2 - 2];
      const s0 = rotr(W15, 7) ^ rotr(W15, 18) ^ W15 >>> 3;
      const s1 = rotr(W2, 17) ^ rotr(W2, 19) ^ W2 >>> 10;
      SHA256_W[i2] = s1 + SHA256_W[i2 - 7] + s0 + SHA256_W[i2 - 16] | 0;
    }
    let { A, B, C, D, E, F, G, H } = this;
    for (let i2 = 0; i2 < 64; i2++) {
      const sigma1 = rotr(E, 6) ^ rotr(E, 11) ^ rotr(E, 25);
      const T1 = H + sigma1 + Chi(E, F, G) + SHA256_K[i2] + SHA256_W[i2] | 0;
      const sigma0 = rotr(A, 2) ^ rotr(A, 13) ^ rotr(A, 22);
      const T2 = sigma0 + Maj(A, B, C) | 0;
      H = G;
      G = F;
      F = E;
      E = D + T1 | 0;
      D = C;
      C = B;
      B = A;
      A = T1 + T2 | 0;
    }
    A = A + this.A | 0;
    B = B + this.B | 0;
    C = C + this.C | 0;
    D = D + this.D | 0;
    E = E + this.E | 0;
    F = F + this.F | 0;
    G = G + this.G | 0;
    H = H + this.H | 0;
    this.set(A, B, C, D, E, F, G, H);
  }
  roundClean() {
    clean(SHA256_W);
  }
  destroy() {
    this.set(0, 0, 0, 0, 0, 0, 0, 0);
    clean(this.buffer);
  }
};
var _SHA256 = class extends SHA2_32B {
  // We cannot use array here since array allows indexing by variable
  // which means optimizer/compiler cannot use registers.
  A = SHA256_IV[0] | 0;
  B = SHA256_IV[1] | 0;
  C = SHA256_IV[2] | 0;
  D = SHA256_IV[3] | 0;
  E = SHA256_IV[4] | 0;
  F = SHA256_IV[5] | 0;
  G = SHA256_IV[6] | 0;
  H = SHA256_IV[7] | 0;
  constructor() {
    super(32);
  }
};
var sha256 = /* @__PURE__ */ createHasher(
  () => new _SHA256(),
  /* @__PURE__ */ oidNist(1)
);

// node_modules/@noble/curves/utils.js
var _0n = /* @__PURE__ */ BigInt(0);
var _1n = /* @__PURE__ */ BigInt(1);
function abool(value, title = "") {
  if (typeof value !== "boolean") {
    const prefix = title && `"${title}" `;
    throw new Error(prefix + "expected boolean, got type=" + typeof value);
  }
  return value;
}
function abignumber(n) {
  if (typeof n === "bigint") {
    if (!isPosBig(n))
      throw new Error("positive bigint expected, got " + n);
  } else
    anumber(n);
  return n;
}
function hexToNumber(hex2) {
  if (typeof hex2 !== "string")
    throw new Error("hex string expected, got " + typeof hex2);
  return hex2 === "" ? _0n : BigInt("0x" + hex2);
}
function bytesToNumberBE(bytes2) {
  return hexToNumber(bytesToHex(bytes2));
}
function bytesToNumberLE(bytes2) {
  return hexToNumber(bytesToHex(copyBytes(abytes(bytes2)).reverse()));
}
function numberToBytesBE(n, len) {
  anumber(len);
  n = abignumber(n);
  const res = hexToBytes(n.toString(16).padStart(len * 2, "0"));
  if (res.length !== len)
    throw new Error("number too large");
  return res;
}
function numberToBytesLE(n, len) {
  return numberToBytesBE(n, len).reverse();
}
function copyBytes(bytes2) {
  return Uint8Array.from(bytes2);
}
function asciiToBytes(ascii) {
  return Uint8Array.from(ascii, (c, i2) => {
    const charCode = c.charCodeAt(0);
    if (c.length !== 1 || charCode > 127) {
      throw new Error(`string contains non-ASCII character "${ascii[i2]}" with code ${charCode} at position ${i2}`);
    }
    return charCode;
  });
}
var isPosBig = (n) => typeof n === "bigint" && _0n <= n;
function bitLen(n) {
  let len;
  for (len = 0; n > _0n; n >>= _1n, len += 1)
    ;
  return len;
}
var bitMask = (n) => (_1n << BigInt(n)) - _1n;
function validateObject(object, fields = {}, optFields = {}) {
  if (!object || typeof object !== "object")
    throw new Error("expected valid options object");
  function checkField(fieldName, expectedType, isOpt) {
    const val = object[fieldName];
    if (isOpt && val === void 0)
      return;
    const current = typeof val;
    if (current !== expectedType || val === null)
      throw new Error(`param "${fieldName}" is invalid: expected ${expectedType}, got ${current}`);
  }
  const iter = (f, isOpt) => Object.entries(f).forEach(([k, v]) => checkField(k, v, isOpt));
  iter(fields, false);
  iter(optFields, true);
}
function memoized(fn) {
  const map = /* @__PURE__ */ new WeakMap();
  return (arg, ...args) => {
    const val = map.get(arg);
    if (val !== void 0)
      return val;
    const computed = fn(arg, ...args);
    map.set(arg, computed);
    return computed;
  };
}

// node_modules/@noble/curves/abstract/modular.js
var _0n2 = /* @__PURE__ */ BigInt(0);
var _1n2 = /* @__PURE__ */ BigInt(1);
var _2n = /* @__PURE__ */ BigInt(2);
var _3n = /* @__PURE__ */ BigInt(3);
var _4n = /* @__PURE__ */ BigInt(4);
var _5n = /* @__PURE__ */ BigInt(5);
var _7n = /* @__PURE__ */ BigInt(7);
var _8n = /* @__PURE__ */ BigInt(8);
var _9n = /* @__PURE__ */ BigInt(9);
var _16n = /* @__PURE__ */ BigInt(16);
function mod(a, b) {
  const result = a % b;
  return result >= _0n2 ? result : b + result;
}
function pow2(x, power, modulo) {
  let res = x;
  while (power-- > _0n2) {
    res *= res;
    res %= modulo;
  }
  return res;
}
function invert(number, modulo) {
  if (number === _0n2)
    throw new Error("invert: expected non-zero number");
  if (modulo <= _0n2)
    throw new Error("invert: expected positive modulus, got " + modulo);
  let a = mod(number, modulo);
  let b = modulo;
  let x = _0n2, y = _1n2, u = _1n2, v = _0n2;
  while (a !== _0n2) {
    const q = b / a;
    const r = b % a;
    const m = x - u * q;
    const n = y - v * q;
    b = a, a = r, x = u, y = v, u = m, v = n;
  }
  const gcd = b;
  if (gcd !== _1n2)
    throw new Error("invert: does not exist");
  return mod(x, modulo);
}
function assertIsSquare(Fp, root, n) {
  if (!Fp.eql(Fp.sqr(root), n))
    throw new Error("Cannot find square root");
}
function sqrt3mod4(Fp, n) {
  const p1div4 = (Fp.ORDER + _1n2) / _4n;
  const root = Fp.pow(n, p1div4);
  assertIsSquare(Fp, root, n);
  return root;
}
function sqrt5mod8(Fp, n) {
  const p5div8 = (Fp.ORDER - _5n) / _8n;
  const n2 = Fp.mul(n, _2n);
  const v = Fp.pow(n2, p5div8);
  const nv = Fp.mul(n, v);
  const i2 = Fp.mul(Fp.mul(nv, _2n), v);
  const root = Fp.mul(nv, Fp.sub(i2, Fp.ONE));
  assertIsSquare(Fp, root, n);
  return root;
}
function sqrt9mod16(P) {
  const Fp_ = Field2(P);
  const tn = tonelliShanks(P);
  const c1 = tn(Fp_, Fp_.neg(Fp_.ONE));
  const c2 = tn(Fp_, c1);
  const c3 = tn(Fp_, Fp_.neg(c1));
  const c4 = (P + _7n) / _16n;
  return (Fp, n) => {
    let tv1 = Fp.pow(n, c4);
    let tv2 = Fp.mul(tv1, c1);
    const tv3 = Fp.mul(tv1, c2);
    const tv4 = Fp.mul(tv1, c3);
    const e1 = Fp.eql(Fp.sqr(tv2), n);
    const e2 = Fp.eql(Fp.sqr(tv3), n);
    tv1 = Fp.cmov(tv1, tv2, e1);
    tv2 = Fp.cmov(tv4, tv3, e2);
    const e3 = Fp.eql(Fp.sqr(tv2), n);
    const root = Fp.cmov(tv1, tv2, e3);
    assertIsSquare(Fp, root, n);
    return root;
  };
}
function tonelliShanks(P) {
  if (P < _3n)
    throw new Error("sqrt is not defined for small field");
  let Q = P - _1n2;
  let S = 0;
  while (Q % _2n === _0n2) {
    Q /= _2n;
    S++;
  }
  let Z = _2n;
  const _Fp = Field2(P);
  while (FpLegendre(_Fp, Z) === 1) {
    if (Z++ > 1e3)
      throw new Error("Cannot find square root: probably non-prime P");
  }
  if (S === 1)
    return sqrt3mod4;
  let cc = _Fp.pow(Z, Q);
  const Q1div2 = (Q + _1n2) / _2n;
  return function tonelliSlow(Fp, n) {
    if (Fp.is0(n))
      return n;
    if (FpLegendre(Fp, n) !== 1)
      throw new Error("Cannot find square root");
    let M = S;
    let c = Fp.mul(Fp.ONE, cc);
    let t = Fp.pow(n, Q);
    let R = Fp.pow(n, Q1div2);
    while (!Fp.eql(t, Fp.ONE)) {
      if (Fp.is0(t))
        return Fp.ZERO;
      let i2 = 1;
      let t_tmp = Fp.sqr(t);
      while (!Fp.eql(t_tmp, Fp.ONE)) {
        i2++;
        t_tmp = Fp.sqr(t_tmp);
        if (i2 === M)
          throw new Error("Cannot find square root");
      }
      const exponent = _1n2 << BigInt(M - i2 - 1);
      const b = Fp.pow(c, exponent);
      M = i2;
      c = Fp.sqr(b);
      t = Fp.mul(t, c);
      R = Fp.mul(R, b);
    }
    return R;
  };
}
function FpSqrt(P) {
  if (P % _4n === _3n)
    return sqrt3mod4;
  if (P % _8n === _5n)
    return sqrt5mod8;
  if (P % _16n === _9n)
    return sqrt9mod16(P);
  return tonelliShanks(P);
}
var FIELD_FIELDS = [
  "create",
  "isValid",
  "is0",
  "neg",
  "inv",
  "sqrt",
  "sqr",
  "eql",
  "add",
  "sub",
  "mul",
  "pow",
  "div",
  "addN",
  "subN",
  "mulN",
  "sqrN"
];
function validateField(field) {
  const initial = {
    ORDER: "bigint",
    BYTES: "number",
    BITS: "number"
  };
  const opts = FIELD_FIELDS.reduce((map, val) => {
    map[val] = "function";
    return map;
  }, initial);
  validateObject(field, opts);
  return field;
}
function FpPow(Fp, num2, power) {
  if (power < _0n2)
    throw new Error("invalid exponent, negatives unsupported");
  if (power === _0n2)
    return Fp.ONE;
  if (power === _1n2)
    return num2;
  let p = Fp.ONE;
  let d = num2;
  while (power > _0n2) {
    if (power & _1n2)
      p = Fp.mul(p, d);
    d = Fp.sqr(d);
    power >>= _1n2;
  }
  return p;
}
function FpInvertBatch(Fp, nums, passZero = false) {
  const inverted = new Array(nums.length).fill(passZero ? Fp.ZERO : void 0);
  const multipliedAcc = nums.reduce((acc, num2, i2) => {
    if (Fp.is0(num2))
      return acc;
    inverted[i2] = acc;
    return Fp.mul(acc, num2);
  }, Fp.ONE);
  const invertedAcc = Fp.inv(multipliedAcc);
  nums.reduceRight((acc, num2, i2) => {
    if (Fp.is0(num2))
      return acc;
    inverted[i2] = Fp.mul(acc, inverted[i2]);
    return Fp.mul(acc, num2);
  }, invertedAcc);
  return inverted;
}
function FpLegendre(Fp, n) {
  const p1mod2 = (Fp.ORDER - _1n2) / _2n;
  const powered = Fp.pow(n, p1mod2);
  const yes = Fp.eql(powered, Fp.ONE);
  const zero = Fp.eql(powered, Fp.ZERO);
  const no = Fp.eql(powered, Fp.neg(Fp.ONE));
  if (!yes && !zero && !no)
    throw new Error("invalid Legendre symbol result");
  return yes ? 1 : zero ? 0 : -1;
}
function nLength(n, nBitLength) {
  if (nBitLength !== void 0)
    anumber(nBitLength);
  const _nBitLength = nBitLength !== void 0 ? nBitLength : n.toString(2).length;
  const nByteLength = Math.ceil(_nBitLength / 8);
  return { nBitLength: _nBitLength, nByteLength };
}
var _Field = class {
  ORDER;
  BITS;
  BYTES;
  isLE;
  ZERO = _0n2;
  ONE = _1n2;
  _lengths;
  _sqrt;
  // cached sqrt
  _mod;
  constructor(ORDER, opts = {}) {
    if (ORDER <= _0n2)
      throw new Error("invalid field: expected ORDER > 0, got " + ORDER);
    let _nbitLength = void 0;
    this.isLE = false;
    if (opts != null && typeof opts === "object") {
      if (typeof opts.BITS === "number")
        _nbitLength = opts.BITS;
      if (typeof opts.sqrt === "function")
        this.sqrt = opts.sqrt;
      if (typeof opts.isLE === "boolean")
        this.isLE = opts.isLE;
      if (opts.allowedLengths)
        this._lengths = opts.allowedLengths?.slice();
      if (typeof opts.modFromBytes === "boolean")
        this._mod = opts.modFromBytes;
    }
    const { nBitLength, nByteLength } = nLength(ORDER, _nbitLength);
    if (nByteLength > 2048)
      throw new Error("invalid field: expected ORDER of <= 2048 bytes");
    this.ORDER = ORDER;
    this.BITS = nBitLength;
    this.BYTES = nByteLength;
    this._sqrt = void 0;
    Object.preventExtensions(this);
  }
  create(num2) {
    return mod(num2, this.ORDER);
  }
  isValid(num2) {
    if (typeof num2 !== "bigint")
      throw new Error("invalid field element: expected bigint, got " + typeof num2);
    return _0n2 <= num2 && num2 < this.ORDER;
  }
  is0(num2) {
    return num2 === _0n2;
  }
  // is valid and invertible
  isValidNot0(num2) {
    return !this.is0(num2) && this.isValid(num2);
  }
  isOdd(num2) {
    return (num2 & _1n2) === _1n2;
  }
  neg(num2) {
    return mod(-num2, this.ORDER);
  }
  eql(lhs, rhs) {
    return lhs === rhs;
  }
  sqr(num2) {
    return mod(num2 * num2, this.ORDER);
  }
  add(lhs, rhs) {
    return mod(lhs + rhs, this.ORDER);
  }
  sub(lhs, rhs) {
    return mod(lhs - rhs, this.ORDER);
  }
  mul(lhs, rhs) {
    return mod(lhs * rhs, this.ORDER);
  }
  pow(num2, power) {
    return FpPow(this, num2, power);
  }
  div(lhs, rhs) {
    return mod(lhs * invert(rhs, this.ORDER), this.ORDER);
  }
  // Same as above, but doesn't normalize
  sqrN(num2) {
    return num2 * num2;
  }
  addN(lhs, rhs) {
    return lhs + rhs;
  }
  subN(lhs, rhs) {
    return lhs - rhs;
  }
  mulN(lhs, rhs) {
    return lhs * rhs;
  }
  inv(num2) {
    return invert(num2, this.ORDER);
  }
  sqrt(num2) {
    if (!this._sqrt)
      this._sqrt = FpSqrt(this.ORDER);
    return this._sqrt(this, num2);
  }
  toBytes(num2) {
    return this.isLE ? numberToBytesLE(num2, this.BYTES) : numberToBytesBE(num2, this.BYTES);
  }
  fromBytes(bytes2, skipValidation = false) {
    abytes(bytes2);
    const { _lengths: allowedLengths, BYTES, isLE, ORDER, _mod: modFromBytes } = this;
    if (allowedLengths) {
      if (!allowedLengths.includes(bytes2.length) || bytes2.length > BYTES) {
        throw new Error("Field.fromBytes: expected " + allowedLengths + " bytes, got " + bytes2.length);
      }
      const padded = new Uint8Array(BYTES);
      padded.set(bytes2, isLE ? 0 : padded.length - bytes2.length);
      bytes2 = padded;
    }
    if (bytes2.length !== BYTES)
      throw new Error("Field.fromBytes: expected " + BYTES + " bytes, got " + bytes2.length);
    let scalar = isLE ? bytesToNumberLE(bytes2) : bytesToNumberBE(bytes2);
    if (modFromBytes)
      scalar = mod(scalar, ORDER);
    if (!skipValidation) {
      if (!this.isValid(scalar))
        throw new Error("invalid field element: outside of range 0..ORDER");
    }
    return scalar;
  }
  // TODO: we don't need it here, move out to separate fn
  invertBatch(lst) {
    return FpInvertBatch(this, lst);
  }
  // We can't move this out because Fp6, Fp12 implement it
  // and it's unclear what to return in there.
  cmov(a, b, condition) {
    return condition ? b : a;
  }
};
function Field2(ORDER, opts = {}) {
  return new _Field(ORDER, opts);
}
function getFieldBytesLength(fieldOrder) {
  if (typeof fieldOrder !== "bigint")
    throw new Error("field order must be bigint");
  const bitLength = fieldOrder.toString(2).length;
  return Math.ceil(bitLength / 8);
}
function getMinHashLength(fieldOrder) {
  const length = getFieldBytesLength(fieldOrder);
  return length + Math.ceil(length / 2);
}
function mapHashToField(key2, fieldOrder, isLE = false) {
  abytes(key2);
  const len = key2.length;
  const fieldLen = getFieldBytesLength(fieldOrder);
  const minLen = getMinHashLength(fieldOrder);
  if (len < 16 || len < minLen || len > 1024)
    throw new Error("expected " + minLen + "-1024 bytes of input, got " + len);
  const num2 = isLE ? bytesToNumberLE(key2) : bytesToNumberBE(key2);
  const reduced = mod(num2, fieldOrder - _1n2) + _1n2;
  return isLE ? numberToBytesLE(reduced, fieldLen) : numberToBytesBE(reduced, fieldLen);
}

// node_modules/@noble/curves/abstract/curve.js
var _0n3 = /* @__PURE__ */ BigInt(0);
var _1n3 = /* @__PURE__ */ BigInt(1);
function negateCt(condition, item) {
  const neg = item.negate();
  return condition ? neg : item;
}
function normalizeZ(c, points) {
  const invertedZs = FpInvertBatch(c.Fp, points.map((p) => p.Z));
  return points.map((p, i2) => c.fromAffine(p.toAffine(invertedZs[i2])));
}
function validateW(W, bits) {
  if (!Number.isSafeInteger(W) || W <= 0 || W > bits)
    throw new Error("invalid window size, expected [1.." + bits + "], got W=" + W);
}
function calcWOpts(W, scalarBits) {
  validateW(W, scalarBits);
  const windows = Math.ceil(scalarBits / W) + 1;
  const windowSize = 2 ** (W - 1);
  const maxNumber = 2 ** W;
  const mask = bitMask(W);
  const shiftBy = BigInt(W);
  return { windows, windowSize, mask, maxNumber, shiftBy };
}
function calcOffsets(n, window, wOpts) {
  const { windowSize, mask, maxNumber, shiftBy } = wOpts;
  let wbits = Number(n & mask);
  let nextN = n >> shiftBy;
  if (wbits > windowSize) {
    wbits -= maxNumber;
    nextN += _1n3;
  }
  const offsetStart = window * windowSize;
  const offset = offsetStart + Math.abs(wbits) - 1;
  const isZero = wbits === 0;
  const isNeg = wbits < 0;
  const isNegF = window % 2 !== 0;
  const offsetF = offsetStart;
  return { nextN, offset, isZero, isNeg, isNegF, offsetF };
}
var pointPrecomputes = /* @__PURE__ */ new WeakMap();
var pointWindowSizes = /* @__PURE__ */ new WeakMap();
function getW(P) {
  return pointWindowSizes.get(P) || 1;
}
function assert0(n) {
  if (n !== _0n3)
    throw new Error("invalid wNAF");
}
var wNAF = class {
  BASE;
  ZERO;
  Fn;
  bits;
  // Parametrized with a given Point class (not individual point)
  constructor(Point, bits) {
    this.BASE = Point.BASE;
    this.ZERO = Point.ZERO;
    this.Fn = Point.Fn;
    this.bits = bits;
  }
  // non-const time multiplication ladder
  _unsafeLadder(elm, n, p = this.ZERO) {
    let d = elm;
    while (n > _0n3) {
      if (n & _1n3)
        p = p.add(d);
      d = d.double();
      n >>= _1n3;
    }
    return p;
  }
  /**
   * Creates a wNAF precomputation window. Used for caching.
   * Default window size is set by `utils.precompute()` and is equal to 8.
   * Number of precomputed points depends on the curve size:
   * 2^(𝑊−1) * (Math.ceil(𝑛 / 𝑊) + 1), where:
   * - 𝑊 is the window size
   * - 𝑛 is the bitlength of the curve order.
   * For a 256-bit curve and window size 8, the number of precomputed points is 128 * 33 = 4224.
   * @param point Point instance
   * @param W window size
   * @returns precomputed point tables flattened to a single array
   */
  precomputeWindow(point, W) {
    const { windows, windowSize } = calcWOpts(W, this.bits);
    const points = [];
    let p = point;
    let base2 = p;
    for (let window = 0; window < windows; window++) {
      base2 = p;
      points.push(base2);
      for (let i2 = 1; i2 < windowSize; i2++) {
        base2 = base2.add(p);
        points.push(base2);
      }
      p = base2.double();
    }
    return points;
  }
  /**
   * Implements ec multiplication using precomputed tables and w-ary non-adjacent form.
   * More compact implementation:
   * https://github.com/paulmillr/noble-secp256k1/blob/47cb1669b6e506ad66b35fe7d76132ae97465da2/index.ts#L502-L541
   * @returns real and fake (for const-time) points
   */
  wNAF(W, precomputes, n) {
    if (!this.Fn.isValid(n))
      throw new Error("invalid scalar");
    let p = this.ZERO;
    let f = this.BASE;
    const wo = calcWOpts(W, this.bits);
    for (let window = 0; window < wo.windows; window++) {
      const { nextN, offset, isZero, isNeg, isNegF, offsetF } = calcOffsets(n, window, wo);
      n = nextN;
      if (isZero) {
        f = f.add(negateCt(isNegF, precomputes[offsetF]));
      } else {
        p = p.add(negateCt(isNeg, precomputes[offset]));
      }
    }
    assert0(n);
    return { p, f };
  }
  /**
   * Implements ec unsafe (non const-time) multiplication using precomputed tables and w-ary non-adjacent form.
   * @param acc accumulator point to add result of multiplication
   * @returns point
   */
  wNAFUnsafe(W, precomputes, n, acc = this.ZERO) {
    const wo = calcWOpts(W, this.bits);
    for (let window = 0; window < wo.windows; window++) {
      if (n === _0n3)
        break;
      const { nextN, offset, isZero, isNeg } = calcOffsets(n, window, wo);
      n = nextN;
      if (isZero) {
        continue;
      } else {
        const item = precomputes[offset];
        acc = acc.add(isNeg ? item.negate() : item);
      }
    }
    assert0(n);
    return acc;
  }
  getPrecomputes(W, point, transform) {
    let comp = pointPrecomputes.get(point);
    if (!comp) {
      comp = this.precomputeWindow(point, W);
      if (W !== 1) {
        if (typeof transform === "function")
          comp = transform(comp);
        pointPrecomputes.set(point, comp);
      }
    }
    return comp;
  }
  cached(point, scalar, transform) {
    const W = getW(point);
    return this.wNAF(W, this.getPrecomputes(W, point, transform), scalar);
  }
  unsafe(point, scalar, transform, prev) {
    const W = getW(point);
    if (W === 1)
      return this._unsafeLadder(point, scalar, prev);
    return this.wNAFUnsafe(W, this.getPrecomputes(W, point, transform), scalar, prev);
  }
  // We calculate precomputes for elliptic curve point multiplication
  // using windowed method. This specifies window size and
  // stores precomputed values. Usually only base point would be precomputed.
  createCache(P, W) {
    validateW(W, this.bits);
    pointWindowSizes.set(P, W);
    pointPrecomputes.delete(P);
  }
  hasCache(elm) {
    return getW(elm) !== 1;
  }
};
function mulEndoUnsafe(Point, point, k1, k2) {
  let acc = point;
  let p1 = Point.ZERO;
  let p2 = Point.ZERO;
  while (k1 > _0n3 || k2 > _0n3) {
    if (k1 & _1n3)
      p1 = p1.add(acc);
    if (k2 & _1n3)
      p2 = p2.add(acc);
    acc = acc.double();
    k1 >>= _1n3;
    k2 >>= _1n3;
  }
  return { p1, p2 };
}
function createField(order, field, isLE) {
  if (field) {
    if (field.ORDER !== order)
      throw new Error("Field.ORDER must match order: Fp == p, Fn == n");
    validateField(field);
    return field;
  } else {
    return Field2(order, { isLE });
  }
}
function createCurveFields(type, CURVE, curveOpts = {}, FpFnLE) {
  if (FpFnLE === void 0)
    FpFnLE = type === "edwards";
  if (!CURVE || typeof CURVE !== "object")
    throw new Error(`expected valid ${type} CURVE object`);
  for (const p of ["p", "n", "h"]) {
    const val = CURVE[p];
    if (!(typeof val === "bigint" && val > _0n3))
      throw new Error(`CURVE.${p} must be positive bigint`);
  }
  const Fp = createField(CURVE.p, curveOpts.Fp, FpFnLE);
  const Fn = createField(CURVE.n, curveOpts.Fn, FpFnLE);
  const _b = type === "weierstrass" ? "b" : "d";
  const params = ["Gx", "Gy", "a", _b];
  for (const p of params) {
    if (!Fp.isValid(CURVE[p]))
      throw new Error(`CURVE.${p} must be valid field element of CURVE.Fp`);
  }
  CURVE = Object.freeze(Object.assign({}, CURVE));
  return { CURVE, Fp, Fn };
}
function createKeygen(randomSecretKey, getPublicKey2) {
  return function keygen(seed) {
    const secretKey = randomSecretKey(seed);
    return { secretKey, publicKey: getPublicKey2(secretKey) };
  };
}

// node_modules/@noble/curves/abstract/weierstrass.js
var divNearest = (num2, den) => (num2 + (num2 >= 0 ? den : -den) / _2n2) / den;
function _splitEndoScalar(k, basis, n) {
  const [[a1, b1], [a2, b2]] = basis;
  const c1 = divNearest(b2 * k, n);
  const c2 = divNearest(-b1 * k, n);
  let k1 = k - c1 * a1 - c2 * a2;
  let k2 = -c1 * b1 - c2 * b2;
  const k1neg = k1 < _0n4;
  const k2neg = k2 < _0n4;
  if (k1neg)
    k1 = -k1;
  if (k2neg)
    k2 = -k2;
  const MAX_NUM = bitMask(Math.ceil(bitLen(n) / 2)) + _1n4;
  if (k1 < _0n4 || k1 >= MAX_NUM || k2 < _0n4 || k2 >= MAX_NUM) {
    throw new Error("splitScalar (endomorphism): failed, k=" + k);
  }
  return { k1neg, k1, k2neg, k2 };
}
var _0n4 = BigInt(0);
var _1n4 = BigInt(1);
var _2n2 = BigInt(2);
var _3n2 = BigInt(3);
var _4n2 = BigInt(4);
function weierstrass(params, extraOpts = {}) {
  const validated = createCurveFields("weierstrass", params, extraOpts);
  const { Fp, Fn } = validated;
  let CURVE = validated.CURVE;
  const { h: cofactor, n: CURVE_ORDER } = CURVE;
  validateObject(extraOpts, {}, {
    allowInfinityPoint: "boolean",
    clearCofactor: "function",
    isTorsionFree: "function",
    fromBytes: "function",
    toBytes: "function",
    endo: "object"
  });
  const { endo } = extraOpts;
  if (endo) {
    if (!Fp.is0(CURVE.a) || typeof endo.beta !== "bigint" || !Array.isArray(endo.basises)) {
      throw new Error('invalid endo: expected "beta": bigint and "basises": array');
    }
  }
  const lengths = getWLengths(Fp, Fn);
  function assertCompressionIsSupported() {
    if (!Fp.isOdd)
      throw new Error("compression is not supported: Field does not have .isOdd()");
  }
  function pointToBytes2(_c, point, isCompressed) {
    const { x, y } = point.toAffine();
    const bx = Fp.toBytes(x);
    abool(isCompressed, "isCompressed");
    if (isCompressed) {
      assertCompressionIsSupported();
      const hasEvenY = !Fp.isOdd(y);
      return concatBytes(pprefix(hasEvenY), bx);
    } else {
      return concatBytes(Uint8Array.of(4), bx, Fp.toBytes(y));
    }
  }
  function pointFromBytes(bytes2) {
    abytes(bytes2, void 0, "Point");
    const { publicKey: comp, publicKeyUncompressed: uncomp } = lengths;
    const length = bytes2.length;
    const head = bytes2[0];
    const tail = bytes2.subarray(1);
    if (length === comp && (head === 2 || head === 3)) {
      const x = Fp.fromBytes(tail);
      if (!Fp.isValid(x))
        throw new Error("bad point: is not on curve, wrong x");
      const y2 = weierstrassEquation(x);
      let y;
      try {
        y = Fp.sqrt(y2);
      } catch (sqrtError) {
        const err = sqrtError instanceof Error ? ": " + sqrtError.message : "";
        throw new Error("bad point: is not on curve, sqrt error" + err);
      }
      assertCompressionIsSupported();
      const evenY = Fp.isOdd(y);
      const evenH = (head & 1) === 1;
      if (evenH !== evenY)
        y = Fp.neg(y);
      return { x, y };
    } else if (length === uncomp && head === 4) {
      const L = Fp.BYTES;
      const x = Fp.fromBytes(tail.subarray(0, L));
      const y = Fp.fromBytes(tail.subarray(L, L * 2));
      if (!isValidXY(x, y))
        throw new Error("bad point: is not on curve");
      return { x, y };
    } else {
      throw new Error(`bad point: got length ${length}, expected compressed=${comp} or uncompressed=${uncomp}`);
    }
  }
  const encodePoint = extraOpts.toBytes || pointToBytes2;
  const decodePoint = extraOpts.fromBytes || pointFromBytes;
  function weierstrassEquation(x) {
    const x2 = Fp.sqr(x);
    const x3 = Fp.mul(x2, x);
    return Fp.add(Fp.add(x3, Fp.mul(x, CURVE.a)), CURVE.b);
  }
  function isValidXY(x, y) {
    const left = Fp.sqr(y);
    const right = weierstrassEquation(x);
    return Fp.eql(left, right);
  }
  if (!isValidXY(CURVE.Gx, CURVE.Gy))
    throw new Error("bad curve params: generator point");
  const _4a3 = Fp.mul(Fp.pow(CURVE.a, _3n2), _4n2);
  const _27b2 = Fp.mul(Fp.sqr(CURVE.b), BigInt(27));
  if (Fp.is0(Fp.add(_4a3, _27b2)))
    throw new Error("bad curve params: a or b");
  function acoord(title, n, banZero = false) {
    if (!Fp.isValid(n) || banZero && Fp.is0(n))
      throw new Error(`bad point coordinate ${title}`);
    return n;
  }
  function aprjpoint(other) {
    if (!(other instanceof Point))
      throw new Error("Weierstrass Point expected");
  }
  function splitEndoScalarN(k) {
    if (!endo || !endo.basises)
      throw new Error("no endo");
    return _splitEndoScalar(k, endo.basises, Fn.ORDER);
  }
  const toAffineMemo = memoized((p, iz) => {
    const { X, Y, Z } = p;
    if (Fp.eql(Z, Fp.ONE))
      return { x: X, y: Y };
    const is0 = p.is0();
    if (iz == null)
      iz = is0 ? Fp.ONE : Fp.inv(Z);
    const x = Fp.mul(X, iz);
    const y = Fp.mul(Y, iz);
    const zz = Fp.mul(Z, iz);
    if (is0)
      return { x: Fp.ZERO, y: Fp.ZERO };
    if (!Fp.eql(zz, Fp.ONE))
      throw new Error("invZ was invalid");
    return { x, y };
  });
  const assertValidMemo = memoized((p) => {
    if (p.is0()) {
      if (extraOpts.allowInfinityPoint && !Fp.is0(p.Y))
        return;
      throw new Error("bad point: ZERO");
    }
    const { x, y } = p.toAffine();
    if (!Fp.isValid(x) || !Fp.isValid(y))
      throw new Error("bad point: x or y not field elements");
    if (!isValidXY(x, y))
      throw new Error("bad point: equation left != right");
    if (!p.isTorsionFree())
      throw new Error("bad point: not in prime-order subgroup");
    return true;
  });
  function finishEndo(endoBeta, k1p, k2p, k1neg, k2neg) {
    k2p = new Point(Fp.mul(k2p.X, endoBeta), k2p.Y, k2p.Z);
    k1p = negateCt(k1neg, k1p);
    k2p = negateCt(k2neg, k2p);
    return k1p.add(k2p);
  }
  class Point {
    // base / generator point
    static BASE = new Point(CURVE.Gx, CURVE.Gy, Fp.ONE);
    // zero / infinity / identity point
    static ZERO = new Point(Fp.ZERO, Fp.ONE, Fp.ZERO);
    // 0, 1, 0
    // math field
    static Fp = Fp;
    // scalar field
    static Fn = Fn;
    X;
    Y;
    Z;
    /** Does NOT validate if the point is valid. Use `.assertValidity()`. */
    constructor(X, Y, Z) {
      this.X = acoord("x", X);
      this.Y = acoord("y", Y, true);
      this.Z = acoord("z", Z);
      Object.freeze(this);
    }
    static CURVE() {
      return CURVE;
    }
    /** Does NOT validate if the point is valid. Use `.assertValidity()`. */
    static fromAffine(p) {
      const { x, y } = p || {};
      if (!p || !Fp.isValid(x) || !Fp.isValid(y))
        throw new Error("invalid affine point");
      if (p instanceof Point)
        throw new Error("projective point not allowed");
      if (Fp.is0(x) && Fp.is0(y))
        return Point.ZERO;
      return new Point(x, y, Fp.ONE);
    }
    static fromBytes(bytes2) {
      const P = Point.fromAffine(decodePoint(abytes(bytes2, void 0, "point")));
      P.assertValidity();
      return P;
    }
    static fromHex(hex2) {
      return Point.fromBytes(hexToBytes(hex2));
    }
    get x() {
      return this.toAffine().x;
    }
    get y() {
      return this.toAffine().y;
    }
    /**
     *
     * @param windowSize
     * @param isLazy true will defer table computation until the first multiplication
     * @returns
     */
    precompute(windowSize = 8, isLazy = true) {
      wnaf.createCache(this, windowSize);
      if (!isLazy)
        this.multiply(_3n2);
      return this;
    }
    // TODO: return `this`
    /** A point on curve is valid if it conforms to equation. */
    assertValidity() {
      assertValidMemo(this);
    }
    hasEvenY() {
      const { y } = this.toAffine();
      if (!Fp.isOdd)
        throw new Error("Field doesn't support isOdd");
      return !Fp.isOdd(y);
    }
    /** Compare one point to another. */
    equals(other) {
      aprjpoint(other);
      const { X: X1, Y: Y1, Z: Z1 } = this;
      const { X: X2, Y: Y2, Z: Z2 } = other;
      const U1 = Fp.eql(Fp.mul(X1, Z2), Fp.mul(X2, Z1));
      const U2 = Fp.eql(Fp.mul(Y1, Z2), Fp.mul(Y2, Z1));
      return U1 && U2;
    }
    /** Flips point to one corresponding to (x, -y) in Affine coordinates. */
    negate() {
      return new Point(this.X, Fp.neg(this.Y), this.Z);
    }
    // Renes-Costello-Batina exception-free doubling formula.
    // There is 30% faster Jacobian formula, but it is not complete.
    // https://eprint.iacr.org/2015/1060, algorithm 3
    // Cost: 8M + 3S + 3*a + 2*b3 + 15add.
    double() {
      const { a, b } = CURVE;
      const b3 = Fp.mul(b, _3n2);
      const { X: X1, Y: Y1, Z: Z1 } = this;
      let X3 = Fp.ZERO, Y3 = Fp.ZERO, Z3 = Fp.ZERO;
      let t0 = Fp.mul(X1, X1);
      let t1 = Fp.mul(Y1, Y1);
      let t2 = Fp.mul(Z1, Z1);
      let t3 = Fp.mul(X1, Y1);
      t3 = Fp.add(t3, t3);
      Z3 = Fp.mul(X1, Z1);
      Z3 = Fp.add(Z3, Z3);
      X3 = Fp.mul(a, Z3);
      Y3 = Fp.mul(b3, t2);
      Y3 = Fp.add(X3, Y3);
      X3 = Fp.sub(t1, Y3);
      Y3 = Fp.add(t1, Y3);
      Y3 = Fp.mul(X3, Y3);
      X3 = Fp.mul(t3, X3);
      Z3 = Fp.mul(b3, Z3);
      t2 = Fp.mul(a, t2);
      t3 = Fp.sub(t0, t2);
      t3 = Fp.mul(a, t3);
      t3 = Fp.add(t3, Z3);
      Z3 = Fp.add(t0, t0);
      t0 = Fp.add(Z3, t0);
      t0 = Fp.add(t0, t2);
      t0 = Fp.mul(t0, t3);
      Y3 = Fp.add(Y3, t0);
      t2 = Fp.mul(Y1, Z1);
      t2 = Fp.add(t2, t2);
      t0 = Fp.mul(t2, t3);
      X3 = Fp.sub(X3, t0);
      Z3 = Fp.mul(t2, t1);
      Z3 = Fp.add(Z3, Z3);
      Z3 = Fp.add(Z3, Z3);
      return new Point(X3, Y3, Z3);
    }
    // Renes-Costello-Batina exception-free addition formula.
    // There is 30% faster Jacobian formula, but it is not complete.
    // https://eprint.iacr.org/2015/1060, algorithm 1
    // Cost: 12M + 0S + 3*a + 3*b3 + 23add.
    add(other) {
      aprjpoint(other);
      const { X: X1, Y: Y1, Z: Z1 } = this;
      const { X: X2, Y: Y2, Z: Z2 } = other;
      let X3 = Fp.ZERO, Y3 = Fp.ZERO, Z3 = Fp.ZERO;
      const a = CURVE.a;
      const b3 = Fp.mul(CURVE.b, _3n2);
      let t0 = Fp.mul(X1, X2);
      let t1 = Fp.mul(Y1, Y2);
      let t2 = Fp.mul(Z1, Z2);
      let t3 = Fp.add(X1, Y1);
      let t4 = Fp.add(X2, Y2);
      t3 = Fp.mul(t3, t4);
      t4 = Fp.add(t0, t1);
      t3 = Fp.sub(t3, t4);
      t4 = Fp.add(X1, Z1);
      let t5 = Fp.add(X2, Z2);
      t4 = Fp.mul(t4, t5);
      t5 = Fp.add(t0, t2);
      t4 = Fp.sub(t4, t5);
      t5 = Fp.add(Y1, Z1);
      X3 = Fp.add(Y2, Z2);
      t5 = Fp.mul(t5, X3);
      X3 = Fp.add(t1, t2);
      t5 = Fp.sub(t5, X3);
      Z3 = Fp.mul(a, t4);
      X3 = Fp.mul(b3, t2);
      Z3 = Fp.add(X3, Z3);
      X3 = Fp.sub(t1, Z3);
      Z3 = Fp.add(t1, Z3);
      Y3 = Fp.mul(X3, Z3);
      t1 = Fp.add(t0, t0);
      t1 = Fp.add(t1, t0);
      t2 = Fp.mul(a, t2);
      t4 = Fp.mul(b3, t4);
      t1 = Fp.add(t1, t2);
      t2 = Fp.sub(t0, t2);
      t2 = Fp.mul(a, t2);
      t4 = Fp.add(t4, t2);
      t0 = Fp.mul(t1, t4);
      Y3 = Fp.add(Y3, t0);
      t0 = Fp.mul(t5, t4);
      X3 = Fp.mul(t3, X3);
      X3 = Fp.sub(X3, t0);
      t0 = Fp.mul(t3, t1);
      Z3 = Fp.mul(t5, Z3);
      Z3 = Fp.add(Z3, t0);
      return new Point(X3, Y3, Z3);
    }
    subtract(other) {
      return this.add(other.negate());
    }
    is0() {
      return this.equals(Point.ZERO);
    }
    /**
     * Constant time multiplication.
     * Uses wNAF method. Windowed method may be 10% faster,
     * but takes 2x longer to generate and consumes 2x memory.
     * Uses precomputes when available.
     * Uses endomorphism for Koblitz curves.
     * @param scalar by which the point would be multiplied
     * @returns New point
     */
    multiply(scalar) {
      const { endo: endo2 } = extraOpts;
      if (!Fn.isValidNot0(scalar))
        throw new Error("invalid scalar: out of range");
      let point, fake;
      const mul = (n) => wnaf.cached(this, n, (p) => normalizeZ(Point, p));
      if (endo2) {
        const { k1neg, k1, k2neg, k2 } = splitEndoScalarN(scalar);
        const { p: k1p, f: k1f } = mul(k1);
        const { p: k2p, f: k2f } = mul(k2);
        fake = k1f.add(k2f);
        point = finishEndo(endo2.beta, k1p, k2p, k1neg, k2neg);
      } else {
        const { p, f } = mul(scalar);
        point = p;
        fake = f;
      }
      return normalizeZ(Point, [point, fake])[0];
    }
    /**
     * Non-constant-time multiplication. Uses double-and-add algorithm.
     * It's faster, but should only be used when you don't care about
     * an exposed secret key e.g. sig verification, which works over *public* keys.
     */
    multiplyUnsafe(sc) {
      const { endo: endo2 } = extraOpts;
      const p = this;
      if (!Fn.isValid(sc))
        throw new Error("invalid scalar: out of range");
      if (sc === _0n4 || p.is0())
        return Point.ZERO;
      if (sc === _1n4)
        return p;
      if (wnaf.hasCache(this))
        return this.multiply(sc);
      if (endo2) {
        const { k1neg, k1, k2neg, k2 } = splitEndoScalarN(sc);
        const { p1, p2 } = mulEndoUnsafe(Point, p, k1, k2);
        return finishEndo(endo2.beta, p1, p2, k1neg, k2neg);
      } else {
        return wnaf.unsafe(p, sc);
      }
    }
    /**
     * Converts Projective point to affine (x, y) coordinates.
     * @param invertedZ Z^-1 (inverted zero) - optional, precomputation is useful for invertBatch
     */
    toAffine(invertedZ) {
      return toAffineMemo(this, invertedZ);
    }
    /**
     * Checks whether Point is free of torsion elements (is in prime subgroup).
     * Always torsion-free for cofactor=1 curves.
     */
    isTorsionFree() {
      const { isTorsionFree } = extraOpts;
      if (cofactor === _1n4)
        return true;
      if (isTorsionFree)
        return isTorsionFree(Point, this);
      return wnaf.unsafe(this, CURVE_ORDER).is0();
    }
    clearCofactor() {
      const { clearCofactor } = extraOpts;
      if (cofactor === _1n4)
        return this;
      if (clearCofactor)
        return clearCofactor(Point, this);
      return this.multiplyUnsafe(cofactor);
    }
    isSmallOrder() {
      return this.multiplyUnsafe(cofactor).is0();
    }
    toBytes(isCompressed = true) {
      abool(isCompressed, "isCompressed");
      this.assertValidity();
      return encodePoint(Point, this, isCompressed);
    }
    toHex(isCompressed = true) {
      return bytesToHex(this.toBytes(isCompressed));
    }
    toString() {
      return `<Point ${this.is0() ? "ZERO" : this.toHex()}>`;
    }
  }
  const bits = Fn.BITS;
  const wnaf = new wNAF(Point, extraOpts.endo ? Math.ceil(bits / 2) : bits);
  Point.BASE.precompute(8);
  return Point;
}
function pprefix(hasEvenY) {
  return Uint8Array.of(hasEvenY ? 2 : 3);
}
function getWLengths(Fp, Fn) {
  return {
    secretKey: Fn.BYTES,
    publicKey: 1 + Fp.BYTES,
    publicKeyUncompressed: 1 + 2 * Fp.BYTES,
    publicKeyHasPrefix: true,
    signature: 2 * Fn.BYTES
  };
}

// node_modules/@noble/curves/secp256k1.js
var secp256k1_CURVE = {
  p: BigInt("0xfffffffffffffffffffffffffffffffffffffffffffffffffffffffefffffc2f"),
  n: BigInt("0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141"),
  h: BigInt(1),
  a: BigInt(0),
  b: BigInt(7),
  Gx: BigInt("0x79be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798"),
  Gy: BigInt("0x483ada7726a3c4655da4fbfc0e1108a8fd17b448a68554199c47d08ffb10d4b8")
};
var secp256k1_ENDO = {
  beta: BigInt("0x7ae96a2b657c07106e64479eac3434e99cf0497512f58995c1396c28719501ee"),
  basises: [
    [BigInt("0x3086d221a7d46bcde86c90e49284eb15"), -BigInt("0xe4437ed6010e88286f547fa90abfe4c3")],
    [BigInt("0x114ca50f7a8e2f3f657c1108d9d44cfd8"), BigInt("0x3086d221a7d46bcde86c90e49284eb15")]
  ]
};
var _0n5 = /* @__PURE__ */ BigInt(0);
var _2n3 = /* @__PURE__ */ BigInt(2);
function sqrtMod(y) {
  const P = secp256k1_CURVE.p;
  const _3n3 = BigInt(3), _6n = BigInt(6), _11n = BigInt(11), _22n = BigInt(22);
  const _23n = BigInt(23), _44n = BigInt(44), _88n = BigInt(88);
  const b2 = y * y * y % P;
  const b3 = b2 * b2 * y % P;
  const b6 = pow2(b3, _3n3, P) * b3 % P;
  const b9 = pow2(b6, _3n3, P) * b3 % P;
  const b11 = pow2(b9, _2n3, P) * b2 % P;
  const b22 = pow2(b11, _11n, P) * b11 % P;
  const b44 = pow2(b22, _22n, P) * b22 % P;
  const b88 = pow2(b44, _44n, P) * b44 % P;
  const b176 = pow2(b88, _88n, P) * b88 % P;
  const b220 = pow2(b176, _44n, P) * b44 % P;
  const b223 = pow2(b220, _3n3, P) * b3 % P;
  const t1 = pow2(b223, _23n, P) * b22 % P;
  const t2 = pow2(t1, _6n, P) * b2 % P;
  const root = pow2(t2, _2n3, P);
  if (!Fpk1.eql(Fpk1.sqr(root), y))
    throw new Error("Cannot find square root");
  return root;
}
var Fpk1 = Field2(secp256k1_CURVE.p, { sqrt: sqrtMod });
var Pointk1 = /* @__PURE__ */ weierstrass(secp256k1_CURVE, {
  Fp: Fpk1,
  endo: secp256k1_ENDO
});
var TAGGED_HASH_PREFIXES = {};
function taggedHash(tag, ...messages) {
  let tagP = TAGGED_HASH_PREFIXES[tag];
  if (tagP === void 0) {
    const tagH = sha256(asciiToBytes(tag));
    tagP = concatBytes(tagH, tagH);
    TAGGED_HASH_PREFIXES[tag] = tagP;
  }
  return sha256(concatBytes(tagP, ...messages));
}
var pointToBytes = (point) => point.toBytes(true).slice(1);
var hasEven = (y) => y % _2n3 === _0n5;
function schnorrGetExtPubKey(priv) {
  const { Fn, BASE } = Pointk1;
  const d_ = Fn.fromBytes(priv);
  const p = BASE.multiply(d_);
  const scalar = hasEven(p.y) ? d_ : Fn.neg(d_);
  return { scalar, bytes: pointToBytes(p) };
}
function lift_x(x) {
  const Fp = Fpk1;
  if (!Fp.isValidNot0(x))
    throw new Error("invalid x: Fail if x \u2265 p");
  const xx = Fp.create(x * x);
  const c = Fp.create(xx * x + BigInt(7));
  let y = Fp.sqrt(c);
  if (!hasEven(y))
    y = Fp.neg(y);
  const p = Pointk1.fromAffine({ x, y });
  p.assertValidity();
  return p;
}
var num = bytesToNumberBE;
function challenge(...args) {
  return Pointk1.Fn.create(num(taggedHash("BIP0340/challenge", ...args)));
}
function schnorrGetPublicKey(secretKey) {
  return schnorrGetExtPubKey(secretKey).bytes;
}
function schnorrSign(message, secretKey, auxRand = randomBytes(32)) {
  const { Fn } = Pointk1;
  const m = abytes(message, void 0, "message");
  const { bytes: px, scalar: d } = schnorrGetExtPubKey(secretKey);
  const a = abytes(auxRand, 32, "auxRand");
  const t = Fn.toBytes(d ^ num(taggedHash("BIP0340/aux", a)));
  const rand = taggedHash("BIP0340/nonce", t, px, m);
  const { bytes: rx, scalar: k } = schnorrGetExtPubKey(rand);
  const e = challenge(rx, px, m);
  const sig = new Uint8Array(64);
  sig.set(rx, 0);
  sig.set(Fn.toBytes(Fn.create(k + e * d)), 32);
  if (!schnorrVerify(sig, m, px))
    throw new Error("sign: Invalid signature produced");
  return sig;
}
function schnorrVerify(signature, message, publicKey) {
  const { Fp, Fn, BASE } = Pointk1;
  const sig = abytes(signature, 64, "signature");
  const m = abytes(message, void 0, "message");
  const pub = abytes(publicKey, 32, "publicKey");
  try {
    const P = lift_x(num(pub));
    const r = num(sig.subarray(0, 32));
    if (!Fp.isValidNot0(r))
      return false;
    const s = num(sig.subarray(32, 64));
    if (!Fn.isValidNot0(s))
      return false;
    const e = challenge(Fn.toBytes(r), pointToBytes(P), m);
    const R = BASE.multiplyUnsafe(s).add(P.multiplyUnsafe(Fn.neg(e)));
    const { x, y } = R.toAffine();
    if (R.is0() || !hasEven(y) || x !== r)
      return false;
    return true;
  } catch (error) {
    return false;
  }
}
var schnorr = /* @__PURE__ */ (() => {
  const size = 32;
  const seedLength = 48;
  const randomSecretKey = (seed = randomBytes(seedLength)) => {
    return mapHashToField(seed, secp256k1_CURVE.n);
  };
  return {
    keygen: createKeygen(randomSecretKey, schnorrGetPublicKey),
    getPublicKey: schnorrGetPublicKey,
    sign: schnorrSign,
    verify: schnorrVerify,
    Point: Pointk1,
    utils: {
      randomSecretKey,
      taggedHash,
      lift_x,
      pointToBytes
    },
    lengths: {
      secretKey: size,
      publicKey: size,
      publicKeyHasPrefix: false,
      signature: size * 2,
      seed: seedLength
    }
  };
})();

// node_modules/nostr-tools/lib/esm/pure.js
var utf8Decoder = new TextDecoder("utf-8");
var utf8Encoder = new TextEncoder();
function isHex32(input) {
  if (input.length !== 64)
    return false;
  for (let i2 = 0; i2 < 64; i2++) {
    let cc = input.charCodeAt(i2);
    if (isNaN(cc) || cc < 48 || cc > 102 || cc > 57 && cc < 97) {
      return false;
    }
  }
  return true;
}
var verifiedSymbol = Symbol("verified");
var isRecord = (obj) => obj instanceof Object;
function validateEvent(event) {
  if (!isRecord(event))
    return false;
  if (typeof event.kind !== "number")
    return false;
  if (typeof event.content !== "string")
    return false;
  if (typeof event.created_at !== "number")
    return false;
  if (typeof event.pubkey !== "string")
    return false;
  if (!isHex32(event.pubkey))
    return false;
  if (!Array.isArray(event.tags))
    return false;
  for (let i2 = 0; i2 < event.tags.length; i2++) {
    let tag = event.tags[i2];
    if (!Array.isArray(tag))
      return false;
    for (let j = 0; j < tag.length; j++) {
      if (typeof tag[j] !== "string")
        return false;
    }
  }
  return true;
}
var JS = class {
  generateSecretKey() {
    return schnorr.utils.randomSecretKey();
  }
  getPublicKey(secretKey) {
    return bytesToHex(schnorr.getPublicKey(secretKey));
  }
  finalizeEvent(t, secretKey) {
    const event = t;
    event.pubkey = bytesToHex(schnorr.getPublicKey(secretKey));
    event.id = getEventHash(event);
    event.sig = bytesToHex(schnorr.sign(hexToBytes(getEventHash(event)), secretKey));
    event[verifiedSymbol] = true;
    return event;
  }
  verifyEvent(event) {
    if (typeof event[verifiedSymbol] === "boolean")
      return event[verifiedSymbol];
    try {
      const hash = getEventHash(event);
      if (hash !== event.id) {
        event[verifiedSymbol] = false;
        return false;
      }
      const valid = schnorr.verify(hexToBytes(event.sig), hexToBytes(hash), hexToBytes(event.pubkey));
      event[verifiedSymbol] = valid;
      return valid;
    } catch (err) {
      event[verifiedSymbol] = false;
      return false;
    }
  }
};
function serializeEvent(evt) {
  if (!validateEvent(evt))
    throw new Error("can't serialize event with wrong or missing properties");
  return JSON.stringify([0, evt.pubkey, evt.created_at, evt.kind, evt.tags, evt.content]);
}
function getEventHash(event) {
  let eventHash = sha256(utf8Encoder.encode(serializeEvent(event)));
  return bytesToHex(eventHash);
}
var i = new JS();
var generateSecretKey = i.generateSecretKey;
var getPublicKey = i.getPublicKey;
var finalizeEvent = i.finalizeEvent;
var verifyEvent = i.verifyEvent;

// packages/core/src/api/apps.ts
var APP_NAME = /^[a-z0-9](?:[a-z0-9-]{0,28}[a-z0-9])?$/;
var status = (error) => error.status;
var missing = (error) => status(error) === 404 || ["RESOURCE_DOES_NOT_EXIST", "NOT_FOUND"].includes(String(error.errorCode));
var exists = (error) => status(error) === 409 || /ALREADY_EXISTS/.test(String(error.errorCode ?? ""));
function wait(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason);
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
}
var Apps = class {
  constructor(client) {
    this.client = client;
  }
  /** The app, or undefined when there's none by that name. */
  async get(name, signal) {
    try {
      return await this.client.get(`/api/2.0/apps/${encodeURIComponent(name)}`, { ...signal && { signal } });
    } catch (error) {
      if (missing(error)) return void 0;
      throw error;
    }
  }
  async list(signal) {
    const found = [];
    let token;
    for (let page = 0; page < 20; page++) {
      const reply = await this.client.get("/api/2.0/apps", { query: { page_size: 100, page_token: token }, ...signal && { signal } });
      found.push(...reply.apps ?? []);
      token = reply.next_page_token;
      if (!token) break;
    }
    return found;
  }
  /** Creates an app; with `compute: false` it stays stopped until its first deployment. */
  create(name, options = {}) {
    return this.client.post(
      "/api/2.0/apps",
      { name, ...options.description && { description: options.description }, ...options.resources?.length && { resources: options.resources } },
      { ...options.compute === false && { query: { no_compute: true } }, ...options.signal && { signal: options.signal } }
    );
  }
  deploy(name, sourceCodePath, signal) {
    return this.client.post(`/api/2.0/apps/${encodeURIComponent(name)}/deployments`, { source_code_path: sourceCodePath, mode: "SNAPSHOT" }, { ...signal && { signal } });
  }
  deployment(name, id, signal) {
    return this.client.get(`/api/2.0/apps/${encodeURIComponent(name)}/deployments/${encodeURIComponent(id)}`, { ...signal && { signal } });
  }
  start(name, signal) {
    return this.client.post(`/api/2.0/apps/${encodeURIComponent(name)}/start`, {}, { ...signal && { signal } });
  }
  stop(name, signal) {
    return this.client.post(`/api/2.0/apps/${encodeURIComponent(name)}/stop`, {}, { ...signal && { signal } });
  }
  /** Lets a workspace group use the app (open it, call its API). `users` is everyone in the workspace. */
  allow(name, group, permission = "CAN_USE", signal) {
    return this.client.json(`/api/2.0/permissions/apps/${encodeURIComponent(name)}`, {
      method: "PATCH",
      body: { access_control_list: [{ group_name: group, permission_level: permission }] },
      ...signal && { signal }
    });
  }
  async allowed(name, group, signal) {
    const found = await this.client.get(`/api/2.0/permissions/apps/${encodeURIComponent(name)}`, { ...signal && { signal } });
    return (found.access_control_list ?? []).some((entry) => entry.group_name === group && (entry.all_permissions ?? []).some((p) => p.permission_level === "CAN_USE" || p.permission_level === "CAN_MANAGE"));
  }
  async delete(name, signal) {
    try {
      await this.client.json(`/api/2.0/apps/${encodeURIComponent(name)}`, { method: "DELETE", ...signal && { signal } });
    } catch (error) {
      if (!missing(error)) throw error;
    }
  }
  /** Polls the app until `done` says so, or `timeoutMs` passes. */
  async until(name, done, options) {
    const end = Date.now() + options.timeoutMs;
    for (; ; ) {
      const app = await this.get(name, options.signal);
      if (!app || done(app) || Date.now() > end) return app;
      await wait(options.intervalMs ?? 5e3, options.signal);
    }
  }
};
var UcSecrets = class {
  constructor(client) {
    this.client = client;
  }
  path(fullName) {
    return `/api/2.1/unity-catalog/secrets/${fullName.split(".").map(encodeURIComponent).join(".")}`;
  }
  /** The value, or undefined when there's no such secret. */
  async read(fullName, signal) {
    try {
      const secret = await this.client.get(this.path(fullName), { query: { include_value: true }, ...signal && { signal } });
      return secret.effective_value ?? secret.value ?? "";
    } catch (error) {
      if (missing(error)) return void 0;
      throw error;
    }
  }
  create(fullName, value, comment, signal) {
    const [catalog, schema2, name] = fullName.split(".");
    return this.client.post("/api/2.1/unity-catalog/secrets", { catalog_name: catalog, schema_name: schema2, name, value, comment }, { ...signal && { signal } });
  }
  update(fullName, value, signal) {
    return this.client.json(this.path(fullName), { method: "PATCH", query: { update_mask: "value" }, body: { value }, ...signal && { signal } });
  }
  async delete(fullName, signal) {
    try {
      await this.client.json(this.path(fullName), { method: "DELETE", ...signal && { signal } });
    } catch (error) {
      if (!missing(error)) throw error;
    }
  }
};
function grantPrivileges(client, securable, fullName, principal, privileges, signal) {
  return client.json(`/api/2.1/unity-catalog/permissions/${securable}/${fullName.split(".").map(encodeURIComponent).join(".")}`, {
    method: "PATCH",
    body: { changes: [{ principal, add: privileges }] },
    ...signal && { signal }
  });
}
async function ensureSchema(client, catalog, schema2, comment, signal) {
  try {
    await client.get(`/api/2.1/unity-catalog/schemas/${encodeURIComponent(`${catalog}.${schema2}`)}`, { ...signal && { signal } });
    return;
  } catch (error) {
    if (!missing(error)) throw error;
  }
  try {
    await client.post("/api/2.1/unity-catalog/schemas", { catalog_name: catalog, name: schema2, comment }, { ...signal && { signal } });
  } catch (error) {
    if (!exists(error)) throw error;
  }
}
async function listCatalogs(client, signal) {
  const reply = await client.get("/api/2.1/unity-catalog/catalogs", { ...signal && { signal } });
  return (reply.catalogs ?? []).filter((catalog) => catalog.name !== "system" && catalog.catalog_type !== "SYSTEM_CATALOG").map((catalog) => catalog.name);
}
var base64 = (text) => {
  const bytes2 = new TextEncoder().encode(text);
  let binary = "";
  for (let i2 = 0; i2 < bytes2.length; i2 += 32768) binary += String.fromCharCode(...bytes2.subarray(i2, i2 + 32768));
  return btoa(binary);
};
async function writeWorkspaceFiles(client, folder, files, options = {}) {
  const { signal } = options;
  await client.post("/api/2.0/workspace/mkdirs", { path: folder }, { ...signal && { signal } });
  for (const [name, content] of Object.entries(files)) {
    const path = `${folder}/${name}`;
    if (options.keep?.includes(name)) {
      const found = await client.get("/api/2.0/workspace/get-status", { query: { path }, ...signal && { signal } }).then(
        () => true,
        (error) => missing(error) ? false : Promise.reject(error)
      );
      if (found) continue;
    }
    await client.post("/api/2.0/workspace/import", { path, format: "AUTO", overwrite: true, content: base64(content) }, { ...signal && { signal } });
  }
}
var SEARCH_APP_PREFIX = "Buzz search index";

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
  const status3 = error.status;
  const message = error.message ?? String(error);
  if (status3 === 503 && /data api is not enabled/i.test(message))
    return new Error("The Data API isn't turned on for this Lakebase project. Turn it on in Lakebase \u2192 the project \u2192 Data API.", { cause: error });
  if (status3 === 404 && /PGRST205|could not find the table/i.test(`${message} ${error.body ?? ""}`))
    return new Error(`There's no table or view named ${table} that you can read. Check the name and schema, and that it's in an exposed schema.`, { cause: error });
  if (/permission denied to set role/i.test(detail(error))) return new DataApiRoleError(error);
  if (status3 === 401 || status3 === 403)
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
  /** A project's default branch and its first database, as full resource names (what an app's `postgres` resource takes). */
  async defaultDatabase(projectId, signal) {
    const branches = await this.branches(projectId, signal);
    const branch = branches.find((candidate) => candidate.status?.default) ?? branches.find((candidate) => candidate.name.endsWith("/production")) ?? branches[0];
    if (!branch) return void 0;
    const databases = await this.client.get(`/api/2.0/postgres/${branch.name}/databases`, signal ? { signal } : {});
    const database = (databases.databases ?? []).find((candidate) => candidate.status?.postgres_database === "databricks_postgres") ?? databases.databases?.[0];
    return database ? { branch: branch.name, database: database.name, databaseName: database.status?.postgres_database ?? database.name.split("/").pop() } : void 0;
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
    const [endpoints, databases] = await Promise.all([
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
    return (databases.databases ?? []).flatMap((database) => {
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

// virtual-app:buzz-app
var SDK = '// buzz-app.mjs: Buzz for Databricks Apps (built by databricks-buzz-plugins). Apache-2.0. Usage: plugins/agents/app/sdk.ts in the repo.\nimport{createServer as Wn}from"node:http";function Dt(e){return e instanceof Uint8Array||ArrayBuffer.isView(e)&&e.constructor.name==="Uint8Array"}function tt(e,t=""){if(!Number.isSafeInteger(e)||e<0){let r=t&&`"${t}" `;throw new Error(`${r}expected integer >= 0, got ${e}`)}}function R(e,t,r=""){let n=Dt(e),s=e?.length,o=t!==void 0;if(!n||o&&s!==t){let i=r&&`"${r}" `,c=o?` of length ${t}`:"",a=n?`length=${s}`:`type=${typeof e}`;throw new Error(i+"expected Uint8Array"+c+", got "+a)}return e}function Ct(e,t=!0){if(e.destroyed)throw new Error("Hash instance has been destroyed");if(t&&e.finished)throw new Error("Hash#digest() has already been called")}function ce(e,t){R(e,void 0,"digestInto() output");let r=t.outputLen;if(e.length<r)throw new Error(\'"digestInto() output" expected to be of length >=\'+r)}function lt(...e){for(let t=0;t<e.length;t++)e[t].fill(0)}function mt(e){return new DataView(e.buffer,e.byteOffset,e.byteLength)}function L(e,t){return e<<32-t|e>>>t}var le=typeof Uint8Array.from([]).toHex=="function"&&typeof Uint8Array.fromHex=="function",cn=Array.from({length:256},(e,t)=>t.toString(16).padStart(2,"0"));function U(e){if(R(e),le)return e.toHex();let t="";for(let r=0;r<e.length;r++)t+=cn[e[r]];return t}var Z={_0:48,_9:57,A:65,F:70,a:97,f:102};function ae(e){if(e>=Z._0&&e<=Z._9)return e-Z._0;if(e>=Z.A&&e<=Z.F)return e-(Z.A-10);if(e>=Z.a&&e<=Z.f)return e-(Z.a-10)}function j(e){if(typeof e!="string")throw new Error("hex string expected, got "+typeof e);if(le)return Uint8Array.fromHex(e);let t=e.length,r=t/2;if(t%2)throw new Error("hex string expected, got unpadded hex of length "+t);let n=new Uint8Array(r);for(let s=0,o=0;s<r;s++,o+=2){let i=ae(e.charCodeAt(o)),c=ae(e.charCodeAt(o+1));if(i===void 0||c===void 0){let a=e[o]+e[o+1];throw new Error(\'hex string expected, got non-hex character "\'+a+\'" at index \'+o)}n[s]=i*16+c}return n}function K(...e){let t=0;for(let n=0;n<e.length;n++){let s=e[n];R(s),t+=s.length}let r=new Uint8Array(t);for(let n=0,s=0;n<e.length;n++){let o=e[n];r.set(o,s),s+=o.length}return r}function ue(e,t={}){let r=(s,o)=>e(o).update(s).digest(),n=e(void 0);return r.outputLen=n.outputLen,r.blockLen=n.blockLen,r.create=s=>e(s),Object.assign(r,t),Object.freeze(r)}function ut(e=32){let t=typeof globalThis=="object"?globalThis.crypto:null;if(typeof t?.getRandomValues!="function")throw new Error("crypto.getRandomValues must be defined");return t.getRandomValues(new Uint8Array(e))}var fe=e=>({oid:Uint8Array.from([6,9,96,134,72,1,101,3,4,2,e])});function de(e,t,r){return e&t^~e&r}function he(e,t,r){return e&t^e&r^t&r}var bt=class{blockLen;outputLen;padOffset;isLE;buffer;view;finished=!1;length=0;pos=0;destroyed=!1;constructor(t,r,n,s){this.blockLen=t,this.outputLen=r,this.padOffset=n,this.isLE=s,this.buffer=new Uint8Array(t),this.view=mt(this.buffer)}update(t){Ct(this),R(t);let{view:r,buffer:n,blockLen:s}=this,o=t.length;for(let i=0;i<o;){let c=Math.min(s-this.pos,o-i);if(c===s){let a=mt(t);for(;s<=o-i;i+=s)this.process(a,i);continue}n.set(t.subarray(i,i+c),this.pos),this.pos+=c,i+=c,this.pos===s&&(this.process(r,0),this.pos=0)}return this.length+=t.length,this.roundClean(),this}digestInto(t){Ct(this),ce(t,this),this.finished=!0;let{buffer:r,view:n,blockLen:s,isLE:o}=this,{pos:i}=this;r[i++]=128,lt(this.buffer.subarray(i)),this.padOffset>s-i&&(this.process(n,0),i=0);for(let f=i;f<s;f++)r[f]=0;n.setBigUint64(s-8,BigInt(this.length*8),o),this.process(n,0);let c=mt(t),a=this.outputLen;if(a%4)throw new Error("_sha2: outputLen must be aligned to 32bit");let l=a/4,d=this.get();if(l>d.length)throw new Error("_sha2: outputLen bigger than state");for(let f=0;f<l;f++)c.setUint32(4*f,d[f],o)}digest(){let{buffer:t,outputLen:r}=this;this.digestInto(t);let n=t.slice(0,r);return this.destroy(),n}_cloneInto(t){t||=new this.constructor,t.set(...this.get());let{blockLen:r,buffer:n,length:s,finished:o,destroyed:i,pos:c}=this;return t.destroyed=i,t.finished=o,t.length=s,t.pos=c,s%r&&t.buffer.set(n),t}clone(){return this._cloneInto()}},V=Uint32Array.from([1779033703,3144134277,1013904242,2773480762,1359893119,2600822924,528734635,1541459225]);var ln=Uint32Array.from([1116352408,1899447441,3049323471,3921009573,961987163,1508970993,2453635748,2870763221,3624381080,310598401,607225278,1426881987,1925078388,2162078206,2614888103,3248222580,3835390401,4022224774,264347078,604807628,770255983,1249150122,1555081692,1996064986,2554220882,2821834349,2952996808,3210313671,3336571891,3584528711,113926993,338241895,666307205,773529912,1294757372,1396182291,1695183700,1986661051,2177026350,2456956037,2730485921,2820302411,3259730800,3345764771,3516065817,3600352804,4094571909,275423344,430227734,506948616,659060556,883997877,958139571,1322822218,1537002063,1747873779,1955562222,2024104815,2227730452,2361852424,2428436474,2756734187,3204031479,3329325298]),G=new Uint32Array(64),Ht=class extends bt{constructor(t){super(64,t,8,!1)}get(){let{A:t,B:r,C:n,D:s,E:o,F:i,G:c,H:a}=this;return[t,r,n,s,o,i,c,a]}set(t,r,n,s,o,i,c,a){this.A=t|0,this.B=r|0,this.C=n|0,this.D=s|0,this.E=o|0,this.F=i|0,this.G=c|0,this.H=a|0}process(t,r){for(let f=0;f<16;f++,r+=4)G[f]=t.getUint32(r,!1);for(let f=16;f<64;f++){let p=G[f-15],y=G[f-2],k=L(p,7)^L(p,18)^p>>>3,T=L(y,17)^L(y,19)^y>>>10;G[f]=T+G[f-7]+k+G[f-16]|0}let{A:n,B:s,C:o,D:i,E:c,F:a,G:l,H:d}=this;for(let f=0;f<64;f++){let p=L(c,6)^L(c,11)^L(c,25),y=d+p+de(c,a,l)+ln[f]+G[f]|0,T=(L(n,2)^L(n,13)^L(n,22))+he(n,s,o)|0;d=l,l=a,a=c,c=i+y|0,i=o,o=s,s=n,n=y+T|0}n=n+this.A|0,s=s+this.B|0,o=o+this.C|0,i=i+this.D|0,c=c+this.E|0,a=a+this.F|0,l=l+this.G|0,d=d+this.H|0,this.set(n,s,o,i,c,a,l,d)}roundClean(){lt(G)}destroy(){this.set(0,0,0,0,0,0,0,0),lt(this.buffer)}},$t=class extends Ht{A=V[0]|0;B=V[1]|0;C=V[2]|0;D=V[3]|0;E=V[4]|0;F=V[5]|0;G=V[6]|0;H=V[7]|0;constructor(){super(32)}};var W=ue(()=>new $t,fe(1));var qt=BigInt(0),zt=BigInt(1);function Lt(e,t=""){if(typeof e!="boolean"){let r=t&&`"${t}" `;throw new Error(r+"expected boolean, got type="+typeof e)}return e}function un(e){if(typeof e=="bigint"){if(!dn(e))throw new Error("positive bigint expected, got "+e)}else tt(e);return e}function pe(e){if(typeof e!="string")throw new Error("hex string expected, got "+typeof e);return e===""?qt:BigInt("0x"+e)}function et(e){return pe(U(e))}function Ut(e){return pe(U(fn(R(e)).reverse()))}function xt(e,t){tt(t),e=un(e);let r=j(e.toString(16).padStart(t*2,"0"));if(r.length!==t)throw new Error("number too large");return r}function Pt(e,t){return xt(e,t).reverse()}function fn(e){return Uint8Array.from(e)}function ge(e){return Uint8Array.from(e,(t,r)=>{let n=t.charCodeAt(0);if(t.length!==1||n>127)throw new Error(`string contains non-ASCII character "${e[r]}" with code ${n} at position ${r}`);return n})}var dn=e=>typeof e=="bigint"&&qt<=e;function Mt(e){let t;for(t=0;e>qt;e>>=zt,t+=1);return t}var wt=e=>(zt<<BigInt(e))-zt;function Et(e,t={},r={}){if(!e||typeof e!="object")throw new Error("expected valid options object");function n(o,i,c){let a=e[o];if(c&&a===void 0)return;let l=typeof a;if(l!==i||a===null)throw new Error(`param "${o}" is invalid: expected ${i}, got ${l}`)}let s=(o,i)=>Object.entries(o).forEach(([c,a])=>n(c,a,i));s(t,!1),s(r,!0)}function jt(e){let t=new WeakMap;return(r,...n)=>{let s=t.get(r);if(s!==void 0)return s;let o=e(r,...n);return t.set(r,o),o}}var D=BigInt(0),N=BigInt(1),X=BigInt(2),be=BigInt(3),xe=BigInt(4),we=BigInt(5),hn=BigInt(7),Ee=BigInt(8),pn=BigInt(9),ve=BigInt(16);function P(e,t){let r=e%t;return r>=D?r:t+r}function C(e,t,r){let n=e;for(;t-- >D;)n*=n,n%=r;return n}function ye(e,t){if(e===D)throw new Error("invert: expected non-zero number");if(t<=D)throw new Error("invert: expected positive modulus, got "+t);let r=P(e,t),n=t,s=D,o=N,i=N,c=D;for(;r!==D;){let l=n/r,d=n%r,f=s-i*l,p=o-c*l;n=r,r=d,s=i,o=c,i=f,c=p}if(n!==N)throw new Error("invert: does not exist");return P(s,t)}function Vt(e,t,r){if(!e.eql(e.sqr(t),r))throw new Error("Cannot find square root")}function Se(e,t){let r=(e.ORDER+N)/xe,n=e.pow(t,r);return Vt(e,n,t),n}function gn(e,t){let r=(e.ORDER-we)/Ee,n=e.mul(t,X),s=e.pow(n,r),o=e.mul(t,s),i=e.mul(e.mul(o,X),s),c=e.mul(o,e.sub(i,e.ONE));return Vt(e,c,t),c}function yn(e){let t=nt(e),r=Ae(e),n=r(t,t.neg(t.ONE)),s=r(t,n),o=r(t,t.neg(n)),i=(e+hn)/ve;return(c,a)=>{let l=c.pow(a,i),d=c.mul(l,n),f=c.mul(l,s),p=c.mul(l,o),y=c.eql(c.sqr(d),a),k=c.eql(c.sqr(f),a);l=c.cmov(l,d,y),d=c.cmov(p,f,k);let T=c.eql(c.sqr(d),a),$=c.cmov(l,d,T);return Vt(c,$,a),$}}function Ae(e){if(e<be)throw new Error("sqrt is not defined for small field");let t=e-N,r=0;for(;t%X===D;)t/=X,r++;let n=X,s=nt(e);for(;me(s,n)===1;)if(n++>1e3)throw new Error("Cannot find square root: probably non-prime P");if(r===1)return Se;let o=s.pow(n,t),i=(t+N)/X;return function(a,l){if(a.is0(l))return l;if(me(a,l)!==1)throw new Error("Cannot find square root");let d=r,f=a.mul(a.ONE,o),p=a.pow(l,t),y=a.pow(l,i);for(;!a.eql(p,a.ONE);){if(a.is0(p))return a.ZERO;let k=1,T=a.sqr(p);for(;!a.eql(T,a.ONE);)if(k++,T=a.sqr(T),k===d)throw new Error("Cannot find square root");let $=N<<BigInt(d-k-1),Q=a.pow(f,$);d=k,f=a.sqr(Q),p=a.mul(p,f),y=a.mul(y,Q)}return y}}function mn(e){return e%xe===be?Se:e%Ee===we?gn:e%ve===pn?yn(e):Ae(e)}var bn=["create","isValid","is0","neg","inv","sqrt","sqr","eql","add","sub","mul","pow","div","addN","subN","mulN","sqrN"];function Be(e){let t={ORDER:"bigint",BYTES:"number",BITS:"number"},r=bn.reduce((n,s)=>(n[s]="function",n),t);return Et(e,r),e}function xn(e,t,r){if(r<D)throw new Error("invalid exponent, negatives unsupported");if(r===D)return e.ONE;if(r===N)return t;let n=e.ONE,s=t;for(;r>D;)r&N&&(n=e.mul(n,s)),s=e.sqr(s),r>>=N;return n}function Kt(e,t,r=!1){let n=new Array(t.length).fill(r?e.ZERO:void 0),s=t.reduce((i,c,a)=>e.is0(c)?i:(n[a]=i,e.mul(i,c)),e.ONE),o=e.inv(s);return t.reduceRight((i,c,a)=>e.is0(c)?i:(n[a]=e.mul(i,n[a]),e.mul(i,c)),o),n}function me(e,t){let r=(e.ORDER-N)/X,n=e.pow(t,r),s=e.eql(n,e.ONE),o=e.eql(n,e.ZERO),i=e.eql(n,e.neg(e.ONE));if(!s&&!o&&!i)throw new Error("invalid Legendre symbol result");return s?1:o?0:-1}function wn(e,t){t!==void 0&&tt(t);let r=t!==void 0?t:e.toString(2).length,n=Math.ceil(r/8);return{nBitLength:r,nByteLength:n}}var Zt=class{ORDER;BITS;BYTES;isLE;ZERO=D;ONE=N;_lengths;_sqrt;_mod;constructor(t,r={}){if(t<=D)throw new Error("invalid field: expected ORDER > 0, got "+t);let n;this.isLE=!1,r!=null&&typeof r=="object"&&(typeof r.BITS=="number"&&(n=r.BITS),typeof r.sqrt=="function"&&(this.sqrt=r.sqrt),typeof r.isLE=="boolean"&&(this.isLE=r.isLE),r.allowedLengths&&(this._lengths=r.allowedLengths?.slice()),typeof r.modFromBytes=="boolean"&&(this._mod=r.modFromBytes));let{nBitLength:s,nByteLength:o}=wn(t,n);if(o>2048)throw new Error("invalid field: expected ORDER of <= 2048 bytes");this.ORDER=t,this.BITS=s,this.BYTES=o,this._sqrt=void 0,Object.preventExtensions(this)}create(t){return P(t,this.ORDER)}isValid(t){if(typeof t!="bigint")throw new Error("invalid field element: expected bigint, got "+typeof t);return D<=t&&t<this.ORDER}is0(t){return t===D}isValidNot0(t){return!this.is0(t)&&this.isValid(t)}isOdd(t){return(t&N)===N}neg(t){return P(-t,this.ORDER)}eql(t,r){return t===r}sqr(t){return P(t*t,this.ORDER)}add(t,r){return P(t+r,this.ORDER)}sub(t,r){return P(t-r,this.ORDER)}mul(t,r){return P(t*r,this.ORDER)}pow(t,r){return xn(this,t,r)}div(t,r){return P(t*ye(r,this.ORDER),this.ORDER)}sqrN(t){return t*t}addN(t,r){return t+r}subN(t,r){return t-r}mulN(t,r){return t*r}inv(t){return ye(t,this.ORDER)}sqrt(t){return this._sqrt||(this._sqrt=mn(this.ORDER)),this._sqrt(this,t)}toBytes(t){return this.isLE?Pt(t,this.BYTES):xt(t,this.BYTES)}fromBytes(t,r=!1){R(t);let{_lengths:n,BYTES:s,isLE:o,ORDER:i,_mod:c}=this;if(n){if(!n.includes(t.length)||t.length>s)throw new Error("Field.fromBytes: expected "+n+" bytes, got "+t.length);let l=new Uint8Array(s);l.set(t,o?0:l.length-t.length),t=l}if(t.length!==s)throw new Error("Field.fromBytes: expected "+s+" bytes, got "+t.length);let a=o?Ut(t):et(t);if(c&&(a=P(a,i)),!r&&!this.isValid(a))throw new Error("invalid field element: outside of range 0..ORDER");return a}invertBatch(t){return Kt(this,t)}cmov(t,r,n){return n?r:t}};function nt(e,t={}){return new Zt(e,t)}function _e(e){if(typeof e!="bigint")throw new Error("field order must be bigint");let t=e.toString(2).length;return Math.ceil(t/8)}function En(e){let t=_e(e);return t+Math.ceil(t/2)}function ke(e,t,r=!1){R(e);let n=e.length,s=_e(t),o=En(t);if(n<16||n<o||n>1024)throw new Error("expected "+o+"-1024 bytes of input, got "+n);let i=r?Ut(e):et(e),c=P(i,t-N)+N;return r?Pt(c,s):xt(c,s)}var rt=BigInt(0),J=BigInt(1);function ft(e,t){let r=t.negate();return e?r:t}function Xt(e,t){let r=Kt(e.Fp,t.map(n=>n.Z));return t.map((n,s)=>e.fromAffine(n.toAffine(r[s])))}function Ne(e,t){if(!Number.isSafeInteger(e)||e<=0||e>t)throw new Error("invalid window size, expected [1.."+t+"], got W="+e)}function Gt(e,t){Ne(e,t);let r=Math.ceil(t/e)+1,n=2**(e-1),s=2**e,o=wt(e),i=BigInt(e);return{windows:r,windowSize:n,mask:o,maxNumber:s,shiftBy:i}}function Re(e,t,r){let{windowSize:n,mask:s,maxNumber:o,shiftBy:i}=r,c=Number(e&s),a=e>>i;c>n&&(c-=o,a+=J);let l=t*n,d=l+Math.abs(c)-1,f=c===0,p=c<0,y=t%2!==0;return{nextN:a,offset:d,isZero:f,isNeg:p,isNegF:y,offsetF:l}}var Yt=new WeakMap,Oe=new WeakMap;function Wt(e){return Oe.get(e)||1}function Te(e){if(e!==rt)throw new Error("invalid wNAF")}var vt=class{BASE;ZERO;Fn;bits;constructor(t,r){this.BASE=t.BASE,this.ZERO=t.ZERO,this.Fn=t.Fn,this.bits=r}_unsafeLadder(t,r,n=this.ZERO){let s=t;for(;r>rt;)r&J&&(n=n.add(s)),s=s.double(),r>>=J;return n}precomputeWindow(t,r){let{windows:n,windowSize:s}=Gt(r,this.bits),o=[],i=t,c=i;for(let a=0;a<n;a++){c=i,o.push(c);for(let l=1;l<s;l++)c=c.add(i),o.push(c);i=c.double()}return o}wNAF(t,r,n){if(!this.Fn.isValid(n))throw new Error("invalid scalar");let s=this.ZERO,o=this.BASE,i=Gt(t,this.bits);for(let c=0;c<i.windows;c++){let{nextN:a,offset:l,isZero:d,isNeg:f,isNegF:p,offsetF:y}=Re(n,c,i);n=a,d?o=o.add(ft(p,r[y])):s=s.add(ft(f,r[l]))}return Te(n),{p:s,f:o}}wNAFUnsafe(t,r,n,s=this.ZERO){let o=Gt(t,this.bits);for(let i=0;i<o.windows&&n!==rt;i++){let{nextN:c,offset:a,isZero:l,isNeg:d}=Re(n,i,o);if(n=c,!l){let f=r[a];s=s.add(d?f.negate():f)}}return Te(n),s}getPrecomputes(t,r,n){let s=Yt.get(r);return s||(s=this.precomputeWindow(r,t),t!==1&&(typeof n=="function"&&(s=n(s)),Yt.set(r,s))),s}cached(t,r,n){let s=Wt(t);return this.wNAF(s,this.getPrecomputes(s,t,n),r)}unsafe(t,r,n,s){let o=Wt(t);return o===1?this._unsafeLadder(t,r,s):this.wNAFUnsafe(o,this.getPrecomputes(o,t,n),r,s)}createCache(t,r){Ne(r,this.bits),Oe.set(t,r),Yt.delete(t)}hasCache(t){return Wt(t)!==1}};function De(e,t,r,n){let s=t,o=e.ZERO,i=e.ZERO;for(;r>rt||n>rt;)r&J&&(o=o.add(s)),n&J&&(i=i.add(s)),s=s.double(),r>>=J,n>>=J;return{p1:o,p2:i}}function Ie(e,t,r){if(t){if(t.ORDER!==e)throw new Error("Field.ORDER must match order: Fp == p, Fn == n");return Be(t),t}else return nt(e,{isLE:r})}function Ce(e,t,r={},n){if(n===void 0&&(n=e==="edwards"),!t||typeof t!="object")throw new Error(`expected valid ${e} CURVE object`);for(let a of["p","n","h"]){let l=t[a];if(!(typeof l=="bigint"&&l>rt))throw new Error(`CURVE.${a} must be positive bigint`)}let s=Ie(t.p,r.Fp,n),o=Ie(t.n,r.Fn,n),c=["Gx","Gy","a",e==="weierstrass"?"b":"d"];for(let a of c)if(!s.isValid(t[a]))throw new Error(`CURVE.${a} must be valid field element of CURVE.Fp`);return t=Object.freeze(Object.assign({},t)),{CURVE:t,Fp:s,Fn:o}}function Jt(e,t){return function(n){let s=e(n);return{secretKey:s,publicKey:t(s)}}}var He=(e,t)=>(e+(e>=0?t:-t)/Sn)/t;function vn(e,t,r){let[[n,s],[o,i]]=t,c=He(i*e,r),a=He(-s*e,r),l=e-c*n-a*o,d=-c*s-a*i,f=l<dt,p=d<dt;f&&(l=-l),p&&(d=-d);let y=wt(Math.ceil(Mt(r)/2))+At;if(l<dt||l>=y||d<dt||d>=y)throw new Error("splitScalar (endomorphism): failed, k="+e);return{k1neg:f,k1:l,k2neg:p,k2:d}}var dt=BigInt(0),At=BigInt(1),Sn=BigInt(2),St=BigInt(3),An=BigInt(4);function $e(e,t={}){let r=Ce("weierstrass",e,t),{Fp:n,Fn:s}=r,o=r.CURVE,{h:i,n:c}=o;Et(t,{},{allowInfinityPoint:"boolean",clearCofactor:"function",isTorsionFree:"function",fromBytes:"function",toBytes:"function",endo:"object"});let{endo:a}=t;if(a&&(!n.is0(o.a)||typeof a.beta!="bigint"||!Array.isArray(a.basises)))throw new Error(\'invalid endo: expected "beta": bigint and "basises": array\');let l=_n(n,s);function d(){if(!n.isOdd)throw new Error("compression is not supported: Field does not have .isOdd()")}function f(S,u,h){let{x:m,y:b}=u.toAffine(),A=n.toBytes(m);if(Lt(h,"isCompressed"),h){d();let E=!n.isOdd(b);return K(Bn(E),A)}else return K(Uint8Array.of(4),A,n.toBytes(b))}function p(S){R(S,void 0,"Point");let{publicKey:u,publicKeyUncompressed:h}=l,m=S.length,b=S[0],A=S.subarray(1);if(m===u&&(b===2||b===3)){let E=n.fromBytes(A);if(!n.isValid(E))throw new Error("bad point: is not on curve, wrong x");let x=T(E),g;try{g=n.sqrt(x)}catch(H){let I=H instanceof Error?": "+H.message:"";throw new Error("bad point: is not on curve, sqrt error"+I)}d();let w=n.isOdd(g);return(b&1)===1!==w&&(g=n.neg(g)),{x:E,y:g}}else if(m===h&&b===4){let E=n.BYTES,x=n.fromBytes(A.subarray(0,E)),g=n.fromBytes(A.subarray(E,E*2));if(!$(x,g))throw new Error("bad point: is not on curve");return{x,y:g}}else throw new Error(`bad point: got length ${m}, expected compressed=${u} or uncompressed=${h}`)}let y=t.toBytes||f,k=t.fromBytes||p;function T(S){let u=n.sqr(S),h=n.mul(u,S);return n.add(n.add(h,n.mul(S,o.a)),o.b)}function $(S,u){let h=n.sqr(u),m=T(S);return n.eql(h,m)}if(!$(o.Gx,o.Gy))throw new Error("bad curve params: generator point");let Q=n.mul(n.pow(o.a,St),An),Ot=n.mul(n.sqr(o.b),BigInt(27));if(n.is0(n.add(Q,Ot)))throw new Error("bad curve params: a or b");function at(S,u,h=!1){if(!n.isValid(u)||h&&n.is0(u))throw new Error(`bad point coordinate ${S}`);return u}function pt(S){if(!(S instanceof _))throw new Error("Weierstrass Point expected")}function gt(S){if(!a||!a.basises)throw new Error("no endo");return vn(S,a.basises,s.ORDER)}let yt=jt((S,u)=>{let{X:h,Y:m,Z:b}=S;if(n.eql(b,n.ONE))return{x:h,y:m};let A=S.is0();u==null&&(u=A?n.ONE:n.inv(b));let E=n.mul(h,u),x=n.mul(m,u),g=n.mul(b,u);if(A)return{x:n.ZERO,y:n.ZERO};if(!n.eql(g,n.ONE))throw new Error("invZ was invalid");return{x:E,y:x}}),an=jt(S=>{if(S.is0()){if(t.allowInfinityPoint&&!n.is0(S.Y))return;throw new Error("bad point: ZERO")}let{x:u,y:h}=S.toAffine();if(!n.isValid(u)||!n.isValid(h))throw new Error("bad point: x or y not field elements");if(!$(u,h))throw new Error("bad point: equation left != right");if(!S.isTorsionFree())throw new Error("bad point: not in prime-order subgroup");return!0});function oe(S,u,h,m,b){return h=new _(n.mul(h.X,S),h.Y,h.Z),u=ft(m,u),h=ft(b,h),u.add(h)}class _{static BASE=new _(o.Gx,o.Gy,n.ONE);static ZERO=new _(n.ZERO,n.ONE,n.ZERO);static Fp=n;static Fn=s;X;Y;Z;constructor(u,h,m){this.X=at("x",u),this.Y=at("y",h,!0),this.Z=at("z",m),Object.freeze(this)}static CURVE(){return o}static fromAffine(u){let{x:h,y:m}=u||{};if(!u||!n.isValid(h)||!n.isValid(m))throw new Error("invalid affine point");if(u instanceof _)throw new Error("projective point not allowed");return n.is0(h)&&n.is0(m)?_.ZERO:new _(h,m,n.ONE)}static fromBytes(u){let h=_.fromAffine(k(R(u,void 0,"point")));return h.assertValidity(),h}static fromHex(u){return _.fromBytes(j(u))}get x(){return this.toAffine().x}get y(){return this.toAffine().y}precompute(u=8,h=!0){return ct.createCache(this,u),h||this.multiply(St),this}assertValidity(){an(this)}hasEvenY(){let{y:u}=this.toAffine();if(!n.isOdd)throw new Error("Field doesn\'t support isOdd");return!n.isOdd(u)}equals(u){pt(u);let{X:h,Y:m,Z:b}=this,{X:A,Y:E,Z:x}=u,g=n.eql(n.mul(h,x),n.mul(A,b)),w=n.eql(n.mul(m,x),n.mul(E,b));return g&&w}negate(){return new _(this.X,n.neg(this.Y),this.Z)}double(){let{a:u,b:h}=o,m=n.mul(h,St),{X:b,Y:A,Z:E}=this,x=n.ZERO,g=n.ZERO,w=n.ZERO,v=n.mul(b,b),H=n.mul(A,A),I=n.mul(E,E),B=n.mul(b,A);return B=n.add(B,B),w=n.mul(b,E),w=n.add(w,w),x=n.mul(u,w),g=n.mul(m,I),g=n.add(x,g),x=n.sub(H,g),g=n.add(H,g),g=n.mul(x,g),x=n.mul(B,x),w=n.mul(m,w),I=n.mul(u,I),B=n.sub(v,I),B=n.mul(u,B),B=n.add(B,w),w=n.add(v,v),v=n.add(w,v),v=n.add(v,I),v=n.mul(v,B),g=n.add(g,v),I=n.mul(A,E),I=n.add(I,I),v=n.mul(I,B),x=n.sub(x,v),w=n.mul(I,H),w=n.add(w,w),w=n.add(w,w),new _(x,g,w)}add(u){pt(u);let{X:h,Y:m,Z:b}=this,{X:A,Y:E,Z:x}=u,g=n.ZERO,w=n.ZERO,v=n.ZERO,H=o.a,I=n.mul(o.b,St),B=n.mul(h,A),z=n.mul(m,E),q=n.mul(b,x),F=n.add(h,m),O=n.add(A,E);F=n.mul(F,O),O=n.add(B,z),F=n.sub(F,O),O=n.add(h,b);let M=n.add(A,x);return O=n.mul(O,M),M=n.add(B,q),O=n.sub(O,M),M=n.add(m,b),g=n.add(E,x),M=n.mul(M,g),g=n.add(z,q),M=n.sub(M,g),v=n.mul(H,O),g=n.mul(I,q),v=n.add(g,v),g=n.sub(z,v),v=n.add(z,v),w=n.mul(g,v),z=n.add(B,B),z=n.add(z,B),q=n.mul(H,q),O=n.mul(I,O),z=n.add(z,q),q=n.sub(B,q),q=n.mul(H,q),O=n.add(O,q),B=n.mul(z,O),w=n.add(w,B),B=n.mul(M,O),g=n.mul(F,g),g=n.sub(g,B),B=n.mul(F,z),v=n.mul(M,v),v=n.add(v,B),new _(g,w,v)}subtract(u){return this.add(u.negate())}is0(){return this.equals(_.ZERO)}multiply(u){let{endo:h}=t;if(!s.isValidNot0(u))throw new Error("invalid scalar: out of range");let m,b,A=E=>ct.cached(this,E,x=>Xt(_,x));if(h){let{k1neg:E,k1:x,k2neg:g,k2:w}=gt(u),{p:v,f:H}=A(x),{p:I,f:B}=A(w);b=H.add(B),m=oe(h.beta,v,I,E,g)}else{let{p:E,f:x}=A(u);m=E,b=x}return Xt(_,[m,b])[0]}multiplyUnsafe(u){let{endo:h}=t,m=this;if(!s.isValid(u))throw new Error("invalid scalar: out of range");if(u===dt||m.is0())return _.ZERO;if(u===At)return m;if(ct.hasCache(this))return this.multiply(u);if(h){let{k1neg:b,k1:A,k2neg:E,k2:x}=gt(u),{p1:g,p2:w}=De(_,m,A,x);return oe(h.beta,g,w,b,E)}else return ct.unsafe(m,u)}toAffine(u){return yt(this,u)}isTorsionFree(){let{isTorsionFree:u}=t;return i===At?!0:u?u(_,this):ct.unsafe(this,c).is0()}clearCofactor(){let{clearCofactor:u}=t;return i===At?this:u?u(_,this):this.multiplyUnsafe(i)}isSmallOrder(){return this.multiplyUnsafe(i).is0()}toBytes(u=!0){return Lt(u,"isCompressed"),this.assertValidity(),y(_,this,u)}toHex(u=!0){return U(this.toBytes(u))}toString(){return`<Point ${this.is0()?"ZERO":this.toHex()}>`}}let ie=s.BITS,ct=new vt(_,t.endo?Math.ceil(ie/2):ie);return _.BASE.precompute(8),_}function Bn(e){return Uint8Array.of(e?2:3)}function _n(e,t){return{secretKey:t.BYTES,publicKey:1+e.BYTES,publicKeyUncompressed:1+2*e.BYTES,publicKeyHasPrefix:!0,signature:2*t.BYTES}}var kt={p:BigInt("0xfffffffffffffffffffffffffffffffffffffffffffffffffffffffefffffc2f"),n:BigInt("0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141"),h:BigInt(1),a:BigInt(0),b:BigInt(7),Gx:BigInt("0x79be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798"),Gy:BigInt("0x483ada7726a3c4655da4fbfc0e1108a8fd17b448a68554199c47d08ffb10d4b8")},kn={beta:BigInt("0x7ae96a2b657c07106e64479eac3434e99cf0497512f58995c1396c28719501ee"),basises:[[BigInt("0x3086d221a7d46bcde86c90e49284eb15"),-BigInt("0xe4437ed6010e88286f547fa90abfe4c3")],[BigInt("0x114ca50f7a8e2f3f657c1108d9d44cfd8"),BigInt("0x3086d221a7d46bcde86c90e49284eb15")]]},Rn=BigInt(0),Qt=BigInt(2);function Tn(e){let t=kt.p,r=BigInt(3),n=BigInt(6),s=BigInt(11),o=BigInt(22),i=BigInt(23),c=BigInt(44),a=BigInt(88),l=e*e*e%t,d=l*l*e%t,f=C(d,r,t)*d%t,p=C(f,r,t)*d%t,y=C(p,Qt,t)*l%t,k=C(y,s,t)*y%t,T=C(k,o,t)*k%t,$=C(T,c,t)*T%t,Q=C($,a,t)*$%t,Ot=C(Q,c,t)*T%t,at=C(Ot,r,t)*d%t,pt=C(at,i,t)*k%t,gt=C(pt,n,t)*l%t,yt=C(gt,Qt,t);if(!Bt.eql(Bt.sqr(yt),e))throw new Error("Cannot find square root");return yt}var Bt=nt(kt.p,{sqrt:Tn}),st=$e(kt,{Fp:Bt,endo:kn});var ze={};function _t(e,...t){let r=ze[e];if(r===void 0){let n=W(ge(e));r=K(n,n),ze[e]=r}return W(K(r,...t))}var te=e=>e.toBytes(!0).slice(1),ee=e=>e%Qt===Rn;function Ft(e){let{Fn:t,BASE:r}=st,n=t.fromBytes(e),s=r.multiply(n);return{scalar:ee(s.y)?n:t.neg(n),bytes:te(s)}}function Le(e){let t=Bt;if(!t.isValidNot0(e))throw new Error("invalid x: Fail if x \\u2265 p");let r=t.create(e*e),n=t.create(r*e+BigInt(7)),s=t.sqrt(n);ee(s)||(s=t.neg(s));let o=st.fromAffine({x:e,y:s});return o.assertValidity(),o}var ht=et;function Ue(...e){return st.Fn.create(ht(_t("BIP0340/challenge",...e)))}function qe(e){return Ft(e).bytes}function In(e,t,r=ut(32)){let{Fn:n}=st,s=R(e,void 0,"message"),{bytes:o,scalar:i}=Ft(t),c=R(r,32,"auxRand"),a=n.toBytes(i^ht(_t("BIP0340/aux",c))),l=_t("BIP0340/nonce",a,o,s),{bytes:d,scalar:f}=Ft(l),p=Ue(d,o,s),y=new Uint8Array(64);if(y.set(d,0),y.set(n.toBytes(n.create(f+p*i)),32),!Pe(y,s,o))throw new Error("sign: Invalid signature produced");return y}function Pe(e,t,r){let{Fp:n,Fn:s,BASE:o}=st,i=R(e,64,"signature"),c=R(t,void 0,"message"),a=R(r,32,"publicKey");try{let l=Le(ht(a)),d=ht(i.subarray(0,32));if(!n.isValidNot0(d))return!1;let f=ht(i.subarray(32,64));if(!s.isValidNot0(f))return!1;let p=Ue(s.toBytes(d),te(l),c),y=o.multiplyUnsafe(f).add(l.multiplyUnsafe(s.neg(p))),{x:k,y:T}=y.toAffine();return!(y.is0()||!ee(T)||k!==d)}catch{return!1}}var Y=(()=>{let r=(n=ut(48))=>ke(n,kt.n);return{keygen:Jt(r,qe),getPublicKey:qe,sign:In,verify:Pe,Point:st,utils:{randomSecretKey:r,taggedHash:_t,lift_x:Le,pointToBytes:te},lengths:{secretKey:32,publicKey:32,publicKeyHasPrefix:!1,signature:64,seed:48}}})();var Cr=new TextDecoder("utf-8"),Nn=new TextEncoder;function On(e){if(e.length!==64)return!1;for(let t=0;t<64;t++){let r=e.charCodeAt(t);if(isNaN(r)||r<48||r>102||r>57&&r<97)return!1}return!0}var ot=Symbol("verified"),Dn=e=>e instanceof Object;function Cn(e){if(!Dn(e)||typeof e.kind!="number"||typeof e.content!="string"||typeof e.created_at!="number"||typeof e.pubkey!="string"||!On(e.pubkey)||!Array.isArray(e.tags))return!1;for(let t=0;t<e.tags.length;t++){let r=e.tags[t];if(!Array.isArray(r))return!1;for(let n=0;n<r.length;n++)if(typeof r[n]!="string")return!1}return!0}var Hn=class{generateSecretKey(){return Y.utils.randomSecretKey()}getPublicKey(e){return U(Y.getPublicKey(e))}finalizeEvent(e,t){let r=e;return r.pubkey=U(Y.getPublicKey(t)),r.id=ne(r),r.sig=U(Y.sign(j(ne(r)),t)),r[ot]=!0,r}verifyEvent(e){if(typeof e[ot]=="boolean")return e[ot];try{let t=ne(e);if(t!==e.id)return e[ot]=!1,!1;let r=Y.verify(j(e.sig),j(t),j(e.pubkey));return e[ot]=r,r}catch{return e[ot]=!1,!1}}};function $n(e){if(!Cn(e))throw new Error("can\'t serialize event with wrong or missing properties");return JSON.stringify([0,e.pubkey,e.created_at,e.kind,e.tags,e.content])}function ne(e){let t=W(Nn.encode($n(e)));return U(t)}var Rt=new Hn,$r=Rt.generateSecretKey,Me=Rt.getPublicKey,je=Rt.finalizeEvent,Ze=Rt.verifyEvent;var it=[9,40002],zn="buzz.solo",qn=48e3,Ve=/^[0-9a-f]{64}$/,Ln=/^[0-9a-f]{128}$/,Un=/^(kind=|created_at<|created_at>)(0|[1-9][0-9]*)$/,Pn=(e,t)=>e.tags.find(r=>r[0]===t)?.[1],Mn=e=>{let t=Pn(e,"h");return t&&/^[a-zA-Z0-9_-]{1,128}$/.test(t)?t:void 0};function jn(e){let t,r;for(let n of e.tags)n[0]!=="e"||!Ve.test(n[1]??"")||(n[3]==="root"?t=n[1]:n[3]==="reply"&&(r=n[1]));return t??r}var Ke=(e,t)=>it.includes(e.kind)&&e.pubkey!==t&&e.tags.some(r=>r[0]==="p"&&r[1]===t);function Zn(e){let t=e.tags.filter(c=>c[0]==="auth");if(t.length!==1)return;let[,r="",n="",s=""]=t[0];if(t[0].length!==4||!Ve.test(r)||!Ln.test(s)||r===e.pubkey)return;let o=n?n.split("&"):[];if(!o.every(c=>Un.test(c)))return;for(let c of o){let a=Number(c.replace(/^[^0-9]+/,""));if(c.startsWith("kind=")&&e.kind!==a||c.startsWith("created_at<")&&!(e.created_at<a)||c.startsWith("created_at>")&&!(e.created_at>a))return}let i=W(new TextEncoder().encode(`nostr:agent-auth:${e.pubkey}:${n}`));try{return Y.verify(Buffer.from(s,"hex"),i,Buffer.from(r,"hex"))?r:void 0}catch{return}}var Ge=(e,t)=>e.pubkey===t||Zn(e)===t;function Ye(e){if(!e)return{solo:!1};let[t,...r]=e.tags.flatMap(n=>n[0]==="t"&&typeof n[1]=="string"?[n[1]]:[]);return{...t&&{type:t},solo:t==="stream"&&r.includes(zn)}}function We(e,t,r){let n=Mn(e);if(!n)return;let s=jn(e),o=s??e.id,i=r.type==="dm",c=r.solo,a=c||i||t==="channel";return{key:a?n:`${n}/${o}`,channel:n,root:o,topLevel:c,dm:i,fresh:!s&&!a}}function Xe(e){return e.fresh?[]:!e.topLevel&&!e.dm&&e.key!==e.channel?[{ids:[e.root],"#h":[e.channel],limit:1},{kinds:it,"#h":[e.channel],"#e":[e.root],limit:200}]:[{kinds:it,"#h":[e.channel],limit:13}]}var Je=e=>e.replace(/\\[([^\\]]*)\\]\\(nostr:[^)]+\\)/g,"").replace(/nostr:(npub|nprofile|note|nevent)1[0-9a-z]+/g,"").replace(/^\\s*@\\S+\\s*/,"").replace(/[ \\t]+/g," ").trim();function Qe(e,t=qn){let r=o=>Buffer.byteLength(o);if(r(e)<=t)return[e];let n=[],s=e;for(;r(s)>t;){let o=t;for(;r(s.slice(0,o))>t;)o=Math.floor(o*.9);let i=s.slice(0,o),c=Math.max(i.lastIndexOf(`\n\n`),i.lastIndexOf(`\n`)),a=c>o/2?c:o;n.push(s.slice(0,a).trimEnd()),s=s.slice(a).trimStart()}return s&&n.push(s),n}function Fe(e){return{kind:9,created_at:Math.floor(Date.now()/1e3),content:e.content,tags:[["h",e.conversation.channel],...e.conversation.topLevel?[]:[["e",e.conversation.root,"","reply"]],...(typeof e.notify=="string"?[e.notify]:e.notify??[]).map(t=>["p",t]),[...e.authTag]]}}function tn(e){return{kind:0,created_at:Math.floor(Date.now()/1e3),content:JSON.stringify({name:e.name,display_name:e.name,bot:!0,...e.picture&&{picture:e.picture},...e.about&&{about:e.about}}),tags:[[...e.authTag]]}}import{createHash as Vn,randomUUID as Kn}from"node:crypto";var Gn=e=>Vn("sha256").update(e).digest("hex"),Tt=class{constructor(t,r,n,s){this.url=t;this.secretKey=r;this.authTag=n;this.log=s;this.base=t.replace(/^ws/,"http").replace(/\\/+$/,"")}base;ready=!1;watching=new Set;closed=!1;sign(t){return je(t,this.secretKey)}async post(t,r){let n=`${this.base}${t}`,s=this.sign({kind:27235,created_at:Math.floor(Date.now()/1e3),content:"",tags:[["u",n],["method","POST"],["payload",Gn(r)],["nonce",Kn()]]}),o=await fetch(n,{method:"POST",headers:{authorization:`Nostr ${Buffer.from(JSON.stringify(s)).toString("base64")}`,"content-type":"application/json","x-auth-tag":JSON.stringify(this.authTag)},body:r,signal:AbortSignal.timeout(2e4)}),i=await o.text();if(!o.ok)throw this.ready=!1,Object.assign(new Error(`${o.status} ${i.slice(0,300)}`.trim()),{status:o.status});return this.ready=!0,JSON.parse(i)}async publish(t){let r=t.tags.filter(o=>o[0]!=="auth"&&o[0]!=="ms");r.some(o=>o[0]==="h")&&r.push(["ms",String(Date.now()%1e3)]),r.push([...this.authTag]);let n=this.sign({...t,tags:r}),s=await this.post("/events",JSON.stringify(n));if(!s.accepted&&!s.message?.startsWith("duplicate"))throw new Error(s.message||"The community refused the event.");return n}async query(t){if(!t.length)return[];let r=await this.post("/query",JSON.stringify(t));return Array.isArray(r)?r:[]}watch(t,r,n,s=3e3){let o=new Set,i=r,c=0,a,l=async()=>{if(this.closed)return;let d=s;try{let f=await this.query([{...t,since:i-5}]);c=0;for(let p of f.sort((y,k)=>y.created_at-k.created_at))o.has(p.id)||(o.add(p.id),i=Math.max(i,p.created_at),n(p));if(o.size>2e3)for(let p of[...o].slice(0,1e3))o.delete(p)}catch(f){let p=f.message??String(f),y=/retry in (\\d+)s/.exec(p);d=y?Number(y[1])*1e3:Math.min(6e4,s*2**++c),this.log(`poll failed (${p.slice(0,160)}); next in ${Math.round(d/1e3)}s`)}this.closed||(a=setTimeout(()=>void l(),d),this.watching.add(a))};return l(),()=>{a&&clearTimeout(a)}}close(){this.closed=!0;for(let t of this.watching)clearTimeout(t)}};function Yn(e,t){let r=e.root;return{kind:20002,created_at:Math.floor(Date.now()/1e3),content:"",tags:[["h",e.channel],...e.topLevel?[]:[...r===t.id?[]:[["e",r,"","root"]],["e",t.id,"","reply"]]]}}var It=class{constructor(t,r){this.publish=t;this.log=r}pulses=new Map;start(t,r){let n=t.topLevel?t.channel:t.key,s=this.pulses.get(n);if(!s){let c={turns:0,stop:()=>{}};c.stop=this.pulse(t,r,()=>{this.pulses.get(n)===c&&this.pulses.delete(n)}),this.pulses.set(n,c),s=c}let o=s;o.turns++;let i=!1;return()=>{i||(i=!0,--o.turns===0&&o.stop())}}pulse(t,r,n){let s=Date.now(),o=!1,i=0,c=()=>{clearInterval(l),n()},a=()=>{if(Date.now()-s>=18e5)return c();o||(o=!0,this.publish(Yn(t,r)).then(()=>{o=!1,i=0},d=>{o=!1,!(++i<3)&&(c(),this.log(`stopped showing typing in ${t.key}: ${d.message}`))}))},l=setInterval(a,3e3);return l.unref?.(),a(),c}};var Nt=class{constructor(t=36e5,r=()=>Date.now()){this.quietMs=t;this.now=r}told=new Map;take(t,r,n){let s=this.now(),o=`${t}|${r}|${n}`,i=this.told.get(o);if(i!==void 0&&s-i<this.quietMs)return!1;if(this.told.set(o,s),this.told.size>1e3)for(let[c,a]of this.told)s-a>=this.quietMs&&this.told.delete(c);return!0}};var en=/^[0-9a-f]{64}$/;function nn(e){if(e)try{let t=JSON.parse(e);return t.v!==1||typeof t.key!="string"||!en.test(t.key)?void 0:{v:1,key:t.key,...typeof t.relay=="string"&&t.relay&&{relay:t.relay},...typeof t.owner=="string"&&en.test(t.owner)&&{owner:t.owner},...Array.isArray(t.auth)&&t.auth.every(r=>typeof r=="string")&&{auth:t.auth},...typeof t.name=="string"&&t.name&&{name:t.name},...typeof t.picture=="string"&&t.picture&&{picture:t.picture},...(t.answers==="owner"||t.answers==="everyone")&&{answers:t.answers},...typeof t.app=="string"&&t.app&&{app:t.app},...typeof t.workspace=="string"&&t.workspace&&{workspace:t.workspace}}}catch{return}}var rn=e=>!!(e?.relay&&e.owner&&e.auth?.length);var sn=e=>Uint8Array.from(Buffer.from(e,"hex")),Xn=()=>Math.floor(Date.now()/1e3),Jn="Hi! I only take requests from the person who set me up, so I can\'t help with this one. I\'ve let them know you asked.",se=class{constructor(t=process.env){this.env=t;let r=(t.DATABRICKS_HOST??"").trim().replace(/\\/+$/,"");this.host=r?/^https?:\\/\\//.test(r)?r:`https://${r}`:""}host;cached;me;async token(){if(this.cached&&Date.now()<this.cached.until)return this.cached.token;let t=this.env.DATABRICKS_CLIENT_ID,r=this.env.DATABRICKS_CLIENT_SECRET;if(!this.host||!t||!r)throw new Error("DATABRICKS_HOST, DATABRICKS_CLIENT_ID and DATABRICKS_CLIENT_SECRET aren\'t set; this runs as a Databricks App.");let n=await fetch(`${this.host}/oidc/v1/token`,{method:"POST",headers:{authorization:`Basic ${Buffer.from(`${t}:${r}`).toString("base64")}`,"content-type":"application/x-www-form-urlencoded"},body:"grant_type=client_credentials&scope=all-apis",signal:AbortSignal.timeout(2e4)}),s=await n.json().catch(()=>({}));if(!n.ok||!s.access_token)throw new Error(`Couldn\'t sign in as the app\'s service principal: ${s.error_description??`HTTP ${n.status}`}`);return this.cached={token:s.access_token,until:Date.now()+Math.max(60,(s.expires_in??3600)-60)*1e3},s.access_token}async api(t,r={}){let n=new URL(`${this.host}${t}`);for(let[i,c]of Object.entries(r.query??{}))n.searchParams.set(i,c);let s=await fetch(n,{method:r.method??(r.body===void 0?"GET":"POST"),headers:{authorization:`Bearer ${await this.token()}`,accept:"application/json",...r.body!==void 0&&{"content-type":"application/json"}},...r.body!==void 0&&{body:JSON.stringify(r.body)},signal:AbortSignal.timeout(6e4)}),o=await s.text();if(!s.ok){let i=`HTTP ${s.status}`;try{i=JSON.parse(o).message||i}catch{}throw Object.assign(new Error(i),{status:s.status})}return o.trim()?JSON.parse(o):{}}async secret(t){try{let r=await this.api(`/api/2.1/unity-catalog/secrets/${t.split(".").map(encodeURIComponent).join(".")}`,{query:{include_value:"true"}});return r.effective_value??r.value??""}catch(r){if(r.status===404)return;throw r}}whoami(){return this.me??=this.api("/api/2.0/preview/scim/v2/Me").then(t=>({applicationId:t.applicationId??t.userName??"",displayName:t.displayName??t.userName??""}),t=>{throw this.me=void 0,t}),this.me}},on=class{constructor(t={}){this.options=t;this.env=t.env??process.env,this.databricks=new se(this.env);let r=t.log??(n=>console.log(`[buzz] ${n}`));this.log=n=>{/^poll failed/.test(n)&&(this.relayError=n.replace(/^poll failed \\((.*)\\); next in .*$/,"$1")),r(n)}}databricks;identity;pubkey;relay;state="starting";lastError;handlers=[];connects=[];disconnects=[];routes=new Map;extras=[];stopWatch;refreshTimer;server;typing;publishedProfile;handled=new Set;queues=new Map;channels=new Map;notes=new Nt;startedAt=Date.now();answered=0;lastMention;log;relayError;runsAs;env;get secretName(){return this.options.identitySecret??this.env.BUZZ_IDENTITY_SECRET??""}get appName(){return this.env.DATABRICKS_APP_NAME??this.identity?.app??""}onMention(t){return this.handlers.push(t),this}onConnect(t){return this.connects.push(t),this}route(t,r){return this.routes.set(t,r),this}describe(t){return this.extras.push(t),this}async start(){let t=this.options.port??Number(this.env.DATABRICKS_APP_PORT||8e3);this.server=Wn((r,n)=>{let s=new URL(r.url??"/","http://app"),o=this.routes.get(s.pathname);if(o)return void this.serve(o,r,s,n);let i=this.status();if(s.pathname.startsWith("/api/status"))return n.writeHead(200,{"content-type":"application/json"}),n.end(JSON.stringify(i));n.writeHead(200,{"content-type":"text/html; charset=utf-8"}),n.end(Fn(i))}),await new Promise(r=>this.server.listen(t,r)),this.databricks.whoami().then(r=>this.runsAs=r,r=>this.log(`couldn\'t sign in to Databricks as the app\'s service principal: ${r.message}`)),process.once("SIGTERM",()=>{this.stop(),process.exit(0)}),await this.refresh()}async serve(t,r,n,s){let o=a=>{let l=r.headers[a];return typeof l=="string"&&l?l:void 0},i;try{let a=o("x-forwarded-email"),l=o("x-forwarded-access-token");i=await t({method:r.method??"GET",url:n,...a&&{user:a},...l&&{userToken:l},body:()=>new Promise((d,f)=>{let p="";r.setEncoding("utf8"),r.on("data",y=>p+=y),r.on("end",()=>d(p)),r.on("error",f)})})}catch(a){i={status:500,json:{error:a.message??String(a)}}}let c=i.json!==void 0?"application/json":i.html!==void 0?"text/html; charset=utf-8":"text/plain; charset=utf-8";s.writeHead(i.status??200,{"content-type":c}),s.end(i.json!==void 0?JSON.stringify(i.json):i.html??i.text??"")}stop(){this.stopWatch?.(),this.relay?.close(),this.refreshTimer&&clearTimeout(this.refreshTimer),this.server?.close()}status(){let t=this.state==="connected"&&!this.relay?.ready,r=this.lastError??(t&&this.relayError?`Can\'t reach the Buzz community: ${this.relayError}`:void 0),n={state:t?"connecting":this.state,...r&&{lastError:r},...this.pubkey&&{pubkey:this.pubkey},...this.identity?.name&&{name:this.identity.name},...this.identity?.owner&&{owner:this.identity.owner},app:this.appName,secret:this.secretName,connected:this.relay?.ready??!1,...this.runsAs&&{runsAs:this.runsAs},answered:this.answered,startedAt:new Date(this.startedAt).toISOString(),...this.lastMention&&{lastMention:new Date(this.lastMention).toISOString()}},s={};for(let o of this.extras)try{Object.assign(s,o())}catch{}return{...s,...n,...Object.keys(s).length&&{extra:s}}}publish(t){if(!this.relay)throw new Error("Not signed in to Buzz yet.");return this.relay.publish(t)}query(t){if(!this.relay)throw new Error("Not signed in to Buzz yet.");return this.relay.query(t)}schedule(t){this.refreshTimer&&clearTimeout(this.refreshTimer),this.refreshTimer=setTimeout(()=>void this.refresh(),t),this.refreshTimer.unref?.()}async refresh(){let t=this.options.refreshMs??(Number(this.env.BUZZ_REFRESH_MS)||6e4);if(!this.secretName){this.state="error",this.lastError="BUZZ_IDENTITY_SECRET isn\'t set. Add it to app.yaml (the Databricks Agents plugin shows the line to add).";return}let r;try{let s=await this.databricks.secret(this.secretName);if(s===void 0)return this.relay&&this.log("the identity\'s secret is gone; signing out"),this.signOut(),this.state="removed",this.lastError=`${this.secretName} doesn\'t exist (anymore). The identity was removed in Buzz, or the name is wrong.`,this.schedule(t);if(r=nn(s),!r)throw new Error(`${this.secretName} isn\'t a Buzz identity.`)}catch(s){return this.state="error",this.lastError=`Couldn\'t read ${this.secretName}: ${s.message}`,this.log(this.lastError),this.schedule(Math.min(t,3e4))}let n=this.identity;if(this.identity=r,this.pubkey=Me(sn(r.key)),!rn(r))return this.state="waiting",this.lastError=void 0,this.schedule(Math.min(t,1e4));(!this.relay||n?.key!==r.key||n?.relay!==r.relay||n?.auth?.join()!==r.auth.join())&&this.signIn(r),this.state="connected",this.lastError=void 0,await this.publishProfile(r),this.schedule(t)}signOut(){for(let t of this.disconnects.splice(0))try{t()}catch{}this.stopWatch?.(),this.stopWatch=void 0,this.relay?.close(),this.relay=void 0,this.publishedProfile=void 0}signIn(t){this.signOut();let r=new Tt(t.relay,sn(t.key),t.auth,this.log);this.relay=r,this.typing=new It(n=>r.publish(n),this.log),this.log(`signing in as ${this.pubkey.slice(0,12)}\\u2026 for ${t.name??"this app"}`),this.stopWatch=r.watch({kinds:it,"#p":[this.pubkey]},Xn()-60,n=>this.onEvent(n),this.options.pollMs??3e3);for(let n of this.connects)Promise.resolve().then(()=>n(this)).then(s=>{typeof s=="function"&&(this.relay===r?this.disconnects.push(s):s())},s=>this.log(`a connect handler failed: ${s.message??s}`))}async publishProfile(t){let r=t.name||this.appName||"Buzz app",n=this.options.about;if(!n){let o=await this.databricks.whoami().catch(()=>{});o&&(this.runsAs=o);let i=t.workspace?` in ${t.workspace.replace(/^https:\\/\\//,"")}`:"";n=`A Databricks App${this.appName?` (${this.appName})`:""}${i}${o?`, running as the service principal ${o.displayName||o.applicationId} (${o.applicationId})`:""}.`}let s=JSON.stringify([r,t.picture??"",n]);if(!(this.publishedProfile===s||!this.relay))try{await this.relay.publish(tn({name:r,...t.picture&&{picture:t.picture},about:n,authTag:t.auth})),this.publishedProfile=s,this.log("published the profile")}catch(o){this.log(`profile not published yet: ${o.message}`)}}allowed(t){let r=this.identity?.owner??"";if(Ge(t,r))return!0;let n=this.options.answers??this.identity?.answers??"everyone";return n==="everyone"?!0:n==="owner"?!1:n.includes(t.pubkey)}async kindOf(t){let r=this.channels.get(t);if(r&&Date.now()-r.at<10*6e4)return r.kind;let[n]=await this.query([{kinds:[39e3],"#d":[t],limit:1}]),s=Ye(n);return this.channels.set(t,{at:Date.now(),kind:s}),s}onEvent(t){let r=this.pubkey;if(this.handled.has(t.id)||!Ze(t)||!Ke(t,r))return;if(this.handled.add(t.id),this.handled.size>5e3)for(let s of[...this.handled].slice(0,2500))this.handled.delete(s);let n=t.tags.find(s=>s[0]==="h")?.[1];n&&this.kindOf(n).catch(()=>({solo:!1})).then(s=>{let o=We(t,this.options.scope??"thread",s);if(!o)return;let i=(this.queues.get(o.key)??Promise.resolve()).then(()=>this.handle(t,o));this.queues.set(o.key,i.catch(()=>{}))})}async say(t,r,n){for(let s of Qe(r))await this.publish(Fe({conversation:t,content:s,authTag:this.identity.auth,...n&&{notify:n}}))}async handle(t,r){let n=this.identity?.owner??"";if(!this.allowed(t)){this.notes.take(this.pubkey,t.pubkey,r.key)&&await this.say(r,Jn,[t.pubkey,n]).catch(()=>{}),this.log(`ignored ${t.id.slice(0,8)}: not someone it answers`);return}this.lastMention=Date.now();let s=[],o={say:a=>this.say(r,a),typing:()=>{let a=this.typing?.start(r,t)??(()=>{});return s.push(a),a},history:async()=>(await this.query(Xe(r))).filter(l=>l.id!==t.id&&it.includes(l.kind)&&l.created_at<=t.created_at).sort((l,d)=>l.created_at-d.created_at)},i=r.root!==t.id?r.root:void 0,c={id:t.id,channel:r.channel,...i&&{thread:i},author:t.pubkey,text:Je(t.content),content:t.content,createdAt:t.created_at,conversation:r,event:t};try{for(let a of this.handlers)await a(c,o);this.answered++}catch(a){let l=a.message??String(a);this.lastError=l,this.log(`a mention failed: ${l}`),await this.say(r,`I couldn\'t finish that: ${l}`).catch(()=>{})}finally{for(let a of s)a()}}},re=e=>e.replace(/[&<>"]/g,t=>({"&":"&amp;","<":"&lt;",">":"&gt;",\'"\':"&quot;"})[t]),Qn={starting:"Starting",waiting:"Waiting for Buzz to finish setting up this identity",connecting:"Reaching the Buzz community",connected:"Signed in to Buzz",removed:"Its identity was removed",error:"Something\'s wrong"};function Fn(e){let t=[["Status",Qn[e.state]],["Problem",e.lastError],["Buzz identity",e.pubkey],["Runs as",e.runsAs&&`${e.runsAs.displayName} (${e.runsAs.applicationId})`],["Name",e.name],["Owner",e.owner],["Identity secret",e.secret],["Mentions answered",String(e.answered)],...Object.entries(e.extra??{}).map(([r,n])=>[r,typeof n=="object"?JSON.stringify(n):String(n)]),["Started",e.startedAt]];return`<!doctype html><meta charset="utf-8"><title>${re(e.name??e.app??"Buzz app")}</title>\n<style>body{font:14px system-ui,sans-serif;margin:40px;color:#1b1f23}td{padding:4px 16px 4px 0;vertical-align:top}td:first-child{color:#666}code{font-size:12px}</style>\n<h1>${re(e.name??e.app??"Buzz app")}</h1><table>${t.filter(([,r])=>r).map(([r,n])=>`<tr><td>${r}</td><td><code>${re(n)}</code></td></tr>`).join("")}</table>`}export{on as BuzzApp,Jn as NOT_ALLOWED_TEXT,se as Workspace};\n';
var STARTER = '// A starter Buzz app on Databricks Apps, from the Databricks Agents plugin.\n//\n// It answers when someone mentions it in Buzz, and says who it runs as: this\n// app\'s own Databricks service principal. Everything it does in Databricks\n// runs as that principal, so it can reach only what the principal is granted.\n//\n// Change what it does below, then redeploy the app (from its Settings tab in\n// Buzz, or Deploy in Databricks). buzz-app.mjs handles Buzz itself; see the\n// comments at its top.\nimport { BuzzApp } from "./buzz-app.mjs";\n\nconst app = new BuzzApp();\n\napp.onMention(async (mention, reply) => {\n  const stopTyping = reply.typing();\n  const me = await app.databricks.whoami().catch(() => undefined);\n  stopTyping();\n  const lines = [\n    `Hi! I\'m a Databricks App${app.appName ? ` (**${app.appName}**)` : ""}.`,\n    me\n      ? `I run in ${app.databricks.host.replace(/^https:\\/\\//, "")} as the service principal **${me.displayName || me.applicationId}** (\\`${me.applicationId}\\`), so I can reach only what it\'s granted.`\n      : "I run as this app\'s own Databricks service principal, so I can reach only what it\'s granted.",\n  ];\n  if (mention.text) lines.push(`You said: \u201C${mention.text}\u201D`);\n  if (process.env.BUZZ_APP_SOURCE) lines.push(`To change what I do, edit \\`app.mjs\\` in \\`${process.env.BUZZ_APP_SOURCE}\\` and redeploy me.`);\n  await reply.say(lines.join("\\n\\n"));\n});\n\napp.start();\n';
var INDEXER = '// Buzz search index for Databricks Apps (built by databricks-buzz-plugins). Apache-2.0.\nimport { createRequire as __buzzRequire } from \'node:module\';\nconst require = __buzzRequire(import.meta.url);\nvar Xo=Object.create;var $n=Object.defineProperty;var Jo=Object.getOwnPropertyDescriptor;var ea=Object.getOwnPropertyNames;var ta=Object.getPrototypeOf,ra=Object.prototype.hasOwnProperty;var O=(t=>typeof require<"u"?require:typeof Proxy<"u"?new Proxy(t,{get:(e,r)=>(typeof require<"u"?require:e)[r]}):t)(function(t){if(typeof require<"u")return require.apply(this,arguments);throw Error(\'Dynamic require of "\'+t+\'" is not supported\')});var E=(t,e)=>()=>(e||t((e={exports:{}}).exports,e),e.exports);var na=(t,e,r,n)=>{if(e&&typeof e=="object"||typeof e=="function")for(let s of ea(e))!ra.call(t,s)&&s!==r&&$n(t,s,{get:()=>e[s],enumerable:!(n=Jo(e,s))||n.enumerable});return t};var sa=(t,e,r)=>(r=t!=null?Xo(ta(t)):{},na(e||!t||!t.__esModule?$n(r,"default",{value:t,enumerable:!0}):r,t));var Pr=E(ei=>{"use strict";ei.parse=function(t,e){return new Br(t,e).parse()};var Br=class t{constructor(e,r){this.source=e,this.transform=r||sc,this.position=0,this.entries=[],this.recorded=[],this.dimension=0}isEof(){return this.position>=this.source.length}nextCharacter(){var e=this.source[this.position++];return e==="\\\\"?{value:this.source[this.position++],escaped:!0}:{value:e,escaped:!1}}record(e){this.recorded.push(e)}newEntry(e){var r;(this.recorded.length>0||e)&&(r=this.recorded.join(""),r==="NULL"&&!e&&(r=null),r!==null&&(r=this.transform(r)),this.entries.push(r),this.recorded=[])}consumeDimensions(){if(this.source[0]==="[")for(;!this.isEof();){var e=this.nextCharacter();if(e.value==="=")break}}parse(e){var r,n,s;for(this.consumeDimensions();!this.isEof();)if(r=this.nextCharacter(),r.value==="{"&&!s)this.dimension++,this.dimension>1&&(n=new t(this.source.substr(this.position-1),this.transform),this.entries.push(n.parse(!0)),this.position+=n.position-2);else if(r.value==="}"&&!s){if(this.dimension--,!this.dimension&&(this.newEntry(),e))return this.entries}else r.value===\'"\'&&!r.escaped?(s&&this.newEntry(!0),s=!s):r.value===","&&!s?this.newEntry():this.record(r.value);if(this.dimension!==0)throw new Error("array dimension not balanced");return this.entries}};function sc(t){return t}});var Lr=E((Wf,ti)=>{"use strict";var ic=Pr();ti.exports={create:function(t,e){return{parse:function(){return ic.parse(t,e)}}}}});var si=E((Zf,ni)=>{"use strict";var oc=/(\\d{1,})-(\\d{2})-(\\d{2}) (\\d{2}):(\\d{2}):(\\d{2})(\\.\\d{1,})?.*?( BC)?$/,ac=/^(\\d{1,})-(\\d{2})-(\\d{2})( BC)?$/,cc=/([Z+-])(\\d{2})?:?(\\d{2})?:?(\\d{2})?/,uc=/^-?infinity$/;ni.exports=function(e){if(uc.test(e))return Number(e.replace("i","I"));var r=oc.exec(e);if(!r)return lc(e)||null;var n=!!r[8],s=parseInt(r[1],10);n&&(s=ri(s));var i=parseInt(r[2],10)-1,o=r[3],a=parseInt(r[4],10),c=parseInt(r[5],10),u=parseInt(r[6],10),l=r[7];l=l?1e3*parseFloat(l):0;var h,f=hc(e);return f!=null?(h=new Date(Date.UTC(s,i,o,a,c,u,l)),Dr(s)&&h.setUTCFullYear(s),f!==0&&h.setTime(h.getTime()-f)):(h=new Date(s,i,o,a,c,u,l),Dr(s)&&h.setFullYear(s)),h};function lc(t){var e=ac.exec(t);if(e){var r=parseInt(e[1],10),n=!!e[4];n&&(r=ri(r));var s=parseInt(e[2],10)-1,i=e[3],o=new Date(r,s,i);return Dr(r)&&o.setFullYear(r),o}}function hc(t){if(t.endsWith("+00"))return 0;var e=cc.exec(t.split(" ")[1]);if(e){var r=e[1];if(r==="Z")return 0;var n=r==="-"?-1:1,s=parseInt(e[2],10)*3600+parseInt(e[3]||0,10)*60+parseInt(e[4]||0,10);return s*n*1e3}}function ri(t){return-(t-1)}function Dr(t){return t>=0&&t<100}});var oi=E((Xf,ii)=>{"use strict";ii.exports=dc;var fc=Object.prototype.hasOwnProperty;function dc(t){for(var e=1;e<arguments.length;e++){var r=arguments[e];for(var n in r)fc.call(r,n)&&(t[n]=r[n])}return t}});var ui=E((Jf,ci)=>{"use strict";var pc=oi();ci.exports=De;function De(t){if(!(this instanceof De))return new De(t);pc(this,Tc(t))}var mc=["seconds","minutes","hours","days","months","years"];De.prototype.toPostgres=function(){var t=mc.filter(this.hasOwnProperty,this);return this.milliseconds&&t.indexOf("seconds")<0&&t.push("seconds"),t.length===0?"0":t.map(function(e){var r=this[e]||0;return e==="seconds"&&this.milliseconds&&(r=(r+this.milliseconds/1e3).toFixed(6).replace(/\\.?0+$/,"")),r+" "+e},this).join(" ")};var yc={years:"Y",months:"M",days:"D",hours:"H",minutes:"M",seconds:"S"},gc=["years","months","days"],bc=["hours","minutes","seconds"];De.prototype.toISOString=De.prototype.toISO=function(){var t=gc.map(r,this).join(""),e=bc.map(r,this).join("");return"P"+t+"T"+e;function r(n){var s=this[n]||0;return n==="seconds"&&this.milliseconds&&(s=(s+this.milliseconds/1e3).toFixed(6).replace(/0+$/,"")),s+yc[n]}};var Mr="([+-]?\\\\d+)",wc=Mr+"\\\\s+years?",Ec=Mr+"\\\\s+mons?",xc=Mr+"\\\\s+days?",Sc="([+-])?([\\\\d]*):(\\\\d\\\\d):(\\\\d\\\\d)\\\\.?(\\\\d{1,6})?",vc=new RegExp([wc,Ec,xc,Sc].map(function(t){return"("+t+")?"}).join("\\\\s*")),ai={years:2,months:4,days:6,hours:9,minutes:10,seconds:11,milliseconds:12},_c=["hours","minutes","seconds","milliseconds"];function Ac(t){var e=t+"000000".slice(t.length);return parseInt(e,10)/1e3}function Tc(t){if(!t)return{};var e=vc.exec(t),r=e[8]==="-";return Object.keys(ai).reduce(function(n,s){var i=ai[s],o=e[i];return!o||(o=s==="milliseconds"?Ac(o):parseInt(o,10),!o)||(r&&~_c.indexOf(s)&&(o*=-1),n[s]=o),n},{})}});var fi=E((ed,hi)=>{"use strict";var li=Buffer.from||Buffer;hi.exports=function(e){if(/^\\\\x/.test(e))return li(e.substr(2),"hex");for(var r="",n=0;n<e.length;)if(e[n]!=="\\\\")r+=e[n],++n;else if(/[0-7]{3}/.test(e.substr(n+1,3)))r+=String.fromCharCode(parseInt(e.substr(n+1,3),8)),n+=4;else{for(var s=1;n+s<e.length&&e[n+s]==="\\\\";)s++;for(var i=0;i<Math.floor(s/2);++i)r+="\\\\";n+=Math.floor(s/2)*2}return li(r,"binary")}});var wi=E((td,bi)=>{"use strict";var et=Pr(),tt=Lr(),Ot=si(),pi=ui(),mi=fi();function Bt(t){return function(r){return r===null?r:t(r)}}function yi(t){return t===null?t:t==="TRUE"||t==="t"||t==="true"||t==="y"||t==="yes"||t==="on"||t==="1"}function Rc(t){return t?et.parse(t,yi):null}function kc(t){return parseInt(t,10)}function qr(t){return t?et.parse(t,Bt(kc)):null}function Ic(t){return t?et.parse(t,Bt(function(e){return gi(e).trim()})):null}var Cc=function(t){if(!t)return null;var e=tt.create(t,function(r){return r!==null&&(r=Qr(r)),r});return e.parse()},$r=function(t){if(!t)return null;var e=tt.create(t,function(r){return r!==null&&(r=parseFloat(r)),r});return e.parse()},te=function(t){if(!t)return null;var e=tt.create(t);return e.parse()},Ur=function(t){if(!t)return null;var e=tt.create(t,function(r){return r!==null&&(r=Ot(r)),r});return e.parse()},Nc=function(t){if(!t)return null;var e=tt.create(t,function(r){return r!==null&&(r=pi(r)),r});return e.parse()},Oc=function(t){return t?et.parse(t,Bt(mi)):null},Hr=function(t){return parseInt(t,10)},gi=function(t){var e=String(t);return/^\\d+$/.test(e)?e:t},di=function(t){return t?et.parse(t,Bt(JSON.parse)):null},Qr=function(t){return t[0]!=="("?null:(t=t.substring(1,t.length-1).split(","),{x:parseFloat(t[0]),y:parseFloat(t[1])})},Bc=function(t){if(t[0]!=="<"&&t[1]!=="(")return null;for(var e="(",r="",n=!1,s=2;s<t.length-1;s++){if(n||(e+=t[s]),t[s]===")"){n=!0;continue}else if(!n)continue;t[s]!==","&&(r+=t[s])}var i=Qr(e);return i.radius=parseFloat(r),i},Pc=function(t){t(20,gi),t(21,Hr),t(23,Hr),t(26,Hr),t(700,parseFloat),t(701,parseFloat),t(16,yi),t(1082,Ot),t(1114,Ot),t(1184,Ot),t(600,Qr),t(651,te),t(718,Bc),t(1e3,Rc),t(1001,Oc),t(1005,qr),t(1007,qr),t(1028,qr),t(1016,Ic),t(1017,Cc),t(1021,$r),t(1022,$r),t(1231,$r),t(1014,te),t(1015,te),t(1008,te),t(1009,te),t(1040,te),t(1041,te),t(1115,Ur),t(1182,Ur),t(1185,Ur),t(1186,pi),t(1187,Nc),t(17,mi),t(114,JSON.parse.bind(JSON)),t(3802,JSON.parse.bind(JSON)),t(199,di),t(3807,di),t(3907,te),t(2951,te),t(791,te),t(1183,te),t(1270,te)};bi.exports={init:Pc}});var xi=E((rd,Ei)=>{"use strict";var Y=1e6;function Lc(t){var e=t.readInt32BE(0),r=t.readUInt32BE(4),n="";e<0&&(e=~e+(r===0),r=~r+1>>>0,n="-");var s="",i,o,a,c,u,l;{if(i=e%Y,e=e/Y>>>0,o=4294967296*i+r,r=o/Y>>>0,a=""+(o-Y*r),r===0&&e===0)return n+a+s;for(c="",u=6-a.length,l=0;l<u;l++)c+="0";s=c+a+s}{if(i=e%Y,e=e/Y>>>0,o=4294967296*i+r,r=o/Y>>>0,a=""+(o-Y*r),r===0&&e===0)return n+a+s;for(c="",u=6-a.length,l=0;l<u;l++)c+="0";s=c+a+s}{if(i=e%Y,e=e/Y>>>0,o=4294967296*i+r,r=o/Y>>>0,a=""+(o-Y*r),r===0&&e===0)return n+a+s;for(c="",u=6-a.length,l=0;l<u;l++)c+="0";s=c+a+s}return i=e%Y,o=4294967296*i+r,a=""+o%Y,n+a+s}Ei.exports=Lc});var Ti=E((nd,Ai)=>{"use strict";var Dc=xi(),D=function(t,e,r,n,s){r=r||0,n=n||!1,s=s||function(p,S,y){return p*Math.pow(2,y)+S};var i=r>>3,o=function(p){return n?~p&255:p},a=255,c=8-r%8;e<c&&(a=255<<8-e&255,c=e),r&&(a=a>>r%8);var u=0;r%8+e>=8&&(u=s(0,o(t[i])&a,c));for(var l=e+r>>3,h=i+1;h<l;h++)u=s(u,o(t[h]),8);var f=(e+r)%8;return f>0&&(u=s(u,o(t[l])>>8-f,f)),u},_i=function(t,e,r){var n=Math.pow(2,r-1)-1,s=D(t,1),i=D(t,r,1);if(i===0)return 0;var o=1,a=function(u,l,h){u===0&&(u=1);for(var f=1;f<=h;f++)o/=2,(l&1<<h-f)>0&&(u+=o);return u},c=D(t,e,r+1,!1,a);return i==Math.pow(2,r+1)-1?c===0?s===0?1/0:-1/0:NaN:(s===0?1:-1)*Math.pow(2,i-n)*c},Mc=function(t){return D(t,1)==1?-1*(D(t,15,1,!0)+1):D(t,15,1)},Si=function(t){return D(t,1)==1?-1*(D(t,31,1,!0)+1):D(t,31,1)},qc=function(t){return _i(t,23,8)},$c=function(t){return _i(t,52,11)},Uc=function(t){var e=D(t,16,32);if(e==49152)return NaN;for(var r=Math.pow(1e4,D(t,16,16)),n=0,s=[],i=D(t,16),o=0;o<i;o++)n+=D(t,16,64+16*o)*r,r/=1e4;var a=Math.pow(10,D(t,16,48));return(e===0?1:-1)*Math.round(n*a)/a},vi=function(t,e){var r=D(e,1),n=D(e,63,1),s=new Date((r===0?1:-1)*n/1e3+9466848e5);return t||s.setTime(s.getTime()+s.getTimezoneOffset()*6e4),s.usec=n%1e3,s.getMicroSeconds=function(){return this.usec},s.setMicroSeconds=function(i){this.usec=i},s.getUTCMicroSeconds=function(){return this.usec},s},rt=function(t){for(var e=D(t,32),r=D(t,32,32),n=D(t,32,64),s=96,i=[],o=0;o<e;o++)i[o]=D(t,32,s),s+=32,s+=32;var a=function(u){var l=D(t,32,s);if(s+=32,l==4294967295)return null;var h;if(u==23||u==20)return h=D(t,l*8,s),s+=l*8,h;if(u==25)return h=t.toString(this.encoding,s>>3,(s+=l<<3)>>3),h;console.log("ERROR: ElementType not implemented: "+u)},c=function(u,l){var h=[],f;if(u.length>1){var p=u.shift();for(f=0;f<p;f++)h[f]=c(u,l);u.unshift(p)}else for(f=0;f<u[0];f++)h[f]=a(l);return h};return c(i,n)},Hc=function(t){return t.toString("utf8")},Qc=function(t){return t===null?null:D(t,8)>0},zc=function(t){t(20,Dc),t(21,Mc),t(23,Si),t(26,Si),t(1700,Uc),t(700,qc),t(701,$c),t(16,Qc),t(1114,vi.bind(null,!1)),t(1184,vi.bind(null,!0)),t(1e3,rt),t(1007,rt),t(1016,rt),t(1008,rt),t(1009,rt),t(25,Hc)};Ai.exports={init:zc}});var ki=E((sd,Ri)=>{"use strict";Ri.exports={BOOL:16,BYTEA:17,CHAR:18,INT8:20,INT2:21,INT4:23,REGPROC:24,TEXT:25,OID:26,TID:27,XID:28,CID:29,JSON:114,XML:142,PG_NODE_TREE:194,SMGR:210,PATH:602,POLYGON:604,CIDR:650,FLOAT4:700,FLOAT8:701,ABSTIME:702,RELTIME:703,TINTERVAL:704,CIRCLE:718,MACADDR8:774,MONEY:790,MACADDR:829,INET:869,ACLITEM:1033,BPCHAR:1042,VARCHAR:1043,DATE:1082,TIME:1083,TIMESTAMP:1114,TIMESTAMPTZ:1184,INTERVAL:1186,TIMETZ:1266,BIT:1560,VARBIT:1562,NUMERIC:1700,REFCURSOR:1790,REGPROCEDURE:2202,REGOPER:2203,REGOPERATOR:2204,REGCLASS:2205,REGTYPE:2206,UUID:2950,TXID_SNAPSHOT:2970,PG_LSN:3220,PG_NDISTINCT:3361,PG_DEPENDENCIES:3402,TSVECTOR:3614,TSQUERY:3615,GTSVECTOR:3642,REGCONFIG:3734,REGDICTIONARY:3769,JSONB:3802,REGNAMESPACE:4089,REGROLE:4096}});var it=E(st=>{"use strict";var jc=wi(),Fc=Ti(),Gc=Lr(),Vc=ki();st.getTypeParser=Kc;st.setTypeParser=Yc;st.arrayParser=Gc;st.builtins=Vc;var nt={text:{},binary:{}};function Ii(t){return String(t)}function Kc(t,e){return e=e||"text",nt[e]&&nt[e][t]||Ii}function Yc(t,e,r){typeof e=="function"&&(r=e,e="text"),nt[e][t]=r}jc.init(function(t,e){nt.text[t]=e});Fc.init(function(t,e){nt.binary[t]=e})});var ot=E((od,zr)=>{"use strict";var Ci;try{Ci=process.platform==="win32"?process.env.USERNAME:process.env.USER}catch{}zr.exports={host:"localhost",user:Ci,database:void 0,password:null,connectionString:void 0,port:5432,rows:0,binary:!1,max:10,idleTimeoutMillis:3e4,client_encoding:"",ssl:!1,sslnegotiation:void 0,application_name:void 0,fallback_application_name:void 0,options:void 0,parseInputDatesAsUTC:!1,statement_timeout:!1,lock_timeout:!1,idle_in_transaction_session_timeout:!1,query_timeout:!1,connect_timeout:0,keepalives:1,keepalives_idle:0};var Me=it(),Wc=Me.getTypeParser(20,"text"),Zc=Me.getTypeParser(1016,"text");zr.exports.__defineSetter__("parseInt8",function(t){Me.setTypeParser(20,"text",t?Me.getTypeParser(23,"text"):Wc),Me.setTypeParser(1016,"text",t?Me.getTypeParser(1007,"text"):Zc)})});var ve=E((ad,Oi)=>{"use strict";var Xc=ot(),Jc=O("util"),{isDate:eu}=O("util/types"),tu=Jc.deprecate(()=>{},"Sending an invalid date to Postgres is deprecated and will throw an error in the next major version of pg. Ensure any Date object passed as a query parameter is valid.","PG_INVALID_DATE");function ru(t){return\'"\'+t.replace(/\\\\/g,"\\\\\\\\").replace(/"/g,\'\\\\"\')+\'"\'}function Ni(t){let e="{";for(let r=0;r<t.length;r++){r>0&&(e+=",");let n=t[r];n==null?e+="NULL":Array.isArray(n)?e+=Ni(n):ArrayBuffer.isView(n)?(n instanceof Buffer||(n=Buffer.from(n.buffer,n.byteOffset,n.byteLength)),e+="\\\\\\\\x"+n.toString("hex")):e+=ru(Pt(n))}return e+="}",e}var Pt=function(t,e){return t==null?null:typeof t=="object"?t instanceof Buffer?t:ArrayBuffer.isView(t)?Buffer.from(t.buffer,t.byteOffset,t.byteLength):eu(t)?(isNaN(t.getTime())&&tu(),Xc.parseInputDatesAsUTC?iu(t):su(t)):Array.isArray(t)?Ni(t):nu(t,e):t.toString()};function nu(t,e){if(t&&typeof t.toPostgres=="function"){if(e=e||[],e.indexOf(t)!==-1)throw new Error(\'circular reference detected while preparing "\'+t+\'" for query\');return e.push(t),Pt(t.toPostgres(Pt),e)}return JSON.stringify(t)}function su(t){let e=-t.getTimezoneOffset(),r=t.getFullYear(),n=r<1;n&&(r=Math.abs(r)+1);let s=String(r).padStart(4,"0")+"-"+String(t.getMonth()+1).padStart(2,"0")+"-"+String(t.getDate()).padStart(2,"0")+"T"+String(t.getHours()).padStart(2,"0")+":"+String(t.getMinutes()).padStart(2,"0")+":"+String(t.getSeconds()).padStart(2,"0")+"."+String(t.getMilliseconds()).padStart(3,"0");return e<0?(s+="-",e*=-1):s+="+",s+=String(Math.floor(e/60)).padStart(2,"0")+":"+String(e%60).padStart(2,"0"),n&&(s+=" BC"),s}function iu(t){let e=t.getUTCFullYear(),r=e<1;r&&(e=Math.abs(e)+1);let n=String(e).padStart(4,"0")+"-"+String(t.getUTCMonth()+1).padStart(2,"0")+"-"+String(t.getUTCDate()).padStart(2,"0")+"T"+String(t.getUTCHours()).padStart(2,"0")+":"+String(t.getUTCMinutes()).padStart(2,"0")+":"+String(t.getUTCSeconds()).padStart(2,"0")+"."+String(t.getUTCMilliseconds()).padStart(3,"0");return n+="+00:00",r&&(n+=" BC"),n}function ou(t,e,r){return t=typeof t=="string"?{text:t}:au(t),e&&(typeof e=="function"?t.callback=e:t.values=e),r&&(t.callback=r),t}function au(t){return t==null?t:Object.defineProperties(Object.create(Object.getPrototypeOf(t)),Object.getOwnPropertyDescriptors(t))}var cu=function(t){return\'"\'+t.replace(/"/g,\'""\')+\'"\'},uu=function(t){let e=!1,r="\'";if(t==null||typeof t!="string")return"\'\'";for(let n=0;n<t.length;n++){let s=t[n];s==="\'"?r+=s+s:s==="\\\\"?(r+=s+s,e=!0):r+=s}return r+="\'",e===!0&&(r=" E"+r),r};Oi.exports={prepareValue:function(e){return Pt(e)},normalizeQueryConfig:ou,escapeIdentifier:cu,escapeLiteral:uu}});var Gr=E((cd,Li)=>{"use strict";var Bi=O("crypto");Li.exports={postgresMd5PasswordHash:hu,randomBytes:lu,deriveKey:mu,sha256:fu,hashByName:du,hmacSha256:pu,md5:jr};var Pi=Bi.webcrypto||globalThis.crypto,_e=Pi.subtle,Fr=new TextEncoder;function lu(t){return Pi.getRandomValues(Buffer.alloc(t))}async function jr(t){try{return Bi.createHash("md5").update(t,"utf-8").digest("hex")}catch{let r=typeof t=="string"?Fr.encode(t):t,n=await _e.digest("MD5",r);return Array.from(new Uint8Array(n)).map(s=>s.toString(16).padStart(2,"0")).join("")}}async function hu(t,e,r){let n=await jr(e+t);return"md5"+await jr(Buffer.concat([Buffer.from(n),r]))}async function fu(t){return await _e.digest("SHA-256",t)}async function du(t,e){return await _e.digest(t,e)}async function pu(t,e){let r=await _e.importKey("raw",t,{name:"HMAC",hash:"SHA-256"},!1,["sign"]);return await _e.sign("HMAC",r,Fr.encode(e))}async function mu(t,e,r){let n=await _e.importKey("raw",Fr.encode(t),"PBKDF2",!1,["deriveBits"]),s={name:"PBKDF2",hash:"SHA-256",salt:e,iterations:r};return await _e.deriveBits(s,n,256,["deriveBits"])}});var qi=E((ud,Mi)=>{"use strict";function Ae(t,e){return new Error("SASL channel binding: "+t+" when parsing public certificate "+e.toString("base64"))}function Vr(t,e){let r=t[e++];if(r<128)return{length:r,index:e};let n=r&127;if(n>4)throw Ae("bad length",t);r=0;for(let s=0;s<n;s++)r=r<<8|t[e++];return{length:r,index:e}}function Di(t,e){if(t[e++]!==6)throw Ae("non-OID data",t);let{length:r,index:n}=Vr(t,e);e=n;let s=e+r,i=t[e++],o=(i/40>>0)+"."+i%40;for(;e<s;){let a=0;for(;e<s;){let c=t[e++];if(a=a<<7|c&127,c<128)break}o+="."+a}return{oid:o,index:e}}function at(t,e){if(t[e++]!==48)throw Ae("non-sequence data",t);return Vr(t,e)}function yu(t,e){e===void 0&&(e=0),e=at(t,e).index;let{length:r,index:n}=at(t,e);e=n+r,e=at(t,e).index;let{oid:s,index:i}=Di(t,e);switch(s){case"1.2.840.113549.1.1.4":return"MD5";case"1.2.840.113549.1.1.5":return"SHA-1";case"1.2.840.113549.1.1.11":return"SHA-256";case"1.2.840.113549.1.1.12":return"SHA-384";case"1.2.840.113549.1.1.13":return"SHA-512";case"1.2.840.113549.1.1.14":return"SHA-224";case"1.2.840.113549.1.1.15":return"SHA512-224";case"1.2.840.113549.1.1.16":return"SHA512-256";case"1.2.840.10045.4.1":return"SHA-1";case"1.2.840.10045.4.3.1":return"SHA-224";case"1.2.840.10045.4.3.2":return"SHA-256";case"1.2.840.10045.4.3.3":return"SHA-384";case"1.2.840.10045.4.3.4":return"SHA-512";case"1.2.840.113549.1.1.10":{if(e=i,e=at(t,e).index,t[e++]!==160)throw Ae("non-tag data",t);e=Vr(t,e).index,e=at(t,e).index;let{oid:o}=Di(t,e);switch(o){case"1.2.840.113549.2.5":return"MD5";case"1.3.14.3.2.26":return"SHA-1";case"2.16.840.1.101.3.4.2.1":return"SHA-256";case"2.16.840.1.101.3.4.2.2":return"SHA-384";case"2.16.840.1.101.3.4.2.3":return"SHA-512"}throw Ae("unknown hash OID "+o,t)}case"1.3.101.110":case"1.3.101.112":return"SHA-512";case"1.3.101.111":case"1.3.101.113":throw Ae("Ed448 certificate channel binding is not currently supported by Postgres")}throw Ae("unknown OID "+s,t)}Mi.exports={signatureAlgorithmHashFromCertificate:yu}});var Qi=E((ld,Hi)=>{"use strict";var be=Gr(),{signatureAlgorithmHashFromCertificate:gu}=qi();function bu(t){let e=/[\\u00A0\\u1680\\u2000-\\u200B\\u202F\\u205F\\u3000]/g,r=/[\\u00AD\\u034F\\u1806\\u180B\\u180C\\u180D\\u200C\\u200D\\u2060\\uFE00-\\uFE0F\\uFEFF]/g;return t.replace(e," ").replace(r,"").normalize("NFKC")}var Kr=1e5;function wu(t,e,r=Kr){let n=["SCRAM-SHA-256"];e&&n.unshift("SCRAM-SHA-256-PLUS");let s=n.find(a=>t.includes(a));if(!s)throw new Error("SASL: Only mechanism(s) "+n.join(" and ")+" are supported");if(s==="SCRAM-SHA-256-PLUS"&&typeof e.getPeerCertificate!="function")throw new Error("SASL: Mechanism SCRAM-SHA-256-PLUS requires a certificate");let i=be.randomBytes(18).toString("base64");return{mechanism:s,clientNonce:i,response:(s==="SCRAM-SHA-256-PLUS"?"p=tls-server-end-point":e?"y":"n")+",,n=*,r="+i,message:"SASLInitialResponse",scramMaxIterations:r}}async function Eu(t,e,r,n){if(t.message!=="SASLInitialResponse")throw new Error("SASL: Last message was not SASLInitialResponse");if(typeof e!="string")throw new Error("SASL: SCRAM-SERVER-FIRST-MESSAGE: client password must be a string");if(e==="")throw new Error("SASL: SCRAM-SERVER-FIRST-MESSAGE: client password must be a non-empty string");if(typeof r!="string")throw new Error("SASL: SCRAM-SERVER-FIRST-MESSAGE: serverData must be a string");let s=vu(r);if(s.nonce.startsWith(t.clientNonce)){if(s.nonce.length===t.clientNonce.length)throw new Error("SASL: SCRAM-SERVER-FIRST-MESSAGE: server nonce is too short")}else throw new Error("SASL: SCRAM-SERVER-FIRST-MESSAGE: server nonce does not start with client nonce");let i=typeof t.scramMaxIterations=="number"?t.scramMaxIterations:Kr;if(i!==0&&s.iteration>i)throw new Error("SASL: SCRAM-SERVER-FIRST-MESSAGE: iteration count "+s.iteration+" exceeds scramMaxIterations of "+i);let o="n=*,r="+t.clientNonce,a="r="+s.nonce+",s="+s.salt+",i="+s.iteration,c=n?"eSws":"biws";if(t.mechanism==="SCRAM-SHA-256-PLUS"){let re=n.getPeerCertificate().raw,le=gu(re);(le==="MD5"||le==="SHA-1")&&(le="SHA-256");let Re=await be.hashByName(le,re);c=Buffer.concat([Buffer.from("p=tls-server-end-point,,"),Buffer.from(Re)]).toString("base64")}let u="c="+c+",r="+s.nonce,l=o+","+a+","+u,h=Buffer.from(s.salt,"base64"),f=await be.deriveKey(bu(e),h,s.iteration),p=await be.hmacSha256(f,"Client Key"),S=await be.sha256(p),y=await be.hmacSha256(S,l),P=Au(Buffer.from(p),Buffer.from(y)).toString("base64"),j=await be.hmacSha256(f,"Server Key"),ce=await be.hmacSha256(j,l);t.message="SASLResponse",t.serverSignature=Buffer.from(ce).toString("base64"),t.response=u+",p="+P}function xu(t,e){if(t.message!=="SASLResponse")throw new Error("SASL: Last message was not SASLResponse");if(typeof e!="string")throw new Error("SASL: SCRAM-SERVER-FINAL-MESSAGE: serverData must be a string");let{serverSignature:r}=_u(e);if(r!==t.serverSignature)throw new Error("SASL: SCRAM-SERVER-FINAL-MESSAGE: server signature does not match")}function Su(t){if(typeof t!="string")throw new TypeError("SASL: text must be a string");return t.split("").map((e,r)=>t.charCodeAt(r)).every(e=>e>=33&&e<=43||e>=45&&e<=126)}function $i(t){return/^(?:[a-zA-Z0-9+/]{4})*(?:[a-zA-Z0-9+/]{2}==|[a-zA-Z0-9+/]{3}=)?$/.test(t)}function Ui(t){if(typeof t!="string")throw new TypeError("SASL: attribute pairs text must be a string");return new Map(t.split(",").map(e=>{if(!/^.=/.test(e))throw new Error("SASL: Invalid attribute pair entry");let r=e[0],n=e.substring(2);return[r,n]}))}function vu(t){let e=Ui(t),r=e.get("r");if(r){if(!Su(r))throw new Error("SASL: SCRAM-SERVER-FIRST-MESSAGE: nonce must only contain printable characters")}else throw new Error("SASL: SCRAM-SERVER-FIRST-MESSAGE: nonce missing");let n=e.get("s");if(n){if(!$i(n))throw new Error("SASL: SCRAM-SERVER-FIRST-MESSAGE: salt must be base64")}else throw new Error("SASL: SCRAM-SERVER-FIRST-MESSAGE: salt missing");let s=e.get("i");if(s){if(!/^[1-9][0-9]*$/.test(s))throw new Error("SASL: SCRAM-SERVER-FIRST-MESSAGE: invalid iteration count")}else throw new Error("SASL: SCRAM-SERVER-FIRST-MESSAGE: iteration missing");let i=parseInt(s,10);return{nonce:r,salt:n,iteration:i}}function _u(t){let e=Ui(t),r=e.get("e"),n=e.get("v");if(r)throw new Error(`SASL: SCRAM-SERVER-FINAL-MESSAGE: server returned error: "${r}"`);if(n){if(!$i(n))throw new Error("SASL: SCRAM-SERVER-FINAL-MESSAGE: server signature must be base64")}else throw new Error("SASL: SCRAM-SERVER-FINAL-MESSAGE: server signature is missing");return{serverSignature:n}}function Au(t,e){if(!Buffer.isBuffer(t))throw new TypeError("first argument must be a Buffer");if(!Buffer.isBuffer(e))throw new TypeError("second argument must be a Buffer");if(t.length!==e.length)throw new Error("Buffer lengths must match");if(t.length===0)throw new Error("Buffers cannot be empty");return Buffer.from(t.map((r,n)=>t[n]^e[n]))}Hi.exports={startSession:wu,continueSession:Eu,finalizeSession:xu,DEFAULT_MAX_SCRAM_ITERATIONS:Kr}});var Dt=E((hd,zi)=>{"use strict";var Tu=it();function Lt(t){this._types=t||Tu,this.text={},this.binary={}}Lt.prototype.getOverrides=function(t){switch(t){case"text":return this.text;case"binary":return this.binary;default:return{}}};Lt.prototype.setTypeParser=function(t,e,r){typeof e=="function"&&(r=e,e="text"),this.getOverrides(e)[t]=r};Lt.prototype.getTypeParser=function(t,e){return e=e||"text",this.getOverrides(e)[t]||this._types.getTypeParser(t,e)};zi.exports=Lt});var Gi=E((fd,Fi)=>{"use strict";function qe(t,e={}){if(t.charAt(0)==="/"){let c=t.split(" ");return{host:c[0],database:c[1]}}let r=Object.create(null),n,s=!1;/ |%[^a-f0-9]|%[a-f0-9][^a-f0-9]/i.test(t)&&(t=encodeURI(t).replace(/%25(\\d\\d)/g,"%$1"));try{try{n=new URL(t,"postgres://base")}catch{n=new URL(t.replace("@/","@___DUMMY___/"),"postgres://base"),s=!0}}catch(c){throw c.input&&(c.input="*****REDACTED*****"),c}for(let c of n.searchParams.entries())r[c[0]]=c[1];if(r.user=r.user||decodeURIComponent(n.username),r.password=r.password||decodeURIComponent(n.password),n.protocol=="socket:")return r.host=decodeURI(n.pathname),r.database=n.searchParams.get("db"),r.client_encoding=n.searchParams.get("encoding"),r;let i=(s?"":n.hostname).replace(/^\\[(.+)\\]$/,"$1");r.host?i&&/^%2f/i.test(i)&&(n.pathname=i+n.pathname):r.host=decodeURIComponent(i),r.port||(r.port=n.port);let o=n.pathname.slice(1)||null;r.database=o?decodeURI(o):null,(r.ssl==="true"||r.ssl==="1")&&(r.ssl=!0),r.ssl==="0"&&(r.ssl=!1),(r.sslcert||r.sslkey||r.sslrootcert||r.sslmode)&&(r.ssl={}),r.sslnegotiation==="direct"&&r.ssl===void 0&&(r.ssl=!0);let a=r.sslcert||r.sslkey||r.sslrootcert?O("fs"):null;if(r.sslcert&&(r.ssl.cert=a.readFileSync(r.sslcert).toString()),r.sslkey&&(r.ssl.key=a.readFileSync(r.sslkey).toString()),r.sslrootcert&&(r.ssl.ca=a.readFileSync(r.sslrootcert).toString()),e.useLibpqCompat&&r.uselibpqcompat)throw new Error("Both useLibpqCompat and uselibpqcompat are set. Please use only one of them.");if(r.uselibpqcompat==="true"||e.useLibpqCompat)switch(r.sslmode){case"disable":{r.ssl=!1;break}case"prefer":{r.ssl.rejectUnauthorized=!1;break}case"require":{r.sslrootcert?r.ssl.checkServerIdentity=function(){}:r.ssl.rejectUnauthorized=!1;break}case"verify-ca":{if(!r.ssl.ca)throw new Error("SECURITY WARNING: Using sslmode=verify-ca requires specifying a CA with sslrootcert. If a public CA is used, verify-ca allows connections to a server that somebody else may have registered with the CA, making you vulnerable to Man-in-the-Middle attacks. Either specify a custom CA certificate with sslrootcert parameter or use sslmode=verify-full for proper security.");r.ssl.checkServerIdentity=function(){};break}case"verify-full":break}else switch(r.sslmode){case"disable":{r.ssl=!1;break}case"prefer":case"require":case"verify-ca":case"verify-full":{r.sslmode!=="verify-full"&&Yr(r.sslmode);break}case"no-verify":{r.ssl.rejectUnauthorized=!1;break}}return r}function Ru(t){return Object.entries(t).reduce((r,[n,s])=>(s!=null&&(r[n]=s),r),Object.create(null))}function ji(t){return Object.entries(t).reduce((r,[n,s])=>{if(n==="ssl"){let i=s;typeof i=="boolean"&&(r[n]=i),typeof i=="object"&&(r[n]=Ru(i))}else if(s!=null)if(n==="port"){if(s!==""){let i=parseInt(s,10);if(isNaN(i))throw new Error(`Invalid ${n}: ${s}`);r[n]=i}}else r[n]=s;return r},Object.create(null))}function ku(t){return ji(qe(t))}function Yr(t){!Yr.warned&&typeof process<"u"&&process.emitWarning&&(Yr.warned=!0,process.emitWarning(`SECURITY WARNING: The SSL modes \'prefer\', \'require\', and \'verify-ca\' are treated as aliases for \'verify-full\'.\nIn the next major version (pg-connection-string v3.0.0 and pg v9.0.0), these modes will adopt standard libpq semantics, which have weaker security guarantees.\n\nTo prepare for this change:\n- If you want the current behavior, explicitly use \'sslmode=verify-full\'\n- If you want libpq compatibility now, use \'uselibpqcompat=true&sslmode=${t}\'\n\nSee https://www.postgresql.org/docs/current/libpq-ssl.html for libpq SSL mode definitions.`))}Fi.exports=qe;qe.parse=qe;qe.toClientConfig=ji;qe.parseIntoClientConfig=ku});var Zr=E((dd,Yi)=>{"use strict";var Iu=O("dns"),Ki=ot(),Vi=Gi().parse,G=function(t,e,r){return e[t]?e[t]:(r===void 0?r=process.env["PG"+t.toUpperCase()]:r===!1||(r=process.env[r]),r||Ki[t])},Cu=function(){switch(process.env.PGSSLMODE){case"disable":return!1;case"prefer":case"require":case"verify-ca":case"verify-full":return!0;case"no-verify":return{rejectUnauthorized:!1}}return Ki.ssl},$e=function(t){return"\'"+(""+t).replace(/\\\\/g,"\\\\\\\\").replace(/\'/g,"\\\\\'")+"\'"},Z=function(t,e,r){let n=e[r];n!=null&&t.push(r+"="+$e(n))},Wr=class{constructor(e){if(e=typeof e=="string"?Vi(e):e||{},e.connectionString&&(e=Object.assign({},e,Vi(e.connectionString))),this.user=G("user",e),this.database=G("database",e),this.database===void 0&&(this.database=this.user),this.port=parseInt(G("port",e),10),this.host=G("host",e),Object.defineProperty(this,"password",{configurable:!0,enumerable:!1,writable:!0,value:G("password",e)}),this.binary=G("binary",e),this.options=G("options",e),this.ssl=typeof e.ssl>"u"?Cu():e.ssl,typeof this.ssl=="string"&&this.ssl==="true"&&(this.ssl=!0),this.ssl==="no-verify"&&(this.ssl={rejectUnauthorized:!1}),this.ssl&&this.ssl.key&&Object.defineProperty(this.ssl,"key",{enumerable:!1}),this.sslnegotiation=G("sslnegotiation",e,"PGSSLNEGOTIATION"),this.sslnegotiation!==void 0&&this.sslnegotiation!=="postgres"&&this.sslnegotiation!=="direct")throw new Error(`Invalid sslnegotiation value: "${this.sslnegotiation}". Valid values are "postgres" and "direct".`);if(this.sslnegotiation==="direct"&&!this.ssl)throw new Error("sslnegotiation=direct requires SSL to be enabled");this.client_encoding=G("client_encoding",e),this.replication=G("replication",e),this.isDomainSocket=!(this.host||"").indexOf("/"),this.application_name=G("application_name",e,"PGAPPNAME"),this.fallback_application_name=G("fallback_application_name",e,!1),this.statement_timeout=G("statement_timeout",e,!1),this.lock_timeout=G("lock_timeout",e,!1),this.idle_in_transaction_session_timeout=G("idle_in_transaction_session_timeout",e,!1),this.query_timeout=G("query_timeout",e,!1),e.connectionTimeoutMillis===void 0?this.connect_timeout=process.env.PGCONNECT_TIMEOUT||0:this.connect_timeout=Math.floor(e.connectionTimeoutMillis/1e3),e.keepAlive===!1?this.keepalives=0:e.keepAlive===!0&&(this.keepalives=1),typeof e.keepAliveInitialDelayMillis=="number"&&(this.keepalives_idle=Math.floor(e.keepAliveInitialDelayMillis/1e3))}getLibpqConnectionString(e){let r=[];Z(r,this,"user"),Z(r,this,"password"),Z(r,this,"port"),Z(r,this,"application_name"),Z(r,this,"fallback_application_name"),Z(r,this,"connect_timeout"),Z(r,this,"options");let n=typeof this.ssl=="object"?this.ssl:this.ssl?{sslmode:this.ssl}:{};if(Z(r,n,"sslmode"),Z(r,n,"sslca"),Z(r,n,"sslkey"),Z(r,n,"sslcert"),Z(r,n,"sslrootcert"),Z(r,this,"sslnegotiation"),this.database&&r.push("dbname="+$e(this.database)),this.replication&&r.push("replication="+$e(this.replication)),this.host&&r.push("host="+$e(this.host)),this.isDomainSocket)return e(null,r.join(" "));this.client_encoding&&r.push("client_encoding="+$e(this.client_encoding)),Iu.lookup(this.host,function(s,i){return s?e(s,null):(r.push("hostaddr="+$e(i)),e(null,r.join(" ")))})}};Yi.exports=Wr});var Jr=E((pd,Zi)=>{"use strict";var Nu=it(),Wi=/^([A-Za-z]+)(?: (\\d+))?(?: (\\d+))?/,Xr=class{constructor(e,r){this.command=null,this.rowCount=null,this.oid=null,this.rows=[],this.fields=[],this._parsers=void 0,this._types=r,this.RowCtor=null,this.rowAsArray=e==="array",this.rowAsArray&&(this.parseRow=this._parseRowAsArray),this._prebuiltEmptyResultObject=null}addCommandComplete(e){let r;e.text?r=Wi.exec(e.text):r=Wi.exec(e.command),r&&(this.command=r[1],r[3]?(this.oid=parseInt(r[2],10),this.rowCount=parseInt(r[3],10)):r[2]&&(this.rowCount=parseInt(r[2],10)))}_parseRowAsArray(e){let r=new Array(e.length);for(let n=0,s=e.length;n<s;n++){let i=e[n];i!==null?r[n]=this._parsers[n](i):r[n]=null}return r}parseRow(e){let r={...this._prebuiltEmptyResultObject};for(let n=0,s=e.length;n<s;n++){let i=e[n],o=this.fields[n].name;if(i!==null){let a=this.fields[n].format==="binary"?Buffer.from(i):i;r[o]=this._parsers[n](a)}else r[o]=null}return r}addRow(e){this.rows.push(e)}addFields(e){this.fields=e,this.fields.length&&(this._parsers=new Array(e.length));let r=Object.create(null);for(let n=0;n<e.length;n++){let s=e[n];r[s.name]=null,this._types?this._parsers[n]=this._types.getTypeParser(s.dataTypeID,s.format||"text"):this._parsers[n]=Nu.getTypeParser(s.dataTypeID,s.format||"text")}this._prebuiltEmptyResultObject={...r}}};Zi.exports=Xr});var to=E((md,eo)=>{"use strict";var{EventEmitter:Ou}=O("events"),Xi=Jr(),Ji=ve(),en=class extends Ou{constructor(e,r,n){super(),e=Ji.normalizeQueryConfig(e,r,n),this.text=e.text,this.values=e.values,this.rows=e.rows,this.types=e.types,this.name=e.name,this.queryMode=e.queryMode,this.binary=e.binary,this.portal=e.portal||"",this.callback=e.callback,this._rowMode=e.rowMode,process.domain&&e.callback&&(this.callback=process.domain.bind(e.callback)),this._result=new Xi(this._rowMode,this.types),this._results=this._result,this._canceledDueToError=!1}requiresPreparation(){return this.queryMode==="extended"||this.name||this.rows?!0:!this.text||!this.values?!1:this.values.length>0}_checkForMultirow(){this._result.command&&(Array.isArray(this._results)||(this._results=[this._result]),this._result=new Xi(this._rowMode,this._result._types),this._results.push(this._result))}handleRowDescription(e){this._checkForMultirow(),this._result.addFields(e.fields),this._accumulateRows=this.callback||!this.listeners("row").length}handleDataRow(e){let r;if(!this._canceledDueToError){try{r=this._result.parseRow(e.fields)}catch(n){this._canceledDueToError=n;return}this.emit("row",r,this._result),this._accumulateRows&&this._result.addRow(r)}}handleCommandComplete(e,r){this._checkForMultirow(),this._result.addCommandComplete(e),this.rows&&r.sync()}handleEmptyQuery(e){this.rows&&e.sync()}handleError(e,r){if(this._canceledDueToError&&(e=this._canceledDueToError,this._canceledDueToError=!1),this.callback)return this.callback(e);this.emit("error",e)}handleReadyForQuery(e){if(this._canceledDueToError)return this.handleError(this._canceledDueToError,e);if(this.callback)try{this.callback(null,this._results)}catch(r){process.nextTick(()=>{throw r})}this.emit("end",this._results)}submit(e){if(typeof this.text!="string"&&typeof this.name!="string")return new Error("A query must have either text or a name. Supplying neither is unsupported.");let r=e.parsedStatements[this.name]||e.submittedNamedStatements[this.name];if(this.text&&r&&this.text!==r)return new Error(`Prepared statements must be unique - \'${this.name}\' was used for a different statement`);if(this.values&&!Array.isArray(this.values))return new Error("Query values must be an array");if(this.requiresPreparation()){e.stream.cork&&e.stream.cork();try{this.prepare(e)}finally{e.stream.uncork&&e.stream.uncork()}}else e.query(this.text);return null}hasBeenParsed(e){return this.name&&(e.parsedStatements[this.name]!==void 0||e.submittedNamedStatements[this.name]!==void 0)}handlePortalSuspended(e){this._getRows(e,this.rows)}_getRows(e,r){e.execute({portal:this.portal,rows:r}),r?e.flush():e.sync()}prepare(e){this.hasBeenParsed(e)||(e.parse({text:this.text,name:this.name,types:this.types}),this.name&&(e.submittedNamedStatements[this.name]=this.text));try{e.bind({portal:this.portal,statement:this.name,values:this.values,binary:this.binary,valueMapper:Ji.prepareValue})}catch(r){e.close({type:"S",name:this.name}),e.sync(),this.handleError(r,e);return}e.describe({type:"P",name:this.portal||""}),this._getRows(e,this.rows)}handleCopyInResponse(e){e.sendCopyFail("No source stream defined")}handleCopyData(e,r){}};eo.exports=en});var yn=E(g=>{"use strict";Object.defineProperty(g,"__esModule",{value:!0});g.NoticeMessage=g.DataRowMessage=g.CommandCompleteMessage=g.ReadyForQueryMessage=g.NotificationResponseMessage=g.BackendKeyDataMessage=g.AuthenticationMD5Password=g.ParameterStatusMessage=g.ParameterDescriptionMessage=g.RowDescriptionMessage=g.Field=g.CopyResponse=g.CopyDataMessage=g.DatabaseError=g.copyDone=g.emptyQuery=g.replicationStart=g.portalSuspended=g.noData=g.closeComplete=g.bindComplete=g.parseComplete=void 0;g.parseComplete={name:"parseComplete",length:5};g.bindComplete={name:"bindComplete",length:5};g.closeComplete={name:"closeComplete",length:5};g.noData={name:"noData",length:5};g.portalSuspended={name:"portalSuspended",length:5};g.replicationStart={name:"replicationStart",length:4};g.emptyQuery={name:"emptyQuery",length:4};g.copyDone={name:"copyDone",length:4};var tn=class extends Error{constructor(e,r,n){super(e),this.length=r,this.name=n}};g.DatabaseError=tn;var rn=class{constructor(e,r){this.length=e,this.chunk=r,this.name="copyData"}};g.CopyDataMessage=rn;var nn=class{constructor(e,r,n,s){this.length=e,this.name=r,this.binary=n,this.columnTypes=new Array(s)}};g.CopyResponse=nn;var sn=class{constructor(e,r,n,s,i,o,a){this.name=e,this.tableID=r,this.columnID=n,this.dataTypeID=s,this.dataTypeSize=i,this.dataTypeModifier=o,this.format=a}};g.Field=sn;var on=class{constructor(e,r){this.length=e,this.fieldCount=r,this.name="rowDescription",this.fields=new Array(this.fieldCount)}};g.RowDescriptionMessage=on;var an=class{constructor(e,r){this.length=e,this.parameterCount=r,this.name="parameterDescription",this.dataTypeIDs=new Array(this.parameterCount)}};g.ParameterDescriptionMessage=an;var cn=class{constructor(e,r,n){this.length=e,this.parameterName=r,this.parameterValue=n,this.name="parameterStatus"}};g.ParameterStatusMessage=cn;var un=class{constructor(e,r){this.length=e,this.salt=r,this.name="authenticationMD5Password"}};g.AuthenticationMD5Password=un;var ln=class{constructor(e,r,n){this.length=e,this.processID=r,this.secretKey=n,this.name="backendKeyData"}};g.BackendKeyDataMessage=ln;var hn=class{constructor(e,r,n,s){this.length=e,this.processId=r,this.channel=n,this.payload=s,this.name="notification"}};g.NotificationResponseMessage=hn;var fn=class{constructor(e,r){this.length=e,this.status=r,this.name="readyForQuery"}};g.ReadyForQueryMessage=fn;var dn=class{constructor(e,r){this.length=e,this.text=r,this.name="commandComplete"}};g.CommandCompleteMessage=dn;var pn=class{constructor(e,r){this.length=e,this.fields=r,this.name="dataRow",this.fieldCount=r.length}};g.DataRowMessage=pn;var mn=class{constructor(e,r){this.length=e,this.message=r,this.name="notice"}};g.NoticeMessage=mn});var ro=E(Mt=>{"use strict";Object.defineProperty(Mt,"__esModule",{value:!0});Mt.Writer=void 0;var gn=class{constructor(e=256){this.size=e,this.offset=5,this.headerPosition=0,this.buffer=Buffer.allocUnsafe(e)}ensure(e){if(this.buffer.length-this.offset<e){let n=this.buffer,s=n.length+(n.length>>1)+e;this.buffer=Buffer.allocUnsafe(s),n.copy(this.buffer,0,0,this.offset)}}addInt32(e){return this.ensure(4),this.buffer[this.offset++]=e>>>24&255,this.buffer[this.offset++]=e>>>16&255,this.buffer[this.offset++]=e>>>8&255,this.buffer[this.offset++]=e>>>0&255,this}addInt16(e){return this.ensure(2),this.buffer[this.offset++]=e>>>8&255,this.buffer[this.offset++]=e>>>0&255,this}addCString(e){if(!e)this.ensure(1);else{let r=Buffer.byteLength(e);this.ensure(r+1),this.buffer.write(e,this.offset,"utf-8"),this.offset+=r}return this.buffer[this.offset++]=0,this}addString(e=""){let r=Buffer.byteLength(e);return this.ensure(r),this.buffer.write(e,this.offset),this.offset+=r,this}addInt32PrefixedString(e){let r=Buffer.byteLength(e);this.ensure(4+r);let n=this.buffer,s=this.offset;return n[s++]=r>>>24&255,n[s++]=r>>>16&255,n[s++]=r>>>8&255,n[s++]=r>>>0&255,n.write(e,s,"utf-8"),this.offset=s+r,this}add(e){return this.ensure(e.length),e.copy(this.buffer,this.offset),this.offset+=e.length,this}reserveUnsafe(e){let r=this.offset;return this.ensure(e),this.offset+=e,r}join(e){if(e){this.buffer[this.headerPosition]=e;let r=this.offset-(this.headerPosition+1);this.buffer.writeInt32BE(r,this.headerPosition+1)}return this.buffer.slice(e?0:5,this.offset)}flush(e){let r=this.join(e);return this.offset=5,this.headerPosition=0,this.buffer=Buffer.allocUnsafe(this.size),r}clear(){this.offset=5,this.headerPosition=0}};Mt.Writer=gn});var io=E($t=>{"use strict";Object.defineProperty($t,"__esModule",{value:!0});$t.serialize=void 0;var no=ro(),I=new no.Writer,Bu=t=>{I.addInt16(3).addInt16(0);for(let n of Object.keys(t))I.addCString(n).addCString(t[n]);I.addCString("client_encoding").addCString("UTF8");let e=I.addCString("").flush(),r=e.length+4;return new no.Writer().addInt32(r).add(e).flush()},Pu=()=>{let t=Buffer.allocUnsafe(8);return t.writeInt32BE(8,0),t.writeInt32BE(80877103,4),t},Lu=t=>I.addCString(t).flush(112),Du=function(t,e){return I.addCString(t).addInt32PrefixedString(e),I.flush(112)},Mu=function(t){return I.addString(t).flush(112)},qu=t=>I.addCString(t).flush(81),so=[],$u=t=>{let e=t.name||"";e.length>63&&(console.error("Warning! Postgres only supports 63 characters for query names."),console.error("You supplied %s (%s)",e,e.length),console.error("This can cause conflicts and silent errors executing queries"));let r=t.types||so,n=r.length,s=I.addCString(e).addCString(t.text).addInt16(n);for(let i=0;i<n;i++)s.addInt32(r[i]);return I.flush(80)},Uu=function(t,e,r){let n=t.length;for(let s=0;s<n;s++){let i=e?e(t[s],s):t[s],o=0;i==null?I.addInt32(-1):i instanceof Buffer?(o=1,I.addInt32(i.length),I.add(i)):I.addInt32PrefixedString(i);let a=I.buffer;a[r++]=0,a[r++]=o}},Hu=(t={})=>{let e=t.portal||"",r=t.statement||"",n=t.binary||!1,s=t.values||so,i=s.length;I.addCString(e).addCString(r),I.addInt16(i);let o=I.reserveUnsafe(i*2);I.addInt16(i);try{Uu(s,t.valueMapper,o)}catch(a){throw I.clear(),a}return I.addInt16(1),I.addInt16(n?1:0),I.flush(66)},Qu=Buffer.from([69,0,0,0,9,0,0,0,0,0]),zu=t=>{if(!t||!t.portal&&!t.rows)return Qu;let e=t.portal||"",r=t.rows||0,n=Buffer.byteLength(e),s=4+n+1+4,i=Buffer.allocUnsafe(1+s);return i[0]=69,i.writeInt32BE(s,1),i.write(e,5,"utf-8"),i[n+5]=0,i.writeUInt32BE(r,i.length-4),i},ju=(t,e)=>{let r=Buffer.allocUnsafe(16);return r.writeInt32BE(16,0),r.writeInt16BE(1234,4),r.writeInt16BE(5678,6),r.writeInt32BE(t,8),r.writeInt32BE(e,12),r},bn=(t,e)=>{let n=4+Buffer.byteLength(e)+1,s=Buffer.allocUnsafe(1+n);return s[0]=t,s.writeInt32BE(n,1),s.write(e,5,"utf-8"),s[n]=0,s},Fu=I.addCString("P").flush(68),Gu=I.addCString("S").flush(68),Vu=t=>t.name?bn(68,`${t.type}${t.name||""}`):t.type==="P"?Fu:Gu,Ku=t=>{let e=`${t.type}${t.name||""}`;return bn(67,e)},Yu=t=>I.add(t).flush(100),Wu=t=>bn(102,t),qt=t=>Buffer.from([t,0,0,0,4]),Zu=qt(72),Xu=qt(83),Ju=qt(88),el=qt(99),tl={startup:Bu,password:Lu,requestSsl:Pu,sendSASLInitialResponseMessage:Du,sendSCRAMClientFinalMessage:Mu,query:qu,parse:$u,bind:Hu,execute:zu,describe:Vu,close:Ku,flush:()=>Zu,sync:()=>Xu,end:()=>Ju,copyData:Yu,copyDone:()=>el,copyFail:Wu,cancel:ju};$t.serialize=tl});var oo=E(Ut=>{"use strict";Object.defineProperty(Ut,"__esModule",{value:!0});Ut.BufferReader=void 0;var wn=class{constructor(e=0){this.offset=e,this.buffer=Buffer.allocUnsafe(0),this.encoding="utf-8"}setBuffer(e,r){this.offset=e,this.buffer=r}int16(){let e=this.buffer.readInt16BE(this.offset);return this.offset+=2,e}byte(){let e=this.buffer[this.offset];return this.offset++,e}int32(){let e=this.buffer.readInt32BE(this.offset);return this.offset+=4,e}uint32(){let e=this.buffer.readUInt32BE(this.offset);return this.offset+=4,e}string(e){let r=this.buffer.toString(this.encoding,this.offset,this.offset+e);return this.offset+=e,r}cstring(){let e=this.offset,r=e;for(;this.buffer[r++];);return this.offset=r,this.buffer.toString(this.encoding,e,r-1)}bytes(e){let r=this.buffer.slice(this.offset,this.offset+e);return this.offset+=e,r}};Ut.BufferReader=wn});var lo=E(Ht=>{"use strict";Object.defineProperty(Ht,"__esModule",{value:!0});Ht.Parser=void 0;var M=yn(),rl=oo(),xn=1,nl=4,ao=xn+nl,X=-1,En=Buffer.allocUnsafe(0),Sn=class{constructor(e){if(this.buffer=En,this.bufferLength=0,this.bufferOffset=0,this.reader=new rl.BufferReader,e?.mode==="binary")throw new Error("Binary mode not supported yet");this.mode=e?.mode||"text"}parse(e,r){this.mergeBuffer(e);let n=this.bufferOffset+this.bufferLength,s=this.bufferOffset;for(;s+ao<=n;){let i=this.buffer[s],o=this.buffer.readUInt32BE(s+xn),a=xn+o;if(a+s<=n){let c=this.handlePacket(s+ao,i,o,this.buffer);r(c),s+=a}else break}s===n?(this.buffer=En,this.bufferLength=0,this.bufferOffset=0):(this.bufferLength=n-s,this.bufferOffset=s)}mergeBuffer(e){if(this.bufferLength>0){let r=this.bufferLength+e.byteLength;if(r+this.bufferOffset>this.buffer.byteLength){let s;if(r<=this.buffer.byteLength&&this.bufferOffset>=this.bufferLength)s=this.buffer;else{let i=this.buffer.byteLength*2;for(;r>=i;)i*=2;s=Buffer.allocUnsafe(i)}this.buffer.copy(s,0,this.bufferOffset,this.bufferOffset+this.bufferLength),this.buffer=s,this.bufferOffset=0}e.copy(this.buffer,this.bufferOffset+this.bufferLength),this.bufferLength=r}else this.buffer=e,this.bufferOffset=0,this.bufferLength=e.byteLength}handlePacket(e,r,n,s){let{reader:i}=this;i.setBuffer(e,s);let o;switch(r){case 50:o=M.bindComplete;break;case 49:o=M.parseComplete;break;case 51:o=M.closeComplete;break;case 110:o=M.noData;break;case 115:o=M.portalSuspended;break;case 99:o=M.copyDone;break;case 87:o=M.replicationStart;break;case 73:o=M.emptyQuery;break;case 68:o=dl(i);break;case 67:o=il(i);break;case 90:o=sl(i);break;case 65:o=ul(i);break;case 82:o=yl(i,n);break;case 83:o=pl(i);break;case 75:o=ml(i);break;case 69:o=co(i,"error");break;case 78:o=co(i,"notice");break;case 84:o=ll(i);break;case 116:o=fl(i);break;case 71:o=al(i);break;case 72:o=cl(i);break;case 100:o=ol(i,n);break;default:return new M.DatabaseError("received invalid response: "+r.toString(16),n,"error")}return i.setBuffer(0,En),o.length=n,o}};Ht.Parser=Sn;var sl=t=>{let e=t.string(1);return new M.ReadyForQueryMessage(X,e)},il=t=>{let e=t.cstring();return new M.CommandCompleteMessage(X,e)},ol=(t,e)=>{let r=t.bytes(e-4);return new M.CopyDataMessage(X,r)},al=t=>uo(t,"copyInResponse"),cl=t=>uo(t,"copyOutResponse"),uo=(t,e)=>{let r=t.byte()!==0,n=t.int16(),s=new M.CopyResponse(X,e,r,n);for(let i=0;i<n;i++)s.columnTypes[i]=t.int16();return s},ul=t=>{let e=t.int32(),r=t.cstring(),n=t.cstring();return new M.NotificationResponseMessage(X,e,r,n)},ll=t=>{let e=t.int16(),r=new M.RowDescriptionMessage(X,e);for(let n=0;n<e;n++)r.fields[n]=hl(t);return r},hl=t=>{let e=t.cstring(),r=t.uint32(),n=t.int16(),s=t.uint32(),i=t.int16(),o=t.int32(),a=t.int16()===0?"text":"binary";return new M.Field(e,r,n,s,i,o,a)},fl=t=>{let e=t.int16(),r=new M.ParameterDescriptionMessage(X,e);for(let n=0;n<e;n++)r.dataTypeIDs[n]=t.uint32();return r},dl=t=>{let e=t.int16(),r=new Array(e);for(let n=0;n<e;n++){let s=t.int32();r[n]=s===-1?null:t.string(s)}return new M.DataRowMessage(X,r)},pl=t=>{let e=t.cstring(),r=t.cstring();return new M.ParameterStatusMessage(X,e,r)},ml=t=>{let e=t.int32(),r=t.int32();return new M.BackendKeyDataMessage(X,e,r)},yl=(t,e)=>{let r=t.int32(),n={name:"authenticationOk",length:e};switch(r){case 0:break;case 3:n.length===8&&(n.name="authenticationCleartextPassword");break;case 5:if(n.length===12){n.name="authenticationMD5Password";let s=t.bytes(4);return new M.AuthenticationMD5Password(X,s)}break;case 10:{n.name="authenticationSASL",n.mechanisms=[];let s;do s=t.cstring(),s&&n.mechanisms.push(s);while(s)}break;case 11:n.name="authenticationSASLContinue",n.data=t.string(e-8);break;case 12:n.name="authenticationSASLFinal",n.data=t.string(e-8);break;default:throw new Error("Unknown authenticationOk message type "+r)}return n},co=(t,e)=>{let r={},n=t.string(1);for(;n!=="\\0";)r[n]=t.cstring(),n=t.string(1);let s=r.M,i=e==="notice"?new M.NoticeMessage(X,s):new M.DatabaseError(s,X,e);return i.severity=r.S,i.code=r.C,i.detail=r.D,i.hint=r.H,i.position=r.P,i.internalPosition=r.p,i.internalQuery=r.q,i.where=r.W,i.schema=r.s,i.table=r.t,i.column=r.c,i.dataType=r.d,i.constraint=r.n,i.file=r.F,i.line=r.L,i.routine=r.R,i}});var vn=E(Te=>{"use strict";Object.defineProperty(Te,"__esModule",{value:!0});Te.DatabaseError=Te.serialize=void 0;Te.parse=El;var gl=yn();Object.defineProperty(Te,"DatabaseError",{enumerable:!0,get:function(){return gl.DatabaseError}});var bl=io();Object.defineProperty(Te,"serialize",{enumerable:!0,get:function(){return bl.serialize}});var wl=lo();function El(t,e){let r=new wl.Parser;return t.on("data",n=>r.parse(n,e)),new Promise(n=>t.on("end",()=>n()))}});var ho=E(_n=>{"use strict";Object.defineProperty(_n,"__esModule",{value:!0});_n.default={}});var po=E((vd,fo)=>{"use strict";var{getStream:xl,getSecureStream:Sl}=Tl();fo.exports={getStream:xl,getSecureStream:Sl};function vl(){function t(r){let n=O("net");return new n.Socket}function e(r){return O("tls").connect(r)}return{getStream:t,getSecureStream:e}}function _l(){function t(r){let{CloudflareSocket:n}=ho();return new n(r)}function e(r){return r.socket.startTls(r),r.socket}return{getStream:t,getSecureStream:e}}function Al(){if(typeof navigator=="object"&&navigator!==null&&typeof navigator.userAgent=="string")return navigator.userAgent==="Cloudflare-Workers";if(typeof Response=="function"){let t=new Response(null,{cf:{thing:!0}});if(typeof t.cf=="object"&&t.cf!==null&&t.cf.thing)return!0}return!1}function Tl(){return Al()?_l():vl()}});var Tn=E((_d,yo)=>{"use strict";var Rl=O("events").EventEmitter,{parse:kl,serialize:H}=vn(),mo=po(),{getStream:Il}=mo,Cl=H.flush(),Nl=H.sync(),Ol=H.end(),An=class extends Rl{constructor(e){super(),e=e||{},this.stream=e.stream||Il(e.ssl),typeof this.stream=="function"&&(this.stream=this.stream(e)),this._keepAlive=e.keepAlive,this._keepAliveInitialDelayMillis=e.keepAliveInitialDelayMillis,this.parsedStatements={},this.submittedNamedStatements={},this.ssl=e.ssl||!1,this.sslNegotiation=e.sslNegotiation||"postgres",this._ending=!1,this._emitMessage=!1;let r=this;this.on("newListener",function(n){n==="message"&&(r._emitMessage=!0)})}connect(e,r){let n=this;this._connecting=!0,this.stream.setNoDelay(!0),this.stream.connect(e,r),this.stream.once("connect",function(){n._keepAlive&&n.stream.setKeepAlive(!0,n._keepAliveInitialDelayMillis),n.emit("connect")});let s=function(i){n._ending&&(i.code==="ECONNRESET"||i.code==="EPIPE")||n.emit("error",i)};if(this.stream.on("error",s),this.stream.on("close",function(){n.emit("end")}),!this.ssl)return this.attachListeners(this.stream);if(this.sslNegotiation==="direct")return this.stream.once("connect",function(){n.upgradeToSSL(r,s)});this.stream.once("data",function(i){switch(i.toString("utf8")){case"S":break;case"N":return n.stream.end(),n.emit("error",new Error("The server does not support SSL connections"));default:return n.stream.end(),n.emit("error",new Error("There was an error establishing an SSL connection"))}n.upgradeToSSL(r,s)})}upgradeToSSL(e,r){let n=this,s={socket:n.stream,host:e};n.ssl!==!0&&(Object.assign(s,n.ssl),"key"in n.ssl&&(s.key=n.ssl.key)),n.sslNegotiation==="direct"&&(s.ALPNProtocols=["postgresql"]);let i=O("net");i.isIP&&i.isIP(e)===0&&(s.servername=e);try{n.stream=mo.getSecureStream(s)}catch(o){return n.emit("error",o)}n.attachListeners(n.stream),n.stream.on("error",r),n.emit("sslconnect")}attachListeners(e){kl(e,r=>{let n=r.name==="error"?"errorMessage":r.name;this._emitMessage&&this.emit("message",r),this.emit(n,r)})}requestSsl(){this.stream.write(H.requestSsl())}startup(e){this.stream.write(H.startup(e))}cancel(e,r){this._send(H.cancel(e,r))}password(e){this._send(H.password(e))}sendSASLInitialResponseMessage(e,r){this._send(H.sendSASLInitialResponseMessage(e,r))}sendSCRAMClientFinalMessage(e){this._send(H.sendSCRAMClientFinalMessage(e))}_send(e){return this.stream.writable?this.stream.write(e):!1}query(e){this._send(H.query(e))}parse(e){this._send(H.parse(e))}bind(e){this._send(H.bind(e))}execute(e){this._send(H.execute(e))}flush(){this.stream.writable&&this.stream.write(Cl)}sync(){this._send(Nl)}ref(){this.stream.ref()}unref(){this.stream.unref()}end(){if(this._ending=!0,!this._connecting||!this.stream.writable){this.stream.end();return}return this.stream.write(Ol,()=>{this.stream.end()})}close(e){this._send(H.close(e))}describe(e){this._send(H.describe(e))}sendCopyFromChunk(e){this._send(H.copyData(e))}endCopyFrom(){this._send(H.copyDone())}sendCopyFail(e){this._send(H.copyFail(e))}};yo.exports=An});var Eo=E((Ad,wo)=>{"use strict";var{Transform:Bl}=O("stream"),{StringDecoder:Pl}=O("string_decoder"),we=Symbol("last"),Qt=Symbol("decoder");function Ll(t,e,r){let n;if(this.overflow){if(n=this[Qt].write(t).split(this.matcher),n.length===1)return r();n.shift(),this.overflow=!1}else this[we]+=this[Qt].write(t),n=this[we].split(this.matcher);this[we]=n.pop();for(let s=0;s<n.length;s++)try{bo(this,this.mapper(n[s]))}catch(i){return r(i)}if(this.overflow=this[we].length>this.maxLength,this.overflow&&!this.skipOverflow){r(new Error("maximum buffer reached"));return}r()}function Dl(t){if(this[we]+=this[Qt].end(),this[we])try{bo(this,this.mapper(this[we]))}catch(e){return t(e)}t()}function bo(t,e){e!==void 0&&t.push(e)}function go(t){return t}function Ml(t,e,r){switch(t=t||/\\r?\\n/,e=e||go,r=r||{},arguments.length){case 1:typeof t=="function"?(e=t,t=/\\r?\\n/):typeof t=="object"&&!(t instanceof RegExp)&&!t[Symbol.split]&&(r=t,t=/\\r?\\n/);break;case 2:typeof t=="function"?(r=e,e=t,t=/\\r?\\n/):typeof e=="object"&&(r=e,e=go)}r=Object.assign({},r),r.autoDestroy=!0,r.transform=Ll,r.flush=Dl,r.readableObjectMode=!0;let n=new Bl(r);return n[we]="",n[Qt]=new Pl("utf8"),n.matcher=t,n.mapper=e,n.maxLength=r.maxLength,n.skipOverflow=r.skipOverflow||!1,n.overflow=!1,n._destroy=function(s,i){this._writableState.errorEmitted=!1,i(s)},n}wo.exports=Ml});var vo=E((Td,me)=>{"use strict";var xo=O("path"),ql=O("stream").Stream,$l=Eo(),So=O("util"),Ul=5432,zt=process.platform==="win32",ct=process.stderr,Hl=56,Ql=7,zl=61440,jl=32768;function Fl(t){return(t&zl)==jl}var Ue=["host","port","database","user","password"],Rn=Ue.length,Gl=Ue[Rn-1];function kn(){var t=ct instanceof ql&&ct.writable===!0;if(t){var e=Array.prototype.slice.call(arguments).concat(`\n`);ct.write(So.format.apply(So,e))}}Object.defineProperty(me.exports,"isWin",{get:function(){return zt},set:function(t){zt=t}});me.exports.warnTo=function(t){var e=ct;return ct=t,e};me.exports.getFileName=function(t){var e=t||process.env,r=e.PGPASSFILE||(zt?xo.join(e.APPDATA||"./","postgresql","pgpass.conf"):xo.join(e.HOME||"./",".pgpass"));return r};me.exports.usePgPass=function(t,e){return Object.prototype.hasOwnProperty.call(process.env,"PGPASSWORD")?!1:zt?!0:(e=e||"<unkn>",Fl(t.mode)?t.mode&(Hl|Ql)?(kn(\'WARNING: password file "%s" has group or world access; permissions should be u=rw (0600) or less\',e),!1):!0:(kn(\'WARNING: password file "%s" is not a plain file\',e),!1))};var Vl=me.exports.match=function(t,e){return Ue.slice(0,-1).reduce(function(r,n,s){return s==1&&Number(t[n]||Ul)===Number(e[n])?r&&!0:r&&(e[n]==="*"||e[n]===t[n])},!0)};me.exports.getPassword=function(t,e,r){var n,s=e.pipe($l());function i(c){var u=Kl(c);u&&Yl(u)&&Vl(t,u)&&(n=u[Gl],s.end())}var o=function(){e.destroy(),r(n)},a=function(c){e.destroy(),kn("WARNING: error on reading file: %s",c),r(void 0)};e.on("error",a),s.on("data",i).on("end",o).on("error",a)};var Kl=me.exports.parseLine=function(t){if(t.length<11||t.match(/^\\s+#/))return null;for(var e="",r="",n=0,s=0,i=0,o={},a=!1,c=function(l,h,f){var p=t.substring(h,f);Object.hasOwnProperty.call(process.env,"PGPASS_NO_DEESCAPE")||(p=p.replace(/\\\\([:\\\\])/g,"$1")),o[Ue[l]]=p},u=0;u<t.length-1;u+=1){if(e=t.charAt(u+1),r=t.charAt(u),a=n==Rn-1,a){c(n,s);break}u>=0&&e==":"&&r!=="\\\\"&&(c(n,s,u+1),s=u+2,n+=1)}return o=Object.keys(o).length===Rn?o:null,o},Yl=me.exports.isValidEntry=function(t){for(var e={0:function(o){return o.length>0},1:function(o){return o==="*"?!0:(o=Number(o),isFinite(o)&&o>0&&o<9007199254740992&&Math.floor(o)===o)},2:function(o){return o.length>0},3:function(o){return o.length>0},4:function(o){return o.length>0}},r=0;r<Ue.length;r+=1){var n=e[r],s=t[Ue[r]]||"",i=n(s);if(!i)return!1}return!0}});var Ao=E((kd,In)=>{"use strict";var Rd=O("path"),_o=O("fs"),jt=vo();In.exports=function(t,e){var r=jt.getFileName();_o.stat(r,function(n,s){if(n||!jt.usePgPass(s,r))return e(void 0);var i=_o.createReadStream(r);jt.getPassword(t,i,e)})};In.exports.warnTo=jt.warnTo});var Io=E((Id,ko)=>{"use strict";var Wl=O("events").EventEmitter,To=ve(),ut=O("util"),Ft=Qi(),Zl=Dt(),Xl=Zr(),Cn=to(),Jl=ot(),eh=Tn(),th=Gr(),Ro=ut.deprecate(()=>{},"Client.activeQuery is deprecated and will be removed in pg@9.0"),rh=ut.deprecate(()=>{},"Client.queryQueue is deprecated and will be removed in pg@9.0."),nh=ut.deprecate(()=>{},"pgpass support is deprecated and will be removed in pg@9.0. You can provide an async function as the password property to the Client/Pool constructor that returns a password instead. Within this function you can call the pgpass module in your own code."),sh=ut.deprecate(()=>{},"Passing a custom Promise implementation to the Client/Pool constructor is deprecated and will be removed in pg@9.0."),ih=ut.deprecate(()=>{},"Calling client.query() when the client is already executing a query is deprecated and will be removed in pg@9.0. Use async/await or an external async flow control mechanism instead.");function oh(t,e){if(typeof t=="number")return Number.isFinite(t)?t:e;if(typeof t=="string"&&t.trim()!==""){let r=Number(t);return Number.isFinite(r)?r:e}return e}var Gt=class extends Wl{constructor(e){super(),this.connectionParameters=new Xl(e),this.user=this.connectionParameters.user,this.database=this.connectionParameters.database,this.port=this.connectionParameters.port,this.host=this.connectionParameters.host,Object.defineProperty(this,"password",{configurable:!0,enumerable:!1,writable:!0,value:this.connectionParameters.password}),this.replication=this.connectionParameters.replication;let r=e||{};r.Promise&&sh(),this._Promise=r.Promise||global.Promise,this._types=new Zl(r.types),this._ending=!1,this._ended=!1,this._connecting=!1,this._connected=!1,this._connectionError=!1,this._queryable=!0,this._activeQuery=null,this._txStatus=null,this.enableChannelBinding=!!r.enableChannelBinding,this.scramMaxIterations=oh(r.scramMaxIterations,Ft.DEFAULT_MAX_SCRAM_ITERATIONS),this.connection=r.connection||new eh({stream:r.stream,ssl:this.connectionParameters.ssl,sslNegotiation:this.connectionParameters.sslnegotiation,keepAlive:r.keepAlive||!1,keepAliveInitialDelayMillis:r.keepAliveInitialDelayMillis||0,encoding:this.connectionParameters.client_encoding||"utf8"}),this._queryQueue=[],this._sentQueryQueue=[],this.pipeline=!!r.pipeline,this.binary=r.binary||Jl.binary,this.processID=null,this.secretKey=null,this.ssl=this.connectionParameters.ssl||!1,this.sslNegotiation=this.connectionParameters.sslnegotiation||"postgres",this.ssl&&this.ssl.key&&Object.defineProperty(this.ssl,"key",{enumerable:!1}),this._connectionTimeoutMillis=r.connectionTimeoutMillis||0}get activeQuery(){return Ro(),this._activeQuery}set activeQuery(e){Ro(),this._activeQuery=e}_getActiveQuery(){return this._activeQuery}_errorAllQueries(e){let r=s=>{process.nextTick(()=>{s.handleError(e,this.connection)})},n=this._getActiveQuery();n&&(r(n),this._activeQuery=null),this._sentQueryQueue.forEach(r),this._sentQueryQueue.length=0,this._queryQueue.forEach(r),this._queryQueue.length=0}_connect(e){let r=this,n=this.connection;if(this._connectionCallback=e,this._connecting||this._connected){let s=new Error("Client has already been connected. You cannot reuse a client.");process.nextTick(()=>{e(s)});return}this._connecting=!0,this._connectionTimeoutMillis>0&&(this.connectionTimeoutHandle=setTimeout(()=>{n._ending=!0,n.stream.destroy(new Error("timeout expired"))},this._connectionTimeoutMillis),this.connectionTimeoutHandle.unref&&this.connectionTimeoutHandle.unref()),this.host&&this.host.indexOf("/")===0?n.connect(this.host+"/.s.PGSQL."+this.port):n.connect(this.port,this.host),n.on("connect",function(){r.ssl?r.sslNegotiation!=="direct"&&n.requestSsl():n.startup(r.getStartupConf())}),n.on("sslconnect",function(){n.startup(r.getStartupConf())}),this._attachListeners(n),n.once("end",()=>{let s=this._ending?new Error("Connection terminated"):new Error("Connection terminated unexpectedly");clearTimeout(this.connectionTimeoutHandle),this._errorAllQueries(s),this._ended=!0,this._ending||(this._connecting&&!this._connectionError?this._connectionCallback?this._connectionCallback(s):this._handleErrorEvent(s):this._connectionError||this._handleErrorEvent(s)),process.nextTick(()=>{this.emit("end")})})}connect(e){if(e){this._connect(e);return}return new this._Promise((r,n)=>{this._connect(s=>{s?n(s):r(this)})})}_attachListeners(e){e.on("authenticationCleartextPassword",this._handleAuthCleartextPassword.bind(this)),e.on("authenticationMD5Password",this._handleAuthMD5Password.bind(this)),e.on("authenticationSASL",this._handleAuthSASL.bind(this)),e.on("authenticationSASLContinue",this._handleAuthSASLContinue.bind(this)),e.on("authenticationSASLFinal",this._handleAuthSASLFinal.bind(this)),e.on("backendKeyData",this._handleBackendKeyData.bind(this)),e.on("error",this._handleErrorEvent.bind(this)),e.on("errorMessage",this._handleErrorMessage.bind(this)),e.on("readyForQuery",this._handleReadyForQuery.bind(this)),e.on("notice",this._handleNotice.bind(this)),e.on("rowDescription",this._handleRowDescription.bind(this)),e.on("dataRow",this._handleDataRow.bind(this)),e.on("portalSuspended",this._handlePortalSuspended.bind(this)),e.on("emptyQuery",this._handleEmptyQuery.bind(this)),e.on("commandComplete",this._handleCommandComplete.bind(this)),e.on("parseComplete",this._handleParseComplete.bind(this)),e.on("copyInResponse",this._handleCopyInResponse.bind(this)),e.on("copyData",this._handleCopyData.bind(this)),e.on("notification",this._handleNotification.bind(this))}_getPassword(e){let r=this.connection;if(typeof this.password=="function")this._Promise.resolve().then(()=>this.password(this.connectionParameters)).then(n=>{if(n!==void 0){if(typeof n!="string"){r.emit("error",new TypeError("Password must be a string"));return}this.connectionParameters.password=this.password=n}else this.connectionParameters.password=this.password=null;e()}).catch(n=>{r.emit("error",n)});else if(this.password!==null)e();else try{Ao()(this.connectionParameters,s=>{s!==void 0&&(nh(),this.connectionParameters.password=this.password=s),e()})}catch(n){this.emit("error",n)}}_handleAuthCleartextPassword(e){this._getPassword(()=>{this.connection.password(this.password)})}_handleAuthMD5Password(e){this._getPassword(async()=>{try{let r=await th.postgresMd5PasswordHash(this.user,this.password,e.salt);this.connection.password(r)}catch(r){this.emit("error",r)}})}_handleAuthSASL(e){this._getPassword(()=>{try{this.saslSession=Ft.startSession(e.mechanisms,this.enableChannelBinding&&this.connection.stream,this.scramMaxIterations),this.connection.sendSASLInitialResponseMessage(this.saslSession.mechanism,this.saslSession.response)}catch(r){this.connection.emit("error",r)}})}async _handleAuthSASLContinue(e){try{await Ft.continueSession(this.saslSession,this.password,e.data,this.enableChannelBinding&&this.connection.stream),this.connection.sendSCRAMClientFinalMessage(this.saslSession.response)}catch(r){this.connection.emit("error",r)}}_handleAuthSASLFinal(e){try{Ft.finalizeSession(this.saslSession,e.data),this.saslSession=null}catch(r){this.connection.emit("error",r)}}_handleBackendKeyData(e){this.processID=e.processID,this.secretKey=e.secretKey}_handleReadyForQuery(e){this._connecting&&(this._connecting=!1,this._connected=!0,clearTimeout(this.connectionTimeoutHandle),this._connectionCallback&&(this._connectionCallback(null,this),this._connectionCallback=null),this.emit("connect"));let r=this._getActiveQuery();this._activeQuery=null,this._txStatus=e?.status??null,this.readyForQuery=!0,r&&r.handleReadyForQuery(this.connection),this._pulseQueryQueue()}_handleErrorWhileConnecting(e){if(!this._connectionError){if(this._connectionError=!0,clearTimeout(this.connectionTimeoutHandle),this._connectionCallback)return this._connectionCallback(e);this.emit("error",e)}}_handleErrorEvent(e){if(this._connecting)return this._handleErrorWhileConnecting(e);this._queryable=!1,this._errorAllQueries(e),this.emit("error",e)}_handleErrorMessage(e){if(this._connecting)return this._handleErrorWhileConnecting(e);let r=this._getActiveQuery();if(!r){this._handleErrorEvent(e);return}this._activeQuery=null,r.name&&delete this.connection.submittedNamedStatements[r.name],r.handleError(e,this.connection)}_handleRowDescription(e){let r=this._getActiveQuery();if(r==null){let n=new Error("Received unexpected rowDescription message from backend.");this._handleErrorEvent(n);return}r.handleRowDescription(e)}_handleDataRow(e){let r=this._getActiveQuery();if(r==null){let n=new Error("Received unexpected dataRow message from backend.");this._handleErrorEvent(n);return}r.handleDataRow(e)}_handlePortalSuspended(e){let r=this._getActiveQuery();if(r==null){let n=new Error("Received unexpected portalSuspended message from backend.");this._handleErrorEvent(n);return}r.handlePortalSuspended(this.connection)}_handleEmptyQuery(e){let r=this._getActiveQuery();if(r==null){let n=new Error("Received unexpected emptyQuery message from backend.");this._handleErrorEvent(n);return}r.handleEmptyQuery(this.connection)}_handleCommandComplete(e){let r=this._getActiveQuery();if(r==null){let n=new Error("Received unexpected commandComplete message from backend.");this._handleErrorEvent(n);return}r.handleCommandComplete(e,this.connection)}_handleParseComplete(){let e=this._getActiveQuery();if(e==null){let r=new Error("Received unexpected parseComplete message from backend.");this._handleErrorEvent(r);return}e.name&&(this.connection.parsedStatements[e.name]=e.text,delete this.connection.submittedNamedStatements[e.name])}_handleCopyInResponse(e){let r=this._getActiveQuery();if(r==null){let n=new Error("Received unexpected copyInResponse message from backend.");this._handleErrorEvent(n);return}r.handleCopyInResponse(this.connection)}_handleCopyData(e){let r=this._getActiveQuery();if(r==null){let n=new Error("Received unexpected copyData message from backend.");this._handleErrorEvent(n);return}r.handleCopyData(e,this.connection)}_handleNotification(e){this.emit("notification",e)}_handleNotice(e){this.emit("notice",e)}getStartupConf(){let e=this.connectionParameters,r={user:e.user,database:e.database},n=e.application_name||e.fallback_application_name;return n&&(r.application_name=n),e.replication&&(r.replication=""+e.replication),e.statement_timeout&&(r.statement_timeout=String(parseInt(e.statement_timeout,10))),e.lock_timeout&&(r.lock_timeout=String(parseInt(e.lock_timeout,10))),e.idle_in_transaction_session_timeout&&(r.idle_in_transaction_session_timeout=String(parseInt(e.idle_in_transaction_session_timeout,10))),e.options&&(r.options=e.options),r}cancel(e,r){if(e.activeQuery===r){let n=this.connection;this.host&&this.host.indexOf("/")===0?n.connect(this.host+"/.s.PGSQL."+this.port):n.connect(this.port,this.host),n.on("connect",function(){n.cancel(e.processID,e.secretKey)})}else e._queryQueue.indexOf(r)!==-1?e._queryQueue.splice(e._queryQueue.indexOf(r),1):e._sentQueryQueue.indexOf(r)!==-1&&(r.callback=()=>{})}setTypeParser(e,r,n){return this._types.setTypeParser(e,r,n)}getTypeParser(e,r){return this._types.getTypeParser(e,r)}escapeIdentifier(e){return To.escapeIdentifier(e)}escapeLiteral(e){return To.escapeLiteral(e)}_pulseQueryQueue(){if(this.pipeline){this._pulsePipelinedQueryQueue();return}if(this.readyForQuery===!0){this._activeQuery=this._queryQueue.shift();let e=this._getActiveQuery();if(e){this.readyForQuery=!1,this.hasExecuted=!0;let r=e.submit(this.connection);r&&process.nextTick(()=>{e.handleError(r,this.connection),this.readyForQuery=!0,this._pulseQueryQueue()})}else this.hasExecuted&&(this._activeQuery=null,this.emit("drain"))}}_pulsePipelinedQueryQueue(){if(!(!this._connected||!this._queryable)){for(;this._queryQueue.length>0;){let e=this._queryQueue.shift();this.hasExecuted=!0;let r=e.submit(this.connection);if(r){process.nextTick(()=>{e.handleError(r,this.connection)});continue}this._sentQueryQueue.push(e)}this.readyForQuery&&!this._activeQuery&&this._sentQueryQueue.length>0&&(this._activeQuery=this._sentQueryQueue.shift(),this.readyForQuery=!1),!this._activeQuery&&this._sentQueryQueue.length===0&&this._queryQueue.length===0&&this.hasExecuted&&this.emit("drain")}}query(e,r,n){let s,i;if(e==null)throw new TypeError("Client was passed a null or undefined query");if(typeof e.submit=="function")i=s=e,s.callback||(typeof r=="function"?s.callback=r:n&&(s.callback=n));else if(s=new Cn(e,r,n),!s.callback)i=new this._Promise((a,c)=>{s.callback=(u,l)=>u?c(u):a(l)}).catch(a=>{throw Error.captureStackTrace(a),a});else if(typeof s.callback!="function")throw new TypeError("callback is not a function");let o=e.query_timeout||this.connectionParameters.query_timeout;if(o){let a=s.callback||(()=>{}),c=setTimeout(()=>{let u=new Error("Query read timeout");process.nextTick(()=>{s.handleError(u,this.connection)}),a(u),s.callback=()=>{};let l=this._queryQueue.indexOf(s);if(l>-1)this._queryQueue.splice(l,1);else if(this.pipeline){this.connection.stream.destroy();return}this._pulseQueryQueue()},o);s.callback=(u,l)=>{clearTimeout(c),a(u,l)}}if(this.binary&&!s.binary&&(s.binary=!0),s._result&&!s._result._types&&(s._result._types=this._types),this.pipeline){let a=typeof e.submit=="function"&&!(s instanceof Cn)?"Custom query classes such as pg-cursor and pg-query-stream are":s.rows?"The `rows` option is":null;if(a)return process.nextTick(()=>{s.handleError(new Error(`${a} not supported in pipeline mode`),this.connection)}),i}return this._queryable?this._ending?(process.nextTick(()=>{s.handleError(new Error("Client was closed and is not queryable"),this.connection)}),i):(this._queryQueue.length>0&&!this.pipeline&&ih(),this._queryQueue.push(s),this._pulseQueryQueue(),i):(process.nextTick(()=>{s.handleError(new Error("Client has encountered a connection error and is not queryable"),this.connection)}),i)}ref(){this.connection.ref()}unref(){this.connection.unref()}getTransactionStatus(){return this._txStatus}end(e){if(this._ending=!0,!this.connection._connecting||this._ended)if(e){e();return}else return this._Promise.resolve();if(this._queryable?this.pipeline&&(this._getActiveQuery()||this._sentQueryQueue.length>0||this._queryQueue.length>0)?this.once("drain",()=>this.connection.end()):this._getActiveQuery()?this.connection.stream.destroy():this.connection.end():this.connection.stream.destroy(),e)this.connection.once("end",e);else return new this._Promise(r=>{this.connection.once("end",r)})}get queryQueue(){return rh(),this._queryQueue}};Gt.Query=Cn;ko.exports=Gt});var Oo=E((Cd,No)=>{"use strict";var ah=O("events").EventEmitter,Nn=function(){},Co=(t,e)=>{let r=t.findIndex(e);return r===-1?void 0:t.splice(r,1)[0]},On=class{constructor(e,r,n){this.client=e,this.idleListener=r,this.timeoutId=n}},He=class{constructor(e){this.callback=e}};function ch(){throw new Error("Release called on client which has already been released to the pool.")}function Vt(t,e){if(e)return{callback:e,result:void 0};let r,n,s=function(o,a){o?r(o):n(a)},i=new t(function(o,a){n=o,r=a}).catch(o=>{throw Error.captureStackTrace(o),o});return{callback:s,result:i}}function uh(t,e){return function r(n){n.client=e,e.removeListener("error",r),e.on("error",()=>{t.log("additional client error after disconnection due to error",n)}),t._remove(e),t.emit("error",n,e)}}var Bn=class extends ah{constructor(e,r){super(),this.options=Object.assign({},e),e!=null&&"password"in e&&Object.defineProperty(this.options,"password",{configurable:!0,enumerable:!1,writable:!0,value:e.password}),e!=null&&e.ssl&&e.ssl.key&&Object.defineProperty(this.options.ssl,"key",{enumerable:!1}),this.options.max=this.options.max||this.options.poolSize||10,this.options.min=this.options.min||0,this.options.maxUses=this.options.maxUses||1/0,this.options.allowExitOnIdle=this.options.allowExitOnIdle||!1,this.options.maxLifetimeSeconds=this.options.maxLifetimeSeconds||0,this.log=this.options.log||function(){},this.Client=this.options.Client||r||Pn().Client,this.Promise=this.options.Promise||global.Promise,typeof this.options.idleTimeoutMillis>"u"&&(this.options.idleTimeoutMillis=1e4),this._clients=[],this._idle=[],this._expired=new WeakSet,this._pendingQueue=[],this._endCallback=void 0,this.ending=!1,this.ended=!1}_promiseTry(e){let r=this.Promise;return typeof r.try=="function"?r.try(e):new r(n=>n(e()))}_isFull(){return this._clients.length>=this.options.max}_isAboveMin(){return this._clients.length>this.options.min}_pulseQueue(){if(this.log("pulse queue"),this.ended){this.log("pulse queue ended");return}if(this.ending){this.log("pulse queue on ending"),this._idle.length&&this._idle.slice().map(r=>{this._remove(r.client)}),this._clients.length||(this.ended=!0,this._endCallback());return}if(!this._pendingQueue.length){this.log("no queued requests");return}if(!this._idle.length&&this._isFull())return;let e=this._pendingQueue.shift();if(this._idle.length){let r=this._idle.pop();clearTimeout(r.timeoutId);let n=r.client;n.ref&&n.ref();let s=r.idleListener;return this._acquireClient(n,e,s,!1)}if(!this._isFull())return this.newClient(e);throw new Error("unexpected condition")}_remove(e,r){let n=Co(this._idle,i=>i.client===e);n!==void 0&&clearTimeout(n.timeoutId),this._clients=this._clients.filter(i=>i!==e);let s=this;e.end(()=>{s.emit("remove",e),typeof r=="function"&&r()})}connect(e){if(this.ending){let s=new Error("Cannot use a pool after calling end on the pool");return e?e(s):this.Promise.reject(s)}let r=Vt(this.Promise,e),n=r.result;if(this._isFull()||this._idle.length){if(this._idle.length&&process.nextTick(()=>this._pulseQueue()),!this.options.connectionTimeoutMillis)return this._pendingQueue.push(new He(r.callback)),n;let s=(a,c,u)=>{clearTimeout(o),r.callback(a,c,u)},i=new He(s),o=setTimeout(()=>{Co(this._pendingQueue,a=>a.callback===s),i.timedOut=!0,r.callback(new Error("timeout exceeded when trying to connect"))},this.options.connectionTimeoutMillis);return o.unref&&o.unref(),this._pendingQueue.push(i),n}return this.newClient(new He(r.callback)),n}newClient(e){let r=new this.Client(this.options);this._clients.push(r);let n=uh(this,r);this.log("checking client timeout");let s,i=!1;this.options.connectionTimeoutMillis&&(s=setTimeout(()=>{r.connection?(this.log("ending client due to timeout"),i=!0,r.connection.stream.destroy()):r.isConnected()||(this.log("ending client due to timeout"),i=!0,r.end())},this.options.connectionTimeoutMillis)),this.log("connecting new client"),r.connect(o=>{if(s&&clearTimeout(s),r.on("error",n),o)this.log("client failed to connect",o),this._clients=this._clients.filter(a=>a!==r),i&&(o=new Error("Connection terminated due to connection timeout",{cause:o})),this._pulseQueue(),e.timedOut||e.callback(o,void 0,Nn);else{if(this.log("new client connected"),this.options.onConnect){this._promiseTry(()=>this.options.onConnect(r)).then(()=>{this._afterConnect(r,e,n)},a=>{this._clients=this._clients.filter(c=>c!==r),r.end(()=>{this._pulseQueue(),e.timedOut||e.callback(a,void 0,Nn)})});return}return this._afterConnect(r,e,n)}})}_afterConnect(e,r,n){if(this.options.maxLifetimeSeconds!==0){let s=setTimeout(()=>{this.log("ending client due to expired lifetime"),this._expired.add(e),this._idle.findIndex(o=>o.client===e)!==-1&&this._acquireClient(e,new He((o,a,c)=>c()),n,!1)},this.options.maxLifetimeSeconds*1e3);s.unref(),e.once("end",()=>clearTimeout(s))}return this._acquireClient(e,r,n,!0)}_acquireClient(e,r,n,s){s&&this.emit("connect",e),this.emit("acquire",e),e.release=this._releaseOnce(e,n),e.removeListener("error",n),r.timedOut?s&&this.options.verify?this.options.verify(e,e.release):e.release():s&&this.options.verify?this.options.verify(e,i=>{if(i)return e.release(i),r.callback(i,void 0,Nn);r.callback(void 0,e,e.release)}):r.callback(void 0,e,e.release)}_releaseOnce(e,r){let n=!1;return s=>{n&&ch(),n=!0,this._release(e,r,s)}}_release(e,r,n){if(e.on("error",r),e._poolUseCount=(e._poolUseCount||0)+1,this.emit("release",n,e),n||this.ending||!e._queryable||e._ending||e._poolUseCount>=this.options.maxUses)return e._poolUseCount>=this.options.maxUses&&this.log("remove expended client"),this._remove(e,this._pulseQueue.bind(this));if(this._expired.has(e))return this.log("remove expired client"),this._expired.delete(e),this._remove(e,this._pulseQueue.bind(this));let i;this.options.idleTimeoutMillis&&this._isAboveMin()&&(i=setTimeout(()=>{this._isAboveMin()&&(this.log("remove idle client"),this._remove(e,this._pulseQueue.bind(this)))},this.options.idleTimeoutMillis),this.options.allowExitOnIdle&&i.unref()),this.options.allowExitOnIdle&&e.unref(),this._idle.push(new On(e,r,i)),this._pulseQueue()}query(e,r,n){if(typeof e=="function"){let i=Vt(this.Promise,e);return setImmediate(function(){return i.callback(new Error("Passing a function as the first parameter to pool.query is not supported"))}),i.result}typeof r=="function"&&(n=r,r=void 0);let s=Vt(this.Promise,n);return n=s.callback,this.connect((i,o)=>{if(i)return n(i);let a=!1,c=u=>{a||(a=!0,o.release(u),n(u))};o.once("error",c),this.log("dispatching query");try{o.query(e,r,(u,l)=>{if(this.log("query dispatched"),o.removeListener("error",c),!a)return a=!0,o.release(u),u?n(u):n(void 0,l)})}catch(u){return o.release(u),n(u)}}),s.result}end(e){if(this.log("ending"),this.ending){let n=new Error("Called end on pool more than once");return e?e(n):this.Promise.reject(n)}this.ending=!0;let r=Vt(this.Promise,e);return this._endCallback=r.callback,this._pulseQueue(),r.result}get waitingCount(){return this._pendingQueue.length}get idleCount(){return this._idle.length}get expiredCount(){return this._clients.reduce((e,r)=>e+(this._expired.has(r)?1:0),0)}get totalCount(){return this._clients.length}};No.exports=Bn});var Lo=E((Nd,Po)=>{"use strict";var Bo=O("events").EventEmitter,lh=O("util"),Ln=ve(),Qe=Po.exports=function(t,e,r){Bo.call(this),t=Ln.normalizeQueryConfig(t,e,r),this.text=t.text,this.values=t.values,this.name=t.name,this.queryMode=t.queryMode,this.callback=t.callback,this.state="new",this._arrayMode=t.rowMode==="array",this._emitRowEvents=!1,this.on("newListener",function(n){n==="row"&&(this._emitRowEvents=!0)}.bind(this))};lh.inherits(Qe,Bo);var hh={sqlState:"code",statementPosition:"position",messagePrimary:"message",messageDetail:"detail",messageHint:"hint",context:"where",schemaName:"schema",tableName:"table",columnName:"column",dataTypeName:"dataType",constraintName:"constraint",sourceFile:"file",sourceLine:"line",sourceFunction:"routine"};Qe.prototype.handleError=function(t){let e=this.native&&this.native.pq.resultErrorFields();if(e)for(let r in e){let n=hh[r]||r;t[n]=e[r]}this.callback?this.callback(t):this.emit("error",t),this.state="error"};Qe.prototype.then=function(t,e){return this._getPromise().then(t,e)};Qe.prototype.catch=function(t){return this._getPromise().catch(t)};Qe.prototype._getPromise=function(){return this._promise?this._promise:(this._promise=new Promise(function(t,e){this._once("end",t),this._once("error",e)}.bind(this)),this._promise)};Qe.prototype.submit=function(t){this.state="running";let e=this;this.native=t.native,t.native.arrayMode=this._arrayMode;let r=function(n,s,i){if(t.native.arrayMode=!1,setImmediate(function(){e.emit("_done")}),n)return e.handleError(n);e._emitRowEvents&&(i.length>1?s.forEach((o,a)=>{o.forEach(c=>{e.emit("row",c,i[a])})}):s.forEach(function(o){e.emit("row",o,i)})),e.state="end",e.emit("end",i),e.callback&&e.callback(null,i)};if(process.domain&&(r=process.domain.bind(r)),this.name){this.name.length>63&&(console.error("Warning! Postgres only supports 63 characters for query names."),console.error("You supplied %s (%s)",this.name,this.name.length),console.error("This can cause conflicts and silent errors executing queries"));let n=(this.values||[]).map(Ln.prepareValue);if(t.namedQueries[this.name]!==void 0){if(this.text&&t.namedQueries[this.name]!==this.text){let s=new Error(`Prepared statements must be unique - \'${this.name}\' was used for a different statement`);return r(s)}return t.native.execute(this.name,n,r)}return t.native.prepare(this.name,this.text,n.length,function(s){return s?r(s):(t.namedQueries[e.name]=e.text,e.native.execute(e.name,n,r))})}else if(this.values){if(!Array.isArray(this.values)){let s=new Error("Query values must be an array");return r(s)}let n=this.values.map(Ln.prepareValue);t.native.query(this.text,n,r)}else this.queryMode==="extended"?t.native.query(this.text,[],r):t.native.query(this.text,r)}});var Uo=E((Od,$o)=>{"use strict";var fh=O("util"),Do;try{Do=O("pg-native")}catch(t){throw t}var dh=Dt(),Mo=O("events").EventEmitter,ph=O("util"),mh=Zr(),qo=Lo(),yh=fh.deprecate(()=>{},"Calling client.query() when the client is already executing a query is deprecated and will be removed in pg@9.0. Use async/await or an external async flow control mechanism instead."),Q=$o.exports=function(t){Mo.call(this),t=t||{},this._Promise=t.Promise||global.Promise,this._types=new dh(t.types),this.native=new Do({types:this._types}),this._queryQueue=[],this._ending=!1,this._connecting=!1,this._connected=!1,this._queryable=!0,this.pipeline=!!t.pipeline,this._pipelineInFlight=!1;let e=this.connectionParameters=new mh(t);t.nativeConnectionString&&(e.nativeConnectionString=t.nativeConnectionString),this.user=e.user,Object.defineProperty(this,"password",{configurable:!0,enumerable:!1,writable:!0,value:e.password}),this.database=e.database,this.host=e.host,this.port=e.port,this.namedQueries={}};Q.Query=qo;ph.inherits(Q,Mo);Q.prototype._errorAllQueries=function(t){let e=r=>{process.nextTick(()=>{r.native=this.native,r.handleError(t)})};this._hasActiveQuery()&&(e(this._activeQuery),this._activeQuery=null),this._queryQueue.forEach(e),this._queryQueue.length=0};Q.prototype._connect=function(t){let e=this;if(this._connecting){process.nextTick(()=>t(new Error("Client has already been connected. You cannot reuse a client.")));return}this._connecting=!0,this.connectionParameters.getLibpqConnectionString(function(r,n){if(e.connectionParameters.nativeConnectionString&&(n=e.connectionParameters.nativeConnectionString),r)return t(r);e.native.connect(n,function(s){if(s)return e.native.end(),t(s);e._connected=!0,e.native.on("error",function(i){e._queryable=!1,e._errorAllQueries(i),e.emit("error",i)}),e.native.on("notification",function(i){e.emit("notification",{channel:i.relname,payload:i.extra})}),e.emit("connect"),e._pulseQueryQueue(!0),t(null,this)})})};Q.prototype.connect=function(t){if(t){this._connect(t);return}return new this._Promise((e,r)=>{this._connect(n=>{n?r(n):e(this)})})};Q.prototype.query=function(t,e,r){let n,s,i,o,a;if(t==null)throw new TypeError("Client was passed a null or undefined query");if(typeof t.submit=="function")i=t.query_timeout||this.connectionParameters.query_timeout,s=n=t,typeof e=="function"&&(t.callback=e);else if(i=t.query_timeout||this.connectionParameters.query_timeout,n=new qo(t,e,r),!n.callback){let c,u;s=new this._Promise((l,h)=>{c=l,u=h}).catch(l=>{throw Error.captureStackTrace(l),l}),n.callback=(l,h)=>l?u(l):c(h)}return i&&(a=n.callback||(()=>{}),o=setTimeout(()=>{let c=new Error("Query read timeout");process.nextTick(()=>{n.handleError(c,this.connection)}),a(c),n.callback=()=>{};let u=this._queryQueue.indexOf(n);u>-1&&this._queryQueue.splice(u,1),this._pulseQueryQueue()},i),n.callback=(c,u)=>{clearTimeout(o),a(c,u)}),this._queryable?this._ending?(n.native=this.native,process.nextTick(()=>{n.handleError(new Error("Client was closed and is not queryable"))}),s):(this._queryQueue.length>0&&!this.pipeline&&yh(),this._queryQueue.push(n),this._pulseQueryQueue(),s):(n.native=this.native,process.nextTick(()=>{n.handleError(new Error("Client has encountered a connection error and is not queryable"))}),s)};Q.prototype.end=function(t){let e=this;this._ending=!0,this._connecting&&!this._connected&&this.once("connect",()=>{this.end(()=>{})});let r;t||(r=new this._Promise(function(s,i){t=o=>o?i(o):s()}));let n=function(){e.native.end(function(){e._connected=!1,e._errorAllQueries(new Error("Connection terminated")),process.nextTick(()=>{e.emit("end"),t&&t()})})};return this.pipeline&&(this._pipelineInFlight||this._queryQueue.length>0)?this.once("drain",n):n(),r};Q.prototype._hasActiveQuery=function(){return this._activeQuery&&this._activeQuery.state!=="error"&&this._activeQuery.state!=="end"};Q.prototype._pulseQueryQueue=function(t){if(!this._connected)return;if(this.pipeline&&!t)return this._pulsePipelinedQueryQueue();if(this._hasActiveQuery())return;let e=this._queryQueue.shift();if(!e){t||this.emit("drain");return}this._activeQuery=e,e.submit(this);let r=this;e.once("_done",function(){r._pulseQueryQueue()})};Q.prototype._pulsePipelinedQueryQueue=function(){if(!this._connected||this._pipelineInFlight)return;if(this._queryQueue.length===0){this.hasExecuted&&this.emit("drain");return}this._pipelineInFlight=!0;let t=this,e=[],r=[],n=ve();for(;this._queryQueue.length>0;){let s=this._queryQueue.shift();this.hasExecuted=!0,r.push(s);let i=s.values?s.values.map(n.prepareValue):null,o={text:s.text,name:s.name,arrayMode:s._arrayMode};i&&(o.values=i),s.name&&this.namedQueries[s.name]&&(o._alreadyPrepared=!0),e.push(o)}this.native.pipeline(e,function(s,i){if(t._pipelineInFlight=!1,s){t._connected=!1,t._queryable=!1;for(let o=0;o<r.length;o++){let a=r[o];a.native=t.native,a.handleError(s)}t._errorAllQueries(s),t.emit("error",s),t.emit("end");return}for(let o=0;o<r.length;o++){let a=r[o],c=i[o];a.native=t.native,c.err?a.handleError(c.err):(a.name&&(t.namedQueries[a.name]=a.text),a.state="end",a.emit("end",c.result),a.callback&&a.callback(null,c.result)),setImmediate(function(){a.emit("_done")})}t._pulsePipelinedQueryQueue()})};Q.prototype.cancel=function(t){this._activeQuery===t?this.native.cancel(function(){}):this._queryQueue.indexOf(t)!==-1&&this._queryQueue.splice(this._queryQueue.indexOf(t),1)};Q.prototype.ref=function(){};Q.prototype.unref=function(){};Q.prototype.setTypeParser=function(t,e,r){return this._types.setTypeParser(t,e,r)};Q.prototype.getTypeParser=function(t,e){return this._types.getTypeParser(t,e)};Q.prototype.isConnected=function(){return this._connected};Q.prototype.getTransactionStatus=function(){return this.native.getTransactionStatus()}});var Dn=E((Bd,Ho)=>{"use strict";Ho.exports=Uo()});var Pn=E((Ld,Kt)=>{"use strict";var gh=Io(),bh=ot(),wh=Tn(),Eh=Jr(),xh=ve(),Sh=Oo(),vh=Dt(),{DatabaseError:_h}=vn(),{escapeIdentifier:Ah,escapeLiteral:Th}=ve(),Rh=t=>class extends Sh{constructor(r){super(r,t)}},Qo=function(t){this.defaults=bh,this.Client=t,this.Query=this.Client.Query,this.Pool=Rh(this.Client),this._pools=[],this.Connection=wh,this.types=it(),this.DatabaseError=_h,this.TypeOverrides=vh,this.escapeIdentifier=Ah,this.escapeLiteral=Th,this.Result=Eh,this.utils=xh},zo=gh,jo=!1;try{jo=!!process.env.NODE_PG_FORCE_NATIVE}catch{}jo&&(zo=Dn());Kt.exports=new Qo(zo);Object.defineProperty(Kt.exports,"native",{configurable:!0,enumerable:!1,get(){let t=null;try{t=new Qo(Dn())}catch(e){if(e.code!=="MODULE_NOT_FOUND")throw e}return Object.defineProperty(Kt.exports,"native",{value:t}),t}})});function Xt(t){return t instanceof Uint8Array||ArrayBuffer.isView(t)&&t.constructor.name==="Uint8Array"}function Ie(t,e=""){if(!Number.isSafeInteger(t)||t<0){let r=e&&`"${e}" `;throw new Error(`${r}expected integer >= 0, got ${t}`)}}function q(t,e,r=""){let n=Xt(t),s=t?.length,i=e!==void 0;if(!n||i&&s!==e){let o=r&&`"${r}" `,a=i?` of length ${e}`:"",c=n?`length=${s}`:`type=${typeof t}`;throw new Error(o+"expected Uint8Array"+a+", got "+c)}return t}function Jt(t,e=!0){if(t.destroyed)throw new Error("Hash instance has been destroyed");if(e&&t.finished)throw new Error("Hash#digest() has already been called")}function Hn(t,e){q(t,void 0,"digestInto() output");let r=e.outputLen;if(t.length<r)throw new Error(\'"digestInto() output" expected to be of length >=\'+r)}function Fe(...t){for(let e=0;e<t.length;e++)t[e].fill(0)}function lt(t){return new DataView(t.buffer,t.byteOffset,t.byteLength)}function ie(t,e){return t<<32-e|t>>>e}var Qn=typeof Uint8Array.from([]).toHex=="function"&&typeof Uint8Array.fromHex=="function",ia=Array.from({length:256},(t,e)=>e.toString(16).padStart(2,"0"));function $(t){if(q(t),Qn)return t.toHex();let e="";for(let r=0;r<t.length;r++)e+=ia[t[r]];return e}var he={_0:48,_9:57,A:65,F:70,a:97,f:102};function Un(t){if(t>=he._0&&t<=he._9)return t-he._0;if(t>=he.A&&t<=he.F)return t-(he.A-10);if(t>=he.a&&t<=he.f)return t-(he.a-10)}function oe(t){if(typeof t!="string")throw new Error("hex string expected, got "+typeof t);if(Qn)return Uint8Array.fromHex(t);let e=t.length,r=e/2;if(e%2)throw new Error("hex string expected, got unpadded hex of length "+e);let n=new Uint8Array(r);for(let s=0,i=0;s<r;s++,i+=2){let o=Un(t.charCodeAt(i)),a=Un(t.charCodeAt(i+1));if(o===void 0||a===void 0){let c=t[i]+t[i+1];throw new Error(\'hex string expected, got non-hex character "\'+c+\'" at index \'+i)}n[s]=o*16+a}return n}function fe(...t){let e=0;for(let n=0;n<t.length;n++){let s=t[n];q(s),e+=s.length}let r=new Uint8Array(e);for(let n=0,s=0;n<t.length;n++){let i=t[n];r.set(i,s),s+=i.length}return r}function zn(t,e={}){let r=(s,i)=>t(i).update(s).digest(),n=t(void 0);return r.outputLen=n.outputLen,r.blockLen=n.blockLen,r.create=s=>t(s),Object.assign(r,e),Object.freeze(r)}function Ge(t=32){let e=typeof globalThis=="object"?globalThis.crypto:null;if(typeof e?.getRandomValues!="function")throw new Error("crypto.getRandomValues must be defined");return e.getRandomValues(new Uint8Array(t))}var jn=t=>({oid:Uint8Array.from([6,9,96,134,72,1,101,3,4,2,t])});function Fn(t,e,r){return t&e^~t&r}function Gn(t,e,r){return t&e^t&r^e&r}var ht=class{blockLen;outputLen;padOffset;isLE;buffer;view;finished=!1;length=0;pos=0;destroyed=!1;constructor(e,r,n,s){this.blockLen=e,this.outputLen=r,this.padOffset=n,this.isLE=s,this.buffer=new Uint8Array(e),this.view=lt(this.buffer)}update(e){Jt(this),q(e);let{view:r,buffer:n,blockLen:s}=this,i=e.length;for(let o=0;o<i;){let a=Math.min(s-this.pos,i-o);if(a===s){let c=lt(e);for(;s<=i-o;o+=s)this.process(c,o);continue}n.set(e.subarray(o,o+a),this.pos),this.pos+=a,o+=a,this.pos===s&&(this.process(r,0),this.pos=0)}return this.length+=e.length,this.roundClean(),this}digestInto(e){Jt(this),Hn(e,this),this.finished=!0;let{buffer:r,view:n,blockLen:s,isLE:i}=this,{pos:o}=this;r[o++]=128,Fe(this.buffer.subarray(o)),this.padOffset>s-o&&(this.process(n,0),o=0);for(let h=o;h<s;h++)r[h]=0;n.setBigUint64(s-8,BigInt(this.length*8),i),this.process(n,0);let a=lt(e),c=this.outputLen;if(c%4)throw new Error("_sha2: outputLen must be aligned to 32bit");let u=c/4,l=this.get();if(u>l.length)throw new Error("_sha2: outputLen bigger than state");for(let h=0;h<u;h++)a.setUint32(4*h,l[h],i)}digest(){let{buffer:e,outputLen:r}=this;this.digestInto(e);let n=e.slice(0,r);return this.destroy(),n}_cloneInto(e){e||=new this.constructor,e.set(...this.get());let{blockLen:r,buffer:n,length:s,finished:i,destroyed:o,pos:a}=this;return e.destroyed=o,e.finished=i,e.length=s,e.pos=a,s%r&&e.buffer.set(n),e}clone(){return this._cloneInto()}},de=Uint32Array.from([1779033703,3144134277,1013904242,2773480762,1359893119,2600822924,528734635,1541459225]);var oa=Uint32Array.from([1116352408,1899447441,3049323471,3921009573,961987163,1508970993,2453635748,2870763221,3624381080,310598401,607225278,1426881987,1925078388,2162078206,2614888103,3248222580,3835390401,4022224774,264347078,604807628,770255983,1249150122,1555081692,1996064986,2554220882,2821834349,2952996808,3210313671,3336571891,3584528711,113926993,338241895,666307205,773529912,1294757372,1396182291,1695183700,1986661051,2177026350,2456956037,2730485921,2820302411,3259730800,3345764771,3516065817,3600352804,4094571909,275423344,430227734,506948616,659060556,883997877,958139571,1322822218,1537002063,1747873779,1955562222,2024104815,2227730452,2361852424,2428436474,2756734187,3204031479,3329325298]),ye=new Uint32Array(64),er=class extends ht{constructor(e){super(64,e,8,!1)}get(){let{A:e,B:r,C:n,D:s,E:i,F:o,G:a,H:c}=this;return[e,r,n,s,i,o,a,c]}set(e,r,n,s,i,o,a,c){this.A=e|0,this.B=r|0,this.C=n|0,this.D=s|0,this.E=i|0,this.F=o|0,this.G=a|0,this.H=c|0}process(e,r){for(let h=0;h<16;h++,r+=4)ye[h]=e.getUint32(r,!1);for(let h=16;h<64;h++){let f=ye[h-15],p=ye[h-2],S=ie(f,7)^ie(f,18)^f>>>3,y=ie(p,17)^ie(p,19)^p>>>10;ye[h]=y+ye[h-7]+S+ye[h-16]|0}let{A:n,B:s,C:i,D:o,E:a,F:c,G:u,H:l}=this;for(let h=0;h<64;h++){let f=ie(a,6)^ie(a,11)^ie(a,25),p=l+f+Fn(a,c,u)+oa[h]+ye[h]|0,y=(ie(n,2)^ie(n,13)^ie(n,22))+Gn(n,s,i)|0;l=u,u=c,c=a,a=o+p|0,o=i,i=s,s=n,n=p+y|0}n=n+this.A|0,s=s+this.B|0,i=i+this.C|0,o=o+this.D|0,a=a+this.E|0,c=c+this.F|0,u=u+this.G|0,l=l+this.H|0,this.set(n,s,i,o,a,c,u,l)}roundClean(){Fe(ye)}destroy(){this.set(0,0,0,0,0,0,0,0),Fe(this.buffer)}},tr=class extends er{A=de[0]|0;B=de[1]|0;C=de[2]|0;D=de[3]|0;E=de[4]|0;F=de[5]|0;G=de[6]|0;H=de[7]|0;constructor(){super(32)}};var Ee=zn(()=>new tr,jn(1));var nr=BigInt(0),rr=BigInt(1);function sr(t,e=""){if(typeof t!="boolean"){let r=e&&`"${e}" `;throw new Error(r+"expected boolean, got type="+typeof t)}return t}function aa(t){if(typeof t=="bigint"){if(!ua(t))throw new Error("positive bigint expected, got "+t)}else Ie(t);return t}function Vn(t){if(typeof t!="string")throw new Error("hex string expected, got "+typeof t);return t===""?nr:BigInt("0x"+t)}function Ce(t){return Vn($(t))}function ir(t){return Vn($(ca(q(t)).reverse()))}function ft(t,e){Ie(e),t=aa(t);let r=oe(t.toString(16).padStart(e*2,"0"));if(r.length!==e)throw new Error("number too large");return r}function or(t,e){return ft(t,e).reverse()}function ca(t){return Uint8Array.from(t)}function Kn(t){return Uint8Array.from(t,(e,r)=>{let n=e.charCodeAt(0);if(e.length!==1||n>127)throw new Error(`string contains non-ASCII character "${t[r]}" with code ${n} at position ${r}`);return n})}var ua=t=>typeof t=="bigint"&&nr<=t;function ar(t){let e;for(e=0;t>nr;t>>=rr,e+=1);return e}var dt=t=>(rr<<BigInt(t))-rr;function pt(t,e={},r={}){if(!t||typeof t!="object")throw new Error("expected valid options object");function n(i,o,a){let c=t[i];if(a&&c===void 0)return;let u=typeof c;if(u!==o||c===null)throw new Error(`param "${i}" is invalid: expected ${o}, got ${u}`)}let s=(i,o)=>Object.entries(i).forEach(([a,c])=>n(a,c,o));s(e,!1),s(r,!0)}function cr(t){let e=new WeakMap;return(r,...n)=>{let s=e.get(r);if(s!==void 0)return s;let i=t(r,...n);return e.set(r,i),i}}var K=BigInt(0),F=BigInt(1),xe=BigInt(2),Zn=BigInt(3),Xn=BigInt(4),Jn=BigInt(5),la=BigInt(7),es=BigInt(8),ha=BigInt(9),ts=BigInt(16);function ae(t,e){let r=t%e;return r>=K?r:e+r}function W(t,e,r){let n=t;for(;e-- >K;)n*=n,n%=r;return n}function Yn(t,e){if(t===K)throw new Error("invert: expected non-zero number");if(e<=K)throw new Error("invert: expected positive modulus, got "+e);let r=ae(t,e),n=e,s=K,i=F,o=F,a=K;for(;r!==K;){let u=n/r,l=n%r,h=s-o*u,f=i-a*u;n=r,r=l,s=o,i=a,o=h,a=f}if(n!==F)throw new Error("invert: does not exist");return ae(s,e)}function lr(t,e,r){if(!t.eql(t.sqr(e),r))throw new Error("Cannot find square root")}function rs(t,e){let r=(t.ORDER+F)/Xn,n=t.pow(e,r);return lr(t,n,e),n}function fa(t,e){let r=(t.ORDER-Jn)/es,n=t.mul(e,xe),s=t.pow(n,r),i=t.mul(e,s),o=t.mul(t.mul(i,xe),s),a=t.mul(i,t.sub(o,t.ONE));return lr(t,a,e),a}function da(t){let e=Ne(t),r=ns(t),n=r(e,e.neg(e.ONE)),s=r(e,n),i=r(e,e.neg(n)),o=(t+la)/ts;return(a,c)=>{let u=a.pow(c,o),l=a.mul(u,n),h=a.mul(u,s),f=a.mul(u,i),p=a.eql(a.sqr(l),c),S=a.eql(a.sqr(h),c);u=a.cmov(u,l,p),l=a.cmov(f,h,S);let y=a.eql(a.sqr(l),c),P=a.cmov(u,l,y);return lr(a,P,c),P}}function ns(t){if(t<Zn)throw new Error("sqrt is not defined for small field");let e=t-F,r=0;for(;e%xe===K;)e/=xe,r++;let n=xe,s=Ne(t);for(;Wn(s,n)===1;)if(n++>1e3)throw new Error("Cannot find square root: probably non-prime P");if(r===1)return rs;let i=s.pow(n,e),o=(e+F)/xe;return function(c,u){if(c.is0(u))return u;if(Wn(c,u)!==1)throw new Error("Cannot find square root");let l=r,h=c.mul(c.ONE,i),f=c.pow(u,e),p=c.pow(u,o);for(;!c.eql(f,c.ONE);){if(c.is0(f))return c.ZERO;let S=1,y=c.sqr(f);for(;!c.eql(y,c.ONE);)if(S++,y=c.sqr(y),S===l)throw new Error("Cannot find square root");let P=F<<BigInt(l-S-1),j=c.pow(h,P);l=S,h=c.sqr(j),f=c.mul(f,h),p=c.mul(p,j)}return p}}function pa(t){return t%Xn===Zn?rs:t%es===Jn?fa:t%ts===ha?da(t):ns(t)}var ma=["create","isValid","is0","neg","inv","sqrt","sqr","eql","add","sub","mul","pow","div","addN","subN","mulN","sqrN"];function ss(t){let e={ORDER:"bigint",BYTES:"number",BITS:"number"},r=ma.reduce((n,s)=>(n[s]="function",n),e);return pt(t,r),t}function ya(t,e,r){if(r<K)throw new Error("invalid exponent, negatives unsupported");if(r===K)return t.ONE;if(r===F)return e;let n=t.ONE,s=e;for(;r>K;)r&F&&(n=t.mul(n,s)),s=t.sqr(s),r>>=F;return n}function hr(t,e,r=!1){let n=new Array(e.length).fill(r?t.ZERO:void 0),s=e.reduce((o,a,c)=>t.is0(a)?o:(n[c]=o,t.mul(o,a)),t.ONE),i=t.inv(s);return e.reduceRight((o,a,c)=>t.is0(a)?o:(n[c]=t.mul(o,n[c]),t.mul(o,a)),i),n}function Wn(t,e){let r=(t.ORDER-F)/xe,n=t.pow(e,r),s=t.eql(n,t.ONE),i=t.eql(n,t.ZERO),o=t.eql(n,t.neg(t.ONE));if(!s&&!i&&!o)throw new Error("invalid Legendre symbol result");return s?1:i?0:-1}function ga(t,e){e!==void 0&&Ie(e);let r=e!==void 0?e:t.toString(2).length,n=Math.ceil(r/8);return{nBitLength:r,nByteLength:n}}var ur=class{ORDER;BITS;BYTES;isLE;ZERO=K;ONE=F;_lengths;_sqrt;_mod;constructor(e,r={}){if(e<=K)throw new Error("invalid field: expected ORDER > 0, got "+e);let n;this.isLE=!1,r!=null&&typeof r=="object"&&(typeof r.BITS=="number"&&(n=r.BITS),typeof r.sqrt=="function"&&(this.sqrt=r.sqrt),typeof r.isLE=="boolean"&&(this.isLE=r.isLE),r.allowedLengths&&(this._lengths=r.allowedLengths?.slice()),typeof r.modFromBytes=="boolean"&&(this._mod=r.modFromBytes));let{nBitLength:s,nByteLength:i}=ga(e,n);if(i>2048)throw new Error("invalid field: expected ORDER of <= 2048 bytes");this.ORDER=e,this.BITS=s,this.BYTES=i,this._sqrt=void 0,Object.preventExtensions(this)}create(e){return ae(e,this.ORDER)}isValid(e){if(typeof e!="bigint")throw new Error("invalid field element: expected bigint, got "+typeof e);return K<=e&&e<this.ORDER}is0(e){return e===K}isValidNot0(e){return!this.is0(e)&&this.isValid(e)}isOdd(e){return(e&F)===F}neg(e){return ae(-e,this.ORDER)}eql(e,r){return e===r}sqr(e){return ae(e*e,this.ORDER)}add(e,r){return ae(e+r,this.ORDER)}sub(e,r){return ae(e-r,this.ORDER)}mul(e,r){return ae(e*r,this.ORDER)}pow(e,r){return ya(this,e,r)}div(e,r){return ae(e*Yn(r,this.ORDER),this.ORDER)}sqrN(e){return e*e}addN(e,r){return e+r}subN(e,r){return e-r}mulN(e,r){return e*r}inv(e){return Yn(e,this.ORDER)}sqrt(e){return this._sqrt||(this._sqrt=pa(this.ORDER)),this._sqrt(this,e)}toBytes(e){return this.isLE?or(e,this.BYTES):ft(e,this.BYTES)}fromBytes(e,r=!1){q(e);let{_lengths:n,BYTES:s,isLE:i,ORDER:o,_mod:a}=this;if(n){if(!n.includes(e.length)||e.length>s)throw new Error("Field.fromBytes: expected "+n+" bytes, got "+e.length);let u=new Uint8Array(s);u.set(e,i?0:u.length-e.length),e=u}if(e.length!==s)throw new Error("Field.fromBytes: expected "+s+" bytes, got "+e.length);let c=i?ir(e):Ce(e);if(a&&(c=ae(c,o)),!r&&!this.isValid(c))throw new Error("invalid field element: outside of range 0..ORDER");return c}invertBatch(e){return hr(this,e)}cmov(e,r,n){return n?r:e}};function Ne(t,e={}){return new ur(t,e)}function is(t){if(typeof t!="bigint")throw new Error("field order must be bigint");let e=t.toString(2).length;return Math.ceil(e/8)}function ba(t){let e=is(t);return e+Math.ceil(e/2)}function os(t,e,r=!1){q(t);let n=t.length,s=is(e),i=ba(e);if(n<16||n<i||n>1024)throw new Error("expected "+i+"-1024 bytes of input, got "+n);let o=r?ir(t):Ce(t),a=ae(o,e-F)+F;return r?or(a,s):ft(a,s)}var Oe=BigInt(0),Se=BigInt(1);function Ve(t,e){let r=e.negate();return t?r:e}function mr(t,e){let r=hr(t.Fp,e.map(n=>n.Z));return e.map((n,s)=>t.fromAffine(n.toAffine(r[s])))}function ls(t,e){if(!Number.isSafeInteger(t)||t<=0||t>e)throw new Error("invalid window size, expected [1.."+e+"], got W="+t)}function fr(t,e){ls(t,e);let r=Math.ceil(e/t)+1,n=2**(t-1),s=2**t,i=dt(t),o=BigInt(t);return{windows:r,windowSize:n,mask:i,maxNumber:s,shiftBy:o}}function as(t,e,r){let{windowSize:n,mask:s,maxNumber:i,shiftBy:o}=r,a=Number(t&s),c=t>>o;a>n&&(a-=i,c+=Se);let u=e*n,l=u+Math.abs(a)-1,h=a===0,f=a<0,p=e%2!==0;return{nextN:c,offset:l,isZero:h,isNeg:f,isNegF:p,offsetF:u}}var dr=new WeakMap,hs=new WeakMap;function pr(t){return hs.get(t)||1}function cs(t){if(t!==Oe)throw new Error("invalid wNAF")}var mt=class{BASE;ZERO;Fn;bits;constructor(e,r){this.BASE=e.BASE,this.ZERO=e.ZERO,this.Fn=e.Fn,this.bits=r}_unsafeLadder(e,r,n=this.ZERO){let s=e;for(;r>Oe;)r&Se&&(n=n.add(s)),s=s.double(),r>>=Se;return n}precomputeWindow(e,r){let{windows:n,windowSize:s}=fr(r,this.bits),i=[],o=e,a=o;for(let c=0;c<n;c++){a=o,i.push(a);for(let u=1;u<s;u++)a=a.add(o),i.push(a);o=a.double()}return i}wNAF(e,r,n){if(!this.Fn.isValid(n))throw new Error("invalid scalar");let s=this.ZERO,i=this.BASE,o=fr(e,this.bits);for(let a=0;a<o.windows;a++){let{nextN:c,offset:u,isZero:l,isNeg:h,isNegF:f,offsetF:p}=as(n,a,o);n=c,l?i=i.add(Ve(f,r[p])):s=s.add(Ve(h,r[u]))}return cs(n),{p:s,f:i}}wNAFUnsafe(e,r,n,s=this.ZERO){let i=fr(e,this.bits);for(let o=0;o<i.windows&&n!==Oe;o++){let{nextN:a,offset:c,isZero:u,isNeg:l}=as(n,o,i);if(n=a,!u){let h=r[c];s=s.add(l?h.negate():h)}}return cs(n),s}getPrecomputes(e,r,n){let s=dr.get(r);return s||(s=this.precomputeWindow(r,e),e!==1&&(typeof n=="function"&&(s=n(s)),dr.set(r,s))),s}cached(e,r,n){let s=pr(e);return this.wNAF(s,this.getPrecomputes(s,e,n),r)}unsafe(e,r,n,s){let i=pr(e);return i===1?this._unsafeLadder(e,r,s):this.wNAFUnsafe(i,this.getPrecomputes(i,e,n),r,s)}createCache(e,r){ls(r,this.bits),hs.set(e,r),dr.delete(e)}hasCache(e){return pr(e)!==1}};function fs(t,e,r,n){let s=e,i=t.ZERO,o=t.ZERO;for(;r>Oe||n>Oe;)r&Se&&(i=i.add(s)),n&Se&&(o=o.add(s)),s=s.double(),r>>=Se,n>>=Se;return{p1:i,p2:o}}function us(t,e,r){if(e){if(e.ORDER!==t)throw new Error("Field.ORDER must match order: Fp == p, Fn == n");return ss(e),e}else return Ne(t,{isLE:r})}function ds(t,e,r={},n){if(n===void 0&&(n=t==="edwards"),!e||typeof e!="object")throw new Error(`expected valid ${t} CURVE object`);for(let c of["p","n","h"]){let u=e[c];if(!(typeof u=="bigint"&&u>Oe))throw new Error(`CURVE.${c} must be positive bigint`)}let s=us(e.p,r.Fp,n),i=us(e.n,r.Fn,n),a=["Gx","Gy","a",t==="weierstrass"?"b":"d"];for(let c of a)if(!s.isValid(e[c]))throw new Error(`CURVE.${c} must be valid field element of CURVE.Fp`);return e=Object.freeze(Object.assign({},e)),{CURVE:e,Fp:s,Fn:i}}function yr(t,e){return function(n){let s=t(n);return{secretKey:s,publicKey:e(s)}}}var ps=(t,e)=>(t+(t>=0?e:-e)/Ea)/e;function wa(t,e,r){let[[n,s],[i,o]]=e,a=ps(o*t,r),c=ps(-s*t,r),u=t-a*n-c*i,l=-a*s-c*o,h=u<Ke,f=l<Ke;h&&(u=-u),f&&(l=-l);let p=dt(Math.ceil(ar(r)/2))+gt;if(u<Ke||u>=p||l<Ke||l>=p)throw new Error("splitScalar (endomorphism): failed, k="+t);return{k1neg:h,k1:u,k2neg:f,k2:l}}var Ke=BigInt(0),gt=BigInt(1),Ea=BigInt(2),yt=BigInt(3),xa=BigInt(4);function ms(t,e={}){let r=ds("weierstrass",t,e),{Fp:n,Fn:s}=r,i=r.CURVE,{h:o,n:a}=i;pt(e,{},{allowInfinityPoint:"boolean",clearCofactor:"function",isTorsionFree:"function",fromBytes:"function",toBytes:"function",endo:"object"});let{endo:c}=e;if(c&&(!n.is0(i.a)||typeof c.beta!="bigint"||!Array.isArray(c.basises)))throw new Error(\'invalid endo: expected "beta": bigint and "basises": array\');let u=va(n,s);function l(){if(!n.isOdd)throw new Error("compression is not supported: Field does not have .isOdd()")}function h(k,d,m){let{x,y:v}=d.toAffine(),C=n.toBytes(x);if(sr(m,"isCompressed"),m){l();let T=!n.isOdd(v);return fe(Sa(T),C)}else return fe(Uint8Array.of(4),C,n.toBytes(v))}function f(k){q(k,void 0,"Point");let{publicKey:d,publicKeyUncompressed:m}=u,x=k.length,v=k[0],C=k.subarray(1);if(x===d&&(v===2||v===3)){let T=n.fromBytes(C);if(!n.isValid(T))throw new Error("bad point: is not on curve, wrong x");let _=y(T),b;try{b=n.sqrt(_)}catch(ee){let U=ee instanceof Error?": "+ee.message:"";throw new Error("bad point: is not on curve, sqrt error"+U)}l();let A=n.isOdd(b);return(v&1)===1!==A&&(b=n.neg(b)),{x:T,y:b}}else if(x===m&&v===4){let T=n.BYTES,_=n.fromBytes(C.subarray(0,T)),b=n.fromBytes(C.subarray(T,T*2));if(!P(_,b))throw new Error("bad point: is not on curve");return{x:_,y:b}}else throw new Error(`bad point: got length ${x}, expected compressed=${d} or uncompressed=${m}`)}let p=e.toBytes||h,S=e.fromBytes||f;function y(k){let d=n.sqr(k),m=n.mul(d,k);return n.add(n.add(m,n.mul(k,i.a)),i.b)}function P(k,d){let m=n.sqr(d),x=y(k);return n.eql(m,x)}if(!P(i.Gx,i.Gy))throw new Error("bad curve params: generator point");let j=n.mul(n.pow(i.a,yt),xa),ce=n.mul(n.sqr(i.b),BigInt(27));if(n.is0(n.add(j,ce)))throw new Error("bad curve params: a or b");function re(k,d,m=!1){if(!n.isValid(d)||m&&n.is0(d))throw new Error(`bad point coordinate ${k}`);return d}function le(k){if(!(k instanceof L))throw new Error("Weierstrass Point expected")}function Re(k){if(!c||!c.basises)throw new Error("no endo");return wa(k,c.basises,s.ORDER)}let ze=cr((k,d)=>{let{X:m,Y:x,Z:v}=k;if(n.eql(v,n.ONE))return{x:m,y:x};let C=k.is0();d==null&&(d=C?n.ONE:n.inv(v));let T=n.mul(m,d),_=n.mul(x,d),b=n.mul(v,d);if(C)return{x:n.ZERO,y:n.ZERO};if(!n.eql(b,n.ONE))throw new Error("invZ was invalid");return{x:T,y:_}}),Zo=cr(k=>{if(k.is0()){if(e.allowInfinityPoint&&!n.is0(k.Y))return;throw new Error("bad point: ZERO")}let{x:d,y:m}=k.toAffine();if(!n.isValid(d)||!n.isValid(m))throw new Error("bad point: x or y not field elements");if(!P(d,m))throw new Error("bad point: equation left != right");if(!k.isTorsionFree())throw new Error("bad point: not in prime-order subgroup");return!0});function Mn(k,d,m,x,v){return m=new L(n.mul(m.X,k),m.Y,m.Z),d=Ve(x,d),m=Ve(v,m),d.add(m)}class L{static BASE=new L(i.Gx,i.Gy,n.ONE);static ZERO=new L(n.ZERO,n.ONE,n.ZERO);static Fp=n;static Fn=s;X;Y;Z;constructor(d,m,x){this.X=re("x",d),this.Y=re("y",m,!0),this.Z=re("z",x),Object.freeze(this)}static CURVE(){return i}static fromAffine(d){let{x:m,y:x}=d||{};if(!d||!n.isValid(m)||!n.isValid(x))throw new Error("invalid affine point");if(d instanceof L)throw new Error("projective point not allowed");return n.is0(m)&&n.is0(x)?L.ZERO:new L(m,x,n.ONE)}static fromBytes(d){let m=L.fromAffine(S(q(d,void 0,"point")));return m.assertValidity(),m}static fromHex(d){return L.fromBytes(oe(d))}get x(){return this.toAffine().x}get y(){return this.toAffine().y}precompute(d=8,m=!0){return je.createCache(this,d),m||this.multiply(yt),this}assertValidity(){Zo(this)}hasEvenY(){let{y:d}=this.toAffine();if(!n.isOdd)throw new Error("Field doesn\'t support isOdd");return!n.isOdd(d)}equals(d){le(d);let{X:m,Y:x,Z:v}=this,{X:C,Y:T,Z:_}=d,b=n.eql(n.mul(m,_),n.mul(C,v)),A=n.eql(n.mul(x,_),n.mul(T,v));return b&&A}negate(){return new L(this.X,n.neg(this.Y),this.Z)}double(){let{a:d,b:m}=i,x=n.mul(m,yt),{X:v,Y:C,Z:T}=this,_=n.ZERO,b=n.ZERO,A=n.ZERO,R=n.mul(v,v),ee=n.mul(C,C),U=n.mul(T,T),N=n.mul(v,C);return N=n.add(N,N),A=n.mul(v,T),A=n.add(A,A),_=n.mul(d,A),b=n.mul(x,U),b=n.add(_,b),_=n.sub(ee,b),b=n.add(ee,b),b=n.mul(_,b),_=n.mul(N,_),A=n.mul(x,A),U=n.mul(d,U),N=n.sub(R,U),N=n.mul(d,N),N=n.add(N,A),A=n.add(R,R),R=n.add(A,R),R=n.add(R,U),R=n.mul(R,N),b=n.add(b,R),U=n.mul(C,T),U=n.add(U,U),R=n.mul(U,N),_=n.sub(_,R),A=n.mul(U,ee),A=n.add(A,A),A=n.add(A,A),new L(_,b,A)}add(d){le(d);let{X:m,Y:x,Z:v}=this,{X:C,Y:T,Z:_}=d,b=n.ZERO,A=n.ZERO,R=n.ZERO,ee=i.a,U=n.mul(i.b,yt),N=n.mul(m,C),ne=n.mul(x,T),se=n.mul(v,_),ke=n.add(m,x),V=n.add(C,T);ke=n.mul(ke,V),V=n.add(N,ne),ke=n.sub(ke,V),V=n.add(m,v);let ue=n.add(C,_);return V=n.mul(V,ue),ue=n.add(N,se),V=n.sub(V,ue),ue=n.add(x,v),b=n.add(T,_),ue=n.mul(ue,b),b=n.add(ne,se),ue=n.sub(ue,b),R=n.mul(ee,V),b=n.mul(U,se),R=n.add(b,R),b=n.sub(ne,R),R=n.add(ne,R),A=n.mul(b,R),ne=n.add(N,N),ne=n.add(ne,N),se=n.mul(ee,se),V=n.mul(U,V),ne=n.add(ne,se),se=n.sub(N,se),se=n.mul(ee,se),V=n.add(V,se),N=n.mul(ne,V),A=n.add(A,N),N=n.mul(ue,V),b=n.mul(ke,b),b=n.sub(b,N),N=n.mul(ke,ne),R=n.mul(ue,R),R=n.add(R,N),new L(b,A,R)}subtract(d){return this.add(d.negate())}is0(){return this.equals(L.ZERO)}multiply(d){let{endo:m}=e;if(!s.isValidNot0(d))throw new Error("invalid scalar: out of range");let x,v,C=T=>je.cached(this,T,_=>mr(L,_));if(m){let{k1neg:T,k1:_,k2neg:b,k2:A}=Re(d),{p:R,f:ee}=C(_),{p:U,f:N}=C(A);v=ee.add(N),x=Mn(m.beta,R,U,T,b)}else{let{p:T,f:_}=C(d);x=T,v=_}return mr(L,[x,v])[0]}multiplyUnsafe(d){let{endo:m}=e,x=this;if(!s.isValid(d))throw new Error("invalid scalar: out of range");if(d===Ke||x.is0())return L.ZERO;if(d===gt)return x;if(je.hasCache(this))return this.multiply(d);if(m){let{k1neg:v,k1:C,k2neg:T,k2:_}=Re(d),{p1:b,p2:A}=fs(L,x,C,_);return Mn(m.beta,b,A,v,T)}else return je.unsafe(x,d)}toAffine(d){return ze(this,d)}isTorsionFree(){let{isTorsionFree:d}=e;return o===gt?!0:d?d(L,this):je.unsafe(this,a).is0()}clearCofactor(){let{clearCofactor:d}=e;return o===gt?this:d?d(L,this):this.multiplyUnsafe(o)}isSmallOrder(){return this.multiplyUnsafe(o).is0()}toBytes(d=!0){return sr(d,"isCompressed"),this.assertValidity(),p(L,this,d)}toHex(d=!0){return $(this.toBytes(d))}toString(){return`<Point ${this.is0()?"ZERO":this.toHex()}>`}}let qn=s.BITS,je=new mt(L,e.endo?Math.ceil(qn/2):qn);return L.BASE.precompute(8),L}function Sa(t){return Uint8Array.of(t?2:3)}function va(t,e){return{secretKey:e.BYTES,publicKey:1+t.BYTES,publicKeyUncompressed:1+2*t.BYTES,publicKeyHasPrefix:!0,signature:2*e.BYTES}}var Et={p:BigInt("0xfffffffffffffffffffffffffffffffffffffffffffffffffffffffefffffc2f"),n:BigInt("0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141"),h:BigInt(1),a:BigInt(0),b:BigInt(7),Gx:BigInt("0x79be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798"),Gy:BigInt("0x483ada7726a3c4655da4fbfc0e1108a8fd17b448a68554199c47d08ffb10d4b8")},_a={beta:BigInt("0x7ae96a2b657c07106e64479eac3434e99cf0497512f58995c1396c28719501ee"),basises:[[BigInt("0x3086d221a7d46bcde86c90e49284eb15"),-BigInt("0xe4437ed6010e88286f547fa90abfe4c3")],[BigInt("0x114ca50f7a8e2f3f657c1108d9d44cfd8"),BigInt("0x3086d221a7d46bcde86c90e49284eb15")]]},Aa=BigInt(0),gr=BigInt(2);function Ta(t){let e=Et.p,r=BigInt(3),n=BigInt(6),s=BigInt(11),i=BigInt(22),o=BigInt(23),a=BigInt(44),c=BigInt(88),u=t*t*t%e,l=u*u*t%e,h=W(l,r,e)*l%e,f=W(h,r,e)*l%e,p=W(f,gr,e)*u%e,S=W(p,s,e)*p%e,y=W(S,i,e)*S%e,P=W(y,a,e)*y%e,j=W(P,c,e)*P%e,ce=W(j,a,e)*y%e,re=W(ce,r,e)*l%e,le=W(re,o,e)*S%e,Re=W(le,n,e)*u%e,ze=W(Re,gr,e);if(!bt.eql(bt.sqr(ze),t))throw new Error("Cannot find square root");return ze}var bt=Ne(Et.p,{sqrt:Ta}),Be=ms(Et,{Fp:bt,endo:_a});var ys={};function wt(t,...e){let r=ys[t];if(r===void 0){let n=Ee(Kn(t));r=fe(n,n),ys[t]=r}return Ee(fe(r,...e))}var wr=t=>t.toBytes(!0).slice(1),Er=t=>t%gr===Aa;function br(t){let{Fn:e,BASE:r}=Be,n=e.fromBytes(t),s=r.multiply(n);return{scalar:Er(s.y)?n:e.neg(n),bytes:wr(s)}}function bs(t){let e=bt;if(!e.isValidNot0(t))throw new Error("invalid x: Fail if x \\u2265 p");let r=e.create(t*t),n=e.create(r*t+BigInt(7)),s=e.sqrt(n);Er(s)||(s=e.neg(s));let i=Be.fromAffine({x:t,y:s});return i.assertValidity(),i}var Ye=Ce;function ws(...t){return Be.Fn.create(Ye(wt("BIP0340/challenge",...t)))}function gs(t){return br(t).bytes}function Ra(t,e,r=Ge(32)){let{Fn:n}=Be,s=q(t,void 0,"message"),{bytes:i,scalar:o}=br(e),a=q(r,32,"auxRand"),c=n.toBytes(o^Ye(wt("BIP0340/aux",a))),u=wt("BIP0340/nonce",c,i,s),{bytes:l,scalar:h}=br(u),f=ws(l,i,s),p=new Uint8Array(64);if(p.set(l,0),p.set(n.toBytes(n.create(h+f*o)),32),!Es(p,s,i))throw new Error("sign: Invalid signature produced");return p}function Es(t,e,r){let{Fp:n,Fn:s,BASE:i}=Be,o=q(t,64,"signature"),a=q(e,void 0,"message"),c=q(r,32,"publicKey");try{let u=bs(Ye(c)),l=Ye(o.subarray(0,32));if(!n.isValidNot0(l))return!1;let h=Ye(o.subarray(32,64));if(!s.isValidNot0(h))return!1;let f=ws(s.toBytes(l),wr(u),a),p=i.multiplyUnsafe(h).add(u.multiplyUnsafe(s.neg(f))),{x:S,y}=p.toAffine();return!(p.is0()||!Er(y)||S!==l)}catch{return!1}}var ge=(()=>{let r=(n=Ge(48))=>os(n,Et.n);return{keygen:yr(r,gs),getPublicKey:gs,sign:Ra,verify:Es,Point:Be,utils:{randomSecretKey:r,taggedHash:wt,lift_x:bs,pointToBytes:wr},lengths:{secretKey:32,publicKey:32,publicKeyHasPrefix:!1,signature:64,seed:48}}})();var yf=new TextDecoder("utf-8"),ka=new TextEncoder;function Ia(t){if(t.length!==64)return!1;for(let e=0;e<64;e++){let r=t.charCodeAt(e);if(isNaN(r)||r<48||r>102||r>57&&r<97)return!1}return!0}var Pe=Symbol("verified"),Ca=t=>t instanceof Object;function Na(t){if(!Ca(t)||typeof t.kind!="number"||typeof t.content!="string"||typeof t.created_at!="number"||typeof t.pubkey!="string"||!Ia(t.pubkey)||!Array.isArray(t.tags))return!1;for(let e=0;e<t.tags.length;e++){let r=t.tags[e];if(!Array.isArray(r))return!1;for(let n=0;n<r.length;n++)if(typeof r[n]!="string")return!1}return!0}var Oa=class{generateSecretKey(){return ge.utils.randomSecretKey()}getPublicKey(t){return $(ge.getPublicKey(t))}finalizeEvent(t,e){let r=t;return r.pubkey=$(ge.getPublicKey(e)),r.id=xr(r),r.sig=$(ge.sign(oe(xr(r)),e)),r[Pe]=!0,r}verifyEvent(t){if(typeof t[Pe]=="boolean")return t[Pe];try{let e=xr(t);if(e!==t.id)return t[Pe]=!1,!1;let r=ge.verify(oe(t.sig),oe(e),oe(t.pubkey));return t[Pe]=r,r}catch{return t[Pe]=!1,!1}}};function Ba(t){if(!Na(t))throw new Error("can\'t serialize event with wrong or missing properties");return JSON.stringify([0,t.pubkey,t.created_at,t.kind,t.tags,t.content])}function xr(t){let e=Ee(ka.encode(Ba(t)));return $(e)}var xt=new Oa,bf=xt.generateSecretKey,xs=xt.getPublicKey,Ss=xt.finalizeEvent,Le=xt.verifyEvent;import{createServer as Fa}from"node:http";var pe=[9,40002],Pa="buzz.solo",La=48e3,vs=/^[0-9a-f]{64}$/,Da=/^[0-9a-f]{128}$/,Ma=/^(kind=|created_at<|created_at>)(0|[1-9][0-9]*)$/,qa=(t,e)=>t.tags.find(r=>r[0]===e)?.[1],$a=t=>{let e=qa(t,"h");return e&&/^[a-zA-Z0-9_-]{1,128}$/.test(e)?e:void 0};function Sr(t){let e,r;for(let n of t.tags)n[0]!=="e"||!vs.test(n[1]??"")||(n[3]==="root"?e=n[1]:n[3]==="reply"&&(r=n[1]));return e??r}var _s=(t,e)=>pe.includes(t.kind)&&t.pubkey!==e&&t.tags.some(r=>r[0]==="p"&&r[1]===e);function Ua(t){let e=t.tags.filter(a=>a[0]==="auth");if(e.length!==1)return;let[,r="",n="",s=""]=e[0];if(e[0].length!==4||!vs.test(r)||!Da.test(s)||r===t.pubkey)return;let i=n?n.split("&"):[];if(!i.every(a=>Ma.test(a)))return;for(let a of i){let c=Number(a.replace(/^[^0-9]+/,""));if(a.startsWith("kind=")&&t.kind!==c||a.startsWith("created_at<")&&!(t.created_at<c)||a.startsWith("created_at>")&&!(t.created_at>c))return}let o=Ee(new TextEncoder().encode(`nostr:agent-auth:${t.pubkey}:${n}`));try{return ge.verify(Buffer.from(s,"hex"),o,Buffer.from(r,"hex"))?r:void 0}catch{return}}var As=(t,e)=>t.pubkey===e||Ua(t)===e;function Ts(t){if(!t)return{solo:!1};let[e,...r]=t.tags.flatMap(n=>n[0]==="t"&&typeof n[1]=="string"?[n[1]]:[]);return{...e&&{type:e},solo:e==="stream"&&r.includes(Pa)}}function Rs(t,e,r){let n=$a(t);if(!n)return;let s=Sr(t),i=s??t.id,o=r.type==="dm",a=r.solo,c=a||o||e==="channel";return{key:c?n:`${n}/${i}`,channel:n,root:i,topLevel:a,dm:o,fresh:!s&&!c}}function ks(t){return t.fresh?[]:!t.topLevel&&!t.dm&&t.key!==t.channel?[{ids:[t.root],"#h":[t.channel],limit:1},{kinds:pe,"#h":[t.channel],"#e":[t.root],limit:200}]:[{kinds:pe,"#h":[t.channel],limit:13}]}var We=t=>t.replace(/\\[([^\\]]*)\\]\\(nostr:[^)]+\\)/g,"").replace(/nostr:(npub|nprofile|note|nevent)1[0-9a-z]+/g,"").replace(/^\\s*@\\S+\\s*/,"").replace(/[ \\t]+/g," ").trim();function Is(t,e=La){let r=i=>Buffer.byteLength(i);if(r(t)<=e)return[t];let n=[],s=t;for(;r(s)>e;){let i=e;for(;r(s.slice(0,i))>e;)i=Math.floor(i*.9);let o=s.slice(0,i),a=Math.max(o.lastIndexOf(`\n\n`),o.lastIndexOf(`\n`)),c=a>i/2?a:i;n.push(s.slice(0,c).trimEnd()),s=s.slice(c).trimStart()}return s&&n.push(s),n}function Cs(t){return{kind:9,created_at:Math.floor(Date.now()/1e3),content:t.content,tags:[["h",t.conversation.channel],...t.conversation.topLevel?[]:[["e",t.conversation.root,"","reply"]],...(typeof t.notify=="string"?[t.notify]:t.notify??[]).map(e=>["p",e]),[...t.authTag]]}}function Ns(t){return{kind:0,created_at:Math.floor(Date.now()/1e3),content:JSON.stringify({name:t.name,display_name:t.name,bot:!0,...t.picture&&{picture:t.picture},...t.about&&{about:t.about}}),tags:[[...t.authTag]]}}import{createHash as Ha,randomUUID as Qa}from"node:crypto";var za=t=>Ha("sha256").update(t).digest("hex"),St=class{constructor(e,r,n,s){this.url=e;this.secretKey=r;this.authTag=n;this.log=s;this.base=e.replace(/^ws/,"http").replace(/\\/+$/,"")}base;ready=!1;watching=new Set;closed=!1;sign(e){return Ss(e,this.secretKey)}async post(e,r){let n=`${this.base}${e}`,s=this.sign({kind:27235,created_at:Math.floor(Date.now()/1e3),content:"",tags:[["u",n],["method","POST"],["payload",za(r)],["nonce",Qa()]]}),i=await fetch(n,{method:"POST",headers:{authorization:`Nostr ${Buffer.from(JSON.stringify(s)).toString("base64")}`,"content-type":"application/json","x-auth-tag":JSON.stringify(this.authTag)},body:r,signal:AbortSignal.timeout(2e4)}),o=await i.text();if(!i.ok)throw this.ready=!1,Object.assign(new Error(`${i.status} ${o.slice(0,300)}`.trim()),{status:i.status});return this.ready=!0,JSON.parse(o)}async publish(e){let r=e.tags.filter(i=>i[0]!=="auth"&&i[0]!=="ms");r.some(i=>i[0]==="h")&&r.push(["ms",String(Date.now()%1e3)]),r.push([...this.authTag]);let n=this.sign({...e,tags:r}),s=await this.post("/events",JSON.stringify(n));if(!s.accepted&&!s.message?.startsWith("duplicate"))throw new Error(s.message||"The community refused the event.");return n}async query(e){if(!e.length)return[];let r=await this.post("/query",JSON.stringify(e));return Array.isArray(r)?r:[]}watch(e,r,n,s=3e3){let i=new Set,o=r,a=0,c,u=async()=>{if(this.closed)return;let l=s;try{let h=await this.query([{...e,since:o-5}]);a=0;for(let f of h.sort((p,S)=>p.created_at-S.created_at))i.has(f.id)||(i.add(f.id),o=Math.max(o,f.created_at),n(f));if(i.size>2e3)for(let f of[...i].slice(0,1e3))i.delete(f)}catch(h){let f=h.message??String(h),p=/retry in (\\d+)s/.exec(f);l=p?Number(p[1])*1e3:Math.min(6e4,s*2**++a),this.log(`poll failed (${f.slice(0,160)}); next in ${Math.round(l/1e3)}s`)}this.closed||(c=setTimeout(()=>void u(),l),this.watching.add(c))};return u(),()=>{c&&clearTimeout(c)}}close(){this.closed=!0;for(let e of this.watching)clearTimeout(e)}};function ja(t,e){let r=t.root;return{kind:20002,created_at:Math.floor(Date.now()/1e3),content:"",tags:[["h",t.channel],...t.topLevel?[]:[...r===e.id?[]:[["e",r,"","root"]],["e",e.id,"","reply"]]]}}var vt=class{constructor(e,r){this.publish=e;this.log=r}pulses=new Map;start(e,r){let n=e.topLevel?e.channel:e.key,s=this.pulses.get(n);if(!s){let a={turns:0,stop:()=>{}};a.stop=this.pulse(e,r,()=>{this.pulses.get(n)===a&&this.pulses.delete(n)}),this.pulses.set(n,a),s=a}let i=s;i.turns++;let o=!1;return()=>{o||(o=!0,--i.turns===0&&i.stop())}}pulse(e,r,n){let s=Date.now(),i=!1,o=0,a=()=>{clearInterval(u),n()},c=()=>{if(Date.now()-s>=18e5)return a();i||(i=!0,this.publish(ja(e,r)).then(()=>{i=!1,o=0},l=>{i=!1,!(++o<3)&&(a(),this.log(`stopped showing typing in ${e.key}: ${l.message}`))}))},u=setInterval(c,3e3);return u.unref?.(),c(),a}};var _t=class{constructor(e=36e5,r=()=>Date.now()){this.quietMs=e;this.now=r}told=new Map;take(e,r,n){let s=this.now(),i=`${e}|${r}|${n}`,o=this.told.get(i);if(o!==void 0&&s-o<this.quietMs)return!1;if(this.told.set(i,s),this.told.size>1e3)for(let[a,c]of this.told)s-c>=this.quietMs&&this.told.delete(a);return!0}};var Os=/^[0-9a-f]{64}$/;function Bs(t){if(t)try{let e=JSON.parse(t);return e.v!==1||typeof e.key!="string"||!Os.test(e.key)?void 0:{v:1,key:e.key,...typeof e.relay=="string"&&e.relay&&{relay:e.relay},...typeof e.owner=="string"&&Os.test(e.owner)&&{owner:e.owner},...Array.isArray(e.auth)&&e.auth.every(r=>typeof r=="string")&&{auth:e.auth},...typeof e.name=="string"&&e.name&&{name:e.name},...typeof e.picture=="string"&&e.picture&&{picture:e.picture},...(e.answers==="owner"||e.answers==="everyone")&&{answers:e.answers},...typeof e.app=="string"&&e.app&&{app:e.app},...typeof e.workspace=="string"&&e.workspace&&{workspace:e.workspace}}}catch{return}}var Ps=t=>!!(t?.relay&&t.owner&&t.auth?.length);var Ls=t=>Uint8Array.from(Buffer.from(t,"hex")),Ga=()=>Math.floor(Date.now()/1e3),Va="Hi! I only take requests from the person who set me up, so I can\'t help with this one. I\'ve let them know you asked.",_r=class{constructor(e=process.env){this.env=e;let r=(e.DATABRICKS_HOST??"").trim().replace(/\\/+$/,"");this.host=r?/^https?:\\/\\//.test(r)?r:`https://${r}`:""}host;cached;me;async token(){if(this.cached&&Date.now()<this.cached.until)return this.cached.token;let e=this.env.DATABRICKS_CLIENT_ID,r=this.env.DATABRICKS_CLIENT_SECRET;if(!this.host||!e||!r)throw new Error("DATABRICKS_HOST, DATABRICKS_CLIENT_ID and DATABRICKS_CLIENT_SECRET aren\'t set; this runs as a Databricks App.");let n=await fetch(`${this.host}/oidc/v1/token`,{method:"POST",headers:{authorization:`Basic ${Buffer.from(`${e}:${r}`).toString("base64")}`,"content-type":"application/x-www-form-urlencoded"},body:"grant_type=client_credentials&scope=all-apis",signal:AbortSignal.timeout(2e4)}),s=await n.json().catch(()=>({}));if(!n.ok||!s.access_token)throw new Error(`Couldn\'t sign in as the app\'s service principal: ${s.error_description??`HTTP ${n.status}`}`);return this.cached={token:s.access_token,until:Date.now()+Math.max(60,(s.expires_in??3600)-60)*1e3},s.access_token}async api(e,r={}){let n=new URL(`${this.host}${e}`);for(let[o,a]of Object.entries(r.query??{}))n.searchParams.set(o,a);let s=await fetch(n,{method:r.method??(r.body===void 0?"GET":"POST"),headers:{authorization:`Bearer ${await this.token()}`,accept:"application/json",...r.body!==void 0&&{"content-type":"application/json"}},...r.body!==void 0&&{body:JSON.stringify(r.body)},signal:AbortSignal.timeout(6e4)}),i=await s.text();if(!s.ok){let o=`HTTP ${s.status}`;try{o=JSON.parse(i).message||o}catch{}throw Object.assign(new Error(o),{status:s.status})}return i.trim()?JSON.parse(i):{}}async secret(e){try{let r=await this.api(`/api/2.1/unity-catalog/secrets/${e.split(".").map(encodeURIComponent).join(".")}`,{query:{include_value:"true"}});return r.effective_value??r.value??""}catch(r){if(r.status===404)return;throw r}}whoami(){return this.me??=this.api("/api/2.0/preview/scim/v2/Me").then(e=>({applicationId:e.applicationId??e.userName??"",displayName:e.displayName??e.userName??""}),e=>{throw this.me=void 0,e}),this.me}},At=class{constructor(e={}){this.options=e;this.env=e.env??process.env,this.databricks=new _r(this.env);let r=e.log??(n=>console.log(`[buzz] ${n}`));this.log=n=>{/^poll failed/.test(n)&&(this.relayError=n.replace(/^poll failed \\((.*)\\); next in .*$/,"$1")),r(n)}}databricks;identity;pubkey;relay;state="starting";lastError;handlers=[];connects=[];disconnects=[];routes=new Map;extras=[];stopWatch;refreshTimer;server;typing;publishedProfile;handled=new Set;queues=new Map;channels=new Map;notes=new _t;startedAt=Date.now();answered=0;lastMention;log;relayError;runsAs;env;get secretName(){return this.options.identitySecret??this.env.BUZZ_IDENTITY_SECRET??""}get appName(){return this.env.DATABRICKS_APP_NAME??this.identity?.app??""}onMention(e){return this.handlers.push(e),this}onConnect(e){return this.connects.push(e),this}route(e,r){return this.routes.set(e,r),this}describe(e){return this.extras.push(e),this}async start(){let e=this.options.port??Number(this.env.DATABRICKS_APP_PORT||8e3);this.server=Fa((r,n)=>{let s=new URL(r.url??"/","http://app"),i=this.routes.get(s.pathname);if(i)return void this.serve(i,r,s,n);let o=this.status();if(s.pathname.startsWith("/api/status"))return n.writeHead(200,{"content-type":"application/json"}),n.end(JSON.stringify(o));n.writeHead(200,{"content-type":"text/html; charset=utf-8"}),n.end(Ya(o))}),await new Promise(r=>this.server.listen(e,r)),this.databricks.whoami().then(r=>this.runsAs=r,r=>this.log(`couldn\'t sign in to Databricks as the app\'s service principal: ${r.message}`)),process.once("SIGTERM",()=>{this.stop(),process.exit(0)}),await this.refresh()}async serve(e,r,n,s){let i=c=>{let u=r.headers[c];return typeof u=="string"&&u?u:void 0},o;try{let c=i("x-forwarded-email"),u=i("x-forwarded-access-token");o=await e({method:r.method??"GET",url:n,...c&&{user:c},...u&&{userToken:u},body:()=>new Promise((l,h)=>{let f="";r.setEncoding("utf8"),r.on("data",p=>f+=p),r.on("end",()=>l(f)),r.on("error",h)})})}catch(c){o={status:500,json:{error:c.message??String(c)}}}let a=o.json!==void 0?"application/json":o.html!==void 0?"text/html; charset=utf-8":"text/plain; charset=utf-8";s.writeHead(o.status??200,{"content-type":a}),s.end(o.json!==void 0?JSON.stringify(o.json):o.html??o.text??"")}stop(){this.stopWatch?.(),this.relay?.close(),this.refreshTimer&&clearTimeout(this.refreshTimer),this.server?.close()}status(){let e=this.state==="connected"&&!this.relay?.ready,r=this.lastError??(e&&this.relayError?`Can\'t reach the Buzz community: ${this.relayError}`:void 0),n={state:e?"connecting":this.state,...r&&{lastError:r},...this.pubkey&&{pubkey:this.pubkey},...this.identity?.name&&{name:this.identity.name},...this.identity?.owner&&{owner:this.identity.owner},app:this.appName,secret:this.secretName,connected:this.relay?.ready??!1,...this.runsAs&&{runsAs:this.runsAs},answered:this.answered,startedAt:new Date(this.startedAt).toISOString(),...this.lastMention&&{lastMention:new Date(this.lastMention).toISOString()}},s={};for(let i of this.extras)try{Object.assign(s,i())}catch{}return{...s,...n,...Object.keys(s).length&&{extra:s}}}publish(e){if(!this.relay)throw new Error("Not signed in to Buzz yet.");return this.relay.publish(e)}query(e){if(!this.relay)throw new Error("Not signed in to Buzz yet.");return this.relay.query(e)}schedule(e){this.refreshTimer&&clearTimeout(this.refreshTimer),this.refreshTimer=setTimeout(()=>void this.refresh(),e),this.refreshTimer.unref?.()}async refresh(){let e=this.options.refreshMs??(Number(this.env.BUZZ_REFRESH_MS)||6e4);if(!this.secretName){this.state="error",this.lastError="BUZZ_IDENTITY_SECRET isn\'t set. Add it to app.yaml (the Databricks Agents plugin shows the line to add).";return}let r;try{let s=await this.databricks.secret(this.secretName);if(s===void 0)return this.relay&&this.log("the identity\'s secret is gone; signing out"),this.signOut(),this.state="removed",this.lastError=`${this.secretName} doesn\'t exist (anymore). The identity was removed in Buzz, or the name is wrong.`,this.schedule(e);if(r=Bs(s),!r)throw new Error(`${this.secretName} isn\'t a Buzz identity.`)}catch(s){return this.state="error",this.lastError=`Couldn\'t read ${this.secretName}: ${s.message}`,this.log(this.lastError),this.schedule(Math.min(e,3e4))}let n=this.identity;if(this.identity=r,this.pubkey=xs(Ls(r.key)),!Ps(r))return this.state="waiting",this.lastError=void 0,this.schedule(Math.min(e,1e4));(!this.relay||n?.key!==r.key||n?.relay!==r.relay||n?.auth?.join()!==r.auth.join())&&this.signIn(r),this.state="connected",this.lastError=void 0,await this.publishProfile(r),this.schedule(e)}signOut(){for(let e of this.disconnects.splice(0))try{e()}catch{}this.stopWatch?.(),this.stopWatch=void 0,this.relay?.close(),this.relay=void 0,this.publishedProfile=void 0}signIn(e){this.signOut();let r=new St(e.relay,Ls(e.key),e.auth,this.log);this.relay=r,this.typing=new vt(n=>r.publish(n),this.log),this.log(`signing in as ${this.pubkey.slice(0,12)}\\u2026 for ${e.name??"this app"}`),this.stopWatch=r.watch({kinds:pe,"#p":[this.pubkey]},Ga()-60,n=>this.onEvent(n),this.options.pollMs??3e3);for(let n of this.connects)Promise.resolve().then(()=>n(this)).then(s=>{typeof s=="function"&&(this.relay===r?this.disconnects.push(s):s())},s=>this.log(`a connect handler failed: ${s.message??s}`))}async publishProfile(e){let r=e.name||this.appName||"Buzz app",n=this.options.about;if(!n){let i=await this.databricks.whoami().catch(()=>{});i&&(this.runsAs=i);let o=e.workspace?` in ${e.workspace.replace(/^https:\\/\\//,"")}`:"";n=`A Databricks App${this.appName?` (${this.appName})`:""}${o}${i?`, running as the service principal ${i.displayName||i.applicationId} (${i.applicationId})`:""}.`}let s=JSON.stringify([r,e.picture??"",n]);if(!(this.publishedProfile===s||!this.relay))try{await this.relay.publish(Ns({name:r,...e.picture&&{picture:e.picture},about:n,authTag:e.auth})),this.publishedProfile=s,this.log("published the profile")}catch(i){this.log(`profile not published yet: ${i.message}`)}}allowed(e){let r=this.identity?.owner??"";if(As(e,r))return!0;let n=this.options.answers??this.identity?.answers??"everyone";return n==="everyone"?!0:n==="owner"?!1:n.includes(e.pubkey)}async kindOf(e){let r=this.channels.get(e);if(r&&Date.now()-r.at<10*6e4)return r.kind;let[n]=await this.query([{kinds:[39e3],"#d":[e],limit:1}]),s=Ts(n);return this.channels.set(e,{at:Date.now(),kind:s}),s}onEvent(e){let r=this.pubkey;if(this.handled.has(e.id)||!Le(e)||!_s(e,r))return;if(this.handled.add(e.id),this.handled.size>5e3)for(let s of[...this.handled].slice(0,2500))this.handled.delete(s);let n=e.tags.find(s=>s[0]==="h")?.[1];n&&this.kindOf(n).catch(()=>({solo:!1})).then(s=>{let i=Rs(e,this.options.scope??"thread",s);if(!i)return;let o=(this.queues.get(i.key)??Promise.resolve()).then(()=>this.handle(e,i));this.queues.set(i.key,o.catch(()=>{}))})}async say(e,r,n){for(let s of Is(r))await this.publish(Cs({conversation:e,content:s,authTag:this.identity.auth,...n&&{notify:n}}))}async handle(e,r){let n=this.identity?.owner??"";if(!this.allowed(e)){this.notes.take(this.pubkey,e.pubkey,r.key)&&await this.say(r,Va,[e.pubkey,n]).catch(()=>{}),this.log(`ignored ${e.id.slice(0,8)}: not someone it answers`);return}this.lastMention=Date.now();let s=[],i={say:c=>this.say(r,c),typing:()=>{let c=this.typing?.start(r,e)??(()=>{});return s.push(c),c},history:async()=>(await this.query(ks(r))).filter(u=>u.id!==e.id&&pe.includes(u.kind)&&u.created_at<=e.created_at).sort((u,l)=>u.created_at-l.created_at)},o=r.root!==e.id?r.root:void 0,a={id:e.id,channel:r.channel,...o&&{thread:o},author:e.pubkey,text:We(e.content),content:e.content,createdAt:e.created_at,conversation:r,event:e};try{for(let c of this.handlers)await c(a,i);this.answered++}catch(c){let u=c.message??String(c);this.lastError=u,this.log(`a mention failed: ${u}`),await this.say(r,`I couldn\'t finish that: ${u}`).catch(()=>{})}finally{for(let c of s)c()}}},vr=t=>t.replace(/[&<>"]/g,e=>({"&":"&amp;","<":"&lt;",">":"&gt;",\'"\':"&quot;"})[e]),Ka={starting:"Starting",waiting:"Waiting for Buzz to finish setting up this identity",connecting:"Reaching the Buzz community",connected:"Signed in to Buzz",removed:"Its identity was removed",error:"Something\'s wrong"};function Ya(t){let e=[["Status",Ka[t.state]],["Problem",t.lastError],["Buzz identity",t.pubkey],["Runs as",t.runsAs&&`${t.runsAs.displayName} (${t.runsAs.applicationId})`],["Name",t.name],["Owner",t.owner],["Identity secret",t.secret],["Mentions answered",String(t.answered)],...Object.entries(t.extra??{}).map(([r,n])=>[r,typeof n=="object"?JSON.stringify(n):String(n)]),["Started",t.startedAt]];return`<!doctype html><meta charset="utf-8"><title>${vr(t.name??t.app??"Buzz app")}</title>\n<style>body{font:14px system-ui,sans-serif;margin:40px;color:#1b1f23}td{padding:4px 16px 4px 0;vertical-align:top}td:first-child{color:#666}code{font-size:12px}</style>\n<h1>${vr(t.name??t.app??"Buzz app")}</h1><table>${e.filter(([,r])=>r).map(([r,n])=>`<tr><td>${r}</td><td><code>${vr(n)}</code></td></tr>`).join("")}</table>`}function $s(t){return t instanceof Uint8Array||ArrayBuffer.isView(t)&&t.constructor.name==="Uint8Array"}function Us(t,e){return Array.isArray(e)?e.length===0?!0:t?e.every(r=>typeof r=="string"):e.every(r=>Number.isSafeInteger(r)):!1}function Wa(t){if(typeof t!="function")throw new Error("function expected");return!0}function Xe(t,e){if(typeof e!="string")throw new Error(`${t}: string expected`);return!0}function Hs(t){if(!Number.isSafeInteger(t))throw new Error(`invalid integer: ${t}`)}function Ar(t){if(!Array.isArray(t))throw new Error("array expected")}function Qs(t,e){if(!Us(!0,e))throw new Error(`${t}: array of strings expected`)}function zs(t,e){if(!Us(!1,e))throw new Error(`${t}: array of numbers expected`)}function Za(...t){let e=i=>i,r=(i,o)=>a=>i(o(a)),n=t.map(i=>i.encode).reduceRight(r,e),s=t.map(i=>i.decode).reduce(r,e);return{encode:n,decode:s}}function Xa(t){let e=typeof t=="string"?t.split(""):t,r=e.length;Qs("alphabet",e);let n=new Map(e.map((s,i)=>[s,i]));return{encode:s=>(Ar(s),s.map(i=>{if(!Number.isSafeInteger(i)||i<0||i>=r)throw new Error(`alphabet.encode: digit index outside alphabet "${i}". Allowed: ${t}`);return e[i]})),decode:s=>(Ar(s),s.map(i=>{Xe("alphabet.decode",i);let o=n.get(i);if(o===void 0)throw new Error(`Unknown letter: "${i}". Allowed: ${t}`);return o}))}}function Ja(t=""){return Xe("join",t),{encode:e=>(Qs("join.decode",e),e.join(t)),decode:e=>(Xe("join.decode",e),e.split(t))}}var js=(t,e)=>e===0?t:js(e,t%e),Rt=(t,e)=>t+(e-js(t,e)),Tt=(()=>{let t=[];for(let e=0;e<40;e++)t.push(2**e);return t})();function Tr(t,e,r,n){if(Ar(t),e<=0||e>32)throw new Error(`convertRadix2: wrong from=${e}`);if(r<=0||r>32)throw new Error(`convertRadix2: wrong to=${r}`);if(Rt(e,r)>32)throw new Error(`convertRadix2: carry overflow from=${e} to=${r} carryBits=${Rt(e,r)}`);let s=0,i=0,o=Tt[e],a=Tt[r]-1,c=[];for(let u of t){if(Hs(u),u>=o)throw new Error(`convertRadix2: invalid data word=${u} from=${e}`);if(s=s<<e|u,i+e>32)throw new Error(`convertRadix2: carry overflow pos=${i} from=${e}`);for(i+=e;i>=r;i-=r)c.push((s>>i-r&a)>>>0);let l=Tt[i];if(l===void 0)throw new Error("invalid carry");s&=l-1}if(s=s<<r-i&a,!n&&i>=e)throw new Error("Excess padding");if(!n&&s>0)throw new Error(`Non-zero padding: ${s}`);return n&&i>0&&c.push(s>>>0),c}function ec(t,e=!1){if(Hs(t),t<=0||t>32)throw new Error("radix2: bits should be in (0..32]");if(Rt(8,t)>32||Rt(t,8)>32)throw new Error("radix2: carry overflow");return{encode:r=>{if(!$s(r))throw new Error("radix2.encode input should be Uint8Array");return Tr(Array.from(r),8,t,!e)},decode:r=>(zs("radix2.decode",r),Uint8Array.from(Tr(r,t,8,e)))}}function Ds(t){return Wa(t),function(...e){try{return t.apply(null,e)}catch{}}}var Rr=Za(Xa("qpzry9x8gf2tvdw0s3jn54khce6mua7l"),Ja("")),Ms=[996825010,642813549,513874426,1027748829,705979059];function Ze(t){let e=t>>25,r=(t&33554431)<<5;for(let n=0;n<Ms.length;n++)(e>>n&1)===1&&(r^=Ms[n]);return r}function qs(t,e,r=1){let n=t.length,s=1;for(let i=0;i<n;i++){let o=t.charCodeAt(i);if(o<33||o>126)throw new Error(`Invalid prefix (${t})`);s=Ze(s)^o>>5}s=Ze(s);for(let i=0;i<n;i++)s=Ze(s)^t.charCodeAt(i)&31;for(let i of e)s=Ze(s)^i;for(let i=0;i<6;i++)s=Ze(s);return s^=r,Rr.encode(Tr([s%Tt[30]],30,5,!1))}function tc(t){let e=t==="bech32"?1:734539939,r=ec(5),n=r.decode,s=r.encode,i=Ds(n);function o(h,f,p=90){Xe("bech32.encode prefix",h),$s(f)&&(f=Array.from(f)),zs("bech32.encode",f);let S=h.length;if(S===0)throw new TypeError(`Invalid prefix length ${S}`);let y=S+7+f.length;if(p!==!1&&y>p)throw new TypeError(`Length ${y} exceeds limit ${p}`);let P=h.toLowerCase(),j=qs(P,f,e);return`${P}1${Rr.encode(f)}${j}`}function a(h,f=90){Xe("bech32.decode input",h);let p=h.length;if(p<8||f!==!1&&p>f)throw new TypeError(`invalid string length: ${p} (${h}). Expected (8..${f})`);let S=h.toLowerCase();if(h!==S&&h!==h.toUpperCase())throw new Error("String must be lowercase or uppercase");let y=S.lastIndexOf("1");if(y===0||y===-1)throw new Error(\'Letter "1" must be present between prefix and data only\');let P=S.slice(0,y),j=S.slice(y+1);if(j.length<6)throw new Error("Data must be at least 6 characters long");let ce=Rr.decode(j).slice(0,-6),re=qs(P,ce,e);if(!j.endsWith(re))throw new Error(`Invalid checksum in ${h}: expected "${re}"`);return{prefix:P,words:ce}}let c=Ds(a);function u(h){let{prefix:f,words:p}=a(h,!1);return{prefix:f,words:p,bytes:n(p)}}function l(h,f){return o(h,s(f))}return{encode:o,decode:a,encodeFromBytes:l,decodeToBytes:u,decodeUnsafe:c,fromWords:n,fromWordsUnsafe:i,toWords:s}}var kr=tc("bech32");var kt=new TextDecoder("utf-8"),jf=new TextEncoder;var rc=5e3;function Fs(t){let{prefix:e,words:r}=kr.decode(t,rc),n=new Uint8Array(kr.fromWords(r));switch(e){case"nprofile":{let s=Ir(n);if(!s[0]?.[0])throw new Error("missing TLV 0 for nprofile");if(s[0][0].length!==32)throw new Error("TLV 0 should be 32 bytes");return{type:"nprofile",data:{pubkey:$(s[0][0]),relays:s[1]?s[1].map(i=>kt.decode(i)):[]}}}case"nevent":{let s=Ir(n);if(!s[0]?.[0])throw new Error("missing TLV 0 for nevent");if(s[0][0].length!==32)throw new Error("TLV 0 should be 32 bytes");if(s[2]&&s[2][0].length!==32)throw new Error("TLV 2 should be 32 bytes");if(s[3]&&s[3][0].length!==4)throw new Error("TLV 3 should be 4 bytes");return{type:"nevent",data:{id:$(s[0][0]),relays:s[1]?s[1].map(i=>kt.decode(i)):[],author:s[2]?.[0]?$(s[2][0]):void 0,kind:s[3]?.[0]?parseInt($(s[3][0]),16):void 0}}}case"naddr":{let s=Ir(n);if(!s[0]?.[0])throw new Error("missing TLV 0 for naddr");if(!s[2]?.[0])throw new Error("missing TLV 2 for naddr");if(s[2][0].length!==32)throw new Error("TLV 2 should be 32 bytes");if(!s[3]?.[0])throw new Error("missing TLV 3 for naddr");if(s[3][0].length!==4)throw new Error("TLV 3 should be 4 bytes");return{type:"naddr",data:{identifier:kt.decode(s[0][0]),pubkey:$(s[2][0]),kind:parseInt($(s[3][0]),16),relays:s[1]?s[1].map(i=>kt.decode(i)):[]}}}case"nsec":return{type:e,data:n};case"npub":case"note":return{type:e,data:$(n)};default:throw new Error(`unknown prefix ${e}`)}}function Ir(t){let e={},r=t;for(;r.length>0;){if(r.length<2)throw new Error("not enough data to read TLV");let n=r[0],s=r[1],i=r.slice(2,2+s);if(r=r.slice(2+s),i.length<s)throw new Error(`not enough data to read on TLV ${n}`);e[n]=e[n]||[],e[n].push(i)}return e}var Vs=40003,Ks=[5,9005],Nr=[...pe,Vs,...Ks],Ct=/^[0-9a-f]{64}$/,It=(t,e)=>t.tags.find(r=>r[0]===e)?.[1],Cr=(t,e)=>t.tags.some(r=>r[0]===e);function Ys(t){if(t.kind!==39e3)return;let e=It(t,"d");if(!e)return;let[r,...n]=t.tags.flatMap(c=>c[0]==="t"&&typeof c[1]=="string"?[c[1]]:[]),s=r==="stream"&&n.includes("buzz.solo"),i=!r||r==="stream"||r==="forum",o=Cr(t,"public")&&!Cr(t,"private")&&!Cr(t,"hidden"),a=It(t,"about");return{id:e,name:It(t,"name")||e,...a&&{about:a},...r&&{type:r},public:o&&i&&!s,signer:t.pubkey,updatedAt:t.created_at}}function Or(t){if(!pe.includes(t.kind))return;let e=It(t,"h");if(!e)return;let r=We(t.content);if(!r)return;let n=Sr(t),s=[...new Set(t.tags.flatMap(i=>i[0]==="p"&&Ct.test(i[1]??"")?[i[1]]:[]))];return{id:t.id,channel:e,author:t.pubkey,...n&&n!==t.id&&{root:n},kind:t.kind,createdAt:t.created_at,text:r,mentions:s}}function Ws(t){if(t.kind!==Vs)return;let e=t.tags.find(r=>r[0]==="e"&&Ct.test(r[1]??""))?.[1];if(e)return{target:e,author:t.pubkey,text:We(t.content),at:t.created_at}}function Zs(t,e){if(!Ks.includes(t.kind))return;let r=t.tags.flatMap(s=>s[0]==="e"&&Ct.test(s[1]??"")?[s[1]]:[]);if(!r.length)return;let n=t.kind===9005;if(!(n&&!e.has(t.pubkey)))return{targets:r,author:t.pubkey,byRelay:n}}function Xs(t){if(t.kind===0)try{let e=JSON.parse(t.content),r=e.display_name||e.displayName||e.name,n=(e.name||(typeof e.nip05=="string"?e.nip05.split("@")[0]:"")||"").toLowerCase().replace(/^@/,"");return r?{pubkey:t.pubkey,name:String(r).slice(0,200),...n&&{username:n.slice(0,100)},updatedAt:t.created_at}:void 0}catch{return}}function Js(t){return t.replace(/[^\\p{L}\\p{N}\\s\'-]+/gu," ").split(/\\s+/).filter(Boolean).slice(0,32).join(" ")}var Je=86400;function nc(t,e=Date.now()){let r=Math.floor(e/1e3/Je)*Je;if(t==="today")return[r,r+Je];if(t==="yesterday")return[r-Je,r];let n=/^(\\d{4})(?:-(\\d{1,2})(?:-(\\d{1,2}))?)?$/.exec(t);if(!n)return;let[s,i,o]=[Number(n[1]),n[2]?Number(n[2]):void 0,n[3]?Number(n[3]):void 0];if(i!==void 0&&(i<1||i>12)||o!==void 0&&(o<1||o>31))return;let a=Date.UTC(s,(i??1)-1,o??1)/1e3,c=o!==void 0?a+Je:i!==void 0?Date.UTC(s,i,1)/1e3:Date.UTC(s+1,0,1)/1e3;return[a,c]}function Gs(t){let e=t.replace(/^@/,"");if(Ct.test(e))return e;if(/^(npub|nprofile)1[0-9a-z]+$/.test(e))try{let r=Fs(e);if(r.type==="npub")return r.data;if(r.type==="nprofile")return r.data.pubkey}catch{}return e.toLowerCase()}function Nt(t,e=Date.now()){let r={text:"",from:[],to:[],in:[]},n=[],s=/\\b(from|to|in|before|after|on|during|has|is):\\s*([@#]?"[^"]*"|[^\\s"]+)|("[^"]*")|(\\S+)/gi;for(let[i,o,a,c,u]of t.matchAll(s)){if(!o){n.push(c??u??i);continue}let l=o.toLowerCase(),h=(a??"").replace(/^([@#]?)"(.*)"$/,"$1$2").trim();if(!h||/^[@#]$/.test(h)){n.push(i);continue}if(l==="from")r.from.push(Gs(h));else if(l==="to")r.to.push(Gs(h));else if(l==="in")r.in.push(h.replace(/^#/,"").toLowerCase());else if(l==="has"&&h.toLowerCase()==="link")r.link=!0;else if(l==="is"&&h.toLowerCase()==="thread")r.thread=!0;else if(l==="before"||l==="after"||l==="on"||l==="during"){let f=nc(h.toLowerCase(),e);if(!f){n.push(i);continue}l==="before"?r.before=Math.min(r.before??1/0,f[0]):l==="after"?r.after=Math.max(r.after??0,f[1]):(r.after=Math.max(r.after??0,f[0]),r.before=Math.min(r.before??1/0,f[1]))}else n.push(i)}return r.text=n.join(" ").trim(),r}var J=sa(Pn(),1),Dd=J.default.Client,Md=J.default.Pool,qd=J.default.Connection,$d=J.default.types,Ud=J.default.Query,Hd=J.default.DatabaseError,Qd=J.default.escapeIdentifier,zd=J.default.escapeLiteral,jd=J.default.Result,Fd=J.default.TypeOverrides,Gd=J.default.defaults,Fo=J.default;var Go=t=>`buzz_search_${(t||"index").toLowerCase().replace(/[^a-z0-9]+/g,"_")}`.slice(0,63),Yt=class{constructor(e,r=process.env){this.databricks=e;this.env=r}credential;pool;async password(){if(this.credential&&Date.now()<this.credential.until)return this.credential.token;let e=this.env.LAKEBASE_ENDPOINT;if(!e)throw new Error("LAKEBASE_ENDPOINT isn\'t set: the app needs a Lakebase database resource, and `LAKEBASE_ENDPOINT` with `valueFrom: postgres` in app.yaml.");let r=await this.databricks.api("/api/2.0/postgres/credentials",{body:{endpoint:e}});if(!r.token)throw new Error("Lakebase didn\'t give the app a credential.");let n=r.expire_time?Date.parse(r.expire_time):Date.now()+60*6e4;return this.credential={token:r.token,until:n-5*6e4},r.token}db(){if(this.pool)return this.pool;let{PGHOST:e,PGPORT:r,PGDATABASE:n,PGUSER:s}=this.env;if(!e||!n||!s)throw new Error("PGHOST, PGDATABASE and PGUSER aren\'t set: give the app a Lakebase database resource.");return this.pool=new Fo.Pool({host:e,port:Number(r||5432),database:n,user:s,password:()=>this.password(),ssl:!0,max:4,idleTimeoutMillis:3e4}),this.pool.on("error",()=>{}),this.pool}close(){this.pool?.end(),this.pool=void 0}},Wt=class{constructor(e,r){this.lakebase=e;this.schema=r}mode="postgres";extensions=[];extensionError;query(e,r=[]){return this.lakebase.db().query(e,r)}async setup(){await this.query(`CREATE SCHEMA IF NOT EXISTS ${this.schema}`),await this.query(`CREATE TABLE IF NOT EXISTS ${this.schema}.channels (\n      id text PRIMARY KEY, name text NOT NULL, about text, type text, public boolean NOT NULL, signer text,\n      updated_at bigint NOT NULL, backfill_until bigint, backfilled boolean NOT NULL DEFAULT false, problem text)`),await this.query(`CREATE TABLE IF NOT EXISTS ${this.schema}.messages (\n      id text PRIMARY KEY, channel text NOT NULL, author text NOT NULL, root text, kind int NOT NULL,\n      created_at bigint NOT NULL, edited_at bigint, text text NOT NULL,\n      tsv tsvector GENERATED ALWAYS AS (to_tsvector(\'english\', text)) STORED)`),await this.query(`CREATE INDEX IF NOT EXISTS messages_channel_time ON ${this.schema}.messages (channel, created_at DESC)`),await this.query(`ALTER TABLE ${this.schema}.messages ADD COLUMN IF NOT EXISTS mentions text[]`),await this.query(`CREATE INDEX IF NOT EXISTS messages_author_time ON ${this.schema}.messages (author, created_at DESC)`),await this.query(`CREATE TABLE IF NOT EXISTS ${this.schema}.edits (target text PRIMARY KEY, author text NOT NULL, text text NOT NULL, at bigint NOT NULL)`),await this.query(`CREATE TABLE IF NOT EXISTS ${this.schema}.deleted (id text PRIMARY KEY, author text NOT NULL, by_relay boolean NOT NULL)`),await this.query(`CREATE TABLE IF NOT EXISTS ${this.schema}.people (pubkey text PRIMARY KEY, name text NOT NULL, updated_at bigint NOT NULL)`),await this.query(`ALTER TABLE ${this.schema}.people ADD COLUMN IF NOT EXISTS username text`);for(let n of["CREATE EXTENSION IF NOT EXISTS lakebase_vector CASCADE","CREATE EXTENSION IF NOT EXISTS lakebase_text"])await this.query(n).catch(s=>this.extensionError=s.message);let e=await this.query("SELECT extname FROM pg_extension ORDER BY extname");return this.extensions=e.rows.map(n=>n.extname),(await this.query("SELECT 1 FROM pg_am WHERE amname = \'lakebase_bm25\'")).rowCount?(await this.query(`CREATE INDEX IF NOT EXISTS messages_bm25 ON ${this.schema}.messages USING lakebase_bm25 (tsv)`),this.mode="bm25"):(await this.query(`CREATE INDEX IF NOT EXISTS messages_tsv ON ${this.schema}.messages USING gin (tsv)`),this.mode="postgres"),this.mode}async selfCheck(){if(await this.query(`CREATE TABLE IF NOT EXISTS ${this.schema}.selfcheck (id int PRIMARY KEY, text text NOT NULL, tsv tsvector GENERATED ALWAYS AS (to_tsvector(\'english\', text)) STORED)`),await this.query(`INSERT INTO ${this.schema}.selfcheck (id, text) VALUES (1, \'the quarterly revenue report is ready\'), (2, \'lunch plans for friday\') ON CONFLICT (id) DO NOTHING`),this.mode==="bm25"){await this.query(`CREATE INDEX IF NOT EXISTS selfcheck_bm25 ON ${this.schema}.selfcheck USING lakebase_bm25 (tsv)`);let r=await this.query(`SELECT id FROM ${this.schema}.selfcheck ORDER BY tsv <@> to_bm25query(to_tsvector(\'english\', $1), \'${this.schema}.selfcheck_bm25\') LIMIT 1`,["revenue"]);return r.rows[0]?.id===1?"ok (Lakebase Search BM25)":`unexpected result ${JSON.stringify(r.rows)}`}let e=await this.query(`SELECT id FROM ${this.schema}.selfcheck WHERE tsv @@ plainto_tsquery(\'english\', $1) ORDER BY ts_rank_cd(tsv, plainto_tsquery(\'english\', $1)) DESC LIMIT 1`,["revenue"]);return e.rows[0]?.id===1?"ok (Postgres full-text search)":`unexpected result ${JSON.stringify(e.rows)}`}async channels(e){e.length&&await this.query(`INSERT INTO ${this.schema}.channels (id, name, about, type, public, signer, updated_at)\n       SELECT * FROM unnest($1::text[], $2::text[], $3::text[], $4::text[], $5::boolean[], $6::text[], $7::bigint[])\n       ON CONFLICT (id) DO UPDATE SET name = excluded.name, about = excluded.about, type = excluded.type, public = excluded.public, signer = excluded.signer, updated_at = excluded.updated_at\n       WHERE excluded.updated_at >= ${this.schema}.channels.updated_at`,[e.map(r=>r.id),e.map(r=>r.name),e.map(r=>r.about??null),e.map(r=>r.type??null),e.map(r=>r.public),e.map(r=>r.signer),e.map(r=>r.updatedAt)])}async cursor(e){let n=(await this.query(`SELECT backfill_until, backfilled FROM ${this.schema}.channels WHERE id = $1`,[e])).rows[0];return{...n?.backfill_until&&{until:Number(n.backfill_until)},done:!!n?.backfilled}}async setCursor(e,r,n,s){await this.query(`UPDATE ${this.schema}.channels SET backfill_until = $2, backfilled = $3, problem = $4 WHERE id = $1`,[e,r??null,n,s??null])}async messages(e){if(!e.length)return;let r=e.map(n=>n.id);await this.query(`INSERT INTO ${this.schema}.messages (id, channel, author, root, kind, created_at, text, mentions)\n       SELECT id, channel, author, root, kind, created_at, text, string_to_array(nullif(mentions, \'\'), \',\')\n       FROM unnest($1::text[], $2::text[], $3::text[], $4::text[], $5::int[], $6::bigint[], $7::text[], $8::text[]) AS m(id, channel, author, root, kind, created_at, text, mentions)\n       ON CONFLICT (id) DO UPDATE SET mentions = excluded.mentions WHERE ${this.schema}.messages.mentions IS NULL`,[r,e.map(n=>n.channel),e.map(n=>n.author),e.map(n=>n.root??null),e.map(n=>n.kind),e.map(n=>n.createdAt),e.map(n=>n.text),e.map(n=>n.mentions.join(","))]),await this.query(`UPDATE ${this.schema}.messages m SET text = e.text, edited_at = e.at FROM ${this.schema}.edits e\n       WHERE m.id = ANY($1) AND e.target = m.id AND e.author = m.author AND (m.edited_at IS NULL OR m.edited_at < e.at)`,[r]),await this.query(`DELETE FROM ${this.schema}.messages m USING ${this.schema}.deleted d WHERE m.id = ANY($1) AND d.id = m.id AND (d.by_relay OR d.author = m.author)`,[r])}async edit(e){await this.query(`INSERT INTO ${this.schema}.edits (target, author, text, at) VALUES ($1, $2, $3, $4)\n       ON CONFLICT (target) DO UPDATE SET author = excluded.author, text = excluded.text, at = excluded.at WHERE excluded.at > ${this.schema}.edits.at`,[e.target,e.author,e.text,e.at]),await this.query(`UPDATE ${this.schema}.messages SET text = $3, edited_at = $4 WHERE id = $1 AND author = $2 AND (edited_at IS NULL OR edited_at < $4)`,[e.target,e.author,e.text,e.at])}async deletion(e){await this.query(`INSERT INTO ${this.schema}.deleted (id, author, by_relay) SELECT unnest($1::text[]), $2, $3 ON CONFLICT (id) DO NOTHING`,[e.targets,e.author,e.byRelay]),await this.query(`DELETE FROM ${this.schema}.messages WHERE id = ANY($1) AND ($3 OR author = $2)`,[e.targets,e.author,e.byRelay])}async people(e){e.length&&await this.query(`INSERT INTO ${this.schema}.people (pubkey, name, username, updated_at) SELECT * FROM unnest($1::text[], $2::text[], $3::text[], $4::bigint[])\n       ON CONFLICT (pubkey) DO UPDATE SET name = excluded.name, username = excluded.username, updated_at = excluded.updated_at\n       WHERE excluded.updated_at > ${this.schema}.people.updated_at OR ${this.schema}.people.username IS NULL`,[e.map(r=>r.pubkey),e.map(r=>r.name),e.map(r=>r.username??null),e.map(r=>r.updatedAt)])}async unnamed(e){if(!e.length)return[];let r=await this.query(`SELECT pubkey FROM ${this.schema}.people WHERE pubkey = ANY($1)`,[e]),n=new Set(r.rows.map(s=>s.pubkey));return e.filter(s=>!n.has(s))}async search(e,r=20){let n=typeof e=="string"?Nt(e):e,s=Js(n.text.replace(/(^|\\s)-\\S+/g," ").replace(/\\bOR\\b/g," ")),i=[],o=y=>`$${i.push(y)}`,a=[],c=n.text.trim()?o(n.text):void 0;c&&a.push(`m.tsv @@ websearch_to_tsquery(\'english\', ${c})`);let u=y=>{let P=o(y),j=o(y.map(ce=>`${ce.replace(/[%_\\\\]/g,"")}%`));return`(SELECT pubkey FROM ${this.schema}.people p WHERE p.pubkey = ANY(${P}) OR lower(p.username) = ANY(${P}) OR lower(p.name) = ANY(${P}) OR lower(p.name) LIKE ANY(${j}) UNION SELECT unnest(${P}::text[]))`};if(n.from.length&&a.push(`m.author IN ${u(n.from)}`),n.to.length&&a.push(`m.mentions && ARRAY${u(n.to)}`),n.in.length){let y=o(n.in);a.push(`(lower(c.name) = ANY(${y}) OR c.id = ANY(${y}))`)}if(n.after!==void 0&&a.push(`m.created_at >= ${o(n.after)}`),n.before!==void 0&&Number.isFinite(n.before)&&a.push(`m.created_at < ${o(n.before)}`),n.thread&&a.push("m.root IS NOT NULL"),n.link&&a.push("m.text ~* \'https?://\'"),!a.length)return[];let l=!!(c&&s),h=l?o(s):void 0,f=l?this.mode==="bm25"?`m.tsv <@> to_bm25query(to_tsvector(\'english\', ${h}), \'${this.schema}.messages_bm25\')`:`-ts_rank_cd(m.tsv, websearch_to_tsquery(\'english\', ${c}))`:"0",p=c?`ts_headline(\'english\', m.text, websearch_to_tsquery(\'english\', ${c}), \'MaxFragments=1,MaxWords=30,MinWords=10,StartSel=**,StopSel=**\')`:"left(m.text, 240)";return(await this.query(`SELECT m.id, m.channel, c.name AS channel_name, m.author, p.name AS author_name, m.root, m.created_at, ${p} AS snippet, ${f} AS score\n       FROM ${this.schema}.messages m\n       JOIN ${this.schema}.channels c ON c.id = m.channel AND c.public\n       LEFT JOIN ${this.schema}.people p ON p.pubkey = m.author\n       WHERE ${a.join(" AND ")}\n       ORDER BY ${l?"score ASC, ":""}m.created_at DESC\n       LIMIT ${o(Math.max(1,Math.min(50,r)))}`,i)).rows.map(y=>({id:y.id,channel:y.channel,channelName:y.channel_name,author:y.author,...y.author_name&&{authorName:y.author_name},...y.root&&{root:y.root},createdAt:Number(y.created_at),snippet:y.snippet}))}async suggestPeople(e,r=8){let n=e.replace(/^@/,"").trim().toLowerCase().replace(/[%_\\\\]/g,"");return(await this.query(`SELECT p.pubkey, p.name, p.username FROM ${this.schema}.people p\n       LEFT JOIN (SELECT author, count(*) AS n FROM ${this.schema}.messages GROUP BY author) a ON a.author = p.pubkey\n       WHERE $1 = \'\' OR lower(p.username) LIKE $1 || \'%\' OR lower(p.name) LIKE $1 || \'%\' OR lower(p.name) LIKE \'% \' || $1 || \'%\'\n       ORDER BY (lower(p.username) = $1 OR lower(p.name) = $1) DESC, coalesce(a.n, 0) DESC, p.name\n       LIMIT $2`,[n,Math.max(1,Math.min(20,r))])).rows.map(i=>({pubkey:i.pubkey,name:i.name,handle:i.username||i.name.toLowerCase().replace(/\\s+/g,"")}))}async suggestChannels(e,r=8){let n=e.replace(/^#/,"").trim().toLowerCase().replace(/[%_\\\\]/g,"");return(await this.query(`SELECT c.id, c.name FROM ${this.schema}.channels c\n       LEFT JOIN (SELECT channel, count(*) AS n FROM ${this.schema}.messages GROUP BY channel) m ON m.channel = c.id\n       WHERE c.public AND ($1 = \'\' OR lower(c.name) LIKE $1 || \'%\' OR lower(c.name) ~ (\'[-_ ]\' || $1))\n       ORDER BY (lower(c.name) = $1) DESC, coalesce(m.n, 0) DESC, c.name\n       LIMIT $2`,[n,Math.max(1,Math.min(20,r))])).rows}async stats(){let r=(await this.query(`SELECT\n      (SELECT count(*) FROM ${this.schema}.messages) AS messages,\n      (SELECT count(*) FROM ${this.schema}.channels) AS channels,\n      (SELECT count(*) FROM ${this.schema}.channels WHERE public) AS public_channels,\n      (SELECT count(*) FROM ${this.schema}.channels WHERE public AND backfilled) AS backfilled,\n      (SELECT count(*) FROM ${this.schema}.people) AS people`)).rows[0]??{};return{messages:Number(r.messages??0),channels:Number(r.channels??0),publicChannels:Number(r.public_channels??0),backfilled:Number(r.backfilled??0),people:Number(r.people??0)}}};var Zt=200,Vo=40,kh=10*6e4,Ih=t=>{let e=Math.max(0,Math.round((Date.now()/1e3-t)/60));return e<60?`${e}m ago`:e<2880?`${Math.round(e/60)}h ago`:`${Math.round(e/1440)}d ago`},Ch=t=>new Promise(e=>setTimeout(e,t)),z=new At({about:"Searches this community\'s public channels. Mention me with what you\'re looking for, or use Search in Buzz."}),Nh=new Yt(z.databricks),B=new Wt(Nh,Go(z.appName)),w={ready:!1,setupError:void 0,searchCheck:"not run",reading:"",readErrors:0,lastIndexed:void 0,stats:void 0},Ko=new Set;async function Yo(){try{let t=await B.setup();w.searchCheck=await B.selfCheck().catch(e=>`failed: ${e.message}`),w.ready=!0,w.setupError=void 0,console.log(`[index] ready (${t}); search check: ${w.searchCheck}`)}catch(t){w.setupError=t.message,console.log(`[index] Lakebase isn\'t ready: ${w.setupError}`),setTimeout(()=>void Yo(),3e4).unref()}}async function Wo(t){let e=t.filter(s=>s.pubkey!==z.pubkey&&Le(s));await B.messages(e.flatMap(s=>Or(s)??[]));for(let s of e){let i=Ws(s);i&&await B.edit(i);let o=Zs(s,Ko);o&&await B.deletion(o)}let r=[...new Set(e.filter(s=>Or(s)).map(s=>s.pubkey))],n=await B.unnamed(r);for(let s=0;s<n.length;s+=100){let i=await z.query([{kinds:[0],authors:n.slice(s,s+100)}]);await B.people(i.filter(o=>Le(o)).flatMap(o=>Xs(o)??[]))}e.length&&(w.lastIndexed=Math.floor(Date.now()/1e3))}async function Oh(t,e){let r=await B.cursor(t);if(r.done)return;let n=r.until??Math.floor(Date.now()/1e3);for(;!e();){let s;try{s=await z.query([{kinds:Nr,"#h":[t],until:n,limit:Zt}])}catch(o){w.readErrors++,console.log(`[index] couldn\'t read ${t}: ${o.message.slice(0,200)}`),await B.setCursor(t,n,!1,o.message.slice(0,300));return}if(!s.length)return B.setCursor(t,n,!0);await Wo(s),console.log(`[index] ${t}: read ${s.length} older events`);let i=Math.min(...s.map(o=>o.created_at));if(n=s.length>=Zt&&i>=n?n-1:i,await B.setCursor(t,n,s.length<Zt),s.length<Zt)return;await Ch(250)}}z.onConnect(()=>{let t=!1,e=[],r="",n=()=>{for(let i of e)i();e=[]},s=async()=>{if(!t){if(!w.ready)return void setTimeout(()=>void s(),1e4);try{let o=(await z.query([{kinds:[39e3],limit:5e3}])).filter(c=>Le(c)).flatMap(c=>Ys(c)??[]);for(let c of o)Ko.add(c.signer);await B.channels(o);let a=o.filter(c=>c.public).map(c=>c.id).sort();if(console.log(`[index] found ${o.length} channels, ${a.length} public`),a.join()!==r){n(),r=a.join();let c=Math.floor(Date.now()/1e3)-60;for(let u=0;u<a.length;u+=Vo)e.push(z.relay.watch({kinds:Nr,"#h":a.slice(u,u+Vo)},c,l=>void Wo([l]).catch(h=>console.log(`[index] couldn\'t index ${l.id.slice(0,8)}: ${h.message}`)),5e3))}for(let c of a){if(t)break;w.reading=c,await Oh(c,()=>t)}w.reading="",w.stats=await B.stats(),console.log(`[index] ${w.stats.messages} messages in ${w.stats.backfilled}/${w.stats.publicChannels} public channels`)}catch(i){console.log(`[index] discovery failed: ${i.message}`)}t||setTimeout(()=>void s(),kh).unref()}};return s(),()=>{t=!0,n()}});function Bh(t,e){return e.length?[`Here\'s what I found for \\u201C${t}\\u201D:`,...e.map((r,n)=>`${n+1}. **#${r.channelName}** \\xB7 ${r.authorName??`${r.author.slice(0,8)}\\u2026`} \\xB7 ${Ih(r.createdAt)}\n   ${r.snippet.replace(/\\s+/g," ")}`)].join(`\n\n`):`I didn\'t find anything for \\u201C${t}\\u201D in public channels.`}z.onMention(async(t,e)=>{let r=t.text.replace(/^(search( for)?|find|look up)\\s+/i,"").trim();if(!r)return e.say("Tell me what to look for, like \\u201Cquarterly planning\\u201D or \\u201Cfrom:@sam in:#general after:2026-11-01 launch\\u201D.");if(!w.ready)return e.say(`I can\'t search yet: ${w.setupError??"I\'m still setting up my index."}`);let n=e.typing(),s=await B.search(r,5).finally(n);await e.say(Bh(r,s))});z.route("/api/info",()=>({json:{kind:"buzz-search",version:2,name:z.identity?.name??z.appName,ready:w.ready}}));z.route("/api/search",async t=>{let e=t.url.searchParams.get("q")??"",r=Number(t.url.searchParams.get("limit")??20);if(!w.ready)return{status:503,json:{error:w.setupError??"The index is still setting up."}};let n=Nt(e),s=await B.search(n,Number.isFinite(r)?r:20);return console.log(`[index] search by ${t.user??"unknown"}: ${s.length} results`),{json:{results:s,query:n,mode:B.mode,...w.stats&&{indexed:w.stats}}}});z.route("/api/people",async t=>w.ready?{json:{people:await B.suggestPeople(t.url.searchParams.get("q")??"",Number(t.url.searchParams.get("limit")??8)||8)}}:{status:503,json:{error:w.setupError??"The index is still setting up."}});z.route("/api/channels",async t=>w.ready?{json:{channels:await B.suggestChannels(t.url.searchParams.get("q")??"",Number(t.url.searchParams.get("limit")??8)||8)}}:{status:503,json:{error:w.setupError??"The index is still setting up."}});z.describe(()=>({index:w.ready?`ready (${B.mode==="bm25"?"Lakebase Search":"Postgres full-text"})`:w.setupError??"setting up",searchCheck:w.searchCheck,...B.extensions.length&&{extensions:B.extensions.join(", ")},...B.mode!=="bm25"&&B.extensionError&&{lakebaseSearch:`not on in this database: ${B.extensionError.slice(0,200)}`},...w.stats&&{indexed:`${w.stats.messages} messages in ${w.stats.backfilled}/${w.stats.publicChannels} public channels read so far`},...w.reading&&{reading:w.reading},...w.readErrors&&{readErrors:w.readErrors},...w.lastIndexed&&{lastIndexed:new Date(w.lastIndexed*1e3).toISOString()}}));Yo();z.start();setInterval(()=>{w.ready&&B.stats().then(t=>w.stats=t,()=>{})},6e4).unref();\n';
var APP_SHA = "03694c9790485be3";

// plugins/agents/src/app-identity.ts
var HEX64 = /^[0-9a-f]{64}$/;
function parseIdentity(value) {
  if (!value) return void 0;
  try {
    const parsed = JSON.parse(value);
    if (parsed.v !== 1 || typeof parsed.key !== "string" || !HEX64.test(parsed.key)) return void 0;
    return {
      v: 1,
      key: parsed.key,
      ...typeof parsed.relay === "string" && parsed.relay && { relay: parsed.relay },
      ...typeof parsed.owner === "string" && HEX64.test(parsed.owner) && { owner: parsed.owner },
      ...Array.isArray(parsed.auth) && parsed.auth.every((part) => typeof part === "string") && { auth: parsed.auth },
      ...typeof parsed.name === "string" && parsed.name && { name: parsed.name },
      ...typeof parsed.picture === "string" && parsed.picture && { picture: parsed.picture },
      ...(parsed.answers === "owner" || parsed.answers === "everyone") && { answers: parsed.answers },
      ...typeof parsed.app === "string" && parsed.app && { app: parsed.app },
      ...typeof parsed.workspace === "string" && parsed.workspace && { workspace: parsed.workspace }
    };
  } catch {
    return void 0;
  }
}
var activated = (identity) => Boolean(identity?.relay && identity.owner && identity.auth?.length);
var identitySecretName = (schema2, app) => `${schema2}.buzz_${app.replace(/-/g, "_")}`;
function appYaml(input) {
  return [
    'command: ["node", "app.mjs"]',
    "env:",
    "  - name: BUZZ_IDENTITY_SECRET",
    `    value: "${input.secret}"`,
    ...input.source ? ["  - name: BUZZ_APP_SOURCE", `    value: "${input.source}"`] : [],
    // The app's Lakebase database resource (PGHOST and the rest come with it).
    ...input.lakebase ? ["  - name: LAKEBASE_ENDPOINT", "    valueFrom: postgres"] : [],
    ""
  ].join("\n");
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
var OUTPUT_LIMITS = /* @__PURE__ */ new Map();
function outputLimit(error, asked) {
  const message = error?.message ?? "";
  if (!/max(_new|_output)?_tokens|output tokens/i.test(message)) return void 0;
  const below = [...message.matchAll(/\d+/g)].map((match) => Number(match[0])).filter((n) => n >= 256 && n < asked);
  return below.length ? Math.max(...below) : void 0;
}
var Ai = class {
  constructor(client) {
    this.client = client;
  }
  /** Remembers which chat route the workspace answers. */
  route;
  async chat(request) {
    const tools = Boolean(request.tools?.length);
    const asked = request.maxTokens ?? 4096;
    let body = {
      model: request.model,
      messages: request.messages,
      ...tools && { tools: request.tools, tool_choice: "auto" },
      max_tokens: Math.min(asked, OUTPUT_LIMITS.get(request.model) ?? asked),
      ...request.temperature !== void 0 && { temperature: request.temperature },
      ...tools && NO_REASONING_WITH_TOOLS.has(request.model) && { reasoning_effort: "none" }
    };
    for (let attempt = 0; ; attempt++) {
      try {
        return await this.send(request.model, body, request.signal);
      } catch (error) {
        if (attempt >= 2) throw error;
        if (tools && body.reasoning_effort === void 0 && needsReasoningOff(error)) {
          NO_REASONING_WITH_TOOLS.add(request.model);
          body = { ...body, reasoning_effort: "none" };
          continue;
        }
        const limit = outputLimit(error, body.max_tokens);
        if (!limit) throw error;
        OUTPUT_LIMITS.set(request.model, limit);
        body = { ...body, max_tokens: limit };
      }
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
        const status3 = error.status;
        if (this.route === "gateway" || status3 !== 404 && status3 !== 405) throw error;
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
        const status3 = error.status;
        if (status3 !== 404 && status3 !== 405) throw error;
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

// packages/core/src/api/mcp-catalog.ts
var NATIVE = /* @__PURE__ */ new Set(["system.ai.genie_one_mcp", "system.ai.sandbox"]);
var plain = (text = "") => text.replace(/\[([^\]]+)\]\([^)]+\)/g, "$1").replace(/\s+/g, " ").trim();
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
          description: plain(service.comment).replace(/ Verify that the provider's service.*$/, ""),
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
          ...(connection.comment || host) && { description: plain(connection.comment) || host },
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
  const bytes2 = new TextEncoder().encode(text);
  let binary = "";
  for (let i2 = 0; i2 < bytes2.length; i2 += 32768) binary += String.fromCharCode(...bytes2.subarray(i2, i2 + 32768));
  return btoa(binary);
}
function fromBase64(encoded) {
  const binary = atob(encoded.trim());
  const bytes2 = new Uint8Array(binary.length);
  for (let i2 = 0; i2 < binary.length; i2++) bytes2[i2] = binary.charCodeAt(i2);
  return new TextDecoder().decode(bytes2);
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
  for (let i2 = 0; i2 < lines.length; i2++) {
    if (row.test(lines[i2] ?? "") && /^\s*\|?\s*:?-{2,}/.test(lines[i2 + 1] ?? "")) {
      const header = cells(lines[i2] ?? "");
      const body = [];
      for (i2 += 2; i2 < lines.length && row.test(lines[i2] ?? ""); i2++) body.push(cells(lines[i2] ?? "").map((cell2) => cell2 || null));
      i2--;
      const result = take(header, body.length) ?? resultSet(header.map((name) => ({ name })), body);
      out.push("", resultBlock(result, maxRows), "");
      blocks++;
      continue;
    }
    out.push(lines[i2] ?? "");
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
var sleep = (ms, signal) => new Promise((resolve, reject) => {
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
      const wait2 = RATE_LIMIT_WAITS_MS[attempt];
      if (wait2 === void 0 || options.signal?.aborted || !(options.retryable ?? isRateLimited)(error)) throw error;
      const waitMs = jittered(wait2);
      options.onRetry?.({ attempt: attempt + 1, waitMs, reason: error instanceof Error ? error.message : String(error) });
      await sleep(waitMs, options.signal);
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
        if (state.status) await sleep(POLL_MS, signal);
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
function compactCommand(harness, model, session) {
  const cd = `cd ${shellQuote(WORK_DIR)} || exit 1`;
  if (harness === "claude")
    return `${cd}; printf '/compact' | claude -p --model ${shellQuote(model)} --output-format stream-json --verbose --resume ${shellQuote(session)} 2>/dev/null`;
  return [
    cd,
    'd=$(mktemp -d) && mkfifo "$d/in" || exit 1',
    `timeout 260 pi --mode rpc --model ${shellQuote(model)} --session-id ${shellQuote(session)} < "$d/in" > "$d/out" 2>/dev/null &`,
    "p=$!",
    'exec 3> "$d/in"',
    `printf '%s\\n' '{"id":"buzz-compact","type":"compact"}' >&3`,
    `for i in $(seq 1 258); do grep -q '"type":"response"' "$d/out" 2>/dev/null && break; kill -0 $p 2>/dev/null || break; sleep 1; done`,
    "exec 3>&-",
    "kill $p 2>/dev/null; wait $p 2>/dev/null",
    `grep -m1 '"type":"response"' "$d/out"`,
    'rm -rf "$d"'
  ].join("\n");
}
function compactOutcome(harness, stdout) {
  const events = stdout.split("\n").flatMap((line) => {
    try {
      return [JSON.parse(line)];
    } catch {
      return [];
    }
  });
  if (harness === "claude") {
    if (events.some((event) => event.type === "system" && event.subtype === "compact_boundary")) return { ok: true, compacted: true };
    const result = events.find((event) => event.type === "result");
    const text = typeof result?.result === "string" ? result.result : "";
    return { ok: false, error: text || (result ? "Claude Code didn't compact the session." : "Claude Code didn't answer.") };
  }
  const response = events.find((event) => event.type === "response");
  if (response?.success === true) return { ok: true, compacted: true };
  const error = typeof response?.error === "string" ? response.error : "";
  if (/nothing to compact/i.test(error)) return { ok: true, compacted: false };
  return { ok: false, error: error || "Pi didn't answer." };
}
async function compactRemote(input) {
  if (input.harness === "codex") throw new Error("Codex compacts its own context as it fills up; it has no command to do it on request.");
  const result = await input.sandboxes.bash(input.sandbox, compactCommand(input.harness, input.model, input.session), { timeoutSeconds: 280, signal: input.signal });
  const outcome = compactOutcome(input.harness, result.stdout ?? "");
  if (!outcome.ok) throw new Error(`${harnessLabel(input.harness)} couldn't compact: ${outcome.error}`);
  return { compacted: outcome.compacted };
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
var sleep2 = (ms, signal) => new Promise((resolve, reject) => {
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
var plain2 = (text) => text.replace(/\x1b\[[0-9;]*[A-Za-z]/g, "").replace(/[│╭╮╰╯─✔•]/g, "").trim();
function stderrSummary(stderr) {
  return plain2(stderr).split("\n").map((line) => line.trim()).filter((line) => line && !/Unity Gateway|Databricks auth already|Launching |Starting |managed coding agent config|token refresh is managed|^is running\.?$/i.test(line)).slice(-4).join(" ").slice(0, 600);
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
      await sleep2(input.pollMs ?? 2e3, signal);
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
  const clean2 = path.replace(/^\/+/, "");
  if (clean2.split("/").some((part) => part === ".." || part === ".")) throw new Error("Skill file paths cannot contain . or ..");
  return ["Skills", catalog, schema2, skill, ...clean2.split("/").filter(Boolean)].map(encodeURIComponent).join("/");
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
    const clean2 = [...new Set(locations.map((location) => location.trim()).filter((location) => /^[^.\s]+\.[^.\s]+$/.test(location)))];
    this.service.preferences.set(SKILL_LOCATIONS, clean2.length ? clean2 : void 0);
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
  const clean2 = (list, pattern) => [
    ...new Set(Array.isArray(list) ? list.filter((item) => typeof item === "string" && pattern.test(item)) : [])
  ];
  return { schemas: clean2(choice.schemas, SCHEMA), names: clean2(choice.names, SKILL), channel: choice.channel !== false };
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
var settling = (status3) => status3 === "checking" || status3 === "connecting" || status3 === "signing-in";
var loads = (status3) => status3 === "connected" || settling(status3);
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
  const status3 = useConnection(workspace).status;
  const available = useAsync(() => cachedList(workspace, "sandbox", async () => new Sandboxes(await workspace.ready()).available()), [workspace, status3]);
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
  const status3 = useConnection(props.service).status;
  const models = useAsync(() => cachedList(props.service, "models", async () => new Ai(await props.service.ready()).models()), [props.service, status3]);
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
      loading: models.loading && !models.data && loads(status3) ? "Loading all models\u2026" : false,
      ...models.error && status3 === "connected" && { error: `Couldn't list models: ${describeError(models.error)}` },
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
  const status3 = useConnection(service).status;
  const spaces = useAsync(() => genieSpaces(service), [service, status3]);
  const catalog = useAsync(() => cachedList(service, "mcp", async () => new McpCatalog(await service.ready()).list()), [service, status3]);
  const [schemaName, setSchemaName] = React.useState("");
  const choices = /* @__PURE__ */ new Map([[GENIE_ONE_CHOICE.id, GENIE_ONE_CHOICE]]);
  const servers = catalog.data?.servers ?? [];
  const logins = useMcpLogins(service, status3 === "connected", servers);
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
  const loading = !loads(status3) ? false : spaces.loading ? "Loading Genie agents\u2026" : catalog.loading ? "Finding MCP servers\u2026" : false;
  const notes = status3 !== "connected" ? [] : [
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
  const status3 = useConnection(service).status;
  const catalog = React.useMemo(() => skillCatalogFor(service, profile), [service, profile]);
  const state = React.useSyncExternalStore(catalog.subscribe, catalog.snapshot);
  React.useEffect(() => {
    if (status3 === "connected") void catalog.load();
  }, [catalog, status3]);
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
      loading: status3 !== "connected" ? false : state.status === "loading" ? "Finding skills\u2026" : false,
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
  const status3 = useConnection(service).status;
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
    [service, status3]
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
      loading: found.loading && !found.data && loads(status3) ? "Finding your agents\u2026" : false,
      ...found.error && status3 === "connected" && { error: describeError(found.error) },
      ...props.disabled !== void 0 && { disabled: props.disabled },
      onChange: (option) => {
        const agent = found.data?.agents.get(option.id);
        if (agent) props.onChange(agent);
      }
    }
  ), (found.data?.errors ?? []).map((error) => /* @__PURE__ */ React.createElement(Text, { key: error, tone: "tertiary", size: "xs" }, "Couldn't list ", error)));
}

// plugins/agents/src/app-type.tsx
var APP_TYPE_ID = "databricks-app";
var RECORD_PREFIX = "bkvarda.databricks-app.v1:";
var DEFAULT_SCHEMA = "buzz_apps";
function normalizeAppConfig(value) {
  const config = value ?? {};
  const lakebase = config.lakebase;
  return {
    mode: config.mode === "own" ? "own" : "starter",
    template: config.template === "search" ? "search" : "starter",
    ...lakebase && typeof lakebase.branch === "string" && typeof lakebase.database === "string" && typeof lakebase.project === "string" && { lakebase: { project: lakebase.project, branch: lakebase.branch, database: lakebase.database } },
    app: typeof config.app === "string" ? config.app.trim().toLowerCase() : "",
    schema: typeof config.schema === "string" ? config.schema.trim() : "",
    answers: config.answers === "owner" ? "owner" : "everyone",
    ...typeof config.profile === "string" && config.profile && { profile: config.profile }
  };
}
var SCHEMA2 = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_]+$/;
function appConfigProblem(config) {
  if (!config.app) return config.mode === "own" ? "Pick the app." : "Name the app.";
  if (!APP_NAME.test(config.app)) return "App names use lowercase letters, numbers and hyphens (at most 30), and start and end with a letter or number.";
  if (!SCHEMA2.test(config.schema)) return "Pick where its key is kept: a catalog and a schema.";
  if (isSearch(config) && !config.lakebase) return "Pick the Lakebase project for its index.";
  return void 0;
}
var isSearch = (config) => config.mode === "starter" && config.template === "search";
function templateFiles(config, secret, source) {
  if (isSearch(config)) return { files: { "app.mjs": INDEXER, "app.yaml": appYaml({ secret, source, lakebase: true }) }, keep: [] };
  return { files: { "buzz-app.mjs": SDK, "app.mjs": STARTER, "app.yaml": appYaml({ secret, source }) }, keep: ["app.mjs", "app.yaml"] };
}
function summarizeApp(config) {
  return [config.app || "No app yet", config.mode === "own" ? "your app" : isSearch(config) ? "search index" : "starter app", config.answers === "owner" ? "answers only you" : "answers everyone", ...config.profile ? [config.profile] : []].join(" \xB7 ");
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
var hex = (bytes2) => [...bytes2].map((b) => b.toString(16).padStart(2, "0")).join("");
var bytes = (text) => Uint8Array.from(text.match(/../g).map((pair) => parseInt(pair, 16)));
var workspaceOf = (service, profile) => profile && service.forProfile ? service.forProfile(profile) : service;
async function sourceFolder(workspace, app, signal) {
  const snapshot = workspace.snapshot();
  let user = snapshot.status === "connected" ? snapshot.user?.userName : void 0;
  if (!user) user = (await (await workspace.ready(signal)).get("/api/2.0/preview/scim/v2/Me", { ...signal && { signal } })).userName;
  if (!user) throw new Error("Couldn't tell who you're signed in to Databricks as.");
  return `/Workspace/Users/${user}/buzz-apps/${app}`;
}
function grantFailed(error, what, principal) {
  if (isApiError(error) && error.isPermission)
    return new Error(`You can't grant access to ${what}. Pick a catalog you own or manage, or ask its owner to grant the app's service principal (${principal}) access.`);
  return error instanceof Error ? error : new Error(String(error));
}
var ACTIVE = /* @__PURE__ */ new Set(["ACTIVE"]);
function appProvider(agents, service) {
  const storage = agents.storage;
  const read = (pubkey) => parse(storage.get(recordKey(pubkey)));
  const records = () => storage.keys().filter((key2) => key2.startsWith(RECORD_PREFIX) && !key2.includes(":pending:")).map((key2) => parse(storage.get(key2))).filter((record) => Boolean(record?.pubkey));
  const write = (record) => storage.set(recordKey(record.pubkey), JSON.stringify(record));
  const clientOf = (record, signal) => workspaceOf(service, record.config.profile).ready(signal);
  async function identityOf(record, signal) {
    const identity = parseIdentity(await new UcSecrets(await clientOf(record, signal)).read(record.secret, signal));
    if (!identity) throw new Error(`The identity's key (${record.secret}) is gone; remove this agent and create it again.`);
    return identity;
  }
  async function saveIdentity(record, change, signal) {
    const identity = await identityOf(record, signal);
    await new UcSecrets(await clientOf(record, signal)).update(record.secret, JSON.stringify({ ...identity, ...change }), signal);
  }
  async function deploy2(record, signal) {
    const client = await clientOf(record, signal);
    const apps = new Apps(client);
    let app = await apps.get(record.config.app, signal);
    if (!app) throw new Error(`The app ${record.config.app} is gone.`);
    if (["STOPPED", "ERROR"].includes(app.compute_status?.state ?? "")) app = await apps.start(record.config.app, signal);
    app = await apps.until(record.config.app, (found) => ACTIVE.has(found.compute_status?.state ?? "") || ["ERROR", "STOPPED"].includes(found.compute_status?.state ?? ""), { timeoutMs: 12 * 6e4, signal });
    if (!app || !ACTIVE.has(app.compute_status?.state ?? "")) throw new Error(`The app's compute didn't start${app?.compute_status?.message ? `: ${app.compute_status.message}` : ""}. Try again in a minute.`);
    let deployment = await apps.deploy(record.config.app, record.source, signal);
    for (const end = Date.now() + 8 * 6e4; deployment.deployment_id && deployment.status?.state === "IN_PROGRESS" && Date.now() < end; ) {
      await wait(5e3, signal);
      deployment = await apps.deployment(record.config.app, deployment.deployment_id, signal);
    }
    if (deployment.status?.state === "FAILED") throw new Error(`The app's deployment failed: ${deployment.status.message ?? "no reason given"}`);
  }
  return {
    read,
    records,
    /** Whether the plugin has newer template code than the app was deployed with. */
    outdated: (record) => record.config.mode === "starter" && record.deployedSha !== APP_SHA,
    async provision(input) {
      const { signal } = input;
      const config = normalizeAppConfig(input.config);
      const problem = appConfigProblem(config);
      if (problem) throw new Error(problem);
      const pending = pendingKey(input.community, input.name);
      const prior = parse(storage.get(pending));
      const workspace = workspaceOf(service, config.profile);
      const client = await workspace.ready(signal);
      const apps = new Apps(client);
      const secrets = new UcSecrets(client);
      const [catalog, schema2] = config.schema.split(".");
      const secret = identitySecretName(config.schema, config.app);
      const record = {
        name: input.name,
        ...input.picture && { picture: input.picture },
        config,
        secret,
        source: prior?.source ?? await sourceFolder(workspace, config.app, signal),
        createdApp: prior?.config.app === config.app && prior.createdApp,
        host: client.host,
        createdAt: prior?.createdAt ?? Date.now()
      };
      let app = await apps.get(config.app, signal);
      if (app && config.mode === "starter" && !record.createdApp)
        throw new Error(`There's already an app named ${config.app} in this workspace. Pick another name, or choose "Connect an app you have" to use it.`);
      if (!app) {
        if (config.mode === "own") throw new Error(`There's no app named ${config.app} in this workspace.`);
        app = await apps.create(config.app, {
          description: `${isSearch(config) ? SEARCH_APP_PREFIX : "Buzz app"}: ${input.name}`.slice(0, 200),
          ...isSearch(config) && config.lakebase && { resources: [{ name: "postgres", description: "The search index", postgres: { branch: config.lakebase.branch, database: config.lakebase.database, permission: "CAN_CONNECT_AND_CREATE" } }] },
          signal
        });
        record.createdApp = true;
        await storage.set(pending, JSON.stringify(record));
      }
      if (!app.service_principal_client_id) app = await apps.until(config.app, (found) => Boolean(found.service_principal_client_id), { timeoutMs: 9e4, intervalMs: 3e3, signal }) ?? app;
      const principal = app.service_principal_client_id;
      if (!principal) throw new Error("Databricks hasn't given the app its service principal yet. Try again in a minute.");
      record.servicePrincipal = { id: principal, ...app.service_principal_name && { name: app.service_principal_name } };
      await ensureSchema(client, catalog, schema2, "Buzz identities for Databricks Apps, from the Databricks Agents plugin for Buzz.", signal);
      const stored = await secrets.read(secret, signal);
      let identity = parseIdentity(stored);
      if (identity && activated(identity) && prior?.pubkey !== getPublicKey(bytes(identity.key)))
        throw new Error(`The app ${config.app} already has a Buzz identity (${secret}). Remove that agent first, or use another app.`);
      if (!identity) {
        if (stored !== void 0) throw new Error(`${secret} already exists and isn't a Buzz identity.`);
        identity = { v: 1, key: hex(generateSecretKey()), app: config.app, workspace: client.host, answers: config.answers };
        await secrets.create(secret, JSON.stringify(identity), `The Buzz identity of the Databricks App ${config.app}. Its service principal reads it to sign in to Buzz.`, signal);
      }
      const pubkey = getPublicKey(bytes(identity.key));
      record.pubkey = pubkey;
      await storage.set(pending, JSON.stringify(record));
      await grantPrivileges(client, "catalog", catalog, principal, ["USE_CATALOG"], signal).catch((error) => Promise.reject(grantFailed(error, `the catalog ${catalog}`, principal)));
      await grantPrivileges(client, "schema", config.schema, principal, ["USE_SCHEMA"], signal).catch((error) => Promise.reject(grantFailed(error, `the schema ${config.schema}`, principal)));
      await grantPrivileges(client, "secret", secret, principal, ["READ_SECRET"], signal).catch((error) => Promise.reject(grantFailed(error, secret, principal)));
      const code = templateFiles(config, secret, record.source);
      await writeWorkspaceFiles(client, record.source, code.files, { keep: code.keep, signal });
      await write(record);
      return { pubkey, ...record.picture && { picture: record.picture } };
    },
    async activate(input) {
      const found = read(input.pubkey);
      if (!found) throw new Error("This app's identity was set up from another device; remove the agent and create it again here.");
      const record = { ...found, name: input.name, community: input.community, owner: String(input.auth[1]), authTag: [...input.auth].map(String) };
      await saveIdentity(record, { relay: input.community, owner: record.owner, auth: record.authTag, name: input.name, ...record.picture && { picture: record.picture }, answers: record.config.answers }, input.signal);
      if (record.config.mode === "starter") {
        await deploy2(record, input.signal);
        record.deployedSha = APP_SHA;
      }
      await write(record);
      await storage.set(pendingKey(input.community, found.name), null);
      if (isSearch(record.config)) {
        service.preferences.set("buzzSearchProfile", record.config.profile);
        service.preferences.set("buzzSearchApp", record.config.app);
      }
    },
    async profile(input) {
      const found = read(input.pubkey);
      if (!found) return;
      const record = { ...found, name: input.name };
      if (input.picture) record.picture = input.picture;
      else delete record.picture;
      const identity = await identityOf(record, input.signal);
      const { picture: _old, ...rest } = identity;
      await new UcSecrets(await clientOf(record, input.signal)).update(record.secret, JSON.stringify({ ...rest, name: input.name, ...input.picture && { picture: input.picture } }), input.signal);
      await write(record);
    },
    async remove(input) {
      const record = read(input.pubkey);
      if (!record) return;
      const client = await clientOf(record, input.signal);
      await new UcSecrets(client).delete(record.secret, input.signal);
      if (record.createdApp) await new Apps(client).delete(record.config.app, input.signal);
      await storage.set(recordKey(input.pubkey), null);
    },
    /** Whose mentions it takes, from its Settings tab. */
    async setAnswers(pubkey, answers, signal) {
      const record = read(pubkey);
      if (!record) throw new Error("This app is managed from another device.");
      await saveIdentity(record, { answers }, signal);
      await write({ ...record, config: { ...record.config, answers } });
    },
    /** Lets everyone in the workspace use the app (for a search index: search from Buzz). */
    async allowEveryone(pubkey, signal) {
      const record = read(pubkey);
      if (!record) throw new Error("This app is managed from another device.");
      await new Apps(await clientOf(record, signal)).allow(record.config.app, "users", "CAN_USE", signal);
    },
    async everyoneAllowed(pubkey, signal) {
      const record = read(pubkey);
      if (!record) return false;
      return new Apps(await clientOf(record, signal)).allowed(record.config.app, "users", signal).catch(() => false);
    },
    /** Puts the current library in its folder and deploys the folder again. */
    async redeploy(pubkey, signal) {
      const record = read(pubkey);
      if (!record) throw new Error("This app is managed from another device.");
      const code = templateFiles(record.config, record.secret, record.source);
      await writeWorkspaceFiles(await clientOf(record, signal), record.source, code.files, { keep: code.keep, ...signal && { signal } });
      await deploy2(record, signal);
      await write({ ...read(pubkey) ?? record, deployedSha: APP_SHA });
    },
    /** The app in Databricks, and what its status page says. */
    async status(pubkey, signal) {
      const record = read(pubkey);
      if (!record) return {};
      const client = await clientOf(record, signal);
      const app = await new Apps(client).get(record.config.app, signal);
      if (!app?.url || app.app_status?.state !== "RUNNING") return { ...app && { app } };
      try {
        const response = await client.request(`${app.url.replace(/\/+$/, "")}/api/status`, { ...signal && { signal }, timeoutMs: 15e3 });
        if (response.status !== 200) return { app, liveError: `Its status page answered HTTP ${response.status}.` };
        return { app, live: JSON.parse(response.body) };
      } catch (error) {
        return { app, liveError: describeError(error) };
      }
    }
  };
}
var MODE_HINT = {
  starter: "Makes a new app from a template. Its code goes in a folder in your workspace.",
  own: "Connects an app that's already in this workspace. You add buzz-app.mjs and one setting to its code; the agent's Settings tab shows how."
};
function CatalogField(props) {
  const status3 = useConnection(props.service).status;
  const catalogs2 = useAsync(() => cachedList(props.service, "catalogs", async () => listCatalogs(await props.service.ready())), [props.service, status3]);
  const [catalog = "", schema2 = DEFAULT_SCHEMA] = props.value.split(".");
  React.useEffect(() => {
    if (catalog || !catalogs2.data?.length) return;
    const first = catalogs2.data.find((name) => name === "main") ?? catalogs2.data.find((name) => name !== "samples") ?? catalogs2.data[0];
    props.onChange(`${first}.${schema2}`);
  }, [catalog, catalogs2.data]);
  return /* @__PURE__ */ React.createElement(Stack, { gap: 8 }, /* @__PURE__ */ React.createElement(
    SinglePicker,
    {
      label: "Where its key is kept",
      hint: "A Unity Catalog secret in this catalog and schema. Only the app's service principal can read it, besides you. You need to be able to grant access in this catalog.",
      value: catalog,
      valueLabel: catalog || "Pick a catalog",
      placeholder: "Pick a catalog",
      searchPlaceholder: `Search ${(catalogs2.data ?? []).length} catalogs`,
      options: (catalogs2.data ?? []).map((name) => ({ id: name, label: name, group: "Catalogs" })),
      loading: catalogs2.loading && !catalogs2.data ? "Loading catalogs\u2026" : false,
      ...props.disabled !== void 0 && { disabled: props.disabled },
      onChange: (option) => props.onChange(`${option.id}.${schema2}`)
    }
  ), /* @__PURE__ */ React.createElement(Field, { label: "Schema", hint: "Made if it isn't there." }, /* @__PURE__ */ React.createElement("input", { className: "dbx-input", value: schema2, disabled: props.disabled, onChange: (event) => props.onChange(`${catalog}.${event.target.value.trim()}`) })));
}
var TEMPLATE_HINT = {
  starter: "A small bot that answers mentions and says who it runs as, ready for you to change.",
  search: "Reads the community's public channels into a Lakebase database and searches them: from the Search page in Buzz, or when someone mentions it. Only public channels, which everyone in the community can read already."
};
function DatabaseField(props) {
  const status3 = useConnection(props.service).status;
  const projects = useAsync(() => cachedList(props.service, "lakebase-projects", async () => new Lakebase(await props.service.ready()).projects()), [props.service, status3]);
  const [error, setError] = React.useState();
  const project = props.value?.project ?? "";
  return /* @__PURE__ */ React.createElement(Stack, { gap: 8 }, /* @__PURE__ */ React.createElement(
    SinglePicker,
    {
      label: "Lakebase project",
      hint: props.value ? `Its index goes in ${props.value.database.split("/").pop()} on ${props.value.branch.split("/").pop()}, in a buzz_search schema the app owns. Lakebase Search (lakebase_text) gives the best ranking; without it, Postgres' own full-text search is used.` : "The app gets access to its default branch's database and keeps its index there.",
      value: project,
      valueLabel: (projects.data ?? []).find((found) => found.id === project)?.name ?? (project || "Pick a project"),
      placeholder: "Pick a project",
      searchPlaceholder: `Search ${(projects.data ?? []).length} projects`,
      options: (projects.data ?? []).map((found) => ({ id: found.id, label: found.name, group: "Lakebase" })),
      loading: projects.loading && !projects.data ? "Loading Lakebase projects\u2026" : false,
      ...props.disabled !== void 0 && { disabled: props.disabled },
      onChange: (option) => {
        setError(void 0);
        void props.service.ready().then((client) => new Lakebase(client).defaultDatabase(option.id)).then(
          (found) => {
            if (!found) setError("That project has no database on its default branch.");
            props.onChange(found ? { project: option.id, branch: found.branch, database: found.database } : void 0);
          },
          (cause) => setError(describeError(cause))
        );
      }
    }
  ), error && /* @__PURE__ */ React.createElement(Notice, { tone: "warning" }, error));
}
function AppPicker(props) {
  const status3 = useConnection(props.service).status;
  const apps = useAsync(() => cachedList(props.service, "apps", async () => new Apps(await props.service.ready()).list()), [props.service, status3]);
  return /* @__PURE__ */ React.createElement(
    SinglePicker,
    {
      label: "App",
      hint: "An app in this workspace. Its code needs buzz-app.mjs; nothing is deployed to it for you.",
      value: props.value,
      valueLabel: props.value || "Pick an app",
      placeholder: "Pick an app",
      searchPlaceholder: `Search ${(apps.data ?? []).length} apps`,
      options: (apps.data ?? []).map((app) => ({ id: app.name, label: app.name, group: "Apps", ...app.description && { detail: app.description } })),
      loading: apps.loading && !apps.data ? "Loading apps\u2026" : false,
      ...props.disabled !== void 0 && { disabled: props.disabled },
      onChange: (option) => props.onChange(option.id)
    }
  );
}
function AppForm(props) {
  const { config, onChange } = props;
  const workspace = useAgentService(props.service, config.profile);
  const problem = appConfigProblem(config);
  React.useEffect(() => props.onReadyChange?.(!problem), [problem]);
  const disabled = props.disabled !== void 0 ? { disabled: props.disabled } : {};
  return /* @__PURE__ */ React.createElement(DbxRoot, null, /* @__PURE__ */ React.createElement(Stack, { gap: 14 }, /* @__PURE__ */ React.createElement(NeedsConnection, { service: props.service }), /* @__PURE__ */ React.createElement(Text, { tone: "subtle", size: "sm" }, "A Buzz identity for code that runs as a Databricks App, like a Slack app's bot user. It works as the app's own service principal, with only the access you grant it, so it can answer anyone in the channels it's in."), /* @__PURE__ */ React.createElement(
    WorkspaceField,
    {
      service: props.service,
      ...config.profile && { profile: config.profile },
      ...disabled,
      onChange: (profile) => {
        const { profile: _old, ...rest } = config;
        onChange({ ...rest, ...profile && { profile }, app: config.mode === "own" ? "" : config.app, schema: "" });
      }
    }
  ), /* @__PURE__ */ React.createElement(Field, { label: "App", hint: MODE_HINT[config.mode] }, /* @__PURE__ */ React.createElement("select", { className: "dbx-select", ...disabled, value: config.mode, onChange: (event) => onChange({ ...config, mode: event.target.value, app: "" }) }, /* @__PURE__ */ React.createElement("option", { value: "starter" }, "Deploy a starter app for me"), /* @__PURE__ */ React.createElement("option", { value: "own" }, "Connect an app you have"))), config.mode === "starter" && /* @__PURE__ */ React.createElement(Field, { label: "Template", hint: TEMPLATE_HINT[config.template] }, /* @__PURE__ */ React.createElement("select", { className: "dbx-select", ...disabled, value: config.template, onChange: (event) => onChange({ ...config, template: event.target.value }) }, /* @__PURE__ */ React.createElement("option", { value: "starter" }, "Starter bot"), /* @__PURE__ */ React.createElement("option", { value: "search" }, "Search index"))), isSearch(config) && /* @__PURE__ */ React.createElement(
    DatabaseField,
    {
      service: workspace,
      ...config.lakebase && { value: config.lakebase },
      ...disabled,
      onChange: (lakebase) => {
        const { lakebase: _old, ...rest } = config;
        onChange({ ...rest, ...lakebase && { lakebase } });
      }
    }
  ), config.mode === "starter" ? /* @__PURE__ */ React.createElement(Field, { label: "App name", hint: "Lowercase letters, numbers and hyphens. It's the app's name in Databricks and part of its URL." }, /* @__PURE__ */ React.createElement("input", { className: "dbx-input", placeholder: "my-buzz-app", value: config.app, ...disabled, onChange: (event) => onChange({ ...config, app: event.target.value.toLowerCase().replace(/[^a-z0-9-]/g, "-") }) })) : /* @__PURE__ */ React.createElement(AppPicker, { service: workspace, value: config.app, ...disabled, onChange: (app) => onChange({ ...config, app }) }), /* @__PURE__ */ React.createElement(CatalogField, { service: workspace, value: config.schema, ...disabled, onChange: (schema2) => onChange({ ...config, schema: schema2 }) }), /* @__PURE__ */ React.createElement(Field, { label: "Answers", hint: "Everyone: anyone in a channel it's in can ask it, since it uses only its own access. Your app's code can choose otherwise." }, /* @__PURE__ */ React.createElement("select", { className: "dbx-select", ...disabled, value: config.answers, onChange: (event) => onChange({ ...config, answers: event.target.value }) }, /* @__PURE__ */ React.createElement("option", { value: "everyone" }, "Everyone in its channels"), /* @__PURE__ */ React.createElement("option", { value: "owner" }, "Only you"))), config.app && problem && /* @__PURE__ */ React.createElement(Notice, { tone: "warning" }, problem), /* @__PURE__ */ React.createElement(Text, { tone: "tertiary", size: "xs" }, config.mode === "starter" ? "Removing it deletes the app it made and its key. Its code stays in your workspace folder." : "Removing it deletes its key, so your app signs out of Buzz; the app itself stays.", " ", "A running app costs about 0.5 DBU an hour.")));
}
var COMPUTE_LABEL = { ACTIVE: "Running", STARTING: "Starting", STOPPED: "Stopped", STOPPING: "Stopping", UPDATING: "Updating", ERROR: "Compute error", DELETING: "Being deleted" };
var LIVE_LABEL = {
  connected: "Signed in to Buzz",
  waiting: "Waiting for Buzz to finish setting up its identity",
  connecting: "Can't reach Buzz yet",
  removed: "Its identity is gone",
  error: "Has a problem",
  starting: "Starting"
};
function Row(props) {
  return /* @__PURE__ */ React.createElement(Stack, { direction: "row", gap: 12, align: "baseline" }, /* @__PURE__ */ React.createElement(Text, { size: "sm", tone: "subtle", style: { width: 140, flex: "none" } }, props.label), /* @__PURE__ */ React.createElement("div", { style: { minWidth: 0, overflowWrap: "anywhere" } }, props.children));
}
function AppSettings(props) {
  const [nonce, setNonce] = React.useState(0);
  const status3 = useAsync((signal) => props.provider.status(props.pubkey, signal), [props.pubkey, nonce]);
  const record = props.provider.read(props.pubkey);
  const [busy, setBusy] = React.useState();
  const [error, setError] = React.useState();
  React.useEffect(() => {
    const timer = setInterval(() => setNonce((n) => n + 1), 15e3);
    return () => clearInterval(timer);
  }, []);
  if (!record)
    return /* @__PURE__ */ React.createElement(DbxRoot, { style: { padding: "4px 0 24px" } }, /* @__PURE__ */ React.createElement(Notice, { tone: "info" }, "This app's identity was set up from another device, which manages it."));
  const workspace = workspaceOf(props.service, record.config.profile);
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
  const app = status3.data?.app;
  const live = status3.data?.live;
  const compute = app?.compute_status?.state;
  const deployment = app?.pending_deployment ?? app?.active_deployment;
  const tone = live?.state === "connected" ? "success" : live?.state === "error" || compute === "ERROR" || deployment?.status?.state === "FAILED" ? "danger" : "active";
  const headline = !status3.data && status3.loading ? "Checking\u2026" : !app ? "The app is gone" : compute !== "ACTIVE" ? COMPUTE_LABEL[compute ?? ""] ?? compute ?? "Unknown" : live ? LIVE_LABEL[live.state ?? ""] ?? live.state : app.app_status?.state === "RUNNING" ? "Running" : "Not running its code yet";
  const detail2 = live?.lastError ?? status3.data?.liveError ?? (deployment?.status?.state === "FAILED" ? `Last deployment failed: ${deployment.status.message ?? ""}` : app?.app_status?.message);
  const yaml = appYaml({ secret: record.secret, source: record.source });
  return /* @__PURE__ */ React.createElement(DbxRoot, { style: { padding: "4px 0 24px" } }, /* @__PURE__ */ React.createElement(Stack, { gap: 16 }, /* @__PURE__ */ React.createElement(
    Notice,
    {
      tone: tone === "danger" ? "danger" : tone === "success" ? "info" : "warning",
      title: headline,
      action: /* @__PURE__ */ React.createElement(Button, { size: "sm", disabled: Boolean(busy), onClick: () => setNonce((n) => n + 1) }, "Check again")
    },
    detail2 ?? (live?.state === "connected" ? `It has answered ${live.answered ?? 0} mention${live.answered === 1 ? "" : "s"} since it started.` : "")
  ), /* @__PURE__ */ React.createElement(Stack, { gap: 8 }, /* @__PURE__ */ React.createElement(Text, { weight: 500 }, "How it's connected"), /* @__PURE__ */ React.createElement(Row, { label: "Buzz identity" }, /* @__PURE__ */ React.createElement(Text, { size: "sm", mono: true }, props.pubkey.slice(0, 16), "\u2026"), " ", /* @__PURE__ */ React.createElement(Badge, null, "owned by you")), /* @__PURE__ */ React.createElement(Row, { label: "Databricks App" }, /* @__PURE__ */ React.createElement(Text, { size: "sm", mono: true }, record.config.app), " ", app && /* @__PURE__ */ React.createElement(StatusDot, { tone: compute === "ACTIVE" ? "success" : compute === "ERROR" ? "danger" : "neutral", label: COMPUTE_LABEL[compute ?? ""] ?? "unknown" })), /* @__PURE__ */ React.createElement(Row, { label: "Runs as" }, /* @__PURE__ */ React.createElement(Text, { size: "sm" }, record.servicePrincipal?.name ?? app?.service_principal_name ?? "its service principal", " ", /* @__PURE__ */ React.createElement(Text, { as: "span", size: "sm", mono: true, tone: "subtle" }, record.servicePrincipal?.id ?? app?.service_principal_client_id))), /* @__PURE__ */ React.createElement(Row, { label: "Key" }, /* @__PURE__ */ React.createElement(Text, { size: "sm", mono: true }, record.secret)), /* @__PURE__ */ React.createElement(Row, { label: "Code" }, /* @__PURE__ */ React.createElement(Text, { size: "sm", mono: true }, record.source))), props.provider.outdated(record) && !isSearch(record.config) && /* @__PURE__ */ React.createElement(Notice, { tone: "info", title: "Newer code is available" }, "This plugin has a newer buzz-app.mjs. Deploy again puts it in the app's folder and deploys it; your app.mjs stays as it is."), isSearch(record.config) && /* @__PURE__ */ React.createElement(SearchInfo, { provider: props.provider, pubkey: props.pubkey, live, busy: Boolean(busy), run }), record.config.mode === "own" && /* @__PURE__ */ React.createElement(Stack, { gap: 8 }, /* @__PURE__ */ React.createElement(Text, { weight: 500 }, "Connect your app's code"), /* @__PURE__ */ React.createElement(Text, { size: "sm", tone: "subtle" }, "1. Copy buzz-app.mjs from ", record.source, " into your app, and use it as app.mjs there does. 2. Add this to your app.yaml (or set the environment variable). 3. Deploy your app."), /* @__PURE__ */ React.createElement(CodeView, { code: yaml, language: "yaml", copy: true })), /* @__PURE__ */ React.createElement(Field, { label: "Answers", hint: "Whose mentions it takes, unless its code says otherwise. It reads this again within a minute." }, /* @__PURE__ */ React.createElement(
    "select",
    {
      className: "dbx-select",
      disabled: Boolean(busy),
      value: record.config.answers,
      onChange: (event) => run("answers", () => props.provider.setAnswers(props.pubkey, event.target.value))
    },
    /* @__PURE__ */ React.createElement("option", { value: "everyone" }, "Everyone in its channels"),
    /* @__PURE__ */ React.createElement("option", { value: "owner" }, "Only you")
  )), error && /* @__PURE__ */ React.createElement(Notice, { tone: "danger" }, error), /* @__PURE__ */ React.createElement(Stack, { direction: "row", gap: 8, justify: "flex-end" }, app?.url && /* @__PURE__ */ React.createElement(Button, { variant: "ghost", onClick: () => openExternal(app.url) }, "Open the app"), workspace.workspaceUrl(`/apps/${record.config.app}`) && /* @__PURE__ */ React.createElement(Button, { variant: "ghost", onClick: () => openExternal(workspace.workspaceUrl(`/apps/${record.config.app}`)) }, "Open in Databricks"), record.config.mode === "starter" && /* @__PURE__ */ React.createElement(Button, { variant: "primary", disabled: Boolean(busy), onClick: () => run("deploy", () => props.provider.redeploy(props.pubkey)) }, busy === "deploy" ? /* @__PURE__ */ React.createElement(Spinner, { size: 11 }) : null, "Deploy again"))));
}
function SearchInfo(props) {
  const allowed = useAsync((signal) => props.provider.everyoneAllowed(props.pubkey, signal), [props.pubkey, props.busy]);
  const live = props.live;
  const line = (label, value) => typeof value === "string" || typeof value === "number" ? /* @__PURE__ */ React.createElement(Row, { label }, /* @__PURE__ */ React.createElement(Text, { size: "sm" }, String(value))) : null;
  return /* @__PURE__ */ React.createElement(Stack, { gap: 8 }, /* @__PURE__ */ React.createElement(Text, { weight: 500 }, "Search"), line("Index", live?.index), line("Indexed", live?.indexed), line("Self-check", live?.searchCheck), line("Reading", live?.reading), /* @__PURE__ */ React.createElement(Text, { size: "sm", tone: "subtle" }, "People search from the Search page in Buzz (in the Lakebase plugin), as themselves: they need Can Use on this app.", " ", allowed.data ? "Everyone in the workspace has it." : "So far only you have it.", " It indexes public channels only, but anyone with Can Use can search them, so give it to people in this community."), allowed.data === false && /* @__PURE__ */ React.createElement(Stack, { direction: "row", gap: 8 }, /* @__PURE__ */ React.createElement(Button, { size: "sm", disabled: props.busy, onClick: () => props.run("allow", () => props.provider.allowEveryone(props.pubkey)) }, "Let everyone in the workspace search")));
}
function refreshSearchIndexes(provider2) {
  const timer = setTimeout(() => {
    for (const record of provider2.records())
      if (record.community && isSearch(record.config) && provider2.outdated(record)) void provider2.redeploy(record.pubkey).catch(() => {
      });
  }, 2e4);
  return () => clearTimeout(timer);
}
function registerAppType(agents, service) {
  const provider2 = appProvider(agents, service);
  const icon = databricksIcon();
  const type = {
    id: APP_TYPE_ID,
    icon,
    title: "Databricks App",
    description: "A Buzz identity for code running as a Databricks App, like a Slack app: it works as the app's service principal and can answer anyone in its channels.",
    defaults: () => ({ config: normalizeAppConfig({}) }),
    summary: (agent) => summarizeApp(provider2.read(agent.pubkey ?? "")?.config ?? normalizeAppConfig(agent.config)),
    Create: (props) => /* @__PURE__ */ React.createElement(AppForm, { service, config: normalizeAppConfig(props.config), onChange: props.onChange, ...props.onReadyChange && { onReadyChange: props.onReadyChange }, disabled: props.disabled }),
    tabs: [
      {
        id: "settings",
        title: "Settings",
        role: "settings",
        component: (props) => /* @__PURE__ */ React.createElement(AppSettings, { service, provider: provider2, pubkey: props.agent.pubkey })
      }
    ],
    remote: {
      provision: provider2.provision,
      activate: provider2.activate,
      profile: provider2.profile,
      remove: provider2.remove
    }
  };
  agents.register(type);
  return refreshSearchIndexes(provider2);
}

// virtual:agent-runner
var RUNNER = '// Databricks Agents runner for Buzz (built by databricks-buzz-plugins). Apache-2.0.\nimport{execFile as Ec,spawn as Sc}from"node:child_process";import{appendFileSync as vc,existsSync as Ae,openSync as kc,readFileSync as en,rmSync as ar,statSync as No,truncateSync as _c,writeFileSync as Ye}from"node:fs";var Go=/^(tinyint|smallint|int|integer|bigint|long|short|byte|float|double|real|decimal|numeric)/i,pr=/^(date|timestamp)/i,jo=/(^|_)(id|ids|zip|zipcode|zip_code|postal_code|postcode|code|key|year|fiscal_year|phone)$/i;function zo(t,e,n=""){if(jo.test(n)&&!pr.test(t??"")&&!/^bool/i.test(t??""))return"text";if(t){if(Go.test(t))return"number";if(pr.test(t))return"time";if(/^bool/i.test(t))return"boolean";if(/^(string|varchar|char|binary|array|map|struct|interval)/i.test(t))return"text"}let r=e.filter(s=>s!==null&&s!=="");return r.length?r.every(s=>/^-?\\d+(\\.\\d+)?([eE][+-]?\\d+)?$/.test(s))?"number":r.every(s=>/^\\d{4}-\\d{2}(-\\d{2})?([T ]\\d{2}:\\d{2}(:\\d{2}(\\.\\d+)?)?(Z|[+-]\\d{2}:?\\d{2})?)?$/.test(s))?"time":"text":"text"}function ht(t,e,n={}){return{columns:t.map((r,s)=>({name:r.name,...r.type&&{type:r.type},kind:zo(r.type,e.slice(0,50).map(o=>o[s]??null),r.name)})),rows:e,...n}}function nn(t){let e=(t.manifest?.schema?.columns??[]).map(s=>({name:s.name,type:s.type_text??s.type_name??""})),n=t.result?.data_array??[],r=t.manifest?.total_row_count;return ht(e,n,{...r!==void 0&&{totalRows:r},truncated:!!t.manifest?.truncated||r!==void 0&&r>n.length})}var Ko=new Intl.NumberFormat(void 0,{notation:"compact",maximumFractionDigits:1}),Fo=new Intl.NumberFormat(void 0,{maximumFractionDigits:2});function Wo(t,e="precise"){return Number.isFinite(t)?e==="compact"&&Math.abs(t)>=1e4?Ko.format(t):Fo.format(t):String(t)}function Vo(t,e){if(t===null)return"null";if(e==="number"){let n=Number(t);if(Number.isFinite(n)&&Math.abs(n)<1e15)return Wo(n)}return e==="time"&&/T00:00:00(\\.000)?(Z)?$/.test(t)?t.slice(0,10):t}function mt(t,e=20){if(!t.columns.length)return"_No columns._";let n=c=>c.replace(/\\|/g,"\\\\|").replace(/\\n/g," "),r=`| ${t.columns.map(c=>n(c.name)).join(" | ")} |`,s=`| ${t.columns.map(c=>c.kind==="number"?"---:":"---").join(" | ")} |`,o=t.rows.slice(0,e).map(c=>`| ${t.columns.map((l,d)=>n(Vo(c[d]??null,l.kind))).join(" | ")} |`),i=t.totalRows??t.rows.length,a=i>Math.min(e,t.rows.length)?`\n\n_Showing ${Math.min(e,t.rows.length)} of ${i} rows._`:"";return[r,s,...o].join(`\n`)+a}function Zo(t){let e=n=>n===null?"":/[",\\n]/.test(n)?`"${n.replace(/"/g,\'""\')}"`:n;return[t.columns.map(n=>e(n.name)).join(","),...t.rows.map(n=>n.map(e).join(","))].join(`\n`)}var rn="databricks-result";function Xe(t,e=200){let n={...t,rows:t.rows.slice(0,e)},r=Zo(n),s=r.includes("```")?"````":"```",o=t.totalRows??t.rows.length,i=o>n.rows.length?`\n\n_Showing ${n.rows.length} of ${o} rows._`:"";return`${s}${rn}\n${r}\n${s}${i}`}var Yo=new Set(["COMPLETED","FAILED","QUERY_RESULT_EXPIRED","CANCELLED"]);var gr=t=>t.message_id??t.id??"";function Xo(t){let e=t.attachments??[],n=e.map(o=>o.text?.content).filter(o=>!!o).join(`\n\n`),r=e.find(o=>o.query?.query),s=e.flatMap(o=>o.suggested_questions?.questions??[]);return{text:n,sql:r?.query?.query,queryTitle:r?.query?.title,queryDescription:r?.query?.description,queryAttachmentId:r?.attachment_id,rowCount:r?.query?.query_result_metadata?.row_count,suggestions:s,error:t.error?.error}}var Je=t=>`/api/2.0/genie/spaces/${encodeURIComponent(t)}`,fe=class{constructor(e){this.client=e}async listSpaces(e){let n=[],r;for(let s=0;s<20;s++){let o=await this.client.get("/api/2.0/genie/spaces",{query:{page_size:100,page_token:r},...e&&{signal:e}});if(n.push(...o.spaces??[]),r=o.next_page_token,!r)break}return n.sort((s,o)=>s.title.localeCompare(o.title))}getSpace(e,n){return this.client.get(Je(e),n?{signal:n}:{})}async ask(e,n,r,s){if(r){let a=await this.client.post(`${Je(e)}/conversations/${encodeURIComponent(r)}/messages`,{content:n},s?{signal:s}:{});return{...a,conversation_id:a.conversation_id??r}}let o=await this.client.post(`${Je(e)}/start-conversation`,{content:n},s?{signal:s}:{}),i=o.conversation_id??o.conversation?.id??o.message?.conversation_id??"";return{content:n,status:"SUBMITTED",...o.message,conversation_id:i,message_id:o.message_id??o.message?.message_id??o.message?.id??""}}getMessage(e,n,r,s){return this.client.get(`${Je(e)}/conversations/${encodeURIComponent(n)}/messages/${encodeURIComponent(r)}`,s?{signal:s}:{})}async wait(e,n,r,s){let o=n,i=1e3,a=Date.now()+10*6e4;for(;!Yo.has(o.status);){if(Date.now()>a)throw new Error("Genie did not answer within 10 minutes.");await new Promise(c=>setTimeout(c,i)),s?.throwIfAborted(),i=Math.min(5e3,Math.round(i*1.4)),o={...await this.getMessage(e,o.conversation_id,gr(o),s),conversation_id:o.conversation_id},r?.(o)}return o}async result(e,n,r,s){let o=`${Je(e)}/conversations/${encodeURIComponent(n.conversation_id)}/messages/${encodeURIComponent(gr(n))}/attachments/${encodeURIComponent(r)}`;try{let a=await this.client.get(`${o}/query-result`,s?{signal:s}:{});if(a.statement_response?.result||a.statement_response?.manifest)return nn(a.statement_response)}catch(a){if(a.status!==404&&a.status!==400)throw a}let i=await this.client.post(`${o}/execute-query`,{},s?{signal:s}:{});return nn(i.statement_response??{})}async answer(e,n,r={}){let s=await this.ask(e,n,r.conversationId,r.signal);r.onUpdate?.(s);let o=await this.wait(e,s,r.onUpdate,r.signal),i=Xo(o),a;return o.status==="COMPLETED"&&i.queryAttachmentId&&(a=await this.result(e,o,i.queryAttachmentId,r.signal).catch(()=>{})),{message:o,...i,result:a}}static webPath(e,n){return`/genie/rooms/${encodeURIComponent(e)}${n?`/chats/${encodeURIComponent(n)}`:""}`}};function Qe(t){return t instanceof Uint8Array||ArrayBuffer.isView(t)&&t.constructor.name==="Uint8Array"}function ie(t,e=""){if(!Number.isSafeInteger(t)||t<0){let n=e&&`"${e}" `;throw new Error(`${n}expected integer >= 0, got ${t}`)}}function P(t,e,n=""){let r=Qe(t),s=t?.length,o=e!==void 0;if(!r||o&&s!==e){let i=n&&`"${n}" `,a=o?` of length ${e}`:"",c=r?`length=${s}`:`type=${typeof t}`;throw new Error(i+"expected Uint8Array"+a+", got "+c)}return t}function Ie(t){if(typeof t!="function"||typeof t.create!="function")throw new Error("Hash must wrapped by utils.createHasher");ie(t.outputLen),ie(t.blockLen)}function Me(t,e=!0){if(t.destroyed)throw new Error("Hash instance has been destroyed");if(e&&t.finished)throw new Error("Hash#digest() has already been called")}function mr(t,e){P(t,void 0,"digestInto() output");let n=e.outputLen;if(t.length<n)throw new Error(\'"digestInto() output" expected to be of length >=\'+n)}function ge(...t){for(let e=0;e<t.length;e++)t[e].fill(0)}function yt(t){return new DataView(t.buffer,t.byteOffset,t.byteLength)}function le(t,e){return t<<32-e|t>>>e}var yr=typeof Uint8Array.from([]).toHex=="function"&&typeof Uint8Array.fromHex=="function",Jo=Array.from({length:256},(t,e)=>e.toString(16).padStart(2,"0"));function ae(t){if(P(t),yr)return t.toHex();let e="";for(let n=0;n<t.length;n++)e+=Jo[t[n]];return e}var pe={_0:48,_9:57,A:65,F:70,a:97,f:102};function hr(t){if(t>=pe._0&&t<=pe._9)return t-pe._0;if(t>=pe.A&&t<=pe.F)return t-(pe.A-10);if(t>=pe.a&&t<=pe.f)return t-(pe.a-10)}function re(t){if(typeof t!="string")throw new Error("hex string expected, got "+typeof t);if(yr)return Uint8Array.fromHex(t);let e=t.length,n=e/2;if(e%2)throw new Error("hex string expected, got unpadded hex of length "+e);let r=new Uint8Array(n);for(let s=0,o=0;s<n;s++,o+=2){let i=hr(t.charCodeAt(o)),a=hr(t.charCodeAt(o+1));if(i===void 0||a===void 0){let c=t[o]+t[o+1];throw new Error(\'hex string expected, got non-hex character "\'+c+\'" at index \'+o)}r[s]=i*16+a}return r}function Z(...t){let e=0;for(let r=0;r<t.length;r++){let s=t[r];P(s),e+=s.length}let n=new Uint8Array(e);for(let r=0,s=0;r<t.length;r++){let o=t[r];n.set(o,s),s+=o.length}return n}function br(t,e={}){let n=(s,o)=>t(o).update(s).digest(),r=t(void 0);return n.outputLen=r.outputLen,n.blockLen=r.blockLen,n.create=s=>t(s),Object.assign(n,e),Object.freeze(n)}function he(t=32){let e=typeof globalThis=="object"?globalThis.crypto:null;if(typeof e?.getRandomValues!="function")throw new Error("crypto.getRandomValues must be defined");return e.getRandomValues(new Uint8Array(t))}var wr=t=>({oid:Uint8Array.from([6,9,96,134,72,1,101,3,4,2,t])});function xr(t,e,n){return t&e^~t&n}function Er(t,e,n){return t&e^t&n^e&n}var bt=class{blockLen;outputLen;padOffset;isLE;buffer;view;finished=!1;length=0;pos=0;destroyed=!1;constructor(e,n,r,s){this.blockLen=e,this.outputLen=n,this.padOffset=r,this.isLE=s,this.buffer=new Uint8Array(e),this.view=yt(this.buffer)}update(e){Me(this),P(e);let{view:n,buffer:r,blockLen:s}=this,o=e.length;for(let i=0;i<o;){let a=Math.min(s-this.pos,o-i);if(a===s){let c=yt(e);for(;s<=o-i;i+=s)this.process(c,i);continue}r.set(e.subarray(i,i+a),this.pos),this.pos+=a,i+=a,this.pos===s&&(this.process(n,0),this.pos=0)}return this.length+=e.length,this.roundClean(),this}digestInto(e){Me(this),mr(e,this),this.finished=!0;let{buffer:n,view:r,blockLen:s,isLE:o}=this,{pos:i}=this;n[i++]=128,ge(this.buffer.subarray(i)),this.padOffset>s-i&&(this.process(r,0),i=0);for(let u=i;u<s;u++)n[u]=0;r.setBigUint64(s-8,BigInt(this.length*8),o),this.process(r,0);let a=yt(e),c=this.outputLen;if(c%4)throw new Error("_sha2: outputLen must be aligned to 32bit");let l=c/4,d=this.get();if(l>d.length)throw new Error("_sha2: outputLen bigger than state");for(let u=0;u<l;u++)a.setUint32(4*u,d[u],o)}digest(){let{buffer:e,outputLen:n}=this;this.digestInto(e);let r=e.slice(0,n);return this.destroy(),r}_cloneInto(e){e||=new this.constructor,e.set(...this.get());let{blockLen:n,buffer:r,length:s,finished:o,destroyed:i,pos:a}=this;return e.destroyed=i,e.finished=o,e.length=s,e.pos=a,s%n&&e.buffer.set(r),e}clone(){return this._cloneInto()}},me=Uint32Array.from([1779033703,3144134277,1013904242,2773480762,1359893119,2600822924,528734635,1541459225]);var Qo=Uint32Array.from([1116352408,1899447441,3049323471,3921009573,961987163,1508970993,2453635748,2870763221,3624381080,310598401,607225278,1426881987,1925078388,2162078206,2614888103,3248222580,3835390401,4022224774,264347078,604807628,770255983,1249150122,1555081692,1996064986,2554220882,2821834349,2952996808,3210313671,3336571891,3584528711,113926993,338241895,666307205,773529912,1294757372,1396182291,1695183700,1986661051,2177026350,2456956037,2730485921,2820302411,3259730800,3345764771,3516065817,3600352804,4094571909,275423344,430227734,506948616,659060556,883997877,958139571,1322822218,1537002063,1747873779,1955562222,2024104815,2227730452,2361852424,2428436474,2756734187,3204031479,3329325298]),Ee=new Uint32Array(64),sn=class extends bt{constructor(e){super(64,e,8,!1)}get(){let{A:e,B:n,C:r,D:s,E:o,F:i,G:a,H:c}=this;return[e,n,r,s,o,i,a,c]}set(e,n,r,s,o,i,a,c){this.A=e|0,this.B=n|0,this.C=r|0,this.D=s|0,this.E=o|0,this.F=i|0,this.G=a|0,this.H=c|0}process(e,n){for(let u=0;u<16;u++,n+=4)Ee[u]=e.getUint32(n,!1);for(let u=16;u<64;u++){let m=Ee[u-15],f=Ee[u-2],y=le(m,7)^le(m,18)^m>>>3,S=le(f,17)^le(f,19)^f>>>10;Ee[u]=S+Ee[u-7]+y+Ee[u-16]|0}let{A:r,B:s,C:o,D:i,E:a,F:c,G:l,H:d}=this;for(let u=0;u<64;u++){let m=le(a,6)^le(a,11)^le(a,25),f=d+m+xr(a,c,l)+Qo[u]+Ee[u]|0,S=(le(r,2)^le(r,13)^le(r,22))+Er(r,s,o)|0;d=l,l=c,c=a,a=i+f|0,i=o,o=s,s=r,r=f+S|0}r=r+this.A|0,s=s+this.B|0,o=o+this.C|0,i=i+this.D|0,a=a+this.E|0,c=c+this.F|0,l=l+this.G|0,d=d+this.H|0,this.set(r,s,o,i,a,c,l,d)}roundClean(){ge(Ee)}destroy(){this.set(0,0,0,0,0,0,0,0),ge(this.buffer)}},on=class extends sn{A=me[0]|0;B=me[1]|0;C=me[2]|0;D=me[3]|0;E=me[4]|0;F=me[5]|0;G=me[6]|0;H=me[7]|0;constructor(){super(32)}};var ce=br(()=>new on,wr(1));var cn=BigInt(0),an=BigInt(1);function et(t,e=""){if(typeof t!="boolean"){let n=e&&`"${e}" `;throw new Error(n+"expected boolean, got type="+typeof t)}return t}function Sr(t){if(typeof t=="bigint"){if(!wt(t))throw new Error("positive bigint expected, got "+t)}else ie(t);return t}function tt(t){let e=Sr(t).toString(16);return e.length&1?"0"+e:e}function vr(t){if(typeof t!="string")throw new Error("hex string expected, got "+typeof t);return t===""?cn:BigInt("0x"+t)}function Se(t){return vr(ae(t))}function ln(t){return vr(ae(ei(P(t)).reverse()))}function xt(t,e){ie(e),t=Sr(t);let n=re(t.toString(16).padStart(e*2,"0"));if(n.length!==e)throw new Error("number too large");return n}function dn(t,e){return xt(t,e).reverse()}function ei(t){return Uint8Array.from(t)}function kr(t){return Uint8Array.from(t,(e,n)=>{let r=e.charCodeAt(0);if(e.length!==1||r>127)throw new Error(`string contains non-ASCII character "${t[n]}" with code ${r} at position ${n}`);return r})}var wt=t=>typeof t=="bigint"&&cn<=t;function ti(t,e,n){return wt(t)&&wt(e)&&wt(n)&&e<=t&&t<n}function _r(t,e,n,r){if(!ti(e,n,r))throw new Error("expected valid "+t+": "+n+" <= n < "+r+", got "+e)}function un(t){let e;for(e=0;t>cn;t>>=an,e+=1);return e}var nt=t=>(an<<BigInt(t))-an;function Rr(t,e,n){if(ie(t,"hashLen"),ie(e,"qByteLen"),typeof n!="function")throw new Error("hmacFn must be a function");let r=E=>new Uint8Array(E),s=Uint8Array.of(),o=Uint8Array.of(0),i=Uint8Array.of(1),a=1e3,c=r(t),l=r(t),d=0,u=()=>{c.fill(1),l.fill(0),d=0},m=(...E)=>n(l,Z(c,...E)),f=(E=s)=>{l=m(o,E),c=m(),E.length!==0&&(l=m(i,E),c=m())},y=()=>{if(d++>=a)throw new Error("drbg: tried max amount of iterations");let E=0,b=[];for(;E<e;){c=m();let C=c.slice();b.push(C),E+=c.length}return Z(...b)};return(E,b)=>{u(),f(E);let C;for(;!(C=b(y()));)f();return u(),C}}function rt(t,e={},n={}){if(!t||typeof t!="object")throw new Error("expected valid options object");function r(o,i,a){let c=t[o];if(a&&c===void 0)return;let l=typeof c;if(l!==i||c===null)throw new Error(`param "${o}" is invalid: expected ${i}, got ${l}`)}let s=(o,i)=>Object.entries(o).forEach(([a,c])=>r(a,c,i));s(e,!1),s(n,!0)}function fn(t){let e=new WeakMap;return(n,...r)=>{let s=e.get(n);if(s!==void 0)return s;let o=t(n,...r);return e.set(n,o),o}}var ne=BigInt(0),te=BigInt(1),$e=BigInt(2),Ir=BigInt(3),$r=BigInt(4),Or=BigInt(5),ni=BigInt(7),Cr=BigInt(8),ri=BigInt(9),Lr=BigInt(16);function de(t,e){let n=t%e;return n>=ne?n:e+n}function oe(t,e,n){let r=t;for(;e-- >ne;)r*=r,r%=n;return r}function Tr(t,e){if(t===ne)throw new Error("invert: expected non-zero number");if(e<=ne)throw new Error("invert: expected positive modulus, got "+e);let n=de(t,e),r=e,s=ne,o=te,i=te,a=ne;for(;n!==ne;){let l=r/n,d=r%n,u=s-i*l,m=o-a*l;r=n,n=d,s=i,o=a,i=u,a=m}if(r!==te)throw new Error("invert: does not exist");return de(s,e)}function gn(t,e,n){if(!t.eql(t.sqr(e),n))throw new Error("Cannot find square root")}function Br(t,e){let n=(t.ORDER+te)/$r,r=t.pow(e,n);return gn(t,r,e),r}function si(t,e){let n=(t.ORDER-Or)/Cr,r=t.mul(e,$e),s=t.pow(r,n),o=t.mul(e,s),i=t.mul(t.mul(o,$e),s),a=t.mul(o,t.sub(i,t.ONE));return gn(t,a,e),a}function oi(t){let e=Ue(t),n=Nr(t),r=n(e,e.neg(e.ONE)),s=n(e,r),o=n(e,e.neg(r)),i=(t+ni)/Lr;return(a,c)=>{let l=a.pow(c,i),d=a.mul(l,r),u=a.mul(l,s),m=a.mul(l,o),f=a.eql(a.sqr(d),c),y=a.eql(a.sqr(u),c);l=a.cmov(l,d,f),d=a.cmov(m,u,y);let S=a.eql(a.sqr(d),c),E=a.cmov(l,d,S);return gn(a,E,c),E}}function Nr(t){if(t<Ir)throw new Error("sqrt is not defined for small field");let e=t-te,n=0;for(;e%$e===ne;)e/=$e,n++;let r=$e,s=Ue(t);for(;Ar(s,r)===1;)if(r++>1e3)throw new Error("Cannot find square root: probably non-prime P");if(n===1)return Br;let o=s.pow(r,e),i=(e+te)/$e;return function(c,l){if(c.is0(l))return l;if(Ar(c,l)!==1)throw new Error("Cannot find square root");let d=n,u=c.mul(c.ONE,o),m=c.pow(l,e),f=c.pow(l,i);for(;!c.eql(m,c.ONE);){if(c.is0(m))return c.ZERO;let y=1,S=c.sqr(m);for(;!c.eql(S,c.ONE);)if(y++,S=c.sqr(S),y===d)throw new Error("Cannot find square root");let E=te<<BigInt(d-y-1),b=c.pow(u,E);d=y,u=c.sqr(b),m=c.mul(m,u),f=c.mul(f,b)}return f}}function ii(t){return t%$r===Ir?Br:t%Cr===Or?si:t%Lr===ri?oi(t):Nr(t)}var ai=["create","isValid","is0","neg","inv","sqrt","sqr","eql","add","sub","mul","pow","div","addN","subN","mulN","sqrN"];function hn(t){let e={ORDER:"bigint",BYTES:"number",BITS:"number"},n=ai.reduce((r,s)=>(r[s]="function",r),e);return rt(t,n),t}function ci(t,e,n){if(n<ne)throw new Error("invalid exponent, negatives unsupported");if(n===ne)return t.ONE;if(n===te)return e;let r=t.ONE,s=e;for(;n>ne;)n&te&&(r=t.mul(r,s)),s=t.sqr(s),n>>=te;return r}function Et(t,e,n=!1){let r=new Array(e.length).fill(n?t.ZERO:void 0),s=e.reduce((i,a,c)=>t.is0(a)?i:(r[c]=i,t.mul(i,a)),t.ONE),o=t.inv(s);return e.reduceRight((i,a,c)=>t.is0(a)?i:(r[c]=t.mul(i,r[c]),t.mul(i,a)),o),r}function Ar(t,e){let n=(t.ORDER-te)/$e,r=t.pow(e,n),s=t.eql(r,t.ONE),o=t.eql(r,t.ZERO),i=t.eql(r,t.neg(t.ONE));if(!s&&!o&&!i)throw new Error("invalid Legendre symbol result");return s?1:o?0:-1}function li(t,e){e!==void 0&&ie(e);let n=e!==void 0?e:t.toString(2).length,r=Math.ceil(n/8);return{nBitLength:n,nByteLength:r}}var pn=class{ORDER;BITS;BYTES;isLE;ZERO=ne;ONE=te;_lengths;_sqrt;_mod;constructor(e,n={}){if(e<=ne)throw new Error("invalid field: expected ORDER > 0, got "+e);let r;this.isLE=!1,n!=null&&typeof n=="object"&&(typeof n.BITS=="number"&&(r=n.BITS),typeof n.sqrt=="function"&&(this.sqrt=n.sqrt),typeof n.isLE=="boolean"&&(this.isLE=n.isLE),n.allowedLengths&&(this._lengths=n.allowedLengths?.slice()),typeof n.modFromBytes=="boolean"&&(this._mod=n.modFromBytes));let{nBitLength:s,nByteLength:o}=li(e,r);if(o>2048)throw new Error("invalid field: expected ORDER of <= 2048 bytes");this.ORDER=e,this.BITS=s,this.BYTES=o,this._sqrt=void 0,Object.preventExtensions(this)}create(e){return de(e,this.ORDER)}isValid(e){if(typeof e!="bigint")throw new Error("invalid field element: expected bigint, got "+typeof e);return ne<=e&&e<this.ORDER}is0(e){return e===ne}isValidNot0(e){return!this.is0(e)&&this.isValid(e)}isOdd(e){return(e&te)===te}neg(e){return de(-e,this.ORDER)}eql(e,n){return e===n}sqr(e){return de(e*e,this.ORDER)}add(e,n){return de(e+n,this.ORDER)}sub(e,n){return de(e-n,this.ORDER)}mul(e,n){return de(e*n,this.ORDER)}pow(e,n){return ci(this,e,n)}div(e,n){return de(e*Tr(n,this.ORDER),this.ORDER)}sqrN(e){return e*e}addN(e,n){return e+n}subN(e,n){return e-n}mulN(e,n){return e*n}inv(e){return Tr(e,this.ORDER)}sqrt(e){return this._sqrt||(this._sqrt=ii(this.ORDER)),this._sqrt(this,e)}toBytes(e){return this.isLE?dn(e,this.BYTES):xt(e,this.BYTES)}fromBytes(e,n=!1){P(e);let{_lengths:r,BYTES:s,isLE:o,ORDER:i,_mod:a}=this;if(r){if(!r.includes(e.length)||e.length>s)throw new Error("Field.fromBytes: expected "+r+" bytes, got "+e.length);let l=new Uint8Array(s);l.set(e,o?0:l.length-e.length),e=l}if(e.length!==s)throw new Error("Field.fromBytes: expected "+s+" bytes, got "+e.length);let c=o?ln(e):Se(e);if(a&&(c=de(c,i)),!n&&!this.isValid(c))throw new Error("invalid field element: outside of range 0..ORDER");return c}invertBatch(e){return Et(this,e)}cmov(e,n,r){return r?n:e}};function Ue(t,e={}){return new pn(t,e)}function Pr(t){if(typeof t!="bigint")throw new Error("field order must be bigint");let e=t.toString(2).length;return Math.ceil(e/8)}function mn(t){let e=Pr(t);return e+Math.ceil(e/2)}function St(t,e,n=!1){P(t);let r=t.length,s=Pr(e),o=mn(e);if(r<16||r<o||r>1024)throw new Error("expected "+o+"-1024 bytes of input, got "+r);let i=n?ln(t):Se(t),a=de(i,e-te)+te;return n?dn(a,s):xt(a,s)}var He=BigInt(0),Oe=BigInt(1);function st(t,e){let n=e.negate();return t?n:e}function xn(t,e){let n=Et(t.Fp,e.map(r=>r.Z));return e.map((r,s)=>t.fromAffine(r.toAffine(n[s])))}function Hr(t,e){if(!Number.isSafeInteger(t)||t<=0||t>e)throw new Error("invalid window size, expected [1.."+e+"], got W="+t)}function yn(t,e){Hr(t,e);let n=Math.ceil(e/t)+1,r=2**(t-1),s=2**t,o=nt(t),i=BigInt(t);return{windows:n,windowSize:r,mask:o,maxNumber:s,shiftBy:i}}function Dr(t,e,n){let{windowSize:r,mask:s,maxNumber:o,shiftBy:i}=n,a=Number(t&s),c=t>>i;a>r&&(a-=o,c+=Oe);let l=e*r,d=l+Math.abs(a)-1,u=a===0,m=a<0,f=e%2!==0;return{nextN:c,offset:d,isZero:u,isNeg:m,isNegF:f,offsetF:l}}var bn=new WeakMap,qr=new WeakMap;function wn(t){return qr.get(t)||1}function Mr(t){if(t!==He)throw new Error("invalid wNAF")}var vt=class{BASE;ZERO;Fn;bits;constructor(e,n){this.BASE=e.BASE,this.ZERO=e.ZERO,this.Fn=e.Fn,this.bits=n}_unsafeLadder(e,n,r=this.ZERO){let s=e;for(;n>He;)n&Oe&&(r=r.add(s)),s=s.double(),n>>=Oe;return r}precomputeWindow(e,n){let{windows:r,windowSize:s}=yn(n,this.bits),o=[],i=e,a=i;for(let c=0;c<r;c++){a=i,o.push(a);for(let l=1;l<s;l++)a=a.add(i),o.push(a);i=a.double()}return o}wNAF(e,n,r){if(!this.Fn.isValid(r))throw new Error("invalid scalar");let s=this.ZERO,o=this.BASE,i=yn(e,this.bits);for(let a=0;a<i.windows;a++){let{nextN:c,offset:l,isZero:d,isNeg:u,isNegF:m,offsetF:f}=Dr(r,a,i);r=c,d?o=o.add(st(m,n[f])):s=s.add(st(u,n[l]))}return Mr(r),{p:s,f:o}}wNAFUnsafe(e,n,r,s=this.ZERO){let o=yn(e,this.bits);for(let i=0;i<o.windows&&r!==He;i++){let{nextN:a,offset:c,isZero:l,isNeg:d}=Dr(r,i,o);if(r=a,!l){let u=n[c];s=s.add(d?u.negate():u)}}return Mr(r),s}getPrecomputes(e,n,r){let s=bn.get(n);return s||(s=this.precomputeWindow(n,e),e!==1&&(typeof r=="function"&&(s=r(s)),bn.set(n,s))),s}cached(e,n,r){let s=wn(e);return this.wNAF(s,this.getPrecomputes(s,e,r),n)}unsafe(e,n,r,s){let o=wn(e);return o===1?this._unsafeLadder(e,n,s):this.wNAFUnsafe(o,this.getPrecomputes(o,e,r),n,s)}createCache(e,n){Hr(n,this.bits),qr.set(e,n),bn.delete(e)}hasCache(e){return wn(e)!==1}};function Gr(t,e,n,r){let s=e,o=t.ZERO,i=t.ZERO;for(;n>He||r>He;)n&Oe&&(o=o.add(s)),r&Oe&&(i=i.add(s)),s=s.double(),n>>=Oe,r>>=Oe;return{p1:o,p2:i}}function Ur(t,e,n){if(e){if(e.ORDER!==t)throw new Error("Field.ORDER must match order: Fp == p, Fn == n");return hn(e),e}else return Ue(t,{isLE:n})}function jr(t,e,n={},r){if(r===void 0&&(r=t==="edwards"),!e||typeof e!="object")throw new Error(`expected valid ${t} CURVE object`);for(let c of["p","n","h"]){let l=e[c];if(!(typeof l=="bigint"&&l>He))throw new Error(`CURVE.${c} must be positive bigint`)}let s=Ur(e.p,n.Fp,r),o=Ur(e.n,n.Fn,r),a=["Gx","Gy","a",t==="weierstrass"?"b":"d"];for(let c of a)if(!s.isValid(e[c]))throw new Error(`CURVE.${c} must be valid field element of CURVE.Fp`);return e=Object.freeze(Object.assign({},e)),{CURVE:e,Fp:s,Fn:o}}function kt(t,e){return function(r){let s=t(r);return{secretKey:s,publicKey:e(s)}}}var _t=class{oHash;iHash;blockLen;outputLen;finished=!1;destroyed=!1;constructor(e,n){if(Ie(e),P(n,void 0,"key"),this.iHash=e.create(),typeof this.iHash.update!="function")throw new Error("Expected instance of class which extends utils.Hash");this.blockLen=this.iHash.blockLen,this.outputLen=this.iHash.outputLen;let r=this.blockLen,s=new Uint8Array(r);s.set(n.length>r?e.create().update(n).digest():n);for(let o=0;o<s.length;o++)s[o]^=54;this.iHash.update(s),this.oHash=e.create();for(let o=0;o<s.length;o++)s[o]^=106;this.oHash.update(s),ge(s)}update(e){return Me(this),this.iHash.update(e),this}digestInto(e){Me(this),P(e,this.outputLen,"output"),this.finished=!0,this.iHash.digestInto(e),this.oHash.update(e),this.oHash.digestInto(e),this.destroy()}digest(){let e=new Uint8Array(this.oHash.outputLen);return this.digestInto(e),e}_cloneInto(e){e||=Object.create(Object.getPrototypeOf(this),{});let{oHash:n,iHash:r,finished:s,destroyed:o,blockLen:i,outputLen:a}=this;return e=e,e.finished=s,e.destroyed=o,e.blockLen=i,e.outputLen=a,e.oHash=n._cloneInto(e.oHash),e.iHash=r._cloneInto(e.iHash),e}clone(){return this._cloneInto()}destroy(){this.destroyed=!0,this.oHash.destroy(),this.iHash.destroy()}},ve=(t,e,n)=>new _t(t,e).update(n).digest();ve.create=(t,e)=>new _t(t,e);var zr=(t,e)=>(t+(t>=0?e:-e)/Kr)/e;function di(t,e,n){let[[r,s],[o,i]]=e,a=zr(i*t,n),c=zr(-s*t,n),l=t-a*r-c*o,d=-a*s-c*i,u=l<ye,m=d<ye;u&&(l=-l),m&&(d=-d);let f=nt(Math.ceil(un(n)/2))+qe;if(l<ye||l>=f||d<ye||d>=f)throw new Error("splitScalar (endomorphism): failed, k="+t);return{k1neg:u,k1:l,k2neg:m,k2:d}}function Sn(t){if(!["compact","recovered","der"].includes(t))throw new Error(\'Signature format must be "compact", "recovered", or "der"\');return t}function En(t,e){let n={};for(let r of Object.keys(e))n[r]=t[r]===void 0?e[r]:t[r];return et(n.lowS,"lowS"),et(n.prehash,"prehash"),n.format!==void 0&&Sn(n.format),n}var vn=class extends Error{constructor(e=""){super(e)}},ke={Err:vn,_tlv:{encode:(t,e)=>{let{Err:n}=ke;if(t<0||t>256)throw new n("tlv.encode: wrong tag");if(e.length&1)throw new n("tlv.encode: unpadded data");let r=e.length/2,s=tt(r);if(s.length/2&128)throw new n("tlv.encode: long form length too big");let o=r>127?tt(s.length/2|128):"";return tt(t)+o+s+e},decode(t,e){let{Err:n}=ke,r=0;if(t<0||t>256)throw new n("tlv.encode: wrong tag");if(e.length<2||e[r++]!==t)throw new n("tlv.decode: wrong tlv");let s=e[r++],o=!!(s&128),i=0;if(!o)i=s;else{let c=s&127;if(!c)throw new n("tlv.decode(long): indefinite length not supported");if(c>4)throw new n("tlv.decode(long): byte length is too big");let l=e.subarray(r,r+c);if(l.length!==c)throw new n("tlv.decode: length bytes not complete");if(l[0]===0)throw new n("tlv.decode(long): zero leftmost byte");for(let d of l)i=i<<8|d;if(r+=c,i<128)throw new n("tlv.decode(long): not minimal encoding")}let a=e.subarray(r,r+i);if(a.length!==i)throw new n("tlv.decode: wrong value length");return{v:a,l:e.subarray(r+i)}}},_int:{encode(t){let{Err:e}=ke;if(t<ye)throw new e("integer: negative integers are not allowed");let n=tt(t);if(Number.parseInt(n[0],16)&8&&(n="00"+n),n.length&1)throw new e("unexpected DER parsing assertion: unpadded hex");return n},decode(t){let{Err:e}=ke;if(t[0]&128)throw new e("invalid signature integer: negative");if(t[0]===0&&!(t[1]&128))throw new e("invalid signature integer: unnecessary leading zero");return Se(t)}},toSig(t){let{Err:e,_int:n,_tlv:r}=ke,s=P(t,void 0,"signature"),{v:o,l:i}=r.decode(48,s);if(i.length)throw new e("invalid signature: left bytes after parsing");let{v:a,l:c}=r.decode(2,o),{v:l,l:d}=r.decode(2,c);if(d.length)throw new e("invalid signature: left bytes after parsing");return{r:n.decode(a),s:n.decode(l)}},hexFromSig(t){let{_tlv:e,_int:n}=ke,r=e.encode(2,n.encode(t.r)),s=e.encode(2,n.encode(t.s)),o=r+s;return e.encode(48,o)}},ye=BigInt(0),qe=BigInt(1),Kr=BigInt(2),Rt=BigInt(3),ui=BigInt(4);function Fr(t,e={}){let n=jr("weierstrass",t,e),{Fp:r,Fn:s}=n,o=n.CURVE,{h:i,n:a}=o;rt(e,{},{allowInfinityPoint:"boolean",clearCofactor:"function",isTorsionFree:"function",fromBytes:"function",toBytes:"function",endo:"object"});let{endo:c}=e;if(c&&(!r.is0(o.a)||typeof c.beta!="bigint"||!Array.isArray(c.basises)))throw new Error(\'invalid endo: expected "beta": bigint and "basises": array\');let l=Vr(r,s);function d(){if(!r.isOdd)throw new Error("compression is not supported: Field does not have .isOdd()")}function u(x,p,h){let{x:g,y:v}=p.toAffine(),_=r.toBytes(g);if(et(h,"isCompressed"),h){d();let k=!r.isOdd(v);return Z(Wr(k),_)}else return Z(Uint8Array.of(4),_,r.toBytes(v))}function m(x){P(x,void 0,"Point");let{publicKey:p,publicKeyUncompressed:h}=l,g=x.length,v=x[0],_=x.subarray(1);if(g===p&&(v===2||v===3)){let k=r.fromBytes(_);if(!r.isValid(k))throw new Error("bad point: is not on curve, wrong x");let w=S(k),R;try{R=r.sqrt(w)}catch(U){let M=U instanceof Error?": "+U.message:"";throw new Error("bad point: is not on curve, sqrt error"+M)}d();let T=r.isOdd(R);return(v&1)===1!==T&&(R=r.neg(R)),{x:k,y:R}}else if(g===h&&v===4){let k=r.BYTES,w=r.fromBytes(_.subarray(0,k)),R=r.fromBytes(_.subarray(k,k*2));if(!E(w,R))throw new Error("bad point: is not on curve");return{x:w,y:R}}else throw new Error(`bad point: got length ${g}, expected compressed=${p} or uncompressed=${h}`)}let f=e.toBytes||u,y=e.fromBytes||m;function S(x){let p=r.sqr(x),h=r.mul(p,x);return r.add(r.add(h,r.mul(x,o.a)),o.b)}function E(x,p){let h=r.sqr(p),g=S(x);return r.eql(h,g)}if(!E(o.Gx,o.Gy))throw new Error("bad curve params: generator point");let b=r.mul(r.pow(o.a,Rt),ui),C=r.mul(r.sqr(o.b),BigInt(27));if(r.is0(r.add(b,C)))throw new Error("bad curve params: a or b");function B(x,p,h=!1){if(!r.isValid(p)||h&&r.is0(p))throw new Error(`bad point coordinate ${x}`);return p}function L(x){if(!(x instanceof O))throw new Error("Weierstrass Point expected")}function W(x){if(!c||!c.basises)throw new Error("no endo");return di(x,c.basises,s.ORDER)}let z=fn((x,p)=>{let{X:h,Y:g,Z:v}=x;if(r.eql(v,r.ONE))return{x:h,y:g};let _=x.is0();p==null&&(p=_?r.ONE:r.inv(v));let k=r.mul(h,p),w=r.mul(g,p),R=r.mul(v,p);if(_)return{x:r.ZERO,y:r.ZERO};if(!r.eql(R,r.ONE))throw new Error("invZ was invalid");return{x:k,y:w}}),F=fn(x=>{if(x.is0()){if(e.allowInfinityPoint&&!r.is0(x.Y))return;throw new Error("bad point: ZERO")}let{x:p,y:h}=x.toAffine();if(!r.isValid(p)||!r.isValid(h))throw new Error("bad point: x or y not field elements");if(!E(p,h))throw new Error("bad point: equation left != right");if(!x.isTorsionFree())throw new Error("bad point: not in prime-order subgroup");return!0});function K(x,p,h,g,v){return h=new O(r.mul(h.X,x),h.Y,h.Z),p=st(g,p),h=st(v,h),p.add(h)}class O{static BASE=new O(o.Gx,o.Gy,r.ONE);static ZERO=new O(r.ZERO,r.ONE,r.ZERO);static Fp=r;static Fn=s;X;Y;Z;constructor(p,h,g){this.X=B("x",p),this.Y=B("y",h,!0),this.Z=B("z",g),Object.freeze(this)}static CURVE(){return o}static fromAffine(p){let{x:h,y:g}=p||{};if(!p||!r.isValid(h)||!r.isValid(g))throw new Error("invalid affine point");if(p instanceof O)throw new Error("projective point not allowed");return r.is0(h)&&r.is0(g)?O.ZERO:new O(h,g,r.ONE)}static fromBytes(p){let h=O.fromAffine(y(P(p,void 0,"point")));return h.assertValidity(),h}static fromHex(p){return O.fromBytes(re(p))}get x(){return this.toAffine().x}get y(){return this.toAffine().y}precompute(p=8,h=!0){return D.createCache(this,p),h||this.multiply(Rt),this}assertValidity(){F(this)}hasEvenY(){let{y:p}=this.toAffine();if(!r.isOdd)throw new Error("Field doesn\'t support isOdd");return!r.isOdd(p)}equals(p){L(p);let{X:h,Y:g,Z:v}=this,{X:_,Y:k,Z:w}=p,R=r.eql(r.mul(h,w),r.mul(_,v)),T=r.eql(r.mul(g,w),r.mul(k,v));return R&&T}negate(){return new O(this.X,r.neg(this.Y),this.Z)}double(){let{a:p,b:h}=o,g=r.mul(h,Rt),{X:v,Y:_,Z:k}=this,w=r.ZERO,R=r.ZERO,T=r.ZERO,A=r.mul(v,v),U=r.mul(_,_),M=r.mul(k,k),I=r.mul(v,_);return I=r.add(I,I),T=r.mul(v,k),T=r.add(T,T),w=r.mul(p,T),R=r.mul(g,M),R=r.add(w,R),w=r.sub(U,R),R=r.add(U,R),R=r.mul(w,R),w=r.mul(I,w),T=r.mul(g,T),M=r.mul(p,M),I=r.sub(A,M),I=r.mul(p,I),I=r.add(I,T),T=r.add(A,A),A=r.add(T,A),A=r.add(A,M),A=r.mul(A,I),R=r.add(R,A),M=r.mul(_,k),M=r.add(M,M),A=r.mul(M,I),w=r.sub(w,A),T=r.mul(M,U),T=r.add(T,T),T=r.add(T,T),new O(w,R,T)}add(p){L(p);let{X:h,Y:g,Z:v}=this,{X:_,Y:k,Z:w}=p,R=r.ZERO,T=r.ZERO,A=r.ZERO,U=o.a,M=r.mul(o.b,Rt),I=r.mul(h,_),N=r.mul(g,k),j=r.mul(v,w),V=r.add(h,g),q=r.add(_,k);V=r.mul(V,q),q=r.add(I,N),V=r.sub(V,q),q=r.add(h,v);let ee=r.add(_,w);return q=r.mul(q,ee),ee=r.add(I,j),q=r.sub(q,ee),ee=r.add(g,v),R=r.add(k,w),ee=r.mul(ee,R),R=r.add(N,j),ee=r.sub(ee,R),A=r.mul(U,q),R=r.mul(M,j),A=r.add(R,A),R=r.sub(N,A),A=r.add(N,A),T=r.mul(R,A),N=r.add(I,I),N=r.add(N,I),j=r.mul(U,j),q=r.mul(M,q),N=r.add(N,j),j=r.sub(I,j),j=r.mul(U,j),q=r.add(q,j),I=r.mul(N,q),T=r.add(T,I),I=r.mul(ee,q),R=r.mul(V,R),R=r.sub(R,I),I=r.mul(V,N),A=r.mul(ee,A),A=r.add(A,I),new O(R,T,A)}subtract(p){return this.add(p.negate())}is0(){return this.equals(O.ZERO)}multiply(p){let{endo:h}=e;if(!s.isValidNot0(p))throw new Error("invalid scalar: out of range");let g,v,_=k=>D.cached(this,k,w=>xn(O,w));if(h){let{k1neg:k,k1:w,k2neg:R,k2:T}=W(p),{p:A,f:U}=_(w),{p:M,f:I}=_(T);v=U.add(I),g=K(h.beta,A,M,k,R)}else{let{p:k,f:w}=_(p);g=k,v=w}return xn(O,[g,v])[0]}multiplyUnsafe(p){let{endo:h}=e,g=this;if(!s.isValid(p))throw new Error("invalid scalar: out of range");if(p===ye||g.is0())return O.ZERO;if(p===qe)return g;if(D.hasCache(this))return this.multiply(p);if(h){let{k1neg:v,k1:_,k2neg:k,k2:w}=W(p),{p1:R,p2:T}=Gr(O,g,_,w);return K(h.beta,R,T,v,k)}else return D.unsafe(g,p)}toAffine(p){return z(this,p)}isTorsionFree(){let{isTorsionFree:p}=e;return i===qe?!0:p?p(O,this):D.unsafe(this,a).is0()}clearCofactor(){let{clearCofactor:p}=e;return i===qe?this:p?p(O,this):this.multiplyUnsafe(i)}isSmallOrder(){return this.multiplyUnsafe(i).is0()}toBytes(p=!0){return et(p,"isCompressed"),this.assertValidity(),f(O,this,p)}toHex(p=!0){return ae(this.toBytes(p))}toString(){return`<Point ${this.is0()?"ZERO":this.toHex()}>`}}let H=s.BITS,D=new vt(O,e.endo?Math.ceil(H/2):H);return O.BASE.precompute(8),O}function Wr(t){return Uint8Array.of(t?2:3)}function Vr(t,e){return{secretKey:e.BYTES,publicKey:1+t.BYTES,publicKeyUncompressed:1+2*t.BYTES,publicKeyHasPrefix:!0,signature:2*e.BYTES}}function fi(t,e={}){let{Fn:n}=t,r=e.randomBytes||he,s=Object.assign(Vr(t.Fp,n),{seed:mn(n.ORDER)});function o(f){try{let y=n.fromBytes(f);return n.isValidNot0(y)}catch{return!1}}function i(f,y){let{publicKey:S,publicKeyUncompressed:E}=s;try{let b=f.length;return y===!0&&b!==S||y===!1&&b!==E?!1:!!t.fromBytes(f)}catch{return!1}}function a(f=r(s.seed)){return St(P(f,s.seed,"seed"),n.ORDER)}function c(f,y=!0){return t.BASE.multiply(n.fromBytes(f)).toBytes(y)}function l(f){let{secretKey:y,publicKey:S,publicKeyUncompressed:E}=s;if(!Qe(f)||"_lengths"in n&&n._lengths||y===S)return;let b=P(f,void 0,"key").length;return b===S||b===E}function d(f,y,S=!0){if(l(f)===!0)throw new Error("first arg must be private key");if(l(y)===!1)throw new Error("second arg must be public key");let E=n.fromBytes(f);return t.fromBytes(y).multiply(E).toBytes(S)}let u={isValidSecretKey:o,isValidPublicKey:i,randomSecretKey:a},m=kt(a,c);return Object.freeze({getPublicKey:c,getSharedSecret:d,keygen:m,Point:t,utils:u,lengths:s})}function Zr(t,e,n={}){Ie(e),rt(n,{},{hmac:"function",lowS:"boolean",randomBytes:"function",bits2int:"function",bits2int_modN:"function"}),n=Object.assign({},n);let r=n.randomBytes||he,s=n.hmac||((h,g)=>ve(e,h,g)),{Fp:o,Fn:i}=t,{ORDER:a,BITS:c}=i,{keygen:l,getPublicKey:d,getSharedSecret:u,utils:m,lengths:f}=fi(t,n),y={prehash:!0,lowS:typeof n.lowS=="boolean"?n.lowS:!0,format:"compact",extraEntropy:!1},S=a*Kr<o.ORDER;function E(h){let g=a>>qe;return h>g}function b(h,g){if(!i.isValidNot0(g))throw new Error(`invalid signature ${h}: out of range 1..Point.Fn.ORDER`);return g}function C(){if(S)throw new Error(\'"recovered" sig type is not supported for cofactor >2 curves\')}function B(h,g){Sn(g);let v=f.signature,_=g==="compact"?v:g==="recovered"?v+1:void 0;return P(h,_)}class L{r;s;recovery;constructor(g,v,_){if(this.r=b("r",g),this.s=b("s",v),_!=null){if(C(),![0,1,2,3].includes(_))throw new Error("invalid recovery id");this.recovery=_}Object.freeze(this)}static fromBytes(g,v=y.format){B(g,v);let _;if(v==="der"){let{r:T,s:A}=ke.toSig(P(g));return new L(T,A)}v==="recovered"&&(_=g[0],v="compact",g=g.subarray(1));let k=f.signature/2,w=g.subarray(0,k),R=g.subarray(k,k*2);return new L(i.fromBytes(w),i.fromBytes(R),_)}static fromHex(g,v){return this.fromBytes(re(g),v)}assertRecovery(){let{recovery:g}=this;if(g==null)throw new Error("invalid recovery id: must be present");return g}addRecoveryBit(g){return new L(this.r,this.s,g)}recoverPublicKey(g){let{r:v,s:_}=this,k=this.assertRecovery(),w=k===2||k===3?v+a:v;if(!o.isValid(w))throw new Error("invalid recovery id: sig.r+curve.n != R.x");let R=o.toBytes(w),T=t.fromBytes(Z(Wr((k&1)===0),R)),A=i.inv(w),U=z(P(g,void 0,"msgHash")),M=i.create(-U*A),I=i.create(_*A),N=t.BASE.multiplyUnsafe(M).add(T.multiplyUnsafe(I));if(N.is0())throw new Error("invalid recovery: point at infinify");return N.assertValidity(),N}hasHighS(){return E(this.s)}toBytes(g=y.format){if(Sn(g),g==="der")return re(ke.hexFromSig(this));let{r:v,s:_}=this,k=i.toBytes(v),w=i.toBytes(_);return g==="recovered"?(C(),Z(Uint8Array.of(this.assertRecovery()),k,w)):Z(k,w)}toHex(g){return ae(this.toBytes(g))}}let W=n.bits2int||function(g){if(g.length>8192)throw new Error("input is too large");let v=Se(g),_=g.length*8-c;return _>0?v>>BigInt(_):v},z=n.bits2int_modN||function(g){return i.create(W(g))},F=nt(c);function K(h){return _r("num < 2^"+c,h,ye,F),i.toBytes(h)}function O(h,g){return P(h,void 0,"message"),g?P(e(h),void 0,"prehashed message"):h}function H(h,g,v){let{lowS:_,prehash:k,extraEntropy:w}=En(v,y);h=O(h,k);let R=z(h),T=i.fromBytes(g);if(!i.isValidNot0(T))throw new Error("invalid private key");let A=[K(T),K(R)];if(w!=null&&w!==!1){let N=w===!0?r(f.secretKey):w;A.push(P(N,void 0,"extraEntropy"))}let U=Z(...A),M=R;function I(N){let j=W(N);if(!i.isValidNot0(j))return;let V=i.inv(j),q=t.BASE.multiply(j).toAffine(),ee=i.create(q.x);if(ee===ye)return;let gt=i.create(V*i.create(M+ee*T));if(gt===ye)return;let ur=(q.x===ee?0:2)|Number(q.y&qe),fr=gt;return _&&E(gt)&&(fr=i.neg(gt),ur^=1),new L(ee,fr,S?void 0:ur)}return{seed:U,k2sig:I}}function D(h,g,v={}){let{seed:_,k2sig:k}=H(h,g,v);return Rr(e.outputLen,i.BYTES,s)(_,k).toBytes(v.format)}function x(h,g,v,_={}){let{lowS:k,prehash:w,format:R}=En(_,y);if(v=P(v,void 0,"publicKey"),g=O(g,w),!Qe(h)){let T=h instanceof L?", use sig.toBytes()":"";throw new Error("verify expects Uint8Array signature"+T)}B(h,R);try{let T=L.fromBytes(h,R),A=t.fromBytes(v);if(k&&T.hasHighS())return!1;let{r:U,s:M}=T,I=z(g),N=i.inv(M),j=i.create(I*N),V=i.create(U*N),q=t.BASE.multiplyUnsafe(j).add(A.multiplyUnsafe(V));return q.is0()?!1:i.create(q.x)===U}catch{return!1}}function p(h,g,v={}){let{prehash:_}=En(v,y);return g=O(g,_),L.fromBytes(h,"recovered").recoverPublicKey(g).toBytes()}return Object.freeze({keygen:l,getPublicKey:d,getSharedSecret:u,utils:m,lengths:f,Point:t,sign:D,verify:x,recoverPublicKey:p,Signature:L,hash:e})}var It={p:BigInt("0xfffffffffffffffffffffffffffffffffffffffffffffffffffffffefffffc2f"),n:BigInt("0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141"),h:BigInt(1),a:BigInt(0),b:BigInt(7),Gx:BigInt("0x79be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798"),Gy:BigInt("0x483ada7726a3c4655da4fbfc0e1108a8fd17b448a68554199c47d08ffb10d4b8")},pi={beta:BigInt("0x7ae96a2b657c07106e64479eac3434e99cf0497512f58995c1396c28719501ee"),basises:[[BigInt("0x3086d221a7d46bcde86c90e49284eb15"),-BigInt("0xe4437ed6010e88286f547fa90abfe4c3")],[BigInt("0x114ca50f7a8e2f3f657c1108d9d44cfd8"),BigInt("0x3086d221a7d46bcde86c90e49284eb15")]]},gi=BigInt(0),kn=BigInt(2);function hi(t){let e=It.p,n=BigInt(3),r=BigInt(6),s=BigInt(11),o=BigInt(22),i=BigInt(23),a=BigInt(44),c=BigInt(88),l=t*t*t%e,d=l*l*t%e,u=oe(d,n,e)*d%e,m=oe(u,n,e)*d%e,f=oe(m,kn,e)*l%e,y=oe(f,s,e)*f%e,S=oe(y,o,e)*y%e,E=oe(S,a,e)*S%e,b=oe(E,c,e)*E%e,C=oe(b,a,e)*S%e,B=oe(C,n,e)*d%e,L=oe(B,i,e)*y%e,W=oe(L,r,e)*l%e,z=oe(W,kn,e);if(!Tt.eql(Tt.sqr(z),t))throw new Error("Cannot find square root");return z}var Tt=Ue(It.p,{sqrt:hi}),Ce=Fr(It,{Fp:Tt,endo:pi}),Jr=Zr(Ce,ce),Yr={};function At(t,...e){let n=Yr[t];if(n===void 0){let r=ce(kr(t));n=Z(r,r),Yr[t]=n}return ce(Z(n,...e))}var Rn=t=>t.toBytes(!0).slice(1),Tn=t=>t%kn===gi;function _n(t){let{Fn:e,BASE:n}=Ce,r=e.fromBytes(t),s=n.multiply(r);return{scalar:Tn(s.y)?r:e.neg(r),bytes:Rn(s)}}function Qr(t){let e=Tt;if(!e.isValidNot0(t))throw new Error("invalid x: Fail if x \\u2265 p");let n=e.create(t*t),r=e.create(n*t+BigInt(7)),s=e.sqrt(r);Tn(s)||(s=e.neg(s));let o=Ce.fromAffine({x:t,y:s});return o.assertValidity(),o}var ot=Se;function es(...t){return Ce.Fn.create(ot(At("BIP0340/challenge",...t)))}function Xr(t){return _n(t).bytes}function mi(t,e,n=he(32)){let{Fn:r}=Ce,s=P(t,void 0,"message"),{bytes:o,scalar:i}=_n(e),a=P(n,32,"auxRand"),c=r.toBytes(i^ot(At("BIP0340/aux",a))),l=At("BIP0340/nonce",c,o,s),{bytes:d,scalar:u}=_n(l),m=es(d,o,s),f=new Uint8Array(64);if(f.set(d,0),f.set(r.toBytes(r.create(u+m*i)),32),!ts(f,s,o))throw new Error("sign: Invalid signature produced");return f}function ts(t,e,n){let{Fp:r,Fn:s,BASE:o}=Ce,i=P(t,64,"signature"),a=P(e,void 0,"message"),c=P(n,32,"publicKey");try{let l=Qr(ot(c)),d=ot(i.subarray(0,32));if(!r.isValidNot0(d))return!1;let u=ot(i.subarray(32,64));if(!s.isValidNot0(u))return!1;let m=es(s.toBytes(d),Rn(l),a),f=o.multiplyUnsafe(u).add(l.multiplyUnsafe(s.neg(m))),{x:y,y:S}=f.toAffine();return!(f.is0()||!Tn(S)||y!==d)}catch{return!1}}var _e=(()=>{let n=(r=he(48))=>St(r,It.n);return{keygen:kt(n,Xr),getPublicKey:Xr,sign:mi,verify:ts,Point:Ce,utils:{randomSecretKey:n,taggedHash:At,lift_x:Qr,pointToBytes:Rn},lengths:{secretKey:32,publicKey:32,publicKeyHasPrefix:!1,signature:64,seed:48}}})();var hl=new TextDecoder("utf-8"),yi=new TextEncoder;function bi(t){if(t.length!==64)return!1;for(let e=0;e<64;e++){let n=t.charCodeAt(e);if(isNaN(n)||n<48||n>102||n>57&&n<97)return!1}return!0}var Ge=Symbol("verified"),wi=t=>t instanceof Object;function xi(t){if(!wi(t)||typeof t.kind!="number"||typeof t.content!="string"||typeof t.created_at!="number"||typeof t.pubkey!="string"||!bi(t.pubkey)||!Array.isArray(t.tags))return!1;for(let e=0;e<t.tags.length;e++){let n=t.tags[e];if(!Array.isArray(n))return!1;for(let r=0;r<n.length;r++)if(typeof n[r]!="string")return!1}return!0}var Ei=class{generateSecretKey(){return _e.utils.randomSecretKey()}getPublicKey(t){return ae(_e.getPublicKey(t))}finalizeEvent(t,e){let n=t;return n.pubkey=ae(_e.getPublicKey(e)),n.id=An(n),n.sig=ae(_e.sign(re(An(n)),e)),n[Ge]=!0,n}verifyEvent(t){if(typeof t[Ge]=="boolean")return t[Ge];try{let e=An(t);if(e!==t.id)return t[Ge]=!1,!1;let n=_e.verify(re(t.sig),re(e),re(t.pubkey));return t[Ge]=n,n}catch{return t[Ge]=!1,!1}}};function Si(t){if(!xi(t))throw new Error("can\'t serialize event with wrong or missing properties");return JSON.stringify([0,t.pubkey,t.created_at,t.kind,t.tags,t.content])}function An(t){let e=ce(yi.encode(Si(t)));return ae(e)}var $t=new Ei,ns=$t.generateSecretKey,it=$t.getPublicKey,rs=$t.finalizeEvent,ss=$t.verifyEvent;var at=class{constructor(e){this.onEvent=e}buffer="";data=[];event="";id;push(e){this.buffer+=e;let n=this.buffer.search(/\\r\\n|\\r|\\n/);for(;n!==-1;){let r=this.buffer.slice(0,n),s=this.buffer.startsWith(`\\r\n`,n)?2:1;this.buffer=this.buffer.slice(n+s),this.line(r),n=this.buffer.search(/\\r\\n|\\r|\\n/)}}end(){this.buffer&&this.line(this.buffer),this.buffer="",this.line("")}line(e){if(e===""){this.data.length&&this.onEvent({event:this.event||"message",data:this.data.join(`\n`),...this.id!==void 0&&{id:this.id}}),this.data=[],this.event="";return}if(e.startsWith(":"))return;let n=e.indexOf(":"),r=n===-1?e:e.slice(0,n),s=n===-1?"":e.slice(n+1);s.startsWith(" ")&&(s=s.slice(1)),r==="data"?this.data.push(s):r==="event"?this.event=s:r==="id"&&(this.id=s)}};function os(t){let e=[],n=new at(r=>e.push(r));return n.push(t),n.end(),e}var vi="databricks-buzz-plugins/0.1.0",In=class extends Error{constructor(n,r,s,o){super(s);this.status=n;this.errorCode=r;this.body=o;this.name="DatabricksApiError"}get isPermission(){return this.status===403||this.errorCode==="PERMISSION_DENIED"}get isNotFound(){return this.status===404||this.errorCode==="RESOURCE_DOES_NOT_EXIST"||this.errorCode==="NOT_FOUND"}get isFeatureDisabled(){return this.errorCode==="FEATURE_DISABLED"||this.errorCode==="NOT_IMPLEMENTED"||/not enabled|feature.*disabled|preview/i.test(this.message)}};function je(t){let e,n=`Databricks returned HTTP ${t.status}`;try{let r=JSON.parse(t.body);if(e=r.error_code??(typeof r.error=="object"?r.error?.code:void 0),n=r.message??(typeof r.error=="object"?r.error?.message:r.error)??r.error_description??n,/^\\s*\\{/.test(n))try{let s=JSON.parse(n),o=s.message??s.error?.message;typeof o=="string"&&o&&(n=o)}catch{}}catch{let r=t.body.trim();r&&r.length<400&&!r.startsWith("<")&&(n=r)}return new In(t.status,e,n,t.body)}var ki=new Set(["GET","HEAD","PUT","DELETE"]),_i=(t,e)=>new Promise((n,r)=>{let s=setTimeout(n,t);e?.addEventListener("abort",()=>{clearTimeout(s),r(e.reason)},{once:!0})}),ct=class{constructor(e){this.options=e;this.host=e.host.replace(/\\/+$/,""),this.workspaceId=e.workspaceId}host;workspaceId;url(e,n){let r=new URL(/^https:\\/\\//.test(e)?e:`${this.host}${e.startsWith("/")?"":"/"}${e}`);for(let[s,o]of Object.entries(n??{}))o!==void 0&&r.searchParams.set(s,String(o));return r.toString()}async request(e,n={},r){let s=n.method??(n.body===void 0?"GET":"POST"),o=n.body===void 0?void 0:typeof n.body=="string"?n.body:JSON.stringify(n.body),i=async c=>{let l=await this.options.token({force:c});return this.options.transport({url:this.url(e,n.query),method:s,headers:{Authorization:`Bearer ${l}`,"User-Agent":this.options.userAgent??vi,Accept:"application/json",...o!==void 0&&{"Content-Type":"application/json"},...this.workspaceId&&{"X-Databricks-Workspace-Id":this.workspaceId},...n.headers},...o!==void 0&&{body:o},...n.timeoutMs!==void 0&&{timeoutMs:n.timeoutMs},...n.signal&&{signal:n.signal},...r&&{onBody:r}})},a=await i(!1);a.status===401&&(a=await i(!0));for(let c=0;c<3&&(a.status===429||a.status===503)&&ki.has(s)&&!r;c++){let l=Number(a.headers["retry-after"]);await _i(Number.isFinite(l)&&l>0?Math.min(l*1e3,2e4):500*2**c+Math.random()*250,n.signal),a=await i(!1)}return a}async json(e,n={}){let r=await this.request(e,n);if(r.status<200||r.status>=300)throw je(r);return r.body.trim()?JSON.parse(r.body):{}}get(e,n={}){return this.json(e,{...n,method:"GET"})}post(e,n,r={}){return this.json(e,{...r,method:"POST",body:n??{}})}async stream(e,n,r){let s=new at(r),o=!0,i=await this.request(e,{...n,headers:{Accept:"text/event-stream",...n.headers}},a=>{o&&s.push(a)});if(i.status<200||i.status>=300)throw o=!1,je(i);return s.end(),i}};var is="2025-06-18",Ot=class extends Error{constructor(n,r,s){super(n);this.code=r;this.data=s;this.name="McpError"}},$n=t=>`/ai-gateway/mcp-services/${t}`,ze=class{constructor(e,n,r={}){this.client=e;this.path=n;this.query=r}session;initializing;nextId=1;toolsCache;serverInfo;instructions;async listTools(e){if(this.toolsCache&&Date.now()-this.toolsCache.at<5*6e4)return this.toolsCache.tools;let n=[],r;do{let s=await this.call("tools/list",r?{cursor:r}:{},e);n.push(...s.tools??[]),r=s.nextCursor}while(r);return this.toolsCache={at:Date.now(),tools:n},n}callTool(e,n,r={}){return this.call("tools/call",{name:e,arguments:n,...r.meta&&{_meta:r.meta}},r.signal,r.timeoutMs)}async readResource(e,n){return await this.call("resources/read",{uri:e},n)}async ensureSession(e){this.session||(this.initializing??=(async()=>{let n=await this.send({jsonrpc:"2.0",id:this.nextId++,method:"initialize",params:{protocolVersion:is,capabilities:{},clientInfo:{name:"databricks-buzz-plugins",version:"0.1.0"}}},e,!0);this.serverInfo=n?.serverInfo,this.instructions=n?.instructions,await this.send({jsonrpc:"2.0",method:"notifications/initialized"},e).catch(()=>{})})().finally(()=>{this.initializing=void 0}),await this.initializing)}async call(e,n,r,s){await this.ensureSession(r);try{return await this.send({jsonrpc:"2.0",id:this.nextId++,method:e,params:n},r,!1,s)}catch(o){if(o.status===404&&this.session)return this.session=void 0,await this.ensureSession(r),this.send({jsonrpc:"2.0",id:this.nextId++,method:e,params:n},r,!1,s);throw o}}async send(e,n,r=!1,s=12e4){let o=await this.client.request(this.path,{method:"POST",query:this.query,body:e,timeoutMs:s,...n&&{signal:n},headers:{Accept:"application/json, text/event-stream",...!r&&{"MCP-Protocol-Version":is},...this.session&&{"Mcp-Session-Id":this.session}}}),i=o.headers["mcp-session-id"];if(i&&(this.session=i),e.id===void 0||o.status===202)return;if(o.status<200||o.status>=300)throw je(o);let c=(o.headers["content-type"]??"").includes("text/event-stream")?os(o.body).map(l=>l.data):[o.body];for(let l of c){let d;try{d=JSON.parse(l)}catch{continue}if(d.id===e.id){if(d.error)throw new Ot(d.error.message??"MCP error",d.error.code,d.error.data);return d.result}}throw new Ot(`No response to ${e.method}`)}};function Re(t){return(t.content??[]).map(e=>e.type==="text"?String(e.text):"").filter(Boolean).join(`\n\n`)}function Ke(t){if(t.structuredContent!==void 0)return t.structuredContent;for(let e of t.content??[]){if(e.type!=="text")continue;let n=String(e.text).trim();if(!(!n.startsWith("{")&&!n.startsWith("[")))try{return JSON.parse(n)}catch{}}}var Il=3*6e4,$l=30*6e4;var Ti="bkvarda.databricks",Yl=`${Ti}/connection`;function Ct(t){return t instanceof Error&&t.name==="DatabricksApiError"}function as(t){return Ct(t)?t.isPermission?`You don\'t have access: ${t.message}`:t.isFeatureDisabled?`This isn\'t enabled in your workspace: ${t.message}`:t.message:t instanceof Error?t.message:String(t)}var Ai="system.ai.genie_one_mcp",Ii=3e3,$i=3,Oi=t=>t==null?null:typeof t=="object"?JSON.stringify(t):String(t);function Ci(t){if(!t.ready||!t.columns?.length)return;let e=(t.rows??[]).map(r=>r.map(Oi)),n=t.total_row_count??void 0;return ht(t.columns.map(r=>({name:r.name,...r.type_text&&{type:r.type_text}})),e,{...n!==void 0&&{totalRows:n},truncated:!!t.truncated||n!==void 0&&n>e.length})}var Li=t=>t.replace(/<!--[\\s\\S]*?--\\s*>/g,"").replace(/\\n{3,}/g,`\n\n`).trim();function ds(t){return Li(t).replace(/\\s*:citation\\[[^\\]]*\\]/g,"").replace(/\\s*\\[Query Result\\]\\([^)\\s]*#embed-[^)\\s]*\\)/g,"").replace(/\\s*\\[Knowledge snippets?\\]\\([^)]*\\)/gi,"").replace(/([.!?)])[ \\t]+Knowledge snippets?(?=[ \\t]*(\\n|$))/gi,"$1").replace(/`([^`]+)`\\s*\\[\\1\\]\\(/g,"[$1](").replace(/[ \\t]+$/gm,"").trim()}function Bi(t){let e=String.raw`(?:charts?|graphs?|plots?|visuali[sz]ations?)`,n=r=>/^[ \\t]*/.exec(r)?.[0]??"";return t.replace(new RegExp(String.raw`[^.!?\\n]*\\b(?:can(?:\'|\u2019)?t|cannot|can not|unable to|not able to)\\b[^.!?\\n]*\\b${e}\\b[^.!?\\n]*[.!?][ \\t]*`,"gi"),n).replace(new RegExp(String.raw`[^.!?\\n]*\\b(?:to (?:turn|make|build|create) (?:this|it|these|the results?) into an? ${e}|you can (?:chart|plot|graph) (?:this|it|them|directly))\\b[^.!?\\n]*[.!?][ \\t]*`,"gi"),n).replace(/[ \\t]+$/gm,"").replace(/\\n{3,}/g,`\n\n`).trim()}var cs=t=>t.trim().replace(/^\\|/,"").replace(/\\|$/,"").split("|").map(e=>e.replace(/\\*\\*|__|`/g,"").trim()),ls=t=>t.toLowerCase().replace(/[^a-z0-9]/g,"");function us(t,e=200){let n=ds(t.text).split(`\n`),r=[...t.results],s=(l,d)=>{let u=l.map(ls).join("|"),m=r.findIndex(f=>f.columns.map(y=>ls(y.name)).join("|")===u);return m<0&&(m=r.findIndex(f=>f.columns.length===l.length&&f.rows.length===d)),m<0?void 0:r.splice(m,1)[0]},o=[],i=0,a=/^\\s*\\|.*\\|\\s*$/;for(let l=0;l<n.length;l++){if(a.test(n[l]??"")&&/^\\s*\\|?\\s*:?-{2,}/.test(n[l+1]??"")){let d=cs(n[l]??""),u=[];for(l+=2;l<n.length&&a.test(n[l]??"");l++)u.push(cs(n[l]??"").map(f=>f||null));l--;let m=s(d,u.length)??ht(d.map(f=>({name:f})),u);o.push("",Xe(m,e),""),i++;continue}o.push(n[l]??"")}let c=o.join(`\n`).replace(/\\n{3,}/g,`\n\n`).trim();if(!i){let l=t.results[t.results.length-1];l?.columns.length&&(l.rows.length>1||!c)&&(c=[c,Xe(l,e)].filter(Boolean).join(`\n\n`),i++)}return i?Bi(c):c}var fs=(t,e)=>new Promise((n,r)=>{if(e?.aborted){r(e.reason);return}let s=setTimeout(n,t);e?.addEventListener("abort",()=>{clearTimeout(s),r(e.reason)},{once:!0})}),Ni=[2e3,4e3,8e3,15e3],Cn=/REQUEST_LIMIT_EXCEEDED|TOO_MANY_REQUESTS|rate[- ]?limit/i;function Ln(t){return Ct(t)&&(t.status===429||t.errorCode==="REQUEST_LIMIT_EXCEEDED"||t.errorCode==="TOO_MANY_REQUESTS")?!0:t instanceof Error&&Cn.test(t.message)}var Le=class extends Error{constructor(n,r){super(n);this.conversationId=r;this.name="RateLimited"}},Pi=t=>Math.round(t*(.8+Math.random()*.4));async function On(t,e){for(let n=0;;n++)try{return await t()}catch(r){let s=Ni[n];if(s===void 0||e.signal?.aborted||!(e.retryable??Ln)(r))throw r;let o=Pi(s);e.onRetry?.({attempt:n+1,waitMs:o,reason:r instanceof Error?r.message:String(r)}),await fs(o,e.signal)}}var ps=2e4,Lt=class extends Error{};function Di(t){return t instanceof Lt?`Genie One didn\'t answer within ${ps/1e3} seconds.`:Ln(t)?"Databricks is rate-limiting Genie One for your organization right now. Try again in a minute.":Ct(t)&&t.isNotFound?`Genie One isn\'t set up in this workspace. ${t.message}`:as(t)}var Fe=class{constructor(e){this.service=e}clients=new Map;checks=new Map;revision=0;listeners=new Set;checkRevision=()=>this.revision;subscribeChecks=e=>(this.listeners.add(e),()=>this.listeners.delete(e));async mcp(){let e=await this.service.ready(),n=this.service.snapshot(),r=n.status==="connected"?n.workspaceId??n.profile.workspaceId:void 0,s=`${e.host}|${r??""}`,o=this.clients.get(s);return o||(o=new ze(e,$n(Ai),r?{o:r}:{}),this.clients.set(s,o)),o}checkKey(){let e=this.service.snapshot();return e.status==="connected"?e.profile.host:"none"}check(){let e=this.checkKey(),n=this.checks.get(e);return n||(n=this.listWithin(ps).then(r=>r.some(s=>s.name==="genie_ask")?{ok:!0}:{ok:!1,reason:"Genie One answered, but without its question tool (genie_ask)."}).catch(r=>({ok:!1,reason:Di(r),...Ln(r)&&{busy:!0}})).then(r=>(!r.ok&&this.checks.get(e)===n&&this.checks.delete(e),r)),this.checks.set(e,n)),n}async available(){return(await this.check()).ok}recheck(){let e=this.checkKey();this.checks.delete(e);for(let n of[...this.clients.keys()])n.startsWith(`${e}|`)&&this.clients.delete(n);this.revision++;for(let n of[...this.listeners])n()}async listWithin(e){let n=new AbortController,r,s,o=new Promise((a,c)=>{s=setTimeout(()=>{n.abort(),c(r??new Lt)},e)}),i=this.mcp().then(a=>On(()=>a.listTools(n.signal),{signal:n.signal,onRetry:c=>{r=new Le(c.reason)}}));try{return await Promise.race([i,o])}finally{clearTimeout(s),i.catch(()=>{})}}callTool(e,n,r,s){let{signal:o,timeoutMs:i,onRetry:a}=s;return On(async()=>{let c=await e.callTool(n,r,{...o&&{signal:o},timeoutMs:i}),l=c.isError?Re(c):"";if(l&&Cn.test(l))throw new Le(l);return c},{...o&&{signal:o},...a&&{onRetry:c=>a({...c,restarted:!1})}})}async ask(e,n={}){let r=n.conversationId;return On(async()=>{try{return await this.askOnce(e,{...n,...r&&{conversationId:r}})}catch(s){throw s instanceof Le&&s.conversationId&&(r=s.conversationId),s}},{...n.signal&&{signal:n.signal},retryable:s=>s instanceof Le&&s.conversationId!==void 0,...n.onRetry&&{onRetry:s=>n.onRetry?.({...s,restarted:!0})}})}async askOnce(e,n){let{signal:r,onRetry:s}=n,o=await this.mcp(),i=await this.callTool(o,"genie_ask",{question:e,...n.conversationId&&{conversation_id:n.conversationId}},{...r&&{signal:r},timeoutMs:17e4,...s&&{onRetry:s}});if(i.isError)throw new Error(Re(i)||"Genie One couldn\'t take the question.");let a=Ke(i)??{},c=a.conversation_id??n.conversationId??"",l=a.response_id??"";if(!c||!l)throw new Error("Genie One didn\'t return a conversation.");return n.onStarted?.({conversationId:c,responseId:l}),this.follow(o,c,l,a,Re(i),n)}async response(e,n,r={}){return this.follow(await this.mcp(),e,n,{},"",r)}async follow(e,n,r,s,o,i){let{signal:a,onRetry:c}=i,l={...a&&{signal:a},...c&&{onRetry:c}},d=s,u=o,m=0,f=[],y=Date.now()+10*6e4;try{for(;!d.status||d.status==="in_progress"||d.status==="unknown"&&m<5;){if(Date.now()>y)throw new Error("Genie One didn\'t finish within 10 minutes.");d.status&&await fs(Ii,a);let b=await this.callTool(e,"genie_poll_response",{conversation_id:n,response_id:r},{...l,timeoutMs:6e4});if(b.isError)throw new Error(Re(b)||"Genie One failed.");d=Ke(b)??{status:"unknown"},u=Re(b),m=d.status==="unknown"?m+1:0,d.progress_steps?.length&&(f=d.progress_steps,i.onProgress?.(f))}}catch(b){throw a?.aborted&&e.callTool("genie_cancel_response",{conversation_id:n}).catch(()=>{}),b}if(d.status==="failed"){let b=u.trim()||"Genie One couldn\'t answer that.";throw Cn.test(b)?new Le(b,n):new Error(b)}let S=(d.query_items??[]).slice(0,$i),E=(await Promise.all(S.map(b=>this.callTool(e,"genie_get_query_result",{conversation_id:n,response_id:r,item_id:b.item_id},{...a&&{signal:a},timeoutMs:6e4}).then(C=>C.isError?void 0:Ci(Ke(C)??{})).catch(()=>{})))).filter(b=>b!==void 0);return{conversationId:n,responseId:r,status:d.status??"completed",text:(d.final_answer??"").trim(),markdown:u.trim(),steps:f,results:E,sql:S.flatMap(b=>b.sql?[b.sql]:[]),...d.deep_link&&{deepLink:d.deep_link}}}format(e){let n=["Genie One",`conversation_id: ${e.conversationId}`];e.status==="incomplete"&&n.push("(Genie One stopped before finishing; the answer may be partial.)");let r=ds(e.text);if(r)n.push("",r);else for(let s of e.results)n.push("",mt(s,20));for(let s of e.sql.slice(0,2))n.push("","SQL Genie One ran:","```sql",s.trim(),"```");return e.deepLink&&n.push("",`[Explore in Databricks](${e.deepLink})`),n.join(`\n`)}};var We="/home/sandbox-agent";var Mi=`${We}/.buzz/agent/runner.mjs`,Te="dbx",Bn=54,Nn=(t,e)=>["node",t,"mcp",e],Ui=`// Databricks tools for Pi, written by the Databricks Agents plugin for Buzz.\nimport { spawn } from "node:child_process";\nimport { createInterface } from "node:readline";\n\nexport default async function (pi) {\n  let command = [];\n  try {\n    command = JSON.parse(process.env.BUZZ_TOOLS_BRIDGE || "[]");\n  } catch {}\n  if (!command.length) return;\n  const child = spawn(command[0], command.slice(1), { stdio: ["pipe", "pipe", "inherit"] });\n  const pending = new Map();\n  let next = 1;\n  // The bridge keeps Pi running only while a request waits on it, so Pi can exit when it\'s done.\n  const hold = (on) => {\n    for (const handle of [child, child.stdin, child.stdout]) on ? handle.ref?.() : handle.unref?.();\n  };\n  const settle = () => pending.size || hold(false);\n  const fail = (error) => {\n    for (const waiting of pending.values()) waiting.reject(error);\n    pending.clear();\n    settle();\n  };\n  child.on("error", fail);\n  child.on("exit", () => fail(new Error("The Databricks tools stopped.")));\n  createInterface({ input: child.stdout }).on("line", (line) => {\n    let message;\n    try {\n      message = JSON.parse(line);\n    } catch {\n      return;\n    }\n    const waiting = pending.get(message.id);\n    if (!waiting) return;\n    pending.delete(message.id);\n    settle();\n    if (message.error) waiting.reject(new Error(message.error.message || "The tool failed."));\n    else waiting.resolve(message.result);\n  });\n  const send = (message) => child.stdin.write(JSON.stringify(message) + "\\\\n");\n  const request = (method, params, signal) =>\n    new Promise((resolve, reject) => {\n      const id = next++;\n      pending.set(id, { resolve, reject });\n      hold(true);\n      send({ jsonrpc: "2.0", id, method, params });\n      signal?.addEventListener(\n        "abort",\n        () => {\n          if (!pending.delete(id)) return;\n          settle();\n          send({ jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: id } });\n          reject(new Error("Stopped."));\n        },\n        { once: true },\n      );\n    });\n  const stop = () => child.kill();\n  pi.on("session_shutdown", stop);\n  process.on("exit", stop);\n  try {\n    await request("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "pi", version: "1" } });\n    send({ jsonrpc: "2.0", method: "notifications/initialized" });\n    const { tools = [] } = await request("tools/list", {});\n    for (const tool of tools)\n      pi.registerTool({\n        name: tool.name,\n        label: tool.title || tool.name,\n        description: tool.description || tool.name,\n        parameters: tool.inputSchema || { type: "object", properties: {} },\n        async execute(_id, params, signal) {\n          const result = await request("tools/call", { name: tool.name, arguments: params ?? {} }, signal);\n          const text = (result?.content ?? []).filter((part) => part.type === "text").map((part) => part.text).join("\\\\n") || JSON.stringify(result?.structuredContent ?? {});\n          if (result?.isError) throw new Error(text);\n          return { content: [{ type: "text", text }], details: {} };\n        },\n      });\n  } catch (error) {\n    console.error("Databricks tools unavailable: " + (error?.message ?? error));\n  }\n}\n`;function Pn(t,e,n,r){let s=[{path:e.tools,content:`${JSON.stringify(r)}\n`}],[o,...i]=Nn(n,e.tools);return t==="claude"&&s.push({path:e.mcp,content:`${JSON.stringify({mcpServers:{[Te]:{type:"stdio",command:o,args:i}}})}\n`}),t==="pi"&&s.push({path:e.piTools,content:Ui}),s}var Dn=t=>!!t?.length;var ms=[{id:"builtin",label:"Built-in",detail:"Fastest. Uses Buzz\'s tools and the tools you pick, and runs code in the Sandbox when it needs to."},{id:"claude",label:"Claude Code",detail:"Anthropic\'s coding agent, running in the Sandbox with its own tools and the Databricks CLI signed in as you. Keeps its context between turns."},{id:"codex",label:"Codex",detail:"OpenAI\'s coding agent, running in the Sandbox with its own tools and the Databricks CLI signed in as you. Keeps its context between turns."},{id:"pi",label:"Pi",detail:"A small coding agent for Claude, GPT and Gemini models, running in the Sandbox with its own tools. Keeps its context between turns."}],cd=ms.map(t=>t.id);var Ne=t=>ms.find(e=>e.id===t)?.label??t;var ys=["To show a query result or other table, put it in a fenced code block with the language",`\\`${rn}\\` whose body is CSV with a header row (up to 200 rows; quote values that contain commas).`,"Buzz draws it as an interactive chart with a table view, so you can chart data; don\'t say you can\'t.","Put the label column (such as a date or category) first and the numeric columns after it, unformatted (no $ or thousands separators)."].join(" "),ld=`${We}/.buzz/runs`,Bt=`${We}/work`,bs=t=>({dir:t,prompt:`${t}/prompt.md`,system:`${t}/system.md`,events:`${t}/events.jsonl`,stderr:`${t}/stderr.log`,exit:`${t}/exit`,pid:`${t}/pid`,script:`${t}/run.sh`,tools:`${t}/tools.json`,mcp:`${t}/mcp.json`,piTools:`${t}/databricks-tools.mjs`}),Y=t=>`\'${t.replace(/\'/g,"\'\\\\\'\'")}\'`,Hi="read,grep,find,ls,edit,write";function ws(t){let{model:e,files:n,session:r,tools:s}=t,o=t.permissions==="full",i=s?Nn(s.runner,n.tools):void 0;switch(t.harness){case"claude":{if(!r)throw new Error("Claude Code needs a session ID.");return[...i?["MCP_TIMEOUT=120000","MCP_TOOL_TIMEOUT=600000"]:[],"claude","-p","--model",Y(e),"--output-format","stream-json","--verbose","--permission-mode",o?"bypassPermissions":"auto",...i?["--mcp-config",Y(n.mcp),"--strict-mcp-config",...o?[]:["--allowedTools",`mcp__${Te}`]]:[],"--append-system-prompt-file",Y(n.system),r.resume?"--resume":"--session-id",Y(r.id),"<",Y(n.prompt)].join(" ")}case"codex":return["codex","exec",...r?["resume",Y(r.id)]:[],"--json","--skip-git-repo-check","-m",Y(e),...o?["--dangerously-bypass-approvals-and-sandbox"]:["-c",Y(\'sandbox_mode="workspace-write"\'),"-c","sandbox_workspace_write.network_access=true"],...i?["-c",Y(`mcp_servers.${Te}.command=${JSON.stringify(i[0])}`),"-c",Y(`mcp_servers.${Te}.args=${JSON.stringify(i.slice(1))}`),"-c",`mcp_servers.${Te}.startup_timeout_sec=120`,"-c",`mcp_servers.${Te}.tool_timeout_sec=600`,"-c",Y(`mcp_servers.${Te}.default_tools_approval_mode="approve"`)]:[],"-","<",Y(n.prompt)].join(" ");case"pi":{if(!r)throw new Error("Pi needs a session ID.");let a=i?`$(${[...i.slice(0,2),"mcp-names",n.tools].map(Y).join(" ")} 2>/dev/null)`:"";return[...i?[`BUZZ_TOOLS_BRIDGE=${Y(JSON.stringify(i))}`]:[],"pi","-p","--mode","json","--model",Y(e),"--session-id",Y(r.id),"--append-system-prompt",Y(n.system),...i?["-e",Y(n.piTools)]:[],...o?[]:["--tools",`"${Hi}${a}"`],Y(`@${n.prompt}`),"<","/dev/null"].join(" ")}}}var qi=["command","cmd","file_path","path","pattern","query","question","statement","url","description","prompt"];function Be(t){if(!(!t||typeof t!="object"))for(let e of qi){let n=t[e];if(typeof n=="string"&&n.trim())return n.length>80?`${n.slice(0,77)}\\u2026`:n}}var Gi=t=>{let e=/^\\/bin\\/(?:ba)?sh -lc ([\'"])([\\s\\S]*)\\1$/.exec(t);return e?e[1]===\'"\'?e[2].replace(/\\\\(["\\\\$`])/g,"$1"):e[2]:t},gs=t=>Array.isArray(t)?t.filter(e=>!!e&&typeof e=="object"&&e.type==="thinking"&&typeof e.thinking=="string").map(e=>e.thinking.trim()).filter(Boolean).join(`\n\n`):"",hs=t=>Array.isArray(t)?t.filter(e=>!!e&&typeof e=="object"&&e.type==="text"&&typeof e.text=="string").map(e=>e.text).join(""):typeof t=="string"?t:"";function xs(t,e){let n;try{n=JSON.parse(e)}catch{return}if(!(!n||typeof n!="object")){if(t==="claude"){if(n.type==="system"&&n.subtype==="init"&&typeof n.session_id=="string")return{session:n.session_id};if(n.type==="system"&&n.subtype==="api_retry")return{step:{tool:"model",target:`retrying after ${n.error_status??"an error"}${n.error?` (${n.error})`:""}`}};if(n.type==="assistant"&&Array.isArray(n.message?.content)){let r=gs(n.message.content),s=n.message.content.find(i=>i?.type==="tool_use");if(s)return{...r&&{thought:r},step:{tool:String(s.name??"tool"),...Be(s.input)&&{target:Be(s.input)}}};let o=hs(n.message.content);return o||r?{...o&&{text:o},...r&&{thought:r}}:void 0}if(n.type==="result"){let r=typeof n.result=="string"?n.result:"";return n.is_error||n.subtype&&n.subtype!=="success"?{error:r||String(n.subtype??"Claude Code failed")}:{final:r}}return}if(t==="codex"){if(n.type==="thread.started"&&typeof n.thread_id=="string")return{session:n.thread_id};if(n.type==="turn.failed")return{error:String(n.error?.message??"Codex failed")};let r=n.item;return!r||typeof r!="object"?void 0:n.type==="item.started"?r.type==="command_execution"&&typeof r.command=="string"?{step:{tool:"shell",target:Be({command:Gi(r.command)})}}:r.type==="file_change"?{step:{tool:"edit",...r.changes?.[0]?.path&&{target:String(r.changes[0].path)}}}:r.type==="mcp_tool_call"?{step:{tool:String(r.tool??"tool"),...Be(r.arguments)&&{target:Be(r.arguments)}}}:r.type==="web_search"?{step:{tool:"web search",...r.query&&{target:String(r.query)}}}:void 0:n.type==="item.completed"&&r.type==="agent_message"&&typeof r.text=="string"?{text:r.text}:n.type==="item.completed"&&r.type==="reasoning"&&typeof r.text=="string"&&r.text.trim()?{thought:r.text}:void 0}if(n.type==="session"&&typeof n.id=="string")return{session:n.id};if(n.type==="tool_execution_start")return{step:{tool:String(n.toolName??"tool"),...Be(n.args)&&{target:Be(n.args)}}};if(n.type==="message_end"&&n.message?.role==="assistant"){if(n.message.stopReason==="error"&&n.message.errorMessage)return{error:String(n.message.errorMessage)};let r=hs(n.message.content),s=gs(n.message.content);return r||s?{...r&&{text:r},...s&&{thought:s}}:void 0}}}var ji=t=>t.replace(/\\x1b\\[[0-9;]*[A-Za-z]/g,"").replace(/[\u2502\u256D\u256E\u2570\u256F\u2500\u2714\u2022]/g,"").trim();function Mn(t){return ji(t).split(`\n`).map(e=>e.trim()).filter(e=>e&&!/Unity Gateway|Databricks auth already|Launching |Starting |managed coding agent config|token refresh is managed|^is running\\.?$/i.test(e)).slice(-4).join(" ").slice(0,600)}function Es(t,e,n=[]){return["<databricks-sandbox>",`You are running as ${Ne(t)} inside your own Databricks Sandbox, a Linux machine in Databricks with Python, Node.js, git, the Databricks CLI (already signed in as your owner) and internet access. Your working folder is ${Bt}; files under ${We} persist across restarts.`,"Your final message is posted to the Buzz conversation as your reply, so make it the answer itself, written for the people there. You don\'t have Buzz\'s own tools in this session.",t==="pi"&&e==="standard"?"You can read, search and edit files, but you have no shell in this session.":"",n.length?`Your owner gave you these Databricks tools, which run with their access: ${n.map(r=>r.label).join(", ")}. Use them for questions about data (Genie One finds the right tables and runs the SQL). If a tool says your owner hasn\'t logged in yet, give them its login link.`:"","Never print secrets into the conversation.","</databricks-sandbox>"].filter(Boolean).join(`\n`)}var zi=new Set(["Bash","Read","Write","Edit","MultiEdit","NotebookEdit","Grep","Glob","ListFiles","WebFetch","WebSearch","Task","Agent","TodoWrite","send","send_message","read"]),Ss={shell:"Bash",bash:"Bash",exec_command:"Bash",sandbox_exec:"Bash",read_file:"Read",sandbox_read_file:"Read",write:"Write",write_file:"Write",sandbox_write_file:"Write",edit:"Edit",apply_patch:"Edit",grep:"Grep",find:"Glob",glob:"Glob",ls:"ListFiles",sandbox_list:"ListFiles","web search":"WebSearch",web_search:"WebSearch",fetch:"WebFetch",web_fetch:"WebFetch",update_plan:"TodoWrite"},Ki={genie_one_ask:"Asking Genie One",databricks_genie_one_ask:"Asking Genie One",databricks_genie_ask:"Asking Genie",databricks_genie_list:"Listing Genie agents",databricks_sql_query:"Running SQL",databricks_sql_warehouses:"Finding a SQL warehouse",databricks_catalog_list:"Browsing the catalog",databricks_table_describe:"Reading a table",model:"Waiting for the model"},Fi={"Creating sandbox":"Creating its Sandbox","Starting sandbox":"Starting its Sandbox","Waiting for sandbox to stop":"Waiting for its Sandbox"},lt=t=>t.replace(/[_-]+/g," ").replace(/\\s+/g," ").trim();function be(t,e=100){let n=t.replace(/\\s+/g," ").trim();return n.length>e?`${n.slice(0,e-1).trimEnd()}\\u2026`:n}function dt(t,e,n){let r=(l,d=e)=>d?{tool:l,target:be(d,120)}:{tool:l},s=t.replace(/^mcp__[a-zA-Z0-9_-]+?__/,"");if(zi.has(s))return r(s);let o=Ss[s]??Ss[s.toLowerCase()];if(o)return r(o);if(s==="sandbox")return{tool:Fi[e??""]??"Starting its Sandbox"};if(s==="databricks_sql_query")return r("Running SQL",e?.split(`\n`).find(l=>l.trim()));let i=Ki[s];if(i)return r(i);let a=n?.get(s);if(/^genie_.+_ask$/.test(s))return r(`Asking ${a??`Genie (${lt(s.slice(6,-4))})`}`);let c=/^(.+?)__(.+)$/.exec(s);if(c){let l=n?.get(c[1])??lt(c[1]);return c[2]==="log_in"?{tool:`Checking the ${l} login`}:c[2]==="unavailable"?{tool:`${l} isn\'t available`}:r(`Using ${l}`,[lt(c[2]),e].filter(Boolean).join(": "))}return r(lt(s)||"Working")}function vs(t){let n=/^\\s*\\*\\*(.+?)\\*\\*/.exec(t)?.[1]??t.split(`\n`).find(r=>r.trim())??"";return n.trim()?{tool:"Thinking",target:be(n,110)}:{tool:"Thinking"}}var ks=t=>t.trim()?{tool:"Genie One",target:be(t,120)}:{tool:"Asking Genie One"},_s=t=>({tool:"Rate-limited",target:`${t.restarted?"asking Genie One again":"trying again"} in ${Math.max(1,Math.round(t.waitMs/1e3))} s (retry ${t.attempt})`});function Rs(t,e){let n={SUBMITTED:"sent the question",FILTERING_CONTEXT:"finding the right data",FETCHING_METADATA:"reading the tables",ASKING_AI:"writing the SQL",PENDING_WAREHOUSE:"waiting for the SQL warehouse",EXECUTING_QUERY:"running the query",COMPLETED:"answered"};return{tool:`Asking ${t}`,target:n[e]??lt(e.toLowerCase())}}function Un(t){let e=t.target;return e?{Bash:`Running ${e}`,Read:`Reading ${e}`,Write:`Writing ${e}`,Edit:`Editing ${e}`,MultiEdit:`Editing ${e}`,Grep:`Searching for ${e}`,Glob:`Finding ${e}`,ListFiles:`Listing ${e}`,WebFetch:`Reading ${e}`,WebSearch:`Searching the web for ${e}`}[t.tool]??`${t.tool} \\xB7 ${e}`:{Bash:"Running a command",Read:"Reading a file",Write:"Writing a file",Edit:"Editing a file",Grep:"Searching files",Glob:"Finding files",ListFiles:"Listing files",WebSearch:"Searching the web",TodoWrite:"Updating its plan",send:"Sending a message",send_message:"Sending a message",read:"Reading the conversation"}[t.tool]??t.tool}function Ts(t){let e={Bash:"execute",Read:"read",Write:"edit",Edit:"edit",MultiEdit:"edit",Grep:"search",Glob:"search",ListFiles:"search",WebFetch:"fetch",WebSearch:"fetch",Thinking:"think"};return e[t.tool]?e[t.tool]:/^(Asking|Running SQL|Reading a table|Browsing|Listing|Genie One)/.test(t.tool)?"search":"other"}var Wi="/api/2.0/omnigent",Vi="X-Databricks-Omnigent-Slice-Key",As=2500,Zi=8*6e4,Yi=3*6e4,Xi=3e4,Ji=3,Os="claude-native-ui",qn={"claude-native-ui":{label:"Claude Code",detail:"Claude Code, with models from AI Gateway."},"codex-native-ui":{label:"Codex",detail:"OpenAI\'s Codex, with models from AI Gateway."},"pi-native-ui":{label:"Pi",detail:"The Pi coding agent, with models from AI Gateway."},polly:{label:"Polly",detail:"Hands larger coding tasks to other coding agents, with an independent reviewer checking their work."},debby:{label:"Debby",detail:"A brainstorming partner that answers with Claude\'s and GPT\'s views side by side."}},Qi=new Set(["claude-native","codex-native","pi-native","claude-sdk","codex","pi"]),Nt=t=>qn[t]?.label??t.replace(/-native-ui$/,"").replace(/[-_]+/g," ");function ea(t){let e;try{let r=JSON.parse(t.body);typeof r.detail=="string"&&(e=r.detail)}catch{}let n=je(t);return e&&(n.message=e),n}var Hn=t=>(t??[]).map(e=>typeof e.text=="string"?e.text:"").filter(e=>e.trim()).join(`\n\n`);function Is(t,e={}){let r=((...o)=>{for(let i of o){let a=e[i];if(typeof a=="string"&&a.trim())return a}})("command","file_path","path","pattern","query","url","title","description","prompt");return dt({sys_os_shell:"Bash",shell:"Bash",exec_command:"Bash",sys_session_send:"Handing off to another agent",sys_read_inbox:"Checking on other agents",browser_navigate:"Opening a web page"}[t]??t,r)}function ta(t){if(t.type==="function_call"&&t.name){let e={};try{e=t.arguments?JSON.parse(t.arguments):{}}catch{}return Is(t.name,e)}if(t.type==="native_tool"&&t.item){let e=t.item,n=[e.name,e.tool_name,e.tool,e.type].find(o=>typeof o=="string"&&!!o),r=e.input??e.arguments??e.args;return n?Is(n,typeof r=="object"&&r?r:typeof r=="string"?{command:r}:{}):void 0}if(t.type==="terminal_command"&&t.input)return dt("Bash",t.input)}var $s=(t,e)=>new Promise((n,r)=>{if(e.aborted)return r(e.reason);let s=setTimeout(()=>{e.removeEventListener("abort",o),n()},t),o=()=>{clearTimeout(s),r(e.reason)};e.addEventListener("abort",o,{once:!0})}),Pt=class{constructor(e,n){this.client=e;this.workspaceId=n}hosts=new Map;webUrl(e){let n=new URL(`${this.client.host}/omnigent${e?`/c/${encodeURIComponent(e)}`:""}`);return this.workspaceId&&n.searchParams.set("o",this.workspaceId),n.toString()}async call(e,n,r={}){let s=r.session?this.hosts.get(r.session):void 0,o=a=>this.client.request(`${Wi}${n}`,{method:e,...r.body!==void 0&&{body:r.body},headers:{...this.workspaceId&&{"X-Databricks-Org-Id":this.workspaceId},...a&&s&&{[Vi]:s}},timeoutMs:6e4,...r.signal&&{signal:r.signal}}),i=await o(!0);if(i.status===400&&s&&/wrong_replica/.test(i.body)&&(i=await o(!1)),i.status<200||i.status>=300)throw ea(i);return i.body.trim()?JSON.parse(i.body):{}}async check(e){try{return(await this.call("GET","/v1/info",{...e&&{signal:e}})).managed_sandboxes_enabled===!1?{ok:!1,reason:"Omnigent is on in this workspace, but not with Databricks Sandbox sessions, which hosted agents use."}:{ok:!0}}catch(n){let r=n.status;return r===404?{ok:!1,reason:"Omnigent isn\'t on in this workspace. A workspace admin can turn on the Omnigent preview."}:r===401||r===403?{ok:!1,reason:"Omnigent turned this account away; it may not be enabled for you."}:{ok:!1,reason:n.message}}}async agents(e){let n=await this.call("GET","/v1/agents?limit=200",{...e&&{signal:e}}),r=Object.keys(qn);return(n.data??[]).filter(s=>Qi.has(s.harness??"")).map(s=>{let i=qn[s.name]?.detail??s.description??void 0;return{id:s.id,name:s.name,harness:s.harness??"",label:Nt(s.name),...i&&{detail:i}}}).sort((s,o)=>(r.indexOf(s.name)+1||99)-(r.indexOf(o.name)+1||99)||s.label.localeCompare(o.label))}async create(e,n,r){let s=(await this.agents(r)).find(a=>a.name===e);if(!s)throw new Error(`This workspace\'s Omnigent has no agent named ${e} that runs in a Databricks Sandbox.`);let o=await this.call("POST","/v1/sessions",{body:{agent_id:s.id,host_type:"managed",title:n.slice(0,120)},...r&&{signal:r}}),i=o.id??o.session_id;if(!i)throw new Error("Omnigent didn\'t return the new session.");return i}async session(e,n){let r=await this.call("GET",`/v1/sessions/${encodeURIComponent(e)}`,{session:e,...n&&{signal:n}});return r.host_id&&this.hosts.set(e,r.host_id),r}async send(e,n,r){return(await this.call("POST",`/v1/sessions/${encodeURIComponent(e)}/events`,{session:e,body:{type:"message",data:{role:"user",content:[{type:"input_text",text:n}]}},...r&&{signal:r}})).item_id}async interrupt(e,n){await this.call("POST",`/v1/sessions/${encodeURIComponent(e)}/events`,{session:e,body:{type:"interrupt",data:{}},...n&&{signal:n}})}async items(e,n,r){let s=[],o=n;for(let i=0;i<20;i++){let a=new URLSearchParams({limit:"100",order:"asc",...o&&{after:o}}),c=await this.call("GET",`/v1/sessions/${encodeURIComponent(e)}/items?${a}`,{session:e,...r&&{signal:r}});if(s.push(...c.data??[]),!c.has_more||!c.last_id)break;o=c.last_id}return s}async newest(e,n){return(await this.call("GET",`/v1/sessions/${encodeURIComponent(e)}/items?limit=1&order=desc`,{session:e,...n&&{signal:n}})).data?.[0]?.id}async ready(e,n,r,s){let o=Date.now()+Zi,i="";for(;;){let a=await this.session(e,r),c=a.sandbox_status;if(c?.stage==="failed"||a.status==="failed")throw new Error(`Omnigent couldn\'t start the session\'s Sandbox${c?.error?`: ${c.error}`:"."}`);if(!(c&&c.stage!=="ready")&&(a.runner_online===!0||!n&&a.host_resumable!==!1))return;if(c&&c.stage!==i&&(i=c.stage,s?.({tool:"Starting its Omnigent Sandbox",target:c.stage})),Date.now()>o)throw new Error("Omnigent\'s Sandbox for this session didn\'t start in time.");await $s(As,r)}}async turn(e){let{signal:n,onStep:r,onThought:s}=e,o=e.session,i=!1;if(o)try{await this.session(o,n)}catch(d){if(d.status!==404)throw d;o=void 0}o||(r?.({tool:"Starting an Omnigent session",target:Nt(e.agent)}),o=await this.create(e.agent,e.title,n),i=!0,e.onSession?.(o)),await this.ready(o,i,n,r);let a=i?void 0:await this.newest(o,n),c=await this.send(o,e.text(i),n),l=o;try{return await this.follow(l,c??a,i,n,r,s)}catch(d){throw n.aborted&&await this.interrupt(l).catch(()=>{}),d}}async follow(e,n,r,s,o,i){let a=n,c=!1,l="",d,u=0,m,f=Date.now();for(;;){await $s(As,s);let y=await this.session(e,s),S=await this.items(e,a,s);for(let b of S){if(a=b.id,b.type==="message"&&b.role==="user")continue;if(c=!0,b.type==="message"&&b.role==="assistant"){let B=Hn(b.content);if(!B)continue;l&&i?.(l),l=B;continue}if(b.type==="reasoning"){let B=Hn(b.summary)||Hn(b.content);B&&i?.(B);continue}if(b.type==="error"){d=[b.title,b.message].filter(Boolean).join(": ")||"Omnigent reported an error.";continue}let C=ta(b);C&&o?.(C)}let E=n?y.failed_inputs?.find(b=>b.id===n||b.item_id===n):void 0;if(E)throw new Error(`Omnigent couldn\'t take the message${typeof E.error=="string"?`: ${E.error}`:"."}`);if(y.status==="failed")throw new Error(d??na(y.last_task_error)??"The Omnigent session failed.");if(y.status==="running"&&(c=!0,u=0),y.pending_elicitations?.length){if(m??=Date.now(),Date.now()-m>Xi){let b=`It\'s waiting for your approval in Omnigent before it goes on: [open the session](${this.webUrl(e)}).`;return{session:e,text:l?`${l}\n\n${b}`:b,fresh:r,waiting:!0}}continue}if(m=void 0,y.status==="idle"){if(!c){if(Date.now()-f>Yi)throw new Error("Omnigent accepted the message but didn\'t start working on it.");continue}if(l||++u>=Ji){if(!l&&d)throw new Error(d);return{session:e,text:l||"_It finished without a reply._",fresh:r,waiting:!1}}}}}};function na(t){if(!t)return;let e=t.message??t.detail??t.error;return typeof e=="string"&&e?be(e,400):void 0}var Ve=[9,40002],ra="buzz.solo",sa=48e3,Bs=/^[0-9a-f]{64}$/,oa=/^[0-9a-f]{128}$/,ia=/^(kind=|created_at<|created_at>)(0|[1-9][0-9]*)$/,aa=(t,e)=>t.tags.find(n=>n[0]===e)?.[1],ca=t=>{let e=aa(t,"h");return e&&/^[a-zA-Z0-9_-]{1,128}$/.test(e)?e:void 0};function la(t){let e,n;for(let r of t.tags)r[0]!=="e"||!Bs.test(r[1]??"")||(r[3]==="root"?e=r[1]:r[3]==="reply"&&(n=r[1]));return e??n}var Ns=(t,e)=>Ve.includes(t.kind)&&t.pubkey!==e&&t.tags.some(n=>n[0]==="p"&&n[1]===e);function da(t){let e=t.tags.filter(a=>a[0]==="auth");if(e.length!==1)return;let[,n="",r="",s=""]=e[0];if(e[0].length!==4||!Bs.test(n)||!oa.test(s)||n===t.pubkey)return;let o=r?r.split("&"):[];if(!o.every(a=>ia.test(a)))return;for(let a of o){let c=Number(a.replace(/^[^0-9]+/,""));if(a.startsWith("kind=")&&t.kind!==c||a.startsWith("created_at<")&&!(t.created_at<c)||a.startsWith("created_at>")&&!(t.created_at>c))return}let i=ce(new TextEncoder().encode(`nostr:agent-auth:${t.pubkey}:${r}`));try{return _e.verify(Buffer.from(s,"hex"),i,Buffer.from(n,"hex"))?n:void 0}catch{return}}var Ps=(t,e)=>t.pubkey===e||da(t)===e;function Ds(t){if(!t)return{solo:!1};let[e,...n]=t.tags.flatMap(r=>r[0]==="t"&&typeof r[1]=="string"?[r[1]]:[]);return{...e&&{type:e},solo:e==="stream"&&n.includes(ra)}}function Gn(t,e,n){let r=ca(t);if(!r)return;let s=la(t),o=s??t.id,i=n.type==="dm",a=n.solo,c=a||i||e==="channel";return{key:c?r:`${r}/${o}`,channel:r,root:o,topLevel:a,dm:i,fresh:!s&&!c}}function Ms(t){return t.fresh?[]:!t.topLevel&&!t.dm&&t.key!==t.channel?[{ids:[t.root],"#h":[t.channel],limit:1},{kinds:Ve,"#h":[t.channel],"#e":[t.root],limit:200}]:[{kinds:Ve,"#h":[t.channel],limit:13}]}var Cs=t=>JSON.stringify(t).replace(/</g,"\\\\u003c").replace(/>/g,"\\\\u003e").replace(/&/g,"\\\\u0026"),Ls=(t,e)=>({id:t.id,pubkey:t.pubkey,...e.get(t.pubkey)&&{author:e.get(t.pubkey)},time:new Date(t.created_at*1e3).toISOString(),content:t.content});function Us(t){let{event:e,conversation:n,names:r}=t,s=n.dm?"dm":n.key===n.channel?"channel":"thread",o=[`Scope: ${s}`,`Session scope: ${t.scope==="channel"||n.key===n.channel?"channel":"thread"} conversation`,`Channel: #${n.channel}`,...s==="thread"?[`Thread root: ${n.root}`]:[],`Agent: ${t.agent}`,"Your final message is posted as your reply in this conversation."].join(`\n`),i=s==="thread"?"thread-context":"conversation-context",a=[`<context>\n${o}\n</context>`];t.context.length&&a.push(`<${i} included="${t.context.length}" total="${t.total}" truncated="${t.total>t.context.length}">\n${Cs(t.context.map(l=>Ls(l,r)))}\n</${i}>`);let c=e.tags.filter(l=>l[0]==="p").map(l=>l[1]);return a.push(`<buzz-event type="@mention">\n${Cs({...Ls(e,r),channel:n.channel,kind:e.kind,...n.root!==e.id&&{thread:n.root},...c.length&&{mentions:c}})}\n</buzz-event>`),a.join(`\n\n`)}var Dt=t=>t.replace(/\\[([^\\]]*)\\]\\(nostr:[^)]+\\)/g,"").replace(/nostr:(npub|nprofile|note|nevent)1[0-9a-z]+/g,"").replace(/^\\s*@\\S+\\s*/,"").replace(/[ \\t]+/g," ").trim();function Hs(t,e=sa){let n=o=>Buffer.byteLength(o);if(n(t)<=e)return[t];let r=[],s=t;for(;n(s)>e;){let o=e;for(;n(s.slice(0,o))>e;)o=Math.floor(o*.9);let i=s.slice(0,o),a=Math.max(i.lastIndexOf(`\n\n`),i.lastIndexOf(`\n`)),c=a>o/2?a:o;r.push(s.slice(0,c).trimEnd()),s=s.slice(c).trimStart()}return s&&r.push(s),r}function qs(t){return{kind:9,created_at:Math.floor(Date.now()/1e3),content:t.content,tags:[["h",t.conversation.channel],...t.conversation.topLevel?[]:[["e",t.conversation.root,"","reply"]],...(typeof t.notify=="string"?[t.notify]:t.notify??[]).map(e=>["p",e]),[...t.authTag]]}}function jn(t){return{kind:0,created_at:Math.floor(Date.now()/1e3),content:JSON.stringify({name:t.name,display_name:t.name,bot:!0,...t.picture&&{picture:t.picture},...t.about&&{about:t.about}}),tags:[[...t.authTag]]}}var Gs="Hi! I only take requests from the person who set me up, since I work with their Databricks access, so I can\'t help with this one. I\'ve let them know you asked.",Mt=class{constructor(e=36e5,n=()=>Date.now()){this.quietMs=e;this.now=n}told=new Map;take(e,n,r){let s=this.now(),o=`${e}|${n}|${r}`,i=this.told.get(o);if(i!==void 0&&s-i<this.quietMs)return!1;if(this.told.set(o,s),this.told.size>1e3)for(let[a,c]of this.told)s-c>=this.quietMs&&this.told.delete(a);return!0}};var js=t=>`/mcp-service-login?name=${encodeURIComponent(t)}`,zs=t=>/HTTP 401|requires authentication|not logged in|login first|Credential for user identity/i.test(t?.message??String(t));function ut(t){return((t.label||t.id).toLowerCase().replace(/[^a-z0-9]+/g,"_").replace(/^_+|_+$/g,"")||"mcp").slice(0,20).replace(/_+$/,"")}var ua="Note: these results came from the owner\'s Databricks access. Everyone in this conversation can read what you post, so share only what this audience should see.";function Ks(t,e,n,r){let s=[`Genie agent: ${t.title} (${t.space_id})`,`conversation_id: ${e.message.conversation_id}`,`status: ${e.message.status}`];return e.error&&s.push(`error: ${e.error}`),e.text&&s.push("",e.text),e.result?s.push("",mt(e.result,r)):e.rowCount!==void 0&&s.push("",`(The query returned ${e.rowCount} rows; the result could not be fetched.)`),e.sql&&s.push("","SQL:","```sql",e.sql.trim(),"```"),e.suggestions.length&&s.push("",`Follow-ups Genie suggests: ${e.suggestions.slice(0,3).join(" | ")}`),n&&s.push("",`Open in Genie: ${n}`),s.push("",ua),s.join(`\n`)}var fa=/^[a-zA-Z0-9_-]{1,64}$/;function Ws(t){return Array.isArray(t)?t.flatMap(e=>{let n=e;return typeof n?.id!="string"||typeof n.label!="string"||typeof n.kind!="string"?[]:["service","connection","functions"].includes(n.kind)&&!(typeof n.path=="string"&&n.path.startsWith("/"))?[]:[{id:n.id,kind:n.kind,label:n.label,...n.path&&{path:n.path}}]}):[]}var Fs=(t,e)=>(t.toLowerCase().replace(/[^a-z0-9]+/g,"_").replace(/^_+|_+$/g,"")||"x").slice(0,e).replace(/_+$/,""),pa=t=>{let e=t.snapshot();return e.status==="connected"?e.workspaceId??e.profile.workspaceId:void 0};function ga(t,e){let n=new AbortController,r=setTimeout(()=>n.abort(new Error(`No answer within ${e/1e3} seconds`)),e),s=()=>n.abort(t.reason);return t.aborted?s():t.addEventListener("abort",s,{once:!0}),n.signal.addEventListener("abort",()=>clearTimeout(r),{once:!0}),n.signal}function Vs(t){let e=new Map,n=new Set;for(let r of t)r.kind==="genie"?e.set(Zs(r.label,n),r.label):r.path&&e.set(ut(r),r.label);return e}function Zs(t,e){let n=`genie_${Fs(t,40)}_ask`;for(let r=2;e.has(n);r++)n=`genie_${Fs(t,36)}_${r}_ask`;return e.add(n),n}function Ys(t,e){let n=[],r=new Set;for(let s of e)if(s.kind==="genie-one"){let o=new Fe(t);n.push({name:"genie_one_ask",description:"Asks Genie One, Databricks\' assistant for questions about any data the owner can access in this agent\'s workspace. It finds the tables, writes and runs the SQL, and answers with numbers, a table and a link. Pass conversation_id from an earlier answer to follow up. Answers can take a minute.",parameters:{type:"object",properties:{question:{type:"string",description:"The question, in plain language."},conversation_id:{type:"string"}},required:["question"]},run:async(i,a)=>{let c=typeof i.conversation_id=="string"&&i.conversation_id?i.conversation_id:void 0;return o.format(await o.ask(String(i.question??""),{signal:a,...c&&{conversationId:c}}))}})}else if(s.kind==="genie"){let o=s.id.replace(/^genie:/,""),i=Zs(s.label,r);n.push({name:i,description:`Asks the "${s.label}" Genie agent, curated by the owner\'s data team, a question about its data. It answers with an explanation, a table and the SQL. Pass conversation_id to follow up.`,parameters:{type:"object",properties:{question:{type:"string",description:"The question, in plain language."},conversation_id:{type:"string"}},required:["question"]},run:async(a,c)=>{let l=await t.ready(c),d=typeof a.conversation_id=="string"&&a.conversation_id?a.conversation_id:void 0,u=await new fe(l).answer(o,String(a.question??""),{signal:c,...d&&{conversationId:d}});return Ks({title:s.label,space_id:o},u,t.workspaceUrl(fe.webPath(o,u.message.conversation_id)),30)}})}return n}async function Xs(t,e,n){let r=e.filter(u=>u.path);if(!r.length)return{tools:[],problems:[],failures:[]};let s=await t.ready(n),o=pa(t),i=[],a=[],c=await Promise.all(r.map(async u=>{let m=u.path.startsWith("/ai-gateway/")&&o?{o}:{},f=new ze(s,u.path,m);try{let y=await f.listTools(ga(n,3e4));return{server:u,mcp:f,tools:y}}catch(y){let S=u.kind==="service"&&zs(y)?t.workspaceUrl(js(u.id.replace(/^service:/,""))):void 0;return a.push({server:u,message:y.message??String(y),...S&&{login:S}}),i.push(S?`${u.label}: your owner isn\'t logged in to ${u.label} yet. Ask them to log in at ${S}, then try again`:`${u.label}: ${y.message??y}`),{server:u,mcp:f,tools:[]}}})),l=[],d=new Set;for(let{server:u,mcp:m,tools:f}of c){let y=ut(u);for(let S of f){let E=`${y}__${S.name}`.replace(/[^a-zA-Z0-9_-]/g,"_").slice(0,64);for(let b=2;d.has(E);b++)E=`${E.slice(0,60)}_${b}`;fa.test(E)&&(d.add(E),l.push({name:E,description:`[${u.label}] ${S.description??S.title??S.name}`.slice(0,4e3),parameters:S.inputSchema??{type:"object",properties:{}},run:async(b,C)=>{let B=await m.callTool(S.name,b,{signal:C,timeoutMs:17e4}),W=Re(B)||(B.structuredContent!==void 0?JSON.stringify(Ke(B)):"OK");return B.isError?`Error from ${u.label}: ${W}`:W}}))}}return{tools:l,problems:i,failures:a}}import{appendFileSync as Ka,existsSync as Fa,readFileSync as Wa,statSync as Va,writeFileSync as Za}from"node:fs";function ha(t){return t instanceof Uint8Array||ArrayBuffer.isView(t)&&t.constructor.name==="Uint8Array"}function Ut(t){if(typeof t!="boolean")throw new Error(`boolean expected, not ${t}`)}function Ht(t){if(!Number.isSafeInteger(t)||t<0)throw new Error("positive integer expected, got "+t)}function J(t,e,n=""){let r=ha(t),s=t?.length,o=e!==void 0;if(!r||o&&s!==e){let i=n&&`"${n}" `,a=o?` of length ${e}`:"",c=r?`length=${s}`:`type=${typeof t}`;throw new Error(i+"expected Uint8Array"+a+", got "+c)}return t}function zn(t,e=!0){if(t.destroyed)throw new Error("Hash instance has been destroyed");if(e&&t.finished)throw new Error("Hash#digest() has already been called")}function Js(t,e){J(t,void 0,"output");let n=e.outputLen;if(t.length<n)throw new Error("digestInto() expects output buffer of length at least "+n)}function we(t){return new Uint32Array(t.buffer,t.byteOffset,Math.floor(t.byteLength/4))}function xe(...t){for(let e=0;e<t.length;e++)t[e].fill(0)}function ma(t){return new DataView(t.buffer,t.byteOffset,t.byteLength)}var ya=new Uint8Array(new Uint32Array([287454020]).buffer)[0]===68;function Qs(t,e){if(e==null||typeof e!="object")throw new Error("options must be defined");return Object.assign(t,e)}function eo(t,e){if(t.length!==e.length)return!1;let n=0;for(let r=0;r<t.length;r++)n|=t[r]^e[r];return n===0}var Kn=(t,e)=>{function n(r,...s){if(J(r,void 0,"key"),!ya)throw new Error("Non little-endian hardware is not yet supported");if(t.nonceLength!==void 0){let d=s[0];J(d,t.varSizeNonce?void 0:t.nonceLength,"nonce")}let o=t.tagLength;o&&s[1]!==void 0&&J(s[1],void 0,"AAD");let i=e(r,...s),a=(d,u)=>{if(u!==void 0){if(d!==2)throw new Error("cipher output not supported");J(u,void 0,"output")}},c=!1;return{encrypt(d,u){if(c)throw new Error("cannot encrypt() twice with same key + nonce");return c=!0,J(d),a(i.encrypt.length,u),i.encrypt(d,u)},decrypt(d,u){if(J(d),o&&d.length<o)throw new Error(\'"ciphertext" expected length bigger than tagLength=\'+o);return a(i.decrypt.length,u),i.decrypt(d,u)}}}return Object.assign(n,t),n};function Fn(t,e,n=!0){if(e===void 0)return new Uint8Array(t);if(e.length!==t)throw new Error(\'"output" expected Uint8Array of length \'+t+", got: "+e.length);if(n&&!ba(e))throw new Error("invalid output, must be aligned");return e}function to(t,e,n){Ut(n);let r=new Uint8Array(16),s=ma(r);return s.setBigUint64(0,BigInt(e),n),s.setBigUint64(8,BigInt(t),n),r}function ba(t){return t.byteOffset%4===0}function Ze(t){return Uint8Array.from(t)}var ro=t=>Uint8Array.from(t.split(""),e=>e.charCodeAt(0)),wa=ro("expand 16-byte k"),xa=ro("expand 32-byte k"),Ea=we(wa),Sa=we(xa);function $(t,e){return t<<e|t>>>32-e}function Wn(t){return t.byteOffset%4===0}var qt=64,va=16,so=2**32-1,no=Uint32Array.of();function ka(t,e,n,r,s,o,i,a){let c=s.length,l=new Uint8Array(qt),d=we(l),u=Wn(s)&&Wn(o),m=u?we(s):no,f=u?we(o):no;for(let y=0;y<c;i++){if(t(e,n,r,d,i,a),i>=so)throw new Error("arx: counter overflow");let S=Math.min(qt,c-y);if(u&&S===qt){let E=y/4;if(y%4!==0)throw new Error("arx: invalid block position");for(let b=0,C;b<va;b++)C=E+b,f[C]=m[C]^d[b];y+=qt;continue}for(let E=0,b;E<S;E++)b=y+E,o[b]=s[b]^l[E];y+=S}}function Vn(t,e){let{allowShortKeys:n,extendNonceFn:r,counterLength:s,counterRight:o,rounds:i}=Qs({allowShortKeys:!1,counterLength:8,counterRight:!1,rounds:20},e);if(typeof t!="function")throw new Error("core must be a function");return Ht(s),Ht(i),Ut(o),Ut(n),(a,c,l,d,u=0)=>{J(a,void 0,"key"),J(c,void 0,"nonce"),J(l,void 0,"data");let m=l.length;if(d===void 0&&(d=new Uint8Array(m)),J(d,void 0,"output"),Ht(u),u<0||u>=so)throw new Error("arx: counter overflow");if(d.length<m)throw new Error(`arx: output (${d.length}) is shorter than data (${m})`);let f=[],y=a.length,S,E;if(y===32)f.push(S=Ze(a)),E=Sa;else if(y===16&&n)S=new Uint8Array(32),S.set(a),S.set(a,16),E=Ea,f.push(S);else throw J(a,32,"arx key"),new Error("invalid key size");Wn(c)||f.push(c=Ze(c));let b=we(S);if(r){if(c.length!==24)throw new Error("arx: extended nonce must be 24 bytes");r(E,b,we(c.subarray(0,16)),b),c=c.subarray(16)}let C=16-s;if(C!==c.length)throw new Error(`arx: nonce must be ${C} or 16 bytes`);if(C!==12){let L=new Uint8Array(12);L.set(c,o?0:12-c.length),c=L,f.push(c)}let B=we(c);return ka(t,E,b,B,l,d,u,i),xe(...f),d}}function Q(t,e){return t[e++]&255|(t[e++]&255)<<8}var Zn=class{blockLen=16;outputLen=16;buffer=new Uint8Array(16);r=new Uint16Array(10);h=new Uint16Array(10);pad=new Uint16Array(8);pos=0;finished=!1;constructor(e){e=Ze(J(e,32,"key"));let n=Q(e,0),r=Q(e,2),s=Q(e,4),o=Q(e,6),i=Q(e,8),a=Q(e,10),c=Q(e,12),l=Q(e,14);this.r[0]=n&8191,this.r[1]=(n>>>13|r<<3)&8191,this.r[2]=(r>>>10|s<<6)&7939,this.r[3]=(s>>>7|o<<9)&8191,this.r[4]=(o>>>4|i<<12)&255,this.r[5]=i>>>1&8190,this.r[6]=(i>>>14|a<<2)&8191,this.r[7]=(a>>>11|c<<5)&8065,this.r[8]=(c>>>8|l<<8)&8191,this.r[9]=l>>>5&127;for(let d=0;d<8;d++)this.pad[d]=Q(e,16+2*d)}process(e,n,r=!1){let s=r?0:2048,{h:o,r:i}=this,a=i[0],c=i[1],l=i[2],d=i[3],u=i[4],m=i[5],f=i[6],y=i[7],S=i[8],E=i[9],b=Q(e,n+0),C=Q(e,n+2),B=Q(e,n+4),L=Q(e,n+6),W=Q(e,n+8),z=Q(e,n+10),F=Q(e,n+12),K=Q(e,n+14),O=o[0]+(b&8191),H=o[1]+((b>>>13|C<<3)&8191),D=o[2]+((C>>>10|B<<6)&8191),x=o[3]+((B>>>7|L<<9)&8191),p=o[4]+((L>>>4|W<<12)&8191),h=o[5]+(W>>>1&8191),g=o[6]+((W>>>14|z<<2)&8191),v=o[7]+((z>>>11|F<<5)&8191),_=o[8]+((F>>>8|K<<8)&8191),k=o[9]+(K>>>5|s),w=0,R=w+O*a+H*(5*E)+D*(5*S)+x*(5*y)+p*(5*f);w=R>>>13,R&=8191,R+=h*(5*m)+g*(5*u)+v*(5*d)+_*(5*l)+k*(5*c),w+=R>>>13,R&=8191;let T=w+O*c+H*a+D*(5*E)+x*(5*S)+p*(5*y);w=T>>>13,T&=8191,T+=h*(5*f)+g*(5*m)+v*(5*u)+_*(5*d)+k*(5*l),w+=T>>>13,T&=8191;let A=w+O*l+H*c+D*a+x*(5*E)+p*(5*S);w=A>>>13,A&=8191,A+=h*(5*y)+g*(5*f)+v*(5*m)+_*(5*u)+k*(5*d),w+=A>>>13,A&=8191;let U=w+O*d+H*l+D*c+x*a+p*(5*E);w=U>>>13,U&=8191,U+=h*(5*S)+g*(5*y)+v*(5*f)+_*(5*m)+k*(5*u),w+=U>>>13,U&=8191;let M=w+O*u+H*d+D*l+x*c+p*a;w=M>>>13,M&=8191,M+=h*(5*E)+g*(5*S)+v*(5*y)+_*(5*f)+k*(5*m),w+=M>>>13,M&=8191;let I=w+O*m+H*u+D*d+x*l+p*c;w=I>>>13,I&=8191,I+=h*a+g*(5*E)+v*(5*S)+_*(5*y)+k*(5*f),w+=I>>>13,I&=8191;let N=w+O*f+H*m+D*u+x*d+p*l;w=N>>>13,N&=8191,N+=h*c+g*a+v*(5*E)+_*(5*S)+k*(5*y),w+=N>>>13,N&=8191;let j=w+O*y+H*f+D*m+x*u+p*d;w=j>>>13,j&=8191,j+=h*l+g*c+v*a+_*(5*E)+k*(5*S),w+=j>>>13,j&=8191;let V=w+O*S+H*y+D*f+x*m+p*u;w=V>>>13,V&=8191,V+=h*d+g*l+v*c+_*a+k*(5*E),w+=V>>>13,V&=8191;let q=w+O*E+H*S+D*y+x*f+p*m;w=q>>>13,q&=8191,q+=h*u+g*d+v*l+_*c+k*a,w+=q>>>13,q&=8191,w=(w<<2)+w|0,w=w+R|0,R=w&8191,w=w>>>13,T+=w,o[0]=R,o[1]=T,o[2]=A,o[3]=U,o[4]=M,o[5]=I,o[6]=N,o[7]=j,o[8]=V,o[9]=q}finalize(){let{h:e,pad:n}=this,r=new Uint16Array(10),s=e[1]>>>13;e[1]&=8191;for(let a=2;a<10;a++)e[a]+=s,s=e[a]>>>13,e[a]&=8191;e[0]+=s*5,s=e[0]>>>13,e[0]&=8191,e[1]+=s,s=e[1]>>>13,e[1]&=8191,e[2]+=s,r[0]=e[0]+5,s=r[0]>>>13,r[0]&=8191;for(let a=1;a<10;a++)r[a]=e[a]+s,s=r[a]>>>13,r[a]&=8191;r[9]-=8192;let o=(s^1)-1;for(let a=0;a<10;a++)r[a]&=o;o=~o;for(let a=0;a<10;a++)e[a]=e[a]&o|r[a];e[0]=(e[0]|e[1]<<13)&65535,e[1]=(e[1]>>>3|e[2]<<10)&65535,e[2]=(e[2]>>>6|e[3]<<7)&65535,e[3]=(e[3]>>>9|e[4]<<4)&65535,e[4]=(e[4]>>>12|e[5]<<1|e[6]<<14)&65535,e[5]=(e[6]>>>2|e[7]<<11)&65535,e[6]=(e[7]>>>5|e[8]<<8)&65535,e[7]=(e[8]>>>8|e[9]<<5)&65535;let i=e[0]+n[0];e[0]=i&65535;for(let a=1;a<8;a++)i=(e[a]+n[a]|0)+(i>>>16)|0,e[a]=i&65535;xe(r)}update(e){zn(this),J(e),e=Ze(e);let{buffer:n,blockLen:r}=this,s=e.length;for(let o=0;o<s;){let i=Math.min(r-this.pos,s-o);if(i===r){for(;r<=s-o;o+=r)this.process(e,o);continue}n.set(e.subarray(o,o+i),this.pos),this.pos+=i,o+=i,this.pos===r&&(this.process(n,0,!1),this.pos=0)}return this}destroy(){xe(this.h,this.r,this.buffer,this.pad)}digestInto(e){zn(this),Js(e,this),this.finished=!0;let{buffer:n,h:r}=this,{pos:s}=this;if(s){for(n[s++]=1;s<16;s++)n[s]=0;this.process(n,0,!0)}this.finalize();let o=0;for(let i=0;i<8;i++)e[o++]=r[i]>>>0,e[o++]=r[i]>>>8;return e}digest(){let{buffer:e,outputLen:n}=this;this.digestInto(e);let r=e.slice(0,n);return this.destroy(),r}};function _a(t){let e=(r,s)=>t(s).update(r).digest(),n=t(new Uint8Array(32));return e.outputLen=n.outputLen,e.blockLen=n.blockLen,e.create=r=>t(r),e}var oo=_a(t=>new Zn(t));function co(t,e,n,r,s,o=20){let i=t[0],a=t[1],c=t[2],l=t[3],d=e[0],u=e[1],m=e[2],f=e[3],y=e[4],S=e[5],E=e[6],b=e[7],C=s,B=n[0],L=n[1],W=n[2],z=i,F=a,K=c,O=l,H=d,D=u,x=m,p=f,h=y,g=S,v=E,_=b,k=C,w=B,R=L,T=W;for(let U=0;U<o;U+=2)z=z+H|0,k=$(k^z,16),h=h+k|0,H=$(H^h,12),z=z+H|0,k=$(k^z,8),h=h+k|0,H=$(H^h,7),F=F+D|0,w=$(w^F,16),g=g+w|0,D=$(D^g,12),F=F+D|0,w=$(w^F,8),g=g+w|0,D=$(D^g,7),K=K+x|0,R=$(R^K,16),v=v+R|0,x=$(x^v,12),K=K+x|0,R=$(R^K,8),v=v+R|0,x=$(x^v,7),O=O+p|0,T=$(T^O,16),_=_+T|0,p=$(p^_,12),O=O+p|0,T=$(T^O,8),_=_+T|0,p=$(p^_,7),z=z+D|0,T=$(T^z,16),v=v+T|0,D=$(D^v,12),z=z+D|0,T=$(T^z,8),v=v+T|0,D=$(D^v,7),F=F+x|0,k=$(k^F,16),_=_+k|0,x=$(x^_,12),F=F+x|0,k=$(k^F,8),_=_+k|0,x=$(x^_,7),K=K+p|0,w=$(w^K,16),h=h+w|0,p=$(p^h,12),K=K+p|0,w=$(w^K,8),h=h+w|0,p=$(p^h,7),O=O+H|0,R=$(R^O,16),g=g+R|0,H=$(H^g,12),O=O+H|0,R=$(R^O,8),g=g+R|0,H=$(H^g,7);let A=0;r[A++]=i+z|0,r[A++]=a+F|0,r[A++]=c+K|0,r[A++]=l+O|0,r[A++]=d+H|0,r[A++]=u+D|0,r[A++]=m+x|0,r[A++]=f+p|0,r[A++]=y+h|0,r[A++]=S+g|0,r[A++]=E+v|0,r[A++]=b+_|0,r[A++]=C+k|0,r[A++]=B+w|0,r[A++]=L+R|0,r[A++]=W+T|0}function Ra(t,e,n,r){let s=t[0],o=t[1],i=t[2],a=t[3],c=e[0],l=e[1],d=e[2],u=e[3],m=e[4],f=e[5],y=e[6],S=e[7],E=n[0],b=n[1],C=n[2],B=n[3];for(let W=0;W<20;W+=2)s=s+c|0,E=$(E^s,16),m=m+E|0,c=$(c^m,12),s=s+c|0,E=$(E^s,8),m=m+E|0,c=$(c^m,7),o=o+l|0,b=$(b^o,16),f=f+b|0,l=$(l^f,12),o=o+l|0,b=$(b^o,8),f=f+b|0,l=$(l^f,7),i=i+d|0,C=$(C^i,16),y=y+C|0,d=$(d^y,12),i=i+d|0,C=$(C^i,8),y=y+C|0,d=$(d^y,7),a=a+u|0,B=$(B^a,16),S=S+B|0,u=$(u^S,12),a=a+u|0,B=$(B^a,8),S=S+B|0,u=$(u^S,7),s=s+l|0,B=$(B^s,16),y=y+B|0,l=$(l^y,12),s=s+l|0,B=$(B^s,8),y=y+B|0,l=$(l^y,7),o=o+d|0,E=$(E^o,16),S=S+E|0,d=$(d^S,12),o=o+d|0,E=$(E^o,8),S=S+E|0,d=$(d^S,7),i=i+u|0,b=$(b^i,16),m=m+b|0,u=$(u^m,12),i=i+u|0,b=$(b^i,8),m=m+b|0,u=$(u^m,7),a=a+c|0,C=$(C^a,16),f=f+C|0,c=$(c^f,12),a=a+c|0,C=$(C^a,8),f=f+C|0,c=$(c^f,7);let L=0;r[L++]=s,r[L++]=o,r[L++]=i,r[L++]=a,r[L++]=E,r[L++]=b,r[L++]=C,r[L++]=B}var Yn=Vn(co,{counterRight:!1,counterLength:4,allowShortKeys:!1}),Ta=Vn(co,{counterRight:!1,counterLength:8,extendNonceFn:Ra,allowShortKeys:!1});var Aa=new Uint8Array(16),io=(t,e)=>{t.update(e);let n=e.length%16;n&&t.update(Aa.subarray(n))},Ia=new Uint8Array(32);function ao(t,e,n,r,s){s!==void 0&&J(s,void 0,"AAD");let o=t(e,n,Ia),i=to(r.length,s?s.length:0,!0),a=oo.create(o);s&&io(a,s),io(a,r),a.update(i);let c=a.digest();return xe(o,i),c}var lo=t=>(e,n,r)=>({encrypt(o,i){let a=o.length;i=Fn(a+16,i,!1),i.set(o);let c=i.subarray(0,-16);t(e,n,c,c,1);let l=ao(t,e,n,c,r);return i.set(l,a),xe(l),i},decrypt(o,i){i=Fn(o.length-16,i,!1);let a=o.subarray(0,-16),c=o.subarray(-16),l=ao(t,e,n,a,r);if(!eo(c,l))throw new Error("invalid tag");return i.set(o.subarray(0,-16)),t(e,n,i,i,1),xe(l),i}}),Zd=Kn({blockSize:64,nonceLength:12,tagLength:16},lo(Yn)),Yd=Kn({blockSize:64,nonceLength:24,tagLength:16},lo(Ta));function fo(t,e,n){return Ie(t),n===void 0&&(n=new Uint8Array(t.outputLen)),ve(t,n,e)}var Xn=Uint8Array.of(0),uo=Uint8Array.of();function po(t,e,n,r=32){Ie(t),ie(r,"length");let s=t.outputLen;if(r>255*s)throw new Error("Length must be <= 255*HashLen");let o=Math.ceil(r/s);n===void 0?n=uo:P(n,void 0,"info");let i=new Uint8Array(o*s),a=ve.create(t,e),c=a._cloneInto(),l=new Uint8Array(a.outputLen);for(let d=0;d<o;d++)Xn[0]=d+1,c.update(d===0?uo:l).update(n).update(Xn).digestInto(l),i.set(l,s*d),a._cloneInto(c);return a.destroy(),c.destroy(),ge(l,Xn),i.slice(0,r)}function ho(t){return t instanceof Uint8Array||ArrayBuffer.isView(t)&&t.constructor.name==="Uint8Array"}function $a(t){if(!ho(t))throw new Error("Uint8Array expected")}function mo(t,e){return Array.isArray(e)?e.length===0?!0:t?e.every(n=>typeof n=="string"):e.every(n=>Number.isSafeInteger(n)):!1}function ft(t,e){if(typeof e!="string")throw new Error(`${t}: string expected`);return!0}function er(t){if(!Number.isSafeInteger(t))throw new Error(`invalid integer: ${t}`)}function Qn(t){if(!Array.isArray(t))throw new Error("array expected")}function Gt(t,e){if(!mo(!0,e))throw new Error(`${t}: array of strings expected`)}function Oa(t,e){if(!mo(!1,e))throw new Error(`${t}: array of numbers expected`)}function Ca(...t){let e=o=>o,n=(o,i)=>a=>o(i(a)),r=t.map(o=>o.encode).reduceRight(n,e),s=t.map(o=>o.decode).reduce(n,e);return{encode:r,decode:s}}function La(t){let e=typeof t=="string"?t.split(""):t,n=e.length;Gt("alphabet",e);let r=new Map(e.map((s,o)=>[s,o]));return{encode:s=>(Qn(s),s.map(o=>{if(!Number.isSafeInteger(o)||o<0||o>=n)throw new Error(`alphabet.encode: digit index outside alphabet "${o}". Allowed: ${t}`);return e[o]})),decode:s=>(Qn(s),s.map(o=>{ft("alphabet.decode",o);let i=r.get(o);if(i===void 0)throw new Error(`Unknown letter: "${o}". Allowed: ${t}`);return i}))}}function Ba(t=""){return ft("join",t),{encode:e=>(Gt("join.decode",e),e.join(t)),decode:e=>(ft("join.decode",e),e.split(t))}}function Na(t,e="="){return er(t),ft("padding",e),{encode(n){for(Gt("padding.encode",n);n.length*t%8;)n.push(e);return n},decode(n){Gt("padding.decode",n);let r=n.length;if(r*t%8)throw new Error("padding: invalid, string should have whole number of bytes");for(;r>0&&n[r-1]===e;r--)if((r-1)*t%8===0)throw new Error("padding: invalid, string has too much padding");return n.slice(0,r)}}}var yo=(t,e)=>e===0?t:yo(e,t%e),jt=(t,e)=>t+(e-yo(t,e)),Jn=(()=>{let t=[];for(let e=0;e<40;e++)t.push(2**e);return t})();function go(t,e,n,r){if(Qn(t),e<=0||e>32)throw new Error(`convertRadix2: wrong from=${e}`);if(n<=0||n>32)throw new Error(`convertRadix2: wrong to=${n}`);if(jt(e,n)>32)throw new Error(`convertRadix2: carry overflow from=${e} to=${n} carryBits=${jt(e,n)}`);let s=0,o=0,i=Jn[e],a=Jn[n]-1,c=[];for(let l of t){if(er(l),l>=i)throw new Error(`convertRadix2: invalid data word=${l} from=${e}`);if(s=s<<e|l,o+e>32)throw new Error(`convertRadix2: carry overflow pos=${o} from=${e}`);for(o+=e;o>=n;o-=n)c.push((s>>o-n&a)>>>0);let d=Jn[o];if(d===void 0)throw new Error("invalid carry");s&=d-1}if(s=s<<n-o&a,!r&&o>=e)throw new Error("Excess padding");if(!r&&s>0)throw new Error(`Non-zero padding: ${s}`);return r&&o>0&&c.push(s>>>0),c}function Pa(t,e=!1){if(er(t),t<=0||t>32)throw new Error("radix2: bits should be in (0..32]");if(jt(8,t)>32||jt(t,8)>32)throw new Error("radix2: carry overflow");return{encode:n=>{if(!ho(n))throw new Error("radix2.encode input should be Uint8Array");return go(Array.from(n),8,t,!e)},decode:n=>(Oa("radix2.decode",n),Uint8Array.from(go(n,t,8,e)))}}var Da=typeof Uint8Array.from([]).toBase64=="function"&&typeof Uint8Array.fromBase64=="function",Ma=(t,e)=>{ft("base64",t);let n=e?/^[A-Za-z0-9=_-]+$/:/^[A-Za-z0-9=+/]+$/,r=e?"base64url":"base64";if(t.length>0&&!n.test(t))throw new Error("invalid base64");return Uint8Array.fromBase64(t,{alphabet:r,lastChunkHandling:"strict"})},bo=Da?{encode(t){return $a(t),t.toBase64()},decode(t){return Ma(t,!1)}}:Ca(Pa(6),La("ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/"),Na(6),Ba(""));var lu=new TextDecoder("utf-8"),wo=new TextEncoder,xo=1,Eo=4294967295,So=65536;function vo(t,e){let n=Jr.getSharedSecret(t,re("02"+e)).subarray(1,33);return fo(ce,n,wo.encode("nip44-v2"))}function Ua(t,e){let n=po(ce,t,e,76);return{chacha_key:n.subarray(0,32),chacha_nonce:n.subarray(32,44),hmac_key:n.subarray(44,76)}}function Ha(t){if(!Number.isSafeInteger(t)||t<1)throw new Error("expected positive integer");if(t<=32)return 32;let e=2**(Math.floor(Math.log2(t-1))+1),n=e<=256?32:e/8;return n*(Math.floor((t-1)/n)+1)}function qa(t){if(!Number.isSafeInteger(t)||t<xo||t>65535)throw new Error("invalid plaintext size: must be between 1 and 65535 bytes");let e=new Uint8Array(2);return new DataView(e.buffer).setUint16(0,t,!1),e}function Ga(t){if(!Number.isSafeInteger(t)||t<So||t>Eo)throw new Error("invalid plaintext size: must be between 65536 and 4294967295 bytes");let e=new Uint8Array(4);return new DataView(e.buffer).setUint32(0,t,!1),e}function ja(t){let e=wo.encode(t),n=e.length;if(n<xo||n>Eo)throw new Error("invalid plaintext size: must be between 1 and 4294967295 bytes");let r=n>=So?Z(new Uint8Array([0,0]),Ga(n)):qa(n),s=new Uint8Array(Ha(n)-n);return Z(r,e,s)}function za(t,e,n){if(n.length!==32)throw new Error("AAD associated data must be 32 bytes");let r=Z(n,e);return ve(ce,t,r)}function ko(t,e,n=he(32)){let{chacha_key:r,chacha_nonce:s,hmac_key:o}=Ua(e,n),i=ja(t),a=Yn(r,s,i),c=za(o,a,n);return bo.encode(Z(new Uint8Array([2]),n,a,c))}var Ya=3e3,Xa=1e4,Ja=1200,Qa=8e3,zt=class{constructor(e,n,r,s){this.relay=e;this.owner=r;this.log=s;this.key=vo(n,r),this.agent=it(n)}key;agent;queue=[];timer;refused=!1;seq=0;send(e){this.queue.push({seq:++this.seq,...e}),this.timer??=setTimeout(()=>void this.flush(),Ja)}async flush(){this.timer&&clearTimeout(this.timer),this.timer=void 0;let e=this.queue.splice(0);if(!e.length)return;let n=JSON.stringify(e.length===1?e[0]:{kind:"batch",payload:{events:e}});try{await this.relay.publish({kind:24200,created_at:Math.floor(Date.now()/1e3),content:ko(n,this.key),tags:[["p",this.owner],["agent",this.agent],["frame","telemetry"]]}),this.refused&&this.log("activity frames are getting through again"),this.refused=!1}catch(r){this.refused||this.log(`couldn\'t send an activity frame: ${r.message}`),this.refused=!0}}},Kt=class{constructor(e,n){this.path=e;this.observer=n;try{Fa(e)&&Va(e).size>2*1024*1024&&Za(e,`${Wa(e,"utf8").split(`\n`).slice(-Ya).join(`\n`)}`)}catch{}}write(e){try{Ka(this.path,`${JSON.stringify(e)}\n`)}catch{}}start(e){let n=`${Date.now().toString(36)}-${e.eventId.slice(0,8)}`,r=this.observer,s=()=>new Date().toISOString(),o=(f,y)=>r?.send({kind:f,turnId:n,channelId:e.channel,timestamp:s(),...y&&{payload:y}}),i=f=>o("acp_read",{jsonrpc:"2.0",method:"session/update",params:{sessionId:n,update:f}}),a,c=0,l=f=>{a&&i({sessionUpdate:"tool_call_update",toolCallId:a,status:f}),a=void 0};this.write({turn:n,at:Date.now(),type:"start",channel:e.channel,...e.root&&{root:e.root},text:be(e.request,300)}),r?.send({kind:"turn_started",turnId:n,channelId:e.channel,timestamp:s(),startedAt:s(),payload:{source:"mention",triggeringEventIds:[e.eventId],...e.root&&{threadRootEventId:e.root}}});let d=setInterval(()=>o("turn_liveness"),Xa);d.unref();let u=f=>{let y=Un(f);l("completed"),a=`${n}-${++c}`;let S=Ts(f);i({sessionUpdate:"tool_call",toolCallId:a,title:y.slice(0,200),kind:S,status:"in_progress",...f.target&&{rawInput:{target:f.target}},...(S==="read"||S==="edit")&&f.target&&{locations:[{path:f.target}]}})},m=f=>{this.write({turn:n,at:Date.now(),type:"step",text:Un(f)}),u(f)};return{tool:(f,y)=>m(dt(f,y,e.labels)),step:m,thought:f=>{f.trim()&&(this.write({turn:n,at:Date.now(),type:"thought",text:f.slice(0,4e3)}),u(vs(f)),i({sessionUpdate:"agent_thought_chunk",content:{type:"text",text:f.slice(0,Qa)}}))},end:async(f,y)=>{clearInterval(d),l(f==="done"?"completed":"failed"),this.write({turn:n,at:Date.now(),type:"end",outcome:f,...y&&{error:be(y,500)}}),o(f==="error"?"turn_error":"turn_completed",f==="error"?{error:be(y??"failed",2e3)}:f==="stopped"?{outcome:"stopped"}:void 0),await r?.flush()}}}};import{readFileSync as sc}from"node:fs";import{createInterface as oc}from"node:readline";import{readFileSync as ec}from"node:fs";import{homedir as tc}from"node:os";import{join as nc}from"node:path";function _o(){let t=ec(nc(tc(),".databrickscfg"),"utf8"),e="",n={};for(let r of t.split(`\n`)){let s=r.trim(),o=/^\\[(.+)\\]$/.exec(s);if(o){e=o[1];continue}let i=/^([a-z_]+)\\s*=\\s*(.*)$/.exec(s);i&&e==="DEFAULT"&&(n[i[1]]=i[2])}if(!n.host||!n.token)throw new Error("The Sandbox has no Databricks credential.");return{host:n.host.replace(/\\/+$/,""),token:n.token}}async function rc(t){let e=new AbortController,n=setTimeout(()=>e.abort(new DOMException("Timed out","TimeoutError")),t.timeoutMs??6e4),r=()=>e.abort(t.signal?.reason);t.signal?.addEventListener("abort",r,{once:!0});try{let s=await fetch(t.url,{method:t.method??"GET",...t.headers&&{headers:t.headers},...t.body!==void 0&&{body:t.body},signal:e.signal}),o={};s.headers.forEach((a,c)=>o[c.toLowerCase()]=a);let i="";if(s.body){let a=new TextDecoder,c=s.body.getReader();for(;;){let{done:d,value:u}=await c.read();if(d)break;let m=a.decode(u,{stream:!0});i+=m,t.onBody?.(m)}let l=a.decode();l&&(i+=l,t.onBody?.(l))}return{status:s.status,headers:o,body:i}}finally{clearTimeout(n),t.signal?.removeEventListener("abort",r)}}function pt(t){let{host:e}=_o(),n=new ct({host:e,transport:rc,token:async()=>_o().token}),r={status:"connected",...t&&{workspaceId:t},profile:{name:"DEFAULT",host:e,...t&&{workspaceId:t}},user:{userName:""},profiles:[]};return{version:1,snapshot:()=>r,subscribe:()=>()=>{},client:()=>n,ready:async()=>n,workspaceUrl:o=>new URL(o,e).toString(),profiles:()=>[],openSettings:()=>{},signIn:async()=>{},preferences:{get:()=>{},set:()=>{},subscribe:()=>()=>{}}}}var Ro={type:"object",properties:{}};function ic(t){let{server:e}=t,n=ut(e);return t.login?{name:`${n}__log_in`,description:`[${e.label}] Not available yet: your owner hasn\'t logged in to ${e.label}. If you need it, give them this link to log in, then try again: ${t.login}`,parameters:Ro,run:async()=>`Ask your owner to log in to ${e.label} at ${t.login}, then try again.`}:{name:`${n}__unavailable`,description:`[${e.label}] Didn\'t start this time: ${t.message.slice(0,300)}`,parameters:Ro,run:async()=>`${e.label} isn\'t available right now: ${t.message}`}}async function tr(t,e){let n=JSON.parse(sc(t,"utf8")),r=Ws(n.tools),s=pt(n.workspaceId),o=await Xs(s,r,e),i=new Set;return[...Ys(s,r),...o.tools,...o.failures.map(ic)].map(a=>{let c=a.name.slice(0,Bn);for(let l=2;i.has(c);l++)c=`${a.name.slice(0,Bn-4)}_${l}`;return i.add(c),c===a.name?a:{...a,name:c}})}function To(t,e=n=>console.error(n)){let n=tr(t,AbortSignal.timeout(12e4)).catch(a=>(e(`tools bridge: couldn\'t list the tools: ${a.message??a}`),[])),r=new Map,s=a=>process.stdout.write(`${JSON.stringify({jsonrpc:"2.0",...a})}\n`),o=(a,c=!1)=>({content:[{type:"text",text:a}],...c&&{isError:c}});async function i(a){let{id:c,method:l,params:d}=a;if(l==="notifications/cancelled")return r.get(d?.requestId)?.abort();if(c!==void 0)switch(l){case"initialize":return s({id:c,result:{protocolVersion:d?.protocolVersion??"2025-06-18",capabilities:{tools:{}},serverInfo:{name:"databricks",version:"1"}}});case"ping":return s({id:c,result:{}});case"tools/list":return s({id:c,result:{tools:(await n).map(u=>({name:u.name,description:u.description,inputSchema:u.parameters}))}});case"tools/call":{let u=(await n).find(f=>f.name===d?.name);if(!u)return s({id:c,result:o(`There\'s no Databricks tool named ${String(d?.name)}.`,!0)});let m=new AbortController;r.set(c,m);try{return s({id:c,result:o(await u.run(d?.arguments??{},m.signal))})}catch(f){return s({id:c,result:o(`Error: ${f.message??f}`,!0)})}finally{r.delete(c)}}default:return s({id:c,error:{code:-32601,message:`Unknown method: ${l}`}})}}return new Promise(a=>{let c=oc({input:process.stdin});c.on("line",l=>{let d;try{d=JSON.parse(l)}catch{return}i(d).catch(u=>d.id!==void 0&&s({id:d.id,error:{code:-32603,message:u.message??String(u)}}))}),c.on("close",()=>{for(let l of r.values())l.abort();a()})})}import{spawn as pc}from"node:child_process";import{mkdirSync as Co,rmSync as Lo,writeFileSync as Yt}from"node:fs";import{join as gc}from"node:path";import{createInterface as hc}from"node:readline";import{chmodSync as ac,existsSync as Ao,mkdirSync as cc,readFileSync as lc,renameSync as dc,rmSync as Iu,statSync as uc,writeFileSync as Io}from"node:fs";import{homedir as fc}from"node:os";import{join as se}from"node:path";var ue=process.env.BUZZ_AGENT_DIR??se(fc(),".buzz","agent"),Ft=process.env.BUZZ_AGENT_RUN_DIR??(process.env.BUZZ_AGENT_DIR?se(ue,"run"):"/tmp/buzz-agent"),G={key:se(ue,"key.json"),config:se(ue,"config.json"),state:se(ue,"state.json"),turns:se(Ft,"turns"),pid:se(Ft,"runner.pid"),started:se(Ft,"started"),log:se(ue,"runner.log"),status:se(ue,"status.json"),activity:se(ue,"activity.jsonl"),awake:se(ue,"awake"),runs:se(ue,"runs")};function nr(){for(let t of[ue,Ft,G.turns,G.runs])cc(t,{recursive:!0,mode:448});Ao(G.started)||Io(G.started,"")}function $o(){try{return new Date(uc(G.started).mtimeMs).toISOString()}catch{return}}function rr(t,e){try{return JSON.parse(lc(t,"utf8"))}catch{return e}}function Wt(t,e,n=384){let r=`${t}.tmp`;Io(r,`${JSON.stringify(e,null,2)}\n`,{mode:n}),dc(r,t),ac(t,n)}var Vt=()=>rr(G.config,void 0),sr=()=>({sessions:{},since:0,handled:[],...rr(G.state,{})}),or=t=>Wt(G.state,{...t,handled:t.handled.slice(-500)});function Zt(){let t=rr(G.key,void 0);return t?.secret&&/^[0-9a-f]{64}$/.test(t.secret)?Uint8Array.from(Buffer.from(t.secret,"hex")):void 0}function Oo(t){if(Ao(G.key))throw new Error("This Sandbox already has an agent key.");Wt(G.key,{secret:Buffer.from(t).toString("hex")})}var Pe=t=>se(G.turns,Buffer.from(t).toString("base64url"));var mc=t=>/no conversation found|no (saved )?session|session[^.]* not found|thread[^.]* not found|no rollout found/i.test(t);async function ir(t){try{return await Bo(t)}catch(e){if(!t.session||t.signal.aborted||!mc(e.message))throw e;let{session:n,...r}=t;return Bo(r)}}function Bo(t){let{harness:e}=t,n=crypto.randomUUID(),r=gc(G.runs,`${Date.now().toString(36)}-${n.slice(0,8)}`);Co(r,{recursive:!0,mode:448});let s=bs(r),o=t.session?.id??(e==="codex"?void 0:crypto.randomUUID()),i=e==="codex"&&!t.session?`<instructions>\n${t.system}\n</instructions>\n\n${t.prompt}`:t.prompt;Yt(s.prompt,i,{mode:384}),Yt(s.system,t.system,{mode:384});let a=Dn(t.tools?.tools)?{runner:process.argv[1]}:void 0;if(a)for(let l of Pn(e,s,a.runner,t.tools))Yt(l.path,l.content,{mode:384});let c=ws({harness:e,model:t.model,permissions:t.permissions,session:o?{id:o,resume:!!t.session}:void 0,files:s,...a&&{tools:a}});return Co(Bt,{recursive:!0}),new Promise((l,d)=>{let u=pc("bash",["-lc",`cd \'${Bt}\' && ${c}`],{detached:!0,stdio:["ignore","pipe","pipe"]});Yt(t.pidFile,String(u.pid??""),{mode:384});let m="",f,y,S,E="",b=!1,C=()=>{if(u.pid){try{process.kill(-u.pid,"SIGTERM")}catch{}setTimeout(()=>{try{process.kill(-u.pid,"SIGKILL")}catch{}},3e3).unref()}};t.signal.addEventListener("abort",C,{once:!0}),hc({input:u.stdout}).on("line",B=>{let L=xs(e,B);L&&(L.session&&(!b||L.session!==o)&&(o=L.session,b=!0,t.onSession?.(o)),L.thought&&t.onThought?.(L.thought),L.step&&(f&&t.onThought?.(f),f=void 0,t.onStep?.(L.step.tool,L.step.target)),L.text&&(m=f=L.text),L.final!==void 0&&(y=L.final),L.error&&(S=L.error))}),u.stderr.on("data",B=>E=`${E}${B}`.slice(-8e3)),u.on("close",B=>{if(t.signal.removeEventListener("abort",C),Lo(t.pidFile,{force:!0}),Lo(r,{recursive:!0,force:!0}),t.signal.aborted)return d(t.signal.reason??new DOMException("Aborted","AbortError"));if(S)return d(new Error(`${Ne(e)}: ${S}`));let L=(y??m).trim();if(B!==0||!L)return d(new Error(`${Ne(e)} stopped (exit ${B})${Mn(E)?`: ${Mn(E)}`:""}.`));if(!o)return d(new Error(`${Ne(e)} didn\'t report its session.`));l({text:L,session:o})})})}function yc(t,e){let n=t.root;return{kind:20002,created_at:Math.floor(Date.now()/1e3),content:"",tags:[["h",t.channel],...t.topLevel?[]:[...n===e.id?[]:[["e",n,"","root"]],["e",e.id,"","reply"]]]}}var Xt=class{constructor(e,n){this.publish=e;this.log=n}pulses=new Map;start(e,n){let r=e.topLevel?e.channel:e.key,s=this.pulses.get(r);if(!s){let a={turns:0,stop:()=>{}};a.stop=this.pulse(e,n,()=>{this.pulses.get(r)===a&&this.pulses.delete(r)}),this.pulses.set(r,a),s=a}let o=s;o.turns++;let i=!1;return()=>{i||(i=!0,--o.turns===0&&o.stop())}}pulse(e,n,r){let s=Date.now(),o=!1,i=0,a=()=>{clearInterval(l),r()},c=()=>{if(Date.now()-s>=18e5)return a();o||(o=!0,this.publish(yc(e,n)).then(()=>{o=!1,i=0},d=>{o=!1,!(++i<3)&&(a(),this.log(`stopped showing typing in ${e.key}: ${d.message}`))}))},l=setInterval(c,3e3);return l.unref?.(),c(),a}};import{createHash as bc,randomUUID as wc}from"node:crypto";var xc=t=>bc("sha256").update(t).digest("hex"),Jt=class{constructor(e,n,r,s){this.url=e;this.secretKey=n;this.authTag=r;this.log=s;this.base=e.replace(/^ws/,"http").replace(/\\/+$/,"")}base;ready=!1;watching=new Set;closed=!1;sign(e){return rs(e,this.secretKey)}async post(e,n){let r=`${this.base}${e}`,s=this.sign({kind:27235,created_at:Math.floor(Date.now()/1e3),content:"",tags:[["u",r],["method","POST"],["payload",xc(n)],["nonce",wc()]]}),o=await fetch(r,{method:"POST",headers:{authorization:`Nostr ${Buffer.from(JSON.stringify(s)).toString("base64")}`,"content-type":"application/json","x-auth-tag":JSON.stringify(this.authTag)},body:n,signal:AbortSignal.timeout(2e4)}),i=await o.text();if(!o.ok)throw this.ready=!1,Object.assign(new Error(`${o.status} ${i.slice(0,300)}`.trim()),{status:o.status});return this.ready=!0,JSON.parse(i)}async publish(e){let n=e.tags.filter(o=>o[0]!=="auth"&&o[0]!=="ms");n.some(o=>o[0]==="h")&&n.push(["ms",String(Date.now()%1e3)]),n.push([...this.authTag]);let r=this.sign({...e,tags:n}),s=await this.post("/events",JSON.stringify(r));if(!s.accepted&&!s.message?.startsWith("duplicate"))throw new Error(s.message||"The community refused the event.");return r}async query(e){if(!e.length)return[];let n=await this.post("/query",JSON.stringify(e));return Array.isArray(n)?n:[]}watch(e,n,r,s=3e3){let o=new Set,i=n,a=0,c,l=async()=>{if(this.closed)return;let d=s;try{let u=await this.query([{...e,since:i-5}]);a=0;for(let m of u.sort((f,y)=>f.created_at-y.created_at))o.has(m.id)||(o.add(m.id),i=Math.max(i,m.created_at),r(m));if(o.size>2e3)for(let m of[...o].slice(0,1e3))o.delete(m)}catch(u){let m=u.message??String(u),f=/retry in (\\d+)s/.exec(m);d=f?Number(f[1])*1e3:Math.min(6e4,s*2**++a),this.log(`poll failed (${m.slice(0,160)}); next in ${Math.round(d/1e3)}s`)}this.closed||(c=setTimeout(()=>void l(),d),this.watching.add(c))};return l(),()=>{c&&clearTimeout(c)}}close(){this.closed=!0;for(let e of this.watching)clearTimeout(e)}};var Qt=30*6e4,Po="A Databricks agent in its own Databricks Sandbox.";function X(t){try{Ae(G.log)&&No(G.log).size>5*1024*1024&&_c(G.log,0)}catch{}vc(G.log,`${new Date().toISOString()} ${t}\n`)}function lr(t){try{return process.kill(t,0),en(`/proc/${t}/cmdline`,"utf8").includes("serve")}catch{return!1}}var cr=()=>{let t=Number(Ae(G.pid)?en(G.pid,"utf8"):"");return Number.isInteger(t)&&t>0&&lr(t)?t:void 0};function De(t,e){return t===void 0&&(console.error(`No ${e} yet.`),process.exit(2)),t}var Do=(t,e)=>new Jt(t.relay,e,t.authTag,X),dr=t=>t.omnigentAgent||Os,Rc=t=>t.kind==="genie"?"Genie":t.kind==="omnigent"?`Omnigent \\xB7 ${t.omnigentLabel??Nt(dr(t))}`:Ne(t.harness),Tc=["<omnigent-session>","You are running as an Omnigent agent in an Omnigent session on a Databricks Sandbox. Your owner can open this session in Omnigent and see your work.","Your final message in each turn is posted to the Buzz conversation as your reply, so make it the answer itself, written for the people there. You don\'t have Buzz\'s own tools in this session.","Never print secrets into the conversation.","</omnigent-session>"].join(`\n`);function tn(t,e){return[`<identity>You are ${t.name} (pubkey ${e}), an agent in Buzz, a chat app, owned by ${t.owner}.</identity>`,"People mention you in channels, threads and Solo chats; each mention is a turn. Messages in the conversation you haven\'t seen arrive with the mention, as JSON. Your final message is posted as your reply in that conversation: make it the answer itself, in Markdown, written for the people there, without saying that you\'re posting it.",t.kind==="omnigent"?Tc:Es(t.harness,"standard",t.kind==="sandbox"?t.tools??[]:[]),ys,t.instructions.trim()?`<agent-instructions>\n${t.instructions.trim()}\n</agent-instructions>`:""].filter(Boolean).join(`\n\n`)}async function Ac(t,e){let n=new Map;if(!e.length)return n;for(let r of await t.query([{kinds:[0],authors:e,limit:e.length*2}]).catch(()=>[]))try{let s=JSON.parse(r.content),o=s.display_name||s.name;o&&!n.has(r.pubkey)&&n.set(r.pubkey,String(o).slice(0,80))}catch{}return n}var Mo=t=>({tools:t.tools??[],...t.workspaceId&&{workspaceId:t.workspaceId}});async function Uo(t,e,n,r,s){let o=pt(t.workspaceId),i=t.genieSpace;if(!i){s?.step({tool:"Asking Genie One",target:e});let f=0,y=await new Fe(o).ask(e,{...n&&{conversationId:n},signal:r,onProgress:b=>{for(let C of b.slice(f))s?.step(ks(C));f=Math.max(f,b.length)},onRetry:b=>{s?.step(_s(b)),b.restarted&&(f=0)}}),S=[us(y)];y.status==="incomplete"&&S.push("_Genie One stopped early; this may be partial._");let E=y.sql[y.sql.length-1];return E&&S.push(`\\`\\`\\`sql\n${E.trim()}\n\\`\\`\\``),y.deepLink&&S.push(`[Explore in Databricks](${y.deepLink})`),{text:S.filter(Boolean).join(`\n\n`)||"Genie One had no answer.",conversation:y.conversationId}}let a=await o.ready(),c=t.genieLabel??"Genie";s?.step({tool:`Asking ${c}`,target:e});let l="",d=await new fe(a).answer(i,e,{...n&&{conversationId:n},signal:r,onUpdate:f=>{f.status!==l&&(l=f.status,s?.step(Rs(c,l)))}}),u=[];d.text&&u.push(d.text),d.result?.columns.length&&u.push(Xe(d.result)),d.sql&&u.push(`\\`\\`\\`sql\n${d.sql.trim()}\n\\`\\`\\``),d.message.status!=="COMPLETED"&&u.push(`Genie stopped with status ${d.message.status}${d.error?`: ${d.error}`:""}.`),d.suggestions.length&&u.push(`_You could also ask:_ ${d.suggestions.slice(0,3).map(f=>`\\u201C${f}\\u201D`).join(" \\xB7 ")}`);let m=o.workspaceUrl(fe.webPath(i,d.message.conversation_id));return m&&u.push(`[Open in Genie](${m})`),{text:u.join(`\n\n`)||"Genie had no answer.",conversation:d.message.conversation_id}}async function Ho(t,e){let n=await pt(t.workspaceId).ready(),r=new Pt(n,t.workspaceId),s=await r.turn({...e.session&&{session:e.session},agent:dr(t),title:e.title,text:i=>i?`${e.preamble}\n\n${e.prompt}`:e.prompt,signal:e.signal,onStep:i=>{X(`  ${i.tool}${i.target?` \\xB7 ${i.target}`:""}`),e.activity?.step(i)},onThought:i=>e.activity?.thought(i),...e.onSession&&{onSession:e.onSession}}),o=s.fresh&&!s.waiting?`\n\n[Open in Omnigent](${r.webUrl(s.session)})`:"";return{text:`${s.text}${o}`,session:s.session}}var qo=t=>`${Pe(t)}.omnigent`;async function Ic(){nr();let t=De(Vt(),"config.json"),e=De(Zt(),"agent key"),n=it(e);Ye(G.pid,String(process.pid));let r=sr(),s=new Set(r.handled),o=new Mt,i=new Map,a=new Map,c=Date.now(),l=0,d=Date.now(),u;X(`starting as ${n.slice(0,12)}\\u2026 (${Rc(t)}, ${t.availability})`);let m=Do(t,e),f=new Kt(G.activity,new zt(m,e,t.owner,X)),y=new Xt(x=>m.publish(x),X),S=Vs(t.tools??[]),E=()=>or({...r,handled:[...s]}),b=()=>Wt(G.status,{pid:process.pid,pubkey:n,connected:m.ready,active:l,startedAt:new Date(c).toISOString(),lastActivity:new Date(d).toISOString(),since:r.since,...u&&{lastError:u}},420);async function C(x){let p=i.get(x);if(p&&Date.now()-p.at<10*6e4)return p.kind;let[h]=await m.query([{kinds:[39e3],"#d":[x],limit:1}]),g=Ds(h);return i.set(x,{at:Date.now(),kind:g}),g}async function B(x,p,h){for(let g of Hs(p))await m.publish(qs({conversation:x,content:g,authTag:t.authTag,...h&&{notify:h}}))}async function L(x,p,h,g){let v=r.sessions[p.key];if(t.kind==="genie"){let I=t.genieSpace?`genie:${t.genieSpace}`:"genie-one",N=v?.harness===I?v.id:void 0,j=await Uo(t,Dt(x.content)||"What can I ask you about?",N,h,g);return r.sessions[p.key]={harness:I,id:j.conversation,at:x.created_at},j.text}let _=t.kind==="omnigent"?`omnigent:${dr(t)}`:t.harness,k=v?.harness===_?v:void 0,w=Ms(p),T=(await m.query(w)).filter(I=>I.id!==x.id&&Ve.includes(I.kind)&&I.created_at<=x.created_at&&I.tags.some(N=>N[0]==="h"&&N[1]===p.channel)).filter(I=>I.created_at>(k?.at??0)&&I.pubkey!==n).sort((I,N)=>I.created_at-N.created_at),A=T.slice(-12),U=Us({event:x,conversation:p,agent:n,context:A,total:T.length,names:await Ac(m,[...new Set([x.pubkey,...A.map(I=>I.pubkey)])]),scope:t.scope});if(process.env.BUZZ_RUNNER_ECHO==="1")return`echo: ${Dt(x.content)} | ${p.key} | context ${A.length} | ${U.length} chars`;if(t.kind==="omnigent"){let I=qo(p.key);Ye(I,k?.id??"");let N=new AbortController,j=setInterval(()=>Ae(`${Pe(p.key)}.stopped`)&&N.abort(new DOMException("Stopped","AbortError")),1e3);try{let V=await Ho(t,{...k&&{session:k.id},title:`Buzz \\xB7 ${t.name} \\xB7 #${p.channel}`,prompt:U,preamble:tn(t,n),signal:AbortSignal.any([h,N.signal]),activity:g,onSession:q=>{r.sessions[p.key]={harness:_,id:q,at:k?.at??0},Ye(I,q),E()}});return r.sessions[p.key]={harness:_,id:V.session,at:x.created_at},V.text}finally{clearInterval(j),ar(I,{force:!0})}}let M=await ir({harness:t.harness,model:t.model,permissions:"standard",...k&&{session:{id:k.id}},prompt:U,system:tn(t,n),signal:h,pidFile:Pe(p.key),...t.tools?.length&&{tools:Mo(t)},onStep:(I,N)=>{X(`  ${I}${N?` \\xB7 ${N}`:""}`),g.tool(I,N)},onThought:I=>g.thought(I),onSession:I=>{r.sessions[p.key]={harness:t.harness,id:I,at:k?.at??0},E()}});return r.sessions[p.key]={harness:t.harness,id:M.session,at:x.created_at},M.text}async function W(x,p){let h=`${Pe(p.key)}.stopped`;ar(h,{force:!0}),l++,d=Date.now(),b(),X(`mention ${x.id.slice(0,8)} in ${p.key}`);let g=f.start({eventId:x.id,channel:p.channel,...p.key!==p.channel&&{root:p.root},request:Dt(x.content),labels:S}),v=y.start(p,x),_="done";try{let k=await L(x,p,AbortSignal.timeout(Qt),g);await B(p,k),X(`replied in ${p.key}`)}catch(k){Ae(h)?(_="stopped",X(`stopped in ${p.key}`)):(u=k.message??String(k),_="error",X(`turn failed: ${u}`),await B(p,`I couldn\'t finish that: ${u}`,t.owner).catch(w=>X(`couldn\'t post the failure: ${w.message}`)))}finally{v(),await g.end(_,_==="error"?u:void 0),ar(h,{force:!0}),l--,d=Date.now(),r.since=Math.max(r.since,x.created_at),E(),b()}}function z(x){if(!(s.has(x.id)||!ss(x)||!Ns(x,n))){if(s.add(x.id),!Ps(x,t.owner)){X(`ignored ${x.id.slice(0,8)}: not from the owner`),K(x).catch(p=>X(`couldn\'t tell ${x.pubkey.slice(0,8)} that only the owner\'s requests are taken: ${p.message}`));return}F=F.then(async()=>{let p=x.tags.find(v=>v[0]==="h")?.[1];if(!p)return;let h=Gn(x,t.scope,await C(p).catch(()=>({solo:!1})));if(!h)return;let g=(a.get(h.key)??Promise.resolve()).then(()=>W(x,h));a.set(h.key,g.catch(()=>{}))})}}let F=Promise.resolve();async function K(x){if(x.pubkey===n)return;let p=x.tags.find(g=>g[0]==="h")?.[1];if(!p)return;let h=Gn(x,t.scope,await C(p).catch(()=>({solo:!1})));!h||!o.take(n,x.pubkey,h.key)||(await B(h,Gs,[x.pubkey,t.owner]),X(`told ${x.pubkey.slice(0,8)} in ${h.key} that only the owner\'s requests are taken`))}let O=JSON.stringify([t.name,t.picture??""]),H=async()=>{if(r.profile!==O)try{await m.publish(jn({name:t.name,...t.picture&&{picture:t.picture},about:Po,authTag:t.authTag})),r.profile=O,E(),X("published the profile")}catch(x){X(`profile not published yet: ${x.message}`),setTimeout(()=>void H(),6e4).unref()}};H();let D=r.since?r.since-5:Math.floor(Date.now()/1e3)-60;m.watch({kinds:Ve,"#p":[n]},D,z),b(),setInterval(b,3e4).unref(),t.availability==="sleep"&&setInterval(()=>{let x=Date.now()-d>t.idleMinutes*6e4,p=Ae(G.awake)?No(G.awake).mtimeMs:0;l||!x||Date.now()-p<10*6e4||(X("idle with the owner\'s Buzz closed; stopping the Sandbox until Buzz wakes it"),E(),m.close(),Ec("databricks",["api","post",`/api/2.0/sandboxes/${t.sandbox}/stop`,"--json","{}"],h=>{h&&X(`couldn\'t stop the Sandbox: ${h.message}`),process.exit(0)}))},6e4).unref(),process.on("SIGTERM",()=>{E(),m.close(),process.exit(0)})}async function $c(){let[t,...e]=process.argv.slice(2);if(t==="mcp"&&(await To(De(e[0],"a tools config")),process.exit(0)),t==="mcp-names"){let n=(await tr(De(e[0],"a tools config"),AbortSignal.timeout(12e4))).map(r=>`,${r.name}`).join("");process.stdout.write(n,()=>process.exit(0));return}switch(nr(),t){case"keygen":{let n=Zt();n||(n=ns(),Oo(n)),console.log(JSON.stringify({pubkey:it(n)}));return}case"profile":{let n=De(Vt(),"config.json");await Do(n,De(Zt(),"agent key")).publish(jn({name:n.name,...n.picture&&{picture:n.picture},about:Po,authTag:n.authTag}));let s=sr();or({...s,profile:JSON.stringify([n.name,n.picture??""])}),console.log("published");return}case"start":{if(cr())return console.log("running");let n=kc(G.log,"a"),r=Sc(process.execPath,[process.argv[1],"serve"],{detached:!0,stdio:["ignore",n,n]});return r.unref(),Ye(G.pid,String(r.pid)),console.log("started")}case"stop":{let n=cr();if(n){process.kill(n,"SIGTERM");for(let r=0;r<50&&lr(n);r++)await new Promise(s=>setTimeout(s,100));lr(n)&&process.kill(n,"SIGKILL")}return console.log(n?"stopped":"not running")}case"interrupt":{let[n="",r=""]=e;for(let s of[`${n}/${r}`,n]){let o=Pe(s);if(Ae(qo(s)))return Ye(`${o}.stopped`,""),console.log("true");let i=Number(Ae(o)?en(o,"utf8"):"");if(i){Ye(`${o}.stopped`,"");try{return process.kill(-i,"SIGTERM"),console.log("true")}catch{}}}return console.log("false")}case"status":{let n=cr(),r=Ae(G.status)?JSON.parse(en(G.status,"utf8")):{},s=n&&r.pid===n?r:{},o=$o();return console.log(JSON.stringify({...s,running:!!n,...o&&{bootedAt:o}}))}case"ask":{let n=De(Vt(),"config.json"),r=e.join(" ")||"Say hello in one short sentence.";if(n.kind==="genie")return console.log((await Uo(n,r,void 0,AbortSignal.timeout(Qt))).text);if(n.kind==="omnigent"){let o=await Ho(n,{title:`Buzz \\xB7 ${n.name} \\xB7 diagnostic`,prompt:r,preamble:tn(n,"diagnostic"),signal:AbortSignal.timeout(Qt)});return console.log(o.text)}let s=await ir({harness:n.harness,model:n.model,permissions:"standard",prompt:r,system:tn(n,"diagnostic"),signal:AbortSignal.timeout(Qt),pidFile:Pe("ask"),...n.tools?.length&&{tools:Mo(n)},onStep:(o,i)=>console.error(`step: ${o}${i?` \\xB7 ${i}`:""}`)});return console.log(s.text)}case"serve":return Ic();default:console.error("usage: runner.mjs keygen|profile|start|serve|stop|interrupt|status|ask|mcp|mcp-names"),process.exit(2)}}$c().catch(t=>{X(`fatal: ${t?.stack??t}`),console.error(t?.message??t),process.exit(1)});\n';
var RUNNER_SHA = "9501f97d840d6085";

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
function genieStatusStep(label, status3) {
  const phrase = {
    SUBMITTED: "sent the question",
    FILTERING_CONTEXT: "finding the right data",
    FETCHING_METADATA: "reading the tables",
    ASKING_AI: "writing the SQL",
    PENDING_WAREHOUSE: "waiting for the SQL warehouse",
    EXECUTING_QUERY: "running the query",
    COMPLETED: "answered"
  };
  return { tool: `Asking ${label}`, target: phrase[status3] ?? humanize(status3.toLowerCase()) };
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
function status2(turn) {
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
  return /* @__PURE__ */ React.createElement("div", { style: { border: "1px solid var(--dbx-border)", borderRadius: 10, padding: "10px 12px" } }, /* @__PURE__ */ React.createElement(Stack, { gap: 8 }, /* @__PURE__ */ React.createElement(Stack, { direction: "row", gap: 8, align: "center", justify: "space-between" }, /* @__PURE__ */ React.createElement(Stack, { direction: "row", gap: 6, align: "center" }, working && /* @__PURE__ */ React.createElement(Spinner, { size: 11 }), /* @__PURE__ */ React.createElement(Text, { size: "sm", weight: 500 }, status2(turn)), /* @__PURE__ */ React.createElement(Text, { size: "xs", tone: "tertiary" }, when(turn.startedAt))), props.openConversation && turn.channelId && /* @__PURE__ */ React.createElement(Button, { size: "sm", variant: "ghost", onClick: () => props.openConversation(turn.channelId, turn.root) }, "Open conversation")), turn.request && /* @__PURE__ */ React.createElement(Text, { size: "sm", tone: "subtle" }, "\u201C", turn.request, "\u201D"), turn.items.length ? /* @__PURE__ */ React.createElement(Stack, { gap: 5 }, turn.items.map((item, index) => /* @__PURE__ */ React.createElement(Item, { key: `${item.at}-${index}`, item }))) : /* @__PURE__ */ React.createElement(Text, { size: "xs", tone: "tertiary" }, working ? "Starting\u2026" : "No steps were recorded."), turn.error && /* @__PURE__ */ React.createElement(Notice, { tone: "danger" }, turn.error)));
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
  let detail2;
  try {
    const parsed = JSON.parse(response.body);
    if (typeof parsed.detail === "string") detail2 = parsed.detail;
  } catch {
  }
  const error = apiError(response);
  if (detail2) error.message = detail2;
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
      const status3 = error.status;
      if (status3 === 404) return { ok: false, reason: "Omnigent isn't on in this workspace. A workspace admin can turn on the Omnigent preview." };
      if (status3 === 401 || status3 === 403) return { ok: false, reason: "Omnigent turned this account away; it may not be enabled for you." };
      return { ok: false, reason: error.message };
    }
  }
  /** The workspace's Omnigent agents that run in its Sandboxes, best known first. */
  async agents(signal) {
    const listed = await this.call("GET", "/v1/agents?limit=200", { ...signal && { signal } });
    const order = Object.keys(KNOWN_AGENTS);
    return (listed.data ?? []).filter((agent) => SANDBOX_HARNESSES.has(agent.harness ?? "")).map((agent) => {
      const known = KNOWN_AGENTS[agent.name];
      const detail2 = known?.detail ?? agent.description ?? void 0;
      return { id: agent.id, name: agent.name, harness: agent.harness ?? "", label: omnigentAgentLabel(agent.name), ...detail2 && { detail: detail2 } };
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

// plugins/agents/src/hosted.tsx
var HOSTED_TYPE_ID = "databricks-hosted";
var AGENT_DIR = `${SANDBOX_HOME}/.buzz/agent`;
var RECORD_PREFIX2 = "bkvarda.databricks-hosted.v1:";
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
var recordKey2 = (pubkey) => `${RECORD_PREFIX2}${pubkey}`;
var pendingKey2 = (community, name) => `${RECORD_PREFIX2}pending:${community}:${name}`;
var parse2 = (raw) => {
  try {
    return raw ? JSON.parse(raw) : void 0;
  } catch {
    return void 0;
  }
};
var randomHex = (bytes2) => [...crypto.getRandomValues(new Uint8Array(bytes2))].map((b) => b.toString(16).padStart(2, "0")).join("");
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
function workspaceOf2(service, profile) {
  return profile && service.forProfile ? service.forProfile(profile) : service;
}
async function sandboxOf(service, record, signal) {
  const client = await workspaceOf2(service, record.config.profile).ready(signal);
  return { client, sandboxes: new Sandboxes(client) };
}
var keepAwake = (client, sandbox, signal) => client.json(`/api/2.0/lakebox/sandboxes/${encodeURIComponent(sandbox)}`, { method: "PATCH", body: { no_autostop: true }, ...signal && { signal } });
async function runner(sandboxes, sandbox, args, signal, timeoutSeconds = 90) {
  const result = await sandboxes.bash(sandbox, `node ${shellQuote(`${AGENT_DIR}/runner.mjs`)} ${args}`, { timeoutSeconds, ...signal && { signal } });
  if (result.exit_code !== 0) throw new Error(`The agent's runner couldn't ${args.split(" ")[0]}: ${(result.stderr || result.stdout || `exit ${result.exit_code}`).trim().slice(-400)}`);
  return (result.stdout ?? "").trim();
}
function shouldRefresh(status3, now = Date.now()) {
  if (!status3?.running || status3.active || !status3.bootedAt) return false;
  const booted = Date.parse(status3.bootedAt);
  const last = Math.max(booted, Date.parse(status3.lastActivity ?? "") || 0);
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
    const status3 = error.status;
    if (status3 !== 400 && status3 !== 404) throw error;
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
    const workspace = workspaceOf2(service, record.config.profile);
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
  const workspaceId = workspaceIdOf(workspaceOf2(service, record.config.profile));
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
  const read = (pubkey) => parse2(storage.get(recordKey2(pubkey)));
  const write = (record) => storage.set(recordKey2(record.pubkey), JSON.stringify(record));
  const records = () => storage.keys().filter((key2) => key2.startsWith(RECORD_PREFIX2) && !key2.includes(":pending:")).map((key2) => parse2(storage.get(key2))).filter((record) => Boolean(record?.pubkey));
  return {
    read,
    records,
    async provision(input) {
      const config = normalizeHosted(input.config);
      const pending = pendingKey2(input.community, input.name);
      const record = parse2(storage.get(pending)) ?? {
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
      await storage.set(pendingKey2(input.community, found.name), null);
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
      await storage.set(recordKey2(input.pubkey), null);
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
      const status3 = await start();
      if (options.refresh === false || record.config.availability !== "always" || !shouldRefresh(status3)) return status3;
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
  const status3 = useConnection(props.service).status;
  const spaces = useAsync(() => genieSpaces(props.service), [props.service, status3]);
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
  const status3 = useConnection(props.service).status;
  const found = useAsync(async () => {
    const omnigent = new Omnigent(await props.service.ready(), workspaceIdOf(props.service));
    const check = await omnigent.check();
    return check.ok ? { agents: await omnigent.agents(), url: omnigent.webUrl() } : { reason: check.reason };
  }, [props.service, status3]);
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
  const status3 = useConnection(workspace).status;
  const available = useAsync(() => cachedList(workspace, "sandbox", async () => new Sandboxes(await workspace.ready()).available()), [workspace, status3]);
  const kind = KIND_CHOICES.find((choice) => choice.id === config.kind) ?? KIND_CHOICES[0];
  const harness = HARNESS_CHOICES.find((choice) => choice.id === config.harness) ?? HARNESS_CHOICES[0];
  const disabled = props.disabled !== void 0 ? { disabled: props.disabled } : {};
  return /* @__PURE__ */ React.createElement(DbxRoot, null, /* @__PURE__ */ React.createElement(Stack, { gap: 14 }, /* @__PURE__ */ React.createElement(NeedsConnection, { service: props.service }), !props.locked && /* @__PURE__ */ React.createElement(Text, { tone: "subtle", size: "sm" }, "Runs in Databricks, in its own Sandbox, so it can answer with Buzz closed, including from your phone. It can't use Buzz's own tools."), available.data === false && /* @__PURE__ */ React.createElement(Notice, { tone: "warning" }, "Databricks Sandbox isn't on in this workspace, and this agent runs in one. An admin can turn on the Sandbox preview."), !props.locked && /* @__PURE__ */ React.createElement(
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
  const status3 = useAsync(() => props.provider.status(props.pubkey), [props.pubkey, nonce]);
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
  const state = status3.data?.state;
  const runnerState = status3.data?.runner;
  const dirty = JSON.stringify(draft) !== JSON.stringify(record.config);
  const left = hoursLeft(runnerState?.bootedAt);
  return /* @__PURE__ */ React.createElement(DbxRoot, { style: { padding: "4px 0 24px" } }, /* @__PURE__ */ React.createElement(Stack, { gap: 16 }, /* @__PURE__ */ React.createElement(
    Notice,
    {
      tone: state === "SANDBOX_STATE_RUNNING" && runnerState?.running === false ? "warning" : "info",
      title: status3.loading && !status3.data ? "Checking\u2026" : stateLabel(state, record.config.availability),
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
    description: "Runs in your Databricks workspace, so it can answer with Buzz closed: Genie, Claude Code, Codex or Pi in its own Sandbox, or an Omnigent agent. No Buzz tools.",
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
var MAX_TOKENS = 16e3;
var MAX_CUTOFFS = 2;
var MAX_STEPS = 100;
var WRAP_UP_RESPONSES = 2;
var MAX_TURN_CHARS = 24e4;
var KEEP_RECENT = 8;
var CLEARED = "(This output was cleared to keep the conversation within the model's context. Run it again if you need it.)";
var wrapUpNote = (reason, steps) => `(This turn is out of ${reason === "steps" ? `steps (${steps})` : "time"}. Don't start anything new: use send with final: true to say what's done, what's left, and that you'll carry on when you're mentioned again.)`;
var stoppedNotice = (reason, steps) => `I stopped before finishing: this turn ${reason === "steps" ? `used its ${steps} steps` : "ran out of time"}. Mention me to carry on from here.`;
var charsOf = (message) => (typeof message.content === "string" ? message.content.length : 0) + (message.role === "assistant" && message.tool_calls ? JSON.stringify(message.tool_calls).length : 0);
function clearOldResults(messages, maxChars) {
  let total = messages.reduce((sum, message) => sum + charsOf(message), 0);
  for (let i2 = 0; i2 < messages.length - KEEP_RECENT && total > maxChars; i2++) {
    const message = messages[i2];
    if (message.role !== "tool" || message.content.length <= CLEARED.length * 2) continue;
    total -= message.content.length - CLEARED.length;
    messages[i2] = { ...message, content: CLEARED };
  }
}
function sendable(message) {
  return message.role !== "assistant" || Boolean(message.content) || Boolean(message.tool_calls?.length);
}
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
  const history = input.history.filter(sendable);
  const maxTokens = input.maxTokens ?? MAX_TOKENS;
  const usage = { prompt: 0, completion: 0 };
  let posted = false;
  let final = false;
  let text = "";
  let partial = "";
  let cutoffs = 0;
  const maxSteps = input.maxSteps ?? MAX_STEPS;
  let steps = 0;
  let wrapping;
  let wrapResponses = 0;
  let wrapPosted = false;
  for (; ; ) {
    input.signal.throwIfAborted();
    if (!wrapping) {
      wrapping = steps >= maxSteps ? "steps" : input.deadline !== void 0 && Date.now() >= input.deadline ? "time" : void 0;
      if (wrapping) added.push({ role: "user", content: wrapUpNote(wrapping, steps) });
    }
    if (wrapping && wrapResponses++ >= WRAP_UP_RESPONSES) break;
    steps++;
    clearOldResults(added, input.maxTurnChars ?? MAX_TURN_CHARS);
    const completion = await input.chat({
      model: input.model,
      messages: [{ role: "system", content: input.system }, ...history, ...added],
      tools,
      maxTokens,
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
    if (!calls.length && choice.finish_reason === "length") {
      if (++cutoffs > MAX_CUTOFFS)
        throw new Error("The model's responses kept stopping at its output limit before they were complete. Ask for smaller steps, such as writing a large file in parts.");
      if (content.trim()) {
        partial += content;
        added.push({ role: "assistant", content });
        added.push({ role: "user", content: "(Your reply stopped at the output limit. Continue exactly where it stopped, without repeating anything.)" });
      } else
        added.push({
          role: "user",
          content: "(Your last response stopped at the output limit before it was complete, so none of it arrived, not even its tool call. Do it in smaller steps: write a large file in several parts, or run shorter commands.)"
        });
      continue;
    }
    cutoffs = 0;
    if (content || calls.length) added.push({ role: "assistant", content: content || null, ...calls.length && { tool_calls: calls } });
    if (!calls.length) {
      text = partial + content;
      break;
    }
    partial = "";
    for (const call of calls) {
      input.signal.throwIfAborted();
      const args = parseArgs(call);
      const name = call.function.name;
      input.onStep?.(name, target(args));
      let result;
      try {
        const localTool = local.get(name);
        if (wrapping && !MESSAGE_TOOLS.has(name)) result = "Error: this turn is out of steps or time, so nothing new runs. Post where things stand with send (final: true).";
        else if (localTool && !buzzNames.has(name)) result = await localTool.run(args, input.signal);
        else if (input.buzz && buzzNames.has(name)) {
          const reply = await callBuzz(input.buzz, name, args);
          result = reply.error ? `Error: ${reply.text}` : reply.text;
          if (!reply.error && MESSAGE_TOOLS.has(name)) {
            posted = true;
            if (wrapping) wrapPosted = true;
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
  const unfinished = wrapping && !final ? { reason: wrapping, ...!wrapPosted && { notice: text.trim() || stoppedNotice(wrapping, maxSteps) } } : void 0;
  return { text, posted, final, messages: added, steps, usage, ...unfinished && { unfinished } };
}
var HISTORY_CHARS = 12e4;
var HISTORY_MESSAGES = 120;
function splitHistory(all, maxChars = HISTORY_CHARS, maxMessages = HISTORY_MESSAGES) {
  const messages = all.filter(sendable);
  const size = (list) => list.reduce((total, message) => total + (typeof message.content === "string" ? message.content.length : 0) + 200, 0);
  let start = 0;
  while ((size(messages.slice(start)) > maxChars || messages.length - start > maxMessages) && start < messages.length) {
    const next = messages.findIndex((message, index) => index > start && message.role === "user");
    if (next === -1) break;
    start = next;
  }
  return { kept: messages.slice(start), dropped: messages.slice(0, start) };
}
function trimHistory(all, maxChars = HISTORY_CHARS, maxMessages = HISTORY_MESSAGES) {
  return splitHistory(all, maxChars, maxMessages).kept;
}

// plugins/agents/src/compaction.ts
var SUMMARY_MAX = 8e3;
var COMPACT_CHARS = 2e4;
var COMPACT_MESSAGES = 12;
var TRANSCRIPT_MAX = 12e4;
var clip2 = (text, max) => text.length > max ? `${text.slice(0, max)} \u2026 (${text.length - max} more characters)` : text;
function transcript(messages, max = TRANSCRIPT_MAX) {
  const lines = messages.map((message) => {
    if (message.role === "tool") return `[tool result] ${clip2(message.content, 800)}`;
    if (message.role === "assistant") {
      const calls = (message.tool_calls ?? []).map((call) => `[called ${call.function.name}] ${clip2(call.function.arguments, 300)}`);
      return [message.content ? `[agent] ${clip2(message.content, 3e3)}` : "", ...calls].filter(Boolean).join("\n");
    }
    return `[${message.role === "user" ? "conversation" : message.role}] ${clip2(message.content, 4e3)}`;
  });
  const text = lines.join("\n\n");
  if (text.length <= max) return text;
  return `${text.slice(0, max / 2)}

\u2026 (${text.length - max} characters left out) \u2026

${text.slice(-max / 2)}`;
}
var INSTRUCTIONS = "You keep the running summary of a conversation in Buzz, a team chat, for an AI agent that takes part in it. The conversation's oldest messages no longer fit in the agent's context, so your summary stands in for them. Write it for the agent itself.";
function summaryRequest(previous, dropped) {
  return [
    { role: "system", content: INSTRUCTIONS },
    {
      role: "user",
      content: [
        previous ? `<previous_summary>
${previous}
</previous_summary>` : "",
        `<messages>
${transcript(dropped)}
</messages>`,
        `Write the updated summary${previous ? ", merging the previous summary with these messages into one" : ""}. Keep:
- what people asked for, and who asked;
- decisions, and why they were made;
- what was done, with exact names: files, commands, branches, pull requests, links, IDs and numbers;
- what is in progress or still to do, and anything the agent promised.
Leave out greetings, and tool output that no longer matters. Use short Markdown bullets under a few headings, at most 600 words. Reply with the summary only.`
      ].filter(Boolean).join("\n\n")
    }
  ];
}
async function summarize2(chat, previous, dropped, signal) {
  const text = (await chat(summaryRequest(previous, dropped), signal)).trim();
  if (!text) throw new Error("The model returned an empty summary.");
  return clip2(text, SUMMARY_MAX);
}
function withSummary(system, summary) {
  if (!summary?.trim()) return system;
  return `${system}

<earlier_in_this_conversation>
The start of this conversation no longer fits in your context. This is a summary of it, written as it fell out; read the conversation for anything it leaves out.

${summary.trim()}
</earlier_in_this_conversation>`;
}
async function keepWithinBudget(save, session, messages, chat, signal, onSummarizing) {
  const { kept, dropped } = splitHistory(messages);
  if (!dropped.length) return save({ ...session, messages: kept });
  await save({ ...session, messages: [...dropped, ...kept] });
  try {
    onSummarizing?.();
    const summary = await summarize2(chat, session.summary, dropped, signal);
    await save({ ...session, messages: kept, summary });
  } catch {
    const over = splitHistory(messages, HISTORY_CHARS * 2, HISTORY_MESSAGES * 2);
    if (over.dropped.length) await save({ ...session, messages: over.kept });
  }
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
var clip3 = (text, max = 2e4) => text.length > max ? `${text.slice(0, max / 2)}
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
        const status3 = result.status?.replace("EXECUTE_COMMAND_STATUS_", "").toLowerCase() ?? "completed";
        return [
          `exit_code: ${result.exit_code ?? "unknown"} (${status3}${result.truncated ? ", output truncated" : ""})`,
          result.stdout ? `stdout:
${clip3(result.stdout)}` : "stdout: (empty)",
          result.stderr ? `stderr:
${clip3(result.stderr, 8e3)}` : ""
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
        return clip3(await sandboxes.readFile(id, path.startsWith("/") ? path : `${SANDBOX_HOME}/work/${path}`, signal), 6e4);
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
var WRAP_UP_MS = 3 * 6e4;
var summaryChat = (ai, model) => async (messages, signal) => messageText((await ai.chat({ model, messages, maxTokens: 2e3, signal })).choices[0]?.message.content ?? null);
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
      const status3 = service.snapshot().status;
      if (status3 === "connected") return { readiness: "ready" };
      if (status3 === "checking" || status3 === "connecting") return { readiness: "checking" };
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
  const compacting = /* @__PURE__ */ new Set();
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
  async function sandboxTurn(delivery, config, conversation, signal, report, deadline) {
    const workspace = agentService(service, config.profile);
    const client = await workspace.ready(signal);
    const session = sessions.get(delivery.agent.key, conversation.key);
    const { tools, instructions, cwd } = await sandboxSetup(delivery, config, workspace, signal, (state) => report.tool("sandbox", state), conversation.channel);
    const system = withSummary(await kit.systemPrompt(delivery, { scope: config.scope, cwd, instructions, tools: true }), session.summary);
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
        deadline,
        onStep: (tool, target2) => report.tool(tool, target2),
        onThought: (text) => report.thought(text)
      });
      if (result.unfinished?.notice) await kit.reply(delivery.agent, conversation, result.unfinished.notice, { notifyOwner: true });
      else if (!result.posted && result.text.trim()) await kit.reply(delivery.agent, conversation, result.text.trim());
      await keepSession(delivery.agent.key, conversation.key, { ...session, cursor: prompt.cursor }, [...session.messages, ...result.messages], summaryChat(ai, delivery.model ?? config.model), signal, report);
    } catch (error) {
      if (!answered) prompt.restore();
      throw error;
    }
  }
  function keepSession(agent, key2, session, messages, chat, signal, report) {
    return keepWithinBudget((next) => sessions.set(agent, key2, next), session, messages, chat, signal, () => report?.step({ tool: "Summarizing earlier messages" }));
  }
  async function compact2(agent, config, key2, signal) {
    const session = sessions.get(agent.key, key2);
    if (config.kind === "genie-one") throw new Error("Genie One keeps the conversation and manages its context itself. Start a new session to begin again.");
    if (config.kind !== "sandbox") return;
    const workspace = agentService(service, config.profile);
    if (isRemote(config.harness)) {
      if (session.remote?.harness !== config.harness) return;
      const sandboxes = await ensureAgentSandbox(workspace, agent.pubkey, agent.name, signal);
      await compactRemote({ sandboxes, sandbox: sandboxFor(agent.pubkey), harness: config.harness, model: harnessModel(config.harness, config.model), session: session.remote.id, signal });
      return;
    }
    const { kept, dropped } = splitHistory(session.messages, COMPACT_CHARS, COMPACT_MESSAGES);
    if (!dropped.length) return;
    const summary = await summarize2(summaryChat(new Ai(await workspace.ready(signal)), config.model), session.summary, dropped, signal);
    await sessions.set(agent.key, key2, { ...sessions.get(agent.key, key2), messages: kept, summary });
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
    let status3 = "";
    const answer = await new Genie(client).answer(agent.target, question, {
      ...session.genieConversationId && { conversationId: session.genieConversationId },
      signal,
      onUpdate: (message) => {
        if (message.status === status3) return;
        status3 = message.status;
        report.step(genieStatusStep(agent.label, status3));
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
    summary: (agent) => summarize3(normalizeDatabricks(agent.config)),
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
      state: (agent, place) => {
        const key2 = `${agent.key}|${conversationKey(scopeOf(normalizeDatabricks(agent.config)), place)}`;
        return compacting.has(key2) ? "compacting" : queue.active(key2) ? "active" : "idle";
      },
      async run(agent, place, action) {
        const config = normalizeDatabricks(agent.config);
        const key2 = conversationKey(scopeOf(config), place);
        if (action === "interrupt") return queue.interrupt(`${agent.key}|${key2}`);
        if (action === "new") return sessions.clear(agent.key, key2);
        const queued = `${agent.key}|${key2}`;
        compacting.add(queued);
        await queue.run(queued, async (signal) => {
          try {
            await compact2(agent, config, key2, signal);
          } finally {
            compacting.delete(queued);
          }
        });
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
      const deadline = Date.now() + TURN_TIMEOUT_MS - WRAP_UP_MS;
      turn(
        delivery,
        conversation,
        config,
        (signal, report) => config.kind === "sandbox" ? isRemote(harness) ? remoteTurn(delivery, config, harness, conversation, signal, report) : sandboxTurn(delivery, config, conversation, signal, report, deadline) : config.kind === "custom" ? customTurn(delivery, config, conversation, signal, report) : genieOneTurn(delivery, config, conversation, signal, report)
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
function summarize3(config) {
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
    const stopRefresh = registerAppType(scope.agents, databricks);
    scope.effect(() => stopRefresh);
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
          "Runs in your Databricks workspace, in its own Sandbox, so it can answer with Buzz closed. Genie, Claude Code, Codex or Pi in each harness's guarded mode, or an Omnigent agent. Always on, or asleep while Buzz is closed. It can't use Buzz's own tools."
        ],
        [
          "Databricks App",
          "A Buzz identity for code running as a Databricks App, like a Slack app's bot user. It works as the app's own service principal, with only the access you grant it, so it can answer anyone in its channels. Deploy the starter app, or connect an app you have."
        ]
      ].map(([title, body]) => /* @__PURE__ */ React.createElement(Stack, { key: title, gap: 2 }, /* @__PURE__ */ React.createElement(Text, { weight: 500 }, title), /* @__PURE__ */ React.createElement(Text, { tone: "subtle", size: "sm" }, body))), /* @__PURE__ */ React.createElement(Text, { size: "sm" }, "To create one, open ", /* @__PURE__ */ React.createElement("b", null, "Agents"), ", choose ", /* @__PURE__ */ React.createElement("b", null, "New agent"), " and pick ", /* @__PURE__ */ React.createElement("b", null, "Databricks"), ", ", /* @__PURE__ */ React.createElement("b", null, "Databricks (hosted)"), " or ", /* @__PURE__ */ React.createElement("b", null, "Databricks App"), " as the harness.")));
    }
  });
}
export {
  apply,
  inject
};
