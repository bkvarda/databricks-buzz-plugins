// Signals: default actions per workstream (workstream_actions): the row each workstream's tasks go by, checked and saved.
import { PGlite } from "@electric-sql/pglite";
import { describe, expect, it } from "vitest";
import { actionsFor, actionsText, catalogFor, triggeredLines, DEFAULT_WORKSTREAM_ACTIONS, MAX_ACTIONS, readWorkstreamActions, recommendedRow, type Rule, type WorkstreamActions } from "../plugins/signals/app/model";
import { briefing, Hub, taskMessage } from "../plugins/signals/app/hub";
import { readTriggerAnswer, type TriggerQuestion } from "../plugins/signals/app/classify";
import { type Db, SignalsStore } from "../plugins/signals/app/store";

function pglite(): Db {
  const db = new PGlite();
  return { query: async (text, values) => ({ rows: (await db.query(text, values)).rows as never[] }) };
}

const escalate = { id: "escalate-if-needed", label: "Escalate if needed", trigger: "Poor sentiment or a stall" };

describe("workstream actions", () => {
  it("reads rows and says what's wrong with one", () => {
    expect(readWorkstreamActions({ " Support Cases ": { watch: [{ ...escalate, label: " Escalate if needed " }], otherwise: "dismiss" } })).toEqual({ "Support Cases": { watch: [escalate], otherwise: "dismiss" } });
    // An always action needs no trigger; `always: false` is left out.
    expect(readWorkstreamActions({ tickets: { watch: [{ id: "work-it", label: "Work it", always: true }, { ...escalate, always: false }], otherwise: "track" } })).toEqual({ tickets: { watch: [{ id: "work-it", label: "Work it", trigger: "", always: true }, escalate], otherwise: "track" } });
    // Track with nothing ticked: tasks are tracked, no agents asked.
    expect(readWorkstreamActions({ questions: { watch: [], otherwise: "track" } })).toEqual({ questions: { watch: [], otherwise: "track" } });
    expect(readWorkstreamActions({ questions: { otherwise: "dismiss" } })).toEqual({ questions: { watch: [], otherwise: "dismiss" } });
    expect(readWorkstreamActions({})).toEqual({});
    const wrong: unknown[] = [
      [],
      "x",
      { questions: { watch: [] } },
      { questions: { watch: [], otherwise: "ignore" } },
      { questions: { watch: {}, otherwise: "track" } },
      { questions: { watch: [{ ...escalate, id: "Escalate" }], otherwise: "track" } },
      { questions: { watch: [{ ...escalate, id: "x".repeat(41) }], otherwise: "track" } },
      { questions: { watch: [escalate, escalate], otherwise: "track" } },
      { questions: { watch: [{ ...escalate, label: " " }], otherwise: "track" } },
      { questions: { watch: [{ ...escalate, label: "x".repeat(61) }], otherwise: "track" } },
      { questions: { watch: [{ ...escalate, label: "Escalate — prod" }], otherwise: "track" } },
      { questions: { watch: [{ ...escalate, trigger: "x".repeat(301) }], otherwise: "track" } },
      { questions: { watch: [{ ...escalate, trigger: " " }], otherwise: "track" } },
      { questions: { watch: [{ ...escalate, always: "yes" }], otherwise: "track" } },
      { questions: { watch: Array.from({ length: MAX_ACTIONS + 1 }, (_, i) => ({ ...escalate, id: `a${i}` })), otherwise: "track" } },
      { questions: { watch: [], otherwise: "track" }, Questions: { watch: [], otherwise: "track" } },
      { "": { watch: [], otherwise: "track" } },
      Object.fromEntries(Array.from({ length: 31 }, (_, i) => [`w${i}`, { watch: [], otherwise: "track" }])),
    ];
    for (const raw of wrong) expect(typeof readWorkstreamActions(raw), JSON.stringify(raw).slice(0, 80)).toBe("string");
  });

  it("finds a task's row by its rule id, then its workstream, in any case", () => {
    const rows = { "Capacity Requests": { watch: [escalate], otherwise: "dismiss" as const }, "es-tickets": { watch: [], otherwise: "track" as const } };
    expect(actionsFor(rows, { rule_id: "es-capacity-requests", workstream: "capacity requests" })?.key).toBe("Capacity Requests");
    expect(actionsFor(rows, { rule_id: "es-tickets", workstream: "capacity requests" })?.key).toBe("es-tickets");
    expect(actionsFor(rows, { rule_id: "x", workstream: "questions" })).toBeUndefined();
    expect(actionsFor(undefined, { workstream: "questions" })).toBeUndefined();
  });

  it("has a catalog entry for each usual workstream, by name or alias, that reads back as a row", () => {
    expect(catalogFor("Capacity Requests")?.workstream).toBe("capacity requests");
    for (const name of ["capacity", "es-capacity-requests"]) expect(catalogFor(name)?.workstream).toBe("capacity requests");
    expect(catalogFor("incidents")?.workstream).toBe("escalations");
    expect(catalogFor("support tracking")?.workstream).toBe("support cases");
    expect(catalogFor("escalation tracking")?.workstream).toBe("tickets");
    expect(catalogFor("meeting action items")?.workstream).toBe("meeting follow-up");
    expect(catalogFor("feature evaluation")).toBeUndefined();
    expect(catalogFor(undefined)).toBeUndefined();
    const names = DEFAULT_WORKSTREAM_ACTIONS.flatMap((entry) => [entry.workstream, ...entry.aliases]);
    expect(new Set(names).size).toBe(names.length);
    for (const entry of DEFAULT_WORKSTREAM_ACTIONS) {
      expect(names.every((name) => name === name.toLowerCase().trim())).toBe(true);
      const row = recommendedRow(entry);
      expect(row.watch.length).toBeGreaterThan(0);
      expect(row.watch.some((action) => "recommended" in action)).toBe(false);
      // Every catalog action, ticked or not, is a valid action.
      expect(readWorkstreamActions({ [entry.workstream]: { watch: entry.actions.map(({ recommended: _, ...action }) => action), otherwise: entry.otherwise } })).toEqual({ [entry.workstream]: { watch: entry.actions.map(({ recommended: _, ...action }) => action), otherwise: entry.otherwise } });
    }
    expect(recommendedRow(catalogFor("support cases")!)).toMatchObject({ otherwise: "dismiss", watch: [{ id: "escalate-if-needed" }, { id: "confirm-workaround" }, { id: "engage-engineering" }] });
    expect(recommendedRow(catalogFor("tickets")!).otherwise).toBe("track");
  });

  it("saves an account's rows, replaces them whole, and refuses bad ones", async () => {
    const store = new SignalsStore(pglite(), "signals_ws_actions_save");
    await store.setup();
    const hub = new Hub(store, undefined, { defaultConfig: { version: 1, rules: [] } });
    const call = (body: unknown) => hub.handle({ method: "POST", path: "/api/account", query: new URLSearchParams(), user: "alice@x.com", body: async () => JSON.stringify(body) });
    await call({ name: "Globex", channel: "globex", preferences: "everything: draft" });
    expect((await store.account({ name: "Globex" }))!.workstream_actions).toEqual({});
    const support = { watch: [escalate], otherwise: "dismiss" };
    const saved = await call({ name: "Globex", workstream_actions: { "support cases": support } });
    expect((saved.json as { account: { workstream_actions: object } }).account.workstream_actions).toEqual({ "support cases": support });
    // Other fields leave the rows alone.
    await call({ name: "Globex", preferences: "everything: auto" });
    expect((await store.account({ name: "Globex" }))!.workstream_actions).toEqual({ "support cases": support });
    // The map is replaced whole.
    await call({ name: "Globex", workstream_actions: { tickets: { watch: [], otherwise: "track" } } });
    expect((await store.account({ name: "Globex" }))!.workstream_actions).toEqual({ tickets: { watch: [], otherwise: "track" } });
    const bad = await call({ name: "Globex", workstream_actions: { tickets: { watch: [], otherwise: "maybe" } } });
    expect(bad.status).toBe(400);
    expect((await store.account({ name: "Globex" }))!.workstream_actions).toEqual({ tickets: { watch: [], otherwise: "track" } });
    // An empty map clears them: every workstream works as before.
    await call({ name: "Globex", workstream_actions: {} });
    expect((await store.account({ name: "Globex" }))!.workstream_actions).toEqual({});
  });

  it("reads a saved row that no longer checks out as no row", async () => {
    const db = pglite();
    const store = new SignalsStore(db, "signals_ws_actions_read");
    await store.setup();
    await store.saveAccount("Globex", { workstream_actions: { questions: { watch: [escalate], otherwise: "dismiss" } } }, "alice");
    await db.query(`UPDATE signals_ws_actions_read.accounts SET workstream_actions = workstream_actions || '{"tickets": {"watch": [], "otherwise": "later"}}'::jsonb`);
    expect((await store.account({ name: "Globex" }))!.workstream_actions).toEqual({ questions: { watch: [escalate], otherwise: "dismiss" } });
  });

});

