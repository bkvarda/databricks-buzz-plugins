// Databricks App identities: the plugin's provider against a fake workspace
// (the app, its service principal, the Unity Catalog secret and its grants,
// the code folder and deployment), and the app library end to end, as a real
// Node process, against a fake relay and a fake Databricks.
import { type ChildProcess, spawn } from "node:child_process";
import { copyFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { schnorr } from "@noble/curves/secp256k1.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { build } from "esbuild";
import { finalizeEvent, generateSecretKey, getPublicKey, type NostrEvent } from "nostr-tools/pure";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DatabricksClient } from "@dbx/core/client";
import { activated, appYaml, identitySecretName, parseIdentity } from "../plugins/agents/src/app-identity";
import { appConfigProblem, appProvider, normalizeAppConfig, summarizeApp } from "../plugins/agents/src/app-type";
import { NOT_ALLOWED_TEXT } from "../plugins/agents/app/sdk";
import { type FakeRelay, fakeRelay } from "./fake-relay";
import { fakeService } from "./fake-workspace";

const hex = (bytes: Uint8Array) => Buffer.from(bytes).toString("hex");
const now = () => Math.floor(Date.now() / 1000);
const attest = (ownerSecret: Uint8Array, agent: string) => ["auth", getPublicKey(ownerSecret), "", hex(schnorr.sign(sha256(new TextEncoder().encode(`nostr:agent-auth:${agent}:`)), ownerSecret))];

