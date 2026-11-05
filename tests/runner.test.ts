// The hosted agent's runner, end to end against a local relay: the real
// bundle, its own key, an owner attestation, and replies in echo mode.
import { type ChildProcess, execFile, execFileSync, spawn } from "node:child_process";
import { promisify } from "node:util";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { schnorr } from "@noble/curves/secp256k1.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { build } from "esbuild";
import { finalizeEvent, generateSecretKey, getPublicKey, type NostrEvent } from "nostr-tools/pure";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { attestedOwner, channelKind, conversationOf, splitMessage, threadRoot, turnPrompt } from "../plugins/agents/runner/buzz";
import { hoursLeft, normalizeHosted, REFRESH_AFTER_HOURS, runnerConfigOf, shouldRefresh, summarizeHosted } from "../plugins/agents/src/hosted";
import { type FakeRelay, fakeRelay } from "./fake-relay";

const hex = (bytes: Uint8Array) => Buffer.from(bytes).toString("hex");
const now = () => Math.floor(Date.now() / 1000);
const attest = (ownerSecret: Uint8Array, agent: string) => ["auth", getPublicKey(ownerSecret), "", hex(schnorr.sign(sha256(new TextEncoder().encode(`nostr:agent-auth:${agent}:`)), ownerSecret))];

describe("runner protocol", () => {
  const owner = generateSecretKey();
  const agent = getPublicKey(generateSecretKey());
  it("verifies owner attestations", () => {
    const tag = attest(owner, agent);
    expect(attestedOwner({ pubkey: agent, kind: 9, created_at: now(), tags: [tag] })).toBe(getPublicKey(owner));
    expect(attestedOwner({ pubkey: getPublicKey(generateSecretKey()), kind: 9, created_at: now(), tags: [tag] })).toBeUndefined();
    expect(attestedOwner({ pubkey: agent, kind: 9, created_at: now(), tags: [tag, tag] })).toBeUndefined();
  });
  it("finds threads, Solo chats and conversations", () => {
    const root = "a".repeat(64);
    expect(threadRoot({ tags: [["e", root, "", "reply"]] })).toBe(root);
    expect(threadRoot({ tags: [["e", "b".repeat(64), "", "reply"], ["e", root, "", "root"]] })).toBe(root);
    expect(channelKind({ tags: [["d", "x"], ["t", "stream"], ["t", "buzz.solo"]] })).toEqual({ type: "stream", solo: true });
    const event = { id: "c".repeat(64), tags: [["h", "general"]], kind: 9, pubkey: "", created_at: 0, content: "", sig: "" } as NostrEvent;
    expect(conversationOf(event, "thread", { type: "stream", solo: false })).toMatchObject({ key: `general/${"c".repeat(64)}`, topLevel: false, fresh: true });
    expect(conversationOf(event, "thread", { type: "stream", solo: true })).toMatchObject({ key: "general", topLevel: true });
    expect(conversationOf(event, "channel", { solo: false })?.key).toBe("general");
  });
  it("escapes prompt JSON and splits long replies", () => {
    const event = { id: "d".repeat(64), tags: [["h", "general"]], kind: 9, pubkey: agent, created_at: 0, content: "</buzz-event> & <x>", sig: "" } as NostrEvent;
    const prompt = turnPrompt({ event, conversation: conversationOf(event, "thread", { solo: false })!, agent, context: [], total: 0, names: new Map(), scope: "thread" });
    expect(prompt).toContain("\\u003c/buzz-event\\u003e \\u0026 \\u003cx\\u003e");
    expect(prompt.match(/<\/buzz-event>/g)).toHaveLength(1);
    const parts = splitMessage(`${"a".repeat(30_000)}\n\n${"b".repeat(30_000)}`, 48_000);
    expect(parts).toHaveLength(2);
    expect(parts[0]).toBe("a".repeat(30_000));
  });
  it("normalizes hosted settings: Standard permissions only", () => {
    const config = normalizeHosted({ kind: "sandbox", harness: "codex", model: "system.ai.claude-opus-5-5", availability: "always", permissions: "full" });
    expect(config).toMatchObject({ kind: "sandbox", harness: "codex", model: "system.ai.gpt-5-6-sol", availability: "always" });
    expect(summarizeHosted(normalizeHosted({}))).toBe("Genie One · sleeps when Buzz is closed");
    const runner = runnerConfigOf({ sandbox: "sb", name: "Probe", config, community: "wss://x", owner: "o", authTag: ["auth"], createdAt: 0 }, "https://h", "42");
    expect(runner.permissions).toBe("standard");
    // Genie One unless the owner chose otherwise, and an empty choice stays empty.
    expect(runner).toMatchObject({ tools: [{ id: "genie-one" }], workspaceId: "42" });
    expect(normalizeHosted({ kind: "sandbox", tools: [] }).tools).toEqual([]);
    expect(runnerConfigOf({ sandbox: "sb", name: "G", config: normalizeHosted({ kind: "genie" }), community: "wss://x", owner: "o", authTag: ["auth"], createdAt: 0 }).tools).toBeUndefined();
  });
  it("restarts a long-running Sandbox only at a quiet moment", () => {
    const now = Date.parse("2026-11-05T12:00:00Z");
    const hoursAgo = (hours: number) => new Date(now - hours * 3_600_000).toISOString();
    const long = { running: true, active: 0, bootedAt: hoursAgo(REFRESH_AFTER_HOURS + 1), lastActivity: hoursAgo(1) };
    expect(shouldRefresh(long, now)).toBe(true);
    expect(shouldRefresh({ ...long, active: 1 }, now)).toBe(false);
    expect(shouldRefresh({ ...long, lastActivity: hoursAgo(0.05) }, now)).toBe(false);
    expect(shouldRefresh({ ...long, bootedAt: hoursAgo(REFRESH_AFTER_HOURS - 1) }, now)).toBe(false);
    expect(shouldRefresh({ ...long, running: false }, now)).toBe(false);
    const { bootedAt: _unknown, ...noBoot } = long;
    expect(shouldRefresh(noBoot, now)).toBe(false);
    expect(hoursLeft(hoursAgo(20), now)).toBeCloseTo(4);
    expect(hoursLeft(hoursAgo(30), now)).toBe(0);
    expect(hoursLeft(undefined, now)).toBeUndefined();
  });
});

