// The Buzz search index: what it keeps from Buzz events, how the plugin
// deploys the Search index template with its Lakebase database, and the
// search client the Search page and agent tool use.
import { finalizeEvent, generateSecretKey, getPublicKey } from "nostr-tools/pure";
import { describe, expect, it } from "vitest";
import { searchApps, searchBuzz } from "@dbx/core/api/apps";
import { DatabricksClient } from "@dbx/core/client";
import { channelOf, deletionOf, editOf, messageOf, personOf, searchTerms } from "../plugins/agents/app/index-events";
import { appConfigProblem, appProvider, normalizeAppConfig, summarizeApp } from "../plugins/agents/src/app-type";
import { parseIdentity } from "../plugins/agents/src/app-identity";
import { fakeService } from "./fake-workspace";

const relay = generateSecretKey();
const alice = generateSecretKey();
const now = () => Math.floor(Date.now() / 1000);
const metadata = (tags: string[][]) => finalizeEvent({ kind: 39000, created_at: now(), content: "", tags }, relay);
const id = (n: number) => String(n).repeat(64).slice(0, 64);

describe("what the index keeps", () => {
  it("indexes public channels only: not private, hidden (DMs), Solo chats or system channels", () => {
    expect(channelOf(metadata([["d", "general"], ["name", "General"], ["t", "stream"], ["public"]]))).toMatchObject({ id: "general", name: "General", public: true, signer: getPublicKey(relay) });
    expect(channelOf(metadata([["d", "secret"], ["t", "stream"], ["private"]]))?.public).toBe(false);
    expect(channelOf(metadata([["d", "dm1"], ["t", "dm"], ["public"], ["hidden"]]))?.public).toBe(false);
    expect(channelOf(metadata([["d", "solo"], ["t", "stream"], ["t", "buzz.solo"], ["public"]]))?.public).toBe(false);
    expect(channelOf(metadata([["d", "sys"], ["t", "system"], ["public"]]))?.public).toBe(false);
    // Unknown visibility isn't public.
    expect(channelOf(metadata([["d", "unknown"], ["t", "stream"]]))?.public).toBe(false);
  });

  it("keeps a message's text without mention links, and its thread", () => {
    const event = finalizeEvent({ kind: 9, created_at: 100, content: "nostr:npub1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqq8a7rf3 the Q3 plan is ready", tags: [["h", "general"], ["e", id(1), "", "root"]] }, alice);
    expect(messageOf(event)).toMatchObject({ channel: "general", author: getPublicKey(alice), root: id(1), text: "the Q3 plan is ready", createdAt: 100 });
    expect(messageOf(finalizeEvent({ kind: 9, created_at: 1, content: "no channel", tags: [] }, alice))).toBeUndefined();
  });

  it("reads edits, author deletions, and moderator deletions only from the relay", () => {
    expect(editOf(finalizeEvent({ kind: 40003, created_at: 5, content: "fixed typo", tags: [["e", id(2)], ["h", "general"]] }, alice))).toEqual({ target: id(2), author: getPublicKey(alice), text: "fixed typo", at: 5 });
    const signers = new Set([getPublicKey(relay)]);
    expect(deletionOf(finalizeEvent({ kind: 5, created_at: 6, content: "", tags: [["e", id(3)]] }, alice), signers)).toEqual({ targets: [id(3)], author: getPublicKey(alice), byRelay: false });
    expect(deletionOf(finalizeEvent({ kind: 9005, created_at: 6, content: "", tags: [["e", id(3)]] }, relay), signers)?.byRelay).toBe(true);
    // A 9005 from anyone but the relay deletes nothing.
    expect(deletionOf(finalizeEvent({ kind: 9005, created_at: 6, content: "", tags: [["e", id(3)]] }, alice), signers)).toBeUndefined();
  });

  it("names people from their profiles, and cleans search terms", () => {
    expect(personOf(finalizeEvent({ kind: 0, created_at: 7, content: JSON.stringify({ name: "alice", display_name: "Alice A." }), tags: [] }, alice))).toMatchObject({ name: "Alice A." });
    expect(searchTerms("  q3 & 'plan' (draft)!! ")).toBe("q3 'plan' draft");
    expect(searchTerms("&&&")).toBe("");
  });
});

