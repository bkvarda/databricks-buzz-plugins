// Signals: a rule's `summarize_title` gives its new tasks a short title from a chat model, keeping the source's own as `source_title`.
import { PGlite } from "@electric-sql/pglite";
import { describe, expect, it } from "vitest";
import { chatText, chatTitler, jevCategorizer, TITLER_PROMPT } from "../plugins/signals/app/classify";
import { eventDetails, Hub, taskMessage } from "../plugins/signals/app/hub";
import { configProblems, NO_CATEGORY, type Rule, shortTitle, type SignalsConfig, sourceTitle, taskTitle } from "../plugins/signals/app/model";
import { type Categorizer, SignalsStore, type Titler } from "../plugins/signals/app/store";

const ES_TITLE = "ES-2376508 For customer: [Acme], workspace id: [2736046192934091] increase RPM/TPM rate limit for Gemini 4 Neon";
const ESCALATIONS: Rule = {
  id: "escalations", sources: ["jira"], action: "task", group_by: "external_id", workstream: "escalation tracking", summarize_title: true,
  categories: [
    { workstream: "capacity requests", when: { "payload.model": "." }, title: "Capacity request: {payload.model} in workspace {payload.workspace}" },
    { workstream: "feature request", about: "Asks for a feature that doesn't exist yet" },
  ],
};
const PREP: Rule = { id: "prep", sources: ["google_calendar"], action: "task", title: "Prep: {title}", workstream: "meeting prep", summarize_title: true };
const PLAIN: Rule = { id: "questions", sources: ["slack"], action: "task", workstream: "questions" };
const CONFIG: SignalsConfig = { version: 1, first_run_seen: true, accounts: [{ name: "Acme", channel: "acme" }], rules: [ESCALATIONS, PREP, PLAIN] };

