// Which parts of an agent's draft a customer would read, and what in them
// looks internal. Agents mark their draft with audience headings (see
// DRAFT_FORMAT). Only an audience heading switches parts: any other heading
// (### Sources, ## Next steps) stays in the part it's under, and so does text
// in a code block fenced with ``` or ~~~. Text before the first audience
// heading is neither part.

/** What agents are asked to do, so the hub can tell the parts apart. */
export const DRAFT_FORMAT = 'Put what a customer would read under a heading "Customer draft", and anything only for us (sources, tickets, reasoning) under "Internal notes".';

export type DraftPart = "customer" | "internal";
export type DraftSections = { customer: string; internal: string; marked: boolean };

const HEADING = /^\s{0,3}(?:#{1,6}\s+|\*\*|__)?\s*(?:\p{Extended_Pictographic}\uFE0F?\s*)?([A-Za-z][A-Za-z '/-]{2,40}?)\s*(?:\*\*|__)?\s*:?\s*(?:\*\*|__)?\s*$/u;
/** Audience headings: who the text under them is for. */
const CUSTOMER = /^(customer(?:[- ]facing)?(?: draft| reply| email| response| answer)?|draft (?:reply|email|response)(?: to (?:the )?customer)?|reply to (?:the )?customer|email draft)$/i;
const INTERNAL = /^(internal(?: notes?| only| context)?|notes? for (?:us|the team)|for (?:us|the team))$/i;
const FENCE = /^\s{0,3}(`{3,}|~{3,})/;

/** Splits a draft by its audience headings. */
export function draftSections(text: string): DraftSections {
  const parts: Record<DraftPart, string[]> = { customer: [], internal: [] };
  let part: DraftPart | undefined;
  let marked = false;
  let fence: string | undefined;
  for (const line of text.split(/\r?\n/)) {
    const opens = FENCE.exec(line)?.[1];
    if (opens && (!fence || (opens[0] === fence[0] && opens.length >= fence.length))) fence = fence ? undefined : opens;
    else if (!fence) {
      const heading = HEADING.exec(line)?.[1]?.trim();
      const to: DraftPart | undefined = heading && CUSTOMER.test(heading) ? "customer" : heading && INTERNAL.test(heading) ? "internal" : undefined;
      if (to) {
        part = to;
        marked = true;
        continue;
      }
    }
    if (part) parts[part].push(line);
  }
  return { customer: parts.customer.join("\n").trim(), internal: parts.internal.join("\n").trim(), marked };
}

export type Hit = { kind: string; text: string };

/** What looks internal: links and ids a customer can't open or shouldn't see. */
const PATTERNS: readonly [string, RegExp][] = [
  ["go link", /\bgo\/[\w-]+(?:\/[\w./-]*)?/gi],
  ["Jira or Confluence", /\bhttps?:\/\/[\w-]+\.atlassian\.net\/\S*/gi],
  ["internal ticket", /\b(?:ES|INC|NOC|PS|SC|DECO|PLAT)-\d{3,}\b/g],
  ["Brickroad", /\bbrickroad:\S+|\bbrickroad\s*#\d+/gi],
  ["Buzz link", /\bbuzz:\/\/\S+/gi],
  ["Slack link", /\bhttps?:\/\/[\w-]+\.slack\.com\/\S*/gi],
  ["Google Drive", /\bhttps?:\/\/(?:docs|drive)\.google\.com\/\S*/gi],
  ["workspace link", /\bhttps?:\/\/(?:[\w-]+\.)*(?:cloud\.databricks\.com|azuredatabricks\.net|gcp\.databricks\.com|databricksapps\.com)\S*/gi],
  ["Glean", /\bhttps?:\/\/[\w-]+\.glean\.com\/\S*|\bglean\b/gi],
  ["internal date", /\beng(?:ineering)?[- ]availability(?: date)?\b/gi],
];

/** Hosts a customer can open, which a pattern above would otherwise catch. */
const PUBLIC = /^https?:\/\/(?:docs|www|community|learn)\.databricks\.com\b/i;

export function internalHits(text: string): Hit[] {
  const hits = new Map<string, Hit>();
  for (const [kind, pattern] of PATTERNS)
    for (const found of text.matchAll(pattern)) {
      const value = found[0].replace(/[.,;:!?)\]>*_]+$/, "");
      if (!PUBLIC.test(value) && !hits.has(value)) hits.set(value, { kind, text: value });
    }
  return [...hits.values()];
}

/**
 * The check's result for one reply: "unchecked" when it has no customer part
 * to check (no audience headings, only Internal notes, or an empty Customer
 * draft), "clean" when its customer part has nothing internal-looking, and
 * "warned" with the kinds of what was found. Kinds only, never the text.
 */
export type DisclosureResult = { status: "unchecked" } | { status: "clean" } | { status: "warned"; kinds: string[] };

export function disclosureCheck(text: string): DisclosureResult {
  const { customer } = draftSections(text);
  if (!customer) return { status: "unchecked" };
  const kinds = [...new Set(internalHits(customer).map((hit) => hit.kind))];
  return kinds.length ? { status: "warned", kinds } : { status: "clean" };
}
