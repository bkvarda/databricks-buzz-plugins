// Runs a process the plugin's manifest declares in `host.processes`.
// Buzz resolves the program on its own search path (Homebrew and ~/.local/bin
// included on macOS), passes the declared arguments first, then ours.
import type { Host } from "@buzz/author";

export class DesktopOnlyError extends Error {
  constructor() {
    super("This needs the Buzz desktop app.");
    this.name = "DesktopOnlyError";
  }
}

export class ProcessError extends Error {
  constructor(
    message: string,
    readonly code: number | null,
    readonly stdout: string,
    readonly stderr: string,
  ) {
    super(message);
    this.name = "ProcessError";
  }
}

export type RunOptions = Readonly<{
  args?: readonly string[];
  /** Written to stdin, which is then closed. Stdin is always closed so a
   * program that would prompt fails instead of waiting forever. */
  input?: string;
  env?: Readonly<Record<string, string | null>>;
  signal?: AbortSignal;
  /** Kills the process after this many milliseconds. */
  timeoutMs?: number;
  onStdout?(data: string): void;
  onStderr?(data: string): void;
}>;

export type RunResult = Readonly<{
  code: number | null;
  stdout: string;
  stderr: string;
}>;

export async function runProcess(
  host: Host,
  id: string,
  options: RunOptions = {},
): Promise<RunResult> {
  if (!host.spawn) throw new DesktopOnlyError();
  options.signal?.throwIfAborted();
  let stdout = "";
  let stderr = "";
  const child = await host.spawn(id, {
    ...(options.args && { args: options.args }),
    ...(options.env && { env: options.env }),
    onStdout(data) {
      stdout += data;
      options.onStdout?.(data);
    },
    onStderr(data) {
      stderr += data;
      options.onStderr?.(data);
    },
  });
  let timedOut = false;
  const kill = () => void child.kill().catch(() => {});
  const timer =
    options.timeoutMs === undefined
      ? undefined
      : setTimeout(() => {
          timedOut = true;
          kill();
        }, options.timeoutMs);
  options.signal?.addEventListener("abort", kill, { once: true });
  try {
    await child.end(options.input ?? "").catch(() => {
      // A program that exits before reading stdin closes the pipe first.
    });
    const code = await child.exited;
    options.signal?.throwIfAborted();
    if (timedOut)
      throw new ProcessError("Timed out", code, stdout, stderr);
    return { code, stdout, stderr };
  } finally {
    if (timer) clearTimeout(timer);
    options.signal?.removeEventListener("abort", kill);
  }
}
