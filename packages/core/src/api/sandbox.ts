// Databricks Sandbox (Beta): serverless Linux microVMs for agents, with a
// persistent home directory (/home/sandbox-agent), egress, and the creator's
// Databricks credential. REST paths match databricks-sdk 0.161 SandboxAPI.
import type { DatabricksClient } from "../client";

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

export type SandboxFile = Readonly<{ name: string; path: string; directory: boolean; size?: number; modified?: string }>;

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

/** Databricks answers this before the Databricks Sandbox preview is on. */
const isUnavailable = (error: unknown) =>
  (error as { status?: number }).status === 404 && /requested API is not available/i.test((error as Error).message ?? "");

export class SandboxUnavailableError extends Error {
  constructor() {
    super("Databricks Sandbox isn't turned on in this workspace. A workspace admin can turn on the Databricks Sandbox preview in Settings → Previews.");
    this.name = "SandboxUnavailableError";
  }
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

  /** Whether Databricks Sandbox is on in this workspace (no retries). */
  async available(signal?: AbortSignal): Promise<boolean> {
    try {
      await this.client.get("/api/2.0/sandboxes", { query: { page_size: 1 }, ...(signal && { signal }) });
      return true;
    } catch (error) {
      if (isUnavailable(error)) return false;
      throw error;
    }
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
    options: Readonly<{
      displayName?: string;
      tags?: Record<string, string>;
      signal?: AbortSignal;
      /** A short label for people, and the raw API state. */
      onState?(label: string, state?: string): void;
    }> = {},
  ): Promise<Sandbox> {
    let sandbox: Sandbox | undefined = await this.find(id, options.signal);
    if (!sandbox) {
      options.onState?.("Creating sandbox");
      try {
        sandbox = await this.create(id, options);
      } catch (error) {
        if (isUnavailable(error)) throw new SandboxUnavailableError();
        if ((error as { status?: number }).status !== 409) throw error;
        sandbox = await this.get(id, options.signal);
      }
    }
    const deadline = Date.now() + 5 * 60_000;
    let started = false;
    for (;;) {
      const state = sandbox?.status?.state ?? "";
      if (state === "SANDBOX_STATE_RUNNING") return sandbox!;
      if (Date.now() > deadline) throw new Error(`The sandbox did not start within 5 minutes (state: ${state || "unknown"}).`);
      if (state === "SANDBOX_STATE_STOPPED" && !started) {
        options.onState?.("Starting sandbox", state);
        started = true;
        sandbox = await this.start(id);
        continue;
      }
      options.onState?.(state === "SANDBOX_STATE_STOPPING" ? "Waiting for sandbox to stop" : "Starting sandbox", state);
      if (state === "SANDBOX_STATE_STOPPED") started = false;
      await new Promise((resolve) => setTimeout(resolve, 2000));
      options.signal?.throwIfAborted();
      sandbox = (await this.find(id, options.signal)) ?? sandbox;
    }
  }

  /** The sandbox, or undefined when it doesn't exist. */
  private async find(id: string, signal?: AbortSignal): Promise<Sandbox | undefined> {
    for (let attempt = 0; ; attempt++) {
      try {
        return await this.get(id, signal);
      } catch (error) {
        // While the preview rolls out, some servers answer "API not available".
        if (isUnavailable(error) && attempt < 3) {
          await new Promise((resolve) => setTimeout(resolve, 1000));
          continue;
        }
        if (isUnavailable(error)) throw new SandboxUnavailableError();
        if ((error as { status?: number }).status === 404) return undefined;
        throw error;
      }
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

  // Files go through exec-sync, the documented API: contents travel as base64
  // in environment variables, never in the command line.

  /** Reads a UTF-8 text file. */
  async readFile(id: string, path: string, signal?: AbortSignal): Promise<string> {
    const result = await this.exec(id, "/bin/bash", {
      args: ["-c", 'if [ -d "$P" ]; then echo "$P is a directory" >&2; exit 21; fi; base64 -w0 -- "$P"'],
      env: { P: path },
      timeoutSeconds: 60,
      ...(signal && { signal }),
    });
    if (result.exit_code !== 0) throw new Error(result.stderr?.trim().replace(/^base64: /, "") || `Couldn't read ${path}.`);
    if (result.truncated) throw new Error(`${path} is too large to read whole; read part of it with a command instead.`);
    return fromBase64(result.stdout ?? "");
  }

  /** Creates or replaces a file (and its parent folders). */
  async writeFile(id: string, path: string, contents: string, signal?: AbortSignal): Promise<void> {
    const encoded = toBase64(contents);
    const CHUNK = 96 * 1024;
    for (let offset = 0; offset === 0 || offset < encoded.length; offset += CHUNK) {
      const result = await this.exec(id, "/bin/bash", {
        args: ["-c", offset === 0 ? 'mkdir -p -- "$(dirname -- "$P")" && printf %s "$C" | base64 -d > "$P"' : 'printf %s "$C" | base64 -d >> "$P"'],
        env: { P: path, C: encoded.slice(offset, offset + CHUNK) },
        timeoutSeconds: 60,
        ...(signal && { signal }),
      });
      if (result.exit_code !== 0) throw new Error(result.stderr?.trim() || `Couldn't write ${path}.`);
    }
  }

  /** Lists a folder: directory-entries when the server offers it, else `find`. */
  async listDirectory(id: string, path: string, signal?: AbortSignal): Promise<SandboxFile[]> {
    type Raw = { name?: string; path?: string; fileType?: string; file_type?: string; size?: string | number; modifyTime?: string; modify_time?: string };
    try {
      const response = await this.client.get<{ contents?: Raw[] }>(`/api/2.0/sandbox-files/${resource(id)}/directory-entries`, {
        query: { path, page_size: 500 },
        ...(signal && { signal }),
      });
      return (response.contents ?? []).map((entry) => {
        const type = entry.fileType ?? entry.file_type ?? "";
        const size = entry.size === undefined ? undefined : Number(entry.size);
        const modified = entry.modifyTime ?? entry.modify_time;
        return {
          name: entry.name ?? entry.path?.split("/").pop() ?? "",
          path: entry.path ?? "",
          directory: /DIRECTORY/.test(type),
          ...(size !== undefined && Number.isFinite(size) && { size }),
          ...(modified && { modified }),
        };
      });
    } catch (error) {
      if (signal?.aborted) throw error;
      const result = await this.exec(id, "/bin/bash", {
        args: ["-c", 'find "$P" -mindepth 1 -maxdepth 1 -printf "%y\\t%s\\t%p\\n"'],
        env: { P: path },
        timeoutSeconds: 30,
        ...(signal && { signal }),
      });
      if (result.exit_code !== 0) throw new Error(result.stderr?.trim() || `Couldn't list ${path}.`);
      return parseFindOutput(result.stdout ?? "");
    }
  }
}

/** Parses `find -printf "%y\t%s\t%p\n"` lines. */
export function parseFindOutput(text: string): SandboxFile[] {
  return text
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const [type = "", size = "", ...rest] = line.split("\t");
      const path = rest.join("\t");
      return {
        name: path.split("/").pop() ?? path,
        path,
        directory: type === "d",
        ...(type !== "d" && Number.isFinite(Number(size)) && { size: Number(size) }),
      };
    });
}

export function toBase64(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}

export function fromBase64(encoded: string): string {
  const binary = atob(encoded.trim());
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}
