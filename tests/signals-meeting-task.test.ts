// Signals: a meeting's notes land on that meeting's prep task (a rule's `meeting_task`), from synthetic calendar and Drive events.
import { PGlite } from "@electric-sql/pglite";
import { npubEncode } from "nostr-tools/nip19";
import { describe, expect, it } from "vitest";
import { Hub } from "../plugins/signals/app/hub";
import { configProblems, type SignalsConfig } from "../plugins/signals/app/model";
import { type Classifier, SignalsStore } from "../plugins/signals/app/store";

const RULES: SignalsConfig["rules"] = [
  { id: "customer-meetings", sources: ["google_calendar"], customer_attendees: true, action: "task", title: "Prep: {title}", workstream: "meeting prep", series: "payload.recurringEventId", done_when: { after: "payload.end", note: "the meeting has ended" } },
  { id: "meeting-notes", sources: ["google_drive"], when: { title: "Notes by Gemini" }, account_named_in: "title", action: "task", title: "Follow up: {title}", workstream: "meeting follow-up", group_by: "group_key", action_items: { workstream: "meeting action items" }, meeting_task: { rule: "customer-meetings" } },
];

const genie = "ab".repeat(32);
const prepAgent = "cd".repeat(32);
const followAgent = "ef".repeat(32);

async function setup(schema: string, preferences = "meeting prep: auto\nmeeting follow-up: draft", fail?: (text: string, values?: unknown[]) => boolean, extra: { classifier?: Classifier; account?: Record<string, unknown>; rules?: SignalsConfig["rules"]; failPost?: (text: string) => boolean; onPost?: (text: string) => Promise<void> } = {}) {
  const pg = new PGlite();
  const store = new SignalsStore({ query: async (text: string, values?: unknown[]) => {
    if (fail?.(text, values)) throw new Error("write failed");
    return (await pg.query(text, values as unknown[])) as { rows: never[] };
  } }, schema);
  await store.setup();
  const opened: { id: number; title: string }[] = [];
  const replies: { id: number; text: string; agents: readonly string[] }[] = [];
  const hub = new Hub(
    store,
    { opened: async (task) => (opened.push({ id: task.id, title: task.title }), "f".repeat(60) + String(task.id).padStart(4, "0")), updated: async (task, text, agents = []) => {
      if (extra.failPost?.(text)) throw new Error("relay down");
      await extra.onPost?.(text);
      replies.push({ id: task.id, text, agents });
    } },
    { ...(extra.classifier && { classifier: extra.classifier }), defaultConfig: { version: 1, rules: extra.classifier ? (extra.rules ?? RULES).map((rule) => (rule.id === "meeting-notes" ? { ...rule, classify: { question: "Worth a follow-up?", min: 0.5 } } : rule)) : (extra.rules ?? RULES) } },
  );
  const call = (user: string, path: string, body: unknown) => hub.handle({ method: "POST", path, query: new URLSearchParams(), user, body: async () => JSON.stringify(body) });
  await call("alice@x.com", "/api/account", { name: "Globex", channel: "globex", domains: ["globex.io"], agents: [genie], preferences, ...extra.account });
  for (const user of ["alice@x.com", "bob@x.com"])
    for (const source of ["google_calendar", "google_drive"]) {
      await call(user, "/api/sources", { source, enabled: true });
      await call(user, "/api/events", { events: [{ source, external_id: `seed-${source}` }] });
    }
  // A meeting on someone's calendar: Globex's Jane in it makes it a customer meeting (its prep task), or only colleagues.
  const meeting = (user: string, id: string, options: { customer?: boolean; recurring?: string } = {}) =>
    call(user, "/api/events", { events: [{ source: "google_calendar", external_id: id, title: "Globex QBR", occurred_at: "2026-11-17T10:00:00Z", payload: {
      start: { dateTime: "2026-11-17T10:00:00Z" }, end: { dateTime: "2026-11-17T11:00:00Z" },
      attendees: [{ email: user, displayName: "Alice Wu" }, { email: "ann.lee@x.com", displayName: "Ann Lee" }, ...(options.customer === false ? [] : [{ email: "jane.doe@globex.io", displayName: "Jane Doe" }])],
      ...(options.recurring && { recurringEventId: options.recurring }),
    } }] });
  const link = (id: string) => `https://calendar.google.com/calendar/event?eid=${Buffer.from(`${id} alice@x.com`).toString("base64url")}`;
  const notes = (doc: string, version: string, at: string, meetingLink: string | undefined, steps: string[], title = "Globex QBR - 2026/11/17 - Notes by Gemini") => ({
    source: "google_drive", group_key: doc, external_id: `${doc}:${version}`, title, url: `https://docs.google.com/document/d/${doc}`, occurred_at: at,
    payload: { notes: ["Summary", "Pricing and the renewal.", "Next steps", ...steps, "Details"].join("\n"), meeting: meetingLink ?? null },
  });
  const post = async (user: string, events: unknown[]) => (await call(user, "/api/events", { events })).json as { created: number[]; updated: number[] };
  const all = async () => (await store.tasks({})).sort((a, b) => a.id - b.id);
  return { store, hub, call, meeting, link, notes, post, all, opened, replies, pg };
}

const STEPS = ["[Ann Lee] Send pricing: Send the revised pricing sheet to Jane.", "[Jane Doe] Share usage: Share last quarter's usage export."];

