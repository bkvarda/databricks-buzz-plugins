// The agent loop for Databricks-model agents: a model served by Databricks
// (AI Gateway, OpenAI-compatible tool calling) drives Buzz's own tools
// through the harness kit's MCP handler, plus local tools such as a
// Databricks Sandbox. Pure orchestration, so it is unit-testable.
import type { ChatCompletion, ChatMessage, FunctionTool, ToolCall } from "@dbx/core/api/ai";
import { messageText } from "@dbx/core/api/ai";

export type McpHandler = (message: unknown) => Promise<unknown>;

export type LocalTool = Readonly<{
  name: string;
  description: string;
  parameters: Readonly<Record<string, unknown>>;
  run(args: Record<string, unknown>, signal: AbortSignal): Promise<string>;
}>;

export type LoopInput = Readonly<{
  model: string;
  system: string;
  history: readonly ChatMessage[];
  prompt: string;
  /** Buzz tools for this conversation (from the harness kit). */
  buzz?: McpHandler;
  /** Which Buzz tools to offer (default: all). */
  buzzFilter?(name: string): boolean;
  local?: readonly LocalTool[];
  chat(request: { model: string; messages: readonly ChatMessage[]; tools: readonly FunctionTool[]; signal: AbortSignal }): Promise<ChatCompletion>;
  signal: AbortSignal;
  maxSteps?: number;
  onStep?(tool: string, target?: string): void;
  /** What the model said alongside its tool calls, and any reasoning it returned. */
  onThought?(text: string): void;
}>;

export type LoopResult = Readonly<{
  /** The model's last text, when it ended without posting through a tool. */
  text: string;
  /** Whether a Buzz message tool posted a message during the turn. */
  posted: boolean;
  /** Whether that post was marked final. */
  final: boolean;
  /** New messages for the saved session (excluding the system prompt). */
  messages: readonly ChatMessage[];
  steps: number;
  usage: { prompt: number; completion: number };
}>;

const MESSAGE_TOOLS = new Set(["send", "reply_in_subthread"]);
const MAX_RESULT = 24_000;
const NAME = /^[a-zA-Z0-9_-]{1,64}$/;

type ListedTool = { name: string; description?: string; inputSchema?: Record<string, unknown> };

let rpcId = 0;
async function rpc(handler: McpHandler, method: string, params?: unknown): Promise<Record<string, unknown>> {
  const response = (await handler({ jsonrpc: "2.0", id: ++rpcId, method, ...(params !== undefined && { params }) })) as {
    result?: Record<string, unknown>;
    error?: { message?: string };
  };
  if (response?.error) throw new Error(response.error.message ?? `${method} failed`);
  return response?.result ?? {};
}

export async function buzzTools(handler: McpHandler): Promise<ListedTool[]> {
  const listed = await rpc(handler, "tools/list");
  return ((listed.tools as ListedTool[] | undefined) ?? []).filter((tool) => NAME.test(tool.name));
}

export function toFunction(tool: ListedTool): FunctionTool {
  const parameters = tool.inputSchema && typeof tool.inputSchema === "object" ? tool.inputSchema : { type: "object", properties: {} };
  return {
    type: "function",
    function: {
      name: tool.name,
      description: (tool.description ?? "").slice(0, 4000),
      parameters: { type: "object", properties: {}, ...parameters },
    },
  };
}

function clip(text: string) {
  return text.length > MAX_RESULT ? `${text.slice(0, MAX_RESULT)}\n… (${text.length - MAX_RESULT} more characters cut)` : text;
}

