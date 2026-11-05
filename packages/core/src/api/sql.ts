// Databricks SQL: warehouses, the Statement Execution API and Unity Catalog
// browsing, all as the signed-in user so Unity Catalog permissions apply.
import type { DatabricksClient } from "../client";
import { fromStatement, type ResultSet } from "../result";

export type Warehouse = Readonly<{
  id: string;
  name: string;
  state?: string;
  cluster_size?: string;
  warehouse_type?: string;
  enable_serverless_compute?: boolean;
}>;

type StatementResponse = {
  statement_id: string;
  status?: { state?: string; error?: { message?: string; error_code?: string } };
} & Parameters<typeof fromStatement>[0];

export class StatementError extends Error {
  constructor(
    message: string,
    readonly statementId?: string,
    readonly state?: string,
  ) {
    super(message);
    this.name = "StatementError";
  }
}

const RUNNING = new Set(["PENDING", "RUNNING"]);
const EXPIRED = "Databricks no longer keeps this result. Run the statement again to see it.";

export class Sql {
  constructor(private readonly client: DatabricksClient) {}

  async warehouses(signal?: AbortSignal): Promise<Warehouse[]> {
    const response = await this.client.get<{ warehouses?: Warehouse[] }>("/api/2.0/sql/warehouses", signal ? { signal } : {});
    return response.warehouses ?? [];
  }

  /** The best default: running serverless, any serverless, running, first. */
  static pick(warehouses: readonly Warehouse[]): Warehouse | undefined {
    const score = (w: Warehouse) =>
      (w.enable_serverless_compute || w.warehouse_type === "SERVERLESS" ? 2 : 0) + (w.state === "RUNNING" ? 1 : 0);
    return [...warehouses].sort((a, b) => score(b) - score(a))[0];
  }

  /** Runs a statement and waits for its first result chunk. */
  async execute(
    statement: string,
    options: Readonly<{
      warehouseId: string;
      catalog?: string;
      schema?: string;
      rowLimit?: number;
      signal?: AbortSignal;
      timeoutMs?: number;
      onStatement?(id: string): void;
    }>,
  ): Promise<{ statementId: string; result: ResultSet }> {
    const signal = options.signal;
    let response = await this.client.post<StatementResponse>(
      "/api/2.0/sql/statements",
      {
        statement,
        warehouse_id: options.warehouseId,
        // Short, so the statement ID comes back soon: with it, a run cut off
        // (Buzz closing) can be picked up again.
        wait_timeout: "10s",
        on_wait_timeout: "CONTINUE",
        disposition: "INLINE",
        format: "JSON_ARRAY",
        row_limit: options.rowLimit ?? 1000,
        ...(options.catalog && { catalog: options.catalog }),
        ...(options.schema && { schema: options.schema }),
      },
      { timeoutMs: 30_000, ...(signal && { signal }) },
    );
    options.onStatement?.(response.statement_id);
    return this.follow(response, options);
  }

  /**
   * A statement started earlier, by its ID: waits for it if it's still
   * running, then returns its first result chunk. Databricks keeps a result
   * only for a while; after that this fails with `state` CLOSED.
   */
  async resume(
    statementId: string,
    options: Readonly<{ signal?: AbortSignal; timeoutMs?: number }> = {},
  ): Promise<{ statementId: string; result: ResultSet }> {
    const signal = options.signal;
    let response: StatementResponse;
    try {
      response = await this.client.get<StatementResponse>(`/api/2.0/sql/statements/${encodeURIComponent(statementId)}`, signal ? { signal } : {});
    } catch (error) {
      if ((error as { status?: number }).status === 404) throw new StatementError(EXPIRED, statementId, "CLOSED");
      throw error;
    }
    return this.follow(response, options);
  }

