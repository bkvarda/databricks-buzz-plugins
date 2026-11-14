// Databricks links in conversations: an inline chip with live status, and a
// side panel with details. Everything is read with the *viewer's* own
// sign-in, so each person only sees what Databricks lets them see.
import type { ComponentType, ReactNode } from "react";
import type { BrowserViewProps, LinkPreviewProps, PanelProps } from "@dbx/core/host-types";
import { type DashboardSummary, dashboardSummary } from "@dbx/core/api/dashboards";
import { Jobs, LINK_LABEL, parseWorkspaceUrl, type RunStatus, runLabel, runTone, type WorkspaceLink } from "@dbx/core/api/workspace";
import { Sql } from "@dbx/core/api/sql";
import { React } from "@dbx/core/react";
import { type DatabricksService, describeError, isApiError, useAsync, useConnection } from "@dbx/core/service";
import { ago, Badge, Button, Card, DatabricksMark, DbxRoot, EmptyState, Notice, openExternal, Spinner, Stack, StatusDot, Text } from "@dbx/core/ui/components";
import { DataTable } from "@dbx/core/ui/data";
import { resultSet } from "@dbx/core/result";

/** Status reads are shared across chips for the same object for 20 seconds. */
const statusCache = new Map<string, { at: number; value: Promise<ChipStatus | undefined> }>();

type ChipStatus = { label: string; tone: "success" | "danger" | "warning" | "active" | "neutral"; title?: string };

function sameWorkspace(service: DatabricksService, link: WorkspaceLink) {
  const snapshot = service.snapshot();
  return snapshot.status === "connected" && snapshot.profile.host === link.host;
}

async function chipStatus(service: DatabricksService, link: WorkspaceLink): Promise<ChipStatus | undefined> {
  const client = service.client();
  if (!client || !sameWorkspace(service, link)) return undefined;
  const jobs = new Jobs(client);
  if (link.kind === "run") {
    const run = await jobs.run(link.runId);
    return { label: runLabel(run), tone: runTone(run), title: run.name };
  }
  if (link.kind === "job") {
    const job = await jobs.job(link.jobId);
    return job.latest
      ? { label: runLabel(job.latest), tone: runTone(job.latest), title: `${job.name} — latest run` }
      : { label: job.name, tone: "neutral" };
  }
  if (link.kind === "pipeline") {
    const pipeline = await jobs.pipeline(link.pipelineId);
    const state = pipeline.latest?.state ?? pipeline.state;
    const tone = /FAILED/.test(state) ? "danger" : /COMPLETED|IDLE/.test(state) ? "success" : /RUNNING|INITIALIZING|SETTING_UP|WAITING/.test(state) ? "active" : "neutral";
    return { label: state.toLowerCase().replace(/_/g, " "), tone, title: pipeline.name };
  }
  return undefined;
}

function cachedStatus(service: DatabricksService, link: WorkspaceLink, url: string) {
  const hit = statusCache.get(url);
  if (hit && Date.now() - hit.at < 20_000) return hit.value;
  const value = chipStatus(service, link).catch(() => undefined);
  statusCache.set(url, { at: Date.now(), value });
  return value;
}

