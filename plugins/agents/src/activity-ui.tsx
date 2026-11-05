// The Activity tab of both Databricks agent types: recent turns, each with
// what was asked, every step it took and its thinking. Buzz opens this tab
// from "View <agent> activity" under a request; that conversation's turns
// come first.
import { React } from "@dbx/core/react";
import { Button, DbxRoot, Notice, Spinner, Stack, Text } from "@dbx/core/ui/components";
import type { ActivityItem, ActivityTurn } from "./activity";

const LONG_THOUGHT = 280;

/** What Buzz hands an Activity tab (AgentViewProps, which the author types don't export by name). */
export type ActivityTabProps = Readonly<{
  agent: Readonly<{ pubkey: string }>;
  conversation?: Readonly<{ channelId: string; rootId?: string }>;
  openConversation?: (channelId: string, threadRootId?: string) => void;
  initialTranscript?: Readonly<{ opening: number; done(): void }>;
}>;

function when(at: number): string {
  const date = new Date(at);
  const today = new Date().toDateString() === date.toDateString();
  return today ? date.toLocaleTimeString([], { hour: "numeric", minute: "2-digit", second: "2-digit" }) : date.toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}

const seconds = (ms: number) => (ms < 60_000 ? `${Math.max(1, Math.round(ms / 1000))} s` : `${Math.floor(ms / 60_000)} min ${Math.round((ms % 60_000) / 1000)} s`);

function status(turn: ActivityTurn): string {
  if (!turn.endedAt) return `Working · ${seconds(Date.now() - turn.startedAt)}`;
  const took = seconds(turn.endedAt - turn.startedAt);
  if (turn.outcome === "stopped") return `Stopped after ${took}`;
  if (turn.outcome === "error") return `Couldn't finish (${took})`;
  return `Done in ${took}`;
}

function Thought(props: { item: ActivityItem }) {
  const [open, setOpen] = React.useState(false);
  const long = props.item.text.length > LONG_THOUGHT;
  const text = long && !open ? `${props.item.text.slice(0, LONG_THOUGHT).trimEnd()}…` : props.item.text;
  return (
    <div style={{ borderLeft: "2px solid var(--dbx-border)", paddingLeft: 10, margin: "2px 0" }}>
      <Text size="xs" tone="tertiary">
        Thinking
      </Text>
      <div style={{ whiteSpace: "pre-wrap", fontStyle: "italic", fontSize: "0.8rem", color: "var(--dbx-subtle)", lineHeight: 1.45 }}>{text}</div>
      {long && (
        <button type="button" className="dbx-link" style={{ fontSize: "0.75rem", background: "none", border: 0, padding: 0, cursor: "pointer" }} onClick={() => setOpen(!open)}>
          {open ? "Show less" : "Show all"}
        </button>
      )}
    </div>
  );
}

function Item(props: { item: ActivityItem }) {
  if (props.item.kind === "thought") return <Thought item={props.item} />;
  return (
    <Stack direction="row" gap={8} align="flex-start">
      <span style={{ color: "var(--dbx-subtle)", fontSize: "0.7rem", minWidth: 62, paddingTop: 2 }}>{new Date(props.item.at).toLocaleTimeString([], { hour: "numeric", minute: "2-digit", second: "2-digit" })}</span>
      <Text size="sm" tone={props.item.kind === "note" ? "subtle" : "standard"}>
        {props.item.text}
      </Text>
    </Stack>
  );
}

function Turn(props: { turn: ActivityTurn; openConversation?: ActivityTabProps["openConversation"] }) {
  const { turn } = props;
  const working = !turn.endedAt;
  return (
    <div style={{ border: "1px solid var(--dbx-border)", borderRadius: 10, padding: "10px 12px" }}>
      <Stack gap={8}>
        <Stack direction="row" gap={8} align="center" justify="space-between">
          <Stack direction="row" gap={6} align="center">
            {working && <Spinner size={11} />}
            <Text size="sm" weight={500}>
              {status(turn)}
            </Text>
            <Text size="xs" tone="tertiary">
              {when(turn.startedAt)}
            </Text>
          </Stack>
          {props.openConversation && turn.channelId && (
            <Button size="sm" variant="ghost" onClick={() => props.openConversation!(turn.channelId!, turn.root)}>
              Open conversation
            </Button>
          )}
        </Stack>
        {turn.request && (
          <Text size="sm" tone="subtle">
            “{turn.request}”
          </Text>
        )}
        {turn.items.length ? (
          <Stack gap={5}>
            {turn.items.map((item, index) => (
              <Item key={`${item.at}-${index}`} item={item} />
            ))}
          </Stack>
        ) : (
          <Text size="xs" tone="tertiary">
            {working ? "Starting…" : "No steps were recorded."}
          </Text>
        )}
        {turn.error && <Notice tone="danger">{turn.error}</Notice>}
      </Stack>
    </div>
  );
}

export function ActivityView(
  props: Readonly<{
    turns: readonly ActivityTurn[];
    loading?: boolean;
    error?: string;
    note?: React.ReactNode;
    conversation?: ActivityTabProps["conversation"];
    openConversation?: ActivityTabProps["openConversation"];
    initialTranscript?: ActivityTabProps["initialTranscript"];
  }>,
) {
  const { conversation } = props;
  // Ticks while a turn works, so its time counts up.
  const [, tick] = React.useState(0);
  const working = props.turns.some((turn) => !turn.endedAt);
  React.useEffect(() => {
    if (!working) return;
    const timer = setInterval(() => tick((n) => n + 1), 1000);
    return () => clearInterval(timer);
  }, [working]);
  React.useEffect(() => props.initialTranscript?.done(), [props.initialTranscript]);
  const here = (turn: ActivityTurn) => !!conversation && turn.channelId === conversation.channelId && (conversation.rootId ? turn.root === conversation.rootId : true);
  const ordered = conversation ? [...props.turns.filter(here), ...props.turns.filter((turn) => !here(turn))] : props.turns;
  return (
    <DbxRoot style={{ padding: "4px 0 24px" }}>
      <Stack gap={12}>
        {props.note}
        {props.error && <Notice tone="warning">{props.error}</Notice>}
        {props.loading && !props.turns.length ? (
          <Stack direction="row" gap={8} align="center">
            <Spinner size={12} />
            <Text size="sm" tone="subtle">
              Loading activity…
            </Text>
          </Stack>
        ) : !ordered.length ? (
          <Text size="sm" tone="subtle">
            Nothing yet. When you mention this agent, each turn's steps and thinking appear here.
          </Text>
        ) : (
          ordered.map((turn) => <Turn key={turn.id} turn={turn} {...(props.openConversation && { openConversation: props.openConversation })} />)
        )}
      </Stack>
    </DbxRoot>
  );
}
