// A local Databricks agent mentioned by someone other than its owner: it says
// once, in that thread, that it only takes its owner's requests, tagging the
// person and the owner, and otherwise does nothing.
import { describe, expect, it } from "vitest";
import { noteOutsider, OUTSIDER_QUIET_MS, OUTSIDER_TEXT, OutsiderNotes, threadRoot } from "../plugins/agents/src/outsider";

const OWNER = "o".repeat(64);
const AGENT = "a".repeat(64);
const PERSON = "b".repeat(64);

function setup() {
  let clock = 1_000_000;
  const notes = new OutsiderNotes(OUTSIDER_QUIET_MS, () => clock);
  const published: { kind: number; content: string; tags?: readonly (readonly string[])[] }[] = [];
  let failing = false;
  const agent = {
    pubkey: AGENT,
    owner: OWNER,
    publish: async (event: (typeof published)[number]) => {
      if (failing) throw new Error("relay refused");
      published.push(event);
      return event;
    },
  };
  const mention = (from: string, tags: string[][] = [], id = `m-${Math.random()}`) => ({
    trigger: { type: "mention", event: { id, pubkey: from, tags: [["h", "general"], ["p", AGENT], ...tags] } },
    agent,
  });
  return {
    notes,
    published,
    mention,
    later: (ms: number) => (clock += ms),
    fail: () => (failing = true),
  };
}

describe("someone else mentions a Databricks agent", () => {
  it("gets one note in their thread, tagging them and the owner", async () => {
    const { notes, published, mention } = setup();
    expect(await noteOutsider(mention(PERSON, [], "m1"), notes)).toBe(true);
    expect(published).toEqual([
      {
        kind: 9,
        content: OUTSIDER_TEXT,
        tags: [
          ["h", "general"],
          ["e", "m1", "", "reply"],
          ["p", PERSON],
          ["p", OWNER],
        ],
      },
    ]);
  });

  it("stays quiet for the rest of the hour in that thread, but not in another", async () => {
    const { notes, published, mention, later } = setup();
    await noteOutsider(mention(PERSON, [], "m1"), notes);
    // A follow-up in the same thread.
    expect(await noteOutsider(mention(PERSON, [["e", "m1", "", "reply"]]), notes)).toBe(false);
    // A new thread, or another person, gets its own note.
    expect(await noteOutsider(mention(PERSON, [], "m2"), notes)).toBe(true);
    expect(await noteOutsider(mention("c".repeat(64), [["e", "m1", "", "reply"]]), notes)).toBe(true);
    later(OUTSIDER_QUIET_MS);
    expect(await noteOutsider(mention(PERSON, [["e", "m1", "", "reply"]]), notes)).toBe(true);
    expect(published).toHaveLength(4);
  });

  it("never answers its owner, itself, or anything but a mention this way", async () => {
    const { notes, published, mention } = setup();
    expect(await noteOutsider(mention(OWNER), notes)).toBe(false);
    expect(await noteOutsider(mention(AGENT), notes)).toBe(false);
    const wake = { ...mention(PERSON), trigger: { type: "plugin" } };
    expect(await noteOutsider(wake, notes)).toBe(false);
    const nowhere = { ...mention(PERSON), trigger: { type: "mention", event: { id: "x", pubkey: PERSON, tags: [["p", AGENT]] } } };
    expect(await noteOutsider(nowhere, notes)).toBe(false);
    expect(published).toHaveLength(0);
  });

  it("only logs when the note can't be sent", async () => {
    const { notes, mention, fail } = setup();
    fail();
    const warn = console.warn;
    console.warn = () => {};
    try {
      expect(await noteOutsider(mention(PERSON), notes)).toBe(false);
    } finally {
      console.warn = warn;
    }
  });

  it("finds the thread a message replies under", () => {
    expect(threadRoot({ id: "m", pubkey: PERSON, tags: [["e", "r", "", "root"], ["e", "p", "", "reply"]] })).toBe("r");
    expect(threadRoot({ id: "m", pubkey: PERSON, tags: [["e", "r", "", "reply"]] })).toBe("r");
    expect(threadRoot({ id: "m", pubkey: PERSON, tags: [] })).toBe("m");
  });
});
