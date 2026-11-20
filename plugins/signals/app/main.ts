// The signals hub, a Databricks App with a Lakebase database.
//
// It takes events from each person's sources (their scheduled poller job, the
// Signals plugin, agents) on POST /api/events or, for poller jobs, through
// the inbox table in Lakebase (see SignalsStore.setupInbox), keeps one row per thing, and
// runs the rules to open and update tasks. As its own Buzz identity (when it
// has one) it posts each new task in its account's channel and replies in the
// task's thread as the task changes. Everything runs as the app's service
// principal; who's asking comes from Databricks Apps (X-Forwarded-Email).
//
// app.yaml: a `postgres` resource, LAKEBASE_ENDPOINT (valueFrom: postgres) and,
// for posting to Buzz, BUZZ_IDENTITY_SECRET. Optional: SIGNALS_ADMINS (emails
// that may change the rules), SIGNALS_CONFIG (the starting rules, as JSON),
// SIGNALS_CLASSIFIER (the serving endpoint for rules' `classify`; "off" turns it off),
// SIGNALS_TITLER (the chat endpoint for rules' `summarize_title`; "off" turns it off).
import { readFile } from "node:fs/promises";
import { BuzzApp } from "../../agents/app/sdk";
import { Lakebase } from "../../agents/app/index-store";
import { splitMessage } from "../../agents/runner/buzz";
import { chatTitler, chatTriggerer, jevCategorizer, jevClassifier, DEFAULT_CLASSIFIER_ENDPOINT, DEFAULT_TITLER_ENDPOINT } from "./classify";
import { Hub, HUB_PATHS, type Notifier, taskMessage } from "./hub";
import { configProblems, type SignalsConfig } from "./model";
import { schemaName, SignalsStore } from "./store";

const SWEEP_MS = 5 * 60_000;
const INBOX_MS = 30_000;

const app = new BuzzApp({ about: "Turns events from your sources into tasks in your account channels. Mention me with “tasks” to see what's open." });
const lakebase = new Lakebase(app.databricks);
// The pool is made on first use, so a missing database resource shows on the status page instead of crashing.
const store = new SignalsStore({ query: (text, values) => lakebase.db().query(text, values) as never }, schemaName(process.env.SIGNALS_SCHEMA || app.appName));

async function startingConfig(): Promise<SignalsConfig | undefined> {
  const raw = process.env.SIGNALS_CONFIG || (await readFile(new URL("./signals.config.json", import.meta.url), "utf8").catch(() => ""));
  if (!raw.trim()) return undefined;
  try {
    const config = JSON.parse(raw) as SignalsConfig;
    const problems = configProblems(config);
    if (problems.length) throw new Error(problems.join("; "));
    return config;
  } catch (error) {
    console.log(`[signals] the starting config isn't used: ${(error as Error).message}`);
    return undefined;
  }
}

const notifier: Notifier = {
  async opened(task, agents = [], context = {}) {
    if (!app.relay || !task.channel) return undefined;
    const event = await app.publish({ kind: 9, created_at: Math.floor(Date.now() / 1000), content: taskMessage(task, { agents, ...context }), tags: [["h", task.channel], ...agents.map((key) => ["p", key])] });
    return event.id;
  },
  async updated(task, text, agents = []) {
    if (!app.relay || !task.channel || !task.buzz_root) return;
    // Only the first part mentions the agents, so a long message wakes them once.
    for (const [n, part] of splitMessage(text).entries())
      await app.publish({ kind: 9, created_at: Math.floor(Date.now() / 1000), content: part, tags: [["h", task.channel], ["e", task.buzz_root, "", "reply"], ...(n === 0 ? agents.map((key) => ["p", key]) : [])] });
  },
  // The channel's member list (kind 39002) names the hub when it can post there (null).
  async canPost(channel) {
    if (!app.relay || !app.pubkey) return "The hub isn't signed in to Buzz yet, so it can't post tasks. Check BUZZ_IDENTITY_SECRET in app.yaml and the app's status page.";
    const [members] = await app.query([{ kinds: [39002], "#d": [channel], limit: 1 }]);
    // The relay shows a channel's member list only to its members, so not seeing it most likely means the hub isn't one.
    if (!members) return `${app.identity?.name || "The hub"} can't see this channel's member list, which usually means it isn't a member, so tasks won't be posted here. Add it to the channel (Add people), then save again.`;
    if (members.tags.some((tag) => tag[0] === "p" && tag[1] === app.pubkey)) return null;
    return `${app.identity?.name || "The hub"} isn't a member of this channel, so it can't post tasks here. Add it to the channel (Add people), then save again.`;
  },
  // An author edit (kind 40003) of the task's first message: Buzz shows the latest one in its place.
  async edited(task, text) {
    if (!app.relay || !task.channel || !task.buzz_root) return;
    await app.publish({ kind: 40003, created_at: Math.floor(Date.now() / 1000), content: text, tags: [["h", task.channel], ["e", task.buzz_root]] });
  },
};

const state = { ready: false, setupError: undefined as string | undefined, lastSweep: undefined as string | undefined, lastInbox: undefined as string | undefined, stats: undefined as Awaited<ReturnType<SignalsStore["stats"]>> | undefined };
let hub: Hub | undefined;

