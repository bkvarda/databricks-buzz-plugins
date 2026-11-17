// The signals hub's store in Postgres (Lakebase in production, PGlite in
// tests). One schema, owned by the app's service principal, made on start.
//
// - sources: who turned on which source (the opt-in), and its last post.
// - events: one row per (owner, source, external_id); a changed content hash
//   is a new version, the same hash is only "seen again".
// - tasks: one per rule group across everyone (two people getting the same
//   ticket update share one task), with its Buzz thread once posted.
// - task_events, activities, artifacts: what led to a task and what was done.
import { createHash } from "node:crypto";
import { contentKey, decide, type EventInput, isOpen, matches, type SignalsConfig, TASK_STATUSES, type TaskStatus, toSeconds } from "./model";

export type Row = Record<string, unknown>;
/** The part of pg.Pool (and PGlite) the store uses. */
export type Db = Readonly<{ query<T extends Row = Row>(text: string, values?: unknown[]): Promise<{ rows: T[] }> }>;

export type Task = Readonly<{
  id: number;
  rule_id: string;
  group_key: string;
  title: string;
  account: string | null;
  channel: string | null;
  workstream: string | null;
  status: TaskStatus;
  created_by: string;
  created_at: number;
  updated_at: number;
  last_event_at: number;
  event_count: number;
  buzz_root: string | null;
  nudged_at: number | null;
}>;

export type Outcome = "new" | "changed" | "same" | "skipped";
export type IngestResult = Readonly<{
  received: number;
  new: number;
  changed: number;
  same: number;
  skipped: number;
  errors: { index: number; error: string }[];
  /** Tasks opened by this post. */
  created: Task[];
  /** Tasks an event of this post was added to. */
  updated: { task: Task; title?: string; url?: string }[];
  firstRun: boolean;
}>;

const now = () => Math.floor(Date.now() / 1000);

export const contentHash = (event: EventInput) => createHash("sha256").update(contentKey(event)).digest("hex").slice(0, 32);

export const schemaName = (app: string) => `signals_${(app || "hub").toLowerCase().replace(/[^a-z0-9]+/g, "_")}`.slice(0, 63);

export class SignalsStore {
  constructor(
    private readonly db: Db,
    readonly schema: string,
  ) {
    if (!/^[a-z_][a-z0-9_]{0,62}$/.test(schema)) throw new Error(`Bad schema name ${schema}`);
  }

  private q<T extends Row = Row>(text: string, values: unknown[] = []) {
    return this.db.query<T>(text.replaceAll("$S.", `${this.schema}.`), values);
  }

