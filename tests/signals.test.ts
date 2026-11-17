// Signals: events → dedupe → rules → tasks, on a real Postgres (PGlite).
import { PGlite } from "@electric-sql/pglite";
import { beforeEach, describe, expect, it } from "vitest";
import { configProblems, decide, type SignalsConfig, validateEvent } from "../plugins/signals/app/model";
import { Hub } from "../plugins/signals/app/hub";
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

describe("the plugin's sign-in check", () => {
  it("reads not signed in from a JSON-RPC error with HTTP 200, not only from a 401", () => {
    expect(rpcSignIn(200, JSON.stringify({ jsonrpc: "2.0", id: 2, error: { code: -32006, message: "Request rejected (HTTP 401)" } }))).toBe("needed");
    expect(rpcSignIn(200, `event: message\ndata: ${JSON.stringify({ jsonrpc: "2.0", id: 2, result: { tools: [] } })}\n\n`)).toBe("signed-in");
    expect(rpcSignIn(401, "")).toBe("needed");
    expect(rpcSignIn(200, JSON.stringify({ jsonrpc: "2.0", id: 2, error: { code: -32003, message: "Tool not allowed" } }))).toBe("unknown");
    expect(rpcSignIn(500, "oops")).toBe("unknown");
  });
});
