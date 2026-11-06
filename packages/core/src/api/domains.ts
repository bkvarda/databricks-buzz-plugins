// Unity Catalog domains (Beta): business areas built on a governed tag.
// https://docs.databricks.com/api/domains/v1/domain
//
// A domain's `name` is `domains/<id>` and its `tag_key` (immutable) is both
// its title and the governed tag that marks what belongs to it; subdomains use
// `Parent/Child` keys. Domains are account-wide, so names are shared across
// workspaces. Listing and reading need MANAGE DISCOVERY; drafts stay hidden
// from people browsing until published.
import type { DatabricksClient } from "../client";

export const DOMAIN_ICONS = [
  "ADDRESS_BOOK", "ALARM", "ARROWS_IN", "ATOM", "BALLOON", "BANK", "BARRICADE", "BASKET", "BRIDGE", "CACTUS", "CALL_BELL", "CARROT",
  "CHART_PIE_SLICE", "CITY", "CLOUD", "COINS", "COMPASS_ROSE", "CRANE_TOWER", "CROWN", "CUBE_TRANSPARENT", "FADERS", "FLAG_BANNER_FOLD",
  "FLAG_CHECKERED", "GAVEL", "HAMBURGER", "HEAD_CIRCUIT", "HOURGLASS_HIGH", "INTERSECT_THREE", "MICROSCOPE", "MOON_STARS", "PACKAGE",
  "PARACHUTE", "PEPPER", "PIGGY_BANK", "PILL", "PLANET", "PLANT", "PLUGS_CONNECTED", "POPCORN", "PRESENTATION_CHART", "PUZZLE_PIECE",
  "RAINBOW", "RANKING", "RECEIPT", "ROCKET", "RULER", "SAILBOAT", "SCALES", "SCAN_SMILEY", "SCROLL", "SHIELD_CHECKERED", "SNEAKER",
  "SNOWFLAKE", "SOLAR_ROOF", "SPEEDOMETER", "STAMP", "STEPS", "STRATEGY", "SWORD", "TELEVISION_SIMPLE", "TENT", "TICKET", "TRACTOR",
  "TRAFFIC_CONE", "TRAIN", "TREE_EVERGREEN", "TREE_STRUCTURE", "TROLLEY_SUITCASE", "TROPHY", "TRUCK_TRAILER", "USERS_THREE", "VECTOR_THREE",
] as const;

export type DomainIcon = Readonly<{ name?: string; color?: string }>;

export type Domain = Readonly<{
  /** `domains/<domain_id>`. */
  name: string;
  domain_id?: string;
  /** The governed tag, and the domain's title. */
  tag_key: string;
  effective_draft?: boolean;
  icon?: DomainIcon;
  subtitle?: string;
  description?: string;
  parent_domain_id?: string;
  technical_owner_ids?: readonly number[];
  business_owner_ids?: readonly number[];
  create_time?: string;
  update_time?: string;
}>;

export type NewDomain = Readonly<{
  tag_key: string;
  draft?: boolean;
  icon?: DomainIcon;
  subtitle?: string;
  description?: string;
  parent_domain_id?: string;
}>;

/** A domain's title: its tag key, without the parent part for a subdomain. */
export const domainTitle = (domain: Pick<Domain, "tag_key">) => domain.tag_key.split("/").pop() ?? domain.tag_key;

export class Domains {
  constructor(private readonly client: DatabricksClient) {}

  async list(options: Readonly<{ parentDomainId?: string; signal?: AbortSignal }> = {}): Promise<Domain[]> {
    const domains: Domain[] = [];
    let pageToken: string | undefined;
    for (let page = 0; page < 50; page++) {
      const response = await this.client.get<{ domains?: Domain[]; next_page_token?: string }>("/api/2.0/domains", {
        query: { page_size: 100, page_token: pageToken, parent_domain_id: options.parentDomainId },
        ...(options.signal && { signal: options.signal }),
      });
      domains.push(...(response.domains ?? []));
      pageToken = response.next_page_token;
      if (!pageToken) break;
    }
    return domains.sort((a, b) => a.tag_key.localeCompare(b.tag_key));
  }

  get(name: string): Promise<Domain> {
    return this.client.get<Domain>(`/api/2.0/${domainName(name)}`);
  }

  /**
   * Creates a domain; `draft` defaults to true here so nothing is published by
   * surprise. A governed tag policy with the same key must exist first (else
   * "Tag policy with name X not found"); accounts have a cap on policies.
   */
  create(domain: NewDomain): Promise<Domain> {
    return this.client.post<Domain>("/api/2.0/domains", { draft: true, ...domain });
  }

  update(name: string, fields: Partial<Omit<NewDomain, "tag_key" | "parent_domain_id">>, domain: Pick<Domain, "tag_key">): Promise<Domain> {
    const mask = Object.keys(fields).join(",");
    return this.client.json<Domain>(`/api/2.0/${domainName(name)}`, { method: "PATCH", body: { tag_key: domain.tag_key, ...fields }, query: { update_mask: mask } });
  }

  delete(name: string, force = false): Promise<unknown> {
    return this.client.json(`/api/2.0/${domainName(name)}`, { method: "DELETE", query: { force: force ? "true" : undefined } });
  }
}

/** `domains/<id>` from either form. */
export const domainName = (nameOrId: string) => (nameOrId.startsWith("domains/") ? nameOrId : `domains/${nameOrId}`);
