// The SQL warehouse to use: the person's default (Settings → Databricks), else
// the best available (running serverless first).
import { Sql } from "./api/sql";
import type { DatabricksService } from "./service";

export async function resolveWarehouse(service: DatabricksService, explicit?: string): Promise<{ id: string; name: string }> {
  const client = await service.ready();
  const sql = new Sql(client);
  const warehouses = await sql.warehouses();
  const preferred = explicit || service.preferences.get<string>("warehouseId");
  const chosen = (preferred && warehouses.find((w) => w.id === preferred || w.name === preferred)) || Sql.pick(warehouses);
  if (!chosen) throw new Error("No SQL warehouse is available to you in this workspace.");
  return { id: chosen.id, name: chosen.name };
}
