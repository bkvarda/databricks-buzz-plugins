// The signals hub's HTTP API, without the server: the app (./main.ts) gives it
// requests from Databricks Apps, which signs people in first and says who they
// are (X-Forwarded-Email). Every person's events and sources are their own:
// the hub takes the owner from the request, never from the body.
//
//   GET  /api/info                        what this is, for the plugin
//   GET  /api/sources                     your sources (on or off, last post, cursor) and the catalog to choose from
//   POST /api/sources {source, enabled, scope?, forget?}
//   POST /api/cursor  {source, cursor?, error?}  where a poller stopped, and its problem
//   POST /api/events  {events: [...]}     ingest (dedupe, rules, tasks)
//   GET  /api/tasks?status=&account=&channel=&workstream=&initiative=&open=1&limit=
//   GET  /api/task?id=                    a task with its events, activity and artifacts
//   POST /api/task {id, status?, note?, workstream?, initiative?, artifact?: {url, title?, kind?}}
//   GET  /api/accounts                    the account channels teams set up
//   GET  /api/account?channel=|name=      one, with its preferences read
//   GET  /api/ids                         every account's ids by kind, which pollers fill into queries
//   POST /api/account {name, rename?, channel?, aliases?, domains?, ids?, agents?, preferences?, profile?, playbooks?, delete?}
//   GET  /api/board?channel=              a channel's tasks for the board: who's on each, its source, artifacts, last activity
//   POST /api/task {id, agents: [...]}    asks agents to work on a task (in its thread)
//   POST /api/task {id, assign?: [...], unassign?: [...], note?}  sets its owners (see setOwners): agents or people, by
//                                         pubkey (hex or npub) or email, or {key, kind: "agent"|"person", label?}
//   POST /api/task {id, question, options?}  needs input: waiting, with the question (agents ask this way)
//   POST /api/task {id, input}            answers it: in the thread, mentioning the agents, and the task resumes
//   GET  /api/onboard | POST /api/onboard   your poller's setup: your database role (POST creates it if it can) and
//                                         the `lakebase` settings and arguments for your sources.json and job
//   GET  /api/config | POST /api/config   the rules (posting needs the app's CAN_MANAGE: see below)
import { randomUUID } from "node:crypto";
import { type Attendee, attendeesOf, realCustomers, twinOf } from "./attendees";
import { type AccountRecord, isOpen, configProblems, type FieldChange, DEFAULT_CLASSIFY_MIN, accountNames, idsByKind, readIds, plainSlack, type EventInput, sourceTitle, capitalized, DEFAULT_SOURCES, labelsOf, partyFor, type ResolvedLabels, type Rule, EMPTY_CONFIG, MAX_EVENTS_PER_POST, MAX_PLAYBOOK, MAX_PLAYBOOKS, agentListFor, agentsFor, parsePreferences, playbookFor, workstreamsOf, SERIES_ASKER, seriesAnswer, type SignalsConfig, TASK_STATUSES, type TaskStatus, validDomain, validateEvent, type Verdict, VERDICTS, withAccounts, readWorkstreamActions, type WorkstreamActions, actionsFor, actionsText, type PendingCheck, type TriggerNotice, type TriggerResult, type TriggerState, triggeredLines, type WorkstreamActionsRow } from "./model";
import { type Classifier, type Handled, type IngestResult, type JoinClaim, CHECK_LEASE, readTriggerState, type SignalsStore, type Task, type TaskPerson } from "./store";
import type { Triggerer } from "./classify";
import { DRAFT_FORMAT, disclosureCheck } from "./disclosure";
import { decode, npubEncode } from "nostr-tools/nip19";

const HEX64 = /^[0-9a-f]{64}$/;
/** A Buzz pubkey as hex, from hex or an npub; "" when it's neither. */
export function agentKey(value: string): string {
  const bare = value.trim().replace(/^nostr:/, "").toLowerCase();
  if (HEX64.test(bare)) return bare;
  try {
    const decoded = decode(bare);
    if (decoded.type === "npub") return decoded.data;
  } catch {}
  return "";
}
const npub = (key: string) => npubEncode(key);

export type HubRequest = Readonly<{ method: string; path: string; query: URLSearchParams; user?: string; body(): Promise<string> }>;
export type HubResponse = Readonly<{ status?: number; json: unknown }>;

/** Where tasks go in Buzz. The hub works without it (tasks stay in Lakebase). */
export type Notifier = Readonly<{
  /** Posts a new task at its channel's top level, mentioning `agents` (hex pubkeys); resolves with the message id. */
  opened(task: Task, agents?: readonly string[], context?: PostContext): Promise<string | undefined>;
  /** Replies in the task's thread, mentioning `agents` (hex pubkeys). */
  updated(task: Task, text: string, agents?: readonly string[]): Promise<void>;
  /** Replaces the text of the task's first message (an author edit; it mentions nobody). Optional. */
  edited?(task: Task, text: string): Promise<void>;
  /** Why the hub can't post in a channel (it isn't a member, it has no Buzz identity); null when it can, undefined when it can't tell. Optional. */
  canPost?(channel: string): Promise<string | null | undefined>;
}>;

/** What a task's post carries besides the task: the account briefing (for agents), the source event's details, and what its default actions found (`note`). */
export type PostContext = Readonly<{ briefing?: string; source?: string; note?: string }>;

/** A chat message as the relay gives it: enough to tell who replied in which thread. */
export type ThreadReply = Readonly<{ id: string; pubkey: string; content: string; created_at: number; tags: readonly (readonly string[])[] }>;

export type HubOptions = Readonly<{
  /** Who may change the rules (the app's owner, say). Everyone may when empty. */
  admins?: readonly string[];
  /** The config to use until one is saved (from SIGNALS_CONFIG). */
  defaultConfig?: SignalsConfig;
  /** Asks rules' `classify` questions (see jevClassifier); without it, rules with `classify` open their tasks unasked. */
  classifier?: Classifier;
  /** Where poller jobs reach the hub's database (from the app's postgres resource), for /api/onboard. */
  lakebase?: LakebaseInfo;
  /** Checks workstreams' default-action triggers (see chatTriggerer); without it, a row with actions to check fails open: its tasks go to agents as without a row. */
  triggerer?: Triggerer;
  log?(line: string): void;
}>;

/** Where a person's poller.py and sources.json live in the workspace. */
export const pollerFolder = (user: string) => `/Workspace/Users/${user}/signals-poller`;

/** The hub's database, as a person's poller job reaches it (sources.json's `lakebase`). */
export type LakebaseInfo = Readonly<{ endpoint: string; host: string; database: string; port?: number }>;

/** What /api/onboard tells a person about their poller: its database role, and the settings it needs. */
export type Onboarding = Readonly<{
  user: string;
  role: "ready" | "created" | "waiting";
  /** Why the hub couldn't create the role, and what someone who can should run. */
  waiting?: Readonly<{ reason: string; command?: string }>;
  /** sources.json's `lakebase`, or undefined when the hub doesn't know its database. */
  lakebase?: Readonly<{ endpoint: string; host: string; database: string; port?: number; schema: string }>;
  /** The workspace folder the person's poller.py and sources.json go in. */
  folder: string;
  /** The job's arguments, with sources.json's full workspace path (a job's working directory isn't the folder). */
  args: readonly string[];
}>;

const bad = (error: string, status = 400): HubResponse => ({ status, json: { error } });

/** Every path Hub.handle serves; the app routes exactly these to it. */
export const HUB_PATHS = ["/api/info", "/api/sources", "/api/cursor", "/api/events", "/api/tasks", "/api/task", "/api/accounts", "/api/account", "/api/board", "/api/config", "/api/ids", "/api/filtered", "/api/onboard", "/api/retitle"] as const;

export class Hub {
  private cached?: { at: number; config: SignalsConfig };
  private publishedIds?: string;
  /** The last failure to post a task in each channel, until a post there works. */
  private readonly postFailures = new Map<string, string>();
  /** Tasks being posted now, so overlapping posts of one task send one Buzz thread. */
  private readonly posting = new Map<number, Promise<void>>();

  constructor(
    readonly store: SignalsStore,
    private readonly notifier?: Notifier,
    private readonly options: HubOptions = {},
  ) {}

  /** The saved rules (or the starting ones), with the accounts teams set up. */
  async config(): Promise<SignalsConfig> {
    if (this.cached && Date.now() - this.cached.at < 30_000) return this.cached.config;
    const config = withAccounts((await this.store.config()) ?? this.options.defaultConfig ?? EMPTY_CONFIG, await this.store.accounts());
    this.cached = { at: Date.now(), config };
    // Poller jobs that reach the hub through Lakebase read the ids from a table.
    // Account names go there as kind `_name` (an id kind starts with a letter), for pollers that read notes docs.
    const ids = { ...idsByKind(config.accounts ?? []), _name: accountNames(config.accounts ?? []) };
    const text = JSON.stringify(ids);
    if (text !== this.publishedIds)
      await this.store.publishIds(ids).then(
        () => (this.publishedIds = text),
        (error: Error) => this.log(`couldn't publish account ids for pollers: ${error.message}`),
      );
    return config;
  }

  async handle(request: HubRequest): Promise<HubResponse> {
    const user = request.user?.toLowerCase();
    if (request.path === "/api/info") return { json: { kind: "signals-hub", version: 1, user: user ?? null, labels: labelsOf(await this.config().catch(() => undefined)) } };
    if (!user) return bad("Sign in through Databricks Apps: the hub needs to know who you are.", 401);
    const body = async () => {
      const text = await request.body();
      try {
        return text.trim() ? (JSON.parse(text) as Record<string, unknown>) : {};
      } catch {
        throw Object.assign(new Error("The body isn't JSON."), { status: 400 });
      }
    };
    try {
      switch (`${request.method} ${request.path}`) {
        case "GET /api/sources":
          return { json: { sources: await this.store.sources(user), catalog: (await this.config()).sources ?? DEFAULT_SOURCES } };
        case "POST /api/sources": {
          const input = await body();
          if (typeof input.source !== "string" || typeof input.enabled !== "boolean") return bad("Send {source, enabled}.");
          if (validateEvent({ source: input.source, external_id: "x" }) === "source must be a lowercase name like gmail or table.support_cases") return bad("source must be a lowercase name like gmail or table.support_cases");
          await this.store.setSource(user, input.source, input.enabled, input.scope, input.forget === true);
          this.log(`${user} turned ${input.source} ${input.enabled ? "on" : "off"}`);
          return { json: { sources: await this.store.sources(user) } };
        }
        case "POST /api/cursor": {
          const input = await body();
          if (typeof input.source !== "string" || (input.cursor !== undefined && typeof input.cursor !== "string")) return bad("Send {source, cursor?, error?}.");
          if (typeof input.cursor === "string") await this.store.setCursor(user, input.source, input.cursor);
          // A poller's problem with the source (not signed in, table unavailable), or null once it works again.
          if (input.error !== undefined) await this.store.sourceError(user, input.source, typeof input.error === "string" && input.error ? input.error : null);
          return { json: { ok: true } };
        }
        case "POST /api/events":
          return this.events(user, await body());
        case "GET /api/tasks": {
          const q = request.query;
          const status = q.get("status") ?? undefined;
          if (status && !TASK_STATUSES.includes(status as TaskStatus)) return bad(`status must be one of ${TASK_STATUSES.join(", ")}`);
          return {
            json: {
              tasks: await this.store.tasks({
                ...(status && { status }),
                ...(q.get("account") && { account: q.get("account")! }),
                ...(q.get("channel") && { channel: q.get("channel")! }),
                ...(q.get("workstream") && { workstream: q.get("workstream")! }),
                ...(q.get("initiative") && { initiative: q.get("initiative")! }),
                open: q.get("open") === "1" || q.get("open") === "true",
                limit: Number(q.get("limit") ?? 50) || 50,
              }),
            },
          };
        }
        case "GET /api/task": {
          const detail = await this.store.detail(Number(request.query.get("id")));
          return detail ? { json: detail } : bad("No such task.", 404);
        }
        case "POST /api/task":
          return this.updateTask(user, await body());
        case "GET /api/board": {
          const channel = request.query.get("channel");
          if (!channel) return bad("Send ?channel= (a Buzz channel id).");
          return { json: await this.board(channel) };
        }
        case "GET /api/filtered": {
          const q = request.query;
          const number = (name: string) => (q.get(name) ? Number(q.get(name)) || undefined : undefined);
          const days = number("days");
          const limit = number("limit");
          const events = await this.store.filtered({ ...(days && { days }), ...(limit && { limit }), ...(q.get("source") && { source: q.get("source")! }), ...(q.get("rule") && { rule: q.get("rule")! }), ...(q.get("channel") && { channel: q.get("channel")! }) });
          // Why each was held back: its rule's question and the score it needed.
          const rules = new Map((await this.config()).rules.map((rule) => [rule.id, rule]));
          return {
            json: {
              events: events.map((event) => {
                const classify = rules.get(event.rule)?.classify;
                return classify ? { ...event, question: classify.question, min: classify.min ?? DEFAULT_CLASSIFY_MIN } : event;
              }),
            },
          };
        }
        case "GET /api/onboard":
          return { json: await this.onboard(user, false) };
        case "POST /api/onboard":
          return { json: await this.onboard(user, true) };
        case "GET /api/ids": {
          const accounts = (await this.config()).accounts ?? [];
          return { json: { ids: idsByKind(accounts), names: accountNames(accounts) } };
        }
        case "GET /api/accounts":
          return { json: { accounts: await this.store.accounts() } };
        case "GET /api/account": {
          const account = await this.store.account({ ...(request.query.get("name") && { name: request.query.get("name")! }), ...(request.query.get("channel") && { channel: request.query.get("channel")! }) });
          const config = await this.config();
          const warning = account ? await this.postProblem(account.channel) : undefined;
          return { json: { account: account ? withRead(account) : null, labels: labelsOf(config), workstreams: workstreamsOf(config), ...(warning && { warning }) } };
        }
        case "POST /api/account":
          return this.saveAccount(user, await body());
        case "GET /api/config":
          // The rules as saved; accounts teams set up are under /api/accounts.
          return { json: { config: (await this.store.config()) ?? this.options.defaultConfig ?? EMPTY_CONFIG, canEdit: this.isAdmin(user) } };
        case "POST /api/retitle": {
          // Titles and files open tasks again as their rules now would (see SignalsStore.retitle). A dry run unless dry_run is false.
          if (!this.isAdmin(user)) return bad("Only the hub's admins can retitle tasks.", 403);
          const input = await body();
          if (input.dry_run !== undefined && typeof input.dry_run !== "boolean") return bad("dry_run is true or false.");
          if (input.ids !== undefined && (!Array.isArray(input.ids) || !input.ids.every((id) => Number.isInteger(id) && id > 0) || input.ids.length > 500)) return bad("ids are at most 500 task ids.");
          if (input.limit !== undefined && (!Number.isInteger(input.limit) || (input.limit as number) < 1)) return bad("limit is a positive number.");
          const dryRun = input.dry_run !== false;
          const result = await this.store.retitle(await this.config(), user, { dryRun, ...(input.ids !== undefined && { ids: input.ids as number[] }), ...(input.limit !== undefined && { limit: input.limit as number }) });
          if (!dryRun) this.log(`${user} retitled ${result.changed.length} tasks`);
          return { json: { dry_run: dryRun, ...result } };
        }
        case "POST /api/config": {
          if (!this.isAdmin(user)) return bad("Only the hub's admins can change its rules.", 403);
          const input = await body();
          const config = (input.config ?? input) as SignalsConfig;
          const problems = configProblems(config);
          if (problems.length) return { status: 400, json: { error: "The config has problems.", problems } };
          await this.store.saveConfig(config, user);
          this.cached = undefined;
          return { json: { config } };
        }
        default:
          return bad(`No route ${request.method} ${request.path}.`, 404);
      }
    } catch (error) {
      const status = (error as { status?: number }).status;
      return bad((error as Error).message ?? String(error), status && status < 500 ? status : 500);
    }
  }

