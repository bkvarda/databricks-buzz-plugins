// A Slack bridge agent's work, in its Sandbox: for each Slack conversation its
// owner chose, it keeps a Buzz channel, posts the conversation's new messages
// and thread replies there, and sends its owner's Buzz messages there back to
// Slack, as its owner (the Sandbox's Databricks sign-in, through Slack's MCP
// server, so Slack shows them as its owner's own).
//
// Several people can bridge the same public Slack channel (../src/slack.ts has
// the conventions). Each bridge finds its Buzz channel by its label, the oldest
// one first, and joins it, or makes one. The bridge that made it posts at once;
// the others post a message only when it's still missing two minutes later,
// taking turns, so the channel keeps up while that bridge's Sandbox is asleep.
// Every bridge checks for the message's Slack link (its `r` tag) first.
//
// A private channel, DM or group DM always goes to a private Buzz channel this
// bridge made, with its owner as an admin: whoever else is in the Buzz channel
// is the owner's choice. A bridge never takes a private channel someone else
// made, since nothing in Buzz shows who is in the Slack conversation. Each
// person in a DM has their own, and what one of them writes from Buzz shows up
// in the other's like any Slack message.
//
// Slack's tools answer in markdown and don't escape message text, so the
// bridge reads each new message again on its own before posting it: a header
// someone typed into a message is not a message.
import { randomUUID } from "node:crypto";
import type { EventTemplate, NostrEvent } from "nostr-tools/pure";
import {
  BRIDGE_TAG,
  bridgedContent,
  bridgedText,
  buzzChannelName,
  FOOTER,
  around,
  hasFooter,
  headers,
  isPrivateKind,
  isTs,
  mrkdwn,
  norm,
  parseMessages,
  parseOne,
  parseProfile,
  permalink,
  type SlackConversation,
  type SlackMessage,
  slackLabel,
  tsFromLink,
  unfooter,
  unwrap,
} from "../src/slack";
import { attestedOwner, threadRoot } from "./buzz";

export const HELPER_DELAY_MS = 2 * 60_000;
/** How much longer each helper after the first waits, so helpers take turns. */
export const HELPER_TURN_MS = 30_000;
const RESOLVE_EVERY_MS = 10 * 60_000;
const BACKFILL = 5;
/** Messages read a pass: the latest, for thread replies; and, after a gap, the next ones since the last handled. */
const RECENT = 50;
const CATCH_UP = 100;
const KEEP = 500;
const TRIES = 3;
const MAX_SEND = 4900;
/** How long a send that timed out waits to show up in Slack before it's sent again. */
export const UNSURE_MS = 2 * 60_000;
/** How long a Slack message the community won't answer for is tried before it counts as refused. */
export const STUCK_MS = 60 * 60_000;

export type BridgeRelay = Readonly<{
  publish(template: EventTemplate): Promise<NostrEvent>;
  query(filters: readonly Readonly<Record<string, unknown>>[]): Promise<NostrEvent[]>;
}>;
/**
 * Calls one of Slack's MCP tools as the owner; resolves with its text. Rejects
 * with a SlackToolError when the tool answered with an error, so nothing
 * happened, and with anything else (a timeout, a network failure) when it may
 * have.
 */
export type SlackCall = (tool: string, args: Readonly<Record<string, unknown>>) => Promise<string>;
export class SlackToolError extends Error {}
/** What a Buzz message is sent to Slack as, the footer aside. */
const bodyOf = (text: string) => (text.length > MAX_SEND ? `${text.slice(0, MAX_SEND)}… _(cut short: the rest is in Buzz)_` : text);
/** The relay answered and refused the event (rather than failing to answer). */
const refused = (error: unknown) => (error as { refused?: unknown } | undefined)?.refused === true;
/** A Buzz message a Slack message may be the copy of; `kept` when "//" keeps it in Buzz. */
type Twin = Readonly<{ norm: string; id: string; pubkey: string; kept: boolean }>;

