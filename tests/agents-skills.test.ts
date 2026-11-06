import { describe, expect, it } from "vitest";
import type { Skill, SkillRef } from "@dbx/core/api/skills";
import type { CatalogState } from "@dbx/core/skill-catalog";
import { normalizeHosted } from "../plugins/agents/src/hosted";
import { normalizeDatabricks } from "../plugins/agents/src/types";
import { normalizeSkills, resolveSkills, type SkillSource, skillsSection, skillTools } from "../plugins/agents/src/skills";
import { folderOf, installSkills, planSync, SKILL_ROOTS, SKILLS_MANIFEST, type SkillsApi, versionOf } from "../plugins/agents/src/skills-sandbox";

const ref = (fullName: string, description = `${fullName} does things`): SkillRef => ({ fullName, description });

const catalog = (skills: SkillRef[], extra: Partial<CatalogState> = {}): CatalogState => ({
  status: "ready",
  schemas: [],
  skills,
  at: Date.now(),
  ...extra,
});

/** A catalog that knows these skills, and these channel schemas. */
function source(state: CatalogState, channels: Record<string, SkillRef[]> = {}): SkillSource & { asked: string[] } {
  const asked: string[] = [];
  return {
    asked,
    load: async () => state,
    channelSkills: async (channelId) => {
      asked.push(channelId);
      return channels[channelId] ?? [];
    },
  };
}

describe("skill settings", () => {
  it("defaults to no picks and the channel's skills on", () => {
    expect(normalizeSkills(undefined)).toEqual({ schemas: [], names: [], channel: true });
    expect(normalizeSkills({ schemas: [] })).toEqual({ schemas: [], names: [], channel: true });
    expect(normalizeDatabricks({ kind: "sandbox" }).skills).toEqual({ schemas: [], names: [], channel: true });
    expect(normalizeHosted({}).skills).toEqual({ schemas: [], names: [], channel: true });
  });

  it("keeps valid picks once, drops malformed ones, and respects channel off", () => {
    expect(
      normalizeSkills({
        schemas: ["main.skills", "main.skills", "nope", "a.b.c", 7],
        names: ["main.skills.sql-tips", "main.skills", "x.y", "main.skills.sql-tips"],
        channel: false,
      }),
    ).toEqual({ schemas: ["main.skills"], names: ["main.skills.sql-tips"], channel: false });
  });
});

describe("resolving a turn's skills", () => {
  it("combines names, whole schemas and the channel's schema, each skill once", async () => {
    const state = catalog([ref("main.skills.sql-tips"), ref("main.skills.charts"), ref("main.team.runbook"), ref("main.ops.deploy")]);
    const found = await resolveSkills(
      source(state, { C1: [ref("main.ops.deploy"), ref("main.ops.rollback")] }),
      { schemas: ["main.skills"], names: ["main.skills.sql-tips", "main.team.runbook"], channel: true },
      "C1",
    );
    expect(found.skills.map((skill) => skill.fullName)).toEqual(["main.ops.deploy", "main.ops.rollback", "main.skills.charts", "main.skills.sql-tips", "main.team.runbook"]);
    expect(found.problems).toEqual([]);
  });

  it("skips the channel when it's off or unknown, and asks only for the turn's channel", async () => {
    const state = catalog([ref("main.ops.deploy")]);
    const off = source(state, { C1: [ref("main.ops.deploy")] });
    expect((await resolveSkills(off, { schemas: [], names: [], channel: false }, "C1")).skills).toEqual([]);
    expect(off.asked).toEqual([]);
    const on = source(state, { C1: [ref("main.ops.deploy")] });
    expect((await resolveSkills(on, { schemas: [], names: [], channel: true }, undefined)).skills).toEqual([]);
    expect(on.asked).toEqual([]);
  });

  it("reports names it can't see, and a catalog error, without failing", async () => {
    const missing = await resolveSkills(source(catalog([ref("main.skills.a")])), { schemas: [], names: ["main.skills.gone"], channel: true });
    expect(missing.skills).toEqual([]);
    expect(missing.problems).toEqual(["main.skills.gone isn't available to you"]);
    const failed = await resolveSkills(source(catalog([], { status: "error", error: "Warehouse is down" })), { schemas: [], names: ["main.skills.gone"], channel: true });
    expect(failed.problems).toEqual(["Warehouse is down"]);
  });

  it("passes on a catalog note (no warehouse) and a failed channel lookup", async () => {
    const failing: SkillSource = {
      load: async () => catalog([ref("main.skills.a")], { note: "Couldn't look for tagged skills schemas: no warehouse" }),
      channelSkills: async () => {
        throw new Error("channel lookup failed");
      },
    };
    const found = await resolveSkills(failing, { schemas: ["main.skills"], names: [], channel: true }, "C9");
    expect(found.skills.map((skill) => skill.fullName)).toEqual(["main.skills.a"]);
    expect(found.problems).toEqual(["Couldn't look for tagged skills schemas: no warehouse", "Couldn't load this channel's skills: channel lookup failed"]);
  });
});

