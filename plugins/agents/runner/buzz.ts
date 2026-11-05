// Buzz's relay protocol, as a hosted agent needs it (pure, so it's testable):
// which mentions to answer, where a conversation is, what the harness is
// shown, and the events the agent signs. Mirrors the app's own harness kit
// (src/features/agent-harness/kit.ts and the Claude Code prompt).
import { schnorr } from "@noble/curves/secp256k1.js";
import { sha256 } from "@noble/hashes/sha2.js";
import type { EventTemplate, NostrEvent } from "nostr-tools/pure";

/** Channel messages; 40002 is the agent-envelope message kind. */
export const CHAT_KINDS = [9, 40002];
export const SOLO_LABEL = "buzz.solo";
/** The relay refuses socket frames over 64 KiB; leave room for tags and JSON. */
export const MAX_MESSAGE_BYTES = 48_000;

const HEX64 = /^[0-9a-f]{64}$/;
const HEX128 = /^[0-9a-f]{128}$/;
const CONDITION = /^(kind=|created_at<|created_at>)(0|[1-9][0-9]*)$/;

const tagValue = (event: Pick<NostrEvent, "tags">, name: string) => event.tags.find((tag) => tag[0] === name)?.[1];

export const channelOf = (event: Pick<NostrEvent, "tags">) => {
  const value = tagValue(event, "h");
  return value && /^[a-zA-Z0-9_-]{1,128}$/.test(value) ? value : undefined;
};

/** NIP-10 marked `e` tags: the last valid root wins; a lone `reply` names the root. */
export function threadRoot(event: Pick<NostrEvent, "tags">): string | undefined {
  let root: string | undefined;
  let reply: string | undefined;
  for (const tag of event.tags) {
    if (tag[0] !== "e" || !HEX64.test(tag[1] ?? "")) continue;
    if (tag[3] === "root") root = tag[1];
    else if (tag[3] === "reply") reply = tag[1];
  }
  return root ?? reply;
}

/** Whether an event asks the agent something: a chat message tagging it, from someone else. */
export const mentionsAgent = (event: NostrEvent, agent: string) =>
  CHAT_KINDS.includes(event.kind) && event.pubkey !== agent && event.tags.some((tag) => tag[0] === "p" && tag[1] === agent);

/** NIP-OA: the owner whose `auth` tag on `event` checks out, if any. */
export function attestedOwner(event: Pick<NostrEvent, "tags" | "pubkey" | "kind" | "created_at">): string | undefined {
  const tags = event.tags.filter((tag) => tag[0] === "auth");
  if (tags.length !== 1) return undefined;
  const [, owner = "", conditions = "", signature = ""] = tags[0]!;
  if (tags[0]!.length !== 4 || !HEX64.test(owner) || !HEX128.test(signature) || owner === event.pubkey) return undefined;
  const clauses = conditions ? conditions.split("&") : [];
  if (!clauses.every((clause) => CONDITION.test(clause))) return undefined;
  for (const clause of clauses) {
    const value = Number(clause.replace(/^[^0-9]+/, ""));
    if (clause.startsWith("kind=") && event.kind !== value) return undefined;
    if (clause.startsWith("created_at<") && !(event.created_at < value)) return undefined;
    if (clause.startsWith("created_at>") && !(event.created_at > value)) return undefined;
  }
  const digest = sha256(new TextEncoder().encode(`nostr:agent-auth:${event.pubkey}:${conditions}`));
  try {
    return schnorr.verify(Buffer.from(signature, "hex"), digest, Buffer.from(owner, "hex")) ? owner : undefined;
  } catch {
    return undefined;
  }
}

/** Buzz's admission rule: the owner's own message, or one the owner attested. */
export const fromOwner = (event: NostrEvent, owner: string) => event.pubkey === owner || attestedOwner(event) === owner;

/** A channel's kind 39000 metadata: its type, and whether it's a Solo chat. */
export function channelKind(metadata: Pick<NostrEvent, "tags"> | undefined): { type?: string; solo: boolean } {
  if (!metadata) return { solo: false };
  const [type, ...labels] = metadata.tags.flatMap((tag) => (tag[0] === "t" && typeof tag[1] === "string" ? [tag[1]] : []));
  return { ...(type && { type }), solo: type === "stream" && labels.includes(SOLO_LABEL) };
}

export type Conversation = Readonly<{
  /** `channel`, or `channel/root` for a thread. */
  key: string;
  channel: string;
  root: string;
  /** Replies go at the channel's top level (a Solo chat). */
  topLevel: boolean;
  dm: boolean;
  /** The mention started a thread of its own (no context to read). */
  fresh: boolean;
}>;

/** Where a mention's conversation is, as the kit decides it. */
export function conversationOf(event: NostrEvent, scope: "thread" | "channel", kind: { type?: string; solo: boolean }): Conversation | undefined {
  const channel = channelOf(event);
  if (!channel) return undefined;
  const parent = threadRoot(event);
  const root = parent ?? event.id;
  const dm = kind.type === "dm";
  const topLevel = kind.solo;
  const whole = topLevel || dm || scope === "channel";
  return { key: whole ? channel : `${channel}/${root}`, channel, root, topLevel, dm, fresh: !parent && !whole };
}

