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
  chat(request: { model: string; messages: readonly ChatMessage[]; tools: readonly FunctionTool[]; maxTokens: number; signal: AbortSignal }): Promise<ChatCompletion>;
  signal: AbortSignal;
  /** Model responses per turn (default 100). */
  maxSteps?: number;
  /** When the turn has to wrap up (epoch ms), ahead of its hard time limit. */
  deadline?: number;
  /** Characters of this turn's own messages to send before older tool results are cleared (default 240,000). */
  maxTurnChars?: number;
  /** Output tokens per model response (default 16,000; a model with a lower ceiling gets its own). */
  maxTokens?: number;
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
  /**
   * Set when the turn ran out of steps or time before the model finished. The
   * model is asked to post where things stand; `notice` is what to post when
   * it didn't (its last text, or a plain note), so a turn never ends silently.
   */
  unfinished?: Readonly<{ reason: "steps" | "time"; notice?: string }>;
}>;

const MESSAGE_TOOLS = new Set(["send", "reply_in_subthread"]);
const MAX_RESULT = 24_000;
const NAME = /^[a-zA-Z0-9_-]{1,64}$/;
/** Enough for a sizeable file in one tool call, and well inside the chat request's time limit. */
const MAX_TOKENS = 16_000;
/** Responses cut off at the output limit in a row before the turn gives up. */
const MAX_CUTOFFS = 2;
/** A long piece of work (reading, building, testing) in one turn: about 25 minutes of steps. */
const MAX_STEPS = 100;
/** Responses the model gets to post where things stand once the turn is out of steps or time. */
const WRAP_UP_RESPONSES = 2;
/** This turn's messages, roughly 60,000 tokens, before older tool results are cleared to make room. */
const MAX_TURN_CHARS = 240_000;
/** Recent messages whose tool results are always kept. */
const KEEP_RECENT = 8;
const CLEARED = "(This output was cleared to keep the conversation within the model's context. Run it again if you need it.)";

const wrapUpNote = (reason: "steps" | "time", steps: number) =>
  `(This turn is out of ${reason === "steps" ? `steps (${steps})` : "time"}. Don't start anything new: use send with final: true to say what's done, what's left, and that you'll carry on when you're mentioned again.)`;

const stoppedNotice = (reason: "steps" | "time", steps: number) =>
  `I stopped before finishing: this turn ${reason === "steps" ? `used its ${steps} steps` : "ran out of time"}. Mention me to carry on from here.`;

const charsOf = (message: ChatMessage) =>
  (typeof message.content === "string" ? message.content.length : 0) + (message.role === "assistant" && message.tool_calls ? JSON.stringify(message.tool_calls).length : 0);

/** Clears the oldest long tool results until this turn's messages fit, keeping the recent ones and every message's place. */
export function clearOldResults(messages: ChatMessage[], maxChars: number): void {
  let total = messages.reduce((sum, message) => sum + charsOf(message), 0);
  for (let i = 0; i < messages.length - KEEP_RECENT && total > maxChars; i++) {
    const message = messages[i]!;
    if (message.role !== "tool" || message.content.length <= CLEARED.length * 2) continue;
    total -= message.content.length - CLEARED.length;
    messages[i] = { ...message, content: CLEARED };
  }
}

/**
 * Whether a saved message can go back to the model: an assistant message with
 * neither text nor tool calls can't (Claude rejects `content: null`), and
 * earlier versions saved one when a response came back empty.
 */
