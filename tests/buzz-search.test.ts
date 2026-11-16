// The Buzz search index: what it keeps from Buzz events, how the plugin
// deploys the Search index template with its Lakebase database, and the
// search client the Search page and agent tool use.
import { finalizeEvent, generateSecretKey, getPublicKey } from "nostr-tools/pure";
import { describe, expect, it } from "vitest";
import { searchApps, searchBuzz } from "@dbx/core/api/apps";
import { DatabricksClient } from "@dbx/core/client";
import { npubEncode } from "nostr-tools/nip19";
import { channelOf, dateRange, deletionOf, editOf, messageOf, parseQuery, personOf, searchTerms } from "../plugins/agents/app/index-events";
import { chooseSuggestion, filterLabels, initialQuery, typingAt } from "../plugins/lakebase/src/search";
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

describe("Slack's search filters", () => {
  const now = Date.parse("2026-11-16T15:00:00Z");
  const at = (date: string) => Date.parse(`${date}T00:00:00Z`) / 1000;

  it("reads from:, to:, in:, has: and is:, and leaves the words", () => {
    const bob = getPublicKey(alice);
    expect(parseQuery(`from:@bkvarda to:${npubEncode(bob)} in:#general has:link is:thread launch "go live" -draft`, now)).toEqual({
      text: 'launch "go live" -draft',
      from: ["bkvarda"],
      to: [bob],
      in: ["general"],
      link: true,
      thread: true,
    });
    expect(parseQuery('from:"Brandon K" plan', now)).toMatchObject({ from: ["brandon k"], text: "plan" });
    // As people type it: a space after the colon, or a quoted name after @.
    expect(parseQuery("from: @bkvarda", now)).toMatchObject({ from: ["bkvarda"], text: "" });
    expect(parseQuery('to:@"Sam Lee" in: #general', now)).toMatchObject({ to: ["sam lee"], in: ["general"], text: "" });
    // A filter with nothing after it is just a word.
    expect(parseQuery("from: ", now)).toMatchObject({ from: [], text: "from:" });
  });

  it("reads dates as Slack does: before a day, after a day, on a day, during a month or year", () => {
    expect(parseQuery("before:2026-11-01", now)).toMatchObject({ before: at("2026-11-01") });
    expect(parseQuery("after:2026-11-01", now)).toMatchObject({ after: at("2026-11-02") });
    expect(parseQuery("on:2026-11-03", now)).toMatchObject({ after: at("2026-11-03"), before: at("2026-11-04") });
    expect(parseQuery("during:2026-11", now)).toMatchObject({ after: at("2026-11-01"), before: at("2026-12-01") });
    expect(parseQuery("during:2026", now)).toMatchObject({ after: at("2026-01-01"), before: at("2027-01-01") });
    expect(parseQuery("on:today", now)).toMatchObject({ after: at("2026-11-16"), before: at("2026-11-17") });
    expect(dateRange("2026-13")).toBeUndefined();
    // What it can't read stays in the words.
    expect(parseQuery("before:someday is:pinned", now)).toMatchObject({ text: "before:someday is:pinned", from: [], in: [] });
  });

  it("keeps who a message mentions, and people's handles", () => {
    const bob = getPublicKey(generateSecretKey());
    expect(messageOf(finalizeEvent({ kind: 9, created_at: 1, content: "hi", tags: [["h", "general"], ["p", bob], ["p", bob]] }, alice))?.mentions).toEqual([bob]);
    expect(personOf(finalizeEvent({ kind: 0, created_at: 1, content: JSON.stringify({ name: "BKvarda", display_name: "Brandon" }), tags: [] }, alice))).toMatchObject({ name: "Brandon", username: "bkvarda" });
    expect(personOf(finalizeEvent({ kind: 0, created_at: 1, content: JSON.stringify({ display_name: "Sam", nip05: "sam@example.com" }), tags: [] }, alice))?.username).toBe("sam");
  });

  it("shows what the index understood, and opens with a search", () => {
    expect(filterLabels({ text: "launch", from: ["bkvarda"], to: [], in: ["general"], after: at("2026-11-02"), link: true })).toEqual(["from @bkvarda", "in #general", "from 2026-11-02", "has a link"]);
    expect(initialQuery({ kind: "page", route: { version: 1, params: { q: "from:@sam" } } })).toBe("from:@sam");
    expect(initialQuery({ kind: "plugin", params: { q: "launch" } })).toBe("launch");
    expect(initialQuery(undefined)).toBe("");
  });
});

describe("suggestions as people type", () => {
  it("knows when a person or a channel is being typed", () => {
    expect(typingAt("launch @bk", 10)).toEqual({ kind: "people", filter: "from", typed: "bk", start: 7, end: 10 });
    expect(typingAt("to: @sa", 7)).toMatchObject({ kind: "people", filter: "to", typed: "sa" });
    expect(typingAt("from:", 5)).toMatchObject({ kind: "people", filter: "from", typed: "" });
    expect(typingAt("in:#gen", 7)).toMatchObject({ kind: "channels", typed: "gen", start: 0 });
    expect(typingAt("plan #", 6)).toMatchObject({ kind: "channels", typed: "" });
    expect(typingAt("email@example", 13)).toBeUndefined();
    expect(typingAt("launch plan", 11)).toBeUndefined();
  });

  it("puts the chosen person or channel in as a filter, and the caret after it", () => {
    const text = "launch @bk plan";
    const chosen = chooseSuggestion(text, typingAt(text, 10)!, "bkvarda");
    expect(chosen).toEqual({ text: "launch from:@bkvarda plan", caret: 21 });
    expect(chooseSuggestion("to:@sa", typingAt("to:@sa", 6)!, "sam lee").text).toBe('to:@"sam lee" ');
    expect(chooseSuggestion("in:#ge", typingAt("in:#ge", 6)!, "general").text).toBe("in:#general ");
    // And the parser reads them back.
    expect(parseQuery(chosen.text)).toMatchObject({ from: ["bkvarda"], text: "launch plan" });
    expect(parseQuery('to:@"sam lee" in:#general')).toMatchObject({ to: ["sam lee"], in: ["general"] });
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
    // It's on the plugin's current code; a record from before has no version, so it's redeployed.
    const record = provider.read(pubkey)!;
    expect(provider.outdated(record)).toBe(false);
    expect(provider.outdated({ ...record, deployedSha: undefined })).toBe(true);
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