  private async follow(
    first: StatementResponse,
    options: Readonly<{ signal?: AbortSignal; timeoutMs?: number }>,
  ): Promise<{ statementId: string; result: ResultSet }> {
    const signal = options.signal;
    let response = first;
    const deadline = Date.now() + (options.timeoutMs ?? 5 * 60_000);
    const cancel = () => void this.cancel(response.statement_id).catch(() => {});
    signal?.addEventListener("abort", cancel, { once: true });
    try {
      let delay = 750;
      while (RUNNING.has(response.status?.state ?? "")) {
        if (Date.now() > deadline) {
          cancel();
          throw new StatementError("The query took too long and was cancelled.", response.statement_id, "CANCELED");
        }
        await new Promise((resolve) => setTimeout(resolve, delay));
        signal?.throwIfAborted();
        delay = Math.min(3000, delay * 1.5);
        response = await this.client.get<StatementResponse>(
          `/api/2.0/sql/statements/${encodeURIComponent(response.statement_id)}`,
          signal ? { signal } : {},
        );
      }
    } finally {
      signal?.removeEventListener("abort", cancel);
    }
    const state = response.status?.state;
    if (state === "CLOSED") throw new StatementError(EXPIRED, response.statement_id, state);
    if (state !== "SUCCEEDED")
      throw new StatementError(
        response.status?.error?.message ?? `The query ended as ${state ?? "unknown"}.`,
        response.statement_id,
        state,
      );
    return { statementId: response.statement_id, result: fromStatement(response) };
  }

  cancel(statementId: string) {
    return this.client.post(`/api/2.0/sql/statements/${encodeURIComponent(statementId)}/cancel`, {});
  }

  catalogs(signal?: AbortSignal) {
    return this.client
      .get<{ catalogs?: { name: string; comment?: string }[] }>("/api/2.1/unity-catalog/catalogs", signal ? { signal } : {})
      .then((response) => response.catalogs ?? []);
  }

  schemas(catalog: string, signal?: AbortSignal) {
    return this.client
      .get<{ schemas?: { name: string; full_name: string; comment?: string }[] }>("/api/2.1/unity-catalog/schemas", {
        query: { catalog_name: catalog },
        ...(signal && { signal }),
      })
      .then((response) => response.schemas ?? []);
  }

  tables(catalog: string, schema: string, signal?: AbortSignal) {
    return this.client
      .get<{ tables?: { name: string; full_name: string; table_type?: string; comment?: string }[] }>(
        "/api/2.1/unity-catalog/tables",
        { query: { catalog_name: catalog, schema_name: schema, max_results: 200 }, ...(signal && { signal }) },
      )
      .then((response) => response.tables ?? []);
  }

  table(fullName: string, signal?: AbortSignal) {
    return this.client.get<{
      full_name: string;
      table_type?: string;
      comment?: string;
      owner?: string;
      columns?: { name: string; type_text?: string; comment?: string; nullable?: boolean }[];
      updated_at?: number;
    }>(`/api/2.1/unity-catalog/tables/${encodeURIComponent(fullName)}`, signal ? { signal } : {});
  }
}

/** Whether a statement only reads. Conservative: anything unclear is a write. */
export function isReadOnlySql(statement: string): boolean {
  const stripped = statement
    .replace(/--[^\n]*/g, " ")
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/'(?:[^'\\]|\\.)*'/g, "''")
    .replace(/`[^`]*`/g, "``")
    .trim();
  const statements = stripped.split(";").map((part) => part.trim()).filter(Boolean);
  if (!statements.length) return false;
  return statements.every((part) => {
    const first = /^\(*\s*(\w+)/.exec(part)?.[1]?.toUpperCase();
    if (!first || !["SELECT", "WITH", "SHOW", "DESCRIBE", "DESC", "EXPLAIN", "VALUES", "TABLE", "LIST"].includes(first))
      return false;
    return !/\b(INSERT|UPDATE|DELETE|MERGE|DROP|CREATE|ALTER|TRUNCATE|GRANT|REVOKE|COPY|OPTIMIZE|VACUUM|REFRESH|RESTORE|CALL)\b/i.test(
      part.replace(/^WITH[\s\S]*?\bSELECT\b/i, "SELECT"),
    );
  });
}
