// Signals: the event model and the rules that turn events into tasks.
//
// Everything here is pure (no database, no network, no Node modules), so the
// hub, the plugin and the tests share it. A source (a poller, the plugin, an agent) sends
// events; the hub keeps one row per (owner, source, external_id), notices
// when an event's content changed, and runs the rules to decide whether it
// opens a task, updates one, or is only recorded.

import { realCustomers } from "./attendees";

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
   * A pattern for the customer's email addresses (`@(globex\\.io|globex\\.com)$`).
   * The rule applies only when `payload.attendees` has someone it matches who
   * isn't the same person as an attendee it doesn't match (see attendees.ts),
   * so a meeting of your own team that invites their customer-domain
   * addresses doesn't count.
   */
  customer_attendees?: string;
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
}>;

export type AccountRule = Readonly<{
  /** The account's name, as tasks show it. */
  name: string;
  /** The Buzz channel tasks for it are posted in. */
  channel?: string;
  /** Field → condition that says an event is about this account (when the event doesn't name one). */
  when?: Readonly<Record<string, Condition>>;
  /** Other names sources use for it. */
  aliases?: readonly string[];
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
  { name: "google_calendar", label: "Google Calendar", service: "google_calendar", description: "Your meetings in the next week." },
  { name: "google_drive", label: "Google Drive", service: "google_drive", description: "Docs changed recently." },
  { name: "jira", label: "Jira", service: "atlassian", description: "Issues you're assigned, reported or watching." },
  { name: "slack", label: "Slack", service: "slack", description: "Messages that mention you." },
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
    if (rule.customer_attendees !== undefined) {
      if (typeof rule.customer_attendees !== "string" || !rule.customer_attendees) problems.push(`${where}.customer_attendees is a pattern for the customer's email addresses`);
      else
        try {
          new RegExp(rule.customer_attendees, "i");
        } catch {
          problems.push(`${where}.customer_attendees isn't a valid regular expression`);
        }
    }
    if (rule.group_by !== undefined && (typeof rule.group_by !== "string" || !rule.group_by)) problems.push(`${where}.group_by is a field or a {field} template`);
    if (rule.series !== undefined && (typeof rule.series !== "string" || !rule.series)) problems.push(`${where}.series is a field or a {field} template`);
    if (rule.stale_after_hours !== undefined && !(typeof rule.stale_after_hours === "number" && rule.stale_after_hours > 0)) problems.push(`${where}.stale_after_hours must be a positive number`);
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
  if (config.accounts !== undefined && !Array.isArray(config.accounts)) problems.push("accounts must be a list");
  for (const [n, account] of ((config.accounts as Record<string, unknown>[] | undefined) ?? []).entries())
    if (!account || typeof account.name !== "string" || !account.name) problems.push(`accounts[${n}].name is required`);
  return problems;
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

/** The first rule that applies to an event, in config order. */
export function ruleFor(config: SignalsConfig, event: EventInput): Rule | undefined {
  return config.rules.find(
    (rule) =>
      sourceMatches(rule.sources, event.source) &&
      matches(rule.when, event) &&
      !(rule.unless && Object.keys(rule.unless).length && matchesAny(rule.unless, event)) &&
      (!rule.customer_attendees || hasCustomer(rule.customer_attendees, event)),
  );
}

function hasCustomer(pattern: string, event: EventInput): boolean {
  let regex = regexes.get(pattern);
  if (!regex) regexes.set(pattern, (regex = new RegExp(pattern, "i")));
  return realCustomers(field(event, "payload.attendees"), (email) => regex.test(email)).length > 0;
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

/** The account an event is about: the rule's, the event's (by name or alias), or the first account whose conditions hold. */
export function accountFor(config: SignalsConfig, event: EventInput, rule?: Rule): AccountRule | undefined {
  const named = rule?.account ? fill(rule.account, event).trim() : event.account;
  const accounts = config.accounts ?? [];
  if (named) {
    const lower = named.toLowerCase();
    return accounts.find((account) => account.name.toLowerCase() === lower || account.aliases?.some((alias) => alias.toLowerCase() === lower)) ?? { name: named };
  }
  return accounts.find((account) => account.when && Object.keys(account.when).length && matches(account.when, event));
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
  | Readonly<{ kind: "task"; rule: Rule; group: string; title: string; account?: AccountRule; channel?: string; create: boolean; mode: Mode; series?: string }>;

/**
 * What to do with an event that is new or changed. `firstRun` is a source's
 * first post for this person: it only records what's there. Rules decide the
 * rest: `task` opens or updates the group's task, `update` only updates one.
 */
export function decide(config: SignalsConfig, event: EventInput, options: Readonly<{ firstRun: boolean }>): Decision {
  const rule = ruleFor(config, event);
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
  return { kind: "task", rule, group, title, ...(account && { account }), ...(channel && { channel }), create, mode, ...(series && { series }) };
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

/** The workstreams a config's rules file tasks under, in rule order. */
export function workstreamsOf(config: SignalsConfig | undefined): string[] {
  return [...new Set((config?.rules ?? []).map((rule) => rule.workstream?.trim()).filter((name): name is string => Boolean(name)))];
}

/** What a team registers for its account channel (the hub's accounts table). */
export type AccountRecord = Readonly<{
  name: string;
  channel: string | null;
  aliases: readonly string[];
  /** Email domains of the customer's people, so their mail and meetings find the account. */
  domains: readonly string[];
  preferences: string;
  /** What agents have learned about the account, its team and its people. */
  profile: string;
  /** Agents (hex pubkeys) woken on each new task here, to work on it in the team's mode. */
  agents: readonly string[];
  /** How the team likes each kind of work done: workstream (or rule id) → playbook text. */
  playbooks: Readonly<Record<string, string>>;
  updated_by: string | null;
  updated_at: number | null;
}>;

const DOMAIN = /^[a-z0-9-]+(\.[a-z0-9-]+)+$/;
export const validDomain = (domain: string) => DOMAIN.test(domain);
const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** A registered account as a rule's account: its domains match an event's actor or attendees. */
export function accountRule(record: AccountRecord): AccountRule {
  const domains = record.domains.filter(validDomain);
  return {
    name: record.name,
    ...(record.channel && { channel: record.channel }),
    ...(record.aliases.length && { aliases: record.aliases }),
    ...(domains.length && { when: { actor: `@(${domains.map(escape).join("|")})>?$` } }),
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
