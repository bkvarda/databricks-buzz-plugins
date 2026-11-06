// Puts an agent's skills where Claude Code, Codex and Pi look for them inside
// its Sandbox: ~/.claude/skills (Claude Code) and ~/.agents/skills (the alias
// Codex and Pi read; Unity Gateway's downloader writes both). A skill's folder
// is named for its bundle, as the downloader names it, so the agent reads it
// under the name its SKILL.md gives.
//
// Buzz keeps a manifest in the Sandbox of what it installed, per root. A sync
// adds, updates or removes only the folders the manifest lists: a folder that
// is already there and not in the manifest belongs to someone else and is left
// alone. Versions come from the skills' update and finalize times (and etag),
// so a turn with nothing new to install writes nothing.
import { type Skill, type SkillRef, skillFullName } from "@dbx/core/api/skills";
import { SANDBOX_HOME, type Sandboxes } from "@dbx/core/api/sandbox";
import { describeError } from "@dbx/core/service";
import { schemaOf } from "@dbx/core/skill-catalog";
import { shellQuote } from "./remote";

/** Where the harnesses look for skills, under the Sandbox's home. */
export const SKILL_ROOTS = [`${SANDBOX_HOME}/.claude/skills`, `${SANDBOX_HOME}/.agents/skills`] as const;
/** The manifest of what Buzz installed, per root. Only Buzz writes it. */
export const SKILLS_MANIFEST = `${SANDBOX_HOME}/.buzz/skills/manifest.json`;

const SEPARATOR = "@@buzz-skills@@";
const FOLDER = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/;
const FILES_MAX = 300;

export type Installed = Readonly<{ skill: string; version: string }>;
/** Installed skills by folder name, per root. */
export type Manifest = { roots: Record<string, Record<string, Installed>> };

export type Desired = Readonly<{ skill: string; folder: string; version: string }>;

export type SyncPlan = {
  add: Desired[];
  update: Desired[];
  unchanged: Desired[];
  /** Folders Buzz installed earlier that are no longer chosen. */
  remove: string[];
  /** Skills that can't be installed here, and why. */
  skipped: { skill: string; reason: string }[];
};

/** A skill's folder name: its bundle name, else the last part of its full name. */
export function folderOf(skill: string, bundle?: string): string | undefined {
  const name = bundle || skill.split(".").pop() || "";
  return FOLDER.test(name) && !name.includes("..") ? name : undefined;
}

/** A version that changes whenever the skill does. */
export const versionOf = (skill: Skill) => [skill.etag, skill.update_time, skill.finalize_time].filter(Boolean).join("|") || "unversioned";

/**
 * What to do with each chosen skill, given what Buzz installed earlier
 * (`installed`, by folder) and which folders exist (`present`). Pure, so the
 * rules can be tested without a Sandbox.
 */
export function planSync(desired: readonly Desired[], installed: Readonly<Record<string, Installed>>, present: ReadonlySet<string>): SyncPlan {
  const plan: SyncPlan = { add: [], update: [], unchanged: [], remove: [], skipped: [] };
  const taken = new Set<string>();
  for (const item of desired) {
    if (taken.has(item.folder)) {
      plan.skipped.push({ skill: item.skill, reason: `another skill already uses the folder ${item.folder}` });
      continue;
    }
    taken.add(item.folder);
    const mine = installed[item.folder];
    if (!present.has(item.folder)) plan.add.push(item);
    else if (!mine) plan.skipped.push({ skill: item.skill, reason: `a folder named ${item.folder} is already there, and Buzz didn't install it` });
    else if (mine.skill !== item.skill || mine.version !== item.version) plan.update.push(item);
    else plan.unchanged.push(item);
  }
  for (const folder of Object.keys(installed)) if (!taken.has(folder)) plan.remove.push(folder);
  return plan;
}

