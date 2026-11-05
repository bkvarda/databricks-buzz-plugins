// The hosted Databricks agent's runner, inside its Databricks Sandbox. It
// holds the agent's key, stays connected to the Buzz community, answers its
// owner's mentions with Genie or a coding harness (Claude Code, Codex, Pi),
// and posts replies as the agent: with the owner's laptop on or off.
//
//   node runner.mjs keygen       make (or read) the agent's key; prints {"pubkey"}
//   node runner.mjs profile      publish the agent's profile from config.json
//   node runner.mjs start        start `serve` in the background unless it's running
//   node runner.mjs serve        the runner itself
//   node runner.mjs stop         stop it
//   node runner.mjs interrupt <channel> <root>   stop a conversation's turn; prints true/false
//   node runner.mjs status       prints status.json
//   node runner.mjs ask <text>   answers once with the configured Genie or harness (a diagnostic)
import { execFile, spawn } from "node:child_process";
import { appendFileSync, existsSync, openSync, readFileSync, rmSync, statSync, truncateSync, writeFileSync } from "node:fs";
import { Genie } from "@dbx/core/api/genie";
import { resultBlock } from "@dbx/core/result";
import { generateSecretKey, getPublicKey, type NostrEvent, verifyEvent } from "nostr-tools/pure";
import { answerMarkdown, GenieOne } from "../../genie/src/genie-one";
import { harnessLabel, RESULT_PROMPT, remoteNote } from "../src/remote";
import { CHAT_KINDS, channelKind, contextFilters, type Conversation, conversationOf, fromOwner, mentionsAgent, plainText, profileTemplate, replyTemplate, splitMessage, turnPrompt } from "./buzz";
import { sandboxService } from "./databricks";
import { runLocalTurn } from "./harness";
import { HttpRelay } from "./http";
import { ensureDirs, paths, readConfig, readSecretKey, readState, type RunnerConfig, saveSecretKey, turnPidPath, writeJson, writeState } from "./store";

const TURN_TIMEOUT_MS = 30 * 60_000;
const PROFILE_ABOUT = "A Databricks agent in its own Databricks Sandbox.";

function log(line: string) {
  try {
    if (existsSync(paths.log) && statSync(paths.log).size > 5 * 1024 * 1024) truncateSync(paths.log, 0);
  } catch {}
  appendFileSync(paths.log, `${new Date().toISOString()} ${line}\n`);
}

function alive(pid: number) {
  try {
    process.kill(pid, 0);
    return readFileSync(`/proc/${pid}/cmdline`, "utf8").includes("serve");
  } catch {
    return false;
  }
}

const runnerPid = () => {
  const pid = Number(existsSync(paths.pid) ? readFileSync(paths.pid, "utf8") : "");
  return Number.isInteger(pid) && pid > 0 && alive(pid) ? pid : undefined;
};

function need<T>(value: T | undefined, what: string): T {
  if (value === undefined) {
    console.error(`No ${what} yet.`);
    process.exit(2);
  }
  return value;
}

const connect = (config: RunnerConfig, secret: Uint8Array) => new HttpRelay(config.relay, secret, config.authTag, log);

// ── Turns ──

function systemPrompt(config: RunnerConfig, pubkey: string): string {
  return [
    `<identity>You are ${config.name} (pubkey ${pubkey}), an agent in Buzz, a chat app, owned by ${config.owner}.</identity>`,
    "People mention you in channels, threads and Solo chats; each mention is a turn. Messages in the conversation you haven't seen arrive with the mention, as JSON. Your final message is posted as your reply in that conversation: make it the answer itself, in Markdown, written for the people there, without saying that you're posting it.",
    remoteNote(config.harness, "standard"),
    RESULT_PROMPT,
    config.instructions.trim() ? `<agent-instructions>\n${config.instructions.trim()}\n</agent-instructions>` : "",
  ]
    .filter(Boolean)
    .join("\n\n");
}

async function names(relay: HttpRelay, pubkeys: string[]): Promise<Map<string, string>> {
  const found = new Map<string, string>();
  if (!pubkeys.length) return found;
  for (const event of await relay.query([{ kinds: [0], authors: pubkeys, limit: pubkeys.length * 2 }]).catch(() => [])) {
    try {
      const profile = JSON.parse(event.content) as { name?: string; display_name?: string };
      const name = profile.display_name || profile.name;
      if (name && !found.has(event.pubkey)) found.set(event.pubkey, String(name).slice(0, 80));
    } catch {}
  }
  return found;
}

