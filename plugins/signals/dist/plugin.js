// Signals (bkvarda.databricks-signals) — built by databricks-buzz-plugins. Apache-2.0.

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
  return a.size === b.size && [...b].every(([id, status2]) => a.get(id) === status2);
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
/* Markdown inside a card, the host's included: headings no bigger than bold body text. */
[data-dbx] .dbx-quiet-headings :is(h1, h2, h3, h4, h5, h6) { font-size: 1em !important; line-height: inherit !important; font-weight: 600 !important; letter-spacing: normal !important; margin: 12px 0 4px !important; padding: 0 !important; border: 0 !important; }
[data-dbx] .dbx-quiet-headings :is(h1, h2, h3, h4, h5, h6):first-child { margin-top: 0 !important; }
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
function openExternal(url, doc = document) {
  const link2 = doc.createElement("a");
  link2.href = url;
  link2.target = "_blank";
  link2.rel = "noreferrer";
  link2.style.display = "none";
  doc.body.appendChild(link2);
  link2.click();
  link2.remove();
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
function ago(ms, now = Date.now()) {
  const diff = Math.round((now - ms) / 1e3);
  const s = Math.abs(diff);
  if (s < 45) return "just now";
  const m = Math.round(s / 60);
  const h = Math.round(m / 60);
  const span = m < 60 ? `${m}m` : h < 24 ? `${h}h` : `${Math.round(h / 24)}d`;
  return diff < 0 ? `in ${span}` : `${span} ago`;
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
  const signIn = (label2) => service.reauthenticate ? /* @__PURE__ */ React.createElement(Button, { size: "sm", variant: "brand", onClick: () => void service.reauthenticate() }, label2) : void 0;
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

// packages/core/src/workspace-choice.ts
function followWorkspace(main, key) {
  const chosen = () => main.preferences.get(key) || void 0;
  const target = () => {
    const profile = chosen();
    return profile && main.forProfile ? main.forProfile(profile) : main;
  };
  const listeners = /* @__PURE__ */ new Set();
  const preferenceListeners = /* @__PURE__ */ new Set();
  const notify = () => {
    for (const listener of [...listeners]) listener();
  };
  const notifyPreferences = () => {
    for (const listener of [...preferenceListeners]) listener();
  };
  let current = target();
  let stop = current.subscribe(notify);
  let stopPreferences = current.preferences.subscribe(notifyPreferences);
  const follow = () => {
    const next = target();
    if (next === current) return;
    stop();
    stopPreferences();
    current = next;
    stop = current.subscribe(notify);
    stopPreferences = current.preferences.subscribe(notifyPreferences);
    notify();
    notifyPreferences();
  };
  main.preferences.subscribe(follow);
  main.subscribe(follow);
  const preferences = {
    get: (name) => current.preferences.get(name),
    set: (name, value) => current.preferences.set(name, value),
    subscribe: (listener) => {
      preferenceListeners.add(listener);
      return () => preferenceListeners.delete(listener);
    }
  };
  return {
    version: 1,
    snapshot: () => current.snapshot(),
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    client: () => current.client(),
    ready: (signal) => current.ready(signal),
    workspaceUrl: (path) => current.workspaceUrl(path),
    profiles: () => main.profiles(),
    openSettings: () => main.openSettings(),
    signIn: () => current.signIn(),
    reauthenticate: () => current.reauthenticate ? current.reauthenticate() : current.signIn(),
    cancelSignIn: () => current.cancelSignIn?.(),
    preferences,
    ...main.announce && { announce: main.announce },
    ...main.forProfile && { forProfile: main.forProfile },
    ...main.addWorkspace && { addWorkspace: main.addWorkspace },
    profile: chosen,
    setProfile: (profile) => main.preferences.set(key, profile || void 0)
  };
}

// packages/core/src/api/apps.ts
var status = (error) => error.status;
var missing = (error) => status(error) === 404 || ["RESOURCE_DOES_NOT_EXIST", "NOT_FOUND"].includes(String(error.errorCode));
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
var base64 = (text) => {
  const bytes = new TextEncoder().encode(text);
  let binary = "";
  for (let i = 0; i < bytes.length; i += 32768) binary += String.fromCharCode(...bytes.subarray(i, i + 32768));
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

// packages/core/src/api/mcp.ts
var gatewayMcpPath = (fullName) => `/ai-gateway/mcp-services/${fullName}`;

// plugins/signals/src/client.ts
var HUB_PREFIX = "Signals hub";
var HUB_PREFERENCE = "signalsHub";
async function hubApps(client, signal) {
  return (await new Apps(client).list(signal)).filter((app) => app.description?.startsWith(HUB_PREFIX));
}
async function chosenHub(service, signal) {
  const apps = await hubApps(await service.ready(signal), signal);
  const picked = service.preferences.get(HUB_PREFERENCE);
  const app = apps.find((found) => found.name === picked) ?? (apps.length === 1 ? apps[0] : apps.find((found) => found.app_status?.state === "RUNNING"));
  return { apps, ...app && { app } };
}
var HubClient = class {
  constructor(client, app) {
    this.client = client;
    this.app = app;
  }
  async call(method, path, init = {}) {
    if (!this.app.url) throw new Error(`The signals hub ${this.app.name} isn't running.`);
    const response = await this.client.request(`${this.app.url.replace(/\/+$/, "")}${path}`, {
      method,
      ...init.query && { query: init.query },
      ...init.body !== void 0 && { body: init.body },
      timeoutMs: 6e4,
      ...init.signal && { signal: init.signal }
    });
    if (response.status === 401 || response.status === 403) throw new Error(`You can't use the signals hub ${this.app.name} yet. Ask its owner for Can Use on the app.`);
    if (!/json/.test(response.headers["content-type"] ?? "")) throw new Error(`The signals hub ${this.app.name} answered HTTP ${response.status}; it may be stopped or still starting.`);
    const body = JSON.parse(response.body);
    if (response.status >= 400) throw new Error([body.error ?? `HTTP ${response.status}`, ...body.problems ?? []].join(" "));
    return body;
  }
  sources(signal) {
    return this.call("GET", "/api/sources", { ...signal && { signal } });
  }
  setSource(source, enabled, forget = false) {
    return this.call("POST", "/api/sources", { body: { source, enabled, forget } });
  }
  tasks(filter = {}, signal) {
    const query = {
      ...filter.open && { open: "1" },
      ...filter.account && { account: filter.account },
      ...filter.channel && { channel: filter.channel },
      ...filter.status && { status: filter.status },
      ...filter.workstream && { workstream: filter.workstream },
      ...filter.initiative && { initiative: filter.initiative },
      limit: filter.limit ?? 50
    };
    return this.call("GET", "/api/tasks", { query, ...signal && { signal } }).then((reply) => reply.tasks);
  }
  task(id) {
    return this.call("GET", "/api/task", { query: { id } });
  }
  /** A channel's tasks for the board: who's on each, its source, artifacts and last activity. */
  board(channel, signal) {
    return this.call("GET", "/api/board", { query: { channel }, ...signal && { signal } });
  }
  updateTask(input) {
    return this.call("POST", "/api/task", { body: input });
  }
  accounts(signal) {
    return this.call("GET", "/api/accounts", { ...signal && { signal } }).then((reply) => reply.accounts);
  }
  /** The account set up for a channel (or by name), or null. */
  account(by, signal) {
    return this.accountLookup(by, signal).then((found) => found.account);
  }
  /** The account and the hub's workstreams, which setup offers even before there's an account. */
  accountLookup(by, signal) {
    return this.call("GET", "/api/account", { query: { ...by }, ...signal && { signal } }).then((reply) => ({
      account: reply.account ? { ...reply.account, ...reply.labels && { labels: reply.labels }, ...reply.workstreams && { workstreams: reply.workstreams }, ...reply.warning && { warning: reply.warning } } : null,
      workstreams: reply.workstreams ?? []
    }));
  }
  saveAccount(input) {
    return this.call("POST", "/api/account", { body: input }).then((reply) => ({ ...reply.account, ...reply.labels && { labels: reply.labels }, ...reply.workstreams && { workstreams: reply.workstreams }, ...reply.warning && { warning: reply.warning } }));
  }
  /** The agents saving these agents for an account would ask to work on its open tasks (the save's handoff), without saving. */
  handOffs(input, signal) {
    return this.call("POST", "/api/handoffs", { body: input, ...signal && { signal } }).then((reply) => reply.agents);
  }
  deleteAccount(name) {
    return this.call("POST", "/api/account", { body: { name, delete: true } });
  }
  /** Events a rule's classifier kept from opening a task in this channel, newest first, with why. */
  filtered(channel, signal) {
    return this.call("GET", "/api/filtered", { query: { channel, days: 14, limit: 100 }, ...signal && { signal } }).then((reply) => reply.events);
  }
  /** Your poller's setup: your database role, and the settings for your sources.json and job. */
  onboarding(signal) {
    return this.call("GET", "/api/onboard", { ...signal && { signal } });
  }
  /** Creates your database role if the hub can. */
  createRole() {
    return this.call("POST", "/api/onboard");
  }
  events(events) {
    return this.call("POST", "/api/events", { body: { events } });
  }
};
async function signInState(client, service, signal) {
  const path = gatewayMcpPath(`system.ai.${service}`);
  const headers = { Accept: "application/json, text/event-stream" };
  try {
    const init = await client.request(path, { method: "POST", headers, body: { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "signals", version: "1" } } }, timeoutMs: 3e4, ...signal && { signal } });
    if (init.status === 401) return "needed";
    if (init.status === 404) return "unknown";
    const session = init.headers["mcp-session-id"];
    const list = await client.request(path, { method: "POST", headers: { ...headers, "MCP-Protocol-Version": "2025-06-18", ...session && { "Mcp-Session-Id": session } }, body: { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }, timeoutMs: 3e4, ...signal && { signal } });
    return rpcSignIn(list.status, list.body);
  } catch {
    return "unknown";
  }
}
function rpcSignIn(status2, body) {
  if (status2 === 401) return "needed";
  if (status2 >= 400) return "unknown";
  const payload = body.includes("data:") ? body.split("\n").filter((line2) => line2.startsWith("data:")).map((line2) => line2.slice(5)).join("") : body;
  try {
    const reply = JSON.parse(payload);
    if (reply.error) return reply.error.code === -32006 || /401|not logged in|login first|Credential for user/i.test(reply.error.message ?? "") ? "needed" : "unknown";
    return reply.result ? "signed-in" : "unknown";
  } catch {
    return "unknown";
  }
}
var lakebaseSnippet = (onboarding) => onboarding.lakebase ? JSON.stringify({ lakebase: onboarding.lakebase }, null, 2) : void 0;
var signInPath = (service) => `/explore/mcp-services/system/ai/${service}`;

// plugins/signals/app/model.ts
var capitalized = (word) => word.charAt(0).toUpperCase() + word.slice(1);
var MODES = ["auto", "draft", "ask", "off"];
var DEFAULT_MODE = "draft";
var MODE_LINE = /^\s*(?:[-*]\s*)?([^:#]{1,80}?)\s*:\s*(\S+)\s*$/;
function parsePreferences(text) {
  const modes = {};
  const guidance = [];
  const problems = [];
  for (const line2 of (text ?? "").split(/\r?\n/)) {
    const found = MODE_LINE.exec(line2);
    const value = found?.[2].toLowerCase().replace(/[.,;]$/, "");
    if (found && MODES.includes(value)) modes[found[1].trim().toLowerCase()] = value;
    else {
      if (found && /^(auto|draft|ask|off|on|manual|skip|none)\b/i.test(found[2])) problems.push(`"${line2.trim()}": the mode is one of ${MODES.join(", ")}`);
      guidance.push(line2);
    }
  }
  return { modes, guidance: guidance.join("\n").trim(), problems };
}
var MAX_PLAYBOOKS = 30;
var MAX_PLAYBOOK = 6e3;
function playbookFor(playbooks, task) {
  const entries = Object.entries(playbooks ?? {}).filter(([, text]) => text.trim());
  for (const wanted of [task.rule_id, task.workstream ?? void 0]) {
    const lower = wanted?.trim().toLowerCase();
    const found = lower && entries.find(([key]) => key.trim().toLowerCase() === lower);
    if (found) return { key: found[0], text: found[1].trim() };
  }
  return void 0;
}
var MAX_ACTIONS = 8;
var MAX_ACTION_LABEL = 60;
var MAX_ACTION_TRIGGER = 300;
var OTHERWISE = ["track", "dismiss"];
var ACTION_ID = /^[a-z0-9-]{1,40}$/;
function readWorkstreamActions(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return "workstream_actions maps a workstream (or rule id) to {watch, otherwise}.";
  const out = {};
  for (const [key, value] of Object.entries(raw)) {
    const name = key.trim();
    if (!name || name.length > 80) return "A workstream is 1-80 characters.";
    if (Object.keys(out).some((other) => other.toLowerCase() === name.toLowerCase())) return `${name} is named twice.`;
    if (!value || typeof value !== "object" || Array.isArray(value)) return `The ${name} actions are {watch, otherwise}.`;
    const { watch, otherwise } = value;
    if (!OTHERWISE.includes(otherwise)) return `The ${name} otherwise is ${OTHERWISE.join(" or ")}.`;
    if (watch !== void 0 && !Array.isArray(watch)) return `The ${name} watch is a list of actions.`;
    const actions = [];
    for (const item of watch ?? []) {
      if (!item || typeof item !== "object" || Array.isArray(item)) return `A ${name} action is {id, label, trigger}.`;
      const { id, label: label2, trigger, always } = item;
      if (typeof id !== "string" || !ACTION_ID.test(id)) return `A ${name} action's id is 1-40 lowercase letters, digits and dashes.`;
      if (actions.some((other) => other.id === id)) return `${name} has the action ${id} twice.`;
      if (typeof label2 !== "string" || !label2.trim() || label2.trim().length > MAX_ACTION_LABEL) return `The ${name} action ${id} needs a label of 1-${MAX_ACTION_LABEL} characters.`;
      if (label2.includes("\u2014")) return `The ${name} action ${id}'s label can't contain \u2014.`;
      if (always !== void 0 && always !== true && always !== false) return `The ${name} action ${id}: always is true or left out.`;
      if (trigger !== void 0 && typeof trigger !== "string") return `The ${name} action ${id}: trigger must be text.`;
      const text = typeof trigger === "string" ? trigger.trim() : "";
      if (text.length > MAX_ACTION_TRIGGER) return `The ${name} action ${id}: the trigger is at most ${MAX_ACTION_TRIGGER} characters.`;
      if (always !== true && !text) return `The ${name} action ${id} needs a trigger (or always: true).`;
      actions.push({ id, label: label2.trim(), trigger: text, ...always === true && { always: true } });
    }
    if (actions.length > MAX_ACTIONS) return `${name} has more than ${MAX_ACTIONS} actions.`;
    out[name] = { watch: actions, otherwise };
  }
  if (Object.keys(out).length > MAX_PLAYBOOKS) return `An account sets actions for at most ${MAX_PLAYBOOKS} workstreams.`;
  return out;
}
function actionsFor(rows, task) {
  const entries = Object.entries(rows ?? {});
  for (const wanted of [task.rule_id, task.workstream ?? void 0]) {
    const lower = wanted?.trim().toLowerCase();
    const found = lower && entries.find(([key]) => key.trim().toLowerCase() === lower);
    if (found) return { key: found[0], row: found[1] };
  }
  return void 0;
}
function actionsText(found) {
  const { key, row } = found;
  const watch = row.watch.map((action) => `- ${action.label}: ${action.always ? "always" : action.trigger}`);
  const otherwise = row.otherwise === "dismiss" ? "the task is dismissed" : "the task stays open, with no agent asked";
  return [
    `Default actions for ${key} (do each one whose trigger holds, under the mode; the hub says which it found):`,
    ...watch.length ? watch : ["- none ticked"],
    `Otherwise (none holds): ${otherwise}.`
  ].join("\n");
}
var DEFAULT_WORKSTREAM_ACTIONS = [
  {
    workstream: "support cases",
    aliases: ["support", "support tracking", "cases"],
    otherwise: "dismiss",
    actions: [
      { id: "work-it", label: "Work it", trigger: "", always: true, recommended: false },
      { id: "escalate-if-needed", label: "Escalate if needed", trigger: "Poor sentiment, no case update for 2 business days, open past SLA, priority raised, or a Sev1 production outage", recommended: true },
      { id: "confirm-workaround", label: "Confirm workaround", trigger: "The linked ES moves to Mitigated or Resolved, or the case is waiting on the customer's confirmation", recommended: true },
      { id: "engage-engineering", label: "Engage engineering", trigger: "The case is about a Private Preview or Beta product, which engineering supports directly", recommended: true }
    ]
  },
  {
    workstream: "capacity requests",
    aliases: ["capacity", "es-capacity-requests", "capacity request", "quota requests"],
    otherwise: "dismiss",
    actions: [
      { id: "draft-request", label: "Draft request", trigger: "A third-party model hits a page-level 429 alert, or the customer asks for more, and no open request already covers it", recommended: true },
      { id: "nudge-request", label: "Nudge request", trigger: "The open request is unassigned for 48h or past its SLA", recommended: true },
      { id: "customer-update", label: "Customer update", trigger: "The request is granted, denied or changed", recommended: true }
    ]
  },
  {
    workstream: "escalations",
    aliases: ["incidents", "escalations and incidents", "escalations & incidents"],
    otherwise: "dismiss",
    actions: [
      { id: "brief-account-team", label: "Brief account team", trigger: "The incident affects this account's workspaces, or an escalation (ER) is opened on the account", recommended: true },
      { id: "customer-holding-note", label: "Customer holding note", trigger: "Sev0 or Sev1 impact on the account, and approved status or RCA text exists", recommended: true },
      { id: "request-confidence-call", label: "Request confidence call", trigger: "A Sev0 or Sev1 that repeats a past incident, or the customer or an exec asks for a call", recommended: true }
    ]
  },
  {
    workstream: "tickets",
    aliases: ["escalation tracking", "es tickets", "jira", "es-tickets"],
    otherwise: "track",
    actions: [
      { id: "nudge", label: "Nudge", trigger: "Unassigned past SLA, or no update for 5 business days", recommended: true },
      { id: "close-out", label: "Close out", trigger: "The status moves to Mitigated or Resolved", recommended: true },
      { id: "customer-update", label: "Customer update", trigger: "A material change: assigned, fix scheduled, or workaround available", recommended: false }
    ]
  },
  {
    workstream: "questions",
    aliases: ["customer slack questions", "customer questions", "slack questions"],
    otherwise: "dismiss",
    actions: [
      { id: "draft-answer", label: "Draft answer", trigger: "A customer question with no Databricks reply after 4 business hours, or someone asks the agent directly", recommended: true },
      { id: "route-to-support", label: "Route to support case", trigger: "A break-fix report: a production error, an outage or a failing job", recommended: true },
      { id: "route-to-ae", label: "Route to AE", trigger: "Pricing, contract or other commercial questions", recommended: true }
    ]
  },
  {
    workstream: "meeting prep",
    aliases: ["meetings", "prep"],
    otherwise: "dismiss",
    actions: [
      { id: "prep-brief", label: "Prep brief", trigger: "An external meeting with the account in the next 24h", recommended: true },
      { id: "brief-and-deck", label: "Brief + deck", trigger: "A QBR or exec meeting, or the account has an open escalation", recommended: true }
    ]
  },
  {
    workstream: "meeting follow-up",
    aliases: ["meeting follow-up and action items", "meeting action items", "follow-up", "meeting notes"],
    otherwise: "dismiss",
    actions: [
      { id: "draft-recap", label: "Draft recap + actions", trigger: "Notes exist for an external meeting, and the notes are about this account", recommended: true },
      { id: "salesforce-updates", label: "Salesforce updates", trigger: "The notes include stage, date, next-step, competitor or contact changes", recommended: true },
      { id: "create-action-tasks", label: "Create action tasks", trigger: "The notes assign a Databricks owner with a due date", recommended: false }
    ]
  }
];
function catalogFor(workstream) {
  const lower = workstream?.trim().toLowerCase();
  if (!lower) return void 0;
  return DEFAULT_WORKSTREAM_ACTIONS.find((entry) => entry.workstream === lower || entry.aliases.includes(lower));
}
function recommendedRow(entry) {
  return { watch: entry.actions.filter((action) => action.recommended).map(({ recommended: _, ...action }) => action), otherwise: entry.otherwise };
}
function agentsFor(account, task) {
  return agentListFor(account, task).agents;
}
function agentListFor(account, task) {
  const entries = Object.entries(account.workstream_agents ?? {}).filter(([, keys]) => keys.length);
  for (const wanted of [task.rule_id, task.workstream ?? void 0]) {
    const lower = wanted?.trim().toLowerCase();
    const found = lower && entries.find(([key]) => key.trim().toLowerCase() === lower);
    if (found) return { key: found[0], agents: found[1] };
  }
  return { agents: account.agents };
}
var TASK_STATUSES = ["open", "in_progress", "waiting", "done", "dismissed"];

// plugins/signals/src/agent-choices.ts
var MAX_ROW_AGENTS = 10;
function agentGroups(input) {
  const members = new Set(input.members);
  const placed = /* @__PURE__ */ new Set();
  const ownNames = new Map(input.own.map((agent) => [agent.pubkey, agent.name]));
  const option = (key) => ({ key, name: ownNames.get(key) || input.name(key), inChannel: members.has(key) });
  const take = (keys) => {
    const out = [];
    for (const key of keys) {
      if (!/^[0-9a-f]{64}$/.test(key) || placed.has(key)) continue;
      placed.add(key);
      out.push(option(key));
    }
    return out;
  };
  const byName = (a, b) => a.name.localeCompare(b.name);
  const groups = [];
  for (const team of input.teams) {
    const options = take(team.members);
    if (options.length) groups.push({ id: `team:${team.id}`, title: team.name, team: true, options });
  }
  const channel = take(input.channelAgents).sort(byName);
  if (channel.length) groups.push({ id: "channel", title: groups.length ? "Other agents in this channel" : "In this channel", options: channel });
  const rest = take(input.own.map((agent) => agent.pubkey)).sort(byName);
  if (rest.length) groups.push({ id: "own", title: groups.length ? "Your other agents" : "Your agents", options: rest });
  return groups;
}
function filterGroups(groups, query) {
  const words = query.replace(/^@/, "").toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return [...groups];
  return groups.map((group) => ({ ...group, options: group.options.filter((option) => words.every((word) => option.name.toLowerCase().includes(word) || group.title.toLowerCase().includes(word))) })).filter((group) => group.options.length);
}
function withTeam(value, team) {
  const out = [...value];
  for (const key of team) if (!out.includes(key) && out.length < MAX_ROW_AGENTS) out.push(key);
  return out;
}
function missingFromChannel(picked, members) {
  const inChannel = new Set(members);
  return [...new Set(picked.flat())].filter((key) => !inChannel.has(key));
}
function newlyAssigned(before, after) {
  const was = { agents: before?.agents ?? [], workstream_agents: before?.workstream_agents ?? {} };
  const names = [...new Set([...Object.keys(was.workstream_agents), ...Object.keys(after.workstream_agents)].map((name) => name.trim().toLowerCase()))];
  const out = /* @__PURE__ */ new Set();
  for (const rule_id of [void 0, ...names])
    for (const workstream of [void 0, ...names]) {
      const task = { ...rule_id !== void 0 && { rule_id }, workstream: workstream ?? null };
      const old = new Set(agentsFor(was, task));
      for (const key of agentsFor(after, task)) if (!old.has(key)) out.add(key);
    }
  return [...out];
}

// packages/core/src/ui/markdown.tsx
var SAFE_URL = /^https?:\/\//i;
function renderInline(text, keyPrefix = "i") {
  const nodes = [];
  const pattern = /(\\[\\`*_{}[\]()#+\-.!~|<>$])|(`[^`]+`)|(\*\*[^*]+\*\*)|(__[^_]+__)|(\*[^*\s][^*]*\*)|(\[[^\]]+\]\([^)\s]+\))|(https?:\/\/[^\s)<>]+)/g;
  let last = 0;
  let match;
  let index = 0;
  while (match = pattern.exec(text)) {
    if (match.index > last) nodes.push(text.slice(last, match.index));
    const token = match[0];
    const key = `${keyPrefix}-${index++}`;
    if (token.length === 2 && token.startsWith("\\")) nodes.push(token.slice(1));
    else if (token.startsWith("`")) nodes.push(/* @__PURE__ */ React.createElement("code", { key }, token.slice(1, -1)));
    else if (token.startsWith("**") || token.startsWith("__"))
      nodes.push(/* @__PURE__ */ React.createElement("strong", { key }, renderInline(token.slice(2, -2), key)));
    else if (token.startsWith("*")) nodes.push(/* @__PURE__ */ React.createElement("em", { key }, renderInline(token.slice(1, -1), key)));
    else if (token.startsWith("[")) {
      const label2 = token.slice(1, token.indexOf("]("));
      const href = token.slice(token.indexOf("](") + 2, -1);
      nodes.push(
        SAFE_URL.test(href) ? /* @__PURE__ */ React.createElement("a", { key, href, target: "_blank", rel: "noreferrer", className: "dbx-link" }, label2) : label2
      );
    } else
      nodes.push(
        /* @__PURE__ */ React.createElement("a", { key, href: token, target: "_blank", rel: "noreferrer", className: "dbx-link" }, token)
      );
    last = match.index + token.length;
  }
  if (last < text.length) nodes.push(text.slice(last));
  return nodes;
}
var cells = (line2) => line2.trim().replace(/^\|/, "").replace(/\|$/, "").split("|").map((cell) => cell.trim());
function parseBlocks(source) {
  const lines = source.replace(/\r\n?/g, "\n").split("\n");
  const blocks = [];
  let i = 0;
  while (i < lines.length) {
    const line2 = lines[i] ?? "";
    if (!line2.trim()) {
      i++;
      continue;
    }
    const fence = /^```(\S*)/.exec(line2);
    if (fence) {
      const body = [];
      i++;
      while (i < lines.length && !/^```/.test(lines[i] ?? "")) body.push(lines[i++] ?? "");
      i++;
      blocks.push({ type: "code", lang: fence[1] ?? "", code: body.join("\n") });
      continue;
    }
    const heading = /^(#{1,4})\s+(.*)$/.exec(line2);
    if (heading) {
      blocks.push({ type: "h", level: heading[1]?.length ?? 1, text: heading[2] ?? "" });
      i++;
      continue;
    }
    if (/^\s*\|.*\|\s*$/.test(line2) && /^\s*\|?\s*:?-{2,}/.test(lines[i + 1] ?? "")) {
      const header = cells(line2);
      const rows = [];
      i += 2;
      while (i < lines.length && /^\s*\|.*\|\s*$/.test(lines[i] ?? "")) rows.push(cells(lines[i++] ?? ""));
      blocks.push({ type: "table", header, rows });
      continue;
    }
    const bullet = /^\s*[-*+]\s+/;
    const ordered = /^\s*\d+[.)]\s+/;
    if (bullet.test(line2) || ordered.test(line2)) {
      const type = bullet.test(line2) ? "ul" : "ol";
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

// node_modules/@noble/hashes/utils.js
function isBytes(a) {
  return a instanceof Uint8Array || ArrayBuffer.isView(a) && a.constructor.name === "Uint8Array";
}
function abytes(value, length, title = "") {
  const bytes = isBytes(value);
  const len = value?.length;
  const needsLen = length !== void 0;
  if (!bytes || needsLen && len !== length) {
    const prefix = title && `"${title}" `;
    const ofLen = needsLen ? ` of length ${length}` : "";
    const got = bytes ? `length=${len}` : `type=${typeof value}`;
    throw new Error(prefix + "expected Uint8Array" + ofLen + ", got " + got);
  }
  return value;
}
var hasHexBuiltin = /* @__PURE__ */ (() => (
  // @ts-ignore
  typeof Uint8Array.from([]).toHex === "function" && typeof Uint8Array.fromHex === "function"
))();
var hexes = /* @__PURE__ */ Array.from({ length: 256 }, (_, i) => i.toString(16).padStart(2, "0"));
function bytesToHex(bytes) {
  abytes(bytes);
  if (hasHexBuiltin)
    return bytes.toHex();
  let hex = "";
  for (let i = 0; i < bytes.length; i++) {
    hex += hexes[bytes[i]];
  }
  return hex;
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
function hexToBytes(hex) {
  if (typeof hex !== "string")
    throw new Error("hex string expected, got " + typeof hex);
  if (hasHexBuiltin)
    return Uint8Array.fromHex(hex);
  const hl = hex.length;
  const al = hl / 2;
  if (hl % 2)
    throw new Error("hex string expected, got unpadded hex of length " + hl);
  const array = new Uint8Array(al);
  for (let ai = 0, hi = 0; ai < al; ai++, hi += 2) {
    const n1 = asciiToBase16(hex.charCodeAt(hi));
    const n2 = asciiToBase16(hex.charCodeAt(hi + 1));
    if (n1 === void 0 || n2 === void 0) {
      const char = hex[hi] + hex[hi + 1];
      throw new Error('hex string expected, got non-hex character "' + char + '" at index ' + hi);
    }
    array[ai] = n1 * 16 + n2;
  }
  return array;
}

// node_modules/@scure/base/index.js
function isBytes2(a) {
  return a instanceof Uint8Array || ArrayBuffer.isView(a) && a.constructor.name === "Uint8Array";
}
function isArrayOf(isString, arr) {
  if (!Array.isArray(arr))
    return false;
  if (arr.length === 0)
    return true;
  if (isString) {
    return arr.every((item) => typeof item === "string");
  } else {
    return arr.every((item) => Number.isSafeInteger(item));
  }
}
function afn(input) {
  if (typeof input !== "function")
    throw new Error("function expected");
  return true;
}
function astr(label2, input) {
  if (typeof input !== "string")
    throw new Error(`${label2}: string expected`);
  return true;
}
function anumber(n) {
  if (!Number.isSafeInteger(n))
    throw new Error(`invalid integer: ${n}`);
}
function aArr(input) {
  if (!Array.isArray(input))
    throw new Error("array expected");
}
function astrArr(label2, input) {
  if (!isArrayOf(true, input))
    throw new Error(`${label2}: array of strings expected`);
}
function anumArr(label2, input) {
  if (!isArrayOf(false, input))
    throw new Error(`${label2}: array of numbers expected`);
}
// @__NO_SIDE_EFFECTS__
function chain(...args) {
  const id = (a) => a;
  const wrap = (a, b) => (c) => a(b(c));
  const encode = args.map((x) => x.encode).reduceRight(wrap, id);
  const decode2 = args.map((x) => x.decode).reduce(wrap, id);
  return { encode, decode: decode2 };
}
// @__NO_SIDE_EFFECTS__
function alphabet(letters) {
  const lettersA = typeof letters === "string" ? letters.split("") : letters;
  const len = lettersA.length;
  astrArr("alphabet", lettersA);
  const indexes = new Map(lettersA.map((l, i) => [l, i]));
  return {
    encode: (digits) => {
      aArr(digits);
      return digits.map((i) => {
        if (!Number.isSafeInteger(i) || i < 0 || i >= len)
          throw new Error(`alphabet.encode: digit index outside alphabet "${i}". Allowed: ${letters}`);
        return lettersA[i];
      });
    },
    decode: (input) => {
      aArr(input);
      return input.map((letter) => {
        astr("alphabet.decode", letter);
        const i = indexes.get(letter);
        if (i === void 0)
          throw new Error(`Unknown letter: "${letter}". Allowed: ${letters}`);
        return i;
      });
    }
  };
}
// @__NO_SIDE_EFFECTS__
function join(separator = "") {
  astr("join", separator);
  return {
    encode: (from) => {
      astrArr("join.decode", from);
      return from.join(separator);
    },
    decode: (to) => {
      astr("join.decode", to);
      return to.split(separator);
    }
  };
}
var gcd = (a, b) => b === 0 ? a : gcd(b, a % b);
var radix2carry = /* @__NO_SIDE_EFFECTS__ */ (from, to) => from + (to - gcd(from, to));
var powers = /* @__PURE__ */ (() => {
  let res = [];
  for (let i = 0; i < 40; i++)
    res.push(2 ** i);
  return res;
})();
function convertRadix2(data, from, to, padding) {
  aArr(data);
  if (from <= 0 || from > 32)
    throw new Error(`convertRadix2: wrong from=${from}`);
  if (to <= 0 || to > 32)
    throw new Error(`convertRadix2: wrong to=${to}`);
  if (/* @__PURE__ */ radix2carry(from, to) > 32) {
    throw new Error(`convertRadix2: carry overflow from=${from} to=${to} carryBits=${/* @__PURE__ */ radix2carry(from, to)}`);
  }
  let carry = 0;
  let pos = 0;
  const max = powers[from];
  const mask = powers[to] - 1;
  const res = [];
  for (const n of data) {
    anumber(n);
    if (n >= max)
      throw new Error(`convertRadix2: invalid data word=${n} from=${from}`);
    carry = carry << from | n;
    if (pos + from > 32)
      throw new Error(`convertRadix2: carry overflow pos=${pos} from=${from}`);
    pos += from;
    for (; pos >= to; pos -= to)
      res.push((carry >> pos - to & mask) >>> 0);
    const pow = powers[pos];
    if (pow === void 0)
      throw new Error("invalid carry");
    carry &= pow - 1;
  }
  carry = carry << to - pos & mask;
  if (!padding && pos >= from)
    throw new Error("Excess padding");
  if (!padding && carry > 0)
    throw new Error(`Non-zero padding: ${carry}`);
  if (padding && pos > 0)
    res.push(carry >>> 0);
  return res;
}
// @__NO_SIDE_EFFECTS__
function radix2(bits, revPadding = false) {
  anumber(bits);
  if (bits <= 0 || bits > 32)
    throw new Error("radix2: bits should be in (0..32]");
  if (/* @__PURE__ */ radix2carry(8, bits) > 32 || /* @__PURE__ */ radix2carry(bits, 8) > 32)
    throw new Error("radix2: carry overflow");
  return {
    encode: (bytes) => {
      if (!isBytes2(bytes))
        throw new Error("radix2.encode input should be Uint8Array");
      return convertRadix2(Array.from(bytes), 8, bits, !revPadding);
    },
    decode: (digits) => {
      anumArr("radix2.decode", digits);
      return Uint8Array.from(convertRadix2(digits, bits, 8, revPadding));
    }
  };
}
function unsafeWrapper(fn) {
  afn(fn);
  return function(...args) {
    try {
      return fn.apply(null, args);
    } catch (e) {
    }
  };
}
var BECH_ALPHABET = /* @__PURE__ */ chain(/* @__PURE__ */ alphabet("qpzry9x8gf2tvdw0s3jn54khce6mua7l"), /* @__PURE__ */ join(""));
var POLYMOD_GENERATORS = [996825010, 642813549, 513874426, 1027748829, 705979059];
function bech32Polymod(pre) {
  const b = pre >> 25;
  let chk = (pre & 33554431) << 5;
  for (let i = 0; i < POLYMOD_GENERATORS.length; i++) {
    if ((b >> i & 1) === 1)
      chk ^= POLYMOD_GENERATORS[i];
  }
  return chk;
}
function bechChecksum(prefix, words, encodingConst = 1) {
  const len = prefix.length;
  let chk = 1;
  for (let i = 0; i < len; i++) {
    const c = prefix.charCodeAt(i);
    if (c < 33 || c > 126)
      throw new Error(`Invalid prefix (${prefix})`);
    chk = bech32Polymod(chk) ^ c >> 5;
  }
  chk = bech32Polymod(chk);
  for (let i = 0; i < len; i++)
    chk = bech32Polymod(chk) ^ prefix.charCodeAt(i) & 31;
  for (let v of words)
    chk = bech32Polymod(chk) ^ v;
  for (let i = 0; i < 6; i++)
    chk = bech32Polymod(chk);
  chk ^= encodingConst;
  return BECH_ALPHABET.encode(convertRadix2([chk % powers[30]], 30, 5, false));
}
// @__NO_SIDE_EFFECTS__
function genBech32(encoding) {
  const ENCODING_CONST = encoding === "bech32" ? 1 : 734539939;
  const _words = /* @__PURE__ */ radix2(5);
  const fromWords = _words.decode;
  const toWords = _words.encode;
  const fromWordsUnsafe = unsafeWrapper(fromWords);
  function encode(prefix, words, limit = 90) {
    astr("bech32.encode prefix", prefix);
    if (isBytes2(words))
      words = Array.from(words);
    anumArr("bech32.encode", words);
    const plen = prefix.length;
    if (plen === 0)
      throw new TypeError(`Invalid prefix length ${plen}`);
    const actualLength = plen + 7 + words.length;
    if (limit !== false && actualLength > limit)
      throw new TypeError(`Length ${actualLength} exceeds limit ${limit}`);
    const lowered = prefix.toLowerCase();
    const sum = bechChecksum(lowered, words, ENCODING_CONST);
    return `${lowered}1${BECH_ALPHABET.encode(words)}${sum}`;
  }
  function decode2(str, limit = 90) {
    astr("bech32.decode input", str);
    const slen = str.length;
    if (slen < 8 || limit !== false && slen > limit)
      throw new TypeError(`invalid string length: ${slen} (${str}). Expected (8..${limit})`);
    const lowered = str.toLowerCase();
    if (str !== lowered && str !== str.toUpperCase())
      throw new Error(`String must be lowercase or uppercase`);
    const sepIndex = lowered.lastIndexOf("1");
    if (sepIndex === 0 || sepIndex === -1)
      throw new Error(`Letter "1" must be present between prefix and data only`);
    const prefix = lowered.slice(0, sepIndex);
    const data = lowered.slice(sepIndex + 1);
    if (data.length < 6)
      throw new Error("Data must be at least 6 characters long");
    const words = BECH_ALPHABET.decode(data).slice(0, -6);
    const sum = bechChecksum(prefix, words, ENCODING_CONST);
    if (!data.endsWith(sum))
      throw new Error(`Invalid checksum in ${str}: expected "${sum}"`);
    return { prefix, words };
  }
  const decodeUnsafe = unsafeWrapper(decode2);
  function decodeToBytes(str) {
    const { prefix, words } = decode2(str, false);
    return { prefix, words, bytes: fromWords(words) };
  }
  function encodeFromBytes(prefix, bytes) {
    return encode(prefix, toWords(bytes));
  }
  return {
    encode,
    decode: decode2,
    encodeFromBytes,
    decodeToBytes,
    decodeUnsafe,
    fromWords,
    fromWordsUnsafe,
    toWords
  };
}
var bech32 = /* @__PURE__ */ genBech32("bech32");

// node_modules/nostr-tools/lib/esm/nip19.js
var utf8Decoder = new TextDecoder("utf-8");
var utf8Encoder = new TextEncoder();
var Bech32MaxSize = 5e3;
function decode(code) {
  let { prefix, words } = bech32.decode(code, Bech32MaxSize);
  let data = new Uint8Array(bech32.fromWords(words));
  switch (prefix) {
    case "nprofile": {
      let tlv = parseTLV(data);
      if (!tlv[0]?.[0])
        throw new Error("missing TLV 0 for nprofile");
      if (tlv[0][0].length !== 32)
        throw new Error("TLV 0 should be 32 bytes");
      return {
        type: "nprofile",
        data: {
          pubkey: bytesToHex(tlv[0][0]),
          relays: tlv[1] ? tlv[1].map((d) => utf8Decoder.decode(d)) : []
        }
      };
    }
    case "nevent": {
      let tlv = parseTLV(data);
      if (!tlv[0]?.[0])
        throw new Error("missing TLV 0 for nevent");
      if (tlv[0][0].length !== 32)
        throw new Error("TLV 0 should be 32 bytes");
      if (tlv[2] && tlv[2][0].length !== 32)
        throw new Error("TLV 2 should be 32 bytes");
      if (tlv[3] && tlv[3][0].length !== 4)
        throw new Error("TLV 3 should be 4 bytes");
      return {
        type: "nevent",
        data: {
          id: bytesToHex(tlv[0][0]),
          relays: tlv[1] ? tlv[1].map((d) => utf8Decoder.decode(d)) : [],
          author: tlv[2]?.[0] ? bytesToHex(tlv[2][0]) : void 0,
          kind: tlv[3]?.[0] ? parseInt(bytesToHex(tlv[3][0]), 16) : void 0
        }
      };
    }
    case "naddr": {
      let tlv = parseTLV(data);
      if (!tlv[0]?.[0])
        throw new Error("missing TLV 0 for naddr");
      if (!tlv[2]?.[0])
        throw new Error("missing TLV 2 for naddr");
      if (tlv[2][0].length !== 32)
        throw new Error("TLV 2 should be 32 bytes");
      if (!tlv[3]?.[0])
        throw new Error("missing TLV 3 for naddr");
      if (tlv[3][0].length !== 4)
        throw new Error("TLV 3 should be 4 bytes");
      return {
        type: "naddr",
        data: {
          identifier: utf8Decoder.decode(tlv[0][0]),
          pubkey: bytesToHex(tlv[2][0]),
          kind: parseInt(bytesToHex(tlv[3][0]), 16),
          relays: tlv[1] ? tlv[1].map((d) => utf8Decoder.decode(d)) : []
        }
      };
    }
    case "nsec":
      return { type: prefix, data };
    case "npub":
    case "note":
      return { type: prefix, data: bytesToHex(data) };
    default:
      throw new Error(`unknown prefix ${prefix}`);
  }
}
function parseTLV(data) {
  let result = {};
  let rest = data;
  while (rest.length > 0) {
    if (rest.length < 2)
      throw new Error("not enough data to read TLV");
    let t = rest[0];
    let l = rest[1];
    let v = rest.slice(2, 2 + l);
    rest = rest.slice(2 + l);
    if (v.length < l)
      throw new Error(`not enough data to read on TLV ${t}`);
    result[t] = result[t] || [];
    result[t].push(v);
  }
  return result;
}
function npubEncode(hex) {
  return encodeBytes("npub", hexToBytes(hex));
}
function encodeBech32(prefix, data) {
  let words = bech32.toWords(data);
  return bech32.encode(prefix, words, Bech32MaxSize);
}
function encodeBytes(prefix, bytes) {
  return encodeBech32(prefix, bytes);
}

// plugins/signals/src/posts.ts
var TASK_LINE = /^📌 \*\*Task (\d+): (.+)\*\*\s*$/u;
var REPLY_HERE = "Reply in this thread to work on it.";
var SOURCE_LAST_REPLY = "Reply in this thread to work on it. Agents update it with the signals_task tools.";
var NPUB = /nostr:npub1[02-9ac-hj-np-z]{58}/g;
var NAMED = /(?:nostr|agent|person):(npub1[02-9ac-hj-np-z]{58})/g;
var OPTIONS = /^Options: (.+)$/;
var CHANGE = /^- \*\*(.+?):\*\* (.*) → (.*)$/;
var TRIGGERED = /^\*\*Triggered:\*\* (.+)$/;
var UNTRIGGERED = /^No default action for .+ is triggered, so it's (?:(dismissed)\. It opens again if one is|(tracked) with no agent asked)\.$/;
var triggeredIn = (lines) => lines.flatMap((line2) => {
  const found = TRIGGERED.exec(line2.trim());
  if (!found) return [];
  const at = found[1].indexOf(" \u2014 ");
  return [at < 0 ? { label: found[1].trim() } : { label: found[1].slice(0, at).trim(), why: found[1].slice(at + 3).trim() }];
});
function untriggeredNote(post, now) {
  if (!post.untriggered || post.triggered.length) return void 0;
  return now?.status === "dismissed" && now.byDefaults ? "dismissed" : "opening";
}
var CHECKLIST_HEADS = ["**Action items from the notes for this follow-up** (not the account team's own tasks):", "The account team's items have their own tasks:"];
var isChecklist = (block) => CHECKLIST_HEADS.includes(block[0]) && block.length > 1 && block.every((line2) => CHECKLIST_HEADS.includes(line2) || line2.startsWith("- "));
function sourceEnd(lines, start, end) {
  let at = end;
  const blank = () => {
    while (at > start + 1 && !lines[at - 1].trim()) at--;
  };
  const paragraph = () => {
    let from2 = at;
    while (from2 > start + 1 && lines[from2 - 1].trim()) from2--;
    return from2;
  };
  blank();
  let from = paragraph();
  const block = lines.slice(from, at).map((line2) => line2.trim());
  if (block.length && (block.every((line2) => TRIGGERED.test(line2)) || block.length === 1 && UNTRIGGERED.test(block[0]))) at = from, blank(), from = paragraph();
  if (from < at && isChecklist(lines.slice(from, at).map((line2) => line2.trim()))) at = from, blank();
  return at;
}
var isTaskPost = (content) => TASK_LINE.test(content.split("\n", 1)[0] ?? "") && content.includes(REPLY_HERE);
var splitOptions = (text) => text.split(" / ").map((item) => item.trim()).filter(Boolean);
function parseTaskPost(content) {
  if (!isTaskPost(content)) return void 0;
  const lines = content.split("\n");
  const head = TASK_LINE.exec(lines[0]);
  const meta = {};
  let mode;
  let question;
  let options = [];
  let at = 1;
  for (; at < lines.length; at++) {
    const line2 = lines[at];
    if (!line2.trim() || line2.startsWith("**Source**") || line2.startsWith(REPLY_HERE)) break;
    const asked = /^⏸️ \*\*Needs input:\*\* (.+)$/u.exec(line2);
    if (asked) {
      question = asked[1].trim();
      const listed = OPTIONS.exec(lines[at + 1] ?? "");
      if (listed) options = splitOptions(listed[1]), at++;
      continue;
    }
    const moded = /^Mode: (\w+)/.exec(line2);
    if (moded) {
      mode = moded[1];
      continue;
    }
    for (const part of line2.split(" \xB7 ")) {
      const pair = /^(Account|Workstream|Initiative|Rule): (.+)$/.exec(part.trim());
      if (pair) meta[pair[1].toLowerCase()] = pair[2].trim();
    }
  }
  const start = lines.findIndex((line2) => line2.startsWith("**Source**"));
  const last = lines.findIndex((line2) => line2.trim() === SOURCE_LAST_REPLY);
  const end = last >= 0 ? last : lines.findIndex((line2) => line2.startsWith(REPLY_HERE));
  const title = head[2].trim();
  const sourceLast = last >= 0;
  const until = end > start ? end : lines.length;
  const read = start >= 0 ? parseSource(lines.slice(start, sourceLast ? until : sourceEnd(lines, start, until))) : void 0;
  const source = read && { ...read, facts: read.facts.filter((fact) => !title.toLowerCase().includes(fact.value.toLowerCase())) };
  const after = end >= 0 ? lines.slice(end + 1).join("\n") : "";
  const middle = lines.slice(at, sourceLast && start >= at ? start : end >= 0 ? end : void 0);
  const outcome = middle.map((line2) => UNTRIGGERED.exec(line2.trim())).find(Boolean);
  const untriggered = outcome ? outcome[1] ? "dismissed" : "tracked" : void 0;
  return {
    id: Number(head[1]),
    title,
    ...meta.account && { account: meta.account },
    ...meta.workstream && { workstream: meta.workstream },
    ...meta.initiative && { initiative: meta.initiative },
    ...meta.rule && { rule: meta.rule },
    ...mode && { mode },
    ...question && { question },
    options,
    ...source && { source },
    asksAgents: /nostr:npub1/.test(after),
    triggered: triggeredIn(middle),
    ...untriggered && { untriggered }
  };
}
var QUIET = /* @__PURE__ */ new Set(["channel_id", "context_before", "mimetype", "owners", "text", "from", "thread_ts", "ts", "message_ts", "status", "attendeecount", "recurringeventid", "id", "url", "link", "permalink", "user", "user_id"]);
var personName = (text) => /^\s*"?([^"<]+?)"?\s*<[^>]+>/.exec(text)?.[1]?.trim() ?? text.trim();
var label = (key) => {
  const words = key.replace(/([a-z])([A-Z])/g, "$1 $2").replace(/[_.-]+/g, " ").trim().toLowerCase();
  return words ? words[0].toUpperCase() + words.slice(1) : key;
};
function detailPairs(text) {
  return text.split(/;\s+(?=[A-Za-z_][\w.]*: )/).map((part) => /^([A-Za-z_][\w.]*): ([\s\S]*)$/.exec(part.trim())).filter((found) => Boolean(found)).map((found) => [found[1], found[2].trim()]);
}
function parseSource(lines) {
  const first = /^\*\*Source\*\* \(([^)]+)\)(?::\s*(\S+))?/.exec(lines[0] ?? "");
  if (!first) return void 0;
  const field = (name) => lines.find((line2) => line2.startsWith(`${name}: `))?.slice(name.length + 2).trim();
  const facts = [];
  const attendeesAt = lines.findIndex((line2) => /^Attendees \(\d+\):/.test(line2));
  if (attendeesAt >= 0) {
    const count = Number(/^Attendees \((\d+)\)/.exec(lines[attendeesAt])[1]);
    let customers = 0;
    let customerWord;
    for (const line2 of lines.slice(attendeesAt + 1)) {
      if (!line2.startsWith("- ")) break;
      const notes = /\(([^()]*)\)\s*$/.exec(line2)?.[1] ?? "";
      const first2 = notes.split(",")[0].trim();
      if (first2 && !/-domain address|organizer|accepted|declined|tentative/.test(first2)) customers++, customerWord ??= first2;
    }
    facts.push({ label: "Attendees", value: `${count}${customers ? ` \xB7 ${customers} ${customerWord}` : ""}` });
  }
  const detailsAt = lines.findIndex((line2) => line2.startsWith("Details: "));
  const details = detailsAt >= 0 ? detailPairs(lines.slice(detailsAt).join("\n").slice("Details: ".length)) : [];
  const detail = (key) => details.find(([name]) => name === key)?.[1];
  const quote = detail("text") ?? detail("snippet");
  const fromDetail = detail("from");
  const fromLine = field("From");
  const from = fromDetail && /</.test(fromDetail) ? personName(fromDetail) : fromLine && personName(fromLine);
  const channel = detail("channel");
  const whereLine = field("Where");
  for (const [key, value] of details) {
    if (facts.length >= 4) break;
    if (QUIET.has(key.toLowerCase()) || key === "channel" || key === "snippet") continue;
    if (!value || /^[[{]/.test(value) || value.length > 48 || /\n/.test(value) || value === "false" || value === "null") continue;
    facts.push({ label: label(key), value });
  }
  const when = field("When");
  const title = lines[1]?.startsWith("Title: ") ? lines[1].slice(7).trim() : void 0;
  return {
    kind: first[1],
    ...first[2] && { url: first[2] },
    ...title && { title },
    ...when && { when },
    ...from && { from },
    ...(channel || whereLine) && { where: channel ?? whereLine },
    ...quote && { quote: quote.length > 400 ? `${quote.slice(0, 399).trimEnd()}\u2026` : quote },
    facts
  };
}
function sourceName(kind) {
  const known = { slack: "Slack", gmail: "Gmail", google_calendar: "Calendar", google_drive: "Drive", jira: "Jira", atlassian: "Jira", agent: "Agent" };
  if (known[kind]) return known[kind];
  if (kind.startsWith("table.")) return label(kind.slice(6));
  return label(kind);
}
var MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
function shortWhen(when, now = /* @__PURE__ */ new Date()) {
  const zoned = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}:\d{2}) \S+ \(([^)]+)\)/.exec(when);
  if (zoned) return `${MONTHS[Number(zoned[2]) - 1]} ${Number(zoned[3])}, ${zoned[4]} ${zoned[5]}`;
  const allDay = /^(\d{4})-(\d{2})-(\d{2}) \(all day\)/.exec(when);
  if (allDay) return `${MONTHS[Number(allDay[2]) - 1]} ${Number(allDay[3])} (all day)`;
  const at = /^\d{4}-\d{2}-\d{2}T/.test(when) ? new Date(when) : void 0;
  if (!at || Number.isNaN(at.getTime())) return when.split(" \u2192 ")[0];
  const time = at.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  const sameDay = at.toDateString() === now.toDateString();
  return sameDay ? `Today, ${time}` : `${MONTHS[at.getMonth()]} ${at.getDate()}, ${time}`;
}
function humanPart(content) {
  const lines = content.split("\n");
  const at = lines.findIndex((line2, n) => n > 0 && /^nostr:npub1/.test(line2.trim()));
  const text = (at > 0 ? lines.slice(0, at) : lines).join("\n").trim();
  return { text, forAgents: at > 0 || /\*\*For agents:/.test(content) };
}
function parseThreadPost(content) {
  const lines = content.split("\n");
  const first = lines[0] ?? "";
  const asked = /^⏸️ \*\*Needs input\*\* \(asked by (.+?)\): (.+)$/u.exec(first);
  if (asked) {
    const listed = OPTIONS.exec(lines[1] ?? "");
    return { kind: "question", by: asked[1].trim(), question: asked[2].trim(), options: listed ? splitOptions(listed[1]) : [] };
  }
  const done = /^✅ Done: (.+?)\.?(?: \(Set its status on the Tasks board if it isn't\.\))?$/u.exec(first);
  if (done) return { kind: "done", reason: done[1].trim() };
  if (first.startsWith("\u23F0 ")) return { kind: "nudge", text: first.slice(2).trim() };
  const update = /^Update: (.+)$/.exec(first) ?? (TRIGGERED.test((lines[2] ?? "").trim()) ? /^↩️ Open again: (.+)$/u.exec(first) : null);
  if (update) {
    const link2 = /^\[(.+)\]\((\S+)\)$/.exec(update[1].trim());
    const changes = lines.slice(1).map((line2) => CHANGE.exec(line2)).filter((found) => Boolean(found)).map((found) => ({ field: found[1], from: found[2], to: found[3] }));
    const human = humanPart(content);
    const shown = human.text.split("\n");
    const more = shown.slice(1).some((line2) => line2.trim() && !TRIGGERED.test(line2.trim()) && !CHANGE.test(line2));
    return { kind: "update", title: link2 ? link2[1] : update[1].trim(), ...link2 && { url: link2[2] }, changes, triggered: triggeredIn(shown), forAgents: human.forAgents, ...more && { more: true }, ...!first.startsWith("Update:") && { reopened: true } };
  }
  const answered = /^(?:nostr:npub1\S+\s+)*(.+?) answered: (.+)$/.exec(first);
  if (answered) {
    const quoted = lines.find((line2) => line2.startsWith("> "))?.slice(2).trim();
    return { kind: "answered", who: answered[1].trim(), answer: answered[2].trim(), ...quoted && { question: quoted }, forAgents: /^nostr:npub1/.test(first) };
  }
  const status2 = /^(.+?) set this to \*\*(\w[\w ]*)\*\*/.exec(first);
  if (status2 && lines.length === 1) return { kind: "status", text: first };
  if (first.startsWith("\u{1F464} ")) {
    const part = humanPart(content);
    return { kind: "assigned", text: part.text.slice(2).trim(), forAgents: part.forAgents };
  }
  const ask = /^((?:nostr:npub1\S+\s*)+)(.+?)(?::| asked you to work on this task)/.exec(first);
  if (ask && /work on this task|no agent has worked on this task|you've been named|you've been added/.test(first)) {
    const asker = /^(?:nostr:npub1\S+\s*)+(.+?) asked you to work on this task/.exec(first)?.[1];
    return { kind: "asked", text: asker ? `${asker} asked agents to work on it` : "Agents were asked to work on it", forAgents: true };
  }
  return void 0;
}
function plainLine(text, name = () => void 0) {
  return text.split("\n").filter((line2) => !/^\s*(?:```|~~~)/.test(line2)).map((line2) => line2.replace(/^\s{0,3}(?:#{1,6}\s+|>\s?|[-*+]\s+(?:\[[ xX]\]\s+)?|\d+[.)]\s+)/, "")).join(" ").replace(/!?\[([^\]\n]*)\]\([^)\s]*(?:\s+"[^"]*")?\)?/g, "$1").replace(/<((?:https?|mailto):[^>\s]+)>/g, "$1").replace(NAMED, (_found, npub) => `@${name(npub) ?? `${npub.slice(0, 12)}\u2026`}`).replace(/`([^`]+)`/g, "$1").replace(/(\*\*|__|~~)(?=\S)(.+?)(?<=\S)\1/g, "$2").replace(/(^|[^\w*])\*(?=\S)([^*]+?)(?<=\S)\*(?!\w)/g, "$1$2").replace(/\*\*/g, "").replace(/\s+/g, " ").trim();
}
var mentionedNpubs = (content) => [...new Set((content.match(NPUB) ?? []).map((found) => found.slice(6)))];
var taskTarget = (channel, id) => `signals-task:${channel}:${id}`;
function readTaskTarget(target) {
  const found = /^signals-task:([^:\s]+):(\d+)$/.exec(target);
  return found ? { channel: found[1], id: Number(found[2]) } : void 0;
}

// plugins/signals/src/board-view.ts
var VIEWS = ["list", "swimlanes", "filtered"];
var STATUS_GROUPS = [
  { status: "waiting", title: "Needs input" },
  { status: "open", title: "Open" },
  { status: "in_progress", title: "In progress" },
  { status: "done", title: "Done" },
  { status: "dismissed", title: "Dismissed" }
];
var postWeight = (status2) => status2 === "dismissed" ? "folded" : status2 === "done" ? "quiet" : "full";
var ownersOf = (item) => item.people.filter((person) => person.on && person.role === "owner" && (person.kind === "agent" || person.kind === "person"));
var removable = (item) => item.people.filter((person) => person.on && (person.kind === "agent" || person.kind === "person"));
function assigneeOf(item) {
  const open = item.task.status !== "done" && item.task.status !== "dismissed";
  if (open && item.task.question) return { kind: "you" };
  const owner = ownersOf(item)[0];
  if (owner) return { kind: owner.kind, key: owner.key, label: owner.label };
  const agents = item.people.filter((person) => person.kind === "agent");
  const agent = agents.find((person) => person.role === "replied") ?? agents[0];
  return agent ? { kind: "agent", key: agent.key, label: agent.label } : { kind: "unassigned" };
}
var assigneeValue = (assignee) => assignee.kind === "agent" ? `agent:${assignee.key}` : assignee.kind === "person" ? `person:${assignee.key}` : assignee.kind;
function memberChoices(members, boardAgents, owners2, profile, viewer) {
  const taken = new Set(owners2);
  const agents = new Set(boardAgents);
  return [.../* @__PURE__ */ new Set([...members, ...boardAgents])].filter((key) => !taken.has(key)).map((key) => {
    const found = profile(key);
    return { key, name: key === viewer ? `${found?.name ?? "You"} (you)` : found?.name ?? `${key.slice(0, 8)}\u2026`, agent: Boolean(found?.agent) || agents.has(key) };
  }).sort((a, b) => Number(b.agent) - Number(a.agent) || a.name.localeCompare(b.name));
}
function filterTasks(tasks, filters) {
  const words = (filters.search ?? "").toLowerCase().split(/\s+/).filter(Boolean);
  return tasks.filter((item) => {
    const { task } = item;
    if (filters.status && task.status !== filters.status) return false;
    if (filters.workstream && (task.workstream ?? "") !== (filters.workstream === NONE ? "" : filters.workstream)) return false;
    if (filters.mode && task.mode !== filters.mode) return false;
    if (filters.assignee && assigneeValue(assigneeOf(item)) !== filters.assignee) return false;
    if (!words.length) return true;
    const haystack = [`#${task.id}`, task.title, task.workstream, task.initiative, item.source?.source, item.source?.title, item.origin?.title, item.origin?.external_id, taskOrigin(task.title, item.origin).ref].filter(Boolean).join(" ").toLowerCase();
    return words.every((word) => haystack.includes(word));
  });
}
var squash = (text) => text.replace(/\s+/g, " ").trim().toLowerCase();
var TICKET = /^[A-Z][A-Z0-9]+-\d+$/;
function taskOrigin(title, origin) {
  if (!origin) return {};
  const own = origin.title?.replace(/\s+/g, " ").trim();
  const original = own && !squash(title).includes(squash(own)) ? own : void 0;
  const linked = origin.url && /\/browse\/([A-Z][A-Z0-9]+-\d+)(?:[/?#]|$)/.exec(origin.url)?.[1];
  const ref = linked || (origin.external_id && TICKET.test(origin.external_id) ? origin.external_id : void 0);
  const said = ref && title.split(/[^A-Za-z0-9-]+/).includes(ref);
  return { ...original && { original }, ...ref && !said && { ref } };
}
function openingTitle(item) {
  const origin = item.origin ?? void 0;
  const { original } = taskOrigin(item.task.title, origin);
  if (!original || !origin) return void 0;
  const latest = item.source;
  if (latest && latest.source === origin.source && (latest.url ?? "") === (origin.url ?? "") && latest.title && squash(latest.title) === squash(original)) return void 0;
  return { source: origin.source, title: original, ...origin.url && { url: origin.url } };
}
function filedHint(task) {
  if (task.filed_by === "match") return "Matched a category rule";
  if (task.filed_by !== "classifier") return void 0;
  const score = typeof task.filed_score === "number" && Number.isFinite(task.filed_score) ? ` (${Math.round(Math.min(1, Math.max(0, task.filed_score)) * 100)}%)` : "";
  return `Picked by the classifier${score}`;
}
function workstreamHint(task) {
  if (!task.workstream) return void 0;
  const filed = filedHint(task);
  return filed ? `${task.workstream}
${filed}` : task.workstream;
}
function titleHint(title, origin) {
  const { original } = taskOrigin(title, origin);
  return original && origin ? `${title}
From ${sourceName(origin.source)}: ${original}` : title;
}
function postOrigin(source, live) {
  if (!source) return void 0;
  const same = live && live.source === source.kind && (!source.url || !live.url || live.url === source.url) ? live : void 0;
  const title = source.title ?? same?.title;
  const url = source.url ?? same?.url;
  return { source: source.kind, ...same?.external_id && { external_id: same.external_id }, ...title && { title }, ...url && { url } };
}
var NONE = "(none)";
function filterOptions(tasks) {
  const count = (map, value, extra) => {
    const found = map.get(value);
    if (found) found.count++;
    else map.set(value, { value, count: 1, ...extra });
  };
  const workstreams = /* @__PURE__ */ new Map();
  const modes = /* @__PURE__ */ new Map();
  const assignees = /* @__PURE__ */ new Map();
  for (const item of tasks) {
    count(workstreams, item.task.workstream ?? NONE, {});
    count(modes, item.task.mode, {});
    const assignee = assigneeOf(item);
    count(assignees, assigneeValue(assignee), { assignee });
  }
  const order = { you: 0, person: 1, agent: 2, unassigned: 3 };
  return {
    workstreams: [...workstreams.values()].sort((a, b) => a.value === NONE ? 1 : b.value === NONE ? -1 : a.value.localeCompare(b.value)),
    modes: [...modes.values()].sort((a, b) => a.value.localeCompare(b.value)),
    assignees: [...assignees.values()].sort((a, b) => order[a.assignee.kind] - order[b.assignee.kind] || a.value.localeCompare(b.value))
  };
}
function byStatus(tasks) {
  const out = new Map(STATUS_GROUPS.map((group) => [group.status, []]));
  for (const item of tasks) out.get(item.task.status)?.push(item);
  return out;
}
var cardAssets = (item) => item.artifacts.filter((artifact) => /^https?:/.test(artifact.url) && !["reply", "draft", "workspace"].includes(artifact.kind));
var readView = (value) => VIEWS.includes(value) ? value : "list";
var MENTION = /nostr:(npub1[02-9ac-hj-np-z]{58})/g;
function mentionedKeys(text, decode2) {
  const keys = [...text.matchAll(MENTION)].map((match) => decode2(match[1])).filter((key) => Boolean(key));
  return [...new Set(keys)];
}
function withMentionNames(text, decode2, name) {
  return text.replace(MENTION, (whole, npub) => {
    const key = decode2(npub);
    if (!key) return whole;
    return `**@${name(key) ?? `${npub.slice(0, 12)}\u2026`}**`;
  });
}
function threadComments(messages) {
  return messages.filter((message) => message.content.trim()).map((message) => ({ id: message.id, author: message.authorId, at: message.createdAt, text: message.content, agents: message.audience === "agents", pending: message.delivery === "sending", failed: message.delivery === "failed" })).sort((a, b) => a.at - b.at);
}
var replyMentions = (assignee) => assignee.kind === "agent" ? [assignee.key] : [];
function replyText(text, mentions) {
  const body = text.trim();
  return mentions.length ? `${mentions.map((mention) => `nostr:${mention.npub}`).join(" ")} ${body}` : body;
}
function taskFacts(item, now = Date.now() / 1e3) {
  const { task } = item;
  const utc = (seconds) => new Date(seconds * 1e3).toISOString().slice(0, 16).replace("T", " ") + " UTC";
  const local = (seconds) => {
    const at = new Date(seconds * 1e3);
    const sameYear = at.getFullYear() === new Date(now * 1e3).getFullYear();
    return at.toLocaleString([], { month: "short", day: "numeric", ...!sameYear && { year: "numeric" }, hour: "numeric", minute: "2-digit" });
  };
  const ahead = task.last_event_at > now;
  return [
    { label: "Mode", value: MODE_NAMES[task.mode]?.name ?? task.mode, ...MODE_NAMES[task.mode] && { title: MODE_NAMES[task.mode].title } },
    ...task.workstream ? [{ label: "Workstream", value: task.workstream, ...filedHint(task) && { note: filedHint(task) } }] : [],
    ...task.initiative ? [{ label: "Initiative", value: task.initiative }] : [],
    ...task.account ? [{ label: "Account", value: task.account }] : [],
    { label: "Opened", value: local(task.created_at), title: utc(task.created_at) },
    { label: ahead ? "Starts" : "Last event", value: `${local(task.last_event_at)}${!ahead && task.event_count > 1 ? ` \xB7 ${task.event_count} events` : ""}`, title: utc(task.last_event_at) }
  ];
}
var MODE_NAMES = {
  auto: { name: "Auto", title: "Agents do it and report" },
  draft: { name: "Draft", title: "Agents prepare it, a person sends it" },
  ask: { name: "Ask", title: "Agents ask before doing anything" },
  off: { name: "Off", title: "Agents leave it alone" }
};
function taskActivity(comments, fold = 3) {
  const first = comments[0];
  const opened = first && parseTaskPost(first.text);
  const hub2 = opened ? first.author : void 0;
  const out = [];
  let run = [];
  const flush = () => {
    if (run.length > fold) out.push({ kind: "lines", lines: run });
    else out.push(...run);
    run = [];
  };
  comments.forEach((comment, at) => {
    if (at === 0 && opened) return void run.push({ kind: "opened", comment, post: opened });
    const post = hub2 && comment.author === hub2 ? parseThreadPost(comment.text) : void 0;
    if (post) return void run.push({ kind: "event", comment, post });
    if (comment.agents) return void run.push({ kind: "note", comment });
    flush();
    out.push({ kind: "comment", comment });
  });
  flush();
  return out;
}
function filteredWhy(event) {
  const percent = (n) => `${Math.round(n * 100)}%`;
  const score = `scored ${percent(event.score)}${event.min !== void 0 ? `, needed ${percent(event.min)}` : ""}`;
  return `${event.rule}: ${score}${event.question ? ` on \u201C${event.question}\u201D` : ""}`;
}
function filterFiltered(events, search) {
  const words = (search ?? "").toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return [...events];
  return events.filter((event) => {
    const text = [event.title, event.actor, event.source, event.rule, event.account].filter(Boolean).join(" ").toLowerCase();
    return words.every((word) => text.includes(word));
  });
}

// plugins/signals/src/board-panel.tsx
var NO_RELAY = {};
var readRelay = (relay) => {
  try {
    return relay?.snapshot() ?? NO_RELAY;
  } catch {
    return NO_RELAY;
  }
};
function useRelay(ctx) {
  const relay = optionalService(ctx, "relay");
  const [held, setHeld] = React.useState(() => readRelay(relay));
  React.useEffect(() => {
    const update = () => setHeld((previous) => {
      const next = readRelay(relay);
      const same = next.session === previous.session && next.generation === previous.generation && next.viewer === previous.viewer && next.origin === previous.origin;
      return same ? previous : next;
    });
    update();
    try {
      return relay?.subscribe?.(update);
    } catch {
      return void 0;
    }
  }, [relay]);
  return held;
}
function useProfiles(ctx, keys) {
  const session = useRelay(ctx).session;
  const profiles = session?.profiles;
  const [, bump] = React.useReducer((n) => n + 1, 0);
  React.useEffect(() => profiles ? profiles.subscribe(bump) : void 0, [profiles]);
  const wanted = keys.join(",");
  React.useEffect(() => {
    if (!profiles || !keys.length) return;
    const limit = Math.max(1, profiles.limit?.() ?? 200);
    for (let start = 0; start < keys.length; start += limit) {
      try {
        void profiles.ensure(keys.slice(start, start + limit)).catch(() => {
        });
      } catch {
      }
    }
  }, [profiles, wanted]);
  return (key) => {
    let found;
    try {
      found = profiles?.snapshot().get(key);
    } catch {
      return void 0;
    }
    if (!found) return void 0;
    let picture = found.picture;
    try {
      if (picture && session?.media) picture = session.media(picture, "small") ?? picture;
    } catch {
    }
    return { ...found.name && { name: found.name }, ...picture && { picture }, ...found.isAgent && { agent: true } };
  };
}
var NO_MEMBERS = [];
function useMembers(ctx, channel) {
  const channels = useRelay(ctx).session?.channels;
  const [, bump] = React.useReducer((n) => n + 1, 0);
  React.useEffect(() => channels?.subscribeList ? channels.subscribeList(bump) : void 0, [channels]);
  React.useEffect(() => {
    if (!channel || !channels?.resolve) return;
    try {
      void channels.resolve([channel]).then(bump, () => {
      });
    } catch {
    }
  }, [channels, channel]);
  try {
    return channel && channels?.get?.(channel)?.members || NO_MEMBERS;
  } catch {
    return NO_MEMBERS;
  }
}
var npubKey = (npub) => {
  try {
    const found = decode(npub);
    return found.type === "npub" ? found.data : void 0;
  } catch {
    return void 0;
  }
};
var npubOf = (key) => {
  try {
    return npubEncode(key);
  } catch {
    return key;
  }
};
var initials = (label2) => label2.replace(/[^\p{L}\p{N} ]/gu, "").split(/\s+/).filter(Boolean).slice(0, 2).map((word) => word[0].toUpperCase()).join("") || "?";
var assigneeName = (assignee, profile) => assignee.kind === "you" ? "You" : assignee.kind === "unassigned" ? "Unassigned" : profile(assignee.key)?.name ?? assignee.label;
var nameOf = (person, profile) => profile(person.key)?.name ?? person.label;
function AssigneeMark(props) {
  const size = props.size ?? 20;
  const name = assigneeName(props.assignee, props.profile);
  const title = props.assignee.kind === "you" ? "You: it needs your input" : props.assignee.kind === "agent" ? `${name} (agent)` : props.assignee.kind === "person" ? name : "Unassigned";
  const base = { width: size, height: size, flex: "none", boxSizing: "border-box", display: "inline-flex", alignItems: "center", justifyContent: "center", fontSize: Math.round(size * 0.42), fontWeight: 600 };
  if (props.assignee.kind === "unassigned") return /* @__PURE__ */ React.createElement("span", { title, "aria-label": title, style: { ...base, borderRadius: 999, border: "1.5px dashed var(--dbx-border-strong)" } });
  if (props.assignee.kind === "you") return /* @__PURE__ */ React.createElement("span", { title, "aria-label": title, style: { ...base, borderRadius: 999, background: "var(--dbx-warning)", color: "var(--dbx-surface)" } }, "!");
  const picture = props.profile(props.assignee.key)?.picture;
  const style = { ...base, borderRadius: props.assignee.kind === "person" ? 999 : 5, border: "1px solid var(--dbx-border)" };
  return picture ? /* @__PURE__ */ React.createElement("img", { src: picture, alt: name, title, style: { ...style, objectFit: "cover" } }) : /* @__PURE__ */ React.createElement("span", { title, "aria-label": title, style: { ...style, background: "var(--dbx-brand-tint)", color: "var(--dbx-subtle)" } }, initials(name));
}
function StatusIcon(props) {
  const size = props.size ?? 13;
  const color = { open: "var(--dbx-tertiary)", in_progress: "var(--dbx-warning)", waiting: "var(--dbx-danger)", done: "var(--dbx-success)", dismissed: "var(--dbx-tertiary)" }[props.status] ?? "var(--dbx-tertiary)";
  const fill = props.status === "in_progress" ? `conic-gradient(${color} 0 50%, transparent 50% 100%)` : props.status === "done" ? color : "transparent";
  const label2 = STATUS_GROUPS.find((group) => group.status === props.status)?.title ?? props.status;
  return /* @__PURE__ */ React.createElement("span", { title: label2, "aria-label": label2, style: { width: size, height: size, flex: "none", boxSizing: "border-box", borderRadius: 999, border: `1.5px ${props.status === "waiting" ? "dotted" : "solid"} ${color}`, background: fill, display: "inline-flex", alignItems: "center", justifyContent: "center", color: "var(--dbx-surface)", fontSize: size * 0.6, lineHeight: 1 } }, props.status === "done" ? "\u2713" : props.status === "dismissed" ? /* @__PURE__ */ React.createElement("span", { style: { color, fontSize: size * 0.7 } }, "\xD7") : null);
}
function Chip(props) {
  const color = props.tone === "brand" ? "var(--dbx-lava-text)" : props.tone === "success" ? "var(--dbx-success)" : "var(--dbx-subtle)";
  return /* @__PURE__ */ React.createElement("span", { title: props.title, style: { display: "inline-flex", alignItems: "center", padding: "0 6px", borderRadius: 4, border: "1px solid var(--dbx-border)", fontSize: "0.6875rem", lineHeight: "18px", color, whiteSpace: "nowrap", maxWidth: 160, overflow: "hidden", textOverflow: "ellipsis" } }, props.children);
}
var ASSET_ICON = { doc: "\u{1F4C4}", sheet: "\u{1F4CA}", slides: "\u{1F4FD}", form: "\u{1F4DD}", drive: "\u{1F4C1}", pr: "\u21C4", issue: "\u25CE", code: "</>", app: "\u25A3", dashboard: "\u{1F4C8}", notebook: "\u{1F4D3}", slack: "#", link: "\u{1F517}" };
var shorten = (text, most) => text.length > most ? `${text.slice(0, most - 1)}\u2026` : text;
var link = (url) => (event) => (event.preventDefault(), event.stopPropagation(), openExternal(url));
function AddAgent(props) {
  const [open, setOpen] = React.useState(false);
  const [agent, setAgent] = React.useState("");
  const [note, setNote] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState();
  if (!open) return /* @__PURE__ */ React.createElement(Button, { size: "sm", disabled: !props.task.thread, title: props.task.thread ? "Ask an agent to work on it in its thread" : "Not posted in Buzz yet", onClick: () => setOpen(true) }, "Add agent");
  const add = async () => {
    setBusy(true);
    setError(void 0);
    try {
      await props.hub.updateTask({ id: props.task.task.id, agents: agent.split(/[,\s]+/).filter(Boolean), ...note.trim() && { note: note.trim() } });
      setOpen(false);
      setAgent("");
      setNote("");
      props.onDone();
    } catch (problem) {
      setError(describeError(problem));
    } finally {
      setBusy(false);
    }
  };
  return /* @__PURE__ */ React.createElement(Stack, { gap: 6, style: { width: "100%" } }, /* @__PURE__ */ React.createElement("input", { className: "dbx-input", placeholder: "Agent npub1\u2026 (a member of this channel)", value: agent, onChange: (event) => setAgent(event.target.value) }), /* @__PURE__ */ React.createElement("input", { className: "dbx-input", placeholder: "What to do (optional)", value: note, onChange: (event) => setNote(event.target.value) }), error && /* @__PURE__ */ React.createElement(Text, { size: "xs", tone: "danger" }, error), /* @__PURE__ */ React.createElement(Stack, { direction: "row", gap: 6 }, /* @__PURE__ */ React.createElement(Button, { size: "sm", variant: "brand", disabled: busy || !agent.trim(), onClick: () => void add() }, busy ? /* @__PURE__ */ React.createElement(Spinner, { size: 10 }) : null, "Ask"), /* @__PURE__ */ React.createElement(Button, { size: "sm", onClick: () => setOpen(false) }, "Cancel")));
}
function Owners(props) {
  const { item } = props;
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState();
  const [picked, setPicked] = React.useState();
  const closed2 = item.task.status === "done" || item.task.status === "dismissed";
  const owners2 = ownersOf(item);
  const helpers = removable(item).filter((person) => person.role !== "owner");
  const choices = memberChoices(props.members, props.boardAgents, owners2.map((owner) => owner.key), props.profile, props.viewer);
  const run = async (input) => {
    setBusy(true);
    setError(void 0);
    try {
      await props.hub.updateTask({ id: item.task.id, ...input });
      setPicked(void 0);
      props.onChange();
    } catch (problem) {
      setError(describeError(problem));
    } finally {
      setBusy(false);
    }
  };
  const asOwner = (member) => ({ key: member.key, kind: member.agent ? "agent" : "person" });
  const off = (person) => ({ key: person.key, kind: person.kind });
  const pick = (key) => {
    const member = choices.find((choice) => choice.key === key);
    if (!member) return;
    if (!owners2.length) void run({ assign: [asOwner(member)] });
    else setPicked(member);
  };
  const row = (person, owner) => /* @__PURE__ */ React.createElement(Stack, { key: `${person.kind}:${person.key}`, direction: "row", gap: 8, align: "center" }, /* @__PURE__ */ React.createElement(AssigneeMark, { assignee: { kind: person.kind, key: person.key, label: person.label }, profile: props.profile }), /* @__PURE__ */ React.createElement(Text, { size: "sm", style: { flex: "1 1 auto", minWidth: 0, overflow: "hidden", textOverflow: "ellipsis" } }, nameOf(person, props.profile), !owner && /* @__PURE__ */ React.createElement("span", { style: { color: "var(--dbx-tertiary)" } }, " \xB7 ", person.role)), !closed2 && /* @__PURE__ */ React.createElement("button", { type: "button", className: "dbx-input", disabled: busy, title: person.kind === "agent" ? "Take it off this task: it's told in the thread to stop" : "Take them off this task", "aria-label": `Take ${nameOf(person, props.profile)} off`, onClick: () => void run({ unassign: [off(person)] }), style: { width: "auto", padding: "0 6px", lineHeight: 1.4, cursor: "pointer" } }, "\xD7"));
  return /* @__PURE__ */ React.createElement(Stack, { gap: 6 }, /* @__PURE__ */ React.createElement(Text, { size: "xs", tone: "tertiary", weight: 600 }, "OWNERS"), item.task.question && !closed2 && !props.compact && /* @__PURE__ */ React.createElement(Stack, { direction: "row", gap: 8, align: "center" }, /* @__PURE__ */ React.createElement(AssigneeMark, { assignee: { kind: "you" }, profile: props.profile }), /* @__PURE__ */ React.createElement(Text, { size: "sm" }, "Waiting on your input")), owners2.length ? owners2.map((person) => row(person, true)) : /* @__PURE__ */ React.createElement(Text, { size: "xs", tone: "subtle" }, "No one", helpers.length ? "; agents asked are below" : "", "."), helpers.length > 0 && helpers.map((person) => row(person, false)), !closed2 && !picked && /* @__PURE__ */ React.createElement("select", { className: "dbx-input", "aria-label": "Assign", disabled: busy || !choices.length, value: "", onChange: (event) => pick(event.target.value), style: { fontSize: "0.75rem" } }, /* @__PURE__ */ React.createElement("option", { value: "" }, choices.length ? "Assign to\u2026" : "No channel members to assign"), choices.map((member) => /* @__PURE__ */ React.createElement("option", { key: member.key, value: member.key }, member.agent ? "\u{1F916} " : "", member.name))), picked && /* @__PURE__ */ React.createElement(Stack, { gap: 6 }, /* @__PURE__ */ React.createElement(Text, { size: "xs" }, "Assign ", picked.name, ":"), /* @__PURE__ */ React.createElement(Stack, { direction: "row", gap: 6, wrap: true }, /* @__PURE__ */ React.createElement(Button, { size: "sm", variant: "brand", disabled: busy, title: "Take the current owners off and assign them", onClick: () => void run({ assign: [asOwner(picked)], unassign: owners2.map(off) }) }, "Reassign"), /* @__PURE__ */ React.createElement(Button, { size: "sm", disabled: busy, title: "Keep the current owners", onClick: () => void run({ assign: [asOwner(picked)] }) }, "Add"), /* @__PURE__ */ React.createElement(Button, { size: "sm", disabled: busy, onClick: () => setPicked(void 0) }, "Cancel"))), busy && /* @__PURE__ */ React.createElement(Spinner, { size: 10 }), error && /* @__PURE__ */ React.createElement(Text, { size: "xs", tone: "danger" }, error));
}
function ProvideInput(props) {
  const { task } = props.task;
  const [open, setOpen] = React.useState(Boolean(props.startOpen));
  const [text, setText] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState();
  if (!task.question) return null;
  const send = async (answer) => {
    if (!answer.trim()) return;
    setBusy(true);
    setError(void 0);
    try {
      await props.hub.updateTask({ id: task.id, input: answer.trim() });
      setOpen(false);
      setText("");
      props.onDone();
    } catch (problem) {
      setError(describeError(problem));
    } finally {
      setBusy(false);
    }
  };
  return /* @__PURE__ */ React.createElement("div", { style: { borderLeft: "3px solid var(--dbx-warning, var(--dbx-brand))", paddingLeft: 8 } }, /* @__PURE__ */ React.createElement(Stack, { gap: 6 }, /* @__PURE__ */ React.createElement(Text, { size: "xs", weight: 600 }, "Needs input"), /* @__PURE__ */ React.createElement(Text, { size: "sm" }, task.question), !open ? /* @__PURE__ */ React.createElement(Button, { size: "sm", variant: "brand", onClick: () => setOpen(true) }, "Provide input") : /* @__PURE__ */ React.createElement(Stack, { gap: 6 }, (task.options ?? []).length > 0 && /* @__PURE__ */ React.createElement(Stack, { direction: "row", gap: 6, wrap: true }, task.options.map((option) => /* @__PURE__ */ React.createElement(Button, { key: option, size: "sm", disabled: busy, onClick: () => void send(option) }, option))), /* @__PURE__ */ React.createElement("textarea", { className: "dbx-input", rows: 2, placeholder: (task.options ?? []).length ? "Or write your answer" : "Your answer", value: text, onChange: (event) => setText(event.target.value) }), error && /* @__PURE__ */ React.createElement(Text, { size: "xs", tone: "danger" }, error), /* @__PURE__ */ React.createElement(Stack, { direction: "row", gap: 6 }, /* @__PURE__ */ React.createElement(Button, { size: "sm", variant: "brand", disabled: busy || !text.trim(), onClick: () => void send(text) }, busy ? /* @__PURE__ */ React.createElement(Spinner, { size: 10 }) : null, "Send"), /* @__PURE__ */ React.createElement(Button, { size: "sm", onClick: () => setOpen(false) }, "Cancel")))));
}
function TaskBody(props) {
  const { item } = props;
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState();
  const setStatus = async (status2) => {
    setBusy(true);
    setError(void 0);
    try {
      await props.hub.updateTask({ id: item.task.id, status: status2 });
      props.onChange();
    } catch (problem) {
      setError(describeError(problem));
    } finally {
      setBusy(false);
    }
  };
  const closed2 = item.task.status === "done" || item.task.status === "dismissed";
  const assets = item.artifacts.filter((artifact) => /^https?:/.test(artifact.url) && artifact.kind !== "workspace");
  return /* @__PURE__ */ React.createElement(Stack, { gap: 8, style: { paddingTop: 8 } }, item.task.question && !closed2 && /* @__PURE__ */ React.createElement(ProvideInput, { hub: props.hub, task: item, onDone: props.onChange }), props.assigning && /* @__PURE__ */ React.createElement(Owners, { hub: props.hub, item, ...props.assigning, onChange: props.onChange, compact: true }), item.source?.title && /* @__PURE__ */ React.createElement(Text, { size: "xs", tone: "subtle" }, "From ", sourceName(item.source.source), ": ", item.source.url ? /* @__PURE__ */ React.createElement("a", { className: "dbx-link", href: item.source.url, onClick: link(item.source.url) }, item.source.title) : item.source.title), item.activity && /* @__PURE__ */ React.createElement(Text, { size: "xs", tone: "subtle" }, item.activity.kind === "agent_reply" ? "Agent: " : "", shorten(plainLine(item.activity.text, (npub) => props.assigning?.profile(npubKey(npub) ?? "")?.name), 280), " ", /* @__PURE__ */ React.createElement("span", { style: { color: "var(--dbx-tertiary)" } }, "\xB7 ", ago(item.activity.at * 1e3))), assets.length > 0 && /* @__PURE__ */ React.createElement(Stack, { direction: "row", gap: 6, wrap: true }, assets.map((artifact) => /* @__PURE__ */ React.createElement("a", { className: "dbx-link", key: `${artifact.at}:${artifact.url}`, href: artifact.url, onClick: link(artifact.url), title: artifact.url, style: { fontSize: "0.75rem" } }, ASSET_ICON[artifact.kind] ?? "\u{1F517}", " ", artifact.title ?? artifact.kind))), error && /* @__PURE__ */ React.createElement(Text, { size: "xs", tone: "danger" }, error), /* @__PURE__ */ React.createElement(Stack, { direction: "row", gap: 6, wrap: true, align: "center" }, props.open && /* @__PURE__ */ React.createElement(Button, { size: "sm", variant: "primary", title: "Its details, assets and thread", onClick: () => props.open(item) }, "Open"), /* @__PURE__ */ React.createElement(Button, { size: "sm", disabled: !item.thread, title: "Open its thread to steer the agents there", onClick: () => props.steer(item) }, "Steer"), !closed2 && /* @__PURE__ */ React.createElement(AddAgent, { hub: props.hub, task: item, onDone: props.onChange }), /* @__PURE__ */ React.createElement("select", { className: "dbx-input", "aria-label": "Status", disabled: busy, value: item.task.status, onChange: (event) => void setStatus(event.target.value), style: { width: "auto", fontSize: "0.75rem" } }, TASK_STATUSES.map((status2) => /* @__PURE__ */ React.createElement("option", { key: status2, value: status2 }, STATUS_GROUPS.find((group) => group.status === status2)?.title ?? status2))), !closed2 && /* @__PURE__ */ React.createElement(Button, { size: "sm", variant: "danger", disabled: busy, onClick: () => void setStatus("dismissed") }, "Dismiss")));
}
function AssignButton(props) {
  const name = assigneeName(props.assignee, props.profile);
  return /* @__PURE__ */ React.createElement(
    "button",
    {
      type: "button",
      title: props.open ? `${name}: owners are below` : `${name}: click to assign or reassign`,
      "aria-label": `Assign (now ${name})`,
      onClick: (event) => (event.stopPropagation(), props.open || props.toggle()),
      onKeyDown: (event) => event.stopPropagation(),
      style: { border: 0, padding: 0, background: "transparent", cursor: "pointer", display: "inline-flex", flex: "none", borderRadius: 999 }
    },
    /* @__PURE__ */ React.createElement(AssigneeMark, { assignee: props.assignee, profile: props.profile, ...props.size && { size: props.size } })
  );
}
function SourceMark(props) {
  const { ref } = taskOrigin(props.title, props.origin);
  const label2 = ref && props.origin ? `${sourceName(props.origin.source)} ${ref}` : sourceName(props.source.source);
  return /* @__PURE__ */ React.createElement(Text, { size: "xs", tone: "tertiary", mono: Boolean(ref) }, /* @__PURE__ */ React.createElement("span", { title: label2, style: { whiteSpace: "nowrap" } }, ref ?? label2));
}
function Meta(props) {
  const { item } = props;
  const assets = cardAssets(item);
  return /* @__PURE__ */ React.createElement(React.Fragment, null, item.task.workstream && /* @__PURE__ */ React.createElement(Chip, { title: workstreamHint(item.task) }, item.task.workstream), item.task.initiative && /* @__PURE__ */ React.createElement(Chip, { tone: "brand" }, item.task.initiative), item.task.mode !== "draft" && /* @__PURE__ */ React.createElement(Chip, { tone: item.task.mode === "auto" ? "success" : void 0, title: "How agents handle it" }, item.task.mode), item.source && /* @__PURE__ */ React.createElement(SourceMark, { source: item.source, ...item.origin && { origin: item.origin }, title: item.task.title }), assets.slice(0, 3).map((artifact) => /* @__PURE__ */ React.createElement("a", { className: "dbx-link", key: `${artifact.at}:${artifact.url}`, href: artifact.url, onClick: link(artifact.url), title: artifact.title ?? artifact.url, style: { fontSize: "0.75rem", textDecoration: "none" } }, ASSET_ICON[artifact.kind] ?? "\u{1F517}")), assets.length > 3 && /* @__PURE__ */ React.createElement(Text, { size: "xs", tone: "tertiary" }, "+", assets.length - 3));
}
var rowKeys = (toggle2) => ({ role: "button", tabIndex: 0, onClick: toggle2, onKeyDown: (event) => (event.key === "Enter" || event.key === " ") && event.target === event.currentTarget && (event.preventDefault(), toggle2()) });
function TaskRow(props) {
  const { item } = props;
  const assignee = assigneeOf(item);
  return /* @__PURE__ */ React.createElement("div", { style: { borderBottom: "1px solid var(--dbx-border)", background: props.open ? "var(--dbx-inset)" : void 0 } }, /* @__PURE__ */ React.createElement("div", { ...rowKeys(props.toggle), "aria-expanded": props.open, className: "signals-row", style: { display: "flex", alignItems: "center", gap: 8, padding: "7px 12px", cursor: "pointer", minWidth: 0 } }, /* @__PURE__ */ React.createElement(Text, { size: "xs", tone: "tertiary", mono: true, style: { flex: "none", width: 34 } }, "#", item.task.id), /* @__PURE__ */ React.createElement(StatusIcon, { status: item.task.status }), /* @__PURE__ */ React.createElement(Text, { size: "sm", weight: 500, style: { flex: "1 1 auto", minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" } }, /* @__PURE__ */ React.createElement("span", { title: titleHint(item.task.title, item.origin) }, item.task.title)), /* @__PURE__ */ React.createElement("span", { style: { display: "flex", gap: 6, alignItems: "center", flex: "none", maxWidth: "45%", overflow: "hidden" } }, /* @__PURE__ */ React.createElement(Meta, { item })), /* @__PURE__ */ React.createElement(Text, { size: "xs", tone: "tertiary", style: { flex: "none", width: 52, textAlign: "right" } }, ago(item.task.last_event_at * 1e3)), /* @__PURE__ */ React.createElement(AssignButton, { assignee, profile: props.profile, open: props.open, toggle: props.toggle })), props.open && /* @__PURE__ */ React.createElement("div", { style: { padding: "0 12px 10px 54px" } }, /* @__PURE__ */ React.createElement(TaskBody, { hub: props.hub, item, steer: props.steer, onChange: props.onChange, open: props.view, assigning: props.assigning })));
}
function TaskCard(props) {
  const { item } = props;
  const assignee = assigneeOf(item);
  return /* @__PURE__ */ React.createElement("div", { className: "dbx-card", style: { padding: 10, borderRadius: 8, boxShadow: props.open ? "0 1px 6px rgba(0,0,0,0.12)" : void 0 } }, /* @__PURE__ */ React.createElement("div", { ...rowKeys(props.toggle), "aria-expanded": props.open, style: { cursor: "pointer" } }, /* @__PURE__ */ React.createElement(Stack, { gap: 6 }, /* @__PURE__ */ React.createElement(Stack, { direction: "row", gap: 6, align: "center", justify: "space-between" }, /* @__PURE__ */ React.createElement(Text, { size: "xs", tone: "tertiary", mono: true }, "#", item.task.id), /* @__PURE__ */ React.createElement(Stack, { direction: "row", gap: 6, align: "center" }, /* @__PURE__ */ React.createElement(Text, { size: "xs", tone: "tertiary" }, ago(item.task.last_event_at * 1e3)), /* @__PURE__ */ React.createElement(AssignButton, { assignee, profile: props.profile, size: 18, open: props.open, toggle: props.toggle }))), /* @__PURE__ */ React.createElement(Stack, { direction: "row", gap: 6, align: "flex-start" }, /* @__PURE__ */ React.createElement("span", { style: { paddingTop: 2 } }, /* @__PURE__ */ React.createElement(StatusIcon, { status: item.task.status })), /* @__PURE__ */ React.createElement(Text, { size: "sm", weight: 500, style: { minWidth: 0, overflowWrap: "anywhere" } }, /* @__PURE__ */ React.createElement("span", { title: titleHint(item.task.title, item.origin) }, item.task.title))), /* @__PURE__ */ React.createElement(Stack, { direction: "row", gap: 6, wrap: true, align: "center" }, /* @__PURE__ */ React.createElement(Meta, { item })))), props.open && /* @__PURE__ */ React.createElement(TaskBody, { hub: props.hub, item, steer: props.steer, onChange: props.onChange, open: props.view, assigning: props.assigning }));
}
function useThread(ctx, channel, root) {
  const session = useRelay(ctx).session;
  const [reader, setReader] = React.useState();
  const [, bump] = React.useReducer((n) => n + 1, 0);
  React.useEffect(() => {
    if (!channel || !root || !session?.thread) return setReader(void 0);
    let opened;
    try {
      opened = session.thread(channel, root, { priority: "foreground" });
    } catch {
      return setReader(void 0);
    }
    let refreshed = false;
    const settle = () => {
      const now = opened.snapshot();
      if (!refreshed && now.status === "ready" && !now.replies.length && opened.refresh) {
        refreshed = true;
        void opened.refresh().catch(() => {
        });
      }
      bump();
    };
    const stop = opened.subscribe(settle);
    setReader(opened);
    settle();
    return () => (stop(), opened.dispose());
  }, [session, channel, root]);
  const snapshot = reader?.snapshot();
  const messages = snapshot ? [...snapshot.root ? [snapshot.root] : [], ...snapshot.replies] : [];
  const reply = session?.messages?.reply;
  return {
    available: Boolean(session?.thread),
    status: snapshot?.status ?? "idle",
    /** Reading more of it (a refresh or an earlier page) while some is shown. */
    reading: snapshot?.status === "loading" || Boolean(snapshot?.readKind),
    /** The reader stopped at its bound with no way to read on here. */
    limited: Boolean(snapshot?.limited && !snapshot.canLoadMore),
    error: snapshot?.error,
    comments: threadComments(messages),
    more: snapshot?.canLoadMore ? () => void reader?.loadMore() : void 0,
    reply: reply && channel && root ? (content, mentions) => reply(channel, root, content, mentions) : void 0
  };
}
var fullTime = (seconds) => new Date(seconds * 1e3).toLocaleString([], { dateStyle: "medium", timeStyle: "short" });
var shortEmails = (text) => text.replace(/\b([\w.+-]+)@[\w-]+(?:\.[\w-]+)+\b/g, "$1");
var lineText = (text, profile) => shortEmails(plainLine(text, (npub) => profile(npubKey(npub) ?? "")?.name));
function RichText(props) {
  const HostMarkdown = props.ctx.conversation?.ui?.Markdown;
  const named = withMentionNames(props.text, npubKey, (key) => props.profile(key)?.name);
  return /* @__PURE__ */ React.createElement("div", { className: "dbx-quiet-headings", style: { overflowWrap: "anywhere", minWidth: 0 } }, HostMarkdown ? /* @__PURE__ */ React.createElement(HostMarkdown, { content: named }) : /* @__PURE__ */ React.createElement(Markdown, { source: named, size: "sm" }));
}
function Step(props) {
  return /* @__PURE__ */ React.createElement("div", { style: { display: "flex", gap: 10, minWidth: 0 } }, /* @__PURE__ */ React.createElement("div", { style: { flex: "none", width: 24, display: "flex", flexDirection: "column", alignItems: "center" } }, props.mark, !props.last && /* @__PURE__ */ React.createElement("span", { "aria-hidden": true, style: { flex: "1 1 auto", width: 1, minHeight: 8, marginTop: 4, background: "var(--dbx-border)" } })), /* @__PURE__ */ React.createElement("div", { style: { flex: "1 1 auto", minWidth: 0, paddingBottom: props.last ? 0 : 14 } }, props.children));
}
function LineMark(props) {
  const color = props.tone === "success" ? "var(--dbx-success)" : props.tone === "warning" ? "var(--dbx-warning)" : "var(--dbx-subtle)";
  return /* @__PURE__ */ React.createElement("span", { "aria-hidden": true, style: { width: 24, height: 24, flex: "none", boxSizing: "border-box", borderRadius: 999, border: "1px solid var(--dbx-border)", background: "var(--dbx-inset)", color, display: "inline-flex", alignItems: "center", justifyContent: "center", fontSize: 11, lineHeight: 1 } }, props.icon);
}
function PersonMark(props) {
  const found = props.profile(props.id);
  const label2 = found?.name ?? `${npubOf(props.id).slice(0, 12)}\u2026`;
  return /* @__PURE__ */ React.createElement(AssigneeMark, { assignee: { kind: found?.agent ? "agent" : "person", key: props.id, label: label2 }, profile: props.profile, size: props.size ?? 24 });
}
var Who = (props) => /* @__PURE__ */ React.createElement("span", { style: { color: "var(--dbx-ink)", fontWeight: 600 } }, props.children);
var When = (props) => /* @__PURE__ */ React.createElement("span", { title: fullTime(props.at), style: { color: "var(--dbx-tertiary)", whiteSpace: "nowrap" } }, ago(props.at * 1e3));
var STATUS_WORD = /^(.+?) set this to \*\*(\w[\w ]*)\*\*(?::\s*(.*))?$/;
function describeLine(line2, profile) {
  const text = (value) => lineText(value, profile);
  if (line2.kind === "opened") {
    const from = line2.post.source && sourceName(line2.post.source.kind);
    return { mark: /* @__PURE__ */ React.createElement(LineMark, { icon: "\u{1F4CC}" }), body: /* @__PURE__ */ React.createElement("span", null, "Task opened", from ? /* @__PURE__ */ React.createElement(React.Fragment, null, " from ", /* @__PURE__ */ React.createElement(Who, null, from)) : null, line2.post.source?.from ? ` \xB7 ${shortEmails(line2.post.source.from)}` : ""), more: true };
  }
  if (line2.kind === "note") {
    const name = profile(line2.comment.author)?.name ?? "An agent";
    return { mark: /* @__PURE__ */ React.createElement(LineMark, { icon: "\u270E" }), body: /* @__PURE__ */ React.createElement("span", null, /* @__PURE__ */ React.createElement(Who, null, name), " left a note for agents"), more: true };
  }
  const { post } = line2;
  switch (post.kind) {
    case "question":
      return { mark: /* @__PURE__ */ React.createElement(LineMark, { icon: "?", tone: "warning" }), body: /* @__PURE__ */ React.createElement("span", null, /* @__PURE__ */ React.createElement(Who, null, text(post.by)), " asked: \u201C", shorten(post.question, 160), "\u201D"), more: false };
    case "answered":
      return { mark: /* @__PURE__ */ React.createElement(LineMark, { icon: "\u21B3" }), body: /* @__PURE__ */ React.createElement("span", null, /* @__PURE__ */ React.createElement(Who, null, text(post.who)), " answered ", /* @__PURE__ */ React.createElement(Who, null, text(post.answer))), more: post.forAgents };
    case "status": {
      const found = STATUS_WORD.exec(post.text);
      const status2 = found?.[2]?.trim().replace(" ", "_");
      const title = STATUS_GROUPS.find((group) => group.status === status2)?.title ?? found?.[2];
      return found ? { mark: /* @__PURE__ */ React.createElement(LineMark, { icon: /* @__PURE__ */ React.createElement(StatusIcon, { status: status2 ?? "", size: 11 }) }), body: /* @__PURE__ */ React.createElement("span", null, /* @__PURE__ */ React.createElement(Who, null, text(found[1])), " moved it to ", /* @__PURE__ */ React.createElement(Who, null, title), found[3] ? `: ${text(found[3])}` : ""), more: false } : { mark: /* @__PURE__ */ React.createElement(LineMark, { icon: "\u25CF" }), body: /* @__PURE__ */ React.createElement("span", null, text(post.text)), more: false };
    }
    case "assigned":
      return { mark: /* @__PURE__ */ React.createElement(LineMark, { icon: "\u{1F464}" }), body: /* @__PURE__ */ React.createElement("span", null, text(post.text)), more: post.forAgents };
    case "update":
      return {
        mark: /* @__PURE__ */ React.createElement(LineMark, { icon: "\u21BB" }),
        body: /* @__PURE__ */ React.createElement("span", null, "Source updated: ", post.url ? /* @__PURE__ */ React.createElement("a", { className: "dbx-link", href: post.url, onClick: link(post.url), title: post.url }, post.title) : post.title, post.changes.map((change) => /* @__PURE__ */ React.createElement("span", { key: change.field, style: { marginLeft: 6 } }, /* @__PURE__ */ React.createElement(Chip, { title: `${change.field}: ${change.from} \u2192 ${change.to}` }, change.field, " \u2192 ", change.to)))),
        more: post.forAgents
      };
    case "done":
      return { mark: /* @__PURE__ */ React.createElement(LineMark, { icon: "\u2713", tone: "success" }), body: /* @__PURE__ */ React.createElement("span", null, /* @__PURE__ */ React.createElement(Who, null, "Done"), ": ", text(post.reason)), more: false };
    case "nudge":
      return { mark: /* @__PURE__ */ React.createElement(LineMark, { icon: "\u23F1" }), body: /* @__PURE__ */ React.createElement("span", null, text(post.text)), more: false };
    case "asked":
      return { mark: /* @__PURE__ */ React.createElement(LineMark, { icon: "\u2192" }), body: /* @__PURE__ */ React.createElement("span", null, post.text), more: true };
  }
}
function LineStep(props) {
  const [open, setOpen] = React.useState(false);
  const { mark, body, more } = describeLine(props.line, props.profile);
  const label2 = props.line.kind === "note" ? "Show" : "For agents";
  return /* @__PURE__ */ React.createElement(Step, { mark, ...props.last && { last: true } }, /* @__PURE__ */ React.createElement("div", { style: { display: "flex", flexWrap: "wrap", alignItems: "baseline", columnGap: 6, rowGap: 2, minHeight: 24, paddingTop: 4, boxSizing: "border-box", fontSize: "0.75rem", color: "var(--dbx-subtle)", overflowWrap: "anywhere" } }, body, /* @__PURE__ */ React.createElement(When, { at: props.line.comment.at }), more && /* @__PURE__ */ React.createElement("button", { type: "button", "aria-expanded": open, onClick: () => setOpen(!open), style: { border: 0, background: "transparent", padding: 0, cursor: "pointer", color: "var(--dbx-tertiary)", fontSize: "0.75rem", textDecoration: "underline dotted" } }, open ? "Hide" : label2)), open && /* @__PURE__ */ React.createElement("div", { style: { marginTop: 6, padding: "8px 12px", borderRadius: 8, border: "1px solid var(--dbx-border)", background: "var(--dbx-inset)" } }, /* @__PURE__ */ React.createElement(RichText, { ctx: props.ctx, text: props.line.comment.text, profile: props.profile })));
}
var recordedReply = (item) => item.artifacts.filter((artifact) => artifact.kind === "reply" || artifact.kind === "draft").sort((a, b) => a.at - b.at).map((artifact) => /[?&]id=([0-9a-f]{64})/.exec(artifact.url)?.[1]).filter(Boolean).at(-1);
var COMMENT_HEIGHT = 280;
function CommentStep(props) {
  const { comment } = props;
  const name = props.profile(comment.author)?.name ?? `${npubOf(comment.author).slice(0, 12)}\u2026`;
  const [open, setOpen] = React.useState(props.expanded);
  const [long, setLong] = React.useState(false);
  const body = React.useRef(null);
  const text = comment.text.length > 2e4 ? `${comment.text.slice(0, 19999)}\u2026` : comment.text;
  React.useLayoutEffect(() => {
    const element = body.current;
    if (!element) return;
    const measure = () => setLong(element.scrollHeight > COMMENT_HEIGHT + 60);
    measure();
    const Observer = globalThis.ResizeObserver;
    if (!Observer) return;
    const observer = new Observer(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [text]);
  const cut = long && !open;
  const fade = "linear-gradient(to bottom, #000 65%, transparent)";
  return /* @__PURE__ */ React.createElement(Step, { mark: /* @__PURE__ */ React.createElement(PersonMark, { id: comment.author, profile: props.profile }) }, /* @__PURE__ */ React.createElement("div", { style: { border: "1px solid var(--dbx-border)", borderRadius: 8, background: "var(--dbx-surface)", minWidth: 0, opacity: comment.pending ? 0.6 : 1 } }, /* @__PURE__ */ React.createElement("div", { style: { display: "flex", alignItems: "center", gap: 6, padding: "6px 6px 0 12px", minWidth: 0 } }, /* @__PURE__ */ React.createElement(Text, { size: "sm", weight: 600, style: { minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" } }, name), /* @__PURE__ */ React.createElement(Text, { size: "xs", tone: "tertiary", style: { flex: "1 1 auto", whiteSpace: "nowrap" } }, /* @__PURE__ */ React.createElement(When, { at: comment.at }), comment.pending ? " \xB7 sending" : ""), comment.failed && /* @__PURE__ */ React.createElement(Text, { size: "xs", tone: "danger" }, "Not sent"), long && /* @__PURE__ */ React.createElement(CopyButton, { text: comment.text })), /* @__PURE__ */ React.createElement("div", { ref: body, style: { padding: "0 12px 10px", ...cut && { maxHeight: COMMENT_HEIGHT, overflow: "hidden", maskImage: fade, WebkitMaskImage: fade } } }, /* @__PURE__ */ React.createElement(RichText, { ctx: props.ctx, text, profile: props.profile })), long && /* @__PURE__ */ React.createElement("div", { style: { padding: "0 12px 8px" } }, /* @__PURE__ */ React.createElement("button", { type: "button", className: "dbx-link", "aria-expanded": open, onClick: () => setOpen(!open), style: { border: 0, background: "transparent", padding: 0, cursor: "pointer", fontSize: "0.75rem" } }, open ? "Show less" : "Show more"))));
}
function LinesStep(props) {
  const [open, setOpen] = React.useState(false);
  const shown = open ? props.lines : props.lines.slice(-2);
  const hidden = props.lines.length - shown.length;
  return /* @__PURE__ */ React.createElement(React.Fragment, null, hidden > 0 && /* @__PURE__ */ React.createElement(Step, { mark: /* @__PURE__ */ React.createElement(LineMark, { icon: "\u22EF" }) }, /* @__PURE__ */ React.createElement("button", { type: "button", onClick: () => setOpen(true), style: { border: 0, background: "transparent", padding: "4px 0 0", cursor: "pointer", color: "var(--dbx-subtle)", fontSize: "0.75rem", minHeight: 24 } }, "Show ", hidden, " earlier ", hidden === 1 ? "update" : "updates")), shown.map((line2, at) => /* @__PURE__ */ React.createElement(LineStep, { key: line2.comment.id, ctx: props.ctx, line: line2, profile: props.profile, ...props.last && at === shown.length - 1 && { last: true } })));
}
function ReplyBox(props) {
  const [text, setText] = React.useState("");
  const [error, setError] = React.useState();
  const mentions = replyMentions(props.assignee);
  const to = props.assignee.kind === "agent" ? props.profile(props.assignee.key)?.name ?? props.assignee.label : void 0;
  if (!props.send) return /* @__PURE__ */ React.createElement(Text, { size: "xs", tone: "subtle" }, "Replying needs Buzz's thread view here. ", /* @__PURE__ */ React.createElement("a", { className: "dbx-link", href: "#", onClick: (event) => (event.preventDefault(), props.steer()) }, "Open the thread"), " to reply.");
  const send = () => {
    if (!text.trim()) return;
    setError(void 0);
    try {
      props.send(replyText(text, mentions.map((key) => ({ npub: npubEncode(key) }))), mentions);
      setText("");
    } catch (problem) {
      setError(describeError(problem));
    }
  };
  return /* @__PURE__ */ React.createElement(Stack, { gap: 6 }, /* @__PURE__ */ React.createElement(
    "textarea",
    {
      className: "dbx-input",
      rows: 3,
      "aria-label": "Reply",
      placeholder: to ? `Reply to ${to}\u2026` : "Reply in the task's thread\u2026",
      value: text,
      onChange: (event) => setText(event.target.value),
      onKeyDown: (event) => event.key === "Enter" && (event.metaKey || event.ctrlKey) && (event.preventDefault(), send()),
      style: { resize: "vertical", minHeight: 64 }
    }
  ), error && /* @__PURE__ */ React.createElement(Text, { size: "xs", tone: "danger" }, error), /* @__PURE__ */ React.createElement(Stack, { direction: "row", gap: 8, align: "center", justify: "space-between", wrap: true }, /* @__PURE__ */ React.createElement(Text, { size: "xs", tone: "tertiary" }, to ? `Mentions ${to}, the agent it's with` : props.assignee.kind === "you" ? "Mentions no one: it's waiting on your answer" : "Mentions no one: no agent is on it", " \xB7 \u2318\u21B5 sends"), /* @__PURE__ */ React.createElement(Button, { size: "sm", variant: "brand", disabled: !text.trim(), onClick: send }, "Reply")));
}
function useWide(ref, min) {
  const [wide, setWide] = React.useState(true);
  React.useLayoutEffect(() => {
    const element = ref.current;
    if (!element) return;
    const measure = () => setWide(element.getBoundingClientRect().width >= min);
    measure();
    const Observer = globalThis.ResizeObserver;
    if (!Observer) return;
    const observer = new Observer(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [min]);
  return wide;
}
function Section(props) {
  return /* @__PURE__ */ React.createElement(Stack, { gap: 6 }, /* @__PURE__ */ React.createElement(Text, { size: "xs", tone: "tertiary", weight: 600 }, props.title.toUpperCase()), props.children);
}
function useSetStatus(hub2, id, onChange) {
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState();
  const set = async (status2) => {
    setBusy(true);
    setError(void 0);
    try {
      await hub2.updateTask({ id, status: status2 });
      onChange();
    } catch (problem) {
      setError(describeError(problem));
    } finally {
      setBusy(false);
    }
  };
  return { busy, error, set };
}
function StatusPicker(props) {
  return /* @__PURE__ */ React.createElement("select", { className: "dbx-input", "aria-label": "Status", disabled: props.busy, value: props.status, onChange: (event) => props.set(event.target.value), style: { width: "auto", maxWidth: "100%", fontSize: "0.75rem" } }, TASK_STATUSES.map((status2) => /* @__PURE__ */ React.createElement("option", { key: status2, value: status2 }, STATUS_GROUPS.find((group) => group.status === status2)?.title ?? status2)));
}
function TaskView(props) {
  const { item } = props;
  const assignee = assigneeOf(item);
  const thread = useThread(props.ctx, props.channel ?? item.task.channel ?? void 0, item.task.buzz_root);
  const assets = item.artifacts.filter((artifact) => /^https?:/.test(artifact.url) && !["reply", "draft"].includes(artifact.kind));
  const facts = taskFacts(item);
  const authorProfile = useProfiles(props.ctx, [...new Set(thread.comments.flatMap((comment) => [comment.author, ...mentionedKeys(comment.text, npubKey)]))]);
  const who = (key) => props.profile(key) ?? authorProfile(key);
  const people = item.people.filter((person) => person.kind !== "agent" && !person.on);
  const members = useMembers(props.ctx, props.channel ?? item.task.channel ?? void 0);
  useProfiles(props.ctx, members);
  const viewer = useRelay(props.ctx).viewer;
  const status2 = useSetStatus(props.hub, item.task.id, props.onChange);
  const closed2 = item.task.status === "done" || item.task.status === "dismissed";
  const box = React.useRef(null);
  const wide = useWide(box, 680);
  const entries = React.useMemo(() => taskActivity(thread.comments), [thread.comments]);
  const opened = entries.find((entry) => entry.kind === "opened")?.post;
  const comments = entries.flatMap((entry) => entry.kind === "comment" ? [entry.comment] : []);
  const expanded = /* @__PURE__ */ new Set([comments.at(-1)?.id, recordedReply(item)]);
  const commentCount = comments.length;
  const end = React.useRef(null);
  const count = thread.comments.length;
  const seen = React.useRef(void 0);
  const { onChange } = props;
  React.useEffect(() => {
    if (thread.status !== "ready") return;
    if (seen.current !== void 0 && count > seen.current) onChange(), end.current?.scrollIntoView?.({ block: "nearest" });
    seen.current = count;
  }, [count, thread.status]);
  const source = item.source;
  const ticket = taskOrigin(item.task.title, item.origin).ref;
  const opening = openingTitle(item);
  const sourceLine = [source && sourceName(source.source), opened?.source?.from && shortEmails(opened.source.from)].filter(Boolean).join(" \xB7 ");
  const quote = opened?.source?.quote;
  const sourceFacts = opened?.source?.facts ?? [];
  const openThread = item.thread ? () => props.steer(item) : void 0;
  const more = /* @__PURE__ */ React.createElement(Stack, { gap: 16 }, /* @__PURE__ */ React.createElement(Section, { title: "Details" }, /* @__PURE__ */ React.createElement("div", { style: { display: "grid", gridTemplateColumns: "auto minmax(0, 1fr)", columnGap: 12, rowGap: 4, fontSize: "0.75rem" } }, facts.map((fact) => /* @__PURE__ */ React.createElement(React.Fragment, { key: fact.label }, /* @__PURE__ */ React.createElement("span", { style: { color: "var(--dbx-tertiary)", whiteSpace: "nowrap" } }, fact.label), /* @__PURE__ */ React.createElement("span", { title: fact.title, style: { minWidth: 0, overflowWrap: "anywhere", color: "var(--dbx-ink)" } }, fact.value, fact.note && /* @__PURE__ */ React.createElement("span", { style: { display: "block", color: "var(--dbx-tertiary)" } }, fact.note)))))), people.length > 0 && /* @__PURE__ */ React.createElement(Section, { title: "People" }, people.map((person) => /* @__PURE__ */ React.createElement(Text, { key: `${person.kind}:${person.key}`, size: "xs", style: { overflowWrap: "anywhere" } }, person.label, " ", /* @__PURE__ */ React.createElement("span", { style: { color: "var(--dbx-tertiary)" } }, "\xB7 ", person.role)))), /* @__PURE__ */ React.createElement(Section, { title: "Assets" }, !assets.length ? /* @__PURE__ */ React.createElement(Text, { size: "xs", tone: "subtle" }, "Nothing made for it yet.") : assets.map((artifact) => /* @__PURE__ */ React.createElement("a", { className: "dbx-link", key: `${artifact.at}:${artifact.url}`, href: artifact.url, onClick: link(artifact.url), title: artifact.url, style: { display: "flex", gap: 6, alignItems: "baseline", fontSize: "0.75rem", minWidth: 0, textDecoration: "none", opacity: artifact.kind === "workspace" ? 0.7 : 1 } }, /* @__PURE__ */ React.createElement("span", { "aria-hidden": true, style: { flex: "none" } }, ASSET_ICON[artifact.kind] ?? "\u{1F517}"), /* @__PURE__ */ React.createElement("span", { style: { minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" } }, artifact.title ?? artifact.url.replace(/^https?:\/\//, ""))))));
  const sidebar = /* @__PURE__ */ React.createElement(Stack, { gap: 16 }, /* @__PURE__ */ React.createElement(Section, { title: "Status" }, /* @__PURE__ */ React.createElement(StatusPicker, { status: item.task.status, busy: status2.busy, set: (next) => void status2.set(next) }), status2.error && /* @__PURE__ */ React.createElement(Text, { size: "xs", tone: "danger" }, status2.error)), /* @__PURE__ */ React.createElement(Owners, { hub: props.hub, item, members, boardAgents: props.boardAgents, ...viewer && { viewer }, profile: who, onChange: props.onChange }), wide ? more : /* @__PURE__ */ React.createElement(Disclosure, { summary: `Details${assets.length ? ` and ${assets.length} ${assets.length === 1 ? "asset" : "assets"}` : ""}` }, more), !closed2 && /* @__PURE__ */ React.createElement("div", null, /* @__PURE__ */ React.createElement(Button, { size: "sm", disabled: status2.busy, title: "Close it without doing it; agents stop working on it", onClick: () => void status2.set("dismissed") }, "Dismiss task")));
  return /* @__PURE__ */ React.createElement("div", { ref: box, style: { minWidth: 0 } }, /* @__PURE__ */ React.createElement(Stack, { gap: 16 }, /* @__PURE__ */ React.createElement(Stack, { gap: 8 }, /* @__PURE__ */ React.createElement(Stack, { direction: "row", gap: 8, align: "center" }, props.back && /* @__PURE__ */ React.createElement(Button, { size: "sm", variant: "ghost", onClick: props.back }, "\u2190 Board"), /* @__PURE__ */ React.createElement(Text, { size: "xs", tone: "tertiary", mono: true }, "Task ", item.task.id), ticket && /* @__PURE__ */ React.createElement(Text, { size: "xs", tone: "tertiary", mono: true }, ticket), item.task.workstream && /* @__PURE__ */ React.createElement(Chip, { title: workstreamHint(item.task) }, item.task.workstream), item.task.mode !== "draft" && /* @__PURE__ */ React.createElement(Chip, { tone: item.task.mode === "auto" ? "success" : void 0, title: MODE_NAMES[item.task.mode]?.title }, item.task.mode)), /* @__PURE__ */ React.createElement(Stack, { direction: "row", gap: 8, align: "flex-start" }, /* @__PURE__ */ React.createElement("span", { style: { paddingTop: 5 } }, /* @__PURE__ */ React.createElement(StatusIcon, { status: item.task.status, size: 15 })), /* @__PURE__ */ React.createElement(Text, { as: "h2", size: "xl", weight: 600, style: { overflowWrap: "anywhere", margin: 0 } }, item.task.title)), opening && /* @__PURE__ */ React.createElement(Text, { size: "sm", tone: "subtle", style: { overflowWrap: "anywhere" } }, /* @__PURE__ */ React.createElement("span", { style: { color: "var(--dbx-tertiary)" } }, "Opened from ", sourceName(opening.source), ": "), opening.url ? /* @__PURE__ */ React.createElement("a", { className: "dbx-link", href: opening.url, onClick: link(opening.url), title: opening.url }, opening.title) : opening.title), source && /* @__PURE__ */ React.createElement(Text, { size: "xs", tone: "subtle", style: { overflowWrap: "anywhere" } }, sourceLine, source.title && /* @__PURE__ */ React.createElement(React.Fragment, null, " \xB7 ", source.url ? /* @__PURE__ */ React.createElement("a", { className: "dbx-link", href: source.url, onClick: link(source.url), title: source.url }, source.title) : source.title), /* @__PURE__ */ React.createElement("span", { style: { color: "var(--dbx-tertiary)" } }, " \xB7 ", ago(source.occurred_at * 1e3)))), item.task.question && !closed2 && /* @__PURE__ */ React.createElement(ProvideInput, { hub: props.hub, task: item, onDone: props.onChange, startOpen: true }), (quote || sourceFacts.length > 0) && /* @__PURE__ */ React.createElement(Stack, { gap: 8 }, quote && /* @__PURE__ */ React.createElement("div", { style: { borderLeft: "2px solid var(--dbx-border-strong)", paddingLeft: 10 } }, /* @__PURE__ */ React.createElement(Text, { size: "sm", tone: "subtle", style: { overflowWrap: "anywhere", whiteSpace: "pre-wrap" } }, quote)), sourceFacts.length > 0 && /* @__PURE__ */ React.createElement("div", { style: { display: "flex", flexWrap: "wrap", columnGap: 14, rowGap: 2 } }, sourceFacts.map((fact) => /* @__PURE__ */ React.createElement(Text, { key: fact.label, size: "xs", tone: "subtle" }, /* @__PURE__ */ React.createElement("span", { style: { color: "var(--dbx-tertiary)" } }, fact.label), " ", fact.value)))), /* @__PURE__ */ React.createElement("div", { style: { display: "flex", flexDirection: wide ? "row" : "column", gap: wide ? 28 : 16, alignItems: wide ? "flex-start" : "stretch", minWidth: 0 } }, !wide && /* @__PURE__ */ React.createElement("div", { className: "dbx-card", style: { padding: 12, borderRadius: 8 } }, sidebar), /* @__PURE__ */ React.createElement("div", { style: { flex: "1 1 0", minWidth: 0 } }, /* @__PURE__ */ React.createElement(Stack, { gap: 12 }, /* @__PURE__ */ React.createElement(Stack, { direction: "row", gap: 8, align: "center", justify: "space-between" }, /* @__PURE__ */ React.createElement(Text, { size: "sm", weight: 600 }, "Activity", commentCount ? /* @__PURE__ */ React.createElement("span", { style: { color: "var(--dbx-tertiary)", fontWeight: 400 } }, " \xB7 ", commentCount, " ", commentCount === 1 ? "comment" : "comments") : null), openThread && /* @__PURE__ */ React.createElement(Button, { size: "sm", variant: "ghost", title: "Open its thread in Buzz to steer the agents there", onClick: openThread }, "Open thread \u2197")), !item.thread ? /* @__PURE__ */ React.createElement(Text, { size: "xs", tone: "subtle" }, "Not posted in Buzz yet.") : !thread.available ? /* @__PURE__ */ React.createElement(Text, { size: "xs", tone: "subtle" }, "The thread can't be read here. ", /* @__PURE__ */ React.createElement("a", { className: "dbx-link", href: "#", onClick: (event) => (event.preventDefault(), props.steer(item)) }, "Open it in Buzz"), ".") : thread.status === "error" ? /* @__PURE__ */ React.createElement(Text, { size: "xs", tone: "danger" }, thread.error ?? "Couldn't read the thread.", " ", /* @__PURE__ */ React.createElement("a", { className: "dbx-link", href: "#", onClick: (event) => (event.preventDefault(), props.steer(item)) }, "Open it in Buzz"), ".") : thread.status !== "ready" && !count ? /* @__PURE__ */ React.createElement(Spinner, { label: "Loading the activity" }) : /* @__PURE__ */ React.createElement("div", null, thread.more && /* @__PURE__ */ React.createElement(Step, { mark: /* @__PURE__ */ React.createElement(LineMark, { icon: "\u22EF" }) }, /* @__PURE__ */ React.createElement(Button, { size: "sm", variant: "ghost", onClick: thread.more }, "Earlier activity")), thread.limited && /* @__PURE__ */ React.createElement(Step, { mark: /* @__PURE__ */ React.createElement(LineMark, { icon: "\u22EF" }) }, /* @__PURE__ */ React.createElement(Text, { size: "xs", tone: "subtle" }, "Only part of the thread can be read here. ", /* @__PURE__ */ React.createElement("a", { className: "dbx-link", href: "#", onClick: (event) => (event.preventDefault(), props.steer(item)) }, "Open it in Buzz"), " for the rest.")), entries.map(
    (entry) => entry.kind === "comment" ? /* @__PURE__ */ React.createElement(CommentStep, { key: entry.comment.id, ctx: props.ctx, comment: entry.comment, profile: who, expanded: expanded.has(entry.comment.id) }) : entry.kind === "lines" ? /* @__PURE__ */ React.createElement(LinesStep, { key: entry.lines[0].comment.id, ctx: props.ctx, lines: entry.lines, profile: who }) : /* @__PURE__ */ React.createElement(LineStep, { key: entry.comment.id, ctx: props.ctx, line: entry, profile: who })
  ), thread.reading && /* @__PURE__ */ React.createElement(Step, { mark: /* @__PURE__ */ React.createElement(LineMark, { icon: /* @__PURE__ */ React.createElement(Spinner, { size: 10 }) }) }, /* @__PURE__ */ React.createElement(Text, { size: "xs", tone: "tertiary" }, "Reading the thread\u2026")), item.thread && /* @__PURE__ */ React.createElement(Step, { mark: viewer ? /* @__PURE__ */ React.createElement(PersonMark, { id: viewer, profile: who }) : /* @__PURE__ */ React.createElement(LineMark, { icon: "\u270E" }), last: true }, /* @__PURE__ */ React.createElement(ReplyBox, { assignee, profile: props.profile, ...thread.reply && { send: thread.reply }, steer: () => props.steer(item) })), /* @__PURE__ */ React.createElement("div", { ref: end })))), wide && /* @__PURE__ */ React.createElement("aside", { style: { flex: "0 0 240px", minWidth: 0 } }, sidebar))));
}
var VIEW_KEY = "signals.board.view";
var savedView = () => {
  try {
    return readView(globalThis.localStorage?.getItem(VIEW_KEY));
  } catch {
    return "list";
  }
};
function FilteredList(props) {
  if (props.error) return /* @__PURE__ */ React.createElement(Notice, { tone: "danger" }, describeError(props.error));
  if (!props.events) return props.loading ? /* @__PURE__ */ React.createElement(Spinner, { label: "Loading filtered events" }) : null;
  const shown = filterFiltered(props.events, props.search);
  if (!props.events.length) return /* @__PURE__ */ React.createElement(Text, { tone: "subtle", size: "sm" }, "Nothing filtered in the last two weeks. Rules with ", /* @__PURE__ */ React.createElement("code", null, "classify"), " list here the events their question held back.");
  if (!shown.length) return /* @__PURE__ */ React.createElement(Text, { tone: "subtle", size: "sm" }, "No filtered events match the search.");
  return /* @__PURE__ */ React.createElement(Stack, { gap: 6 }, /* @__PURE__ */ React.createElement(Text, { size: "xs", tone: "tertiary" }, "Events from the last two weeks that a rule's classifier kept from opening a task here. If one should have been a task, loosen the rule's question or lower its ", /* @__PURE__ */ React.createElement("code", null, "min"), "."), /* @__PURE__ */ React.createElement("div", { style: { border: "1px solid var(--dbx-border)", borderRadius: 8, overflow: "hidden", minWidth: 0 } }, shown.map((event, n) => /* @__PURE__ */ React.createElement("div", { key: event.id, style: { padding: "8px 12px", borderTop: n ? "1px solid var(--dbx-border)" : void 0, minWidth: 0 } }, /* @__PURE__ */ React.createElement(Stack, { gap: 2 }, /* @__PURE__ */ React.createElement(Stack, { direction: "row", gap: 8, align: "center", wrap: true }, /* @__PURE__ */ React.createElement("span", { style: { fontSize: "0.8125rem", fontWeight: 500, minWidth: 0, flex: "1 1 200px", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }, title: event.title }, event.url ? /* @__PURE__ */ React.createElement("a", { className: "dbx-link", href: event.url, onClick: (click) => (click.preventDefault(), openExternal(event.url)) }, event.title || event.external_id) : event.title || event.external_id), /* @__PURE__ */ React.createElement(Text, { size: "xs", tone: "tertiary" }, event.source, " \xB7 ", ago(event.filtered_at * 1e3))), event.actor && /* @__PURE__ */ React.createElement(Text, { size: "xs", tone: "subtle" }, event.actor), /* @__PURE__ */ React.createElement(Text, { size: "xs", tone: "tertiary" }, filteredWhy(event)))))));
}
function Toolbar(props) {
  const { filters, setFilters } = props;
  const options = filterOptions(props.tasks);
  const statusCounts = byStatus(props.tasks);
  const set = (key) => (event) => setFilters({ ...filters, [key]: event.target.value || void 0 });
  const select = { width: "auto", fontSize: "0.75rem", padding: "2px 6px" };
  const any = Object.values(filters).some(Boolean);
  return /* @__PURE__ */ React.createElement(Stack, { direction: "row", gap: 6, wrap: true, align: "center" }, /* @__PURE__ */ React.createElement("div", { role: "tablist", "aria-label": "View", style: { display: "inline-flex", border: "1px solid var(--dbx-border)", borderRadius: 6, overflow: "hidden" } }, ["list", "swimlanes", "filtered"].map((view) => /* @__PURE__ */ React.createElement("button", { key: view, type: "button", role: "tab", "aria-selected": props.view === view, onClick: () => props.setView(view), title: view === "filtered" ? "Events the classifier kept from opening a task, and why" : void 0, style: { border: 0, padding: "3px 10px", fontSize: "0.75rem", cursor: "pointer", color: props.view === view ? "var(--dbx-ink)" : "var(--dbx-subtle)", background: props.view === view ? "var(--dbx-inset)" : "transparent", fontWeight: props.view === view ? 600 : 400 } }, view === "list" ? "\u2630 List" : view === "swimlanes" ? "\u25A5 Swimlanes" : `\u2298 Filtered${props.filtered !== void 0 ? ` (${props.filtered})` : ""}`))), /* @__PURE__ */ React.createElement("input", { className: "dbx-input", type: "search", "aria-label": props.view === "filtered" ? "Search filtered events" : "Search tasks", placeholder: "Search\u2026", value: filters.search ?? "", onChange: set("search"), style: { ...select, width: 160 } }), props.view !== "filtered" && /* @__PURE__ */ React.createElement(React.Fragment, null, /* @__PURE__ */ React.createElement("select", { className: "dbx-input", "aria-label": "Status", value: filters.status ?? "", onChange: set("status"), style: select }, /* @__PURE__ */ React.createElement("option", { value: "" }, "Any status"), STATUS_GROUPS.map((group) => /* @__PURE__ */ React.createElement("option", { key: group.status, value: group.status }, group.title, " (", statusCounts.get(group.status).length, ")"))), /* @__PURE__ */ React.createElement("select", { className: "dbx-input", "aria-label": "Workstream", value: filters.workstream ?? "", onChange: set("workstream"), style: select }, /* @__PURE__ */ React.createElement("option", { value: "" }, "Any workstream"), options.workstreams.map((option) => /* @__PURE__ */ React.createElement("option", { key: option.value, value: option.value }, option.value === NONE ? "No workstream" : option.value, " (", option.count, ")"))), /* @__PURE__ */ React.createElement("select", { className: "dbx-input", "aria-label": "Assignee", value: filters.assignee ?? "", onChange: set("assignee"), style: select }, /* @__PURE__ */ React.createElement("option", { value: "" }, "Anyone"), options.assignees.map((option) => /* @__PURE__ */ React.createElement("option", { key: option.value, value: option.value }, assigneeName(option.assignee, props.profile), " (", option.count, ")"))), /* @__PURE__ */ React.createElement("select", { className: "dbx-input", "aria-label": "Mode", value: filters.mode ?? "", onChange: set("mode"), style: select }, /* @__PURE__ */ React.createElement("option", { value: "" }, "Any mode"), options.modes.map((option) => /* @__PURE__ */ React.createElement("option", { key: option.value, value: option.value }, option.value, " (", option.count, ")")))), any && /* @__PURE__ */ React.createElement(Button, { size: "sm", onClick: () => setFilters({}) }, "Clear"), any && props.view !== "filtered" && /* @__PURE__ */ React.createElement(Text, { size: "xs", tone: "tertiary" }, props.shown, " of ", props.tasks.length));
}
var BOARD_PAGE = "board";
var PLUGIN_ID = "bkvarda.databricks-signals";
var validBoardRoute = (params) => params === null || typeof params === "object" && !Array.isArray(params) && ["channel", "name"].every((key) => params[key] === void 0 || typeof params[key] === "string");
function boardRoute(target) {
  const t = target;
  const params = t?.kind === "page" && t.route?.params && typeof t.route.params === "object" ? t.route.params : {};
  return { ...typeof params.channel === "string" && { channel: params.channel }, ...typeof params.name === "string" && { name: params.name } };
}
function Columns(props) {
  const row = React.useRef(null);
  const [edges, setEdges] = React.useState({ left: false, right: false });
  const measure = React.useCallback(() => {
    const el = row.current;
    if (!el) return;
    setEdges({ left: el.scrollLeft > 1, right: el.scrollLeft + el.clientWidth < el.scrollWidth - 1 });
  }, []);
  React.useEffect(() => {
    measure();
    const el = row.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, [measure]);
  const scroll = (direction) => row.current?.scrollBy({ left: direction * (COLUMN_WIDTH + 12), behavior: "smooth" });
  const arrow = (direction) => ({ position: "absolute", top: 0, [direction < 0 ? "left" : "right"]: 0, boxShadow: "0 1px 4px rgba(0,0,0,0.15)", pointerEvents: "auto" });
  return /* @__PURE__ */ React.createElement("div", { style: { position: "relative", minWidth: 0, maxWidth: "100%" } }, /* @__PURE__ */ React.createElement("div", { style: { position: "sticky", top: 0, height: 0, zIndex: 1, pointerEvents: "none" } }, edges.left && /* @__PURE__ */ React.createElement("div", { style: arrow(-1) }, /* @__PURE__ */ React.createElement(Button, { size: "sm", title: "Scroll left", "aria-label": "Scroll left", onClick: () => scroll(-1) }, "\u2039")), edges.right && /* @__PURE__ */ React.createElement("div", { style: arrow(1) }, /* @__PURE__ */ React.createElement(Button, { size: "sm", title: "Scroll right", "aria-label": "Scroll right", onClick: () => scroll(1) }, "\u203A"))), /* @__PURE__ */ React.createElement("div", { ref: row, onScroll: measure, style: { display: "flex", gap: 12, overflowX: "auto", alignItems: "flex-start", minWidth: 0, maxWidth: "100%", paddingBottom: 8 } }, props.children));
}
var COLUMN_WIDTH = 260;
var BoardBoundary;
function boundary() {
  BoardBoundary ??= class extends React.Component {
    state = {};
    static getDerivedStateFromError(error) {
      return { error: error instanceof Error ? error : new Error(String(error)) };
    }
    static getDerivedStateFromProps(props, state) {
      return props.reset === state.reset ? null : { error: void 0, reset: props.reset };
    }
    componentDidCatch(error, info) {
      console.error("Signals board failed", error, info.componentStack);
    }
    render() {
      if (!this.state.error) return this.props.children;
      return /* @__PURE__ */ React.createElement(Notice, { tone: "danger", title: "The board hit an error", action: /* @__PURE__ */ React.createElement(Button, { size: "sm", onClick: () => (this.setState({ error: void 0 }), this.props.retry()) }, "Try again") }, /* @__PURE__ */ React.createElement(Text, { size: "xs", mono: true, as: "div", style: { overflowWrap: "anywhere" } }, this.state.error.message || String(this.state.error)));
    }
  };
  return BoardBoundary;
}
function Board(props) {
  const { ctx, service, channel } = props;
  const connection = useConnection(service);
  const hubs = useAsync(async (signal) => connection.status === "connected" ? chosenHub(service, signal) : void 0, [connection.status]);
  const app = hubs.data?.app;
  const hub2 = React.useMemo(() => app ? new HubClient(service.client(), app) : void 0, [app?.name, app?.url]);
  const [version, refresh] = React.useReducer((n) => n + 1, 0);
  const board = useAsync(async (signal) => hub2 && channel ? hub2.board(channel.id, signal) : void 0, [hub2, channel?.id, version]);
  const filtered = useAsync(async (signal) => hub2 && channel ? hub2.filtered(channel.id, signal).catch((error) => /No route/.test(error.message) ? [] : Promise.reject(error)) : void 0, [hub2, channel?.id, version]);
  const agents = [...new Set((board.data?.tasks ?? []).flatMap((item) => item.people.filter((person) => person.kind === "agent").map((person) => person.key)))];
  const members = useMembers(ctx, channel?.id);
  const profile = useProfiles(ctx, [.../* @__PURE__ */ new Set([...agents, ...members])]);
  const viewer = useRelay(ctx).viewer;
  const assigning = { members, boardAgents: agents, ...viewer && { viewer }, profile };
  const [view, setView] = React.useState(savedView);
  const chooseView = (next) => {
    setView(next);
    try {
      globalThis.localStorage?.setItem(VIEW_KEY, next);
    } catch {
    }
  };
  const [filters, setFilters] = React.useState({});
  const [opened, setOpened] = React.useState();
  const [viewing, setViewing] = React.useState();
  React.useEffect(() => (setFilters({}), setOpened(void 0), setViewing(void 0)), [channel?.id]);
  const steer = (item) => {
    if (!item.thread || !channel || !item.task.buzz_root) return;
    if (props.openThread?.(item.thread)) return;
    const relay = optionalService(ctx, "relay")?.snapshot();
    const navigation = optionalService(ctx, "navigation");
    if (!relay?.viewer || !relay.origin || !navigation) return;
    void navigation.open({ version: 1, kind: "conversation", scope: { viewer: relay.viewer, communityOrigin: relay.origin }, channelId: channel.id, messageId: item.task.buzz_root, threadRootId: item.task.buzz_root, context: "channel" });
  };
  const Boundary = boundary();
  let body;
  if (connection.status !== "connected") body = /* @__PURE__ */ React.createElement(Notice, { title: "Connect Databricks", action: /* @__PURE__ */ React.createElement(Button, { variant: "brand", onClick: () => service.openSettings() }, "Connect") }, "Tasks live in your team's signals hub, a Databricks App.");
  else if (!channel) body = props.noChannel ?? /* @__PURE__ */ React.createElement(Notice, null, "Open this from a channel's menu.");
  else if (hubs.loading || board.loading && !board.data) body = /* @__PURE__ */ React.createElement(Spinner, { label: "Loading tasks" });
  else if (hubs.error || board.error) body = /* @__PURE__ */ React.createElement(Notice, { tone: "danger" }, describeError(hubs.error ?? board.error));
  else if (!hub2) body = /* @__PURE__ */ React.createElement(Notice, { title: "No signals hub in this workspace" }, "Deploy one first (see the Signals plugin's README).");
  else if (!board.data?.tasks.length && !filtered.data?.length) body = /* @__PURE__ */ React.createElement(Text, { tone: "subtle", size: "sm" }, "No tasks in this channel", board.data?.account ? "" : " (set it up as an account from the channel menu)", ".");
  else if (viewing !== void 0 && board.data?.tasks.some((item) => item.task.id === viewing)) {
    const item = board.data.tasks.find((found) => found.task.id === viewing);
    body = /* @__PURE__ */ React.createElement(TaskView, { ctx, hub: hub2, item, channel: channel.id, boardAgents: agents, profile, steer, onChange: refresh, back: () => setViewing(void 0) });
  } else if (board.data) {
    const shown = filterTasks(board.data.tasks, filters);
    const grouped = byStatus(shown);
    const groups = STATUS_GROUPS.filter((group) => !filters.status || group.status === filters.status);
    const task = (item, Item) => /* @__PURE__ */ React.createElement(Item, { key: item.task.id, hub: hub2, item, open: opened === item.task.id, toggle: () => setOpened(opened === item.task.id ? void 0 : item.task.id), profile, steer, onChange: refresh, view: (found) => setViewing(found.task.id), assigning });
    const header = (group) => /* @__PURE__ */ React.createElement(Stack, { direction: "row", gap: 8, align: "center" }, /* @__PURE__ */ React.createElement(StatusIcon, { status: group.status }), /* @__PURE__ */ React.createElement(Text, { size: "sm", weight: 600 }, group.title), /* @__PURE__ */ React.createElement(Text, { size: "xs", tone: "tertiary" }, grouped.get(group.status).length));
    body = /* @__PURE__ */ React.createElement(Stack, { gap: 12 }, /* @__PURE__ */ React.createElement(Toolbar, { tasks: board.data.tasks, filters, setFilters, view, setView: chooseView, profile, shown: shown.length, ...filtered.data && { filtered: filtered.data.length } }), view === "filtered" ? /* @__PURE__ */ React.createElement(FilteredList, { events: filtered.data, loading: filtered.loading, ...filtered.error && { error: filtered.error }, ...filters.search && { search: filters.search } }) : !board.data.tasks.length ? /* @__PURE__ */ React.createElement(Text, { tone: "subtle", size: "sm" }, "No tasks in this channel.") : !shown.length ? /* @__PURE__ */ React.createElement(Text, { tone: "subtle", size: "sm" }, "No tasks match these filters.") : view === "list" ? /* @__PURE__ */ React.createElement("div", { style: { border: "1px solid var(--dbx-border)", borderRadius: 8, overflow: "hidden", minWidth: 0 } }, groups.filter((group) => grouped.get(group.status).length).map((group) => /* @__PURE__ */ React.createElement("section", { key: group.status, "aria-label": group.title }, /* @__PURE__ */ React.createElement("div", { style: { padding: "6px 12px", background: "var(--dbx-inset)", borderBottom: "1px solid var(--dbx-border)" } }, header(group)), grouped.get(group.status).map((item) => task(item, TaskRow))))) : /* @__PURE__ */ React.createElement(Columns, null, groups.map((group) => /* @__PURE__ */ React.createElement("section", { key: group.status, "aria-label": group.title, style: { flex: `0 0 ${COLUMN_WIDTH}px`, minWidth: 0, background: "var(--dbx-inset)", borderRadius: 8, padding: 8, boxSizing: "border-box" } }, /* @__PURE__ */ React.createElement(Stack, { gap: 8 }, /* @__PURE__ */ React.createElement("div", { style: { padding: "2px 4px" } }, header(group)), grouped.get(group.status).map((item) => task(item, TaskCard)))))));
  }
  return (
    // The host gives the tab or page a fixed height and doesn't scroll it, so the board scrolls itself (as the SQL and Genie pages do).
    /* @__PURE__ */ React.createElement(DbxRoot, { style: { minWidth: 0, maxWidth: "100%", width: "100%", height: "100%", overflow: "auto", boxSizing: "border-box" } }, /* @__PURE__ */ React.createElement("div", { style: { padding: 16, minWidth: 0, maxWidth: "100%", boxSizing: "border-box" } }, /* @__PURE__ */ React.createElement(Stack, { gap: 16 }, /* @__PURE__ */ React.createElement("div", { style: { display: "flex", flexWrap: "wrap", alignItems: "flex-end", justifyContent: "space-between", gap: 8, minWidth: 0 } }, /* @__PURE__ */ React.createElement(Stack, { gap: 2, style: { flex: "1 1 240px", minWidth: 0 } }, /* @__PURE__ */ React.createElement(Text, { as: "h3", size: "md", weight: 500, style: { overflowWrap: "anywhere" } }, channel ? `Tasks in #${channel.name ?? "channel"}` : "Tasks"), /* @__PURE__ */ React.createElement(Text, { tone: "subtle", size: "sm", as: "div" }, board.data?.account ? `${board.data.account}: who each task is with and what's been made for it. Open a task to act on it.` : "Who each task is with and what's been made for it. Open a task to act on it.")), /* @__PURE__ */ React.createElement(Stack, { direction: "row", gap: 6, align: "center", wrap: true }, props.action, hub2 && channel && /* @__PURE__ */ React.createElement(Button, { size: "sm", disabled: board.loading, onClick: refresh }, board.loading ? /* @__PURE__ */ React.createElement(Spinner, { size: 10 }) : null, "Refresh"))), /* @__PURE__ */ React.createElement(Boundary, { reset: `${channel?.id}:${viewing}:${view}`, retry: refresh }, body))))
  );
}
function boardPanel(ctx, service) {
  return function BoardPanel({ channelContext, context }) {
    const navigation = optionalService(ctx, "navigation");
    const popOut = channelContext && navigation && /* @__PURE__ */ React.createElement(Button, { size: "sm", title: "Open the board in a full-window page", onClick: () => void navigation.open({ version: 1, kind: "page", pluginId: PLUGIN_ID, pageId: BOARD_PAGE, route: { version: 1, params: { channel: channelContext.channelId, name: channelContext.channelName } } }) }, "Open in full window \u2197");
    return /* @__PURE__ */ React.createElement(
      Board,
      {
        ctx,
        service,
        ...channelContext && { channel: { id: channelContext.channelId, name: channelContext.channelName } },
        openThread: (thread) => Boolean(context?.canOpen(thread) && context.open(thread)),
        action: popOut
      }
    );
  };
}
function boardPage(ctx, service) {
  return function BoardPage(props) {
    const opened = boardRoute(props.navigation?.target);
    const [picked, setPicked] = React.useState();
    React.useEffect(() => setPicked(void 0), [opened.channel]);
    const connection = useConnection(service);
    const accounts = useAsync(async (signal) => {
      if (connection.status !== "connected") return [];
      const found = await chosenHub(service, signal);
      return found?.app ? (await new HubClient(service.client(), found.app).accounts(signal)).filter((account) => account.channel) : [];
    }, [connection.status]);
    const channel = picked ?? (opened.channel ? { id: opened.channel, ...opened.name && { name: opened.name } } : void 0);
    const options = accounts.data ?? [];
    const named = channel && !channel.name ? options.find((account) => account.channel === channel.id) : void 0;
    const shown = channel && { id: channel.id, name: channel.name ?? named?.name ?? "channel" };
    const picker = options.length > 0 && /* @__PURE__ */ React.createElement(
      "select",
      {
        className: "dbx-input",
        "aria-label": "Account channel",
        value: channel?.id ?? "",
        onChange: (event) => {
          const account = options.find((item) => item.channel === event.target.value);
          if (account?.channel) setPicked({ id: account.channel, name: account.name });
        },
        style: { width: "auto", fontSize: "0.75rem" }
      },
      !channel && /* @__PURE__ */ React.createElement("option", { value: "" }, "Choose an account\u2026"),
      channel && !options.some((account) => account.channel === channel.id) && /* @__PURE__ */ React.createElement("option", { value: channel.id }, "#", channel.name ?? channel.id),
      options.map((account) => /* @__PURE__ */ React.createElement("option", { key: account.channel, value: account.channel }, account.name))
    );
    return /* @__PURE__ */ React.createElement(
      Board,
      {
        ctx,
        service,
        ...shown && { channel: shown },
        action: picker,
        noChannel: accounts.loading ? /* @__PURE__ */ React.createElement(Spinner, { label: "Loading accounts" }) : /* @__PURE__ */ React.createElement(Notice, null, options.length ? "Choose an account to see its tasks." : "No account channels yet. Set one up from a channel's menu (Set up account).")
      }
    );
  };
}
function taskPanel(ctx, live) {
  return function TaskPanel({ target, context }) {
    const at = readTaskTarget(target);
    React.useSyncExternalStore(live.subscribe, live.snapshot);
    const connection = useConnection(live.service);
    const [hub2, setHub] = React.useState();
    const [problem, setProblem] = React.useState();
    const [attempt, retry] = React.useReducer((n) => n + 1, 0);
    React.useEffect(() => {
      if (connection.status !== "connected") return;
      let current = true;
      setProblem(void 0);
      live.client().then(
        (found) => current && (found ? setHub(found) : setProblem("There's no signals hub in this workspace.")),
        (error) => current && setProblem(describeError(error))
      );
      return () => void (current = false);
    }, [connection.status, attempt]);
    const entry = at && connection.status === "connected" ? live.board(at.channel) : void 0;
    const item = at ? entry?.board?.tasks.find((found) => found.task.id === at.id) : void 0;
    ctx.panels.useTabTitle?.(at ? `Task ${at.id}` : "Task");
    const agents = item ? [...new Set(item.people.filter((person) => person.kind === "agent").map((person) => person.key))] : [];
    const profile = useProfiles(ctx, agents);
    const steer = (found) => void (found.thread && context?.canOpen(found.thread) && context.open(found.thread));
    let body;
    if (!at) body = /* @__PURE__ */ React.createElement(Notice, { tone: "danger" }, "This link doesn't name a task.");
    else if (connection.status !== "connected") body = /* @__PURE__ */ React.createElement(Notice, { title: "Connect Databricks", action: /* @__PURE__ */ React.createElement(Button, { variant: "brand", onClick: () => live.service.openSettings() }, "Connect") }, "Tasks live in your team's signals hub, a Databricks App.");
    else if (problem || entry?.error && !entry.board) body = /* @__PURE__ */ React.createElement(Notice, { tone: "danger", title: "Couldn't load the task", action: /* @__PURE__ */ React.createElement(Button, { size: "sm", onClick: () => (retry(), void live.load(at.channel)) }, "Try again") }, problem ?? describeError(entry.error));
    else if (!hub2 || !entry?.board) body = /* @__PURE__ */ React.createElement(Spinner, { label: "Loading the task" });
    else if (!item) body = /* @__PURE__ */ React.createElement(Notice, { title: `Task ${at.id} isn't on this channel's board` }, "Done and dismissed tasks leave the board after two weeks.");
    else body = /* @__PURE__ */ React.createElement(TaskView, { ctx, hub: hub2, item, channel: at.channel, boardAgents: agents, profile, steer, onChange: () => void live.load(at.channel) });
    return /* @__PURE__ */ React.createElement(DbxRoot, { style: { minWidth: 0, maxWidth: "100%", width: "100%", height: "100%", overflow: "auto", boxSizing: "border-box" } }, /* @__PURE__ */ React.createElement("div", { style: { padding: 16, minWidth: 0, boxSizing: "border-box" } }, body));
  };
}

// plugins/signals/src/workstream-actions.ts
var plain = ({ recommended: _recommended, ...rest }) => rest;
function startRow(workstream) {
  const entry = catalogFor(workstream);
  return entry ? recommendedRow(entry) : { watch: [], otherwise: "track" };
}
function rowChoices(workstream, row) {
  const builtIn = catalogFor(workstream)?.actions ?? [];
  const ticked = new Map(row.watch.map((item) => [item.id, item]));
  return [
    ...builtIn.map((item) => ({ action: ticked.get(item.id) ?? plain(item), ticked: ticked.has(item.id), custom: false })),
    ...row.watch.filter((item) => !builtIn.some((other) => other.id === item.id)).map((item) => ({ action: item, ticked: true, custom: true }))
  ];
}
function toggle(workstream, row, item, on) {
  if (!on) return { ...row, watch: row.watch.filter((other) => other.id !== item.id) };
  if (row.watch.some((other) => other.id === item.id)) return row;
  const order = rowChoices(workstream, { ...row, watch: [...row.watch, item] }).map((choice) => choice.action.id);
  return { ...row, watch: [...row.watch, item].sort((a, b) => order.indexOf(a.id) - order.indexOf(b.id)) };
}
function retrigger(workstream, row, item, trigger) {
  const next = { ...item, trigger: trigger.trim().slice(0, MAX_ACTION_TRIGGER) };
  return row.watch.some((other) => other.id === item.id) ? { ...row, watch: row.watch.map((other) => other.id === item.id ? next : other) } : toggle(workstream, row, next, true);
}
function newActionId(label2, row, workstream) {
  const base = label2.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 34) || "action";
  const taken = /* @__PURE__ */ new Set([...row.watch.map((item) => item.id), ...(catalogFor(workstream)?.actions ?? []).map((item) => item.id)]);
  let id = base;
  for (let n = 2; taken.has(id); n++) id = `${base}-${n}`;
  return id;
}
function rowSummary(row) {
  if (!row) return "Agents work every task";
  const otherwise = row.otherwise === "dismiss" ? "otherwise dismiss" : "otherwise track";
  if (!row.watch.length) return row.otherwise === "dismiss" ? "Dismiss everything" : "Track only";
  if (row.watch.some((item) => item.always)) return `Work every task${row.watch.length > 1 ? ` \xB7 also watch for ${row.watch.length - 1}` : ""}`;
  return `Watch for ${row.watch.length} \xB7 ${otherwise}`;
}
var MODE_LINE2 = (workstream) => new RegExp(`^(\\s*(?:[-*]\\s*)?)${workstream.trim().replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*:\\s*\\S+\\s*$`, "gim");
function withMode(preferences, workstream, mode, modes) {
  const pattern = MODE_LINE2(workstream);
  const setsMode = (line3) => new RegExp(`:\\s*(${modes.join("|")})[.,;]?\\s*$`, "i").test(line3);
  if (preferences.match(pattern)?.some(setsMode)) {
    const lines2 = preferences.split("\n");
    const line3 = (text) => new RegExp(pattern.source, "i").test(text) && setsMode(text);
    if (!mode) return lines2.filter((text) => !line3(text)).join("\n");
    return lines2.map((text) => line3(text) ? text.replace(new RegExp(pattern.source, "i"), `$1${workstream.trim()}: ${mode}`) : text).join("\n");
  }
  if (!mode) return preferences;
  const lines = preferences.split("\n");
  const isMode = (line3) => new RegExp(`^\\s*(?:[-*]\\s+)?[^:]{1,80}:\\s*(${modes.join("|")})\\s*$`, "i").test(line3);
  const last = lines.reduce((at, line3, index) => isMode(line3) ? index : at, -1);
  const line2 = `- ${workstream.trim()}: ${mode}`;
  if (last < 0) return [line2, ...preferences.trim() ? ["", preferences] : []].join("\n");
  lines.splice(last + 1, 0, line2);
  return lines.join("\n");
}

// plugins/signals/src/workstream-rows.tsx
var MODE_LABEL = { auto: "Auto", draft: "Draft", ask: "Ask", off: "Off" };
var MODE_HINT = { auto: "Agents do it and report", draft: "Agents prepare it, a person sends it", ask: "Agents ask before doing anything", off: "No tasks" };
var LINK_BUTTON = { border: 0, background: "transparent", padding: 0, cursor: "pointer", fontSize: "0.75rem" };
function ModeMenu(props) {
  const shown = props.value ?? props.inherited;
  return /* @__PURE__ */ React.createElement(
    "select",
    {
      className: "dbx-select",
      "aria-label": props.label,
      title: shown ? MODE_HINT[shown] : void 0,
      value: props.value ?? "",
      onChange: (event) => props.onChange(event.target.value || null),
      style: { width: "auto", minHeight: 26, padding: "2px 26px 2px 9px", fontSize: "0.75rem", fontWeight: 500, backgroundPosition: "right 9px center", flex: "none" }
    },
    props.inherited && /* @__PURE__ */ React.createElement("option", { value: "" }, `${MODE_LABEL[props.inherited]} (default)`),
    MODES.map((mode) => /* @__PURE__ */ React.createElement("option", { key: mode, value: mode }, MODE_LABEL[mode]))
  );
}
function AgentChip(props) {
  const name = props.source.name(props.agentKey);
  const missing2 = !props.source.inChannel(props.agentKey);
  return /* @__PURE__ */ React.createElement(
    "span",
    {
      className: "dbx-chip",
      title: missing2 ? `${name} isn't in #${props.source.channel} yet. Saving adds it.` : name,
      style: { maxWidth: 180, padding: "2px 2px 2px 3px", gap: 5, ...missing2 && { borderStyle: "dashed", background: "transparent" } }
    },
    /* @__PURE__ */ React.createElement(AssigneeMark, { assignee: { kind: "agent", key: props.agentKey, label: name }, profile: props.source.profile, size: 16 }),
    /* @__PURE__ */ React.createElement("span", null, name),
    missing2 && /* @__PURE__ */ React.createElement("span", { "aria-hidden": true, style: { color: "var(--dbx-warning)", fontSize: "0.6875rem" } }, "+"),
    /* @__PURE__ */ React.createElement("button", { type: "button", "aria-label": `Take ${name} off ${props.owner}`, onClick: props.onRemove, style: { fontSize: "0.875rem", padding: "0 4px" } }, "\xD7")
  );
}
function InheritedMarks(props) {
  const names = props.keys.map(props.source.name);
  return /* @__PURE__ */ React.createElement("span", { title: `From every workstream: ${names.join(", ")}`, "aria-label": `From every workstream: ${names.join(", ")}`, style: { display: "inline-flex", alignItems: "center", opacity: 0.5, flex: "none" } }, props.keys.slice(0, 4).map((key, at) => /* @__PURE__ */ React.createElement("span", { key, "aria-hidden": true, style: { marginLeft: at ? -4 : 0, borderRadius: 6, boxShadow: "0 0 0 2px var(--dbx-surface)", display: "inline-flex" } }, /* @__PURE__ */ React.createElement(AssigneeMark, { assignee: { kind: "agent", key, label: props.source.name(key) }, profile: props.source.profile, size: props.size ?? 18 }))));
}
function AgentsPicker(props) {
  const [open, setOpen] = React.useState(false);
  const [query, setQuery] = React.useState("");
  const [active, setActive] = React.useState(0);
  const anchor = React.useRef(null);
  const trigger = React.useRef(null);
  const list = React.useId();
  const groups = filterGroups(props.source.groups, query);
  const options = groups.flatMap((group) => group.options);
  const full = props.value.length >= MAX_ROW_AGENTS;
  const close = React.useCallback((refocus) => {
    setOpen(false);
    setQuery("");
    setActive(0);
    if (refocus) trigger.current?.focus();
  }, []);
  React.useEffect(() => {
    if (!open) return;
    const outside = (event) => anchor.current && !anchor.current.contains(event.target) && close(false);
    document.addEventListener("mousedown", outside);
    return () => document.removeEventListener("mousedown", outside);
  }, [open, close]);
  React.useEffect(() => {
    if (open) anchor.current?.querySelector(`#${CSS.escape(`${list}-${active}`)}`)?.scrollIntoView?.({ block: "nearest" });
  }, [open, active, list]);
  const pick = (key) => {
    if (props.value.includes(key)) props.onChange(props.value.filter((other) => other !== key));
    else if (!full) props.onChange([...props.value, key]);
  };
  const keys = (event) => {
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      if (options.length) setActive((at) => (at + (event.key === "ArrowDown" ? 1 : options.length - 1)) % options.length);
    } else if (event.key === "Enter") {
      event.preventDefault();
      event.stopPropagation();
      const option = options[Math.min(active, options.length - 1)];
      if (option) pick(option.key);
    } else if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      close(true);
    }
  };
  let index = -1;
  return /* @__PURE__ */ React.createElement("div", { ref: anchor, className: "dbx-picker-anchor", style: { minWidth: 0 } }, /* @__PURE__ */ React.createElement("div", { style: { display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap", minWidth: 0 } }, props.value.map((key) => /* @__PURE__ */ React.createElement(AgentChip, { key, agentKey: key, source: props.source, owner: props.name, onRemove: () => props.onChange(props.value.filter((other) => other !== key)) })), props.value.length === 0 && props.inherited?.length ? /* @__PURE__ */ React.createElement(InheritedMarks, { keys: props.inherited, source: props.source }) : null, props.value.length === 0 && !props.inherited?.length && props.empty && /* @__PURE__ */ React.createElement(Text, { size: "xs", tone: "tertiary" }, props.empty), /* @__PURE__ */ React.createElement(
    "button",
    {
      ref: trigger,
      type: "button",
      className: "dbx-btn",
      "data-variant": "ghost",
      "data-size": "sm",
      "aria-haspopup": "listbox",
      "aria-expanded": open,
      "aria-label": `Add an agent to ${props.name}`,
      onClick: () => open ? close(false) : setOpen(true),
      style: { gap: 4, color: "var(--dbx-subtle)", minHeight: 22, padding: "0 6px" }
    },
    /* @__PURE__ */ React.createElement("span", { "aria-hidden": true, style: { fontWeight: 600 } }, "@"),
    " Add agent"
  )), open && /* @__PURE__ */ React.createElement("div", { className: "dbx-picker", "data-floating": "", style: { minWidth: 240 }, onKeyDown: keys }, /* @__PURE__ */ React.createElement(
    "input",
    {
      className: "dbx-input",
      autoFocus: true,
      role: "combobox",
      "aria-expanded": true,
      "aria-controls": list,
      "aria-activedescendant": options.length ? `${list}-${Math.min(active, options.length - 1)}` : void 0,
      "aria-label": `Search agents for ${props.name}`,
      placeholder: "@ Search agents or teams",
      value: query,
      onChange: (event) => (setQuery(event.target.value), setActive(0))
    }
  ), /* @__PURE__ */ React.createElement("div", { id: list, className: "dbx-picker-list", role: "listbox", "aria-multiselectable": true, "aria-label": "Agents", style: { maxHeight: 280 } }, groups.length === 0 && /* @__PURE__ */ React.createElement(Text, { size: "sm", tone: "subtle", as: "div", style: { padding: "8px 10px" } }, query ? `No agent matches \u201C${query.replace(/^@/, "")}\u201D.` : "No agents yet. Add one to this channel, or make one on the Agents page."), groups.map((group) => {
    const rest = group.options.filter((option) => !props.value.includes(option.key));
    return /* @__PURE__ */ React.createElement("div", { key: group.id, role: "group", "aria-label": group.title }, /* @__PURE__ */ React.createElement("div", { className: "dbx-picker-group", style: { display: "flex", gap: 8, alignItems: "center" } }, /* @__PURE__ */ React.createElement("span", { style: { flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }, title: group.title }, group.title), group.team && rest.length > 1 && /* @__PURE__ */ React.createElement("button", { type: "button", className: "dbx-link", tabIndex: -1, disabled: full, onMouseDown: (event) => event.preventDefault(), onClick: () => props.onChange(withTeam(props.value, rest.map((option) => option.key))), style: { ...LINK_BUTTON, fontSize: "0.6875rem", textTransform: "none", letterSpacing: 0 } }, "Add all ", rest.length)), group.options.map((option) => {
      const at = ++index;
      const selected = props.value.includes(option.key);
      return /* @__PURE__ */ React.createElement(
        "div",
        {
          key: option.key,
          id: `${list}-${at}`,
          role: "option",
          "aria-selected": selected,
          "aria-disabled": !selected && full,
          className: "dbx-picker-option",
          "data-active": at === Math.min(active, options.length - 1) || void 0,
          onMouseDown: (event) => event.preventDefault(),
          onMouseMove: () => at !== active && setActive(at),
          onClick: () => pick(option.key),
          style: { alignItems: "center", ...at === Math.min(active, options.length - 1) && { background: "var(--dbx-inset)" }, ...!selected && full && { opacity: 0.55, cursor: "default" } }
        },
        /* @__PURE__ */ React.createElement("span", { className: "dbx-picker-check", "aria-hidden": true }, selected ? "\u2713" : ""),
        /* @__PURE__ */ React.createElement(AssigneeMark, { assignee: { kind: "agent", key: option.key, label: option.name }, profile: props.source.profile, size: 20 }),
        /* @__PURE__ */ React.createElement("span", { className: "dbx-picker-text", style: { flexDirection: "row", alignItems: "baseline", gap: 6 } }, /* @__PURE__ */ React.createElement("span", { style: { overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", fontWeight: 500 }, title: option.name }, option.name)),
        !option.inChannel && /* @__PURE__ */ React.createElement("span", { className: "dbx-picker-meta", style: { fontFamily: "inherit" }, title: `Saving adds it to #${props.source.channel}` }, "Not in channel")
      );
    }));
  })), full && /* @__PURE__ */ React.createElement(Text, { size: "xs", tone: "subtle", as: "div", style: { padding: "6px 10px", borderTop: "1px solid var(--dbx-border)" } }, `At most ${MAX_ROW_AGENTS} agents here. Take one off to add another.`)));
}
function ActionLine(props) {
  const { item } = props;
  const [editing, setEditing] = React.useState(false);
  const [text, setText] = React.useState(item.trigger);
  const edit = React.useRef(null);
  const input = React.useRef(null);
  const reopened = React.useRef(false);
  React.useEffect(() => {
    if (editing) input.current?.focus();
    else if (reopened.current) edit.current?.focus();
    reopened.current = false;
  }, [editing]);
  const close = (save) => {
    if (save && text.trim() && text.trim() !== item.trigger) props.onTrigger(text);
    if (!save) setText(item.trigger);
    reopened.current = true;
    setEditing(false);
  };
  const id = `${props.workstream}-${item.id}`.replace(/\W+/g, "-");
  return /* @__PURE__ */ React.createElement("div", { style: { display: "flex", gap: 8, alignItems: "flex-start", minWidth: 0 } }, /* @__PURE__ */ React.createElement("input", { id, type: "checkbox", checked: props.ticked, onChange: (event) => props.onTick(event.target.checked), style: { marginTop: 3, flex: "none" } }), /* @__PURE__ */ React.createElement("div", { style: { minWidth: 0, flex: 1 } }, /* @__PURE__ */ React.createElement("label", { htmlFor: id, style: { cursor: "pointer" } }, /* @__PURE__ */ React.createElement(Text, { size: "sm", weight: 500, tone: props.ticked ? void 0 : "subtle" }, item.label), props.custom && /* @__PURE__ */ React.createElement(Text, { size: "xs", tone: "tertiary" }, " \xB7 your own")), item.always ? /* @__PURE__ */ React.createElement(Text, { size: "xs", tone: "tertiary", as: "div" }, "When: always, on every task") : editing ? (
    // Not a <form>: this sits inside the account form, and a nested form's submit would save (or reload) that one.
    /* @__PURE__ */ React.createElement("div", { role: "group", "aria-label": `When to ${item.label.toLowerCase()}`, style: { display: "flex", gap: 6, flexWrap: "wrap", marginTop: 2 } }, /* @__PURE__ */ React.createElement(
      "input",
      {
        ref: input,
        className: "dbx-input",
        "aria-label": `When to ${item.label.toLowerCase()}`,
        maxLength: MAX_ACTION_TRIGGER,
        value: text,
        onChange: (event) => setText(event.target.value),
        onKeyDown: (event) => {
          if (event.key === "Escape") event.preventDefault(), event.stopPropagation(), close(false);
          else if (event.key === "Enter") event.preventDefault(), event.stopPropagation(), text.trim() && close(true);
        },
        style: { flex: "1 1 220px", minWidth: 0, fontSize: "0.75rem" }
      }
    ), /* @__PURE__ */ React.createElement(Button, { size: "sm", disabled: !text.trim(), onClick: () => close(true) }, "Save trigger"), /* @__PURE__ */ React.createElement(Button, { size: "sm", variant: "ghost", onClick: () => close(false) }, "Cancel"))
  ) : /* @__PURE__ */ React.createElement("div", { style: { display: "flex", gap: 6, alignItems: "baseline", minWidth: 0 } }, /* @__PURE__ */ React.createElement(Text, { size: "xs", tone: "tertiary", style: { minWidth: 0, flex: 1, overflowWrap: "anywhere" } }, "When: ", item.trigger), /* @__PURE__ */ React.createElement("button", { ref: edit, type: "button", className: "dbx-link", "aria-label": `Edit when to ${item.label.toLowerCase()}`, onClick: () => (setText(item.trigger), setEditing(true)), style: { border: 0, background: "transparent", padding: 0, cursor: "pointer", fontSize: "0.75rem", flex: "none" } }, "Edit"))));
}
function AddAction(props) {
  const [open, setOpen] = React.useState(false);
  const [label2, setLabel] = React.useState("");
  const [trigger, setTrigger] = React.useState("");
  const opener = React.useRef(null);
  const first = React.useRef(null);
  const was = React.useRef(false);
  React.useEffect(() => {
    if (open) first.current?.focus();
    else if (was.current) opener.current?.parentElement?.querySelector("button[data-add-action]")?.focus();
    was.current = open;
  }, [open]);
  if (!open)
    return /* @__PURE__ */ React.createElement("span", { ref: opener }, /* @__PURE__ */ React.createElement("button", { type: "button", "data-add-action": true, className: "dbx-link", disabled: props.disabled, title: props.disabled ? `A workstream has at most ${MAX_ACTIONS} actions` : void 0, onClick: () => setOpen(true), style: { border: 0, background: "transparent", padding: 0, cursor: "pointer", fontSize: "0.75rem" } }, "+ Add action"));
  const add = () => {
    if (!label2.trim() || !trigger.trim()) return;
    props.onAdd(label2.trim(), trigger.trim());
    setLabel("");
    setTrigger("");
    setOpen(false);
  };
  return (
    // Not a <form>: it sits inside the account form (see ActionLine). Enter, with or without ⌘, adds the action.
    /* @__PURE__ */ React.createElement(
      "div",
      {
        ref: opener,
        role: "group",
        "aria-label": "Add your own action",
        onKeyDown: (event) => {
          if (event.key === "Escape") event.preventDefault(), event.stopPropagation(), setOpen(false);
          else if (event.key === "Enter" && event.target instanceof HTMLInputElement) event.preventDefault(), event.stopPropagation(), add();
        },
        style: { display: "flex", gap: 6, flexWrap: "wrap", alignItems: "center" }
      },
      /* @__PURE__ */ React.createElement("input", { ref: first, className: "dbx-input", "aria-label": "What agents do", placeholder: "What agents do, e.g. Loop in the CSM", maxLength: MAX_ACTION_LABEL, value: label2, onChange: (event) => setLabel(event.target.value.replace(/—/g, "-")), style: { flex: "1 1 160px", minWidth: 0, fontSize: "0.75rem" } }),
      /* @__PURE__ */ React.createElement("input", { className: "dbx-input", "aria-label": "When", placeholder: "When, e.g. the customer mentions renewal", maxLength: MAX_ACTION_TRIGGER, value: trigger, onChange: (event) => setTrigger(event.target.value), style: { flex: "2 1 220px", minWidth: 0, fontSize: "0.75rem" } }),
      /* @__PURE__ */ React.createElement(Button, { size: "sm", disabled: !label2.trim() || !trigger.trim(), onClick: add }, "Add action"),
      /* @__PURE__ */ React.createElement(Button, { size: "sm", variant: "ghost", onClick: () => setOpen(false) }, "Cancel")
    )
  );
}
function Actions(props) {
  const { name, value } = props;
  const box = React.useRef(null);
  const moved = React.useRef(false);
  const set = Boolean(value);
  React.useEffect(() => {
    if (!moved.current) return;
    moved.current = false;
    box.current?.querySelector(set ? "input[type=checkbox], button[data-add-action]" : "button")?.focus();
  }, [set]);
  if (!value)
    return /* @__PURE__ */ React.createElement("div", { ref: box }, /* @__PURE__ */ React.createElement(Stack, { direction: "row", gap: 8, align: "center", wrap: true }, /* @__PURE__ */ React.createElement(Text, { size: "xs", tone: "subtle", style: { flex: "1 1 160px" } }, "Agents work every task. Pick what they watch for to have them act only when it matters."), /* @__PURE__ */ React.createElement(Button, { size: "sm", onClick: () => (moved.current = true, props.onChange(startRow(name))), title: "Start with the usual actions for this kind of work" }, "Choose actions")));
  const choices = rowChoices(name, value);
  const group = `${name}-otherwise`.replace(/\W+/g, "-");
  return /* @__PURE__ */ React.createElement("div", { ref: box }, /* @__PURE__ */ React.createElement(Stack, { gap: 10 }, /* @__PURE__ */ React.createElement(Stack, { gap: 6 }, /* @__PURE__ */ React.createElement(Text, { size: "xs", weight: 600 }, "Watch for"), /* @__PURE__ */ React.createElement(Text, { size: "xs", tone: "tertiary" }, "Agents check each update against every ticked action."), choices.map((choice) => /* @__PURE__ */ React.createElement(
    ActionLine,
    {
      key: choice.action.id,
      workstream: name,
      item: choice.action,
      ticked: choice.ticked,
      custom: choice.custom,
      onTick: (on) => props.onChange(toggle(name, value, choice.action, on)),
      onTrigger: (text) => props.onChange(retrigger(name, value, choice.action, text))
    }
  )), choices.length === 0 && /* @__PURE__ */ React.createElement(Text, { size: "xs", tone: "subtle" }, "No usual actions for this kind of work. Add your own."), /* @__PURE__ */ React.createElement(AddAction, { disabled: value.watch.length >= MAX_ACTIONS, onAdd: (label2, trigger) => props.onChange(toggle(name, value, { id: newActionId(label2, value, name), label: label2, trigger }, true)) })), /* @__PURE__ */ React.createElement("fieldset", { style: { border: 0, margin: 0, padding: 0, minWidth: 0 } }, /* @__PURE__ */ React.createElement("legend", { style: { padding: 0 } }, /* @__PURE__ */ React.createElement(Text, { size: "xs", weight: 600 }, "Otherwise")), /* @__PURE__ */ React.createElement(Stack, { gap: 4, style: { marginTop: 4 } }, ["track", "dismiss"].map((option) => /* @__PURE__ */ React.createElement("label", { key: option, style: { display: "inline-flex", gap: 6, alignItems: "baseline", cursor: "pointer" } }, /* @__PURE__ */ React.createElement("input", { type: "radio", name: group, checked: value.otherwise === option, onChange: () => props.onChange({ ...value, otherwise: option }) }), /* @__PURE__ */ React.createElement("span", null, /* @__PURE__ */ React.createElement(Text, { size: "sm" }, option === "track" ? "Track" : "Dismiss"), /* @__PURE__ */ React.createElement(Text, { size: "xs", tone: "tertiary" }, " ", option === "track" ? "\xB7 keep it open, no agents" : "\xB7 record it and fold it away; it reopens if a trigger applies later")))))), /* @__PURE__ */ React.createElement("div", null, /* @__PURE__ */ React.createElement("button", { type: "button", className: "dbx-link", onClick: () => (moved.current = true, props.onChange(null)), style: { border: 0, background: "transparent", padding: 0, cursor: "pointer", fontSize: "0.75rem", color: "var(--dbx-tertiary)" }, title: "Agents work every task again, as before" }, "Stop using actions"))));
}
function RowFrame(props) {
  return /* @__PURE__ */ React.createElement("div", { style: { borderTop: "1px solid var(--dbx-border)", padding: "12px 0", minWidth: 0, display: "flex", flexDirection: "column", gap: 8 } }, /* @__PURE__ */ React.createElement("div", { style: { display: "flex", gap: 8, alignItems: "center", minWidth: 0 } }, /* @__PURE__ */ React.createElement("div", { style: { flex: 1, minWidth: 0 } }, /* @__PURE__ */ React.createElement(Text, { size: "md", weight: 600, as: "div", style: { overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" } }, props.title), props.subtitle && /* @__PURE__ */ React.createElement(Text, { size: "xs", tone: "tertiary", as: "div" }, props.subtitle)), props.mode), props.children);
}
function EveryRow(props) {
  return /* @__PURE__ */ React.createElement(
    RowFrame,
    {
      title: "Every workstream",
      subtitle: "Unless a workstream below sets its own",
      mode: /* @__PURE__ */ React.createElement(ModeMenu, { label: "Mode for every workstream", value: props.mode, inherited: props.defaultMode, onChange: props.onMode })
    },
    /* @__PURE__ */ React.createElement(AgentsPicker, { name: "every workstream", empty: "No agents: tasks wait for a person", value: props.agents, source: props.source, onChange: props.onAgents })
  );
}
function WorkstreamRow(props) {
  const { name, value } = props;
  const [open, setOpen] = React.useState(Boolean(props.defaultOpen));
  const mode = value.mode ?? value.inherited;
  const summary = mode === "off" ? "No tasks" : [value.actions ? rowSummary(value.actions) : void 0, value.playbook.trim() ? "playbook" : void 0].filter(Boolean).join(" \xB7 ");
  const panel = `ws-${name}`.replace(/\W+/g, "-");
  return /* @__PURE__ */ React.createElement(
    RowFrame,
    {
      title: /* @__PURE__ */ React.createElement("span", { title: name }, name),
      ...summary && { subtitle: /* @__PURE__ */ React.createElement("span", { title: summary }, summary) },
      mode: /* @__PURE__ */ React.createElement(ModeMenu, { label: `Mode for ${name}`, value: value.mode, inherited: value.inherited, onChange: (next) => props.onChange({ mode: next }) })
    },
    /* @__PURE__ */ React.createElement("div", { style: { display: "flex", gap: 8, alignItems: "flex-start", minWidth: 0 } }, /* @__PURE__ */ React.createElement("div", { style: { flex: 1, minWidth: 0 } }, mode !== "off" && /* @__PURE__ */ React.createElement(AgentsPicker, { name, inherited: props.inheritedAgents, value: value.agents, source: props.source, onChange: (agents) => props.onChange({ agents }) })), /* @__PURE__ */ React.createElement(
      "button",
      {
        type: "button",
        className: "dbx-btn",
        "data-variant": "ghost",
        "data-size": "sm",
        "aria-expanded": open,
        "aria-controls": panel,
        "aria-label": `Details for ${name}`,
        onClick: () => setOpen(!open),
        style: { gap: 4, color: "var(--dbx-subtle)", minHeight: 22, padding: "0 6px", flex: "none" }
      },
      "Details ",
      /* @__PURE__ */ React.createElement("span", { "aria-hidden": true, style: { fontSize: "0.625rem" } }, open ? "\u25B4" : "\u25BE")
    )),
    open && /* @__PURE__ */ React.createElement("div", { id: panel, style: { background: "var(--dbx-inset)", borderRadius: "var(--dbx-radius)", padding: 12, minWidth: 0 } }, /* @__PURE__ */ React.createElement(Stack, { gap: 14 }, mode === "off" ? /* @__PURE__ */ React.createElement(Text, { size: "xs", tone: "subtle" }, "Mode is off: this kind of work opens no tasks, so there's nothing to watch for.") : /* @__PURE__ */ React.createElement(Actions, { name, ...value.actions && { value: value.actions }, onChange: (actions) => props.onChange({ actions }) }), /* @__PURE__ */ React.createElement(Stack, { gap: 4 }, /* @__PURE__ */ React.createElement(Text, { size: "xs", weight: 600 }, "Playbook"), /* @__PURE__ */ React.createElement("textarea", { className: "dbx-textarea", "aria-label": `Playbook for ${name}`, rows: 3, maxLength: MAX_PLAYBOOK, placeholder: `How you like ${name} done: steps, what to include, tone, who to copy\u2026`, value: value.playbook, onChange: (event) => props.onChange({ playbook: event.target.value }) }))))
  );
}

// plugins/signals/src/account-panel.tsx
var PREFERENCES_TEMPLATE = `How agents handle each kind of work: auto (do it and report), draft (prepare it for one of us to send), ask (ask first) or off (no tasks).

- everything: draft
- meeting prep: auto

Anything else you write here is guidance agents follow, for example:
Keep customer replies short. Copy the account owner on anything about pricing.`;
var idsText = (ids) => Object.entries(ids ?? {}).map(([kind, values]) => `${kind}: ${values.join(", ")}`).join("\n");
var parseIds = (text) => {
  const out = {};
  for (const line2 of text.split("\n")) {
    const at = line2.indexOf(":");
    if (!line2.trim()) continue;
    const kind = (at < 0 ? line2 : line2.slice(0, at)).trim();
    out[kind] = [...out[kind] ?? [], ...at < 0 ? [] : line2.slice(at + 1).split(",").map((id) => id.trim()).filter(Boolean)];
  }
  return out;
};
var keyIn = (map, name) => Object.keys(map).find((key) => key.toLowerCase() === name.toLowerCase());
function withEntry(map, name, value) {
  const key = keyIn(map, name) ?? name;
  const { [key]: _, ...rest } = map;
  return value === void 0 ? rest : { ...rest, [key]: value };
}
function workstreamNames(configured, ...maps) {
  const out = [];
  for (const name of [...configured, ...maps.flat()]) if (name.trim() && name.toLowerCase() !== "everything" && !out.some((other) => other.toLowerCase() === name.toLowerCase())) out.push(name);
  return out;
}
var NO_AGENTS = [];
var NO_TEAMS = [];
function useOwnAgents(live) {
  const service = React.useSyncExternalStore(live?.subscribe ?? NO_SUBSCRIBE, live?.snapshot ?? NO_SERVICE);
  const [, bump] = React.useReducer((n) => n + 1, 0);
  React.useEffect(() => {
    try {
      return service?.subscribe(bump);
    } catch {
      return void 0;
    }
  }, [service]);
  let read;
  try {
    read = service?.snapshot();
  } catch {
    read = void 0;
  }
  const agents = read?.agents;
  const own = React.useMemo(() => (agents ?? NO_AGENTS).filter((agent) => !("deleting" in agent && agent.deleting) && !("unfinished" in agent && agent.unfinished)), [agents]);
  return { own, teams: read?.teams ?? NO_TEAMS };
}
var NO_SUBSCRIBE = () => () => {
};
var NO_SERVICE = () => void 0;
var cleanDomain = (text) => text.trim().toLowerCase().replace(/^@/, "");
function withTyped(value, raw, clean = (text) => text.trim()) {
  const next = [...value];
  for (const item of raw.split(/[,\n]/).map(clean).filter(Boolean)) if (!next.some((other) => other.toLowerCase() === item.toLowerCase())) next.push(item);
  return next.length === value.length ? value : next;
}
function TokenInput(props) {
  const { text, onText: setText } = props;
  const input = React.useRef(null);
  const add = (raw) => {
    const next = withTyped(props.value, raw, props.clean);
    if (next !== props.value) props.onChange(next);
    setText("");
  };
  return /* @__PURE__ */ React.createElement(
    "div",
    {
      className: "dbx-input",
      onClick: () => input.current?.focus(),
      style: { display: "flex", flexWrap: "wrap", gap: 4, alignItems: "center", padding: "3px 6px", minHeight: 32, cursor: "text" }
    },
    props.value.map((item) => /* @__PURE__ */ React.createElement("span", { key: item, className: "dbx-chip", title: item }, /* @__PURE__ */ React.createElement("span", null, item), /* @__PURE__ */ React.createElement("button", { type: "button", "aria-label": `Remove ${item}`, onClick: (event) => (event.stopPropagation(), props.onChange(props.value.filter((other) => other !== item))) }, "\xD7"))),
    /* @__PURE__ */ React.createElement(
      "input",
      {
        ref: input,
        "aria-label": props.label,
        placeholder: props.value.length ? "" : props.placeholder,
        value: text,
        onChange: (event) => /[,\n]/.test(event.target.value) ? add(event.target.value) : setText(event.target.value),
        onKeyDown: (event) => {
          if (event.key === "Enter" && !event.metaKey && !event.ctrlKey && text.trim()) event.preventDefault(), add(text);
          else if (event.key === "Backspace" && !text && props.value.length) props.onChange(props.value.slice(0, -1));
        },
        onBlur: () => text.trim() && add(text),
        style: { flex: "1 1 60px", minWidth: 60, border: 0, outline: "none", background: "transparent", font: "inherit", color: "inherit", padding: "3px 2px" }
      }
    )
  );
}
function Section2(props) {
  const id = React.useId();
  return /* @__PURE__ */ React.createElement("section", { "aria-labelledby": id, style: { display: "flex", flexDirection: "column", gap: 12, padding: props.first ? "4px 0 20px" : "20px 0", borderTop: props.first ? void 0 : "1px solid var(--dbx-border)", minWidth: 0 } }, /* @__PURE__ */ React.createElement("div", { style: { display: "flex", flexDirection: "column", gap: 2 } }, /* @__PURE__ */ React.createElement(Text, { as: "h3", id, size: "lg", weight: 600 }, props.title), props.description && /* @__PURE__ */ React.createElement(Text, { size: "sm", tone: "subtle", as: "div" }, props.description)), props.children);
}
var AddWorkstream = (props) => {
  const [open, setOpen] = React.useState(false);
  const [adding, setAdding] = React.useState("");
  const opener = React.useRef(null);
  const was = React.useRef(false);
  React.useEffect(() => {
    if (!open && was.current) opener.current?.focus();
    was.current = open;
  }, [open]);
  if (!open)
    return /* @__PURE__ */ React.createElement("div", { style: { borderTop: "1px solid var(--dbx-border)", paddingTop: 12 } }, /* @__PURE__ */ React.createElement("button", { ref: opener, type: "button", className: "dbx-btn", "data-variant": "ghost", "data-size": "sm", onClick: () => setOpen(true), style: { color: "var(--dbx-subtle)" } }, "+ Add workstream"));
  const add = () => {
    if (!adding.trim()) return;
    props.onAdd(adding.trim());
    setAdding("");
    setOpen(false);
  };
  return (
    // Not a <form>: it sits inside the account form. Enter, with or without ⌘, adds the workstream.
    /* @__PURE__ */ React.createElement(
      "div",
      {
        role: "group",
        "aria-label": "Add a workstream",
        onKeyDown: (event) => {
          if (event.key === "Escape") event.preventDefault(), event.stopPropagation(), setOpen(false);
          else if (event.key === "Enter" && event.target instanceof HTMLInputElement) event.preventDefault(), event.stopPropagation(), add();
        },
        style: { display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap", borderTop: "1px solid var(--dbx-border)", paddingTop: 12 }
      },
      /* @__PURE__ */ React.createElement("input", { className: "dbx-input", autoFocus: true, "aria-label": "Workstream or rule id", placeholder: "A workstream your rules use, or a rule id", value: adding, maxLength: 80, onChange: (event) => setAdding(event.target.value), style: { flex: "1 1 180px", minWidth: 0 } }),
      /* @__PURE__ */ React.createElement(Button, { size: "sm", disabled: !adding.trim(), onClick: add }, "Add"),
      /* @__PURE__ */ React.createElement(Button, { size: "sm", variant: "ghost", onClick: () => setOpen(false) }, "Cancel")
    )
  );
};
function useAgentSource(ctx, live, channel, named) {
  const members = useMembers(ctx, channel.id);
  const { own, teams } = useOwnAgents(live);
  const keys = [.../* @__PURE__ */ new Set([...members, ...named, ...own.map((agent) => agent.pubkey), ...teams.flatMap((team) => team.members)])];
  const profiles = useProfiles(ctx, keys);
  const ownBy = new Map(own.map((agent) => [agent.pubkey, agent]));
  const profile = (key) => {
    const found = profiles(key);
    const mine = ownBy.get(key);
    return mine ? { name: found?.name ?? mine.name, ...(found?.picture ?? mine.picture) && { picture: found?.picture ?? mine.picture }, agent: true } : found;
  };
  const name = (key) => profile(key)?.name ?? `${key.slice(0, 8)}\u2026`;
  const choices = memberChoices(members, [], [], profile);
  const inChannel = new Set(members);
  return {
    members,
    groups: agentGroups({ channelAgents: choices.filter((member) => member.agent).map((member) => member.key), members, own, teams, name }),
    profile,
    name,
    inChannel: (key) => inChannel.has(key),
    channel: channel.name
  };
}
function Form(props) {
  const { hub: hub2, channel, account } = props;
  const [name, setName] = React.useState(account?.name ?? channel.name.replace(/[-_]+/g, " "));
  const [aliases, setAliases] = React.useState(account?.aliases ?? []);
  const [domains, setDomains] = React.useState(account?.domains ?? []);
  const [aliasText, setAliasText] = React.useState("");
  const [domainText, setDomainText] = React.useState("");
  const [ids, setIds] = React.useState(idsText(account?.ids));
  const [agents, setAgents] = React.useState(account?.agents ?? []);
  const [preferences, setPreferences] = React.useState(account?.preferences ?? PREFERENCES_TEMPLATE);
  const [playbooks, setPlaybooks] = React.useState({ ...account?.playbooks ?? {} });
  const [workstreamAgents, setWorkstreamAgents] = React.useState({ ...account?.workstream_agents ?? {} });
  const [actions, setActions] = React.useState({ ...account?.workstream_actions ?? {} });
  const [added, setAdded] = React.useState([]);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState();
  const [discarding, setDiscarding] = React.useState(false);
  const read = React.useMemo(() => parsePreferences(preferences), [preferences]);
  const source = useAgentSource(props.ctx, props.agents, channel, [...agents, ...Object.values(workstreamAgents).flat()]);
  const writes = useRelay(props.ctx).session?.channelWrites;
  const inherited = read.modes.everything ?? DEFAULT_MODE;
  const names = workstreamNames(props.workstreams ?? account?.workstreams ?? [], Object.keys(read.modes), Object.keys(actions), Object.keys(workstreamAgents), Object.keys(playbooks), added);
  const typedAliases = withTyped(aliases, aliasText);
  const typedDomains = withTyped(domains, domainText, cleanDomain);
  const state = JSON.stringify([name, typedAliases, typedDomains, ids, agents, preferences, playbooks, workstreamAgents, actions]);
  const [initial] = React.useState(state);
  const dirty = state !== initial;
  const change = (workstream, next) => {
    if (next.mode !== void 0) setPreferences((text) => withMode(text, workstream, next.mode ?? void 0, MODES));
    if (next.agents) setWorkstreamAgents((map) => withEntry(map, workstream, next.agents.length ? next.agents : void 0));
    if (next.actions !== void 0) setActions((map) => withEntry(map, workstream, next.actions ?? void 0));
    if (next.playbook !== void 0) setPlaybooks((map) => withEntry(map, workstream, next.playbook));
  };
  const save = async () => {
    if (busy || !name.trim()) return;
    const checked = readWorkstreamActions(actions);
    if (typeof checked === "string") return setError(checked);
    setBusy(true);
    setError(void 0);
    try {
      const keptAgents = Object.fromEntries(Object.entries(workstreamAgents).filter(([, keys]) => keys.length));
      const missing3 = missingFromChannel([agents, ...Object.values(keptAgents)], source.members);
      const fresh = new Set(
        missing3.length ? await hub2.handOffs({ name: account?.name ?? name.trim(), channel: channel.id, agents, workstream_agents: keptAgents }).catch(
          () => newlyAssigned(account && { agents: account.agents ?? [], workstream_agents: account.workstream_agents ?? {} }, { agents, workstream_agents: keptAgents })
        ) : []
      );
      const problem = await addToChannel(writes, channel, missing3.filter((key) => fresh.has(key)), source.name, "first");
      if (problem) return setError(problem);
      const notice = await addToChannel(writes, channel, missing3.filter((key) => !fresh.has(key)), source.name, "anyway");
      const saved = await hub2.saveAccount({
        name: account?.name ?? name.trim(),
        ...account && name.trim() !== account.name && { rename: name.trim() },
        channel: channel.id,
        aliases: typedAliases,
        domains: typedDomains,
        ids: parseIds(ids),
        agents,
        preferences,
        playbooks: Object.fromEntries(Object.entries(playbooks).filter(([, text]) => text.trim())),
        workstream_agents: keptAgents,
        workstream_actions: checked
      });
      props.onSaved(saved, notice);
    } catch (problem) {
      setError(describeError(problem));
    } finally {
      setBusy(false);
    }
  };
  const missing2 = missingFromChannel([agents, ...Object.values(workstreamAgents)], source.members);
  return /* @__PURE__ */ React.createElement(
    "form",
    {
      onSubmit: (event) => (event.preventDefault(), void save()),
      onKeyDown: (event) => event.key === "Enter" && (event.metaKey || event.ctrlKey) && (event.preventDefault(), void save()),
      style: { display: "flex", flexDirection: "column", minWidth: 0 }
    },
    /* @__PURE__ */ React.createElement(Section2, { first: true, title: "Account", description: "How sources recognize this customer." }, /* @__PURE__ */ React.createElement(Field, { label: "Name" }, /* @__PURE__ */ React.createElement("input", { className: "dbx-input", value: name, onChange: (event) => setName(event.target.value) })), /* @__PURE__ */ React.createElement("div", { style: { display: "flex", flexDirection: "column", gap: 4, minWidth: 0 } }, /* @__PURE__ */ React.createElement(Text, { size: "sm", weight: 500 }, "Other names"), /* @__PURE__ */ React.createElement(TokenInput, { label: "Other names", placeholder: "Acme Corp, Acme Inc", value: aliases, onChange: setAliases, text: aliasText, onText: setAliasText })), /* @__PURE__ */ React.createElement("div", { style: { display: "flex", flexDirection: "column", gap: 4, minWidth: 0 } }, /* @__PURE__ */ React.createElement(Text, { size: "sm", weight: 500 }, `${capitalized(account?.labels?.customer ?? "customer")} email domains`), /* @__PURE__ */ React.createElement(TokenInput, { label: "Email domains", placeholder: "example.com", value: domains, onChange: setDomains, text: domainText, onText: setDomainText, clean: cleanDomain }), /* @__PURE__ */ React.createElement(Text, { size: "xs", tone: "subtle", as: "div" }, "Mail, meetings and mentions from these domains open tasks here.")), /* @__PURE__ */ React.createElement(Disclosure, { summary: `Ids in other systems${Object.keys(parseIds(ids)).length ? ` (${Object.keys(parseIds(ids)).length})` : ""}` }, /* @__PURE__ */ React.createElement(Field, { label: "Ids", hint: /* @__PURE__ */ React.createElement(React.Fragment, null, "A line per kind, like ", /* @__PURE__ */ React.createElement("code", null, "crm: 0016100000AbCdE"), ". Events carrying one of these ids find this account.") }, /* @__PURE__ */ React.createElement("textarea", { className: "dbx-textarea", rows: 3, placeholder: "crm: 0016100000AbCdE", value: ids, onChange: (event) => setIds(event.target.value) })))),
    /* @__PURE__ */ React.createElement(Section2, { title: "Who works on what", description: "Each kind of work's mode and agents. New tasks mention their agents in the thread." }, /* @__PURE__ */ React.createElement("div", { style: { minWidth: 0, marginTop: -4 } }, /* @__PURE__ */ React.createElement(
      EveryRow,
      {
        ...read.modes.everything && { mode: read.modes.everything },
        defaultMode: DEFAULT_MODE,
        agents,
        source,
        onMode: (mode) => setPreferences((text) => withMode(text, "everything", mode ?? void 0, MODES)),
        onAgents: setAgents
      }
    ), names.map((workstream) => /* @__PURE__ */ React.createElement(
      WorkstreamRow,
      {
        key: workstream.toLowerCase(),
        name: workstream,
        value: {
          ...read.modes[workstream.toLowerCase()] && { mode: read.modes[workstream.toLowerCase()] },
          inherited,
          agents: workstreamAgents[keyIn(workstreamAgents, workstream) ?? workstream] ?? [],
          ...keyIn(actions, workstream) && { actions: actions[keyIn(actions, workstream)] },
          playbook: playbooks[keyIn(playbooks, workstream) ?? workstream] ?? ""
        },
        inheritedAgents: agents,
        source,
        defaultOpen: added.some((other) => other.toLowerCase() === workstream.toLowerCase()),
        onChange: (next) => change(workstream, next)
      }
    )), /* @__PURE__ */ React.createElement(AddWorkstream, { onAdd: (next) => setAdded((list) => [...list, next]) })), missing2.length > 0 && /* @__PURE__ */ React.createElement(Notice, null, `${listNames(missing2.map(source.name))} ${missing2.length === 1 ? "isn't" : "aren't"} in #${channel.name} yet. Saving adds ${missing2.length === 1 ? "it" : "them"}, so ${missing2.length === 1 ? "it sees its" : "they see their"} tasks.`)),
    /* @__PURE__ */ React.createElement(Section2, { title: "Team guidance", description: "Agents read this before every task. Mode lines, like meeting prep: auto, follow the menus above." }, /* @__PURE__ */ React.createElement("textarea", { className: "dbx-textarea", "aria-label": "Team guidance", rows: 7, value: preferences, onChange: (event) => setPreferences(event.target.value) }), read.problems.map((problem) => /* @__PURE__ */ React.createElement(Text, { key: problem, size: "xs", tone: "danger" }, problem))),
    /* @__PURE__ */ React.createElement("div", { style: { position: "sticky", bottom: 0, zIndex: 2, display: "flex", gap: 8, alignItems: "center", padding: "12px 0", marginTop: 4, borderTop: "1px solid var(--dbx-border)", background: "var(--dbx-surface)" } }, discarding ? /* @__PURE__ */ React.createElement(React.Fragment, null, /* @__PURE__ */ React.createElement(Text, { size: "sm", style: { flex: "1 1 0", minWidth: 0 } }, "Discard changes?"), /* @__PURE__ */ React.createElement(Button, { variant: "danger", onClick: () => props.onCancel?.() }, "Discard"), /* @__PURE__ */ React.createElement(Button, { variant: "ghost", onClick: () => setDiscarding(false) }, "Keep editing")) : /* @__PURE__ */ React.createElement(React.Fragment, null, /* @__PURE__ */ React.createElement("div", { role: error ? "alert" : "status", style: { flex: "1 1 0", minWidth: 0 } }, /* @__PURE__ */ React.createElement(Text, { size: "xs", tone: error ? "danger" : "tertiary" }, error ?? (dirty ? "Unsaved changes" : account && !missing2.length ? "No changes yet" : ""))), props.onCancel && /* @__PURE__ */ React.createElement(Button, { variant: "ghost", disabled: busy, onClick: () => dirty ? setDiscarding(true) : props.onCancel() }, "Cancel"), /* @__PURE__ */ React.createElement(Button, { variant: "brand", type: "submit", disabled: busy || !name.trim() || Boolean(account) && !dirty && !missing2.length, title: "Save (\u2318\u21B5)" }, busy ? /* @__PURE__ */ React.createElement(Spinner, { size: 12 }) : null, account ? "Save changes" : "Set up account")))
  );
}
var listNames = (names) => names.length < 2 ? names[0] ?? "" : `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
async function addToChannel(writes, channel, keys, name, when) {
  if (!keys.length) return void 0;
  const who = listNames(keys.map(name));
  const them = keys.length === 1 ? "it" : "them";
  if (!writes?.addAgents) return when === "first" ? `Add ${who} to #${channel.name} from the channel's members, then save.` : `Saved. Add ${who} to #${channel.name} from the channel's members, so ${keys.length === 1 ? "it sees its" : "they see their"} tasks.`;
  try {
    await writes.addAgents(channel.id, keys);
    return void 0;
  } catch (problem) {
    const why = describeError(problem).replace(/\.$/, "");
    return when === "first" ? `Not saved: ${who} couldn't be added to #${channel.name} (${why}). Try again, or add ${them} from the channel's members.` : `Saved, but ${who} couldn't be added to #${channel.name} (${why}). Add ${them} from the channel's members, so ${keys.length === 1 ? "it sees its" : "they see their"} tasks.`;
  }
}
function Tasks(props) {
  const tasks = useAsync(async (signal) => props.hub.tasks({ channel: props.channel, open: true, limit: 50 }, signal), [props.channel]);
  if (tasks.loading) return /* @__PURE__ */ React.createElement(Spinner, { label: "Loading tasks" });
  if (tasks.error) return /* @__PURE__ */ React.createElement(Notice, { tone: "danger" }, describeError(tasks.error));
  if (!tasks.data?.length) return /* @__PURE__ */ React.createElement(Text, { tone: "subtle", size: "sm" }, "No open tasks in this channel.");
  const groups = /* @__PURE__ */ new Map();
  for (const task of tasks.data) {
    const key = task.initiative ? `Initiative: ${task.initiative}` : task.workstream ?? "Other";
    groups.set(key, [...groups.get(key) ?? [], task]);
  }
  return /* @__PURE__ */ React.createElement(Stack, { gap: 14 }, [...groups].map(([group, list]) => /* @__PURE__ */ React.createElement(Stack, { key: group, gap: 2 }, /* @__PURE__ */ React.createElement(Text, { size: "xs", weight: 600, tone: "subtle", style: { textTransform: "uppercase", letterSpacing: "0.03em" } }, group), list.map((task) => /* @__PURE__ */ React.createElement("div", { key: task.id, style: { display: "flex", gap: 8, alignItems: "baseline", minWidth: 0, padding: "3px 0" } }, /* @__PURE__ */ React.createElement(Text, { size: "xs", tone: "tertiary", style: { flex: "none", fontVariantNumeric: "tabular-nums" } }, "#", task.id), /* @__PURE__ */ React.createElement(Text, { size: "sm", style: { flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" } }, /* @__PURE__ */ React.createElement("span", { title: task.title }, task.title)), /* @__PURE__ */ React.createElement(Text, { size: "xs", tone: "tertiary", style: { flex: "none" } }, ago(task.last_event_at * 1e3)))))));
}
function Workload(props) {
  const { account, source } = props;
  const everything = account.read.modes.everything ?? DEFAULT_MODE;
  const names = workstreamNames(account.workstreams ?? [], Object.keys(account.read.modes), Object.keys(account.workstream_actions ?? {}), Object.keys(account.workstream_agents ?? {}), Object.keys(account.playbooks ?? {}));
  const rows = [
    { name: "Every workstream", mode: everything, own: Boolean(account.read.modes.everything), agents: account.agents, detail: "Unless a workstream sets its own" },
    ...names.map((workstream) => {
      const own = account.read.modes[workstream.toLowerCase()];
      const mode = own ?? everything;
      const actionsKey = keyIn(account.workstream_actions ?? {}, workstream);
      const agentsKey = keyIn(account.workstream_agents ?? {}, workstream);
      const playbook = keyIn(account.playbooks ?? {}, workstream);
      return {
        name: workstream,
        mode,
        own: Boolean(own),
        agents: agentsKey ? account.workstream_agents[agentsKey] : [],
        detail: mode === "off" ? "No tasks" : [actionsKey ? rowSummary(account.workstream_actions[actionsKey]) : void 0, playbook && account.playbooks[playbook]?.trim() ? "playbook" : void 0].filter(Boolean).join(" \xB7 ")
      };
    })
  ];
  return /* @__PURE__ */ React.createElement("div", { role: "list", style: { minWidth: 0 } }, rows.map((row, index) => /* @__PURE__ */ React.createElement("div", { role: "listitem", key: row.name, style: { display: "flex", gap: 10, alignItems: "center", padding: "9px 0", borderTop: index ? "1px solid var(--dbx-border)" : void 0, minWidth: 0 } }, /* @__PURE__ */ React.createElement("div", { style: { flex: 1, minWidth: 0 } }, /* @__PURE__ */ React.createElement(Text, { size: "md", weight: index ? 500 : 600, as: "div", style: { overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" } }, /* @__PURE__ */ React.createElement("span", { title: row.name }, row.name)), row.detail && /* @__PURE__ */ React.createElement(Text, { size: "xs", tone: "tertiary", as: "div", style: { overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" } }, /* @__PURE__ */ React.createElement("span", { title: row.detail }, row.detail))), row.mode !== "off" && /* @__PURE__ */ React.createElement("span", { style: { display: "inline-flex", flex: "none" }, title: row.agents.length ? row.agents.map(source.name).join(", ") : index ? "Every workstream's agents" : "No agents" }, row.agents.slice(0, 4).map((key, at) => /* @__PURE__ */ React.createElement("span", { key, style: { marginLeft: at ? -4 : 0, borderRadius: 6, boxShadow: "0 0 0 2px var(--dbx-surface)", display: "inline-flex" } }, /* @__PURE__ */ React.createElement(AssigneeMark, { assignee: { kind: "agent", key, label: source.name(key) }, profile: source.profile, size: 20 }))), row.agents.length > 4 && /* @__PURE__ */ React.createElement(Text, { size: "xs", tone: "tertiary", style: { marginLeft: 4 } }, "+", row.agents.length - 4), !row.agents.length && index > 0 && account.agents.length > 0 && /* @__PURE__ */ React.createElement(InheritedMarks, { keys: account.agents, source, size: 20 })), /* @__PURE__ */ React.createElement("span", { style: { flex: "none", width: 52, textAlign: "right" }, title: MODE_HINT[row.mode] }, /* @__PURE__ */ React.createElement(Badge, { tone: row.mode === "auto" ? "success" : "neutral" }, MODE_LABEL[row.mode])))));
}
function AccountSummary(props) {
  const { account } = props;
  const source = useAgentSource(props.ctx, props.agents, props.channel, [...account.agents, ...Object.values(account.workstream_agents ?? {}).flat()]);
  const facts = [...account.domains, ...account.aliases.length ? [`also ${account.aliases.join(", ")}`] : []].join(" \xB7 ");
  return /* @__PURE__ */ React.createElement(Stack, { gap: 0 }, account.warning && /* @__PURE__ */ React.createElement("div", { style: { paddingBottom: 12 } }, /* @__PURE__ */ React.createElement(Notice, { tone: "warning" }, account.warning)), props.notice && /* @__PURE__ */ React.createElement("div", { style: { paddingBottom: 12 } }, /* @__PURE__ */ React.createElement(Notice, { tone: "warning" }, props.notice)), /* @__PURE__ */ React.createElement("div", { style: { display: "flex", gap: 12, alignItems: "flex-start", paddingBottom: 16, minWidth: 0 } }, /* @__PURE__ */ React.createElement("div", { style: { flex: 1, minWidth: 0 } }, /* @__PURE__ */ React.createElement(Text, { as: "h2", size: "xl", weight: 600, style: { overflowWrap: "anywhere" } }, account.name), facts && /* @__PURE__ */ React.createElement(Text, { size: "sm", tone: "subtle", as: "div", style: { overflowWrap: "anywhere" } }, facts), account.updated_by && /* @__PURE__ */ React.createElement(Text, { size: "xs", tone: "tertiary", as: "div", style: { marginTop: 2 } }, "Changed by ", account.updated_by, account.updated_at ? ` ${ago(account.updated_at * 1e3)}` : "")), /* @__PURE__ */ React.createElement(Button, { size: "sm", onClick: props.onEdit }, "Edit")), /* @__PURE__ */ React.createElement(Section2, { title: "Who works on what" }, /* @__PURE__ */ React.createElement(Workload, { account, source })), /* @__PURE__ */ React.createElement(Section2, { title: "Open tasks", description: "Work on them in their threads." }, /* @__PURE__ */ React.createElement(Tasks, { hub: props.hub, channel: props.channel.id })), /* @__PURE__ */ React.createElement(Section2, { title: "What agents have learned" }, account.profile ? /* @__PURE__ */ React.createElement(Text, { size: "sm", as: "div", style: { whiteSpace: "pre-wrap" } }, account.profile) : /* @__PURE__ */ React.createElement(Text, { size: "sm", tone: "subtle" }, "Nothing yet. Agents add to it as they work on this account's tasks.")));
}
function accountPanel(ctx, service, agents) {
  return function AccountPanel({ channelContext }) {
    const connection = useConnection(service);
    const hubs = useAsync(async (signal) => connection.status === "connected" ? chosenHub(service, signal) : void 0, [connection.status]);
    const app = hubs.data?.app;
    const hub2 = React.useMemo(() => app ? new HubClient(service.client(), app) : void 0, [app?.name, app?.url]);
    const found = useAsync(async (signal) => hub2 && channelContext ? hub2.accountLookup({ channel: channelContext.channelId }, signal) : void 0, [hub2, channelContext?.channelId]);
    const [saved, setSaved] = React.useState();
    const [editing, setEditing] = React.useState(false);
    let body;
    let editingNow = false;
    if (!channelContext) body = /* @__PURE__ */ React.createElement(Notice, null, "Open this from a channel's menu.");
    else if (connection.status !== "connected") body = /* @__PURE__ */ React.createElement(Notice, { title: "Connect Databricks", action: /* @__PURE__ */ React.createElement(Button, { variant: "brand", onClick: () => service.openSettings() }, "Connect") }, "Account channels live in your team's signals hub, a Databricks App.");
    else if (hubs.loading || found.loading) body = /* @__PURE__ */ React.createElement(Spinner, { label: "Looking for this channel's account" });
    else if (hubs.error || found.error) body = /* @__PURE__ */ React.createElement(Notice, { tone: "danger" }, describeError(hubs.error ?? found.error));
    else if (!hub2) body = /* @__PURE__ */ React.createElement(Notice, { title: "No signals hub in this workspace" }, "Deploy one first (see the Signals plugin's README), then set up account channels here.");
    else {
      const account = saved?.account ?? found.data?.account ?? void 0;
      const channel = { id: channelContext.channelId, name: channelContext.channelName };
      editingNow = !account || editing;
      body = editingNow ? /* @__PURE__ */ React.createElement(
        Form,
        {
          ctx,
          ...agents && { agents },
          hub: hub2,
          channel,
          ...account && { account, onCancel: () => setEditing(false) },
          workstreams: account?.workstreams ?? found.data?.workstreams ?? [],
          onSaved: (next, notice) => (setSaved({ account: next, ...notice && { notice } }), setEditing(false))
        }
      ) : /* @__PURE__ */ React.createElement(AccountSummary, { ctx, ...agents && { agents }, hub: hub2, channel, account, ...saved?.notice && { notice: saved.notice }, onEdit: () => setEditing(true) });
    }
    const accountName = saved?.account.name ?? found.data?.account?.name;
    return /* @__PURE__ */ React.createElement(DbxRoot, null, /* @__PURE__ */ React.createElement("div", { style: { padding: "16px 16px 0" } }, editingNow && /* @__PURE__ */ React.createElement("div", { style: { paddingBottom: 16 } }, /* @__PURE__ */ React.createElement(Text, { as: "h2", size: "xl", weight: 600 }, accountName ? `Edit ${accountName}` : `Set up #${channelContext?.channelName ?? "channel"}`), /* @__PURE__ */ React.createElement(Text, { size: "sm", tone: "subtle", as: "div" }, accountName ? `Tasks for this account post in #${channelContext?.channelName}.` : "Make this channel an account: its tasks post here, and agents follow what you set.")), !editingNow && !channelContext && /* @__PURE__ */ React.createElement(SectionHeader, { title: "Account" }), /* @__PURE__ */ React.createElement("div", { style: { paddingBottom: editingNow ? 0 : 16 } }, body)));
  };
}
var ACCOUNT_INSTRUCTIONS = `Signals: when you work on a signals task, or in a channel set up as an account, first call signals_account with the channel id and the task's workstream, and follow its mode for that workstream (auto: do it and report in the task's thread; draft: prepare it for a person to send; ask: ask in the thread first), the team's guidance and the workstream's playbook. Record what you did with signals_task_update. When you learn something lasting about the customer or the team, update the profile with signals_account_learn.`;

// plugins/signals/src/live-tasks.ts
var STALE_MS = 3e4;
var OLDER_LIMIT = 500;
var LiveTasks = class {
  constructor(service) {
    this.service = service;
  }
  hub;
  boards = /* @__PURE__ */ new Map();
  listeners = /* @__PURE__ */ new Set();
  version = 0;
  /** Changes whenever a board is read, for useSyncExternalStore. */
  snapshot = () => this.version;
  subscribe = (listener) => {
    this.listeners.add(listener);
    return () => void this.listeners.delete(listener);
  };
  notify() {
    this.version++;
    for (const listener of [...this.listeners]) listener();
  }
  /** Whether Databricks is connected, so the hub can be asked. */
  connected() {
    return this.service.snapshot().status === "connected";
  }
  /** The hub as the signed-in person, found once per workspace. */
  client() {
    const snapshot = this.service.snapshot();
    if (snapshot.status !== "connected") return Promise.resolve(void 0);
    const key = "profile" in snapshot ? snapshot.profile.host : "connected";
    if (this.hub?.key !== key) {
      const client = chosenHub(this.service).then((found) => found.app ? new HubClient(this.service.client(), found.app) : void 0).catch((error) => (this.hub = void 0, Promise.reject(error)));
      this.hub = { key, client };
    }
    return this.hub.client;
  }
  /** A channel's board as last read, reading it (again) when it's missing or stale. */
  board(channel) {
    const entry = this.boards.get(channel) ?? {};
    if (!this.boards.has(channel)) this.boards.set(channel, entry);
    if (!entry.pending && this.connected() && (!entry.board || Date.now() - entry.board.at > STALE_MS) && !(entry.error && !entry.board && Date.now() - (entry.errorAt ?? 0) < STALE_MS)) void this.load(channel);
    return entry;
  }
  /** The task as the hub has it now, if its channel's board was read. */
  task(channel, id) {
    return this.board(channel).board?.tasks.find((item) => item.task.id === id);
  }
  /**
   * The status of a task that isn't on its channel's board (it closed before
   * the board's window), read once per channel; undefined until it's known,
   * or when the hub doesn't have it.
   */
  olderStatus(channel, id) {
    return this.olderTask(channel, id)?.status;
  }
  /**
   * A task that isn't on its channel's board (it closed before the board's
   * window): its status, and whether its workstream's defaults dismissed it
   * (not a person). Read once per channel; undefined until it's known, or
   * when the hub doesn't have it.
   */
  olderTask(channel, id) {
    const entry = this.board(channel);
    if (!entry.board || entry.board.tasks.some((item) => item.task.id === id)) return void 0;
    if (entry.older) return entry.older.get(id);
    if (!entry.olderPending && this.connected()) {
      entry.olderPending = true;
      void (async () => {
        try {
          const hub2 = await this.client();
          const tasks = hub2 ? await hub2.tasks({ channel, limit: OLDER_LIMIT }) : [];
          entry.older = new Map(tasks.map((task) => [task.id, { status: task.status, byDefaults: task.status === "dismissed" && Boolean(task.triggers?.dismissed) }]));
        } catch {
          entry.older = /* @__PURE__ */ new Map();
        } finally {
          entry.olderPending = false;
          this.notify();
        }
      })();
    }
    return void 0;
  }
  /** The task whose thread starts at `root`, if its channel's board was read. */
  byRoot(channel, root) {
    return this.board(channel).board?.tasks.find((item) => item.task.buzz_root === root);
  }
  /** Whether a channel's board is being read and none is shown yet. */
  loading(channel) {
    const entry = this.boards.get(channel);
    return Boolean(entry?.pending && !entry.board);
  }
  /** Reads a channel's board now (after an action on one of its tasks, say). */
  load(channel) {
    const entry = this.boards.get(channel) ?? {};
    this.boards.set(channel, entry);
    if (entry.pending) return entry.pending;
    entry.pending = (async () => {
      try {
        const hub2 = await this.client();
        if (!hub2) return;
        const read = await hub2.board(channel);
        entry.board = { tasks: read.tasks, at: Date.now() };
        entry.error = void 0;
      } catch (error) {
        entry.error = error instanceof Error ? error : new Error(String(error));
        entry.errorAt = Date.now();
      } finally {
        entry.pending = void 0;
        this.notify();
      }
    })();
    this.notify();
    return entry.pending;
  }
  /** Answers what a task asks, then reads its board again so every card shows the answer. */
  async answer(channel, id, input) {
    const hub2 = await this.client();
    if (!hub2) throw new Error("There's no signals hub in your Databricks workspace.");
    await hub2.updateTask({ id, input });
    await this.load(channel);
  }
};

// plugins/signals/src/post-cards.tsx
var MODE_TITLE = { auto: "Auto: agents do it and report", draft: "Draft: agents prepare it, a person sends it", ask: "Ask: agents ask before doing anything", off: "Off: agents leave it alone" };
var clamp = (lines) => ({ display: "-webkit-box", WebkitLineClamp: lines, WebkitBoxOrient: "vertical", overflow: "hidden" });
var statusTitle = (status2) => STATUS_GROUPS.find((group) => group.status === status2)?.title ?? status2;
var closed = (item) => item?.task.status === "done" || item?.task.status === "dismissed";
function Chip2(props) {
  const color = props.tone === "warning" ? "var(--dbx-warning)" : props.tone === "success" ? "var(--dbx-success)" : "var(--dbx-subtle)";
  return /* @__PURE__ */ React.createElement("span", { title: props.title, style: { display: "inline-flex", alignItems: "center", padding: "0 6px", borderRadius: 4, border: "1px solid var(--dbx-border)", fontSize: "0.6875rem", lineHeight: "18px", color, whiteSpace: "nowrap", maxWidth: 180, overflow: "hidden", textOverflow: "ellipsis" } }, props.children);
}
function useLiveTask(live, channel, by) {
  React.useSyncExternalStore(live.subscribe, live.snapshot);
  const connection = React.useSyncExternalStore(live.service.subscribe, live.service.snapshot);
  if (connection.status !== "connected") return void 0;
  return by.id !== void 0 ? live.task(channel, by.id) : by.root ? live.byRoot(channel, by.root) : void 0;
}
function FullPost(props) {
  const HostMarkdown = props.ctx.conversation?.ui?.Markdown;
  const named = withMentionNames(props.content, npubKey, (key) => props.profile(key)?.name);
  return /* @__PURE__ */ React.createElement("div", { style: { borderTop: "1px solid var(--dbx-border)", paddingTop: 8, overflowWrap: "anywhere" } }, HostMarkdown ? /* @__PURE__ */ React.createElement(HostMarkdown, { content: named }) : /* @__PURE__ */ React.createElement(Markdown, { source: named, size: "sm" }));
}
function Answer(props) {
  const { live, item } = props;
  const [busy, setBusy] = React.useState();
  const [error, setError] = React.useState();
  const [other, setOther] = React.useState(false);
  const [text, setText] = React.useState("");
  const connected = live.connected();
  const ready = connected && props.id !== void 0;
  const waiting = item ? Boolean(item.task.question) && !closed(item) && item.task.question === props.question : void 0;
  const send = async (answer) => {
    if (!answer.trim() || busy || props.id === void 0) return;
    setBusy(answer);
    setError(void 0);
    try {
      await live.answer(props.channel, props.id, answer.trim());
      setText("");
      setOther(false);
    } catch (problem) {
      const message = describeError(problem);
      setError(/isn't waiting on input/.test(message) ? "Someone already answered this." : message);
      if (/isn't waiting on input/.test(message)) void live.load(props.channel);
    } finally {
      setBusy(void 0);
    }
  };
  if (waiting === false)
    return /* @__PURE__ */ React.createElement(Stack, { direction: "row", gap: 6, align: "baseline", wrap: true }, /* @__PURE__ */ React.createElement(Text, { size: "xs", tone: "success", weight: 600 }, "\u2713 Answered"), /* @__PURE__ */ React.createElement(Text, { size: "xs", tone: "tertiary", style: { minWidth: 0, ...clamp(1) } }, props.question));
  return /* @__PURE__ */ React.createElement("div", { style: { borderLeft: "3px solid var(--dbx-warning)", paddingLeft: 10 } }, /* @__PURE__ */ React.createElement(Stack, { gap: 6 }, /* @__PURE__ */ React.createElement(Text, { size: "xs", weight: 600, tone: "warning" }, "Needs your input"), /* @__PURE__ */ React.createElement(Text, { size: "sm", style: { overflowWrap: "anywhere" } }, props.question), /* @__PURE__ */ React.createElement(Stack, { direction: "row", gap: 6, wrap: true, align: "center" }, props.options.map((option) => /* @__PURE__ */ React.createElement(Button, { key: option, size: "sm", disabled: !ready || Boolean(busy), onClick: () => void send(option), title: `Answer \u201C${option}\u201D` }, busy === option ? /* @__PURE__ */ React.createElement(Spinner, { size: 10 }) : null, option)), !other && /* @__PURE__ */ React.createElement(Button, { size: "sm", variant: "ghost", disabled: !ready || Boolean(busy), onClick: () => setOther(true) }, props.options.length ? "Other answer\u2026" : "Answer\u2026")), other && /* @__PURE__ */ React.createElement("form", { onSubmit: (event) => (event.preventDefault(), void send(text)), style: { display: "flex", gap: 6, flexWrap: "wrap", minWidth: 0 } }, /* @__PURE__ */ React.createElement(
    "input",
    {
      className: "dbx-input",
      "aria-label": "Your answer",
      placeholder: "Your answer",
      autoFocus: true,
      value: text,
      onChange: (event) => setText(event.target.value),
      onKeyDown: (event) => event.key === "Escape" && (event.preventDefault(), setOther(false)),
      style: { flex: "1 1 200px", minWidth: 0 }
    }
  ), /* @__PURE__ */ React.createElement(Button, { size: "sm", variant: "brand", type: "submit", disabled: !text.trim() || Boolean(busy) }, busy && busy === text.trim() ? /* @__PURE__ */ React.createElement(Spinner, { size: 10 }) : null, "Send answer")), connected && props.id === void 0 && (live.loading(props.channel) ? /* @__PURE__ */ React.createElement(Spinner, { size: 10, label: "Loading the task" }) : /* @__PURE__ */ React.createElement(Text, { size: "xs", tone: "subtle" }, "This task isn't on the signals hub you're connected to. Answer from its Tasks board.")), !connected && /* @__PURE__ */ React.createElement(Text, { size: "xs", tone: "subtle" }, "Connect Databricks to answer here.", " ", /* @__PURE__ */ React.createElement("a", { href: "#", className: "dbx-link", onClick: (event) => (event.preventDefault(), live.service.openSettings()) }, "Connect")), error && /* @__PURE__ */ React.createElement(Text, { size: "xs", tone: "danger" }, error)));
}
function SourceLine(props) {
  const { source } = props;
  if (!source) return null;
  const parts = [props.ticket ? `${sourceName(source.kind)} ${props.ticket}` : sourceName(source.kind), source.from, source.where && !/^https?:/.test(source.where) ? source.where : void 0, source.when && shortWhen(source.when)].filter(Boolean);
  return /* @__PURE__ */ React.createElement(Text, { size: "xs", tone: "tertiary", style: { minWidth: 0, ...clamp(1) } }, /* @__PURE__ */ React.createElement("span", { title: parts.join(" \xB7 ") }, parts.join(" \xB7 ")));
}
function FoldedTask(props) {
  const button = React.useRef(null);
  React.useEffect(() => void (props.focus && button.current?.focus()), []);
  return /* @__PURE__ */ React.createElement(DbxRoot, { style: { minWidth: 0, maxWidth: 620 } }, /* @__PURE__ */ React.createElement(
    "button",
    {
      ref: button,
      type: "button",
      onClick: props.onShow,
      "aria-expanded": false,
      title: `Task ${props.id} was dismissed${props.untriggered ? " because none of its workstream's default actions triggered" : ""}: ${props.title}. Show its card.`,
      style: { display: "flex", alignItems: "center", gap: 6, width: "100%", minWidth: 0, margin: 0, padding: "2px 0", border: 0, borderRadius: 4, background: "transparent", cursor: "pointer", color: "var(--dbx-tertiary)", fontFamily: "inherit", fontSize: "0.75rem", lineHeight: "18px", textAlign: "left" }
    },
    /* @__PURE__ */ React.createElement(StatusIcon, { status: "dismissed", size: 11 }),
    /* @__PURE__ */ React.createElement("span", { style: { flex: "none" } }, props.untriggered ? "Not triggered" : "Dismissed"),
    /* @__PURE__ */ React.createElement("span", { "aria-hidden": true, style: { flex: "none" } }, "\xB7"),
    /* @__PURE__ */ React.createElement("span", { style: { flex: "0 1 auto", minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" } }, props.title),
    /* @__PURE__ */ React.createElement("span", { style: { flex: "none", marginLeft: "auto", paddingLeft: 8, textDecoration: "underline dotted" } }, "Show")
  ));
}
function TriggeredLines(props) {
  if (!props.triggered.length)
    return props.note ? /* @__PURE__ */ React.createElement(Text, { size: "xs", tone: "tertiary", style: { overflowWrap: "anywhere" } }, props.note === "dismissed" ? "Nothing triggered, so it was dismissed. It opens again if something does." : props.dismissing ? "When it opened, nothing triggered, so it was dismissed then." : "When it opened, nothing triggered, so no agent was asked then.") : null;
  return /* @__PURE__ */ React.createElement(Stack, { gap: 2 }, props.triggered.map((item) => /* @__PURE__ */ React.createElement(Text, { key: item.label, size: "xs", tone: "subtle", style: { overflowWrap: "anywhere", ...clamp(2) } }, /* @__PURE__ */ React.createElement("span", { title: item.why ? `${item.label} \u2014 ${item.why}` : item.label }, /* @__PURE__ */ React.createElement("span", { style: { color: "var(--dbx-tertiary)" } }, "Triggered \xB7 "), /* @__PURE__ */ React.createElement("span", { style: { fontWeight: 600 } }, item.label), item.why ? ` \u2014 ${item.why}` : ""))));
}
function TaskPostCard(props) {
  const { message, live } = props;
  const post = React.useMemo(() => parseTaskPost(message.content), [message.content]);
  const item = useLiveTask(live, message.channelId, { ...post && { id: post.id } });
  const [full, setFull] = React.useState(false);
  const [unfolded, setUnfolded] = React.useState(false);
  const moved = React.useRef(void 0);
  const card = React.useRef(null);
  React.useEffect(() => {
    const want = moved.current;
    moved.current = void 0;
    if (unfolded && want === "fold") card.current?.querySelector('button[aria-label="Fold"]')?.focus();
  }, [unfolded]);
  const latest = item?.activity?.text ?? "";
  const mentioned = React.useMemo(() => mentionedNpubs(`${message.content}
${latest}`).map(npubKey).filter((key) => Boolean(key)), [message.content, latest]);
  const assignee = item && assigneeOf(item);
  const profile = useProfiles(props.ctx, [...mentioned, ...assignee && (assignee.kind === "agent" || assignee.kind === "person") ? [assignee.key] : []]);
  if (!post) return null;
  const target = taskTarget(message.channelId, post.id);
  const options = item ? item.task.options ?? [] : post.options;
  const older = item ? void 0 : live.olderTask(message.channelId, post.id);
  const status2 = item?.task.status ?? older?.status;
  const weight = postWeight(status2);
  const question = item ? item.task.question && !closed(item) ? item.task.question : void 0 : weight === "full" ? post.question : void 0;
  const details = weight === "full" || weight === "folded" && unfolded;
  const source = post.source;
  const origin = postOrigin(source, item?.origin);
  const ticket = taskOrigin(post.title, origin).ref;
  const open = () => props.canOpen(target) && props.open(target) || props.openBoard(message.channelId);
  const now = item ? { status: item.task.status, byDefaults: item.task.status === "dismissed" && Boolean(item.task.triggers?.dismissed) } : older;
  const note = untriggeredNote(post, now);
  const untriggered = Boolean(now?.byDefaults);
  if (weight === "folded" && !unfolded) return /* @__PURE__ */ React.createElement(FoldedTask, { id: post.id, title: post.title, untriggered, focus: moved.current === "show", onShow: () => (moved.current = "fold", setUnfolded(true)) });
  return /* @__PURE__ */ React.createElement(DbxRoot, { style: { minWidth: 0, maxWidth: 620 } }, /* @__PURE__ */ React.createElement("div", { ref: card, className: "dbx-card", style: { padding: "10px 12px", borderRadius: 8, minWidth: 0 } }, /* @__PURE__ */ React.createElement(Stack, { gap: 8 }, /* @__PURE__ */ React.createElement(Stack, { direction: "row", gap: 8, align: "center", justify: "space-between" }, /* @__PURE__ */ React.createElement(Stack, { direction: "row", gap: 6, align: "center", wrap: true, style: { minWidth: 0 } }, status2 ? /* @__PURE__ */ React.createElement(StatusIcon, { status: status2 }) : /* @__PURE__ */ React.createElement("span", { "aria-hidden": true, style: { width: 13, height: 13, borderRadius: 999, border: "1.5px solid var(--dbx-border-strong)", flex: "none" } }), /* @__PURE__ */ React.createElement(Text, { size: "xs", tone: "tertiary", mono: true }, "Task ", post.id), status2 && /* @__PURE__ */ React.createElement(Text, { size: "xs", tone: status2 === "waiting" ? "warning" : status2 === "done" ? "success" : "subtle", weight: 500 }, statusTitle(status2)), post.workstream && /* @__PURE__ */ React.createElement(Chip2, { title: item && item.task.workstream === post.workstream ? workstreamHint(item.task) : post.workstream }, post.workstream), post.initiative && /* @__PURE__ */ React.createElement(Chip2, null, post.initiative), post.mode && post.mode !== "draft" && /* @__PURE__ */ React.createElement(Chip2, { title: MODE_TITLE[post.mode], ...post.mode === "auto" && { tone: "success" } }, post.mode)), assignee && /* @__PURE__ */ React.createElement(Stack, { direction: "row", gap: 6, align: "center", style: { flex: "none", maxWidth: "40%" } }, /* @__PURE__ */ React.createElement(Text, { size: "xs", tone: "subtle", style: { overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" } }, assignee.kind === "you" ? "Waiting on you" : assigneeName(assignee, profile)), /* @__PURE__ */ React.createElement(AssigneeMark, { assignee, profile, size: 18 }))), /* @__PURE__ */ React.createElement(Stack, { gap: 2 }, /* @__PURE__ */ React.createElement(Text, { size: "md", weight: 600, style: { overflowWrap: "anywhere", ...clamp(2) } }, /* @__PURE__ */ React.createElement("span", { title: titleHint(post.title, origin) }, post.title)), /* @__PURE__ */ React.createElement(SourceLine, { source, ...ticket && { ticket } })), source?.quote && details && /* @__PURE__ */ React.createElement("div", { style: { borderLeft: "2px solid var(--dbx-border-strong)", paddingLeft: 8 } }, /* @__PURE__ */ React.createElement(Text, { size: "sm", tone: "subtle", style: { overflowWrap: "anywhere", ...clamp(3) } }, source.quote)), source && source.facts.length > 0 && details && /* @__PURE__ */ React.createElement("div", { style: { display: "flex", flexWrap: "wrap", columnGap: 14, rowGap: 2 } }, source.facts.map((fact) => /* @__PURE__ */ React.createElement(Text, { key: fact.label, size: "xs", tone: "subtle", style: { whiteSpace: "nowrap", maxWidth: "100%", overflow: "hidden", textOverflow: "ellipsis" } }, /* @__PURE__ */ React.createElement("span", { style: { color: "var(--dbx-tertiary)" } }, fact.label), " ", fact.value))), details && /* @__PURE__ */ React.createElement(TriggeredLines, { triggered: post.triggered, note, dismissing: post.untriggered === "dismissed" }), question && /* @__PURE__ */ React.createElement(Answer, { live, channel: message.channelId, id: post.id, question, options, ...item && { item } }), item?.activity && !question && /* @__PURE__ */ React.createElement(Text, { size: "xs", tone: "subtle", style: { overflowWrap: "anywhere", ...clamp(2) } }, /* @__PURE__ */ React.createElement("span", { style: { color: "var(--dbx-tertiary)" } }, item.activity.kind === "agent_reply" ? "Agent" : "Latest", " \xB7 ", ago(item.activity.at * 1e3), " \xB7 "), (() => {
    const line2 = plainLine(item.activity.text, (npub) => profile(npubKey(npub) ?? "")?.name);
    return /* @__PURE__ */ React.createElement("span", { title: line2 }, line2);
  })()), /* @__PURE__ */ React.createElement(Stack, { direction: "row", gap: 6, align: "center", wrap: true }, /* @__PURE__ */ React.createElement(Button, { size: "sm", variant: weight === "full" ? "primary" : "default", onClick: open, title: "Its details, what's been made for it and its thread" }, "Open task"), source?.url && /* @__PURE__ */ React.createElement(Button, { size: "sm", variant: "ghost", onClick: () => openExternal(source.url), title: source.url }, "View source \u2197"), /* @__PURE__ */ React.createElement("span", { style: { flex: "1 1 auto" } }), weight === "folded" && /* @__PURE__ */ React.createElement(Button, { size: "sm", variant: "ghost", "aria-label": "Fold", onClick: () => (moved.current = "show", setUnfolded(false), setFull(false)), title: "Back to one line: it was dismissed, so there's nothing to do" }, "Fold"), /* @__PURE__ */ React.createElement(Button, { size: "sm", variant: "ghost", onClick: () => setFull(!full), title: "The whole message, as agents read it" }, full ? "Hide full post" : "Full post")), full && /* @__PURE__ */ React.createElement(FullPost, { ctx: props.ctx, content: message.content, profile }))));
}
var LINE_ICON = { update: "\u21BB", done: "\u2713", nudge: "\u23F1", answered: "\u21B3", status: "\u25CF", assigned: "\u{1F464}", asked: "\u2192" };
function ThreadPostCard(props) {
  const { message, live } = props;
  const post = React.useMemo(() => parseThreadPost(message.content), [message.content]);
  const item = useLiveTask(live, message.channelId, { ...message.threadRootId && { root: message.threadRootId } });
  const id = item?.task.id;
  const [full, setFull] = React.useState(false);
  const mentioned = React.useMemo(() => mentionedNpubs(message.content).map(npubKey).filter((key) => Boolean(key)), [message.content]);
  const profile = useProfiles(props.ctx, mentioned);
  if (!post) return null;
  const named = (text) => withMentionNames(text, npubKey, (key) => profile(key)?.name).replace(/\*\*/g, "");
  if (post.kind === "question") {
    const by = named(post.by);
    return /* @__PURE__ */ React.createElement(DbxRoot, { style: { minWidth: 0, maxWidth: 620 } }, /* @__PURE__ */ React.createElement(Stack, { gap: 4 }, /* @__PURE__ */ React.createElement(Answer, { live, channel: message.channelId, ...id !== void 0 && { id }, question: post.question, options: post.options, ...item && { item } }), /* @__PURE__ */ React.createElement(Text, { size: "xs", tone: "tertiary" }, "Asked by ", by)));
  }
  let body;
  let forAgents = false;
  let more = false;
  switch (post.kind) {
    case "update":
      forAgents = post.forAgents;
      more = Boolean(post.more);
      body = /* @__PURE__ */ React.createElement(React.Fragment, null, post.reopened && /* @__PURE__ */ React.createElement("span", null, "Open again:"), post.url ? /* @__PURE__ */ React.createElement("a", { href: post.url, className: "dbx-link", title: post.url, onClick: (event) => (event.preventDefault(), openExternal(post.url)) }, post.title) : /* @__PURE__ */ React.createElement("span", null, post.title), post.changes.map((change) => /* @__PURE__ */ React.createElement(Chip2, { key: change.field, title: `${change.field}: ${change.from} \u2192 ${change.to}` }, change.field, " ", change.from === "(none)" ? "" : `${change.from} `, "\u2192 ", /* @__PURE__ */ React.createElement("b", { style: { marginLeft: 3 } }, change.to))));
      break;
    case "done":
      body = /* @__PURE__ */ React.createElement("span", null, "Done: ", post.reason);
      break;
    case "nudge":
      body = /* @__PURE__ */ React.createElement("span", null, post.text);
      break;
    case "answered":
      forAgents = post.forAgents;
      body = /* @__PURE__ */ React.createElement("span", null, named(post.who), " answered ", /* @__PURE__ */ React.createElement("b", null, named(post.answer)), post.question ? /* @__PURE__ */ React.createElement("span", { style: { color: "var(--dbx-tertiary)" } }, " to \u201C", post.question.length > 80 ? `${post.question.slice(0, 79)}\u2026` : post.question, "\u201D") : null);
      break;
    case "status":
    case "assigned":
      forAgents = post.kind === "assigned" && post.forAgents;
      body = /* @__PURE__ */ React.createElement("span", null, named(post.text));
      break;
    case "asked":
      forAgents = true;
      body = /* @__PURE__ */ React.createElement("span", null, post.text, mentioned.length ? `: ${mentioned.map((key) => profile(key)?.name ?? "an agent").join(", ")}` : "");
      break;
  }
  return /* @__PURE__ */ React.createElement(DbxRoot, { style: { minWidth: 0 } }, /* @__PURE__ */ React.createElement(Stack, { gap: 6 }, /* @__PURE__ */ React.createElement("div", { style: { display: "flex", alignItems: "baseline", gap: 6, fontSize: "0.75rem", color: "var(--dbx-subtle)", minWidth: 0 } }, /* @__PURE__ */ React.createElement("span", { "aria-hidden": true, style: { color: post.kind === "done" ? "var(--dbx-success)" : "var(--dbx-tertiary)", flex: "none" } }, post.kind === "update" && post.reopened ? "\u21A9" : LINE_ICON[post.kind]), /* @__PURE__ */ React.createElement("span", { style: { display: "flex", flexWrap: "wrap", alignItems: "center", columnGap: 6, rowGap: 2, flex: "1 1 auto", minWidth: 0, overflowWrap: "anywhere" } }, body, (forAgents || more) && /* @__PURE__ */ React.createElement("button", { type: "button", onClick: () => setFull(!full), "aria-expanded": full, style: { border: 0, background: "transparent", padding: 0, cursor: "pointer", color: "var(--dbx-tertiary)", fontSize: "0.75rem", textDecoration: "underline dotted" } }, full ? "Hide" : more ? "Details" : "For agents"))), post.kind === "update" && post.triggered.length > 0 && /* @__PURE__ */ React.createElement("div", { style: { paddingLeft: 18, minWidth: 0 } }, /* @__PURE__ */ React.createElement(TriggeredLines, { triggered: post.triggered })), full && /* @__PURE__ */ React.createElement(FullPost, { ctx: props.ctx, content: message.content, profile })));
}

// plugins/signals/src/tools.ts
async function hub(service) {
  const { apps, app } = await chosenHub(service);
  if (!app) throw new Error(apps.length ? "Several signals hubs exist; the owner picks one in Settings \u2192 Signals." : "There's no signals hub in this workspace yet (Settings \u2192 Signals says how to deploy one).");
  return new HubClient(await service.ready(), app);
}
var line = (task) => `- #${task.id} [${task.status}, ${task.mode}] ${task.title}${task.question ? ` \xB7 needs input: ${task.question}${task.options?.length ? ` (${task.options.join(" / ")})` : ""}` : ""}${task.account ? ` \xB7 ${task.account}` : ""}${task.workstream ? ` \xB7 ${task.workstream}` : ""}${task.initiative ? ` \xB7 initiative ${task.initiative}` : ""} \xB7 ${task.event_count} event${task.event_count === 1 ? "" : "s"}, last ${new Date(task.last_event_at * 1e3).toISOString().slice(0, 16)}Z`;
function signalsTools(service) {
  return [
    {
      name: "signals_tasks",
      description: "Lists tasks from the signals hub (events from people's Gmail, Calendar, Jira, tables\u2026 turned into tasks by the team's rules). Filter by account, channel (a Buzz channel id) or status; open only by default.",
      inputSchema: schema.object({
        account: schema.string("Account name."),
        channel: schema.string("Buzz channel id the tasks are posted in."),
        workstream: schema.string("Workstream, e.g. meeting prep."),
        initiative: schema.string("Initiative."),
        status: schema.string(`One of ${TASK_STATUSES.join(", ")}.`),
        all: { type: "boolean", description: "Include done and dismissed tasks." },
        limit: schema.integer("Max tasks (default 30, max 200).")
      }),
      async call(_client, _context, args) {
        const client = await hub(service);
        const tasks = await client.tasks({
          open: !args.all && !args.status,
          ...stringArg(args, "account", false) && { account: stringArg(args, "account") },
          ...stringArg(args, "channel", false) && { channel: stringArg(args, "channel") },
          ...stringArg(args, "status", false) && { status: stringArg(args, "status") },
          ...stringArg(args, "workstream", false) && { workstream: stringArg(args, "workstream") },
          ...stringArg(args, "initiative", false) && { initiative: stringArg(args, "initiative") },
          limit: numberArg(args, "limit", 30, 1, 200)
        });
        return tasks.length ? tasks.map(line).join("\n") : "No tasks match.";
      }
    },
    {
      name: "signals_task",
      description: "Reads one signals task: what it is, the events behind it (with links), what's been done and the artifacts made for it.",
      inputSchema: schema.object({ id: schema.integer("Task id.") }, ["id"]),
      async call(_client, _context, args) {
        const detail = await (await hub(service)).task(numberArg(args, "id", 0, 0, Number.MAX_SAFE_INTEGER));
        return [
          line(detail.task),
          "",
          "Events (newest first):",
          ...detail.events.map((event) => `- ${event.source} ${event.title ?? event.external_id}${event.url ? ` <${event.url}>` : ""}${event.actor ? ` from ${event.actor}` : ""}`),
          "",
          "Activity:",
          ...detail.activities.map((activity) => `- ${new Date(activity.at * 1e3).toISOString().slice(0, 16)}Z ${activity.actor}: ${activity.text}`),
          ...detail.artifacts.length ? ["", "Artifacts:", ...detail.artifacts.map((artifact) => `- ${artifact.kind}: ${artifact.title ?? artifact.url} <${artifact.url}>`)] : []
        ].join("\n");
      }
    },
    {
      name: "signals_task_update",
      description: "Works on a signals task: set its status, add a note of what was done, file it under a workstream or initiative, link an artifact (a draft doc, a demo, a PR), or ask for a person's input (question and options: the task waits, and their answer comes to its thread mentioning you). Its Buzz thread gets status changes, questions and artifacts.",
      inputSchema: schema.object(
        {
          id: schema.integer("Task id."),
          status: schema.string(`One of ${TASK_STATUSES.join(", ")}.`),
          note: schema.string("What was done, or why the status changed."),
          workstream: schema.string('File it under this workstream ("" clears it).'),
          initiative: schema.string('File it under this initiative ("" clears it).'),
          artifact_url: schema.string("A link to something made for the task."),
          artifact_title: schema.string("The artifact's title."),
          artifact_kind: schema.string("doc, demo, code, email draft\u2026 (default link)."),
          question: schema.string("Needs input: what you need a person to tell you. The task waits until they answer in its thread or on the Tasks board."),
          options: schema.string(`The question's choices, separated by " / " (optional).`),
          input: schema.string("Answers the task's question (as a person would)."),
          verdict: schema.string("For a candidate a fan_out rule opened (a feature for one account): qualified, disqualified (also marks it done) or unsure. Put why in note."),
          assign: schema.string("Makes them its owners: npubs (agents) or emails (people), separated by commas. An agent assigned is asked in the thread to work on it."),
          unassign: schema.string("Takes them off it: npubs or emails, separated by commas. An agent taken off is told in the thread to stop, and isn't woken by the task again. Assign another and unassign yourself to hand it off.")
        },
        ["id"]
      ),
      async call(_client, _context, args) {
        const url = stringArg(args, "artifact_url", false);
        const detail = await (await hub(service)).updateTask({
          id: numberArg(args, "id", 0, 0, Number.MAX_SAFE_INTEGER),
          ...stringArg(args, "status", false) && { status: stringArg(args, "status") },
          ...stringArg(args, "note", false) && { note: stringArg(args, "note") },
          ...typeof args.workstream === "string" && { workstream: args.workstream },
          ...typeof args.initiative === "string" && { initiative: args.initiative },
          ...stringArg(args, "question", false) && { question: stringArg(args, "question"), ...stringArg(args, "options", false) && { options: stringArg(args, "options").split(/\s+\/\s+|\s*\|\s*|\s*;\s*/).filter(Boolean) } },
          ...stringArg(args, "input", false) && { input: stringArg(args, "input") },
          ...stringArg(args, "verdict", false) && { verdict: stringArg(args, "verdict") },
          ...stringArg(args, "assign", false) && { assign: owners(stringArg(args, "assign")) },
          ...stringArg(args, "unassign", false) && { unassign: owners(stringArg(args, "unassign")) },
          ...url && { artifact: { url, ...stringArg(args, "artifact_title", false) && { title: stringArg(args, "artifact_title") }, ...stringArg(args, "artifact_kind", false) && { kind: stringArg(args, "artifact_kind") } } }
        });
        return `Updated: ${line(detail.task)}`;
      }
    },
    {
      name: "signals_account",
      description: `Reads an account channel's setup in the signals hub: the account, its team's preferences (how agents handle each kind of work: ${MODES.join(", ")}, plus their guidance), the team's playbook for a workstream (how they like that work done), and the profile agents keep of the account, its team and its people. Read it before working on a task in that channel, with the task's workstream, and follow it.`,
      inputSchema: schema.object({ channel: schema.string("The Buzz channel id."), name: schema.string("Or the account's name."), workstream: schema.string("The task's workstream (or rule id), for its playbook.") }),
      async call(_client, _context, args) {
        const channel = stringArg(args, "channel", false);
        const name = stringArg(args, "name", false);
        const workstream = stringArg(args, "workstream", false);
        if (!channel && !name) throw new Error("Give channel or name.");
        const account = await (await hub(service)).account({ ...channel && { channel }, ...name && { name } });
        if (!account) return "No account is set up for that. Someone in the channel can set one up from its menu: Set up account.";
        const modes = Object.entries(account.read.modes);
        const names = Object.keys(account.playbooks ?? {});
        const playbook = workstream ? playbookFor(account.playbooks, { rule_id: workstream, workstream }) : void 0;
        const playbookText = workstream ? playbook ? [`Playbook for ${playbook.key} (how the team likes this done; follow it):`, playbook.text] : [`No playbook for ${workstream}${names.length ? ` (the team has playbooks for ${names.join(", ")})` : ""}.`] : names.length ? [`Playbooks: ${names.join(", ")}. Read the one for your task's workstream with workstream.`] : [];
        const actions = workstream ? actionsFor(account.workstream_actions ?? {}, { rule_id: workstream, workstream }) : void 0;
        const actionLines = actions ? [actionsText(actions)] : [];
        return [
          `Account: ${account.name}${account.aliases.length ? ` (also ${account.aliases.join(", ")})` : ""}${account.channel ? ` \xB7 channel ${account.channel}` : ""}`,
          account.domains.length ? `${capitalized(account.labels?.customer ?? "customer")} domains: ${account.domains.join(", ")}` : "",
          Object.keys(account.ids ?? {}).length ? `Ids: ${Object.entries(account.ids).map(([kind, values]) => `${kind} ${values.join(", ")}`).join("; ")}` : "",
          "",
          `Modes (default draft): ${modes.length ? modes.map(([key, mode]) => `${key}: ${mode}`).join("; ") : "none set"}`,
          "- auto: do the work and report it in the task's thread. draft: prepare it (a draft doc, a reply) for a person to send. ask: ask in the thread before doing anything. off: no tasks.",
          "",
          "Team guidance:",
          account.read.guidance || "(none)",
          "",
          ...playbookText,
          ...playbookText.length ? [""] : [],
          ...actionLines,
          ...actionLines.length ? [""] : [],
          "Profile (what agents have learned; update it with signals_account_learn):",
          account.profile || "(empty)"
        ].filter((part, index, all) => part !== "" || all[index - 1] !== "").join("\n");
      }
    },
    {
      name: "signals_account_learn",
      description: "Updates the profile agents keep of an account: what you learned about the customer, the account team, how they like to work, open initiatives. Send the whole new profile (short Markdown sections; at most 16,000 characters), not only what's new: read it first with signals_account. Never put secrets or a mail's body in it.",
      inputSchema: schema.object({ channel: schema.string("The account channel's Buzz id."), name: schema.string("Or the account's name."), profile: schema.string("The new profile.") }, ["profile"]),
      async call(_client, _context, args) {
        const client = await hub(service);
        const channel = stringArg(args, "channel", false);
        const name = stringArg(args, "name", false);
        const account = await client.account({ ...channel && { channel }, ...name && { name } });
        if (!account) throw new Error("No account is set up for that channel yet.");
        const saved = await client.saveAccount({ name: account.name, profile: stringArg(args, "profile") });
        return `Saved the profile of ${saved.name} (${saved.profile.length} characters).`;
      }
    },
    {
      name: "signals_event",
      description: "Sends an event to the signals hub as the owner, for a source they turned on (or `agent`, which the owner turns on in Settings \u2192 Signals). The team's rules decide whether it opens or updates a task; the same external_id with the same content is recorded once.",
      inputSchema: schema.object(
        {
          source: schema.string("Source name, e.g. agent."),
          external_id: schema.string("The thing's own id at the source."),
          title: schema.string("What happened."),
          url: schema.string("A link to it."),
          account: schema.string("The account it's about."),
          group_key: schema.string("Events with the same group key share a task."),
          payload: { type: "object", description: "Fields the rules can match on." }
        },
        ["source", "external_id", "title"]
      ),
      async call(_client, _context, args) {
        const event = Object.fromEntries(Object.entries(args).filter(([key, value]) => ["source", "external_id", "title", "url", "account", "group_key", "payload"].includes(key) && value !== void 0 && value !== ""));
        const reply = await (await hub(service)).events([event]);
        if (reply.errors.length) throw new Error(reply.errors.map((error) => error.error).join("; "));
        if (reply.skipped) return `Skipped: the owner hasn't turned on the source ${String(args.source)} in Settings \u2192 Signals.`;
        return reply.created.length ? `Opened task #${reply.created.join(", #")}.` : reply.updated.length ? `Added to task #${reply.updated.join(", #")}.` : reply.same ? "Already recorded; nothing changed." : "Recorded; no rule makes it a task.";
      }
    }
  ];
}
function owners(text) {
  return text.split(/[\s,]+/).filter(Boolean).map((key) => ({ key, kind: key.includes("@") ? "person" : "agent" }));
}

// virtual-poller:signals-poller
var POLLER = '"""Signals poller: reads one person\'s sources and posts what it finds to the signals hub.\n\nRuns as a scheduled serverless Databricks job owned by that person, so it reads\ntheir sources as them: the Unity Catalog MCP services (system.ai.gmail,\ngoogle_calendar, slack, ...) with their own sign-ins, and tables with their own\ngrants. It keeps no state: the hub says which sources the person turned on and\nwhere each one stopped (its cursor).\n\n    python poller.py --config sources.json [--hub https://<app-url> | --lakebase] [--warehouse <id>] [--dry-run]\n\nHow it reaches the hub:\n\n- `--hub` calls the hub app\'s API. Databricks Apps only take OAuth tokens, so\n  this works from a laptop (`databricks auth login`) but not from a job, whose\n  token isn\'t one.\n- `--lakebase` (for jobs) writes to the hub\'s inbox table in Lakebase instead,\n  logged in as the job\'s owner\'s own Postgres role (a token from\n  /api/2.0/postgres/credentials). Row-level security lets each person write\n  only rows the hub reads as theirs, and read only their own sources. The hub\n  drains the inbox every half minute. Config: `"lakebase": {"endpoint":\n  "projects/<p>/branches/<b>/endpoints/<e>", "host": "<endpoint host>",\n  "database": "databricks_postgres", "schema": "signals_<app name>"}`. It\n  needs `psycopg[binary]` and a Postgres role for the person in the database.\n\n- `hub_auth` in the config (with `--hub`) signs hub calls in with another\n  profile than the default client\'s, for sources in another workspace than\n  the hub\'s: `{"profile": "<name>"}`, a profile in ~/.databrickscfg for the\n  hub\'s workspace. SQL and MCP calls stay on the default client\n  (DATABRICKS_CONFIG_PROFILE picks its profile).\n\nThe config lists sources (see sources.example.json):\n\n- kind "mcp": a tool of a system.ai MCP service. `args` and `map` are templates:\n  "{since}" (the cursor, or `lookback_hours` ago, ISO 8601), "{now}", "{now+7d}",\n  "{since_epoch}", and "{field}" for a field of the item being mapped.\n  `items` is the path to the list in the tool\'s JSON result.\n  `detail` (optional) fetches each item\'s full record with another tool of the\n  same service and merges it into the item before mapping, for list tools that\n  leave fields out (calendar_event_list has no attendees or description):\n  {"tool": "calendar_event_get", "args": {"event_id": "{id}"}, "max": 50}.\n  A detail call that fails leaves the item as the list gave it.\n  `when` ({path: regex}) fetches it only for the items it matches; `named_in`\n  (a path) only for items whose field names an account (its name or another\n  name, as whole words; the hub serves them with the ids). With `after` (a path\n  to the item\'s time), the versions not read before are read, oldest first.\n  The cursor keeps which versions (id and time) were read: one read\n  before isn\'t read or posted again, and one past `max`, or whose read failed,\n  isn\'t posted and is read by a later poll. `max` counts reads tried, failed or\n  not; versions never tried go before those that failed, which take turns. A source with `named_in` is\n  unavailable (its cursor held) when the account names can\'t be read.\n  `sections` (optional) is for tools that answer with Markdown instead of a JSON\n  list (Slack search): {"split": "^### Result \\\\d+ of \\\\d+$"} cuts the text at\n  `items` into one item per section, and each "Key: value" line starts a field\n  (`key` lowercased, spaces as _) that runs until the next one. `keys` (optional)\n  lists the only keys that start a field, so a "Note: ..." line inside a\n  message\'s text stays in the text.\n- kind "table": a SQL query with :since (the watermark) as a parameter.\n  `table` is checked first; a table that isn\'t there (or can\'t be read) makes\n  the source "unavailable" and it is skipped. The cursor is the largest\n  `watermark` column seen.\n\nAccount ids: a source that covers every account names the kinds of account ids\nit uses, `"ids": ["crm"]`, and gets every account\'s ids of each kind (set in\nthe account panel, or `ids` in the hub\'s config accounts; the hub serves them\nat GET /api/ids, and in Lakebase as the account_ids table):\n\n- a table source\'s query has `:crm`, which becomes bound parameters\n  (`:crm_0, :crm_1, ...`), as in `WHERE account_id IN (:crm)`; the ids are\n  never pasted into the SQL.\n- an mcp source\'s args have `{crm: <clause with {}>}`, which becomes the clause\n  once per id joined by OR, with `\\\\` and `"` in the id escaped:\n  `({jira_customer: cf[10001] ~ "{}"})` -> `(cf[10001] ~ "Acme" OR cf[10001] ~ "Acme Co")`.\n\nWhen no account has ids of a kind the source uses, it is skipped (reported as\nunavailable, with why).\n\n`map` turns an item into an event: external_id, title, url, actor, account,\ngroup_key, occurred_at, and payload (a list of fields, "*" for the whole item,\nor an object of specs). A spec is a path ("fields.summary"), a template\n("{key}: {fields.summary}"), or {"from": <spec>, "match": <regex>}, which takes\nthe regex\'s first group (case-insensitive) and is left out without a match:\n{"from": "title", "match": "workspace (\\\\d+)"}. `match` can be a list of regexes,\ntried in order, and `"replace": "\\\\1:\\\\2"` builds the value from the groups.\n"""\n\nfrom __future__ import annotations\n\nimport argparse\nimport datetime as dt\nimport hashlib\nimport json\nimport re\nimport sys\nimport time\nimport unicodedata\nfrom typing import Any, Callable, Iterable\n\nPROTOCOL = "2025-06-18"\nNOT_SIGNED_IN = -32006\nBATCH = 200\n\n# ---------------------------------------------------------------------------\n# Templates and mapping (pure; tested without a workspace)\n\n\ndef iso(t: dt.datetime) -> str:\n    return t.astimezone(dt.timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")\n\n\ndef parse_time(value: str | None) -> dt.datetime | None:\n    if not value:\n        return None\n    try:\n        if re.fullmatch(r"\\d+(\\.\\d+)?", value):\n            return dt.datetime.fromtimestamp(float(value), dt.timezone.utc)\n        return dt.datetime.fromisoformat(value.replace("Z", "+00:00"))\n    except ValueError:\n        return None\n\n\ndef get_path(item: Any, path: str) -> Any:\n    """`a.b.0.c` into dicts and lists."""\n    value = item\n    for part in path.split(".") if path else []:\n        if isinstance(value, dict):\n            value = value.get(part)\n        elif isinstance(value, list) and part.isdigit() and int(part) < len(value):\n            value = value[int(part)]\n        else:\n            return None\n    return value\n\n\n_OFFSET = re.compile(r"^now([+-])(\\d+)([mhd])$")\n\n\ndef fill(template: Any, item: Any, clock: dict[str, dt.datetime]) -> Any:\n    """Fills {since}, {now}, {now+7d}, {since_epoch} and {item.field} in strings (recursively in lists and dicts)."""\n    if isinstance(template, dict):\n        return {key: fill(value, item, clock) for key, value in template.items()}\n    if isinstance(template, list):\n        return [fill(value, item, clock) for value in template]\n    if not isinstance(template, str):\n        return template\n\n    def one(name: str) -> Any:\n        if name == "now":\n            return iso(clock["now"])\n        if name == "since":\n            return iso(clock["since"])\n        if name == "since_epoch":\n            return int(clock["since"].timestamp())\n        if name == "since_date":\n            return clock["since"].date().isoformat()\n        offset = _OFFSET.match(name)\n        if offset:\n            sign, amount, unit = offset.groups()\n            unit_name = {"m": "minutes", "h": "hours", "d": "days"}[unit]\n            delta = dt.timedelta(**{unit_name: int(amount)})\n            return iso(clock["now"] + delta if sign == "+" else clock["now"] - delta)\n        return get_path(item, name)\n\n    whole = re.fullmatch(r"\\{([A-Za-z0-9_.+-]+)\\}", template)\n    if whole:  # keep the value\'s type ({since_epoch} stays a number)\n        return one(whole.group(1))\n    return re.sub(r"\\{([A-Za-z0-9_.+-]+)\\}", lambda m: "" if one(m.group(1)) is None else str(one(m.group(1))), template)\n\n\ndef extract(found: Any, pattern: str | list[str], replace: str | None = None) -> Any:\n    """The first capture group of `pattern` in `found` (or the whole match), case-insensitive; None without a match.\n\n    `pattern` can be a list, tried in order (the first that matches wins). With\n    `replace`, the result is that template with the match\'s groups in it\n    (`\\\\1:\\\\2`), for a value made of several parts.\n    """\n    if found in (None, ""):\n        return None\n    text = found if isinstance(found, str) else json.dumps(found, default=str)\n    for one in [pattern] if isinstance(pattern, str) else pattern:\n        match = re.search(one, text, re.I)\n        if not match:\n            continue\n        if replace is not None:\n            return match.expand(replace).strip()\n        groups = [group for group in match.groups() if group is not None]\n        return (groups[0] if groups else match.group(0)).strip()\n    return None\n\n\n_FIELD = re.compile(r"^([A-Z][A-Za-z_ ]{0,30}):[ \\t]?(.*)$")\n\n\ndef sections(text: Any, split: str, keys: Iterable[str] | None = None) -> list[dict]:\n    """Markdown results as items: the text cut at `split` (a regex for a line), each "Key: value" line a field (only `keys`, when given)."""\n    allowed = {key.lower() for key in keys} if keys else None\n    if not isinstance(text, str):\n        return []\n    items = []\n    for part in re.split(f"(?m){split}", text)[1:]:\n        item: dict[str, str] = {}\n        key = None\n        for line in part.strip("\\n").splitlines():\n            if line.strip() == "---":\n                continue\n            found = _FIELD.match(line)\n            if found and allowed is not None and found.group(1).strip().lower() not in allowed:\n                found = None\n            if found:\n                key = found.group(1).strip().lower().replace(" ", "_")\n                item[key] = found.group(2).strip()\n            elif key:\n                item[key] = (item[key] + "\\n" + line.rstrip()).strip("\\n")\n        if item:\n            items.append({k: v.strip() for k, v in item.items()})\n    return items\n\n\ndef to_event(source: str, item: dict, mapping: dict, clock: dict[str, dt.datetime]) -> dict | None:\n    """An item as a hub event, or None without an external_id."""\n\n    def value(spec: Any) -> Any:\n        if isinstance(spec, dict) and "match" in spec:\n            found = extract(value(spec.get("from", "")), spec["match"], spec.get("replace"))\n            # `max`: at most this many characters (long text, like a doc\'s notes, stays small on the hub).\n            return found[: int(spec["max"])] if isinstance(found, str) and spec.get("max") else found\n        if isinstance(spec, str) and "{" not in spec:\n            return get_path(item, spec)  # a plain path\n        return fill(spec, item, clock)\n\n    external = value(mapping.get("external_id", "id"))\n    if external in (None, ""):\n        return None\n    event: dict[str, Any] = {"source": source, "external_id": str(external)}\n    for key in ("title", "url", "actor", "account", "group_key", "occurred_at"):\n        if key in mapping:\n            found = value(mapping[key])\n            if found not in (None, ""):\n                event[key] = found if key == "occurred_at" and isinstance(found, (int, float)) else str(found)\n    payload = mapping.get("payload")\n    if payload == "*":\n        event["payload"] = item\n    elif isinstance(payload, list):\n        event["payload"] = {name: get_path(item, name) for name in payload}\n    elif isinstance(payload, dict):\n        event["payload"] = {name: value(spec) for name, spec in payload.items()}\n    return json.loads(json.dumps(event, default=str))\n\n\ndef tool_json(result: dict) -> Any:\n    """A tool result\'s JSON: structuredContent, or the first JSON text block."""\n    if result.get("structuredContent") is not None:\n        return result["structuredContent"]\n    for block in result.get("content") or []:\n        text = (block.get("text") or "").strip() if block.get("type") == "text" else ""\n        if text[:1] in "{[":\n            try:\n                return json.loads(text)\n            except ValueError:\n                continue\n    return None\n\n\n# ---------------------------------------------------------------------------\n# Workspace access\n\n\nclass NotSignedIn(Exception):\n    pass\n\n\nclass Unavailable(Exception):\n    pass\n\n\n# ---------------------------------------------------------------------------\n# Account ids in queries\n\n\ndef needed_ids(source: dict, ids: dict[str, list[str]]) -> dict[str, list[str]]:\n    """The ids of each kind the source uses; Unavailable when an account has none of a kind."""\n    kinds = source.get("ids") or []\n    if isinstance(kinds, str):\n        kinds = [kinds]\n    missing = [kind for kind in kinds if not ids.get(kind)]\n    if missing:\n        raise Unavailable(f"no account has {\', \'.join(missing)} ids yet (add them in the account panel, as `{missing[0]}: ...`)")\n    return {kind: list(ids[kind]) for kind in kinds}\n\n\ndef bind_ids(query: str, ids: dict[str, list[str]]) -> tuple[str, dict[str, str]]:\n    """The query with each `:kind` as one bound parameter per id (`:kind_0, :kind_1`), and those parameters."""\n    parameters: dict[str, str] = {}\n    for kind, values in ids.items():\n        names = [f"{kind}_{n}" for n in range(len(values))]\n        parameters.update(zip(names, values))\n        # `:kind` as a whole name, not part of `::cast` or a longer name.\n        query = re.sub(rf"(?<![:\\w]):{re.escape(kind)}(?!\\w)", ", ".join(f":{name}" for name in names), query)\n    return query, parameters\n\n\ndef quoted(value: str) -> str:\n    """A value for inside a double-quoted string (JQL\'s): backslashes and quotes escaped."""\n    return value.replace("\\\\", "\\\\\\\\").replace(\'"\', \'\\\\"\')\n\n\ndef clause_ids(template: Any, ids: dict[str, list[str]]) -> Any:\n    """`{kind: <clause with {}>}` in strings (recursively) as the clause once per id, joined by OR."""\n    if isinstance(template, dict):\n        return {key: clause_ids(value, ids) for key, value in template.items()}\n    if isinstance(template, list):\n        return [clause_ids(value, ids) for value in template]\n    if not isinstance(template, str) or not ids:\n        return template\n\n    def one(match: re.Match) -> str:\n        kind, clause = match.group(1), match.group(2)\n        if kind not in ids:\n            return match.group(0)\n        return " OR ".join(clause.replace("{}", quoted(value)) for value in ids[kind])\n\n    return re.sub(r"\\{([a-z][a-z0-9_]*):\\s?((?:[^{}]|\\{\\})*)\\}", one, template)\n\n\ndef check_hub_auth(settings: Any) -> str | None:\n    """What\'s wrong with a config\'s `hub_auth`, or None. It\'s {"profile": "<name>"}."""\n    if not isinstance(settings, dict) or set(settings) != {"profile"}:\n        return \'hub_auth is {"profile": "<name>"}, a profile in ~/.databrickscfg for the hub\\\'s workspace\'\n    if not isinstance(settings["profile"], str) or not settings["profile"]:\n        return "hub_auth.profile is a profile name from ~/.databrickscfg"\n    return None\n\n\ndef hub_client(settings: dict, make: Callable[..., Any] | None = None) -> Any:\n    """The client for hub calls that `hub_auth` describes."""\n    problem = check_hub_auth(settings)\n    if problem:\n        raise SystemExit(problem)\n    if make is None:\n        from databricks.sdk import WorkspaceClient as make\n    try:\n        return make(profile=settings["profile"])\n    except Exception as error:\n        raise RuntimeError(f"hub_auth: couldn\'t sign in with profile {settings[\'profile\']!r}: {error}") from None\n\n\nclass Workspace:\n    """Calls as the job\'s owner, through the Databricks SDK\'s auth. `hub_auth` (optional) signs hub calls in as someone else."""\n\n    def __init__(self, client=None, hub_auth: dict | None = None, make_client: Callable[..., Any] | None = None):\n        if client is None:\n            from databricks.sdk import WorkspaceClient\n\n            client = WorkspaceClient()\n        self.client = client\n        self.host = client.config.host.rstrip("/")\n        self.hub_auth = hub_auth\n        self.make_client = make_client\n        self.hub_as: Any = None\n        import requests\n\n        self.http = requests.Session()\n\n    def headers(self) -> dict:\n        return {**self.client.config.authenticate(), "Content-Type": "application/json"}\n\n    def hub_headers(self) -> dict:\n        """Headers for a hub call: the default client\'s, or `hub_auth`\'s client\'s (made on the first call)."""\n        if self.hub_auth is None:\n            return self.headers()\n        if self.hub_as is None:\n            self.hub_as = hub_client(self.hub_auth, self.make_client)\n        return {**self.hub_as.config.authenticate(), "Content-Type": "application/json"}\n\n    def mcp(self, service: str, tool: str, args: dict) -> Any:\n        url = f"{self.host}/ai-gateway/mcp-services/system.ai.{service}"\n        headers = {**self.headers(), "Accept": "application/json, text/event-stream"}\n\n        def post(message: dict, initializing=False) -> dict:\n            h = dict(headers)\n            if not initializing:\n                h["MCP-Protocol-Version"] = PROTOCOL\n            response = self.http.post(url, headers=h, json=message, timeout=120)\n            if response.headers.get("mcp-session-id"):\n                headers["Mcp-Session-Id"] = response.headers["mcp-session-id"]\n            if response.status_code == 401:\n                raise NotSignedIn(f"system.ai.{service} rejected the call (HTTP 401)")\n            response.raise_for_status()\n            text = response.text\n            if "text/event-stream" in response.headers.get("content-type", ""):\n                text = "\\n".join(line[5:].strip() for line in text.splitlines() if line.startswith("data:"))\n            reply = json.loads(text) if text.strip() else {}\n            error = reply.get("error")\n            if error:\n                # Not signed in comes back as HTTP 200 with a JSON-RPC error.\n                if error.get("code") == NOT_SIGNED_IN or re.search(r"401|not logged in|login first|Credential for user", error.get("message", ""), re.I):\n                    raise NotSignedIn(f"Sign in to system.ai.{service}: {self.host}/explore/mcp-services/system/ai/{service}")\n                raise RuntimeError(f"system.ai.{service} {tool}: {error.get(\'message\')}")\n            return reply.get("result") or {}\n\n        post({"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {"protocolVersion": PROTOCOL, "capabilities": {}, "clientInfo": {"name": "signals-poller", "version": "1"}}}, True)\n        self.http.post(url, headers={**headers, "MCP-Protocol-Version": PROTOCOL}, json={"jsonrpc": "2.0", "method": "notifications/initialized"}, timeout=30)\n        result = post({"jsonrpc": "2.0", "id": 2, "method": "tools/call", "params": {"name": tool, "arguments": args}})\n        if result.get("isError"):\n            text = " ".join(block.get("text", "") for block in result.get("content") or [])\n            raise RuntimeError(f"system.ai.{service} {tool}: {text[:500]}")\n        return tool_json(result)\n\n    def table_exists(self, name: str) -> bool:\n        try:\n            return bool(self.client.tables.exists(full_name=name).table_exists)\n        except Exception:  # no access looks the same as not there\n            return False\n\n    def sql(self, warehouse: str, statement: str, parameters: dict) -> list[dict]:\n        from databricks.sdk.service.sql import StatementParameterListItem, StatementState\n\n        response = self.client.statement_execution.execute_statement(\n            warehouse_id=warehouse,\n            statement=statement,\n            parameters=[StatementParameterListItem(name=k, value=None if v is None else str(v)) for k, v in parameters.items()],\n            wait_timeout="50s",\n        )\n        while response.status.state in (StatementState.PENDING, StatementState.RUNNING):\n            time.sleep(2)\n            response = self.client.statement_execution.get_statement(response.statement_id)\n        if response.status.state != StatementState.SUCCEEDED:\n            raise RuntimeError(response.status.error.message if response.status.error else str(response.status.state))\n        columns = [column.name for column in response.manifest.schema.columns]\n        rows = [dict(zip(columns, row)) for row in (response.result.data_array or [])]\n        chunk = response.result.next_chunk_index\n        while chunk is not None:\n            part = self.client.statement_execution.get_statement_result_chunk_n(response.statement_id, chunk)\n            rows.extend(dict(zip(columns, row)) for row in (part.data_array or []))\n            chunk = part.next_chunk_index\n        return rows\n\n    def hub(self, base: str, method: str, path: str, body: Any = None) -> Any:\n        response = self.http.request(method, f"{base.rstrip(\'/\')}{path}", headers=self.hub_headers(), json=body, timeout=120)\n        if response.status_code >= 400:\n            raise RuntimeError(f"hub {path}: HTTP {response.status_code} {response.text[:300]}")\n        return response.json()\n\n\nclass LakebaseInbox:\n    """The hub\'s API, as far as a poller needs it, through the inbox table in Lakebase."""\n\n    def __init__(self, ws: Workspace, settings: dict, connect: Callable[[], Any] | None = None):\n        missing = [key for key in ("endpoint", "host", "schema") if not settings.get(key)]\n        if missing and connect is None:\n            raise SystemExit("--lakebase needs " + ", ".join(f"lakebase.{key}" for key in missing) + " in the config")\n        if not re.fullmatch(r"[a-z_][a-z0-9_]{0,62}", settings.get("schema", "")):\n            raise SystemExit(f"lakebase.schema {settings.get(\'schema\')!r} isn\'t a schema name")\n        self.schema = settings["schema"]\n        if connect is None:\n            import psycopg\n\n            user = ws.client.current_user.me().user_name\n            token = ws.client.api_client.do("POST", "/api/2.0/postgres/credentials", body={"endpoint": settings["endpoint"]})["token"]\n            self.db = psycopg.connect(host=settings["host"], port=int(settings.get("port", 5432)), dbname=settings.get("database", "databricks_postgres"), user=user, password=token, sslmode="require", autocommit=True)\n        else:\n            self.db = connect()\n\n    def call(self, method: str, path: str, body: Any = None) -> Any:\n        with self.db.cursor() as cursor:\n            if (method, path) == ("GET", "/api/ids"):\n                cursor.execute(f"SELECT kind, id FROM {self.schema}.account_ids ORDER BY kind, id")\n                ids: dict[str, list[str]] = {}\n                for kind, value in cursor.fetchall():\n                    ids.setdefault(kind, []).append(value)\n                # The hub keeps accounts\' names there as kind `_name` (an id kind starts with a letter).\n                return {"ids": {kind: values for kind, values in ids.items() if kind != "_name"}, "names": ids.get("_name", [])}\n            if (method, path) == ("GET", "/api/sources"):\n                # Row-level security returns only this person\'s sources.\n                cursor.execute(f"SELECT source, enabled, cursor FROM {self.schema}.sources")\n                return {"sources": [{"source": row[0], "enabled": row[1], "cursor": row[2]} for row in cursor.fetchall()]}\n            if method == "POST" and path in ("/api/events", "/api/cursor"):\n                cursor.execute(f"INSERT INTO {self.schema}.inbox (kind, body) VALUES (%s, %s)", ("events" if path == "/api/events" else "cursor", json.dumps(body, default=str)))\n                return {"queued": True}\n        raise RuntimeError(f"the inbox can\'t take {method} {path}")\n\n\n# ---------------------------------------------------------------------------\n# Polling\n\n\ndef name_words(text: str) -> str:\n    """Text as its lowercase words, each with a space either side (the hub\'s whole-word name test)."""\n    return " " + " ".join(re.findall(r"[^\\W_]+", unicodedata.normalize("NFKD", text.lower()))) + " "\n\n\ndef names_one(value: Any, names: Iterable[str]) -> bool:\n    """Whether the text names one of `names` (an account\'s name or other name) as whole words."""\n    if not isinstance(value, str) or not value.strip():\n        return False\n    text = name_words(value)\n    return any(spelled.strip() and spelled in text for spelled in (name_words(name) for name in names))\n\n\ndef detail_applies(detail: dict, item: dict, names: Iterable[str] | None = None) -> bool:\n    """Whether `detail` is fetched for this item: every `when` field (a path) matches its pattern (case-insensitive),\n    and with `named_in` (a path), that field names an account (`names`; none known reads nothing)."""\n    for path, pattern in (detail.get("when") or {}).items():\n        value = get_path(item, path)\n        if value is None or not re.search(pattern, value if isinstance(value, str) else json.dumps(value, default=str), re.I):\n            return False\n    if detail.get("named_in") and not names_one(get_path(item, detail["named_in"]), names or ()):\n        return False\n    return True\n\n\ndef with_detail(ws: Workspace, service: str, detail: dict, item: dict, clock: dict[str, dt.datetime]) -> dict:\n    """The item with its full record (from `detail`\'s tool) merged in; the item as it was when that fails."""\n    try:\n        found = ws.mcp(service, detail["tool"], fill(detail.get("args", {}), item, clock))\n    except NotSignedIn:\n        raise\n    except Exception:\n        return item\n    return {**item, **found} if isinstance(found, dict) else item\n\n\nREAD_KEEP = 150  # 17 characters each: the hub keeps 4,000 of a cursor\n\n\ndef version_key(item: dict, after: str) -> str:\n    """A short key for one version of an item (its id and its time): which versions a poll read is kept in the cursor."""\n    return hashlib.sha256(json.dumps([item.get("id"), get_path(item, after)], default=str).encode()).hexdigest()[:16]\n\n\ndef split_cursor(cursor: str | None) -> tuple[str | None, list[str], list[str]]:\n    """A cursor\'s time and, for a source that reads details by version (`detail.after`), the versions it read and\n    those whose read failed (least recently failed first)."""\n    if cursor and cursor.startswith("{"):\n        try:\n            data = json.loads(cursor)\n            return data.get("at"), [str(key) for key in data.get("read") or []], [str(key) for key in data.get("failed") or []]\n        except ValueError:\n            return None, [], []\n    return cursor, [], []\n\n\ndef detailed(ws: Workspace, source: dict, detail: dict, items: list[dict], clock: dict[str, dt.datetime], read_before: list[str], names: Iterable[str] | None, failed_before: list[str] | None = None) -> tuple[list[dict], list[str], dt.datetime | None, list[str]]:\n    """The items with `detail` fetched for those it applies to (at most `max` reads tried), the versions read so far,\n    the time of the oldest one left unread (past the cap, or its read failed), and the versions whose read failed.\n\n    Without `after`, the first `max` in the listing\'s order are read and the rest go as listed. With `after` (a\n    path to the item\'s time), at most `max` reads are tried, failed or not, so an outage of the detail service costs\n    one poll `max` calls at most. Versions never tried go first, oldest first, then those whose read failed before,\n    least recently failed first, so a doc that keeps failing doesn\'t keep healthy ones waiting and each failed one\n    gets its turn. One read before (it\'s in the cursor) isn\'t read or posted again, and one not read (past the cap,\n    or its read failed) isn\'t posted (a version without its details would replace the one with them) and waits.\n    Being read is tracked per version, not by time, so a burst within one second, equal times, or a doc that\'s\n    listed late (older than the cursor) are all read in time.\n    """\n    service = source.get("service", source["name"])\n    cap = int(detail.get("max", 50))\n    after = detail.get("after")\n    if not after:\n        fetched, out = 0, []\n        for item in items:\n            if fetched < cap and detail_applies(detail, item, names):\n                fetched += 1\n                item = with_detail(ws, service, detail, item, clock)\n            out.append(item)\n        return out, [], None, []\n    def when(item: dict) -> dt.datetime | None:\n        value = get_path(item, after)\n        return parse_time(value) if isinstance(value, str) else None\n    seen = set(read_before)\n    failed_rank = {key: n for n, key in enumerate(failed_before or [])}\n    eligible = [item for item in items if detail_applies(detail, item, names)]\n    keys = [version_key(item, after) for item in eligible]\n    oldest = dt.datetime.min.replace(tzinfo=dt.timezone.utc)\n    # Never tried first, oldest first (an item without a time after the timed ones, in the listing\'s order); then\n    # the ones that failed before, least recently failed first.\n    order = sorted(range(len(eligible)), key=lambda i: (keys[i] in failed_rank, failed_rank.get(keys[i], 0), when(eligible[i]) is None, when(eligible[i]) or oldest, i))\n    read: dict[int, dict] = {}\n    now_read: list[str] = []\n    now_failed: list[str] = []\n    tried = 0\n    held: dt.datetime | None = None\n    def hold(time_: dt.datetime | None) -> None:\n        nonlocal held\n        if time_ and (held is None or time_ < held):\n            held = time_\n    for i in order:\n        item, key = eligible[i], keys[i]\n        if key in seen:\n            continue  # read by an earlier poll\n        if tried >= cap:\n            hold(when(item))\n            continue\n        tried += 1\n        found = with_detail(ws, service, detail, item, clock)\n        if found is item:  # the read failed: it waits for a later poll, behind the ones not tried yet\n            hold(when(item))\n            now_failed.append(key)\n            continue\n        read[id(item)] = found\n        now_read.append(key)\n        seen.add(key)\n    # Keep the versions the listing still shows (older ones won\'t come back): read ones newest last, failed ones\n    # least recently failed first, READ_KEEP in all (failed ones first, as they\'re still to read).\n    listed = set(keys)\n    failed = [key for key in failed_before or [] if key in listed and key not in seen and key not in now_failed] + now_failed\n    failed = failed[-READ_KEEP:]\n    kept = [key for key in read_before if key in listed and key not in now_read] + now_read\n    remaining = READ_KEEP - len(failed)\n    kept = kept[-remaining:] if remaining > 0 else []\n    chosen = {id(item) for item in eligible}\n    return [read[id(item)] if id(item) in read else item for item in items if id(item) not in chosen or id(item) in read], kept, held, failed\n\n\ndef poll_source(ws: Workspace, source: dict, cursor: str | None, warehouse: str | None, now: dt.datetime, ids: dict[str, list[str]] | None = None, names: Iterable[str] | None = None) -> tuple[list[dict], str]:\n    """One source\'s events since its cursor, and its next cursor. `ids`: every account\'s ids, by kind; `names`: every account\'s names and other names."""\n    lookback = dt.timedelta(hours=float(source.get("lookback_hours", 24)))\n    name = source["name"]\n    used = needed_ids(source, ids or {})\n    if source["kind"] == "mcp":\n        at, read_before, failed_before = split_cursor(cursor)\n        since = parse_time(at) or now - lookback\n        # Look back a little past the cursor: the hub dedupes, and sources index late.\n        since = min(since, now) - dt.timedelta(minutes=float(source.get("overlap_minutes", 10)))\n        clock = {"now": now, "since": since}\n        data = ws.mcp(source.get("service", name), source["tool"], clause_ids(fill(source.get("args", {}), None, clock), used))\n        items = get_path(data, source.get("items", "items")) if source.get("items", "items") else data\n        if source.get("sections"):\n            items = sections(items, source["sections"].get("split", r"^#+ .*$"), source["sections"].get("keys"))\n        items = [item for item in items or [] if isinstance(item, dict)]\n        detail = source.get("detail")\n        next_cursor = iso(now)\n        if detail and detail.get("after"):\n            items, read_now, held, failed = detailed(ws, source, detail, items, clock, read_before, names, failed_before)\n            # The versions read (and those that failed) go in the cursor; one left unread keeps its time from passing\n            # (to the microsecond).\n            at_ = min(held - dt.timedelta(microseconds=1), now) if held else now\n            state = {"at": at_.astimezone(dt.timezone.utc).isoformat().replace("+00:00", "Z"), "read": read_now}\n            if failed:\n                state["failed"] = failed\n            next_cursor = json.dumps(state, separators=(",", ":"))\n        elif detail:\n            items, _, _, _ = detailed(ws, source, detail, items, clock, [], names)\n        events = [e for e in (to_event(name, item, source.get("map", {}), clock) for item in items) if e]\n        return events, next_cursor\n    if source["kind"] == "table":\n        if not warehouse:\n            raise Unavailable("a table source needs --warehouse")\n        if source.get("table") and not ws.table_exists(source["table"]):\n            raise Unavailable(f"{source[\'table\']} isn\'t there or you can\'t read it")\n        since = cursor or source.get("start", "1970-01-01T00:00:00Z")\n        query, bound = bind_ids(source["query"], used)\n        rows = ws.sql(warehouse, query, {"since": since, **bound})\n        clock = {"now": now, "since": parse_time(since) or now - lookback}\n        events = [e for e in (to_event(name, row, source.get("map", {}), clock) for row in rows) if e]\n        watermark = source.get("watermark")\n        marks = [str(row[watermark]) for row in rows if watermark and row.get(watermark) is not None]\n        return events, max(marks + [since])\n    raise Unavailable(f"unknown kind {source[\'kind\']}")\n\n\ndef run(ws: Workspace, config: dict, hub: str | None, warehouse: str | None, dry_run=False, log: Callable[[str], None] = print, now: dt.datetime | None = None, inbox: LakebaseInbox | None = None) -> dict:\n    """Polls the sources that are on. Reaches the hub at its URL, or through `inbox`."""\n    now = now or dt.datetime.now(dt.timezone.utc)\n    hub = hub or config.get("hub")\n    if not dry_run and not hub and not inbox:\n        raise SystemExit("Say where the hub is: --hub <app url> (or `hub` in the config), or --lakebase")\n\n    def call(method: str, path: str, body: Any = None) -> Any:\n        return inbox.call(method, path, body) if inbox else ws.hub(hub, method, path, body)\n\n    state = {} if dry_run else {s["source"]: s for s in call("GET", "/api/sources")["sources"]}\n    summary: dict[str, Any] = {}\n    ids: dict[str, list[str]] = {}\n    names: list[str] = []\n    ids_error = ""\n    on = [s for s in config.get("sources", []) if dry_run or (state.get(s["name"]) or {}).get("enabled")]\n    wanted = [s for s in on if s.get("ids") or (s.get("detail") or {}).get("named_in")]\n    if wanted and (hub or inbox):\n        try:\n            known_ids = call("GET", "/api/ids")\n            ids, names = known_ids.get("ids") or {}, known_ids.get("names") or []\n        except Exception as error:  # the sources that need ids are skipped, saying why\n            ids_error = f"couldn\'t read account ids: {error}"[:600]\n            log(ids_error)\n    for source in config.get("sources", []):\n        name = source["name"]\n        known = state.get(name)\n        if not dry_run and not (known and known.get("enabled")):\n            summary[name] = "off"\n            continue\n        try:\n            if ids_error and (source.get("ids") or (source.get("detail") or {}).get("named_in")):\n                raise Unavailable(ids_error)\n            events, cursor = poll_source(ws, source, known.get("cursor") if known else None, warehouse or config.get("warehouse"), now, ids, names)\n        except (NotSignedIn, Unavailable) as error:\n            summary[name] = f"unavailable: {error}"\n            log(f"{name}: {summary[name]}")\n            if not dry_run:\n                call("POST", "/api/cursor", {"source": name, "error": str(error)})\n            continue\n        except Exception as error:  # one source failing doesn\'t stop the others\n            summary[name] = f"failed: {error}"\n            log(f"{name}: {summary[name]}")\n            if not dry_run:\n                call("POST", "/api/cursor", {"source": name, "error": f"failed: {error}"[:900]})\n            continue\n        if dry_run:\n            summary[name] = {"events": len(events), "sample": events[:3], "cursor": cursor}\n            continue\n        totals = {"queued": 0} if inbox else {"new": 0, "changed": 0, "same": 0, "created": 0}\n        retry = False\n        for start in range(0, len(events), BATCH):\n            reply = call("POST", "/api/events", {"events": events[start : start + BATCH]})\n            if inbox:  # the hub handles it within a minute (and again, its cursor waiting, if some failed to save)\n                totals["queued"] += len(events[start : start + BATCH])\n                continue\n            for key in ("new", "changed", "same"):\n                totals[key] += reply.get(key, 0)\n            totals["created"] += len(reply.get("created", []))\n            retry = retry or bool(reply.get("retry"))\n        if retry:  # some failed to save: the cursor stays, so the next poll reads them again\n            summary[name] = f"failed: some events didn\'t save, read again next time"\n            log(f"{name}: {summary[name]}")\n            call("POST", "/api/cursor", {"source": name, "error": summary[name]})\n            continue\n        # The cursor moves only once the hub has the events (the inbox keeps them in order).\n        call("POST", "/api/cursor", {"source": name, "cursor": cursor, "error": ""})\n        summary[name] = {"events": len(events), **totals}\n        log(f"{name}: {summary[name]}")\n    return summary\n\n\ndef main(argv: Iterable[str] | None = None) -> int:\n    parser = argparse.ArgumentParser(description=__doc__.split("\\n")[0])\n    parser.add_argument("--config", required=True, help="sources JSON (a workspace file or volume path)")\n    parser.add_argument("--hub", help="the hub app\'s URL (or `hub` in the config)")\n    parser.add_argument("--lakebase", action="store_true", help="reach the hub through its inbox in Lakebase (for jobs; see `lakebase` in the config)")\n    parser.add_argument("--warehouse", help="SQL warehouse id, for table sources")\n    parser.add_argument("--dry-run", action="store_true", help="poll every source and print, without the hub")\n    args = parser.parse_args(list(argv) if argv is not None else None)\n    with open(args.config) as file:\n        config = json.load(file)\n    hub_auth = config.get("hub_auth")\n    if hub_auth is not None:\n        problem = check_hub_auth(hub_auth)\n        if problem:\n            raise SystemExit(problem)\n        if args.lakebase:\n            raise SystemExit("hub_auth is for calling the hub app (--hub <app url>, or `hub` in the config); --lakebase writes to the hub\'s inbox as the job\'s owner and can\'t use it. Use --hub instead.")\n    ws = Workspace(hub_auth=hub_auth)\n    inbox = LakebaseInbox(ws, config.get("lakebase") or {}) if args.lakebase and not args.dry_run else None\n    summary = run(ws, config, args.hub, args.warehouse, args.dry_run, inbox=inbox)\n    print(json.dumps(summary, indent=2, default=str))\n    return 0\n\n\nif __name__ == "__main__":\n    # Only exit on failure: a Databricks job counts any SystemExit, even 0, as a failed task.\n    code = main()\n    if code:\n        sys.exit(code)\n';
var EXAMPLE_SOURCES = '{\n  "hub": "https://<your-signals-hub-app-url>",\n  "sources": [\n    {\n      "name": "google_calendar",\n      "kind": "mcp",\n      "tool": "calendar_event_list",\n      "args": { "time_min": "{now}", "time_max": "{now+7d}", "max_results": 50, "query": "" },\n      "items": "items",\n      "detail": { "tool": "calendar_event_get", "args": { "event_id": "{id}" }, "max": 50 },\n      "map": {\n        "external_id": "id",\n        "title": "summary",\n        "url": "htmlLink",\n        "occurred_at": "{start.dateTime}{start.date}",\n        "payload": ["start", "end", "status", "attendeeCount", "attendees", "organizer", "description", "location", "hangoutLink", "recurringEventId"]\n      }\n    },\n    {\n      "name": "gmail",\n      "kind": "mcp",\n      "tool": "gmail_search",\n      "args": { "query": "in:inbox after:{since_epoch}", "max_results": 50 },\n      "items": "items",\n      "lookback_hours": 24,\n      "map": {\n        "external_id": "id",\n        "title": "subject",\n        "actor": "from",\n        "group_key": "threadId",\n        "url": "https://mail.google.com/mail/u/0/#all/{threadId}",\n        "occurred_at": "date",\n        "payload": ["from", "to", "snippet", "labelIds"]\n      }\n    },\n    {\n      "name": "gmail.sent",\n      "service": "gmail",\n      "kind": "mcp",\n      "tool": "gmail_search",\n      "args": { "query": "in:sent after:{since_epoch}", "max_results": 50 },\n      "items": "items",\n      "lookback_hours": 24,\n      "map": {\n        "external_id": "id",\n        "title": "subject",\n        "actor": "from",\n        "group_key": "threadId",\n        "url": "https://mail.google.com/mail/u/0/#all/{threadId}",\n        "occurred_at": "date",\n        "payload": ["from", "to", "snippet", "labelIds"]\n      }\n    },\n    {\n      "name": "google_drive",\n      "kind": "mcp",\n      "tool": "google_drive_list_recent",\n      "args": { "days": 1, "max_results": 50 },\n      "items": "items",\n      "detail": { "tool": "google_file_read", "args": { "file_id": "{id}", "file_type": "doc", "limit": 20000 }, "when": { "name": "Notes by Gemini" }, "named_in": "name", "after": "modifiedTime", "max": 10 },\n      "map": {\n        "external_id": "{id}:{modifiedTime}",\n        "group_key": "id",\n        "title": "name",\n        "url": "webViewLink",\n        "occurred_at": "modifiedTime",\n        "payload": {\n          "mimeType": "mimeType",\n          "modifiedTime": "modifiedTime",\n          "notes": { "from": "content", "match": "(?ms)^(Summary:?[ \\\\t]*$.*?)^(?:Details|Transcript|Attachments):?[ \\\\t]*$", "max": 6000 },\n          "meeting": { "from": "content", "match": "(https://calendar\\\\.google\\\\.com/calendar/event\\\\?eid=[A-Za-z0-9_-]+)" }\n        }\n      }\n    },\n    {\n      "name": "slack",\n      "kind": "mcp",\n      "service": "slack",\n      "tool": "slack_search_public_and_private",\n      "args": { "keywords": ["<@YOUR_SLACK_USER_ID>"], "filters": "", "natural_language_query": "", "after": "{since_epoch}", "limit": 20, "include_bots": false },\n      "items": "results",\n      "sections": {\n        "split": "^### Result \\\\d+ of \\\\d+\\\\s*$",\n        "keys": ["Channel", "Participants", "From", "Time", "Message_ts", "Reply count", "Permalink", "Text", "Context before", "Context after"]\n      },\n      "lookback_hours": 24,\n      "map": {\n        "external_id": { "from": "permalink", "match": "\\\\((https://[^)?]+)" },\n        "url": { "from": "permalink", "match": "\\\\((https://[^)]+)\\\\)" },\n        "group_key": { "from": "permalink", "match": ["/archives/([A-Z0-9]+)/p\\\\d+\\\\?(?:[^)\\\\s]*&)?thread_ts=(\\\\d+)\\\\.(\\\\d+)", "/archives/([A-Z0-9]+)/p(\\\\d{10})(\\\\d{6})"], "replace": "\\\\1:\\\\2.\\\\3" },\n        "title": { "from": "text", "match": "^\\\\s*([^\\\\n]{1,140})" },\n        "actor": { "from": "from", "match": "<([^>\\\\s]+@[^>\\\\s]+)>" },\n        "occurred_at": "message_ts",\n        "payload": {\n          "channel": { "from": "channel", "match": "^(.*?)\\\\s*\\\\(ID:" },\n          "channel_id": { "from": "channel", "match": "\\\\(ID: ([A-Z0-9]+)\\\\)" },\n          "from": { "from": "from", "match": "^(.*?)\\\\s*\\\\(ID:" },\n          "text": "text",\n          "context_before": "context_before"\n        }\n      }\n    },\n    {\n      "name": "slack.sent",\n      "kind": "mcp",\n      "service": "slack",\n      "tool": "slack_search_public_and_private",\n      "args": { "keywords": [], "filters": "from:<@YOUR_SLACK_USER_ID>", "natural_language_query": "", "after": "{since_epoch}", "limit": 20, "include_bots": false },\n      "items": "results",\n      "sections": {\n        "split": "^### Result \\\\d+ of \\\\d+\\\\s*$",\n        "keys": ["Channel", "Participants", "From", "Time", "Message_ts", "Reply count", "Permalink", "Text", "Context before", "Context after"]\n      },\n      "lookback_hours": 24,\n      "map": {\n        "external_id": { "from": "permalink", "match": "\\\\((https://[^)?]+)" },\n        "url": { "from": "permalink", "match": "\\\\((https://[^)]+)\\\\)" },\n        "group_key": { "from": "permalink", "match": ["/archives/([A-Z0-9]+)/p\\\\d+\\\\?(?:[^)\\\\s]*&)?thread_ts=(\\\\d+)\\\\.(\\\\d+)", "/archives/([A-Z0-9]+)/p(\\\\d{10})(\\\\d{6})"], "replace": "\\\\1:\\\\2.\\\\3" },\n        "title": { "from": "text", "match": "^\\\\s*([^\\\\n]{1,140})" },\n        "actor": { "from": "from", "match": "<([^>\\\\s]+@[^>\\\\s]+)>" },\n        "occurred_at": "message_ts",\n        "payload": {\n          "channel": { "from": "channel", "match": "^(.*?)\\\\s*\\\\(ID:" },\n          "channel_id": { "from": "channel", "match": "\\\\(ID: ([A-Z0-9]+)\\\\)" },\n          "from": { "from": "from", "match": "^(.*?)\\\\s*\\\\(ID:" },\n          "text": "text",\n          "context_before": "context_before"\n        }\n      }\n    },\n    {\n      "name": "jira",\n      "kind": "mcp",\n      "service": "atlassian",\n      "tool": "searchJiraIssuesUsingJql",\n      "args": { "jql": "(assignee = currentUser() OR reporter = currentUser() OR watcher = currentUser()) AND updated >= \\"{since_date}\\" ORDER BY updated DESC", "maxResults": 50, "fields": ["summary", "status", "updated", "priority", "assignee"] },\n      "items": "issues",\n      "lookback_hours": 48,\n      "map": {\n        "external_id": "key",\n        "group_key": "key",\n        "title": "{key} {fields.summary}",\n        "occurred_at": "fields.updated",\n        "payload": { "status": "{fields.status.name}", "status_category": "{fields.status.statusCategory.name}", "priority": "{fields.priority.name}", "assignee": "{fields.assignee.displayName}" }\n      }\n    },\n    {\n      "name": "jira_customers",\n      "kind": "mcp",\n      "service": "atlassian",\n      "tool": "searchJiraIssuesUsingJql",\n      "ids": ["jira_customer"],\n      "args": { "jql": "({jira_customer: \\"Customer\\" ~ \\"{}\\"}) AND updated >= \\"{since_date}\\" ORDER BY updated DESC", "maxResults": 50, "fields": ["summary", "status", "updated", "priority", "customfield_10001"] },\n      "items": "issues",\n      "lookback_hours": 48,\n      "map": {\n        "external_id": "key",\n        "group_key": "key",\n        "title": "{key} {fields.summary}",\n        "account": "fields.customfield_10001",\n        "occurred_at": "fields.updated",\n        "payload": { "status": "{fields.status.name}", "status_category": "{fields.status.statusCategory.name}", "priority": "{fields.priority.name}" }\n      }\n    },\n    {\n      "name": "table.support_cases",\n      "kind": "table",\n      "table": "main.support.cases",\n      "query": "SELECT case_id, subject, status, account_name, updated_at FROM main.support.cases WHERE updated_at > :since ORDER BY updated_at LIMIT 1000",\n      "watermark": "updated_at",\n      "map": {\n        "external_id": "case_id",\n        "group_key": "case_id",\n        "title": "{case_id} {subject}",\n        "account": "account_name",\n        "occurred_at": "updated_at",\n        "payload": ["status", "subject"]\n      }\n    },\n    {\n      "name": "table.usage",\n      "kind": "table",\n      "table": "main.sales.account_usage",\n      "ids": ["crm"],\n      "query": "SELECT account_id, workspace_id, metric, value, updated_at FROM main.sales.account_usage WHERE account_id IN (:crm) AND updated_at > :since ORDER BY updated_at LIMIT 1000",\n      "watermark": "updated_at",\n      "map": {\n        "external_id": "{account_id}:{workspace_id}:{metric}:{updated_at}",\n        "group_key": "{account_id}:{metric}",\n        "title": "{metric} for workspace {workspace_id}",\n        "account": "account_id",\n        "occurred_at": "updated_at",\n        "payload": ["workspace_id", "metric", "value"]\n      }\n    }\n  ]\n}\n';

// plugins/signals/src/poller-job.ts
var POLLER_SCHEDULE = "0 0/15 * * * ?";
var pollerJobName = (user) => `Signals poller (${user})`;
var isSlack = (source) => source.name === "slack" || source.name.startsWith("slack.");
function personalSources(onboarding, slackUserId, example = EXAMPLE_SOURCES) {
  const parsed = JSON.parse(example);
  const slack = slackUserId?.trim();
  const sources = parsed.sources.filter((source) => source.kind === "mcp" && (!isSlack(source) || slack)).map((source) => isSlack(source) && slack ? JSON.parse(JSON.stringify(source).replaceAll("YOUR_SLACK_USER_ID", slack)) : source);
  return `${JSON.stringify({ lakebase: onboarding.lakebase, sources }, null, 2)}
`;
}
function pollerJobSettings(onboarding) {
  return {
    name: pollerJobName(onboarding.user),
    max_concurrent_runs: 1,
    schedule: { quartz_cron_expression: POLLER_SCHEDULE, timezone_id: "UTC", pause_status: "UNPAUSED" },
    tasks: [{ task_key: "poll", environment_key: "poller", spark_python_task: { python_file: `${onboarding.folder}/poller.py`, parameters: [...onboarding.args], source: "WORKSPACE" } }],
    environments: [{ environment_key: "poller", spec: { client: "3", dependencies: ["databricks-sdk>=0.40", "psycopg[binary]>=3.1"] } }]
  };
}
async function updatePollerTask(client, jobId, settings, signal) {
  const job = await client.get("/api/2.2/jobs/get", { query: { job_id: jobId }, ...signal && { signal } });
  const ours = settings.tasks[0];
  const task = job.settings?.tasks?.find((t) => t.spark_python_task?.python_file?.endsWith("/signals-poller/poller.py"));
  const tasks = (job.settings?.tasks ?? []).filter((t) => t !== task).concat({ ...ours, task_key: task?.task_key ?? ours.task_key });
  const environments = (job.settings?.environments ?? []).filter((e) => e.environment_key !== ours.environment_key).concat(settings.environments);
  await client.post("/api/2.2/jobs/update", { job_id: jobId, new_settings: { tasks, environments } }, { ...signal && { signal } });
}
async function findPollerJob(client, user, signal) {
  const script = `/Workspace/Users/${user}/signals-poller/poller.py`.toLowerCase();
  const runsPoller = (job) => job.settings?.tasks?.some((task) => [script, script.replace(/^\/workspace/, "")].includes((task.spark_python_task?.python_file ?? "").toLowerCase()));
  const mine = (job) => !job.creator_user_name || job.creator_user_name.toLowerCase() === user.toLowerCase();
  let pageToken;
  for (let page = 0; page < 20; page++) {
    const reply = await client.get("/api/2.2/jobs/list", { query: { expand_tasks: true, limit: 100, ...pageToken && { page_token: pageToken } }, ...signal && { signal } });
    const jobs = (reply.jobs ?? []).filter(mine);
    const found = jobs.find((job) => job.settings?.name === pollerJobName(user)) ?? jobs.find(runsPoller);
    if (found) return found.job_id;
    if (!reply.next_page_token) return void 0;
    pageToken = reply.next_page_token;
  }
  return void 0;
}
async function setUpPollerJob(client, onboarding, options = {}) {
  const { signal } = options;
  if (!onboarding.lakebase) throw new Error("The hub doesn't know where its database is, so a job can't reach it. Check the app's postgres resource.");
  if (onboarding.role === "waiting") throw new Error("Create your database role first: the job logs in to the hub's database as it.");
  const config = `${onboarding.folder}/sources.json`;
  const hadSources = await client.get("/api/2.0/workspace/get-status", { query: { path: config }, ...signal && { signal } }).then(
    () => true,
    (error) => error.status === 404 || error.errorCode === "RESOURCE_DOES_NOT_EXIST" ? false : Promise.reject(error)
  );
  await writeWorkspaceFiles(client, onboarding.folder, { "poller.py": POLLER, "sources.json": personalSources(onboarding, options.slackUserId) }, { keep: ["sources.json"], ...signal && { signal } });
  const settings = pollerJobSettings(onboarding);
  const existing = await findPollerJob(client, onboarding.user, signal);
  let jobId = existing;
  if (existing) await updatePollerTask(client, existing, settings, signal);
  else jobId = (await client.post("/api/2.2/jobs/create", settings, { ...signal && { signal } })).job_id;
  await client.post("/api/2.2/jobs/run-now", { job_id: jobId }, { ...signal && { signal } });
  return { jobId, created: !existing, keptSources: hadSources };
}

// plugins/signals/src/index.tsx
var inject = ["react", "settingsCards", "panels", "pages", "conversation"];
var WORKSPACE_PREF = "signalsWorkspace";
function HubWorkspace(props) {
  const [, setProfile] = usePreference(props.main, WORKSPACE_PREF);
  const profile = props.service.profile();
  return /* @__PURE__ */ React.createElement(Stack, { gap: 8 }, /* @__PURE__ */ React.createElement(SectionHeader, { title: "Workspace", description: "The workspace your signals hub runs in. Agents' signals tools use it too." }), /* @__PURE__ */ React.createElement(WorkspaceField, { service: props.main, ...profile && { profile }, onChange: setProfile }));
}
function SourceRow(props) {
  const { service, hub: hub2, info, state } = props;
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState();
  const signIn = useAsync(async (signal) => info.service ? signInState(await service.ready(signal), info.service, signal) : void 0, [info.service]);
  const on = state?.enabled === true;
  const toggle2 = async (enabled, forget = false) => {
    setBusy(true);
    setError(void 0);
    try {
      props.onChange((await hub2.setSource(info.name, enabled, forget)).sources);
    } catch (problem) {
      setError(describeError(problem));
    } finally {
      setBusy(false);
    }
  };
  const loginUrl = info.service ? service.workspaceUrl(signInPath(info.service)) : void 0;
  return /* @__PURE__ */ React.createElement("div", { className: "dbx-card", style: { padding: 12 } }, /* @__PURE__ */ React.createElement(Stack, { gap: 6 }, /* @__PURE__ */ React.createElement(Stack, { direction: "row", align: "center", justify: "space-between", gap: 10 }, /* @__PURE__ */ React.createElement(Stack, { gap: 2, style: { minWidth: 0 } }, /* @__PURE__ */ React.createElement(Stack, { direction: "row", gap: 6, align: "center" }, /* @__PURE__ */ React.createElement(Text, { weight: 500 }, info.label), on ? /* @__PURE__ */ React.createElement(Badge, { tone: "success" }, "On") : /* @__PURE__ */ React.createElement(Badge, null, "Off"), signIn.data === "needed" && /* @__PURE__ */ React.createElement(Badge, { tone: "warning" }, "Not signed in"), signIn.loading && info.service && /* @__PURE__ */ React.createElement(Spinner, { size: 10 })), info.description && /* @__PURE__ */ React.createElement(Text, { tone: "subtle", size: "sm" }, info.description), on && /* @__PURE__ */ React.createElement(Text, { tone: "tertiary", size: "xs" }, state?.last_post_at ? `Last read ${ago(state.last_post_at * 1e3)} (${state.last_count ?? 0} items)` : "Not read yet: your poller job reads it on its next run."), on && state?.last_error && /* @__PURE__ */ React.createElement(Text, { tone: "danger", size: "xs" }, state.last_error)), /* @__PURE__ */ React.createElement(Stack, { direction: "row", gap: 6, align: "center", style: { flex: "none" } }, signIn.data === "needed" && loginUrl && /* @__PURE__ */ React.createElement(Button, { size: "sm", onClick: () => openExternal(loginUrl) }, "Sign in"), on ? /* @__PURE__ */ React.createElement(React.Fragment, null, /* @__PURE__ */ React.createElement(Button, { size: "sm", disabled: busy, onClick: () => void toggle2(false) }, "Turn off"), /* @__PURE__ */ React.createElement(Button, { size: "sm", variant: "danger", disabled: busy, title: "Turn it off and delete what the hub keeps from it", onClick: () => void toggle2(false, true) }, "Forget")) : /* @__PURE__ */ React.createElement(Button, { size: "sm", variant: "brand", disabled: busy || signIn.data === "needed", onClick: () => void toggle2(true) }, busy ? /* @__PURE__ */ React.createElement(Spinner, { size: 12 }) : null, "Turn on"))), error && /* @__PURE__ */ React.createElement(Text, { tone: "danger", size: "sm" }, error)));
}
function PollerSetup(props) {
  const { hub: hub2, service } = props;
  const looked = useAsync(async (signal) => hub2.onboarding(signal), [hub2]);
  const [state, setState] = React.useState();
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState();
  React.useEffect(() => setState(looked.data), [looked.data]);
  const create = async () => {
    setBusy(true);
    setError(void 0);
    try {
      setState(await hub2.createRole());
    } catch (problem) {
      setError(describeError(problem));
    } finally {
      setBusy(false);
    }
  };
  const snippet = state && lakebaseSnippet(state);
  const existing = useAsync(async (signal) => state ? findPollerJob(await service.ready(signal), state.user, signal) : void 0, [state?.user]);
  const [slackId, setSlackId] = React.useState("");
  const [job, setJob] = React.useState();
  const [jobBusy, setJobBusy] = React.useState(false);
  const [jobError, setJobError] = React.useState();
  const jobId = job?.jobId ?? existing.data;
  const makeJob = async () => {
    if (!state) return;
    setJobBusy(true);
    setJobError(void 0);
    try {
      setJob(await setUpPollerJob(await service.ready(), state, { ...slackId.trim() && { slackUserId: slackId.trim() } }));
    } catch (problem) {
      setJobError(describeError(problem));
    } finally {
      setJobBusy(false);
    }
  };
  const jobUrl = jobId ? service.workspaceUrl(`/jobs/${jobId}`) : void 0;
  return /* @__PURE__ */ React.createElement(Stack, { gap: 10 }, /* @__PURE__ */ React.createElement(SectionHeader, { title: "Your poller", description: "A job that runs as you reads the sources you turn on and writes what it finds to the hub's database, as your own database role." }), looked.loading && /* @__PURE__ */ React.createElement(Spinner, { size: 12 }), looked.error && /* @__PURE__ */ React.createElement(Notice, { tone: "danger", title: "Couldn't check your poller setup" }, describeError(looked.error)), state && /* @__PURE__ */ React.createElement("div", { className: "dbx-card", style: { padding: 12 } }, /* @__PURE__ */ React.createElement(Stack, { gap: 8 }, /* @__PURE__ */ React.createElement(Stack, { direction: "row", align: "center", justify: "space-between", gap: 10 }, /* @__PURE__ */ React.createElement(Stack, { direction: "row", gap: 6, align: "center" }, /* @__PURE__ */ React.createElement(Text, { weight: 500 }, "Database role"), state.role === "waiting" ? /* @__PURE__ */ React.createElement(Badge, { tone: "warning" }, "Not set up") : /* @__PURE__ */ React.createElement(Badge, { tone: "success" }, state.role === "created" ? "Created" : "Ready")), state.role === "waiting" && /* @__PURE__ */ React.createElement(Button, { size: "sm", variant: "brand", disabled: busy, onClick: () => void create() }, busy ? /* @__PURE__ */ React.createElement(Spinner, { size: 12 }) : null, "Create my role")), /* @__PURE__ */ React.createElement(Text, { tone: "subtle", size: "sm" }, state.role === "waiting" ? state.waiting?.reason ?? "You don't have a role in the hub's database yet." : `${state.user} can write to the hub's inbox.`), state.role === "waiting" && state.waiting?.command && /* @__PURE__ */ React.createElement(Stack, { gap: 4 }, /* @__PURE__ */ React.createElement(Text, { tone: "tertiary", size: "xs" }, "If the hub can't create it, someone with Can Manage on the database project can run:"), /* @__PURE__ */ React.createElement(CodeView, { code: state.waiting.command, language: "bash", copy: true })), error && /* @__PURE__ */ React.createElement(Text, { tone: "danger", size: "sm" }, error))), state && state.role !== "waiting" && state.lakebase && /* @__PURE__ */ React.createElement("div", { className: "dbx-card", style: { padding: 12 } }, /* @__PURE__ */ React.createElement(Stack, { gap: 8 }, /* @__PURE__ */ React.createElement(Stack, { direction: "row", align: "center", justify: "space-between", gap: 10 }, /* @__PURE__ */ React.createElement(Stack, { direction: "row", gap: 6, align: "center" }, /* @__PURE__ */ React.createElement(Text, { weight: 500 }, "Poller job"), existing.loading ? /* @__PURE__ */ React.createElement(Spinner, { size: 10 }) : jobId ? /* @__PURE__ */ React.createElement(Badge, { tone: "success" }, "Set up") : /* @__PURE__ */ React.createElement(Badge, null, "Not set up")), /* @__PURE__ */ React.createElement(Stack, { direction: "row", gap: 6, align: "center" }, jobUrl && /* @__PURE__ */ React.createElement(Button, { size: "sm", onClick: () => openExternal(jobUrl) }, "Open job"), /* @__PURE__ */ React.createElement(Button, { size: "sm", variant: jobId ? "default" : "brand", disabled: jobBusy || existing.loading, onClick: () => void makeJob() }, jobBusy ? /* @__PURE__ */ React.createElement(Spinner, { size: 12 }) : null, jobId ? "Update my job" : "Create my job"))), /* @__PURE__ */ React.createElement(Text, { tone: "subtle", size: "sm" }, "Puts poller.py and a sources.json with your personal sources (Gmail, Calendar, Drive, Slack, Jira) in ", /* @__PURE__ */ React.createElement("code", null, state.folder), ", and runs it as you every 15 minutes on serverless. It only reads the sources you turn on above. Shared table sources aren't in it: one job reads those for everyone."), !jobId && /* @__PURE__ */ React.createElement(Stack, { direction: "row", gap: 6, align: "center" }, /* @__PURE__ */ React.createElement(Text, { size: "sm" }, "Your Slack user id"), /* @__PURE__ */ React.createElement("input", { className: "dbx-input", placeholder: "U01ABCDEF (optional; without it, Slack is left out)", value: slackId, onChange: (event) => setSlackId(event.target.value), style: { maxWidth: 320 } })), job && /* @__PURE__ */ React.createElement(Text, { tone: "success", size: "sm" }, job.created ? "Created your job" : "Updated your job", " and started a first run.", job.keptSources ? " Your sources.json was already there, so it was kept as it is." : ""), jobError && /* @__PURE__ */ React.createElement(Text, { tone: "danger", size: "sm" }, jobError))), state && snippet && /* @__PURE__ */ React.createElement(Stack, { gap: 4 }, /* @__PURE__ */ React.createElement(Text, { tone: "subtle", size: "sm" }, "To set it up by hand instead, add this to ", /* @__PURE__ */ React.createElement("code", null, state.folder, "/sources.json"), ", and have your job run ", /* @__PURE__ */ React.createElement("code", null, state.folder, "/poller.py"), " with ", /* @__PURE__ */ React.createElement("code", null, state.args.join(" ")), ":"), /* @__PURE__ */ React.createElement(CodeView, { code: snippet, language: "json", copy: true })));
}
function SignalsSettings(props) {
  const { service } = props;
  const snapshot = useConnection(service);
  const workspace = "profile" in snapshot ? snapshot.profile.host : void 0;
  const [picked, setPicked] = usePreference(service, HUB_PREFERENCE);
  const hubs = useAsync(async (signal) => chosenHub(service, signal), [snapshot.status, workspace, picked]);
  const app = hubs.data?.app;
  const hub2 = React.useMemo(() => app ? new HubClient(service.client(), app) : void 0, [app?.name, app?.url, snapshot.status, workspace]);
  const [sources, setSources] = React.useState();
  const loaded = useAsync(async (signal) => hub2 ? hub2.sources(signal) : void 0, [hub2]);
  React.useEffect(() => setSources(loaded.data?.sources), [loaded.data]);
  if (snapshot.status !== "connected")
    return /* @__PURE__ */ React.createElement(Notice, { title: "Connect Databricks", action: /* @__PURE__ */ React.createElement(Button, { variant: "brand", onClick: () => service.openSettings() }, "Connect") }, "Signals reads your sources as you, through your Databricks workspace.");
  if (hubs.loading) return /* @__PURE__ */ React.createElement(Stack, { direction: "row", gap: 8, align: "center" }, /* @__PURE__ */ React.createElement(Spinner, { size: 12 }), /* @__PURE__ */ React.createElement(Text, { tone: "subtle" }, "Looking for a signals hub\u2026"));
  if (hubs.error) return /* @__PURE__ */ React.createElement(Notice, { tone: "danger", title: "Couldn't list Databricks Apps" }, describeError(hubs.error));
  if (!app)
    return /* @__PURE__ */ React.createElement(Notice, { title: "No signals hub in this workspace" }, "A signals hub is a Databricks App with a Lakebase database whose description starts with \u201C", `Signals hub`, "\u201D. See the plugin's README for deploying one; then come back here to turn on your sources.");
  const catalog = loaded.data?.catalog ?? [];
  const extra = (sources ?? []).filter((state) => !catalog.some((info) => info.name === state.source)).map((state) => ({ name: state.source, label: state.source }));
  return /* @__PURE__ */ React.createElement(Stack, { gap: 20 }, /* @__PURE__ */ React.createElement(Stack, { gap: 8 }, /* @__PURE__ */ React.createElement(
    SectionHeader,
    {
      title: "Hub",
      description: /* @__PURE__ */ React.createElement(React.Fragment, null, "Tasks are kept in ", /* @__PURE__ */ React.createElement("b", null, app.name), app.url ? "" : " (not running)", ". Your sources are read by a job that runs as you, so the hub only gets what you can read, and only from sources you turn on.")
    }
  ), (hubs.data?.apps.length ?? 0) > 1 && /* @__PURE__ */ React.createElement("select", { className: "dbx-input", value: app.name, onChange: (event) => setPicked(event.target.value), style: { maxWidth: 320 } }, hubs.data.apps.map((found) => /* @__PURE__ */ React.createElement("option", { key: found.name, value: found.name }, found.name)))), /* @__PURE__ */ React.createElement(Stack, { gap: 10 }, /* @__PURE__ */ React.createElement(SectionHeader, { title: "Your sources", description: "Off until you turn them on. Turning one off stops it; Forget also deletes what the hub keeps from it (tasks others work on stay)." }), loaded.loading && /* @__PURE__ */ React.createElement(Spinner, { size: 12 }), loaded.error && /* @__PURE__ */ React.createElement(Notice, { tone: "danger", title: "Couldn't reach the hub" }, describeError(loaded.error)), hub2 && [...catalog, ...extra, { name: "agent", label: "Agents", description: "Events your agents send with signals_event." }].map((info) => /* @__PURE__ */ React.createElement(SourceRow, { key: info.name, service, hub: hub2, info, state: sources?.find((state) => state.source === info.name), onChange: setSources }))), hub2 && /* @__PURE__ */ React.createElement(PollerSetup, { hub: hub2, service }));
}
var HUB_AUTHORS_KEY = "signals.hubAuthors";
function registerPosts(ctx, scope, databricks) {
  const live = new LiveTasks(databricks);
  const authors = /* @__PURE__ */ new Set();
  try {
    for (const key of JSON.parse(globalThis.localStorage?.getItem(HUB_AUTHORS_KEY) ?? "[]")) if (typeof key === "string") authors.add(key);
  } catch {
  }
  const remember = (author) => {
    if (authors.has(author)) return;
    authors.add(author);
    try {
      globalThis.localStorage?.setItem(HUB_AUTHORS_KEY, JSON.stringify([...authors].slice(-20)));
    } catch {
    }
  };
  const openBoard = (channel) => {
    const navigation = optionalService(ctx, "navigation");
    void navigation?.open({ version: 1, kind: "page", pluginId: "bkvarda.databricks-signals", pageId: BOARD_PAGE, route: { version: 1, params: { channel } } });
  };
  scope.panels.register({ id: "task", title: "Task", matches: (target) => readTaskTarget(target) !== void 0, component: taskPanel(ctx, live) });
  scope.conversation.registerMessage({
    id: "task-post",
    title: "Signals task",
    matches: (message) => {
      if (!isTaskPost(message.content)) return false;
      remember(message.authorId);
      return true;
    },
    component: (props) => /* @__PURE__ */ React.createElement(TaskPostCard, { ctx, live, message: props.message, canOpen: props.canOpen, open: props.open, openBoard })
  });
  scope.conversation.registerMessage({
    id: "task-reply",
    title: "Signals update",
    matches: (message) => Boolean(message.threadRootId) && authors.has(message.authorId) && parseThreadPost(message.content) !== void 0,
    component: (props) => /* @__PURE__ */ React.createElement(ThreadPostCard, { ctx, live, message: props.message })
  });
}
function apply(ctx) {
  bindReact(ctx.react);
  const live = attach(ctx, { id: "bkvarda.databricks-signals", name: "Signals" }, (scope, main) => {
    const databricks = followWorkspace(main, WORKSPACE_PREF);
    const ownAgents = new Live();
    scope.inject(["agents"], (agents) => {
      ownAgents.set(agents.agents);
      agents.effect(() => () => ownAgents.set(void 0));
      for (const tool of signalsTools(databricks)) agents.agents.addTool(tool);
      agents.agents.addInstructions?.({ id: "accounts", text: ACCOUNT_INSTRUCTIONS });
    });
    scope.panels.register({
      id: "account",
      title: "Account",
      // Opened from the channel menu only, never from a link.
      matches: () => false,
      channelMenu: { label: "Set up account", eligible: (channel) => !channel.readOnly && !channel.cached },
      channelPlacement: "side",
      component: accountPanel(ctx, databricks, ownAgents)
    });
    scope.panels.register({
      id: "board",
      title: "Tasks board",
      matches: () => false,
      channelMenu: { label: "Tasks board", eligible: (channel) => !channel.cached },
      channelPlacement: "tab",
      component: boardPanel(ctx, databricks)
    });
    registerPosts(ctx, scope, databricks);
    return { main, databricks, BoardPage: boardPage(ctx, databricks) };
  });
  ctx.pages.register({
    id: BOARD_PAGE,
    title: "Tasks board",
    layout: "workspace",
    route: { version: 1, validate: validBoardRoute },
    component: (props) => {
      const runtime = useLive(live);
      return runtime ? /* @__PURE__ */ React.createElement(runtime.BoardPage, { ...props.navigation && { navigation: props.navigation } }) : /* @__PURE__ */ React.createElement(MissingCore, { ctx, feature: "Tasks board" });
    }
  });
  ctx.settingsCards.register({
    id: "signals",
    title: "Signals",
    component: () => {
      const runtime = useLive(live);
      return runtime ? /* @__PURE__ */ React.createElement(DbxRoot, null, /* @__PURE__ */ React.createElement(Stack, { gap: 24 }, /* @__PURE__ */ React.createElement(HubWorkspace, { main: runtime.main, service: runtime.databricks }), /* @__PURE__ */ React.createElement(SignalsSettings, { service: runtime.databricks }))) : /* @__PURE__ */ React.createElement(MissingCore, { ctx, feature: "Signals" });
    }
  });
}
export {
  WORKSPACE_PREF,
  apply,
  inject
};
