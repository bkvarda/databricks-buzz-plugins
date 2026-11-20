// A Slack bridge agent's work, in its Sandbox: for each Slack conversation its
// owner chose, it keeps a Buzz channel, posts the conversation's new messages
// and thread replies there, and sends its owner's Buzz messages there back to
// Slack, as its owner (the Sandbox's Databricks sign-in, through Slack's MCP
// server, so Slack shows them as its owner's own).
//
// Several people can bridge the same conversation (../src/slack.ts has the
// conventions). Each bridge finds the conversation's Buzz channel by its label,
// the oldest one first:
//   - a public Slack channel's open Buzz channel, which it joins;
//   - for a private channel, DM or group DM, a private Buzz channel it made, or
//     one another bridge made and shared with it. It takes someone else's only
//     once that channel holds a message it can read in Slack itself, so a
//     channel nobody in the conversation made can't collect it;
//   - otherwise it makes one, with its owner as an admin.
// The bridge that made the channel posts at once; the others post a message
// only when it's still missing two minutes later, so the channel keeps up
// while that bridge's Sandbox is asleep. Every bridge checks for the message's
// Slack link (its `r` tag) first. The bridge that made a private channel adds
// the Slack bridges of the people its owner adds to it.
import { randomUUID } from "node:crypto";
import type { EventTemplate, NostrEvent } from "nostr-tools/pure";
import {
  BRIDGE_TAG,
  bridgedContent,
  bridgedText,
  buzzChannelName,
  FOOTER,
  hasFooter,
  isPrivateKind,
  mrkdwn,
  norm,
  parseMessages,
  parseProfile,
  permalink,
  type SlackConversation,
  type SlackMessage,
  slackLabel,
  tsFromLink,
  unwrap,
} from "../src/slack";
import { attestedOwner, threadRoot } from "./buzz";

export const HELPER_DELAY_MS = 2 * 60_000;
const RESOLVE_EVERY_MS = 10 * 60_000;
const BACKFILL = 5;
const KEEP = 500;

export type BridgeRelay = Readonly<{
  publish(template: EventTemplate): Promise<NostrEvent>;
  query(filters: readonly Readonly<Record<string, unknown>>[]): Promise<NostrEvent[]>;
}>;
/** Calls one of Slack's MCP tools as the owner; resolves with its text, rejects on a tool error. */
export type SlackCall = (tool: string, args: Readonly<Record<string, unknown>>) => Promise<string>;

export type ConversationState = {
  buzz?: string;
  buzzName?: string;
  /** This bridge made the Buzz channel, so it posts at once. */
  primary?: boolean;
  /** Whether the owner is in the Buzz channel (they join an open one someone else made themselves). */
  ownerIn?: boolean;
  /** People in the Buzz channel, agents aside. */
  people?: number;
  resolvedAt?: number;
  /** Messages up to this Slack ts are all handled. */
  last?: string;
  /** Slack ts → the Buzz event for it ("" when it came from Buzz and the original wasn't found). */
  posted: Record<string, string>;
  threads: Record<string, { latest?: string; seen: string[] }>;
  /** Slack ts → when a helper first saw it missing. */
  pending: Record<string, number>;
  out?: { since: number; sent: Record<string, string | null> };
  error?: string;
};
export type BridgeState = { conversations: Record<string, ConversationState>; me?: { handle: string; name: string } };

export type ConversationStatus = Readonly<{
  id: string;
  name: string;
  buzz?: string;
  buzzName?: string;
  primary?: boolean;
  ownerIn?: boolean;
  people?: number;
  error?: string;
}>;

type Channel = Readonly<{ id: string; name: string; private: boolean; creator?: string; createdAt?: number; labels: readonly string[] }>;

function channelOf(event: NostrEvent): Channel | undefined {
  const tag = (name: string) => event.tags.find((t) => t[0] === name)?.[1];
  const id = tag("d");
  if (!id) return undefined;
  const createdAt = Number(tag("created_at"));
  const creator = tag("P");
  return {
    id,
    name: tag("name") ?? id,
    private: event.tags.some((t) => t[0] === "private"),
    labels: event.tags.filter((t) => t[0] === "t").slice(1).map((t) => t[1]!),
    ...(creator && { creator }),
    ...(Number.isFinite(createdAt) && createdAt > 0 && { createdAt }),
  };
}

