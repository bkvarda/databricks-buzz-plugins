// Databricks Apps, Unity Catalog secrets and workspace files: what a Buzz App
// identity needs. Each app runs as its own service principal; the identity's
// key is a Unity Catalog secret that only that principal (and its creator)
// can read.
import type { DatabricksClient } from "../client";

type Status = Readonly<{ state?: string; message?: string }>;

export type AppDeployment = Readonly<{
  deployment_id?: string;
  source_code_path?: string;
  status?: Status;
  create_time?: string;
}>;

export type DatabricksApp = Readonly<{
  name: string;
  description?: string;
  url?: string;
  creator?: string;
  /** The app's service principal: its application (client) ID, as grants name it. */
  service_principal_client_id?: string;
  service_principal_id?: number;
  service_principal_name?: string;
  app_status?: Status;
  compute_status?: Status;
  active_deployment?: AppDeployment;
  pending_deployment?: AppDeployment;
  default_source_code_path?: string;
}>;

/** Databricks app names: lowercase letters, numbers and hyphens, at most 30 characters. */
export const APP_NAME = /^[a-z0-9](?:[a-z0-9-]{0,28}[a-z0-9])?$/;

const status = (error: unknown) => (error as { status?: number }).status;
const missing = (error: unknown) => status(error) === 404 || ["RESOURCE_DOES_NOT_EXIST", "NOT_FOUND"].includes(String((error as { errorCode?: string }).errorCode));
const exists = (error: unknown) => status(error) === 409 || /ALREADY_EXISTS/.test(String((error as { errorCode?: string }).errorCode ?? ""));

export function wait(ms: number, signal?: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason);
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        reject(signal.reason);
      },
      { once: true },
    );
  });
}

export class Apps {
  constructor(private readonly client: DatabricksClient) {}

  /** The app, or undefined when there's none by that name. */
  async get(name: string, signal?: AbortSignal): Promise<DatabricksApp | undefined> {
    try {
      return await this.client.get<DatabricksApp>(`/api/2.0/apps/${encodeURIComponent(name)}`, { ...(signal && { signal }) });
    } catch (error) {
      if (missing(error)) return undefined;
      throw error;
    }
  }

  async list(signal?: AbortSignal): Promise<DatabricksApp[]> {
    const found: DatabricksApp[] = [];
    let token: string | undefined;
    for (let page = 0; page < 20; page++) {
      const reply = await this.client.get<{ apps?: DatabricksApp[]; next_page_token?: string }>("/api/2.0/apps", { query: { page_size: 100, page_token: token }, ...(signal && { signal }) });
      found.push(...(reply.apps ?? []));
      token = reply.next_page_token;
      if (!token) break;
    }
    return found;
  }

  /** Creates an app; with `compute: false` it stays stopped until its first deployment. */
  create(name: string, options: Readonly<{ description?: string; compute?: boolean; signal?: AbortSignal }> = {}): Promise<DatabricksApp> {
    return this.client.post<DatabricksApp>(
      "/api/2.0/apps",
      { name, ...(options.description && { description: options.description }) },
      { ...(options.compute === false && { query: { no_compute: true } }), ...(options.signal && { signal: options.signal }) },
    );
  }

  deploy(name: string, sourceCodePath: string, signal?: AbortSignal): Promise<AppDeployment> {
    return this.client.post<AppDeployment>(`/api/2.0/apps/${encodeURIComponent(name)}/deployments`, { source_code_path: sourceCodePath, mode: "SNAPSHOT" }, { ...(signal && { signal }) });
  }

  deployment(name: string, id: string, signal?: AbortSignal): Promise<AppDeployment> {
    return this.client.get<AppDeployment>(`/api/2.0/apps/${encodeURIComponent(name)}/deployments/${encodeURIComponent(id)}`, { ...(signal && { signal }) });
  }

  start(name: string, signal?: AbortSignal): Promise<DatabricksApp> {
    return this.client.post<DatabricksApp>(`/api/2.0/apps/${encodeURIComponent(name)}/start`, {}, { ...(signal && { signal }) });
  }

  stop(name: string, signal?: AbortSignal): Promise<DatabricksApp> {
    return this.client.post<DatabricksApp>(`/api/2.0/apps/${encodeURIComponent(name)}/stop`, {}, { ...(signal && { signal }) });
  }

  async delete(name: string, signal?: AbortSignal): Promise<void> {
    try {
      await this.client.json(`/api/2.0/apps/${encodeURIComponent(name)}`, { method: "DELETE", ...(signal && { signal }) });
    } catch (error) {
      if (!missing(error)) throw error;
    }
  }

