// Lakebase: let agents read operational data in Lakebase (Databricks managed
// Postgres) through the Data API, as the signed-in person. Postgres roles and
// grants decide what each person can read; this plugin only reads.
import type { Context } from "@buzz/author";
import { type DataApiTarget, dataApiError, dataApiSetupSql, Lakebase } from "@dbx/core/api/workspace";
import { apiError } from "@dbx/core/client";
import { type AgentTool, numberArg, schema, stringArg } from "@dbx/core/host-types";
import { bindReact, React } from "@dbx/core/react";
import { resultSet, toMarkdown } from "@dbx/core/result";
import { type DatabricksService, describeError, useAsync, useConnection, usePreference } from "@dbx/core/service";
import { attach, MissingCore, useLive } from "@dbx/core/suite";
import { Badge, Button, CodeView, DbxRoot, Disclosure, Field, Notice, SectionHeader, Spinner, Stack, Text } from "@dbx/core/ui/components";

export const inject = ["react", "settingsCards"];

export type Database = { name: string; url: string; description?: string };
const DATABASES = "lakebaseDatabases";

const databases = (service: DatabricksService) => service.preferences.get<Database[]>(DATABASES) ?? [];

function rowsToResult(rows: Record<string, unknown>[]) {
  const columns = [...new Set(rows.flatMap((row) => Object.keys(row)))];
  return resultSet(
    columns.map((name) => ({ name })),
    rows.map((row) => columns.map((column) => (row[column] == null ? null : typeof row[column] === "object" ? JSON.stringify(row[column]) : String(row[column])))),
  );
}

export function lakebaseTools(service: DatabricksService): AgentTool[] {
  return [
    {
      name: "databricks_lakebase_databases",
      description:
        "Lists the Lakebase (Databricks Postgres) databases the owner registered for agents, plus the Lakebase projects in the workspace. Use a registered database name with databricks_lakebase_select.",
      inputSchema: schema.object({}),
      async call() {
        const client = await service.ready();
        const registered = databases(service);
        const projects = (await new Lakebase(client).projects().catch(() => [])).filter((project) => !project.id.startsWith("databricks-internal-"));
        return [
          registered.length
            ? `Registered databases:\n${registered.map((db) => `- ${db.name}${db.description ? `: ${db.description}` : ""}`).join("\n")}`
            : "No databases are registered for agents yet (the owner adds Data API endpoints in Settings → Lakebase).",
          projects.length ? `\nLakebase projects in the workspace:\n${projects.map((p) => `- ${p.name} (${p.id})`).join("\n")}` : "",
        ].join("\n");
      },
    },
    {
      name: "databricks_lakebase_select",
      description:
        "Reads rows from a table or view in a registered Lakebase database through the Data API (PostgREST). Filter with PostgREST operators, e.g. filters {\"status\": \"eq.open\", \"amount\": \"gt.100\"}; order like \"created_at.desc\". Read-only.",
      inputSchema: schema.object(
        {
          database: schema.string("A registered database name."),
          table: schema.string("Table or view name."),
          schema: schema.string("Postgres schema (default public)."),
          select: schema.string("Columns, comma separated (default *)."),
          filters: { type: "object", description: "Column → PostgREST condition such as eq.42.", additionalProperties: { type: "string" } },
          order: schema.string("Ordering, e.g. created_at.desc"),
          limit: schema.integer("Rows (default 50, max 500)."),
        },
        ["database", "table"],
      ),
      async call(_client, _context, args) {
        const name = stringArg(args, "database");
        const database = databases(service).find((db) => db.name.toLowerCase() === name.toLowerCase());
        if (!database) throw new Error(`No registered database named ${name}. Call databricks_lakebase_databases.`);
        const client = await service.ready();
        const rows = await new Lakebase(client).select(database.url, stringArg(args, "schema", false) || "public", stringArg(args, "table"), {
          ...(stringArg(args, "select", false) && { select: stringArg(args, "select") }),
          ...(args.filters && typeof args.filters === "object" ? { filters: args.filters as Record<string, string> } : {}),
          ...(stringArg(args, "order", false) && { order: stringArg(args, "order") }),
          limit: numberArg(args, "limit", 50, 1, 500),
        });
        if (!rows.length) return "No rows.";
        return `${toMarkdown(rowsToResult(rows), 100)}\n\nThese rows came from the owner's access; everyone in this conversation can read what you post.`;
      },
    },
  ];
}

type Check = { state: "idle" | "testing" | "ok" | "error" | "role"; message?: string };

/**
 * Checks that the Data API is on and reachable. A missing table answers 404
 * before the role check, so role problems only show on a real read.
 */
