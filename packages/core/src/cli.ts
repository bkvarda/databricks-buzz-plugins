// Sign-in through the Databricks CLI: browser OAuth (U2M) with refresh tokens
// in ~/.databricks/token-cache.json, shared with every other Databricks tool on
// the machine. People who already ran `databricks auth login` are signed in
// with zero clicks; everyone else gets one browser sign-in.
//
// The manifest declares each subcommand separately, so the access review
// shows exactly what can run (`databricks auth token`, not "any databricks").
import type { Host } from "@buzz/author";
import { ProcessError, runProcess } from "./process";

export const CLI_PROCESSES = {
  version: "cli-version",
  profiles: "cli-profiles",
  token: "cli-token",
  login: "cli-login",
  install: "cli-install",
} as const;

export type CliProfile = Readonly<{
  name: string;
  host: string;
  authType?: string;
  workspaceId?: string;
  accountId?: string;
  cloud?: string;
}>;

export type AccessToken = Readonly<{
  accessToken: string;
  /** Unix milliseconds. */
  expiresAt: number;
}>;

export type CliTarget = Readonly<{ profile: string }>;

export class CliMissingError extends Error {
  constructor() {
    super("The Databricks CLI is not installed.");
    this.name = "CliMissingError";
  }
}

export class SignInRequiredError extends Error {
  constructor(message = "Sign in to Databricks again.") {
    super(message);
    this.name = "SignInRequiredError";
  }
}

/** Refresh this long before the token says it expires. */
const EXPIRY_MARGIN_MS = 3 * 60_000;
const DEFAULT_LIFETIME_MS = 30 * 60_000;

const missingProgram = (error: unknown) =>
  /no such file|not found|cannot find|os error 2|enoent/i.test(String(error));

function signInNeeded(stderr: string) {
  return /refresh token|invalid_grant|re-?auth|auth login|no token|cache|expired|not found in cache|cannot find/i.test(
    stderr,
  );
}

export function parseProfiles(stdout: string): CliProfile[] {
  const parsed = JSON.parse(stdout) as {
    profiles?: readonly Record<string, unknown>[];
  };
  return (parsed.profiles ?? []).flatMap((raw) => {
    const name = typeof raw.name === "string" ? raw.name : undefined;
    const host = typeof raw.host === "string" ? raw.host : undefined;
    if (!name || !host) return [];
    const text = (key: string) =>
      typeof raw[key] === "string" && raw[key] ? (raw[key] as string) : undefined;
    const profile: Record<string, string> = { name, host: normalizeHost(host) };
    const authType = text("auth_type");
    const workspaceId = text("workspace_id");
    const accountId = text("account_id");
    const cloud = text("cloud");
    if (authType) profile.authType = authType;
    if (workspaceId) profile.workspaceId = workspaceId;
    if (accountId) profile.accountId = accountId;
    if (cloud) profile.cloud = cloud;
    return [profile as CliProfile];
  });
}

export function parseToken(stdout: string, now = Date.now()): AccessToken {
  const parsed = JSON.parse(stdout) as {
    access_token?: unknown;
    expiry?: unknown;
    expires_in?: unknown;
  };
  if (typeof parsed.access_token !== "string" || !parsed.access_token)
    throw new Error("The Databricks CLI returned no access token.");
  const expiry =
    typeof parsed.expiry === "string" ? Date.parse(parsed.expiry) : Number.NaN;
  const expiresAt = Number.isFinite(expiry)
    ? expiry
    : typeof parsed.expires_in === "number"
      ? now + parsed.expires_in * 1000
      : now + DEFAULT_LIFETIME_MS;
  return { accessToken: parsed.access_token, expiresAt };
}

export function normalizeHost(host: string): string {
  const trimmed = host.trim().replace(/\/+$/, "");
  const withScheme = /^https?:\/\//i.test(trimmed)
    ? trimmed
    : `https://${trimmed}`;
  const url = new URL(withScheme);
  return `https://${url.host.toLowerCase()}`;
}

/** Profile accounts.* hosts are account-level and cannot call workspace APIs. */
export const isWorkspaceProfile = (profile: CliProfile) =>
  !/^https:\/\/accounts(\.[a-z-]+)?\.(cloud\.)?databricks\.(com|net)|^https:\/\/accounts\.azuredatabricks\.net/i.test(
    profile.host,
  );

