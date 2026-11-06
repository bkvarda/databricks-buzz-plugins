// Core skills: the SKILL.md format, IDs and search, the Files API paths, and
// SkillCatalog's discovery (tags from SQL, the registry over MCP, added
// schemas, channel links, and resets on a workspace switch).
import { describe, expect, it } from "vitest";
import { parseSkillMarkdown, searchSkills, skillFilesPath, skillIdFrom, skillMarkdown, validSkillId } from "@dbx/core/api/skills";
import { SkillCatalog } from "@dbx/core/skill-catalog";
import { fakeService, fakeWorkspace } from "./fake-workspace";

describe("SKILL.md", () => {
  it("round-trips quotes, colons and newlines in the description", () => {
    const description = 'Use for: "fare" questions, tips: 10% of fares.\nOnly NYC.';
    const body = "# Fares\n\nUse `samples.nyctaxi.trips`.\n\n- fare_amount is in dollars";
    const text = skillMarkdown({ name: "trip-fares", description, body });
    const parsed = parseSkillMarkdown(text);
    expect(parsed.name).toBe("trip-fares");
    expect(parsed.description).toBe('Use for: "fare" questions, tips: 10% of fares. Only NYC.');
    expect(parsed.body.trim()).toBe(body);
  });

  it("reads plain and single-quoted frontmatter values", () => {
    const parsed = parseSkillMarkdown("---\nname: plain-name\ndescription: 'It''s: fine'\n---\n\nBody here\n");
    expect(parsed.name).toBe("plain-name");
    expect(parsed.description).toBe("It's: fine");
    expect(parsed.body).toBe("Body here\n");
  });

  it("treats text without frontmatter as the body", () => {
    expect(parseSkillMarkdown("just text")).toEqual({ body: "just text" });
  });
});

describe("skill IDs", () => {
  it("makes an ID from a title", () => {
    expect(skillIdFrom("Quarterly revenue (SQL)")).toBe("quarterly-revenue-sql");
    expect(skillIdFrom("  Trip_fares  ")).toBe("trip-fares");
    expect(skillIdFrom("!!!")).toBe("skill");
    expect(skillIdFrom("x".repeat(80))).toHaveLength(64);
  });

  it("accepts only lowercase letters, digits, hyphens and underscores", () => {
    expect(validSkillId("trip-fares_2")).toBe(true);
    expect(validSkillId("Trip")).toBe(false);
    expect(validSkillId("-leading")).toBe(false);
    expect(validSkillId("has space")).toBe(false);
  });
});

describe("searchSkills", () => {
  const skills = [
    { fullName: "main.sales.quarterly-revenue", description: "Quarterly revenue numbers by region." },
    { fullName: "main.hr.revenue-policy", description: "Expense policy." },
    { fullName: "main.team.standup", description: "Notes for the daily standup." },
  ];

  it("ranks a name match above a description match", () => {
    expect(searchSkills(skills, "revenue").map((skill) => skill.fullName)).toEqual(["main.sales.quarterly-revenue", "main.hr.revenue-policy"]);
  });

  it("matches on description words and drops what matches nothing", () => {
    expect(searchSkills(skills, "standup notes").map((skill) => skill.fullName)).toEqual(["main.team.standup"]);
    expect(searchSkills(skills, "weather")).toEqual([]);
  });

  it("returns the first skills for an empty query, up to the limit", () => {
    expect(searchSkills(skills, "", 2)).toHaveLength(2);
  });
});

describe("skillFilesPath", () => {
  it("encodes each segment of the Files API path", () => {
    expect(skillFilesPath("main.sales.rev", "references/my file.md")).toBe("Skills/main/sales/rev/references/my%20file.md");
    expect(skillFilesPath("main.sales.rev")).toBe("Skills/main/sales/rev");
  });

  it("drops a leading slash and rejects . and .. segments", () => {
    expect(skillFilesPath("main.sales.rev", "/SKILL.md")).toBe("Skills/main/sales/rev/SKILL.md");
    expect(() => skillFilesPath("main.sales.rev", "../other/SKILL.md")).toThrow(/cannot contain \. or \.\./);
    expect(() => skillFilesPath("main.sales.rev", "a/./b.md")).toThrow(/cannot contain \. or \.\./);
  });
});

