// A conversation with one Genie agent: used by the Genie page, by panels
// opened from Genie links, and (compact) by the composer tool.
import { Genie, type GenieMessage, type GenieSpace, messageId, STATUS_LABEL, summarize, TERMINAL } from "@dbx/core/api/genie";
import { React } from "@dbx/core/react";
import type { ResultSet } from "@dbx/core/result";
import { toMarkdown } from "@dbx/core/result";
import { type DatabricksService, describeError } from "@dbx/core/service";
import { Badge, Button, CodeView, CopyButton, DatabricksMark, Disclosure, Notice, Spinner, Stack, Text } from "@dbx/core/ui/components";
import { ResultView } from "@dbx/core/ui/data";
import { Markdown } from "@dbx/core/ui/markdown";

export type Turn = {
  key: string;
  question: string;
  message?: GenieMessage;
  text?: string;
  sql?: string;
  queryTitle?: string;
  result?: ResultSet;
  suggestions: readonly string[];
  error?: string;
  loadingResult?: boolean;
};

const STEPS = ["FETCHING_METADATA", "FILTERING_CONTEXT", "ASKING_AI", "PENDING_WAREHOUSE", "EXECUTING_QUERY"] as const;

/** A Markdown version of an answer, for sharing into a conversation. */
export function turnMarkdown(space: Pick<GenieSpace, "title">, turn: Turn, link?: string): string {
  const parts = [`**${space.title}** · _${turn.question}_`];
  if (turn.text) parts.push(turn.text);
  if (turn.result?.columns.length) parts.push(toMarkdown(turn.result, 15));
  if (turn.sql) parts.push(`\`\`\`sql\n${turn.sql.trim()}\n\`\`\``);
  if (link) parts.push(`[Open in Genie](${link})`);
  return parts.join("\n\n");
}

function Progress(props: { status: string }) {
  const index = STEPS.indexOf(props.status as (typeof STEPS)[number]);
  return (
    <Stack direction="row" gap={10} align="center">
      <Spinner size={13} />
      <Text tone="subtle" size="sm">
        {STATUS_LABEL[props.status as keyof typeof STATUS_LABEL] ?? "Thinking"}…
      </Text>
      <Stack direction="row" gap={3} align="center" style={{ marginLeft: 4 }}>
        {STEPS.map((step, n) => (
          <span
            key={step}
            style={{
              width: 14,
              height: 3,
              borderRadius: 2,
              background: n <= index ? "var(--dbx-lava)" : "var(--dbx-border)",
              transition: "background-color 200ms ease",
            }}
          />
        ))}
      </Stack>
    </Stack>
  );
}

export function TurnView(props: {
  turn: Turn;
  compact?: boolean;
  onSuggestion?(question: string): void;
  onLoadResult?(): void;
  actions?: React.ReactNode;
}) {
  const { turn } = props;
  const status = turn.message?.status ?? "SUBMITTED";
  const done = TERMINAL.has(status) || Boolean(turn.error);
  return (
    <Stack gap={10}>
      <Stack direction="row" gap={8} align="flex-start">
        <span
          aria-hidden
          style={{
            flex: "none",
            width: 22,
            height: 22,
            borderRadius: 6,
            background: "var(--dbx-inset)",
            border: "1px solid var(--dbx-border)",
            display: "inline-flex",
            alignItems: "center",
            justifyContent: "center",
            fontSize: 11,
            color: "var(--dbx-subtle)",
          }}
        >
          ?
        </span>
        <Text weight={500} style={{ paddingTop: 2 }}>
          {turn.question}
        </Text>
      </Stack>
      <div
        className="dbx-card"
        style={{ padding: props.compact ? 12 : 16, marginLeft: props.compact ? 0 : 30, display: "flex", flexDirection: "column", gap: 12 }}
      >
        {!done && <Progress status={status} />}
        {turn.error && <Notice tone="danger" title="Genie couldn't answer">{turn.error}</Notice>}
        {status === "FAILED" && !turn.error && (
          <Notice tone="danger" title="Genie couldn't answer">
            {turn.message?.error?.error ?? "The request failed."}
          </Notice>
        )}
        {turn.text && <Markdown source={turn.text} />}
        {turn.result && <ResultView result={turn.result} maxHeight={props.compact ? 200 : 320} />}
        {turn.loadingResult && (
          <Stack direction="row" gap={8} align="center">
            <Spinner size={12} />
            <Text tone="subtle" size="sm">
              Loading the result…
            </Text>
          </Stack>
        )}
        {done && turn.sql && !turn.result && !turn.loadingResult && props.onLoadResult && (
          <div>
            <Button size="sm" onClick={props.onLoadResult}>
              Show result
            </Button>
          </div>
        )}
        {turn.sql && (
          <Disclosure summary={turn.queryTitle ? `SQL · ${turn.queryTitle}` : "SQL Genie wrote"}>
            <CodeView code={turn.sql.trim()} />
          </Disclosure>
        )}
        {done && turn.suggestions.length > 0 && props.onSuggestion && (
          <Stack direction="row" gap={6} wrap>
            {turn.suggestions.slice(0, 4).map((suggestion) => (
              <Button key={suggestion} size="sm" variant="ghost" onClick={() => props.onSuggestion?.(suggestion)} style={{ border: "1px solid var(--dbx-border)" }}>
                {suggestion}
              </Button>
            ))}
          </Stack>
        )}
        {done && props.actions}
      </div>
    </Stack>
  );
}

