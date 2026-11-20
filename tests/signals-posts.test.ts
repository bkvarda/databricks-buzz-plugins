// The cards on the hub's posts read back what the hub writes: these check the
// parser against the hub's own message builders and posts as they look live.
import { describe, expect, it } from "vitest";
import { npubEncode } from "nostr-tools/nip19";
import { answerMessage, changedMessage, doneMessage, eventDetails, questionMessage, taskMessage } from "../plugins/signals/app/hub";
import type { Task } from "../plugins/signals/app/store";
import { ago } from "../packages/core/src/ui/components";
import { filedHint, filterTasks, openingTitle, postOrigin, taskFacts, taskOrigin, titleHint, workstreamHint } from "../plugins/signals/src/board-view";
import type { BoardTask } from "../plugins/signals/src/client";
import { detailPairs, isTaskPost, parseTaskPost, parseThreadPost, personName, plainLine, readTaskTarget, shortWhen, sourceName, taskTarget } from "../plugins/signals/src/posts";

const AGENT = "09fea0492c475c37e6e96b6e4e47a7b8f0670fd319c667b45ab8f49aa85602f2";
const task = (over: Partial<Task> = {}) => ({ id: 65, title: "Incident ES-2373918 (Sev1, Mitigated): Model Serving", account: "Block", workstream: "escalations", initiative: null, rule_id: "incidents", mode: "draft", question: null, options: null, channel: "c1", buzz_root: "r".repeat(64), status: "open", ...over }) as unknown as Task;

describe("task posts", () => {
  it("reads a task post the hub builds, with its source and the agents' part", () => {
    const source = eventDetails({ source: "table.incident", external_id: "ES-2373918", occurred_at: 1795104122, payload: { sev: "Sev1", has_prca: false, INC_Ticket: "INC-6588", inc_status: "Mitigated", affected_services: "Model Serving" } });
    const text = taskMessage(task(), { agents: [AGENT], briefing: "**For agents: Block**\nModes: everything: draft\nProfile:\n## Account team\n- lots", source });
    expect(isTaskPost(text)).toBe(true);
    const post = parseTaskPost(text)!;
    expect(post).toMatchObject({ id: 65, title: "Incident ES-2373918 (Sev1, Mitigated): Model Serving", account: "Block", workstream: "escalations", rule: "incidents", mode: "draft", asksAgents: true, options: [] });
    expect(post.source?.kind).toBe("table.incident");
    expect(post.source?.when).toMatch(/^2026-11-19T/);
    // Short facts only, in order, without false, the agents' brief or what the title already says.
    expect(post.source?.facts).toEqual([{ label: "Inc ticket", value: "INC-6588" }]);
    const untitled = parseTaskPost(taskMessage(task({ title: "Incident ES-2373918" }), { source }))!;
    expect(untitled.source?.facts.map((fact) => fact.label)).toEqual(["Sev", "Inc ticket", "Inc status", "Affected services"]);
  });

  it("reads a calendar task with its question, attendees and customer count", () => {
    const source = eventDetails(
      { source: "google_calendar", external_id: "e", url: "https://calendar.example/e", payload: { start: { dateTime: "2026-11-26T15:00:00-08:00", timeZone: "America/Los_Angeles" }, end: { dateTime: "2026-11-26T15:25:00-08:00", timeZone: "America/Los_Angeles" }, attendees: [{ email: "shams@block.xyz", responseStatus: "accepted" }, { email: "alane@squareup.com" }, { email: "bkvarda@block.xyz" }, { email: "brandon.kvarda@databricks.com" }, { email: "aemro.amare@databricks.com" }], hangoutLink: "https://meet.google.com/x" } },
      ["block.xyz", "squareup.com"],
    );
    const text = taskMessage(task({ id: 75, title: "Prep: Tecton Migrations sync", workstream: "meeting prep", rule_id: "customer-meetings", mode: "ask", question: "Should agents work on its events from now on?", options: ["Always", "Just this one", "Never"] }), { source });
    const post = parseTaskPost(text)!;
    expect(post).toMatchObject({ id: 75, mode: "ask", question: "Should agents work on its events from now on?", options: ["Always", "Just this one", "Never"], asksAgents: false });
    expect(post.source).toMatchObject({ kind: "google_calendar", url: "https://calendar.example/e", where: "https://meet.google.com/x" });
    expect(post.source?.facts[0]).toEqual({ label: "Attendees", value: "5 · 2 customer" });
    expect(shortWhen(post.source!.when!)).toBe("Nov 26, 15:00 GMT-8");
  });

  it("reads a Slack task as it's posted live: who said it, where, and what", () => {
    const text = [
      "📌 **Task 69: Slack: @Brandon Kvarda curious question, where did Block perform benchmarking as we did not even launch the model**",
      "Account: Block · Workstream: questions · Rule: customer-slack",
      "Mode: draft (agents prepare it; a person sends it)",
      "",
      "**Source** (slack): https://databricks.enterprise.slack.com/archives/C0CF5G6R8Q3/p1795115061291679",
      "When: 2026-11-19T19:04:21.000Z",
      "From: hema.ramrakhyani@databricks.com",
      "Details: from: Hema Ramrakhyani <hema.ramrakhyani@databricks.com>; text: @Brandon Kvarda curious question, where did Block perform benchmarking; as we did not even launch the model; channel: #block-fmapi-capacity-alerts; channel_id: C0CF5G6R8Q3; context_before: - From: Hema (ID: U0AU2PW4AH2)\n  Message_ts: 1795107909.656439",
      "",
      "Reply in this thread to work on it. Agents can update it with the signals_task tools.",
      `nostr:${npubEncode(AGENT)} please prepare this: …`,
    ].join("\n");
    const post = parseTaskPost(text)!;
    expect(post.source).toMatchObject({ kind: "slack", from: "Hema Ramrakhyani", where: "#block-fmapi-capacity-alerts" });
    // A semicolon inside the message stays in it: the split is only before a new key.
    expect(post.source?.quote).toBe("@Brandon Kvarda curious question, where did Block perform benchmarking; as we did not even launch the model");
    expect(post.source?.facts).toEqual([]);
    expect(post.asksAgents).toBe(true);
  });

  it("isn't fooled by other messages", () => {
    expect(isTaskPost("📌 **Task 3: something**\nno footer")).toBe(false);
    expect(parseTaskPost("hello")).toBeUndefined();
  });
});

