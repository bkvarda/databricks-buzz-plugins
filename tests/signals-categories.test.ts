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
    expect(bad([{ workstream: "a", about: "x", color: "red" }])).toEqual([expect.stringMatching(/is \{workstream, when\?, about\?\}/)]);
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
  const prepare = async (preferences: string, rules: readonly Rule[] = [ESCALATIONS]) => {
    const store = new SignalsStore(pglite(), "signals_categories");
    await store.setup();
    await store.setSource("alice@x.com", "jira", true);
    const config: SignalsConfig = { ...CONFIG, accounts: [{ name: "Acme", channel: "acme", preferences }], rules };
    const post = (...events: ReturnType<typeof ticket>[]) => store.ingest("alice@x.com", events, config);
    await post(ticket("seed", "seed"));
    return { store, post };
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
    ] satisfies readonly Rule[];
    const { store, post } = await prepare("escalation tracking: ask\ncapacity request: auto\nresolved_work: draft", rules);
    await post(ticket("refile", "Please increase TPM for our endpoint", { status: "Incoming" }), ticket("kept", "Please increase TPM for our endpoint", { status: "Incoming" }), ticket("hand", "Please increase TPM", { status: "Incoming" }));
    const byKey = async (): Promise<Record<string, Awaited<ReturnType<SignalsStore["tasks"]>>[number]>> => Object.fromEntries((await store.tasks({})).map((task) => [task.group_key.split("|").pop(), task]));
    expect(Object.values(await byKey()).map((task) => [task.workstream, task.mode])).toEqual([["capacity request", "auto"], ["capacity request", "auto"], ["capacity request", "auto"]]);
    // Someone filed "hand" under capacity request themselves: that stays.
    await store.file((await byKey()).hand!.id, "bob@x.com", { workstream: "capacity request" });
    await post(ticket("refile", "Please increase TPM for our endpoint", { status: "Investigating" }), ticket("kept", "Please increase TPM for our endpoint", { status: "Waiting" }), ticket("hand", "Please increase TPM", { status: "Investigating" }));
    const after = await byKey();
    // resolved_work has no workstream and no categories: the task is under none, in the team's mode for that rule.
    expect(after.refile).toMatchObject({ rule_id: "resolved_work", workstream: null, mode: "draft" });
    expect(after.kept).toMatchObject({ rule_id: "es_later", workstream: "capacity request", mode: "auto" });
    expect(after.hand).toMatchObject({ rule_id: "resolved_work", workstream: "capacity request", mode: "auto" });
    expect((await store.detail(after.refile!.id))!.activities.map((one) => one.text)).toContain("Now under rule resolved_work: a new event matched it. That rule has no capacity request category, so it's under no workstream now, in draft mode.");
  });

  it("asks the endpoint a choice question, and reads its answer", async () => {
    const calls: { path: string; body: unknown }[] = [];
    const categorize = jevCategorizer(async (path, init) => (calls.push({ path, body: init.body }), { answers: { category: { type: "choice", choice: "capacity request", confidence: 0.99 } } }));
    expect(await categorize({ source: "jira", external_id: "1", title: "More TPM" }, { "capacity request": "Raise a limit", [NO_CATEGORY]: "None" })).toBe("capacity request");
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
