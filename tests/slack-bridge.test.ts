// The Slack bridge: parsing what Slack's MCP server answers, and several
// people's bridges sharing conversations, against an in-memory community that
// keeps channels and members as the relay does, and an in-memory Slack.
import { schnorr } from "@noble/curves/secp256k1.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { type EventTemplate, finalizeEvent, generateSecretKey, getPublicKey, type NostrEvent } from "nostr-tools/pure";
import { afterEach, describe, expect, it, vi } from "vitest";
import { HttpRelay } from "../plugins/agents/runner/http";
import { type BridgeRelay, type BridgeState, HELPER_DELAY_MS, HELPER_TURN_MS, SlackBridge, SlackToolError, STUCK_MS, UNSURE_LIMIT_MS, UNSURE_MS } from "../plugins/agents/runner/slack-bridge";
import { normalizeHosted, runnerConfigOf, summarizeHosted } from "../plugins/agents/src/hosted";
import { loadDirectory } from "../plugins/agents/src/slack-ui";
import type { DatabricksService } from "@dbx/core/service";
import { around, BRIDGE_TAG, buzzChannelName, FOOTER, groupName, headers, mrkdwn, parseListing, parseMessages, parseOne, parseProfile, permalink, type SlackConversation, slackLabel, tsFromLink } from "../plugins/agents/src/slack";
import { matches } from "./fake-relay";

const hex = (bytes: Uint8Array) => Buffer.from(bytes).toString("hex");
const attest = (ownerSecret: Uint8Array, agent: string) => ["auth", getPublicKey(ownerSecret), "", hex(schnorr.sign(sha256(new TextEncoder().encode(`nostr:agent-auth:${agent}:`)), ownerSecret))];