  /**
   * A person's poller setup: whether they have a Postgres role in the hub's
   * database (their job logs in as it to write the inbox), and the settings
   * their sources.json and job need. With `create`, a missing role is made
   * (store.createRole); when the hub can't, it says why and what someone with
   * Can Manage on the database project can run instead.
   */
  private async onboard(user: string, create: boolean): Promise<Onboarding> {
    const info = this.options.lakebase;
    const lakebase = info && { ...info, schema: this.store.schema };
    const folder = pollerFolder(user);
    const args = ["--config", `${folder}/sources.json`, "--lakebase"];
    if (await this.store.hasRole(user)) return { user, role: "ready", ...(lakebase && { lakebase }), folder, args };
    const branch = info?.endpoint.split("/").slice(0, 4).join("/");
    const command = branch && /^projects\/[^/]+\/branches\/[^/]+$/.test(branch) ? `databricks postgres create-role ${branch} --json '${JSON.stringify({ spec: { identity_type: "USER", postgres_role: user, auth_method: "LAKEBASE_OAUTH_V1" } })}'` : undefined;
    if (!create) return { user, role: "waiting", waiting: { reason: "You don't have a role in the hub's database yet.", ...(command && { command }) }, ...(lakebase && { lakebase }), folder, args };
    try {
      await this.store.createRole(user);
      this.log(`created a database role for ${user}`);
      return { user, role: "created", ...(lakebase && { lakebase }), folder, args };
    } catch (error) {
      const reason = `The hub couldn't create your role in its database: ${(error as Error).message}`;
      this.log(`couldn't create a database role for ${user}: ${(error as Error).message}`);
      return { user, role: "waiting", waiting: { reason, ...(command && { command }) }, ...(lakebase && { lakebase }), folder, args };
    }
  }

  private isAdmin(user: string) {
    const admins = (this.options.admins ?? []).map((admin) => admin.toLowerCase());
    return !admins.length || admins.includes(user);
  }

  private log(line: string) {
    this.options.log?.(line);
  }

  private async events(user: string, input: Record<string, unknown>): Promise<HubResponse> {
    const raw = Array.isArray(input.events) ? input.events : Array.isArray(input) ? input : [input];
    if (raw.length > MAX_EVENTS_PER_POST) return bad(`Send at most ${MAX_EVENTS_PER_POST} events at a time.`);
    const errors: { index: number; error: string }[] = [];
    const events = raw.flatMap((event, index) => {
      const checked = validateEvent(event);
      if (typeof checked === "string") {
        errors.push({ index, error: checked });
        return [];
      }
      return [checked];
    });
    const result = await this.store.ingest(user, events, await this.config(), this.options.classifier);
    await this.announce(result);
    return {
      json: {
        received: raw.length,
        new: result.new,
        changed: result.changed,
        same: result.same,
        skipped: result.skipped,
        filtered: result.filtered,
        firstRun: result.firstRun,
        created: result.created.map((task) => task.id),
        updated: [...new Set(result.updated.map((update) => update.task.id))],
        errors: [...errors, ...result.errors],
        // Events that failed to save or be placed (a write failed, not a bad event): post them again (the poller keeps its cursor; the inbox handles the post again).
        ...(result.errors.some((error) => error.retry) && { retry: true }),
      },
    };
  }

  /**
   * Posts new tasks to Buzz and their updates in the task's thread. Failures leave the task for `retry`. A meeting's
   * notes' move of its prep task (an update's `joined`) is marked reported once its update is posted, or needs none
   * (no thread to post in); when it can't be (a read or the post failed), it's left for the next sweep to report.
   */
  private async announce(result: IngestResult) {
    const joins = new Map(result.updated.flatMap((update) => (update.joined ? [[update.joined.claim, update.joined] as const] : [])));
    try {
      await this.announceAll(result, joins);
    } finally {
      if (joins.size) await this.store.releaseJoins([...joins.values()]).catch((error: Error) => this.log(`couldn't leave moves ${[...joins.values()].map((one) => one.event).join(", ")} for the sweep: ${error.message}`));
    }
  }

  /**
   * Done with these moves (see announce): their marks cleared, so no sweep reports them again. (A failure to clear
   * them is logged, not thrown, so the post's other updates still go out; the sweep may then report them again.)
   */
  private async reported(joins: Map<string, JoinClaim>, updates: IngestResult["updated"]) {
    const done = updates.flatMap((update) => (update.joined && joins.has(update.joined.claim) ? [update.joined] : []));
    if (!done.length) return;
    for (const one of done) joins.delete(one.claim);
    await this.store.reportedJoins(done).catch((error: Error) => this.log(`couldn't mark moves ${done.map((one) => one.event).join(", ")} reported: ${error.message}`));
  }

  private async announceAll(result: IngestResult, joins: Map<string, JoinClaim>) {
    if (!this.notifier) {
      await this.reported(joins, result.updated);
      return;
    }
    for (const task of result.created) await this.post(task);
    // A task never posted (a reply closed it before it was) that a customer message opened again: post it now.
    for (const id of new Set(result.updated.filter((update) => update.reopened && !update.task.buzz_root).map((update) => update.task.id))) {
      const task = await this.store.task(id);
      if (task) await this.post(task);
    }
    const seen = new Set<number>();
    for (const { task, reason } of result.finished) {
      if (!task.buzz_root || seen.has(task.id)) continue;
      seen.add(task.id);
      await this.notifier.updated(task, doneMessage(reason)).catch((error: Error) => this.log(`couldn't post that task ${task.id} is done: ${error.message}`));
    }
    // One notice per task, for its last closure in this post (the reply that answered the newest customer message),
    // taking off every agent any of its closures removed.
    const closures = new Map<number, Handled>();
    for (const done of result.handled) {
      const before = closures.get(done.task.id);
      closures.set(done.task.id, { ...done, agents: [...new Set([...(before?.agents ?? []), ...done.agents])] });
    }
    for (const { task, by, title, url, agents, owner } of closures.values()) {
      if (!task.buzz_root || seen.has(task.id)) continue;
      seen.add(task.id);
      // A newer customer message later in the same post opened it again: one message says both, and no "Done".
      const now = await this.store.task(task.id);
      // The customer message that opened it again (not a delayed older one in the same post).
      const later = now && isOpen(now.status) ? [...result.updated].reverse().find((update) => update.task.id === task.id && update.reopened) : undefined;
      const text = now && isOpen(now.status) ? handledThenReopened(by, title, url, agents, owner, later && { title: later.title && plainSlack(later.title), url: later.url }) : handledMessage(by, title, url, agents, owner);
      await this.notifier.updated(now ?? task, text, agents).catch((error: Error) => this.log(`couldn't post that task ${task.id} was handled: ${error.message}`));
    }
    // One notice per task: about the update that opened it again when one did (not an older, delayed message
    // earlier in the post), else its first; with the watched-field changes of all its updates in the post.
    const byTask = new Map<number, (typeof result.updated)[number][]>();
    for (const update of result.updated) byTask.set(update.task.id, [...(byTask.get(update.task.id) ?? []), update]);
    for (const updates of byTask.values()) {
      const update = [...updates].reverse().find((one) => one.reopened) ?? updates[0]!;
      if (!update.task.buzz_root || seen.has(update.task.id)) {
        // No thread yet (its post briefs the agents it has then), or its closure was posted: no handoff to post.
        // (Not posted yet: its versions were saved pending as they were attached, for its post's opening check, or after
        // it, the drain, to decide. Its closure posted: they aren't checked, as they weren't before.)
        if (update.task.buzz_root) {
          const versions = updates.flatMap((one) => (one.event ? [{ event: one.event.id, version: one.event.version }] : []));
          await this.store.dropChecks(update.task.id, versions).catch((error: Error) => this.log(`couldn't drop task ${update.task.id}'s default-actions checks: ${error.message}`));
        }
        await this.reported(joins, updates);
        continue;
      }
      seen.add(update.task.id);
      const what = whatOf(update);
      const changes = mergedChanges(updates.flatMap((one) => one.changes ?? []));
      // The agents are briefed on where the task ended up after the whole post: the last update's task (its rule)
      // and whether that rule still applies then, not a mismatch an earlier update in the post went through.
      const last = updates.at(-1)!;
      const outgrown = last.outgrown;
      let final = (await this.store.task(update.task.id)) ?? last.task;
      let text = `Update: ${what}`;
      // A meeting's notes changed: the follow-up's checklist as the new version has it.
      // (The last update of the post that changed it, when the task still has that: null says the notes list no items now.)
      const checklist = [...updates].reverse().find((one) => one.checklist !== undefined)?.checklist;
      const listed = checklist !== undefined && (final.checklist ?? null) === checklist ? (checklist ? `\n\n${checklist}` : "\n\nThe notes list no action items now, so the checklist is cleared.") : "";
      if (update.reopened) {
        // It was done: say it's open again and who has it, not just that something came in.
        const on = (await this.store.people([update.task.id])).get(update.task.id) ?? [];
        const people = on.filter((person) => person.kind === "person").map((person) => person.label ?? person.key);
        text = reopenedMessage(what, people, on.some((person) => person.kind === "agent"));
      }
      // Its workstream's default actions, checked against each event version the post attached, in the order they were
      // attached (after any another post attached first): one that holds now (and didn't) is told in the thread, waking the
      // agents, from the notice saved with the check (the sweep sends it again when this post fails). A check that found
      // none holding, that another post decides, or that's left pending after an error (the sweep's check decides), keeps
      // the post's changes quiet: they're shown, nobody's woken.
      const extra = [changes.map((change) => `- **${change.field}:** ${change.from} → ${change.to}`).join("\n"), listed.trim()].filter(Boolean).join("\n\n");
      const checked = await this.checkUpdates(final, updates, { ...(extra && { extra }), ...(update.reopened && { reopened: true as const }) }).catch(
        (error: Error) => (this.log(`couldn't check task ${final.id}'s default actions: ${error.message}`), { outcome: "failed" as const, task: final }),
      );
      final = checked.task;
      if (checked.outcome === "fired") {
        const joined = updates.find((one) => one.joined)?.joined;
        if (changes.length) await this.store.activity(final.id, "hub", "changed", changes.map(changeLine).join("; "), joined && `move:${joined.event}:${joined.at}`);
        this.posted(update.task.id, text + listed);
        await this.deliverNotices(final.id);
        // (Reported either way: the notice, saved, carries the update until it's sent.)
        await this.reported(joins, updates);
        continue;
      }
      if (changes.length) {
        // The changes go the usual way (the diff, the agents asked again, a `changed` activity), under this line,
        // and the checklist under them (notes that just came to their meeting's prep task, which may have been done).
        this.posted(update.task.id, text + listed);
        const sent = await this.changed(final, text, changes, outgrown, listed.trim(), updates.find((one) => one.joined)?.joined, checked.outcome === "quiet" || checked.outcome === "pending").then(
          () => true,
          (error: Error) => (this.log(`couldn't post a change to task ${update.task.id}: ${error.message}`), false),
        );
        if (sent) await this.reported(joins, updates);
        continue;
      }
      text += listed;
      if (update.reopened) {
        this.posted(update.task.id, text);
        const sent = await this.notifier.updated(final, text).then(
          () => true,
          (error: Error) => (this.log(`couldn't post that task ${update.task.id} is open again: ${error.message}`), false),
        );
        if (sent) await this.reported(joins, updates);
        continue;
      }
      // A source that saves an event again with nothing new to say (a calendar does, hourly) doesn't repeat the line.
      if (this.repeats(update.task.id, text)) {
        await this.reported(joins, updates);
        continue;
      }
      const sent = await this.notifier.updated(update.task, text).then(
        () => true,
        (error: Error) => (this.log(`couldn't post an update to task ${update.task.id}: ${error.message}`), false),
      );
      if (sent) await this.reported(joins, updates);
    }
  }

  /** The last update line each task's thread got, and when, so the same line isn't posted again soon after. */
  private readonly lastUpdates = new Map<number, Readonly<{ text: string; at: number }>>();

  private posted(task: number, text: string) {
    this.lastUpdates.delete(task);
    this.lastUpdates.set(task, { text, at: Date.now() });
    // The oldest go first; a task that's forgotten can repeat its line once.
    if (this.lastUpdates.size > 5000) this.lastUpdates.delete(this.lastUpdates.keys().next().value!);
  }

  /** Whether `text` is the line this task's thread got last, within REPEAT_MS; otherwise it's noted as posted. */
  private repeats(task: number, text: string): boolean {
    const last = this.lastUpdates.get(task);
    if (last?.text === text && Date.now() - last.at < REPEAT_MS) return true;
    this.posted(task, text);
    return false;
  }

  /**
   * Sends a task's undelivered trigger notices (see TriggerNotice) in its
   * thread, oldest first, each asking the agents to do what fired, once:
   * whoever claims one sends it (one at a time per task); a send that fails
   * leaves it, and the ones after it, for the sweep.
   */
  private async deliverNotices(id: number) {
    if (!this.notifier) return;
    for (let sent = 0; sent < 20; sent++) {
      const claimed = await this.store.claimNotice(id).catch((error: Error) => (this.log(`couldn't take task ${id}'s trigger notice: ${error.message}`), undefined));
      if (!claimed) return;
      const { task, notice, claim } = claimed;
      try {
        const account = task.account ? await this.store.account({ name: task.account }) : undefined;
        const agents = await this.triggerAgents(task, account, notice.fired);
        if (agents.length) await this.store.askAgain(task.id, agents);
        const labels = labelsOf(await this.config());
        // The event that fired them, as it was checked (older notices: the latest).
        const latest = agents.length && !notice.source ? await this.store.latestEvent(task.id) : undefined;
        const source = agents.length ? (notice.source ?? (latest && eventDetails(latest, account?.domains ?? [], labels, task))) : undefined;
        // (The Triggered lines right under the update's line, then its changes, as changedMessage puts them: the channel cards read that.)
        const head = `${notice.reopened ? "↩️ Open again" : "Update"}: ${notice.what}\n\n${triggeredLines(notice.fired)}${notice.extra ? `\n${notice.extra}` : ""}`;
        const brief = account && account.channel === task.channel ? briefing(account, labels, task) : undefined;
        await this.notifier.updated(task, triggeredMessage(task, head, agents, brief, source), agents);
        await this.store.doneNotice(claimed.id, claim);
      } catch (error) {
        this.log(`couldn't post task ${id}'s triggered actions: ${(error as Error).message}`);
        await this.store.failedNotice(claimed.id, claim).catch(() => {});
        return;
      }
    }
  }

