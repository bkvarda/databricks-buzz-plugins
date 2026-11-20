// Signals: the event model and the rules that turn events into tasks.
//
// Everything here is pure (no database, no network, no Node modules), so the
// hub, the plugin and the tests share it. A source (a poller, the plugin, an agent) sends
// events; the hub keeps one row per (owner, source, external_id), notices
// when an event's content changed, and runs the rules to decide whether it
// opens a task, updates one, or is only recorded.

import { attendeesOf, realCustomers } from "./attendees";

/** What a source sends. `external_id` is the source's own key for the thing (a message id, a ticket key, a table row's key). */
export type EventInput = Readonly<{
  source: string;
  external_id: string;
  /** When it happened at the source, ISO 8601 or Unix seconds. */
  occurred_at?: string | number;
  title?: string;
  url?: string;
  /** Who it's from at the source (an email, a name). */
  actor?: string;
  /** The account it's about, when the source knows (a table column, say). */
  account?: string;
  /** Events with the same group key belong to one task (a ticket and its updates, a thread). */
  group_key?: string;
  /** The source's fields. Rules match on them. */
  payload?: Readonly<Record<string, unknown>>;
}>;

export type EventRecord = EventInput & Readonly<{ owner: string; content_hash: string }>;

export const MAX_EVENTS_PER_POST = 500;

const SOURCE = /^[a-z][a-z0-9_.-]{0,63}$/;

/** Checks and trims a posted event; a string explains what's wrong. */
export function validateEvent(raw: unknown): EventInput | string {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return "an event is an object";
  const event = raw as Record<string, unknown>;
  if (typeof event.source !== "string" || !SOURCE.test(event.source)) return "source must be a lowercase name like gmail or table.support_cases";
  if (typeof event.external_id !== "string" && typeof event.external_id !== "number") return "external_id is required";
  const external = String(event.external_id).trim();
  if (!external || external.length > 512) return "external_id must be 1-512 characters";
  for (const field of ["title", "url", "actor", "account", "group_key"] as const)
    if (event[field] !== undefined && event[field] !== null && typeof event[field] !== "string") return `${field} must be a string`;
  if (event.payload !== undefined && event.payload !== null && (typeof event.payload !== "object" || Array.isArray(event.payload))) return "payload must be an object";
  if (event.occurred_at !== undefined && event.occurred_at !== null && Number.isNaN(toSeconds(event.occurred_at as string | number))) return "occurred_at must be ISO 8601 or Unix seconds";
  const text = (value: unknown, max: number) => (typeof value === "string" && value.trim() ? value.trim().slice(0, max) : undefined);
  const out: Record<string, unknown> = { source: event.source, external_id: external };
  if (event.occurred_at !== undefined && event.occurred_at !== null) out.occurred_at = event.occurred_at;
  for (const [field, max] of [["title", 500], ["url", 2000], ["actor", 320], ["account", 200], ["group_key", 512]] as const) {
    const value = text(event[field], max);
    if (value) out[field] = value;
  }
  if (event.payload) out.payload = event.payload;
  return out as EventInput;
}

export function toSeconds(value: string | number | undefined): number {
  if (value === undefined) return Math.floor(Date.now() / 1000);
  if (typeof value === "number") return value > 1e12 ? Math.floor(value / 1000) : Math.floor(value);
  if (/^\d+(\.\d+)?$/.test(value)) return toSeconds(Number(value));
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? Number.NaN : Math.floor(ms / 1000);
}

/**
 * The same moment as `toSeconds`, in whole microseconds, keeping what a
 * decimal string carries exactly (Slack's `1795001030.900000`) rather than
 * through a float. NaN when it can't be read.
 */
export function toMicros(value: string | number | undefined): number {
  if (value === undefined) return Date.now() * 1000;
  if (typeof value === "number") return value > 1e12 ? Math.floor(value) * 1000 : Math.round(value * 1e6);
  const decimal = /^(\d+)(?:\.(\d+))?$/.exec(value);
  if (decimal) {
    const whole = Number(decimal[1]);
    if (whole > 1e12) return Math.floor(Number(value)) * 1000;
    return whole * 1_000_000 + Number((decimal[2] ?? "").slice(0, 6).padEnd(6, "0"));
  }
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? Number.NaN : ms * 1000;
}

