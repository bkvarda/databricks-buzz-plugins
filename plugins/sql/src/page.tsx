// The SQL page: a catalog browser in the sidebar and an editor with results.
import type { PageSidebarProps } from "@buzz/author";
import { Sql, type Warehouse } from "@dbx/core/api/sql";
import type { PageProps } from "@dbx/core/host-types";
import { React } from "@dbx/core/react";
import { type DatabricksService, describeError, useAsync, useConnection, usePreference } from "@dbx/core/service";
import { Button, DbxRoot, EmptyState, Field, Notice, Spinner, Stack, Text } from "@dbx/core/ui/components";
import { ResultView } from "@dbx/core/ui/data";
import { ALLOW_WRITES } from "./tools";
import type { Runs } from "./runs";

/** The editor text, shared so the sidebar can insert statements. */
export class Editor {
  text = "SELECT current_user(), current_catalog(), current_date()";
  private listeners = new Set<() => void>();
  snapshot = () => this.text;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };
  set(text: string) {
    this.text = text;
    for (const listener of [...this.listeners]) listener();
  }
}

function Tree(props: { service: DatabricksService; editor: Editor }) {
  const { service, editor } = props;
  const [open, setOpen] = React.useState<Record<string, boolean>>({});
  const catalogs = useAsync(async (signal) => new Sql(await service.ready(signal)).catalogs(signal), [service.snapshot()]);
  const toggle = (key: string) => setOpen((current) => ({ ...current, [key]: !current[key] }));
  if (catalogs.loading) return <Stack direction="row" gap={8} align="center" style={{ padding: 10 }}><Spinner size={12} /><Text tone="subtle" size="sm">Loading catalogs…</Text></Stack>;
  if (catalogs.error) return <Text tone="danger" size="sm" as="div" style={{ padding: 10 }}>{describeError(catalogs.error)}</Text>;
  return (
    <div role="tree" aria-label="Unity Catalog">
      {(catalogs.data ?? []).map((catalog) => (
        <div key={catalog.name} role="treeitem" aria-expanded={Boolean(open[catalog.name])}>
          <Row label={catalog.name} depth={0} open={Boolean(open[catalog.name])} onClick={() => toggle(catalog.name)} />
          {open[catalog.name] && <Schemas service={service} editor={editor} catalog={catalog.name} open={open} toggle={toggle} />}
        </div>
      ))}
    </div>
  );
}

function Row(props: { label: string; depth: number; open?: boolean; leaf?: boolean; onClick(): void; title?: string }) {
  return (
    <button
      type="button"
      className="dbx-row"
      onClick={props.onClick}
      title={props.title ?? props.label}
      style={{
        display: "flex",
        alignItems: "center",
        gap: 6,
        width: "100%",
        border: 0,
        background: "transparent",
        padding: `4px 8px 4px ${8 + props.depth * 14}px`,
        borderRadius: 6,
        cursor: "pointer",
        font: "inherit",
        fontSize: "0.8125rem",
        color: "var(--dbx-ink)",
        textAlign: "left",
      }}
    >
      <span aria-hidden style={{ width: 10, color: "var(--dbx-tertiary)", fontSize: 9 }}>{props.leaf ? "▦" : props.open ? "▾" : "▸"}</span>
      <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{props.label}</span>
    </button>
  );
}

function Schemas(props: { service: DatabricksService; editor: Editor; catalog: string; open: Record<string, boolean>; toggle(key: string): void }) {
  const schemas = useAsync(async (signal) => new Sql(await props.service.ready(signal)).schemas(props.catalog, signal), [props.catalog]);
  if (schemas.loading) return <Text tone="subtle" size="xs" as="div" style={{ padding: "4px 30px" }}>Loading…</Text>;
  if (schemas.error) return <Text tone="danger" size="xs" as="div" style={{ padding: "4px 30px" }}>{describeError(schemas.error)}</Text>;
  return (
    <>
      {(schemas.data ?? []).map((schema) => (
        <div key={schema.full_name}>
          <Row label={schema.name} depth={1} open={Boolean(props.open[schema.full_name])} onClick={() => props.toggle(schema.full_name)} />
          {props.open[schema.full_name] && <Tables {...props} schema={schema.name} />}
        </div>
      ))}
    </>
  );
}

function Tables(props: { service: DatabricksService; editor: Editor; catalog: string; schema: string }) {
  const tables = useAsync(async (signal) => new Sql(await props.service.ready(signal)).tables(props.catalog, props.schema, signal), [props.catalog, props.schema]);
  if (tables.loading) return <Text tone="subtle" size="xs" as="div" style={{ padding: "4px 44px" }}>Loading…</Text>;
  if (tables.error) return <Text tone="danger" size="xs" as="div" style={{ padding: "4px 44px" }}>{describeError(tables.error)}</Text>;
  if (!tables.data?.length) return <Text tone="tertiary" size="xs" as="div" style={{ padding: "4px 44px" }}>No tables</Text>;
  const quote = (part: string) => (/^[A-Za-z_][A-Za-z0-9_]*$/.test(part) ? part : `\`${part.replace(/`/g, "``")}\``);
  return (
    <>
      {tables.data.map((table) => (
        <Row
          key={table.full_name}
          leaf
          label={table.name}
          depth={2}
          title={`${table.full_name}${table.comment ? ` — ${table.comment}` : ""}\nClick to query`}
          onClick={() => props.editor.set(`SELECT *\nFROM ${[props.catalog, props.schema, table.name].map(quote).join(".")}\nLIMIT 100`)}
        />
      ))}
    </>
  );
}

