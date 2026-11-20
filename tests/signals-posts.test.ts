// The cards on the hub's posts read back what the hub writes: these check the
// parser against the hub's own message builders and posts as they look live.
import { describe, expect, it } from "vitest";
import { npubEncode } from "nostr-tools/nip19";
import { answerMessage, changedMessage, doneMessage, eventDetails, questionMessage, taskMessage } from "../plugins/signals/app/hub";
import type { Task } from "../plugins/signals/app/store";
import { detailPairs, isTaskPost, parseTaskPost, parseThreadPost, personName, readTaskTarget, shortWhen, sourceName, taskTarget } from "../plugins/signals/src/posts";

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

  it("round-trips the task panel's target", () => {
    expect(readTaskTarget(taskTarget("cd524d72-32a3", 65))).toEqual({ channel: "cd524d72-32a3", id: 65 });
    expect(readTaskTarget("https://example.com")).toBeUndefined();
  });
});
