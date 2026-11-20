// Signals: events → dedupe → rules → tasks, on a real Postgres (PGlite).
import { readFileSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";
import { beforeEach, describe, expect, it } from "vitest";
import { accountRule, agentsFor, DEFAULT_SOURCES, slackThreadKey, configProblems, decide, doneReason, finishes, handledBy, plainSlack, timeOf, type EventInput, labelsOf, modeFor, parsePreferences, playbookFor, ruleFor, type SignalsConfig, validateEvent, withAccounts } from "../plugins/signals/app/model";
import { agentKey, briefing, doneMessage, eventDetails, handledMessage, handOffReason, Hub, HUB_PATHS, type Onboarding, linkKind, markedQuestion, readQuestion, replyLinks, taskMessage, whoIsOn } from "../plugins/signals/app/hub";
import { npubEncode } from "nostr-tools/nip19";
import { lakebaseSnippet, rpcSignIn } from "../plugins/signals/src/client";
import { boardRoute, validBoardRoute } from "../plugins/signals/src/board-panel";
import { assigneeOf, memberChoices, ownersOf, removable, byStatus, cardAssets, filterFiltered, filteredWhy, filterOptions, filterTasks, mentionedKeys, readView, replyMentions, replyText, taskActivity, taskFacts, threadComments, withMentionNames } from "../plugins/signals/src/board-view";
import { contentHash, type Db, SignalsStore } from "../plugins/signals/app/store";
import { answerScore, jevClassifier } from "../plugins/signals/app/classify";
import { classifyQuestions, classifyState } from "../plugins/signals/app/model";

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
        { id: "auto", sources: ["jira"], when: { title: "auto.?approved" }, action: "update", group: "limits", group_by: "{payload.workspace}/{payload.region}" },
        { id: "limits", sources: ["jira"], action: "task", group_by: "{payload.workspace}/{payload.region}" },
      ],
    };
    expect(configProblems(rules)).toEqual([]);
    const ticket = (key: string, title: string, payload?: Record<string, unknown>) => decide(rules, { source: "jira", external_id: key, title, ...(payload && { payload }) }, { firstRun: false });
    expect(ticket("TKT-1", "Limit increase", { workspace: "123", region: "US East" })).toMatchObject({ create: true, group: "limits|123/us east" });
    expect(ticket("TKT-2", "Auto-approved increase", { workspace: "123", region: "us east " })).toMatchObject({ create: false, group: "limits|123/us east" });
    // Without any of its fields, an event is its own group.
    expect(ticket("TKT-3", "Something else")).toMatchObject({ group: "limits|jira:TKT-3" });
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

  it("doesn't repeat an update line when an event is saved again with nothing new", async () => {
    await call("POST", "/api/sources", { source: "gmail", enabled: true });
    await call("POST", "/api/events", { events: [{ source: "gmail", external_id: "seed" }] });
    await call("POST", "/api/events", { events: [{ source: "gmail", external_id: "m1", actor: "sam@acme.com", title: "Q", group_key: "t1" }] });
    const again = (n: number, title = "Re: Q", url = "https://mail/2") => call("POST", "/api/events", { events: [{ source: "gmail", external_id: "m2", actor: "sam@acme.com", title, url, group_key: "t1", payload: { snippet: `seen ${n}` } }] });
    await again(1);
    await again(2);
    await again(3);
    expect(posts.filter((post) => post.kind === "updated").map((post) => post.text)).toEqual(["Update: [Re: Q](https://mail/2)"]);
    // Something new to say is posted.
    await again(4, "Re: Q (new subject)");
    expect(posts.at(-1)).toEqual({ kind: "updated", task: 1, text: "Update: [Re: Q (new subject)](https://mail/2)" });
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
    expect(await hub.sweep()).toEqual({ posted: 1, nudged: 0, finished: 0 });
    expect(await hub.sweep(Math.floor(Date.now() / 1000) + 80 * 3600)).toEqual({ posted: 0, nudged: 1, finished: 0 });
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
    const record = { name: "Acme", channel: "acme-2", aliases: ["ACME Corp"], domains: ["acme.com", "acme.co.uk", "bad domain"], ids: {}, preferences: "questions: auto", profile: "", agents: [], playbooks: {}, workstream_agents: {}, updated_by: null, updated_at: null };
    expect(accountRule(record)).toEqual({ name: "Acme", channel: "acme-2", aliases: ["ACME Corp"], domains: ["acme.com", "acme.co.uk"], preferences: "questions: auto" });
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
    const setUp = await call("POST", "/api/account", { name: "Globex", channel: "globex", domains: "@globex.com, Globex.io", aliases: ["Globex Corp"], preferences: "questions: ask\nCopy the account owner." });
    expect(setUp.json).toMatchObject({ account: { name: "Globex", channel: "globex", domains: ["globex.com", "globex.io"], updated_by: "alice@x.com", read: { modes: { questions: "ask" }, guidance: "Copy the account owner." } } });
    expect((await call("GET", "/api/account", undefined, "channel=globex")).json).toMatchObject({ account: { name: "Globex" } });
    expect((await call("GET", "/api/account", undefined, "name=globex corp")).json).toMatchObject({ account: { name: "Globex" } });
    expect((await call("GET", "/api/account", undefined, "channel=nope")).json).toMatchObject({ account: null, labels: { customer: "customer" } });

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

    // The board shows the channel's tasks with who's on them, in the config's words.
    expect(await call("GET", "/api/board")).toMatchObject({ status: 400 });
    expect((await call("GET", "/api/board", undefined, "channel=globex")).json).toMatchObject({
      account: "Globex",
      labels: { customer: "customer", parties: { support: "Support" } },
      tasks: [{ task: { id: 1 }, people: expect.arrayContaining([{ kind: "customer", key: "ann@globex.io", label: "Ann", role: "wrote" }]) }],
    });

    // Renaming keeps its tasks; agents keep a profile; deleting forgets the setup, not the tasks.
    await call("POST", "/api/account", { name: "Globex", rename: "Globex Inc", profile: "## Team\nAccount owner: Dana" });
    expect((await call("GET", "/api/task", undefined, "id=1")).json).toMatchObject({ task: { account: "Globex Inc" } });
    expect((await call("GET", "/api/accounts")).json).toMatchObject({ accounts: [{ name: "Globex Inc", profile: "## Team\nAccount owner: Dana", aliases: ["Globex Corp"] }] });
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

  it("gives each task only its own workstream's playbook", async () => {
    expect(playbookFor({ "Meeting Prep": "Agenda first.", mail: "Short." }, { rule_id: "meetings", workstream: "meeting prep" })).toEqual({ key: "Meeting Prep", text: "Agenda first." });
    // A playbook named by the rule id wins over the workstream's.
    expect(playbookFor({ "meeting prep": "Agenda first.", meetings: "QBR deck." }, { rule_id: "meetings", workstream: "meeting prep" })?.text).toBe("QBR deck.");
    expect(playbookFor({ mail: "Short.", "meeting prep": "  " }, { rule_id: "meetings", workstream: "meeting prep" })).toBeUndefined();

    const store = new SignalsStore(pglite(), "signals_playbooks");
    await store.setup();
    const posts: { task: number; text: string }[] = [];
    const rules = [
      { id: "meetings", sources: ["google_calendar"], action: "task" as const, workstream: "meeting prep", group_by: "external_id" },
      { id: "mail", sources: ["gmail"], action: "task" as const, workstream: "questions", group_by: "external_id" },
    ];
    const hub = new Hub(store, { opened: async (task, agents = [], context = {}) => (posts.push({ task: task.id, text: taskMessage(task, { agents, ...context }) }), "d".repeat(63) + task.id), updated: async () => {} }, { defaultConfig: { version: 1, rules } });
    const call = (method: "GET" | "POST", path: string, body?: unknown, query = "") => hub.handle({ method, path, query: new URLSearchParams(query), user: "alice@x.com", body: async () => JSON.stringify(body ?? {}) });
    const agent = "ab".repeat(32);
    const saved = await call("POST", "/api/account", { name: "Globex", channel: "globex", domains: ["globex.io"], agents: [agent], playbooks: { "Meeting Prep": "Open with the agenda.\nList open tickets.", questions: "Answer in three lines.", empty: "  " } });
    expect(saved.json).toMatchObject({ account: { playbooks: { "Meeting Prep": "Open with the agenda.\nList open tickets.", questions: "Answer in three lines." } }, workstreams: ["meeting prep", "questions"] });
    expect(Object.keys((saved.json as { account: { playbooks: object } }).account.playbooks)).not.toContain("empty");
    expect((await call("GET", "/api/account", undefined, "channel=globex")).json).toMatchObject({ account: { playbooks: { questions: "Answer in three lines." } }, workstreams: ["meeting prep", "questions"] });

    await call("POST", "/api/sources", { source: "google_calendar", enabled: true });
    await call("POST", "/api/sources", { source: "gmail", enabled: true });
    await call("POST", "/api/events", { events: [{ source: "google_calendar", external_id: "seed" }, { source: "gmail", external_id: "seed" }] });
    await call("POST", "/api/events", { events: [{ source: "google_calendar", external_id: "c1", actor: "ann@globex.io", title: "QBR" }] });
    await call("POST", "/api/events", { events: [{ source: "gmail", external_id: "m1", actor: "ann@globex.io", title: "Pricing?" }] });
    expect(posts[0]!.text).toContain("Playbook for Meeting Prep (how the team likes this done; follow it):\nOpen with the agenda.\nList open tickets.");
    expect(posts[0]!.text).not.toContain("Answer in three lines.");
    expect(posts[1]!.text).toContain("Playbook for questions (how the team likes this done; follow it):\nAnswer in three lines.");
    expect(posts[1]!.text).not.toContain("Open with the agenda.");

    // Saving without playbooks keeps them; bad ones are refused.
    await call("POST", "/api/account", { name: "Globex", preferences: "everything: draft" });
    expect((await store.account({ name: "Globex" }))!.playbooks).toMatchObject({ questions: "Answer in three lines." });
    expect((await call("POST", "/api/account", { name: "Globex", playbooks: ["x"] })).status).toBe(400);
    expect((await call("POST", "/api/account", { name: "Globex", playbooks: { a: 1 } })).status).toBe(400);
    expect((await call("POST", "/api/account", { name: "Globex", playbooks: { a: "x", A: "y" } })).status).toBe(400);
    expect((await call("POST", "/api/account", { name: "Globex", playbooks: { a: "x".repeat(6001) } })).status).toBe(400);
    // An empty map clears them.
    await call("POST", "/api/account", { name: "Globex", playbooks: {} });
    expect((await store.account({ name: "Globex" }))!.playbooks).toEqual({});
  });

  it("mentions a workstream's own agents on its tasks, and the account's on the rest", async () => {
    const account = { agents: ["a"], workstream_agents: { "Meeting Prep": ["b"], mail: ["c"] } };
    expect(agentsFor(account, { rule_id: "meetings", workstream: "meeting prep" })).toEqual(["b"]);
    expect(agentsFor(account, { rule_id: "mail", workstream: "meeting prep" })).toEqual(["c"]);
    expect(agentsFor(account, { rule_id: "x", workstream: "questions" })).toEqual(["a"]);

    const store = new SignalsStore(pglite(), "signals_ws_agents");
    await store.setup();
    const opened: { task: number; agents: readonly string[] }[] = [];
    const updates: { task: number; mentions: readonly string[] }[] = [];
    const rules = [
      { id: "meetings", sources: ["google_calendar"], action: "task" as const, workstream: "meeting prep", group_by: "external_id" },
      { id: "mail", sources: ["gmail"], action: "task" as const, workstream: "questions", group_by: "external_id" },
    ];
    const hub = new Hub(store, { opened: async (task, agents = []) => (opened.push({ task: task.id, agents }), "e".repeat(63) + task.id), updated: async (task, _text, mentions = []) => void updates.push({ task: task.id, mentions }) }, { defaultConfig: { version: 1, rules } });
    const call = (path: string, body: unknown) => hub.handle({ method: "POST", path, query: new URLSearchParams(), user: "alice@x.com", body: async () => JSON.stringify(body) });
    const general = "ab".repeat(32);
    const prep = "cd".repeat(32);
    const saved = await call("/api/account", { name: "Globex", channel: "globex", domains: ["globex.io"], agents: [general], preferences: "everything: draft", workstream_agents: { "Meeting Prep": [npubEncode(prep)], questions: [] } });
    expect((saved.json as { account: { workstream_agents: object } }).account.workstream_agents).toEqual({ "Meeting Prep": [prep] });
    await call("/api/sources", { source: "google_calendar", enabled: true });
    await call("/api/sources", { source: "gmail", enabled: true });
    await call("/api/events", { events: [{ source: "google_calendar", external_id: "seed" }, { source: "gmail", external_id: "seed" }] });
    await call("/api/events", { events: [{ source: "google_calendar", external_id: "c1", actor: "ann@globex.io", title: "QBR" }] });
    await call("/api/events", { events: [{ source: "gmail", external_id: "m1", actor: "ann@globex.io", title: "Pricing?" }] });
    expect(opened.map((item) => item.agents)).toEqual([[prep], [general]]);

    // Naming agents for a workstream later hands its untouched tasks to them, and only them.
    const tickets = "ef".repeat(32);
    updates.length = 0;
    await call("/api/account", { name: "Globex", workstream_agents: { "Meeting Prep": [prep], questions: [tickets] } });
    expect(updates).toEqual([{ task: opened[1]!.task, mentions: [tickets] }]);

    // Clearing a workstream's agents before they reply doesn't ask the account's too: the agents already asked keep it.
    const texts: string[] = [];
    const listen = new Hub(store, { opened: async (task) => "e".repeat(63) + task.id, updated: async (task, text, mentions = []) => void (texts.push(text), updates.push({ task: task.id, mentions })) }, { defaultConfig: { version: 1, rules } });
    const save = (body: unknown) => listen.handle({ method: "POST", path: "/api/account", query: new URLSearchParams(), user: "alice@x.com", body: async () => JSON.stringify(body) });
    updates.length = 0;
    await save({ name: "Globex", workstream_agents: { "Meeting Prep": [prep] } });
    expect(updates).toEqual([]);
    // A task opened while the workstream had its own agents, once nobody's on it (Tickets taken off): clearing them hands it to the account's agents, saying why.
    // Naming Tickets again asks nobody: Tickets is already on the older task.
    await save({ name: "Globex", workstream_agents: { "Meeting Prep": [prep], questions: [tickets] } });
    expect(updates).toEqual([]);
    await call("/api/events", { events: [{ source: "gmail", external_id: "m2", actor: "ann@globex.io", title: "Renewal?" }] });
    const fresh = opened.at(-1)!;
    expect(fresh.agents).toEqual([tickets]);
    await call("/api/task", { id: fresh.task, unassign: [tickets] });
    updates.length = 0;
    await save({ name: "Globex", workstream_agents: { "Meeting Prep": [prep] } });
    // The older task still has the account's agent it was opened with, so it isn't asked again.
    expect(updates).toEqual([{ task: fresh.task, mentions: [general] }]);
    expect(texts.at(-1)).toContain("no longer has its own agents");
    expect(handOffReason("questions")).toBe("you've been named this account's agents for questions");
    await call("/api/account", { name: "Globex", workstream_agents: { "Meeting Prep": [prep], questions: [tickets] } });

    expect((await call("/api/account", { name: "Globex", workstream_agents: { questions: ["nope"] } })).status).toBe(400);
    expect((await call("/api/account", { name: "Globex", workstream_agents: ["x"] })).status).toBe(400);
    // Saving without it keeps it.
    await call("/api/account", { name: "Globex", preferences: "everything: auto" });
    expect((await store.account({ name: "Globex" }))!.workstream_agents).toEqual({ "Meeting Prep": [prep], questions: [tickets] });
  });

  it("puts several people's copies of one mail on one task, and their later replies there too", async () => {
    const rule = { id: "mail", sources: ["gmail"], action: "task" as const, group_by: "group_key", same_as: "{actor}|{title}|{occurred_at}" };
    expect(configProblems({ version: 1, rules: [rule] })).toEqual([]);
    expect(configProblems({ version: 1, rules: [{ ...rule, same_as: "actor" }] })).not.toEqual([]);
    const store = new SignalsStore(pglite(), "signals_copies");
    await store.setup();
    const opened: number[] = [];
    const hub = new Hub(store, { opened: async (task) => (opened.push(task.id), "f".repeat(63) + task.id), updated: async () => {} }, { defaultConfig: { version: 1, rules: [rule] } });
    const as = (user: string) => (path: string, body: unknown) => hub.handle({ method: "POST", path, query: new URLSearchParams(), user, body: async () => JSON.stringify(body) });
    const alice = as("alice@x.com");
    const sam = as("sam@x.com");
    await alice("/api/account", { name: "Globex", channel: "globex", domains: ["globex.io"] });
    const date = "Thu, 19 Nov 2026 23:31:51 +0000";
    const mail = (id: string, thread: string, extra: object = {}) => ({ source: "gmail", external_id: id, group_key: thread, actor: "Ann <ann@globex.io>", title: "Pricing?", occurred_at: date, ...extra });
    for (const call of [alice, sam]) {
      await call("/api/sources", { source: "gmail", enabled: true });
      await call("/api/events", { events: [{ source: "gmail", external_id: "seed" }] });
    }
    await alice("/api/events", { events: [mail("a1", "ta")] });
    // Sam's copy has its own message and thread ids.
    await sam("/api/events", { events: [mail("s1", "ts")] });
    expect(opened).toHaveLength(1);
    const task = (await store.tasks())[0]!;
    expect(task.event_count).toBe(2);
    // Sam's later reply in his own thread goes to the same task.
    await sam("/api/events", { events: [mail("s2", "ts", { actor: "sam@x.com", title: "Re: Pricing?", occurred_at: "Thu, 19 Nov 2026 23:40:00 +0000" })] });
    expect(opened).toHaveLength(1);
    expect((await store.task(task.id))!.event_count).toBe(3);
    // A different mail (another time) is its own task.
    await sam("/api/events", { events: [mail("s3", "ts2", { occurred_at: "Fri, 20 Nov 2026 09:00:00 +0000" })] });
    expect(opened).toHaveLength(2);
    // A copy missing a field it names doesn't join anything.
    await alice("/api/events", { events: [mail("a4", "ta4", { occurred_at: undefined, title: "Pricing?" })] });
    expect(opened).toHaveLength(3);
  });

  it("briefs agents without the Signals tools in the wake, and records their first reply on the task", async () => {
    const store = new SignalsStore(pglite(), "signals_remote");
    await store.setup();
    await store.setup();
    const posts: { task: number; text: string }[] = [];
    const hub = new Hub(store, { opened: async (task, agents = [], context = {}) => (posts.push({ task: task.id, text: taskMessage(task, { agents, ...context }) }), "c".repeat(63) + task.id), updated: async () => {} }, { defaultConfig: { version: 1, rules: [{ id: "meetings", sources: ["google_calendar"], action: "task", workstream: "meeting prep", group_by: "external_id" }] } });
    const call = (path: string, body: unknown) => hub.handle({ method: "POST", path, query: new URLSearchParams(), user: "alice@x.com", body: async () => JSON.stringify(body) });
    const agent = "ab".repeat(32);
    await call("/api/account", { name: "Globex", channel: "globex", domains: ["globex.io"], agents: [agent], preferences: "meeting prep: draft\nCopy the account owner on everything.", profile: "## Team\nAccount owner: Dana" });
    await call("/api/sources", { source: "google_calendar", enabled: true });
    await call("/api/events", { events: [{ source: "google_calendar", external_id: "seed" }] });
    await call("/api/events", { events: [{ source: "google_calendar", external_id: "c1", actor: "ann@globex.io", title: "QBR" }] });
    expect(posts[0]!.text).toContain("Modes: meeting prep: draft");
    expect(posts[0]!.text).toContain("Team guidance:\nCopy the account owner on everything.");
    expect(posts[0]!.text).toContain("Profile:\n## Team\nAccount owner: Dana");

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
      { id: "r1", pubkey: agent, content: "Draft:\n  agenda for the QBR in [QBR agenda](https://docs.google.com/document/d/abc/edit), see https://github.com/o/r/pull/7.", created_at: 2, tags: [["e", root, "", "reply"]] },
    ];
    let asked: unknown;
    expect(await hub.collect(async (filters) => ((asked = filters), replies))).toEqual({ recorded: 1 });
    expect(asked).toMatchObject([{ kinds: [9], "#e": [root, "c".repeat(63) + "2"], authors: [agent] }]);
    const detail = await store.detail(1);
    expect(detail?.task).toMatchObject({ status: "in_progress" });
    expect(detail?.activities.map((a) => a.kind)).toEqual(["opened", "agent_reply", "status"]);
    expect(detail?.activities[1]!.text).toMatch(/^Draft: agenda for the QBR/);
    expect(detail?.artifacts).toMatchObject([
      { kind: "draft", url: "buzz://message?channel=globex&id=r1" },
      { kind: "doc", url: "https://docs.google.com/document/d/abc/edit", title: "QBR agenda" },
      { kind: "pr", url: "https://github.com/o/r/pull/7" },
    ]);
    // Recorded once.
    expect(await hub.collect(async () => replies)).toEqual({ recorded: 0 });
  });

  it("asks agents added to an account to work on its open tasks no agent has worked yet", async () => {
    const store = new SignalsStore(pglite(), "signals_handoff");
    await store.setup();
    const replies: { task: number; text: string; agents: readonly string[] }[] = [];
    const hub = new Hub(
      store,
      { opened: async (task) => "d".repeat(63) + task.id, updated: async (task, text, agents = []) => void replies.push({ task: task.id, text, agents }) },
      { defaultConfig: { version: 1, rules: [{ id: "meetings", sources: ["google_calendar"], action: "task", workstream: "meeting prep", group_by: "external_id" }] } },
    );
    const call = (path: string, body: unknown) => hub.handle({ method: "POST", path, query: new URLSearchParams(), user: "alice@x.com", body: async () => JSON.stringify(body) });
    const [genie, scout] = ["ab".repeat(32), "ef".repeat(32)];
    await call("/api/account", { name: "Globex", channel: "globex", domains: ["globex.io"], preferences: "meeting prep: draft\nQBRs: ask" });
    await call("/api/sources", { source: "google_calendar", enabled: true });
    await call("/api/events", { events: [{ source: "google_calendar", external_id: "seed" }] });
    await call("/api/events", { events: ["c1", "c2", "c3"].map((id) => ({ source: "google_calendar", external_id: id, actor: "ann@globex.io", title: id })) });
    await call("/api/task", { id: 3, status: "dismissed" });
    await store.setAgentReply(2, "someone-already");
    replies.length = 0;

    const saved = await call("/api/account", { name: "Globex", agents: [genie] });
    expect(saved.json).toMatchObject({ woken: [1] });
    expect(replies).toHaveLength(1);
    expect(replies[0]).toMatchObject({ task: 1, agents: [genie] });
    expect(replies[0]!.text).toMatch(/^nostr:npub1\S+ you've been added to this account's agents/);
    expect(replies[0]!.text).toContain("post a draft in this thread");
    expect(replies[0]!.text).toContain("**For agents: Globex**");
    expect((await store.detail(1))?.activities.map((a) => a.kind)).toEqual(["opened", "agents_asked"]);

    // Saving the same agents again asks nobody; adding one asks only the new one.
    expect((await call("/api/account", { name: "Globex", agents: [genie] })).json).not.toHaveProperty("woken");
    expect((await call("/api/account", { name: "Globex", agents: [genie, scout] })).json).toMatchObject({ woken: [1] });
    expect(replies.at(-1)).toMatchObject({ task: 1, agents: [scout] });
    // Saving other fields doesn't ask anyone.
    expect((await call("/api/account", { name: "Globex", profile: "x" })).json).not.toHaveProperty("woken");
    expect(replies).toHaveLength(2);

    // Anyone can ask agents on a task from the board: they're mentioned in its thread and shown on it.
    const helper = "12".repeat(32);
    expect(await call("/api/task", { id: 1, agents: [] })).toMatchObject({ status: 400 });
    expect(await call("/api/task", { id: 1, agents: ["not-a-key"] })).toMatchObject({ status: 400 });
    expect(await call("/api/task", { id: 1, agents: Array.from({ length: 11 }, (_, i) => i.toString(16).padStart(2, "0").repeat(32)) })).toMatchObject({ status: 400 });
    const asked = await call("/api/task", { id: 1, agents: [npubEncode(helper), helper], note: "Check the pricing sheet" });
    expect(asked.json).toMatchObject({ activities: expect.arrayContaining([expect.objectContaining({ kind: "agents_asked", text: expect.stringContaining("Check the pricing sheet") })]) });
    expect(replies.at(-1)).toMatchObject({ task: 1, agents: [helper] });
    expect(replies.at(-1)!.text).toContain("Check the pricing sheet");
    const board = (await hub.handle({ method: "GET", path: "/api/board", query: new URLSearchParams("channel=globex"), user: "alice@x.com", body: async () => "" })).json as { tasks: { task: { id: number }; people: { kind: string; key: string }[] }[] };
    expect(board.tasks.find((item) => item.task.id === 1)?.people).toEqual(expect.arrayContaining([expect.objectContaining({ kind: "agent", key: helper })]));

    // Their reply is recorded as for a new task.
    const root = "d".repeat(63) + "1";
    expect(await hub.collect(async () => [{ id: "r1", pubkey: scout, content: "Draft", created_at: 2, tags: [["e", root, "", "reply"]] }])).toEqual({ recorded: 1 });
    expect((await store.task(1))?.status).toBe("in_progress");
  });

  it("assigns and unassigns owners: agents are asked or told to stop, and an agent taken off stays off", async () => {
    const store = new SignalsStore(pglite(), "signals_owners");
    await store.setup();
    const replies: { task: number; text: string; agents: readonly string[] }[] = [];
    const hub = new Hub(
      store,
      { opened: async (task) => "d".repeat(63) + task.id, updated: async (task, text, agents = []) => void replies.push({ task: task.id, text, agents }) },
      { defaultConfig: { version: 1, rules: [{ id: "meetings", sources: ["google_calendar"], action: "task", workstream: "meeting prep", group_by: "external_id", watch: ["payload.status"] }] } },
    );
    const call = (path: string, body: unknown) => hub.handle({ method: "POST", path, query: new URLSearchParams(), user: "alice@x.com", body: async () => JSON.stringify(body) });
    const board = async () => ((await hub.handle({ method: "GET", path: "/api/board", query: new URLSearchParams("channel=globex"), user: "alice@x.com", body: async () => "" })).json as { tasks: { task: { id: number }; people: { kind: string; key: string; role: string; on?: true }[] }[] }).tasks.find((item) => item.task.id === 1)!.people;
    const [genie, scout, bo] = ["ab".repeat(32), "ef".repeat(32), "34".repeat(32)];
    const root = "d".repeat(63) + "1";
    const reply = (id: string, pubkey: string) => [{ id, pubkey, content: "On it", created_at: 9e9, tags: [["e", root, "", "reply"]] }];
    await call("/api/account", { name: "Globex", channel: "globex", domains: ["globex.io"], agents: [genie], preferences: "meeting prep: draft" });
    await call("/api/sources", { source: "google_calendar", enabled: true });
    await call("/api/events", { events: [{ source: "google_calendar", external_id: "seed" }] });
    await call("/api/events", { events: [{ source: "google_calendar", external_id: "m1", actor: "ann@globex.io", title: "QBR", payload: { status: "a" } }] });
    await hub.sweep();
    replies.length = 0;

    // The API's shape: lists of pubkeys, emails or {key, kind}.
    expect(await call("/api/task", { id: 1, assign: ["nobody"] })).toMatchObject({ status: 400 });
    expect(await call("/api/task", { id: 1, assign: [{ key: scout, kind: "robot" }] })).toMatchObject({ status: 400 });
    expect(await call("/api/task", { id: 1, assign: [], unassign: [] })).toMatchObject({ status: 400 });

    // Assign an agent: mentioned and asked to work on it, with the briefing, and logged.
    const assigned = await call("/api/task", { id: 1, assign: [npubEncode(scout)], note: "Scout has the deck" });
    expect(assigned.json).toMatchObject({ activities: expect.arrayContaining([expect.objectContaining({ kind: "assigned", text: expect.stringContaining("Scout has the deck") })]) });
    // The log names them as a mention, so every surface and agents reading the API see who it is.
    expect(assigned.json).toMatchObject({ activities: expect.arrayContaining([expect.objectContaining({ kind: "assigned", text: `Assigned nostr:${npubEncode(scout)}: Scout has the deck` })]) });
    expect(replies.at(-1)!.agents).toEqual([scout]);
    expect(replies.at(-1)!.text).toContain(`assigned this to nostr:${npubEncode(scout)}`);
    expect(replies.at(-1)!.text).toContain("post a draft in this thread");
    expect(replies.at(-1)!.text).toContain("**For agents: Globex**");
    expect(await board()).toEqual(expect.arrayContaining([expect.objectContaining({ kind: "agent", key: scout, role: "owner", on: true })]));
    // Assigning the same owner again posts nothing.
    const before = replies.length;
    await call("/api/task", { id: 1, assign: [scout] });
    expect(replies).toHaveLength(before);

    // Assign a person (a channel member, by pubkey): mentioned, no agent asked.
    await call("/api/task", { id: 1, assign: [{ key: bo, kind: "person" }] });
    expect(replies.at(-1)!.agents).toEqual([bo]);
    expect(replies.at(-1)!.text).toBe(`👤 alice@x.com assigned this to nostr:${npubEncode(bo)}.`);
    // And by email.
    await call("/api/task", { id: 1, assign: ["Cy <CY@x.com>"] });
    expect(replies.at(-1)!.text).toContain("**cy@x.com**");
    expect(replies.at(-1)!.agents).toEqual([]);

    // Unassign the account's agent: told to stop, and not woken again by changes, answers, askAgain, handOff or collect.
    await call("/api/task", { id: 1, unassign: [genie] });
    expect(replies.at(-1)!.agents).toEqual([genie]);
    expect(replies.at(-1)!.text).toContain(`nostr:${npubEncode(genie)} you're off this task`);
    expect((await store.detail(1))?.activities.map((a) => a.kind)).toContain("unassigned");
    expect((await board()).some((person) => person.key === genie)).toBe(false);
    expect(await hub.collect(async () => reply("g1", genie))).toEqual({ recorded: 0 });
    await call("/api/events", { events: [{ source: "google_calendar", external_id: "m1", actor: "ann@globex.io", title: "QBR", payload: { status: "b" } }] });
    const change = replies.at(-1)!;
    expect(change.text).toContain("status");
    expect(change.agents).toEqual([scout]);
    await call("/api/task", { id: 1, question: "Which deck?", options: ["A", "B"] });
    await call("/api/task", { id: 1, input: "A" });
    expect(replies.at(-1)!.agents).toEqual([scout]);
    await store.askAgain(1, [genie]);
    expect((await store.people([1])).get(1)?.some((person) => person.key === genie)).toBe(false);
    expect((await call("/api/account", { name: "Globex", agents: [genie, "56".repeat(32)] })).json).not.toHaveProperty("woken");
    expect(await hub.collect(async () => reply("g2", genie))).toEqual({ recorded: 0 });
    expect(await hub.collect(async () => reply("s1", scout))).toEqual({ recorded: 1 });

    // Reassign in one call: Scout off (told to stop), Genie on (asked again, so it's back).
    await call("/api/task", { id: 1, assign: [genie], unassign: [scout, { key: bo, kind: "person" }] });
    const swap = replies.at(-1)!;
    expect(swap.agents).toEqual(expect.arrayContaining([genie, scout]));
    expect(swap.text).toContain(`assigned this to nostr:${npubEncode(genie)}`);
    expect(swap.text).toContain(`nostr:${npubEncode(scout)} you're off this task`);
    const owners = (await board()).filter((person) => person.role === "owner").map((person) => person.key);
    expect(owners.sort()).toEqual(["cy@x.com", genie].sort());
    expect(await hub.collect(async () => reply("s2", scout))).toEqual({ recorded: 0 });
    expect(await hub.collect(async () => reply("g3", genie))).toEqual({ recorded: 1 });
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

describe("needs input", () => {
  it("reads a question an agent marked in its reply", () => {
    expect(markedQuestion("Here's the draft.\nNeeds input: Send it to Ann or to the whole team?\nOptions: Ann / Whole team")).toEqual({ question: "Send it to Ann or to the whole team?", options: ["Ann", "Whole team"] });
    expect(markedQuestion("**Needs input:** Which region? \n- Options: us-east | eu-west")).toEqual({ question: "Which region?", options: ["us-east", "eu-west"] });
    expect(markedQuestion("⏸️ needs input: Go ahead?")).toEqual({ question: "Go ahead?", options: [] });
    expect(markedQuestion("This needs input from Dana later.")).toBeUndefined();
    expect(markedQuestion("Done, no questions.")).toBeUndefined();
    expect(readQuestion("", [])).toMatch(/question/);
    expect(readQuestion("Which?", Array.from({ length: 9 }, (_, i) => `o${i}`))).toMatch(/options/);
    expect(readQuestion(" Which? ", "A / B / A")).toEqual({ question: "Which?", options: ["A", "B"] });
  });

  it("puts a task on hold for input, takes the answer to its thread, and records the agent's next reply", async () => {
    const store = new SignalsStore(pglite(), "signals_input");
    await store.setup();
    await store.setup();
    const replies: { task: number; text: string; agents: readonly string[] }[] = [];
    const hub = new Hub(
      store,
      { opened: async (task) => "e".repeat(63) + task.id, updated: async (task, text, agents = []) => void replies.push({ task: task.id, text, agents }) },
      { defaultConfig: { version: 1, rules: [{ id: "mail", sources: ["gmail"], action: "task", workstream: "questions", group_by: "external_id" }] } },
    );
    const call = (method: string, path: string, body?: unknown, query = "") => hub.handle({ method, path, query: new URLSearchParams(query), user: "alice@x.com", body: async () => (body === undefined ? "" : JSON.stringify(body)) });
    const [genie, scout] = ["ab".repeat(32), "cd".repeat(32)];
    await call("POST", "/api/account", { name: "Globex", channel: "globex", domains: ["globex.io"], agents: [genie], preferences: "questions: draft" });
    await call("POST", "/api/sources", { source: "gmail", enabled: true });
    await call("POST", "/api/events", { events: [{ source: "gmail", external_id: "seed" }] });
    await call("POST", "/api/events", { events: [{ source: "gmail", external_id: "m1", actor: "ann@globex.io", title: "Pricing?" }, { source: "gmail", external_id: "m2", actor: "ann@globex.io", title: "Renewal?" }] });
    const root = (id: number) => "e".repeat(63) + id;

    // A remote agent asks by marking a line in its reply: the task waits with the question.
    const marked = { id: "r1", pubkey: genie, content: "Draft below.\nNeeds input: Quote list price or the discount?\nOptions: List / Discount", created_at: 100, tags: [["e", root(1), "", "reply"]] };
    expect(await hub.collect(async () => [marked])).toEqual({ recorded: 1 });
    let task = (await store.task(1))!;
    expect(task).toMatchObject({ status: "waiting", question: "Quote list price or the discount?", options: ["List", "Discount"], asked_by: genie });
    // The hub says so in the thread too, as it does when asked through the API.
    expect(replies.at(-1)).toMatchObject({ task: 1 });
    expect(replies.at(-1)!.text).toContain("⏸️ **Needs input** (asked by nostr:");
    expect(replies.at(-1)!.text).toContain("Options: List / Discount");
    expect((await store.detail(1))!.activities.map((a) => a.kind)).toEqual(["opened", "agent_reply", "question"]);
    const board = (await call("GET", "/api/board", undefined, "channel=globex")).json as { tasks: { task: { id: number; question?: string } }[] };
    expect(board.tasks.find((item) => item.task.id === 1)?.task.question).toBe("Quote list price or the discount?");

    // An agent with the tools asks through the API (as signals_task_update does).
    expect(await call("POST", "/api/task", { id: 2, question: "" })).toMatchObject({ status: 400 });
    expect(await call("POST", "/api/task", { id: 2, question: "Who signs?", options: [7] })).toMatchObject({ status: 400 });
    expect((await call("POST", "/api/task", { id: 2, question: "Who signs?", options: ["Dana", "Lee"] })).json).toMatchObject({ task: { status: "waiting" } });
    expect((await store.task(2))!).toMatchObject({ status: "waiting", question: "Who signs?", options: ["Dana", "Lee"], asked_by: "alice@x.com" });
    expect(replies.at(-1)!.text).toContain("**Needs input**");
    await call("POST", "/api/task", { id: 2, status: "in_progress" });
    expect((await store.task(2))!).toMatchObject({ status: "in_progress", question: null });
    expect(await call("POST", "/api/task", { id: 2, input: "Dana" })).toMatchObject({ status: 409 });

    // Someone answers from the board: in the thread, mentioning the agent that asked, and the task resumes.
    await call("POST", "/api/task", { id: 1, agents: [scout] });
    expect(await call("POST", "/api/task", { id: 1, input: "  " })).toMatchObject({ status: 400 });
    const answered = await call("POST", "/api/task", { id: 1, input: "Discount" });
    expect(answered.json).toMatchObject({ task: { status: "in_progress", question: null, options: null }, activities: expect.arrayContaining([expect.objectContaining({ kind: "input", text: "Discount" })]) });
    expect(replies.at(-1)).toMatchObject({ task: 1, agents: [genie, scout] });
    expect(replies.at(-1)!.text).toContain("alice@x.com answered: Discount");
    expect(replies.at(-1)!.text).toContain("> Quote list price or the discount?");

    // Only the agents' replies after the answer count, once each; the old one doesn't count again.
    expect(await hub.collect(async () => [marked])).toEqual({ recorded: 0 });
    const after = { id: "r2", pubkey: genie, content: "Updated draft with the discount.", created_at: Math.floor(Date.now() / 1000) + 5, tags: [["e", root(1), "", "reply"]] };
    expect(await hub.collect(async () => [marked, after])).toEqual({ recorded: 1 });
    task = (await store.task(1))!;
    expect(task).toMatchObject({ status: "in_progress", question: null, agent_reply: "r1" });
    expect(await hub.collect(async () => [marked, after])).toEqual({ recorded: 0 });
  });
});

describe("recurring series", () => {
  it("asks once about a new series, holds its other events, and keeps Always and Never", async () => {
    const store = new SignalsStore(pglite(), "signals_series");
    await store.setup();
    await store.setup();
    const opened: { id: number; mode: string; text: string; agents: readonly string[] }[] = [];
    const edits: { task: number; text: string }[] = [];
    const replies: { task: number; text: string; agents: readonly string[] }[] = [];
    const hub = new Hub(
      store,
      {
        opened: async (task, agents = [], context = {}) => (opened.push({ id: task.id, mode: task.mode, text: taskMessage(task, { agents, ...context }), agents }), "f".repeat(60) + String(task.id).padStart(4, "0")),
        updated: async (task, text, agents = []) => void replies.push({ task: task.id, text, agents }),
        edited: async (task, text) => void edits.push({ task: task.id, text }),
      },
      { defaultConfig: { version: 1, rules: [{ id: "meetings", sources: ["google_calendar"], action: "task", title: "Prep: {title}", workstream: "meeting prep", group_by: "external_id", series: "payload.recurringEventId" }] } },
    );
    expect(configProblems({ version: 1, rules: [{ id: "m", action: "task", series: "" }] })).toEqual(["rules[0].series is a field or a {field} template"]);
    const call = (method: string, path: string, body?: unknown, query = "") => hub.handle({ method, path, query: new URLSearchParams(query), user: "alice@x.com", body: async () => (body === undefined ? "" : JSON.stringify(body)) });
    const genie = "ab".repeat(32);
    await call("POST", "/api/account", { name: "Globex", channel: "globex", domains: ["globex.io"], agents: [genie], preferences: "meeting prep: draft" });
    await call("POST", "/api/sources", { source: "google_calendar", enabled: true });
    await call("POST", "/api/events", { events: [{ source: "google_calendar", external_id: "seed" }] });
    const meeting = (id: string, series: string | undefined, title = "Weekly sync", at = 1000) => ({ source: "google_calendar", external_id: id, actor: "ann@globex.io", title, occurred_at: at, ...(series && { payload: { recurringEventId: series } }) });

    // The series' first event asks, in ask mode (no agent starts), with the three choices.
    await call("POST", "/api/events", { events: [meeting("w1", "weekly"), meeting("w2", "weekly", "Weekly sync", 2000)] });
    let task = (await store.task(1))!;
    expect(task).toMatchObject({ mode: "ask", status: "waiting", options: ["Always", "Just this one", "Never"], asked_by: "signals", series: "meetings|globex|weekly" });
    expect(opened).toMatchObject([{ id: 1, mode: "ask", agents: [] }]);
    expect(opened[0]!.text).toContain("**Needs input:** \"Prep: Weekly sync\" is part of a recurring series.");
    expect(opened[0]!.text).toContain("Options: Always / Just this one / Never");
    // Its other events wait for the answer.
    expect(await store.tasks()).toHaveLength(1);
    // A one-off meeting has no series and opens as usual.
    await call("POST", "/api/events", { events: [meeting("o1", undefined, "Kickoff")] });
    expect((await store.task(2))!).toMatchObject({ mode: "draft", status: "open", series: null, question: null });

    // Always: this task goes ahead in the team's mode with the account's agents, and the held event opens its task.
    const always = await call("POST", "/api/task", { id: 1, input: "Always" });
    expect(always.json).toMatchObject({ task: { status: "open", mode: "draft", question: null } });
    expect(replies.at(-1)).toMatchObject({ task: 1, agents: [genie] });
    expect(replies.at(-1)!.text).toContain("alice@x.com answered: **Always**");
    expect(replies.at(-1)!.text).toContain("please prepare this");
    // The first message is edited to the task's mode now, without the question or a mention.
    expect(edits).toHaveLength(1);
    expect(edits[0]!.task).toBe(1);
    expect(edits[0]!.text).toContain("Mode: draft");
    expect(edits[0]!.text).not.toContain("Mode: ask");
    expect(edits[0]!.text).not.toContain("Needs input");
    expect(edits[0]!.text).not.toContain("nostr:");
    expect((await store.seriesFor("meetings|globex|weekly"))!).toMatchObject({ answer: "always", asked_task: null, answered_by: "alice@x.com" });
    expect((await store.task(3))!).toMatchObject({ title: "Prep: Weekly sync", mode: "draft", status: "open", series: "meetings|globex|weekly", question: null });
    expect(opened.at(-1)).toMatchObject({ id: 3, agents: [genie] });
    // Later events of the series open tasks without asking.
    await call("POST", "/api/events", { events: [meeting("w3", "weekly")] });
    expect((await store.task(4))!).toMatchObject({ mode: "draft", question: null });

    // Never: the task is dismissed, and the series' held and later events open nothing.
    await call("POST", "/api/events", { events: [meeting("s1", "standup", "Standup"), meeting("s2", "standup", "Standup", 2000)] });
    expect((await store.task(5))!).toMatchObject({ mode: "ask", status: "waiting" });
    await call("POST", "/api/task", { id: 5, input: "Never" });
    expect((await store.task(5))!).toMatchObject({ status: "dismissed", question: null });
    expect(edits.at(-1)!.task).toBe(5);
    expect(edits.at(-1)!.text).not.toContain("Needs input");
    expect(edits.at(-1)!.text).toContain("🚫 Dismissed: no tasks open for this series.");
    await call("POST", "/api/events", { events: [meeting("s3", "standup", "Standup")] });
    expect(await store.tasks()).toHaveLength(5);

    // Just this one: the task goes ahead, and the series' next event asks again.
    await call("POST", "/api/events", { events: [meeting("q1", "qbr", "QBR"), meeting("q2", "qbr", "QBR", 2000)] });
    expect((await store.task(6))!).toMatchObject({ mode: "ask", status: "waiting" });
    await call("POST", "/api/task", { id: 6, input: "Just this one" });
    expect((await store.task(6))!).toMatchObject({ mode: "draft", status: "open", question: null });
    expect(edits.at(-1)).toMatchObject({ task: 6, text: expect.stringContaining("Mode: draft") });
    expect((await store.seriesFor("meetings|globex|qbr"))!).toMatchObject({ answer: null });
    expect((await store.task(7))!).toMatchObject({ mode: "ask", status: "waiting", question: expect.stringContaining("recurring series") });

    // Each series keeps its own answer, under its account.
    expect((await store.seriesList("globex")).map((series) => [series.key, series.answer])).toEqual(expect.arrayContaining([["meetings|globex|weekly", "always"], ["meetings|globex|standup", "never"], ["meetings|globex|qbr", null]]));
  });
});

describe("who's on a task", () => {
  const ticket: EventInput = { source: "jira", external_id: "T-1", actor: "Ann <ann@acme.io>", payload: { assignee: "Bo <bo@us.io>" } };
  it("uses generic party names by default, and only a rule's party adds one", () => {
    const engineering = { party: "engineering" };
    expect(labelsOf(undefined)).toEqual({ customer: "customer", parties: { engineering: "Engineering", support: "Support" } });
    expect(configProblems({ version: 1, rules: [{ id: "r", action: "task", party: "support" }] })).toEqual([]);
    const people = whoIsOn([], [], ticket, ["acme.io"], labelsOf(undefined), engineering);
    expect(people).toEqual(expect.arrayContaining([
      { kind: "team", key: "engineering", label: "Engineering", role: "jira" },
      { kind: "person", key: "bo@us.io", label: "Bo", role: "assignee" },
      { kind: "customer", key: "ann@acme.io", label: "Ann", role: "from" },
    ]));
    expect(whoIsOn([], [], { source: "table.support_cases", external_id: "1", payload: { owner: "cy@us.io" } }, [], labelsOf(undefined), { party: "support" })).toEqual([
      { kind: "team", key: "support", label: "Support", role: "table.support_cases" },
      { kind: "person", key: "cy@us.io", label: "cy@us.io", role: "owner" },
    ]);
    // No rule party: nothing is guessed from a jira or case source.
    expect(whoIsOn([], [], ticket, [])).toEqual([]);
    expect(whoIsOn([], [], { source: "table.support_cases", external_id: "1", payload: { owner: "cy@us.io" } }, [])).toEqual([]);
  });
  it("names parties and customers as the config's labels say, and a rule's party wins", () => {
    const config: SignalsConfig = { version: 1, labels: { customer: "Client", parties: { support: "Customer Care", partner: "Partner team" } }, rules: [{ id: "r", action: "task", party: "partner" }] };
    expect(configProblems(config)).toEqual([]);
    expect(configProblems({ version: 1, labels: { customer: "", parties: { x: 3 } }, rules: [{ id: "r", action: "task", party: "nobody" }] })).toEqual([
      "labels.customer is a word, like client",
      "labels.parties.x is a name",
      "rules[0].party must be one of engineering, support (or a key you add in labels.parties)",
    ]);
    const labels = labelsOf(config);
    expect(labels).toEqual({ customer: "client", parties: { engineering: "Engineering", support: "Customer Care", partner: "Partner team" } });
    expect(whoIsOn([], [], { source: "zendesk.cases", external_id: "1" }, [], labels, { party: "support" })).toEqual([{ kind: "team", key: "support", label: "Customer Care", role: "zendesk.cases" }]);
    expect(whoIsOn([], [], ticket, [], labels, config.rules[0])[0]).toEqual({ kind: "team", key: "partner", label: "Partner team", role: "jira" });
    const text = eventDetails({ source: "google_calendar", external_id: "c", payload: { attendees: [{ email: "ann@acme.io" }, { email: "me@us.io" }] } }, ["acme.io"], labels);
    expect(text).toContain("- ann@acme.io (client)");
    expect(briefing({ name: "Acme", channel: "c", aliases: [], domains: ["acme.io"], agents: [], preferences: "", profile: "" } as never, labels)).toContain("Client domains: acme.io");
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

describe("onboarding a poller", () => {
  it("says whether a person has a database role, creates it when it can, and says what to run when it can't", async () => {
    const pg = new PGlite();
    const db: Db = { query: async (text, values) => ({ rows: (await pg.query(text, values)).rows as never[] }) };
    const store = new SignalsStore(db, "signals_onboard");
    await store.setup();
    const lakebase = { endpoint: "projects/p1/branches/production/endpoints/primary", host: "ep.example.com", database: "databricks_postgres" };
    const hub = new Hub(store, undefined, { lakebase });
    const call = (method: string, user: string) => hub.handle({ method, path: "/api/onboard", query: new URLSearchParams(), user, body: async () => "" });

    // No role yet: GET only looks, and says what someone who can should run.
    const looked = (await call("GET", "Ann@x.com")).json as Onboarding;
    expect(looked).toMatchObject({ user: "ann@x.com", role: "waiting", lakebase: { ...lakebase, schema: "signals_onboard" }, args: ["--config", "/Workspace/Users/ann@x.com/signals-poller/sources.json", "--lakebase"], folder: "/Workspace/Users/ann@x.com/signals-poller" });
    expect(looked.waiting?.command).toBe(`databricks postgres create-role projects/p1/branches/production --json '{"spec":{"identity_type":"USER","postgres_role":"ann@x.com","auth_method":"LAKEBASE_OAUTH_V1"}}'`);

    // Without databricks_create_role (the extension isn't installed), POST says why and still gives the command.
    const failed = (await call("POST", "ann@x.com")).json as Onboarding;
    expect(failed.role).toBe("waiting");
    expect(failed.waiting?.reason).toMatch(/couldn't create your role.*databricks_create_role/);
    expect(failed.waiting?.command).toContain("create-role");

    // With it, POST creates the role, and then it's ready.
    await pg.query(`CREATE FUNCTION databricks_create_role(name text, kind text) RETURNS text LANGUAGE plpgsql AS $$ BEGIN EXECUTE format('CREATE ROLE %I LOGIN', name); RETURN name; END $$`);
    expect(((await call("POST", "ann@x.com")).json as Onboarding).role).toBe("created");
    expect(((await call("GET", "ANN@x.com")).json as Onboarding)).toMatchObject({ role: "ready" });
    expect(((await call("POST", "ann@x.com")).json as Onboarding).role).toBe("ready");

    // A hub that doesn't know its database still answers, without the settings or the command.
    const bare = (await new Hub(store).handle({ method: "GET", path: "/api/onboard", query: new URLSearchParams(), user: "bo@x.com", body: async () => "" })).json as Onboarding;
    expect(bare).toEqual({ user: "bo@x.com", role: "waiting", waiting: { reason: "You don't have a role in the hub's database yet." }, folder: "/Workspace/Users/bo@x.com/signals-poller", args: ["--config", "/Workspace/Users/bo@x.com/signals-poller/sources.json", "--lakebase"] });
    // It needs to know who's asking.
    expect((await hub.handle({ method: "GET", path: "/api/onboard", query: new URLSearchParams(), body: async () => "" })).status).toBe(401);
  });
});

describe("the poller setup card", () => {
  it("gives the lakebase block for sources.json, or nothing when the hub doesn't know its database", () => {
    const lakebase = { endpoint: "projects/p/branches/b/endpoints/e", host: "h", database: "databricks_postgres", schema: "signals_x" };
    expect(JSON.parse(lakebaseSnippet({ user: "a@x.com", role: "ready", lakebase, folder: "/f", args: [] })!)).toEqual({ lakebase });
    expect(lakebaseSnippet({ user: "a@x.com", role: "waiting", folder: "/f", args: [] })).toBeUndefined();
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

describe("the board page's route", () => {
  it("takes a channel and its name, and nothing else", () => {
    expect(validBoardRoute(null)).toBe(true);
    expect(validBoardRoute({ channel: "c1", name: "acme" })).toBe(true);
    expect(validBoardRoute({ channel: 5 })).toBe(false);
    expect(validBoardRoute(["c1"])).toBe(false);
    expect(boardRoute({ kind: "page", route: { version: 1, params: { channel: "c1", name: "acme" } } })).toEqual({ channel: "c1", name: "acme" });
    expect(boardRoute({ kind: "page", route: { version: 1, params: null } })).toEqual({});
    expect(boardRoute(undefined)).toEqual({});
  });
});

describe("tasks that finish themselves", () => {
  it("checks done_when", () => {
    expect(configProblems({ version: 1, rules: [{ id: "a", action: "task", done_when: {} }] })).toEqual(["rules[0].done_when needs when, after, idle_days or by_owner"]);
    expect(configProblems({ version: 1, rules: [{ id: "a", action: "task", done_when: { by_owner: "yes" } }] })).toEqual(["rules[0].done_when.by_owner is true or false"]);
    expect(configProblems({ version: 1, rules: [{ id: "a", action: "task", done_when: { by_owner: true } }] })).toEqual([]);
    expect(configProblems({ version: 1, rules: [{ id: "a", action: "task", done_when: { after: "", idle_days: 0, when: { x: "(" } } }] })).toEqual([
      "rules[0].done_when.when.x isn't a valid regular expression",
      "rules[0].done_when.after is an event field holding a time, like payload.end",
      "rules[0].done_when.idle_days must be a positive number",
    ]);
    expect(configProblems({ version: 1, done_idle_days: -1, rules: [] })).toEqual(["done_idle_days must be a positive number"]);
    expect(configProblems({ version: 1, done_idle_days: 14, rules: [{ id: "a", action: "task", done_when: { after: "payload.end", grace_hours: 2, note: "over" } }] })).toEqual([]);
  });

  it("reads times from ISO strings, Unix seconds and calendar objects", () => {
    expect(timeOf("2026-11-20T17:00:00Z")).toBe(Date.parse("2026-11-20T17:00:00Z") / 1000);
    expect(timeOf({ dateTime: "2026-11-20T09:00:00-08:00", timeZone: "America/Los_Angeles" })).toBe(Date.parse("2026-11-20T17:00:00Z") / 1000);
    expect(timeOf({ date: "2026-11-20" })).toBe(Date.parse("2026-11-20") / 1000);
    expect(timeOf(1795000000)).toBe(1795000000);
    expect(timeOf(1795000000123)).toBe(1795000000);
    expect(timeOf("soon")).toBeUndefined();
    expect(timeOf("")).toBeUndefined();
    expect(timeOf(undefined)).toBeUndefined();
  });

  it("says why a task is done", () => {
    const meeting: EventInput = { source: "google_calendar", external_id: "m", title: "QBR", payload: { end: { dateTime: "2026-11-20T17:00:00Z" } } };
    const end = Date.parse("2026-11-20T17:00:00Z") / 1000;
    expect(doneReason({ after: "payload.end" }, meeting, { at: end - 1, sweep: true })).toBeUndefined();
    expect(doneReason({ after: "payload.end" }, meeting, { at: end, sweep: true })).toBe("it ended 2026-11-20 17:00 UTC");
    expect(doneReason({ after: "payload.end", grace_hours: 2 }, meeting, { at: end + 3600, sweep: true })).toBeUndefined();
    expect(doneReason({ after: "payload.end", note: "{title} is over" }, meeting, { at: end + 1, sweep: true })).toBe("QBR is over");
    // Times are only the sweep's.
    expect(doneReason({ after: "payload.end" }, meeting, { at: end + 1, sweep: false })).toBeUndefined();
    expect(doneReason({ idle_days: 3 }, meeting, { at: 10 * 86400, sweep: true, lastActive: 8 * 86400 })).toBeUndefined();
    expect(doneReason({ idle_days: 3 }, meeting, { at: 10 * 86400, sweep: true, lastActive: 7 * 86400 })).toBe("nothing new in 3 days");
    const ticket: EventInput = { source: "jira", external_id: "T-1", payload: { status: "Resolved", status_category: "Done" } };
    expect(doneReason({ when: { "payload.status_category": ["Done"] } }, ticket, { at: 0, sweep: false })).toBe("its latest update says it's finished");
    expect(doneReason({ when: { "payload.status_category": ["Done"] }, note: "{external_id} is {payload.status}" }, ticket, { at: 0, sweep: false })).toBe("T-1 is Resolved");
  });

  const rules: SignalsConfig = {
    version: 1,
    rules: [
      { id: "prep", sources: ["google_calendar"], action: "task", title: "Prep: {title}", group_by: "external_id", done_when: { after: "payload.end", note: "the meeting has ended" } },
      { id: "tickets", sources: ["jira"], unless: { "payload.status_category": ["Done"] }, action: "task", group_by: "external_id", done_when: { when: { "payload.status_category": ["Done"] }, note: "{external_id} is {payload.status}" } },
      { id: "mail", sources: ["gmail"], action: "task", group_by: "group_key" },
    ],
  };

  it("finds the tasks an event finishes, even when the rule skips it", () => {
    const resolved: EventInput = { source: "jira", external_id: "T-1", payload: { status_category: "Done" } };
    expect(decide(rules, resolved, { firstRun: false })).toMatchObject({ kind: "none" });
    expect(finishes(rules, resolved).map((found) => [found.rule.id, found.group])).toEqual([["tickets", "tickets|T-1"]]);
    expect(finishes(rules, { source: "jira", external_id: "T-1", payload: { status_category: "In Progress" } })).toEqual([]);
    expect(finishes(rules, { source: "gmail", external_id: "x", payload: { status_category: "Done" } })).toEqual([]);
  });

  it("closes tickets when Jira resolves them, and meetings once they've ended, with a line in the thread", async () => {
    const store = new SignalsStore(pglite(), "signals_done");
    await store.setup();
    const posts: { kind: string; task: number; text?: string }[] = [];
    const hub = new Hub(
      store,
      { opened: async (task) => (posts.push({ kind: "opened", task: task.id }), `root-${task.id}`), updated: async (task, text) => void posts.push({ kind: "updated", task: task.id, text }) },
      { defaultConfig: { ...rules, default_channel: "triage", done_idle_days: 14 } },
    );
    const call = (path: string, body: unknown) => hub.handle({ method: "POST", path, query: new URLSearchParams(), user: "alice@x.com", body: async () => JSON.stringify(body) });
    for (const source of ["jira", "google_calendar", "gmail"]) await call("/api/sources", { source, enabled: true });
    await call("/api/events", { events: [{ source: "jira", external_id: "seed" }, { source: "google_calendar", external_id: "seed" }, { source: "gmail", external_id: "seed" }] });
    const t = Math.floor(Date.now() / 1000);

    // A ticket: open while in progress, done (and said so) when its status category is Done.
    await call("/api/events", { events: [{ source: "jira", external_id: "T-1", title: "T-1 Broken", payload: { status: "In Progress", status_category: "In Progress" } }] });
    expect((await store.task(1))!).toMatchObject({ status: "open" });
    const resolved = await call("/api/events", { events: [{ source: "jira", external_id: "T-1", title: "T-1 Broken", payload: { status: "Resolved", status_category: "Done" } }] });
    expect(resolved.json).toMatchObject({ created: [], updated: [] });
    expect((await store.task(1))!).toMatchObject({ status: "done", event_count: 2 });
    expect(posts.at(-1)).toEqual({ kind: "updated", task: 1, text: doneMessage("T-1 is Resolved") });
    expect((await store.detail(1))!.activities.map((activity) => activity.text)).toContain("done: T-1 is Resolved");
    // Seen again done: nothing more. Reopened in Jira: the task opens again.
    await call("/api/events", { events: [{ source: "jira", external_id: "T-1", title: "T-1 Broken", payload: { status: "Closed", status_category: "Done" } }] });
    expect(posts.filter((post) => post.task === 1 && post.text?.startsWith("✅"))).toHaveLength(1);
    // A ticket first seen already resolved opens nothing.
    await call("/api/events", { events: [{ source: "jira", external_id: "T-2", payload: { status_category: "Done" } }] });
    expect(await store.tasks()).toHaveLength(1);

    // A meeting: done by the sweep once its end has passed, not before.
    const end = t + 3600;
    await call("/api/events", { events: [{ source: "google_calendar", external_id: "m1", title: "QBR", payload: { end: { dateTime: new Date(end * 1000).toISOString() } } }] });
    const meeting = (await store.tasks({ open: true }))[0]!;
    expect(await hub.sweep(end - 60)).toMatchObject({ finished: 0 });
    expect((await store.task(meeting.id))!.status).toBe("open");
    expect(await hub.sweep(end + 60)).toMatchObject({ finished: 1 });
    expect((await store.task(meeting.id))!.status).toBe("done");
    expect(posts.at(-1)).toEqual({ kind: "updated", task: meeting.id, text: doneMessage("the meeting has ended") });
    // A late change to the meeting (after it ended) doesn't reopen it.
    await call("/api/events", { events: [{ source: "google_calendar", external_id: "m1", title: "QBR (notes)", payload: { end: { dateTime: new Date((t - 10) * 1000).toISOString() } } }] });
    expect((await store.task(meeting.id))!.status).toBe("done");

    // A task waiting on a question stays open; the config's done_idle_days closes anything else left idle.
    await call("/api/events", { events: [{ source: "gmail", external_id: "g1", title: "Hello", group_key: "th1" }, { source: "gmail", external_id: "g2", title: "Pricing?", group_key: "th2" }] });
    const [mailA, mailB] = (await store.tasks({ open: true })).sort((a, b) => a.id - b.id);
    await store.setQuestion(mailB!.id, "agent", { question: "Which plan?", options: [], by: "agent" });
    expect(await hub.sweep(t + 13 * 86400)).toMatchObject({ finished: 0 });
    expect(await hub.sweep(t + 15 * 86400)).toMatchObject({ finished: 1 });
    expect((await store.task(mailA!.id))!.status).toBe("done");
    expect(posts.at(-1)!.text).toBe(doneMessage("nothing new in 14 days"));
    expect((await store.task(mailB!.id))!.status).toBe("waiting");
  });
});

describe("work someone on the team did themselves", () => {
  const config: SignalsConfig = {
    version: 1,
    default_channel: "triage",
    rules: [
      { id: "mail", sources: ["gmail"], customer_actor: "@globex\\.io$", action: "task", title: "Reply: {title}", group_by: "group_key", done_when: { by_owner: true } },
      { id: "slack", sources: ["slack", "slack.sent"], customer_actor: "@globex\\.io$", skip_own: true, action: "task", group_by: "group_key", done_when: { by_owner: true } },
      { id: "tickets", sources: ["jira"], action: "task", group_by: "external_id" },
    ],
  };

  it("reads a Slack thread's key from a permalink", () => {
    expect(slackThreadKey("https://x.slack.com/archives/C1/p1795000000123456")).toBe("C1:1795000000.123456");
    expect(slackThreadKey("https://x.slack.com/archives/C1/p1795000300654321?thread_ts=1795000000.123456&cid=C1")).toBe("C1:1795000000.123456");
    expect(slackThreadKey("https://x.slack.com/archives/C1/p1795000300654321?cid=C1&thread_ts=1795000000.123456")).toBe("C1:1795000000.123456");
    expect(slackThreadKey("https://mail/th1")).toBeUndefined();
    expect(slackThreadKey(undefined)).toBeUndefined();
  });

  it("offers the sent sources on their own in Settings, each with its sign-in service", () => {
    const sources = new Map(DEFAULT_SOURCES.map((info) => [info.name, info]));
    expect(sources.get("gmail")).toMatchObject({ service: "gmail", description: "Mail in your inbox." });
    expect(sources.get("gmail.sent")).toMatchObject({ service: "gmail" });
    expect(sources.get("slack.sent")).toMatchObject({ service: "slack" });
  });

  it("finds the tasks an owner's own event handles, only for by_owner rules", () => {
    const reply: EventInput = { source: "gmail", external_id: "m2", actor: "Alice <Alice@x.com>", group_key: "th1" };
    expect(decide(config, reply, { firstRun: false, owner: "alice@x.com" })).toMatchObject({ kind: "none" });
    expect(handledBy(config, reply, "alice@x.com").map((found) => found.group)).toEqual(["mail|th1"]);
    expect(handledBy(config, reply, "bob@x.com")).toEqual([]);
    expect(handledBy(config, reply, undefined)).toEqual([]);
    expect(handledBy(config, { source: "slack.sent", external_id: "s", actor: "alice@x.com", group_key: "1795000000" }, "alice@x.com").map((found) => found.group)).toEqual(["slack|1795000000"]);
    expect(handledBy(config, { source: "jira", external_id: "T-1", actor: "alice@x.com" }, "alice@x.com")).toEqual([]);
  });

  const setup = async (schema: string) => {
    const store = new SignalsStore(pglite(), schema);
    await store.setup();
    const posts: { task: number; text: string; agents: readonly string[] }[] = [];
    const hub = new Hub(store, { opened: async (task) => `root-${task.id}`, updated: async (task, text, agents = []) => void posts.push({ task: task.id, text, agents }) }, { defaultConfig: config });
    const call = (path: string, body: unknown, user = "alice@x.com") => hub.handle({ method: "POST", path, query: new URLSearchParams(), user, body: async () => JSON.stringify(body) });
    for (const user of ["alice@x.com", "bob@x.com"])
      for (const source of ["gmail", "slack", "slack.sent", "jira"]) {
        await call("/api/sources", { source, enabled: true }, user);
        await call("/api/events", { events: [{ source, external_id: "seed" }] }, user);
      }
    return { store, hub, posts, call };
  };
  const agent = "ab".repeat(32);

  it("closes the task when the owner replies in its thread: theirs, recorded, agents off, and a customer reply opens it again", async () => {
    const { store, posts, call } = await setup("signals_handled");
    await call("/api/events", { events: [{ source: "gmail", external_id: "m1", actor: "Ann <ann@globex.io>", title: "Pricing?", group_key: "th1" }] });
    const task = (await store.tasks({ open: true }))[0]!;
    await store.assign(task.id, "agent", agent, false);
    await store.setQuestion(task.id, "agent", { question: "Which plan?", options: [], by: agent });
    posts.length = 0;

    const reply = await call("/api/events", { events: [{ source: "gmail", external_id: "m2", actor: "Alice <alice@x.com>", title: "Re: Pricing?", group_key: "th1", url: "https://mail/th1" }] });
    expect(reply.json).toMatchObject({ created: [], updated: [] });
    expect(await store.task(task.id)).toMatchObject({ status: "done", question: null, event_count: 2 });
    const people = (await store.people([task.id])).get(task.id)!;
    expect(people).toEqual([expect.objectContaining({ kind: "person", key: "alice@x.com", assigned_at: expect.any(Number) })]);
    const detail = (await store.detail(task.id))!;
    expect(detail.activities.map((item) => item.text)).toEqual(expect.arrayContaining(["alice@x.com handled it themselves (gmail): Re: Pricing? https://mail/th1", "done: handled by alice@x.com"]));
    expect(detail.artifacts).toEqual([expect.objectContaining({ actor: "alice@x.com", url: "https://mail/th1" })]);
    expect(posts).toEqual([{ task: task.id, text: handledMessage("alice@x.com", "Re: Pricing?", "https://mail/th1", [agent]), agents: [agent] }]);
    expect(posts[0]!.text).toContain("you're off this task");

    // Seen again: nothing more. The customer writes again: open again, still Alice's.
    await call("/api/events", { events: [{ source: "gmail", external_id: "m2", actor: "Alice <alice@x.com>", title: "Re: Pricing? (edited)", group_key: "th1" }] });
    expect(posts).toHaveLength(1);
    await call("/api/events", { events: [{ source: "gmail", external_id: "m3", actor: "Ann <ann@globex.io>", title: "Re: Pricing?", group_key: "th1" }] });
    expect(await store.task(task.id)).toMatchObject({ status: "open" });
    expect((await store.people([task.id])).get(task.id)!.map((person) => person.key)).toEqual(["alice@x.com"]);
  });

  it("keeps an owner someone chose, closes from a Slack reply, and leaves other people's and other threads' events alone", async () => {
    const { store, posts, call } = await setup("signals_handled_slack");
    await call("/api/events", { events: [{ source: "slack", external_id: "s1", actor: "ann@globex.io", title: "Is ingest down?", group_key: "1795000000" }] });
    await call("/api/events", { events: [{ source: "gmail", external_id: "m1", actor: "ann@globex.io", title: "Other", group_key: "th9" }] });
    const [slack, mail] = (await store.tasks({ open: true })).sort((a, b) => a.id - b.id);
    await store.assign(slack!.id, "person", "carol@x.com", true);

    // Bob's reply in another thread, and Alice's mail in another thread: nothing.
    await call("/api/events", { events: [{ source: "slack.sent", external_id: "s2", actor: "alice@x.com", title: "unrelated", group_key: "1795009999" }] });
    await call("/api/events", { events: [{ source: "gmail", external_id: "m2", actor: "bob@x.com", title: "Re: Other", group_key: "th1" }] }, "bob@x.com");
    expect((await store.task(slack!.id))!.status).toBe("open");
    expect((await store.task(mail!.id))!.status).toBe("open");

    // Bob replies in the Slack thread, seen by his own slack.sent source: done, still Carol's.
    await call("/api/events", { events: [{ source: "slack.sent", external_id: "s3", actor: "bob@x.com", title: "Looking now, it's back", group_key: "1795000000" }] }, "bob@x.com");
    expect((await store.task(slack!.id))!.status).toBe("done");
    expect((await store.people([slack!.id])).get(slack!.id)!.map((person) => person.key)).toEqual(["carol@x.com"]);
    expect(posts.at(-1)).toEqual({ task: slack!.id, text: handledMessage("bob@x.com", "Looking now, it's back", undefined, [], "carol@x.com"), agents: [] });
    expect(posts.at(-1)!.text).toContain("It stays with **carol@x.com**");
  });

  it("closes a task whose team reply came in before the customer's message, and never posts it", async () => {
    const { store, call } = await setup("signals_handled_early");
    await call("/api/events", { events: [{ source: "gmail", external_id: "r1", actor: "alice@x.com", title: "Re: Pricing?", group_key: "th1", occurred_at: 1795001100 }] });
    expect(await store.tasks({})).toHaveLength(0);
    const opened = await call("/api/events", { events: [{ source: "gmail", external_id: "m1", actor: "ann@globex.io", title: "Pricing?", group_key: "th1", occurred_at: 1795001000 }] });
    expect(opened.json).toMatchObject({ created: [] });
    const [task] = await store.tasks({});
    expect(task).toMatchObject({ status: "done", buzz_root: null, event_count: 2 });
    expect((await store.people([task!.id])).get(task!.id)!.map((person) => person.key)).toEqual(["alice@x.com"]);
  });

  it("decides by event time: an older team reply doesn't close a newer customer message, or reopen for an older one", async () => {
    const { store, call } = await setup("signals_handled_order");
    await call("/api/events", { events: [{ source: "gmail", external_id: "m1", actor: "ann@globex.io", title: "Pricing?", group_key: "th1", occurred_at: 1795001000 }] });
    await call("/api/events", { events: [{ source: "gmail", external_id: "m2", actor: "ann@globex.io", title: "Also SSO?", group_key: "th1", occurred_at: 1795002000 }] });
    const [task] = await store.tasks({});
    // Alice's reply to the first message, delivered late: the follow-up still needs an answer.
    await call("/api/events", { events: [{ source: "gmail", external_id: "r1", actor: "alice@x.com", title: "Re: Pricing?", group_key: "th1", occurred_at: 1795001500 }] });
    expect((await store.task(task!.id))!.status).toBe("open");
    // Her reply to both: done. Then the customer's earlier message, delivered late: still done.
    await call("/api/events", { events: [{ source: "gmail", external_id: "r2", actor: "alice@x.com", title: "Re: Also SSO?", group_key: "th1", occurred_at: 1795002500 }] });
    expect((await store.task(task!.id))!.status).toBe("done");
    await call("/api/events", { events: [{ source: "gmail", external_id: "m0", actor: "ann@globex.io", title: "Hello?", group_key: "th1", occurred_at: 1795000500 }] });
    expect((await store.task(task!.id))!.status).toBe("done");
    // A newer one opens it again.
    await call("/api/events", { events: [{ source: "gmail", external_id: "m3", actor: "ann@globex.io", title: "Thanks, one more", group_key: "th1", occurred_at: 1795003000 }] });
    expect((await store.task(task!.id))!.status).toBe("open");
  });

  it("finishes a closure a failed write cut short when the reply comes again, and tells the agents once", async () => {
    let fail = 0;
    const db = pglite();
    const flaky: Db = { query: async (text, values) => (fail > 0 && /INSERT INTO \S+\.activities/.test(text) && fail-- ? Promise.reject(new Error("connection reset")) : db.query(text, values)) };
    const store = new SignalsStore(flaky, "signals_handled_retry");
    await store.setup();
    const posts: { task: number; text: string; agents: readonly string[] }[] = [];
    const hub = new Hub(store, { opened: async (task) => `root-${task.id}`, updated: async (task, text, agents = []) => void posts.push({ task: task.id, text, agents }) }, { defaultConfig: config });
    const call = (path: string, body: unknown) => hub.handle({ method: "POST", path, query: new URLSearchParams(), user: "alice@x.com", body: async () => JSON.stringify(body) });
    await call("/api/sources", { source: "gmail", enabled: true });
    await call("/api/events", { events: [{ source: "gmail", external_id: "seed" }] });
    await call("/api/events", { events: [{ source: "gmail", external_id: "m1", actor: "ann@globex.io", title: "Pricing?", group_key: "th1" }] });
    const [task] = await store.tasks({});
    await store.assign(task!.id, "agent", agent, false);
    posts.length = 0;

    const reply = { source: "gmail", external_id: "r1", actor: "alice@x.com", title: "Re: Pricing?", group_key: "th1", url: "https://mail/th1" };
    fail = 1;
    const first = await call("/api/events", { events: [reply] });
    expect((first.json as { errors: unknown[] }).errors).toHaveLength(1);
    expect((await store.task(task!.id))!.status).toBe("open");
    expect((await store.people([task!.id])).get(task!.id)!.map((person) => person.key)).toEqual([agent]);
    expect(posts).toHaveLength(0);

    // The poller sends it again (its cursor didn't move): same content, and the closure finishes.
    await call("/api/events", { events: [reply] });
    expect((await store.task(task!.id))!.status).toBe("done");
    const detail = (await store.detail(task!.id))!;
    expect(detail.activities.filter((item) => item.kind === "handled")).toHaveLength(1);
    expect(detail.artifacts).toHaveLength(1);
    expect(posts).toEqual([{ task: task!.id, text: handledMessage("alice@x.com", "Re: Pricing?", "https://mail/th1", [agent]), agents: [agent] }]);
    await call("/api/events", { events: [reply] });
    expect(posts).toHaveLength(1);
  });

  it("makes the responder the owner when only an agent owned it", async () => {
    const { store, posts, call } = await setup("signals_handled_agent_owner");
    await call("/api/events", { events: [{ source: "gmail", external_id: "m1", actor: "ann@globex.io", title: "Pricing?", group_key: "th1" }] });
    const [task] = await store.tasks({});
    await store.assign(task!.id, "agent", agent, true);
    await call("/api/events", { events: [{ source: "gmail", external_id: "r1", actor: "alice@x.com", title: "Re: Pricing?", group_key: "th1" }] });
    expect(await store.task(task!.id)).toMatchObject({ status: "done" });
    expect((await store.people([task!.id])).get(task!.id)).toEqual([expect.objectContaining({ kind: "person", key: "alice@x.com", assigned_at: expect.any(Number) })]);
    expect(posts.at(-1)!.text).toContain("It's theirs now");
  });

  it("keeps Slack threads apart by channel and root, and a reply permalink finds its root's task", async () => {
    const { store, call } = await setup("signals_handled_slack_keys");
    // As the example slack sources map them: channel:root thread_ts.
    await call("/api/events", { events: [{ source: "slack", external_id: "https://x.slack.com/archives/C1/p1795000000123456", actor: "ann@globex.io", title: "Is ingest down?", group_key: "C1:1795000000.123456", occurred_at: "1795000000.123456" }] });
    await call("/api/events", { events: [{ source: "slack", external_id: "https://x.slack.com/archives/C2/p1795000000999999", actor: "ann@globex.io", title: "Other channel", group_key: "C2:1795000000.999999", occurred_at: "1795000000.999999" }] });
    const [one, two] = (await store.tasks({ open: true })).sort((a, b) => a.id - b.id);
    expect([one!.group_key, two!.group_key]).toEqual(["slack|C1:1795000000.123456", "slack|C2:1795000000.999999"]);
    await call("/api/events", { events: [{ source: "slack.sent", external_id: "https://x.slack.com/archives/C1/p1795000300654321", actor: "alice@x.com", title: "Looking", group_key: "C1:1795000000.123456", occurred_at: "1795000300.654321" }] });
    expect((await store.task(one!.id))!.status).toBe("done");
    expect((await store.task(two!.id))!.status).toBe("open");
  });

  describe("Slack tasks keyed the old way (the root's second)", () => {
    const link = (channel: string, ts: string, root?: string) => `https://x.slack.com/archives/${channel}/p${ts.replace(".", "")}${root ? `?thread_ts=${root}&cid=${channel}` : ""}`;
    // As the earlier example source sent them: group_key the old regex's first match (`/p…` comes first, so a reply's own second), url the permalink.
    const legacy = (id: string, channel: string, ts: string, root?: string) => ({ source: "slack", external_id: link(channel, ts), url: link(channel, ts, root), actor: "ann@globex.io", title: `msg ${id}`, group_key: /thread_ts=(\d{10})|\/p(\d{10})/.exec(link(channel, ts, root))!.slice(1).find(Boolean)!, occurred_at: ts });
    const current = (source: string, channel: string, ts: string, root: string, actor = "ann@globex.io") => ({ source, external_id: link(channel, ts), url: link(channel, ts, root === ts ? undefined : root), actor, title: `${source} ${ts}`, group_key: `${channel}:${root}`, occurred_at: ts });

    it("a customer's new message in the thread joins the old task, and a team reply closes it", async () => {
      const { store, call } = await setup("signals_legacy_both");
      await call("/api/events", { events: [legacy("1", "C1", "1795000000.123456")] });
      const [task] = await store.tasks({});
      expect(task!.group_key).toBe("slack|1795000000");
      // The customer writes again in that thread, now keyed the new way: no second task.
      await call("/api/events", { events: [current("slack", "C1", "1795000100.000001", "1795000000.123456")] });
      expect(await store.tasks({})).toHaveLength(1);
      expect((await store.task(task!.id))!.event_count).toBe(2);
      // Alice replies in it: the old task closes.
      await call("/api/events", { events: [current("slack.sent", "C1", "1795000200.000002", "1795000000.123456", "alice@x.com")] });
      expect((await store.task(task!.id))!.status).toBe("done");
      expect(await store.tasks({})).toHaveLength(1);
    });

    it("a team reply first, then the customer: both on the old task (from a reply's permalink)", async () => {
      const { store, call } = await setup("signals_legacy_reply_first");
      // The old task was opened by a reply in the thread: its permalink names the root.
      await call("/api/events", { events: [legacy("1", "C1", "1795000050.000009", "1795000000.123456")] });
      const [task] = await store.tasks({});
      await call("/api/events", { events: [current("slack.sent", "C1", "1795000200.000002", "1795000000.123456", "alice@x.com")] });
      expect((await store.task(task!.id))!.status).toBe("done");
      await call("/api/events", { events: [current("slack", "C1", "1795000300.000003", "1795000000.123456")] });
      expect(await store.tasks({})).toHaveLength(1);
      expect((await store.task(task!.id))!.status).toBe("open");
    });

    it("finds an old task keyed by the reply's own second that opened it, from the root its permalink names", async () => {
      const { store, call } = await setup("signals_legacy_reply_second");
      await call("/api/events", { events: [legacy("1", "C1", "1795000050.000009", "1795000000.123456")] });
      const [task] = await store.tasks({});
      expect(task!.group_key).toBe("slack|1795000050");
      await call("/api/events", { events: [current("slack.sent", "C1", "1795000200.000002", "1795000000.123456", "alice@x.com")] });
      expect((await store.task(task!.id))!.status).toBe("done");
      await call("/api/events", { events: [current("slack", "C1", "1795000300.000003", "1795000000.123456")] });
      expect(await store.tasks({})).toHaveLength(1);
      expect((await store.task(task!.id))!).toMatchObject({ status: "open", event_count: 3 });
    });

    it("leaves alone a thread two old tasks both hold", async () => {
      const { store, call } = await setup("signals_legacy_two_old");
      await call("/api/events", { events: [legacy("1", "C1", "1795000050.000009", "1795000000.123456"), legacy("2", "C1", "1795000070.000001", "1795000000.123456")] });
      expect(await store.tasks({})).toHaveLength(2);
      await call("/api/events", { events: [current("slack.sent", "C1", "1795000200.000002", "1795000000.123456", "alice@x.com")] });
      expect((await store.tasks({})).every((task) => task.status === "open")).toBe(true);
    });

    it("keeps two threads that started in the same second apart, and leaves an old task that mixed them alone", async () => {
      const { store, call } = await setup("signals_legacy_same_second");
      await call("/api/events", { events: [legacy("1", "C1", "1795000000.123456")] });
      const [old] = await store.tasks({});
      // Another thread, same second (another channel, then the same channel): its own task; the old one is untouched.
      await call("/api/events", { events: [current("slack", "C2", "1795000000.999999", "1795000000.999999")] });
      await call("/api/events", { events: [current("slack.sent", "C1", "1795000400.000001", "1795000000.000001", "alice@x.com")] });
      await call("/api/events", { events: [current("slack", "C1", "1795000500.000001", "1795000000.000001")] });
      const tasks = (await store.tasks({})).sort((a, b) => a.id - b.id);
      expect(tasks.map((task) => task.group_key)).toEqual(["slack|1795000000", "slack|C2:1795000000.999999", "slack|C1:1795000000.000001"]);
      expect((await store.task(old!.id))!).toMatchObject({ status: "open", event_count: 1 });

      // An old task that already holds both threads of a second (the bug this fixes): neither new key takes it.
      const mixed = await setup("signals_legacy_mixed");
      await mixed.call("/api/events", { events: [legacy("1", "C1", "1795000000.123456"), legacy("2", "C1", "1795000000.000001")] });
      const [both] = await mixed.store.tasks({});
      expect(both!.event_count).toBe(2);
      await mixed.call("/api/events", { events: [current("slack.sent", "C1", "1795000200.000002", "1795000000.123456", "alice@x.com")] });
      expect((await mixed.store.task(both!.id))!.status).toBe("open");
    });
  });

  it("orders a team reply and a customer message in the same second by Slack's ts", async () => {
    const { store, call } = await setup("signals_handled_subsecond");
    const msg = (source: string, ts: string, actor: string) => ({ source, external_id: `https://x.slack.com/archives/C1/p${ts.replace(".", "")}`, actor, title: ts, group_key: "C1:1795001000.000001", occurred_at: ts });
    await call("/api/events", { events: [msg("slack", "1795001030.900000", "ann@globex.io")] });
    const [task] = await store.tasks({});
    // Delivered after the customer's message, but sent 0.8 s before it: it didn't answer it.
    await call("/api/events", { events: [msg("slack.sent", "1795001030.100000", "alice@x.com")] });
    expect((await store.task(task!.id))!.status).toBe("open");
    // A later reply in the same second does close it, and a customer message just before that reply doesn't reopen it.
    await call("/api/events", { events: [msg("slack.sent", "1795001030.950000", "alice@x.com")] });
    expect((await store.task(task!.id))!.status).toBe("done");
    await call("/api/events", { events: [msg("slack", "1795001030.920000", "ann@globex.io")] });
    expect((await store.task(task!.id))!.status).toBe("done");
    await call("/api/events", { events: [msg("slack", "1795001030.960000", "ann@globex.io")] });
    expect((await store.task(task!.id))!.status).toBe("open");
  });

  it("keeps the closure when the same reply is decided twice (overlapping deliveries)", async () => {
    const { store, call } = await setup("signals_handled_overlap");
    await call("/api/events", { events: [{ source: "gmail", external_id: "m1", actor: "ann@globex.io", group_key: "th1", occurred_at: 1795000100 }] });
    const [task] = await store.tasks({});
    const sent = { source: "gmail", external_id: "m2", actor: "alice@x.com", group_key: "th1", occurred_at: 1795000200 };
    // Two deliveries at once, then the other one's handled() again after the first closed it (the overlap's last step).
    await Promise.all([call("/api/events", { events: [sent] }), call("/api/events", { events: [sent] })]);
    expect((await store.task(task!.id))!.status).toBe("done");
    const reply = { group: "mail|th1", event: Number((await store.detail(task!.id))!.events.find((event) => event.external_id === "m2")!.id), owner: "alice@x.com", source: "gmail", title: null, url: null, at: 1795000200, micros: 1795000200_000000 };
    expect(await store.handled(task!.id, reply)).toBeUndefined();
    // A late customer message older than the reply: the reply answered it, so it stays done.
    await call("/api/events", { events: [{ source: "gmail", external_id: "m0", actor: "ann@globex.io", group_key: "th1", occurred_at: 1795000150 }] });
    expect((await store.task(task!.id))!.status).toBe("done");
  });

  it("forgets a source's replies with its events, pending ones too", async () => {
    const { store, call } = await setup("signals_handled_forget");
    // Alice's reply comes in before the customer's message: it waits for the task.
    await call("/api/events", { events: [{ source: "slack.sent", external_id: "s2", actor: "alice@x.com", group_key: "C1:1795000000.000001", occurred_at: "1795000200.000000" }] });
    await call("/api/sources", { source: "slack.sent", enabled: false, forget: true });
    await call("/api/events", { events: [{ source: "slack", external_id: "s1", actor: "ann@globex.io", group_key: "C1:1795000000.000001", occurred_at: "1795000100.000000" }] });
    const [task] = await store.tasks({});
    expect(task!.status).toBe("open");
  });

  it("keeps a task done for a late customer message that a later saved reply answered", async () => {
    const { store, call } = await setup("signals_handled_two_saved");
    const mail = (id: string, actor: string, at: number) => ({ source: "gmail", external_id: id, actor, group_key: "th1", occurred_at: at });
    // Two team replies come in before the customer's message: the first closes the task, the second finds it done.
    await call("/api/events", { events: [mail("r1", "alice@x.com", 1795000100), mail("r2", "alice@x.com", 1795000300)] });
    await call("/api/events", { events: [mail("c0", "ann@globex.io", 1795000000)] });
    const [task] = await store.tasks({});
    expect(task!.status).toBe("done");
    // A late customer message between them: the second reply answered it.
    await call("/api/events", { events: [mail("c2", "ann@globex.io", 1795000200)] });
    expect((await store.task(task!.id))!.status).toBe("done");
    await call("/api/events", { events: [mail("c4", "ann@globex.io", 1795000400)] });
    expect((await store.task(task!.id))!.status).toBe("open");
  });

  it("doesn't close a task with a reply Forget deleted while it was being decided", async () => {
    const pg = new PGlite();
    let paused: (() => Promise<void>) | undefined;
    const db: Db = {
      query: async (text, values) => {
        // Forget runs between the reply's attachment and the closure's statement.
        if (paused && text.includes("handled it themselves") === false && text.includes("kept AS")) {
          const run = paused;
          paused = undefined;
          await run();
        }
        return { rows: (await pg.query(text, values)).rows as never[] };
      },
    };
    const store = new SignalsStore(db, "signals_handled_forget_inflight");
    await store.setup();
    for (const source of ["gmail", "slack", "slack.sent"]) {
      await store.setSource("alice@x.com", source, true);
      await store.ingest("alice@x.com", [{ source, external_id: "seed" }], config);
    }
    await store.ingest("alice@x.com", [{ source: "slack", external_id: "c1", actor: "ann@globex.io", group_key: "C1:1795000000.000001", occurred_at: "1795000100.000000" }], config);
    const [task] = await store.tasks({});
    paused = () => store.setSource("alice@x.com", "slack.sent", false, undefined, true);
    const result = await store.ingest("alice@x.com", [{ source: "slack.sent", external_id: "s1", actor: "alice@x.com", group_key: "C1:1795000000.000001", occurred_at: "1795000200.000000" }], config);
    expect(paused).toBeUndefined();
    expect(result.handled).toEqual([]);
    expect((await store.task(task!.id))!.status).toBe("open");
  });

  it("doesn't save a reply whose event Forget deleted before it was saved", async () => {
    const pg = new PGlite();
    let paused: (() => Promise<void>) | undefined;
    const db: Db = {
      query: async (text, values) => {
        // Forget runs after the sent event is written, before its reply is saved.
        if (paused && text.includes(".replies (group_key")) {
          const run = paused;
          paused = undefined;
          await run();
        }
        return { rows: (await pg.query(text, values)).rows as never[] };
      },
    };
    const store = new SignalsStore(db, "signals_handled_forget_early");
    await store.setup();
    for (const source of ["gmail", "slack", "slack.sent"]) {
      await store.setSource("alice@x.com", source, true);
      await store.ingest("alice@x.com", [{ source, external_id: "seed" }], config);
    }
    await store.ingest("alice@x.com", [{ source: "slack", external_id: "c1", actor: "ann@globex.io", group_key: "C1:1795000000.000001", occurred_at: "1795000100.000000" }], config);
    const [task] = await store.tasks({});
    paused = () => store.setSource("alice@x.com", "slack.sent", false, undefined, true);
    const result = await store.ingest("alice@x.com", [{ source: "slack.sent", external_id: "s1", actor: "alice@x.com", group_key: "C1:1795000000.000001", occurred_at: "1795000200.000000" }], config);
    expect(paused).toBeUndefined();
    expect(result.handled).toEqual([]);
    expect((await store.task(task!.id))!.status).toBe("open");
    expect((await pg.query("SELECT count(*)::int AS n FROM signals_handled_forget_early.replies")).rows).toEqual([{ n: 0 }]);
    // Later customer messages still find it open, and nothing the forgotten reply left closes it.
    await store.ingest("alice@x.com", [{ source: "slack", external_id: "c2", actor: "ann@globex.io", group_key: "C1:1795000000.000001", occurred_at: "1795000150.000000" }], config);
    expect((await store.task(task!.id))!.status).toBe("open");
  });

  for (const existing of [true, false])
    it(`keeps a task open for a newer customer message an older reply was decided against while it was being attached (${existing ? "existing task" : "task it opens"})`, async () => {
      const pg = new PGlite();
      let paused: (() => Promise<void>) | undefined;
      const db: Db = {
        query: async (text, values) => {
          // The team's reply is ingested and decided just before the customer's message is attached.
          if (paused && text.includes(".task_events (task_id, event_id, version, at)") && values?.[1] === customerId) {
            const run = paused;
            paused = undefined;
            await run();
          }
          return { rows: (await pg.query(text, values)).rows as never[] };
        },
      };
      let customerId: unknown;
      const schema = `signals_handled_attach_${existing ? "old" : "new"}`;
      const store = new SignalsStore(db, schema);
      await store.setup();
      for (const source of ["gmail", "slack", "slack.sent"]) {
        await store.setSource("alice@x.com", source, true);
        await store.ingest("alice@x.com", [{ source, external_id: "seed" }], config);
      }
      const group = "C1:1795000000.000001";
      if (existing) await store.ingest("alice@x.com", [{ source: "slack", external_id: "c0", actor: "ann@globex.io", group_key: group, occurred_at: "1795000100.000000" }], config);
      let reply: Awaited<ReturnType<SignalsStore["ingest"]>> | undefined;
      paused = async () => {
        reply = await store.ingest("alice@x.com", [{ source: "slack.sent", external_id: "s1", actor: "alice@x.com", group_key: group, occurred_at: "1795000200.000000" }], config);
      };
      const original = pg.query.bind(pg);
      // (The customer event's row id, once it's written, so the pause is at its own attachment.)
      pg.query = (async (text: string, values?: unknown[]) => {
        const out = await original(text, values);
        if (customerId === undefined && text.includes(".events (owner, source, external_id") && values?.[2] === "c3") customerId = (out.rows[0] as { id: unknown }).id;
        return out;
      }) as typeof pg.query;
      const customer = await store.ingest("alice@x.com", [{ source: "slack", external_id: "c3", actor: "ann@globex.io", group_key: group, occurred_at: "1795000300.000000" }], config);
      expect(paused).toBeUndefined();
      expect(reply!.handled.length).toBe(existing ? 1 : 1);
      const [task] = await store.tasks({});
      const events = await pg.query<{ n: number }>(`SELECT count(*)::int AS n FROM ${schema}.task_events WHERE task_id = $1`, [task!.id]);
      expect(events.rows[0]!.n).toBe(existing ? 3 : 2);
      expect((await store.task(task!.id))!.status).toBe("open");
      if (!existing) expect(customer.created.map((t) => t.status)).toEqual(["open"]);
      // And a later reply still closes it.
      const again = await store.ingest("alice@x.com", [{ source: "slack.sent", external_id: "s2", actor: "alice@x.com", group_key: group, occurred_at: "1795000400.000000" }], config);
      expect(again.handled.length).toBe(1);
    });

  it("orders an event saved before the upgrade by its own permalink's ts, not the root's", async () => {
    const { store, call } = await setup("signals_handled_upgrade_us");
    const root = "1795001000.000001";
    // The customer's reply in the thread, at .900000: its permalink is its own ts, thread_ts the root's.
    await call("/api/events", { events: [{ source: "slack", external_id: "https://x.slack.com/archives/C1/p1795001030900000", url: `https://x.slack.com/archives/C1/p1795001030900000?thread_ts=${root}&cid=C1`, actor: "ann@globex.io", group_key: `C1:${root}`, occurred_at: "1795001030.900000" }] });
    const [task] = await store.tasks({});
    // As a row saved before occurred_us existed.
    await (store as unknown as { q: (text: string) => Promise<unknown> }).q(`UPDATE $S.events SET occurred_us = NULL`);
    await call("/api/events", { events: [{ source: "slack.sent", external_id: "https://x.slack.com/archives/C1/p1795001030100000", actor: "alice@x.com", group_key: `C1:${root}`, occurred_at: "1795001030.100000" }] });
    expect((await store.task(task!.id))!.status).toBe("open");
    await call("/api/events", { events: [{ source: "slack.sent", external_id: "https://x.slack.com/archives/C1/p1795001030950000", actor: "alice@x.com", group_key: `C1:${root}`, occurred_at: "1795001030.950000" }] });
    expect((await store.task(task!.id))!.status).toBe("done");
  });

  it("closes nothing for a rule without by_owner", async () => {
    const { store, call } = await setup("signals_handled_off");
    await call("/api/events", { events: [{ source: "jira", external_id: "T-1", actor: "ann@globex.io" }] });
    await call("/api/events", { events: [{ source: "jira", external_id: "T-1", actor: "alice@x.com", title: "changed" }] });
    expect((await store.tasks({ open: true }))).toHaveLength(1);
  });
});

describe("Slack markup", () => {
  it("shows mentions, channels and links as people read them", () => {
    expect(plainSlack("<@U029YEWF7V2|Brandon Kvarda> can you look? cc <@U12>")).toBe("@Brandon Kvarda can you look? cc @U12");
    expect(plainSlack("in <#C0123|ext-globex> and <#C9|>, <!here> <!channel> <!subteam^S1|@eng> <!subteam^S2|ops> <!subteam^S3>")).toBe("in #ext-globex and #C9, @here @channel @eng @ops @team");
    expect(plainSlack("see <https://x.io/a?b=1|the doc> or <https://y.io>")).toBe("see [the doc](https://x.io/a?b=1) or https://y.io");
    expect(plainSlack("From: Ann <ann@globex.io>, 2 < 3")).toBe("From: Ann <ann@globex.io>, 2 < 3");
    expect(plainSlack(null)).toBeNull();
  });

  it("shows tasks and their posts without the markup, and rules still see it", async () => {
    const store = new SignalsStore(pglite(), "signals_slack");
    await store.setup();
    const posts: { kind: string; text: string }[] = [];
    const hub = new Hub(
      store,
      { opened: async (task, agents = [], context = {}) => (posts.push({ kind: "opened", text: taskMessage(task, { agents, ...context }) }), `root-${task.id}`), updated: async (_task, text) => void posts.push({ kind: "updated", text }) },
      { defaultConfig: { version: 1, default_channel: "triage", rules: [{ id: "asks", sources: ["slack"], when: { title: "<@U029YEWF7V2" }, action: "task", group_by: "group_key", title: "Answer: {title}" }] } },
    );
    const call = (method: string, path: string, body?: unknown, query = "") => hub.handle({ method, path, query: new URLSearchParams(query), user: "alice@x.com", body: async () => (body === undefined ? "" : JSON.stringify(body)) });
    await call("POST", "/api/sources", { source: "slack", enabled: true });
    await call("POST", "/api/events", { events: [{ source: "slack", external_id: "seed" }] });
    const raw = "<@U029YEWF7V2|Brandon Kvarda> can you check <#C1|ext-globex>?";
    await call("POST", "/api/events", { events: [{ source: "slack", external_id: "s1", group_key: "t1", title: raw, payload: { text: raw } }] });
    const task = (await store.task(1))!;
    expect(task.title).toBe("Answer: @Brandon Kvarda can you check #ext-globex?");
    expect(posts[0]!.text).toContain("📌 **Task 1: Answer: @Brandon Kvarda can you check #ext-globex?**");
    expect(posts[0]!.text).toContain("text: @Brandon Kvarda can you check #ext-globex?");
    expect(posts[0]!.text).not.toContain("<@U");
    await call("POST", "/api/events", { events: [{ source: "slack", external_id: "s2", group_key: "t1", title: "<@U029YEWF7V2|Brandon Kvarda> any news?" }] });
    expect(posts.at(-1)!.text).toBe("Update: @Brandon Kvarda any news?");
    const detail = (await call("GET", "/api/task", undefined, "id=1")).json as { task: { title: string }; events: { title: string }[] };
    expect(detail.task.title).not.toContain("<@");
    expect(detail.events.map((event) => event.title)).toEqual(expect.arrayContaining(["@Brandon Kvarda any news?"]));
    const board = (await call("GET", "/api/board", undefined, "channel=triage")).json as { tasks: { task: { title: string }; source?: { title?: string } }[] };
    expect(board.tasks[0]!.task.title).toBe("Answer: @Brandon Kvarda can you check #ext-globex?");
    expect(board.tasks[0]!.source!.title).toBe("@Brandon Kvarda any news?");
  });
});

describe("account ids", () => {
  it("are kept by kind, served to pollers and find the account of events that carry one", async () => {
    const store = new SignalsStore(pglite(), "signals_ids");
    await store.setup();
    const config: SignalsConfig = { version: 1, first_run_seen: true, rules: [{ id: "cases", sources: ["table.*"], action: "task", group_by: "external_id" }], accounts: [{ name: "Initech", ids: { crm: ["001-INI"] } }] };
    const hub = new Hub(store, undefined, { defaultConfig: config });
    const call = (method: string, path: string, body?: unknown, query = "") => hub.handle({ method, path, query: new URLSearchParams(query), user: "alice@x.com", body: async () => (body === undefined ? "" : JSON.stringify(body)) });

    expect(await call("POST", "/api/account", { name: "Globex", ids: { "CRM id": ["x"] } })).toMatchObject({ status: 400 });
    expect(await call("POST", "/api/account", { name: "Globex", ids: { since: ["x"] } })).toMatchObject({ status: 400 });
    expect(configProblems({ ...config, accounts: [{ name: "X", ids: ["nope"] as never }] })).toEqual([expect.stringContaining("accounts[0].ids")]);
    const saved = await call("POST", "/api/account", { name: "Globex", channel: "globex", ids: { CRM: "001-GLX, 001-GLX2", jira_customer: ["Globex", "Globex Corp", "Globex"], empty: [] } });
    expect(saved.json).toMatchObject({ account: { ids: { crm: ["001-GLX", "001-GLX2"], jira_customer: ["Globex", "Globex Corp"] } } });
    // Every account's ids by kind, registered and config accounts.
    expect((await call("GET", "/api/ids")).json).toEqual({ ids: { crm: ["001-GLX", "001-GLX2", "001-INI"], jira_customer: ["Globex", "Globex Corp"] } });
    // The same, for pollers that reach the hub through Lakebase.
    expect((await store["db"].query("SELECT kind, id FROM signals_ids.account_ids ORDER BY kind, id")).rows).toEqual([
      { kind: "crm", id: "001-GLX" },
      { kind: "crm", id: "001-GLX2" },
      { kind: "crm", id: "001-INI" },
      { kind: "jira_customer", id: "Globex" },
      { kind: "jira_customer", id: "Globex Corp" },
    ]);
    // An event whose account is an id finds the account (any case).
    await call("POST", "/api/sources", { source: "table.cases", enabled: true });
    await call("POST", "/api/events", { events: [{ source: "table.cases", external_id: "seed" }] });
    await call("POST", "/api/events", { events: [{ source: "table.cases", external_id: "C-1", account: "001-glx2", title: "Case" }, { source: "table.cases", external_id: "C-2", account: "001-INI", title: "Case" }] });
    const tasks = await store.tasks({});
    expect(tasks.find((task) => task.group_key.endsWith("C-1"))).toMatchObject({ account: "Globex", channel: "globex" });
    expect(tasks.find((task) => task.group_key.endsWith("C-2"))).toMatchObject({ account: "Initech" });
    expect((await call("GET", "/api/account", undefined, "name=001-GLX")).json).toMatchObject({ account: { name: "Globex" } });
    // Saving without ids keeps them; {} clears them.
    await call("POST", "/api/account", { name: "Globex", preferences: "questions: ask" });
    expect((await store.account({ name: "Globex" }))!.ids).toEqual({ crm: ["001-GLX", "001-GLX2"], jira_customer: ["Globex", "Globex Corp"] });
    await call("POST", "/api/account", { name: "Globex", ids: {} });
    expect((await call("GET", "/api/ids")).json).toEqual({ ids: { crm: ["001-INI"] } });
  });
});

describe("rules for every account", () => {
  const example = JSON.parse(readFileSync(new URL("../plugins/signals/deploy/signals.config.json", import.meta.url), "utf8")) as SignalsConfig;
  const record = (name: string, channel: string, domains: string[], aliases: string[] = []) => ({ name, channel, aliases, domains, ids: {}, preferences: "", profile: "", agents: [], playbooks: {}, workstream_agents: {}, updated_by: null, updated_at: null });
  const accounts = [record("Globex", "globex", ["globex.io"], ["Globex Corp"]), record("Initech", "initech", ["initech.com"])];
  const config = withAccounts(example, accounts);

  it("the example config is valid and names no account or domain", () => {
    expect(configProblems(example)).toEqual([]);
    const text = JSON.stringify(example.rules);
    expect(text).not.toMatch(/"account"|example\\\\\.com|<@U/);
    expect(example.accounts).toBeUndefined();
  });

  it("opens mail from any registered account's people in that account's channel", () => {
    expect(decide(config, { source: "gmail", external_id: "m1", actor: "Ann Lee <ann@globex.io>", title: "Pricing?", group_key: "t1" }, { firstRun: false })).toMatchObject({ kind: "task", rule: { id: "customer-mail" }, account: { name: "Globex" }, channel: "globex", title: "Reply: Pricing?" });
    expect(decide(config, { source: "gmail", external_id: "m2", actor: "bob@eu.initech.com", title: "Hi", group_key: "t2" }, { firstRun: false })).toMatchObject({ account: { name: "Initech" }, channel: "initech" });
    expect(decide(config, { source: "gmail", external_id: "m3", actor: "vendor@else.com", title: "Deal", group_key: "t3" }, { firstRun: false })).toMatchObject({ kind: "none" });
    expect(decide(config, { source: "gmail", external_id: "m4", actor: "noreply@globex.io", title: "Receipt" }, { firstRun: false })).toMatchObject({ kind: "none" });
  });

  it("finds a meeting's account by its real customers, not its organizer or colleagues' customer-domain addresses", () => {
    const meeting = (emails: string[]): EventInput => ({ source: "google_calendar", external_id: `c-${emails.join()}`, actor: "me@x.com", title: "Sync", payload: { attendees: emails.map((email, n) => ({ email, ...(n === 0 && { organizer: true }) })) } });
    expect(decide(config, meeting(["me@x.com", "ann@globex.io"]), { firstRun: false })).toMatchObject({ rule: { id: "customer-meetings" }, account: { name: "Globex" }, channel: "globex", title: "Prep: Sync" });
    // The most customers wins.
    expect(decide(config, meeting(["me@x.com", "ann@globex.io", "pat@initech.com", "lee@initech.com"]), { firstRun: false })).toMatchObject({ account: { name: "Initech" } });
    // dane.isburgh's Globex address is a colleague, not a customer.
    expect(decide(config, meeting(["dane.isburgh@x.com", "disburgh@globex.io", "me@x.com"]), { firstRun: false })).toMatchObject({ kind: "none" });
  });

  it("with known_account, opens nothing for an account no one set up", () => {
    const rules = [{ id: "tickets", action: "task" as const, sources: ["jira"], known_account: true }];
    const known = withAccounts({ version: 1, rules, default_channel: "fallback", accounts: [{ name: "Acme", ids: { jira_customer: ["Acme"] } }] }, accounts);
    const ticket = (account: string): EventInput => ({ source: "jira", external_id: `t-${account}`, title: "Help", account });
    expect(decide(known, ticket("Globex Corp"), { firstRun: false })).toMatchObject({ kind: "task", account: { name: "Globex" }, channel: "globex" });
    expect(decide(known, ticket("acme"), { firstRun: false })).toMatchObject({ kind: "task", account: { name: "Acme" }, channel: "fallback" });
    expect(decide(known, ticket("Acme Party Inc"), { firstRun: false })).toMatchObject({ kind: "none", reason: "no rule matches" });
    // Without it, the unknown name still opens a task in default_channel.
    expect(decide({ ...known, rules: [{ ...rules[0]!, known_account: false }] }, ticket("Acme Party Inc"), { firstRun: false })).toMatchObject({ kind: "task", account: { name: "Acme Party Inc" }, channel: "fallback" });
    expect(configProblems({ version: 1, rules: [{ ...rules[0]!, known_account: "yes" as unknown as boolean }] })).toEqual(["rules[0].known_account is true or false"]);
  });

  it("opens Slack mentions from a customer's address or in a channel named for the account, but not your own", () => {
    const slack = (payload: Record<string, unknown>, actor?: string): EventInput => ({ source: "slack", external_id: `s-${JSON.stringify(payload)}${actor}`, title: "<@U1|Me> can you look?", group_key: "1795000000", ...(actor && { actor }), payload });
    expect(decide(config, slack({ channel: "ext-globex-corp-team" }), { firstRun: false })).toMatchObject({ rule: { id: "customer-slack" }, account: { name: "Globex" }, channel: "globex" });
    expect(decide(config, slack({ channel: "general" }, "pat@initech.com"), { firstRun: false })).toMatchObject({ account: { name: "Initech" } });
    expect(decide(config, slack({ channel: "team-internal" }, "me@x.com"), { firstRun: false })).toMatchObject({ kind: "none" });
    // Whole words only: "globexx" isn't Globex.
    expect(decide(config, slack({ channel: "globexx-fans" }), { firstRun: false })).toMatchObject({ kind: "none" });
    // Your own message in the account's channel.
    expect(decide(config, slack({ channel: "ext-globex" }, "Me <me@x.com>"), { firstRun: false, owner: "me@x.com" })).toMatchObject({ kind: "none" });
    expect(decide(config, slack({ channel: "ext-globex" }, "Me <me@x.com>"), { firstRun: false, owner: "you@x.com" })).toMatchObject({ kind: "task" });
  });

  it("opens follow-ups for meeting notes whose title names an account", () => {
    expect(decide(config, { source: "google_drive", external_id: "d1", title: "Initech QBR - 2026/11/18 - Notes by Gemini", group_key: "d1" }, { firstRun: false })).toMatchObject({ rule: { id: "meeting-notes" }, account: { name: "Initech" }, title: "Follow up: Initech QBR - 2026/11/18 - Notes by Gemini" });
    expect(decide(config, { source: "google_drive", external_id: "d2", title: "Team standup - Notes by Gemini", group_key: "d2" }, { firstRun: false })).toMatchObject({ kind: "none" });
    expect(decide(config, { source: "google_drive", external_id: "d3", title: "Globex plan", group_key: "d3" }, { firstRun: false })).toMatchObject({ kind: "none" });
  });

  it("still takes patterns, a rule's account, and config accounts with domains", () => {
    const rules: SignalsConfig = {
      version: 1,
      accounts: [{ name: "Hooli", channel: "hooli", domains: ["hooli.xyz"] }],
      rules: [
        { id: "pinned", sources: ["gmail"], customer_actor: "@special\\.org$", account: "Globex", action: "task" },
        { id: "any", sources: ["gmail"], customer_actor: true, action: "task" },
      ],
    };
    const merged = withAccounts(rules, accounts);
    expect(decide(merged, { source: "gmail", external_id: "1", actor: "a@special.org" }, { firstRun: false })).toMatchObject({ rule: { id: "pinned" }, account: { name: "Globex" }, channel: "globex" });
    expect(decide(merged, { source: "gmail", external_id: "2", actor: "a@hooli.xyz" }, { firstRun: false })).toMatchObject({ rule: { id: "any" }, account: { name: "Hooli" }, channel: "hooli" });
    expect(configProblems({ version: 1, rules: [{ id: "a", action: "task", customer_actor: "(", account_named_in: "", skip_own: "yes" }] })).toEqual([
      "rules[0].customer_actor isn't a valid regular expression",
      "rules[0].account_named_in is a field, like payload.channel",
      "rules[0].skip_own is true or false",
    ]);
    expect(configProblems({ version: 1, rules: [], accounts: [{ name: "A", domains: ["not a domain"] }] })).toEqual(["accounts[0].domains is a list of email domains, like example.com"]);
  });

  it("an account set up in the panel opens and posts tasks with no rule changes, and warns when the hub can't post there", async () => {
    const store = new SignalsStore(pglite(), "signals_every");
    await store.setup();
    const posted: number[] = [];
    let member = false;
    const hub = new Hub(
      store,
      {
        opened: async (task) => {
          if (!member) throw new Error("not a member of the channel");
          posted.push(task.id);
          return `root-${task.id}`;
        },
        updated: async () => {},
        canPost: async () => (member ? null : "Signals App isn't a member of this channel."),
      },
      { defaultConfig: example },
    );
    const call = (method: string, path: string, body?: unknown, query = "") => hub.handle({ method, path, query: new URLSearchParams(query), user: "me@x.com", body: async () => (body === undefined ? "" : JSON.stringify(body)) });
    const saved = await call("POST", "/api/account", { name: "Globex", channel: "globex", domains: ["globex.io"] });
    expect(saved.json).toMatchObject({ account: { name: "Globex" }, warning: "Signals App isn't a member of this channel." });
    await call("POST", "/api/sources", { source: "gmail", enabled: true });
    await call("POST", "/api/events", { events: [{ source: "gmail", external_id: "seed" }] });
    await call("POST", "/api/events", { events: [{ source: "gmail", external_id: "m1", actor: "ann@globex.io", title: "Pricing?", group_key: "t1" }] });
    expect((await store.task(1))!).toMatchObject({ account: "Globex", channel: "globex", rule_id: "customer-mail" });
    expect(posted).toEqual([]);
    member = true;
    expect((await call("GET", "/api/account", undefined, "channel=globex")).json).not.toHaveProperty("warning");
    expect(await hub.sweep()).toMatchObject({ posted: 1 });
    expect(posted).toEqual([1]);
  });

  it("remembers a failed post when the notifier can't check membership", async () => {
    const store = new SignalsStore(pglite(), "signals_every_fail");
    await store.setup();
    let fail = true;
    const hub = new Hub(store, { opened: async (task) => { if (fail) throw new Error("403 not a member"); return `root-${task.id}`; }, updated: async () => {} }, { defaultConfig: example });
    const call = (method: string, path: string, body?: unknown, query = "") => hub.handle({ method, path, query: new URLSearchParams(query), user: "me@x.com", body: async () => (body === undefined ? "" : JSON.stringify(body)) });
    await call("POST", "/api/account", { name: "Globex", channel: "globex", domains: ["globex.io"] });
    await call("POST", "/api/sources", { source: "gmail", enabled: true });
    await call("POST", "/api/events", { events: [{ source: "gmail", external_id: "seed" }] });
    await call("POST", "/api/events", { events: [{ source: "gmail", external_id: "m1", actor: "ann@globex.io", title: "Q", group_key: "t1" }] });
    expect((await call("GET", "/api/account", undefined, "channel=globex")).json).toMatchObject({ warning: "Task 1 couldn't be posted here: 403 not a member" });
    // A failed post says more than the notifier's guess.
    const guessing = new Hub(store, { opened: async () => { throw new Error("403 not a member"); }, updated: async () => {}, canPost: async () => "probably not a member" }, { defaultConfig: example });
    expect((await guessing.handle({ method: "GET", path: "/api/account", query: new URLSearchParams("channel=globex"), user: "me@x.com", body: async () => "" })).json).toMatchObject({ warning: "probably not a member" });
    await guessing.sweep();
    expect((await guessing.handle({ method: "GET", path: "/api/account", query: new URLSearchParams("channel=globex"), user: "me@x.com", body: async () => "" })).json).toMatchObject({ warning: "Task 1 couldn't be posted here: 403 not a member" });
    fail = false;
    await hub.sweep();
    expect((await call("GET", "/api/account", undefined, "channel=globex")).json).not.toHaveProperty("warning");
    expect((await new Hub(store, undefined, { defaultConfig: example }).handle({ method: "GET", path: "/api/account", query: new URLSearchParams("channel=globex"), user: "me@x.com", body: async () => "" })).json).toMatchObject({ warning: expect.stringContaining("no Buzz identity") });
  });

  it("types the links in agent replies as assets", () => {
    expect(linkKind("https://docs.google.com/spreadsheets/d/x")).toBe("sheet");
    expect(linkKind("https://docs.google.com/presentation/d/x")).toBe("slides");
    expect(linkKind("https://docs.google.com/document/d/x")).toBe("doc");
    expect(linkKind("https://drive.google.com/file/d/x")).toBe("drive");
    expect(linkKind("https://github.com/o/r/issues/3")).toBe("issue");
    expect(linkKind("https://github.com/o/r/blob/main/a.ts")).toBe("code");
    expect(linkKind("https://signals-1.aws.databricksapps.com/")).toBe("app");
    expect(linkKind("https://x.cloud.databricks.com/dashboardsv3/1")).toBe("dashboard");
    expect(linkKind("https://x.cloud.databricks.com/editor/notebooks/1")).toBe("notebook");
    expect(linkKind("https://x.cloud.databricks.com/")).toBe("workspace");
    expect(linkKind("https://acme.slack.com/archives/C1/p1")).toBe("slack");
    expect(linkKind("https://example.com/a")).toBe("link");
    expect(linkKind("not a url")).toBe("link");
    expect(replyLinks("See [the doc](https://docs.google.com/document/d/a), https://github.com/o/r/pull/1. Again https://docs.google.com/document/d/a and <https://example.com/x>")).toEqual([
      { url: "https://docs.google.com/document/d/a", kind: "doc", title: "the doc" },
      { url: "https://github.com/o/r/pull/1", kind: "pr" },
      { url: "https://example.com/x", kind: "link" },
    ]);
  });

  describe("board view", () => {
    const agent = "ab".repeat(32);
    const scout = "ef".repeat(32);
    const item = (id: number, over: Record<string, unknown> = {}, people: unknown[] = [], artifacts: unknown[] = []) =>
      ({ task: { id, title: `Task ${id}`, status: "open", mode: "draft", workstream: "meeting prep", initiative: null, last_event_at: id, question: null, ...over }, people, artifacts, source: { source: "gmail", title: "Pricing question", occurred_at: 0 } }) as never;
    const tasks = [
      item(1, { status: "waiting", question: "Which SKU?" }, [{ kind: "agent", key: agent, label: "Genie", role: "replied" }]),
      item(2, { status: "in_progress" }, [{ kind: "agent", key: scout, label: "Scout", role: "asked" }, { kind: "agent", key: agent, label: "Genie", role: "replied" }, { kind: "customer", key: "ann@globex.io", label: "Ann", role: "wrote" }]),
      item(3, { mode: "auto", workstream: null }, [{ kind: "customer", key: "ann@globex.io", label: "Ann", role: "wrote" }]),
      item(4, { status: "done", question: "Old?" }, [{ kind: "agent", key: scout, label: "Scout", role: "asked" }], [
        { at: 1, actor: "a", kind: "reply", url: "buzz://message?channel=c&id=r" },
        { at: 2, actor: "a", kind: "doc", url: "https://docs.google.com/document/d/x", title: "Plan" },
        { at: 3, actor: "a", kind: "workspace", url: "https://x.cloud.databricks.com/genie" },
      ]),
    ];

    it("shows one assignee: you when it needs input, else the agent that replied, else the one asked, else no one", () => {
      expect(tasks.map(assigneeOf)).toEqual([{ kind: "you" }, { kind: "agent", key: agent, label: "Genie" }, { kind: "unassigned" }, { kind: "agent", key: scout, label: "Scout" }]);
    });

    it("shows its first owner over the agents asked, lists who can be taken off, and offers the channel's other members", () => {
      const people = [
        { kind: "agent", key: agent, label: "Genie", role: "replied", on: true },
        { kind: "person", key: "bo@x.com", label: "bo@x.com", role: "owner", on: true },
        { kind: "agent", key: scout, label: "Scout", role: "owner", on: true },
        { kind: "customer", key: "ann@globex.io", label: "Ann", role: "wrote" },
      ];
      const owned = item(5, { status: "in_progress" }, people);
      expect(assigneeOf(owned)).toEqual({ kind: "person", key: "bo@x.com", label: "bo@x.com" });
      expect(ownersOf(owned).map((person) => person.key)).toEqual(["bo@x.com", scout]);
      expect(removable(owned).map((person) => person.key)).toEqual([agent, "bo@x.com", scout]);
      // A question still puts it with you.
      expect(assigneeOf(item(6, { status: "waiting", question: "?" }, people))).toEqual({ kind: "you" });
      const me = "77".repeat(32);
      const names: Record<string, { name?: string; agent?: boolean }> = { [agent]: { name: "Genie", agent: true }, [me]: { name: "Alice" }, ["88".repeat(32)]: { name: "Zed" } };
      expect(memberChoices([me, "88".repeat(32), scout, agent], [agent], [scout], (key) => names[key], me)).toEqual([
        { key: agent, name: "Genie", agent: true },
        { key: me, name: "Alice (you)", agent: false },
        { key: "88".repeat(32), name: "Zed", agent: false },
      ]);
    });

    it("filters by status, workstream, assignee, mode and words, and counts each choice", () => {
      const ids = (filters: object) => filterTasks(tasks, filters).map((found) => found.task.id);
      expect(ids({})).toEqual([1, 2, 3, 4]);
      expect(ids({ status: "open" })).toEqual([3]);
      expect(ids({ workstream: "(none)" })).toEqual([3]);
      expect(ids({ workstream: "meeting prep", mode: "draft" })).toEqual([1, 2, 4]);
      expect(ids({ assignee: "you" })).toEqual([1]);
      expect(ids({ assignee: `agent:${scout}` })).toEqual([4]);
      expect(ids({ search: "#2" })).toEqual([2]);
      expect(ids({ search: "PRICING task 3" })).toEqual([3]);
      const options = filterOptions(tasks);
      expect(options.workstreams).toEqual([{ value: "meeting prep", count: 3 }, { value: "(none)", count: 1 }]);
      expect(options.modes).toEqual([{ value: "auto", count: 1 }, { value: "draft", count: 3 }]);
      expect(options.assignees.map((option) => [option.value, option.count])).toEqual([["you", 1], [`agent:${agent}`, 1], [`agent:${scout}`, 1], ["unassigned", 1]]);
      expect([...byStatus(tasks).entries()].map(([status, list]) => [status, list.length])).toEqual([["waiting", 1], ["open", 1], ["in_progress", 1], ["done", 1], ["dismissed", 0]]);
    });

    it("leaves the reply record and workspace links off cards, and reads a saved view", () => {
      expect(cardAssets(tasks[3]!).map((artifact) => artifact.kind)).toEqual(["doc"]);
      expect(readView("swimlanes")).toBe("swimlanes");
      expect(readView("grid")).toBe("list");
      expect(readView(null)).toBe("list");
    });

    it("shows the thread as comments, and a reply mentions the agent the task is with", () => {
      const comments = threadComments([
        { id: "b", authorId: agent, createdAt: 3, content: "Draft ready", delivery: "delivered" },
        { id: "a", authorId: "hub", createdAt: 1, content: "📋 Task #1" },
        { id: "c", authorId: scout, createdAt: 4, content: "note", audience: "agents" },
        { id: "d", authorId: "me", createdAt: 5, content: "  " },
        { id: "e", authorId: "me", createdAt: 6, content: "Thanks", delivery: "sending" },
        { id: "f", authorId: "me", createdAt: 7, content: "Sent", delivery: "accepted" },
        { id: "g", authorId: "me", createdAt: 8, content: "Seen", delivery: "seen" },
        { id: "h", authorId: "me", createdAt: 9, content: "Lost", delivery: "failed" },
      ]);
      // Only "sending" is pending: the relay never says "delivered", so a sent reply mustn't stay "sending".
      expect(comments.map((comment) => [comment.id, comment.agents, comment.pending, comment.failed])).toEqual([["a", false, false, false], ["b", false, false, false], ["c", true, false, false], ["e", false, true, false], ["f", false, false, false], ["g", false, false, false], ["h", false, false, true]]);
      expect(replyMentions(assigneeOf(tasks[1]!))).toEqual([agent]);
      expect(replyMentions(assigneeOf(tasks[0]!))).toEqual([]);
      expect(replyMentions(assigneeOf(tasks[2]!))).toEqual([]);
      expect(replyText("  go on ", [{ npub: "npub1x" }])).toBe("nostr:npub1x go on");
      const npub = npubEncode(agent);
      const keyOf = (value: string) => (value === npub ? agent : undefined);
      expect(mentionedKeys(`nostr:${npub} and nostr:${npub} again`, keyOf)).toEqual([agent]);
      expect(withMentionNames(`nostr:${npub} draft is ready`, keyOf, () => "Genie")).toBe("**@Genie** draft is ready");
      expect(withMentionNames(`nostr:${npub} hi`, keyOf, () => undefined)).toBe(`**@${npub.slice(0, 12)}…** hi`);
      expect(replyText("go on", [])).toBe("go on");
    });

    it("lists a task's details, in the viewer's time with UTC on hover, and a meeting ahead as when it starts", () => {
      const facts = taskFacts(item(9, { account: "Globex", created_at: 1_700_000_000, last_event_at: 1_700_003_600, event_count: 3, initiative: "Q4" }), 1_700_010_000);
      expect(facts.map((fact) => fact.label)).toEqual(["Mode", "Workstream", "Initiative", "Account", "Opened", "Last event"]);
      expect(facts[0]).toEqual({ label: "Mode", value: "Draft", title: "Agents prepare it, a person sends it" });
      expect(facts[4]!.title).toBe("2023-11-14 22:13 UTC");
      expect(facts[5]!.title).toBe("2023-11-14 23:13 UTC");
      expect(facts[5]!.value).toMatch(/ · 3 events$/);
      const ahead = taskFacts(item(9, { created_at: 1_700_000_000, last_event_at: 1_700_090_000, event_count: 3 }), 1_700_010_000);
      expect(ahead.at(-1)).toMatchObject({ label: "Starts", title: "2023-11-15 23:13 UTC" });
      expect(ahead.at(-1)!.value).not.toMatch(/events/);
    });

    it("reads a task's thread as activity: the hub's posts as lines, notes for agents as lines, long runs folded", () => {
      const hub = "hub";
      const post = "📌 **Task 9: Pricing question**\nAccount: Globex · Workstream: questions\nMode: draft (agents prepare it; a person sends it)\n\n**Source** (gmail): https://mail/x\nFrom: Ann <ann@globex.io>\n\nReply in this thread to work on it.";
      const comment = (id: string, author: string, text: string, agents = false) => ({ id, author, at: id.charCodeAt(0), text, agents, pending: false, failed: false });
      const thread = [
        comment("a", hub, post),
        comment("b", agent, "Draft ready"),
        comment("c", hub, "alice@x.com set this to **in_progress**"),
        comment("d", agent, "Update: [the doc](https://x)"),
        comment("e", scout, "checking", true),
        comment("f", hub, "👤 alice@x.com assigned this to nostr:npub1x."),
        comment("g", hub, "Update: [Pricing](https://mail/x)"),
        comment("h", hub, "✅ Done: replied. (Set its status on the Tasks board if it isn't.)"),
        comment("i", hub, "an unknown hub post"),
      ];
      const entries = taskActivity(thread);
      expect(entries.map((entry) => (entry.kind === "lines" ? `lines:${entry.lines.map((line) => line.comment.id).join("")}` : `${entry.kind}:${entry.comment.id}`))).toEqual([
        "opened:a",
        "comment:b",
        "event:c",
        // An agent's own "Update:" stays a comment: only the hub's posts are lines.
        "comment:d",
        // Four lines in a row fold into one entry.
        "lines:efgh",
        "comment:i",
      ]);
      const opened = entries[0]!;
      expect(opened.kind === "opened" && opened.post.source?.from).toBe("Ann");
      // Without a task post first, nothing is read as the hub's.
      expect(taskActivity(thread.slice(1)).every((entry) => entry.kind !== "event" && entry.kind !== "opened")).toBe(true);
      expect(taskActivity([])).toEqual([]);
    });
  });
});

describe("classify", () => {
  const rules: SignalsConfig = {
    ...config,
    rules: [{ id: "customer-mail", sources: ["gmail"], when: { actor: "@acme\\.com$" }, classify: { question: "Does it ask for something?", true: "asks", false: "FYI", min: 0.7 }, action: "task", group_by: "group_key" }],
  };

  it("checks classify in the config", () => {
    expect(configProblems(rules)).toEqual([]);
    const bad = (classify: unknown, action = "task") => configProblems({ version: 1, rules: [{ id: "r", action, classify } as never] });
    expect(bad({})).toEqual(["rules[0].classify is {question, true?, false?, min?}"]);
    expect(bad({ question: "Q?", true: "yes" })).toEqual(["rules[0].classify.true and .false go together, as text"]);
    expect(bad({ question: "Q?", min: 1.5 })).toEqual(["rules[0].classify.min is a number between 0 and 1"]);
    expect(bad({ question: "Q?" }, "ignore")).toEqual(["rules[0].classify needs action task"]);
  });

  it("sends the model only what it needs, and reads its score", () => {
    expect(classifyState({ source: "gmail", external_id: "1", title: "Pricing?", actor: "Sam <sam@acme.com>", payload: { to: ["me@x.com"], snippet: "Could you   send\nthe quote?", labelIds: ["INBOX"] } })).toEqual({ source: "gmail", title: "Pricing?", from: "Sam <sam@acme.com>", to: '["me@x.com"]', snippet: "Could you send the quote?" });
    expect(classifyQuestions({ question: "Q?", true: "a", false: "b" })).toEqual({ classify: { type: "noul", instructions: "Q?", criteria: { true: "a", false: "b" } } });
    expect(classifyQuestions({ question: "Q?" })).toEqual({ classify: { type: "noul", instructions: "Q?" } });
    expect(answerScore({ answers: { classify: { noul: 0.42 } } })).toBe(0.42);
    expect(answerScore({ answers: { classify: { noul: 3 } } })).toBeUndefined();
    expect(answerScore({ error: "x" })).toBeUndefined();
  });

  it("calls the serving endpoint, and fails open", async () => {
    const calls: { path: string; body: unknown }[] = [];
    const ok = jevClassifier(async (path, init) => (calls.push({ path, body: init.body }), { answers: { classify: { noul: 0.9 } } }));
    expect(await ok({ source: "gmail", external_id: "1", title: "Hi" }, { question: "Q?" })).toBe(0.9);
    expect(calls[0]).toMatchObject({ path: "/serving-endpoints/databricks-openjev-qwen35-4b/invocations", body: { state: { source: "gmail", title: "Hi" }, questions: { classify: { instructions: "Q?" } } } });
    const lines: string[] = [];
    const down = jevClassifier(async () => Promise.reject(new Error("HTTP 503")), "my-ep", (line) => lines.push(line));
    expect(await down({ source: "gmail", external_id: "2" }, { question: "Q?" })).toBeUndefined();
    expect(lines).toEqual(["classifier my-ep failed for gmail 2: HTTP 503"]);
  });

  it("opens tasks the model passes, records the ones it doesn't, and opens when it can't tell", async () => {
    const scores: Record<string, number | undefined> = { m1: 0.95, m2: 0.1, m4: 0.05 };
    const asked: string[] = [];
    const store = new SignalsStore(pglite(), "signals_classify");
    await store.setup();
    const hub = new Hub(store, undefined, { defaultConfig: rules, classifier: async (event) => (asked.push(event.external_id), event.external_id === "m3" ? Promise.reject(new Error("down")) : scores[event.external_id]) });
    const call = (method: string, path: string, body?: unknown, query = "") => hub.handle({ method, path, query: new URLSearchParams(query), user: "alice@x.com", body: async () => (body === undefined ? "" : JSON.stringify(body)) });
    await call("POST", "/api/sources", { source: "gmail", enabled: true });
    await call("POST", "/api/events", { events: [{ source: "gmail", external_id: "seed" }] });
    const mail = (id: string, thread: string, title: string) => ({ source: "gmail", external_id: id, actor: "sam@acme.com", title, group_key: thread });
    const reply = await call("POST", "/api/events", { events: [mail("m1", "t1", "Can you help?"), mail("m2", "t2", "Accepted: sync"), mail("m3", "t3", "Question")] });
    expect(reply.json).toMatchObject({ new: 3, filtered: 1, created: [1, 2] });
    // A later mail in a thread with a task isn't asked: it updates the task.
    const later = await call("POST", "/api/events", { events: [mail("m4", "t1", "Re: Can you help?")] });
    expect(later.json).toMatchObject({ filtered: 0, updated: [1] });
    expect(asked).toEqual(["m1", "m2", "m3"]);
    const filtered = (await call("GET", "/api/filtered")).json as { events: { external_id: string; rule: string; score: number; title?: string }[] };
    expect(filtered.events).toEqual([expect.objectContaining({ external_id: "m2", rule: "customer-mail", title: "Accepted: sync" })]);
    expect(filtered.events[0]!.score).toBeCloseTo(0.1);
    expect(((await call("GET", "/api/filtered", undefined, "rule=other")).json as { events: unknown[] }).events).toEqual([]);
    // Each says why: the channel its task would have gone to, its rule's question and the score it needed.
    expect(filtered.events[0]).toMatchObject({ channel: "acme", question: "Does it ask for something?", min: 0.7 });
    expect(((await call("GET", "/api/filtered", undefined, "channel=acme")).json as { events: unknown[] }).events).toHaveLength(1);
    expect(((await call("GET", "/api/filtered", undefined, "channel=triage")).json as { events: unknown[] }).events).toEqual([]);
    expect(HUB_PATHS).toContain("/api/filtered");
  });

  it("the board's Filtered view says why each event was held back, and searches them", () => {
    const event = { id: 1, owner: "a@x.com", source: "gmail", external_id: "m2", title: "Your lunch receipt", actor: "Cafe <receipts@cafe.com>", occurred_at: 1, rule: "customer-mail", score: 0.378, filtered_at: 2, question: "Is the sender asking?", min: 0.7 };
    expect(filteredWhy(event)).toBe("customer-mail: scored 38%, needed 70% on “Is the sender asking?”");
    expect(filteredWhy({ ...event, question: undefined, min: undefined } as never)).toBe("customer-mail: scored 38%");
    expect(filterFiltered([event], "LUNCH cafe")).toHaveLength(1);
    expect(filterFiltered([event], "quota")).toEqual([]);
    expect(filterFiltered([event], undefined)).toHaveLength(1);
    expect(readView("filtered")).toBe("filtered");
  });

  it("the example config classifies customer mail", () => {
    const example = JSON.parse(readFileSync(new URL("../plugins/signals/hub/signals.config.json", import.meta.url), "utf8")) as SignalsConfig;
    expect(example.rules.find((rule) => rule.id === "customer-mail")?.classify?.question).toMatch(/asking/);
    expect(readFileSync(new URL("../plugins/signals/deploy/signals.config.json", import.meta.url), "utf8")).toBe(readFileSync(new URL("../plugins/signals/hub/signals.config.json", import.meta.url), "utf8"));
  });
});

describe("watched fields", () => {
  it("lists what a watched field changed to, moves the task to the rule that now applies, and asks its agents to go on", async () => {
    const store = new SignalsStore(pglite(), "signals_watch");
    await store.setup();
    const replies: { task: number; text: string; agents: readonly string[] }[] = [];
    const watch = ["payload.es_status"];
    const rules = [
      { id: "case-es-resolved", sources: ["table.cases"], when: { "payload.es_status": ["Resolved"] }, action: "task" as const, group: "case", group_by: "external_id", workstream: "cases", watch },
      { id: "case-es-open", sources: ["table.cases"], when: { "payload.es_status": "." }, action: "task" as const, group: "case", group_by: "external_id", workstream: "cases", watch },
      { id: "case-confirm", sources: ["table.cases"], action: "task" as const, group: "case", group_by: "external_id", workstream: "cases", watch },
    ];
    expect(configProblems({ version: 1, rules })).toEqual([]);
    expect(configProblems({ version: 1, rules: [{ ...rules[0]!, watch: [] }] })).toEqual([expect.stringMatching(/watch is a list/)]);
    const hub = new Hub(
      store,
      { opened: async (task) => "f".repeat(63) + task.id, updated: async (task, text, agents = []) => void replies.push({ task: task.id, text, agents }) },
      { defaultConfig: { version: 1, rules } },
    );
    const call = (path: string, body: unknown) => hub.handle({ method: "POST", path, query: new URLSearchParams(), user: "alice@x.com", body: async () => JSON.stringify(body) });
    const genie = "ab".repeat(32);
    await call("/api/account", { name: "Globex", channel: "globex", agents: [genie], preferences: "cases: draft", playbooks: { "case-es-resolved": "Draft confirm-or-close." } });
    await call("/api/sources", { source: "table.cases", enabled: true });
    await call("/api/events", { events: [{ source: "table.cases", external_id: "seed" }] });
    const kase = (es_status: string | undefined, title = "Case C-1") => ({ source: "table.cases", external_id: "C-1", account: "Globex", title, payload: { case: "C-1", ...(es_status && { es_status }) } });
    await call("/api/events", { events: [kase("Mitigated")] });
    expect(await store.task(1)).toMatchObject({ rule_id: "case-es-open", channel: "globex" });

    // The ticket is resolved: the thread says so, and the agent is asked again with the Resolved rule's playbook.
    await call("/api/events", { events: [kase("Resolved")] });
    expect(await store.task(1)).toMatchObject({ rule_id: "case-es-resolved", event_count: 2 });
    expect(replies.at(-1)).toMatchObject({ task: 1, agents: [genie] });
    expect(replies.at(-1)!.text).toContain("- **es_status:** Mitigated → Resolved");
    expect(replies.at(-1)!.text).toContain(`nostr:${npubEncode(genie)} this changed since you last looked`);
    expect(replies.at(-1)!.text).toContain("Playbook for case-es-resolved");
    expect((await store.detail(1))!.activities.map((a) => a.kind)).toContain("changed");

    // A change to a field nobody watches is the usual update line, mentioning no one.
    await call("/api/events", { events: [kase("Resolved", "Case C-1 (renamed)")] });
    expect(replies.at(-1)).toEqual({ task: 1, text: "Update: Case C-1 (renamed)", agents: [] });

    // The ticket unlinked: (none), back under the no-ticket rule.
    await call("/api/events", { events: [kase(undefined)] });
    expect(replies.at(-1)!.text).toContain("- **es_status:** Resolved → (none)");
    expect(await store.task(1)).toMatchObject({ rule_id: "case-confirm" });
  });
});

describe("watched fields, rule outgrown", () => {
  it("leaves out the old rule's playbook when it no longer applies and no other rule of the group does", async () => {
    const store = new SignalsStore(pglite(), "signals_outgrown");
    await store.setup();
    const replies: { task: number; text: string; agents: readonly string[] }[] = [];
    const watch = ["payload.es_status"];
    const awaiting = { "payload.status": ["Awaiting Confirmation"] };
    const rules = [
      { id: "case-es-open", sources: ["table.cases"], when: { ...awaiting, "payload.es_status": "." }, action: "task" as const, group: "case", group_by: "external_id", workstream: "cases", watch },
      { id: "case-confirm", sources: ["table.cases"], when: awaiting, action: "task" as const, group: "case", group_by: "external_id", workstream: "cases", watch },
      { id: "case-updates", sources: ["table.cases"], action: "update" as const, group: "case", group_by: "external_id" },
    ];
    const hub = new Hub(
      store,
      { opened: async (task) => "f".repeat(63) + task.id, updated: async (task, text, agents = []) => void replies.push({ task: task.id, text, agents }) },
      { defaultConfig: { version: 1, rules } },
    );
    const call = (path: string, body: unknown) => hub.handle({ method: "POST", path, query: new URLSearchParams(), user: "alice@x.com", body: async () => JSON.stringify(body) });
    const genie = "ab".repeat(32);
    await call("/api/account", { name: "Globex", channel: "globex", agents: [genie], preferences: "cases: draft", playbooks: { "case-confirm": "Ask, quoting the solution.", cases: "Work the case." } });
    await call("/api/sources", { source: "table.cases", enabled: true });
    await call("/api/events", { events: [{ source: "table.cases", external_id: "seed" }] });
    const kase = (status: string, es_status?: string) => ({ source: "table.cases", external_id: "C-1", account: "Globex", title: "Case C-1", payload: { status, ...(es_status && { es_status }) } });
    await call("/api/events", { events: [kase("Awaiting Confirmation")] });
    expect(await store.task(1)).toMatchObject({ rule_id: "case-confirm" });

    // Back to Open with a ticket: only the update rule matches, so the task stays on case-confirm, whose playbook is wrong now.
    await call("/api/events", { events: [kase("Open", "Mitigated")] });
    expect(await store.task(1)).toMatchObject({ rule_id: "case-confirm" });
    const text = replies.at(-1)!.text;
    expect(replies.at(-1)!.agents).toEqual([genie]);
    expect(text).toContain("- **es_status:** (none) → Mitigated");
    expect(text).toContain("The rule this task is under (case-confirm) no longer applies");
    expect(text).toContain("Now: es_status Mitigated");
    expect(text).not.toContain("Ask, quoting the solution.");
    expect(text).toContain("Playbook for cases");
    expect(text).toContain("status: Open");

    // Awaiting again with the ticket: case-es-open takes it over, with no outgrown line.
    await call("/api/events", { events: [kase("Awaiting Confirmation", "Resolved")] });
    expect(await store.task(1)).toMatchObject({ rule_id: "case-es-open" });
    expect(replies.at(-1)!.text).not.toContain("no longer applies");
  });
});
