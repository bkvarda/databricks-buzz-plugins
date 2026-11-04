// Databricks workspace objects that show up as links in conversations, and
// the status reads behind their chips and watches.
import type { DatabricksClient } from "../client";

export type WorkspaceLink =
  | { kind: "job"; host: string; jobId: string }
  | { kind: "run"; host: string; jobId?: string; runId: string }
  | { kind: "pipeline"; host: string; pipelineId: string; updateId?: string }
  | { kind: "dashboard"; host: string; dashboardId: string }
  | { kind: "notebook"; host: string; notebookId: string }
  | { kind: "query"; host: string; queryId: string }
  | { kind: "genie"; host: string; spaceId: string; conversationId?: string }
  | { kind: "app"; host: string; name: string }
  | { kind: "table"; host: string; fullName: string }
  | { kind: "workspace"; host: string };

const DATABRICKS_HOST = /(^|\.)(cloud\.databricks\.com|azuredatabricks\.net|gcp\.databricks\.com|databricks\.com)$/i;

export function isDatabricksHost(hostname: string): boolean {
  return DATABRICKS_HOST.test(hostname) && !/^(www|docs|community|login|accounts|marketplace)\./i.test(hostname);
}

export function parseWorkspaceUrl(raw: string): WorkspaceLink | undefined {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return undefined;
  }
  if (url.protocol !== "https:" || !isDatabricksHost(url.hostname)) return undefined;
  const host = url.origin;
  // Legacy hash routes: #job/1/run/2, #notebook/123
  const route = `${url.pathname}${url.hash.startsWith("#") ? `/${url.hash.slice(1)}` : ""}`;
  let m: RegExpExecArray | null;
  if ((m = /\/jobs\/(\d+)\/runs\/(\d+)/.exec(route)) || (m = /\/job\/(\d+)\/run\/(\d+)/.exec(route)))
    return { kind: "run", host, jobId: m[1] as string, runId: m[2] as string };
  if ((m = /\/jobs\/runs\/(\d+)/.exec(route))) return { kind: "run", host, runId: m[1] as string };
  if ((m = /\/jobs\/(\d+)(?:\/|$|\?)/.exec(route)) || (m = /\/job\/(\d+)$/.exec(route))) return { kind: "job", host, jobId: m[1] as string };
  if ((m = /\/pipelines\/([0-9a-f-]{36})(?:\/updates\/([0-9a-f-]{36}))?/.exec(route)))
    return { kind: "pipeline", host, pipelineId: m[1] as string, ...(m[2] && { updateId: m[2] }) };
  if ((m = /\/(?:sql\/)?dashboardsv3\/([0-9a-f]{32})/.exec(route)) || (m = /\/dashboards\/([0-9a-f]{32})/.exec(route)))
    return { kind: "dashboard", host, dashboardId: m[1] as string };
  if ((m = /\/genie\/rooms\/([\w-]+)(?:\/chats\/([\w-]+))?/.exec(route)))
    return { kind: "genie", host, spaceId: m[1] as string, ...(m[2] && { conversationId: m[2] }) };
  if ((m = /\/editor\/notebooks\/(\d+)/.exec(route)) || (m = /\/notebook\/(\d+)/.exec(route)))
    return { kind: "notebook", host, notebookId: m[1] as string };
  if ((m = /\/sql\/editor\/([0-9a-f-]{36})/.exec(route)) || (m = /\/queries\/([0-9a-f-]{36})/.exec(route)))
    return { kind: "query", host, queryId: m[1] as string };
  if ((m = /\/apps\/([a-z0-9-]+)/.exec(route))) return { kind: "app", host, name: m[1] as string };
  if ((m = /\/explore\/data\/([^/]+)\/([^/]+)\/([^/?#]+)/.exec(route)))
    return { kind: "table", host, fullName: [m[1], m[2], m[3]].map((part) => decodeURIComponent(part as string)).join(".") };
  if (url.pathname === "/" || url.pathname === "") return { kind: "workspace", host };
  return undefined;
}

export const LINK_LABEL: Record<WorkspaceLink["kind"], string> = {
  job: "Job",
  run: "Job run",
  pipeline: "Pipeline",
  dashboard: "Dashboard",
  notebook: "Notebook",
  query: "SQL query",
  genie: "Genie",
  app: "App",
  table: "Table",
  workspace: "Workspace",
};

export type RunStatus = Readonly<{
  runId: string;
  jobId?: string;
  name: string;
  /** PENDING, QUEUED, RUNNING, TERMINATING, TERMINATED, SKIPPED, INTERNAL_ERROR, BLOCKED, WAITING */
  lifecycle: string;
  /** SUCCESS, FAILED, TIMEDOUT, CANCELED, ... once finished. */
  result?: string;
  message?: string;
  startTime?: number;
  endTime?: number;
  url?: string;
  done: boolean;
  tasks: readonly { key: string; lifecycle: string; result?: string; message?: string }[];
}>;

const finished = new Set(["TERMINATED", "SKIPPED", "INTERNAL_ERROR"]);

export function runTone(status: RunStatus): "success" | "danger" | "warning" | "active" | "neutral" {
  if (!status.done) return "active";
  if (status.result === "SUCCESS") return "success";
  if (status.result === "CANCELED" || status.result === "SKIPPED") return "neutral";
  if (status.result === "SUCCESS_WITH_FAILURES") return "warning";
  return "danger";
}

export function runLabel(status: RunStatus): string {
  if (!status.done) return { PENDING: "Pending", QUEUED: "Queued", RUNNING: "Running", TERMINATING: "Finishing", BLOCKED: "Blocked", WAITING: "Waiting" }[status.lifecycle] ?? status.lifecycle.toLowerCase();
  return (
    { SUCCESS: "Succeeded", FAILED: "Failed", TIMEDOUT: "Timed out", CANCELED: "Cancelled", SKIPPED: "Skipped", SUCCESS_WITH_FAILURES: "Succeeded with failures", UPSTREAM_FAILED: "Upstream failed" }[
      status.result ?? ""
    ] ?? (status.result ?? "Finished").toLowerCase()
  );
}

export class Jobs {
  constructor(private readonly client: DatabricksClient) {}

  async run(runId: string, signal?: AbortSignal): Promise<RunStatus> {
    const run = await this.client.get<{
      run_id: number;
      job_id?: number;
      run_name?: string;
      state?: { life_cycle_state?: string; result_state?: string; state_message?: string };
      status?: { state?: string; termination_details?: { code?: string; message?: string } };
      start_time?: number;
      end_time?: number;
      run_page_url?: string;
      tasks?: { task_key: string; state?: { life_cycle_state?: string; result_state?: string; state_message?: string } }[];
    }>("/api/2.2/jobs/runs/get", { query: { run_id: runId }, ...(signal && { signal }) });
    const lifecycle = run.state?.life_cycle_state ?? run.status?.state ?? "UNKNOWN";
    const result = run.state?.result_state ?? (run.status?.state === "TERMINATED" ? run.status.termination_details?.code : undefined);
    return {
      runId: String(run.run_id),
      ...(run.job_id !== undefined && { jobId: String(run.job_id) }),
      name: run.run_name ?? `Run ${run.run_id}`,
      lifecycle,
      ...(result && { result }),
      ...((run.state?.state_message || run.status?.termination_details?.message) && {
        message: run.state?.state_message || run.status?.termination_details?.message,
      }),
      ...(run.start_time && { startTime: run.start_time }),
      ...(run.end_time && { endTime: run.end_time }),
      ...(run.run_page_url && { url: run.run_page_url }),
      done: finished.has(lifecycle),
      tasks: (run.tasks ?? []).map((task) => ({
        key: task.task_key,
        lifecycle: task.state?.life_cycle_state ?? "",
        ...(task.state?.result_state && { result: task.state.result_state }),
        ...(task.state?.state_message && { message: task.state.state_message }),
      })),
    };
  }

  async job(jobId: string, signal?: AbortSignal) {
    const job = await this.client.get<{ job_id: number; settings?: { name?: string; schedule?: { quartz_cron_expression?: string } } }>(
      "/api/2.2/jobs/get",
      { query: { job_id: jobId }, ...(signal && { signal }) },
    );
    const runs = await this.client
      .get<{ runs?: { run_id: number }[] }>("/api/2.2/jobs/runs/list", { query: { job_id: jobId, limit: 1 }, ...(signal && { signal }) })
      .catch(() => ({ runs: [] as { run_id: number }[] }));
    const latest = runs.runs?.[0];
    return {
      jobId: String(job.job_id),
      name: job.settings?.name ?? `Job ${job.job_id}`,
      latest: latest ? await this.run(String(latest.run_id), signal).catch(() => undefined) : undefined,
    };
  }

  runNow(jobId: string) {
    return this.client.post<{ run_id: number }>("/api/2.2/jobs/run-now", { job_id: Number(jobId) });
  }

  async pipeline(pipelineId: string, signal?: AbortSignal) {
    const pipeline = await this.client.get<{
      pipeline_id: string;
      name?: string;
      state?: string;
      latest_updates?: { update_id: string; state?: string; creation_time?: string }[];
    }>(`/api/2.0/pipelines/${encodeURIComponent(pipelineId)}`, signal ? { signal } : {});
    return {
      name: pipeline.name ?? "Pipeline",
      state: pipeline.state ?? "UNKNOWN",
      latest: pipeline.latest_updates?.[0],
    };
  }
}

/** Lakebase (managed Postgres) projects and the PostgREST-style Data API. */
const detail = (error: unknown) => {
  const body = (error as { body?: string }).body ?? "";
  try {
    const parsed = JSON.parse(body) as { message?: string; code?: string };
    return [parsed.code, parsed.message].filter(Boolean).join(": ") || `HTTP ${(error as { status?: number }).status}`;
  } catch {
    return `HTTP ${(error as { status?: number }).status}`;
  }
};

/**
 * What a Lakebase project owner runs once so the Data API can act as `user`
 * (https://docs.databricks.com/aws/en/oltp/projects/data-api). Roles added in
 * the Lakebase UI or API, and owners/admins, can't be used by the Data API.
 */
export function dataApiSetupSql(user: string, schema = "public"): string {
  const role = `"${user.replace(/"/g, '""')}"`;
  const literal = `'${user.replace(/'/g, "''")}'`;
  return [
    "CREATE EXTENSION IF NOT EXISTS databricks_auth;",
    `SELECT databricks_create_role(${literal}, 'USER');`,
    `GRANT ${role} TO authenticator;`,
    `GRANT USAGE ON SCHEMA ${schema} TO ${role};`,
    `GRANT SELECT ON ALL TABLES IN SCHEMA ${schema} TO ${role};`,
  ].join("\n");
}

export class DataApiRoleError extends Error {
  constructor(cause: unknown) {
    super(
      "The Data API can't act as you yet. A Lakebase project owner needs to create your Postgres role with databricks_create_role and grant it to authenticator (Settings → Lakebase shows the SQL).",
      { cause },
    );
    this.name = "DataApiRoleError";
  }
}

/** Plain-language errors for the Data API's most common failures. */
export function dataApiError(error: unknown, table: string): Error {
  const status = (error as { status?: number }).status;
  const message = (error as Error).message ?? String(error);
  if (status === 503 && /data api is not enabled/i.test(message))
    return new Error("The Data API isn't turned on for this Lakebase project. Turn it on in Lakebase → the project → Data API.", { cause: error });
  if (status === 404 && /PGRST205|could not find the table/i.test(`${message} ${(error as { body?: string }).body ?? ""}`))
    return new Error(`There's no table or view named ${table} that you can read. Check the name and schema, and that it's in an exposed schema.`, { cause: error });
  if (/permission denied to set role/i.test(detail(error))) return new DataApiRoleError(error);
  if (status === 401 || status === 403)
    return new Error(`Lakebase refused the request (${detail(error)}). You need a Postgres role on this branch with access to the table.`, { cause: error });
  return error instanceof Error ? error : new Error(message);
}

export type DataApiTarget = Readonly<{ project: string; branch: string; database: string; url: string }>;

export class Lakebase {
  constructor(private readonly client: DatabricksClient) {}

  async projects(signal?: AbortSignal) {
    const response = await this.client.get<{
      projects?: { name: string; status?: Record<string, unknown>; spec?: { display_name?: string; pg_version?: number } }[];
    }>("/api/2.0/postgres/projects", signal ? { signal } : {});
    return (response.projects ?? []).map((project) => ({
      id: project.name.replace(/^projects\//, ""),
      name: project.spec?.display_name ?? project.name.replace(/^projects\//, ""),
      pgVersion: project.spec?.pg_version,
      status: project.status,
    }));
  }

  async branches(projectId: string, signal?: AbortSignal) {
    const response = await this.client.get<{ branches?: { name: string; status?: { default?: boolean; current_state?: string } }[] }>(
      `/api/2.0/postgres/projects/${encodeURIComponent(projectId)}/branches`,
      signal ? { signal } : {},
    );
    return response.branches ?? [];
  }

  /**
   * Data API base URLs for a project's default branch, one per database:
   * https://<read-write host>/api/2.0/workspace/<workspace-id>/rest/<database>
   */
  async dataApiTargets(projectId: string, workspaceId: string, signal?: AbortSignal): Promise<DataApiTarget[]> {
    const branches = await this.branches(projectId, signal);
    const branch = branches.find((candidate) => candidate.status?.default) ?? branches[0];
    if (!branch) return [];
    const opts = signal ? { signal } : {};
    const [endpoints, databases] = await Promise.all([
      this.client.get<{ endpoints?: { name: string; status?: { endpoint_type?: string; hosts?: { host?: string }; disabled?: boolean } }[] }>(
        `/api/2.0/postgres/${branch.name}/endpoints`,
        opts,
      ),
      this.client.get<{ databases?: { name: string; status?: { postgres_database?: string } }[] }>(`/api/2.0/postgres/${branch.name}/databases`, opts),
    ]);
    const host = (endpoints.endpoints ?? []).find(
      (endpoint) => endpoint.status?.endpoint_type === "ENDPOINT_TYPE_READ_WRITE" && !endpoint.status.disabled && endpoint.status.hosts?.host,
    )?.status?.hosts?.host;
    if (!host) return [];
    return (databases.databases ?? []).flatMap((database) => {
      const name = database.status?.postgres_database;
      return name
        ? [{ project: projectId, branch: branch.name.split("/").pop() ?? "", database: name, url: `https://${host}/api/2.0/workspace/${workspaceId}/rest/${encodeURIComponent(name)}` }]
        : [];
    });
  }

  /**
   * Reads rows through a Data API endpoint, e.g.
   * dataApi("https://…/api/2.0/…", "public", "orders", { select: "id,total", limit: 20 }).
   * PostgREST filters go in `filters` as column → "op.value" (e.g. "eq.42").
   */
  async select(
    endpoint: string,
    schema: string,
    table: string,
    options: Readonly<{ select?: string; filters?: Readonly<Record<string, string>>; order?: string; limit?: number; signal?: AbortSignal }> = {},
  ): Promise<Record<string, unknown>[]> {
    if (!/^https:\/\//.test(endpoint)) throw new Error("The Data API endpoint must be an https:// URL.");
    if (!/^[A-Za-z_][\w$]*$/.test(schema) || !/^[A-Za-z_][\w$]*$/.test(table)) throw new Error("Invalid schema or table name.");
    try {
      return await this.client.get<Record<string, unknown>[]>(`${endpoint.replace(/\/+$/, "")}/${schema}/${table}`, {
        query: {
          select: options.select ?? "*",
          limit: Math.min(options.limit ?? 50, 1000),
          ...(options.order && { order: options.order }),
          ...options.filters,
        },
        headers: { "Accept-Profile": schema },
        ...(options.signal && { signal: options.signal }),
      });
    } catch (error) {
      throw dataApiError(error, table);
    }
  }
}