  async setup(): Promise<void> {
    await this.q(`CREATE SCHEMA IF NOT EXISTS ${this.schema}`);
    await this.q(`CREATE TABLE IF NOT EXISTS $S.config (id int PRIMARY KEY, body jsonb NOT NULL, updated_by text, updated_at bigint NOT NULL)`);
    await this.q(`CREATE TABLE IF NOT EXISTS $S.sources (
      owner text NOT NULL, source text NOT NULL, enabled boolean NOT NULL, scope jsonb,
      enabled_at bigint, last_post_at bigint, last_count int, last_error text, PRIMARY KEY (owner, source))`);
    // Where a poller stopped (a watermark, a page token); pollers keep no state of their own.
    await this.q(`ALTER TABLE $S.sources ADD COLUMN IF NOT EXISTS cursor text`);
    await this.q(`CREATE TABLE IF NOT EXISTS $S.events (
      id bigserial PRIMARY KEY, owner text NOT NULL, source text NOT NULL, external_id text NOT NULL,
      content_hash text NOT NULL, versions int NOT NULL DEFAULT 1, occurred_at bigint NOT NULL,
      first_seen bigint NOT NULL, last_seen bigint NOT NULL, changed_at bigint NOT NULL,
      title text, url text, actor text, account text, group_key text, payload jsonb, task_id bigint,
      UNIQUE (owner, source, external_id))`);
    await this.q(`CREATE INDEX IF NOT EXISTS events_task ON $S.events (task_id)`);
    await this.q(`CREATE TABLE IF NOT EXISTS $S.tasks (
      id bigserial PRIMARY KEY, rule_id text NOT NULL, group_key text NOT NULL UNIQUE, title text NOT NULL,
      account text, channel text, workstream text, status text NOT NULL DEFAULT 'open', created_by text NOT NULL,
      created_at bigint NOT NULL, updated_at bigint NOT NULL, last_event_at bigint NOT NULL, event_count int NOT NULL DEFAULT 0,
      latest_event bigint, buzz_root text, nudged_at bigint)`);
    await this.q(`CREATE INDEX IF NOT EXISTS tasks_status ON $S.tasks (status, last_event_at)`);
    await this.q(`CREATE INDEX IF NOT EXISTS tasks_account ON $S.tasks (account, status)`);
    await this.q(`CREATE TABLE IF NOT EXISTS $S.task_events (task_id bigint NOT NULL, event_id bigint NOT NULL, version int NOT NULL, at bigint NOT NULL, PRIMARY KEY (task_id, event_id, version))`);
    await this.q(`CREATE TABLE IF NOT EXISTS $S.activities (id bigserial PRIMARY KEY, task_id bigint NOT NULL, at bigint NOT NULL, actor text NOT NULL, kind text NOT NULL, text text NOT NULL)`);
    await this.q(`CREATE INDEX IF NOT EXISTS activities_task ON $S.activities (task_id, at)`);
    await this.q(`CREATE TABLE IF NOT EXISTS $S.artifacts (id bigserial PRIMARY KEY, task_id bigint NOT NULL, at bigint NOT NULL, actor text NOT NULL, kind text NOT NULL, url text NOT NULL, title text)`);
  }

  // --- config -------------------------------------------------------------

  async config(): Promise<SignalsConfig | undefined> {
    const found = await this.q<{ body: SignalsConfig }>(`SELECT body FROM $S.config WHERE id = 1`);
    return found.rows[0]?.body;
  }

  async saveConfig(config: SignalsConfig, by: string): Promise<void> {
    await this.q(`INSERT INTO $S.config (id, body, updated_by, updated_at) VALUES (1, $1, $2, $3) ON CONFLICT (id) DO UPDATE SET body = excluded.body, updated_by = excluded.updated_by, updated_at = excluded.updated_at`, [JSON.stringify(config), by, now()]);
  }

  // --- opt-in -------------------------------------------------------------

  async sources(owner: string) {
    return (await this.q<{ source: string; enabled: boolean; scope: unknown; enabled_at: number | null; last_post_at: number | null; last_count: number | null; last_error: string | null; cursor: string | null }>(
      `SELECT source, enabled, scope, enabled_at, last_post_at, last_count, last_error, cursor FROM $S.sources WHERE owner = $1 ORDER BY source`,
      [owner],
    )).rows.map((row) => ({ ...row, enabled_at: num(row.enabled_at), last_post_at: num(row.last_post_at) }));
  }

  /** Turns a source on or off for a person. Turning it off keeps their events; `forget` deletes them. */
  async setSource(owner: string, source: string, enabled: boolean, scope?: unknown, forget = false): Promise<void> {
    await this.q(
      `INSERT INTO $S.sources (owner, source, enabled, scope, enabled_at) VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (owner, source) DO UPDATE SET enabled = excluded.enabled, scope = COALESCE(excluded.scope, $S.sources.scope),
         enabled_at = CASE WHEN excluded.enabled AND NOT $S.sources.enabled THEN excluded.enabled_at ELSE $S.sources.enabled_at END`,
      [owner, source, enabled, scope === undefined ? null : JSON.stringify(scope), enabled ? now() : null],
    );
    if (!enabled && forget) await this.q(`DELETE FROM $S.events WHERE owner = $1 AND source = $2`, [owner, source]);
  }

