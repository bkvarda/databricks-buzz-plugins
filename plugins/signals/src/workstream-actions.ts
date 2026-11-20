// What a team sets for each workstream in Set up account: which actions
// agents watch for (each with its trigger; every ticked one applies) and what
// happens otherwise. The types, the catalog and the checks live in
// app/model.ts, shared with the hub; these are the setup form's helpers.
import { type CatalogAction, catalogFor, MAX_ACTION_TRIGGER, type Mode, recommendedRow, type WorkstreamAction, type WorkstreamActionsRow } from "../app/model";

const plain = ({ recommended: _recommended, ...rest }: CatalogAction): WorkstreamAction => rest;

/** A new row for a workstream: its built-in recommended ticks, or nothing ticked and Track. */
export function startRow(workstream: string): WorkstreamActionsRow {
  const entry = catalogFor(workstream);
  return entry ? recommendedRow(entry) : { watch: [], otherwise: "track" };
}

/**
 * The actions a row offers, in order: the built-in ones (ticked or not, with
 * the team's own trigger text when they changed it), then the team's own.
 */
export function rowChoices(workstream: string, row: WorkstreamActionsRow): { action: WorkstreamAction; ticked: boolean; custom: boolean }[] {
  const builtIn = catalogFor(workstream)?.actions ?? [];
  const ticked = new Map(row.watch.map((item) => [item.id, item]));
  return [
    ...builtIn.map((item) => ({ action: ticked.get(item.id) ?? plain(item), ticked: ticked.has(item.id), custom: false })),
    ...row.watch.filter((item) => !builtIn.some((other) => other.id === item.id)).map((item) => ({ action: item, ticked: true, custom: true })),
  ];
}

/** Ticks or unticks an action, keeping the row's order the same as its choices. */
export function toggle(workstream: string, row: WorkstreamActionsRow, item: WorkstreamAction, on: boolean): WorkstreamActionsRow {
  if (!on) return { ...row, watch: row.watch.filter((other) => other.id !== item.id) };
  if (row.watch.some((other) => other.id === item.id)) return row;
  const order = rowChoices(workstream, { ...row, watch: [...row.watch, item] }).map((choice) => choice.action.id);
  return { ...row, watch: [...row.watch, item].sort((a, b) => order.indexOf(a.id) - order.indexOf(b.id)) };
}

/** Changes an action's trigger text (ticking it if it wasn't). */
export function retrigger(workstream: string, row: WorkstreamActionsRow, item: WorkstreamAction, trigger: string): WorkstreamActionsRow {
  const next = { ...item, trigger: trigger.trim().slice(0, MAX_ACTION_TRIGGER) };
  return row.watch.some((other) => other.id === item.id) ? { ...row, watch: row.watch.map((other) => (other.id === item.id ? next : other)) } : toggle(workstream, row, next, true);
}

/** A slug for a team's own action, unique in the row. */
export function newActionId(label: string, row: WorkstreamActionsRow, workstream: string): string {
  const base = (label.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 34) || "action");
  const taken = new Set([...row.watch.map((item) => item.id), ...(catalogFor(workstream)?.actions ?? []).map((item) => item.id)]);
  let id = base;
  for (let n = 2; taken.has(id); n++) id = `${base}-${n}`;
  return id;
}

/** One line for a row's state, as setup shows it folded. */
export function rowSummary(row: WorkstreamActionsRow | undefined): string {
  if (!row) return "Agents work every task";
  const otherwise = row.otherwise === "dismiss" ? "otherwise dismiss" : "otherwise track";
  if (!row.watch.length) return row.otherwise === "dismiss" ? "Dismiss everything" : "Track only";
  if (row.watch.some((item) => item.always)) return `Work every task${row.watch.length > 1 ? ` · also watch for ${row.watch.length - 1}` : ""}`;
  return `Watch for ${row.watch.length} · ${otherwise}`;
}

// As parsePreferences reads a mode line: an optional list mark, the name, a colon and one word.
const MODE_LINE = (workstream: string) => new RegExp(`^(\\s*(?:[-*]\\s*)?)${workstream.trim().replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*:\\s*\\S+\\s*$`, "gim");

/**
 * Sets a workstream's mode in the team's preferences text: replaces its line
 * (`- tickets: draft`), adds one after the other mode lines, or, with
 * `undefined`, removes it so the workstream follows `everything`.
 */
export function withMode(preferences: string, workstream: string, mode: Mode | undefined, modes: readonly string[]): string {
  const pattern = MODE_LINE(workstream);
  // Only lines that set a mode: "tickets: see the runbook" is guidance and stays.
  const setsMode = (line: string) => new RegExp(`:\\s*(${modes.join("|")})[.,;]?\\s*$`, "i").test(line);
  if (preferences.match(pattern)?.some(setsMode)) {
    const lines = preferences.split("\n");
    const line = (text: string) => new RegExp(pattern.source, "i").test(text) && setsMode(text);
    if (!mode) return lines.filter((text) => !line(text)).join("\n");
    return lines.map((text) => (line(text) ? text.replace(new RegExp(pattern.source, "i"), `$1${workstream.trim()}: ${mode}`) : text)).join("\n");
  }
  if (!mode) return preferences;
  const lines = preferences.split("\n");
  const isMode = (line: string) => new RegExp(`^\\s*(?:[-*]\\s+)?[^:]{1,80}:\\s*(${modes.join("|")})\\s*$`, "i").test(line);
  const last = lines.reduce((at, line, index) => (isMode(line) ? index : at), -1);
  const line = `- ${workstream.trim()}: ${mode}`;
  if (last < 0) return [line, ...(preferences.trim() ? ["", preferences] : [])].join("\n");
  lines.splice(last + 1, 0, line);
  return lines.join("\n");
}
