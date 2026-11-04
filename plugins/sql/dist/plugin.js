// Databricks SQL (bkvarda.databricks-sql) — built by databricks-buzz-plugins. Apache-2.0.

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
var CHART_COLORS = [
  "var(--dbx-chart-1)",
  "var(--dbx-chart-2)",
  "var(--dbx-chart-3)",
  "var(--dbx-chart-4)",
  "var(--dbx-chart-5)",
  "var(--dbx-chart-6)",
  "var(--dbx-chart-7)",
  "var(--dbx-chart-8)"
];
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
function comparable(rows, indices) {
  const peak = (index) => Math.max(0, ...rows.map((row) => Math.abs(Number(row[index]) || 0)));
  const base = indices[0] === void 0 ? 0 : peak(indices[0]);
  return indices.filter((index, n) => n === 0 || base === 0 || peak(index) / base <= 10 && peak(index) / base >= 0.1);
}
function planChart(result) {
  const { columns, rows } = result;
  if (!rows.length) return { type: "none" };
  const numeric = columns.flatMap((column, index) => column.kind === "number" ? [index] : []);
  if (rows.length === 1 && columns.length === 1 && numeric.length === 1) {
    const value = Number(rows[0]?.[0]);
    if (Number.isFinite(value)) return { type: "kpi", value, label: columns[0]?.name ?? "" };
  }
  if (rows.length < 2 || !numeric.length) return { type: "none" };
  const time = columns.findIndex((column) => column.kind === "time");
  if (time !== -1) {
    const series = comparable(rows, numeric.filter((index) => index !== time)).slice(0, 4);
    return series.length ? { type: "line", x: time, series } : { type: "none" };
  }
  const label = columns.findIndex((column) => column.kind === "text");
  if (label !== -1 && rows.length <= 40) {
    const series = comparable(rows, numeric).slice(0, 3);
    const longest = Math.max(...rows.map((row) => (row[label] ?? "").length));
    return { type: "bar", x: label, series, horizontal: longest > 10 || rows.length > 12 };
  }
  const yearLike = numeric.find(
    (index) => /(^|_)(year|yr|quarter|month|week|day|hour|minute|period)(_|s?$)/i.test(columns[index]?.name ?? "")
  );
  if (yearLike !== void 0) {
    const series = comparable(rows, numeric.filter((index) => index !== yearLike)).slice(0, 4);
    if (series.length) return { type: "line", x: yearLike, series };
  }
  return { type: "none" };
}