  async enabled(owner: string, source: string): Promise<{ enabled: boolean; firstRun: boolean }> {
    const found = await this.q<{ enabled: boolean; last_post_at: unknown }>(`SELECT enabled, last_post_at FROM $S.sources WHERE owner = $1 AND source = $2`, [owner, source]);
    const row = found.rows[0];
    return { enabled: row?.enabled === true, firstRun: !row || row.last_post_at === null };
  }

  /** Saves where a poller stopped, for its next run. Only for a source that's on. */
  async setCursor(owner: string, source: string, cursor: string): Promise<void> {
    await this.q(`UPDATE $S.sources SET cursor = $3 WHERE owner = $1 AND source = $2 AND enabled`, [owner, source, cursor.slice(0, 4000)]);
  }

  async sourceError(owner: string, source: string, error: string | null): Promise<void> {
    await this.q(`UPDATE $S.sources SET last_error = $3 WHERE owner = $1 AND source = $2`, [owner, source, error?.slice(0, 1000) ?? null]);
  }

  // --- events -------------------------------------------------------------

  /** Records one event: new, changed (a new content hash) or the same. */
  async record(owner: string, event: EventInput): Promise<{ outcome: Exclude<Outcome, "skipped">; id: number; version: number; taskId: number | null }> {
    const hash = contentHash(event);
    const at = now();
    const occurred = toSeconds(event.occurred_at);
    const values = [owner, event.source, event.external_id, hash, occurred, at, event.title ?? null, event.url ?? null, event.actor ?? null, event.account ?? null, event.group_key ?? null, event.payload ? JSON.stringify(event.payload) : null];
    // xmax = 0 only for a row this statement inserted.
    const found = await this.q<{ id: unknown; versions: number; task_id: unknown; inserted: boolean; changed: boolean }>(
      `WITH previous AS (SELECT content_hash FROM $S.events WHERE owner = $1 AND source = $2 AND external_id = $3)
       INSERT INTO $S.events (owner, source, external_id, content_hash, occurred_at, first_seen, last_seen, changed_at, title, url, actor, account, group_key, payload)
       VALUES ($1, $2, $3, $4, $5, $6, $6, $6, $7, $8, $9, $10, $11, $12)
       ON CONFLICT (owner, source, external_id) DO UPDATE SET
         last_seen = excluded.last_seen,
         content_hash = excluded.content_hash,
         versions = $S.events.versions + CASE WHEN $S.events.content_hash = excluded.content_hash THEN 0 ELSE 1 END,
         changed_at = CASE WHEN $S.events.content_hash = excluded.content_hash THEN $S.events.changed_at ELSE excluded.changed_at END,
         occurred_at = excluded.occurred_at, title = excluded.title, url = excluded.url, actor = excluded.actor,
         account = excluded.account, group_key = excluded.group_key, payload = excluded.payload
       RETURNING id, versions, task_id,
         NOT EXISTS (SELECT 1 FROM previous) AS inserted,
         COALESCE((SELECT content_hash FROM previous) <> $4, false) AS changed`,
      values,
    );
    const row = found.rows[0]!;
    return { outcome: row.inserted ? "new" : row.changed ? "changed" : "same", id: Number(row.id), version: row.versions, taskId: num(row.task_id) };
  }