/** JSON with sorted keys, so the same content always hashes the same. */
export function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  const object = value as Record<string, unknown>;
  return `{${Object.keys(object)
    .filter((key) => object[key] !== undefined)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonical(object[key])}`)
    .join(",")}}`;
}

/** What makes an event "changed": its title, url, account, group and payload; not when it was seen. (Hashed by the store.) */
export function contentKey(event: EventInput): string {
  const { title, url, account, group_key, payload } = event;
  return canonical({ title, url, account, group_key, payload });
}

// ---------------------------------------------------------------------------
// Rules

/** A condition on a field: a regular expression (case-insensitive), or a list of exact values. */
export type Condition = string | readonly (string | number | boolean)[];

export type Rule = Readonly<{
  id: string;
  /** Sources it applies to (exact names, or a prefix ending in `*`). All when omitted. */
  sources?: readonly string[];
  /** Field → condition. Fields are event fields (title, actor, account…) or `payload.<name>`. All must hold. */
  when?: Readonly<Record<string, Condition>>;
  /** Field → condition that must not hold. */
  unless?: Readonly<Record<string, Condition>>;
  /**
   * The meeting has the customer in it: `true` for people at any account's
   * email domains (the domains a team gives when it sets up its account
   * channel), or a pattern for the customer's email addresses
   * (`@(globex\\.io|globex\\.com)$`). The rule applies only when
   * `payload.attendees` has someone it matches who isn't the same person as an
   * attendee it doesn't match (see attendees.ts), so a meeting of your own
   * team that invites their customer-domain addresses doesn't count.
   */
  customer_attendees?: true | string;
  /** The event is from the customer: `true` for an `actor` at any account's email domains, or a pattern for the actor's email address. */
  customer_actor?: true | string;
  /**
   * The event names an account in this field (like a Slack message's
   * `payload.channel`, `ext-globex-team`, or a doc's `title`): the account's
   * name or one of its other names appears in it as whole words.
   */
  account_named_in?: string;
  /** Skip events whose `actor` is the person whose source sent them (your own Slack messages, mail you sent). */
  skip_own?: boolean;
  /**
   * Only events about an account the hub knows (set up in a channel, or a
   * config account), found by its name, other names, ids, domains or the
   * other ways accountFor finds one. An event naming an account no one set up
   * opens nothing (no task in default_channel); a later rule may still apply.
   */
  known_account?: boolean;
  /**
   * Asks a small model whether the event really needs the team (see
   * Classify), before it opens a new task. Below `min` the event is recorded
   * as filtered, with its score, and opens nothing; it's on the hub's
   * filtered list. Updates to tasks that exist aren't asked. When the model
   * can't answer, the task opens (it fails open).
   */
  classify?: Classify;
  /** task: open (or update) a task. update: only update a task that exists for the group. ignore: record the event, no task. */
  action: "task" | "update" | "ignore";
  /** The task's title; `{field}` takes an event field, e.g. "Prep: {title}". Defaults to the event's title. */
  title?: string;
  workstream?: string;
  /**
   * Which events share a task: an event field (`payload.workspace`), or a
   * template of fields (`{payload.workspace}/{payload.region}`). Default
   * group_key; when it's empty, the event's own source and external_id.
   */
  group_by?: string;
  /**
   * What makes one person's thing the same as another person's, when their
   * group keys differ (each mailbox has its own Gmail thread ids): a template
   * of fields, like `{actor}|{title}|{occurred_at}`, that has the same value
   * in every copy. Every field it names must be there. When a new group's
   * event matches it, that group joins the task the match is on, so its later
   * events go there too.
   */
  same_as?: string;
  /**
   * The event is a meeting's notes (`payload.notes`, Gemini's "Next steps"
   * lines, `[Name] Title: what to do`): each item someone on the account team
   * owns opens its own task, under `workstream`, assigned to that person when
   * the name is one attendee. The customer's items, and items whose owner
   * isn't clear, are listed on this rule's task as a checklist. The meeting's
   * attendees come from the `meetings` source's event (default
   * google_calendar) that the notes' `payload.meeting` link names.
   */
  action_items?: Readonly<{ workstream?: string; meetings?: string }>;
  /** Rules with the same group share tasks (default: the rule's id). An `update` rule needs the group of the rule that opens the tasks. */
  group?: string;
  /** Overrides the account the event says (a fixed name or `{payload.account_name}`). */
  account?: string;
  /** Who tasks from this rule sit with on the tasks board: a key of labels.parties, like `support` (default: the source says). */
  party?: string;
  /**
   * What makes events one recurring series, like a meeting's
   * `payload.recurringEventId` (a field or a `{field}` template). The first
   * time a series shows up, its task asks the team once (Always / Just this
   * one / Never), and the answer holds for the series' later events.
   */
  series?: string;
  /** Nudge when the event's latest version still matches `when` after this many hours. */
  stale_after_hours?: number;
  /** What the nudge says; `{field}` takes an event field. */
  nudge?: string;
  /** When its tasks are finished, so the hub marks them done itself (see DoneWhen). */
  done_when?: DoneWhen;
  /**
   * Event fields (`payload.es_status`) whose changes matter: when a later
   * event changes one, the task's thread is told what changed
   * (`es_status: Mitigated → Resolved`) and the agents on it are asked to go
   * on, with the playbook of the rule that now applies.
   */
  watch?: readonly string[];
}>;

/** A watched field's change between a task's previous event and its new one. */
export type FieldChange = Readonly<{ field: string; from: string; to: string }>;

/** A watched field's value on an event, as the thread shows it. */
export const watchedValue = (event: EventInput, path: string) => shown(field(event, path)) || "(none)";

const shown = (value: unknown) => (value === undefined || value === null || value === "" ? "" : typeof value === "object" ? JSON.stringify(value) : String(value));

/** The watched fields that differ between two events, in the order given; a field only one of them has counts. */
export function fieldChanges(fields: readonly string[] | undefined, before: EventInput | undefined, after: EventInput): FieldChange[] {
  if (!before || !fields?.length) return [];
  return [...new Set(fields)].flatMap((path) => {
    const [from, to] = [shown(field(before, path)), shown(field(after, path))];
    return from === to ? [] : [{ field: path.replace(/^payload\./, ""), from: from || "(none)", to: to || "(none)" }];
  });
}

/**
 * A yes/no question for a rule's events, put to the classifier model with the
 * event's source, subject, sender, recipients and snippet. `true` and
 * `false` say what each answer means; `min` is the lowest probability of yes
 * that opens a task (default 0.7).
 */
export type Classify = Readonly<{ question: string; true?: string; false?: string; min?: number }>;
export const DEFAULT_CLASSIFY_MIN = 0.7;

/** What the classifier sees of an event: only what it needs to judge it. */
export function classifyState(event: EventInput): Record<string, string> {
  const payload = event.payload ?? {};
  const text = (value: unknown, max: number) => (typeof value === "string" ? value : value === undefined || value === null ? "" : JSON.stringify(value)).replace(/\s+/g, " ").trim().slice(0, max);
  const state: Record<string, string> = { source: event.source, title: text(event.title, 300), from: text(event.actor, 200) };
  for (const [key, max] of [["to", 300], ["snippet", 1000], ["description", 1000], ["text", 1000], ["status", 100]] as const) {
    const value = text(payload[key], max);
    if (value) state[key] = value;
  }
  return state;
}

/** The questions to send the classifier for a rule's `classify`, under `classify`. */
export function classifyQuestions(classify: Classify): Record<string, { type: "noul"; instructions: string; criteria?: { true: string; false: string } }> {
  return { classify: { type: "noul", instructions: classify.question, ...(classify.true && classify.false && { criteria: { true: classify.true, false: classify.false } }) } };
}

/**
 * When a rule's tasks are finished. Any one that holds marks an open task
 * done, with a line in its thread:
 *
 * - `when`: the task's latest event matches these conditions (a ticket's
 *   `payload.status_category: ["Done"]`). Checked as each event comes in, even
 *   an event the rule no longer matches (a rule that skips resolved tickets).
 * - `after`: an event field holding a time (ISO 8601, Unix seconds, or a
 *   calendar `{dateTime}` / `{date}`), like a meeting's `payload.end`; done
 *   once it has passed by `grace_hours` (default 0). Checked by the sweep.
 * - `idle_days`: nothing new on the task (no event, no activity) for this many days. Checked by the sweep.
 * - `by_owner`: someone on the team did the work: an event of the task's group
 *   whose `actor` is the person whose source sent it (their reply in the
 *   thread, mail they sent). Checked as each event comes in. They become the
 *   task's owner, and agents on it are taken off.
 *
 * Tasks still asking the team about a recurring series are left open.
 */
export type DoneWhen = Readonly<{
  when?: Readonly<Record<string, Condition>>;
  after?: string;
  grace_hours?: number;
  idle_days?: number;
  by_owner?: boolean;
  /** What the thread is told; `{field}` takes an event field. A default says why. */
  note?: string;
}>;

export type AccountRule = Readonly<{
  /** The account's name, as tasks show it. */
  name: string;
  /** The Buzz channel tasks for it are posted in. */
  channel?: string;
  /** Field → condition that says an event is about this account (when the event doesn't name one). */
  when?: Readonly<Record<string, Condition>>;
  /** The email domains of the account's people: an event's actor or a meeting's (real) attendees at one of them make it about this account. */
  domains?: readonly string[];
  /** Other names sources use for it. */
  aliases?: readonly string[];
  /** Its ids in other systems, by kind (`{"crm": ["0016100000AbCdE"]}`): events whose `account` is one match it, and pollers fill them into queries (see AccountIds). */
  ids?: AccountIds;
  /** The team's preferences, as they wrote them (see parsePreferences). */
  preferences?: string;
}>;

/** A source people can turn on, as the Settings card lists it. */
export type SourceInfo = Readonly<{
  name: string;
  label: string;
  /** The system.ai MCP service it reads (gmail for gmail), for the sign-in check. */
  service?: string;
  /** A table it reads; it shows as unavailable where the table isn't. */
  table?: string;
  description?: string;
}>;

export const DEFAULT_SOURCES: readonly SourceInfo[] = [
  { name: "gmail", label: "Gmail", service: "gmail", description: "Mail in your inbox." },
  { name: "gmail.sent", label: "Gmail (sent)", service: "gmail", description: "Mail you sent, so a reply you send in a task's thread closes it." },
  { name: "google_calendar", label: "Google Calendar", service: "google_calendar", description: "Your meetings in the next week." },
  { name: "google_drive", label: "Google Drive", service: "google_drive", description: "Docs changed recently." },
  { name: "jira", label: "Jira", service: "atlassian", description: "Issues you're assigned, reported or watching." },
  { name: "slack", label: "Slack", service: "slack", description: "Messages that mention you." },
  { name: "slack.sent", label: "Slack (sent)", service: "slack", description: "Messages you sent, so a reply you send in a task's thread closes it." },
];

export type SignalsConfig = Readonly<{
  version: 1;
  /** The sources people can turn on (DEFAULT_SOURCES when omitted). */
  sources?: readonly SourceInfo[];
  /** On a source's first post for a person, record what's already there without opening tasks (default true). */
  first_run_seen?: boolean;
  rules: readonly Rule[];
  accounts?: readonly AccountRule[];
  /** Channel for tasks with no account channel. */
  default_channel?: string;
  /** What this deployment calls things (see Labels); generic words when omitted. */
  labels?: Labels;
  /** Any rule's open tasks are done after this many days with nothing new, unless its done_when says idle_days. Off when omitted. */
  done_idle_days?: number;
}>;

/**
 * What a deployment calls things, so each organization uses its own words:
 * `customer` for the people at an account (say "client"), and `parties` for
 * who a task from outside sits with on the tasks board, by id (a rule's
 * `party`), like `{ "support": "Support" }`.
 */
export type Labels = Readonly<{ customer?: string; parties?: Readonly<Record<string, string>> }>;

/** The parties every deployment has; `labels.parties` renames them or adds more. */
export const DEFAULT_PARTIES: Readonly<Record<string, string>> = { engineering: "Engineering", support: "Support" };

export type ResolvedLabels = Readonly<{ customer: string; parties: Readonly<Record<string, string>> }>;

/** The config's labels with the defaults filled in. */
export function labelsOf(config: SignalsConfig | undefined): ResolvedLabels {
  const customer = config?.labels?.customer?.trim().toLowerCase() || "customer";
  return { customer, parties: { ...DEFAULT_PARTIES, ...(config?.labels?.parties ?? {}) } };
}

/** "customer" → "Customer". */
export const capitalized = (word: string) => word.charAt(0).toUpperCase() + word.slice(1);

/** The party a task from this rule sits with: the rule's `party`, or none. Parties are never guessed from the source. */
export function partyFor(rule: Pick<Rule, "party"> | undefined): string | undefined {
  return rule?.party || undefined;
}

export const EMPTY_CONFIG: SignalsConfig = { version: 1, first_run_seen: true, rules: [] };

/** Checks a config; returns the problems, or none. */
export function configProblems(raw: unknown): string[] {
  const problems: string[] = [];
  if (!raw || typeof raw !== "object") return ["the config is a JSON object"];
  const config = raw as Record<string, unknown>;
  if (config.version !== 1) problems.push("version must be 1");
  if (!Array.isArray(config.rules)) return [...problems, "rules must be a list"];
  const ids = new Set<string>();
  for (const [n, rule] of (config.rules as Record<string, unknown>[]).entries()) {
    const where = `rules[${n}]`;
    if (!rule || typeof rule !== "object") {
      problems.push(`${where} is an object`);
      continue;
    }
    if (typeof rule.id !== "string" || !rule.id) problems.push(`${where}.id is required`);
    else if (ids.has(rule.id)) problems.push(`${where}.id ${rule.id} is used twice`);
    else ids.add(rule.id);
    if (!["task", "update", "ignore"].includes(rule.action as string)) problems.push(`${where}.action must be task, update or ignore`);
    for (const key of ["when", "unless"] as const) {
      const conditions = rule[key];
      if (conditions === undefined) continue;
      if (!conditions || typeof conditions !== "object" || Array.isArray(conditions)) problems.push(`${where}.${key} is an object`);
      else
        for (const [field, condition] of Object.entries(conditions)) {
          if (typeof condition === "string") {
            try {
              new RegExp(condition, "i");
            } catch {
              problems.push(`${where}.${key}.${field} isn't a valid regular expression`);
            }
          } else if (!Array.isArray(condition)) problems.push(`${where}.${key}.${field} is a pattern or a list of values`);
        }
    }
    for (const key of ["customer_attendees", "customer_actor"] as const) {
      const value = rule[key];
      if (value === undefined || value === true) continue;
      if (typeof value !== "string" || !value) problems.push(`${where}.${key} is true (any account's domains) or a pattern for the customer's email addresses`);
      else
        try {
          new RegExp(value, "i");
        } catch {
          problems.push(`${where}.${key} isn't a valid regular expression`);
        }
    }
    if (rule.account_named_in !== undefined && (typeof rule.account_named_in !== "string" || !rule.account_named_in)) problems.push(`${where}.account_named_in is a field, like payload.channel`);
    if (rule.skip_own !== undefined && typeof rule.skip_own !== "boolean") problems.push(`${where}.skip_own is true or false`);
    if (rule.known_account !== undefined && typeof rule.known_account !== "boolean") problems.push(`${where}.known_account is true or false`);
    if (rule.group_by !== undefined && (typeof rule.group_by !== "string" || !rule.group_by)) problems.push(`${where}.group_by is a field or a {field} template`);
    if (rule.series !== undefined && (typeof rule.series !== "string" || !rule.series)) problems.push(`${where}.series is a field or a {field} template`);
    if (rule.same_as !== undefined && (typeof rule.same_as !== "string" || !/\{[a-z_][a-z0-9_.]*\}/i.test(rule.same_as))) problems.push(`${where}.same_as is a {field} template, like {actor}|{title}|{occurred_at}`);
    if (rule.stale_after_hours !== undefined && !(typeof rule.stale_after_hours === "number" && rule.stale_after_hours > 0)) problems.push(`${where}.stale_after_hours must be a positive number`);
    if (rule.done_when !== undefined) problems.push(...doneWhenProblems(rule.done_when, `${where}.done_when`));
    if (rule.action_items !== undefined) {
      const a = rule.action_items as Record<string, unknown>;
      if (!a || typeof a !== "object" || Array.isArray(a) || Object.keys(a).some((key) => key !== "workstream" && key !== "meetings") || [a.workstream, a.meetings].some((value) => value !== undefined && (typeof value !== "string" || !value.trim())))
        problems.push(`${where}.action_items is {workstream?, meetings?}, like {"workstream": "meeting action items"}`);
      else if (rule.action !== "task") problems.push(`${where}.action_items needs action task`);
    }
    if (rule.watch !== undefined && !(Array.isArray(rule.watch) && rule.watch.length && rule.watch.length <= 20 && rule.watch.every((item) => typeof item === "string" && item))) problems.push(`${where}.watch is a list of up to 20 event fields, like payload.status`);
    if (rule.classify !== undefined) {
      const c = rule.classify as Record<string, unknown>;
      if (!c || typeof c !== "object" || Array.isArray(c) || typeof c.question !== "string" || !c.question.trim()) problems.push(`${where}.classify is {question, true?, false?, min?}`);
      else {
        if ((c.true === undefined) !== (c.false === undefined) || (c.true !== undefined && (typeof c.true !== "string" || typeof c.false !== "string"))) problems.push(`${where}.classify.true and .false go together, as text`);
        if (c.min !== undefined && !(typeof c.min === "number" && c.min > 0 && c.min < 1)) problems.push(`${where}.classify.min is a number between 0 and 1`);
        if (rule.action !== "task") problems.push(`${where}.classify needs action task`);
      }
    }
  }
  if (config.sources !== undefined && (!Array.isArray(config.sources) || (config.sources as Record<string, unknown>[]).some((source) => !source || typeof source.name !== "string" || typeof source.label !== "string")))
    problems.push("sources is a list of {name, label}");
  const parties = { ...DEFAULT_PARTIES };
  if (config.labels !== undefined) {
    const labels = config.labels as Record<string, unknown>;
    if (!labels || typeof labels !== "object" || Array.isArray(labels)) problems.push("labels is an object");
    else {
      if (labels.customer !== undefined && (typeof labels.customer !== "string" || !labels.customer.trim())) problems.push("labels.customer is a word, like client");
      if (labels.parties !== undefined) {
        if (!labels.parties || typeof labels.parties !== "object" || Array.isArray(labels.parties)) problems.push("labels.parties is an object of key → name");
        else
          for (const [key, name] of Object.entries(labels.parties as Record<string, unknown>)) {
            if (typeof name !== "string" || !name.trim()) problems.push(`labels.parties.${key} is a name`);
            else parties[key as keyof typeof parties] = name;
          }
      }
    }
  }
  for (const [n, rule] of (config.rules as Record<string, unknown>[]).entries())
    if (rule && typeof rule === "object" && rule.party !== undefined && (typeof rule.party !== "string" || !(rule.party in parties)))
      problems.push(`rules[${n}].party must be one of ${Object.keys(parties).join(", ")} (or a key you add in labels.parties)`);
  if (config.done_idle_days !== undefined && !(typeof config.done_idle_days === "number" && config.done_idle_days > 0)) problems.push("done_idle_days must be a positive number");
  if (config.accounts !== undefined && !Array.isArray(config.accounts)) problems.push("accounts must be a list");
  for (const [n, account] of ((config.accounts as Record<string, unknown>[] | undefined) ?? []).entries()) {
    if (!account || typeof account.name !== "string" || !account.name) problems.push(`accounts[${n}].name is required`);
    else if (account.domains !== undefined && (!Array.isArray(account.domains) || account.domains.some((domain) => typeof domain !== "string" || !validDomain(domain.toLowerCase())))) problems.push(`accounts[${n}].domains is a list of email domains, like example.com`);
    else if (account.ids !== undefined) {
      const read = readIds(account.ids);
      if (typeof read === "string") problems.push(`accounts[${n}].ids: ${read}`);
    }
  }
  return problems;
}

