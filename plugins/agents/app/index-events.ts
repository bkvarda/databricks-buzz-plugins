// What the search index keeps from Buzz events, as Buzz itself folds them
// (src/features/relay/fold.ts in buzz-app): channel metadata (kind 39000,
// relay-signed), messages (9, and 40002 agent envelopes), author edits
// (40003, latest wins), deletions (5 by the author, 9005 by the relay) and
// profiles (0). Pure, so it's testable.
import { decode } from "nostr-tools/nip19";
import type { NostrEvent } from "nostr-tools/pure";
import { CHAT_KINDS, plainText, threadRoot } from "../runner/buzz";

export const EDIT_KIND = 40003;
export const DELETE_KINDS = [5, 9005];
/** Everything the live read follows in a channel. */
export const INDEX_KINDS = [...CHAT_KINDS, EDIT_KIND, ...DELETE_KINDS];

const HEX64 = /^[0-9a-f]{64}$/;
const tag = (event: Pick<NostrEvent, "tags">, name: string) => event.tags.find((t) => t[0] === name)?.[1];
const has = (event: Pick<NostrEvent, "tags">, name: string) => event.tags.some((t) => t[0] === name);

export type ChannelRow = Readonly<{ id: string; name: string; about?: string; type?: string; public: boolean; signer: string; updatedAt: number }>;

/**
 * A channel from its metadata. Only channels marked public (and not hidden,
 * like DMs, or Solo chats and system channels) are indexed: everyone in the
 * community can read those already.
 */
export function channelOf(metadata: NostrEvent): ChannelRow | undefined {
  if (metadata.kind !== 39000) return undefined;
  const id = tag(metadata, "d");
  if (!id) return undefined;
  const [type, ...labels] = metadata.tags.flatMap((t) => (t[0] === "t" && typeof t[1] === "string" ? [t[1]] : []));
  const solo = type === "stream" && labels.includes("buzz.solo");
  const kindOk = !type || type === "stream" || type === "forum";
  const visible = has(metadata, "public") && !has(metadata, "private") && !has(metadata, "hidden");
  const about = tag(metadata, "about");
  return {
    id,
    name: tag(metadata, "name") || id,
    ...(about && { about }),
    ...(type && { type }),
    public: visible && kindOk && !solo,
    signer: metadata.pubkey,
    updatedAt: metadata.created_at,
  };
}

export type MessageRow = Readonly<{ id: string; channel: string; author: string; root?: string; kind: number; createdAt: number; text: string; mentions: string[] }>;

export function messageOf(event: NostrEvent): MessageRow | undefined {
  if (!CHAT_KINDS.includes(event.kind)) return undefined;
  const channel = tag(event, "h");
  if (!channel) return undefined;
  const text = plainText(event.content);
  if (!text) return undefined;
  const root = threadRoot(event);
  // Who it mentions (its `p` tags), for to:@someone.
  const mentions = [...new Set(event.tags.flatMap((t) => (t[0] === "p" && HEX64.test(t[1] ?? "") ? [t[1]!] : [])))];
  return { id: event.id, channel, author: event.pubkey, ...(root && root !== event.id && { root }), kind: event.kind, createdAt: event.created_at, text, mentions };
}

export type Edit = Readonly<{ target: string; author: string; text: string; at: number }>;

/** An author's edit: the message it replaces the text of, and the new text. */
export function editOf(event: NostrEvent): Edit | undefined {
  if (event.kind !== EDIT_KIND) return undefined;
  const target = event.tags.find((t) => t[0] === "e" && HEX64.test(t[1] ?? ""))?.[1];
  if (!target) return undefined;
  return { target, author: event.pubkey, text: plainText(event.content), at: event.created_at };
}

export type Deletion = Readonly<{ targets: string[]; author: string; byRelay: boolean }>;

/** A deletion: by its author (5), or by the relay for a moderator (9005), which applies to anyone's message. */
export function deletionOf(event: NostrEvent, relaySigners: ReadonlySet<string>): Deletion | undefined {
  if (!DELETE_KINDS.includes(event.kind)) return undefined;
  const targets = event.tags.flatMap((t) => (t[0] === "e" && HEX64.test(t[1] ?? "") ? [t[1]!] : []));
  if (!targets.length) return undefined;
  const byRelay = event.kind === 9005;
  if (byRelay && !relaySigners.has(event.pubkey)) return undefined;
  return { targets, author: event.pubkey, byRelay };
}

export type Person = Readonly<{ pubkey: string; name: string; username?: string; updatedAt: number }>;

