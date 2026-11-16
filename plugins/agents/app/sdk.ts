// buzz-app.mjs: Buzz for code running as a Databricks App. The app's Buzz
// identity is a Unity Catalog secret (named by BUZZ_IDENTITY_SECRET) that the
// Databricks Agents plugin made and that only the app's service principal can
// read. This library reads it as that principal, signs in to the community
// as the identity, keeps its profile up to date, and hands the app its
// mentions to answer. It also serves a status page on the app's port.
//
//   import { BuzzApp } from "./buzz-app.mjs";
//   const app = new BuzzApp();
//   app.onMention(async (mention, reply) => reply.say(`You said: ${mention.text}`));
//   app.start();
//
// Calls to Databricks from the app (`app.databricks.api(...)`) run as the
// app's service principal, so the app reaches only what that principal is
// granted, whoever mentions it.
import { createServer, type Server } from "node:http";
import { getPublicKey, type EventTemplate, type NostrEvent, verifyEvent } from "nostr-tools/pure";
import { CHAT_KINDS, channelKind, contextFilters, type Conversation, conversationOf, fromOwner, mentionsAgent, plainText, profileTemplate, replyTemplate, splitMessage } from "../runner/buzz";
import { type Filter, HttpRelay } from "../runner/http";
import { Typing } from "../runner/typing";
import { OutsiderNotes } from "../src/outsider";
import { activated, type AppIdentity, type Answers, parseIdentity } from "../src/app-identity";

export type { AppIdentity, Conversation, NostrEvent };

const hex = (text: string) => Uint8Array.from(Buffer.from(text, "hex"));
const now = () => Math.floor(Date.now() / 1000);

export const NOT_ALLOWED_TEXT = "Hi! I only take requests from the person who set me up, so I can't help with this one. I've let them know you asked.";

/** Databricks as the app's service principal, from the credentials Databricks Apps put in its environment. */
export class Workspace {
  readonly host: string;
  private cached?: { token: string; until: number };
  private me?: Promise<{ applicationId: string; displayName: string }>;

  constructor(private readonly env: NodeJS.ProcessEnv = process.env) {
    const host = (env.DATABRICKS_HOST ?? "").trim().replace(/\/+$/, "");
    this.host = !host ? "" : /^https?:\/\//.test(host) ? host : `https://${host}`;
  }

  /** An OAuth token for the service principal, refreshed a minute before it expires. */
  async token(): Promise<string> {
    if (this.cached && Date.now() < this.cached.until) return this.cached.token;
    const id = this.env.DATABRICKS_CLIENT_ID;
    const secret = this.env.DATABRICKS_CLIENT_SECRET;
    if (!this.host || !id || !secret) throw new Error("DATABRICKS_HOST, DATABRICKS_CLIENT_ID and DATABRICKS_CLIENT_SECRET aren't set; this runs as a Databricks App.");
    const response = await fetch(`${this.host}/oidc/v1/token`, {
      method: "POST",
      headers: { authorization: `Basic ${Buffer.from(`${id}:${secret}`).toString("base64")}`, "content-type": "application/x-www-form-urlencoded" },
      body: "grant_type=client_credentials&scope=all-apis",
      signal: AbortSignal.timeout(20_000),
    });
    const body = (await response.json().catch(() => ({}))) as { access_token?: string; expires_in?: number; error_description?: string };
    if (!response.ok || !body.access_token) throw new Error(`Couldn't sign in as the app's service principal: ${body.error_description ?? `HTTP ${response.status}`}`);
    this.cached = { token: body.access_token, until: Date.now() + Math.max(60, (body.expires_in ?? 3600) - 60) * 1000 };
    return body.access_token;
  }

