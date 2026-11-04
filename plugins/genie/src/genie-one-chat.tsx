// Genie One on the Genie page: workspace-wide questions, no Genie agent
// needed. Genie One's MCP server returns its progress steps, answer, SQL and
// typed rows; this renders them with Buzz-native components: a live thinking
// timeline, the answer, an auto chart or table, and the SQL.
import { React } from "@dbx/core/react";
import { resultSet, type ResultSet } from "@dbx/core/result";
import { type DatabricksService, describeError } from "@dbx/core/service";
import { Badge, Button, CodeView, CopyButton, DatabricksMark, Disclosure, Notice, openExternal, Spinner, Stack, Text } from "@dbx/core/ui/components";
import { ResultView } from "@dbx/core/ui/data";
import { Markdown, parseBlocks } from "@dbx/core/ui/markdown";
import { Composer } from "./chat";
import { cleanAnswer, type GenieOne, type GenieOneAnswer, stripComments, withoutChartCaveats } from "./genie-one";

export { cleanAnswer };

export type OneTurn = {
  key: string;
  question: string;
  steps: readonly string[];
  started: number;
  finished?: number;
  answer?: GenieOneAnswer;
  error?: string;
};

export type Step = Readonly<{ kind: "thought" | "sql" | "result" | "other"; text: string }>;

/** Splits Genie One's one-line step summaries ("Running SQL: SELECT …"). */
export function parseStep(raw: string): Step {
  const clean = (text: string) => stripComments(text).replace(/\s*\|.*\|\s*$/s, "").trim();
  const match = /^(Thinking|Running SQL|Query result|[A-Z][\w ]{1,24}):\s*(.*)$/s.exec(raw.trim());
  if (!match) return { kind: "other", text: clean(raw) };
  const [, label = "", rest = ""] = match;
  if (label === "Thinking") return { kind: "thought", text: clean(rest.replace(/^Genie:\s*none\s*[—-]\s*/i, "")) };
  if (label === "Running SQL") return { kind: "sql", text: rest.trim() };
  if (label === "Query result") return { kind: "result", text: clean(rest).replace(/:$/, "") };
  return { kind: "other", text: clean(`${label}: ${rest}`) };
}