/** NIP-CL's oldest-channel rule: lowest creation time, then lowest ID; unknown times last. */
const byAge = (a: Channel, b: Channel) => (a.createdAt ?? Infinity) - (b.createdAt ?? Infinity) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

export class SlackBridge {
  private lastCreated = 0;
  /** Messages posted to Buzz or sent to Slack so far, for the runner's "last activity". */
  moved = 0;

  constructor(
    private readonly input: Readonly<{
      relay: BridgeRelay;
      slack: SlackCall;
      /** The bridge agent's pubkey, and its owner's. */
      pubkey: string;
      owner: string;
      conversations: readonly SlackConversation[];
      state: BridgeState;
      save(): void;
      log(line: string): void;
      now?: () => number;
      helperDelayMs?: number;
      newId?: () => string;
    }>,
  ) {}

  private get state() {
    return this.input.state;
  }
  private now() {
    return this.input.now?.() ?? Date.now();
  }
  private stateOf(id: string): ConversationState {
    return (this.state.conversations[id] ??= { posted: {}, threads: {}, pending: {} });
  }

  /** One pass over every conversation. */
  async tick(): Promise<void> {
    if (!this.state.me) {
      try {
        const me = parseProfile(await this.input.slack("slack_read_user_profile", { response_format: "concise" }));
        if (me) this.state.me = me;
      } catch (error) {
        this.input.log(`couldn't read the owner's Slack profile: ${(error as Error).message}`);
      }
    }
    for (const conversation of this.input.conversations) {
      const st = this.stateOf(conversation.id);
      try {
        await this.resolve(conversation, st);
        if (st.buzz) {
          await this.inbound(conversation, st);
          await this.outbound(conversation, st);
        }
        delete st.error;
      } catch (error) {
        st.error = String((error as Error).message ?? error).slice(0, 300);
        this.input.log(`${conversation.id}: ${st.error}`);
      }
      this.input.save();
    }
  }

  status(): ConversationStatus[] {
    return this.input.conversations.map((conversation) => {
      const st = this.state.conversations[conversation.id];
      return {
        id: conversation.id,
        name: conversation.name,
        ...(st?.buzz && { buzz: st.buzz }),
        ...(st?.buzzName && { buzzName: st.buzzName }),
        ...(st?.primary !== undefined && { primary: st.primary }),
        ...(st?.ownerIn !== undefined && { ownerIn: st.ownerIn }),
        ...(st?.people !== undefined && { people: st.people }),
        ...(st?.error && { error: st.error }),
      };
    });
  }

  // ── Publishing ──

  /** Publishes in order: the relay refuses a backdated event, so one second per event at most. */
  private async publish(kind: number, content: string, tags: string[][]): Promise<NostrEvent> {
    let created = Math.floor(this.now() / 1000);
    while (created <= this.lastCreated && !this.input.now) {
      await new Promise((resolve) => setTimeout(resolve, 200));
      created = Math.floor(Date.now() / 1000);
    }
    this.lastCreated = Math.max(created, this.lastCreated + (this.input.now ? 1 : 0));
    return this.input.relay.publish({ kind, created_at: this.lastCreated, content, tags });
  }

  // ── The Buzz channel ──

  private async members(channel: string): Promise<Map<string, string>> {
    const [event] = await this.input.relay.query([{ kinds: [39002], "#d": [channel], limit: 1 }]);
    const roles = new Map<string, string>();
    for (const tag of event?.tags ?? []) if (tag[0] === "p" && tag[1]) roles.set(tag[1], tag[3] ?? "member");
    return roles;
  }

