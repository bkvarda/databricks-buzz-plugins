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
var RUNNER = '// Databricks Agents runner for Buzz (built by databricks-buzz-plugins). Apache-2.0.\nimport{execFile as Vs,spawn as Zs}from"node:child_process";import{appendFileSync as Ys,existsSync as Se,openSync as Xs,readFileSync as at,rmSync as hr,statSync as gr,truncateSync as Ws,writeFileSync as Vt}from"node:fs";var wr=/^(tinyint|smallint|int|integer|bigint|long|short|byte|float|double|real|decimal|numeric)/i,Xt=/^(date|timestamp)/i,Er=/(^|_)(id|ids|zip|zipcode|zip_code|postal_code|postcode|code|key|year|fiscal_year|phone)$/i;function Sr(e,t,r=""){if(Er.test(r)&&!Xt.test(e??"")&&!/^bool/i.test(e??""))return"text";if(e){if(wr.test(e))return"number";if(Xt.test(e))return"time";if(/^bool/i.test(e))return"boolean";if(/^(string|varchar|char|binary|array|map|struct|interval)/i.test(e))return"text"}let n=t.filter(s=>s!==null&&s!=="");return n.length?n.every(s=>/^-?\\d+(\\.\\d+)?([eE][+-]?\\d+)?$/.test(s))?"number":n.every(s=>/^\\d{4}-\\d{2}(-\\d{2})?([T ]\\d{2}:\\d{2}(:\\d{2}(\\.\\d+)?)?(Z|[+-]\\d{2}:?\\d{2})?)?$/.test(s))?"time":"text":"text"}function Le(e,t,r={}){return{columns:e.map((n,s)=>({name:n.name,...n.type&&{type:n.type},kind:Sr(n.type,t.slice(0,50).map(o=>o[s]??null),n.name)})),rows:t,...r}}function ct(e){let t=(e.manifest?.schema?.columns??[]).map(s=>({name:s.name,type:s.type_text??s.type_name??""})),r=e.result?.data_array??[],n=e.manifest?.total_row_count;return Le(t,r,{...n!==void 0&&{totalRows:n},truncated:!!e.manifest?.truncated||n!==void 0&&n>r.length})}var vr=new Intl.NumberFormat(void 0,{notation:"compact",maximumFractionDigits:1}),_r=new Intl.NumberFormat(void 0,{maximumFractionDigits:2});function Rr(e,t="precise"){return Number.isFinite(e)?t==="compact"&&Math.abs(e)>=1e4?vr.format(e):_r.format(e):String(e)}function kr(e,t){if(e===null)return"null";if(t==="number"){let r=Number(e);if(Number.isFinite(r)&&Math.abs(r)<1e15)return Rr(r)}return t==="time"&&/T00:00:00(\\.000)?(Z)?$/.test(e)?e.slice(0,10):e}function Wt(e,t=20){if(!e.columns.length)return"_No columns._";let r=c=>c.replace(/\\|/g,"\\\\|").replace(/\\n/g," "),n=`| ${e.columns.map(c=>r(c.name)).join(" | ")} |`,s=`| ${e.columns.map(c=>c.kind==="number"?"---:":"---").join(" | ")} |`,o=e.rows.slice(0,t).map(c=>`| ${e.columns.map((d,l)=>r(kr(c[l]??null,d.kind))).join(" | ")} |`),a=e.totalRows??e.rows.length,i=a>Math.min(t,e.rows.length)?`\n\n_Showing ${Math.min(t,e.rows.length)} of ${a} rows._`:"";return[n,s,...o].join(`\n`)+i}function Tr(e){let t=r=>r===null?"":/[",\\n]/.test(r)?`"${r.replace(/"/g,\'""\')}"`:r;return[e.columns.map(r=>t(r.name)).join(","),...e.rows.map(r=>r.map(t).join(","))].join(`\n`)}var dt="databricks-result";function ve(e,t=200){let r={...e,rows:e.rows.slice(0,t)},n=Tr(r),s=n.includes("```")?"````":"```",o=e.totalRows??e.rows.length,a=o>r.rows.length?`\n\n_Showing ${r.rows.length} of ${o} rows._`:"";return`${s}${dt}\n${n}\n${s}${a}`}var Ar=new Set(["COMPLETED","FAILED","QUERY_RESULT_EXPIRED","CANCELLED"]);var Jt=e=>e.message_id??e.id??"";function Br(e){let t=e.attachments??[],r=t.map(o=>o.text?.content).filter(o=>!!o).join(`\n\n`),n=t.find(o=>o.query?.query),s=t.flatMap(o=>o.suggested_questions?.questions??[]);return{text:r,sql:n?.query?.query,queryTitle:n?.query?.title,queryDescription:n?.query?.description,queryAttachmentId:n?.attachment_id,rowCount:n?.query?.query_result_metadata?.row_count,suggestions:s,error:e.error?.error}}var _e=e=>`/api/2.0/genie/spaces/${encodeURIComponent(e)}`,Re=class{constructor(t){this.client=t}async listSpaces(t){let r=[],n;for(let s=0;s<20;s++){let o=await this.client.get("/api/2.0/genie/spaces",{query:{page_size:100,page_token:n},...t&&{signal:t}});if(r.push(...o.spaces??[]),n=o.next_page_token,!n)break}return r.sort((s,o)=>s.title.localeCompare(o.title))}getSpace(t,r){return this.client.get(_e(t),r?{signal:r}:{})}async ask(t,r,n,s){if(n){let i=await this.client.post(`${_e(t)}/conversations/${encodeURIComponent(n)}/messages`,{content:r},s?{signal:s}:{});return{...i,conversation_id:i.conversation_id??n}}let o=await this.client.post(`${_e(t)}/start-conversation`,{content:r},s?{signal:s}:{}),a=o.conversation_id??o.conversation?.id??o.message?.conversation_id??"";return{content:r,status:"SUBMITTED",...o.message,conversation_id:a,message_id:o.message_id??o.message?.message_id??o.message?.id??""}}getMessage(t,r,n,s){return this.client.get(`${_e(t)}/conversations/${encodeURIComponent(r)}/messages/${encodeURIComponent(n)}`,s?{signal:s}:{})}async wait(t,r,n,s){let o=r,a=1e3,i=Date.now()+10*6e4;for(;!Ar.has(o.status);){if(Date.now()>i)throw new Error("Genie did not answer within 10 minutes.");await new Promise(c=>setTimeout(c,a)),s?.throwIfAborted(),a=Math.min(5e3,Math.round(a*1.4)),o={...await this.getMessage(t,o.conversation_id,Jt(o),s),conversation_id:o.conversation_id},n?.(o)}return o}async result(t,r,n,s){let o=`${_e(t)}/conversations/${encodeURIComponent(r.conversation_id)}/messages/${encodeURIComponent(Jt(r))}/attachments/${encodeURIComponent(n)}`;try{let i=await this.client.get(`${o}/query-result`,s?{signal:s}:{});if(i.statement_response?.result||i.statement_response?.manifest)return ct(i.statement_response)}catch(i){if(i.status!==404&&i.status!==400)throw i}let a=await this.client.post(`${o}/execute-query`,{},s?{signal:s}:{});return ct(a.statement_response??{})}async answer(t,r,n={}){let s=await this.ask(t,r,n.conversationId,n.signal);n.onUpdate?.(s);let o=await this.wait(t,s,n.onUpdate,n.signal),a=Br(o),i;return o.status==="COMPLETED"&&a.queryAttachmentId&&(i=await this.result(t,o,a.queryAttachmentId,n.signal).catch(()=>{})),{message:o,...a,result:i}}static webPath(t,r){return`/genie/rooms/${encodeURIComponent(t)}${r?`/chats/${encodeURIComponent(r)}`:""}`}};function lt(e){return e instanceof Uint8Array||ArrayBuffer.isView(e)&&e.constructor.name==="Uint8Array"}function ge(e,t=""){if(!Number.isSafeInteger(e)||e<0){let r=t&&`"${t}" `;throw new Error(`${r}expected integer >= 0, got ${e}`)}}function D(e,t,r=""){let n=lt(e),s=e?.length,o=t!==void 0;if(!n||o&&s!==t){let a=r&&`"${r}" `,i=o?` of length ${t}`:"",c=n?`length=${s}`:`type=${typeof e}`;throw new Error(a+"expected Uint8Array"+i+", got "+c)}return e}function ut(e,t=!0){if(e.destroyed)throw new Error("Hash instance has been destroyed");if(t&&e.finished)throw new Error("Hash#digest() has already been called")}function Qt(e,t){D(e,void 0,"digestInto() output");let r=t.outputLen;if(e.length<r)throw new Error(\'"digestInto() output" expected to be of length >=\'+r)}function ke(...e){for(let t=0;t<e.length;t++)e[t].fill(0)}function Me(e){return new DataView(e.buffer,e.byteOffset,e.byteLength)}function Y(e,t){return e<<32-t|e>>>t}var en=typeof Uint8Array.from([]).toHex=="function"&&typeof Uint8Array.fromHex=="function",Ir=Array.from({length:256},(e,t)=>t.toString(16).padStart(2,"0"));function X(e){if(D(e),en)return e.toHex();let t="";for(let r=0;r<e.length;r++)t+=Ir[e[r]];return t}var te={_0:48,_9:57,A:65,F:70,a:97,f:102};function Ft(e){if(e>=te._0&&e<=te._9)return e-te._0;if(e>=te.A&&e<=te.F)return e-(te.A-10);if(e>=te.a&&e<=te.f)return e-(te.a-10)}function Q(e){if(typeof e!="string")throw new Error("hex string expected, got "+typeof e);if(en)return Uint8Array.fromHex(e);let t=e.length,r=t/2;if(t%2)throw new Error("hex string expected, got unpadded hex of length "+t);let n=new Uint8Array(r);for(let s=0,o=0;s<r;s++,o+=2){let a=Ft(e.charCodeAt(o)),i=Ft(e.charCodeAt(o+1));if(a===void 0||i===void 0){let c=e[o]+e[o+1];throw new Error(\'hex string expected, got non-hex character "\'+c+\'" at index \'+o)}n[s]=a*16+i}return n}function se(...e){let t=0;for(let n=0;n<e.length;n++){let s=e[n];D(s),t+=s.length}let r=new Uint8Array(t);for(let n=0,s=0;n<e.length;n++){let o=e[n];r.set(o,s),s+=o.length}return r}function tn(e,t={}){let r=(s,o)=>e(o).update(s).digest(),n=e(void 0);return r.outputLen=n.outputLen,r.blockLen=n.blockLen,r.create=s=>e(s),Object.assign(r,t),Object.freeze(r)}function Te(e=32){let t=typeof globalThis=="object"?globalThis.crypto:null;if(typeof t?.getRandomValues!="function")throw new Error("crypto.getRandomValues must be defined");return t.getRandomValues(new Uint8Array(e))}var nn=e=>({oid:Uint8Array.from([6,9,96,134,72,1,101,3,4,2,e])});function rn(e,t,r){return e&t^~e&r}function sn(e,t,r){return e&t^e&r^t&r}var Pe=class{blockLen;outputLen;padOffset;isLE;buffer;view;finished=!1;length=0;pos=0;destroyed=!1;constructor(t,r,n,s){this.blockLen=t,this.outputLen=r,this.padOffset=n,this.isLE=s,this.buffer=new Uint8Array(t),this.view=Me(this.buffer)}update(t){ut(this),D(t);let{view:r,buffer:n,blockLen:s}=this,o=t.length;for(let a=0;a<o;){let i=Math.min(s-this.pos,o-a);if(i===s){let c=Me(t);for(;s<=o-a;a+=s)this.process(c,a);continue}n.set(t.subarray(a,a+i),this.pos),this.pos+=i,a+=i,this.pos===s&&(this.process(r,0),this.pos=0)}return this.length+=t.length,this.roundClean(),this}digestInto(t){ut(this),Qt(t,this),this.finished=!0;let{buffer:r,view:n,blockLen:s,isLE:o}=this,{pos:a}=this;r[a++]=128,ke(this.buffer.subarray(a)),this.padOffset>s-a&&(this.process(n,0),a=0);for(let u=a;u<s;u++)r[u]=0;n.setBigUint64(s-8,BigInt(this.length*8),o),this.process(n,0);let i=Me(t),c=this.outputLen;if(c%4)throw new Error("_sha2: outputLen must be aligned to 32bit");let d=c/4,l=this.get();if(d>l.length)throw new Error("_sha2: outputLen bigger than state");for(let u=0;u<d;u++)i.setUint32(4*u,l[u],o)}digest(){let{buffer:t,outputLen:r}=this;this.digestInto(t);let n=t.slice(0,r);return this.destroy(),n}_cloneInto(t){t||=new this.constructor,t.set(...this.get());let{blockLen:r,buffer:n,length:s,finished:o,destroyed:a,pos:i}=this;return t.destroyed=a,t.finished=o,t.length=s,t.pos=i,s%r&&t.buffer.set(n),t}clone(){return this._cloneInto()}},ne=Uint32Array.from([1779033703,3144134277,1013904242,2773480762,1359893119,2600822924,528734635,1541459225]);var $r=Uint32Array.from([1116352408,1899447441,3049323471,3921009573,961987163,1508970993,2453635748,2870763221,3624381080,310598401,607225278,1426881987,1925078388,2162078206,2614888103,3248222580,3835390401,4022224774,264347078,604807628,770255983,1249150122,1555081692,1996064986,2554220882,2821834349,2952996808,3210313671,3336571891,3584528711,113926993,338241895,666307205,773529912,1294757372,1396182291,1695183700,1986661051,2177026350,2456956037,2730485921,2820302411,3259730800,3345764771,3516065817,3600352804,4094571909,275423344,430227734,506948616,659060556,883997877,958139571,1322822218,1537002063,1747873779,1955562222,2024104815,2227730452,2361852424,2428436474,2756734187,3204031479,3329325298]),oe=new Uint32Array(64),ft=class extends Pe{constructor(t){super(64,t,8,!1)}get(){let{A:t,B:r,C:n,D:s,E:o,F:a,G:i,H:c}=this;return[t,r,n,s,o,a,i,c]}set(t,r,n,s,o,a,i,c){this.A=t|0,this.B=r|0,this.C=n|0,this.D=s|0,this.E=o|0,this.F=a|0,this.G=i|0,this.H=c|0}process(t,r){for(let u=0;u<16;u++,r+=4)oe[u]=t.getUint32(r,!1);for(let u=16;u<64;u++){let p=oe[u-15],h=oe[u-2],v=Y(p,7)^Y(p,18)^p>>>3,I=Y(h,17)^Y(h,19)^h>>>10;oe[u]=I+oe[u-7]+v+oe[u-16]|0}let{A:n,B:s,C:o,D:a,E:i,F:c,G:d,H:l}=this;for(let u=0;u<64;u++){let p=Y(i,6)^Y(i,11)^Y(i,25),h=l+p+rn(i,c,d)+$r[u]+oe[u]|0,I=(Y(n,2)^Y(n,13)^Y(n,22))+sn(n,s,o)|0;l=d,d=c,c=i,i=a+h|0,a=o,o=s,s=n,n=h+I|0}n=n+this.A|0,s=s+this.B|0,o=o+this.C|0,a=a+this.D|0,i=i+this.E|0,c=c+this.F|0,d=d+this.G|0,l=l+this.H|0,this.set(n,s,o,a,i,c,d,l)}roundClean(){ke(oe)}destroy(){this.set(0,0,0,0,0,0,0,0),ke(this.buffer)}},pt=class extends ft{A=ne[0]|0;B=ne[1]|0;C=ne[2]|0;D=ne[3]|0;E=ne[4]|0;F=ne[5]|0;G=ne[6]|0;H=ne[7]|0;constructor(){super(32)}};var de=tn(()=>new pt,nn(1));var gt=BigInt(0),ht=BigInt(1);function mt(e,t=""){if(typeof e!="boolean"){let r=t&&`"${t}" `;throw new Error(r+"expected boolean, got type="+typeof e)}return e}function Or(e){if(typeof e=="bigint"){if(!Dr(e))throw new Error("positive bigint expected, got "+e)}else ge(e);return e}function on(e){if(typeof e!="string")throw new Error("hex string expected, got "+typeof e);return e===""?gt:BigInt("0x"+e)}function me(e){return on(X(e))}function yt(e){return on(X(Nr(D(e)).reverse()))}function qe(e,t){ge(t),e=Or(e);let r=Q(e.toString(16).padStart(t*2,"0"));if(r.length!==t)throw new Error("number too large");return r}function bt(e,t){return qe(e,t).reverse()}function Nr(e){return Uint8Array.from(e)}function an(e){return Uint8Array.from(e,(t,r)=>{let n=t.charCodeAt(0);if(t.length!==1||n>127)throw new Error(`string contains non-ASCII character "${e[r]}" with code ${n} at position ${r}`);return n})}var Dr=e=>typeof e=="bigint"&&gt<=e;function xt(e){let t;for(t=0;e>gt;e>>=ht,t+=1);return t}var Ue=e=>(ht<<BigInt(e))-ht;function He(e,t={},r={}){if(!e||typeof e!="object")throw new Error("expected valid options object");function n(o,a,i){let c=e[o];if(i&&c===void 0)return;let d=typeof c;if(d!==a||c===null)throw new Error(`param "${o}" is invalid: expected ${a}, got ${d}`)}let s=(o,a)=>Object.entries(o).forEach(([i,c])=>n(i,c,a));s(t,!1),s(r,!0)}function wt(e){let t=new WeakMap;return(r,...n)=>{let s=t.get(r);if(s!==void 0)return s;let o=e(r,...n);return t.set(r,o),o}}var U=BigInt(0),P=BigInt(1),le=BigInt(2),ln=BigInt(3),un=BigInt(4),fn=BigInt(5),Cr=BigInt(7),pn=BigInt(8),Lr=BigInt(9),hn=BigInt(16);function W(e,t){let r=e%t;return r>=U?r:t+r}function j(e,t,r){let n=e;for(;t-- >U;)n*=n,n%=r;return n}function cn(e,t){if(e===U)throw new Error("invert: expected non-zero number");if(t<=U)throw new Error("invert: expected positive modulus, got "+t);let r=W(e,t),n=t,s=U,o=P,a=P,i=U;for(;r!==U;){let d=n/r,l=n%r,u=s-a*d,p=o-i*d;n=r,r=l,s=a,o=i,a=u,i=p}if(n!==P)throw new Error("invert: does not exist");return W(s,t)}function St(e,t,r){if(!e.eql(e.sqr(t),r))throw new Error("Cannot find square root")}function gn(e,t){let r=(e.ORDER+P)/un,n=e.pow(t,r);return St(e,n,t),n}function Mr(e,t){let r=(e.ORDER-fn)/pn,n=e.mul(t,le),s=e.pow(n,r),o=e.mul(t,s),a=e.mul(e.mul(o,le),s),i=e.mul(o,e.sub(a,e.ONE));return St(e,i,t),i}function Pr(e){let t=ye(e),r=mn(e),n=r(t,t.neg(t.ONE)),s=r(t,n),o=r(t,t.neg(n)),a=(e+Cr)/hn;return(i,c)=>{let d=i.pow(c,a),l=i.mul(d,n),u=i.mul(d,s),p=i.mul(d,o),h=i.eql(i.sqr(l),c),v=i.eql(i.sqr(u),c);d=i.cmov(d,l,h),l=i.cmov(p,u,v);let I=i.eql(i.sqr(l),c),k=i.cmov(d,l,I);return St(i,k,c),k}}function mn(e){if(e<ln)throw new Error("sqrt is not defined for small field");let t=e-P,r=0;for(;t%le===U;)t/=le,r++;let n=le,s=ye(e);for(;dn(s,n)===1;)if(n++>1e3)throw new Error("Cannot find square root: probably non-prime P");if(r===1)return gn;let o=s.pow(n,t),a=(t+P)/le;return function(c,d){if(c.is0(d))return d;if(dn(c,d)!==1)throw new Error("Cannot find square root");let l=r,u=c.mul(c.ONE,o),p=c.pow(d,t),h=c.pow(d,a);for(;!c.eql(p,c.ONE);){if(c.is0(p))return c.ZERO;let v=1,I=c.sqr(p);for(;!c.eql(I,c.ONE);)if(v++,I=c.sqr(I),v===l)throw new Error("Cannot find square root");let k=P<<BigInt(l-v-1),L=c.pow(u,k);l=v,u=c.sqr(L),p=c.mul(p,u),h=c.mul(h,L)}return h}}function qr(e){return e%un===ln?gn:e%pn===fn?Mr:e%hn===Lr?Pr(e):mn(e)}var Ur=["create","isValid","is0","neg","inv","sqrt","sqr","eql","add","sub","mul","pow","div","addN","subN","mulN","sqrN"];function yn(e){let t={ORDER:"bigint",BYTES:"number",BITS:"number"},r=Ur.reduce((n,s)=>(n[s]="function",n),t);return He(e,r),e}function Hr(e,t,r){if(r<U)throw new Error("invalid exponent, negatives unsupported");if(r===U)return e.ONE;if(r===P)return t;let n=e.ONE,s=t;for(;r>U;)r&P&&(n=e.mul(n,s)),s=e.sqr(s),r>>=P;return n}function vt(e,t,r=!1){let n=new Array(t.length).fill(r?e.ZERO:void 0),s=t.reduce((a,i,c)=>e.is0(i)?a:(n[c]=a,e.mul(a,i)),e.ONE),o=e.inv(s);return t.reduceRight((a,i,c)=>e.is0(i)?a:(n[c]=e.mul(a,n[c]),e.mul(a,i)),o),n}function dn(e,t){let r=(e.ORDER-P)/le,n=e.pow(t,r),s=e.eql(n,e.ONE),o=e.eql(n,e.ZERO),a=e.eql(n,e.neg(e.ONE));if(!s&&!o&&!a)throw new Error("invalid Legendre symbol result");return s?1:o?0:-1}function Gr(e,t){t!==void 0&&ge(t);let r=t!==void 0?t:e.toString(2).length,n=Math.ceil(r/8);return{nBitLength:r,nByteLength:n}}var Et=class{ORDER;BITS;BYTES;isLE;ZERO=U;ONE=P;_lengths;_sqrt;_mod;constructor(t,r={}){if(t<=U)throw new Error("invalid field: expected ORDER > 0, got "+t);let n;this.isLE=!1,r!=null&&typeof r=="object"&&(typeof r.BITS=="number"&&(n=r.BITS),typeof r.sqrt=="function"&&(this.sqrt=r.sqrt),typeof r.isLE=="boolean"&&(this.isLE=r.isLE),r.allowedLengths&&(this._lengths=r.allowedLengths?.slice()),typeof r.modFromBytes=="boolean"&&(this._mod=r.modFromBytes));let{nBitLength:s,nByteLength:o}=Gr(t,n);if(o>2048)throw new Error("invalid field: expected ORDER of <= 2048 bytes");this.ORDER=t,this.BITS=s,this.BYTES=o,this._sqrt=void 0,Object.preventExtensions(this)}create(t){return W(t,this.ORDER)}isValid(t){if(typeof t!="bigint")throw new Error("invalid field element: expected bigint, got "+typeof t);return U<=t&&t<this.ORDER}is0(t){return t===U}isValidNot0(t){return!this.is0(t)&&this.isValid(t)}isOdd(t){return(t&P)===P}neg(t){return W(-t,this.ORDER)}eql(t,r){return t===r}sqr(t){return W(t*t,this.ORDER)}add(t,r){return W(t+r,this.ORDER)}sub(t,r){return W(t-r,this.ORDER)}mul(t,r){return W(t*r,this.ORDER)}pow(t,r){return Hr(this,t,r)}div(t,r){return W(t*cn(r,this.ORDER),this.ORDER)}sqrN(t){return t*t}addN(t,r){return t+r}subN(t,r){return t-r}mulN(t,r){return t*r}inv(t){return cn(t,this.ORDER)}sqrt(t){return this._sqrt||(this._sqrt=qr(this.ORDER)),this._sqrt(this,t)}toBytes(t){return this.isLE?bt(t,this.BYTES):qe(t,this.BYTES)}fromBytes(t,r=!1){D(t);let{_lengths:n,BYTES:s,isLE:o,ORDER:a,_mod:i}=this;if(n){if(!n.includes(t.length)||t.length>s)throw new Error("Field.fromBytes: expected "+n+" bytes, got "+t.length);let d=new Uint8Array(s);d.set(t,o?0:d.length-t.length),t=d}if(t.length!==s)throw new Error("Field.fromBytes: expected "+s+" bytes, got "+t.length);let c=o?yt(t):me(t);if(i&&(c=W(c,a)),!r&&!this.isValid(c))throw new Error("invalid field element: outside of range 0..ORDER");return c}invertBatch(t){return vt(this,t)}cmov(t,r,n){return n?r:t}};function ye(e,t={}){return new Et(e,t)}function bn(e){if(typeof e!="bigint")throw new Error("field order must be bigint");let t=e.toString(2).length;return Math.ceil(t/8)}function jr(e){let t=bn(e);return t+Math.ceil(t/2)}function xn(e,t,r=!1){D(e);let n=e.length,s=bn(t),o=jr(t);if(n<16||n<o||n>1024)throw new Error("expected "+o+"-1024 bytes of input, got "+n);let a=r?yt(e):me(e),i=W(a,t-P)+P;return r?bt(i,s):qe(i,s)}var be=BigInt(0),ue=BigInt(1);function Ae(e,t){let r=t.negate();return e?r:t}function Tt(e,t){let r=vt(e.Fp,t.map(n=>n.Z));return t.map((n,s)=>e.fromAffine(n.toAffine(r[s])))}function vn(e,t){if(!Number.isSafeInteger(e)||e<=0||e>t)throw new Error("invalid window size, expected [1.."+t+"], got W="+e)}function _t(e,t){vn(e,t);let r=Math.ceil(t/e)+1,n=2**(e-1),s=2**e,o=Ue(e),a=BigInt(e);return{windows:r,windowSize:n,mask:o,maxNumber:s,shiftBy:a}}function wn(e,t,r){let{windowSize:n,mask:s,maxNumber:o,shiftBy:a}=r,i=Number(e&s),c=e>>a;i>n&&(i-=o,c+=ue);let d=t*n,l=d+Math.abs(i)-1,u=i===0,p=i<0,h=t%2!==0;return{nextN:c,offset:l,isZero:u,isNeg:p,isNegF:h,offsetF:d}}var Rt=new WeakMap,_n=new WeakMap;function kt(e){return _n.get(e)||1}function En(e){if(e!==be)throw new Error("invalid wNAF")}var Ge=class{BASE;ZERO;Fn;bits;constructor(t,r){this.BASE=t.BASE,this.ZERO=t.ZERO,this.Fn=t.Fn,this.bits=r}_unsafeLadder(t,r,n=this.ZERO){let s=t;for(;r>be;)r&ue&&(n=n.add(s)),s=s.double(),r>>=ue;return n}precomputeWindow(t,r){let{windows:n,windowSize:s}=_t(r,this.bits),o=[],a=t,i=a;for(let c=0;c<n;c++){i=a,o.push(i);for(let d=1;d<s;d++)i=i.add(a),o.push(i);a=i.double()}return o}wNAF(t,r,n){if(!this.Fn.isValid(n))throw new Error("invalid scalar");let s=this.ZERO,o=this.BASE,a=_t(t,this.bits);for(let i=0;i<a.windows;i++){let{nextN:c,offset:d,isZero:l,isNeg:u,isNegF:p,offsetF:h}=wn(n,i,a);n=c,l?o=o.add(Ae(p,r[h])):s=s.add(Ae(u,r[d]))}return En(n),{p:s,f:o}}wNAFUnsafe(t,r,n,s=this.ZERO){let o=_t(t,this.bits);for(let a=0;a<o.windows&&n!==be;a++){let{nextN:i,offset:c,isZero:d,isNeg:l}=wn(n,a,o);if(n=i,!d){let u=r[c];s=s.add(l?u.negate():u)}}return En(n),s}getPrecomputes(t,r,n){let s=Rt.get(r);return s||(s=this.precomputeWindow(r,t),t!==1&&(typeof n=="function"&&(s=n(s)),Rt.set(r,s))),s}cached(t,r,n){let s=kt(t);return this.wNAF(s,this.getPrecomputes(s,t,n),r)}unsafe(t,r,n,s){let o=kt(t);return o===1?this._unsafeLadder(t,r,s):this.wNAFUnsafe(o,this.getPrecomputes(o,t,n),r,s)}createCache(t,r){vn(r,this.bits),_n.set(t,r),Rt.delete(t)}hasCache(t){return kt(t)!==1}};function Rn(e,t,r,n){let s=t,o=e.ZERO,a=e.ZERO;for(;r>be||n>be;)r&ue&&(o=o.add(s)),n&ue&&(a=a.add(s)),s=s.double(),r>>=ue,n>>=ue;return{p1:o,p2:a}}function Sn(e,t,r){if(t){if(t.ORDER!==e)throw new Error("Field.ORDER must match order: Fp == p, Fn == n");return yn(t),t}else return ye(e,{isLE:r})}function kn(e,t,r={},n){if(n===void 0&&(n=e==="edwards"),!t||typeof t!="object")throw new Error(`expected valid ${e} CURVE object`);for(let c of["p","n","h"]){let d=t[c];if(!(typeof d=="bigint"&&d>be))throw new Error(`CURVE.${c} must be positive bigint`)}let s=Sn(t.p,r.Fp,n),o=Sn(t.n,r.Fn,n),i=["Gx","Gy","a",e==="weierstrass"?"b":"d"];for(let c of i)if(!s.isValid(t[c]))throw new Error(`CURVE.${c} must be valid field element of CURVE.Fp`);return t=Object.freeze(Object.assign({},t)),{CURVE:t,Fp:s,Fn:o}}function At(e,t){return function(n){let s=e(n);return{secretKey:s,publicKey:t(s)}}}var Tn=(e,t)=>(e+(e>=0?t:-t)/Kr)/t;function zr(e,t,r){let[[n,s],[o,a]]=t,i=Tn(a*e,r),c=Tn(-s*e,r),d=e-i*n-c*o,l=-i*s-c*a,u=d<Be,p=l<Be;u&&(d=-d),p&&(l=-l);let h=Ue(Math.ceil(xt(r)/2))+ze;if(d<Be||d>=h||l<Be||l>=h)throw new Error("splitScalar (endomorphism): failed, k="+e);return{k1neg:u,k1:d,k2neg:p,k2:l}}var Be=BigInt(0),ze=BigInt(1),Kr=BigInt(2),je=BigInt(3),Vr=BigInt(4);function An(e,t={}){let r=kn("weierstrass",e,t),{Fp:n,Fn:s}=r,o=r.CURVE,{h:a,n:i}=o;He(t,{},{allowInfinityPoint:"boolean",clearCofactor:"function",isTorsionFree:"function",fromBytes:"function",toBytes:"function",endo:"object"});let{endo:c}=t;if(c&&(!n.is0(o.a)||typeof c.beta!="bigint"||!Array.isArray(c.basises)))throw new Error(\'invalid endo: expected "beta": bigint and "basises": array\');let d=Yr(n,s);function l(){if(!n.isOdd)throw new Error("compression is not supported: Field does not have .isOdd()")}function u(T,f,g){let{x:w,y:S}=f.toAffine(),A=n.toBytes(w);if(mt(g,"isCompressed"),g){l();let m=!n.isOdd(S);return se(Zr(m),A)}else return se(Uint8Array.of(4),A,n.toBytes(S))}function p(T){D(T,void 0,"Point");let{publicKey:f,publicKeyUncompressed:g}=d,w=T.length,S=T[0],A=T.subarray(1);if(w===f&&(S===2||S===3)){let m=n.fromBytes(A);if(!n.isValid(m))throw new Error("bad point: is not on curve, wrong x");let x=I(m),y;try{y=n.sqrt(x)}catch(z){let M=z instanceof Error?": "+z.message:"";throw new Error("bad point: is not on curve, sqrt error"+M)}l();let R=n.isOdd(y);return(S&1)===1!==R&&(y=n.neg(y)),{x:m,y}}else if(w===g&&S===4){let m=n.BYTES,x=n.fromBytes(A.subarray(0,m)),y=n.fromBytes(A.subarray(m,m*2));if(!k(x,y))throw new Error("bad point: is not on curve");return{x,y}}else throw new Error(`bad point: got length ${w}, expected compressed=${f} or uncompressed=${g}`)}let h=t.toBytes||u,v=t.fromBytes||p;function I(T){let f=n.sqr(T),g=n.mul(f,T);return n.add(n.add(g,n.mul(T,o.a)),o.b)}function k(T,f){let g=n.sqr(f),w=I(T);return n.eql(g,w)}if(!k(o.Gx,o.Gy))throw new Error("bad curve params: generator point");let L=n.mul(n.pow(o.a,je),Vr),N=n.mul(n.sqr(o.b),BigInt(27));if(n.is0(n.add(L,N)))throw new Error("bad curve params: a or b");function re(T,f,g=!1){if(!n.isValid(f)||g&&n.is0(f))throw new Error(`bad point coordinate ${T}`);return f}function ae(T){if(!(T instanceof b))throw new Error("Weierstrass Point expected")}function ce(T){if(!c||!c.basises)throw new Error("no endo");return zr(T,c.basises,s.ORDER)}let pe=wt((T,f)=>{let{X:g,Y:w,Z:S}=T;if(n.eql(S,n.ONE))return{x:g,y:w};let A=T.is0();f==null&&(f=A?n.ONE:n.inv(S));let m=n.mul(g,f),x=n.mul(w,f),y=n.mul(S,f);if(A)return{x:n.ZERO,y:n.ZERO};if(!n.eql(y,n.ONE))throw new Error("invZ was invalid");return{x:m,y:x}}),E=wt(T=>{if(T.is0()){if(t.allowInfinityPoint&&!n.is0(T.Y))return;throw new Error("bad point: ZERO")}let{x:f,y:g}=T.toAffine();if(!n.isValid(f)||!n.isValid(g))throw new Error("bad point: x or y not field elements");if(!k(f,g))throw new Error("bad point: equation left != right");if(!T.isTorsionFree())throw new Error("bad point: not in prime-order subgroup");return!0});function _(T,f,g,w,S){return g=new b(n.mul(g.X,T),g.Y,g.Z),f=Ae(w,f),g=Ae(S,g),f.add(g)}class b{static BASE=new b(o.Gx,o.Gy,n.ONE);static ZERO=new b(n.ZERO,n.ONE,n.ZERO);static Fp=n;static Fn=s;X;Y;Z;constructor(f,g,w){this.X=re("x",f),this.Y=re("y",g,!0),this.Z=re("z",w),Object.freeze(this)}static CURVE(){return o}static fromAffine(f){let{x:g,y:w}=f||{};if(!f||!n.isValid(g)||!n.isValid(w))throw new Error("invalid affine point");if(f instanceof b)throw new Error("projective point not allowed");return n.is0(g)&&n.is0(w)?b.ZERO:new b(g,w,n.ONE)}static fromBytes(f){let g=b.fromAffine(v(D(f,void 0,"point")));return g.assertValidity(),g}static fromHex(f){return b.fromBytes(Q(f))}get x(){return this.toAffine().x}get y(){return this.toAffine().y}precompute(f=8,g=!0){return H.createCache(this,f),g||this.multiply(je),this}assertValidity(){E(this)}hasEvenY(){let{y:f}=this.toAffine();if(!n.isOdd)throw new Error("Field doesn\'t support isOdd");return!n.isOdd(f)}equals(f){ae(f);let{X:g,Y:w,Z:S}=this,{X:A,Y:m,Z:x}=f,y=n.eql(n.mul(g,x),n.mul(A,S)),R=n.eql(n.mul(w,x),n.mul(m,S));return y&&R}negate(){return new b(this.X,n.neg(this.Y),this.Z)}double(){let{a:f,b:g}=o,w=n.mul(g,je),{X:S,Y:A,Z:m}=this,x=n.ZERO,y=n.ZERO,R=n.ZERO,B=n.mul(S,S),z=n.mul(A,A),M=n.mul(m,m),$=n.mul(S,A);return $=n.add($,$),R=n.mul(S,m),R=n.add(R,R),x=n.mul(f,R),y=n.mul(w,M),y=n.add(x,y),x=n.sub(z,y),y=n.add(z,y),y=n.mul(x,y),x=n.mul($,x),R=n.mul(w,R),M=n.mul(f,M),$=n.sub(B,M),$=n.mul(f,$),$=n.add($,R),R=n.add(B,B),B=n.add(R,B),B=n.add(B,M),B=n.mul(B,$),y=n.add(y,B),M=n.mul(A,m),M=n.add(M,M),B=n.mul(M,$),x=n.sub(x,B),R=n.mul(M,z),R=n.add(R,R),R=n.add(R,R),new b(x,y,R)}add(f){ae(f);let{X:g,Y:w,Z:S}=this,{X:A,Y:m,Z:x}=f,y=n.ZERO,R=n.ZERO,B=n.ZERO,z=o.a,M=n.mul(o.b,je),$=n.mul(g,A),V=n.mul(w,m),Z=n.mul(S,x),he=n.add(g,w),q=n.add(A,m);he=n.mul(he,q),q=n.add($,V),he=n.sub(he,q),q=n.add(g,S);let F=n.add(A,x);return q=n.mul(q,F),F=n.add($,Z),q=n.sub(q,F),F=n.add(w,S),y=n.add(m,x),F=n.mul(F,y),y=n.add(V,Z),F=n.sub(F,y),B=n.mul(z,q),y=n.mul(M,Z),B=n.add(y,B),y=n.sub(V,B),B=n.add(V,B),R=n.mul(y,B),V=n.add($,$),V=n.add(V,$),Z=n.mul(z,Z),q=n.mul(M,q),V=n.add(V,Z),Z=n.sub($,Z),Z=n.mul(z,Z),q=n.add(q,Z),$=n.mul(V,q),R=n.add(R,$),$=n.mul(F,q),y=n.mul(he,y),y=n.sub(y,$),$=n.mul(he,V),B=n.mul(F,B),B=n.add(B,$),new b(y,R,B)}subtract(f){return this.add(f.negate())}is0(){return this.equals(b.ZERO)}multiply(f){let{endo:g}=t;if(!s.isValidNot0(f))throw new Error("invalid scalar: out of range");let w,S,A=m=>H.cached(this,m,x=>Tt(b,x));if(g){let{k1neg:m,k1:x,k2neg:y,k2:R}=ce(f),{p:B,f:z}=A(x),{p:M,f:$}=A(R);S=z.add($),w=_(g.beta,B,M,m,y)}else{let{p:m,f:x}=A(f);w=m,S=x}return Tt(b,[w,S])[0]}multiplyUnsafe(f){let{endo:g}=t,w=this;if(!s.isValid(f))throw new Error("invalid scalar: out of range");if(f===Be||w.is0())return b.ZERO;if(f===ze)return w;if(H.hasCache(this))return this.multiply(f);if(g){let{k1neg:S,k1:A,k2neg:m,k2:x}=ce(f),{p1:y,p2:R}=Rn(b,w,A,x);return _(g.beta,y,R,S,m)}else return H.unsafe(w,f)}toAffine(f){return pe(this,f)}isTorsionFree(){let{isTorsionFree:f}=t;return a===ze?!0:f?f(b,this):H.unsafe(this,i).is0()}clearCofactor(){let{clearCofactor:f}=t;return a===ze?this:f?f(b,this):this.multiplyUnsafe(a)}isSmallOrder(){return this.multiplyUnsafe(a).is0()}toBytes(f=!0){return mt(f,"isCompressed"),this.assertValidity(),h(b,this,f)}toHex(f=!0){return X(this.toBytes(f))}toString(){return`<Point ${this.is0()?"ZERO":this.toHex()}>`}}let C=s.BITS,H=new Ge(b,t.endo?Math.ceil(C/2):C);return b.BASE.precompute(8),b}function Zr(e){return Uint8Array.of(e?2:3)}function Yr(e,t){return{secretKey:t.BYTES,publicKey:1+e.BYTES,publicKeyUncompressed:1+2*e.BYTES,publicKeyHasPrefix:!0,signature:2*t.BYTES}}var Ze={p:BigInt("0xfffffffffffffffffffffffffffffffffffffffffffffffffffffffefffffc2f"),n:BigInt("0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141"),h:BigInt(1),a:BigInt(0),b:BigInt(7),Gx:BigInt("0x79be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798"),Gy:BigInt("0x483ada7726a3c4655da4fbfc0e1108a8fd17b448a68554199c47d08ffb10d4b8")},Xr={beta:BigInt("0x7ae96a2b657c07106e64479eac3434e99cf0497512f58995c1396c28719501ee"),basises:[[BigInt("0x3086d221a7d46bcde86c90e49284eb15"),-BigInt("0xe4437ed6010e88286f547fa90abfe4c3")],[BigInt("0x114ca50f7a8e2f3f657c1108d9d44cfd8"),BigInt("0x3086d221a7d46bcde86c90e49284eb15")]]},Wr=BigInt(0),Bt=BigInt(2);function Jr(e){let t=Ze.p,r=BigInt(3),n=BigInt(6),s=BigInt(11),o=BigInt(22),a=BigInt(23),i=BigInt(44),c=BigInt(88),d=e*e*e%t,l=d*d*e%t,u=j(l,r,t)*l%t,p=j(u,r,t)*l%t,h=j(p,Bt,t)*d%t,v=j(h,s,t)*h%t,I=j(v,o,t)*v%t,k=j(I,i,t)*I%t,L=j(k,c,t)*k%t,N=j(L,i,t)*I%t,re=j(N,r,t)*l%t,ae=j(re,a,t)*v%t,ce=j(ae,n,t)*d%t,pe=j(ce,Bt,t);if(!Ke.eql(Ke.sqr(pe),e))throw new Error("Cannot find square root");return pe}var Ke=ye(Ze.p,{sqrt:Jr}),xe=An(Ze,{Fp:Ke,endo:Xr});var Bn={};function Ve(e,...t){let r=Bn[e];if(r===void 0){let n=de(an(e));r=se(n,n),Bn[e]=r}return de(se(r,...t))}var $t=e=>e.toBytes(!0).slice(1),Ot=e=>e%Bt===Wr;function It(e){let{Fn:t,BASE:r}=xe,n=t.fromBytes(e),s=r.multiply(n);return{scalar:Ot(s.y)?n:t.neg(n),bytes:$t(s)}}function $n(e){let t=Ke;if(!t.isValidNot0(e))throw new Error("invalid x: Fail if x \\u2265 p");let r=t.create(e*e),n=t.create(r*e+BigInt(7)),s=t.sqrt(n);Ot(s)||(s=t.neg(s));let o=xe.fromAffine({x:e,y:s});return o.assertValidity(),o}var Ie=me;function On(...e){return xe.Fn.create(Ie(Ve("BIP0340/challenge",...e)))}function In(e){return It(e).bytes}function Fr(e,t,r=Te(32)){let{Fn:n}=xe,s=D(e,void 0,"message"),{bytes:o,scalar:a}=It(t),i=D(r,32,"auxRand"),c=n.toBytes(a^Ie(Ve("BIP0340/aux",i))),d=Ve("BIP0340/nonce",c,o,s),{bytes:l,scalar:u}=It(d),p=On(l,o,s),h=new Uint8Array(64);if(h.set(l,0),h.set(n.toBytes(n.create(u+p*a)),32),!Nn(h,s,o))throw new Error("sign: Invalid signature produced");return h}function Nn(e,t,r){let{Fp:n,Fn:s,BASE:o}=xe,a=D(e,64,"signature"),i=D(t,void 0,"message"),c=D(r,32,"publicKey");try{let d=$n(Ie(c)),l=Ie(a.subarray(0,32));if(!n.isValidNot0(l))return!1;let u=Ie(a.subarray(32,64));if(!s.isValidNot0(u))return!1;let p=On(s.toBytes(l),$t(d),i),h=o.multiplyUnsafe(u).add(d.multiplyUnsafe(s.neg(p))),{x:v,y:I}=h.toAffine();return!(h.is0()||!Ot(I)||v!==l)}catch{return!1}}var ie=(()=>{let r=(n=Te(48))=>xn(n,Ze.n);return{keygen:At(r,In),getPublicKey:In,sign:Fr,verify:Nn,Point:xe,utils:{randomSecretKey:r,taggedHash:Ve,lift_x:$n,pointToBytes:$t},lengths:{secretKey:32,publicKey:32,publicKeyHasPrefix:!1,signature:64,seed:48}}})();var Po=new TextDecoder("utf-8"),Qr=new TextEncoder;function es(e){if(e.length!==64)return!1;for(let t=0;t<64;t++){let r=e.charCodeAt(t);if(isNaN(r)||r<48||r>102||r>57&&r<97)return!1}return!0}var we=Symbol("verified"),ts=e=>e instanceof Object;function ns(e){if(!ts(e)||typeof e.kind!="number"||typeof e.content!="string"||typeof e.created_at!="number"||typeof e.pubkey!="string"||!es(e.pubkey)||!Array.isArray(e.tags))return!1;for(let t=0;t<e.tags.length;t++){let r=e.tags[t];if(!Array.isArray(r))return!1;for(let n=0;n<r.length;n++)if(typeof r[n]!="string")return!1}return!0}var rs=class{generateSecretKey(){return ie.utils.randomSecretKey()}getPublicKey(e){return X(ie.getPublicKey(e))}finalizeEvent(e,t){let r=e;return r.pubkey=X(ie.getPublicKey(t)),r.id=Nt(r),r.sig=X(ie.sign(Q(Nt(r)),t)),r[we]=!0,r}verifyEvent(e){if(typeof e[we]=="boolean")return e[we];try{let t=Nt(e);if(t!==e.id)return e[we]=!1,!1;let r=ie.verify(Q(e.sig),Q(t),Q(e.pubkey));return e[we]=r,r}catch{return e[we]=!1,!1}}};function ss(e){if(!ns(e))throw new Error("can\'t serialize event with wrong or missing properties");return JSON.stringify([0,e.pubkey,e.created_at,e.kind,e.tags,e.content])}function Nt(e){let t=de(Qr.encode(ss(e)));return X(t)}var Ye=new rs,Dn=Ye.generateSecretKey,Dt=Ye.getPublicKey,Cn=Ye.finalizeEvent,Ln=Ye.verifyEvent;var $e=class{constructor(t){this.onEvent=t}buffer="";data=[];event="";id;push(t){this.buffer+=t;let r=this.buffer.search(/\\r\\n|\\r|\\n/);for(;r!==-1;){let n=this.buffer.slice(0,r),s=this.buffer.startsWith(`\\r\n`,r)?2:1;this.buffer=this.buffer.slice(r+s),this.line(n),r=this.buffer.search(/\\r\\n|\\r|\\n/)}}end(){this.buffer&&this.line(this.buffer),this.buffer="",this.line("")}line(t){if(t===""){this.data.length&&this.onEvent({event:this.event||"message",data:this.data.join(`\n`),...this.id!==void 0&&{id:this.id}}),this.data=[],this.event="";return}if(t.startsWith(":"))return;let r=t.indexOf(":"),n=r===-1?t:t.slice(0,r),s=r===-1?"":t.slice(r+1);s.startsWith(" ")&&(s=s.slice(1)),n==="data"?this.data.push(s):n==="event"?this.event=s:n==="id"&&(this.id=s)}};function Mn(e){let t=[],r=new $e(n=>t.push(n));return r.push(e),r.end(),t}var os="databricks-buzz-plugins/0.1.0",Ct=class extends Error{constructor(r,n,s,o){super(s);this.status=r;this.errorCode=n;this.body=o;this.name="DatabricksApiError"}get isPermission(){return this.status===403||this.errorCode==="PERMISSION_DENIED"}get isNotFound(){return this.status===404||this.errorCode==="RESOURCE_DOES_NOT_EXIST"||this.errorCode==="NOT_FOUND"}get isFeatureDisabled(){return this.errorCode==="FEATURE_DISABLED"||this.errorCode==="NOT_IMPLEMENTED"||/not enabled|feature.*disabled|preview/i.test(this.message)}};function Xe(e){let t,r=`Databricks returned HTTP ${e.status}`;try{let n=JSON.parse(e.body);t=n.error_code??(typeof n.error=="object"?n.error?.code:void 0),r=n.message??(typeof n.error=="object"?n.error?.message:n.error)??n.error_description??r}catch{let n=e.body.trim();n&&n.length<400&&!n.startsWith("<")&&(r=n)}return new Ct(e.status,t,r,e.body)}var is=new Set(["GET","HEAD","PUT","DELETE"]),as=(e,t)=>new Promise((r,n)=>{let s=setTimeout(r,e);t?.addEventListener("abort",()=>{clearTimeout(s),n(t.reason)},{once:!0})}),We=class{constructor(t){this.options=t;this.host=t.host.replace(/\\/+$/,""),this.workspaceId=t.workspaceId}host;workspaceId;url(t,r){let n=new URL(/^https:\\/\\//.test(t)?t:`${this.host}${t.startsWith("/")?"":"/"}${t}`);for(let[s,o]of Object.entries(r??{}))o!==void 0&&n.searchParams.set(s,String(o));return n.toString()}async request(t,r={},n){let s=r.method??(r.body===void 0?"GET":"POST"),o=r.body===void 0?void 0:typeof r.body=="string"?r.body:JSON.stringify(r.body),a=async c=>{let d=await this.options.token({force:c});return this.options.transport({url:this.url(t,r.query),method:s,headers:{Authorization:`Bearer ${d}`,"User-Agent":this.options.userAgent??os,Accept:"application/json",...o!==void 0&&{"Content-Type":"application/json"},...this.workspaceId&&{"X-Databricks-Workspace-Id":this.workspaceId},...r.headers},...o!==void 0&&{body:o},...r.timeoutMs!==void 0&&{timeoutMs:r.timeoutMs},...r.signal&&{signal:r.signal},...n&&{onBody:n}})},i=await a(!1);i.status===401&&(i=await a(!0));for(let c=0;c<3&&(i.status===429||i.status===503)&&is.has(s)&&!n;c++){let d=Number(i.headers["retry-after"]);await as(Number.isFinite(d)&&d>0?Math.min(d*1e3,2e4):500*2**c+Math.random()*250,r.signal),i=await a(!1)}return i}async json(t,r={}){let n=await this.request(t,r);if(n.status<200||n.status>=300)throw Xe(n);return n.body.trim()?JSON.parse(n.body):{}}get(t,r={}){return this.json(t,{...r,method:"GET"})}post(t,r,n={}){return this.json(t,{...n,method:"POST",body:r??{}})}async stream(t,r,n){let s=new $e(n),o=!0,a=await this.request(t,{...r,headers:{Accept:"text/event-stream",...r.headers}},i=>{o&&s.push(i)});if(a.status<200||a.status>=300)throw o=!1,Xe(a);return s.end(),a}};var Pn="2025-06-18",Je=class extends Error{constructor(r,n,s){super(r);this.code=n;this.data=s;this.name="McpError"}},qn=e=>`/ai-gateway/mcp-services/${e}`,Fe=class{constructor(t,r,n={}){this.client=t;this.path=r;this.query=n}session;initializing;nextId=1;toolsCache;serverInfo;instructions;async listTools(t){if(this.toolsCache&&Date.now()-this.toolsCache.at<5*6e4)return this.toolsCache.tools;let r=[],n;do{let s=await this.call("tools/list",n?{cursor:n}:{},t);r.push(...s.tools??[]),n=s.nextCursor}while(n);return this.toolsCache={at:Date.now(),tools:r},r}callTool(t,r,n={}){return this.call("tools/call",{name:t,arguments:r,...n.meta&&{_meta:n.meta}},n.signal,n.timeoutMs)}async readResource(t,r){return await this.call("resources/read",{uri:t},r)}async ensureSession(t){this.session||(this.initializing??=(async()=>{let r=await this.send({jsonrpc:"2.0",id:this.nextId++,method:"initialize",params:{protocolVersion:Pn,capabilities:{},clientInfo:{name:"databricks-buzz-plugins",version:"0.1.0"}}},t,!0);this.serverInfo=r?.serverInfo,this.instructions=r?.instructions,await this.send({jsonrpc:"2.0",method:"notifications/initialized"},t).catch(()=>{})})().finally(()=>{this.initializing=void 0}),await this.initializing)}async call(t,r,n,s){await this.ensureSession(n);try{return await this.send({jsonrpc:"2.0",id:this.nextId++,method:t,params:r},n,!1,s)}catch(o){if(o.status===404&&this.session)return this.session=void 0,await this.ensureSession(n),this.send({jsonrpc:"2.0",id:this.nextId++,method:t,params:r},n,!1,s);throw o}}async send(t,r,n=!1,s=12e4){let o=await this.client.request(this.path,{method:"POST",query:this.query,body:t,timeoutMs:s,...r&&{signal:r},headers:{Accept:"application/json, text/event-stream",...!n&&{"MCP-Protocol-Version":Pn},...this.session&&{"Mcp-Session-Id":this.session}}}),a=o.headers["mcp-session-id"];if(a&&(this.session=a),t.id===void 0||o.status===202)return;if(o.status<200||o.status>=300)throw Xe(o);let c=(o.headers["content-type"]??"").includes("text/event-stream")?Mn(o.body).map(d=>d.data):[o.body];for(let d of c){let l;try{l=JSON.parse(d)}catch{continue}if(l.id===t.id){if(l.error)throw new Je(l.error.message??"MCP error",l.error.code,l.error.data);return l.result}}throw new Je(`No response to ${t.method}`)}};function Oe(e){return(e.content??[]).map(t=>t.type==="text"?String(t.text):"").filter(Boolean).join(`\n\n`)}function Qe(e){if(e.structuredContent!==void 0)return e.structuredContent;for(let t of e.content??[]){if(t.type!=="text")continue;let r=String(t.text).trim();if(!(!r.startsWith("{")&&!r.startsWith("[")))try{return JSON.parse(r)}catch{}}}var cs="system.ai.genie_one_mcp",ds=3e3,ls=3,us=e=>e==null?null:typeof e=="object"?JSON.stringify(e):String(e);function fs(e){if(!e.ready||!e.columns?.length)return;let t=(e.rows??[]).map(n=>n.map(us)),r=e.total_row_count??void 0;return Le(e.columns.map(n=>({name:n.name,...n.type_text&&{type:n.type_text}})),t,{...r!==void 0&&{totalRows:r},truncated:!!e.truncated||r!==void 0&&r>t.length})}var ps=e=>e.replace(/<!--[\\s\\S]*?--\\s*>/g,"").replace(/\\n{3,}/g,`\n\n`).trim();function Gn(e){return ps(e).replace(/\\s*:citation\\[[^\\]]*\\]/g,"").replace(/\\s*\\[Query Result\\]\\([^)\\s]*#embed-[^)\\s]*\\)/g,"").replace(/\\s*\\[Knowledge snippets?\\]\\([^)]*\\)/gi,"").replace(/([.!?)])[ \\t]+Knowledge snippets?(?=[ \\t]*(\\n|$))/gi,"$1").replace(/`([^`]+)`\\s*\\[\\1\\]\\(/g,"[$1](").replace(/[ \\t]+$/gm,"").trim()}function hs(e){let t=String.raw`(?:charts?|graphs?|plots?|visuali[sz]ations?)`,r=n=>/^[ \\t]*/.exec(n)?.[0]??"";return e.replace(new RegExp(String.raw`[^.!?\\n]*\\b(?:can(?:\'|\u2019)?t|cannot|can not|unable to|not able to)\\b[^.!?\\n]*\\b${t}\\b[^.!?\\n]*[.!?][ \\t]*`,"gi"),r).replace(new RegExp(String.raw`[^.!?\\n]*\\b(?:to (?:turn|make|build|create) (?:this|it|these|the results?) into an? ${t}|you can (?:chart|plot|graph) (?:this|it|them|directly))\\b[^.!?\\n]*[.!?][ \\t]*`,"gi"),r).replace(/[ \\t]+$/gm,"").replace(/\\n{3,}/g,`\n\n`).trim()}var Un=e=>e.trim().replace(/^\\|/,"").replace(/\\|$/,"").split("|").map(t=>t.replace(/\\*\\*|__|`/g,"").trim()),Hn=e=>e.toLowerCase().replace(/[^a-z0-9]/g,"");function jn(e,t=200){let r=Gn(e.text).split(`\n`),n=[...e.results],s=(d,l)=>{let u=d.map(Hn).join("|"),p=n.findIndex(h=>h.columns.map(v=>Hn(v.name)).join("|")===u);return p<0&&(p=n.findIndex(h=>h.columns.length===d.length&&h.rows.length===l)),p<0?void 0:n.splice(p,1)[0]},o=[],a=0,i=/^\\s*\\|.*\\|\\s*$/;for(let d=0;d<r.length;d++){if(i.test(r[d]??"")&&/^\\s*\\|?\\s*:?-{2,}/.test(r[d+1]??"")){let l=Un(r[d]??""),u=[];for(d+=2;d<r.length&&i.test(r[d]??"");d++)u.push(Un(r[d]??"").map(h=>h||null));d--;let p=s(l,u.length)??Le(l.map(h=>({name:h})),u);o.push("",ve(p,t),""),a++;continue}o.push(r[d]??"")}let c=o.join(`\n`).replace(/\\n{3,}/g,`\n\n`).trim();if(!a){let d=e.results[e.results.length-1];d?.columns.length&&(d.rows.length>1||!c)&&(c=[c,ve(d,t)].filter(Boolean).join(`\n\n`),a++)}return a?hs(c):c}var gs=(e,t)=>new Promise((r,n)=>{let s=setTimeout(r,e);t?.addEventListener("abort",()=>{clearTimeout(s),n(t.reason)},{once:!0})}),et=class{constructor(t){this.service=t}clients=new Map;availability=new Map;async mcp(){let t=await this.service.ready(),r=this.service.snapshot(),n=r.status==="connected"?r.workspaceId??r.profile.workspaceId:void 0,s=`${t.host}|${n??""}`,o=this.clients.get(s);return o||(o=new Fe(t,qn(cs),n?{o:n}:{}),this.clients.set(s,o)),o}available(){let t=this.service.snapshot(),r=t.status==="connected"?t.profile.host:"none",n=this.availability.get(r);return n||(n=this.mcp().then(s=>s.listTools()).then(s=>s.some(o=>o.name==="genie_ask")).catch(()=>!1).then(s=>(s||this.availability.delete(r),s)),this.availability.set(r,n)),n}async ask(t,r={}){let{signal:n}=r,s=await this.mcp(),o=await s.callTool("genie_ask",{question:t,...r.conversationId&&{conversation_id:r.conversationId}},{...n&&{signal:n},timeoutMs:17e4});if(o.isError)throw new Error(Oe(o)||"Genie One couldn\'t take the question.");let a=Qe(o)??{},i=a.conversation_id??r.conversationId??"",c=a.response_id??"";if(!i||!c)throw new Error("Genie One didn\'t return a conversation.");let d=a,l=Oe(o),u=0,p=[],h=Date.now()+10*6e4;try{for(;!d.status||d.status==="in_progress"||d.status==="unknown"&&u<5;){if(Date.now()>h)throw new Error("Genie One didn\'t finish within 10 minutes.");await gs(ds,n);let k=await s.callTool("genie_poll_response",{conversation_id:i,response_id:c},{...n&&{signal:n},timeoutMs:6e4});if(k.isError)throw new Error(Oe(k)||"Genie One failed.");d=Qe(k)??{status:"unknown"},l=Oe(k),u=d.status==="unknown"?u+1:0,d.progress_steps?.length&&(p=d.progress_steps,r.onProgress?.(p))}}catch(k){throw n?.aborted&&s.callTool("genie_cancel_response",{conversation_id:i}).catch(()=>{}),k}if(d.status==="failed")throw new Error(l.trim()||"Genie One couldn\'t answer that.");let v=(d.query_items??[]).slice(0,ls),I=(await Promise.all(v.map(k=>s.callTool("genie_get_query_result",{conversation_id:i,response_id:c,item_id:k.item_id},{...n&&{signal:n},timeoutMs:6e4}).then(L=>L.isError?void 0:fs(Qe(L)??{})).catch(()=>{})))).filter(k=>k!==void 0);return{conversationId:i,responseId:c,status:d.status??"completed",text:(d.final_answer??"").trim(),markdown:l.trim(),steps:p,results:I,sql:v.flatMap(k=>k.sql?[k.sql]:[]),...d.deep_link&&{deepLink:d.deep_link}}}format(t){let r=["Genie One",`conversation_id: ${t.conversationId}`];t.status==="incomplete"&&r.push("(Genie One stopped before finishing; the answer may be partial.)");let n=Gn(t.text);if(n)r.push("",n);else for(let s of t.results)r.push("",Wt(s,20));for(let s of t.sql.slice(0,2))r.push("","SQL Genie One ran:","```sql",s.trim(),"```");return t.deepLink&&r.push("",`[Explore in Databricks](${t.deepLink})`),r.join(`\n`)}};var tt="/home/sandbox-agent";var Kn=[{id:"builtin",label:"Built-in",detail:"Fastest. Uses Buzz\'s tools and the tools you pick, and runs code in the Sandbox when it needs to."},{id:"claude",label:"Claude Code",detail:"Anthropic\'s coding agent, running in the Sandbox with its own tools and the Databricks CLI signed in as you. Keeps its context between turns."},{id:"codex",label:"Codex",detail:"OpenAI\'s coding agent, running in the Sandbox with its own tools and the Databricks CLI signed in as you. Keeps its context between turns."},{id:"pi",label:"Pi",detail:"A small coding agent for Claude, GPT and Gemini models, running in the Sandbox with its own tools. Keeps its context between turns."}],ei=Kn.map(e=>e.id);var fe=e=>Kn.find(t=>t.id===e)?.label??e;var Vn=["To show a query result or other table, put it in a fenced code block with the language",`\\`${dt}\\` whose body is CSV with a header row (up to 200 rows; quote values that contain commas).`,"Buzz draws it as an interactive chart with a table view, so you can chart data; don\'t say you can\'t.","Put the label column (such as a date or category) first and the numeric columns after it, unformatted (no $ or thousands separators)."].join(" "),ti=`${tt}/.buzz/runs`,nt=`${tt}/work`,Zn=e=>({dir:e,prompt:`${e}/prompt.md`,system:`${e}/system.md`,events:`${e}/events.jsonl`,stderr:`${e}/stderr.log`,exit:`${e}/exit`,pid:`${e}/pid`,script:`${e}/run.sh`}),K=e=>`\'${e.replace(/\'/g,"\'\\\\\'\'")}\'`,ms="read,grep,find,ls,edit,write";function Yn(e){let{model:t,files:r,session:n}=e,s=e.permissions==="full";switch(e.harness){case"claude":{if(!n)throw new Error("Claude Code needs a session ID.");return["claude","-p","--model",K(t),"--output-format","stream-json","--verbose","--permission-mode",s?"bypassPermissions":"auto","--append-system-prompt-file",K(r.system),n.resume?"--resume":"--session-id",K(n.id),"<",K(r.prompt)].join(" ")}case"codex":return["codex","exec",...n?["resume",K(n.id)]:[],"--json","--skip-git-repo-check","-m",K(t),...s?["--dangerously-bypass-approvals-and-sandbox"]:["-c",K(\'sandbox_mode="workspace-write"\'),"-c","sandbox_workspace_write.network_access=true"],"-","<",K(r.prompt)].join(" ");case"pi":if(!n)throw new Error("Pi needs a session ID.");return["pi","-p","--mode","json","--model",K(t),"--session-id",K(n.id),"--append-system-prompt",K(r.system),...s?[]:["--tools",ms],K(`@${r.prompt}`),"<","/dev/null"].join(" ")}}var ys=["command","cmd","file_path","path","pattern","query","url","description","prompt"];function Ne(e){if(!(!e||typeof e!="object"))for(let t of ys){let r=e[t];if(typeof r=="string"&&r.trim())return r.length>80?`${r.slice(0,77)}\\u2026`:r}}var bs=e=>e.replace(/^\\/bin\\/(ba)?sh -lc \'?/,"").replace(/\'$/,""),zn=e=>Array.isArray(e)?e.filter(t=>!!t&&typeof t=="object"&&t.type==="text"&&typeof t.text=="string").map(t=>t.text).join(""):typeof e=="string"?e:"";function Xn(e,t){let r;try{r=JSON.parse(t)}catch{return}if(!(!r||typeof r!="object")){if(e==="claude"){if(r.type==="system"&&r.subtype==="init"&&typeof r.session_id=="string")return{session:r.session_id};if(r.type==="system"&&r.subtype==="api_retry")return{step:{tool:"model",target:`retrying after ${r.error_status??"an error"}${r.error?` (${r.error})`:""}`}};if(r.type==="assistant"&&Array.isArray(r.message?.content)){let n=r.message.content.find(o=>o?.type==="tool_use");if(n)return{step:{tool:String(n.name??"tool"),...Ne(n.input)&&{target:Ne(n.input)}}};let s=zn(r.message.content);return s?{text:s}:void 0}if(r.type==="result"){let n=typeof r.result=="string"?r.result:"";return r.is_error||r.subtype&&r.subtype!=="success"?{error:n||String(r.subtype??"Claude Code failed")}:{final:n}}return}if(e==="codex"){if(r.type==="thread.started"&&typeof r.thread_id=="string")return{session:r.thread_id};if(r.type==="turn.failed")return{error:String(r.error?.message??"Codex failed")};let n=r.item;return!n||typeof n!="object"?void 0:r.type==="item.started"?n.type==="command_execution"&&typeof n.command=="string"?{step:{tool:"shell",target:Ne({command:bs(n.command)})}}:n.type==="file_change"?{step:{tool:"edit",...n.changes?.[0]?.path&&{target:String(n.changes[0].path)}}}:n.type==="mcp_tool_call"?{step:{tool:String(n.tool??"tool"),...n.server&&{target:String(n.server)}}}:n.type==="web_search"?{step:{tool:"web search",...n.query&&{target:String(n.query)}}}:void 0:r.type==="item.completed"&&n.type==="agent_message"&&typeof n.text=="string"?{text:n.text}:void 0}if(r.type==="session"&&typeof r.id=="string")return{session:r.id};if(r.type==="tool_execution_start")return{step:{tool:String(r.toolName??"tool"),...Ne(r.args)&&{target:Ne(r.args)}}};if(r.type==="message_end"&&r.message?.role==="assistant"){if(r.message.stopReason==="error"&&r.message.errorMessage)return{error:String(r.message.errorMessage)};let n=zn(r.message.content);return n?{text:n}:void 0}}}var xs=e=>e.replace(/\\x1b\\[[0-9;]*[A-Za-z]/g,"").replace(/[\u2502\u256D\u256E\u2570\u256F\u2500\u2714\u2022]/g,"").trim();function Lt(e){return xs(e).split(`\n`).map(t=>t.trim()).filter(t=>t&&!/Unity Gateway|Databricks auth already|Launching |Starting |managed coding agent config|token refresh is managed|^is running\\.?$/i.test(t)).slice(-4).join(" ").slice(0,600)}function Wn(e,t){return["<databricks-sandbox>",`You are running as ${fe(e)} inside your own Databricks Sandbox, a Linux machine in Databricks with Python, Node.js, git, the Databricks CLI (already signed in as your owner) and internet access. Your working folder is ${nt}; files under ${tt} persist across restarts.`,"Your final message is posted to the Buzz conversation as your reply, so make it the answer itself, written for the people there. You don\'t have Buzz\'s own tools in this session.",e==="pi"&&t==="standard"?"You can read, search and edit files, but you have no shell in this session.":"","Never print secrets into the conversation.","</databricks-sandbox>"].filter(Boolean).join(`\n`)}var Ee=[9,40002],ws="buzz.solo",Es=48e3,Qn=/^[0-9a-f]{64}$/,Ss=/^[0-9a-f]{128}$/,vs=/^(kind=|created_at<|created_at>)(0|[1-9][0-9]*)$/,_s=(e,t)=>e.tags.find(r=>r[0]===t)?.[1],Rs=e=>{let t=_s(e,"h");return t&&/^[a-zA-Z0-9_-]{1,128}$/.test(t)?t:void 0};function ks(e){let t,r;for(let n of e.tags)n[0]!=="e"||!Qn.test(n[1]??"")||(n[3]==="root"?t=n[1]:n[3]==="reply"&&(r=n[1]));return t??r}var er=(e,t)=>Ee.includes(e.kind)&&e.pubkey!==t&&e.tags.some(r=>r[0]==="p"&&r[1]===t);function Ts(e){let t=e.tags.filter(i=>i[0]==="auth");if(t.length!==1)return;let[,r="",n="",s=""]=t[0];if(t[0].length!==4||!Qn.test(r)||!Ss.test(s)||r===e.pubkey)return;let o=n?n.split("&"):[];if(!o.every(i=>vs.test(i)))return;for(let i of o){let c=Number(i.replace(/^[^0-9]+/,""));if(i.startsWith("kind=")&&e.kind!==c||i.startsWith("created_at<")&&!(e.created_at<c)||i.startsWith("created_at>")&&!(e.created_at>c))return}let a=de(new TextEncoder().encode(`nostr:agent-auth:${e.pubkey}:${n}`));try{return ie.verify(Buffer.from(s,"hex"),a,Buffer.from(r,"hex"))?r:void 0}catch{return}}var tr=(e,t)=>e.pubkey===t||Ts(e)===t;function nr(e){if(!e)return{solo:!1};let[t,...r]=e.tags.flatMap(n=>n[0]==="t"&&typeof n[1]=="string"?[n[1]]:[]);return{...t&&{type:t},solo:t==="stream"&&r.includes(ws)}}function rr(e,t,r){let n=Rs(e);if(!n)return;let s=ks(e),o=s??e.id,a=r.type==="dm",i=r.solo,c=i||a||t==="channel";return{key:c?n:`${n}/${o}`,channel:n,root:o,topLevel:i,dm:a,fresh:!s&&!c}}function sr(e){return e.fresh?[]:!e.topLevel&&!e.dm&&e.key!==e.channel?[{ids:[e.root],"#h":[e.channel],limit:1},{kinds:Ee,"#h":[e.channel],"#e":[e.root],limit:200}]:[{kinds:Ee,"#h":[e.channel],limit:13}]}var Jn=e=>JSON.stringify(e).replace(/</g,"\\\\u003c").replace(/>/g,"\\\\u003e").replace(/&/g,"\\\\u0026"),Fn=(e,t)=>({id:e.id,pubkey:e.pubkey,...t.get(e.pubkey)&&{author:t.get(e.pubkey)},time:new Date(e.created_at*1e3).toISOString(),content:e.content});function or(e){let{event:t,conversation:r,names:n}=e,s=r.dm?"dm":r.key===r.channel?"channel":"thread",o=[`Scope: ${s}`,`Session scope: ${e.scope==="channel"||r.key===r.channel?"channel":"thread"} conversation`,`Channel: #${r.channel}`,...s==="thread"?[`Thread root: ${r.root}`]:[],`Agent: ${e.agent}`,"Your final message is posted as your reply in this conversation."].join(`\n`),a=s==="thread"?"thread-context":"conversation-context",i=[`<context>\n${o}\n</context>`];e.context.length&&i.push(`<${a} included="${e.context.length}" total="${e.total}" truncated="${e.total>e.context.length}">\n${Jn(e.context.map(d=>Fn(d,n)))}\n</${a}>`);let c=t.tags.filter(d=>d[0]==="p").map(d=>d[1]);return i.push(`<buzz-event type="@mention">\n${Jn({...Fn(t,n),channel:r.channel,kind:t.kind,...r.root!==t.id&&{thread:r.root},...c.length&&{mentions:c}})}\n</buzz-event>`),i.join(`\n\n`)}var Mt=e=>e.replace(/\\[([^\\]]*)\\]\\(nostr:[^)]+\\)/g,"").replace(/nostr:(npub|nprofile|note|nevent)1[0-9a-z]+/g,"").replace(/^\\s*@\\S+\\s*/,"").replace(/[ \\t]+/g," ").trim();function ir(e,t=Es){let r=o=>Buffer.byteLength(o);if(r(e)<=t)return[e];let n=[],s=e;for(;r(s)>t;){let o=t;for(;r(s.slice(0,o))>t;)o=Math.floor(o*.9);let a=s.slice(0,o),i=Math.max(a.lastIndexOf(`\n\n`),a.lastIndexOf(`\n`)),c=i>o/2?i:o;n.push(s.slice(0,c).trimEnd()),s=s.slice(c).trimStart()}return s&&n.push(s),n}function ar(e){return{kind:9,created_at:Math.floor(Date.now()/1e3),content:e.content,tags:[["h",e.conversation.channel],...e.conversation.topLevel?[]:[["e",e.conversation.root,"","reply"]],...e.notify?[["p",e.notify]]:[],[...e.authTag]]}}function Pt(e){return{kind:0,created_at:Math.floor(Date.now()/1e3),content:JSON.stringify({name:e.name,display_name:e.name,bot:!0,...e.picture&&{picture:e.picture},...e.about&&{about:e.about}}),tags:[[...e.authTag]]}}import{readFileSync as As}from"node:fs";import{homedir as Bs}from"node:os";import{join as Is}from"node:path";function cr(){let e=As(Is(Bs(),".databrickscfg"),"utf8"),t="",r={};for(let n of e.split(`\n`)){let s=n.trim(),o=/^\\[(.+)\\]$/.exec(s);if(o){t=o[1];continue}let a=/^([a-z_]+)\\s*=\\s*(.*)$/.exec(s);a&&t==="DEFAULT"&&(r[a[1]]=a[2])}if(!r.host||!r.token)throw new Error("The Sandbox has no Databricks credential.");return{host:r.host.replace(/\\/+$/,""),token:r.token}}async function $s(e){let t=new AbortController,r=setTimeout(()=>t.abort(new DOMException("Timed out","TimeoutError")),e.timeoutMs??6e4),n=()=>t.abort(e.signal?.reason);e.signal?.addEventListener("abort",n,{once:!0});try{let s=await fetch(e.url,{method:e.method??"GET",...e.headers&&{headers:e.headers},...e.body!==void 0&&{body:e.body},signal:t.signal}),o={};s.headers.forEach((i,c)=>o[c.toLowerCase()]=i);let a="";if(s.body){let i=new TextDecoder,c=s.body.getReader();for(;;){let{done:l,value:u}=await c.read();if(l)break;let p=i.decode(u,{stream:!0});a+=p,e.onBody?.(p)}let d=i.decode();d&&(a+=d,e.onBody?.(d))}return{status:s.status,headers:o,body:a}}finally{clearTimeout(r),e.signal?.removeEventListener("abort",n)}}function dr(){let{host:e}=cr(),t=new We({host:e,transport:$s,token:async()=>cr().token}),r={status:"connected",profile:{name:"DEFAULT",host:e},user:{userName:""},profiles:[]};return{version:1,snapshot:()=>r,subscribe:()=>()=>{},client:()=>t,ready:async()=>t,workspaceUrl:s=>new URL(s,e).toString(),profiles:()=>[],openSettings:()=>{},signIn:async()=>{},preferences:{get:()=>{},set:()=>{},subscribe:()=>()=>{}}}}import{spawn as qs}from"node:child_process";import{mkdirSync as ur,rmSync as fr,writeFileSync as jt}from"node:fs";import{join as Us}from"node:path";import{createInterface as Hs}from"node:readline";import{chmodSync as Os,existsSync as Ns,mkdirSync as Ds,readFileSync as Cs,renameSync as Ls,rmSync as fi,writeFileSync as Ms}from"node:fs";import{homedir as Ps}from"node:os";import{join as J}from"node:path";var ee=process.env.BUZZ_AGENT_DIR??J(Ps(),".buzz","agent"),O={key:J(ee,"key.json"),config:J(ee,"config.json"),state:J(ee,"state.json"),turns:J(ee,"turns"),pid:J(ee,"runner.pid"),log:J(ee,"runner.log"),status:J(ee,"status.json"),awake:J(ee,"awake"),runs:J(ee,"runs")};function qt(){for(let e of[ee,O.turns,O.runs])Ds(e,{recursive:!0,mode:448})}function Ut(e,t){try{return JSON.parse(Cs(e,"utf8"))}catch{return t}}function rt(e,t,r=384){let n=`${e}.tmp`;Ms(n,`${JSON.stringify(t,null,2)}\n`,{mode:r}),Ls(n,e),Os(e,r)}var st=()=>Ut(O.config,void 0),Ht=()=>({sessions:{},since:0,handled:[],...Ut(O.state,{})}),Gt=e=>rt(O.state,{...e,handled:e.handled.slice(-500)});function ot(){let e=Ut(O.key,void 0);return e?.secret&&/^[0-9a-f]{64}$/.test(e.secret)?Uint8Array.from(Buffer.from(e.secret,"hex")):void 0}function lr(e){if(Ns(O.key))throw new Error("This Sandbox already has an agent key.");rt(O.key,{secret:Buffer.from(e).toString("hex")})}var De=e=>J(O.turns,Buffer.from(e).toString("base64url"));var Gs=e=>/no conversation found|no (saved )?session|session[^.]* not found|thread[^.]* not found|no rollout found/i.test(e);async function zt(e){try{return await pr(e)}catch(t){if(!e.session||e.signal.aborted||!Gs(t.message))throw t;let{session:r,...n}=e;return pr(n)}}function pr(e){let{harness:t}=e,r=crypto.randomUUID(),n=Us(O.runs,`${Date.now().toString(36)}-${r.slice(0,8)}`);ur(n,{recursive:!0,mode:448});let s=Zn(n),o=e.session?.id??(t==="codex"?void 0:crypto.randomUUID()),a=t==="codex"&&!e.session?`<instructions>\n${e.system}\n</instructions>\n\n${e.prompt}`:e.prompt;jt(s.prompt,a,{mode:384}),jt(s.system,e.system,{mode:384});let i=Yn({harness:t,model:e.model,permissions:e.permissions,session:o?{id:o,resume:!!e.session}:void 0,files:s});return ur(nt,{recursive:!0}),new Promise((c,d)=>{let l=qs("bash",["-lc",`cd \'${nt}\' && ${i}`],{detached:!0,stdio:["ignore","pipe","pipe"]});jt(e.pidFile,String(l.pid??""),{mode:384});let u="",p,h,v="",I=!1,k=()=>{if(l.pid){try{process.kill(-l.pid,"SIGTERM")}catch{}setTimeout(()=>{try{process.kill(-l.pid,"SIGKILL")}catch{}},3e3).unref()}};e.signal.addEventListener("abort",k,{once:!0}),Hs({input:l.stdout}).on("line",L=>{let N=Xn(t,L);N&&(N.session&&(!I||N.session!==o)&&(o=N.session,I=!0,e.onSession?.(o)),N.step&&e.onStep?.(N.step.tool,N.step.target),N.text&&(u=N.text),N.final!==void 0&&(p=N.final),N.error&&(h=N.error))}),l.stderr.on("data",L=>v=`${v}${L}`.slice(-8e3)),l.on("close",L=>{if(e.signal.removeEventListener("abort",k),fr(e.pidFile,{force:!0}),fr(n,{recursive:!0,force:!0}),e.signal.aborted)return d(e.signal.reason??new DOMException("Aborted","AbortError"));if(h)return d(new Error(`${fe(t)}: ${h}`));let N=(p??u).trim();if(L!==0||!N)return d(new Error(`${fe(t)} stopped (exit ${L})${Lt(v)?`: ${Lt(v)}`:""}.`));if(!o)return d(new Error(`${fe(t)} didn\'t report its session.`));c({text:N,session:o})})})}import{createHash as js,randomUUID as zs}from"node:crypto";var Ks=e=>js("sha256").update(e).digest("hex"),it=class{constructor(t,r,n,s){this.url=t;this.secretKey=r;this.authTag=n;this.log=s;this.base=t.replace(/^ws/,"http").replace(/\\/+$/,"")}base;ready=!1;watching=new Set;closed=!1;sign(t){return Cn(t,this.secretKey)}async post(t,r){let n=`${this.base}${t}`,s=this.sign({kind:27235,created_at:Math.floor(Date.now()/1e3),content:"",tags:[["u",n],["method","POST"],["payload",Ks(r)],["nonce",zs()]]}),o=await fetch(n,{method:"POST",headers:{authorization:`Nostr ${Buffer.from(JSON.stringify(s)).toString("base64")}`,"content-type":"application/json","x-auth-tag":JSON.stringify(this.authTag)},body:r,signal:AbortSignal.timeout(2e4)}),a=await o.text();if(!o.ok)throw this.ready=!1,Object.assign(new Error(`${o.status} ${a.slice(0,300)}`.trim()),{status:o.status});return this.ready=!0,JSON.parse(a)}async publish(t){let r=t.tags.filter(o=>o[0]!=="auth"&&o[0]!=="ms");r.some(o=>o[0]==="h")&&r.push(["ms",String(Date.now()%1e3)]),r.push([...this.authTag]);let n=this.sign({...t,tags:r}),s=await this.post("/events",JSON.stringify(n));if(!s.accepted&&!s.message?.startsWith("duplicate"))throw new Error(s.message||"The community refused the event.");return n}async query(t){if(!t.length)return[];let r=await this.post("/query",JSON.stringify(t));return Array.isArray(r)?r:[]}watch(t,r,n,s=3e3){let o=new Set,a=r,i=0,c,d=async()=>{if(this.closed)return;let l=s;try{let u=await this.query([{...t,since:a-5}]);i=0;for(let p of u.sort((h,v)=>h.created_at-v.created_at))o.has(p.id)||(o.add(p.id),a=Math.max(a,p.created_at),n(p));if(o.size>2e3)for(let p of[...o].slice(0,1e3))o.delete(p)}catch(u){let p=u.message??String(u),h=/retry in (\\d+)s/.exec(p);l=h?Number(h[1])*1e3:Math.min(6e4,s*2**++i),this.log(`poll failed (${p.slice(0,160)}); next in ${Math.round(l/1e3)}s`)}this.closed||(c=setTimeout(()=>void d(),l),this.watching.add(c))};return d(),()=>{c&&clearTimeout(c)}}close(){this.closed=!0;for(let t of this.watching)clearTimeout(t)}};var Zt=30*6e4,mr="A Databricks agent in its own Databricks Sandbox.";function G(e){try{Se(O.log)&&gr(O.log).size>5*1024*1024&&Ws(O.log,0)}catch{}Ys(O.log,`${new Date().toISOString()} ${e}\n`)}function Yt(e){try{return process.kill(e,0),at(`/proc/${e}/cmdline`,"utf8").includes("serve")}catch{return!1}}var Kt=()=>{let e=Number(Se(O.pid)?at(O.pid,"utf8"):"");return Number.isInteger(e)&&e>0&&Yt(e)?e:void 0};function Ce(e,t){return e===void 0&&(console.error(`No ${t} yet.`),process.exit(2)),e}var yr=(e,t)=>new it(e.relay,t,e.authTag,G);function br(e,t){return[`<identity>You are ${e.name} (pubkey ${t}), an agent in Buzz, a chat app, owned by ${e.owner}.</identity>`,"People mention you in channels, threads and Solo chats; each mention is a turn. Messages in the conversation you haven\'t seen arrive with the mention, as JSON. Your final message is posted as your reply in that conversation: make it the answer itself, in Markdown, written for the people there, without saying that you\'re posting it.",Wn(e.harness,"standard"),Vn,e.instructions.trim()?`<agent-instructions>\n${e.instructions.trim()}\n</agent-instructions>`:""].filter(Boolean).join(`\n\n`)}async function Js(e,t){let r=new Map;if(!t.length)return r;for(let n of await e.query([{kinds:[0],authors:t,limit:t.length*2}]).catch(()=>[]))try{let s=JSON.parse(n.content),o=s.display_name||s.name;o&&!r.has(n.pubkey)&&r.set(n.pubkey,String(o).slice(0,80))}catch{}return r}async function xr(e,t,r,n){let s=dr(),o=e.genieSpace;if(!o){let l=await new et(s).ask(t,{...r&&{conversationId:r},signal:n}),u=[jn(l)];l.status==="incomplete"&&u.push("_Genie One stopped early; this may be partial._");let p=l.sql[l.sql.length-1];return p&&u.push(`\\`\\`\\`sql\n${p.trim()}\n\\`\\`\\``),l.deepLink&&u.push(`[Explore in Databricks](${l.deepLink})`),{text:u.filter(Boolean).join(`\n\n`)||"Genie One had no answer.",conversation:l.conversationId}}let a=await s.ready(),i=await new Re(a).answer(o,t,{...r&&{conversationId:r},signal:n}),c=[];i.text&&c.push(i.text),i.result?.columns.length&&c.push(ve(i.result)),i.sql&&c.push(`\\`\\`\\`sql\n${i.sql.trim()}\n\\`\\`\\``),i.message.status!=="COMPLETED"&&c.push(`Genie stopped with status ${i.message.status}${i.error?`: ${i.error}`:""}.`),i.suggestions.length&&c.push(`_You could also ask:_ ${i.suggestions.slice(0,3).map(l=>`\\u201C${l}\\u201D`).join(" \\xB7 ")}`);let d=s.workspaceUrl(Re.webPath(o,i.message.conversation_id));return d&&c.push(`[Open in Genie](${d})`),{text:c.join(`\n\n`)||"Genie had no answer.",conversation:i.message.conversation_id}}async function Fs(){qt();let e=Ce(st(),"config.json"),t=Ce(ot(),"agent key"),r=Dt(t);Vt(O.pid,String(process.pid));let n=Ht(),s=new Set(n.handled),o=new Map,a=new Map,i=Date.now(),c=0,d=Date.now(),l;G(`starting as ${r.slice(0,12)}\\u2026 (${e.kind==="genie"?"Genie":fe(e.harness)}, ${e.availability})`);let u=yr(e,t),p=()=>Gt({...n,handled:[...s]}),h=()=>rt(O.status,{pid:process.pid,pubkey:r,connected:u.ready,active:c,startedAt:new Date(i).toISOString(),lastActivity:new Date(d).toISOString(),since:n.since,...l&&{lastError:l}},420);async function v(E){let _=o.get(E);if(_&&Date.now()-_.at<10*6e4)return _.kind;let[b]=await u.query([{kinds:[39e3],"#d":[E],limit:1}]),C=nr(b);return o.set(E,{at:Date.now(),kind:C}),C}async function I(E,_,b){for(let C of ir(_))await u.publish(ar({conversation:E,content:C,authTag:e.authTag,...b&&{notify:b}}))}async function k(E,_,b){let C=n.sessions[_.key];if(e.kind==="genie"){let m=e.genieSpace?`genie:${e.genieSpace}`:"genie-one",x=C?.harness===m?C.id:void 0,y=await xr(e,Mt(E.content)||"What can I ask you about?",x,b);return n.sessions[_.key]={harness:m,id:y.conversation,at:E.created_at},y.text}let H=C?.harness===e.harness?C:void 0,T=sr(_),g=(await u.query(T)).filter(m=>m.id!==E.id&&Ee.includes(m.kind)&&m.created_at<=E.created_at&&m.tags.some(x=>x[0]==="h"&&x[1]===_.channel)).filter(m=>m.created_at>(H?.at??0)&&m.pubkey!==r).sort((m,x)=>m.created_at-x.created_at),w=g.slice(-12),S=or({event:E,conversation:_,agent:r,context:w,total:g.length,names:await Js(u,[...new Set([E.pubkey,...w.map(m=>m.pubkey)])]),scope:e.scope});if(process.env.BUZZ_RUNNER_ECHO==="1")return`echo: ${Mt(E.content)} | ${_.key} | context ${w.length} | ${S.length} chars`;let A=await zt({harness:e.harness,model:e.model,permissions:"standard",...H&&{session:{id:H.id}},prompt:S,system:br(e,r),signal:b,pidFile:De(_.key),onStep:(m,x)=>G(`  ${m}${x?` \\xB7 ${x}`:""}`),onSession:m=>{n.sessions[_.key]={harness:e.harness,id:m,at:H?.at??0},p()}});return n.sessions[_.key]={harness:e.harness,id:A.session,at:E.created_at},A.text}async function L(E,_){let b=`${De(_.key)}.stopped`;hr(b,{force:!0}),c++,d=Date.now(),h(),G(`mention ${E.id.slice(0,8)} in ${_.key}`);try{let C=await k(E,_,AbortSignal.timeout(Zt));await I(_,C),G(`replied in ${_.key}`)}catch(C){Se(b)?G(`stopped in ${_.key}`):(l=C.message??String(C),G(`turn failed: ${l}`),await I(_,`I couldn\'t finish that: ${l}`,e.owner).catch(H=>G(`couldn\'t post the failure: ${H.message}`)))}finally{hr(b,{force:!0}),c--,d=Date.now(),n.since=Math.max(n.since,E.created_at),p(),h()}}function N(E){if(!(s.has(E.id)||!Ln(E)||!er(E,r))){if(s.add(E.id),!tr(E,e.owner)){G(`ignored ${E.id.slice(0,8)}: not from the owner`);return}re=re.then(async()=>{let _=E.tags.find(H=>H[0]==="h")?.[1];if(!_)return;let b=rr(E,e.scope,await v(_).catch(()=>({solo:!1})));if(!b)return;let C=(a.get(b.key)??Promise.resolve()).then(()=>L(E,b));a.set(b.key,C.catch(()=>{}))})}}let re=Promise.resolve(),ae=JSON.stringify([e.name,e.picture??""]),ce=async()=>{if(n.profile!==ae)try{await u.publish(Pt({name:e.name,...e.picture&&{picture:e.picture},about:mr,authTag:e.authTag})),n.profile=ae,p(),G("published the profile")}catch(E){G(`profile not published yet: ${E.message}`),setTimeout(()=>void ce(),6e4).unref()}};ce();let pe=n.since?n.since-5:Math.floor(Date.now()/1e3)-60;u.watch({kinds:Ee,"#p":[r]},pe,N),h(),setInterval(h,3e4).unref(),e.availability==="sleep"&&setInterval(()=>{let E=Date.now()-d>e.idleMinutes*6e4,_=Se(O.awake)?gr(O.awake).mtimeMs:0;c||!E||Date.now()-_<10*6e4||(G("idle; stopping the Sandbox until the keeper wakes it"),p(),u.close(),Vs("databricks",["api","post",`/api/2.0/sandboxes/${e.sandbox}/stop`,"--json","{}"],b=>{b&&G(`couldn\'t stop the Sandbox: ${b.message}`),process.exit(0)}))},6e4).unref(),process.on("SIGTERM",()=>{p(),u.close(),process.exit(0)})}async function Qs(){let[e,...t]=process.argv.slice(2);switch(qt(),e){case"keygen":{let r=ot();r||(r=Dn(),lr(r)),console.log(JSON.stringify({pubkey:Dt(r)}));return}case"profile":{let r=Ce(st(),"config.json");await yr(r,Ce(ot(),"agent key")).publish(Pt({name:r.name,...r.picture&&{picture:r.picture},about:mr,authTag:r.authTag}));let s=Ht();Gt({...s,profile:JSON.stringify([r.name,r.picture??""])}),console.log("published");return}case"start":{if(Kt())return console.log("running");let r=Xs(O.log,"a"),n=Zs(process.execPath,[process.argv[1],"serve"],{detached:!0,stdio:["ignore",r,r]});return n.unref(),Vt(O.pid,String(n.pid)),console.log("started")}case"stop":{let r=Kt();if(r){process.kill(r,"SIGTERM");for(let n=0;n<50&&Yt(r);n++)await new Promise(s=>setTimeout(s,100));Yt(r)&&process.kill(r,"SIGKILL")}return console.log(r?"stopped":"not running")}case"interrupt":{let[r="",n=""]=t;for(let s of[`${r}/${n}`,r]){let o=De(s),a=Number(Se(o)?at(o,"utf8"):"");if(a){Vt(`${o}.stopped`,"");try{return process.kill(-a,"SIGTERM"),console.log("true")}catch{}}}return console.log("false")}case"status":{let r=Kt(),n=Se(O.status)?JSON.parse(at(O.status,"utf8")):{};return console.log(JSON.stringify({...n,running:!!r}))}case"ask":{let r=Ce(st(),"config.json"),n=t.join(" ")||"Say hello in one short sentence.";if(r.kind==="genie")return console.log((await xr(r,n,void 0,AbortSignal.timeout(Zt))).text);let s=await zt({harness:r.harness,model:r.model,permissions:"standard",prompt:n,system:br(r,"diagnostic"),signal:AbortSignal.timeout(Zt),pidFile:De("ask"),onStep:(o,a)=>console.error(`step: ${o}${a?` \\xB7 ${a}`:""}`)});return console.log(s.text)}case"serve":return Fs();default:console.error("usage: runner.mjs keygen|profile|start|serve|stop|interrupt|status"),process.exit(2)}}Qs().catch(e=>{G(`fatal: ${e?.stack??e}`),console.error(e?.message??e),process.exit(1)});\n';
var RUNNER_SHA = "d33e783a7baf61d7";