function doneWhenProblems(raw: unknown, where: string): string[] {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return [`${where} is an object with when, after, idle_days or by_owner`];
  const done = raw as Record<string, unknown>;
  const problems: string[] = [];
  if (done.when === undefined && done.after === undefined && done.idle_days === undefined && done.by_owner === undefined) problems.push(`${where} needs when, after, idle_days or by_owner`);
  if (done.by_owner !== undefined && typeof done.by_owner !== "boolean") problems.push(`${where}.by_owner is true or false`);
  if (done.when !== undefined) {
    if (!done.when || typeof done.when !== "object" || Array.isArray(done.when)) problems.push(`${where}.when is an object`);
    else
      for (const [path, condition] of Object.entries(done.when)) {
        if (typeof condition === "string") {
          try {
            new RegExp(condition, "i");
          } catch {
            problems.push(`${where}.when.${path} isn't a valid regular expression`);
          }
        } else if (!Array.isArray(condition)) problems.push(`${where}.when.${path} is a pattern or a list of values`);
      }
  }
  if (done.after !== undefined && (typeof done.after !== "string" || !done.after)) problems.push(`${where}.after is an event field holding a time, like payload.end`);
  for (const key of ["grace_hours", "idle_days"] as const)
    if (done[key] !== undefined && !(typeof done[key] === "number" && (done[key] as number) >= 0 && (key === "grace_hours" || (done[key] as number) > 0))) problems.push(`${where}.${key} must be a ${key === "idle_days" ? "positive" : "non-negative"} number`);
  if (done.note !== undefined && (typeof done.note !== "string" || !done.note.trim())) problems.push(`${where}.note is text`);
  return problems;
}