  /**
   * Takes a post of events from one person: records each, and runs the rules
   * on the new and changed ones. Events for a source they haven't turned on
   * are skipped (that's the opt-in). Returns what changed, for Buzz.
   */
  async ingest(owner: string, events: readonly EventInput[], config: SignalsConfig): Promise<IngestResult> {
    const result: IngestResult = { received: events.length, new: 0, changed: 0, same: 0, skipped: 0, errors: [], created: [], updated: [], firstRun: false };
    const counts = result as { -readonly [K in keyof IngestResult]: IngestResult[K] };
    const consent = new Map<string, { enabled: boolean; firstRun: boolean }>();
    const touched = new Map<number, Task>();
    const opened = new Set<number>();
    for (const [index, event] of events.entries()) {
      try {
        let state = consent.get(event.source);
        if (!state) consent.set(event.source, (state = await this.enabled(owner, event.source)));
        if (!state.enabled) {
          counts.skipped++;
          continue;
        }
        if (state.firstRun) counts.firstRun = true;
        const recorded = await this.record(owner, event);
        counts[recorded.outcome]++;
        if (recorded.outcome === "same") continue;
        const decision = decide(config, event, { firstRun: state.firstRun });
        if (decision.kind === "none") continue;
        let task = await this.taskByGroup(decision.group);
        if (!task && decision.create) {
          task = await this.openTask({ rule: decision.rule.id, group: decision.group, title: decision.title, account: decision.account?.name, channel: decision.channel, workstream: decision.rule.workstream, by: owner, at: toSeconds(event.occurred_at) });
          opened.add(task.id);
        } else if (task && !isOpen(task.status) && decision.create && recorded.outcome === "new") {
          await this.setStatus(task.id, "open", "signals", "Opened again: a new event came in.");
        }
        if (!task) continue;
        await this.attach(task.id, recorded.id, recorded.version, toSeconds(event.occurred_at));
        const fresh = (await this.task(task.id))!;
        touched.set(fresh.id, fresh);
        if (!opened.has(fresh.id)) result.updated.push({ task: fresh, ...(event.title && { title: event.title }), ...(event.url && { url: event.url }) });
      } catch (error) {
        result.errors.push({ index, error: (error as Error).message });
      }
    }
    for (const id of opened) result.created.push(touched.get(id) ?? (await this.task(id))!);
    const by = new Map<string, number>();
    for (const event of events) by.set(event.source, (by.get(event.source) ?? 0) + 1);
    for (const [source, count] of by)
      if (consent.get(source)?.enabled) await this.q(`UPDATE $S.sources SET last_post_at = $3, last_count = $4, last_error = NULL WHERE owner = $1 AND source = $2`, [owner, source, now(), count]);
    return result;
  }

  // --- tasks --------------------------------------------------------------

  private async openTask(input: { rule: string; group: string; title: string; account?: string; channel?: string; workstream?: string; by: string; at: number }): Promise<Task> {
    const at = now();
    const found = await this.q(
      `INSERT INTO $S.tasks (rule_id, group_key, title, account, channel, workstream, created_by, created_at, updated_at, last_event_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $8, $9) ON CONFLICT (group_key) DO UPDATE SET updated_at = $S.tasks.updated_at RETURNING *`,
      [input.rule, input.group, input.title, input.account ?? null, input.channel ?? null, input.workstream ?? null, input.by, at, Number.isNaN(input.at) ? at : input.at],
    );
    const task = toTask(found.rows[0]!);
    await this.activity(task.id, "signals", "opened", `Opened by rule ${input.rule}.`);
    return task;
  }

  private async attach(task: number, event: number, version: number, at: number): Promise<void> {
    const inserted = await this.q(`INSERT INTO $S.task_events (task_id, event_id, version, at) VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING RETURNING task_id`, [task, event, version, now()]);
    if (!inserted.rows.length) return;
    await this.q(`UPDATE $S.events SET task_id = $1 WHERE id = $2`, [task, event]);
    await this.q(`UPDATE $S.tasks SET event_count = event_count + 1, latest_event = $2, last_event_at = GREATEST(last_event_at, $3), updated_at = $4 WHERE id = $1`, [task, event, Number.isNaN(at) ? now() : at, now()]);
  }

  async taskByGroup(group: string): Promise<Task | undefined> {
    const found = await this.q(`SELECT * FROM $S.tasks WHERE group_key = $1`, [group]);
    return found.rows[0] ? toTask(found.rows[0]) : undefined;
  }

  async task(id: number): Promise<Task | undefined> {
    const found = await this.q(`SELECT * FROM $S.tasks WHERE id = $1`, [id]);
    return found.rows[0] ? toTask(found.rows[0]) : undefined;
  }