describe("short titles", () => {
  const ES = "ES-2376026 For customer: [Block], workspace id: [2736046192934091] increase RPM/TPM rate limit for Gemini 4 Carbon";
  it("reads the source's own title from the line under **Source**", () => {
    const text = taskMessage(task({ title: "Capacity request: Gemini 4 Carbon in workspace 2736046192934091" }), { source: `**Source** (jira)\nTitle: ${ES}\nWhen: 2026-11-20T10:03:00Z\nDetails: status: To Do` });
    const post = parseTaskPost(text)!;
    expect(post.source).toMatchObject({ kind: "jira", title: ES, when: "2026-11-20T10:03:00Z" });
    expect(parseTaskPost(taskMessage(task(), { source: "**Source** (jira)\nWhen: 2026-11-20T10:03:00Z" }))!.source?.title).toBeUndefined();
  });

  it("says what a short title left out about the source it opened from: its own title and ticket key", () => {
    const jira = { source: "jira", external_id: "ES-2376026", title: ES };
    expect(taskOrigin("Capacity request: Gemini 4 Carbon in workspace 2736046192934091", jira)).toEqual({ original: ES, ref: "ES-2376026" });
    expect(titleHint("Capacity request: Gemini 4 Carbon", jira)).toBe(`Capacity request: Gemini 4 Carbon\nFrom Jira: ${ES}`);
    // The key comes from a Jira link or an id that is one, not from how a title starts.
    expect(taskOrigin("Capacity request: Neon", { source: "jira", external_id: "10233", url: "https://x.atlassian.net/browse/ES-2376508", title: "Neon quota" }).ref).toBe("ES-2376508");
    expect(taskOrigin("Slack: QBR prep", { source: "slack", external_id: "1795.12", title: "QBR-2026 prep: who's coming?" })).toEqual({ original: "QBR-2026 prep: who's coming?" });
    // A key the title already shows, as a whole word, isn't repeated; one that only starts the same is.
    expect(taskOrigin("Incident ES-2373918 (Sev1): Model Serving", { source: "table.incident", external_id: "ES-2373918" })).toEqual({});
    expect(taskOrigin("Follow up on ES-1234", { source: "jira", external_id: "ES-123" }).ref).toBe("ES-123");
    // A template that keeps the source's title adds nothing.
    expect(taskOrigin("Prep: Block  x Databricks sync", { source: "google_calendar", external_id: "ev1", title: "Block x Databricks sync" })).toEqual({});
    expect(taskOrigin("Anything", undefined)).toEqual({});
    expect(titleHint("Anything", undefined)).toBe("Anything");
  });

  it("finds a task by the ticket key it shows, even one only its Jira link has", () => {
    const item = { task: { id: 7, title: "Capacity request: Neon", status: "open", mode: "draft" }, people: [], artifacts: [], source: { source: "table.fmapi_429", title: "429s", occurred_at: 1 }, origin: { source: "jira", external_id: "10233", url: "https://x.atlassian.net/browse/ES-2376508" } } as unknown as BoardTask;
    expect(filterTasks([item], { search: "es-2376508" })).toHaveLength(1);
    expect(filterTasks([item], { search: "es-999" })).toHaveLength(0);
  });

  it("describes a post's own source, and takes from the live task only what's about that same source", () => {
    const alert = { source: "table.fmapi_429", external_id: "a1", title: "429s on databricks-gemini-4-carbon" };
    const jira = { source: "jira", external_id: "ES-2376026", title: ES };
    expect(postOrigin({ kind: "jira" }, jira)).toEqual({ source: "jira", external_id: "ES-2376026", title: ES });
    // A live task that opened from another source (or another link) lends nothing.
    expect(postOrigin({ kind: "jira" }, alert)).toEqual({ source: "jira" });
    expect(postOrigin({ kind: "jira", url: "https://x/browse/ES-1" }, { ...jira, url: "https://x/browse/ES-2" })).toEqual({ source: "jira", url: "https://x/browse/ES-1" });
    // The hub's Title: line wins over the live title.
    expect(postOrigin({ kind: "jira", title: "From the post" }, jira)).toMatchObject({ title: "From the post", external_id: "ES-2376026" });
    expect(postOrigin(undefined, jira)).toBeUndefined();
  });

  it("keeps the opening source's title for the full view after a grouped update", () => {
    const origin = { source: "jira", external_id: "ES-2376026", title: ES, url: "https://x.atlassian.net/browse/ES-2376026" };
    const task = { title: "Capacity request: Gemini 4 Carbon in workspace 2736046192934091" };
    // A 429 alert grouped onto the task is its latest event; the Jira summary still shows.
    expect(openingTitle({ task, source: { source: "table.fmapi_429", title: "429s on databricks-gemini-4-carbon" }, origin })).toEqual({ source: "jira", title: ES, url: origin.url });
    // When the latest event is the one it opened from, its source line already says it.
    expect(openingTitle({ task, source: { source: "jira", title: ES, url: origin.url }, origin })).toBeUndefined();
    // Another ticket grouped on with the same summary links elsewhere: the opening ticket's link still shows.
    expect(openingTitle({ task, source: { source: "jira", title: ES, url: "https://x.atlassian.net/browse/ES-820" }, origin })).toEqual({ source: "jira", title: ES, url: origin.url });
    // Nothing hidden, or no origin (tasks opened before the hub kept it): nothing extra.
    expect(openingTitle({ task: { title: `Prep: ${ES}` }, origin })).toBeUndefined();
    expect(openingTitle({ task, source: { source: "jira", title: ES } })).toBeUndefined();
    expect(openingTitle({ task, source: { source: "jira", title: ES }, origin: { source: "jira", external_id: "ES-1", title: ES } })).toBeUndefined();
    expect(openingTitle({ task, origin: null })).toBeUndefined();
  });

  it("says how a task was filed under its workstream, only when a category picked it", () => {
    expect(filedHint({ filed_by: "match" })).toBe("Matched a category rule");
    expect(filedHint({ filed_by: "classifier", filed_score: 0.857 })).toBe("Picked by the classifier (86%)");
    expect(filedHint({ filed_by: "classifier", filed_score: null })).toBe("Picked by the classifier");
    // The rule alone, or a task filed before the hub kept this, says nothing.
    expect(filedHint({ filed_by: "rule" })).toBeUndefined();
    expect(filedHint({ filed_by: null })).toBeUndefined();
    expect(filedHint({})).toBeUndefined();
    expect(workstreamHint({ workstream: "capacity requests", filed_by: "match" })).toBe("capacity requests\nMatched a category rule");
    expect(workstreamHint({ workstream: "escalation tracking", filed_by: "rule" })).toBe("escalation tracking");
    expect(workstreamHint({ workstream: null, filed_by: "match" })).toBeUndefined();
    const item = (fields: object) => ({ task: { id: 1, title: "t", status: "open", mode: "draft", workstream: "capacity requests", created_at: 1, last_event_at: 1, event_count: 1, ...fields }, people: [], artifacts: [] }) as unknown as BoardTask;
    expect(taskFacts(item({ filed_by: "classifier", filed_score: 0.91 }), 10).find((fact) => fact.label === "Workstream")).toEqual({ label: "Workstream", value: "capacity requests", note: "Picked by the classifier (91%)" });
    expect(taskFacts(item({ filed_by: null }), 10).find((fact) => fact.label === "Workstream")).toEqual({ label: "Workstream", value: "capacity requests" });
  });
});

