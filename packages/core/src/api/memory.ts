// Databricks managed agent memory and sessions (Beta, Lakebase-backed).
// https://docs.databricks.com/aws/en/agents/agent-memory/managed-memory
//
// `actor_id` is whose memory it is. Trusted plugin code sets it to the signed
// in user (never model output), so a person's memory follows them across
// their Buzz agents and Databricks-hosted agents that use the same store.
import type { DatabricksClient } from "../client";

export type MemoryEntry = Readonly<{
  /** Resource name; the entry ID is its last segment. */
  name?: string;
  actor_id: string;
  path: string;
  content?: string;
  description?: string;
  session_id?: string;
  create_time?: string;
  update_time?: string;
  score?: number;
}>;

export type MemoryStore = Readonly<{ name?: string; description?: string; create_time?: string }>;

export const entryId = (entry: MemoryEntry) => entry.name?.split("/").pop() ?? "";

/** Store IDs: 3–56 chars, [a-z0-9-], starting with a letter. */
export const validStoreId = (id: string) => /^[a-z][a-z0-9-]{1,54}[a-z0-9]$/.test(id);

/** Paths are file-like: /topic/name.md. */
export function normalizePath(path: string): string {
  const trimmed = path.trim().replace(/\\/g, "/").replace(/\/{2,}/g, "/");
  const absolute = trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
  if (absolute.split("/").some((part) => part === ".." || part === ".")) throw new Error("Memory paths cannot contain . or ..");
  return absolute;
}

const store = (id: string) => `/api/2.0/agents/memory-stores/${encodeURIComponent(id)}`;

export class Memory {
  constructor(private readonly client: DatabricksClient) {}

  async stores(signal?: AbortSignal): Promise<MemoryStore[]> {
    const response = await this.client.get<{ memory_stores?: MemoryStore[]; managed_memory_stores?: MemoryStore[] }>(
      "/api/2.0/agents/memory-stores",
      signal ? { signal } : {},
    );
    return response.memory_stores ?? response.managed_memory_stores ?? [];
  }

  getStore(id: string, signal?: AbortSignal) {
    return this.client.get<MemoryStore>(store(id), signal ? { signal } : {});
  }

  createStore(id: string, description: string) {
    return this.client.post<MemoryStore>("/api/2.0/agents/memory-stores", { description }, { query: { managed_memory_store_id: id } });
  }

  /** Creates the store when it does not exist yet. */
  async ensureStore(id: string, description: string): Promise<MemoryStore> {
    try {
      return await this.getStore(id);
    } catch (error) {
      if ((error as { status?: number }).status !== 404) throw error;
      try {
        return await this.createStore(id, description);
      } catch (createError) {
        if ((createError as { status?: number }).status === 409) return this.getStore(id);
        throw createError;
      }
    }
  }

  async search(storeId: string, actorId: string, query: string, limit = 10, signal?: AbortSignal): Promise<MemoryEntry[]> {
    const response = await this.client.post<{ entries?: MemoryEntry[]; results?: { entry?: MemoryEntry; score?: number }[] }>(
      `${store(storeId)}/entries:search`,
      { actor_id: actorId, query, ...(limit && { limit }) },
      signal ? { signal } : {},
    );
    if (response.entries) return response.entries.slice(0, limit);
    return (response.results ?? [])
      .flatMap((result) => (result.entry ? [{ ...result.entry, ...(result.score !== undefined && { score: result.score }) }] : []))
      .slice(0, limit);
  }

  async list(storeId: string, actorId: string, options: Readonly<{ path?: string; signal?: AbortSignal }> = {}): Promise<MemoryEntry[]> {
    const out: MemoryEntry[] = [];
    let pageToken: string | undefined;
    for (let page = 0; page < 20; page++) {
      const response = await this.client.get<{ entries?: MemoryEntry[]; next_page_token?: string }>(`${store(storeId)}/entries`, {
        query: { actor_id: actorId, path: options.path && normalizePath(options.path), page_size: 100, page_token: pageToken },
        ...(options.signal && { signal: options.signal }),
      });
      out.push(...(response.entries ?? []));
      pageToken = response.next_page_token;
      if (!pageToken) break;
    }
    return out;
  }