  async tasks(filter: Readonly<{ status?: string; account?: string; channel?: string; open?: boolean; limit?: number }> = {}): Promise<Task[]> {
    const where: string[] = [];
    const values: unknown[] = [];
    if (filter.status) where.push(`status = $${values.push(filter.status)}`);
    if (filter.open) where.push(`status NOT IN ('done', 'dismissed')`);
    if (filter.account) where.push(`lower(account) = lower($${values.push(filter.account)})`);
    if (filter.channel) where.push(`channel = $${values.push(filter.channel)}`);
    const limit = Math.min(Math.max(filter.limit ?? 50, 1), 500);
    const found = await this.q(`SELECT * FROM $S.tasks ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY last_event_at DESC, id DESC LIMIT ${limit}`, values);
    return found.rows.map(toTask);
  }

  /** A task with its events (newest first), activities and artifacts. */
  async detail(id: number) {
    const task = await this.task(id);
    if (!task) return undefined;
    const events = await this.q(`SELECT e.id, e.source, e.external_id, e.title, e.url, e.actor, e.occurred_at, e.versions, e.owner FROM $S.events e WHERE e.task_id = $1 ORDER BY e.occurred_at DESC LIMIT 100`, [id]);
    const activities = await this.q(`SELECT at, actor, kind, text FROM $S.activities WHERE task_id = $1 ORDER BY at, id`, [id]);
    const artifacts = await this.q(`SELECT at, actor, kind, url, title FROM $S.artifacts WHERE task_id = $1 ORDER BY at, id`, [id]);
    return { task, events: events.rows.map(numbers), activities: activities.rows.map(numbers), artifacts: artifacts.rows.map(numbers) };
  }

  async setStatus(id: number, status: TaskStatus, actor: string, note?: string): Promise<Task | undefined> {
    if (!TASK_STATUSES.includes(status)) throw new Error(`status must be one of ${TASK_STATUSES.join(", ")}`);
    const found = await this.q(`UPDATE $S.tasks SET status = $2, updated_at = $3 WHERE id = $1 RETURNING *`, [id, status, now()]);
    if (!found.rows[0]) return undefined;
    await this.activity(id, actor, "status", note ? `${status}: ${note}` : status);
    return toTask(found.rows[0]);
  }

  async activity(task: number, actor: string, kind: string, text: string): Promise<void> {
    await this.q(`INSERT INTO $S.activities (task_id, at, actor, kind, text) VALUES ($1, $2, $3, $4, $5)`, [task, now(), actor, kind, text.slice(0, 4000)]);
  }

  async artifact(task: number, actor: string, kind: string, url: string, title?: string): Promise<void> {
    await this.q(`INSERT INTO $S.artifacts (task_id, at, actor, kind, url, title) VALUES ($1, $2, $3, $4, $5, $6)`, [task, now(), actor, kind, url, title ?? null]);
    await this.q(`UPDATE $S.tasks SET updated_at = $2 WHERE id = $1`, [task, now()]);
  }

  async setBuzzRoot(task: number, root: string): Promise<void> {
    await this.q(`UPDATE $S.tasks SET buzz_root = $2 WHERE id = $1`, [task, root]);
  }

  /** Open tasks with a channel that aren't in Buzz yet (a post that failed, or a channel added later). */
  async unposted(limit = 20): Promise<Task[]> {
    const found = await this.q(`SELECT * FROM $S.tasks WHERE buzz_root IS NULL AND channel IS NOT NULL AND status NOT IN ('done', 'dismissed') ORDER BY id LIMIT ${limit}`);
    return found.rows.map(toTask);
  }

