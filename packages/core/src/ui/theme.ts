// Databricks brand mappings for plugin-owned content, layered on Buzz roles.
//
// Buzz owns surfaces, text, controls and both color modes; these plugins use
// its CSS roles for all of that, so they follow light/dark, accent and text
// scale like any built-in screen. Databricks identity shows up where the
// content is Databricks': the mark, brand actions such as "Sign in with
// Databricks", status of Databricks objects, chart palettes and data tables.
// Like GitHub's `--github-*`, every mapping is scoped to `[data-dbx]`.

export const BRAND = {
  lava: "#FF3621",
  lavaStrong: "#E5301D",
  navy: "#0B2026",
  oat: "#F9F7F4",
  oatMedium: "#EEEDE9",
  green: "#00A972",
  amber: "#FBB300",
  blue: "#4462C9",
  teal: "#1B5162",
} as const;

/** Databricks categorical chart palette; index 5 swaps for dark mode. */
export const CHART_COLORS = [
  "var(--dbx-chart-1)",
  "var(--dbx-chart-2)",
  "var(--dbx-chart-3)",
  "var(--dbx-chart-4)",
  "var(--dbx-chart-5)",
  "var(--dbx-chart-6)",
  "var(--dbx-chart-7)",
  "var(--dbx-chart-8)",
] as const;

const STYLE_ID = "dbx-buzz-plugins-style-v1";

export const STYLESHEET = `
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

/** Adds the scoped stylesheet once per document. Safe to call repeatedly. */
/** A short hash of the stylesheet, so each build's rules get their own element. */
function styleHash(text: string): string {
  let hash = 5381;
  for (let i = 0; i < text.length; i++) hash = ((hash << 5) + hash + text.charCodeAt(i)) | 0;
  return (hash >>> 0).toString(36);
}

const STYLE_ELEMENT_ID = `${STYLE_ID}-${styleHash(STYLESHEET)}`;

/**
 * Adds this build's stylesheet once per document. Keyed by content: a plugin
 * updated while Buzz runs adds its new rules instead of finding the old
 * element and stopping (the old one stays for plugins still on it; the newer
 * one comes later, so it wins where they differ).
 */
export function ensureStyles(doc: Document | undefined = globalThis.document): void {
  if (!doc || doc.getElementById(STYLE_ELEMENT_ID)) return;
  const style = doc.createElement("style");
  style.id = STYLE_ELEMENT_ID;
  style.textContent = STYLESHEET;
  doc.head.appendChild(style);
}

/** The Databricks symbol (Lava), as an SVG string. */
/** The Databricks symbol's path, in a 300×331 box. */
export const DATABRICKS_MARK_PATH =
  "M283.923 136.449L150.144 213.624L6.88995 131.168L0 134.982V194.844L150.144 281.115L283.923 204.234V235.926L150.144 313.1L6.88995 230.644L0 234.458V244.729L150.144 331L300 244.729V184.867L293.11 181.052L150.144 263.215L16.0766 186.334V154.643L150.144 231.524L300 145.253V86.2713L292.536 81.8697L150.144 163.739L22.9665 90.9663L150.144 17.8998L254.641 78.055L263.828 72.773V65.4371L150.144 0L0 86.2713V95.6613L150.144 181.933L283.923 104.758V136.449Z";

export const DATABRICKS_MARK_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 300 331" fill="none"><path fill="#FF3621" d="${DATABRICKS_MARK_PATH}"/></svg>`;

/** Monochrome version that paints with currentColor, for Buzz navigation
 * icons: Buzz draws `currentColor` SVGs as a mask in the text color. */
export const DATABRICKS_MARK_MONO_SVG = DATABRICKS_MARK_SVG.replace(
  'fill="#FF3621"',
  'fill="currentColor"',
);

export const svgDataUri = (svg: string) =>
  `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`;

export const DATABRICKS_ICON = svgDataUri(DATABRICKS_MARK_SVG);
export const DATABRICKS_ICON_MONO = svgDataUri(DATABRICKS_MARK_MONO_SVG);
