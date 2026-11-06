// Setting up a Buzz channel: a domain (picked or created), a skills schema
// (picked or created), the tags that link them, and optional access for one
// group or user. Every step runs as the signed-in person and reports its own
// result. A step Databricks refuses says what to ask an admin for, with the
// GRANT to copy. Running it again is safe: existing domains and schemas are
// reused and tags are set again, so missing ones are added.
import type { DatabricksClient } from "@dbx/core/client";
import { Domains, type Domain } from "@dbx/core/api/domains";
import { CHANNEL_TAG, DOMAIN_TAG, SKILLS_TAG, Tags } from "@dbx/core/api/tags";
import { describeError, isApiError } from "@dbx/core/service";
import { alreadyExists, ensureTagPolicy, tagPolicyLimit } from "./domain-api";

export type StepStatus = "done" | "skipped" | "denied" | "failed";

export type SetupStep = Readonly<{
  id: string;
  title: string;
  status: StepStatus;
  /** What happened, or for a refused step, what to ask for. */
  detail?: string;
  /** A GRANT or CREATE an admin can run, for a refused step. */
  sql?: string;
}>;

export type DomainPick = Readonly<{ mode: "existing"; id: string; tagKey: string; title: string }>;
export type DomainNew = Readonly<{ mode: "new"; title: string; description?: string; parent?: Readonly<{ id: string; tagKey: string }> }>;

export type SetupInput = Readonly<{
  channel: Readonly<{ id: string; name: string }>;
  domain: DomainPick | DomainNew;
  schema: Readonly<{ catalog: string; name: string; create: boolean }>;
  /** A group or user who may use the channel's skills. */
  principal?: string;
  /** The signed-in person, for the GRANTs an admin would run. */
  viewer?: string;
}>;

export type SetupResult = Readonly<{ steps: readonly SetupStep[]; linked: boolean; domainId?: string; schema: string }>;

/** Quotes an identifier for SQL, as an admin would paste it. */
export const quoteIdent = (name: string) => `\`${name.replace(/`/g, "``")}\``;
const sqlPrincipal = (principal: string) => quoteIdent(principal);

const domainIdOf = (domain: Pick<Domain, "name" | "domain_id">) => domain.domain_id ?? domain.name.replace(/^domains\//, "");

/** A refused step: the ask for a permission problem, the error otherwise. */
function refusal(error: unknown, ask: string, sql?: string): Pick<SetupStep, "status" | "detail" | "sql"> {
  if (isApiError(error) && error.isPermission) return { status: "denied", detail: ask, ...(sql && { sql }) };
  return { status: "failed", detail: describeError(error) };
}

/** A default schema name from a channel's name: lowercase letters, digits and underscores. */
export function schemaNameFor(channelName: string): string {
  const base = channelName.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "") || "channel";
  return /^\d/.test(base) ? `c_${base}` : base;
}

/** Domain key for a new domain: `Parent/Child` under a parent. */
export const domainKey = (title: string, parent?: Readonly<{ tagKey: string }>) => (parent ? `${parent.tagKey}/${title}` : title);