  /**
   * Open tasks whose rule has `stale_after_hours`, whose latest event still
   * matches the rule (e.g. a case still "Awaiting Confirmation"), and that
   * haven't changed or been nudged within that time.
   */
  async stale(config: SignalsConfig, at = now()): Promise<{ task: Task; text: string }[]> {
    const out: { task: Task; text: string }[] = [];
    for (const rule of config.rules) {
      if (!rule.stale_after_hours) continue;
      const cutoff = at - rule.stale_after_hours * 3600;
      const found = await this.q(
        `SELECT t.*, e.source AS e_source, e.external_id AS e_external_id, e.title AS e_title, e.url AS e_url, e.actor AS e_actor, e.account AS e_account, e.group_key AS e_group_key, e.payload AS e_payload, e.changed_at AS e_changed_at
         FROM $S.tasks t JOIN $S.events e ON e.id = t.latest_event
         WHERE t.rule_id = $1 AND t.status NOT IN ('done', 'dismissed') AND e.changed_at <= $2 AND (t.nudged_at IS NULL OR t.nudged_at <= $2)`,
        [rule.id, cutoff],
      );
      for (const row of found.rows) {
        const event: EventInput = { source: String(row.e_source), external_id: String(row.e_external_id), ...(row.e_title ? { title: String(row.e_title) } : {}), ...(row.e_url ? { url: String(row.e_url) } : {}), ...(row.e_actor ? { actor: String(row.e_actor) } : {}), ...(row.e_account ? { account: String(row.e_account) } : {}), ...(row.e_payload ? { payload: row.e_payload as Record<string, unknown> } : {}) };
        if (!matches(rule.when, event)) continue;
        const hours = Math.round((at - Number(row.e_changed_at)) / 3600);
        const text = rule.nudge ? fillText(rule.nudge, event, hours) : `No change in ${hours}h: ${event.title ?? event.external_id}`;
        out.push({ task: toTask(row), text });
      }
    }
    return out;
  }

  async nudged(task: number, text: string, at = now()): Promise<void> {
    await this.q(`UPDATE $S.tasks SET nudged_at = $2 WHERE id = $1`, [task, at]);
    await this.activity(task, "signals", "nudge", text);
  }

  async stats() {
    const found = await this.q<{ events: unknown; tasks: unknown; open: unknown; people: unknown }>(
      `SELECT (SELECT count(*) FROM $S.events) AS events, (SELECT count(*) FROM $S.tasks) AS tasks,
              (SELECT count(*) FROM $S.tasks WHERE status NOT IN ('done', 'dismissed')) AS open,
              (SELECT count(DISTINCT owner) FROM $S.sources WHERE enabled) AS people`,
    );
    const row = found.rows[0]!;
    return { events: Number(row.events), tasks: Number(row.tasks), open: Number(row.open), people: Number(row.people) };
  }
}

const fillText = (template: string, event: EventInput, hours: number) => template.replaceAll("{hours}", String(hours)).replace(/\{([a-z_][a-z0-9_.]*)\}/gi, (_, path: string) => {
  const [head, ...rest] = path.split(".");
  let value: unknown = head === "payload" ? event.payload : (event as Record<string, unknown>)[head!];
  for (const part of rest) value = value && typeof value === "object" ? (value as Record<string, unknown>)[part] : undefined;
  return value === undefined || value === null ? "" : String(value);
});

const num = (value: unknown): number | null => (value === null || value === undefined ? null : Number(value));
const numbers = (row: Row) => Object.fromEntries(Object.entries(row).map(([key, value]) => [key, typeof value === "bigint" || (/^(at|id|occurred_at|versions)$/.test(key) && value !== null) ? Number(value) : value]));

function toTask(row: Row): Task {
  return {
    id: Number(row.id),
    rule_id: String(row.rule_id),
    group_key: String(row.group_key),
    title: String(row.title),
    account: (row.account as string | null) ?? null,
    channel: (row.channel as string | null) ?? null,
    workstream: (row.workstream as string | null) ?? null,
    status: row.status as TaskStatus,
    created_by: String(row.created_by),
    created_at: Number(row.created_at),
    updated_at: Number(row.updated_at),
    last_event_at: Number(row.last_event_at),
    event_count: Number(row.event_count),
    buzz_root: (row.buzz_root as string | null) ?? null,
    nudged_at: num(row.nudged_at),
  };
}
