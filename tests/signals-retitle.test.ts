// Signals: POST /api/retitle titles and files open tasks again as their rules now would open them, a dry run first.
import { PGlite } from "@electric-sql/pglite";
import { describe, expect, it } from "vitest";
import { Hub } from "../plugins/signals/app/hub";
import type { Rule, SignalsConfig } from "../plugins/signals/app/model";
import { type Categorizer, SignalsStore, type Titler } from "../plugins/signals/app/store";

const TICKETS: Rule = { id: "es-tickets", sources: ["jira"], action: "task", group_by: "external_id", workstream: "escalation tracking" };
const CAPACITY: Rule = { id: "es-capacity-requests", sources: ["jira"], action: "task", group_by: "external_id", workstream: "capacity requests", when: { title: "increase (RPM|TPM|rate limit)" }, title: "Capacity request: {payload.model} in workspace {payload.workspace}" };
const TICKETS_V2: Rule = { ...TICKETS, summarize_title: true, categories: [{ workstream: "feature request", about: "Asks for a feature that doesn't exist yet" }] };
const ACCOUNTS = [{ name: "Acme", channel: "acme", preferences: "feature request: auto" }];
const BEFORE: SignalsConfig = { version: 1, first_run_seen: true, accounts: ACCOUNTS, rules: [TICKETS] };
const AFTER: SignalsConfig = { ...BEFORE, rules: [CAPACITY, TICKETS_V2] };
const CAP_TITLE = "ES-1 For customer: [Acme], workspace id: [27] increase RPM/TPM rate limit for Gemini 4 Neon";
const ticket = (id: string, title: string, payload: Record<string, unknown> = {}) => ({ source: "jira", external_id: id, title, account: "Acme", payload });

async function setup() {
  const store = new SignalsStore(new PGlite(), "signals_retitle");
  store.titler = (async (event) => ({ "ES-2": "Dark mode for the SQL editor", "ES-3": "Jobs failing after the upgrade" })[event.external_id]) satisfies Titler;
  store.categorizer = (async (event) => (event.external_id === "ES-2" ? { choice: "feature request", score: 0.9 } : "none of these")) satisfies Categorizer;
  await store.setup();
  const call = (hub: Hub, path: string, body: unknown, user = "admin@x.com") => hub.handle({ method: "POST", path, query: new URLSearchParams(), user, body: async () => JSON.stringify(body) });
  const before = new Hub(store, undefined, { admins: ["admin@x.com"], defaultConfig: BEFORE });
  await call(before, "/api/sources", { source: "jira", enabled: true });
  await call(before, "/api/events", { events: [{ source: "jira", external_id: "seed" }] });
  await call(before, "/api/events", { events: [
    ticket("ES-1", CAP_TITLE, { model: "Gemini 4 Neon", workspace: "27" }),
    ticket("ES-2", "Dark mode please! Our analysts work late and the SQL editor is very bright, could you add a dark theme option?"),
    ticket("ES-3", "Workspace 9: all our scheduled jobs have been failing since last night's runtime upgrade, please help"),
    ticket("ES-4", "Hand-filed one about a dark theme for notebooks that someone already moved"),
  ] });
  const ids = Object.fromEntries((await store.tasks({})).map((task) => [task.group_key.split("|").pop(), task.id]));
  return { store, call, ids, after: new Hub(store, undefined, { admins: ["admin@x.com"], defaultConfig: AFTER }) };
}