describe("thread posts", () => {
  it("reads the hub's question, done, nudge and answer replies", () => {
    const asked = questionMessage(task({ question: "Send Draft 2 now?", options: ["Send now", "Wait for PRCA"] }), AGENT);
    expect(parseThreadPost(asked)).toEqual({ kind: "question", by: `nostr:${npubEncode(AGENT)}`, question: "Send Draft 2 now?", options: ["Send now", "Wait for PRCA"] });
    expect(parseThreadPost(doneMessage("the meeting has ended"))).toEqual({ kind: "done", reason: "the meeting has ended" });
    expect(parseThreadPost("⏰ No one has replied in 2 days.")).toEqual({ kind: "nudge", text: "No one has replied in 2 days." });
    const answered = answerMessage(task({ question: "Send Draft 2 now?" }), "brandon@x.com", "Send now", [AGENT]);
    expect(parseThreadPost(answered)).toEqual({ kind: "answered", who: "brandon@x.com", answer: "Send now", question: "Send Draft 2 now?", forAgents: true });
    expect(parseThreadPost("brandon.kvarda@databricks.com set this to **dismissed**")).toEqual({ kind: "status", text: "brandon.kvarda@databricks.com set this to **dismissed**" });
  });

  it("reads updates, with what changed and whether agents were asked", () => {
    expect(parseThreadPost("Update: Case 01060787 (Normal): Open")).toEqual({ kind: "update", title: "Case 01060787 (Normal): Open", changes: [], forAgents: false });
    expect(parseThreadPost("Update: [lucas/dbx buzz sync](https://calendar.example/e)")).toMatchObject({ kind: "update", title: "lucas/dbx buzz sync", url: "https://calendar.example/e" });
    const changed = changedMessage(task(), "Update: Case 01060787 (Normal): Open", [{ field: "es_status", from: "(none)", to: "Mitigated" }], [AGENT], "**For agents: Block**\nProfile: …");
    expect(parseThreadPost(changed)).toEqual({ kind: "update", title: "Case 01060787 (Normal): Open", changes: [{ field: "es_status", from: "(none)", to: "Mitigated" }], forAgents: true });
  });

  it("leaves other replies alone", () => {
    expect(parseThreadPost("Here's the draft you asked for.")).toBeUndefined();
  });
});

