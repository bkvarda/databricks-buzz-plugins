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
function Card(props) {
  return /* @__PURE__ */ React.createElement("div", { className: "dbx-card", style: { padding: props.padding ?? 16, ...props.style } }, props.children);
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
    return this.call("GET", "/api/account", { query: { ...by }, ...signal && { signal } }).then((reply) => reply.account ? { ...reply.account, ...reply.labels && { labels: reply.labels }, ...reply.workstreams && { workstreams: reply.workstreams }, ...reply.warning && { warning: reply.warning } } : null);
  }
  saveAccount(input) {
    return this.call("POST", "/api/account", { body: input }).then((reply) => ({ ...reply.account, ...reply.labels && { labels: reply.labels }, ...reply.workstreams && { workstreams: reply.workstreams }, ...reply.warning && { warning: reply.warning } }));
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
function astr(label, input) {
  if (typeof input !== "string")
    throw new Error(`${label}: string expected`);
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
function astrArr(label, input) {
  if (!isArrayOf(true, input))
    throw new Error(`${label}: array of strings expected`);
}
function anumArr(label, input) {
  if (!isArrayOf(false, input))
    throw new Error(`${label}: array of numbers expected`);
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

// plugins/signals/app/model.ts
var capitalized = (word) => word.charAt(0).toUpperCase() + word.slice(1);
var MODES = ["auto", "draft", "ask", "off"];
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
var TASK_STATUSES = ["open", "in_progress", "waiting", "done", "dismissed"];

// plugins/signals/src/account-panel.tsx
var PREFERENCES_TEMPLATE = `How agents handle each kind of work: auto (do it and report), draft (prepare it for one of us to send), ask (ask first) or off (no tasks).

- everything: draft
- meeting prep: auto
- tickets: draft
- questions: draft

Anything else you write here is guidance agents follow, for example:
Keep customer replies short. Copy the account owner on anything about pricing.`;
function Playbooks(props) {
  const { value, onChange, agents, onAgents } = props;
  const [adding, setAdding] = React.useState("");
  const known = new Set(props.workstreams.map((name) => name.toLowerCase()));
  const extra = [...Object.keys(value), ...Object.keys(agents)].filter((name, index, all) => !known.has(name.toLowerCase()) && all.findIndex((other) => other.toLowerCase() === name.toLowerCase()) === index);
  const names = [...props.workstreams, ...extra];
  const keyOf = (name) => Object.keys(value).find((key) => key.toLowerCase() === name.toLowerCase()) ?? name;
  const agentKeyOf = (name) => Object.keys(agents).find((key) => key.toLowerCase() === name.toLowerCase()) ?? name;
  const add = () => {
    const name = adding.trim();
    if (!name) return;
    if (!names.some((other) => other.toLowerCase() === name.toLowerCase())) onChange({ ...value, [name]: "" });
    setAdding("");
  };
  return /* @__PURE__ */ React.createElement(Stack, { gap: 8 }, names.length === 0 && /* @__PURE__ */ React.createElement(Text, { size: "xs", tone: "subtle" }, "No workstreams yet. Add one below (a workstream your rules use, or a rule id)."), names.map((name) => {
    const key = keyOf(name);
    const text = value[key] ?? "";
    const who = agents[agentKeyOf(name)] ?? "";
    const named = who.split(/[,\s]+/).filter(Boolean).length;
    return /* @__PURE__ */ React.createElement(Disclosure, { key: name, summary: `${name}${text.trim() ? "" : " (no playbook)"}${named ? ` \xB7 ${named} agent${named === 1 ? "" : "s"}` : ""}` }, /* @__PURE__ */ React.createElement(Stack, { gap: 6 }, /* @__PURE__ */ React.createElement("input", { className: "dbx-input", placeholder: "Agents for this work (npubs); empty: the account's agents", value: who, onChange: (event) => onAgents({ ...agents, [agentKeyOf(name)]: event.target.value }) }), /* @__PURE__ */ React.createElement("textarea", { className: "dbx-textarea", rows: 6, maxLength: MAX_PLAYBOOK, placeholder: `How you like ${name} done: steps, what to include, tone, who to copy\u2026`, value: text, onChange: (event) => onChange({ ...value, [key]: event.target.value }) })));
  }), /* @__PURE__ */ React.createElement(Stack, { direction: "row", gap: 6, align: "center" }, /* @__PURE__ */ React.createElement("input", { className: "dbx-input", placeholder: "Another workstream or rule id", value: adding, onChange: (event) => setAdding(event.target.value), onKeyDown: (event) => event.key === "Enter" && add() }), /* @__PURE__ */ React.createElement(Button, { size: "sm", disabled: !adding.trim(), onClick: add }, "Add workstream")));
}
var splitList = (text) => text.split(/[,\n]/).map((item) => item.trim()).filter(Boolean);
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
function Form(props) {
  const { hub: hub2, channel, account } = props;
  const [name, setName] = React.useState(account?.name ?? channel.name.replace(/[-_]+/g, " "));
  const [aliases, setAliases] = React.useState(account?.aliases.join(", ") ?? "");
  const [domains, setDomains] = React.useState(account?.domains.join(", ") ?? "");
  const [ids, setIds] = React.useState(idsText(account?.ids));
  const [agents, setAgents] = React.useState(account?.agents.join(", ") ?? "");
  const [preferences, setPreferences] = React.useState(account?.preferences ?? PREFERENCES_TEMPLATE);
  const [playbooks, setPlaybooks] = React.useState({ ...account?.playbooks ?? {} });
  const [workstreamAgents, setWorkstreamAgents] = React.useState(Object.fromEntries(Object.entries(account?.workstream_agents ?? {}).map(([name2, keys]) => [name2, keys.map((key) => npubEncode(key)).join(", ")])));
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState();
  const read = React.useMemo(() => parsePreferences(preferences), [preferences]);
  const save = async () => {
    setBusy(true);
    setError(void 0);
    try {
      const saved = await hub2.saveAccount({
        name: account?.name ?? name.trim(),
        ...account && name.trim() !== account.name && { rename: name.trim() },
        channel: channel.id,
        aliases: splitList(aliases),
        domains: splitList(domains),
        ids: parseIds(ids),
        agents: splitList(agents),
        preferences,
        playbooks: Object.fromEntries(Object.entries(playbooks).filter(([, text]) => text.trim())),
        workstream_agents: Object.fromEntries(Object.entries(workstreamAgents).map(([name2, text]) => [name2, splitList(text.replace(/\s+/g, ","))]).filter(([, keys]) => keys.length))
      });
      props.onSaved(saved);
    } catch (problem) {
      setError(describeError(problem));
    } finally {
      setBusy(false);
    }
  };
  return /* @__PURE__ */ React.createElement(Card, null, /* @__PURE__ */ React.createElement(Stack, { gap: 12 }, /* @__PURE__ */ React.createElement(Field, { label: "Account", hint: "As tasks show it. Sources that name the account (a table column, say) match it or one of its other names." }, /* @__PURE__ */ React.createElement("input", { className: "dbx-input", value: name, onChange: (event) => setName(event.target.value) })), /* @__PURE__ */ React.createElement(Field, { label: "Other names", hint: "Comma-separated, e.g. ACME Corp, Acme Inc." }, /* @__PURE__ */ React.createElement("input", { className: "dbx-input", value: aliases, onChange: (event) => setAliases(event.target.value) })), /* @__PURE__ */ React.createElement(Field, { label: `${capitalized(account?.labels?.customer ?? "customer")} email domains`, hint: "Mail, meetings and mentions from people at these domains open tasks in this channel (with the hub's shared rules). Colleagues' addresses at these domains don't count." }, /* @__PURE__ */ React.createElement("input", { className: "dbx-input", placeholder: "example.com", value: domains, onChange: (event) => setDomains(event.target.value) })), /* @__PURE__ */ React.createElement(Field, { label: "Ids in other systems", hint: /* @__PURE__ */ React.createElement(React.Fragment, null, "A line per kind of id, like ", /* @__PURE__ */ React.createElement("code", null, "crm: 0016100000AbCdE"), " or ", /* @__PURE__ */ React.createElement("code", null, "jira_customer: Example, Example Co"), ". Sources that ask for a kind get every account's ids of it, and events that carry one of these ids find this account.") }, /* @__PURE__ */ React.createElement("textarea", { className: "dbx-textarea", rows: 3, placeholder: "crm: 0016100000AbCdE", value: ids, onChange: (event) => setIds(event.target.value) })), /* @__PURE__ */ React.createElement(Field, { label: "Agents that work on tasks", hint: "Their npubs or hex pubkeys, comma-separated. Each new task mentions them (in auto and draft mode), so they start on it in its thread, unless its workstream names its own agents below. They must be members of this channel." }, /* @__PURE__ */ React.createElement("input", { className: "dbx-input", placeholder: "npub1\u2026", value: agents, onChange: (event) => setAgents(event.target.value) })), /* @__PURE__ */ React.createElement(Field, { label: "Team preferences", hint: /* @__PURE__ */ React.createElement(React.Fragment, null, "Lines like ", /* @__PURE__ */ React.createElement("code", null, "meeting prep: auto"), " set how agents handle that workstream (or rule); ", /* @__PURE__ */ React.createElement("code", null, "everything:"), " sets the rest. Modes: ", MODES.join(", "), ". Every other line is guidance agents follow.") }, /* @__PURE__ */ React.createElement("textarea", { className: "dbx-textarea", rows: 12, value: preferences, onChange: (event) => setPreferences(event.target.value) })), /* @__PURE__ */ React.createElement(Stack, { direction: "row", gap: 6, wrap: true, align: "center" }, /* @__PURE__ */ React.createElement(Text, { size: "xs", tone: "subtle" }, "Reads as:"), Object.entries(read.modes).length ? Object.entries(read.modes).map(([key, mode]) => /* @__PURE__ */ React.createElement(Badge, { key, tone: mode === "off" ? "neutral" : mode === "auto" ? "success" : "warning" }, `${key}: ${mode}`)) : /* @__PURE__ */ React.createElement(Text, { size: "xs", tone: "subtle" }, "no modes (everything is draft)")), read.problems.map((problem) => /* @__PURE__ */ React.createElement(Text, { key: problem, size: "xs", tone: "danger" }, problem)), /* @__PURE__ */ React.createElement(Field, { label: "Workstreams", hint: "For each kind of work: the agents that work on its tasks (instead of the account's agents above, when you name any) and its playbook, how your team likes it done. An agent working on a task gets only its workstream's playbook (or its rule's, when one is named by the rule id)." }, /* @__PURE__ */ React.createElement(Playbooks, { workstreams: props.workstreams ?? account?.workstreams ?? [], value: playbooks, onChange: setPlaybooks, agents: workstreamAgents, onAgents: setWorkstreamAgents })), error && /* @__PURE__ */ React.createElement(Text, { tone: "danger", size: "sm" }, error), /* @__PURE__ */ React.createElement(Stack, { direction: "row", gap: 8 }, /* @__PURE__ */ React.createElement(Button, { variant: "brand", disabled: busy || !name.trim(), onClick: () => void save() }, busy ? /* @__PURE__ */ React.createElement(Spinner, { size: 12 }) : null, account ? "Save" : "Set up account"))));
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
  return /* @__PURE__ */ React.createElement(Stack, { gap: 12 }, [...groups].map(([group, list]) => /* @__PURE__ */ React.createElement(Stack, { key: group, gap: 4 }, /* @__PURE__ */ React.createElement(Text, { size: "sm", weight: 500 }, group), list.map((task) => /* @__PURE__ */ React.createElement(Stack, { key: task.id, direction: "row", gap: 6, align: "center", wrap: true }, /* @__PURE__ */ React.createElement(Text, { size: "sm" }, "#", task.id, " ", task.title), /* @__PURE__ */ React.createElement(Badge, null, task.status), /* @__PURE__ */ React.createElement(Badge, { tone: task.mode === "auto" ? "success" : "neutral" }, task.mode), /* @__PURE__ */ React.createElement(Text, { size: "xs", tone: "tertiary" }, ago(task.last_event_at * 1e3)))))));
}
function accountPanel(service) {
  return function AccountPanel({ channelContext }) {
    const connection = useConnection(service);
    const hubs = useAsync(async (signal) => connection.status === "connected" ? chosenHub(service, signal) : void 0, [connection.status]);
    const app = hubs.data?.app;
    const hub2 = React.useMemo(() => app ? new HubClient(service.client(), app) : void 0, [app?.name, app?.url]);
    const found = useAsync(async (signal) => hub2 && channelContext ? hub2.account({ channel: channelContext.channelId }, signal) : void 0, [hub2, channelContext?.channelId]);
    const [saved, setSaved] = React.useState();
    const [editing, setEditing] = React.useState(false);
    let body;
    if (!channelContext) body = /* @__PURE__ */ React.createElement(Notice, null, "Open this from a channel's menu.");
    else if (connection.status !== "connected") body = /* @__PURE__ */ React.createElement(Notice, { title: "Connect Databricks", action: /* @__PURE__ */ React.createElement(Button, { variant: "brand", onClick: () => service.openSettings() }, "Connect") }, "Account channels live in your team's signals hub, a Databricks App.");
    else if (hubs.loading || found.loading) body = /* @__PURE__ */ React.createElement(Spinner, { label: "Looking for this channel's account" });
    else if (hubs.error || found.error) body = /* @__PURE__ */ React.createElement(Notice, { tone: "danger" }, describeError(hubs.error ?? found.error));
    else if (!hub2) body = /* @__PURE__ */ React.createElement(Notice, { title: "No signals hub in this workspace" }, "Deploy one first (see the Signals plugin's README), then set up account channels here.");
    else {
      const account = saved ?? found.data ?? void 0;
      const channel = { id: channelContext.channelId, name: channelContext.channelName };
      body = !account || editing ? /* @__PURE__ */ React.createElement(Form, { hub: hub2, channel, ...account && { account }, onSaved: (next) => (setSaved(next), setEditing(false)) }) : /* @__PURE__ */ React.createElement(Stack, { gap: 16 }, account.warning && /* @__PURE__ */ React.createElement(Notice, { tone: "warning" }, account.warning), /* @__PURE__ */ React.createElement(Card, null, /* @__PURE__ */ React.createElement(Stack, { gap: 8 }, /* @__PURE__ */ React.createElement(Stack, { direction: "row", gap: 8, align: "center", justify: "space-between" }, /* @__PURE__ */ React.createElement(Text, { weight: 500 }, account.name), /* @__PURE__ */ React.createElement(Button, { size: "sm", onClick: () => setEditing(true) }, "Edit")), account.domains.length > 0 && /* @__PURE__ */ React.createElement(Text, { size: "sm", tone: "subtle" }, capitalized(account.labels?.customer ?? "customer"), " domains: ", account.domains.join(", ")), Object.keys(account.ids ?? {}).length > 0 && /* @__PURE__ */ React.createElement(Text, { size: "sm", tone: "subtle" }, "Ids: ", Object.entries(account.ids).map(([kind, values]) => `${kind} ${values.join(", ")}`).join(" \xB7 ")), /* @__PURE__ */ React.createElement(Text, { size: "sm", tone: "subtle" }, account.agents.length ? `${account.agents.length} agent${account.agents.length === 1 ? "" : "s"} work on new tasks` : "No agents work on new tasks yet"), /* @__PURE__ */ React.createElement(Stack, { direction: "row", gap: 6, wrap: true }, Object.entries(account.read.modes).map(([key, mode]) => /* @__PURE__ */ React.createElement(Badge, { key }, `${key}: ${mode}`))), Object.keys(account.playbooks ?? {}).length > 0 && /* @__PURE__ */ React.createElement(Text, { size: "sm", tone: "subtle" }, "Playbooks: ", Object.keys(account.playbooks).join(", ")), Object.keys(account.workstream_agents ?? {}).length > 0 && /* @__PURE__ */ React.createElement(Text, { size: "sm", tone: "subtle" }, "Own agents: ", Object.entries(account.workstream_agents).map(([name, keys]) => `${name} (${keys.length})`).join(", ")), account.updated_by && /* @__PURE__ */ React.createElement(Text, { size: "xs", tone: "tertiary" }, "Changed by ", account.updated_by, account.updated_at ? ` ${ago(account.updated_at * 1e3)}` : ""))), /* @__PURE__ */ React.createElement(Stack, { gap: 8 }, /* @__PURE__ */ React.createElement(SectionHeader, { title: "Open tasks", description: "From your team's sources, grouped by initiative and workstream. Work on them in their threads." }), /* @__PURE__ */ React.createElement(Tasks, { hub: hub2, channel: channel.id })), /* @__PURE__ */ React.createElement(Disclosure, { summary: "What agents have learned" }, account.profile ? /* @__PURE__ */ React.createElement(Text, { size: "sm", as: "div", style: { whiteSpace: "pre-wrap" } }, account.profile) : /* @__PURE__ */ React.createElement(Text, { size: "sm", tone: "subtle" }, "Nothing yet. Agents add to it as they work on this account's tasks.")));
    }
    return /* @__PURE__ */ React.createElement(DbxRoot, null, /* @__PURE__ */ React.createElement("div", { style: { padding: 16 } }, /* @__PURE__ */ React.createElement(Stack, { gap: 16 }, /* @__PURE__ */ React.createElement(SectionHeader, { title: channelContext ? `Account for #${channelContext.channelName}` : "Account", description: "Tasks for the account are posted here, and agents follow the team's preferences." }), body)));
  };
}
var ACCOUNT_INSTRUCTIONS = `Signals: when you work on a signals task, or in a channel set up as an account, first call signals_account with the channel id and the task's workstream, and follow its mode for that workstream (auto: do it and report in the task's thread; draft: prepare it for a person to send; ask: ask in the thread first), the team's guidance and the workstream's playbook. Record what you did with signals_task_update. When you learn something lasting about the customer or the team, update the profile with signals_account_learn.`;

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

// plugins/signals/src/board-view.ts
var VIEWS = ["list", "swimlanes", "filtered"];
var STATUS_GROUPS = [
  { status: "waiting", title: "Needs input" },
  { status: "open", title: "Open" },
  { status: "in_progress", title: "In progress" },
  { status: "done", title: "Done" },
  { status: "dismissed", title: "Dismissed" }
];
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
    const haystack = [`#${task.id}`, task.title, task.workstream, task.initiative, item.source?.source, item.source?.title].filter(Boolean).join(" ").toLowerCase();
    return words.every((word) => haystack.includes(word));
  });
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
function taskFacts(item) {
  const { task } = item;
  const date = (seconds) => new Date(seconds * 1e3).toISOString().slice(0, 16).replace("T", " ") + " UTC";
  return [
    { label: "Status", value: STATUS_GROUPS.find((group) => group.status === task.status)?.title ?? task.status },
    { label: "Mode", value: task.mode },
    ...task.workstream ? [{ label: "Workstream", value: task.workstream }] : [],
    ...task.initiative ? [{ label: "Initiative", value: task.initiative }] : [],
    ...task.account ? [{ label: "Account", value: task.account }] : [],
    ...item.source ? [{ label: "Source", value: item.source.title ? `${item.source.source}: ${item.source.title}` : item.source.source }] : [],
    { label: "Opened", value: date(task.created_at) },
    { label: "Last event", value: `${date(task.last_event_at)}${task.event_count > 1 ? ` (${task.event_count} events)` : ""}` }
  ];
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
var initials = (label) => label.replace(/[^\p{L}\p{N} ]/gu, "").split(/\s+/).filter(Boolean).slice(0, 2).map((word) => word[0].toUpperCase()).join("") || "?";
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
  const label = STATUS_GROUPS.find((group) => group.status === props.status)?.title ?? props.status;
  return /* @__PURE__ */ React.createElement("span", { title: label, "aria-label": label, style: { width: size, height: size, flex: "none", boxSizing: "border-box", borderRadius: 999, border: `1.5px ${props.status === "waiting" ? "dotted" : "solid"} ${color}`, background: fill, display: "inline-flex", alignItems: "center", justifyContent: "center", color: "var(--dbx-surface)", fontSize: size * 0.6, lineHeight: 1 } }, props.status === "done" ? "\u2713" : props.status === "dismissed" ? /* @__PURE__ */ React.createElement("span", { style: { color, fontSize: size * 0.7 } }, "\xD7") : null);
}
function Chip(props) {
  const color = props.tone === "brand" ? "var(--dbx-lava-text)" : props.tone === "success" ? "var(--dbx-success)" : "var(--dbx-subtle)";
  return /* @__PURE__ */ React.createElement("span", { title: props.title, style: { display: "inline-flex", alignItems: "center", padding: "0 6px", borderRadius: 4, border: "1px solid var(--dbx-border)", fontSize: "0.6875rem", lineHeight: "18px", color, whiteSpace: "nowrap", maxWidth: 160, overflow: "hidden", textOverflow: "ellipsis" } }, props.children);
}
var ASSET_ICON = { doc: "\u{1F4C4}", sheet: "\u{1F4CA}", slides: "\u{1F4FD}", form: "\u{1F4DD}", drive: "\u{1F4C1}", pr: "\u21C4", issue: "\u25CE", code: "</>", app: "\u25A3", dashboard: "\u{1F4C8}", notebook: "\u{1F4D3}", slack: "#", link: "\u{1F517}" };
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
  const closed = item.task.status === "done" || item.task.status === "dismissed";
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
  const row = (person, owner) => /* @__PURE__ */ React.createElement(Stack, { key: `${person.kind}:${person.key}`, direction: "row", gap: 8, align: "center" }, /* @__PURE__ */ React.createElement(AssigneeMark, { assignee: { kind: person.kind, key: person.key, label: person.label }, profile: props.profile }), /* @__PURE__ */ React.createElement(Text, { size: "sm", style: { flex: "1 1 auto", minWidth: 0, overflow: "hidden", textOverflow: "ellipsis" } }, nameOf(person, props.profile), !owner && /* @__PURE__ */ React.createElement("span", { style: { color: "var(--dbx-tertiary)" } }, " \xB7 ", person.role)), !closed && /* @__PURE__ */ React.createElement("button", { type: "button", className: "dbx-input", disabled: busy, title: person.kind === "agent" ? "Take it off this task: it's told in the thread to stop" : "Take them off this task", "aria-label": `Take ${nameOf(person, props.profile)} off`, onClick: () => void run({ unassign: [off(person)] }), style: { width: "auto", padding: "0 6px", lineHeight: 1.4, cursor: "pointer" } }, "\xD7"));
  return /* @__PURE__ */ React.createElement(Stack, { gap: 6 }, /* @__PURE__ */ React.createElement(Text, { size: "xs", tone: "tertiary", weight: 600 }, "OWNERS"), item.task.question && !closed && !props.compact && /* @__PURE__ */ React.createElement(Stack, { direction: "row", gap: 8, align: "center" }, /* @__PURE__ */ React.createElement(AssigneeMark, { assignee: { kind: "you" }, profile: props.profile }), /* @__PURE__ */ React.createElement(Text, { size: "sm" }, "Waiting on your input")), owners2.length ? owners2.map((person) => row(person, true)) : /* @__PURE__ */ React.createElement(Text, { size: "xs", tone: "subtle" }, "No one", helpers.length ? "; agents asked are below" : "", "."), helpers.length > 0 && helpers.map((person) => row(person, false)), !closed && !picked && /* @__PURE__ */ React.createElement("select", { className: "dbx-input", "aria-label": "Assign", disabled: busy || !choices.length, value: "", onChange: (event) => pick(event.target.value), style: { fontSize: "0.75rem" } }, /* @__PURE__ */ React.createElement("option", { value: "" }, choices.length ? "Assign to\u2026" : "No channel members to assign"), choices.map((member) => /* @__PURE__ */ React.createElement("option", { key: member.key, value: member.key }, member.agent ? "\u{1F916} " : "", member.name))), picked && /* @__PURE__ */ React.createElement(Stack, { gap: 6 }, /* @__PURE__ */ React.createElement(Text, { size: "xs" }, "Assign ", picked.name, ":"), /* @__PURE__ */ React.createElement(Stack, { direction: "row", gap: 6, wrap: true }, /* @__PURE__ */ React.createElement(Button, { size: "sm", variant: "brand", disabled: busy, title: "Take the current owners off and assign them", onClick: () => void run({ assign: [asOwner(picked)], unassign: owners2.map(off) }) }, "Reassign"), /* @__PURE__ */ React.createElement(Button, { size: "sm", disabled: busy, title: "Keep the current owners", onClick: () => void run({ assign: [asOwner(picked)] }) }, "Add"), /* @__PURE__ */ React.createElement(Button, { size: "sm", disabled: busy, onClick: () => setPicked(void 0) }, "Cancel"))), busy && /* @__PURE__ */ React.createElement(Spinner, { size: 10 }), error && /* @__PURE__ */ React.createElement(Text, { size: "xs", tone: "danger" }, error));
}
function ProvideInput(props) {
  const { task } = props.task;
  const [open, setOpen] = React.useState(false);
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
  const closed = item.task.status === "done" || item.task.status === "dismissed";
  const assets = item.artifacts.filter((artifact) => /^https?:/.test(artifact.url) && artifact.kind !== "workspace");
  return /* @__PURE__ */ React.createElement(Stack, { gap: 8, style: { paddingTop: 8 } }, item.task.question && !closed && /* @__PURE__ */ React.createElement(ProvideInput, { hub: props.hub, task: item, onDone: props.onChange }), !props.full && props.assigning && /* @__PURE__ */ React.createElement(Owners, { hub: props.hub, item, ...props.assigning, onChange: props.onChange, compact: true }), !props.full && item.source?.title && /* @__PURE__ */ React.createElement(Text, { size: "xs", tone: "subtle" }, "From ", item.source.source, ": ", item.source.url ? /* @__PURE__ */ React.createElement("a", { href: item.source.url, onClick: link(item.source.url) }, item.source.title) : item.source.title), !props.full && item.activity && /* @__PURE__ */ React.createElement(Text, { size: "xs", tone: "subtle" }, item.activity.kind === "agent_reply" ? "Agent: " : "", item.activity.text.length > 280 ? `${item.activity.text.slice(0, 279)}\u2026` : item.activity.text, " ", /* @__PURE__ */ React.createElement("span", { style: { color: "var(--dbx-tertiary)" } }, "\xB7 ", ago(item.activity.at * 1e3))), !props.full && assets.length > 0 && /* @__PURE__ */ React.createElement(Stack, { direction: "row", gap: 6, wrap: true }, assets.map((artifact) => /* @__PURE__ */ React.createElement("a", { key: `${artifact.at}:${artifact.url}`, href: artifact.url, onClick: link(artifact.url), title: artifact.url, style: { fontSize: "0.75rem" } }, ASSET_ICON[artifact.kind] ?? "\u{1F517}", " ", artifact.title ?? artifact.kind))), error && /* @__PURE__ */ React.createElement(Text, { size: "xs", tone: "danger" }, error), /* @__PURE__ */ React.createElement(Stack, { direction: "row", gap: 6, wrap: true, align: "center" }, props.open && /* @__PURE__ */ React.createElement(Button, { size: "sm", variant: "primary", title: "Its details, assets and thread", onClick: () => props.open(item) }, "Open"), /* @__PURE__ */ React.createElement(Button, { size: "sm", disabled: !item.thread, title: "Open its thread to steer the agents there", onClick: () => props.steer(item) }, "Steer"), !closed && /* @__PURE__ */ React.createElement(AddAgent, { hub: props.hub, task: item, onDone: props.onChange }), /* @__PURE__ */ React.createElement("select", { className: "dbx-input", "aria-label": "Status", disabled: busy, value: item.task.status, onChange: (event) => void setStatus(event.target.value), style: { width: "auto", fontSize: "0.75rem" } }, TASK_STATUSES.map((status2) => /* @__PURE__ */ React.createElement("option", { key: status2, value: status2 }, status2.replace("_", " ")))), !closed && /* @__PURE__ */ React.createElement(Button, { size: "sm", variant: "danger", disabled: busy, onClick: () => void setStatus("dismissed") }, "Dismiss")));
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
function Meta(props) {
  const { item } = props;
  const assets = cardAssets(item);
  return /* @__PURE__ */ React.createElement(React.Fragment, null, item.task.workstream && /* @__PURE__ */ React.createElement(Chip, null, item.task.workstream), item.task.initiative && /* @__PURE__ */ React.createElement(Chip, { tone: "brand" }, item.task.initiative), item.task.mode !== "draft" && /* @__PURE__ */ React.createElement(Chip, { tone: item.task.mode === "auto" ? "success" : void 0, title: "How agents handle it" }, item.task.mode), item.source && /* @__PURE__ */ React.createElement(Text, { size: "xs", tone: "tertiary" }, item.source.source), assets.slice(0, 3).map((artifact) => /* @__PURE__ */ React.createElement("a", { key: `${artifact.at}:${artifact.url}`, href: artifact.url, onClick: link(artifact.url), title: artifact.title ?? artifact.url, style: { fontSize: "0.75rem", textDecoration: "none" } }, ASSET_ICON[artifact.kind] ?? "\u{1F517}")), assets.length > 3 && /* @__PURE__ */ React.createElement(Text, { size: "xs", tone: "tertiary" }, "+", assets.length - 3));
}
var rowKeys = (toggle) => ({ role: "button", tabIndex: 0, onClick: toggle, onKeyDown: (event) => (event.key === "Enter" || event.key === " ") && event.target === event.currentTarget && (event.preventDefault(), toggle()) });
function TaskRow(props) {
  const { item } = props;
  const assignee = assigneeOf(item);
  return /* @__PURE__ */ React.createElement("div", { style: { borderBottom: "1px solid var(--dbx-border)", background: props.open ? "var(--dbx-inset)" : void 0 } }, /* @__PURE__ */ React.createElement("div", { ...rowKeys(props.toggle), "aria-expanded": props.open, className: "signals-row", style: { display: "flex", alignItems: "center", gap: 8, padding: "7px 12px", cursor: "pointer", minWidth: 0 } }, /* @__PURE__ */ React.createElement(Text, { size: "xs", tone: "tertiary", mono: true, style: { flex: "none", width: 34 } }, "#", item.task.id), /* @__PURE__ */ React.createElement(StatusIcon, { status: item.task.status }), /* @__PURE__ */ React.createElement(Text, { size: "sm", weight: 500, style: { flex: "1 1 auto", minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" } }, item.task.title), /* @__PURE__ */ React.createElement("span", { style: { display: "flex", gap: 6, alignItems: "center", flex: "none", maxWidth: "45%", overflow: "hidden" } }, /* @__PURE__ */ React.createElement(Meta, { item })), /* @__PURE__ */ React.createElement(Text, { size: "xs", tone: "tertiary", style: { flex: "none", width: 52, textAlign: "right" } }, ago(item.task.last_event_at * 1e3)), /* @__PURE__ */ React.createElement(AssignButton, { assignee, profile: props.profile, open: props.open, toggle: props.toggle })), props.open && /* @__PURE__ */ React.createElement("div", { style: { padding: "0 12px 10px 54px" } }, /* @__PURE__ */ React.createElement(TaskBody, { hub: props.hub, item, steer: props.steer, onChange: props.onChange, open: props.view, assigning: props.assigning })));
}
function TaskCard(props) {
  const { item } = props;
  const assignee = assigneeOf(item);
  return /* @__PURE__ */ React.createElement("div", { className: "dbx-card", style: { padding: 10, borderRadius: 8, boxShadow: props.open ? "0 1px 6px rgba(0,0,0,0.12)" : void 0 } }, /* @__PURE__ */ React.createElement("div", { ...rowKeys(props.toggle), "aria-expanded": props.open, style: { cursor: "pointer" } }, /* @__PURE__ */ React.createElement(Stack, { gap: 6 }, /* @__PURE__ */ React.createElement(Stack, { direction: "row", gap: 6, align: "center", justify: "space-between" }, /* @__PURE__ */ React.createElement(Text, { size: "xs", tone: "tertiary", mono: true }, "#", item.task.id), /* @__PURE__ */ React.createElement(Stack, { direction: "row", gap: 6, align: "center" }, /* @__PURE__ */ React.createElement(Text, { size: "xs", tone: "tertiary" }, ago(item.task.last_event_at * 1e3)), /* @__PURE__ */ React.createElement(AssignButton, { assignee, profile: props.profile, size: 18, open: props.open, toggle: props.toggle }))), /* @__PURE__ */ React.createElement(Stack, { direction: "row", gap: 6, align: "flex-start" }, /* @__PURE__ */ React.createElement("span", { style: { paddingTop: 2 } }, /* @__PURE__ */ React.createElement(StatusIcon, { status: item.task.status })), /* @__PURE__ */ React.createElement(Text, { size: "sm", weight: 500 }, item.task.title)), /* @__PURE__ */ React.createElement(Stack, { direction: "row", gap: 6, wrap: true, align: "center" }, /* @__PURE__ */ React.createElement(Meta, { item })))), props.open && /* @__PURE__ */ React.createElement(TaskBody, { hub: props.hub, item, steer: props.steer, onChange: props.onChange, open: props.view, assigning: props.assigning }));
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
function CommentItem(props) {
  const { comment } = props;
  const who = props.profile(comment.author);
  const name = who?.name ?? `${npubOf(comment.author).slice(0, 12)}\u2026`;
  const mark = who?.picture ? /* @__PURE__ */ React.createElement("img", { src: who.picture, alt: name, style: { width: 22, height: 22, borderRadius: 999, objectFit: "cover", flex: "none" } }) : /* @__PURE__ */ React.createElement("span", { style: { width: 22, height: 22, borderRadius: 999, flex: "none", display: "inline-flex", alignItems: "center", justifyContent: "center", fontSize: 9, fontWeight: 600, background: "var(--dbx-inset)", color: "var(--dbx-subtle)", border: "1px solid var(--dbx-border)" } }, initials(name));
  const raw = comment.text.length > 6e3 ? `${comment.text.slice(0, 5999)}\u2026` : comment.text;
  const text = withMentionNames(raw, npubKey, (key) => props.profile(key)?.name);
  return /* @__PURE__ */ React.createElement("div", { style: { display: "flex", gap: 10, alignItems: "flex-start", opacity: comment.pending ? 0.6 : 1 } }, mark, /* @__PURE__ */ React.createElement("div", { style: { flex: "1 1 auto", minWidth: 0 } }, /* @__PURE__ */ React.createElement(Stack, { direction: "row", gap: 6, align: "baseline" }, /* @__PURE__ */ React.createElement(Text, { size: "sm", weight: 600 }, name), /* @__PURE__ */ React.createElement(Text, { size: "xs", tone: "tertiary" }, ago(comment.at * 1e3), comment.pending ? " \xB7 sending" : ""), comment.failed && /* @__PURE__ */ React.createElement(Text, { size: "xs", tone: "danger" }, "Not sent")), /* @__PURE__ */ React.createElement("div", { style: { overflowWrap: "anywhere" } }, comment.agents ? /* @__PURE__ */ React.createElement(Disclosure, { summary: "Note between agents" }, /* @__PURE__ */ React.createElement(Markdown, { source: text, size: "sm" })) : /* @__PURE__ */ React.createElement(Markdown, { source: text, size: "sm" }))));
}
function ReplyBox(props) {
  const [text, setText] = React.useState("");
  const [error, setError] = React.useState();
  const mentions = replyMentions(props.assignee);
  const to = props.assignee.kind === "agent" ? props.profile(props.assignee.key)?.name ?? props.assignee.label : void 0;
  if (!props.send) return /* @__PURE__ */ React.createElement(Text, { size: "xs", tone: "subtle" }, "Replying needs Buzz's thread view here. ", /* @__PURE__ */ React.createElement("a", { href: "#", onClick: (event) => (event.preventDefault(), props.steer()) }, "Open the thread"), " to reply.");
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
      onKeyDown: (event) => event.key === "Enter" && (event.metaKey || event.ctrlKey) && (event.preventDefault(), send())
    }
  ), error && /* @__PURE__ */ React.createElement(Text, { size: "xs", tone: "danger" }, error), /* @__PURE__ */ React.createElement(Stack, { direction: "row", gap: 8, align: "center", justify: "space-between" }, /* @__PURE__ */ React.createElement(Text, { size: "xs", tone: "tertiary" }, to ? `Mentions ${to}, the agent it's with.` : props.assignee.kind === "you" ? "Mentions no one: it's waiting on your answer." : "Mentions no one: no agent is on it.", " \u2318\u21B5 sends."), /* @__PURE__ */ React.createElement(Button, { size: "sm", variant: "brand", disabled: !text.trim(), onClick: send }, "Reply")));
}
function TaskView(props) {
  const { item } = props;
  const assignee = assigneeOf(item);
  const thread = useThread(props.ctx, props.channel ?? item.task.channel ?? void 0, item.task.buzz_root);
  const assets = item.artifacts.filter((artifact) => /^https?:/.test(artifact.url));
  const facts = taskFacts(item);
  const authorProfile = useProfiles(props.ctx, [...new Set(thread.comments.flatMap((comment) => [comment.author, ...mentionedKeys(comment.text, npubKey)]))]);
  const who = (key) => props.profile(key) ?? authorProfile(key);
  const people = item.people.filter((person) => person.kind !== "agent" && !person.on);
  const members = useMembers(props.ctx, props.channel ?? item.task.channel ?? void 0);
  useProfiles(props.ctx, members);
  const viewer = useRelay(props.ctx).viewer;
  const end = React.useRef(null);
  const count = thread.comments.length;
  React.useEffect(() => end.current?.scrollIntoView?.({ block: "nearest" }), [count]);
  const seen = React.useRef(void 0);
  const { onChange } = props;
  React.useEffect(() => {
    if (thread.status !== "ready") return;
    if (seen.current !== void 0 && count > seen.current) onChange();
    seen.current = count;
  }, [count, thread.status]);
  return /* @__PURE__ */ React.createElement(Stack, { gap: 14 }, /* @__PURE__ */ React.createElement(Stack, { direction: "row", gap: 8, align: "center" }, /* @__PURE__ */ React.createElement(Button, { size: "sm", variant: "ghost", onClick: props.back }, "\u2190 Board"), /* @__PURE__ */ React.createElement(Text, { size: "xs", tone: "tertiary", mono: true }, "#", item.task.id)), /* @__PURE__ */ React.createElement(Stack, { direction: "row", gap: 8, align: "flex-start" }, /* @__PURE__ */ React.createElement("span", { style: { paddingTop: 4 } }, /* @__PURE__ */ React.createElement(StatusIcon, { status: item.task.status, size: 15 })), /* @__PURE__ */ React.createElement(Text, { as: "h2", size: "xl", weight: 600, style: { overflowWrap: "anywhere" } }, item.task.title)), /* @__PURE__ */ React.createElement("div", { style: { display: "flex", flexWrap: "wrap", gap: 20, alignItems: "flex-start", minWidth: 0 } }, /* @__PURE__ */ React.createElement("div", { style: { flex: "2 1 360px", minWidth: 0 } }, /* @__PURE__ */ React.createElement(Stack, { gap: 14 }, /* @__PURE__ */ React.createElement(TaskBody, { hub: props.hub, item, steer: props.steer, onChange: props.onChange, full: true }), /* @__PURE__ */ React.createElement("div", { style: { borderTop: "1px solid var(--dbx-border)", paddingTop: 12 } }, /* @__PURE__ */ React.createElement(Stack, { gap: 12 }, /* @__PURE__ */ React.createElement(Text, { size: "sm", weight: 600 }, "Activity"), !item.thread ? /* @__PURE__ */ React.createElement(Text, { size: "xs", tone: "subtle" }, "Not posted in Buzz yet.") : !thread.available ? /* @__PURE__ */ React.createElement(Text, { size: "xs", tone: "subtle" }, "The thread can't be read here. ", /* @__PURE__ */ React.createElement("a", { href: "#", onClick: (event) => (event.preventDefault(), props.steer(item)) }, "Open it in Buzz"), ".") : thread.status === "error" ? /* @__PURE__ */ React.createElement(Text, { size: "xs", tone: "danger" }, thread.error ?? "Couldn't read the thread.") : thread.status !== "ready" && !count ? /* @__PURE__ */ React.createElement(Spinner, { label: "Loading the thread" }) : /* @__PURE__ */ React.createElement(Stack, { gap: 14 }, thread.more && /* @__PURE__ */ React.createElement(Button, { size: "sm", variant: "ghost", onClick: thread.more }, "Earlier comments"), thread.reading && /* @__PURE__ */ React.createElement(Spinner, { size: 10, label: "Reading the thread" }), thread.limited && /* @__PURE__ */ React.createElement(Text, { size: "xs", tone: "subtle" }, "Only part of the thread can be read here. ", /* @__PURE__ */ React.createElement("a", { href: "#", onClick: (event) => (event.preventDefault(), props.steer(item)) }, "Open it in Buzz"), " for the rest."), thread.comments.map((comment) => /* @__PURE__ */ React.createElement(CommentItem, { key: comment.id, comment, profile: who })), /* @__PURE__ */ React.createElement("div", { ref: end })), item.thread && /* @__PURE__ */ React.createElement(ReplyBox, { assignee, profile: props.profile, ...thread.reply && { send: thread.reply }, steer: () => props.steer(item) }))))), /* @__PURE__ */ React.createElement("aside", { style: { flex: "1 1 220px", minWidth: 0, maxWidth: 340 } }, /* @__PURE__ */ React.createElement(Stack, { gap: 12 }, /* @__PURE__ */ React.createElement(Owners, { hub: props.hub, item, members, boardAgents: props.boardAgents, ...viewer && { viewer }, profile: who, onChange: props.onChange }), /* @__PURE__ */ React.createElement(Stack, { gap: 4 }, /* @__PURE__ */ React.createElement(Text, { size: "xs", tone: "tertiary", weight: 600 }, "DETAILS"), facts.map((fact) => /* @__PURE__ */ React.createElement("div", { key: fact.label, style: { display: "flex", gap: 8, fontSize: "0.75rem" } }, /* @__PURE__ */ React.createElement("span", { style: { flex: "0 0 84px", color: "var(--dbx-tertiary)" } }, fact.label), /* @__PURE__ */ React.createElement("span", { style: { minWidth: 0, overflowWrap: "anywhere", color: "var(--dbx-ink)" } }, fact.label === "Source" && item.source?.url ? /* @__PURE__ */ React.createElement("a", { href: item.source.url, onClick: link(item.source.url) }, fact.value) : fact.value)))), people.length > 0 && /* @__PURE__ */ React.createElement(Stack, { gap: 4 }, /* @__PURE__ */ React.createElement(Text, { size: "xs", tone: "tertiary", weight: 600 }, "PEOPLE"), people.map((person) => /* @__PURE__ */ React.createElement(Text, { key: `${person.kind}:${person.key}`, size: "xs" }, person.label, " ", /* @__PURE__ */ React.createElement("span", { style: { color: "var(--dbx-tertiary)" } }, "\xB7 ", person.role)))), /* @__PURE__ */ React.createElement(Stack, { gap: 4 }, /* @__PURE__ */ React.createElement(Text, { size: "xs", tone: "tertiary", weight: 600 }, "ASSETS"), !assets.length ? /* @__PURE__ */ React.createElement(Text, { size: "xs", tone: "subtle" }, "Nothing made for it yet.") : assets.map((artifact) => /* @__PURE__ */ React.createElement("a", { key: `${artifact.at}:${artifact.url}`, href: artifact.url, onClick: link(artifact.url), title: artifact.url, style: { fontSize: "0.75rem", overflowWrap: "anywhere", opacity: artifact.kind === "workspace" ? 0.65 : 1 } }, ASSET_ICON[artifact.kind] ?? "\u{1F517}", " ", artifact.title ?? artifact.url.replace(/^https?:\/\//, "").slice(0, 60), " ", /* @__PURE__ */ React.createElement("span", { style: { color: "var(--dbx-tertiary)" } }, "\xB7 ", artifact.kind))))))));
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
  return /* @__PURE__ */ React.createElement(Stack, { gap: 6 }, /* @__PURE__ */ React.createElement(Text, { size: "xs", tone: "tertiary" }, "Events from the last two weeks that a rule's classifier kept from opening a task here. If one should have been a task, loosen the rule's question or lower its ", /* @__PURE__ */ React.createElement("code", null, "min"), "."), /* @__PURE__ */ React.createElement("div", { style: { border: "1px solid var(--dbx-border)", borderRadius: 8, overflow: "hidden", minWidth: 0 } }, shown.map((event, n) => /* @__PURE__ */ React.createElement("div", { key: event.id, style: { padding: "8px 12px", borderTop: n ? "1px solid var(--dbx-border)" : void 0, minWidth: 0 } }, /* @__PURE__ */ React.createElement(Stack, { gap: 2 }, /* @__PURE__ */ React.createElement(Stack, { direction: "row", gap: 8, align: "center", wrap: true }, /* @__PURE__ */ React.createElement("span", { style: { fontSize: "0.8125rem", fontWeight: 500, minWidth: 0, flex: "1 1 200px", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }, title: event.title }, event.url ? /* @__PURE__ */ React.createElement("a", { href: event.url, onClick: (click) => (click.preventDefault(), openExternal(event.url)) }, event.title || event.external_id) : event.title || event.external_id), /* @__PURE__ */ React.createElement(Text, { size: "xs", tone: "tertiary" }, event.source, " \xB7 ", ago(event.filtered_at * 1e3))), event.actor && /* @__PURE__ */ React.createElement(Text, { size: "xs", tone: "subtle" }, event.actor), /* @__PURE__ */ React.createElement(Text, { size: "xs", tone: "tertiary" }, filteredWhy(event)))))));
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
var POLLER = '"""Signals poller: reads one person\'s sources and posts what it finds to the signals hub.\n\nRuns as a scheduled serverless Databricks job owned by that person, so it reads\ntheir sources as them: the Unity Catalog MCP services (system.ai.gmail,\ngoogle_calendar, slack, ...) with their own sign-ins, and tables with their own\ngrants. It keeps no state: the hub says which sources the person turned on and\nwhere each one stopped (its cursor).\n\n    python poller.py --config sources.json [--hub https://<app-url> | --lakebase] [--warehouse <id>] [--dry-run]\n\nHow it reaches the hub:\n\n- `--hub` calls the hub app\'s API. Databricks Apps only take OAuth tokens, so\n  this works from a laptop (`databricks auth login`) but not from a job, whose\n  token isn\'t one.\n- `--lakebase` (for jobs) writes to the hub\'s inbox table in Lakebase instead,\n  logged in as the job\'s owner\'s own Postgres role (a token from\n  /api/2.0/postgres/credentials). Row-level security lets each person write\n  only rows the hub reads as theirs, and read only their own sources. The hub\n  drains the inbox every half minute. Config: `"lakebase": {"endpoint":\n  "projects/<p>/branches/<b>/endpoints/<e>", "host": "<endpoint host>",\n  "database": "databricks_postgres", "schema": "signals_<app name>"}`. It\n  needs `psycopg[binary]` and a Postgres role for the person in the database.\n\n- `hub_auth` in the config (with `--hub`) signs hub calls in with another\n  profile than the default client\'s, for sources in another workspace than\n  the hub\'s: `{"profile": "<name>"}`, a profile in ~/.databrickscfg for the\n  hub\'s workspace. SQL and MCP calls stay on the default client\n  (DATABRICKS_CONFIG_PROFILE picks its profile).\n\nThe config lists sources (see sources.example.json):\n\n- kind "mcp": a tool of a system.ai MCP service. `args` and `map` are templates:\n  "{since}" (the cursor, or `lookback_hours` ago, ISO 8601), "{now}", "{now+7d}",\n  "{since_epoch}", and "{field}" for a field of the item being mapped.\n  `items` is the path to the list in the tool\'s JSON result.\n  `detail` (optional) fetches each item\'s full record with another tool of the\n  same service and merges it into the item before mapping, for list tools that\n  leave fields out (calendar_event_list has no attendees or description):\n  {"tool": "calendar_event_get", "args": {"event_id": "{id}"}, "max": 50}.\n  A detail call that fails leaves the item as the list gave it.\n  `sections` (optional) is for tools that answer with Markdown instead of a JSON\n  list (Slack search): {"split": "^### Result \\\\d+ of \\\\d+$"} cuts the text at\n  `items` into one item per section, and each "Key: value" line starts a field\n  (`key` lowercased, spaces as _) that runs until the next one. `keys` (optional)\n  lists the only keys that start a field, so a "Note: ..." line inside a\n  message\'s text stays in the text.\n- kind "table": a SQL query with :since (the watermark) as a parameter.\n  `table` is checked first; a table that isn\'t there (or can\'t be read) makes\n  the source "unavailable" and it is skipped. The cursor is the largest\n  `watermark` column seen.\n\nAccount ids: a source that covers every account names the kinds of account ids\nit uses, `"ids": ["crm"]`, and gets every account\'s ids of each kind (set in\nthe account panel, or `ids` in the hub\'s config accounts; the hub serves them\nat GET /api/ids, and in Lakebase as the account_ids table):\n\n- a table source\'s query has `:crm`, which becomes bound parameters\n  (`:crm_0, :crm_1, ...`), as in `WHERE account_id IN (:crm)`; the ids are\n  never pasted into the SQL.\n- an mcp source\'s args have `{crm: <clause with {}>}`, which becomes the clause\n  once per id joined by OR, with `\\\\` and `"` in the id escaped:\n  `({jira_customer: cf[10001] ~ "{}"})` -> `(cf[10001] ~ "Acme" OR cf[10001] ~ "Acme Co")`.\n\nWhen no account has ids of a kind the source uses, it is skipped (reported as\nunavailable, with why).\n\n`map` turns an item into an event: external_id, title, url, actor, account,\ngroup_key, occurred_at, and payload (a list of fields, "*" for the whole item,\nor an object of specs). A spec is a path ("fields.summary"), a template\n("{key}: {fields.summary}"), or {"from": <spec>, "match": <regex>}, which takes\nthe regex\'s first group (case-insensitive) and is left out without a match:\n{"from": "title", "match": "workspace (\\\\d+)"}.\n"""\n\nfrom __future__ import annotations\n\nimport argparse\nimport datetime as dt\nimport json\nimport re\nimport sys\nimport time\nfrom typing import Any, Callable, Iterable\n\nPROTOCOL = "2025-06-18"\nNOT_SIGNED_IN = -32006\nBATCH = 200\n\n# ---------------------------------------------------------------------------\n# Templates and mapping (pure; tested without a workspace)\n\n\ndef iso(t: dt.datetime) -> str:\n    return t.astimezone(dt.timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")\n\n\ndef parse_time(value: str | None) -> dt.datetime | None:\n    if not value:\n        return None\n    try:\n        if re.fullmatch(r"\\d+(\\.\\d+)?", value):\n            return dt.datetime.fromtimestamp(float(value), dt.timezone.utc)\n        return dt.datetime.fromisoformat(value.replace("Z", "+00:00"))\n    except ValueError:\n        return None\n\n\ndef get_path(item: Any, path: str) -> Any:\n    """`a.b.0.c` into dicts and lists."""\n    value = item\n    for part in path.split(".") if path else []:\n        if isinstance(value, dict):\n            value = value.get(part)\n        elif isinstance(value, list) and part.isdigit() and int(part) < len(value):\n            value = value[int(part)]\n        else:\n            return None\n    return value\n\n\n_OFFSET = re.compile(r"^now([+-])(\\d+)([mhd])$")\n\n\ndef fill(template: Any, item: Any, clock: dict[str, dt.datetime]) -> Any:\n    """Fills {since}, {now}, {now+7d}, {since_epoch} and {item.field} in strings (recursively in lists and dicts)."""\n    if isinstance(template, dict):\n        return {key: fill(value, item, clock) for key, value in template.items()}\n    if isinstance(template, list):\n        return [fill(value, item, clock) for value in template]\n    if not isinstance(template, str):\n        return template\n\n    def one(name: str) -> Any:\n        if name == "now":\n            return iso(clock["now"])\n        if name == "since":\n            return iso(clock["since"])\n        if name == "since_epoch":\n            return int(clock["since"].timestamp())\n        if name == "since_date":\n            return clock["since"].date().isoformat()\n        offset = _OFFSET.match(name)\n        if offset:\n            sign, amount, unit = offset.groups()\n            unit_name = {"m": "minutes", "h": "hours", "d": "days"}[unit]\n            delta = dt.timedelta(**{unit_name: int(amount)})\n            return iso(clock["now"] + delta if sign == "+" else clock["now"] - delta)\n        return get_path(item, name)\n\n    whole = re.fullmatch(r"\\{([A-Za-z0-9_.+-]+)\\}", template)\n    if whole:  # keep the value\'s type ({since_epoch} stays a number)\n        return one(whole.group(1))\n    return re.sub(r"\\{([A-Za-z0-9_.+-]+)\\}", lambda m: "" if one(m.group(1)) is None else str(one(m.group(1))), template)\n\n\ndef extract(found: Any, pattern: str) -> Any:\n    """The first capture group of `pattern` in `found` (or the whole match), case-insensitive; None without a match."""\n    if found in (None, ""):\n        return None\n    match = re.search(pattern, found if isinstance(found, str) else json.dumps(found, default=str), re.I)\n    if not match:\n        return None\n    groups = [group for group in match.groups() if group is not None]\n    return (groups[0] if groups else match.group(0)).strip()\n\n\n_FIELD = re.compile(r"^([A-Z][A-Za-z_ ]{0,30}):[ \\t]?(.*)$")\n\n\ndef sections(text: Any, split: str, keys: Iterable[str] | None = None) -> list[dict]:\n    """Markdown results as items: the text cut at `split` (a regex for a line), each "Key: value" line a field (only `keys`, when given)."""\n    allowed = {key.lower() for key in keys} if keys else None\n    if not isinstance(text, str):\n        return []\n    items = []\n    for part in re.split(f"(?m){split}", text)[1:]:\n        item: dict[str, str] = {}\n        key = None\n        for line in part.strip("\\n").splitlines():\n            if line.strip() == "---":\n                continue\n            found = _FIELD.match(line)\n            if found and allowed is not None and found.group(1).strip().lower() not in allowed:\n                found = None\n            if found:\n                key = found.group(1).strip().lower().replace(" ", "_")\n                item[key] = found.group(2).strip()\n            elif key:\n                item[key] = (item[key] + "\\n" + line.rstrip()).strip("\\n")\n        if item:\n            items.append({k: v.strip() for k, v in item.items()})\n    return items\n\n\ndef to_event(source: str, item: dict, mapping: dict, clock: dict[str, dt.datetime]) -> dict | None:\n    """An item as a hub event, or None without an external_id."""\n\n    def value(spec: Any) -> Any:\n        if isinstance(spec, dict) and "match" in spec:\n            return extract(value(spec.get("from", "")), spec["match"])\n        if isinstance(spec, str) and "{" not in spec:\n            return get_path(item, spec)  # a plain path\n        return fill(spec, item, clock)\n\n    external = value(mapping.get("external_id", "id"))\n    if external in (None, ""):\n        return None\n    event: dict[str, Any] = {"source": source, "external_id": str(external)}\n    for key in ("title", "url", "actor", "account", "group_key", "occurred_at"):\n        if key in mapping:\n            found = value(mapping[key])\n            if found not in (None, ""):\n                event[key] = found if key == "occurred_at" and isinstance(found, (int, float)) else str(found)\n    payload = mapping.get("payload")\n    if payload == "*":\n        event["payload"] = item\n    elif isinstance(payload, list):\n        event["payload"] = {name: get_path(item, name) for name in payload}\n    elif isinstance(payload, dict):\n        event["payload"] = {name: value(spec) for name, spec in payload.items()}\n    return json.loads(json.dumps(event, default=str))\n\n\ndef tool_json(result: dict) -> Any:\n    """A tool result\'s JSON: structuredContent, or the first JSON text block."""\n    if result.get("structuredContent") is not None:\n        return result["structuredContent"]\n    for block in result.get("content") or []:\n        text = (block.get("text") or "").strip() if block.get("type") == "text" else ""\n        if text[:1] in "{[":\n            try:\n                return json.loads(text)\n            except ValueError:\n                continue\n    return None\n\n\n# ---------------------------------------------------------------------------\n# Workspace access\n\n\nclass NotSignedIn(Exception):\n    pass\n\n\nclass Unavailable(Exception):\n    pass\n\n\n# ---------------------------------------------------------------------------\n# Account ids in queries\n\n\ndef needed_ids(source: dict, ids: dict[str, list[str]]) -> dict[str, list[str]]:\n    """The ids of each kind the source uses; Unavailable when an account has none of a kind."""\n    kinds = source.get("ids") or []\n    if isinstance(kinds, str):\n        kinds = [kinds]\n    missing = [kind for kind in kinds if not ids.get(kind)]\n    if missing:\n        raise Unavailable(f"no account has {\', \'.join(missing)} ids yet (add them in the account panel, as `{missing[0]}: ...`)")\n    return {kind: list(ids[kind]) for kind in kinds}\n\n\ndef bind_ids(query: str, ids: dict[str, list[str]]) -> tuple[str, dict[str, str]]:\n    """The query with each `:kind` as one bound parameter per id (`:kind_0, :kind_1`), and those parameters."""\n    parameters: dict[str, str] = {}\n    for kind, values in ids.items():\n        names = [f"{kind}_{n}" for n in range(len(values))]\n        parameters.update(zip(names, values))\n        # `:kind` as a whole name, not part of `::cast` or a longer name.\n        query = re.sub(rf"(?<![:\\w]):{re.escape(kind)}(?!\\w)", ", ".join(f":{name}" for name in names), query)\n    return query, parameters\n\n\ndef quoted(value: str) -> str:\n    """A value for inside a double-quoted string (JQL\'s): backslashes and quotes escaped."""\n    return value.replace("\\\\", "\\\\\\\\").replace(\'"\', \'\\\\"\')\n\n\ndef clause_ids(template: Any, ids: dict[str, list[str]]) -> Any:\n    """`{kind: <clause with {}>}` in strings (recursively) as the clause once per id, joined by OR."""\n    if isinstance(template, dict):\n        return {key: clause_ids(value, ids) for key, value in template.items()}\n    if isinstance(template, list):\n        return [clause_ids(value, ids) for value in template]\n    if not isinstance(template, str) or not ids:\n        return template\n\n    def one(match: re.Match) -> str:\n        kind, clause = match.group(1), match.group(2)\n        if kind not in ids:\n            return match.group(0)\n        return " OR ".join(clause.replace("{}", quoted(value)) for value in ids[kind])\n\n    return re.sub(r"\\{([a-z][a-z0-9_]*):\\s?((?:[^{}]|\\{\\})*)\\}", one, template)\n\n\ndef check_hub_auth(settings: Any) -> str | None:\n    """What\'s wrong with a config\'s `hub_auth`, or None. It\'s {"profile": "<name>"}."""\n    if not isinstance(settings, dict) or set(settings) != {"profile"}:\n        return \'hub_auth is {"profile": "<name>"}, a profile in ~/.databrickscfg for the hub\\\'s workspace\'\n    if not isinstance(settings["profile"], str) or not settings["profile"]:\n        return "hub_auth.profile is a profile name from ~/.databrickscfg"\n    return None\n\n\ndef hub_client(settings: dict, make: Callable[..., Any] | None = None) -> Any:\n    """The client for hub calls that `hub_auth` describes."""\n    problem = check_hub_auth(settings)\n    if problem:\n        raise SystemExit(problem)\n    if make is None:\n        from databricks.sdk import WorkspaceClient as make\n    try:\n        return make(profile=settings["profile"])\n    except Exception as error:\n        raise RuntimeError(f"hub_auth: couldn\'t sign in with profile {settings[\'profile\']!r}: {error}") from None\n\n\nclass Workspace:\n    """Calls as the job\'s owner, through the Databricks SDK\'s auth. `hub_auth` (optional) signs hub calls in as someone else."""\n\n    def __init__(self, client=None, hub_auth: dict | None = None, make_client: Callable[..., Any] | None = None):\n        if client is None:\n            from databricks.sdk import WorkspaceClient\n\n            client = WorkspaceClient()\n        self.client = client\n        self.host = client.config.host.rstrip("/")\n        self.hub_auth = hub_auth\n        self.make_client = make_client\n        self.hub_as: Any = None\n        import requests\n\n        self.http = requests.Session()\n\n    def headers(self) -> dict:\n        return {**self.client.config.authenticate(), "Content-Type": "application/json"}\n\n    def hub_headers(self) -> dict:\n        """Headers for a hub call: the default client\'s, or `hub_auth`\'s client\'s (made on the first call)."""\n        if self.hub_auth is None:\n            return self.headers()\n        if self.hub_as is None:\n            self.hub_as = hub_client(self.hub_auth, self.make_client)\n        return {**self.hub_as.config.authenticate(), "Content-Type": "application/json"}\n\n    def mcp(self, service: str, tool: str, args: dict) -> Any:\n        url = f"{self.host}/ai-gateway/mcp-services/system.ai.{service}"\n        headers = {**self.headers(), "Accept": "application/json, text/event-stream"}\n\n        def post(message: dict, initializing=False) -> dict:\n            h = dict(headers)\n            if not initializing:\n                h["MCP-Protocol-Version"] = PROTOCOL\n            response = self.http.post(url, headers=h, json=message, timeout=120)\n            if response.headers.get("mcp-session-id"):\n                headers["Mcp-Session-Id"] = response.headers["mcp-session-id"]\n            if response.status_code == 401:\n                raise NotSignedIn(f"system.ai.{service} rejected the call (HTTP 401)")\n            response.raise_for_status()\n            text = response.text\n            if "text/event-stream" in response.headers.get("content-type", ""):\n                text = "\\n".join(line[5:].strip() for line in text.splitlines() if line.startswith("data:"))\n            reply = json.loads(text) if text.strip() else {}\n            error = reply.get("error")\n            if error:\n                # Not signed in comes back as HTTP 200 with a JSON-RPC error.\n                if error.get("code") == NOT_SIGNED_IN or re.search(r"401|not logged in|login first|Credential for user", error.get("message", ""), re.I):\n                    raise NotSignedIn(f"Sign in to system.ai.{service}: {self.host}/explore/mcp-services/system/ai/{service}")\n                raise RuntimeError(f"system.ai.{service} {tool}: {error.get(\'message\')}")\n            return reply.get("result") or {}\n\n        post({"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {"protocolVersion": PROTOCOL, "capabilities": {}, "clientInfo": {"name": "signals-poller", "version": "1"}}}, True)\n        self.http.post(url, headers={**headers, "MCP-Protocol-Version": PROTOCOL}, json={"jsonrpc": "2.0", "method": "notifications/initialized"}, timeout=30)\n        result = post({"jsonrpc": "2.0", "id": 2, "method": "tools/call", "params": {"name": tool, "arguments": args}})\n        if result.get("isError"):\n            text = " ".join(block.get("text", "") for block in result.get("content") or [])\n            raise RuntimeError(f"system.ai.{service} {tool}: {text[:500]}")\n        return tool_json(result)\n\n    def table_exists(self, name: str) -> bool:\n        try:\n            return bool(self.client.tables.exists(full_name=name).table_exists)\n        except Exception:  # no access looks the same as not there\n            return False\n\n    def sql(self, warehouse: str, statement: str, parameters: dict) -> list[dict]:\n        from databricks.sdk.service.sql import StatementParameterListItem, StatementState\n\n        response = self.client.statement_execution.execute_statement(\n            warehouse_id=warehouse,\n            statement=statement,\n            parameters=[StatementParameterListItem(name=k, value=None if v is None else str(v)) for k, v in parameters.items()],\n            wait_timeout="50s",\n        )\n        while response.status.state in (StatementState.PENDING, StatementState.RUNNING):\n            time.sleep(2)\n            response = self.client.statement_execution.get_statement(response.statement_id)\n        if response.status.state != StatementState.SUCCEEDED:\n            raise RuntimeError(response.status.error.message if response.status.error else str(response.status.state))\n        columns = [column.name for column in response.manifest.schema.columns]\n        rows = [dict(zip(columns, row)) for row in (response.result.data_array or [])]\n        chunk = response.result.next_chunk_index\n        while chunk is not None:\n            part = self.client.statement_execution.get_statement_result_chunk_n(response.statement_id, chunk)\n            rows.extend(dict(zip(columns, row)) for row in (part.data_array or []))\n            chunk = part.next_chunk_index\n        return rows\n\n    def hub(self, base: str, method: str, path: str, body: Any = None) -> Any:\n        response = self.http.request(method, f"{base.rstrip(\'/\')}{path}", headers=self.hub_headers(), json=body, timeout=120)\n        if response.status_code >= 400:\n            raise RuntimeError(f"hub {path}: HTTP {response.status_code} {response.text[:300]}")\n        return response.json()\n\n\nclass LakebaseInbox:\n    """The hub\'s API, as far as a poller needs it, through the inbox table in Lakebase."""\n\n    def __init__(self, ws: Workspace, settings: dict, connect: Callable[[], Any] | None = None):\n        missing = [key for key in ("endpoint", "host", "schema") if not settings.get(key)]\n        if missing and connect is None:\n            raise SystemExit("--lakebase needs " + ", ".join(f"lakebase.{key}" for key in missing) + " in the config")\n        if not re.fullmatch(r"[a-z_][a-z0-9_]{0,62}", settings.get("schema", "")):\n            raise SystemExit(f"lakebase.schema {settings.get(\'schema\')!r} isn\'t a schema name")\n        self.schema = settings["schema"]\n        if connect is None:\n            import psycopg\n\n            user = ws.client.current_user.me().user_name\n            token = ws.client.api_client.do("POST", "/api/2.0/postgres/credentials", body={"endpoint": settings["endpoint"]})["token"]\n            self.db = psycopg.connect(host=settings["host"], port=int(settings.get("port", 5432)), dbname=settings.get("database", "databricks_postgres"), user=user, password=token, sslmode="require", autocommit=True)\n        else:\n            self.db = connect()\n\n    def call(self, method: str, path: str, body: Any = None) -> Any:\n        with self.db.cursor() as cursor:\n            if (method, path) == ("GET", "/api/ids"):\n                cursor.execute(f"SELECT kind, id FROM {self.schema}.account_ids ORDER BY kind, id")\n                ids: dict[str, list[str]] = {}\n                for kind, value in cursor.fetchall():\n                    ids.setdefault(kind, []).append(value)\n                return {"ids": ids}\n            if (method, path) == ("GET", "/api/sources"):\n                # Row-level security returns only this person\'s sources.\n                cursor.execute(f"SELECT source, enabled, cursor FROM {self.schema}.sources")\n                return {"sources": [{"source": row[0], "enabled": row[1], "cursor": row[2]} for row in cursor.fetchall()]}\n            if method == "POST" and path in ("/api/events", "/api/cursor"):\n                cursor.execute(f"INSERT INTO {self.schema}.inbox (kind, body) VALUES (%s, %s)", ("events" if path == "/api/events" else "cursor", json.dumps(body, default=str)))\n                return {"queued": True}\n        raise RuntimeError(f"the inbox can\'t take {method} {path}")\n\n\n# ---------------------------------------------------------------------------\n# Polling\n\n\ndef with_detail(ws: Workspace, service: str, detail: dict, item: dict, clock: dict[str, dt.datetime]) -> dict:\n    """The item with its full record (from `detail`\'s tool) merged in; the item as it was when that fails."""\n    try:\n        found = ws.mcp(service, detail["tool"], fill(detail.get("args", {}), item, clock))\n    except NotSignedIn:\n        raise\n    except Exception:\n        return item\n    return {**item, **found} if isinstance(found, dict) else item\n\n\ndef poll_source(ws: Workspace, source: dict, cursor: str | None, warehouse: str | None, now: dt.datetime, ids: dict[str, list[str]] | None = None) -> tuple[list[dict], str]:\n    """One source\'s events since its cursor, and its next cursor. `ids`: every account\'s ids, by kind."""\n    lookback = dt.timedelta(hours=float(source.get("lookback_hours", 24)))\n    name = source["name"]\n    used = needed_ids(source, ids or {})\n    if source["kind"] == "mcp":\n        since = parse_time(cursor) or now - lookback\n        # Look back a little past the cursor: the hub dedupes, and sources index late.\n        since = min(since, now) - dt.timedelta(minutes=float(source.get("overlap_minutes", 10)))\n        clock = {"now": now, "since": since}\n        data = ws.mcp(source.get("service", name), source["tool"], clause_ids(fill(source.get("args", {}), None, clock), used))\n        items = get_path(data, source.get("items", "items")) if source.get("items", "items") else data\n        if source.get("sections"):\n            items = sections(items, source["sections"].get("split", r"^#+ .*$"), source["sections"].get("keys"))\n        items = [item for item in items or [] if isinstance(item, dict)]\n        detail = source.get("detail")\n        if detail:\n            items = [with_detail(ws, source.get("service", name), detail, item, clock) if i < int(detail.get("max", 50)) else item for i, item in enumerate(items)]\n        events = [e for e in (to_event(name, item, source.get("map", {}), clock) for item in items) if e]\n        return events, iso(now)\n    if source["kind"] == "table":\n        if not warehouse:\n            raise Unavailable("a table source needs --warehouse")\n        if source.get("table") and not ws.table_exists(source["table"]):\n            raise Unavailable(f"{source[\'table\']} isn\'t there or you can\'t read it")\n        since = cursor or source.get("start", "1970-01-01T00:00:00Z")\n        query, bound = bind_ids(source["query"], used)\n        rows = ws.sql(warehouse, query, {"since": since, **bound})\n        clock = {"now": now, "since": parse_time(since) or now - lookback}\n        events = [e for e in (to_event(name, row, source.get("map", {}), clock) for row in rows) if e]\n        watermark = source.get("watermark")\n        marks = [str(row[watermark]) for row in rows if watermark and row.get(watermark) is not None]\n        return events, max(marks + [since])\n    raise Unavailable(f"unknown kind {source[\'kind\']}")\n\n\ndef run(ws: Workspace, config: dict, hub: str | None, warehouse: str | None, dry_run=False, log: Callable[[str], None] = print, now: dt.datetime | None = None, inbox: LakebaseInbox | None = None) -> dict:\n    """Polls the sources that are on. Reaches the hub at its URL, or through `inbox`."""\n    now = now or dt.datetime.now(dt.timezone.utc)\n    hub = hub or config.get("hub")\n    if not dry_run and not hub and not inbox:\n        raise SystemExit("Say where the hub is: --hub <app url> (or `hub` in the config), or --lakebase")\n\n    def call(method: str, path: str, body: Any = None) -> Any:\n        return inbox.call(method, path, body) if inbox else ws.hub(hub, method, path, body)\n\n    state = {} if dry_run else {s["source"]: s for s in call("GET", "/api/sources")["sources"]}\n    summary: dict[str, Any] = {}\n    ids: dict[str, list[str]] = {}\n    ids_error = ""\n    wanted = [s for s in config.get("sources", []) if s.get("ids") and (dry_run or (state.get(s["name"]) or {}).get("enabled"))]\n    if wanted and (hub or inbox):\n        try:\n            ids = call("GET", "/api/ids").get("ids") or {}\n        except Exception as error:  # the sources that need ids are skipped, saying why\n            ids_error = f"couldn\'t read account ids: {error}"[:600]\n            log(ids_error)\n    for source in config.get("sources", []):\n        name = source["name"]\n        known = state.get(name)\n        if not dry_run and not (known and known.get("enabled")):\n            summary[name] = "off"\n            continue\n        try:\n            if ids_error and source.get("ids"):\n                raise Unavailable(ids_error)\n            events, cursor = poll_source(ws, source, known.get("cursor") if known else None, warehouse or config.get("warehouse"), now, ids)\n        except (NotSignedIn, Unavailable) as error:\n            summary[name] = f"unavailable: {error}"\n            log(f"{name}: {summary[name]}")\n            if not dry_run:\n                call("POST", "/api/cursor", {"source": name, "error": str(error)})\n            continue\n        except Exception as error:  # one source failing doesn\'t stop the others\n            summary[name] = f"failed: {error}"\n            log(f"{name}: {summary[name]}")\n            if not dry_run:\n                call("POST", "/api/cursor", {"source": name, "error": f"failed: {error}"[:900]})\n            continue\n        if dry_run:\n            summary[name] = {"events": len(events), "sample": events[:3], "cursor": cursor}\n            continue\n        totals = {"queued": 0} if inbox else {"new": 0, "changed": 0, "same": 0, "created": 0}\n        for start in range(0, len(events), BATCH):\n            reply = call("POST", "/api/events", {"events": events[start : start + BATCH]})\n            if inbox:  # the hub handles it within a minute\n                totals["queued"] += len(events[start : start + BATCH])\n                continue\n            for key in ("new", "changed", "same"):\n                totals[key] += reply.get(key, 0)\n            totals["created"] += len(reply.get("created", []))\n        # The cursor moves only once the hub has the events (the inbox keeps them in order).\n        call("POST", "/api/cursor", {"source": name, "cursor": cursor, "error": ""})\n        summary[name] = {"events": len(events), **totals}\n        log(f"{name}: {summary[name]}")\n    return summary\n\n\ndef main(argv: Iterable[str] | None = None) -> int:\n    parser = argparse.ArgumentParser(description=__doc__.split("\\n")[0])\n    parser.add_argument("--config", required=True, help="sources JSON (a workspace file or volume path)")\n    parser.add_argument("--hub", help="the hub app\'s URL (or `hub` in the config)")\n    parser.add_argument("--lakebase", action="store_true", help="reach the hub through its inbox in Lakebase (for jobs; see `lakebase` in the config)")\n    parser.add_argument("--warehouse", help="SQL warehouse id, for table sources")\n    parser.add_argument("--dry-run", action="store_true", help="poll every source and print, without the hub")\n    args = parser.parse_args(list(argv) if argv is not None else None)\n    with open(args.config) as file:\n        config = json.load(file)\n    hub_auth = config.get("hub_auth")\n    if hub_auth is not None:\n        problem = check_hub_auth(hub_auth)\n        if problem:\n            raise SystemExit(problem)\n        if args.lakebase:\n            raise SystemExit("hub_auth is for calling the hub app (--hub <app url>, or `hub` in the config); --lakebase writes to the hub\'s inbox as the job\'s owner and can\'t use it. Use --hub instead.")\n    ws = Workspace(hub_auth=hub_auth)\n    inbox = LakebaseInbox(ws, config.get("lakebase") or {}) if args.lakebase and not args.dry_run else None\n    summary = run(ws, config, args.hub, args.warehouse, args.dry_run, inbox=inbox)\n    print(json.dumps(summary, indent=2, default=str))\n    return 0\n\n\nif __name__ == "__main__":\n    # Only exit on failure: a Databricks job counts any SystemExit, even 0, as a failed task.\n    code = main()\n    if code:\n        sys.exit(code)\n';
var EXAMPLE_SOURCES = '{\n  "hub": "https://<your-signals-hub-app-url>",\n  "sources": [\n    {\n      "name": "google_calendar",\n      "kind": "mcp",\n      "tool": "calendar_event_list",\n      "args": { "time_min": "{now}", "time_max": "{now+7d}", "max_results": 50, "query": "" },\n      "items": "items",\n      "detail": { "tool": "calendar_event_get", "args": { "event_id": "{id}" }, "max": 50 },\n      "map": {\n        "external_id": "id",\n        "title": "summary",\n        "url": "htmlLink",\n        "occurred_at": "{start.dateTime}{start.date}",\n        "payload": ["start", "end", "status", "attendeeCount", "attendees", "organizer", "description", "location", "hangoutLink", "recurringEventId"]\n      }\n    },\n    {\n      "name": "gmail",\n      "kind": "mcp",\n      "tool": "gmail_search",\n      "args": { "query": "in:inbox after:{since_epoch}", "max_results": 50 },\n      "items": "items",\n      "lookback_hours": 24,\n      "map": {\n        "external_id": "id",\n        "title": "subject",\n        "actor": "from",\n        "group_key": "threadId",\n        "url": "https://mail.google.com/mail/u/0/#all/{threadId}",\n        "occurred_at": "date",\n        "payload": ["from", "to", "snippet", "labelIds"]\n      }\n    },\n    {\n      "name": "google_drive",\n      "kind": "mcp",\n      "tool": "google_drive_list_recent",\n      "args": { "days": 1, "max_results": 50 },\n      "items": "items",\n      "map": {\n        "external_id": "{id}:{modifiedTime}",\n        "group_key": "id",\n        "title": "name",\n        "url": "webViewLink",\n        "occurred_at": "modifiedTime",\n        "payload": ["mimeType", "modifiedTime"]\n      }\n    },\n    {\n      "name": "slack",\n      "kind": "mcp",\n      "tool": "slack_search_public_and_private",\n      "args": { "keywords": ["<@YOUR_SLACK_USER_ID>"], "filters": "", "natural_language_query": "", "after": "{since_epoch}", "limit": 20, "include_bots": false },\n      "items": "results",\n      "sections": {\n        "split": "^### Result \\\\d+ of \\\\d+\\\\s*$",\n        "keys": ["Channel", "Participants", "From", "Time", "Message_ts", "Reply count", "Permalink", "Text", "Context before", "Context after"]\n      },\n      "lookback_hours": 24,\n      "map": {\n        "external_id": { "from": "permalink", "match": "\\\\((https://[^)?]+)" },\n        "url": { "from": "permalink", "match": "\\\\((https://[^)]+)\\\\)" },\n        "group_key": { "from": "permalink", "match": "thread_ts=(\\\\d{10})|/p(\\\\d{10})" },\n        "title": { "from": "text", "match": "^\\\\s*([^\\\\n]{1,140})" },\n        "actor": { "from": "from", "match": "<([^>\\\\s]+@[^>\\\\s]+)>" },\n        "occurred_at": "message_ts",\n        "payload": {\n          "channel": { "from": "channel", "match": "^(.*?)\\\\s*\\\\(ID:" },\n          "channel_id": { "from": "channel", "match": "\\\\(ID: ([A-Z0-9]+)\\\\)" },\n          "from": { "from": "from", "match": "^(.*?)\\\\s*\\\\(ID:" },\n          "text": "text",\n          "context_before": "context_before"\n        }\n      }\n    },\n    {\n      "name": "jira",\n      "kind": "mcp",\n      "service": "atlassian",\n      "tool": "searchJiraIssuesUsingJql",\n      "args": { "jql": "(assignee = currentUser() OR reporter = currentUser() OR watcher = currentUser()) AND updated >= \\"{since_date}\\" ORDER BY updated DESC", "maxResults": 50, "fields": ["summary", "status", "updated", "priority", "assignee"] },\n      "items": "issues",\n      "lookback_hours": 48,\n      "map": {\n        "external_id": "key",\n        "group_key": "key",\n        "title": "{key} {fields.summary}",\n        "occurred_at": "fields.updated",\n        "payload": { "status": "{fields.status.name}", "status_category": "{fields.status.statusCategory.name}", "priority": "{fields.priority.name}", "assignee": "{fields.assignee.displayName}" }\n      }\n    },\n    {\n      "name": "jira_customers",\n      "kind": "mcp",\n      "service": "atlassian",\n      "tool": "searchJiraIssuesUsingJql",\n      "ids": ["jira_customer"],\n      "args": { "jql": "({jira_customer: \\"Customer\\" ~ \\"{}\\"}) AND updated >= \\"{since_date}\\" ORDER BY updated DESC", "maxResults": 50, "fields": ["summary", "status", "updated", "priority", "customfield_10001"] },\n      "items": "issues",\n      "lookback_hours": 48,\n      "map": {\n        "external_id": "key",\n        "group_key": "key",\n        "title": "{key} {fields.summary}",\n        "account": "fields.customfield_10001",\n        "occurred_at": "fields.updated",\n        "payload": { "status": "{fields.status.name}", "status_category": "{fields.status.statusCategory.name}", "priority": "{fields.priority.name}" }\n      }\n    },\n    {\n      "name": "table.support_cases",\n      "kind": "table",\n      "table": "main.support.cases",\n      "query": "SELECT case_id, subject, status, account_name, updated_at FROM main.support.cases WHERE updated_at > :since ORDER BY updated_at LIMIT 1000",\n      "watermark": "updated_at",\n      "map": {\n        "external_id": "case_id",\n        "group_key": "case_id",\n        "title": "{case_id} {subject}",\n        "account": "account_name",\n        "occurred_at": "updated_at",\n        "payload": ["status", "subject"]\n      }\n    },\n    {\n      "name": "table.usage",\n      "kind": "table",\n      "table": "main.sales.account_usage",\n      "ids": ["crm"],\n      "query": "SELECT account_id, workspace_id, metric, value, updated_at FROM main.sales.account_usage WHERE account_id IN (:crm) AND updated_at > :since ORDER BY updated_at LIMIT 1000",\n      "watermark": "updated_at",\n      "map": {\n        "external_id": "{account_id}:{workspace_id}:{metric}:{updated_at}",\n        "group_key": "{account_id}:{metric}",\n        "title": "{metric} for workspace {workspace_id}",\n        "account": "account_id",\n        "occurred_at": "updated_at",\n        "payload": ["workspace_id", "metric", "value"]\n      }\n    }\n  ]\n}\n';

// plugins/signals/src/poller-job.ts
var POLLER_SCHEDULE = "0 0/15 * * * ?";
var pollerJobName = (user) => `Signals poller (${user})`;
function personalSources(onboarding, slackUserId, example = EXAMPLE_SOURCES) {
  const parsed = JSON.parse(example);
  const slack = slackUserId?.trim();
  const sources = parsed.sources.filter((source) => source.kind === "mcp" && (source.name !== "slack" || slack)).map((source) => source.name === "slack" && slack ? JSON.parse(JSON.stringify(source).replaceAll("YOUR_SLACK_USER_ID", slack)) : source);
  return `${JSON.stringify({ lakebase: onboarding.lakebase, sources }, null, 2)}
`;
}
function pollerJobSettings(onboarding) {
  return {
    name: pollerJobName(onboarding.user),
    max_concurrent_runs: 1,
    schedule: { quartz_cron_expression: POLLER_SCHEDULE, timezone_id: "UTC", pause_status: "UNPAUSED" },
    tasks: [{ task_key: "poll", environment_key: "poller", spark_python_task: { python_file: `${onboarding.folder}/poller.py`, parameters: [...onboarding.args], source: "WORKSPACE" } }],
    environments: [{ environment_key: "poller", spec: { client: "2", dependencies: ["psycopg[binary]"] } }]
  };
}
async function findPollerJob(client, user, signal) {
  const reply = await client.get("/api/2.2/jobs/list", { query: { name: pollerJobName(user), limit: 25 }, ...signal && { signal } });
  return reply.jobs?.find((job) => !job.creator_user_name || job.creator_user_name.toLowerCase() === user.toLowerCase())?.job_id;
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
  if (existing) await client.post("/api/2.2/jobs/reset", { job_id: existing, new_settings: settings }, { ...signal && { signal } });
  else jobId = (await client.post("/api/2.2/jobs/create", settings, { ...signal && { signal } })).job_id;
  await client.post("/api/2.2/jobs/run-now", { job_id: jobId }, { ...signal && { signal } });
  return { jobId, created: !existing, keptSources: hadSources };
}

// plugins/signals/src/index.tsx
var inject = ["react", "settingsCards", "panels", "pages"];
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
  const toggle = async (enabled, forget = false) => {
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
  return /* @__PURE__ */ React.createElement("div", { className: "dbx-card", style: { padding: 12 } }, /* @__PURE__ */ React.createElement(Stack, { gap: 6 }, /* @__PURE__ */ React.createElement(Stack, { direction: "row", align: "center", justify: "space-between", gap: 10 }, /* @__PURE__ */ React.createElement(Stack, { gap: 2, style: { minWidth: 0 } }, /* @__PURE__ */ React.createElement(Stack, { direction: "row", gap: 6, align: "center" }, /* @__PURE__ */ React.createElement(Text, { weight: 500 }, info.label), on ? /* @__PURE__ */ React.createElement(Badge, { tone: "success" }, "On") : /* @__PURE__ */ React.createElement(Badge, null, "Off"), signIn.data === "needed" && /* @__PURE__ */ React.createElement(Badge, { tone: "warning" }, "Not signed in"), signIn.loading && info.service && /* @__PURE__ */ React.createElement(Spinner, { size: 10 })), info.description && /* @__PURE__ */ React.createElement(Text, { tone: "subtle", size: "sm" }, info.description), on && /* @__PURE__ */ React.createElement(Text, { tone: "tertiary", size: "xs" }, state?.last_post_at ? `Last read ${ago(state.last_post_at * 1e3)} (${state.last_count ?? 0} items)` : "Not read yet: your poller job reads it on its next run."), on && state?.last_error && /* @__PURE__ */ React.createElement(Text, { tone: "danger", size: "xs" }, state.last_error)), /* @__PURE__ */ React.createElement(Stack, { direction: "row", gap: 6, align: "center", style: { flex: "none" } }, signIn.data === "needed" && loginUrl && /* @__PURE__ */ React.createElement(Button, { size: "sm", onClick: () => openExternal(loginUrl) }, "Sign in"), on ? /* @__PURE__ */ React.createElement(React.Fragment, null, /* @__PURE__ */ React.createElement(Button, { size: "sm", disabled: busy, onClick: () => void toggle(false) }, "Turn off"), /* @__PURE__ */ React.createElement(Button, { size: "sm", variant: "danger", disabled: busy, title: "Turn it off and delete what the hub keeps from it", onClick: () => void toggle(false, true) }, "Forget")) : /* @__PURE__ */ React.createElement(Button, { size: "sm", variant: "brand", disabled: busy || signIn.data === "needed", onClick: () => void toggle(true) }, busy ? /* @__PURE__ */ React.createElement(Spinner, { size: 12 }) : null, "Turn on"))), error && /* @__PURE__ */ React.createElement(Text, { tone: "danger", size: "sm" }, error)));
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
function apply(ctx) {
  bindReact(ctx.react);
  const live = attach(ctx, { id: "bkvarda.databricks-signals", name: "Signals" }, (scope, main) => {
    const databricks = followWorkspace(main, WORKSPACE_PREF);
    scope.inject(["agents"], (agents) => {
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
      component: accountPanel(databricks)
    });
    scope.panels.register({
      id: "board",
      title: "Tasks board",
      matches: () => false,
      channelMenu: { label: "Tasks board", eligible: (channel) => !channel.cached },
      channelPlacement: "tab",
      component: boardPanel(ctx, databricks)
    });
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