  /** A Databricks REST call as the service principal; throws with the status for an error. */
  async api<T = unknown>(path: string, init: Readonly<{ method?: string; body?: unknown; query?: Record<string, string> }> = {}): Promise<T> {
    const url = new URL(`${this.host}${path}`);
    for (const [key, value] of Object.entries(init.query ?? {})) url.searchParams.set(key, value);
    const response = await fetch(url, {
      method: init.method ?? (init.body === undefined ? "GET" : "POST"),
      headers: { authorization: `Bearer ${await this.token()}`, accept: "application/json", ...(init.body !== undefined && { "content-type": "application/json" }) },
      ...(init.body !== undefined && { body: JSON.stringify(init.body) }),
      signal: AbortSignal.timeout(60_000),
    });
    const text = await response.text();
    if (!response.ok) {
      let message = `HTTP ${response.status}`;
      try {
        message = (JSON.parse(text) as { message?: string }).message || message;
      } catch {}
      throw Object.assign(new Error(message), { status: response.status });
    }
    return (text.trim() ? JSON.parse(text) : {}) as T;
  }

  /** A Unity Catalog secret's value; undefined when it's gone. */
  async secret(fullName: string): Promise<string | undefined> {
    try {
      const found = await this.api<{ effective_value?: string; value?: string }>(`/api/2.1/unity-catalog/secrets/${fullName.split(".").map(encodeURIComponent).join(".")}`, { query: { include_value: "true" } });
      return found.effective_value ?? found.value ?? "";
    } catch (error) {
      if ((error as { status?: number }).status === 404) return undefined;
      throw error;
    }
  }

  /** The service principal this app runs as. */
  whoami(): Promise<{ applicationId: string; displayName: string }> {
    this.me ??= this.api<{ userName?: string; applicationId?: string; displayName?: string }>("/api/2.0/preview/scim/v2/Me").then(
      (me) => ({ applicationId: me.applicationId ?? me.userName ?? "", displayName: me.displayName ?? me.userName ?? "" }),
      (error: unknown) => {
        this.me = undefined;
        throw error;
      },
    );
    return this.me;
  }
}

export type Mention = Readonly<{
  id: string;
  channel: string;
  /** The thread's root, unless the mention started it. */
  thread?: string;
  author: string;
  /** The message without mention links. */
  text: string;
  content: string;
  createdAt: number;
  conversation: Conversation;
  event: NostrEvent;
}>;

export type Reply = Readonly<{
  /** Replies in the mention's thread (or the channel, for a Solo chat). */
  say(text: string): Promise<void>;
  /** Shows the app typing there until the returned function is called (or the handler ends). */
  typing(): () => void;
  /** The conversation's earlier messages, oldest first. */
  history(): Promise<NostrEvent[]>;
}>;

export type MentionHandler = (mention: Mention, reply: Reply) => unknown;

/** A request to the app through Databricks Apps, which signs people in first. */
export type AppRequest = Readonly<{
  method: string;
  url: URL;
  /** Who's asking, from the Databricks Apps proxy (X-Forwarded-Email), when a person is. */
  user?: string;
  /** Their token, when the app has user authorization (on-behalf-of) scopes. */
  userToken?: string;
  body(): Promise<string>;
}>;
export type AppResponse = Readonly<{ status?: number; json?: unknown; html?: string; text?: string }>;
export type RouteHandler = (request: AppRequest) => AppResponse | Promise<AppResponse>;
/** Runs each time it signs in to Buzz; what it returns runs when it signs out. */
export type ConnectHandler = (app: BuzzApp) => void | (() => void) | Promise<void | (() => void)>;

export type BuzzAppOptions = Readonly<{
  /** Whose mentions it takes: everyone (the default), only its owner, or these pubkeys and its owner. The plugin's setting applies unless this is set. */
  answers?: Answers | readonly string[];
  /** One conversation per thread (the default) or per channel. */
  scope?: "thread" | "channel";
  /** The profile's About text. */
  about?: string;
  /** The status page's port; Databricks Apps sets DATABRICKS_APP_PORT. */
  port?: number;
  /** The secret's name; BUZZ_IDENTITY_SECRET by default. */
  identitySecret?: string;
  /** How often it reads its identity again, for a new name, picture or key. */
  refreshMs?: number;
  /** How often it checks for mentions. */
  pollMs?: number;
  log?(line: string): void;
  env?: NodeJS.ProcessEnv;
}>;

export type AppState = "starting" | "waiting" | "connecting" | "connected" | "removed" | "error";

