// Channels, domains and Pages against a fake Databricks: setup steps (order,
// idempotence, refusals), agent tools (linked, unlinked, Pages off), page
// drafts (create vs append, published pages), and the message action's match.
import { describe, expect, it } from "vitest";
import type { DatabricksClient } from "@dbx/core/client";
import { DatabricksApiError } from "@dbx/core/client";
import type { DatabricksService } from "@dbx/core/service";
import type { SkillCatalog } from "@dbx/core/skill-catalog";
import { setUpChannel, schemaNameFor, domainKey, unlinkChannel, quoteIdent, type SetupInput } from "../plugins/knowledge/src/channel-setup";
import { channelTools } from "../plugins/knowledge/src/channel-tools";
import { addDraft, PAGES_OFF, parsePageBlock, pageBlockFence, titleFrom, type PageBlock } from "../plugins/knowledge/src/page-draft";
import { addToPageAction, linkedDomainId } from "../plugins/knowledge/src/page-card";

type Call = { method: string; path: string; query?: Record<string, unknown>; body?: unknown; raw?: boolean };
/** A raw HTTP answer, for requests read by status (Pages availability). */
class Raw {
  constructor(
    readonly status: number,
    readonly body: string,
  ) {}
}
type Route = (call: Call) => unknown;

const denied = (message = "User does not have permission") => new DatabricksApiError(403, "PERMISSION_DENIED", message, "");

function fakeClient(route: Route, calls: Call[] = []): DatabricksClient {
  const run = (method: string, path: string, query?: Record<string, unknown>, body?: unknown, raw = false) => {
    const call = { method, path, ...(query && { query }), ...(body !== undefined && { body }) };
    calls.push(call);
    const value = route({ ...call, ...(raw && { raw: true }) });
    if (value instanceof Error) throw value;
    if (value instanceof Raw) {
      if (raw) return value;
      const parsed = JSON.parse(value.body) as { error_code?: string; message?: string };
      throw new DatabricksApiError(value.status, parsed.error_code, parsed.message ?? "", value.body);
    }
    if (value === undefined) throw new DatabricksApiError(404, "NOT_FOUND", `no route for ${method} ${path}`, "");
    return value;
  };
  return {
    host: "https://w.example",
    get: (path: string, init: { query?: Record<string, unknown> } = {}) => run("GET", path, init.query),
    post: (path: string, body?: unknown, init: { query?: Record<string, unknown> } = {}) => run("POST", path, init.query, body),
    json: (path: string, init: { method?: string; body?: unknown; query?: Record<string, unknown> } = {}) => run(init.method ?? "GET", path, init.query, init.body),
    request: (path: string, init: { method?: string; query?: Record<string, unknown> } = {}) => {
      const value = route({ method: init.method ?? "GET", path, ...(init.query && { query: init.query }), raw: true });
      calls.push({ method: init.method ?? "GET", path, ...(init.query && { query: init.query }) });
      if (value instanceof Raw) return value;
      if (value instanceof Error) throw value;
      return value === undefined ? new Raw(404, "{}") : new Raw(200, JSON.stringify(value));
    },
  } as unknown as DatabricksClient;
}

const CONNECTED = { status: "connected", profile: { host: "https://w.example", name: "p" }, user: { userName: "me@example.com" } };
const service = (client: DatabricksClient) =>
  ({
    version: 1,
    snapshot: () => CONNECTED,
    subscribe: () => () => {},
    ready: async () => client,
    workspaceUrl: (path: string) => `https://w.example${path}`,
    openSettings() {},
    preferences: { get: () => undefined, set: () => {}, subscribe: () => () => {} },
  }) as unknown as DatabricksService;

const pagesOff = () => new Raw(501, JSON.stringify({ error_code: "NOT_IMPLEMENTED", message: "The Knowledge Pages public API is not enabled on this deployment." }));

const input = (overrides: Partial<SetupInput> = {}): SetupInput => ({
  channel: { id: "chan-1", name: "Sales" },
  domain: { mode: "new", title: "Sales" },
  schema: { catalog: "cat", name: "sales", create: true },
  viewer: "me@example.com",
  ...overrides,
});

