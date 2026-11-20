// Signals: a rule's `categories` file its tasks under finer workstreams (a matching `when`, else the model's pick), from synthetic events.
import { PGlite } from "@electric-sql/pglite";
import { describe, expect, it } from "vitest";
import { answerChoice, jevCategorizer } from "../plugins/signals/app/classify";
import { Hub } from "../plugins/signals/app/hub";
import { categoryByWhen, categoryChoices, categoryModeFor, configProblems, decide, NO_CATEGORY, type Rule, type SignalsConfig, workstreamsOf } from "../plugins/signals/app/model";
import { type Categorizer, SignalsStore } from "../plugins/signals/app/store";

const ESCALATIONS: Rule = {
  id: "escalations", sources: ["jira"], action: "task", group_by: "external_id", workstream: "escalation tracking",
  categories: [
    { workstream: "capacity request", when: { title: "increase (RPM|TPM|rate limit)|quota increase" }, about: "Asks to raise a rate limit, quota or capacity for a model or workspace" },
    { workstream: "incident", when: { "payload.priority": ["Sev0", "Sev1"] } },
    { workstream: "feature request", about: "Asks for a feature or product change that doesn't exist yet" },
  ],
};
const CONFIG: SignalsConfig = { version: 1, first_run_seen: true, accounts: [{ name: "Acme", channel: "acme", aliases: ["ACME"], preferences: "capacity request: auto\nfeature request: off\nescalation tracking: ask" }], rules: [ESCALATIONS] };
const ticket = (id: string, title: string, payload: Record<string, unknown> = {}) => ({ source: "jira", external_id: id, title, account: "Acme", payload });