// packages/core/src/ui/data.tsx
function DataTable(props) {
  const { result } = props;
  const rows = result.rows.slice(0, props.maxRows ?? 500);
  const total = result.totalRows ?? result.rows.length;
  return /* @__PURE__ */ React.createElement(Stack, { gap: 6 }, /* @__PURE__ */ React.createElement(
    "div",
    {
      style: {
        overflow: "auto",
        maxHeight: props.maxHeight ?? 320,
        border: "1px solid var(--dbx-border)",
        borderRadius: "var(--dbx-radius)"
      }
    },
    /* @__PURE__ */ React.createElement("table", { className: "dbx-table" }, /* @__PURE__ */ React.createElement("thead", null, /* @__PURE__ */ React.createElement("tr", null, result.columns.map((column) => /* @__PURE__ */ React.createElement("th", { key: column.name, "data-numeric": column.kind === "number", title: column.type }, column.name)))), /* @__PURE__ */ React.createElement("tbody", null, rows.map((row, r) => (
      // biome-ignore lint/suspicious/noArrayIndexKey: rows have no identity
      /* @__PURE__ */ React.createElement("tr", { key: r }, result.columns.map((column, c) => {
        const value = row[c] ?? null;
        return /* @__PURE__ */ React.createElement(
          "td",
          {
            key: column.name,
            "data-numeric": column.kind === "number",
            title: value ?? "null",
            style: value === null ? { color: "var(--dbx-tertiary)", fontStyle: "italic" } : void 0
          },
          formatCell(value, column.kind)
        );
      }))
    ))))
  ), /* @__PURE__ */ React.createElement(Stack, { direction: "row", align: "center", justify: "space-between", gap: 8 }, /* @__PURE__ */ React.createElement(Text, { size: "xs", tone: "subtle" }, rows.length === total ? `${total} ${total === 1 ? "row" : "rows"}` : `Showing ${rows.length} of ${total.toLocaleString()} rows`, result.truncated && rows.length === total ? " (truncated)" : ""), /* @__PURE__ */ React.createElement(CopyButton, { text: toCsv(result), label: "Copy CSV" })));
}
var W = 560;
var H = 220;
var PAD = { top: 12, right: 12, bottom: 28, left: 52 };
function ticks(min, max, count = 4) {
  if (min === max) return [min];
  const span = max - min;
  const step = 10 ** Math.floor(Math.log10(span / count));
  const nice = [1, 2, 2.5, 5, 10].map((m) => m * step).find((s) => span / s <= count) ?? step * 10;
  const start = Math.ceil(min / nice) * nice;
  const out = [];
  for (let value = start; value <= max + nice / 1e3; value += nice) out.push(Number(value.toPrecision(12)));
  return out;
}
function Legend(props) {
  if (props.names.length < 2) return null;
  return /* @__PURE__ */ React.createElement(Stack, { direction: "row", gap: 12, wrap: true }, props.names.map((name, index) => /* @__PURE__ */ React.createElement("span", { key: name, style: { display: "inline-flex", alignItems: "center", gap: 5, fontSize: "0.6875rem", color: "var(--dbx-subtle)" } }, /* @__PURE__ */ React.createElement("span", { style: { width: 8, height: 8, borderRadius: 2, background: CHART_COLORS[index % CHART_COLORS.length] } }), name)));
}
function LineChart(props) {
  const { result, plan } = props;
  const isTime = result.columns[plan.x]?.kind === "time";
  const points = result.rows.map((row) => ({
    x: isTime ? Date.parse(String(row[plan.x])) : Number(row[plan.x]),
    raw: String(row[plan.x] ?? ""),
    ys: plan.series.map((index) => Number(row[index]))
  })).filter((point) => Number.isFinite(point.x)).sort((a, b) => a.x - b.x);
  if (points.length < 2) return null;
  const xs = points.map((point) => point.x);
  const ys = points.flatMap((point) => point.ys.filter(Number.isFinite));
  const [x0, x1] = [Math.min(...xs), Math.max(...xs)];
  const [y0, y1] = [Math.min(0, ...ys), Math.max(...ys)];
  const sx = (x) => PAD.left + (x - x0) / (x1 - x0 || 1) * (W - PAD.left - PAD.right);
  const sy = (y) => H - PAD.bottom - (y - y0) / (y1 - y0 || 1) * (H - PAD.top - PAD.bottom);
  const xTicks = [points[0], points[Math.floor(points.length / 2)], points[points.length - 1]].filter(Boolean);
  return /* @__PURE__ */ React.createElement("svg", { viewBox: `0 0 ${W} ${H}`, role: "img", "aria-label": `Line chart of ${plan.series.map((i) => result.columns[i]?.name).join(", ")}`, style: { width: "100%", height: "auto" } }, ticks(y0, y1).map((tick) => /* @__PURE__ */ React.createElement("g", { key: tick }, /* @__PURE__ */ React.createElement("line", { x1: PAD.left, x2: W - PAD.right, y1: sy(tick), y2: sy(tick), stroke: "var(--dbx-border)" }), /* @__PURE__ */ React.createElement("text", { x: PAD.left - 6, y: sy(tick) + 3, textAnchor: "end", fontSize: "10", fill: "var(--dbx-subtle)" }, formatNumber(tick, "compact")))), xTicks.map((point, index) => /* @__PURE__ */ React.createElement("text", { key: point.raw, x: sx(point.x), y: H - 8, fontSize: "10", fill: "var(--dbx-subtle)", textAnchor: index === 0 ? "start" : index === xTicks.length - 1 ? "end" : "middle" }, isTime ? point.raw.slice(0, 10) : point.raw)), plan.series.map((_, s) => /* @__PURE__ */ React.createElement(
    "polyline",
    {
      key: plan.series[s],
      fill: "none",
      stroke: CHART_COLORS[s % CHART_COLORS.length],
      strokeWidth: "2",
      strokeLinejoin: "round",
      points: points.filter((p) => Number.isFinite(p.ys[s])).map((p) => `${sx(p.x)},${sy(p.ys[s])}`).join(" ")
    }
  )));
}
function BarChart(props) {
  const { result, plan } = props;
  const rows = result.rows.slice(0, 40);
  const values = rows.flatMap((row) => plan.series.map((index) => Number(row[index])).filter(Number.isFinite));
  const max = Math.max(0, ...values);
  const min = Math.min(0, ...values);
  if (plan.horizontal) {
    const rowH = 22;
    const labelW = 150;
    const height = rows.length * rowH * Math.max(1, plan.series.length * 0.6) + 8;
    const band2 = (height - 8) / rows.length;
    const scale = (v) => (v - min) / (max - min || 1) * (W - labelW - 60);
    return /* @__PURE__ */ React.createElement("svg", { viewBox: `0 0 ${W} ${height}`, role: "img", "aria-label": "Bar chart", style: { width: "100%", height: "auto" } }, rows.map((row, r) => {
      const y = 4 + r * band2;
      const label = String(row[plan.x] ?? "null");
      return /* @__PURE__ */ React.createElement("g", { key: `${label}-${r}` }, /* @__PURE__ */ React.createElement("text", { x: labelW - 8, y: y + band2 / 2 + 3, textAnchor: "end", fontSize: "10", fill: "var(--dbx-ink)" }, label.length > 24 ? `${label.slice(0, 23)}\u2026` : label), plan.series.map((index, s) => {
        const value = Number(row[index]);
        const barH = (band2 - 4) / plan.series.length;
        const w = Number.isFinite(value) ? scale(value) - scale(0) : 0;
        return /* @__PURE__ */ React.createElement("g", { key: index }, /* @__PURE__ */ React.createElement("rect", { x: labelW + Math.min(scale(0), scale(0) + w), y: y + s * barH, width: Math.abs(w), height: Math.max(2, barH - 1), rx: "2", fill: CHART_COLORS[s % CHART_COLORS.length] }, /* @__PURE__ */ React.createElement("title", null, `${label}: ${formatNumber(value)}`)), plan.series.length === 1 && /* @__PURE__ */ React.createElement("text", { x: labelW + scale(0) + Math.max(0, w) + 4, y: y + barH / 2 + 3, fontSize: "10", fill: "var(--dbx-subtle)" }, formatNumber(value, "compact")));
      }));
    }));
  }
  const band = (W - PAD.left - PAD.right) / rows.length;
  const sy = (y) => H - PAD.bottom - (y - min) / (max - min || 1) * (H - PAD.top - PAD.bottom);
  return /* @__PURE__ */ React.createElement("svg", { viewBox: `0 0 ${W} ${H}`, role: "img", "aria-label": "Bar chart", style: { width: "100%", height: "auto" } }, ticks(min, max).map((tick) => /* @__PURE__ */ React.createElement("g", { key: tick }, /* @__PURE__ */ React.createElement("line", { x1: PAD.left, x2: W - PAD.right, y1: sy(tick), y2: sy(tick), stroke: "var(--dbx-border)" }), /* @__PURE__ */ React.createElement("text", { x: PAD.left - 6, y: sy(tick) + 3, textAnchor: "end", fontSize: "10", fill: "var(--dbx-subtle)" }, formatNumber(tick, "compact")))), rows.map((row, r) => {
    const label = String(row[plan.x] ?? "null");
    const barW = band * 0.75 / plan.series.length;
    return /* @__PURE__ */ React.createElement("g", { key: `${label}-${r}` }, plan.series.map((index, s) => {
      const value = Number(row[index]);
      const top = sy(Math.max(0, value));
      const h = Math.abs(sy(value) - sy(0));
      return /* @__PURE__ */ React.createElement("rect", { key: index, x: PAD.left + r * band + band * 0.125 + s * barW, y: top, width: Math.max(1, barW - 1), height: Math.max(1, h), rx: "2", fill: CHART_COLORS[s % CHART_COLORS.length] }, /* @__PURE__ */ React.createElement("title", null, `${label}: ${formatNumber(value)}`));
    }), /* @__PURE__ */ React.createElement("text", { x: PAD.left + r * band + band / 2, y: H - 10, fontSize: "10", textAnchor: "middle", fill: "var(--dbx-subtle)" }, label.length > 10 ? `${label.slice(0, 9)}\u2026` : label));
  }));
}
function ResultChart(props) {
  const plan = props.plan ?? planChart(props.result);
  if (plan.type === "none") return null;
  if (plan.type === "kpi")
    return /* @__PURE__ */ React.createElement(Stack, { gap: 2, style: { padding: "8px 2px" } }, /* @__PURE__ */ React.createElement(Text, { size: "xs", tone: "subtle" }, plan.label), /* @__PURE__ */ React.createElement(Text, { size: "xl", weight: 600, style: { fontSize: "1.75rem", fontVariantNumeric: "tabular-nums" } }, formatNumber(plan.value)));
  const names = plan.series.map((index) => props.result.columns[index]?.name ?? "");
  return /* @__PURE__ */ React.createElement(Stack, { gap: 6 }, /* @__PURE__ */ React.createElement(Legend, { names }), plan.type === "line" ? /* @__PURE__ */ React.createElement(LineChart, { result: props.result, plan }) : /* @__PURE__ */ React.createElement(BarChart, { result: props.result, plan }));
}
function ResultView(props) {
  const plan = React.useMemo(() => planChart(props.result), [props.result]);
  const [view, setView] = React.useState(plan.type === "none" ? "table" : "chart");
  if (!props.result.columns.length) return /* @__PURE__ */ React.createElement(Text, { tone: "subtle" }, "The query returned no columns.");
  const canChart = plan.type !== "none";
  return /* @__PURE__ */ React.createElement(Stack, { gap: 8 }, canChart && /* @__PURE__ */ React.createElement(Stack, { direction: "row", gap: 4, align: "center" }, /* @__PURE__ */ React.createElement(Button, { size: "sm", variant: view === "chart" ? "default" : "ghost", onClick: () => setView("chart") }, "Chart"), /* @__PURE__ */ React.createElement(Button, { size: "sm", variant: view === "table" ? "default" : "ghost", onClick: () => setView("table") }, "Table"), props.result.truncated && /* @__PURE__ */ React.createElement(Badge, { tone: "warning" }, "Partial")), view === "chart" && canChart ? /* @__PURE__ */ React.createElement(ResultChart, { result: props.result, plan }) : /* @__PURE__ */ React.createElement(DataTable, { result: props.result, ...props.maxHeight !== void 0 && { maxHeight: props.maxHeight } }));
}

