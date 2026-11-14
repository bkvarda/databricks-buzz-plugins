// A hosted agent shows as typing while it works (what Buzz on a phone shows as
// "working"): kind 20002 where its reply goes, every 3 seconds until the turn ends.
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Conversation } from "../plugins/agents/runner/buzz";
import { TYPING_PULSE_MS, Typing, typingTemplate } from "../plugins/agents/runner/typing";

const thread = (root: string): Conversation => ({ key: `general/${root}`, channel: "general", root, topLevel: false, dm: false, fresh: false });
const solo: Conversation = { key: "solo1", channel: "solo1", root: "m1", topLevel: true, dm: false, fresh: false };

afterEach(() => vi.useRealTimers());

describe("typing while a hosted agent works", () => {
  it("types where the reply goes: under the thread, or in the channel for a Solo chat", () => {
    expect(typingTemplate(thread("m1"), { id: "m1" }).tags).toEqual([
      ["h", "general"],
      ["e", "m1", "", "reply"],
    ]);
    expect(typingTemplate(thread("r1"), { id: "m2" }).tags).toEqual([
      ["h", "general"],
      ["e", "r1", "", "root"],
      ["e", "m2", "", "reply"],
    ]);
    expect(typingTemplate(solo, { id: "m1" })).toMatchObject({ kind: 20002, content: "", tags: [["h", "solo1"]] });
  });

  it("pulses every 3 seconds until the turn ends, once per conversation", async () => {
    vi.useFakeTimers();
    const sent: unknown[] = [];
    const typing = new Typing(async (template) => sent.push(template), () => {});
    const first = typing.start(thread("m1"), { id: "m1" });
    const second = typing.start(thread("m1"), { id: "m1" });
    expect(sent).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(TYPING_PULSE_MS * 2);
    expect(sent).toHaveLength(3);
    first();
    await vi.advanceTimersByTimeAsync(TYPING_PULSE_MS);
    expect(sent).toHaveLength(4);
    second();
    await vi.advanceTimersByTimeAsync(TYPING_PULSE_MS * 3);
    expect(sent).toHaveLength(4);
  });

  it("gives up quietly when the community keeps refusing it", async () => {
    vi.useFakeTimers();
    let tries = 0;
    const logged: string[] = [];
    const typing = new Typing(
      async () => {
        tries++;
        throw new Error("refused");
      },
      (line) => logged.push(line),
    );
    const stop = typing.start(thread("m1"), { id: "m1" });
    await vi.advanceTimersByTimeAsync(TYPING_PULSE_MS * 10);
    expect(tries).toBe(3);
    expect(logged).toEqual(["stopped showing typing in general/m1: refused"]);
    stop();
  });
});
