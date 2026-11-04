// Runs of SQL statements started from conversations and the SQL page. The
// code-block action and its presentation are separate components, so they
// share run state here, keyed by the statement text.
import { isReadOnlySql, Sql } from "@dbx/core/api/sql";
import type { ResultSet } from "@dbx/core/result";
import { type DatabricksService, describeError } from "@dbx/core/service";

export type Run =
  | { status: "confirm" }
  | { status: "running"; startedAt: number; statementId?: string }
  | { status: "done"; result: ResultSet; statementId: string; ms: number; warehouse: string }
  | { status: "error"; message: string };

export async function resolveWarehouse(service: DatabricksService, explicit?: string): Promise<{ id: string; name: string }> {
  const client = await service.ready();
  const sql = new Sql(client);
  const warehouses = await sql.warehouses();
  const preferred = explicit || service.preferences.get<string>("warehouseId");
  const chosen = (preferred && warehouses.find((w) => w.id === preferred || w.name === preferred)) || Sql.pick(warehouses);
  if (!chosen) throw new Error("No SQL warehouse is available to you in this workspace.");
  return { id: chosen.id, name: chosen.name };
}

export class Runs {
  private runs = new Map<string, Run>();
  private controllers = new Map<string, AbortController>();
  private listeners = new Set<() => void>();
  private version = 0;

  constructor(private readonly service: DatabricksService) {}

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
        onStatement: (id) => this.set(key, { status: "running", startedAt, statementId: id }),
      });
      this.set(key, { status: "done", result, statementId, ms: Date.now() - startedAt, warehouse: warehouse.name });
    } catch (error) {
      if (controller.signal.aborted) this.clear(key);
      else this.set(key, { status: "error", message: describeError(error) });
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
