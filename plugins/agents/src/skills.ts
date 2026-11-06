// Unity Catalog skills for Databricks agents. An agent's skills are its own
// picks, every skill in the schemas it picked, and the skills of its channel's
// schema. A built-in Sandbox agent loads them with two tools; Claude Code,
// Codex, Pi and hosted agents find them in their own skill folders, which
// ./skills-sandbox.ts keeps in step with this list.
import { type SkillRef, Skills } from "@dbx/core/api/skills";
import type { DatabricksService } from "@dbx/core/service";
import { describeError } from "@dbx/core/service";
import { type CatalogState, SkillCatalog, schemaOf } from "@dbx/core/skill-catalog";
import type { LocalTool } from "./loop";

/** What an agent's settings choose. Schemas are `catalog.schema`; names are full skill names. */
export type SkillsChoice = Readonly<{ schemas?: readonly string[]; names?: readonly string[]; channel?: boolean }>;

/** The stored choice, cleaned: always all three fields. */
export type SkillsConfig = { schemas: string[]; names: string[]; channel: boolean };

const SCHEMA = /^[^.\s]+\.[^.\s]+$/;
const SKILL = /^[^.\s]+\.[^.\s]+\.[^.\s]+$/;

/** Validates a saved choice. Channel skills are on unless turned off. */
export function normalizeSkills(value: unknown): SkillsConfig {
  const choice = (value ?? {}) as SkillsChoice;
  const clean = (list: unknown, pattern: RegExp) => [
    ...new Set(Array.isArray(list) ? list.filter((item): item is string => typeof item === "string" && pattern.test(item)) : []),
  ];
  return { schemas: clean(choice.schemas, SCHEMA), names: clean(choice.names, SKILL), channel: choice.channel !== false };
}

// One catalog per workspace and profile, so every form and turn shares its loads.
const catalogs = new WeakMap<DatabricksService, Map<string, SkillCatalog>>();

/** The skill catalog of an agent's workspace (its own profile, or Buzz's connection). */
export function skillCatalogFor(service: DatabricksService, profile: string | undefined): SkillCatalog {
  let byProfile = catalogs.get(service);
  if (!byProfile) catalogs.set(service, (byProfile = new Map()));
  const key = profile ?? "";
  let catalog = byProfile.get(key);
  if (!catalog) byProfile.set(key, (catalog = new SkillCatalog(profile && service.forProfile ? service.forProfile(profile) : service)));
  return catalog;
}

/** What resolution needs from a catalog: the skills it can see, and a channel's. */
export interface SkillSource {
  load(): Promise<CatalogState>;
  channelSkills(channelId: string): Promise<readonly SkillRef[]>;
}

export type ResolvedSkills = Readonly<{ skills: readonly SkillRef[]; problems: readonly string[] }>;

/**
 * An agent's skills for one turn: the names it picked, every skill in the
 * schemas it picked, and (when the channel setting is on and the turn's
 * channel is known) the skills of that channel's schema. Each skill appears
 * once. Problems don't stop the turn; they're reported.
 */
export async function resolveSkills(source: SkillSource, choice: SkillsConfig, channelId?: string): Promise<ResolvedSkills> {
  const problems: string[] = [];
  const state = await source.load();
  if (state.error) problems.push(state.error);
  else if (state.note) problems.push(state.note);
  const byName = new Map(state.skills.map((skill) => [skill.fullName, skill]));
  const picked = new Map<string, SkillRef>();
  for (const name of choice.names) {
    const skill = byName.get(name);
    if (skill) picked.set(name, skill);
    else if (!state.error) problems.push(`${name} isn't available to you`);
  }
  const schemas = new Set(choice.schemas);
  for (const skill of state.skills) if (schemas.has(schemaOf(skill.fullName))) picked.set(skill.fullName, skill);
  if (choice.channel && channelId) {
    try {
      for (const skill of await source.channelSkills(channelId)) picked.set(skill.fullName, skill);
    } catch (error) {
      problems.push(`Couldn't load this channel's skills: ${describeError(error)}`);
    }
  }
  return { skills: [...picked.values()].sort((a, b) => a.fullName.localeCompare(b.fullName)), problems };
}

const LISTED = 40;
const NAMES_LISTED = 100;
const DESCRIPTION_MAX = 200;

const shorten = (text: string, max: number) => {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
};

