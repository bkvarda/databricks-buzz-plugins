// Cards for the hub's posts in a channel. A new task shows as a compact card:
// where it's at, who has it, what it came from and the one thing to do next.
// A done task drops the source's quote and details; a dismissed one folds to
// one quiet line that opens the card again (see postWeight).
// What the hub wrote for agents (their brief, the full source) is folded
// under "Full post". In a task's thread, the hub's updates are one quiet line
// each, and a question is a card you answer with one click. Agents still read
// the whole message: this only changes how it looks.
import type { Context } from "@buzz/author";
import { React } from "@dbx/core/react";
import { describeError } from "@dbx/core/service";
import { ago, Button, DbxRoot, Spinner, Stack, Text, openExternal } from "@dbx/core/ui/components";
import { Markdown } from "@dbx/core/ui/markdown";
import { assigneeOf, postOrigin, postWeight, STATUS_GROUPS, taskOrigin, titleHint, withMentionNames, workstreamHint } from "./board-view";
import { AssigneeMark, assigneeName, npubKey, type Profile, StatusIcon, useProfiles } from "./board-panel";
import type { BoardTask } from "./client";
import type { LiveTasks } from "./live-tasks";
import { mentionedNpubs, parseTaskPost, parseThreadPost, plainLine, shortWhen, sourceName, type TaskPost, taskTarget, type ThreadPost, type Triggered, type UntriggeredNote, untriggeredNote } from "./posts";

/** What a message renderer gets from the host (ChannelMessage, the parts used here). */
export type PostMessage = Readonly<{ id: string; channelId: string; authorId: string; content: string; createdAt: number; threadRootId?: string }>;
type Opener = Readonly<{ canOpen(target: string): boolean; open(target: string): boolean }>;

const MODE_TITLE: Record<string, string> = { auto: "Auto: agents do it and report", draft: "Draft: agents prepare it, a person sends it", ask: "Ask: agents ask before doing anything", off: "Off: agents leave it alone" };
const clamp = (lines: number): React.CSSProperties => ({ display: "-webkit-box", WebkitLineClamp: lines, WebkitBoxOrient: "vertical", overflow: "hidden" });
const statusTitle = (status: string) => STATUS_GROUPS.find((group) => group.status === status)?.title ?? status;
const closed = (item?: BoardTask) => item?.task.status === "done" || item?.task.status === "dismissed";

/** A small outlined label, like the board's. */
function Chip(props: { children: React.ReactNode; title?: string; tone?: "warning" | "success" }) {
  const color = props.tone === "warning" ? "var(--dbx-warning)" : props.tone === "success" ? "var(--dbx-success)" : "var(--dbx-subtle)";
  return <span title={props.title} style={{ display: "inline-flex", alignItems: "center", padding: "0 6px", borderRadius: 4, border: "1px solid var(--dbx-border)", fontSize: "0.6875rem", lineHeight: "18px", color, whiteSpace: "nowrap", maxWidth: 180, overflow: "hidden", textOverflow: "ellipsis" }}>{props.children}</span>;
}

/** The task as the hub has it now, kept current while the card shows. */
function useLiveTask(live: LiveTasks, channel: string, by: { id?: number; root?: string }): BoardTask | undefined {
  React.useSyncExternalStore(live.subscribe, live.snapshot);
  const connection = React.useSyncExternalStore(live.service.subscribe, live.service.snapshot);
  if (connection.status !== "connected") return undefined;
  return by.id !== undefined ? live.task(channel, by.id) : by.root ? live.byRoot(channel, by.root) : undefined;
}

/** The original post, for "Full post": Buzz's own Markdown when it has it, so mentions show as names. */
function FullPost(props: { ctx: Context; content: string; profile(key: string): Profile | undefined }) {
  const HostMarkdown = (props.ctx as unknown as { conversation?: { ui?: { Markdown?: React.ComponentType<{ content: string; scale?: "message" | "document" }> } } }).conversation?.ui?.Markdown;
  const named = withMentionNames(props.content, npubKey, (key) => props.profile(key)?.name);
  return (
    <div style={{ borderTop: "1px solid var(--dbx-border)", paddingTop: 8, overflowWrap: "anywhere" }}>
      {/* Mentions read as @Name in either renderer; the host's Markdown leaves nostr:npub… as it is. */}
      {HostMarkdown ? <HostMarkdown content={named} /> : <Markdown source={named} size="sm" />}
    </div>
  );
}

