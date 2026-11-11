// The one Databricks connection the suite shares. The core plugin owns it and
// provides it to the others as the `databricks` service (see service.ts).
//
// Startup, with no clicks: find the CLI, restore the saved profile (or use
// DEFAULT when it has a valid sign-in), check the token and read who the user
// is. Otherwise the Settings card offers one button: "Sign in with
// Databricks", which opens login.databricks.com to pick a workspace.
import type { Host } from "@buzz/author";
import {
  type CliProfile,
  CliMissingError,
  DatabricksCli,
  isWorkspaceProfile,
  normalizeHost,
  SignInRequiredError,
} from "./cli";
import { DatabricksClient } from "./client";
import { curlTransport, type Transport } from "./curl";
import { DesktopOnlyError } from "./process";

export type WorkspaceUser = Readonly<{
  id?: string;
  userName: string;
  displayName?: string;
}>;

export type ConnectionSnapshot =
  | Readonly<{ status: "checking" }>
  | Readonly<{ status: "unsupported"; message: string }>
  | Readonly<{ status: "cli-missing"; installing?: boolean; error?: string }>
  | Readonly<{ status: "signed-out"; profiles: readonly CliProfile[]; error?: string }>
  | Readonly<{ status: "signing-in"; profiles: readonly CliProfile[]; host?: string }>
  | Readonly<{ status: "connecting"; profile: CliProfile }>
  | Readonly<{
      status: "connected";
      profile: CliProfile;
      user: WorkspaceUser;
      workspaceId?: string;
      profiles: readonly CliProfile[];
    }>
  | Readonly<{
      status: "error";
      profile: CliProfile;
      profiles: readonly CliProfile[];
      message: string;
      needsSignIn: boolean;
    }>;

export type ConnectionStorage = Readonly<{
  get(key: string): string | null;
  set(key: string, value: string | null): void;
}>;

export const browserStorage: ConnectionStorage = {
  get: (key) => {
    try {
      return globalThis.localStorage?.getItem(key) ?? null;
    } catch {
      return null;
    }
  },
  set: (key, value) => {
    try {
      if (value === null) globalThis.localStorage?.removeItem(key);
      else globalThis.localStorage?.setItem(key, value);
    } catch {
      // Storage can be unavailable; the selection then lasts this session.
    }
  },
};

const SELECTION_KEY = "bkvarda.databricks.connection.v1";
/** Profile name for sign-ins this plugin starts. */
export const BUZZ_PROFILE = "buzz";

export class Connection {
  private state: ConnectionSnapshot = { status: "checking" };
  private listeners = new Set<() => void>();
  private profiles: readonly CliProfile[] = [];
  private current: { profile: CliProfile; client: DatabricksClient } | undefined;
  private login: AbortController | undefined;
  /** The profile this connection last tried, so it can sign in to it again. */
  private target: CliProfile | undefined;
  private generation = 0;
  readonly cli: DatabricksCli;
  readonly transport: Transport;

  constructor(
    private readonly host: Host,
    private readonly storage: ConnectionStorage = browserStorage,
    transport?: Transport,
  ) {
    this.cli = new DatabricksCli(host);
    this.transport = transport ?? curlTransport(host);
  }

  snapshot = (): ConnectionSnapshot => this.state;

