// Sandbox agents can think with a coding agent that lives in their Databricks
// Sandbox instead of the built-in loop: Claude Code, Codex or Pi. All three
// come preinstalled in every Sandbox and reach AI Gateway through Unity
// Gateway (`ug`) with the Sandbox's own credential, the owner's. Each Buzz
// conversation keeps one harness session on the Sandbox's persistent home, so
// context survives between turns and across Sandbox restarts.
//
// A turn writes the prompt and instructions to files, starts the harness
// detached (Databricks' command API returns after about five minutes at most,
// and waits for anything holding its output), then reads the harness's JSON
// event log every couple of seconds for progress, its session ID and the
// final message, which Buzz posts as the agent's reply.
import { SANDBOX_HOME, type Sandboxes } from "@dbx/core/api/sandbox";
import { RESULT_LANGUAGE } from "@dbx/core/result";
import { BRIDGE_NAME, type BridgeConfig, bridgeCommand, hasBridgeTools, RUNNER_PATH, toolFiles } from "./harness-tools";

export type HarnessId = "builtin" | "claude" | "codex" | "pi";
export type RemoteHarness = Exclude<HarnessId, "builtin">;
/** "standard": each harness's own guarded mode; "full": nothing is asked or blocked. */
export type Permissions = "standard" | "full";

export const HARNESSES: readonly Readonly<{ id: HarnessId; label: string; detail: string }>[] = [
  { id: "builtin", label: "Built-in", detail: "Fastest. Uses Buzz's tools and the tools you pick, and runs code in the Sandbox when it needs to." },
  { id: "claude", label: "Claude Code", detail: "Anthropic's coding agent, running in the Sandbox with its own tools and the Databricks CLI signed in as you. Keeps its context between turns." },
  { id: "codex", label: "Codex", detail: "OpenAI's coding agent, running in the Sandbox with its own tools and the Databricks CLI signed in as you. Keeps its context between turns." },
  { id: "pi", label: "Pi", detail: "A small coding agent for Claude, GPT and Gemini models, running in the Sandbox with its own tools. Keeps its context between turns." },
];

export const HARNESS_IDS = HARNESSES.map((harness) => harness.id);
export const isRemote = (harness: HarnessId): harness is RemoteHarness => harness !== "builtin";
export const harnessLabel = (harness: HarnessId) => HARNESSES.find((candidate) => candidate.id === harness)?.label ?? harness;

/** The model each harness starts with (the Sandbox's preinstalled Claude Code default is retired). */
export const HARNESS_MODEL: Readonly<Record<RemoteHarness, string>> = {
  claude: "system.ai.claude-sonnet-5-5",
  codex: "system.ai.gpt-5-6-sol",
  pi: "system.ai.claude-sonnet-5-5",
};

/**
 * Whether a harness can use a model. Claude Code speaks Anthropic's API and
 * Codex OpenAI's Responses API; Pi is set up with Databricks' Claude, GPT and
 * Gemini models. The built-in loop takes any chat model with tool calling.
 */
export function harnessAccepts(harness: HarnessId, model: string): boolean {
  if (harness === "builtin") return true;
  if (!model.startsWith("system.ai.")) return false;
  const leaf = model.slice("system.ai.".length);
  if (harness === "claude") return /^claude/.test(leaf);
  if (harness === "codex") return /^gpt/.test(leaf);
  return /^(claude|gpt|gemini)/.test(leaf);
}

/** The model a harness runs with: the agent's own when it fits, else the harness default. */
export const harnessModel = (harness: RemoteHarness, model: string) => (harnessAccepts(harness, model) ? model : HARNESS_MODEL[harness]);

/** What each permission level means for a harness, for the form. */
export function permissionsHint(harness: RemoteHarness, permissions: Permissions): string {
  if (permissions === "full")
    return "Runs any command and changes any file in the Sandbox without asking. The Sandbox is separate from your computer, but it's signed in to Databricks as you and can reach the internet.";
  if (harness === "claude") return "Claude Code's auto mode: a safety check approves or blocks each action, and nothing waits for you.";
  if (harness === "codex") return "Codex can change files only in its work folder and /tmp, and can reach the internet.";
  return "Pi has no approval step, so Standard gives it file tools only (read, search, edit, write) and no shell.";
}

