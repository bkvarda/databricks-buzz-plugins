// "Tasks board" in a channel's menu: the channel's signals tasks, in a list
// grouped by status or in swimlanes (a column per status), styled after
// Linear. Filters narrow it by status, workstream, assignee, mode and text.
// Each task shows one assignee: you when it needs your input, otherwise the
// agent on it, otherwise no one. Opening a task shows its latest activity,
// the links made for it, and what you can do: answer what an agent asked
// (Provide input), add an agent, open its thread to steer the agents there,
// change its status or dismiss it. Its full view (Open) shows where it came
// from, its activity as a timeline (the hub's updates as quiet lines, comments
// as cards, a box to reply that mentions the agent it's with) and a sidebar
// with its status, owners, details and assets.
import type { Context } from "@buzz/author";
import type { PanelProps } from "@dbx/core/host-types";
import { optionalService } from "@dbx/core/host-types";
import { React } from "@dbx/core/react";
import { type DatabricksService, describeError, useAsync, useConnection } from "@dbx/core/service";
import { ago, Button, CopyButton, DbxRoot, Disclosure, Notice, Spinner, Stack, Text, openExternal } from "@dbx/core/ui/components";
import { Markdown } from "@dbx/core/ui/markdown";
import { decode, npubEncode } from "nostr-tools/nip19";
import { TASK_STATUSES } from "../app/model";
import { type ActivityEntry, type ActivityLine, type Assignee, assigneeOf, type Member, memberChoices, MODE_NAMES, ownersOf, removable, type BoardFilters, type BoardView, byStatus, cardAssets, type Comment, filterFiltered, filteredWhy, filterOptions, filterTasks, mentionedKeys, NONE, readView, replyMentions, replyText, STATUS_GROUPS, taskActivity, openingTitle, taskFacts, taskOrigin, threadComments, titleHint, withMentionNames, workstreamHint } from "./board-view";
import { type BoardPerson, type BoardTask, chosenHub, type FilteredEvent, HubClient } from "./client";
import type { LiveTasks } from "./live-tasks";
import { plainLine, readTaskTarget, sourceName } from "./posts";

export type Profile = { name?: string; picture?: string; agent?: boolean };
type ProfileQueries = { snapshot(): ReadonlyMap<string, { name?: string; picture?: string; isAgent?: true }>; subscribe(listener: () => void): () => void; ensure(ids: readonly string[]): Promise<void> };
type ThreadMessage = { id: string; authorId: string; createdAt: number; content: string; audience?: "agents"; delivery?: unknown };
type ThreadReader = {
  snapshot(): { status: "idle" | "loading" | "ready" | "error"; root?: ThreadMessage; replies: readonly ThreadMessage[]; error?: string; canLoadMore: boolean; limited?: boolean; readKind?: "older" | "refresh" };
  subscribe(listener: () => void): () => void;
  loadMore(): Promise<void>;
  refresh?(): Promise<void>;
  dispose(): void;
};
type RelaySession = {
  profiles?: ProfileQueries;
  media?: (url: string, size?: "small") => string | undefined;
  thread?: (channelId: string, messageId: string, options?: { exact?: boolean; priority?: "foreground" | "background" }) => ThreadReader;
  messages?: { reply?: (channelId: string, rootId: string, content: string, mentions?: readonly string[]) => string };
  channels?: { get?(channelId: string): { members?: readonly string[] } | undefined; resolve?(channelIds: readonly string[]): Promise<void>; subscribeList?(listener: () => void): () => void };
  channelWrites?: { addAgents?(channelId: string, keys: readonly string[]): Promise<void> };
};
type RelayView = { snapshot(): { viewer?: string; origin?: string; session?: RelaySession; generation?: number; cached?: true; status?: string }; subscribe?(listener: () => void): () => void };

type RelaySnapshot = ReturnType<RelayView["snapshot"]>;
const NO_RELAY: RelaySnapshot = {};
const readRelay = (relay: RelayView | undefined): RelaySnapshot => {
  try {
    return relay?.snapshot() ?? NO_RELAY;
  } catch {
    return NO_RELAY;
  }
};

/**
 * The host's relay snapshot, held steady between the relay's notices. The
 * hooks below key their effects on the session; if they read it fresh on
 * every render and the host hands out a new object each time, an effect that
 * sets state (opening a thread reader, reading the roster) re-runs on every
 * render, which loops until React gives up and the tab crashes. So the
 * snapshot is read only when the relay says it changed, and kept when its
 * session, generation, viewer and origin are all the same.
 */
export function useRelay(ctx: Context): RelaySnapshot {
  const relay = optionalService<RelayView>(ctx, "relay");
  const [held, setHeld] = React.useState<RelaySnapshot>(() => readRelay(relay));
  React.useEffect(() => {
    const update = () =>
      setHeld((previous) => {
        const next = readRelay(relay);
        const same = next.session === previous.session && next.generation === previous.generation && next.viewer === previous.viewer && next.origin === previous.origin;
        // A new session is taken even under the same generation: the relay
        // only notifies on a change, so this can't loop, and a reconnect the
        // host makes without a new generation still reopens the thread.
        return same ? previous : next;
      });
    update();
    try {
      return relay?.subscribe?.(update);
    } catch {
      return undefined;
    }
  }, [relay]);
  return held;
}

/** Buzz profiles (names and pictures) of the agents on the board, from the host's relay when it has one. */
export function useProfiles(ctx: Context, keys: readonly string[]) {
  const session = useRelay(ctx).session;
  const profiles = session?.profiles;
  const [, bump] = React.useReducer((n: number) => n + 1, 0);
  React.useEffect(() => (profiles ? profiles.subscribe(bump) : undefined), [profiles]);
  const wanted = keys.join(",");
  React.useEffect(() => {
    if (!profiles || !keys.length) return;
    // One ensure may ask for at most limit() profiles; a channel's roster can be more.
    const limit = Math.max(1, (profiles as { limit?(): number }).limit?.() ?? 200);
    for (let start = 0; start < keys.length; start += limit) {
      try {
        void profiles.ensure(keys.slice(start, start + limit)).catch(() => {});
      } catch {
        // Names are optional: the board shows short keys without them.
      }
    }
  }, [profiles, wanted]);
  return (key: string): Profile | undefined => {
    let found: { name?: string; picture?: string; isAgent?: true } | undefined;
    try {
      found = profiles?.snapshot().get(key);
    } catch {
      return undefined;
    }
    if (!found) return undefined;
    let picture = found.picture;
    try {
      if (picture && session?.media) picture = session.media(picture, "small") ?? picture;
    } catch {
      // The original URL then.
    }
    return { ...(found.name && { name: found.name }), ...(picture && { picture }), ...(found.isAgent && { agent: true }) };
  };
}

const NO_MEMBERS: readonly string[] = [];

/** A channel's members, from its relay-signed roster (empty until the host has read it). */
export function useMembers(ctx: Context, channel: string | undefined): readonly string[] {
  const channels = useRelay(ctx).session?.channels;
  const [, bump] = React.useReducer((n: number) => n + 1, 0);
  React.useEffect(() => (channels?.subscribeList ? channels.subscribeList(bump) : undefined), [channels]);
  React.useEffect(() => {
    if (!channel || !channels?.resolve) return;
    try {
      void channels.resolve([channel]).then(bump, () => {});
    } catch {
      // No roster then: the picker offers the board's agents.
    }
  }, [channels, channel]);
  try {
    return (channel && channels?.get?.(channel)?.members) || NO_MEMBERS;
  } catch {
    return NO_MEMBERS;
  }
}