  /** The profile this connection uses, or last tried while it signs in again. */
  profileName(): string | undefined {
    return this.target?.name;
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  /** The client for the connected workspace, or undefined. */
  client(): DatabricksClient | undefined {
    return this.state.status === "connected" ? this.current?.client : undefined;
  }

  /** Resolves with a client once connected; rejects if it cannot connect. */
  async ready(signal?: AbortSignal, timeoutMs = 20_000): Promise<DatabricksClient> {
    const settled = () => {
      const s = this.state.status;
      return s !== "checking" && s !== "connecting";
    };
    if (!settled())
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => {
          stop();
          resolve();
        }, timeoutMs);
        const stop = this.subscribe(() => {
          if (!settled()) return;
          clearTimeout(timer);
          stop();
          resolve();
        });
        signal?.addEventListener("abort", () => {
          clearTimeout(timer);
          stop();
          reject(signal.reason);
        });
      });
    const client = this.client();
    if (client) return client;
    throw new NotConnectedError(this.state);
  }

  async start(): Promise<void> {
    const generation = ++this.generation;
    this.set({ status: "checking" });
    if (!this.host.spawn) {
      this.set({ status: "unsupported", message: "Databricks plugins need the Buzz desktop app." });
      return;
    }
    try {
      const version = await this.cli.version();
      if (generation !== this.generation) return;
      if (!version) {
        this.set({ status: "cli-missing" });
        return;
      }
      await this.reloadProfiles();
      if (generation !== this.generation) return;
      const saved = this.savedProfile();
      const candidate =
        (saved && this.profiles.find((profile) => profile.name === saved)) ??
        (saved ? undefined : this.profiles.find((profile) => profile.name === "DEFAULT"));
      if (candidate && isWorkspaceProfile(candidate)) {
        await this.connect(candidate, { silent: !saved });
        return;
      }
      this.set({ status: "signed-out", profiles: this.workspaceProfiles() });
    } catch (error) {
      if (generation !== this.generation) return;
      if (error instanceof CliMissingError) this.set({ status: "cli-missing" });
      else if (error instanceof DesktopOnlyError)
        this.set({ status: "unsupported", message: error.message });
      else this.set({ status: "signed-out", profiles: this.workspaceProfiles(), error: String((error as Error).message ?? error) });
    }
  }

  /** Uses an existing CLI profile. */
  async useProfile(name: string): Promise<void> {
    await this.reloadProfiles();
    const profile = this.profiles.find((candidate) => candidate.name === name);
    if (!profile) throw new Error(`No profile named ${name}`);
    await this.connect(profile, { silent: false });
  }

  /**
   * Browser sign-in. With a host, signs in to that workspace; without one,
   * login.databricks.com lets the person pick a workspace.
   */
  async signIn(options: Readonly<{ host?: string; profile?: string }> = {}): Promise<void> {
    this.login?.abort();
    const controller = new AbortController();
    this.login = controller;
    const before = this.state;
    const host = options.host ? normalizeHost(options.host) : undefined;
    const name =
      options.profile ??
      (host
        ? (this.profiles.find((profile) => profile.host === host)?.name ?? this.freshProfileName(host))
        : this.freshProfileName());
    this.set({ status: "signing-in", profiles: this.workspaceProfiles(), ...(host && { host }) });
    try {
      await this.cli.login({ profile: name, ...(host && { host }) }, controller.signal);
      await this.reloadProfiles();
      const profile = this.profiles.find((candidate) => candidate.name === name);
      if (!profile) throw new Error("Sign-in finished, but no profile was saved.");
      await this.connect(profile, { silent: false });
    } catch (error) {
      if (controller.signal.aborted) {
        // A cancelled "Sign in again" goes back to the message that asked for it.
        this.set(before.status === "error" ? before : { status: "signed-out", profiles: this.workspaceProfiles() });
        return;
      }
      this.set({
        status: "signed-out",
        profiles: this.workspaceProfiles(),
        error: (error as Error).message ?? String(error),
      });
    } finally {
      if (this.login === controller) this.login = undefined;
    }
  }

  /** Rereads CLI profiles (for example after another connection added one). */
  async refreshProfiles(): Promise<void> {
    await this.reloadProfiles();
    const state = this.state;
    if ("profiles" in state) this.set({ ...state, profiles: this.workspaceProfiles() });
  }

  cancelSignIn(): void {
    this.login?.abort();
  }

  /** Signs in again to the current (or last tried) profile's workspace. */
  async reauthenticate(): Promise<void> {
    const profile = "profile" in this.state ? this.state.profile : this.target;
    if (!profile) return this.signIn();
    return this.signIn({ host: profile.host, profile: profile.name });
  }

  /** Forgets the selection on this device. The CLI keeps its sign-in. */
  disconnect(): void {
    this.generation++;
    this.storage.set(SELECTION_KEY, null);
    this.current = undefined;
    this.set({ status: "signed-out", profiles: this.workspaceProfiles() });
  }

  async installCli(): Promise<void> {
    this.set({ status: "cli-missing", installing: true });
    try {
      await this.cli.install();
      await this.start();
    } catch (error) {
      this.set({ status: "cli-missing", error: (error as Error).message ?? String(error) });
    }
  }

  /** A Databricks web URL in the connected workspace. */
  workspaceUrl(path: string): string | undefined {
    if (this.state.status !== "connected") return undefined;
    const url = new URL(path, this.state.profile.host);
    const workspaceId = this.state.workspaceId ?? this.state.profile.workspaceId;
    if (workspaceId && !url.searchParams.has("o")) url.searchParams.set("o", workspaceId);
    return url.toString();
  }

  private async connect(profile: CliProfile, options: Readonly<{ silent: boolean }>): Promise<void> {
    const generation = ++this.generation;
    this.target = profile;
    this.set({ status: "connecting", profile });
    // A sign-in that expires while connected shows as expired, so Settings and
    // the agents offer "Sign in again" rather than failing each request.
    const token = async (tokenOptions?: Readonly<{ force?: boolean }>) => {
      try {
        return (await this.cli.token({ profile: profile.name }, tokenOptions)).accessToken;
      } catch (error) {
        if (error instanceof SignInRequiredError && generation === this.generation && this.state.status === "connected")
          this.expire(profile);
        throw error;
      }
    };
    const client = new DatabricksClient({
      host: profile.host,
      ...(profile.workspaceId && { workspaceId: profile.workspaceId }),
      transport: this.transport,
      token,
    });
    try {
      const response = await client.request("/api/2.0/preview/scim/v2/Me", {
        query: { attributes: "id,userName,displayName" },
        timeoutMs: 30_000,
      });
      if (generation !== this.generation) return;
      if (response.status === 401 || response.status === 403)
        throw new SignInRequiredError("Your Databricks sign-in has expired.");
      if (response.status < 200 || response.status >= 300)
        throw new Error(`Databricks returned HTTP ${response.status}`);
      const me = JSON.parse(response.body) as { id?: string; userName?: string; displayName?: string };
      const workspaceId = response.headers["x-databricks-org-id"] ?? profile.workspaceId;
      // A profile can keep the ID of a workspace that was deleted and recreated
      // at the same URL; trust the server's answer for routing headers.
      const routed =
        workspaceId && workspaceId !== profile.workspaceId
          ? new DatabricksClient({
              host: profile.host,
              workspaceId,
              transport: this.transport,
              token,
            })
          : client;
      this.current = { profile, client: routed };
      this.storage.set(SELECTION_KEY, JSON.stringify({ profile: profile.name }));
      this.set({
        status: "connected",
        profile,
        user: {
          userName: me.userName ?? "unknown",
          ...(me.id && { id: me.id }),
          ...(me.displayName && { displayName: me.displayName }),
        },
        ...(workspaceId && { workspaceId }),
        profiles: this.workspaceProfiles(),
      });
    } catch (error) {
      if (generation !== this.generation) return;
      const needsSignIn = error instanceof SignInRequiredError;
      if (options.silent) {
        // A stale DEFAULT profile should not greet people with an error.
        this.set({ status: "signed-out", profiles: this.workspaceProfiles() });
        return;
      }
      this.set({
        status: "error",
        profile,
        profiles: this.workspaceProfiles(),
        message: needsSignIn ? "Your Databricks sign-in has expired." : ((error as Error).message ?? String(error)),
        needsSignIn,
      });
    }
  }

  private expire(profile: CliProfile) {
    this.current = undefined;
    this.set({
      status: "error",
      profile,
      profiles: this.workspaceProfiles(),
      message: "Your Databricks sign-in has expired.",
      needsSignIn: true,
    });
  }

  private async reloadProfiles() {
    this.profiles = await this.cli.profiles();
  }

  private workspaceProfiles() {
    return this.profiles.filter(isWorkspaceProfile);
  }

  private savedProfile(): string | undefined {
    try {
      const saved = JSON.parse(this.storage.get(SELECTION_KEY) ?? "null") as { profile?: unknown } | null;
      return typeof saved?.profile === "string" ? saved.profile : undefined;
    } catch {
      return undefined;
    }
  }

  private freshProfileName(host?: string) {
    const base = host
      ? `${BUZZ_PROFILE}-${new URL(host).hostname.split(".")[0]?.replace(/[^a-z0-9-]/gi, "-").toLowerCase()}`
      : BUZZ_PROFILE;
    const taken = new Set(this.profiles.map((profile) => profile.name));
    if (!taken.has(base)) return base;
    for (let n = 2; ; n++) if (!taken.has(`${base}-${n}`)) return `${base}-${n}`;
  }

  private set(state: ConnectionSnapshot) {
    this.state = state;
    for (const listener of [...this.listeners]) listener();
  }
}

export class NotConnectedError extends Error {
  constructor(readonly snapshot: ConnectionSnapshot) {
    super(
      snapshot.status === "cli-missing"
        ? "Databricks isn't set up yet: install the Databricks CLI in Settings → Databricks."
        : snapshot.status === "error" && snapshot.needsSignIn
          ? "The Databricks sign-in expired. Sign in again in Settings → Databricks."
          : "Not connected to Databricks. Connect in Settings → Databricks.",
    );
    this.name = "NotConnectedError";
  }
}