const tagPosts = (calls: Call[]) => calls.filter((call) => call.method === "POST" && call.path === "/api/2.1/unity-catalog/entity-tag-assignments").map((call) => call.body as Record<string, string>);

describe("setUpChannel", () => {
  it("creates the domain and schema, tags them in order, then links the channel", async () => {
    const calls: Call[] = [];
    const client = fakeClient((call) => {
      if (call.path === "/api/2.0/domains" && call.method === "POST") return { name: "domains/d1", domain_id: "d1", tag_key: "Sales", effective_draft: true };
      if (call.path === "/api/2.1/unity-catalog/entity-tag-assignments") return {};
      if (call.path === "/api/2.1/unity-catalog/schemas") return {};
      if (call.path === "/api/2.1/tag-policies" && call.method === "POST") return {};
      return undefined;
    }, calls);

    const result = await setUpChannel(client, input());

    expect(result.steps.map((step) => [step.id, step.status])).toEqual([
      ["domain", "done"],
      ["schema", "done"],
      ["tag-domain", "done"],
      ["tag-metadata", "done"],
      ["link", "done"],
    ]);
    expect(result.linked).toBe(true);
    expect(result.domainId).toBe("d1");
    expect(result.schema).toBe("cat.sales");
    // The governed tag carries no value; the link is written last.
    expect(tagPosts(calls).map((body) => [body.tag_key, body.tag_value ?? ""])).toEqual([
      ["Sales", ""],
      ["agent_skills", "Sales"],
      ["buzz_domain", "d1"],
      ["buzz_channel", "chan-1"],
    ]);
    expect(tagPosts(calls).every((body) => body.entity_type === "schemas" && body.entity_name === "cat.sales")).toBe(true);
    const domainBody = calls.find((call) => call.path === "/api/2.0/domains")?.body as Record<string, unknown>;
    expect(domainBody).toMatchObject({ tag_key: "Sales", draft: true });
  });

  it("reuses an existing domain and schema, and sets the tags again", async () => {
    const calls: Call[] = [];
    const client = fakeClient((call) => {
      if (call.path === "/api/2.1/unity-catalog/entity-tag-assignments/schemas/cat.sales/tags" && call.method === "GET")
        return { tag_assignments: [{ tag_key: "buzz_channel", tag_value: "chan-1" }] };
      // The tag is already there: the create answers ALREADY_EXISTS and the update takes over.
      if (call.path === "/api/2.1/unity-catalog/entity-tag-assignments" && call.method === "POST")
        return new DatabricksApiError(400, "ALREADY_EXISTS", "tag exists", "");
      if (call.method === "PATCH" && call.path.startsWith("/api/2.1/unity-catalog/entity-tag-assignments/")) return {};
      return undefined;
    }, calls);

    const result = await setUpChannel(
      client,
      input({ domain: { mode: "existing", id: "d1", tagKey: "Sales", title: "Sales" }, schema: { catalog: "cat", name: "sales", create: false } }),
    );

    expect(result.steps.every((step) => step.status === "done")).toBe(true);
    expect(result.linked).toBe(true);
    expect(calls.some((call) => call.path === "/api/2.1/unity-catalog/schemas")).toBe(false);
    expect(calls.filter((call) => call.method === "PATCH").length).toBe(4);
  });

  it("says what to ask for when the schema can't be created, and writes no tags", async () => {
    const calls: Call[] = [];
    const client = fakeClient((call) => {
      if (call.path === "/api/2.1/unity-catalog/schemas") return denied("User does not have CREATE SCHEMA on Catalog 'cat'");
      if (call.path === "/api/2.0/domains" && call.method === "POST") return { name: "domains/d1", domain_id: "d1", tag_key: "Sales" };
      if (call.path === "/api/2.1/tag-policies" && call.method === "POST") return {};
      return undefined;
    }, calls);

    const result = await setUpChannel(client, input());

    const schema = result.steps.find((step) => step.id === "schema");
    expect(schema?.status).toBe("denied");
    expect(schema?.sql).toBe("GRANT CREATE SCHEMA ON CATALOG `cat` TO `me@example.com`");
    expect(result.steps.filter((step) => step.id.startsWith("tag") || step.id === "link").map((step) => step.status)).toEqual(["skipped", "skipped", "skipped"]);
    expect(result.linked).toBe(false);
    expect(tagPosts(calls)).toEqual([]);
  });

  it("reports a refused governed tag and still links, so the channel isn't stuck", async () => {
    const client = fakeClient((call) => {
      if (call.path === "/api/2.0/domains" && call.method === "POST") return { name: "domains/d1", domain_id: "d1", tag_key: "Sales" };
      if (call.path === "/api/2.1/tag-policies" && call.method === "POST") return {};
      if (call.path === "/api/2.1/unity-catalog/schemas") return {};
      if (call.path === "/api/2.1/unity-catalog/entity-tag-assignments" && call.method === "POST") {
        const body = (call.body ?? {}) as { tag_key?: string };
        return body.tag_key === "Sales" ? denied("no ASSIGN") : {};
      }
      return undefined;
    });

    const result = await setUpChannel(client, input());

    const domainTag = result.steps.find((step) => step.id === "tag-domain");
    expect(domainTag?.status).toBe("denied");
    expect(domainTag?.detail).toContain("ASSIGN");
    expect(result.steps.find((step) => step.id === "link")?.status).toBe("done");
    expect(result.linked).toBe(true);
  });

  it("explains the tag-policy limit instead of failing with a raw error", async () => {
    const calls: Call[] = [];
    const client = fakeClient((call) => {
      if (call.path === "/api/2.1/tag-policies" && call.method === "POST")
        return new DatabricksApiError(400, "BAD_REQUEST", "The maximum number of tag policies allowed is reached for the account.", "");
      return undefined;
    }, calls);

    const result = await setUpChannel(client, input());

    expect(result.steps[0]).toMatchObject({ id: "domain", status: "failed" });
    expect(result.steps[0]?.detail).toContain("limit of tag policies");
    expect(calls.some((call) => call.path === "/api/2.1/unity-catalog/schemas")).toBe(false);
    expect(result.linked).toBe(false);
  });

  it("stops at a schema that another channel already uses", async () => {
    const calls: Call[] = [];
    const client = fakeClient((call) => {
      if (call.path === "/api/2.1/unity-catalog/entity-tag-assignments/schemas/cat.sales/tags")
        return { tag_assignments: [{ tag_key: "buzz_channel", tag_value: "other-channel" }] };
      return undefined;
    }, calls);

    const result = await setUpChannel(client, input({ domain: { mode: "existing", id: "d1", tagKey: "Sales", title: "Sales" }, schema: { catalog: "cat", name: "sales", create: false } }));

    expect(result.steps[1]).toMatchObject({ id: "schema", status: "failed" });
    expect(result.steps[1]?.detail).toContain("already linked to another Buzz channel");
    expect(tagPosts(calls)).toEqual([]);
    expect(result.linked).toBe(false);
  });

  it("grants a group the schema and catalog access, and gives the catalog GRANT when refused", async () => {
    const calls: Call[] = [];
    const client = fakeClient((call) => {
      if (call.path === "/api/2.1/unity-catalog/permissions/schema/cat.sales" && call.method === "PATCH") return {};
      if (call.path === "/api/2.1/unity-catalog/permissions/catalog/cat" && call.method === "PATCH") return denied("not an owner of cat");
      if (call.path === "/api/2.0/domains" && call.method === "POST") return { name: "domains/d1", domain_id: "d1", tag_key: "Sales" };
      if (call.path === "/api/2.1/tag-policies" && call.method === "POST") return {};
      if (call.path === "/api/2.1/unity-catalog/schemas") return {};
      if (call.path === "/api/2.1/unity-catalog/entity-tag-assignments" && call.method === "POST") return {};
      return undefined;
    }, calls);

    const result = await setUpChannel(client, input({ principal: "analysts" }));

    const schemaGrant = calls.find((call) => call.path === "/api/2.1/unity-catalog/permissions/schema/cat.sales");
    expect(schemaGrant?.body).toEqual({ changes: [{ principal: "analysts", add: ["USE_SCHEMA", "READ_VOLUME"] }] });
    expect(result.steps.find((step) => step.id === "share-schema")?.status).toBe("done");
    const catalog = result.steps.find((step) => step.id === "share-catalog");
    expect(catalog?.status).toBe("denied");
    expect(catalog?.sql).toBe("GRANT USE CATALOG ON CATALOG `cat` TO `analysts`");
    expect(result.linked).toBe(true);
  });

  it("removes only the channel's tag when unlinking", async () => {
    const calls: Call[] = [];
    const client = fakeClient((call) => (call.method === "DELETE" ? {} : undefined), calls);
    await unlinkChannel(client, "cat.sales");
    expect(calls).toEqual([{ method: "DELETE", path: "/api/2.1/unity-catalog/entity-tag-assignments/schemas/cat.sales/tags/buzz_channel" }]);
  });

  it("builds names and keys", () => {
    expect(schemaNameFor("Sales & Ops 2026")).toBe("sales_ops_2026");
    expect(schemaNameFor("2026 plans")).toBe("c_2026_plans");
    expect(schemaNameFor("!!!")).toBe("channel");
    expect(domainKey("Ops", { tagKey: "Sales" })).toBe("Sales/Ops");
    expect(domainKey("Sales")).toBe("Sales");
    expect(quoteIdent("we`ird")).toBe("`we``ird`");
  });
});