describe("Slack's answers", () => {
  it("lists conversations, with the next page's cursor", () => {
    const text = JSON.stringify({
      result:
        '## My Channels (showing 4, more results available)\n\n### #xyz-account-team\n- **ID:** C07MUHLFC83\n- **Type:** Private Channel\n- **Archived:** No\n\n### DM with Olga Deriy\n- **ID:** D0CK87XNBD4\n- **Type:** Direct Message\n- **User ID:** U07LKRZU736\n- **Archived:** No\n\n### Group DM\n- **ID:** C02H7DN0Y0J\n- **Type:** Group DM\n- **Members:** Group messaging with: @angela.chu, @brandon.kvarda, @michael.simic\n- **Archived:** No\n\n### #general\n- **ID:** C0123456789\n- **Type:** Public Channel\n- **Archived:** No\n\n---\nPagination: More results available. Use cursor: "dHJ1bmM6QzAySEY2Rk5VS1U="\n',
    });
    const { conversations, cursor } = parseListing(text);
    expect(cursor).toBe("dHJ1bmM6QzAySEY2Rk5VS1U=");
    expect(conversations).toEqual([
      { id: "C07MUHLFC83", name: "xyz-account-team", kind: "private" },
      { id: "D0CK87XNBD4", name: "Olga Deriy", kind: "im", user: "U07LKRZU736" },
      { id: "C02H7DN0Y0J", name: "angela.chu, brandon.kvarda, michael.simic", kind: "mpim" },
      { id: "C0123456789", name: "general", kind: "public" },
    ]);
    expect(groupName(conversations[2]!.name, "brandon.kvarda")).toBe("angela.chu, michael.simic");
    expect(parseListing(JSON.stringify({ result: "## My Channels (showing 1 of 1 total)\n\n### #a\n- **ID:** C0AAAAAAA\n- **Type:** Public Channel\n" })).cursor).toBeUndefined();
  });

  it("reads messages: footers stay, Slack's own notes go", () => {
    const text = JSON.stringify({
      messages:
        "Channel: DM (D03919ZRGP4)\n\n=== Message from Brandon Kvarda <brandon.kvarda@databricks.com> (U029YEWF7V2) at 2026-11-20 13:22:54 PST === \nMessage TS: 1795209774.705859\noh yeah i forgot.\n:buzzblock:\n*Sent using* <@U0AM9K925RA|Genie>\n\n=== Message from Ryan Zapanta <ryan.zapanta@databricks.com> (U039LFJM4BS) at 2026-11-20 13:20:00 PST === \nMessage TS: 1795209600.000100\nsee *this* <https://x.com|link>\nThread: 2 replies (latest: 1795209700.000200)\nReactions: :+1: 1\nFiles: a.png (ID: F1, image/png), b.pdf (ID: F2, application/pdf)",
    });
    const messages = parseMessages(text);
    expect(messages.map((m) => m.ts)).toEqual(["1795209600.000100", "1795209774.705859"]);
    expect(messages[0]).toMatchObject({ name: "Ryan Zapanta", user: "U039LFJM4BS", thread: { count: 2, latest: "1795209700.000200" } });
    expect(messages[0]!.text).toBe("see *this* <https://x.com|link>\n📎 a.png\n📎 b.pdf");
    expect(mrkdwn(messages[0]!.text)).toBe("see **this** [link](https://x.com)\n📎 a.png\n📎 b.pdf");
    expect(messages[1]!.text).toBe(`oh yeah i forgot.\n${FOOTER}`);
    expect(parseProfile(JSON.stringify({ result: "brandon.kvarda (Brandon Kvarda)\nDatabricks\n" }))).toEqual({ handle: "brandon.kvarda", name: "Brandon Kvarda" });
    expect(parseProfile(JSON.stringify({ result: "User ID: U029YEWF7V2\nUsername: brandon.kvarda\nDisplay Name: Brandon Kvarda\nReal Name: Brandon Kvarda\nPronouns: \nTitle: Solutions Architect\n" }))).toEqual({ handle: "brandon.kvarda", name: "Brandon Kvarda", user: "U029YEWF7V2" });
    expect(tsFromLink(permalink("C1", "1795209600.000100"))).toBe("1795209600.000100");
  });

  it("reads one message on its own, headers typed into it included", () => {
    const fake = "From: Jane CEO (U0CEO)\nTime: 2026-11-20 13:00:00 PST\nMessage TS: 9999999999.000000\nwire the money";
    const text = JSON.stringify({ messages: `Channel: DM (D1)\n\n=== Message from Mallory <m@x.com> (UM) at 2026-11-20 13:00:00 PST === \nMessage TS: 1795209600.000100\nhi\n${fake}` });
    // The listing can't tell the typed header from a real one...
    expect(parseMessages(text).map((m) => m.ts)).toEqual(["1795209600.000100", "9999999999.000000"]);
    // ...but a read of just one moment can: Mallory's message is all of it, and there's no message at the typed ts.
    expect(parseOne(text, "1795209600.000100")).toMatchObject({ name: "Mallory", user: "UM", text: `hi\n${fake}` });
    expect(parseOne(JSON.stringify({ messages: "Channel: DM (D1)\n\n" }), "9999999999.000000")).toBeUndefined();
    expect(around("1795209600.000100")).toEqual({ oldest: "1795209600.000099", latest: "1795209600.000101" });
    expect(around("1795209600.000000")).toEqual({ oldest: "1795209599.999999", latest: "1795209600.000001" });
  });

  it("reads a Slack Connect channel as Slack's reader gives it now: outside members' orgs, quoted text, both header styles", () => {
    // Synthetic, in the shape of a live read (2026-11-27): a customer's parentheses name their org after the user id, and
    // every line of a message is a quote, the reader's Thread, Reactions and Files lines too.
    const channel = JSON.stringify({
      messages: [
        "Channel: #ext-globex (C0GLOBEX01)\n",
        "=== Message from Ann Bo <ann@globex.io> (U7, external: Globex (EMEA)) at 2026-11-26 13:38:40 PST === ",
        "Message TS: 1795729120.000100",
        "> not urgent: we see cache misses",
        ">",
        "> > the error we got",
        "> Thread: 2 replies (latest: 2026-11-26 14:00:00 PST)",
        "> Reactions: eyes (1)",
        "> Files: repro.txt (ID: F1, text/plain)\n",
        "=== Message from Di Ro <di@example.edu> (U9, external: School of Science (SCS) at Example University) at 2026-11-26 13:49:37 PST === ",
        "Message TS: 1795729777.000200",
        "> here's a repro\n",
        "=== Message from Cy Do <cy@x.com> (U8, some note) at 2026-11-26 13:50:00 PST === ",
        "Message TS: 1795729800.000300",
        "> Shall we ship the fix?",
        "Yes, Friday works.\n",
        "=== Message from Brandon Kvarda <brandon.kvarda@databricks.com> (U029YEWF7V2) at 2026-11-26 13:51:00 PST === ",
        "Message TS: 1795729860.000400",
        "> on it",
        `> ${FOOTER}`,
        "> *Sent using* <@U0AM9K925RA|Genie>",
        "> Reactions: +1 (2)",
      ].join("\n"),
    });
    expect(parseMessages(channel).map((m) => [m.ts, m.name, m.user, m.when, m.text])).toEqual([
      ["1795729120.000100", "Ann Bo", "U7", "2026-11-26 13:38:40 PST", "not urgent: we see cache misses\n\n> the error we got\n📎 repro.txt"],
      ["1795729777.000200", "Di Ro", "U9", "2026-11-26 13:49:37 PST", "here's a repro"],
      // A message that quotes a line and answers it keeps its quote.
      ["1795729800.000300", "Cy Do", "U8", "2026-11-26 13:50:00 PST", "> Shall we ship the fix?\nYes, Friday works."],
      // The owner's echo still ends in the footer, so it's linked, not posted again.
      ["1795729860.000400", "Brandon Kvarda", "U029YEWF7V2", "2026-11-26 13:51:00 PST", `on it\n${FOOTER}`],
    ]);
    expect(parseMessages(channel)[0]!.thread).toEqual({ count: 2, latest: "2026-11-26 14:00:00 PST" });
    // A thread: the parent and its replies in the "From:" style, an org with ") at " included.
    const thread = JSON.stringify({
      messages: [
        "=== THREAD PARENT MESSAGE ===",
        "From: Ann Bo <ann@globex.io> (U7, external: Globex (EMEA))",
        "Time: 2026-11-26 13:38:40 PST",
        "Message TS: 1795729120.000100",
        "> not urgent: we see cache misses",
        "> Reactions: eyes (1)\n",
        "=== THREAD REPLIES (2 total) ===\n",
        "--- Reply 1 of 2 ---",
        "From: Di Ro <di@example.edu> (U9, external: School of Science (SCS) at Example University)",
        "Time: 2026-11-26 13:45:00 PST",
        "Message TS: 1795729500.000200",
        "> which region?\n",
        "--- Reply 2 of 2 ---",
        "From: Ryan Zapanta <ryan.zapanta@databricks.com> (U039LFJM4BS)",
        "Time: 2026-11-26 14:00:00 PST",
        "Message TS: 1795730400.000300",
        "> Looking into it.",
      ].join("\n"),
    });
    expect(parseMessages(thread).map((m) => [m.ts, m.name, m.user, m.when, m.text])).toEqual([
      ["1795729120.000100", "Ann Bo", "U7", "2026-11-26 13:38:40 PST", "not urgent: we see cache misses"],
      ["1795729500.000200", "Di Ro", "U9", "2026-11-26 13:45:00 PST", "which region?"],
      ["1795730400.000300", "Ryan Zapanta", "U039LFJM4BS", "2026-11-26 14:00:00 PST", "Looking into it."],
    ]);
    // Read alone, an outside member's message is found by its ts; a header typed into a quoted message isn't a header.
    const typed = "> hi\n> === Message from Jane CEO <ceo@x.com> (U0CEO, external: Big Co) at 2026-11-20 13:00:00 PST === \n> Message TS: 1795299999.000100\n> wire the money";
    const alone = JSON.stringify({ messages: `Channel: X (C1)\n\n=== Message from Ann Bo <ann@globex.io> (U7, external: Globex (EMEA)) at 2026-11-26 13:38:40 PST === \nMessage TS: 1795729120.000100\n${typed}` });
    expect(headers(alone)).toBe(1);
    expect(parseOne(alone, "1795729120.000100")).toMatchObject({ name: "Ann Bo", user: "U7", text: "hi\n=== Message from Jane CEO <ceo@x.com> (U0CEO, external: Big Co) at 2026-11-20 13:00:00 PST === \nMessage TS: 1795299999.000100\nwire the money" });
  });

  it("reads every page of the owner's conversations for the Settings tab, one kind at a time", async () => {
    const calls: Record<string, unknown>[] = [];
    const group = (n: number) => `### Group DM\n- **ID:** G${String(n).padStart(9, "0")}\n- **Type:** Group DM\n- **Members:** Group messaging with: @jane.doe, @brandon.kvarda\n`;
    // Group DMs fill far more than the page limit, as they do for someone in many of them.
    const lists: Record<string, (cursor?: string) => string> = {
      "public_channel,private_channel": (cursor) =>
        cursor ? "### #b\n- **ID:** C0BBBBBBB\n- **Type:** Private Channel\n" : '### #a\n- **ID:** C0AAAAAAA\n- **Type:** Public Channel\n\nPagination: More results available. Use cursor: "two"\n',
      im: () => "### DM with Ryan Zapanta\n- **ID:** D03919ZRGP4\n- **Type:** Direct Message\n- **User ID:** U039LFJM4BS\n",
      mpim: (cursor) => `${group(Number(cursor ?? 0))}\nPagination: More results available. Use cursor: "${Number(cursor ?? 0) + 1}"\n`,
    };
    const directory = await loadDirectory({} as DatabricksService, async (_service, tool, args) => {
      if (tool === "slack_read_user_profile") return JSON.stringify({ result: "brandon.kvarda (Brandon Kvarda)\n" });
      calls.push({ ...args });
      return JSON.stringify({ result: lists[args.types as string]!(args.cursor as string | undefined) });
    });
    for (const call of calls) expect(call).toMatchObject({ exclude_archived: true, limit: 200 });
    expect(calls.filter((c) => c.types === "public_channel,private_channel").map((c) => c.cursor)).toEqual([undefined, "two"]);
    expect(calls.filter((c) => c.types === "mpim")).toHaveLength(10);
    expect(directory.partial).toBe(true);
    // Channels and DMs are all there, ahead of the group DMs, even though group DMs ran past the limit.
    expect(directory.conversations.slice(0, 4)).toEqual([
      { id: "C0AAAAAAA", name: "a", kind: "public" },
      { id: "C0BBBBBBB", name: "b", kind: "private" },
      { id: "D03919ZRGP4", name: "Ryan Zapanta", kind: "im", user: "U039LFJM4BS" },
      { id: "G000000000", name: "jane.doe", kind: "mpim" },
    ]);
    expect(directory.conversations).toHaveLength(13);
    expect(directory.handle).toBe("brandon.kvarda");
  });

  it("names Buzz channels and labels them by Slack ID", () => {
    const me = { handle: "brandon.kvarda", name: "Brandon Kvarda" };
    expect(buzzChannelName({ id: "C1", name: "xyz-account-team", kind: "private" }, me)).toBe("slack-xyz-account-team");
    expect(buzzChannelName({ id: "D1", name: "Ryan Zapanta", kind: "im" }, me)).toBe("slack-dm-brandon-kvarda-ryan-zapanta");
    expect(buzzChannelName({ id: "C2", name: "angela.chu, brandon.kvarda", kind: "mpim" }, me)).toBe("slack-group-angela-chu");
    expect(slackLabel("C07MUHLFC83")).toBe("slack-c07muhlfc83");
  });

  it("keeps a Slack bridge's settings", () => {
    const config = normalizeHosted({ kind: "slack", availability: "sleep", slack: { conversations: [{ id: "C07MUHLFC83", name: "xyz", kind: "private" }, { id: "nope" }, { id: "C07MUHLFC83", name: "again" }] } });
    expect(config).toMatchObject({ kind: "slack", availability: "always", slack: { conversations: [{ id: "C07MUHLFC83", name: "xyz", kind: "private" }] } });
    // A kind it doesn't know is private, never an open channel.
    expect(normalizeHosted({ kind: "slack", slack: { conversations: [{ id: "C0SOMETHING", name: "x", kind: "weird" }] } }).slack!.conversations[0]!.kind).toBe("private");
    expect(summarizeHosted(config)).toBe("Slack bridge · 1 conversation");
    const runner = runnerConfigOf({ sandbox: "sb", name: "Slack", config, community: "wss://x", owner: "o", authTag: ["auth"], createdAt: 0 });
    expect(runner).toMatchObject({ kind: "slack", availability: "always", slack: { conversations: [{ id: "C07MUHLFC83" }] } });
    expect(normalizeHosted({ kind: "genie" }).slack).toBeUndefined();
  });
});

// ── An in-memory community: channels, members and visibility, as the relay keeps them ──

