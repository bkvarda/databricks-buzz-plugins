// ```sql blocks in conversations: highlighted SQL plus a Run action. Each
// viewer runs the statement with their own access on their own warehouse, so
// a shared query never leaks data to someone who can't already read it.
import { React } from "@dbx/core/react";
import { type DatabricksService, useConnection } from "@dbx/core/service";
import { Button, DbxRoot, Notice, Spinner, Stack, Text } from "@dbx/core/ui/components";
import { ResultView } from "@dbx/core/ui/data";
import type { Runs } from "./runs";

const KEYWORDS = new Set(
  "select from where group by order having limit join left right inner outer full cross on as and or not in is null like ilike between case when then else end with union all distinct over partition qualify insert into values update set delete merge using create table view replace drop alter describe show explain asc desc interval date timestamp cast true false exists any some lateral pivot unpivot window rows range preceding following current row".split(
    " ",
  ),
);

/** Splits SQL into tokens for light highlighting; never alters the text. */
export function highlight(sql: string): { text: string; kind: "keyword" | "string" | "comment" | "number" | "plain" }[] {
  const tokens: { text: string; kind: "keyword" | "string" | "comment" | "number" | "plain" }[] = [];
  const pattern = /(--[^\n]*|\/\*[\s\S]*?\*\/)|('(?:[^'\\]|\\.)*'?)|(\b\d+(?:\.\d+)?\b)|([A-Za-z_][A-Za-z0-9_]*)|(\s+|[^\sA-Za-z0-9_'-]+|-)/g;
  let match: RegExpExecArray | null;
  // biome-ignore lint/suspicious/noAssignInExpressions: standard regex loop
  while ((match = pattern.exec(sql))) {
    if (match[1]) tokens.push({ text: match[1], kind: "comment" });
    else if (match[2]) tokens.push({ text: match[2], kind: "string" });
    else if (match[3]) tokens.push({ text: match[3], kind: "number" });
    else if (match[4]) tokens.push({ text: match[4], kind: KEYWORDS.has(match[4].toLowerCase()) ? "keyword" : "plain" });
    else tokens.push({ text: match[0], kind: "plain" });
  }
  return tokens;
}

const COLOR = {
  keyword: "var(--dbx-lava-text)",
  string: "var(--dbx-success)",
  comment: "var(--dbx-tertiary)",
  number: "var(--text-link, #2272B4)",
  plain: "inherit",
} as const;

export function SqlText(props: { code: string }) {
  const tokens = React.useMemo(() => highlight(props.code), [props.code]);
  return (
    <code className="dbx-mono" style={{ whiteSpace: "pre", fontSize: "inherit" }}>
      {tokens.map((token, index) =>
        token.kind === "plain" ? (
          token.text
        ) : (
          // biome-ignore lint/suspicious/noArrayIndexKey: token order is fixed
          <span key={index} style={{ color: COLOR[token.kind], fontWeight: token.kind === "keyword" ? 500 : undefined }}>
            {token.text}
          </span>
        ),
      )}
    </code>
  );
}

function useRun(runs: Runs, code: string) {
  React.useSyncExternalStore(runs.subscribe, runs.snapshot);
  return runs.get(code);
}

export function sqlBlock(service: DatabricksService, runs: Runs) {
  return function SqlBlock(props: { code: string; language: string }) {
    const run = useRun(runs, props.code);
    return (
      <DbxRoot>
        <pre style={{ margin: 0, overflow: "auto" }}>
          <SqlText code={props.code} />
        </pre>
        {run && (
          <div style={{ marginTop: 10, paddingTop: 10, borderTop: "1px solid var(--dbx-border)", fontFamily: "var(--font-sans, inherit)", whiteSpace: "normal" }}>
            {run.status === "confirm" && (
              <Notice
                tone="warning"
                title="This statement can change data"
                action={
                  <Stack direction="row" gap={6}>
                    <Button size="sm" variant="primary" onClick={() => void runs.run(props.code)}>
                      Run anyway
                    </Button>
                    <Button size="sm" variant="ghost" onClick={() => runs.clear(props.code)}>
                      Cancel
                    </Button>
                  </Stack>
                }
              >
                It will run with your Databricks access. Check it before running.
              </Notice>
            )}
            {run.status === "running" && (
              <Stack direction="row" gap={8} align="center">
                <Spinner size={12} />
                <Text tone="subtle" size="sm">
                  Running on Databricks…
                </Text>
                <Button size="sm" variant="ghost" onClick={() => runs.cancel(props.code)}>
                  Cancel
                </Button>
              </Stack>
            )}
            {run.status === "error" && (
              <Notice tone="danger" title="The query failed" action={<Button size="sm" variant="ghost" onClick={() => runs.clear(props.code)}>Dismiss</Button>}>
                {run.message}
              </Notice>
            )}
            {run.status === "done" && (
              <Stack gap={8}>
                <ResultView result={run.result} maxHeight={260} />
                <Stack direction="row" gap={8} align="center" justify="space-between">
                  <Text tone="tertiary" size="xs">
                    Ran as you on {run.warehouse} in {(run.ms / 1000).toFixed(1)}s
                  </Text>
                  <Button size="sm" variant="ghost" onClick={() => runs.clear(props.code)}>
                    Hide result
                  </Button>
                </Stack>
              </Stack>
            )}
          </div>
        )}
      </DbxRoot>
    );
  };
}

export function sqlBlockAction(service: DatabricksService, runs: Runs) {
  return function RunSql(props: { code: string; language: string }) {
    const snapshot = useConnection(service);
    const run = useRun(runs, props.code);
    const connected = snapshot.status === "connected";
    return (
      <DbxRoot style={{ display: "inline-flex" }}>
        <Button
          size="sm"
          variant="ghost"
          title={connected ? "Run this query on Databricks with your access" : "Connect Databricks to run queries"}
          disabled={run?.status === "running"}
          onClick={() => (connected ? runs.request(props.code) : service.openSettings())}
        >
          {run?.status === "running" ? "Running…" : connected ? "▶ Run" : "Connect to run"}
        </Button>
      </DbxRoot>
    );
  };
}