describe("meeting notes on the meeting's prep task (meeting_task)", () => {
  it("puts linked notes on the open prep task: moved to the follow-up rule and mode, its agents asked to go on, and later versions follow", async () => {
    const t = await setup("signals_meeting_task_open");
    await t.meeting("alice@x.com", "evt1");
    const [prep] = await t.all();
    expect(prep).toMatchObject({ rule_id: "customer-meetings", title: "Prep: Globex QBR", workstream: "meeting prep", mode: "auto", status: "open" });

    const first = await t.post("alice@x.com", [t.notes("doc1", "v1", "2026-11-17T11:05:00Z", t.link("evt1"), STEPS)]);
    const tasks = await t.all();
    // No "Follow up:" task: only Ann's action item is new.
    expect(tasks.filter((task) => task.rule_id === "meeting-notes")).toEqual([expect.objectContaining({ id: prep!.id })]);
    expect(tasks.map((task) => task.title)).toEqual(["Prep: Globex QBR", "Action: Send pricing: Send the revised pricing sheet to Jane."]);
    expect(first.created).toEqual([tasks[1]!.id]);
    expect(first.updated).toEqual([prep!.id]);
    const moved = (await t.store.task(prep!.id))!;
    // The team's mode for follow-ups (draft), not prep's (auto); still open, with both events and the customer's item as its checklist.
    expect(moved).toMatchObject({ rule_id: "meeting-notes", workstream: "meeting follow-up", mode: "draft", status: "open", event_count: 2 });
    expect(moved.checklist).toContain("- [ ] [Jane Doe] Share usage: Share last quarter's usage export. (the customer's)");
    expect(moved.checklist).toContain(`- Task ${tasks[1]!.id}: [Ann Lee] Send pricing`);
    const detail = (await t.store.detail(prep!.id))!;
    expect(detail.activities.map((a) => a.text)).toContain("Now under rule meeting-notes: this meeting's notes came in (Globex QBR - 2026/11/17 - Notes by Gemini), so its follow-up is here.");
    expect((await t.store.detail(tasks[1]!.id))!.activities.map((a) => a.text)).toContain(`Opened from the action items in the notes of task ${prep!.id}: [Ann Lee] Send pricing: Send the revised pricing sheet to Jane.`);
    // Its thread: the move, the checklist, and its agent asked to go on with the follow-up's guidance and the notes.
    const update = t.replies.find((reply) => reply.id === prep!.id)!;
    expect(update.agents).toEqual([genie]);
    expect(update.text).toContain("Update: [Globex QBR - 2026/11/17 - Notes by Gemini](https://docs.google.com/document/d/doc1)");
    expect(update.text).toContain("- **workstream:** meeting prep → meeting follow-up\n\n**Action items from the notes for this follow-up**");
    expect(update.text).toContain("Share last quarter's usage export. (the customer's)");
    expect(update.text).toContain(`nostr:${npubEncode(genie)} this changed since you last looked`);
    expect(update.text).toContain("Pricing and the renewal.");

    // The doc's next version: the same task, nothing re-asked, no follow-up of its own.
    const repliesBefore = t.replies.length;
    const second = await t.post("alice@x.com", [t.notes("doc1", "v2", "2026-11-17T11:20:00Z", t.link("evt1"), [...STEPS, "[Ann Lee] Send deck: Send the QBR deck to Jane."])]);
    expect(second.updated).toEqual([prep!.id]);
    expect(second.created).toHaveLength(1);
    expect((await t.all()).filter((task) => task.title.startsWith("Follow up:"))).toEqual([]);
    expect((await t.store.task(prep!.id))!.event_count).toBe(3);
    const later = t.replies.slice(repliesBefore).find((reply) => reply.id === prep!.id)!;
    expect(later.agents).toEqual([]);
    expect(later.text).not.toContain("workstream:");
    expect(later.text).toContain("Send deck");

    // The meeting's end no longer closes it: it follows the follow-up rule now.
    await t.hub.sweep();
    expect((await t.store.task(prep!.id))!.status).toBe("open");
  });

  it("opens a prep task the meeting's end finished again, with the checklist, and finds it from another attendee's calendar", async () => {
    const t = await setup("signals_meeting_task_done");
    // Bob's calendar has the meeting; the notes are in Alice's Drive.
    await t.meeting("bob@x.com", "evt2");
    const [prep] = await t.all();
    expect(await t.hub.sweep()).toMatchObject({ finished: 1 });
    expect((await t.store.task(prep!.id))!.status).toBe("done");

    const posted = await t.post("alice@x.com", [t.notes("doc2", "v1", "2026-11-17T11:05:00Z", t.link("evt2"), STEPS)]);
    expect(posted.updated).toEqual([prep!.id]);
    expect(await t.store.task(prep!.id)).toMatchObject({ rule_id: "meeting-notes", status: "open", workstream: "meeting follow-up" });
    expect((await t.all()).filter((task) => task.title.startsWith("Follow up:"))).toEqual([]);
    const update = t.replies.filter((reply) => reply.id === prep!.id).at(-1)!;
    expect(update.text).toContain("↩️ Open again: [Globex QBR - 2026/11/17 - Notes by Gemini]");
    expect(update.text).toContain("- **workstream:** meeting prep → meeting follow-up\n\n**Action items from the notes for this follow-up**");
    // (Who's who comes only from the poster's own calendar, as before: Alice has no copy, so no item is the team's own task.)
    expect(update.text).toContain("- [ ] [Jane Doe] Share usage: Share last quarter's usage export. (owner not clear)");
    expect(update.agents).toEqual([genie]);
    // And stays open through the next sweep: the meeting has ended, but the follow-up's rule has no end time.
    await t.hub.sweep();
    expect((await t.store.task(prep!.id))!.status).toBe("open");
  });

  it("opens the usual follow-up for notes whose meeting has no prep task, or that link no meeting", async () => {
    const t = await setup("signals_meeting_task_unmatched");
    // A meeting of colleagues only: no prep task. And notes that name no meeting at all.
    await t.meeting("alice@x.com", "evt3", { customer: false });
    expect(await t.all()).toEqual([]);
    const posted = await t.post("alice@x.com", [t.notes("doc3", "v1", "2026-11-17T11:05:00Z", t.link("evt3"), STEPS), t.notes("doc4", "v1", "2026-11-17T12:05:00Z", undefined, STEPS)]);
    const followUps = (await t.all()).filter((task) => task.rule_id === "meeting-notes");
    expect(followUps.map((task) => [task.title, task.group_key, task.workstream])).toEqual([
      ["Follow up: Globex QBR - 2026/11/17 - Notes by Gemini", "meeting-notes|doc3", "meeting follow-up"],
      ["Follow up: Globex QBR - 2026/11/17 - Notes by Gemini", "meeting-notes|doc4", "meeting follow-up"],
    ]);
    expect(posted.created).toEqual(expect.arrayContaining(followUps.map((task) => task.id)));
    expect(t.opened.map((one) => one.title)).toContain("Follow up: Globex QBR - 2026/11/17 - Notes by Gemini");
    // Notes of a meeting that has a prep task, but a doc that already had its own follow-up: that follow-up keeps it.
    await t.meeting("alice@x.com", "evt4");
    const prep = (await t.all()).find((task) => task.rule_id === "customer-meetings")!;
    await t.post("alice@x.com", [t.notes("doc4", "v2", "2026-11-17T12:30:00Z", t.link("evt4"), STEPS)]);
    expect((await t.store.task(prep.id))!).toMatchObject({ rule_id: "customer-meetings", event_count: 1 });
    expect((await t.store.task(followUps[1]!.id))!.event_count).toBe(2);
  });

  it("leaves a prep task still asking about its series alone, and opens nothing with follow-ups turned off", async () => {
    const t = await setup("signals_meeting_task_series");
    await t.meeting("alice@x.com", "evt5_20261117T100000Z", { recurring: "evt5" });
    const [asking] = await t.all();
    expect(asking!.question).toMatch(/recurring series/);
    await t.post("alice@x.com", [t.notes("doc5", "v1", "2026-11-17T11:05:00Z", t.link("evt5_20261117T100000Z"), STEPS)]);
    expect(await t.store.task(asking!.id)).toMatchObject({ rule_id: "customer-meetings", event_count: 1 });
    expect((await t.all()).filter((task) => task.title.startsWith("Follow up:"))).toHaveLength(1);

    const off = await setup("signals_meeting_task_off", "meeting prep: auto\nmeeting follow-up: off");
    await off.meeting("alice@x.com", "evt6");
    const [prep] = await off.all();
    await off.post("alice@x.com", [off.notes("doc6", "v1", "2026-11-17T11:05:00Z", off.link("evt6"), STEPS)]);
    expect(await off.store.task(prep!.id)).toMatchObject({ rule_id: "customer-meetings", workstream: "meeting prep", event_count: 1 });
    expect((await off.all()).map((task) => task.id)).toEqual([prep!.id]);
  });

  it("puts notes whose attachment failed on the prep task from the next sweep, with their checklist", async () => {
    let failing = false;
    const t = await setup("signals_meeting_task_sweep", undefined, (text) => failing && text.includes("WITH lk AS (SELECT id, status, answered_us") && !(failing = false));
    await t.meeting("alice@x.com", "evt7");
    const [prep] = await t.all();
    failing = true;
    const posted = (await t.call("alice@x.com", "/api/events", { events: [t.notes("doc7", "v1", "2026-11-17T11:05:00Z", t.link("evt7"), STEPS)] })).json as { errors: unknown[] };
    expect(posted.errors).toHaveLength(1);
    expect((await t.store.task(prep!.id))!.event_count).toBe(1);
    expect((await t.hub.sweep()).resumed).toBeGreaterThan(0);
    const moved = (await t.store.task(prep!.id))!;
    expect(moved).toMatchObject({ rule_id: "meeting-notes", event_count: 2 });
    expect(moved.checklist).toContain("(the customer's)");
    expect((await t.all()).filter((task) => task.title.startsWith("Follow up:"))).toEqual([]);
    expect((await t.all()).map((task) => task.title)).toContain("Action: Send pricing: Send the revised pricing sheet to Jane.");
    // The move is reported from the sweep, as the ingest would have: its agent asked to go on with the follow-up.
    const update = t.replies.filter((reply) => reply.id === prep!.id).at(-1)!;
    expect(update.text).toContain("- **workstream:** meeting prep → meeting follow-up");
    expect(update.agents).toEqual([genie]);
    // Once: the next sweep has nothing left to report.
    const count = t.replies.length;
    expect(await t.hub.sweep()).toMatchObject({ resumed: 0 });
    expect(t.replies.length).toBe(count);
  });

  it("opens a done prep task again from the sweep when the notes' attachment failed, and asks the follow-up's agent once", async () => {
    let failing = false;
    const t = await setup("signals_meeting_task_sweep_done", undefined, (text) => failing && text.includes("WITH lk AS (SELECT id, status, answered_us") && !(failing = false));
    await t.meeting("alice@x.com", "evt8");
    const [prep] = await t.all();
    expect(await t.hub.sweep()).toMatchObject({ finished: 1 });
    failing = true;
    const posted = (await t.call("alice@x.com", "/api/events", { events: [t.notes("doc8", "v1", "2026-11-17T11:05:00Z", t.link("evt8"), STEPS)] })).json as { errors: unknown[] };
    expect(posted.errors).toHaveLength(1);
    // Moved (that statement worked), not yet attached or opened again.
    expect(await t.store.task(prep!.id)).toMatchObject({ rule_id: "meeting-notes", status: "done", event_count: 1 });
    const before = t.replies.length;
    expect((await t.hub.sweep()).resumed).toBeGreaterThan(0);
    expect(await t.store.task(prep!.id)).toMatchObject({ rule_id: "meeting-notes", workstream: "meeting follow-up", status: "open", event_count: 2 });
    const updates = t.replies.slice(before).filter((reply) => reply.id === prep!.id);
    expect(updates).toHaveLength(1);
    expect(updates[0]!.text).toContain("↩️ Open again: [Globex QBR - 2026/11/17 - Notes by Gemini]");
    expect(updates[0]!.text).toContain("- **workstream:** meeting prep → meeting follow-up\n\n**Action items from the notes for this follow-up**");
    expect(updates[0]!.agents).toEqual([genie]);
    const count = t.replies.length;
    expect(await t.hub.sweep()).toMatchObject({ resumed: 0, finished: 0 });
    expect(t.replies.length).toBe(count);
    expect((await t.store.task(prep!.id))!.status).toBe("open");
  });

  it("leaves a prep task in another account or channel than the notes' alone: the notes open their own follow-up", async () => {
    const t = await setup("signals_meeting_task_routing");
    await t.call("alice@x.com", "/api/account", { name: "Initech", channel: "initech", domains: ["initech.io"], agents: [genie], preferences: "meeting follow-up: draft" });
    await t.meeting("alice@x.com", "evt9");
    const [prep] = await t.all();
    expect(prep).toMatchObject({ account: "Globex", channel: "globex" });
    // Notes the title says are Initech's, linking Globex's meeting: Initech's follow-up, in Initech's channel.
    await t.post("alice@x.com", [t.notes("doc9", "v1", "2026-11-17T11:05:00Z", t.link("evt9"), STEPS, "Initech QBR - 2026/11/17 - Notes by Gemini")]);
    expect(await t.store.task(prep!.id)).toMatchObject({ rule_id: "customer-meetings", workstream: "meeting prep", account: "Globex", event_count: 1 });
    expect((await t.all()).filter((task) => task.rule_id === "meeting-notes").map((task) => [task.group_key, task.account, task.channel])).toEqual([["meeting-notes|doc9", "Initech", "initech"]]);

    // Globex's channel changed since its prep task was posted: the notes go to the new channel, on their own follow-up.
    await t.meeting("alice@x.com", "evt10");
    const other = (await t.all()).find((task) => task.rule_id === "customer-meetings" && task.id !== prep!.id)!;
    expect(other.channel).toBe("globex");
    await t.call("alice@x.com", "/api/account", { name: "Globex", channel: "globex-team", domains: ["globex.io"], agents: [genie], preferences: "meeting prep: auto\nmeeting follow-up: draft" });
    await t.post("alice@x.com", [t.notes("doc10", "v1", "2026-11-17T11:05:00Z", t.link("evt10"), STEPS)]);
    expect(await t.store.task(other.id)).toMatchObject({ rule_id: "customer-meetings", channel: "globex", event_count: 1 });
    expect((await t.all()).filter((task) => task.group_key === "meeting-notes|doc10").map((task) => task.channel)).toEqual(["globex-team"]);
  });

  it("asks the notes rule's classifier before moving a prep task: notes it filters leave the task as it was", async () => {
    let score = 0;
    let asked = 0;
    const t = await setup("signals_meeting_task_classify", undefined, undefined, { classifier: () => (asked++, Promise.resolve(score)) });
    await t.meeting("alice@x.com", "evt11");
    const [prep] = await t.all();
    const filtered = (await t.call("alice@x.com", "/api/events", { events: [t.notes("doc11", "v1", "2026-11-17T11:05:00Z", t.link("evt11"), STEPS)] })).json as { filtered: number };
    expect(filtered.filtered).toBe(1);
    expect(asked).toBe(1);
    expect(await t.store.task(prep!.id)).toMatchObject({ rule_id: "customer-meetings", workstream: "meeting prep", mode: "auto", event_count: 1 });
    expect(await t.all()).toHaveLength(1);
    // Nothing for the sweep to place either: the classifier's decision stands.
    await t.hub.sweep();
    expect(await t.store.task(prep!.id)).toMatchObject({ rule_id: "customer-meetings", event_count: 1 });
    expect(await t.all()).toHaveLength(1);
    // A note it passes moves it, asked once.
    score = 0.9;
    await t.meeting("alice@x.com", "evt12");
    const next = (await t.all()).find((task) => task.id !== prep!.id)!;
    await t.post("alice@x.com", [t.notes("doc12", "v1", "2026-11-17T11:05:00Z", t.link("evt12"), STEPS)]);
    expect(asked).toBe(2);
    expect(await t.store.task(next.id)).toMatchObject({ rule_id: "meeting-notes", workstream: "meeting follow-up", event_count: 2 });
  });

  it("hands the moved task to the follow-up workstream's agents, never one taken off it, and keeps people someone chose", async () => {
    const t = await setup("signals_meeting_task_agents", undefined, undefined, { account: { workstream_agents: { "meeting prep": [prepAgent], "meeting follow-up": [followAgent] } } });
    await t.meeting("alice@x.com", "evt13");
    const [prep] = await t.all();
    expect(((await t.store.people([prep!.id])).get(prep!.id) ?? []).map((person) => person.key)).toEqual([prepAgent]);
    await t.post("alice@x.com", [t.notes("doc13", "v1", "2026-11-17T11:05:00Z", t.link("evt13"), STEPS)]);
    const update = t.replies.filter((reply) => reply.id === prep!.id).at(-1)!;
    expect(update.agents).toEqual([followAgent]);
    expect(update.text).toContain(`nostr:${npubEncode(followAgent)}`);
    expect(update.text).not.toContain(`nostr:${npubEncode(prepAgent)}`);
    const people = (await t.store.people([prep!.id])).get(prep!.id) ?? [];
    expect(people.find((person) => person.key === followAgent)).toMatchObject({ kind: "agent", asked_at: expect.any(Number) });
    expect((await t.store.detail(prep!.id))!.activities.map((a) => a.text)).toContain(`Asked nostr:${npubEncode(followAgent)} to work on it (meeting follow-up now)`);

    // The follow-up's agent taken off this one: not asked, not put back.
    await t.meeting("alice@x.com", "evt14");
    const second = (await t.all()).find((task) => task.rule_id === "customer-meetings")!;
    await t.store.unassign(second.id, followAgent, "agent");
    await t.post("alice@x.com", [t.notes("doc14", "v1", "2026-11-17T11:05:00Z", t.link("evt14"), STEPS)]);
    expect(t.replies.filter((reply) => reply.id === second.id).at(-1)!.agents).toEqual([]);
    expect(((await t.store.people([second.id])).get(second.id) ?? []).map((person) => person.key)).toEqual([prepAgent]);

    // Someone chose who has it (an owner): they keep it, and the agents on it are asked to go on.
    await t.meeting("alice@x.com", "evt15");
    const third = (await t.all()).find((task) => task.rule_id === "customer-meetings")!;
    await t.store.assign(third.id, "person", "alice@x.com", true);
    await t.post("alice@x.com", [t.notes("doc15", "v1", "2026-11-17T11:05:00Z", t.link("evt15"), STEPS)]);
    expect(t.replies.filter((reply) => reply.id === third.id).at(-1)!.agents).toEqual([prepAgent]);
    expect(((await t.store.people([third.id])).get(third.id) ?? []).map((person) => person.key).sort()).toEqual(["alice@x.com", prepAgent].sort());
  });

  it("moves nothing for an older notes revision whose classifier finishes after a newer revision is saved", async () => {
    const hold: { during?: () => Promise<unknown> } = {};
    const t = await setup("signals_meeting_task_stale", undefined, undefined, {
      classifier: async (event) => {
        if (event.external_id !== "doc16:v1") return 0;
        // While v1 is being classified: v2 of the same doc comes in, and its classifier filters it.
        await hold.during?.();
        return 0.9;
      },
    });
    await t.meeting("alice@x.com", "evt16");
    const [prep] = await t.all();
    hold.during = () => t.post("alice@x.com", [t.notes("doc16", "v2", "2026-11-17T11:30:00Z", t.link("evt16"), STEPS)]);
    await t.post("alice@x.com", [t.notes("doc16", "v1", "2026-11-17T11:05:00Z", t.link("evt16"), STEPS)]);
    expect(await t.store.task(prep!.id)).toMatchObject({ rule_id: "customer-meetings", workstream: "meeting prep", mode: "auto", event_count: 1 });
    expect(await t.all()).toHaveLength(1);
    expect(t.replies.filter((reply) => reply.text.includes("workstream:"))).toEqual([]);
    await t.hub.sweep();
    expect(await t.store.task(prep!.id)).toMatchObject({ rule_id: "customer-meetings", event_count: 1 });
    expect(await t.all()).toHaveLength(1);
  });

  it("doesn't close a prep task the meeting's end finished in a sweep that judged it before its notes moved it", async () => {
    const t = await setup("signals_meeting_task_race");
    await t.meeting("alice@x.com", "evt17");
    const [prep] = await t.all();
    // The sweep judges the prep task done (its meeting has ended)...
    const judged = (await t.store.finishable({ version: 1, rules: RULES })).find((one) => one.task.id === prep!.id)!;
    expect(judged.reason).toContain("the meeting has ended");
    // ...the notes move it to the follow-up before the sweep writes that...
    await t.post("alice@x.com", [t.notes("doc17", "v1", "2026-11-17T11:05:00Z", t.link("evt17"), STEPS)]);
    // ...and the write leaves it open, as the follow-up it is now.
    expect(await t.store.finish(judged.task.id, judged.reason, judged.task)).toBeUndefined();
    expect(await t.store.task(prep!.id)).toMatchObject({ rule_id: "meeting-notes", status: "open" });
    expect((await t.store.detail(prep!.id))!.activities.map((a) => a.text)).not.toContain("done: the meeting has ended");
    // As judged, with nothing changed since, it still closes.
    await t.meeting("alice@x.com", "evt18");
    const other = (await t.all()).find((task) => task.rule_id === "customer-meetings")!;
    const now = (await t.store.finishable({ version: 1, rules: RULES })).find((one) => one.task.id === other.id)!;
    expect(await t.store.finish(now.task.id, now.reason, now.task)).toMatchObject({ status: "done" });
  });

  it("keeps the move's handoff when a read after it fails, in the ingest and in the sweep, and posts it once", async () => {
    let failRead = false;
    let moved = false;
    const t = await setup("signals_meeting_task_read", undefined, (text) => {
      if (text.includes("SET join_pending = $8")) moved = true;
      const read = text.startsWith("SELECT * FROM") && text.includes(".tasks WHERE id = $1");
      if (read && ((moved && !failRead) || failRead)) {
        // Once each: right after the move in the ingest, then once in the sweep when armed.
        if (failRead) failRead = false;
        else moved = false;
        return true;
      }
      return false;
    });
    await t.meeting("alice@x.com", "evt19");
    const [prep] = await t.all();
    const posted = (await t.call("alice@x.com", "/api/events", { events: [t.notes("doc19", "v1", "2026-11-17T11:05:00Z", t.link("evt19"), STEPS)] })).json as { errors: unknown[] };
    expect(posted.errors).toHaveLength(1);
    expect(t.replies.filter((reply) => reply.id === prep!.id)).toEqual([]);
    failRead = true;
    await t.hub.sweep();
    expect(t.replies.filter((reply) => reply.id === prep!.id && reply.text.includes("workstream:"))).toEqual([]);
    await t.hub.sweep();
    const handoffs = t.replies.filter((reply) => reply.id === prep!.id && reply.text.includes("- **workstream:** meeting prep → meeting follow-up"));
    expect(handoffs).toHaveLength(1);
    expect(handoffs[0]!.agents).toEqual([genie]);
    expect(await t.store.task(prep!.id)).toMatchObject({ rule_id: "meeting-notes", status: "open", event_count: 2 });
    await t.hub.sweep();
    expect(t.replies.filter((reply) => reply.id === prep!.id && reply.text.includes("workstream:"))).toHaveLength(1);
  });

  it("finishes a failed move for a meeting_task rule without action_items, from an identical repost or the sweep", async () => {
    const rules = RULES.map((rule) => (rule.id === "meeting-notes" ? { ...rule, action_items: undefined } : rule));
    let fail: string | undefined;
    const t = await setup("signals_meeting_task_plain", undefined, (text) => Boolean(fail && text.includes(fail) && !(fail = undefined)), { rules });
    // The move's statement fails: posting the same notes again finishes it.
    await t.meeting("alice@x.com", "evt20");
    const [prep] = await t.all();
    const doc = t.notes("doc20", "v1", "2026-11-17T11:05:00Z", t.link("evt20"), STEPS);
    fail = "SET join_pending = $8";
    expect(((await t.call("alice@x.com", "/api/events", { events: [doc] })).json as { errors: unknown[] }).errors).toHaveLength(1);
    expect(await t.store.task(prep!.id)).toMatchObject({ rule_id: "customer-meetings", event_count: 1 });
    await t.post("alice@x.com", [doc]);
    expect(await t.store.task(prep!.id)).toMatchObject({ rule_id: "meeting-notes", workstream: "meeting follow-up", status: "open", event_count: 2, checklist: null });
    expect(t.replies.filter((reply) => reply.id === prep!.id && reply.text.includes("- **workstream:** meeting prep → meeting follow-up"))).toHaveLength(1);
    // Its attachment fails: the sweep finishes it.
    await t.meeting("alice@x.com", "evt21");
    const second = (await t.all()).find((task) => task.rule_id === "customer-meetings")!;
    fail = "WITH lk AS (SELECT id, status, answered_us";
    expect(((await t.call("alice@x.com", "/api/events", { events: [t.notes("doc21", "v1", "2026-11-17T11:05:00Z", t.link("evt21"), STEPS)] })).json as { errors: unknown[] }).errors).toHaveLength(1);
    expect((await t.hub.sweep()).resumed).toBeGreaterThan(0);
    expect(await t.store.task(second.id)).toMatchObject({ rule_id: "meeting-notes", status: "open", event_count: 2 });
    expect(t.replies.filter((reply) => reply.id === second.id && reply.text.includes("workstream:"))).toHaveLength(1);
    // Nothing left pending for either.
    expect(await t.hub.sweep()).toMatchObject({ resumed: 0 });
    // And notes placed with no failure leave nothing pending either.
    await t.meeting("alice@x.com", "evt22");
    await t.post("alice@x.com", [t.notes("doc22", "v1", "2026-11-17T11:05:00Z", t.link("evt22"), STEPS)]);
    expect(await t.hub.sweep()).toMatchObject({ resumed: 0 });
  });

  it("opens no follow-up for an older revision of a meeting_task rule without action_items, when a newer one stopped the move", async () => {
    const rules = RULES.map((rule) => (rule.id === "meeting-notes" ? { ...rule, action_items: undefined } : rule));
    const hold: { during?: () => Promise<unknown> } = {};
    const t = await setup("signals_meeting_task_stale_plain", undefined, undefined, {
      rules,
      classifier: async (event) => {
        if (event.external_id !== "doc23:v1") return 0;
        await hold.during?.();
        return 0.9;
      },
    });
    await t.meeting("alice@x.com", "evt23");
    const [prep] = await t.all();
    hold.during = () => t.post("alice@x.com", [t.notes("doc23", "v2", "2026-11-17T11:30:00Z", t.link("evt23"), STEPS)]);
    await t.post("alice@x.com", [t.notes("doc23", "v1", "2026-11-17T11:05:00Z", t.link("evt23"), STEPS)]);
    // Neither moved nor a "Follow up:" of its own: the newest revision's decision stands.
    expect(await t.store.task(prep!.id)).toMatchObject({ rule_id: "customer-meetings", event_count: 1 });
    expect(await t.all()).toHaveLength(1);
    await t.hub.sweep();
    expect(await t.all()).toHaveLength(1);
    expect(t.replies.filter((reply) => reply.text.includes("workstream:"))).toEqual([]);
  });

  it("keeps the move's handoff when the hub can't build or post its update, and posts it once from the next sweep", async () => {
    const handoffs = (t: Awaited<ReturnType<typeof setup>>, id: number) => t.replies.filter((reply) => reply.id === id && reply.text.includes("- **workstream:** meeting prep → meeting follow-up"));
    // A task read fails right after the store took the move to report: the Hub's own read (no action items: nothing else
    // is read), or the store's read of the tasks the notes opened (with action items).
    for (const [schema, rules] of [["signals_meeting_task_hub_read", RULES.map((rule) => (rule.id === "meeting-notes" ? { ...rule, action_items: undefined } : rule))], ["signals_meeting_task_hub_read_items", RULES]] as const) {
      let armed = false;
      let claimed = false;
      const t = await setup(schema, undefined, (text) => {
        // (The statement that takes the move to report, or one that clears its mark.)
        if (armed && (text.includes("SET join_claimed_at = $2") || text.includes("SET join_pending = NULL"))) claimed = true;
        if (claimed && text.startsWith("SELECT * FROM") && text.includes(".tasks WHERE id = $1")) {
          armed = claimed = false;
          return true;
        }
        return false;
      }, { rules });
      await t.meeting("alice@x.com", "evt24");
      const [prep] = await t.all();
      armed = true;
      // (The post's request fails with it: the notes are saved and attached.)
      await t.call("alice@x.com", "/api/events", { events: [t.notes("doc24", "v1", "2026-11-17T11:05:00Z", t.link("evt24"), STEPS)] }).catch(() => undefined);
      expect(armed).toBe(false);
      expect(await t.store.task(prep!.id)).toMatchObject({ rule_id: "meeting-notes", event_count: 2 });
      expect(handoffs(t, prep!.id)).toEqual([]);
      expect((await t.hub.sweep()).resumed).toBeGreaterThan(0);
      expect(handoffs(t, prep!.id)).toHaveLength(1);
      expect(handoffs(t, prep!.id)[0]!.agents).toEqual([genie]);
      await t.hub.sweep();
      expect(handoffs(t, prep!.id)).toHaveLength(1);
    }
    // Its post fails (the relay is down): the next sweep posts it, once.
    let down = true;
    const t = await setup("signals_meeting_task_hub_post", undefined, undefined, { failPost: (text) => down && text.includes("workstream:") && !(down = false) });
    await t.meeting("alice@x.com", "evt25");
    const [prep] = await t.all();
    await t.post("alice@x.com", [t.notes("doc25", "v1", "2026-11-17T11:05:00Z", t.link("evt25"), STEPS)]);
    expect(down).toBe(false);
    expect(handoffs(t, prep!.id)).toEqual([]);
    await t.hub.sweep();
    expect(handoffs(t, prep!.id)).toHaveLength(1);
    await t.hub.sweep();
    expect(handoffs(t, prep!.id)).toHaveLength(1);
  });

  it("never lets a post whose lease passed clear or release the claim a later sweep took", async () => {
    const gate = () => {
      let resolve!: () => void;
      const promise = new Promise<void>((done) => (resolve = done));
      return { promise, resolve };
    };
    const gates = [gate(), gate()];
    let posts = 0;
    const t = await setup("signals_meeting_task_claims", undefined, undefined, {
      onPost: async (text) => {
        if (!text.includes("workstream:")) return;
        const held = gates[posts++];
        if (!held) return;
        await held.promise;
        if (held === gates[0]) throw new Error("relay down");
      },
    });
    const until = async (check: () => boolean) => {
      for (let i = 0; i < 200 && !check(); i++) await new Promise((resolve) => setTimeout(resolve, 5));
      expect(check()).toBe(true);
    };
    await t.meeting("alice@x.com", "evt26");
    const [prep] = await t.all();
    // The ingest's handoff post hangs, long enough for its lease to pass...
    const first = t.post("alice@x.com", [t.notes("doc26", "v1", "2026-11-17T11:05:00Z", t.link("evt26"), STEPS)]);
    await until(() => posts === 1);
    await t.pg.query(`UPDATE signals_meeting_task_claims.events SET join_claimed_at = join_claimed_at - 601 WHERE join_pending IS NOT NULL`);
    // ...so a sweep takes the move and starts its own post...
    const second = t.hub.sweep();
    await until(() => posts === 2);
    // ...and then the first post fails: its cleanup leaves the sweep's claim alone, so another sweep doesn't post it too.
    gates[0]!.resolve();
    await first;
    await t.hub.sweep();
    expect(posts).toBe(2);
    gates[1]!.resolve();
    await second;
    await t.hub.sweep();
    expect(posts).toBe(2);
    expect(t.replies.filter((reply) => reply.id === prep!.id && reply.text.includes("workstream:"))).toHaveLength(1);
    expect((await t.pg.query(`SELECT count(*)::int AS n FROM signals_meeting_task_claims.events WHERE join_pending IS NOT NULL`)).rows[0]).toEqual({ n: 0 });
  });

  it("posts a retried handoff with the checklist the notes saved, and records its change once", async () => {
    let down = true;
    const t = await setup("signals_meeting_task_retry_list", undefined, undefined, { failPost: (text) => down && text.includes("workstream:") && !(down = false) });
    await t.meeting("alice@x.com", "evt27");
    const [prep] = await t.all();
    await t.post("alice@x.com", [t.notes("doc27", "v1", "2026-11-17T11:05:00Z", t.link("evt27"), STEPS)]);
    expect(down).toBe(false);
    const item = (await t.all()).find((task) => task.title.startsWith("Action:"))!;
    await t.hub.sweep();
    const handoffs = t.replies.filter((reply) => reply.id === prep!.id && reply.text.includes("- **workstream:** meeting prep → meeting follow-up"));
    expect(handoffs).toHaveLength(1);
    expect(handoffs[0]!.agents).toEqual([genie]);
    expect(handoffs[0]!.text).toContain("**Action items from the notes for this follow-up**");
    expect(handoffs[0]!.text).toContain("Share last quarter's usage export. (the customer's)");
    expect(handoffs[0]!.text).toContain(`- Task ${item.id}: [Ann Lee] Send pricing`);
    const changed = (await t.store.detail(prep!.id))!.activities.filter((a) => a.kind === "changed");
    expect(changed.map((a) => a.text)).toEqual(["workstream: meeting prep → meeting follow-up"]);
  });

  it("posts a retried handoff with the watched fields' changes too, and records the move's change once whatever the retry says", async () => {
    // The notes rule watches the title: the move's update says the title changed (the meeting's → the notes'), as well as the workstream.
    const rules = RULES.map((rule) => (rule.id === "meeting-notes" ? { ...rule, watch: ["title"] } : rule));
    const both = ["workstream: meeting prep → meeting follow-up", "title: Globex QBR → Globex QBR - 2026/11/17 - Notes by Gemini"];
    const lines = ["- **workstream:** meeting prep → meeting follow-up", "- **title:** Globex QBR → Globex QBR - 2026/11/17 - Notes by Gemini"];
    // Its first post fails (the relay is down), after its `changed` activity: the next sweep posts the same handoff.
    let down = true;
    const t = await setup("signals_meeting_task_retry_watch", undefined, undefined, { rules, failPost: (text) => down && text.includes("workstream:") && !(down = false) });
    await t.meeting("alice@x.com", "evt28");
    const [prep] = await t.all();
    await t.post("alice@x.com", [t.notes("doc28", "v1", "2026-11-17T11:05:00Z", t.link("evt28"), STEPS)]);
    expect(down).toBe(false);
    await t.hub.sweep();
    const handoffs = t.replies.filter((reply) => reply.id === prep!.id && reply.text.includes(lines[0]!));
    expect(handoffs).toHaveLength(1);
    for (const line of lines) expect(handoffs[0]!.text).toContain(line);
    expect(handoffs[0]!.agents).toEqual([genie]);
    expect((await t.store.detail(prep!.id))!.activities.filter((a) => a.kind === "changed").map((a) => a.text)).toEqual([both.join("; ")]);
    await t.hub.sweep();
    expect(t.replies.filter((reply) => reply.id === prep!.id && reply.text.includes(lines[0]!))).toHaveLength(1);
    // The notes' attachment fails (nothing moves in the ingest): the sweep's move says the title changed too.
    let failing = false;
    const s = await setup("signals_meeting_task_sweep_watch", undefined, (text) => failing && text.includes("WITH lk AS (SELECT id, status, answered_us") && !(failing = false), { rules });
    await s.meeting("alice@x.com", "evt29");
    const [prep2] = await s.all();
    failing = true;
    await s.post("alice@x.com", [s.notes("doc29", "v1", "2026-11-17T11:05:00Z", s.link("evt29"), STEPS)]);
    await s.hub.sweep();
    const moved = s.replies.filter((reply) => reply.id === prep2!.id && reply.text.includes(lines[0]!));
    expect(moved).toHaveLength(1);
    for (const line of lines) expect(moved[0]!.text).toContain(line);
    expect((await s.store.detail(prep2!.id))!.activities.filter((a) => a.kind === "changed").map((a) => a.text)).toEqual([both.join("; ")]);
  });

  it("records a move's change once even when a retry's changes read differently", async () => {
    const t = await setup("signals_meeting_task_activity_ref");
    await t.meeting("alice@x.com", "evt30");
    const [prep] = await t.all();
    await t.store.activity(prep!.id, "hub", "changed", "workstream: meeting prep → meeting follow-up; title: a → b", "move:1:2");
    await t.store.activity(prep!.id, "hub", "changed", "workstream: meeting prep → meeting follow-up", "move:1:2");
    await t.store.activity(prep!.id, "hub", "changed", "workstream: meeting prep → meeting follow-up", "move:3:4");
    await t.store.activity(prep!.id, "hub", "changed", "title: c → d");
    await t.store.activity(prep!.id, "hub", "changed", "title: c → d");
    expect((await t.store.detail(prep!.id))!.activities.filter((a) => a.kind === "changed").map((a) => a.text)).toEqual([
      "workstream: meeting prep → meeting follow-up; title: a → b",
      "workstream: meeting prep → meeting follow-up",
      "title: c → d",
      "title: c → d",
    ]);
  });

  it("checks a rule's meeting_task setting", () => {
    expect(configProblems({ version: 1, rules: RULES })).toEqual([]);
    const notes = RULES[1]!;
    expect(configProblems({ version: 1, rules: [RULES[0], { ...notes, meeting_task: { rule: "nope" } }] })).toEqual(["rules[1].meeting_task.rule nope isn't a task rule here"]);
    expect(configProblems({ version: 1, rules: [RULES[0], { ...notes, meeting_task: { rule: "meeting-notes" } }] })).toEqual(["rules[1].meeting_task names another rule, the one whose task the meeting has"]);
    expect(configProblems({ version: 1, rules: [RULES[0], { ...notes, meeting_task: { rule: "customer-meetings", other: 1 } }] })).toHaveLength(1);
    expect(configProblems({ version: 1, rules: [RULES[0], { ...notes, action: "ignore" }] })).toContain("rules[1].meeting_task needs action task");
    expect(configProblems({ version: 1, rules: [RULES[0], { id: "f", action: "task", fan_out: "accounts", meeting_task: { rule: "customer-meetings" } }] })).toContain("rules[1].fan_out is about every account, so it takes no meeting_task");
  });
});
