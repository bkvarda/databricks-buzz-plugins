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
import { createHash, randomUUID } from "node:crypto";
import { calendarEventId, itemKey, itemLine, parseNextSteps, peopleNamed, sideOf } from "./actions";
import { attendeesOf, realCustomers } from "./attendees";
import { KEPT_DETAILS, slackThreadKey, toMicros, type AccountIds, type AccountRecord, atDomains, type Decision, categoryChoices, categoryModeFor, DEFAULT_CLASSIFY_MIN, contentKey, namesAccount, decide, fanOut, type Verdict, VERDICTS, doneReason, doneWhenOf, type EventInput, type FieldChange, fieldChanges, finishes, handledBy, isOpen, matches, modeFor, ruleApplies, watchedValue, type Mode, plainSlack, type Rule, SERIES_ASKER, SERIES_OPTIONS, type SeriesAnswer, seriesQuestion, type SignalsConfig, TASK_STATUSES, type TaskStatus, toSeconds } from "./model";

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
  /** For a meeting's follow-up (a rule's `action_items`): the notes' items that aren't the account team's own tasks, as a checklist, and the tasks the team's items opened. */
  checklist?: string | null;
  /** For a fan-out candidate (a rule's `fan_out`): what was decided about it for its account, and who decided. */
  verdict?: Verdict | null;
  verdict_by?: string | null;
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
/**
 * An event row's time in microseconds: `occurred_us`, or for a row saved
 * before it, its Slack permalink's own ts (`/p1795001030900000`, the message's,
 * not `thread_ts=`, which is the root's) when that's in the same second, or
 * else its second.
 */
const EVENT_MICROS = `COALESCE(e.occurred_us,
  CASE WHEN (e.source = 'slack' OR e.source LIKE 'slack.%') AND substring(e.url from '/archives/[A-Za-z0-9]+/p([0-9]{16})') IS NOT NULL
        AND substring(e.url from '/archives/[A-Za-z0-9]+/p([0-9]{10})[0-9]{6}')::bigint = e.occurred_at
       THEN substring(e.url from '/archives/[A-Za-z0-9]+/p([0-9]{16})')::bigint END,
  e.occurred_at * 1000000)`;

/**
 * SQL that holds while event `$<n>` is still its notes' latest revision: no newer revision of the same document (the same
 * source and group) is saved. Drive gives each modification of a doc its own event id (`{id}:{modifiedTime}`), so a newer
 * one is another row of the group, later in time. Each notes revision raises its document's `revisions` row as it's saved
 * (see record), and this locks that row to share: a newer revision being saved now waits for this statement, or this one
 * waits for it and sees its time. (`OFFSET 0` keeps the time check out of the locking read: the lock is taken first, then
 * the time compared, so a row a newer revision raises is compared as raised. A newer version under the same id is checked by the
 * event's `versions`.)
 */
const LATEST_REVISION = (n: number) => `NOT EXISTS (SELECT 1 FROM $S.events o JOIN $S.events r ON r.source = o.source AND r.group_key = o.group_key AND r.id <> o.id
       AND COALESCE(r.occurred_us, r.occurred_at * 1000000) > COALESCE(o.occurred_us, o.occurred_at * 1000000) WHERE o.id = $${n}::bigint)
     AND NOT EXISTS (SELECT 1 FROM (SELECT v.latest_us, COALESCE(o.occurred_us, o.occurred_at * 1000000) AS mine FROM $S.revisions v
       JOIN $S.events o ON v.source = o.source AND v.group_key = o.group_key WHERE o.id = $${n}::bigint OFFSET 0 FOR SHARE OF v) l WHERE l.latest_us > l.mine)`;

/** `at` in seconds; `micros` the same moment in microseconds (Slack's ts keeps them), for ordering it against the customer's messages. */
export type Reply = Readonly<{ group: string; event: number; owner: string; source: string; title: string | null; url: string | null; at: number; micros?: number }>;

export type Outcome = "new" | "changed" | "same" | "skipped";
/** A meeting's notes moving their prep task to their rule (meeting_task): the task, what changed, whether attaching them opens it again, and whether it was done. */
type Joined = Readonly<{ task: number; changes: FieldChange[]; reopen: boolean; was_done: boolean; at: number }>;

/** A move taken to report (see claimJoin): the notes event, the claim's token (it must match to clear or release it), and when the move was made. */
export type JoinClaim = Readonly<{ event: number; claim: string; at: number }>;

/** What resumeItems finished on a notes event: its task, the tasks it opened, the checklist when it changed, and the move it reported (see meetingTask). */
type Resumed = Readonly<{ task: Task; opened: number[]; checklist?: string | null; joined?: JoinClaim; changes?: FieldChange[]; reopened?: boolean }>;

/** A resumed notes event's update, as an ingest's is (see IngestResult.updated). */
function resumedUpdate(resumed: Resumed) {
  return { ...(resumed.checklist !== undefined && { checklist: resumed.checklist }), ...(resumed.joined && { joined: resumed.joined }), ...(resumed.changes && { changes: resumed.changes }), ...(resumed.reopened && { reopened: true }) };
}

/** A rule's classifier: the probability (0 to 1) that the event needs a task, or undefined when it can't tell. */
export type Classifier = (event: EventInput, classify: import("./model").Classify) => Promise<number | undefined>;

/**
 * Picks one of a rule's categories for an event (see Rule.categories):
 * `choices` is workstream → what that work is, plus NO_CATEGORY. Gives the
 * chosen workstream, or undefined when it can't tell (the task keeps the
 * rule's workstream).
 */
export type Categorizer = (event: EventInput, choices: Readonly<Record<string, string>>) => Promise<string | undefined>;

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
  /** `retry`: it may not be saved, or not all of it (a write failed): post it again. */
  errors: { index: number; error: string; retry?: boolean }[];
  /** Tasks opened by this post. */
  created: Task[];
  /** Tasks an event of this post was added to. */
  /** `changes`: watched fields this event changed. `outgrown`: the task's own rule no longer applies to the event and no other `task` rule of its group took it over, with the watched fields' values now. */
  updated: { task: Task; title?: string; url?: string; reopened?: boolean; changes?: FieldChange[]; outgrown?: { rule: string; values: { field: string; value: string }[] };
    /** A meeting's follow-up whose checklist this event changed: the checklist now (null: the notes list no items now, so it was cleared). */
    checklist?: string | null;
    /** A meeting's notes that just moved its prep task to their rule (meeting_task): its agents are the new workstream's. The
     * claim on the notes event's mark, which keeps the move until it's reported: the hub clears it (reportedJoins) once the update
     * is posted, or releases it (releaseJoins) when it couldn't be, for the next sweep. */
    joined?: JoinClaim }[];
  /** Tasks an event of this post finished (its rule's done_when.when), and why. */
  finished: { task: Task; reason: string }[];
  /** Tasks someone on the team handled themselves (done_when.by_owner): who, the event that shows it, and the agents taken off. */
  handled: Handled[];
  firstRun: boolean;
}>;

const now = () => Math.floor(Date.now() / 1000);

/** Seconds an ingest has to place a pending notes version before the sweep may (see events.placing_at). */
export const PLACING_LEASE = 600;
/** Seconds a run that took a notes event's move to report has before another may (see events.join_claimed_at). */
const JOIN_LEASE = PLACING_LEASE;
const clip = (text: string, max: number) => (text.length > max ? `${text.slice(0, max - 1)}…` : text);

export const contentHash = (event: EventInput) => createHash("sha256").update(contentKey(event)).digest("hex").slice(0, 32);

export const schemaName = (app: string) => `signals_${(app || "hub").toLowerCase().replace(/[^a-z0-9]+/g, "_")}`.slice(0, 63);

export class SignalsStore {
  constructor(
    private readonly db: Db,
    readonly schema: string,
  ) {
    if (!/^[a-z_][a-z0-9_]{0,62}$/.test(schema)) throw new Error(`Bad schema name ${schema}`);
  }