  /**
   * A watched field changed: says what changed, and asks the task's agents to
   * go on with the playbook of the rule it's under now. Tasks in ask or off
   * mode, or no agent on, only get the line. `joined`: a meeting's notes just
   * moved its prep task to their rule (meeting_task), a handoff: the agents
   * asked are the ones the account names for where it is now (its rule or
   * workstream, as a new task's are), added to it, not the ones it had for its
   * old workstream; never one someone took off it. A task someone chose people
   * for (an owner or an agent assigned) keeps those: its agents are asked.
   * `quiet`: the update's default-actions check found nothing firing, so no
   * agent is asked. (`joined` is the move's claim: its `changed` activity is recorded once
   * for the move, however many posts of the handoff it takes and whatever
   * each one's changes say.)
   */
  private async changed(task: Task, update: string, changes: readonly FieldChange[], outgrown?: Readonly<{ rule: string; values: readonly { field: string; value: string }[] }>, checklist?: string, joined?: JoinClaim, quiet = false) {
    const people = (await this.store.people([task.id])).get(task.id) ?? [];
    // (quiet: its workstream's default actions were checked and none fired, so the change is shown and nobody's asked.)
    const working = (task.mode === "auto" || task.mode === "draft") && !quiet;
    let agents = working ? [...new Set(people.filter((person) => person.kind === "agent").map((person) => person.key))] : [];
    let added: string[] = [];
    const routing = joined && working && task.account && !people.some((person) => person.assigned_at) ? await this.store.account({ name: task.account }) : undefined;
    if (routing && routing.channel === task.channel) {
      const gone = (await this.store.removed([task.id])).get(task.id);
      agents = agentsFor(routing, task).filter((key) => !gone?.has(key));
      added = agents.filter((key) => !people.some((person) => person.kind === "agent" && person.key === key));
    }
    const account = agents.length && task.account ? (routing ?? (await this.store.account({ name: task.account }))) : undefined;
    const labels = labelsOf(await this.config());
    if (added.length) {
      await this.store.addPeople(task.id, added.map((key) => ({ kind: "agent", key })));
      await this.store.activity(task.id, "hub", "agents_asked", `Asked ${added.map((key) => `nostr:${npub(key)}`).join(", ")} to work on it (${task.workstream ?? task.rule_id} now)`);
    }
    if (agents.length) await this.store.askAgain(task.id, agents);
    // (A handoff's once: a retried post of it, its first having failed after this, doesn't record it again.)
    await this.store.activity(task.id, "hub", "changed", changes.map(changeLine).join("; "), joined && `move:${joined.event}:${joined.at}`);
    // A rule that no longer applies gives no playbook of its own: the workstream's, if any.
    const playbookTask = outgrown ? { rule_id: "", workstream: task.workstream } : task;
    const event = agents.length ? await this.store.latestEvent(task.id) : undefined;
    await this.notifier!.updated(task, changedMessage(task, update, changes, agents, account && briefing(account, labels, playbookTask), outgrown, event && eventDetails(event, account?.domains ?? [], labels, task), checklist), agents);
  }

  /**
   * Posts a task once: a call for a task already being posted leaves it to that post (without waiting on the
   * relay), and the task is read again first, so one posted (or closed) since isn't posted again.
   */
  private post(task: Task): Promise<void> {
    if (this.posting.has(task.id)) return Promise.resolve();
    const run = this.publish(task).finally(() => this.posting.delete(task.id));
    this.posting.set(task.id, run);
    return run;
  }

  private async publish(given: Task) {
    if (!this.notifier || !given.channel || given.buzz_root) return;
    const found = await this.store.task(given.id);
    // (A task its default actions dismissed as it opened is posted too, folded: the team sees it was tracked.)
    if (!found || !found.channel || found.buzz_root || !(isOpen(found.status) || quietlyDismissed(found))) return;
    // (Not before its first event is attached: the post again that attaches it posts it, checked against its default actions.)
    if (!(await this.store.attached(found.id))) return;
    try {
      const full = found.account ? await this.store.account({ name: found.account }) : undefined;
      // An event it read changed while it was checked: checked again as it is now (after OPENING_TRIES, the sweep's post does).
      let check: TriggerCheck = await this.checkOpening(found, full);
      for (let attempt = 1; attempt < OPENING_TRIES && check.kind === "stale"; attempt++) {
        const now = await this.store.task(found.id);
        if (!now || !now.channel || now.buzz_root || !(isOpen(now.status) || quietlyDismissed(now))) return;
        check = await this.checkOpening(now, full);
      }
      if (check.kind === "stale") return;
      const task = check.kind === "checked" ? check.task : found;
      // The account's agents are asked to work on it, unless the team said ask (they wait for a person) or off,
      // or its workstream's default actions found none of their triggers holding.
      const working = (task.mode === "auto" || task.mode === "draft") && isOpen(task.status) && !(check.kind === "checked" && !check.fired.length);
      const account = working ? full : undefined;
      const agents = account && account.channel === task.channel ? agentsFor(account, task) : [];
      // (Its source: the event that fired its first triggered action, else its latest.)
      const event = (check.kind === "checked" && check.source) || (await this.store.latestEvent(task.id));
      const labels = labelsOf(await this.config());
      const domains = full?.domains ?? [];
      const note = check.kind === "checked" ? openingNote(check) : undefined;
      const context: PostContext = { ...(agents.length && { briefing: briefing(account!, labels, task) }), ...(event && { source: eventDetails(event, domains, labels, task) }), ...(note && { note }) };
      const root = await this.notifier.opened(task, agents, context);
      if (root) await this.store.setBuzzRoot(task.id, root);
      if (root) this.postFailures.delete(task.channel!);
      if (root && agents.length) await this.store.addPeople(task.id, agents.map((key) => ({ kind: "agent", key })));
      // Versions that came while it was being posted: checked now, as updates.
      if (root) await this.drainTriggers(task.id).catch((error: Error) => this.log(`couldn't check task ${task.id}'s waiting default actions: ${error.message}`));
    } catch (error) {
      this.postFailures.set(found.channel, `Task ${found.id} couldn't be posted here: ${(error as Error).message}`);
      this.log(`couldn't post task ${found.id}: ${(error as Error).message}`);
    }
  }

  /**
   * Which of its row's actions hold for an event on a task: `always` ones
   * hold without the model; mode off asks no model and nothing holds.
   * Undefined when the model can't answer (no answer, or one that leaves an
   * action out): it fails open, with a `trigger` activity saying so.
   */
  private async askTriggers(task: Task, found: Readonly<{ key: string; row: WorkstreamActionsRow }>, event: EventInput, key: string): Promise<TriggerResult[] | undefined> {
    const asked = task.mode === "off" ? [] : found.row.watch.filter((action) => !action.always);
    let answer: Readonly<Record<string, Readonly<{ holds: boolean; why: string }>>> | undefined = {};
    if (asked.length) {
      const now = Math.floor(Date.now() / 1000);
      answer = this.options.triggerer ? await this.options.triggerer({ task: { title: task.title, workstream: task.workstream, opened_at: task.created_at, now }, event, actions: asked }).catch(() => undefined) : undefined;
    }
    // (An answer that leaves an action out, or doesn't say whether it holds, is no answer.)
    if (answer && asked.some((action) => typeof answer![action.id]?.holds !== "boolean")) answer = undefined;
    if (!answer) {
      const why = this.options.triggerer ? "the model gave no usable answer" : "the hub has no trigger model";
      await this.store.activity(task.id, "hub", "trigger", `Default actions for ${found.key} not checked (${why}), so it goes on as without them`, `failed:${key}`);
      return undefined;
    }
    return task.mode === "off" ? [] : found.row.watch.map((action) => (action.always ? { id: action.id, label: action.label, held: true, why: "always" } : { id: action.id, label: action.label, held: answer[action.id]!.holds, why: answer[action.id]!.why }));
  }

  /**
   * A new task's check against its workstream's default actions
   * (Account.workstream_actions), as it's posted: its first OPENING_EVENTS
   * events in the order they were attached (the one that opened it first),
   * so a batch's later update doesn't hide the event that opened it; any
   * after those stay pending, checked as updates once it's posted, in order. The first fires every action that holds, each later one those
   * that hold and didn't before; when none fired, its row's Otherwise applies
   * (dismiss marks it dismissed by them), and one that fired opens a task
   * their Otherwise dismissed again. Saved with each event's results, only
   * while every event it checked is still at the version it checked, taking
   * those versions off its pending checks (a newer one stays, checked as an
   * update once it's posted). `source`: the event that fired the first
   * action. `failed`: the model couldn't answer for one (it goes on as
   * without a row). `stale`: an event moved on, or it was posted meanwhile,
   * so nothing was saved. `none`: no row applies.
   */
  private async checkOpening(task: Task, account: AccountRecord | undefined): Promise<TriggerCheck> {
    const found = account && account.channel === task.channel ? actionsFor(account.workstream_actions, task) : undefined;
    if (!found) return { kind: "none" };
    const first = await this.store.triggersOf(task.id);
    const all = await this.store.taskEvents(task.id);
    if (!first || !all.length) return { kind: "none" };
    const events = all.slice(0, OPENING_EVENTS);
    const read = events.map((one) => ({ event: one.id, version: one.version }));
    const checks: { event: number; version: number; results: TriggerResult[]; subject: EventInput }[] = [];
    for (const one of events) {
      const results = await this.askTriggers(task, found, one.event, `${one.id}:${one.version}`);
      if (!results) {
        // (It goes on as without them: the versions it checked aren't checked again as updates.)
        await this.store.dropChecks(task.id, read);
        return { kind: "failed" };
      }
      checks.push({ event: one.id, version: one.version, results, subject: one.event });
    }
    const fired = new Map<string, TriggerResult>();
    let source: EventInput | undefined;
    let held: Record<string, boolean> = {};
    for (const check of checks) {
      for (const result of check.results)
        if (result.held && !held[result.id] && !fired.has(result.id)) {
          fired.set(result.id, result);
          source ??= check.subject;
        }
      held = Object.fromEntries(check.results.map((result) => [result.id, result.held]));
    }
    const last = checks.at(-1)!;
    let seen = first;
    for (let attempt = 0; attempt < 5; attempt++) {
      if (seen.task.buzz_root) return { kind: "stale" };
      const reopen = fired.size > 0 && quietlyDismissed(seen.task);
      const dismiss = !fired.size && found.row.otherwise === "dismiss" && isOpen(seen.task.status);
      const then = {
        ...(reopen && { reopen: `${[...fired.values()].map((result) => result.label).join(", ")} triggered` }),
        ...(dismiss && { dismiss: `Not triggered: ${clip(last.results.map((result) => `${result.label}${result.why ? ` (${result.why})` : ""}`).join("; ") || (task.mode === "off" ? "mode off" : "no actions ticked"), 900)}` }),
        also: checks.slice(0, -1).map(({ event, version, results }) => ({ event, version, results })),
        done: read,
      };
      const saved = await this.store.saveTriggers(task.id, { event: last.event, version: last.version, prior: seen.prior }, { held, event: last.event, version: last.version }, last.results, then);
      if (saved) return { kind: "checked", key: found.key, task: saved, fired: [...fired.values()], results: last.results, ...(source && { source }), ...(reopen && { reopened: true }) };
      // Not saved: another check saved first (save again over it), or an event it checked moved on (stale).
      const again = await this.store.triggersOf(task.id);
      if (!again || again.prior === seen.prior) return { kind: "stale" };
      seen = again;
    }
    return { kind: "stale" };
  }

  /**
   * An update's checks against its workstream's default actions: each event
   * version the post attached to the task was saved pending as it was
   * attached (see PendingCheck), ordered by its attachment. They're checked
   * and decided in that order (commitTriggers), so a check that finishes
   * first waits for the ones attached before it, whichever post has them.
   * `fired` when one of this post's fired and it decided it (its notice
   * carries the post's changes), else `failed` when one failed open, else
   * `quiet` (checked, decided by another post, or decided already), else
   * `none` (no row applies, or mode off). `pending`: a check it couldn't
   * finish (an error), left for the sweep at once, whose decision wakes the
   * agents or not, so the post stays quiet.
   */
  private async checkUpdates(task: Task, updates: IngestResult["updated"], notice: Readonly<{ extra?: string; reopened?: true }>): Promise<{ outcome: "none" | "failed" | "quiet" | "fired" | "pending"; task: Task }> {
    const account = task.account ? await this.store.account({ name: task.account }) : undefined;
    const found = account && account.channel === task.channel ? actionsFor(account.workstream_actions, task) : undefined;
    // (Mode off on an update: nothing to wake, and the last check's results stay for when the mode changes.)
    if (task.mode === "off" || !account || !found) {
      await this.store.dropChecks(task.id);
      return { outcome: "none", task };
    }
    const lines = new Map(updates.flatMap((one) => (one.event ? [[`${one.event.id}:${one.event.version}`, whatOf(one)] as const] : [])));
    const me = randomUUID();
    let outcome: "none" | "failed" | "quiet" | "fired" | "pending" = "quiet";
    let mine: PendingCheck[] = [];
    try {
      // (No version given, as for meeting notes a sweep finished: the ones waiting unchecked are this post's.)
      mine = (await this.store.pendingChecks(task.id)).filter((one) => !one.result && (lines.size ? lines.has(`${one.event}:${one.version}`) : true));
      for (const entry of mine) {
        if (!(await this.store.claimCheck(task.id, entry, -1))) continue;
        const what = lines.get(`${entry.event}:${entry.version}`) ?? whatOf(updates[0] ?? {});
        if ((await this.checkPending(task, found, account, entry, { owner: me, what, ...notice })) === "failed") outcome = "failed";
      }
      const decided = await this.commitTriggers(task.id, me);
      if (decided.some((one) => one.mine && one.fired)) outcome = "fired";
      // (Another post's that fired, decided here as this one waited on it: its notice goes now, before this post's line.)
      else if (decided.some((one) => one.fired)) await this.deliverNotices(task.id);
    } catch (error) {
      // (Still pending, for the sweep at once: its check decides whether the agents are woken, so this post's changes are quiet.)
      this.log(`couldn't check task ${task.id}'s default actions, left for the sweep: ${(error as Error).message}`);
      await this.store.releaseChecks(task.id, mine).catch(() => {});
      outcome = "pending";
    }
    return { outcome, task: (await this.store.task(task.id).catch(() => undefined)) ?? task };
  }

