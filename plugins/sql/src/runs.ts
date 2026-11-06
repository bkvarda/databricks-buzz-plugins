// Runs of SQL statements started from conversations and the SQL page. The
// code-block action and its presentation are separate components, so they
// share run state here, keyed by the statement text. Runs belong to the
// plugin, not a page, so one keeps going while you're elsewhere in Buzz; a
// workspace change stops and forgets them.
import { isReadOnlySql, Sql } from "@dbx/core/api/sql";
import type { ResultSet } from "@dbx/core/result";
import { type DatabricksService, describeError } from "@dbx/core/service";
import { resolveWarehouse } from "@dbx/core/warehouse";

export type Run =
  | { status: "confirm" }
  | { status: "running"; startedAt: number; statementId?: string; warehouse?: string }
  /** `ms` is unknown for a run picked up after a restart that finished meanwhile. */
  | { status: "done"; result: ResultSet; statementId: string; ms?: number; warehouse: string }
  | { status: "error"; message: string };

export { resolveWarehouse };

const hostOf = (service: DatabricksService) => {
  const snapshot = service.snapshot();
  return snapshot.status === "connected" ? snapshot.profile.host : undefined;
};

export class Runs {
  private runs = new Map<string, Run>();
  private controllers = new Map<string, AbortController>();
  private listeners = new Set<() => void>();
  private version = 0;

  private host: string | undefined;

  constructor(private readonly service: DatabricksService) {
    this.host = hostOf(service);
  }

  /** Stops and forgets every run when the workspace changes; returns the unsubscribe. */
  watchWorkspace(): () => void {
    return this.service.subscribe(() => {
      const host = hostOf(this.service);
      if (host === this.host) return;
      this.host = host;
      for (const controller of this.controllers.values()) controller.abort();
      this.controllers.clear();
      this.runs.clear();
      this.bump();
    });
  }

  get(code: string): Run | undefined {
    return this.runs.get(code.trim());
  }
  snapshot = () => this.version;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  /** Runs read-only statements at once; anything else asks first. */
  request(code: string): void {
    const key = code.trim();
    if (!isReadOnlySql(key)) this.set(key, { status: "confirm" });
    else void this.run(key);
  }

  async run(code: string): Promise<void> {
    const key = code.trim();
    this.controllers.get(key)?.abort();
    const controller = new AbortController();
    this.controllers.set(key, controller);
    const startedAt = Date.now();
    this.set(key, { status: "running", startedAt });
    try {
      const warehouse = await resolveWarehouse(this.service);
      const client = await this.service.ready(controller.signal);
      const { statementId, result } = await new Sql(client).execute(key, {
        warehouseId: warehouse.id,
        rowLimit: 1000,
        signal: controller.signal,
        onStatement: (id) => this.set(key, { status: "running", startedAt, statementId: id, warehouse: warehouse.name }),
      });
      this.set(key, { status: "done", result, statementId, ms: Date.now() - startedAt, warehouse: warehouse.name });
    } catch (error) {
      if (controller.signal.aborted) this.clear(key);
      else this.set(key, { status: "error", message: describeError(error) });
    }
  }

  /** Shows a statement started earlier (before a restart) again: Databricks
   * gives its result back by statement ID, or a running one's when it ends. */
  async resume(code: string, earlier: Readonly<{ statementId: string; startedAt: number; warehouse?: string; ms?: number }>): Promise<void> {
    const key = code.trim();
    if (this.runs.has(key)) return;
    const controller = new AbortController();
    this.controllers.set(key, controller);
    this.set(key, { status: "running", startedAt: earlier.startedAt, statementId: earlier.statementId, ...(earlier.warehouse && { warehouse: earlier.warehouse }) });
    try {
      const client = await this.service.ready(controller.signal);
      const { statementId, result } = await new Sql(client).resume(earlier.statementId, { signal: controller.signal });
      this.set(key, { status: "done", result, statementId, ...(earlier.ms !== undefined && { ms: earlier.ms }), warehouse: earlier.warehouse ?? "SQL warehouse" });
    } catch (error) {
      if (controller.signal.aborted) this.clear(key);
      else this.set(key, { status: "error", message: describeError(error) });
    } finally {
      if (this.controllers.get(key) === controller) this.controllers.delete(key);
    }
  }

  cancel(code: string) {
    this.controllers.get(code.trim())?.abort();
    this.clear(code);
  }

  clear(code: string) {
    this.runs.delete(code.trim());
    this.bump();
  }

  private set(key: string, run: Run) {
    this.runs.set(key, run);
    this.bump();
  }
  private bump() {
    this.version++;
    for (const listener of [...this.listeners]) listener();
  }
}