function parseArgs(call: ToolCall): Record<string, unknown> {
  try {
    const parsed = JSON.parse(call.function.arguments || "{}");
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

async function callBuzz(handler: McpHandler, name: string, args: Record<string, unknown>): Promise<{ text: string; error: boolean }> {
  const result = (await rpc(handler, "tools/call", { name, arguments: args })) as {
    content?: { type: string; text?: string }[];
    isError?: boolean;
  };
  const text = (result.content ?? []).map((part) => (part.type === "text" ? (part.text ?? "") : `[${part.type}]`)).join("\n");
  return { text: text || (result.isError ? "Error" : "OK"), error: Boolean(result.isError) };
}

/** Reasoning parts some models return in content: summaries or text. */
function reasoningText(content: unknown): string {
  if (!Array.isArray(content)) return "";
  return content
    .flatMap((part: { type?: string; summary?: { text?: string }[]; text?: string }) =>
      part?.type === "reasoning" ? (Array.isArray(part.summary) ? part.summary.map((entry) => entry?.text ?? "") : [part.text ?? ""]) : [],
    )
    .join("\n")
    .trim();
}

function target(args: Record<string, unknown>): string | undefined {
  for (const key of ["channel", "path", "command", "agent", "statement", "question", "query", "url"]) {
    const value = args[key];
    if (typeof value === "string" && value) return value.length > 60 ? `${value.slice(0, 57)}…` : value;
  }
  return undefined;
}

export async function runLoop(input: LoopInput): Promise<LoopResult> {
  const listed = (input.buzz ? await buzzTools(input.buzz) : []).filter((tool) => input.buzzFilter?.(tool.name) ?? true);
  const local = new Map((input.local ?? []).map((tool) => [tool.name, tool]));
  const buzzNames = new Set(listed.map((tool) => tool.name));
  const tools: FunctionTool[] = [
    ...listed.map(toFunction),
    ...[...local.values()].filter((tool) => !buzzNames.has(tool.name)).map((tool) => ({
      type: "function" as const,
      function: { name: tool.name, description: tool.description, parameters: tool.parameters },
    })),
  ];
  const added: ChatMessage[] = [{ role: "user", content: input.prompt }];
  const usage = { prompt: 0, completion: 0 };
  let posted = false;
  let final = false;
  let text = "";
  const maxSteps = input.maxSteps ?? 24;
  let steps = 0;
  while (steps < maxSteps) {
    input.signal.throwIfAborted();
    steps++;
    const completion = await input.chat({
      model: input.model,
      messages: [{ role: "system", content: input.system }, ...input.history, ...added],
      tools,
      signal: input.signal,
    });
    usage.prompt += completion.usage?.prompt_tokens ?? 0;
    usage.completion += completion.usage?.completion_tokens ?? 0;
    const choice = completion.choices[0];
    if (!choice) throw new Error("The model returned no answer.");
    const content = messageText(choice.message.content);
    const calls = choice.message.tool_calls ?? [];
    const reasoning = reasoningText(choice.message.content);
    if (reasoning) input.onThought?.(reasoning);
    if (calls.length && content.trim()) input.onThought?.(content);
    added.push({ role: "assistant", content: content || null, ...(calls.length && { tool_calls: calls }) });
    if (!calls.length) {
      text = content;
      break;
    }
    for (const call of calls) {
      input.signal.throwIfAborted();
      const args = parseArgs(call);
      const name = call.function.name;
      input.onStep?.(name, target(args));
      let result: string;
      try {
        const localTool = local.get(name);
        if (localTool && !buzzNames.has(name)) result = await localTool.run(args, input.signal);
        else if (input.buzz && buzzNames.has(name)) {
          const reply = await callBuzz(input.buzz, name, args);
          result = reply.error ? `Error: ${reply.text}` : reply.text;
          if (!reply.error && MESSAGE_TOOLS.has(name)) {
            posted = true;
            if (args.final === true) final = true;
          }
        } else result = `Error: there is no tool named ${name}.`;
      } catch (error) {
        result = `Error: ${(error as Error).message ?? String(error)}`;
      }
      added.push({ role: "tool", tool_call_id: call.id, content: clip(result) });
    }
    if (final) break;
  }
  return { text, posted, final, messages: added, steps, usage };
}

/** Keeps the saved session within budget, cutting at user turns so tool
 * results never lose the assistant message that asked for them. */
export function trimHistory(messages: readonly ChatMessage[], maxChars = 120_000, maxMessages = 120): ChatMessage[] {
  const size = (list: readonly ChatMessage[]) =>
    list.reduce((total, message) => total + (typeof message.content === "string" ? message.content.length : 0) + 200, 0);
  let start = 0;
  while ((size(messages.slice(start)) > maxChars || messages.length - start > maxMessages) && start < messages.length) {
    const next = messages.findIndex((message, index) => index > start && message.role === "user");
    if (next === -1) break;
    start = next;
  }
  return messages.slice(start);
}