type Channel = { id: string; name: string; private: boolean; creator: string; createdAt: number; labels: string[]; roles: Map<string, string> };

function community() {
  const events: NostrEvent[] = [];
  const channels = new Map<string, Channel>();
  let clock = 1_800_000_000;
  const meta = (channel: Channel): NostrEvent[] => [
    {
      kind: 39000,
      pubkey: "relay",
      id: `m${channel.id}`,
      sig: "",
      content: "",
      created_at: channel.createdAt,
      tags: [["d", channel.id], ["name", channel.name], ...(channel.private ? [["private"]] : [["public"]]), ["t", "stream"], ...channel.labels.map((label) => ["t", label]), ["P", channel.creator], ["created_at", String(channel.createdAt)]],
    },
    { kind: 39002, pubkey: "relay", id: `r${channel.id}`, sig: "", content: "", created_at: channel.createdAt, tags: [["d", channel.id], ...[...channel.roles].map(([pubkey, role]) => ["p", pubkey, "", role])] },
  ];
  const visible = (viewer: string, event: NostrEvent) => {
    const channel = channels.get(event.tags.find((tag) => tag[0] === "h" || tag[0] === "d")?.[1] ?? "");
    return !channel || !channel.private || channel.roles.has(viewer);
  };
  const agents = new Set<string>();
  // The relay answers a refusal with accepted:false; an outage (a rate limit) isn't an answer.
  const refuse = (message: string) => Object.assign(new Error(message), { refused: true });
  let outages = 0;
  let failing: ((event: NostrEvent) => boolean) | undefined;
  const relayFor = (secret: Uint8Array, authTag?: string[]): BridgeRelay & { pubkey: string } => {
    const pubkey = getPublicKey(secret);
    if (authTag) agents.add(pubkey);
    return {
      pubkey,
      async publish(template: EventTemplate) {
        const event = finalizeEvent({ ...template, created_at: Math.max(template.created_at, ++clock), tags: [...template.tags, ...(authTag ? [authTag] : [])] }, secret);
        const h = event.tags.find((tag) => tag[0] === "h")?.[1] ?? "";
        const channel = channels.get(h);
        const role = channel?.roles.get(pubkey);
        if (event.kind === 9 && authTag && failing?.(event)) throw Object.assign(new Error("503 unavailable"), { status: 503 });
        if (event.kind === 9 && authTag && outages > 0) {
          outages--;
          throw Object.assign(new Error("429 rate limited"), { status: 429 });
        }
        if (event.kind === 9007) {
          channels.set(h, {
            id: h,
            name: event.tags.find((t) => t[0] === "name")![1]!,
            private: event.tags.some((t) => t[0] === "visibility" && t[1] === "private"),
            creator: pubkey,
            createdAt: event.created_at,
            labels: event.tags.filter((t) => t[0] === "t").map((t) => t[1]!),
            roles: new Map([[pubkey, "owner"]]),
          });
        } else if (event.kind === 9000) {
          if (role !== "owner" && role !== "admin") throw refuse("restricted: not an admin");
          const [, who, , as] = event.tags.find((t) => t[0] === "p")!;
          // The relay keeps an agent's ordinary role as `bot`.
          channel!.roles.set(who!, as === "member" && agents.has(who!) ? "bot" : as!);
        } else if (event.kind === 9021) {
          if (!channel || channel.private) throw refuse("restricted: private");
          channel.roles.set(pubkey, authTag ? "bot" : "member");
        } else if (event.kind === 9) {
          if (!role) throw refuse("restricted: not a member");
          events.push(event);
        } else events.push(event);
        return event;
      },
      async query(filters) {
        const all = [...events, ...[...channels.values()].flatMap(meta)];
        return filters.flatMap((filter) =>
          all
            .filter((event) => matches(event, filter as Record<string, unknown>) && visible(pubkey, event))
            .sort((a, b) => b.created_at - a.created_at)
            .slice(0, typeof filter.limit === "number" ? filter.limit : undefined),
        );
      },
    };
  };
  return { events, channels, relayFor, failNextPosts: (count: number) => (outages = count), failPostsWhere: (when?: (event: NostrEvent) => boolean) => (failing = when), posts: (channel: string) => events.filter((e) => e.kind === 9 && e.tags.some((t) => t[0] === "h" && t[1] === channel)) };
}

// ── An in-memory Slack ──

type SlackMsg = { ts: string; user: string; name: string; text: string; replies: SlackMsg[] };

/**
 * `live`: answer as Slack's reader does now (2026-11-27): a Slack Connect
 * member's parentheses name their org (`orgs`), every line of a message's text
 * is a quote, its Thread and Reactions lines too, and a thread's replies come in
 * the "From:" style under the reader's own separators.
 */
function slackWorld(live?: { orgs: Record<string, string>; names: Record<string, string> }) {
  const conversations = new Map<string, SlackMsg[]>();
  let ts = 1_795_200_000;
  const next = () => `${++ts}.000100`;
  const say = (conversation: string, user: string, text: string, thread?: string) => {
    const message = { ts: next(), user, name: live?.names[user] ?? (user === "UB" ? "Brandon Kvarda" : user === "UR" ? "Ryan Zapanta" : "Someone"), text, replies: [] };
    const list = conversations.get(conversation) ?? [];
    conversations.set(conversation, list);
    if (thread) list.find((m) => m.ts === thread)!.replies.push(message);
    else list.push(message);
    return message.ts;
  };
  const who = (m: SlackMsg) => `${m.name} <x@y.com> (${m.user}${live?.orgs[m.user] ? `, external: ${live.orgs[m.user]}` : ""})`;
  const quote = (text: string) => text.split("\n").map((line) => (line ? `> ${line}` : ">")).join("\n");
  const thread = (m: SlackMsg) => (m.replies.length ? `Thread: ${m.replies.length} replies (latest: ${m.replies.at(-1)!.ts})` : "");
  const body = (m: SlackMsg, lines: string[]) => {
    const text = [m.text, ...lines.filter(Boolean)].join("\n");
    return live ? `${quote(`${text}\nReactions: eyes (1)`)}\n` : `${text}\n`;
  };
  const head = (m: SlackMsg, lines: string[] = []) => `=== Message from ${who(m)} at 2026-11-20 13:00:00 PST === \nMessage TS: ${m.ts}\n${body(m, lines)}`;
  const from = (m: SlackMsg) => `From: ${who(m)}\nTime: 2026-11-20 13:00:00 PST\nMessage TS: ${m.ts}\n${body(m, [])}`;
  const sends: { as: string; channel: string; text: string; thread?: string }[] = [];
  const reads: Record<string, unknown>[] = [];
  let failSends = 0;
  let timeouts: ("before" | "after")[] = [];
  const as = (user: string, member: (id: string) => boolean = () => true) => async (tool: string, args: Readonly<Record<string, unknown>>): Promise<string> => {
    const id = String(args.channel_id ?? "");
    if (id && !member(id)) throw new Error("channel_not_found");
    const list = conversations.get(id) ?? [];
    // The detailed answer, as Slack gives it without `response_format`.
    if (tool === "slack_read_user_profile") {
      const [handle, name] = user === "UB" ? ["brandon.kvarda", "Brandon Kvarda"] : user === "UR" ? ["ryan.zapanta", "Ryan Zapanta"] : ["someone", "Someone"];
      return JSON.stringify({ result: `User ID: ${user}\nUsername: ${handle}\nDisplay Name: ${name}\nReal Name: ${name}\nTitle: \nBot: No\n` });
    }
    reads.push({ tool, ...args });
    // Slack's bounds leave themselves out; with `oldest`, the oldest `limit` after it, otherwise the latest.
    const inside = (m: SlackMsg) => (args.oldest === undefined || Number(m.ts) > Number(args.oldest)) && (args.latest === undefined || Number(m.ts) < Number(args.latest));
    const pick = (all: SlackMsg[]) => {
      const limit = Number(args.limit ?? 100);
      const found = all.filter(inside);
      return args.oldest !== undefined ? found.slice(0, limit) : found.slice(-limit);
    };
    if (tool === "slack_read_channel")
      return JSON.stringify({ messages: `Channel: X (${id})\n\n${pick(list).reverse().map((m) => head(m, [thread(m)])).join("\n")}` });
    if (tool === "slack_read_thread") {
      const parent = list.find((m) => m.ts === args.message_ts)!;
      const replies = pick(parent.replies);
      if (!live) return JSON.stringify({ messages: [parent, ...replies].map((m) => head(m)).join("\n") });
      return JSON.stringify({
        messages: `=== THREAD PARENT MESSAGE ===\n${from(parent)}\n=== THREAD REPLIES (${replies.length} total) ===\n${replies.map((m, i) => `\n--- Reply ${i + 1} of ${replies.length} ---\n${from(m)}`).join("")}`,
      });
    }
    if (tool === "slack_send_message") {
      if (failSends > 0) {
        failSends--;
        throw new SlackToolError("ratelimited");
      }
      const timeout = timeouts.shift();
      if (timeout === "before") throw new Error("timed out");
      const text = `${String(args.message)}\n*Sent using* <@U0AM9K925RA|Genie>`;
      sends.push({ as: user, channel: id, text: String(args.message), ...(args.thread_ts ? { thread: String(args.thread_ts) } : {}) });
      const sent = say(id, user, text, args.thread_ts ? String(args.thread_ts) : undefined);
      if (timeout === "after") throw new Error("timed out");
      return JSON.stringify({ message_context: { message_ts: sent } });
    }
    throw new Error(`no tool ${tool}`);
  };
  return { conversations, say, as, sends, reads, failNextSends: (count: number) => (failSends = count), timeOutNextSends: (...when: ("before" | "after")[]) => (timeouts = when) };
}

