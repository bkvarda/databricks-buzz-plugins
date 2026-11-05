// Runs Claude Code, Codex or Pi for one turn inside the Sandbox, with the
// same commands and event parsing as hybrid agents (../src/remote.ts), but
// reading the harness's output live instead of polling it.
import { spawn } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { type BridgeConfig, hasBridgeTools, toolFiles } from "../src/harness-tools";
import { harnessCommand, harnessLabel, parseEvent, type Permissions, type RemoteHarness, runFiles, stderrSummary, WORK_DIR } from "../src/remote";
import { paths } from "./store";

export type LocalTurn = Readonly<{
  harness: RemoteHarness;
  model: string;
  permissions: Permissions;
  /** The conversation's harness session, if this harness has one. */
  session?: Readonly<{ id: string }>;
  prompt: string;
  system: string;
  signal: AbortSignal;
  /** Where the harness's process ID goes while it runs (for Stop). */
  pidFile: string;
  /** The agent's Databricks tools, served to the harness by this runner's bridge. */
  tools?: BridgeConfig;
  onStep?(tool: string, target?: string): void;
  onSession?(id: string): void;
}>;

const lostSession = (message: string) => /no conversation found|no (saved )?session|session[^.]* not found|thread[^.]* not found|no rollout found/i.test(message);

export async function runLocalTurn(turn: LocalTurn): Promise<{ text: string; session: string }> {
  try {
    return await once(turn);
  } catch (error) {
    if (!turn.session || turn.signal.aborted || !lostSession((error as Error).message)) throw error;
    const { session: _gone, ...fresh } = turn;
    return once(fresh);
  }
}

function once(turn: LocalTurn): Promise<{ text: string; session: string }> {
  const { harness } = turn;
  const id = crypto.randomUUID();
  const dir = join(paths.runs, `${Date.now().toString(36)}-${id.slice(0, 8)}`);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const files = runFiles(dir);
  let sessionId = turn.session?.id ?? (harness === "codex" ? undefined : crypto.randomUUID());
  const prompt = harness === "codex" && !turn.session ? `<instructions>\n${turn.system}\n</instructions>\n\n${turn.prompt}` : turn.prompt;
  writeFileSync(files.prompt, prompt, { mode: 0o600 });
  writeFileSync(files.system, turn.system, { mode: 0o600 });
  // This runner bundle is the bridge: the harness starts it as `node <this file> mcp tools.json`.
  const tools = hasBridgeTools(turn.tools?.tools) ? { runner: process.argv[1]! } : undefined;
  if (tools) for (const file of toolFiles(harness, files, tools.runner, turn.tools!)) writeFileSync(file.path, file.content, { mode: 0o600 });
  const command = harnessCommand({
    harness,
    model: turn.model,
    permissions: turn.permissions,
    session: sessionId ? { id: sessionId, resume: Boolean(turn.session) } : undefined,
    files,
    ...(tools && { tools }),
  });
  mkdirSync(WORK_DIR, { recursive: true });
  return new Promise((resolve, reject) => {
    // Its own process group, so Stop ends the harness and whatever it started.
    const child = spawn("bash", ["-lc", `cd '${WORK_DIR}' && ${command}`], { detached: true, stdio: ["ignore", "pipe", "pipe"] });
    writeFileSync(turn.pidFile, String(child.pid ?? ""), { mode: 0o600 });
    let text = "";
    let final: string | undefined;
    let error: string | undefined;
    let stderr = "";
    let announced = false;
    const kill = () => {
      if (!child.pid) return;
      try {
        process.kill(-child.pid, "SIGTERM");
      } catch {}
      setTimeout(() => {
        try {
          process.kill(-child.pid!, "SIGKILL");
        } catch {}
      }, 3000).unref();
    };
    turn.signal.addEventListener("abort", kill, { once: true });
    createInterface({ input: child.stdout! }).on("line", (line) => {
      const event = parseEvent(harness, line);
      if (!event) return;
      if (event.session && (!announced || event.session !== sessionId)) {
        sessionId = event.session;
        announced = true;
        turn.onSession?.(sessionId);
      }
      if (event.step) turn.onStep?.(event.step.tool, event.step.target);
      if (event.text) text = event.text;
      if (event.final !== undefined) final = event.final;
      if (event.error) error = event.error;
    });
    child.stderr!.on("data", (chunk) => (stderr = `${stderr}${chunk}`.slice(-8000)));
    child.on("close", (code) => {
      turn.signal.removeEventListener("abort", kill);
      rmSync(turn.pidFile, { force: true });
      rmSync(dir, { recursive: true, force: true });
      if (turn.signal.aborted) return reject(turn.signal.reason ?? new DOMException("Aborted", "AbortError"));
      if (error) return reject(new Error(`${harnessLabel(harness)}: ${error}`));
      const reply = (final ?? text).trim();
      if (code !== 0 || !reply) return reject(new Error(`${harnessLabel(harness)} stopped (exit ${code})${stderrSummary(stderr) ? `: ${stderrSummary(stderr)}` : ""}.`));
      if (!sessionId) return reject(new Error(`${harnessLabel(harness)} didn't report its session.`));
      resolve({ text: reply, session: sessionId });
    });
  });
}
