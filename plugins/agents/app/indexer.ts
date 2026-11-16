// The Buzz search index, a Databricks App from the Databricks Agents plugin.
// As its own Buzz identity it reads the community's public channels (their
// history, then new messages, edits and deletions as they come) into
// Lakebase, and searches them: on its /api/search route, for the Search page
// in Buzz, and when someone mentions it. Only public channels are indexed,
// which everyone in the community can read already. It runs as the app's
// service principal, in Buzz and in Databricks.
import type { NostrEvent } from "nostr-tools/pure";
import { verifyEvent } from "nostr-tools/pure";
import { BuzzApp } from "./sdk";
import { channelOf, deletionOf, editOf, INDEX_KINDS, messageOf, parseQuery, personOf } from "./index-events";
import { Lakebase, type SearchHit, SearchIndex, searchSchema } from "./index-store";

const PAGE = 200;
const CHANNELS_PER_WATCH = 40;
const DISCOVER_EVERY_MS = 10 * 60_000;

const ago = (seconds: number) => {
  const minutes = Math.max(0, Math.round((Date.now() / 1000 - seconds) / 60));
  if (minutes < 60) return `${minutes}m ago`;
  if (minutes < 48 * 60) return `${Math.round(minutes / 60)}h ago`;
  return `${Math.round(minutes / 1440)}d ago`;
};
const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const app = new BuzzApp({ about: "Searches this community's public channels. Mention me with what you're looking for, or use Search in Buzz." });
const lakebase = new Lakebase(app.databricks);
const index = new SearchIndex(lakebase, searchSchema(app.appName));

const state = {
  ready: false,
  setupError: undefined as string | undefined,
  searchCheck: "not run",
  reading: "",
  readErrors: 0,
  lastIndexed: undefined as number | undefined,
  stats: undefined as Awaited<ReturnType<SearchIndex["stats"]>> | undefined,
};
const relaySigners = new Set<string>();

async function prepare() {
  try {
    const mode = await index.setup();
    state.searchCheck = await index.selfCheck().catch((error: Error) => `failed: ${error.message}`);
    state.ready = true;
    state.setupError = undefined;
    console.log(`[index] ready (${mode}); search check: ${state.searchCheck}`);
  } catch (error) {
    state.setupError = (error as Error).message;
    console.log(`[index] Lakebase isn't ready: ${state.setupError}`);
    setTimeout(() => void prepare(), 30_000).unref();
  }
}

/** Indexes a batch of events: messages first, then edits and deletions, and names for new authors. */
async function take(events: readonly NostrEvent[]) {
  // Its own replies (search results) would only echo other messages.
  const verified = events.filter((event) => event.pubkey !== app.pubkey && verifyEvent(event));
  await index.messages(verified.flatMap((event) => messageOf(event) ?? []));
  for (const event of verified) {
    const edit = editOf(event);
    if (edit) await index.edit(edit);
    const deletion = deletionOf(event, relaySigners);
    if (deletion) await index.deletion(deletion);
  }
  const authors = [...new Set(verified.filter((event) => messageOf(event)).map((event) => event.pubkey))];
  const unnamed = await index.unnamed(authors);
  for (let start = 0; start < unnamed.length; start += 100) {
    const profiles = await app.query([{ kinds: [0], authors: unnamed.slice(start, start + 100) }]);
    await index.people(profiles.filter((event) => verifyEvent(event)).flatMap((event) => personOf(event) ?? []));
  }
  if (verified.length) state.lastIndexed = Math.floor(Date.now() / 1000);
}

/** A channel's history, newest first, from where the last read stopped to its start. */
async function backfill(channel: string, stopped: () => boolean) {
  const cursor = await index.cursor(channel);
  if (cursor.done) return;
  let until = cursor.until ?? Math.floor(Date.now() / 1000);
  while (!stopped()) {
    let events: NostrEvent[];
    try {
      events = await app.query([{ kinds: INDEX_KINDS, "#h": [channel], until, limit: PAGE }]);
    } catch (error) {
      state.readErrors++;
      console.log(`[index] couldn't read ${channel}: ${(error as Error).message.slice(0, 200)}`);
      await index.setCursor(channel, until, false, (error as Error).message.slice(0, 300));
      return;
    }
    if (!events.length) return index.setCursor(channel, until, true);
    await take(events);
    console.log(`[index] ${channel}: read ${events.length} older events`);
    const oldest = Math.min(...events.map((event) => event.created_at));
    // A full page all in one second would repeat forever; step past it.
    until = events.length >= PAGE && oldest >= until ? until - 1 : oldest;
    await index.setCursor(channel, until, events.length < PAGE);
    if (events.length < PAGE) return;
    await pause(250);
  }
}