function person(world: ReturnType<typeof community>, slack: (tool: string, args: Readonly<Record<string, unknown>>) => Promise<string>, conversations: SlackConversation[], clock: { now: number }, wrap: (relay: BridgeRelay) => BridgeRelay = (relay) => relay) {
  const ownerSecret = generateSecretKey();
  const botSecret = generateSecretKey();
  const owner = getPublicKey(ownerSecret);
  const human = world.relayFor(ownerSecret);
  const bot = world.relayFor(botSecret, attest(ownerSecret, getPublicKey(botSecret)));
  const state: BridgeState = { conversations: {} };
  const logs: string[] = [];
  const bridge = new SlackBridge({ relay: wrap(bot), slack, pubkey: bot.pubkey, owner, conversations, state, save: () => {}, log: (line) => logs.push(line), now: () => clock.now });
  // Its profile, as the runner publishes it, so other bridges know it for one.
  void bot.publish({ kind: 0, created_at: 0, content: JSON.stringify({ name: "Slack bridge" }), tags: [["t", BRIDGE_TAG]] });
  return { owner, human, bot, state, bridge, logs };
}

describe("Slack bridges sharing conversations", () => {
  const general: SlackConversation = { id: "C0GENERAL1", name: "general", kind: "public" };

  it("shares a public channel: one posts, the other fills in when it's asleep, and nobody echoes", async () => {
    const world = community();
    const slack = slackWorld();
    for (let i = 0; i < 7; i++) slack.say(general.id, "US", `old ${i}`);
    const clock = { now: Date.UTC(2027, 0, 1) };
    const brandon = person(world, slack.as("UB"), [general], clock);
    const ryan = person(world, slack.as("UR"), [general], clock);

    await brandon.bridge.tick();
    const channel = brandon.state.conversations[general.id]!.buzz!;
    expect(world.channels.get(channel)).toMatchObject({ private: false, name: "slack-general", labels: [slackLabel(general.id)] });
    expect(world.channels.get(channel)!.roles.get(brandon.owner)).toBe("admin");
    // The latest five, not the whole history.
    expect(world.posts(channel).map((e) => e.content.split("\n")[1])).toEqual(["old 2", "old 3", "old 4", "old 5", "old 6"]);

    await ryan.bridge.tick();
    expect(ryan.state.conversations[general.id]).toMatchObject({ buzz: channel, primary: false, ownerIn: false });
    expect(world.channels.get(channel)!.roles.get(ryan.bot.pubkey)).toBe("bot");
    expect(world.posts(channel)).toHaveLength(5);

    // Brandon's bridge is up: it posts; Ryan's waits, then finds it there.
    slack.say(general.id, "US", "new one");
    await ryan.bridge.tick();
    await brandon.bridge.tick();
    clock.now += HELPER_DELAY_MS + 1000;
    await ryan.bridge.tick();
    expect(world.posts(channel).filter((e) => e.content.endsWith("new one"))).toHaveLength(1);
    expect(world.posts(channel).find((e) => e.content.endsWith("new one"))!.pubkey).toBe(brandon.bot.pubkey);

    // Brandon's bridge is asleep: Ryan's posts after two minutes, and Brandon's doesn't post it again.
    slack.say(general.id, "US", "while asleep");
    await ryan.bridge.tick();
    expect(world.posts(channel).filter((e) => e.content.endsWith("while asleep"))).toHaveLength(0);
    clock.now += HELPER_DELAY_MS + 1000;
    await ryan.bridge.tick();
    await brandon.bridge.tick();
    const asleep = world.posts(channel).filter((e) => e.content.endsWith("while asleep"));
    expect(asleep.map((e) => e.pubkey)).toEqual([ryan.bot.pubkey]);
    expect(asleep[0]!.tags).toContainEqual(["r", expect.stringContaining(`/archives/${general.id}/p`)]);

    // Ryan joins and writes in Buzz: his bridge sends it as him; it comes back from Slack and nobody posts it again.
    await ryan.human.publish({ kind: 9021, created_at: 0, content: "", tags: [["h", channel]] });
    const said = await ryan.human.publish({ kind: 9, created_at: 0, content: "hello from Buzz!", tags: [["h", channel]] });
    await ryan.bridge.tick();
    expect(slack.sends).toEqual([{ as: "UR", channel: general.id, text: `hello from Buzz!\n${FOOTER}` }]);
    clock.now += HELPER_DELAY_MS + 1000;
    await brandon.bridge.tick();
    await ryan.bridge.tick();
    expect(world.posts(channel).filter((e) => e.content.includes("hello from Buzz"))).toEqual([said]);
    // Brandon's bridge linked the Slack copy to Ryan's message, so a Slack reply to it lands in its thread.
    const sentTs = slack.conversations.get(general.id)!.at(-1)!.ts;
    expect(brandon.state.conversations[general.id]!.posted[sentTs]).toBe(said.id);
    slack.say(general.id, "US", "a reply in Slack", sentTs);
    await brandon.bridge.tick();
    const reply = world.posts(channel).find((e) => e.content.endsWith("a reply in Slack"))!;
    expect(reply.tags).toContainEqual(["e", said.id, "", "reply"]);

    // Brandon replies in Buzz under a bridged message: it goes to the Slack thread. "//" and talking to an agent stay in Buzz.
    const parent = world.posts(channel).find((e) => e.content.endsWith("new one"))!;
    await brandon.human.publish({ kind: 9, created_at: 0, content: "threaded", tags: [["h", channel], ["e", parent.id, "", "reply"]] });
    await brandon.human.publish({ kind: 9, created_at: 0, content: "// just Buzz", tags: [["h", channel]] });
    await brandon.human.publish({ kind: 9, created_at: 0, content: "@bot do it", tags: [["h", channel], ["p", ryan.bot.pubkey]] });
    // A reply under a Buzz message the bridge never saw: flip the first hex digit, so the id differs from said.id even when it starts with "0".
    const missingParent = `${said.id[0] === "0" ? "1" : "0"}${said.id.slice(1)}`;
    expect(world.posts(channel).some((e) => e.id === missingParent)).toBe(false);
    await brandon.human.publish({ kind: 9, created_at: 0, content: "a Buzz thread", tags: [["h", channel], ["e", missingParent, "", "reply"]] });
    await brandon.bridge.tick();
    expect(slack.sends.slice(1)).toEqual([{ as: "UB", channel: general.id, text: `threaded\n${FOOTER}`, thread: tsFromLink(parent.tags.find((t) => t[0] === "r")![1]) }]);
    // Its own message, back from Slack in the thread, isn't posted again.
    await brandon.bridge.tick();
    expect(world.posts(channel).filter((e) => e.content.includes("threaded"))).toHaveLength(1);
  });

  it("keeps DMs private: each person's own channel, never a stranger's, and Buzz messages reach the other side", async () => {
    const world = community();
    const slack = slackWorld();
    const dm: SlackConversation = { id: "D0BRANDONRYAN", name: "Ryan Zapanta", kind: "im" };
    slack.say(dm.id, "UR", "secret plans");
    const known = slack.say(dm.id, "UB", "sounds good");
    const clock = { now: Date.UTC(2027, 0, 1) };
    // Mallory isn't in the DM; her channel, labeled for it, is the oldest, with a correct copy of a message, and she adds Ryan's bridge.
    const mallory = person(world, slack.as("UM", () => false), [], clock);
    const decoy = "decoy-channel";
    await mallory.bot.publish({ kind: 9007, created_at: 0, content: "", tags: [["h", decoy], ["name", "slack-dm"], ["visibility", "private"], ["t", slackLabel(dm.id)]] });
    await mallory.bot.publish({ kind: 9, created_at: 0, content: `**Brandon Kvarda** · [Slack](${permalink(dm.id, known)})\nsounds good`, tags: [["h", decoy], ["r", permalink(dm.id, known)]] });
    const brandon = person(world, slack.as("UB"), [dm], clock);
    const ryan = person(world, slack.as("UR"), [dm], clock);
    await mallory.bot.publish({ kind: 9000, created_at: 0, content: "", tags: [["h", decoy], ["p", ryan.bot.pubkey, "", "member"]] });

    await brandon.bridge.tick();
    await ryan.bridge.tick();
    const brandons = brandon.state.conversations[dm.id]!.buzz!;
    const ryans = ryan.state.conversations[dm.id]!.buzz!;
    expect(new Set([brandons, ryans, decoy]).size).toBe(3);
    expect(world.channels.get(brandons)).toMatchObject({ private: true, name: "slack-dm-brandon-kvarda-ryan-zapanta" });
    expect([...world.channels.get(brandons)!.roles.keys()].sort()).toEqual([brandon.bot.pubkey, brandon.owner].sort());
    expect([...world.channels.get(ryans)!.roles.keys()].sort()).toEqual([ryan.bot.pubkey, ryan.owner].sort());
    expect(world.posts(brandons).map((e) => e.content.split("\n")[1])).toEqual(["secret plans", "sounds good"]);
    expect(world.posts(decoy)).toHaveLength(1);

    // Ryan writes in his Buzz channel: it goes to Slack as him, and shows up in Brandon's channel like any Slack message.
    const said = await ryan.human.publish({ kind: 9, created_at: 0, content: "from Ryan's Buzz", tags: [["h", ryans]] });
    await ryan.bridge.tick();
    await brandon.bridge.tick();
    await ryan.bridge.tick();
    expect(slack.sends).toEqual([{ as: "UR", channel: dm.id, text: `from Ryan's Buzz\n${FOOTER}` }]);
    expect(world.posts(brandons).at(-1)!.content).toMatch(/^\*\*Ryan Zapanta\*\* · \[Slack[^\]]*\]\(.*\)\nfrom Ryan's Buzz$/);
    // In Ryan's own channel it's linked, not posted again.
    expect(world.posts(ryans).filter((e) => e.content.includes("from Ryan's Buzz"))).toEqual([said]);
  });

  it("bridges a Slack Connect channel in the reader's live format: customers' messages and thread replies, the owner's echoes linked", async () => {
    const world = community();
    const slack = slackWorld({ orgs: { UK: "Globex (EMEA)", UJ: "School of Science (SCS) at Example University" }, names: { UK: "Kai Wu", UJ: "Jo Lin" } });
    const shared: SlackConversation = { id: "C0GLOBEX01", name: "ext-globex", kind: "private" };
    slack.say(shared.id, "UK", "before");
    const clock = { now: Date.UTC(2027, 0, 1) };
    const brandon = person(world, slack.as("UB"), [shared], clock);
    await brandon.bridge.tick();
    const channel = brandon.state.conversations[shared.id]!.buzz!;
    // A customer's message: posted once, unquoted, without the reader's Reactions line.
    const asked = slack.say(shared.id, "UK", "we see cache misses\n\nis this a tuning thing?");
    await brandon.bridge.tick();
    const posts = () => world.posts(channel);
    const question = posts().find((e) => e.tags.some((t) => t[0] === "r" && t[1] === permalink(shared.id, asked)))!;
    expect(question.content).toMatch(/^\*\*Kai Wu\*\* · \[Slack[^\]]*\]\([^)]*\)\nwe see cache misses\n\nis this a tuning thing\?$/);
    // Another org's reply in its thread (the "From:" style, an org with ") at "): found from the quoted Thread line, posted under it.
    slack.say(shared.id, "UJ", "which region?", asked);
    await brandon.bridge.tick();
    const reply = posts().find((e) => e.content.endsWith("\nwhich region?"))!;
    expect(reply.content).toMatch(/^\*\*Jo Lin\*\* · /);
    expect(reply.tags).toContainEqual(["e", question.id, "", "reply"]);
    // Brandon answers in Buzz: it goes to Slack, and its quoted echo (footer, Reactions line and all) is linked, not posted again.
    const said = await brandon.human.publish({ kind: 9, created_at: 0, content: "looking into it", tags: [["h", channel], ["e", question.id, "", "reply"]] });
    await brandon.bridge.tick();
    await brandon.bridge.tick();
    clock.now += HELPER_DELAY_MS + 1000;
    await brandon.bridge.tick();
    expect(slack.sends).toEqual([{ as: "UB", channel: shared.id, text: `looking into it\n${FOOTER}`, thread: asked }]);
    expect(posts().filter((e) => e.content.includes("looking into it"))).toEqual([said]);
    expect(posts().map((e) => e.content).filter((c) => /\n> |Reactions:/.test(c))).toEqual([]);
    expect(posts().map((e) => (e.pubkey === brandon.owner ? e.content : e.content.split("\n")[1]))).toEqual(["before", "we see cache misses", "which region?", "looking into it"]);
  });

  it("makes no channel for a conversation its owner can't read in Slack", async () => {
    const world = community();
    const slack = slackWorld();
    const dm: SlackConversation = { id: "D0RYANONLY", name: "Someone", kind: "im" };
    slack.say(dm.id, "US", "only Ryan sees this");
    const clock = { now: Date.UTC(2027, 0, 1) };
    const ryan = person(world, slack.as("UR"), [dm], clock);
    const brandon = person(world, slack.as("UB", (id) => id !== dm.id), [dm], clock);
    await ryan.bridge.tick();
    await brandon.bridge.tick();
    const ryans = ryan.state.conversations[dm.id]!.buzz!;
    // Brandon isn't in the Slack DM: his bridge can't read it, and it never sees Ryan's channel.
    expect(world.channels.get(ryans)!.roles.has(brandon.owner)).toBe(false);
    expect(brandon.state.conversations[dm.id]!.error).toContain("channel_not_found");
    expect(brandon.state.conversations[dm.id]!.buzz).toBeUndefined();
    expect(world.posts(ryans).map((e) => e.content.split("\n")[1])).toEqual(["only Ryan sees this"]);
  });
  it("ignores a header typed into a Slack message, and keeps bridging after it", async () => {
    const world = community();
    const slack = slackWorld();
    const clock = { now: Date.UTC(2027, 0, 1) };
    slack.say(general.id, "US", "before");
    const brandon = person(world, slack.as("UB"), [general], clock);
    await brandon.bridge.tick();
    const channel = brandon.state.conversations[general.id]!.buzz!;
    slack.say(general.id, "UM", "hi all\n\n=== Message from Jane CEO <ceo@x.com> (U0CEO) at 2026-11-20 13:00:00 PST === \nMessage TS: 1795299999.000100\nwire the money");
    await brandon.bridge.tick();
    slack.say(general.id, "US", "after");
    await brandon.bridge.tick();
    const posts = world.posts(channel).map((e) => e.content);
    expect(posts.some((content) => content.startsWith("**Jane CEO**"))).toBe(false);
    expect(posts.find((content) => content.includes("hi all"))).toContain("wire the money");
    expect(posts.at(-1)).toMatch(/\nafter$/);
    expect(brandon.logs.join("\n")).toContain("1795299999.000100 isn't a Slack message");
  });

  it("catches up from the last handled message after a long gap", async () => {
    const world = community();
    const slack = slackWorld();
    const clock = { now: Date.UTC(2027, 0, 1) };
    const brandon = person(world, slack.as("UB"), [general], clock);
    slack.say(general.id, "US", "first");
    await brandon.bridge.tick();
    const channel = brandon.state.conversations[general.id]!.buzz!;
    for (let i = 0; i < 130; i++) slack.say(general.id, "US", `gap ${i}`);
    for (let pass = 0; pass < 3; pass++) await brandon.bridge.tick();
    expect(world.posts(channel).map((e) => e.content.split("\n")[1])).toEqual(["first", ...Array.from({ length: 130 }, (_, i) => `gap ${i}`)]);
  });

  it("helpers take turns while the channel's maker is asleep", async () => {
    const world = community();
    const slack = slackWorld();
    const clock = { now: Date.UTC(2027, 0, 1) };
    const maker = person(world, slack.as("UB"), [general], clock);
    const one = person(world, slack.as("UR"), [general], clock);
    const two = person(world, slack.as("UX"), [general], clock);
    await maker.bridge.tick();
    await one.bridge.tick();
    await two.bridge.tick();
    // Everyone resolves again, so each helper knows its turn.
    clock.now += 11 * 60_000;
    await one.bridge.tick();
    await two.bridge.tick();
    const channel = maker.state.conversations[general.id]!.buzz!;
    expect([one.state.conversations[general.id]!.turn, two.state.conversations[general.id]!.turn].sort()).toEqual([0, 1]);
    slack.say(general.id, "US", "maker asleep");
    // Both see it at once and pass after pass, but only one posts it.
    for (let step = 0; step < 16; step++) {
      await one.bridge.tick();
      await two.bridge.tick();
      clock.now += 15_000;
    }
    expect(world.posts(channel).filter((e) => e.content.endsWith("maker asleep"))).toHaveLength(1);
  });

  it("marks a send before it goes, and tries a refused one again", async () => {
    const world = community();
    const slack = slackWorld();
    const clock = { now: Date.UTC(2027, 0, 1) };
    const brandon = person(world, slack.as("UB"), [general], clock);
    await brandon.bridge.tick();
    const channel = brandon.state.conversations[general.id]!.buzz!;
    slack.failNextSends(1);
    await brandon.human.publish({ kind: 9, created_at: 0, content: "try me", tags: [["h", channel]] });
    await brandon.bridge.tick();
    expect(slack.sends).toHaveLength(0);
    await brandon.bridge.tick();
    expect(slack.sends.map((send) => send.text)).toEqual([`try me\n${FOOTER}`]);
    // A restart mid-send leaves the mark: it isn't sent again.
    const pending = await brandon.human.publish({ kind: 9, created_at: 0, content: "in flight", tags: [["h", channel]] });
    brandon.state.conversations[general.id]!.out!.sent[pending.id] = "";
    await brandon.bridge.tick();
    expect(slack.sends).toHaveLength(1);
  });

  it("doesn't trust a Slack link on a message no bridge posted", async () => {
    const world = community();
    const slack = slackWorld();
    const clock = { now: Date.UTC(2027, 0, 1) };
    const brandon = person(world, slack.as("UB"), [general], clock);
    const ryan = person(world, slack.as("UR"), [general], clock);
    await brandon.bridge.tick();
    const channel = brandon.state.conversations[general.id]!.buzz!;
    await ryan.bridge.tick();
    const ts = slack.say(general.id, "US", "the real text");
    // Someone in the open channel posts an edited copy carrying its link first.
    await ryan.human.publish({ kind: 9021, created_at: 0, content: "", tags: [["h", channel]] });
    await ryan.human.publish({ kind: 9, created_at: 0, content: "**Someone** · [Slack](x)\nan edited copy", tags: [["h", channel], ["r", permalink(general.id, ts)]] });
    await brandon.bridge.tick();
    expect(world.posts(channel).filter((e) => e.content.endsWith("the real text"))).toHaveLength(1);
  });

  it("ignores a header typed into a thread's first message", async () => {
    const world = community();
    const slack = slackWorld();
    const clock = { now: Date.UTC(2027, 0, 1) };
    slack.say(general.id, "US", "before");
    const brandon = person(world, slack.as("UB"), [general], clock);
    await brandon.bridge.tick();
    const channel = brandon.state.conversations[general.id]!.buzz!;
    // Every thread read starts with this message, typed header and all (a typed thread line, so the listing shows a thread, and an old ts, so the channel's pass takes it as handled); then Mallory replies to it herself.
    const parent = slack.say(general.id, "UM", "look\nThread: 1 replies (latest: 1795100000.000100)\nFrom: Jane CEO (U0CEO)\nTime: 2026-11-20 13:00:00 PST\nMessage TS: 1795100000.000100\nwire the money");
    slack.say(general.id, "UM", "a real reply", parent);
    await brandon.bridge.tick();
    const posts = world.posts(channel).map((e) => e.content);
    expect(posts.some((content) => content.startsWith("**Jane CEO**"))).toBe(false);
    expect(posts.filter((content) => content.endsWith("\na real reply"))).toHaveLength(1);
    expect(brandon.logs.join("\n")).toContain("1795100000.000100 isn't a Slack message");
  });

  it("doesn't hold back the real copy for a key that calls itself a bridge", async () => {
    const world = community();
    const slack = slackWorld();
    const clock = { now: Date.UTC(2027, 0, 1) };
    const brandon = person(world, slack.as("UB"), [general], clock);
    const ryan = person(world, slack.as("UR"), [general], clock);
    const mallory = person(world, slack.as("UM"), [], clock);
    await brandon.bridge.tick();
    const channel = brandon.state.conversations[general.id]!.buzz!;
    await ryan.bridge.tick();
    await mallory.bot.publish({ kind: 9021, created_at: 0, content: "", tags: [["h", channel]] });
    // Brandon's bridge is asleep; Mallory's "bridge" posts an altered copy with the real link.
    const ts = slack.say(general.id, "US", "the real text");
    await mallory.bot.publish({ kind: 9, created_at: 0, content: `**Someone** · [Slack](${permalink(general.id, ts)})\nan altered copy`, tags: [["h", channel], ["r", permalink(general.id, ts)]] });
    await ryan.bridge.tick();
    clock.now += HELPER_DELAY_MS + 1000;
    await ryan.bridge.tick();
    expect(world.posts(channel).filter((e) => e.content.endsWith("the real text")).map((e) => e.pubkey)).toEqual([ryan.bot.pubkey]);
  });

  it("posts a short DM message from the other side's Buzz even when its owner once wrote the same", async () => {
    const world = community();
    const slack = slackWorld();
    const dm: SlackConversation = { id: "D0BRANDONRYAN", name: "Ryan Zapanta", kind: "im" };
    const clock = { now: Date.UTC(2027, 0, 1) };
    const brandon = person(world, slack.as("UB"), [dm], clock);
    const ryan = person(world, slack.as("UR"), [dm], clock);
    slack.say(dm.id, "UR", "hi");
    await brandon.bridge.tick();
    await ryan.bridge.tick();
    const brandons = brandon.state.conversations[dm.id]!.buzz!;
    const ryans = ryan.state.conversations[dm.id]!.buzz!;
    const mine = await brandon.human.publish({ kind: 9, created_at: 0, content: "ok", tags: [["h", brandons]] });
    await brandon.bridge.tick();
    await brandon.bridge.tick();
    await ryan.bridge.tick();
    await ryan.human.publish({ kind: 9, created_at: 0, content: "ok", tags: [["h", ryans]] });
    await ryan.bridge.tick();
    await brandon.bridge.tick();
    expect(slack.sends.map((send) => send.as)).toEqual(["UB", "UR"]);
    // Brandon's own "ok" is linked once; Ryan's arrives in Brandon's channel as Ryan's.
    const oks = world.posts(brandons).filter((e) => /\nok$|^ok$/.test(e.content));
    expect(oks.map((e) => (e.id === mine.id ? "mine" : e.content.split(" ")[0]))).toEqual(["mine", "**Ryan"]);
  });

  it("doesn't send twice after a timeout, and sends again one that never went", async () => {
    const world = community();
    const slack = slackWorld();
    const clock = { now: Date.UTC(2027, 0, 1) };
    const brandon = person(world, slack.as("UB"), [general], clock);
    await brandon.bridge.tick();
    const channel = brandon.state.conversations[general.id]!.buzz!;
    // It went out, but no answer came: the copy from Slack is linked to it.
    slack.timeOutNextSends("after");
    const went = await brandon.human.publish({ kind: 9, created_at: 0, content: "went anyway", tags: [["h", channel]] });
    await brandon.bridge.tick();
    await brandon.bridge.tick();
    clock.now += UNSURE_MS + 1000;
    await brandon.bridge.tick();
    expect(slack.sends.map((send) => send.text)).toEqual([`went anyway\n${FOOTER}`]);
    expect(world.posts(channel).filter((e) => e.content.includes("went anyway"))).toEqual([went]);
    // It never went: after a while it's sent again, once.
    slack.timeOutNextSends("before");
    await brandon.human.publish({ kind: 9, created_at: 0, content: "never went", tags: [["h", channel]] });
    await brandon.bridge.tick();
    await brandon.bridge.tick();
    expect(slack.sends).toHaveLength(1);
    clock.now += UNSURE_MS + 1000;
    await brandon.bridge.tick();
    await brandon.bridge.tick();
    expect(slack.sends.map((send) => send.text)).toEqual([`went anyway\n${FOOTER}`, `never went\n${FOOTER}`]);
  });

  it("keeps Slack messages for the next pass when the community doesn't answer", async () => {
    const world = community();
    const slack = slackWorld();
    const clock = { now: Date.UTC(2027, 0, 1) };
    const brandon = person(world, slack.as("UB"), [general], clock);
    await brandon.bridge.tick();
    const channel = brandon.state.conversations[general.id]!.buzz!;
    slack.say(general.id, "US", "one");
    slack.say(general.id, "US", "two");
    world.failNextPosts(3);
    for (let pass = 0; pass < 3; pass++) await brandon.bridge.tick();
    expect(world.posts(channel)).toHaveLength(0);
    expect(brandon.state.conversations[general.id]!.error).toContain("429");
    await brandon.bridge.tick();
    expect(world.posts(channel).map((e) => e.content.split("\n")[1])).toEqual(["one", "two"]);
    expect(brandon.logs.join("\n")).not.toContain("gave up");
  });

  it("makes no private channel until it knows the community's key", async () => {
    const world = community();
    const slack = slackWorld();
    const dm: SlackConversation = { id: "D0BRANDONRYAN", name: "Ryan Zapanta", kind: "im" };
    const clock = { now: Date.UTC(2027, 0, 1) };
    const brandon = person(world, slack.as("UB"), [dm], clock);
    let key: string | undefined;
    const state: BridgeState = { conversations: {} };
    const bridge = new SlackBridge({ relay: brandon.bot, slack: slack.as("UB"), pubkey: brandon.bot.pubkey, owner: brandon.owner, relayKey: async () => key, conversations: [dm, general], state, save: () => {}, log: () => {}, now: () => clock.now });
    await bridge.tick();
    expect(state.conversations[dm.id]).toMatchObject({ error: expect.stringContaining("community's key") });
    expect(state.conversations[dm.id]!.buzz).toBeUndefined();
    expect(state.conversations[general.id]!.buzz).toBeDefined();
    key = "relay";
    await bridge.tick();
    expect(state.conversations[dm.id]!.buzz).toBeDefined();
    expect(state.conversations[dm.id]!.error).toBeUndefined();
  });
});

