// A fully remote agent's keeper: a scheduled serverless job, running as the
// owner, that starts the agent's Sandbox when it has stopped (the 24-hour
// limit, a crash, or an agent sleeping on purpose) and starts its runner.
// This is what keeps the agent working with the owner's laptop off.
import type { DatabricksClient } from "@dbx/core/client";

export const KEEPER_SCRIPT = `# Keeps a Buzz agent's Databricks Sandbox and runner up.
# Created by the Databricks Agents plugin for Buzz; deleting the agent deletes its job.
import sys, time
from databricks.sdk import WorkspaceClient

sandbox = sys.argv[1]
w = WorkspaceClient()

def api(method, path, body=None):
    return w.api_client.do(method, path, body=body)

state = api("GET", f"/api/2.0/sandboxes/{sandbox}").get("status", {}).get("state")
print("sandbox", sandbox, "was", state)
if state in ("SANDBOX_STATE_STOPPED", "SANDBOX_STATE_STOPPING"):
    deadline = time.time() + 300
    while state == "SANDBOX_STATE_STOPPING" and time.time() < deadline:
        time.sleep(5)
        state = api("GET", f"/api/2.0/sandboxes/{sandbox}").get("status", {}).get("state")
    if state == "SANDBOX_STATE_STOPPED":
        api("POST", f"/api/2.0/sandboxes/{sandbox}/start")
deadline = time.time() + 300
while state != "SANDBOX_STATE_RUNNING" and time.time() < deadline:
    time.sleep(3)
    state = api("GET", f"/api/2.0/sandboxes/{sandbox}").get("status", {}).get("state")
if state != "SANDBOX_STATE_RUNNING":
    raise SystemExit(f"sandbox didn't start: {state}")
r = api("POST", f"/api/2.0/sandbox-exec/sandboxes/{sandbox}/exec-sync",
        body={"cmd": "/bin/bash", "args": ["-lc", "node ~/.buzz/agent/runner.mjs start"], "execution_timeout": "60s"})
print("runner:", r.get("exit_code"), (r.get("stdout") or "").strip()[-500:], (r.get("stderr") or "").strip()[-500:])
if r.get("exit_code") != 0:
    raise SystemExit("runner didn't start")
`;

/** Every 30 minutes for an agent that is always on (a restart after the 24-hour limit); every 15 for one that sleeps. */
export const keeperSchedule = (availability: "always" | "sleep") => (availability === "always" ? "0 0/30 * * * ?" : "0 0/15 * * * ?");

const scriptPath = (home: string) => `${home}/.buzz/agent_keeper.py`;

/** Uploads the keeper script to the owner's workspace folder. */
async function uploadScript(client: DatabricksClient, home: string, signal?: AbortSignal) {
  await client.post("/api/2.0/workspace/mkdirs", { path: `${home}/.buzz` }, signal ? { signal } : {});
  await client.post(
    "/api/2.0/workspace/import",
    { path: scriptPath(home), format: "AUTO", language: "PYTHON", overwrite: true, content: btoa(KEEPER_SCRIPT) },
    signal ? { signal } : {},
  );
}

/**
 * Creates or updates the agent's keeper job and returns its ID. The job runs
 * as the person who creates it, so it reaches their Sandbox.
 */
export async function ensureKeeper(
  client: DatabricksClient,
  input: Readonly<{ jobId?: number; sandbox: string; agentName: string; pubkey: string; availability: "always" | "sleep"; signal?: AbortSignal }>,
): Promise<number> {
  const me = await client.get<{ userName: string }>("/api/2.0/preview/scim/v2/Me", { query: { attributes: "userName" }, ...(input.signal && { signal: input.signal }) });
  const home = `/Users/${me.userName}`;
  await uploadScript(client, home, input.signal);
  const settings = {
    name: `Buzz agent: ${input.agentName}`.slice(0, 100),
    description: "Keeps a fully remote Buzz agent's Databricks Sandbox and runner up. Created by the Databricks Agents plugin; removing the agent in Buzz deletes this job.",
    tags: { created_by: "buzz", buzz_agent: input.pubkey.slice(0, 16) },
    schedule: { quartz_cron_expression: keeperSchedule(input.availability), timezone_id: "UTC", pause_status: "UNPAUSED" },
    max_concurrent_runs: 1,
    tasks: [
      {
        task_key: "keep",
        spark_python_task: { python_file: scriptPath(home), parameters: [input.sandbox] },
        environment_key: "default",
        timeout_seconds: 900,
      },
    ],
    environments: [{ environment_key: "default", spec: { client: "2" } }],
  };
  const init = input.signal ? { signal: input.signal } : {};
  if (input.jobId) {
    try {
      await client.post("/api/2.2/jobs/reset", { job_id: input.jobId, new_settings: settings }, init);
      return input.jobId;
    } catch (error) {
      if ((error as { status?: number }).status !== 400 && (error as { status?: number }).status !== 404) throw error;
    }
  }
  const created = await client.post<{ job_id: number }>("/api/2.2/jobs/create", settings, init);
  return created.job_id;
}

/** Runs the keeper now (after activation, so the agent comes up at once). */
export const runKeeperNow = (client: DatabricksClient, jobId: number, signal?: AbortSignal) =>
  client.post("/api/2.2/jobs/run-now", { job_id: jobId }, signal ? { signal } : {});

export async function deleteKeeper(client: DatabricksClient, jobId: number, signal?: AbortSignal) {
  try {
    await client.post("/api/2.2/jobs/delete", { job_id: jobId }, signal ? { signal } : {});
  } catch (error) {
    // Already gone counts as deleted.
    const status = (error as { status?: number }).status;
    if (status !== 400 && status !== 404) throw error;
  }
}
