// What the tasks board shows, apart from how it draws it: each task's
// assignee, the filters, and the list and swimlane views' groups.
import type { BoardPerson, BoardTask } from "./client";

/** The views of the board: rows grouped by status, or a column per status. */
export const VIEWS = ["list", "swimlanes"] as const;
export type BoardView = (typeof VIEWS)[number];

/** The statuses, in the board's order; done and dismissed show the last two weeks. */
export const STATUS_GROUPS = [
  { status: "waiting", title: "Needs input" },
  { status: "open", title: "Open" },
  { status: "in_progress", title: "In progress" },
  { status: "done", title: "Done" },
  { status: "dismissed", title: "Dismissed" },
] as const;

/**
 * Who a task is with, the one name its card shows: you, when it waits on a
 * person's input; otherwise the agent that replied in its thread, or the
 * one asked; otherwise no one.
 */
export type Assignee = Readonly<{ kind: "you" } | { kind: "agent"; key: string; label: string } | { kind: "unassigned" }>;

export function assigneeOf(item: BoardTask): Assignee {
  const open = item.task.status !== "done" && item.task.status !== "dismissed";
  if (open && item.task.question) return { kind: "you" };
  const agents = item.people.filter((person): person is BoardPerson & { kind: "agent" } => person.kind === "agent");
  const agent = agents.find((person) => person.role === "replied") ?? agents[0];
  return agent ? { kind: "agent", key: agent.key, label: agent.label } : { kind: "unassigned" };
}

/** An assignee as a filter value: "you", "unassigned" or "agent:<hex>". */
export const assigneeValue = (assignee: Assignee) => (assignee.kind === "agent" ? `agent:${assignee.key}` : assignee.kind);

/** The board's filters; an empty one keeps every task. */
export type BoardFilters = Readonly<{ status?: string; workstream?: string; assignee?: string; mode?: string; search?: string }>;

/** The tasks the filters keep, in the board's order. Search matches the id, title, workstream, initiative, source and its title, any case. */
export function filterTasks(tasks: readonly BoardTask[], filters: BoardFilters): BoardTask[] {
  const words = (filters.search ?? "").toLowerCase().split(/\s+/).filter(Boolean);
  return tasks.filter((item) => {
    const { task } = item;
    if (filters.status && task.status !== filters.status) return false;
    if (filters.workstream && (task.workstream ?? "") !== (filters.workstream === NONE ? "" : filters.workstream)) return false;
    if (filters.mode && task.mode !== filters.mode) return false;
    if (filters.assignee && assigneeValue(assigneeOf(item)) !== filters.assignee) return false;
    if (!words.length) return true;
    const haystack = [`#${task.id}`, task.title, task.workstream, task.initiative, item.source?.source, item.source?.title].filter(Boolean).join(" ").toLowerCase();
    return words.every((word) => haystack.includes(word));
  });
}

/** The workstream filter's value for tasks without one. */
export const NONE = "(none)";

/** Each filter's choices, from the tasks on the board, with how many tasks each keeps. */
export function filterOptions(tasks: readonly BoardTask[]): {
  workstreams: { value: string; count: number }[];
  modes: { value: string; count: number }[];
  assignees: { value: string; assignee: Assignee; count: number }[];
} {
  const count = <T>(map: Map<string, { value: string; count: number } & T>, value: string, extra: T) => {
    const found = map.get(value);
    if (found) found.count++;
    else map.set(value, { value, count: 1, ...extra });
  };
  const workstreams = new Map<string, { value: string; count: number }>();
  const modes = new Map<string, { value: string; count: number }>();
  const assignees = new Map<string, { value: string; assignee: Assignee; count: number }>();
  for (const item of tasks) {
    count(workstreams, item.task.workstream ?? NONE, {});
    count(modes, item.task.mode, {});
    const assignee = assigneeOf(item);
    count(assignees, assigneeValue(assignee), { assignee });
  }
  const order = { you: 0, agent: 1, unassigned: 2 } as const;
  return {
    workstreams: [...workstreams.values()].sort((a, b) => (a.value === NONE ? 1 : b.value === NONE ? -1 : a.value.localeCompare(b.value))),
    modes: [...modes.values()].sort((a, b) => a.value.localeCompare(b.value)),
    assignees: [...assignees.values()].sort((a, b) => order[a.assignee.kind] - order[b.assignee.kind] || a.value.localeCompare(b.value)),
  };
}

