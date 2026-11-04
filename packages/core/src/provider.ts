// Builds the `databricks` service from a Connection (core plugin only).
import type { Connection } from "./connection";
import { createPreferences, type DatabricksService } from "./service";

export type SuiteMember = Readonly<{ id: string; name: string }>;

export type ProvidedService = DatabricksService &
  Readonly<{
    /** Feature plugins announce themselves so Settings can show them. */
    announce(member: SuiteMember): () => void;
    members(): readonly SuiteMember[];
    subscribeMembers(listener: () => void): () => void;
  }>;

export function createService(connection: Connection, openSettings: () => void): ProvidedService {
  const scope = () => {
    const snapshot = connection.snapshot();
    return snapshot.status === "connected" ? snapshot.profile.host : "none";
  };
  const preferences = createPreferences(scope);
  // Workspace-scoped preferences change when the workspace does.
  connection.subscribe(preferences.notify);
  const members = new Map<string, SuiteMember>();
  const memberListeners = new Set<() => void>();
  let memberList: readonly SuiteMember[] = [];
  const notifyMembers = () => {
    memberList = [...members.values()].sort((a, b) => a.name.localeCompare(b.name));
    for (const listener of [...memberListeners]) listener();
  };
  return {
    version: 1,
    snapshot: connection.snapshot,
    subscribe: connection.subscribe,
    client: () => connection.client(),
    ready: (signal) => connection.ready(signal),
    workspaceUrl: (path) => connection.workspaceUrl(path),
    profiles: () => {
      const snapshot = connection.snapshot();
      return "profiles" in snapshot ? snapshot.profiles : [];
    },
    openSettings,
    signIn: () => connection.signIn(),
    preferences,
    announce(member) {
      members.set(member.id, member);
      notifyMembers();
      return () => {
        if (members.get(member.id) === member) {
          members.delete(member.id);
          notifyMembers();
        }
      };
    },
    members: () => memberList,
    subscribeMembers(listener) {
      memberListeners.add(listener);
      return () => memberListeners.delete(listener);
    },
  };
}
