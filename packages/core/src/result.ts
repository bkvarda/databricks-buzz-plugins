// One shape for tabular results, whichever API produced them: the SQL
// Statement Execution API, Genie query results, or MCP tool output.

export type ColumnKind = "number" | "time" | "text" | "boolean";

export type Column = Readonly<{ name: string; type?: string; kind: ColumnKind }>;

export type ResultSet = Readonly<{
  columns: readonly Column[];
  rows: readonly (readonly (string | null)[])[];
  /** Rows the source reported in total, when more exist than `rows`. */
  totalRows?: number;
  truncated?: boolean;
}>;

const NUMERIC_TYPES = /^(tinyint|smallint|int|integer|bigint|long|short|byte|float|double|real|decimal|numeric)/i;
const TIME_TYPES = /^(date|timestamp)/i;

/** Numbers that name things (IDs, ZIP codes, years) are labels, not measures. */
const IDENTIFIER = /(^|_)(id|ids|zip|zipcode|zip_code|postal_code|postcode|code|key|year|fiscal_year|phone)$/i;

export function kindOf(type: string | undefined, sample: readonly (string | null)[], name = ""): ColumnKind {
  if (IDENTIFIER.test(name) && !TIME_TYPES.test(type ?? "") && !/^bool/i.test(type ?? "")) return "text";
  if (type) {
    if (NUMERIC_TYPES.test(type)) return "number";
    if (TIME_TYPES.test(type)) return "time";
    if (/^bool/i.test(type)) return "boolean";
    if (/^(string|varchar|char|binary|array|map|struct|interval)/i.test(type)) return "text";
  }
  const values = sample.filter((value): value is string => value !== null && value !== "");
  if (!values.length) return "text";
  if (values.every((value) => /^-?\d+(\.\d+)?([eE][+-]?\d+)?$/.test(value))) return "number";
  if (values.every((value) => /^\d{4}-\d{2}(-\d{2})?([T ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?)?$/.test(value)))
    return "time";
  return "text";
}

/** Builds a ResultSet from column names/types and string rows. */
export function resultSet(
  columns: readonly Readonly<{ name: string; type?: string }>[],
  rows: readonly (readonly (string | null)[])[],
  extra: Readonly<{ totalRows?: number; truncated?: boolean }> = {},
): ResultSet {
  return {
    columns: columns.map((column, index) => ({
      name: column.name,
      ...(column.type && { type: column.type }),
      kind: kindOf(
        column.type,
        rows.slice(0, 50).map((row) => row[index] ?? null),
        column.name,
      ),
    })),
    rows,
    ...extra,
  };
}

/** Parses the Statement Execution API's `manifest` + `result` (JSON_ARRAY). */
export function fromStatement(response: {
  manifest?: {
    schema?: { columns?: readonly { name: string; type_text?: string; type_name?: string }[] };
    total_row_count?: number;
    truncated?: boolean;
  };
  result?: { data_array?: readonly (readonly (string | null)[])[] };
}): ResultSet {
  const columns = (response.manifest?.schema?.columns ?? []).map((column) => ({
    name: column.name,
    type: column.type_text ?? column.type_name ?? "",
  }));
  const rows = response.result?.data_array ?? [];
  const total = response.manifest?.total_row_count;
  return resultSet(columns, rows, {
    ...(total !== undefined && { totalRows: total }),
    truncated: Boolean(response.manifest?.truncated) || (total !== undefined && total > rows.length),
  });
}

const compact = new Intl.NumberFormat(undefined, { notation: "compact", maximumFractionDigits: 1 });
const precise = new Intl.NumberFormat(undefined, { maximumFractionDigits: 2 });

export function formatNumber(value: number, style: "compact" | "precise" = "precise"): string {
  if (!Number.isFinite(value)) return String(value);
  if (style === "compact" && Math.abs(value) >= 10_000) return compact.format(value);
  return precise.format(value);
}

export function formatCell(value: string | null, kind: ColumnKind): string {
  if (value === null) return "null";
  if (kind === "number") {
    const parsed = Number(value);
    if (Number.isFinite(parsed) && Math.abs(parsed) < 1e15) return formatNumber(parsed);
  }
  if (kind === "time" && /T00:00:00(\.000)?(Z)?$/.test(value)) return value.slice(0, 10);
  return value;
}

/** A Markdown table of the first rows, for agents and plain-text replies. */
export function toMarkdown(result: ResultSet, maxRows = 20): string {
  if (!result.columns.length) return "_No columns._";
  const escape = (value: string) => value.replace(/\|/g, "\\|").replace(/\n/g, " ");
  const head = `| ${result.columns.map((column) => escape(column.name)).join(" | ")} |`;
  const rule = `| ${result.columns.map((column) => (column.kind === "number" ? "---:" : "---")).join(" | ")} |`;
  const body = result.rows
    .slice(0, maxRows)
    .map(
      (row) =>
        `| ${result.columns
          .map((column, index) => escape(formatCell(row[index] ?? null, column.kind)))
          .join(" | ")} |`,
    );
  const total = result.totalRows ?? result.rows.length;
  const note =
    total > Math.min(maxRows, result.rows.length)
      ? `\n\n_Showing ${Math.min(maxRows, result.rows.length)} of ${total} rows._`
      : "";
  return [head, rule, ...body].join("\n") + note;
}

/** CSV text for downloads and clipboard. */
export function toCsv(result: ResultSet): string {
  const quote = (value: string | null) =>
    value === null ? "" : /[",\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
  return [
    result.columns.map((column) => quote(column.name)).join(","),
    ...result.rows.map((row) => row.map(quote).join(",")),
  ].join("\n");
}

export type SeriesPlan = Readonly<{ type: "line" | "bar"; x: number; series: readonly number[]; horizontal?: boolean }>;

export type ChartPlan =
  | Readonly<{ type: "kpi"; value: number; label: string }>
  | SeriesPlan
  | Readonly<{ type: "none" }>;

/** Picks the chart that reads best for a result, or none. */
/** Keeps measures within 10× of the first, so no series flattens to nothing. */
function comparable(rows: ResultSet["rows"], indices: readonly number[]): number[] {
  const peak = (index: number) => Math.max(0, ...rows.map((row) => Math.abs(Number(row[index]) || 0)));
  const base = indices[0] === undefined ? 0 : peak(indices[0]);
  return indices.filter((index, n) => n === 0 || base === 0 || (peak(index) / base <= 10 && peak(index) / base >= 0.1));
}

export function planChart(result: ResultSet): ChartPlan {
  const { columns, rows } = result;
  if (!rows.length) return { type: "none" };
  const numeric = columns.flatMap((column, index) => (column.kind === "number" ? [index] : []));
  if (rows.length === 1 && columns.length === 1 && numeric.length === 1) {
    const value = Number(rows[0]?.[0]);
    if (Number.isFinite(value)) return { type: "kpi", value, label: columns[0]?.name ?? "" };
  }
  if (rows.length < 2 || !numeric.length) return { type: "none" };
  const time = columns.findIndex((column) => column.kind === "time");
  if (time !== -1) {
    const series = comparable(rows, numeric.filter((index) => index !== time)).slice(0, 4);
    return series.length ? { type: "line", x: time, series } : { type: "none" };
  }
  const label = columns.findIndex((column) => column.kind === "text");
  if (label !== -1 && rows.length <= 40) {
    const series = comparable(rows, numeric).slice(0, 3);
    const longest = Math.max(...rows.map((row) => (row[label] ?? "").length));
    return { type: "bar", x: label, series, horizontal: longest > 10 || rows.length > 12 };
  }
  // A year/month/hour integer column is a common x-axis even without a time type.
  const yearLike = numeric.find((index) =>
    /(^|_)(year|yr|quarter|month|week|day|hour|minute|period)(_|s?$)/i.test(columns[index]?.name ?? ""),
  );
  if (yearLike !== undefined) {
    const series = comparable(rows, numeric.filter((index) => index !== yearLike)).slice(0, 4);
    if (series.length) return { type: "line", x: yearLike, series };
  }
  return { type: "none" };
}

// ── Result blocks in messages ──
// An agent reply carries a result as a fenced code block of CSV, language
// `databricks-result`. With these plugins installed, Buzz draws it as a chart
// with a table toggle; without them it stays readable CSV, and Copy gives CSV.

export const RESULT_LANGUAGE = "databricks-result";

/** Parses CSV (RFC 4180 quoting). Empty unquoted fields become null. */
export function parseCsv(text: string): (string | null)[][] {
  const rows: (string | null)[][] = [];
  let row: (string | null)[] = [];
  let field = "";
  let quoted = false;
  let wasQuoted = false;
  const endField = () => {
    row.push(field === "" && !wasQuoted ? null : field);
    field = "";
    wasQuoted = false;
  };
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (quoted) {
      if (char === '"' && text[i + 1] === '"') (field += '"'), i++;
      else if (char === '"') quoted = false;
      else field += char;
    } else if (char === '"' && field === "") (quoted = true), (wasQuoted = true);
    else if (char === ",") endField();
    else if (char === "\n" || char === "\r") {
      if (char === "\r" && text[i + 1] === "\n") i++;
      endField();
      rows.push(row);
      row = [];
    } else field += char;
  }
  if (field !== "" || wasQuoted || row.length) {
    endField();
    rows.push(row);
  }
  return rows.filter((cells) => cells.some((cell) => cell !== null));
}

/** A result block's ResultSet, or undefined when it isn't a header plus rows. */
export function fromCsv(text: string): ResultSet | undefined {
  const [header, ...rows] = parseCsv(text.trim());
  if (!header?.length || header.some((name) => !name)) return undefined;
  if (rows.some((row) => row.length !== header.length)) return undefined;
  return resultSet(header.map((name) => ({ name: name ?? "" })), rows);
}

/** A fenced result block for a message, with at most `maxRows` rows. */
export function resultBlock(result: ResultSet, maxRows = 200): string {
  const shown = { ...result, rows: result.rows.slice(0, maxRows) };
  const csv = toCsv(shown);
  const fence = csv.includes("```") ? "````" : "```";
  const total = result.totalRows ?? result.rows.length;
  const note = total > shown.rows.length ? `\n\n_Showing ${shown.rows.length} of ${total} rows._` : "";
  return `${fence}${RESULT_LANGUAGE}\n${csv}\n${fence}${note}`;
}