/** A Buzz identity for a Databricks App. */
export class BuzzApp {
  readonly databricks: Workspace;
  identity?: AppIdentity;
  pubkey?: string;
  relay?: HttpRelay;
  state: AppState = "starting";
  lastError?: string;
  private handlers: MentionHandler[] = [];
  private connects: ConnectHandler[] = [];
  private disconnects: (() => void)[] = [];
  private routes = new Map<string, RouteHandler>();
  private extras: (() => Record<string, unknown>)[] = [];
  private stopWatch?: () => void;
  private refreshTimer?: ReturnType<typeof setTimeout>;
  private server?: Server;
  private typing?: Typing;
  private publishedProfile?: string;
  private readonly handled = new Set<string>();
  private readonly queues = new Map<string, Promise<void>>();
  private readonly channels = new Map<string, { at: number; kind: { type?: string; solo: boolean } }>();
  private readonly notes = new OutsiderNotes();
  private readonly startedAt = Date.now();
  private answered = 0;
  private lastMention?: number;
  private readonly log: (line: string) => void;
  private relayError?: string;
  /** The service principal it signed in to Databricks as, once known. */
  private runsAs?: { applicationId: string; displayName: string };
  private readonly env: NodeJS.ProcessEnv;

  constructor(private readonly options: BuzzAppOptions = {}) {
    this.env = options.env ?? process.env;
    this.databricks = new Workspace(this.env);
    const log = options.log ?? ((line: string) => console.log(`[buzz] ${line}`));
    this.log = (line) => {
      // The community's last refusal or failure, for the status page.
      if (/^poll failed/.test(line)) this.relayError = line.replace(/^poll failed \((.*)\); next in .*$/, "$1");
      log(line);
    };
  }

  /** The secret this app's identity is in. */
  get secretName(): string {
    return this.options.identitySecret ?? this.env.BUZZ_IDENTITY_SECRET ?? "";
  }

  /** The app's name in Databricks. */
  get appName(): string {
    return this.env.DATABRICKS_APP_NAME ?? this.identity?.app ?? "";
  }

  onMention(handler: MentionHandler): this {
    this.handlers.push(handler);
    return this;
  }

  /** Runs once it's signed in to Buzz (again after a new key or community), e.g. to start reading channels. */
  onConnect(handler: ConnectHandler): this {
    this.connects.push(handler);
    return this;
  }

  /** Serves `path` (exact, e.g. "/api/search") on the app's port. */
  route(path: string, handler: RouteHandler): this {
    this.routes.set(path, handler);
    return this;
  }

  /** Adds fields to the status page and /api/status. */
  describe(fields: () => Record<string, unknown>): this {
    this.extras.push(fields);
    return this;
  }

  /** Serves the status page, then signs in once the identity is ready (and keeps checking it). */
  async start(): Promise<void> {
    const port = this.options.port ?? Number(this.env.DATABRICKS_APP_PORT || 8000);
    this.server = createServer((request, response) => {
      const url = new URL(request.url ?? "/", "http://app");
      const route = this.routes.get(url.pathname);
      if (route) return void this.serve(route, request, url, response);
      const status = this.status();
      if (url.pathname.startsWith("/api/status")) {
        response.writeHead(200, { "content-type": "application/json" });
        return response.end(JSON.stringify(status));
      }
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      response.end(statusPage(status));
    });
    await new Promise<void>((resolve) => this.server!.listen(port, resolve));
    // Checks its Databricks sign-in early, for the status page.
    void this.databricks.whoami().then((me) => (this.runsAs = me), (error: Error) => this.log(`couldn't sign in to Databricks as the app's service principal: ${error.message}`));
    process.once("SIGTERM", () => {
      this.stop();
      process.exit(0);
    });
    await this.refresh();
  }

