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
    environments: [{ environment_key: "poller", spec: { client: "2", dependencies: ["psycopg[binary]"] } }],
  };
}

export type PollerJob = Readonly<{ jobId: number; created: boolean; keptSources: boolean }>;

/** The person's poller job, by its name, if they have one. */
export async function findPollerJob(client: DatabricksClient, user: string, signal?: AbortSignal): Promise<number | undefined> {
  const reply = await client.get<{ jobs?: { job_id: number; creator_user_name?: string }[] }>("/api/2.2/jobs/list", { query: { name: pollerJobName(user), limit: 25 }, ...(signal && { signal }) });
  return reply.jobs?.find((job) => !job.creator_user_name || job.creator_user_name.toLowerCase() === user.toLowerCase())?.job_id;
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
  if (existing) await client.post("/api/2.2/jobs/reset", { job_id: existing, new_settings: settings }, { ...(signal && { signal }) });
  else jobId = (await client.post<{ job_id: number }>("/api/2.2/jobs/create", settings, { ...(signal && { signal }) })).job_id;
  await client.post("/api/2.2/jobs/run-now", { job_id: jobId }, { ...(signal && { signal }) });
  return { jobId: jobId!, created: !existing, keptSources: hadSources };
}