describe("helpers", () => {
  it("splits details only where a key starts, and names people", () => {
    expect(detailPairs("a: 1; b: x; y; c_d: [1]")).toEqual([["a", "1"], ["b", "x; y"], ["c_d", "[1]"]]);
    expect(personName("Hema R <h@x.com>")).toBe("Hema R");
    expect(personName("h@x.com")).toBe("h@x.com");
    expect(sourceName("table.incident")).toBe("Incident");
    expect(sourceName("google_calendar")).toBe("Calendar");
  });

  it("previews an agent's reply as one plain line", () => {
    const genie = npubEncode(AGENT);
    // As seen on task 79's card: a link, a mention, formatting and a list.
    expect(plainLine(`## Done\n**Draft** ready: [Globex test one-line format](https://adb-1.azuredatabricks.net/x?o=1) for nostr:${genie}\n- uses \`ai_query\`\n> *quoted*`, (npub) => (npub === genie ? "Genie" : undefined)))
      .toBe("Done Draft ready: Globex test one-line format for @Genie uses ai_query quoted");
    // The hub cuts long replies short, sometimes inside a link's URL.
    expect(plainLine("See [the doc](https://adb-123.azuredatabricks.net/one/chat/thr…")).toBe("See the doc");
    expect(plainLine(`nostr:${genie} ok`)).toBe(`@${genie.slice(0, 12)}… ok`);
    // The hub's activity names who it assigned as agent:npub… / person:npub…, without nostr:.
    expect(plainLine(`Assigned agent:${genie}, person:${genie}, carol@x.com`, (npub) => (npub === genie ? "Genie" : undefined))).toBe("Assigned @Genie, @Genie, carol@x.com");
    expect(plainLine(`Took agent:${genie} off it`)).toBe(`Took @${genie.slice(0, 12)}… off it`);
    expect(plainLine("```sql\nselect 1\n```\n![chart](https://x/y.png) <https://x.example/a> 2 * 3 = 6, snake_case_name")).toBe("select 1 chart https://x.example/a 2 * 3 = 6, snake_case_name");
  });

  it("reads a time ahead, like a meeting's start, as in …", () => {
    const now = 1_795_000_000_000;
    expect(ago(now - 30_000, now)).toBe("just now");
    expect(ago(now + 30_000, now)).toBe("just now");
    expect(ago(now - 5 * 60_000, now)).toBe("5m ago");
    expect(ago(now + 5 * 60_000, now)).toBe("in 5m");
    expect(ago(now + 3 * 3_600_000, now)).toBe("in 3h");
    expect(ago(now + 2_200_000_000, now)).toBe("in 25d");
    expect(ago(now - 2 * 86_400_000, now)).toBe("2d ago");
  });

  it("round-trips the task panel's target", () => {
    expect(readTaskTarget(taskTarget("cd524d72-32a3", 65))).toEqual({ channel: "cd524d72-32a3", id: 65 });
    expect(readTaskTarget("https://example.com")).toBeUndefined();
  });
});