async function domainStep(client: DatabricksClient, choice: DomainNew): Promise<{ step: SetupStep; domain?: Readonly<{ id: string; tagKey: string }> }> {
  const tagKey = domainKey(choice.title, choice.parent);
  const id = "domain";
  const title = `Create the draft domain “${choice.title}”`;
  try {
    await ensureTagPolicy(client, tagKey, `Governs the “${tagKey}” domain.`);
  } catch (error) {
    if (tagPolicyLimit(error))
      return { step: { id, title, status: "failed", detail: "This account has reached its limit of tag policies, and a domain needs one. An account admin can free one up, or you can pick an existing domain." } };
    return { step: { id, title, ...refusal(error, `Creating a domain needs a tag policy named “${tagKey}”. Ask an account admin to create it, or pick an existing domain.`) } };
  }
  try {
    const domain = await new Domains(client).create({ tag_key: tagKey, draft: true, ...(choice.description && { description: choice.description }), ...(choice.parent && { parent_domain_id: choice.parent.id }) });
    return { step: { id, title, status: "done", detail: "Its governed tag is ready, and nothing is published." }, domain: { id: domainIdOf(domain), tagKey } };
  } catch (error) {
    if (alreadyExists(error)) {
      try {
        const existing = (await new Domains(client).list()).find((domain) => domain.tag_key === tagKey);
        if (existing) return { step: { id, title: `Use the existing domain “${choice.title}”`, status: "done" }, domain: { id: domainIdOf(existing), tagKey } };
      } catch (listError) {
        return { step: { id, title, ...refusal(listError, "Finding the existing domain needs the MANAGE DISCOVERY permission. Ask an admin, or pick it from the list.") } };
      }
    }
    return { step: { id, title, ...refusal(error, `You can't create domains here. Ask an admin to create “${tagKey}”, or pick an existing domain.`) } };
  }
}

async function schemaStep(client: DatabricksClient, input: SetupInput, full: string): Promise<SetupStep> {
  const { catalog, name, create } = input.schema;
  const id = "schema";
  if (create) {
    try {
      await client.post("/api/2.1/unity-catalog/schemas", { name, catalog_name: catalog });
      return { id, title: `Create the schema ${full}`, status: "done" };
    } catch (error) {
      if (!alreadyExists(error))
        return {
          id,
          title: `Create the schema ${full}`,
          ...refusal(
            error,
            `Creating a schema needs CREATE SCHEMA on “${catalog}”. Ask an admin to grant it, or pick an existing schema.`,
            `GRANT CREATE SCHEMA ON CATALOG ${quoteIdent(catalog)} TO ${sqlPrincipal(input.viewer ?? "you@example.com")}`,
          ),
        };
      // It's there already: fall through and use it, after the link check below.
    }
  }
  // A schema can only serve one channel. Its tags say which, if any.
  try {
    const current = await new Tags(client).list("schemas", full);
    const other = current.find((tag) => tag.tag_key === CHANNEL_TAG)?.tag_value;
    if (other && other !== input.channel.id)
      return { id, title: `Use ${full}`, status: "failed", detail: `${full} is already linked to another Buzz channel. Pick another schema, or unlink it in that channel first.` };
  } catch {
    // Can't read its tags: the tag steps below will say what's wrong.
  }
  return { id, title: `Use the schema ${full}`, status: "done" };
}

