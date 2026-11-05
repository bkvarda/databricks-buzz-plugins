// Puts the runner bundle (embedded in this plugin by scripts/build.mjs) into a
// Sandbox: hosted agents run it, and every Sandbox harness uses it as the
// Databricks tools bridge. Skipped when the Sandbox already has this build.
import type { Sandboxes } from "@dbx/core/api/sandbox";
import { RUNNER, RUNNER_SHA } from "virtual:agent-runner";
import { RUNNER_PATH } from "./harness-tools";
import { shellQuote } from "./remote";

const SHA_PATH = RUNNER_PATH.replace(/\.mjs$/, ".sha");

/** Resolves true when it put a new build there (a running runner then needs a restart to use it). */
export async function uploadRunner(sandboxes: Sandboxes, sandbox: string, signal?: AbortSignal): Promise<boolean> {
  const current = await sandboxes.bash(sandbox, `cat ${shellQuote(SHA_PATH)} 2>/dev/null`, { timeoutSeconds: 30, ...(signal && { signal }) });
  if (current.stdout?.trim() === RUNNER_SHA) return false;
  await sandboxes.writeFile(sandbox, RUNNER_PATH, RUNNER, signal);
  await sandboxes.bash(sandbox, `echo ${RUNNER_SHA} > ${shellQuote(SHA_PATH)}`, { timeoutSeconds: 30, ...(signal && { signal }) });
  return true;
}