  /** Polls the app until `done` says so, or `timeoutMs` passes. */
  async until(name: string, done: (app: DatabricksApp) => boolean, options: Readonly<{ timeoutMs: number; intervalMs?: number; signal?: AbortSignal }>): Promise<DatabricksApp | undefined> {
    const end = Date.now() + options.timeoutMs;
    for (;;) {
      const app = await this.get(name, options.signal);
      if (!app || done(app) || Date.now() > end) return app;
      await wait(options.intervalMs ?? 5000, options.signal);
    }
  }
}

/** A Unity Catalog secret's value, read by its owner or a principal with READ SECRET. */
export class UcSecrets {
  constructor(private readonly client: DatabricksClient) {}

  private path(fullName: string) {
    return `/api/2.1/unity-catalog/secrets/${fullName.split(".").map(encodeURIComponent).join(".")}`;
  }

  /** The value, or undefined when there's no such secret. */
  async read(fullName: string, signal?: AbortSignal): Promise<string | undefined> {
    try {
      const secret = await this.client.get<{ effective_value?: string; value?: string }>(this.path(fullName), { query: { include_value: true }, ...(signal && { signal }) });
      return secret.effective_value ?? secret.value ?? "";
    } catch (error) {
      if (missing(error)) return undefined;
      throw error;
    }
  }

  create(fullName: string, value: string, comment: string, signal?: AbortSignal): Promise<unknown> {
    const [catalog, schema, name] = fullName.split(".");
    return this.client.post("/api/2.1/unity-catalog/secrets", { catalog_name: catalog, schema_name: schema, name, value, comment }, { ...(signal && { signal }) });
  }

  update(fullName: string, value: string, signal?: AbortSignal): Promise<unknown> {
    return this.client.json(this.path(fullName), { method: "PATCH", query: { update_mask: "value" }, body: { value }, ...(signal && { signal }) });
  }

  async delete(fullName: string, signal?: AbortSignal): Promise<void> {
    try {
      await this.client.json(this.path(fullName), { method: "DELETE", ...(signal && { signal }) });
    } catch (error) {
      if (!missing(error)) throw error;
    }
  }
}

/** Grants Unity Catalog privileges, e.g. READ_SECRET on a secret, to a principal (a service principal's application ID). */
export function grantPrivileges(client: DatabricksClient, securable: "catalog" | "schema" | "secret", fullName: string, principal: string, privileges: readonly string[], signal?: AbortSignal) {
  return client.json(`/api/2.1/unity-catalog/permissions/${securable}/${fullName.split(".").map(encodeURIComponent).join(".")}`, {
    method: "PATCH",
    body: { changes: [{ principal, add: privileges }] },
    ...(signal && { signal }),
  });
}

/** Creates the schema unless it's there. */
export async function ensureSchema(client: DatabricksClient, catalog: string, schema: string, comment: string, signal?: AbortSignal): Promise<void> {
  try {
    await client.get(`/api/2.1/unity-catalog/schemas/${encodeURIComponent(`${catalog}.${schema}`)}`, { ...(signal && { signal }) });
    return;
  } catch (error) {
    if (!missing(error)) throw error;
  }
  try {
    await client.post("/api/2.1/unity-catalog/schemas", { catalog_name: catalog, name: schema, comment }, { ...(signal && { signal }) });
  } catch (error) {
    if (!exists(error)) throw error;
  }
}

export async function listCatalogs(client: DatabricksClient, signal?: AbortSignal): Promise<string[]> {
  const reply = await client.get<{ catalogs?: { name: string; catalog_type?: string }[] }>("/api/2.1/unity-catalog/catalogs", { ...(signal && { signal }) });
  return (reply.catalogs ?? []).filter((catalog) => catalog.name !== "system" && catalog.catalog_type !== "SYSTEM_CATALOG").map((catalog) => catalog.name);
}

const base64 = (text: string) => {
  const bytes = new TextEncoder().encode(text);
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
};

/** Writes files into a workspace folder (made if missing), replacing what's there. */
export async function writeWorkspaceFiles(client: DatabricksClient, folder: string, files: Readonly<Record<string, string>>, options: Readonly<{ keep?: readonly string[]; signal?: AbortSignal }> = {}): Promise<void> {
  const { signal } = options;
  await client.post("/api/2.0/workspace/mkdirs", { path: folder }, { ...(signal && { signal }) });
  for (const [name, content] of Object.entries(files)) {
    const path = `${folder}/${name}`;
    // Files someone may have edited stay as they are.
    if (options.keep?.includes(name)) {
      const found = await client.get("/api/2.0/workspace/get-status", { query: { path }, ...(signal && { signal }) }).then(
        () => true,
        (error: unknown) => (missing(error) ? false : Promise.reject(error)),
      );
      if (found) continue;
    }
    await client.post("/api/2.0/workspace/import", { path, format: "AUTO", overwrite: true, content: base64(content) }, { ...(signal && { signal }) });
  }
}
