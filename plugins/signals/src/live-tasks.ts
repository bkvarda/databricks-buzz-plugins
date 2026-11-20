// Tasks as the hub has them now, for the cards on the hub's posts. A channel
// can show dozens of task posts at once, so each channel's board is read once
// and shared by every card in it, again after `STALE_MS`, and at once after
// an action on one of its tasks.
import type { DatabricksService } from "@dbx/core/service";
import { type BoardTask, chosenHub, HubClient } from "./client";

const STALE_MS = 30_000;

type Board = Readonly<{ tasks: readonly BoardTask[]; at: number }>;
/** errorAt: when a read last failed, so a hub that's down isn't asked on every render. */
type Entry = { board?: Board; error?: Error; errorAt?: number; pending?: Promise<void> };

export class LiveTasks {
  private hub?: Readonly<{ key: string; client: Promise<HubClient | undefined> }>;
  private readonly boards = new Map<string, Entry>();
  private readonly listeners = new Set<() => void>();
  private version = 0;

  constructor(readonly service: DatabricksService) {}

  /** Changes whenever a board is read, for useSyncExternalStore. */
  readonly snapshot = () => this.version;

  readonly subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => void this.listeners.delete(listener);
  };

  private notify() {
    this.version++;
    for (const listener of [...this.listeners]) listener();
  }

  /** Whether Databricks is connected, so the hub can be asked. */
  connected(): boolean {
    return this.service.snapshot().status === "connected";
  }

  /** The hub as the signed-in person, found once per workspace. */
  client(): Promise<HubClient | undefined> {
    const snapshot = this.service.snapshot();
    if (snapshot.status !== "connected") return Promise.resolve(undefined);
    const key = "profile" in snapshot ? snapshot.profile.host : "connected";
    if (this.hub?.key !== key) {
      const client = chosenHub(this.service)
        .then((found) => (found.app ? new HubClient(this.service.client()!, found.app) : undefined))
        // A failed lookup is tried again on the next read.
        .catch((error: Error) => ((this.hub = undefined), Promise.reject(error)));
      this.hub = { key, client };
    }
    return this.hub.client;
  }

  /** A channel's board as last read, reading it (again) when it's missing or stale. */
  board(channel: string): Entry {
    const entry = this.boards.get(channel) ?? {};
    if (!this.boards.has(channel)) this.boards.set(channel, entry);
    if (!entry.pending && this.connected() && (!entry.board || Date.now() - entry.board.at > STALE_MS) && !(entry.error && !entry.board && Date.now() - (entry.errorAt ?? 0) < STALE_MS)) void this.load(channel);
    return entry;
  }

  /** The task as the hub has it now, if its channel's board was read. */
  task(channel: string, id: number): BoardTask | undefined {
    return this.board(channel).board?.tasks.find((item) => item.task.id === id);
  }

  /** The task whose thread starts at `root`, if its channel's board was read. */
  byRoot(channel: string, root: string): BoardTask | undefined {
    return this.board(channel).board?.tasks.find((item) => item.task.buzz_root === root);
  }

  /** Whether a channel's board is being read and none is shown yet. */
  loading(channel: string): boolean {
    const entry = this.boards.get(channel);
    return Boolean(entry?.pending && !entry.board);
  }

  /** Reads a channel's board now (after an action on one of its tasks, say). */
  load(channel: string): Promise<void> {
    const entry = this.boards.get(channel) ?? {};
    this.boards.set(channel, entry);
    if (entry.pending) return entry.pending;
    entry.pending = (async () => {
      try {
        const hub = await this.client();
        if (!hub) return;
        const read = await hub.board(channel);
        entry.board = { tasks: read.tasks, at: Date.now() };
        entry.error = undefined;
      } catch (error) {
        entry.error = error instanceof Error ? error : new Error(String(error));
        entry.errorAt = Date.now();
      } finally {
        entry.pending = undefined;
        this.notify();
      }
    })();
    this.notify();
    return entry.pending;
  }

  /** Answers what a task asks, then reads its board again so every card shows the answer. */
  async answer(channel: string, id: number, input: string): Promise<void> {
    const hub = await this.client();
    if (!hub) throw new Error("There's no signals hub in your Databricks workspace.");
    await hub.updateTask({ id, input });
    await this.load(channel);
  }
}