  /** The entry at `path` outside any session, if there is one. */
  async get(storeId: string, actorId: string, path: string, signal?: AbortSignal): Promise<MemoryEntry | undefined> {
    const entries = await this.list(storeId, actorId, { path, ...(signal && { signal }) });
    const normalized = normalizePath(path);
    return entries.find((entry) => entry.path === normalized && !entry.session_id) ?? entries.find((entry) => entry.path === normalized);
  }

  /** Creates or replaces the entry at `path`. */
  async put(
    storeId: string,
    entry: Readonly<{ actorId: string; path: string; content: string; description?: string }>,
  ): Promise<MemoryEntry> {
    const path = normalizePath(entry.path);
    const existing = await this.get(storeId, entry.actorId, path);
    if (existing && entryId(existing)) {
      const mask = entry.description !== undefined ? "content,description" : "content";
      return this.client.json<MemoryEntry>(`${store(storeId)}/entries/${encodeURIComponent(entryId(existing))}`, {
        method: "PATCH",
        query: { update_mask: mask },
        body: { content: entry.content, ...(entry.description !== undefined && { description: entry.description }) },
      });
    }
    return this.client.post<MemoryEntry>(`${store(storeId)}/entries`, {
      actor_id: entry.actorId,
      path,
      content: entry.content,
      ...(entry.description && { description: entry.description }),
    });
  }

  async remove(storeId: string, actorId: string, path: string): Promise<boolean> {
    const existing = await this.get(storeId, actorId, path);
    if (!existing || !entryId(existing)) return false;
    await this.client.json(`${store(storeId)}/entries/${encodeURIComponent(entryId(existing))}`, { method: "DELETE" });
    return true;
  }
}

/** Managed agent sessions: durable, ordered conversation items per session. */
export class Sessions {
  constructor(private readonly client: DatabricksClient) {}

  private base(storeId: string) {
    return `/api/2.0/agents/session-stores/${encodeURIComponent(storeId)}`;
  }

  async ensureStore(storeId: string, description: string) {
    try {
      return await this.client.get(this.base(storeId));
    } catch (error) {
      if ((error as { status?: number }).status !== 404) throw error;
      return this.client
        .post("/api/2.0/agents/session-stores", { description }, { query: { session_store_id: storeId } })
        .catch(async (createError: unknown) => {
          if ((createError as { status?: number }).status === 409) return this.client.get(this.base(storeId));
          throw createError;
        });
    }
  }

  async ensureSession(storeId: string, sessionId: string, actorId: string) {
    try {
      return await this.client.get(`${this.base(storeId)}/sessions/${encodeURIComponent(sessionId)}`);
    } catch (error) {
      const status = (error as { status?: number }).status;
      if (status !== 404) throw error;
      return this.client
        .post(`${this.base(storeId)}/sessions`, { actor_id: actorId }, { query: { session_id: sessionId } })
        .catch((createError: unknown) => {
          if ((createError as { status?: number }).status === 409) return undefined;
          throw createError;
        });
    }
  }

  append(storeId: string, sessionId: string, items: readonly Readonly<Record<string, unknown>>[]) {
    return this.client.post(`${this.base(storeId)}/sessions/${encodeURIComponent(sessionId)}/items:append`, {
      items: items.map((data) => ({ data })),
    });
  }

  async items<T = Record<string, unknown>>(storeId: string, sessionId: string, signal?: AbortSignal): Promise<T[]> {
    const out: T[] = [];
    let pageToken: string | undefined;
    for (let page = 0; page < 20; page++) {
      const response = await this.client.get<{ items?: { data?: T }[]; next_page_token?: string }>(
        `${this.base(storeId)}/sessions/${encodeURIComponent(sessionId)}/items`,
        { query: { order_by: "create_time asc", page_size: 100, page_token: pageToken }, ...(signal && { signal }) },
      );
      for (const item of response.items ?? []) if (item.data) out.push(item.data);
      pageToken = response.next_page_token;
      if (!pageToken) break;
    }
    return out;
  }
}
