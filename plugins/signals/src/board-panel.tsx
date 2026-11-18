// "Tasks board" in a channel's menu: the channel's signals tasks by status,
// like a Linear board, each with who's on it (agents, your team, the party
// it sits with, like support, the customer, named as the hub's labels say), its source, what was made for it and
// its latest activity. From a card you can add an agent, open its thread to
// steer the agents there, answer what an agent asked (Provide input), and
// change its status or dismiss it.
import type { Context } from "@buzz/author";
import type { PanelProps } from "@dbx/core/host-types";
import { optionalService } from "@dbx/core/host-types";
import { React } from "@dbx/core/react";
import { type DatabricksService, describeError, useAsync, useConnection } from "@dbx/core/service";
import { ago, Badge, Button, Card, DbxRoot, Notice, SectionHeader, Spinner, Stack, Text, openExternal } from "@dbx/core/ui/components";
import { capitalized, type ResolvedLabels, TASK_STATUSES } from "../app/model";
import { type BoardPerson, type BoardTask, chosenHub, HubClient } from "./client";

/** The columns, in order; done and dismissed show the last two weeks. */
export const COLUMNS = [
  { status: "open", title: "Open" },
  { status: "in_progress", title: "In progress" },
  { status: "waiting", title: "Waiting" },
  { status: "done", title: "Done" },
  { status: "dismissed", title: "Dismissed" },
] as const;

/** The tasks of each column, in the board's order (latest activity first). */
export function columns(tasks: readonly BoardTask[]): Map<string, BoardTask[]> {
  const out = new Map<string, BoardTask[]>(COLUMNS.map((column) => [column.status, []]));
  for (const item of tasks) out.get(item.task.status)?.push(item);
  return out;
}

type Profile = { name?: string; picture?: string };
type ProfileQueries = { snapshot(): ReadonlyMap<string, Profile>; subscribe(listener: () => void): () => void; ensure(ids: readonly string[]): Promise<void> };
type RelayView = { snapshot(): { viewer?: string; origin?: string; session?: { profiles?: ProfileQueries; media?: (url: string, size?: "small") => string | undefined } } };

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

const initials = (label: string) => label.replace(/[^\p{L}\p{N} ]/gu, "").split(/\s+/).filter(Boolean).slice(0, 2).map((word) => word[0]!.toUpperCase()).join("") || "?";
const KIND_COLOR = { agent: "var(--dbx-brand-tint)", person: "var(--dbx-inset)", customer: "var(--dbx-warning-tint, var(--dbx-inset))", team: "var(--dbx-inset)" } as const;
const KIND_TEXT = { agent: "Agent", person: "Your team", customer: "Customer", team: "Team" } as const;
const kindText = (kind: BoardPerson["kind"], labels?: { customer: string }) => (kind === "customer" && labels ? capitalized(labels.customer) : KIND_TEXT[kind]);

function Avatar(props: { person: BoardPerson; profile?: Profile; labels?: ResolvedLabels }) {
  const label = props.profile?.name ?? props.person.label;
  const title = `${label}: ${kindText(props.person.kind, props.labels)}, ${props.person.role}`;
  const size = 22;
  const style: React.CSSProperties = { width: size, height: size, borderRadius: props.person.kind === "agent" ? 6 : 999, flex: "none", border: "1px solid var(--dbx-border)" };
  return props.profile?.picture ? (
    <img src={props.profile.picture} alt={label} title={title} style={{ ...style, objectFit: "cover" }} />
  ) : (
    <span title={title} aria-label={title} style={{ ...style, display: "inline-flex", alignItems: "center", justifyContent: "center", fontSize: 9, fontWeight: 600, background: KIND_COLOR[props.person.kind], color: "var(--dbx-subtle)" }}>
      {initials(label)}
    </span>
  );
}

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

function TaskCard(props: { hub: HubClient; item: BoardTask; labels?: ResolvedLabels; profile(key: string): Profile | undefined; steer(item: BoardTask): void; onChange(): void }) {
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
  return (
    <Card>
      <Stack gap={6}>
        <Stack direction="row" gap={6} align="flex-start" justify="space-between">
          <Text size="sm" weight={500}>#{item.task.id} {item.task.title}</Text>
          <Badge tone={item.task.mode === "auto" ? "success" : "neutral"}>{item.task.mode}</Badge>
        </Stack>
        <Stack direction="row" gap={6} wrap align="center">
          {item.task.workstream && <Badge>{item.task.workstream}</Badge>}
          {item.task.initiative && <Badge tone="brand">{item.task.initiative}</Badge>}
          {item.source && (item.source.url ? (
            <a href={item.source.url} onClick={(event) => (event.preventDefault(), openExternal(item.source!.url!))} style={{ fontSize: "0.75rem" }}>{item.source.source}</a>
          ) : <Text size="xs" tone="tertiary">{item.source.source}</Text>)}
          <Text size="xs" tone="tertiary">{ago(item.task.last_event_at * 1000)}</Text>
        </Stack>
        {item.people.length > 0 && (
          <Stack direction="row" gap={4} wrap align="center">
            {item.people.map((person) => <Avatar key={`${person.kind}:${person.key}`} person={person} {...(props.labels && { labels: props.labels })} {...(person.kind === "agent" && props.profile(person.key) && { profile: props.profile(person.key)! })} />)}
          </Stack>
        )}
        {item.task.question && !closed && <ProvideInput hub={props.hub} task={item} onDone={props.onChange} />}
        {item.activity && <Text size="xs" tone="subtle">{item.activity.kind === "agent_reply" ? "Agent: " : ""}{item.activity.text.length > 160 ? `${item.activity.text.slice(0, 159)}…` : item.activity.text}</Text>}
        {item.artifacts.length > 0 && (
          <Stack gap={2}>
            {item.artifacts.slice(0, 3).map((artifact) => (
              <Text key={`${artifact.at}:${artifact.url}`} size="xs">
                {artifact.url.startsWith("http") ? <a href={artifact.url} onClick={(event) => (event.preventDefault(), openExternal(artifact.url))}>{artifact.title ?? artifact.kind}</a> : (artifact.title ?? artifact.kind)}
              </Text>
            ))}
          </Stack>
        )}
        {error && <Text size="xs" tone="danger">{error}</Text>}
        <Stack direction="row" gap={6} wrap align="center">
          <Button size="sm" disabled={!item.thread} title="Open its thread to steer the agents there" onClick={() => props.steer(item)}>Steer</Button>
          {!closed && <AddAgent hub={props.hub} task={item} onDone={props.onChange} />}
          <select className="dbx-input" aria-label="Status" disabled={busy} value={item.task.status} onChange={(event) => void setStatus(event.target.value)} style={{ width: "auto", fontSize: "0.75rem" }}>
            {TASK_STATUSES.map((status) => <option key={status} value={status}>{status.replace("_", " ")}</option>)}
          </select>
          {!closed && <Button size="sm" variant="danger" disabled={busy} onClick={() => void setStatus("dismissed")}>Dismiss</Button>}
        </Stack>
      </Stack>
    </Card>
  );
}