describe("retitle", () => {
  it("is for admins, and a dry run unless told otherwise", async () => {
    const { store, call, ids, after } = await setup();
    expect((await call(after, "/api/retitle", {}, "someone@x.com")).status).toBe(403);
    expect((await call(after, "/api/retitle", { dry_run: "no" })).status).toBe(400);
    const dry = (await call(after, "/api/retitle", {})).json as { dry_run: boolean; changed: { id: number; title: string; applied: boolean }[] };
    expect(dry.dry_run).toBe(true);
    expect(dry.changed.find((c) => c.id === ids["ES-1"])).toMatchObject({ title: "Capacity request: Gemini 4 Neon in workspace 27", applied: false });
    // Nothing written.
    expect((await store.task(ids["ES-1"]!))!).toMatchObject({ title: CAP_TITLE, rule_id: "es-tickets", workstream: "escalation tracking" });
    expect((await store.detail(ids["ES-1"]!))!.activities.map((a) => a.kind)).toEqual(["opened"]);
  });

  it("titles and files open tasks as their rules now would, and leaves a filing by hand", async () => {
    const { store, call, ids, after } = await setup();
    await store.file(ids["ES-4"]!, "bob@x.com", { workstream: "notebooks" });
    await store.setStatus(ids["ES-3"]!, "done", "bob@x.com");
    const result = (await call(after, "/api/retitle", { dry_run: false })).json as { changed: { id: number; applied: boolean }[]; skipped: unknown[]; unchanged: number };
    expect(result.changed.every((c) => c.applied)).toBe(true);
    // A rule that comes first now takes it: its title, its workstream, the team's mode, and its group for the event.
    expect((await store.task(ids["ES-1"]!))!).toMatchObject({ title: "Capacity request: Gemini 4 Neon in workspace 27", source_title: CAP_TITLE, rule_id: "es-capacity-requests", workstream: "capacity requests", filed_by: "rule" });
    // A category the model picks and a short title.
    expect((await store.task(ids["ES-2"]!))!).toMatchObject({ title: "Dark mode for the SQL editor", workstream: "feature request", mode: "auto", filed_by: "classifier" });
    expect((await store.task(ids["ES-2"]!))!.filed_score).toBeCloseTo(0.9);
    // A done task is left.
    expect((await store.task(ids["ES-3"]!))!.title).toMatch(/^Workspace 9: all our/);
    // Filed by hand: keeps its workstream and mode (its title is the rule's still: the titler had none for it).
    expect((await store.task(ids["ES-4"]!))!).toMatchObject({ workstream: "notebooks", filed_by: null });
    expect(result.changed.map((c) => c.id)).not.toContain(ids["ES-3"]);
    const activity = (await store.detail(ids["ES-1"]!))!.activities.at(-1)!;
    expect(activity).toMatchObject({ actor: "admin@x.com", kind: "retitle" });
    expect(activity.text).toContain("rule es-tickets → es-capacity-requests");
    // The ticket's next version comes to the same task, under its new rule.
    await call(after, "/api/events", { events: [ticket("ES-1", `${CAP_TITLE} (bump)`, { model: "Gemini 4 Neon", workspace: "27" })] });
    expect((await store.tasks({})).filter((task) => task.title.startsWith("Capacity request"))).toHaveLength(1);
    expect((await store.task(ids["ES-1"]!))!.event_count).toBe(2);
    // Run again: nothing left to change.
    const again = (await call(after, "/api/retitle", { dry_run: false })).json as { changed: unknown[] };
    expect(again.changed).toEqual([]);
  });

  it("writes nothing for a task that changed since it was read, and keeps a short title the titler can't give now", async () => {
    const { store, ids } = await setup();
    // Filed by hand while the titler is being asked.
    store.titler = (async (event) => {
      if (event.external_id === "ES-2") await store.file(ids["ES-2"]!, "bob@x.com", { workstream: "ui" });
      return undefined;
    }) satisfies Titler;
    const result = await store.retitle(AFTER, "admin@x.com", { dryRun: false, ids: [ids["ES-2"]!] });
    expect(result.changed).toEqual([]);
    expect(result.skipped).toEqual([{ id: ids["ES-2"], reason: "it changed while it was being retitled" }]);
    expect((await store.task(ids["ES-2"]!))!).toMatchObject({ workstream: "ui", rule_id: "es-tickets" });
    // Shortened already, and the titler fails now: the short title stays.
    const db = (store as unknown as { db: PGlite }).db;
    await db.query(`UPDATE signals_retitle.tasks SET title = 'Jobs failing after the upgrade', source_title = 'x' WHERE id = $1`, [ids["ES-3"]]);
    store.titler = (async () => undefined) satisfies Titler;
    await store.retitle({ ...AFTER, rules: [TICKETS_V2] }, "admin@x.com", { dryRun: false, ids: [ids["ES-3"]!] });
    expect((await store.task(ids["ES-3"]!))!.title).toBe("Jobs failing after the upgrade");
  });
  it("leaves a task whose new group another task took while it was being retitled", async () => {
    const { store, ids } = await setup();
    const db = (store as unknown as { db: PGlite }).db;
    const shortened = { ...AFTER, rules: [{ ...CAPACITY, summarize_title: true }, TICKETS_V2] };
    // An ingest opens the capacity rule's task for ES-1 while the titler is being asked.
    store.titler = (async (event) => {
      if (event.external_id === "ES-1") await db.query(`INSERT INTO signals_retitle.tasks (rule_id, group_key, title, created_by, created_at, updated_at, last_event_at) VALUES ('es-capacity-requests', 'es-capacity-requests|ES-1', 'opened meanwhile', 'x', 1, 1, 1)`);
      return undefined;
    }) satisfies Titler;
    const result = await store.retitle(shortened, "admin@x.com", { dryRun: false, ids: [ids["ES-1"]!] });
    expect(result.changed).toEqual([]);
    expect(result.skipped).toEqual([{ id: ids["ES-1"], reason: "another task took rule es-capacity-requests's group for its event while it was being retitled" }]);
    expect((await store.task(ids["ES-1"]!))!).toMatchObject({ rule_id: "es-tickets", group_key: "es-tickets|ES-1", title: CAP_TITLE });
    expect((await store.detail(ids["ES-1"]!))!.activities.map((a) => a.kind)).toEqual(["opened"]);
    expect((await db.query(`SELECT * FROM signals_retitle.group_links`)).rows).toEqual([]);
    // Or links it to itself meanwhile: the same.
    await db.query(`DELETE FROM signals_retitle.tasks WHERE group_key = 'es-capacity-requests|ES-1'`);
    store.titler = (async (event) => {
      if (event.external_id === "ES-1") await db.query(`INSERT INTO signals_retitle.group_links (group_key, task_id, at) VALUES ('es-capacity-requests|ES-1', $1, 1)`, [ids["ES-2"]]);
      return undefined;
    }) satisfies Titler;
    expect((await store.retitle(shortened, "admin@x.com", { dryRun: false, ids: [ids["ES-1"]!] })).changed).toEqual([]);
    expect((await store.task(ids["ES-1"]!))!.rule_id).toBe("es-tickets");
  });

  it("takes the new group as the task's own, its old one linked, so a second retitle can't take it too", async () => {
    const { store, ids } = await setup();
    const db = (store as unknown as { db: PGlite }).db;
    expect((await store.retitle(AFTER, "admin@x.com", { dryRun: false, ids: [ids["ES-1"]!] })).changed).toMatchObject([{ applied: true }]);
    expect((await store.task(ids["ES-1"]!))!.group_key).toBe("es-capacity-requests|ES-1");
    expect((await db.query(`SELECT group_key, task_id::int AS task_id FROM signals_retitle.group_links ORDER BY group_key`)).rows).toEqual([{ group_key: "es-capacity-requests|ES-1", task_id: ids["ES-1"] }, { group_key: "es-tickets|ES-1", task_id: ids["ES-1"] }]);
    // The old group's next event still reaches it.
    expect((await store.taskByGroup("es-tickets|ES-1"))!.id).toBe(ids["ES-1"]);
  });

  it("moves nothing when the event has a newer version than the one it read", async () => {
    const { store, ids } = await setup();
    const db = (store as unknown as { db: PGlite }).db;
    const shortened = { ...AFTER, rules: [{ ...CAPACITY, summarize_title: true }, TICKETS_V2] };
    // A newer version (withdrawn, say) is saved while the titler is being asked.
    store.titler = (async (event) => {
      if (event.external_id === "ES-1") await db.query(`UPDATE signals_retitle.events SET versions = versions + 1, title = 'Withdrawn' WHERE external_id = 'ES-1'`);
      return undefined;
    }) satisfies Titler;
    const result = await store.retitle(shortened, "admin@x.com", { dryRun: false, ids: [ids["ES-1"]!] });
    expect(result.skipped).toEqual([{ id: ids["ES-1"], reason: "it changed while it was being retitled" }]);
    expect((await store.task(ids["ES-1"]!))!).toMatchObject({ rule_id: "es-tickets", title: CAP_TITLE });
  });

  it("looks up an old-keyed Slack task without linking it", async () => {
    const store = new SignalsStore(new PGlite(), "signals_retitle_slack");
    await store.setup();
    const config: SignalsConfig = { version: 1, first_run_seen: true, rules: [{ id: "slack", sources: ["slack"], action: "task", group_by: "group_key" }] };
    const hub = new Hub(store, undefined, { admins: ["admin@x.com"], defaultConfig: config });
    const call = (path: string, body: unknown) => hub.handle({ method: "POST", path, query: new URLSearchParams(), user: "admin@x.com", body: async () => JSON.stringify(body) });
    await call("/api/sources", { source: "slack", enabled: true });
    await call("/api/events", { events: [{ source: "slack", external_id: "seed" }] });
    const url = "https://x.slack.com/archives/C1/p1795000000123456";
    await call("/api/events", { events: [{ source: "slack", external_id: url, url, title: "old", group_key: "1795000000", occurred_at: "1795000000.123456" }] });
    const [task] = await store.tasks({});
    const db = (store as unknown as { db: PGlite }).db;
    expect((await store.taskByGroup("slack|C1:1795000000.123456", { link: false }))!.id).toBe(task!.id);
    expect((await db.query(`SELECT * FROM signals_retitle_slack.group_links`)).rows).toEqual([]);
    // Without it, as ingest looks one up: linked.
    await store.taskByGroup("slack|C1:1795000000.123456");
    expect((await db.query(`SELECT group_key FROM signals_retitle_slack.group_links`)).rows).toEqual([{ group_key: "slack|C1:1795000000.123456" }]);
  });
});
