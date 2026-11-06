// Skill drafts: the JSON an agent (or a message) turns into, carried in a
// ```databricks-skill fence so the conversation shows it as a card. Nothing
// here publishes; the card's Publish button does that.
import { skillFilesPath, skillIdFrom, skillMarkdown, type SkillFile, validSkillId } from "@dbx/core/api/skills";

/** The code block language agents post drafts under. */
export const DRAFT_LANGUAGE = "databricks-skill";

/** The person's default schema for publishing, a preference on this device. */
export const DEFAULT_SCHEMA_PREF = "skillsDefaultSchema";

/** SKILL.md is written from name, description and instructions; a file of that name is ignored. */
const SKILL_FILE = "SKILL.md";

export type SkillDraft = Readonly<{
  /** The skill's ID, which is also its name in SKILL.md. */
  name: string;
  description: string;
  instructions: string;
  files: readonly SkillFile[];
  /** `catalog.schema` to publish into; the card asks when it's missing. */
  schema?: string;
}>;

export const validSchemaName = (value: string) => /^[^.\s]+\.[^.\s]+$/.test(value);

const text = (value: unknown) => (typeof value === "string" ? value : "");

/** The fenced block an agent posts. Newlines inside JSON strings are escaped, so the fence can't close early. */
export function draftBlock(draft: SkillDraft): string {
  const body = {
    name: draft.name,
    description: draft.description,
    instructions: draft.instructions,
    ...(draft.files.length && { files: draft.files }),
    ...(draft.schema && { schema: draft.schema }),
  };
  return `\`\`\`${DRAFT_LANGUAGE}\n${JSON.stringify(body, null, 2)}\n\`\`\``;
}

/** Reads a draft's JSON. Lenient about missing fields so a card can still show what's there. */
export function parseDraft(source: string): SkillDraft {
  let value: unknown;
  try {
    value = JSON.parse(source.trim());
  } catch {
    throw new Error("This skill draft isn't valid JSON yet.");
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("A skill draft is a JSON object.");
  const record = value as Record<string, unknown>;
  const files = Array.isArray(record.files)
    ? record.files.flatMap((file) => {
        const entry = file as Record<string, unknown> | null;
        return entry && typeof entry.path === "string" && typeof entry.content === "string" ? [{ path: entry.path, content: entry.content }] : [];
      })
    : [];
  const schema = text(record.schema).trim();
  return {
    name: text(record.name).trim() || text(record.id).trim(),
    description: text(record.description).trim(),
    instructions: text(record.instructions).trim(),
    files,
    ...(schema && { schema }),
  };
}

/** The problem with a draft as it stands, or undefined when it can be published. */
export function validateDraft(draft: SkillDraft): string | undefined {
  if (!validSkillId(draft.name)) return "The name can use lowercase letters, digits, hyphens and underscores, up to 64 characters.";
  if (!draft.description.trim()) return "Add a description so agents know when to use the skill.";
  if (!draft.instructions.trim()) return "Add the instructions.";
  for (const file of draft.files) {
    try {
      skillFilesPath("catalog.schema.skill", file.path);
    } catch (error) {
      return error instanceof Error ? error.message : String(error);
    }
  }
  return undefined;
}

/** The files to upload: SKILL.md written from the draft, then the others. */
export function skillFiles(draft: SkillDraft): SkillFile[] {
  const others = draft.files.filter((file) => file.path.replace(/^\/+/, "") !== SKILL_FILE);
  return [{ path: SKILL_FILE, content: skillMarkdown({ name: draft.name, description: draft.description, body: draft.instructions }) }, ...others];
}

const clip = (value: string, max: number) => (value.length > max ? `${value.slice(0, max - 1).trimEnd()}…` : value);

/**
 * A starting draft from a chat message: the first heading (or else the first
 * line) is the title, and the first sentence of the rest is the description.
 */
export function draftFromText(source: string): Pick<SkillDraft, "name" | "description" | "instructions"> {
  const body = source.trim();
  const lines = body.split(/\r?\n/);
  const heading = lines.findIndex((line) => /^#{1,6}\s+\S/.test(line));
  const at = heading >= 0 ? heading : lines.findIndex((line) => line.trim());
  const title = clip(lines[at]?.replace(/^(#{1,6}\s+|[>*\-\s]+)/, "").trim() ?? "", 80) || "Untitled skill";
  const rest = lines
    .filter((_, index) => index !== at)
    .join("\n")
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/[*_`>#]+/g, "")
    .replace(/\s+/g, " ")
    .trim();
  const sentence = rest.split(/(?<=[.!?])\s+/).find(Boolean) ?? title;
  // A heading names the skill as written; a first line only lends its first
  // few words, so the name stays short enough to read and type.
  const words = title.replace(/[`*]/g, "").split(/\s+/).filter(Boolean);
  let name = skillIdFrom(heading >= 0 ? title : words.slice(0, 5).join(" "));
  if (name.length > 40) name = name.slice(0, name.lastIndexOf("-", 40) > 0 ? name.lastIndexOf("-", 40) : 40);
  return { name: name || "skill", description: clip(sentence, 200), instructions: body };
}
