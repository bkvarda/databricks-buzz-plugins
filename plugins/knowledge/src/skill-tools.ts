// Skill tools for every agent: search and load the team's skills, read their
// other files, and draft a new one for a person to publish. Agents never
// publish: a draft is a block the agent posts, and the person reviews it.
import { type SkillFile, Skills, searchSkills, skillFullName, skillIdFrom, splitFullName, validSkillId } from "@dbx/core/api/skills";
import { type AgentTool, numberArg, schema, stringArg } from "@dbx/core/host-types";
import { type DatabricksService, describeError } from "@dbx/core/service";
import type { CatalogState, SkillCatalog } from "@dbx/core/skill-catalog";
import { DEFAULT_SCHEMA_PREF, draftBlock, type SkillDraft, validateDraft, validSchemaName } from "./skill-draft";

/** How much text read_files returns in one call (characters, a cheap stand-in for bytes). */
export const READ_BUDGET = 100_000;
const MAX_PATHS = 20;
const MAX_DRAFT_FILES = 30;
const MAX_FILE_CHARS = 200_000;

const SETTINGS_PLACE = "Settings → Databricks Knowledge";

/** A skill's full name from `catalog.schema.skill`, or a bare skill name when only one skill has it. */
async function resolveSkill(catalog: SkillCatalog, name: string): Promise<string> {
  if (name.includes(".")) {
    splitFullName(name);
    return skillFullName(name);
  }
  const state = await catalog.load();
  const matches = state.skills.filter((skill) => skill.fullName.split(".").pop() === name);
  if (matches.length === 1) return matches[0]!.fullName;
  if (!matches.length) throw new Error(`There's no skill named ${name} in the skills schemas. Search for it first.`);
  throw new Error(`${matches.length} skills are called ${name}: ${matches.map((skill) => skill.fullName).join(", ")}. Use the full catalog.schema.${name} name.`);
}

function nothingFound(query: string, state: CatalogState): string {
  const count = new Set(state.schemas.map((entry) => entry.schema)).size;
  const where = count ? `Searched ${count} skills schema${count === 1 ? "" : "s"}.` : "No skills schemas were found.";
  const trouble = state.note ?? state.error;
  return [
    `No skills match "${query}".`,
    where,
    trouble,
    `Skills schemas are schemas tagged agent_skills, or ones added in ${SETTINGS_PLACE}.`,
  ]
    .filter(Boolean)
    .join(" ");
}

function parseFiles(value: unknown): SkillFile[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw new Error("files must be a list of {path, content}.");
  if (value.length > MAX_DRAFT_FILES) throw new Error(`A draft can have at most ${MAX_DRAFT_FILES} files.`);
  return value.map((entry) => {
    const file = entry as Record<string, unknown> | null;
    if (!file || typeof file.path !== "string" || typeof file.content !== "string") throw new Error("Each file needs a path and content.");
    if (file.content.length > MAX_FILE_CHARS) throw new Error(`${file.path} is over ${MAX_FILE_CHARS.toLocaleString()} characters; split it up.`);
    return { path: file.path.trim(), content: file.content };
  });
}