async function checkDatabase(service: DatabricksService, url: string): Promise<Check> {
  try {
    const client = await service.ready();
    const response = await client.request(`${url.replace(/\/+$/, "")}/public/buzz_connection_check`, { query: { limit: 0 }, headers: { "Accept-Profile": "public" } });
    if (response.status < 400 || /PGRST205/.test(response.body)) return { state: "ok", message: "The Data API is on and answering." };
    const error = dataApiError(apiError(response), "");
    return { state: error.name === "DataApiRoleError" ? "role" : "error", message: error.message };
  } catch (error) {
    return { state: "error", message: describeError(error) };
  }
}

function DatabaseRow(props: { service: DatabricksService; db: Database; userName: string; onRemove(): void }) {
  const [check, setCheck] = React.useState<Check>({ state: "idle" });
  return (
    <div className="dbx-card" style={{ padding: 12 }}>
      <Stack gap={8}>
        <Stack direction="row" align="center" justify="space-between" gap={10}>
          <Stack gap={2} style={{ minWidth: 0 }}>
            <Text weight={500}>{props.db.name}</Text>
            <Text tone="subtle" size="xs" mono style={{ overflow: "hidden", textOverflow: "ellipsis" }}>{props.db.url}</Text>
          </Stack>
          <Stack direction="row" gap={6} align="center" style={{ flex: "none" }}>
            <Button size="sm" disabled={check.state === "testing"} onClick={async () => {
              setCheck({ state: "testing" });
              setCheck(await checkDatabase(props.service, props.db.url));
            }}>
              {check.state === "testing" ? <Spinner size={12} /> : null}Test
            </Button>
            <Button size="sm" variant="danger" onClick={props.onRemove}>Remove</Button>
          </Stack>
        </Stack>
        {check.state === "ok" && <Text size="sm" tone="success">{check.message}</Text>}
        {check.state === "error" && <Text size="sm" tone="danger">{check.message}</Text>}
        <Disclosure summary="Access setup for the Data API" defaultOpen={check.state === "role"}>
          <Stack gap={8}>
            <Text size="sm" tone={check.state === "role" ? "warning" : "subtle"} as="div">
              {check.state === "role" ? `${check.message} ` : ""}
              The Data API reads as you, through a Postgres role a project owner creates once in the project's SQL editor. Roles added in the Lakebase UI, and project owners themselves, can't be used.
            </Text>
            <CodeView code={dataApiSetupSql(props.userName)} />
          </Stack>
        </Disclosure>
      </Stack>
    </div>
  );
}

function ProjectRow(props: {
  service: DatabricksService;
  project: { id: string; name: string };
  workspaceId: string | undefined;
  added: readonly string[];
  onAdd(target: DataApiTarget): void;
}) {
  const { service, project, workspaceId } = props;
  const targets = useAsync(
    async (signal) => (workspaceId ? new Lakebase(await service.ready(signal)).dataApiTargets(project.id, workspaceId, signal) : []),
    [project.id, workspaceId],
  );
  return (
    <div className="dbx-card" style={{ padding: 12 }}>
      <Stack gap={8}>
        <Stack direction="row" gap={8} align="center">
          <Text weight={500}>{project.name}</Text>
          {project.id !== project.name && <Text tone="tertiary" size="xs" mono>{project.id}</Text>}
        </Stack>
        {targets.loading && <Spinner size={12} />}
        {targets.error && <Text tone="subtle" size="sm">{describeError(targets.error)}</Text>}
        {(targets.data ?? []).map((target) => {
          const added = props.added.includes(target.url);
          return (
            <Stack key={target.url} direction="row" gap={8} align="center" justify="space-between">
              <Text size="sm" mono>{target.branch} / {target.database}</Text>
              {added ? <Badge tone="success">Added</Badge> : <Button size="sm" onClick={() => props.onAdd(target)}>Add for agents</Button>}
            </Stack>
          );
        })}
        {targets.data && !targets.data.length && <Text tone="subtle" size="sm">No read-write compute on the default branch.</Text>}
      </Stack>
    </div>
  );
}