describe("the skills section", () => {
  it("is empty without skills", () => {
    expect(skillsSection([])).toBe("");
  });

  it("lists each skill with a trimmed description and says to load it first", () => {
    const section = skillsSection([ref("main.skills.sql-tips", "  Writes   SQL\nfor reports. "), ref("main.skills.charts", "x".repeat(300))]);
    expect(section.split("\n")[0]).toBe("<databricks-skills>");
    expect(section).toContain("load it with skills_load, using its full name, and follow what it says");
    expect(section).toContain("- main.skills.sql-tips: Writes SQL for reports.");
    const long = section.split("\n").find((line) => line.startsWith("- main.skills.charts:"))!;
    expect(long.length).toBeLessThanOrEqual("- main.skills.charts: ".length + 200);
    expect(long.endsWith("…")).toBe(true);
    expect(section.endsWith("</databricks-skills>")).toBe(true);
  });

  it("lists names only beyond forty skills, and says how many more there are", () => {
    const many = Array.from({ length: 150 }, (_, index) => ref(`main.skills.s${index}`, "d"));
    const section = skillsSection(many);
    expect(section.match(/^- /gm)).toHaveLength(40);
    expect(section).toContain("Also available, without descriptions: main.skills.s40, ");
    expect(section).toContain("and 10 more.");
  });
});

describe("the model loop's skill tools", () => {
  const files: Record<string, string[]> = { "main.skills.sql-tips": ["SKILL.md", "references/style.md", "examples/a.sql"] };
  const api = async () => ({
    load: async (fullName: string) => `---\nname: x\ndescription: y\n---\n# ${fullName}\nDo it.`,
    files: async (fullName: string) => files[fullName] ?? [],
    read: async (_fullName: string, path: string) => `contents of ${path}`,
  });
  const tools = skillTools(api, [ref("main.skills.sql-tips")]);
  const byName = (name: string) => tools.find((tool) => tool.name === name)!;
  const signal = new AbortController().signal;

  it("offers skills_load and skills_read_files", () => {
    expect(tools.map((tool) => tool.name)).toEqual(["skills_load", "skills_read_files"]);
    expect(byName("skills_read_files").parameters).toMatchObject({ required: ["name", "paths"] });
  });

  it("loads SKILL.md and lists the other files", async () => {
    const text = await byName("skills_load").run({ name: "main.skills.sql-tips" }, signal);
    expect(text).toContain("# main.skills.sql-tips");
    expect(text).toContain("Other files in this skill (read them with skills_read_files): references/style.md, examples/a.sql");
    expect(text).not.toContain("SKILL.md, ");
  });

  it("only loads the chosen skills", async () => {
    expect(await byName("skills_load").run({ name: "main.skills.other" }, signal)).toMatch(/There is no skill named "main.skills.other". Your skills are: main.skills.sql-tips/);
  });

  it("reads only the files a skill lists", async () => {
    const text = await byName("skills_read_files").run({ name: "main.skills.sql-tips", paths: ["references/style.md", "../../etc/passwd"] }, signal);
    expect(text).toContain("=== references/style.md ===\ncontents of references/style.md");
    expect(text).toContain("../../etc/passwd: not a file in main.skills.sql-tips");
  });
});