/** The system prompt's skills section; empty when there are none. Long lists keep descriptions for the first few and names for the rest. */
export function skillsSection(skills: readonly SkillRef[]): string {
  if (!skills.length) return "";
  const listed = skills.slice(0, LISTED).map((skill) => `- ${skill.fullName}: ${shorten(skill.description, DESCRIPTION_MAX) || "(no description)"}`);
  const rest = skills.slice(LISTED);
  const more = rest.length
    ? `Also available, without descriptions: ${rest
        .slice(0, NAMES_LISTED)
        .map((skill) => skill.fullName)
        .join(", ")}${rest.length > NAMES_LISTED ? `, and ${rest.length - NAMES_LISTED} more` : ""}.`
    : "";
  return [
    "<databricks-skills>",
    "These skills are written instructions for particular kinds of work. Before you follow one, load it with skills_load, using its full name, and follow what it says. When it points to other files, read them with skills_read_files.",
    ...listed,
    more,
    "</databricks-skills>",
  ]
    .filter(Boolean)
    .join("\n");
}

/** A harness is told the skills are installed where it looks for them, so it can use one whenever it fits. */
export function skillsNote(skills: readonly SkillRef[]): string {
  return skills.length
    ? "Your owner's skills are installed in your Sandbox's skill folders. When one matches the task, follow its instructions."
    : "";
}

/** What the skill tools need from the Skills API. */
export type SkillApi = Pick<Skills, "load" | "files" | "read">;

const FILE_CHARS = 12_000;
const NAMES_IN_ERRORS = 60;

const clipText = (text: string, max: number) => (text.length > max ? `${text.slice(0, max)}\n… (${text.length - max} characters cut)` : text);

/**
 * The model loop's two skill tools: `skills_load` gives a skill's SKILL.md
 * and lists its other files; `skills_read_files` reads some of them. Only
 * the resolved skills can be used, and only the files a skill lists.
 */
export function skillTools(api: (signal: AbortSignal) => Promise<SkillApi>, skills: readonly SkillRef[]): LocalTool[] {
  const byName = new Map(skills.map((skill) => [skill.fullName, skill]));
  const find = (raw: unknown): SkillRef | string => {
    const name = typeof raw === "string" ? raw.trim() : "";
    const found = byName.get(name);
    if (found) return found;
    const names = [...byName.keys()].slice(0, NAMES_IN_ERRORS);
    return `There is no skill named "${name}". Your skills are: ${names.join(", ") || "none"}.`;
  };
  const nameParameter = { type: "string", description: "The skill's full name, as listed in your skills." };
  return [
    {
      name: "skills_load",
      description: "Loads one of your skills: its SKILL.md instructions, and the names of its other files. Load a skill before you follow it.",
      parameters: { type: "object", properties: { name: nameParameter }, required: ["name"] },
      async run(args, signal) {
        const found = find(args.name);
        if (typeof found === "string") return found;
        const skills = await api(signal);
        const [markdown, files] = await Promise.all([skills.load(found.fullName, signal), skills.files(found.fullName, signal).catch(() => [] as string[])]);
        const others = files.filter((path) => path !== "SKILL.md");
        return [
          clipText(markdown.trim(), 20_000),
          others.length ? `Other files in this skill (read them with skills_read_files): ${others.join(", ")}` : "",
        ]
          .filter(Boolean)
          .join("\n\n");
      },
    },
    {
      name: "skills_read_files",
      description: "Reads some of a skill's files, such as the ones its SKILL.md points to. Pass the skill's full name and the file paths that skills_load listed.",
      parameters: {
        type: "object",
        properties: { name: nameParameter, paths: { type: "array", items: { type: "string" }, description: "Up to 10 file paths, relative to the skill." } },
        required: ["name", "paths"],
      },
      async run(args, signal) {
        const found = find(args.name);
        if (typeof found === "string") return found;
        const wanted = (Array.isArray(args.paths) ? args.paths : [args.paths])
          .filter((path): path is string => typeof path === "string" && path.length > 0)
          .slice(0, 10);
        if (!wanted.length) return "Pass the paths of the files to read.";
        const skills = await api(signal);
        const files = new Set(await skills.files(found.fullName, signal));
        const parts: string[] = [];
        for (const path of wanted) {
          if (!files.has(path)) {
            parts.push(`${path}: not a file in ${found.fullName}`);
            continue;
          }
          parts.push(`=== ${path} ===\n${clipText(await skills.read(found.fullName, path, signal), FILE_CHARS)}`);
        }
        return parts.join("\n\n");
      },
    },
  ];
}