function LakebaseSettings(props: { service: DatabricksService }) {
  const { service } = props;
  const snapshot = useConnection(service);
  const [list, setList] = usePreference<Database[]>(service, DATABASES);
  const [draft, setDraft] = React.useState<Database>({ name: "", url: "", description: "" });
  const [test, setTest] = React.useState<{ state: "idle" | "testing" | "ok" | "error"; message?: string }>({ state: "idle" });
  // Databricks keeps its own Lakebase projects (for example the one behind
  // managed memory) under "databricks-internal-"; they aren't for agents.
  const projects = useAsync(
    async (signal) => (await new Lakebase(await service.ready(signal)).projects(signal)).filter((project) => !project.id.startsWith("databricks-internal-")),
    [snapshot.status],
  );
  if (snapshot.status !== "connected")
    return <Notice title="Connect Databricks" action={<Button variant="brand" onClick={() => service.openSettings()}>Connect</Button>}>Lakebase lives in your Databricks workspace.</Notice>;
  const valid = /^[a-z][\w-]{0,40}$/i.test(draft.name) && /^https:\/\//.test(draft.url);
  return (
    <Stack gap={24}>
      <Stack gap={6}>
        <Text as="h2" size="xl" weight={500}>Lakebase</Text>
        <Text tone="subtle">Give agents read access to operational data in Lakebase Postgres. Requests use your Databricks sign-in, so your Postgres role's grants apply.</Text>
      </Stack>
      <Stack gap={10}>
        <SectionHeader title="Databases for agents" description={(list ?? []).length ? "Agents can read these with databricks_lakebase_select." : "None yet. Add one from your projects below."} />
        {(list ?? []).map((db) => (
          <DatabaseRow
            key={db.name}
            service={service}
            db={db}
            userName={snapshot.user.userName}
            onRemove={() => setList((list ?? []).filter((candidate) => candidate.name !== db.name))}
          />
        ))}
        <Disclosure summary="Add by Data API URL">
        <Stack gap={8} style={{ maxWidth: 560 }}>
          <Field label="Name agents use"><input className="dbx-input" value={draft.name} onChange={(event) => setDraft({ ...draft, name: event.target.value.trim() })} placeholder="orders-db" /></Field>
          <Field label="Data API URL"><input className="dbx-input" value={draft.url} onChange={(event) => setDraft({ ...draft, url: event.target.value.trim() })} placeholder="https://…" /></Field>
          <Field label="What's in it (optional)"><input className="dbx-input" value={draft.description} onChange={(event) => setDraft({ ...draft, description: event.target.value })} placeholder="Orders and fulfillment for the storefront app" /></Field>
          <Stack direction="row" gap={8} align="center">
            <Button
              disabled={!valid || test.state === "testing"}
              onClick={async () => {
                setTest({ state: "testing" });
                const result = await checkDatabase(service, draft.url);
                setTest({ state: result.state === "ok" ? "ok" : "error", ...(result.message && { message: result.message }) });
              }}
            >
              {test.state === "testing" ? <Spinner size={12} /> : null}Test
            </Button>
            <Button
              variant="primary"
              disabled={!valid || (list ?? []).some((db) => db.name === draft.name)}
              onClick={() => {
                setList([...(list ?? []), { name: draft.name, url: draft.url.replace(/\/+$/, ""), ...(draft.description?.trim() && { description: draft.description.trim() }) }]);
                setDraft({ name: "", url: "", description: "" });
                setTest({ state: "idle" });
              }}
            >
              Add database
            </Button>
            {test.message && <Text size="sm" tone={test.state === "ok" ? "success" : "danger"}>{test.message}</Text>}
          </Stack>
        </Stack>
        </Disclosure>
      </Stack>
      <Stack gap={8}>
        <SectionHeader title="Lakebase projects in this workspace" description="Add a database in one click. Agents read it through its Data API, which must be turned on for the project." />
        {projects.loading && <Spinner size={12} />}
        {projects.error && <Text tone="subtle" size="sm">{describeError(projects.error)}</Text>}
        {(projects.data ?? []).map((project) => (
          <ProjectRow
            key={project.id}
            service={service}
            project={project}
            workspaceId={snapshot.workspaceId ?? snapshot.profile.workspaceId}
            added={(list ?? []).map((db) => db.url)}
            onAdd={(target) => {
              const taken = new Set((list ?? []).map((db) => db.name));
              let name = target.database === "databricks_postgres" ? target.project : `${target.project}-${target.database}`;
              name = name.replace(/[^\w-]/g, "-").slice(0, 40);
              for (let n = 2; taken.has(name); n++) name = `${name.replace(/-\d+$/, "")}-${n}`;
              setList([...(list ?? []), { name, url: target.url, description: `Lakebase project ${project.name}, database ${target.database}` }]);
            }}
          />
        ))}
        {projects.data && !projects.data.length && <Text tone="subtle" size="sm">No Lakebase projects yet.</Text>}
      </Stack>
    </Stack>
  );
}

export function apply(ctx: Context) {
  bindReact(ctx.react);
  const live = attach(ctx, { id: "bkvarda.databricks-lakebase", name: "Lakebase" }, (scope, databricks) => {
    scope.inject(["agents"], (agents: Context) => {
      for (const tool of lakebaseTools(databricks)) agents.agents.addTool(tool);
    });
    return databricks;
  });
  ctx.settingsCards.register({
    id: "lakebase",
    title: "Lakebase",
    component: () => {
      const service = useLive(live);
      return service ? (
        <DbxRoot>
          <LakebaseSettings service={service} />
        </DbxRoot>
      ) : (
        <MissingCore ctx={ctx} feature="Lakebase" />
      );
    },
  });
}
