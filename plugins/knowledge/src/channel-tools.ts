// Agent tools for channels: what a channel is linked to, Pages search and
// reading, and page drafts. Agents read as the signed-in person and never
// write pages; a draft goes into the reply as a block a person adds.
import { type Domain, domainName, Domains, domainTitle } from "@dbx/core/api/domains";
import { type KnowledgePage, Pages, pageName } from "@dbx/core/api/pages";
import type { AgentTool } from "@dbx/core/host-types";
import { schema, stringArg } from "@dbx/core/host-types";
import { type DatabricksService, describeError, isApiError } from "@dbx/core/service";
import type { SkillCatalog } from "@dbx/core/skill-catalog";
import { PAGES_OFF, type PageBlock, pageBlockFence } from "./page-draft";

const NOT_LINKED =
  "This channel isn't set up with Databricks yet. Someone can open the channel's menu and choose Set up Databricks to link it to a domain and a skills schema.";
const NO_CHANNEL = "This conversation isn't in a Buzz channel, so it has no linked Databricks domain.";
const MAX_BODY = 20_000;

/** A domain's title and status, or why they can't be read. */
async function describeDomain(service: DatabricksService, id: string): Promise<string> {
  try {
    const domain: Domain = await new Domains(await service.ready()).get(domainName(id));
    const status = domain.effective_draft ? "draft" : "published";
    return `Domain: ${domainTitle(domain)} (${status})${domain.description ? `\n${domain.description}` : ""}`;
  } catch (error) {
    if (isApiError(error) && error.isPermission) return `Domain: ${id} (its details need the MANAGE DISCOVERY permission)`;
    return `Domain: ${id} (${describeError(error)})`;
  }
}

/** Pages in a domain, or the reason there are none to show. */
async function describePages(service: DatabricksService, domain: string): Promise<string> {
  const pages = new Pages(await service.ready());
  if (!(await pages.available())) return PAGES_OFF;
  try {
    const list = await pages.list({ domain: domainName(domain) });
    if (!list.length) return "Pages: none yet.";
    return `Pages (${list.length}):\n${list
      .slice(0, 25)
      .map((page) => `- ${page.display_name} (${page.name}, ${page.state === "PUBLISHED" ? "published" : "draft"})`)
      .join("\n")}`;
  } catch (error) {
    return `Pages: couldn't list them (${describeError(error)}).`;
  }
}

const pageLine = (page: KnowledgePage) => {
  const text = (page.body ?? page.description ?? "").replace(/\s+/g, " ").trim();
  return `- ${page.display_name} — ${page.name} (${page.state === "PUBLISHED" ? "published" : "draft"})${text ? `\n  ${text.slice(0, 200)}${text.length > 200 ? "…" : ""}` : ""}`;
};

