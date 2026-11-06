// Databricks Knowledge, skills: what agents get from the tools (channel
// skills first, loading and reading files, drafts), the draft block's round
// trip, and publishing as the person (create, upload, finalize, replace, the
// domain tag, sharing). Runs against the in-memory fake workspace.
import { describe, expect, it } from "vitest";
import { skillMarkdown } from "@dbx/core/api/skills";
import { SkillCatalog } from "@dbx/core/skill-catalog";
import { draftBlock, draftFromText, parseDraft, type SkillDraft, validateDraft } from "../plugins/knowledge/src/skill-draft";
import { isAlreadyExists, publishDraft, shareSkill } from "../plugins/knowledge/src/skill-publish";
import { READ_BUDGET, skillTools } from "../plugins/knowledge/src/skill-tools";
import { fakeService, fakeWorkspace } from "./fake-workspace";

const md = (name: string, description: string, body = "# Body\n") => skillMarkdown({ name, description, body });

const SALES_TAGS: [string, string, string, string][] = [
  ["main", "sales", "agent_skills", "true"],
  ["main", "sales", "buzz_channel", "c1"],
  ["main", "sales", "buzz_domain", "dom-1"],
  ["main", "hr", "agent_skills", "true"],
];

function setup(options: Parameters<typeof fakeWorkspace>[0] = {}, prefs: Record<string, unknown> = {}) {
  const workspace = fakeWorkspace({ tags: SALES_TAGS, ...options });
  const fake = fakeService(workspace.client, prefs);
  const catalog = new SkillCatalog(fake.service);
  const tools = skillTools(fake.service, catalog);
  const client = {} as never;
  // The tools answer with text; the wrapper narrows AgentTool's wider reply type and binds the client.
  const tool = (name: string) => {
    const found = tools.find((candidate) => candidate.name === name);
    if (!found) throw new Error(`no tool ${name}`);
    return { call: async (context: Record<string, unknown>, args: Record<string, unknown>) => (await found.call(client, context as never, args)) as string };
  };
  return { workspace, fake, catalog, tool, client };
}