/**
 * A time in an event field, in Unix seconds: ISO 8601, Unix seconds or
 * milliseconds, or a calendar time object (`{dateTime}`, or `{date}` for an
 * all-day event). Undefined when there's none.
 */
export function timeOf(value: unknown): number | undefined {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const object = value as { dateTime?: unknown; date?: unknown };
    return timeOf(object.dateTime ?? object.date);
  }
  if (typeof value !== "string" && typeof value !== "number") return undefined;
  if (typeof value === "string" && !value.trim()) return undefined;
  const seconds = toSeconds(value);
  return Number.isNaN(seconds) ? undefined : seconds;
}

/**
 * Why a task is finished, by its rule's `done_when` and its latest event, or
 * undefined. `sweep` also checks the times (`after`, `idle_days`); without it
 * only `when` is checked, as an event comes in. `lastActive` is when anything
 * last happened on the task (Unix seconds).
 */
export function doneReason(done: DoneWhen | undefined, event: EventInput | undefined, options: Readonly<{ at: number; sweep: boolean; lastActive?: number }>): string | undefined {
  if (!done) return undefined;
  const say = (fallback: string) => (done.note && event ? fill(done.note, event) : fallback);
  if (done.when && Object.keys(done.when).length && event && matches(done.when, event)) return say("its latest update says it's finished");
  if (!options.sweep) return undefined;
  if (done.after && event) {
    const time = timeOf(field(event, done.after));
    if (time !== undefined && time + (done.grace_hours ?? 0) * 3600 <= options.at) return say(`it ended ${new Date(time * 1000).toISOString().slice(0, 16).replace("T", " ")} UTC`);
  }
  if (done.idle_days && options.lastActive !== undefined && options.lastActive + done.idle_days * 86400 <= options.at) return say(`nothing new in ${done.idle_days} days`);
  return undefined;
}

