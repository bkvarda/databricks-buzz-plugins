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
function databricksIcon() {
  return React.forwardRef(function DatabricksIcon({ size = "1em", title, color: _color, ...props }, ref) {
    return /* @__PURE__ */ React.createElement("svg", { ref, viewBox: "-15.5 0 331 331", width: size, height: size, fill: "none", role: title ? "img" : void 0, "aria-hidden": title ? void 0 : true, ...props }, title && /* @__PURE__ */ React.createElement("title", null, title), /* @__PURE__ */ React.createElement("path", { fill: "#FF3621", d: DATABRICKS_MARK_PATH }));
  });
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

// virtual:agent-runner
var RUNNER = '// Databricks Agents runner for Buzz (built by databricks-buzz-plugins). Apache-2.0.\nimport{execFile as Eo,spawn as vo}from"node:child_process";import{appendFileSync as _o,existsSync as Ie,openSync as ko,readFileSync as pt,rmSync as Cr,statSync as Dr,truncateSync as Ro,writeFileSync as rn}from"node:fs";var Hr=/^(tinyint|smallint|int|integer|bigint|long|short|byte|float|double|real|decimal|numeric)/i,an=/^(date|timestamp)/i,Gr=/(^|_)(id|ids|zip|zipcode|zip_code|postal_code|postcode|code|key|year|fiscal_year|phone)$/i;function jr(e,t,n=""){if(Gr.test(n)&&!an.test(e??"")&&!/^bool/i.test(e??""))return"text";if(e){if(Hr.test(e))return"number";if(an.test(e))return"time";if(/^bool/i.test(e))return"boolean";if(/^(string|varchar|char|binary|array|map|struct|interval)/i.test(e))return"text"}let r=t.filter(s=>s!==null&&s!=="");return r.length?r.every(s=>/^-?\\d+(\\.\\d+)?([eE][+-]?\\d+)?$/.test(s))?"number":r.every(s=>/^\\d{4}-\\d{2}(-\\d{2})?([T ]\\d{2}:\\d{2}(:\\d{2}(\\.\\d+)?)?(Z|[+-]\\d{2}:?\\d{2})?)?$/.test(s))?"time":"text":"text"}function He(e,t,n={}){return{columns:e.map((r,s)=>({name:r.name,...r.type&&{type:r.type},kind:jr(r.type,t.slice(0,50).map(o=>o[s]??null),r.name)})),rows:t,...n}}function gt(e){let t=(e.manifest?.schema?.columns??[]).map(s=>({name:s.name,type:s.type_text??s.type_name??""})),n=e.result?.data_array??[],r=e.manifest?.total_row_count;return He(t,n,{...r!==void 0&&{totalRows:r},truncated:!!e.manifest?.truncated||r!==void 0&&r>n.length})}var zr=new Intl.NumberFormat(void 0,{notation:"compact",maximumFractionDigits:1}),Kr=new Intl.NumberFormat(void 0,{maximumFractionDigits:2});function Zr(e,t="precise"){return Number.isFinite(e)?t==="compact"&&Math.abs(e)>=1e4?zr.format(e):Kr.format(e):String(e)}function Vr(e,t){if(e===null)return"null";if(t==="number"){let n=Number(e);if(Number.isFinite(n)&&Math.abs(n)<1e15)return Zr(n)}return t==="time"&&/T00:00:00(\\.000)?(Z)?$/.test(e)?e.slice(0,10):e}function Ge(e,t=20){if(!e.columns.length)return"_No columns._";let n=c=>c.replace(/\\|/g,"\\\\|").replace(/\\n/g," "),r=`| ${e.columns.map(c=>n(c.name)).join(" | ")} |`,s=`| ${e.columns.map(c=>c.kind==="number"?"---:":"---").join(" | ")} |`,o=e.rows.slice(0,t).map(c=>`| ${e.columns.map((l,u)=>n(Vr(c[u]??null,l.kind))).join(" | ")} |`),a=e.totalRows??e.rows.length,i=a>Math.min(t,e.rows.length)?`\n\n_Showing ${Math.min(t,e.rows.length)} of ${a} rows._`:"";return[r,s,...o].join(`\n`)+i}function Yr(e){let t=n=>n===null?"":/[",\\n]/.test(n)?`"${n.replace(/"/g,\'""\')}"`:n;return[e.columns.map(n=>t(n.name)).join(","),...e.rows.map(n=>n.map(t).join(","))].join(`\n`)}var ht="databricks-result";function Be(e,t=200){let n={...e,rows:e.rows.slice(0,t)},r=Yr(n),s=r.includes("```")?"````":"```",o=e.totalRows??e.rows.length,a=o>n.rows.length?`\n\n_Showing ${n.rows.length} of ${o} rows._`:"";return`${s}${ht}\n${r}\n${s}${a}`}var Xr=new Set(["COMPLETED","FAILED","QUERY_RESULT_EXPIRED","CANCELLED"]);var cn=e=>e.message_id??e.id??"";function Jr(e){let t=e.attachments??[],n=t.map(o=>o.text?.content).filter(o=>!!o).join(`\n\n`),r=t.find(o=>o.query?.query),s=t.flatMap(o=>o.suggested_questions?.questions??[]);return{text:n,sql:r?.query?.query,queryTitle:r?.query?.title,queryDescription:r?.query?.description,queryAttachmentId:r?.attachment_id,rowCount:r?.query?.query_result_metadata?.row_count,suggestions:s,error:e.error?.error}}var Oe=e=>`/api/2.0/genie/spaces/${encodeURIComponent(e)}`,ne=class{constructor(t){this.client=t}async listSpaces(t){let n=[],r;for(let s=0;s<20;s++){let o=await this.client.get("/api/2.0/genie/spaces",{query:{page_size:100,page_token:r},...t&&{signal:t}});if(n.push(...o.spaces??[]),r=o.next_page_token,!r)break}return n.sort((s,o)=>s.title.localeCompare(o.title))}getSpace(t,n){return this.client.get(Oe(t),n?{signal:n}:{})}async ask(t,n,r,s){if(r){let i=await this.client.post(`${Oe(t)}/conversations/${encodeURIComponent(r)}/messages`,{content:n},s?{signal:s}:{});return{...i,conversation_id:i.conversation_id??r}}let o=await this.client.post(`${Oe(t)}/start-conversation`,{content:n},s?{signal:s}:{}),a=o.conversation_id??o.conversation?.id??o.message?.conversation_id??"";return{content:n,status:"SUBMITTED",...o.message,conversation_id:a,message_id:o.message_id??o.message?.message_id??o.message?.id??""}}getMessage(t,n,r,s){return this.client.get(`${Oe(t)}/conversations/${encodeURIComponent(n)}/messages/${encodeURIComponent(r)}`,s?{signal:s}:{})}async wait(t,n,r,s){let o=n,a=1e3,i=Date.now()+10*6e4;for(;!Xr.has(o.status);){if(Date.now()>i)throw new Error("Genie did not answer within 10 minutes.");await new Promise(c=>setTimeout(c,a)),s?.throwIfAborted(),a=Math.min(5e3,Math.round(a*1.4)),o={...await this.getMessage(t,o.conversation_id,cn(o),s),conversation_id:o.conversation_id},r?.(o)}return o}async result(t,n,r,s){let o=`${Oe(t)}/conversations/${encodeURIComponent(n.conversation_id)}/messages/${encodeURIComponent(cn(n))}/attachments/${encodeURIComponent(r)}`;try{let i=await this.client.get(`${o}/query-result`,s?{signal:s}:{});if(i.statement_response?.result||i.statement_response?.manifest)return gt(i.statement_response)}catch(i){if(i.status!==404&&i.status!==400)throw i}let a=await this.client.post(`${o}/execute-query`,{},s?{signal:s}:{});return gt(a.statement_response??{})}async answer(t,n,r={}){let s=await this.ask(t,n,r.conversationId,r.signal);r.onUpdate?.(s);let o=await this.wait(t,s,r.onUpdate,r.signal),a=Jr(o),i;return o.status==="COMPLETED"&&a.queryAttachmentId&&(i=await this.result(t,o,a.queryAttachmentId,r.signal).catch(()=>{})),{message:o,...a,result:i}}static webPath(t,n){return`/genie/rooms/${encodeURIComponent(t)}${n?`/chats/${encodeURIComponent(n)}`:""}`}};function mt(e){return e instanceof Uint8Array||ArrayBuffer.isView(e)&&e.constructor.name==="Uint8Array"}function xe(e,t=""){if(!Number.isSafeInteger(e)||e<0){let n=t&&`"${t}" `;throw new Error(`${n}expected integer >= 0, got ${e}`)}}function C(e,t,n=""){let r=mt(e),s=e?.length,o=t!==void 0;if(!r||o&&s!==t){let a=n&&`"${n}" `,i=o?` of length ${t}`:"",c=r?`length=${s}`:`type=${typeof e}`;throw new Error(a+"expected Uint8Array"+i+", got "+c)}return e}function yt(e,t=!0){if(e.destroyed)throw new Error("Hash instance has been destroyed");if(t&&e.finished)throw new Error("Hash#digest() has already been called")}function dn(e,t){C(e,void 0,"digestInto() output");let n=t.outputLen;if(e.length<n)throw new Error(\'"digestInto() output" expected to be of length >=\'+n)}function Ne(...e){for(let t=0;t<e.length;t++)e[t].fill(0)}function je(e){return new DataView(e.buffer,e.byteOffset,e.byteLength)}function J(e,t){return e<<32-t|e>>>t}var un=typeof Uint8Array.from([]).toHex=="function"&&typeof Uint8Array.fromHex=="function",Wr=Array.from({length:256},(e,t)=>t.toString(16).padStart(2,"0"));function W(e){if(C(e),un)return e.toHex();let t="";for(let n=0;n<e.length;n++)t+=Wr[e[n]];return t}var re={_0:48,_9:57,A:65,F:70,a:97,f:102};function ln(e){if(e>=re._0&&e<=re._9)return e-re._0;if(e>=re.A&&e<=re.F)return e-(re.A-10);if(e>=re.a&&e<=re.f)return e-(re.a-10)}function te(e){if(typeof e!="string")throw new Error("hex string expected, got "+typeof e);if(un)return Uint8Array.fromHex(e);let t=e.length,n=t/2;if(t%2)throw new Error("hex string expected, got unpadded hex of length "+t);let r=new Uint8Array(n);for(let s=0,o=0;s<n;s++,o+=2){let a=ln(e.charCodeAt(o)),i=ln(e.charCodeAt(o+1));if(a===void 0||i===void 0){let c=e[o]+e[o+1];throw new Error(\'hex string expected, got non-hex character "\'+c+\'" at index \'+o)}r[s]=a*16+i}return r}function ae(...e){let t=0;for(let r=0;r<e.length;r++){let s=e[r];C(s),t+=s.length}let n=new Uint8Array(t);for(let r=0,s=0;r<e.length;r++){let o=e[r];n.set(o,s),s+=o.length}return n}function fn(e,t={}){let n=(s,o)=>e(o).update(s).digest(),r=e(void 0);return n.outputLen=r.outputLen,n.blockLen=r.blockLen,n.create=s=>e(s),Object.assign(n,t),Object.freeze(n)}function Ce(e=32){let t=typeof globalThis=="object"?globalThis.crypto:null;if(typeof t?.getRandomValues!="function")throw new Error("crypto.getRandomValues must be defined");return t.getRandomValues(new Uint8Array(e))}var pn=e=>({oid:Uint8Array.from([6,9,96,134,72,1,101,3,4,2,e])});function gn(e,t,n){return e&t^~e&n}function hn(e,t,n){return e&t^e&n^t&n}var ze=class{blockLen;outputLen;padOffset;isLE;buffer;view;finished=!1;length=0;pos=0;destroyed=!1;constructor(t,n,r,s){this.blockLen=t,this.outputLen=n,this.padOffset=r,this.isLE=s,this.buffer=new Uint8Array(t),this.view=je(this.buffer)}update(t){yt(this),C(t);let{view:n,buffer:r,blockLen:s}=this,o=t.length;for(let a=0;a<o;){let i=Math.min(s-this.pos,o-a);if(i===s){let c=je(t);for(;s<=o-a;a+=s)this.process(c,a);continue}r.set(t.subarray(a,a+i),this.pos),this.pos+=i,a+=i,this.pos===s&&(this.process(n,0),this.pos=0)}return this.length+=t.length,this.roundClean(),this}digestInto(t){yt(this),dn(t,this),this.finished=!0;let{buffer:n,view:r,blockLen:s,isLE:o}=this,{pos:a}=this;n[a++]=128,Ne(this.buffer.subarray(a)),this.padOffset>s-a&&(this.process(r,0),a=0);for(let d=a;d<s;d++)n[d]=0;r.setBigUint64(s-8,BigInt(this.length*8),o),this.process(r,0);let i=je(t),c=this.outputLen;if(c%4)throw new Error("_sha2: outputLen must be aligned to 32bit");let l=c/4,u=this.get();if(l>u.length)throw new Error("_sha2: outputLen bigger than state");for(let d=0;d<l;d++)i.setUint32(4*d,u[d],o)}digest(){let{buffer:t,outputLen:n}=this;this.digestInto(t);let r=t.slice(0,n);return this.destroy(),r}_cloneInto(t){t||=new this.constructor,t.set(...this.get());let{blockLen:n,buffer:r,length:s,finished:o,destroyed:a,pos:i}=this;return t.destroyed=a,t.finished=o,t.length=s,t.pos=i,s%n&&t.buffer.set(r),t}clone(){return this._cloneInto()}},se=Uint32Array.from([1779033703,3144134277,1013904242,2773480762,1359893119,2600822924,528734635,1541459225]);var Fr=Uint32Array.from([1116352408,1899447441,3049323471,3921009573,961987163,1508970993,2453635748,2870763221,3624381080,310598401,607225278,1426881987,1925078388,2162078206,2614888103,3248222580,3835390401,4022224774,264347078,604807628,770255983,1249150122,1555081692,1996064986,2554220882,2821834349,2952996808,3210313671,3336571891,3584528711,113926993,338241895,666307205,773529912,1294757372,1396182291,1695183700,1986661051,2177026350,2456956037,2730485921,2820302411,3259730800,3345764771,3516065817,3600352804,4094571909,275423344,430227734,506948616,659060556,883997877,958139571,1322822218,1537002063,1747873779,1955562222,2024104815,2227730452,2361852424,2428436474,2756734187,3204031479,3329325298]),ce=new Uint32Array(64),bt=class extends ze{constructor(t){super(64,t,8,!1)}get(){let{A:t,B:n,C:r,D:s,E:o,F:a,G:i,H:c}=this;return[t,n,r,s,o,a,i,c]}set(t,n,r,s,o,a,i,c){this.A=t|0,this.B=n|0,this.C=r|0,this.D=s|0,this.E=o|0,this.F=a|0,this.G=i|0,this.H=c|0}process(t,n){for(let d=0;d<16;d++,n+=4)ce[d]=t.getUint32(n,!1);for(let d=16;d<64;d++){let p=ce[d-15],g=ce[d-2],x=J(p,7)^J(p,18)^p>>>3,S=J(g,17)^J(g,19)^g>>>10;ce[d]=S+ce[d-7]+x+ce[d-16]|0}let{A:r,B:s,C:o,D:a,E:i,F:c,G:l,H:u}=this;for(let d=0;d<64;d++){let p=J(i,6)^J(i,11)^J(i,25),g=u+p+gn(i,c,l)+Fr[d]+ce[d]|0,S=(J(r,2)^J(r,13)^J(r,22))+hn(r,s,o)|0;u=l,l=c,c=i,i=a+g|0,a=o,o=s,s=r,r=g+S|0}r=r+this.A|0,s=s+this.B|0,o=o+this.C|0,a=a+this.D|0,i=i+this.E|0,c=c+this.F|0,l=l+this.G|0,u=u+this.H|0,this.set(r,s,o,a,i,c,l,u)}roundClean(){Ne(ce)}destroy(){this.set(0,0,0,0,0,0,0,0),Ne(this.buffer)}},xt=class extends bt{A=se[0]|0;B=se[1]|0;C=se[2]|0;D=se[3]|0;E=se[4]|0;F=se[5]|0;G=se[6]|0;H=se[7]|0;constructor(){super(32)}};var ue=fn(()=>new xt,pn(1));var St=BigInt(0),wt=BigInt(1);function Et(e,t=""){if(typeof e!="boolean"){let n=t&&`"${t}" `;throw new Error(n+"expected boolean, got type="+typeof e)}return e}function Qr(e){if(typeof e=="bigint"){if(!ts(e))throw new Error("positive bigint expected, got "+e)}else xe(e);return e}function mn(e){if(typeof e!="string")throw new Error("hex string expected, got "+typeof e);return e===""?St:BigInt("0x"+e)}function we(e){return mn(W(e))}function vt(e){return mn(W(es(C(e)).reverse()))}function Ke(e,t){xe(t),e=Qr(e);let n=te(e.toString(16).padStart(t*2,"0"));if(n.length!==t)throw new Error("number too large");return n}function _t(e,t){return Ke(e,t).reverse()}function es(e){return Uint8Array.from(e)}function yn(e){return Uint8Array.from(e,(t,n)=>{let r=t.charCodeAt(0);if(t.length!==1||r>127)throw new Error(`string contains non-ASCII character "${e[n]}" with code ${r} at position ${n}`);return r})}var ts=e=>typeof e=="bigint"&&St<=e;function kt(e){let t;for(t=0;e>St;e>>=wt,t+=1);return t}var Ze=e=>(wt<<BigInt(e))-wt;function Ve(e,t={},n={}){if(!e||typeof e!="object")throw new Error("expected valid options object");function r(o,a,i){let c=e[o];if(i&&c===void 0)return;let l=typeof c;if(l!==a||c===null)throw new Error(`param "${o}" is invalid: expected ${a}, got ${l}`)}let s=(o,a)=>Object.entries(o).forEach(([i,c])=>r(i,c,a));s(t,!1),s(n,!0)}function Rt(e){let t=new WeakMap;return(n,...r)=>{let s=t.get(n);if(s!==void 0)return s;let o=e(n,...r);return t.set(n,o),o}}var H=BigInt(0),q=BigInt(1),fe=BigInt(2),wn=BigInt(3),Sn=BigInt(4),En=BigInt(5),ns=BigInt(7),vn=BigInt(8),rs=BigInt(9),_n=BigInt(16);function F(e,t){let n=e%t;return n>=H?n:t+n}function K(e,t,n){let r=e;for(;t-- >H;)r*=r,r%=n;return r}function bn(e,t){if(e===H)throw new Error("invert: expected non-zero number");if(t<=H)throw new Error("invert: expected positive modulus, got "+t);let n=F(e,t),r=t,s=H,o=q,a=q,i=H;for(;n!==H;){let l=r/n,u=r%n,d=s-a*l,p=o-i*l;r=n,n=u,s=a,o=i,a=d,i=p}if(r!==q)throw new Error("invert: does not exist");return F(s,t)}function At(e,t,n){if(!e.eql(e.sqr(t),n))throw new Error("Cannot find square root")}function kn(e,t){let n=(e.ORDER+q)/Sn,r=e.pow(t,n);return At(e,r,t),r}function ss(e,t){let n=(e.ORDER-En)/vn,r=e.mul(t,fe),s=e.pow(r,n),o=e.mul(t,s),a=e.mul(e.mul(o,fe),s),i=e.mul(o,e.sub(a,e.ONE));return At(e,i,t),i}function os(e){let t=Se(e),n=Rn(e),r=n(t,t.neg(t.ONE)),s=n(t,r),o=n(t,t.neg(r)),a=(e+ns)/_n;return(i,c)=>{let l=i.pow(c,a),u=i.mul(l,r),d=i.mul(l,s),p=i.mul(l,o),g=i.eql(i.sqr(u),c),x=i.eql(i.sqr(d),c);l=i.cmov(l,u,g),u=i.cmov(p,d,x);let S=i.eql(i.sqr(u),c),v=i.cmov(l,u,S);return At(i,v,c),v}}function Rn(e){if(e<wn)throw new Error("sqrt is not defined for small field");let t=e-q,n=0;for(;t%fe===H;)t/=fe,n++;let r=fe,s=Se(e);for(;xn(s,r)===1;)if(r++>1e3)throw new Error("Cannot find square root: probably non-prime P");if(n===1)return kn;let o=s.pow(r,t),a=(t+q)/fe;return function(c,l){if(c.is0(l))return l;if(xn(c,l)!==1)throw new Error("Cannot find square root");let u=n,d=c.mul(c.ONE,o),p=c.pow(l,t),g=c.pow(l,a);for(;!c.eql(p,c.ONE);){if(c.is0(p))return c.ZERO;let x=1,S=c.sqr(p);for(;!c.eql(S,c.ONE);)if(x++,S=c.sqr(S),x===u)throw new Error("Cannot find square root");let v=q<<BigInt(u-x-1),D=c.pow(d,v);u=x,d=c.sqr(D),p=c.mul(p,d),g=c.mul(g,D)}return g}}function is(e){return e%Sn===wn?kn:e%vn===En?ss:e%_n===rs?os(e):Rn(e)}var as=["create","isValid","is0","neg","inv","sqrt","sqr","eql","add","sub","mul","pow","div","addN","subN","mulN","sqrN"];function Tn(e){let t={ORDER:"bigint",BYTES:"number",BITS:"number"},n=as.reduce((r,s)=>(r[s]="function",r),t);return Ve(e,n),e}function cs(e,t,n){if(n<H)throw new Error("invalid exponent, negatives unsupported");if(n===H)return e.ONE;if(n===q)return t;let r=e.ONE,s=t;for(;n>H;)n&q&&(r=e.mul(r,s)),s=e.sqr(s),n>>=q;return r}function $t(e,t,n=!1){let r=new Array(t.length).fill(n?e.ZERO:void 0),s=t.reduce((a,i,c)=>e.is0(i)?a:(r[c]=a,e.mul(a,i)),e.ONE),o=e.inv(s);return t.reduceRight((a,i,c)=>e.is0(i)?a:(r[c]=e.mul(a,r[c]),e.mul(a,i)),o),r}function xn(e,t){let n=(e.ORDER-q)/fe,r=e.pow(t,n),s=e.eql(r,e.ONE),o=e.eql(r,e.ZERO),a=e.eql(r,e.neg(e.ONE));if(!s&&!o&&!a)throw new Error("invalid Legendre symbol result");return s?1:o?0:-1}function ls(e,t){t!==void 0&&xe(t);let n=t!==void 0?t:e.toString(2).length,r=Math.ceil(n/8);return{nBitLength:n,nByteLength:r}}var Tt=class{ORDER;BITS;BYTES;isLE;ZERO=H;ONE=q;_lengths;_sqrt;_mod;constructor(t,n={}){if(t<=H)throw new Error("invalid field: expected ORDER > 0, got "+t);let r;this.isLE=!1,n!=null&&typeof n=="object"&&(typeof n.BITS=="number"&&(r=n.BITS),typeof n.sqrt=="function"&&(this.sqrt=n.sqrt),typeof n.isLE=="boolean"&&(this.isLE=n.isLE),n.allowedLengths&&(this._lengths=n.allowedLengths?.slice()),typeof n.modFromBytes=="boolean"&&(this._mod=n.modFromBytes));let{nBitLength:s,nByteLength:o}=ls(t,r);if(o>2048)throw new Error("invalid field: expected ORDER of <= 2048 bytes");this.ORDER=t,this.BITS=s,this.BYTES=o,this._sqrt=void 0,Object.preventExtensions(this)}create(t){return F(t,this.ORDER)}isValid(t){if(typeof t!="bigint")throw new Error("invalid field element: expected bigint, got "+typeof t);return H<=t&&t<this.ORDER}is0(t){return t===H}isValidNot0(t){return!this.is0(t)&&this.isValid(t)}isOdd(t){return(t&q)===q}neg(t){return F(-t,this.ORDER)}eql(t,n){return t===n}sqr(t){return F(t*t,this.ORDER)}add(t,n){return F(t+n,this.ORDER)}sub(t,n){return F(t-n,this.ORDER)}mul(t,n){return F(t*n,this.ORDER)}pow(t,n){return cs(this,t,n)}div(t,n){return F(t*bn(n,this.ORDER),this.ORDER)}sqrN(t){return t*t}addN(t,n){return t+n}subN(t,n){return t-n}mulN(t,n){return t*n}inv(t){return bn(t,this.ORDER)}sqrt(t){return this._sqrt||(this._sqrt=is(this.ORDER)),this._sqrt(this,t)}toBytes(t){return this.isLE?_t(t,this.BYTES):Ke(t,this.BYTES)}fromBytes(t,n=!1){C(t);let{_lengths:r,BYTES:s,isLE:o,ORDER:a,_mod:i}=this;if(r){if(!r.includes(t.length)||t.length>s)throw new Error("Field.fromBytes: expected "+r+" bytes, got "+t.length);let l=new Uint8Array(s);l.set(t,o?0:l.length-t.length),t=l}if(t.length!==s)throw new Error("Field.fromBytes: expected "+s+" bytes, got "+t.length);let c=o?vt(t):we(t);if(i&&(c=F(c,a)),!n&&!this.isValid(c))throw new Error("invalid field element: outside of range 0..ORDER");return c}invertBatch(t){return $t(this,t)}cmov(t,n,r){return r?n:t}};function Se(e,t={}){return new Tt(e,t)}function An(e){if(typeof e!="bigint")throw new Error("field order must be bigint");let t=e.toString(2).length;return Math.ceil(t/8)}function ds(e){let t=An(e);return t+Math.ceil(t/2)}function $n(e,t,n=!1){C(e);let r=e.length,s=An(t),o=ds(t);if(r<16||r<o||r>1024)throw new Error("expected "+o+"-1024 bytes of input, got "+r);let a=n?vt(e):we(e),i=F(a,t-q)+q;return n?_t(i,s):Ke(i,s)}var Ee=BigInt(0),pe=BigInt(1);function De(e,t){let n=t.negate();return e?n:t}function Nt(e,t){let n=$t(e.Fp,t.map(r=>r.Z));return t.map((r,s)=>e.fromAffine(r.toAffine(n[s])))}function Nn(e,t){if(!Number.isSafeInteger(e)||e<=0||e>t)throw new Error("invalid window size, expected [1.."+t+"], got W="+e)}function It(e,t){Nn(e,t);let n=Math.ceil(t/e)+1,r=2**(e-1),s=2**e,o=Ze(e),a=BigInt(e);return{windows:n,windowSize:r,mask:o,maxNumber:s,shiftBy:a}}function In(e,t,n){let{windowSize:r,mask:s,maxNumber:o,shiftBy:a}=n,i=Number(e&s),c=e>>a;i>r&&(i-=o,c+=pe);let l=t*r,u=l+Math.abs(i)-1,d=i===0,p=i<0,g=t%2!==0;return{nextN:c,offset:u,isZero:d,isNeg:p,isNegF:g,offsetF:l}}var Bt=new WeakMap,Cn=new WeakMap;function Ot(e){return Cn.get(e)||1}function Bn(e){if(e!==Ee)throw new Error("invalid wNAF")}var Ye=class{BASE;ZERO;Fn;bits;constructor(t,n){this.BASE=t.BASE,this.ZERO=t.ZERO,this.Fn=t.Fn,this.bits=n}_unsafeLadder(t,n,r=this.ZERO){let s=t;for(;n>Ee;)n&pe&&(r=r.add(s)),s=s.double(),n>>=pe;return r}precomputeWindow(t,n){let{windows:r,windowSize:s}=It(n,this.bits),o=[],a=t,i=a;for(let c=0;c<r;c++){i=a,o.push(i);for(let l=1;l<s;l++)i=i.add(a),o.push(i);a=i.double()}return o}wNAF(t,n,r){if(!this.Fn.isValid(r))throw new Error("invalid scalar");let s=this.ZERO,o=this.BASE,a=It(t,this.bits);for(let i=0;i<a.windows;i++){let{nextN:c,offset:l,isZero:u,isNeg:d,isNegF:p,offsetF:g}=In(r,i,a);r=c,u?o=o.add(De(p,n[g])):s=s.add(De(d,n[l]))}return Bn(r),{p:s,f:o}}wNAFUnsafe(t,n,r,s=this.ZERO){let o=It(t,this.bits);for(let a=0;a<o.windows&&r!==Ee;a++){let{nextN:i,offset:c,isZero:l,isNeg:u}=In(r,a,o);if(r=i,!l){let d=n[c];s=s.add(u?d.negate():d)}}return Bn(r),s}getPrecomputes(t,n,r){let s=Bt.get(n);return s||(s=this.precomputeWindow(n,t),t!==1&&(typeof r=="function"&&(s=r(s)),Bt.set(n,s))),s}cached(t,n,r){let s=Ot(t);return this.wNAF(s,this.getPrecomputes(s,t,r),n)}unsafe(t,n,r,s){let o=Ot(t);return o===1?this._unsafeLadder(t,n,s):this.wNAFUnsafe(o,this.getPrecomputes(o,t,r),n,s)}createCache(t,n){Nn(n,this.bits),Cn.set(t,n),Bt.delete(t)}hasCache(t){return Ot(t)!==1}};function Dn(e,t,n,r){let s=t,o=e.ZERO,a=e.ZERO;for(;n>Ee||r>Ee;)n&pe&&(o=o.add(s)),r&pe&&(a=a.add(s)),s=s.double(),n>>=pe,r>>=pe;return{p1:o,p2:a}}function On(e,t,n){if(t){if(t.ORDER!==e)throw new Error("Field.ORDER must match order: Fp == p, Fn == n");return Tn(t),t}else return Se(e,{isLE:n})}function Ln(e,t,n={},r){if(r===void 0&&(r=e==="edwards"),!t||typeof t!="object")throw new Error(`expected valid ${e} CURVE object`);for(let c of["p","n","h"]){let l=t[c];if(!(typeof l=="bigint"&&l>Ee))throw new Error(`CURVE.${c} must be positive bigint`)}let s=On(t.p,n.Fp,r),o=On(t.n,n.Fn,r),i=["Gx","Gy","a",e==="weierstrass"?"b":"d"];for(let c of i)if(!s.isValid(t[c]))throw new Error(`CURVE.${c} must be valid field element of CURVE.Fp`);return t=Object.freeze(Object.assign({},t)),{CURVE:t,Fp:s,Fn:o}}function Ct(e,t){return function(r){let s=e(r);return{secretKey:s,publicKey:t(s)}}}var Mn=(e,t)=>(e+(e>=0?t:-t)/fs)/t;function us(e,t,n){let[[r,s],[o,a]]=t,i=Mn(a*e,n),c=Mn(-s*e,n),l=e-i*r-c*o,u=-i*s-c*a,d=l<Le,p=u<Le;d&&(l=-l),p&&(u=-u);let g=Ze(Math.ceil(kt(n)/2))+Je;if(l<Le||l>=g||u<Le||u>=g)throw new Error("splitScalar (endomorphism): failed, k="+e);return{k1neg:d,k1:l,k2neg:p,k2:u}}var Le=BigInt(0),Je=BigInt(1),fs=BigInt(2),Xe=BigInt(3),ps=BigInt(4);function Pn(e,t={}){let n=Ln("weierstrass",e,t),{Fp:r,Fn:s}=n,o=n.CURVE,{h:a,n:i}=o;Ve(t,{},{allowInfinityPoint:"boolean",clearCofactor:"function",isTorsionFree:"function",fromBytes:"function",toBytes:"function",endo:"object"});let{endo:c}=t;if(c&&(!r.is0(o.a)||typeof c.beta!="bigint"||!Array.isArray(c.basises)))throw new Error(\'invalid endo: expected "beta": bigint and "basises": array\');let l=hs(r,s);function u(){if(!r.isOdd)throw new Error("compression is not supported: Field does not have .isOdd()")}function d($,f,h){let{x:E,y:k}=f.toAffine(),I=r.toBytes(E);if(Et(h,"isCompressed"),h){u();let m=!r.isOdd(k);return ae(gs(m),I)}else return ae(Uint8Array.of(4),I,r.toBytes(k))}function p($){C($,void 0,"Point");let{publicKey:f,publicKeyUncompressed:h}=l,E=$.length,k=$[0],I=$.subarray(1);if(E===f&&(k===2||k===3)){let m=r.fromBytes(I);if(!r.isValid(m))throw new Error("bad point: is not on curve, wrong x");let w=S(m),y;try{y=r.sqrt(w)}catch(V){let P=V instanceof Error?": "+V.message:"";throw new Error("bad point: is not on curve, sqrt error"+P)}u();let T=r.isOdd(y);return(k&1)===1!==T&&(y=r.neg(y)),{x:m,y}}else if(E===h&&k===4){let m=r.BYTES,w=r.fromBytes(I.subarray(0,m)),y=r.fromBytes(I.subarray(m,m*2));if(!v(w,y))throw new Error("bad point: is not on curve");return{x:w,y}}else throw new Error(`bad point: got length ${E}, expected compressed=${f} or uncompressed=${h}`)}let g=t.toBytes||d,x=t.fromBytes||p;function S($){let f=r.sqr($),h=r.mul(f,$);return r.add(r.add(h,r.mul($,o.a)),o.b)}function v($,f){let h=r.sqr(f),E=S($);return r.eql(h,E)}if(!v(o.Gx,o.Gy))throw new Error("bad curve params: generator point");let D=r.mul(r.pow(o.a,Xe),ps),G=r.mul(r.sqr(o.b),BigInt(27));if(r.is0(r.add(D,G)))throw new Error("bad curve params: a or b");function A($,f,h=!1){if(!r.isValid(f)||h&&r.is0(f))throw new Error(`bad point coordinate ${$}`);return f}function ie($){if(!($ instanceof b))throw new Error("Weierstrass Point expected")}function Q($){if(!c||!c.basises)throw new Error("no endo");return us($,c.basises,s.ORDER)}let ye=Rt(($,f)=>{let{X:h,Y:E,Z:k}=$;if(r.eql(k,r.ONE))return{x:h,y:E};let I=$.is0();f==null&&(f=I?r.ONE:r.inv(k));let m=r.mul(h,f),w=r.mul(E,f),y=r.mul(k,f);if(I)return{x:r.ZERO,y:r.ZERO};if(!r.eql(y,r.ONE))throw new Error("invZ was invalid");return{x:m,y:w}}),_=Rt($=>{if($.is0()){if(t.allowInfinityPoint&&!r.is0($.Y))return;throw new Error("bad point: ZERO")}let{x:f,y:h}=$.toAffine();if(!r.isValid(f)||!r.isValid(h))throw new Error("bad point: x or y not field elements");if(!v(f,h))throw new Error("bad point: equation left != right");if(!$.isTorsionFree())throw new Error("bad point: not in prime-order subgroup");return!0});function R($,f,h,E,k){return h=new b(r.mul(h.X,$),h.Y,h.Z),f=De(E,f),h=De(k,h),f.add(h)}class b{static BASE=new b(o.Gx,o.Gy,r.ONE);static ZERO=new b(r.ZERO,r.ONE,r.ZERO);static Fp=r;static Fn=s;X;Y;Z;constructor(f,h,E){this.X=A("x",f),this.Y=A("y",h,!0),this.Z=A("z",E),Object.freeze(this)}static CURVE(){return o}static fromAffine(f){let{x:h,y:E}=f||{};if(!f||!r.isValid(h)||!r.isValid(E))throw new Error("invalid affine point");if(f instanceof b)throw new Error("projective point not allowed");return r.is0(h)&&r.is0(E)?b.ZERO:new b(h,E,r.ONE)}static fromBytes(f){let h=b.fromAffine(x(C(f,void 0,"point")));return h.assertValidity(),h}static fromHex(f){return b.fromBytes(te(f))}get x(){return this.toAffine().x}get y(){return this.toAffine().y}precompute(f=8,h=!0){return j.createCache(this,f),h||this.multiply(Xe),this}assertValidity(){_(this)}hasEvenY(){let{y:f}=this.toAffine();if(!r.isOdd)throw new Error("Field doesn\'t support isOdd");return!r.isOdd(f)}equals(f){ie(f);let{X:h,Y:E,Z:k}=this,{X:I,Y:m,Z:w}=f,y=r.eql(r.mul(h,w),r.mul(I,k)),T=r.eql(r.mul(E,w),r.mul(m,k));return y&&T}negate(){return new b(this.X,r.neg(this.Y),this.Z)}double(){let{a:f,b:h}=o,E=r.mul(h,Xe),{X:k,Y:I,Z:m}=this,w=r.ZERO,y=r.ZERO,T=r.ZERO,O=r.mul(k,k),V=r.mul(I,I),P=r.mul(m,m),N=r.mul(k,I);return N=r.add(N,N),T=r.mul(k,m),T=r.add(T,T),w=r.mul(f,T),y=r.mul(E,P),y=r.add(w,y),w=r.sub(V,y),y=r.add(V,y),y=r.mul(w,y),w=r.mul(N,w),T=r.mul(E,T),P=r.mul(f,P),N=r.sub(O,P),N=r.mul(f,N),N=r.add(N,T),T=r.add(O,O),O=r.add(T,O),O=r.add(O,P),O=r.mul(O,N),y=r.add(y,O),P=r.mul(I,m),P=r.add(P,P),O=r.mul(P,N),w=r.sub(w,O),T=r.mul(P,V),T=r.add(T,T),T=r.add(T,T),new b(w,y,T)}add(f){ie(f);let{X:h,Y:E,Z:k}=this,{X:I,Y:m,Z:w}=f,y=r.ZERO,T=r.ZERO,O=r.ZERO,V=o.a,P=r.mul(o.b,Xe),N=r.mul(h,I),Y=r.mul(E,m),X=r.mul(k,w),be=r.add(h,E),U=r.add(I,m);be=r.mul(be,U),U=r.add(N,Y),be=r.sub(be,U),U=r.add(h,k);let ee=r.add(I,w);return U=r.mul(U,ee),ee=r.add(N,X),U=r.sub(U,ee),ee=r.add(E,k),y=r.add(m,w),ee=r.mul(ee,y),y=r.add(Y,X),ee=r.sub(ee,y),O=r.mul(V,U),y=r.mul(P,X),O=r.add(y,O),y=r.sub(Y,O),O=r.add(Y,O),T=r.mul(y,O),Y=r.add(N,N),Y=r.add(Y,N),X=r.mul(V,X),U=r.mul(P,U),Y=r.add(Y,X),X=r.sub(N,X),X=r.mul(V,X),U=r.add(U,X),N=r.mul(Y,U),T=r.add(T,N),N=r.mul(ee,U),y=r.mul(be,y),y=r.sub(y,N),N=r.mul(be,Y),O=r.mul(ee,O),O=r.add(O,N),new b(y,T,O)}subtract(f){return this.add(f.negate())}is0(){return this.equals(b.ZERO)}multiply(f){let{endo:h}=t;if(!s.isValidNot0(f))throw new Error("invalid scalar: out of range");let E,k,I=m=>j.cached(this,m,w=>Nt(b,w));if(h){let{k1neg:m,k1:w,k2neg:y,k2:T}=Q(f),{p:O,f:V}=I(w),{p:P,f:N}=I(T);k=V.add(N),E=R(h.beta,O,P,m,y)}else{let{p:m,f:w}=I(f);E=m,k=w}return Nt(b,[E,k])[0]}multiplyUnsafe(f){let{endo:h}=t,E=this;if(!s.isValid(f))throw new Error("invalid scalar: out of range");if(f===Le||E.is0())return b.ZERO;if(f===Je)return E;if(j.hasCache(this))return this.multiply(f);if(h){let{k1neg:k,k1:I,k2neg:m,k2:w}=Q(f),{p1:y,p2:T}=Dn(b,E,I,w);return R(h.beta,y,T,k,m)}else return j.unsafe(E,f)}toAffine(f){return ye(this,f)}isTorsionFree(){let{isTorsionFree:f}=t;return a===Je?!0:f?f(b,this):j.unsafe(this,i).is0()}clearCofactor(){let{clearCofactor:f}=t;return a===Je?this:f?f(b,this):this.multiplyUnsafe(a)}isSmallOrder(){return this.multiplyUnsafe(a).is0()}toBytes(f=!0){return Et(f,"isCompressed"),this.assertValidity(),g(b,this,f)}toHex(f=!0){return W(this.toBytes(f))}toString(){return`<Point ${this.is0()?"ZERO":this.toHex()}>`}}let L=s.BITS,j=new Ye(b,t.endo?Math.ceil(L/2):L);return b.BASE.precompute(8),b}function gs(e){return Uint8Array.of(e?2:3)}function hs(e,t){return{secretKey:t.BYTES,publicKey:1+e.BYTES,publicKeyUncompressed:1+2*e.BYTES,publicKeyHasPrefix:!0,signature:2*t.BYTES}}var Qe={p:BigInt("0xfffffffffffffffffffffffffffffffffffffffffffffffffffffffefffffc2f"),n:BigInt("0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141"),h:BigInt(1),a:BigInt(0),b:BigInt(7),Gx:BigInt("0x79be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798"),Gy:BigInt("0x483ada7726a3c4655da4fbfc0e1108a8fd17b448a68554199c47d08ffb10d4b8")},ms={beta:BigInt("0x7ae96a2b657c07106e64479eac3434e99cf0497512f58995c1396c28719501ee"),basises:[[BigInt("0x3086d221a7d46bcde86c90e49284eb15"),-BigInt("0xe4437ed6010e88286f547fa90abfe4c3")],[BigInt("0x114ca50f7a8e2f3f657c1108d9d44cfd8"),BigInt("0x3086d221a7d46bcde86c90e49284eb15")]]},ys=BigInt(0),Dt=BigInt(2);function bs(e){let t=Qe.p,n=BigInt(3),r=BigInt(6),s=BigInt(11),o=BigInt(22),a=BigInt(23),i=BigInt(44),c=BigInt(88),l=e*e*e%t,u=l*l*e%t,d=K(u,n,t)*u%t,p=K(d,n,t)*u%t,g=K(p,Dt,t)*l%t,x=K(g,s,t)*g%t,S=K(x,o,t)*x%t,v=K(S,i,t)*S%t,D=K(v,c,t)*v%t,G=K(D,i,t)*S%t,A=K(G,n,t)*u%t,ie=K(A,a,t)*x%t,Q=K(ie,r,t)*l%t,ye=K(Q,Dt,t);if(!We.eql(We.sqr(ye),e))throw new Error("Cannot find square root");return ye}var We=Se(Qe.p,{sqrt:bs}),ve=Pn(Qe,{Fp:We,endo:ms});var qn={};function Fe(e,...t){let n=qn[e];if(n===void 0){let r=ue(yn(e));n=ae(r,r),qn[e]=n}return ue(ae(n,...t))}var Mt=e=>e.toBytes(!0).slice(1),Pt=e=>e%Dt===ys;function Lt(e){let{Fn:t,BASE:n}=ve,r=t.fromBytes(e),s=n.multiply(r);return{scalar:Pt(s.y)?r:t.neg(r),bytes:Mt(s)}}function Hn(e){let t=We;if(!t.isValidNot0(e))throw new Error("invalid x: Fail if x \\u2265 p");let n=t.create(e*e),r=t.create(n*e+BigInt(7)),s=t.sqrt(r);Pt(s)||(s=t.neg(s));let o=ve.fromAffine({x:e,y:s});return o.assertValidity(),o}var Me=we;function Gn(...e){return ve.Fn.create(Me(Fe("BIP0340/challenge",...e)))}function Un(e){return Lt(e).bytes}function xs(e,t,n=Ce(32)){let{Fn:r}=ve,s=C(e,void 0,"message"),{bytes:o,scalar:a}=Lt(t),i=C(n,32,"auxRand"),c=r.toBytes(a^Me(Fe("BIP0340/aux",i))),l=Fe("BIP0340/nonce",c,o,s),{bytes:u,scalar:d}=Lt(l),p=Gn(u,o,s),g=new Uint8Array(64);if(g.set(u,0),g.set(r.toBytes(r.create(d+p*a)),32),!jn(g,s,o))throw new Error("sign: Invalid signature produced");return g}function jn(e,t,n){let{Fp:r,Fn:s,BASE:o}=ve,a=C(e,64,"signature"),i=C(t,void 0,"message"),c=C(n,32,"publicKey");try{let l=Hn(Me(c)),u=Me(a.subarray(0,32));if(!r.isValidNot0(u))return!1;let d=Me(a.subarray(32,64));if(!s.isValidNot0(d))return!1;let p=Gn(s.toBytes(u),Mt(l),i),g=o.multiplyUnsafe(d).add(l.multiplyUnsafe(s.neg(p))),{x,y:S}=g.toAffine();return!(g.is0()||!Pt(S)||x!==u)}catch{return!1}}var le=(()=>{let n=(r=Ce(48))=>$n(r,Qe.n);return{keygen:Ct(n,Un),getPublicKey:Un,sign:xs,verify:jn,Point:ve,utils:{randomSecretKey:n,taggedHash:Fe,lift_x:Hn,pointToBytes:Mt},lengths:{secretKey:32,publicKey:32,publicKeyHasPrefix:!1,signature:64,seed:48}}})();var pi=new TextDecoder("utf-8"),ws=new TextEncoder;function Ss(e){if(e.length!==64)return!1;for(let t=0;t<64;t++){let n=e.charCodeAt(t);if(isNaN(n)||n<48||n>102||n>57&&n<97)return!1}return!0}var _e=Symbol("verified"),Es=e=>e instanceof Object;function vs(e){if(!Es(e)||typeof e.kind!="number"||typeof e.content!="string"||typeof e.created_at!="number"||typeof e.pubkey!="string"||!Ss(e.pubkey)||!Array.isArray(e.tags))return!1;for(let t=0;t<e.tags.length;t++){let n=e.tags[t];if(!Array.isArray(n))return!1;for(let r=0;r<n.length;r++)if(typeof n[r]!="string")return!1}return!0}var _s=class{generateSecretKey(){return le.utils.randomSecretKey()}getPublicKey(e){return W(le.getPublicKey(e))}finalizeEvent(e,t){let n=e;return n.pubkey=W(le.getPublicKey(t)),n.id=qt(n),n.sig=W(le.sign(te(qt(n)),t)),n[_e]=!0,n}verifyEvent(e){if(typeof e[_e]=="boolean")return e[_e];try{let t=qt(e);if(t!==e.id)return e[_e]=!1,!1;let n=le.verify(te(e.sig),te(t),te(e.pubkey));return e[_e]=n,n}catch{return e[_e]=!1,!1}}};function ks(e){if(!vs(e))throw new Error("can\'t serialize event with wrong or missing properties");return JSON.stringify([0,e.pubkey,e.created_at,e.kind,e.tags,e.content])}function qt(e){let t=ue(ws.encode(ks(e)));return W(t)}var et=new _s,zn=et.generateSecretKey,Ut=et.getPublicKey,Kn=et.finalizeEvent,Zn=et.verifyEvent;var Pe=class{constructor(t){this.onEvent=t}buffer="";data=[];event="";id;push(t){this.buffer+=t;let n=this.buffer.search(/\\r\\n|\\r|\\n/);for(;n!==-1;){let r=this.buffer.slice(0,n),s=this.buffer.startsWith(`\\r\n`,n)?2:1;this.buffer=this.buffer.slice(n+s),this.line(r),n=this.buffer.search(/\\r\\n|\\r|\\n/)}}end(){this.buffer&&this.line(this.buffer),this.buffer="",this.line("")}line(t){if(t===""){this.data.length&&this.onEvent({event:this.event||"message",data:this.data.join(`\n`),...this.id!==void 0&&{id:this.id}}),this.data=[],this.event="";return}if(t.startsWith(":"))return;let n=t.indexOf(":"),r=n===-1?t:t.slice(0,n),s=n===-1?"":t.slice(n+1);s.startsWith(" ")&&(s=s.slice(1)),r==="data"?this.data.push(s):r==="event"?this.event=s:r==="id"&&(this.id=s)}};function Vn(e){let t=[],n=new Pe(r=>t.push(r));return n.push(e),n.end(),t}var Rs="databricks-buzz-plugins/0.1.0",Ht=class extends Error{constructor(n,r,s,o){super(s);this.status=n;this.errorCode=r;this.body=o;this.name="DatabricksApiError"}get isPermission(){return this.status===403||this.errorCode==="PERMISSION_DENIED"}get isNotFound(){return this.status===404||this.errorCode==="RESOURCE_DOES_NOT_EXIST"||this.errorCode==="NOT_FOUND"}get isFeatureDisabled(){return this.errorCode==="FEATURE_DISABLED"||this.errorCode==="NOT_IMPLEMENTED"||/not enabled|feature.*disabled|preview/i.test(this.message)}};function tt(e){let t,n=`Databricks returned HTTP ${e.status}`;try{let r=JSON.parse(e.body);t=r.error_code??(typeof r.error=="object"?r.error?.code:void 0),n=r.message??(typeof r.error=="object"?r.error?.message:r.error)??r.error_description??n}catch{let r=e.body.trim();r&&r.length<400&&!r.startsWith("<")&&(n=r)}return new Ht(e.status,t,n,e.body)}var Ts=new Set(["GET","HEAD","PUT","DELETE"]),As=(e,t)=>new Promise((n,r)=>{let s=setTimeout(n,e);t?.addEventListener("abort",()=>{clearTimeout(s),r(t.reason)},{once:!0})}),nt=class{constructor(t){this.options=t;this.host=t.host.replace(/\\/+$/,""),this.workspaceId=t.workspaceId}host;workspaceId;url(t,n){let r=new URL(/^https:\\/\\//.test(t)?t:`${this.host}${t.startsWith("/")?"":"/"}${t}`);for(let[s,o]of Object.entries(n??{}))o!==void 0&&r.searchParams.set(s,String(o));return r.toString()}async request(t,n={},r){let s=n.method??(n.body===void 0?"GET":"POST"),o=n.body===void 0?void 0:typeof n.body=="string"?n.body:JSON.stringify(n.body),a=async c=>{let l=await this.options.token({force:c});return this.options.transport({url:this.url(t,n.query),method:s,headers:{Authorization:`Bearer ${l}`,"User-Agent":this.options.userAgent??Rs,Accept:"application/json",...o!==void 0&&{"Content-Type":"application/json"},...this.workspaceId&&{"X-Databricks-Workspace-Id":this.workspaceId},...n.headers},...o!==void 0&&{body:o},...n.timeoutMs!==void 0&&{timeoutMs:n.timeoutMs},...n.signal&&{signal:n.signal},...r&&{onBody:r}})},i=await a(!1);i.status===401&&(i=await a(!0));for(let c=0;c<3&&(i.status===429||i.status===503)&&Ts.has(s)&&!r;c++){let l=Number(i.headers["retry-after"]);await As(Number.isFinite(l)&&l>0?Math.min(l*1e3,2e4):500*2**c+Math.random()*250,n.signal),i=await a(!1)}return i}async json(t,n={}){let r=await this.request(t,n);if(r.status<200||r.status>=300)throw tt(r);return r.body.trim()?JSON.parse(r.body):{}}get(t,n={}){return this.json(t,{...n,method:"GET"})}post(t,n,r={}){return this.json(t,{...r,method:"POST",body:n??{}})}async stream(t,n,r){let s=new Pe(r),o=!0,a=await this.request(t,{...n,headers:{Accept:"text/event-stream",...n.headers}},i=>{o&&s.push(i)});if(a.status<200||a.status>=300)throw o=!1,tt(a);return s.end(),a}};var Yn="2025-06-18",rt=class extends Error{constructor(n,r,s){super(n);this.code=r;this.data=s;this.name="McpError"}},Gt=e=>`/ai-gateway/mcp-services/${e}`,ke=class{constructor(t,n,r={}){this.client=t;this.path=n;this.query=r}session;initializing;nextId=1;toolsCache;serverInfo;instructions;async listTools(t){if(this.toolsCache&&Date.now()-this.toolsCache.at<5*6e4)return this.toolsCache.tools;let n=[],r;do{let s=await this.call("tools/list",r?{cursor:r}:{},t);n.push(...s.tools??[]),r=s.nextCursor}while(r);return this.toolsCache={at:Date.now(),tools:n},n}callTool(t,n,r={}){return this.call("tools/call",{name:t,arguments:n,...r.meta&&{_meta:r.meta}},r.signal,r.timeoutMs)}async readResource(t,n){return await this.call("resources/read",{uri:t},n)}async ensureSession(t){this.session||(this.initializing??=(async()=>{let n=await this.send({jsonrpc:"2.0",id:this.nextId++,method:"initialize",params:{protocolVersion:Yn,capabilities:{},clientInfo:{name:"databricks-buzz-plugins",version:"0.1.0"}}},t,!0);this.serverInfo=n?.serverInfo,this.instructions=n?.instructions,await this.send({jsonrpc:"2.0",method:"notifications/initialized"},t).catch(()=>{})})().finally(()=>{this.initializing=void 0}),await this.initializing)}async call(t,n,r,s){await this.ensureSession(r);try{return await this.send({jsonrpc:"2.0",id:this.nextId++,method:t,params:n},r,!1,s)}catch(o){if(o.status===404&&this.session)return this.session=void 0,await this.ensureSession(r),this.send({jsonrpc:"2.0",id:this.nextId++,method:t,params:n},r,!1,s);throw o}}async send(t,n,r=!1,s=12e4){let o=await this.client.request(this.path,{method:"POST",query:this.query,body:t,timeoutMs:s,...n&&{signal:n},headers:{Accept:"application/json, text/event-stream",...!r&&{"MCP-Protocol-Version":Yn},...this.session&&{"Mcp-Session-Id":this.session}}}),a=o.headers["mcp-session-id"];if(a&&(this.session=a),t.id===void 0||o.status===202)return;if(o.status<200||o.status>=300)throw tt(o);let c=(o.headers["content-type"]??"").includes("text/event-stream")?Vn(o.body).map(l=>l.data):[o.body];for(let l of c){let u;try{u=JSON.parse(l)}catch{continue}if(u.id===t.id){if(u.error)throw new rt(u.error.message??"MCP error",u.error.code,u.error.data);return u.result}}throw new rt(`No response to ${t.method}`)}};function ge(e){return(e.content??[]).map(t=>t.type==="text"?String(t.text):"").filter(Boolean).join(`\n\n`)}function Re(e){if(e.structuredContent!==void 0)return e.structuredContent;for(let t of e.content??[]){if(t.type!=="text")continue;let n=String(t.text).trim();if(!(!n.startsWith("{")&&!n.startsWith("[")))try{return JSON.parse(n)}catch{}}}var $s="system.ai.genie_one_mcp",Is=3e3,Bs=3,Os=e=>e==null?null:typeof e=="object"?JSON.stringify(e):String(e);function Ns(e){if(!e.ready||!e.columns?.length)return;let t=(e.rows??[]).map(r=>r.map(Os)),n=e.total_row_count??void 0;return He(e.columns.map(r=>({name:r.name,...r.type_text&&{type:r.type_text}})),t,{...n!==void 0&&{totalRows:n},truncated:!!e.truncated||n!==void 0&&n>t.length})}var Cs=e=>e.replace(/<!--[\\s\\S]*?--\\s*>/g,"").replace(/\\n{3,}/g,`\n\n`).trim();function Wn(e){return Cs(e).replace(/\\s*:citation\\[[^\\]]*\\]/g,"").replace(/\\s*\\[Query Result\\]\\([^)\\s]*#embed-[^)\\s]*\\)/g,"").replace(/\\s*\\[Knowledge snippets?\\]\\([^)]*\\)/gi,"").replace(/([.!?)])[ \\t]+Knowledge snippets?(?=[ \\t]*(\\n|$))/gi,"$1").replace(/`([^`]+)`\\s*\\[\\1\\]\\(/g,"[$1](").replace(/[ \\t]+$/gm,"").trim()}function Ds(e){let t=String.raw`(?:charts?|graphs?|plots?|visuali[sz]ations?)`,n=r=>/^[ \\t]*/.exec(r)?.[0]??"";return e.replace(new RegExp(String.raw`[^.!?\\n]*\\b(?:can(?:\'|\u2019)?t|cannot|can not|unable to|not able to)\\b[^.!?\\n]*\\b${t}\\b[^.!?\\n]*[.!?][ \\t]*`,"gi"),n).replace(new RegExp(String.raw`[^.!?\\n]*\\b(?:to (?:turn|make|build|create) (?:this|it|these|the results?) into an? ${t}|you can (?:chart|plot|graph) (?:this|it|them|directly))\\b[^.!?\\n]*[.!?][ \\t]*`,"gi"),n).replace(/[ \\t]+$/gm,"").replace(/\\n{3,}/g,`\n\n`).trim()}var Xn=e=>e.trim().replace(/^\\|/,"").replace(/\\|$/,"").split("|").map(t=>t.replace(/\\*\\*|__|`/g,"").trim()),Jn=e=>e.toLowerCase().replace(/[^a-z0-9]/g,"");function Fn(e,t=200){let n=Wn(e.text).split(`\n`),r=[...e.results],s=(l,u)=>{let d=l.map(Jn).join("|"),p=r.findIndex(g=>g.columns.map(x=>Jn(x.name)).join("|")===d);return p<0&&(p=r.findIndex(g=>g.columns.length===l.length&&g.rows.length===u)),p<0?void 0:r.splice(p,1)[0]},o=[],a=0,i=/^\\s*\\|.*\\|\\s*$/;for(let l=0;l<n.length;l++){if(i.test(n[l]??"")&&/^\\s*\\|?\\s*:?-{2,}/.test(n[l+1]??"")){let u=Xn(n[l]??""),d=[];for(l+=2;l<n.length&&i.test(n[l]??"");l++)d.push(Xn(n[l]??"").map(g=>g||null));l--;let p=s(u,d.length)??He(u.map(g=>({name:g})),d);o.push("",Be(p,t),""),a++;continue}o.push(n[l]??"")}let c=o.join(`\n`).replace(/\\n{3,}/g,`\n\n`).trim();if(!a){let l=e.results[e.results.length-1];l?.columns.length&&(l.rows.length>1||!c)&&(c=[c,Be(l,t)].filter(Boolean).join(`\n\n`),a++)}return a?Ds(c):c}var Ls=(e,t)=>new Promise((n,r)=>{let s=setTimeout(n,e);t?.addEventListener("abort",()=>{clearTimeout(s),r(t.reason)},{once:!0})}),Te=class{constructor(t){this.service=t}clients=new Map;availability=new Map;async mcp(){let t=await this.service.ready(),n=this.service.snapshot(),r=n.status==="connected"?n.workspaceId??n.profile.workspaceId:void 0,s=`${t.host}|${r??""}`,o=this.clients.get(s);return o||(o=new ke(t,Gt($s),r?{o:r}:{}),this.clients.set(s,o)),o}available(){let t=this.service.snapshot(),n=t.status==="connected"?t.profile.host:"none",r=this.availability.get(n);return r||(r=this.mcp().then(s=>s.listTools()).then(s=>s.some(o=>o.name==="genie_ask")).catch(()=>!1).then(s=>(s||this.availability.delete(n),s)),this.availability.set(n,r)),r}async ask(t,n={}){let{signal:r}=n,s=await this.mcp(),o=await s.callTool("genie_ask",{question:t,...n.conversationId&&{conversation_id:n.conversationId}},{...r&&{signal:r},timeoutMs:17e4});if(o.isError)throw new Error(ge(o)||"Genie One couldn\'t take the question.");let a=Re(o)??{},i=a.conversation_id??n.conversationId??"",c=a.response_id??"";if(!i||!c)throw new Error("Genie One didn\'t return a conversation.");let l=a,u=ge(o),d=0,p=[],g=Date.now()+10*6e4;try{for(;!l.status||l.status==="in_progress"||l.status==="unknown"&&d<5;){if(Date.now()>g)throw new Error("Genie One didn\'t finish within 10 minutes.");await Ls(Is,r);let v=await s.callTool("genie_poll_response",{conversation_id:i,response_id:c},{...r&&{signal:r},timeoutMs:6e4});if(v.isError)throw new Error(ge(v)||"Genie One failed.");l=Re(v)??{status:"unknown"},u=ge(v),d=l.status==="unknown"?d+1:0,l.progress_steps?.length&&(p=l.progress_steps,n.onProgress?.(p))}}catch(v){throw r?.aborted&&s.callTool("genie_cancel_response",{conversation_id:i}).catch(()=>{}),v}if(l.status==="failed")throw new Error(u.trim()||"Genie One couldn\'t answer that.");let x=(l.query_items??[]).slice(0,Bs),S=(await Promise.all(x.map(v=>s.callTool("genie_get_query_result",{conversation_id:i,response_id:c,item_id:v.item_id},{...r&&{signal:r},timeoutMs:6e4}).then(D=>D.isError?void 0:Ns(Re(D)??{})).catch(()=>{})))).filter(v=>v!==void 0);return{conversationId:i,responseId:c,status:l.status??"completed",text:(l.final_answer??"").trim(),markdown:u.trim(),steps:p,results:S,sql:x.flatMap(v=>v.sql?[v.sql]:[]),...l.deep_link&&{deepLink:l.deep_link}}}format(t){let n=["Genie One",`conversation_id: ${t.conversationId}`];t.status==="incomplete"&&n.push("(Genie One stopped before finishing; the answer may be partial.)");let r=Wn(t.text);if(r)n.push("",r);else for(let s of t.results)n.push("",Ge(s,20));for(let s of t.sql.slice(0,2))n.push("","SQL Genie One ran:","```sql",s.trim(),"```");return t.deepLink&&n.push("",`[Explore in Databricks](${t.deepLink})`),n.join(`\n`)}};var Ae="/home/sandbox-agent";var Ms=`${Ae}/.buzz/agent/runner.mjs`,de="dbx",jt=54,zt=(e,t)=>["node",e,"mcp",t],Ps=`// Databricks tools for Pi, written by the Databricks Agents plugin for Buzz.\nimport { spawn } from "node:child_process";\nimport { createInterface } from "node:readline";\n\nexport default async function (pi) {\n  let command = [];\n  try {\n    command = JSON.parse(process.env.BUZZ_TOOLS_BRIDGE || "[]");\n  } catch {}\n  if (!command.length) return;\n  const child = spawn(command[0], command.slice(1), { stdio: ["pipe", "pipe", "inherit"] });\n  const pending = new Map();\n  let next = 1;\n  // The bridge keeps Pi running only while a request waits on it, so Pi can exit when it\'s done.\n  const hold = (on) => {\n    for (const handle of [child, child.stdin, child.stdout]) on ? handle.ref?.() : handle.unref?.();\n  };\n  const settle = () => pending.size || hold(false);\n  const fail = (error) => {\n    for (const waiting of pending.values()) waiting.reject(error);\n    pending.clear();\n    settle();\n  };\n  child.on("error", fail);\n  child.on("exit", () => fail(new Error("The Databricks tools stopped.")));\n  createInterface({ input: child.stdout }).on("line", (line) => {\n    let message;\n    try {\n      message = JSON.parse(line);\n    } catch {\n      return;\n    }\n    const waiting = pending.get(message.id);\n    if (!waiting) return;\n    pending.delete(message.id);\n    settle();\n    if (message.error) waiting.reject(new Error(message.error.message || "The tool failed."));\n    else waiting.resolve(message.result);\n  });\n  const send = (message) => child.stdin.write(JSON.stringify(message) + "\\\\n");\n  const request = (method, params, signal) =>\n    new Promise((resolve, reject) => {\n      const id = next++;\n      pending.set(id, { resolve, reject });\n      hold(true);\n      send({ jsonrpc: "2.0", id, method, params });\n      signal?.addEventListener(\n        "abort",\n        () => {\n          if (!pending.delete(id)) return;\n          settle();\n          send({ jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: id } });\n          reject(new Error("Stopped."));\n        },\n        { once: true },\n      );\n    });\n  const stop = () => child.kill();\n  pi.on("session_shutdown", stop);\n  process.on("exit", stop);\n  try {\n    await request("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "pi", version: "1" } });\n    send({ jsonrpc: "2.0", method: "notifications/initialized" });\n    const { tools = [] } = await request("tools/list", {});\n    for (const tool of tools)\n      pi.registerTool({\n        name: tool.name,\n        label: tool.title || tool.name,\n        description: tool.description || tool.name,\n        parameters: tool.inputSchema || { type: "object", properties: {} },\n        async execute(_id, params, signal) {\n          const result = await request("tools/call", { name: tool.name, arguments: params ?? {} }, signal);\n          const text = (result?.content ?? []).filter((part) => part.type === "text").map((part) => part.text).join("\\\\n") || JSON.stringify(result?.structuredContent ?? {});\n          if (result?.isError) throw new Error(text);\n          return { content: [{ type: "text", text }], details: {} };\n        },\n      });\n  } catch (error) {\n    console.error("Databricks tools unavailable: " + (error?.message ?? error));\n  }\n}\n`;function Kt(e,t,n,r){let s=[{path:t.tools,content:`${JSON.stringify(r)}\n`}],[o,...a]=zt(n,t.tools);return e==="claude"&&s.push({path:t.mcp,content:`${JSON.stringify({mcpServers:{[de]:{type:"stdio",command:o,args:a}}})}\n`}),e==="pi"&&s.push({path:t.piTools,content:Ps}),s}var Zt=e=>!!e?.length;var er=[{id:"builtin",label:"Built-in",detail:"Fastest. Uses Buzz\'s tools and the tools you pick, and runs code in the Sandbox when it needs to."},{id:"claude",label:"Claude Code",detail:"Anthropic\'s coding agent, running in the Sandbox with its own tools and the Databricks CLI signed in as you. Keeps its context between turns."},{id:"codex",label:"Codex",detail:"OpenAI\'s coding agent, running in the Sandbox with its own tools and the Databricks CLI signed in as you. Keeps its context between turns."},{id:"pi",label:"Pi",detail:"A small coding agent for Claude, GPT and Gemini models, running in the Sandbox with its own tools. Keeps its context between turns."}],Oi=er.map(e=>e.id);var he=e=>er.find(t=>t.id===e)?.label??e;var tr=["To show a query result or other table, put it in a fenced code block with the language",`\\`${ht}\\` whose body is CSV with a header row (up to 200 rows; quote values that contain commas).`,"Buzz draws it as an interactive chart with a table view, so you can chart data; don\'t say you can\'t.","Put the label column (such as a date or category) first and the numeric columns after it, unformatted (no $ or thousands separators)."].join(" "),Ni=`${Ae}/.buzz/runs`,st=`${Ae}/work`,nr=e=>({dir:e,prompt:`${e}/prompt.md`,system:`${e}/system.md`,events:`${e}/events.jsonl`,stderr:`${e}/stderr.log`,exit:`${e}/exit`,pid:`${e}/pid`,script:`${e}/run.sh`,tools:`${e}/tools.json`,mcp:`${e}/mcp.json`,piTools:`${e}/databricks-tools.mjs`}),M=e=>`\'${e.replace(/\'/g,"\'\\\\\'\'")}\'`,qs="read,grep,find,ls,edit,write";function rr(e){let{model:t,files:n,session:r,tools:s}=e,o=e.permissions==="full",a=s?zt(s.runner,n.tools):void 0;switch(e.harness){case"claude":{if(!r)throw new Error("Claude Code needs a session ID.");return[...a?["MCP_TIMEOUT=120000","MCP_TOOL_TIMEOUT=600000"]:[],"claude","-p","--model",M(t),"--output-format","stream-json","--verbose","--permission-mode",o?"bypassPermissions":"auto",...a?["--mcp-config",M(n.mcp),"--strict-mcp-config",...o?[]:["--allowedTools",`mcp__${de}`]]:[],"--append-system-prompt-file",M(n.system),r.resume?"--resume":"--session-id",M(r.id),"<",M(n.prompt)].join(" ")}case"codex":return["codex","exec",...r?["resume",M(r.id)]:[],"--json","--skip-git-repo-check","-m",M(t),...o?["--dangerously-bypass-approvals-and-sandbox"]:["-c",M(\'sandbox_mode="workspace-write"\'),"-c","sandbox_workspace_write.network_access=true"],...a?["-c",M(`mcp_servers.${de}.command=${JSON.stringify(a[0])}`),"-c",M(`mcp_servers.${de}.args=${JSON.stringify(a.slice(1))}`),"-c",`mcp_servers.${de}.startup_timeout_sec=120`,"-c",`mcp_servers.${de}.tool_timeout_sec=600`,"-c",M(`mcp_servers.${de}.default_tools_approval_mode="approve"`)]:[],"-","<",M(n.prompt)].join(" ");case"pi":{if(!r)throw new Error("Pi needs a session ID.");let i=a?`$(${[...a.slice(0,2),"mcp-names",n.tools].map(M).join(" ")} 2>/dev/null)`:"";return[...a?[`BUZZ_TOOLS_BRIDGE=${M(JSON.stringify(a))}`]:[],"pi","-p","--mode","json","--model",M(t),"--session-id",M(r.id),"--append-system-prompt",M(n.system),...a?["-e",M(n.piTools)]:[],...o?[]:["--tools",`"${qs}${i}"`],M(`@${n.prompt}`),"<","/dev/null"].join(" ")}}}var Us=["command","cmd","file_path","path","pattern","query","url","description","prompt"];function qe(e){if(!(!e||typeof e!="object"))for(let t of Us){let n=e[t];if(typeof n=="string"&&n.trim())return n.length>80?`${n.slice(0,77)}\\u2026`:n}}var Hs=e=>e.replace(/^\\/bin\\/(ba)?sh -lc \'?/,"").replace(/\'$/,""),Qn=e=>Array.isArray(e)?e.filter(t=>!!t&&typeof t=="object"&&t.type==="text"&&typeof t.text=="string").map(t=>t.text).join(""):typeof e=="string"?e:"";function sr(e,t){let n;try{n=JSON.parse(t)}catch{return}if(!(!n||typeof n!="object")){if(e==="claude"){if(n.type==="system"&&n.subtype==="init"&&typeof n.session_id=="string")return{session:n.session_id};if(n.type==="system"&&n.subtype==="api_retry")return{step:{tool:"model",target:`retrying after ${n.error_status??"an error"}${n.error?` (${n.error})`:""}`}};if(n.type==="assistant"&&Array.isArray(n.message?.content)){let r=n.message.content.find(o=>o?.type==="tool_use");if(r)return{step:{tool:String(r.name??"tool"),...qe(r.input)&&{target:qe(r.input)}}};let s=Qn(n.message.content);return s?{text:s}:void 0}if(n.type==="result"){let r=typeof n.result=="string"?n.result:"";return n.is_error||n.subtype&&n.subtype!=="success"?{error:r||String(n.subtype??"Claude Code failed")}:{final:r}}return}if(e==="codex"){if(n.type==="thread.started"&&typeof n.thread_id=="string")return{session:n.thread_id};if(n.type==="turn.failed")return{error:String(n.error?.message??"Codex failed")};let r=n.item;return!r||typeof r!="object"?void 0:n.type==="item.started"?r.type==="command_execution"&&typeof r.command=="string"?{step:{tool:"shell",target:qe({command:Hs(r.command)})}}:r.type==="file_change"?{step:{tool:"edit",...r.changes?.[0]?.path&&{target:String(r.changes[0].path)}}}:r.type==="mcp_tool_call"?{step:{tool:String(r.tool??"tool"),...r.server&&{target:String(r.server)}}}:r.type==="web_search"?{step:{tool:"web search",...r.query&&{target:String(r.query)}}}:void 0:n.type==="item.completed"&&r.type==="agent_message"&&typeof r.text=="string"?{text:r.text}:void 0}if(n.type==="session"&&typeof n.id=="string")return{session:n.id};if(n.type==="tool_execution_start")return{step:{tool:String(n.toolName??"tool"),...qe(n.args)&&{target:qe(n.args)}}};if(n.type==="message_end"&&n.message?.role==="assistant"){if(n.message.stopReason==="error"&&n.message.errorMessage)return{error:String(n.message.errorMessage)};let r=Qn(n.message.content);return r?{text:r}:void 0}}}var Gs=e=>e.replace(/\\x1b\\[[0-9;]*[A-Za-z]/g,"").replace(/[\u2502\u256D\u256E\u2570\u256F\u2500\u2714\u2022]/g,"").trim();function Vt(e){return Gs(e).split(`\n`).map(t=>t.trim()).filter(t=>t&&!/Unity Gateway|Databricks auth already|Launching |Starting |managed coding agent config|token refresh is managed|^is running\\.?$/i.test(t)).slice(-4).join(" ").slice(0,600)}function or(e,t,n=[]){return["<databricks-sandbox>",`You are running as ${he(e)} inside your own Databricks Sandbox, a Linux machine in Databricks with Python, Node.js, git, the Databricks CLI (already signed in as your owner) and internet access. Your working folder is ${st}; files under ${Ae} persist across restarts.`,"Your final message is posted to the Buzz conversation as your reply, so make it the answer itself, written for the people there. You don\'t have Buzz\'s own tools in this session.",e==="pi"&&t==="standard"?"You can read, search and edit files, but you have no shell in this session.":"",n.length?`Your owner gave you these Databricks tools, which run with their access: ${n.map(r=>r.label).join(", ")}. Use them for questions about data (Genie One finds the right tables and runs the SQL). If a tool says your owner hasn\'t logged in yet, give them its login link.`:"","Never print secrets into the conversation.","</databricks-sandbox>"].filter(Boolean).join(`\n`)}var $e=[9,40002],js="buzz.solo",zs=48e3,cr=/^[0-9a-f]{64}$/,Ks=/^[0-9a-f]{128}$/,Zs=/^(kind=|created_at<|created_at>)(0|[1-9][0-9]*)$/,Vs=(e,t)=>e.tags.find(n=>n[0]===t)?.[1],Ys=e=>{let t=Vs(e,"h");return t&&/^[a-zA-Z0-9_-]{1,128}$/.test(t)?t:void 0};function Xs(e){let t,n;for(let r of e.tags)r[0]!=="e"||!cr.test(r[1]??"")||(r[3]==="root"?t=r[1]:r[3]==="reply"&&(n=r[1]));return t??n}var lr=(e,t)=>$e.includes(e.kind)&&e.pubkey!==t&&e.tags.some(n=>n[0]==="p"&&n[1]===t);function Js(e){let t=e.tags.filter(i=>i[0]==="auth");if(t.length!==1)return;let[,n="",r="",s=""]=t[0];if(t[0].length!==4||!cr.test(n)||!Ks.test(s)||n===e.pubkey)return;let o=r?r.split("&"):[];if(!o.every(i=>Zs.test(i)))return;for(let i of o){let c=Number(i.replace(/^[^0-9]+/,""));if(i.startsWith("kind=")&&e.kind!==c||i.startsWith("created_at<")&&!(e.created_at<c)||i.startsWith("created_at>")&&!(e.created_at>c))return}let a=ue(new TextEncoder().encode(`nostr:agent-auth:${e.pubkey}:${r}`));try{return le.verify(Buffer.from(s,"hex"),a,Buffer.from(n,"hex"))?n:void 0}catch{return}}var dr=(e,t)=>e.pubkey===t||Js(e)===t;function ur(e){if(!e)return{solo:!1};let[t,...n]=e.tags.flatMap(r=>r[0]==="t"&&typeof r[1]=="string"?[r[1]]:[]);return{...t&&{type:t},solo:t==="stream"&&n.includes(js)}}function fr(e,t,n){let r=Ys(e);if(!r)return;let s=Xs(e),o=s??e.id,a=n.type==="dm",i=n.solo,c=i||a||t==="channel";return{key:c?r:`${r}/${o}`,channel:r,root:o,topLevel:i,dm:a,fresh:!s&&!c}}function pr(e){return e.fresh?[]:!e.topLevel&&!e.dm&&e.key!==e.channel?[{ids:[e.root],"#h":[e.channel],limit:1},{kinds:$e,"#h":[e.channel],"#e":[e.root],limit:200}]:[{kinds:$e,"#h":[e.channel],limit:13}]}var ir=e=>JSON.stringify(e).replace(/</g,"\\\\u003c").replace(/>/g,"\\\\u003e").replace(/&/g,"\\\\u0026"),ar=(e,t)=>({id:e.id,pubkey:e.pubkey,...t.get(e.pubkey)&&{author:t.get(e.pubkey)},time:new Date(e.created_at*1e3).toISOString(),content:e.content});function gr(e){let{event:t,conversation:n,names:r}=e,s=n.dm?"dm":n.key===n.channel?"channel":"thread",o=[`Scope: ${s}`,`Session scope: ${e.scope==="channel"||n.key===n.channel?"channel":"thread"} conversation`,`Channel: #${n.channel}`,...s==="thread"?[`Thread root: ${n.root}`]:[],`Agent: ${e.agent}`,"Your final message is posted as your reply in this conversation."].join(`\n`),a=s==="thread"?"thread-context":"conversation-context",i=[`<context>\n${o}\n</context>`];e.context.length&&i.push(`<${a} included="${e.context.length}" total="${e.total}" truncated="${e.total>e.context.length}">\n${ir(e.context.map(l=>ar(l,r)))}\n</${a}>`);let c=t.tags.filter(l=>l[0]==="p").map(l=>l[1]);return i.push(`<buzz-event type="@mention">\n${ir({...ar(t,r),channel:n.channel,kind:t.kind,...n.root!==t.id&&{thread:n.root},...c.length&&{mentions:c}})}\n</buzz-event>`),i.join(`\n\n`)}var Yt=e=>e.replace(/\\[([^\\]]*)\\]\\(nostr:[^)]+\\)/g,"").replace(/nostr:(npub|nprofile|note|nevent)1[0-9a-z]+/g,"").replace(/^\\s*@\\S+\\s*/,"").replace(/[ \\t]+/g," ").trim();function hr(e,t=zs){let n=o=>Buffer.byteLength(o);if(n(e)<=t)return[e];let r=[],s=e;for(;n(s)>t;){let o=t;for(;n(s.slice(0,o))>t;)o=Math.floor(o*.9);let a=s.slice(0,o),i=Math.max(a.lastIndexOf(`\n\n`),a.lastIndexOf(`\n`)),c=i>o/2?i:o;r.push(s.slice(0,c).trimEnd()),s=s.slice(c).trimStart()}return s&&r.push(s),r}function mr(e){return{kind:9,created_at:Math.floor(Date.now()/1e3),content:e.content,tags:[["h",e.conversation.channel],...e.conversation.topLevel?[]:[["e",e.conversation.root,"","reply"]],...e.notify?[["p",e.notify]]:[],[...e.authTag]]}}function Xt(e){return{kind:0,created_at:Math.floor(Date.now()/1e3),content:JSON.stringify({name:e.name,display_name:e.name,bot:!0,...e.picture&&{picture:e.picture},...e.about&&{about:e.about}}),tags:[[...e.authTag]]}}import{readFileSync as oo}from"node:fs";import{createInterface as io}from"node:readline";var yr=e=>`/mcp-service-login?name=${encodeURIComponent(e)}`,br=e=>/HTTP 401|requires authentication|not logged in|login first|Credential for user identity/i.test(e?.message??String(e));function ot(e){return((e.label||e.id).toLowerCase().replace(/[^a-z0-9]+/g,"_").replace(/^_+|_+$/g,"")||"mcp").slice(0,20).replace(/_+$/,"")}var Ws="Note: these results came from the owner\'s Databricks access. Everyone in this conversation can read what you post, so share only what this audience should see.";function xr(e,t,n,r){let s=[`Genie agent: ${e.title} (${e.space_id})`,`conversation_id: ${t.message.conversation_id}`,`status: ${t.message.status}`];return t.error&&s.push(`error: ${t.error}`),t.text&&s.push("",t.text),t.result?s.push("",Ge(t.result,r)):t.rowCount!==void 0&&s.push("",`(The query returned ${t.rowCount} rows; the result could not be fetched.)`),t.sql&&s.push("","SQL:","```sql",t.sql.trim(),"```"),t.suggestions.length&&s.push("",`Follow-ups Genie suggests: ${t.suggestions.slice(0,3).join(" | ")}`),n&&s.push("",`Open in Genie: ${n}`),s.push("",Ws),s.join(`\n`)}var Fs=/^[a-zA-Z0-9_-]{1,64}$/;function Sr(e){return Array.isArray(e)?e.flatMap(t=>{let n=t;return typeof n?.id!="string"||typeof n.label!="string"||typeof n.kind!="string"?[]:["service","connection","functions"].includes(n.kind)&&!(typeof n.path=="string"&&n.path.startsWith("/"))?[]:[{id:n.id,kind:n.kind,label:n.label,...n.path&&{path:n.path}}]}):[]}var wr=(e,t)=>(e.toLowerCase().replace(/[^a-z0-9]+/g,"_").replace(/^_+|_+$/g,"")||"x").slice(0,t).replace(/_+$/,""),Qs=e=>{let t=e.snapshot();return t.status==="connected"?t.workspaceId??t.profile.workspaceId:void 0};function eo(e,t){let n=new AbortController,r=setTimeout(()=>n.abort(new Error(`No answer within ${t/1e3} seconds`)),t),s=()=>n.abort(e.reason);return e.aborted?s():e.addEventListener("abort",s,{once:!0}),n.signal.addEventListener("abort",()=>clearTimeout(r),{once:!0}),n.signal}function Er(e,t){let n=[],r=new Set;for(let s of t)if(s.kind==="genie-one"){let o=new Te(e);n.push({name:"genie_one_ask",description:"Asks Genie One, Databricks\' assistant for questions about any data the owner can access in this agent\'s workspace. It finds the tables, writes and runs the SQL, and answers with numbers, a table and a link. Pass conversation_id from an earlier answer to follow up. Answers can take a minute.",parameters:{type:"object",properties:{question:{type:"string",description:"The question, in plain language."},conversation_id:{type:"string"}},required:["question"]},run:async(a,i)=>{let c=typeof a.conversation_id=="string"&&a.conversation_id?a.conversation_id:void 0;return o.format(await o.ask(String(a.question??""),{signal:i,...c&&{conversationId:c}}))}})}else if(s.kind==="genie"){let o=s.id.replace(/^genie:/,""),a=`genie_${wr(s.label,40)}_ask`;for(let i=2;r.has(a);i++)a=`genie_${wr(s.label,36)}_${i}_ask`;r.add(a),n.push({name:a,description:`Asks the "${s.label}" Genie agent, curated by the owner\'s data team, a question about its data. It answers with an explanation, a table and the SQL. Pass conversation_id to follow up.`,parameters:{type:"object",properties:{question:{type:"string",description:"The question, in plain language."},conversation_id:{type:"string"}},required:["question"]},run:async(i,c)=>{let l=await e.ready(c),u=typeof i.conversation_id=="string"&&i.conversation_id?i.conversation_id:void 0,d=await new ne(l).answer(o,String(i.question??""),{signal:c,...u&&{conversationId:u}});return xr({title:s.label,space_id:o},d,e.workspaceUrl(ne.webPath(o,d.message.conversation_id)),30)}})}return n}async function vr(e,t,n){let r=t.filter(d=>d.path);if(!r.length)return{tools:[],problems:[],failures:[]};let s=await e.ready(n),o=Qs(e),a=[],i=[],c=await Promise.all(r.map(async d=>{let p=d.path.startsWith("/ai-gateway/")&&o?{o}:{},g=new ke(s,d.path,p);try{let x=await g.listTools(eo(n,3e4));return{server:d,mcp:g,tools:x}}catch(x){let S=d.kind==="service"&&br(x)?e.workspaceUrl(yr(d.id.replace(/^service:/,""))):void 0;return i.push({server:d,message:x.message??String(x),...S&&{login:S}}),a.push(S?`${d.label}: your owner isn\'t logged in to ${d.label} yet. Ask them to log in at ${S}, then try again`:`${d.label}: ${x.message??x}`),{server:d,mcp:g,tools:[]}}})),l=[],u=new Set;for(let{server:d,mcp:p,tools:g}of c){let x=ot(d);for(let S of g){let v=`${x}__${S.name}`.replace(/[^a-zA-Z0-9_-]/g,"_").slice(0,64);for(let D=2;u.has(v);D++)v=`${v.slice(0,60)}_${D}`;Fs.test(v)&&(u.add(v),l.push({name:v,description:`[${d.label}] ${S.description??S.title??S.name}`.slice(0,4e3),parameters:S.inputSchema??{type:"object",properties:{}},run:async(D,G)=>{let A=await p.callTool(S.name,D,{signal:G,timeoutMs:17e4}),Q=ge(A)||(A.structuredContent!==void 0?JSON.stringify(Re(A)):"OK");return A.isError?`Error from ${d.label}: ${Q}`:Q}}))}}return{tools:l,problems:a,failures:i}}import{readFileSync as to}from"node:fs";import{homedir as no}from"node:os";import{join as ro}from"node:path";function _r(){let e=to(ro(no(),".databrickscfg"),"utf8"),t="",n={};for(let r of e.split(`\n`)){let s=r.trim(),o=/^\\[(.+)\\]$/.exec(s);if(o){t=o[1];continue}let a=/^([a-z_]+)\\s*=\\s*(.*)$/.exec(s);a&&t==="DEFAULT"&&(n[a[1]]=a[2])}if(!n.host||!n.token)throw new Error("The Sandbox has no Databricks credential.");return{host:n.host.replace(/\\/+$/,""),token:n.token}}async function so(e){let t=new AbortController,n=setTimeout(()=>t.abort(new DOMException("Timed out","TimeoutError")),e.timeoutMs??6e4),r=()=>t.abort(e.signal?.reason);e.signal?.addEventListener("abort",r,{once:!0});try{let s=await fetch(e.url,{method:e.method??"GET",...e.headers&&{headers:e.headers},...e.body!==void 0&&{body:e.body},signal:t.signal}),o={};s.headers.forEach((i,c)=>o[c.toLowerCase()]=i);let a="";if(s.body){let i=new TextDecoder,c=s.body.getReader();for(;;){let{done:u,value:d}=await c.read();if(u)break;let p=i.decode(d,{stream:!0});a+=p,e.onBody?.(p)}let l=i.decode();l&&(a+=l,e.onBody?.(l))}return{status:s.status,headers:o,body:a}}finally{clearTimeout(n),e.signal?.removeEventListener("abort",r)}}function it(e){let{host:t}=_r(),n=new nt({host:t,transport:so,token:async()=>_r().token}),r={status:"connected",...e&&{workspaceId:e},profile:{name:"DEFAULT",host:t,...e&&{workspaceId:e}},user:{userName:""},profiles:[]};return{version:1,snapshot:()=>r,subscribe:()=>()=>{},client:()=>n,ready:async()=>n,workspaceUrl:o=>new URL(o,t).toString(),profiles:()=>[],openSettings:()=>{},signIn:async()=>{},preferences:{get:()=>{},set:()=>{},subscribe:()=>()=>{}}}}var kr={type:"object",properties:{}};function ao(e){let{server:t}=e,n=ot(t);return e.login?{name:`${n}__log_in`,description:`[${t.label}] Not available yet: your owner hasn\'t logged in to ${t.label}. If you need it, give them this link to log in, then try again: ${e.login}`,parameters:kr,run:async()=>`Ask your owner to log in to ${t.label} at ${e.login}, then try again.`}:{name:`${n}__unavailable`,description:`[${t.label}] Didn\'t start this time: ${e.message.slice(0,300)}`,parameters:kr,run:async()=>`${t.label} isn\'t available right now: ${e.message}`}}async function Jt(e,t){let n=JSON.parse(oo(e,"utf8")),r=Sr(n.tools),s=it(n.workspaceId),o=await vr(s,r,t),a=new Set;return[...Er(s,r),...o.tools,...o.failures.map(ao)].map(i=>{let c=i.name.slice(0,jt);for(let l=2;a.has(c);l++)c=`${i.name.slice(0,jt-4)}_${l}`;return a.add(c),c===i.name?i:{...i,name:c}})}function Rr(e,t=n=>console.error(n)){let n=Jt(e,AbortSignal.timeout(12e4)).catch(i=>(t(`tools bridge: couldn\'t list the tools: ${i.message??i}`),[])),r=new Map,s=i=>process.stdout.write(`${JSON.stringify({jsonrpc:"2.0",...i})}\n`),o=(i,c=!1)=>({content:[{type:"text",text:i}],...c&&{isError:c}});async function a(i){let{id:c,method:l,params:u}=i;if(l==="notifications/cancelled")return r.get(u?.requestId)?.abort();if(c!==void 0)switch(l){case"initialize":return s({id:c,result:{protocolVersion:u?.protocolVersion??"2025-06-18",capabilities:{tools:{}},serverInfo:{name:"databricks",version:"1"}}});case"ping":return s({id:c,result:{}});case"tools/list":return s({id:c,result:{tools:(await n).map(d=>({name:d.name,description:d.description,inputSchema:d.parameters}))}});case"tools/call":{let d=(await n).find(g=>g.name===u?.name);if(!d)return s({id:c,result:o(`There\'s no Databricks tool named ${String(u?.name)}.`,!0)});let p=new AbortController;r.set(c,p);try{return s({id:c,result:o(await d.run(u?.arguments??{},p.signal))})}catch(g){return s({id:c,result:o(`Error: ${g.message??g}`,!0)})}finally{r.delete(c)}}default:return s({id:c,error:{code:-32601,message:`Unknown method: ${l}`}})}}return new Promise(i=>{let c=io({input:process.stdin});c.on("line",l=>{let u;try{u=JSON.parse(l)}catch{return}a(u).catch(d=>u.id!==void 0&&s({id:u.id,error:{code:-32603,message:d.message??String(d)}}))}),c.on("close",()=>{for(let l of r.values())l.abort();i()})})}import{spawn as ho}from"node:child_process";import{mkdirSync as Br,rmSync as Or,writeFileSync as ut}from"node:fs";import{join as mo}from"node:path";import{createInterface as yo}from"node:readline";import{chmodSync as co,existsSync as Tr,mkdirSync as lo,readFileSync as uo,renameSync as fo,rmSync as pa,statSync as po,writeFileSync as Ar}from"node:fs";import{homedir as go}from"node:os";import{join as Z}from"node:path";var oe=process.env.BUZZ_AGENT_DIR??Z(go(),".buzz","agent"),at=process.env.BUZZ_AGENT_RUN_DIR??(process.env.BUZZ_AGENT_DIR?Z(oe,"run"):"/tmp/buzz-agent"),B={key:Z(oe,"key.json"),config:Z(oe,"config.json"),state:Z(oe,"state.json"),turns:Z(at,"turns"),pid:Z(at,"runner.pid"),started:Z(at,"started"),log:Z(oe,"runner.log"),status:Z(oe,"status.json"),awake:Z(oe,"awake"),runs:Z(oe,"runs")};function Wt(){for(let e of[oe,at,B.turns,B.runs])lo(e,{recursive:!0,mode:448});Tr(B.started)||Ar(B.started,"")}function $r(){try{return new Date(po(B.started).mtimeMs).toISOString()}catch{return}}function Ft(e,t){try{return JSON.parse(uo(e,"utf8"))}catch{return t}}function ct(e,t,n=384){let r=`${e}.tmp`;Ar(r,`${JSON.stringify(t,null,2)}\n`,{mode:n}),fo(r,e),co(e,n)}var lt=()=>Ft(B.config,void 0),Qt=()=>({sessions:{},since:0,handled:[],...Ft(B.state,{})}),en=e=>ct(B.state,{...e,handled:e.handled.slice(-500)});function dt(){let e=Ft(B.key,void 0);return e?.secret&&/^[0-9a-f]{64}$/.test(e.secret)?Uint8Array.from(Buffer.from(e.secret,"hex")):void 0}function Ir(e){if(Tr(B.key))throw new Error("This Sandbox already has an agent key.");ct(B.key,{secret:Buffer.from(e).toString("hex")})}var Ue=e=>Z(B.turns,Buffer.from(e).toString("base64url"));var bo=e=>/no conversation found|no (saved )?session|session[^.]* not found|thread[^.]* not found|no rollout found/i.test(e);async function tn(e){try{return await Nr(e)}catch(t){if(!e.session||e.signal.aborted||!bo(t.message))throw t;let{session:n,...r}=e;return Nr(r)}}function Nr(e){let{harness:t}=e,n=crypto.randomUUID(),r=mo(B.runs,`${Date.now().toString(36)}-${n.slice(0,8)}`);Br(r,{recursive:!0,mode:448});let s=nr(r),o=e.session?.id??(t==="codex"?void 0:crypto.randomUUID()),a=t==="codex"&&!e.session?`<instructions>\n${e.system}\n</instructions>\n\n${e.prompt}`:e.prompt;ut(s.prompt,a,{mode:384}),ut(s.system,e.system,{mode:384});let i=Zt(e.tools?.tools)?{runner:process.argv[1]}:void 0;if(i)for(let l of Kt(t,s,i.runner,e.tools))ut(l.path,l.content,{mode:384});let c=rr({harness:t,model:e.model,permissions:e.permissions,session:o?{id:o,resume:!!e.session}:void 0,files:s,...i&&{tools:i}});return Br(st,{recursive:!0}),new Promise((l,u)=>{let d=ho("bash",["-lc",`cd \'${st}\' && ${c}`],{detached:!0,stdio:["ignore","pipe","pipe"]});ut(e.pidFile,String(d.pid??""),{mode:384});let p="",g,x,S="",v=!1,D=()=>{if(d.pid){try{process.kill(-d.pid,"SIGTERM")}catch{}setTimeout(()=>{try{process.kill(-d.pid,"SIGKILL")}catch{}},3e3).unref()}};e.signal.addEventListener("abort",D,{once:!0}),yo({input:d.stdout}).on("line",G=>{let A=sr(t,G);A&&(A.session&&(!v||A.session!==o)&&(o=A.session,v=!0,e.onSession?.(o)),A.step&&e.onStep?.(A.step.tool,A.step.target),A.text&&(p=A.text),A.final!==void 0&&(g=A.final),A.error&&(x=A.error))}),d.stderr.on("data",G=>S=`${S}${G}`.slice(-8e3)),d.on("close",G=>{if(e.signal.removeEventListener("abort",D),Or(e.pidFile,{force:!0}),Or(r,{recursive:!0,force:!0}),e.signal.aborted)return u(e.signal.reason??new DOMException("Aborted","AbortError"));if(x)return u(new Error(`${he(t)}: ${x}`));let A=(g??p).trim();if(G!==0||!A)return u(new Error(`${he(t)} stopped (exit ${G})${Vt(S)?`: ${Vt(S)}`:""}.`));if(!o)return u(new Error(`${he(t)} didn\'t report its session.`));l({text:A,session:o})})})}import{createHash as xo,randomUUID as wo}from"node:crypto";var So=e=>xo("sha256").update(e).digest("hex"),ft=class{constructor(t,n,r,s){this.url=t;this.secretKey=n;this.authTag=r;this.log=s;this.base=t.replace(/^ws/,"http").replace(/\\/+$/,"")}base;ready=!1;watching=new Set;closed=!1;sign(t){return Kn(t,this.secretKey)}async post(t,n){let r=`${this.base}${t}`,s=this.sign({kind:27235,created_at:Math.floor(Date.now()/1e3),content:"",tags:[["u",r],["method","POST"],["payload",So(n)],["nonce",wo()]]}),o=await fetch(r,{method:"POST",headers:{authorization:`Nostr ${Buffer.from(JSON.stringify(s)).toString("base64")}`,"content-type":"application/json","x-auth-tag":JSON.stringify(this.authTag)},body:n,signal:AbortSignal.timeout(2e4)}),a=await o.text();if(!o.ok)throw this.ready=!1,Object.assign(new Error(`${o.status} ${a.slice(0,300)}`.trim()),{status:o.status});return this.ready=!0,JSON.parse(a)}async publish(t){let n=t.tags.filter(o=>o[0]!=="auth"&&o[0]!=="ms");n.some(o=>o[0]==="h")&&n.push(["ms",String(Date.now()%1e3)]),n.push([...this.authTag]);let r=this.sign({...t,tags:n}),s=await this.post("/events",JSON.stringify(r));if(!s.accepted&&!s.message?.startsWith("duplicate"))throw new Error(s.message||"The community refused the event.");return r}async query(t){if(!t.length)return[];let n=await this.post("/query",JSON.stringify(t));return Array.isArray(n)?n:[]}watch(t,n,r,s=3e3){let o=new Set,a=n,i=0,c,l=async()=>{if(this.closed)return;let u=s;try{let d=await this.query([{...t,since:a-5}]);i=0;for(let p of d.sort((g,x)=>g.created_at-x.created_at))o.has(p.id)||(o.add(p.id),a=Math.max(a,p.created_at),r(p));if(o.size>2e3)for(let p of[...o].slice(0,1e3))o.delete(p)}catch(d){let p=d.message??String(d),g=/retry in (\\d+)s/.exec(p);u=g?Number(g[1])*1e3:Math.min(6e4,s*2**++i),this.log(`poll failed (${p.slice(0,160)}); next in ${Math.round(u/1e3)}s`)}this.closed||(c=setTimeout(()=>void l(),u),this.watching.add(c))};return l(),()=>{c&&clearTimeout(c)}}close(){this.closed=!0;for(let t of this.watching)clearTimeout(t)}};var sn=30*6e4,Lr="A Databricks agent in its own Databricks Sandbox.";function z(e){try{Ie(B.log)&&Dr(B.log).size>5*1024*1024&&Ro(B.log,0)}catch{}_o(B.log,`${new Date().toISOString()} ${e}\n`)}function on(e){try{return process.kill(e,0),pt(`/proc/${e}/cmdline`,"utf8").includes("serve")}catch{return!1}}var nn=()=>{let e=Number(Ie(B.pid)?pt(B.pid,"utf8"):"");return Number.isInteger(e)&&e>0&&on(e)?e:void 0};function me(e,t){return e===void 0&&(console.error(`No ${t} yet.`),process.exit(2)),e}var Mr=(e,t)=>new ft(e.relay,t,e.authTag,z);function Pr(e,t){return[`<identity>You are ${e.name} (pubkey ${t}), an agent in Buzz, a chat app, owned by ${e.owner}.</identity>`,"People mention you in channels, threads and Solo chats; each mention is a turn. Messages in the conversation you haven\'t seen arrive with the mention, as JSON. Your final message is posted as your reply in that conversation: make it the answer itself, in Markdown, written for the people there, without saying that you\'re posting it.",or(e.harness,"standard",e.kind==="sandbox"?e.tools??[]:[]),tr,e.instructions.trim()?`<agent-instructions>\n${e.instructions.trim()}\n</agent-instructions>`:""].filter(Boolean).join(`\n\n`)}async function To(e,t){let n=new Map;if(!t.length)return n;for(let r of await e.query([{kinds:[0],authors:t,limit:t.length*2}]).catch(()=>[]))try{let s=JSON.parse(r.content),o=s.display_name||s.name;o&&!n.has(r.pubkey)&&n.set(r.pubkey,String(o).slice(0,80))}catch{}return n}var qr=e=>({tools:e.tools??[],...e.workspaceId&&{workspaceId:e.workspaceId}});async function Ur(e,t,n,r){let s=it(),o=e.genieSpace;if(!o){let u=await new Te(s).ask(t,{...n&&{conversationId:n},signal:r}),d=[Fn(u)];u.status==="incomplete"&&d.push("_Genie One stopped early; this may be partial._");let p=u.sql[u.sql.length-1];return p&&d.push(`\\`\\`\\`sql\n${p.trim()}\n\\`\\`\\``),u.deepLink&&d.push(`[Explore in Databricks](${u.deepLink})`),{text:d.filter(Boolean).join(`\n\n`)||"Genie One had no answer.",conversation:u.conversationId}}let a=await s.ready(),i=await new ne(a).answer(o,t,{...n&&{conversationId:n},signal:r}),c=[];i.text&&c.push(i.text),i.result?.columns.length&&c.push(Be(i.result)),i.sql&&c.push(`\\`\\`\\`sql\n${i.sql.trim()}\n\\`\\`\\``),i.message.status!=="COMPLETED"&&c.push(`Genie stopped with status ${i.message.status}${i.error?`: ${i.error}`:""}.`),i.suggestions.length&&c.push(`_You could also ask:_ ${i.suggestions.slice(0,3).map(u=>`\\u201C${u}\\u201D`).join(" \\xB7 ")}`);let l=s.workspaceUrl(ne.webPath(o,i.message.conversation_id));return l&&c.push(`[Open in Genie](${l})`),{text:c.join(`\n\n`)||"Genie had no answer.",conversation:i.message.conversation_id}}async function Ao(){Wt();let e=me(lt(),"config.json"),t=me(dt(),"agent key"),n=Ut(t);rn(B.pid,String(process.pid));let r=Qt(),s=new Set(r.handled),o=new Map,a=new Map,i=Date.now(),c=0,l=Date.now(),u;z(`starting as ${n.slice(0,12)}\\u2026 (${e.kind==="genie"?"Genie":he(e.harness)}, ${e.availability})`);let d=Mr(e,t),p=()=>en({...r,handled:[...s]}),g=()=>ct(B.status,{pid:process.pid,pubkey:n,connected:d.ready,active:c,startedAt:new Date(i).toISOString(),lastActivity:new Date(l).toISOString(),since:r.since,...u&&{lastError:u}},420);async function x(_){let R=o.get(_);if(R&&Date.now()-R.at<10*6e4)return R.kind;let[b]=await d.query([{kinds:[39e3],"#d":[_],limit:1}]),L=ur(b);return o.set(_,{at:Date.now(),kind:L}),L}async function S(_,R,b){for(let L of hr(R))await d.publish(mr({conversation:_,content:L,authTag:e.authTag,...b&&{notify:b}}))}async function v(_,R,b){let L=r.sessions[R.key];if(e.kind==="genie"){let m=e.genieSpace?`genie:${e.genieSpace}`:"genie-one",w=L?.harness===m?L.id:void 0,y=await Ur(e,Yt(_.content)||"What can I ask you about?",w,b);return r.sessions[R.key]={harness:m,id:y.conversation,at:_.created_at},y.text}let j=L?.harness===e.harness?L:void 0,$=pr(R),h=(await d.query($)).filter(m=>m.id!==_.id&&$e.includes(m.kind)&&m.created_at<=_.created_at&&m.tags.some(w=>w[0]==="h"&&w[1]===R.channel)).filter(m=>m.created_at>(j?.at??0)&&m.pubkey!==n).sort((m,w)=>m.created_at-w.created_at),E=h.slice(-12),k=gr({event:_,conversation:R,agent:n,context:E,total:h.length,names:await To(d,[...new Set([_.pubkey,...E.map(m=>m.pubkey)])]),scope:e.scope});if(process.env.BUZZ_RUNNER_ECHO==="1")return`echo: ${Yt(_.content)} | ${R.key} | context ${E.length} | ${k.length} chars`;let I=await tn({harness:e.harness,model:e.model,permissions:"standard",...j&&{session:{id:j.id}},prompt:k,system:Pr(e,n),signal:b,pidFile:Ue(R.key),...e.tools?.length&&{tools:qr(e)},onStep:(m,w)=>z(`  ${m}${w?` \\xB7 ${w}`:""}`),onSession:m=>{r.sessions[R.key]={harness:e.harness,id:m,at:j?.at??0},p()}});return r.sessions[R.key]={harness:e.harness,id:I.session,at:_.created_at},I.text}async function D(_,R){let b=`${Ue(R.key)}.stopped`;Cr(b,{force:!0}),c++,l=Date.now(),g(),z(`mention ${_.id.slice(0,8)} in ${R.key}`);try{let L=await v(_,R,AbortSignal.timeout(sn));await S(R,L),z(`replied in ${R.key}`)}catch(L){Ie(b)?z(`stopped in ${R.key}`):(u=L.message??String(L),z(`turn failed: ${u}`),await S(R,`I couldn\'t finish that: ${u}`,e.owner).catch(j=>z(`couldn\'t post the failure: ${j.message}`)))}finally{Cr(b,{force:!0}),c--,l=Date.now(),r.since=Math.max(r.since,_.created_at),p(),g()}}function G(_){if(!(s.has(_.id)||!Zn(_)||!lr(_,n))){if(s.add(_.id),!dr(_,e.owner)){z(`ignored ${_.id.slice(0,8)}: not from the owner`);return}A=A.then(async()=>{let R=_.tags.find(j=>j[0]==="h")?.[1];if(!R)return;let b=fr(_,e.scope,await x(R).catch(()=>({solo:!1})));if(!b)return;let L=(a.get(b.key)??Promise.resolve()).then(()=>D(_,b));a.set(b.key,L.catch(()=>{}))})}}let A=Promise.resolve(),ie=JSON.stringify([e.name,e.picture??""]),Q=async()=>{if(r.profile!==ie)try{await d.publish(Xt({name:e.name,...e.picture&&{picture:e.picture},about:Lr,authTag:e.authTag})),r.profile=ie,p(),z("published the profile")}catch(_){z(`profile not published yet: ${_.message}`),setTimeout(()=>void Q(),6e4).unref()}};Q();let ye=r.since?r.since-5:Math.floor(Date.now()/1e3)-60;d.watch({kinds:$e,"#p":[n]},ye,G),g(),setInterval(g,3e4).unref(),e.availability==="sleep"&&setInterval(()=>{let _=Date.now()-l>e.idleMinutes*6e4,R=Ie(B.awake)?Dr(B.awake).mtimeMs:0;c||!_||Date.now()-R<10*6e4||(z("idle with the owner\'s Buzz closed; stopping the Sandbox until Buzz wakes it"),p(),d.close(),Eo("databricks",["api","post",`/api/2.0/sandboxes/${e.sandbox}/stop`,"--json","{}"],b=>{b&&z(`couldn\'t stop the Sandbox: ${b.message}`),process.exit(0)}))},6e4).unref(),process.on("SIGTERM",()=>{p(),d.close(),process.exit(0)})}async function $o(){let[e,...t]=process.argv.slice(2);if(e==="mcp"&&(await Rr(me(t[0],"a tools config")),process.exit(0)),e==="mcp-names"){let n=(await Jt(me(t[0],"a tools config"),AbortSignal.timeout(12e4))).map(r=>`,${r.name}`).join("");process.stdout.write(n,()=>process.exit(0));return}switch(Wt(),e){case"keygen":{let n=dt();n||(n=zn(),Ir(n)),console.log(JSON.stringify({pubkey:Ut(n)}));return}case"profile":{let n=me(lt(),"config.json");await Mr(n,me(dt(),"agent key")).publish(Xt({name:n.name,...n.picture&&{picture:n.picture},about:Lr,authTag:n.authTag}));let s=Qt();en({...s,profile:JSON.stringify([n.name,n.picture??""])}),console.log("published");return}case"start":{if(nn())return console.log("running");let n=ko(B.log,"a"),r=vo(process.execPath,[process.argv[1],"serve"],{detached:!0,stdio:["ignore",n,n]});return r.unref(),rn(B.pid,String(r.pid)),console.log("started")}case"stop":{let n=nn();if(n){process.kill(n,"SIGTERM");for(let r=0;r<50&&on(n);r++)await new Promise(s=>setTimeout(s,100));on(n)&&process.kill(n,"SIGKILL")}return console.log(n?"stopped":"not running")}case"interrupt":{let[n="",r=""]=t;for(let s of[`${n}/${r}`,n]){let o=Ue(s),a=Number(Ie(o)?pt(o,"utf8"):"");if(a){rn(`${o}.stopped`,"");try{return process.kill(-a,"SIGTERM"),console.log("true")}catch{}}}return console.log("false")}case"status":{let n=nn(),r=Ie(B.status)?JSON.parse(pt(B.status,"utf8")):{},s=n&&r.pid===n?r:{},o=$r();return console.log(JSON.stringify({...s,running:!!n,...o&&{bootedAt:o}}))}case"ask":{let n=me(lt(),"config.json"),r=t.join(" ")||"Say hello in one short sentence.";if(n.kind==="genie")return console.log((await Ur(n,r,void 0,AbortSignal.timeout(sn))).text);let s=await tn({harness:n.harness,model:n.model,permissions:"standard",prompt:r,system:Pr(n,"diagnostic"),signal:AbortSignal.timeout(sn),pidFile:Ue("ask"),...n.tools?.length&&{tools:qr(n)},onStep:(o,a)=>console.error(`step: ${o}${a?` \\xB7 ${a}`:""}`)});return console.log(s.text)}case"serve":return Ao();default:console.error("usage: runner.mjs keygen|profile|start|serve|stop|interrupt|status|ask|mcp|mcp-names"),process.exit(2)}}$o().catch(e=>{z(`fatal: ${e?.stack??e}`),console.error(e?.message??e),process.exit(1)});\n';
var RUNNER_SHA = "c5d18b9c3159fa48";

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
  const quote = (value) => value === null ? "" : /[",\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
  return [
    result.columns.map((column) => quote(column.name)).join(","),
    ...result.rows.map((row) => row.map(quote).join(","))
  ].join("\n");
}
var RESULT_LANGUAGE = "databricks-result";
function resultBlock(result, maxRows = 200) {
  const shown = { ...result, rows: result.rows.slice(0, maxRows) };
  const csv = toCsv(shown);
  const fence = csv.includes("```") ? "````" : "```";
  const total = result.totalRows ?? result.rows.length;
  const note = total > shown.rows.length ? `

_Showing ${shown.rows.length} of ${total} rows._` : "";
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
var TARGET_KEYS = ["command", "cmd", "file_path", "path", "pattern", "query", "url", "description", "prompt"];
function targetOf(value) {
  if (!value || typeof value !== "object") return void 0;
  for (const key2 of TARGET_KEYS) {
    const found = value[key2];
    if (typeof found === "string" && found.trim()) return found.length > 80 ? `${found.slice(0, 77)}\u2026` : found;
  }
  return void 0;
}
var shellTarget = (command) => command.replace(/^\/bin\/(ba)?sh -lc '?/, "").replace(/'$/, "");
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
      const tool = event.message.content.find((part) => part?.type === "tool_use");
      if (tool) return { step: { tool: String(tool.name ?? "tool"), ...targetOf(tool.input) && { target: targetOf(tool.input) } } };
      const text = textOf(event.message.content);
      return text ? { text } : void 0;
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
      if (item.type === "mcp_tool_call") return { step: { tool: String(item.tool ?? "tool"), ...item.server && { target: String(item.server) } } };
      if (item.type === "web_search") return { step: { tool: "web search", ...item.query && { target: String(item.query) } } };
      return void 0;
    }
    if (event.type === "item.completed" && item.type === "agent_message" && typeof item.text === "string") return { text: item.text };
    return void 0;
  }
  if (event.type === "session" && typeof event.id === "string") return { session: event.id };
  if (event.type === "tool_execution_start") return { step: { tool: String(event.toolName ?? "tool"), ...targetOf(event.args) && { target: targetOf(event.args) } } };
  if (event.type === "message_end" && event.message?.role === "assistant") {
    if (event.message.stopReason === "error" && event.message.errorMessage) return { error: String(event.message.errorMessage) };
    const text = textOf(event.message.content);
    return text ? { text } : void 0;
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
        if (event.step) input.onStep?.(event.step.tool, event.step.target);
        if (event.text) text = event.text;
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
  if (current.stdout?.trim() === RUNNER_SHA) return;
  await sandboxes.writeFile(sandbox, RUNNER_PATH, RUNNER, signal);
  await sandboxes.bash(sandbox, `echo ${RUNNER_SHA} > ${shellQuote(SHA_PATH)}`, { timeoutSeconds: 30, ...signal && { signal } });
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
var GenieOne = class {
  constructor(service) {
    this.service = service;
  }
  clients = /* @__PURE__ */ new Map();
  availability = /* @__PURE__ */ new Map();
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
  /** Whether Genie One answers in this workspace for this user. */
  available() {
    const snapshot = this.service.snapshot();
    const key2 = snapshot.status === "connected" ? snapshot.profile.host : "none";
    let check = this.availability.get(key2);
    if (!check) {
      check = this.mcp().then((mcp) => mcp.listTools()).then((tools) => tools.some((tool) => tool.name === "genie_ask")).catch(() => false).then((ok) => {
        if (!ok) this.availability.delete(key2);
        return ok;
      });
      this.availability.set(key2, check);
    }
    return check;
  }
  async ask(question, options = {}) {
    const { signal } = options;
    const mcp = await this.mcp();
    const asked = await mcp.callTool(
      "genie_ask",
      { question, ...options.conversationId && { conversation_id: options.conversationId } },
      { ...signal && { signal }, timeoutMs: 17e4 }
    );
    if (asked.isError) throw new Error(resultText(asked) || "Genie One couldn't take the question.");
    const started = resultJson(asked) ?? {};
    const conversationId = started.conversation_id ?? options.conversationId ?? "";
    const responseId = started.response_id ?? "";
    if (!conversationId || !responseId) throw new Error("Genie One didn't return a conversation.");
    let state = started;
    let markdown = resultText(asked);
    let unknowns = 0;
    let steps = [];
    const deadline = Date.now() + 10 * 6e4;
    try {
      while (!state.status || state.status === "in_progress" || state.status === "unknown" && unknowns < 5) {
        if (Date.now() > deadline) throw new Error("Genie One didn't finish within 10 minutes.");
        await sleep2(POLL_MS, signal);
        const polled = await mcp.callTool(
          "genie_poll_response",
          { conversation_id: conversationId, response_id: responseId },
          { ...signal && { signal }, timeoutMs: 6e4 }
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
    if (state.status === "failed") throw new Error(markdown.trim() || "Genie One couldn't answer that.");
    const items = (state.query_items ?? []).slice(0, MAX_RESULTS);
    const results = (await Promise.all(
      items.map(
        (item) => mcp.callTool(
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
      let name = `genie_${slug(choice.label, 40)}_ask`;
      for (let n = 2; used.has(name); n++) name = `genie_${slug(choice.label, 36)}_${n}_ask`;
      used.add(name);
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
        const status = error.status;
        if (this.route === "gateway" || status !== 404 && status !== 405) throw error;
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
        const status = error.status;
        if (status !== 404 && status !== 405) throw error;
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

// plugins/agents/src/ui.tsx
var KINDS = [
  {
    id: "sandbox",
    label: "Sandbox agent",
    detail: "A model with its own Databricks Sandbox to run code, plus the tools you pick."
  },
  {
    id: "genie-one",
    label: "Genie One",
    detail: "Answers questions about any data you can access, with a chart, the SQL and a link. Nothing to set up."
  },
  {
    id: "custom",
    label: "Custom agent",
    detail: "An agent you already have: Agent Bricks or Model Serving, a Databricks App, or a Genie agent."
  }
];
var settling = (status) => status === "checking" || status === "connecting" || status === "signing-in";
var loads = (status) => status === "connected" || settling(status);
var hostname = (host) => new URL(host).hostname;
function BrowserWait(props) {
  const { cancelSignIn } = props.service;
  return /* @__PURE__ */ React.createElement(Stack, { direction: "row", gap: 8, align: "center", justify: "space-between" }, /* @__PURE__ */ React.createElement(Stack, { direction: "row", gap: 6, align: "center" }, /* @__PURE__ */ React.createElement(Spinner, { size: 11 }), /* @__PURE__ */ React.createElement(Text, { tone: "subtle", size: "sm" }, "Finish signing in in your browser", props.host ? ` (${hostname(props.host)})` : "", ".")), cancelSignIn && /* @__PURE__ */ React.createElement(Button, { size: "sm", variant: "ghost", onClick: () => cancelSignIn() }, "Cancel"));
}
function NeedsConnection(props) {
  const { service } = props;
  const snapshot = useConnection(service);
  if (snapshot.status === "signing-in") return /* @__PURE__ */ React.createElement(BrowserWait, { service, ...snapshot.host && { host: snapshot.host } });
  if (snapshot.status === "connected" || settling(snapshot.status)) return null;
  const expired = snapshot.status === "error" && snapshot.needsSignIn && service.reauthenticate;
  const action = expired ? /* @__PURE__ */ React.createElement(Button, { size: "sm", variant: "brand", onClick: () => void service.reauthenticate() }, "Sign in again") : snapshot.status === "signed-out" ? /* @__PURE__ */ React.createElement(Button, { size: "sm", variant: "brand", onClick: () => void service.signIn() }, "Sign in with Databricks") : /* @__PURE__ */ React.createElement(Button, { size: "sm", variant: "brand", onClick: () => service.openSettings() }, "Connect");
  return /* @__PURE__ */ React.createElement(Notice, { tone: "warning", title: expired ? "Your Databricks sign-in has expired" : "Databricks isn't connected", action }, snapshot.status === "signed-out" && snapshot.error ? snapshot.error : "These agents run on Databricks with your sign-in.");
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
function AgentForm(props) {
  const { config, onChange } = props;
  const workspace = useAgentService(props.service, config.profile);
  const kind = KINDS.find((candidate) => candidate.id === config.kind) ?? KINDS[1];
  return /* @__PURE__ */ React.createElement(DbxRoot, null, /* @__PURE__ */ React.createElement(Stack, { gap: 14 }, /* @__PURE__ */ React.createElement(NeedsConnection, { service: props.service }), props.intro, /* @__PURE__ */ React.createElement(Field, { label: "Type", hint: kind.detail }, /* @__PURE__ */ React.createElement("select", { className: "dbx-select", disabled: props.disabled, value: kind.id, onChange: (event) => onChange({ ...config, kind: event.target.value }) }, KINDS.map((candidate) => /* @__PURE__ */ React.createElement("option", { key: candidate.id, value: candidate.id }, candidate.label)))), /* @__PURE__ */ React.createElement(
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
  ), kind.id === "sandbox" && /* @__PURE__ */ React.createElement(SandboxFields, { workspace, config, onChange, ...props.disabled !== void 0 && { disabled: props.disabled } }), kind.id === "custom" && /* @__PURE__ */ React.createElement(
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
  const status = useConnection(workspace).status;
  const available = useAsync(() => cachedList(workspace, "sandbox", async () => new Sandboxes(await workspace.ready()).available()), [workspace, status]);
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
  ), remote && /* @__PURE__ */ React.createElement(Field, { label: "Permissions", hint: permissionsHint(remote, config.permissions) }, /* @__PURE__ */ React.createElement("select", { className: "dbx-select", ...disabled, value: config.permissions, onChange: (event) => onChange({ ...config, permissions: event.target.value }) }, /* @__PURE__ */ React.createElement("option", { value: "standard" }, "Standard"), /* @__PURE__ */ React.createElement("option", { value: "full" }, "Full access"))), /* @__PURE__ */ React.createElement(ToolsField, { service: workspace, tools: config.tools, ...disabled, onChange: (tools) => onChange({ ...config, tools }) }), /* @__PURE__ */ React.createElement(Field, { label: "Conversation", hint: "Thread: each thread is its own conversation. Channel: one conversation for the whole channel." }, /* @__PURE__ */ React.createElement("select", { className: "dbx-select", disabled: props.disabled, value: config.scope, onChange: (event) => onChange({ ...config, scope: event.target.value }) }, /* @__PURE__ */ React.createElement("option", { value: "thread" }, "One per thread"), /* @__PURE__ */ React.createElement("option", { value: "channel" }, "One per channel"))), /* @__PURE__ */ React.createElement(Field, { label: "Instructions", hint: "Optional. Who it is, what it should focus on, how to answer." }, /* @__PURE__ */ React.createElement("textarea", { className: "dbx-textarea", rows: 5, disabled: props.disabled, value: config.instructions, onChange: (event) => onChange({ ...config, instructions: event.target.value }) })));
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
function useAgentService(service, profile) {
  return React.useMemo(() => profile && service.forProfile ? service.forProfile(profile) : service, [service, profile]);
}
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
var ADD = "__add__";
function WorkspaceField(props) {
  const main = useConnection(props.service);
  const workspace = useAgentService(props.service, props.profile);
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
function OptionList(props) {
  const shown = filterOptions(props.options, props.query);
  let group = "";
  return /* @__PURE__ */ React.createElement("div", { className: "dbx-picker-list", role: "listbox", "aria-label": props.label, "aria-multiselectable": props.multi || void 0, style: { maxHeight: props.maxHeight } }, shown.length === 0 && /* @__PURE__ */ React.createElement(Text, { tone: "subtle", size: "sm", as: "div", style: { padding: "8px 10px" } }, props.query ? `Nothing matches \u201C${props.query}\u201D.` : "Nothing to choose from here."), shown.map((option) => {
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
    /* @__PURE__ */ React.createElement(
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
  const status = useConnection(props.service).status;
  const models = useAsync(() => cachedList(props.service, "models", async () => new Ai(await props.service.ready()).models()), [props.service, status]);
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
      loading: models.loading && !models.data && loads(status) ? "Loading all models\u2026" : false,
      ...models.error && status === "connected" && { error: `Couldn't list models: ${describeError(models.error)}` },
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
  const status = useConnection(service).status;
  const spaces = useAsync(() => genieSpaces(service), [service, status]);
  const catalog = useAsync(() => cachedList(service, "mcp", async () => new McpCatalog(await service.ready()).list()), [service, status]);
  const [schemaName, setSchemaName] = React.useState("");
  const choices = /* @__PURE__ */ new Map([[GENIE_ONE_CHOICE.id, GENIE_ONE_CHOICE]]);
  const servers = catalog.data?.servers ?? [];
  const logins = useMcpLogins(service, status === "connected", servers);
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
  const loading = !loads(status) ? false : spaces.loading ? "Loading Genie agents\u2026" : catalog.loading ? "Finding MCP servers\u2026" : false;
  const notes = status !== "connected" ? [] : [
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
function CustomAgentField(props) {
  const { service } = props;
  const status = useConnection(service).status;
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
    [service, status]
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
      loading: found.loading && !found.data && loads(status) ? "Finding your agents\u2026" : false,
      ...found.error && status === "connected" && { error: describeError(found.error) },
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
  return {
    kind: config.kind === "sandbox" ? "sandbox" : "genie",
    harness,
    model: typeof config.model === "string" && harnessAccepts(harness, config.model) ? config.model : HARNESS_MODEL[harness],
    // Genie One unless the owner chose otherwise (an empty list is a choice).
    tools: Array.isArray(config.tools) ? normalizeChoices(config.tools) : [GENIE_ONE_CHOICE],
    availability: config.availability === "always" ? "always" : "sleep",
    scope: config.scope === "channel" ? "channel" : "thread",
    instructions: typeof config.instructions === "string" ? config.instructions : "",
    ...typeof config.profile === "string" && config.profile && { profile: config.profile },
    ...genie && { genie }
  };
}
function summarizeHosted(config) {
  const what = config.kind === "genie" ? config.genie ? `Genie \xB7 ${config.genie.label}` : "Genie One" : `${harnessLabel(config.harness)} \xB7 ${harnessModel(config.harness, config.model).replace(/^system\.ai\./, "")}`;
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
    ...config.genie && { genieSpace: config.genie.space },
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
function shouldRefresh(status, now = Date.now()) {
  if (!status?.running || status.active || !status.bootedAt) return false;
  const booted = Date.parse(status.bootedAt);
  const last = Math.max(booted, Date.parse(status.lastActivity ?? "") || 0);
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
    const status = error.status;
    if (status !== 400 && status !== 404) throw error;
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
async function deploy(service, record, options) {
  const { client, sandboxes } = await sandboxOf(service, record, options.signal);
  await sandboxes.ensureRunning(record.sandbox, { ...options.signal && { signal: options.signal } });
  await uploadRunner(sandboxes, record.sandbox, options.signal);
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
        const result = await sandboxes.bash(record.sandbox, script, { timeoutSeconds: 60, ...signal && { signal } });
        if (result.exit_code !== 0) throw new Error(`The agent's runner couldn't start: ${(result.stderr || result.stdout || `exit ${result.exit_code}`).trim().slice(-400)}`);
        return JSON.parse((result.stdout ?? "").trim() || "{}");
      };
      const status = await start();
      if (options.refresh === false || record.config.availability !== "always" || !shouldRefresh(status)) return status;
      await runner(sandboxes, record.sandbox, "stop", signal);
      await sandboxes.stop(record.sandbox);
      await stopped(sandboxes, record.sandbox, signal);
      return start();
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
  { id: "genie", label: "Genie", detail: "Answers data questions with Genie One, or with one of your Genie agents, as charts and tables." },
  { id: "sandbox", label: "Sandbox agent", detail: "Claude Code, Codex or Pi, working in its own Databricks Sandbox with the Databricks CLI signed in as you." }
];
var AVAILABILITY_HINT = {
  always: `Replies within seconds, with Buzz open or closed. Databricks stops a Sandbox ${SANDBOX_DAY_HOURS} hours after it starts, so with Buzz closed it keeps answering for ${SANDBOX_DAY_HOURS - REFRESH_AFTER_HOURS} to ${SANDBOX_DAY_HOURS} hours. Your Buzz restarts it whenever it's open, and it then answers anything it missed.`,
  sleep: "Runs while your Buzz is open and finishes any work after you close it, then sleeps about 10 minutes later. Opening Buzz wakes it, and it answers anything it missed. Costs less than Always on."
};
function GenieField(props) {
  const status = useConnection(props.service).status;
  const spaces = useAsync(() => genieSpaces(props.service), [props.service, status]);
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
function HostedForm(props) {
  const { config, onChange } = props;
  const workspace = useAgentService(props.service, config.profile);
  const status = useConnection(workspace).status;
  const available = useAsync(() => cachedList(workspace, "sandbox", async () => new Sandboxes(await workspace.ready()).available()), [workspace, status]);
  const kind = KIND_CHOICES.find((choice) => choice.id === config.kind) ?? KIND_CHOICES[0];
  const harness = HARNESS_CHOICES.find((choice) => choice.id === config.harness) ?? HARNESS_CHOICES[0];
  const disabled = props.disabled !== void 0 ? { disabled: props.disabled } : {};
  return /* @__PURE__ */ React.createElement(DbxRoot, null, /* @__PURE__ */ React.createElement(Stack, { gap: 14 }, /* @__PURE__ */ React.createElement(NeedsConnection, { service: props.service }), !props.locked && /* @__PURE__ */ React.createElement(Text, { tone: "subtle", size: "sm" }, "Runs in Databricks, in its own Sandbox, so it can answer with Buzz closed. It can't use Buzz's own tools, and Buzz doesn't show it working."), available.data === false && /* @__PURE__ */ React.createElement(Notice, { tone: "warning" }, "Databricks Sandbox isn't on in this workspace, and this agent runs in one. An admin can turn on the Sandbox preview."), !props.locked && /* @__PURE__ */ React.createElement(Field, { label: "Type", hint: kind.detail }, /* @__PURE__ */ React.createElement("select", { className: "dbx-select", ...disabled, value: kind.id, onChange: (event) => onChange({ ...config, kind: event.target.value }) }, KIND_CHOICES.map((choice) => /* @__PURE__ */ React.createElement("option", { key: choice.id, value: choice.id }, choice.label)))), !props.locked && /* @__PURE__ */ React.createElement(
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
  ), config.kind === "genie" ? /* @__PURE__ */ React.createElement(
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
  ), /* @__PURE__ */ React.createElement(ToolsField, { service: workspace, tools: config.tools, ...disabled, onChange: (tools) => onChange({ ...config, tools }) })), /* @__PURE__ */ React.createElement(Field, { label: "Availability", hint: AVAILABILITY_HINT[config.availability] }, /* @__PURE__ */ React.createElement("select", { className: "dbx-select", ...disabled, value: config.availability, onChange: (event) => onChange({ ...config, availability: event.target.value }) }, /* @__PURE__ */ React.createElement("option", { value: "sleep" }, "Sleep when Buzz is closed"), /* @__PURE__ */ React.createElement("option", { value: "always" }, "Always on"))), /* @__PURE__ */ React.createElement(Field, { label: "Conversation", hint: "Thread: each thread is its own conversation. Channel: one conversation for the whole channel." }, /* @__PURE__ */ React.createElement("select", { className: "dbx-select", ...disabled, value: config.scope, onChange: (event) => onChange({ ...config, scope: event.target.value }) }, /* @__PURE__ */ React.createElement("option", { value: "thread" }, "One per thread"), /* @__PURE__ */ React.createElement("option", { value: "channel" }, "One per channel"))), config.kind === "sandbox" && /* @__PURE__ */ React.createElement(Field, { label: "Instructions", hint: "Optional. Who it is, what it should focus on, how to answer." }, /* @__PURE__ */ React.createElement("textarea", { className: "dbx-textarea", rows: 5, ...disabled, value: config.instructions, onChange: (event) => onChange({ ...config, instructions: event.target.value }) })), !props.locked && /* @__PURE__ */ React.createElement(Text, { tone: "tertiary", size: "xs" }, "Only your own messages reach it. Its Sandbox belongs to you in Databricks; removing the agent deletes it.")));
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
  const status = useAsync(() => props.provider.status(props.pubkey), [props.pubkey, nonce]);
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
  const state = status.data?.state;
  const runnerState = status.data?.runner;
  const dirty = JSON.stringify(draft) !== JSON.stringify(record.config);
  const left = hoursLeft(runnerState?.bootedAt);
  return /* @__PURE__ */ React.createElement(DbxRoot, { style: { padding: "4px 0 24px" } }, /* @__PURE__ */ React.createElement(Stack, { gap: 16 }, /* @__PURE__ */ React.createElement(
    Notice,
    {
      tone: state === "SANDBOX_STATE_RUNNING" && runnerState?.running === false ? "warning" : "info",
      title: status.loading && !status.data ? "Checking\u2026" : stateLabel(state, record.config.availability),
      action: /* @__PURE__ */ React.createElement(Button, { size: "sm", disabled: Boolean(busy), onClick: () => run("wake", () => props.provider.wake(props.pubkey, { refresh: false })) }, busy === "wake" ? /* @__PURE__ */ React.createElement(Spinner, { size: 11 }) : null, state === "SANDBOX_STATE_RUNNING" ? "Check again" : "Wake now")
    },
    state === "SANDBOX_STATE_RUNNING" ? runnerState?.running ? `${runnerState.connected ? "Connected to the community" : "Connecting"}${runnerState.active ? ` \xB7 working on ${runnerState.active}` : ""}${runnerState.lastError ? ` \xB7 last error: ${runnerState.lastError}` : ""}.${record.config.availability === "always" && left !== void 0 ? ` Databricks stops its Sandbox in about ${Math.max(1, Math.round(left))} h; your Buzz restarts it sooner, at a quiet moment.` : ""}` : "The Sandbox is up but the agent isn't running; Wake now starts it." : state === "SANDBOX_STATE_STOPPED" ? record.config.availability === "sleep" ? "It slept while Buzz was closed. Buzz wakes it within a few minutes, or now with Wake now." : `Databricks stops a Sandbox ${SANDBOX_DAY_HOURS} hours after it starts. Buzz starts it again within a few minutes, or now with Wake now.` : `Sandbox ${record.sandbox}.`
  ), /* @__PURE__ */ React.createElement(HostedForm, { service: props.service, config: draft, onChange: setDraft, ...busy && { disabled: true }, locked: true }), error && /* @__PURE__ */ React.createElement(Notice, { tone: "danger" }, error), /* @__PURE__ */ React.createElement(Stack, { direction: "row", gap: 8, justify: "flex-end" }, /* @__PURE__ */ React.createElement(Button, { variant: "ghost", disabled: !dirty || Boolean(busy), onClick: () => setDraft(record.config) }, "Revert"), /* @__PURE__ */ React.createElement(Button, { variant: "primary", disabled: !dirty || Boolean(busy), onClick: () => run("save", () => props.provider.update(props.pubkey, draft)) }, busy === "save" ? /* @__PURE__ */ React.createElement(Spinner, { size: 11 }) : null, "Save"))));
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
        wait_timeout: "30s",
        on_wait_timeout: "CONTINUE",
        disposition: "INLINE",
        format: "JSON_ARRAY",
        row_limit: options.rowLimit ?? 1e3,
        ...options.catalog && { catalog: options.catalog },
        ...options.schema && { schema: options.schema }
      },
      { timeoutMs: 45e3, ...signal && { signal } }
    );
    options.onStatement?.(response.statement_id);
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

// plugins/sql/src/runs.ts
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
          const catalogs = await sql.catalogs();
          return catalogs.map((c) => `- ${c.name}${c.comment ? `: ${c.comment}` : ""}`).join("\n") || "No catalogs visible.";
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
        const status = result.status?.replace("EXECUTE_COMMAND_STATUS_", "").toLowerCase() ?? "completed";
        return [
          `exit_code: ${result.exit_code ?? "unknown"} (${status}${result.truncated ? ", output truncated" : ""})`,
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
var PREFIX = "bkvarda.databricks-agents.v1";
var Sessions = class {
  constructor(storage) {
    this.storage = storage;
  }
  key(agent, conversation) {
    return `${PREFIX}:${agent}:${conversation}`;
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
    const prefix = `${PREFIX}:${agent}:`;
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
      const status = service.snapshot().status;
      if (status === "connected") return { readiness: "ready" };
      if (status === "checking" || status === "connecting") return { readiness: "checking" };
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
  function turn(delivery, conversation, work) {
    delivery.acknowledged?.();
    const key2 = `${delivery.agent.key}|${conversation.key}`;
    const done = queue.run(key2, (signal) => {
      const stop = () => queue.interrupt(key2);
      delivery.signal.addEventListener("abort", stop, { once: true });
      delivery.interruptible?.(async () => stop());
      return work(signal).finally(() => delivery.signal.removeEventListener("abort", stop));
    }).then(
      () => ({ ok: true }),
      async (error) => {
        if (error?.name === "AbortError" || error?.name === "TimeoutError")
          return { ok: true, stopped: true };
        const message = describeError(error);
        await kit.reply(delivery.agent, conversation, `I couldn't finish that: ${message}`, { notifyOwner: true }).catch(() => {
        });
        return { ok: false, error: message };
      }
    );
    delivery.workingUntil(done);
  }
  async function sandboxSetup(delivery, config, workspace, signal, step) {
    const on = await sandboxOn(workspace, signal);
    const sandbox = on ? sandboxTools(workspace, delivery.agent.pubkey, delivery.agent.name, step) : [];
    const tools = await databricksTools(service, workspace, config, sandbox, signal);
    const instructions = [
      config.instructions.trim(),
      on ? SANDBOX_PROMPT : "Databricks Sandbox isn't turned on in this workspace, so you can't run code or keep files this turn.",
      toolsNote(workspace, service, tools.problems)
    ].filter(Boolean).join("\n\n");
    return { tools, instructions, cwd: on ? `${SANDBOX_HOME}/work` : "~" };
  }
  async function sandboxTurn(delivery, config, conversation, signal) {
    const workspace = agentService(service, config.profile);
    const client = await workspace.ready(signal);
    const session = sessions.get(delivery.agent.key, conversation.key);
    const { tools, instructions, cwd } = await sandboxSetup(delivery, config, workspace, signal, (state) => delivery.step?.("sandbox", state));
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
        onStep: (tool, target2) => delivery.step?.(tool, target2)
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
  async function remoteTurn(delivery, config, harness, conversation, signal) {
    const workspace = agentService(service, config.profile);
    const client = await workspace.ready(signal);
    if (!await sandboxOn(workspace, signal))
      throw new Error(`Databricks Sandbox isn't turned on in this workspace, and ${harnessLabel(harness)} runs there. A workspace admin can turn on the Sandbox preview.`);
    const sandbox = await ensureAgentSandbox(workspace, delivery.agent.pubkey, delivery.agent.name, signal, (state) => delivery.step?.("sandbox", state));
    const tools = config.tools.length ? { tools: config.tools, ...workspaceIdOf(workspace) && { workspaceId: workspaceIdOf(workspace) } } : void 0;
    if (tools) await uploadRunner(sandbox, sandboxFor(delivery.agent.pubkey), signal);
    const session = sessions.get(delivery.agent.key, conversation.key);
    const continued = session.remote?.harness === harness ? { harness, id: session.remote.id } : void 0;
    const instructions = [config.instructions.trim(), remoteNote(harness, config.permissions, config.tools), toolsNote(workspace, service, [])].filter(Boolean).join("\n\n");
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
        onStep: (tool, target2) => delivery.step?.(tool, target2),
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
  async function genieOneTurn(delivery, config, conversation, signal) {
    const question = deliveredText(delivery) || "What can I ask you about?";
    const session = sessions.get(delivery.agent.key, conversation.key);
    delivery.step?.("genie", "Genie One");
    const answer = await genieOneFor(agentService(service, config.profile)).ask(question, {
      ...session.genieOneConversationId && { conversationId: session.genieOneConversationId },
      signal,
      onProgress: (steps) => {
        const last = steps[steps.length - 1] ?? "";
        delivery.step?.("genie", /^Running SQL/.test(last) ? "running SQL" : /^Query result/.test(last) ? "reading the result" : "thinking");
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
  async function genieSpaceTurn(delivery, config, agent, conversation, signal) {
    const workspace = agentService(service, config.profile);
    const client = await workspace.ready(signal);
    const question = deliveredText(delivery) || "What can I ask you about?";
    const session = sessions.get(delivery.agent.key, conversation.key);
    delivery.step?.("genie", agent.label);
    const answer = await new Genie(client).answer(agent.target, question, {
      ...session.genieConversationId && { conversationId: session.genieConversationId },
      signal,
      onUpdate: (message) => delivery.step?.("genie", message.status.toLowerCase().replace(/_/g, " "))
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
  async function customTurn(delivery, config, conversation, signal) {
    const agent = config.custom;
    if (!agent) throw new Error("No agent is chosen yet. My owner can pick one in my Settings.");
    if (agent.kind === "genie") return genieSpaceTurn(delivery, config, agent, conversation, signal);
    const client = await agentService(service, config.profile).ready(signal);
    const session = sessions.get(delivery.agent.key, conversation.key);
    const question = deliveredText(delivery);
    const history = session.messages.filter((m) => (m.role === "user" || m.role === "assistant") && typeof m.content === "string");
    const messages = [...history, { role: "user", content: question || "Hello" }];
    delivery.step?.("agent", agent.label);
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
        return;
      }
      const harness = config.harness;
      turn(
        delivery,
        conversation,
        (signal) => config.kind === "sandbox" ? isRemote(harness) ? remoteTurn(delivery, config, harness, conversation, signal) : sandboxTurn(delivery, config, conversation, signal) : config.kind === "custom" ? customTurn(delivery, config, conversation, signal) : genieOneTurn(delivery, config, conversation, signal)
      );
    },
    async runOnce(standalone) {
      const config = normalizeDatabricks(standalone.delivery.config);
      if (config.kind !== "sandbox") return { ok: false, error: "Watches and timers run on Sandbox agents; Genie One and custom agents answer mentions." };
      if (isRemote(config.harness))
        return { ok: false, error: `Watches and timers run on the Built-in harness for now; ${harnessLabel(config.harness)} answers mentions.` };
      try {
        const prompt = await standalone.prompt();
        if (!prompt) return { ok: true };
        const workspace = agentService(service, config.profile);
        const client = await workspace.ready(standalone.signal);
        const { tools, instructions } = await sandboxSetup(standalone.delivery, config, workspace, standalone.signal);
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
          onStep: (tool, target2) => standalone.delivery.step?.(tool, target2)
        });
        return { ok: true };
      } catch (error) {
        return { ok: false, error: describeError(error) };
      }
    }
  };
  agents.register(databricksType);
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