/** A catalog with one linked channel, as SkillCatalog reports it. */
function fakeCatalog(linked: boolean, skills: { fullName: string; description: string }[] = []) {
  const schemas = linked ? [{ schema: "cat.sales", tags: { agent_skills: "Sales", buzz_channel: "chan-1", buzz_domain: "d1" }, source: "tag" as const }] : [];
  const link = linked ? { schema: "cat.sales", channelId: "chan-1", domainId: "d1" } : undefined;
  return {
    snapshot: () => ({ status: "ready", schemas, skills: skills.map((skill) => skill), at: Date.now() }),
    load: async () => ({ status: "ready", schemas, skills, at: Date.now() }),
    channel: async (id: string) => (id === "chan-1" ? link : undefined),
    channelSkills: async (id: string) => (id === "chan-1" && linked ? skills.map((skill) => ({ fullName: `cat.sales.${skill.fullName}`, description: skill.description })) : []),
    subscribe: () => () => {},
  } as unknown as SkillCatalog;
}

const DOMAIN = { name: "domains/d1", domain_id: "d1", tag_key: "Sales", effective_draft: false, description: "Revenue" };
const tool = (name: string, catalog: SkillCatalog, client: DatabricksClient) => {
  const found = channelTools(service(client), catalog).find((item) => item.name === name);
  if (!found) throw new Error(`no tool ${name}`);
  return found;
};

