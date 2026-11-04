// Databricks Sandbox (Beta): serverless Linux microVMs for agents, with a
// persistent home directory (/home/sandbox-agent), egress, and the creator's
// Databricks credential. REST paths match databricks-sdk 0.161 SandboxAPI.
import { apiError, type DatabricksClient } from "../client";

export type SandboxState =
  | "SANDBOX_STATE_PENDING"
  | "SANDBOX_STATE_RUNNING"
  | "SANDBOX_STATE_STOPPED"
  | "SANDBOX_STATE_STOPPING"
  | string;

export type Sandbox = Readonly<{
  /** `sandboxes/<id>` */
  name: string;
  display_name?: string;
  status?: { state?: SandboxState };
  create_time?: string;
  update_time?: string;
  metadata?: { custom_tags?: Record<string, string> };
}>;

export type ExecResult = Readonly<{
  command_id?: string;
  exit_code?: number;
  status?: "EXECUTE_COMMAND_STATUS_COMPLETED" | "EXECUTE_COMMAND_STATUS_FAILED" | "EXECUTE_COMMAND_STATUS_TIMED_OUT" | string;
  stdout?: string;
  stderr?: string;
  truncated?: boolean;
}>;

export const SANDBOX_HOME = "/home/sandbox-agent";

/** Sandbox IDs: lowercase letters, digits and hyphens. */
export function sandboxId(seed: string): string {
  const cleaned = seed
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
  return /^[a-z]/.test(cleaned) ? cleaned : `sb-${cleaned}`;
}

const resource = (id: string) => (id.startsWith("sandboxes/") ? id : `sandboxes/${id}`);

export class Sandboxes {
  constructor(private readonly client: DatabricksClient) {}

  async list(signal?: AbortSignal): Promise<Sandbox[]> {
    const out: Sandbox[] = [];
    let pageToken: string | undefined;
    for (let page = 0; page < 10; page++) {
      const response = await this.client.get<{ sandboxes?: Sandbox[]; next_page_token?: string }>("/api/2.0/sandboxes", {
        query: { page_size: 100, page_token: pageToken },
        ...(signal && { signal }),
      });
      out.push(...(response.sandboxes ?? []));
      pageToken = response.next_page_token;
      if (!pageToken) break;
    }
    return out;
  }

  get(id: string, signal?: AbortSignal) {
    return this.client.get<Sandbox>(`/api/2.0/${resource(id)}`, signal ? { signal } : {});
  }

  create(id: string, options: Readonly<{ displayName?: string; tags?: Record<string, string> }> = {}) {
    return this.client.post<Sandbox>(
      "/api/2.0/sandboxes",
      {
        ...(options.displayName && { display_name: options.displayName }),
        ...(options.tags && { metadata: { custom_tags: options.tags } }),
      },
      { query: { sandbox_id: id }, timeoutMs: 120_000 },
    );
  }

  start(id: string) {
    return this.client.post<Sandbox>(`/api/2.0/${resource(id)}/start`, {}, { timeoutMs: 120_000 });
  }

  stop(id: string) {
    return this.client.post<Sandbox>(`/api/2.0/${resource(id)}/stop`, {});
  }

  delete(id: string) {
    return this.client.json(`/api/2.0/${resource(id)}`, { method: "DELETE" });
  }

  /** Gets or creates the sandbox and waits until it is running. */
  async ensureRunning(
    id: string,
    options: Readonly<{ displayName?: string; tags?: Record<string, string>; signal?: AbortSignal; onState?(state: string): void }> = {},
  ): Promise<Sandbox> {
    let sandbox: Sandbox;
    try {
      sandbox = await this.get(id, options.signal);
    } catch (error) {
      if ((error as { status?: number }).status !== 404) throw error;
      options.onState?.("Creating sandbox");
      sandbox = await this.create(id, options);
    }
    const deadline = Date.now() + 5 * 60_000;
    for (;;) {
      const state = sandbox.status?.state ?? "";
      if (state === "SANDBOX_STATE_RUNNING") return sandbox;
      if (Date.now() > deadline) throw new Error("The sandbox did not start within 5 minutes.");
      if (state === "SANDBOX_STATE_STOPPED") {
        options.onState?.("Starting sandbox");
        sandbox = await this.start(id);
        continue;
      }
      options.onState?.(state === "SANDBOX_STATE_STOPPING" ? "Waiting for sandbox to stop" : "Starting sandbox");
      await new Promise((resolve) => setTimeout(resolve, 2000));
      options.signal?.throwIfAborted();
      sandbox = await this.get(id, options.signal);
    }
  }

  /** Runs a command and waits for it, up to `timeoutSeconds` (server-clamped). */
  exec(
    id: string,
    cmd: string,
    options: Readonly<{ args?: readonly string[]; env?: Record<string, string>; timeoutSeconds?: number; signal?: AbortSignal }> = {},
  ): Promise<ExecResult> {
    const timeout = options.timeoutSeconds ?? 120;
    return this.client.post<ExecResult>(
      `/api/2.0/sandbox-exec/${resource(id)}/exec-sync`,
      {
        cmd,
        ...(options.args && { args: options.args }),
        ...(options.env && { envs: options.env }),
        execution_timeout: `${timeout}s`,
      },
      { timeoutMs: (timeout + 30) * 1000, ...(options.signal && { signal: options.signal }) },
    );
  }

  /** Runs a bash script in the agent's home directory. */
  bash(id: string, script: string, options: Readonly<{ timeoutSeconds?: number; signal?: AbortSignal; cwd?: string }> = {}) {
    const cwd = options.cwd ?? SANDBOX_HOME;
    return this.exec(id, "/bin/bash", {
      args: ["-lc", `cd ${JSON.stringify(cwd)} 2>/dev/null || cd ${SANDBOX_HOME}; ${script}`],
      ...(options.timeoutSeconds !== undefined && { timeoutSeconds: options.timeoutSeconds }),
      ...(options.signal && { signal: options.signal }),
    });
  }

  async readFile(id: string, path: string, signal?: AbortSignal): Promise<string> {
    const response = await this.client.request(`/api/2.0/sandbox-files/${resource(id)}/content`, {
      query: { path },
      headers: { Accept: "application/octet-stream" },
      ...(signal && { signal }),
    });
    if (response.status < 200 || response.status >= 300) throw apiError(response);
    return response.body;
  }

  async writeFile(id: string, path: string, contents: string, signal?: AbortSignal): Promise<void> {
    const response = await this.client.request(`/api/2.0/sandbox-files/${resource(id)}/content`, {
      method: "PUT",
      query: { path },
      body: contents,
      headers: { "Content-Type": "application/octet-stream" },
      ...(signal && { signal }),
    });
    if (response.status < 200 || response.status >= 300) throw apiError(response);
  }

  async listDirectory(id: string, path: string, signal?: AbortSignal) {
    const response = await this.client.get<{
      contents?: { name?: string; path?: string; file_type?: string; size?: number }[];
    }>(`/api/2.0/sandbox-files/${resource(id)}/directory-entries`, { query: { path, page_size: 500 }, ...(signal && { signal }) });
    return response.contents ?? [];
  }
}
