// Publishing a reviewed draft as the signed-in person: the skill is created,
// its files uploaded and it's finalized (Skills.publish). Then, best-effort,
// it takes the governed tag of its schema's domain, and it can be shared
// with read access. Nothing is elevated: every call uses the person's client.
import type { DatabricksClient } from "@dbx/core/client";
import { Domains } from "@dbx/core/api/domains";
import { isSkillExists, Skills, splitFullName } from "@dbx/core/api/skills";
import { DOMAIN_TAG, Tags } from "@dbx/core/api/tags";
import { type DatabricksService, describeError } from "@dbx/core/service";
import type { SkillCatalog } from "@dbx/core/skill-catalog";
import { type SkillDraft, skillFiles, validateDraft, validSchemaName } from "./skill-draft";

export type DomainTag = Readonly<{ status: "tagged"; tag: string }> | Readonly<{ status: "failed"; error: string }>;

export type Published = Readonly<{
  /** `catalog.schema.skill`. */
  fullName: string;
  schema: string;
  created: boolean;
  /** Set when the schema belongs to a domain: whether its governed tag went on. */
  domain?: DomainTag;
  /** Principals the skill was shared with in this session. */
  shared: readonly string[];
}>;

/** Skills.publish's error when the name is taken and `replace` wasn't asked for. */
export const isAlreadyExists = isSkillExists;

/** The domain ID on a schema the catalog found, if it belongs to one. */
export function domainIdOf(catalog: SkillCatalog, schema: string): string | undefined {
  return catalog.snapshot().schemas.find((entry) => entry.schema === schema)?.tags[DOMAIN_TAG];
}

/** Tags a skill with its domain's governed tag. Failure is reported, never thrown. */
export async function tagDomain(client: DatabricksClient, fullName: string, domainId: string): Promise<DomainTag> {
  try {
    const domain = await new Domains(client).get(domainId);
    await new Tags(client).assign("skills", fullName, domain.tag_key);
    return { status: "tagged", tag: domain.tag_key };
  } catch (error) {
    return { status: "failed", error: describeError(error) };
  }
}

/** Publishes a draft into `schema` (`catalog.schema`). Throws with a message for the person when it can't. */
export async function publishDraft(
  service: DatabricksService,
  catalog: SkillCatalog,
  draft: SkillDraft,
  schema: string,
  options: Readonly<{ replace?: boolean }> = {},
): Promise<Published> {
  const problem = validateDraft(draft) ?? (validSchemaName(schema) ? undefined : "Choose the schema to publish into, as catalog.schema.");
  if (problem) throw new Error(problem);
  const client = await service.ready();
  const [catalogName, schemaName] = schema.split(".") as [string, string];
  const { created } = await new Skills(client).publish({ catalog: catalogName, schema: schemaName, id: draft.name }, skillFiles(draft), {
    replace: options.replace,
  });
  const fullName = `${catalogName}.${schemaName}.${draft.name}`;
  const domainId = domainIdOf(catalog, schema);
  const domain = domainId ? await tagDomain(client, fullName, domainId) : undefined;
  void catalog.load(true);
  return { fullName, schema, created, ...(domain && { domain }), shared: [] };
}

/** Gives a principal (a user or group) read access to a skill: READ VOLUME, the privilege that shares a skill. */
export async function shareSkill(service: DatabricksService, fullName: string, principal: string): Promise<void> {
  splitFullName(fullName);
  await new Skills(await service.ready()).grant(fullName, principal, ["READ_VOLUME"]);
}