  /** Finds, takes or makes the conversation's Buzz channel; every few minutes, or until it has one. */
  private async resolve(conversation: SlackConversation, st: ConversationState) {
    if (st.buzz && this.now() - (st.resolvedAt ?? 0) < RESOLVE_EVERY_MS) return;
    const label = slackLabel(conversation.id);
    const secret = isPrivateKind(conversation.kind);
    const found = (await this.input.relay.query([{ kinds: [39000], "#t": [label], limit: 50 }]))
      .map(channelOf)
      .filter((channel): channel is Channel => Boolean(channel && channel.labels.includes(label) && channel.private === secret))
      .sort(byAge);
    let chosen: Channel | undefined;
    for (const channel of found) {
      if (channel.creator === this.input.pubkey || !secret || (await this.proven(conversation, channel))) {
        chosen = channel;
        break;
      }
    }
    if (!chosen) {
      // Only for a conversation the owner can read in Slack (this throws otherwise).
      await this.read(conversation);
      chosen = await this.create(conversation, label, secret);
    }
    if (st.buzz !== chosen.id) {
      if (st.buzz) this.input.log(`${conversation.id}: now bridged in ${chosen.id} (was ${st.buzz})`);
      // Another channel's history isn't this one's: start over there, with the latest few.
      st.posted = {};
      st.threads = {};
      st.pending = {};
      delete st.last;
      delete st.out;
      st.buzz = chosen.id;
    }
    st.buzzName = chosen.name;
    st.primary = chosen.creator === this.input.pubkey;
    let roles = await this.members(chosen.id);
    if (!roles.has(this.input.pubkey) && !secret) {
      await this.publish(9021, "", [["h", chosen.id]]);
      roles = await this.members(chosen.id);
    }
    if (st.primary && secret) await this.addBridges(chosen.id, roles);
    st.ownerIn = roles.has(this.input.owner);
    st.people = [...roles].filter(([pubkey, role]) => role !== "bot" && pubkey !== this.input.pubkey).length;
    st.resolvedAt = this.now();
  }

  /** Whether a private channel someone else's bridge made holds a message of this conversation that this bridge can read in Slack. */
  private async proven(conversation: SlackConversation, channel: Channel): Promise<boolean> {
    if (!channel.creator) return false;
    const posts = await this.input.relay.query([{ kinds: [9], "#h": [channel.id], authors: [channel.creator], limit: 50 }]);
    if (!posts.length) return false;
    const slack = new Map(parseMessages(await this.read(conversation)).map((message) => [message.ts, norm(mrkdwn(message.text))]));
    return posts.some((post) => {
      const link = post.tags.find((tag) => tag[0] === "r")?.[1];
      const ts = tsFromLink(link);
      const text = ts ? slack.get(ts) : undefined;
      return Boolean(link?.includes(`/archives/${conversation.id}/`) && text && text === norm(bridgedText(post.content)));
    });
  }

  private async create(conversation: SlackConversation, label: string, secret: boolean): Promise<Channel> {
    const id = this.input.newId?.() ?? randomUUID();
    const name = buzzChannelName(conversation, this.state.me);
    const about = secret ? `Bridged from Slack. Only people in the Slack conversation should be added here.` : `Bridged from the Slack channel #${conversation.name}.`;
    await this.publish(9007, "", [["h", id], ["name", name], ["visibility", secret ? "private" : "open"], ["channel_type", "stream"], ["about", about], ["t", label]]);
    await this.publish(9000, "", [["h", id], ["p", this.input.owner, "", "admin"]]);
    this.input.log(`${conversation.id}: made ${secret ? "private" : "open"} channel ${name} (${id})`);
    return { id, name, private: secret, creator: this.input.pubkey, createdAt: Math.floor(this.now() / 1000), labels: [label] };
  }

  /** Adds the Slack bridges of the people in a private channel this bridge made (their owners' attestations checked). */
  private async addBridges(channel: string, roles: Map<string, string>) {
    const people = new Set([...roles].filter(([pubkey, role]) => role !== "bot" && pubkey !== this.input.owner && pubkey !== this.input.pubkey).map(([pubkey]) => pubkey));
    if (!people.size) return;
    for (const profile of await this.input.relay.query([{ kinds: [0], "#t": [BRIDGE_TAG], limit: 500 }])) {
      const owner = attestedOwner(profile);
      if (!owner || !people.has(owner) || roles.has(profile.pubkey) || profile.pubkey === this.input.pubkey) continue;
      await this.publish(9000, "", [["h", channel], ["p", profile.pubkey, "", "member"]]);
      roles.set(profile.pubkey, "bot");
      this.input.log(`${channel}: added ${owner.slice(0, 8)}…'s Slack bridge`);
    }
  }

