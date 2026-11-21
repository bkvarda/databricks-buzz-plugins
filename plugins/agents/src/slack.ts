// The Slack bridge's shared pieces, for its Settings tab and its runner: what
// Slack's MCP server (system.ai.slack) answers, as data, and the conventions
// bridges agree on so that several people can bridge the same conversation.
//
//   One Buzz channel per Slack conversation, labeled `slack-<id>` (NIP-CL). A
//   public Slack channel gets an open Buzz channel; a private channel, DM or
//   group DM gets a private one. The oldest labeled channel wins.
//   Every message a bridge sends to Slack ends with FOOTER, so the bridges that
//   read it back link it to the Buzz original instead of posting it again.

export const FOOTER = ":buzzblock:";
/** The `t` tag on a Slack bridge's profile, so bridges find each other. */
export const BRIDGE_TAG = "buzz-slack-bridge";
export const SLACK_TOOLS = "system.ai.slack";
const SLACK_WEB = "https://databricks.enterprise.slack.com";

export type SlackKind = "public" | "private" | "im" | "mpim";
/** A conversation the owner chose to bridge. */
export type SlackConversation = Readonly<{ id: string; name: string; kind: SlackKind }>;
/** A conversation in the owner's Slack, as `slack_list_user_channels` lists it. */
export type SlackListing = SlackConversation & Readonly<{ user?: string; archived?: boolean }>;

export const KIND_LABEL: Record<SlackKind, string> = { public: "Channel", private: "Private channel", im: "DM", mpim: "Group DM" };
export const isPrivateKind = (kind: SlackKind) => kind !== "public";
export const slackLabel = (id: string) => `slack-${id.toLowerCase()}`;
export const permalink = (channel: string, ts: string) => `${SLACK_WEB}/archives/${channel}/p${ts.replace(".", "")}`;

export function tsFromLink(url: string | undefined): string | undefined {
  const found = /\/p(\d{10})(\d{6})(?:\D|$)/.exec(url ?? "");
  return found ? `${found[1]}.${found[2]}` : undefined;
}

export const unfooter = (text: string) => text.replace(new RegExp(`\\s*${FOOTER}\\s*$`), "");
export const hasFooter = (text: string) => new RegExp(`${FOOTER}\\s*$`).test(text);
/** Text compared without case, spacing, punctuation or the footer: what survives a trip through Slack. */
export const norm = (text: string) => unfooter(text ?? "").toLowerCase().replace(/[^0-9a-z]+/g, "");

/** A tool's text, unwrapped from the JSON object some Slack tools answer with. */
export function unwrap(text: string): Record<string, unknown> {
  const trimmed = text.trim();
  if (trimmed.startsWith("{")) {
    try {
      return JSON.parse(trimmed) as Record<string, unknown>;
    } catch {}
  }
  return { result: text, messages: text };
}

const TYPES: Record<string, SlackKind> = { "Public Channel": "public", "Private Channel": "private", "Direct Message": "im", "Group DM": "mpim" };

/** `slack_list_user_channels` (markdown) as conversations, and the next page's cursor. */
export function parseListing(text: string): { conversations: SlackListing[]; cursor?: string } {
  const body = String(unwrap(text).result ?? "");
  const conversations: SlackListing[] = [];
  for (const block of body.split(/^### /m).slice(1)) {
    const title = block.split("\n", 1)[0]!.trim();
    const field = (name: string) => new RegExp(`^- \\*\\*${name}:\\*\\* (.*)$`, "m").exec(block)?.[1]?.trim();
    const id = field("ID");
    const kind = TYPES[field("Type") ?? ""];
    if (!id || !kind) continue;
    const members = (field("Members") ?? "").replace(/^Group messaging with:\s*/, "");
    const name =
      kind === "im" ? title.replace(/^DM with /, "") : kind === "mpim" ? members.replace(/@/g, "") || title : title.replace(/^#/, "");
    const user = field("User ID");
    conversations.push({ id, name, kind, ...(user && { user }), ...(field("Archived") === "Yes" && { archived: true }) });
  }
  const cursor = /Use cursor: "([^"]+)"/.exec(body)?.[1];
  return { conversations, ...(cursor && { cursor }) };
}

/** A group DM's name without its owner, who is in all of them. */
export function groupName(name: string, ownHandle?: string): string {
  if (!ownHandle) return name;
  const others = name.split(/,\s*/).filter((handle) => handle && handle !== ownHandle);
  return others.length ? others.join(", ") : name;
}

/** The owner's handle and name, from `slack_read_user_profile`'s concise answer: "jane.doe (Jane Doe)". */
export function parseProfile(text: string): { handle: string; name: string } | undefined {
  const line = String(unwrap(text).result ?? "").split("\n", 1)[0]!.trim();
  const found = /^(\S+) \((.+)\)$/.exec(line);
  return found ? { handle: found[1]!, name: found[2]! } : line ? { handle: line, name: line } : undefined;
}

const slug = (text: string) =>
  text
    .toLowerCase()
    .replace(/[^0-9a-z]+/g, "-")
    .replace(/^-+|-+$/g, "");

/** The Buzz channel's name for a conversation, from its owner's side. */
export function buzzChannelName(conversation: SlackConversation, own?: { handle: string; name: string }): string {
  const name =
    conversation.kind === "im"
      ? `slack-dm-${slug([own?.name, conversation.name].filter(Boolean).join(" "))}`
      : conversation.kind === "mpim"
        ? `slack-group-${slug(groupName(conversation.name, own?.handle).split(/,\s*/).slice(0, 4).join(" "))}`
        : `slack-${slug(conversation.name)}`;
  return name.slice(0, 64).replace(/-+$/, "");
}