// plugins/sql/src/codeblock.tsx
var KEYWORDS = new Set(
  "select from where group by order having limit join left right inner outer full cross on as and or not in is null like ilike between case when then else end with union all distinct over partition qualify insert into values update set delete merge using create table view replace drop alter describe show explain asc desc interval date timestamp cast true false exists any some lateral pivot unpivot window rows range preceding following current row".split(
    " "
  )
);
function highlight(sql) {
  const tokens = [];
  const pattern = /(--[^\n]*|\/\*[\s\S]*?\*\/)|('(?:[^'\\]|\\.)*'?)|(\b\d+(?:\.\d+)?\b)|([A-Za-z_][A-Za-z0-9_]*)|(\s+|[^\sA-Za-z0-9_'-]+|-)/g;
  let match;
  while (match = pattern.exec(sql)) {
    if (match[1]) tokens.push({ text: match[1], kind: "comment" });
    else if (match[2]) tokens.push({ text: match[2], kind: "string" });
    else if (match[3]) tokens.push({ text: match[3], kind: "number" });
    else if (match[4]) tokens.push({ text: match[4], kind: KEYWORDS.has(match[4].toLowerCase()) ? "keyword" : "plain" });
    else tokens.push({ text: match[0], kind: "plain" });
  }
  return tokens;
}
var COLOR = {
  keyword: "var(--dbx-lava-text)",
  string: "var(--dbx-success)",
  comment: "var(--dbx-tertiary)",
  number: "var(--text-link, #2272B4)",
  plain: "inherit"
};
function SqlText(props) {
  const tokens = React.useMemo(() => highlight(props.code), [props.code]);
  return /* @__PURE__ */ React.createElement("code", { className: "dbx-mono", style: { whiteSpace: "pre", fontSize: "inherit" } }, tokens.map(
    (token, index) => token.kind === "plain" ? token.text : (
      // biome-ignore lint/suspicious/noArrayIndexKey: token order is fixed
      /* @__PURE__ */ React.createElement("span", { key: index, style: { color: COLOR[token.kind], fontWeight: token.kind === "keyword" ? 500 : void 0 } }, token.text)
    )
  ));
}
function useRun(runs, code) {
  React.useSyncExternalStore(runs.subscribe, runs.snapshot);
  return runs.get(code);
}
function sqlBlock(service, runs) {
  return function SqlBlock(props) {
    const run = useRun(runs, props.code);
    return /* @__PURE__ */ React.createElement(DbxRoot, null, /* @__PURE__ */ React.createElement("pre", { style: { margin: 0, overflow: "auto" } }, /* @__PURE__ */ React.createElement(SqlText, { code: props.code })), run && /* @__PURE__ */ React.createElement("div", { style: { marginTop: 10, paddingTop: 10, borderTop: "1px solid var(--dbx-border)", fontFamily: "var(--font-sans, inherit)", whiteSpace: "normal" } }, run.status === "confirm" && /* @__PURE__ */ React.createElement(
      Notice,
      {
        tone: "warning",
        title: "This statement can change data",
        action: /* @__PURE__ */ React.createElement(Stack, { direction: "row", gap: 6 }, /* @__PURE__ */ React.createElement(Button, { size: "sm", variant: "primary", onClick: () => void runs.run(props.code) }, "Run anyway"), /* @__PURE__ */ React.createElement(Button, { size: "sm", variant: "ghost", onClick: () => runs.clear(props.code) }, "Cancel"))
      },
      "It will run with your Databricks access. Check it before running."
    ), run.status === "running" && /* @__PURE__ */ React.createElement(Stack, { direction: "row", gap: 8, align: "center" }, /* @__PURE__ */ React.createElement(Spinner, { size: 12 }), /* @__PURE__ */ React.createElement(Text, { tone: "subtle", size: "sm" }, "Running on Databricks\u2026"), /* @__PURE__ */ React.createElement(Button, { size: "sm", variant: "ghost", onClick: () => runs.cancel(props.code) }, "Cancel")), run.status === "error" && /* @__PURE__ */ React.createElement(Notice, { tone: "danger", title: "The query failed", action: /* @__PURE__ */ React.createElement(Button, { size: "sm", variant: "ghost", onClick: () => runs.clear(props.code) }, "Dismiss") }, run.message), run.status === "done" && /* @__PURE__ */ React.createElement(Stack, { gap: 8 }, /* @__PURE__ */ React.createElement(ResultView, { result: run.result, maxHeight: 260 }), /* @__PURE__ */ React.createElement(Stack, { direction: "row", gap: 8, align: "center", justify: "space-between" }, /* @__PURE__ */ React.createElement(Text, { tone: "tertiary", size: "xs" }, "Ran as you on ", run.warehouse, " in ", (run.ms / 1e3).toFixed(1), "s"), /* @__PURE__ */ React.createElement(Button, { size: "sm", variant: "ghost", onClick: () => runs.clear(props.code) }, "Hide result")))));
  };
}
function sqlBlockAction(service, runs) {
  return function RunSql(props) {
    const snapshot = useConnection(service);
    const run = useRun(runs, props.code);
    const connected = snapshot.status === "connected";
    return /* @__PURE__ */ React.createElement(DbxRoot, { style: { display: "inline-flex" } }, /* @__PURE__ */ React.createElement(
      Button,
      {
        size: "sm",
        variant: "ghost",
        title: connected ? "Run this query on Databricks with your access" : "Connect Databricks to run queries",
        disabled: run?.status === "running",
        onClick: () => connected ? runs.request(props.code) : service.openSettings()
      },
      run?.status === "running" ? "Running\u2026" : connected ? "\u25B6 Run" : "Connect to run"
    ));
  };
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
var Runs = class {
  constructor(service) {
    this.service = service;
  }
  runs = /* @__PURE__ */ new Map();
  controllers = /* @__PURE__ */ new Map();
  listeners = /* @__PURE__ */ new Set();
  version = 0;
  get(code) {
    return this.runs.get(code.trim());
  }
  snapshot = () => this.version;
  subscribe = (listener) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };
  /** Runs read-only statements at once; anything else asks first. */
  request(code) {
    const key = code.trim();
    if (!isReadOnlySql(key)) this.set(key, { status: "confirm" });
    else void this.run(key);
  }
  async run(code) {
    const key = code.trim();
    this.controllers.get(key)?.abort();
    const controller = new AbortController();
    this.controllers.set(key, controller);
    const startedAt = Date.now();
    this.set(key, { status: "running", startedAt });
    try {
      const warehouse = await resolveWarehouse(this.service);
      const client = await this.service.ready(controller.signal);
      const { statementId, result } = await new Sql(client).execute(key, {
        warehouseId: warehouse.id,
        rowLimit: 1e3,
        signal: controller.signal,
        onStatement: (id) => this.set(key, { status: "running", startedAt, statementId: id })
      });
      this.set(key, { status: "done", result, statementId, ms: Date.now() - startedAt, warehouse: warehouse.name });
    } catch (error) {
      if (controller.signal.aborted) this.clear(key);
      else this.set(key, { status: "error", message: describeError(error) });
    }
  }
  cancel(code) {
    this.controllers.get(code.trim())?.abort();
    this.clear(code);
  }
  clear(code) {
    this.runs.delete(code.trim());
    this.bump();
  }
  set(key, run) {
    this.runs.set(key, run);
    this.bump();
  }
  bump() {
    this.version++;
    for (const listener of [...this.listeners]) listener();
  }
};