/** The Skills API calls a sync makes. */
export type SkillsApi = Readonly<{
  list(catalog: string, schema: string, signal?: AbortSignal): Promise<Skill[]>;
  files(fullName: string, signal?: AbortSignal): Promise<string[]>;
  read(fullName: string, path: string, signal?: AbortSignal): Promise<string>;
}>;

export type SyncResult = {
  added: string[];
  updated: string[];
  removed: string[];
  unchanged: string[];
  problems: string[];
};

const safePath = (path: string) => path.length > 0 && !path.startsWith("/") && !path.split("/").some((part) => part === "" || part === "." || part === "..");

function parseManifest(text: string): Manifest {
  try {
    const parsed = JSON.parse(text) as { roots?: Record<string, Record<string, Installed>> };
    const roots: Manifest["roots"] = {};
    for (const [root, entries] of Object.entries(parsed?.roots ?? {})) {
      roots[root] = {};
      for (const [folder, entry] of Object.entries(entries ?? {}))
        if (FOLDER.test(folder) && typeof entry?.skill === "string" && typeof entry.version === "string") roots[root][folder] = { skill: entry.skill, version: entry.version };
    }
    return { roots };
  } catch {
    return { roots: {} };
  }
}

/** Writes one skill's files into a root, replacing nothing else. A failed write leaves no folder behind. */
async function writeSkill(sandboxes: Pick<Sandboxes, "bash" | "writeFile">, sandbox: string, api: SkillsApi, root: string, item: Desired, signal?: AbortSignal) {
  const dir = `${root}/${item.folder}`;
  const files = (await api.files(item.skill, signal)).filter(safePath);
  if (!files.includes("SKILL.md")) throw new Error("it has no SKILL.md");
  if (files.length > FILES_MAX) throw new Error(`it has more than ${FILES_MAX} files`);
  try {
    for (const path of files) await sandboxes.writeFile(sandbox, `${dir}/${path}`, await api.read(item.skill, path, signal), signal);
  } catch (error) {
    await sandboxes.bash(sandbox, `rm -rf -- ${shellQuote(dir)}`, { timeoutSeconds: 30 }).catch(() => {});
    throw error;
  }
}

/** One sync at a time per Sandbox, so two turns never write the manifest together. */
const queues = new Map<string, Promise<unknown>>();

/**
 * Makes the Sandbox's skill folders match `skills`: installs the new and
 * changed ones, removes the ones Buzz installed that aren't chosen any more,
 * and writes the manifest when anything changed. Problems are reported in the
 * result; they don't throw.
 */
export function installSkills(input: {
  sandboxes: Pick<Sandboxes, "bash" | "writeFile">;
  sandbox: string;
  api: SkillsApi;
  skills: readonly SkillRef[];
  signal?: AbortSignal;
}): Promise<SyncResult> {
  const previous = queues.get(input.sandbox) ?? Promise.resolve();
  const next = previous.catch(() => {}).then(() => syncOnce(input));
  queues.set(input.sandbox, next);
  return next;
}

