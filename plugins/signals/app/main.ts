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
// that may change the rules), SIGNALS_CONFIG (the starting rules, as JSON).
import { readFile } from "node:fs/promises";
import { BuzzApp } from "../../agents/app/sdk";
import { Lakebase } from "../../agents/app/index-store";
import { splitMessage } from "../../agents/runner/buzz";
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
};

const state = { ready: false, setupError: undefined as string | undefined, lastSweep: undefined as string | undefined, lastInbox: undefined as string | undefined, stats: undefined as Awaited<ReturnType<SignalsStore["stats"]>> | undefined };
let hub: Hub | undefined;

async function prepare() {
  try {
    await store.setup();
    const admins = (process.env.SIGNALS_ADMINS ?? "").split(",").map((admin) => admin.trim()).filter(Boolean);
    const defaultConfig = await startingConfig();
    hub = new Hub(store, notifier, { ...(admins.length && { admins }), ...(defaultConfig && { defaultConfig }), log: (line) => console.log(`[signals] ${line}`) });
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
      state.lastSweep = `${new Date().toISOString()}: posted ${result.posted}, nudged ${result.nudged}`;
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
