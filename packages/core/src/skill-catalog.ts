// Finding Unity Catalog skills without walking every catalog and schema.
//
// 1. One SQL query on system.information_schema.schema_tags finds every schema
//    tagged as a skills schema (SKILLS_TAG) or linked to a channel
//    (CHANNEL_TAG), across all catalogs, limited to what the person can see.
// 2. One call to the skills registry's MCP server, scoped to those schemas
//    (plus any the person added by hand), lists all their skills with
//    descriptions.
// 3. Search runs here, over names and descriptions.
//
// Results are kept for a few minutes per workspace. Without a SQL warehouse
// only the added schemas are searched, and the catalog says so.
//
// The warehouse: the one chosen for this (`warehousePref`), or, on
// Automatic, the person's default and then the rest best first, skipping any
// they may see but not use. The one that worked is remembered.
import { type SkillRef, Skills, searchSkills } from "./api/skills";
import { Sql } from "./api/sql";
import { CHANNEL_TAG, DOMAIN_TAG, SKILLS_TAG, type SchemaTag, Tags } from "./api/tags";
import { type DatabricksService, describeError, isApiError } from "./service";

/** Schemas the person added by hand, as `catalog.schema`. */
export const SKILL_LOCATIONS = "skillLocations";

const FRESH_MS = 5 * 60_000;

export type SkillSchema = Readonly<{
  /** `catalog.schema`. */
  schema: string;
  /** Its discovery tags: SKILLS_TAG, CHANNEL_TAG, DOMAIN_TAG values. */
  tags: Readonly<Record<string, string>>;
  /** Found by tag, or added by the person. */
  source: "tag" | "added";
}>;

export type ChannelLink = Readonly<{ schema: string; channelId: string; domainId?: string }>;

export type CatalogState = Readonly<{
  status: "idle" | "loading" | "ready" | "error";
  schemas: readonly SkillSchema[];
  skills: readonly SkillRef[];
  /** Why tag discovery didn't run (no warehouse, query failed); added schemas still work. */
  note?: string;
  /** The SQL warehouse the tag query ran on. */
  warehouse?: Readonly<{ id: string; name: string }>;
  error?: string;
  at?: number;
}>;

const IDLE: CatalogState = { status: "idle", schemas: [], skills: [] };

const hostOf = (service: DatabricksService) => {
  const snapshot = service.snapshot();
  return snapshot.status === "connected" ? snapshot.profile.host : undefined;
};

export const schemaOf = (fullName: string) => fullName.split(".").slice(0, 2).join(".");

/** A warehouse refused because the person may see it but not use it. */
const refused = (error: unknown) =>
  (isApiError(error) && error.isPermission) || /permission|not authorized|insufficient privileges|insufficient permissions/i.test(String((error as Error)?.message ?? error));

export class SkillCatalog {
  private state: CatalogState = IDLE;
  private host: string | undefined;
  private loading: Promise<CatalogState> | undefined;
  private listeners = new Set<() => void>();
  /** The warehouse that last worked on Automatic, per workspace. */
  private working: string | undefined;

  constructor(
    private readonly service: DatabricksService,
    private readonly options: Readonly<{ warehousePref?: string }> = {},
  ) {
    service.subscribe(() => {
      const host = hostOf(service);
      if (host === this.host) return;
      this.host = host;
      this.loading = undefined;
      this.working = undefined;
      this.set(IDLE);
    });
    this.host = hostOf(service);
  }

  /** The warehouse chosen for this catalog, or undefined for Automatic. */
  chosenWarehouse(): string | undefined {
    return this.options.warehousePref ? this.service.preferences.get<string>(this.options.warehousePref) || undefined : undefined;
  }

  /**
   * Runs SQL work on a warehouse: the chosen one, or on Automatic the person's
   * default and then the others best first, moving on from any that refuse
   * the person. Tries at most four.
   */
  async withWarehouse<T>(run: (warehouseId: string) => Promise<T>): Promise<{ result: T; warehouse: { id: string; name: string } }> {
    const warehouses = await new Sql(await this.service.ready()).warehouses();
    const chosen = this.chosenWarehouse();
    if (chosen) {
      const warehouse = warehouses.find((w) => w.id === chosen || w.name === chosen);
      if (!warehouse) throw new Error("The SQL warehouse chosen for skills isn't available to you any more. Choose another in Settings → Databricks Knowledge.");
      return { result: await run(warehouse.id), warehouse: { id: warehouse.id, name: warehouse.name } };
    }
    const preferred = [this.working, this.service.preferences.get<string>("warehouseId")].filter(Boolean);
    const ordered = [
      ...preferred.map((id) => warehouses.find((w) => w.id === id || w.name === id)).filter((w): w is NonNullable<typeof w> => Boolean(w)),
      ...Sql.rank(warehouses),
    ].filter((w, index, all) => all.findIndex((other) => other.id === w.id) === index);
    if (!ordered.length) throw new Error("No SQL warehouse is available to you in this workspace.");
    let last: unknown;
    for (const warehouse of ordered.slice(0, 4)) {
      try {
        const result = await run(warehouse.id);
        this.working = warehouse.id;
        return { result, warehouse: { id: warehouse.id, name: warehouse.name } };
      } catch (error) {
        if (!refused(error)) throw error;
        last = error;
      }
    }
    throw new Error(`None of the SQL warehouses tried let you run queries (${describeError(last)}). Choose one you can use in Settings → Databricks Knowledge.`);
  }

