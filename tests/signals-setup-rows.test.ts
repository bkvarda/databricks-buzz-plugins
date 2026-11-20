// Signals: the Set up account form's workstream rows (src/workstream-actions.ts): starting a row, ticking and rewording actions, and mode lines.
import { describe, expect, it } from "vitest";
import { MODES, parsePreferences, readWorkstreamActions } from "../plugins/signals/app/model";
import { newActionId, retrigger, rowChoices, rowSummary, startRow, toggle, withMode } from "../plugins/signals/src/workstream-actions";

describe("setup rows", () => {
  it("starts a row from the catalog, by name or alias, or as track only", () => {
    const support = startRow("Support");
    expect(support.otherwise).toBe("dismiss");
    expect(support.watch.map((item) => item.id)).toEqual(["escalate-if-needed", "confirm-workaround", "engage-engineering"]);
    expect(support.watch.some((item) => "recommended" in item)).toBe(false);
    expect(startRow("es-capacity-requests").watch.map((item) => item.id)).toEqual(["draft-request", "nudge-request", "customer-update"]);
    expect(startRow("renewals")).toEqual({ watch: [], otherwise: "track" });
    // What setup saves passes the hub's check.
    expect(typeof readWorkstreamActions({ support: support, tickets: startRow("tickets") })).toBe("object");
  });

  it("offers the catalog's actions in order, then the team's own, and keeps that order when ticking", () => {
    let row = startRow("support cases");
    const own = { id: newActionId("Loop in the CSM", row, "support cases"), label: "Loop in the CSM", trigger: "The customer mentions renewal" };
    expect(own.id).toBe("loop-in-the-csm");
    row = toggle("support cases", row, own, true);
    const workIt = rowChoices("support cases", row).find((choice) => choice.action.id === "work-it")!;
    expect(workIt.ticked).toBe(false);
    row = toggle("support cases", row, workIt.action, true);
    expect(row.watch.map((item) => item.id)).toEqual(["work-it", "escalate-if-needed", "confirm-workaround", "engage-engineering", "loop-in-the-csm"]);
    expect(rowChoices("support cases", row).map((choice) => [choice.action.id, choice.ticked, choice.custom])).toEqual([
      ["work-it", true, false],
      ["escalate-if-needed", true, false],
      ["confirm-workaround", true, false],
      ["engage-engineering", true, false],
      ["loop-in-the-csm", true, true],
    ]);
    // Ticking twice does nothing; unticking drops it.
    expect(toggle("support cases", row, own, true)).toBe(row);
    expect(toggle("support cases", row, own, false).watch.some((item) => item.id === own.id)).toBe(false);
    // An id never repeats a catalog one or one already in the row.
    expect(newActionId("Work it!", row, "support cases")).toBe("work-it-2");
    expect(newActionId("Loop in the CSM", row, "support cases")).toBe("loop-in-the-csm-2");
    expect(newActionId("???", row, "support cases")).toBe("action");
  });

  it("rewords a trigger in place, and ticks an unticked action it rewords", () => {
    const row = startRow("support cases");
    const edited = retrigger("support cases", row, row.watch[0]!, "  Sentiment is poor  ");
    expect(edited.watch[0]).toEqual({ ...row.watch[0], trigger: "Sentiment is poor" });
    expect(edited.watch.length).toBe(row.watch.length);
    // The choices show the team's wording, not the catalog's.
    expect(rowChoices("support cases", edited)[1]!.action.trigger).toBe("Sentiment is poor");
    const tickets = startRow("tickets");
    const update = rowChoices("tickets", tickets).find((choice) => !choice.ticked)!.action;
    expect(retrigger("tickets", tickets, update, "Any change").watch.map((item) => [item.id, item.trigger]).at(-1)).toEqual(["customer-update", "Any change"]);
  });

  it("sums a row up in a line", () => {
    const map = { "Support Cases": startRow("support cases") };
    expect(rowSummary(undefined)).toBe("Agents work every task");
    expect(rowSummary({ watch: [], otherwise: "track" })).toBe("Track only");
    expect(rowSummary({ watch: [], otherwise: "dismiss" })).toBe("Dismiss everything");
    expect(rowSummary(map["Support Cases"])).toBe("Watch for 3 · otherwise dismiss");
    expect(rowSummary({ watch: [{ id: "work-it", label: "Work it", trigger: "", always: true }], otherwise: "dismiss" })).toBe("Work every task");
    expect(rowSummary({ watch: [{ id: "work-it", label: "Work it", trigger: "", always: true }, ...map["Support Cases"].watch], otherwise: "dismiss" })).toBe("Work every task · also watch for 3");
  });

  it("sets, changes and clears a workstream's mode line, leaving guidance alone", () => {
    const text = "How agents work.\n\n- everything: draft\n- Tickets: draft\n\nTickets: see the runbook first.";
    const auto = withMode(text, "tickets", "auto", MODES);
    expect(auto).toBe("How agents work.\n\n- everything: draft\n- tickets: auto\n\nTickets: see the runbook first.");
    expect(parsePreferences(auto).modes.tickets).toBe("auto");
    const cleared = withMode(auto, "tickets", undefined, MODES);
    expect(cleared).toBe("How agents work.\n\n- everything: draft\n\nTickets: see the runbook first.");
    expect(parsePreferences(cleared).modes.tickets).toBeUndefined();
    // A new line goes after the other mode lines; nothing to clear leaves the text as it was.
    expect(withMode(text, "support cases", "ask", MODES)).toBe("How agents work.\n\n- everything: draft\n- Tickets: draft\n- support cases: ask\n\nTickets: see the runbook first.");
    expect(withMode(text, "support cases", undefined, MODES)).toBe(text);
    expect(withMode("", "everything", "auto", MODES)).toBe("- everything: auto");
    expect(withMode("Be brief.", "everything", "off", MODES)).toBe("- everything: off\n\nBe brief.");
    // Names with regex characters are taken literally.
    expect(parsePreferences(withMode("- c++ (beta): draft", "c++ (beta)", "auto", MODES)).modes["c++ (beta)"]).toBe("auto");
  });
});