export class DatabricksCli {
  private tokens = new Map<string, AccessToken>();
  private pending = new Map<string, Promise<AccessToken>>();

  constructor(private readonly host: Host) {}

  /** The installed CLI version, or undefined when it is not installed. */
  async version(): Promise<string | undefined> {
    try {
      const result = await runProcess(this.host, CLI_PROCESSES.version, {
        timeoutMs: 15_000,
      });
      if (result.code !== 0) return undefined;
      return /v?(\d+\.\d+\.\d+)/.exec(result.stdout)?.[1] ?? result.stdout.trim();
    } catch (error) {
      if (missingProgram(error)) return undefined;
      throw error;
    }
  }

  async profiles(): Promise<CliProfile[]> {
    const result = await this.run(CLI_PROCESSES.profiles, [], 20_000);
    if (result.code !== 0)
      throw new Error(result.stderr.trim() || "Could not read profiles.");
    return parseProfiles(result.stdout || '{"profiles":[]}');
  }

  /** A current access token; refreshes it through the CLI when needed. */
  token(
    target: CliTarget,
    options: Readonly<{ force?: boolean }> = {},
  ): Promise<AccessToken> {
    const key = target.profile;
    const cached = this.tokens.get(key);
    if (
      !options.force &&
      cached &&
      cached.expiresAt - EXPIRY_MARGIN_MS > Date.now()
    )
      return Promise.resolve(cached);
    const inFlight = this.pending.get(key);
    if (inFlight && !options.force) return inFlight;
    const request = (async () => {
      const args = ["--profile", target.profile];
      if (options.force) args.push("--force-refresh");
      const result = await this.run(CLI_PROCESSES.token, args, 60_000);
      if (result.code !== 0) {
        this.tokens.delete(key);
        const message = result.stderr.trim();
        if (signInNeeded(message)) throw new SignInRequiredError();
        throw new Error(message || "Could not get a Databricks token.");
      }
      const token = parseToken(result.stdout);
      this.tokens.set(key, token);
      return token;
    })().finally(() => this.pending.delete(key));
    this.pending.set(key, request);
    return request;
  }

  forget(target: CliTarget): void {
    this.tokens.delete(target.profile);
  }

  /**
   * Browser sign-in. Without a host, the CLI opens login.databricks.com,
   * where the person signs in and picks their workspace; the profile then
   * records it. Resolves once the browser flow finishes.
   */
  async login(
    target: Readonly<{ profile: string; host?: string; scopes?: string }>,
    signal?: AbortSignal,
  ): Promise<void> {
    const args = ["--profile", target.profile];
    if (target.host) args.push("--host", normalizeHost(target.host));
    if (target.scopes) args.push("--scopes", target.scopes);
    const result = await this.run(CLI_PROCESSES.login, args, 15 * 60_000, signal);
    this.tokens.delete(target.profile);
    if (result.code !== 0) {
      throw new Error(
        result.stderr.trim().split("\n").pop() || "Sign-in did not finish.",
      );
    }
  }

  /** Installs the CLI into ~/.local/bin after verifying its checksum. */
  async install(signal?: AbortSignal): Promise<string> {
    const result = await runProcess(this.host, CLI_PROCESSES.install, {
      timeoutMs: 5 * 60_000,
      ...(signal && { signal }),
    });
    if (result.code !== 0)
      throw new ProcessError(
        result.stderr.trim() || "Installing the Databricks CLI failed.",
        result.code,
        result.stdout,
        result.stderr,
      );
    return result.stdout.trim();
  }

  private async run(
    id: string,
    args: readonly string[],
    timeoutMs: number,
    signal?: AbortSignal,
  ) {
    try {
      return await runProcess(this.host, id, {
        args,
        timeoutMs,
        ...(signal && { signal }),
        // Never let the CLI open an interactive prompt or a pager.
        env: { DATABRICKS_CLI_PAGER: null, PAGER: "cat" },
      });
    } catch (error) {
      if (missingProgram(error)) throw new CliMissingError();
      throw error;
    }
  }
}
