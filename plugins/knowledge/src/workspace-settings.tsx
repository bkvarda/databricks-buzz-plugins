// Settings → Databricks Knowledge, first section: which workspace the plugin
// works in and which SQL warehouse finds skills schemas. Both default to what
// the rest of the suite uses ("Same as Buzz", Automatic) and can be changed
// here. Everything in the plugin (tools, cards, channel setup) follows the
// workspace chosen; the warehouse choice is kept per workspace.
import { Sql } from "@dbx/core/api/sql";
import { React } from "@dbx/core/react";
import { type DatabricksService, useAsync, useConnection, usePreference } from "@dbx/core/service";
import type { SkillCatalog } from "@dbx/core/skill-catalog";
import { Field, SectionHeader, Stack, Text } from "@dbx/core/ui/components";
import { WorkspaceField } from "@dbx/core/ui/workspace";
import type { FollowedService } from "@dbx/core/workspace-choice";

/** In the main connection's preferences: the CLI profile Knowledge works in. */
export const WORKSPACE_PREF = "knowledgeWorkspace";
/** In the chosen workspace's preferences: the warehouse for finding skills. */
export const WAREHOUSE_PREF = "knowledgeWarehouse";

export function WorkspaceSettings(props: { main: DatabricksService; service: FollowedService; catalog: SkillCatalog }) {
  const { main, service, catalog } = props;
  const connection = useConnection(service);
  const state = React.useSyncExternalStore(catalog.subscribe, catalog.snapshot);
  const host = connection.status === "connected" ? connection.profile.host : undefined;
  const [warehouseId, setWarehouseId] = usePreference<string>(service, WAREHOUSE_PREF);
  const warehouses = useAsync(async (signal) => (host ? new Sql(await service.ready(signal)).warehouses(signal) : []), [host]);
  const [, setProfile] = usePreference<string>(main, WORKSPACE_PREF);
  const profile = service.profile();
  const used = state.warehouse && !warehouseId ? ` Last used: ${state.warehouse.name}.` : "";
  return (
    <Stack gap={12}>
      <SectionHeader title="Workspace and warehouse" description="Where skills, domains and Pages are read and published. Agents' skill tools use it too." />
      <WorkspaceField
        service={main}
        {...(profile && { profile })}
        onChange={(next) => {
          setProfile(next);
          void catalog.load(true);
        }}
      />
      <Field
        label="SQL warehouse for finding skills"
        hint={`Runs one query on schema tags to find skills schemas across your catalogs. Automatic tries your default warehouse, then others you can use.${used}`}
      >
        <select
          className="dbx-select"
          value={warehouseId ?? ""}
          disabled={!host}
          onChange={(event) => {
            setWarehouseId(event.target.value || undefined);
            void catalog.load(true);
          }}
        >
          <option value="">Automatic</option>
          {(warehouses.data ?? []).map((warehouse) => (
            <option key={warehouse.id} value={warehouse.id}>
              {warehouse.name}
              {warehouse.state ? ` · ${warehouse.state.toLowerCase()}` : ""}
            </option>
          ))}
          {warehouseId && !(warehouses.data ?? []).some((warehouse) => warehouse.id === warehouseId) && <option value={warehouseId}>{warehouseId}</option>}
        </select>
      </Field>
      {warehouses.error && (
        <Text tone="danger" size="sm">
          Couldn't list SQL warehouses: {warehouses.error.message}
        </Text>
      )}
    </Stack>
  );
}
