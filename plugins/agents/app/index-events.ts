// What the search index keeps from Buzz events, as Buzz itself folds them
// (src/features/relay/fold.ts in buzz-app): channel metadata (kind 39000,
// relay-signed), messages (9, and 40002 agent envelopes), author edits
// (40003, latest wins), deletions (5 by the author, 9005 by the relay) and
// profiles (0). Pure, so it's testable.
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

export type MessageRow = Readonly<{ id: string; channel: string; author: string; root?: string; kind: number; createdAt: number; text: string }>;

export function messageOf(event: NostrEvent): MessageRow | undefined {
  if (!CHAT_KINDS.includes(event.kind)) return undefined;
  const channel = tag(event, "h");
  if (!channel) return undefined;
  const text = plainText(event.content);
  if (!text) return undefined;
  const root = threadRoot(event);
  return { id: event.id, channel, author: event.pubkey, ...(root && root !== event.id && { root }), kind: event.kind, createdAt: event.created_at, text };
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

export type Person = Readonly<{ pubkey: string; name: string; updatedAt: number }>;

export function personOf(event: NostrEvent): Person | undefined {
  if (event.kind !== 0) return undefined;
  try {
    const profile = JSON.parse(event.content) as { name?: string; display_name?: string; displayName?: string };
    const name = profile.display_name || profile.displayName || profile.name;
    return name ? { pubkey: event.pubkey, name: String(name).slice(0, 200), updatedAt: event.created_at } : undefined;
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
