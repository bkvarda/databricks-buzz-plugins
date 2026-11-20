// Signals: action items in a meeting's notes (Gemini's "Next steps") and whose they are.
import { describe, expect, it } from "vitest";
import { MAX_ACTION_ITEMS, parseNextSteps, sideOf, sideOfName } from "../plugins/signals/app/actions";

// A synthetic Gemini notes doc, as the poller keeps it (Summary through Next steps; soft breaks as \v).
const NOTES = [
  "Summary",
  "Globex wants the pricing revised before the Q1 renewal.\u000bBilling pushed back on the commit.",
  "",
  "Next steps",
  "[Ann Lee] Send pricing: Send the revised pricing sheet to Globex by Friday.",
  "[Jane Doe] Share usage data: Share last quarter's usage export with the account team.",
  "[Ann Lee, Jane Doe] Schedule workshop: Agree a date for the governance workshop.",
  "[The group] Review options: Review the three migration options.",
  "Follow up on the SSO ticket.",
  "Details",
  "[Bob Ray] Not an item: this is in Details.",
].join("\n");

const people = {
  ours: [{ email: "ann.lee@x.com", name: "Ann Lee" }, { email: "bob.ray@x.com" }],
  customers: [{ email: "jane.doe@globex.io", name: "Jane Doe" }, { email: "mike@globex.io" }],
  account: ["Globex", "Globex Corp"],
};

describe("meeting notes action items", () => {
  it("reads each Next steps line as owners, title and text, and stops at the next heading", () => {
    expect(parseNextSteps(NOTES)).toEqual([
      { owners: ["Ann Lee"], title: "Send pricing", text: "Send the revised pricing sheet to Globex by Friday." },
      { owners: ["Jane Doe"], title: "Share usage data", text: "Share last quarter's usage export with the account team." },
      { owners: ["Ann Lee", "Jane Doe"], title: "Schedule workshop", text: "Agree a date for the governance workshop." },
      { owners: ["The group"], title: "Review options", text: "Review the three migration options." },
      { owners: [], text: "Follow up on the SSO ticket." },
    ]);
  });

  it("tells account-team items from the customer's, and shared or unknown ones", () => {
    const sides = parseNextSteps(NOTES).map((item) => sideOf(item, people));
    expect(sides).toEqual(["ours", "customer", "both", "unknown", "unknown"]);
  });

  it("matches a name by display name, address, a lone first name, or the account's name", () => {
    expect(sideOfName("bob ray", people)).toBe("ours");
    expect(sideOfName("Mike", people)).toBe("customer");
    expect(sideOfName("Globex team", people)).toBe("customer");
    expect(sideOfName("Ann", people)).toBe("ours");
    expect(sideOfName("Carol Smith", people)).toBe("unknown");
    // A first name from their address when their display name differs.
    expect(sideOfName("Beth", { ours: [{ name: "Elizabeth Smith", email: "beth.smith@example.org" }], customers: [] })).toBe("ours");
    expect(sideOfName("Elizabeth", { ours: [{ name: "Elizabeth Smith", email: "beth.smith@example.org" }], customers: [] })).toBe("ours");
    // …and still not guessed when it's someone's on each side.
    expect(sideOfName("Beth", { ours: [{ name: "Elizabeth Smith", email: "beth.smith@x.com" }], customers: [{ name: "Beth Ng" }] })).toBe("unknown");
    // The account's name as whole words only.
    const block = { ours: [], customers: [], account: ["Block", "Block Inc"] };
    expect(sideOfName("Block team", block)).toBe("customer");
    expect(sideOfName("the Block Inc. data team", block)).toBe("customer");
    expect(sideOfName("Blockchain team", block)).toBe("unknown");
    expect(sideOfName("Unblocked team", block)).toBe("unknown");
    // On both sides (a colleague and a customer with the same first name): not guessed.
    expect(sideOfName("Sam", { ours: [{ name: "Sam Colleague", email: "sam@x.com" }], customers: [{ email: "sam.jones@globex.io" }] })).toBe("unknown");
  });

  it("takes bullets, soft breaks, numbered lines and the 'Suggested next steps:' heading", () => {
    const notes = "Suggested next steps:\u000b- [Ann Lee] Send pricing: by Friday.\u000b2. [Jane Doe] Confirm budget\u000b• Meet again at 10:30: Tuesday";
    expect(parseNextSteps(notes)).toEqual([
      { owners: ["Ann Lee"], title: "Send pricing", text: "by Friday." },
      { owners: ["Jane Doe"], text: "Confirm budget" },
      // A time isn't a title.
      { owners: [], text: "Meet again at 10:30: Tuesday" },
    ]);
  });

  it("keeps a sentence, a time or a link before a colon in the text, not as a title, and keeps numbered titles", () => {
    expect(parseNextSteps("Next steps\n[Ann] Check the docs at https://docs.example.com: they changed.\n[Ann] We agreed. Next: send it.")).toEqual([
      { owners: ["Ann"], text: "Check the docs at https://docs.example.com: they changed." },
      { owners: ["Ann"], text: "We agreed. Next: send it." },
    ]);
    // A title may end in a number.
    expect(parseNextSteps("Next steps\n[Ann Lee] Phase 2: Send the revised plan.\n[Ann] Call at 10: Tuesday works.")).toEqual([
      { owners: ["Ann Lee"], title: "Phase 2", text: "Send the revised plan." },
      { owners: ["Ann"], title: "Call at 10", text: "Tuesday works." },
    ]);
  });

  it("has no items without a Next steps heading, or with an empty one, or for anything but text", () => {
    expect(parseNextSteps("Summary\n[Ann] Send pricing: soon.")).toEqual([]);
    expect(parseNextSteps("Summary\nx\nNext steps\n\nDetails\n[Ann] y: z")).toEqual([]);
    expect(parseNextSteps(null)).toEqual([]);
    expect(parseNextSteps({ notes: "Next steps\n[Ann] a: b" })).toEqual([]);
    // A bracket with no task in it isn't an item.
    expect(parseNextSteps("Next steps\n[Ann Lee]\n[Ann Lee] Real: one")).toEqual([{ owners: ["Ann Lee"], title: "Real", text: "one" }]);
  });

  it("keeps at most MAX_ACTION_ITEMS items, each clipped", () => {
    const notes = `Next steps\n${Array.from({ length: MAX_ACTION_ITEMS + 5 }, (_, i) => `[Ann] Item ${i}: ${"x".repeat(i === 0 ? 900 : 3)}`).join("\n")}`;
    const items = parseNextSteps(notes);
    expect(items).toHaveLength(MAX_ACTION_ITEMS);
    expect(items[0]!.text).toHaveLength(500);
    expect(items[0]!.text.endsWith("…")).toBe(true);
  });
});