/** What to read for context: the thread, or the conversation's recent messages. */
export function contextFilters(conversation: Conversation): Record<string, unknown>[] {
  if (conversation.fresh) return [];
  if (!conversation.topLevel && !conversation.dm && conversation.key !== conversation.channel)
    return [
      { ids: [conversation.root], "#h": [conversation.channel], limit: 1 },
      { kinds: CHAT_KINDS, "#h": [conversation.channel], "#e": [conversation.root], limit: 200 },
    ];
  return [{ kinds: CHAT_KINDS, "#h": [conversation.channel], limit: 13 }];
}

/** JSON for a prompt, with <, > and & escaped so content can't close our tags. */
const safeJson = (value: unknown) => JSON.stringify(value).replace(/</g, "\\u003c").replace(/>/g, "\\u003e").replace(/&/g, "\\u0026");

export type PromptInput = Readonly<{
  event: NostrEvent;
  conversation: Conversation;
  agent: string;
  /** Earlier messages the session hasn't been shown, oldest first. */
  context: readonly NostrEvent[];
  /** Total messages found, for the `truncated` note. */
  total: number;
  names: ReadonlyMap<string, string>;
  scope: "thread" | "channel";
}>;

const item = (event: NostrEvent, names: ReadonlyMap<string, string>) => ({
  id: event.id,
  pubkey: event.pubkey,
  ...(names.get(event.pubkey) && { author: names.get(event.pubkey) }),
  time: new Date(event.created_at * 1000).toISOString(),
  content: event.content,
});

/** The turn's prompt, in the shape Buzz's own harnesses are shown. */
export function turnPrompt(input: PromptInput): string {
  const { event, conversation, names } = input;
  const where = conversation.dm ? "dm" : conversation.key === conversation.channel ? "channel" : "thread";
  const context = [
    `Scope: ${where}`,
    `Session scope: ${input.scope === "channel" || conversation.key === conversation.channel ? "channel" : "thread"} conversation`,
    `Channel: #${conversation.channel}`,
    ...(where === "thread" ? [`Thread root: ${conversation.root}`] : []),
    `Agent: ${input.agent}`,
    "Your final message is posted as your reply in this conversation.",
  ].join("\n");
  const tag = where === "thread" ? "thread-context" : "conversation-context";
  const parts = [`<context>\n${context}\n</context>`];
  if (input.context.length)
    parts.push(
      `<${tag} included="${input.context.length}" total="${input.total}" truncated="${input.total > input.context.length}">\n${safeJson(input.context.map((e) => item(e, names)))}\n</${tag}>`,
    );
  const mentions = event.tags.filter((t) => t[0] === "p").map((t) => t[1]);
  parts.push(
    `<buzz-event type="@mention">\n${safeJson({
      ...item(event, names),
      channel: conversation.channel,
      kind: event.kind,
      ...(conversation.root !== event.id && { thread: conversation.root }),
      ...(mentions.length && { mentions }),
    })}\n</buzz-event>`,
  );
  return parts.join("\n\n");
}

/** The message text without mention links, for Genie. */
export const plainText = (content: string) =>
  content
    .replace(/\[([^\]]*)\]\(nostr:[^)]+\)/g, "")
    .replace(/nostr:(npub|nprofile|note|nevent)1[0-9a-z]+/g, "")
    .replace(/^\s*@\S+\s*/, "")
    .replace(/[ \t]+/g, " ")
    .trim();

/** Splits a long reply into messages under the relay's limit, at paragraph or line breaks. */
export function splitMessage(text: string, maxBytes = MAX_MESSAGE_BYTES): string[] {
  const size = (s: string) => Buffer.byteLength(s);
  if (size(text) <= maxBytes) return [text];
  const out: string[] = [];
  let rest = text;
  while (size(rest) > maxBytes) {
    let cut = maxBytes;
    while (size(rest.slice(0, cut)) > maxBytes) cut = Math.floor(cut * 0.9);
    const window = rest.slice(0, cut);
    const at = Math.max(window.lastIndexOf("\n\n"), window.lastIndexOf("\n"));
    const end = at > cut / 2 ? at : cut;
    out.push(rest.slice(0, end).trimEnd());
    rest = rest.slice(end).trimStart();
  }
  if (rest) out.push(rest);
  return out;
}

/** A reply in the conversation, signed later by the agent. */
export function replyTemplate(input: Readonly<{ conversation: Conversation; content: string; authTag: readonly string[]; notify?: string }>): EventTemplate {
  return {
    kind: 9,
    created_at: Math.floor(Date.now() / 1000),
    content: input.content,
    tags: [
      ["h", input.conversation.channel],
      ...(input.conversation.topLevel ? [] : [["e", input.conversation.root, "", "reply"]]),
      ...(input.notify ? [["p", input.notify]] : []),
      [...input.authTag],
    ],
  };
}

/** The agent's kind 0 profile, attested by its owner. */
export function profileTemplate(input: Readonly<{ name: string; picture?: string; about?: string; authTag: readonly string[] }>): EventTemplate {
  return {
    kind: 0,
    created_at: Math.floor(Date.now() / 1000),
    content: JSON.stringify({ name: input.name, display_name: input.name, bot: true, ...(input.picture && { picture: input.picture }), ...(input.about && { about: input.about }) }),
    tags: [[...input.authTag]],
  };
}
