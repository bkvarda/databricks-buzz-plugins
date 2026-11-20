import { describe, expect, it } from "vitest";
import type { DatabricksClient } from "@dbx/core/client";
import type { Onboarding } from "../plugins/signals/src/client";
import { personalSources, pollerJobName, pollerJobSettings, setUpPollerJob } from "../plugins/signals/src/poller-job";

const lakebase = { endpoint: "projects/p/branches/b/endpoints/e", host: "h", database: "databricks_postgres", schema: "signals_hub" };
const folder = "/Workspace/Users/ann@x.com/signals-poller";
const onboarding: Onboarding = { user: "ann@x.com", role: "ready", lakebase, folder, args: ["--config", `${folder}/sources.json`, "--lakebase"] };

type Call = { method: string; path: string; body?: unknown; query?: unknown };
type Job = { job_id: number; creator_user_name?: string; settings?: { name?: string; tasks?: { task_key: string; spark_python_task?: { python_file?: string } }[]; environments?: { environment_key: string }[] } };
function fakeClient(state: { jobs?: Job[]; sources?: boolean }) {
  const calls: Call[] = [];
  const client = {
    async get(path: string, init: { query?: unknown } = {}) {
      calls.push({ method: "GET", path, query: init.query });
      if (path === "/api/2.0/workspace/get-status") {
        const query = init.query as { path: string };
        if (query.path.endsWith("sources.json") && state.sources) return {};
        throw Object.assign(new Error("missing"), { status: 404 });
      }
      if (path === "/api/2.2/jobs/list") return { jobs: state.jobs ?? [] };
      if (path === "/api/2.2/jobs/get") return state.jobs?.find((job) => job.job_id === (init.query as { job_id: number }).job_id) ?? {};
      throw new Error(`unexpected GET ${path}`);
    },
    async post(path: string, body?: unknown) {
      calls.push({ method: "POST", path, body });
      if (path === "/api/2.2/jobs/create") return { job_id: 42 };
      return {};
    },
  };
  return { client: client as unknown as DatabricksClient, calls };
}
const decode = (content: string) => new TextDecoder().decode(Uint8Array.from(atob(content), (c) => c.charCodeAt(0)));

describe("a person's poller job", () => {
  it("has only personal sources, the hub's lakebase, and Slack only with a Slack user id", () => {
    const without = JSON.parse(personalSources(onboarding));
    expect(without.lakebase).toEqual(lakebase);
    expect(without.sources.every((source: { kind: string }) => source.kind === "mcp")).toBe(true);
    expect(without.sources.map((source: { name: string }) => source.name)).not.toContain("slack");
    expect(without.sources.map((source: { name: string }) => source.name)).not.toContain("slack.sent");
    expect(without.sources.map((source: { name: string }) => source.name)).not.toContain("table.support_cases");
    const withSlack = personalSources(onboarding, "U0123");
    expect(withSlack).toContain("<@U0123>");
    expect(withSlack).not.toContain("YOUR_SLACK_USER_ID");
    const sent = JSON.parse(withSlack).sources.find((source: { name: string }) => source.name === "slack.sent");
    expect(sent.args.filters).toBe("from:<@U0123>");
  });

  it("runs poller.py from the person's folder with the full config path, every 15 minutes on serverless", () => {
    const settings = pollerJobSettings(onboarding);
    expect(settings.name).toBe(pollerJobName("ann@x.com"));
    expect(settings.tasks[0]!.spark_python_task).toEqual({ python_file: `${folder}/poller.py`, parameters: ["--config", `${folder}/sources.json`, "--lakebase"], source: "WORKSPACE" });
    expect(settings.environments[0]!.spec).toEqual({ client: "3", dependencies: ["databricks-sdk>=0.40", "psycopg[binary]>=3.1"] });
    expect(settings.schedule.quartz_cron_expression).toBe("0 0/15 * * * ?");
  });

  it("creates the job, writes both files, and starts a run", async () => {
    const { client, calls } = fakeClient({});
    expect(await setUpPollerJob(client, onboarding, { slackUserId: "U9" })).toEqual({ jobId: 42, created: true, keptSources: false });
    const imports = calls.filter((call) => call.path === "/api/2.0/workspace/import").map((call) => call.body as { path: string; content: string });
    expect(imports.map((file) => file.path)).toEqual([`${folder}/poller.py`, `${folder}/sources.json`]);
    expect(JSON.parse(decode(imports[1]!.content)).lakebase).toEqual(lakebase);
    expect(calls.find((call) => call.path === "/api/2.2/jobs/run-now")?.body).toEqual({ job_id: 42 });
  });

  it("updates an existing job by its name and keeps a sources.json the person already has", async () => {
    const { client, calls } = fakeClient({ jobs: [{ job_id: 7, creator_user_name: "Ann@x.com", settings: { name: pollerJobName("ann@x.com") } }], sources: true });
    expect(await setUpPollerJob(client, onboarding)).toEqual({ jobId: 7, created: false, keptSources: true });
    expect(calls.filter((call) => call.path === "/api/2.0/workspace/import").map((call) => (call.body as { path: string }).path)).toEqual([`${folder}/poller.py`]);
    expect(calls.some((call) => call.path === "/api/2.2/jobs/create")).toBe(false);
    expect((calls.find((call) => call.path === "/api/2.2/jobs/update")?.body as { job_id: number }).job_id).toBe(7);
  });

  it("finds a job made by hand that runs poller.py from the person's folder, and only updates its poller task", async () => {
    const other = { job_id: 3, creator_user_name: "bo@x.com", settings: { name: "x", tasks: [{ task_key: "t", spark_python_task: { python_file: `${folder}/poller.py` } }] } };
    const hand = { job_id: 9, creator_user_name: "ann@x.com", settings: { name: "signals-poller (ann)", tasks: [{ task_key: "run", spark_python_task: { python_file: `${folder}/poller.py` } }, { task_key: "other" }], environments: [{ environment_key: "default" }] } };
    const { client, calls } = fakeClient({ jobs: [other, { job_id: 4, creator_user_name: "ann@x.com", settings: { name: "unrelated" } }, hand], sources: true });
    expect(await setUpPollerJob(client, onboarding)).toEqual({ jobId: 9, created: false, keptSources: true });
    expect(calls.some((call) => call.path === "/api/2.2/jobs/create")).toBe(false);
    const update = calls.find((call) => call.path === "/api/2.2/jobs/update")?.body as { job_id: number; new_settings: { name?: string; tasks: { task_key: string; spark_python_task?: unknown }[] } };
    expect(update.job_id).toBe(9);
    expect(update.new_settings.name).toBeUndefined();
    expect(update.new_settings.tasks.map((task) => task.task_key)).toEqual(["other", "run"]);
    expect(update.new_settings.tasks[1]!.spark_python_task).toMatchObject({ python_file: `${folder}/poller.py`, parameters: onboarding.args });
  });

  it("won't make a job before the person has a database role, or when the hub doesn't know its database", async () => {
    const { client } = fakeClient({});
    await expect(setUpPollerJob(client, { ...onboarding, role: "waiting" })).rejects.toThrow(/database role first/);
    const { lakebase: _, ...bare } = onboarding;
    await expect(setUpPollerJob(client, bare)).rejects.toThrow(/doesn't know where its database is/);
  });
});
