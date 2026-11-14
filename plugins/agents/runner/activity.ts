// What a hosted agent is doing, for its owner:
//   activity.jsonl  each turn's steps and thinking (../src/activity.ts), which
//                   the plugin's Activity tab reads from the Sandbox
//   activity frames what Buzz's own hosted agents send: kind 24200 events,
//                   NIP-44 encrypted to the owner, tagged p/agent/frame, with
//                   turn_started, turn_liveness and turn_completed and ACP
//                   session updates (tool calls, thoughts). Buzz shows the
//                   agent working under the request, with a live label and Stop.
// Frames are best effort: a refused one never stops a turn.
import { appendFileSync, existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { encrypt, getConversationKey } from "nostr-tools/nip44";
import { getPublicKey } from "nostr-tools/pure";
import { type ActivityLine, acpKind, describeStep, snippet, type Step, stepText, thoughtStep, type ToolLabels } from "../src/activity";
import type { HttpRelay } from "./http";

const KEEP_LINES = 3000;
const LIVENESS_MS = 10_000;
const FLUSH_MS = 1200;
const MAX_FRAME_TEXT = 8000;

/** Sends activity frames to the owner, a batch at a time. */
export class Observer {
  private readonly key: Uint8Array;
  private readonly agent: string;
  private queue: Record<string, unknown>[] = [];
  private timer: ReturnType<typeof setTimeout> | undefined;
  private refused = false;
  /** Numbers each frame, from 1 in each run, as Buzz's own agents do: Buzz on a phone tells same-millisecond frames apart by it. */
  private seq = 0;

  constructor(
    private readonly relay: HttpRelay,
    secret: Uint8Array,
    private readonly owner: string,
    private readonly log: (line: string) => void,
  ) {
    this.key = getConversationKey(secret, owner);
    this.agent = getPublicKey(secret);
  }

  send(event: Record<string, unknown>) {
    this.queue.push({ seq: ++this.seq, ...event });
    this.timer ??= setTimeout(() => void this.flush(), FLUSH_MS);
  }

  async flush() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    const events = this.queue.splice(0);
    if (!events.length) return;
    const plaintext = JSON.stringify(events.length === 1 ? events[0] : { kind: "batch", payload: { events } });
    try {
      await this.relay.publish({
        kind: 24200,
        created_at: Math.floor(Date.now() / 1000),
        content: encrypt(plaintext, this.key),
        tags: [
          ["p", this.owner],
          ["agent", this.agent],
          ["frame", "telemetry"],
        ],
      });
      if (this.refused) this.log("activity frames are getting through again");
      this.refused = false;
    } catch (error) {
      if (!this.refused) this.log(`couldn't send an activity frame: ${(error as Error).message}`);
      this.refused = true;
    }
  }
}

export type TurnActivity = Readonly<{
  tool(name: string, target?: string): void;
  step(step: Step): void;
  thought(text: string): void;
  end(outcome: "done" | "error" | "stopped", error?: string): Promise<void>;
}>;

/** The runner's activity: its log file, and frames for the owner's Buzz when an observer is given. */
export class RunnerActivity {
  constructor(
    private readonly path: string,
    private readonly observer?: Observer,
  ) {
    // Keep the log to its recent turns.
    try {
      if (existsSync(path) && statSync(path).size > 2 * 1024 * 1024) writeFileSync(path, `${readFileSync(path, "utf8").split("\n").slice(-KEEP_LINES).join("\n")}`);
    } catch {}
  }

  private write(line: ActivityLine) {
    try {
      appendFileSync(this.path, `${JSON.stringify(line)}\n`);
    } catch {}
  }

  start(input: Readonly<{ eventId: string; channel: string; root?: string; request: string; labels?: ToolLabels }>): TurnActivity {
    const turn = `${Date.now().toString(36)}-${input.eventId.slice(0, 8)}`;
    const observer = this.observer;
    const at = () => new Date().toISOString();
    const frame = (kind: string, payload?: Record<string, unknown>) => observer?.send({ kind, turnId: turn, channelId: input.channel, timestamp: at(), ...(payload && { payload }) });
    const update = (update: Record<string, unknown>) => frame("acp_read", { jsonrpc: "2.0", method: "session/update", params: { sessionId: turn, update } });
    let open: string | undefined;
    let calls = 0;
    const close = (status: "completed" | "failed") => {
      if (open) update({ sessionUpdate: "tool_call_update", toolCallId: open, status });
      open = undefined;
    };
    this.write({ turn, at: Date.now(), type: "start", channel: input.channel, ...(input.root && { root: input.root }), text: snippet(input.request, 300) });
    observer?.send({
      kind: "turn_started",
      turnId: turn,
      channelId: input.channel,
      timestamp: at(),
      startedAt: at(),
      payload: { source: "mention", triggeringEventIds: [input.eventId], ...(input.root && { threadRootEventId: input.root }) },
    });
    const liveness = setInterval(() => frame("turn_liveness"), LIVENESS_MS);
    liveness.unref();
    // Each step is an ACP tool call, open until the next one: Buzz labels the live work from it.
    const call = (step: Step) => {
      const text = stepText(step);
      close("completed");
      open = `${turn}-${++calls}`;
      const kind = acpKind(step);
      update({
        sessionUpdate: "tool_call",
        toolCallId: open,
        title: text.slice(0, 200),
        kind,
        status: "in_progress",
        ...(step.target && { rawInput: { target: step.target } }),
        ...((kind === "read" || kind === "edit") && step.target && { locations: [{ path: step.target }] }),
      });
    };
    const step = (step: Step) => {
      this.write({ turn, at: Date.now(), type: "step", text: stepText(step) });
      call(step);
    };
    return {
      tool: (name, target) => step(describeStep(name, target, input.labels)),
      step,
      thought: (text) => {
        if (!text.trim()) return;
        this.write({ turn, at: Date.now(), type: "thought", text: text.slice(0, 4000) });
        // Thinking shows as Buzz's "Working", with the text in the frame.
        call(thoughtStep(text));
        update({ sessionUpdate: "agent_thought_chunk", content: { type: "text", text: text.slice(0, MAX_FRAME_TEXT) } });
      },
      end: async (outcome, error) => {
        clearInterval(liveness);
        close(outcome === "done" ? "completed" : "failed");
        this.write({ turn, at: Date.now(), type: "end", outcome, ...(error && { error: snippet(error, 500) }) });
        frame(outcome === "error" ? "turn_error" : "turn_completed", outcome === "error" ? { error: snippet(error ?? "failed", 2000) } : outcome === "stopped" ? { outcome: "stopped" } : undefined);
        await observer?.flush();
      },
    };
  }
}
