// Result tables and charts for Databricks query results.
import { React } from "../react";
import { formatCell, formatNumber, fromCsv, planChart, type ChartPlan, type ResultSet, type SeriesPlan, toCsv } from "../result";
import { Badge, Button, CopyButton, DbxRoot, Stack, Text } from "./components";
import { CHART_COLORS } from "./theme";

export function DataTable(props: { result: ResultSet; maxRows?: number; maxHeight?: number }) {
  const { result } = props;
  const rows = result.rows.slice(0, props.maxRows ?? 500);
  const total = result.totalRows ?? result.rows.length;
  return (
    <Stack gap={6}>
      <div
        style={{
          overflow: "auto",
          maxHeight: props.maxHeight ?? 320,
          border: "1px solid var(--dbx-border)",
          borderRadius: "var(--dbx-radius)",
        }}
      >
        <table className="dbx-table">
          <thead>
            <tr>
              {result.columns.map((column) => (
                <th key={column.name} data-numeric={column.kind === "number"} title={column.type}>
                  {column.name}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((row, r) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: rows have no identity
              <tr key={r}>
                {result.columns.map((column, c) => {
                  const value = row[c] ?? null;
                  return (
                    <td
                      key={column.name}
                      data-numeric={column.kind === "number"}
                      title={value ?? "null"}
                      style={value === null ? { color: "var(--dbx-tertiary)", fontStyle: "italic" } : undefined}
                    >
                      {formatCell(value, column.kind)}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <Stack direction="row" align="center" justify="space-between" gap={8}>
        <Text size="xs" tone="subtle">
          {rows.length === total
            ? `${total} ${total === 1 ? "row" : "rows"}`
            : `Showing ${rows.length} of ${total.toLocaleString()} rows`}
          {result.truncated && rows.length === total ? " (truncated)" : ""}
        </Text>
        <CopyButton text={toCsv(result)} label="Copy CSV" />
      </Stack>
    </Stack>
  );
}

const W = 560;
const H = 220;
const PAD = { top: 12, right: 12, bottom: 28, left: 52 };

function ticks(min: number, max: number, count = 4): number[] {
  if (min === max) return [min];
  const span = max - min;
  const step = 10 ** Math.floor(Math.log10(span / count));
  const nice = [1, 2, 2.5, 5, 10].map((m) => m * step).find((s) => span / s <= count) ?? step * 10;
  const start = Math.ceil(min / nice) * nice;
  const out: number[] = [];
  for (let value = start; value <= max + nice / 1000; value += nice) out.push(Number(value.toPrecision(12)));
  return out;
}

function Legend(props: { names: readonly string[] }) {
  if (props.names.length < 2) return null;
  return (
    <Stack direction="row" gap={12} wrap>
      {props.names.map((name, index) => (
        <span key={name} style={{ display: "inline-flex", alignItems: "center", gap: 5, fontSize: "0.6875rem", color: "var(--dbx-subtle)" }}>
          <span style={{ width: 8, height: 8, borderRadius: 2, background: CHART_COLORS[index % CHART_COLORS.length] }} />
          {name}
        </span>
      ))}
    </Stack>
  );
}

function LineChart(props: { result: ResultSet; plan: SeriesPlan }) {
  const { result, plan } = props;
  const isTime = result.columns[plan.x]?.kind === "time";
  const points = result.rows
    .map((row) => ({
      x: isTime ? Date.parse(String(row[plan.x])) : Number(row[plan.x]),
      raw: String(row[plan.x] ?? ""),
      ys: plan.series.map((index) => Number(row[index])),
    }))
    .filter((point) => Number.isFinite(point.x))
    .sort((a, b) => a.x - b.x);
  if (points.length < 2) return null;
  const xs = points.map((point) => point.x);
  const ys = points.flatMap((point) => point.ys.filter(Number.isFinite));
  const [x0, x1] = [Math.min(...xs), Math.max(...xs)];
  const [y0, y1] = [Math.min(0, ...ys), Math.max(...ys)];
  const sx = (x: number) => PAD.left + ((x - x0) / (x1 - x0 || 1)) * (W - PAD.left - PAD.right);
  const sy = (y: number) => H - PAD.bottom - ((y - y0) / (y1 - y0 || 1)) * (H - PAD.top - PAD.bottom);
  const xTicks = [points[0], points[Math.floor(points.length / 2)], points[points.length - 1]].filter(Boolean) as typeof points;
  return (
    <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label={`Line chart of ${plan.series.map((i) => result.columns[i]?.name).join(", ")}`} style={{ width: "100%", height: "auto" }}>
      {ticks(y0, y1).map((tick) => (
        <g key={tick}>
          <line x1={PAD.left} x2={W - PAD.right} y1={sy(tick)} y2={sy(tick)} stroke="var(--dbx-border)" />
          <text x={PAD.left - 6} y={sy(tick) + 3} textAnchor="end" fontSize="10" fill="var(--dbx-subtle)">
            {formatNumber(tick, "compact")}
          </text>
        </g>
      ))}
      {xTicks.map((point, index) => (
        <text key={point.raw} x={sx(point.x)} y={H - 8} fontSize="10" fill="var(--dbx-subtle)" textAnchor={index === 0 ? "start" : index === xTicks.length - 1 ? "end" : "middle"}>
          {isTime ? point.raw.slice(0, 10) : point.raw}
        </text>
      ))}
      {plan.series.map((_, s) => (
        <polyline
          key={plan.series[s]}
          fill="none"
          stroke={CHART_COLORS[s % CHART_COLORS.length]}
          strokeWidth="2"
          strokeLinejoin="round"
          points={points.filter((p) => Number.isFinite(p.ys[s])).map((p) => `${sx(p.x)},${sy(p.ys[s] as number)}`).join(" ")}
        />
      ))}
    </svg>
  );
}

function BarChart(props: { result: ResultSet; plan: SeriesPlan }) {
  const { result, plan } = props;
  const rows = result.rows.slice(0, 40);
  const values = rows.flatMap((row) => plan.series.map((index) => Number(row[index])).filter(Number.isFinite));
  const max = Math.max(0, ...values);
  const min = Math.min(0, ...values);
  if (plan.horizontal) {
    const rowH = 22;
    const labelW = 150;
    const height = rows.length * rowH * Math.max(1, plan.series.length * 0.6) + 8;
    const band = (height - 8) / rows.length;
    const scale = (v: number) => ((v - min) / (max - min || 1)) * (W - labelW - 60);
    return (
      <svg viewBox={`0 0 ${W} ${height}`} role="img" aria-label="Bar chart" style={{ width: "100%", height: "auto" }}>
        {rows.map((row, r) => {
          const y = 4 + r * band;
          const label = String(row[plan.x] ?? "null");
          return (
            <g key={`${label}-${r}`}>
              <text x={labelW - 8} y={y + band / 2 + 3} textAnchor="end" fontSize="10" fill="var(--dbx-ink)">
                {label.length > 24 ? `${label.slice(0, 23)}…` : label}
              </text>
              {plan.series.map((index, s) => {
                const value = Number(row[index]);
                const barH = (band - 4) / plan.series.length;
                const w = Number.isFinite(value) ? scale(value) - scale(0) : 0;
                return (
                  <g key={index}>
                    <rect x={labelW + Math.min(scale(0), scale(0) + w)} y={y + s * barH} width={Math.abs(w)} height={Math.max(2, barH - 1)} rx="2" fill={CHART_COLORS[s % CHART_COLORS.length]}>
                      <title>{`${label}: ${formatNumber(value)}`}</title>
                    </rect>
                    {plan.series.length === 1 && (
                      <text x={labelW + scale(0) + Math.max(0, w) + 4} y={y + barH / 2 + 3} fontSize="10" fill="var(--dbx-subtle)">
                        {formatNumber(value, "compact")}
                      </text>
                    )}
                  </g>
                );
              })}
            </g>
          );
        })}
      </svg>
    );
  }
  const band = (W - PAD.left - PAD.right) / rows.length;
  const sy = (y: number) => H - PAD.bottom - ((y - min) / (max - min || 1)) * (H - PAD.top - PAD.bottom);
  return (
    <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label="Bar chart" style={{ width: "100%", height: "auto" }}>
      {ticks(min, max).map((tick) => (
        <g key={tick}>
          <line x1={PAD.left} x2={W - PAD.right} y1={sy(tick)} y2={sy(tick)} stroke="var(--dbx-border)" />
          <text x={PAD.left - 6} y={sy(tick) + 3} textAnchor="end" fontSize="10" fill="var(--dbx-subtle)">
            {formatNumber(tick, "compact")}
          </text>
        </g>
      ))}
      {rows.map((row, r) => {
        const label = String(row[plan.x] ?? "null");
        const barW = (band * 0.75) / plan.series.length;
        return (
          <g key={`${label}-${r}`}>
            {plan.series.map((index, s) => {
              const value = Number(row[index]);
              const top = sy(Math.max(0, value));
              const h = Math.abs(sy(value) - sy(0));
              return (
                <rect key={index} x={PAD.left + r * band + band * 0.125 + s * barW} y={top} width={Math.max(1, barW - 1)} height={Math.max(1, h)} rx="2" fill={CHART_COLORS[s % CHART_COLORS.length]}>
                  <title>{`${label}: ${formatNumber(value)}`}</title>
                </rect>
              );
            })}
            <text x={PAD.left + r * band + band / 2} y={H - 10} fontSize="10" textAnchor="middle" fill="var(--dbx-subtle)">
              {label.length > 10 ? `${label.slice(0, 9)}…` : label}
            </text>
          </g>
        );
      })}
    </svg>
  );
}

export function ResultChart(props: { result: ResultSet; plan?: ChartPlan }) {
  const plan = props.plan ?? planChart(props.result);
  if (plan.type === "none") return null;
  if (plan.type === "kpi")
    return (
      <Stack gap={2} style={{ padding: "8px 2px" }}>
        <Text size="xs" tone="subtle">
          {plan.label}
        </Text>
        <Text size="xl" weight={600} style={{ fontSize: "1.75rem", fontVariantNumeric: "tabular-nums" }}>
          {formatNumber(plan.value)}
        </Text>
      </Stack>
    );
  const names = plan.series.map((index) => props.result.columns[index]?.name ?? "");
  return (
    <Stack gap={6}>
      <Legend names={names} />
      {plan.type === "line" ? <LineChart result={props.result} plan={plan} /> : <BarChart result={props.result} plan={plan} />}
    </Stack>
  );
}

/** Chart above table with a toggle, the default view of a query result. */
export function ResultView(props: { result: ResultSet; maxHeight?: number; compact?: boolean }) {
  const plan = React.useMemo(() => planChart(props.result), [props.result]);
  const [view, setView] = React.useState<"chart" | "table">(plan.type === "none" ? "table" : "chart");
  if (!props.result.columns.length) return <Text tone="subtle">The query returned no columns.</Text>;
  const canChart = plan.type !== "none";
  return (
    <Stack gap={8}>
      {canChart && (
        <Stack direction="row" gap={4} align="center">
          <Button size="sm" variant={view === "chart" ? "default" : "ghost"} onClick={() => setView("chart")}>
            Chart
          </Button>
          <Button size="sm" variant={view === "table" ? "default" : "ghost"} onClick={() => setView("table")}>
            Table
          </Button>
          {props.result.truncated && <Badge tone="warning">Partial</Badge>}
        </Stack>
      )}
      {view === "chart" && canChart ? (
        <ResultChart result={props.result} plan={plan} />
      ) : (
        <DataTable result={props.result} {...(props.maxHeight !== undefined && { maxHeight: props.maxHeight })} />
      )}
    </Stack>
  );
}

/**
 * A `databricks-result` code block in a message: its CSV drawn as a chart with
 * a table toggle. Throws on CSV it can't read, so Buzz shows the plain block.
 */
export function ResultBlock(props: { code: string }) {
  const result = React.useMemo(() => fromCsv(props.code), [props.code]);
  if (!result) throw new Error("Not a result table");
  // Room on the right for the host's Copy button.
  return (
    <DbxRoot style={{ padding: "10px 44px 10px 12px" }}>
      <ResultView result={result} maxHeight={320} compact />
    </DbxRoot>
  );
}