  /** Picks a new task's category when none of its rule's categories' `when` matched (see Rule.categories); the hub sets it. */
  categorizer?: Categorizer;

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
    // The newest customer message on the task, and the newest team reply decided on it (both microseconds): on the row,
    // so a closure and a customer message decided at once see each other (each waits for the other's row lock, then rereads them).
    await this.q(`ALTER TABLE $S.tasks ADD COLUMN IF NOT EXISTS customer_us bigint`);
    await this.q(`ALTER TABLE $S.tasks ADD COLUMN IF NOT EXISTS answered_us bigint`);
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
    await this.q(`ALTER TABLE $S.tasks ADD COLUMN IF NOT EXISTS checklist text`);
    // A fan-out candidate's verdict (see Rule.fan_out): set by an agent or a person, never by an event coming in.
    await this.q(`ALTER TABLE $S.tasks ADD COLUMN IF NOT EXISTS verdict text`);
    await this.q(`ALTER TABLE $S.tasks ADD COLUMN IF NOT EXISTS verdict_by text`);
    await this.q(`ALTER TABLE $S.tasks ADD COLUMN IF NOT EXISTS verdict_at bigint`);
    // The newest notes revision (microseconds) whose action items the follow-up took: an older one read late changes nothing.
    await this.q(`ALTER TABLE $S.tasks ADD COLUMN IF NOT EXISTS items_us bigint`);
    // The event version whose action items are being written, until all are: one a failed write cut short is finished by the sweep (or a repost).
    await this.q(`ALTER TABLE $S.events ADD COLUMN IF NOT EXISTS items_pending int`);
    await this.q(`CREATE INDEX IF NOT EXISTS events_items_pending ON $S.events (id) WHERE items_pending IS NOT NULL`);
    // A meeting's notes that just moved their meeting's prep task to their rule (meeting_task), until that move is reported:
    // {task, changes, reopen, was_done}, set in the statement that moves it, so the sweep finishes a move a failed write cut short
    // (attaching them, opening it again, asking the follow-up's agents) and the run that clears it is the one that reports it.
    await this.q(`ALTER TABLE $S.events ADD COLUMN IF NOT EXISTS join_pending jsonb`);
    await this.q(`CREATE INDEX IF NOT EXISTS events_join_pending ON $S.events (id) WHERE join_pending IS NOT NULL`);
    // When a run took the move to report, and its token (see claimJoin): another run leaves it to that one until JOIN_LEASE has passed.
    await this.q(`ALTER TABLE $S.events ADD COLUMN IF NOT EXISTS join_claimed_at bigint`);
    await this.q(`ALTER TABLE $S.events ADD COLUMN IF NOT EXISTS join_claim text`);
    // When the sweep last tried a pending event's items: the least recently tried go first, so ones that keep failing don't hold up the rest.
    await this.q(`ALTER TABLE $S.events ADD COLUMN IF NOT EXISTS items_tried bigint`);
    // While an ingest is placing a pending notes version (its classifier may take a while): the sweep leaves it to that ingest
    // until it ends (cleared then) or PLACING_LEASE seconds pass (the hub stopped mid-way).
    await this.q(`ALTER TABLE $S.events ADD COLUMN IF NOT EXISTS placing_at bigint`);
    // Whether the pending version came in on its source's first run: the sweep places it as that ingest would have.
    await this.q(`ALTER TABLE $S.events ADD COLUMN IF NOT EXISTS items_first_run boolean`);
    // A fan-out event's version not yet placed on every candidate (set with the version, cleared once it is), and whether it came
    // in on its source's first run: posting it again finishes that version as its first ingest would have, and changes nothing else.
    await this.q(`ALTER TABLE $S.events ADD COLUMN IF NOT EXISTS fan_pending int`);
    await this.q(`ALTER TABLE $S.events ADD COLUMN IF NOT EXISTS fan_first_run boolean`);
    // A notes document's newest revision saved (microseconds), by source and group: raised as each is recorded, so placing an older
    // one can lock it and see a newer one being saved (see LATEST_REVISION).
    await this.q(`CREATE TABLE IF NOT EXISTS $S.revisions (source text NOT NULL, group_key text NOT NULL, latest_us bigint NOT NULL, PRIMARY KEY (source, group_key))`);
    // Sets a document's newest revision again from the copies saved now (anyone's), or drops it with none left (after Forget).
    // Its row is locked first, and each statement after that reads with a new snapshot (PL/pgSQL under read committed), so it
    // counts every copy committed before it got the lock: one another Forget deleted (that Forget's refresh waits for this one, or
    // this for it) and one saved meanwhile (record raises the row in the statement that saves it, so it waits too, then raises it).
    // A document with no row (saved before revisions were kept) has nothing to set: only a row it locked is changed.
    await this.q(`CREATE OR REPLACE FUNCTION $S.refresh_revision(doc_source text, doc_group text) RETURNS void LANGUAGE plpgsql AS $fn$
      DECLARE newest bigint;
      BEGIN
        PERFORM 1 FROM $S.revisions WHERE source = doc_source AND group_key = doc_group FOR UPDATE;
        IF NOT FOUND THEN RETURN; END IF;
        SELECT max(COALESCE(occurred_us, occurred_at * 1000000)) INTO newest FROM $S.events WHERE source = doc_source AND group_key = doc_group;
        IF newest IS NULL THEN
          DELETE FROM $S.revisions WHERE source = doc_source AND group_key = doc_group;
        ELSE
          UPDATE $S.revisions SET latest_us = newest WHERE source = doc_source AND group_key = doc_group;
        END IF;
      END $fn$`);
    // Forget's delete of a person's events from a source, and the refresh of the documents they were copies of, in one transaction
    // (one call) as separate statements: the refreshes read after the delete, and a refresh that fails undoes the delete too,
    // so Forget again finds the events and does both. Returns the tasks the events were on.
    await this.q(`CREATE OR REPLACE FUNCTION $S.forget_events(of_owner text, of_source text) RETURNS TABLE (task bigint) LANGUAGE plpgsql AS $fn$
      DECLARE docs text[];
      BEGIN
        CREATE TEMP TABLE IF NOT EXISTS forgotten (id bigint, task_id bigint, group_key text) ON COMMIT DROP;
        DELETE FROM forgotten;
        WITH del AS (DELETE FROM $S.events WHERE owner = of_owner AND source = of_source RETURNING id, task_id, group_key)
          INSERT INTO forgotten SELECT * FROM del;
        SELECT array_agg(DISTINCT f.group_key ORDER BY f.group_key) INTO docs FROM forgotten f WHERE f.group_key IS NOT NULL;
        IF docs IS NOT NULL THEN
          FOR i IN 1 .. array_length(docs, 1) LOOP PERFORM $S.refresh_revision(of_source, docs[i]); END LOOP;
        END IF;
        RETURN QUERY SELECT f.task_id FROM forgotten f WHERE f.task_id IS NOT NULL
          UNION SELECT te.task_id FROM $S.task_events te WHERE te.event_id IN (SELECT f.id FROM forgotten f);
        DELETE FROM forgotten;
      END $fn$`);
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
    // The version the classifier decided on (filtered_rule / filtered_score): a later version is asked again.
    await this.q(`ALTER TABLE $S.events ADD COLUMN IF NOT EXISTS filtered_version int`);
    await this.q(`CREATE INDEX IF NOT EXISTS events_filtered ON $S.events (filtered_at) WHERE filtered_at IS NOT NULL`);
    await this.q(`CREATE INDEX IF NOT EXISTS tasks_status ON $S.tasks (status, last_event_at)`);
    await this.q(`CREATE INDEX IF NOT EXISTS tasks_account ON $S.tasks (account, status)`);
    await this.q(`CREATE TABLE IF NOT EXISTS $S.task_events (task_id bigint NOT NULL, event_id bigint NOT NULL, version int NOT NULL, at bigint NOT NULL, PRIMARY KEY (task_id, event_id, version))`);
    await this.q(`CREATE TABLE IF NOT EXISTS $S.activities (id bigserial PRIMARY KEY, task_id bigint NOT NULL, at bigint NOT NULL, actor text NOT NULL, kind text NOT NULL, text text NOT NULL)`);
    await this.q(`CREATE INDEX IF NOT EXISTS activities_task ON $S.activities (task_id, at)`);
    // What an activity is about, when it must be recorded once however often it's tried (a move's `changed`, see Hub.changed).
    await this.q(`ALTER TABLE $S.activities ADD COLUMN IF NOT EXISTS ref text`);
    await this.q(`CREATE UNIQUE INDEX IF NOT EXISTS activities_ref ON $S.activities (task_id, kind, ref) WHERE ref IS NOT NULL`);
    // The disclosure check's result for each agent reply it looked at, once per reply.
    await this.q(`CREATE TABLE IF NOT EXISTS $S.disclosure_checks (task_id bigint NOT NULL, reply_id text NOT NULL, status text NOT NULL, kinds text[] NOT NULL DEFAULT '{}', at bigint NOT NULL, PRIMARY KEY (task_id, reply_id))`);
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
    // Times a post was handled with events that failed to save (a write failed): it's handled again, its owner's later posts (its cursor) waiting, up to INBOX_TRIES times.
    await this.q(`ALTER TABLE $S.inbox ADD COLUMN IF NOT EXISTS tries int NOT NULL DEFAULT 0`);
    // When it was last tried (epoch seconds): past INBOX_TRIES it's held, and tried again only every INBOX_HOLD_SECONDS.
    await this.q(`ALTER TABLE $S.inbox ADD COLUMN IF NOT EXISTS tried_at bigint`);
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

  /** Inbox posts the hub hasn't handled yet, oldest first (after the post `after`, to page past held ones). */
  async inbox(limit = 20, after = 0): Promise<{ id: number; owner: string; kind: "events" | "cursor"; body: unknown; tries: number; tried_at: number | null }[]> {
    const found = await this.q<{ id: unknown; owner: string; kind: "events" | "cursor"; body: unknown; tries: unknown; tried_at: unknown }>(`SELECT id, owner, kind, body, tries, tried_at FROM $S.inbox WHERE done_at IS NULL AND id > $2 ORDER BY id LIMIT $1`, [limit, after]);
    return found.rows.map((row) => ({ ...row, id: Number(row.id), tries: Number(row.tries ?? 0), tried_at: num(row.tried_at) }));
  }

