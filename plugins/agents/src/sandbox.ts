// Databricks Sandbox tools for a Databricks agent: each agent gets its own
// sandbox (a serverless Linux microVM with a persistent home directory,
// Python/Node/Rust and the Databricks CLI, signed in as the owner), created
// on first use and started again when it has stopped.
import { SANDBOX_HOME, Sandboxes, sandboxId } from "@dbx/core/api/sandbox";
import type { DatabricksService } from "@dbx/core/service";
import type { LocalTool } from "./loop";

export const sandboxFor = (pubkey: string) => sandboxId(`buzz-agent-${pubkey.slice(0, 12)}`);

export const SANDBOX_PROMPT = `<databricks-sandbox>
You have your own Databricks Sandbox: a Linux machine in Databricks with Python, Node.js, Rust, git, the Databricks CLI (already signed in as your owner) and internet access. Your working folder is ${SANDBOX_HOME}/work; relative paths in every sandbox tool are relative to it, and each sandbox_exec call is a fresh bash login shell that starts there. Files under ${SANDBOX_HOME} persist across restarts; other paths reset when the sandbox stops. Keep state in files. Use sandbox_read_file / sandbox_write_file / sandbox_list for files. Commands time out after the limit you give (default 120 seconds, up to 1800); start long jobs in the background with nohup and check on them. Never print secrets into conversations.
</databricks-sandbox>`;

const clip = (text: string, max = 20_000) => (text.length > max ? `${text.slice(0, max / 2)}\n… (${text.length - max} characters cut) …\n${text.slice(-max / 2)}` : text);

/** Creates or starts the agent's sandbox, with its work folder, and returns its API. */
export async function ensureAgentSandbox(service: DatabricksService, pubkey: string, agentName: string, signal: AbortSignal, onState?: (state: string) => void): Promise<Sandboxes> {
  const client = await service.ready(signal);
  const sandboxes = new Sandboxes(client);
  const id = sandboxFor(pubkey);
  await sandboxes.ensureRunning(id, {
    displayName: `Buzz agent: ${agentName}`.slice(0, 60),
    tags: { created_by: "buzz", buzz_agent: pubkey.slice(0, 16) },
    signal,
    ...(onState && { onState }),
  });
  await sandboxes.bash(id, `mkdir -p ${SANDBOX_HOME}/work`, { timeoutSeconds: 30, signal });
  return sandboxes;
}

export function sandboxTools(service: DatabricksService, pubkey: string, agentName: string, onState?: (state: string) => void): LocalTool[] {
  const id = sandboxFor(pubkey);
  let ready: Promise<void> | undefined;
  const ensure = async (signal: AbortSignal) => {
    ready ??= ensureAgentSandbox(service, pubkey, agentName, signal, onState).then(() => {}).catch((error) => {
      ready = undefined;
      throw error;
    });
    await ready;
    return new Sandboxes(await service.ready(signal));
  };
  return [
    {
      name: "sandbox_exec",
      description: "Runs a bash command in your Databricks Sandbox and returns its exit code, stdout and stderr.",
      parameters: {
        type: "object",
        properties: {
          command: { type: "string", description: "Bash command or script." },
          timeout_seconds: { type: "integer", description: "Limit, 1–1800 (default 120)." },
          cwd: { type: "string", description: `Working directory (default ${SANDBOX_HOME}/work).` },
        },
        required: ["command"],
      },
      async run(args, signal) {
        const command = String(args.command ?? "");
        if (!command.trim()) throw new Error("command is required");
        const timeout = Math.min(1800, Math.max(1, Number(args.timeout_seconds) || 120));
        const sandboxes = await ensure(signal);
        const result = await sandboxes.bash(id, command, {
          timeoutSeconds: timeout,
          cwd: typeof args.cwd === "string" && args.cwd ? args.cwd : `${SANDBOX_HOME}/work`,
          signal,
        });
        const status = result.status?.replace("EXECUTE_COMMAND_STATUS_", "").toLowerCase() ?? "completed";
        return [
          `exit_code: ${result.exit_code ?? "unknown"} (${status}${result.truncated ? ", output truncated" : ""})`,
          result.stdout ? `stdout:\n${clip(result.stdout)}` : "stdout: (empty)",
          result.stderr ? `stderr:\n${clip(result.stderr, 8_000)}` : "",
        ]
          .filter(Boolean)
          .join("\n");
      },
    },
    {
      name: "sandbox_read_file",
      description: "Reads a text file from your Databricks Sandbox.",
      parameters: { type: "object", properties: { path: { type: "string", description: "Absolute path, or relative to the work directory." } }, required: ["path"] },
      async run(args, signal) {
        const sandboxes = await ensure(signal);
        const path = String(args.path ?? "");
        return clip(await sandboxes.readFile(id, path.startsWith("/") ? path : `${SANDBOX_HOME}/work/${path}`, signal), 60_000);
      },
    },
    {
      name: "sandbox_write_file",
      description: "Writes (replaces) a text file in your Databricks Sandbox, creating parent directories.",
      parameters: {
        type: "object",
        properties: { path: { type: "string", description: "Absolute path, or relative to the work directory." }, content: { type: "string" } },
        required: ["path", "content"],
      },
      async run(args, signal) {
        const sandboxes = await ensure(signal);
        const raw = String(args.path ?? "");
        const path = raw.startsWith("/") ? raw : `${SANDBOX_HOME}/work/${raw}`;
        const parent = path.slice(0, path.lastIndexOf("/")) || "/";
        await sandboxes.bash(id, `mkdir -p ${JSON.stringify(parent)}`, { timeoutSeconds: 30, signal });
        await sandboxes.writeFile(id, path, String(args.content ?? ""), signal);
        return `Wrote ${String(args.content ?? "").length} characters to ${path}.`;
      },
    },
    {
      name: "sandbox_list",
      description: "Lists a directory in your Databricks Sandbox.",
      parameters: { type: "object", properties: { path: { type: "string", description: `Directory (default ${SANDBOX_HOME}/work).` } } },
      async run(args, signal) {
        const sandboxes = await ensure(signal);
        const path = typeof args.path === "string" && args.path ? args.path : `${SANDBOX_HOME}/work`;
        const entries = await sandboxes.listDirectory(id, path, signal);
        return (
          entries
            .sort((a, b) => Number(b.directory) - Number(a.directory) || a.name.localeCompare(b.name))
            .map((entry) => (entry.directory ? `${entry.name}/` : `${entry.name}${entry.size !== undefined ? `  (${entry.size} bytes)` : ""}`))
            .join("\n") || "(empty)"
        );
      },
    },
  ];
}