describe("Slack bridges, third review", () => {
  const general: SlackConversation = { id: "C0GENERAL1", name: "general", kind: "public" };

  it("doesn't post a Slack message again when it's edited before a helper's turn", async () => {
    const world = community();
    const slack = slackWorld();
    const clock = { now: Date.UTC(2027, 0, 1) };
    const maker = person(world, slack.as("UB"), [general], clock);
    const helper = person(world, slack.as("UR"), [general], clock);
    await maker.bridge.tick();
    await helper.bridge.tick();
    const channel = maker.state.conversations[general.id]!.buzz!;
    const ts = slack.say(general.id, "US", "helo");
    await maker.bridge.tick();
    await helper.bridge.tick();
    slack.conversations.get(general.id)!.find((m) => m.ts === ts)!.text = "hello";
    clock.now += HELPER_DELAY_MS + 1000;
    await helper.bridge.tick();
    expect(world.posts(channel).filter((e) => e.tags.some((t) => t[0] === "r" && t[1] === permalink(general.id, ts))).map((e) => e.pubkey)).toEqual([maker.bot.pubkey]);
  });

  it("finds a timed-out thread reply in Slack instead of sending it again, when its parent is old", async () => {
    const world = community();
    const slack = slackWorld();
    // Slack's clock and the bridge's agree here, so the bridge can read Slack around when it sent.
    const clock = { now: 1_795_200_000_000 };
    const brandon = person(world, slack.as("UB"), [general], clock);
    await brandon.bridge.tick();
    const channel = brandon.state.conversations[general.id]!.buzz!;
    slack.say(general.id, "US", "an old one");
    await brandon.bridge.tick();
    for (let i = 0; i < 60; i++) slack.say(general.id, "US", `later ${i}`);
    for (let pass = 0; pass < 3; pass++) await brandon.bridge.tick();
    const parent = world.posts(channel).find((e) => e.content.endsWith("\nan old one"))!;
    slack.timeOutNextSends("after");
    await brandon.human.publish({ kind: 9, created_at: 0, content: "late reply", tags: [["h", channel], ["e", parent.id, "", "reply"]] });
    await brandon.bridge.tick();
    await brandon.bridge.tick();
    clock.now += UNSURE_MS + 1000;
    await brandon.bridge.tick();
    await brandon.bridge.tick();
    expect(slack.sends.map((send) => send.text)).toEqual([`late reply\n${FOOTER}`]);
    expect(brandon.logs.join("\n")).toContain("did reach Slack");
  });

  it("doesn't match a Slack message to a Buzz-only member's message with the same text", async () => {
    const world = community();
    const slack = slackWorld();
    const dm: SlackConversation = { id: "D0BRANDONRYAN", name: "Ryan Zapanta", kind: "im" };
    const clock = { now: Date.UTC(2027, 0, 1) };
    const brandon = person(world, slack.as("UB"), [dm], clock);
    const ryan = person(world, slack.as("UR"), [dm], clock);
    slack.say(dm.id, "UR", "hi");
    await brandon.bridge.tick();
    await ryan.bridge.tick();
    const brandons = brandon.state.conversations[dm.id]!.buzz!;
    const ryans = ryan.state.conversations[dm.id]!.buzz!;
    // Brandon adds Alice to his Buzz channel; what she writes there stays in Buzz.
    const alice = world.relayFor(generateSecretKey());
    await brandon.human.publish({ kind: 9000, created_at: 0, content: "", tags: [["h", brandons], ["p", alice.pubkey, "", "member"]] });
    const hers = await alice.publish({ kind: 9, created_at: 0, content: "ok", tags: [["h", brandons]] });
    await ryan.human.publish({ kind: 9, created_at: 0, content: "ok", tags: [["h", ryans]] });
    await ryan.bridge.tick();
    await brandon.bridge.tick();
    expect(Object.values(brandon.state.conversations[dm.id]!.posted)).not.toContain(hers.id);
    expect(world.posts(brandons).filter((e) => /^\*\*Ryan Zapanta\*\*.*\nok$/s.test(e.content))).toHaveLength(1);
  });

  it("sends the owner's messages while a Slack message can't be posted, and gives that one up after an hour of tries, with a note", async () => {
    const world = community();
    const slack = slackWorld();
    const clock = { now: Date.UTC(2027, 0, 1) };
    const brandon = person(world, slack.as("UB"), [general], clock);
    await brandon.bridge.tick();
    const channel = brandon.state.conversations[general.id]!.buzz!;
    slack.say(general.id, "US", "stuck");
    world.failPostsWhere(() => true);
    await brandon.human.publish({ kind: 9, created_at: 0, content: "still goes", tags: [["h", channel]] });
    await brandon.bridge.tick();
    expect(slack.sends.map((send) => send.text)).toEqual([`still goes\n${FOOTER}`]);
    // Nothing posts for over an hour, the note included: nothing is given up.
    for (let pass = 0; pass < 20; pass++) {
      clock.now += 4 * 60_000;
      await brandon.bridge.tick();
    }
    expect(brandon.logs.join("\n")).not.toContain("gave up posting");
    // Only that message fails now: it's given up, with a note.
    world.failPostsWhere((event) => event.content.endsWith("\nstuck"));
    for (let pass = 0; pass < 3; pass++) {
      clock.now += 60_000;
      await brandon.bridge.tick();
    }
    expect(brandon.logs.join("\n")).toContain("gave up posting");
    expect(world.posts(channel).some((e) => e.content.startsWith("⚠️ A Slack message couldn't be bridged"))).toBe(true);
  });

  it("starts a message's hour again after a long gap between tries", async () => {
    const world = community();
    const slack = slackWorld();
    const clock = { now: Date.UTC(2027, 0, 1) };
    const brandon = person(world, slack.as("UB"), [general], clock);
    await brandon.bridge.tick();
    const channel = brandon.state.conversations[general.id]!.buzz!;
    slack.say(general.id, "US", "blip");
    world.failPostsWhere((event) => event.content.endsWith("\nblip"));
    await brandon.bridge.tick();
    // The Sandbox sleeps two hours, then a few more failures.
    clock.now += 2 * STUCK_MS;
    for (let pass = 0; pass < 3; pass++) await brandon.bridge.tick();
    expect(brandon.logs.join("\n")).not.toContain("gave up posting");
    world.failPostsWhere(undefined);
    await brandon.bridge.tick();
    expect(world.posts(channel).filter((e) => e.content.endsWith("\nblip"))).toHaveLength(1);
  });

  it("posts a message edited since another helper posted it next to that copy, marked as differing", async () => {
    const world = community();
    const slack = slackWorld();
    const clock = { now: Date.UTC(2027, 0, 1) };
    const maker = person(world, slack.as("UB"), [general], clock);
    const one = person(world, slack.as("UR"), [general], clock);
    const two = person(world, slack.as("UX"), [general], clock);
    await maker.bridge.tick();
    await one.bridge.tick();
    await two.bridge.tick();
    clock.now += 11 * 60_000;
    await one.bridge.tick();
    await two.bridge.tick();
    const channel = maker.state.conversations[general.id]!.buzz!;
    const first = one.state.conversations[general.id]!.turn === 0 ? one : two;
    const second = first === one ? two : one;
    // The maker is asleep: the first helper posts it, then it's edited in Slack before the second helper's turn.
    const ts = slack.say(general.id, "US", "helo");
    await first.bridge.tick();
    await second.bridge.tick();
    clock.now += HELPER_DELAY_MS + 1000;
    await first.bridge.tick();
    slack.conversations.get(general.id)!.find((m) => m.ts === ts)!.text = "hello";
    clock.now += HELPER_TURN_MS + 1000;
    await second.bridge.tick();
    await maker.bridge.tick();
    const copies = world.posts(channel).filter((e) => e.tags.some((t) => t[0] === "r" && t[1] === permalink(general.id, ts)));
    const top = copies.filter((e) => !e.tags.some((t) => t[0] === "e"));
    // The maker trusts the helpers' copies by text only, and the second copy matches: three bridges, two copies, none nested.
    expect(top.map((e) => e.pubkey)).toEqual([first.bot.pubkey, second.bot.pubkey]);
    expect(top[1]!.content).toMatch(/differs from an earlier copy\nhello$/);
  });

  it("doesn't post a long message that timed out back to Buzz, or send it again", async () => {
    const world = community();
    const slack = slackWorld();
    const clock = { now: 1_795_200_000_000 };
    const brandon = person(world, slack.as("UB"), [general], clock);
    await brandon.bridge.tick();
    const channel = brandon.state.conversations[general.id]!.buzz!;
    const long = Array.from({ length: 1200 }, (_, i) => `word${i}`).join(" ");
    slack.timeOutNextSends("after");
    const said = await brandon.human.publish({ kind: 9, created_at: 0, content: long, tags: [["h", channel]] });
    await brandon.bridge.tick();
    await brandon.bridge.tick();
    clock.now += UNSURE_MS + 1000;
    await brandon.bridge.tick();
    await brandon.bridge.tick();
    expect(slack.sends).toHaveLength(1);
    expect(slack.sends[0]!.text).toContain("cut short");
    expect(world.posts(channel).filter((e) => e.content.includes("word1199") || e.content.includes("word10 "))).toEqual([said]);
  });

  it("links a timed-out send that went while the owner's Slack ID can't be read", async () => {
    const world = community();
    const slack = slackWorld();
    const clock = { now: Date.UTC(2027, 0, 1) };
    const base = slack.as("UB");
    const noProfile = (tool: string, args: Readonly<Record<string, unknown>>) => (tool === "slack_read_user_profile" ? Promise.reject(new Error("timed out")) : base(tool, args));
    const brandon = person(world, noProfile, [general], clock);
    await brandon.bridge.tick();
    const channel = brandon.state.conversations[general.id]!.buzz!;
    slack.timeOutNextSends("after");
    const said = await brandon.human.publish({ kind: 9, created_at: 0, content: "went anyway", tags: [["h", channel]] });
    await brandon.bridge.tick();
    await brandon.bridge.tick();
    clock.now += UNSURE_MS + 1000;
    await brandon.bridge.tick();
    expect(slack.sends).toHaveLength(1);
    expect(world.posts(channel).filter((e) => e.content.includes("went anyway") || e.content.startsWith("⚠️"))).toEqual([said]);
  });

  it("keeps sending when a timed-out send can't be checked, and gives that one up after a while", async () => {
    const world = community();
    const slack = slackWorld();
    const clock = { now: 1_795_200_000_000 };
    const brandon = person(world, slack.as("UB"), [general], clock);
    await brandon.bridge.tick();
    const channel = brandon.state.conversations[general.id]!.buzz!;
    const parentTs = slack.say(general.id, "US", "a parent");
    await brandon.bridge.tick();
    const parent = world.posts(channel).find((e) => e.content.endsWith("\na parent"))!;
    slack.timeOutNextSends("before");
    const reply = await brandon.human.publish({ kind: 9, created_at: 0, content: "a reply", tags: [["h", channel], ["e", parent.id, "", "reply"]] });
    await brandon.bridge.tick();
    // The parent is deleted in Slack, so its thread can't be read.
    const list = slack.conversations.get(general.id)!;
    list.splice(list.findIndex((m) => m.ts === parentTs), 1);
    clock.now += UNSURE_MS + 1000;
    await brandon.human.publish({ kind: 9, created_at: 0, content: "later one", tags: [["h", channel]] });
    await brandon.bridge.tick();
    await brandon.bridge.tick();
    expect(slack.sends.map((send) => send.text)).toEqual([`later one\n${FOOTER}`]);
    clock.now += UNSURE_LIMIT_MS;
    await brandon.bridge.tick();
    expect(world.posts(channel).filter((e) => e.content.startsWith("⚠️ This may not have reached Slack") && e.tags.some((t) => t[0] === "e" && t[1] === parent.id))).toHaveLength(1);
    expect(brandon.state.conversations[general.id]!.out!.sent[reply.id]).toBeNull();
  });
});