  /** Counts a failed attempt at an inbox post, which stays to be handled again. */
  async inboxRetry(id: number, result: unknown, at = now()): Promise<number> {
    const found = await this.q<{ tries: unknown }>(`UPDATE $S.inbox SET tries = tries + 1, tried_at = $3, result = $2 WHERE id = $1 RETURNING tries`, [id, JSON.stringify(result ?? null), at]);
    return Number(found.rows[0]?.tries ?? 0);
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
      // Events first, then their replies, decided or not: a forgotten reply mustn't close (or keep closed) anything.
      // A reply is saved only while its event is there (recordReply), so one saved during this is caught by the second delete.
      // (An event being attached holds its row: the delete waits for it, then returns the task it went to.)
      // (The documents they were copies of get their newest revision set again in the same call; see forget_events.)
      const events = await this.q<{ task: unknown }>(`SELECT task FROM $S.forget_events($1, $2)`, [owner, source]);
      const replies = await this.q<{ task: unknown }>(`DELETE FROM $S.replies WHERE owner = lower($1) AND source = $2 RETURNING closed_task AS task`, [owner, source]);
      const tasks = [...new Set([...events.rows, ...replies.rows].map((row) => row.task).filter((task) => task !== null && task !== undefined).map(String))];
      if (tasks.length) await this.retime(tasks);
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

  /**
   * Records one event: new, changed (a new content hash) or the same. With
   * `items`, a new or changed version is marked as having action items to
   * write (items_pending) in the same statement, so the sweep finishes them
   * even when a later write of this post fails and the post is acknowledged.
   */
  async record(owner: string, given: EventInput, items = false, firstRun = false, fan = false): Promise<{ outcome: Exclude<Outcome, "skipped">; id: number; version: number; taskId: number | null; before?: EventInput; itemsPending?: number; fanPending?: { version: number; firstRun: boolean } }> {
    const event = await this.keepDetails(owner, given);
    const hash = contentHash(event);
    const at = now();
    const occurred = toSeconds(event.occurred_at);
    const micros = toMicros(event.occurred_at);
    const values = [owner, event.source, event.external_id, hash, occurred, at, event.title ?? null, event.url ?? null, event.actor ?? null, event.account ?? null, event.group_key ?? null, event.payload ? JSON.stringify(event.payload) : null, Number.isNaN(micros) ? null : String(micros), items, firstRun, fan];
    // xmax = 0 only for a row this statement inserted.
    const found = await this.q<{ id: unknown; versions: number; task_id: unknown; before: unknown; inserted: boolean; changed: boolean; items_pending: unknown; fan_pending: unknown; fan_first_run: unknown }>(
      `WITH previous AS (SELECT content_hash, occurred_at, title, url, actor, account, payload FROM $S.events WHERE owner = $1 AND source = $2 AND external_id = $3),
       doc AS (INSERT INTO $S.revisions (source, group_key, latest_us) SELECT $2, $11, $13::bigint WHERE $14 AND $11::text IS NOT NULL AND $13::bigint IS NOT NULL
         ON CONFLICT (source, group_key) DO UPDATE SET latest_us = GREATEST($S.revisions.latest_us, excluded.latest_us) RETURNING 1)
       INSERT INTO $S.events (owner, source, external_id, content_hash, occurred_at, first_seen, last_seen, changed_at, title, url, actor, account, group_key, payload, occurred_us, items_pending, placing_at, items_first_run, fan_pending, fan_first_run)
       VALUES ($1, $2, $3, $4, $5, $6, $6, $6, $7, $8, $9, $10, $11, $12, $13::bigint, CASE WHEN $14 THEN 1 END, CASE WHEN $14 THEN $6::bigint END, CASE WHEN $14 THEN $15::boolean END,
         CASE WHEN $16 THEN 1 END, CASE WHEN $16 THEN $15::boolean END)
       ON CONFLICT (owner, source, external_id) DO UPDATE SET
         last_seen = excluded.last_seen,
         content_hash = excluded.content_hash,
         versions = $S.events.versions + CASE WHEN $S.events.content_hash = excluded.content_hash THEN 0 ELSE 1 END,
         changed_at = CASE WHEN $S.events.content_hash = excluded.content_hash THEN $S.events.changed_at ELSE excluded.changed_at END,
         occurred_at = excluded.occurred_at, occurred_us = excluded.occurred_us, title = excluded.title, url = excluded.url, actor = excluded.actor,
         account = excluded.account, group_key = excluded.group_key, payload = excluded.payload,
         items_pending = CASE WHEN $14 AND $S.events.content_hash <> excluded.content_hash THEN $S.events.versions + 1 ELSE $S.events.items_pending END,
         items_tried = CASE WHEN $14 AND $S.events.content_hash <> excluded.content_hash THEN NULL ELSE $S.events.items_tried END,
         placing_at = CASE WHEN $14 AND $S.events.content_hash <> excluded.content_hash THEN excluded.placing_at ELSE $S.events.placing_at END,
         items_first_run = CASE WHEN $14 AND $S.events.content_hash <> excluded.content_hash THEN excluded.items_first_run ELSE $S.events.items_first_run END,
         fan_pending = CASE WHEN $16 AND $S.events.content_hash <> excluded.content_hash THEN $S.events.versions + 1 ELSE $S.events.fan_pending END,
         fan_first_run = CASE WHEN $16 AND $S.events.content_hash <> excluded.content_hash THEN $15::boolean ELSE $S.events.fan_first_run END
       RETURNING id, versions, task_id, items_pending, fan_pending, fan_first_run,
         (SELECT row_to_json(previous) FROM previous) AS before,
         NOT EXISTS (SELECT 1 FROM previous) AS inserted,
         COALESCE((SELECT content_hash FROM previous) <> $4, false) AS changed`,
      values,
    );
    const row = found.rows[0]!;
    // The event as it was before this version (pg gives row_to_json as an object, PGlite may give text).
    const raw = typeof row.before === "string" ? (JSON.parse(row.before) as Row) : (row.before as Row | null);
    const before = raw ? toEvent({ ...raw, source: event.source, external_id: event.external_id }) : undefined;
    return { outcome: row.inserted ? "new" : row.changed ? "changed" : "same", id: Number(row.id), version: row.versions, taskId: num(row.task_id), ...(before && { before }), ...(num(row.items_pending) !== null && { itemsPending: num(row.items_pending)! }), ...(num(row.fan_pending) !== null && { fanPending: { version: num(row.fan_pending)!, firstRun: row.fan_first_run === true } }) };
  }

  /**
   * The event with the details an earlier version had and this one lacks (a notes doc read before, not this time):
   * a version without them is the same event, not one whose notes were removed.
   */
  private async keepDetails(owner: string, event: EventInput): Promise<EventInput> {
    const payload = (event.payload ?? {}) as Record<string, unknown>;
    const missing = KEPT_DETAILS.filter((key) => payload[key] === undefined || payload[key] === null);
    // Only events that carry these fields (null when unread) and lack one.
    if (!missing.length || !KEPT_DETAILS.some((key) => key in payload)) return event;
    const found = await this.q<{ payload: unknown }>(`SELECT payload FROM $S.events WHERE owner = $1 AND source = $2 AND external_id = $3`, [owner, event.source, event.external_id]);
    const raw = found.rows[0]?.payload;
    const before = (typeof raw === "string" ? JSON.parse(raw) : raw) as Record<string, unknown> | null | undefined;
    if (!before) return event;
    const kept = Object.fromEntries(missing.filter((key) => before[key] !== undefined && before[key] !== null).map((key) => [key, before[key]]));
    return Object.keys(kept).length ? { ...event, payload: { ...payload, ...kept } } : event;
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
    const retried = new Set<string>();
    const touched = new Map<number, Task>();
    const opened = new Set<number>();
    for (const [index, event] of events.entries()) {
      // Saved: an error after that needn't be posted again (a notes event's items_pending has the sweep finish it;
      // reposting a saved event changes nothing). Before that, the post is handled again (see Hub.drain).
      let saved = false;
      let fanning = false;
      let placing: number | undefined;
      let placingVersion: number | undefined;
      try {
        let state = consent.get(event.source);
        if (!state) consent.set(event.source, (state = await this.enabled(owner, event.source)));
        if (!state.enabled) {
          counts.skipped++;
          continue;
        }
        if (state.firstRun) counts.firstRun = true;
        // A meeting's notes a rule with action_items may take: marked pending as it's recorded, with whether it's a first run,
        // so the sweep places it as this ingest would (a first run opens tasks only with first_run_seen false; otherwise
        // placing it finds nothing to do and clears the marker).
        const fan = fanOut(config, event, { firstRun: state.firstRun, owner });
        // (So is one a rule with meeting_task may take: its placement, which may move a prep task, is finished the same way.)
        const recorded = await this.record(owner, event, config.rules.some((rule) => (rule.action_items || rule.meeting_task) && ruleApplies(config, rule, event, owner)), state.firstRun, Boolean(fan));
        counts[recorded.outcome]++;
        saved = true;
        if (recorded.outcome !== "same" && recorded.itemsPending !== undefined) {
          placing = recorded.id;
          placingVersion = recorded.version;
        }
        const replies = handledBy(config, event, owner);
        // About every account (a new feature announced): a candidate per opted-in account, then nothing else to do with it.
        // Its version is pending (fan_pending) until placed on every candidate: a failure asks for the post again, and posting it
        // again places that version as its first ingest would have (the same first-run decision). Seen before and placed: nothing.
        if (fan) {
          const pending = recorded.fanPending;
          if (!pending || pending.version !== recorded.version) continue;
          fanning = true;
          const decisions = pending.firstRun === state.firstRun ? fan.decisions : fanOut(config, event, { firstRun: pending.firstRun, owner })!.decisions;
          await this.fanOutPlace(owner, event, recorded, decisions, opened, (task) => {
            touched.set(task.id, task);
            result.updated.push({ task, ...(event.title && { title: event.title }), ...(event.url && { url: event.url }) });
          });
          await this.q(`UPDATE $S.events SET fan_pending = NULL WHERE id = $1 AND fan_pending = $2`, [recorded.id, recorded.version]);
          continue;
        }
        if (recorded.outcome === "same") {
          // Seen before, but a closure it started may not have finished (a write failed): finish it.
          if (replies.length) {
            for (const { group } of replies) await this.recordReply(group, recorded.id, owner, event, true);
            for (const reply of await this.pendingReplies({ event: recorded.id })) await this.applyReply(reply, result);
          }
          // A meeting's notes whose action items a failed write cut short: written now (each item once),
          // after placing it on its task first when that failed too (resumeItems does both).
          if (recorded.itemsPending !== undefined) {
            const resumed = await this.resumeItems(owner, recorded.id, config, classifier);
            if (resumed) {
              for (const id of resumed.opened) opened.add(id);
              if (resumed.checklist !== undefined || resumed.joined) result.updated.push({ task: resumed.task, ...(event.title && { title: event.title }), ...(event.url && { url: event.url }), ...resumedUpdate(resumed) });
            }
          }
          continue;
        }
        const placed = await this.place(owner, event, recorded, config, state.firstRun, classifier, () => counts.filtered++);
        // An event can finish a task even when its rule no longer matches it (a resolved ticket).
        let finishedHere = false;
        for (const { rule, group } of finishes(config, event)) {
          const task = placed?.task.group_key === group ? placed.task : await this.taskByGroup(group);
          if (!task || !isOpen(task.status) || (task.series && task.asked_by === SERIES_ASKER)) continue;
          await this.attach(task.id, recorded.id, recorded.version, toSeconds(event.occurred_at), replies.length ? undefined : { micros: toMicros(event.occurred_at), reopen: false });
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
          if (!reply) continue;
          const done = await this.applyReply(reply, result);
          if (done && done.task.id === placed?.task.id) finishedHere = true;
        }
        if (!placed || finishedHere) {
          // Not placed (no task for it: filtered, a first run, a closed group) or finished here: no action items to write later either.
          if (recorded.itemsPending !== undefined) await this.q(`UPDATE $S.events SET items_pending = NULL WHERE id = $1 AND items_pending = $2`, [recorded.id, recorded.itemsPending]);
          continue;
        }
        let task = placed.task;
        if (placed.opened) opened.add(task.id);
        // A finished task opens again for a new event, when attached (below): not for a message older than a team reply decided on it
        // (that reply answered it), and not for a late event that is itself past done, like a meeting's notes after it ended.
        // (A task this event just opened too: a team reply decided while it was being attached may have closed it already.)
        // (Notes that just moved their meeting's prep task: as the move decided, saved with it for a sweep that finishes it.)
        const reopen = placed.joined ? placed.joined.reopen : placed.create && recorded.outcome === "new" && !doneReason(doneWhenOf(config, placed.rule), event, { at: now(), sweep: true });
        // What the watched fields were: this event's last version, or else the task's latest event (another event of its group).
        let changes: FieldChange[] = [];
        let outgrown: { rule: string; values: { field: string; value: string }[] } | undefined;
        if (!placed.opened) {
          const watched = [...(placed.rule.watch ?? []), ...(config.rules.find((rule) => rule.id === task.rule_id)?.watch ?? [])];
          // A meeting's notes that just joined its prep task (meeting_task): the move, so its agents are asked to go on with this rule's playbook,
          // with the watched fields' changes, all saved with the move (see meetingTask), so a retry from the sweep posts the same.
          if (placed.joined) changes = placed.joined.changes;
          else if (watched.length) changes = fieldChanges(watched, recorded.before ?? (await this.latestEvent(task.id)), event);
          // When a watched field changed and the event now matches another `task` rule of the group, that rule takes the task over, with its playbook.
          // (Only then: groups without watched fields keep their tasks on the rule that opened them, as before.)
          if (changes.length && placed.rule.id !== task.rule_id && placed.rule.action === "task" && isOpen(task.status)) task = await this.refile(task, placed.rule);
          // Still on its old rule, and that rule doesn't apply now (a case back to Open, say): its playbook would be the wrong one.
          // (Checked for every attached event, whatever its rules watch, changed or not: the last event of a post decides the briefing,
          // and one that changes nothing, a new title say, or that comes through a rule watching nothing, still leaves the task where
          // the post's earlier events took it.)
          const own = config.rules.find((rule) => rule.id === task.rule_id);
          if (own && task.rule_id !== placed.rule.id && !ruleApplies(config, own, event, owner))
            outgrown = { rule: own.id, values: [...new Set(watched)].map((path) => ({ field: path.replace(/^payload\./, ""), value: watchedValue(event, path) })) };
        }
        const reopened = await this.attach(task.id, recorded.id, recorded.version, toSeconds(event.occurred_at), { micros: toMicros(event.occurred_at), reopen });
        // A meeting's notes: the account team's items get their own tasks, the rest a checklist on this one.
        let checklist: string | null | undefined;
        if (placed.rule.action_items) {
          const items = await this.actionItems(owner, event, recorded, task, placed.rule, config);
          for (const id of items.opened) opened.add(id);
          checklist = items.checklist;
        } else if (recorded.itemsPending !== undefined) {
          // Placed and attached, with no action items to write (a meeting_task rule without them): nothing left for the sweep.
          await this.q(`UPDATE $S.events SET items_pending = NULL WHERE id = $1 AND items_pending = $2`, [recorded.id, recorded.itemsPending]);
        }
        // A done task isn't taken over above; once this event opened it again, the rule it now matches takes it, as for an open one.
        if (reopened && changes.length && placed.rule.id !== task.rule_id && placed.rule.action === "task") {
          task = await this.refile(task, placed.rule);
          outgrown = undefined;
        }
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
        // The move is reported by the run that takes it (a sweep that finished it first reports it), the last write here,
        // with everything its update needs already read: a failure before it leaves the move for the sweep. Its mark stays
        // until the hub has posted the update (see IngestResult.updated's joined).
        const joined = placed.joined && (await this.claimJoin(recorded.id));
        if (placed.joined && !joined) changes = changes.slice(placed.joined.changes.length);
        touched.set(fresh.id, fresh);
        if (!opened.has(fresh.id)) result.updated.push({ task: fresh, ...(event.title && { title: event.title }), ...(event.url && { url: event.url }), ...(reopened && { reopened }), ...(changes.length && { changes }), ...(outgrown && { outgrown }), ...(checklist !== undefined && { checklist }), ...(joined && { joined: joined.claim }) });
      } catch (error) {
        result.errors.push({ index, error: (error as Error).message, ...((!saved || fanning) && { retry: true }) });
        if (!saved || fanning) retried.add(event.source);
      } finally {
        // Done placing it (or failed to): the sweep may finish it now.
        // (Only its own lease: a newer version recorded since holds the lease for its own ingest, still placing it.)
        if (placing !== undefined) await this.q(`UPDATE $S.events SET placing_at = NULL WHERE id = $1 AND versions = $2`, [placing, placingVersion]).catch(() => {});
      }
    }
    // As they are now: a later event of this post (a team reply) may have closed one it opened. Those aren't new work.
    // (A read failing here returns no update: the moves this post took to report go back to the sweep.)
    try {
      for (const id of opened) {
        const task = await this.task(id);
        if (task && isOpen(task.status)) result.created.push(task);
      }
    } catch (error) {
      await this.releaseJoins(result.updated.flatMap((update) => (update.joined ? [update.joined] : []))).catch(() => {});
      throw error;
    }
    const by = new Map<string, number>();
    for (const event of events) by.set(event.source, (by.get(event.source) ?? 0) + 1);
    // (Not for a source with events to post again: its next post is still its first run, when this one was.)
    for (const [source, count] of by)
      if (consent.get(source)?.enabled && !retried.has(source)) await this.q(`UPDATE $S.sources SET last_post_at = $3, last_count = $4, last_error = NULL WHERE owner = $1 AND source = $2`, [owner, source, now(), count]);
    return result;
  }

  // --- tasks --------------------------------------------------------------

  /**
   * Runs the rules on a recorded event and finds (or opens) its task. A rule
   * with `series` asks about a new recurring series once: its first event's
   * task asks the team, and the series' other events are held until they
   * answer; a series they said never to work on opens no tasks.
   */
  private async place(owner: string, event: EventInput, recorded: { id: number; version?: number; before?: EventInput }, config: SignalsConfig, firstRun: boolean, classifier?: Classifier, filtered?: () => void): Promise<{ task: Task; opened: boolean; create: boolean; rule: Rule; joined?: Joined } | undefined> {
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
    // A meeting's notes whose meeting has its task (its prep): the notes go there instead, once the rule's classifier
    // (asked here, before anything moves) passes them, as it would before opening their own follow-up.
    if (rule.meeting_task) {
      if (!(await this.classified(event, recorded, decision, classifier, filtered))) return undefined;
      classifier = undefined;
      const meeting = await this.meetingTask(event, recorded, decision, config);
      if (meeting) return { ...meeting, opened: false, create: true, rule };
    }
    const placed = await this.placeNew(owner, event, recorded, decision, classifier, filtered);
    if (placed && decision.same) await this.copyOf(decision.same, placed.task.id);
    return placed;
  }

  /**
   * For a rule with `meeting_task`: the task rule `meeting_task.rule` has for
   * the calendar event the notes' `payload.meeting` link names (an event of
   * `meeting_task.source` on it, whoever's calendar it came from: the task is
   * the team's, in the account's channel, and is the same task for every
   * attendee's copy). Only when exactly one such task is there, it isn't
   * asking about its series, and it's the account and channel the notes are
   * for (the notes' routing decides; a prep task elsewhere is left alone).
   * The notes' group is linked to it, and it moves to this rule (workstream,
   * and the team's mode for this rule on the notes' account) with an
   * activity, and the move is marked on the notes event (join_pending), all
   * in one statement, so the notes' later versions come to it, its sweep
   * follows this rule (a prep task's meeting end no longer closes it), and a
   * failed write after it leaves the move for the sweep to finish. Returns
   * the task, and the move (only for the call whose statement linked it).
   * Undefined: the notes open their own task.
   */
  private async meetingTask(event: EventInput, recorded: { id: number; version?: number; before?: EventInput }, decision: Extract<Decision, { kind: "task" }>, config: SignalsConfig): Promise<{ task: Task; joined?: Joined } | undefined> {
    const rule = decision.rule;
    const spec = rule.meeting_task!;
    const target = config.rules.find((one) => one.id === spec.rule && one.action === "task");
    const meetingId = calendarEventId(event.payload?.meeting);
    if (!target || !meetingId || decision.mode === "off" || !decision.account) return undefined;
    const prefix = `${target.group ?? target.id}|`;
    const found = await this.q(
      `SELECT DISTINCT t.* FROM $S.task_events te JOIN $S.events e ON e.id = te.event_id JOIN $S.tasks t ON t.id = te.task_id
       WHERE e.source = $1 AND e.external_id = $2 AND left(t.group_key, length($3)) = $3 AND (t.series IS NULL OR t.asked_by IS DISTINCT FROM $4)
       ORDER BY t.id LIMIT 2`,
      [spec.source ?? "google_calendar", meetingId, prefix, SERIES_ASKER],
    );
    if (found.rows.length !== 1) return undefined;
    const task = toTask(found.rows[0]!);
    if (task.account?.toLowerCase() !== decision.account.name.toLowerCase() || (task.channel ?? null) !== (decision.channel ?? null)) return undefined;
    const time = now();
    const workstream = rule.workstream ?? task.workstream ?? null;
    // The move, and the fields the rules watch, as an attached event's update shows them (what they were: this event's last
    // version, or else the task's latest event): saved with the move, so the handoff a retry posts is the same.
    const watched = [...(rule.watch ?? []), ...(config.rules.find((one) => one.id === task.rule_id)?.watch ?? [])];
    const changes: FieldChange[] = [
      ...(task.workstream && workstream && task.workstream !== workstream ? [{ field: "workstream", from: task.workstream, to: workstream }] : task.rule_id !== rule.id ? [{ field: "rule", from: task.rule_id, to: rule.id }] : []),
      ...(watched.length ? fieldChanges(watched, recorded.before ?? (await this.latestEvent(task.id)), event) : []),
    ];
    // Opened again when the notes are attached, unless the notes rule says notes like these are past done.
    const joined: Joined = { task: task.id, changes, reopen: !doneReason(doneWhenOf(config, rule), event, { at: time, sweep: true }), was_done: !isOpen(task.status), at: time };
    const linked = await this.q(
      // Only while this is the notes event's saved version and the doc's newest revision, checked here as openTask does:
      // an older revision, its classifier finishing late, moves nothing. The event's row is locked for the update up front
      // (as fan-out's attachment does), since this statement writes join_pending on it: two runs finishing the same move
      // (the sweep and an identical repost) take turns, where with share locks each would wait on the other's.
      `WITH l AS (INSERT INTO $S.group_links (group_key, task_id, at) SELECT $1, id, $3 FROM $S.tasks WHERE id = $2 AND NOT EXISTS (SELECT 1 FROM $S.tasks WHERE group_key = $1)
             AND EXISTS (SELECT 1 FROM $S.events WHERE id = $9::bigint AND ($10::integer IS NULL OR versions = $10::integer) FOR NO KEY UPDATE)
             AND ($10::integer IS NULL OR ${LATEST_REVISION(9)})
           ON CONFLICT (group_key) DO NOTHING RETURNING task_id),
         t AS (UPDATE $S.tasks SET rule_id = $4, workstream = $5, mode = $6, updated_at = $3 WHERE id = $2 AND EXISTS (SELECT 1 FROM l) RETURNING *),
         act AS (INSERT INTO $S.activities (task_id, at, actor, kind, text) SELECT id, $3, 'signals', 'rule', $7 FROM t RETURNING 1),
         ev AS (UPDATE $S.events SET join_pending = $8::jsonb WHERE id = $9 AND EXISTS (SELECT 1 FROM t) RETURNING 1)
       SELECT * FROM t`,
      [decision.group, task.id, time, rule.id, workstream, decision.mode,
        `Now under rule ${rule.id}: this meeting's notes came in (${clip(event.title ?? event.external_id, 200)}), so its follow-up is here.`,
        JSON.stringify(joined), recorded.id, recorded.version ?? null],
    );
    if (!linked.rows[0]) {
      // Linked meanwhile by another post of these notes (that post tells its agents), or the notes have their own task now.
      const other = await this.taskByGroup(decision.group);
      return other ? { task: other } : undefined;
    }
    return { task: toTask(linked.rows[0]), joined };
  }

  /**
   * A notes event's move of its prep task (see meetingTask), taken to report:
   * the run whose statement takes it reports it. Its mark stays (the hub
   * clears it once the update is posted, see reportedJoins), and another run
   * leaves it alone until JOIN_LEASE has passed or it's released. The claim's
   * token is new each time: a run whose lease passed (another run took the
   * move since) can't clear or release the newer claim. Undefined: none, or
   * another run has it.
   */
  private async claimJoin(event: number): Promise<{ joined: Joined; claim: JoinClaim } | undefined> {
    const at = now();
    const claim = randomUUID();
    const found = await this.q<{ join_pending: unknown }>(
      `UPDATE $S.events SET join_claimed_at = $2, join_claim = $4 WHERE id = $1 AND join_pending IS NOT NULL AND (join_claimed_at IS NULL OR join_claimed_at < $3) RETURNING join_pending`,
      [event, at, at - JOIN_LEASE, claim],
    );
    const raw = found.rows[0]?.join_pending;
    if (raw === undefined || raw === null) return undefined;
    const joined = (typeof raw === "string" ? JSON.parse(raw) : raw) as Joined;
    return { joined, claim: { event, claim, at: joined.at ?? at } };
  }

  /** Moves the hub has posted the update for (see claimJoin): their marks cleared, each only while it's still that claim. */
  async reportedJoins(claims: readonly JoinClaim[]): Promise<void> {
    for (const { event, claim } of claims)
      await this.q(`UPDATE $S.events SET join_pending = NULL, join_claimed_at = NULL, join_claim = NULL WHERE id = $1 AND join_claim = $2`, [event, claim]);
  }

  /** Moves the hub couldn't post the update for (a read or the post failed): left for the next sweep, each only while it's still that claim. */
  async releaseJoins(claims: readonly JoinClaim[]): Promise<void> {
    for (const { event, claim } of claims) await this.q(`UPDATE $S.events SET join_claimed_at = NULL, join_claim = NULL WHERE id = $1 AND join_claim = $2`, [event, claim]);
  }

  /** A move with nothing to report (the notes aren't on the task it moved): its mark cleared (this run's claim, or one no run holds). */
  private async dropJoin(event: number, claim?: JoinClaim): Promise<void> {
    if (claim) await this.q(`UPDATE $S.events SET join_pending = NULL, join_claimed_at = NULL, join_claim = NULL WHERE id = $1 AND join_claim = $2`, [event, claim.claim]);
    else await this.q(`UPDATE $S.events SET join_pending = NULL WHERE id = $1 AND join_pending IS NOT NULL AND (join_claimed_at IS NULL OR join_claimed_at < $2)`, [event, now() - JOIN_LEASE]);
  }

  /** A notes event's pending move (see meetingTask), as saved. */
  private async pendingJoin(event: number): Promise<Joined | undefined> {
    const raw = (await this.q<{ join_pending: unknown }>(`SELECT join_pending FROM $S.events WHERE id = $1`, [event])).rows[0]?.join_pending;
    if (raw === undefined || raw === null) return undefined;
    return (typeof raw === "string" ? JSON.parse(raw) : raw) as Joined;
  }

  /**
   * An event a `fan_out` rule takes, on each opted-in account's candidate:
   * opened with its event and activity in one statement, or found by its
   * group and the event attached (never opening a finished one again). A
   * candidate's verdict is left as it is. Idempotent, so posting the event
   * again finishes what a failed write cut short: each candidate it opens is
   * added to `opened` as it's opened (posted once, by the ingest that opened
   * it), and each open, unjudged one this version is attached to is passed to
   * `updated` as it's attached, by the ingest whose write attached it (so an
   * update is reported once, and kept when a later account's write fails).
   */
  private async fanOutPlace(owner: string, event: EventInput, recorded: { id: number; version: number }, decisions: readonly Extract<Decision, { kind: "task" }>[], opened: Set<number>, updated: (task: Task) => void): Promise<void> {
    const occurred = toSeconds(event.occurred_at);
    for (const decision of decisions) {
      let task = await this.taskByGroup(decision.group);
      if (!task) {
        if (!decision.create) continue;
        const at = now();
        // One statement: the candidate, its event and its activity are all written or none is. A run placing the same
        // announcement at the same time inserts nothing, and finds the one it committed (read again below).
        const inserted = await this.q(
          `WITH ins AS (
             INSERT INTO $S.tasks (rule_id, group_key, title, account, channel, workstream, mode, created_by, created_at, updated_at, last_event_at, event_count, latest_event)
             -- Only while this is the event's saved version (locked, as in attach): a superseded ingest opens nothing.
             SELECT $1, $2, $3, $4, $5, $6, $7, $8, $9, $9, $10, 1, $11 WHERE EXISTS (SELECT 1 FROM $S.events WHERE id = $11 AND versions = $12 FOR SHARE)
             ON CONFLICT (group_key) DO NOTHING RETURNING *),
           te AS (INSERT INTO $S.task_events (task_id, event_id, version, at) SELECT id, $11, $12, $9 FROM ins RETURNING 1),
           act AS (INSERT INTO $S.activities (task_id, at, actor, kind, text) SELECT id, $9, 'signals', 'opened', $13 FROM ins RETURNING 1)
           SELECT * FROM ins`,
          [decision.rule.id, decision.group, decision.title, decision.account?.name ?? null, decision.channel ?? null, decision.rule.workstream ?? null, decision.mode, owner, at, Number.isNaN(occurred) ? at : occurred, recorded.id, recorded.version,
            `Opened by rule ${decision.rule.id}, for ${decision.account?.name ?? "this account"}.`],
        );
        if (inserted.rows[0]) {
          opened.add(Number(inserted.rows[0].id));
          continue;
        }
        task = await this.taskByGroup(decision.group);
        if (!task) continue;
      }
      // Attached by this write (not already on it, from this ingest or one at the same time, and still the saved version):
      // reported here, once, as the write left it.
      const fresh = (await this.attachOnce(task.id, recorded.id, recorded.version, occurred, undefined, true)).attached;
      if (fresh && isOpen(fresh.status) && !fresh.verdict && !opened.has(fresh.id)) updated(fresh);
    }
  }

  /**
   * Records a fan-out candidate's verdict, with why (see Rule.fan_out), in one
   * statement with its activity: `disqualified` also marks an open one done
   * (its question off, and that activity too); the others leave its status.
   * Events that come in later never change it; only another verdict does.
   */
  async setVerdict(id: number, verdict: Verdict, actor: string, note?: string): Promise<Task | undefined> {
    if (!VERDICTS.includes(verdict)) throw new Error(`verdict must be one of ${VERDICTS.join(", ")}`);
    const done = note ? `Disqualified: ${note}` : "Disqualified.";
    const found = await this.q(
      `WITH old AS (SELECT id, status FROM $S.tasks WHERE id = $1 FOR UPDATE),
       closes AS (SELECT id FROM old WHERE $2 = 'disqualified' AND status NOT IN ('done', 'dismissed')),
       t AS (
         UPDATE $S.tasks SET verdict = $2, verdict_by = $3, verdict_at = $4, updated_at = $4,
           status = CASE WHEN EXISTS (SELECT 1 FROM closes) THEN 'done' ELSE status END,
           question = CASE WHEN EXISTS (SELECT 1 FROM closes) THEN NULL ELSE question END,
           options = CASE WHEN EXISTS (SELECT 1 FROM closes) THEN NULL ELSE options END,
           asked_by = CASE WHEN EXISTS (SELECT 1 FROM closes) THEN NULL ELSE asked_by END
         WHERE id = (SELECT id FROM old) RETURNING *),
       act AS (
         INSERT INTO $S.activities (task_id, at, actor, kind, text)
         SELECT id, $4, $3, 'verdict', $5 FROM t
         UNION ALL SELECT id, $4, 'signals', 'status', $6 FROM closes WHERE EXISTS (SELECT 1 FROM t)
         RETURNING 1)
       SELECT * FROM t`,
      [id, verdict, actor, now(), (note ? `${verdict}: ${note}` : verdict).slice(0, 4000), `done: ${done}`.slice(0, 4000)],
    );
    return found.rows[0] ? toTask(found.rows[0]) : undefined;
  }

  /** Records that a copy key's thing is on a task (the first task it was on keeps it). */
  private async copyOf(key: string, task: number): Promise<void> {
    await this.q(`INSERT INTO $S.copies (key, task_id, at) VALUES ($1, $2, $3) ON CONFLICT (key) DO NOTHING`, [key, task, now()]);
  }

  private async copyTask(key: string): Promise<Task | undefined> {
    const found = await this.q(`SELECT t.* FROM $S.copies c JOIN $S.tasks t ON t.id = c.task_id WHERE c.key = $1`, [key]);
    return found.rows[0] ? toTask(found.rows[0]) : undefined;
  }

  /**
   * The rule's classifier on an event that would open (or, with
   * meeting_task, move) a task: false when it scored it under the rule's
   * minimum (recorded as filtered, for the channel its task would have gone
   * to); a passing score is recorded too. Fails open: no classifier, or no
   * score (the model is down, say), passes.
   */
  private async classified(event: EventInput, recorded: { id: number; version?: number }, decision: Extract<Decision, { kind: "task" }>, classifier?: Classifier, filtered?: () => void): Promise<boolean> {
    const rule = decision.rule;
    if (!rule.classify || !classifier) return true;
    const score = await classifier(event, rule.classify).catch(() => undefined);
    const min = rule.classify.min ?? DEFAULT_CLASSIFY_MIN;
    if (typeof score === "number" && Number.isFinite(score) && score < min) {
      // The channel its task would have gone to, so that channel's board can list it.
      // (Only while this is still the event's latest version: an older one's request, finishing late, leaves the newer one's decision.)
      await this.q(`UPDATE $S.events SET filtered_rule = $2, filtered_score = $3, filtered_at = $4, filtered_channel = $5, filtered_version = $6 WHERE id = $1 AND ($6::integer IS NULL OR versions = $6::integer)`, [recorded.id, rule.id, score, now(), decision.channel ?? null, recorded.version ?? null]);
      filtered?.();
      return false;
    }
    if (typeof score === "number") await this.q(`UPDATE $S.events SET filtered_rule = NULL, filtered_score = $2, filtered_at = NULL, filtered_channel = NULL, filtered_version = $3 WHERE id = $1 AND ($3::integer IS NULL OR versions = $3::integer)`, [recorded.id, score, recorded.version ?? null]);
    return true;
  }

  /** The category the categorizer picks for an event its rule's categories' `when` didn't place, if it picks one of them. */
  private async category(event: EventInput, rule: Rule): Promise<string | undefined> {
    const choices = categoryChoices(rule);
    if (!choices || !this.categorizer) return undefined;
    const picked = await this.categorizer(event, choices).catch(() => undefined);
    const key = picked?.trim().toLowerCase();
    return rule.categories?.find((category) => category.about?.trim() && category.workstream.trim().toLowerCase() === key)?.workstream.trim();
  }

  private async placeNew(owner: string, event: EventInput, recorded: { id: number; version?: number }, decision: Extract<Decision, { kind: "task" }>, classifier?: Classifier, filtered?: () => void): Promise<{ task: Task; opened: boolean; create: boolean; rule: Rule } | undefined> {
    const rule = decision.rule;
    if (!(await this.classified(event, recorded, decision, classifier, filtered))) return undefined;
    // For a rule with a classifier or action items, the task opens only while this is still the event's latest version, checked in the
    // statement that opens it: whether this run just asked the classifier or the sweep retries a saved version, a newer version recorded
    // meanwhile is that version's to decide (with its own request), not this one's. For notes (action_items) that includes a newer
    // revision of the same document saved under its own id (see LATEST_REVISION), as for meeting_task's notes.
    // (So for a rule with meeting_task: an older revision whose move the newest one's decision stopped opens no follow-up instead.)
    const latest = (rule.classify || rule.action_items || rule.meeting_task) && recorded.version !== undefined ? { event: recorded.id, version: recorded.version, revisions: Boolean(rule.action_items || rule.meeting_task) } : undefined;
    // Its category (see Rule.categories): one whose `when` matched (decide), or the one the model picks, with the team's mode for it.
    let { workstream, mode } = { workstream: decision.workstream ?? rule.workstream, mode: decision.mode };
    if (!decision.category) {
      const picked = await this.category(event, rule);
      if (picked) {
        workstream = picked;
        mode = categoryModeFor(decision.account?.preferences, rule, picked);
        // The team turned that kind of work off: no task, as for a rule whose work is off.
        if (mode === "off") return undefined;
      }
    }
    const input = { rule: decision.rule.id, group: decision.group, title: decision.title, account: decision.account?.name, channel: decision.channel, workstream, mode, by: owner, at: toSeconds(event.occurred_at), latest };
    const open = async (task: Parameters<SignalsStore["openTask"]>[0]) => {
      const opened = await this.openTask(task);
      return opened && { task: opened, opened: true, create: true, rule };
    };
    if (!decision.series) return open(input);
    const series = await this.seriesFor(decision.series);
    if (series?.answer === "never") return undefined;
    if (series?.answer === "always") return open({ ...input, series: decision.series });
    if (series?.asked_task) {
      await this.q(`UPDATE $S.events SET held_series = $2 WHERE id = $1`, [recorded.id, decision.series]);
      return undefined;
    }
    // A new (or undecided) series: this task asks the team, in ask mode so no agent starts on it yet.
    const asking = await this.openTask({ ...input, mode: "ask", series: decision.series });
    if (!asking) return undefined;
    await this.q(
      `INSERT INTO $S.series (key, rule_id, account, title, asked_task, mode, created_at) VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (key) DO UPDATE SET asked_task = EXCLUDED.asked_task, title = EXCLUDED.title, mode = EXCLUDED.mode`,
      [decision.series, decision.rule.id, decision.account?.name ?? null, decision.title, asking.id, decision.mode, now()],
    );
    return { task: (await this.setQuestion(asking.id, SERIES_ASKER, { question: seriesQuestion(decision.title), options: SERIES_OPTIONS, by: SERIES_ASKER }))!, opened: true, create: true, rule };
  }

  /**
   * Opens a task (or finds its group's). With `latest`, only while that event is still at that version, checked in the
   * statement that opens it (the event's row locked to share, so a newer version being recorded waits for it, and one
   * recorded first fails the check): none is opened for a version a newer one has replaced.
   */
  private async openTask(input: { rule: string; group: string; title: string; account?: string; channel?: string; workstream?: string; mode: Mode; by: string; at: number; series?: string; latest?: { event: number; version: number; revisions?: boolean } }): Promise<Task | undefined> {
    const at = now();
    const found = await this.q(
      `INSERT INTO $S.tasks (rule_id, group_key, title, account, channel, workstream, mode, created_by, created_at, updated_at, last_event_at, series)
       SELECT $1, $2, $3, $4, $5, $6, $7, $8, $9, $9, $10, $11
       WHERE $12::bigint IS NULL OR (EXISTS (SELECT 1 FROM $S.events WHERE id = $12::bigint AND versions = $13::integer FOR SHARE)
         AND (NOT $14::boolean OR ${LATEST_REVISION(12)}))
       ON CONFLICT (group_key) DO UPDATE SET updated_at = $S.tasks.updated_at RETURNING *`,
      [input.rule, input.group, input.title, input.account ?? null, input.channel ?? null, input.workstream ?? null, input.mode, input.by, at, Number.isNaN(input.at) ? at : input.at, input.series ?? null, input.latest?.event ?? null, input.latest?.version ?? null, input.latest?.revisions ?? false],
    );
    if (!found.rows[0]) return undefined;
    const task = toTask(found.rows[0]);
    await this.activity(task.id, "signals", "opened", `Opened by rule ${input.rule}.`);
    return task;
  }

  /**
   * For a notes event whose action items weren't all written, or whose move
   * of its meeting's prep task wasn't reported (a write failed): writes the
   * items now, from the saved event (each item once), and finishes the move
   * (attaching the notes, opening the task again when the move said so) and
   * returns it to be reported, once. The sweep runs it for every such event,
   * so it doesn't wait on the poller posting the same version again (it
   * won't: it has read it).
   */
  private async resumeItems(owner: string, id: number, config: SignalsConfig, classifier?: Classifier): Promise<Resumed | undefined> {
    // Not one an ingest is placing now (it decides, with its classifier): left to it until it's done or its lease is past.
    // (A move another run took to report is left to it, too: see claimJoin.)
    const row = (await this.q(`SELECT * FROM $S.events WHERE id = $1 AND (items_pending IS NOT NULL OR (join_pending IS NOT NULL AND (join_claimed_at IS NULL OR join_claimed_at < $3))) AND (placing_at IS NULL OR placing_at < $2)`, [id, now() - PLACING_LEASE, now() - JOIN_LEASE])).rows[0];
    if (!row) return undefined;
    const itemsPending = num(row.items_pending);
    const done = () => (itemsPending === null ? Promise.resolve() : this.q(`UPDATE $S.events SET items_pending = NULL WHERE id = $1 AND items_pending = $2`, [id, itemsPending]));
    const event: EventInput = { ...toEvent(row), ...(row.group_key ? { group_key: String(row.group_key) } : {}) };
    const placedNow: number[] = [];
    let task = num(row.task_id) === null ? undefined : await this.task(num(row.task_id)!);
    // Never placed on its task (that write failed, after it was saved): placed and attached now, as ingest would have.
    // (It doesn't open a done task again from here: a sweep isn't the customer's message arriving. Unless the notes just
    // moved their meeting's prep task: that move said whether they open it again, as their ingest would have.)
    // The classifier's decision on this version (filtered, or its passing score), if it made one: an earlier version's is
    // about other content, and this one is asked again.
    const decided = num(row.filtered_version) !== null && num(row.filtered_version) === Number(row.versions) && num(row.filtered_score) !== null;
    if (num(row.task_id) === null && !(decided && row.filtered_rule)) {
      // With the rule's classifier, as ingest would have: one it filters isn't placed (and its marker is cleared below).
      // A decision ingest's classifier already made on this version (its score, kept when it passed) stands: not asked again.
      // And on a first run as its ingest was (see record).
      const placed = await this.place(owner, event, { id, version: Number(row.versions) }, config, row.items_first_run === true, decided ? undefined : classifier);
      if (placed) {
        // (The move as saved: by the ingest a failed write cut short, or by place just now.)
        const join = placed.joined ?? (await this.pendingJoin(id));
        const reopen = join?.task === placed.task.id && join.reopen;
        await this.attach(placed.task.id, id, Number(row.versions), toSeconds(event.occurred_at), { micros: toMicros(event.occurred_at), reopen });
        task = await this.task(placed.task.id);
        if (placed.opened && task) placedNow.push(task.id);
      }
    }
    const rule = task && config.rules.find((one) => one.id === task.rule_id && one.action_items);
    // Items to write: a rule with action items takes it and they aren't all written.
    const written = task && rule && itemsPending !== null ? await this.actionItems(owner, event, { id, version: Number(row.versions), micros: num(row.occurred_us) }, task, rule, config) : undefined;
    if (!written) await done();
    if (!task) {
      await this.dropJoin(id);
      return undefined;
    }
    // Its move, reported by the run that takes it, when the task it moved is the one the notes are on: the last write
    // here, after the task is read for the update, so a failure before it leaves the move for the next sweep (and the
    // hub clears its mark once it has posted the update).
    const current = (await this.task(task.id)) ?? task;
    const join = await this.claimJoin(id);
    const moved = join?.joined.task === task.id ? join.joined : undefined;
    if (join && !moved) await this.dropJoin(id, join.claim);
    if (!written && !moved) return undefined;
    // The handoff, as its first post would have been: with the checklist the notes saved on the task (a failed post, or one
    // whose items were written before), when no items were written now.
    const checklist = written?.checklist !== undefined ? written.checklist : moved && current.checklist ? current.checklist : undefined;
    return {
      task: current,
      opened: [...placedNow, ...(written?.opened ?? [])],
      ...(checklist !== undefined && { checklist }),
      ...(moved && { joined: join!.claim, ...(moved.changes.length && { changes: moved.changes }), ...(moved.was_done && isOpen(current.status) && { reopened: true }) }),
    };
  }

  /**
   * Finishes the action items of every notes event a failed write cut short,
   * and the moves of prep tasks it left unreported (see resumeItems).
   * Returns the tasks it opened and the follow-ups whose checklist changed or
   * that moved, to be posted as an ingest's are; an event that fails again
   * stays pending for the next sweep.
   */
  async pendingItems(config: SignalsConfig, limit = 20, classifier?: Classifier): Promise<{ created: Task[]; updated: IngestResult["updated"]; errors: { event: number; error: string }[] }> {
    const out = { created: [] as Task[], updated: [] as IngestResult["updated"], errors: [] as { event: number; error: string }[] };
    if (!config.rules.some((rule) => rule.action_items || rule.meeting_task)) return out;
    // Least recently tried first (never tried before those that failed), each marked tried now.
    const found = await this.q<{ id: unknown; owner: string; title: string | null; url: string | null }>(
      `UPDATE $S.events e SET items_tried = $2 FROM (SELECT id FROM $S.events WHERE items_pending IS NOT NULL OR (join_pending IS NOT NULL AND (join_claimed_at IS NULL OR join_claimed_at < $3))
         ORDER BY items_tried NULLS FIRST, id LIMIT $1) next
       WHERE e.id = next.id RETURNING e.id, e.owner, e.title, e.url`,
      [limit, Date.now(), now() - JOIN_LEASE],
    );
    found.rows.sort((a, b) => Number(a.id) - Number(b.id));
    for (const row of found.rows) {
      try {
        const resumed = await this.resumeItems(row.owner, Number(row.id), config, classifier);
        if (!resumed) continue;
        // (Its update first, from what resumeItems read before it cleared the move's mark: a failed read below loses no handoff.)
        if (resumed.checklist !== undefined || resumed.joined) out.updated.push({ task: resumed.task, ...(row.title && { title: row.title }), ...(row.url && { url: row.url }), ...resumedUpdate(resumed) });
        for (const id of resumed.opened) {
          const task = await this.task(id);
          if (task && isOpen(task.status)) out.created.push(task);
        }
      } catch (error) {
        out.errors.push({ event: Number(row.id), error: (error as Error).message });
      }
    }
    return out;
  }

  /**
   * A meeting's notes (`payload.notes`, its Next steps) for the rule's
   * `action_items`: each item the account team owns opens its own task (once
   * per doc and item: the same item in a later version of the doc is the same
   * task), assigned to the attendee its name is when it's exactly one. The
   * others (the customer's, both sides', not clear whose) become the
   * follow-up's checklist. Whose a name is comes from the meeting's
   * attendees: the poster's own copy of the calendar event its
   * `payload.meeting` link names, from a calendar source they have on (no
   * one else's calendar). Each item is written in one statement (its task,
   * its owner); the event is marked pending as it's recorded and done only
   * with the checklist, in one statement, so one a failed write cut short is
   * finished by the sweep (and its update sent then). Revisions
   * are ordered by their time: a revision first claims the follow-up (its
   * time, if no newer one has), and every item task and the checklist are
   * written only while no newer revision has claimed it, so an older one read
   * late opens nothing and changes nothing. A newer one with no items clears
   * the checklist, and notes that couldn't be read (no `notes` text) leave it
   * as it is. Returns the tasks it opened and, when it
   * changed, the checklist (null: cleared).
   */
  private async actionItems(owner: string, event: EventInput, recorded: { id: number; version: number; micros?: number | null }, followUp: Task, rule: Rule, config: SignalsConfig): Promise<{ opened: number[]; checklist?: string | null }> {
    const markDone = () => this.q(`UPDATE $S.events SET items_pending = NULL WHERE id = $1 AND items_pending = $2`, [recorded.id, recorded.version]);
    // (Already marked when the event was recorded, for a rule with action_items that applies to it; this covers any other way here.)
    // (Not by an older version than the event's latest: that one's own marker stands.)
    await this.q(`UPDATE $S.events SET items_pending = $2 WHERE id = $1 AND items_pending IS DISTINCT FROM $2 AND versions = $2`, [recorded.id, recorded.version]);
    // Notes it couldn't read: the checklist stays as it was.
    if (typeof event.payload?.notes !== "string") {
      await markDone();
      return { opened: [] };
    }
    const micros = recorded.micros ?? toMicros(event.occurred_at);
    const at = Number.isNaN(micros) ? now() * 1_000_000 : micros;
    // Claims the follow-up for this revision. An older one than it has: nothing to do (its items may be gone from the newer one).
    const claimed = await this.q(`UPDATE $S.tasks SET items_us = $2 WHERE id = $1 AND (items_us IS NULL OR items_us <= $2) RETURNING 1`, [followUp.id, String(at)]);
    if (!claimed.rows.length) {
      await markDone();
      return { opened: [] };
    }
    const items = parseNextSteps(event.payload.notes);
    const account = config.accounts?.find((one) => followUp.account && namesAccount(one, followUp.account.toLowerCase()));
    const domains = (account?.domains ?? []).map((domain) => domain.toLowerCase());
    // The meeting's attendees: only the poster's own copy, from a calendar source they have on.
    const meetingId = items.length ? calendarEventId(event.payload.meeting) : undefined;
    const meeting = meetingId
      ? (await this.q<{ payload: unknown }>(
          `SELECT e.payload FROM $S.events e JOIN $S.sources s ON s.owner = e.owner AND s.source = e.source AND s.enabled
           WHERE e.owner = $3 AND e.source = $1 AND e.external_id = $2`,
          [rule.action_items!.meetings ?? "google_calendar", meetingId, owner],
        )).rows[0]
      : undefined;
    const payload = typeof meeting?.payload === "string" ? JSON.parse(meeting.payload) : (meeting?.payload as Record<string, unknown> | undefined);
    const listed = attendeesOf(payload?.attendees).filter((a) => a.email);
    const ownDomain = (owner.split("@")[1] ?? "").toLowerCase();
    const atOwn = (email: string) => Boolean(ownDomain) && atDomains(email.toLowerCase(), [ownDomain]);
    // The customer's people: at the account's domains (and not a colleague's address there), or, without domains, anyone not at the poster's.
    const customers = domains.length ? realCustomers(listed, (email) => atDomains(email.toLowerCase(), domains)) : listed.filter((a) => !atOwn(a.email!));
    const theirs = new Set(customers.map((a) => a.email!.toLowerCase()));
    const ours = listed.filter((a) => !theirs.has(a.email!.toLowerCase()) && (atOwn(a.email!) || (domains.length > 0 && atDomains(a.email!.toLowerCase(), domains))));
    const people = { ours, customers, account: account ? [account.name, ...(account.aliases ?? [])] : followUp.account ? [followUp.account] : [] };
    const workstream = rule.action_items!.workstream ?? "meeting action items";
    const ruleId = `${rule.id}/action-item`;
    const mode = modeFor(account?.preferences, { id: ruleId, workstream });
    const doc = event.group_key ?? event.external_id;
    const opened: number[] = [];
    const tasks: string[] = [];
    const rest: string[] = [];
    for (const item of items) {
      const side = sideOf(item, people);
      // (With the workstream off, the team's items are listed too, rather than opened.)
      if (side !== "ours" || mode === "off") {
        rest.push(`- [ ] ${itemLine(item)} (${side === "customer" ? "the customer's" : side === "both" ? "shared" : side === "ours" ? "the account team's" : "owner not clear"})`);
        continue;
      }
      // Theirs when the name is exactly one of the account team's attendees; a name two of them share isn't guessed.
      const assigned: string[] = [];
      const unsure: string[] = [];
      for (const name of item.owners) {
        const matched = peopleNamed(name, ours);
        if (matched.length === 1) assigned.push(matched[0]!.email!.toLowerCase());
        else if (matched.length > 1) unsure.push(`Not assigned: "${name}" could be ${matched.map((a) => a.email).join(" or ")}.`);
      }
      const group = `${ruleId}|${doc}|${itemKey(item)}`;
      const time = now();
      // One statement: the task, its event, its owners and its activity are all written or none is.
      const found = await this.q<Row>(
        `WITH ins AS (
           INSERT INTO $S.tasks (rule_id, group_key, title, account, channel, workstream, mode, created_by, created_at, updated_at, last_event_at, event_count, latest_event)
           -- Only for the notes' latest revision: its version (locked, so a newer one being saved under this id waits for this), and no
           -- newer revision of the document saved under its own id. A superseded revision's items may be gone from the newer one.
           SELECT $1, $2, $3, $4, $5, $6, $7, $8, $9, $9, $9, 1, $10 WHERE EXISTS (SELECT 1 FROM $S.events WHERE id = $10 AND versions = $11 FOR SHARE)
             AND ${LATEST_REVISION(10)}
             -- Only while no newer revision has claimed the follow-up (locked, so one claiming now waits for this, or this sees its claim).
             AND EXISTS (SELECT 1 FROM $S.tasks WHERE id = $15 AND items_us <= $16 FOR SHARE)
           ON CONFLICT (group_key) DO NOTHING RETURNING *),
         te AS (INSERT INTO $S.task_events (task_id, event_id, version, at) SELECT id, $10, $11, $9 FROM ins RETURNING 1),
         act AS (INSERT INTO $S.activities (task_id, at, actor, kind, text) SELECT id, $9, 'signals', 'opened', $12 FROM ins
           UNION ALL SELECT id, $9, 'signals', 'unassigned', u FROM ins, unnest($14::text[]) AS u RETURNING 1),
         own AS (INSERT INTO $S.task_people (task_id, kind, key, at, assigned_at) SELECT id, 'person', k, $9, $9 FROM ins, unnest($13::text[]) AS k ON CONFLICT DO NOTHING RETURNING 1)
         SELECT * FROM ins`,
        [ruleId, group, clip(`Action: ${item.title ? `${item.title}: ` : ""}${item.text}`, 200), followUp.account, followUp.channel, workstream, mode, owner, time, recorded.id, recorded.version,
          `Opened from the action items in the notes of task ${followUp.id}: ${clip(itemLine(item), 500)}`, [...new Set(assigned)], unsure, followUp.id, String(at)],
      );
      // Another post opened it (or did meanwhile: a fresh read sees the row its insert committed).
      const row = found.rows[0] ?? (await this.q(`SELECT * FROM $S.tasks WHERE group_key = $1`, [group])).rows[0];
      if (!row) continue;
      const task = toTask(row);
      if (found.rows[0]) opened.push(task.id);
      tasks.push(`- Task ${task.id}: ${itemLine(item)}`);
    }
    const checklist = [
      rest.length ? `**Action items from the notes for this follow-up** (not the account team's own tasks):\n${rest.join("\n")}` : "",
      tasks.length ? `The account team's items have their own tasks:\n${tasks.join("\n")}` : "",
    ].filter(Boolean).join("\n") || null;
    // Only as new as the newest revision it took (a revision read late, at the same time as a newer one, loses here).
    // The event is marked done in the same statement: a checklist saved is never left without its update being sent (a retry sees it unchanged).
    const written = await this.q<{ was: unknown }>(
      `WITH ck AS (UPDATE $S.tasks t SET checklist = $2, items_us = $3 FROM (SELECT checklist AS was FROM $S.tasks WHERE id = $1 FOR UPDATE) old
         WHERE t.id = $1 AND (t.items_us IS NULL OR t.items_us <= $3)
           -- Only from the notes' latest revision saved, as for its action tasks: a newer one saved but not yet here writes its own.
           AND EXISTS (SELECT 1 FROM $S.events WHERE id = $4 AND versions = $5 FOR SHARE) AND ${LATEST_REVISION(4)}
         RETURNING old.was),
       ev AS (UPDATE $S.events SET items_pending = NULL WHERE id = $4 AND items_pending = $5 RETURNING 1)
       SELECT was FROM ck`,
      [followUp.id, checklist, String(at), recorded.id, recorded.version],
    );
    const changed = written.rows.length > 0 && ((written.rows[0]!.was as string | null) ?? null) !== checklist;
    return { opened, ...(changed && { checklist }) };
  }

  /** Moves a task to another rule of its group (its workstream too, when that rule names one), as a later event matched that rule. */
  private async refile(task: Task, rule: Rule): Promise<Task> {
    // A task already under one of the new rule's categories keeps it.
    const kept = rule.categories?.find((category) => category.workstream.trim().toLowerCase() === task.workstream?.trim().toLowerCase())?.workstream.trim();
    const found = await this.q(`UPDATE $S.tasks SET rule_id = $2, workstream = COALESCE($3, workstream), updated_at = $4 WHERE id = $1 RETURNING *`, [task.id, rule.id, kept ?? rule.workstream ?? null, now()]);
    await this.activity(task.id, "signals", "rule", `Now under rule ${rule.id}: a new event matched it.`);
    return found.rows[0] ? toTask(found.rows[0]) : task;
  }

  /**
   * Adds an event to a task. One that isn't a team reply (`customer`) raises
   * the task's newest customer time; with `reopen`, a finished task opens
   * again unless a team reply decided on it came at or after the event (that
   * reply answered it). All in one statement that locks the task row first,
   * so a reply decided at the same time either sees this event or is seen by
   * it. Returns whether it reopened the task.
   */
  private async attach(task: number, event: number, version: number, at: number, customer?: Readonly<{ micros: number; reopen: boolean }>): Promise<boolean> {
    return (await this.attachOnce(task, event, version, at, customer)).reopened;
  }

  /**
   * attach, also giving the task as this call left it when this call attached
   * the event (undefined: that version was on the task already, or with
   * `current`, it's no longer the event's saved version: a newer edit is
   * saved, and its ingest places it). In one statement, so a read after it
   * failing can't lose what it did.
   */
  private async attachOnce(task: number, event: number, version: number, at: number, customer?: Readonly<{ micros: number; reopen: boolean }>, current = false): Promise<{ reopened: boolean; attached?: Task }> {
    const micros = customer && !Number.isNaN(customer.micros) ? String(customer.micros) : null;
    const found = await this.q<{ reopened: unknown; task: unknown }>(
      `WITH lk AS (SELECT id, status, answered_us FROM $S.tasks WHERE id = $1 FOR UPDATE),
       ins AS (INSERT INTO $S.task_events (task_id, event_id, version, at) SELECT $1, $2, $3, $5 FROM lk
         -- (With current: only while $3 is the event's saved version, so an edit being saved waits for this, or this sees it.
         -- Locked as ev below updates it, not FOR SHARE first: two of these on the event, for two tasks, would each hold a
         -- share lock and wait for the other's to update it, a deadlock.)
         WHERE EXISTS (SELECT 1 FROM $S.events WHERE id = $2${current ? " AND versions = $3 FOR NO KEY UPDATE" : ""}) ON CONFLICT DO NOTHING RETURNING task_id),
       ev AS (UPDATE $S.events SET task_id = $1 WHERE id = $2 AND EXISTS (SELECT 1 FROM ins) RETURNING 1),
       -- (Only while the event is saved: Forget's delete of it waits for this, or wins and this changes nothing on the task.)
       cust AS (SELECT $6::bigint AS us WHERE $6::bigint IS NOT NULL AND EXISTS (SELECT 1 FROM ev) AND NOT EXISTS (SELECT 1 FROM $S.replies WHERE event_id = $2)),
       -- (For a task closed before answered_us was kept: its decided replies as this statement sees them.)
       answered AS (
         SELECT COALESCE((SELECT answered_us FROM lk), (SELECT max(COALESCE(r.at_us, r.at * 1000000)) FROM $S.replies r WHERE r.applied_at IS NOT NULL
           AND (r.closed_task = $1 OR EXISTS (SELECT 1 FROM $S.task_events te WHERE te.task_id = $1 AND te.event_id = r.event_id)))) AS us),
       dec AS (
         SELECT $7::boolean AND lk.status IN ('done', 'dismissed') AND (SELECT us FROM cust) IS NOT NULL
           AND (SELECT us FROM cust) > COALESCE((SELECT us FROM answered), -1) AS reopen
         FROM lk WHERE EXISTS (SELECT 1 FROM ev)),
       t AS (
         -- The latest event is the newest by when it happened (one older that comes in late is kept in its history, not made latest).
         UPDATE $S.tasks SET event_count = event_count + 1,
           -- (By microsecond, as saved: two reminders in the same second are told apart.)
           latest_event = CASE WHEN latest_event IS NULL OR latest_event = $2
             OR (SELECT ${EVENT_MICROS} FROM $S.events e WHERE e.id = $2) >= COALESCE((SELECT ${EVENT_MICROS} FROM $S.events e WHERE e.id = $S.tasks.latest_event), -1)
             THEN $2 ELSE latest_event END,
           last_event_at = GREATEST(last_event_at, $4), updated_at = $5,
           customer_us = GREATEST(customer_us, (SELECT us FROM cust)),
           status = CASE WHEN (SELECT reopen FROM dec) THEN 'open' ELSE status END
         WHERE id = $1 AND EXISTS (SELECT 1 FROM dec)
         RETURNING *),
       again AS (
         INSERT INTO $S.activities (task_id, at, actor, kind, text)
         SELECT $1, $5, 'signals', 'status', 'open: Opened again: a new event came in.' FROM dec WHERE dec.reopen AND EXISTS (SELECT 1 FROM t)
         RETURNING 1)
       SELECT EXISTS (SELECT 1 FROM again) AS reopened, (SELECT row_to_json(t) FROM t) AS task`,
      [task, event, version, Number.isNaN(at) ? now() : at, now(), micros, customer?.reopen ?? false],
    );
    // (pg gives row_to_json as an object, PGlite may give text.)
    const raw = found.rows[0]?.task;
    const row = typeof raw === "string" ? (JSON.parse(raw) as Row) : (raw as Row | null | undefined);
    return { reopened: Boolean(found.rows[0]?.reopened), ...(row && { attached: toTask(row) }) };
  }

  /**
   * Works out tasks' newest customer message and newest decided team reply
   * again from the rows left (after Forget deleted some). Attaching and
   * deciding only ever raise them, under the task's row lock: when one of
   * them raised a task's value while this waited for that lock (after this
   * statement's snapshot), its value is kept too.
   */
  private async retime(tasks: readonly string[]): Promise<void> {
    // Each try reads the rows left and writes only when the task's times are still what that read saw. Otherwise
    // something changed them meanwhile (an attachment, a closure, another Forget), and it reads again: a value
    // worked out from an older read never stands.
    let left = [...tasks];
    for (let attempt = 0; left.length && attempt < 50; attempt++) {
      const done = await this.q<{ id: unknown }>(
        `UPDATE $S.tasks t SET customer_us = s.customer, answered_us = s.answered
         FROM (
           SELECT x.id, x.customer_us AS customer_was, x.answered_us AS answered_was,
             (SELECT max(${EVENT_MICROS}) FROM $S.task_events te JOIN $S.events e ON e.id = te.event_id
               WHERE te.task_id = x.id AND NOT EXISTS (SELECT 1 FROM $S.replies r WHERE r.event_id = e.id)) AS customer,
             (SELECT max(COALESCE(r.at_us, r.at * 1000000)) FROM $S.replies r WHERE r.applied_at IS NOT NULL
               AND (r.closed_task = x.id OR EXISTS (SELECT 1 FROM $S.task_events te WHERE te.task_id = x.id AND te.event_id = r.event_id))) AS answered
           FROM $S.tasks x WHERE x.id = ANY($1::bigint[])) s
         WHERE t.id = s.id AND t.customer_us IS NOT DISTINCT FROM s.customer_was AND t.answered_us IS NOT DISTINCT FROM s.answered_was
         RETURNING t.id`,
        [left],
      );
      const written = new Set(done.rows.map((row) => String(row.id)));
      left = left.filter((id) => !written.has(id));
    }
    if (left.length) throw new Error(`couldn't work out the times of tasks ${left.join(", ")} again`);
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
    const events = await this.q(`SELECT e.id, e.source, e.external_id, e.title, e.url, e.actor, e.occurred_at, e.versions, e.owner FROM $S.events e
       -- (An event on several tasks, an announcement on each account's candidate, has the last as its task_id: task_events has them all.)
       WHERE e.task_id = $1 OR e.id IN (SELECT event_id FROM $S.task_events WHERE task_id = $1) ORDER BY e.occurred_at DESC LIMIT 100`, [id]);
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

  /** `ref`: what it's about (a move, say), recorded once per task and kind, whatever its text: a retried post records nothing. */
  async activity(task: number, actor: string, kind: string, text: string, ref?: string): Promise<void> {
    if (ref === undefined) await this.q(`INSERT INTO $S.activities (task_id, at, actor, kind, text) VALUES ($1, $2, $3, $4, $5)`, [task, now(), actor, kind, text.slice(0, 4000)]);
    else
      await this.q(
        `INSERT INTO $S.activities (task_id, at, actor, kind, text, ref) VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (task_id, kind, ref) WHERE ref IS NOT NULL DO NOTHING`,
        [task, now(), actor, kind, text.slice(0, 4000), ref],
      );
  }

  /**
   * Records the disclosure check's result for a reply and, for a warning, its
   * activity on the task, in one statement: both are saved or neither is, so a
   * failed write leaves the reply to be checked again. True only for the call
   * that recorded it first, so overlapping collectors warn once.
   */
  async disclosureChecked(task: number, reply: string, status: string, kinds: readonly string[] = [], warning?: { actor: string; text: string }): Promise<boolean> {
    const inserted = await this.q(
      `WITH checked AS (
         INSERT INTO $S.disclosure_checks (task_id, reply_id, status, kinds, at) VALUES ($1, $2, $3, $4, $5) ON CONFLICT DO NOTHING RETURNING task_id, at
       ), warned AS (
         INSERT INTO $S.activities (task_id, at, actor, kind, text) SELECT task_id, at, $6, 'disclosure_warning', $7 FROM checked WHERE $7::text IS NOT NULL RETURNING id
       )
       SELECT task_id FROM checked`,
      [task, reply, status, [...kinds], now(), warning?.actor ?? "", warning?.text.slice(0, 4000) ?? null],
    );
    return inserted.rows.length > 0;
  }

  /** The disclosure check's results on a task, oldest first. */
  async disclosureChecks(task: number): Promise<{ reply_id: string; status: string; kinds: string[]; at: number }[]> {
    const found = await this.q(`SELECT reply_id, status, kinds, at FROM $S.disclosure_checks WHERE task_id = $1 ORDER BY at, reply_id`, [task]);
    return found.rows.map((row) => ({ reply_id: String(row.reply_id), status: String(row.status), kinds: (row.kinds as string[]) ?? [], at: Number(row.at) }));
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

  /**
   * Records a reply someone on the team sent in a group's thread (once; it
   * waits there until it's decided), only while its event is still saved:
   * undefined when Forget deleted it meanwhile.
   */
  private async recordReply(group: string, event: number, owner: string, input: EventInput, keep = false): Promise<Reply | undefined> {
    const title = input.title ? plainSlack(input.title).replace(/\s+/g, " ").trim().slice(0, 200) : null;
    const occurred = toSeconds(input.occurred_at);
    const at = Number.isNaN(occurred) ? now() : occurred;
    const precise = toMicros(input.occurred_at);
    const micros = Number.isNaN(precise) ? at * 1_000_000 : precise;
    // (The event's key-share lock holds Forget's delete of it until this commits; then Forget's delete of replies sees this row.)
    const saved = await this.q<{ kept: unknown }>(
      `WITH ev AS (SELECT id FROM $S.events WHERE id = $2 FOR KEY SHARE),
       ins AS (
         INSERT INTO $S.replies (group_key, event_id, owner, source, title, url, at, seen_at, at_us)
         SELECT $1, ev.id, $3, $4, $5, $6, $7, $8, $9::bigint FROM ev
         ON CONFLICT (group_key, event_id) DO ${keep ? "NOTHING" : "UPDATE SET title = EXCLUDED.title, url = EXCLUDED.url, at = EXCLUDED.at, at_us = EXCLUDED.at_us"} RETURNING 1)
       SELECT EXISTS (SELECT 1 FROM ev) AS kept, (SELECT count(*) FROM ins) AS n`,
      [group, event, owner.toLowerCase(), input.source, title, input.url ?? null, at, now(), String(micros)],
    );
    if (!saved.rows[0]?.kept) return undefined;
    return { group, event, owner: owner.toLowerCase(), source: input.source, title, url: input.url ?? null, at, micros };
  }

  /** Replies not decided yet: one event's, or one group's. */
  private async pendingReplies(where: { event: number } | { group: string }): Promise<Reply[]> {
    const found = "event" in where
      ? await this.q(`SELECT * FROM $S.replies WHERE event_id = $1 AND applied_at IS NULL ORDER BY at`, [where.event])
      : await this.q(`SELECT * FROM $S.replies WHERE group_key = $1 AND applied_at IS NULL ORDER BY at`, [where.group]);
    return found.rows.map((row) => ({ group: String(row.group_key), event: Number(row.event_id), owner: String(row.owner), source: String(row.source), title: (row.title as string | null) ?? null, url: (row.url as string | null) ?? null, at: Number(row.at), micros: row.at_us === null || row.at_us === undefined ? Number(row.at) * 1_000_000 : Number(row.at_us) }));
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
    // The reply's row lock comes first, and for update: a second decision of the same reply waits for this one, then finds the task done,
    // instead of both holding a share lock and deadlocking at `mark`. Forget's delete waits too, or wins and this closes nothing.
    const found = await this.q<{ task: unknown; agents: unknown; owners: unknown }>(
      // (Its event too: Forget deletes events before replies, so a reply whose event is gone is one being forgotten.)
      `WITH kept AS (SELECT 1 FROM $S.replies r JOIN $S.events e ON e.id = r.event_id WHERE r.group_key = $2 AND r.event_id = $5 FOR NO KEY UPDATE OF r FOR KEY SHARE OF e),
       -- Then the task row, for update (only once the reply is held, so two decisions take the locks in the same order). A customer
       -- message being attached holds it too: this waits for it and reads its customer_us, or it waits for this and reads answered_us.
       lk AS (SELECT id, status, series, asked_by, customer_us FROM $S.tasks WHERE id = $1 AND EXISTS (SELECT 1 FROM kept) FOR UPDATE),
       -- (For events attached before customer_us was kept.)
       latest AS (
         SELECT max(${EVENT_MICROS}) AS at FROM $S.task_events te JOIN $S.events e ON e.id = te.event_id
         WHERE te.task_id = $1 AND NOT EXISTS (SELECT 1 FROM $S.replies r WHERE r.event_id = e.id)),
       dec AS (
         SELECT lk.status NOT IN ('done', 'dismissed') AND NOT (lk.series IS NOT NULL AND lk.asked_by IS NOT DISTINCT FROM $9::text)
           AND $4::bigint >= COALESCE(GREATEST(lk.customer_us, (SELECT at FROM latest)), 0) AS close
         FROM lk),
       -- (Only while the reply is still saved: Forget deletes it, and a closure it was about to make with it. Its time is kept either way:
       -- a later customer message older than it doesn't reopen the task.)
       upd AS (
         UPDATE $S.tasks SET answered_us = GREATEST(answered_us, $4::bigint),
           status = CASE WHEN (SELECT close FROM dec) THEN 'done' ELSE status END,
           question = CASE WHEN (SELECT close FROM dec) THEN NULL ELSE question END,
           options = CASE WHEN (SELECT close FROM dec) THEN NULL ELSE options END,
           asked_by = CASE WHEN (SELECT close FROM dec) THEN NULL ELSE asked_by END,
           updated_at = CASE WHEN (SELECT close FROM dec) THEN $3 ELSE updated_at END
         WHERE id = $1 AND EXISTS (SELECT 1 FROM dec)
         RETURNING *),
       t AS (SELECT upd.* FROM upd, dec WHERE dec.close),
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

  /**
   * Marks a task done by its rule (not a person), clearing any question;
   * undefined if it's gone. With `seen` (the task as the sweep judged it, see
   * finishable): only while it's still open, asking nothing, under that rule
   * and with no event since, checked in the statement that closes it, so a
   * task that moved (a meeting's notes took its prep task over) or got an
   * event meanwhile is left open, for the next sweep to judge again.
   */
  async finish(id: number, reason: string, seen?: Pick<Task, "rule_id" | "event_count">): Promise<Task | undefined> {
    if (seen) {
      const at = now();
      const found = await this.q(
        `WITH t AS (UPDATE $S.tasks SET status = 'done', question = NULL, options = NULL, asked_by = NULL, updated_at = $2
             WHERE id = $1 AND status NOT IN ('done', 'dismissed') AND question IS NULL AND rule_id = $3 AND event_count = $4 RETURNING *),
           act AS (INSERT INTO $S.activities (task_id, at, actor, kind, text) SELECT id, $2, 'signals', 'status', $5 FROM t RETURNING 1)
         SELECT * FROM t`,
        [id, at, seen.rule_id, seen.event_count, `done: ${reason}`.slice(0, 4000)],
      );
      return found.rows[0] ? toTask(found.rows[0]) : undefined;
    }
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
      const placed = await this.place(String(row.owner), event, { id: Number(row.id), version: Number(row.versions) }, config, false);
      if (!placed) continue;
      await this.attach(placed.task.id, Number(row.id), Number(row.versions), toSeconds(event.occurred_at), { micros: toMicros(event.occurred_at), reopen: false });
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
    checklist: (row.checklist as string | null) ?? null,
    verdict: VERDICTS.includes(row.verdict as Verdict) ? (row.verdict as Verdict) : null,
    verdict_by: (row.verdict_by as string | null) ?? null,
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