describe("short titles", () => {
  it("checks a model's title", () => {
    expect(shortTitle("Capacity request: Gemini 4 Neon in workspace 27360461")).toBe("Capacity request: Gemini 4 Neon in workspace 27360461");
    expect(shortTitle("x".repeat(60))).toBe("X" + "x".repeat(59));
    expect(shortTitle('  "quota bump for Claude Sonnet on prod workspace 123."  ')).toBe("Quota bump for Claude Sonnet on prod workspace 123");
    expect(shortTitle("Title: Dark mode request")).toBe("Dark mode request");
    for (const bad of ["x".repeat(61), "Two\nlines", "Ask @brandon about quota", "**Quota** bump", "Quota bump 🚀", "Slack: quota bump", "Reply: thanks", "- quota", "[link](https://x)", "", "   ", undefined, 42])
      expect(shortTitle(bad)).toBeUndefined();
  });

  it("fills templates with the short title, and keeps the source's when the title doesn't show it", () => {
    const event = { source: "google_calendar", external_id: "m1", title: "Acme <> Databricks weekly sync on serving costs and the Q1 roadmap review" };
    expect(taskTitle(PREP, event, undefined, "Acme weekly sync")).toBe("Prep: Acme weekly sync");
    expect(taskTitle(PREP, event)).toBe(`Prep: ${event.title}`);
    expect(taskTitle(ESCALATIONS, { source: "jira", external_id: "1", title: ES_TITLE, payload: { model: "Gemini 4 Neon", workspace: "27" } }, ESCALATIONS.categories![0], "ignored")).toBe("Capacity request: Gemini 4 Neon in workspace 27");
    expect(sourceTitle(event, `Prep: ${event.title}`)).toBeUndefined();
    expect(sourceTitle(event, "Prep: Acme weekly sync")).toBe(event.title);
    expect(sourceTitle({ ...event, title: "a\n  b" }, "x")).toBe("a b");
    expect(sourceTitle({ ...event, title: undefined }, "x")).toBeUndefined();
  });

  it("validates summarize_title and a category's title", () => {
    expect(configProblems(CONFIG)).toEqual([]);
    expect(configProblems({ ...CONFIG, rules: [{ ...PLAIN, summarize_title: "yes" } as never] })).toEqual([expect.stringMatching(/summarize_title is true or false/)]);
    expect(configProblems({ ...CONFIG, rules: [{ ...PLAIN, action: "update", summarize_title: true }] })).toContainEqual(expect.stringMatching(/summarize_title needs action task/));
    expect(configProblems({ ...CONFIG, rules: [{ ...ESCALATIONS, categories: [{ workstream: "a", about: "x", title: "" }] }] })).toEqual([expect.stringMatching(/title is a title template/)]);
  });

  it("opens tasks with short titles, source_title, filed_by and quiet activities", async () => {
    const titled: string[] = [];
    const db = pglite();
    const store = new SignalsStore(db, "signals_titles");
    store.titler = (async (event) => {
      titled.push(event.external_id);
      if (event.external_id === "down") throw new Error("503");
      return { m1: "Acme weekly sync", t2: "Dark mode for the SQL editor", bad: "Slack: hi @team" }[event.external_id];
    }) satisfies Titler;
    store.categorizer = (async (event) => (event.external_id === "t2" ? { choice: "feature request", score: 0.93 } : NO_CATEGORY)) satisfies Categorizer;
    await store.setup();
    const hub = new Hub(store, undefined, { defaultConfig: CONFIG });
    const call = (path: string, body: unknown) => hub.handle({ method: "POST", path, query: new URLSearchParams(), user: "alice@x.com", body: async () => JSON.stringify(body) });
    for (const source of ["jira", "google_calendar", "slack"]) {
      await call("/api/sources", { source, enabled: true });
      await call("/api/events", { events: [{ source, external_id: "seed" }] });
    }
    const long = "Dark mode please! Our analysts work late and the SQL editor is very bright, could you add a dark theme option?";
    await call("/api/events", { events: [
      { source: "jira", external_id: "t1", title: ES_TITLE, account: "Acme", payload: { model: "Gemini 4 Neon", workspace: "2736046192934091" } },
      { source: "jira", external_id: "t2", title: long, account: "Acme" },
      { source: "jira", external_id: "down", title: "Workspace 9 jobs failing since upgrade", account: "Acme" },
      { source: "jira", external_id: "bad", title: "hello there team", account: "Acme" },
      { source: "google_calendar", external_id: "m1", title: "Acme <> Databricks weekly sync on serving costs", account: "Acme" },
      { source: "slack", external_id: "s1", title: "Is there a limit on endpoints?", account: "Acme" },
    ] });
    const tasks = Object.fromEntries((await store.tasks({})).map((task) => [task.group_key.split(/[|:]/).pop(), task]));
    // A category with its own title, and a rule without summarize_title, don't ask the model.
    expect(titled.sort()).toEqual(["bad", "down", "m1", "t2"]);
    expect(tasks.t1).toMatchObject({ title: "Capacity request: Gemini 4 Neon in workspace 2736046192934091", source_title: ES_TITLE, workstream: "capacity requests", filed_by: "match", filed_score: null });
    expect(tasks.t2).toMatchObject({ title: "Dark mode for the SQL editor", source_title: long, workstream: "feature request", filed_by: "classifier" });
    expect(tasks.t2!.filed_score).toBeCloseTo(0.93);
    // The model failed, or its title failed the checks: the normal title, no source_title.
    expect(tasks.down).toMatchObject({ title: "Workspace 9 jobs failing since upgrade", source_title: null, filed_by: "rule" });
    expect(tasks.bad).toMatchObject({ title: "hello there team", source_title: null });
    expect(tasks.m1).toMatchObject({ title: "Prep: Acme weekly sync", source_title: "Acme <> Databricks weekly sync on serving costs" });
    expect(tasks.s1).toMatchObject({ title: "Is there a limit on endpoints?", source_title: null, filed_by: "rule" });
    // How it was filed and titled is an activity, not a post.
    const detail = await store.detail(tasks.t2!.id);
    expect(detail!.activities.map((a) => a.text)).toEqual(["Opened by rule escalations · filed under feature request (picked by the classifier, 93%) · title shortened"]);
    expect((await store.detail(tasks.t1!.id))!.activities.map((a) => a.text)).toEqual(["Opened by rule escalations · filed under capacity requests (matched a category rule) · title shortened"]);
    expect((await store.detail(tasks.s1!.id))!.activities.map((a) => a.text)).toEqual(["Opened by rule questions"]);
    // The board gives each task the event it opened with (whose title it took) as its origin.
    const board = new Map((await hub.board("acme")).tasks.map((row) => [row.task.id, row]));
    expect(board.get(tasks.t1!.id)!.origin).toEqual({ source: "jira", external_id: "t1", title: ES_TITLE });
    expect(board.get(tasks.m1!.id)!.origin).toMatchObject({ source: "google_calendar", external_id: "m1" });
    // An edit of the opening event itself doesn't change where the task came from: origin keeps the title it opened with.
    await call("/api/events", { events: [{ source: "jira", external_id: "t1", title: "Edited summary", account: "Acme", payload: { model: "Gemini 4 Neon", workspace: "2736046192934091" } }] });
    expect((await store.task(tasks.t1!.id))!.source_title).toBe(ES_TITLE);
    expect((await hub.board("acme")).tasks.find((row) => row.task.id === tasks.t1!.id)!.origin).toEqual({ source: "jira", external_id: "t1", title: ES_TITLE });
    // Tasks opened before origin_title was kept show the event's own title.
    await db.query(`UPDATE signals_titles.tasks SET origin_title = NULL WHERE id = $1`, [tasks.m1!.id]);
    expect((await hub.board("acme")).tasks.find((row) => row.task.id === tasks.m1!.id)!.origin).toMatchObject({ title: "Acme <> Databricks weekly sync on serving costs" });
    // A task opened before the origin was kept has none.
    await db.query(`UPDATE signals_titles.tasks SET title_event = NULL WHERE id = $1`, [tasks.s1!.id]);
    expect((await hub.board("acme")).tasks.find((row) => row.task.id === tasks.s1!.id)).not.toHaveProperty("origin");
    // Filed again under the same workstream, it keeps how it was filed; moved to another, that's cleared (the reason was for the old one).
    expect(await store.file(tasks.t2!.id, "alice@x.com", { workstream: "feature request" })).toMatchObject({ filed_by: "classifier" });
    expect(await store.file(tasks.t1!.id, "alice@x.com", { initiative: "Q1" })).toMatchObject({ filed_by: "match" });
    expect(await store.file(tasks.t1!.id, "alice@x.com", { workstream: "escalation tracking" })).toMatchObject({ workstream: "escalation tracking", filed_by: null, filed_score: null });
    expect((await hub.board("acme")).tasks.find((row) => row.task.id === tasks.t1!.id)!.task).toMatchObject({ filed_by: null });
    // A later event doesn't retitle it.
    await call("/api/events", { events: [{ source: "jira", external_id: "t2", title: `${long} (bump)`, account: "Acme" }] });
    expect(titled).toHaveLength(4);
    expect((await store.task(tasks.t2!.id))!.title).toBe("Dark mode for the SQL editor");
  });

  it("opens no task from a version a newer one replaced while its title was being shortened", async () => {
    const store = new SignalsStore(pglite(), "signals_titles_race");
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    let asked!: () => void;
    const waiting = new Promise<void>((resolve) => (asked = resolve));
    store.titler = (async () => (asked(), await held, "Quota bump for Gemini")) satisfies Titler;
    await store.setup();
    // Only an incoming request opens a task; a withdrawn one doesn't.
    const intake: Rule = { id: "intake", sources: ["jira"], action: "task", group_by: "external_id", workstream: "intake", summarize_title: true, when: { "payload.status": "^Incoming$" } };
    const hub = new Hub(store, undefined, { defaultConfig: { ...CONFIG, rules: [intake] } });
    const call = (path: string, body: unknown) => hub.handle({ method: "POST", path, query: new URLSearchParams(), user: "alice@x.com", body: async () => JSON.stringify(body) });
    await call("/api/sources", { source: "jira", enabled: true });
    await call("/api/events", { events: [{ source: "jira", external_id: "seed" }] });
    const ticket = { source: "jira", external_id: "ES-9", title: "Please raise the RPM limit for Gemini 4 Neon in workspace 27 before the launch", account: "Acme" };
    const older = call("/api/events", { events: [{ ...ticket, payload: { status: "Incoming" } }] });
    await waiting;
    // The request is withdrawn while the older version waits on the model: that newer version decides, and opens nothing.
    await call("/api/events", { events: [{ ...ticket, payload: { status: "Withdrawn" } }] });
    release();
    await older;
    expect(await store.tasks({})).toEqual([]);
  });

  it("puts the source's title under Source in the task's post, only when the title doesn't show it", () => {
    const event = { source: "jira", external_id: "ES-1", url: "https://jira/ES-1", title: `${ES_TITLE}\nsecond line` };
    const details = eventDetails(event, [], undefined, { title: "Capacity request: Gemini 4 Neon" });
    expect(details.split("\n").slice(0, 2)).toEqual(["**Source** (jira): https://jira/ES-1", `Title: ${ES_TITLE} second line`]);
    expect(eventDetails({ ...event, title: "x".repeat(400) }, [], undefined, { title: "Short" }).split("\n")[1]!.length).toBeLessThanOrEqual(310);
    expect(eventDetails(event, [], undefined, { title: `Prep: ${ES_TITLE} second line` })).not.toContain("Title:");
    expect(eventDetails(event)).not.toContain("Title:");
    const post = taskMessage({ id: 1, title: "Capacity request: Gemini 4 Neon" } as never, { source: details });
    expect(post).toContain(`**Source** (jira): https://jira/ES-1\nTitle: ${ES_TITLE}`);
  });

  it("asks a chat endpoint, and reads its answer", async () => {
    const calls: { path: string; body: unknown }[] = [];
    const titler = chatTitler(async (path, init) => (calls.push({ path, body: init.body }), { choices: [{ message: { role: "assistant", content: "Capacity request: Gemini 4 Neon in workspace 27" } }] }));
    expect(await titler({ source: "jira", external_id: "1", title: ES_TITLE })).toBe("Capacity request: Gemini 4 Neon in workspace 27");
    expect(calls[0]).toMatchObject({ path: "/serving-endpoints/databricks-claude-haiku-5-5/invocations", body: { messages: [{ role: "system", content: TITLER_PROMPT }, { role: "user", content: expect.stringContaining("2736046192934091") }], max_tokens: 60 } });
    expect(chatText({ choices: [{ message: { content: [{ type: "text", text: "A" }, { type: "text", text: "B" }] } }] })).toBe("AB");
    const lines: string[] = [];
    expect(await chatTitler(async () => ({ choices: [{ message: { content: "x".repeat(80) } }] }), "ep", (l) => lines.push(l))({ source: "jira", external_id: "2" })).toBeUndefined();
    expect(await chatTitler(async () => Promise.reject(new Error("HTTP 503")), "ep", (l) => lines.push(l))({ source: "jira", external_id: "3" })).toBeUndefined();
    expect(lines).toEqual(["titler ep gave no usable title for jira 2", "titler ep failed for jira 3: HTTP 503"]);
    // The categorizer gives the choice's confidence too.
    expect(await jevCategorizer(async () => ({ answers: { category: { choice: "x", confidence: 0.8 } } }))({ source: "jira", external_id: "4" }, {})).toEqual({ choice: "x", score: 0.8 });
  });
});

function pglite() {
  const db = new PGlite();
  return { query: async (text: string, values?: unknown[]) => ({ rows: (await db.query(text, values)).rows as never[] }) };
}
