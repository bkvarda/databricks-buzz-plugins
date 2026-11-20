// Sets up a person's poller: poller.py and a sources.json in their workspace
// folder, and a scheduled serverless job, owned by them, that runs it. Made
// through their own Databricks connection, so the job runs (and reads their
// sources) as them. Shared table sources stay off it: one job reads those for everyone.
import { writeWorkspaceFiles } from "@dbx/core/api/apps";
import type { DatabricksClient } from "@dbx/core/client";
import { EXAMPLE_SOURCES, POLLER } from "virtual:signals-poller";
import type { Onboarding } from "./client";

export const POLLER_SCHEDULE = "0 0/15 * * * ?";
export const pollerJobName = (user: string) => `Signals poller (${user})`;

type Source = Record<string, unknown> & { name: string; kind: string };

/**
 * A person's sources.json: the example's personal (`mcp`) sources and the
 * hub's `lakebase`. Slack needs their Slack user id; without one it's left out.
 */
export function personalSources(onboarding: Onboarding, slackUserId?: string, example = EXAMPLE_SOURCES): string {
  const parsed = JSON.parse(example) as { sources: Source[] };
  const slack = slackUserId?.trim();
  const sources = parsed.sources
    .filter((source) => source.kind === "mcp" && (source.name !== "slack" || slack))
    .map((source) => (source.name === "slack" && slack ? (JSON.parse(JSON.stringify(source).replaceAll("YOUR_SLACK_USER_ID", slack)) as Source) : source));
  return `${JSON.stringify({ lakebase: onboarding.lakebase, sources }, null, 2)}\n`;
}

/** The job's settings: poller.py from the person's folder, every 15 minutes, on serverless. */
export function pollerJobSettings(onboarding: Onboarding) {
  return {
    name: pollerJobName(onboarding.user),
    max_concurrent_runs: 1,
    schedule: { quartz_cron_expression: POLLER_SCHEDULE, timezone_id: "UTC", pause_status: "UNPAUSED" },
    tasks: [{ task_key: "poll", environment_key: "poller", spark_python_task: { python_file: `${onboarding.folder}/poller.py`, parameters: [...onboarding.args], source: "WORKSPACE" } }],
    environments: [{ environment_key: "poller", spec: { client: "3", dependencies: ["databricks-sdk>=0.40", "psycopg[binary]>=3.1"] } }],
  };
}

/** Points an existing job's poller task (or a new one, if it has none) at poller.py, and gives it the poller's environment. */
async function updatePollerTask(client: DatabricksClient, jobId: number, settings: ReturnType<typeof pollerJobSettings>, signal?: AbortSignal) {
  const job = await client.get<{ settings?: { tasks?: { task_key: string; spark_python_task?: { python_file?: string } }[]; environments?: { environment_key: string }[] } }>("/api/2.2/jobs/get", { query: { job_id: jobId }, ...(signal && { signal }) });
  const ours = settings.tasks[0]!;
  const task = job.settings?.tasks?.find((t) => t.spark_python_task?.python_file?.endsWith("/signals-poller/poller.py"));
  const tasks = (job.settings?.tasks ?? []).filter((t) => t !== task).concat({ ...ours, task_key: task?.task_key ?? ours.task_key });
  const environments = (job.settings?.environments ?? []).filter((e) => e.environment_key !== ours.environment_key).concat(settings.environments);
  await client.post("/api/2.2/jobs/update", { job_id: jobId, new_settings: { tasks, environments } }, { ...(signal && { signal }) });
}

export type PollerJob = Readonly<{ jobId: number; created: boolean; keptSources: boolean }>;

type ListedJob = { job_id: number; creator_user_name?: string; settings?: { name?: string; tasks?: { spark_python_task?: { python_file?: string } }[] } };

/**
 * The person's poller job, if they have one: theirs, and named "Signals poller
 * (<email>)" or running poller.py from their folder (a job they made by hand).
 */
export async function findPollerJob(client: DatabricksClient, user: string, signal?: AbortSignal): Promise<number | undefined> {
  const script = `/Workspace/Users/${user}/signals-poller/poller.py`.toLowerCase();
  const runsPoller = (job: ListedJob) => job.settings?.tasks?.some((task) => [script, script.replace(/^\/workspace/, "")].includes((task.spark_python_task?.python_file ?? "").toLowerCase()));
  const mine = (job: ListedJob) => !job.creator_user_name || job.creator_user_name.toLowerCase() === user.toLowerCase();
  let pageToken: string | undefined;
  for (let page = 0; page < 20; page++) {
    const reply = await client.get<{ jobs?: ListedJob[]; next_page_token?: string }>("/api/2.2/jobs/list", { query: { expand_tasks: true, limit: 100, ...(pageToken && { page_token: pageToken }) }, ...(signal && { signal }) });
    const jobs = (reply.jobs ?? []).filter(mine);
    const found = jobs.find((job) => job.settings?.name === pollerJobName(user)) ?? jobs.find(runsPoller);
    if (found) return found.job_id;
    if (!reply.next_page_token) return undefined;
    pageToken = reply.next_page_token;
  }
  return undefined;
}

/**
 * Writes poller.py (always, so it's current) and sources.json (only if there
 * isn't one: they may have edited it), then creates the job or brings an
 * existing one up to date, and starts a first run.
 */
export async function setUpPollerJob(client: DatabricksClient, onboarding: Onboarding, options: Readonly<{ slackUserId?: string; signal?: AbortSignal }> = {}): Promise<PollerJob> {
  const { signal } = options;
  if (!onboarding.lakebase) throw new Error("The hub doesn't know where its database is, so a job can't reach it. Check the app's postgres resource.");
  if (onboarding.role === "waiting") throw new Error("Create your database role first: the job logs in to the hub's database as it.");
  const config = `${onboarding.folder}/sources.json`;
  const hadSources = await client.get("/api/2.0/workspace/get-status", { query: { path: config }, ...(signal && { signal }) }).then(
    () => true,
    (error: { status?: number; errorCode?: string }) => (error.status === 404 || error.errorCode === "RESOURCE_DOES_NOT_EXIST" ? false : Promise.reject(error)),
  );
  await writeWorkspaceFiles(client, onboarding.folder, { "poller.py": POLLER, "sources.json": personalSources(onboarding, options.slackUserId) }, { keep: ["sources.json"], ...(signal && { signal }) });
  const settings = pollerJobSettings(onboarding);
  const existing = await findPollerJob(client, onboarding.user, signal);
  let jobId = existing;
  // An existing job keeps its name, schedule and settings; only its poller task is brought up to date.
  if (existing) await updatePollerTask(client, existing, settings, signal);
  else jobId = (await client.post<{ job_id: number }>("/api/2.2/jobs/create", settings, { ...(signal && { signal }) })).job_id;
  await client.post("/api/2.2/jobs/run-now", { job_id: jobId }, { ...(signal && { signal }) });
  return { jobId: jobId!, created: !existing, keptSources: hadSources };
}
