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
// Observed shapes go to tmp/live-apps-report.json.
import { mkdirSync, writeFileSync } from "node:fs";
import { schnorr } from "@noble/curves/secp256k1.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { generateSecretKey, getPublicKey } from "nostr-tools/pure";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { Apps, UcSecrets } from "@dbx/core/api/apps";
import type { DatabricksClient } from "@dbx/core/client";
import { Connection } from "@dbx/core/connection";
import { createService } from "@dbx/core/provider";
import { parseIdentity } from "../plugins/agents/src/app-identity";
import { type AppStatus, appProvider } from "../plugins/agents/src/app-type";
import { nodeHost } from "./node-host";

// The real library and starter (tests stub them): run `npm run build` first.
vi.mock("virtual:buzz-app", async () => {
  const { readFileSync } = await import("node:fs");
  return {
    SDK: readFileSync(new URL("../sdk/buzz-app.mjs", import.meta.url), "utf8"),
    STARTER: readFileSync(new URL("../plugins/agents/app/starter/app.mjs", import.meta.url), "utf8"),
    APP_SHA: "live",
  };
});

const PROFILE = process.env.DBX_LIVE_PROFILE;
const SCHEMA = process.env.DBX_LIVE_APPS;
const APP = `buzz-live-${Date.now().toString(36)}`;
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
  }, 90_000);

  afterAll(async () => {
    // Whatever happened, nothing is left behind but the code folder.
    if (pubkey) await provider.remove({ pubkey, signal: AbortSignal.timeout(120_000) }).catch((error) => (report.removeError = String(error)));
    await new Apps(client).delete(APP).catch(() => {});
    if (source) await client.post("/api/2.0/workspace/delete", { path: source, recursive: true }).catch(() => {});
    mkdirSync(new URL("../tmp/", import.meta.url), { recursive: true });
    writeFileSync(new URL("../tmp/live-apps-report.json", import.meta.url), JSON.stringify(report, null, 2));
  }, 180_000);

  it("makes the app, its key and its grants", async () => {
    const config = { mode: "starter", app: APP, schema: SCHEMA, answers: "everyone" };
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
});