/**
 * The tasks an event finishes: for each rule with `done_when.when` that the
 * event matches (and whose sources it's from), that rule's group for it. The
 * rule itself needn't match the event, so a rule that skips resolved tickets
 * still hears that its ticket was resolved.
 */
export function finishes(config: SignalsConfig, event: EventInput): { rule: Rule; group: string }[] {
  return config.rules.flatMap((rule) =>
    rule.action === "task" && rule.done_when?.when && Object.keys(rule.done_when.when).length && sourceMatches(rule.sources, event.source) && matches(rule.done_when.when, event) ? [{ rule, group: groupKey(rule, event) }] : [],
  );
}

/**
 * The tasks an event shows someone on the team handled: for each rule with
 * `done_when.by_owner` (and whose sources it's from), when the event's actor
 * is `owner`, the person whose source sent it, that rule's group for it. The
 * rule itself needn't match (it may skip your own messages).
 */
export function handledBy(config: SignalsConfig, event: EventInput, owner: string | undefined): { rule: Rule; group: string }[] {
  if (!owner || emailOf(event.actor) !== owner.toLowerCase()) return [];
  return config.rules.flatMap((rule) => (rule.action === "task" && rule.done_when?.by_owner && sourceMatches(rule.sources, event.source) ? [{ rule, group: groupKey(rule, event) }] : []));
}

/**
 * A Slack thread's key, `C123:1795000000.123456` (its channel and root
 * message's full ts), from a message's permalink: a reply's carries the root
 * as `thread_ts=`, a root's is its own `/p…`. As the example Slack sources key
 * threads. Undefined for anything else.
 */
