// "Tasks board" in a channel's menu: the channel's signals tasks, in a list
// grouped by status or in swimlanes (a column per status), styled after
// Linear. Filters narrow it by status, workstream, assignee, mode and text.
// Each task shows one assignee: you when it needs your input, otherwise the
// agent on it, otherwise no one. Opening a task shows its latest activity,
// the links made for it, and what you can do: answer what an agent asked
// (Provide input), add an agent, open its thread to steer the agents there,
// change its status or dismiss it. Its full view (Open) shows its details,
// every asset, and its thread as comments, with a box to reply that mentions
// the agent it's with.
import type { Context } from "@buzz/author";
import type { PanelProps } from "@dbx/core/host-types";
import { optionalService } from "@dbx/core/host-types";
import { React } from "@dbx/core/react";
import { type DatabricksService, describeError, useAsync, useConnection } from "@dbx/core/service";
import { ago, Button, Disclosure, DbxRoot, Notice, Spinner, Stack, Text, openExternal } from "@dbx/core/ui/components";
import { Markdown } from "@dbx/core/ui/markdown";
import { decode, npubEncode } from "nostr-tools/nip19";
import { TASK_STATUSES } from "../app/model";
import { type Assignee, assigneeOf, type BoardFilters, type BoardView, byStatus, cardAssets, type Comment, filterFiltered, filteredWhy, filterOptions, filterTasks, mentionedKeys, NONE, readView, replyMentions, replyText, STATUS_GROUPS, taskFacts, threadComments, withMentionNames } from "./board-view";
import { type BoardTask, chosenHub, type FilteredEvent, HubClient } from "./client";

type Profile = { name?: string; picture?: string };
type ProfileQueries = { snapshot(): ReadonlyMap<string, Profile>; subscribe(listener: () => void): () => void; ensure(ids: readonly string[]): Promise<void> };
type ThreadMessage = { id: string; authorId: string; createdAt: number; content: string; audience?: "agents"; delivery?: unknown };
type ThreadReader = {
  snapshot(): { status: "idle" | "loading" | "ready" | "error"; root?: ThreadMessage; replies: readonly ThreadMessage[]; error?: string; canLoadMore: boolean };
  subscribe(listener: () => void): () => void;
  loadMore(): Promise<void>;
  dispose(): void;
};
type RelaySession = {
  profiles?: ProfileQueries;
  media?: (url: string, size?: "small") => string | undefined;
  thread?: (channelId: string, messageId: string) => ThreadReader;
  messages?: { reply?: (channelId: string, rootId: string, content: string, mentions?: readonly string[]) => string };
};
type RelayView = { snapshot(): { viewer?: string; origin?: string; session?: RelaySession } };

/** Buzz profiles (names and pictures) of the agents on the board, from the host's relay when it has one. */
function useProfiles(ctx: Context, keys: readonly string[]) {
  const session = optionalService<RelayView>(ctx, "relay")?.snapshot().session;
  const profiles = session?.profiles;
  const [, bump] = React.useReducer((n: number) => n + 1, 0);
  React.useEffect(() => (profiles ? profiles.subscribe(bump) : undefined), [profiles]);
  const wanted = keys.join(",");
  React.useEffect(() => void profiles?.ensure(keys).catch(() => {}), [profiles, wanted]);
  return (key: string): Profile | undefined => {
    const found = profiles?.snapshot().get(key);
    if (!found) return undefined;
    const picture = found.picture && session?.media ? (session.media(found.picture, "small") ?? found.picture) : found.picture;
    return { ...(found.name && { name: found.name }), ...(picture && { picture }) };
  };
}

/** An npub's hex key, or undefined when it isn't one. */
const npubKey = (npub: string): string | undefined => {
  try {
    const found = decode(npub);
    return found.type === "npub" ? found.data : undefined;
  } catch {
    return undefined;
  }
};

const initials = (label: string) => label.replace(/[^\p{L}\p{N} ]/gu, "").split(/\s+/).filter(Boolean).slice(0, 2).map((word) => word[0]!.toUpperCase()).join("") || "?";

/** An assignee's name, from the agent's Buzz profile when there is one. */
const assigneeName = (assignee: Assignee, profile: (key: string) => Profile | undefined) =>
  assignee.kind === "you" ? "You" : assignee.kind === "unassigned" ? "Unassigned" : (profile(assignee.key)?.name ?? assignee.label);

/** The assignee's picture (or initials), like Linear's: round for you, square for agents, dashed for no one. */
function AssigneeMark(props: { assignee: Assignee; profile(key: string): Profile | undefined; size?: number }) {
  const size = props.size ?? 20;
  const name = assigneeName(props.assignee, props.profile);
  const title = props.assignee.kind === "you" ? "You: it needs your input" : props.assignee.kind === "agent" ? `${name} (agent)` : "Unassigned";
  const base: React.CSSProperties = { width: size, height: size, flex: "none", boxSizing: "border-box", display: "inline-flex", alignItems: "center", justifyContent: "center", fontSize: Math.round(size * 0.42), fontWeight: 600 };
  if (props.assignee.kind === "unassigned") return <span title={title} aria-label={title} style={{ ...base, borderRadius: 999, border: "1.5px dashed var(--dbx-border-strong)" }} />;
  if (props.assignee.kind === "you") return <span title={title} aria-label={title} style={{ ...base, borderRadius: 999, background: "var(--dbx-warning)", color: "var(--dbx-surface)" }}>!</span>;
  const picture = props.profile(props.assignee.key)?.picture;
  const style: React.CSSProperties = { ...base, borderRadius: 5, border: "1px solid var(--dbx-border)" };
  return picture ? <img src={picture} alt={name} title={title} style={{ ...style, objectFit: "cover" }} /> : <span title={title} aria-label={title} style={{ ...style, background: "var(--dbx-brand-tint)", color: "var(--dbx-subtle)" }}>{initials(name)}</span>;
}