export type SlackMessage = Readonly<{ name: string; user: string; ts: string; when: string; text: string; thread?: Readonly<{ count: number; latest: string }> }>;

const HEAD =
  /=== Message from (?<n1>.*?) \((?<u1>\w+)\) at (?<w1>.*?) === ?\nMessage TS: (?<t1>\d+\.\d+)\n|From: (?<n2>.*?) \((?<u2>\w+)\)\nTime: (?<w2>.*?)\nMessage TS: (?<t2>\d+\.\d+)\n/g;
const END = /\n(?:--- Reply \d+ of \d+ ---|=== THREAD REPLIES.*===|There are no more messages in this thread\.)/;

function messageOf(groups: Record<string, string | undefined>, raw: string): SlackMessage {
  let body = raw;
  const end = END.exec(`\n${body}`);
  if (end) body = end.index ? body.slice(0, Math.max(0, end.index - 1)) : "";
  const name = (groups.n1 ?? groups.n2 ?? "").replace(/\s*<[^>]*>$/, "").trim();
  let thread: SlackMessage["thread"];
  const keep: string[] = [];
  for (const line of body.replace(/\n+$/, "").split("\n")) {
    const replies = /^Thread: (\d+) repl(?:y|ies) \(latest: (.*?)\)/.exec(line);
    if (replies) {
      thread = { count: Number(replies[1]), latest: replies[2]! };
      continue;
    }
    if (/^Reactions: /.test(line)) continue;
    const files = /^Files: (.*)$/.exec(line);
    if (files) {
      keep.push(
        files[1]!
          .split(/(?<=\)), /)
          .map((file) => `📎 ${file.trim().replace(/ \(ID: [^,]*,.*?\)$/, "")}`)
          .join("\n"),
      );
      continue;
    }
    keep.push(line);
  }
  const message = keep
    .join("\n")
    .trim()
    .replace(/\n?\*Sent using\* <@\w+\|[^>]+>\s*$/, "")
    .trim()
    .replace(/ — use slack_read_thread or slack_read_channel to read it in context$/, "");
  return { name, user: groups.u1 ?? groups.u2 ?? "", ts: groups.t1 ?? groups.t2 ?? "", when: groups.w1 ?? groups.w2 ?? "", text: message, ...(thread && { thread }) };
}

/**
 * Messages from `slack_read_channel` or `slack_read_thread` (markdown), oldest
 * first. Slack doesn't escape message text, so a message can hold text that
 * looks like another message's header: these are only a listing, to be checked
 * one by one with `parseOne` before anything is posted.
 */
export function parseMessages(text: string): SlackMessage[] {
  const md = String(unwrap(text).messages ?? "");
  const heads = [...md.matchAll(HEAD)];
  return heads
    .map((head, i) => messageOf(head.groups ?? {}, md.slice(head.index! + head[0].length, i + 1 < heads.length ? heads[i + 1]!.index : md.length)))
    .sort((a, b) => Number(a.ts) - Number(b.ts));
}

/**
 * The one message with this ts, from a read of just the moments around it
 * (`around`): its header is the first with that ts, and the rest of the answer
 * is its text, headers it may contain included. Undefined when Slack has no such
 * message, as for a header someone typed into a message.
 */
export function parseOne(text: string, ts: string): SlackMessage | undefined {
  const md = String(unwrap(text).messages ?? "");
  const head = [...md.matchAll(HEAD)].find((found) => (found.groups?.t1 ?? found.groups?.t2) === ts);
  return head ? messageOf(head.groups ?? {}, md.slice(head.index! + head[0].length)) : undefined;
}

/** `oldest` and `latest` for a read of just the message at ts (Slack's bounds leave themselves out). */
export function around(ts: string): { oldest: string; latest: string } {
  const [seconds, micros = "0"] = ts.split(".");
  const at = BigInt(seconds!) * 1_000_000n + BigInt(micros.padEnd(6, "0").slice(0, 6));
  const format = (value: bigint) => `${value / 1_000_000n}.${String(value % 1_000_000n).padStart(6, "0")}`;
  return { oldest: format(at - 1n), latest: format(at + 1n) };
}

export const isTs = (ts: string) => /^\d{10}\.\d{6}$/.test(ts);

/** Slack mrkdwn as Buzz Markdown. */
export function mrkdwn(text: string): string {
  return text
    .replace(/<@(\w+)\|([^>]+)>/g, "@$2")
    .replace(/<#(\w+)\|([^>]*)>/g, (_, id: string, name: string) => `#${name || id}`)
    .replace(/<!(here|channel|everyone)>/g, "@$1")
    .replace(/<(https?:\/\/[^|>]+)\|([^>]+)>/g, "[$2]($1)")
    .replace(/<(https?:\/\/[^>]+)>/g, "$1")
    .replace(/(?<![\w*])\*(?!\s)([^*\n]+?)(?<!\s)\*(?![\w*])/g, "**$1**")
    .replace(/(?<![\w~])~(?!\s)([^~\n]+?)(?<!\s)~(?![\w~])/g, "~~$1~~")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

/** What a bridge posts for a Slack message: who wrote it, a link to it, and its text. */
export function bridgedContent(message: SlackMessage, link: string, nowSeconds: number): string {
  const late = nowSeconds - Number(message.ts) > 300 && message.when ? `, ${message.when}` : "";
  return `**${message.name}** · [Slack${late}](${link})\n${mrkdwn(message.text) || "_(no text)_"}`;
}

/** A bridged post's message text, without the first line (who wrote it and the link). */
export const bridgedText = (content: string) => content.split("\n").slice(1).join("\n");