export function skillTools(service: DatabricksService, catalog: SkillCatalog): AgentTool[] {
  return [
    {
      name: "databricks_skills_search",
      description:
        "Searches the team's skills in Unity Catalog and returns matches as full names with what each is for. Skills are instructions for a task, such as how to answer a kind of question or run a process. Search before doing a task that a skill might cover. Skills from the channel you're in come first when they match.",
      inputSchema: schema.object(
        { query: schema.string("What the task is about, in a few words."), limit: schema.integer("Most results to return (default 10, max 50).") },
        ["query"],
      ),
      async call(_client, context, args) {
        const query = stringArg(args, "query");
        const limit = numberArg(args, "limit", 10, 1, 50);
        const state = await catalog.load();
        const here = context.channel ? await catalog.channelSkills(context.channel) : [];
        const first = searchSkills(here, query, limit);
        const taken = new Set(first.map((skill) => skill.fullName));
        const rest = searchSkills(
          state.skills.filter((skill) => !taken.has(skill.fullName)),
          query,
          limit - first.length,
        );
        const found = [...first, ...rest];
        if (!found.length) return nothingFound(query, state);
        return found.map((skill) => `- ${skill.fullName}${skill.description ? ` — ${skill.description}` : ""}`).join("\n");
      },
    },
    {
      name: "databricks_skills_load",
      description:
        "Loads a skill's SKILL.md: the instructions to follow for the task. Also lists the skill's other files, which databricks_skills_read_files reads. Pass the full catalog.schema.skill name from a search.",
      inputSchema: schema.object({ name: schema.string("The skill's full name, catalog.schema.skill.") }, ["name"]),
      async call(_client, _context, args) {
        const fullName = await resolveSkill(catalog, stringArg(args, "name"));
        const skills = new Skills(await service.ready());
        const instructions = await skills.load(fullName);
        let others: string[] = [];
        let note = "";
        try {
          others = (await skills.files(fullName)).filter((path) => path !== "SKILL.md");
        } catch (error) {
          note = `\n\n(Couldn't list its other files: ${describeError(error)})`;
        }
        const list = others.length ? `\n\nOther files in ${fullName} (read them with databricks_skills_read_files):\n${others.map((path) => `- ${path}`).join("\n")}` : "";
        return `Skill ${fullName}:\n\n${instructions.trim()}${list}${note}`;
      },
    },
    {
      name: "databricks_skills_read_files",
      description: `Reads other files from a skill, such as references or scripts, by their paths from databricks_skills_load. Returns at most about ${READ_BUDGET / 1000} KB per call; anything over is cut and says so.`,
      inputSchema: {
        type: "object",
        properties: {
          name: schema.string("The skill's full name, catalog.schema.skill."),
          paths: { type: "array", items: { type: "string" }, description: `Relative file paths, up to ${MAX_PATHS}.` },
        },
        required: ["name", "paths"],
        additionalProperties: false,
      },
      async call(_client, _context, args) {
        const fullName = await resolveSkill(catalog, stringArg(args, "name"));
        const paths = Array.isArray(args.paths)
          ? args.paths.filter((path): path is string => typeof path === "string").map((path) => path.trim()).filter(Boolean)
          : [];
        if (!paths.length) throw new Error("paths needs at least one file path from databricks_skills_load.");
        if (paths.length > MAX_PATHS) throw new Error(`Read at most ${MAX_PATHS} files at a time.`);
        const skills = new Skills(await service.ready());
        let budget = READ_BUDGET;
        const parts: string[] = [];
        const skipped: string[] = [];
        for (const path of paths) {
          if (budget <= 0) {
            skipped.push(path);
            continue;
          }
          let text: string;
          try {
            text = await skills.read(fullName, path);
          } catch (error) {
            parts.push(`=== ${path} ===\n(Couldn't read it: ${describeError(error)})`);
            continue;
          }
          const body = text.slice(0, budget);
          budget -= body.length;
          const cut = body.length < text.length ? `\n[Cut here: ${text.length - body.length} characters left out.]` : "";
          parts.push(`=== ${path} ===\n${body}${cut}`);
        }
        if (skipped.length) parts.push(`Not read, the ${READ_BUDGET / 1000} KB limit was reached: ${skipped.join(", ")}. Ask for them in another call.`);
        return parts.join("\n\n");
      },
    },
    {
      name: "databricks_skills_draft",
      description:
        "Drafts a new skill from what you learned in this conversation, for the person to review and publish. This does NOT publish anything: it returns a databricks-skill block. Post that block exactly as it is in your reply; the person sees it as a card, edits it if needed, and publishes it from the card. Write instructions an agent can follow alone: the steps, the rules, the tables and the checks. The target schema defaults to the channel's skills schema.",
      inputSchema: schema.object(
        {
          name: schema.string("Short name for the skill, e.g. quarterly-revenue. Lowercase letters, digits, hyphens."),
          description: schema.string("One sentence on when to use the skill."),
          instructions: schema.string("The skill's instructions in Markdown."),
          files: {
            type: "array",
            description: "Optional supporting files, e.g. references or examples.",
            items: {
              type: "object",
              properties: { path: { type: "string", description: "Relative path, e.g. references/tables.md" }, content: { type: "string" } },
              required: ["path", "content"],
              additionalProperties: false,
            },
          },
          schema: schema.string("Optional catalog.schema to publish into. Leave it out to use the channel's skills schema."),
        },
        ["name", "description", "instructions"],
      ),
      async call(_client, context, args) {
        const name = stringArg(args, "name");
        const explicit = stringArg(args, "schema", false);
        if (explicit && !validSchemaName(explicit)) throw new Error("schema must be catalog.schema.");
        const target = explicit || (await channelOrDefault(catalog, service, context.channel));
        const draft: SkillDraft = {
          name: validSkillId(name) ? name : skillIdFrom(name),
          description: stringArg(args, "description", false),
          instructions: stringArg(args, "instructions", false),
          files: parseFiles(args.files),
          ...(target && { schema: target }),
        };
        const problem = validateDraft(draft);
        if (problem) throw new Error(problem);
        const where = target ? `Publishes to ${target}.` : "No schema is set, so the card asks where to publish.";
        return `Drafted ${draft.name}. ${where} Nothing is published yet.\n\n${draftBlock(draft)}\n\nPost that block as it is in your reply.`;
      },
    },
  ];
}

/** The channel's skills schema, else the person's default for publishing. */
async function channelOrDefault(catalog: SkillCatalog, service: DatabricksService, channel: string | undefined): Promise<string | undefined> {
  if (channel) {
    const link = await catalog.channel(channel);
    if (link) return link.schema;
  }
  const preferred = service.preferences.get<string>(DEFAULT_SCHEMA_PREF);
  return preferred && validSchemaName(preferred) ? preferred : undefined;
}