  /**
   * Checks a pending version, keeping the model's answer and its event's
   * details on it for commitTriggers (`meta`: the update's line and, for its
   * post, its changes). `stale` when its event moved on (the newer version is
   * pending too) and `failed` when the model couldn't answer, both taken off
   * the pending ones.
   */
  private async checkPending(
    task: Task,
    found: Readonly<{ key: string; row: WorkstreamActionsRow }>,
    account: AccountRecord,
    entry: PendingCheck,
    meta: Readonly<{ owner: string; what?: string; extra?: string; reopened?: true }>,
  ): Promise<"checked" | "stale" | "failed"> {
    const subject = await this.store.triggerSubject(task.id, entry.event);
    if (!subject || subject.id !== entry.event || subject.version !== entry.version) {
      await this.store.dropChecks(task.id, [entry]);
      return "stale";
    }
    const results = await this.askTriggers(task, found, subject.event, `${entry.event}:${entry.version}`);
    if (!results) {
      await this.store.dropChecks(task.id, [entry]);
      return "failed";
    }
    const source = eventDetails(subject.event, account.domains ?? [], labelsOf(await this.config()), task);
    await this.store.storeCheck(task.id, {
      event: entry.event,
      version: entry.version,
      results,
      what: meta.what ?? whatOf(subject.event),
      owner: meta.owner,
      ...(meta.extra && { extra: clip(meta.extra, 3000) }),
      ...(meta.reopened && { reopened: true as const }),
      source: clip(source, 6000),
    });
    return "checked";
  }

  /**
   * Decides a task's pending checks that are done, in the order they were
   * attached, stopping at the first one that isn't: each fires the actions
   * that hold and didn't at the check before it (edge-triggered), saved with
   * its notice (the line of the update that fired it, its event's details,
   * and the post's changes when `me` checked it, as that post shows them
   * otherwise) and, for a task their Otherwise dismissed, opening it again.
   * One whose event moved on or left the task is dropped. The ones decided,
   * with whether each fired and was `me`'s.
   */
  private async commitTriggers(id: number, me: string): Promise<{ event: number; version: number; fired: boolean; mine: boolean }[]> {
    const decided: { event: number; version: number; fired: boolean; mine: boolean }[] = [];
    let extraGiven = false;
    for (let attempt = 0; attempt < 100; attempt++) {
      const seen = await this.store.triggersOf(id);
      const [head] = seen ? await this.store.pendingChecks(id) : [];
      if (!seen || !head?.result) break;
      const state = readTriggerState(seen.prior) ?? { held: {} };
      const { results, source, what, owner } = head.result;
      const { event, version } = head;
      const fired = results.filter((result) => result.held && !state.held[result.id]);
      const reopen = fired.length > 0 && quietlyDismissed(seen.task);
      const mine = Boolean(me) && owner === me;
      const extra = mine && !extraGiven ? head.result.extra : undefined;
      const notice: TriggerNotice | undefined = fired.length
        ? { fired, what, ...(extra && { extra }), ...((reopen || (mine && head.result.reopened)) && { reopened: true as const }), ...(source && { source }) }
        : undefined;
      // (`seq`: the attachment decided, so two decisions never save the same state.)
      const next: TriggerState = { held: Object.fromEntries(results.map((result) => [result.id, result.held])), event, version, seq: head.seq };
      const then = { ...(reopen && { reopen: `${fired.map((result) => result.label).join(", ")} triggered` }), ...(notice && { notice }), done: [{ event, version }] };
      if (await this.store.saveTriggers(id, { event, version, pending: true, prior: seen.prior }, next, results, then)) {
        if (notice?.extra) extraGiven = true;
        decided.push({ event, version, fired: fired.length > 0, mine });
        continue;
      }
      // Not saved: another check saved first (read again), or its event moved on or left the task (dropped: a newer version is pending too).
      const again = await this.store.triggersOf(id);
      if (again && again.prior === seen.prior) await this.store.dropChecks(id, [{ event, version }]);
    }
    return decided;
  }

  /**
   * A posted task's pending checks: the ones not checked yet checked (with
   * `lease`, only those no post took within that many seconds, so one a post
   * is still checking isn't repeated; negative, all of them), the done ones
   * decided, and their notices sent. A task no row applies to now has them
   * dropped.
   */
  private async drainTriggers(id: number, lease = -1) {
    const task = await this.store.task(id);
    if (!task?.buzz_root) return;
    const pending = await this.store.pendingChecks(id);
    if (!pending.length) return;
    const account = task.account ? await this.store.account({ name: task.account }) : undefined;
    const found = account && account.channel === task.channel && task.mode !== "off" ? actionsFor(account.workstream_actions, task) : undefined;
    if (!account || !found) {
      await this.store.dropChecks(id);
      return;
    }
    for (const entry of pending) if (!entry.result && (await this.store.claimCheck(id, entry, lease))) await this.checkPending(task, found, account, entry, { owner: "" });
    await this.commitTriggers(id, "");
    await this.deliverNotices(id);
  }

  /**
   * The agents a trigger notice asks (none in ask or off mode, or on a task
   * that isn't open): the task's own, or the ones the account names for it
   * when none is on it (a task the actions dismissed as it opened has none),
   * never one someone took off it.
   */
  private async triggerAgents(task: Task, account: AccountRecord | undefined, fired: readonly TriggerResult[]): Promise<string[]> {
    if (!(task.mode === "auto" || task.mode === "draft") || !isOpen(task.status)) return [];
    const people = (await this.store.people([task.id])).get(task.id) ?? [];
    const agents = [...new Set(people.filter((person) => person.kind === "agent").map((person) => person.key))];
    if (agents.length || !account || account.channel !== task.channel) return agents;
    const gone = (await this.store.removed([task.id])).get(task.id);
    const named = agentsFor(account, task).filter((key) => !gone?.has(key));
    if (named.length) {
      await this.store.addPeople(task.id, named.map((key) => ({ kind: "agent", key })));
      await this.store.activity(task.id, "hub", "agents_asked", `Asked ${named.map((key) => `nostr:${npub(key)}`).join(", ")} to work on it (${fired.map((result) => result.label).join(", ")} triggered)`);
    }
    return named;
  }

  /** Why tasks can't be posted in a channel: the notifier's check, else the last failed post there. */
  async postProblem(channel: string | null | undefined): Promise<string | undefined> {
    if (!channel) return undefined;
    if (!this.notifier) return "The hub has no Buzz identity, so it can't post tasks. Give it one (see the README).";
    const problem = await this.notifier.canPost?.(channel).catch(() => undefined);
    // It can post there now: the sweep posts what failed before.
    if (problem === null) return undefined;
    // A post that failed says exactly why; the notifier's check may only be a guess.
    return this.postFailures.get(channel) ?? problem;
  }

  /**
   * Sets up or changes an account channel. Anyone who can use the hub may:
   * it's the team's own channel, and every change records who made it.
   */
  private async saveAccount(user: string, input: Record<string, unknown>): Promise<HubResponse> {
    const name = typeof input.name === "string" ? input.name.trim() : "";
    if (!name || name.length > 200) return bad("Send {name} (1-200 characters).");
    if (input.delete === true) {
      if (!(await this.store.deleteAccount(name))) return bad("No such account.", 404);
      this.cached = undefined;
      this.log(`${user} deleted the account ${name}`);
      return { json: { deleted: true } };
    }
    const list = (key: string, max: number) => {
      const value = input[key];
      if (value === undefined) return undefined;
      const items = (Array.isArray(value) ? value : typeof value === "string" ? value.split(/[,\n]/) : undefined)?.map((item) => String(item).trim()).filter(Boolean);
      if (!items) throw Object.assign(new Error(`${key} is a list of names.`), { status: 400 });
      return [...new Set(items)].slice(0, max);
    };
    const text = (key: string, max: number) => {
      const value = input[key];
      if (value === undefined) return undefined;
      if (typeof value !== "string") throw Object.assign(new Error(`${key} must be text.`), { status: 400 });
      if (value.length > max) throw Object.assign(new Error(`${key} is at most ${max} characters.`), { status: 400 });
      return value;
    };
    const domains = list("domains", 20)?.map((domain) => domain.toLowerCase().replace(/^@/, ""));
    const wrong = domains?.find((domain) => !validDomain(domain));
    if (wrong) return bad(`${wrong} isn't an email domain (like example.com).`);
    if (input.channel !== undefined && input.channel !== null && (typeof input.channel !== "string" || !/^[\w-]{1,100}$/.test(input.channel))) return bad("channel is a Buzz channel id.");
    if (input.rename !== undefined && (typeof input.rename !== "string" || !input.rename.trim() || input.rename.length > 200)) return bad("rename is the account's new name (1-200 characters).");
    const aliases = list("aliases", 20);
    const ids = input.ids === undefined ? undefined : readIds(input.ids);
    if (typeof ids === "string") return bad(ids);
    const agents = list("agents", 10)?.map(agentKey);
    const notAgent = agents?.find((key) => !key);
    if (notAgent !== undefined) return bad("agents are Buzz pubkeys (64 hex characters or an npub).");
    let workstreamAgents: Record<string, string[]> | undefined;
    if (input.workstream_agents !== undefined) {
      const given = input.workstream_agents;
      if (!given || typeof given !== "object" || Array.isArray(given)) return bad("workstream_agents maps a workstream (or rule id) to the agents that work on its tasks.");
      workstreamAgents = {};
      for (const [key, value] of Object.entries(given as Record<string, unknown>)) {
        const name = key.trim();
        if (!name || name.length > 80) return bad("A workstream is 1-80 characters.");
        const items = Array.isArray(value) ? value.map(String) : typeof value === "string" ? value.split(/[,\s]+/) : undefined;
        if (!items) return bad(`The ${name} agents are a list of Buzz pubkeys.`);
        const keys = [...new Set(items.map((item) => item.trim()).filter(Boolean).map(agentKey))];
        if (keys.some((item) => !item)) return bad(`The ${name} agents are Buzz pubkeys (64 hex characters or an npub).`);
        if (keys.length > 10) return bad(`A workstream has at most 10 agents.`);
        if (Object.keys(workstreamAgents).some((other) => other.toLowerCase() === name.toLowerCase())) return bad(`${name} is named twice.`);
        // No agents is the same as none: its tasks go to the account's agents.
        if (keys.length) workstreamAgents[name] = keys;
      }
      if (Object.keys(workstreamAgents).length > MAX_PLAYBOOKS) return bad(`An account names agents for at most ${MAX_PLAYBOOKS} workstreams.`);
    }
    let workstreamActions: WorkstreamActions | undefined;
    if (input.workstream_actions !== undefined) {
      const read = readWorkstreamActions(input.workstream_actions);
      if (typeof read === "string") return bad(read);
      workstreamActions = read;
    }
    // The account as it was, to find the agents the save adds (none when it doesn't change who works on what).
    const before = agents || workstreamAgents ? await this.store.account({ name }) : undefined;
    const preferences = text("preferences", 8000);
    const profile = text("profile", 16000);
    let playbooks: Record<string, string> | undefined;
    if (input.playbooks !== undefined) {
      const given = input.playbooks;
      if (!given || typeof given !== "object" || Array.isArray(given)) return bad("playbooks maps a workstream (or rule id) to how the team likes that work done.");
      playbooks = {};
      for (const [key, value] of Object.entries(given as Record<string, unknown>)) {
        const name = key.trim();
        if (!name || name.length > 80) return bad("A playbook's workstream is 1-80 characters.");
        if (typeof value !== "string") return bad(`The ${name} playbook must be text.`);
        if (value.length > MAX_PLAYBOOK) return bad(`The ${name} playbook is at most ${MAX_PLAYBOOK} characters.`);
        if (Object.keys(playbooks).some((other) => other.toLowerCase() === name.toLowerCase())) return bad(`There are two playbooks for ${name}.`);
        // An empty playbook is the same as none.
        if (value.trim()) playbooks[name] = value;
      }
      if (Object.keys(playbooks).length > MAX_PLAYBOOKS) return bad(`An account keeps at most ${MAX_PLAYBOOKS} playbooks.`);
    }
    const account = await this.store.saveAccount(
      name,
      {
        ...(typeof input.rename === "string" && { rename: input.rename }),
        ...(input.channel !== undefined && { channel: (input.channel as string | null) || null }),
        ...(aliases && { aliases }),
        ...(domains && { domains }),
        ...(ids && { ids }),
        ...(agents && { agents: agents as string[] }),
        ...(preferences !== undefined && { preferences }),
        ...(profile !== undefined && { profile }),
        ...(playbooks && { playbooks }),
        ...(workstreamAgents && { workstream_agents: workstreamAgents }),
        ...(workstreamActions && { workstream_actions: workstreamActions }),
      },
      user,
    );
    this.cached = undefined;
    this.log(`${user} saved the account ${account.name}`);
    const woken = agents || workstreamAgents ? await this.handOff(account, before ?? { agents: [], workstream_agents: {} }) : [];
    const config = await this.config();
    const warning = await this.postProblem(account.channel);
    return { json: { account: withRead(account), labels: labelsOf(config), workstreams: workstreamsOf(config), ...(woken.length && { woken }), ...(warning && { warning }) } };
  }