export function slackThreadKey(permalink: string | null | undefined): string | undefined {
  if (!permalink) return undefined;
  const reply = /\/archives\/([A-Z0-9]+)\/p\d+\?(?:[^\s)#]*&)?thread_ts=(\d+)\.(\d+)/i.exec(permalink);
  if (reply) return `${reply[1]}:${reply[2]}.${reply[3]}`;
  const root = /\/archives\/([A-Z0-9]+)\/p(\d{10})(\d{6})(?![\d])/i.exec(permalink);
  return root ? `${root[1]}:${root[2]}.${root[3]}` : undefined;
}

/** A rule's done_when with the config's done_idle_days filled in. */
export function doneWhenOf(config: SignalsConfig, rule: Rule): DoneWhen | undefined {
  if (!config.done_idle_days || rule.done_when?.idle_days) return rule.done_when;
  return { ...rule.done_when, idle_days: config.done_idle_days };
}

/**
 * Slack's markup as people read it, for display: `<@U123|Ann Lee>` → `@Ann
 * Lee` (a bare `<@U123>` → `@U123`), `<#C123|general>` → `#general`,
 * `<!here>` → `@here`, `<!subteam^S1|@eng>` → `@eng`, and links
 * `<https://x|label>` → `[label](https://x)`, `<https://x>` → the URL. Other
 * angle brackets (an email address) are left alone. Rules still see the raw text.
 */
export function plainSlack(text: string): string;
export function plainSlack(text: string | null): string | null;
export function plainSlack(text: string | null): string | null {
  if (!text || !text.includes("<")) return text;
  return text
    .replace(/<@([A-Z0-9]+)(?:\|([^>]+))?>/g, (_, id: string, name?: string) => `@${name?.trim() || id}`)
    .replace(/<#([A-Z0-9]+)(?:\|([^>]*))?>/g, (_, id: string, name?: string) => `#${name?.trim() || id}`)
    .replace(/<!subteam\^[A-Z0-9]+(?:\|([^>]+))?>/g, (_, name?: string) => (name?.trim() ? (name.trim().startsWith("@") ? name.trim() : `@${name.trim()}`) : "@team"))
    .replace(/<!(here|channel|everyone)(?:\|[^>]*)?>/g, "@$1")
    .replace(/<(https?:\/\/[^|>\s]+)\|([^>]+)>/g, "[$2]($1)")
    .replace(/<(https?:\/\/[^|>\s]+)>/g, "$1");
}

/** An event field: `title`, `payload.status`, `payload.case.owner`. */
export function field(event: EventInput, path: string): unknown {
  const [head, ...rest] = path.split(".");
  let value: unknown = head === "payload" ? event.payload : (event as Record<string, unknown>)[head!];
  for (const part of head === "payload" ? rest : rest) {
    if (value === null || typeof value !== "object") return undefined;
    value = (value as Record<string, unknown>)[part];
  }
  return value;
}

const regexes = new Map<string, RegExp>();
function holds(condition: Condition, value: unknown): boolean {
  if (Array.isArray(condition)) return condition.some((option) => String(option) === String(value ?? ""));
  if (value === undefined || value === null) return false;
  let regex = regexes.get(condition as string);
  if (!regex) regexes.set(condition as string, (regex = new RegExp(condition as string, "i")));
  return regex.test(typeof value === "object" ? JSON.stringify(value) : String(value));
}

export function matches(conditions: Readonly<Record<string, Condition>> | undefined, event: EventInput): boolean {
  return Object.entries(conditions ?? {}).every(([path, condition]) => holds(condition, field(event, path)));
}

const sourceMatches = (patterns: readonly string[] | undefined, source: string) =>
  !patterns?.length || patterns.some((pattern) => (pattern.endsWith("*") ? source.startsWith(pattern.slice(0, -1)) : pattern === source));

/**
 * The first rule that applies to an event, in config order. `owner` is whose
 * source sent it (their email), for `skip_own`.
 */
export function ruleFor(config: SignalsConfig, event: EventInput, owner?: string): Rule | undefined {
  return config.rules.find((rule) => ruleApplies(config, rule, event, owner));
}

/** Whether one rule applies to an event (as ruleFor checks each, in order). */
export function ruleApplies(config: SignalsConfig, rule: Rule, event: EventInput, owner?: string): boolean {
  return (
      sourceMatches(rule.sources, event.source) &&
      matches(rule.when, event) &&
      !(rule.unless && Object.keys(rule.unless).length && matchesAny(rule.unless, event)) &&
      !(rule.skip_own && owner && emailOf(event.actor) === owner.toLowerCase()) &&
      aboutCustomer(config, rule, event) &&
      (!rule.known_account || knownAccount(config, event, rule))
  );
}

/** Whether the account an event is about (for the rule) is one the config has, not just a name the event gives. */
function knownAccount(config: SignalsConfig, event: EventInput, rule: Rule): boolean {
  const account = accountFor(config, event, rule);
  return Boolean(account && (config.accounts ?? []).includes(account));
}

/** A rule's customer conditions: with any of them, at least one must hold (they're all ways to say the event is about a customer). */
function aboutCustomer(config: SignalsConfig, rule: Rule, event: EventInput): boolean {
  const { customer_actor: actor, customer_attendees: attendees, account_named_in: named } = rule;
  if (actor === undefined && attendees === undefined && named === undefined) return true;
  const accounts = config.accounts ?? [];
  if (actor === true ? Boolean(byActor(accounts, event)) : actor !== undefined && Boolean(emailOf(event.actor) && regexFor(actor).test(emailOf(event.actor)!))) return true;
  if (attendees === true ? Boolean(byAttendees(accounts, event)) : attendees !== undefined && realCustomers(field(event, "payload.attendees"), (email) => regexFor(attendees).test(email)).length > 0) return true;
  return named !== undefined && Boolean(byName(accounts, field(event, named)));
}

function regexFor(pattern: string): RegExp {
  let regex = regexes.get(pattern);
  if (!regex) regexes.set(pattern, (regex = new RegExp(pattern, "i")));
  return regex;
}

/** The email address in an actor (`Ann Lee <ann@globex.io>` or `ann@globex.io`), lowercased. */
export function emailOf(actor: unknown): string | undefined {
  if (typeof actor !== "string") return undefined;
  const found = /<?([^\s<>"]+@[^\s<>"]+\.[^\s<>"]+)>?\s*$/.exec(actor.trim());
  return found?.[1]!.toLowerCase();
}

/** True when an email address is at one of these domains (or a subdomain of one). */
export const atDomains = (email: string, domains: readonly string[]) => domains.some((domain) => email.endsWith(`@${domain.toLowerCase()}`) || email.endsWith(`.${domain.toLowerCase()}`));

/** The account whose domains the event's actor is at. */
function byActor(accounts: readonly AccountRule[], event: EventInput): AccountRule | undefined {
  const email = emailOf(event.actor);
  return email ? accounts.find((account) => account.domains?.length && atDomains(email, account.domains)) : undefined;
}

/** The account with the most real customers among a meeting's attendees (colleagues' customer-domain addresses don't count). */
function byAttendees(accounts: readonly AccountRule[], event: EventInput): AccountRule | undefined {
  const attendees = field(event, "payload.attendees");
  if (!attendeesOf(attendees).length) return undefined;
  let best: { account: AccountRule; count: number } | undefined;
  for (const account of accounts) {
    if (!account.domains?.length) continue;
    const count = realCustomers(attendees, (email) => atDomains(email.toLowerCase(), account.domains!)).length;
    if (count && (!best || count > best.count)) best = { account, count };
  }
  return best?.account;
}

const words = (text: string) => text.toLowerCase().normalize("NFKD").split(/[^\p{L}\p{N}]+/u).filter(Boolean);

/** The account whose name or one of its other names appears in a field's text as whole words (the longest name wins). */
function byName(accounts: readonly AccountRule[], value: unknown): AccountRule | undefined {
  if (typeof value !== "string" || !value.trim()) return undefined;
  const text = ` ${words(value).join(" ")} `;
  let best: { account: AccountRule; length: number } | undefined;
  for (const account of accounts)
    for (const name of [account.name, ...(account.aliases ?? [])]) {
      const spelled = words(name).join(" ");
      if (spelled && text.includes(` ${spelled} `) && (!best || spelled.length > best.length)) best = { account, length: spelled.length };
    }
  return best?.account;
}

/** True when any one of the conditions holds (so `unless` excludes on any match). */
function matchesAny(conditions: Readonly<Record<string, Condition>>, event: EventInput): boolean {
  return Object.entries(conditions).some(([path, condition]) => holds(condition, field(event, path)));
}

/** `{field}` replaced with the event's field. */
export function fill(template: string, event: EventInput): string {
  return template.replace(/\{([a-z_][a-z0-9_.]*)\}/gi, (_, path: string) => {
    const value = field(event, path);
    return value === undefined || value === null ? "" : typeof value === "object" ? JSON.stringify(value) : String(value);
  });
}

/**
 * The account an event is about: the rule's, the event's (by name, alias or id),
 * then the account whose domains the actor is at, the first whose `when`
 * holds, the one with the meeting's real customers among its attendees, and
 * (with the rule's `account_named_in`) the one that field names.
 */
export function accountFor(config: SignalsConfig, event: EventInput, rule?: Rule): AccountRule | undefined {
  const named = rule?.account ? fill(rule.account, event).trim() : event.account;
  const accounts = config.accounts ?? [];
  if (named) {
    const lower = named.toLowerCase();
    return accounts.find((account) => namesAccount(account, lower)) ?? { name: named };
  }
  return (
    byActor(accounts, event) ??
    accounts.find((account) => account.when && Object.keys(account.when).length && matches(account.when, event)) ??
    byAttendees(accounts, event) ??
    (rule?.account_named_in ? byName(accounts, field(event, rule.account_named_in)) : undefined)
  );
}

/** A group_by template filled in, or undefined when every field it names is empty. */
function fillGroup(template: string, event: EventInput): string | undefined {
  let any = false;
  const filled = template.replace(/\{([a-z_][a-z0-9_.]*)\}/gi, (_, path: string) => {
    const value = field(event, path);
    if (value === undefined || value === null || value === "") return "";
    any = true;
    return typeof value === "object" ? JSON.stringify(value) : String(value).trim().toLowerCase();
  });
  return any ? filled : undefined;
}

/**
 * An event's copy key for a rule with `same_as`: the rule's group and the
 * template filled in. Undefined without `same_as`, or when a field it names
 * is empty (a half-filled key would join unrelated things).
 */
export function sameKey(rule: Rule, event: EventInput): string | undefined {
  if (!rule.same_as) return undefined;
  let missing = false;
  const filled = rule.same_as.replace(/\{([a-z_][a-z0-9_.]*)\}/gi, (_, path: string) => {
    const value = field(event, path);
    if (value === undefined || value === null || value === "") missing = true;
    return typeof value === "object" ? JSON.stringify(value) : String(value ?? "").trim().toLowerCase();
  });
  return missing ? undefined : `${rule.group ?? rule.id}|${filled}`;
}

/** Which task an event belongs to, for a rule. */
export function groupKey(rule: Rule, event: EventInput): string {
  const by = !rule.group_by ? event.group_key : rule.group_by.includes("{") ? fillGroup(rule.group_by, event) : field(event, rule.group_by);
  const group = by === undefined || by === null || by === "" ? `${event.source}:${event.external_id}` : String(by);
  return `${rule.group ?? rule.id}|${group}`;
}

/**
 * The recurring series an event is part of, for a rule with `series`: the
 * rule's group, the account and the series id, so a team's answer holds for
 * that series in that account. Undefined without one.
 */
export function seriesKey(rule: Rule, event: EventInput, account?: Pick<AccountRule, "name">): string | undefined {
  if (!rule.series) return undefined;
  const value = rule.series.includes("{") ? fillGroup(rule.series, event) : field(event, rule.series);
  if (value === undefined || value === null || value === "") return undefined;
  return `${rule.group ?? rule.id}|${(account?.name ?? "").toLowerCase()}|${typeof value === "object" ? JSON.stringify(value) : String(value).trim()}`;
}

/** How a team answers a new recurring series' question; Always and Never are kept for the series. */
export const SERIES_OPTIONS = ["Always", "Just this one", "Never"] as const;
export type SeriesAnswer = "always" | "once" | "never";
/** Who asks a series' question (a task's asked_by). */
export const SERIES_ASKER = "signals";

/** An answer to a series' question as its choice, or undefined when it isn't one. */
export function seriesAnswer(text: string): SeriesAnswer | undefined {
  const lower = text.trim().toLowerCase().replace(/[.!]+$/, "");
  if (lower === "always") return "always";
  if (lower === "never") return "never";
  if (lower === "just this one" || lower === "just this once" || lower === "once" || lower === "this one") return "once";
  return undefined;
}

/** The question a new recurring series' first task asks. */
export const seriesQuestion = (title: string) => `"${title}" is part of a recurring series. Should agents work on its events from now on?`;

export type Decision =
  | Readonly<{ kind: "none"; reason: string }>
  | Readonly<{ kind: "task"; rule: Rule; group: string; title: string; account?: AccountRule; channel?: string; create: boolean; mode: Mode; series?: string; same?: string }>;

/**
 * What to do with an event that is new or changed. `firstRun` is a source's
 * first post for this person: it only records what's there. Rules decide the
 * rest: `task` opens or updates the group's task, `update` only updates one.
 */
export function decide(config: SignalsConfig, event: EventInput, options: Readonly<{ firstRun: boolean; owner?: string }>): Decision {
  const rule = ruleFor(config, event, options.owner);
  if (!rule) return { kind: "none", reason: "no rule matches" };
  if (rule.action === "ignore") return { kind: "none", reason: `rule ${rule.id} ignores it` };
  const account = accountFor(config, event, rule);
  const channel = account?.channel ?? config.default_channel;
  const group = groupKey(rule, event);
  const title = (rule.title ? fill(rule.title, event) : event.title || `${event.source} ${event.external_id}`).trim().slice(0, 500);
  const mode = modeFor(account?.preferences, rule);
  // On a first run, existing things are seen; only updates to tasks that already exist go through.
  // A team that turned a kind of work off still gets updates on tasks already open.
  const create = rule.action === "task" && mode !== "off" && !(options.firstRun && config.first_run_seen !== false);
  const series = seriesKey(rule, event, account);
  const same = sameKey(rule, event);
  return { kind: "task", rule, group, title, ...(account && { account }), ...(channel && { channel }), create, mode, ...(series && { series }), ...(same && { same }) };
}

// ---------------------------------------------------------------------------
// Team preferences

/**
 * How agents handle a kind of work: `auto` (do it and say so), `draft`
 * (prepare it for a person to send), `ask` (ask before doing anything), or
 * `off` (don't open tasks for it).
 */
export const MODES = ["auto", "draft", "ask", "off"] as const;
export type Mode = (typeof MODES)[number];
export const DEFAULT_MODE: Mode = "draft";

export type Preferences = Readonly<{
  /** Lowercased workstream or rule id (or `everything`) → mode. */
  modes: Readonly<Record<string, Mode>>;
  /** Everything else the team wrote: guidance for agents, word for word. */
  guidance: string;
  /** Lines that look like a mode setting but aren't one. */
  problems: readonly string[];
}>;

const MODE_LINE = /^\s*(?:[-*]\s*)?([^:#]{1,80}?)\s*:\s*(\S+)\s*$/;

/**
 * Reads a team's preferences. A line `<workstream or rule id>: <mode>`
 * (optionally a list item) sets a mode; `everything: <mode>` sets the
 * default. Every other line is guidance for agents.
 *
 *     - meeting prep: auto
 *     - tickets: off
 *     Keep replies to customers short, and cc the account owner.
 */
export function parsePreferences(text: string | undefined): Preferences {
  const modes: Record<string, Mode> = {};
  const guidance: string[] = [];
  const problems: string[] = [];
  for (const line of (text ?? "").split(/\r?\n/)) {
    const found = MODE_LINE.exec(line);
    const value = found?.[2]!.toLowerCase().replace(/[.,;]$/, "");
    if (found && MODES.includes(value as Mode)) modes[found[1]!.trim().toLowerCase()] = value as Mode;
    else {
      if (found && /^(auto|draft|ask|off|on|manual|skip|none)\b/i.test(found[2]!)) problems.push(`"${line.trim()}": the mode is one of ${MODES.join(", ")}`);
      guidance.push(line);
    }
  }
  return { modes, guidance: guidance.join("\n").trim(), problems };
}

const parsed = new Map<string, Preferences>();
function preferencesOf(text: string | undefined): Preferences {
  const key = text ?? "";
  let found = parsed.get(key);
  if (!found) {
    if (parsed.size > 200) parsed.clear();
    parsed.set(key, (found = parsePreferences(key)));
  }
  return found;
}

/** A rule's mode under a team's preferences: its id, then its workstream, then `everything`. */
export function modeFor(preferences: string | undefined, rule: Pick<Rule, "id" | "workstream">): Mode {
  const { modes } = preferencesOf(preferences);
  return modes[rule.id.toLowerCase()] ?? (rule.workstream ? modes[rule.workstream.toLowerCase()] : undefined) ?? modes.everything ?? DEFAULT_MODE;
}

/** How many playbooks an account keeps, and how long each is. */
export const MAX_PLAYBOOKS = 30;
export const MAX_PLAYBOOK = 6000;

/**
 * The playbook for a task: the one named by its rule id, then by its
 * workstream (any case), as modes are found. Undefined when there's none.
 */
export function playbookFor(playbooks: Readonly<Record<string, string>> | undefined, task: Readonly<{ rule_id?: string; workstream?: string | null }>): { key: string; text: string } | undefined {
  const entries = Object.entries(playbooks ?? {}).filter(([, text]) => text.trim());
  for (const wanted of [task.rule_id, task.workstream ?? undefined]) {
    const lower = wanted?.trim().toLowerCase();
    const found = lower && entries.find(([key]) => key.trim().toLowerCase() === lower);
    if (found) return { key: found[0], text: found[1].trim() };
  }
  return undefined;
}

/**
 * The agents that work on a task: the ones the team named for its rule id,
 * then for its workstream (any case), as playbooks are found; otherwise the
 * account's agents.
 */
export function agentsFor(account: Pick<AccountRecord, "agents" | "workstream_agents">, task: Readonly<{ rule_id?: string; workstream?: string | null }>): readonly string[] {
  return agentListFor(account, task).agents;
}

/** Which of an account's agent lists a task goes to: a workstream's (or rule id's) by its key, or the account's (no key). */
export function agentListFor(account: Pick<AccountRecord, "agents" | "workstream_agents">, task: Readonly<{ rule_id?: string; workstream?: string | null }>): { key?: string; agents: readonly string[] } {
  const entries = Object.entries(account.workstream_agents ?? {}).filter(([, keys]) => keys.length);
  for (const wanted of [task.rule_id, task.workstream ?? undefined]) {
    const lower = wanted?.trim().toLowerCase();
    const found = lower && entries.find(([key]) => key.trim().toLowerCase() === lower);
    if (found) return { key: found[0], agents: found[1] };
  }
  return { agents: account.agents };
}

/** The workstreams a config's rules file tasks under, in rule order. */
export function workstreamsOf(config: SignalsConfig | undefined): string[] {
  return [...new Set((config?.rules ?? []).map((rule) => rule.workstream?.trim()).filter((name): name is string => Boolean(name)))];
}

/**
 * An account's ids in other systems, by kind: `{"crm": ["0016100000AbCdE"], "jira_customer": ["Example", "Example Co"]}`.
 * A kind is a lowercase name (letters, digits, `_`), and pollers fill each
 * kind's ids from every account into the queries that ask for it: `:crm` in
 * SQL (as bound parameters) and `{crm: <clause with {}>}` in a tool's args.
 */
export type AccountIds = Readonly<Record<string, readonly string[]>>;

const ID_KIND = /^[a-z][a-z0-9_]{0,39}$/;
export const MAX_ID_KINDS = 20;
export const MAX_IDS = 50;

/** Ids as given (a kind's ids as a list, or one comma-separated text), cleaned; or what's wrong with them. */
export function readIds(raw: unknown): AccountIds | string {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return 'ids maps a kind to its ids, like {"crm": ["0016100000AbCdE"]}';
  const out: Record<string, string[]> = {};
  for (const [given, value] of Object.entries(raw as Record<string, unknown>)) {
    const kind = given.trim().toLowerCase();
    if (!ID_KIND.test(kind) || kind === "since") return `${given} isn't a kind of id: use lowercase letters, digits and _ (not "since")`;
    const items = Array.isArray(value) ? value : typeof value === "string" ? value.split(/[,\n]/) : undefined;
    if (!items || items.some((item) => typeof item !== "string")) return `${kind} is a list of ids`;
    const ids = [...new Set((items as string[]).map((item) => item.trim()).filter(Boolean))];
    if (ids.some((id) => id.length > 200)) return `${kind} has an id longer than 200 characters`;
    if (ids.length > MAX_IDS) return `${kind} has more than ${MAX_IDS} ids`;
    if (ids.length) out[kind] = [...(out[kind] ?? []), ...ids.filter((id) => !out[kind]?.includes(id))];
  }
  if (Object.keys(out).length > MAX_ID_KINDS) return `at most ${MAX_ID_KINDS} kinds of ids`;
  return out;
}

/** True when the account's name, one of its other names or one of its ids is this (lowercase) text. */
export function namesAccount(account: Readonly<{ name: string; aliases?: readonly string[]; ids?: AccountIds }>, lower: string): boolean {
  return account.name.toLowerCase() === lower || Boolean(account.aliases?.some((alias) => alias.toLowerCase() === lower)) || Object.values(account.ids ?? {}).some((ids) => ids.some((id) => id.toLowerCase() === lower));
}

/** Every account's ids, by kind (each kind's ids once, sorted): what pollers fill into queries. */
export function idsByKind(accounts: readonly Readonly<{ ids?: AccountIds }>[]): Record<string, string[]> {
  const out: Record<string, Set<string>> = {};
  for (const account of accounts) for (const [kind, ids] of Object.entries(account.ids ?? {})) for (const id of ids) (out[kind] ??= new Set()).add(id);
  return Object.fromEntries(Object.entries(out).sort(([a], [b]) => a.localeCompare(b)).map(([kind, ids]) => [kind, [...ids].sort()]));
}

/** Every account's name and other names (each once, sorted): pollers read a notes doc only when its title names one. */
export function accountNames(accounts: readonly Readonly<{ name: string; aliases?: readonly string[] }>[]): string[] {
  return [...new Set(accounts.flatMap((account) => [account.name, ...(account.aliases ?? [])]).map((name) => name.trim()).filter(Boolean))].sort();
}

/**
 * Payload fields a source fills only when it could read the item's details (a notes doc's `notes` and `meeting`):
 * a later version of the same event without them keeps the earlier ones.
 */
export const KEPT_DETAILS = ["notes", "meeting"] as const;

/** What a team registers for its account channel (the hub's accounts table). */
export type AccountRecord = Readonly<{
  name: string;
  channel: string | null;
  aliases: readonly string[];
  /** Email domains of the customer's people, so their mail and meetings find the account. */
  domains: readonly string[];
  /** Its ids in other systems, by kind. */
  ids: AccountIds;
  preferences: string;
  /** What agents have learned about the account, its team and its people. */
  profile: string;
  /** Agents (hex pubkeys) woken on each new task here, to work on it in the team's mode. */
  agents: readonly string[];
  /** How the team likes each kind of work done: workstream (or rule id) → playbook text. */
  playbooks: Readonly<Record<string, string>>;
  /** Agents for one kind of work: workstream (or rule id) → hex pubkeys, in place of `agents` for its tasks. */
  workstream_agents: Readonly<Record<string, readonly string[]>>;
  updated_by: string | null;
  updated_at: number | null;
}>;

const DOMAIN = /^[a-z0-9-]+(\.[a-z0-9-]+)+$/;
export const validDomain = (domain: string) => DOMAIN.test(domain);

/** A registered account as a rule's account: its domains match an event's actor or attendees. */
export function accountRule(record: AccountRecord): AccountRule {
  const domains = record.domains.map((domain) => domain.toLowerCase()).filter(validDomain);
  return {
    name: record.name,
    ...(record.channel && { channel: record.channel }),
    ...(record.aliases.length && { aliases: record.aliases }),
    ...(domains.length && { domains }),
    ...(Object.keys(record.ids ?? {}).length && { ids: record.ids }),
    ...(record.preferences && { preferences: record.preferences }),
  };
}

/** The config with registered accounts first: they win over a config account with the same name. */
export function withAccounts(config: SignalsConfig, records: readonly AccountRecord[]): SignalsConfig {
  if (!records.length) return config;
  const names = new Set(records.map((record) => record.name.toLowerCase()));
  return { ...config, accounts: [...records.map(accountRule), ...(config.accounts ?? []).filter((account) => !names.has(account.name.toLowerCase()))] };
}

/** A task's state. */
export const TASK_STATUSES = ["open", "in_progress", "waiting", "done", "dismissed"] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];
export const isOpen = (status: string) => status !== "done" && status !== "dismissed";
