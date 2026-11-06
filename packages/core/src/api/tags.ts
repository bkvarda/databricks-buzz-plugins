// Unity Catalog tags: assigning them to securables (including skills, which
// SQL's SET TAGS can't do), and finding tagged schemas with one query.
//
// Schema tags drive discovery across the whole metastore: skills schemas
// carry SKILLS_TAG, a channel's schema carries CHANNEL_TAG = its channel ID,
// and a domain's schemas carry the domain's governed tag. The information
// schema only shows what the person can see, so permissions apply for free.
import type { DatabricksClient } from "../client";
import { Sql } from "./sql";

/** Marks a schema whose skills agents should find. */
export const SKILLS_TAG = "agent_skills";
/** Links a schema to a Buzz channel; the value is the channel's ID. */
export const CHANNEL_TAG = "buzz_channel";
/** The domain a channel's schema belongs to; the value is the domain's ID. */
export const DOMAIN_TAG = "buzz_domain";

export type TagAssignment = Readonly<{ entity_type: string; entity_name: string; tag_key: string; tag_value?: string; inherited?: boolean }>;

export type SchemaTag = Readonly<{ catalog: string; schema: string; tag: string; value: string }>;

const quote = (value: string) => `'${value.replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'`;
const ident = (value: string) => `\`${value.replace(/`/g, "``")}\``;

export class Tags {
  constructor(private readonly client: DatabricksClient) {}

  /**
   * Sets a tag on a securable. `entityType` is the API's plural name:
   * catalogs, schemas, tables, volumes, functions, skills, … A tag that's
   * already there is updated.
   */
  async assign(entityType: string, entityName: string, key: string, value = ""): Promise<TagAssignment> {
    const body = { entity_type: entityType, entity_name: entityName, tag_key: key, ...(value && { tag_value: value }) };
    try {
      return await this.client.post<TagAssignment>("/api/2.1/unity-catalog/entity-tag-assignments", body);
    } catch (error) {
      const code = (error as { errorCode?: string }).errorCode;
      if (code !== "ALREADY_EXISTS" && code !== "RESOURCE_ALREADY_EXISTS") throw error;
      return this.client.json<TagAssignment>(
        `/api/2.1/unity-catalog/entity-tag-assignments/${entityType}/${encodeURIComponent(entityName)}/tags/${encodeURIComponent(key)}`,
        { method: "PATCH", body, query: { update_mask: "tag_value" } },
      );
    }
  }

  async list(entityType: string, entityName: string): Promise<TagAssignment[]> {
    const response = await this.client.get<{ tag_assignments?: TagAssignment[] }>(
      `/api/2.1/unity-catalog/entity-tag-assignments/${entityType}/${encodeURIComponent(entityName)}/tags`,
    );
    return response.tag_assignments ?? [];
  }

  remove(entityType: string, entityName: string, key: string): Promise<unknown> {
    return this.client.json(`/api/2.1/unity-catalog/entity-tag-assignments/${entityType}/${encodeURIComponent(entityName)}/tags/${encodeURIComponent(key)}`, {
      method: "DELETE",
    });
  }

  /**
   * Every schema the person can see that carries one of these tags (with
   * `value`, only that value), across all catalogs, in one SQL query.
   */
  async schemas(warehouseId: string, tags: readonly string[], value?: string, signal?: AbortSignal): Promise<SchemaTag[]> {
    if (!tags.length) return [];
    const statement =
      `SELECT catalog_name, schema_name, tag_name, tag_value FROM system.information_schema.schema_tags WHERE tag_name IN (${tags.map(quote).join(", ")})` +
      (value !== undefined ? ` AND tag_value = ${quote(value)}` : "") +
      " ORDER BY catalog_name, schema_name LIMIT 2000";
    const { result } = await new Sql(this.client).execute(statement, { warehouseId, rowLimit: 2000, timeoutMs: 120_000, ...(signal && { signal }) });
    return result.rows.map((row) => ({ catalog: String(row[0]), schema: String(row[1]), tag: String(row[2]), value: row[3] == null ? "" : String(row[3]) }));
  }

  /** Tags a schema through SQL (works for plain and governed tags you may assign). */
  async tagSchema(warehouseId: string, catalog: string, schema: string, tags: Readonly<Record<string, string>>): Promise<void> {
    const pairs = Object.entries(tags).map(([key, value]) => `${quote(key)} = ${quote(value)}`);
    if (!pairs.length) return;
    await new Sql(this.client).execute(`ALTER SCHEMA ${ident(catalog)}.${ident(schema)} SET TAGS (${pairs.join(", ")})`, { warehouseId, timeoutMs: 120_000 });
  }
}
