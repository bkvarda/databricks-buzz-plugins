// Live: a Databricks App identity end to end against a real workspace, through
// the same CLI path the plugin uses in Buzz. It creates an app, its Unity
// Catalog secret and grants, deploys the starter, checks the app signed in to
// Databricks as its service principal and read its identity, then deletes the
// app and the secret. The community it's given doesn't exist, so the app
// reports that it can't reach Buzz: sign-in to a real community is checked in
// Buzz itself. Skipped unless asked for:
//
//   DBX_LIVE_PROFILE=<profile> DBX_LIVE_APPS=<catalog.schema> npx vitest run tests/live-apps.test.ts
//
// With DBX_LIVE_SEARCH=<Lakebase project ID> it deploys the Search index
// template instead, checks it set up its index in that project's database as
// its service principal (and that Lakebase Search answers), and searches it as
// you. The index's schema stays in the database; nothing else does.
//
// Observed shapes go to tmp/live-apps-report.json.
import { mkdirSync, writeFileSync } from "node:fs";
import { schnorr } from "@noble/curves/secp256k1.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { generateSecretKey, getPublicKey } from "nostr-tools/pure";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { Apps, searchBuzz, UcSecrets } from "@dbx/core/api/apps";
import { Lakebase } from "@dbx/core/api/workspace";
import type { DatabricksClient } from "@dbx/core/client";
import { Connection } from "@dbx/core/connection";
import { createService } from "@dbx/core/provider";
import { identitySecretName, parseIdentity } from "../plugins/agents/src/app-identity";
import { type AppStatus, appProvider } from "../plugins/agents/src/app-type";
import { nodeHost } from "./node-host";

// The real library and starter (tests stub them): run `npm run build` first.
vi.mock("virtual:buzz-app", async () => {
  const { readFileSync } = await import("node:fs");
  return {
    SDK: readFileSync(new URL("../sdk/buzz-app.mjs", import.meta.url), "utf8"),
    INDEXER: readFileSync(new URL("../sdk/search-index.mjs", import.meta.url), "utf8"),
    STARTER: readFileSync(new URL("../plugins/agents/app/starter/app.mjs", import.meta.url), "utf8"),
    APP_SHA: "live",
  };
});

const PROFILE = process.env.DBX_LIVE_PROFILE;
const SCHEMA = process.env.DBX_LIVE_APPS;
const SEARCH = process.env.DBX_LIVE_SEARCH;
const APP = `buzz-${SEARCH ? "idx" : "live"}-${Date.now().toString(36)}`;
const report: Record<string, unknown> = {};
const hex = (bytes: Uint8Array) => Buffer.from(bytes).toString("hex");

