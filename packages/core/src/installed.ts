// Whether Buzz has a plugin installed, on or off. Buzz 0.7.14 and later can
// say; older hosts lack the status methods, so callers see no status and keep
// offering Add, as before.
import type { Context, Navigation, PluginInstaller } from "@buzz/author";
import { optionalService } from "./host-types";
import { React } from "./react";

export type InstallationStatus = "installed" | "absent" | "unavailable";

type StatusMethods = Readonly<{
  get(id: string): InstallationStatus;
  subscribe(id: string, listener: () => void): () => void;
}>;

/** The installer's status methods, when this host has them. */
export function statusMethods(installer: PluginInstaller | undefined): StatusMethods | undefined {
  const get = installer?.getInstallationStatus;
  const subscribe = installer?.subscribeInstallationStatus;
  if (typeof get !== "function" || typeof subscribe !== "function") return undefined;
  return {
    get: (id) => get.call(installer, id),
    subscribe: (id, listener) => subscribe.call(installer, id, () => listener()),
  };
}

/** Each plugin's installation status, kept current. Empty where the host can't say. */
export function useInstallationStatus(installer: () => PluginInstaller | undefined, ids: readonly string[]): ReadonlyMap<string, InstallationStatus> {
  const key = ids.join("\n");
  // The getter is often a new function each render; only the ids decide when to resubscribe.
  const getter = React.useRef(installer);
  getter.current = installer;
  const [statuses, setStatuses] = React.useState<ReadonlyMap<string, InstallationStatus>>(new Map());
  React.useEffect(() => {
    const methods = statusMethods(getter.current());
    if (!methods) return;
    const list = key.split("\n");
    const read = () => {
      const next = new Map(list.map((id) => [id, methods.get(id)] as const));
      setStatuses((current) => (sameStatuses(current, next) ? current : next));
    };
    // Subscribe first, then read, so a change in between isn't missed.
    const stops = list.map((id) => methods.subscribe(id, read));
    read();
    return () => {
      for (const stop of stops) stop();
    };
  }, [key]);
  return statuses;
}

function sameStatuses(a: ReadonlyMap<string, InstallationStatus>, b: ReadonlyMap<string, InstallationStatus>) {
  return a.size === b.size && [...b].every(([id, status]) => a.get(id) === status);
}

/** Opens a plugin's details in Settings → Plugins, where it can be turned on. */
export function openPluginDetails(ctx: Context, id: string) {
  const navigation = optionalService<Navigation>(ctx, "navigation");
  if (!navigation) return false;
  void navigation.open({ version: 1, kind: "settings", section: "plugins", pluginId: id });
  return true;
}
