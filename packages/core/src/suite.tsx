// Shared bootstrap for feature plugins in the suite.
//
// Feature plugins attach to the core plugin's `databricks` service. Their
// tools and renderers exist only while it is there; their pages stay
// registered and explain how to add the core plugin when it is missing.
import type { Context, PluginInstaller } from "@buzz/author";
import { optionalService } from "./host-types";
import { React } from "./react";
import { CORE_PLUGIN_ID, type DatabricksService, withDatabricks } from "./service";
import { Button, DbxRoot, EmptyState } from "./ui/components";

export const REPOSITORY = "https://github.com/bkvarda/databricks-buzz-plugins";

/** A value that comes and goes with the core plugin, observable from React. */
export class Live<T> {
  private value: T | undefined;
  private listeners = new Set<() => void>();
  snapshot = () => this.value;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };
  set(value: T | undefined) {
    this.value = value;
    for (const listener of [...this.listeners]) listener();
  }
}

/**
 * Runs `apply` while the core plugin provides its service. Whatever `apply`
 * returns is published on the returned Live until the service goes away.
 */
export function attach<T>(
  ctx: Context,
  member: Readonly<{ id: string; name: string }>,
  apply: (scope: Context, databricks: DatabricksService) => T,
): Live<T> {
  const live = new Live<T>();
  withDatabricks(ctx, member, (scope, databricks) => {
    live.set(apply(scope, databricks));
    scope.effect(() => () => live.set(undefined));
  });
  return live;
}

export function useLive<T>(live: Live<T>): T | undefined {
  return React.useSyncExternalStore(live.subscribe, live.snapshot);
}

export function MissingCore(props: { ctx: Context; feature: string }) {
  const [message, setMessage] = React.useState<string>();
  const add = async () => {
    const installer = optionalService<PluginInstaller>(props.ctx, "pluginInstaller");
    if (!installer) {
      setMessage("Add it from Settings → Plugins → Manage plugins → Add, using github.com/bkvarda/databricks-buzz-plugins.");
      return;
    }
    const outcome = await installer.requestInstall({ repository: REPOSITORY, reference: "main", path: "plugins/databricks/dist" }).catch(() => "unavailable" as const);
    if (outcome === "unavailable") setMessage("Close any open plugin review and try again.");
  };
  return (
    <DbxRoot style={{ padding: 32 }}>
      <EmptyState
        title="Add the Databricks plugin"
        action={
          <Button variant="brand" onClick={() => void add()}>
            Add Databricks
          </Button>
        }
      >
        {props.feature} uses the Databricks plugin ({CORE_PLUGIN_ID}) for sign-in. Add it, or turn it back on in Settings → Plugins.
        {message && <p>{message}</p>}
      </EmptyState>
    </DbxRoot>
  );
}
