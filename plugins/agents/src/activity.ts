// What a Databricks agent is doing, in words people read: the one-line step
// Buzz shows under a request (`delivery.step(tool, target)`), and the turn
// records our Activity tab shows (steps and thinking). Shared by the plugin and
// the hosted runner, which also sends the steps to Buzz as activity frames.
//
// Buzz phrases a few tool names itself (Bash shows the command, Read and Edit
// the file, and so on) and shows any other step as "tool · target", so a step
// names a tool Buzz knows, or is already a phrase.

export type Step = Readonly<{ tool: string; target?: string }>;

/** Display labels for an agent's own tools: a Genie tool's name, or an MCP server's tool prefix, to its label. */
export type ToolLabels = ReadonlyMap<string, string>;

const BUZZ_TOOLS = new Set(["Bash", "Read", "Write", "Edit", "MultiEdit", "NotebookEdit", "Grep", "Glob", "ListFiles", "WebFetch", "WebSearch", "Task", "Agent", "TodoWrite", "send", "send_message", "read"]);

/** Harness tool names Buzz knows under another name (Codex, Pi, the Built-in Sandbox tools). */
const ALIASES: Readonly<Record<string, string>> = {
  shell: "Bash",
  bash: "Bash",
  exec_command: "Bash",
  sandbox_exec: "Bash",
  read_file: "Read",
  sandbox_read_file: "Read",
  write: "Write",
  write_file: "Write",
  sandbox_write_file: "Write",
  edit: "Edit",
  apply_patch: "Edit",
  grep: "Grep",
  find: "Glob",
  glob: "Glob",
  ls: "ListFiles",
  sandbox_list: "ListFiles",
  "web search": "WebSearch",
  web_search: "WebSearch",
  fetch: "WebFetch",
  web_fetch: "WebFetch",
  update_plan: "TodoWrite",
};

/** Databricks tools, by the names the Built-in loop and the bridge give them. */
const PHRASES: Readonly<Record<string, string>> = {
  genie_one_ask: "Asking Genie One",
  databricks_genie_one_ask: "Asking Genie One",
  databricks_genie_ask: "Asking Genie",
  databricks_genie_list: "Listing Genie agents",
  databricks_sql_query: "Running SQL",
  databricks_sql_warehouses: "Finding a SQL warehouse",
  databricks_catalog_list: "Browsing the catalog",
  databricks_table_describe: "Reading a table",
  model: "Waiting for the model",
};

const SANDBOX_STATES: Readonly<Record<string, string>> = {
  "Creating sandbox": "Creating its Sandbox",
  "Starting sandbox": "Starting its Sandbox",
  "Waiting for sandbox to stop": "Waiting for its Sandbox",
};

const humanize = (name: string) => name.replace(/[_-]+/g, " ").replace(/\s+/g, " ").trim();

/** One line, at most `max` characters. */
export function snippet(text: string, max = 100): string {
  const line = text.replace(/\s+/g, " ").trim();
  return line.length > max ? `${line.slice(0, max - 1).trimEnd()}…` : line;
}

/** The step to show for a tool call, from any of our harnesses. */
export function describeStep(tool: string, target?: string, labels?: ToolLabels): Step {
  const withTarget = (name: string, value = target): Step => (value ? { tool: name, target: snippet(value, 120) } : { tool: name });
  // Claude Code names MCP tools mcp__<server>__<tool>.
  const name = tool.replace(/^mcp__[a-zA-Z0-9_-]+?__/, "");
  if (BUZZ_TOOLS.has(name)) return withTarget(name);
  const alias = ALIASES[name] ?? ALIASES[name.toLowerCase()];
  if (alias) return withTarget(alias);
  if (name === "sandbox") return { tool: SANDBOX_STATES[target ?? ""] ?? "Starting its Sandbox" };
  if (name === "databricks_sql_query") return withTarget("Running SQL", target?.split("\n").find((line) => line.trim()));
  const phrase = PHRASES[name];
  if (phrase) return withTarget(phrase);
  const label = labels?.get(name);
  if (/^genie_.+_ask$/.test(name)) return withTarget(`Asking ${label ?? `Genie (${humanize(name.slice(6, -4))})`}`);
  const server = /^(.+?)__(.+)$/.exec(name);
  if (server) {
    const serverLabel = labels?.get(server[1]!) ?? humanize(server[1]!);
    if (server[2] === "log_in") return { tool: `Checking the ${serverLabel} login` };
    if (server[2] === "unavailable") return { tool: `${serverLabel} isn't available` };
    return withTarget(`Using ${serverLabel}`, [humanize(server[2]!), target].filter(Boolean).join(": "));
  }
  return withTarget(humanize(name) || "Working");
}

/** A thought as a step: Codex's reasoning has a bold title first, which says it best. */
export function thoughtStep(text: string): Step {
  const title = /^\s*\*\*(.+?)\*\*/.exec(text)?.[1];
  const line = title ?? text.split("\n").find((part) => part.trim()) ?? "";
  return line.trim() ? { tool: "Thinking", target: snippet(line, 110) } : { tool: "Thinking" };
}

/** A Genie One progress line ("Thinking: …", "Running SQL: …") as a step. */
export const genieOneStep = (line: string): Step => (line.trim() ? { tool: "Genie One", target: snippet(line, 120) } : { tool: "Asking Genie One" });