// plugins/agents/src/keeper.ts
var KEEPER_SCRIPT = `# Keeps a Buzz agent's Databricks Sandbox and runner up.
# Created by the Databricks Agents plugin for Buzz; deleting the agent deletes its job.
import sys, time
from databricks.sdk import WorkspaceClient

sandbox = sys.argv[1]
w = WorkspaceClient()

def api(method, path, body=None):
    return w.api_client.do(method, path, body=body)

state = api("GET", f"/api/2.0/sandboxes/{sandbox}").get("status", {}).get("state")
print("sandbox", sandbox, "was", state)
if state in ("SANDBOX_STATE_STOPPED", "SANDBOX_STATE_STOPPING"):
    deadline = time.time() + 300
    while state == "SANDBOX_STATE_STOPPING" and time.time() < deadline:
        time.sleep(5)
        state = api("GET", f"/api/2.0/sandboxes/{sandbox}").get("status", {}).get("state")
    if state == "SANDBOX_STATE_STOPPED":
        api("POST", f"/api/2.0/sandboxes/{sandbox}/start")
deadline = time.time() + 300
while state != "SANDBOX_STATE_RUNNING" and time.time() < deadline:
    time.sleep(3)
    state = api("GET", f"/api/2.0/sandboxes/{sandbox}").get("status", {}).get("state")
if state != "SANDBOX_STATE_RUNNING":
    raise SystemExit(f"sandbox didn't start: {state}")
r = api("POST", f"/api/2.0/sandbox-exec/sandboxes/{sandbox}/exec-sync",
        body={"cmd": "/bin/bash", "args": ["-lc", "node ~/.buzz/agent/runner.mjs start"], "execution_timeout": "60s"})
print("runner:", r.get("exit_code"), (r.get("stdout") or "").strip()[-500:], (r.get("stderr") or "").strip()[-500:])
if r.get("exit_code") != 0:
    raise SystemExit("runner didn't start")
`;
var keeperSchedule = (availability) => availability === "always" ? "0 0/30 * * * ?" : "0 0/15 * * * ?";
var scriptPath = (home) => `${home}/.buzz/agent_keeper.py`;
async function uploadScript(client, home, signal) {
  await client.post("/api/2.0/workspace/mkdirs", { path: `${home}/.buzz` }, signal ? { signal } : {});
  await client.post(
    "/api/2.0/workspace/import",
    { path: scriptPath(home), format: "AUTO", language: "PYTHON", overwrite: true, content: btoa(KEEPER_SCRIPT) },
    signal ? { signal } : {}
  );
}
async function ensureKeeper(client, input) {
  const me = await client.get("/api/2.0/preview/scim/v2/Me", { query: { attributes: "userName" }, ...input.signal && { signal: input.signal } });
  const home = `/Users/${me.userName}`;
  await uploadScript(client, home, input.signal);
  const settings = {
    name: `Buzz agent: ${input.agentName}`.slice(0, 100),
    description: "Keeps a fully remote Buzz agent's Databricks Sandbox and runner up. Created by the Databricks Agents plugin; removing the agent in Buzz deletes this job.",
    tags: { created_by: "buzz", buzz_agent: input.pubkey.slice(0, 16) },
    schedule: { quartz_cron_expression: keeperSchedule(input.availability), timezone_id: "UTC", pause_status: "UNPAUSED" },
    max_concurrent_runs: 1,
    tasks: [
      {
        task_key: "keep",
        spark_python_task: { python_file: scriptPath(home), parameters: [input.sandbox] },
        environment_key: "default",
        timeout_seconds: 900
      }
    ],
    environments: [{ environment_key: "default", spec: { client: "2" } }]
  };
  const init = input.signal ? { signal: input.signal } : {};
  if (input.jobId) {
    try {
      await client.post("/api/2.2/jobs/reset", { job_id: input.jobId, new_settings: settings }, init);
      return input.jobId;
    } catch (error) {
      if (error.status !== 400 && error.status !== 404) throw error;
    }
  }
  const created = await client.post("/api/2.2/jobs/create", settings, init);
  return created.job_id;
}
async function deleteKeeper(client, jobId, signal) {
  try {
    await client.post("/api/2.2/jobs/delete", { job_id: jobId }, signal ? { signal } : {});
  } catch (error) {
    const status = error.status;
    if (status !== 400 && status !== 404) throw error;
  }
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
var RESULT_LANGUAGE = "databricks-result";

// plugins/agents/src/remote.ts
var HARNESSES = [
  { id: "builtin", label: "Built-in", detail: "Fastest. Uses Buzz's tools and the tools you pick, and runs code in the Sandbox when it needs to." },
  { id: "claude", label: "Claude Code", detail: "Anthropic's coding agent, running in the Sandbox with its own tools and the Databricks CLI signed in as you. Keeps its context between turns." },
  { id: "codex", label: "Codex", detail: "OpenAI's coding agent, running in the Sandbox with its own tools and the Databricks CLI signed in as you. Keeps its context between turns." },
  { id: "pi", label: "Pi", detail: "A small coding agent for Claude, GPT and Gemini models, running in the Sandbox with its own tools. Keeps its context between turns." }
];
var HARNESS_IDS = HARNESSES.map((harness) => harness.id);
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
var shellQuote = (text) => `'${text.replace(/'/g, `'\\''`)}'`;

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
  async invokeAgent(target, messages, options = {}) {
    const init = { timeoutMs: 175e3, ...options.signal && { signal: options.signal } };
    if (/^https:\/\//.test(target)) {
      const base2 = target.replace(/\/+$/, "");
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
    const path = `/serving-endpoints/${encodeURIComponent(target)}/invocations`;
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

// plugins/agents/src/ui.tsx
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
function useAgentService(service, profile) {
  return React.useMemo(() => profile && service.forProfile ? service.forProfile(profile) : service, [service, profile]);
}
var LIST_TTL_MS = 5 * 6e4;
var lists = /* @__PURE__ */ new WeakMap();
function cachedList(service, key, load) {
  let entries = lists.get(service);
  if (!entries) lists.set(service, entries = /* @__PURE__ */ new Map());
  const found = entries.get(key);
  if (found && Date.now() - found.at < LIST_TTL_MS) return found.value;
  const value = load();
  const kept = entries;
  kept.set(key, { at: Date.now(), value });
  value.catch(() => {
    if (kept.get(key)?.value === value) kept.delete(key);
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

// plugins/agents/src/hosted.tsx
var HOSTED_TYPE_ID = "databricks-hosted";
var AGENT_DIR = `${SANDBOX_HOME}/.buzz/agent`;
var RECORD_PREFIX = "bkvarda.databricks-hosted.v1:";
var IDLE_MINUTES = 5;
var HARNESS_CHOICES = HARNESSES.filter((harness) => harness.id !== "builtin");
function normalizeHosted(value) {
  const config = value ?? {};
  const harness = HARNESS_CHOICES.some((choice) => choice.id === config.harness) ? config.harness : "claude";
  const genie = config.genie && typeof config.genie.space === "string" && config.genie.space ? { space: config.genie.space, label: String(config.genie.label || config.genie.space) } : void 0;
  return {
    kind: config.kind === "sandbox" ? "sandbox" : "genie",
    harness,
    model: typeof config.model === "string" && harnessAccepts(harness, config.model) ? config.model : HARNESS_MODEL[harness],
    availability: config.availability === "always" ? "always" : "sleep",
    scope: config.scope === "channel" ? "channel" : "thread",
    instructions: typeof config.instructions === "string" ? config.instructions : "",
    ...typeof config.profile === "string" && config.profile && { profile: config.profile },
    ...genie && { genie }
  };
}
function summarizeHosted(config) {
  const what = config.kind === "genie" ? config.genie ? `Genie \xB7 ${config.genie.label}` : "Genie One" : `${harnessLabel(config.harness)} \xB7 ${harnessModel(config.harness, config.model).replace(/^system\.ai\./, "")}`;
  return [what, config.availability === "always" ? "always on" : "sleeps when idle", ...config.profile ? [config.profile] : []].join(" \xB7 ");
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
function runnerConfigOf(record, host) {
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
    ...host && { workspaceHost: host }
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
async function uploadRunner(sandboxes, sandbox, signal) {
  const current = await sandboxes.bash(sandbox, `cat ${shellQuote(`${AGENT_DIR}/runner.sha`)} 2>/dev/null`, { timeoutSeconds: 30, ...signal && { signal } });
  if (current.stdout?.trim() === RUNNER_SHA) return;
  await sandboxes.writeFile(sandbox, `${AGENT_DIR}/runner.mjs`, RUNNER, signal);
  await sandboxes.bash(sandbox, `echo ${RUNNER_SHA} > ${shellQuote(`${AGENT_DIR}/runner.sha`)}`, { timeoutSeconds: 30, ...signal && { signal } });
}
async function runner(sandboxes, sandbox, args, signal, timeoutSeconds = 90) {
  const result = await sandboxes.bash(sandbox, `node ${shellQuote(`${AGENT_DIR}/runner.mjs`)} ${args}`, { timeoutSeconds, ...signal && { signal } });
  if (result.exit_code !== 0) throw new Error(`The agent's runner couldn't ${args.split(" ")[0]}: ${(result.stderr || result.stdout || `exit ${result.exit_code}`).trim().slice(-400)}`);
  return (result.stdout ?? "").trim();
}
async function deploy(service, record, options) {
  const { client, sandboxes } = await sandboxOf(service, record, options.signal);
  await sandboxes.ensureRunning(record.sandbox, { ...options.signal && { signal: options.signal } });
  await uploadRunner(sandboxes, record.sandbox, options.signal);
  await sandboxes.writeFile(record.sandbox, `${AGENT_DIR}/config.json`, `${JSON.stringify(runnerConfigOf(record, client.host), null, 2)}
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
  const records = () => storage.keys().filter((key) => key.startsWith(RECORD_PREFIX) && !key.includes(":pending:")).map((key) => parse(storage.get(key))).filter((record) => Boolean(record?.pubkey));
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
      const { client } = await deploy(service, record, { restart: true, publishProfile: true, signal: input.signal });
      record.jobId = await ensureKeeper(client, { ...record.jobId && { jobId: record.jobId }, sandbox: record.sandbox, agentName: record.name, pubkey: input.pubkey, availability: record.config.availability, signal: input.signal });
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
      if (record.jobId) await deleteKeeper(client, record.jobId, input.signal);
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
      const { client } = await deploy(service, record, { restart: true, publishProfile: false, ...signal && { signal } });
      record.jobId = await ensureKeeper(client, { ...record.jobId && { jobId: record.jobId }, sandbox: record.sandbox, agentName: record.name, pubkey, availability: record.config.availability, ...signal && { signal } });
      await write(record);
    },
    /** Wakes the agent's Sandbox now and starts its runner. */
    async wake(pubkey, signal) {
      const record = read(pubkey);
      if (!record) throw new Error("This agent is managed from another device.");
      const { sandboxes } = await sandboxOf(service, record, signal);
      await sandboxes.ensureRunning(record.sandbox, { ...signal && { signal } });
      await sandboxes.bash(record.sandbox, `touch ${shellQuote(`${AGENT_DIR}/awake`)}`, { timeoutSeconds: 30, ...signal && { signal } });
      await runner(sandboxes, record.sandbox, "start", signal);
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
function keepAgentsAwake(provider) {
  const beat = () => {
    for (const record of provider.records())
      if (record.config.availability === "sleep" && record.community) void provider.wake(record.pubkey).catch(() => {
      });
  };
  const first = setTimeout(beat, 3e4);
  const timer = setInterval(beat, 4 * 6e4);
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
  always: "Replies within seconds at any time. Its Sandbox runs all the time.",
  sleep: `Its Sandbox sleeps after ${IDLE_MINUTES} minutes without work. It stays awake while your Buzz is open; with your laptop off it wakes every 15 minutes, so a reply can take that long.`
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
  return /* @__PURE__ */ React.createElement(DbxRoot, null, /* @__PURE__ */ React.createElement(Stack, { gap: 14 }, /* @__PURE__ */ React.createElement(NeedsConnection, { service: props.service }), available.data === false && /* @__PURE__ */ React.createElement(Notice, { tone: "warning" }, "Databricks Sandbox isn't on in this workspace, and this agent runs in one. An admin can turn on the Sandbox preview."), !props.locked && /* @__PURE__ */ React.createElement(Field, { label: "Type", hint: kind.detail }, /* @__PURE__ */ React.createElement("select", { className: "dbx-select", ...disabled, value: kind.id, onChange: (event) => onChange({ ...config, kind: event.target.value }) }, KIND_CHOICES.map((choice) => /* @__PURE__ */ React.createElement("option", { key: choice.id, value: choice.id }, choice.label)))), !props.locked && /* @__PURE__ */ React.createElement(
    WorkspaceField,
    {
      service: props.service,
      ...config.profile && { profile: config.profile },
      ...disabled,
      onChange: (profile) => {
        const { profile: _old, genie: _genie, ...rest } = config;
        onChange({ ...rest, ...profile && { profile } });
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
  )), /* @__PURE__ */ React.createElement(Field, { label: "Availability", hint: AVAILABILITY_HINT[config.availability] }, /* @__PURE__ */ React.createElement("select", { className: "dbx-select", ...disabled, value: config.availability, onChange: (event) => onChange({ ...config, availability: event.target.value }) }, /* @__PURE__ */ React.createElement("option", { value: "sleep" }, "Sleep when idle"), /* @__PURE__ */ React.createElement("option", { value: "always" }, "Always on"))), /* @__PURE__ */ React.createElement(Field, { label: "Conversation", hint: "Thread: each thread is its own conversation. Channel: one conversation for the whole channel." }, /* @__PURE__ */ React.createElement("select", { className: "dbx-select", ...disabled, value: config.scope, onChange: (event) => onChange({ ...config, scope: event.target.value }) }, /* @__PURE__ */ React.createElement("option", { value: "thread" }, "One per thread"), /* @__PURE__ */ React.createElement("option", { value: "channel" }, "One per channel"))), config.kind === "sandbox" && /* @__PURE__ */ React.createElement(Field, { label: "Instructions", hint: "Optional. Who it is, what it should focus on, how to answer." }, /* @__PURE__ */ React.createElement("textarea", { className: "dbx-textarea", rows: 5, ...disabled, value: config.instructions, onChange: (event) => onChange({ ...config, instructions: event.target.value }) })), !props.locked && /* @__PURE__ */ React.createElement(Text, { tone: "tertiary", size: "xs" }, "Runs in Databricks, so it answers you with your laptop off. Only your own messages reach it. Its Sandbox and a small scheduled job that keeps it running belong to you in Databricks; removing the agent deletes both.")));
}
var STATE_LABEL = {
  SANDBOX_STATE_RUNNING: "Running",
  SANDBOX_STATE_STOPPED: "Asleep",
  SANDBOX_STATE_STOPPING: "Going to sleep",
  SANDBOX_STATE_PENDING: "Starting",
  missing: "Its Sandbox is gone"
};
function HostedSettings(props) {
  const [nonce, setNonce] = React.useState(0);
  const status = useAsync(() => props.provider.status(props.pubkey), [props.pubkey, nonce]);
  const record = props.provider.read(props.pubkey);
  const [draft, setDraft] = React.useState(record?.config);
  const [busy, setBusy] = React.useState();
  const [error, setError] = React.useState();
  if (!record || !draft)
    return /* @__PURE__ */ React.createElement(DbxRoot, { style: { padding: "4px 0 24px" } }, /* @__PURE__ */ React.createElement(Notice, { tone: "info" }, "This agent was set up from another device, which manages its settings."));
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
  const state = status.data?.state;
  const runnerState = status.data?.runner;
  const dirty = JSON.stringify(draft) !== JSON.stringify(record.config);
  const job = record.jobId ? workspace.workspaceUrl(`/jobs/${record.jobId}`) : void 0;
  return /* @__PURE__ */ React.createElement(DbxRoot, { style: { padding: "4px 0 24px" } }, /* @__PURE__ */ React.createElement(Stack, { gap: 16 }, /* @__PURE__ */ React.createElement(
    Notice,
    {
      tone: state === "SANDBOX_STATE_RUNNING" && runnerState?.running === false ? "warning" : "info",
      title: status.loading && !status.data ? "Checking\u2026" : STATE_LABEL[state ?? ""] ?? state ?? "Unknown",
      action: /* @__PURE__ */ React.createElement(Button, { size: "sm", disabled: Boolean(busy), onClick: () => run("wake", () => props.provider.wake(props.pubkey)) }, busy === "wake" ? /* @__PURE__ */ React.createElement(Spinner, { size: 11 }) : null, state === "SANDBOX_STATE_RUNNING" ? "Check again" : "Wake now")
    },
    state === "SANDBOX_STATE_RUNNING" ? runnerState?.running ? `${runnerState.connected ? "Connected to the community" : "Connecting"}${runnerState.active ? ` \xB7 working on ${runnerState.active}` : ""}${runnerState.lastError ? ` \xB7 last error: ${runnerState.lastError}` : ""}.` : "The Sandbox is up but the agent isn't running; Wake now starts it." : state === "SANDBOX_STATE_STOPPED" ? "It wakes on its schedule, or now with Wake now." : `Sandbox ${record.sandbox}.`,
    " ",
    job && /* @__PURE__ */ React.createElement("a", { className: "dbx-link", href: job, target: "_blank", rel: "noreferrer" }, "Keeper job")
  ), /* @__PURE__ */ React.createElement(HostedForm, { service: props.service, config: draft, onChange: setDraft, ...busy && { disabled: true }, locked: true }), error && /* @__PURE__ */ React.createElement(Notice, { tone: "danger" }, error), /* @__PURE__ */ React.createElement(Stack, { direction: "row", gap: 8, justify: "flex-end" }, /* @__PURE__ */ React.createElement(Button, { variant: "ghost", disabled: !dirty || Boolean(busy), onClick: () => setDraft(record.config) }, "Revert"), /* @__PURE__ */ React.createElement(Button, { variant: "primary", disabled: !dirty || Boolean(busy), onClick: () => run("save", () => props.provider.update(props.pubkey, draft)) }, busy === "save" ? /* @__PURE__ */ React.createElement(Spinner, { size: 11 }) : null, "Save"))));
}
function registerHostedType(agents, service) {
  const provider = hostedProvider(agents, service);
  const icon = databricksIcon();
  const type = {
    id: HOSTED_TYPE_ID,
    icon,
    title: "Databricks",
    description: "Genie, or Claude Code, Codex or Pi in a Databricks Sandbox. Runs in Databricks, so it answers with your laptop off.",
    defaults: () => ({ config: normalizeHosted({}) }),
    summary: (agent) => summarizeHosted(provider.read(agent.pubkey ?? "")?.config ?? normalizeHosted(agent.config)),
    Create: (props) => /* @__PURE__ */ React.createElement(HostedForm, { service, config: normalizeHosted(props.config), onChange: props.onChange, disabled: props.disabled }),
    tabs: [
      {
        id: "settings",
        title: "Settings",
        role: "settings",
        component: (props) => /* @__PURE__ */ React.createElement(HostedSettings, { service, provider, pubkey: props.agent.pubkey })
      }
    ],
    remote: {
      provision: provider.provision,
      activate: provider.activate,
      profile: provider.profile,
      interrupt: provider.interrupt,
      remove: provider.remove
    }
  };
  agents.register(type);
  return keepAgentsAwake(provider);
}

// plugins/agents/src/index.tsx
var inject = ["react", "agents", "settingsCards"];
function apply(ctx) {
  bindReact(ctx.react);
  const live = attach(ctx, { id: "bkvarda.databricks-agents", name: "Databricks Agents" }, (scope, databricks) => {
    if (!scope.agents.harness) return { kit: false };
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
      return /* @__PURE__ */ React.createElement(DbxRoot, null, /* @__PURE__ */ React.createElement(Stack, { gap: 18 }, /* @__PURE__ */ React.createElement(Stack, { gap: 6 }, /* @__PURE__ */ React.createElement(Text, { as: "h2", size: "xl", weight: 500 }, "Databricks Agents"), /* @__PURE__ */ React.createElement(Text, { tone: "subtle" }, "Agents that run fully in Databricks, with your access and your governance, and answer with your laptop off.")), !runtime.kit && /* @__PURE__ */ React.createElement(Notice, { tone: "warning", title: "Update Buzz to create Databricks agents" }, "This version of Buzz doesn't let plugins bring hosted agent types yet. Update Buzz (Settings \u2192 Buzz \u2192 Updates); the Databricks type then appears in Agents."), [
        ["Genie", "Mention it with a data question anywhere. It answers with Genie One, or one of your Genie agents, as charts and tables, and keeps a Genie conversation per thread."],
        ["Sandbox agent", "Claude Code, Codex or Pi working in its own Databricks Sandbox, with the Databricks CLI signed in as you. It keeps its context between turns and runs in each harness's guarded mode."],
        ["Always on, or sleep when idle", "Each agent's Sandbox either runs all the time, or sleeps when idle and wakes on a schedule (and stays awake while your Buzz is open). A small scheduled job in your workspace keeps it running."]
      ].map(([title, body]) => /* @__PURE__ */ React.createElement(Stack, { key: title, gap: 2 }, /* @__PURE__ */ React.createElement(Text, { weight: 500 }, title), /* @__PURE__ */ React.createElement(Text, { tone: "subtle", size: "sm" }, body))), /* @__PURE__ */ React.createElement(Text, { size: "sm" }, "To create one, open ", /* @__PURE__ */ React.createElement("b", null, "Agents"), ", choose ", /* @__PURE__ */ React.createElement("b", null, "New agent"), " and pick ", /* @__PURE__ */ React.createElement("b", null, "Databricks (hosted)"), " as the harness.")));
    }
  });
}
export {
  apply,
  inject
};