/** An in-memory workspace: apps, Unity Catalog schemas, secrets and grants, and workspace files. */
function workspace() {
  const apps = new Map<string, Record<string, any>>();
  const schemas = new Set<string>();
  const secrets = new Map<string, string>();
  const grants: { securable: string; name: string; principal: string; privileges: string[] }[] = [];
  const files = new Map<string, string>();
  const calls: string[] = [];
  const json = (status: number, body: unknown) => ({ status, headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const missing = () => json(404, { error_code: "RESOURCE_DOES_NOT_EXIST", message: "not found" });
  const client = new DatabricksClient({
    host: "https://w.example",
    token: async () => "t",
    transport: async (request) => {
      const url = new URL(request.url);
      const path = decodeURIComponent(url.pathname);
      const method = request.method ?? "GET";
      const body = request.body ? JSON.parse(request.body) : undefined;
      calls.push(`${method} ${path}`);
      if (url.host === "app.example") return json(200, { state: "connected", connected: true, answered: 2 });
      let match: RegExpExecArray | null;
      if ((match = /^\/api\/2\.0\/apps\/([^/]+)$/.exec(path))) {
        const app = apps.get(match[1]!);
        if (method === "DELETE") return app ? (apps.delete(match[1]!), json(200, {})) : missing();
        return app ? json(200, app) : missing();
      }
      if (path === "/api/2.0/apps" && method === "GET") return json(200, { apps: [...apps.values()] });
      if (path === "/api/2.0/apps" && method === "POST") {
        const app = { name: body.name, description: body.description, service_principal_client_id: `sp-${body.name}`, service_principal_name: `app-${body.name}`, compute_status: { state: "ACTIVE" }, url: "https://app.example" };
        apps.set(body.name, app);
        return json(200, app);
      }
      if ((match = /^\/api\/2\.0\/apps\/([^/]+)\/deployments\/([^/]+)$/.exec(path))) {
        const app = apps.get(match[1]!)!;
        const deployment = { ...app.pending_deployment, status: { state: "SUCCEEDED" } };
        Object.assign(app, { active_deployment: deployment, pending_deployment: undefined, app_status: { state: "RUNNING" } });
        return json(200, deployment);
      }
      if ((match = /^\/api\/2\.0\/apps\/([^/]+)\/deployments$/.exec(path))) {
        const deployment = { deployment_id: "d1", source_code_path: body.source_code_path, status: { state: "IN_PROGRESS" } };
        apps.get(match[1]!)!.pending_deployment = deployment;
        return json(200, deployment);
      }
      if ((match = /^\/api\/2\.1\/unity-catalog\/schemas\/(.+)$/.exec(path))) return schemas.has(match[1]!) ? json(200, { full_name: match[1] }) : missing();
      if (path === "/api/2.1/unity-catalog/schemas") return schemas.add(`${body.catalog_name}.${body.name}`), json(200, {});
      if (path === "/api/2.1/unity-catalog/secrets") return secrets.set(`${body.catalog_name}.${body.schema_name}.${body.name}`, body.value), json(200, {});
      if ((match = /^\/api\/2\.1\/unity-catalog\/secrets\/(.+)$/.exec(path))) {
        const name = match[1]!;
        if (method === "PATCH") return secrets.has(name) ? (secrets.set(name, body.value), json(200, {})) : missing();
        if (method === "DELETE") return secrets.delete(name) ? json(200, {}) : missing();
        return secrets.has(name) ? json(200, { full_name: name, effective_value: secrets.get(name) }) : missing();
      }
      if ((match = /^\/api\/2\.1\/unity-catalog\/permissions\/([^/]+)\/(.+)$/.exec(path))) {
        for (const change of body.changes) grants.push({ securable: match[1]!, name: match[2]!, principal: change.principal, privileges: change.add });
        return json(200, {});
      }
      if (path === "/api/2.0/workspace/mkdirs") return json(200, {});
      if (path === "/api/2.0/workspace/get-status") return files.has(url.searchParams.get("path")!) ? json(200, {}) : missing();
      if (path === "/api/2.0/workspace/import") return files.set(body.path, Buffer.from(body.content, "base64").toString("utf8")), json(200, {});
      return missing();
    },
  });
  return { client, apps, schemas, secrets, grants, files, calls };
}

function storage() {
  const values = new Map<string, string>();
  return {
    get: (key: string) => values.get(key) ?? null,
    set: async (key: string, value: string | null) => void (value === null ? values.delete(key) : values.set(key, value)),
    keys: () => [...values.keys()],
  };
}

describe("Databricks App settings", () => {
  it("checks what the Create form needs", () => {
    expect(appConfigProblem(normalizeAppConfig({}))).toBe("Name the app.");
    expect(appConfigProblem(normalizeAppConfig({ app: "Bad_Name", schema: "main.buzz_apps" }))).toMatch(/lowercase/);
    expect(appConfigProblem(normalizeAppConfig({ app: "ok-app", schema: "main" }))).toMatch(/catalog and a schema/);
    expect(appConfigProblem(normalizeAppConfig({ app: "ok-app", schema: "main.buzz_apps" }))).toBeUndefined();
    expect(summarizeApp(normalizeAppConfig({ app: "ok-app", mode: "own", answers: "owner" }))).toBe("ok-app · your app · answers only you");
    expect(identitySecretName("main.buzz_apps", "my-bot")).toBe("main.buzz_apps.buzz_my_bot");
    expect(appYaml({ secret: "main.buzz_apps.buzz_my_bot" })).toContain('value: "main.buzz_apps.buzz_my_bot"');
    expect(parseIdentity('{"v":1,"key":"nothex"}')).toBeUndefined();
  });
});

describe("Databricks App provider", () => {
  const config = { mode: "starter", app: "buzz-starter", schema: "main.buzz_apps", answers: "everyone" };
  const owner = generateSecretKey();

  it("makes the app, keeps its key in a secret only its service principal reads, deploys it, and cleans up", async () => {
    const fake = workspace();
    const provider = appProvider({ storage: storage() } as never, fakeService(fake.client).service);
    const { pubkey } = await provider.provision({ name: "Starter", community: "wss://c.example", config, signal: new AbortController().signal });
    const secret = "main.buzz_apps.buzz_buzz_starter";
    // The key is made here and kept by Unity Catalog; Buzz gets only the pubkey.
    const identity = parseIdentity(fake.secrets.get(secret));
    expect(identity && getPublicKey(Buffer.from(identity.key, "hex"))).toBe(pubkey);
    expect(activated(identity)).toBe(false);
    expect(fake.schemas.has("main.buzz_apps")).toBe(true);
    expect(fake.grants).toEqual([
      { securable: "catalog", name: "main", principal: "sp-buzz-starter", privileges: ["USE_CATALOG"] },
      { securable: "schema", name: "main.buzz_apps", principal: "sp-buzz-starter", privileges: ["USE_SCHEMA"] },
      { securable: "secret", name: secret, principal: "sp-buzz-starter", privileges: ["READ_SECRET"] },
    ]);
    const folder = "/Workspace/Users/me@example.com/buzz-apps/buzz-starter";
    expect([...fake.files.keys()].sort()).toEqual([`${folder}/app.mjs`, `${folder}/app.yaml`, `${folder}/buzz-app.mjs`]);
    expect(fake.files.get(`${folder}/app.yaml`)).toContain(`value: "${secret}"`);
    expect(fake.calls).not.toContain("POST /api/2.0/apps/buzz-starter/deployments");

    // Activation adds the owner's attestation and the community, then deploys the folder.
    const auth = attest(owner, pubkey);
    await provider.activate({ pubkey, name: "Starter", community: "wss://c.example", auth, config, signal: new AbortController().signal });
    expect(parseIdentity(fake.secrets.get(secret))).toMatchObject({ relay: "wss://c.example", owner: getPublicKey(owner), auth, name: "Starter", answers: "everyone" });
    expect(fake.apps.get("buzz-starter")?.active_deployment?.source_code_path).toBe(folder);
    const status = await provider.status(pubkey);
    expect(status.live).toMatchObject({ state: "connected", answered: 2 });

    // A new name reaches the app through the secret; so does who it answers.
    await provider.profile({ pubkey, community: "wss://c.example", name: "Renamed", signal: new AbortController().signal });
    await provider.setAnswers(pubkey, "owner");
    expect(parseIdentity(fake.secrets.get(secret))).toMatchObject({ name: "Renamed", answers: "owner", key: identity!.key });

    await provider.remove({ pubkey, signal: new AbortController().signal });
    expect(fake.secrets.has(secret)).toBe(false);
    expect(fake.apps.has("buzz-starter")).toBe(false);
  });

  it("keeps its key when Buzz asks again after a failure, and won't take over an app with an identity", async () => {
    const fake = workspace();
    const store = storage();
    const provider = appProvider({ storage: store } as never, fakeService(fake.client).service);
    const signal = new AbortController().signal;
    const first = await provider.provision({ name: "Starter", community: "wss://c.example", config, signal });
    // Buzz retries provision (as it does after any failure): same key, same app.
    const again = await provider.provision({ name: "Starter", community: "wss://c.example", config, signal });
    expect(again.pubkey).toBe(first.pubkey);
    await provider.activate({ pubkey: first.pubkey, name: "Starter", community: "wss://c.example", auth: attest(owner, first.pubkey), config, signal });
    // A second identity for the same app is refused.
    const other = appProvider({ storage: storage() } as never, fakeService(fake.client).service);
    await expect(other.provision({ name: "Copy", community: "wss://c.example", config: { ...config, mode: "own" }, signal })).rejects.toThrow(/already has a Buzz identity/);
    // The starter never deploys into an app it didn't make.
    await expect(other.provision({ name: "New", community: "wss://c.example", config, signal })).rejects.toThrow(/already an app named/);
  });

  it("connects an app you have without deploying to it, and leaves the app when removed", async () => {
    const fake = workspace();
    fake.apps.set("my-app", { name: "my-app", service_principal_client_id: "sp-mine", compute_status: { state: "ACTIVE" } });
    const provider = appProvider({ storage: storage() } as never, fakeService(fake.client).service);
    const signal = new AbortController().signal;
    const own = { ...config, mode: "own", app: "my-app" };
    const { pubkey } = await provider.provision({ name: "Mine", community: "wss://c.example", config: own, signal });
    await provider.activate({ pubkey, name: "Mine", community: "wss://c.example", auth: attest(owner, pubkey), config: own, signal });
    expect(fake.calls.some((call) => call.includes("/deployments"))).toBe(false);
    expect(fake.grants.map((grant) => grant.principal)).toEqual(["sp-mine", "sp-mine", "sp-mine"]);
    await provider.remove({ pubkey, signal });
    expect(fake.apps.has("my-app")).toBe(true);
    expect(fake.secrets.size).toBe(0);
    await expect(provider.provision({ name: "Gone", community: "wss://c.example", config: { ...own, app: "nope" }, signal })).rejects.toThrow(/no app named nope/);
  });
});

describe("the app library against a relay", () => {
  let relay: FakeRelay;
  let databricks: Server;
  let dir: string;
  let app: ChildProcess | undefined;
  let port = 0;
  let appPort = 0;
  const secrets = new Map<string, string>();
  const secretName = "main.buzz_apps.buzz_probe";
  const key = generateSecretKey();
  const pubkey = getPublicKey(key);
  const owner = generateSecretKey();
  const stranger = generateSecretKey();
  let identity: Record<string, unknown> = {};
  const setIdentity = (change: Record<string, unknown>) => {
    identity = { ...identity, ...change };
    secrets.set(secretName, JSON.stringify(identity));
  };
  const status = async () => (await fetch(`http://127.0.0.1:${appPort}/api/status`)).json() as Promise<Record<string, unknown>>;
  const until = async (test: () => Promise<boolean>, timeoutMs = 15_000) => {
    const end = Date.now() + timeoutMs;
    while (!(await test().catch(() => false))) {
      if (Date.now() > end) throw new Error("timed out");
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  };
  const mention = (secret: Uint8Array, content: string) => {
    const event = finalizeEvent({ kind: 9, created_at: now(), content, tags: [["h", "general"], ["p", pubkey]] }, secret);
    relay.insert(event);
    return event;
  };
  const fromApp = (test: (event: NostrEvent) => boolean) => (event: NostrEvent) => event.pubkey === pubkey && test(event);

  beforeAll(async () => {
    relay = await fakeRelay();
    relay.insert(finalizeEvent({ kind: 39000, created_at: now(), content: "", tags: [["d", "general"], ["t", "stream"]] }, generateSecretKey()));
    // Databricks as the app sees it: a token for its service principal, the secret, and who it is.
    databricks = createServer((request, response) => {
      const url = new URL(request.url ?? "/", "http://x");
      const reply = (code: number, body: unknown) => {
        response.writeHead(code, { "content-type": "application/json" });
        response.end(JSON.stringify(body));
      };
      if (url.pathname === "/oidc/v1/token") return request.headers.authorization === `Basic ${Buffer.from("client:shh").toString("base64")}` ? reply(200, { access_token: "sp-token", expires_in: 3600 }) : reply(401, { error_description: "bad client" });
      if (request.headers.authorization !== "Bearer sp-token") return reply(401, { message: "no token" });
      if (url.pathname === "/api/2.0/preview/scim/v2/Me") return reply(200, { userName: "11111111-2222", displayName: "app-probe" });
      const secret = /^\/api\/2\.1\/unity-catalog\/secrets\/(.+)$/.exec(url.pathname)?.[1];
      if (secret && url.searchParams.get("include_value") === "true") return secrets.has(secret) ? reply(200, { effective_value: secrets.get(secret) }) : reply(404, { message: "not found" });
      reply(404, { message: "no route" });
    });
    await new Promise<void>((resolve) => databricks.listen(0, "127.0.0.1", resolve));
    port = (databricks.address() as { port: number }).port;
    dir = mkdtempSync(join(tmpdir(), "buzz-app-"));
    const bundle = await build({
      entryPoints: [new URL("../plugins/agents/app/sdk.ts", import.meta.url).pathname],
      bundle: true,
      format: "esm",
      platform: "node",
      target: "node20",
      write: false,
      tsconfig: new URL("../tsconfig.json", import.meta.url).pathname,
      logLevel: "silent",
    });
    writeFileSync(join(dir, "buzz-app.mjs"), bundle.outputFiles[0]!.text);
    copyFileSync(new URL("../plugins/agents/app/starter/app.mjs", import.meta.url).pathname, join(dir, "app.mjs"));
    setIdentity({ v: 1, key: hex(key), app: "probe", workspace: "https://w.example" });
    const free = createServer();
    await new Promise<void>((resolve) => free.listen(0, "127.0.0.1", resolve));
    appPort = (free.address() as { port: number }).port;
    await new Promise((resolve) => free.close(resolve));
    app = spawn(process.execPath, [join(dir, "app.mjs")], {
      cwd: dir,
      env: {
        ...process.env,
        DATABRICKS_HOST: `http://127.0.0.1:${port}`,
        DATABRICKS_CLIENT_ID: "client",
        DATABRICKS_CLIENT_SECRET: "shh",
        DATABRICKS_APP_PORT: String(appPort),
        DATABRICKS_APP_NAME: "probe",
        BUZZ_IDENTITY_SECRET: secretName,
        BUZZ_APP_SOURCE: "/Workspace/Users/me@example.com/buzz-apps/probe",
        BUZZ_REFRESH_MS: "300",
      },
      stdio: "ignore",
    });
    await until(async () => (await status()).state === "waiting");
  }, 60_000);

  afterAll(async () => {
    app?.kill("SIGTERM");
    await relay?.close();
    await new Promise((resolve) => databricks?.close(resolve));
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it("waits for Buzz, then signs in as its identity with the owner's attestation and publishes its profile", async () => {
    expect(relay.signedIn.has(pubkey)).toBe(false);
    const auth = attest(owner, pubkey);
    setIdentity({ relay: relay.url, owner: getPublicKey(owner), auth, name: "Probe" });
    const profile = await relay.waitFor(fromApp((event) => event.kind === 0), 15_000);
    expect(JSON.parse(profile.content)).toMatchObject({ name: "Probe", bot: true, about: expect.stringContaining("service principal app-probe (11111111-2222)") });
    expect(profile.tags).toContainEqual(auth);
    expect(relay.authTags.at(-1)).toEqual(auth);
    await until(async () => (await status()).state === "connected");
  });

  it("answers anyone who mentions it, in a thread, saying who it runs as", async () => {
    const asked = mention(stranger, "hello app");
    const reply = await relay.waitFor(fromApp((event) => event.kind === 9 && event.tags.some((tag) => tag[0] === "e" && tag[1] === asked.id)), 15_000);
    expect(reply.content).toContain("**app-probe** (`11111111-2222`)");
    expect(reply.content).toContain("You said: “hello app”");
    expect(reply.content).toContain("/Workspace/Users/me@example.com/buzz-apps/probe");
  });

  it("answers only its owner once told to, and tells others why", async () => {
    setIdentity({ answers: "owner" });
    await new Promise((resolve) => setTimeout(resolve, 1000));
    const asked = mention(stranger, "and now?");
    const note = await relay.waitFor(fromApp((event) => event.kind === 9 && event.tags.some((tag) => tag[0] === "e" && tag[1] === asked.id)), 15_000);
    expect(note.content).toBe(NOT_ALLOWED_TEXT);
    expect(note.tags).toContainEqual(["p", getPublicKey(owner)]);
    const fromOwner = mention(owner, "me?");
    const reply = await relay.waitFor(fromApp((event) => event.kind === 9 && event.tags.some((tag) => tag[0] === "e" && tag[1] === fromOwner.id)), 15_000);
    expect(reply.content).toContain("You said: “me?”");
  });

  it("signs out once its secret is gone", async () => {
    secrets.delete(secretName);
    await until(async () => (await status()).state === "removed");
  });
});
