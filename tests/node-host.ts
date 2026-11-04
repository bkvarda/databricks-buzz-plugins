// A Node implementation of the slice of Buzz's `Host` these plugins use, for
// tests and the local playground. It enforces the same rule Buzz does: only
// processes declared in the plugin manifest can start, with the declared
// arguments first and the caller's after.
import { spawn as nodeSpawn } from "node:child_process";
import { readFileSync } from "node:fs";
import type { Host } from "@buzz/author";

type Declared = { id: string; program: string; args?: string[] };

export function nodeHost(manifestPath: string): Host {
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as {
    host?: { processes?: Declared[] };
  };
  const declared = new Map(
    (manifest.host?.processes ?? []).map((process) => [process.id, process]),
  );
  const host: Partial<Host> = {
    async runCommand() {
      return null;
    },
    async request() {
      throw new Error("Not available in tests");
    },
    async spawn(id, options = {}) {
      const process = declared.get(id);
      if (!process) throw new Error(`Process ${id} is not declared`);
      const env = { ...globalThis.process.env };
      for (const [key, value] of Object.entries(options.env ?? {})) {
        if (value === null) delete env[key];
        else env[key] = value;
      }
      const child = nodeSpawn(
        process.program,
        [...(process.args ?? []), ...(options.args ?? [])],
        { env, stdio: ["pipe", "pipe", "pipe"] },
      );
      child.stdout.setEncoding("utf8");
      child.stderr.setEncoding("utf8");
      child.stdout.on("data", (data: string) => options.onStdout?.(data));
      child.stderr.on("data", (data: string) => options.onStderr?.(data));
      const exited = new Promise<number | null>((resolve, reject) => {
        child.on("error", reject);
        child.on("close", (code) => resolve(code));
      });
      return {
        write: (data: string) =>
          new Promise<void>((resolve, reject) =>
            child.stdin.write(data, (error) =>
              error ? reject(error) : resolve(),
            ),
          ),
        end: (data?: string) =>
          new Promise<void>((resolve) => child.stdin.end(data ?? "", resolve)),
        kill: async () => {
          child.kill("SIGTERM");
        },
        exited,
      };
    },
  };
  return host as Host;
}