describe("SkillCatalog", () => {
  const TAGS: [string, string, string, string][] = [
    ["main", "sales", "agent_skills", "true"],
    ["main", "sales", "buzz_channel", "c1"],
    ["main", "sales", "buzz_domain", "dom-1"],
    // Only a domain tag: not a skills schema.
    ["main", "hr", "buzz_domain", "dom-2"],
  ];
  const SKILLS = {
    "main.sales.quarterly-revenue": { description: "Quarterly revenue numbers.", body: "---\nname: quarterly-revenue\ndescription: Quarterly revenue numbers.\n---\n\n# Revenue\n" },
    "main.extra.glossary": { description: "Glossary of terms.", body: "---\nname: glossary\ndescription: Glossary of terms.\n---\n\n# Terms\n" },
  };

  it("finds tagged schemas with one SQL query, keeps added ones, and lists skills from the registry", async () => {
    const workspace = fakeWorkspace({ tags: TAGS, skills: SKILLS });
    const { service } = fakeService(workspace.client, { skillLocations: ["main.extra"] });
    const catalog = new SkillCatalog(service);
    const state = await catalog.load();

    expect(state.status).toBe("ready");
    expect(state.note).toBeUndefined();
    expect(state.schemas.map((entry) => [entry.schema, entry.source])).toEqual([
      ["main.extra", "added"],
      ["main.sales", "tag"],
    ]);
    expect(state.schemas[1]!.tags).toEqual({ agent_skills: "true", buzz_channel: "c1", buzz_domain: "dom-1" });
    expect(state.skills.map((skill) => [skill.fullName, skill.description])).toEqual([
      ["main.extra.glossary", "Glossary of terms."],
      ["main.sales.quarterly-revenue", "Quarterly revenue numbers."],
    ]);

    const statement = workspace.calls.find((call) => call.path === "/api/2.0/sql/statements");
    expect(statement?.body.statement).toContain("system.information_schema.schema_tags");
    const registry = workspace.calls.find((call) => call.path.startsWith("/ai-gateway/skills/?"));
    expect(new URL(registry!.path, "https://w.example").searchParams.getAll("schema")).toEqual(["main.extra", "main.sales"]);
  });

  it("finds the channel's schema and its skills", async () => {
    const workspace = fakeWorkspace({ tags: TAGS, skills: SKILLS });
    const catalog = new SkillCatalog(fakeService(workspace.client).service);
    expect(await catalog.channel("c1")).toEqual({ schema: "main.sales", channelId: "c1", domainId: "dom-1" });
    expect(await catalog.channel("c2")).toBeUndefined();
    expect((await catalog.channelSkills("c1")).map((skill) => skill.fullName)).toEqual(["main.sales.quarterly-revenue"]);
  });

  it("still lists added schemas, with a note, when there is no warehouse", async () => {
    const workspace = fakeWorkspace({ tags: TAGS, skills: SKILLS, noWarehouse: true });
    const { service } = fakeService(workspace.client, { skillLocations: ["main.extra"] });
    const state = await new SkillCatalog(service).load();
    expect(state.note).toMatch(/Couldn't look for tagged skills schemas: No SQL warehouse/);
    expect(state.schemas.map((entry) => entry.schema)).toEqual(["main.extra"]);
    expect(state.skills.map((skill) => skill.fullName)).toEqual(["main.extra.glossary"]);
  });

  it("forgets its schemas and skills when the workspace changes", async () => {
    const workspace = fakeWorkspace({ tags: TAGS, skills: SKILLS });
    const fake = fakeService(workspace.client);
    const catalog = new SkillCatalog(fake.service);
    await catalog.load();
    expect(catalog.snapshot().skills).toHaveLength(1);
    fake.switchTo("https://other.example");
    expect(catalog.snapshot()).toMatchObject({ status: "idle", schemas: [], skills: [] });
  });
});