async function genieAnswer(config: RunnerConfig, question: string, conversationId: string | undefined, signal: AbortSignal): Promise<{ text: string; conversation: string }> {
  const service = sandboxService();
  const space = config.genieSpace;
  if (!space) {
    const answer = await new GenieOne(service).ask(question, { ...(conversationId && { conversationId }), signal });
    const parts = [answerMarkdown(answer)];
    if (answer.status === "incomplete") parts.push("_Genie One stopped early; this may be partial._");
    const sql = answer.sql[answer.sql.length - 1];
    if (sql) parts.push(`\`\`\`sql\n${sql.trim()}\n\`\`\``);
    if (answer.deepLink) parts.push(`[Explore in Databricks](${answer.deepLink})`);
    return { text: parts.filter(Boolean).join("\n\n") || "Genie One had no answer.", conversation: answer.conversationId };
  }
  const client = await service.ready();
  const answer = await new Genie(client).answer(space, question, { ...(conversationId && { conversationId }), signal });
  const parts: string[] = [];
  if (answer.text) parts.push(answer.text);
  if (answer.result?.columns.length) parts.push(resultBlock(answer.result));
  if (answer.sql) parts.push(`\`\`\`sql\n${answer.sql.trim()}\n\`\`\``);
  if (answer.message.status !== "COMPLETED") parts.push(`Genie stopped with status ${answer.message.status}${answer.error ? `: ${answer.error}` : ""}.`);
  if (answer.suggestions.length) parts.push(`_You could also ask:_ ${answer.suggestions.slice(0, 3).map((q) => `“${q}”`).join(" · ")}`);
  const link = service.workspaceUrl(Genie.webPath(space, answer.message.conversation_id));
  if (link) parts.push(`[Open in Genie](${link})`);
  return { text: parts.join("\n\n") || "Genie had no answer.", conversation: answer.message.conversation_id };
}

