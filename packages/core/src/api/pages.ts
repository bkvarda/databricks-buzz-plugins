// Unity Catalog Pages (Beta, the Knowledge API): Markdown pages in a domain
// that Genie One prioritizes and cites.
// https://docs.databricks.com/api/knowledge/v1/list-pages
//
// Pages aren't encrypted with customer-managed keys and may be replicated
// across regions, so they must not hold personal data. An account admin turns
// the API on under Previews; until then it answers 501 NOT_IMPLEMENTED.
// Anyone who may see a domain can create their own drafts in it; publishing
// needs Page Manager or Domain Admin on the domain.
import type { DatabricksClient } from "../client";

export type PageState = "DRAFT" | "PUBLISHED";

export type KnowledgePage = Readonly<{
  /** `pages/<page_id>`. */
  name: string;
  /** `domains/<domain_id>`; fixed once created. */
  domain: string;
  display_name: string;
  body?: string;
  synonyms?: readonly string[];
  description?: string;
  state?: PageState;
  owner_ids?: readonly string[];
  create_time?: string;
  update_time?: string;
}>;

export type NewPage = Readonly<{ domain: string; display_name: string; body?: string; synonyms?: readonly string[]; description?: string; state?: PageState }>;

export type PageUpdate = Partial<Pick<KnowledgePage, "display_name" | "body" | "synonyms" | "description" | "state">>;

const quoted = (value: string) => `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;

export class Pages {
  constructor(private readonly client: DatabricksClient) {}

  /** Whether the Pages API is on in this deployment (it answers 501 when it isn't). */
  async available(): Promise<boolean> {
    const response = await this.client.request("/api/2.0/knowledge/pages", { method: "GET", query: { page_size: 1 } });
    return response.status !== 501 && response.status !== 404;
  }

  /** Pages in a domain (and its subdomains), optionally in one state. */
  async list(options: Readonly<{ domain?: string; state?: PageState; signal?: AbortSignal }> = {}): Promise<KnowledgePage[]> {
    const filter = [options.domain && `domain = ${quoted(options.domain)}`, options.state && `state = ${quoted(options.state)}`].filter(Boolean).join(" AND ");
    const pages: KnowledgePage[] = [];
    let pageToken: string | undefined;
    for (let page = 0; page < 50; page++) {
      const response = await this.client.get<{ pages?: KnowledgePage[]; next_page_token?: string }>("/api/2.0/knowledge/pages", {
        query: { page_size: 100, page_token: pageToken, filter: filter || undefined },
        ...(options.signal && { signal: options.signal }),
      });
      pages.push(...(response.pages ?? []));
      pageToken = response.next_page_token;
      if (!pageToken) break;
    }
    return pages;
  }

  get(name: string): Promise<KnowledgePage> {
    return this.client.get<KnowledgePage>(`/api/2.0/knowledge/${pageName(name)}`);
  }

  /** Creates a page; a draft unless `state` says otherwise. `requestId` makes retries safe. */
  create(page: NewPage, requestId?: string): Promise<KnowledgePage> {
    return this.client.post<KnowledgePage>("/api/2.0/knowledge/pages", { state: "DRAFT", ...page }, requestId ? { query: { request_id: requestId } } : {});
  }

  update(name: string, fields: PageUpdate): Promise<KnowledgePage> {
    const mask = Object.keys(fields).join(",");
    if (!mask) throw new Error("Nothing to update.");
    return this.client.json<KnowledgePage>(`/api/2.0/knowledge/${pageName(name)}`, { method: "PATCH", body: fields, query: { update_mask: mask } });
  }

  /** Adds a snippet to the end of a page's body (an update replaces the whole body). */
  async append(name: string, snippet: string): Promise<KnowledgePage> {
    const page = await this.get(name);
    const body = [page.body?.trimEnd(), snippet.trim()].filter(Boolean).join("\n\n");
    return this.update(name, { body });
  }

  delete(name: string): Promise<unknown> {
    return this.client.json(`/api/2.0/knowledge/${pageName(name)}`, { method: "DELETE" });
  }
}

export const pageName = (nameOrId: string) => (nameOrId.startsWith("pages/") ? nameOrId : `pages/${nameOrId}`);