export function sqlSidebar(service: DatabricksService, editor: Editor) {
  return function SqlSidebar(props: PageSidebarProps) {
    const snapshot = useConnection(service);
    return (
      <div className="shell-sidebar-default">
        <DbxRoot style={{ display: "flex", flexDirection: "column", height: "100%", minHeight: 0 }}>
          <Text weight={500} as="div" style={{ padding: "14px 12px 8px" }}>
            Catalog
          </Text>
          <nav aria-label="Unity Catalog" style={{ flex: 1, overflow: "auto", padding: "0 6px 8px" }}>
            {snapshot.status === "connected" ? <Tree service={service} editor={editor} /> : <Text tone="subtle" size="sm" as="div" style={{ padding: 10 }}>Connect Databricks to browse your catalog.</Text>}
          </nav>
          {props.children && <div style={{ borderTop: "1px solid var(--dbx-border)", padding: 6 }}>{props.children}</div>}
        </DbxRoot>
      </div>
    );
  };
}

export function sqlPage(service: DatabricksService, editor: Editor, runs: Runs) {
  return function SqlPage(_props: PageProps) {
    const snapshot = useConnection(service);
    const text = React.useSyncExternalStore(editor.subscribe, editor.snapshot);
    React.useSyncExternalStore(runs.subscribe, runs.snapshot);
    const [warehouseId, setWarehouseId] = usePreference<string>(service, "warehouseId");
    const warehouses = useAsync(async (signal) => new Sql(await service.ready(signal)).warehouses(signal), [snapshot.status]);
    const [lastRun, setLastRun] = React.useState<string>();
    const run = lastRun ? runs.get(lastRun) : undefined;
    if (snapshot.status !== "connected")
      return (
        <DbxRoot style={{ padding: 32 }}>
          <EmptyState title="Connect Databricks to run SQL" action={<Button variant="brand" onClick={() => service.openSettings()}>Connect Databricks</Button>}>
            Queries run on your SQL warehouses with your Unity Catalog permissions.
          </EmptyState>
        </DbxRoot>
      );
    const execute = () => {
      if (!text.trim()) return;
      setLastRun(text);
      runs.request(text);
    };
    const list: readonly Warehouse[] = warehouses.data ?? [];
    return (
      <DbxRoot style={{ height: "100%", overflow: "auto" }}>
        <Stack gap={14} style={{ padding: "22px 28px", maxWidth: 1100, margin: "0 auto" }}>
          <Stack direction="row" align="center" justify="space-between" gap={12} wrap>
            <Text as="h2" size="lg" weight={500}>
              SQL
            </Text>
            <Stack direction="row" gap={8} align="center">
              <select className="dbx-select" value={warehouseId ?? ""} onChange={(event) => setWarehouseId(event.target.value || undefined)} aria-label="SQL warehouse" style={{ width: 280 }}>
                <option value="">Automatic warehouse</option>
                {list.map((w) => (
                  <option key={w.id} value={w.id}>
                    {w.name} · {w.state?.toLowerCase()}
                  </option>
                ))}
              </select>
              <Button variant="primary" onClick={execute} disabled={run?.status === "running"} title="Run (⌘↵)">
                {run?.status === "running" ? <Spinner size={12} label="Running" /> : null}
                Run
              </Button>
            </Stack>
          </Stack>
          <textarea
            className="dbx-textarea dbx-mono"
            value={text}
            onChange={(event) => editor.set(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
                event.preventDefault();
                execute();
              }
            }}
            spellCheck={false}
            rows={9}
            aria-label="SQL statement"
            style={{ fontSize: "0.8125rem", minHeight: 180 }}
          />
          {run?.status === "confirm" && lastRun && (
            <Notice
              tone="warning"
              title="This statement can change data"
              action={
                <Stack direction="row" gap={6}>
                  <Button size="sm" variant="primary" onClick={() => void runs.run(lastRun)}>Run anyway</Button>
                  <Button size="sm" variant="ghost" onClick={() => runs.clear(lastRun)}>Cancel</Button>
                </Stack>
              }
            >
              It will run with your Databricks access.
            </Notice>
          )}
          {run?.status === "running" && (
            <Stack direction="row" gap={8} align="center">
              <Spinner size={12} />
              <Text tone="subtle">Running…</Text>
              <Button size="sm" variant="ghost" onClick={() => lastRun && runs.cancel(lastRun)}>Cancel</Button>
            </Stack>
          )}
          {run?.status === "error" && <Notice tone="danger" title="The query failed">{run.message}</Notice>}
          {run?.status === "done" && (
            <Stack gap={8}>
              <ResultView result={run.result} maxHeight={480} />
              <Text tone="tertiary" size="xs">
                {run.warehouse} · {(run.ms / 1000).toFixed(1)}s · statement {run.statementId}
              </Text>
            </Stack>
          )}
        </Stack>
      </DbxRoot>
    );
  };
}

export function sqlSettings(service: DatabricksService) {
  return function SqlSettings() {
    const [allow, setAllow] = usePreference<boolean>(service, ALLOW_WRITES);
    return (
      <DbxRoot>
        <Stack gap={20}>
          <Stack gap={6}>
            <Text as="h2" size="xl" weight={500}>Databricks SQL</Text>
            <Text tone="subtle">SQL blocks in conversations get a Run action, and agents can query your data with your access.</Text>
          </Stack>
          <Field
            label="Agents can run statements that change data"
            hint="Off: agents may only read (SELECT, SHOW, DESCRIBE). This applies to this workspace on this device."
          >
            <label style={{ display: "flex", gap: 8, alignItems: "center", fontSize: "0.8125rem" }}>
              <input type="checkbox" checked={Boolean(allow)} onChange={(event) => setAllow(event.target.checked || undefined)} />
              Allow INSERT, UPDATE, DELETE, CREATE and other writes from agents
            </label>
          </Field>
        </Stack>
      </DbxRoot>
    );
  };
}