// plugins/sql/src/tools.ts
var ALLOW_WRITES = "sqlAgentWrites";
var AUDIENCE = "These rows came from the owner's Databricks access; everyone in this conversation can read what you post. To let readers re-run it with their own access, post the SQL in a ```sql block.";
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
          AUDIENCE
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

// plugins/sql/src/page.tsx
var Editor = class {
  text = "SELECT current_user(), current_catalog(), current_date()";
  listeners = /* @__PURE__ */ new Set();
  snapshot = () => this.text;
  subscribe = (listener) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };
  set(text) {
    this.text = text;
    for (const listener of [...this.listeners]) listener();
  }
};
function Tree(props) {
  const { service, editor } = props;
  const [open, setOpen] = React.useState({});
  const catalogs = useAsync(async (signal) => new Sql(await service.ready(signal)).catalogs(signal), [service.snapshot()]);
  const toggle = (key) => setOpen((current) => ({ ...current, [key]: !current[key] }));
  if (catalogs.loading) return /* @__PURE__ */ React.createElement(Stack, { direction: "row", gap: 8, align: "center", style: { padding: 10 } }, /* @__PURE__ */ React.createElement(Spinner, { size: 12 }), /* @__PURE__ */ React.createElement(Text, { tone: "subtle", size: "sm" }, "Loading catalogs\u2026"));
  if (catalogs.error) return /* @__PURE__ */ React.createElement(Text, { tone: "danger", size: "sm", as: "div", style: { padding: 10 } }, describeError(catalogs.error));
  return /* @__PURE__ */ React.createElement("div", { role: "tree", "aria-label": "Unity Catalog" }, (catalogs.data ?? []).map((catalog) => /* @__PURE__ */ React.createElement("div", { key: catalog.name, role: "treeitem", "aria-expanded": Boolean(open[catalog.name]) }, /* @__PURE__ */ React.createElement(Row, { label: catalog.name, depth: 0, open: Boolean(open[catalog.name]), onClick: () => toggle(catalog.name) }), open[catalog.name] && /* @__PURE__ */ React.createElement(Schemas, { service, editor, catalog: catalog.name, open, toggle }))));
}
function Row(props) {
  return /* @__PURE__ */ React.createElement(
    "button",
    {
      type: "button",
      className: "dbx-row",
      onClick: props.onClick,
      title: props.title ?? props.label,
      style: {
        display: "flex",
        alignItems: "center",
        gap: 6,
        width: "100%",
        border: 0,
        background: "transparent",
        padding: `4px 8px 4px ${8 + props.depth * 14}px`,
        borderRadius: 6,
        cursor: "pointer",
        font: "inherit",
        fontSize: "0.8125rem",
        color: "var(--dbx-ink)",
        textAlign: "left"
      }
    },
    /* @__PURE__ */ React.createElement("span", { "aria-hidden": true, style: { width: 10, color: "var(--dbx-tertiary)", fontSize: 9 } }, props.leaf ? "\u25A6" : props.open ? "\u25BE" : "\u25B8"),
    /* @__PURE__ */ React.createElement("span", { style: { overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" } }, props.label)
  );
}
function Schemas(props) {
  const schemas = useAsync(async (signal) => new Sql(await props.service.ready(signal)).schemas(props.catalog, signal), [props.catalog]);
  if (schemas.loading) return /* @__PURE__ */ React.createElement(Text, { tone: "subtle", size: "xs", as: "div", style: { padding: "4px 30px" } }, "Loading\u2026");
  if (schemas.error) return /* @__PURE__ */ React.createElement(Text, { tone: "danger", size: "xs", as: "div", style: { padding: "4px 30px" } }, describeError(schemas.error));
  return /* @__PURE__ */ React.createElement(React.Fragment, null, (schemas.data ?? []).map((schema2) => /* @__PURE__ */ React.createElement("div", { key: schema2.full_name }, /* @__PURE__ */ React.createElement(Row, { label: schema2.name, depth: 1, open: Boolean(props.open[schema2.full_name]), onClick: () => props.toggle(schema2.full_name) }), props.open[schema2.full_name] && /* @__PURE__ */ React.createElement(Tables, { ...props, schema: schema2.name }))));
}
function Tables(props) {
  const tables = useAsync(async (signal) => new Sql(await props.service.ready(signal)).tables(props.catalog, props.schema, signal), [props.catalog, props.schema]);
  if (tables.loading) return /* @__PURE__ */ React.createElement(Text, { tone: "subtle", size: "xs", as: "div", style: { padding: "4px 44px" } }, "Loading\u2026");
  if (tables.error) return /* @__PURE__ */ React.createElement(Text, { tone: "danger", size: "xs", as: "div", style: { padding: "4px 44px" } }, describeError(tables.error));
  if (!tables.data?.length) return /* @__PURE__ */ React.createElement(Text, { tone: "tertiary", size: "xs", as: "div", style: { padding: "4px 44px" } }, "No tables");
  const quote = (part) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(part) ? part : `\`${part.replace(/`/g, "``")}\``;
  return /* @__PURE__ */ React.createElement(React.Fragment, null, tables.data.map((table) => /* @__PURE__ */ React.createElement(
    Row,
    {
      key: table.full_name,
      leaf: true,
      label: table.name,
      depth: 2,
      title: `${table.full_name}${table.comment ? ` \u2014 ${table.comment}` : ""}
Click to query`,
      onClick: () => props.editor.set(`SELECT *
FROM ${[props.catalog, props.schema, table.name].map(quote).join(".")}
LIMIT 100`)
    }
  )));
}
function sqlSidebar(service, editor) {
  return function SqlSidebar(props) {
    const snapshot = useConnection(service);
    return /* @__PURE__ */ React.createElement("div", { className: "shell-sidebar-default" }, /* @__PURE__ */ React.createElement(DbxRoot, { style: { display: "flex", flexDirection: "column", height: "100%", minHeight: 0 } }, /* @__PURE__ */ React.createElement(Text, { weight: 500, as: "div", style: { padding: "14px 12px 8px" } }, "Catalog"), /* @__PURE__ */ React.createElement("nav", { "aria-label": "Unity Catalog", style: { flex: 1, overflow: "auto", padding: "0 6px 8px" } }, snapshot.status === "connected" ? /* @__PURE__ */ React.createElement(Tree, { service, editor }) : /* @__PURE__ */ React.createElement(Text, { tone: "subtle", size: "sm", as: "div", style: { padding: 10 } }, "Connect Databricks to browse your catalog.")), props.children && /* @__PURE__ */ React.createElement("div", { style: { borderTop: "1px solid var(--dbx-border)", padding: 6 } }, props.children)));
  };
}
function sqlPage(service, editor, runs) {
  return function SqlPage(_props) {
    const snapshot = useConnection(service);
    const text = React.useSyncExternalStore(editor.subscribe, editor.snapshot);
    React.useSyncExternalStore(runs.subscribe, runs.snapshot);
    const [warehouseId, setWarehouseId] = usePreference(service, "warehouseId");
    const warehouses = useAsync(async (signal) => new Sql(await service.ready(signal)).warehouses(signal), [snapshot.status]);
    const [lastRun, setLastRun] = React.useState();
    const run = lastRun ? runs.get(lastRun) : void 0;
    if (snapshot.status !== "connected")
      return /* @__PURE__ */ React.createElement(DbxRoot, { style: { padding: 32 } }, /* @__PURE__ */ React.createElement(EmptyState, { title: "Connect Databricks to run SQL", action: /* @__PURE__ */ React.createElement(Button, { variant: "brand", onClick: () => service.openSettings() }, "Connect Databricks") }, "Queries run on your SQL warehouses with your Unity Catalog permissions."));
    const execute = () => {
      if (!text.trim()) return;
      setLastRun(text);
      runs.request(text);
    };
    const list = warehouses.data ?? [];
    return /* @__PURE__ */ React.createElement(DbxRoot, { style: { height: "100%", overflow: "auto" } }, /* @__PURE__ */ React.createElement(Stack, { gap: 14, style: { padding: "22px 28px", maxWidth: 1100, margin: "0 auto" } }, /* @__PURE__ */ React.createElement(Stack, { direction: "row", align: "center", justify: "space-between", gap: 12, wrap: true }, /* @__PURE__ */ React.createElement(Text, { as: "h2", size: "lg", weight: 500 }, "SQL"), /* @__PURE__ */ React.createElement(Stack, { direction: "row", gap: 8, align: "center" }, /* @__PURE__ */ React.createElement("select", { className: "dbx-select", value: warehouseId ?? "", onChange: (event) => setWarehouseId(event.target.value || void 0), "aria-label": "SQL warehouse", style: { width: 280 } }, /* @__PURE__ */ React.createElement("option", { value: "" }, "Automatic warehouse"), list.map((w) => /* @__PURE__ */ React.createElement("option", { key: w.id, value: w.id }, w.name, " \xB7 ", w.state?.toLowerCase()))), /* @__PURE__ */ React.createElement(Button, { variant: "primary", onClick: execute, disabled: run?.status === "running", title: "Run (\u2318\u21B5)" }, run?.status === "running" ? /* @__PURE__ */ React.createElement(Spinner, { size: 12, label: "Running" }) : null, "Run"))), /* @__PURE__ */ React.createElement(
      "textarea",
      {
        className: "dbx-textarea dbx-mono",
        value: text,
        onChange: (event) => editor.set(event.target.value),
        onKeyDown: (event) => {
          if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
            event.preventDefault();
            execute();
          }
        },
        spellCheck: false,
        rows: 9,
        "aria-label": "SQL statement",
        style: { fontSize: "0.8125rem", minHeight: 180 }
      }
    ), run?.status === "confirm" && lastRun && /* @__PURE__ */ React.createElement(
      Notice,
      {
        tone: "warning",
        title: "This statement can change data",
        action: /* @__PURE__ */ React.createElement(Stack, { direction: "row", gap: 6 }, /* @__PURE__ */ React.createElement(Button, { size: "sm", variant: "primary", onClick: () => void runs.run(lastRun) }, "Run anyway"), /* @__PURE__ */ React.createElement(Button, { size: "sm", variant: "ghost", onClick: () => runs.clear(lastRun) }, "Cancel"))
      },
      "It will run with your Databricks access."
    ), run?.status === "running" && /* @__PURE__ */ React.createElement(Stack, { direction: "row", gap: 8, align: "center" }, /* @__PURE__ */ React.createElement(Spinner, { size: 12 }), /* @__PURE__ */ React.createElement(Text, { tone: "subtle" }, "Running\u2026"), /* @__PURE__ */ React.createElement(Button, { size: "sm", variant: "ghost", onClick: () => lastRun && runs.cancel(lastRun) }, "Cancel")), run?.status === "error" && /* @__PURE__ */ React.createElement(Notice, { tone: "danger", title: "The query failed" }, run.message), run?.status === "done" && /* @__PURE__ */ React.createElement(Stack, { gap: 8 }, /* @__PURE__ */ React.createElement(ResultView, { result: run.result, maxHeight: 480 }), /* @__PURE__ */ React.createElement(Text, { tone: "tertiary", size: "xs" }, run.warehouse, " \xB7 ", (run.ms / 1e3).toFixed(1), "s \xB7 statement ", run.statementId))));
  };
}
function sqlSettings(service) {
  return function SqlSettings() {
    const [allow, setAllow] = usePreference(service, ALLOW_WRITES);
    return /* @__PURE__ */ React.createElement(DbxRoot, null, /* @__PURE__ */ React.createElement(Stack, { gap: 20 }, /* @__PURE__ */ React.createElement(Stack, { gap: 6 }, /* @__PURE__ */ React.createElement(Text, { as: "h2", size: "xl", weight: 500 }, "Databricks SQL"), /* @__PURE__ */ React.createElement(Text, { tone: "subtle" }, "SQL blocks in conversations get a Run action, and agents can query your data with your access.")), /* @__PURE__ */ React.createElement(
      Field,
      {
        label: "Agents can run statements that change data",
        hint: "Off: agents may only read (SELECT, SHOW, DESCRIBE). This applies to this workspace on this device."
      },
      /* @__PURE__ */ React.createElement("label", { style: { display: "flex", gap: 8, alignItems: "center", fontSize: "0.8125rem" } }, /* @__PURE__ */ React.createElement("input", { type: "checkbox", checked: Boolean(allow), onChange: (event) => setAllow(event.target.checked || void 0) }), "Allow INSERT, UPDATE, DELETE, CREATE and other writes from agents")
    )));
  };
}