  private async serve(route: RouteHandler, request: import("node:http").IncomingMessage, url: URL, response: import("node:http").ServerResponse) {
    const header = (name: string) => {
      const value = request.headers[name];
      return typeof value === "string" && value ? value : undefined;
    };
    let reply: AppResponse;
    try {
      const user = header("x-forwarded-email");
      const userToken = header("x-forwarded-access-token");
      reply = await route({
        method: request.method ?? "GET",
        url,
        ...(user && { user }),
        ...(userToken && { userToken }),
        body: () =>
          new Promise((resolve, reject) => {
            let text = "";
            request.setEncoding("utf8");
            request.on("data", (chunk: string) => (text += chunk));
            request.on("end", () => resolve(text));
            request.on("error", reject);
          }),
      });
    } catch (error) {
      reply = { status: 500, json: { error: (error as Error).message ?? String(error) } };
    }
    const type = reply.json !== undefined ? "application/json" : reply.html !== undefined ? "text/html; charset=utf-8" : "text/plain; charset=utf-8";
    response.writeHead(reply.status ?? 200, { "content-type": type });
    response.end(reply.json !== undefined ? JSON.stringify(reply.json) : (reply.html ?? reply.text ?? ""));
  }

  stop() {
    this.stopWatch?.();
    this.relay?.close();
    if (this.refreshTimer) clearTimeout(this.refreshTimer);
    this.server?.close();
  }

  /** What the status page shows. */
  status() {
    // Signed in, but the community hasn't answered yet (or stopped answering).
    const reaching = this.state === "connected" && !this.relay?.ready;
    const lastError = this.lastError ?? (reaching && this.relayError ? `Can't reach the Buzz community: ${this.relayError}` : undefined);
    const base = {
      state: reaching ? ("connecting" as const) : this.state,
      ...(lastError && { lastError }),
      ...(this.pubkey && { pubkey: this.pubkey }),
      ...(this.identity?.name && { name: this.identity.name }),
      ...(this.identity?.owner && { owner: this.identity.owner }),
      app: this.appName,
      secret: this.secretName,
      connected: this.relay?.ready ?? false,
      ...(this.runsAs && { runsAs: this.runsAs }),
      answered: this.answered,
      startedAt: new Date(this.startedAt).toISOString(),
      ...(this.lastMention && { lastMention: new Date(this.lastMention).toISOString() }),
    };
    const extra: Record<string, unknown> = {};
    for (const fields of this.extras) {
      try {
        Object.assign(extra, fields());
      } catch {}
    }
    return { ...extra, ...base, ...(Object.keys(extra).length && { extra }) };
  }

  /** Signs a template as the identity, with its owner's attestation, and publishes it. */
  publish(template: EventTemplate): Promise<NostrEvent> {
    if (!this.relay) throw new Error("Not signed in to Buzz yet.");
    return this.relay.publish(template);
  }

  query(filters: readonly Filter[]): Promise<NostrEvent[]> {
    if (!this.relay) throw new Error("Not signed in to Buzz yet.");
    return this.relay.query(filters);
  }

  private schedule(ms: number) {
    if (this.refreshTimer) clearTimeout(this.refreshTimer);
    this.refreshTimer = setTimeout(() => void this.refresh(), ms);
    this.refreshTimer.unref?.();
  }

  /** Reads the identity again: signs in, republishes the profile, or stops, as it changed. */
  async refresh(): Promise<void> {
    const every = this.options.refreshMs ?? (Number(this.env.BUZZ_REFRESH_MS) || 60_000);
    if (!this.secretName) {
      this.state = "error";
      this.lastError = "BUZZ_IDENTITY_SECRET isn't set. Add it to app.yaml (the Databricks Agents plugin shows the line to add).";
      return;
    }
    let identity: AppIdentity | undefined;
    try {
      const value = await this.databricks.secret(this.secretName);
      if (value === undefined) {
        if (this.relay) this.log("the identity's secret is gone; signing out");
        this.signOut();
        this.state = "removed";
        this.lastError = `${this.secretName} doesn't exist (anymore). The identity was removed in Buzz, or the name is wrong.`;
        return this.schedule(every);
      }
      identity = parseIdentity(value);
      if (!identity) throw new Error(`${this.secretName} isn't a Buzz identity.`);
    } catch (error) {
      this.state = "error";
      this.lastError = `Couldn't read ${this.secretName}: ${(error as Error).message}`;
      this.log(this.lastError);
      return this.schedule(Math.min(every, 30_000));
    }
    const previous = this.identity;
    this.identity = identity;
    this.pubkey = getPublicKey(hex(identity.key));
    if (!activated(identity)) {
      this.state = "waiting";
      this.lastError = undefined;
      return this.schedule(Math.min(every, 10_000));
    }
    if (!this.relay || previous?.key !== identity.key || previous?.relay !== identity.relay || previous?.auth?.join() !== identity.auth.join()) this.signIn(identity);
    this.state = "connected";
    this.lastError = undefined;
    await this.publishProfile(identity);
    this.schedule(every);
  }

