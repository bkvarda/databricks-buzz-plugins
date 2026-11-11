// Builds the `databricks` service from a Connection (core plugin only).
import type { Connection, ConnectionStorage } from "./connection";
import { createPreferences, type DatabricksService } from "./service";

export type SuiteMember = Readonly<{ id: string; name: string }>;

export type ProvidedService = DatabricksService &
  Readonly<{
    /** Feature plugins announce themselves so Settings can show them. */
    announce(member: SuiteMember): () => void;
    members(): readonly SuiteMember[];
    subscribeMembers(listener: () => void): () => void;
  }>;

/** In-memory selection storage, so a profile connection never changes the main one. */
const memoryStorage = (): ConnectionStorage => {
  const values = new Map<string, string>();
  return { get: (key) => values.get(key) ?? null, set: (key, value) => (value === null ? values.delete(key) : values.set(key, value)) };
};

/**
 * Builds the `databricks` service. `spawn` makes another Connection (same host
 * and transport) for agents that work in a different workspace.
 */
export function createService(
  connection: Connection,
  openSettings: () => void,
  spawn?: (storage: ConnectionStorage) => Connection,
): ProvidedService {
  const scope = () => {
    const snapshot = connection.snapshot();
    return snapshot.status === "connected" ? snapshot.profile.host : "none";
  };
  const preferences = createPreferences(scope);
  const byProfile = new Map<string, DatabricksService>();
  const profileService = (profile: string): DatabricksService => {
    // The main connection's own profile is just the main service, also while
    // its sign-in has expired or is being renewed, so a workspace has one sign-in.
    if (connection.snapshot().status !== "signed-out" && connection.profileName() === profile) return service;
    let found = byProfile.get(profile);
    if (!found && spawn) {
      const derived = spawn(memoryStorage());
      void derived.useProfile(profile).catch(() => {});
      found = createService(derived, openSettings);
      byProfile.set(profile, found);
    }
    return found ?? service;
  };
  // Workspace-scoped preferences change when the workspace does.
  connection.subscribe(preferences.notify);
  const members = new Map<string, SuiteMember>();
  const memberListeners = new Set<() => void>();
  let memberList: readonly SuiteMember[] = [];
  const notifyMembers = () => {
    memberList = [...members.values()].sort((a, b) => a.name.localeCompare(b.name));
    for (const listener of [...memberListeners]) listener();
  };
  const service: ProvidedService = {
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
    reauthenticate: () => connection.reauthenticate(),
    cancelSignIn: () => connection.cancelSignIn(),
    preferences,
    ...(spawn && {
      forProfile: (profile: string) => profileService(profile),
      async addWorkspace(options: Readonly<{ host?: string }> = {}) {
        const fresh = spawn(memoryStorage());
        await fresh.signIn(options);
        const snapshot = fresh.snapshot();
        if (snapshot.status !== "connected")
          throw new Error(("error" in snapshot && snapshot.error) || ("message" in snapshot && snapshot.message) || "Sign-in didn't finish.");
        byProfile.set(snapshot.profile.name, createService(fresh, openSettings));
        // The main connection learns about the new profile too.
        void connection.refreshProfiles();
        return snapshot.profile.name;
      },
    }),
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
  return service;
}