  /**
   * Asks agents just added to an account to work on its open tasks that no
   * agent has worked yet (posted in its channel, auto or draft): a reply in
   * each task's thread, mentioning them, with the account's briefing. Their
   * first reply is recorded as for a new task (see collect).
   */
  private async handOff(account: AccountRecord, before: Pick<AccountRecord, "agents" | "workstream_agents">): Promise<number[]> {
    if (!this.notifier || !account.channel) return [];
    // Each task's new agents: the ones for its workstream now that weren't before.
    const addedFor = (task: Task) => {
      const was = new Set(agentsFor(before, task));
      return agentsFor(account, task).filter((key) => !was.has(key));
    };
    // A workstream whose own agents were cleared falls back to the account's. That hands over only tasks no agent is on yet:
    // the agents already asked, and not taken off, keep them.
    const fellBack = (task: Task) => agentListFor(before, task).key !== undefined && agentListFor(account, task).key === undefined;
    const lower = account.name.toLowerCase();
    const tasks = (await this.store.untouched(HAND_OFF_DAYS, undefined, HAND_OFF_MAX)).filter((task) => task.account?.toLowerCase() === lower && task.channel === account.channel);
    const woken: number[] = [];
    const labels = labelsOf(await this.config());
    const ids = tasks.map((task) => task.id);
    const [gone, people] = await Promise.all([this.store.removed(ids), this.store.people(ids)]);
    for (const task of tasks) {
      // Not agents someone took off it, and not tasks someone gave owners: a person chose who has those.
      const on = people.get(task.id) ?? [];
      // Not agents already on it, either: they were asked before.
      const asked = addedFor(task).filter((key) => !gone.get(task.id)?.has(key) && !on.some((person) => person.kind === "agent" && person.key === key));
      if (!asked.length || on.some((person) => person.assigned_at)) continue;
      if (fellBack(task) && on.some((person) => person.kind === "agent")) continue;
      try {
        const event = await this.store.latestEvent(task.id);
        const why = handOffReason(agentListFor(account, task).key, fellBack(task));
        await this.notifier.updated(task, handOffMessage(task, asked, briefing(account, labels, task), event && eventDetails(event, account.domains, labels, task), why), asked);
        await this.store.addPeople(task.id, asked.map((key) => ({ kind: "agent", key })));
        await this.store.activity(task.id, "hub", "agents_asked", `Asked ${asked.map((key) => `nostr:${npub(key)}`).join(", ")} to work on it (added to ${account.name})`);
        woken.push(task.id);
      } catch (error) {
        this.log(`couldn't ask agents to work on task ${task.id}: ${(error as Error).message}`);
      }
    }
    if (woken.length) this.log(`asked new agents of ${account.name} to work on tasks ${woken.join(", ")}`);
    return woken;
  }