  // ── Slack → Buzz ──

  private read(conversation: SlackConversation) {
    return this.input.slack("slack_read_channel", { channel_id: conversation.id, limit: 50 });
  }

  private async inbound(conversation: SlackConversation, st: ConversationState) {
    const messages = parseMessages(await this.read(conversation));
    if (st.last === undefined) {
      // A new channel starts with the latest few, not the whole history.
      st.last = messages.length > BACKFILL ? messages[messages.length - BACKFILL - 1]!.ts : "0";
    }
    const twins = this.twins(st.buzz!);
    for (const message of messages) {
      if (Number(message.ts) > Number(st.last) && !(message.ts in st.posted)) {
        const id = await this.mirror(conversation, st, message, twins);
        if (id !== undefined) {
          st.posted[message.ts] = id;
          delete st.pending[message.ts];
          this.input.save();
        }
      }
      if (message.thread && st.posted[message.ts] !== undefined && st.threads[message.ts]?.latest !== message.thread.latest) await this.thread(conversation, st, message, twins);
    }
    // Handled up to the first message still waiting.
    for (const message of messages) {
      if (Number(message.ts) <= Number(st.last)) continue;
      if (!(message.ts in st.posted)) break;
      st.last = message.ts;
    }
    const posted = Object.keys(st.posted).sort((a, b) => Number(a) - Number(b));
    for (const ts of posted.slice(0, Math.max(0, posted.length - KEEP))) {
      delete st.posted[ts];
      delete st.threads[ts];
    }
    for (const [ts, at] of Object.entries(st.pending)) if (this.now() - at > 86_400_000) delete st.pending[ts];
  }

  private async thread(conversation: SlackConversation, st: ConversationState, parent: SlackMessage, twins: () => Promise<readonly { norm: string; id: string }[]>) {
    const seen = (st.threads[parent.ts] ??= { seen: [] });
    const root = st.posted[parent.ts];
    const replies = parseMessages(await this.input.slack("slack_read_thread", { channel_id: conversation.id, message_ts: parent.ts, limit: 200 }));
    let waiting = false;
    for (const reply of replies) {
      if (reply.ts === parent.ts || seen.seen.includes(reply.ts)) continue;
      // Replies to a message from Buzz whose original wasn't found have nowhere to go.
      const id = root ? await this.mirror(conversation, st, reply, twins, root) : "";
      if (id === undefined) {
        waiting = true;
        continue;
      }
      seen.seen.push(reply.ts);
      delete st.pending[reply.ts];
      this.input.save();
    }
    if (seen.seen.length > KEEP) seen.seen.splice(0, seen.seen.length - KEEP);
    if (!waiting) seen.latest = parent.thread!.latest;
  }

  /** Recent Buzz messages in the channel, for finding where a message from Buzz came from; read once a pass. */
  private twins(channel: string) {
    let found: Promise<{ norm: string; id: string }[]> | undefined;
    return () =>
      (found ??= this.input.relay
        .query([{ kinds: [9], "#h": [channel], since: Math.floor(this.now() / 1000) - 6 * 3600, limit: 300 }])
        .then((events) => events.map((event) => ({ norm: norm(event.content), id: event.id }))));
  }