async function serve() {
  ensureDirs();
  const config = need(readConfig(), "config.json");
  const secret = need(readSecretKey(), "agent key");
  const pubkey = getPublicKey(secret);
  writeFileSync(paths.pid, String(process.pid));
  const state = readState();
  const handled = new Set(state.handled);
  const channels = new Map<string, { at: number; kind: { type?: string; solo: boolean } }>();
  const queues = new Map<string, Promise<void>>();
  const startedAt = Date.now();
  let active = 0;
  let lastActivity = Date.now();
  let lastError: string | undefined;
  log(`starting as ${pubkey.slice(0, 12)}… (${config.kind === "genie" ? "Genie" : harnessLabel(config.harness)}, ${config.availability})`);
  const relay = connect(config, secret);

  const save = () => writeState({ ...state, handled: [...handled] });
  const status = () =>
    writeJson(paths.status, { pid: process.pid, pubkey, connected: relay.ready, active, startedAt: new Date(startedAt).toISOString(), lastActivity: new Date(lastActivity).toISOString(), since: state.since, ...(lastError && { lastError }) }, 0o644);

  async function kindOf(channel: string) {
    const known = channels.get(channel);
    if (known && Date.now() - known.at < 10 * 60_000) return known.kind;
    const [metadata] = await relay.query([{ kinds: [39000], "#d": [channel], limit: 1 }]);
    const kind = channelKind(metadata);
    channels.set(channel, { at: Date.now(), kind });
    return kind;
  }

  async function post(conversation: Conversation, text: string, notify?: string) {
    for (const part of splitMessage(text)) await relay.publish(replyTemplate({ conversation, content: part, authTag: config.authTag, ...(notify && { notify }) }));
  }

  async function answer(event: NostrEvent, conversation: Conversation, signal: AbortSignal): Promise<string> {
    const saved = state.sessions[conversation.key];
    if (config.kind === "genie") {
      const tag = config.genieSpace ? `genie:${config.genieSpace}` : "genie-one";
      const continued = saved?.harness === tag ? saved.id : undefined;
      const result = await genieAnswer(config, plainText(event.content) || "What can I ask you about?", continued, signal);
      state.sessions[conversation.key] = { harness: tag, id: result.conversation, at: event.created_at };
      return result.text;
    }
    const session = saved?.harness === config.harness ? saved : undefined;
    // The conversation's messages this harness session hasn't seen.
    const filters = contextFilters(conversation);
    const found = (await relay.query(filters)).filter(
      (e) => e.id !== event.id && CHAT_KINDS.includes(e.kind) && e.created_at <= event.created_at && e.tags.some((t) => t[0] === "h" && t[1] === conversation.channel),
    );
    const unseen = found.filter((e) => e.created_at > (session?.at ?? 0) && e.pubkey !== pubkey).sort((a, b) => a.created_at - b.created_at);
    const context = unseen.slice(-12);
    const prompt = turnPrompt({ event, conversation, agent: pubkey, context, total: unseen.length, names: await names(relay, [...new Set([event.pubkey, ...context.map((e) => e.pubkey)])]), scope: config.scope });
    // Tests run the runner against a local relay without a harness.
    if (process.env.BUZZ_RUNNER_ECHO === "1") return `echo: ${plainText(event.content)} | ${conversation.key} | context ${context.length} | ${prompt.length} chars`;
    const result = await runLocalTurn({
      harness: config.harness,
      model: config.model,
      // A hosted agent runs unattended: always each harness's guarded mode.
      permissions: "standard",
      ...(session && { session: { id: session.id } }),
      prompt,
      system: systemPrompt(config, pubkey),
      signal,
      pidFile: turnPidPath(conversation.key),
      onStep: (tool, target) => log(`  ${tool}${target ? ` · ${target}` : ""}`),
      onSession: (id) => {
        state.sessions[conversation.key] = { harness: config.harness, id, at: session?.at ?? 0 };
        save();
      },
    });
    state.sessions[conversation.key] = { harness: config.harness, id: result.session, at: event.created_at };
    return result.text;
  }

  async function turn(event: NostrEvent, conversation: Conversation) {
    const stopped = `${turnPidPath(conversation.key)}.stopped`;
    rmSync(stopped, { force: true });
    active++;
    lastActivity = Date.now();
    status();
    log(`mention ${event.id.slice(0, 8)} in ${conversation.key}`);
    try {
      const text = await answer(event, conversation, AbortSignal.timeout(TURN_TIMEOUT_MS));
      await post(conversation, text);
      log(`replied in ${conversation.key}`);
    } catch (error) {
      if (existsSync(stopped)) {
        log(`stopped in ${conversation.key}`);
      } else {
        lastError = (error as Error).message ?? String(error);
        log(`turn failed: ${lastError}`);
        await post(conversation, `I couldn't finish that: ${lastError}`, config.owner).catch((e) => log(`couldn't post the failure: ${e.message}`));
      }
    } finally {
      rmSync(stopped, { force: true });
      active--;
      lastActivity = Date.now();
      state.since = Math.max(state.since, event.created_at);
      save();
      status();
    }
  }

  function onEvent(event: NostrEvent) {
    if (handled.has(event.id) || !verifyEvent(event) || !mentionsAgent(event, pubkey)) return;
    handled.add(event.id);
    if (!fromOwner(event, config.owner)) {
      log(`ignored ${event.id.slice(0, 8)}: not from the owner`);
      return;
    }
    // Routed in arrival order (a Solo chat or DM is one conversation), then one turn at a time per conversation.
    routing = routing.then(async () => {
      const channel = event.tags.find((t) => t[0] === "h")?.[1];
      if (!channel) return;
      const conversation = conversationOf(event, config.scope, await kindOf(channel).catch(() => ({ solo: false })));
      if (!conversation) return;
      const next = (queues.get(conversation.key) ?? Promise.resolve()).then(() => turn(event, conversation));
      queues.set(conversation.key, next.catch(() => {}));
    });
  }
  let routing: Promise<void> = Promise.resolve();

  // The profile, until the relay takes it (it may admit the agent only once its owner's listing exists).
  const profileKey = JSON.stringify([config.name, config.picture ?? ""]);
  const publishProfile = async () => {
    if (state.profile === profileKey) return;
    try {
      await relay.publish(profileTemplate({ name: config.name, ...(config.picture && { picture: config.picture }), about: PROFILE_ABOUT, authTag: config.authTag }));
      state.profile = profileKey;
      save();
      log("published the profile");
    } catch (error) {
      log(`profile not published yet: ${(error as Error).message}`);
      setTimeout(() => void publishProfile(), 60_000).unref();
    }
  };
  void publishProfile();

  // Mentions since the last one handled (catching up after a sleep), then live ones.
  const since = state.since ? state.since - 5 : Math.floor(Date.now() / 1000) - 60;
  relay.watch({ kinds: CHAT_KINDS, "#p": [pubkey] }, since, onEvent);
  status();
  setInterval(status, 30_000).unref();

  if (config.availability === "sleep") {
    setInterval(() => {
      const idle = Date.now() - lastActivity > config.idleMinutes * 60_000;
      // The owner's Buzz keeps the agent awake while it's open (it touches this file).
      const heartbeat = existsSync(paths.awake) ? statSync(paths.awake).mtimeMs : 0;
      if (active || !idle || Date.now() - heartbeat < 10 * 60_000) return;
      log("idle; stopping the Sandbox until the keeper wakes it");
      save();
      relay.close();
      execFile("databricks", ["api", "post", `/api/2.0/sandboxes/${config.sandbox}/stop`, "--json", "{}"], (error) => {
        if (error) log(`couldn't stop the Sandbox: ${error.message}`);
        process.exit(0);
      });
    }, 60_000).unref();
  }
  process.on("SIGTERM", () => {
    save();
    relay.close();
    process.exit(0);
  });
}