describe.skipIf(!PROFILE || !SCHEMA)(`live Databricks App identity (${PROFILE}, ${SCHEMA})`, () => {
  const values = new Map<string, string>();
  const connection = new Connection(nodeHost(new URL("../plugins/databricks/manifest.json", import.meta.url).pathname), {
    get: (key) => values.get(key) ?? null,
    set: (key, value) => (value === null ? values.delete(key) : values.set(key, value)),
  });
  const store = new Map<string, string>();
  const storage = { get: (key: string) => store.get(key) ?? null, set: async (key: string, value: string | null) => void (value === null ? store.delete(key) : store.set(key, value)), keys: () => [...store.keys()] };
  let client: DatabricksClient;
  let provider: ReturnType<typeof appProvider>;
  let pubkey = "";
  let source = "";
  const signal = () => AbortSignal.timeout(25 * 60_000);

  beforeAll(async () => {
    await connection.useProfile(PROFILE!);
    client = await connection.ready(undefined, 60_000);
    provider = appProvider({ storage } as never, createService(connection, () => {}));
    // Earlier runs' probes (this test's names, over half an hour old), in case one was cut short.
    const me = connection.snapshot();
    for (const app of await new Apps(client).list()) {
      if (!/^buzz-(idx|live)-[0-9a-z]+$/.test(app.name) || !app.description?.endsWith(": Live probe")) continue;
      if (Date.now() - Date.parse((app as { create_time?: string }).create_time ?? "") < 30 * 60_000) continue;
      await new Apps(client).delete(app.name).catch(() => {});
      await new UcSecrets(client).delete(identitySecretName(SCHEMA!, app.name)).catch(() => {});
      if (me.status === "connected" && me.user?.userName) await client.post("/api/2.0/workspace/delete", { path: `/Workspace/Users/${me.user.userName}/buzz-apps/${app.name}`, recursive: true }).catch(() => {});
      report.swept = [...((report.swept as string[] | undefined) ?? []), app.name];
    }
  }, 180_000);

  afterAll(async () => {
    // Whatever happened, nothing is left behind (but a search index's schema in its database).
    if (pubkey) await provider.remove({ pubkey, signal: AbortSignal.timeout(120_000) }).catch((error) => (report.removeError = String(error)));
    // By name too, in case creation stopped partway.
    await new Apps(client).delete(APP).catch(() => {});
    await new UcSecrets(client).delete(identitySecretName(SCHEMA!, APP)).catch(() => {});
    const me = connection.snapshot();
    if (!source && me.status === "connected" && me.user?.userName) source = `/Workspace/Users/${me.user.userName}/buzz-apps/${APP}`;
    if (source) await client.post("/api/2.0/workspace/delete", { path: source, recursive: true }).catch(() => {});
    mkdirSync(new URL("../tmp/", import.meta.url), { recursive: true });
    writeFileSync(new URL("../tmp/live-apps-report.json", import.meta.url), JSON.stringify(report, null, 2));
  }, 180_000);

  it("makes the app, its key and its grants", async () => {
    const lakebase = SEARCH ? await new Lakebase(client).defaultDatabase(SEARCH) : undefined;
    if (SEARCH) expect(lakebase).toBeDefined();
    const config = { mode: "starter", template: SEARCH ? "search" : "starter", app: APP, schema: SCHEMA, answers: "everyone", ...(lakebase && { lakebase: { project: SEARCH, branch: lakebase.branch, database: lakebase.database } }) };
    ({ pubkey } = await provider.provision({ name: "Live probe", community: "wss://relay.invalid", config, signal: signal() }));
    const record = provider.read(pubkey)!;
    source = record.source;
    report.record = record;
    report.app = await new Apps(client).get(APP);
    const identity = parseIdentity(await new UcSecrets(client).read(record.secret));
    expect(identity && getPublicKey(Buffer.from(identity.key, "hex"))).toBe(pubkey);
    report.grants = await client.get(`/api/2.1/unity-catalog/permissions/secret/${record.secret}`).catch((error) => String(error));
  }, 10 * 60_000);

  it("deploys the starter, which signs in to Databricks as its service principal and reads its identity", async () => {
    const owner = generateSecretKey();
    const auth = ["auth", getPublicKey(owner), "", hex(schnorr.sign(sha256(new TextEncoder().encode(`nostr:agent-auth:${pubkey}:`)), owner))];
    await provider.activate({ pubkey, name: "Live probe", community: "wss://relay.invalid", auth, config: provider.read(pubkey)!.config, signal: signal() });
    let status: AppStatus = {};
    for (let i = 0; i < 60; i++) {
      status = await provider.status(pubkey);
      if (status.live?.state && status.live.state !== "starting" && status.live.state !== "waiting") break;
      await new Promise((resolve) => setTimeout(resolve, 5000));
    }
    report.status = status;
    // Signed in to Databricks and read its activated identity: it now tries the (made-up) community.
    expect(status.live?.runsAs?.applicationId).toBe(provider.read(pubkey)!.servicePrincipal?.id);
    expect(status.live?.pubkey).toBe(pubkey);
    expect(["connecting", "connected"]).toContain(status.live?.state);
  }, 30 * 60_000);

  it.skipIf(!SEARCH)("sets up its index in Lakebase as its service principal, and searches as you", async () => {
    type Live = Record<string, unknown>;
    let live: Live = {};
    for (let i = 0; i < 36; i++) {
      live = ((await provider.status(pubkey)).live ?? {}) as Live;
      if (typeof live.index === "string" && (live.index.startsWith("ready") || /isn't|failed|denied/.test(live.index)) && live.searchCheck !== "not run") break;
      await new Promise((resolve) => setTimeout(resolve, 5000));
    }
    report.search = live;
    expect(live.index).toMatch(/^ready/);
    expect(live.searchCheck).toMatch(/^ok/);
    const app = await new Apps(client).get(APP);
    report.hits = await searchBuzz(client, app!, "revenue report");
    expect(Array.isArray(report.hits)).toBe(true);
  }, 10 * 60_000);
});