/** A status as a small ring, like Linear's: empty when open, half full in progress, full when done. */
export function StatusIcon(props: { status: string; size?: number }) {
  const size = props.size ?? 13;
  const color = { open: "var(--dbx-tertiary)", in_progress: "var(--dbx-warning)", waiting: "var(--dbx-danger)", done: "var(--dbx-success)", dismissed: "var(--dbx-tertiary)" }[props.status] ?? "var(--dbx-tertiary)";
  const fill = props.status === "in_progress" ? `conic-gradient(${color} 0 50%, transparent 50% 100%)` : props.status === "done" ? color : "transparent";
  const label = STATUS_GROUPS.find((group) => group.status === props.status)?.title ?? props.status;
  return (
    <span title={label} aria-label={label} style={{ width: size, height: size, flex: "none", boxSizing: "border-box", borderRadius: 999, border: `1.5px ${props.status === "waiting" ? "dotted" : "solid"} ${color}`, background: fill, display: "inline-flex", alignItems: "center", justifyContent: "center", color: "var(--dbx-surface)", fontSize: size * 0.6, lineHeight: 1 }}>
      {props.status === "done" ? "✓" : props.status === "dismissed" ? <span style={{ color, fontSize: size * 0.7 }}>×</span> : null}
    </span>
  );
}

/** A small label, like Linear's: muted text in a thin outline. */
function Chip(props: { children: React.ReactNode; title?: string; tone?: "brand" | "success" }) {
  const color = props.tone === "brand" ? "var(--dbx-lava-text)" : props.tone === "success" ? "var(--dbx-success)" : "var(--dbx-subtle)";
  return <span title={props.title} style={{ display: "inline-flex", alignItems: "center", padding: "0 6px", borderRadius: 4, border: "1px solid var(--dbx-border)", fontSize: "0.6875rem", lineHeight: "18px", color, whiteSpace: "nowrap", maxWidth: 160, overflow: "hidden", textOverflow: "ellipsis" }}>{props.children}</span>;
}

const ASSET_ICON: Record<string, string> = { doc: "📄", sheet: "📊", slides: "📽", form: "📝", drive: "📁", pr: "⇄", issue: "◎", code: "</>", app: "▣", dashboard: "📈", notebook: "📓", slack: "#", link: "🔗" };
const link = (url: string) => (event: React.MouseEvent) => (event.preventDefault(), event.stopPropagation(), openExternal(url));