describe("The community over HTTP", () => {
  const answer = (status: number, body: unknown) => async () => new Response(JSON.stringify(body), { status });
  const relayWith = (respond: () => Promise<Response>) => {
    vi.stubGlobal("fetch", respond);
    return new HttpRelay("wss://relay.example", generateSecretKey(), ["auth", "x", "", "y"], () => {});
  };
  const failure = (relay: HttpRelay) => relay.publish({ kind: 9, created_at: 1, content: "", tags: [] }).then(() => ({}) as Record<string, unknown>, (error: Record<string, unknown>) => error);
  afterEach(() => vi.unstubAllGlobals());

  it("tells a refusal from no answer, whatever the status", async () => {
    expect((await failure(relayWith(answer(200, { accepted: false, message: "invalid: bad tag" })))).refused).toBe(true);
    expect((await failure(relayWith(answer(400, { accepted: false, message: "invalid: bad tag" })))).refused).toBe(true);
    expect((await failure(relayWith(answer(413, { error: "too large" })))).refused).toBe(true);
    expect((await failure(relayWith(answer(200, { accepted: false, message: "nope" })))).refused).toBe(true);
    // About the agent, not the event: retried in order, nothing given up.
    expect((await failure(relayWith(answer(403, { accepted: false, message: "restricted: not a member" })))).refused).toBeUndefined();
    expect((await failure(relayWith(answer(200, { accepted: false, message: "restricted: not a member" })))).refused).toBeUndefined();
    expect((await failure(relayWith(answer(200, { accepted: false, message: "blocked: you are banned" })))).refused).toBeUndefined();
    expect((await failure(relayWith(answer(200, { accepted: false, message: "auth-required: sign in" })))).refused).toBeUndefined();
    expect((await failure(relayWith(answer(404, { error: "not found" })))).refused).toBeUndefined();
    expect((await failure(relayWith(answer(429, { accepted: false, message: "rate-limited: retry in 5s" })))).refused).toBeUndefined();
    expect((await failure(relayWith(answer(200, { accepted: false, message: "rate-limited: slow down" })))).refused).toBeUndefined();
    expect((await failure(relayWith(answer(401, { error: "unauthorized" })))).refused).toBeUndefined();
    expect((await failure(relayWith(answer(503, { accepted: false, message: "error: try later" })))).refused).toBeUndefined();
    // A duplicate is already there.
    expect(await failure(relayWith(answer(409, { accepted: false, message: "duplicate: have it" })))).toEqual({});
  });
});