  /**
   * Posts a Slack message to Buzz unless it's there already. Resolves with its
   * Buzz event, "" for a message from Buzz whose original isn't found, or
   * undefined while a helper waits for the bridge that made the channel.
   */
  private async mirror(conversation: SlackConversation, st: ConversationState, message: SlackMessage, twins: () => Promise<readonly { norm: string; id: string }[]>, root?: string): Promise<string | undefined> {
    if (hasFooter(message.text)) {
      const text = norm(mrkdwn(message.text));
      return (text && (await twins()).find((twin) => twin.norm === text)?.id) || "";
    }
    if (!st.primary) {
      const first = (st.pending[message.ts] ??= this.now());
      if (this.now() - first < (this.input.helperDelayMs ?? HELPER_DELAY_MS)) return undefined;
    }
    const link = permalink(conversation.id, message.ts);
    const [there] = await this.input.relay.query([{ kinds: [9], "#h": [st.buzz!], "#r": [link], limit: 1 }]);
    if (there) return there.id;
    const tags = [["h", st.buzz!], ["r", link]];
    if (root) tags.push(["e", root, "", "reply"]);
    const event = await this.publish(9, bridgedContent(message, link, Math.floor(this.now() / 1000)), tags);
    this.moved++;
    this.input.log(`${conversation.id}: posted ${message.ts}${root ? " (reply)" : ""}${st.primary ? "" : " as a helper"}`);
    return event.id;
  }

  // ── Buzz → Slack ──

  /** The Slack message a Buzz message stands for: one this bridge saw or sent, or another bridge's post of it. */
  private async slackTs(st: ConversationState, event: string): Promise<string | undefined> {
    for (const [ts, id] of Object.entries(st.posted)) if (id === event) return ts;
    const sent = st.out?.sent[event];
    if (sent) return sent;
    const [found] = await this.input.relay.query([{ ids: [event], limit: 1 }]);
    return tsFromLink(found?.tags.find((tag) => tag[0] === "r")?.[1]);
  }

  private async outbound(conversation: SlackConversation, st: ConversationState) {
    const out = (st.out ??= { since: Math.floor(this.now() / 1000), sent: {} });
    const events = await this.input.relay.query([{ kinds: [9], "#h": [st.buzz!], authors: [this.input.owner], since: out.since - 30, limit: 100 }]);
    let roles: Map<string, string> | undefined;
    for (const event of events.sort((a, b) => a.created_at - b.created_at)) {
      if (event.id in out.sent || event.pubkey !== this.input.owner) continue;
      // Who's an agent now: read once a pass, and only when there's something to send.
      const known = (roles ??= await this.members(st.buzz!));
      out.since = Math.max(out.since, event.created_at);
      const text = event.content.trim();
      // "//" keeps a message in Buzz, and so does talking to an agent.
      const agents = event.tags.some((tag) => tag[0] === "p" && known.get(tag[1] ?? "") === "bot");
      const root = threadRoot(event);
      const parent = root ? await this.slackTs(st, root) : undefined;
      // A thread that started in Buzz stays there too.
      if (!text || text.startsWith("//") || agents || (root && !parent)) {
        out.sent[event.id] = null;
        continue;
      }
      try {
        const reply = unwrap(await this.input.slack("slack_send_message", { channel_id: conversation.id, message: `${text.slice(0, 4900)}\n${FOOTER}`, ...(parent && { thread_ts: parent }) }));
        const ts = String((reply.message_context as { message_ts?: string } | undefined)?.message_ts ?? "");
        out.sent[event.id] = ts || null;
        this.moved++;
        if (ts && parent) (st.threads[parent] ??= { seen: [] }).seen.push(ts);
        else if (ts) st.posted[ts] = event.id;
        this.input.log(`${conversation.id}: sent ${event.id.slice(0, 8)} to Slack${parent ? " (reply)" : ""}`);
      } catch (error) {
        out.sent[event.id] = null;
        const why = String((error as Error).message ?? error).slice(0, 200);
        this.input.log(`${conversation.id}: couldn't send ${event.id.slice(0, 8)}: ${why}`);
        await this.publish(9, `⚠️ Couldn't send this to Slack: ${why}`, [["h", st.buzz!], ["e", root ?? event.id, "", "reply"]]).catch(() => {});
      }
      this.input.save();
    }
    const sent = Object.keys(out.sent);
    for (const id of sent.slice(0, Math.max(0, sent.length - KEEP))) delete out.sent[id];
  }
}