function AddAgent(props: { hub: HubClient; task: BoardTask; onDone(): void }) {
  const [open, setOpen] = React.useState(false);
  const [agent, setAgent] = React.useState("");
  const [note, setNote] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string>();
  if (!open) return <Button size="sm" disabled={!props.task.thread} title={props.task.thread ? "Ask an agent to work on it in its thread" : "Not posted in Buzz yet"} onClick={() => setOpen(true)}>Add agent</Button>;
  const add = async () => {
    setBusy(true);
    setError(undefined);
    try {
      await props.hub.updateTask({ id: props.task.task.id, agents: agent.split(/[,\s]+/).filter(Boolean), ...(note.trim() && { note: note.trim() }) });
      setOpen(false);
      setAgent("");
      setNote("");
      props.onDone();
    } catch (problem) {
      setError(describeError(problem));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Stack gap={6} style={{ width: "100%" }}>
      <input className="dbx-input" placeholder="Agent npub1… (a member of this channel)" value={agent} onChange={(event) => setAgent(event.target.value)} />
      <input className="dbx-input" placeholder="What to do (optional)" value={note} onChange={(event) => setNote(event.target.value)} />
      {error && <Text size="xs" tone="danger">{error}</Text>}
      <Stack direction="row" gap={6}>
        <Button size="sm" variant="brand" disabled={busy || !agent.trim()} onClick={() => void add()}>{busy ? <Spinner size={10} /> : null}Ask</Button>
        <Button size="sm" onClick={() => setOpen(false)}>Cancel</Button>
      </Stack>
    </Stack>
  );
}

/** What a waiting task asks, with its choices and a box for any other answer; the answer goes to its thread. */
export function ProvideInput(props: { hub: HubClient; task: BoardTask; onDone(): void }) {
  const { task } = props.task;
  const [open, setOpen] = React.useState(false);
  const [text, setText] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string>();
  if (!task.question) return null;
  const send = async (answer: string) => {
    if (!answer.trim()) return;
    setBusy(true);
    setError(undefined);
    try {
      await props.hub.updateTask({ id: task.id, input: answer.trim() });
      setOpen(false);
      setText("");
      props.onDone();
    } catch (problem) {
      setError(describeError(problem));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div style={{ borderLeft: "3px solid var(--dbx-warning, var(--dbx-brand))", paddingLeft: 8 }}>
      <Stack gap={6}>
        <Text size="xs" weight={600}>Needs input</Text>
        <Text size="sm">{task.question}</Text>
        {!open ? (
          <Button size="sm" variant="brand" onClick={() => setOpen(true)}>Provide input</Button>
        ) : (
          <Stack gap={6}>
            {(task.options ?? []).length > 0 && (
              <Stack direction="row" gap={6} wrap>
                {task.options!.map((option) => <Button key={option} size="sm" disabled={busy} onClick={() => void send(option)}>{option}</Button>)}
              </Stack>
            )}
            <textarea className="dbx-input" rows={2} placeholder={(task.options ?? []).length ? "Or write your answer" : "Your answer"} value={text} onChange={(event) => setText(event.target.value)} />
            {error && <Text size="xs" tone="danger">{error}</Text>}
            <Stack direction="row" gap={6}>
              <Button size="sm" variant="brand" disabled={busy || !text.trim()} onClick={() => void send(text)}>{busy ? <Spinner size={10} /> : null}Send</Button>
              <Button size="sm" onClick={() => setOpen(false)}>Cancel</Button>
            </Stack>
          </Stack>
        )}
      </Stack>
    </div>
  );
}

/** What an opened task shows: what it asks, its latest activity, its assets, and what you can do with it. */
function TaskBody(props: { hub: HubClient; item: BoardTask; steer(item: BoardTask): void; onChange(): void; open?(item: BoardTask): void; full?: boolean }) {
  const { item } = props;
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string>();
  const setStatus = async (status: string) => {
    setBusy(true);
    setError(undefined);
    try {
      await props.hub.updateTask({ id: item.task.id, status });
      props.onChange();
    } catch (problem) {
      setError(describeError(problem));
    } finally {
      setBusy(false);
    }
  };
  const closed = item.task.status === "done" || item.task.status === "dismissed";
  // The workspace link (Explore in Databricks) is in the task's full view; the expanded row keeps to what was made for it.
  const assets = item.artifacts.filter((artifact) => /^https?:/.test(artifact.url) && artifact.kind !== "workspace");
  return (
    <Stack gap={8} style={{ paddingTop: 8 }}>
      {item.task.question && !closed && <ProvideInput hub={props.hub} task={item} onDone={props.onChange} />}
      {!props.full && item.source?.title && <Text size="xs" tone="subtle">From {item.source.source}: {item.source.url ? <a href={item.source.url} onClick={link(item.source.url)}>{item.source.title}</a> : item.source.title}</Text>}
      {!props.full && item.activity && <Text size="xs" tone="subtle">{item.activity.kind === "agent_reply" ? "Agent: " : ""}{item.activity.text.length > 280 ? `${item.activity.text.slice(0, 279)}…` : item.activity.text} <span style={{ color: "var(--dbx-tertiary)" }}>· {ago(item.activity.at * 1000)}</span></Text>}
      {!props.full && assets.length > 0 && (
        <Stack direction="row" gap={6} wrap>
          {assets.map((artifact) => (
            <a key={`${artifact.at}:${artifact.url}`} href={artifact.url} onClick={link(artifact.url)} title={artifact.url} style={{ fontSize: "0.75rem" }}>
              {ASSET_ICON[artifact.kind] ?? "🔗"} {artifact.title ?? artifact.kind}
            </a>
          ))}
        </Stack>
      )}
      {error && <Text size="xs" tone="danger">{error}</Text>}
      <Stack direction="row" gap={6} wrap align="center">
        {props.open && <Button size="sm" variant="primary" title="Its details, assets and thread" onClick={() => props.open!(item)}>Open</Button>}
        <Button size="sm" disabled={!item.thread} title="Open its thread to steer the agents there" onClick={() => props.steer(item)}>Steer</Button>
        {!closed && <AddAgent hub={props.hub} task={item} onDone={props.onChange} />}
        <select className="dbx-input" aria-label="Status" disabled={busy} value={item.task.status} onChange={(event) => void setStatus(event.target.value)} style={{ width: "auto", fontSize: "0.75rem" }}>
          {TASK_STATUSES.map((status) => <option key={status} value={status}>{status.replace("_", " ")}</option>)}
        </select>
        {!closed && <Button size="sm" variant="danger" disabled={busy} onClick={() => void setStatus("dismissed")}>Dismiss</Button>}
      </Stack>
    </Stack>
  );
}

type TaskProps = { hub: HubClient; item: BoardTask; open: boolean; toggle(): void; profile(key: string): Profile | undefined; steer(item: BoardTask): void; onChange(): void; view(item: BoardTask): void };

/** The labels a task shows beside its title: workstream, initiative, mode, source and the links made for it. */
function Meta(props: { item: BoardTask }) {
  const { item } = props;
  const assets = cardAssets(item);
  return (
    <>
      {item.task.workstream && <Chip>{item.task.workstream}</Chip>}
      {item.task.initiative && <Chip tone="brand">{item.task.initiative}</Chip>}
      {item.task.mode !== "draft" && <Chip tone={item.task.mode === "auto" ? "success" : undefined} title="How agents handle it">{item.task.mode}</Chip>}
      {item.source && <Text size="xs" tone="tertiary">{item.source.source}</Text>}
      {assets.slice(0, 3).map((artifact) => (
        <a key={`${artifact.at}:${artifact.url}`} href={artifact.url} onClick={link(artifact.url)} title={artifact.title ?? artifact.url} style={{ fontSize: "0.75rem", textDecoration: "none" }}>{ASSET_ICON[artifact.kind] ?? "🔗"}</a>
      ))}
      {assets.length > 3 && <Text size="xs" tone="tertiary">+{assets.length - 3}</Text>}
    </>
  );
}

const rowKeys = (toggle: () => void) => ({ role: "button", tabIndex: 0, onClick: toggle, onKeyDown: (event: React.KeyboardEvent) => (event.key === "Enter" || event.key === " ") && event.target === event.currentTarget && (event.preventDefault(), toggle()) });

/** A task in the list: one line, like a Linear issue row; it opens in place. */
function TaskRow(props: TaskProps) {
  const { item } = props;
  const assignee = assigneeOf(item);
  return (
    <div style={{ borderBottom: "1px solid var(--dbx-border)", background: props.open ? "var(--dbx-inset)" : undefined }}>
      <div {...rowKeys(props.toggle)} aria-expanded={props.open} className="signals-row" style={{ display: "flex", alignItems: "center", gap: 8, padding: "7px 12px", cursor: "pointer", minWidth: 0 }}>
        <Text size="xs" tone="tertiary" mono style={{ flex: "none", width: 34 }}>#{item.task.id}</Text>
        <StatusIcon status={item.task.status} />
        <Text size="sm" weight={500} style={{ flex: "1 1 auto", minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{item.task.title}</Text>
        <span style={{ display: "flex", gap: 6, alignItems: "center", flex: "none", maxWidth: "45%", overflow: "hidden" }}><Meta item={item} /></span>
        <Text size="xs" tone="tertiary" style={{ flex: "none", width: 52, textAlign: "right" }}>{ago(item.task.last_event_at * 1000)}</Text>
        <AssigneeMark assignee={assignee} profile={props.profile} />
      </div>
      {props.open && <div style={{ padding: "0 12px 10px 54px" }}><TaskBody hub={props.hub} item={item} steer={props.steer} onChange={props.onChange} open={props.view} /></div>}
    </div>
  );
}

/** A task in a swimlane: a compact card, like Linear's board; it opens in place. */
function TaskCard(props: TaskProps) {
  const { item } = props;
  const assignee = assigneeOf(item);
  return (
    <div className="dbx-card" style={{ padding: 10, borderRadius: 8, boxShadow: props.open ? "0 1px 6px rgba(0,0,0,0.12)" : undefined }}>
      <div {...rowKeys(props.toggle)} aria-expanded={props.open} style={{ cursor: "pointer" }}>
        <Stack gap={6}>
          <Stack direction="row" gap={6} align="center" justify="space-between">
            <Text size="xs" tone="tertiary" mono>#{item.task.id}</Text>
            <Stack direction="row" gap={6} align="center">
              <Text size="xs" tone="tertiary">{ago(item.task.last_event_at * 1000)}</Text>
              <AssigneeMark assignee={assignee} profile={props.profile} size={18} />
            </Stack>
          </Stack>
          <Stack direction="row" gap={6} align="flex-start">
            <span style={{ paddingTop: 2 }}><StatusIcon status={item.task.status} /></span>
            <Text size="sm" weight={500}>{item.task.title}</Text>
          </Stack>
          <Stack direction="row" gap={6} wrap align="center"><Meta item={item} /></Stack>
        </Stack>
      </div>
      {props.open && <TaskBody hub={props.hub} item={item} steer={props.steer} onChange={props.onChange} open={props.view} />}
    </div>
  );
}

/** A task's thread from the host's relay, as comments, kept up to date while it's shown. */
function useThread(ctx: Context, channel: string | undefined, root: string | null | undefined) {
  const session = optionalService<RelayView>(ctx, "relay")?.snapshot().session;
  const [reader, setReader] = React.useState<ThreadReader>();
  const [, bump] = React.useReducer((n: number) => n + 1, 0);
  React.useEffect(() => {
    if (!channel || !root || !session?.thread) return setReader(undefined);
    const opened = session.thread(channel, root);
    setReader(opened);
    const stop = opened.subscribe(bump);
    return () => (stop(), opened.dispose());
  }, [session, channel, root]);
  const snapshot = reader?.snapshot();
  const messages = snapshot ? [...(snapshot.root ? [snapshot.root] : []), ...snapshot.replies] : [];
  return {
    available: Boolean(session?.thread),
    status: snapshot?.status ?? "idle",
    error: snapshot?.error,
    comments: threadComments(messages),
    more: snapshot?.canLoadMore ? () => void reader?.loadMore() : undefined,
    reply: session?.messages?.reply && channel && root ? (content: string, mentions: readonly string[]) => session.messages!.reply!(channel, root, content, mentions) : undefined,
  };
}

/** A comment in the task's thread: who wrote it, when, and what it says. Agents' notes to each other are folded away. */
function CommentItem(props: { comment: Comment; profile(key: string): Profile | undefined }) {
  const { comment } = props;
  const who = props.profile(comment.author);
  const name = who?.name ?? `${npubEncode(comment.author).slice(0, 12)}…`;
  const mark = who?.picture ? <img src={who.picture} alt={name} style={{ width: 22, height: 22, borderRadius: 999, objectFit: "cover", flex: "none" }} /> : <span style={{ width: 22, height: 22, borderRadius: 999, flex: "none", display: "inline-flex", alignItems: "center", justifyContent: "center", fontSize: 9, fontWeight: 600, background: "var(--dbx-inset)", color: "var(--dbx-subtle)", border: "1px solid var(--dbx-border)" }}>{initials(name)}</span>;
  const raw = comment.text.length > 6000 ? `${comment.text.slice(0, 5999)}…` : comment.text;
  const text = withMentionNames(raw, npubKey, (key) => props.profile(key)?.name);
  return (
    <div style={{ display: "flex", gap: 10, alignItems: "flex-start", opacity: comment.pending ? 0.6 : 1 }}>
      {mark}
      <div style={{ flex: "1 1 auto", minWidth: 0 }}>
        <Stack direction="row" gap={6} align="baseline">
          <Text size="sm" weight={600}>{name}</Text>
          <Text size="xs" tone="tertiary">{ago(comment.at * 1000)}{comment.pending ? " · sending" : ""}</Text>
          {comment.failed && <Text size="xs" tone="danger">Not sent</Text>}
        </Stack>
        <div style={{ overflowWrap: "anywhere" }}>
          {comment.agents ? <Disclosure summary="Note between agents">{<Markdown source={text} size="sm" />}</Disclosure> : <Markdown source={text} size="sm" />}
        </div>
      </div>
    </div>
  );
}

/** The box under the comments: a reply in the task's thread, mentioning the agent it's with. */
function ReplyBox(props: { assignee: Assignee; profile(key: string): Profile | undefined; send?: (content: string, mentions: readonly string[]) => string; steer(): void }) {
  const [text, setText] = React.useState("");
  const [error, setError] = React.useState<string>();
  const mentions = replyMentions(props.assignee);
  const to = props.assignee.kind === "agent" ? (props.profile(props.assignee.key)?.name ?? props.assignee.label) : undefined;
  if (!props.send) return <Text size="xs" tone="subtle">Replying needs Buzz's thread view here. <a href="#" onClick={(event) => (event.preventDefault(), props.steer())}>Open the thread</a> to reply.</Text>;
  const send = () => {
    if (!text.trim()) return;
    setError(undefined);
    try {
      props.send!(replyText(text, mentions.map((key) => ({ npub: npubEncode(key) }))), mentions);
      setText("");
    } catch (problem) {
      setError(describeError(problem));
    }
  };
  return (
    <Stack gap={6}>
      <textarea
        className="dbx-input"
        rows={3}
        aria-label="Reply"
        placeholder={to ? `Reply to ${to}…` : "Reply in the task's thread…"}
        value={text}
        onChange={(event) => setText(event.target.value)}
        onKeyDown={(event) => (event.key === "Enter" && (event.metaKey || event.ctrlKey)) && (event.preventDefault(), send())}
      />
      {error && <Text size="xs" tone="danger">{error}</Text>}
      <Stack direction="row" gap={8} align="center" justify="space-between">
        <Text size="xs" tone="tertiary">{to ? `Mentions ${to}, the agent it's with.` : "Mentions no one: no agent is on it."} ⌘↵ sends.</Text>
        <Button size="sm" variant="brand" disabled={!text.trim()} onClick={send}>Reply</Button>
      </Stack>
    </Stack>
  );
}

/** A task's full view, like a Linear issue: title, details and assets beside its thread as comments, with a reply box. */
function TaskView(props: { ctx: Context; hub: HubClient; item: BoardTask; channel?: string; profile(key: string): Profile | undefined; steer(item: BoardTask): void; onChange(): void; back(): void }) {
  const { item } = props;
  const assignee = assigneeOf(item);
  const thread = useThread(props.ctx, props.channel ?? item.task.channel ?? undefined, item.task.buzz_root);
  const assets = item.artifacts.filter((artifact) => /^https?:/.test(artifact.url));
  const facts = taskFacts(item);
  const authorProfile = useProfiles(props.ctx, [...new Set(thread.comments.flatMap((comment) => [comment.author, ...mentionedKeys(comment.text, npubKey)]))]);
  const who = (key: string) => props.profile(key) ?? authorProfile(key);
  const people = item.people.filter((person) => person.kind !== "agent");
  const end = React.useRef<HTMLDivElement>(null);
  const count = thread.comments.length;
  React.useEffect(() => end.current?.scrollIntoView?.({ block: "nearest" }), [count]);
  // A new comment can come with a status change or an asset (agents post them in the thread), so reload the task then.
  const seen = React.useRef<number | undefined>(undefined);
  const { onChange } = props;
  React.useEffect(() => {
    if (thread.status !== "ready") return;
    if (seen.current !== undefined && count > seen.current) onChange();
    seen.current = count;
  }, [count, thread.status]);
  return (
    <Stack gap={14}>
      <Stack direction="row" gap={8} align="center">
        <Button size="sm" variant="ghost" onClick={props.back}>← Board</Button>
        <Text size="xs" tone="tertiary" mono>#{item.task.id}</Text>
      </Stack>
      <Stack direction="row" gap={8} align="flex-start">
        <span style={{ paddingTop: 4 }}><StatusIcon status={item.task.status} size={15} /></span>
        <Text as="h2" size="xl" weight={600} style={{ overflowWrap: "anywhere" }}>{item.task.title}</Text>
      </Stack>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 20, alignItems: "flex-start", minWidth: 0 }}>
        <div style={{ flex: "2 1 360px", minWidth: 0 }}>
          <Stack gap={14}>
            <TaskBody hub={props.hub} item={item} steer={props.steer} onChange={props.onChange} full />
            <div style={{ borderTop: "1px solid var(--dbx-border)", paddingTop: 12 }}>
              <Stack gap={12}>
                <Text size="sm" weight={600}>Activity</Text>
                {!item.thread ? <Text size="xs" tone="subtle">Not posted in Buzz yet.</Text>
                  : !thread.available ? <Text size="xs" tone="subtle">The thread can't be read here. <a href="#" onClick={(event) => (event.preventDefault(), props.steer(item))}>Open it in Buzz</a>.</Text>
                  : thread.status === "error" ? <Text size="xs" tone="danger">{thread.error ?? "Couldn't read the thread."}</Text>
                  : thread.status !== "ready" && !count ? <Spinner label="Loading the thread" />
                  : (
                    <Stack gap={14}>
                      {thread.more && <Button size="sm" variant="ghost" onClick={thread.more}>Earlier comments</Button>}
                      {thread.comments.map((comment) => <CommentItem key={comment.id} comment={comment} profile={who} />)}
                      <div ref={end} />
                    </Stack>
                  )}
                {item.thread && <ReplyBox assignee={assignee} profile={props.profile} {...(thread.reply && { send: thread.reply })} steer={() => props.steer(item)} />}
              </Stack>
            </div>
          </Stack>
        </div>
        <aside style={{ flex: "1 1 220px", minWidth: 0, maxWidth: 340 }}>
          <Stack gap={12}>
            <Stack gap={6}>
              <Text size="xs" tone="tertiary" weight={600}>ASSIGNEE</Text>
              <Stack direction="row" gap={8} align="center"><AssigneeMark assignee={assignee} profile={props.profile} /><Text size="sm">{assigneeName(assignee, props.profile)}</Text></Stack>
            </Stack>
            <Stack gap={4}>
              <Text size="xs" tone="tertiary" weight={600}>DETAILS</Text>
              {facts.map((fact) => (
                <div key={fact.label} style={{ display: "flex", gap: 8, fontSize: "0.75rem" }}>
                  <span style={{ flex: "0 0 84px", color: "var(--dbx-tertiary)" }}>{fact.label}</span>
                  <span style={{ minWidth: 0, overflowWrap: "anywhere", color: "var(--dbx-ink)" }}>{fact.label === "Source" && item.source?.url ? <a href={item.source.url} onClick={link(item.source.url)}>{fact.value}</a> : fact.value}</span>
                </div>
              ))}
            </Stack>
            {people.length > 0 && (
              <Stack gap={4}>
                <Text size="xs" tone="tertiary" weight={600}>PEOPLE</Text>
                {people.map((person) => <Text key={`${person.kind}:${person.key}`} size="xs">{person.label} <span style={{ color: "var(--dbx-tertiary)" }}>· {person.role}</span></Text>)}
              </Stack>
            )}
            <Stack gap={4}>
              <Text size="xs" tone="tertiary" weight={600}>ASSETS</Text>
              {!assets.length ? <Text size="xs" tone="subtle">Nothing made for it yet.</Text> : assets.map((artifact) => (
                <a key={`${artifact.at}:${artifact.url}`} href={artifact.url} onClick={link(artifact.url)} title={artifact.url} style={{ fontSize: "0.75rem", overflowWrap: "anywhere", opacity: artifact.kind === "workspace" ? 0.65 : 1 }}>
                  {ASSET_ICON[artifact.kind] ?? "🔗"} {artifact.title ?? artifact.url.replace(/^https?:\/\//, "").slice(0, 60)} <span style={{ color: "var(--dbx-tertiary)" }}>· {artifact.kind}</span>
                </a>
              ))}
            </Stack>
          </Stack>
        </aside>
      </div>
    </Stack>
  );
}

const VIEW_KEY = "signals.board.view";
const savedView = (): BoardView => {
  try {
    return readView(globalThis.localStorage?.getItem(VIEW_KEY));
  } catch {
    return "list";
  }
};

/**
 * The events a rule's classifier kept from opening a task in this channel,
 * with why: the rule, its score against the one it needed, and the question,
 * so the team can see what it held back and tune the question or `min`.
 */
function FilteredList(props: { events: readonly FilteredEvent[] | undefined; loading: boolean; error?: Error; search?: string }) {
  if (props.error) return <Notice tone="danger">{describeError(props.error)}</Notice>;
  if (!props.events) return props.loading ? <Spinner label="Loading filtered events" /> : null;
  const shown = filterFiltered(props.events, props.search);
  if (!props.events.length) return <Text tone="subtle" size="sm">Nothing filtered in the last two weeks. Rules with <code>classify</code> list here the events their question held back.</Text>;
  if (!shown.length) return <Text tone="subtle" size="sm">No filtered events match the search.</Text>;
  return (
    <Stack gap={6}>
      <Text size="xs" tone="tertiary">Events from the last two weeks that a rule's classifier kept from opening a task here. If one should have been a task, loosen the rule's question or lower its <code>min</code>.</Text>
      <div style={{ border: "1px solid var(--dbx-border)", borderRadius: 8, overflow: "hidden", minWidth: 0 }}>
        {shown.map((event, n) => (
          <div key={event.id} style={{ padding: "8px 12px", borderTop: n ? "1px solid var(--dbx-border)" : undefined, minWidth: 0 }}>
            <Stack gap={2}>
              <Stack direction="row" gap={8} align="center" wrap>
                <span style={{ fontSize: "0.8125rem", fontWeight: 500, minWidth: 0, flex: "1 1 200px", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={event.title}>
                  {event.url ? <a href={event.url} onClick={(click) => (click.preventDefault(), openExternal(event.url!))}>{event.title || event.external_id}</a> : event.title || event.external_id}
                </span>
                <Text size="xs" tone="tertiary">{event.source} · {ago(event.filtered_at * 1000)}</Text>
              </Stack>
              {event.actor && <Text size="xs" tone="subtle">{event.actor}</Text>}
              <Text size="xs" tone="tertiary">{filteredWhy(event)}</Text>
            </Stack>
          </div>
        ))}
      </div>
    </Stack>
  );
}

/** The filters and the view switch, in one bar above the tasks. */
function Toolbar(props: { tasks: readonly BoardTask[]; filters: BoardFilters; setFilters(filters: BoardFilters): void; view: BoardView; setView(view: BoardView): void; profile(key: string): Profile | undefined; shown: number; filtered?: number }) {
  const { filters, setFilters } = props;
  const options = filterOptions(props.tasks);
  const statusCounts = byStatus(props.tasks);
  const set = (key: keyof BoardFilters) => (event: React.ChangeEvent<HTMLSelectElement | HTMLInputElement>) => setFilters({ ...filters, [key]: event.target.value || undefined });
  const select: React.CSSProperties = { width: "auto", fontSize: "0.75rem", padding: "2px 6px" };
  const any = Object.values(filters).some(Boolean);
  return (
    <Stack direction="row" gap={6} wrap align="center">
      <div role="tablist" aria-label="View" style={{ display: "inline-flex", border: "1px solid var(--dbx-border)", borderRadius: 6, overflow: "hidden" }}>
        {(["list", "swimlanes", "filtered"] as const).map((view) => (
          <button key={view} type="button" role="tab" aria-selected={props.view === view} onClick={() => props.setView(view)} title={view === "filtered" ? "Events the classifier kept from opening a task, and why" : undefined} style={{ border: 0, padding: "3px 10px", fontSize: "0.75rem", cursor: "pointer", color: props.view === view ? "var(--dbx-ink)" : "var(--dbx-subtle)", background: props.view === view ? "var(--dbx-inset)" : "transparent", fontWeight: props.view === view ? 600 : 400 }}>
            {view === "list" ? "☰ List" : view === "swimlanes" ? "▥ Swimlanes" : `⊘ Filtered${props.filtered !== undefined ? ` (${props.filtered})` : ""}`}
          </button>
        ))}
      </div>
      <input className="dbx-input" type="search" aria-label={props.view === "filtered" ? "Search filtered events" : "Search tasks"} placeholder="Search…" value={filters.search ?? ""} onChange={set("search")} style={{ ...select, width: 160 }} />
      {props.view !== "filtered" && <>
      <select className="dbx-input" aria-label="Status" value={filters.status ?? ""} onChange={set("status")} style={select}>
        <option value="">Any status</option>
        {STATUS_GROUPS.map((group) => <option key={group.status} value={group.status}>{group.title} ({statusCounts.get(group.status)!.length})</option>)}
      </select>
      <select className="dbx-input" aria-label="Workstream" value={filters.workstream ?? ""} onChange={set("workstream")} style={select}>
        <option value="">Any workstream</option>
        {options.workstreams.map((option) => <option key={option.value} value={option.value}>{option.value === NONE ? "No workstream" : option.value} ({option.count})</option>)}
      </select>
      <select className="dbx-input" aria-label="Assignee" value={filters.assignee ?? ""} onChange={set("assignee")} style={select}>
        <option value="">Anyone</option>
        {options.assignees.map((option) => <option key={option.value} value={option.value}>{assigneeName(option.assignee, props.profile)} ({option.count})</option>)}
      </select>
      <select className="dbx-input" aria-label="Mode" value={filters.mode ?? ""} onChange={set("mode")} style={select}>
        <option value="">Any mode</option>
        {options.modes.map((option) => <option key={option.value} value={option.value}>{option.value} ({option.count})</option>)}
      </select>
      </>}
      {any && <Button size="sm" onClick={() => setFilters({})}>Clear</Button>}
      {any && props.view !== "filtered" && <Text size="xs" tone="tertiary">{props.shown} of {props.tasks.length}</Text>}
    </Stack>
  );
}

/** The page's id, for opening the board in its own window-wide page. */
export const BOARD_PAGE = "board";
const PLUGIN_ID = "bkvarda.databricks-signals";

/** A board page route: the channel it shows (and its name, for the title). */
export type BoardRoute = Readonly<{ channel?: string; name?: string }>;
export const validBoardRoute = (params: unknown): boolean =>
  params === null ||
  (typeof params === "object" && !Array.isArray(params) && ["channel", "name"].every((key) => (params as Record<string, unknown>)[key] === undefined || typeof (params as Record<string, unknown>)[key] === "string"));

/** The channel a board page was opened with, from its route. */
export function boardRoute(target: unknown): BoardRoute {
  const t = target as { kind?: string; route?: { params?: unknown } } | undefined;
  const params = t?.kind === "page" && t.route?.params && typeof t.route.params === "object" ? (t.route.params as Record<string, unknown>) : {};
  return { ...(typeof params.channel === "string" && { channel: params.channel }), ...(typeof params.name === "string" && { name: params.name }) };
}

type Navigation = { open(target: unknown): Promise<unknown> };

/**
 * The columns side by side. The row scrolls sideways inside whatever holds it
 * (every parent has minWidth 0, so it can't push the host wider than its
 * tab), and ‹ › buttons show when columns are out of view, since some systems
 * hide scrollbars until you scroll.
 */
function Columns(props: { children: React.ReactNode }) {
  const row = React.useRef<HTMLDivElement>(null);
  const [edges, setEdges] = React.useState({ left: false, right: false });
  const measure = React.useCallback(() => {
    const el = row.current;
    if (!el) return;
    setEdges({ left: el.scrollLeft > 1, right: el.scrollLeft + el.clientWidth < el.scrollWidth - 1 });
  }, []);
  React.useEffect(() => {
    measure();
    const el = row.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, [measure]);
  const scroll = (direction: 1 | -1) => row.current?.scrollBy({ left: direction * (COLUMN_WIDTH + 12), behavior: "smooth" });
  const arrow = (direction: 1 | -1): React.CSSProperties => ({ position: "absolute", top: 0, [direction < 0 ? "left" : "right"]: 0, zIndex: 1, boxShadow: "0 1px 4px rgba(0,0,0,0.15)" });
  return (
    <div style={{ position: "relative", minWidth: 0, maxWidth: "100%" }}>
      {edges.left && <div style={arrow(-1)}><Button size="sm" title="Scroll left" aria-label="Scroll left" onClick={() => scroll(-1)}>‹</Button></div>}
      {edges.right && <div style={arrow(1)}><Button size="sm" title="Scroll right" aria-label="Scroll right" onClick={() => scroll(1)}>›</Button></div>}
      <div ref={row} onScroll={measure} style={{ display: "flex", gap: 12, overflowX: "auto", alignItems: "flex-start", minWidth: 0, maxWidth: "100%", paddingBottom: 8 }}>
        {props.children}
      </div>
    </div>
  );
}

const COLUMN_WIDTH = 260;

/** A channel's board: shared by the channel tab and the full-window page. */
function Board(props: {
  ctx: Context;
  service: DatabricksService;
  channel?: { id: string; name?: string };
  /** Opens a thread in place (the channel tab); otherwise the host navigates to it. */
  openThread?(root: string): boolean;
  /** Shown in the header beside Refresh: Open in full window, or the channel picker. */
  action?: React.ReactNode;
  /** What to say when there's no channel. */
  noChannel?: React.ReactNode;
}) {
  const { ctx, service, channel } = props;
  const connection = useConnection(service);
  const hubs = useAsync(async (signal) => (connection.status === "connected" ? chosenHub(service, signal) : undefined), [connection.status]);
  const app = hubs.data?.app;
  const hub = React.useMemo(() => (app ? new HubClient(service.client()!, app) : undefined), [app?.name, app?.url]);
  const [version, refresh] = React.useReducer((n: number) => n + 1, 0);
  const board = useAsync(async (signal) => (hub && channel ? hub.board(channel.id, signal) : undefined), [hub, channel?.id, version]);
  // The classifier's held-back events, for the Filtered view (an older hub without /api/filtered gives none).
  const filtered = useAsync(async (signal) => (hub && channel ? hub.filtered(channel.id, signal).catch((error: Error) => (/No route/.test(error.message) ? [] : Promise.reject(error))) : undefined), [hub, channel?.id, version]);
  const agents = [...new Set((board.data?.tasks ?? []).flatMap((item) => item.people.filter((person) => person.kind === "agent").map((person) => person.key)))];
  const profile = useProfiles(ctx, agents);
  const [view, setView] = React.useState<BoardView>(savedView);
  const chooseView = (next: BoardView) => {
    setView(next);
    try {
      globalThis.localStorage?.setItem(VIEW_KEY, next);
    } catch {
      // Not kept; it's the list next time.
    }
  };
  const [filters, setFilters] = React.useState<BoardFilters>({});
  const [opened, setOpened] = React.useState<number>();
  const [viewing, setViewing] = React.useState<number>();
  React.useEffect(() => (setFilters({}), setOpened(undefined), setViewing(undefined)), [channel?.id]);
  const steer = (item: BoardTask) => {
    if (!item.thread || !channel || !item.task.buzz_root) return;
    if (props.openThread?.(item.thread)) return;
    const relay = optionalService<RelayView>(ctx, "relay")?.snapshot();
    const navigation = optionalService<Navigation>(ctx, "navigation");
    if (!relay?.viewer || !relay.origin || !navigation) return;
    void navigation.open({ version: 1, kind: "conversation", scope: { viewer: relay.viewer, communityOrigin: relay.origin }, channelId: channel.id, messageId: item.task.buzz_root, threadRootId: item.task.buzz_root, context: "channel" });
  };

  let body: React.ReactNode;
  if (connection.status !== "connected") body = <Notice title="Connect Databricks" action={<Button variant="brand" onClick={() => service.openSettings()}>Connect</Button>}>Tasks live in your team's signals hub, a Databricks App.</Notice>;
  else if (!channel) body = props.noChannel ?? <Notice>Open this from a channel's menu.</Notice>;
  else if (hubs.loading || (board.loading && !board.data)) body = <Spinner label="Loading tasks" />;
  else if (hubs.error || board.error) body = <Notice tone="danger">{describeError((hubs.error ?? board.error)!)}</Notice>;
  else if (!hub) body = <Notice title="No signals hub in this workspace">Deploy one first (see the Signals plugin's README).</Notice>;
  else if (!board.data?.tasks.length && !filtered.data?.length) body = <Text tone="subtle" size="sm">No tasks in this channel{board.data?.account ? "" : " (set it up as an account from the channel menu)"}.</Text>;
  else if (viewing !== undefined && board.data?.tasks.some((item) => item.task.id === viewing)) {
    const item = board.data.tasks.find((found) => found.task.id === viewing)!;
    body = <TaskView ctx={ctx} hub={hub} item={item} channel={channel.id} profile={profile} steer={steer} onChange={refresh} back={() => setViewing(undefined)} />;
  } else if (board.data) {
    const shown = filterTasks(board.data.tasks, filters);
    const grouped = byStatus(shown);
    const groups = STATUS_GROUPS.filter((group) => !filters.status || group.status === filters.status);
    const task = (item: BoardTask, Item: typeof TaskRow) => <Item key={item.task.id} hub={hub} item={item} open={opened === item.task.id} toggle={() => setOpened(opened === item.task.id ? undefined : item.task.id)} profile={profile} steer={steer} onChange={refresh} view={(found) => setViewing(found.task.id)} />;
    const header = (group: (typeof STATUS_GROUPS)[number]) => (
      <Stack direction="row" gap={8} align="center">
        <StatusIcon status={group.status} />
        <Text size="sm" weight={600}>{group.title}</Text>
        <Text size="xs" tone="tertiary">{grouped.get(group.status)!.length}</Text>
      </Stack>
    );
    body = (
      <Stack gap={12}>
        <Toolbar tasks={board.data.tasks} filters={filters} setFilters={setFilters} view={view} setView={chooseView} profile={profile} shown={shown.length} {...(filtered.data && { filtered: filtered.data.length })} />
        {view === "filtered" ? (
          <FilteredList events={filtered.data} loading={filtered.loading} {...(filtered.error && { error: filtered.error })} {...(filters.search && { search: filters.search })} />
        ) : !board.data.tasks.length ? (
          <Text tone="subtle" size="sm">No tasks in this channel.</Text>
        ) : !shown.length ? (
          <Text tone="subtle" size="sm">No tasks match these filters.</Text>
        ) : view === "list" ? (
          <div style={{ border: "1px solid var(--dbx-border)", borderRadius: 8, overflow: "hidden", minWidth: 0 }}>
            {groups.filter((group) => grouped.get(group.status)!.length).map((group) => (
              <section key={group.status} aria-label={group.title}>
                <div style={{ padding: "6px 12px", background: "var(--dbx-inset)", borderBottom: "1px solid var(--dbx-border)" }}>{header(group)}</div>
                {grouped.get(group.status)!.map((item) => task(item, TaskRow))}
              </section>
            ))}
          </div>
        ) : (
          <Columns>
            {groups.map((group) => (
              <section key={group.status} aria-label={group.title} style={{ flex: `0 0 ${COLUMN_WIDTH}px`, minWidth: 0, background: "var(--dbx-inset)", borderRadius: 8, padding: 8, boxSizing: "border-box" }}>
                <Stack gap={8}>
                  <div style={{ padding: "2px 4px" }}>{header(group)}</div>
                  {grouped.get(group.status)!.map((item) => task(item, TaskCard))}
                </Stack>
              </section>
            ))}
          </Columns>
        )}
      </Stack>
    );
  }
  return (
    <DbxRoot style={{ minWidth: 0, maxWidth: "100%", width: "100%", boxSizing: "border-box" }}>
      <div style={{ padding: 16, minWidth: 0, maxWidth: "100%", boxSizing: "border-box" }}>
        <Stack gap={16}>
          {/* Not SectionHeader: in a narrow tab its buttons wrap under the title rather than push the panel sideways. */}
          <div style={{ display: "flex", flexWrap: "wrap", alignItems: "flex-end", justifyContent: "space-between", gap: 8, minWidth: 0 }}>
            <Stack gap={2} style={{ flex: "1 1 240px", minWidth: 0 }}>
              <Text as="h3" size="md" weight={500} style={{ overflowWrap: "anywhere" }}>{channel ? `Tasks in #${channel.name ?? "channel"}` : "Tasks"}</Text>
              <Text tone="subtle" size="sm" as="div">{board.data?.account ? `${board.data.account}: who each task is with and what's been made for it. Open a task to act on it.` : "Who each task is with and what's been made for it. Open a task to act on it."}</Text>
            </Stack>
            <Stack direction="row" gap={6} align="center" wrap>
              {props.action}
              {hub && channel && <Button size="sm" disabled={board.loading} onClick={refresh}>{board.loading ? <Spinner size={10} /> : null}Refresh</Button>}
            </Stack>
          </div>
          {body}
        </Stack>
      </div>
    </DbxRoot>
  );
}

/** The "Tasks board" channel panel (a tab), with a button to open it in a full-window page. */
export function boardPanel(ctx: Context, service: DatabricksService) {
  return function BoardPanel({ channelContext, context }: PanelProps) {
    const navigation = optionalService<Navigation>(ctx, "navigation");
    const popOut = channelContext && navigation && (
      <Button size="sm" title="Open the board in a full-window page" onClick={() => void navigation.open({ version: 1, kind: "page", pluginId: PLUGIN_ID, pageId: BOARD_PAGE, route: { version: 1, params: { channel: channelContext.channelId, name: channelContext.channelName } } })}>
        Open in full window ↗
      </Button>
    );
    return (
      <Board
        ctx={ctx}
        service={service}
        {...(channelContext && { channel: { id: channelContext.channelId, name: channelContext.channelName } })}
        openThread={(thread) => Boolean(context?.canOpen(thread) && context.open(thread))}
        action={popOut}
      />
    );
  };
}

/**
 * The board as a full-window page. It shows the channel it was opened with
 * (from the channel tab's Open in full window), or lets you pick one of the
 * account channels set up in the hub.
 */
export function boardPage(ctx: Context, service: DatabricksService) {
  return function BoardPage(props: { navigation?: { target: unknown } }) {
    const opened = boardRoute(props.navigation?.target);
    const [picked, setPicked] = React.useState<{ id: string; name?: string }>();
    React.useEffect(() => setPicked(undefined), [opened.channel]);
    const connection = useConnection(service);
    const accounts = useAsync(async (signal) => {
      if (connection.status !== "connected") return [];
      const found = await chosenHub(service, signal);
      return found?.app ? (await new HubClient(service.client()!, found.app).accounts(signal)).filter((account) => account.channel) : [];
    }, [connection.status]);
    const channel = picked ?? (opened.channel ? { id: opened.channel, ...(opened.name && { name: opened.name }) } : undefined);
    const options = accounts.data ?? [];
    const named = channel && !channel.name ? options.find((account) => account.channel === channel.id) : undefined;
    const shown = channel && { id: channel.id, name: channel.name ?? named?.name ?? "channel" };
    const picker = options.length > 0 && (
      <select
        className="dbx-input"
        aria-label="Account channel"
        value={channel?.id ?? ""}
        onChange={(event) => {
          const account = options.find((item) => item.channel === event.target.value);
          if (account?.channel) setPicked({ id: account.channel, name: account.name });
        }}
        style={{ width: "auto", fontSize: "0.75rem" }}
      >
        {!channel && <option value="">Choose an account…</option>}
        {channel && !options.some((account) => account.channel === channel.id) && <option value={channel.id}>#{channel.name ?? channel.id}</option>}
        {options.map((account) => <option key={account.channel!} value={account.channel!}>{account.name}</option>)}
      </select>
    );
    return (
      <Board
        ctx={ctx}
        service={service}
        {...(shown && { channel: shown })}
        action={picker}
        noChannel={accounts.loading ? <Spinner label="Loading accounts" /> : <Notice>{options.length ? "Choose an account to see its tasks." : "No account channels yet. Set one up from a channel's menu (Set up account)."}</Notice>}
      />
    );
  };
}