describe("the Search index template", () => {
  it("needs a Lakebase project, and says what it is", () => {
    const config = normalizeAppConfig({ mode: "starter", template: "search", app: "buzz-search", schema: "main.buzz_apps" });
    expect(appConfigProblem(config)).toMatch(/Lakebase project/);
    const ready = normalizeAppConfig({ ...config, lakebase: { project: "p", branch: "projects/p/branches/production", database: "projects/p/branches/production/databases/db" } });
    expect(appConfigProblem(ready)).toBeUndefined();
    expect(summarizeApp(ready)).toBe("buzz-search · search index · answers everyone");
  });

  it("makes the app with its database, marks it as a search index, and deploys the indexer", async () => {
    const calls: { method: string; path: string; body?: any }[] = [];
    const apps = new Map<string, any>();
    const secrets = new Map<string, string>();
    const client = new DatabricksClient({
      host: "https://w.example",
      token: async () => "t",
      transport: async (request) => {
        const url = new URL(request.url);
        const path = decodeURIComponent(url.pathname);
        const method = request.method ?? "GET";
        const body = request.body ? JSON.parse(request.body) : undefined;
        calls.push({ method, path, body });
        const json = (value: unknown, status = 200) => ({ status, headers: { "content-type": "application/json" }, body: JSON.stringify(value) });
        let match: RegExpExecArray | null;
        if (path === "/api/2.0/apps" && method === "POST") {
          const app = { ...body, service_principal_client_id: "sp", compute_status: { state: "ACTIVE" } };
          apps.set(body.name, app);
          return json(app);
        }
        if ((match = /^\/api\/2\.0\/apps\/([^/]+)$/.exec(path))) return apps.has(match[1]!) ? json(apps.get(match[1]!)) : json({ error_code: "RESOURCE_DOES_NOT_EXIST" }, 404);
        if (/\/deployments$/.test(path)) return json({ deployment_id: "d", status: { state: "SUCCEEDED" } });
        if (path === "/api/2.1/unity-catalog/secrets") return secrets.set(`${body.catalog_name}.${body.schema_name}.${body.name}`, body.value), json({});
        if ((match = /^\/api\/2\.1\/unity-catalog\/secrets\/(.+)$/.exec(path))) {
          if (method === "PATCH") return secrets.set(match[1]!, body.value), json({});
          return secrets.has(match[1]!) ? json({ effective_value: secrets.get(match[1]!) }) : json({ error_code: "RESOURCE_DOES_NOT_EXIST" }, 404);
        }
        if (path.startsWith("/api/2.0/permissions/apps/")) return json({ access_control_list: method === "PATCH" ? body.access_control_list : [] });
        if (path === "/api/2.0/workspace/get-status") return json({}, 404);
        return json({});
      },
    });
    const store = new Map<string, string>();
    const provider = appProvider({ storage: { get: (k: string) => store.get(k) ?? null, set: async (k: string, v: string | null) => void (v === null ? store.delete(k) : store.set(k, v)), keys: () => [...store.keys()] } } as never, fakeService(client).service);
    const lakebase = { project: "buzz-search", branch: "projects/buzz-search/branches/production", database: "projects/buzz-search/branches/production/databases/databricks-postgres" };
    const config = { mode: "starter", template: "search", app: "buzz-search-index", schema: "main.buzz_apps", answers: "everyone", lakebase };
    const signal = new AbortController().signal;
    const { pubkey } = await provider.provision({ name: "Search", community: "wss://c.example", config, signal });
    const created = calls.find((call) => call.method === "POST" && call.path === "/api/2.0/apps")!.body;
    expect(created.description).toBe("Buzz search index: Search");
    expect(created.resources).toEqual([{ name: "postgres", description: "The search index", postgres: { branch: lakebase.branch, database: lakebase.database, permission: "CAN_CONNECT_AND_CREATE" } }]);
    const uploads = calls.filter((call) => call.path === "/api/2.0/workspace/import").map((call) => ({ path: call.body.path as string, text: Buffer.from(call.body.content, "base64").toString("utf8") }));
    expect(uploads.map((upload) => upload.path.split("/").pop()).sort()).toEqual(["app.mjs", "app.yaml"]);
    expect(uploads.find((upload) => upload.path.endsWith("app.mjs"))?.text).toContain("indexer stub");
    expect(uploads.find((upload) => upload.path.endsWith("app.yaml"))?.text).toContain("valueFrom: postgres");
    await provider.activate({ pubkey, name: "Search", community: "wss://c.example", auth: ["auth", "o".repeat(64), "", "s".repeat(128)], config, signal });
    expect(parseIdentity(secrets.get("main.buzz_apps.buzz_buzz_search_index"))?.relay).toBe("wss://c.example");
    expect(calls.some((call) => call.path.endsWith("/deployments"))).toBe(true);
    // Letting everyone search gives the workspace's users group Can Use.
    await provider.allowEveryone(pubkey);
    expect(calls.at(-1)).toMatchObject({ method: "PATCH", path: "/api/2.0/permissions/apps/buzz-search-index", body: { access_control_list: [{ group_name: "users", permission_level: "CAN_USE" }] } });
  });
});

describe("searching an index", () => {
  const client = (answer: { status: number; body: unknown }) =>
    new DatabricksClient({
      host: "https://w.example",
      token: async () => "t",
      transport: async (request): Promise<{ status: number; headers: Record<string, string>; body: string }> => {
        const url = new URL(request.url);
        if (url.pathname === "/api/2.0/apps") return { status: 200, headers: {}, body: JSON.stringify({ apps: [{ name: "idx", description: "Buzz search index: Search", url: "https://idx.example" }, { name: "other", description: "Something else" }] }) };
        expect(url.origin + url.pathname).toBe("https://idx.example/api/search");
        expect(url.searchParams.get("q")).toBe("q3 plan");
        return { status: answer.status, headers: { "content-type": "application/json" }, body: JSON.stringify(answer.body) };
      },
    });

  it("finds index apps by their description and searches one as the person", async () => {
    const found = await searchApps(client({ status: 200, body: {} }));
    expect(found.map((app) => app.name)).toEqual(["idx"]);
    const hits = await searchBuzz(client({ status: 200, body: { results: [{ id: id(1), channel: "general", channelName: "General", author: "a", createdAt: 1, snippet: "the **Q3** **plan**" }] } }), found[0]!, "q3 plan");
    expect(hits[0]?.snippet).toBe("the **Q3** **plan**");
  });

  it("explains when the person can't use the index", async () => {
    await expect(searchBuzz(client({ status: 403, body: {} }), { name: "idx", url: "https://idx.example" }, "q3 plan")).rejects.toThrow(/can't use the search index idx yet/);
  });
});
