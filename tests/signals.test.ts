// Signals: events → dedupe → rules → tasks, on a real Postgres (PGlite).
import { readFileSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";
import { beforeEach, describe, expect, it } from "vitest";
import { accountRule, configProblems, decide, type EventInput, modeFor, parsePreferences, ruleFor, type SignalsConfig, validateEvent, withAccounts } from "../plugins/signals/app/model";
import { agentKey, eventDetails, Hub, HUB_PATHS, taskMessage } from "../plugins/signals/app/hub";
import { npubEncode } from "nostr-tools/nip19";
import { rpcSignIn } from "../plugins/signals/src/client";
import { contentHash, type Db, SignalsStore } from "../plugins/signals/app/store";

const config: SignalsConfig = {
  version: 1,
  first_run_seen: true,
  default_channel: "triage",
  accounts: [{ name: "Acme", channel: "acme", aliases: ["ACME Corp"], when: { actor: "@acme\\.com$" } }],
  rules: [
    { id: "newsletters", sources: ["gmail"], when: { actor: "noreply" }, action: "ignore" },
    { id: "customer-mail", sources: ["gmail"], when: { actor: "@acme\\.com$" }, action: "task", title: "Reply: {title}", workstream: "questions", group_by: "group_key" },
    { id: "case-updates", sources: ["table.*"], when: { "payload.status": ["Awaiting Confirmation", "Open"] }, action: "task", group_by: "external_id", stale_after_hours: 72, nudge: "Case {external_id} has waited {hours}h for confirmation" },
    { id: "auto-increase", sources: ["table.quota"], when: { "payload.kind": "auto" }, action: "update", group: "quota", group_by: "payload.workspace" },
    { id: "quota-requests", sources: ["table.quota"], action: "task", group: "quota", group_by: "payload.workspace" },
  ],
};

function pglite(): Db {
  const db = new PGlite();
  return { query: async (text, values) => ({ rows: (await db.query(text, values)).rows as never[] }) };
}

describe("events", () => {
  it("validates what sources send", () => {
    expect(validateEvent({ source: "gmail", external_id: 42, title: "  hi  " })).toEqual({ source: "gmail", external_id: "42", title: "hi" });
    expect(validateEvent({ source: "Gmail!", external_id: "1" })).toMatch(/source/);
    expect(validateEvent({ source: "gmail" })).toMatch(/external_id/);
    expect(validateEvent({ source: "gmail", external_id: "1", payload: [] })).toMatch(/payload/);
    expect(validateEvent({ source: "gmail", external_id: "1", occurred_at: "yesterday" })).toMatch(/occurred_at/);
  });

  it("hashes content, not key order or when it was seen", () => {
    const a = contentHash({ source: "s", external_id: "1", title: "t", payload: { a: 1, b: { c: 2, d: 3 } } });
    expect(contentHash({ source: "s", external_id: "1", occurred_at: 5, payload: { b: { d: 3, c: 2 }, a: 1 }, title: "t" })).toBe(a);
    expect(contentHash({ source: "s", external_id: "1", title: "t", payload: { a: 2, b: { c: 2, d: 3 } } })).not.toBe(a);
  });

  it("checks configs", () => {
    expect(configProblems(config)).toEqual([]);
    expect(configProblems({ version: 1, rules: [{ id: "a", action: "task", when: { title: "(" } }, { id: "a", action: "nope" }] })).toEqual([
      "rules[0].when.title isn't a valid regular expression",
      "rules[1].id a is used twice",
      "rules[1].action must be task, update or ignore",
    ]);
  });

  it("decides with the first matching rule, and finds the account", () => {
    const mail = { source: "gmail", external_id: "m1", actor: "sam@acme.com", title: "Question about pricing", group_key: "thread-1" };
    expect(decide(config, mail, { firstRun: false })).toMatchObject({ kind: "task", title: "Reply: Question about pricing", account: { name: "Acme" }, channel: "acme", group: "customer-mail|thread-1", create: true });
    expect(decide(config, { ...mail, actor: "noreply@acme.com" }, { firstRun: false })).toMatchObject({ kind: "none", reason: "rule newsletters ignores it" });
    expect(decide(config, { source: "gmail", external_id: "x", actor: "me@other.com" }, { firstRun: false })).toMatchObject({ kind: "none" });
    expect(decide(config, mail, { firstRun: true })).toMatchObject({ create: false });
    expect(decide(config, { source: "table.cases", external_id: "C-1", account: "acme corp", payload: { status: "Open" } }, { firstRun: false })).toMatchObject({ account: { name: "Acme", channel: "acme" } });
    expect(decide(config, { source: "table.quota", external_id: "q1", payload: { kind: "auto", workspace: "w1" } }, { firstRun: false })).toMatchObject({ create: false, group: "quota|w1" });
  });

  it("groups by a template of fields, so new tickets for the same thing share a task", () => {
    const rules: SignalsConfig = {
      version: 1,
      rules: [
        { id: "auto", sources: ["jira"], when: { title: "auto.?increase" }, action: "update", group: "limits", group_by: "{payload.workspace}/{payload.model}" },
        { id: "limits", sources: ["jira"], action: "task", group_by: "{payload.workspace}/{payload.model}" },
      ],
    };
    expect(configProblems(rules)).toEqual([]);
    const ticket = (key: string, title: string, payload?: Record<string, unknown>) => decide(rules, { source: "jira", external_id: key, title, ...(payload && { payload }) }, { firstRun: false });
    expect(ticket("ES-1", "Rate limit increase", { workspace: "123", model: "Claude Sonnet" })).toMatchObject({ create: true, group: "limits|123/claude sonnet" });
    expect(ticket("ES-2", "Auto increase", { workspace: "123", model: "claude sonnet " })).toMatchObject({ create: false, group: "limits|123/claude sonnet" });
    // Without any of its fields, an event is its own group.
    expect(ticket("ES-3", "Something else")).toMatchObject({ group: "limits|jira:ES-3" });
  });
});

describe("the store", () => {
  let store: SignalsStore;
  beforeEach(async () => {
    store = new SignalsStore(pglite(), "signals_test");
    await store.setup();
    await store.setup(); // twice is fine
  });

  const mail = (id: string, thread: string, title = "Question") => ({ source: "gmail", external_id: id, actor: "sam@acme.com", title, group_key: thread });

  it("skips sources a person hasn't turned on", async () => {
    const result = await store.ingest("alice@x.com", [mail("m1", "t1")], config);
    expect(result).toMatchObject({ skipped: 1, new: 0, created: [] });
  });

  it("records what's there on the first run, then opens tasks for new events", async () => {
    await store.setSource("alice@x.com", "gmail", true);
    const first = await store.ingest("alice@x.com", [mail("m1", "t1")], config);
    expect(first).toMatchObject({ firstRun: true, new: 1, created: [] });
    const second = await store.ingest("alice@x.com", [mail("m1", "t1"), mail("m2", "t2", "Pricing?")], config);
    expect(second).toMatchObject({ firstRun: false, new: 1, same: 1 });
    expect(second.created.map((task) => [task.title, task.account, task.channel, task.event_count])).toEqual([["Reply: Pricing?", "Acme", "acme", 1]]);
  });

  it("dedupes: the same content is seen again, changed content updates the task, a thread shares one task", async () => {
    await store.setSource("alice@x.com", "gmail", true);
    await store.ingest("alice@x.com", [], config);
    await store.ingest("alice@x.com", [{ source: "gmail", external_id: "seed", title: "x" }], config); // first post done
    const opened = await store.ingest("alice@x.com", [mail("m1", "t1")], config);
    const task = opened.created[0]!;
    expect((await store.ingest("alice@x.com", [mail("m1", "t1")], config))).toMatchObject({ same: 1, updated: [] });
    const changed = await store.ingest("alice@x.com", [mail("m1", "t1", "Question (edited)")], config);
    expect(changed).toMatchObject({ changed: 1 });
    expect(changed.updated.map((u) => u.task.id)).toEqual([task.id]);
    const reply = await store.ingest("alice@x.com", [mail("m3", "t1", "Re: Question")], config);
    expect(reply.created).toEqual([]);
    expect(reply.updated[0]?.task).toMatchObject({ id: task.id, event_count: 3 });
    const detail = await store.detail(task.id);
    expect(detail?.events.map((e) => e.external_id).sort()).toEqual(["m1", "m3"]);
    expect(detail?.activities[0]).toMatchObject({ kind: "opened" });
  });

  it("shares a task between people who get the same thing", async () => {
    for (const person of ["alice@x.com", "bob@x.com"]) {
      await store.setSource(person, "gmail", true);
      await store.ingest(person, [{ source: "gmail", external_id: "seed", title: "x" }], config);
    }
    const a = await store.ingest("alice@x.com", [mail("alice-copy", "t9")], config);
    const b = await store.ingest("bob@x.com", [mail("bob-copy", "t9")], config);
    expect(a.created).toHaveLength(1);
    expect(b.created).toHaveLength(0);
    expect(b.updated[0]?.task.id).toBe(a.created[0]!.id);
  });

  it("only updates for update rules, reopens closed tasks on new events, and tracks status, activity and artifacts", async () => {
    await store.setSource("alice@x.com", "table.quota", true);
    await store.ingest("alice@x.com", [], config);
    await store.ingest("alice@x.com", [{ source: "table.quota", external_id: "seed" }], config);
    const auto = await store.ingest("alice@x.com", [{ source: "table.quota", external_id: "q1", payload: { kind: "auto", workspace: "w1" } }], config);
    expect(auto).toMatchObject({ new: 1, created: [], updated: [] });
    // A request opens the workspace's task; a later auto increase for it lands on that task.
    const request = (await store.ingest("alice@x.com", [{ source: "table.quota", external_id: "q2", payload: { kind: "manual", workspace: "w2" } }], config)).created[0]!;
    const later = await store.ingest("alice@x.com", [{ source: "table.quota", external_id: "q3", payload: { kind: "auto", workspace: "w2" } }], config);
    expect(later).toMatchObject({ created: [] });
    expect(later.updated.map((u) => u.task.id)).toEqual([request.id]);

    await store.setSource("alice@x.com", "gmail", true);
    await store.ingest("alice@x.com", [{ source: "gmail", external_id: "seed" }], config);
    const task = (await store.ingest("alice@x.com", [mail("m1", "t1")], config)).created[0]!;
    await store.setStatus(task.id, "done", "alice@x.com", "answered");
    await store.artifact(task.id, "alice@x.com", "doc", "https://docs.example/1", "Answer");
    await store.ingest("alice@x.com", [mail("m2", "t1", "One more question")], config);
    const detail = await store.detail(task.id);
    expect(detail?.task.status).toBe("open");
    expect(detail?.activities.map((a) => a.kind)).toEqual(["opened", "status", "status"]);
    expect(detail?.artifacts).toMatchObject([{ url: "https://docs.example/1", title: "Answer" }]);
    expect((await store.tasks({ open: true, account: "acme" })).map((t) => t.id)).toEqual([task.id]);
  });

  it("nudges tasks whose latest event still matches after the stale time, once per period", async () => {
    await store.setSource("alice@x.com", "table.cases", true);
    await store.ingest("alice@x.com", [{ source: "table.cases", external_id: "seed" }], config);
    const task = (await store.ingest("alice@x.com", [{ source: "table.cases", external_id: "C-7", title: "Case 7", payload: { status: "Awaiting Confirmation" } }], config)).created[0]!;
    const later = Math.floor(Date.now() / 1000) + 73 * 3600;
    expect(await store.stale(config)).toEqual([]);
    const stale = await store.stale(config, later);
    expect(stale.map((s) => [s.task.id, s.text])).toEqual([[task.id, "Case C-7 has waited 73h for confirmation"]]);
    await store.nudged(task.id, stale[0]!.text, later);
    expect(await store.stale(config, later)).toEqual([]);
    // Moved on to a status the rule doesn't match: no nudge.
    await store.ingest("alice@x.com", [{ source: "table.cases", external_id: "C-7", title: "Case 7", payload: { status: "Closed" } }], config);
    expect(await store.stale(config, later + 200 * 3600)).toEqual([]);
  });

  it("turns a source off, and forgets its events when asked", async () => {
    await store.setSource("alice@x.com", "gmail", true);
    await store.ingest("alice@x.com", [mail("m1", "t1")], config);
    await store.setSource("alice@x.com", "gmail", false, undefined, true);
    expect(await store.ingest("alice@x.com", [mail("m2", "t2")], config)).toMatchObject({ skipped: 1 });
    expect((await store.sources("alice@x.com"))[0]).toMatchObject({ source: "gmail", enabled: false });
    expect(await store.stats()).toMatchObject({ events: 0, people: 0 });
  });

  it("keeps an inbox each person can write only as themselves, and read only their own sources from", async () => {
    const pg = new PGlite();
    const db: Db = { query: async (text, values) => ({ rows: (await pg.query(text, values)).rows as never[] }) };
    const store = new SignalsStore(db, "signals_inbox");
    await store.setup();
    await store.setup();
    await store.setSource("alice@x.com", "gmail", true);
    await store.setSource("bob@x.com", "gmail", true);
    await pg.exec(`CREATE ROLE "Alice@X.com"`);
    await pg.exec(`SET ROLE "Alice@X.com"`);
    try {
      // Alice sees only her own sources, and only the columns a poller needs.
      expect((await pg.query(`SELECT source, enabled, cursor FROM signals_inbox.sources`)).rows).toEqual([{ source: "gmail", enabled: true, cursor: null }]);
      await expect(pg.query(`SELECT owner FROM signals_inbox.sources`)).rejects.toThrow(/permission/);
      await pg.query(`INSERT INTO signals_inbox.inbox (kind, body) VALUES ('events', $1)`, [JSON.stringify({ events: [mail("m1", "t1")] })]);
      // She can't post as anyone else, or mark a post handled.
      await expect(pg.query(`INSERT INTO signals_inbox.inbox (owner, kind, body) VALUES ('bob@x.com', 'events', '{}')`)).rejects.toThrow(/permission/);
      await expect(pg.query(`UPDATE signals_inbox.inbox SET done_at = 1`)).rejects.toThrow(/permission/);
      await expect(pg.query(`UPDATE signals_inbox.sources SET enabled = true`)).rejects.toThrow(/permission/);
    } finally {
      await pg.exec(`RESET ROLE`);
    }
    const hub = new Hub(store, undefined, { defaultConfig: config });
    expect(await store.inbox()).toMatchObject([{ owner: "Alice@X.com", kind: "events" }]);
    expect(await hub.drain()).toEqual({ handled: 1, failed: 0 });
    expect(await store.inbox()).toEqual([]);
    expect(await store.stats()).toMatchObject({ events: 1 });
    expect((await store.sources("alice@x.com"))[0]).toMatchObject({ last_count: 1 });
    await pg.exec(`SET ROLE "Alice@X.com"`);
    try {
      expect((await pg.query(`SELECT kind, done_at IS NOT NULL AS done FROM signals_inbox.inbox`)).rows).toEqual([{ kind: "events", done: true }]);
    } finally {
      await pg.exec(`RESET ROLE`);
    }
    await store.pruneInbox(0, Math.floor(Date.now() / 1000) + 10);
    expect((await pg.query(`SELECT count(*)::int AS n FROM signals_inbox.inbox`)).rows).toEqual([{ n: 0 }]);
  });

  it("keeps its config", async () => {
    expect(await store.config()).toBeUndefined();
    await store.saveConfig(config, "alice@x.com");
    expect((await store.config())?.rules).toHaveLength(5);
  });
});

describe("the hub API", () => {
  const posts: { kind: string; task: number; text?: string }[] = [];
  const notifier = {
    async opened(task: { id: number }) {
      posts.push({ kind: "opened", task: task.id });
      return `root-${task.id}`;
    },
    async updated(task: { id: number }, text: string) {
      posts.push({ kind: "updated", task: task.id, text });
    },
  };
  let hub: Hub;
  beforeEach(async () => {
    posts.length = 0;
    const store = new SignalsStore(pglite(), "signals_hub");
    await store.setup();
    hub = new Hub(store, notifier, { admins: ["admin@x.com"], defaultConfig: config });
  });
  const ANON = "";
  const call = (method: string, path: string, body?: unknown, user = "Alice@X.com", query = "") =>
    hub.handle({ method, path, query: new URLSearchParams(query), ...(user && { user }), body: async () => (body === undefined ? "" : JSON.stringify(body)) });

  it("needs a signed-in person, and takes the owner from the request", async () => {
    expect((await call("GET", "/api/info", undefined, ANON)).json).toMatchObject({ kind: "signals-hub" });
    expect(await call("GET", "/api/sources", undefined, ANON)).toMatchObject({ status: 401 });
    await call("POST", "/api/sources", { source: "gmail", enabled: true });
    // Bob's post for gmail is skipped: he hasn't turned it on, whatever the body says.
    expect((await call("POST", "/api/events", { events: [{ source: "gmail", external_id: "1", owner: "alice@x.com" }] }, "bob@x.com")).json).toMatchObject({ skipped: 1 });
    expect((await call("GET", "/api/sources")).json).toMatchObject({ sources: [{ source: "gmail", enabled: true }] });
  });

  it("ingests, posts new tasks and their updates to Buzz, and reports bad events", async () => {
    await call("POST", "/api/sources", { source: "gmail", enabled: true });
    await call("POST", "/api/events", { events: [{ source: "gmail", external_id: "seed" }] });
    const reply = await call("POST", "/api/events", { events: [{ source: "gmail", external_id: "m1", actor: "sam@acme.com", title: "Q", group_key: "t1" }, { source: "gmail" }] });
    expect(reply.json).toMatchObject({ new: 1, created: [1], errors: [{ index: 1, error: "external_id is required" }] });
    await call("POST", "/api/events", [{ source: "gmail", external_id: "m2", actor: "sam@acme.com", title: "Re: Q", url: "https://mail/2", group_key: "t1" }]);
    expect(posts).toEqual([{ kind: "opened", task: 1 }, { kind: "updated", task: 1, text: "Update: [Re: Q](https://mail/2)" }]);
    const tasks = (await call("GET", "/api/tasks", undefined, ANON)).status;
    expect(tasks).toBe(401);
    expect(((await call("GET", "/api/tasks", undefined, "alice@x.com", "open=1&account=Acme")).json as { tasks: unknown[] }).tasks).toHaveLength(1);
  });

  it("updates tasks with status, notes and artifacts", async () => {
    await call("POST", "/api/sources", { source: "gmail", enabled: true });
    await call("POST", "/api/events", { events: [{ source: "gmail", external_id: "seed" }] });
    await call("POST", "/api/events", { events: [{ source: "gmail", external_id: "m1", actor: "sam@acme.com", title: "Q", group_key: "t1" }] });
    expect(await call("POST", "/api/task", { id: 1, status: "finished" })).toMatchObject({ status: 400 });
    const done = await call("POST", "/api/task", { id: 1, status: "done", note: "answered", artifact: { url: "https://docs/1", title: "Answer" } });
    expect(done.json).toMatchObject({ task: { status: "done" }, artifacts: [{ url: "https://docs/1" }] });
    expect(posts.at(-1)?.text).toBe("alice@x.com set this to **done**: answered\nalice@x.com added [Answer](https://docs/1)");
    expect(await call("GET", "/api/task", undefined, "alice@x.com", "id=99")).toMatchObject({ status: 404 });
  });

  it("lets only admins change the rules, and checks them", async () => {
    expect(await call("POST", "/api/config", { config })).toMatchObject({ status: 403 });
    expect(await call("POST", "/api/config", { config: { version: 1, rules: [{ id: "x", action: "maybe" }] } }, "admin@x.com")).toMatchObject({ status: 400, json: { problems: ["rules[0].action must be task, update or ignore"] } });
    expect(await call("POST", "/api/config", { config: { version: 1, rules: [] } }, "admin@x.com")).toMatchObject({ json: { config: { rules: [] } } });
    expect((await call("GET", "/api/config")).json).toMatchObject({ config: { rules: [] }, canEdit: false });
  });

  it("sweeps: posts tasks that failed to post, and nudges stale ones in their thread", async () => {
    let fail = true;
    const flaky = { opened: async (task: { id: number }) => (fail ? Promise.reject(new Error("relay down")) : notifier.opened(task)), updated: notifier.updated };
    const store = new SignalsStore(pglite(), "signals_sweep");
    await store.setup();
    hub = new Hub(store, flaky, { defaultConfig: config });
    await call("POST", "/api/sources", { source: "table.cases", enabled: true });
    await call("POST", "/api/events", { events: [{ source: "table.cases", external_id: "seed" }] });
    await call("POST", "/api/events", { events: [{ source: "table.cases", external_id: "C-1", payload: { status: "Awaiting Confirmation" } }] });
    expect(posts).toEqual([]);
    fail = false;
    expect(await hub.sweep()).toEqual({ posted: 1, nudged: 0 });
    expect(await hub.sweep(Math.floor(Date.now() / 1000) + 80 * 3600)).toEqual({ posted: 0, nudged: 1 });
    expect(posts.at(-1)).toEqual({ kind: "updated", task: 1, text: "⏰ Case C-1 has waited 80h for confirmation" });
  });
});

describe("account channels", () => {
  it("reads a team's preferences: modes per workstream or rule, the rest is guidance", () => {
    const read = parsePreferences("How we work:\n- meeting prep: auto\n* Tickets: OFF\ncustomer-mail: ask\neverything: draft.\nquestions: sometimes\nreplies: manual\nKeep replies short: two lines.");
    expect(read.modes).toEqual({ "meeting prep": "auto", tickets: "off", "customer-mail": "ask", everything: "draft" });
    expect(read.guidance).toBe("How we work:\nquestions: sometimes\nreplies: manual\nKeep replies short: two lines.");
    expect(read.problems).toEqual(['"replies: manual": the mode is one of auto, draft, ask, off']);
    expect(modeFor("customer-mail: ask\nquestions: auto", { id: "customer-mail", workstream: "questions" })).toBe("ask");
    expect(modeFor("questions: auto", { id: "customer-mail", workstream: "questions" })).toBe("auto");
    expect(modeFor("everything: ask", { id: "x" })).toBe("ask");
    expect(modeFor(undefined, { id: "x" })).toBe("draft");
  });

  it("turns registered accounts into accounts the rules find, ahead of the config's own", () => {
    const record = { name: "Acme", channel: "acme-2", aliases: ["ACME Corp"], domains: ["acme.com", "acme.co.uk", "bad domain"], preferences: "questions: auto", profile: "", agents: [], updated_by: null, updated_at: null };
    expect(accountRule(record)).toEqual({ name: "Acme", channel: "acme-2", aliases: ["ACME Corp"], when: { actor: "@(acme\\.com|acme\\.co\\.uk)>?$" }, preferences: "questions: auto" });
    const merged = withAccounts(config, [record]);
    expect(merged.accounts?.map((account) => account.channel)).toEqual(["acme-2"]);
    const mail = { source: "gmail", external_id: "m1", actor: "sam@acme.com", title: "Q", group_key: "t" };
    expect(decide(merged, mail, { firstRun: false })).toMatchObject({ account: { name: "Acme" }, channel: "acme-2", mode: "auto", create: true });
    expect(decide(withAccounts(config, [{ ...record, preferences: "questions: off" }]), mail, { firstRun: false })).toMatchObject({ kind: "task", create: false, mode: "off" });
  });

  it("sets up an account for a channel, opens its tasks there in the team's mode, and files them", async () => {
    const posts: { task: number; channel: string | null; mode: string }[] = [];
    const store = new SignalsStore(pglite(), "signals_accounts");
    await store.setup();
    await store.setup();
    const hub = new Hub(store, { opened: async (task) => (posts.push({ task: task.id, channel: task.channel, mode: task.mode }), `root-${task.id}`), updated: async () => {} }, { admins: ["admin@x.com"], defaultConfig: { ...config, accounts: [] } });
    const call = (method: string, path: string, body?: unknown, query = "", user = "alice@x.com") => hub.handle({ method, path, query: new URLSearchParams(query), user, body: async () => (body === undefined ? "" : JSON.stringify(body)) });

    // Not an admin, but it's the team's channel: anyone who can use the hub sets it up.
    expect(await call("POST", "/api/account", { name: "Globex", domains: ["not a domain"] })).toMatchObject({ status: 400 });
    const setUp = await call("POST", "/api/account", { name: "Globex", channel: "globex", domains: "@globex.com, Globex.io", aliases: ["Globex Corp"], preferences: "questions: ask\nCopy the AE." });
    expect(setUp.json).toMatchObject({ account: { name: "Globex", channel: "globex", domains: ["globex.com", "globex.io"], updated_by: "alice@x.com", read: { modes: { questions: "ask" }, guidance: "Copy the AE." } } });
    expect((await call("GET", "/api/account", undefined, "channel=globex")).json).toMatchObject({ account: { name: "Globex" } });
    expect((await call("GET", "/api/account", undefined, "name=globex corp")).json).toMatchObject({ account: { name: "Globex" } });
    expect((await call("GET", "/api/account", undefined, "channel=nope")).json).toEqual({ account: null });

    await call("POST", "/api/sources", { source: "gmail", enabled: true });
    await call("POST", "/api/events", { events: [{ source: "gmail", external_id: "seed" }] });
    // The config's customer-mail rule only knows acme.com; Globex's people match its own domains.
    const rules = { ...config, accounts: [], rules: [{ id: "customer-mail", sources: ["gmail"], when: { actor: "@" }, action: "task" as const, title: "Reply: {title}", workstream: "questions", group_by: "group_key" }] };
    expect(await call("POST", "/api/config", { config: rules }, "", "admin@x.com")).toMatchObject({ json: { config: { rules: [{ id: "customer-mail" }] } } });
    const opened = await call("POST", "/api/events", { events: [{ source: "gmail", external_id: "m1", actor: "Ann <ann@globex.io>", title: "Pricing?", group_key: "t1" }] });
    expect(opened.json).toMatchObject({ created: [1] });
    expect(posts).toEqual([{ task: 1, channel: "globex", mode: "ask" }]);
    // /api/config shows the rules as saved, without the accounts teams set up.
    expect((await call("GET", "/api/config")).json).toMatchObject({ config: { accounts: [] } });

    expect(await call("POST", "/api/task", { id: 1, initiative: 7 })).toMatchObject({ status: 400 });
    const filed = await call("POST", "/api/task", { id: 1, initiative: "Q3 migration", workstream: "pricing" });
    expect(filed.json).toMatchObject({ task: { initiative: "Q3 migration", workstream: "pricing" }, activities: [{ kind: "opened" }, { text: "workstream: pricing" }, { text: "initiative: Q3 migration" }] });
    expect(((await call("GET", "/api/tasks", undefined, "initiative=q3 migration")).json as { tasks: unknown[] }).tasks).toHaveLength(1);
    expect(((await call("GET", "/api/tasks", undefined, "workstream=questions")).json as { tasks: unknown[] }).tasks).toHaveLength(0);

    // Renaming keeps its tasks; agents keep a profile; deleting forgets the setup, not the tasks.
    await call("POST", "/api/account", { name: "Globex", rename: "Globex Inc", profile: "## Team\nAE: Dana" });
    expect((await call("GET", "/api/task", undefined, "id=1")).json).toMatchObject({ task: { account: "Globex Inc" } });
    expect((await call("GET", "/api/accounts")).json).toMatchObject({ accounts: [{ name: "Globex Inc", profile: "## Team\nAE: Dana", aliases: ["Globex Corp"] }] });
    // A channel belongs to one account.
    await call("POST", "/api/account", { name: "Initech", channel: "globex" });
    expect((await call("GET", "/api/accounts")).json).toMatchObject({ accounts: [{ name: "Globex Inc", channel: null }, { name: "Initech", channel: "globex" }] });
    expect((await call("POST", "/api/account", { name: "Initech", delete: true })).json).toEqual({ deleted: true });
    expect(await call("POST", "/api/account", { name: "Initech", delete: true })).toMatchObject({ status: 404 });
    expect(await store.task(1)).toMatchObject({ account: "Globex Inc", channel: "globex" });
  });

  it("asks the account's agents to work on new tasks in auto and draft mode, not in ask", async () => {
    const store = new SignalsStore(pglite(), "signals_agents");
    await store.setup();
    const posts: { task: number; agents: readonly string[]; text: string }[] = [];
    const hub = new Hub(store, { opened: async (task, agents = []) => (posts.push({ task: task.id, agents, text: taskMessage(task, { agents }) }), `root-${task.id}`), updated: async () => {} }, { defaultConfig: { version: 1, rules: [
      { id: "mail", sources: ["gmail"], action: "task", workstream: "questions", group_by: "external_id" },
      { id: "meetings", sources: ["google_calendar"], action: "task", workstream: "meeting prep", group_by: "external_id" },
    ] } });
    const call = (path: string, body: unknown) => hub.handle({ method: "POST", path, query: new URLSearchParams(), user: "alice@x.com", body: async () => JSON.stringify(body) });
    const key = "ab".repeat(32);
    expect(await call("/api/account", { name: "Globex", agents: ["not-a-key"] })).toMatchObject({ status: 400 });
    const saved = await call("/api/account", { name: "Globex", channel: "globex", domains: ["globex.io"], agents: [npubEncode(key)], preferences: "questions: ask\nmeeting prep: draft" });
    expect(saved.json).toMatchObject({ account: { agents: [key] } });
    for (const source of ["gmail", "google_calendar"]) {
      await call("/api/sources", { source, enabled: true });
      await call("/api/events", { events: [{ source, external_id: "seed" }] });
    }
    await call("/api/events", { events: [{ source: "gmail", external_id: "m1", actor: "ann@globex.io", title: "Pricing?" }] });
    await call("/api/events", { events: [{ source: "google_calendar", external_id: "c1", actor: "ann@globex.io", title: "QBR" }] });
    expect(posts.map(({ task, agents }) => ({ task, agents }))).toEqual([{ task: 1, agents: [] }, { task: 2, agents: [key] }]);
    expect(posts[0]!.text).not.toContain("nostr:");
    expect(posts[1]!.text).toContain(`nostr:${npubEncode(key)} please prepare this`);
    expect(agentKey(` nostr:${npubEncode(key)}`)).toBe(key);
  });

  it("doesn't mark a colleague's customer-domain address as a customer", () => {
    const text = eventDetails({ source: "google_calendar", external_id: "c", payload: { attendees: [
      { email: "dane.isburgh@x.com" }, { email: "disburgh@globex.io" },
      { email: "Beth.Gregory@x.com" }, { email: "bgregory@sub.globex.io" },
      { email: "pat.amons@x.com" }, { email: "pamons@globex.io", displayName: "Pat Amons" },
      { email: "ann.lee@globex.io" }, { email: "bob@x.com" },
    ] } }, ["globex.io"]);
    expect(text).toContain("- ann.lee@globex.io (customer)");
    expect(text).toContain("- disburgh@globex.io (customer-domain address of dane.isburgh@x.com, not a customer)");
    expect(text).toContain("- bgregory@sub.globex.io (customer-domain address of Beth.Gregory@x.com, not a customer)");
    expect(text).toContain("- Pat Amons <pamons@globex.io> (customer-domain address of pat.amons@x.com, not a customer)");
    expect(text.indexOf("ann.lee@globex.io")).toBeLessThan(text.indexOf("disburgh"));
    expect(text.match(/\(customer\)/g)).toHaveLength(1);
  });

  it("opens prep only for meetings with a real customer, not a colleague's customer-domain address", () => {
    const config: SignalsConfig = { version: 1, rules: [{ id: "prep", sources: ["google_calendar"], customer_attendees: "@globex\\.io$", action: "task" }] };
    const meeting = (emails: string[]): EventInput => ({ source: "google_calendar", external_id: "c", payload: { attendees: emails.map((email) => ({ email })) } });
    expect(ruleFor(config, meeting(["dane.isburgh@x.com", "disburgh@globex.io", "ann@globex.io"]))?.id).toBe("prep");
    expect(ruleFor(config, meeting(["dane.isburgh@x.com", "disburgh@globex.io", "bob@x.com"]))).toBeUndefined();
    expect(ruleFor(config, meeting(["bob@x.com"]))).toBeUndefined();
    expect(ruleFor(config, { source: "google_calendar", external_id: "c" })).toBeUndefined();
    expect(configProblems({ version: 1, rules: [{ id: "a", action: "task", customer_attendees: "(" }] })).toEqual(["rules[0].customer_attendees isn't a valid regular expression"]);
    expect(configProblems({ version: 1, rules: [{ id: "a", action: "task", customer_attendees: 3 }] })).toHaveLength(1);
  });

  it("matches a rule on a calendar event's attendees, so only meetings with the customer open prep", () => {
    const config: SignalsConfig = { version: 1, rules: [{ id: "prep", sources: ["google_calendar"], when: { "payload.attendees": "@globex\\.io" }, action: "task" }] };
    const meeting = (emails: string[]): EventInput => ({ source: "google_calendar", external_id: "c", payload: { attendees: emails.map((email) => ({ email, responseStatus: "accepted" })) } });
    expect(ruleFor(config, meeting(["me@x.com", "ann@globex.io"]))?.id).toBe("prep");
    expect(ruleFor(config, meeting(["me@x.com", "bob@x.com"]))).toBeUndefined();
  });

  it("briefs agents without the Signals tools in the wake, and records their first reply on the task", async () => {
    const store = new SignalsStore(pglite(), "signals_remote");
    await store.setup();
    await store.setup();
    const posts: { task: number; text: string }[] = [];
    const hub = new Hub(store, { opened: async (task, agents = [], context = {}) => (posts.push({ task: task.id, text: taskMessage(task, { agents, ...context }) }), "c".repeat(63) + task.id), updated: async () => {} }, { defaultConfig: { version: 1, rules: [{ id: "meetings", sources: ["google_calendar"], action: "task", workstream: "meeting prep", group_by: "external_id" }] } });
    const call = (path: string, body: unknown) => hub.handle({ method: "POST", path, query: new URLSearchParams(), user: "alice@x.com", body: async () => JSON.stringify(body) });
    const agent = "ab".repeat(32);
    await call("/api/account", { name: "Globex", channel: "globex", domains: ["globex.io"], agents: [agent], preferences: "meeting prep: draft\nCopy the AE on everything.", profile: "## Team\nAE: Dana" });
    await call("/api/sources", { source: "google_calendar", enabled: true });
    await call("/api/events", { events: [{ source: "google_calendar", external_id: "seed" }] });
    await call("/api/events", { events: [{ source: "google_calendar", external_id: "c1", actor: "ann@globex.io", title: "QBR" }] });
    expect(posts[0]!.text).toContain("Modes: meeting prep: draft");
    expect(posts[0]!.text).toContain("Team guidance:\nCopy the AE on everything.");
    expect(posts[0]!.text).toContain("Profile:\n## Team\nAE: Dana");

    // The source event's details, for agents to prepare from.
    await call("/api/events", { events: [{ source: "google_calendar", external_id: "c2", actor: "ann@globex.io", title: "Roadmap", url: "https://cal/c2", payload: {
      start: { dateTime: "2026-11-20T10:00:00-08:00", timeZone: "America/New_York" }, end: { dateTime: "2026-11-20T11:00:00-08:00" },
      attendees: [{ email: "me@x.com", responseStatus: "accepted", organizer: true }, { email: "ann@globex.io", displayName: "Ann", responseStatus: "needsAction" }],
      description: "<p>Agenda:</p><br>roadmap and pricing", status: "confirmed",
    } }] });
    const roadmap = posts[1]!.text;
    expect(roadmap).toContain("**Source** (google_calendar): https://cal/c2");
    expect(roadmap).toContain("When: 2026-11-20 13:00 America/New_York (GMT-5) → 2026-11-20T11:00:00-08:00");
    expect(roadmap).toContain("Attendees (2):\n- Ann <ann@globex.io> (customer)\n- me@x.com (organizer, accepted)");
    expect(roadmap).toContain("Description:\nAgenda:");
    expect(roadmap).toContain("Details: status: confirmed");

    const root = "c".repeat(63) + "1";
    const replies = [
      { id: "r0", pubkey: "cd".repeat(32), content: "Not the agent", created_at: 1, tags: [["e", root, "", "reply"]] },
      { id: "r2", pubkey: agent, content: "Second", created_at: 3, tags: [["e", root, "", "reply"]] },
      { id: "r1", pubkey: agent, content: "Draft:\n  agenda for the QBR", created_at: 2, tags: [["e", root, "", "reply"]] },
    ];
    let asked: unknown;
    expect(await hub.collect(async (filters) => ((asked = filters), replies))).toEqual({ recorded: 1 });
    expect(asked).toMatchObject([{ kinds: [9], "#e": [root, "c".repeat(63) + "2"], authors: [agent] }]);
    const detail = await store.detail(1);
    expect(detail?.task).toMatchObject({ status: "in_progress" });
    expect(detail?.activities.map((a) => a.kind)).toEqual(["opened", "agent_reply", "status"]);
    expect(detail?.activities[1]).toMatchObject({ text: "Draft: agenda for the QBR" });
    expect(detail?.artifacts).toMatchObject([{ kind: "draft", url: "buzz://message?channel=globex&id=r1" }]);
    // Recorded once.
    expect(await hub.collect(async () => replies)).toEqual({ recorded: 0 });
  });

  it("sends an account's open tasks without a channel to the channel it gets", async () => {
    const store = new SignalsStore(pglite(), "signals_late");
    await store.setup();
    const posted: (string | null)[] = [];
    const hub = new Hub(store, { opened: async (task) => (posted.push(task.channel), "root"), updated: async () => {} }, { defaultConfig: { version: 1, rules: [{ id: "cases", sources: ["table.cases"], action: "task", group_by: "external_id" }] } });
    const call = (path: string, body: unknown) => hub.handle({ method: "POST", path, query: new URLSearchParams(), user: "alice@x.com", body: async () => JSON.stringify(body) });
    await call("/api/sources", { source: "table.cases", enabled: true });
    await call("/api/events", { events: [{ source: "table.cases", external_id: "seed" }] });
    await call("/api/events", { events: [{ source: "table.cases", external_id: "C-1", account: "Hooli" }] });
    expect(await store.task(1)).toMatchObject({ account: "Hooli", channel: null });
    await call("/api/account", { name: "hooli", channel: "hooli-team" });
    expect(await store.task(1)).toMatchObject({ channel: "hooli-team" });
    expect(await hub.sweep()).toMatchObject({ posted: 1 });
    expect(posted).toEqual(["hooli-team"]);
  });
});

describe("the plugin's sign-in check", () => {
  it("reads not signed in from a JSON-RPC error with HTTP 200, not only from a 401", () => {
    expect(rpcSignIn(200, JSON.stringify({ jsonrpc: "2.0", id: 2, error: { code: -32006, message: "Request rejected (HTTP 401)" } }))).toBe("needed");
    expect(rpcSignIn(200, `event: message\ndata: ${JSON.stringify({ jsonrpc: "2.0", id: 2, result: { tools: [] } })}\n\n`)).toBe("signed-in");
    expect(rpcSignIn(401, "")).toBe("needed");
    expect(rpcSignIn(200, JSON.stringify({ jsonrpc: "2.0", id: 2, error: { code: -32003, message: "Tool not allowed" } }))).toBe("unknown");
    expect(rpcSignIn(500, "oops")).toBe("unknown");
  });
});

describe("routes", () => {
  it("routes every path the hub handles", () => {
    // The app only sends HUB_PATHS to Hub.handle, so a case missing there is unreachable.
    const source = readFileSync(new URL("../plugins/signals/app/hub.ts", import.meta.url), "utf8");
    const handled = new Set([...source.matchAll(/case "(?:GET|POST) (\/api\/[a-z]+)"/g)].map((match) => match[1]!));
    expect(handled.size).toBeGreaterThan(0);
    expect([...handled].filter((path) => !(HUB_PATHS as readonly string[]).includes(path))).toEqual([]);
  });
});