describe("databricks_skills_search", () => {
  const SKILLS = {
    "main.sales.quarterly-revenue": { description: "Quarterly revenue numbers.", body: md("quarterly-revenue", "Quarterly revenue numbers.") },
    "main.sales.pipeline": { description: "Pipeline stages and owners.", body: md("pipeline", "Pipeline stages and owners.") },
    "main.hr.revenue-policy": { description: "Revenue policy for expenses.", body: md("revenue-policy", "Revenue policy for expenses.") },
  };

  it("puts the channel's matching skills first", async () => {
    const { tool, client } = setup({ skills: SKILLS });
    const text = await tool("databricks_skills_search").call({ channel: "c1" }, { query: "revenue" });
    expect(text).toBe("- main.sales.quarterly-revenue — Quarterly revenue numbers.\n- main.hr.revenue-policy — Revenue policy for expenses.");
  });

  it("leaves out channel skills that don't match, and respects the limit", async () => {
    const { tool, client } = setup({ skills: SKILLS });
    const text = await tool("databricks_skills_search").call({ channel: "c1" }, { query: "expenses", limit: 1 });
    expect(text).toBe("- main.hr.revenue-policy — Revenue policy for expenses.");
    const limited = await tool("databricks_skills_search").call({ channel: "c1" }, { query: "revenue", limit: 1 });
    expect(limited).toBe("- main.sales.quarterly-revenue — Quarterly revenue numbers.");
  });

  it("says where it looked when nothing matches", async () => {
    const { tool, client } = setup({ skills: SKILLS });
    const text = await tool("databricks_skills_search").call({}, { query: "weather" });
    expect(text).toContain('No skills match "weather".');
    expect(text).toContain("Searched 2 skills schemas.");
    expect(text).toContain("tagged agent_skills");
    expect(text).toContain("Settings → Databricks Knowledge");
  });

  it("says when tag discovery failed", async () => {
    const { tool, client } = setup({ noWarehouse: true });
    const text = await tool("databricks_skills_search").call({}, { query: "revenue" });
    expect(text).toContain("No skills schemas were found.");
    expect(text).toMatch(/Couldn't look for tagged skills schemas: No SQL warehouse/);
  });
});

describe("databricks_skills_load and read_files", () => {
  const SKILL = {
    "main.sales.quarterly-revenue": {
      description: "Quarterly revenue numbers.",
      body: md("quarterly-revenue", "Quarterly revenue numbers.", "# Steps\n\n1. Query the orders table.\n"),
      files: { "references/tables.md": "# Tables\norders\n" },
    },
  };

  it("returns SKILL.md and the other files to read", async () => {
    const { tool, client } = setup({ skills: SKILL });
    const text = await tool("databricks_skills_load").call({}, { name: "main.sales.quarterly-revenue" });
    expect(text).toContain("Skill main.sales.quarterly-revenue:");
    expect(text).toContain("1. Query the orders table.");
    expect(text).toContain("Other files in main.sales.quarterly-revenue (read them with databricks_skills_read_files):\n- references/tables.md");
    expect(text).not.toMatch(/^- SKILL\.md$/m);
  });

  it("finds a skill by its bare name when only one has it", async () => {
    const { tool, client } = setup({ skills: SKILL });
    const text = await tool("databricks_skills_load").call({}, { name: "quarterly-revenue" });
    expect(text).toContain("Skill main.sales.quarterly-revenue:");
    await expect(tool("databricks_skills_load").call({}, { name: "nope" })).rejects.toThrow(/no skill named nope/);
  });

  it("reads files and cuts the total at the budget, saying what was left out", async () => {
    const big = "x".repeat(READ_BUDGET + 5_000);
    const { tool, client } = setup({ skills: { "main.sales.quarterly-revenue": { description: "d", body: md("quarterly-revenue", "d"), files: { "references/big.md": big, "references/tables.md": "# Tables" } } } });
    const text = await tool("databricks_skills_read_files").call({}, { name: "main.sales.quarterly-revenue", paths: ["references/big.md", "references/tables.md"] });
    expect(text.length).toBeLessThan(READ_BUDGET + 500);
    expect(text).toContain("=== references/big.md ===");
    expect(text).toContain("[Cut here: 5000 characters left out.]");
    expect(text).toContain("Not read, the 100 KB limit was reached: references/tables.md.");
  });

  it("reports a file it can't read without failing the others", async () => {
    const { tool, client } = setup({ skills: SKILL });
    const text = await tool("databricks_skills_read_files").call({}, { name: "main.sales.quarterly-revenue", paths: ["missing.md", "references/tables.md"] });
    expect(text).toContain("=== missing.md ===\n(Couldn't read it:");
    expect(text).toContain("=== references/tables.md ===\n# Tables");
  });

  it("refuses an empty list of paths", async () => {
    const { tool, client } = setup({ skills: SKILL });
    await expect(tool("databricks_skills_read_files").call({}, { name: "main.sales.quarterly-revenue", paths: [] })).rejects.toThrow(/at least one/);
  });
});

describe("databricks_skills_save", () => {
  const INSTRUCTIONS = "## Steps\n\n1. Use `main.sales.orders`\n\n```sql\nSELECT 1\n```\n\nSay \"done\".";

  it("returns a block that reads back as the same draft", async () => {
    const { tool, client } = setup();
    const text = await tool("databricks_skills_save").call(
      { channel: "c1" },
      { name: "Quarterly revenue (SQL)", description: "How to write quarterly revenue SQL.", instructions: INSTRUCTIONS, files: [{ path: "references/tables.md", content: "# Tables\n" }] },
    );
    expect(text).toContain("Nothing is published yet.");
    const block = /```databricks-skill\n([\s\S]*?)\n```/.exec(text);
    expect(block).not.toBeNull();
    const draft = parseDraft(block![1]!);
    expect(draft).toEqual({
      name: "quarterly-revenue-sql",
      description: "How to write quarterly revenue SQL.",
      instructions: INSTRUCTIONS,
      files: [{ path: "references/tables.md", content: "# Tables\n" }],
      schema: "main.sales",
    });
  });

  it("targets the channel's schema, then the person's default, then asks", async () => {
    const args = { name: "steps", description: "Steps.", instructions: "Do it." };
    const linked = setup({}, { skillsDefaultSchema: "main.hr" });
    expect(parseDraft(/```databricks-skill\n([\s\S]*?)\n```/.exec(await linked.tool("databricks_skills_save").call({ channel: "c1" }, args))![1]!).schema).toBe("main.sales");

    const preferred = setup({}, { skillsDefaultSchema: "main.hr" });
    expect(parseDraft(/```databricks-skill\n([\s\S]*?)\n```/.exec(await preferred.tool("databricks_skills_save").call({}, args))![1]!).schema).toBe("main.hr");

    const none = setup();
    const asked = await none.tool("databricks_skills_save").call({}, args);
    expect(asked).toContain("the card asks where to publish");
    expect(parseDraft(/```databricks-skill\n([\s\S]*?)\n```/.exec(asked)![1]!).schema).toBeUndefined();

    const explicit = setup({}, { skillsDefaultSchema: "main.hr" });
    expect(parseDraft(/```databricks-skill\n([\s\S]*?)\n```/.exec(await explicit.tool("databricks_skills_save").call({ channel: "c1" }, { ...args, schema: "main.hr" }))![1]!).schema).toBe("main.hr");
  });

  it("rejects a draft that can't be published", async () => {
    const { tool, client } = setup();
    const base = { name: "steps", description: "Steps.", instructions: "Do it." };
    await expect(tool("databricks_skills_save").call({}, { ...base, description: "" })).rejects.toThrow(/Add a description/);
    await expect(tool("databricks_skills_save").call({}, { ...base, files: [{ path: "../escape.md", content: "x" }] })).rejects.toThrow(/cannot contain/);
    await expect(tool("databricks_skills_save").call({}, { ...base, schema: "nodot" })).rejects.toThrow(/catalog\.schema/);
  });
});

describe("draft blocks", () => {
  it("reads a message's first heading as the title and its first sentence as the description", () => {
    const text = "# Quarterly revenue\n\nUse `samples.nyctaxi.trips`. Ask for totals by month.\n\nMore detail follows.";
    expect(draftFromText(text)).toEqual({ name: "quarterly-revenue", description: "Use samples.nyctaxi.trips.", instructions: text });
  });

  it("uses a short message's line as both title and description", () => {
    expect(draftFromText("Hi there")).toEqual({ name: "hi-there", description: "Hi there", instructions: "Hi there" });
  });

  it("explains a draft that isn't JSON yet", () => {
    expect(() => parseDraft('{"name": "x", "descr')).toThrow(/isn't valid JSON/);
  });

  it("checks names, descriptions and paths", () => {
    const draft: SkillDraft = { name: "ok-name", description: "d", instructions: "i", files: [] };
    expect(validateDraft(draft)).toBeUndefined();
    expect(validateDraft({ ...draft, name: "Not Valid" })).toMatch(/lowercase/);
    expect(validateDraft({ ...draft, instructions: " " })).toMatch(/instructions/);
  });

  it("round-trips a block with a fence inside the instructions", () => {
    const draft: SkillDraft = { name: "fenced", description: "d", instructions: "```\ncode\n```", files: [], schema: "main.sales" };
    const block = /```databricks-skill\n([\s\S]*?)\n```/.exec(draftBlock(draft));
    expect(parseDraft(block![1]!)).toEqual(draft);
  });
});

describe("publishing a draft", () => {
  const DRAFT: SkillDraft = {
    name: "quarterly-revenue",
    description: "Quarterly revenue numbers.",
    instructions: "# Revenue\n\nUse orders.",
    files: [{ path: "references/tables.md", content: "# Tables" }],
  };
  const DOMAINS = { "dom-1": { tag_key: "Sales/Pipeline" } };

  /** The skill, file, domain and tag requests, in order, as "METHOD path". */
  const sequence = (calls: { method: string; path: string }[]) =>
    calls
      .filter((call) => /^\/api\/2\.[01]\/(unity-catalog\/skills|fs\/files\/Skills|domains|unity-catalog\/entity-tag)/.test(call.path))
      .map((call) => `${call.method} ${call.path}`);

  it("creates the skill, uploads SKILL.md and the files, finalizes it, then tags it with the domain", async () => {
    const { workspace, fake, catalog } = setup({ domains: DOMAINS });
    await catalog.load();
    const start = workspace.calls.length;
    const published = await publishDraft(fake.service, catalog, DRAFT, "main.sales");
    expect(published).toMatchObject({ fullName: "main.sales.quarterly-revenue", schema: "main.sales", created: true, domain: { status: "tagged", tag: "Sales/Pipeline" } });
    expect(sequence(workspace.calls.slice(start))).toEqual([
      "POST /api/2.1/unity-catalog/skills",
      "PUT /api/2.0/fs/files/Skills/main/sales/quarterly-revenue/SKILL.md",
      "PUT /api/2.0/fs/files/Skills/main/sales/quarterly-revenue/references/tables.md",
      "POST /api/2.1/unity-catalog/skills/main.sales.quarterly-revenue/finalize",
      "GET /api/2.0/domains/dom-1",
      "POST /api/2.1/unity-catalog/entity-tag-assignments",
    ]);
    const skillMd = workspace.calls.find((call) => call.path.endsWith("/SKILL.md") && call.method === "PUT");
    expect(skillMd?.body).toContain('name: quarterly-revenue\ndescription: "Quarterly revenue numbers."');
    expect(workspace.assignments).toEqual([{ entity_type: "skills", entity_name: "main.sales.quarterly-revenue", tag_key: "Sales/Pipeline" }]);
  });

  it("refuses a name that's taken unless it's asked to replace it", async () => {
    const { workspace, fake, catalog } = setup({ skills: { "main.sales.quarterly-revenue": { description: "old", body: md("quarterly-revenue", "old") } } });
    await catalog.load();
    await expect(publishDraft(fake.service, catalog, DRAFT, "main.sales")).rejects.toSatisfy(isAlreadyExists);
    expect(workspace.calls.some((call) => call.method === "PUT")).toBe(false);

    const replaced = await publishDraft(fake.service, catalog, DRAFT, "main.sales", { replace: true });
    expect(replaced.created).toBe(false);
    expect(workspace.calls.some((call) => call.method === "DELETE")).toBe(false);
    expect(workspace.skills.get("main.sales.quarterly-revenue")?.description).toBe("Quarterly revenue numbers.");
  });

  it("publishes even when the domain tag can't be set, and says so", async () => {
    const { fake, catalog } = setup({ domains: DOMAINS, domainError: "Domains are unavailable" });
    await catalog.load();
    const published = await publishDraft(fake.service, catalog, DRAFT, "main.sales");
    expect(published.domain).toEqual({ status: "failed", error: "Domains are unavailable" });
    expect(published.created).toBe(true);
  });

  it("skips the domain step for a schema without a domain", async () => {
    const { workspace, fake, catalog } = setup({ tags: [["main", "hr", "agent_skills", "true"]] });
    await catalog.load();
    const start = workspace.calls.length;
    const published = await publishDraft(fake.service, catalog, DRAFT, "main.hr");
    expect(published.domain).toBeUndefined();
    expect(sequence(workspace.calls.slice(start)).some((call) => call.includes("domains") || call.includes("entity-tag"))).toBe(false);
  });

  it("shares a skill with read access", async () => {
    const { workspace, fake } = setup();
    await shareSkill(fake.service, "main.sales.quarterly-revenue", "analysts@example.com");
    expect(workspace.grants).toEqual([{ skill: "main.sales.quarterly-revenue", principal: "analysts@example.com", privileges: ["READ_VOLUME"] }]);
  });
});