describe("planning a Sandbox sync", () => {
  const want = (skill: string, folder: string, version = "v1") => ({ skill, folder, version });

  it("adds what's new, updates what changed, keeps what's the same, removes what's no longer chosen", () => {
    const plan = planSync(
      [want("main.skills.a", "a", "v2"), want("main.skills.b", "b", "v1"), want("main.skills.c", "c", "v1")],
      { a: { skill: "main.skills.a", version: "v1" }, b: { skill: "main.skills.b", version: "v1" }, old: { skill: "main.skills.old", version: "v1" } },
      new Set(["a", "b", "old"]),
    );
    expect(plan.add.map((item) => item.folder)).toEqual(["c"]);
    expect(plan.update.map((item) => item.folder)).toEqual(["a"]);
    expect(plan.unchanged.map((item) => item.folder)).toEqual(["b"]);
    expect(plan.remove).toEqual(["old"]);
    expect(plan.skipped).toEqual([]);
  });

  it("never touches a folder Buzz didn't install", () => {
    const plan = planSync([want("main.skills.a", "a")], {}, new Set(["a", "mine-by-hand"]));
    expect(plan.add).toEqual([]);
    expect(plan.skipped).toEqual([{ skill: "main.skills.a", reason: "a folder named a is already there, and Buzz didn't install it" }]);
    expect(plan.remove).toEqual([]);
  });

  it("installs again when Buzz's folder has gone", () => {
    const plan = planSync([want("main.skills.a", "a")], { a: { skill: "main.skills.a", version: "v1" } }, new Set());
    expect(plan.add.map((item) => item.folder)).toEqual(["a"]);
  });

  it("gives a folder to one skill, and says so for the other", () => {
    const plan = planSync([want("main.one.x", "x"), want("main.two.x", "x")], {}, new Set());
    expect(plan.add.map((item) => item.skill)).toEqual(["main.one.x"]);
    expect(plan.skipped[0]!.reason).toMatch(/already uses the folder x/);
  });

  it("names folders after their bundle, and versions from the skill's times", () => {
    expect(folderOf("main.skills.sql-tips", "sql-tips")).toBe("sql-tips");
    expect(folderOf("main.skills.sql-tips")).toBe("sql-tips");
    expect(folderOf("main.skills.x", "../escape")).toBeUndefined();
    expect(versionOf({ name: "skills/main.skills.a", update_time: "2026-01-02", finalize_time: "2026-01-01" } as Skill)).toBe("2026-01-02|2026-01-01");
  });
});

/** A Sandbox that keeps files in memory and answers the few shell commands the sync runs. */
function fakeSandbox(initial: Record<string, string> = {}) {
  const files = new Map(Object.entries(initial));
  const scripts: string[] = [];
  const quoted = (script: string) => [...script.matchAll(/'([^']*)'/g)].map((match) => match[1]!);
  return {
    files,
    scripts,
    sandboxes: {
      async writeFile(_sandbox: string, path: string, contents: string, _signal?: AbortSignal) {
        files.set(path, contents);
      },
      async bash(_sandbox: string, script: string) {
        scripts.push(script);
        if (script.startsWith("cat ")) return { exit_code: 0, stdout: files.get(quoted(script)[0]!) ?? "" };
        if (script.startsWith("rm -rf")) {
          for (const path of quoted(script))
            for (const key of [...files.keys()]) if (key === path || key.startsWith(`${path}/`)) files.delete(key);
          return { exit_code: 0, stdout: "" };
        }
        // `ls -1A 'root' …; echo @@` per root
        const out = SKILL_ROOTS.map((root) => {
          const names = new Set<string>();
          for (const key of files.keys()) if (key.startsWith(`${root}/`)) names.add(key.slice(root.length + 1).split("/")[0]!);
          return `${[...names].join("\n")}${names.size ? "\n" : ""}@@buzz-skills@@\n`;
        }).join("");
        return { exit_code: 0, stdout: out };
      },
    },
  };
}

