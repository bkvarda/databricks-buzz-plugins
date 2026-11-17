// Compaction for Built-in Sandbox agents: when a conversation's oldest
// messages fall out of the saved session (see splitHistory in ./loop), the
// agent's own model folds them into a running summary, which goes in its
// system prompt from then on. Compact session does the same on request,
// keeping only the last few turns. Pure apart from the model call.
import type { ChatMessage } from "@dbx/core/api/ai";
import { HISTORY_CHARS, HISTORY_MESSAGES, splitHistory } from "./loop";
import type { Session } from "./state";

/** The longest summary kept, in characters (about 2,000 tokens). */
export const SUMMARY_MAX = 8_000;
/** What Compact session keeps word for word: about the last few turns. */
export const COMPACT_CHARS = 20_000;
export const COMPACT_MESSAGES = 12;
/** The most of the dropped messages the summarizer reads. */
const TRANSCRIPT_MAX = 120_000;

const clip = (text: string, max: number) => (text.length > max ? `${text.slice(0, max)} … (${text.length - max} more characters)` : text);

/** The messages as plain text for the summarizer: who said what, with tool calls and their results shortened. */
export function transcript(messages: readonly ChatMessage[], max = TRANSCRIPT_MAX): string {
  const lines = messages.map((message) => {
    if (message.role === "tool") return `[tool result] ${clip(message.content, 800)}`;
    if (message.role === "assistant") {
      const calls = (message.tool_calls ?? []).map((call) => `[called ${call.function.name}] ${clip(call.function.arguments, 300)}`);
      return [message.content ? `[agent] ${clip(message.content, 3_000)}` : "", ...calls].filter(Boolean).join("\n");
    }
    return `[${message.role === "user" ? "conversation" : message.role}] ${clip(message.content, 4_000)}`;
  });
  const text = lines.join("\n\n");
  if (text.length <= max) return text;
  // The start and the end of what fell off, if it's very long.
  return `${text.slice(0, max / 2)}\n\n… (${text.length - max} characters left out) …\n\n${text.slice(-max / 2)}`;
}

const INSTRUCTIONS =
  "You keep the running summary of a conversation in Buzz, a team chat, for an AI agent that takes part in it. The conversation's oldest messages no longer fit in the agent's context, so your summary stands in for them. Write it for the agent itself.";

/** The request that asks the model to fold `dropped` into `previous`. */
export function summaryRequest(previous: string | undefined, dropped: readonly ChatMessage[]): ChatMessage[] {
  return [
    { role: "system", content: INSTRUCTIONS },
    {
      role: "user",
      content: [
        previous ? `<previous_summary>\n${previous}\n</previous_summary>` : "",
        `<messages>\n${transcript(dropped)}\n</messages>`,
        `Write the updated summary${previous ? ", merging the previous summary with these messages into one" : ""}. Keep:
- what people asked for, and who asked;
- decisions, and why they were made;
- what was done, with exact names: files, commands, branches, pull requests, links, IDs and numbers;
- what is in progress or still to do, and anything the agent promised.
Leave out greetings, and tool output that no longer matters. Use short Markdown bullets under a few headings, at most 600 words. Reply with the summary only.`,
      ]
        .filter(Boolean)
        .join("\n\n"),
    },
  ];
}

/** Folds `dropped` into `previous` with the agent's model (`chat` returns its reply text). */
export async function summarize(
  chat: (messages: readonly ChatMessage[], signal: AbortSignal) => Promise<string>,
  previous: string | undefined,
  dropped: readonly ChatMessage[],
  signal: AbortSignal,
): Promise<string> {
  const text = (await chat(summaryRequest(previous, dropped), signal)).trim();
  if (!text) throw new Error("The model returned an empty summary.");
  return clip(text, SUMMARY_MAX);
}

/** The agent's system prompt, with the summary of what fell out of its context. */
export function withSummary(system: string, summary: string | undefined): string {
  if (!summary?.trim()) return system;
  return `${system}\n\n<earlier_in_this_conversation>\nThe start of this conversation no longer fits in your context. This is a summary of it, written as it fell out; read the conversation for anything it leaves out.\n\n${summary.trim()}\n</earlier_in_this_conversation>`;
}

/**
 * Saves a session within budget: messages that fall off are folded into its
 * summary first. Until that's done everything is kept, so a summary that fails
 * or is interrupted is tried again next turn, unless the session has grown
 * well past its budget, when the oldest just go.
 */
export async function keepWithinBudget(
  save: (session: Session) => Promise<void>,
  session: Session,
  messages: readonly ChatMessage[],
  chat: (messages: readonly ChatMessage[], signal: AbortSignal) => Promise<string>,
  signal: AbortSignal,
  onSummarizing?: () => void,
): Promise<void> {
  const { kept, dropped } = splitHistory(messages);
  if (!dropped.length) return save({ ...session, messages: kept });
  await save({ ...session, messages: [...dropped, ...kept] });
  try {
    onSummarizing?.();
    const summary = await summarize(chat, session.summary, dropped, signal);
    await save({ ...session, messages: kept, summary });
  } catch {
    const over = splitHistory(messages, HISTORY_CHARS * 2, HISTORY_MESSAGES * 2);
    if (over.dropped.length) await save({ ...session, messages: over.kept });
  }
}