export function linkChip(service: DatabricksService) {
  return function DatabricksLink(props: { url: string }) {
    const link = React.useMemo(() => parseWorkspaceUrl(props.url), [props.url]);
    const snapshot = useConnection(service);
    const [status, setStatus] = React.useState<ChipStatus>();
    React.useEffect(() => {
      if (!link || snapshot.status !== "connected") return;
      let live = true;
      const load = () =>
        void cachedStatus(service, link, props.url).then((value) => {
          if (live) setStatus(value);
        });
      load();
      // Keep running work fresh while it is on screen.
      const timer = setInterval(() => {
        if (status?.tone === "active") {
          statusCache.delete(props.url);
          load();
        }
      }, 30_000);
      return () => {
        live = false;
        clearInterval(timer);
      };
    }, [link, props.url, snapshot.status, status?.tone]);
    if (!link) return <>{props.url}</>;
    const label =
      link.kind === "table" ? link.fullName : link.kind === "workspace" ? link.host.replace(/^https:\/\//, "").split(".")[0] : LINK_LABEL[link.kind];
    return (
      <span style={{ display: "inline-flex", alignItems: "center", gap: 4, verticalAlign: "baseline" }} title={status?.title}>
        <span data-dbx="" style={{ display: "inline-flex", alignItems: "center" }}>
          <DatabricksMark size={11} />
        </span>
        <span>{label}</span>
        {status && (
          <span data-dbx="" style={{ display: "inline-flex", alignItems: "center", gap: 4 }}>
            <StatusDot tone={status.tone} label={status.label} />
            <span style={{ fontSize: "0.85em", opacity: 0.85 }}>{status.label}</span>
          </span>
        )}
      </span>
    );
  };
}

export const panelMatches = (url: string) => {
  const link = parseWorkspaceUrl(url);
  return link?.kind === "run" || link?.kind === "job" || link?.kind === "pipeline" || link?.kind === "table";
};

// Dashboards open beside the conversation in Buzz's own browser, as the live
// dashboard (Buzz's window can't frame other sites, so the embedding Databricks
// documents doesn't apply), and a card under the message says which one it is.

type DashboardLink = Extract<WorkspaceLink, { kind: "dashboard" }>;

function dashboardLink(url: string): DashboardLink | undefined {
  const link = parseWorkspaceUrl(url);
  return link?.kind === "dashboard" ? link : undefined;
}

export const isDashboardUrl = (url: string) => dashboardLink(url) !== undefined;

/** Website storage for dashboards in Buzz's browser: one workspace sign-in, kept between opens and restarts. */
export const DASHBOARD_STORAGE = "databricks";

/** Cards for the same dashboard share one read for a minute. */
const summaries = new Map<string, { at: number; value: Promise<DashboardSummary | undefined> }>();
/** Names read so far, so a dashboard's tab is named before its page loads. */
const names = new Map<string, string>();
const dashboardKey = (link: DashboardLink) => `${link.host}/${link.dashboardId}`;

function cachedSummary(service: DatabricksService, link: DashboardLink): Promise<DashboardSummary | undefined> {
  const key = dashboardKey(link);
  const hit = summaries.get(key);
  if (hit && Date.now() - hit.at < 60_000) return hit.value;
  const client = service.client();
  if (!client) return Promise.resolve(undefined);
  const value = dashboardSummary(client, link.dashboardId).then(
    (summary) => {
      if (summary) names.set(key, summary.name);
      return summary;
    },
    (error: unknown) => {
      // A failed read isn't kept, so the next card tries again.
      summaries.delete(key);
      throw error;
    },
  );
  summaries.set(key, { at: Date.now(), value });
  return value;
}

/** What a dashboard card says under the name. */
export function dashboardDetail(summary: DashboardSummary, now = Date.now()): string {
  if (summary.published !== undefined) return `Published ${ago(summary.published, now)}`;
  if (summary.updated !== undefined) return `Not published · edited ${ago(summary.updated, now)}`;
  return "Not published";
}

/** The live dashboard, in a tab beside the conversation. */
export function dashboardPanel(View: ComponentType<BrowserViewProps>) {
  return function DashboardPanel(props: PanelProps) {
    const link = dashboardLink(props.target);
    const label = (link && names.get(dashboardKey(link))) ?? "Dashboard";
    return <View url={props.target} storage={DASHBOARD_STORAGE} label={label} />;
  };
}

/** A card under a message for a dashboard link: its name, when it was published, and where to open it. */
export function dashboardCard(service: DatabricksService, opensInBuzz: boolean) {
  return function DashboardCard(props: LinkPreviewProps) {
    const link = React.useMemo(() => dashboardLink(props.url), [props.url]);
    const snapshot = useConnection(service);
    const connected = snapshot.status === "connected";
    const readable = !!link && connected && sameWorkspace(service, link);
    const state = useAsync(async () => (readable && link ? cachedSummary(service, link) : undefined), [props.url, readable]);
    if (!link) return null;
    const host = link.host.replace(/^https:\/\//, "");
    let detail: string;
    if (!connected) detail = "Connect Databricks in Settings to see its name.";
    else if (!readable) detail = `In ${host}, not the workspace you're connected to.`;
    else if (state.loading && !state.data) detail = "Loading…";
    else if (state.error)
      detail = isApiError(state.error) && state.error.isPermission ? "You don't have access to this dashboard." : "Couldn't read this dashboard.";
    else if (!state.data) detail = "This dashboard doesn't exist anymore.";
    else detail = dashboardDetail(state.data);
    return (
      <DbxRoot style={{ width: "min(100%, 26rem)" }}>
        <Card padding={12}>
          <Stack gap={6}>
            <Stack direction="row" gap={6} align="center">
              <DatabricksMark size={12} />
              <Text size="xs" tone="subtle">
                Dashboard · {host.split(".")[0]}
              </Text>
            </Stack>
            <Text weight={500}>{state.data?.name ?? "Databricks dashboard"}</Text>
            <Text size="sm" tone="subtle">
              {detail}
            </Text>
            <Stack direction="row" gap={6} style={{ marginTop: 4 }}>
              {opensInBuzz && (
                <Button size="sm" onClick={() => props.open()}>
                  Open in Buzz
                </Button>
              )}
              <Button size="sm" variant="ghost" onClick={() => openExternal(props.url)}>
                Open in browser
              </Button>
            </Stack>
          </Stack>
        </Card>
      </DbxRoot>
    );
  };
}

function RunDetails(props: { run: RunStatus }) {
  const { run } = props;
  return (
    <Stack gap={12}>
      <Stack direction="row" gap={8} align="center">
        <StatusDot tone={runTone(run)} label={runLabel(run)} />
        <Text weight={500}>{runLabel(run)}</Text>
        {run.startTime && (
          <Text tone="subtle" size="sm">
            started {ago(run.startTime)}
            {run.endTime ? ` · took ${Math.max(1, Math.round((run.endTime - run.startTime) / 1000))}s` : ""}
          </Text>
        )}
      </Stack>
      {run.message && <Notice tone={runTone(run) === "danger" ? "danger" : "info"}>{run.message}</Notice>}
      {run.tasks.length > 0 && (
        <Stack gap={4}>
          <Text size="sm" weight={500}>
            Tasks
          </Text>
          {run.tasks.map((task) => {
            const tone = runTone({ ...run, lifecycle: task.lifecycle, result: task.result, done: ["TERMINATED", "SKIPPED", "INTERNAL_ERROR"].includes(task.lifecycle) } as RunStatus);
            return (
              <Stack key={task.key} direction="row" gap={8} align="center">
                <StatusDot tone={tone} label={task.result ?? task.lifecycle} />
                <Text size="sm" mono>
                  {task.key}
                </Text>
                <Text size="xs" tone="subtle">
                  {(task.result ?? task.lifecycle).toLowerCase()}
                </Text>
              </Stack>
            );
          })}
        </Stack>
      )}
    </Stack>
  );
}

export function workspacePanel(service: DatabricksService) {
  return function DatabricksPanel(props: PanelProps) {
    const link = React.useMemo(() => parseWorkspaceUrl(props.target), [props.target]);
    const snapshot = useConnection(service);
    const state = useAsync(
      async (signal) => {
        if (!link) return undefined;
        const client = await service.ready(signal);
        if (!sameWorkspace(service, link)) return { kind: "elsewhere" as const };
        const jobs = new Jobs(client);
        if (link.kind === "run") return { kind: "run" as const, run: await jobs.run(link.runId, signal) };
        if (link.kind === "job") return { kind: "job" as const, job: await jobs.job(link.jobId, signal) };
        if (link.kind === "pipeline") return { kind: "pipeline" as const, pipeline: await jobs.pipeline(link.pipelineId, signal) };
        if (link.kind === "table") {
          const sql = new Sql(client);
          const table = await sql.table(link.fullName, signal);
          return { kind: "table" as const, table };
        }
        return undefined;
      },
      [props.target, snapshot.status],
    );
    let body: ReactNode;
    if (snapshot.status !== "connected")
      body = (
        <EmptyState title="Connect Databricks" action={<Button variant="brand" onClick={() => service.openSettings()}>Connect</Button>}>
          Sign in to see live details for Databricks links.
        </EmptyState>
      );
    else if (state.loading && !state.data) body = <Stack direction="row" gap={8} align="center"><Spinner /><Text tone="subtle">Loading…</Text></Stack>;
    else if (state.error) body = <Notice tone="danger" title="Couldn't load this">{describeError(state.error)}</Notice>;
    else if (state.data?.kind === "elsewhere")
      body = <Notice title="Different workspace">This link is in {link?.host.replace("https://", "")}; you're connected to another workspace.</Notice>;
    else if (state.data?.kind === "run")
      body = (
        <Stack gap={12}>
          <Text as="h3" size="lg" weight={500}>{state.data.run.name}</Text>
          <RunDetails run={state.data.run} />
        </Stack>
      );
    else if (state.data?.kind === "job")
      body = (
        <Stack gap={12}>
          <Text as="h3" size="lg" weight={500}>{state.data.job.name}</Text>
          {state.data.job.latest ? <RunDetails run={state.data.job.latest} /> : <Text tone="subtle">No runs yet.</Text>}
        </Stack>
      );
    else if (state.data?.kind === "pipeline")
      body = (
        <Stack gap={8}>
          <Text as="h3" size="lg" weight={500}>{state.data.pipeline.name}</Text>
          <Badge>{(state.data.pipeline.latest?.state ?? state.data.pipeline.state).toLowerCase()}</Badge>
        </Stack>
      );
    else if (state.data?.kind === "table") {
      const table = state.data.table;
      body = (
        <Stack gap={10}>
          <Text as="h3" size="lg" weight={500} mono>{table.full_name}</Text>
          {table.comment && <Text tone="subtle">{table.comment}</Text>}
          <DataTable
            result={resultSet(
              [{ name: "column" }, { name: "type" }, { name: "comment" }],
              (table.columns ?? []).map((column) => [column.name, column.type_text ?? "", column.comment ?? ""]),
            )}
          />
        </Stack>
      );
    } else body = <Text tone="subtle">Nothing to show for this link.</Text>;
    return (
      <DbxRoot style={{ padding: "var(--space-panel-inset, 16px)" }}>
        <Stack gap={14}>
          {body}
          <Stack direction="row" gap={8}>
            <Button variant="ghost" onClick={() => openExternal(props.target)}>
              Open in Databricks
            </Button>
            <Button variant="ghost" onClick={() => state.reload()}>
              Refresh
            </Button>
          </Stack>
        </Stack>
      </DbxRoot>
    );
  };
}