function fromMessage(message: GenieMessage): Turn {
  const parts = summarize(message);
  return {
    key: messageId(message),
    question: message.content,
    message,
    suggestions: parts.suggestions,
    ...(parts.text && { text: parts.text }),
    ...(parts.sql && { sql: parts.sql }),
    ...(parts.queryTitle && { queryTitle: parts.queryTitle }),
    ...(parts.error && { error: parts.error }),
  };
}

export function useGenieConversation(service: DatabricksService, spaceId: string, initialConversation?: string) {
  const [conversationId, setConversationId] = React.useState(initialConversation);
  const [turns, setTurns] = React.useState<Turn[]>([]);
  const [busy, setBusy] = React.useState(false);
  const [historyError, setHistoryError] = React.useState<string>();
  const abort = React.useRef<AbortController | undefined>(undefined);

  React.useEffect(() => {
    setTurns([]);
    setConversationId(initialConversation);
    setHistoryError(undefined);
    if (!initialConversation) return;
    const controller = new AbortController();
    void (async () => {
      try {
        const client = await service.ready(controller.signal);
        const response = await client.get<{ messages?: GenieMessage[] }>(
          `/api/2.0/genie/spaces/${encodeURIComponent(spaceId)}/conversations/${encodeURIComponent(initialConversation)}/messages`,
          { query: { page_size: 50 }, signal: controller.signal },
        );
        const messages = [...(response.messages ?? [])]
          .map((message) => ({ ...message, conversation_id: initialConversation }))
          .sort((a, b) => (a.created_timestamp ?? 0) - (b.created_timestamp ?? 0));
        if (!controller.signal.aborted) setTurns(messages.map(fromMessage));
      } catch (error) {
        if (!controller.signal.aborted) setHistoryError(describeError(error));
      }
    })();
    return () => controller.abort();
  }, [service, spaceId, initialConversation]);

  React.useEffect(() => () => abort.current?.abort(), []);

  const update = (key: string, change: Partial<Turn>) =>
    setTurns((current) => current.map((turn) => (turn.key === key ? { ...turn, ...change } : turn)));

  const loadResult = async (key: string) => {
    const turn = turns.find((candidate) => candidate.key === key);
    const message = turn?.message;
    const attachment = message && summarize(message).queryAttachmentId;
    if (!message || !attachment) return;
    update(key, { loadingResult: true });
    try {
      const client = await service.ready();
      const result = await new Genie(client).result(spaceId, message, attachment);
      update(key, { result, loadingResult: false });
    } catch (error) {
      update(key, { loadingResult: false, error: describeError(error) });
    }
  };

  const ask = async (question: string) => {
    const text = question.trim();
    if (!text || busy) return;
    abort.current?.abort();
    const controller = new AbortController();
    abort.current = controller;
    const key = `pending-${Date.now()}`;
    let current = key;
    setTurns((existing) => [...existing, { key, question: text, suggestions: [] }]);
    setBusy(true);
    try {
      const client = await service.ready(controller.signal);
      const genie = new Genie(client);
      const answer = await genie.answer(spaceId, text, {
        ...(conversationId && { conversationId }),
        signal: controller.signal,
        onUpdate: (message) => {
          const id = messageId(message) || current;
          // React runs this updater later, after `current` moves on; capture it now.
          const previous = current;
          setTurns((existing) => existing.map((turn) => (turn.key === previous ? { ...turn, key: id, message } : turn)));
          current = id;
          if (message.conversation_id) setConversationId(message.conversation_id);
        },
      });
      setConversationId(answer.message.conversation_id);
      update(current, {
        message: answer.message,
        suggestions: answer.suggestions,
        ...(answer.text && { text: answer.text }),
        ...(answer.sql && { sql: answer.sql }),
        ...(answer.queryTitle && { queryTitle: answer.queryTitle }),
        ...(answer.result && { result: answer.result }),
        ...(answer.error && { error: answer.error }),
      });
    } catch (error) {
      if (!controller.signal.aborted) update(current, { error: describeError(error) });
    } finally {
      if (abort.current === controller) setBusy(false);
    }
  };

  const reset = () => {
    abort.current?.abort();
    setBusy(false);
    setTurns([]);
    setConversationId(undefined);
  };

  return { turns, busy, ask, reset, loadResult, conversationId, historyError };
}