describe("workstream actions' trigger checks", () => {
  const agent = "ab".repeat(32);
  const workIt = { id: "work-it", label: "Work it", trigger: "", always: true as const };
  const confirm = { id: "confirm-workaround", label: "Confirm workaround", trigger: "Support gave a workaround" };
  const rules = [{ id: "cases", sources: ["gmail"], action: "task" as const, workstream: "support cases", group_by: "external_id" }];

  /** A hub whose posts, updates and trigger questions are kept; `answer` says what the model holds (by action id), or undefined for a failed check. */
  async function setup(schema: string, row: WorkstreamActions[string] | undefined, mode = "draft", given: readonly Rule[] = rules) {
    const db = pglite();
    const store = new SignalsStore(db, schema);
    await store.setup();
    const opened: { task: number; agents: readonly string[]; text: string; status: string }[] = [];
    const updates: { task: number; text: string; agents: readonly string[] }[] = [];
    const asked: TriggerQuestion[] = [];
    const model = { answer: (_q: TriggerQuestion): Record<string, { holds: boolean; why: string }> | undefined => ({}) };
    const hub = new Hub(
      store,
      {
        opened: async (task, agents = [], context = {}) => (opened.push({ task: task.id, agents, text: taskMessage(task, { agents, ...context }), status: task.status }), "f".repeat(60) + String(task.id).padStart(4, "0")),
        updated: async (task, text, agents = []) => void updates.push({ task: task.id, text, agents }),
      },
      { defaultConfig: { version: 1, rules: [...given] }, triggerer: async (q) => (asked.push(q), model.answer(q)) },
    );
    const call = (path: string, body: unknown) => hub.handle({ method: "POST", path, query: new URLSearchParams(), user: "alice@x.com", body: async () => JSON.stringify(body) });
    await call("/api/account", { name: "Globex", channel: "globex", domains: ["globex.io"], agents: [agent], preferences: `everything: ${mode}`, workstream_actions: { "Support Cases": row } });
    await call("/api/sources", { source: "gmail", enabled: true });
    await call("/api/events", { events: [{ source: "gmail", external_id: "seed" }] });
    const send = (id: string, body: string, more: Record<string, unknown> = {}) => call("/api/events", { events: [{ source: "gmail", external_id: id, actor: "ann@globex.io", title: "Case 42", payload: { body, ...more } }] });
    const activities = async (task: number) => ((await store.detail(task))!.activities as { kind: string; text: string }[]).filter((one) => one.kind === "trigger" || one.kind === "status").map((one) => one.text);
    return { db, store, hub, opened, updates, asked, model, call, send, activities };
  }

  it("dismisses a new task none of whose triggers hold, posts it folded with no agent, and opens it again when one does", async () => {
    const t = await setup("signals_trig_dismiss", { watch: [escalate, confirm], otherwise: "dismiss" });
    t.model.answer = () => ({ "escalate-if-needed": { holds: false, why: "calm, moving" }, "confirm-workaround": { holds: false, why: "no workaround yet" } });
    await t.send("c1", "We see slow queries");
    expect(t.opened).toHaveLength(1);
    const id = t.opened[0]!.task;
    expect(t.opened[0]).toMatchObject({ agents: [], status: "dismissed" });
    expect(t.opened[0]!.text).toContain("No default action for Support Cases is triggered, so it's dismissed");
    // The model was asked about the ticked actions, with the task and its event.
    expect(t.asked[0]!.actions.map((action) => action.id)).toEqual(["escalate-if-needed", "confirm-workaround"]);
    expect(t.asked[0]!.task.workstream).toBe("support cases");
    const task = (await t.store.task(id))!;
    expect(task.status).toBe("dismissed");
    expect(task.triggers).toMatchObject({ held: { "escalate-if-needed": false, "confirm-workaround": false }, dismissed: true });
    expect(await t.activities(id)).toEqual(["Escalate if needed: not triggered (calm, moving)", "Confirm workaround: not triggered (no workaround yet)", "dismissed: Not triggered: Escalate if needed (calm, moving); Confirm workaround (no workaround yet)"]);

    // A new customer message on it doesn't open it again by itself (it was dismissed by the defaults, not handled)...
    t.model.answer = () => ({ "escalate-if-needed": { holds: false, why: "still calm" }, "confirm-workaround": { holds: false, why: "no workaround" } });
    await t.send("c1", "Any news?");
    expect((await t.store.task(id))!.status).toBe("dismissed");
    expect(t.updates.at(-1)).toMatchObject({ task: id, agents: [] });
    // ...a trigger that holds does, and wakes the account's agents with what triggered.
    t.model.answer = () => ({ "escalate-if-needed": { holds: true, why: "customer is angry, 5 days stalled" }, "confirm-workaround": { holds: false, why: "no workaround" } });
    await t.send("c1", "This is unacceptable, 5 days and nothing");
    expect((await t.store.task(id))!.status).toBe("open");
    const woke = t.updates.at(-1)!;
    expect(woke.agents).toEqual([agent]);
    expect(woke.text).toContain("↩️ Open again");
    expect(woke.text).toContain("**Triggered:** Escalate if needed — customer is angry, 5 days stalled");
    expect(woke.text).toContain("Default actions for Support Cases");
    expect(await t.activities(id)).toContain("open: Escalate if needed triggered");
    // Still holding at the next version: not done again (edge-triggered; the same Update line isn't repeated either).
    const wakes = () => t.updates.filter((one) => one.agents.length).length;
    await t.send("c1", "Still waiting!!");
    expect(wakes()).toBe(1);
    expect(t.updates.at(-1)).toBe(woke);
    // It stops holding, then holds again: done again.
    t.model.answer = () => ({ "escalate-if-needed": { holds: false, why: "resolved tone" }, "confirm-workaround": { holds: false, why: "none" } });
    await t.send("c1", "Thanks, that looks better");
    t.model.answer = () => ({ "escalate-if-needed": { holds: true, why: "broken again" }, "confirm-workaround": { holds: false, why: "none" } });
    await t.send("c1", "Broken again, escalating");
    expect(t.updates.at(-1)).toMatchObject({ agents: [agent] });
    expect(t.updates.at(-1)!.text).toContain("**Triggered:** Escalate if needed — broken again");
  });

  it("wakes agents with what triggered, for each action that holds (an always action without the model)", async () => {
    const t = await setup("signals_trig_several", { watch: [workIt, escalate, confirm], otherwise: "dismiss" });
    t.model.answer = (q) => Object.fromEntries(q.actions.map((action) => [action.id, { holds: true, why: `${action.id} holds` }]));
    await t.send("c1", "Workaround: restart; customer upset");
    expect(t.opened[0]!.agents).toEqual([agent]);
    expect(t.asked[0]!.actions.map((action) => action.id)).toEqual(["escalate-if-needed", "confirm-workaround"]);
    expect(t.opened[0]!.text).toContain("**Triggered:** Work it\n**Triggered:** Escalate if needed — escalate-if-needed holds\n**Triggered:** Confirm workaround — confirm-workaround holds");
    expect((await t.store.task(t.opened[0]!.task))!.status).toBe("open");

    // Only always actions: no model at all.
    const only = await setup("signals_trig_always", { watch: [workIt], otherwise: "dismiss" });
    await only.send("c1", "Hello");
    expect(only.asked).toEqual([]);
    expect(only.opened[0]).toMatchObject({ agents: [agent], status: "open" });
    expect(only.opened[0]!.text).toContain("**Triggered:** Work it");
  });

  it("tracks a task none of whose triggers hold when Otherwise is track, asking no agent", async () => {
    const t = await setup("signals_trig_track", { watch: [escalate], otherwise: "track" });
    t.model.answer = () => ({ "escalate-if-needed": { holds: false, why: "fine" } });
    await t.send("c1", "Question");
    expect(t.opened[0]).toMatchObject({ agents: [], status: "open" });
    expect(t.opened[0]!.text).toContain("tracked with no agent asked");
    // Nothing ticked and track: no model, tracked.
    const none = await setup("signals_trig_none", { watch: [], otherwise: "track" });
    await none.send("c1", "Question");
    expect(none.asked).toEqual([]);
    expect(none.opened[0]).toMatchObject({ agents: [], status: "open" });
  });

  it("fails open when the model can't answer, saying so on the task", async () => {
    const t = await setup("signals_trig_fail", { watch: [escalate], otherwise: "dismiss" });
    t.model.answer = () => undefined;
    await t.send("c1", "Question");
    expect(t.opened[0]).toMatchObject({ agents: [agent], status: "open" });
    expect(await t.activities(t.opened[0]!.task)).toEqual(["Default actions for Support Cases not checked (the model gave no usable answer), so it goes on as without them"]);
    expect((await t.store.task(t.opened[0]!.task))!.triggers).toBeNull();
    // An answer that leaves an action out does too.
    t.model.answer = () => ({});
    await t.send("c3", "Question");
    expect(t.opened.at(-1)).toMatchObject({ agents: [agent], status: "open" });
    // A model that throws fails the same way.
    t.model.answer = () => {
      throw new Error("down");
    };
    await t.send("c2", "Question");
    expect(t.opened.at(-1)).toMatchObject({ agents: [agent], status: "open" });
    expect(readTriggerAnswer('Sure: {"a": {"holds": true, "why": "x"}}', ["a"])).toEqual({ a: { holds: true, why: "x" } });
    expect(readTriggerAnswer('{"a": {"holds": "yes"}}', ["a"])).toBeUndefined();
    expect(readTriggerAnswer('{"a": {"holds": true}}', ["a", "b"])).toBeUndefined();
    expect(readTriggerAnswer("no json", ["a"])).toBeUndefined();
  });

  it("leaves a person's dismissal alone, and a task without a row as it was", async () => {
    const t = await setup("signals_trig_person", { watch: [escalate], otherwise: "dismiss" });
    t.model.answer = () => ({ "escalate-if-needed": { holds: true, why: "upset" } });
    await t.send("c1", "Upset");
    const id = t.opened[0]!.task;
    await t.call("/api/task", { id, status: "dismissed" });
    expect((await t.store.task(id))!.triggers?.dismissed).toBeUndefined();
    t.model.answer = () => ({ "escalate-if-needed": { holds: false, why: "calm" } });
    await t.send("c1", "ok");
    t.model.answer = () => ({ "escalate-if-needed": { holds: true, why: "upset again" } });
    await t.send("c1", "Upset again");
    // (A customer message may open a person's dismissal again the usual way; the default actions don't.)
    expect(await t.activities(id)).not.toContain("open: Escalate if needed triggered");

    // No row for the workstream: no check, the agents work it as before.
    const plain = await setup("signals_trig_norow", { watch: [escalate], otherwise: "dismiss" });
    await plain.call("/api/account", { name: "Globex", workstream_actions: { questions: { watch: [], otherwise: "dismiss" } } });
    await plain.send("c1", "Question");
    expect(plain.asked).toEqual([]);
    expect(plain.opened[0]).toMatchObject({ agents: [agent], status: "open" });
    expect(plain.opened[0]!.text).not.toContain("default action");
  });

  it("doesn't save a check of a version that's been replaced, and asks no model in mode off", async () => {
    const t = await setup("signals_trig_stale", { watch: [escalate], otherwise: "dismiss" });
    t.model.answer = () => ({ "escalate-if-needed": { holds: false, why: "calm" } });
    await t.send("c1", "Question");
    const id = t.opened[0]!.task;
    const subject = (await t.store.triggerSubject(id))!;
    const held = (on: boolean) => ({ held: { "escalate-if-needed": on }, event: subject.id, version: subject.version });
    expect(await t.store.saveTriggers(id, { event: subject.id, version: subject.version - 1, prior: subject.prior }, held(true), [{ id: "escalate-if-needed", label: "Escalate if needed", held: true, why: "old" }], { reopen: "old" })).toBeUndefined();
    // Nor one that read the task's last check before another check saved.
    expect(await t.store.saveTriggers(id, { event: subject.id, version: subject.version, prior: null }, held(true), [], { reopen: "old" })).toBeUndefined();
    expect((await t.store.task(id))!.status).toBe("dismissed");
    // A check that changes nothing keeps the Otherwise mark, so a later trigger can still open it.
    expect((await t.store.saveTriggers(id, { event: subject.id, version: subject.version, prior: subject.prior }, held(false), [{ id: "escalate-if-needed", label: "Escalate if needed", held: false, why: "calm" }]))!.triggers?.dismissed).toBe(true);
    // Someone opening it clears the mark.
    expect((await t.store.setStatus(id, "open", "alice"))!.triggers?.dismissed).toBeUndefined();

    // An edit saved while a new task's check waits on the model: that check isn't saved, and its post checks the edit.
    let edits = 0;
    t.model.answer = () => {
      if (!edits++) void t.db.query(`UPDATE signals_trig_stale.events SET versions = versions + 1 WHERE external_id = 'c2'`);
      return { "escalate-if-needed": { holds: edits > 1, why: edits > 1 ? "upset in the edit" : "calm" } };
    };
    await t.send("c2", "Question");
    expect(edits).toBe(2);
    expect(t.opened).toHaveLength(2);
    expect(t.opened.at(-1)).toMatchObject({ agents: [agent], status: "open" });
    expect(t.opened.at(-1)!.text).toContain("upset in the edit");
    expect(t.opened.at(-1)!.text).not.toContain("calm");

    await t.db.query(`UPDATE signals_trig_stale.tasks SET mode = 'off' WHERE id = $1`, [id]);
    const before = t.asked.length;
    await t.send("c1", "Upset now");
    expect(t.asked.length).toBe(before);
  });

  it("writes Triggered lines a card can split at the first em dash, whatever the label or reason says", () => {
    expect(triggeredLines([{ id: "a", label: "Escalate: production", held: true, why: "sev1 — paging" }, { id: "w", label: "Work it", held: true, why: "always" }])).toBe("**Triggered:** Escalate: production — sev1 — paging\n**Triggered:** Work it");
    expect(readWorkstreamActions({ q: { watch: [{ ...escalate, label: "Escalate: production" }], otherwise: "track" } })).not.toBeTypeOf("string");
  });

  it("tells agents the row in their brief", () => {
    const account = { name: "Globex", preferences: "", domains: [], profile: "", playbooks: {}, workstream_actions: { "support cases": { watch: [workIt, escalate], otherwise: "dismiss" as const } } } as never;
    const text = briefing(account, undefined, { rule_id: "cases", workstream: "Support Cases" });
    expect(text).toContain(actionsText({ key: "support cases", row: { watch: [workIt, escalate], otherwise: "dismiss" } }));
    expect(text).toContain("- Work it: always\n- Escalate if needed: Poor sentiment or a stall\nOtherwise (none holds): the task is dismissed.");
    expect(briefing(account, undefined, { rule_id: "cases", workstream: "questions" })).not.toContain("Default actions");
  });

  // (A case's emails, one task: each a separate event, as Jira comments or alerts on one ticket are.)
  const grouped: readonly Rule[] = [{ ...rules[0]!, group_by: "payload.case", watch: ["payload.state"] }];

  it("checks each event a post attaches, and keeps a watched change quiet when nothing fires", async () => {
    const t = await setup("signals_trig_batch", { watch: [escalate], otherwise: "track" }, "draft", grouped);
    t.model.answer = (q) => ({ "escalate-if-needed": { holds: String((q.event.payload as { body?: string }).body).includes("escalate"), why: "checked" } });
    await t.send("m1", "hello", { case: "42", state: "new" });
    const id = t.opened[0]!.task;
    await t.call("/api/events", { events: [
      { source: "gmail", external_id: "m2", actor: "ann@globex.io", title: "Case 42", payload: { body: "please escalate", case: "42", state: "new" } },
      { source: "gmail", external_id: "m3", actor: "ann@globex.io", title: "Case 42", payload: { body: "assignee changed", case: "42", state: "new" } },
    ] });
    expect(t.asked.map((q) => (q.event.payload as { body: string }).body)).toEqual(["hello", "please escalate", "assignee changed"]);
    expect(t.updates.filter((one) => one.agents.length)).toHaveLength(1);
    expect(t.updates.at(-1)!.text).toMatch(/^Update: Case 42\n\n\*\*Triggered:\*\* Escalate if needed — checked/);
    // A watched field changes and nothing fires: the change is shown, nobody's asked.
    const before = t.updates.length;
    await t.send("m4", "routine", { case: "42", state: "assigned" });
    expect(t.updates.length).toBe(before + 1);
    expect(t.updates.at(-1)).toMatchObject({ task: id, agents: [] });
    expect(t.updates.at(-1)!.text).toContain("**state:** new → assigned");
  });

  it("sends a fired action's notice again from the sweep when its post fails, once", async () => {
    const t = await setup("signals_trig_retry", { watch: [escalate], otherwise: "dismiss" }, "draft", grouped);
    t.model.answer = () => ({ "escalate-if-needed": { holds: false, why: "calm" } });
    await t.send("m1", "hello", { case: "42", state: "new" });
    const id = t.opened[0]!.task;
    t.model.answer = () => ({ "escalate-if-needed": { holds: true, why: "asked to escalate" } });
    const hub = t.hub as unknown as { notifier: { updated: (...args: unknown[]) => Promise<void> } };
    const real = hub.notifier.updated;
    let failing = true;
    hub.notifier.updated = async (...args) => (failing ? Promise.reject(new Error("relay down")) : real(...args));
    await t.send("m2", "please escalate", { case: "42", state: "new" });
    expect((await t.store.task(id))!.status).toBe("open");
    expect(t.updates.filter((one) => one.agents.length)).toHaveLength(0);
    failing = false;
    await t.hub.sweep();
    await t.hub.sweep();
    expect(t.updates.filter((one) => one.agents.length)).toEqual([expect.objectContaining({ task: id, agents: [agent] })]);
    expect(t.updates.at(-1)!.text).toContain("↩️ Open again: Case 42");
    expect(await t.store.undeliveredNotices()).toEqual([]);
  });

  it("still lets a customer message open a task a person dismissed, with or without a row", async () => {
    for (const [schema, row] of [["signals_trig_manual_row", { watch: [escalate], otherwise: "track" as const }], ["signals_trig_manual_none", undefined]] as const) {
      const t = await setup(schema, row ?? { watch: [], otherwise: "track" }, "draft", grouped);
      if (!row) await t.call("/api/account", { name: "Globex", workstream_actions: {} });
      t.model.answer = () => ({ "escalate-if-needed": { holds: true, why: "upset" } });
      await t.send("m1", "hello", { case: "42", state: "new" });
      const id = t.opened[0]!.task;
      await t.call("/api/task", { id, status: "dismissed" });
      await t.send("m2", "new request", { case: "42", state: "new" });
      expect((await t.store.task(id))!.status, schema).toBe("open");
    }
  });

  it("decides checks in the order their versions came, when a later one finishes first", async () => {
    const t = await setup("signals_trig_order", { watch: [escalate], otherwise: "track" }, "draft", grouped);
    const body = (q: TriggerQuestion) => String((q.event.payload as { body?: string }).body);
    let release = () => {};
    const paused = new Promise<void>((resolve) => (release = resolve));
    let entered = () => {};
    const waiting = new Promise<void>((resolve) => (entered = resolve));
    t.model.answer = () => ({ "escalate-if-needed": { holds: false, why: "calm" } });
    await t.send("m1", "hello", { case: "42", state: "new" });
    const id = t.opened[0]!.task;
    const real = t.model.answer;
    (t.hub as unknown as { options: { triggerer: (q: TriggerQuestion) => Promise<unknown> } }).options.triggerer = async (q) => {
      t.asked.push(q);
      if (body(q).includes("escalate")) {
        entered();
        await paused;
        return { "escalate-if-needed": { holds: true, why: "asked to escalate" } };
      }
      return real(q);
    };
    const urgent = t.send("m2", "please escalate", { case: "42", state: "new" });
    await waiting;
    // A routine update checks and finishes while the escalation's check is out: it waits its turn, and its post asks no one.
    await t.send("m3", "assignee changed", { case: "42", state: "new" });
    expect(t.updates.filter((one) => one.agents.length)).toHaveLength(0);
    release();
    await urgent;
    expect(t.updates.filter((one) => one.agents.length)).toEqual([expect.objectContaining({ task: id, agents: [agent] })]);
    expect(t.updates.at(-1)!.text).toContain("**Triggered:** Escalate if needed — asked to escalate");
    // Decided in order: the routine update after the escalation, so it holds no more, and a new escalation fires again.
    expect((await t.store.task(id))!.triggers).toMatchObject({ held: { "escalate-if-needed": false } });
    expect(await t.store.pendingChecks(id)).toEqual([]);
    await t.send("m4", "escalate again", { case: "42", state: "new" });
    expect(t.updates.filter((one) => one.agents.length)).toHaveLength(2);
  });

  it("sends each fired action's notice once, even when another is still being sent", async () => {
    const t = await setup("signals_trig_inflight", { watch: [escalate, confirm], otherwise: "track" }, "draft", grouped);
    t.model.answer = () => ({ "escalate-if-needed": { holds: false, why: "calm" }, "confirm-workaround": { holds: false, why: "none yet" } });
    await t.send("m1", "hello", { case: "42", state: "new" });
    const hub = t.hub as unknown as { notifier: { updated: (...args: unknown[]) => Promise<void> } };
    const real = hub.notifier.updated;
    let release = () => {};
    const paused = new Promise<void>((resolve) => (release = resolve));
    let entered = () => {};
    const sending = new Promise<void>((resolve) => (entered = resolve));
    let held = false;
    hub.notifier.updated = async (...args) => {
      if (!held && String(args[1]).includes("first trigger")) {
        held = true;
        entered();
        await paused;
      }
      return real(...args);
    };
    t.model.answer = (q) => ({ "escalate-if-needed": { holds: true, why: "first trigger" }, "confirm-workaround": { holds: String((q.event.payload as { body?: string }).body).includes("workaround"), why: "second trigger" } });
    const first = t.send("m2", "please escalate", { case: "42", state: "new" });
    await sending;
    await t.send("m3", "here is a workaround", { case: "42", state: "new" });
    release();
    await first;
    await t.hub.sweep();
    const wakes = t.updates.filter((one) => one.agents.length);
    expect(wakes.filter((one) => one.text.includes("first trigger"))).toHaveLength(1);
    expect(wakes.filter((one) => one.text.includes("second trigger"))).toHaveLength(1);
    expect(wakes.find((one) => one.text.includes("second trigger"))!.text).not.toContain("**Triggered:** Escalate");
    expect(await t.store.undeliveredNotices()).toEqual([]);
  });

  it("checks the event that opened a task before later ones in the same post", async () => {
    const t = await setup("signals_trig_open_batch", { watch: [escalate], otherwise: "dismiss" }, "draft", grouped);
    t.model.answer = (q) => ({ "escalate-if-needed": { holds: String((q.event.payload as { body?: string }).body).includes("escalate"), why: "checked" } });
    await t.call("/api/events", { events: [
      { source: "gmail", external_id: "m1", actor: "ann@globex.io", title: "Case 42", payload: { body: "please escalate", case: "42", state: "new" } },
      { source: "gmail", external_id: "m2", actor: "ann@globex.io", title: "Case 42", payload: { body: "assignee changed", case: "42", state: "new" } },
    ] });
    expect(t.asked.map((q) => (q.event.payload as { body: string }).body)).toEqual(["please escalate", "assignee changed"]);
    const id = t.opened[0]!.task;
    expect(t.opened[0]).toMatchObject({ agents: [agent], status: "open" });
    expect(t.opened[0]!.text).toContain("**Triggered:** Escalate if needed — checked");
    expect((await t.store.task(id))!.triggers).toMatchObject({ held: { "escalate-if-needed": false } });
    // Both were checked as it opened: neither is asked about again.
    await t.hub.sweep();
    expect(t.asked).toHaveLength(2);
  });

  it("quotes the event that fired, not a later one in the same post", async () => {
    const t = await setup("signals_trig_source", { watch: [escalate], otherwise: "track" }, "draft", grouped);
    t.model.answer = (q) => ({ "escalate-if-needed": { holds: String((q.event.payload as { body?: string }).body).includes("escalate"), why: "checked" } });
    await t.send("m1", "hello", { case: "42", state: "new" });
    await t.call("/api/events", { events: [
      { source: "gmail", external_id: "m2", actor: "ann@globex.io", title: "Escalation", url: "https://mail.example/m2", payload: { body: "Escalation source quote: please escalate", case: "42", state: "new" } },
      { source: "gmail", external_id: "m3", actor: "ann@globex.io", title: "Assignee", url: "https://mail.example/m3", payload: { body: "Assignee source quote", case: "42", state: "new" } },
    ] });
    const wake = t.updates.find((one) => one.agents.length)!;
    expect(wake.text).toMatch(/^Update: \[Escalation\]\(https:\/\/mail\.example\/m2\)/);
    expect(wake.text).toContain("Escalation source quote");
    expect(wake.text).not.toContain("Assignee source quote");
  });

  it("doesn't fire a new task's trigger from an event version edited while it was checked", async () => {
    const t = await setup("signals_trig_open_edit", { watch: [escalate], otherwise: "dismiss" }, "draft", grouped);
    const body = (q: TriggerQuestion) => String((q.event.payload as { body?: string }).body);
    let release = () => {};
    const paused = new Promise<void>((resolve) => (release = resolve));
    let entered = () => {};
    const waiting = new Promise<void>((resolve) => (entered = resolve));
    (t.hub as unknown as { options: { triggerer: (q: TriggerQuestion) => Promise<unknown> } }).options.triggerer = async (q) => {
      t.asked.push(q);
      if (body(q) === "please escalate") {
        entered();
        await paused;
        return { "escalate-if-needed": { holds: true, why: "asked to escalate" } };
      }
      return { "escalate-if-needed": { holds: false, why: "calm" } };
    };
    const batch = t.call("/api/events", { events: [
      { source: "gmail", external_id: "m1", actor: "ann@globex.io", title: "Case 42", payload: { body: "please escalate", case: "42", state: "new" } },
      { source: "gmail", external_id: "m2", actor: "ann@globex.io", title: "Case 42", payload: { body: "assignee changed", case: "42", state: "new" } },
    ] });
    await waiting;
    // The escalation is withdrawn (its event edited) while its check waits on the model; the batch's other event stays as it was.
    await t.send("m1", "escalation withdrawn", { case: "42", state: "new" });
    release();
    await batch;
    await t.hub.sweep();
    expect(t.opened).toHaveLength(1);
    expect(t.opened[0]).toMatchObject({ agents: [], status: "dismissed" });
    expect(t.opened[0]!.text).toContain("No default action for Support Cases is triggered");
    expect(t.updates.filter((one) => one.agents.length)).toEqual([]);
    expect(t.asked.map(body)).toContain("escalation withdrawn");
  });

  it("quotes the event that fired in a new task's post, not a later quiet one", async () => {
    const t = await setup("signals_trig_open_source", { watch: [escalate], otherwise: "dismiss" }, "draft", grouped);
    t.model.answer = (q) => ({ "escalate-if-needed": { holds: String((q.event.payload as { body?: string }).body).includes("escalate"), why: "checked" } });
    await t.call("/api/events", { events: [
      { source: "gmail", external_id: "m1", actor: "ann@globex.io", title: "Escalation", url: "https://mail.example/m1", payload: { body: "Escalation source quote: please escalate", case: "42", state: "new" } },
      { source: "gmail", external_id: "m2", actor: "ann@globex.io", title: "Assignee", url: "https://mail.example/m2", payload: { body: "Assignee source quote", case: "42", state: "new" } },
    ] });
    expect(t.opened[0]).toMatchObject({ agents: [agent], status: "open" });
    expect(t.opened[0]!.text).toContain("Escalation source quote");
    expect(t.opened[0]!.text).not.toContain("Assignee source quote");
  });

  it("decides versions in the order they were attached, when the earlier post stops before checking", async () => {
    const t = await setup("signals_trig_attach_order", { watch: [escalate], otherwise: "track" }, "draft", grouped);
    t.model.answer = (q) => ({ "escalate-if-needed": { holds: String((q.event.payload as { body?: string }).body).includes("escalate"), why: "checked" } });
    await t.send("m1", "hello", { case: "42", state: "new" });
    const id = t.opened[0]!.task;
    let release = () => {};
    const paused = new Promise<void>((resolve) => (release = resolve));
    let entered = () => {};
    const waiting = new Promise<void>((resolve) => (entered = resolve));
    const ingest = t.store.ingest.bind(t.store);
    t.store.ingest = async (...args: Parameters<typeof t.store.ingest>) => {
      const result = await ingest(...args);
      if (args[1][0]?.external_id === "m2") {
        entered();
        await paused;
      }
      return result;
    };
    // The escalation is attached, and its post stops before checking it; a later quiet update is checked meanwhile.
    const urgent = t.send("m2", "please escalate", { case: "42", state: "new" });
    await waiting;
    await t.send("m3", "assignee changed", { case: "42", state: "new" });
    expect(t.updates.filter((one) => one.agents.length)).toHaveLength(0);
    release();
    await urgent;
    // The escalation fired, then the quiet update was decided after it: it holds no more, so a new escalation fires again.
    expect(t.updates.filter((one) => one.agents.length)).toHaveLength(1);
    expect((await t.store.task(id))!.triggers).toMatchObject({ held: { "escalate-if-needed": false } });
    await t.send("m4", "escalate again", { case: "42", state: "new" });
    expect(t.updates.filter((one) => one.agents.length)).toHaveLength(2);
  });

  it("keeps a version pending from its attachment, for the sweep when its post fails or stops", async () => {
    const t = await setup("signals_trig_recover", { watch: [escalate], otherwise: "track" }, "draft", grouped);
    t.model.answer = (q) => ({ "escalate-if-needed": { holds: String((q.event.payload as { body?: string }).body).includes("escalate"), why: "checked" } });
    await t.send("m1", "hello", { case: "42", state: "new" });
    const id = t.opened[0]!.task;
    const wakes = () => t.updates.filter((one) => one.agents.length).length;
    // The first write after the attachment fails: the version is left for the sweep at once, checked once, and fires once.
    const claim = t.store.claimCheck.bind(t.store);
    t.store.claimCheck = async () => {
      throw new Error("claim write unavailable");
    };
    await t.send("m2", "please escalate", { case: "42", state: "new" });
    t.store.claimCheck = claim;
    expect(t.asked).toHaveLength(1);
    expect(wakes()).toBe(0);
    await t.hub.sweep();
    await t.hub.sweep();
    expect(t.asked).toHaveLength(2);
    expect(wakes()).toBe(1);
    // A post that stops mid-check (nothing given back): the sweep leaves the version to it for its lease, then checks it.
    const store = t.store.storeCheck.bind(t.store);
    const release = t.store.releaseChecks.bind(t.store);
    t.store.storeCheck = async () => {
      throw new Error("stopped");
    };
    t.store.releaseChecks = async () => {
      throw new Error("stopped");
    };
    t.model.answer = () => ({ "escalate-if-needed": { holds: false, why: "calm" } });
    await t.send("m3", "calm now", { case: "42", state: "new" });
    t.store.storeCheck = store;
    t.store.releaseChecks = release;
    await t.hub.sweep();
    expect(t.asked).toHaveLength(3);
    expect((await t.store.pendingChecks(id)).map((one) => one.result)).toEqual([undefined]);
    await t.db.query(`UPDATE signals_trig_recover.task_events SET trigger_claimed_at = trigger_claimed_at - 1000 WHERE trigger_pending`);
    await t.hub.sweep();
    expect(t.asked).toHaveLength(4);
    expect(await t.store.pendingChecks(id)).toEqual([]);
    expect((await t.store.task(id))!.triggers).toMatchObject({ held: { "escalate-if-needed": false } });
  });

  it("marks a version whose attachment failed to be placed again, so the same event posted again is attached and checked once", async () => {
    const t = await setup("signals_trig_unattached", { watch: [escalate], otherwise: "track" }, "draft", grouped);
    t.model.answer = (q) => ({ "escalate-if-needed": { holds: String((q.event.payload as { body?: string }).body).includes("escalate"), why: "checked" } });
    await t.send("m1", "hello", { case: "42", state: "new" });
    const id = t.opened[0]!.task;
    const store = t.store as unknown as { attachOnce: (...args: unknown[]) => Promise<unknown> };
    const attach = store.attachOnce.bind(t.store);
    store.attachOnce = async () => {
      throw new Error("attachment unavailable");
    };
    // The event is saved, its attachment isn't: the post is asked for again.
    const failed = await t.send("m2", "please escalate", { case: "42", state: "new" });
    store.attachOnce = attach;
    expect(failed.json).toMatchObject({ errors: [{ error: "attachment unavailable", retry: true }] });
    expect((await t.store.latestEvent(id))!.external_id).toBe("m1");
    await t.hub.sweep();
    expect(t.asked).toHaveLength(1);
    // Posted again, the same event is placed: attached, checked and fired once.
    await t.send("m2", "please escalate", { case: "42", state: "new" });
    await t.hub.sweep();
    expect((await t.store.latestEvent(id))!.external_id).toBe("m2");
    expect(t.asked.map((q) => q.event.external_id)).toEqual(["m1", "m2"]);
    expect(t.updates.filter((one) => one.agents.length)).toHaveLength(1);
    expect(await t.store.pendingChecks(id)).toEqual([]);
  });

  it("checks a new task's first events at its opening and the rest after it's posted, in the order they were attached", async () => {
    const t = await setup("signals_trig_cap", { watch: [escalate], otherwise: "dismiss" }, "draft", grouped);
    t.model.answer = (q) => ({ "escalate-if-needed": { holds: String((q.event.payload as { body?: string }).body).includes("escalate"), why: "checked" } });
    const bodies = ["hello", "routine 1", "routine 2", "routine 3", "routine 4", "routine 5", "please escalate", "routine 6"];
    await t.call("/api/events", { events: bodies.map((body, i) => ({ source: "gmail", external_id: `m${i + 1}`, actor: "ann@globex.io", title: "Case 42", occurred_at: 1795200000 + i, payload: { body, case: "42", state: "new" } })) });
    const id = t.opened[0]!.task;
    // The first six held nothing: it's dismissed and posted folded; the seventh, past them, is checked as an update and opens it again.
    expect(t.opened[0]).toMatchObject({ agents: [], status: "dismissed" });
    expect(t.asked.map((q) => (q.event.payload as { body: string }).body)).toEqual(bodies);
    expect((await t.store.task(id))!.status).toBe("open");
    expect(t.updates.filter((one) => one.agents.length)).toHaveLength(1);
    expect(await t.store.pendingChecks(id)).toEqual([]);
  });

  it("keeps a watched change quiet while its check is still pending, and wakes the agents once when the sweep checks it", async () => {
    const t = await setup("signals_trig_quiet_pending", { watch: [escalate], otherwise: "track" }, "draft", grouped);
    t.model.answer = (q) => ({ "escalate-if-needed": { holds: String((q.event.payload as { body?: string }).body).includes("escalate"), why: "checked" } });
    // Opened with the agents on it, then a quiet update: escalating again would fire.
    await t.send("m1", "escalate at once", { case: "42", state: "new" });
    const id = t.opened[0]!.task;
    expect(t.opened[0]!.agents).toEqual([agent]);
    await t.send("m2", "hello", { case: "42", state: "new" });
    const claim = t.store.claimCheck.bind(t.store);
    t.store.claimCheck = async () => {
      throw new Error("claim write unavailable");
    };
    await t.send("m3", "please escalate", { case: "42", state: "assigned" });
    t.store.claimCheck = claim;
    // The watched change is shown, nobody's woken: the check that decides that is still pending.
    expect(t.updates.at(-1)).toMatchObject({ task: id, agents: [] });
    expect(t.updates.at(-1)!.text).toContain("**state:** new → assigned");
    await t.hub.sweep();
    await t.hub.sweep();
    const woken = t.updates.filter((one) => one.agents.length);
    expect(woken).toHaveLength(1);
    expect(woken[0]!.text).toContain("**Triggered:** Escalate if needed — checked");
    expect(t.asked).toHaveLength(3);
  });

  it("doesn't post a new task before its first event is attached, and posts it once, checked, when the event is posted again", async () => {
    const t = await setup("signals_trig_first_attach", { watch: [escalate], otherwise: "dismiss" });
    t.model.answer = () => ({ "escalate-if-needed": { holds: false, why: "calm" } });
    const store = t.store as unknown as { attachOnce: (...args: unknown[]) => Promise<unknown> };
    const attach = store.attachOnce.bind(t.store);
    store.attachOnce = async () => {
      throw new Error("attachment unavailable");
    };
    // The task is opened, its event isn't attached: nothing's posted, by the post or the sweep, and nobody's asked.
    const failed = await t.send("m1", "hello");
    expect(failed.json).toMatchObject({ retry: true, errors: [{ error: "attachment unavailable", retry: true }] });
    await t.hub.sweep();
    store.attachOnce = attach;
    await t.hub.sweep();
    expect(t.opened).toHaveLength(0);
    expect(t.asked).toHaveLength(0);
    // Posted again, the event is attached and the task posted as new: checked, and dismissed by Otherwise.
    await t.send("m1", "hello");
    await t.hub.sweep();
    expect(t.opened).toEqual([expect.objectContaining({ agents: [], status: "dismissed" })]);
    expect(t.asked).toHaveLength(1);
    expect(t.updates).toHaveLength(0);
  });

  it("marks a version to be placed as it's recorded, so the same event posted again is placed even when no write after that worked", async () => {
    const t = await setup("signals_trig_record_mark", { watch: [escalate], otherwise: "track" }, "draft", grouped);
    t.model.answer = (q) => ({ "escalate-if-needed": { holds: String((q.event.payload as { body?: string }).body).includes("escalate"), why: "checked" } });
    const mark = async (id: string) => (await t.db.query(`SELECT place_pending FROM signals_trig_record_mark.events WHERE external_id = $1`, [id])).rows[0] as { place_pending: unknown };
    await t.send("m1", "hello", { case: "42", state: "new" });
    const id = t.opened[0]!.task;
    // Placed: its mark is cleared.
    expect((await mark("m1")).place_pending).toBeNull();
    const store = t.store as unknown as { attachOnce: (...args: unknown[]) => Promise<unknown> };
    const attach = store.attachOnce.bind(t.store);
    store.attachOnce = async () => {
      throw new Error("attachment unavailable");
    };
    const db = t.db as { -readonly [K in keyof Db]: Db[K] };
    const query = db.query;
    db.query = async (text, values) => {
      if (text.includes("SET place_pending = $3::jsonb")) throw new Error("mark unavailable");
      return query(text, values);
    };
    const failed = await t.send("m2", "please escalate", { case: "42", state: "new" });
    store.attachOnce = attach;
    db.query = query;
    expect(failed.json).toMatchObject({ retry: true, errors: [{ error: "attachment unavailable", retry: true }] });
    expect((await mark("m2")).place_pending).toMatchObject({ version: 1, outcome: "new" });
    await t.send("m2", "please escalate", { case: "42", state: "new" });
    await t.hub.sweep();
    expect((await t.store.latestEvent(id))!.external_id).toBe("m2");
    expect((await mark("m2")).place_pending).toBeNull();
    expect(t.asked.map((q) => q.event.external_id)).toEqual(["m1", "m2"]);
    expect(t.updates.filter((one) => one.agents.length)).toHaveLength(1);
    // A changed version's mark has the version before it, for the watched fields' changes when it's placed again.
    store.attachOnce = async () => {
      throw new Error("attachment unavailable");
    };
    db.query = async (text, values) => {
      if (text.includes("SET place_pending = $3::jsonb")) throw new Error("mark unavailable");
      return query(text, values);
    };
    await t.send("m2", "please escalate", { case: "42", state: "assigned" });
    store.attachOnce = attach;
    db.query = query;
    expect((await mark("m2")).place_pending).toMatchObject({ version: 2, outcome: "changed", before_row: { payload: { state: "new" } } });
    await t.send("m2", "please escalate", { case: "42", state: "assigned" });
    expect(t.updates.at(-1)!.text).toContain("**state:** new → assigned");
    expect((await mark("m2")).place_pending).toBeNull();
  });

  it.each([true, false])("reports a version once when the same event is posted again while its first post is still placing it (default actions: %s)", async (configured) => {
    const t = await setup(`signals_trig_overlap_${configured}`, configured ? { watch: [escalate], otherwise: "track" } : undefined, "draft", grouped);
    t.model.answer = (q) => ({ "escalate-if-needed": { holds: String((q.event.payload as { body?: string }).body).includes("escalate"), why: "checked" } });
    await t.send("m1", "hello", { case: "42", state: "new" });
    // The first post stops right after its attachment; the same event posted again meanwhile takes its mark and reports it.
    const db = t.db as { -readonly [K in keyof Db]: Db[K] };
    const query = db.query;
    let attached = () => {};
    const paused = new Promise<void>((resolve) => (attached = resolve));
    let resume = () => {};
    const resumed = new Promise<void>((resolve) => (resume = resolve));
    let pause = true;
    db.query = (async (text: string, values?: unknown[]) => {
      const rows = await query(text, values);
      if (pause && text.includes(".task_events (task_id, event_id, version, at")) {
        pause = false;
        attached();
        await resumed;
      }
      return rows;
    }) as Db["query"];
    const first = t.send("m1", "please escalate", { case: "42", state: "assigned" });
    await paused;
    const again = await t.send("m1", "please escalate", { case: "42", state: "assigned" });
    resume();
    await first;
    db.query = query;
    expect(again.json).toMatchObject({ errors: [] });
    expect(t.updates.filter((one) => one.text.includes("**state:** new → assigned"))).toHaveLength(1);
    expect(t.updates.filter((one) => one.agents.length)).toHaveLength(1);
  });

  /** Pauses the next post right after its attachment (its task_events insert) until `resume`. */
  function pauseAfterAttach(t: { db: Db }) {
    const db = t.db as { -readonly [K in keyof Db]: Db[K] };
    const query = db.query;
    let attached = () => {};
    const paused = new Promise<void>((resolve) => (attached = resolve));
    let resume = () => {};
    const resumed = new Promise<void>((resolve) => (resume = resolve));
    let pause = true;
    db.query = (async (text: string, values?: unknown[]) => {
      const rows = await query(text, values);
      if (pause && text.includes(".task_events (task_id, event_id, version, at")) {
        pause = false;
        attached();
        await resumed;
      }
      return rows;
    }) as Db["query"];
    return { paused, resume: () => (resume(), (db.query = query)) };
  }

  it("reports a version's watched change when a newer version, keeping that field, is placed while it's still placing", async () => {
    const t = await setup("signals_trig_overlap_newer", undefined, "draft", grouped);
    await t.send("m1", "hello", { case: "42", state: "new" });
    // Version 2 changes the state and stops right after its attachment; version 3 (only its text corrected) is placed meanwhile.
    const { paused, resume } = pauseAfterAttach(t);
    const first = t.send("m1", "please look", { case: "42", state: "assigned" });
    await paused;
    const newer = await t.send("m1", "please look (typo fixed)", { case: "42", state: "assigned" });
    resume();
    expect((await first).json).toMatchObject({ errors: [] });
    expect(newer.json).toMatchObject({ errors: [] });
    expect((await t.store.task(t.opened[0]!.task))!.event_count).toBe(3);
    // Version 3 saw assigned → assigned; version 2's own attachment still reports new → assigned, once, waking the agent.
    expect(t.updates.filter((one) => one.text.includes("**state:** new → assigned")).map((one) => one.agents)).toEqual([[agent]]);
  });

  it("reports Open again once when the event that opened a task again is posted again while its first post is still placing it", async () => {
    const t = await setup("signals_trig_overlap_reopen", undefined, "draft", grouped);
    await t.send("m1", "hello", { case: "42", state: "new" });
    const id = t.opened[0]!.task;
    await t.call("/api/task", { id, status: "dismissed" });
    // A new customer message opens it again and stops right after its attachment; the same message posted again meanwhile
    // claims that attachment's report, so it reports what the attachment did: Open again.
    const { paused, resume } = pauseAfterAttach(t);
    const first = t.send("m2", "it's back", { case: "42", state: "new" });
    await paused;
    const again = await t.send("m2", "it's back", { case: "42", state: "new" });
    resume();
    expect((await first).json).toMatchObject({ errors: [] });
    expect(again.json).toMatchObject({ errors: [] });
    expect((await t.store.task(id))!).toMatchObject({ status: "open", event_count: 2 });
    expect(t.updates.filter((one) => one.text.includes("↩️ Open again"))).toHaveLength(1);
  });

  it("reports a new event's watched change from its attachment when the same event posted again claims it", async () => {
    const t = await setup("signals_trig_overlap_new", undefined, "draft", grouped);
    await t.send("m1", "hello", { case: "42", state: "new" });
    // A new event of the case changes its state and stops right after its attachment; posted again meanwhile, it's the task's
    // latest event by then, so the post again reports the changes saved with the attachment, not the event against itself.
    const { paused, resume } = pauseAfterAttach(t);
    const first = t.send("m2", "please look", { case: "42", state: "assigned" });
    await paused;
    const again = await t.send("m2", "please look", { case: "42", state: "assigned" });
    resume();
    expect((await first).json).toMatchObject({ errors: [] });
    expect(again.json).toMatchObject({ errors: [] });
    expect((await t.store.task(t.opened[0]!.task))!.event_count).toBe(2);
    expect(t.updates.filter((one) => one.text.includes("**state:** new → assigned")).map((one) => one.agents)).toEqual([[agent]]);
  });

  it("asks for the post again when claiming an update's report fails, and the post again reports it once", async () => {
    const t = await setup("signals_trig_claim_fails", undefined, "draft", grouped);
    await t.send("m1", "hello", { case: "42", state: "new" });
    const db = t.db as { -readonly [K in keyof Db]: Db[K] };
    const query = db.query;
    db.query = (async (text: string, values?: unknown[]) => {
      if (text.includes("SET reported_at")) throw new Error("claim unavailable");
      return query(text, values);
    }) as Db["query"];
    const failed = await t.send("m1", "please look", { case: "42", state: "assigned" });
    db.query = query;
    expect(failed.json).toMatchObject({ errors: [{ error: "claim unavailable", retry: true }] });
    expect(t.updates.filter((one) => one.text.includes("**state:** new → assigned"))).toHaveLength(0);
    await t.send("m1", "please look", { case: "42", state: "assigned" });
    await t.hub.sweep();
    await t.send("m1", "please look", { case: "42", state: "assigned" });
    expect((await t.store.task(t.opened[0]!.task))!.event_count).toBe(2);
    expect(t.updates.filter((one) => one.text.includes("**state:** new → assigned")).map((one) => one.agents)).toEqual([[agent]]);
  });

  it("reports an update from its attachment when the post again also fails to claim it and to put its mark back", async () => {
    const t = await setup("signals_trig_claim_fails_twice", undefined, "draft", grouped);
    await t.send("m1", "hello", { case: "42", state: "new" });
    const db = t.db as { -readonly [K in keyof Db]: Db[K] };
    const query = db.query;
    let failMark = false;
    db.query = (async (text: string, values?: unknown[]) => {
      if (text.includes("SET reported_at")) throw new Error("claim unavailable");
      if (failMark && text.includes("SET place_pending = $3::jsonb")) throw new Error("mark unavailable");
      return query(text, values);
    }) as Db["query"];
    const edit = () => t.send("m1", "please look", { case: "42", state: "assigned" });
    expect((await edit()).json).toMatchObject({ errors: [{ retry: true }] });
    // The post again takes the mark, then neither its claim nor putting the mark back works: still asked for again.
    failMark = true;
    expect((await edit()).json).toMatchObject({ errors: [{ retry: true }] });
    expect((await t.db.query(`SELECT place_pending FROM signals_trig_claim_fails_twice.events WHERE external_id = 'm1'`)).rows[0]!.place_pending).toBeNull();
    db.query = query;
    // With no mark left, the next post reports it from its attachment, once: a failure finding it, or reading its task, asks
    // for the post again rather than leaving it unreported.
    db.query = (async (text: string, values?: unknown[]) => {
      if (text.includes("reported_at IS NULL AND report_changes IS NOT NULL ORDER BY")) throw new Error("lookup timed out");
      return query(text, values);
    }) as Db["query"];
    expect((await edit()).json).toMatchObject({ errors: [{ error: "lookup timed out", retry: true }] });
    const task = t.store.task.bind(t.store);
    t.store.task = async () => { throw new Error("task read timed out"); };
    db.query = query;
    expect((await edit()).json).toMatchObject({ errors: [{ error: "task read timed out", retry: true }] });
    t.store.task = task;
    expect(t.updates.filter((one) => one.text.includes("**state:** new → assigned"))).toHaveLength(0);
    expect((await edit()).json).toMatchObject({ errors: [] });
    await t.hub.sweep();
    await edit();
    expect((await t.store.task(t.opened[0]!.task))!.event_count).toBe(2);
    expect(t.updates.filter((one) => one.text.includes("**state:** new → assigned")).map((one) => one.agents)).toEqual([[agent]]);
  });
});
