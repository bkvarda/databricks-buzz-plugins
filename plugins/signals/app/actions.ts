/**
 * Action items in a meeting's notes (Gemini's "Next steps"), and whose they are.
 *
 * Gemini writes one item per line, `[Name] Title: what to do`, sometimes with
 * several names (`[Ann Lee, Bob Ray]`) or none. Docs' soft line breaks (\v)
 * count as lines. This only reads the text; nothing here creates tasks yet.
 */
import type { Attendee } from "./attendees";

export type ActionItem = Readonly<{
  /** Names in the brackets, as written (empty when the line names no one). */
  owners: readonly string[];
  /** The short title before the colon, when there is one. */
  title?: string;
  /** What to do: the text after the colon, or the whole line. */
  text: string;
}>;

/** Whose an item is: someone on the account team, the customer's people, both, or not known. */
export type Side = "ours" | "customer" | "both" | "unknown";

export const MAX_ACTION_ITEMS = 50;
const MAX_ITEM = 500;

const NEXT_STEPS = /^(?:suggested\s+)?next\s+steps\s*:?\s*$/i;
// Headings that end the Next steps part (the other parts of a Gemini notes doc).
const OTHER_HEADING = /^(?:summary|details|transcript|attachments|notes|decisions|action items|---\s*tab:.*---)\s*:?\s*$/i;
const BULLET = /^(?:[-*•◦▪·]|\d+[.)])\s+/;
const ITEM = /^\[([^\]]*)\]\s*(.*)$/s;

const clip = (text: string, max: number) => (text.length > max ? `${text.slice(0, max - 1)}…` : text);

/**
 * The action items under a notes doc's "Next steps" heading, in order. A
 * heading after it (Details, Transcript, …) ends the list. Notes with no
 * Next steps heading have none.
 */
export function parseNextSteps(notes: unknown): ActionItem[] {
  if (typeof notes !== "string") return [];
  const lines = notes.replace(/\r\n?|\v|\u2028/g, "\n").split("\n").map((line) => line.replace(/[ \t\u00a0]+/g, " ").trim());
  const start = lines.findIndex((line) => NEXT_STEPS.test(line));
  if (start < 0) return [];
  const items: ActionItem[] = [];
  for (const raw of lines.slice(start + 1)) {
    if (OTHER_HEADING.test(raw) || NEXT_STEPS.test(raw)) break;
    const line = raw.replace(BULLET, "").trim();
    if (!line) continue;
    const item = itemOf(line);
    if (item) items.push(item);
    if (items.length >= MAX_ACTION_ITEMS) break;
  }
  return items;
}

function itemOf(line: string): ActionItem | undefined {
  const bracket = ITEM.exec(line);
  const owners = bracket ? bracket[1]!.split(/\s*(?:,|;|&|\band\b)\s*/i).map((name) => name.trim()).filter(Boolean) : [];
  const rest = (bracket ? bracket[2]! : line).trim();
  if (!rest) return undefined;
  // `Title: text`: a short title (Phase 2 too) with no sentence end in it.
  const colon = /^([^:]{1,80}?):\s+(\S.*)$/s.exec(rest);
  // A colon inside a time (10:30) or a link (https://) has no space after it, so neither is taken as one.
  const titled = colon && !/[.!?](?:\s|$)/.test(colon[1]!) && !/https?$/i.test(colon[1]!);
  return {
    owners,
    ...(titled && { title: clip(colon[1]!.trim(), 120) }),
    text: clip(titled ? colon[2]!.trim() : rest, MAX_ITEM),
  };
}

const letters = (text: string) => text.toLowerCase().normalize("NFKD").replace(/[^a-z]/g, "");
const words = (text: string) => text.toLowerCase().normalize("NFKD").replace(/[\u0300-\u036f]/g, "").split(/[^a-z0-9]+/).filter(Boolean);

/** Whether `phrase`'s words appear together, as whole words, in `text` ("Block team" has Block; "Blockchain team" doesn't). */
function hasPhrase(text: string, phrase: string): boolean {
  const said = words(text);
  const wanted = words(phrase);
  if (!wanted.length) return false;
  return said.some((_, i) => wanted.every((word, j) => said[i + j] === word));
}

/** Whether a name in the notes is this attendee: their name, or their address's name part (ann.lee → "Ann Lee"). */
function isPerson(name: string, person: Attendee): boolean {
  const said = letters(name);
  if (!said) return false;
  if (person.name && letters(person.name) === said) return true;
  const local = (person.email ?? "").split("@")[0]!.replace(/\+.*$/, "");
  if (local && letters(local) === said) return true;
  // A first name alone matches the whole first part of their name or of their address (Beth for Elizabeth Smith <beth.smith@…>).
  if (name.trim().split(/\s+/).length !== 1) return false;
  return [person.name ?? "", local].some((source) => {
    const first = letters(source.split(/[\s._-]+/)[0] ?? "");
    return first.length >= 3 && first === said;
  });
}

/**
 * Whose a name is, from the meeting's people: `ours` (the account team),
 * `customers` (the customer's people) and the account's names (a name like
 * "Globex team" is the customer's). A name that matches both sides, or
 * neither, is `unknown`.
 */
export function sideOfName(name: string, people: Readonly<{ ours: readonly Attendee[]; customers: readonly Attendee[]; account?: readonly string[] }>): Exclude<Side, "both"> {
  const ours = people.ours.some((person) => isPerson(name, person));
  const theirs = people.customers.some((person) => isPerson(name, person)) || (people.account ?? []).some((account) => hasPhrase(name, account));
  return ours === theirs ? "unknown" : ours ? "ours" : "customer";
}

/** Whose an item is: all its owners on one side, owners on both sides, or not known (no owners, or any not known). */
export function sideOf(item: ActionItem, people: Parameters<typeof sideOfName>[1]): Side {
  if (!item.owners.length) return "unknown";
  const sides = new Set(item.owners.map((name) => sideOfName(name, people)));
  if (sides.has("unknown")) return "unknown";
  return sides.size > 1 ? "both" : [...sides][0]!;
}
