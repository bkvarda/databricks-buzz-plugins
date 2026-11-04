// The `databricks` Cordis service: what the core "Databricks" plugin provides
// to the rest of the suite. Feature plugins never spawn processes or hold
// credentials themselves; they ask this service for a client. Only the core
// plugin declares host access, so there is one access review and one sign-in.
//
// Each plugin bundles its own copy of this package, so the contract must stay
// structural and versioned: never rely on `instanceof` across plugins.
import type { Context } from "@buzz/author";
import type { CliProfile } from "./cli";
import type { DatabricksClient } from "./client";
import type { ConnectionSnapshot } from "./connection";
import { browserStorage, type ConnectionStorage } from "./connection";
import { React } from "./react";

export const SERVICE_NAME = "databricks";
export const CORE_PLUGIN_ID = "bkvarda.databricks";
export const SETTINGS_SECTION = `${CORE_PLUGIN_ID}/connection`;

export type Preferences = Readonly<{
  get<T = unknown>(key: string): T | undefined;
  set(key: string, value: unknown): void;
  subscribe(listener: () => void): () => void;
}>;

export type DatabricksService = Readonly<{
  version: 1;
  snapshot(): ConnectionSnapshot;
  subscribe(listener: () => void): () => void;
  /** The connected workspace's client, or undefined. */
  client(): DatabricksClient | undefined;
  /** Waits briefly for startup, then resolves with a client or rejects with
   * an error whose message tells the person how to connect. */
  ready(signal?: AbortSignal): Promise<DatabricksClient>;
  workspaceUrl(path: string): string | undefined;
  profiles(): readonly CliProfile[];
  openSettings(): void;
  signIn(): Promise<void>;
  /** Per-workspace preferences shared by the suite on this device. */
  preferences: Preferences;
  /** Lists a feature plugin in Settings → Databricks while it is active. */
  announce?(member: Readonly<{ id: string; name: string }>): () => void;
  /**
   * A service bound to another CLI profile, for an agent that works in a
   * different workspace. Same sign-in, token refresh and transport as the main
   * connection; the main connection is untouched.
   */
  forProfile?(profile: string): DatabricksService;
  /**
   * Browser sign-in to another workspace without switching the main
   * connection. Resolves with the new (or reused) CLI profile name.
   */
  addWorkspace?(options?: Readonly<{ host?: string }>): Promise<string>;
}>;

declare module "@deepseek-ai/cordis" {
  interface Context {
    databricks: DatabricksService;
  }
}

/** Runs `apply` while the Databricks plugin provides its service, and tears
 * it down when that plugin is disabled or replaced. */
export function withDatabricks(
  ctx: Context,
  member: Readonly<{ id: string; name: string }>,
  apply: (scope: Context, databricks: DatabricksService) => void,
): void {
  ctx.inject([SERVICE_NAME], (scope: Context) => {
    const databricks = scope.databricks;
    if (!databricks || databricks.version !== 1) return;
    const leave = databricks.announce?.(member);
    if (leave) scope.effect(() => leave);
    apply(scope, databricks);
  });
}

export function createPreferences(
  scope: () => string,
  storage: ConnectionStorage = browserStorage,
): Preferences & { notify(): void } {
  const listeners = new Set<() => void>();
  const key = () => `bkvarda.databricks.prefs.v1:${scope()}`;
  const read = (): Record<string, unknown> => {
    try {
      return (JSON.parse(storage.get(key()) ?? "{}") as Record<string, unknown>) ?? {};
    } catch {
      return {};
    }
  };
  const notify = () => {
    for (const listener of [...listeners]) listener();
  };
  return {
    get: <T>(name: string) => read()[name] as T | undefined,
    set(name, value) {
      const next = { ...read() };
      if (value === undefined || value === null) delete next[name];
      else next[name] = value;
      storage.set(key(), JSON.stringify(next));
      notify();
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    notify,
  };
}

export function useConnection(service: Pick<DatabricksService, "snapshot" | "subscribe">): ConnectionSnapshot {
  return React.useSyncExternalStore(service.subscribe, service.snapshot);
}

export function usePreference<T>(service: Pick<DatabricksService, "preferences">, name: string): [T | undefined, (value: T | undefined) => void] {
  const value = React.useSyncExternalStore(service.preferences.subscribe, () =>
    JSON.stringify(service.preferences.get(name) ?? null),
  );
  const parsed = React.useMemo(() => JSON.parse(value) as T | null, [value]);
  return [parsed ?? undefined, (next) => service.preferences.set(name, next)];
}

/** Loads async data keyed by `key`, cancelling stale loads. */
export function useAsync<T>(
  load: (signal: AbortSignal) => Promise<T>,
  key: readonly unknown[],
): { data?: T; error?: Error; loading: boolean; reload(): void } {
  const [state, setState] = React.useState<{ data?: T; error?: Error; loading: boolean }>({ loading: true });
  const [nonce, setNonce] = React.useState(0);
  React.useEffect(() => {
    const controller = new AbortController();
    setState((previous) => ({ ...previous, loading: true }));
    load(controller.signal).then(
      (data) => {
        if (!controller.signal.aborted) setState({ data, loading: false });
      },
      (error: unknown) => {
        if (!controller.signal.aborted)
          setState({ error: error instanceof Error ? error : new Error(String(error)), loading: false });
      },
    );
    return () => controller.abort();
    // biome-ignore lint/correctness/useExhaustiveDependencies: caller supplies the key
  }, [...key, nonce]);
  return { ...state, reload: () => setNonce((n) => n + 1) };
}

/** True for errors from DatabricksClient, across plugin bundles. */
export function isApiError(error: unknown): error is Error & {
  status: number;
  errorCode?: string;
  isPermission: boolean;
  isNotFound: boolean;
  isFeatureDisabled: boolean;
} {
  return error instanceof Error && error.name === "DatabricksApiError";
}

/** A short, human message for any error. */
export function describeError(error: unknown): string {
  if (isApiError(error)) {
    if (error.isPermission) return `You don't have access: ${error.message}`;
    if (error.isFeatureDisabled) return `This isn't enabled in your workspace: ${error.message}`;
    return error.message;
  }
  if (error instanceof Error) return error.message;
  return String(error);
}
