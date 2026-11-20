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