/** A wait while Databricks rate-limits Genie One, as a step: "Rate-limited · trying again in 4 s (retry 2)". */
export const rateLimitStep = (notice: Readonly<{ attempt: number; waitMs: number; restarted?: boolean }>): Step => ({
  tool: "Rate-limited",
  target: `${notice.restarted ? "asking Genie One again" : "trying again"} in ${Math.max(1, Math.round(notice.waitMs / 1000))} s (retry ${notice.attempt})`,
});

/** A Genie agent's message status as a step. */
export function genieStatusStep(label: string, status: string): Step {
  const phrase: Record<string, string> = {
    SUBMITTED: "sent the question",
    FILTERING_CONTEXT: "finding the right data",
    FETCHING_METADATA: "reading the tables",
    ASKING_AI: "writing the SQL",
    PENDING_WAREHOUSE: "waiting for the SQL warehouse",
    EXECUTING_QUERY: "running the query",
    COMPLETED: "answered",
  };
  return { tool: `Asking ${label}`, target: phrase[status] ?? humanize(status.toLowerCase()) };
}

/** How our Activity tab says a step (Buzz's own phrasing, for the tools it knows). */
export function stepText(step: Step): string {
  const t = step.target;
  if (t) {
    const phrased: Record<string, string> = {
      Bash: `Running ${t}`,
      Read: `Reading ${t}`,
      Write: `Writing ${t}`,
      Edit: `Editing ${t}`,
      MultiEdit: `Editing ${t}`,
      Grep: `Searching for ${t}`,
      Glob: `Finding ${t}`,
      ListFiles: `Listing ${t}`,
      WebFetch: `Reading ${t}`,
      WebSearch: `Searching the web for ${t}`,
    };
    return phrased[step.tool] ?? `${step.tool} · ${t}`;
  }
  const bare: Record<string, string> = {
    Bash: "Running a command",
    Read: "Reading a file",
    Write: "Writing a file",
    Edit: "Editing a file",
    Grep: "Searching files",
    Glob: "Finding files",
    ListFiles: "Listing files",
    WebSearch: "Searching the web",
    TodoWrite: "Updating its plan",
    send: "Sending a message",
    send_message: "Sending a message",
    read: "Reading the conversation",
  };
  return bare[step.tool] ?? step.tool;
}

/** ACP's tool kinds, which Buzz turns into its live label for hosted agents ("Reading x", "Searching"…). */
export function acpKind(step: Step): string {
  const kinds: Record<string, string> = { Bash: "execute", Read: "read", Write: "edit", Edit: "edit", MultiEdit: "edit", Grep: "search", Glob: "search", ListFiles: "search", WebFetch: "fetch", WebSearch: "fetch", Thinking: "think" };
  if (kinds[step.tool]) return kinds[step.tool]!;
  if (/^(Asking|Running SQL|Reading a table|Browsing|Listing|Genie One)/.test(step.tool)) return "search";
  return "other";
}

// ── Turn records ──

export type ActivityItem = Readonly<{ at: number; kind: "step" | "thought" | "note"; text: string }>;

export type ActivityTurn = {
  id: string;
  channelId?: string;
  /** The thread's root, for a thread conversation. */
  root?: string;
  startedAt: number;
  endedAt?: number;
  /** What was asked, shortened. */
  request?: string;
  items: ActivityItem[];
  outcome?: "done" | "error" | "stopped";
  error?: string;
};

const MAX_ITEMS = 200;
const MAX_THOUGHT = 4000;

/** Adds an item, merging a repeat of the last one (a harness can report the same step twice). */
export function addItem(turn: ActivityTurn, item: ActivityItem) {
  const text = item.kind === "thought" ? item.text.trim().slice(0, MAX_THOUGHT) : item.text;
  if (!text) return;
  const last = turn.items[turn.items.length - 1];
  if (last && last.kind === item.kind && last.text === text) return;
  turn.items.push({ ...item, text });
  if (turn.items.length > MAX_ITEMS) turn.items.splice(0, turn.items.length - MAX_ITEMS);
}

/** One line of a hosted runner's activity log (activity.jsonl). */
export type ActivityLine = Readonly<{
  turn: string;
  at: number;
  type: "start" | "step" | "thought" | "note" | "end";
  text?: string;
  channel?: string;
  root?: string;
  outcome?: ActivityTurn["outcome"];
  error?: string;
}>;

/** Rebuilds turns from a runner's activity log, newest first. */
export function turnsFromLines(lines: readonly ActivityLine[]): ActivityTurn[] {
  const turns = new Map<string, ActivityTurn>();
  for (const line of lines) {
    let turn = turns.get(line.turn);
    if (!turn) {
      turn = { id: line.turn, startedAt: line.at, items: [] };
      turns.set(line.turn, turn);
    }
    if (line.type === "start") {
      turn.startedAt = line.at;
      if (line.channel) turn.channelId = line.channel;
      if (line.root) turn.root = line.root;
      if (line.text) turn.request = line.text;
    } else if (line.type === "end") {
      turn.endedAt = line.at;
      turn.outcome = line.outcome ?? "done";
      if (line.error) turn.error = line.error;
    } else if (line.text) addItem(turn, { at: line.at, kind: line.type, text: line.text });
  }
  return [...turns.values()].sort((a, b) => b.startedAt - a.startedAt);
}
