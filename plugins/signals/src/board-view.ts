// What the tasks board shows, apart from how it draws it: each task's
// assignee, the filters, and the list and swimlane views' groups.
import type { BoardPerson, BoardTask, FilteredEvent } from "./client";
import { parseTaskPost, parseThreadPost, sourceName, type TaskPost, type ThreadPost } from "./posts";

/** The views of the board: rows grouped by status, a column per status, or the events the classifier held back. */
export const VIEWS = ["list", "swimlanes", "filtered"] as const;
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
 * How much room a task's post takes in its channel: an open task is a full
 * card; a done one keeps its card without the source's quote and details;
 * a dismissed one folds to one quiet line, so nothing in the channel looks
 * like it still needs doing.
 */
export type PostWeight = "full" | "quiet" | "folded";
export const postWeight = (status: string | undefined): PostWeight => (status === "dismissed" ? "folded" : status === "done" ? "quiet" : "full");

/**
 * Who a task is with, the one name its card shows: you, when it waits on a
 * person's input; otherwise its first owner (an agent or a person someone
 * assigned); otherwise the agent that replied in its thread, or the one
 * asked; otherwise no one.
 */
export type Assignee = Readonly<{ kind: "you" } | { kind: "agent"; key: string; label: string } | { kind: "person"; key: string; label: string } | { kind: "unassigned" }>;

/** A task's owners: who someone assigned it to, agents and people, in the order they were. */
export const ownersOf = (item: BoardTask) => item.people.filter((person) => person.on && person.role === "owner" && (person.kind === "agent" || person.kind === "person"));

/** Who's on a task in the hub and can be taken off it: its owners and the agents asked to work on it. */
export const removable = (item: BoardTask) => item.people.filter((person) => person.on && (person.kind === "agent" || person.kind === "person"));

export function assigneeOf(item: BoardTask): Assignee {
  const open = item.task.status !== "done" && item.task.status !== "dismissed";
  if (open && item.task.question) return { kind: "you" };
  const owner = ownersOf(item)[0];
  if (owner) return { kind: owner.kind as "agent" | "person", key: owner.key, label: owner.label };
  const agents = item.people.filter((person): person is BoardPerson & { kind: "agent" } => person.kind === "agent");
  const agent = agents.find((person) => person.role === "replied") ?? agents[0];
  return agent ? { kind: "agent", key: agent.key, label: agent.label } : { kind: "unassigned" };
}

/** An assignee as a filter value: "you", "unassigned" or "agent:<hex>". */
export const assigneeValue = (assignee: Assignee) => (assignee.kind === "agent" ? `agent:${assignee.key}` : assignee.kind === "person" ? `person:${assignee.key}` : assignee.kind);

/** A channel member someone can assign a task to. */
export type Member = Readonly<{ key: string; name: string; agent: boolean }>;

/**
 * The owner picker's choices: the channel's members (from its signed roster)
 * and the agents on the board, without the task's owners, agents first,
 * then by name. `profile` names them and says which are agents.
 */
export function memberChoices(members: readonly string[], boardAgents: readonly string[], owners: readonly string[], profile: (key: string) => { name?: string; agent?: boolean } | undefined, viewer?: string): Member[] {
  const taken = new Set(owners);
  const agents = new Set(boardAgents);
  return [...new Set([...members, ...boardAgents])]
    .filter((key) => !taken.has(key))
    .map((key) => {
      const found = profile(key);
      return { key, name: key === viewer ? `${found?.name ?? "You"} (you)` : (found?.name ?? `${key.slice(0, 8)}…`), agent: Boolean(found?.agent) || agents.has(key) };
    })
    .sort((a, b) => Number(b.agent) - Number(a.agent) || a.name.localeCompare(b.name));
}

/** The board's filters; an empty one keeps every task. */
export type BoardFilters = Readonly<{ status?: string; workstream?: string; assignee?: string; mode?: string; search?: string }>;