// ── Commands ──

async function main() {
  const [command, ...args] = process.argv.slice(2);
  ensureDirs();
  switch (command) {
    case "keygen": {
      let secret = readSecretKey();
      if (!secret) {
        secret = generateSecretKey();
        saveSecretKey(secret);
      }
      console.log(JSON.stringify({ pubkey: getPublicKey(secret) }));
      return;
    }
    case "profile": {
      const config = need(readConfig(), "config.json");
      const relay = connect(config, need(readSecretKey(), "agent key"));
      await relay.publish(profileTemplate({ name: config.name, ...(config.picture && { picture: config.picture }), about: PROFILE_ABOUT, authTag: config.authTag }));
      const state = readState();
      writeState({ ...state, profile: JSON.stringify([config.name, config.picture ?? ""]) });
      console.log("published");
      return;
    }
    case "start": {
      if (runnerPid()) return console.log("running");
      const out = openSync(paths.log, "a");
      const child = spawn(process.execPath, [process.argv[1]!, "serve"], { detached: true, stdio: ["ignore", out, out] });
      child.unref();
      writeFileSync(paths.pid, String(child.pid));
      return console.log("started");
    }
    case "stop": {
      const pid = runnerPid();
      if (pid) {
        process.kill(pid, "SIGTERM");
        // Wait for it to go, so a start right after doesn't find it still running.
        for (let i = 0; i < 50 && alive(pid); i++) await new Promise((resolve) => setTimeout(resolve, 100));
        if (alive(pid)) process.kill(pid, "SIGKILL");
      }
      return console.log(pid ? "stopped" : "not running");
    }
    case "interrupt": {
      const [channel = "", root = ""] = args;
      for (const key of [`${channel}/${root}`, channel]) {
        const file = turnPidPath(key);
        const pid = Number(existsSync(file) ? readFileSync(file, "utf8") : "");
        if (!pid) continue;
        writeFileSync(`${file}.stopped`, "");
        try {
          process.kill(-pid, "SIGTERM");
          return console.log("true");
        } catch {}
      }
      return console.log("false");
    }
    case "status": {
      const pid = runnerPid();
      const saved = existsSync(paths.status) ? JSON.parse(readFileSync(paths.status, "utf8")) : {};
      return console.log(JSON.stringify({ ...saved, running: Boolean(pid) }));
    }
    case "ask": {
      // Answers one question without the relay, to check Genie or the harness from inside the Sandbox.
      const config = need(readConfig(), "config.json");
      const question = args.join(" ") || "Say hello in one short sentence.";
      if (config.kind === "genie") return console.log((await genieAnswer(config, question, undefined, AbortSignal.timeout(TURN_TIMEOUT_MS))).text);
      const result = await runLocalTurn({
        harness: config.harness,
        model: config.model,
        permissions: "standard",
        prompt: question,
        system: systemPrompt(config, "diagnostic"),
        signal: AbortSignal.timeout(TURN_TIMEOUT_MS),
        pidFile: turnPidPath("ask"),
        onStep: (tool, target) => console.error(`step: ${tool}${target ? ` · ${target}` : ""}`),
      });
      return console.log(result.text);
    }
    case "serve":
      return serve();
    default:
      console.error("usage: runner.mjs keygen|profile|start|serve|stop|interrupt|status");
      process.exit(2);
  }
}

main().catch((error) => {
  log(`fatal: ${error?.stack ?? error}`);
  console.error(error?.message ?? error);
  process.exit(1);
});