/** Runs the setup steps in order. Returns every step's result; `linked` is true when the channel's tag is set. */
export async function setUpChannel(client: DatabricksClient, input: SetupInput): Promise<SetupResult> {
  const steps: SetupStep[] = [];
  const tags = new Tags(client);
  const full = `${input.schema.catalog}.${input.schema.name}`;
  const ask = `Tagging ${full} needs APPLY TAG on it. Ask the schema owner or an admin to grant it.`;
  const applyTag = `GRANT APPLY TAG ON SCHEMA ${quoteIdent(input.schema.catalog)}.${quoteIdent(input.schema.name)} TO ${sqlPrincipal(input.viewer ?? "you@example.com")}`;

  let domainId: string | undefined;
  let domainTag: string | undefined;
  if (input.domain.mode === "existing") {
    domainId = input.domain.id;
    domainTag = input.domain.tagKey;
    steps.push({ id: "domain", title: `Use the domain “${input.domain.title}”`, status: "done" });
  } else {
    const created = await domainStep(client, input.domain);
    steps.push(created.step);
    domainId = created.domain?.id;
    domainTag = created.domain?.tagKey;
  }

  const skip = (id: string, title: string, detail: string) => steps.push({ id, title, status: "skipped", detail });
  // No domain, no schema: creating one now would leave it behind when the domain can't be set up.
  if (!domainId) {
    skip("schema", `Use the schema ${full}`, "Set up the domain first.");
    skip("tag-domain", "Add the schema to the domain", "No domain yet.");
    skip("tag-metadata", "Tag the schema for this channel", "No domain yet.");
    skip("link", "Link the channel", "The domain or schema isn't ready.");
    return { steps, linked: false, schema: full };
  }

  const schema = await schemaStep(client, input, full);
  steps.push(schema);
  const ready = schema.status === "done";

  if (domainTag && ready) {
    try {
      await tags.assign("schemas", full, domainTag, "");
      steps.push({ id: "tag-domain", title: "Add the schema to the domain", status: "done" });
    } catch (error) {
      steps.push({
        id: "tag-domain",
        title: "Add the schema to the domain",
        ...refusal(error, `Adding a schema to a domain needs the ASSIGN permission on its tag “${domainTag}”. Ask a domain admin.`),
      });
    }
  } else skip("tag-domain", "Add the schema to the domain", domainTag ? "The schema isn't ready." : "No domain yet.");

  if (ready) {
    try {
      await tags.assign("schemas", full, SKILLS_TAG, input.channel.name);
      await tags.assign("schemas", full, DOMAIN_TAG, domainId);
      steps.push({ id: "tag-metadata", title: "Tag the schema for this channel", status: "done" });
    } catch (error) {
      steps.push({ id: "tag-metadata", title: "Tag the schema for this channel", ...refusal(error, ask, applyTag) });
    }
  } else skip("tag-metadata", "Tag the schema for this channel", "The schema isn't ready.");

  // Linking last, so a channel only counts as linked once the rest is in place.
  let linked = false;
  if (ready) {
    try {
      await tags.assign("schemas", full, CHANNEL_TAG, input.channel.id);
      steps.push({ id: "link", title: "Link the channel", status: "done" });
      linked = true;
    } catch (error) {
      steps.push({ id: "link", title: "Link the channel", ...refusal(error, ask, applyTag) });
    }
  } else skip("link", "Link the channel", "The schema isn't ready.");

  if (input.principal && linked) {
    const principal = input.principal;
    try {
      await client.json(`/api/2.1/unity-catalog/permissions/schema/${encodeURIComponent(full)}`, {
        method: "PATCH",
        body: { changes: [{ principal, add: ["USE_SCHEMA", "READ_VOLUME"] }] },
      });
      steps.push({ id: "share-schema", title: `Let ${principal} use the skills`, status: "done" });
    } catch (error) {
      steps.push({
        id: "share-schema",
        title: `Let ${principal} use the skills`,
        ...refusal(error, `Granting access to ${full} needs MANAGE on it. Ask the schema owner or an admin.`, `GRANT USE SCHEMA, READ VOLUME ON SCHEMA ${quoteIdent(input.schema.catalog)}.${quoteIdent(input.schema.name)} TO ${sqlPrincipal(principal)}`),
      });
    }
    try {
      await client.json(`/api/2.1/unity-catalog/permissions/catalog/${encodeURIComponent(input.schema.catalog)}`, {
        method: "PATCH",
        body: { changes: [{ principal, add: ["USE_CATALOG"] }] },
      });
      steps.push({ id: "share-catalog", title: `Let ${principal} use the catalog`, status: "done" });
    } catch (error) {
      steps.push({
        id: "share-catalog",
        title: `Let ${principal} use the catalog`,
        ...refusal(error, `USE CATALOG usually needs a catalog owner or admin. Ask one to run the GRANT.`, `GRANT USE CATALOG ON CATALOG ${quoteIdent(input.schema.catalog)} TO ${sqlPrincipal(principal)}`),
      });
    }
  }

  return { steps, linked, ...(domainId && { domainId }), schema: full };
}

/** Removes the channel's tag from its schema. The domain and schema stay. */
export function unlinkChannel(client: DatabricksClient, schema: string): Promise<unknown> {
  return new Tags(client).remove("schemas", schema, CHANNEL_TAG);
}