describe("channel tools", () => {
  it("says how to set up an unlinked channel", async () => {
    const client = fakeClient(() => undefined);
    const reply = await tool("databricks_channel_info", fakeCatalog(false), client).call(client as never, { channel: "chan-1" }, {});
    expect(reply).toContain("Set up Databricks");
  });

  it("describes a linked channel with its domain, skills and Pages off", async () => {
    const client = fakeClient((call) => {
      if (call.path === "/api/2.0/domains/d1") return DOMAIN;
      if (call.path === "/api/2.0/knowledge/pages" && call.raw) return pagesOff();
      return undefined;
    });
    const catalog = fakeCatalog(true, [{ fullName: "fares", description: "Fare rules" }]);
    const reply = (await tool("databricks_channel_info", catalog, client).call(client as never, { channel: "chan-1" }, {})) as string;
    expect(reply).toContain("Domain: Sales (published)");
    expect(reply).toContain("Revenue");
    expect(reply).toContain("Skills schema: cat.sales");
    expect(reply).toContain("cat.sales.fares: Fare rules");
    expect(reply).toContain(PAGES_OFF);
  });

  it("lists a linked channel's pages when Pages is on", async () => {
    const client = fakeClient((call) => {
      if (call.path === "/api/2.0/domains/d1") return DOMAIN;
      if (call.path === "/api/2.0/knowledge/pages" && call.raw) return { pages: [] };
      if (call.path === "/api/2.0/knowledge/pages") return { pages: [{ name: "pages/p1", domain: "domains/d1", display_name: "Fare tips", state: "DRAFT" }] };
      return undefined;
    });
    const reply = (await tool("databricks_channel_info", fakeCatalog(true), client).call(client as never, { channel: "chan-1" }, {})) as string;
    expect(reply).toContain("Pages (1):");
    expect(reply).toContain("Fare tips (pages/p1, draft)");
  });

  it("says Pages is off for search and drafts, and returns no block", async () => {
    const client = fakeClient((call) => (call.path === "/api/2.0/knowledge/pages" && call.raw ? pagesOff() : undefined));
    const catalog = fakeCatalog(true);
    expect(await tool("databricks_pages_search", catalog, client).call(client as never, { channel: "chan-1" }, { query: "fares" })).toBe(PAGES_OFF);
    expect(await tool("databricks_page_draft", catalog, client).call(client as never, { channel: "chan-1" }, { title: "T", body: "B" })).toBe(PAGES_OFF);
  });

  it("searches the channel's domain pages by every word", async () => {
    const queries: unknown[] = [];
    const client = fakeClient((call) => {
      if (call.path === "/api/2.0/knowledge/pages" && call.raw) return { pages: [] };
      if (call.path === "/api/2.0/knowledge/pages") {
        queries.push(call.query);
        return {
          pages: [
            { name: "pages/p1", domain: "domains/d1", display_name: "Fare tips", body: "Weekend fares are cheaper.", state: "PUBLISHED" },
            { name: "pages/p2", domain: "domains/d1", display_name: "Refunds", body: "Fares are refunded in 7 days.", state: "DRAFT" },
          ],
        };
      }
      return undefined;
    });
    const reply = (await tool("databricks_pages_search", fakeCatalog(true), client).call(client as never, { channel: "chan-1" }, { query: "weekend fares" })) as string;
    expect(reply).toContain("Fare tips — pages/p1 (published)");
    expect(reply).not.toContain("Refunds");
    expect(queries[0]).toEqual({ page_size: 100, filter: 'domain = "domains/d1"' });
    expect(await tool("databricks_pages_search", fakeCatalog(true), client).call(client as never, { channel: "chan-1" }, { query: "parking" })).toBe("No pages match that.");
  });

  it("reads a page, and says so when it doesn't exist", async () => {
    const client = fakeClient((call) => {
      if (call.path === "/api/2.0/knowledge/pages" && call.raw) return { pages: [] };
      if (call.path === "/api/2.0/knowledge/pages/p1") return { name: "pages/p1", domain: "domains/d1", display_name: "Fare tips", body: "Weekend fares.", state: "DRAFT" };
      return undefined;
    });
    const read = tool("databricks_page_read", fakeCatalog(true), client);
    expect(await read.call(client as never, { channel: "chan-1" }, { name: "pages/p1" })).toContain("Weekend fares.");
    expect(await read.call(client as never, { channel: "chan-1" }, { name: "pages/missing" })).toBe("There's no page named pages/missing.");
  });

  it("drafts a block for the channel's domain without writing anything", async () => {
    const writes: Call[] = [];
    const client = fakeClient((call) => {
      if (call.method !== "GET") writes.push(call);
      if (call.path === "/api/2.0/knowledge/pages" && call.raw) return { pages: [] };
      if (call.path === "/api/2.0/domains/d1") return DOMAIN;
      return undefined;
    });
    const reply = (await tool("databricks_page_draft", fakeCatalog(true), client).call(client as never, { channel: "chan-1" }, {
      title: "Fare tips",
      body: "Weekend fares.\n\n```sql\nSELECT 1\n```",
    })) as string;
    const match = /```databricks-page\n([\s\S]*?)\n```/.exec(reply);
    expect(match).not.toBeNull();
    const block = parsePageBlock(match![1]!);
    expect(block).toMatchObject({ title: "Fare tips", domain: "domains/d1", domain_title: "Sales" });
    expect(block?.body).toContain("SELECT 1");
    expect(writes).toEqual([]);
  });

  it("asks for a domain when the channel has none to draft into", async () => {
    const client = fakeClient((call) => (call.path === "/api/2.0/knowledge/pages" && call.raw ? { pages: [] } : undefined));
    await expect(tool("databricks_page_draft", fakeCatalog(false), client).call(client as never, { channel: "chan-1" }, { title: "T", body: "B" })).rejects.toThrow(
      "isn't set up with a domain",
    );
  });
});