export function Composer(props: { onAsk(question: string): void; busy: boolean; placeholder?: string; autoFocus?: boolean }) {
  const [text, setText] = React.useState("");
  const submit = () => {
    if (!text.trim() || props.busy) return;
    props.onAsk(text);
    setText("");
  };
  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        submit();
      }}
      style={{ display: "flex", gap: 8, alignItems: "flex-end" }}
    >
      <textarea
        className="dbx-textarea"
        rows={2}
        value={text}
        autoFocus={props.autoFocus}
        placeholder={props.placeholder ?? "Ask a question about your data"}
        onChange={(event) => setText(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
            event.preventDefault();
            submit();
          }
        }}
        style={{ flex: 1, minHeight: 44 }}
        aria-label="Question for Genie"
      />
      <Button type="submit" variant="primary" disabled={!text.trim() || props.busy}>
        {props.busy ? <Spinner size={12} label="Asking" /> : null}
        Ask
      </Button>
    </form>
  );
}

export function GenieChat(props: {
  service: DatabricksService;
  space: GenieSpace;
  conversationId?: string;
  compact?: boolean;
  /** Extra per-answer actions, e.g. inserting it into a message. */
  answerActions?(turn: Turn): React.ReactNode;
}) {
  const { service, space } = props;
  const chat = useGenieConversation(service, space.space_id, props.conversationId);
  const bottom = React.useRef<HTMLDivElement>(null);
  React.useEffect(() => {
    bottom.current?.scrollIntoView({ block: "end", behavior: "smooth" });
  }, [chat.turns.length, chat.turns[chat.turns.length - 1]?.message?.status]);
  const link = service.workspaceUrl(Genie.webPath(space.space_id, chat.conversationId));
  return (
    <Stack gap={16} style={{ minHeight: 0, flex: 1 }}>
      {!props.compact && (
        <Stack direction="row" align="flex-start" justify="space-between" gap={12}>
          <Stack gap={4} style={{ minWidth: 0 }}>
            <Stack direction="row" gap={8} align="center">
              <DatabricksMark size={16} />
              <Text as="h2" size="lg" weight={500}>
                {space.title}
              </Text>
              <Badge tone="brand">Genie</Badge>
            </Stack>
            {space.description && (
              <Text tone="subtle" size="sm" as="div" style={{ maxWidth: 680 }}>
                {space.description}
              </Text>
            )}
          </Stack>
          <Stack direction="row" gap={6}>
            {chat.turns.length > 0 && (
              <Button variant="ghost" onClick={chat.reset}>
                New chat
              </Button>
            )}
            {link && (
              <Button variant="ghost" onClick={() => window.open(link, "_blank", "noopener")}>
                Open in Databricks
              </Button>
            )}
          </Stack>
        </Stack>
      )}
      {chat.historyError && <Notice tone="warning" title="Couldn't load this conversation">{chat.historyError}</Notice>}
      <Stack gap={22} style={{ flex: 1 }}>
        {chat.turns.length === 0 && !props.compact && (
          <Stack gap={10} style={{ padding: "24px 0" }}>
            <Text tone="subtle">Ask a question in plain language. Genie writes the SQL, runs it with your access, and charts the answer.</Text>
            <Stack direction="row" gap={6} wrap>
              {["What data can I ask about?", "What are the key metrics here?", "Show the trend over the last 12 months"].map((example) => (
                <Button key={example} size="sm" variant="ghost" style={{ border: "1px solid var(--dbx-border)" }} onClick={() => void chat.ask(example)}>
                  {example}
                </Button>
              ))}
            </Stack>
          </Stack>
        )}
        {chat.turns.map((turn) => (
          <TurnView
            key={turn.key}
            turn={turn}
            {...(props.compact !== undefined && { compact: props.compact })}
            onSuggestion={(question) => void chat.ask(question)}
            onLoadResult={() => void chat.loadResult(turn.key)}
            actions={
              <Stack direction="row" gap={6}>
                <CopyButton text={turnMarkdown(space, turn, link)} label="Copy answer" />
                {props.answerActions?.(turn)}
              </Stack>
            }
          />
        ))}
        <div ref={bottom} />
      </Stack>
      <div style={{ position: "sticky", bottom: 0, background: "var(--surface-panel, var(--dbx-surface))", paddingTop: 8 }}>
        <Composer onAsk={(question) => void chat.ask(question)} busy={chat.busy} placeholder={`Ask ${space.title}`} autoFocus={!props.compact} />
      </div>
    </Stack>
  );
}

export const genieOf = (service: DatabricksService) => service.client() && new Genie(service.client()!);