export function personOf(event: NostrEvent): Person | undefined {
  if (event.kind !== 0) return undefined;
  try {
    const profile = JSON.parse(event.content) as { name?: string; display_name?: string; displayName?: string; nip05?: string };
    const name = profile.display_name || profile.displayName || profile.name;
    // The handle people type after @: their profile's name, else their NIP-05 name.
    const username = (profile.name || (typeof profile.nip05 === "string" ? profile.nip05.split("@")[0] : "") || "").toLowerCase().replace(/^@/, "");
    return name ? { pubkey: event.pubkey, name: String(name).slice(0, 200), ...(username && { username: username.slice(0, 100) }), updatedAt: event.created_at } : undefined;
  } catch {
    return undefined;
  }
}

/** Search terms people type, cleaned for Postgres text search: words only, at most 32. */
export function searchTerms(query: string): string {
  return query
    .replace(/[^\p{L}\p{N}\s'-]+/gu, " ")
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 32)
    .join(" ");
}

/**
 * A search as Slack has it: words (with "quoted phrases", OR and -excluded
 * words, as websearch_to_tsquery reads them) and filters:
 *   from:@name  to:@name  in:#channel  before:2026-11-01  after:…  on:…
 *   during:2026-11 (or a year)  has:link  is:thread
 * Names can be a handle, a display name, an npub or a hex key; dates are UTC.
 * Anything it doesn't know stays in the words.
 */
export type SearchQuery = {
  text: string;
  from: string[];
  to: string[];
  in: string[];
  /** Epoch seconds: at or after, and before. */
  after?: number;
  before?: number;
  link?: boolean;
  thread?: boolean;
};

const DAY = 86_400;

/** [start, end) of a date written YYYY-MM-DD, YYYY-MM or YYYY, today or yesterday, in UTC seconds. */
export function dateRange(value: string, now = Date.now()): [number, number] | undefined {
  const today = Math.floor(now / 1000 / DAY) * DAY;
  if (value === "today") return [today, today + DAY];
  if (value === "yesterday") return [today - DAY, today];
  const match = /^(\d{4})(?:-(\d{1,2})(?:-(\d{1,2}))?)?$/.exec(value);
  if (!match) return undefined;
  const [year, month, day] = [Number(match[1]), match[2] ? Number(match[2]) : undefined, match[3] ? Number(match[3]) : undefined];
  if ((month !== undefined && (month < 1 || month > 12)) || (day !== undefined && (day < 1 || day > 31))) return undefined;
  const start = Date.UTC(year, (month ?? 1) - 1, day ?? 1) / 1000;
  const end = day !== undefined ? start + DAY : month !== undefined ? Date.UTC(year, month, 1) / 1000 : Date.UTC(year + 1, 0, 1) / 1000;
  return [start, end];
}

/** A person as typed after from: or to:, as a hex key when it is one. */
function personKey(value: string): string {
  const bare = value.replace(/^@/, "");
  if (HEX64.test(bare)) return bare;
  if (/^(npub|nprofile)1[0-9a-z]+$/.test(bare)) {
    try {
      const decoded = decode(bare);
      if (decoded.type === "npub") return decoded.data;
      if (decoded.type === "nprofile") return decoded.data.pubkey;
    } catch {}
  }
  return bare.toLowerCase();
}

export function parseQuery(query: string, now = Date.now()): SearchQuery {
  const out: SearchQuery = { text: "", from: [], to: [], in: [] };
  const words: string[] = [];
  // Words, "quoted phrases", and filter:values (a value may be quoted too).
  for (const [, token = ""] of query.matchAll(/((?:[a-z]+:)?"[^"]*"|\S+)/gi)) {
    const filter = /^([a-z]+):(.+)$/i.exec(token);
    const key = filter?.[1]?.toLowerCase();
    const value = filter?.[2]?.replace(/^"|"$/g, "").trim() ?? "";
    if (!filter || !value) {
      words.push(token);
      continue;
    }
    if (key === "from") out.from.push(personKey(value));
    else if (key === "to") out.to.push(personKey(value));
    else if (key === "in") out.in.push(value.replace(/^#/, "").toLowerCase());
    else if (key === "has" && value.toLowerCase() === "link") out.link = true;
    else if (key === "is" && value.toLowerCase() === "thread") out.thread = true;
    else if (key === "before" || key === "after" || key === "on" || key === "during") {
      const range = dateRange(value.toLowerCase(), now);
      if (!range) {
        words.push(token);
        continue;
      }
      if (key === "before") out.before = Math.min(out.before ?? Infinity, range[0]);
      else if (key === "after") out.after = Math.max(out.after ?? 0, range[1]);
      else {
        out.after = Math.max(out.after ?? 0, range[0]);
        out.before = Math.min(out.before ?? Infinity, range[1]);
      }
    } else words.push(token);
  }
  out.text = words.join(" ").trim();
  return out;
}