/** The tasks the filters keep, in the board's order. Search matches the id, title, workstream, initiative, the latest source and its title, and the source it opened from (its title and id), any case. */
export function filterTasks(tasks: readonly BoardTask[], filters: BoardFilters): BoardTask[] {
  const words = (filters.search ?? "").toLowerCase().split(/\s+/).filter(Boolean);
  return tasks.filter((item) => {
    const { task } = item;
    if (filters.status && task.status !== filters.status) return false;
    if (filters.workstream && (task.workstream ?? "") !== (filters.workstream === NONE ? "" : filters.workstream)) return false;
    if (filters.mode && task.mode !== filters.mode) return false;
    if (filters.assignee && assigneeValue(assigneeOf(item)) !== filters.assignee) return false;
    if (!words.length) return true;
    const haystack = [`#${task.id}`, task.title, task.workstream, task.initiative, item.source?.source, item.source?.title, item.origin?.title, item.origin?.external_id, taskOrigin(task.title, item.origin).ref].filter(Boolean).join(" ").toLowerCase();
    return words.every((word) => haystack.includes(word));
  });
}

const squash = (text: string) => text.replace(/\s+/g, " ").trim().toLowerCase();
const TICKET = /^[A-Z][A-Z0-9]+-\d+$/;

/** The source a task opened from, as far as a card knows it. */
export type Origin = Readonly<{ source: string; external_id?: string; title?: string; url?: string }>;

/**
 * What a task's title no longer says about the source it opened from: that
 * source's own title, when a short title or a rule's template replaced it
 * ("Capacity request: Gemini 4 Carbon…" for "ES-2376026 For customer: …"),
 * and its ticket key, from a Jira link (`/browse/ES-2376026`) or an id that is
 * one. Each is left out when the title already has it, as "Prep: {title}"
 * does; a key only as a whole word.
 */