async function prepare() {
  try {
    await store.setup();
    const admins = (process.env.SIGNALS_ADMINS ?? "").split(",").map((admin) => admin.trim()).filter(Boolean);
    const defaultConfig = await startingConfig();
    const log = (line: string) => console.log(`[signals] ${line}`);
    const endpoint = process.env.SIGNALS_CLASSIFIER?.trim() || DEFAULT_CLASSIFIER_ENDPOINT;
    const classifier = endpoint === "off" ? undefined : jevClassifier((path, init) => app.databricks.api(path, init), endpoint, log);
    // Rules' categories without a matching `when` are picked by the same model (see Rule.categories).
    if (endpoint !== "off") store.categorizer = jevCategorizer((path, init) => app.databricks.api(path, init), endpoint, log);
    // Rules' summarize_title: short titles from a fast chat model (SIGNALS_TITLER names another endpoint, or "off").
    const titler = process.env.SIGNALS_TITLER?.trim() || DEFAULT_TITLER_ENDPOINT;
    if (titler !== "off") store.titler = chatTitler((path, init) => app.databricks.api(path, init), titler, log);
    // Workstreams' default actions: which ticked triggers hold, from the same fast chat model unless SIGNALS_TRIGGERS names another ("off": a row's triggers are never checked, so its tasks go to agents as without one).
    const triggers = process.env.SIGNALS_TRIGGERS?.trim() || DEFAULT_TITLER_ENDPOINT;
    const triggerer = triggers === "off" ? undefined : chatTriggerer((path, init) => app.databricks.api(path, init), triggers, log);
    // Where people's poller jobs log in: this app's own database resource.
    const { LAKEBASE_ENDPOINT, PGHOST, PGDATABASE, PGPORT } = process.env;
    const lakebaseInfo = LAKEBASE_ENDPOINT && PGHOST && PGDATABASE ? { endpoint: LAKEBASE_ENDPOINT, host: PGHOST, database: PGDATABASE, ...(PGPORT && PGPORT !== "5432" && { port: Number(PGPORT) }) } : undefined;
    hub = new Hub(store, notifier, { ...(lakebaseInfo && { lakebase: lakebaseInfo }), ...(admins.length && { admins }), ...(defaultConfig && { defaultConfig }), ...(classifier && { classifier }), ...(triggerer && { triggerer }), log });
    state.ready = true;
    state.setupError = undefined;
    state.stats = await store.stats();
    console.log(`[signals] ready in schema ${store.schema}`);
  } catch (error) {
    state.setupError = (error as Error).message;
    console.log(`[signals] Lakebase isn't ready: ${state.setupError}`);
    setTimeout(() => void prepare(), 30_000).unref();
  }
}

for (const path of HUB_PATHS)
  app.route(path, async (request) => {
    if (!hub) return path === "/api/info" ? { json: { kind: "signals-hub", version: 1, ready: false } } : { status: 503, json: { error: state.setupError ?? "The hub is still setting up." } };
    const reply = await hub.handle({ method: request.method, path, query: request.url.searchParams, ...(request.user && { user: request.user }), body: request.body });
    return { status: reply.status ?? 200, json: reply.json };
  });

app.onMention(async (mention, reply) => {
  if (!hub) return reply.say(`I'm not ready yet: ${state.setupError ?? "still setting up"}.`);
  const tasks = await store.tasks({ open: true, channel: mention.channel, limit: 15 });
  const all = tasks.length ? tasks : await store.tasks({ open: true, limit: 15 });
  if (!all.length) return reply.say("No open tasks.");
  await reply.say([tasks.length ? "Open tasks in this channel:" : "No open tasks in this channel. Open tasks everywhere:", ...all.map((task) => `- **${task.id}** ${task.title}${task.account ? ` · ${task.account}` : ""} · ${task.status} · ${task.event_count} event${task.event_count === 1 ? "" : "s"}`)].join("\n"));
});

app.describe(() => ({
  hub: state.ready ? `ready (schema ${store.schema})` : (state.setupError ?? "setting up"),
  ...(state.stats && { tracked: `${state.stats.events} events, ${state.stats.open}/${state.stats.tasks} tasks open, ${state.stats.people} people with sources on` }),
  ...(state.lastSweep && { lastSweep: state.lastSweep }),
  ...(state.lastInbox && { lastInbox: state.lastInbox }),
}));

setInterval(() => {
  if (!hub) return;
  void hub
    .sweep()
    .then(async (result) => {
      state.lastSweep = `${new Date().toISOString()}: posted ${result.posted}, nudged ${result.nudged}, finished ${result.finished}`;
      state.stats = await store.stats();
    })
    .catch((error: Error) => (state.lastSweep = `failed: ${error.message}`));
}, SWEEP_MS).unref();

// Poller jobs that can't call the app (their tokens aren't OAuth) write to the inbox in Lakebase.
let draining = false;
setInterval(() => {
  if (!hub || draining) return;
  draining = true;
  void hub
    .drain()
    .then((result) => {
      if (result.handled || result.failed) state.lastInbox = `${new Date().toISOString()}: handled ${result.handled}, failed ${result.failed}`;
    })
    .catch((error: Error) => (state.lastInbox = `failed: ${error.message}`))
    .finally(() => (draining = false));
}, INBOX_MS).unref();
// Agents asked to work on a task reply in its thread; the hub records the first reply on the task.
const COLLECT_MS = 60_000;
setInterval(() => {
  if (!hub || !app.relay) return;
  void hub
    .collect((filters) => app.query(filters))
    .then((result) => {
      if (result.recorded) console.log(`[signals] recorded ${result.recorded} agent repl${result.recorded === 1 ? "y" : "ies"}`);
    })
    .catch((error: Error) => console.log(`[signals] couldn't check agent replies: ${error.message}`));
}, COLLECT_MS).unref();
setInterval(() => void store.pruneInbox().catch(() => {}), 6 * 3600_000).unref();

void prepare();
void app.start();