app.onConnect(() => {
  let stopped = false;
  let watches: (() => void)[] = [];
  let watching = "";
  const stopWatches = () => {
    for (const stop of watches) stop();
    watches = [];
  };
  const discover = async () => {
    if (stopped) return;
    if (!state.ready) return void setTimeout(() => void discover(), 10_000);
    try {
      const metadata = (await app.query([{ kinds: [39000], limit: 5000 }])).filter((event) => verifyEvent(event));
      const channels = metadata.flatMap((event) => channelOf(event) ?? []);
      for (const channel of channels) relaySigners.add(channel.signer);
      await index.channels(channels);
      const open = channels.filter((channel) => channel.public).map((channel) => channel.id).sort();
      console.log(`[index] found ${channels.length} channels, ${open.length} public`);
      // New messages, edits and deletions in public channels, from now on.
      if (open.join() !== watching) {
        stopWatches();
        watching = open.join();
        const since = Math.floor(Date.now() / 1000) - 60;
        for (let start = 0; start < open.length; start += CHANNELS_PER_WATCH)
          watches.push(app.relay!.watch({ kinds: INDEX_KINDS, "#h": open.slice(start, start + CHANNELS_PER_WATCH) }, since, (event) => void take([event]).catch((error: Error) => console.log(`[index] couldn't index ${event.id.slice(0, 8)}: ${error.message}`)), 5000));
      }
      // Then the history, one channel at a time.
      for (const channel of open) {
        if (stopped) break;
        state.reading = channel;
        await backfill(channel, () => stopped);
      }
      state.reading = "";
      state.stats = await index.stats();
      console.log(`[index] ${state.stats.messages} messages in ${state.stats.backfilled}/${state.stats.publicChannels} public channels`);
    } catch (error) {
      console.log(`[index] discovery failed: ${(error as Error).message}`);
    }
    if (!stopped) setTimeout(() => void discover(), DISCOVER_EVERY_MS).unref();
  };
  void discover();
  return () => {
    stopped = true;
    stopWatches();
  };
});

function format(query: string, hits: readonly SearchHit[]): string {
  if (!hits.length) return `I didn't find anything for “${query}” in public channels.`;
  return [
    `Here's what I found for “${query}”:`,
    ...hits.map((hit, n) => `${n + 1}. **#${hit.channelName}** · ${hit.authorName ?? `${hit.author.slice(0, 8)}…`} · ${ago(hit.createdAt)}\n   ${hit.snippet.replace(/\s+/g, " ")}`),
  ].join("\n\n");
}

app.onMention(async (mention, reply) => {
  const query = mention.text.replace(/^(search( for)?|find|look up)\s+/i, "").trim();
  if (!query) return reply.say("Tell me what to look for, like “quarterly planning” or “from:@sam in:#general after:2026-11-01 launch”.");
  if (!state.ready) return reply.say(`I can't search yet: ${state.setupError ?? "I'm still setting up my index."}`);
  const stop = reply.typing();
  const hits = await index.search(query, 5).finally(stop);
  await reply.say(format(query, hits));
});

// Version 2: filters, and the people and channels routes.
app.route("/api/info", () => ({ json: { kind: "buzz-search", version: 2, name: app.identity?.name ?? app.appName, ready: state.ready } }));

app.route("/api/search", async (request) => {
  const query = request.url.searchParams.get("q") ?? "";
  const limit = Number(request.url.searchParams.get("limit") ?? 20);
  if (!state.ready) return { status: 503, json: { error: state.setupError ?? "The index is still setting up." } };
  const parsed = parseQuery(query);
  const hits = await index.search(parsed, Number.isFinite(limit) ? limit : 20);
  // Who searched, for the app's logs; not what they searched for.
  console.log(`[index] search by ${request.user ?? "unknown"}: ${hits.length} results`);
  return { json: { results: hits, query: parsed, mode: index.mode, ...(state.stats && { indexed: state.stats }) } };
});

// Suggestions for the Search page as people type @ or #.
app.route("/api/people", async (request) => {
  if (!state.ready) return { status: 503, json: { error: state.setupError ?? "The index is still setting up." } };
  return { json: { people: await index.suggestPeople(request.url.searchParams.get("q") ?? "", Number(request.url.searchParams.get("limit") ?? 8) || 8) } };
});
app.route("/api/channels", async (request) => {
  if (!state.ready) return { status: 503, json: { error: state.setupError ?? "The index is still setting up." } };
  return { json: { channels: await index.suggestChannels(request.url.searchParams.get("q") ?? "", Number(request.url.searchParams.get("limit") ?? 8) || 8) } };
});

app.describe(() => ({
  index: state.ready ? `ready (${index.mode === "bm25" ? "Lakebase Search" : "Postgres full-text"})` : (state.setupError ?? "setting up"),
  searchCheck: state.searchCheck,
  ...(index.extensions.length && { extensions: index.extensions.join(", ") }),
  ...(index.mode !== "bm25" && index.extensionError && { lakebaseSearch: `not on in this database: ${index.extensionError.slice(0, 200)}` }),
  ...(state.stats && { indexed: `${state.stats.messages} messages in ${state.stats.backfilled}/${state.stats.publicChannels} public channels read so far` }),
  ...(state.reading && { reading: state.reading }),
  ...(state.readErrors && { readErrors: state.readErrors }),
  ...(state.lastIndexed && { lastIndexed: new Date(state.lastIndexed * 1000).toISOString() }),
}));

void prepare();
void app.start();
setInterval(() => {
  if (state.ready) void index.stats().then((stats) => (state.stats = stats), () => {});
}, 60_000).unref();