export type ConversationState = {
  buzz?: string;
  buzzName?: string;
  /** This bridge made the Buzz channel, so it posts at once. */
  primary?: boolean;
  /** Whether the owner is in the Buzz channel (they join an open one someone else made themselves). */
  ownerIn?: boolean;
  /** People in the Buzz channel, agents aside. */
  people?: number;
  /** A helper's turn among the channel's other bridges: it waits HELPER_TURN_MS more per turn. */
  turn?: number;
  resolvedAt?: number;
  /** Messages up to this Slack ts are all handled. */
  last?: string;
  /** Slack ts → the Buzz event for it ("" when it came from Buzz and the original wasn't found). */
  posted: Record<string, string>;
  threads: Record<string, { latest?: string; seen: string[] }>;
  /** Slack ts → when a helper first saw it missing. */
  pending: Record<string, number>;
  /** Slack ts → failed tries at posting it. */
  failed?: Record<string, number>;
  /** Slack ts → when the community first didn't answer a post of it. */
  stuck?: Record<string, number>;
  /** Who made the Buzz channel (from metadata the relay's key signs): its posts are trusted when a message is edited in Slack later. */
  creator?: string;
  /** Listed ts that aren't messages (a header typed into a message). */
  fake?: string[];
  /** Buzz event → the Slack ts it was sent as; "" while it's being sent (never sent twice), null when it won't be. */
  out?: {
    since: number;
    sent: Record<string, string | null>;
    tries?: Record<string, number>;
    /** Sends that timed out. Linked when they show up in Slack; otherwise Slack is read, and they go again only when they aren't there. */
    unsure?: Record<string, Unsure>;
  };
  error?: string;
};
/** A send that timed out: when, the Buzz message's time, and the Slack thread and Buzz thread it went to. */
type Unsure = { at: number; created: number; parent?: string; root?: string };
export type BridgeState = { conversations: Record<string, ConversationState>; me?: { handle: string; name: string; user?: string } };

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
  private bridgeKeys: Promise<Map<string, string>> | undefined;
  private profileAt = 0;
  private key: string | undefined;
  /** Per pass: a thread's first message → how many headers are typed into its text. */
  private typed = new Map<string, number>();
  /** Messages posted to Buzz or sent to Slack so far, for the runner's "last activity". */
  moved = 0;

  constructor(
    private readonly input: Readonly<{
      relay: BridgeRelay;
      slack: SlackCall;
      /** The bridge agent's pubkey, and its owner's. */
      pubkey: string;
      owner: string;
      /** The relay's own key, which signs channel metadata; when known, metadata signed by anyone else is ignored. */
      relayPubkey?: string;
      /** Reads the relay's key, each pass until it's known; until then, private conversations get no channel. */
      relayKey?: () => Promise<string | undefined>;
      conversations: readonly SlackConversation[];
      state: BridgeState;
      save(): void;
      log(line: string): void;
      now?: () => number;
      helperDelayMs?: number;
      newId?: () => string;
    }>,
  ) {
    this.key = input.relayPubkey;
  }

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
    this.bridgeKeys = undefined;
    this.typed.clear();
    if (!this.key && this.input.relayKey) this.key = await this.input.relayKey().catch(() => undefined);
    // The detailed profile has the owner's Slack ID, which tells their own messages from others' with the same text.
    if (!this.state.me?.user && this.now() - this.profileAt > RESOLVE_EVERY_MS) {
      this.profileAt = this.now();
      try {
        const me = parseProfile(await this.input.slack("slack_read_user_profile", {}));
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
          // A Slack message that keeps failing doesn't hold up the owner's sends.
          let failure: unknown;
          await this.inbound(conversation, st).catch((error: unknown) => (failure = error));
          await this.outbound(conversation, st);
          if (failure) throw failure;
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
    const [event] = await this.input.relay.query([{ kinds: [39002], "#d": [channel], ...this.byRelay(), limit: 1 }]);
    const roles = new Map<string, string>();
    for (const tag of event?.tags ?? []) if (tag[0] === "p" && tag[1]) roles.set(tag[1], tag[3] ?? "member");
    return roles;
  }

  private byRelay() {
    return this.key ? { authors: [this.key] } : {};
  }

  /** The Slack bridges in the community (their owners' attestations checked), this one included: key → owner; read once a pass. */
  private bridges(): Promise<Map<string, string>> {
    return (this.bridgeKeys ??= this.input.relay.query([{ kinds: [0], "#t": [BRIDGE_TAG], limit: 500 }]).then((profiles) => {
      const keys = new Map([[this.input.pubkey, this.input.owner]]);
      for (const profile of profiles) {
        const owner = attestedOwner(profile);
        if (owner && !keys.has(profile.pubkey)) keys.set(profile.pubkey, owner);
      }
      return keys;
    }));
  }

  /** Finds or makes the conversation's Buzz channel; every few minutes, or until it has one. */
  private async resolve(conversation: SlackConversation, st: ConversationState) {
    if (st.buzz && this.now() - (st.resolvedAt ?? 0) < RESOLVE_EVERY_MS) return;
    const label = slackLabel(conversation.id);
    const secret = isPrivateKind(conversation.kind);
    // Whose channel it is comes from metadata only the relay's key can vouch for.
    if (secret && !this.key && this.input.relayKey) throw new Error("couldn't read the community's key yet, to check this private conversation's channel");
    const found = (await this.input.relay.query([{ kinds: [39000], "#t": [label], ...this.byRelay(), limit: 50 }]))
      .map(channelOf)
      .filter((channel): channel is Channel => Boolean(channel && channel.labels.includes(label) && channel.private === secret))
      .sort(byAge);
    // A private conversation's channel is always this bridge's own.
    let chosen = found.find((channel) => !secret || channel.creator === this.input.pubkey);
    if (!chosen) {
      // Only for a conversation the owner can read in Slack (this throws otherwise).
      await this.read(conversation, { limit: 1 });
      chosen = await this.create(conversation, label, secret);
    }
    if (st.buzz !== chosen.id) {
      if (st.buzz) this.input.log(`${conversation.id}: now bridged in ${chosen.id} (was ${st.buzz})`);
      // Another channel's history isn't this one's: start over there, with the latest few.
      st.posted = {};
      st.threads = {};
      st.pending = {};
      delete st.failed;
      delete st.stuck;
      delete st.fake;
      delete st.last;
      delete st.out;
      st.buzz = chosen.id;
    }
    st.buzzName = chosen.name;
    st.primary = chosen.creator === this.input.pubkey;
    if (chosen.creator) st.creator = chosen.creator;
    else delete st.creator;
    let roles = await this.members(chosen.id);
    if (!roles.has(this.input.pubkey) && !secret) {
      await this.publish(9021, "", [["h", chosen.id]]);
      roles = await this.members(chosen.id);
    }
    // A channel made while the relay refused to add the owner gets them now.
    if (st.primary && !roles.has(this.input.owner)) {
      await this.publish(9000, "", [["h", chosen.id], ["p", this.input.owner, "", "admin"]]);
      roles = await this.members(chosen.id);
    }
    st.ownerIn = roles.has(this.input.owner);
    st.people = [...roles].filter(([pubkey, role]) => role !== "bot" && pubkey !== this.input.pubkey).length;
    if (!st.primary) {
      // Helpers take turns by key, the channel's maker aside.
      const bridges = await this.bridges();
      const helpers = [...roles.keys()].filter((pubkey) => pubkey !== chosen.creator && (pubkey === this.input.pubkey || bridges.has(pubkey))).sort();
      st.turn = Math.max(0, helpers.indexOf(this.input.pubkey));
    } else delete st.turn;
    st.resolvedAt = this.now();
  }

  private async create(conversation: SlackConversation, label: string, secret: boolean): Promise<Channel> {
    const id = this.input.newId?.() ?? randomUUID();
    const name = buzzChannelName(conversation, this.state.me);
    const about = secret
      ? `Bridged from Slack by its owner's Slack bridge. Everyone in this channel reads the Slack conversation: add only people who are in it on Slack.`
      : `Bridged from the Slack channel #${conversation.name}.`;
    await this.publish(9007, "", [["h", id], ["name", name], ["visibility", secret ? "private" : "open"], ["channel_type", "stream"], ["about", about], ["t", label]]);
    await this.publish(9000, "", [["h", id], ["p", this.input.owner, "", "admin"]]);
    this.input.log(`${conversation.id}: made ${secret ? "private" : "open"} channel ${name} (${id})`);
    return { id, name, private: secret, creator: this.input.pubkey, createdAt: Math.floor(this.now() / 1000), labels: [label] };
  }

  // ── Slack → Buzz ──

  private read(conversation: SlackConversation, args: Readonly<Record<string, unknown>> = { limit: RECENT }) {
    return this.input.slack("slack_read_channel", { channel_id: conversation.id, ...args });
  }

  /** The message at ts, read on its own: undefined when Slack has none (a header typed into another message). */
  private async verify(conversation: SlackConversation, ts: string, parent?: string): Promise<SlackMessage | undefined> {
    if (!parent) return parseOne(await this.read(conversation, { ...around(ts), limit: 1 }), ts);
    // A thread's answer starts with its first message, whose text can hold headers too: the reply's is the first after those.
    let skip = this.typed.get(parent);
    if (skip === undefined) {
      const alone = await this.read(conversation, { ...around(parent), limit: 1 });
      if (!parseOne(alone, parent)) return undefined;
      skip = headers(alone) - 1;
      this.typed.set(parent, skip);
    }
    return parseOne(await this.input.slack("slack_read_thread", { channel_id: conversation.id, message_ts: parent, ...around(ts), limit: 2 }), ts, skip + 1);
  }

  /** A helper waits its turn before checking a message it hasn't posted; true while it's waiting. */
  private waiting(st: ConversationState, message: SlackMessage) {
    // Its owner's own messages, back from Slack, are linked at once.
    if (st.primary || hasFooter(message.text)) return false;
    const first = (st.pending[message.ts] ??= this.now());
    return this.now() - first < (this.input.helperDelayMs ?? HELPER_DELAY_MS) + (st.turn ?? 0) * HELPER_TURN_MS;
  }

  /** Listed ts worth checking: well formed, not from the future, and not already found to be fake. */
  private plausible(st: ConversationState, ts: string) {
    return isTs(ts) && Number(ts) <= this.now() / 1000 + 300 && !st.fake?.includes(ts);
  }

  private markFake(conversation: SlackConversation, st: ConversationState, ts: string) {
    (st.fake ??= []).push(ts);
    if (st.fake.length > KEEP) st.fake.splice(0, st.fake.length - KEEP);
    this.input.log(`${conversation.id}: ${ts} isn't a Slack message (a header inside one?); skipped`);
  }

  private async inbound(conversation: SlackConversation, st: ConversationState) {
    const listed = parseMessages(await this.read(conversation));
    let recent = listed.filter((message) => this.plausible(st, message.ts));
    if (st.last === undefined) {
      // A new channel starts with the latest few, not the whole history.
      st.last = recent.length > BACKFILL ? recent[recent.length - BACKFILL - 1]!.ts : "0";
    }
    // After a gap longer than one read, carry on from the last handled message.
    let fresh = recent;
    if (st.last !== "0" && listed.length >= RECENT && recent.length && Number(recent[0]!.ts) > Number(st.last)) {
      fresh = parseMessages(await this.read(conversation, { oldest: st.last, limit: CATCH_UP })).filter((message) => this.plausible(st, message.ts));
      recent = [];
    }
    const twins = this.twins(st.buzz!);
    const real = new Set<string>();
    for (const listed of fresh) {
      if (Number(listed.ts) <= Number(st.last) || listed.ts in st.posted || this.waiting(st, listed)) {
        real.add(listed.ts);
        continue;
      }
      const message = await this.verify(conversation, listed.ts);
      if (!message) {
        this.markFake(conversation, st, listed.ts);
        continue;
      }
      real.add(message.ts);
      const id = await this.mirror(conversation, st, message, twins);
      if (id !== undefined) {
        st.posted[message.ts] = id;
        delete st.pending[message.ts];
        this.input.save();
      }
    }
    // Thread replies, under the latest messages this bridge has in Buzz.
    for (const message of recent) {
      if (message.thread && real.has(message.ts) && st.posted[message.ts] !== undefined && st.threads[message.ts]?.latest !== message.thread.latest) await this.thread(conversation, st, message, twins);
    }
    // Handled up to the first message still waiting.
    for (const message of fresh) {
      if (Number(message.ts) <= Number(st.last) || !real.has(message.ts)) continue;
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

  private async thread(conversation: SlackConversation, st: ConversationState, parent: SlackMessage, twins: () => Promise<readonly Twin[]>) {
    const seen = (st.threads[parent.ts] ??= { seen: [] });
    const root = st.posted[parent.ts];
    const replies = parseMessages(await this.input.slack("slack_read_thread", { channel_id: conversation.id, message_ts: parent.ts, limit: 200 }));
    let waiting = false;
    for (const listed of replies) {
      if (listed.ts === parent.ts || seen.seen.includes(listed.ts) || !this.plausible(st, listed.ts)) continue;
      // Replies to a message from Buzz whose original wasn't found have nowhere to go.
      let id: string | undefined = "";
      if (root && this.waiting(st, listed)) id = undefined;
      else if (root) {
        const reply = await this.verify(conversation, listed.ts, parent.ts);
        if (!reply) {
          this.markFake(conversation, st, listed.ts);
          continue;
        }
        id = await this.mirror(conversation, st, reply, twins, root);
      }
      if (id === undefined) {
        waiting = true;
        continue;
      }
      seen.seen.push(listed.ts);
      delete st.pending[listed.ts];
      this.input.save();
    }
    if (seen.seen.length > KEEP) seen.seen.splice(0, seen.seen.length - KEEP);
    if (!waiting) seen.latest = parent.thread!.latest;
  }

  /** Recent Buzz messages in the channel, for finding where a message from Buzz came from; read once a pass. */
  private twins(channel: string) {
    let found: Promise<Twin[]> | undefined;
    return () =>
      (found ??= this.input.relay
        .query([{ kinds: [9], "#h": [channel], since: Math.floor(this.now() / 1000) - 6 * 3600, limit: 300 }])
        .then((events) => events.map((event) => ({ norm: norm(event.content), id: event.id, pubkey: event.pubkey, kept: event.content.trim().startsWith("//") }))));
  }

  /**
   * A bridge's post of this Slack message in this channel, by its link. Anyone
   * can make a key and call it a bridge, so another bridge's post counts only
   * with the message's text; this bridge's own, and those of the bridge that
   * made the channel, count as they are, so an edit in Slack isn't posted twice.
   */
  private async postOf(st: ConversationState, link: string, message: SlackMessage): Promise<NostrEvent | undefined> {
    const bridges = await this.bridges();
    const found = await this.input.relay.query([{ kinds: [9], "#h": [st.buzz!], "#r": [link], limit: 20 }]);
    const text = norm(mrkdwn(unfooter(message.text)) || "_(no text)_");
    const trusted = (pubkey: string) => pubkey === this.input.pubkey || pubkey === st.creator;
    return found
      .filter((event) => bridges.has(event.pubkey) && event.content.startsWith(`**${message.name}** · `) && (trusted(event.pubkey) || norm(bridgedText(event.content)) === text))
      .sort((a, b) => a.created_at - b.created_at || (a.id < b.id ? -1 : 1))[0];
  }

  /**
   * Posts a Slack message to Buzz unless it's there already. Resolves with its
   * Buzz event, "" when it won't be posted, or undefined while a helper waits
   * its turn, or after a failure it will try again.
   */
  private async mirror(conversation: SlackConversation, st: ConversationState, message: SlackMessage, twins: () => Promise<readonly Twin[]>, root?: string): Promise<string | undefined> {
    // Sent from Buzz: linked to the original when it's in this channel; otherwise (someone else's Buzz) posted like any message.
    if (hasFooter(message.text)) {
      const text = norm(mrkdwn(message.text));
      const sent = st.out?.sent ?? {};
      const linked = new Set(Object.values(st.posted));
      const me = this.state.me?.user;
      // The owner's own: one this bridge sent as this, or is still sending, when the Slack message is the owner's.
      const own = (found: Twin) => found.pubkey === this.input.owner && (sent[found.id] === message.ts || (sent[found.id] === "" && Boolean(me) && message.user === me));
      // Someone else's: only in a public channel, and only a person with a bridge of their own, not the owner (who sends through this one).
      const owners = isPrivateKind(conversation.kind) ? new Set<string>() : new Set((await this.bridges()).values());
      const theirs = (found: Twin) => found.pubkey !== this.input.owner && owners.has(found.pubkey) && message.user !== me;
      // Not one already linked or kept in Buzz.
      const twin = text ? (await twins()).find((found) => found.norm === text && !found.kept && !linked.has(found.id) && (own(found) || theirs(found))) : undefined;
      if (twin) {
        // A send that timed out did go.
        if (sent[twin.id] === "") sent[twin.id] = message.ts;
        return twin.id;
      }
    }
    if (this.waiting(st, message)) return undefined;
    const link = permalink(conversation.id, message.ts);
    const there = await this.postOf(st, link, message);
    if (there) return there.id;
    const tags = [["h", st.buzz!], ["r", link]];
    if (root) tags.push(["e", root, "", "reply"]);
    try {
      const event = await this.publish(9, bridgedContent({ ...message, text: unfooter(message.text) }, link, Math.floor(this.now() / 1000)), tags);
      this.moved++;
      this.input.log(`${conversation.id}: posted ${message.ts}${root ? " (reply)" : ""}${st.primary ? "" : " as a helper"}`);
      delete st.failed?.[message.ts];
      delete st.stuck?.[message.ts];
      return event.id;
    } catch (error) {
      // The relay didn't answer (a rate limit, a timeout): stop here, in order, and try again next pass; for an hour, then it counts as refused.
      const stuck = (st.stuck ??= {});
      if (!refused(error) && this.now() - (stuck[message.ts] ??= this.now()) < STUCK_MS) throw error;
      // One message the relay won't take doesn't hold up the rest for long.
      const failed = (st.failed ??= {});
      failed[message.ts] = (failed[message.ts] ?? 0) + 1;
      const why = String((error as Error).message ?? error).slice(0, 200);
      if (failed[message.ts]! < TRIES) {
        this.input.log(`${conversation.id}: couldn't post ${message.ts} (try ${failed[message.ts]}): ${why}`);
        return undefined;
      }
      delete failed[message.ts];
      delete stuck[message.ts];
      this.input.log(`${conversation.id}: gave up posting ${message.ts}: ${why}`);
      await this.publish(9, `⚠️ A Slack message couldn't be bridged: ${link}`, [["h", st.buzz!], ...(root ? [["e", root, "", "reply"]] : [])]).catch(() => {});
      return "";
    }
  }

  // ── Buzz → Slack ──

  /** The Slack message a Buzz message stands for: one this bridge saw or sent, or a bridge's post of one in this conversation. */
  private async slackTs(conversation: SlackConversation, st: ConversationState, event: string): Promise<string | undefined> {
    for (const [ts, id] of Object.entries(st.posted)) if (id === event) return ts;
    const sent = st.out?.sent[event];
    if (sent) return sent;
    const [found] = await this.input.relay.query([{ ids: [event], limit: 1 }]);
    if (!found || !(await this.bridges()).has(found.pubkey)) return undefined;
    const link = found.tags.find((tag) => tag[0] === "r")?.[1];
    return link?.includes(`/archives/${conversation.id}/`) ? tsFromLink(link) : undefined;
  }

  /**
   * After a send that timed out: the ts of its copy in Slack; "" when Slack has
   * no message from the owner sent from Buzz since then; undefined when it
   * can't tell (one is there, but its text doesn't match).
   */
  private async sentAs(conversation: SlackConversation, st: ConversationState, id: string, unsure: Unsure): Promise<string | undefined> {
    const me = this.state.me?.user;
    const [event] = await this.input.relay.query([{ ids: [id], limit: 1 }]);
    if (!me || !event) return undefined;
    // The send started before it timed out: from a few minutes before.
    const oldest = `${Math.floor(unsure.at / 1000) - 300}.000000`;
    const listing = unsure.parent
      ? await this.input.slack("slack_read_thread", { channel_id: conversation.id, message_ts: unsure.parent, oldest, limit: 200 })
      : await this.read(conversation, { oldest, limit: CATCH_UP });
    const known = new Set<string>([...Object.values(st.out?.sent ?? {}).filter((ts): ts is string => Boolean(ts)), ...Object.keys(st.posted), ...(unsure.parent ? (st.threads[unsure.parent]?.seen ?? []) : [])]);
    const mine = parseMessages(listing).filter((message) => message.ts !== unsure.parent && message.user === me && hasFooter(message.text) && !known.has(message.ts));
    if (!mine.length) return "";
    const body = norm(bodyOf(event.content.trim()));
    for (const listed of mine) {
      if (norm(mrkdwn(listed.text)) !== body) continue;
      // A header typed into a message isn't one.
      const message = await this.verify(conversation, listed.ts, unsure.parent);
      if (message?.user === me && norm(mrkdwn(message.text)) === body) return message.ts;
    }
    return undefined;
  }

  private async outbound(conversation: SlackConversation, st: ConversationState) {
    const out = (st.out ??= { since: Math.floor(this.now() / 1000), sent: {} });
    const tries = (out.tries ??= {});
    // A send that timed out and hasn't been linked to its copy: Slack is read around when it went, and it goes again only when it isn't there.
    for (const [id, unsure] of Object.entries(out.unsure ?? {})) {
      if (out.sent[id] === "" && this.now() - unsure.at < UNSURE_MS) continue;
      if (out.sent[id] === "") {
        const found = await this.sentAs(conversation, st, id, unsure);
        if (found === undefined) {
          out.sent[id] = null;
          this.input.log(`${conversation.id}: can't tell whether ${id.slice(0, 8)} reached Slack; not sending it again`);
          await this.publish(9, `⚠️ This may not have reached Slack. Check there, and post it again if it's missing.`, [["h", st.buzz!], ["e", unsure.root ?? id, "", "reply"]]).catch(() => {});
        } else if (found) {
          out.sent[id] = found;
          if (unsure.parent) (st.threads[unsure.parent] ??= { seen: [] }).seen.push(found);
          else st.posted[found] = id;
          this.input.log(`${conversation.id}: ${id.slice(0, 8)} did reach Slack, as ${found}`);
        } else {
          delete out.sent[id];
          out.since = Math.min(out.since, unsure.created);
          this.input.log(`${conversation.id}: ${id.slice(0, 8)} isn't in Slack; sending it again`);
        }
      }
      delete out.unsure![id];
      this.input.save();
    }
    const events = await this.input.relay.query([{ kinds: [9], "#h": [st.buzz!], authors: [this.input.owner], since: out.since - 30, limit: 100 }]);
    let roles: Map<string, string> | undefined;
    for (const event of events.sort((a, b) => a.created_at - b.created_at)) {
      if (event.id in out.sent || event.pubkey !== this.input.owner) continue;
      // Who's an agent now: read once a pass, and only when there's something to send.
      const known = (roles ??= await this.members(st.buzz!));
      // A message that will be tried again ends the pass, and `since` (less 30 s) still reads it.
      out.since = Math.max(out.since, event.created_at);
      const text = event.content.trim();
      // "//" keeps a message in Buzz, and so does talking to an agent.
      const agents = event.tags.some((tag) => tag[0] === "p" && known.get(tag[1] ?? "") === "bot");
      const root = threadRoot(event);
      const parent = root ? await this.slackTs(conversation, st, root) : undefined;
      // A thread that started in Buzz stays there too.
      if (!text || text.startsWith("//") || agents || (root && !parent)) {
        out.sent[event.id] = null;
        continue;
      }
      // Marked before it goes, so a restart mid-send never sends it twice.
      out.sent[event.id] = "";
      this.input.save();
      const body = bodyOf(text);
      try {
        const reply = unwrap(await this.input.slack("slack_send_message", { channel_id: conversation.id, message: `${body}\n${FOOTER}`, ...(parent && { thread_ts: parent }) }));
        const ts = String((reply.message_context as { message_ts?: string } | undefined)?.message_ts ?? "");
        out.sent[event.id] = ts || null;
        delete tries[event.id];
        this.moved++;
        if (ts && parent) (st.threads[parent] ??= { seen: [] }).seen.push(ts);
        else if (ts) st.posted[ts] = event.id;
        this.input.log(`${conversation.id}: sent ${event.id.slice(0, 8)} to Slack${parent ? " (reply)" : ""}`);
      } catch (error) {
        const why = String((error as Error).message ?? error).slice(0, 200);
        tries[event.id] = (tries[event.id] ?? 0) + 1;
        if (tries[event.id]! < TRIES && !(error instanceof SlackToolError)) {
          // No answer (a timeout): it may have gone. The mark stays, the copy that comes back from Slack is linked to it, and otherwise it goes again.
          (out.unsure ??= {})[event.id] = { at: this.now(), created: event.created_at, ...(parent && { parent }), ...(root && { root }) };
          this.input.log(`${conversation.id}: no answer sending ${event.id.slice(0, 8)} (try ${tries[event.id]}): ${why}`);
          this.input.save();
          break;
        }
        if (tries[event.id]! < TRIES) {
          // Slack said no, so nothing went out: try again next pass, and send nothing after it before then.
          delete out.sent[event.id];
          this.input.log(`${conversation.id}: couldn't send ${event.id.slice(0, 8)} (try ${tries[event.id]}): ${why}`);
          this.input.save();
          break;
        } else {
          out.sent[event.id] = null;
          delete tries[event.id];
          this.input.log(`${conversation.id}: gave up sending ${event.id.slice(0, 8)}: ${why}`);
          // The reason stays in the log: the channel may be open to everyone.
          await this.publish(9, `⚠️ Couldn't send this to Slack. Try again, or post it in Slack.`, [["h", st.buzz!], ["e", root ?? event.id, "", "reply"]]).catch(() => {});
        }
      }
      this.input.save();
    }
    const sent = Object.keys(out.sent);
    for (const id of sent.slice(0, Math.max(0, sent.length - KEEP))) delete out.sent[id];
  }
}
