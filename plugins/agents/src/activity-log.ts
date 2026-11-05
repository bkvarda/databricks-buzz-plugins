// The local Databricks type's turn records, for its Activity tab: each turn's
// steps and thinking, kept on this device (the last 25 turns per agent). A turn
// reporter also sends each step to Buzz, which shows the latest one under the
// request.
import type { Agents, Delivery } from "@buzz/author";
import { type ActivityTurn, addItem, describeStep, snippet, type Step, stepText, thoughtStep, type ToolLabels } from "./activity";

const PREFIX = "bkvarda.databricks-activity.v1:";
const KEEP = 25;

export type TurnReporter = Readonly<{
  /** A tool call or other step, by its raw name: shown in Buzz and recorded. */
  tool(tool: string, target?: string): void;
  /** A step already in words. */
  step(step: Step): void;
  thought(text: string): void;
  note(text: string): void;
  end(outcome: NonNullable<ActivityTurn["outcome"]>, error?: string): void;
}>;

export class ActivityLog {
  private readonly cache = new Map<string, ActivityTurn[]>();
  private readonly listeners = new Set<() => void>();
  private readonly pending = new Map<string, ReturnType<typeof setTimeout>>();

  constructor(private readonly storage: Agents["storage"]) {}

  /** The agent's turns, newest first. */
  turns(agent: string): readonly ActivityTurn[] {
    let turns = this.cache.get(agent);
    if (!turns) {
      try {
        turns = JSON.parse(this.storage.get(PREFIX + agent) ?? "[]") as ActivityTurn[];
      } catch {
        turns = [];
      }
      this.cache.set(agent, turns);
    }
    return turns;
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private changed(agent: string) {
    // A new list each change, so a view reading it as a snapshot sees it.
    this.cache.set(agent, [...this.turns(agent)]);
    for (const listener of this.listeners) listener();
    if (this.pending.has(agent)) return;
    this.pending.set(
      agent,
      setTimeout(() => {
        this.pending.delete(agent);
        void this.storage.set(PREFIX + agent, JSON.stringify(this.turns(agent).slice(0, KEEP))).catch(() => {});
      }, 1000),
    );
  }

  /** Starts recording a turn; its steps also go to Buzz through `delivery.step`. */
  start(delivery: Delivery, init: Readonly<{ channelId?: string; root?: string; request?: string; labels?: ToolLabels }>): TurnReporter {
    const agent = delivery.agent.pubkey;
    const turn: ActivityTurn = {
      id: crypto.randomUUID(),
      startedAt: Date.now(),
      items: [],
      ...(init.channelId && { channelId: init.channelId }),
      ...(init.root && { root: init.root }),
      ...(init.request && { request: snippet(init.request, 300) }),
    };
    const turns = [turn, ...this.turns(agent).filter((existing) => existing.id !== turn.id)].slice(0, KEEP);
    this.cache.set(agent, turns);
    this.changed(agent);
    const show = (step: Step) => {
      delivery.step?.(step.tool, step.target);
      addItem(turn, { at: Date.now(), kind: "step", text: stepText(step) });
      this.changed(agent);
    };
    return {
      tool: (tool, target) => show(describeStep(tool, target, init.labels)),
      step: show,
      thought: (text) => {
        if (!text.trim()) return;
        const step = thoughtStep(text);
        delivery.step?.(step.tool, step.target);
        addItem(turn, { at: Date.now(), kind: "thought", text });
        this.changed(agent);
      },
      note: (text) => {
        addItem(turn, { at: Date.now(), kind: "note", text });
        this.changed(agent);
      },
      end: (outcome, error) => {
        turn.endedAt = Date.now();
        turn.outcome = outcome;
        if (error) turn.error = snippet(error, 500);
        this.changed(agent);
      },
    };
  }
}