/** An npub's hex key, or undefined when it isn't one. */
export const npubKey = (npub: string): string | undefined => {
  try {
    const found = decode(npub);
    return found.type === "npub" ? found.data : undefined;
  } catch {
    return undefined;
  }
};

/** A hex key's npub, or the key itself when it isn't one. */
const npubOf = (key: string): string => {
  try {
    return npubEncode(key);
  } catch {
    return key;
  }
};

const initials = (label: string) => label.replace(/[^\p{L}\p{N} ]/gu, "").split(/\s+/).filter(Boolean).slice(0, 2).map((word) => word[0]!.toUpperCase()).join("") || "?";

/** An assignee's name, from the agent's Buzz profile when there is one. */
export const assigneeName = (assignee: Assignee, profile: (key: string) => Profile | undefined) =>
  assignee.kind === "you" ? "You" : assignee.kind === "unassigned" ? "Unassigned" : (profile(assignee.key)?.name ?? assignee.label);

/** A pubkey's name, or a person's email, for the owner list. */
const nameOf = (person: { key: string; label: string }, profile: (key: string) => Profile | undefined) => profile(person.key)?.name ?? person.label;

/** The assignee's picture (or initials), like Linear's: round for you, square for agents, dashed for no one. */
export function AssigneeMark(props: { assignee: Assignee; profile(key: string): Profile | undefined; size?: number }) {
  const size = props.size ?? 20;
  const name = assigneeName(props.assignee, props.profile);
  const title = props.assignee.kind === "you" ? "You: it needs your input" : props.assignee.kind === "agent" ? `${name} (agent)` : props.assignee.kind === "person" ? name : "Unassigned";
  const base: React.CSSProperties = { width: size, height: size, flex: "none", boxSizing: "border-box", display: "inline-flex", alignItems: "center", justifyContent: "center", fontSize: Math.round(size * 0.42), fontWeight: 600 };
  if (props.assignee.kind === "unassigned") return <span title={title} aria-label={title} style={{ ...base, borderRadius: 999, border: "1.5px dashed var(--dbx-border-strong)" }} />;
  if (props.assignee.kind === "you") return <span title={title} aria-label={title} style={{ ...base, borderRadius: 999, background: "var(--dbx-warning)", color: "var(--dbx-surface)" }}>!</span>;
  const picture = props.profile(props.assignee.key)?.picture;
  // People are round, agents square.
  const style: React.CSSProperties = { ...base, borderRadius: props.assignee.kind === "person" ? 999 : 5, border: "1px solid var(--dbx-border)" };
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
const shorten = (text: string, most: number) => (text.length > most ? `${text.slice(0, most - 1)}…` : text);
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

/**
 * A task's owners, each with an × to take them off, and a picker of the
 * channel's members to assign. Picking someone while it has owners asks
 * whether to add them or reassign (take the others off). The hub posts the
 * change in the thread: an agent assigned is asked to work on it, an agent
 * taken off is told to stop.
 */
function Owners(props: { hub: HubClient; item: BoardTask; members: readonly string[]; boardAgents: readonly string[]; viewer?: string; profile(key: string): Profile | undefined; onChange(): void; compact?: boolean }) {
  const { item } = props;
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string>();
  const [picked, setPicked] = React.useState<Member>();
  const closed = item.task.status === "done" || item.task.status === "dismissed";
  const owners = ownersOf(item);
  const helpers = removable(item).filter((person) => person.role !== "owner");
  const choices = memberChoices(props.members, props.boardAgents, owners.map((owner) => owner.key), props.profile, props.viewer);
  const run = async (input: { assign?: { key: string; kind: "agent" | "person" }[]; unassign?: { key: string; kind: "agent" | "person" }[] }) => {
    setBusy(true);
    setError(undefined);
    try {
      await props.hub.updateTask({ id: item.task.id, ...input });
      setPicked(undefined);
      props.onChange();
    } catch (problem) {
      setError(describeError(problem));
    } finally {
      setBusy(false);
    }
  };
  const asOwner = (member: Member) => ({ key: member.key, kind: member.agent ? ("agent" as const) : ("person" as const) });
  const off = (person: BoardPerson) => ({ key: person.key, kind: person.kind as "agent" | "person" });
  const pick = (key: string) => {
    const member = choices.find((choice) => choice.key === key);
    if (!member) return;
    if (!owners.length) void run({ assign: [asOwner(member)] });
    else setPicked(member);
  };
  const row = (person: BoardPerson, owner: boolean) => (
    <Stack key={`${person.kind}:${person.key}`} direction="row" gap={8} align="center">
      <AssigneeMark assignee={{ kind: person.kind as "agent" | "person", key: person.key, label: person.label }} profile={props.profile} />
      <Text size="sm" style={{ flex: "1 1 auto", minWidth: 0, overflow: "hidden", textOverflow: "ellipsis" }}>{nameOf(person, props.profile)}{!owner && <span style={{ color: "var(--dbx-tertiary)" }}> · {person.role}</span>}</Text>
      {!closed && <button type="button" className="dbx-input" disabled={busy} title={person.kind === "agent" ? "Take it off this task: it's told in the thread to stop" : "Take them off this task"} aria-label={`Take ${nameOf(person, props.profile)} off`} onClick={() => void run({ unassign: [off(person)] })} style={{ width: "auto", padding: "0 6px", lineHeight: 1.4, cursor: "pointer" }}>×</button>}
    </Stack>
  );
  return (
    <Stack gap={6}>
      <Text size="xs" tone="tertiary" weight={600}>OWNERS</Text>
      {item.task.question && !closed && !props.compact && <Stack direction="row" gap={8} align="center"><AssigneeMark assignee={{ kind: "you" }} profile={props.profile} /><Text size="sm">Waiting on your input</Text></Stack>}
      {owners.length ? owners.map((person) => row(person, true)) : <Text size="xs" tone="subtle">No one{helpers.length ? "; agents asked are below" : ""}.</Text>}
      {helpers.length > 0 && helpers.map((person) => row(person, false))}
      {!closed && !picked && (
        <select className="dbx-input" aria-label="Assign" disabled={busy || !choices.length} value="" onChange={(event) => pick(event.target.value)} style={{ fontSize: "0.75rem" }}>
          <option value="">{choices.length ? "Assign to…" : "No channel members to assign"}</option>
          {choices.map((member) => <option key={member.key} value={member.key}>{member.agent ? "🤖 " : ""}{member.name}</option>)}
        </select>
      )}
      {picked && (
        <Stack gap={6}>
          <Text size="xs">Assign {picked.name}:</Text>
          <Stack direction="row" gap={6} wrap>
            <Button size="sm" variant="brand" disabled={busy} title="Take the current owners off and assign them" onClick={() => void run({ assign: [asOwner(picked)], unassign: owners.map(off) })}>Reassign</Button>
            <Button size="sm" disabled={busy} title="Keep the current owners" onClick={() => void run({ assign: [asOwner(picked)] })}>Add</Button>
            <Button size="sm" disabled={busy} onClick={() => setPicked(undefined)}>Cancel</Button>
          </Stack>
        </Stack>
      )}
      {busy && <Spinner size={10} />}
      {error && <Text size="xs" tone="danger">{error}</Text>}
    </Stack>
  );
}

/** What a waiting task asks, with its choices and a box for any other answer; the answer goes to its thread. */
export function ProvideInput(props: { hub: HubClient; task: BoardTask; onDone(): void; startOpen?: boolean }) {
  const { task } = props.task;
  const [open, setOpen] = React.useState(Boolean(props.startOpen));
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
/** What the owner pickers need: the channel's members, the board's agents, who's viewing, and their names. */
type Assigning = Readonly<{ members: readonly string[]; boardAgents: readonly string[]; viewer?: string; profile(key: string): Profile | undefined }>;

function TaskBody(props: { hub: HubClient; item: BoardTask; steer(item: BoardTask): void; onChange(): void; open?(item: BoardTask): void; assigning?: Assigning }) {
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
      {props.assigning && <Owners hub={props.hub} item={item} {...props.assigning} onChange={props.onChange} compact />}
      {item.source?.title && <Text size="xs" tone="subtle">From {sourceName(item.source.source)}: {item.source.url ? <a className="dbx-link" href={item.source.url} onClick={link(item.source.url)}>{item.source.title}</a> : item.source.title}</Text>}
      {item.activity && <Text size="xs" tone="subtle">{item.activity.kind === "agent_reply" ? "Agent: " : ""}{shorten(plainLine(item.activity.text, (npub) => props.assigning?.profile(npubKey(npub) ?? "")?.name), 280)} <span style={{ color: "var(--dbx-tertiary)" }}>· {ago(item.activity.at * 1000)}</span></Text>}
      {assets.length > 0 && (
        <Stack direction="row" gap={6} wrap>
          {assets.map((artifact) => (
            <a className="dbx-link" key={`${artifact.at}:${artifact.url}`} href={artifact.url} onClick={link(artifact.url)} title={artifact.url} style={{ fontSize: "0.75rem" }}>
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
          {TASK_STATUSES.map((status) => <option key={status} value={status}>{STATUS_GROUPS.find((group) => group.status === status)?.title ?? status}</option>)}
        </select>
        {!closed && <Button size="sm" variant="danger" disabled={busy} onClick={() => void setStatus("dismissed")}>Dismiss</Button>}
      </Stack>
    </Stack>
  );
}

type TaskProps = { hub: HubClient; item: BoardTask; open: boolean; toggle(): void; profile(key: string): Profile | undefined; steer(item: BoardTask): void; onChange(): void; view(item: BoardTask): void; assigning: Assigning };

/**
 * The assignee's mark as a button: it opens the task in place, where its
 * owners are at the top with the picker, so assigning or reassigning takes
 * two clicks from the board.
 */
function AssignButton(props: { assignee: Assignee; profile(key: string): Profile | undefined; size?: number; open: boolean; toggle(): void }) {
  const name = assigneeName(props.assignee, props.profile);
  return (
    <button
      type="button"
      title={props.open ? `${name}: owners are below` : `${name}: click to assign or reassign`}
      aria-label={`Assign (now ${name})`}
      onClick={(event) => (event.stopPropagation(), props.open || props.toggle())}
      onKeyDown={(event) => event.stopPropagation()}
      style={{ border: 0, padding: 0, background: "transparent", cursor: "pointer", display: "inline-flex", flex: "none", borderRadius: 999 }}
    >
      <AssigneeMark assignee={props.assignee} profile={props.profile} {...(props.size && { size: props.size })} />
    </button>
  );
}

/** Where a task came from, beside its title: the ticket key of the source it opened from, when its title left it out (Jira ES-2376026), or else its latest source. */
function SourceMark(props: { source: NonNullable<BoardTask["source"]>; origin?: BoardTask["origin"]; title: string }) {
  const { ref } = taskOrigin(props.title, props.origin);
  const label = ref && props.origin ? `${sourceName(props.origin.source)} ${ref}` : sourceName(props.source.source);
  return <Text size="xs" tone="tertiary" mono={Boolean(ref)}><span title={label} style={{ whiteSpace: "nowrap" }}>{ref ?? label}</span></Text>;
}

/** The labels a task shows beside its title: workstream, initiative, mode, source and the links made for it. */
function Meta(props: { item: BoardTask }) {
  const { item } = props;
  const assets = cardAssets(item);
  return (
    <>
      {item.task.workstream && <Chip title={workstreamHint(item.task)}>{item.task.workstream}</Chip>}
      {item.task.initiative && <Chip tone="brand">{item.task.initiative}</Chip>}
      {item.task.mode !== "draft" && <Chip tone={item.task.mode === "auto" ? "success" : undefined} title="How agents handle it">{item.task.mode}</Chip>}
      {item.source && <SourceMark source={item.source} {...(item.origin && { origin: item.origin })} title={item.task.title} />}
      {assets.slice(0, 3).map((artifact) => (
        <a className="dbx-link" key={`${artifact.at}:${artifact.url}`} href={artifact.url} onClick={link(artifact.url)} title={artifact.title ?? artifact.url} style={{ fontSize: "0.75rem", textDecoration: "none" }}>{ASSET_ICON[artifact.kind] ?? "🔗"}</a>
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
        <Text size="sm" weight={500} style={{ flex: "1 1 auto", minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}><span title={titleHint(item.task.title, item.origin)}>{item.task.title}</span></Text>
        <span style={{ display: "flex", gap: 6, alignItems: "center", flex: "none", maxWidth: "45%", overflow: "hidden" }}><Meta item={item} /></span>
        <Text size="xs" tone="tertiary" style={{ flex: "none", width: 52, textAlign: "right" }}>{ago(item.task.last_event_at * 1000)}</Text>
        <AssignButton assignee={assignee} profile={props.profile} open={props.open} toggle={props.toggle} />
      </div>
      {props.open && <div style={{ padding: "0 12px 10px 54px" }}><TaskBody hub={props.hub} item={item} steer={props.steer} onChange={props.onChange} open={props.view} assigning={props.assigning} /></div>}
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
              <AssignButton assignee={assignee} profile={props.profile} size={18} open={props.open} toggle={props.toggle} />
            </Stack>
          </Stack>
          <Stack direction="row" gap={6} align="flex-start">
            <span style={{ paddingTop: 2 }}><StatusIcon status={item.task.status} /></span>
            <Text size="sm" weight={500} style={{ minWidth: 0, overflowWrap: "anywhere" }}><span title={titleHint(item.task.title, item.origin)}>{item.task.title}</span></Text>
          </Stack>
          <Stack direction="row" gap={6} wrap align="center"><Meta item={item} /></Stack>
        </Stack>
      </div>
      {props.open && <TaskBody hub={props.hub} item={item} steer={props.steer} onChange={props.onChange} open={props.view} assigning={props.assigning} />}
    </div>
  );
}

/**
 * A task's thread from the host's relay, as comments, kept up to date while it's shown.
 *
 * The host replaces its relay session when it connects or reconnects, and
 * a reader opened on the old one (say, on the device's saved copy while
 * connecting) shows what was saved, often just the root, and never reads on.
 * So this follows the relay and opens a new reader on each new session. A
 * reader that settles with the root alone is asked once to refresh.
 */
function useThread(ctx: Context, channel: string | undefined, root: string | null | undefined) {
  const session = useRelay(ctx).session;
  const [reader, setReader] = React.useState<ThreadReader>();
  const [, bump] = React.useReducer((n: number) => n + 1, 0);
  React.useEffect(() => {
    if (!channel || !root || !session?.thread) return setReader(undefined);
    let opened: ThreadReader;
    try {
      opened = session.thread(channel, root, { priority: "foreground" });
    } catch {
      // The host can't read it now; the view offers to open it in Buzz.
      return setReader(undefined);
    }
    let refreshed = false;
    const settle = () => {
      const now = opened.snapshot();
      if (!refreshed && now.status === "ready" && !now.replies.length && opened.refresh) {
        refreshed = true;
        void opened.refresh().catch(() => {});
      }
      bump();
    };
    const stop = opened.subscribe(settle);
    setReader(opened);
    settle();
    return () => (stop(), opened.dispose());
  }, [session, channel, root]);
  const snapshot = reader?.snapshot();
  const messages = snapshot ? [...(snapshot.root ? [snapshot.root] : []), ...snapshot.replies] : [];
  const reply = session?.messages?.reply;
  return {
    available: Boolean(session?.thread),
    status: snapshot?.status ?? "idle",
    /** Reading more of it (a refresh or an earlier page) while some is shown. */
    reading: snapshot?.status === "loading" || Boolean(snapshot?.readKind),
    /** The reader stopped at its bound with no way to read on here. */
    limited: Boolean(snapshot?.limited && !snapshot.canLoadMore),
    error: snapshot?.error,
    comments: threadComments(messages),
    more: snapshot?.canLoadMore ? () => void reader?.loadMore() : undefined,
    reply: reply && channel && root ? (content: string, mentions: readonly string[]) => reply(channel, root, content, mentions) : undefined,
  };
}

const fullTime = (seconds: number) => new Date(seconds * 1000).toLocaleString([], { dateStyle: "medium", timeStyle: "short" });
/** An address as the part before the @, which is how the team reads it in a line; the whole address is on hover. */
const shortEmails = (text: string) => text.replace(/\b([\w.+-]+)@[\w-]+(?:\.[\w-]+)+\b/g, "$1");
/** A line the hub wrote, as plain text with mentions as @Name and addresses short. */
const lineText = (text: string, profile: (key: string) => Profile | undefined) => shortEmails(plainLine(text, (npub) => profile(npubKey(npub) ?? "")?.name));

/** A message's Markdown in Buzz's own renderer when the host has one, so it reads like the conversation; mentions show as @Name either way. */
function RichText(props: { ctx: Context; text: string; profile(key: string): Profile | undefined }) {
  const HostMarkdown = (props.ctx as unknown as { conversation?: { ui?: { Markdown?: React.ComponentType<{ content: string; scale?: "message" | "document" }> } } }).conversation?.ui?.Markdown;
  const named = withMentionNames(props.text, npubKey, (key) => props.profile(key)?.name);
  return <div className="dbx-quiet-headings" style={{ overflowWrap: "anywhere", minWidth: 0 }}>{HostMarkdown ? <HostMarkdown content={named} /> : <Markdown source={named} size="sm" />}</div>;
}

/**
 * One step of the activity, like GitHub's timeline: a mark in the left
 * gutter, joined to the next step by a thin line, and the step beside it.
 */
function Step(props: { mark: React.ReactNode; last?: boolean; children: React.ReactNode }) {
  return (
    <div style={{ display: "flex", gap: 10, minWidth: 0 }}>
      <div style={{ flex: "none", width: 24, display: "flex", flexDirection: "column", alignItems: "center" }}>
        {props.mark}
        {!props.last && <span aria-hidden style={{ flex: "1 1 auto", width: 1, minHeight: 8, marginTop: 4, background: "var(--dbx-border)" }} />}
      </div>
      <div style={{ flex: "1 1 auto", minWidth: 0, paddingBottom: props.last ? 0 : 14 }}>{props.children}</div>
    </div>
  );
}

/** A line's small round mark in the gutter. */
function LineMark(props: { icon: React.ReactNode; tone?: "success" | "warning" }) {
  const color = props.tone === "success" ? "var(--dbx-success)" : props.tone === "warning" ? "var(--dbx-warning)" : "var(--dbx-subtle)";
  return <span aria-hidden style={{ width: 24, height: 24, flex: "none", boxSizing: "border-box", borderRadius: 999, border: "1px solid var(--dbx-border)", background: "var(--dbx-inset)", color, display: "inline-flex", alignItems: "center", justifyContent: "center", fontSize: 11, lineHeight: 1 }}>{props.icon}</span>;
}

/** Someone's picture in the gutter: round for people, square for agents, as on the board. */
function PersonMark(props: { id: string; profile(key: string): Profile | undefined; size?: number }) {
  const found = props.profile(props.id);
  const label = found?.name ?? `${npubOf(props.id).slice(0, 12)}…`;
  return <AssigneeMark assignee={{ kind: found?.agent ? "agent" : "person", key: props.id, label }} profile={props.profile} size={props.size ?? 24} />;
}

const Who = (props: { children: React.ReactNode }) => <span style={{ color: "var(--dbx-ink)", fontWeight: 600 }}>{props.children}</span>;
const When = (props: { at: number }) => <span title={fullTime(props.at)} style={{ color: "var(--dbx-tertiary)", whiteSpace: "nowrap" }}>{ago(props.at * 1000)}</span>;
const STATUS_WORD = /^(.+?) set this to \*\*(\w[\w ]*)\*\*(?::\s*(.*))?$/;

/** What a line in the activity says, its mark, and whether it has more for agents. */
function describeLine(line: ActivityLine, profile: (key: string) => Profile | undefined): { mark: React.ReactNode; body: React.ReactNode; more: boolean } {
  const text = (value: string) => lineText(value, profile);
  if (line.kind === "opened") {
    const from = line.post.source && sourceName(line.post.source.kind);
    return { mark: <LineMark icon="📌" />, body: <span>Task opened{from ? <> from <Who>{from}</Who></> : null}{line.post.source?.from ? ` · ${shortEmails(line.post.source.from)}` : ""}</span>, more: true };
  }
  if (line.kind === "note") {
    const name = profile(line.comment.author)?.name ?? "An agent";
    return { mark: <LineMark icon="✎" />, body: <span><Who>{name}</Who> left a note for agents</span>, more: true };
  }
  const { post } = line;
  switch (post.kind) {
    case "question":
      return { mark: <LineMark icon="?" tone="warning" />, body: <span><Who>{text(post.by)}</Who> asked: “{shorten(post.question, 160)}”</span>, more: false };
    case "answered":
      return { mark: <LineMark icon="↳" />, body: <span><Who>{text(post.who)}</Who> answered <Who>{text(post.answer)}</Who></span>, more: post.forAgents };
    case "status": {
      const found = STATUS_WORD.exec(post.text);
      const status = found?.[2]?.trim().replace(" ", "_");
      const title = STATUS_GROUPS.find((group) => group.status === status)?.title ?? found?.[2];
      return found
        ? { mark: <LineMark icon={<StatusIcon status={status ?? ""} size={11} />} />, body: <span><Who>{text(found[1]!)}</Who> moved it to <Who>{title}</Who>{found[3] ? `: ${text(found[3])}` : ""}</span>, more: false }
        : { mark: <LineMark icon="●" />, body: <span>{text(post.text)}</span>, more: false };
    }
    case "assigned":
      return { mark: <LineMark icon="👤" />, body: <span>{text(post.text)}</span>, more: post.forAgents };
    case "update":
      return {
        mark: <LineMark icon="↻" />,
        body: (
          <span>
            Source updated: {post.url ? <a className="dbx-link" href={post.url} onClick={link(post.url)} title={post.url}>{post.title}</a> : post.title}
            {post.changes.map((change) => <span key={change.field} style={{ marginLeft: 6 }}><Chip title={`${change.field}: ${change.from} → ${change.to}`}>{change.field} → {change.to}</Chip></span>)}
          </span>
        ),
        more: post.forAgents,
      };
    case "done":
      return { mark: <LineMark icon="✓" tone="success" />, body: <span><Who>Done</Who>: {text(post.reason)}</span>, more: false };
    case "nudge":
      return { mark: <LineMark icon="⏱" />, body: <span>{text(post.text)}</span>, more: false };
    case "asked":
      return { mark: <LineMark icon="→" />, body: <span>{post.text}</span>, more: true };
  }
}

/** A line in the activity: what happened and when, with what the hub wrote for agents folded under it. */
function LineStep(props: { ctx: Context; line: ActivityLine; profile(key: string): Profile | undefined; last?: boolean }) {
  const [open, setOpen] = React.useState(false);
  const { mark, body, more } = describeLine(props.line, props.profile);
  const label = props.line.kind === "note" ? "Show" : "For agents";
  return (
    <Step mark={mark} {...(props.last && { last: true })}>
      <div style={{ display: "flex", flexWrap: "wrap", alignItems: "baseline", columnGap: 6, rowGap: 2, minHeight: 24, paddingTop: 4, boxSizing: "border-box", fontSize: "0.75rem", color: "var(--dbx-subtle)", overflowWrap: "anywhere" }}>
        {body}
        <When at={props.line.comment.at} />
        {more && (
          <button type="button" aria-expanded={open} onClick={() => setOpen(!open)} style={{ border: 0, background: "transparent", padding: 0, cursor: "pointer", color: "var(--dbx-tertiary)", fontSize: "0.75rem", textDecoration: "underline dotted" }}>
            {open ? "Hide" : label}
          </button>
        )}
      </div>
      {open && (
        <div style={{ marginTop: 6, padding: "8px 12px", borderRadius: 8, border: "1px solid var(--dbx-border)", background: "var(--dbx-inset)" }}>
          <RichText ctx={props.ctx} text={props.line.comment.text} profile={props.profile} />
        </div>
      )}
    </Step>
  );
}

/** The thread message the hub recorded as the agent's reply (or draft) for the task, the newest one, by id. */
const recordedReply = (item: BoardTask) =>
  item.artifacts
    .filter((artifact) => artifact.kind === "reply" || artifact.kind === "draft")
    .sort((a, b) => a.at - b.at)
    .map((artifact) => /[?&]id=([0-9a-f]{64})/.exec(artifact.url)?.[1])
    .filter(Boolean)
    .at(-1);

/** How tall a comment shows before "Show more". */
const COMMENT_HEIGHT = 280;

/** A comment: who wrote it and when, over what they said; a long one is cut short until you open it. */
function CommentStep(props: { ctx: Context; comment: Comment; profile(key: string): Profile | undefined; expanded: boolean }) {
  const { comment } = props;
  const name = props.profile(comment.author)?.name ?? `${npubOf(comment.author).slice(0, 12)}…`;
  const [open, setOpen] = React.useState(props.expanded);
  const [long, setLong] = React.useState(false);
  const body = React.useRef<HTMLDivElement>(null);
  const text = comment.text.length > 20000 ? `${comment.text.slice(0, 19999)}…` : comment.text;
  React.useLayoutEffect(() => {
    const element = body.current;
    if (!element) return;
    const measure = () => setLong(element.scrollHeight > COMMENT_HEIGHT + 60);
    measure();
    const Observer = (globalThis as { ResizeObserver?: typeof ResizeObserver }).ResizeObserver;
    if (!Observer) return;
    const observer = new Observer(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [text]);
  const cut = long && !open;
  const fade = "linear-gradient(to bottom, #000 65%, transparent)";
  return (
    <Step mark={<PersonMark id={comment.author} profile={props.profile} />}>
      <div style={{ border: "1px solid var(--dbx-border)", borderRadius: 8, background: "var(--dbx-surface)", minWidth: 0, opacity: comment.pending ? 0.6 : 1 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 6, padding: "6px 6px 0 12px", minWidth: 0 }}>
          <Text size="sm" weight={600} style={{ minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{name}</Text>
          <Text size="xs" tone="tertiary" style={{ flex: "1 1 auto", whiteSpace: "nowrap" }}>
            <When at={comment.at} />
            {comment.pending ? " · sending" : ""}
          </Text>
          {comment.failed && <Text size="xs" tone="danger">Not sent</Text>}
          {/* A long comment is usually a draft someone will send: copy it as written. */}
          {long && <CopyButton text={comment.text} />}
        </div>
        <div ref={body} style={{ padding: "0 12px 10px", ...(cut && { maxHeight: COMMENT_HEIGHT, overflow: "hidden", maskImage: fade, WebkitMaskImage: fade }) }}>
          <RichText ctx={props.ctx} text={text} profile={props.profile} />
        </div>
        {long && (
          <div style={{ padding: "0 12px 8px" }}>
            <button type="button" className="dbx-link" aria-expanded={open} onClick={() => setOpen(!open)} style={{ border: 0, background: "transparent", padding: 0, cursor: "pointer", fontSize: "0.75rem" }}>
              {open ? "Show less" : "Show more"}
            </button>
          </div>
        )}
      </div>
    </Step>
  );
}

/** A run of lines, folded: the last two show, and the rest open with one click. */
function LinesStep(props: { ctx: Context; lines: readonly ActivityLine[]; profile(key: string): Profile | undefined; last?: boolean }) {
  const [open, setOpen] = React.useState(false);
  const shown = open ? props.lines : props.lines.slice(-2);
  const hidden = props.lines.length - shown.length;
  return (
    <>
      {hidden > 0 && (
        <Step mark={<LineMark icon="⋯" />}>
          <button type="button" onClick={() => setOpen(true)} style={{ border: 0, background: "transparent", padding: "4px 0 0", cursor: "pointer", color: "var(--dbx-subtle)", fontSize: "0.75rem", minHeight: 24 }}>
            Show {hidden} earlier {hidden === 1 ? "update" : "updates"}
          </button>
        </Step>
      )}
      {shown.map((line, at) => <LineStep key={line.comment.id} ctx={props.ctx} line={line} profile={props.profile} {...(props.last && at === shown.length - 1 && { last: true })} />)}
    </>
  );
}

/** The box at the end of the activity: a reply in the task's thread, mentioning the agent it's with. */
function ReplyBox(props: { assignee: Assignee; profile(key: string): Profile | undefined; send?: (content: string, mentions: readonly string[]) => string; steer(): void }) {
  const [text, setText] = React.useState("");
  const [error, setError] = React.useState<string>();
  const mentions = replyMentions(props.assignee);
  const to = props.assignee.kind === "agent" ? (props.profile(props.assignee.key)?.name ?? props.assignee.label) : undefined;
  if (!props.send) return <Text size="xs" tone="subtle">Replying needs Buzz's thread view here. <a className="dbx-link" href="#" onClick={(event) => (event.preventDefault(), props.steer())}>Open the thread</a> to reply.</Text>;
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
        style={{ resize: "vertical", minHeight: 64 }}
      />
      {error && <Text size="xs" tone="danger">{error}</Text>}
      <Stack direction="row" gap={8} align="center" justify="space-between" wrap>
        <Text size="xs" tone="tertiary">{to ? `Mentions ${to}, the agent it's with` : props.assignee.kind === "you" ? "Mentions no one: it's waiting on your answer" : "Mentions no one: no agent is on it"} · ⌘↵ sends</Text>
        <Button size="sm" variant="brand" disabled={!text.trim()} onClick={send}>Reply</Button>
      </Stack>
    </Stack>
  );
}

/** Whether an element is at least `min` px wide, kept current as it resizes; read before paint, so the layout doesn't jump. */
function useWide(ref: React.RefObject<HTMLElement | null>, min: number): boolean {
  const [wide, setWide] = React.useState(true);
  React.useLayoutEffect(() => {
    const element = ref.current;
    if (!element) return;
    const measure = () => setWide(element.getBoundingClientRect().width >= min);
    measure();
    const Observer = (globalThis as { ResizeObserver?: typeof ResizeObserver }).ResizeObserver;
    if (!Observer) return;
    const observer = new Observer(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [min]);
  return wide;
}

/** A section of the task's sidebar: a quiet label over its contents. */
function Section(props: { title: string; children: React.ReactNode }) {
  return (
    <Stack gap={6}>
      <Text size="xs" tone="tertiary" weight={600}>{props.title.toUpperCase()}</Text>
      {props.children}
    </Stack>
  );
}

/** Setting a task's status from its view, with what went wrong if it didn't. */
function useSetStatus(hub: HubClient, id: number, onChange: () => void) {
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string>();
  const set = async (status: string) => {
    setBusy(true);
    setError(undefined);
    try {
      await hub.updateTask({ id, status });
      onChange();
    } catch (problem) {
      setError(describeError(problem));
    } finally {
      setBusy(false);
    }
  };
  return { busy, error, set };
}

/** The status picker, with each status named as the board names it. */
function StatusPicker(props: { status: string; busy: boolean; set(status: string): void }) {
  return (
    <select className="dbx-input" aria-label="Status" disabled={props.busy} value={props.status} onChange={(event) => props.set(event.target.value)} style={{ width: "auto", maxWidth: "100%", fontSize: "0.75rem" }}>
      {TASK_STATUSES.map((status) => <option key={status} value={status}>{STATUS_GROUPS.find((group) => group.status === status)?.title ?? status}</option>)}
    </select>
  );
}

/**
 * A task's full view, like a Linear issue: its title and where it came from,
 * what it needs from you, then its activity as a timeline: the hub's
 * updates as quiet lines, comments as cards (long ones cut short), and a box
 * to reply. Its status, owners, details and assets are in a sidebar beside
 * it, or above the activity when the view is narrow.
 */
function TaskView(props: { ctx: Context; hub: HubClient; item: BoardTask; channel?: string; boardAgents: readonly string[]; profile(key: string): Profile | undefined; steer(item: BoardTask): void; onChange(): void; back?(): void }) {
  const { item } = props;
  const assignee = assigneeOf(item);
  const thread = useThread(props.ctx, props.channel ?? item.task.channel ?? undefined, item.task.buzz_root);
  const assets = item.artifacts.filter((artifact) => /^https?:/.test(artifact.url) && !["reply", "draft"].includes(artifact.kind));
  const facts = taskFacts(item);
  const authorProfile = useProfiles(props.ctx, [...new Set(thread.comments.flatMap((comment) => [comment.author, ...mentionedKeys(comment.text, npubKey)]))]);
  const who = (key: string) => props.profile(key) ?? authorProfile(key);
  // Owners and agents asked are under Owners.
  const people = item.people.filter((person) => person.kind !== "agent" && !person.on);
  const members = useMembers(props.ctx, props.channel ?? item.task.channel ?? undefined);
  useProfiles(props.ctx, members);
  const viewer = useRelay(props.ctx).viewer;
  const status = useSetStatus(props.hub, item.task.id, props.onChange);
  const closed = item.task.status === "done" || item.task.status === "dismissed";
  const box = React.useRef<HTMLDivElement>(null);
  const wide = useWide(box, 680);
  const entries = React.useMemo(() => taskActivity(thread.comments), [thread.comments]);
  const opened = entries.find((entry): entry is Extract<ActivityEntry, { kind: "opened" }> => entry.kind === "opened")?.post;
  // The newest comment shows in full, and so does the agent's reply the hub recorded on the task (the draft it's for, say).
  const comments = entries.flatMap((entry) => (entry.kind === "comment" ? [entry.comment] : []));
  const expanded = new Set([comments.at(-1)?.id, recordedReply(item)]);
  const commentCount = comments.length;
  const end = React.useRef<HTMLDivElement>(null);
  const count = thread.comments.length;
  // A new comment can come with a status change or an asset (agents post them in the thread), so reload the task then, and show it.
  const seen = React.useRef<number | undefined>(undefined);
  const { onChange } = props;
  React.useEffect(() => {
    if (thread.status !== "ready") return;
    if (seen.current !== undefined && count > seen.current) (onChange(), end.current?.scrollIntoView?.({ block: "nearest" }));
    seen.current = count;
  }, [count, thread.status]);
  const source = item.source;
  const ticket = taskOrigin(item.task.title, item.origin).ref;
  const opening = openingTitle(item);
  const sourceLine = [source && sourceName(source.source), opened?.source?.from && shortEmails(opened.source.from)].filter(Boolean).join(" · ");
  const quote = opened?.source?.quote;
  const sourceFacts = opened?.source?.facts ?? [];
  const openThread = item.thread ? () => props.steer(item) : undefined;

  // Beside the activity, everything shows; above it, in a narrow view, the details fold away under status and owners.
  const more = (
    <Stack gap={16}>
      <Section title="Details">
        <div style={{ display: "grid", gridTemplateColumns: "auto minmax(0, 1fr)", columnGap: 12, rowGap: 4, fontSize: "0.75rem" }}>
          {facts.map((fact) => (
            <React.Fragment key={fact.label}>
              <span style={{ color: "var(--dbx-tertiary)", whiteSpace: "nowrap" }}>{fact.label}</span>
              <span title={fact.title} style={{ minWidth: 0, overflowWrap: "anywhere", color: "var(--dbx-ink)" }}>{fact.value}{fact.note && <span style={{ display: "block", color: "var(--dbx-tertiary)" }}>{fact.note}</span>}</span>
            </React.Fragment>
          ))}
        </div>
      </Section>
      {people.length > 0 && (
        <Section title="People">
          {people.map((person) => <Text key={`${person.kind}:${person.key}`} size="xs" style={{ overflowWrap: "anywhere" }}>{person.label} <span style={{ color: "var(--dbx-tertiary)" }}>· {person.role}</span></Text>)}
        </Section>
      )}
      <Section title="Assets">
        {!assets.length ? <Text size="xs" tone="subtle">Nothing made for it yet.</Text> : assets.map((artifact) => (
          <a className="dbx-link" key={`${artifact.at}:${artifact.url}`} href={artifact.url} onClick={link(artifact.url)} title={artifact.url} style={{ display: "flex", gap: 6, alignItems: "baseline", fontSize: "0.75rem", minWidth: 0, textDecoration: "none", opacity: artifact.kind === "workspace" ? 0.7 : 1 }}>
            <span aria-hidden style={{ flex: "none" }}>{ASSET_ICON[artifact.kind] ?? "🔗"}</span>
            <span style={{ minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{artifact.title ?? artifact.url.replace(/^https?:\/\//, "")}</span>
          </a>
        ))}
      </Section>
    </Stack>
  );
  const sidebar = (
    <Stack gap={16}>
      <Section title="Status">
        <StatusPicker status={item.task.status} busy={status.busy} set={(next) => void status.set(next)} />
        {status.error && <Text size="xs" tone="danger">{status.error}</Text>}
      </Section>
      <Owners hub={props.hub} item={item} members={members} boardAgents={props.boardAgents} {...(viewer && { viewer })} profile={who} onChange={props.onChange} />
      {wide ? more : <Disclosure summary={`Details${assets.length ? ` and ${assets.length} ${assets.length === 1 ? "asset" : "assets"}` : ""}`}>{more}</Disclosure>}
      {!closed && (
        <div>
          <Button size="sm" disabled={status.busy} title="Close it without doing it; agents stop working on it" onClick={() => void status.set("dismissed")}>Dismiss task</Button>
        </div>
      )}
    </Stack>
  );

  return (
    <div ref={box} style={{ minWidth: 0 }}>
      <Stack gap={16}>
        <Stack gap={8}>
          <Stack direction="row" gap={8} align="center">
            {props.back && <Button size="sm" variant="ghost" onClick={props.back}>← Board</Button>}
            <Text size="xs" tone="tertiary" mono>Task {item.task.id}</Text>
            {ticket && <Text size="xs" tone="tertiary" mono>{ticket}</Text>}
            {item.task.workstream && <Chip title={workstreamHint(item.task)}>{item.task.workstream}</Chip>}
            {item.task.mode !== "draft" && <Chip tone={item.task.mode === "auto" ? "success" : undefined} title={MODE_NAMES[item.task.mode]?.title}>{item.task.mode}</Chip>}
          </Stack>
          <Stack direction="row" gap={8} align="flex-start">
            <span style={{ paddingTop: 5 }}><StatusIcon status={item.task.status} size={15} /></span>
            <Text as="h2" size="xl" weight={600} style={{ overflowWrap: "anywhere", margin: 0 }}>{item.task.title}</Text>
          </Stack>
          {opening && (
            <Text size="sm" tone="subtle" style={{ overflowWrap: "anywhere" }}>
              <span style={{ color: "var(--dbx-tertiary)" }}>Opened from {sourceName(opening.source)}: </span>
              {opening.url ? <a className="dbx-link" href={opening.url} onClick={link(opening.url)} title={opening.url}>{opening.title}</a> : opening.title}
            </Text>
          )}
          {source && (
            <Text size="xs" tone="subtle" style={{ overflowWrap: "anywhere" }}>
              {sourceLine}
              {source.title && <> · {source.url ? <a className="dbx-link" href={source.url} onClick={link(source.url)} title={source.url}>{source.title}</a> : source.title}</>}
              <span style={{ color: "var(--dbx-tertiary)" }}> · {ago(source.occurred_at * 1000)}</span>
            </Text>
          )}
        </Stack>
        {item.task.question && !closed && <ProvideInput hub={props.hub} task={item} onDone={props.onChange} startOpen />}
        {(quote || sourceFacts.length > 0) && (
          <Stack gap={8}>
            {quote && <div style={{ borderLeft: "2px solid var(--dbx-border-strong)", paddingLeft: 10 }}><Text size="sm" tone="subtle" style={{ overflowWrap: "anywhere", whiteSpace: "pre-wrap" }}>{quote}</Text></div>}
            {sourceFacts.length > 0 && (
              <div style={{ display: "flex", flexWrap: "wrap", columnGap: 14, rowGap: 2 }}>
                {sourceFacts.map((fact) => <Text key={fact.label} size="xs" tone="subtle"><span style={{ color: "var(--dbx-tertiary)" }}>{fact.label}</span> {fact.value}</Text>)}
              </div>
            )}
          </Stack>
        )}
        <div style={{ display: "flex", flexDirection: wide ? "row" : "column", gap: wide ? 28 : 16, alignItems: wide ? "flex-start" : "stretch", minWidth: 0 }}>
          {!wide && <div className="dbx-card" style={{ padding: 12, borderRadius: 8 }}>{sidebar}</div>}
          <div style={{ flex: "1 1 0", minWidth: 0 }}>
            <Stack gap={12}>
              <Stack direction="row" gap={8} align="center" justify="space-between">
                <Text size="sm" weight={600}>Activity{commentCount ? <span style={{ color: "var(--dbx-tertiary)", fontWeight: 400 }}> · {commentCount} {commentCount === 1 ? "comment" : "comments"}</span> : null}</Text>
                {openThread && <Button size="sm" variant="ghost" title="Open its thread in Buzz to steer the agents there" onClick={openThread}>Open thread ↗</Button>}
              </Stack>
              {!item.thread ? <Text size="xs" tone="subtle">Not posted in Buzz yet.</Text>
                : !thread.available ? <Text size="xs" tone="subtle">The thread can't be read here. <a className="dbx-link" href="#" onClick={(event) => (event.preventDefault(), props.steer(item))}>Open it in Buzz</a>.</Text>
                : thread.status === "error" ? <Text size="xs" tone="danger">{thread.error ?? "Couldn't read the thread."} <a className="dbx-link" href="#" onClick={(event) => (event.preventDefault(), props.steer(item))}>Open it in Buzz</a>.</Text>
                : thread.status !== "ready" && !count ? <Spinner label="Loading the activity" />
                : (
                  <div>
                    {thread.more && <Step mark={<LineMark icon="⋯" />}><Button size="sm" variant="ghost" onClick={thread.more}>Earlier activity</Button></Step>}
                    {thread.limited && <Step mark={<LineMark icon="⋯" />}><Text size="xs" tone="subtle">Only part of the thread can be read here. <a className="dbx-link" href="#" onClick={(event) => (event.preventDefault(), props.steer(item))}>Open it in Buzz</a> for the rest.</Text></Step>}
                    {entries.map((entry) =>
                      entry.kind === "comment" ? <CommentStep key={entry.comment.id} ctx={props.ctx} comment={entry.comment} profile={who} expanded={expanded.has(entry.comment.id)} />
                      : entry.kind === "lines" ? <LinesStep key={entry.lines[0]!.comment.id} ctx={props.ctx} lines={entry.lines} profile={who} />
                      : <LineStep key={entry.comment.id} ctx={props.ctx} line={entry} profile={who} />,
                    )}
                    {thread.reading && <Step mark={<LineMark icon={<Spinner size={10} />} />}><Text size="xs" tone="tertiary">Reading the thread…</Text></Step>}
                    {item.thread && (
                      <Step mark={viewer ? <PersonMark id={viewer} profile={who} /> : <LineMark icon="✎" />} last>
                        <ReplyBox assignee={assignee} profile={props.profile} {...(thread.reply && { send: thread.reply })} steer={() => props.steer(item)} />
                      </Step>
                    )}
                    <div ref={end} />
                  </div>
                )}
            </Stack>
          </div>
          {wide && <aside style={{ flex: "0 0 240px", minWidth: 0 }}>{sidebar}</aside>}
        </div>
      </Stack>
    </div>
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
                  {event.url ? <a className="dbx-link" href={event.url} onClick={(click) => (click.preventDefault(), openExternal(event.url!))}>{event.title || event.external_id}</a> : event.title || event.external_id}
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
  const arrow = (direction: 1 | -1): React.CSSProperties => ({ position: "absolute", top: 0, [direction < 0 ? "left" : "right"]: 0, boxShadow: "0 1px 4px rgba(0,0,0,0.15)", pointerEvents: "auto" });
  return (
    <div style={{ position: "relative", minWidth: 0, maxWidth: "100%" }}>
      {/* A zero-height bar that sticks to the top of the board as it scrolls down, so the arrows stay in view. */}
      <div style={{ position: "sticky", top: 0, height: 0, zIndex: 1, pointerEvents: "none" }}>
        {edges.left && <div style={arrow(-1)}><Button size="sm" title="Scroll left" aria-label="Scroll left" onClick={() => scroll(-1)}>‹</Button></div>}
        {edges.right && <div style={arrow(1)}><Button size="sm" title="Scroll right" aria-label="Scroll right" onClick={() => scroll(1)}>›</Button></div>}
      </div>
      <div ref={row} onScroll={measure} style={{ display: "flex", gap: 12, overflowX: "auto", alignItems: "flex-start", minWidth: 0, maxWidth: "100%", paddingBottom: 8 }}>
        {props.children}
      </div>
    </div>
  );
}

const COLUMN_WIDTH = 260;

type BoundaryProps = { children: React.ReactNode; reset: unknown; retry(): void };
let BoardBoundary: React.ComponentType<BoundaryProps> | undefined;
/**
 * Keeps a failure in the board from taking down the tab: it shows what went
 * wrong, with a button to try again, instead of the host's crash card. Made
 * on first use, since React is the host's and is bound when the plugin starts.
 */
function boundary(): React.ComponentType<BoundaryProps> {
  BoardBoundary ??= class extends React.Component<BoundaryProps, { error?: Error; reset?: unknown }> {
    override state: { error?: Error; reset?: unknown } = {};
    static getDerivedStateFromError(error: unknown) {
      return { error: error instanceof Error ? error : new Error(String(error)) };
    }
    static getDerivedStateFromProps(props: BoundaryProps, state: { error?: Error; reset?: unknown }) {
      return props.reset === state.reset ? null : { error: undefined, reset: props.reset };
    }
    override componentDidCatch(error: unknown, info: { componentStack?: string | null }) {
      console.error("Signals board failed", error, info.componentStack);
    }
    override render() {
      if (!this.state.error) return this.props.children;
      return (
        <Notice tone="danger" title="The board hit an error" action={<Button size="sm" onClick={() => (this.setState({ error: undefined }), this.props.retry())}>Try again</Button>}>
          <Text size="xs" mono as="div" style={{ overflowWrap: "anywhere" }}>{this.state.error.message || String(this.state.error)}</Text>
        </Notice>
      );
    }
  };
  return BoardBoundary;
}

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
  // The channel's members, for the owner pickers on the board (the task view reads its own).
  const members = useMembers(ctx, channel?.id);
  const profile = useProfiles(ctx, [...new Set([...agents, ...members])]);
  const viewer = useRelay(ctx).viewer;
  const assigning: Assigning = { members, boardAgents: agents, ...(viewer && { viewer }), profile };
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

  const Boundary = boundary();
  let body: React.ReactNode;
  if (connection.status !== "connected") body = <Notice title="Connect Databricks" action={<Button variant="brand" onClick={() => service.openSettings()}>Connect</Button>}>Tasks live in your team's signals hub, a Databricks App.</Notice>;
  else if (!channel) body = props.noChannel ?? <Notice>Open this from a channel's menu.</Notice>;
  else if (hubs.loading || (board.loading && !board.data)) body = <Spinner label="Loading tasks" />;
  else if (hubs.error || board.error) body = <Notice tone="danger">{describeError((hubs.error ?? board.error)!)}</Notice>;
  else if (!hub) body = <Notice title="No signals hub in this workspace">Deploy one first (see the Signals plugin's README).</Notice>;
  else if (!board.data?.tasks.length && !filtered.data?.length) body = <Text tone="subtle" size="sm">No tasks in this channel{board.data?.account ? "" : " (set it up as an account from the channel menu)"}.</Text>;
  else if (viewing !== undefined && board.data?.tasks.some((item) => item.task.id === viewing)) {
    const item = board.data.tasks.find((found) => found.task.id === viewing)!;
    body = <TaskView ctx={ctx} hub={hub} item={item} channel={channel.id} boardAgents={agents} profile={profile} steer={steer} onChange={refresh} back={() => setViewing(undefined)} />;
  } else if (board.data) {
    const shown = filterTasks(board.data.tasks, filters);
    const grouped = byStatus(shown);
    const groups = STATUS_GROUPS.filter((group) => !filters.status || group.status === filters.status);
    const task = (item: BoardTask, Item: typeof TaskRow) => <Item key={item.task.id} hub={hub} item={item} open={opened === item.task.id} toggle={() => setOpened(opened === item.task.id ? undefined : item.task.id)} profile={profile} steer={steer} onChange={refresh} view={(found) => setViewing(found.task.id)} assigning={assigning} />;
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
    // The host gives the tab or page a fixed height and doesn't scroll it, so the board scrolls itself (as the SQL and Genie pages do).
    <DbxRoot style={{ minWidth: 0, maxWidth: "100%", width: "100%", height: "100%", overflow: "auto", boxSizing: "border-box" }}>
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
          <Boundary reset={`${channel?.id}:${viewing}:${view}`} retry={refresh}>{body}</Boundary>
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

/**
 * One task in a panel beside the conversation, opened from its card in the
 * channel: the same view as the board's Open, with its thread as comments.
 * The target names the channel and task, so it opens again from Back.
 */
export function taskPanel(ctx: Context, live: LiveTasks) {
  return function TaskPanel({ target, context }: PanelProps) {
    const at = readTaskTarget(target);
    React.useSyncExternalStore(live.subscribe, live.snapshot);
    const connection = useConnection(live.service);
    const [hub, setHub] = React.useState<HubClient>();
    const [problem, setProblem] = React.useState<string>();
    const [attempt, retry] = React.useReducer((n: number) => n + 1, 0);
    React.useEffect(() => {
      if (connection.status !== "connected") return;
      let current = true;
      setProblem(undefined);
      live.client().then(
        (found) => current && (found ? setHub(found) : setProblem("There's no signals hub in this workspace.")),
        (error: Error) => current && setProblem(describeError(error)),
      );
      return () => void (current = false);
    }, [connection.status, attempt]);
    const entry = at && connection.status === "connected" ? live.board(at.channel) : undefined;
    const item = at ? entry?.board?.tasks.find((found) => found.task.id === at.id) : undefined;
    (ctx.panels as { useTabTitle?(label: string): void }).useTabTitle?.(at ? `Task ${at.id}` : "Task");
    const agents = item ? [...new Set(item.people.filter((person) => person.kind === "agent").map((person) => person.key))] : [];
    const profile = useProfiles(ctx, agents);
    const steer = (found: BoardTask) => void (found.thread && context?.canOpen(found.thread) && context.open(found.thread));
    let body: React.ReactNode;
    if (!at) body = <Notice tone="danger">This link doesn't name a task.</Notice>;
    else if (connection.status !== "connected") body = <Notice title="Connect Databricks" action={<Button variant="brand" onClick={() => live.service.openSettings()}>Connect</Button>}>Tasks live in your team's signals hub, a Databricks App.</Notice>;
    else if (problem || (entry?.error && !entry.board)) body = <Notice tone="danger" title="Couldn't load the task" action={<Button size="sm" onClick={() => (retry(), void live.load(at.channel))}>Try again</Button>}>{problem ?? describeError(entry!.error!)}</Notice>;
    else if (!hub || !entry?.board) body = <Spinner label="Loading the task" />;
    else if (!item) body = <Notice title={`Task ${at.id} isn't on this channel's board`}>Done and dismissed tasks leave the board after two weeks.</Notice>;
    else body = <TaskView ctx={ctx} hub={hub} item={item} channel={at.channel} boardAgents={agents} profile={profile} steer={steer} onChange={() => void live.load(at.channel)} />;
    return (
      <DbxRoot style={{ minWidth: 0, maxWidth: "100%", width: "100%", height: "100%", overflow: "auto", boxSizing: "border-box" }}>
        <div style={{ padding: 16, minWidth: 0, boxSizing: "border-box" }}>{body}</div>
      </DbxRoot>
    );
  };
}
