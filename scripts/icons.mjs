#!/usr/bin/env node
// Renders each plugin's catalog icon (512×512 PNG) from SVG artwork.
import { Resvg } from "@resvg/resvg-js";
import { writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const MARK = "M283.923 136.449L150.144 213.624L6.88995 131.168L0 134.982V194.844L150.144 281.115L283.923 204.234V235.926L150.144 313.1L6.88995 230.644L0 234.458V244.729L150.144 331L300 244.729V184.867L293.11 181.052L150.144 263.215L16.0766 186.334V154.643L150.144 231.524L300 145.253V86.2713L292.536 81.8697L150.144 163.739L22.9665 90.9663L150.144 17.8998L254.641 78.055L263.828 72.773V65.4371L150.144 0L0 86.2713V95.6613L150.144 181.933L283.923 104.758V136.449Z";

const tile = (from, to, body) => `<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512" viewBox="0 0 512 512">
  <defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${from}"/><stop offset="1" stop-color="${to}"/></linearGradient></defs>
  <rect x="16" y="16" width="480" height="480" rx="112" fill="url(#g)"/>
  ${body}
</svg>`;
// The Databricks mark, scaled into a corner badge or the center.
const mark = (x, y, size, fill) => `<g transform="translate(${x} ${y}) scale(${size / 331})"><path d="${MARK}" fill="${fill}"/></g>`;

const ICONS = {
  databricks: tile("#FF3621", "#E5301D", mark(154, 136, 240, "#FFFFFF")),
  genie: tile("#0B2026", "#1B5162", `
    <path d="M128 168c0-26 21-48 48-48h160c27 0 48 22 48 48v112c0 27-21 48-48 48H236l-62 52v-52h2c-27 0-48-21-48-48z" fill="#FFFFFF" opacity="0.95"/>
    <path d="M256 166l15 40 40 15-40 15-15 40-15-40-40-15 40-15z" fill="#FF3621"/>
    <path d="M324 196l7 18 18 7-18 7-7 18-7-18-18-7 18-7z" fill="#FF3621" opacity="0.8"/>
    ${mark(372, 356, 72, "#FF3621")}`),
  sql: tile("#0B2026", "#143D4A", `
    <ellipse cx="256" cy="150" rx="108" ry="40" fill="none" stroke="#FFFFFF" stroke-width="22"/>
    <path d="M148 150v104c0 22 48 40 108 40s108-18 108-40V150" fill="none" stroke="#FFFFFF" stroke-width="22"/>
    <path d="M148 254v104c0 22 48 40 108 40s108-18 108-40V254" fill="none" stroke="#FFFFFF" stroke-width="22"/>
    <path d="M216 236l-28 24 28 24M296 236l28 24-28 24" fill="none" stroke="#FF3621" stroke-width="18" stroke-linecap="round" stroke-linejoin="round"/>
    ${mark(372, 356, 72, "#FF3621")}`),
  agents: tile("#FF7033", "#E5301D", `
    <rect x="144" y="176" width="224" height="176" rx="56" fill="#FFFFFF"/>
    <circle cx="214" cy="262" r="20" fill="#0B2026"/><circle cx="298" cy="262" r="20" fill="#0B2026"/>
    <path d="M226 310h60" stroke="#0B2026" stroke-width="14" stroke-linecap="round"/>
    <path d="M256 176v-40" stroke="#FFFFFF" stroke-width="14" stroke-linecap="round"/><circle cx="256" cy="124" r="16" fill="#FFFFFF"/>
    <path d="M144 250h-28M396 250h-28" stroke="#FFFFFF" stroke-width="16" stroke-linecap="round"/>
    ${mark(372, 356, 72, "#0B2026")}`),
  memory: tile("#1B5162", "#0B2026", `
    <path d="M176 120h160a24 24 0 0 1 24 24v248l-104-60-104 60V144a24 24 0 0 1 24-24z" fill="#FFFFFF"/>
    <path d="M256 168l12 30 32 2-25 20 9 31-28-18-28 18 9-31-25-20 32-2z" fill="#FF3621"/>
    ${mark(372, 356, 72, "#FF3621")}`),
  lakebase: tile("#143D4A", "#003159", `
    <ellipse cx="256" cy="156" rx="100" ry="36" fill="#FFFFFF"/>
    <path d="M156 156v150c0 20 45 36 100 36s100-16 100-36V156" fill="#FFFFFF" opacity="0.92"/>
    <path d="M120 360c22-16 44-16 66 0s44 16 66 0 44-16 66 0 44 16 66 0 44-16 66 0" fill="none" stroke="#FF3621" stroke-width="18" stroke-linecap="round"/>
    <path d="M196 228h120M196 272h120" stroke="#143D4A" stroke-width="14" stroke-linecap="round" opacity="0.5"/>
    ${mark(392, 52, 64, "#FF3621")}`),
};

for (const [name, svg] of Object.entries(ICONS)) {
  const png = new Resvg(svg, { fitTo: { mode: "width", value: 512 } }).render().asPng();
  await writeFile(join(root, "plugins", name, "icon.png"), png);
  await writeFile(join(root, "docs", "icons", `${name}.svg`), svg).catch(async () => {
    const { mkdir } = await import("node:fs/promises");
    await mkdir(join(root, "docs", "icons"), { recursive: true });
    await writeFile(join(root, "docs", "icons", `${name}.svg`), svg);
  });
  console.log(`✓ ${name} icon (${(png.length / 1024).toFixed(0)} KiB)`);
}
