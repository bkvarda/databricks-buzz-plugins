// Unity Catalog skills (Beta): agent skills (a SKILL.md plus files) kept and
// governed in Unity Catalog under three-level names, catalog.schema.skill.
// https://docs.databricks.com/aws/en/ai-gateway/skill-reference
//
// A skill is created empty, its files are uploaded through the Files API under
// /Skills/<catalog>/<schema>/<skill>/, and finalize reads SKILL.md's
// frontmatter into bundle_name and description. Privileges are the volume
// ones: CREATE VOLUME on the schema to create, READ VOLUME to use (that's how
// a skill is shared), READ + WRITE VOLUME to update, MANAGE to delete.
//
// Finding skills: the API lists one schema at a time. The skills registry's
// MCP server (/ai-gateway/skills/?schema=a.b&schema=c.d) lists every skill in
// several schemas, with descriptions, in one call; which schemas to ask is
// found from schema tags (see ../skill-catalog.ts).
import { apiError, type DatabricksClient } from "../client";
import { McpClient, resultText } from "./mcp";

export type Skill = Readonly<{
  /** Resource name, `skills/<catalog>.<schema>.<skill>`. */
  name: string;
  /** From SKILL.md's frontmatter, set when finalized. */
  bundle_name?: string;
  description?: string;
  comment?: string;
  etag?: string;
  create_time?: string;
  update_time?: string;
  finalize_time?: string;
  effective_owner?: string;
  created_by?: string;
}>;

/** A skill as an agent needs it: its full name and when to use it. */
export type SkillRef = Readonly<{ fullName: string; description: string }>;

export type SkillFile = Readonly<{ path: string; content: string }>;

/** `catalog.schema.skill` from a resource name or a full name. */
export const skillFullName = (nameOrFull: string) => nameOrFull.replace(/^skills\//, "");

export function splitFullName(fullName: string): { catalog: string; schema: string; skill: string } {
  const parts = skillFullName(fullName).split(".");
  if (parts.length !== 3 || parts.some((part) => !part)) throw new Error(`A skill's full name is catalog.schema.skill, not "${fullName}".`);
  return { catalog: parts[0]!, schema: parts[1]!, skill: parts[2]! };
}

/** Skill IDs: lowercase letters, digits, hyphens and underscores, up to 64. */
export const validSkillId = (id: string) => /^[a-z0-9][a-z0-9_-]{0,63}$/.test(id);

/** A skill ID from a title: "Quarterly revenue (SQL)" → "quarterly-revenue-sql". */
export function skillIdFrom(text: string): string {
  const slug = text
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^\w\s-]/g, " ")
    .replace(/[\s_]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 64)
    .replace(/-$/, "");
  return slug || "skill";
}

const yamlString = (value: string) => JSON.stringify(value.replace(/\s+/g, " ").trim());

/** SKILL.md: YAML frontmatter with name and description, then the instructions. */
export function skillMarkdown(skill: Readonly<{ name: string; description: string; body: string }>): string {
  return `---\nname: ${skill.name}\ndescription: ${yamlString(skill.description)}\n---\n\n${skill.body.trim()}\n`;
}

/** Reads SKILL.md's name and description (plain or quoted values) and body. */
export function parseSkillMarkdown(text: string): { name?: string; description?: string; body: string } {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(text);
  if (!match) return { body: text };
  const fields: Record<string, string> = {};
  for (const line of match[1]!.split(/\r?\n/)) {
    const field = /^([A-Za-z_][\w-]*):\s*(.*)$/.exec(line);
    if (!field) continue;
    let value = field[2]!.trim();
    if (/^".*"$/.test(value)) {
      try {
        value = JSON.parse(value) as string;
      } catch {
        value = value.slice(1, -1);
      }
    } else if (/^'.*'$/.test(value)) value = value.slice(1, -1).replace(/''/g, "'");
    fields[field[1]!] = value;
  }
  return { ...(fields.name && { name: fields.name }), ...(fields.description && { description: fields.description }), body: match[2]!.replace(/^\s*\n/, "") };
}

/** Where a skill's files live in the Files API, each segment encoded. */
export function skillFilesPath(fullName: string, path = ""): string {
  const { catalog, schema, skill } = splitFullName(fullName);
  const clean = path.replace(/^\/+/, "");
  if (clean.split("/").some((part) => part === ".." || part === ".")) throw new Error("Skill file paths cannot contain . or ..");
  return ["Skills", catalog, schema, skill, ...clean.split("/").filter(Boolean)].map(encodeURIComponent).join("/");
}