describe("meeting notes action items in ingest", () => {
  it("opens a task per account-team item (deduped across doc versions), assigns only one-attendee names, and lists the rest on the follow-up", async () => {
    const { PGlite } = await import("@electric-sql/pglite");
    const { SignalsStore } = await import("../plugins/signals/app/store");
    const { Hub } = await import("../plugins/signals/app/hub");
    const pg = new PGlite();
    const db = { query: async (text: string, values?: unknown[]) => (await pg.query(text, values as unknown[])) as { rows: never[] } };
    const store = new SignalsStore(db, "signals_action_items");
    await store.setup();
    const opened: { id: number; text: string }[] = [];
    const updates: { id: number; text: string }[] = [];
    const { taskMessage } = await import("../plugins/signals/app/hub");
    const hub = new Hub(store, {
      opened: async (task, agents, context) => (opened.push({ id: task.id, text: taskMessage(task, { agents, ...context }) }), `root-${task.id}`),
      updated: async (task, text) => void updates.push({ id: task.id, text }),
    }, { defaultConfig: { version: 1, default_channel: "chan", rules: [
      { id: "meeting-notes", sources: ["google_drive"], when: { title: "Notes by Gemini" }, account_named_in: "title", action: "task", title: "Follow up: {title}", workstream: "meeting follow-up", group_by: "group_key", action_items: {} },
    ], accounts: [{ name: "Globex", aliases: ["Globex Corp"], domains: ["globex.io"] }] } });
    const call = (method: string, path: string, body?: unknown) => hub.handle({ method, path, query: new URLSearchParams(), user: "alice@x.com", body: async () => (body === undefined ? "" : JSON.stringify(body)) });
    for (const source of ["google_drive", "google_calendar"]) {
      await call("POST", "/api/sources", { source, enabled: true });
      await call("POST", "/api/events", { events: [{ source, external_id: `seed-${source}` }] });
    }
    // The meeting, as the calendar source keeps it: two Sams on the account team, Jane at Globex.
    await call("POST", "/api/events", { events: [{ source: "google_calendar", external_id: "evt1_20261117T100000Z", title: "Globex QBR", payload: { attendees: [
      { email: "alice@x.com", displayName: "Alice Wu" }, { email: "ann.lee@x.com", displayName: "Ann Lee" },
      { email: "sam.colleague@x.com", displayName: "Sam Colleague" }, { email: "sam.ortiz@x.com", displayName: "Sam Ortiz" },
      { email: "jane.doe@globex.io", displayName: "Jane Doe" },
    ] } }] });
    const eid = Buffer.from("evt1_20261117T100000Z alice@x.com").toString("base64url");
    const meeting = `https://calendar.google.com/calendar/event?eid=${eid}`;
    const notes = (steps: string[]) => ["Summary", "Pricing and usage.", "Next steps", ...steps, "Details"].join("\n");
    const doc = { source: "google_drive", group_key: "d1", title: "Globex QBR - Notes by Gemini" };
    const v1 = [
      "[Ann Lee] Send pricing: Send the revised pricing sheet to Jane.",
      "[Ann Lee] Send pricing: Send the partner pricing to procurement.",
      "[Sam] Book workshop: Find a date for the governance workshop.",
      "[Jane Doe] Share usage: Share last quarter's usage export.",
      "Follow up on the SSO ticket.",
    ];
    const first = (await call("POST", "/api/events", { events: [{ ...doc, external_id: "d1:v1", payload: { notes: notes(v1), meeting } }] })).json as { created: number[] };
    const tasks = await Promise.all(first.created.map((id) => store.task(id)));
    const followUp = tasks.find((task) => task!.rule_id === "meeting-notes")!;
    const actions = tasks.filter((task) => task!.rule_id === "meeting-notes/action-item").map((task) => task!);
    // Both "Send pricing" items (one title, different text) and Sam's: three tasks, under their own workstream.
    expect(actions.map((task) => task.title)).toEqual([
      "Action: Send pricing: Send the revised pricing sheet to Jane.",
      "Action: Send pricing: Send the partner pricing to procurement.",
      "Action: Book workshop: Find a date for the governance workshop.",
    ]);
    expect(actions.every((task) => task.workstream === "meeting action items" && task.account === "Globex" && task.channel === "chan")).toBe(true);
    const people = await store.people(actions.map((task) => task.id));
    expect(people.get(actions[0]!.id)).toMatchObject([{ kind: "person", key: "ann.lee@x.com" }]);
    expect(people.get(actions[1]!.id)).toMatchObject([{ kind: "person", key: "ann.lee@x.com" }]);
    // "Sam" is two attendees: not guessed.
    expect(people.get(actions[2]!.id) ?? []).toEqual([]);
    expect((await store.detail(actions[2]!.id))!.activities.map((a) => a.text)).toContain('Not assigned: "Sam" could be sam.colleague@x.com or sam.ortiz@x.com.');
    // The customer's item and the unclear one are the follow-up's checklist, with the team's tasks listed.
    const post = opened.find((one) => one.id === followUp!.id)!.text;
    expect(post).toContain("- [ ] [Jane Doe] Share usage: Share last quarter's usage export. (the customer's)");
    expect(post).toContain("- [ ] Follow up on the SSO ticket. (owner not clear)");
    expect(post).toContain(`- Task ${actions[2]!.id}: [Sam] Book workshop: Find a date for the governance workshop.`);
    expect(opened.map((one) => one.id).sort()).toEqual(first.created.slice().sort());

    // The next version: one pricing item repeated, one new. The repeat reuses its task.
    const v2 = [v1[0]!, "[Ann Lee] Send deck: Send the QBR deck to Jane.", v1[3]!];
    const second = (await call("POST", "/api/events", { events: [{ ...doc, external_id: "d1:v2", payload: { notes: notes(v2), meeting } }] })).json as { created: number[]; updated: number[] };
    expect(second.created).toHaveLength(1);
    expect((await store.task(second.created[0]!))!.title).toBe("Action: Send deck: Send the QBR deck to Jane.");
    expect((await store.tasks({ workstream: "meeting action items" })).length).toBe(4);
    expect(second.updated).toEqual([followUp!.id]);
    const update = updates.find((one) => one.id === followUp!.id)!.text;
    expect(update).toContain(`- Task ${actions[0]!.id}: [Ann Lee] Send pricing: Send the revised pricing sheet to Jane.`);
    expect(update).not.toContain("SSO ticket");
    // The same post again: nothing new.
    expect((await call("POST", "/api/events", { events: [{ ...doc, external_id: "d1:v2", payload: { notes: notes(v2), meeting } }] })).json).toMatchObject({ same: 1, created: [] });
  });

  it("checks a rule's action_items setting", async () => {
    const { configProblems } = await import("../plugins/signals/app/model");
    expect(configProblems({ version: 1, rules: [{ id: "n", action: "task", action_items: { workstream: "x" } }] })).toEqual([]);
    expect(configProblems({ version: 1, rules: [{ id: "n", action: "task", action_items: { other: 1 } }] })).toHaveLength(1);
    expect(configProblems({ version: 1, rules: [{ id: "n", action: "ignore", action_items: {} }] })).toEqual(["rules[0].action_items needs action task"]);
  });

  it("reads the calendar event id from a meeting link, and keys items by title and text", async () => {
    const { calendarEventId, itemKey } = await import("../plugins/signals/app/actions");
    expect(calendarEventId(`https://calendar.google.com/calendar/event?eid=${Buffer.from("abc_20261117T100000Z me@x.com").toString("base64url")}`)).toBe("abc_20261117T100000Z");
    expect(calendarEventId("https://calendar.google.com/calendar/event?x=1")).toBeUndefined();
    expect(calendarEventId(3)).toBeUndefined();
    expect(itemKey({ owners: [], title: "Send pricing", text: "A." })).not.toBe(itemKey({ owners: [], title: "Send pricing", text: "B." }));
    expect(itemKey({ owners: ["Ann"], title: "Send  Pricing", text: "A." })).toBe(itemKey({ owners: [], title: "send pricing", text: "a" }));
  });
});