describe("rule categories", () => {
  it("validates categories", () => {
    expect(configProblems(CONFIG)).toEqual([]);
    const bad = (categories: unknown, extra: Record<string, unknown> = {}) => configProblems({ ...CONFIG, rules: [{ ...ESCALATIONS, ...extra, categories } as never] });
    expect(bad([])).toEqual([expect.stringMatching(/categories is a list of 1 to 20/)]);
    expect(bad([{ workstream: "x" }])).toEqual([expect.stringMatching(/needs a when or an about/)]);
    expect(bad([{ workstream: "a", about: "A" }, { workstream: "A", about: "B" }])).toEqual([expect.stringMatching(/used twice/)]);
    expect(bad([{ workstream: NO_CATEGORY, about: "x" }])).toEqual([expect.stringMatching(/can't be/)]);
    expect(bad([{ workstream: "a", when: { title: "(" } }])).toEqual([expect.stringMatching(/valid regular expression/)]);
    expect(bad([{ workstream: "a", when: {} }])).toEqual([expect.stringMatching(/when is an object of conditions/)]);
    expect(bad([{ workstream: "a", about: "x", color: "red" }])).toEqual([expect.stringMatching(/is \{workstream, when\?, about\?, title\?\}/)]);
    expect(bad([{ workstream: "a", about: "x" }], { action: "update", group: "g" })).toContainEqual(expect.stringMatching(/categories needs action task/));
    expect(bad([{ workstream: "a", about: "x" }], { fan_out: "accounts", group_by: undefined })).toContainEqual(expect.stringMatching(/fan_out .* takes no categories/));
  });

  it("files by the first matching when, with the team's mode for that workstream", () => {
    const decision = (title: string, payload = {}) => decide(CONFIG, ticket("1", title, payload), { firstRun: false });
    expect(decision("ES-1 increase RPM/TPM rate limit for Gemini 4 Neon")).toMatchObject({ workstream: "capacity request", category: true, mode: "auto" });
    expect(decision("ES-2 jobs failing", { priority: "Sev1" })).toMatchObject({ workstream: "incident", category: true, mode: "ask" });
    const plain = decision("ES-3 question about billing");
    expect(plain).toMatchObject({ workstream: "escalation tracking", mode: "ask" });
    expect(plain).not.toHaveProperty("category");
    // The rule's id still wins over a category's workstream, as it does over the rule's own.
    expect(categoryModeFor("escalations: draft\ncapacity request: auto", ESCALATIONS, "capacity request")).toBe("draft");
    expect(categoryModeFor("everything: off", ESCALATIONS, "incident")).toBe("off");
    expect(categoryByWhen({ categories: undefined }, ticket("1", "x"))).toBeUndefined();
    // Every category is a workstream a team can write a playbook or agents for.
    expect(workstreamsOf(CONFIG)).toEqual(["escalation tracking", "capacity request", "incident", "feature request"]);
    expect(categoryChoices(ESCALATIONS)).toEqual({ "capacity request": expect.any(String), "feature request": expect.any(String), [NO_CATEGORY]: "None of these fits (it stays escalation tracking)" });
    expect(categoryChoices({ categories: [{ workstream: "incident", when: { title: "x" } }] })).toBeUndefined();
  });

  it("asks the model only when no when matched, and keeps the rule's workstream when it can't tell", async () => {
    const asked: string[] = [];
    const picks: Record<string, string | undefined> = { t2: "capacity request", t3: "Feature Request", t4: NO_CATEGORY, t5: "made up" };
    const store = new SignalsStore(pglite(), "signals_categories");
    store.categorizer = (async (event, choices) => {
      asked.push(event.external_id);
      expect(Object.keys(choices)).toEqual(["capacity request", "feature request", NO_CATEGORY]);
      if (event.external_id === "t6") throw new Error("down");
      return picks[event.external_id];
    }) satisfies Categorizer;
    await store.setup();
    const hub = new Hub(store, undefined, { defaultConfig: CONFIG });
    const call = (path: string, body: unknown) => hub.handle({ method: "POST", path, query: new URLSearchParams(), user: "alice@x.com", body: async () => JSON.stringify(body) });
    await call("/api/sources", { source: "jira", enabled: true });
    await call("/api/events", { events: [{ source: "jira", external_id: "seed" }] });
    await call("/api/events", { events: [
      ticket("t1", "Please increase TPM for our endpoint"),
      ticket("t2", "Need more throughput on Gemini Carbon"),
      ticket("t3", "Can we get a dark mode?"),
      ticket("t4", "Question about billing"),
      ticket("t5", "Something odd"),
      ticket("t6", "Model is down?"),
    ] });
    const tasks = Object.fromEntries((await store.tasks({})).map((task) => [task.group_key.split("|").pop(), task]));
    // t1's when matched: not asked. t3's pick is a category the team turned off: no task.
    expect(asked).toEqual(["t2", "t3", "t4", "t5", "t6"]);
    expect(tasks.t1).toMatchObject({ workstream: "capacity request", mode: "auto" });
    expect(tasks.t2).toMatchObject({ workstream: "capacity request", mode: "auto" });
    expect(tasks.t3).toBeUndefined();
    for (const id of ["t4", "t5", "t6"]) expect(tasks[id]).toMatchObject({ workstream: "escalation tracking", mode: "ask" });
    // A later event on a task doesn't ask again or move it.
    await call("/api/events", { events: [{ ...ticket("t2", "Need more throughput on Gemini Carbon (updated)") }] });
    expect(asked).toHaveLength(5);
    expect((await store.tasks({})).find((task) => task.group_key.endsWith("t2"))).toMatchObject({ workstream: "capacity request" });
  });

  // The store on its own, with Acme's preferences and these rules, and the seed post that ends jira's first run.
  // `hold` runs before each statement: one it returns a promise for waits on it, as a slow connection would.
  const prepare = async (preferences: string, rules: readonly Rule[] = [ESCALATIONS], hold?: (sql: string, values?: unknown[]) => Promise<void> | undefined) => {
    const db = pglite();
    const store = new SignalsStore({ query: async (sql, values) => (await hold?.(sql, values), db.query(sql, values)) }, "signals_categories");
    await store.setup();
    await store.setSource("alice@x.com", "jira", true);
    const config = (preferences: string): SignalsConfig => ({ ...CONFIG, accounts: [{ name: "Acme", channel: "acme", preferences }], rules });
    let current = config(preferences);
    const post = (...events: ReturnType<typeof ticket>[]) => store.ingest("alice@x.com", events, current);
    await post(ticket("seed", "seed"));
    /** The team changes its preferences. */
    const prefer = (text: string) => void (current = config(text));
    return { store, post, prefer, sql: (text: string) => db.query(text) };
  };

  it("opens a category the team kept on when the rule's own workstream is off, but not the fallback", async () => {
    const { store, post } = await prepare("escalation tracking: off\ncapacity request: draft");
    const asked: string[] = [];
    store.categorizer = async (event) => (asked.push(event.external_id), event.external_id === "model" ? "capacity request" : NO_CATEGORY);
    await post(ticket("pattern", "Please increase TPM for our endpoint"), ticket("model", "Need more throughput for our endpoint"), ticket("fallback", "Question about billing"));
    expect(asked).toEqual(["model", "fallback"]);
    const opened = (await store.tasks({})).map((task) => ({ key: task.group_key, workstream: task.workstream, mode: task.mode }));
    expect(opened.sort((a, b) => a.key.localeCompare(b.key))).toEqual([
      { key: "escalations|model", workstream: "capacity request", mode: "draft" },
      { key: "escalations|pattern", workstream: "capacity request", mode: "draft" },
    ]);
    // A mode on the rule's id still turns all of its work off: the model isn't asked.
    const off = await prepare("escalations: off\ncapacity request: draft");
    off.store.categorizer = async () => { throw new Error("not asked"); };
    expect((await off.post(ticket("pattern2", "Please increase TPM"), ticket("model2", "Need more throughput"))).created).toEqual([]);
  });

  it("opens nothing from a category picked for an event version a newer one replaced", async () => {
    const { store, post } = await prepare("escalation tracking: ask\ncapacity request: auto\nfeature request: off");
    let entered!: () => void;
    let release!: () => void;
    const atOld = new Promise<void>((resolve) => (entered = resolve));
    const gate = new Promise<void>((resolve) => (release = resolve));
    store.categorizer = async (event) => {
      if (event.title !== "Old notes") return "feature request";
      entered();
      await gate;
      return "capacity request";
    };
    const earlier = post(ticket("same", "Old notes"));
    await atOld;
    // The newer version picks a category the team turned off: no task, and the older one's late pick doesn't open one either.
    expect((await post(ticket("same", "New notes"))).created).toEqual([]);
    release();
    expect((await earlier).created).toEqual([]);
    expect(await store.tasks({})).toEqual([]);
  });

  it("moves a task off a category the rule it's refiled to doesn't offer, unless someone filed it there", async () => {
    const rules = [
      { ...ESCALATIONS, group: "es", when: { "payload.status": ["Incoming"] }, watch: ["payload.status"] },
      { id: "resolved_work", group: "es", group_by: "external_id", action: "task", sources: ["jira"], when: { "payload.status": ["Investigating"] }, watch: ["payload.status"] },
      { ...ESCALATIONS, id: "es_later", group: "es", when: { "payload.status": ["Waiting"] }, watch: ["payload.status"] },
      { ...ESCALATIONS, id: "es_off", group: "es", when: { "payload.status": ["Blocked"] }, watch: ["payload.status"] },
      { id: "case_follow", group: "es", group_by: "external_id", action: "task", sources: ["jira"], workstream: "case follow-up", when: { "payload.status": ["Pending"] }, watch: ["payload.status"] },
    ] satisfies readonly Rule[];
    const { store, post } = await prepare("escalation tracking: ask\ncapacity request: auto\nresolved_work: draft\nes_off: off", rules);
    const tickets = ["refile", "kept", "hand", "offrule", "hand2"];
    await post(...tickets.map((id) => ticket(id, "Please increase TPM for our endpoint", { status: "Incoming" })));
    const byKey = async (): Promise<Record<string, Awaited<ReturnType<SignalsStore["tasks"]>>[number]>> => Object.fromEntries((await store.tasks({})).map((task) => [task.group_key.split("|").pop(), task]));
    expect(Object.values(await byKey()).map((task) => [task.workstream, task.mode])).toEqual(tickets.map(() => ["capacity request", "auto"]));
    // Someone filed "hand" and "hand2" under capacity request themselves: that stays, whatever the new rule's workstream.
    for (const id of ["hand", "hand2"]) await store.file((await byKey())[id]!.id, "bob@x.com", { workstream: "capacity request" });
    const status = { refile: "Investigating", kept: "Waiting", hand: "Investigating", offrule: "Blocked", hand2: "Pending" } as Record<string, string>;
    await post(...tickets.map((id) => ticket(id, "Please increase TPM for our endpoint", { status: status[id] })));
    const after = await byKey();
    // resolved_work has no workstream and no categories: the task is under none, in the team's mode for that rule.
    expect(after.refile).toMatchObject({ rule_id: "resolved_work", workstream: null, mode: "draft" });
    expect(after.kept).toMatchObject({ rule_id: "es_later", workstream: "capacity request", mode: "auto" });
    expect(after.hand).toMatchObject({ rule_id: "resolved_work", workstream: "capacity request", mode: "auto" });
    expect(after.hand2).toMatchObject({ rule_id: "case_follow", workstream: "capacity request", mode: "auto" });
    // es_off offers the same category, but the team turned that rule off: the task keeps its category, and is off with the rule.
    expect(after.offrule).toMatchObject({ rule_id: "es_off", workstream: "capacity request", mode: "off" });
    expect((await store.detail(after.offrule!.id))!.activities.map((one) => one.text)).toContain("Now under rule es_off: a new event matched it. Its mode is off now.");
    expect((await store.detail(after.refile!.id))!.activities.map((one) => one.text)).toContain("Now under rule resolved_work: a new event matched it. That rule has no capacity request category, so it's under no workstream now, in draft mode.");
  });

  it("keeps a filing by hand that a refile overlaps, before its history is saved or after the task was read, in the new rule's mode for it", async () => {
    const rules = [
      { ...ESCALATIONS, group: "es", when: { "payload.status": ["Incoming"] }, watch: ["payload.status"] },
      { id: "case_follow", group: "es", group_by: "external_id", action: "task", sources: ["jira"], workstream: "case follow-up", when: { "payload.status": ["Investigating"] }, watch: ["payload.status"] },
      { ...ESCALATIONS, id: "es_later", group: "es", when: { "payload.status": ["Waiting"] }, watch: ["payload.status"] },
    ] satisfies readonly Rule[];
    // One statement at a time can be held until the test lets it go.
    let held: { match: (sql: string, values?: unknown[]) => boolean; reached: () => void; release: Promise<void> } | undefined;
    const holdNext = (match: (sql: string, values?: unknown[]) => boolean) => {
      let reached!: () => void;
      let release!: () => void;
      const at = new Promise<void>((resolve) => { reached = resolve; });
      held = { match, reached, release: new Promise<void>((resolve) => { release = resolve; }) };
      return { at, release };
    };
    const { store, post } = await prepare("escalation tracking: ask\ncapacity request: auto\nes_later: draft", rules, (sql, values) => {
      if (!held?.match(sql, values)) return undefined;
      const { reached, release } = held;
      held = undefined;
      reached();
      return release;
    });
    await post(...["early", "late", "other"].map((id) => ticket(id, "Please increase TPM for our endpoint", { status: "Incoming" })));
    const byKey = async (): Promise<Record<string, Awaited<ReturnType<SignalsStore["tasks"]>>[number]>> => Object.fromEntries((await store.tasks({})).map((task) => [task.group_key.split("|").pop(), task]));
    const { early, late, other } = await byKey();
    // The filing has saved its workstream, but not yet its history, when the ticket moves to a rule with a workstream of its own.
    const beforeHistory = holdNext((sql, values) => sql.includes("activities") && values?.[2] === "bob@x.com" && values?.[3] === "workstream");
    const filing = store.file(early!.id, "bob@x.com", { workstream: "manual review" });
    await beforeHistory.at;
    expect((await post(ticket("early", "Please increase TPM for our endpoint", { status: "Investigating" }))).errors).toEqual([]);
    beforeHistory.release();
    await filing;
    expect(await store.task(early!.id)).toMatchObject({ rule_id: "case_follow", workstream: "manual review", mode: "auto" });
    // The refile read the task under capacity request; the filing lands before its write, which leaves the filing and its mode.
    const beforeWrite = holdNext((sql) => sql.includes("SET rule_id = $2"));
    const refiled = post(ticket("late", "Please increase TPM for our endpoint", { status: "Waiting" }));
    await beforeWrite.at;
    await store.file(late!.id, "bob@x.com", { workstream: "manual review" });
    beforeWrite.release();
    expect((await refiled).errors).toEqual([]);
    expect(await store.task(late!.id)).toMatchObject({ rule_id: "es_later", workstream: "manual review", mode: "auto" });
    // Filed under another of the new rule's categories meanwhile: it takes the team's mode for that one there (es_later: draft).
    const beforeOther = holdNext((sql) => sql.includes("SET rule_id = $2"));
    const moving = post(ticket("other", "Please increase TPM for our endpoint", { status: "Waiting" }));
    await beforeOther.at;
    await store.file(other!.id, "bob@x.com", { workstream: "incident" });
    beforeOther.release();
    expect((await moving).errors).toEqual([]);
    expect(await store.task(other!.id)).toMatchObject({ rule_id: "es_later", workstream: "incident", mode: "draft" });
  });

  it("matches a category with an accented capital as categoryNamed does when a task moves to a rule turned off", async () => {
    const categories = [{ workstream: "Éscalade", when: { title: "increase TPM" } }];
    const rules = [
      { ...ESCALATIONS, categories, group: "es", when: { "payload.status": ["Incoming"] }, watch: ["payload.status"] },
      { ...ESCALATIONS, categories, id: "resolved", group: "es", workstream: "case follow-up", when: { "payload.status": ["Investigating"] }, watch: ["payload.status"] },
    ] satisfies readonly Rule[];
    const { store, post, sql } = await prepare("Éscalade: auto\nresolved: off", rules);
    // As on a database whose ctype is C, where the database's lower() leaves É as it is (JavaScript's gives é).
    await sql(`ALTER TABLE signals_categories.tasks ALTER COLUMN workstream TYPE text COLLATE "C"`);
    await post(ticket("ES-1", "Please increase TPM", { status: "Incoming" }));
    expect((await store.tasks({}))[0]).toMatchObject({ rule_id: "escalations", workstream: "Éscalade", mode: "auto" });
    await post(ticket("ES-1", "Please increase TPM", { status: "Investigating" }));
    expect((await store.tasks({}))[0]).toMatchObject({ rule_id: "resolved", workstream: "Éscalade", mode: "off" });
  });

  it("places again, posted again, an update whose refile lost every write to a filing by hand, as it would have been placed", async () => {
    const rules = [
      { ...ESCALATIONS, group: "es", group_by: "payload.case", when: { "payload.status": ["Incoming"] }, watch: ["payload.status"] },
      { ...ESCALATIONS, id: "resolved", group: "es", group_by: "payload.case", when: { "payload.status": ["Investigating"] }, watch: ["payload.status"] },
    ] satisfies readonly Rule[];
    // While on, someone files the task by hand before each refile write, so the workstream it read is never the row's.
    let filing: { id: number; attempts: number } | undefined;
    const { store, post, prefer, sql } = await prepare("capacity request: auto\nresolved: off", rules, (text, values) => {
      if (!filing || !text.includes("SET rule_id = $2") || Number(values?.[0]) !== filing.id) return undefined;
      filing.attempts++;
      return store.file(filing.id, "bob@x.com", { workstream: filing.attempts % 2 ? "incident" : "capacity request" }).then(() => undefined);
    });
    await post(ticket("open", "Please increase TPM", { case: "open", status: "Incoming" }), ticket("done", "Please increase TPM", { case: "done", status: "Incoming" }));
    const tasks = Object.fromEntries((await store.tasks({})).map((task) => [task.group_key.split("|").pop(), task]));
    // An open task: the update is saved, but the refile gives up, and the post is asked for again.
    filing = { id: tasks.open!.id, attempts: 0 };
    const update = ticket("open", "Please increase TPM", { case: "open", status: "Investigating" });
    const conflict = await post(update);
    expect(filing.attempts).toBe(5);
    expect(conflict.errors).toEqual([{ index: 0, error: expect.stringContaining("workstream kept changing"), retry: true }]);
    expect(await store.task(tasks.open!.id)).toMatchObject({ rule_id: "escalations", event_count: 1 });
    // Posted again once the filings stop: placed as the first post would have been, with the change it made.
    filing = undefined;
    const again = await post(update);
    expect(again.errors).toEqual([]);
    expect(again.updated).toEqual([expect.objectContaining({ task: expect.objectContaining({ id: tasks.open!.id, rule_id: "resolved", workstream: "incident", mode: "off" }), changes: [{ field: "status", from: "Incoming", to: "Investigating" }] })]);
    expect(await store.task(tasks.open!.id)).toMatchObject({ rule_id: "resolved", workstream: "incident", mode: "off", event_count: 2 });
    // Then it's placed: posted once more, it's the same event, and nothing happens.
    expect(await post(update)).toMatchObject({ same: 1, updated: [], errors: [] });
    // A finished task a new ticket of its case opens again: the refile after that gives up; posted again, the task is open and
    // moved, and its update says it was opened again.
    // (A rule turned off opens nothing again: resolved is in draft mode for this.)
    prefer("capacity request: auto\nresolved: draft");
    await store.setStatus(tasks.done!.id, "done", "bob@x.com");
    filing = { id: tasks.done!.id, attempts: 0 };
    const reopening = ticket("done-2", "Please increase TPM", { case: "done", status: "Investigating" });
    expect((await post(reopening)).errors).toEqual([expect.objectContaining({ retry: true })]);
    filing = undefined;
    const reopened = await post(reopening);
    expect(reopened.updated).toEqual([expect.objectContaining({ task: expect.objectContaining({ id: tasks.done!.id, status: "open", rule_id: "resolved", workstream: "incident", mode: "draft" }), reopened: true, changes: [{ field: "status", from: "Incoming", to: "Investigating" }] })]);
    // A newer version saved meanwhile places itself: the mark on the one before it is gone. (Filed under incident already, so
    // the filings start with the other one.)
    filing = { id: tasks.open!.id, attempts: 1 };
    const back = ticket("open", "Please increase TPM", { case: "open", status: "Incoming" });
    const mark = async () => (await sql(`SELECT place_pending FROM signals_categories.events WHERE external_id = 'open'`)).rows[0] as unknown as { place_pending: unknown };
    expect((await post(back)).errors).toEqual([expect.objectContaining({ retry: true })]);
    expect((await mark()).place_pending).toMatchObject({ outcome: "changed", changes: [{ field: "status", from: "Investigating", to: "Incoming" }] });
    filing = undefined;
    const newer = ticket("open", "Please increase TPM", { case: "open", status: "Investigating", note: "x" });
    expect((await post(newer)).errors).toEqual([]);
    expect((await mark()).place_pending).toBeNull();
    expect(await store.task(tasks.open!.id)).toMatchObject({ rule_id: "resolved" });
  });

  it("places a replayed update once, whichever post of it gets there first, and never over a newer version", async () => {
    const rules = [
      { ...ESCALATIONS, group: "es", when: { "payload.status": ["Incoming"] }, watch: ["payload.status"] },
      { ...ESCALATIONS, id: "investigating", group: "es", when: { "payload.status": ["Investigating"] }, watch: ["payload.status"] },
      { ...ESCALATIONS, id: "verified", group: "es", when: { "payload.status": ["Verified"] }, watch: ["payload.status"] },
    ] satisfies readonly Rule[];
    for (const scenario of ["duplicate", "newer"] as const) {
      // conflict: a filing by hand before each refile write; pause: the next refile write waits until it's let go.
      let stage: "open" | "conflict" | "pause" = "open";
      let attempts = 0;
      let reached!: () => void;
      let release!: () => void;
      const paused = new Promise<void>((resolve) => { reached = resolve; });
      const resumed = new Promise<void>((resolve) => { release = resolve; });
      const { store, post } = await prepare("capacity request: auto\nverified: auto\ninvestigating: off", rules, (text, values) => {
        if (!text.includes("SET rule_id = $2") || stage === "open") return undefined;
        if (stage === "pause") {
          stage = "open";
          reached();
          return resumed;
        }
        attempts++;
        return store.file(Number(values?.[0]), "bob@x.com", { workstream: attempts % 2 ? "incident" : "capacity request" }).then(() => undefined);
      });
      await post(ticket("ES-990", "Please increase TPM", { status: "Incoming" }));
      const task = (await store.tasks({}))[0]!;
      const older = ticket("ES-990", "Please increase TPM", { status: "Investigating" });
      stage = "conflict";
      expect((await post(older)).errors).toEqual([expect.objectContaining({ retry: true })]);
      // A replay waits at its refile while another post gets there first: the same version again, or a newer one.
      stage = "pause";
      const replay = post(older);
      await paused;
      const second = await post(scenario === "duplicate" ? older : ticket("ES-990", "Please increase TPM", { status: "Verified" }));
      expect(second.updated.map((one) => one.task.id)).toEqual([task.id]);
      release();
      // The replay finds the mark gone: it moves, attaches and reports nothing.
      expect(await replay).toMatchObject({ updated: [], errors: [] });
      const moves = (await store.detail(task.id))!.activities.filter((one) => one.kind === "rule");
      expect({ task: await store.task(task.id), moves: moves.length }).toMatchObject({
        task: scenario === "duplicate" ? { rule_id: "investigating", mode: "off", event_count: 2 } : { rule_id: "verified", mode: "auto", event_count: 2 },
        moves: 1,
      });
    }
  });

  it("keeps a replay to be placed again when its move's activity fails, and reports nothing once a newer version passed it", async () => {
    const rules = [
      { ...ESCALATIONS, group: "es", when: { "payload.status": ["Incoming"] }, watch: ["payload.status"] },
      { ...ESCALATIONS, id: "investigating", group: "es", when: { "payload.status": ["Investigating"] }, watch: ["payload.status"] },
      { ...ESCALATIONS, id: "verified", group: "es", when: { "payload.status": ["Verified"] }, watch: ["payload.status"] },
    ] satisfies readonly Rule[];
    for (const scenario of ["activity", "newer"] as const) {
      // conflict: a filing by hand before each refile write; pause: the replay's attach waits until it's let go.
      let stage: "open" | "conflict" | "pause" = "open";
      let attempts = 0;
      let reached!: () => void;
      let release!: () => void;
      const paused = new Promise<void>((resolve) => { reached = resolve; });
      const resumed = new Promise<void>((resolve) => { release = resolve; });
      const { store, post, sql } = await prepare("capacity request: auto\nverified: auto\ninvestigating: off", rules, (text, values) => {
        if (stage === "conflict" && text.includes("SET rule_id = $2")) {
          attempts++;
          return store.file(Number(values?.[0]), "bob@x.com", { workstream: attempts % 2 ? "incident" : "capacity request" }).then(() => undefined);
        }
        if (stage === "pause" && text.includes("INSERT INTO signals_categories.task_events") && text.includes("FOR NO KEY UPDATE")) {
          stage = "open";
          reached();
          return resumed;
        }
        return undefined;
      });
      await post(ticket("ES-990", "Please increase TPM", { status: "Incoming" }));
      const task = (await store.tasks({}))[0]!;
      const older = ticket("ES-990", "Please increase TPM", { status: "Investigating" });
      stage = "conflict";
      expect((await post(older)).errors).toEqual([expect.objectContaining({ retry: true })]);
      stage = "open";
      const mark = async () => ((await sql(`SELECT place_pending FROM signals_categories.events WHERE external_id = 'ES-990'`)).rows[0] as unknown as { place_pending: unknown }).place_pending;
      const moves = async () => (await store.detail(task.id))!.activities.filter((one) => one.kind === "rule").length;
      if (scenario === "activity") {
        // The replay's move can't write its activity: the move and the mark's taking go back with it, and the post is asked for again.
        await sql(`CREATE FUNCTION signals_categories.no_rule() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.kind = 'rule' THEN RAISE EXCEPTION 'activity failed'; END IF; RETURN NEW; END $$`);
        await sql(`CREATE TRIGGER no_rule BEFORE INSERT ON signals_categories.activities FOR EACH ROW EXECUTE FUNCTION signals_categories.no_rule()`);
        const failed = await post(older);
        expect(failed).toMatchObject({ updated: [], errors: [expect.objectContaining({ retry: true })] });
        expect({ task: await store.task(task.id), mark: await mark(), moves: await moves() }).toMatchObject({ task: { rule_id: "escalations", event_count: 1 }, mark: { version: 2 }, moves: 0 });
        await sql(`DROP TRIGGER no_rule ON signals_categories.activities`);
        const again = await post(older);
        expect(again).toMatchObject({ errors: [] });
        expect(again.updated).toEqual([expect.objectContaining({ task: expect.objectContaining({ id: task.id }), changes: [expect.objectContaining({ to: "Investigating" })] })]);
        expect({ task: await store.task(task.id), mark: await mark(), moves: await moves() }).toMatchObject({ task: { rule_id: "investigating", mode: "off", event_count: 2 }, mark: null, moves: 1 });
        continue;
      }
      // The replay moves the task and takes the mark, then waits at its attach while a newer version is placed and reported.
      stage = "pause";
      const replay = post(older);
      await paused;
      expect(await store.task(task.id)).toMatchObject({ rule_id: "investigating", event_count: 1 });
      const newer = await post(ticket("ES-990", "Please increase TPM", { status: "Verified" }));
      expect(newer.updated.map((one) => one.task.id)).toEqual([task.id]);
      release();
      // Its version isn't the saved one now: it attaches and reports nothing, after the newer one's change.
      expect(await replay).toMatchObject({ updated: [], errors: [] });
      expect({ task: await store.task(task.id), mark: await mark(), moves: await moves() }).toMatchObject({ task: { rule_id: "verified", mode: "auto", event_count: 2 }, mark: null, moves: 2 });
    }
  });

  it("opens a closed task again only while the team still works on its own category", async () => {
    const rules = [{ ...ESCALATIONS, group_by: "payload.case" }] satisfies readonly Rule[];
    const { store, post, prefer } = await prepare("escalation tracking: ask\ncapacity request: auto", rules);
    store.categorizer = async () => NO_CATEGORY;
    await post(ticket("e1", "Please increase TPM for our endpoint", { case: "c1" }), ticket("e2", "Please increase TPM", { case: "c2" }));
    const [one, two] = (await store.tasks({})).sort((a, b) => a.id - b.id);
    for (const task of [one!, two!]) await store.setStatus(task.id, "done", "bob@x.com");
    // A new event in c1's group that no `when` places, while the rule's own workstream is still on: capacity request is off now.
    prefer("escalation tracking: ask\ncapacity request: off");
    await post(ticket("e3", "Any update?", { case: "c1" }));
    expect(await store.task(one!.id)).toMatchObject({ status: "done", workstream: "capacity request" });
    // With capacity request back on, c2's does open again.
    prefer("escalation tracking: ask\ncapacity request: auto");
    await post(ticket("e4", "Any update?", { case: "c2" }));
    expect(await store.task(two!.id)).toMatchObject({ status: "open", workstream: "capacity request" });
  });

  it("asks the endpoint a choice question, and reads its answer", async () => {
    const calls: { path: string; body: unknown }[] = [];
    const categorize = jevCategorizer(async (path, init) => (calls.push({ path, body: init.body }), { answers: { category: { type: "choice", choice: "capacity request", confidence: 0.99 } } }));
    expect(await categorize({ source: "jira", external_id: "1", title: "More TPM" }, { "capacity request": "Raise a limit", [NO_CATEGORY]: "None" })).toEqual({ choice: "capacity request", score: 0.99 });
    expect(calls[0]).toMatchObject({ path: "/serving-endpoints/databricks-openjev-qwen35-4b/invocations", body: { state: { title: "More TPM" }, questions: { category: { type: "choice", criteria: { "capacity request": "Raise a limit" } } } } });
    expect(answerChoice({ answers: { category: { choice: "" } } })).toBeUndefined();
    const lines: string[] = [];
    expect(await jevCategorizer(async () => Promise.reject(new Error("HTTP 503")), "ep", (line) => lines.push(line))({ source: "jira", external_id: "2" }, {})).toBeUndefined();
    expect(lines).toEqual(["categorizer ep failed for jira 2: HTTP 503"]);
  });
});

function pglite() {
  const db = new PGlite();
  return { query: async (text: string, values?: unknown[]) => ({ rows: (await db.query(text, values)).rows as never[] }) };
}