/** Publishing to a name that's taken, without asking to replace it. Checked by `name`, across plugin bundles. */
export class SkillExistsError extends Error {
  override readonly name = "SkillExistsError";
  constructor(readonly fullName: string) {
    super(`There's already a skill named ${fullName}. Pick another name, or choose to replace it.`);
  }
}

export const isSkillExists = (error: unknown): error is SkillExistsError => error instanceof Error && error.name === "SkillExistsError";

/** Registry tools for skills in scope are named `skill_<full name>`. */
const SKILL_TOOL = /^skill_(.+\..+\..+)$/;

export class Skills {
  constructor(private readonly client: DatabricksClient) {}

  /** Every finalized and unfinalized skill in one schema. */
  async list(catalog: string, schema: string, signal?: AbortSignal): Promise<Skill[]> {
    const skills: Skill[] = [];
    let pageToken: string | undefined;
    for (let page = 0; page < 50; page++) {
      const response = await this.client.get<{ skills?: Skill[]; next_page_token?: string }>("/api/2.1/unity-catalog/skills", {
        query: { parent: `schemas/${catalog}.${schema}`, page_token: pageToken },
        ...(signal && { signal }),
      });
      skills.push(...(response.skills ?? []));
      pageToken = response.next_page_token;
      if (!pageToken) break;
    }
    return skills;
  }

  get(fullName: string, signal?: AbortSignal): Promise<Skill> {
    return this.client.get<Skill>(`/api/2.1/unity-catalog/skills/${skillFullName(fullName)}`, signal ? { signal } : {});
  }

  /** An empty skill; it can't be used until its files are uploaded and it's finalized. */
  create(catalog: string, schema: string, id: string, comment?: string): Promise<Skill> {
    if (!validSkillId(id)) throw new Error(`"${id}" isn't a valid skill name: use lowercase letters, digits, hyphens and underscores.`);
    return this.client.post<Skill>("/api/2.1/unity-catalog/skills", comment ? { comment } : {}, { query: { parent: `schemas/${catalog}.${schema}`, skill_id: id } });
  }

  async upload(fullName: string, file: SkillFile, signal?: AbortSignal): Promise<void> {
    const response = await this.client.request(`/api/2.0/fs/files/${skillFilesPath(fullName, file.path)}`, {
      method: "PUT",
      body: file.content,
      query: { overwrite: "true" },
      headers: { "Content-Type": "application/octet-stream" },
      timeoutMs: 60_000,
      ...(signal && { signal }),
    });
    if (response.status < 200 || response.status >= 300) throw apiError(response);
  }

  /** Checks SKILL.md and sets bundle_name and description from it. */
  finalize(fullName: string): Promise<Skill> {
    return this.client.post<Skill>(`/api/2.1/unity-catalog/skills/${skillFullName(fullName)}/finalize`, {});
  }

  /**
   * Creates the skill (or reuses one with that name), uploads its files and
   * finalizes it. SKILL.md is required. Files already there and not in
   * `files` are left alone.
   */
  async publish(
    target: Readonly<{ catalog: string; schema: string; id: string; comment?: string }>,
    files: readonly SkillFile[],
    options: Readonly<{ replace?: boolean; signal?: AbortSignal }> = {},
  ): Promise<{ skill: Skill; created: boolean }> {
    const markdown = files.find((file) => file.path.replace(/^\/+/, "") === "SKILL.md");
    if (!markdown) throw new Error("A skill needs a SKILL.md.");
    const parsed = parseSkillMarkdown(markdown.content);
    if (!parsed.name || !parsed.description) throw new Error("SKILL.md must start with frontmatter that sets name and description.");
    const fullName = `${target.catalog}.${target.schema}.${target.id}`;
    let created = false;
    try {
      await this.create(target.catalog, target.schema, target.id, target.comment);
      created = true;
    } catch (error) {
      const code = (error as { errorCode?: string; status?: number }).errorCode;
      if (code !== "ALREADY_EXISTS" && code !== "RESOURCE_ALREADY_EXISTS") throw error;
      if (!options.replace) throw new SkillExistsError(fullName);
    }
    try {
      for (const file of files) await this.upload(fullName, file, options.signal);
      return { skill: await this.finalize(fullName), created };
    } catch (error) {
      // A skill we just made but couldn't fill is useless: take it away again.
      if (created) await this.delete(fullName).catch(() => {});
      throw error;
    }
  }

  delete(fullName: string): Promise<unknown> {
    return this.client.json(`/api/2.1/unity-catalog/skills/${skillFullName(fullName)}`, { method: "DELETE" });
  }