export function taskOrigin(title: string, origin: Origin | undefined): { original?: string; ref?: string } {
  if (!origin) return {};
  const own = origin.title?.replace(/\s+/g, " ").trim();
  const original = own && !squash(title).includes(squash(own)) ? own : undefined;
  const linked = origin.url && /\/browse\/([A-Z][A-Z0-9]+-\d+)(?:[/?#]|$)/.exec(origin.url)?.[1];
  const ref = linked || (origin.external_id && TICKET.test(origin.external_id) ? origin.external_id : undefined);
  const said = ref && title.split(/[^A-Za-z0-9-]+/).includes(ref);
  return { ...(original && { original }), ...(ref && !said && { ref }) };
}

/** A task title's tooltip: the title, and its source's own title when that says something else. */
/** For the full view, under the task's title: the source it opened from, when a short title or template hides that source's title and the latest event (shown below it) isn't that same source, title and link. */
export function openingTitle(item: Readonly<{ task: Readonly<{ title: string }>; source?: Readonly<{ source: string; title?: string; url?: string }>; origin?: Origin | null }>): { source: string; title: string; url?: string } | undefined {
  const origin = item.origin ?? undefined;
  const { original } = taskOrigin(item.task.title, origin);
  if (!original || !origin) return undefined;
  const latest = item.source;
  // Only the same event (same source, title and link) already says it: another ticket with the same summary has its own link.
  if (latest && latest.source === origin.source && (latest.url ?? "") === (origin.url ?? "") && latest.title && squash(latest.title) === squash(original)) return undefined;
  return { source: origin.source, title: original, ...(origin.url && { url: origin.url }) };
}

/** How the hub filed a task under its workstream, for the workstream's hover: by a category's `when` match, or the classifier's pick. Nothing when the rule alone filed it, or for tasks filed before this was kept. */
export function filedHint(task: Readonly<{ filed_by?: string | null; filed_score?: number | null }>): string | undefined {
  if (task.filed_by === "match") return "Matched a category rule";
  if (task.filed_by !== "classifier") return undefined;
  const score = typeof task.filed_score === "number" && Number.isFinite(task.filed_score) ? ` (${Math.round(Math.min(1, Math.max(0, task.filed_score)) * 100)}%)` : "";
  return `Picked by the classifier${score}`;
}

/** The workstream chip's hover: its full name (the chip may cut it short), then how it was filed, when known. */
export function workstreamHint(task: Readonly<{ workstream?: string | null; filed_by?: string | null; filed_score?: number | null }>): string | undefined {
  if (!task.workstream) return undefined;
  const filed = filedHint(task);
  return filed ? `${task.workstream}\n${filed}` : task.workstream;
}

export function titleHint(title: string, origin: Origin | undefined): string {
  const { original } = taskOrigin(title, origin);
  return original && origin ? `${title}\nFrom ${sourceName(origin.source)}: ${original}` : title;
}

/**
 * The source a task post's card describes: the post's own (the event the task
 * opened from), with what the live task adds about it (its id, and its title
 * until the hub writes a `Title:` line). The live one counts only when it's the
 * same source: same kind, and the same link when both have one.
 */
export function postOrigin(source: Readonly<{ kind: string; url?: string; title?: string }> | undefined, live: Origin | undefined): Origin | undefined {
  if (!source) return undefined;
  const same = live && live.source === source.kind && (!source.url || !live.url || live.url === source.url) ? live : undefined;
  const title = source.title ?? same?.title;
  const url = source.url ?? same?.url;
  return { source: source.kind, ...(same?.external_id && { external_id: same.external_id }), ...(title && { title }), ...(url && { url }) };
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
  const order = { you: 0, person: 1, agent: 2, unassigned: 3 } as const;
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
export type Comment = Readonly<{ id: string; author: string; at: number; text: string; agents: boolean; pending: boolean; failed: boolean }>;

const MENTION = /nostr:(npub1[02-9ac-hj-np-z]{58})/g;

/** The people a text mentions as nostr:npub…, as hex keys, once each. */
export function mentionedKeys(text: string, decode: (npub: string) => string | undefined): string[] {
  const keys = [...text.matchAll(MENTION)].map((match) => decode(match[1]!)).filter((key): key is string => Boolean(key));
  return [...new Set(keys)];
}

/** A text with each nostr:npub… mention shown as @Name, as Buzz shows it; one with no name known shows a short npub. */
export function withMentionNames(text: string, decode: (npub: string) => string | undefined, name: (key: string) => string | undefined): string {
  return text.replace(MENTION, (whole, npub: string) => {
    const key = decode(npub);
    if (!key) return whole;
    return `**@${name(key) ?? `${npub.slice(0, 12)}…`}**`;
  });
}

/** The thread's messages as comments, oldest first, without empty ones. `agents` marks coordination between agents, shown quietly. */
export function threadComments(messages: readonly Readonly<{ id: string; authorId: string; createdAt: number; content: string; audience?: "agents"; delivery?: unknown }>[]): Comment[] {
  return messages
    .filter((message) => message.content.trim())
    // The relay's delivery states: "sending" until it answers, then "accepted", "seen" or "unknown" (sent), or "failed".
    .map((message) => ({ id: message.id, author: message.authorId, at: message.createdAt, text: message.content, agents: message.audience === "agents", pending: message.delivery === "sending", failed: message.delivery === "failed" }))
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

/**
 * The task's details for its view's sidebar, as label and value pairs:
 * dates in the viewer's own time, with the exact UTC time as `title`. A
 * meeting's last event is when it starts, so a time ahead reads "Starts".
 * Status isn't here: the sidebar sets it. `note` is a quiet line under
 * the value: how the workstream was picked, when the hub says.
 */
export function taskFacts(item: BoardTask, now = Date.now() / 1000): { label: string; value: string; title?: string; note?: string }[] {
  const { task } = item;
  const utc = (seconds: number) => new Date(seconds * 1000).toISOString().slice(0, 16).replace("T", " ") + " UTC";
  const local = (seconds: number) => {
    const at = new Date(seconds * 1000);
    const sameYear = at.getFullYear() === new Date(now * 1000).getFullYear();
    return at.toLocaleString([], { month: "short", day: "numeric", ...(!sameYear && { year: "numeric" }), hour: "numeric", minute: "2-digit" });
  };
  const ahead = task.last_event_at > now;
  return [
    { label: "Mode", value: MODE_NAMES[task.mode]?.name ?? task.mode, ...(MODE_NAMES[task.mode] && { title: MODE_NAMES[task.mode]!.title }) },
    ...(task.workstream ? [{ label: "Workstream", value: task.workstream, ...(filedHint(task) && { note: filedHint(task)! }) }] : []),
    ...(task.initiative ? [{ label: "Initiative", value: task.initiative }] : []),
    ...(task.account ? [{ label: "Account", value: task.account }] : []),
    { label: "Opened", value: local(task.created_at), title: utc(task.created_at) },
    { label: ahead ? "Starts" : "Last event", value: `${local(task.last_event_at)}${!ahead && task.event_count > 1 ? ` · ${task.event_count} events` : ""}`, title: utc(task.last_event_at) },
  ];
}

/** Each mode as people say it, and what it means. */
export const MODE_NAMES: Readonly<Record<string, { name: string; title: string }>> = {
  auto: { name: "Auto", title: "Agents do it and report" },
  draft: { name: "Draft", title: "Agents prepare it, a person sends it" },
  ask: { name: "Ask", title: "Agents ask before doing anything" },
  off: { name: "Off", title: "Agents leave it alone" },
};

/**
 * One entry of a task's activity: the task post that opened it, a line the
 * hub posted (an update, an answer, an assignment), a note agents left each
 * other, or a comment. A run of more than three lines in a row is folded
 * into one `lines` entry, so a busy day of updates doesn't bury the comments.
 */
export type ActivityLine = Readonly<{ kind: "opened"; comment: Comment; post: TaskPost }> | Readonly<{ kind: "event"; comment: Comment; post: ThreadPost }> | Readonly<{ kind: "note"; comment: Comment }>;
export type ActivityEntry = ActivityLine | Readonly<{ kind: "comment"; comment: Comment }> | Readonly<{ kind: "lines"; lines: readonly ActivityLine[] }>;

/**
 * A task's thread as activity. The hub is whoever posted the task (the
 * thread's first message); only its replies are read as lines, so an
 * agent's own "Update:" stays a comment.
 */
export function taskActivity(comments: readonly Comment[], fold = 3): ActivityEntry[] {
  const first = comments[0];
  const opened = first && parseTaskPost(first.text);
  const hub = opened ? first.author : undefined;
  const out: ActivityEntry[] = [];
  let run: ActivityLine[] = [];
  const flush = () => {
    if (run.length > fold) out.push({ kind: "lines", lines: run });
    else out.push(...run);
    run = [];
  };
  comments.forEach((comment, at) => {
    if (at === 0 && opened) return void run.push({ kind: "opened", comment, post: opened });
    const post = hub && comment.author === hub ? parseThreadPost(comment.text) : undefined;
    if (post) return void run.push({ kind: "event", comment, post });
    if (comment.agents) return void run.push({ kind: "note", comment });
    flush();
    out.push({ kind: "comment", comment });
  });
  flush();
  return out;
}

/** Why the classifier held an event back, in a line: its rule, its score against the one it needed, and the question. */
export function filteredWhy(event: FilteredEvent): string {
  const percent = (n: number) => `${Math.round(n * 100)}%`;
  const score = `scored ${percent(event.score)}${event.min !== undefined ? `, needed ${percent(event.min)}` : ""}`;
  return `${event.rule}: ${score}${event.question ? ` on “${event.question}”` : ""}`;
}

/** Filtered events matching the board's search (title, sender, source, rule), any case. */
export function filterFiltered(events: readonly FilteredEvent[], search: string | undefined): FilteredEvent[] {
  const words = (search ?? "").toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return [...events];
  return events.filter((event) => {
    const text = [event.title, event.actor, event.source, event.rule, event.account].filter(Boolean).join(" ").toLowerCase();
    return words.every((word) => text.includes(word));
  });
}
