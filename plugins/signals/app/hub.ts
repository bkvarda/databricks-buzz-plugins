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
//   POST /api/account {name, rename?, channel?, aliases?, domains?, agents?, preferences?, profile?, delete?}
//   GET  /api/config | POST /api/config   the rules (posting needs the app's CAN_MANAGE: see below)
import { type AccountRecord, configProblems, DEFAULT_SOURCES, EMPTY_CONFIG, MAX_EVENTS_PER_POST, parsePreferences, type SignalsConfig, TASK_STATUSES, type TaskStatus, validDomain, validateEvent, withAccounts } from "./model";
import type { IngestResult, SignalsStore, Task } from "./store";
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
  opened(task: Task, agents?: readonly string[]): Promise<string | undefined>;
  /** Replies in the task's thread. */
  updated(task: Task, text: string): Promise<void>;
}>;

export type HubOptions = Readonly<{
  /** Who may change the rules (the app's owner, say). Everyone may when empty. */
  admins?: readonly string[];
  /** The config to use until one is saved (from SIGNALS_CONFIG). */
  defaultConfig?: SignalsConfig;
  log?(line: string): void;
}>;

const bad = (error: string, status = 400): HubResponse => ({ status, json: { error } });

/** Every path Hub.handle serves; the app routes exactly these to it. */
export const HUB_PATHS = ["/api/info", "/api/sources", "/api/cursor", "/api/events", "/api/tasks", "/api/task", "/api/accounts", "/api/account", "/api/config"] as const;

export class Hub {
  private cached?: { at: number; config: SignalsConfig };

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
    return config;
  }

  async handle(request: HubRequest): Promise<HubResponse> {
    const user = request.user?.toLowerCase();
    if (request.path === "/api/info") return { json: { kind: "signals-hub", version: 1, user: user ?? null } };
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
        case "GET /api/accounts":
          return { json: { accounts: await this.store.accounts() } };
        case "GET /api/account": {
          const account = await this.store.account({ ...(request.query.get("name") && { name: request.query.get("name")! }), ...(request.query.get("channel") && { channel: request.query.get("channel")! }) });
          return { json: { account: account ? withRead(account) : null } };
        }
        case "POST /api/account":
          return this.saveAccount(user, await body());
        case "GET /api/config":
          // The rules as saved; accounts teams set up are under /api/accounts.
          return { json: { config: (await this.store.config()) ?? this.options.defaultConfig ?? EMPTY_CONFIG, canEdit: this.isAdmin(user) } };
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
    const result = await this.store.ingest(user, events, await this.config());
    await this.announce(result);
    return {
      json: {
        received: raw.length,
        new: result.new,
        changed: result.changed,
        same: result.same,
        skipped: result.skipped,
        firstRun: result.firstRun,
        created: result.created.map((task) => task.id),
        updated: [...new Set(result.updated.map((update) => update.task.id))],
        errors: [...errors, ...result.errors],
      },
    };
  }

  /** Posts new tasks to Buzz and their updates in the task's thread. Failures leave the task for `retry`. */
  private async announce(result: IngestResult) {
    if (!this.notifier) return;
    for (const task of result.created) await this.post(task);
    const seen = new Set<number>();
    for (const update of result.updated) {
      if (!update.task.buzz_root || seen.has(update.task.id)) continue;
      seen.add(update.task.id);
      const text = `Update: ${update.url ? `[${update.title ?? "new event"}](${update.url})` : (update.title ?? "a new event")}`;
      await this.notifier.updated(update.task, text).catch((error: Error) => this.log(`couldn't post an update to task ${update.task.id}: ${error.message}`));
    }
  }

  private async post(task: Task) {
    if (!this.notifier || !task.channel || task.buzz_root) return;
    try {
      // The account's agents are asked to work on it, unless the team said ask (they wait for a person) or off.
      const account = task.account && (task.mode === "auto" || task.mode === "draft") ? await this.store.account({ name: task.account }) : undefined;
      const agents = account && account.channel === task.channel ? account.agents : [];
      const root = await this.notifier.opened(task, agents);
      if (root) await this.store.setBuzzRoot(task.id, root);
    } catch (error) {
      this.log(`couldn't post task ${task.id}: ${(error as Error).message}`);
    }
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
    const agents = list("agents", 10)?.map(agentKey);
    const notAgent = agents?.find((key) => !key);
    if (notAgent !== undefined) return bad("agents are Buzz pubkeys (64 hex characters or an npub).");
    const preferences = text("preferences", 8000);
    const profile = text("profile", 16000);
    const account = await this.store.saveAccount(
      name,
      {
        ...(typeof input.rename === "string" && { rename: input.rename }),
        ...(input.channel !== undefined && { channel: (input.channel as string | null) || null }),
        ...(aliases && { aliases }),
        ...(domains && { domains }),
        ...(agents && { agents: agents as string[] }),
        ...(preferences !== undefined && { preferences }),
        ...(profile !== undefined && { profile }),
      },
      user,
    );
    this.cached = undefined;
    this.log(`${user} saved the account ${account.name}`);
    return { json: { account: withRead(account) } };
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
    if (input.status !== undefined) {
      if (!TASK_STATUSES.includes(input.status as TaskStatus)) return bad(`status must be one of ${TASK_STATUSES.join(", ")}`);
      task = (await this.store.setStatus(id, input.status as TaskStatus, user, note))!;
    } else if (note) await this.store.activity(id, user, "note", note);
    const artifact = input.artifact as { url?: unknown; title?: unknown; kind?: unknown } | undefined;
    if (artifact) {
      if (typeof artifact.url !== "string" || !/^https?:\/\//.test(artifact.url)) return bad("artifact.url must be an http(s) link.");
      await this.store.artifact(id, user, typeof artifact.kind === "string" ? artifact.kind : "link", artifact.url, typeof artifact.title === "string" ? artifact.title : undefined);
    }
    if (this.notifier && task.buzz_root && (input.status !== undefined || artifact)) {
      const parts = [input.status !== undefined && `${user} set this to **${input.status}**${note ? `: ${note}` : ""}`, artifact && `${user} added [${(artifact.title as string) ?? artifact.url}](${artifact.url as string})`].filter(Boolean);
      await this.notifier.updated(task, parts.join("\n")).catch(() => {});
    }
    return { json: await this.store.detail(id) };
  }

  /**
   * Handles what poller jobs wrote to the inbox, in order, exactly as if they
   * had posted it to /api/events or /api/cursor: the owner is the Postgres
   * role that wrote the row. Run every half minute or so.
   */
  async drain(limit = 20): Promise<{ handled: number; failed: number }> {
    let handled = 0;
    let failed = 0;
    for (const post of await this.store.inbox(limit)) {
      const reply = await this.handle({ method: "POST", path: post.kind === "events" ? "/api/events" : "/api/cursor", query: new URLSearchParams(), user: post.owner, body: async () => JSON.stringify(post.body) });
      const status = reply.status ?? 200;
      if (status >= 400) {
        failed++;
        this.log(`inbox ${post.id} from ${post.owner} failed: ${(reply.json as { error?: string }).error ?? status}`);
      } else handled++;
      await this.store.inboxDone(post.id, { status, ...(reply.json as object) });
    }
    return { handled, failed };
  }

  /** Posts tasks that aren't in Buzz yet, and nudges stale ones. Run every few minutes. */
  async sweep(at?: number): Promise<{ posted: number; nudged: number }> {
    let posted = 0;
    let nudged = 0;
    if (this.notifier) {
      for (const task of await this.store.unposted()) {
        await this.post(task);
        if ((await this.store.task(task.id))?.buzz_root) posted++;
      }
    }
    for (const { task, text } of await this.store.stale(await this.config(), at)) {
      if (this.notifier && task.buzz_root) await this.notifier.updated(task, `⏰ ${text}`).catch(() => {});
      await this.store.nudged(task.id, text, at);
      nudged++;
    }
    return { posted, nudged };
  }
}