  /** Every file's path, relative to the skill's folder. */
  async files(fullName: string, signal?: AbortSignal): Promise<string[]> {
    const root = `/${skillFilesPath(fullName)}/`;
    const found: string[] = [];
    const walk = async (relative: string, depth: number) => {
      let pageToken: string | undefined;
      do {
        const response = await this.client.get<{ contents?: { path: string; is_directory?: boolean }[]; next_page_token?: string }>(
          `/api/2.0/fs/directories/${skillFilesPath(fullName, relative)}/`,
          { query: { page_token: pageToken }, ...(signal && { signal }) },
        );
        for (const entry of response.contents ?? []) {
          const path = decodeURIComponent(entry.path.replace(/\/$/, "")).replace(decodeURIComponent(root), "");
          if (entry.is_directory) {
            if (depth < 6) await walk(path, depth + 1);
          } else found.push(path);
        }
        pageToken = response.next_page_token;
      } while (pageToken && found.length < 500);
    };
    await walk("", 0);
    return found.sort();
  }

  /** One file's text. */
  async read(fullName: string, path: string, signal?: AbortSignal): Promise<string> {
    const response = await this.client.request(`/api/2.0/fs/files/${skillFilesPath(fullName, path)}`, {
      method: "GET",
      headers: { Accept: "application/octet-stream" },
      timeoutMs: 60_000,
      ...(signal && { signal }),
    });
    if (response.status < 200 || response.status >= 300) throw apiError(response);
    return response.body;
  }

  /** Grants privileges on a skill, e.g. READ VOLUME to share it. */
  grant(fullName: string, principal: string, privileges: readonly string[] = ["READ_VOLUME"]): Promise<unknown> {
    return this.client.json(`/api/2.1/unity-catalog/permissions/skill/${skillFullName(fullName)}`, {
      method: "PATCH",
      body: { changes: [{ principal, add: privileges }] },
    });
  }

  /**
   * Every finalized skill in these schemas, from one registry call (chunked
   * for long lists). A schema that doesn't exist or isn't readable is skipped
   * by the registry, not an error.
   */
  async registry(schemas: readonly string[], signal?: AbortSignal): Promise<SkillRef[]> {
    const found = new Map<string, SkillRef>();
    for (let start = 0; start < schemas.length; start += 40) {
      const query = schemas
        .slice(start, start + 40)
        .map((schema) => `schema=${encodeURIComponent(schema)}`)
        .join("&");
      const mcp = new McpClient(this.client, `/ai-gateway/skills/?${query}`, this.client.workspaceId ? { o: this.client.workspaceId } : {});
      for (const tool of await mcp.listTools(signal)) {
        const match = SKILL_TOOL.exec(tool.name);
        if (!match) continue;
        const fullName = match[1]!;
        found.set(fullName, { fullName, description: (tool.description ?? "").replace(/^\[[^\]]*\]\s*/, "").trim() });
      }
    }
    return [...found.values()].sort((a, b) => a.fullName.localeCompare(b.fullName));
  }

  /** SKILL.md as the registry serves it to agents, ready to follow. */
  async load(fullName: string, signal?: AbortSignal): Promise<string> {
    const mcp = new McpClient(this.client, "/ai-gateway/skills/", this.client.workspaceId ? { o: this.client.workspaceId } : {});
    const result = await mcp.callTool("load_skill", { full_name: skillFullName(fullName) }, signal ? { signal } : {});
    if (result.isError) throw new Error(resultText(result) || `Couldn't load ${fullName}.`);
    return resultText(result);
  }
}

/** Ranks skills for a query: name matches first, then description words. */
export function searchSkills(skills: readonly SkillRef[], query: string, limit = 20): SkillRef[] {
  const words = query
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((word) => word.length > 1);
  if (!words.length) return skills.slice(0, limit);
  const scored = skills.map((skill) => {
    const leaf = skill.fullName.split(".").pop()!.toLowerCase();
    const where = skill.fullName.toLowerCase();
    const text = skill.description.toLowerCase();
    let score = 0;
    if (leaf === words.join("-")) score += 20;
    for (const word of words) {
      if (leaf.includes(word)) score += 6;
      else if (where.includes(word)) score += 3;
      if (new RegExp(`\\b${word}`).test(text)) score += 2;
      else if (text.includes(word)) score += 1;
    }
    return { skill, score };
  });
  return scored
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score || a.skill.fullName.localeCompare(b.skill.fullName))
    .slice(0, limit)
    .map((entry) => entry.skill);
}