  snapshot = () => this.state;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  /** Schemas the person added by hand. */
  locations(): string[] {
    return this.service.preferences.get<string[]>(SKILL_LOCATIONS) ?? [];
  }

  setLocations(locations: readonly string[]) {
    const clean = [...new Set(locations.map((location) => location.trim()).filter((location) => /^[^.\s]+\.[^.\s]+$/.test(location)))];
    this.service.preferences.set(SKILL_LOCATIONS, clean.length ? clean : undefined);
    void this.load(true);
  }

  /** Discovers schemas and lists their skills; reuses a fresh result unless `force`. */
  load(force = false): Promise<CatalogState> {
    if (!force && this.state.status === "ready" && this.state.at && Date.now() - this.state.at < FRESH_MS) return Promise.resolve(this.state);
    if (this.loading && !force) return this.loading;
    const host = this.host;
    this.set({ ...this.state, status: "loading" });
    let loading: Promise<CatalogState> | undefined;
    loading = (async (): Promise<CatalogState> => {
      try {
        const client = await this.service.ready();
        let tagged: SchemaTag[] = [];
        let note: string | undefined;
        let warehouse: { id: string; name: string } | undefined;
        try {
          const found = await this.withWarehouse((id) => new Tags(client).schemas(id, [SKILLS_TAG, CHANNEL_TAG, DOMAIN_TAG]));
          tagged = found.result;
          warehouse = found.warehouse;
        } catch (error) {
          note = `Couldn't look for tagged skills schemas: ${describeError(error)}`;
        }
        const byName = new Map<string, { tags: Record<string, string>; source: "tag" | "added" }>();
        for (const row of tagged) {
          const name = `${row.catalog}.${row.schema}`;
          const entry = byName.get(name) ?? { tags: {}, source: "tag" as const };
          entry.tags[row.tag] = row.value;
          byName.set(name, entry);
        }
        // A schema tagged only with a domain isn't a skills schema.
        for (const [name, entry] of byName) if (!(SKILLS_TAG in entry.tags) && !(CHANNEL_TAG in entry.tags)) byName.delete(name);
        for (const location of this.locations()) if (!byName.has(location)) byName.set(location, { tags: {}, source: "added" });
        const schemas = [...byName].map(([schema, entry]) => ({ schema, ...entry })).sort((a, b) => a.schema.localeCompare(b.schema));
        const skills = schemas.length ? await this.listSkills(schemas.map((entry) => entry.schema)) : [];
        const next: CatalogState = { status: "ready", schemas, skills, at: Date.now(), ...(note && { note }), ...(warehouse && { warehouse }) };
        if (host === this.host) this.set(next);
        return next;
      } catch (error) {
        const next: CatalogState = { status: "error", schemas: [], skills: [], error: describeError(error) };
        if (host === this.host) this.set(next);
        return next;
      } finally {
        if (this.loading === loading) this.loading = undefined;
      }
    })();
    this.loading = loading;
    return loading;
  }

  /** All skills in these schemas: the registry first, the REST API if it fails. */
  async listSkills(schemas: readonly string[]): Promise<SkillRef[]> {
    const skills = new Skills(await this.service.ready());
    try {
      return await skills.registry(schemas);
    } catch {
      const lists = await Promise.all(
        schemas.map(async (schema) => {
          const [catalog, name] = schema.split(".") as [string, string];
          return (await skills.list(catalog, name).catch(() => [])).filter((skill) => skill.finalize_time || skill.bundle_name);
        }),
      );
      return lists
        .flat()
        .map((skill) => ({ fullName: skill.name.replace(/^skills\//, ""), description: skill.description ?? skill.comment ?? "" }))
        .sort((a, b) => a.fullName.localeCompare(b.fullName));
    }
  }

  async search(query: string, limit = 20): Promise<{ skills: SkillRef[]; state: CatalogState }> {
    const state = await this.load();
    return { skills: searchSkills(state.skills, query, limit), state };
  }

  /** The schema linked to a Buzz channel, if anyone set one up. */
  async channel(channelId: string): Promise<ChannelLink | undefined> {
    const find = (state: CatalogState) => {
      const entry = state.schemas.find((schema) => schema.tags[CHANNEL_TAG] === channelId);
      return entry && { schema: entry.schema, channelId, ...(entry.tags[DOMAIN_TAG] && { domainId: entry.tags[DOMAIN_TAG] }) };
    };
    const state = await this.load();
    const found = find(state);
    // Set up moments ago, maybe by someone else: look again if it's a minute old.
    if (found || !state.at || Date.now() - state.at < 60_000) return found;
    return find(await this.load(true));
  }

  /** The skills in a channel's schema. */
  async channelSkills(channelId: string): Promise<SkillRef[]> {
    const link = await this.channel(channelId);
    if (!link) return [];
    return this.state.skills.filter((skill) => schemaOf(skill.fullName) === link.schema);
  }

  private set(state: CatalogState) {
    this.state = state;
    for (const listener of [...this.listeners]) listener();
  }
}
