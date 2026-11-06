// Unity Catalog reads and writes the channel features need beyond the core API
// modules: catalogs and schemas to pick from, and the governed tag policy a
// domain needs before it can be created.
import type { DatabricksClient } from "@dbx/core/client";
import { isApiError } from "@dbx/core/service";

/** Pages through a list endpoint, following `next_page_token` (an empty first page can still have one). */
async function everyPage<T>(load: (pageToken?: string) => Promise<{ items?: T[]; next_page_token?: string }>): Promise<T[]> {
  const items: T[] = [];
  let pageToken: string | undefined;
  for (let page = 0; page < 100; page++) {
    const response = await load(pageToken);
    items.push(...(response.items ?? []));
    pageToken = response.next_page_token;
    if (!pageToken) break;
  }
  return items;
}

/**
 * Catalogs a skills schema can go in. Skills need a standard catalog with
 * managed storage, so internal, system, shared (Delta Sharing), foreign and
 * Lakebase catalogs are left out.
 */
export async function listCatalogs(client: DatabricksClient): Promise<string[]> {
  const catalogs = await everyPage<{ name: string; catalog_type?: string }>(async (pageToken) => {
    const response = await client.get<{ catalogs?: { name: string; catalog_type?: string }[]; next_page_token?: string }>("/api/2.1/unity-catalog/catalogs", {
      query: { page_token: pageToken },
    });
    return { items: response.catalogs, next_page_token: response.next_page_token };
  });
  return catalogs
    .filter((catalog) => !catalog.catalog_type || catalog.catalog_type === "MANAGED_CATALOG")
    .map((catalog) => catalog.name)
    .sort((a, b) => a.localeCompare(b));
}

/** Schemas in a catalog, without `information_schema`, which every catalog has. */
export async function listSchemas(client: DatabricksClient, catalog: string): Promise<string[]> {
  const schemas = await everyPage<{ name: string }>(async (pageToken) => {
    const response = await client.get<{ schemas?: { name: string }[]; next_page_token?: string }>("/api/2.1/unity-catalog/schemas", {
      query: { catalog_name: catalog, page_token: pageToken },
    });
    return { items: response.schemas, next_page_token: response.next_page_token };
  });
  return schemas.map((schema) => schema.name).filter((name) => name !== "information_schema").sort((a, b) => a.localeCompare(b));
}

/** The error code Databricks gives, whichever shape the error came in. */
export function errorCode(error: unknown): string | undefined {
  return isApiError(error) ? error.errorCode : undefined;
}

export const alreadyExists = (error: unknown) => {
  const code = errorCode(error);
  return code === "ALREADY_EXISTS" || code === "RESOURCE_ALREADY_EXISTS" || (isApiError(error) && error.status === 409);
};

/** A governed tag policy for a domain's key. Domains can't be created without one. */
export async function ensureTagPolicy(client: DatabricksClient, key: string, description: string): Promise<"exists" | "created"> {
  try {
    await client.get(`/api/2.1/tag-policies/${encodeURIComponent(key)}`);
    return "exists";
  } catch (error) {
    if (!isApiError(error) || !error.isNotFound) throw error;
  }
  await client.post("/api/2.1/tag-policies", { tag_key: key, description });
  return "created";
}

/** Whether a Databricks error is the account's tag-policy limit. */
export const tagPolicyLimit = (error: unknown) => isApiError(error) && /maximum number of tag policies/i.test(error.message);