export function channelTools(service: DatabricksService, catalog: SkillCatalog): AgentTool[] {
  return [
    {
      name: "databricks_channel_info",
      description:
        "Describes this channel's Databricks setup: the domain it's linked to, its skills schema, the skills in that schema, and its Pages. Use it before answering questions about this channel's skills or pages.",
      inputSchema: schema.object({}),
      async call(_client, context) {
        if (!context.channel) return NO_CHANNEL;
        const link = await catalog.channel(context.channel);
        if (!link) return NOT_LINKED;
        const skills = await catalog.channelSkills(context.channel);
        const lines = [link.domainId ? await describeDomain(service, link.domainId) : "Domain: none (the schema isn't tagged with one).", `Skills schema: ${link.schema}`];
        lines.push(
          skills.length
            ? `Skills (${skills.length}):\n${skills
                .slice(0, 50)
                .map((skill) => `- ${skill.fullName}${skill.description ? `: ${skill.description}` : ""}`)
                .join("\n")}`
            : "Skills: none in this schema yet.",
        );
        if (link.domainId) lines.push(await describePages(service, link.domainId));
        return lines.join("\n");
      },
    },
    {
      name: "databricks_pages_search",
      description:
        "Searches Databricks Pages (short Markdown pages that Genie One cites), in this channel's domain when it has one. Each word of the query must appear in a page's title, description, synonyms or body.",
      inputSchema: schema.object({ query: schema.string("What to look for.") }, ["query"]),
      async call(_client, context, args) {
        const client = await service.ready();
        const pages = new Pages(client);
        if (!(await pages.available())) return PAGES_OFF;
        const link = context.channel ? await catalog.channel(context.channel) : undefined;
        const words = stringArg(args, "query").toLowerCase().split(/\s+/).filter(Boolean);
        const list = await pages.list(link?.domainId ? { domain: domainName(link.domainId) } : {});
        const matches = list.filter((page) => {
          const text = [page.display_name, page.description, ...(page.synonyms ?? []), page.body].join(" ").toLowerCase();
          return words.every((word) => text.includes(word));
        });
        return matches.length ? matches.slice(0, 10).map(pageLine).join("\n") : "No pages match that.";
      },
    },
    {
      name: "databricks_page_read",
      description: "Reads one Databricks page by its name (from databricks_pages_search or databricks_channel_info), including its body.",
      inputSchema: schema.object({ name: schema.string("The page's name, such as pages/abc123, or just its ID.") }, ["name"]),
      async call(_client, _context, args) {
        const pages = new Pages(await service.ready());
        if (!(await pages.available())) return PAGES_OFF;
        try {
          const page = await pages.get(stringArg(args, "name"));
          const body = (page.body ?? "").slice(0, 20_000);
          return `${page.display_name} (${page.name}, ${page.state === "PUBLISHED" ? "published" : "draft"})\n\n${body}`;
        } catch (error) {
          if (isApiError(error) && error.isNotFound) return `There's no page named ${pageName(stringArg(args, "name"))}.`;
          throw error;
        }
      },
    },
    {
      name: "databricks_page_draft",
      description:
        "Drafts a Databricks page for the channel's domain (or the domain given). It doesn't write anything: it returns a databricks-page block. Post the block exactly as returned, in your reply; the person adds it as a draft from the card. Use it when someone asks you to turn something into a page.",
      inputSchema: schema.object(
        {
          title: schema.string("A short title for the page."),
          body: schema.string("The page's Markdown body. No personal data."),
          page: schema.string("An existing draft page to add this to, as pages/<id>. Leave out for a new page."),
          domain: schema.string("The domain, as domains/<id>. Defaults to this channel's domain."),
        },
        ["title", "body"],
      ),
      async call(_client, context, args) {
        const title = stringArg(args, "title");
        const body = stringArg(args, "body");
        if (body.length > MAX_BODY) throw new Error("Keep a page under 20,000 characters; split it into several pages.");
        const pages = new Pages(await service.ready());
        if (!(await pages.available())) return PAGES_OFF;
        let domainId = stringArg(args, "domain", false).replace(/^domains\//, "");
        if (!domainId && context.channel) domainId = (await catalog.channel(context.channel))?.domainId ?? "";
        if (!domainId)
          throw new Error(
            context.channel
              ? "This channel isn't set up with a domain, so there's nowhere to put the page. Set up Databricks in the channel menu, or pass a domain."
              : "Pass a domain, as domains/<id>; this conversation isn't in a channel.",
          );
        const domain = domainName(domainId);
        const block: PageBlock = {
          title,
          body,
          domain,
          domain_title: await describeDomainTitle(service, domainId),
          ...(stringArg(args, "page", false) && { page: pageName(stringArg(args, "page", false)) }),
        };
        return `Draft page for ${block.domain_title}. Post this block exactly as written, in your reply. The person adds it as a draft from the card.\n\n${pageBlockFence(block)}`;
      },
    },
  ];
}

/** A domain's title, or its ID when it can't be read. */
async function describeDomainTitle(service: DatabricksService, id: string): Promise<string> {
  try {
    return domainTitle(await new Domains(await service.ready()).get(domainName(id)));
  } catch {
    return id;
  }
}