/**
 * What a task asks, with its options as buttons and a box for any other
 * answer. Once it's answered (by anyone, anywhere), it says so instead.
 */
function Answer(props: { live: LiveTasks; channel: string; id?: number; question: string; options: readonly string[]; item?: BoardTask }) {
  const { live, item } = props;
  const [busy, setBusy] = React.useState<string>();
  const [error, setError] = React.useState<string>();
  const [other, setOther] = React.useState(false);
  const [text, setText] = React.useState("");
  const connected = live.connected();
  // In a thread, the task is known once its channel's board is read.
  const ready = connected && props.id !== undefined;
  // Known from the hub: it waits on this question, on another one, or on nothing.
  const waiting = item ? Boolean(item.task.question) && !closed(item) && item.task.question === props.question : undefined;
  const send = async (answer: string) => {
    if (!answer.trim() || busy || props.id === undefined) return;
    setBusy(answer);
    setError(undefined);
    try {
      await live.answer(props.channel, props.id!, answer.trim());
      setText("");
      setOther(false);
    } catch (problem) {
      const message = describeError(problem);
      setError(/isn't waiting on input/.test(message) ? "Someone already answered this." : message);
      if (/isn't waiting on input/.test(message)) void live.load(props.channel);
    } finally {
      setBusy(undefined);
    }
  };
  if (waiting === false)
    return (
      <Stack direction="row" gap={6} align="baseline" wrap>
        <Text size="xs" tone="success" weight={600}>✓ Answered</Text>
        <Text size="xs" tone="tertiary" style={{ minWidth: 0, ...clamp(1) }}>{props.question}</Text>
      </Stack>
    );
  return (
    <div style={{ borderLeft: "3px solid var(--dbx-warning)", paddingLeft: 10 }}>
      <Stack gap={6}>
        <Text size="xs" weight={600} tone="warning">Needs your input</Text>
        <Text size="sm" style={{ overflowWrap: "anywhere" }}>{props.question}</Text>
        <Stack direction="row" gap={6} wrap align="center">
          {props.options.map((option) => (
            <Button key={option} size="sm" disabled={!ready || Boolean(busy)} onClick={() => void send(option)} title={`Answer “${option}”`}>
              {busy === option ? <Spinner size={10} /> : null}{option}
            </Button>
          ))}
          {!other && <Button size="sm" variant="ghost" disabled={!ready || Boolean(busy)} onClick={() => setOther(true)}>{props.options.length ? "Other answer…" : "Answer…"}</Button>}
        </Stack>
        {other && (
          <form onSubmit={(event) => (event.preventDefault(), void send(text))} style={{ display: "flex", gap: 6, flexWrap: "wrap", minWidth: 0 }}>
            <input
              className="dbx-input"
              aria-label="Your answer"
              placeholder="Your answer"
              autoFocus
              value={text}
              onChange={(event) => setText(event.target.value)}
              onKeyDown={(event) => event.key === "Escape" && (event.preventDefault(), setOther(false))}
              style={{ flex: "1 1 200px", minWidth: 0 }}
            />
            <Button size="sm" variant="brand" type="submit" disabled={!text.trim() || Boolean(busy)}>{busy && busy === text.trim() ? <Spinner size={10} /> : null}Send answer</Button>
          </form>
        )}
        {connected && props.id === undefined && (live.loading(props.channel) ? <Spinner size={10} label="Loading the task" /> : <Text size="xs" tone="subtle">This task isn't on the signals hub you're connected to. Answer from its Tasks board.</Text>)}
        {!connected && (
          <Text size="xs" tone="subtle">
            Connect Databricks to answer here.{" "}
            <a href="#" className="dbx-link" onClick={(event) => (event.preventDefault(), live.service.openSettings())}>Connect</a>
          </Text>
        )}
        {error && <Text size="xs" tone="danger">{error}</Text>}
      </Stack>
    </div>
  );
}

/** The line under a task's title: where it came from, who, where and when. */
function SourceLine(props: { source: TaskPost["source"]; ticket?: string }) {
  const { source } = props;
  if (!source) return null;
  const parts = [props.ticket ? `${sourceName(source.kind)} ${props.ticket}` : sourceName(source.kind), source.from, source.where && !/^https?:/.test(source.where) ? source.where : undefined, source.when && shortWhen(source.when)].filter(Boolean) as string[];
  return (
    <Text size="xs" tone="tertiary" style={{ minWidth: 0, ...clamp(1) }}>
      <span title={parts.join(" · ")}>{parts.join(" · ")}</span>
    </Text>
  );
}

/**
 * A dismissed task, as one quiet line: what it was, and a way back to its
 * card. Muted like the board's Dismissed group, so the channel's open work
 * stands out.
 */
function FoldedTask(props: { id: number; title: string; onShow(): void; focus?: boolean; untriggered?: boolean }) {
  const button = React.useRef<HTMLButtonElement>(null);
  // Back from Fold: the keyboard stays where it was.
  React.useEffect(() => void (props.focus && button.current?.focus()), []);
  return (
    <DbxRoot style={{ minWidth: 0, maxWidth: 620 }}>
      <button
        ref={button}
        type="button"
        onClick={props.onShow}
        aria-expanded={false}
        title={`Task ${props.id} was dismissed${props.untriggered ? " because none of its workstream's default actions triggered" : ""}: ${props.title}. Show its card.`}
        style={{ display: "flex", alignItems: "center", gap: 6, width: "100%", minWidth: 0, margin: 0, padding: "2px 0", border: 0, borderRadius: 4, background: "transparent", cursor: "pointer", color: "var(--dbx-tertiary)", fontFamily: "inherit", fontSize: "0.75rem", lineHeight: "18px", textAlign: "left" }}
      >
        <StatusIcon status="dismissed" size={11} />
        <span style={{ flex: "none" }}>{props.untriggered ? "Not triggered" : "Dismissed"}</span>
        <span aria-hidden style={{ flex: "none" }}>·</span>
        <span style={{ flex: "0 1 auto", minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{props.title}</span>
        <span style={{ flex: "none", marginLeft: "auto", paddingLeft: 8, textDecoration: "underline dotted" }}>Show</span>
      </button>
    </DbxRoot>
  );
}

/** What a workstream's default actions found: each that triggered, with why; or, quietly, that none did (now, or when it opened). */
function TriggeredLines(props: { triggered: readonly Triggered[]; note?: UntriggeredNote | undefined; dismissing?: boolean | undefined }) {
  if (!props.triggered.length)
    return props.note ? (
      <Text size="xs" tone="tertiary" style={{ overflowWrap: "anywhere" }}>
        {props.note === "dismissed"
          ? "Nothing triggered, so it was dismissed. It opens again if something does."
          : props.dismissing
              ? "When it opened, nothing triggered, so it was dismissed then."
              : "When it opened, nothing triggered, so no agent was asked then."}
      </Text>
    ) : null;
  return (
    <Stack gap={2}>
      {props.triggered.map((item) => (
        <Text key={item.label} size="xs" tone="subtle" style={{ overflowWrap: "anywhere", ...clamp(2) }}>
          <span title={item.why ? `${item.label} — ${item.why}` : item.label}>
            <span style={{ color: "var(--dbx-tertiary)" }}>Triggered · </span>
            <span style={{ fontWeight: 600 }}>{item.label}</span>
            {item.why ? ` — ${item.why}` : ""}
          </span>
        </Text>
      ))}
    </Stack>
  );
}

/** A new task, as a card. */
export function TaskPostCard(props: Opener & { ctx: Context; live: LiveTasks; message: PostMessage; openBoard(channel: string): void }) {
  const { message, live } = props;
  const post = React.useMemo(() => parseTaskPost(message.content), [message.content]);
  const item = useLiveTask(live, message.channelId, { ...(post && { id: post.id }) });
  const [full, setFull] = React.useState(false);
  // A dismissed task's card, opened from its folded line.
  const [unfolded, setUnfolded] = React.useState(false);
  // Where the keyboard goes after Show (Fold) or Fold (back to Show); not on the first render.
  const moved = React.useRef<"show" | "fold" | undefined>(undefined);
  const card = React.useRef<HTMLDivElement>(null);
  React.useEffect(() => {
    // One move per Show or Fold: a later fold (a refresh that dismisses it again) leaves focus where it is.
    // The folded line's own effect, which runs first, has already used "show".
    const want = moved.current;
    moved.current = undefined;
    if (unfolded && want === "fold") card.current?.querySelector<HTMLButtonElement>('button[aria-label="Fold"]')?.focus();
  }, [unfolded]);
  const latest = item?.activity?.text ?? "";
  const mentioned = React.useMemo(() => mentionedNpubs(`${message.content}\n${latest}`).map(npubKey).filter((key): key is string => Boolean(key)), [message.content, latest]);
  const assignee = item && assigneeOf(item);
  const profile = useProfiles(props.ctx, [...mentioned, ...(assignee && (assignee.kind === "agent" || assignee.kind === "person") ? [assignee.key] : [])]);
  if (!post) return null;
  const target = taskTarget(message.channelId, post.id);

  const options = item ? (item.task.options ?? []) : post.options;
  // A task that closed before the board's window isn't on it: it's looked up on its own.
  const older = item ? undefined : live.olderTask(message.channelId, post.id);
  const status = item?.task.status ?? older?.status;
  const weight = postWeight(status);
  // A closed task asks nothing, even when its post did (and the board no longer has it).
  const question = item ? (item.task.question && !closed(item) ? item.task.question : undefined) : weight === "full" ? post.question : undefined;
  // Opened from its folded line, a dismissed task shows its whole card.
  const details = weight === "full" || (weight === "folded" && unfolded);
  const source = post.source;
  // The source the task opened from, whose own title and key a short title or the rule's template may hide.
  const origin = postOrigin(source, item?.origin);
  const ticket = taskOrigin(post.title, origin).ref;
  const open = () => (props.canOpen(target) && props.open(target)) || props.openBoard(message.channelId);
  // Whether its workstream's defaults dismissed it (nothing triggered), not a person, as the hub has it now;
  // and what the post's "nothing triggered" note still means: so now, or only when it opened.
  const now = item ? { status: item.task.status, byDefaults: item.task.status === "dismissed" && Boolean(item.task.triggers?.dismissed) } : older;
  const note = untriggeredNote(post, now);
  const untriggered = Boolean(now?.byDefaults);
  if (weight === "folded" && !unfolded) return <FoldedTask id={post.id} title={post.title} untriggered={untriggered} focus={moved.current === "show"} onShow={() => ((moved.current = "fold"), setUnfolded(true))} />;
  return (
    <DbxRoot style={{ minWidth: 0, maxWidth: 620 }}>
      <div ref={card} className="dbx-card" style={{ padding: "10px 12px", borderRadius: 8, minWidth: 0 }}>
        <Stack gap={8}>
          <Stack direction="row" gap={8} align="center" justify="space-between">
            <Stack direction="row" gap={6} align="center" wrap style={{ minWidth: 0 }}>
              {status ? <StatusIcon status={status} /> : <span aria-hidden style={{ width: 13, height: 13, borderRadius: 999, border: "1.5px solid var(--dbx-border-strong)", flex: "none" }} />}
              <Text size="xs" tone="tertiary" mono>Task {post.id}</Text>
              {status && <Text size="xs" tone={status === "waiting" ? "warning" : status === "done" ? "success" : "subtle"} weight={500}>{statusTitle(status)}</Text>}
              {post.workstream && <Chip title={item && item.task.workstream === post.workstream ? workstreamHint(item.task) : post.workstream}>{post.workstream}</Chip>}
              {post.initiative && <Chip>{post.initiative}</Chip>}
              {post.mode && post.mode !== "draft" && <Chip title={MODE_TITLE[post.mode]} {...(post.mode === "auto" && { tone: "success" as const })}>{post.mode}</Chip>}
            </Stack>
            {assignee && (
              <Stack direction="row" gap={6} align="center" style={{ flex: "none", maxWidth: "40%" }}>
                <Text size="xs" tone="subtle" style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{assignee.kind === "you" ? "Waiting on you" : assigneeName(assignee, profile)}</Text>
                <AssigneeMark assignee={assignee} profile={profile} size={18} />
              </Stack>
            )}
          </Stack>
          <Stack gap={2}>
            <Text size="md" weight={600} style={{ overflowWrap: "anywhere", ...clamp(2) }}>
              <span title={titleHint(post.title, origin)}>{post.title}</span>
            </Text>
            <SourceLine source={source} {...(ticket && { ticket })} />
          </Stack>
          {source?.quote && details && (
            <div style={{ borderLeft: "2px solid var(--dbx-border-strong)", paddingLeft: 8 }}>
              <Text size="sm" tone="subtle" style={{ overflowWrap: "anywhere", ...clamp(3) }}>{source.quote}</Text>
            </div>
          )}
          {source && source.facts.length > 0 && details && (
            <div style={{ display: "flex", flexWrap: "wrap", columnGap: 14, rowGap: 2 }}>
              {source.facts.map((fact) => (
                <Text key={fact.label} size="xs" tone="subtle" style={{ whiteSpace: "nowrap", maxWidth: "100%", overflow: "hidden", textOverflow: "ellipsis" }}>
                  <span style={{ color: "var(--dbx-tertiary)" }}>{fact.label}</span> {fact.value}
                </Text>
              ))}
            </div>
          )}
          {details && <TriggeredLines triggered={post.triggered} note={note} dismissing={post.untriggered === "dismissed"} />}
          {question && <Answer live={live} channel={message.channelId} id={post.id} question={question} options={options} {...(item && { item })} />}
          {item?.activity && !question && (
            <Text size="xs" tone="subtle" style={{ overflowWrap: "anywhere", ...clamp(2) }}>
              <span style={{ color: "var(--dbx-tertiary)" }}>{item.activity.kind === "agent_reply" ? "Agent" : "Latest"} · {ago(item.activity.at * 1000)} · </span>
              {(() => {
                const line = plainLine(item.activity.text, (npub) => profile(npubKey(npub) ?? "")?.name);
                return <span title={line}>{line}</span>;
              })()}
            </Text>
          )}
          <Stack direction="row" gap={6} align="center" wrap>
            {/* A closed task has nothing to do, so opening it isn't the card's one action. */}
            <Button size="sm" variant={weight === "full" ? "primary" : "default"} onClick={open} title="Its details, what's been made for it and its thread">Open task</Button>
            {source?.url && <Button size="sm" variant="ghost" onClick={() => openExternal(source.url!)} title={source.url}>View source ↗</Button>}
            <span style={{ flex: "1 1 auto" }} />
            {weight === "folded" && <Button size="sm" variant="ghost" aria-label="Fold" onClick={() => ((moved.current = "show"), setUnfolded(false), setFull(false))} title="Back to one line: it was dismissed, so there's nothing to do">Fold</Button>}
            <Button size="sm" variant="ghost" onClick={() => setFull(!full)} title="The whole message, as agents read it">{full ? "Hide full post" : "Full post"}</Button>
          </Stack>
          {full && <FullPost ctx={props.ctx} content={message.content} profile={profile} />}
        </Stack>
      </div>
    </DbxRoot>
  );
}

const LINE_ICON: Record<Exclude<ThreadPost["kind"], "question">, string> = { update: "↻", done: "✓", nudge: "⏱", answered: "↳", status: "●", assigned: "👤", asked: "→" };

/** The hub's reply in a task's thread: a question as a card, anything else as one line. */
export function ThreadPostCard(props: { ctx: Context; live: LiveTasks; message: PostMessage }) {
  const { message, live } = props;
  const post = React.useMemo(() => parseThreadPost(message.content), [message.content]);
  const item = useLiveTask(live, message.channelId, { ...(message.threadRootId && { root: message.threadRootId }) });
  const id = item?.task.id;
  const [full, setFull] = React.useState(false);
  const mentioned = React.useMemo(() => mentionedNpubs(message.content).map(npubKey).filter((key): key is string => Boolean(key)), [message.content]);
  const profile = useProfiles(props.ctx, mentioned);
  if (!post) return null;
  const named = (text: string) => withMentionNames(text, npubKey, (key) => profile(key)?.name).replace(/\*\*/g, "");
  if (post.kind === "question") {
    const by = named(post.by);
    return (
      <DbxRoot style={{ minWidth: 0, maxWidth: 620 }}>
        <Stack gap={4}>
          <Answer live={live} channel={message.channelId} {...(id !== undefined && { id })} question={post.question} options={post.options} {...(item && { item })} />
          <Text size="xs" tone="tertiary">Asked by {by}</Text>
        </Stack>
      </DbxRoot>
    );
  }
  let body: React.ReactNode;
  let forAgents = false;
  // More in the message than its line shows, for people (a meeting's checklist): offered as Details.
  let more = false;
  switch (post.kind) {
    case "update":
      forAgents = post.forAgents;
      more = Boolean(post.more);
      body = (
        <>
          {post.reopened && <span>Open again:</span>}
          {post.url ? <a href={post.url} className="dbx-link" title={post.url} onClick={(event) => (event.preventDefault(), openExternal(post.url!))}>{post.title}</a> : <span>{post.title}</span>}
          {post.changes.map((change) => (
            <Chip key={change.field} title={`${change.field}: ${change.from} → ${change.to}`}>{change.field} {change.from === "(none)" ? "" : `${change.from} `}→ <b style={{ marginLeft: 3 }}>{change.to}</b></Chip>
          ))}
        </>
      );
      break;
    case "done":
      body = <span>Done: {post.reason}</span>;
      break;
    case "nudge":
      body = <span>{post.text}</span>;
      break;
    case "answered":
      forAgents = post.forAgents;
      body = <span>{named(post.who)} answered <b>{named(post.answer)}</b>{post.question ? <span style={{ color: "var(--dbx-tertiary)" }}> to “{post.question.length > 80 ? `${post.question.slice(0, 79)}…` : post.question}”</span> : null}</span>;
      break;
    case "status":
    case "assigned":
      forAgents = post.kind === "assigned" && post.forAgents;
      body = <span>{named(post.text)}</span>;
      break;
    case "asked":
      forAgents = true;
      body = <span>{post.text}{mentioned.length ? `: ${mentioned.map((key) => profile(key)?.name ?? "an agent").join(", ")}` : ""}</span>;
      break;
  }
  return (
    <DbxRoot style={{ minWidth: 0 }}>
      <Stack gap={6}>
        <div style={{ display: "flex", alignItems: "baseline", gap: 6, fontSize: "0.75rem", color: "var(--dbx-subtle)", minWidth: 0 }}>
          <span aria-hidden style={{ color: post.kind === "done" ? "var(--dbx-success)" : "var(--dbx-tertiary)", flex: "none" }}>{post.kind === "update" && post.reopened ? "↩" : LINE_ICON[post.kind]}</span>
          {/* The icon stays beside the text when a narrow column wraps it. */}
          <span style={{ display: "flex", flexWrap: "wrap", alignItems: "center", columnGap: 6, rowGap: 2, flex: "1 1 auto", minWidth: 0, overflowWrap: "anywhere" }}>
            {body}
            {(forAgents || more) && (
              <button type="button" onClick={() => setFull(!full)} aria-expanded={full} style={{ border: 0, background: "transparent", padding: 0, cursor: "pointer", color: "var(--dbx-tertiary)", fontSize: "0.75rem", textDecoration: "underline dotted" }}>
                {full ? "Hide" : more ? "Details" : "For agents"}
              </button>
            )}
          </span>
        </div>
        {post.kind === "update" && post.triggered.length > 0 && (
          <div style={{ paddingLeft: 18, minWidth: 0 }}>
            <TriggeredLines triggered={post.triggered} />
          </div>
        )}
        {full && <FullPost ctx={props.ctx} content={message.content} profile={profile} />}
      </Stack>
    </DbxRoot>
  );
}