/** The Skills API for two skills, with versions the test can change. */
function fakeApi(versions: Record<string, { bundle?: string; update: string; files: Record<string, string> }>) {
  const reads: string[] = [];
  const api: SkillsApi = {
    async list(catalog, schema) {
      return Object.entries(versions)
        .filter(([fullName]) => fullName.startsWith(`${catalog}.${schema}.`))
        .map(([fullName, value]) => ({ name: `skills/${fullName}`, bundle_name: value.bundle ?? fullName.split(".").pop(), update_time: value.update }) as Skill);
    },
    async files(fullName) {
      return Object.keys(versions[fullName]!.files);
    },
    async read(fullName, path) {
      reads.push(`${fullName}:${path}`);
      return versions[fullName]!.files[path]!;
    },
  };
  return { api, reads };
}

describe("installing skills in the Sandbox", () => {
  const sql = "main.skills.sql-tips";
  const runbook = "main.ops.runbook";
  const folderPath = (root: string, folder: string) => `${root}/${folder}`;

  it("writes each chosen skill's files into both skill folders and records them", async () => {
    const { api } = fakeApi({ [sql]: { update: "t1", files: { "SKILL.md": "---\n---\nSQL", "references/a.md": "A" } } });
    const box = fakeSandbox();
    const result = await installSkills({ sandboxes: box.sandboxes, sandbox: "s1", api, skills: [ref(sql)] });
    expect(result.added).toEqual([sql]);
    for (const root of SKILL_ROOTS) {
      expect(box.files.get(folderPath(root, "sql-tips/SKILL.md"))).toBe("---\n---\nSQL");
      expect(box.files.get(folderPath(root, "sql-tips/references/a.md"))).toBe("A");
    }
    const manifest = JSON.parse(box.files.get(SKILLS_MANIFEST)!);
    expect(manifest.roots[SKILL_ROOTS[0]]).toEqual({ "sql-tips": { skill: sql, version: "t1" } });
  });

  it("does nothing when nothing changed: no writes, no manifest rewrite", async () => {
    const { api } = fakeApi({ [sql]: { update: "t1", files: { "SKILL.md": "x" } } });
    const box = fakeSandbox();
    await installSkills({ sandboxes: box.sandboxes, sandbox: "s2", api, skills: [ref(sql)] });
    const before = new Map(box.files);
    const writes = { count: 0 };
    const counting = {
      ...box.sandboxes,
      writeFile: async (sandbox: string, path: string, contents: string, signal?: AbortSignal) => {
        writes.count++;
        return box.sandboxes.writeFile(sandbox, path, contents, signal);
      },
    };
    const again = await installSkills({ sandboxes: counting, sandbox: "s2", api, skills: [ref(sql)] });
    expect(again.unchanged).toEqual([sql]);
    expect(writes.count).toBe(0);
    expect(box.files).toEqual(before);
  });

  it("replaces a changed skill's folder, dropping files the new version lost", async () => {
    const versions: Record<string, { update: string; files: Record<string, string> }> = { [sql]: { update: "t1", files: { "SKILL.md": "v1", "old.md": "gone soon" } } };
    const { api } = fakeApi(versions);
    const box = fakeSandbox();
    await installSkills({ sandboxes: box.sandboxes, sandbox: "s3", api, skills: [ref(sql)] });
    versions[sql] = { update: "t2", files: { "SKILL.md": "v2" } };
    const { api: next } = fakeApi(versions);
    const result = await installSkills({ sandboxes: box.sandboxes, sandbox: "s3", api: next, skills: [ref(sql)] });
    expect(result.updated).toEqual([sql]);
    expect(box.files.get(folderPath(SKILL_ROOTS[0], "sql-tips/SKILL.md"))).toBe("v2");
    expect(box.files.has(folderPath(SKILL_ROOTS[0], "sql-tips/old.md"))).toBe(false);
  });

  it("removes only the skills Buzz installed that are no longer chosen", async () => {
    const { api } = fakeApi({ [sql]: { update: "t1", files: { "SKILL.md": "x" } }, [runbook]: { update: "t1", files: { "SKILL.md": "y" } } });
    const box = fakeSandbox();
    await installSkills({ sandboxes: box.sandboxes, sandbox: "s4", api, skills: [ref(sql), ref(runbook)] });
    const removal = await installSkills({ sandboxes: box.sandboxes, sandbox: "s4", api, skills: [ref(sql)] });
    expect(removal.removed).toEqual([runbook]);
    for (const root of SKILL_ROOTS) {
      expect(box.files.has(folderPath(root, "runbook/SKILL.md"))).toBe(false);
      expect(box.files.has(folderPath(root, "sql-tips/SKILL.md"))).toBe(true);
    }
  });

  it("never removes or overwrites a folder Buzz didn't install", async () => {
    const { api } = fakeApi({ [sql]: { update: "t1", files: { "SKILL.md": "from unity catalog" } } });
    const box = fakeSandbox({ [folderPath(SKILL_ROOTS[0], "sql-tips/SKILL.md")]: "made by hand", [folderPath(SKILL_ROOTS[1], "by-hand/SKILL.md")]: "mine" });
    const result = await installSkills({ sandboxes: box.sandboxes, sandbox: "s5", api, skills: [ref(sql)] });
    expect(box.files.get(folderPath(SKILL_ROOTS[0], "sql-tips/SKILL.md"))).toBe("made by hand");
    // The Claude Code folder is someone else's, so that root is left alone; the agents root is free and gets the skill.
    expect(result.problems).toEqual([`main.skills.sql-tips isn't installed: a folder named sql-tips is already there, and Buzz didn't install it`]);
    expect(result.added).toEqual([sql]);
    expect(box.files.get(folderPath(SKILL_ROOTS[1], "sql-tips/SKILL.md"))).toBe("from unity catalog");
    const later = await installSkills({ sandboxes: box.sandboxes, sandbox: "s5", api, skills: [] });
    expect(later.removed).toEqual([sql]);
    expect(box.files.get(folderPath(SKILL_ROOTS[0], "sql-tips/SKILL.md"))).toBe("made by hand");
    expect(box.files.has(folderPath(SKILL_ROOTS[1], "sql-tips/SKILL.md"))).toBe(false);
    expect(box.files.get(folderPath(SKILL_ROOTS[1], "by-hand/SKILL.md"))).toBe("mine");
  });

  it("makes no calls to the Sandbox when nothing is chosen and nothing was installed", async () => {
    const { api } = fakeApi({});
    const box = fakeSandbox();
    const result = await installSkills({ sandboxes: box.sandboxes, sandbox: "s6", api, skills: [] });
    expect(result).toEqual({ added: [], updated: [], removed: [], unchanged: [], problems: [] });
    expect(box.scripts).toEqual([`cat '${SKILLS_MANIFEST}' 2>/dev/null; true`]);
  });

  it("reports a skill whose files can't be read, and leaves it out of the manifest", async () => {
    const { api } = fakeApi({ [sql]: { update: "t1", files: { "SKILL.md": "x" } } });
    const broken: SkillsApi = { ...api, read: async () => Promise.reject(new Error("read failed")) };
    const box = fakeSandbox();
    const result = await installSkills({ sandboxes: box.sandboxes, sandbox: "s7", api: broken, skills: [ref(sql)] });
    expect(result.added).toEqual([]);
    expect(result.problems).toEqual([`Couldn't install ${sql}: read failed`]);
    expect(box.files.has(folderPath(SKILL_ROOTS[0], "sql-tips/SKILL.md"))).toBe(false);
    expect(JSON.parse(box.files.get(SKILLS_MANIFEST) ?? '{"roots":{}}').roots[SKILL_ROOTS[0]] ?? {}).toEqual({});
  });
});