const plain = (cell: string) => cell.replace(/\*\*|__|`/g, "").trim();

/**
 * The answer's text and result sets. Rows Genie One returned as typed results
 * win; otherwise Markdown tables in the answer become result sets, so both
 * render as a native chart or table instead of Markdown.
 */
export function answerParts(answer: GenieOneAnswer): { text: string; results: readonly ResultSet[] } {
  const text = cleanAnswer(answer.text);
  const lines = text.split("\n");
  const kept: string[] = [];
  const tables: string[][] = [];
  const row = /^\s*\|.*\|\s*$/;
  for (let i = 0; i < lines.length; i++) {
    if (row.test(lines[i] ?? "") && /^\s*\|?\s*:?-{2,}/.test(lines[i + 1] ?? "")) {
      const table: string[] = [];
      while (i < lines.length && row.test(lines[i] ?? "")) table.push(lines[i++] ?? "");
      i--;
      tables.push(table);
      continue;
    }
    kept.push(lines[i] ?? "");
  }
  if (!tables.length) return { text: answer.results.length ? withoutChartCaveats(text) : text, results: answer.results };
  const parsed = answer.results.length
    ? answer.results
    : tables.flatMap((table) => {
        const block = parseBlocks(table.join("\n")).find((candidate) => candidate.type === "table");
        if (!block || block.type !== "table") return [];
        return [resultSet(block.header.map((name) => ({ name: plain(name) })), block.rows.map((cells) => cells.map((cell) => plain(cell) || null)))];
      });
  const rest = kept.join("\n").replace(/\n{3,}/g, "\n\n").trim();
  return { text: parsed.length ? withoutChartCaveats(rest) : rest, results: parsed };
}

/** The answer text alone (tables removed when they render natively). */
export const answerText = (answer: GenieOneAnswer) => answerParts(answer).text;

/** Breaks one-line SQL at its main clauses for reading. */
export function formatSql(sql: string): string {
  if (sql.includes("\n")) return sql.trim();
  return sql
    .trim()
    .replace(/\s+(FROM|WHERE|GROUP BY|HAVING|ORDER BY|LIMIT|QUALIFY|UNION ALL|UNION|(?:LEFT |RIGHT |FULL |INNER |CROSS )?JOIN)\s+/gi, (_, clause: string) => `\n${clause.toUpperCase()} `)
    .replace(/^(SELECT\s+)(.+?)(?=\nFROM)/is, (_, select: string, list: string) => {
      const items = list.split(/,\s+(?![^()]*\))/);
      return items.length > 2 ? `${select.trim()}\n  ${items.join(",\n  ")}` : `${select}${list}`;
    });
}

const seconds = (turn: OneTurn) => Math.max(1, Math.round(((turn.finished ?? Date.now()) - turn.started) / 1000));

function Timeline(props: { steps: readonly string[]; live: boolean }) {
  const steps = props.steps.map(parseStep);
  return (
    <ol style={{ listStyle: "none", margin: 0, padding: 0, display: "flex", flexDirection: "column", gap: 10 }}>
      {steps.map((step, index) => {
        const last = index === steps.length - 1;
        return (
          <li key={`${index}-${step.kind}`} style={{ display: "flex", gap: 10, alignItems: "flex-start" }}>
            <span style={{ width: 14, display: "inline-flex", justifyContent: "center", paddingTop: 4, flex: "none" }}>
              {props.live && last ? (
                <Spinner size={11} />
              ) : (
                <span
                  aria-hidden
                  style={{
                    width: 7,
                    height: 7,
                    borderRadius: "50%",
                    background: step.kind === "sql" ? "var(--dbx-lava)" : "var(--dbx-border-strong)",
                  }}
                />
              )}
            </span>
            <Stack gap={4} style={{ minWidth: 0, flex: 1 }}>
              <Text size="xs" tone="tertiary" weight={500}>
                {{ thought: "Thinking", sql: "Ran SQL", result: "Result", other: "Step" }[step.kind]}
              </Text>
              {step.kind === "sql" ? (
                <CodeView code={formatSql(step.text)} maxHeight={180} copy={false} />
              ) : (
                <Text size="sm" tone="subtle" as="div">
                  {step.text}
                </Text>
              )}
            </Stack>
          </li>
        );
      })}
      {props.live && !steps.length && (
        <li style={{ display: "flex", gap: 10, alignItems: "center" }}>
          <Spinner size={11} />
          <Text size="sm" tone="subtle">
            Finding the right data…
          </Text>
        </li>
      )}
    </ol>
  );
}

/** Markdown for sharing an answer into a conversation. */
export function oneTurnMarkdown(turn: OneTurn): string {
  const answer = turn.answer;
  if (!answer) return "";
  const parts = [`**Genie One** · _${turn.question}_`, cleanAnswer(answer.text)];
  if (answer.deepLink) parts.push(`[Explore in Databricks](${answer.deepLink})`);
  return parts.filter(Boolean).join("\n\n");
}

export function OneTurnView(props: { turn: OneTurn; compact?: boolean; actions?: React.ReactNode }) {
  const { turn } = props;
  const answer = turn.answer;
  const live = !answer && !turn.error;
  const parts = React.useMemo(() => (answer ? answerParts(answer) : undefined), [answer]);
  const [, tick] = React.useState(0);
  React.useEffect(() => {
    if (!live) return;
    const timer = setInterval(() => tick((n) => n + 1), 1000);
    return () => clearInterval(timer);
  }, [live]);
  return (
    <Stack gap={10}>
      <Text weight={500}>{turn.question}</Text>
      <div className="dbx-card" style={{ padding: props.compact ? 12 : 16, display: "flex", flexDirection: "column", gap: 14 }}>
        {live ? (
          <Stack gap={10}>
            <Text size="sm" tone="subtle">
              Thinking · {seconds(turn)}s
            </Text>
            <Timeline steps={turn.steps} live />
          </Stack>
        ) : (
          turn.steps.length > 0 && (
            <Disclosure summary={`Thought for ${seconds(turn)}s · ${turn.steps.length} ${turn.steps.length === 1 ? "step" : "steps"}`}>
              <Timeline steps={turn.steps} live={false} />
            </Disclosure>
          )
        )}
        {turn.error && <Notice tone="danger" title="Genie One couldn't answer">{turn.error}</Notice>}
        {answer?.status === "incomplete" && <Notice tone="warning" title="Genie One stopped early">The answer may be partial.</Notice>}
        {parts?.text && <Markdown source={parts.text} />}
        {parts && parts.results.length > 0 && (
          // The last query is the one the answer describes; earlier ones are drafts.
          <ResultView result={parts.results[parts.results.length - 1]!} maxHeight={props.compact ? 200 : 320} />
        )}
        {parts && parts.results.length > 1 && (
          <Disclosure summary={`Earlier results (${parts.results.length - 1})`}>
            <Stack gap={12}>
              {parts.results.slice(0, -1).map((result, index) => (
                <ResultView key={index} result={result} maxHeight={240} />
              ))}
            </Stack>
          </Disclosure>
        )}
        {answer && answer.sql.length > 0 && (
          <Disclosure summary={answer.sql.length === 1 ? "SQL Genie One ran" : `SQL Genie One ran (${answer.sql.length})`}>
            <Stack gap={8}>
              {answer.sql.map((statement, index) => (
                <CodeView key={index} code={formatSql(statement)} />
              ))}
            </Stack>
          </Disclosure>
        )}
        {answer && (
          <Stack direction="row" gap={6} wrap>
            {answer.deepLink && (
              <Button size="sm" onClick={() => answer.deepLink && openExternal(answer.deepLink)}>
                Explore in Databricks
              </Button>
            )}
            {props.actions}
          </Stack>
        )}
      </div>
    </Stack>
  );
}

export function useGenieOneConversation(genieOne: GenieOne) {
  const [conversationId, setConversationId] = React.useState<string>();
  const [turns, setTurns] = React.useState<OneTurn[]>([]);
  const [busy, setBusy] = React.useState(false);
  const abort = React.useRef<AbortController | undefined>(undefined);
  React.useEffect(() => () => abort.current?.abort(), []);

  const update = (key: string, change: Partial<OneTurn>) =>
    setTurns((current) => current.map((turn) => (turn.key === key ? { ...turn, ...change } : turn)));

  const ask = async (question: string) => {
    const text = question.trim();
    if (!text || busy) return;
    const controller = new AbortController();
    abort.current = controller;
    const key = `one-${Date.now()}`;
    setTurns((existing) => [...existing, { key, question: text, steps: [], started: Date.now() }]);
    setBusy(true);
    try {
      const answer = await genieOne.ask(text, {
        ...(conversationId && { conversationId }),
        signal: controller.signal,
        onProgress: (steps) => update(key, { steps: [...steps] }),
      });
      setConversationId(answer.conversationId);
      update(key, { answer, steps: [...answer.steps], finished: Date.now() });
    } catch (error) {
      if (!controller.signal.aborted) update(key, { error: describeError(error), finished: Date.now() });
    } finally {
      if (abort.current === controller) setBusy(false);
    }
  };

  const stop = () => {
    abort.current?.abort();
    setBusy(false);
    setTurns((current) => current.map((turn) => (turn.answer || turn.error ? turn : { ...turn, error: "Stopped.", finished: Date.now() })));
  };

  const reset = () => {
    abort.current?.abort();
    setBusy(false);
    setTurns([]);
    setConversationId(undefined);
  };

  return { turns, busy, ask, stop, reset, conversationId };
}

const EXAMPLES = ["What data do I have access to?", "Which tables are used the most?", "What changed in the last week?"];

export function GenieOneChat(props: {
  service: DatabricksService;
  genieOne: GenieOne;
  compact?: boolean;
  answerActions?(turn: OneTurn): React.ReactNode;
}) {
  const chat = useGenieOneConversation(props.genieOne);
  const bottom = React.useRef<HTMLDivElement>(null);
  const last = chat.turns[chat.turns.length - 1];
  React.useEffect(() => {
    bottom.current?.scrollIntoView({ block: "end", behavior: "smooth" });
  }, [chat.turns.length, last?.steps.length, Boolean(last?.answer)]);
  return (
    <Stack gap={16} style={{ minHeight: 0, flex: 1 }}>
      {!props.compact && (
        <Stack direction="row" align="flex-start" justify="space-between" gap={12}>
          <Stack gap={4} style={{ minWidth: 0 }}>
            <Stack direction="row" gap={8} align="center">
              <DatabricksMark size={16} />
              <Text as="h2" size="lg" weight={500}>
                Genie One
              </Text>
              <Badge tone="brand">All your data</Badge>
            </Stack>
            <Text tone="subtle" size="sm" as="div" style={{ maxWidth: 680 }}>
              Ask anything about data you can access in this workspace. Genie One finds the right tables and Genie agents, writes the SQL and runs it as you.
            </Text>
          </Stack>
          <Stack direction="row" gap={6}>
            {chat.busy && (
              <Button variant="ghost" onClick={chat.stop}>
                Stop
              </Button>
            )}
            {chat.turns.length > 0 && (
              <Button variant="ghost" onClick={chat.reset}>
                New chat
              </Button>
            )}
          </Stack>
        </Stack>
      )}
      <Stack gap={22} style={{ flex: 1 }}>
        {chat.turns.length === 0 && !props.compact && (
          <Stack gap={10} style={{ padding: "24px 0" }}>
            <Text tone="subtle">Genie One usually answers in under a minute and shows its work as it goes.</Text>
            <Stack direction="row" gap={6} wrap>
              {EXAMPLES.map((example) => (
                <Button key={example} size="sm" variant="ghost" style={{ border: "1px solid var(--dbx-border)" }} onClick={() => void chat.ask(example)}>
                  {example}
                </Button>
              ))}
            </Stack>
          </Stack>
        )}
        {chat.turns.map((turn) => (
          <OneTurnView
            key={turn.key}
            turn={turn}
            {...(props.compact !== undefined && { compact: props.compact })}
            actions={
              turn.answer && (
                <>
                  <CopyButton text={oneTurnMarkdown(turn)} label="Copy answer" />
                  {props.answerActions?.(turn)}
                </>
              )
            }
          />
        ))}
        <div ref={bottom} />
      </Stack>
      <div style={{ position: "sticky", bottom: 0, background: "var(--surface-panel, var(--dbx-surface))", paddingTop: 8 }}>
        <Composer onAsk={(question) => void chat.ask(question)} busy={chat.busy} placeholder="Ask Genie One about any of your data" autoFocus={!props.compact} />
      </div>
    </Stack>
  );
}
