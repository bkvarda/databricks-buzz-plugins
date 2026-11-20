// The signals hub's store in Postgres (Lakebase in production, PGlite in
// tests). One schema, owned by the app's service principal, made on start.
//
// - sources: who turned on which source (the opt-in), and its last post.
// - events: one row per (owner, source, external_id); a changed content hash
//   is a new version, the same hash is only "seen again".
// - inbox: posts from poller jobs that write to Lakebase as their owner.
// - tasks: one per rule group across everyone (two people getting the same
//   ticket update share one task), with its Buzz thread once posted.
// - task_events, activities, artifacts: what led to a task and what was done.
import { createHash } from "node:crypto";
import { slackThreadKey, toMicros, type AccountIds, type AccountRecord, type Decision, DEFAULT_CLASSIFY_MIN, contentKey, namesAccount, decide, doneReason, doneWhenOf, type EventInput, type FieldChange, fieldChanges, finishes, handledBy, isOpen, matches, ruleApplies, watchedValue, type Mode, plainSlack, type Rule, SERIES_ASKER, SERIES_OPTIONS, type SeriesAnswer, seriesQuestion, type SignalsConfig, TASK_STATUSES, type TaskStatus, toSeconds } from "./model";

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
  /** The initiative it's part of, when someone said. */
  initiative: string | null;
  /** How agents handle it, from the team's preferences when it opened. */
  mode: Mode;
  status: TaskStatus;
  created_by: string;
  created_at: number;
  updated_at: number;
  last_event_at: number;
  event_count: number;
  buzz_root: string | null;
  nudged_at: number | null;
  /** The first agent reply the hub recorded in its thread (an event id). */
  agent_reply?: string | null;
  /** While it's waiting on input: the question, its choices, and who asked (an agent's hex pubkey, or a person). */
  question?: string | null;
  options?: readonly string[] | null;
  asked_by?: string | null;
  /** The recurring series it's part of (see Rule.series), when its rule has one. */
  series?: string | null;
}>;

/** A recurring series and what the team said about it. */
export type Series = Readonly<{
  key: string;
  rule_id: string;
  account: string | null;
  /** The title of its first task, to show. */
  title: string;
  /** always: open tasks for its events; never: don't; null: not decided (it asks). */
  answer: "always" | "never" | null;
  /** The task asking about it, while nobody has answered. */
  asked_task: number | null;
  /** The mode its tasks get once the team says yes. */
  mode: Mode;
  answered_by: string | null;
  answered_at: number | null;
  created_at: number;
}>;

/** Someone on a task: an agent (hex pubkey) asked to work on it, or a person (email) who changed it. */
/** Someone on a task. `assigned_at`: when a person (or an agent) made them its owner, as against an agent asked to help. */
export type TaskPerson = Readonly<{ kind: "agent" | "person"; key: string; label?: string; at: number; replied_at?: number; asked_at?: number; assigned_at?: number }>;

/** A task someone on the team handled: who, their reply, the agents taken off it, and `owner` when a person other than them still owns it. */
export type Handled = { task: Task; by: string; title?: string; url?: string; agents: string[]; owner?: string };

/** A reply someone on the team sent in a group's thread, as recorded. */
/** `at` in seconds; `micros` the same moment in microseconds (Slack's ts keeps them), for ordering it against the customer's messages. */
export type Reply = Readonly<{ group: string; event: number; owner: string; source: string; title: string | null; url: string | null; at: number; micros?: number }>;

export type Outcome = "new" | "changed" | "same" | "skipped";
/** A rule's classifier: the probability (0 to 1) that the event needs a task, or undefined when it can't tell. */
export type Classifier = (event: EventInput, classify: import("./model").Classify) => Promise<number | undefined>;

/** An event a classifier filtered out, as the hub lists them. */
export type FilteredEvent = Readonly<{ id: number; owner: string; source: string; external_id: string; title?: string; url?: string; actor?: string; account?: string; occurred_at: number; rule: string; score: number; filtered_at: number; channel?: string;
  /** The rule's classify question and the score it needed (the hub adds them from its config). */
  question?: string; min?: number }>;