/** A task as its Buzz message shows it. */
/** An account as the API gives it: with its preferences read, so the UI and agents see what took. */
const withRead = (account: AccountRecord) => ({ ...account, read: parsePreferences(account.preferences) });

const MODE_TEXT = { auto: "Mode: auto (agents do it and report)", draft: "Mode: draft (agents prepare it; a person sends it)", ask: "Mode: ask (agents ask before doing anything)", off: "Mode: off" } as const;

/** What the account's agents are asked to do with a new task, by its mode. */
const AGENT_ASK = {
  auto: "please work on this now: call signals_account for this channel, follow the team's guidance, do the work, report it here and record it with signals_task_update.",
  draft: "please prepare this: call signals_account for this channel, follow the team's guidance, and post a draft here (a reply, a doc) for a person to send. Record it with signals_task_update; don't send anything yourself.",
} as const;

export function taskMessage(task: Task, detail?: { url?: string; agents?: readonly string[] }): string {
  const ask = detail?.agents?.length && (task.mode === "auto" || task.mode === "draft") ? `${detail.agents.map((key) => `nostr:${npub(key)}`).join(" ")} ${AGENT_ASK[task.mode]}` : "";
  return [
    `📌 **Task ${task.id}: ${task.title}**`,
    [task.account && `Account: ${task.account}`, task.workstream && `Workstream: ${task.workstream}`, task.initiative && `Initiative: ${task.initiative}`, `Rule: ${task.rule_id}`].filter(Boolean).join(" · "),
    MODE_TEXT[task.mode] ?? "",
    detail?.url ? `Source: ${detail.url}` : "",
    `Reply in this thread to work on it. Agents can update it with the signals_task tools.`,
    ask,
  ]
    .filter(Boolean)
    .join("\n");
}