// plugins/sql/src/index.tsx
var inject = ["react", "pages", "conversation", "settingsCards"];
var ICON = svgDataUri(
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><ellipse cx="12" cy="5.5" rx="7.5" ry="3"/><path d="M4.5 5.5v6c0 1.7 3.4 3 7.5 3s7.5-1.3 7.5-3v-6"/><path d="M4.5 11.5v6c0 1.7 3.4 3 7.5 3s7.5-1.3 7.5-3v-6"/></svg>'
);
function apply(ctx) {
  bindReact(ctx.react);
  const live = attach(ctx, { id: "bkvarda.databricks-sql", name: "Databricks SQL" }, (scope, databricks) => {
    const runs = new Runs(databricks);
    const editor = new Editor();
    scope.conversation.registerCodeBlock({
      id: "sql",
      title: "Databricks SQL",
      matches: (language) => /^(sql|databricks-sql|sparksql|spark-sql)$/i.test(language.trim()),
      component: sqlBlock(databricks, runs),
      action: sqlBlockAction(databricks, runs)
    });
    scope.settingsCards.register({ id: "sql", title: "Databricks SQL", component: sqlSettings(databricks) });
    scope.inject(["agents"], (agents) => {
      for (const tool of sqlTools(databricks)) agents.agents.addTool(tool);
    });
    return { page: sqlPage(databricks, editor, runs), sidebar: sqlSidebar(databricks, editor) };
  });
  ctx.pages.register({
    id: "sql",
    title: "SQL",
    primary: true,
    icon: ICON,
    component: (props) => {
      const runtime = useLive(live);
      return runtime ? /* @__PURE__ */ React.createElement(runtime.page, { ...props }) : /* @__PURE__ */ React.createElement(MissingCore, { ctx, feature: "Databricks SQL" });
    },
    sidebar: (props) => {
      const runtime = useLive(live);
      return runtime ? /* @__PURE__ */ React.createElement(runtime.sidebar, { ...props }) : /* @__PURE__ */ React.createElement("div", { className: "shell-sidebar-default" }, props.children);
    }
  });
}
export {
  apply,
  inject
};
