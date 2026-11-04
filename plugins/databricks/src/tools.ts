// Agent tools every Buzz agent gets from the core plugin, and an Attention
// source that wakes an agent when a Databricks job run finishes. Tools act
// with the owner's Databricks sign-in on this device.
import type { Agents } from "@buzz/author";
import { Jobs, parseWorkspaceUrl, type RunStatus, runLabel } from "@dbx/core/api/workspace";
import { type AgentTool, schema, stringArg } from "@dbx/core/host-types";
import type { DatabricksService } from "@dbx/core/service";

export const SOURCE_ID = "job-run";

function runIdFrom(args: Record<string, unknown>): string {
  const url = typeof args.url === "string" ? args.url : typeof args.run_url === "string" ? args.run_url : "";
  if (url) {
    const link = parseWorkspaceUrl(url);
    if (link?.kind === "run") return link.runId;
    throw new Error("That URL is not a Databricks job run link.");
  }
  const id = String(args.run_id ?? "").trim();
  if (!/^\d+$/.test(id)) throw new Error("Give a job run URL or a numeric run_id.");
  return id;
}

export function describeRun(run: RunStatus, url?: string): string {
  const lines = [`${run.name}: ${runLabel(run)}${run.message ? ` — ${run.message}` : ""}`];
  if (run.startTime) lines.push(`Started ${new Date(run.startTime).toISOString()}${run.endTime ? `, ended ${new Date(run.endTime).toISOString()}` : ""}.`);
  for (const task of run.tasks) lines.push(`- ${task.key}: ${(task.result ?? task.lifecycle).toLowerCase()}${task.message ? ` (${task.message})` : ""}`);
  if (url ?? run.url) lines.push(`Run: ${url ?? run.url}`);
  return lines.join("\n");
}

export function coreTools(service: DatabricksService): AgentTool[] {
  return [
    {
      name: "databricks_workspace",
      description:
        "Shows which Databricks workspace this device is signed in to, as whom, and the default SQL warehouse. Use it before other databricks_* tools when unsure whether Databricks is connected.",
      inputSchema: schema.object({}),
      async call() {
        const snapshot = service.snapshot();
        if (snapshot.status !== "connected")
          return "Databricks is not connected on this device. Ask the owner to sign in under Settings → Databricks.";
        const warehouse = service.preferences.get<string>("warehouseId");
        return [
          `Workspace: ${snapshot.profile.host}`,
          `Signed in as: ${snapshot.user.userName}${snapshot.user.displayName ? ` (${snapshot.user.displayName})` : ""}`,
          `Default SQL warehouse: ${warehouse ?? "automatic"}`,
          "Data access follows this user's Unity Catalog permissions. Anything you post is visible to everyone in the conversation, so share query results only where the audience should see them.",
        ].join("\n");
      },
    },
    {
      name: "databricks_job_status",
      description:
        "Reads the status of a Databricks job run (state, result, failed tasks and messages). Pass the run URL or run_id. To be woken when a run finishes, add an Attention source watch with provider \"bkvarda.databricks/job-run\" and config {\"run_url\": \"<url>\"}.",
      inputSchema: schema.object({
        url: schema.string("A Databricks job run URL, e.g. https://<workspace>/jobs/123/runs/456"),
        run_id: schema.string("The numeric run ID, when you have no URL."),
      }),
      async call(_client, _context, args) {
        const client = await service.ready();
        const run = await new Jobs(client).run(runIdFrom(args));
        return describeRun(run);
      },
    },
    {
      name: "databricks_api_get",
      description:
        "Read-only escape hatch: performs a GET against any Databricks REST API path in the signed-in workspace (for example /api/2.1/unity-catalog/tables/main.default.orders or /api/2.2/jobs/list) and returns the JSON, truncated to 20,000 characters. Prefer the specific databricks_* tools when one fits.",
      inputSchema: schema.object(
        {
          path: schema.string("API path starting with /api/"),
          query: { type: "object", description: "Query parameters as string values.", additionalProperties: { type: "string" } },
        },
        ["path"],
      ),
      async call(_client, _context, args) {
        const path = stringArg(args, "path");
        if (!/^\/api\/[\w./:@-]+$/.test(path) || path.includes(".."))
          throw new Error("path must be a plain /api/... path without a query string.");
        const query = (args.query && typeof args.query === "object" ? args.query : {}) as Record<string, string>;
        const client = await service.ready();
        const body = await client.get(path, { query });
        const text = JSON.stringify(body, null, 1);
        return text.length > 20_000 ? `${text.slice(0, 20_000)}\n… (truncated)` : text;
      },
    },
  ];
}

/** Wakes the watch's agent once the run finishes. */
export function jobRunSource(service: DatabricksService): Parameters<Agents["addAttentionSource"]>[0] {
  return {
    id: SOURCE_ID,
    description: "Wakes the agent when a Databricks job run finishes, with its result and any failed tasks.",
    configExample: { run_url: "https://<workspace>/jobs/123/runs/456" },
    present: (watch) => {
      const url = typeof watch.config.run_url === "string" ? watch.config.run_url : undefined;
      const runId = url ? parseWorkspaceUrl(url) : undefined;
      return {
        type: "Databricks job run",
        ...(runId?.kind === "run" && { target: `Run ${runId.runId}` }),
        ...(url && { link: { href: url, title: "Open in Databricks" } }),
      };
    },
    async run({ watch, signal, emit }) {
      const config = watch.config;
      const runId = runIdFrom(config);
      const url = typeof config.run_url === "string" ? config.run_url : undefined;
      let failures = 0;
      while (!signal.aborted) {
        try {
          const client = await service.ready(signal);
          const run = await new Jobs(client).run(runId, signal);
          failures = 0;
          if (run.done) {
            emit(`The Databricks job run you were watching finished.\n${describeRun(run, url)}`);
            return;
          }
        } catch (error) {
          if (signal.aborted) return;
          if (++failures >= 20) {
            emit(`Stopped watching Databricks run ${runId}: ${(error as Error).message ?? error}`);
            return;
          }
        }
        await new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, 30_000);
          signal.addEventListener("abort", () => {
            clearTimeout(timer);
            resolve();
          }, { once: true });
        });
      }
    },
  };
}
