import { describe, expect, it } from "vitest";
import type { DatabricksClient } from "@dbx/core/client";
import type { Onboarding } from "../plugins/signals/src/client";
import { personalSources, pollerJobName, pollerJobSettings, setUpPollerJob } from "../plugins/signals/src/poller-job";

const lakebase = { endpoint: "projects/p/branches/b/endpoints/e", host: "h", database: "databricks_postgres", schema: "signals_hub" };
const folder = "/Workspace/Users/ann@x.com/signals-poller";
const onboarding: Onboarding = { user: "ann@x.com", role: "ready", lakebase, folder, args: ["--config", `${folder}/sources.json`, "--lakebase"] };

type Call = { method: string; path: string; body?: unknown; query?: unknown };
function fakeClient(state: { jobs?: { job_id: number; creator_user_name?: string }[]; sources?: boolean }) {
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
    expect(without.sources.map((source: { name: string }) => source.name)).not.toContain("table.support_cases");
    const withSlack = personalSources(onboarding, "U0123");
    expect(withSlack).toContain("<@U0123>");
    expect(withSlack).not.toContain("YOUR_SLACK_USER_ID");
  });

  it("runs poller.py from the person's folder with the full config path, every 15 minutes on serverless", () => {
    const settings = pollerJobSettings(onboarding);
    expect(settings.name).toBe(pollerJobName("ann@x.com"));
    expect(settings.tasks[0]!.spark_python_task).toEqual({ python_file: `${folder}/poller.py`, parameters: ["--config", `${folder}/sources.json`, "--lakebase"], source: "WORKSPACE" });
    expect(settings.environments[0]!.spec.dependencies).toEqual(["psycopg[binary]"]);
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

  it("updates an existing job and keeps a sources.json the person already has", async () => {
    const { client, calls } = fakeClient({ jobs: [{ job_id: 7, creator_user_name: "Ann@x.com" }], sources: true });
    expect(await setUpPollerJob(client, onboarding)).toEqual({ jobId: 7, created: false, keptSources: true });
    expect(calls.filter((call) => call.path === "/api/2.0/workspace/import").map((call) => (call.body as { path: string }).path)).toEqual([`${folder}/poller.py`]);
    expect(calls.some((call) => call.path === "/api/2.2/jobs/create")).toBe(false);
    expect((calls.find((call) => call.path === "/api/2.2/jobs/reset")?.body as { job_id: number }).job_id).toBe(7);
  });

  it("won't make a job before the person has a database role, or when the hub doesn't know its database", async () => {
    const { client } = fakeClient({});
    await expect(setUpPollerJob(client, { ...onboarding, role: "waiting" })).rejects.toThrow(/database role first/);
    const { lakebase: _, ...bare } = onboarding;
    await expect(setUpPollerJob(client, bare)).rejects.toThrow(/doesn't know where its database is/);
  });
});