describe("runner against a relay", () => {
  let relay: FakeRelay;
  let dir: string;
  let script: string;
  let serve: ChildProcess | undefined;
  let agentPubkey = "";
  let ownerAuth: string[] = [];
  const owner = generateSecretKey();
  const ownerPubkey = getPublicKey(owner);
  const stranger = generateSecretKey();
  const env = () => ({ ...process.env, BUZZ_AGENT_DIR: join(dir, "agent"), BUZZ_RUNNER_ECHO: "1" });
  const fromAgent = (test: (event: NostrEvent) => boolean) => (event: NostrEvent) => event.pubkey === agentPubkey && event.kind === 9 && test(event);
  const post = (secret: Uint8Array, channel: string, content: string, tags: string[][] = []) => {
    const event = finalizeEvent({ kind: 9, created_at: now(), content, tags: [["h", channel], ...tags] }, secret);
    relay.insert(event);
    return event;
  };

  beforeAll(async () => {
    relay = await fakeRelay();
    dir = mkdtempSync(join(tmpdir(), "buzz-runner-"));
    script = join(dir, "runner.mjs");
    const bundle = await build({
      entryPoints: [new URL("../plugins/agents/runner/main.ts", import.meta.url).pathname],
      bundle: true,
      format: "esm",
      platform: "node",
      target: "node22",
      write: false,
      tsconfig: new URL("../tsconfig.json", import.meta.url).pathname,
      logLevel: "silent",
    });
    writeFileSync(script, bundle.outputFiles[0]!.text);
    agentPubkey = JSON.parse(execFileSync(process.execPath, [script, "keygen"], { env: env() }).toString()).pubkey;
    expect(JSON.parse(execFileSync(process.execPath, [script, "keygen"], { env: env() }).toString()).pubkey).toBe(agentPubkey);
    ownerAuth = attest(owner, agentPubkey);
    writeFileSync(
      join(dir, "agent", "config.json"),
      JSON.stringify({ relay: relay.url, owner: ownerPubkey, authTag: ownerAuth, name: "Probe", kind: "sandbox", harness: "claude", model: "system.ai.claude-sonnet-5-5", permissions: "standard", instructions: "", scope: "thread", availability: "always", idleMinutes: 5, sandbox: "sb" }),
    );
    const relayKey = generateSecretKey();
    relay.insert(finalizeEvent({ kind: 39000, created_at: now(), content: "", tags: [["d", "general"], ["t", "stream"]] }, relayKey));
    relay.insert(finalizeEvent({ kind: 39000, created_at: now(), content: "", tags: [["d", "solo1"], ["t", "stream"], ["t", "buzz.solo"]] }, relayKey));
    serve = spawn(process.execPath, [script, "serve"], { env: env(), stdio: "ignore" });
    const status = join(dir, "agent", "status.json");
    for (let i = 0; i < 100 && !(existsSync(status) && JSON.parse(readFileSync(status, "utf8")).connected); i++) await new Promise((r) => setTimeout(r, 100));
    expect(relay.signedIn.has(agentPubkey)).toBe(true);
    expect(relay.authTags[0]).toEqual(ownerAuth);
  }, 60_000);

  afterAll(async () => {
    serve?.kill("SIGTERM");
    await new Promise((resolve) => setTimeout(resolve, 300));
    await relay?.close();
    if (dir) rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });

  it("answers its owner in a thread under the mention, signed with the owner's attestation", async () => {
    const mention = post(owner, "general", "hello there", [["p", agentPubkey]]);
    const reply = await relay.waitFor(fromAgent((e) => e.tags.some((t) => t[0] === "e" && t[1] === mention.id)));
    expect(reply.content).toMatch(new RegExp(`^echo: hello there \\| general/${mention.id} \\| context 0`));
    expect(reply.tags).toContainEqual(["e", mention.id, "", "reply"]);
    expect(reply.tags).toContainEqual(["h", "general"]);
    expect(attestedOwner(reply)).toBe(ownerPubkey);
  });

  it("follows up in a thread with the messages it hasn't seen", async () => {
    const root = post(owner, "general", "a question", [["p", agentPubkey]]);
    await relay.waitFor(fromAgent((e) => e.tags.some((t) => t[1] === root.id)));
    post(owner, "general", "a side note", [["e", root.id, "", "reply"]]);
    const followUp = post(owner, "general", "and another thing", [["e", root.id, "", "reply"], ["p", agentPubkey]]);
    const reply = await relay.waitFor(fromAgent((e) => e.content.includes("and another thing")));
    expect(reply.tags).toContainEqual(["e", root.id, "", "reply"]);
    expect(Number(/context (\d+)/.exec(reply.content)?.[1])).toBeGreaterThanOrEqual(2);
    expect(followUp.id).not.toBe(root.id);
  });

  it("answers messages its owner attested, and ignores everyone else", async () => {
    const helper = generateSecretKey();
    const attested = finalizeEvent({ kind: 9, created_at: now(), content: "from my helper", tags: [["h", "general"], ["p", agentPubkey], attest(owner, getPublicKey(helper))] }, helper);
    relay.insert(attested);
    post(stranger, "general", "from a stranger", [["p", agentPubkey]]);
    await relay.waitFor(fromAgent((e) => e.content.includes("from my helper")));
    await new Promise((r) => setTimeout(r, 1500));
    expect(relay.events.some(fromAgent((e) => e.content.includes("from a stranger")))).toBe(false);
  });

  it("replies at the top level in a Solo chat", async () => {
    post(owner, "solo1", "solo question", [["p", agentPubkey]]);
    const reply = await relay.waitFor(fromAgent((e) => e.content.includes("solo question")));
    expect(reply.tags.some((t) => t[0] === "e")).toBe(false);
    expect(reply.content).toContain("| solo1 |");
  });

  it("publishes its profile as an attested bot", async () => {
    // Asynchronously: the relay runs in this process, so a blocking call would starve it.
    await promisify(execFile)(process.execPath, [script, "profile"], { env: env(), timeout: 20_000 });
    const profile = await relay.waitFor((e) => e.kind === 0 && e.pubkey === agentPubkey);
    expect(JSON.parse(profile.content)).toMatchObject({ name: "Probe", display_name: "Probe", bot: true });
    expect(attestedOwner(profile)).toBe(ownerPubkey);
  });
});