/** The "Tasks board" channel panel. */
export function boardPanel(ctx: Context, service: DatabricksService) {
  return function BoardPanel({ channelContext, context }: PanelProps) {
    const connection = useConnection(service);
    const hubs = useAsync(async (signal) => (connection.status === "connected" ? chosenHub(service, signal) : undefined), [connection.status]);
    const app = hubs.data?.app;
    const hub = React.useMemo(() => (app ? new HubClient(service.client()!, app) : undefined), [app?.name, app?.url]);
    const [version, refresh] = React.useReducer((n: number) => n + 1, 0);
    const board = useAsync(async (signal) => (hub && channelContext ? hub.board(channelContext.channelId, signal) : undefined), [hub, channelContext?.channelId, version]);
    const agents = [...new Set((board.data?.tasks ?? []).flatMap((item) => item.people.filter((person) => person.kind === "agent").map((person) => person.key)))];
    const profile = useProfiles(ctx, agents);
    const steer = (item: BoardTask) => {
      if (!item.thread || !channelContext) return;
      if (context?.canOpen(item.thread) && context.open(item.thread)) return;
      const relay = optionalService<RelayView>(ctx, "relay")?.snapshot();
      const navigation = optionalService<{ open(target: unknown): Promise<unknown> }>(ctx, "navigation");
      if (!relay?.viewer || !relay.origin || !navigation) return;
      void navigation.open({ version: 1, kind: "conversation", scope: { viewer: relay.viewer, communityOrigin: relay.origin }, channelId: channelContext.channelId, messageId: item.task.buzz_root, threadRootId: item.task.buzz_root, context: "channel" });
    };

    let body: React.ReactNode;
    if (!channelContext) body = <Notice>Open this from a channel's menu.</Notice>;
    else if (connection.status !== "connected") body = <Notice title="Connect Databricks" action={<Button variant="brand" onClick={() => service.openSettings()}>Connect</Button>}>Tasks live in your team's signals hub, a Databricks App.</Notice>;
    else if (hubs.loading || (board.loading && !board.data)) body = <Spinner label="Loading tasks" />;
    else if (hubs.error || board.error) body = <Notice tone="danger">{describeError((hubs.error ?? board.error)!)}</Notice>;
    else if (!hub) body = <Notice title="No signals hub in this workspace">Deploy one first (see the Signals plugin's README).</Notice>;
    else if (!board.data?.tasks.length) body = <Text tone="subtle" size="sm">No tasks in this channel{board.data?.account ? "" : " (set it up as an account from the channel menu)"}.</Text>;
    else {
      const grouped = columns(board.data.tasks);
      body = (
        <div style={{ display: "flex", gap: 12, overflowX: "auto", alignItems: "flex-start" }}>
          {COLUMNS.map((column) => (
            <div key={column.status} style={{ flex: "0 0 280px" }}>
              <Stack gap={8}>
                <Stack direction="row" gap={6} align="center">
                  <Text size="sm" weight={600}>{column.title}</Text>
                  <Badge>{grouped.get(column.status)!.length}</Badge>
                </Stack>
                {grouped.get(column.status)!.map((item) => <TaskCard key={item.task.id} hub={hub} item={item} {...(board.data?.labels && { labels: board.data.labels })} profile={profile} steer={steer} onChange={refresh} />)}
              </Stack>
            </div>
          ))}
        </div>
      );
    }
    return (
      <DbxRoot>
        <div style={{ padding: 16 }}>
          <Stack gap={16}>
            <SectionHeader
              title={channelContext ? `Tasks in #${channelContext.channelName}` : "Tasks"}
              description={board.data?.account ? `${board.data.account}: who's on each task, what's been made for it, and its latest activity.` : "Who's on each task, what's been made for it, and its latest activity."}
              action={hub && <Button size="sm" disabled={board.loading} onClick={refresh}>{board.loading ? <Spinner size={10} /> : null}Refresh</Button>}
            />
            {body}
          </Stack>
        </div>
      </DbxRoot>
    );
  };
}