describe("meeting notes action items: consent, retries and revisions", () => {
  const setup = async (schema: string, fail?: (text: string, values?: unknown[]) => boolean | Promise<void>, options: { classifier?: () => Promise<number | undefined>; seed?: boolean; firstRunSeen?: boolean } = {}) => {
    const { PGlite } = await import("@electric-sql/pglite");
    const { SignalsStore } = await import("../plugins/signals/app/store");
    const { Hub } = await import("../plugins/signals/app/hub");
    const pg = new PGlite();
    const db = { query: async (text: string, values?: unknown[]) => {
      const failing = await fail?.(text, values);
      if (failing === true) throw new Error("write failed");
      return (await pg.query(text, values as unknown[])) as { rows: never[] };
    } };
    const store = new SignalsStore(db, schema);
    await store.setup();
    const updates: { id: number; text: string }[] = [];
    const hub = new Hub(store, { opened: async (task) => `root-${task.id}`, updated: async (task, text) => void updates.push({ id: task.id, text }) }, { ...(options.classifier && { classifier: options.classifier }), defaultConfig: { version: 1, default_channel: "chan", ...(options.firstRunSeen !== undefined && { first_run_seen: options.firstRunSeen }), rules: [
      { id: "meeting-notes", sources: ["google_drive"], when: { title: "Notes by Gemini" }, account_named_in: "title", action: "task", title: "Follow up: {title}", group_by: "group_key", action_items: {}, ...(options.classifier && { classify: { question: "Worth a follow-up?", min: 0.5 } }) },
    ], accounts: [{ name: "Globex", domains: ["globex.io"] }] } });
    const call = (user: string, body: unknown) => hub.handle({ method: "POST", path: "/api/events", query: new URLSearchParams(), user, body: async () => JSON.stringify(body) });
    const on = (user: string, source: string) => hub.handle({ method: "POST", path: "/api/sources", query: new URLSearchParams(), user, body: async () => JSON.stringify({ source, enabled: true }) });
    for (const user of ["alice@x.com", "bob@x.com"]) for (const source of ["google_drive", "google_calendar"]) {
      await on(user, source);
      if (options.seed !== false || source !== "google_drive") await call(user, { events: [{ source, external_id: `seed-${source}` }] });
    }
    const calendar = (user: string) => call(user, { events: [{ source: "google_calendar", external_id: "evt1", title: "Globex QBR", payload: { attendees: [
      { email: user, displayName: user === "alice@x.com" ? "Alice Wu" : "Bob Ray" }, { email: "ann.lee@x.com", displayName: "Ann Lee" }, { email: "jane.doe@globex.io", displayName: "Jane Doe" },
    ] } }] });
    const meeting = `https://calendar.google.com/calendar/event?eid=${Buffer.from("evt1 x@x.com").toString("base64url")}`;
    const notes = (steps: string[]) => ["Summary", "Pricing.", "Next steps", ...steps, "Details"].join("\n");
    const doc = (version: string, at: string, steps: string[] | null) => ({ source: "google_drive", group_key: "d1", title: "Globex QBR - Notes by Gemini", external_id: `d1:${version}`, occurred_at: at, payload: { notes: steps && notes(steps), meeting } });
    const owners = async (id: number) => ((await store.people([id])).get(id) ?? []).filter((p) => p.assigned_at).map((p) => p.key);
    const actions = async () => (await store.tasks({})).filter((t) => t.rule_id === "meeting-notes/action-item").sort((a, b) => a.id - b.id);
    const followUp = async () => (await store.tasks({})).find((t) => t.rule_id === "meeting-notes")!;
    return { store, call, on, calendar, doc, owners, actions, followUp, updates, hub, pg };
  };

  it("uses only the poster's own calendar copy, from a calendar source they have on", async () => {
    const t = await setup("signals_items_consent");
    // Bob's calendar has the meeting; Alice's doesn't. Alice's notes don't learn who Ann is from Bob's calendar.
    await t.calendar("bob@x.com");
    await t.call("alice@x.com", { events: [t.doc("v1", "2026-11-17T10:00:00Z", ["[Ann Lee] Send pricing: Send the sheet."])] });
    expect(await t.actions()).toEqual([]);
    expect((await t.followUp()).checklist).toContain("[Ann Lee] Send pricing: Send the sheet. (owner not clear)");
    // Alice's own copy, but her calendar source turned off: not used either.
    const s = await setup("signals_items_consent_off");
    await s.calendar("alice@x.com");
    await s.hub.handle({ method: "POST", path: "/api/sources", query: new URLSearchParams(), user: "alice@x.com", body: async () => JSON.stringify({ source: "google_calendar", enabled: false }) });
    await s.call("alice@x.com", { events: [s.doc("v1", "2026-11-17T10:00:00Z", ["[Ann Lee] Send pricing: Send the sheet."])] });
    expect(await s.actions()).toEqual([]);
    // Her own copy with the source on: Ann's task, hers.
    const o = await setup("signals_items_consent_own");
    await o.calendar("alice@x.com");
    await o.call("alice@x.com", { events: [o.doc("v1", "2026-11-17T10:00:00Z", ["[Ann Lee] Send pricing: Send the sheet."])] });
    const [task] = await o.actions();
    expect(await o.owners(task!.id)).toEqual(["ann.lee@x.com"]);
  });

  it("finishes action items a failed write cut short when the same notes are posted again", async () => {
    let writes = 0;
    let failing = true;
    const t = await setup("signals_items_retry", (text) => text.includes("own AS (INSERT") && ++writes === 2 && failing);
    await t.calendar("alice@x.com");
    const event = t.doc("v1", "2026-11-17T10:00:00Z", ["[Ann Lee] Send pricing: Send the sheet.", "[Ann Lee] Send deck: Send the deck."]);
    const first = (await t.call("alice@x.com", { events: [event] })).json as { errors: unknown[] };
    expect(first.errors).toHaveLength(1);
    // The first item's task is whole (its owner written with it); the second wasn't written at all.
    let tasks = await t.actions();
    expect(tasks).toHaveLength(1);
    expect(await t.owners(tasks[0]!.id)).toEqual(["ann.lee@x.com"]);
    failing = false;
    const again = (await t.call("alice@x.com", { events: [event] })).json as { same: number; created: number[] };
    expect(again.same).toBe(1);
    tasks = await t.actions();
    expect(tasks.map((task) => task.title)).toEqual(["Action: Send pricing: Send the sheet.", "Action: Send deck: Send the deck."]);
    expect(again.created).toEqual([tasks[1]!.id]);
    for (const task of tasks) expect(await t.owners(task.id)).toEqual(["ann.lee@x.com"]);
    expect((await t.followUp()).checklist).toContain(`- Task ${tasks[1]!.id}: [Ann Lee] Send deck: Send the deck.`);
    // Once done, a third identical post changes nothing.
    expect((await t.call("alice@x.com", { events: [event] })).json).toMatchObject({ same: 1, created: [] });
    expect(await t.actions()).toHaveLength(2);
  });

  it("orders checklist writes by the notes' revision time, clears it for a newer revision with no items, and keeps it for unread notes", async () => {
    const t = await setup("signals_items_revisions");
    await t.calendar("alice@x.com");
    await t.call("alice@x.com", { events: [t.doc("v2", "2026-11-17T12:00:00Z", ["[Jane Doe] Share usage: Share the export."])] });
    expect((await t.followUp()).checklist).toContain("Share usage");
    // An older revision read late: no change, no update line.
    t.updates.length = 0;
    await t.call("alice@x.com", { events: [t.doc("v1", "2026-11-17T11:00:00Z", ["[Jane Doe] Old item: Something older."])] });
    expect((await t.followUp()).checklist).toContain("Share usage");
    expect((await t.followUp()).checklist).not.toContain("Old item");
    expect(t.updates.some((u) => u.text.includes("Old item"))).toBe(false);
    // A newer revision that couldn't be read (no notes): kept.
    await t.call("alice@x.com", { events: [t.doc("v3", "2026-11-17T13:00:00Z", null)] });
    expect((await t.followUp()).checklist).toContain("Share usage");
    // A newer revision whose Next steps is empty: cleared, and the update says so.
    t.updates.length = 0;
    await t.call("alice@x.com", { events: [t.doc("v4", "2026-11-17T14:00:00Z", [])] });
    const follow = await t.followUp();
    expect(follow.checklist).toBeNull();
    expect(t.updates.find((u) => u.id === follow.id)!.text).toContain("The notes list no action items now, so the checklist is cleared.");
    // …and an older revision after that still changes nothing.
    await t.call("alice@x.com", { events: [t.doc("v1b", "2026-11-17T12:30:00Z", ["[Jane Doe] Share usage: Share the export."])] });
    expect((await t.followUp()).checklist).toBeNull();
  });

  it("finishes action items a failed write cut short on the next sweep, after a drain from the inbox and no repost", async () => {
    let writes = 0;
    const t = await setup("signals_items_sweep", (text) => text.includes("own AS (INSERT") && ++writes === 2);
    await t.calendar("alice@x.com");
    const event = t.doc("v1", "2026-11-17T10:00:00Z", ["[Ann Lee] Send pricing: Send the sheet.", "[Ann Lee] Send deck: Send the deck."]);
    // The poller's post and its cursor, through the inbox.
    await t.pg.query(`INSERT INTO signals_items_sweep.inbox (owner, kind, body) VALUES ('alice@x.com', 'events', $1), ('alice@x.com', 'cursor', $2)`, [JSON.stringify({ events: [event] }), JSON.stringify({ source: "google_drive", cursor: "c1" })]);
    expect(await t.hub.drain()).toEqual({ handled: 2, failed: 0 });
    expect(await t.actions()).toHaveLength(1);
    // Nothing is posted again: the sweep writes the second item from the saved event, and posts it.
    t.updates.length = 0;
    expect(await t.hub.sweep()).toMatchObject({ resumed: 2 });
    const tasks = await t.actions();
    expect(tasks.map((task) => task.title)).toEqual(["Action: Send pricing: Send the sheet.", "Action: Send deck: Send the deck."]);
    for (const task of tasks) expect(await t.owners(task.id)).toEqual(["ann.lee@x.com"]);
    expect(tasks[1]!.buzz_root).toBe(`root-${tasks[1]!.id}`);
    const follow = await t.followUp();
    expect(follow.checklist).toContain(`- Task ${tasks[1]!.id}: [Ann Lee] Send deck: Send the deck.`);
    expect(t.updates.find((u) => u.id === follow.id)!.text).toContain("Send deck");
    // Done now: the next sweep has nothing to do, and a drain of nothing changes nothing.
    expect(await t.hub.sweep()).toMatchObject({ resumed: 0 });
    expect(await t.hub.drain()).toEqual({ handled: 0, failed: 0 });
    expect(await t.actions()).toHaveLength(2);
  });

  it("keeps a failing item pending for the next sweep, and drops it when a newer revision has the follow-up", async () => {
    let failing = true;
    const t = await setup("signals_items_sweep_newer", (text) => failing && text.includes("own AS (INSERT"));
    await t.calendar("alice@x.com");
    await t.call("alice@x.com", { events: [t.doc("v1", "2026-11-17T10:00:00Z", ["[Ann Lee] Send pricing: Send the sheet."])] });
    expect(await t.hub.sweep()).toMatchObject({ resumed: 0 });
    expect((await t.pg.query(`SELECT count(*)::int AS n FROM signals_items_sweep_newer.events WHERE items_pending IS NOT NULL`)).rows).toEqual([{ n: 1 }]);
    failing = false;
    // A newer revision without the item comes first: the old one's item never opens.
    await t.call("alice@x.com", { events: [t.doc("v2", "2026-11-17T11:00:00Z", [])] });
    expect(await t.hub.sweep()).toMatchObject({ resumed: 0 });
    expect(await t.actions()).toEqual([]);
    expect((await t.followUp()).checklist).toBeNull();
    expect((await t.pg.query(`SELECT count(*)::int AS n FROM signals_items_sweep_newer.events WHERE items_pending IS NOT NULL`)).rows).toEqual([{ n: 0 }]);
  });

  it("opens nothing for an older revision paused before its action insert while a newer empty one is applied", async () => {
    let release!: () => void;
    let paused!: () => void;
    const reached = new Promise<void>((resolve) => (paused = resolve));
    const gate = new Promise<void>((resolve) => (release = resolve));
    const t = await setup("signals_items_paused", async (text, values) => {
      // The older revision's (v1) action insert waits; nothing else does.
      if (text.includes("own AS (INSERT") && String(values?.[2]).includes("Old item")) {
        paused();
        await gate;
      }
    });
    await t.calendar("alice@x.com");
    await t.call("alice@x.com", { events: [t.doc("v0", "2026-11-17T09:00:00Z", [])] });
    const older = t.call("alice@x.com", { events: [t.doc("v1", "2026-11-17T10:00:00Z", ["[Ann Lee] Old item: Send the old sheet."])] });
    await reached;
    await t.call("alice@x.com", { events: [t.doc("v2", "2026-11-17T11:00:00Z", [])] });
    release();
    expect((await older).json).toMatchObject({ errors: [] });
    expect(await t.actions()).toEqual([]);
    expect((await t.followUp()).checklist).toBeNull();
    expect(await t.hub.sweep()).toMatchObject({ resumed: 0 });
    expect(await t.actions()).toEqual([]);
  });

  it("keeps the retry durable when the first pending write fails, so an acknowledged inbox post is finished by the sweep", async () => {
    let failed = false;
    const t = await setup("signals_items_first_write", (text) => !failed && text.includes("SET items_pending = $2 WHERE id = $1") && (failed = true));
    await t.calendar("alice@x.com");
    const event = t.doc("v1", "2026-11-17T10:00:00Z", ["[Ann Lee] Send pricing: Send the sheet.", "[Ann Lee] Send deck: Send the deck."]);
    await t.pg.query(`INSERT INTO signals_items_first_write.inbox (owner, kind, body) VALUES ('alice@x.com', 'events', $1), ('alice@x.com', 'cursor', $2)`, [JSON.stringify({ events: [event] }), JSON.stringify({ source: "google_drive", cursor: "c1" })]);
    expect(await t.hub.drain()).toEqual({ handled: 2, failed: 0 });
    expect(failed).toBe(true);
    expect(await t.actions()).toEqual([]);
    expect(await t.hub.sweep()).toMatchObject({ resumed: 3 });
    expect((await t.actions()).map((task) => task.title)).toEqual(["Action: Send pricing: Send the sheet.", "Action: Send deck: Send the deck."]);
    expect((await t.followUp()).checklist).toContain("Send deck");
    // An identical repost after that changes nothing.
    await t.call("alice@x.com", { events: [event] });
    expect(await t.actions()).toHaveLength(2);
    expect(await t.hub.sweep()).toMatchObject({ resumed: 0 });
  });

  it("sends the update of an existing follow-up's checklist when the write that saves it and finishes the event fails once", async () => {
    let failing = false;
    const t = await setup("signals_items_clear", (text) => failing && text.includes("ev AS (UPDATE") && text.includes("items_pending = NULL") && !(failing = false));
    await t.calendar("alice@x.com");
    await t.call("alice@x.com", { events: [t.doc("v1", "2026-11-17T10:00:00Z", ["[Jane Doe] Share usage: Share the export."])] });
    const follow = await t.followUp();
    expect(follow.checklist).toContain("Share usage");
    failing = true;
    t.updates.length = 0;
    await t.call("alice@x.com", { events: [t.doc("v2", "2026-11-17T11:00:00Z", ["[Jane Doe] Share usage: Share the export.", "[Jane Doe] Book review: Book the review."])] });
    expect(failing).toBe(false);
    // Nothing was saved, so nothing was said; the sweep saves it and says it.
    expect((await t.followUp()).checklist).not.toContain("Book review");
    expect(t.updates.filter((u) => u.id === follow.id && u.text.includes("Book review"))).toEqual([]);
    expect(await t.hub.sweep()).toMatchObject({ resumed: 1 });
    expect((await t.followUp()).checklist).toContain("Book review");
    expect(t.updates.filter((u) => u.id === follow.id && u.text.includes("Book review"))).toHaveLength(1);
    expect(await t.hub.sweep()).toMatchObject({ resumed: 0 });
  });

  it("gives later pending events a turn when earlier ones keep failing", async () => {
    let goodFails = 1;
    const t = await setup("signals_items_fair", (text, values) => {
      if (!text.includes("own AS (INSERT")) return false;
      if (String(values?.[2]).includes("Broken")) return true;
      return String(values?.[2]).includes("Good") && goodFails-- > 0;
    });
    await t.calendar("alice@x.com");
    const doc = (n: number, step: string) => ({ ...t.doc("v1", "2026-11-17T10:00:00Z", [step]), group_key: `doc${n}`, external_id: `doc${n}:v1` });
    for (let n = 0; n < 20; n++) await t.call("alice@x.com", { events: [doc(n, `[Ann Lee] Broken ${n}: Never works.`)] });
    await t.call("alice@x.com", { events: [doc(20, "[Ann Lee] Good one: Works the second time.")] });
    expect(await t.actions()).toEqual([]);
    await t.hub.sweep();
    expect(await t.actions()).toEqual([]);
    await t.hub.sweep();
    expect((await t.actions()).map((task) => task.title)).toEqual(["Action: Good one: Works the second time."]);
    expect((await t.pg.query(`SELECT count(*)::int AS n FROM signals_items_fair.events WHERE items_pending IS NOT NULL`)).rows).toEqual([{ n: 20 }]);
  });

  it("handles an inbox post again, its cursor waiting, when the write that saves a notes event fails once", async () => {
    let failing = false;
    const t = await setup("signals_items_upsert", (text) => failing && text.includes("INSERT INTO signals_items_upsert.events") && !(failing = false));
    await t.calendar("alice@x.com");
    const event = t.doc("v1", "2026-11-17T10:00:00Z", ["[Ann Lee] Send pricing: Send the sheet."]);
    failing = true;
    await t.pg.query(`INSERT INTO signals_items_upsert.inbox (owner, kind, body) VALUES ('alice@x.com', 'events', $1), ('alice@x.com', 'cursor', $2)`, [JSON.stringify({ events: [event] }), JSON.stringify({ source: "google_drive", cursor: "c1" })]);
    // The events post failed to save: it stays, and so does the cursor behind it.
    expect(await t.hub.drain()).toEqual({ handled: 0, failed: 1 });
    expect(failing).toBe(false);
    const cursor = async () => (await t.pg.query<{ cursor: string | null }>(`SELECT cursor FROM signals_items_upsert.sources WHERE owner = 'alice@x.com' AND source = 'google_drive'`)).rows[0]!.cursor;
    expect(await cursor()).not.toBe("c1");
    expect((await t.pg.query(`SELECT count(*)::int AS n FROM signals_items_upsert.inbox WHERE done_at IS NULL`)).rows).toEqual([{ n: 2 }]);
    // The next drain saves it, then the cursor.
    expect(await t.hub.drain()).toEqual({ handled: 2, failed: 0 });
    expect(await cursor()).toBe("c1");
    expect((await t.actions()).map((task) => task.title)).toEqual(["Action: Send pricing: Send the sheet."]);
    expect(await t.hub.drain()).toEqual({ handled: 0, failed: 0 });
  });

  it("places a new notes revision on its existing follow-up from the sweep when the attachment failed, with no repost", async () => {
    let failing = false;
    const t = await setup("signals_items_attach", (text) => failing && text.includes("cust AS (SELECT") && !(failing = false));
    await t.calendar("alice@x.com");
    await t.call("alice@x.com", { events: [t.doc("v1", "2026-11-17T10:00:00Z", [])] });
    const follow = await t.followUp();
    failing = true;
    t.updates.length = 0;
    const event = t.doc("v2", "2026-11-17T11:00:00Z", ["[Ann Lee] Send deck: Send the deck."]);
    await t.pg.query(`INSERT INTO signals_items_attach.inbox (owner, kind, body) VALUES ('alice@x.com', 'events', $1), ('alice@x.com', 'cursor', $2)`, [JSON.stringify({ events: [event] }), JSON.stringify({ source: "google_drive", cursor: "c2" })]);
    await t.hub.drain();
    expect(failing).toBe(false);
    // The event is saved with its retry marker (so the inbox may move on); the sweep places it and writes its item.
    await t.hub.drain();
    expect(await t.hub.sweep()).toMatchObject({ resumed: 2 });
    const tasks = await t.actions();
    expect(tasks.map((task) => task.title)).toEqual(["Action: Send deck: Send the deck."]);
    expect(tasks[0]!.buzz_root).toBe(`root-${tasks[0]!.id}`);
    const row = (await t.pg.query<{ task_id: unknown; items_pending: unknown }>(`SELECT task_id, items_pending FROM signals_items_attach.events WHERE external_id = 'd1:v2'`)).rows[0]!;
    expect({ task: Number(row.task_id), pending: row.items_pending }).toEqual({ task: follow.id, pending: null });
    expect((await t.followUp()).checklist).toContain(`- Task ${tasks[0]!.id}: [Ann Lee] Send deck: Send the deck.`);
    expect(t.updates.find((u) => u.id === follow.id)!.text).toContain("Send deck");
    expect(await t.hub.sweep()).toMatchObject({ resumed: 0 });
    await t.call("alice@x.com", { events: [event] });
    expect(await t.actions()).toHaveLength(1);
  });

  it("never drops an inbox post whose events keep failing to save: held and reported, its cursor waiting, saved once the write works", async () => {
    let failing = false;
    const t = await setup("signals_items_exhaust", (text) => failing && text.includes("INSERT INTO signals_items_exhaust.events"));
    await t.calendar("alice@x.com");
    failing = true;
    const { INBOX_TRIES, INBOX_HOLD_SECONDS } = await import("../plugins/signals/app/hub");
    const event = t.doc("v1", "2026-11-17T10:00:00Z", ["[Ann Lee] Send pricing: Send the sheet."]);
    await t.pg.query(`INSERT INTO signals_items_exhaust.inbox (owner, kind, body) VALUES ('alice@x.com', 'events', $1), ('alice@x.com', 'cursor', $2)`, [JSON.stringify({ events: [event] }), JSON.stringify({ source: "google_drive", cursor: "c1" })]);
    const source = async () => (await t.pg.query<{ cursor: string | null; last_error: string | null }>(`SELECT cursor, last_error FROM signals_items_exhaust.sources WHERE owner = 'alice@x.com' AND source = 'google_drive'`)).rows[0]!;
    for (let n = 0; n < INBOX_TRIES + 3; n++) expect(await t.hub.drain()).toEqual({ handled: 0, failed: 1 });
    expect((await source()).cursor).not.toBe("c1");
    expect((await source()).last_error).toContain(`failed to save ${INBOX_TRIES} times`);
    expect((await t.pg.query(`SELECT count(*)::int AS n FROM signals_items_exhaust.inbox WHERE done_at IS NULL`)).rows).toEqual([{ n: 2 }]);
    // Held: not tried again until the hold is past (only INBOX_TRIES tries so far).
    expect((await t.pg.query(`SELECT tries FROM signals_items_exhaust.inbox WHERE kind = 'events'`)).rows).toEqual([{ tries: INBOX_TRIES }]);
    // Another source of hers isn't held up.
    await t.pg.query(`INSERT INTO signals_items_exhaust.inbox (owner, kind, body) VALUES ('alice@x.com', 'cursor', $1)`, [JSON.stringify({ source: "google_calendar", cursor: "k1" })]);
    expect(await t.hub.drain()).toEqual({ handled: 1, failed: 1 });
    // The write works again and the hold is past: saved, then its cursor, and the error cleared by the next ingest.
    failing = false;
    await t.pg.query(`UPDATE signals_items_exhaust.inbox SET tried_at = tried_at - $1`, [INBOX_HOLD_SECONDS]);
    expect(await t.hub.drain()).toEqual({ handled: 2, failed: 0 });
    expect(await source()).toEqual({ cursor: "c1", last_error: null });
    expect((await t.actions()).map((task) => task.title)).toEqual(["Action: Send pricing: Send the sheet."]);
  });

  it("keeps a source's first run through a retried post: its notes are only recorded, and nothing is left for the sweep", async () => {
    let failing = false;
    const t = await setup("signals_items_first", (text) => failing && text.includes("INSERT INTO signals_items_first.events") && !(failing = false), { seed: false });
    await t.calendar("alice@x.com");
    failing = true;
    const event = t.doc("v1", "2026-11-17T10:00:00Z", ["[Ann Lee] Send pricing: Send the sheet."]);
    await t.pg.query(`INSERT INTO signals_items_first.inbox (owner, kind, body) VALUES ('alice@x.com', 'events', $1), ('alice@x.com', 'cursor', $2)`, [JSON.stringify({ events: [event] }), JSON.stringify({ source: "google_drive", cursor: "c1" })]);
    expect(await t.hub.drain()).toEqual({ handled: 0, failed: 1 });
    expect((await t.pg.query(`SELECT last_post_at FROM signals_items_first.sources WHERE owner = 'alice@x.com' AND source = 'google_drive'`)).rows).toEqual([{ last_post_at: null }]);
    expect(await t.hub.drain()).toEqual({ handled: 2, failed: 0 });
    expect(await t.hub.sweep()).toMatchObject({ resumed: 0 });
    expect((await t.store.tasks({})).filter((task) => task.rule_id?.startsWith("meeting-notes"))).toEqual([]);
    expect((await t.pg.query(`SELECT items_pending FROM signals_items_first.events WHERE external_id = 'd1:v1'`)).rows).toEqual([{ items_pending: null }]);
    // Her next notes (not a first run now) open their follow-up as usual.
    await t.call("alice@x.com", { events: [t.doc("v2", "2026-11-17T11:00:00Z", ["[Ann Lee] Send deck: Send the deck."])] });
    expect((await t.actions()).map((task) => task.title)).toEqual(["Action: Send deck: Send the deck."]);
  });

  it("leaves a notes version an ingest is classifying to that ingest, and the sweep places a recovered one with the classifier", async () => {
    let release!: (score: number) => void;
    let asked!: () => void;
    let score: number | undefined;
    const reached = new Promise<void>((resolve) => (asked = resolve));
    const classifier = () => {
      if (score !== undefined) return Promise.resolve(score);
      asked();
      return new Promise<number | undefined>((resolve) => (release = resolve));
    };
    let failAttach = false;
    const t = await setup("signals_items_classify", (text) => failAttach && text.includes("cust AS (SELECT") && !(failAttach = false), { classifier });
    await t.calendar("alice@x.com");
    await t.pg.query(`INSERT INTO signals_items_classify.inbox (owner, kind, body) VALUES ('alice@x.com', 'events', $1)`, [JSON.stringify({ events: [t.doc("v1", "2026-11-17T10:00:00Z", ["[Ann Lee] Send pricing: Send the sheet."])] })]);
    // A drain, paused in the classifier after the note is saved; the sweep overlapping it leaves the note alone.
    const drained = t.hub.drain();
    await reached;
    expect(await t.hub.sweep()).toMatchObject({ resumed: 0 });
    expect(await t.store.tasks({})).toEqual([]);
    release(0.1);
    expect(await drained).toEqual({ handled: 1, failed: 0 });
    // Filtered: no follow-up, no action, nothing pending, and a later sweep doesn't place it either.
    expect(await t.hub.sweep()).toMatchObject({ resumed: 0 });
    expect(await t.store.tasks({})).toEqual([]);
    expect((await t.pg.query(`SELECT filtered_rule, items_pending, placing_at FROM signals_items_classify.events WHERE external_id = 'd1:v1'`)).rows).toEqual([{ filtered_rule: "meeting-notes", items_pending: null, placing_at: null }]);
    // A version that passed ingest's classifier and whose follow-up failed to open: the sweep opens it, keeping that decision
    // (a later, lower score doesn't undo it).
    score = 0.9;
    let failOpen = true;
    const u = await setup("signals_items_kept", (text) => failOpen && text.includes("ON CONFLICT (group_key) DO UPDATE SET updated_at") && !(failOpen = false), { classifier: () => Promise.resolve(score) });
    await u.calendar("alice@x.com");
    await u.call("alice@x.com", { events: [u.doc("v1", "2026-11-17T10:00:00Z", ["[Ann Lee] Send deck: Send the deck."])] });
    expect(failOpen).toBe(false);
    expect(await u.store.tasks({})).toEqual([]);
    score = 0.1;
    // (Resumed: the follow-up and the action it opened, and the follow-up's checklist update.)
    expect(await u.hub.sweep()).toMatchObject({ resumed: 3 });
    expect((await u.followUp()).title).toContain("Follow up");
    expect((await u.actions()).map((task) => task.title)).toEqual(["Action: Send deck: Send the deck."]);
  });

  it("lets the sweep place a notes version whose ingest stopped mid-way, once its lease is past", async () => {
    const { PLACING_LEASE } = await import("../plugins/signals/app/store");
    let failAttach = false;
    const t = await setup("signals_items_lease", (text) => failAttach && text.includes("cust AS (SELECT") && !(failAttach = false));
    await t.calendar("alice@x.com");
    await t.call("alice@x.com", { events: [t.doc("v1", "2026-11-17T10:00:00Z", [])] });
    failAttach = true;
    await t.call("alice@x.com", { events: [t.doc("v2", "2026-11-17T11:00:00Z", ["[Ann Lee] Send deck: Send the deck."])] });
    // As if the hub had stopped before its ingest finished: the lease is still set.
    await t.pg.query(`UPDATE signals_items_lease.events SET placing_at = extract(epoch FROM now())::bigint WHERE external_id = 'd1:v2'`);
    expect(await t.hub.sweep()).toMatchObject({ resumed: 0 });
    await t.pg.query(`UPDATE signals_items_lease.events SET placing_at = placing_at - $1 - 5 WHERE external_id = 'd1:v2'`, [PLACING_LEASE]);
    expect(await t.hub.sweep()).toMatchObject({ resumed: 2 });
    expect((await t.actions()).map((task) => task.title)).toEqual(["Action: Send deck: Send the deck."]);
  });

  it("drains other sources and owners past a held source's waiting posts, which keep their order", async () => {
    const t = await setup("signals_items_stall");
    const { INBOX_TRIES } = await import("../plugins/signals/app/hub");
    const at = Math.floor(Date.now() / 1000);
    // Alice's Drive: a held events post (tried INBOX_TRIES times, just now) and 30 cursors waiting behind it.
    await t.pg.query(`INSERT INTO signals_items_stall.inbox (owner, kind, body, tries, tried_at) VALUES ('alice@x.com', 'events', $1, $2, $3)`, [JSON.stringify({ events: [t.doc("v1", "2026-11-17T10:00:00Z", [])] }), INBOX_TRIES, at]);
    for (let n = 1; n <= 30; n++) await t.pg.query(`INSERT INTO signals_items_stall.inbox (owner, kind, body) VALUES ('alice@x.com', 'cursor', $1)`, [JSON.stringify({ source: "google_drive", cursor: `c${n}` })]);
    // Then her Calendar's cursor and Bob's Drive cursor.
    await t.pg.query(`INSERT INTO signals_items_stall.inbox (owner, kind, body) VALUES ('alice@x.com', 'cursor', $1), ('bob@x.com', 'cursor', $2)`, [JSON.stringify({ source: "google_calendar", cursor: "k1" }), JSON.stringify({ source: "google_drive", cursor: "b1" })]);
    const cursor = async (owner: string, source: string) => (await t.pg.query<{ cursor: string | null }>(`SELECT cursor FROM signals_items_stall.sources WHERE owner = $1 AND source = $2`, [owner, source])).rows[0]!.cursor;
    expect(await t.hub.drain()).toEqual({ handled: 2, failed: 1 });
    expect(await cursor("alice@x.com", "google_calendar")).toBe("k1");
    expect(await cursor("bob@x.com", "google_drive")).toBe("b1");
    // Alice's Drive cursors all still wait, in order, behind her held post.
    expect(await cursor("alice@x.com", "google_drive")).toBeNull();
    expect((await t.pg.query(`SELECT count(*)::int AS n FROM signals_items_stall.inbox WHERE done_at IS NULL`)).rows).toEqual([{ n: 31 }]);
    // The limit counts posts handled, not those skipped: two at a time here.
    await t.pg.query(`INSERT INTO signals_items_stall.inbox (owner, kind, body) VALUES ('bob@x.com', 'cursor', $1), ('bob@x.com', 'cursor', $2), ('bob@x.com', 'cursor', $3)`, [JSON.stringify({ source: "google_drive", cursor: "b2" }), JSON.stringify({ source: "google_drive", cursor: "b3" }), JSON.stringify({ source: "google_drive", cursor: "b4" })]);
    expect(await t.hub.drain(2)).toEqual({ handled: 2, failed: 1 });
    expect(await cursor("bob@x.com", "google_drive")).toBe("b3");
    expect(await t.hub.drain(2)).toEqual({ handled: 1, failed: 1 });
    expect(await cursor("bob@x.com", "google_drive")).toBe("b4");
  });

  it("keeps the retry of a first run's notes when its rules open tasks on a first run (first_run_seen false) and the pending write fails", async () => {
    let failing = false;
    const t = await setup("signals_items_firstopen", (text) => failing && text.includes("items_pending IS DISTINCT FROM") && !(failing = false), { seed: false, firstRunSeen: false });
    await t.calendar("alice@x.com");
    failing = true;
    await t.pg.query(`INSERT INTO signals_items_firstopen.inbox (owner, kind, body) VALUES ('alice@x.com', 'events', $1), ('alice@x.com', 'cursor', $2)`, [JSON.stringify({ events: [t.doc("v1", "2026-11-17T10:00:00Z", ["[Ann Lee] Send pricing: Send the sheet."])] }), JSON.stringify({ source: "google_drive", cursor: "c1" })]);
    // Saved (so the post is done and the cursor moves), its follow-up opened, and its items left for the sweep.
    expect(await t.hub.drain()).toEqual({ handled: 2, failed: 0 });
    expect(failing).toBe(false);
    expect((await t.followUp()).title).toContain("Follow up");
    expect(await t.actions()).toEqual([]);
    expect((await t.pg.query(`SELECT items_pending FROM signals_items_firstopen.events WHERE external_id = 'd1:v1'`)).rows).toEqual([{ items_pending: 1 }]);
    expect(await t.hub.sweep()).toMatchObject({ resumed: 2 });
    expect((await t.actions()).map((task) => task.title)).toEqual(["Action: Send pricing: Send the sheet."]);
    expect((await t.followUp()).checklist).toContain("[Ann Lee] Send pricing: Send the sheet.");
    expect((await t.pg.query(`SELECT items_pending FROM signals_items_firstopen.events WHERE external_id = 'd1:v1'`)).rows).toEqual([{ items_pending: null }]);
    // Placed by the sweep on a first run, as its ingest: with first_run_seen true (the default), a first run's notes open nothing.
    let fail2 = false;
    const u = await setup("signals_items_firstseen", (text) => fail2 && text.includes("ON CONFLICT (group_key) DO UPDATE SET updated_at") && !(fail2 = false), { seed: false });
    await u.calendar("alice@x.com");
    await u.call("alice@x.com", { events: [u.doc("v1", "2026-11-17T10:00:00Z", ["[Ann Lee] Send pricing: Send the sheet."])] });
    expect((await u.pg.query(`SELECT items_pending FROM signals_items_firstseen.events WHERE external_id = 'd1:v1'`)).rows).toEqual([{ items_pending: null }]);
    expect(await u.hub.sweep()).toMatchObject({ resumed: 0 });
    expect(await u.store.tasks({})).toEqual([]);
  });

  it("asks the classifier again for a changed version whose placement failed, not keeping an earlier version's rejection", async () => {
    let score = 0.1;
    let asked = 0;
    let failPlace = false;
    const t = await setup("signals_items_reclassify", (text) => failPlace && text.includes("FROM signals_items_reclassify.tasks WHERE group_key = $1") && !(failPlace = false), { classifier: () => (asked++, Promise.resolve(score)) });
    await t.calendar("alice@x.com");
    const event = (steps: string[]) => ({ ...t.doc("v1", "2026-11-17T10:00:00Z", steps), external_id: "d1" });
    await t.call("alice@x.com", { events: [event(["[Ann Lee] Send pricing: Send the sheet."])] });
    expect(asked).toBe(1);
    expect((await t.pg.query(`SELECT filtered_rule FROM signals_items_reclassify.events WHERE external_id = 'd1'`)).rows).toEqual([{ filtered_rule: "meeting-notes" }]);
    // Its contents change under the same id, and placing the new version fails before the classifier is asked.
    failPlace = true;
    score = 0.9;
    await t.call("alice@x.com", { events: [event(["[Ann Lee] Send deck: Send the deck."])] });
    expect(failPlace).toBe(false);
    expect(asked).toBe(1);
    expect((await t.pg.query(`SELECT items_pending FROM signals_items_reclassify.events WHERE external_id = 'd1'`)).rows).toEqual([{ items_pending: 2 }]);
    // The sweep asks about this version, which passes: its follow-up and action open.
    expect(await t.hub.sweep()).toMatchObject({ resumed: 3 });
    expect(asked).toBe(2);
    expect((await t.followUp()).title).toContain("Follow up");
    expect((await t.actions()).map((task) => task.title)).toEqual(["Action: Send deck: Send the deck."]);
    expect((await t.pg.query(`SELECT filtered_rule, items_pending FROM signals_items_reclassify.events WHERE external_id = 'd1'`)).rows).toEqual([{ filtered_rule: null, items_pending: null }]);
    // Rejected for this version, the sweep keeps that and doesn't ask again.
    let failAgain = false;
    const u = await setup("signals_items_rejected", (text) => failAgain && text.includes("FROM signals_items_rejected.tasks WHERE group_key = $1") && !(failAgain = false), { classifier: () => (asked++, Promise.resolve(0.1)) });
    await u.calendar("alice@x.com");
    await u.call("alice@x.com", { events: [{ ...u.doc("v1", "2026-11-17T10:00:00Z", ["[Ann Lee] Send pricing: Send the sheet."]), external_id: "d1" }] });
    asked = 0;
    expect(await u.hub.sweep()).toMatchObject({ resumed: 0 });
    expect(asked).toBe(0);
    expect(await u.store.tasks({})).toEqual([]);
  });
  // A classifier whose answers are given by hand, in the order it was asked (each call waits until its answer is given).
  const gated = () => {
    const waiting: ((score: number) => void)[] = [];
    let notify: (() => void) | undefined;
    const classifier = () => new Promise<number | undefined>((resolve) => {
      waiting.push(resolve);
      notify?.();
    });
    const asked = async (count: number) => {
      while (waiting.length < count) await new Promise<void>((resolve) => (notify = resolve));
    };
    return { classifier, asked, answer: (index: number, score: number) => waiting[index]!(score), count: () => waiting.length };
  };

  it("keeps a newer revision's classifier decision when an older revision's request finishes after it", async () => {
    const gate = gated();
    let failOpen = false;
    const t = await setup("signals_items_older_decision", (text) => failOpen && text.includes("ON CONFLICT (group_key) DO UPDATE SET updated_at") && !(failOpen = false), { classifier: gate.classifier });
    await t.calendar("alice@x.com");
    const event = (steps: string[]) => ({ ...t.doc("v1", "2026-11-17T10:00:00Z", steps), external_id: "d1" });
    // Revision 1's ingest waits in its classifier.
    const older = t.call("alice@x.com", { events: [event(["[Ann Lee] Send pricing: Send the sheet."])] });
    await gate.asked(1);
    // Revision 2 is approved, and opening its follow-up fails: left to the sweep, with its decision.
    failOpen = true;
    const newer = t.call("alice@x.com", { events: [event(["[Ann Lee] Send deck: Send the deck."])] });
    await gate.asked(2);
    gate.answer(1, 0.9);
    await newer;
    expect(failOpen).toBe(false);
    // Revision 1's request finishes late and rejects its content: revision 2's decision stands.
    gate.answer(0, 0.1);
    await older;
    expect((await t.pg.query(`SELECT filtered_rule, filtered_score, filtered_version, items_pending FROM signals_items_older_decision.events WHERE external_id = 'd1'`)).rows).toEqual([{ filtered_rule: null, filtered_score: 0.9, filtered_version: 2, items_pending: 2 }]);
    // The sweep places revision 2 on that decision, without asking again.
    expect(await t.hub.sweep()).toMatchObject({ resumed: 3 });
    expect(gate.count()).toBe(2);
    expect((await t.actions()).map((task) => task.title)).toEqual(["Action: Send deck: Send the deck."]);
  });

  it("keeps a newer revision's placement lease when an older revision's ingest finishes while the newer one is still classified", async () => {
    const gate = gated();
    const t = await setup("signals_items_older_lease", undefined, { classifier: gate.classifier });
    await t.calendar("alice@x.com");
    const event = (steps: string[]) => ({ ...t.doc("v1", "2026-11-17T10:00:00Z", steps), external_id: "d1" });
    const older = t.call("alice@x.com", { events: [event(["[Ann Lee] Send pricing: Send the sheet."])] });
    await gate.asked(1);
    const newer = t.call("alice@x.com", { events: [event(["[Ann Lee] Send deck: Send the deck."])] });
    await gate.asked(2);
    // Revision 1 passes, but it isn't the notes' latest revision any more: it opens nothing and leaves revision 2's lease.
    gate.answer(0, 0.9);
    await older;
    expect(await t.store.tasks({})).toEqual([]);
    expect((await t.pg.query(`SELECT placing_at IS NOT NULL AS leased, items_pending FROM signals_items_older_lease.events WHERE external_id = 'd1'`)).rows).toEqual([{ leased: true, items_pending: 2 }]);
    // A sweep while revision 2 is still being classified leaves it to its ingest.
    expect(await t.hub.sweep()).toMatchObject({ resumed: 0 });
    expect(await t.store.tasks({})).toEqual([]);
    // Revision 2 is rejected: no follow-up, no action, nothing left for the sweep.
    gate.answer(1, 0.1);
    await newer;
    expect(await t.hub.sweep()).toMatchObject({ resumed: 0 });
    expect(await t.store.tasks({})).toEqual([]);
    expect(gate.count()).toBe(2);
    expect((await t.pg.query(`SELECT filtered_rule, filtered_version, items_pending, placing_at FROM signals_items_older_lease.events WHERE external_id = 'd1'`)).rows).toEqual([{ filtered_rule: "meeting-notes", filtered_version: 2, items_pending: null, placing_at: null }]);
  });
  it("opens no follow-up for a revision a newer one replaces right before the statement that opens it", async () => {
    // Revision 1 passes its classifier; revision 2 (rejected) is recorded and decided just before revision 1's follow-up insert runs.
    const scores = [0.9, 0.1];
    let newer: Promise<unknown> | undefined;
    let t!: Awaited<ReturnType<typeof setup>>;
    t = await setup("signals_items_write_boundary", async (text) => {
      if (!newer && text.includes("INSERT INTO signals_items_write_boundary.tasks")) {
        newer = t.call("alice@x.com", { events: [{ ...t.doc("v1", "2026-11-17T10:00:00Z", ["[Ann Lee] Send deck: Send the deck."]), external_id: "d1" }] });
        await newer;
      }
    }, { classifier: () => Promise.resolve(scores.shift()) });
    await t.calendar("alice@x.com");
    await t.call("alice@x.com", { events: [{ ...t.doc("v1", "2026-11-17T10:00:00Z", ["[Ann Lee] Send pricing: Send the sheet."]), external_id: "d1" }] });
    expect(newer).toBeDefined();
    expect(scores).toEqual([]);
    expect(await t.store.tasks({})).toEqual([]);
    expect(await t.hub.sweep()).toMatchObject({ resumed: 0 });
    expect(await t.store.tasks({})).toEqual([]);
    expect((await t.pg.query(`SELECT versions, filtered_rule, filtered_version, items_pending, placing_at FROM signals_items_write_boundary.events WHERE external_id = 'd1'`)).rows).toEqual([{ versions: 2, filtered_rule: "meeting-notes", filtered_version: 2, items_pending: null, placing_at: null }]);
  });
  it("opens no follow-up from the sweep for a revision a newer one replaces right before the insert, reusing its saved score", async () => {
    // Revision 1 passes its classifier, and opening its follow-up fails: the sweep is to place it on that saved score.
    const scores = [0.9, 0.1];
    let asked = 0;
    let failOpen = true;
    let sweeping = false;
    let askedAtInsert: number | undefined;
    let newer: Promise<unknown> | undefined;
    let t!: Awaited<ReturnType<typeof setup>>;
    t = await setup("signals_items_sweep_boundary", async (text) => {
      if (!text.includes("INSERT INTO signals_items_sweep_boundary.tasks")) return;
      if (failOpen) {
        failOpen = false;
        throw new Error("write failed");
      }
      // The sweep's insert of revision 1's follow-up: revision 2 (rejected) is recorded and decided just before it runs.
      if (sweeping && !newer) {
        askedAtInsert = asked;
        newer = t.call("alice@x.com", { events: [{ ...t.doc("v1", "2026-11-17T10:00:00Z", ["[Ann Lee] Send deck: Send the deck."]), external_id: "d1" }] });
        await newer;
      }
    }, { classifier: () => (asked++, Promise.resolve(scores.shift())) });
    await t.calendar("alice@x.com");
    await t.call("alice@x.com", { events: [{ ...t.doc("v1", "2026-11-17T10:00:00Z", ["[Ann Lee] Send pricing: Send the sheet."]), external_id: "d1" }] });
    expect(failOpen).toBe(false);
    expect((await t.pg.query(`SELECT filtered_rule, filtered_score, filtered_version, items_pending IS NOT NULL AS pending FROM signals_items_sweep_boundary.events WHERE external_id = 'd1'`)).rows).toEqual([{ filtered_rule: null, filtered_score: 0.9, filtered_version: 1, pending: true }]);
    sweeping = true;
    await t.hub.sweep();
    // The sweep reached the insert on the saved score, without asking again; only revision 2's ingest asked.
    expect(askedAtInsert).toBe(1);
    expect(newer).toBeDefined();
    expect(asked).toBe(2);
    expect(await t.store.tasks({})).toEqual([]);
    expect(await t.hub.sweep()).toMatchObject({ resumed: 0 });
    expect(await t.store.tasks({})).toEqual([]);
    expect(asked).toBe(2);
    expect((await t.pg.query(`SELECT versions, filtered_rule, filtered_version, items_pending, placing_at FROM signals_items_sweep_boundary.events WHERE external_id = 'd1'`)).rows).toEqual([{ versions: 2, filtered_rule: "meeting-notes", filtered_version: 2, items_pending: null, placing_at: null }]);
  });
  for (const ids of ["distinct revision ids sharing the document's group, as the bundled Drive mapping gives", "one stable event id"] as const) {
    it(`opens no stale follow-up or action from the sweep when a newer revision without the action is saved right before the insert (${ids})`, async () => {
      // The bundled meeting-notes rule (no classifier). Revision 1's follow-up insert fails; it's left to the sweep.
      const stable = ids === "one stable event id";
      let failOpen = true;
      let sweeping = false;
      let newer: Promise<unknown> | undefined;
      let t!: Awaited<ReturnType<typeof setup>>;
      const schema = stable ? "signals_items_stale_stable" : "signals_items_stale_revs";
      const revision = (version: string, at: string, steps: string[]) => ({ ...t.doc(version, at, steps), ...(stable && { external_id: "d1" }) });
      t = await setup(schema, async (text) => {
        if (!text.includes(`INSERT INTO ${schema}.tasks`)) return;
        if (failOpen) {
          failOpen = false;
          throw new Error("write failed");
        }
        // The sweep's retry of revision 1: revision 2, with the action removed, is saved just before its insert runs
        // (its ingest then waits, before placing it, until the sweep is done).
        if (sweeping && !newer) {
          newer = t.call("alice@x.com", { events: [revision("v2", "2026-11-17T11:00:00Z", ["[Jane Doe] Share usage: Share the export."])] });
          await saved;
        }
      });
      // Revision 2's ingest, once it has saved it: held at its first look for the group's task until released.
      let markSaved!: () => void;
      const saved = new Promise<void>((resolve) => (markSaved = resolve));
      let release!: () => void;
      const released = new Promise<void>((resolve) => (release = resolve));
      let held = false;
      const inner = t.store as unknown as { db: { query: (text: string, values?: unknown[]) => Promise<unknown> } };
      const query = inner.db.query;
      inner.db.query = async (text, values) => {
        if (newer && !held && text.includes(`FROM ${schema}.tasks WHERE group_key = $1`)) {
          held = true;
          markSaved();
          await released;
        }
        return query(text, values);
      };
      await t.calendar("alice@x.com");
      await t.call("alice@x.com", { events: [revision("v1", "2026-11-17T10:00:00Z", ["[Ann Lee] Send pricing: Send the sheet."])] });
      expect(failOpen).toBe(false);
      expect(await t.store.tasks({})).toEqual([]);
      sweeping = true;
      await t.hub.sweep();
      expect(held).toBe(true);
      release();
      await newer;
      await t.hub.sweep();
      // Only revision 2's work: its follow-up with the customer's item, and no "Send pricing" task.
      const tasks = await t.store.tasks({});
      expect(tasks.map((task) => task.rule_id)).toEqual(["meeting-notes"]);
      expect(tasks[0]!.checklist).toContain("Share usage");
      expect(tasks[0]!.checklist).not.toContain("Send pricing");
      expect(await t.actions()).toEqual([]);
      expect((await t.pg.query(`SELECT count(*)::int AS n FROM ${schema}.events WHERE source = 'google_drive' AND items_pending IS NOT NULL`)).rows).toEqual([{ n: 0 }]);
    });
  }
  it("drops a forgotten copy's revision from its document's newest, so an older pending revision another person saved still opens", async () => {
    // Alice saves revision 1 and Bob revision 2 of one doc; both follow-up inserts fail, so both are left to the sweep.
    let fails = 2;
    const t = await setup("signals_items_forget_revision", (text) => text.includes("INSERT INTO signals_items_forget_revision.tasks") && fails > 0 && fails-- > 0);
    await t.calendar("alice@x.com");
    await t.call("alice@x.com", { events: [t.doc("v1", "2026-11-17T10:00:00Z", ["[Jane Doe] Share usage: Share the export."])] });
    await t.call("bob@x.com", { events: [t.doc("v2", "2026-11-17T11:00:00Z", ["[Jane Doe] Share deck: Share the deck."])] });
    expect(fails).toBe(0);
    const latest = async () => (await t.pg.query(`SELECT latest_us::text AS us FROM signals_items_forget_revision.revisions WHERE group_key = 'd1'`)).rows;
    expect(await latest()).toEqual([{ us: String(Date.parse("2026-11-17T11:00:00Z") * 1000) }]);
    // Bob forgets his Drive: his revision goes, and the document's newest is Alice's again.
    await t.store.setSource("bob@x.com", "google_drive", false, undefined, true);
    expect(await latest()).toEqual([{ us: String(Date.parse("2026-11-17T10:00:00Z") * 1000) }]);
    await t.hub.sweep();
    const follow = await t.followUp();
    expect(follow.checklist).toContain("Share usage");
    expect(follow.checklist).not.toContain("Share deck");
    // Alice forgets hers too: no copy left, no revision kept.
    await t.store.setSource("alice@x.com", "google_drive", false, undefined, true);
    expect(await latest()).toEqual([]);
  });

  it("writes no checklist from the sweep for a revision a newer one, saved but not yet at the follow-up, replaces", async () => {
    // Revision 1 opens its follow-up, and its claim on it fails: the sweep is to write its checklist.
    let failClaim = true;
    let sweeping = false;
    let newer: Promise<unknown> | undefined;
    let markSaved!: () => void;
    const saved = new Promise<void>((resolve) => (markSaved = resolve));
    let release!: () => void;
    const released = new Promise<void>((resolve) => (release = resolve));
    let t!: Awaited<ReturnType<typeof setup>>;
    t = await setup("signals_items_stale_checklist", async (text) => {
      const claim = text.includes("UPDATE signals_items_stale_checklist.tasks SET items_us = $2 WHERE id = $1");
      if (claim && failClaim) {
        failClaim = false;
        throw new Error("write failed");
      }
      // Revision 2's ingest, once it has saved it, waits at its claim on the follow-up until released.
      if (claim && newer) {
        markSaved();
        await released;
      }
      // The sweep's checklist write for revision 1: revision 2 is saved just before it.
      if (sweeping && !newer && text.includes("WITH ck AS (UPDATE signals_items_stale_checklist.tasks")) {
        newer = t.call("alice@x.com", { events: [t.doc("v2", "2026-11-17T11:00:00Z", ["[Jane Doe] Share usage: Share the export."])] });
        await saved;
      }
    });
    await t.calendar("alice@x.com");
    await t.call("alice@x.com", { events: [t.doc("v1", "2026-11-17T10:00:00Z", ["[Jane Doe] Old pricing: Send the sheet."])] });
    expect(failClaim).toBe(false);
    expect((await t.followUp()).checklist ?? null).toBeNull();
    t.updates.length = 0;
    sweeping = true;
    await t.hub.sweep();
    expect(newer).toBeDefined();
    // Nothing from revision 1's notes was written or posted.
    expect((await t.followUp()).checklist ?? null).toBeNull();
    expect(t.updates.some((u) => u.text.includes("Old pricing"))).toBe(false);
    release();
    await newer;
    const follow = await t.followUp();
    expect(follow.checklist).toContain("Share usage");
    expect(follow.checklist).not.toContain("Old pricing");
    expect(t.updates.some((u) => u.text.includes("Old pricing"))).toBe(false);
    expect((await t.pg.query(`SELECT count(*)::int AS n FROM signals_items_stale_checklist.events WHERE items_pending IS NOT NULL`)).rows).toEqual([{ n: 0 }]);
  });
  it("undoes Forget's delete when its revision refresh fails, so Forget again finishes both, and leaves a document saved without a revision row as it is", async () => {
    const t = await setup("signals_items_forget_retry");
    await t.calendar("alice@x.com");
    await t.call("alice@x.com", { events: [t.doc("v1", "2026-11-17T10:00:00Z", ["[Jane Doe] Share usage: Share the export."])] });
    const count = async (table: string) => (await t.pg.query<{ n: number }>(`SELECT count(*)::int AS n FROM signals_items_forget_retry.${table}${table === "events" ? " WHERE source = 'google_drive' AND owner = 'alice@x.com'" : ""}`)).rows[0]!.n;
    expect(await count("revisions")).toBe(1);
    // The refresh fails: the events are still there, and so is the revision.
    const real = (await t.pg.query<{ def: string }>(`SELECT pg_get_functiondef('signals_items_forget_retry.refresh_revision(text,text)'::regprocedure) AS def`)).rows[0]!.def;
    await t.pg.query(`CREATE OR REPLACE FUNCTION signals_items_forget_retry.refresh_revision(doc_source text, doc_group text) RETURNS void LANGUAGE plpgsql AS $fn$ BEGIN RAISE EXCEPTION 'refresh failed'; END $fn$`);
    await expect(t.store.setSource("alice@x.com", "google_drive", false, undefined, true)).rejects.toThrow("refresh failed");
    expect(await count("events")).toBeGreaterThan(0);
    expect(await count("revisions")).toBe(1);
    // Forget again, with the refresh working: both done.
    await t.pg.query(real);
    await t.store.setSource("alice@x.com", "google_drive", false, undefined, true);
    expect(await count("events")).toBe(0);
    expect(await count("revisions")).toBe(0);
    // A document saved before revisions were kept (no row): Forget deletes its copies and adds no row.
    await t.store.setSource("alice@x.com", "google_drive", true);
    await t.call("alice@x.com", { events: [t.doc("v2", "2026-11-17T11:00:00Z", ["[Jane Doe] Share usage: Share the export."])] });
    await t.pg.query(`DELETE FROM signals_items_forget_retry.revisions`);
    await t.store.setSource("alice@x.com", "google_drive", false, undefined, true);
    expect(await count("events")).toBe(0);
    expect(await count("revisions")).toBe(0);
  });
});
