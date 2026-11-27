// Hosted agents: when Buzz's background look after an agent (tendAgents →
// wake) fails, the agent's status says so, an expired Databricks sign-in most
// of all, since Buzz then stops restarting it; a wake that works clears it.
import * as ReactModule from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { bindReact } from "@dbx/core/react";
import type { ConnectionSnapshot } from "@dbx/core/connection";
import type { DatabricksService } from "@dbx/core/service";

// A Sandbox that's up, with this build's runner (tests/stubs: RUNNER_SHA "test") running and connected.
const sandbox = vi.hoisted(() => ({ failStart: false, calls: [] as string[] }));
vi.mock("@dbx/core/api/sandbox", () => ({
  SANDBOX_HOME: "/home/sandbox-agent",
  Sandboxes: class {
    async get() {
      return { status: { state: "SANDBOX_STATE_RUNNING" } };
    }
    async ensureRunning() {
      return { status: { state: "SANDBOX_STATE_RUNNING" } };
    }
    async bash(_id: string, command: string) {
      sandbox.calls.push(command);
      if (command.startsWith("cat ")) return { exit_code: 0, stdout: "test\n" };
      if (command.includes(" status")) return sandbox.failStart ? { exit_code: 1, stderr: "Failed to verify Slack tool" } : { exit_code: 0, stdout: JSON.stringify({ running: true, connected: true }) };
      return { exit_code: 0, stdout: "" };
    }
    async writeFile() {}
    async stop() {}
  },
}));

// The conversations picker reads the live connection; this test is about the status above it.
vi.mock("../plugins/agents/src/slack-ui", () => ({ SlackConversationsField: () => null }));

const { HostedSettings, hostedProvider, normalizeHosted, tendAgents } = await import("../plugins/agents/src/hosted");

bindReact(ReactModule as never);

const PUBKEY = "a".repeat(64);
const profile = { name: "gtm-ai-agent", host: "https://w.example" };

/** A workspace connection whose sign-in can expire, as connection.ts reports it. */
function fakeConnection() {
  const state = { signedIn: false, profiles: [] as string[] };
  const expiredMessage = "Your sign-in to w.example has expired. Sign in again where this workspace is chosen (Settings → Databricks, or an agent's Workspace field).";
  const client = { host: profile.host, json: async () => ({}), post: async () => ({}) };
  const service = {
    version: 1,
    snapshot: (): ConnectionSnapshot =>
      state.signedIn
        ? { status: "connected", profile, user: { userName: "owner@example.com" }, profiles: [] }
        : { status: "error", profile, profiles: [], message: "Your Databricks sign-in has expired.", needsSignIn: true },
    subscribe: () => () => {},
    client: () => (state.signedIn ? client : undefined),
    async ready() {
      // NotConnectedError, structurally: each plugin bundles its own copy of the class.
      if (!state.signedIn) throw Object.assign(new Error(expiredMessage), { name: "NotConnectedError" });
      return client;
    },
    workspaceUrl: () => undefined,
    profiles: () => [],
    openSettings() {},
    async signIn() {},
    async reauthenticate() {},
    preferences: { get: () => undefined, set() {}, subscribe: () => () => {} },
    forProfile(name: string) {
      state.profiles.push(name);
      return service;
    },
  } as unknown as DatabricksService;
  return { state, service };
}

function setup() {
  const store = new Map<string, string>();
  const storage = {
    get: (key: string) => store.get(key) ?? null,
    async set(key: string, value: string | null) {
      if (value === null) store.delete(key);
      else store.set(key, value);
    },
    keys: () => [...store.keys()],
  };
  // A Slack bridge on its own CLI profile, as Brandon's is.
  const record = {
    pubkey: PUBKEY,
    sandbox: "buzz-hosted-test",
    name: "Slack bridge",
    config: normalizeHosted({ kind: "slack", profile: profile.name }),
    community: "wss://relay.example",
    owner: "b".repeat(64),
    authTag: ["auth", "b".repeat(64), "", "sig"],
    createdAt: 0,
  };
  store.set(`bkvarda.databricks-hosted.v1:${PUBKEY}`, JSON.stringify(record));
  const connection = fakeConnection();
  const provider = hostedProvider({ storage } as never, connection.service);
  return { provider, connection };
}

const settingsText = (provider: ReturnType<typeof hostedProvider>, service: DatabricksService) =>
  renderToStaticMarkup(ReactModule.createElement(HostedSettings, { service, provider, pubkey: PUBKEY })).replace(/<[^>]+>/g, " ").replace(/&#x27;/g, "'");

describe("a hosted agent's background wake", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    sandbox.failStart = false;
    sandbox.calls.length = 0;
  });
  afterEach(() => vi.useRealTimers());

  it("shows an expired sign-in after a failed wake, and clears it after one that works", async () => {
    const { provider, connection } = setup();
    const seen = vi.fn();
    provider.subscribe(seen);
    const stop = tendAgents(provider);
    expect(provider.problem(PUBKEY)).toBeUndefined();

    // The first look, 30 s in: the sign-in has expired, so nothing reaches the Sandbox.
    await vi.advanceTimersByTimeAsync(30_000);
    const problem = provider.problem(PUBKEY);
    expect(problem).toMatchObject({ needsSignIn: true });
    expect(problem!.message).toContain("has expired");
    expect(sandbox.calls).toEqual([]);
    expect(connection.state.profiles).toContain("gtm-ai-agent");
    expect(seen).toHaveBeenCalledTimes(1);

    // The Settings tab and the summary say automatic recovery is paused, with Sign in again.
    const text = settingsText(provider, connection.service);
    expect(text).toContain("Sign in again so Buzz can look after this agent");
    expect(text).toContain("paused its automatic recovery");
    expect(text).toContain("(gtm-ai-agent)");
    expect(text).toContain("Sign in again");

    // Still expired four minutes later: the same problem, from when it began.
    await vi.advanceTimersByTimeAsync(4 * 60_000);
    expect(provider.problem(PUBKEY)?.since).toBe(problem!.since);
    expect(provider.problem(PUBKEY)!.at).toBeGreaterThan(problem!.at);

    // The owner signs in again; the next look works and the problem clears.
    connection.state.signedIn = true;
    await vi.advanceTimersByTimeAsync(4 * 60_000);
    expect(provider.problem(PUBKEY)).toBeUndefined();
    expect(sandbox.calls.some((command) => command.includes(" status"))).toBe(true);
    expect(settingsText(provider, connection.service)).not.toContain("Buzz can look after this agent");
    stop();
  });

  it("shows another failure without asking for a sign-in", async () => {
    const { provider, connection } = setup();
    connection.state.signedIn = true;
    sandbox.failStart = true;
    await expect(provider.wake(PUBKEY)).rejects.toThrow("Failed to verify Slack tool");
    expect(provider.problem(PUBKEY)).toMatchObject({ needsSignIn: false });
    const text = settingsText(provider, connection.service);
    expect(text).toContain("Buzz couldn't look after this agent");
    expect(text).toContain("Failed to verify Slack tool");
    expect(text).not.toContain("Sign in again");

    sandbox.failStart = false;
    await expect(provider.wake(PUBKEY)).resolves.toMatchObject({ running: true, connected: true });
    expect(provider.problem(PUBKEY)).toBeUndefined();
  });

  it("keeps nothing from a wake that was called off", async () => {
    const { provider } = setup();
    const controller = new AbortController();
    controller.abort();
    await expect(provider.wake(PUBKEY, { signal: controller.signal })).rejects.toThrow();
    expect(provider.problem(PUBKEY)).toBeUndefined();
  });
});
