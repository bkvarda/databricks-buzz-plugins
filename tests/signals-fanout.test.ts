// Signals: an event about every account (a new feature announced) opens a candidate per account, judged one by one.
import { describe, expect, it } from "vitest";
import { configProblems, fanOut, type SignalsConfig } from "../plugins/signals/app/model";

const rule = { id: "feature-announcement", sources: ["slack"], when: { "payload.channel": "^field-announcements$" }, action: "task" as const, title: "Evaluate: {title}", workstream: "feature evaluation", group_by: "payload.feature", fan_out: "accounts" as const };
const config: SignalsConfig = {
  version: 1,
  default_channel: "triage",
  rules: [rule],
  accounts: [
    { name: "Globex", channel: "globex", preferences: "feature evaluation: draft" },
    { name: "Initech", channel: "initech", preferences: "feature evaluation: off" },
    { name: "Umbrella", preferences: "feature evaluation: ask" },
    // Not opted in: no preference, or only the catch-all.
    { name: "Hooli", channel: "hooli" },
    { name: "Stark", channel: "stark", preferences: "everything: auto" },
    { name: "globex", preferences: "feature evaluation: auto" },
  ],
};
const announcement = (text: string) => ({ source: "slack", external_id: "C1:1795129827.636059", title: "Format unification preview", actor: "pm@x.com", occurred_at: "2026-11-20T10:00:00Z", payload: { channel: "field-announcements", feature: "format-unification", text } });