  private signOut() {
    for (const stop of this.disconnects.splice(0)) {
      try {
        stop();
      } catch {}
    }
    this.stopWatch?.();
    this.stopWatch = undefined;
    this.relay?.close();
    this.relay = undefined;
    this.publishedProfile = undefined;
  }

  private signIn(identity: AppIdentity & Required<Pick<AppIdentity, "relay" | "owner" | "auth">>) {
    this.signOut();
    const relay = new HttpRelay(identity.relay, hex(identity.key), identity.auth, this.log);
    this.relay = relay;
    this.typing = new Typing((template) => relay.publish(template), this.log);
    this.log(`signing in as ${this.pubkey!.slice(0, 12)}… for ${identity.name ?? "this app"}`);
    // Mentions from a minute before it started (a restart's gap), then live ones.
    this.stopWatch = relay.watch({ kinds: CHAT_KINDS, "#p": [this.pubkey!] }, now() - 60, (event) => this.onEvent(event), this.options.pollMs ?? 3000);
    for (const connect of this.connects)
      void Promise.resolve()
        .then(() => connect(this))
        .then(
          (stop) => {
            if (typeof stop !== "function") return;
            // Signed out (or in again) meanwhile: stop it now.
            if (this.relay === relay) this.disconnects.push(stop);
            else stop();
          },
          (error: unknown) => this.log(`a connect handler failed: ${(error as Error).message ?? error}`),
        );
  }

  private async publishProfile(identity: AppIdentity) {
    const name = identity.name || this.appName || "Buzz app";
    let about = this.options.about;
    if (!about) {
      const me = await this.databricks.whoami().catch(() => undefined);
      if (me) this.runsAs = me;
      const where = identity.workspace ? ` in ${identity.workspace.replace(/^https:\/\//, "")}` : "";
      about = `A Databricks App${this.appName ? ` (${this.appName})` : ""}${where}${me ? `, running as the service principal ${me.displayName || me.applicationId} (${me.applicationId})` : ""}.`;
    }
    const key = JSON.stringify([name, identity.picture ?? "", about]);
    if (this.publishedProfile === key || !this.relay) return;
    try {
      await this.relay.publish(profileTemplate({ name, ...(identity.picture && { picture: identity.picture }), about, authTag: identity.auth! }));
      this.publishedProfile = key;
      this.log("published the profile");
    } catch (error) {
      this.log(`profile not published yet: ${(error as Error).message}`);
    }
  }

  private allowed(event: NostrEvent): boolean {
    const owner = this.identity?.owner ?? "";
    if (fromOwner(event, owner)) return true;
    const answers = this.options.answers ?? this.identity?.answers ?? "everyone";
    if (answers === "everyone") return true;
    if (answers === "owner") return false;
    return answers.includes(event.pubkey);
  }

  private async kindOf(channel: string) {
    const known = this.channels.get(channel);
    if (known && Date.now() - known.at < 10 * 60_000) return known.kind;
    const [metadata] = await this.query([{ kinds: [39000], "#d": [channel], limit: 1 }]);
    const kind = channelKind(metadata);
    this.channels.set(channel, { at: Date.now(), kind });
    return kind;
  }

  private onEvent(event: NostrEvent) {
    const pubkey = this.pubkey!;
    if (this.handled.has(event.id) || !verifyEvent(event) || !mentionsAgent(event, pubkey)) return;
    this.handled.add(event.id);
    if (this.handled.size > 5000) for (const id of [...this.handled].slice(0, 2500)) this.handled.delete(id);
    const channel = event.tags.find((tag) => tag[0] === "h")?.[1];
    if (!channel) return;
    void this.kindOf(channel)
      .catch(() => ({ solo: false }))
      .then((kind) => {
        const conversation = conversationOf(event, this.options.scope ?? "thread", kind);
        if (!conversation) return;
        const next = (this.queues.get(conversation.key) ?? Promise.resolve()).then(() => this.handle(event, conversation));
        this.queues.set(conversation.key, next.catch(() => {}));
      });
  }