export function sendable(message: ChatMessage): boolean {
  return message.role !== "assistant" || Boolean(message.content) || Boolean(message.tool_calls?.length);
}

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
  const history = input.history.filter(sendable);
  const maxTokens = input.maxTokens ?? MAX_TOKENS;
  const usage = { prompt: 0, completion: 0 };
  let posted = false;
  let final = false;
  let text = "";
  // A reply cut off at the output limit, continued in the next response.
  let partial = "";
  let cutoffs = 0;
  const maxSteps = input.maxSteps ?? MAX_STEPS;
  let steps = 0;
  // Out of steps or time: the model gets a few responses to post where things stand.
  let wrapping: "steps" | "time" | undefined;
  let wrapResponses = 0;
  let wrapPosted = false;
  for (;;) {
    input.signal.throwIfAborted();
    if (!wrapping) {
      wrapping = steps >= maxSteps ? "steps" : input.deadline !== undefined && Date.now() >= input.deadline ? "time" : undefined;
      if (wrapping) added.push({ role: "user", content: wrapUpNote(wrapping, steps) });
    }
    if (wrapping && wrapResponses++ >= WRAP_UP_RESPONSES) break;
    steps++;
    clearOldResults(added, input.maxTurnChars ?? MAX_TURN_CHARS);
    const completion = await input.chat({
      model: input.model,
      messages: [{ role: "system", content: input.system }, ...history, ...added],
      tools,
      maxTokens,
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
    // Stopped at the output limit before it finished: a tool call that long
    // arrives as nothing at all. Say so and let it go on, in smaller steps.
    if (!calls.length && choice.finish_reason === "length") {
      if (++cutoffs > MAX_CUTOFFS)
        throw new Error("The model's responses kept stopping at its output limit before they were complete. Ask for smaller steps, such as writing a large file in parts.");
      if (content.trim()) {
        partial += content;
        added.push({ role: "assistant", content });
        added.push({ role: "user", content: "(Your reply stopped at the output limit. Continue exactly where it stopped, without repeating anything.)" });
      } else
        added.push({
          role: "user",
          content: "(Your last response stopped at the output limit before it was complete, so none of it arrived, not even its tool call. Do it in smaller steps: write a large file in several parts, or run shorter commands.)",
        });
      continue;
    }
    cutoffs = 0;
    // A response with neither text nor tool calls isn't kept: it can't be sent back.
    if (content || calls.length) added.push({ role: "assistant", content: content || null, ...(calls.length && { tool_calls: calls }) });
    if (!calls.length) {
      text = partial + content;
      break;
    }
    partial = "";
    for (const call of calls) {
      input.signal.throwIfAborted();
      const args = parseArgs(call);
      const name = call.function.name;
      input.onStep?.(name, target(args));
      let result: string;
      try {
        const localTool = local.get(name);
        if (wrapping && !MESSAGE_TOOLS.has(name)) result = "Error: this turn is out of steps or time, so nothing new runs. Post where things stand with send (final: true).";
        else if (localTool && !buzzNames.has(name)) result = await localTool.run(args, input.signal);
        else if (input.buzz && buzzNames.has(name)) {
          const reply = await callBuzz(input.buzz, name, args);
          result = reply.error ? `Error: ${reply.text}` : reply.text;
          if (!reply.error && MESSAGE_TOOLS.has(name)) {
            posted = true;
            if (wrapping) wrapPosted = true;
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
  // Out of steps or time and the model didn't post where things stand: say it for it.
  const unfinished = wrapping && !final ? { reason: wrapping, ...(!wrapPosted && { notice: text.trim() || stoppedNotice(wrapping, maxSteps) }) } : undefined;
  return { text, posted, final, messages: added, steps, usage, ...(unfinished && { unfinished }) };
}

/** A saved session's budget: the characters and messages kept before the oldest turns fall off. */
export const HISTORY_CHARS = 120_000;
export const HISTORY_MESSAGES = 120;

/**
 * Splits a saved session into what stays within budget and what falls off,
 * cutting at user turns so tool results never lose the assistant message that
 * asked for them. Messages that can't be sent back (see sendable) go neither way.
 */
export function splitHistory(all: readonly ChatMessage[], maxChars = HISTORY_CHARS, maxMessages = HISTORY_MESSAGES): { kept: ChatMessage[]; dropped: ChatMessage[] } {
  const messages = all.filter(sendable);
  const size = (list: readonly ChatMessage[]) =>
    list.reduce((total, message) => total + (typeof message.content === "string" ? message.content.length : 0) + 200, 0);
  let start = 0;
  while ((size(messages.slice(start)) > maxChars || messages.length - start > maxMessages) && start < messages.length) {
    const next = messages.findIndex((message, index) => index > start && message.role === "user");
    if (next === -1) break;
    start = next;
  }
  return { kept: messages.slice(start), dropped: messages.slice(0, start) };
}

/** The part of a saved session that stays within budget (see splitHistory). */
export function trimHistory(all: readonly ChatMessage[], maxChars = HISTORY_CHARS, maxMessages = HISTORY_MESSAGES): ChatMessage[] {
  return splitHistory(all, maxChars, maxMessages).kept;
}
