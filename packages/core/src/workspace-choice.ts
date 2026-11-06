// A plugin's own workspace choice. The person picks "Same as Buzz" (the
// default) or another CLI profile; the choice is kept in the main
// connection's preferences under `key`. The returned service forwards to the
// chosen workspace, so code written against one service follows the choice:
// it notifies its subscribers when the choice or that workspace changes, and
// its preferences are the chosen workspace's own (per workspace, as always).
import type { Preferences } from "./service";
import type { DatabricksService } from "./service";

export type FollowedService = DatabricksService &
  Readonly<{
    /** The chosen CLI profile, or undefined for "Same as Buzz". */
    profile(): string | undefined;
    setProfile(profile: string | undefined): void;
  }>;

export function followWorkspace(main: DatabricksService, key: string): FollowedService {
  const chosen = () => main.preferences.get<string>(key) || undefined;
  const target = () => {
    const profile = chosen();
    return profile && main.forProfile ? main.forProfile(profile) : main;
  };
  const listeners = new Set<() => void>();
  const preferenceListeners = new Set<() => void>();
  const notify = () => {
    for (const listener of [...listeners]) listener();
  };
  const notifyPreferences = () => {
    for (const listener of [...preferenceListeners]) listener();
  };
  let current = target();
  let stop = current.subscribe(notify);
  let stopPreferences = current.preferences.subscribe(notifyPreferences);
  const follow = () => {
    const next = target();
    if (next === current) return;
    stop();
    stopPreferences();
    current = next;
    stop = current.subscribe(notify);
    stopPreferences = current.preferences.subscribe(notifyPreferences);
    notify();
    notifyPreferences();
  };
  // The choice lives in the main workspace's preferences, which also change
  // when Buzz signs in to another workspace.
  main.preferences.subscribe(follow);
  main.subscribe(follow);

  const preferences: Preferences = {
    get: (name) => current.preferences.get(name),
    set: (name, value) => current.preferences.set(name, value),
    subscribe: (listener) => {
      preferenceListeners.add(listener);
      return () => preferenceListeners.delete(listener);
    },
  };
  return {
    version: 1,
    snapshot: () => current.snapshot(),
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    client: () => current.client(),
    ready: (signal) => current.ready(signal),
    workspaceUrl: (path) => current.workspaceUrl(path),
    profiles: () => main.profiles(),
    openSettings: () => main.openSettings(),
    signIn: () => current.signIn(),
    reauthenticate: () => (current.reauthenticate ? current.reauthenticate() : current.signIn()),
    cancelSignIn: () => current.cancelSignIn?.(),
    preferences,
    ...(main.announce && { announce: main.announce }),
    ...(main.forProfile && { forProfile: main.forProfile }),
    ...(main.addWorkspace && { addWorkspace: main.addWorkspace }),
    profile: chosen,
    setProfile: (profile) => main.preferences.set(key, profile || undefined),
  };
}