describe("page drafts", () => {
  const block: PageBlock = { title: "Fare tips", body: "Weekend fares.", domain: "domains/d1", domain_title: "Sales" };

  it("creates a draft page in the domain, with a request ID", async () => {
    const calls: Call[] = [];
    const client = fakeClient((call) => (call.method === "POST" && call.path === "/api/2.0/knowledge/pages" ? { name: "pages/p9", display_name: "Fare tips", state: "DRAFT" } : undefined), calls);
    const result = await addDraft(client, block, {}, "req-1");
    expect(result).toEqual({ page: "pages/p9", title: "Fare tips", mode: "created" });
    expect(calls[0]).toMatchObject({
      method: "POST",
      path: "/api/2.0/knowledge/pages",
      body: { domain: "domains/d1", display_name: "Fare tips", body: "Weekend fares.", state: "DRAFT" },
      query: { request_id: "req-1" },
    });
  });

  it("appends a section to an existing draft page", async () => {
    const calls: Call[] = [];
    const client = fakeClient((call) => {
      if (call.method === "GET" && call.path === "/api/2.0/knowledge/pages/p1") return { name: "pages/p1", domain: "domains/d1", display_name: "Fares", body: "Existing text.", state: "DRAFT" };
      if (call.method === "PATCH" && call.path === "/api/2.0/knowledge/pages/p1") return { name: "pages/p1", display_name: "Fares", state: "DRAFT" };
      return undefined;
    }, calls);
    const result = await addDraft(client, block, { page: "pages/p1" });
    expect(result).toEqual({ page: "pages/p1", title: "Fares", mode: "appended" });
    const patch = calls.find((call) => call.method === "PATCH");
    expect(patch?.query).toEqual({ update_mask: "body" });
    expect((patch?.body as { body: string }).body).toBe("Existing text.\n\n### Fare tips\n\nWeekend fares.");
  });

  it("won't change a published page", async () => {
    const calls: Call[] = [];
    const client = fakeClient((call) => (call.method === "GET" ? { name: "pages/p1", domain: "domains/d1", display_name: "Fares", body: "x", state: "PUBLISHED" } : undefined), calls);
    await expect(addDraft(client, block, { page: "pages/p1" })).rejects.toThrow("That page is published");
    expect(calls.some((call) => call.method === "PATCH")).toBe(false);
  });

  it("round-trips the block fence and rejects blocks that aren't drafts", () => {
    const fence = pageBlockFence(block);
    expect(fence.startsWith("```databricks-page\n")).toBe(true);
    const code = fence.replace(/^```databricks-page\n/, "").replace(/\n```$/, "");
    expect(parsePageBlock(code)).toEqual(block);
    expect(parsePageBlock("not json")).toBeUndefined();
    expect(parsePageBlock(JSON.stringify({ title: "T", body: "B", domain: "Sales" }))).toBeUndefined();
    expect(parsePageBlock(JSON.stringify({ title: "", body: "B", domain: "domains/d1" }))).toBeUndefined();
    expect(parsePageBlock(JSON.stringify({ title: "T", body: "B", domain: "domains/d1", page: "p1" }))?.page).toBe("pages/p1");
  });

  it("titles a message from its first line", () => {
    expect(titleFrom("## Weekend fares\nDetails")).toBe("Weekend fares");
    expect(titleFrom("   \n")).toBe("Untitled page");
    expect(titleFrom("x".repeat(100))).toHaveLength(78);
  });
});

describe("Add to page", () => {
  it("shows for messages in a linked channel, and not elsewhere", () => {
    const catalog = fakeCatalog(true);
    const action = addToPageAction(service(fakeClient(() => undefined)), catalog);
    expect(action.matches({ id: "m1", channelId: "chan-1", content: "Fares", authorId: "a", createdAt: 1 } as never)).toBe(true);
    expect(action.matches({ id: "m2", channelId: "chan-2", content: "Fares", authorId: "a", createdAt: 1 } as never)).toBe(false);
    expect(action.matches({ id: "m3", channelId: "chan-1", content: "  ", authorId: "a", createdAt: 1 } as never)).toBe(false);
    expect(linkedDomainId(catalog, "chan-1")).toBe("d1");
  });
});