/** How a Databricks agent shows data: Buzz draws result blocks as charts. */
export const RESULT_PROMPT = [
  "To show a query result or other table, put it in a fenced code block with the language",
  `\`${RESULT_LANGUAGE}\` whose body is CSV with a header row (up to 200 rows; quote values that contain commas).`,
  "Buzz draws it as an interactive chart with a table view, so you can chart data; don't say you can't.",
  "Put the label column (such as a date or category) first and the numeric columns after it, unformatted (no $ or thousands separators).",
].join(" ");

// ── Commands ──

export type RunFiles = Readonly<{
  dir: string;
  prompt: string;
  system: string;
  events: string;
  stderr: string;
  exit: string;
  pid: string;
  script: string;
  /** The Databricks tools bridge's config, Claude Code's MCP config, and Pi's tools extension. */
  tools: string;
  mcp: string;
  piTools: string;
}>;

export const RUNS_DIR = `${SANDBOX_HOME}/.buzz/runs`;
export const WORK_DIR = `${SANDBOX_HOME}/work`;

export const runFiles = (dir: string): RunFiles => ({
  dir,
  prompt: `${dir}/prompt.md`,
  system: `${dir}/system.md`,
  events: `${dir}/events.jsonl`,
  stderr: `${dir}/stderr.log`,
  exit: `${dir}/exit`,
  pid: `${dir}/pid`,
  script: `${dir}/run.sh`,
  tools: `${dir}/tools.json`,
  mcp: `${dir}/mcp.json`,
  piTools: `${dir}/databricks-tools.mjs`,
});

