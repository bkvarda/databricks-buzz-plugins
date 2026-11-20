// Signals: default actions per workstream (workstream_actions): the row each workstream's tasks go by, checked and saved.
import { PGlite } from "@electric-sql/pglite";
import { describe, expect, it } from "vitest";
import { actionsFor, catalogFor, DEFAULT_WORKSTREAM_ACTIONS, MAX_ACTIONS, readWorkstreamActions, recommendedRow } from "../plugins/signals/app/model";
import { Hub } from "../plugins/signals/app/hub";
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