/** The tasks of each status, in the board's order (latest activity first). */
export function byStatus(tasks: readonly BoardTask[]): Map<string, BoardTask[]> {
  const out = new Map<string, BoardTask[]>(STATUS_GROUPS.map((group) => [group.status, []]));
  for (const item of tasks) out.get(item.task.status)?.push(item);
  return out;
}

/**
 * The assets a card shows: links made for the task, not the record of the
 * agent's reply (the thread has it) and not workspace links, which agents
 * like Genie add to every reply.
 */
export const cardAssets = (item: BoardTask) => item.artifacts.filter((artifact) => /^https?:/.test(artifact.url) && !["reply", "draft", "workspace"].includes(artifact.kind));

/** A view from storage or a link, or the list. */
export const readView = (value: unknown): BoardView => (VIEWS as readonly unknown[]).includes(value) ? (value as BoardView) : "list";

/** A message in a task's thread, as the task view shows it: a comment. */
export type Comment = Readonly<{ id: string; author: string; at: number; text: string; agents: boolean; pending: boolean }>;

/** The thread's messages as comments, oldest first, without empty ones. `agents` marks coordination between agents, shown quietly. */
export function threadComments(messages: readonly Readonly<{ id: string; authorId: string; createdAt: number; content: string; audience?: "agents"; delivery?: unknown }>[]): Comment[] {
  return messages
    .filter((message) => message.content.trim())
    .map((message) => ({ id: message.id, author: message.authorId, at: message.createdAt, text: message.content, agents: message.audience === "agents", pending: message.delivery !== undefined && message.delivery !== "delivered" }))
    .sort((a, b) => a.at - b.at);
}

/**
 * Who a reply from the task view mentions: its assignee when that's an
 * agent, so the agent on it wakes up; no one when the task is with you or no
 * one (it goes in the thread for the record).
 */
export const replyMentions = (assignee: Assignee): string[] => (assignee.kind === "agent" ? [assignee.key] : []);

/** A reply's text: the mention first (as nostr:npub…, which Buzz shows as the name), then what you wrote. */
export function replyText(text: string, mentions: readonly { npub: string }[]): string {
  const body = text.trim();
  return mentions.length ? `${mentions.map((mention) => `nostr:${mention.npub}`).join(" ")} ${body}` : body;
}

/** The task's details, as label and value pairs, for its view. */
export function taskFacts(item: BoardTask): { label: string; value: string }[] {
  const { task } = item;
  const date = (seconds: number) => new Date(seconds * 1000).toISOString().slice(0, 16).replace("T", " ") + " UTC";
  return [
    { label: "Status", value: STATUS_GROUPS.find((group) => group.status === task.status)?.title ?? task.status },
    { label: "Mode", value: task.mode },
    ...(task.workstream ? [{ label: "Workstream", value: task.workstream }] : []),
    ...(task.initiative ? [{ label: "Initiative", value: task.initiative }] : []),
    ...(task.account ? [{ label: "Account", value: task.account }] : []),
    ...(item.source ? [{ label: "Source", value: item.source.title ? `${item.source.source}: ${item.source.title}` : item.source.source }] : []),
    { label: "Opened", value: date(task.created_at) },
    { label: "Last event", value: `${date(task.last_event_at)}${task.event_count > 1 ? ` (${task.event_count} events)` : ""}` },
  ];
}