describe("fan-out rules", () => {
  it("decides one candidate per opted-in account, in its channel and mode, once per name", () => {
    const fan = fanOut(config, announcement("PrPr recruiting."), { firstRun: false })!;
    expect(fan.decisions.map((d) => [d.account?.name, d.group, d.channel, d.mode, d.create, d.title])).toEqual([
      ["Globex", "feature-announcement|format-unification|globex", "globex", "draft", true, "Globex: Evaluate: Format unification preview"],
      ["Umbrella", "feature-announcement|format-unification|umbrella", "triage", "ask", true, "Umbrella: Evaluate: Format unification preview"],
    ]);
    // A first run only records it.
    expect(fanOut(config, announcement("x"), { firstRun: true })!.decisions.every((d) => !d.create)).toBe(true);
    // Not a fan-out rule's event: none.
    expect(fanOut(config, { source: "slack", external_id: "2", payload: { channel: "general" } }, { firstRun: false })).toBeUndefined();
  });

  it("checks the rule", () => {
    expect(configProblems({ ...config, rules: [{ ...rule, fan_out: "everyone" as never }] })).toContain("rules[0].fan_out is \"accounts\"");
    expect(configProblems({ ...config, rules: [{ ...rule, action: "update" }] })).toContain("rules[0].fan_out needs action task");
    expect(configProblems({ ...config, rules: [{ ...rule, account: "Globex" }] })).toContain("rules[0].fan_out is about every account, so it takes no account");
    // A classifier isn't run on fan-out yet: refused, not skipped.
    expect(configProblems({ ...config, rules: [{ ...rule, classify: { question: "A real launch?" } }] })).toContain("rules[0].fan_out is about every account, so it takes no classify");
    expect(configProblems(config)).toEqual([]);
  });

  const setup = async (schema: string, fail?: (text: string, values?: unknown[]) => boolean | Promise<boolean>, cfg: SignalsConfig = config) => {
    const { PGlite } = await import("@electric-sql/pglite");
    const { SignalsStore } = await import("../plugins/signals/app/store");
    const { Hub } = await import("../plugins/signals/app/hub");
    const pg = new PGlite();
    const store = new SignalsStore({ query: async (text, values) => {
      if (await fail?.(text, values as unknown[])) throw new Error("write failed");
      return (await pg.query(text, values as unknown[])) as { rows: never[] };
    } }, schema);
    await store.setup();
    const posted: number[] = [];
    const updates: { id: number; text: string }[] = [];
    let current = cfg;
    const hub = new Hub(store, { opened: async (task) => (posted.push(task.id), `root-${task.id}`), updated: async (task, text) => void updates.push({ id: task.id, text }) }, { defaultConfig: cfg });
    const call = (path: string, body: unknown, user = "pm@x.com") => hub.handle({ method: "POST", path, query: new URLSearchParams(), user, body: async () => JSON.stringify(body) });
    await call("/api/sources", { source: "slack", enabled: true });
    await call("/api/events", { events: [{ source: "slack", external_id: "seed" }] });
    const candidates = async () => (await store.tasks({})).filter((t) => t.rule_id === "feature-announcement").sort((a, b) => a.group_key.localeCompare(b.group_key));
    const verdict = (id: number, value: string, note: string) => call("/api/task", { id, verdict: value, note }, "genie@x.com");
    // Ingest straight through the store, with a config of the test's choosing (an account's preferences changed, say).
    const ingest = (events: unknown[], with_ = current) => store.ingest("pm@x.com", events as never, (current = with_));
    return { store, hub, call, posted, updates, candidates, verdict, ingest, pg };
  };

  it("opens a candidate per opted-in account, and an announcement posted again keeps every verdict", async () => {
    const { store, call, posted, updates, candidates, verdict } = await setup("signals_fanout");
    await call("/api/events", { events: [announcement("PrPr recruiting.")] });
    let list = await candidates();
    // Globex and Umbrella (Initech turned this work off; Hooli and Stark never opted in), each once.
    expect(list.map((t) => [t.account, t.channel, t.mode, t.status, t.workstream, t.verdict, t.event_count])).toEqual([
      ["Globex", "globex", "draft", "open", "feature evaluation", null, 1],
      ["Umbrella", "triage", "ask", "open", "feature evaluation", null, 1],
    ]);
    expect(posted.sort()).toEqual(list.map((t) => t.id).sort());
    const [globex, umbrella] = list as [typeof list[0], typeof list[0]];

    // Globex is disqualified (done), Umbrella qualified.
    expect((await verdict(globex.id, "disqualified", "Not on a supported cloud.")).status ?? 200).toBe(200);
    expect((await verdict(umbrella.id, "qualified", "Asked for it in BR-1.")).status ?? 200).toBe(200);
    expect((await verdict(umbrella.id, "maybe", "")).status).toBe(400);
    expect((await store.detail(globex.id))!.activities.map((a) => [a.kind, a.text])).toEqual([
      ["opened", "Opened by rule feature-announcement, for Globex."],
      ["verdict", "disqualified: Not on a supported cloud."],
      ["status", "done: Disqualified: Not on a supported cloud."],
    ]);

    // The same announcement again, and then changed (a reminder edited in): no new candidates, every verdict kept,
    // the disqualified one stays done, and nothing new is posted.
    posted.length = 0;
    updates.length = 0;
    await call("/api/events", { events: [announcement("PrPr recruiting.")] });
    await call("/api/events", { events: [announcement("PrPr recruiting. Reminder: form closes Friday.")] });
    list = await candidates();
    expect(list.map((t) => [t.account, t.status, t.verdict, t.verdict_by])).toEqual([
      ["Globex", "done", "disqualified", "genie@x.com"],
      ["Umbrella", "open", "qualified", "genie@x.com"],
    ]);
    expect(posted).toEqual([]);
    expect(updates.filter((u) => u.id === globex.id)).toEqual([]);
    expect((await store.detail(umbrella.id))!.events.length).toBe(1);
  });

  it("finishes a fan-out a failed write cut short when the announcement is posted again, posting each candidate once", async () => {
    let inserts = 0;
    let failing = true;
    const t = await setup("signals_fanout_partial", (text) => failing && text.includes("ON CONFLICT (group_key) DO NOTHING RETURNING *),\n           te AS") && ++inserts === 2);
    const first = await t.call("/api/events", { events: [announcement("PrPr recruiting.")] });
    // Saved, but not all of its candidates: the post is asked for again.
    expect((first.json as { retry?: boolean }).retry).toBe(true);
    expect((await t.candidates()).map((c) => c.account)).toEqual(["Globex"]);
    const [globex] = await t.candidates();
    expect(t.posted).toEqual([globex!.id]);
    // Globex is judged before the post comes again.
    await t.verdict(globex!.id, "unsure", "AE to decide.");
    failing = false;
    t.posted.length = 0;
    const again = await t.call("/api/events", { events: [announcement("PrPr recruiting.")] });
    expect((again.json as { retry?: boolean }).retry).toBeUndefined();
    const list = await t.candidates();
    expect(list.map((c) => [c.account, c.verdict, c.event_count])).toEqual([["Globex", "unsure", 1], ["Umbrella", null, 1]]);
    // Only the missing one is posted; Globex isn't again.
    expect(t.posted).toEqual([list[1]!.id]);
    // A third time changes nothing.
    t.posted.length = 0;
    t.updates.length = 0;
    await t.call("/api/events", { events: [announcement("PrPr recruiting.")] });
    expect(t.posted).toEqual([]);
    expect(t.updates).toEqual([]);
    expect((await t.candidates()).map((c) => c.event_count)).toEqual([1, 1]);
  });

  it("leaves an account that opts out alone: its candidate isn't updated, and none opens", async () => {
    const t = await setup("signals_fanout_optout");
    await t.ingest([announcement("PrPr recruiting.")]);
    const [globex, umbrella] = await t.candidates();
    const out = { ...config, accounts: config.accounts!.map((a) => (a.name === "Globex" ? { ...a, preferences: "feature evaluation: off" } : a)) };
    const result = await t.ingest([announcement("PrPr recruiting. Reminder.")], out);
    expect(result.updated.map((u) => u.task.id)).toEqual([umbrella!.id]);
    expect((await t.store.task(globex!.id))!.event_count).toBe(1);
    // A new feature: none for Globex.
    const next = await t.ingest([{ ...announcement("GA."), external_id: "C1:2", payload: { channel: "field-announcements", feature: "lakebase-ga", text: "GA." } }], out);
    expect(next.created.map((c) => c.account)).toEqual(["Umbrella"]);
  });

  it("records a verdict with its activity and status, or not at all", async () => {
    let failing = false;
    const t = await setup("signals_fanout_verdict", (text) => failing && text.includes("'verdict'"));
    await t.call("/api/events", { events: [announcement("PrPr recruiting.")] });
    const [globex] = await t.candidates();
    failing = true;
    await expect(t.verdict(globex!.id, "disqualified", "Not eligible.")).rejects.toThrow();
    const after = (await t.store.task(globex!.id))!;
    expect([after.status, after.verdict]).toEqual(["open", null]);
    expect((await t.store.detail(globex!.id))!.activities.map((a) => a.kind)).toEqual(["opened"]);
    failing = false;
    await t.verdict(globex!.id, "disqualified", "Not eligible.");
    const done = (await t.store.task(globex!.id))!;
    expect([done.status, done.verdict]).toEqual(["done", "disqualified"]);
  });

  it("keeps a first run's decision for an announcement posted again: recorded, nothing opened", async () => {
    const t = await setup("signals_fanout_first");
    await t.call("/api/sources", { source: "slack", enabled: true }, "first@x.com");
    const first = await t.store.ingest("first@x.com", [announcement("PrPr recruiting.")], config);
    expect(first.firstRun).toBe(true);
    expect(await t.candidates()).toEqual([]);
    // The same post again (no longer a first run): still nothing.
    const again = await t.store.ingest("first@x.com", [announcement("PrPr recruiting.")], config);
    expect([again.firstRun, again.same, again.created.length]).toEqual([false, 1, 0]);
    expect(await t.candidates()).toEqual([]);
    // Edited: a new version, placed now.
    const edited = await t.store.ingest("first@x.com", [announcement("PrPr recruiting. Reminder.")], config);
    expect(edited.created.map((c) => c.account).sort()).toEqual(["Globex", "Umbrella"]);
  });

  it("reports each candidate's update once, by the ingest that attached it, and keeps one a later account's failure doesn't undo", async () => {
    let failing = false;
    let attaches = 0;
    const t = await setup("signals_fanout_updates", (text) => failing && text.includes("lk AS (SELECT id, status, answered_us") && ++attaches === 2);
    await t.ingest([announcement("PrPr recruiting.")]);
    const [globex, umbrella] = await t.candidates();
    // Two ingests of the same edit at the same time: one update per candidate between them.
    const both = await Promise.all([t.ingest([announcement("Reminder 1.")]), t.ingest([announcement("Reminder 1.")])]);
    expect(both.flatMap((r) => r.updated.map((u) => u.task.id)).sort()).toEqual([globex!.id, umbrella!.id].sort());
    // Umbrella's attachment fails: Globex's update is reported anyway, and the post asked for again.
    failing = true;
    const cut = await t.ingest([announcement("Reminder 2.")]);
    expect(cut.updated.map((u) => u.task.id)).toEqual([globex!.id]);
    expect(cut.errors.map((e) => e.retry)).toEqual([true]);
    failing = false;
    // Posted again: Umbrella's, and only that.
    const again = await t.ingest([announcement("Reminder 2.")]);
    expect(again.updated.map((u) => u.task.id)).toEqual([umbrella!.id]);
    expect(again.errors).toEqual([]);
    // And then nothing.
    expect((await t.ingest([announcement("Reminder 2.")])).updated).toEqual([]);
    expect((await t.candidates()).map((c) => c.event_count)).toEqual([3, 3]);
  });

  it("keeps the newest announcement as the latest when an older one comes in late, and shows every event on each candidate", async () => {
    const t = await setup("signals_fanout_latest");
    const newer = { ...announcement("Reminder: form closes Friday."), external_id: "C1:2", occurred_at: "2026-11-22T10:00:00Z" };
    const older = { ...announcement("Reminder: office hours."), external_id: "C1:3", occurred_at: "2026-11-21T10:00:00Z" };
    await t.ingest([announcement("PrPr recruiting.")]);
    let list = await t.candidates();
    for (const c of list) expect((await t.store.detail(c.id))!.events.map((e) => e.external_id)).toEqual(["C1:1795129827.636059"]);
    await t.ingest([newer]);
    await t.ingest([older]);
    list = await t.candidates();
    for (const c of list) {
      expect((await t.store.latestEvent(c.id))!.external_id).toBe("C1:2");
      expect((await t.store.detail(c.id))!.events.map((e) => e.external_id)).toEqual(["C1:2", "C1:3", "C1:1795129827.636059"]);
      expect(c.event_count).toBe(3);
    }
    // An edit of the first: still on both, once each.
    await t.ingest([announcement("PrPr recruiting. Edited.")]);
    for (const c of await t.candidates()) expect((await t.store.detail(c.id))!.events.map((e) => e.external_id)).toEqual(["C1:2", "C1:3", "C1:1795129827.636059"]);
  });

  it("tells reminders in the same second apart when picking the latest", async () => {
    const t = await setup("signals_fanout_micros");
    await t.ingest([announcement("PrPr recruiting.")]);
    const later = { ...announcement("Reminder B."), external_id: "C1:4", occurred_at: "2026-11-21T10:00:00.900000Z" };
    const earlier = { ...announcement("Reminder A."), external_id: "C1:5", occurred_at: "2026-11-21T10:00:00.100000Z" };
    await t.ingest([later]);
    await t.ingest([earlier]);
    for (const c of await t.candidates()) {
      expect((await t.store.latestEvent(c.id))!.external_id).toBe("C1:4");
      expect((await t.store.detail(c.id))!.events.map((e) => e.external_id).sort()).toEqual(["C1:1795129827.636059", "C1:4", "C1:5"]);
    }
  });

  it("opens and updates nothing from an edit a newer one superseded while it waited", async () => {
    let release!: () => void;
    let paused!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const reached = new Promise<void>((r) => (paused = r));
    let pause = false;
    // Holds the intermediate edit's ingest after it's saved, before it places anything.
    const t = await setup("signals_fanout_stale", async (text) => {
      if (pause && /FROM \S+\.tasks WHERE group_key/.test(text)) {
        pause = false;
        paused();
        await gate;
      }
      return false;
    });
    await t.ingest([announcement("PrPr recruiting.")]);
    const ids = (await t.candidates()).map((c) => c.id).sort();
    pause = true;
    const middle = t.ingest([{ ...announcement("Edit 1."), title: "Middle" }]);
    await reached;
    const last = await t.ingest([{ ...announcement("Edit 2."), title: "Final" }]);
    expect(last.updated.map((u) => [u.task.id, u.title]).sort()).toEqual(ids.map((id) => [id, "Final"]));
    release();
    const stale = await middle;
    expect([stale.updated, stale.created, stale.errors]).toEqual([[], [], []]);
    for (const c of await t.candidates()) expect((await t.store.latestEvent(c.id))!.title).toBe("Final");
  });

  it("keeps an update its attachment made when the read after it fails", async () => {
    let failing = false;
    let reads = 0;
    // Every read of a task by id fails while the edit is placed (the one after an attachment, in v3).
    const t = await setup("signals_fanout_read", (text) => failing && /^SELECT \* FROM \S+\.tasks WHERE id = \$1$/.test(text.trim()) && ++reads > 0);
    await t.ingest([announcement("PrPr recruiting.")]);
    failing = true;
    const edit = await t.ingest([announcement("Reminder.")]);
    failing = false;
    expect(edit.errors).toEqual([]);
    expect(edit.updated.length).toBe(2);
    expect(reads).toBe(0);
  });
});