  private async say(conversation: Conversation, text: string, notify?: readonly string[]) {
    for (const part of splitMessage(text)) await this.publish(replyTemplate({ conversation, content: part, authTag: this.identity!.auth!, ...(notify && { notify }) }));
  }

  private async handle(event: NostrEvent, conversation: Conversation) {
    const owner = this.identity?.owner ?? "";
    if (!this.allowed(event)) {
      if (this.notes.take(this.pubkey!, event.pubkey, conversation.key)) await this.say(conversation, NOT_ALLOWED_TEXT, [event.pubkey, owner]).catch(() => {});
      this.log(`ignored ${event.id.slice(0, 8)}: not someone it answers`);
      return;
    }
    this.lastMention = Date.now();
    const stops: (() => void)[] = [];
    const reply: Reply = {
      say: (text) => this.say(conversation, text),
      typing: () => {
        const stop = this.typing?.start(conversation, event) ?? (() => {});
        stops.push(stop);
        return stop;
      },
      history: async () => {
        const found = await this.query(contextFilters(conversation));
        return found.filter((e) => e.id !== event.id && CHAT_KINDS.includes(e.kind) && e.created_at <= event.created_at).sort((a, b) => a.created_at - b.created_at);
      },
    };
    const root = conversation.root !== event.id ? conversation.root : undefined;
    const mention: Mention = {
      id: event.id,
      channel: conversation.channel,
      ...(root && { thread: root }),
      author: event.pubkey,
      text: plainText(event.content),
      content: event.content,
      createdAt: event.created_at,
      conversation,
      event,
    };
    try {
      for (const handler of this.handlers) await handler(mention, reply);
      this.answered++;
    } catch (error) {
      const message = (error as Error).message ?? String(error);
      this.lastError = message;
      this.log(`a mention failed: ${message}`);
      await this.say(conversation, `I couldn't finish that: ${message}`).catch(() => {});
    } finally {
      for (const stop of stops) stop();
    }
  }
}

const escape = (text: string) => text.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);

const STATE_TEXT: Record<AppState, string> = {
  starting: "Starting",
  waiting: "Waiting for Buzz to finish setting up this identity",
  connecting: "Reaching the Buzz community",
  connected: "Signed in to Buzz",
  removed: "Its identity was removed",
  error: "Something's wrong",
};

function statusPage(status: ReturnType<BuzzApp["status"]>): string {
  const rows: [string, string | undefined][] = [
    ["Status", STATE_TEXT[status.state]],
    ["Problem", status.lastError],
    ["Buzz identity", status.pubkey],
    ["Runs as", status.runsAs && `${status.runsAs.displayName} (${status.runsAs.applicationId})`],
    ["Name", status.name],
    ["Owner", status.owner],
    ["Identity secret", status.secret],
    ["Mentions answered", String(status.answered)],
    ...Object.entries((status as { extra?: Record<string, unknown> }).extra ?? {}).map(([label, value]): [string, string | undefined] => [label, typeof value === "object" ? JSON.stringify(value) : String(value)]),
    ["Started", status.startedAt],
  ];
  return `<!doctype html><meta charset="utf-8"><title>${escape(status.name ?? status.app ?? "Buzz app")}</title>
<style>body{font:14px system-ui,sans-serif;margin:40px;color:#1b1f23}td{padding:4px 16px 4px 0;vertical-align:top}td:first-child{color:#666}code{font-size:12px}</style>
<h1>${escape(status.name ?? status.app ?? "Buzz app")}</h1><table>${rows
    .filter(([, value]) => value)
    .map(([label, value]) => `<tr><td>${label}</td><td><code>${escape(value!)}</code></td></tr>`)
    .join("")}</table>`;
}