/** A single-quoted shell word. */
export const shellQuote = (text: string) => `'${text.replace(/'/g, `'\\''`)}'`;

const PI_STANDARD_TOOLS = "read,grep,find,ls,edit,write";

/**
 * The harness command for one turn. `session` is the harness session to
 * continue: Claude Code and Pi take the ID we choose (Claude Code creates it
 * with --session-id, then --resume continues it); Codex names its own thread,
 * so a first Codex turn has none. With `tools`, the harness also gets the
 * agent's Databricks tools from the runner's bridge (see ./harness-tools.ts),
 * whose files the turn writes first (`toolFiles`).
 */
export function harnessCommand(
  input: Readonly<{
    harness: RemoteHarness;
    model: string;
    permissions: Permissions;
    session: Readonly<{ id: string; resume: boolean }> | undefined;
    files: RunFiles;
    /** The runner bundle's path in the Sandbox, when the agent has Databricks tools. */
    tools?: Readonly<{ runner: string }>;
  }>,
): string {
  const { model, files, session, tools } = input;
  const full = input.permissions === "full";
  const bridge = tools ? bridgeCommand(tools.runner, files.tools) : undefined;
  switch (input.harness) {
    case "claude": {
      if (!session) throw new Error("Claude Code needs a session ID.");
      return [
        // A Genie answer can take minutes; the bridge lists every server before it answers.
        ...(bridge ? ["MCP_TIMEOUT=120000", "MCP_TOOL_TIMEOUT=600000"] : []),
        "claude", "-p", "--model", shellQuote(model), "--output-format", "stream-json", "--verbose",
        "--permission-mode", full ? "bypassPermissions" : "auto",
        // The owner chose these tools, so Standard doesn't second-guess them.
        ...(bridge ? ["--mcp-config", shellQuote(files.mcp), "--strict-mcp-config", ...(full ? [] : ["--allowedTools", `mcp__${BRIDGE_NAME}`])] : []),
        "--append-system-prompt-file", shellQuote(files.system),
        session.resume ? "--resume" : "--session-id", shellQuote(session.id),
        "<", shellQuote(files.prompt),
      ].join(" ");
    }
    case "codex":
      return [
        "codex", "exec", ...(session ? ["resume", shellQuote(session.id)] : []),
        "--json", "--skip-git-repo-check", "-m", shellQuote(model),
        ...(full ? ["--dangerously-bypass-approvals-and-sandbox"] : ["-c", shellQuote('sandbox_mode="workspace-write"'), "-c", "sandbox_workspace_write.network_access=true"]),
        ...(bridge
          ? [
              "-c", shellQuote(`mcp_servers.${BRIDGE_NAME}.command=${JSON.stringify(bridge[0])}`),
              "-c", shellQuote(`mcp_servers.${BRIDGE_NAME}.args=${JSON.stringify(bridge.slice(1))}`),
              "-c", `mcp_servers.${BRIDGE_NAME}.startup_timeout_sec=120`,
              "-c", `mcp_servers.${BRIDGE_NAME}.tool_timeout_sec=600`,
              // codex exec never asks, so a tool needing approval would be refused; the owner chose these.
              "-c", shellQuote(`mcp_servers.${BRIDGE_NAME}.default_tools_approval_mode="approve"`),
            ]
          : []),
        "-", "<", shellQuote(files.prompt),
      ].join(" ");
    case "pi": {
      if (!session) throw new Error("Pi needs a session ID.");
      // Pi's --tools allowlist covers extension tools too, so Standard lists the bridge's by name;
      // if that fails, Pi still has only its file tools.
      const names = bridge ? `$(${[...bridge.slice(0, 2), "mcp-names", files.tools].map(shellQuote).join(" ")} 2>/dev/null)` : "";
      return [
        ...(bridge ? [`BUZZ_TOOLS_BRIDGE=${shellQuote(JSON.stringify(bridge))}`] : []),
        "pi", "-p", "--mode", "json", "--model", shellQuote(model), "--session-id", shellQuote(session.id),
        "--append-system-prompt", shellQuote(files.system),
        ...(bridge ? ["-e", shellQuote(files.piTools)] : []),
        ...(full ? [] : ["--tools", `"${PI_STANDARD_TOOLS}${names}"`]),
        shellQuote(`@${files.prompt}`), "<", "/dev/null",
      ].join(" ");
    }
  }
}

/** The detached script: runs the harness in the work folder and records its exit code. */
export function runScript(command: string, files: RunFiles): string {
  return ["#!/bin/bash", `cd ${shellQuote(WORK_DIR)} || exit 1`, `${command} > ${shellQuote(files.events)} 2> ${shellQuote(files.stderr)}`, `echo $? > ${shellQuote(files.exit)}`, ""].join("\n");
}

/** Starts the script in its own session, holding none of the command's output, so the call returns at once. */
export const launchCommand = (files: RunFiles) =>
  `nohup setsid bash ${shellQuote(files.script)} > /dev/null 2>&1 < /dev/null & echo $! > ${shellQuote(files.pid)}; find ${shellQuote(RUNS_DIR)} -mindepth 1 -maxdepth 1 -mmin +1440 -exec rm -rf {} + 2>/dev/null; true`;

/** Stops the harness and everything it started. */
export const killCommand = (files: RunFiles) =>
  `P=$(cat ${shellQuote(files.pid)} 2>/dev/null); [ -n "$P" ] && { kill -TERM -- -"$P" 2>/dev/null; sleep 2; kill -KILL -- -"$P" 2>/dev/null; }; true`;

const POLL_SEPARATOR = "@@buzz-events@@";

/** Reads the exit code (once written) and complete event lines after `from`, long lines cut. */
export const pollCommand = (files: RunFiles, from: number) =>
  `cat ${shellQuote(files.exit)} 2>/dev/null; echo; echo ${POLL_SEPARATOR}; tail -n +${from + 1} ${shellQuote(files.events)} 2>/dev/null | head -n 400 | cut -c1-262144`;

/** Splits a poll's output into the exit code and the complete lines (a half-written last line waits for the next poll). */
export function parsePoll(stdout: string): { exit?: number; lines: string[] } {
  const at = stdout.indexOf(`\n${POLL_SEPARATOR}\n`);
  const head = at === -1 ? "" : stdout.slice(0, at).trim();
  const body = at === -1 ? "" : stdout.slice(at + POLL_SEPARATOR.length + 2);
  const lines = body.split("\n");
  lines.pop(); // the text after the last newline: empty, or a line still being written
  const exit = /^\d+$/.test(head) ? Number(head) : undefined;
  return { ...(exit !== undefined && { exit }), lines };
}

// ── Events ──

export type HarnessEvent = Readonly<{
  /** A tool the harness started, for Buzz's working steps. */
  step?: Readonly<{ tool: string; target?: string }>;
  /** The harness's own session (thread) ID. */
  session?: string;
  /** Message text the harness wrote; the last one is the reply. */
  text?: string;
  /** The final reply, when the harness reports one. */
  final?: string;
  /** The turn failed. */
  error?: string;
}>;

const TARGET_KEYS = ["command", "cmd", "file_path", "path", "pattern", "query", "url", "description", "prompt"];

function targetOf(value: unknown): string | undefined {
  if (!value || typeof value !== "object") return undefined;
  for (const key of TARGET_KEYS) {
    const found = (value as Record<string, unknown>)[key];
    if (typeof found === "string" && found.trim()) return found.length > 80 ? `${found.slice(0, 77)}…` : found;
  }
  return undefined;
}

const shellTarget = (command: string) => command.replace(/^\/bin\/(ba)?sh -lc '?/, "").replace(/'$/, "");

const textOf = (content: unknown) =>
  Array.isArray(content)
    ? content
        .filter((part): part is { type: string; text: string } => !!part && typeof part === "object" && (part as { type?: unknown }).type === "text" && typeof (part as { text?: unknown }).text === "string")
        .map((part) => part.text)
        .join("")
    : typeof content === "string"
      ? content
      : "";

/** Reads one JSON event line from a harness. */
export function parseEvent(harness: RemoteHarness, line: string): HarnessEvent | undefined {
  let event: Record<string, any>;
  try {
    event = JSON.parse(line);
  } catch {
    return undefined;
  }
  if (!event || typeof event !== "object") return undefined;
  if (harness === "claude") {
    if (event.type === "system" && event.subtype === "init" && typeof event.session_id === "string") return { session: event.session_id };
    if (event.type === "system" && event.subtype === "api_retry")
      return { step: { tool: "model", target: `retrying after ${event.error_status ?? "an error"}${event.error ? ` (${event.error})` : ""}` } };
    if (event.type === "assistant" && Array.isArray(event.message?.content)) {
      const tool = event.message.content.find((part: any) => part?.type === "tool_use");
      if (tool) return { step: { tool: String(tool.name ?? "tool"), ...(targetOf(tool.input) && { target: targetOf(tool.input)! }) } };
      const text = textOf(event.message.content);
      return text ? { text } : undefined;
    }
    if (event.type === "result") {
      const text = typeof event.result === "string" ? event.result : "";
      if (event.is_error || (event.subtype && event.subtype !== "success")) return { error: text || String(event.subtype ?? "Claude Code failed") };
      return { final: text };
    }
    return undefined;
  }
  if (harness === "codex") {
    if (event.type === "thread.started" && typeof event.thread_id === "string") return { session: event.thread_id };
    if (event.type === "turn.failed") return { error: String(event.error?.message ?? "Codex failed") };
    const item = event.item;
    if (!item || typeof item !== "object") return undefined;
    if (event.type === "item.started") {
      if (item.type === "command_execution" && typeof item.command === "string") return { step: { tool: "shell", target: targetOf({ command: shellTarget(item.command) })! } };
      if (item.type === "file_change") return { step: { tool: "edit", ...(item.changes?.[0]?.path && { target: String(item.changes[0].path) }) } };
      if (item.type === "mcp_tool_call") return { step: { tool: String(item.tool ?? "tool"), ...(item.server && { target: String(item.server) }) } };
      if (item.type === "web_search") return { step: { tool: "web search", ...(item.query && { target: String(item.query) }) } };
      return undefined;
    }
    if (event.type === "item.completed" && item.type === "agent_message" && typeof item.text === "string") return { text: item.text };
    return undefined;
  }
  // Pi
  if (event.type === "session" && typeof event.id === "string") return { session: event.id };
  if (event.type === "tool_execution_start") return { step: { tool: String(event.toolName ?? "tool"), ...(targetOf(event.args) && { target: targetOf(event.args)! }) } };
  if (event.type === "message_end" && event.message?.role === "assistant") {
    if (event.message.stopReason === "error" && event.message.errorMessage) return { error: String(event.message.errorMessage) };
    const text = textOf(event.message.content);
    return text ? { text } : undefined;
  }
  return undefined;
}

// ── A turn ──

export type RemoteSession = Readonly<{ harness: RemoteHarness; id: string }>;

export type RemoteTurnInput = Readonly<{
  sandboxes: Sandboxes;
  /** The agent's sandbox ID. */
  sandbox: string;
  harness: RemoteHarness;
  model: string;
  permissions: Permissions;
  /** The conversation's harness session, when one exists for this harness. */
  session?: RemoteSession;
  prompt: string;
  system: string;
  signal: AbortSignal;
  /** The agent's Databricks tools, served by the runner bundle at RUNNER_PATH (the caller uploads it). */
  tools?: BridgeConfig;
  onStep?(tool: string, target?: string): void;
  /** The harness has its session; save it so a later turn continues it, even if this one fails. */
  onSession?(session: RemoteSession): void;
  /** The harness started, so the prompt reached it. */
  onLaunch?(): void;
  pollMs?: number;
  /** New IDs for runs and for sessions we name. */
  newId?(): string;
}>;

const sleep = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", stop);
      resolve();
    }, ms);
    const stop = () => {
      clearTimeout(timer);
      reject(signal.reason ?? new DOMException("Aborted", "AbortError"));
    };
    if (signal.aborted) return stop();
    signal.addEventListener("abort", stop, { once: true });
  });

const plain = (text: string) => text.replace(/\x1b\[[0-9;]*[A-Za-z]/g, "").replace(/[│╭╮╰╯─✔•]/g, "").trim();

/** The useful end of a harness's stderr, without the launcher's banner. */
export function stderrSummary(stderr: string): string {
  return plain(stderr)
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line && !/Unity Gateway|Databricks auth already|Launching |Starting |managed coding agent config|token refresh is managed|^is running\.?$/i.test(line))
    .slice(-4)
    .join(" ")
    .slice(0, 600);
}

/** A saved harness session that no longer exists (deleted, or from before a reset). */
const isLostSession = (error: unknown) => /no conversation found|no (saved )?session|session[^.]* not found|thread[^.]* not found|no rollout found/i.test((error as Error)?.message ?? "");

/**
 * Runs one turn of a harness in the agent's Sandbox and returns its reply. A
 * saved session the harness can't find any more starts over in a new one.
 */
export async function runRemoteTurn(input: RemoteTurnInput): Promise<{ text: string; session: RemoteSession }> {
  try {
    return await runTurn(input);
  } catch (error) {
    if (!input.session || input.signal.aborted || !isLostSession(error)) throw error;
    const { session: _lost, ...fresh } = input;
    return runTurn(fresh);
  }
}

async function runTurn(input: RemoteTurnInput): Promise<{ text: string; session: RemoteSession }> {
  const { sandboxes, sandbox, harness, signal } = input;
  const newId = input.newId ?? (() => crypto.randomUUID());
  const files = runFiles(`${RUNS_DIR}/${Date.now().toString(36)}-${newId().slice(0, 8)}`);
  // Claude Code and Pi continue a session ID we choose; Codex names its own.
  const known = input.session?.harness === harness ? input.session : undefined;
  let sessionId = known?.id ?? (harness === "codex" ? undefined : newId());
  const tools = hasBridgeTools(input.tools?.tools) ? { runner: RUNNER_PATH } : undefined;
  const command = harnessCommand({
    harness,
    model: input.model,
    permissions: input.permissions,
    session: sessionId ? { id: sessionId, resume: Boolean(known) } : undefined,
    files,
    ...(tools && { tools }),
  });
  if (tools) for (const file of toolFiles(harness, files, tools.runner, input.tools!)) await sandboxes.writeFile(sandbox, file.path, file.content, signal);
  // Codex has no system-prompt flag; a new Codex thread gets the instructions with its first message.
  const prompt = harness === "codex" && !known ? `<instructions>\n${input.system}\n</instructions>\n\n${input.prompt}` : input.prompt;
  await sandboxes.writeFile(sandbox, files.prompt, prompt, signal);
  await sandboxes.writeFile(sandbox, files.system, input.system, signal);
  await sandboxes.writeFile(sandbox, files.script, runScript(command, files), signal);
  const launched = await sandboxes.bash(sandbox, launchCommand(files), { timeoutSeconds: 30, signal });
  if (launched.exit_code !== 0) throw new Error(`Couldn't start ${harnessLabel(harness)}: ${launched.stderr?.trim() || `exit ${launched.exit_code}`}`);
  input.onLaunch?.();

  let from = 0;
  let exited = false;
  let announced = false;
  let text = "";
  let final: string | undefined;
  let error: string | undefined;
  let failures = 0;
  try {
    for (;;) {
      await sleep(input.pollMs ?? 2000, signal);
      let poll: { exit?: number; lines: string[] };
      try {
        const result = await sandboxes.bash(sandbox, pollCommand(files, from), { timeoutSeconds: 30, signal });
        poll = parsePoll(result.stdout ?? "");
        failures = 0;
      } catch (pollError) {
        if (signal.aborted) throw pollError;
        // A dropped poll is retried; the harness keeps running meanwhile.
        if (++failures >= 5) throw pollError;
        continue;
      }
      from += poll.lines.length;
      for (const line of poll.lines) {
        const event = parseEvent(harness, line);
        if (!event) continue;
        // Saved once the harness reports it, so a turn that never started one leaves none behind.
        if (event.session && (!announced || event.session !== sessionId)) {
          sessionId = event.session;
          announced = true;
          input.onSession?.({ harness, id: sessionId });
        }
        if (event.step) input.onStep?.(event.step.tool, event.step.target);
        if (event.text) text = event.text;
        if (event.final !== undefined) final = event.final;
        if (event.error) error = event.error;
      }
      // Done once the exit code is written and no more lines are waiting.
      if (poll.exit !== undefined) exited = true;
      if (exited && poll.lines.length === 0) {
        if (error) throw new Error(`${harnessLabel(harness)}: ${error}`);
        const reply = (final ?? text).trim();
        if (poll.exit !== 0 || !reply) {
          const stderr = await sandboxes.readFile(sandbox, files.stderr, signal).catch(() => "");
          throw new Error(`${harnessLabel(harness)} stopped (exit ${poll.exit})${stderrSummary(stderr) ? `: ${stderrSummary(stderr)}` : reply ? "" : " without a reply"}.`);
        }
        if (!sessionId) throw new Error(`${harnessLabel(harness)} didn't report its session.`);
        return { text: reply, session: { harness, id: sessionId } };
      }
    }
  } catch (failure) {
    // Stop a harness still running (Stop, timeout, lost polls); its session stays on disk.
    if (!exited) await sandboxes.bash(sandbox, killCommand(files), { timeoutSeconds: 30 }).catch(() => {});
    throw failure;
  } finally {
    void sandboxes.bash(sandbox, `rm -rf ${shellQuote(files.dir)}`, { timeoutSeconds: 30 }).catch(() => {});
  }
}

/** What a remote harness is told about where it is and how its answer reaches Buzz. */
export function remoteNote(harness: RemoteHarness, permissions: Permissions, tools: readonly Readonly<{ label: string }>[] = []): string {
  return [
    `<databricks-sandbox>`,
    `You are running as ${harnessLabel(harness)} inside your own Databricks Sandbox, a Linux machine in Databricks with Python, Node.js, git, the Databricks CLI (already signed in as your owner) and internet access. Your working folder is ${WORK_DIR}; files under ${SANDBOX_HOME} persist across restarts.`,
    "Your final message is posted to the Buzz conversation as your reply, so make it the answer itself, written for the people there. You don't have Buzz's own tools in this session.",
    harness === "pi" && permissions === "standard" ? "You can read, search and edit files, but you have no shell in this session." : "",
    tools.length
      ? `Your owner gave you these Databricks tools, which run with their access: ${tools.map((tool) => tool.label).join(", ")}. Use them for questions about data (Genie One finds the right tables and runs the SQL). If a tool says your owner hasn't logged in yet, give them its login link.`
      : "",
    "Never print secrets into the conversation.",
    `</databricks-sandbox>`,
  ]
    .filter(Boolean)
    .join("\n");
}