  private async updateTask(user: string, input: Record<string, unknown>): Promise<HubResponse> {
    const id = Number(input.id);
    let task = await this.store.task(id);
    if (!task) return bad("No such task.", 404);
    for (const key of ["workstream", "initiative"] as const)
      if (input[key] !== undefined && (typeof input[key] !== "string" || (input[key] as string).length > 200)) return bad(`${key} is a name (at most 200 characters), or "" to clear it.`);
    if (input.workstream !== undefined || input.initiative !== undefined)
      task = (await this.store.file(id, user, { ...(input.workstream !== undefined && { workstream: input.workstream as string }), ...(input.initiative !== undefined && { initiative: input.initiative as string }) }))!;
    const note = typeof input.note === "string" && input.note.trim() ? input.note.trim() : undefined;
    // A fan-out candidate's verdict (see Rule.fan_out), with the note as its reason.
    if (input.verdict !== undefined) {
      if (!VERDICTS.includes(input.verdict as Verdict)) return bad(`verdict must be one of ${VERDICTS.join(", ")}`);
      if (!(await this.config()).rules.find((rule) => rule.id === task!.rule_id)?.fan_out) return bad("Only a candidate a fan_out rule opened has a verdict.", 409);
      task = (await this.store.setVerdict(id, input.verdict as Verdict, user, note))!;
      if (this.notifier && task.buzz_root) await this.notifier.updated(task, `${user} judged this **${input.verdict}**${note ? `: ${note}` : ""}`).catch(() => {});
    }
    if (input.status !== undefined) {
      if (!TASK_STATUSES.includes(input.status as TaskStatus)) return bad(`status must be one of ${TASK_STATUSES.join(", ")}`);
      task = (await this.store.setStatus(id, input.status as TaskStatus, user, note))!;
      // Moving it on from waiting by hand takes its question off.
      if (task.question && input.status !== "waiting" && input.question === undefined) {
        const asking = task.series && task.asked_by === SERIES_ASKER ? task.series : undefined;
        task = (await this.store.setQuestion(id, user))!;
        // A series' question taken off by hand decides nothing: its held events go on, and its next new one asks again.
        if (asking) {
          await this.store.answerSeries(asking, null, user);
          for (const opened of await this.store.releaseHeld(asking, await this.config())) await this.post(opened);
        }
      }
    } else if (note && input.verdict === undefined && input.agents === undefined && input.assign === undefined && input.unassign === undefined) await this.store.activity(id, user, "note", note);
    if (input.agents !== undefined) {
      const keys = Array.isArray(input.agents) ? [...new Set(input.agents.map((item) => agentKey(String(item))))] : [];
      if (!keys.length || keys.some((key) => !key) || keys.length > 10) return bad("agents is a list of up to 10 Buzz pubkeys (hex or npub).");
      if (!this.notifier || !task.buzz_root) return bad("The task isn't posted in Buzz yet, so there's no thread to ask agents in.", 409);
      const account = task.account ? await this.store.account({ name: task.account }) : undefined;
      const event = await this.store.latestEvent(id);
      const labels = labelsOf(await this.config());
      await this.notifier.updated(task, askMessage(task, keys, user, note, account && briefing(account, labels, task), event && eventDetails(event, account?.domains ?? [], labels, task)), keys);
      // Asking an agent taken off it puts it back.
      for (const key of keys) await this.store.assign(id, "agent", key, false);
      await this.store.activity(id, user, "agents_asked", `Asked ${keys.map((key) => `nostr:${npub(key)}`).join(", ")} to work on it${note ? `: ${note}` : ""}`);
    }
    if (input.assign !== undefined || input.unassign !== undefined) {
      const assign = input.assign === undefined ? [] : readOwners(input.assign);
      const unassign = input.unassign === undefined ? [] : readOwners(input.unassign);
      if (typeof assign === "string" || typeof unassign === "string") return bad(`assign and unassign are lists of up to 10 owners: ${(typeof assign === "string" ? assign : unassign) as string}`);
      if (!assign.length && !unassign.length) return bad("Send who to assign or unassign.");
      if (assign.some((owner) => owner.kind === "agent") && (!this.notifier || !task.buzz_root)) return bad("The task isn't posted in Buzz yet, so there's no thread to ask an agent in.", 409);
      task = await this.setOwners(task, user, assign, unassign, note);
    }
    if (input.question !== undefined) {
      const ask = readQuestion(input.question, input.options);
      if (typeof ask === "string") return bad(ask);
      task = (await this.store.setQuestion(id, user, { ...ask, by: user }))!;
      if (this.notifier && task.buzz_root) await this.notifier.updated(task, questionMessage(task, user)).catch(() => {});
    }
    if (input.input !== undefined) {
      if (typeof input.input !== "string" || !input.input.trim() || input.input.length > 4000) return bad("input is the answer (text, at most 4000 characters).");
      if (!task.question) return bad("The task isn't waiting on input.", 409);
      task = await this.answer(task, user, input.input.trim());
    }
    const artifact = input.artifact as { url?: unknown; title?: unknown; kind?: unknown } | undefined;
    if (artifact) {
      if (typeof artifact.url !== "string" || !/^https?:\/\//.test(artifact.url)) return bad("artifact.url must be an http(s) link.");
      await this.store.artifact(id, user, typeof artifact.kind === "string" ? artifact.kind : linkKind(artifact.url), artifact.url, typeof artifact.title === "string" ? artifact.title : undefined);
    }
    if (this.notifier && task.buzz_root && (input.status !== undefined || artifact)) {
      const parts = [input.status !== undefined && `${user} set this to **${input.status}**${note ? `: ${note}` : ""}`, artifact && `${user} added [${(artifact.title as string) ?? artifact.url}](${artifact.url as string})`].filter(Boolean);
      await this.notifier.updated(task, parts.join("\n")).catch(() => {});
    }
    return { json: await this.store.detail(id) };
  }

  /**
   * Sets a task's owners: takes `unassign` off it, then puts `assign` on it as
   * its owners, so a reassignment is one call. One message in its thread says
   * what changed. An agent assigned is mentioned and asked to work on it, with
   * the account's briefing, and the hub records its next reply. A person
   * assigned is mentioned (by pubkey) and no agent wakes. An agent taken off
   * is told to stop, and from then on it isn't mentioned by changes or
   * answers, isn't waited on, and saving the account's agents doesn't put it
   * back: only assigning it again does.
   */
  private async setOwners(task: Task, user: string, assign: readonly Owner[], unassign: readonly Owner[], note?: string): Promise<Task> {
    const adding = new Set(assign.map((owner) => owner.key));
    const off: Owner[] = [];
    for (const owner of unassign) {
      if (adding.has(owner.key)) continue;
      const kind = await this.store.unassign(task.id, owner.key, owner.kind);
      if (kind) off.push({ kind, key: owner.key });
    }
    const people = (await this.store.people([task.id])).get(task.id) ?? [];
    const on = assign.filter((owner) => !people.some((person) => person.key === owner.key && person.assigned_at));
    for (const owner of on) await this.store.assign(task.id, owner.kind, owner.key, true);
    if (!off.length && !on.length) return task;
    const said = (owner: Owner) => (owner.kind === "agent" || HEX64.test(owner.key) ? `nostr:${npub(owner.key)}` : owner.key);
    if (off.length) await this.store.activity(task.id, user, "unassigned", `Took ${off.map(said).join(", ")} off it`);
    if (on.length) await this.store.activity(task.id, user, "assigned", `Assigned ${on.map(said).join(", ")}${note ? `: ${note}` : ""}`);
    const updated = (await this.store.task(task.id))!;
    if (this.notifier && task.buzz_root) {
      const agents = on.some((owner) => owner.kind === "agent");
      const account = agents && task.account ? await this.store.account({ name: task.account }) : undefined;
      const labels = labelsOf(await this.config());
      const event = agents ? await this.store.latestEvent(task.id) : undefined;
      const text = ownersMessage(updated, user, on, off, note, account && briefing(account, labels, updated), event && eventDetails(event, account?.domains ?? [], labels, updated));
      const mentions = [...new Set([...on, ...off.filter((owner) => owner.kind === "agent")].map((owner) => owner.key).filter((key) => HEX64.test(key)))];
      await this.notifier.updated(updated, text, mentions).catch((error) => this.log(`couldn't post the owners of task ${task.id}: ${(error as Error).message}`));
    }
    return updated;
  }

  /**
   * Answers a task's question: posts the answer in its thread, mentioning its
   * agents (the one that asked first), takes the question off, moves it back to
   * in_progress, and asks the agents again, so each one's next reply is
   * recorded as their first was (see collect).
   */
  private async answer(task: Task, user: string, text: string): Promise<Task> {
    if (task.series && task.asked_by === SERIES_ASKER) return this.answerSeries(task, user, text);
    const people = (await this.store.people([task.id])).get(task.id) ?? [];
    // An agent that asked and was taken off since isn't asked to go on.
    const gone = (await this.store.removed([task.id])).get(task.id);
    const asker = task.asked_by && HEX64.test(task.asked_by) && !gone?.has(task.asked_by) ? [task.asked_by] : [];
    const agents = [...new Set([...asker, ...people.filter((person) => person.kind === "agent").map((person) => person.key)])];
    await this.store.activity(task.id, user, "input", text);
    await this.store.setQuestion(task.id, user);
    const resumed = (await this.store.setStatus(task.id, "in_progress", user, "input given"))!;
    if (agents.length) await this.store.askAgain(task.id, agents);
    if (this.notifier && task.buzz_root) await this.notifier.updated(resumed, answerMessage(task, user, text, agents), agents).catch((error) => this.log(`couldn't post input on task ${task.id}: ${(error as Error).message}`));
    return resumed;
  }

  /**
   * Brings a task's first message up to date (its mode, its question) after
   * it changed, by editing it. It mentions nobody: agents were already asked
   * in the thread. Its source details stay as the post had them.
   */
  private async refresh(task: Task, note?: string) {
    if (!this.notifier?.edited || !task.channel || !task.buzz_root) return;
    try {
      const event = await this.store.latestEvent(task.id);
      const account = task.account ? await this.store.account({ name: task.account }) : undefined;
      const labels = labelsOf(await this.config());
      const text = taskMessage(task, event ? { source: eventDetails(event, account?.domains ?? [], labels, task) } : {});
      await this.notifier.edited(task, note ? `${text}\n${note}` : text);
    } catch (error) {
      this.log(`couldn't update task ${task.id}'s first message: ${(error as Error).message}`);
    }
  }

  /**
   * Answers a new recurring series' question (see Rule.series). Always:
   * the series' tasks open from now on, in the team's mode. Just this one:
   * this task goes ahead, and the series' next event asks again. Never: this
   * task is dismissed and the series opens no more. Unless it's never, the
   * task takes the team's mode and its account's agents are asked to start
   * (in auto and draft). The events held while it asked then go through the
   * rules again. An answer that
   * isn't one of the choices goes to the agents as input, and the series
   * asks again.
   */
  private async answerSeries(task: Task, user: string, text: string): Promise<Task> {
    const choice = seriesAnswer(text);
    const series = task.series!;
    const kept = await this.store.seriesFor(series);
    await this.store.activity(task.id, user, "input", text);
    await this.store.setQuestion(task.id, user);
    await this.store.answerSeries(series, choice ?? null, user);
    let resumed: Task;
    if (choice === "never") {
      resumed = (await this.store.setStatus(task.id, "dismissed", user, "never for this series"))!;
      if (this.notifier && task.buzz_root) await this.notifier.updated(resumed, `${user} answered: **Never**. No tasks open for this series from now on.`).catch(() => {});
    } else {
      const mode = kept?.mode ?? "draft";
      await this.store.setMode(task.id, mode);
      resumed = (await this.store.setStatus(task.id, "open", user, choice === "always" ? "always for this series" : choice === "once" ? "just this one" : "input given"))!;
      const account = resumed.account ? await this.store.account({ name: resumed.account }) : undefined;
      const gone = (await this.store.removed([task.id])).get(task.id);
      const agents = account && account.channel === resumed.channel && (mode === "auto" || mode === "draft") ? agentsFor(account, resumed).filter((key) => !gone?.has(key)) : [];
      const said = choice === "always" ? "**Always**. Tasks open for this series from now on." : choice === "once" ? "**Just this one**. The series' next event asks again." : `${text} (the series' next event asks again)`;
      if (this.notifier && resumed.buzz_root) {
        const labels = labelsOf(await this.config());
        const event = await this.store.latestEvent(task.id);
        const ask = agents.length ? `\n\n${askMessage(resumed, agents, user, choice ? undefined : text, account && briefing(account, labels, resumed), event && eventDetails(event, account?.domains ?? [], labels, resumed))}` : "";
        await this.notifier.updated(resumed, `${user} answered: ${said}${ask}`, agents).catch((error) => this.log(`couldn't post the series answer on task ${task.id}: ${(error as Error).message}`));
      }
      if (agents.length) {
        await this.store.addPeople(task.id, agents.map((key) => ({ kind: "agent", key })));
        await this.store.askAgain(task.id, agents);
      }
    }
    await this.refresh(resumed, choice === "never" ? "🚫 Dismissed: no tasks open for this series." : undefined);
    for (const opened of await this.store.releaseHeld(series, await this.config())) await this.post(opened);
    return resumed;
  }

  /**
   * A channel's tasks for the board, newest activity first: every open one
   * and those closed in the last two weeks, each with who's on it (see
   * `whoIsOn`), its source, its artifacts and its latest activity.
   */
  async board(channel: string): Promise<{ account: string | null; labels: ResolvedLabels; tasks: BoardTask[] }> {
    const tasks = await this.store.boardTasks(channel);
    const ids = tasks.map((task) => task.id);
    const [people, extras, actors] = await Promise.all([this.store.people(ids), this.store.extras(ids), this.store.actors(ids)]);
    const account = await this.store.account({ channel });
    const config = await this.config();
    const labels = labelsOf(config);
    const rules = new Map(config.rules.map((rule) => [rule.id, rule]));
    const domains = new Map<string, readonly string[]>();
    const domainsOf = async (name: string | null) => {
      if (!name) return account?.domains ?? [];
      if (!domains.has(name)) domains.set(name, (await this.store.account({ name }))?.domains ?? []);
      return domains.get(name)!;
    };
    const out: BoardTask[] = [];
    for (const task of tasks) {
      const extra = extras.get(task.id) ?? { artifacts: [] };
      out.push({
        task,
        people: whoIsOn(people.get(task.id) ?? [], actors.get(task.id) ?? [], extra.event, await domainsOf(task.account), labels, rules.get(task.rule_id)),
        ...(extra.event && { source: { source: extra.event.source, ...(extra.event.title && { title: plainSlack(extra.event.title) }), ...(extra.event.url && { url: extra.event.url }), occurred_at: Number(extra.event.occurred_at ?? 0) } }),
        ...(extra.origin && { origin: { source: extra.origin.source, external_id: extra.origin.external_id, ...(extra.origin.title && { title: plainSlack(extra.origin.title) }), ...(extra.origin.url && { url: extra.origin.url }) } }),
        artifacts: extra.artifacts.slice(0, 10),
        ...(extra.activity && { activity: extra.activity }),
        ...(task.buzz_root && { thread: `buzz://message?channel=${task.channel}&id=${task.buzz_root}` }),
      });
    }
    return { account: account?.name ?? null, labels, tasks: out };
  }

  /**
   * Handles what poller jobs wrote to the inbox, in order, exactly as if they
   * had posted it to /api/events or /api/cursor: the owner is the Postgres
   * role that wrote the row. Run every half minute or so.
   */
  async drain(limit = 20): Promise<{ handled: number; failed: number }> {
    let handled = 0;
    let failed = 0;
    // An owner's source with a post to be handled again: their later posts of it (its cursor, above all) wait for it.
    const waiting = new Set<string>();
    const at = Math.floor(Date.now() / 1000);
    // `limit` posts handled (or tried): the posts waiting behind a held one don't count, and the pages after them are read,
    // so one held source doesn't hold up the others (its own posts still wait, in order).
    let tried = 0;
    let after = 0;
    const page = Math.max(limit, 200);
    for (;;) {
      const posts = await this.store.inbox(page, after);
      if (!posts.length) break;
      for (const post of posts) {
        if (tried >= limit) break;
        after = post.id;
        const keys = inboxSources(post.body).map((source) => `${post.owner}\n${source}`);
        // (A post whose sources aren't known, "*", waits for and holds up all its owner's posts.)
        if (keys.some((key) => waiting.has(key) || waiting.has(`${post.owner}\n*`)) || (keys.some((key) => key.endsWith("\n*")) && [...waiting].some((key) => key.startsWith(`${post.owner}\n`)))) continue;
        // Held (past INBOX_TRIES): tried again only every INBOX_HOLD_SECONDS, its source's later posts still waiting.
        if (post.tries >= INBOX_TRIES && post.tried_at !== null && at - post.tried_at < INBOX_HOLD_SECONDS) {
          failed++;
          for (const key of keys) waiting.add(key);
          continue;
        }
        tried++;
        const reply = await this.handle({ method: "POST", path: post.kind === "events" ? "/api/events" : "/api/cursor", query: new URLSearchParams(), user: post.owner, body: async () => JSON.stringify(post.body) });
        const status = reply.status ?? 200;
        // Events that failed to save: never done (so never lost), its source's cursor waiting behind it.
        if (status < 400 && (reply.json as { retry?: boolean }).retry) {
          failed++;
          for (const key of keys) waiting.add(key);
          const tries = await this.store.inboxRetry(post.id, { status, ...(reply.json as object) }, at);
          const error = (reply.json as { errors?: { error: string; retry?: boolean }[] }).errors?.find((one) => one.retry)?.error ?? "a write failed";
          if (tries >= INBOX_TRIES) {
            // Reported on the person's source (Settings shows it) and the log; tried again every so often, so it's saved once the write works.
            const message = `Events failed to save ${tries} times (${error}); held, and tried again every ${INBOX_HOLD_SECONDS / 60} minutes. The source's cursor waits for them.`;
            for (const source of inboxSources(post.body)) await this.store.sourceError(post.owner, source, message).catch(() => {});
            this.log(`inbox ${post.id} from ${post.owner} held: ${message}`);
          } else this.log(`inbox ${post.id} from ${post.owner}: events failed to save (${error}), to be handled again`);
          continue;
        }
        if (status >= 400) {
          failed++;
          this.log(`inbox ${post.id} from ${post.owner} failed: ${(reply.json as { error?: string }).error ?? status}`);
        } else handled++;
        await this.store.inboxDone(post.id, { status, ...(reply.json as object) });
      }
      if (tried >= limit || posts.length < page) break;
    }
    return { handled, failed };
  }

  /**
   * Records the first reply each asked-for agent posts in a task's thread:
   * as activity, as the task's artifact, and by moving an open task to
   * in_progress. Agents without the Signals tools (remote ones) get their
   * work on the task this way, and ask for input with a marked line (see
   * markedQuestion), which puts the task on hold. `fetch` queries the relay.
   */
  async collect(fetch: (filters: { kinds: number[]; "#e": string[]; authors: string[]; since: number }[]) => Promise<readonly ThreadReply[]>): Promise<{ recorded: number }> {
    const tasks = await this.store.awaitingAgents();
    if (!tasks.length) return { recorded: 0 };
    const accounts = new Map((await this.store.accounts()).map((account) => [account.name, account]));
    const people = await this.store.people(tasks.map((task) => task.id));
    const gone = await this.store.removed(tasks.map((task) => task.id));
    // The agents each task waits on: the account's, until one replies, and every agent asked to work on it that hasn't.
    const waiting = tasks.flatMap((task) => {
      const on = (people.get(task.id) ?? []).filter((person) => person.kind === "agent");
      const account = task.account ? accounts.get(task.account) : undefined;
      const fromAccount = !task.agent_reply && (task.mode === "auto" || task.mode === "draft") && account?.channel === task.channel ? agentsFor(account, task) : [];
      const done = new Set([...on.filter((person) => person.replied_at).map((person) => person.key), ...(gone.get(task.id) ?? [])]);
      const agents = [...new Set([...fromAccount, ...on.filter((person) => !person.replied_at).map((person) => person.key)])].filter((key) => !done.has(key));
      // An agent asked again (given input) counts only its replies since.
      const since = new Map(on.filter((person) => person.asked_at).map((person) => [person.key, person.asked_at!]));
      return agents.length ? [{ task, agents, since }] : [];
    });
    if (!waiting.length) return { recorded: 0 };
    const authors = [...new Set(waiting.flatMap((item) => item.agents))];
    const since = Math.min(...waiting.flatMap((item) => [item.task.created_at, ...item.since.values()])) - 60;
    const replies = await fetch([{ kinds: [9], "#e": waiting.map((item) => item.task.buzz_root!), authors, since }]);
    let recorded = 0;
    for (const { task, agents, since: askedAt } of waiting) {
      let first = !task.agent_reply;
      let status = task.status;
      let question = task.question;
      for (const agent of agents) {
        const after = askedAt.get(agent) ?? 0;
        const reply = replies
          .filter((event) => event.pubkey === agent && event.id !== task.buzz_root && event.created_at >= after && event.tags.some((tag) => tag[0] === "e" && tag[1] === task.buzz_root))
          .sort((a, b) => a.created_at - b.created_at)[0];
        if (!reply) continue;
        const actor = `agent:${npub(reply.pubkey)}`;
        const text = reply.content.replace(/\s+/g, " ").trim();
        await this.store.activity(task.id, actor, "agent_reply", text.length > 500 ? `${text.slice(0, 497)}…` : text);
        await this.store.artifact(task.id, actor, task.mode === "draft" ? "draft" : "reply", `buzz://message?channel=${task.channel}&id=${reply.id}`, `Agent reply in the task's thread`);
        // Links in the reply (a doc, a PR, a workspace, an app) become the task's assets, each once.
        const have = new Set((await this.store.detail(task.id))?.artifacts.map((item) => item.url) ?? []);
        for (const link of replyLinks(reply.content)) if (!have.has(link.url)) await this.store.artifact(task.id, actor, link.kind, link.url, link.title);
        if (task.mode === "draft") await this.warnDisclosure(task, agent, reply);
        await this.store.replied(task.id, agent, reply.created_at);
        // Agents without the Signals tools ask for input by marking a line in their reply.
        const ask = !question ? markedQuestion(reply.content) : undefined;
        if (ask) {
          const asked = await this.store.setQuestion(task.id, actor, { ...ask, by: agent });
          if (asked && this.notifier && asked.buzz_root) await this.notifier.updated(asked, questionMessage(asked, agent)).catch(() => {});
          question = ask.question;
          status = "waiting";
        }
        if (status === "open") {
          await this.store.setStatus(task.id, "in_progress", actor, "an agent replied in the task's thread");
          status = "in_progress";
        }
        if (first) {
          await this.store.setAgentReply(task.id, reply.id);
          first = false;
        }
        recorded++;
      }
    }
    return { recorded };
  }

  /**
   * Advisory only: records the disclosure check's result for an inline draft
   * (unchecked, clean or warned), once per reply. When the customer part has
   * internal-looking links or ids, the warning activity is saved with the
   * result, and the run that saved them says so in the task's thread, mentioning the agent: the
   * kinds only, never the flagged text. It never changes the task's status.
   */
  private async warnDisclosure(task: Task, agent: string, reply: ThreadReply): Promise<void> {
    const result = disclosureCheck(reply.content);
    const kinds = result.status === "warned" ? result.kinds : [];
    const warning = kinds.length ? { actor: `agent:${npub(agent)}`, text: `The customer draft in reply ${reply.id} has internal-looking content: ${kinds.join(", ")}` } : undefined;
    // The result and its warning activity are saved together; only the run that saved them posts.
    if (!(await this.store.disclosureChecked(task.id, reply.id, result.status, kinds, warning)) || !warning) return;
    if (this.notifier && task.buzz_root) await this.notifier.updated(task, disclosureMessage(kinds, agent), [agent]).catch(() => {});
  }

  /** Finishes meeting notes' action items a failed write cut short, finishes tasks by their rules' done_when, posts tasks that aren't in Buzz yet, and nudges stale ones. Run every few minutes. */
  async sweep(at?: number): Promise<{ posted: number; nudged: number; finished: number; resumed: number }> {
    let posted = 0;
    let nudged = 0;
    let finished = 0;
    // Meeting notes whose action items a failed write cut short: finished from the saved event (the poller won't post that version again).
    const pending = await this.store.pendingItems(await this.config(), 20, this.options.classifier);
    for (const { event, error } of pending.errors) this.log(`action items of event ${event} failed again: ${error}`);
    const resumed = pending.created.length + pending.updated.length;
    if (resumed) await this.announce({ received: 0, new: 0, changed: 0, same: 0, skipped: 0, filtered: 0, errors: [], created: pending.created, updated: pending.updated, finished: [], handled: [], firstRun: false });
    // Finished tasks first, so they aren't posted or nudged.
    for (const { task, reason } of await this.store.finishable(await this.config(), at)) {
      // (As it was judged: one that moved or got an event since is left for the next sweep.)
      const done = await this.store.finish(task.id, reason, task);
      if (!done) continue;
      finished++;
      if (this.notifier && done.buzz_root) await this.notifier.updated(done, doneMessage(reason)).catch(() => {});
    }
    if (this.notifier) {
      for (const task of await this.store.unposted()) {
        await this.post(task);
        if ((await this.store.task(task.id))?.buzz_root) posted++;
      }
      // Default-actions checks a post left waiting (it stopped, say), then notices whose post failed: done and sent now.
      for (const id of await this.store.pendingTriggers()) await this.drainTriggers(id, CHECK_LEASE).catch((error: Error) => this.log(`couldn't check task ${id}'s waiting default actions: ${error.message}`));
      for (const id of await this.store.undeliveredNotices()) await this.deliverNotices(id);
    }
    for (const { task, text } of await this.store.stale(await this.config(), at)) {
      if (this.notifier && task.buzz_root) await this.notifier.updated(task, `⏰ ${text}`).catch(() => {});
      await this.store.nudged(task.id, text, at);
      nudged++;
    }
    return { posted, nudged, finished, resumed };
  }
}

/** How many times in a row the inbox handles a post whose events failed to save before it's held: reported as the source's error, and tried again only every INBOX_HOLD_SECONDS. It's never dropped. */
export const INBOX_TRIES = 10;
export const INBOX_HOLD_SECONDS = 600;

/** The sources an inbox post is about: an events post's events', or a cursor post's. */
export function inboxSources(body: unknown): string[] {
  const given = body as { source?: unknown; events?: unknown } | null;
  if (typeof given?.source === "string") return [given.source];
  const events = Array.isArray(given?.events) ? given.events : Array.isArray(body) ? body : [body];
  const sources = events.map((event) => (event as { source?: unknown } | null)?.source).filter((source): source is string => typeof source === "string");
  return sources.length ? [...new Set(sources)] : ["*"];
}

/** How long the same update line isn't posted again in a task's thread. */
const REPEAT_MS = 12 * 60 * 60 * 1000;

/** What a task's thread is told when its rule finishes it. */
export const doneMessage = (reason: string) => `✅ Done: ${reason}. (Set its status on the Tasks board if it isn't.)`;

/** What a task's thread is told when someone on the team did the work themselves; its agents (taken off it) are told to stop. */
export function handledMessage(by: string, title?: string, url?: string, agents: readonly string[] = [], owner?: string): string {
  const what = url ? `[${title ?? "their reply"}](${url})` : title ? `"${title}"` : "";
  const whose = owner && owner !== by ? `It stays with **${owner}**` : "It's theirs now";
  return [
    `✅ Done: **${by}** handled this${what ? `: ${what}` : ""}. ${whose}; a new message from the customer opens it again.`,
    agents.length ? `${agents.map((key) => `nostr:${npub(key)}`).join(" ")} you're off this task: stop working on it, and don't post more here unless someone asks you.` : "",
  ]
    .filter(Boolean)
    .join("\n");
}

/**
 * Someone on the team handled a task, and a newer message from the customer
 * (in the same post) opened it again: it's still theirs, and the agents taken
 * off it stay off (as when the message comes later), with nothing saying it's done.
 */
export function handledThenReopened(by: string, title?: string, url?: string, agents: readonly string[] = [], owner?: string, next?: Readonly<{ title?: string; url?: string }>): string {
  const what = url ? `[${title ?? "their reply"}](${url})` : title ? `"${title}"` : "";
  const message = next?.url ? `[${next.title ?? "a new message"}](${next.url})` : next?.title ? `"${next.title}"` : "a new message";
  const who = owner && owner !== by ? owner : by;
  return [
    `↩️ **${by}** replied${what ? `: ${what}` : ""}, then the customer wrote again: ${message}. It's open, with **${who}**.`,
    agents.length ? `${agents.map((key) => `nostr:${npub(key)}`).join(" ")} you're off this task: **${who}** has it. Don't post more here unless someone asks you.` : "",
  ]
    .filter(Boolean)
    .join("\n");
}

/** Watched-field changes across several updates of one task: one per field, from its first value to its last. */
export function mergedChanges(changes: readonly FieldChange[]): FieldChange[] {
  const out = new Map<string, FieldChange>();
  for (const change of changes) {
    const before = out.get(change.field);
    out.set(change.field, before ? { field: change.field, from: before.from, to: change.to } : change);
  }
  return [...out.values()].filter((change) => change.from !== change.to);
}

/** A done task a new message opened again: what came in, that it's open, and who has it. */
/** What checkOpening found (see there). */
type TriggerCheck =
  | Readonly<{ kind: "none" | "failed" | "stale" }>
  | Readonly<{ kind: "checked"; key: string; task: Task; results: readonly TriggerResult[]; fired: readonly TriggerResult[]; source?: EventInput; reopened?: true }>;

/** An update's line: its title, linked to its source when it has a URL. */
const whatOf = (update: Readonly<{ title?: string | null; url?: string | null }>) => {
  const title = update.title ? plainSlack(update.title) : undefined;
  return update.url ? `[${title ?? "new event"}](${update.url})` : (title ?? "a new event");
};

/** How many of a new task's events its opening check goes through (the first ones attached; the rest are checked as updates). */
const OPENING_EVENTS = 6;
/** How many times a new task's post checks its opening again when an event it read changed meanwhile. */
const OPENING_TRIES = 3;

/** A task its workstream's default actions dismissed as it opened (none of their triggers held): one that holds later opens it again. */
const quietlyDismissed = (task: Task) => task.status === "dismissed" && task.triggers?.dismissed === true;

/** The line a new task's post gets from its default actions: which triggered, or that none did and what that means. */
export function openingNote(check: Readonly<{ key: string; task: Task; fired: readonly TriggerResult[] }>): string {
  if (check.fired.length) return triggeredLines(check.fired);
  return check.task.status === "dismissed"
    ? `No default action for ${check.key} is triggered, so it's dismissed. It opens again if one is.`
    : `No default action for ${check.key} is triggered, so it's tracked with no agent asked.`;
}

/** An update whose default actions fired: the line and the Triggered lines, asking `agents` to do them under the mode. */
export function triggeredMessage(task: Task, text: string, agents: readonly string[], account?: string, source?: string): string {
  const mode = task.mode === "auto" ? "auto" : "draft";
  return [
    text,
    agents.length ? `\n${agents.map((key) => `nostr:${npub(key)}`).join(" ")} the default actions above are triggered now: ${AGENT_ASK[mode]} Your next reply in this thread is recorded on the task.` : "",
    agents.length && source ? `\n${source}` : "",
    agents.length && account ? `\n${account}` : "",
  ]
    .filter(Boolean)
    .join("\n");
}

export function reopenedMessage(what: string, people: readonly string[], agents = false): string {
  return `↩️ Open again: ${what}\n${people.length ? `It's with **${people.join("**, **")}**.` : agents ? "Its agents are on it." : "No one has it yet."}`;
}

/** A task as its Buzz message shows it. */
/** An account as the API gives it: with its preferences read, so the UI and agents see what took. */
const withRead = (account: AccountRecord) => ({ ...account, read: parsePreferences(account.preferences) });

const MODE_TEXT = { auto: "Mode: auto (agents do it and report)", draft: "Mode: draft (agents prepare it; a person sends it)", ask: "Mode: ask (agents ask before doing anything)", off: "Mode: off" } as const;

/** What the account's agents are asked to do with a new task, by its mode. */
const AGENT_ASK = {
  auto: "please work on this now: follow the team's guidance below, do the work and report it in this thread.",
  draft: "please prepare this: follow the team's guidance below and post a draft in this thread (a reply, a doc) for a person to send. Don't send anything yourself. " + DRAFT_FORMAT,
} as const;
const AGENT_RECORD = "Your first reply in this thread is recorded on the task. If you have the Signals tools, signals_account gives the full account and signals_task_update records more. If you need a person's input to go on, ask with signals_task_update (question, options), or start a line of your reply with \"Needs input:\" and the question, optionally followed by a line \"Options: A / B / C\".";

/** How far back, and how many, open tasks an agent added to an account is asked to pick up. */
const HAND_OFF_DAYS = 14;
const HAND_OFF_MAX = 20;

/** Why agents are handed a task: the list it goes to (a workstream's key, or the account's), and whether its workstream's own agents were just cleared. */
export function handOffReason(workstream?: string, fellBack = false): string {
  if (workstream) return `you've been named this account's agents for ${workstream}`;
  if (fellBack) return "this task's workstream no longer has its own agents, so it goes to this account's agents";
  return "you've been added to this account's agents";
}

/** The reply that asks agents just added to an account to work on a task that's already posted. */
export function handOffMessage(task: Task, agents: readonly string[], account?: string, source?: string, why = handOffReason()): string {
  return [
    `${agents.map((key) => `nostr:${npub(key)}`).join(" ")} ${why}, and no agent has worked on this task yet: ${AGENT_ASK[task.mode as "auto" | "draft"]} The task is in this thread's first message${source ? " and its source is below" : ""}. ${AGENT_RECORD}`,
    // Tasks posted before posts carried their source don't have it in the first message.
    source ? `\n${source}` : "",
    account ? `\n${account}` : "",
  ]
    .filter(Boolean)
    .join("\n");
}

const clip = (text: string, max: number) => (text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text);

/**
 * What an agent woken on a task needs from the account, for agents without the
 * Signals tools. With a task, it carries that task's playbook (by its rule id,
 * then its workstream) and no other.
 */
export function briefing(account: AccountRecord, labels: ResolvedLabels = labelsOf(undefined), task?: Readonly<{ rule_id: string; workstream: string | null }>): string {
  const read = parsePreferences(account.preferences);
  const playbook = task && playbookFor(account.playbooks, task);
  const actions = task && actionsFor(account.workstream_actions, task);
  const modes = Object.entries(read.modes).map(([key, mode]) => `${key}: ${mode}`).join("; ");
  return [
    `**For agents: ${account.name}**`,
    modes && `Modes: ${modes}`,
    account.domains.length ? `${capitalized(labels.customer)} domains: ${account.domains.join(", ")}` : "",
    read.guidance && `Team guidance:\n${clip(read.guidance, 2000)}`,
    playbook && `Playbook for ${playbook.key} (how the team likes this done; follow it):\n${clip(playbook.text, 3000)}`,
    actions && actionsText(actions),
    account.profile.trim() && `Profile:\n${clip(account.profile.trim(), 3000)}`,
  ]
    .filter(Boolean)
    .join("\n");
}

/**
 * A time in the event's own zone, labeled with it: calendars give the time in
 * the reader's offset (`07:00-08:00`) and the zone it was set in
 * (`America/New_York`) separately. Undefined for a time or zone it can't read.
 */
function inZone(time: string, zone: string): string | undefined {
  const at = new Date(time);
  if (Number.isNaN(at.getTime())) return undefined;
  try {
    const parts = Object.fromEntries(
      new Intl.DateTimeFormat("en-CA", { timeZone: zone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23", timeZoneName: "shortOffset" })
        .formatToParts(at)
        .map((part) => [part.type, part.value]),
    );
    return `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute} ${zone} (${parts.timeZoneName})`;
  } catch {
    return undefined;
  }
}

/** `2026-11-18T10:00:00-08:00`, `{dateTime, timeZone}` or `{date}` as text. */
function timeText(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (value && typeof value === "object") {
    const t = value as Record<string, unknown>;
    if (typeof t.dateTime === "string") return typeof t.timeZone === "string" && t.timeZone ? (inZone(t.dateTime, t.timeZone) ?? t.dateTime) : t.dateTime;
    if (typeof t.date === "string") return `${t.date} (all day)`;
  }
  return undefined;
}


const SHOWN = new Set(["start", "end", "attendees", "description", "location", "hangoutLink", "organizer", "notes"]);
const MAX_ATTENDEES = 30;

/**
 * The source event as a task's post shows it: its link, when, who (people
 * at the account's domains marked as customers), the description and a short
 * excerpt of its other fields.
 */
export function eventDetails(event: EventInput, domains: readonly string[] = [], labels: ResolvedLabels = labelsOf(undefined), task?: Readonly<{ title: string }>): string {
  const payload = event.payload ?? {};
  const lower = domains.map((domain) => domain.toLowerCase());
  const customer = (email?: string) => Boolean(email && lower.some((domain) => email.toLowerCase().endsWith(`@${domain}`) || email.toLowerCase().endsWith(`.${domain}`)));
  const start = timeText(payload.start);
  const end = timeText(payload.end);
  const when = start ? `When: ${start}${end ? ` → ${end}` : ""}` : typeof event.occurred_at === "number" && event.occurred_at > 0 ? `When: ${new Date(event.occurred_at * 1000).toISOString()}` : "";
  const listed = attendeesOf(payload.attendees);
  // Your own people often have an address at the customer's domain too; it isn't a customer.
  const twins = new Map(listed.filter((a) => customer(a.email)).flatMap((a) => {
    const twin = twinOf(a, listed.filter((other) => other.email && !customer(other.email)));
    return twin ? [[a.email!, twin] as const] : [];
  }));
  const isCustomer = (a: Attendee) => customer(a.email) && !twins.has(a.email!);
  const attendees = listed.sort((a, b) => Number(isCustomer(b)) - Number(isCustomer(a)));
  const who = attendees.slice(0, MAX_ATTENDEES).map((a) => {
    const label = a.name && a.email ? `${a.name} <${a.email}>` : (a.email ?? a.name!);
    const twin = a.email ? twins.get(a.email) : undefined;
    const notes = [isCustomer(a) && labels.customer, twin && `${labels.customer}-domain address of ${twin}, not a ${labels.customer}`, a.organizer && "organizer", a.status && a.status !== "needsAction" && a.status].filter(Boolean);
    return `- ${label}${notes.length ? ` (${notes.join(", ")})` : ""}`;
  });
  if (attendees.length > MAX_ATTENDEES) who.push(`- …and ${attendees.length - MAX_ATTENDEES} more`);
  const description = typeof payload.description === "string" ? payload.description.replace(/<[^>]+>/g, " ").replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n").trim() : "";
  // A notes doc's Summary and Next steps (the poller's `payload.notes`): what the follow-up is about. Vertical tabs are Docs' soft line breaks.
  const notes = typeof payload.notes === "string" ? payload.notes.replace(/\v/g, "\n").replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n").trim() : "";
  const rest = Object.entries(payload).filter(([key, value]) => !SHOWN.has(key) && value !== null && value !== undefined && value !== "" && !(Array.isArray(value) && !value.length));
  const excerpt = rest.map(([key, value]) => `${key}: ${typeof value === "string" ? value : JSON.stringify(value)}`).join("; ");
  const original = task ? sourceTitle(event, task.title) : undefined;
  const place = [typeof payload.location === "string" && payload.location, typeof payload.hangoutLink === "string" && payload.hangoutLink].filter(Boolean).join(" · ");
  return plainSlack([
    `**Source** (${event.source})${event.url ? `: ${event.url}` : ""}`,
    // The source's own title, when the task's (shortened, or a template) doesn't show it: one line.
    original && `Title: ${clip(original, 300)}`,
    when,
    event.actor ? `From: ${event.actor}` : "",
    place && `Where: ${place}`,
    who.length ? `Attendees (${attendees.length}):\n${who.join("\n")}` : "",
    description && `Description:\n${clip(description, 1500)}`,
    notes && `Meeting notes (summary and next steps):\n${clip(notes, 4000)}`,
    excerpt && `Details: ${clip(excerpt, 600)}`,
  ]
    .filter(Boolean)
    .join("\n"));
}

/** Someone on a task as the board shows them. */
export type BoardPerson = Readonly<{
  /** agent: a Buzz agent (key is its hex pubkey); person: someone on your team (email); customer: someone at the account (email); team: the party a task sits with, named as labels.parties says, like Support. */
  kind: "agent" | "person" | "customer" | "team";
  key: string;
  label: string;
  /** Why they're on it, e.g. "owner" (someone assigned them), "asked", "replied", "assignee", "changed it". */
  role: string;
  /** On the task in the hub (an owner, or an agent asked), so it can be taken off; others are only seen in its source or activity. */
  on?: true;
}>;

export type BoardTask = Readonly<{
  task: Task;
  people: readonly BoardPerson[];
  source?: Readonly<{ source: string; title?: string; url?: string; occurred_at: number }>;
  /** The event the task opened with, whose title it took (left out for tasks opened before this was kept). */
  origin?: Readonly<{ source: string; external_id: string; title?: string; url?: string }>;
  artifacts: readonly Readonly<{ at: number; actor: string; kind: string; url: string; title?: string }>[];
  activity?: Readonly<{ at: number; actor: string; kind: string; text: string }>;
  /** The task's Buzz thread, to steer its agents there. */
  thread?: string;
}>;

const text = (value: unknown) => (typeof value === "string" && value.trim() ? value.trim() : undefined);
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
/** `Ann <ann@x.io>` or `ann@x.io` as its parts. */
function mailbox(value: string): { email?: string; name?: string } {
  const angle = /^\s*"?([^"<]*?)"?\s*<([^>]+)>\s*$/.exec(value);
  if (angle) return { email: angle[2]!.trim().toLowerCase(), ...(angle[1]!.trim() && { name: angle[1]!.trim() }) };
  return EMAIL.test(value.trim()) ? { email: value.trim().toLowerCase() } : { name: value.trim() };
}

/**
 * Who's on a task: agents asked to work on it (and whether they replied),
 * people who changed it, and who its source says: the party it sits with
 * (the rule's `party`, named as `labels.parties` says) and its owner or assignee, and the
 * customer's people who wrote or are in the meeting (at the account's domains).
 */
export function whoIsOn(people: readonly TaskPerson[], actors: readonly string[], event: EventInput | undefined, domains: readonly string[], labels: ResolvedLabels = labelsOf(undefined), rule?: Pick<Rule, "party">): BoardPerson[] {
  const out = new Map<string, BoardPerson>();
  const add = (person: BoardPerson) => {
    const id = `${person.kind}:${person.key.toLowerCase()}`;
    if (!out.has(id)) out.set(id, person);
  };
  for (const person of people) {
    if (person.kind === "agent") add({ kind: "agent", key: person.key, label: person.label ?? npub(person.key).slice(0, 12) + "…", role: person.assigned_at ? "owner" : person.replied_at ? "replied" : "asked", on: true });
    else add({ kind: "person", key: person.key, label: person.label ?? (HEX64.test(person.key) ? npub(person.key).slice(0, 12) + "…" : person.key), role: person.assigned_at ? "owner" : "on it", on: true });
  }
  for (const actor of actors) {
    if (actor.startsWith("agent:")) {
      const key = agentKey(actor.slice(6));
      if (key) add({ kind: "agent", key, label: actor.slice(6, 18) + "…", role: "replied" });
    } else if (EMAIL.test(actor)) add({ kind: "person", key: actor.toLowerCase(), label: actor, role: "changed it" });
  }
  if (!event) return [...out.values()];
  const lower = domains.map((domain) => domain.toLowerCase());
  const customer = (email?: string) => Boolean(email && lower.some((domain) => email.endsWith(`@${domain}`) || email.endsWith(`.${domain}`)));
  const payload = event.payload ?? {};
  const source = event.source.toLowerCase();
  const party = partyFor(rule);
  if (party) {
    add({ kind: "team", key: party, label: labels.parties[party] ?? capitalized(party), role: event.source });
    const owner = text(payload.owner) ?? text(payload.assignee);
    if (owner) {
      const who = mailbox(owner);
      add({ kind: "person", key: who.email ?? who.name!, label: who.name ?? who.email!, role: text(payload.owner) ? "owner" : "assignee" });
    }
  }
  if (event.actor) {
    const who = mailbox(event.actor);
    if (customer(who.email)) add({ kind: "customer", key: who.email!, label: who.name ?? who.email!, role: source === "gmail" ? "wrote" : "from" });
  }
  for (const attendee of realCustomers(payload.attendees, (email) => customer(email.toLowerCase())))
    add({ kind: "customer", key: attendee.email!.toLowerCase(), label: attendee.name ?? attendee.email!, role: "attendee" });
  return [...out.values()];
}

/** At most this many choices for a question; each at most 200 characters. */
const MAX_OPTIONS = 8;

/** A question as the API or a tool gives it: its text and choices, or what's wrong. */
export function readQuestion(question: unknown, options: unknown): { question: string; options: string[] } | string {
  if (typeof question !== "string" || !question.trim() || question.length > 2000) return "question is what you need to know (text, at most 2000 characters).";
  const list = options === undefined ? [] : Array.isArray(options) ? options : typeof options === "string" ? splitOptions(options) : null;
  if (!list || list.some((item) => typeof item !== "string" || !item.trim() || item.length > 200) || list.length > MAX_OPTIONS)
    return `options is a list of up to ${MAX_OPTIONS} choices (text, at most 200 characters each).`;
  return { question: question.trim(), options: [...new Set((list as string[]).map((item) => item.trim()))] };
}

/**
 * The kind of asset a link is, from its address: a Google doc, sheet, slides
 * or Drive file; a GitHub pull request, issue or code; a Databricks app,
 * notebook, dashboard or workspace; a Slack message; or any other link.
 */
export function linkKind(url: string): string {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return "link";
  }
  const host = parsed.hostname.toLowerCase();
  const path = parsed.pathname;
  if (host === "docs.google.com") return /^\/spreadsheets\//.test(path) ? "sheet" : /^\/presentation\//.test(path) ? "slides" : /^\/forms\//.test(path) ? "form" : "doc";
  if (host === "drive.google.com") return "drive";
  if (host === "github.com") return /\/pull\/\d+/.test(path) ? "pr" : /\/issues\/\d+/.test(path) ? "issue" : "code";
  if (host.endsWith(".databricksapps.com")) return "app";
  if (host.endsWith(".cloud.databricks.com") || host.endsWith(".azuredatabricks.net") || host.endsWith(".gcp.databricks.com")) {
    if (/\/apps\//.test(path)) return "app";
    if (/\/(sql\/)?dashboards|\/dashboardsv3\//.test(path)) return "dashboard";
    if (/\/editor\/notebooks\/|#notebook\//.test(path + parsed.hash)) return "notebook";
    return "workspace";
  }
  if (host.endsWith(".slack.com")) return "slack";
  return "link";
}

const LINK = /\[([^\]\n]{1,200})\]\((https?:\/\/[^\s)]+)\)|<?(https?:\/\/[^\s<>()\]"'`]+)/g;

/** The http(s) links in an agent's reply, each once, with its kind and the markdown link text as its title. */
export function replyLinks(text: string): { url: string; kind: string; title?: string }[] {
  const out = new Map<string, { url: string; kind: string; title?: string }>();
  for (const found of text.matchAll(LINK)) {
    const url = (found[2] ?? found[3] ?? "").replace(/[.,;:!?>*_]+$/, "");
    if (!url || out.has(url)) continue;
    const title = found[1]?.trim();
    out.set(url, { url, kind: linkKind(url), ...(title && title !== url ? { title } : {}) });
  }
  return [...out.values()].slice(0, 20);
}

const splitOptions = (text: string) => text.split(/\s+\/\s+|\s*\|\s*|\s*;\s*/).map((item) => item.trim()).filter(Boolean);
const MARKED = /^[\s>*_~`-]*(?:\p{Extended_Pictographic}\uFE0F?\s*)?needs input[*_]*\s*:[*_]*\s*(.+)$/iu;
const OPTIONS_LINE = /^[\s>*_~`-]*options[*_]*\s*:[*_]*\s*(.+)$/iu;

/**
 * The question an agent marked in its reply, for agents without the Signals
 * tools: a line starting "Needs input:", and optionally the next line
 * "Options: A / B / C" (or separated by | or ;).
 */
export function markedQuestion(text: string): { question: string; options: string[] } | undefined {
  const lines = text.split(/\r?\n/);
  for (const [n, line] of lines.entries()) {
    const found = MARKED.exec(line);
    if (!found) continue;
    const options = OPTIONS_LINE.exec(lines[n + 1] ?? "");
    const read = readQuestion(found[1]!.replace(/[*_]+$/, "").trim(), options ? splitOptions(options[1]!).slice(0, MAX_OPTIONS).map((item) => item.slice(0, 200)) : []);
    return typeof read === "string" ? undefined : read;
  }
  return undefined;
}

/** The thread reply when a draft's customer part looks like it has internal content: the kinds only, never the text. */
export function disclosureMessage(kinds: readonly string[], agent: string): string {
  return `⚠️ nostr:${npub(agent)} the customer draft has internal-looking content (${kinds.join(", ")}). Please check it and move anything internal under "Internal notes" before anyone sends it. This is a warning only; the task isn't on hold.`;
}

/** The thread reply when a task goes on hold for input. */
export function questionMessage(task: Task, by: string): string {
  return [`⏸️ **Needs input** (asked by ${HEX64.test(by) ? `nostr:${npub(by)}` : by}): ${task.question}`, task.options?.length ? `Options: ${task.options.join(" / ")}` : "", "Answer from the Tasks board (Provide input on its card)."].filter(Boolean).join("\n");
}

/** The thread reply with a person's answer, asking the task's agents to go on. */
export function answerMessage(task: Task, user: string, text: string, agents: readonly string[]): string {
  return [
    `${agents.map((key) => `nostr:${npub(key)}`).join(" ")}${agents.length ? " " : ""}${user} answered: ${text}`.trim(),
    `\n> ${task.question}`,
    agents.length ? "\nPlease go on with the task. Your next reply in this thread is recorded on it." : "",
  ]
    .filter(Boolean)
    .join("\n");
}

const changeLine = (change: FieldChange) => `${change.field}: ${change.from} → ${change.to}`;

/** The thread's line when a watched field changes, asking the agents on it (if any) to go on. */
export function changedMessage(task: Task, update: string, changes: readonly FieldChange[], agents: readonly string[], account?: string, outgrown?: Readonly<{ rule: string; values: readonly { field: string; value: string }[] }>, source?: string, checklist?: string): string {
  const mode = task.mode === "auto" ? "auto" : "draft";
  return [
    `${update}\n${changes.map((change) => `- **${change.field}:** ${change.from} → ${change.to}`).join("\n")}`,
    checklist ? `\n${checklist}` : "",
    outgrown ? `\nThe rule this task is under (${outgrown.rule}) no longer applies, and no other rule for this kind of work does, so its playbook isn't given.${outgrown.values.length ? ` Now: ${outgrown.values.map((item) => `${item.field} ${item.value}`).join(", ")}.` : ""} Go by the source as it is now${source && agents.length ? " (below)" : ""}.` : "",
    agents.length ? `\n${agents.map((key) => `nostr:${npub(key)}`).join(" ")} this changed since you last looked: ${AGENT_ASK[mode]} Your next reply in this thread is recorded on the task.` : "",
    agents.length && source ? `\n${source}` : "",
    agents.length && account ? `\n${account}` : "",
  ]
    .filter(Boolean)
    .join("\n");
}

/** The reply that asks agents someone added to a task to work on it. */
/** An owner as the API takes one: an agent or a person, by hex pubkey or (people only) email. */
export type Owner = Readonly<{ kind: "agent" | "person"; key: string }>;

/** Owners from the API: pubkeys (hex or npub, agents unless said) or emails (people), or {key, kind}; else what's wrong. */
export function readOwners(value: unknown): Owner[] | string {
  const list = Array.isArray(value) ? value : [value];
  if (list.length > 10) return "at most 10.";
  const out = new Map<string, Owner>();
  for (const item of list) {
    const raw = typeof item === "string" ? item : item && typeof item === "object" && typeof (item as { key?: unknown }).key === "string" ? (item as { key: string }).key : undefined;
    const kind = item && typeof item === "object" ? (item as { kind?: unknown }).kind : undefined;
    if (raw === undefined || (kind !== undefined && kind !== "agent" && kind !== "person")) return "each is a pubkey (hex or npub), an email, or {key, kind: \"agent\" | \"person\"}.";
    const key = agentKey(raw);
    const email = key ? undefined : mailbox(raw).email;
    if (!key && !email) return `${JSON.stringify(raw)} isn't a pubkey or an email.`;
    out.set(key || email!, { kind: email ? "person" : ((kind as Owner["kind"] | undefined) ?? "agent"), key: key || email! });
  }
  return [...out.values()];
}

/** The thread's line when a task's owners change: who's off it (agents told to stop) and who has it now (agents asked to start). */
export function ownersMessage(task: Task, user: string, on: readonly Owner[], off: readonly Owner[], note?: string, account?: string, source?: string): string {
  const who = (owner: Owner) => (HEX64.test(owner.key) ? `nostr:${npub(owner.key)}` : `**${owner.key}**`);
  const agents = on.filter((owner) => owner.kind === "agent");
  const offAgents = off.filter((owner) => owner.kind === "agent");
  const offPeople = off.filter((owner) => owner.kind === "person");
  const mode = task.mode === "auto" ? "auto" : "draft";
  return [
    on.length ? `👤 ${user} assigned this to ${on.map(who).join(", ")}.${note ? ` ${note}` : ""}` : `👤 ${user} took ${off.map(who).join(", ")} off this task.${note ? ` ${note}` : ""}`,
    on.length && offPeople.length ? `${offPeople.map(who).join(", ")} ${offPeople.length > 1 ? "are" : "is"} off it.` : "",
    offAgents.length ? `\n${offAgents.map(who).join(" ")} you're off this task: stop working on it, and don't post more here unless someone asks you.` : "",
    agents.length ? `\n${agents.map(who).join(" ")} ${AGENT_ASK[mode]} The task is in this thread's first message${source ? " and its source is below" : ""}. ${AGENT_RECORD}` : "",
    agents.length && source ? `\n${source}` : "",
    agents.length && account ? `\n${account}` : "",
  ]
    .filter(Boolean)
    .join("\n");
}

export function askMessage(task: Task, agents: readonly string[], user: string, note?: string, account?: string, source?: string): string {
  const mode = task.mode === "auto" || task.mode === "draft" ? task.mode : "draft";
  return [
    `${agents.map((key) => `nostr:${npub(key)}`).join(" ")} ${user} asked you to work on this task: ${AGENT_ASK[mode]} The task is in this thread's first message. ${AGENT_RECORD}`,
    note ? `\n${user}: ${note}` : "",
    source ? `\n${source}` : "",
    account ? `\n${account}` : "",
  ]
    .filter(Boolean)
    .join("\n");
}

/** A task post's reply line. Its wording marks posts with their source last, and no line of the source is it (posts.ts SOURCE_LAST_REPLY). */
export const TASK_REPLY = "Reply in this thread to work on it. Agents update it with the signals_task tools.";

export function taskMessage(task: Task, detail?: { agents?: readonly string[]; briefing?: string; source?: string; note?: string }): string {
  const asking = Boolean(detail?.agents?.length && (task.mode === "auto" || task.mode === "draft"));
  // The source ends at the first line that is the reply line: one of its own that reads the same (a pasted post) gets a
  // no-break space after "Reply", which looks the same and isn't that line.
  const source = detail?.source?.split("\n").map((line) => (line.trim() === TASK_REPLY ? line.replace("Reply ", "Reply\u00a0") : line)).join("\n");
  const ask = asking ? `${detail!.agents!.map((key) => `nostr:${npub(key)}`).join(" ")} ${AGENT_ASK[task.mode as "auto" | "draft"]} ${AGENT_RECORD}` : "";
  return [
    `📌 **Task ${task.id}: ${task.title}**`,
    [task.account && `Account: ${task.account}`, task.workstream && `Workstream: ${task.workstream}`, task.initiative && `Initiative: ${task.initiative}`, `Rule: ${task.rule_id}`].filter(Boolean).join(" · "),
    MODE_TEXT[task.mode] ?? "",
    task.question ? `⏸️ **Needs input:** ${task.question}${task.options?.length ? `\nOptions: ${task.options.join(" / ")}` : ""}\nAnswer from the Tasks board (Provide input on its card).` : "",
    // What the default actions found and the checklist come before the source, which runs to the reply line: a
    // source's text can look like either, so the card (posts.ts) reads them by place. The reply line's wording says
    // a post is laid out this way (TASK_REPLY); posts before it had them after the source.
    [detail?.note, task.checklist, source].some(Boolean) ? `\n${[detail?.note, task.checklist, source].filter(Boolean).join("\n\n")}\n` : "",
    TASK_REPLY,
    ask,
    asking && detail?.briefing ? `\n${detail.briefing}` : "",
  ]
    .filter(Boolean)
    .join("\n");
}