async function syncOnce({ sandboxes, sandbox, api, skills, signal }: Parameters<typeof installSkills>[0]): Promise<SyncResult> {
  // Per skill, not per root: a skill installed in both roots is reported once.
  const outcome = { added: new Set<string>(), updated: new Set<string>(), removed: new Set<string>(), unchanged: new Set<string>(), problems: new Set<string>() };
  const timeout = { timeoutSeconds: 60, ...(signal && { signal }) };
  const before = await sandboxes.bash(sandbox, `cat ${shellQuote(SKILLS_MANIFEST)} 2>/dev/null; true`, timeout);
  const manifest = parseManifest(before.stdout ?? "");
  const hasInstalled = Object.values(manifest.roots).some((entries) => Object.keys(entries).length > 0);
  // Nothing chosen and nothing installed: nothing to do, and no call to the Sandbox.
  if (!skills.length && !hasInstalled) return { added: [], updated: [], removed: [], unchanged: [], problems: [] };

  // Which folders exist now, per root (only needed when something is chosen).
  const present = new Map<string, Set<string>>();
  if (skills.length) {
    const listing = await sandboxes.bash(
      sandbox,
      SKILL_ROOTS.map((root) => `ls -1A ${shellQuote(root)} 2>/dev/null; echo ${SEPARATOR}`).join("\n"),
      timeout,
    );
    const parts = (listing.stdout ?? "").split(`${SEPARATOR}\n`);
    SKILL_ROOTS.forEach((root, index) => present.set(root, new Set((parts[index] ?? "").split("\n").map((line) => line.trim()).filter(Boolean))));
  }

  // Each chosen skill's folder and version, from its schema's listing.
  const versions = new Map<string, { bundle?: string; version: string }>();
  const failed = new Set<string>();
  const schemas = [...new Set(skills.map((skill) => schemaOf(skill.fullName)))];
  await Promise.all(
    schemas.map(async (schema) => {
      const [catalog, name] = schema.split(".") as [string, string];
      try {
        for (const skill of await api.list(catalog, name, signal)) versions.set(skillFullName(skill.name), { ...(skill.bundle_name && { bundle: skill.bundle_name }), version: versionOf(skill) });
      } catch (error) {
        failed.add(schema);
        outcome.problems.add(`Couldn't check the skills in ${schema}: ${describeError(error)}`);
      }
    }),
  );
  const desired: Desired[] = [];
  for (const skill of skills) {
    const info = versions.get(skill.fullName);
    if (!info) {
      if (!failed.has(schemaOf(skill.fullName))) outcome.problems.add(`${skill.fullName} isn't listed in its schema`);
      continue;
    }
    const folder = folderOf(skill.fullName, info.bundle);
    if (!folder) {
      outcome.problems.add(`${skill.fullName} has no folder name the agent can use`);
      continue;
    }
    desired.push({ skill: skill.fullName, folder, version: info.version });
  }

  const next: Manifest = { roots: {} };
  for (const root of SKILL_ROOTS) {
    const installed = manifest.roots[root] ?? {};
    const plan = planSync(desired, installed, present.get(root) ?? new Set());
    for (const skipped of plan.skipped) outcome.problems.add(`${skipped.skill} isn't installed: ${skipped.reason}`);
    const kept: Record<string, Installed> = {};
    for (const item of plan.unchanged) {
      kept[item.folder] = { skill: item.skill, version: item.version };
      outcome.unchanged.add(item.skill);
    }
    // Folders being replaced or removed go first, so a file a newer version dropped doesn't linger.
    const gone = [...plan.remove, ...plan.update.map((item) => item.folder)].filter((folder) => FOLDER.test(folder));
    const cleared = gone.length
      ? await sandboxes.bash(sandbox, `rm -rf -- ${gone.map((folder) => shellQuote(`${root}/${folder}`)).join(" ")}`, timeout)
      : { exit_code: 0 };
    const clearFailed = (cleared.exit_code ?? 0) !== 0;
    for (const folder of plan.remove) {
      if (clearFailed) kept[folder] = installed[folder]!;
      else outcome.removed.add(installed[folder]?.skill ?? folder);
    }
    for (const item of [...plan.add, ...plan.update]) {
      const isUpdate = plan.update.includes(item);
      try {
        await writeSkill(sandboxes, sandbox, api, root, item, signal);
        kept[item.folder] = { skill: item.skill, version: item.version };
        (isUpdate ? outcome.updated : outcome.added).add(item.skill);
      } catch (error) {
        outcome.problems.add(`Couldn't install ${item.skill}: ${describeError(error)}`);
      }
    }
    next.roots[root] = kept;
  }

  const changed = JSON.stringify(next) !== JSON.stringify(manifest);
  if (changed) await sandboxes.writeFile(sandbox, SKILLS_MANIFEST, `${JSON.stringify(next, null, 2)}\n`, signal);
  return {
    added: [...outcome.added],
    updated: [...outcome.updated],
    removed: [...outcome.removed],
    unchanged: [...outcome.unchanged],
    problems: [...outcome.problems],
  };
}