export type IngestResult = Readonly<{
  received: number;
  new: number;
  changed: number;
  same: number;
  skipped: number;
  /** Events a rule's classifier judged not worth a task. */
  filtered: number;
  errors: { index: number; error: string }[];
  /** Tasks opened by this post. */
  created: Task[];
  /** Tasks an event of this post was added to. */
  /** `changes`: watched fields this event changed. `outgrown`: the task's own rule no longer applies to the event and no other `task` rule of its group took it over, with the watched fields' values now. */
  updated: { task: Task; title?: string; url?: string; changes?: FieldChange[]; outgrown?: { rule: string; values: { field: string; value: string }[] } }[];
  /** Tasks an event of this post finished (its rule's done_when.when), and why. */
  finished: { task: Task; reason: string }[];
  /** Tasks someone on the team handled themselves (done_when.by_owner): who, the event that shows it, and the agents taken off. */
  handled: Handled[];
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
    // Copies of one thing in several people's sources (see Rule.same_as): a copy key's task, and the other groups joined to a task.
    await this.q(`CREATE TABLE IF NOT EXISTS $S.copies (key text PRIMARY KEY, task_id bigint NOT NULL, at bigint NOT NULL)`);
    await this.q(`CREATE TABLE IF NOT EXISTS $S.group_links (group_key text PRIMARY KEY, task_id bigint NOT NULL, at bigint NOT NULL)`);
    await this.q(`CREATE TABLE IF NOT EXISTS $S.tasks (
      id bigserial PRIMARY KEY, rule_id text NOT NULL, group_key text NOT NULL UNIQUE, title text NOT NULL,
      account text, channel text, workstream text, status text NOT NULL DEFAULT 'open', created_by text NOT NULL,
      created_at bigint NOT NULL, updated_at bigint NOT NULL, last_event_at bigint NOT NULL, event_count int NOT NULL DEFAULT 0,
      latest_event bigint, buzz_root text, nudged_at bigint)`);
    await this.q(`ALTER TABLE $S.tasks ADD COLUMN IF NOT EXISTS initiative text`);
    await this.q(`ALTER TABLE $S.tasks ADD COLUMN IF NOT EXISTS mode text NOT NULL DEFAULT 'draft'`);
    // Account channels as their teams set them up (Set up account): names, domains, preferences, what agents learned.
    await this.q(`CREATE TABLE IF NOT EXISTS $S.accounts (
      name text PRIMARY KEY, channel text UNIQUE, aliases jsonb NOT NULL DEFAULT '[]', domains jsonb NOT NULL DEFAULT '[]',
      preferences text NOT NULL DEFAULT '', profile text NOT NULL DEFAULT '', updated_by text, updated_at bigint)`);
    await this.q(`ALTER TABLE $S.accounts ADD COLUMN IF NOT EXISTS agents jsonb NOT NULL DEFAULT '[]'`);
    // Ids in other systems, by kind: {"crm": ["0016100000AbCdE"]}.
    await this.q(`ALTER TABLE $S.accounts ADD COLUMN IF NOT EXISTS ids jsonb NOT NULL DEFAULT '{}'`);
    // Playbooks: how the team likes each workstream's work done (workstream → text).
    await this.q(`ALTER TABLE $S.accounts ADD COLUMN IF NOT EXISTS playbooks jsonb NOT NULL DEFAULT '{}'`);
    await this.q(`ALTER TABLE $S.accounts ADD COLUMN IF NOT EXISTS workstream_agents jsonb NOT NULL DEFAULT '{}'`);
    // The first reply an account's agent posted in the task's thread, once the hub has recorded it.
    await this.q(`ALTER TABLE $S.tasks ADD COLUMN IF NOT EXISTS agent_reply text`);
    // Needs input: what an agent (or a person) asked, its choices, and who asked (an agent's hex pubkey or a person).
    await this.q(`ALTER TABLE $S.tasks ADD COLUMN IF NOT EXISTS question text`);
    await this.q(`ALTER TABLE $S.tasks ADD COLUMN IF NOT EXISTS options jsonb`);
    await this.q(`ALTER TABLE $S.tasks ADD COLUMN IF NOT EXISTS asked_by text`);
    // Recurring series (a rule's `series`): asked once, and the answer kept.
    await this.q(`ALTER TABLE $S.tasks ADD COLUMN IF NOT EXISTS series text`);
    await this.q(`CREATE TABLE IF NOT EXISTS $S.series (
      key text PRIMARY KEY, rule_id text NOT NULL, account text, title text NOT NULL, answer text, asked_task bigint,
      mode text NOT NULL DEFAULT 'draft', answered_by text, answered_at bigint, created_at bigint NOT NULL)`);
    // An event of a series whose question is still open: held until the team answers.
    await this.q(`ALTER TABLE $S.events ADD COLUMN IF NOT EXISTS held_series text`);
    await this.q(`CREATE INDEX IF NOT EXISTS events_held ON $S.events (held_series) WHERE held_series IS NOT NULL`);
    // An event a rule's classifier judged not worth a task: the rule, its score, and when (see Rule.classify).
    await this.q(`ALTER TABLE $S.events ADD COLUMN IF NOT EXISTS filtered_rule text`);
    await this.q(`ALTER TABLE $S.events ADD COLUMN IF NOT EXISTS filtered_score real`);
    await this.q(`ALTER TABLE $S.events ADD COLUMN IF NOT EXISTS filtered_at bigint`);
    await this.q(`ALTER TABLE $S.events ADD COLUMN IF NOT EXISTS filtered_channel text`);
    await this.q(`CREATE INDEX IF NOT EXISTS events_filtered ON $S.events (filtered_at) WHERE filtered_at IS NOT NULL`);
    await this.q(`CREATE INDEX IF NOT EXISTS tasks_status ON $S.tasks (status, last_event_at)`);
    await this.q(`CREATE INDEX IF NOT EXISTS tasks_account ON $S.tasks (account, status)`);
    await this.q(`CREATE TABLE IF NOT EXISTS $S.task_events (task_id bigint NOT NULL, event_id bigint NOT NULL, version int NOT NULL, at bigint NOT NULL, PRIMARY KEY (task_id, event_id, version))`);
    await this.q(`CREATE TABLE IF NOT EXISTS $S.activities (id bigserial PRIMARY KEY, task_id bigint NOT NULL, at bigint NOT NULL, actor text NOT NULL, kind text NOT NULL, text text NOT NULL)`);
    await this.q(`CREATE INDEX IF NOT EXISTS activities_task ON $S.activities (task_id, at)`);
    await this.q(`CREATE TABLE IF NOT EXISTS $S.artifacts (id bigserial PRIMARY KEY, task_id bigint NOT NULL, at bigint NOT NULL, actor text NOT NULL, kind text NOT NULL, url text NOT NULL, title text)`);
    // Who works on a task: agents asked to (and when each first replied), and people who changed it.
    await this.q(`CREATE TABLE IF NOT EXISTS $S.task_people (
      task_id bigint NOT NULL, kind text NOT NULL, key text NOT NULL, label text, at bigint NOT NULL, replied_at bigint, PRIMARY KEY (task_id, kind, key))`);
    // When an agent was asked again (given the input it asked for): only its replies after this count.
    await this.q(`ALTER TABLE $S.task_people ADD COLUMN IF NOT EXISTS asked_at bigint`);
    // Owners someone chose (assigned_at), and who was taken off (removed_at): kept, so nothing puts them back but assigning them again.
    await this.q(`ALTER TABLE $S.task_people ADD COLUMN IF NOT EXISTS assigned_at bigint`);
    await this.q(`ALTER TABLE $S.task_people ADD COLUMN IF NOT EXISTS removed_at bigint`);
    // Replies someone on the team sent in a group's thread (done_when.by_owner), kept until they're decided:
    // applied_at once checked against the task (closed_task when they closed it). One with no task yet waits for the task to open.
    await this.q(`CREATE TABLE IF NOT EXISTS $S.replies (
      group_key text NOT NULL, event_id bigint NOT NULL, owner text NOT NULL, source text NOT NULL, title text, url text,
      at bigint NOT NULL, seen_at bigint NOT NULL, applied_at bigint, closed_task bigint, PRIMARY KEY (group_key, event_id))`);
    await this.q(`CREATE INDEX IF NOT EXISTS replies_event ON $S.replies (event_id) WHERE applied_at IS NULL`);
    // When it happened in microseconds, for ordering a team reply against a customer's message in the same second (Slack's ts).
    // Rows from before it have none: their second stands in (occurred_at * 1e6).
    await this.q(`ALTER TABLE $S.events ADD COLUMN IF NOT EXISTS occurred_us bigint`);
    await this.q(`ALTER TABLE $S.replies ADD COLUMN IF NOT EXISTS at_us bigint`);
    await this.setupInbox();
  }

  /**
   * The inbox: how a poller job reaches the hub when it can't call the app.
   * Databricks Apps only take OAuth tokens, and a job's token isn't one, but
   * the job can log in to Lakebase as its owner's own Postgres role. Each
   * person may insert only `kind` and `body`, so `owner` is always their
   * role (current_user), and row-level security shows them only their own
   * inbox rows and sources. The hub owns the tables, so it reads them all.
   */
  private async setupInbox(): Promise<void> {
    await this.q(`CREATE TABLE IF NOT EXISTS $S.inbox (
      id bigserial PRIMARY KEY, owner text NOT NULL DEFAULT current_user, kind text NOT NULL CHECK (kind IN ('events', 'cursor')),
      body jsonb NOT NULL, at bigint NOT NULL DEFAULT extract(epoch FROM now())::bigint, done_at bigint, result jsonb)`);
    await this.q(`CREATE INDEX IF NOT EXISTS inbox_todo ON $S.inbox (id) WHERE done_at IS NULL`);
    await this.q(`ALTER TABLE $S.inbox ENABLE ROW LEVEL SECURITY`);
    await this.q(`DROP POLICY IF EXISTS own_rows ON $S.inbox`);
    await this.q(`CREATE POLICY own_rows ON $S.inbox USING (lower(owner) = lower(current_user)) WITH CHECK (lower(owner) = lower(current_user))`);
    await this.q(`ALTER TABLE $S.sources ENABLE ROW LEVEL SECURITY`);
    await this.q(`DROP POLICY IF EXISTS own_rows ON $S.sources`);
    await this.q(`CREATE POLICY own_rows ON $S.sources FOR SELECT USING (owner = lower(current_user))`);
    await this.q(`GRANT USAGE ON SCHEMA ${this.schema} TO PUBLIC`);
    await this.q(`GRANT SELECT (id, kind, at, done_at, result), INSERT (kind, body) ON $S.inbox TO PUBLIC`);
    await this.q(`GRANT USAGE ON SEQUENCE $S.inbox_id_seq TO PUBLIC`);
    await this.q(`GRANT SELECT (source, enabled, cursor, last_post_at, last_error) ON $S.sources TO PUBLIC`);
    // Every account's ids (registered and config accounts), which pollers fill into their queries; the hub keeps it current (publishIds).
    await this.q(`CREATE TABLE IF NOT EXISTS $S.account_ids (kind text NOT NULL, id text NOT NULL, PRIMARY KEY (kind, id))`);
    await this.q(`GRANT SELECT ON $S.account_ids TO PUBLIC`);
  }

  /**
   * Whether a person has a Postgres role in the hub's database, which their
   * poller job logs in as (see setupInbox). Roles are matched without case,
   * as the row-level security policies match owners.
   */
  async hasRole(identity: string): Promise<boolean> {
    const found = await this.db.query(`SELECT 1 FROM pg_roles WHERE lower(rolname) = lower($1) LIMIT 1`, [identity]);
    return found.rows.length > 0;
  }

  /**
   * Creates a person's Postgres role with Lakebase's databricks_create_role,
   * which needs the databricks_auth extension and CREATEROLE for the hub's
   * role. Throws (with Postgres's reason) when it can't.
   */
  async createRole(identity: string): Promise<void> {
    await this.db.query(`SELECT databricks_create_role($1, 'USER')`, [identity]);
  }

  /** Replaces the ids pollers read (kind → ids). */
  async publishIds(ids: Readonly<Record<string, readonly string[]>>): Promise<void> {
    const rows = Object.entries(ids).flatMap(([kind, values]) => values.map((id) => [kind, id]));
    await this.q(`DELETE FROM $S.account_ids`);
    if (rows.length) await this.q(`INSERT INTO $S.account_ids (kind, id) SELECT * FROM unnest($1::text[], $2::text[]) ON CONFLICT DO NOTHING`, [rows.map((row) => row[0]), rows.map((row) => row[1])]);
  }

  /** Inbox posts the hub hasn't handled yet, oldest first. */
  async inbox(limit = 20): Promise<{ id: number; owner: string; kind: "events" | "cursor"; body: unknown }[]> {
    const found = await this.q<{ id: unknown; owner: string; kind: "events" | "cursor"; body: unknown }>(`SELECT id, owner, kind, body FROM $S.inbox WHERE done_at IS NULL ORDER BY id LIMIT $1`, [limit]);
    return found.rows.map((row) => ({ ...row, id: Number(row.id) }));
  }

  async inboxDone(id: number, result: unknown, at = now()): Promise<void> {
    await this.q(`UPDATE $S.inbox SET done_at = $2, result = $3 WHERE id = $1`, [id, at, JSON.stringify(result ?? null)]);
  }

  /** Deletes handled inbox posts older than `days`. */
  async pruneInbox(days = 7, at = now()): Promise<void> {
    await this.q(`DELETE FROM $S.inbox WHERE done_at IS NOT NULL AND done_at < $1`, [at - days * 86400]);
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
    if (!enabled && forget) {
      // Its replies too, decided or not: a forgotten reply mustn't close (or keep closed) anything.
      await this.q(`DELETE FROM $S.replies WHERE (owner = lower($1) AND source = $2) OR event_id IN (SELECT id FROM $S.events WHERE owner = $1 AND source = $2)`, [owner, source]);
      await this.q(`DELETE FROM $S.events WHERE owner = $1 AND source = $2`, [owner, source]);
    }
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
  async record(owner: string, event: EventInput): Promise<{ outcome: Exclude<Outcome, "skipped">; id: number; version: number; taskId: number | null; before?: EventInput }> {
    const hash = contentHash(event);
    const at = now();
    const occurred = toSeconds(event.occurred_at);
    const micros = toMicros(event.occurred_at);
    const values = [owner, event.source, event.external_id, hash, occurred, at, event.title ?? null, event.url ?? null, event.actor ?? null, event.account ?? null, event.group_key ?? null, event.payload ? JSON.stringify(event.payload) : null, Number.isNaN(micros) ? null : String(micros)];
    // xmax = 0 only for a row this statement inserted.
    const found = await this.q<{ id: unknown; versions: number; task_id: unknown; before: unknown; inserted: boolean; changed: boolean }>(
      `WITH previous AS (SELECT content_hash, occurred_at, title, url, actor, account, payload FROM $S.events WHERE owner = $1 AND source = $2 AND external_id = $3)
       INSERT INTO $S.events (owner, source, external_id, content_hash, occurred_at, first_seen, last_seen, changed_at, title, url, actor, account, group_key, payload, occurred_us)
       VALUES ($1, $2, $3, $4, $5, $6, $6, $6, $7, $8, $9, $10, $11, $12, $13::bigint)
       ON CONFLICT (owner, source, external_id) DO UPDATE SET
         last_seen = excluded.last_seen,
         content_hash = excluded.content_hash,
         versions = $S.events.versions + CASE WHEN $S.events.content_hash = excluded.content_hash THEN 0 ELSE 1 END,
         changed_at = CASE WHEN $S.events.content_hash = excluded.content_hash THEN $S.events.changed_at ELSE excluded.changed_at END,
         occurred_at = excluded.occurred_at, occurred_us = excluded.occurred_us, title = excluded.title, url = excluded.url, actor = excluded.actor,
         account = excluded.account, group_key = excluded.group_key, payload = excluded.payload
       RETURNING id, versions, task_id,
         (SELECT row_to_json(previous) FROM previous) AS before,
         NOT EXISTS (SELECT 1 FROM previous) AS inserted,
         COALESCE((SELECT content_hash FROM previous) <> $4, false) AS changed`,
      values,
    );
    const row = found.rows[0]!;
    // The event as it was before this version (pg gives row_to_json as an object, PGlite may give text).
    const raw = typeof row.before === "string" ? (JSON.parse(row.before) as Row) : (row.before as Row | null);
    const before = raw ? toEvent({ ...raw, source: event.source, external_id: event.external_id }) : undefined;
    return { outcome: row.inserted ? "new" : row.changed ? "changed" : "same", id: Number(row.id), version: row.versions, taskId: num(row.task_id), ...(before && { before }) };
  }

  /**
   * Takes a post of events from one person: records each, and runs the rules
   * on the new and changed ones. Events for a source they haven't turned on
   * are skipped (that's the opt-in). Returns what changed, for Buzz.
   */
  async ingest(owner: string, events: readonly EventInput[], config: SignalsConfig, classifier?: Classifier): Promise<IngestResult> {
    const result: IngestResult = { received: events.length, new: 0, changed: 0, same: 0, skipped: 0, filtered: 0, errors: [], created: [], updated: [], finished: [], handled: [], firstRun: false };
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
        const replies = handledBy(config, event, owner);
        if (recorded.outcome === "same") {
          // Seen before, but a closure it started may not have finished (a write failed): finish it.
          if (replies.length) {
            for (const { group } of replies) await this.recordReply(group, recorded.id, owner, event, true);
            for (const reply of await this.pendingReplies({ event: recorded.id })) await this.applyReply(reply, result);
          }
          continue;
        }
        const placed = await this.place(owner, event, recorded, config, state.firstRun, classifier, () => counts.filtered++);
        // An event can finish a task even when its rule no longer matches it (a resolved ticket).
        let finishedHere = false;
        for (const { rule, group } of finishes(config, event)) {
          const task = placed?.task.group_key === group ? placed.task : await this.taskByGroup(group);
          if (!task || !isOpen(task.status) || (task.series && task.asked_by === SERIES_ASKER)) continue;
          await this.attach(task.id, recorded.id, recorded.version, toSeconds(event.occurred_at));
          const reason = doneReason(rule.done_when, event, { at: now(), sweep: false })!;
          const done = await this.finish(task.id, reason);
          if (task.id === placed?.task.id) finishedHere = true;
          // A task its own first event finishes (a ticket already resolved) is never posted.
          if (done && !(placed?.opened && task.id === placed.task.id)) result.finished.push({ task: done, reason });
        }
        // Someone on the team did the work themselves (their reply in the thread): done, theirs, and its agents off it.
        // (Recorded first, so a reply that comes before the customer's message, or a closure a failed write cut short, is still decided.)
        for (const { group } of replies) {
          const reply = await this.recordReply(group, recorded.id, owner, event);
          const done = await this.applyReply(reply, result);
          if (done && done.task.id === placed?.task.id) finishedHere = true;
        }
        if (!placed || finishedHere) continue;
        let task = placed.task;
        if (placed.opened) opened.add(task.id);
        else if (!isOpen(task.status) && placed.create && recorded.outcome === "new" && !doneReason(doneWhenOf(config, placed.rule), event, { at: now(), sweep: true }) && !(await this.answeredAfter(task.id, toMicros(event.occurred_at)))) {
          // (Not for a message older than the team's reply that closed it: that reply answered it.)
          // (A finished task stays done when a late event for it is itself past done, like a meeting's notes after it ended.)
          await this.setStatus(task.id, "open", "signals", "Opened again: a new event came in.");
        }
        // What the watched fields were: this event's last version, or else the task's latest event (another event of its group).
        let changes: FieldChange[] = [];
        let outgrown: { rule: string; values: { field: string; value: string }[] } | undefined;
        if (!placed.opened) {
          const watched = [...(placed.rule.watch ?? []), ...(config.rules.find((rule) => rule.id === task.rule_id)?.watch ?? [])];
          if (watched.length) changes = fieldChanges(watched, recorded.before ?? (await this.latestEvent(task.id)), event);
          // When a watched field changed and the event now matches another `task` rule of the group, that rule takes the task over, with its playbook.
          // (Only then: groups without watched fields keep their tasks on the rule that opened them, as before.)
          if (changes.length && placed.rule.id !== task.rule_id && placed.rule.action === "task" && isOpen(task.status)) task = await this.refile(task, placed.rule);
          // Still on its old rule, and that rule doesn't apply now (a case back to Open, say): its playbook would be the wrong one.
          const own = config.rules.find((rule) => rule.id === task.rule_id);
          if (changes.length && own && task.rule_id !== placed.rule.id && !ruleApplies(config, own, event, owner))
            outgrown = { rule: own.id, values: [...new Set(watched)].map((path) => ({ field: path.replace(/^payload\./, ""), value: watchedValue(event, path) })) };
        }
        await this.attach(task.id, recorded.id, recorded.version, toSeconds(event.occurred_at));
        if (placed.opened) {
          // Someone on the team already replied in its thread (their reply came in first): done, and never posted.
          let closed = false;
          for (const reply of await this.pendingReplies({ group: task.group_key })) if (await this.applyReply(reply)) closed = true;
          if (closed) {
            opened.delete(task.id);
            continue;
          }
        }
        const fresh = (await this.task(task.id))!;
        touched.set(fresh.id, fresh);
        if (!opened.has(fresh.id)) result.updated.push({ task: fresh, ...(event.title && { title: event.title }), ...(event.url && { url: event.url }), ...(changes.length && { changes }), ...(outgrown && { outgrown }) });
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

  /**
   * Runs the rules on a recorded event and finds (or opens) its task. A rule
   * with `series` asks about a new recurring series once: its first event's
   * task asks the team, and the series' other events are held until they
   * answer; a series they said never to work on opens no tasks.
   */
  private async place(owner: string, event: EventInput, recorded: { id: number }, config: SignalsConfig, firstRun: boolean, classifier?: Classifier, filtered?: () => void): Promise<{ task: Task; opened: boolean; create: boolean; rule: Rule } | undefined> {
    const decision = decide(config, event, { firstRun, owner });
    if (decision.kind === "none") return undefined;
    const rule = decision.rule;
    const found = await this.taskByGroup(decision.group);
    if (found) {
      if (decision.same) await this.copyOf(decision.same, found.id);
      return { task: found, opened: false, create: decision.create, rule };
    }
    // Another person's copy of it (the same mail in their mailbox) has a task: this group joins it.
    const copy = decision.same ? await this.copyTask(decision.same) : undefined;
    if (copy) {
      await this.q(`INSERT INTO $S.group_links (group_key, task_id, at) VALUES ($1, $2, $3) ON CONFLICT (group_key) DO NOTHING`, [decision.group, copy.id, now()]);
      await this.activity(copy.id, "signals", "joined", `${owner}'s copy joined it (${event.source}).`);
      return { task: copy, opened: false, create: decision.create, rule };
    }
    if (!decision.create) return undefined;
    const placed = await this.placeNew(owner, event, recorded, decision, classifier, filtered);
    if (placed && decision.same) await this.copyOf(decision.same, placed.task.id);
    return placed;
  }

  /** Records that a copy key's thing is on a task (the first task it was on keeps it). */
  private async copyOf(key: string, task: number): Promise<void> {
    await this.q(`INSERT INTO $S.copies (key, task_id, at) VALUES ($1, $2, $3) ON CONFLICT (key) DO NOTHING`, [key, task, now()]);
  }

  private async copyTask(key: string): Promise<Task | undefined> {
    const found = await this.q(`SELECT t.* FROM $S.copies c JOIN $S.tasks t ON t.id = c.task_id WHERE c.key = $1`, [key]);
    return found.rows[0] ? toTask(found.rows[0]) : undefined;
  }

  private async placeNew(owner: string, event: EventInput, recorded: { id: number }, decision: Extract<Decision, { kind: "task" }>, classifier?: Classifier, filtered?: () => void): Promise<{ task: Task; opened: boolean; create: boolean; rule: Rule } | undefined> {
    const rule = decision.rule;
    if (rule.classify && classifier) {
      // Fails open: no score (the model is down, say) opens the task.
      const score = await classifier(event, rule.classify).catch(() => undefined);
      const min = rule.classify.min ?? DEFAULT_CLASSIFY_MIN;
      if (typeof score === "number" && Number.isFinite(score) && score < min) {
        // The channel its task would have gone to, so that channel's board can list it.
        await this.q(`UPDATE $S.events SET filtered_rule = $2, filtered_score = $3, filtered_at = $4, filtered_channel = $5 WHERE id = $1`, [recorded.id, rule.id, score, now(), decision.channel ?? null]);
        filtered?.();
        return undefined;
      }
      if (typeof score === "number") await this.q(`UPDATE $S.events SET filtered_rule = NULL, filtered_score = $2, filtered_at = NULL, filtered_channel = NULL WHERE id = $1`, [recorded.id, score]);
    }
    const input = { rule: decision.rule.id, group: decision.group, title: decision.title, account: decision.account?.name, channel: decision.channel, workstream: decision.rule.workstream, mode: decision.mode, by: owner, at: toSeconds(event.occurred_at) };
    if (!decision.series) return { task: await this.openTask(input), opened: true, create: true, rule };
    const series = await this.seriesFor(decision.series);
    if (series?.answer === "never") return undefined;
    if (series?.answer === "always") return { task: await this.openTask({ ...input, series: decision.series }), opened: true, create: true, rule };
    if (series?.asked_task) {
      await this.q(`UPDATE $S.events SET held_series = $2 WHERE id = $1`, [recorded.id, decision.series]);
      return undefined;
    }
    // A new (or undecided) series: this task asks the team, in ask mode so no agent starts on it yet.
    const asking = await this.openTask({ ...input, mode: "ask", series: decision.series });
    await this.q(
      `INSERT INTO $S.series (key, rule_id, account, title, asked_task, mode, created_at) VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (key) DO UPDATE SET asked_task = EXCLUDED.asked_task, title = EXCLUDED.title, mode = EXCLUDED.mode`,
      [decision.series, decision.rule.id, decision.account?.name ?? null, decision.title, asking.id, decision.mode, now()],
    );
    return { task: (await this.setQuestion(asking.id, SERIES_ASKER, { question: seriesQuestion(decision.title), options: SERIES_OPTIONS, by: SERIES_ASKER }))!, opened: true, create: true, rule };
  }

  private async openTask(input: { rule: string; group: string; title: string; account?: string; channel?: string; workstream?: string; mode: Mode; by: string; at: number; series?: string }): Promise<Task> {
    const at = now();
    const found = await this.q(
      `INSERT INTO $S.tasks (rule_id, group_key, title, account, channel, workstream, mode, created_by, created_at, updated_at, last_event_at, series)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $9, $10, $11) ON CONFLICT (group_key) DO UPDATE SET updated_at = $S.tasks.updated_at RETURNING *`,
      [input.rule, input.group, input.title, input.account ?? null, input.channel ?? null, input.workstream ?? null, input.mode, input.by, at, Number.isNaN(input.at) ? at : input.at, input.series ?? null],
    );
    const task = toTask(found.rows[0]!);
    await this.activity(task.id, "signals", "opened", `Opened by rule ${input.rule}.`);
    return task;
  }

  /** Moves a task to another rule of its group (its workstream too, when that rule names one), as a later event matched that rule. */
  private async refile(task: Task, rule: Rule): Promise<Task> {
    const found = await this.q(`UPDATE $S.tasks SET rule_id = $2, workstream = COALESCE($3, workstream), updated_at = $4 WHERE id = $1 RETURNING *`, [task.id, rule.id, rule.workstream ?? null, now()]);
    await this.activity(task.id, "signals", "rule", `Now under rule ${rule.id}: a new event matched it.`);
    return found.rows[0] ? toTask(found.rows[0]) : task;
  }

  private async attach(task: number, event: number, version: number, at: number): Promise<void> {
    const inserted = await this.q(`INSERT INTO $S.task_events (task_id, event_id, version, at) VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING RETURNING task_id`, [task, event, version, now()]);
    if (!inserted.rows.length) return;
    await this.q(`UPDATE $S.events SET task_id = $1 WHERE id = $2`, [task, event]);
    await this.q(`UPDATE $S.tasks SET event_count = event_count + 1, latest_event = $2, last_event_at = GREATEST(last_event_at, $3), updated_at = $4 WHERE id = $1`, [task, event, Number.isNaN(at) ? now() : at, now()]);
  }

  /** The task a group's events go to: the one it opened, or the one it joined as a copy of another person's. */
  async taskByGroup(group: string): Promise<Task | undefined> {
    const found = await this.q(`SELECT * FROM $S.tasks WHERE group_key = $1`, [group]);
    if (found.rows[0]) return toTask(found.rows[0]);
    const linked = await this.q(`SELECT t.* FROM $S.group_links l JOIN $S.tasks t ON t.id = l.task_id WHERE l.group_key = $1`, [group]);
    if (linked.rows[0]) return toTask(linked.rows[0]);
    return this.legacySlackTask(group);
  }

  /**
   * A Slack task from before threads were keyed by channel and full root ts:
   * the old example source keyed one by a second, `rule|1795000050`, the root's
   * or (for a task a reply opened) that reply's own. For a new key
   * (`rule|C1:1795000000.123456`) it looks for old-keyed tasks of the rule
   * holding a Slack message whose stored permalink names this thread, and
   * links the new key to the one it finds, so a customer's message and a team
   * reply in the thread both reach it. Only when there's exactly one, and
   * every Slack message on it names this thread: a task that mixed threads
   * (two in one second), or has a message without a permalink, is left alone.
   */
  private async legacySlackTask(group: string): Promise<Task | undefined> {
    const key = /^(.*)\|([A-Z0-9]+):(\d{10})\.(\d{6})$/i.exec(group);
    if (!key) return undefined;
    const [, rule, channel, seconds, micros] = key as unknown as [string, string, string, string, string];
    const thread = `${channel}:${seconds}.${micros}`;
    const like = (text: string) => text.replace(/[\\%_]/g, (c) => `\\${c}`);
    const candidates = await this.q(
      `SELECT DISTINCT t.* FROM $S.events e JOIN $S.tasks t ON t.id = e.task_id
       WHERE (e.source = 'slack' OR e.source LIKE 'slack.%') AND e.url LIKE $1
         AND (e.url LIKE $2 OR e.url LIKE $3) AND t.group_key LIKE $4 AND t.group_key ~ '\\|[0-9]{10}$' LIMIT 5`,
      [`%/archives/${like(channel)}/p%`, `%thread_ts=${seconds}.${micros}%`, `%/archives/${like(channel)}/p${seconds}${micros}%`, `${like(rule)}|%`],
    );
    const found: Task[] = [];
    for (const row of candidates.rows) {
      const task = toTask(row);
      if (task.group_key.slice(0, task.group_key.lastIndexOf("|")) !== rule) continue;
      const messages = await this.q<{ url: unknown }>(
        `SELECT DISTINCT e.url FROM $S.task_events te JOIN $S.events e ON e.id = te.event_id WHERE te.task_id = $1 AND (e.source = 'slack' OR e.source LIKE 'slack.%')`,
        [task.id],
      );
      const threads = new Set(messages.rows.map((message) => slackThreadKey(typeof message.url === "string" ? message.url : undefined) ?? ""));
      if (threads.size === 1 && threads.has(thread)) found.push(task);
    }
    if (found.length !== 1) return undefined;
    await this.q(`INSERT INTO $S.group_links (group_key, task_id, at) VALUES ($1, $2, $3) ON CONFLICT (group_key) DO NOTHING`, [group, found[0]!.id, now()]);
    const linked = await this.q(`SELECT t.* FROM $S.group_links l JOIN $S.tasks t ON t.id = l.task_id WHERE l.group_key = $1`, [group]);
    return linked.rows[0] ? toTask(linked.rows[0]) : undefined;
  }

  async task(id: number): Promise<Task | undefined> {
    const found = await this.q(`SELECT * FROM $S.tasks WHERE id = $1`, [id]);
    return found.rows[0] ? toTask(found.rows[0]) : undefined;
  }

  async tasks(filter: Readonly<{ status?: string; account?: string; channel?: string; workstream?: string; initiative?: string; open?: boolean; limit?: number }> = {}): Promise<Task[]> {
    const where: string[] = [];
    const values: unknown[] = [];
    if (filter.workstream) where.push(`lower(workstream) = lower($${values.push(filter.workstream)})`);
    if (filter.initiative) where.push(`lower(initiative) = lower($${values.push(filter.initiative)})`);
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
    const shown = (row: Row): Row => ({ ...numbers(row), ...(typeof row.title === "string" && { title: plainSlack(row.title) }), ...(typeof row.text === "string" && { text: plainSlack(row.text) }) });
    return { task, events: events.rows.map(shown), activities: activities.rows.map(shown), artifacts: artifacts.rows.map(numbers) };
  }

  async setStatus(id: number, status: TaskStatus, actor: string, note?: string): Promise<Task | undefined> {
    if (!TASK_STATUSES.includes(status)) throw new Error(`status must be one of ${TASK_STATUSES.join(", ")}`);
    const found = await this.q(`UPDATE $S.tasks SET status = $2, updated_at = $3 WHERE id = $1 RETURNING *`, [id, status, now()]);
    if (!found.rows[0]) return undefined;
    await this.activity(id, actor, "status", note ? `${status}: ${note}` : status);
    return toTask(found.rows[0]);
  }

  /** Files a task under a workstream or initiative ("" clears it). */
  async file(id: number, actor: string, fields: Readonly<{ workstream?: string; initiative?: string }>): Promise<Task | undefined> {
    let task: Task | undefined;
    for (const key of ["workstream", "initiative"] as const) {
      const value = fields[key];
      if (value === undefined) continue;
      const found = await this.q(`UPDATE $S.tasks SET ${key} = $2, updated_at = $3 WHERE id = $1 RETURNING *`, [id, value.trim().slice(0, 200) || null, now()]);
      if (!found.rows[0]) return undefined;
      task = toTask(found.rows[0]);
      await this.activity(id, actor, key, value.trim() ? `${key}: ${value.trim()}` : `${key} cleared`);
    }
    return task ?? (await this.task(id));
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

  /** Posted auto and draft tasks of an account with no agent reply recorded yet (opened within `days`). */
  async untouched(days = 7, at = now(), limit = 50): Promise<Task[]> {
    const found = await this.q(
      `SELECT * FROM $S.tasks WHERE buzz_root IS NOT NULL AND agent_reply IS NULL AND account IS NOT NULL AND mode IN ('auto', 'draft')
         AND status NOT IN ('done', 'dismissed') AND created_at >= $1 ORDER BY id LIMIT ${limit}`,
      [at - days * 86400],
    );
    return found.rows.map(toTask);
  }

  /**
   * Posted open tasks an agent may still reply to: opened within `days` with no
   * agent reply recorded yet, or with an agent asked (or asked again, given
   * input) within `days` that hasn't replied since.
   */
  async awaitingAgents(days = 7, at = now(), limit = 50): Promise<Task[]> {
    const found = await this.q(
      `SELECT * FROM $S.tasks t WHERE buzz_root IS NOT NULL AND status NOT IN ('done', 'dismissed')
         AND ((created_at >= $1 AND agent_reply IS NULL AND account IS NOT NULL AND mode IN ('auto', 'draft'))
           OR EXISTS (SELECT 1 FROM $S.task_people p WHERE p.task_id = t.id AND p.kind = 'agent' AND p.replied_at IS NULL AND p.removed_at IS NULL AND COALESCE(p.asked_at, t.created_at) >= $1))
         ORDER BY id LIMIT ${limit}`,
      [at - days * 86400],
    );
    return found.rows.map(toTask);
  }

  /** Adds people to a task (agents by hex pubkey, people by email); ones already on it, or taken off it, stay as they were. */
  async addPeople(task: number, people: readonly Readonly<{ kind: "agent" | "person"; key: string; label?: string }>[]): Promise<void> {
    for (const person of people)
      await this.q(`INSERT INTO $S.task_people (task_id, kind, key, label, at) VALUES ($1, $2, $3, $4, $5) ON CONFLICT DO NOTHING`, [task, person.kind, person.key, person.label ?? null, now()]);
  }

  /**
   * Puts someone on a task by a person's choice: back on it if they were taken
   * off. An agent is asked from now (only its replies since count). `owner`:
   * made its owner, as against asked to help.
   */
  async assign(task: number, kind: "agent" | "person", key: string, owner: boolean, at = now()): Promise<void> {
    await this.q(
      `INSERT INTO $S.task_people (task_id, kind, key, at, asked_at, assigned_at) VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (task_id, kind, key) DO UPDATE SET removed_at = NULL, replied_at = CASE WHEN EXCLUDED.kind = 'agent' THEN NULL ELSE $S.task_people.replied_at END,
         asked_at = COALESCE(EXCLUDED.asked_at, $S.task_people.asked_at), assigned_at = COALESCE(EXCLUDED.assigned_at, $S.task_people.assigned_at)`,
      [task, kind, key, at, kind === "agent" ? at : null, owner ? at : null],
    );
  }

  /** Takes someone off a task. The row stays, marked removed, so nothing but assigning them again puts them back. */
  async unassign(task: number, key: string, kind: TaskPerson["kind"], at = now()): Promise<TaskPerson["kind"] | undefined> {
    const found = await this.q(`UPDATE $S.task_people SET removed_at = $3, assigned_at = NULL WHERE task_id = $1 AND key = $2 AND removed_at IS NULL RETURNING kind`, [task, key, at]);
    if (found.rows[0]) return found.rows[0].kind as TaskPerson["kind"];
    // Not on it yet (an account agent the hub would still wait on, say): recorded as taken off, so it isn't.
    await this.q(`INSERT INTO $S.task_people (task_id, kind, key, at, removed_at) VALUES ($1, $2, $3, $4, $4) ON CONFLICT DO NOTHING`, [task, kind, key, at]);
    return undefined;
  }

  /** The agents taken off each of the tasks: the hub doesn't wake or wait on them. */
  async removed(tasks: readonly number[]): Promise<Map<number, Set<string>>> {
    const out = new Map<number, Set<string>>();
    if (!tasks.length) return out;
    const found = await this.q(`SELECT task_id, key FROM $S.task_people WHERE task_id = ANY($1::bigint[]) AND removed_at IS NOT NULL`, [tasks]);
    for (const row of found.rows) {
      const id = Number(row.task_id);
      out.set(id, (out.get(id) ?? new Set()).add(String(row.key)));
    }
    return out;
  }

  /** Records that an agent replied in the task's thread (adding it to the task if it wasn't on it). */
  async replied(task: number, agent: string, at = now()): Promise<void> {
    await this.q(
      `INSERT INTO $S.task_people (task_id, kind, key, at, replied_at) VALUES ($1, 'agent', $2, $3, $3)
       ON CONFLICT (task_id, kind, key) DO UPDATE SET replied_at = COALESCE($S.task_people.replied_at, EXCLUDED.replied_at)`,
      [task, agent, at],
    );
  }

  /** The people on each of the tasks. */
  async people(tasks: readonly number[]): Promise<Map<number, TaskPerson[]>> {
    const out = new Map<number, TaskPerson[]>();
    if (!tasks.length) return out;
    // Who's on them now: not those taken off.
    const found = await this.q(`SELECT task_id, kind, key, label, at, replied_at, asked_at, assigned_at FROM $S.task_people WHERE task_id = ANY($1::bigint[]) AND removed_at IS NULL ORDER BY at, key`, [tasks]);
    for (const row of found.rows) {
      const id = Number(row.task_id);
      out.set(id, [...(out.get(id) ?? []), { kind: row.kind as TaskPerson["kind"], key: String(row.key), ...(row.label ? { label: String(row.label) } : {}), at: Number(row.at), ...(row.replied_at !== null && row.replied_at !== undefined && { replied_at: Number(row.replied_at) }), ...(row.asked_at !== null && row.asked_at !== undefined && { asked_at: Number(row.asked_at) }), ...(row.assigned_at !== null && row.assigned_at !== undefined && { assigned_at: Number(row.assigned_at) }) }]);
    }
    return out;
  }

  /** Each task's latest event, artifacts (newest first) and latest activity, for the tasks board. */
  async extras(tasks: readonly number[]): Promise<Map<number, { event?: EventInput; artifacts: { at: number; actor: string; kind: string; url: string; title?: string }[]; activity?: { at: number; actor: string; kind: string; text: string } }>> {
    const out = new Map(tasks.map((id) => [id, { artifacts: [] as { at: number; actor: string; kind: string; url: string; title?: string }[] } as { event?: EventInput; artifacts: { at: number; actor: string; kind: string; url: string; title?: string }[]; activity?: { at: number; actor: string; kind: string; text: string } }]));
    if (!tasks.length) return out;
    const events = await this.q(`SELECT t.id AS task_id, e.* FROM $S.tasks t JOIN $S.events e ON e.id = t.latest_event WHERE t.id = ANY($1::bigint[])`, [tasks]);
    for (const row of events.rows) out.get(Number(row.task_id))!.event = toEvent(row);
    const artifacts = await this.q(`SELECT task_id, at, actor, kind, url, title FROM $S.artifacts WHERE task_id = ANY($1::bigint[]) ORDER BY at DESC, id DESC`, [tasks]);
    for (const row of artifacts.rows) out.get(Number(row.task_id))!.artifacts.push({ at: Number(row.at), actor: String(row.actor), kind: String(row.kind), url: String(row.url), ...(row.title ? { title: String(row.title) } : {}) });
    const activities = await this.q(`SELECT DISTINCT ON (task_id) task_id, at, actor, kind, text FROM $S.activities WHERE task_id = ANY($1::bigint[]) ORDER BY task_id, at DESC, id DESC`, [tasks]);
    for (const row of activities.rows) out.get(Number(row.task_id))!.activity = { at: Number(row.at), actor: String(row.actor), kind: String(row.kind), text: String(row.text) };
    return out;
  }

  /** Who changed each task (activity actors other than the hub), first first. */
  async actors(tasks: readonly number[]): Promise<Map<number, string[]>> {
    const out = new Map<number, string[]>();
    if (!tasks.length) return out;
    const found = await this.q(`SELECT task_id, actor, min(at) AS at FROM $S.activities WHERE task_id = ANY($1::bigint[]) AND actor NOT IN ('hub', 'signals') GROUP BY task_id, actor ORDER BY task_id, at`, [tasks]);
    for (const row of found.rows) out.set(Number(row.task_id), [...(out.get(Number(row.task_id)) ?? []), String(row.actor)]);
    return out;
  }

  /** A channel's tasks for the board: every open one, and those done or dismissed within `days`. */
  /** Recent events a rule's classifier filtered out, newest first, with their score (see Rule.classify). */
  async filtered(options: { days?: number; limit?: number; source?: string; rule?: string; channel?: string } = {}, at = now()): Promise<FilteredEvent[]> {
    const limit = Math.min(Math.max(1, Math.floor(options.limit ?? 100)), 500);
    const found = await this.q(
      `SELECT id, owner, source, external_id, title, url, actor, account, occurred_at, filtered_rule, filtered_score, filtered_at, filtered_channel FROM $S.events
       WHERE filtered_at IS NOT NULL AND task_id IS NULL AND filtered_at >= $1 AND ($2::text IS NULL OR source = $2) AND ($3::text IS NULL OR filtered_rule = $3) AND ($4::text IS NULL OR filtered_channel = $4)
       ORDER BY filtered_at DESC, id DESC LIMIT ${limit}`,
      [at - (options.days ?? 14) * 86400, options.source ?? null, options.rule ?? null, options.channel ?? null],
    );
    return found.rows.map((row) => ({
      id: Number(row.id), owner: String(row.owner), source: String(row.source), external_id: String(row.external_id),
      ...(row.title != null && { title: String(row.title) }), ...(row.url != null && { url: String(row.url) }), ...(row.actor != null && { actor: String(row.actor) }), ...(row.account != null && { account: String(row.account) }),
      occurred_at: Number(row.occurred_at), rule: String(row.filtered_rule), score: Number(row.filtered_score), filtered_at: Number(row.filtered_at),
      ...(row.filtered_channel != null && { channel: String(row.filtered_channel) }),
    }));
  }

  async boardTasks(channel: string, days = 14, at = now(), limit = 200): Promise<Task[]> {
    const found = await this.q(
      `SELECT * FROM $S.tasks WHERE channel = $1 AND (status NOT IN ('done', 'dismissed') OR updated_at >= $2) ORDER BY last_event_at DESC, id DESC LIMIT ${limit}`,
      [channel, at - days * 86400],
    );
    return found.rows.map(toTask);
  }

  /** The task's latest event, as it was posted (occurred_at in Unix seconds). */
  async latestEvent(task: number): Promise<EventInput | undefined> {
    const found = await this.q(`SELECT e.* FROM $S.tasks t JOIN $S.events e ON e.id = t.latest_event WHERE t.id = $1`, [task]);
    const row = found.rows[0];
    return row ? toEvent(row) : undefined;
  }

  /**
   * Puts a task on hold for input (status waiting, with the question and its
   * choices), or, with no question, takes the question off.
   */
  async setQuestion(id: number, actor: string, ask?: Readonly<{ question: string; options: readonly string[]; by: string }>): Promise<Task | undefined> {
    const found = ask
      ? await this.q(`UPDATE $S.tasks SET status = 'waiting', question = $2, options = $3::jsonb, asked_by = $4, updated_at = $5 WHERE id = $1 RETURNING *`, [id, ask.question, JSON.stringify(ask.options), ask.by, now()])
      : await this.q(`UPDATE $S.tasks SET question = NULL, options = NULL, asked_by = NULL, updated_at = $2 WHERE id = $1 RETURNING *`, [id, now()]);
    if (!found.rows[0]) return undefined;
    if (ask) await this.activity(id, actor, "question", `${ask.question}${ask.options.length ? ` (${ask.options.join(" / ")})` : ""}`);
    return toTask(found.rows[0]);
  }

  /** Asks agents on a task again: the hub records each one's next reply after now, as it did their first. */
  async askAgain(task: number, agents: readonly string[], at = now()): Promise<void> {
    for (const key of agents)
      await this.q(
        `INSERT INTO $S.task_people (task_id, kind, key, at, asked_at) VALUES ($1, 'agent', $2, $3, $3)
         ON CONFLICT (task_id, kind, key) DO UPDATE SET replied_at = NULL, asked_at = EXCLUDED.asked_at WHERE $S.task_people.removed_at IS NULL`,
        [task, key, at],
      );
  }

  async setAgentReply(task: number, reply: string): Promise<void> {
    await this.q(`UPDATE $S.tasks SET agent_reply = $2, updated_at = $3 WHERE id = $1`, [task, reply, now()]);
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

  /**
   * Open tasks that are finished by their rule's `done_when` times: an
   * `after` time that has passed (a meeting's end), or nothing new for
   * `idle_days` (or the config's `done_idle_days`, for any rule's tasks, even
   * a rule that's gone). Tasks asking the team a question are left open.
   */
  async finishable(config: SignalsConfig, at = now(), limit = 1000): Promise<{ task: Task; reason: string }[]> {
    const rules = new Map(config.rules.map((rule) => [rule.id, rule]));
    const found = await this.q(
      `SELECT t.*, e.source AS e_source, e.external_id AS e_external_id, e.title AS e_title, e.url AS e_url, e.actor AS e_actor, e.account AS e_account, e.payload AS e_payload,
         (SELECT max(a.at) FROM $S.activities a WHERE a.task_id = t.id AND a.kind <> 'nudge') AS last_activity
       FROM $S.tasks t LEFT JOIN $S.events e ON e.id = t.latest_event
       WHERE t.status NOT IN ('done', 'dismissed') AND t.question IS NULL ORDER BY t.id LIMIT ${limit}`,
    );
    const out: { task: Task; reason: string }[] = [];
    for (const row of found.rows) {
      const rule = rules.get(String(row.rule_id));
      const done = rule ? doneWhenOf(config, rule) : config.done_idle_days ? { idle_days: config.done_idle_days } : undefined;
      if (!done) continue;
      const event: EventInput | undefined = row.e_source
        ? { source: String(row.e_source), external_id: String(row.e_external_id), ...(row.e_title ? { title: String(row.e_title) } : {}), ...(row.e_url ? { url: String(row.e_url) } : {}), ...(row.e_actor ? { actor: String(row.e_actor) } : {}), ...(row.e_account ? { account: String(row.e_account) } : {}), ...(row.e_payload ? { payload: row.e_payload as Record<string, unknown> } : {}) }
        : undefined;
      const lastActive = Math.max(Number(row.last_event_at ?? 0), Number(row.created_at ?? 0), Number(row.last_activity ?? 0));
      const reason = doneReason(done, event, { at, sweep: true, lastActive });
      if (reason) out.push({ task: toTask(row), reason });
    }
    return out;
  }

  /** Records a reply someone on the team sent in a group's thread (once; it waits there until it's decided). */
  private async recordReply(group: string, event: number, owner: string, input: EventInput, keep = false): Promise<Reply> {
    const title = input.title ? plainSlack(input.title).replace(/\s+/g, " ").trim().slice(0, 200) : null;
    const occurred = toSeconds(input.occurred_at);
    const at = Number.isNaN(occurred) ? now() : occurred;
    const precise = toMicros(input.occurred_at);
    const micros = Number.isNaN(precise) ? at * 1_000_000 : precise;
    await this.q(
      `INSERT INTO $S.replies (group_key, event_id, owner, source, title, url, at, seen_at, at_us) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::bigint)
       ON CONFLICT (group_key, event_id) DO ${keep ? "NOTHING" : "UPDATE SET title = EXCLUDED.title, url = EXCLUDED.url, at = EXCLUDED.at, at_us = EXCLUDED.at_us"}`,
      [group, event, owner.toLowerCase(), input.source, title, input.url ?? null, at, now(), String(micros)],
    );
    return { group, event, owner: owner.toLowerCase(), source: input.source, title, url: input.url ?? null, at, micros };
  }

  /** Replies not decided yet: one event's, or one group's. */
  private async pendingReplies(where: { event: number } | { group: string }): Promise<Reply[]> {
    const found = "event" in where
      ? await this.q(`SELECT * FROM $S.replies WHERE event_id = $1 AND applied_at IS NULL ORDER BY at`, [where.event])
      : await this.q(`SELECT * FROM $S.replies WHERE group_key = $1 AND applied_at IS NULL ORDER BY at`, [where.group]);
    return found.rows.map((row) => ({ group: String(row.group_key), event: Number(row.event_id), owner: String(row.owner), source: String(row.source), title: (row.title as string | null) ?? null, url: (row.url as string | null) ?? null, at: Number(row.at), micros: row.at_us === null || row.at_us === undefined ? Number(row.at) * 1_000_000 : Number(row.at_us) }));
  }

  /** Whether a team reply that closed the task came at or after `micros` (so a customer message from then needs nothing more). */
  private async answeredAfter(task: number, micros: number): Promise<boolean> {
    if (Number.isNaN(micros)) return false;
    const found = await this.q(`SELECT 1 FROM $S.replies WHERE closed_task = $1 AND COALESCE(at_us, at * 1000000) >= $2::bigint LIMIT 1`, [task, String(micros)]);
    return found.rows.length > 0;
  }

  /** Decides a recorded reply against its group's task, if it has one yet (adding the closure to `result`). */
  private async applyReply(reply: Reply, result?: IngestResult): Promise<Handled | undefined> {
    const task = await this.taskByGroup(reply.group);
    if (!task) return undefined;
    await this.attach(task.id, reply.event, 1, reply.at);
    const done = await this.handled(task.id, reply);
    if (done && result) result.handled.push(done);
    return done;
  }

  /**
   * Marks a task done because someone on the team did the work, as their
   * reply shows, when it's open and the reply is no older than the customer's
   * latest message on it: records what they did, makes them its owner unless
   * a person still owns it, and takes its agents off it. All in one statement,
   * so it all happens or none does, and only the call that closes it gets a
   * result (and tells the agents to stop). The reply is marked decided either way.
   */
  async handled(id: number, reply: Reply): Promise<Handled | undefined> {
    const at = now();
    const what = `${reply.owner} handled it themselves (${reply.source})${reply.title ? `: ${reply.title}` : ""}${reply.url ? ` ${reply.url}` : ""}`.slice(0, 4000);
    const found = await this.q<{ task: unknown; agents: unknown; owners: unknown }>(
      `WITH latest AS (
         SELECT max(COALESCE(e.occurred_us, e.occurred_at * 1000000)) AS at FROM $S.task_events te JOIN $S.events e ON e.id = te.event_id
         WHERE te.task_id = $1 AND NOT EXISTS (SELECT 1 FROM $S.replies r WHERE r.event_id = e.id)),
       t AS (
         UPDATE $S.tasks SET status = 'done', question = NULL, options = NULL, asked_by = NULL, updated_at = $3
         WHERE id = $1 AND status NOT IN ('done', 'dismissed') AND NOT (series IS NOT NULL AND asked_by IS NOT DISTINCT FROM $9::text)
           AND $4::bigint >= COALESCE((SELECT at FROM latest), 0)
         RETURNING *),
       -- (Never undone: a second delivery of the same reply that finds the task already done keeps the first one's closure.)
       mark AS (UPDATE $S.replies SET applied_at = COALESCE(applied_at, $3), closed_task = COALESCE((SELECT id FROM t), closed_task) WHERE group_key = $2 AND event_id = $5 RETURNING 1),
       owners AS (SELECT key FROM $S.task_people WHERE task_id = $1 AND kind = 'person' AND assigned_at IS NOT NULL AND removed_at IS NULL AND key <> $6),
       agents AS (
         UPDATE $S.task_people SET removed_at = $3, assigned_at = NULL
         WHERE task_id = $1 AND kind = 'agent' AND removed_at IS NULL AND EXISTS (SELECT 1 FROM t) RETURNING key),
       responder AS (
         INSERT INTO $S.task_people (task_id, kind, key, at, assigned_at)
         SELECT $1, 'person', $6, $3, $3 WHERE EXISTS (SELECT 1 FROM t) AND NOT EXISTS (SELECT 1 FROM owners)
         ON CONFLICT (task_id, kind, key) DO UPDATE SET removed_at = NULL, assigned_at = COALESCE($S.task_people.assigned_at, EXCLUDED.assigned_at)
         RETURNING key),
       acts AS (
         INSERT INTO $S.activities (task_id, at, actor, kind, text)
         SELECT $1, $3, $6, v.kind, v.text FROM t, (VALUES (1, 'handled', $7::text), (2, 'status', $8::text)) AS v(n, kind, text) ORDER BY v.n RETURNING 1),
       art AS (INSERT INTO $S.artifacts (task_id, at, actor, kind, url, title) SELECT $1, $3, $6, 'reply', $10::text, $11::text FROM t WHERE $10::text IS NOT NULL RETURNING 1)
       SELECT (SELECT row_to_json(t) FROM t) AS task, ARRAY(SELECT key FROM agents ORDER BY key) AS agents, ARRAY(SELECT key FROM owners ORDER BY key) AS owners,
         (SELECT count(*) FROM mark) + (SELECT count(*) FROM responder) + (SELECT count(*) FROM acts) + (SELECT count(*) FROM art) AS writes`,
      [id, reply.group, at, String(reply.micros ?? reply.at * 1_000_000), reply.event, reply.owner, what, `done: handled by ${reply.owner}`, SERIES_ASKER, reply.url, `${reply.owner}'s reply`],
    );
    const row = found.rows[0];
    const raw = typeof row?.task === "string" ? (JSON.parse(row.task) as Row) : (row?.task as Row | null | undefined);
    if (!raw) return undefined;
    const list = (value: unknown) => (Array.isArray(value) ? value.map(String) : typeof value === "string" ? value.replace(/^\{|\}$/g, "").split(",").filter(Boolean) : []);
    const owners = list(row!.owners);
    return { task: toTask(raw), by: reply.owner, ...(reply.title && { title: reply.title }), ...(reply.url && { url: reply.url }), agents: list(row!.agents), ...(owners[0] && { owner: owners[0] }) };
  }

  /** Marks a task done by its rule (not a person), clearing any question; undefined if it's gone. */
  async finish(id: number, reason: string): Promise<Task | undefined> {
    await this.q(`UPDATE $S.tasks SET question = NULL, options = NULL, asked_by = NULL WHERE id = $1`, [id]);
    return this.setStatus(id, "done", "signals", reason);
  }

  async nudged(task: number, text: string, at = now()): Promise<void> {
    await this.q(`UPDATE $S.tasks SET nudged_at = $2 WHERE id = $1`, [task, at]);
    await this.activity(task, "signals", "nudge", text);
  }

  // --- recurring series ---------------------------------------------------

  async seriesFor(key: string): Promise<Series | undefined> {
    const found = await this.q(`SELECT * FROM $S.series WHERE key = $1`, [key]);
    return found.rows[0] ? toSeries(found.rows[0]) : undefined;
  }

  /** The series the team was asked about, for an account (or all), newest first. */
  async seriesList(account?: string, limit = 100): Promise<Series[]> {
    const found = account
      ? await this.q(`SELECT * FROM $S.series WHERE lower(account) = lower($1) ORDER BY created_at DESC LIMIT ${limit}`, [account])
      : await this.q(`SELECT * FROM $S.series ORDER BY created_at DESC LIMIT ${limit}`);
    return found.rows.map(toSeries);
  }

  /**
   * Records the team's answer about a series. `always` and `never` are kept
   * for its later events; `once` (just this one) and null leave it undecided,
   * so its next new event asks again. Either way the question is no longer
   * open; `releaseHeld` then runs its held events through the rules again.
   */
  async answerSeries(key: string, answer: SeriesAnswer | null, by: string): Promise<Series | undefined> {
    const kept = answer === "always" || answer === "never" ? answer : null;
    const found = await this.q(`UPDATE $S.series SET answer = $2, asked_task = NULL, answered_by = $3, answered_at = $4 WHERE key = $1 RETURNING *`, [key, kept, by, now()]);
    return found.rows[0] ? toSeries(found.rows[0]) : undefined;
  }

  /**
   * Runs the rules again on the events held while a series' question was
   * open (once it's answered), as their owners sent them: under `always`
   * they open tasks, under `never` none, and after "just this one" the next
   * of them asks again. Returns the tasks it opened.
   */
  async releaseHeld(key: string, config: SignalsConfig): Promise<Task[]> {
    const found = await this.q(`UPDATE $S.events SET held_series = NULL WHERE held_series = $1 AND task_id IS NULL RETURNING *`, [key]);
    const opened: Task[] = [];
    for (const row of [...found.rows].sort((a, b) => Number(a.occurred_at) - Number(b.occurred_at))) {
      const event = toEvent(row);
      const placed = await this.place(String(row.owner), event, { id: Number(row.id) }, config, false);
      if (!placed) continue;
      await this.attach(placed.task.id, Number(row.id), Number(row.versions), toSeconds(event.occurred_at));
      if (placed.opened) opened.push((await this.task(placed.task.id))!);
    }
    return opened;
  }

  /** Gives a task the mode its series' tasks get, once the team said to work on it. */
  async setMode(id: number, mode: Mode): Promise<Task | undefined> {
    const found = await this.q(`UPDATE $S.tasks SET mode = $2, updated_at = $3 WHERE id = $1 RETURNING *`, [id, mode, now()]);
    return found.rows[0] ? toTask(found.rows[0]) : undefined;
  }

  // --- accounts -----------------------------------------------------------

  async accounts(): Promise<AccountRecord[]> {
    return (await this.q(`SELECT * FROM $S.accounts ORDER BY name`)).rows.map(toAccount);
  }

  /** The account by name, alias or id (any case), or by its channel. */
  async account(by: Readonly<{ name?: string; channel?: string }>): Promise<AccountRecord | undefined> {
    if (by.channel) {
      const found = await this.q(`SELECT * FROM $S.accounts WHERE channel = $1`, [by.channel]);
      if (found.rows[0]) return toAccount(found.rows[0]);
    }
    if (!by.name) return undefined;
    const lower = by.name.trim().toLowerCase();
    return (await this.accounts()).find((account) => namesAccount(account, lower));
  }

  /**
   * Creates or changes an account. Only the fields given change; `rename`
   * gives it a new name and moves its tasks along. A channel belongs to one
   * account at a time.
   */
  async saveAccount(name: string, fields: Readonly<{ rename?: string; channel?: string | null; aliases?: readonly string[]; domains?: readonly string[]; ids?: AccountIds; agents?: readonly string[]; preferences?: string; profile?: string; playbooks?: Readonly<Record<string, string>>; workstream_agents?: Readonly<Record<string, readonly string[]>> }>, by: string): Promise<AccountRecord> {
    const at = now();
    const existing = await this.account({ name });
    const key = existing?.name ?? name.trim();
    if (!existing) await this.q(`INSERT INTO $S.accounts (name, updated_by, updated_at) VALUES ($1, $2, $3)`, [key, by, at]);
    const sets: string[] = [];
    const values: unknown[] = [key];
    const set = (column: string, value: unknown) => sets.push(`${column} = $${values.push(value)}`);
    if (fields.channel !== undefined) {
      if (fields.channel) await this.q(`UPDATE $S.accounts SET channel = NULL WHERE channel = $1 AND name <> $2`, [fields.channel, key]);
      set("channel", fields.channel || null);
    }
    if (fields.aliases) set("aliases", JSON.stringify(fields.aliases));
    if (fields.domains) set("domains", JSON.stringify(fields.domains));
    if (fields.ids) set("ids", JSON.stringify(fields.ids));
    if (fields.agents) set("agents", JSON.stringify(fields.agents));
    if (fields.preferences !== undefined) set("preferences", fields.preferences);
    if (fields.profile !== undefined) set("profile", fields.profile);
    if (fields.playbooks) set("playbooks", JSON.stringify(fields.playbooks));
    if (fields.workstream_agents) set("workstream_agents", JSON.stringify(fields.workstream_agents));
    set("updated_by", by);
    set("updated_at", at);
    await this.q(`UPDATE $S.accounts SET ${sets.join(", ")} WHERE name = $1`, values);
    const renamed = fields.rename?.trim();
    if (renamed && renamed !== key) {
      await this.q(`UPDATE $S.accounts SET name = $2 WHERE name = $1`, [key, renamed]);
      await this.q(`UPDATE $S.tasks SET account = $2 WHERE account = $1`, [key, renamed]);
    }
    // Open tasks for the account without a channel go to its channel now (the sweep posts them).
    const account = (await this.account({ name: renamed || key }))!;
    if (account.channel) await this.q(`UPDATE $S.tasks SET channel = $2 WHERE lower(account) = lower($1) AND channel IS NULL AND buzz_root IS NULL`, [account.name, account.channel]);
    return account;
  }

  async deleteAccount(name: string): Promise<boolean> {
    const found = await this.account({ name });
    if (!found) return false;
    await this.q(`DELETE FROM $S.accounts WHERE name = $1`, [found.name]);
    return true;
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

function toEvent(row: Row): EventInput {
  return {
    source: String(row.source),
    external_id: String(row.external_id),
    occurred_at: Number(row.occurred_at),
    ...(row.title ? { title: String(row.title) } : {}),
    ...(row.url ? { url: String(row.url) } : {}),
    ...(row.actor ? { actor: String(row.actor) } : {}),
    ...(row.account ? { account: String(row.account) } : {}),
    ...(row.payload ? { payload: row.payload as Record<string, unknown> } : {}),
  };
}

function toTask(row: Row): Task {
  return {
    id: Number(row.id),
    rule_id: String(row.rule_id),
    group_key: String(row.group_key),
    title: plainSlack(String(row.title)),
    account: (row.account as string | null) ?? null,
    channel: (row.channel as string | null) ?? null,
    workstream: (row.workstream as string | null) ?? null,
    initiative: (row.initiative as string | null) ?? null,
    mode: ((row.mode as Mode | null) ?? "draft") as Mode,
    status: row.status as TaskStatus,
    created_by: String(row.created_by),
    created_at: Number(row.created_at),
    updated_at: Number(row.updated_at),
    last_event_at: Number(row.last_event_at),
    event_count: Number(row.event_count),
    buzz_root: (row.buzz_root as string | null) ?? null,
    nudged_at: num(row.nudged_at),
    agent_reply: (row.agent_reply as string | null) ?? null,
    question: (row.question as string | null) ?? null,
    options: row.options === null || row.options === undefined ? null : strings(typeof row.options === "string" ? JSON.parse(row.options) : row.options),
    asked_by: (row.asked_by as string | null) ?? null,
    series: (row.series as string | null) ?? null,
  };
}

function toSeries(row: Row): Series {
  return {
    key: String(row.key),
    rule_id: String(row.rule_id),
    account: (row.account as string | null) ?? null,
    title: String(row.title),
    answer: row.answer === "always" || row.answer === "never" ? row.answer : null,
    asked_task: num(row.asked_task),
    mode: ((row.mode as Mode | null) ?? "draft") as Mode,
    answered_by: (row.answered_by as string | null) ?? null,
    answered_at: num(row.answered_at),
    created_at: Number(row.created_at),
  };
}

const strings = (value: unknown): string[] => (Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : []);

const idLists = (value: unknown): Record<string, string[]> =>
  value && typeof value === "object" && !Array.isArray(value) ? Object.fromEntries(Object.entries(value).map(([kind, ids]) => [kind, strings(ids)] as [string, string[]]).filter(([, ids]) => ids.length)) : {};

const texts = (value: unknown): Record<string, string> =>
  value && typeof value === "object" && !Array.isArray(value) ? Object.fromEntries(Object.entries(value).filter((entry): entry is [string, string] => typeof entry[1] === "string")) : {};

function toAccount(row: Row): AccountRecord {
  return {
    name: String(row.name),
    channel: (row.channel as string | null) ?? null,
    aliases: strings(typeof row.aliases === "string" ? JSON.parse(row.aliases) : row.aliases),
    domains: strings(typeof row.domains === "string" ? JSON.parse(row.domains) : row.domains),
    ids: idLists(typeof row.ids === "string" ? JSON.parse(row.ids) : row.ids),
    preferences: String(row.preferences ?? ""),
    profile: String(row.profile ?? ""),
    agents: strings(typeof row.agents === "string" ? JSON.parse(row.agents) : row.agents),
    playbooks: texts(typeof row.playbooks === "string" ? JSON.parse(row.playbooks) : row.playbooks),
    workstream_agents: idLists(typeof row.workstream_agents === "string" ? JSON.parse(row.workstream_agents) : row.workstream_agents),
    updated_by: (row.updated_by as string | null) ?? null,
    updated_at: num(row.updated_at),
  };
}
