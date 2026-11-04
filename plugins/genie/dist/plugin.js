// Databricks Genie (bkvarda.databricks-genie) — built by databricks-buzz-plugins. Apache-2.0.

// packages/core/src/result.ts
var NUMERIC_TYPES = /^(tinyint|smallint|int|integer|bigint|long|short|byte|float|double|real|decimal|numeric)/i;
var TIME_TYPES = /^(date|timestamp)/i;
var IDENTIFIER = /(^|_)(id|ids|zip|zipcode|zip_code|postal_code|postcode|code|key|year|fiscal_year|phone)$/i;
function kindOf(type, sample, name = "") {
  if (IDENTIFIER.test(name) && !TIME_TYPES.test(type ?? "") && !/^bool/i.test(type ?? "")) return "text";
  if (type) {
    if (NUMERIC_TYPES.test(type)) return "number";
    if (TIME_TYPES.test(type)) return "time";
    if (/^bool/i.test(type)) return "boolean";
    if (/^(string|varchar|char|binary|array|map|struct|interval)/i.test(type)) return "text";
  }
  const values = sample.filter((value) => value !== null && value !== "");
  if (!values.length) return "text";
  if (values.every((value) => /^-?\d+(\.\d+)?([eE][+-]?\d+)?$/.test(value))) return "number";
  if (values.every((value) => /^\d{4}-\d{2}(-\d{2})?([T ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?)?$/.test(value)))
    return "time";
  return "text";
}
function resultSet(columns, rows, extra = {}) {
  return {
    columns: columns.map((column, index) => ({
      name: column.name,
      ...column.type && { type: column.type },
      kind: kindOf(
        column.type,
        rows.slice(0, 50).map((row) => row[index] ?? null),
        column.name
      )
    })),
    rows,
    ...extra
  };
}
function fromStatement(response) {
  const columns = (response.manifest?.schema?.columns ?? []).map((column) => ({
    name: column.name,
    type: column.type_text ?? column.type_name ?? ""
  }));
  const rows = response.result?.data_array ?? [];
  const total = response.manifest?.total_row_count;
  return resultSet(columns, rows, {
    ...total !== void 0 && { totalRows: total },
    truncated: Boolean(response.manifest?.truncated) || total !== void 0 && total > rows.length
  });
}
var compact = new Intl.NumberFormat(void 0, { notation: "compact", maximumFractionDigits: 1 });
var precise = new Intl.NumberFormat(void 0, { maximumFractionDigits: 2 });
function formatNumber(value, style = "precise") {
  if (!Number.isFinite(value)) return String(value);
  if (style === "compact" && Math.abs(value) >= 1e4) return compact.format(value);
  return precise.format(value);
}
function formatCell(value, kind) {
  if (value === null) return "null";
  if (kind === "number") {
    const parsed = Number(value);
    if (Number.isFinite(parsed) && Math.abs(parsed) < 1e15) return formatNumber(parsed);
  }
  if (kind === "time" && /T00:00:00(\.000)?(Z)?$/.test(value)) return value.slice(0, 10);
  return value;
}
function toMarkdown(result, maxRows = 20) {
  if (!result.columns.length) return "_No columns._";
  const escape = (value) => value.replace(/\|/g, "\\|").replace(/\n/g, " ");
  const head = `| ${result.columns.map((column) => escape(column.name)).join(" | ")} |`;
  const rule = `| ${result.columns.map((column) => column.kind === "number" ? "---:" : "---").join(" | ")} |`;
  const body = result.rows.slice(0, maxRows).map(
    (row) => `| ${result.columns.map((column, index) => escape(formatCell(row[index] ?? null, column.kind))).join(" | ")} |`
  );
  const total = result.totalRows ?? result.rows.length;
  const note = total > Math.min(maxRows, result.rows.length) ? `

_Showing ${Math.min(maxRows, result.rows.length)} of ${total} rows._` : "";
  return [head, rule, ...body].join("\n") + note;
}
function toCsv(result) {
  const quote = (value) => value === null ? "" : /[",\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
  return [
    result.columns.map((column) => quote(column.name)).join(","),
    ...result.rows.map((row) => row.map(quote).join(","))
  ].join("\n");
}
function comparable(rows, indices) {
  const peak = (index) => Math.max(0, ...rows.map((row) => Math.abs(Number(row[index]) || 0)));
  const base2 = indices[0] === void 0 ? 0 : peak(indices[0]);
  return indices.filter((index, n) => n === 0 || base2 === 0 || peak(index) / base2 <= 10 && peak(index) / base2 >= 0.1);
}
function planChart(result) {
  const { columns, rows } = result;
  if (!rows.length) return { type: "none" };
  const numeric = columns.flatMap((column, index) => column.kind === "number" ? [index] : []);
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
  const yearLike = numeric.find(
    (index) => /(^|_)(year|yr|quarter|month|week|day|hour|minute|period)(_|s?$)/i.test(columns[index]?.name ?? "")
  );
  if (yearLike !== void 0) {
    const series = comparable(rows, numeric.filter((index) => index !== yearLike)).slice(0, 4);
    if (series.length) return { type: "line", x: yearLike, series };
  }
  return { type: "none" };
}

// packages/core/src/api/genie.ts
var TERMINAL = /* @__PURE__ */ new Set(["COMPLETED", "FAILED", "QUERY_RESULT_EXPIRED", "CANCELLED"]);
var STATUS_LABEL = {
  SUBMITTED: "Submitted",
  FETCHING_METADATA: "Reading the data model",
  FILTERING_CONTEXT: "Choosing relevant tables",
  ASKING_AI: "Writing a query",
  PENDING_WAREHOUSE: "Waiting for the SQL warehouse",
  EXECUTING_QUERY: "Running the query",
  COMPLETED: "Done",
  FAILED: "Failed",
  QUERY_RESULT_EXPIRED: "Result expired",
  CANCELLED: "Cancelled"
};
var messageId = (message) => message.message_id ?? message.id ?? "";
function summarize(message) {
  const attachments = message.attachments ?? [];
  const text = attachments.map((attachment) => attachment.text?.content).filter((value) => Boolean(value)).join("\n\n");
  const query = attachments.find((attachment) => attachment.query?.query);
  const suggestions = attachments.flatMap((attachment) => attachment.suggested_questions?.questions ?? []);
  return {
    text,
    sql: query?.query?.query,
    queryTitle: query?.query?.title,
    queryDescription: query?.query?.description,
    queryAttachmentId: query?.attachment_id,
    rowCount: query?.query?.query_result_metadata?.row_count,
    suggestions,
    error: message.error?.error
  };
}
var base = (spaceId) => `/api/2.0/genie/spaces/${encodeURIComponent(spaceId)}`;
var Genie = class {
  constructor(client) {
    this.client = client;
  }
  async listSpaces(signal) {
    const spaces = [];
    let pageToken;
    for (let page = 0; page < 20; page++) {
      const response = await this.client.get(
        "/api/2.0/genie/spaces",
        { query: { page_size: 100, page_token: pageToken }, ...signal && { signal } }
      );
      spaces.push(...response.spaces ?? []);
      pageToken = response.next_page_token;
      if (!pageToken) break;
    }
    return spaces.sort((a, b) => a.title.localeCompare(b.title));
  }
  getSpace(spaceId, signal) {
    return this.client.get(base(spaceId), signal ? { signal } : {});
  }
  /** Starts a conversation (or continues one) and returns the new message. */
  async ask(spaceId, content, conversationId, signal) {
    if (conversationId) {
      const message = await this.client.post(
        `${base(spaceId)}/conversations/${encodeURIComponent(conversationId)}/messages`,
        { content },
        signal ? { signal } : {}
      );
      return { ...message, conversation_id: message.conversation_id ?? conversationId };
    }
    const started = await this.client.post(`${base(spaceId)}/start-conversation`, { content }, signal ? { signal } : {});
    const conversation = started.conversation_id ?? started.conversation?.id ?? started.message?.conversation_id ?? "";
    return {
      content,
      status: "SUBMITTED",
      ...started.message,
      conversation_id: conversation,
      message_id: started.message_id ?? started.message?.message_id ?? started.message?.id ?? ""
    };
  }
  getMessage(spaceId, conversationId, id, signal) {
    return this.client.get(
      `${base(spaceId)}/conversations/${encodeURIComponent(conversationId)}/messages/${encodeURIComponent(id)}`,
      signal ? { signal } : {}
    );
  }
  /** Polls until the message settles: 1s, backing off to 5s, up to 10 min. */
  async wait(spaceId, message, onUpdate, signal) {
    let current = message;
    let delay = 1e3;
    const deadline = Date.now() + 10 * 6e4;
    while (!TERMINAL.has(current.status)) {
      if (Date.now() > deadline) throw new Error("Genie did not answer within 10 minutes.");
      await new Promise((resolve) => setTimeout(resolve, delay));
      signal?.throwIfAborted();
      delay = Math.min(5e3, Math.round(delay * 1.4));
      current = {
        ...await this.getMessage(spaceId, current.conversation_id, messageId(current), signal),
        conversation_id: current.conversation_id
      };
      onUpdate?.(current);
    }
    return current;
  }
  /** The query attachment's result, re-running it when it expired. */
  async result(spaceId, message, attachmentId, signal) {
    const path = `${base(spaceId)}/conversations/${encodeURIComponent(message.conversation_id)}/messages/${encodeURIComponent(
      messageId(message)
    )}/attachments/${encodeURIComponent(attachmentId)}`;
    try {
      const response = await this.client.get(`${path}/query-result`, signal ? { signal } : {});
      if (response.statement_response?.result || response.statement_response?.manifest)
        return fromStatement(response.statement_response);
    } catch (error) {
      if (error.status !== 404 && error.status !== 400) throw error;
    }
    const rerun = await this.client.post(`${path}/execute-query`, {}, signal ? { signal } : {});
    return fromStatement(rerun.statement_response ?? {});
  }
  /** A full answer: waits, then fetches the query result when there is one. */
  async answer(spaceId, question, options = {}) {
    const started = await this.ask(spaceId, question, options.conversationId, options.signal);
    options.onUpdate?.(started);
    const message = await this.wait(spaceId, started, options.onUpdate, options.signal);
    const parts = summarize(message);
    let result;
    if (message.status === "COMPLETED" && parts.queryAttachmentId)
      result = await this.result(spaceId, message, parts.queryAttachmentId, options.signal).catch(() => void 0);
    return { message, ...parts, result };
  }
  /** The Genie web URL for a conversation, for "Open in Databricks". */
  static webPath(spaceId, conversationId) {
    return `/genie/rooms/${encodeURIComponent(spaceId)}${conversationId ? `/chats/${encodeURIComponent(conversationId)}` : ""}`;
  }
};
function parseGenieUrl(url) {
  try {
    const parsed = new URL(url);
    const match = /^\/genie\/rooms\/([0-9a-f]{32}|[\w-]{8,})(?:\/chats\/([\w-]+))?/i.exec(parsed.pathname);
    if (!match?.[1]) return void 0;
    if (!/databricks|azuredatabricks/i.test(parsed.hostname)) return void 0;
    return { host: parsed.origin, spaceId: match[1], ...match[2] && { conversationId: match[2] } };
  } catch {
    return void 0;
  }
}

// packages/core/src/react.ts
var React = void 0;
function bindReact(instance) {
  React = instance;
}

// packages/core/src/host-types.ts
function optionalService(ctx, name) {
  try {
    return ctx.reflect?.get?.(name);
  } catch {
    return void 0;
  }
}
var schema = {
  object(properties, required = []) {
    return { type: "object", properties, required, additionalProperties: false };
  },
  string(description, extra = {}) {
    return { type: "string", description, ...extra };
  },
  integer(description, extra = {}) {
    return { type: "integer", description, ...extra };
  },
  boolean(description) {
    return { type: "boolean", description };
  }
};
function stringArg(args, name, required = true) {
  const value = args[name];
  if (typeof value === "string" && value.trim()) return value.trim();
  if (required) throw new Error(`${name} is required.`);
  return "";
}
function numberArg(args, name, fallback, min, max) {
  const value = args[name];
  const parsed = typeof value === "number" ? value : typeof value === "string" ? Number(value) : Number.NaN;
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, Math.round(parsed)));
}

// packages/core/src/cli.ts
var EXPIRY_MARGIN_MS = 3 * 6e4;
var DEFAULT_LIFETIME_MS = 30 * 6e4;

// packages/core/src/sse.ts
var SseParser = class {
  constructor(onEvent) {
    this.onEvent = onEvent;
  }
  buffer = "";
  data = [];
  event = "";
  id;
  push(chunk) {
    this.buffer += chunk;
    let index = this.buffer.search(/\r\n|\r|\n/);
    while (index !== -1) {
      const line = this.buffer.slice(0, index);
      const newline = this.buffer.startsWith("\r\n", index) ? 2 : 1;
      this.buffer = this.buffer.slice(index + newline);
      this.line(line);
      index = this.buffer.search(/\r\n|\r|\n/);
    }
  }
  /** Dispatches a final event that was not followed by a blank line. */
  end() {
    if (this.buffer) this.line(this.buffer);
    this.buffer = "";
    this.line("");
  }
  line(line) {
    if (line === "") {
      if (this.data.length) {
        this.onEvent({
          event: this.event || "message",
          data: this.data.join("\n"),
          ...this.id !== void 0 && { id: this.id }
        });
      }
      this.data = [];
      this.event = "";
      return;
    }
    if (line.startsWith(":")) return;
    const colon = line.indexOf(":");
    const field = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? "" : line.slice(colon + 1);
    if (value.startsWith(" ")) value = value.slice(1);
    if (field === "data") this.data.push(value);
    else if (field === "event") this.event = value;
    else if (field === "id") this.id = value;
  }
};
function parseSse(body) {
  const events = [];
  const parser = new SseParser((event) => events.push(event));
  parser.push(body);
  parser.end();
  return events;
}

// packages/core/src/client.ts
var DatabricksApiError = class extends Error {
  constructor(status, errorCode, message, body) {
    super(message);
    this.status = status;
    this.errorCode = errorCode;
    this.body = body;
    this.name = "DatabricksApiError";
  }
  get isPermission() {
    return this.status === 403 || this.errorCode === "PERMISSION_DENIED";
  }
  get isNotFound() {
    return this.status === 404 || this.errorCode === "RESOURCE_DOES_NOT_EXIST" || this.errorCode === "NOT_FOUND";
  }
  get isFeatureDisabled() {
    return this.errorCode === "FEATURE_DISABLED" || this.errorCode === "NOT_IMPLEMENTED" || /not enabled|feature.*disabled|preview/i.test(this.message);
  }
};
function apiError(response) {
  let code;
  let message = `Databricks returned HTTP ${response.status}`;
  try {
    const parsed = JSON.parse(response.body);
    code = parsed.error_code ?? (typeof parsed.error === "object" ? parsed.error?.code : void 0);
    message = parsed.message ?? (typeof parsed.error === "object" ? parsed.error?.message : parsed.error) ?? parsed.error_description ?? message;
  } catch {
    const text = response.body.trim();
    if (text && text.length < 400 && !text.startsWith("<")) message = text;
  }
  return new DatabricksApiError(response.status, code, message, response.body);
}

// packages/core/src/service.ts
var SERVICE_NAME = "databricks";
var CORE_PLUGIN_ID = "bkvarda.databricks";
var SETTINGS_SECTION = `${CORE_PLUGIN_ID}/connection`;
function withDatabricks(ctx, member, apply2) {
  ctx.inject([SERVICE_NAME], (scope) => {
    const databricks = scope.databricks;
    if (!databricks || databricks.version !== 1) return;
    const leave = databricks.announce?.(member);
    if (leave) scope.effect(() => leave);
    apply2(scope, databricks);
  });
}
function useConnection(service) {
  return React.useSyncExternalStore(service.subscribe, service.snapshot);
}
function usePreference(service, name) {
  const value = React.useSyncExternalStore(
    service.preferences.subscribe,
    () => JSON.stringify(service.preferences.get(name) ?? null)
  );
  const parsed = React.useMemo(() => JSON.parse(value), [value]);
  return [parsed ?? void 0, (next) => service.preferences.set(name, next)];
}
function useAsync(load, key) {
  const [state, setState] = React.useState({ loading: true });
  const [nonce, setNonce] = React.useState(0);
  React.useEffect(() => {
    const controller = new AbortController();
    setState((previous) => ({ ...previous, loading: true }));
    load(controller.signal).then(
      (data) => {
        if (!controller.signal.aborted) setState({ data, loading: false });
      },
      (error) => {
        if (!controller.signal.aborted)
          setState({ error: error instanceof Error ? error : new Error(String(error)), loading: false });
      }
    );
    return () => controller.abort();
  }, [...key, nonce]);
  return { ...state, reload: () => setNonce((n) => n + 1) };
}
function isApiError(error) {
  return error instanceof Error && error.name === "DatabricksApiError";
}
function describeError(error) {
  if (isApiError(error)) {
    if (error.isPermission) return `You don't have access: ${error.message}`;
    if (error.isFeatureDisabled) return `This isn't enabled in your workspace: ${error.message}`;
    return error.message;
  }
  if (error instanceof Error) return error.message;
  return String(error);
}

// packages/core/src/ui/theme.ts
var BRAND = {
  lava: "#FF3621",
  lavaStrong: "#E5301D",
  navy: "#0B2026",
  oat: "#F9F7F4",
  oatMedium: "#EEEDE9",
  green: "#00A972",
  amber: "#FBB300",
  blue: "#4462C9",
  teal: "#1B5162"
};
var CHART_COLORS = [
  "var(--dbx-chart-1)",
  "var(--dbx-chart-2)",
  "var(--dbx-chart-3)",
  "var(--dbx-chart-4)",
  "var(--dbx-chart-5)",
  "var(--dbx-chart-6)",
  "var(--dbx-chart-7)",
  "var(--dbx-chart-8)"
];
var STYLE_ID = "dbx-buzz-plugins-style-v1";
var STYLESHEET = `
[data-dbx] {
  --dbx-lava: ${BRAND.lava};
  --dbx-lava-strong: ${BRAND.lavaStrong};
  --dbx-lava-text: #C4290F;
  --dbx-brand-tint: rgba(255, 54, 33, 0.08);
  --dbx-brand-tint-strong: rgba(255, 54, 33, 0.16);
  --dbx-ink: var(--text-standard, #0F0F0F);
  --dbx-subtle: var(--text-subtle, #5D6670);
  --dbx-tertiary: var(--text-tertiary, var(--text-subtle, #7A828A));
  --dbx-border: var(--border-standard, #E4E2DD);
  --dbx-border-strong: var(--border-prominent, #C4CCD6);
  --dbx-surface: var(--surface-panel, #FFFFFF);
  --dbx-inset: var(--surface-inset, #F6F5F2);
  --dbx-popover: var(--surface-popover, #FFFFFF);
  --dbx-success: var(--text-success, #00804F);
  --dbx-warning: var(--text-warning, #9A6A00);
  --dbx-danger: var(--text-danger, #C4290F);
  --dbx-chart-1: #FF3621; --dbx-chart-2: #4462C9; --dbx-chart-3: #00A972;
  --dbx-chart-4: #FBB300; --dbx-chart-5: #FF7033; --dbx-chart-6: #003159;
  --dbx-chart-7: #A0AEC0; --dbx-chart-8: #98102A;
  --dbx-radius: var(--radius-control, 8px);
  --dbx-radius-card: var(--radius-card, 12px);
  color: var(--dbx-ink);
}
.dark [data-dbx] {
  --dbx-lava-text: #FF7A66;
  --dbx-brand-tint: rgba(255, 90, 71, 0.14);
  --dbx-brand-tint-strong: rgba(255, 90, 71, 0.24);
  --dbx-chart-6: #6FA8BA; --dbx-chart-8: #E0607A;
}
[data-dbx] *, [data-dbx] *::before, [data-dbx] *::after { box-sizing: border-box; }
[data-dbx] .dbx-btn {
  display: inline-flex; align-items: center; justify-content: center; gap: 6px;
  min-height: 28px; padding: 0 12px; border-radius: var(--dbx-radius);
  border: 1px solid transparent; font: inherit; font-size: 0.8125rem; font-weight: 500;
  cursor: pointer; white-space: nowrap; transition: background-color 120ms ease, border-color 120ms ease;
  background: var(--affordance-subtle, #EFEFEF); color: var(--dbx-ink);
}
[data-dbx] .dbx-btn:hover:not(:disabled) { background: var(--affordance-subtle-hover, #E5E5E5); }
[data-dbx] .dbx-btn:focus-visible { outline: 2px solid var(--border-focus, #4462C9); outline-offset: 2px; }
[data-dbx] .dbx-btn:disabled { cursor: default; opacity: 0.55; }
[data-dbx] .dbx-btn[data-variant="primary"] { background: var(--affordance-prominent, #0F0F0F); color: var(--text-on-prominent, #FFF); }
[data-dbx] .dbx-btn[data-variant="primary"]:hover:not(:disabled) { background: var(--affordance-prominent-hover, #2A2A2A); }
[data-dbx] .dbx-btn[data-variant="brand"] { background: var(--dbx-lava-strong); color: #FFFFFF; }
[data-dbx] .dbx-btn[data-variant="brand"]:hover:not(:disabled) { background: #C4290F; }
[data-dbx] .dbx-btn[data-variant="ghost"] { background: transparent; }
[data-dbx] .dbx-btn[data-variant="ghost"]:hover:not(:disabled) { background: var(--affordance-subtle-hover, #EFEFEF); }
[data-dbx] .dbx-btn[data-variant="danger"] { background: transparent; color: var(--dbx-danger); border-color: var(--dbx-border); }
[data-dbx] .dbx-btn[data-size="sm"] { min-height: 24px; padding: 0 8px; font-size: 0.75rem; }
[data-dbx] .dbx-icon-btn { padding: 0; width: 28px; }
[data-dbx] .dbx-input, [data-dbx] .dbx-select, [data-dbx] .dbx-textarea {
  width: 100%; font: inherit; font-size: 0.8125rem; color: var(--dbx-ink);
  background: var(--surface-composer, var(--dbx-surface)); border: 1px solid var(--dbx-border);
  border-radius: var(--dbx-radius); padding: 6px 10px; min-height: 30px;
}
[data-dbx] .dbx-textarea { resize: vertical; line-height: 1.45; }
[data-dbx] .dbx-input:focus, [data-dbx] .dbx-select:focus, [data-dbx] .dbx-textarea:focus {
  outline: none; border-color: var(--border-focus, #4462C9); box-shadow: 0 0 0 1px var(--border-focus, #4462C9);
}
[data-dbx] .dbx-card { background: var(--dbx-surface); border: 1px solid var(--dbx-border); border-radius: var(--dbx-radius-card); }
[data-dbx] .dbx-row:hover { background: var(--affordance-row-hover, var(--affordance-subtle-hover, #F2F2F2)); }
[data-dbx] .dbx-row[aria-selected="true"] { background: var(--affordance-selected, var(--affordance-subtle, #EDEDED)); }
[data-dbx] .dbx-mono { font-family: var(--font-mono, ui-monospace, SFMono-Regular, Menlo, monospace); }
[data-dbx] .dbx-table { border-collapse: separate; border-spacing: 0; width: 100%; font-size: 0.75rem; }
[data-dbx] .dbx-table th { position: sticky; top: 0; z-index: 1; background: var(--dbx-inset); text-align: left; font-weight: 500; color: var(--dbx-subtle); }
[data-dbx] .dbx-table th, [data-dbx] .dbx-table td { padding: 5px 10px; border-bottom: 1px solid var(--dbx-border); white-space: nowrap; max-width: 320px; overflow: hidden; text-overflow: ellipsis; }
[data-dbx] .dbx-table td[data-numeric="true"], [data-dbx] .dbx-table th[data-numeric="true"] { text-align: right; font-variant-numeric: tabular-nums; }
[data-dbx] .dbx-table tbody tr:hover td { background: var(--affordance-row-hover, rgba(127,127,127,0.06)); }
[data-dbx] .dbx-link { color: var(--text-link, #2272B4); text-decoration: none; cursor: pointer; background: none; border: 0; padding: 0; font: inherit; }
[data-dbx] .dbx-link:hover { text-decoration: underline; }
[data-dbx] .dbx-md a.dbx-link { text-decoration: underline; text-decoration-color: color-mix(in srgb, currentColor 40%, transparent); text-underline-offset: 2px; }
[data-dbx] .dbx-md a.dbx-link:hover { text-decoration-color: currentColor; }
[data-dbx] .dbx-md p { margin: 0 0 8px; }
[data-dbx] .dbx-md p:last-child { margin-bottom: 0; }
[data-dbx] .dbx-md ul, [data-dbx] .dbx-md ol { margin: 0 0 8px; padding-left: 20px; }
[data-dbx] .dbx-md code { font-family: var(--font-mono, ui-monospace, monospace); font-size: 0.92em; background: var(--dbx-inset); padding: 1px 4px; border-radius: 4px; }
[data-dbx] .dbx-md pre { background: var(--dbx-inset); padding: 10px 12px; border-radius: var(--dbx-radius); overflow: auto; }
[data-dbx] .dbx-md pre code { background: none; padding: 0; }
@keyframes dbx-spin { to { transform: rotate(360deg); } }
@keyframes dbx-pulse { 0%, 100% { opacity: 0.35; } 50% { opacity: 1; } }
@media (prefers-reduced-motion: reduce) { [data-dbx] * { animation-duration: 0s !important; transition: none !important; } }
`;
function ensureStyles(doc = globalThis.document) {
  if (!doc || doc.getElementById(STYLE_ID)) return;
  const style = doc.createElement("style");
  style.id = STYLE_ID;
  style.textContent = STYLESHEET;
  doc.head.appendChild(style);
}
var DATABRICKS_MARK_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 300 331" fill="none"><path fill="#FF3621" d="M283.923 136.449L150.144 213.624L6.88995 131.168L0 134.982V194.844L150.144 281.115L283.923 204.234V235.926L150.144 313.1L6.88995 230.644L0 234.458V244.729L150.144 331L300 244.729V184.867L293.11 181.052L150.144 263.215L16.0766 186.334V154.643L150.144 231.524L300 145.253V86.2713L292.536 81.8697L150.144 163.739L22.9665 90.9663L150.144 17.8998L254.641 78.055L263.828 72.773V65.4371L150.144 0L0 86.2713V95.6613L150.144 181.933L283.923 104.758V136.449Z"/></svg>`;
var DATABRICKS_MARK_MONO_SVG = DATABRICKS_MARK_SVG.replace(
  'fill="#FF3621"',
  'fill="currentColor"'
);
var svgDataUri = (svg) => `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`;
var DATABRICKS_ICON = svgDataUri(DATABRICKS_MARK_SVG);
var DATABRICKS_ICON_MONO = svgDataUri(DATABRICKS_MARK_MONO_SVG);

// packages/core/src/ui/components.tsx
function DbxRoot(props) {
  ensureStyles();
  return /* @__PURE__ */ React.createElement("div", { "data-dbx": "", className: props.className, style: props.style }, props.children);
}
function DatabricksMark(props) {
  const size = props.size ?? 16;
  const svg = props.color === "current" ? DATABRICKS_MARK_SVG.replace('fill="#FF3621"', 'fill="currentColor"') : DATABRICKS_MARK_SVG;
  return /* @__PURE__ */ React.createElement(
    "span",
    {
      role: props.title ? "img" : void 0,
      "aria-label": props.title,
      "aria-hidden": props.title ? void 0 : true,
      style: { display: "inline-flex", width: size, height: size * 1.1, flex: "none" },
      dangerouslySetInnerHTML: { __html: svg.replace("<svg ", `<svg width="${size}" height="${size * 1.1}" `) }
    }
  );
}
function Button(props) {
  return /* @__PURE__ */ React.createElement(
    "button",
    {
      type: props.type ?? "button",
      className: `dbx-btn${props.icon ? " dbx-icon-btn" : ""}`,
      "data-variant": props.variant ?? "default",
      "data-size": props.size ?? "md",
      disabled: props.disabled,
      onClick: props.onClick,
      title: props.title,
      "aria-label": props["aria-label"],
      style: props.style
    },
    props.children
  );
}
function Spinner(props) {
  const size = props.size ?? 14;
  return /* @__PURE__ */ React.createElement(
    "span",
    {
      role: "status",
      "aria-label": props.label ?? "Loading",
      style: {
        display: "inline-block",
        width: size,
        height: size,
        borderRadius: "50%",
        border: "2px solid var(--dbx-border-strong)",
        borderTopColor: "var(--dbx-lava)",
        animation: "dbx-spin 0.8s linear infinite",
        flex: "none"
      }
    }
  );
}
function Stack(props) {
  return /* @__PURE__ */ React.createElement(
    "div",
    {
      style: {
        display: "flex",
        flexDirection: props.direction ?? "column",
        gap: props.gap ?? 8,
        alignItems: props.align,
        justifyContent: props.justify,
        flexWrap: props.wrap ? "wrap" : void 0,
        minWidth: 0,
        ...props.style
      }
    },
    props.children
  );
}
function Text(props) {
  const color = {
    standard: "var(--dbx-ink)",
    subtle: "var(--dbx-subtle)",
    tertiary: "var(--dbx-tertiary)",
    danger: "var(--dbx-danger)",
    success: "var(--dbx-success)",
    warning: "var(--dbx-warning)",
    brand: "var(--dbx-lava-text)"
  }[props.tone ?? "standard"];
  const fontSize = { xs: "0.6875rem", sm: "0.75rem", md: "0.8125rem", lg: "0.9375rem", xl: "1.125rem" }[props.size ?? "md"];
  const Tag = props.as ?? "span";
  return React.createElement(
    Tag,
    {
      className: props.mono ? "dbx-mono" : void 0,
      style: {
        margin: 0,
        color,
        fontSize,
        fontWeight: props.weight ?? (Tag.startsWith("h") ? 500 : 400),
        lineHeight: 1.45,
        ...props.style
      }
    },
    props.children
  );
}
function Notice(props) {
  const tone = props.tone ?? "info";
  const accent = {
    info: "var(--dbx-border-strong)",
    warning: "var(--dbx-warning)",
    danger: "var(--dbx-danger)",
    success: "var(--dbx-success)"
  }[tone];
  return /* @__PURE__ */ React.createElement(
    "div",
    {
      role: tone === "danger" ? "alert" : "status",
      style: {
        display: "flex",
        gap: 12,
        alignItems: "flex-start",
        justifyContent: "space-between",
        padding: "10px 12px",
        borderRadius: "var(--dbx-radius)",
        border: "1px solid var(--dbx-border)",
        background: "var(--dbx-inset)",
        boxShadow: `inset 3px 0 0 ${accent}`
      }
    },
    /* @__PURE__ */ React.createElement(Stack, { gap: 2, style: { minWidth: 0 } }, props.title && /* @__PURE__ */ React.createElement(Text, { weight: 500, size: "md" }, props.title), props.children && /* @__PURE__ */ React.createElement(Text, { tone: "subtle", size: "sm", as: "div" }, props.children)),
    props.action && /* @__PURE__ */ React.createElement("div", { style: { flex: "none" } }, props.action)
  );
}
function EmptyState(props) {
  return /* @__PURE__ */ React.createElement(
    Stack,
    {
      align: "center",
      gap: 10,
      style: { textAlign: "center", padding: "40px 24px", maxWidth: 420, margin: "0 auto" }
    },
    props.mark !== false && /* @__PURE__ */ React.createElement(DatabricksMark, { size: 28 }),
    /* @__PURE__ */ React.createElement(Text, { as: "h3", size: "lg", weight: 500 }, props.title),
    props.children && /* @__PURE__ */ React.createElement(Text, { tone: "subtle", as: "div" }, props.children),
    props.action
  );
}
function Badge(props) {
  const tone = props.tone ?? "neutral";
  const color = {
    neutral: "var(--dbx-subtle)",
    brand: "var(--dbx-lava-text)",
    success: "var(--dbx-success)",
    warning: "var(--dbx-warning)",
    danger: "var(--dbx-danger)"
  }[tone];
  return /* @__PURE__ */ React.createElement(
    "span",
    {
      title: props.title,
      style: {
        display: "inline-flex",
        alignItems: "center",
        gap: 4,
        padding: "1px 7px",
        borderRadius: 999,
        fontSize: "0.6875rem",
        fontWeight: 500,
        lineHeight: 1.6,
        color,
        background: tone === "brand" ? "var(--dbx-brand-tint)" : "var(--dbx-inset)",
        border: "1px solid var(--dbx-border)",
        whiteSpace: "nowrap"
      }
    },
    props.children
  );
}
function CopyButton(props) {
  const [copied, setCopied] = React.useState(false);
  return /* @__PURE__ */ React.createElement(
    Button,
    {
      size: "sm",
      variant: "ghost",
      onClick: () => {
        void navigator.clipboard?.writeText(props.text).then(() => {
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        });
      }
    },
    copied ? "Copied" : props.label ?? "Copy"
  );
}
function CodeView(props) {
  return /* @__PURE__ */ React.createElement("div", { style: { position: "relative" } }, /* @__PURE__ */ React.createElement(
    "pre",
    {
      className: "dbx-mono",
      style: {
        margin: 0,
        padding: "10px 12px",
        background: "var(--dbx-inset)",
        border: "1px solid var(--dbx-border)",
        borderRadius: "var(--dbx-radius)",
        fontSize: "0.75rem",
        lineHeight: 1.5,
        overflow: "auto",
        maxHeight: props.maxHeight ?? 260,
        whiteSpace: "pre"
      }
    },
    /* @__PURE__ */ React.createElement("code", null, props.code)
  ), props.copy !== false && /* @__PURE__ */ React.createElement("div", { style: { position: "absolute", top: 4, right: 4 } }, /* @__PURE__ */ React.createElement(CopyButton, { text: props.code })));
}
function Disclosure(props) {
  return /* @__PURE__ */ React.createElement("details", { open: props.defaultOpen }, /* @__PURE__ */ React.createElement("summary", { style: { cursor: "pointer", fontSize: "0.75rem", color: "var(--dbx-subtle)", userSelect: "none" } }, props.summary), /* @__PURE__ */ React.createElement("div", { style: { marginTop: 8 } }, props.children));
}

// packages/core/src/suite.tsx
var REPOSITORY = "https://github.com/bkvarda/databricks-buzz-plugins";
var Live = class {
  value;
  listeners = /* @__PURE__ */ new Set();
  snapshot = () => this.value;
  subscribe = (listener) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };
  set(value) {
    this.value = value;
    for (const listener of [...this.listeners]) listener();
  }
};
function attach(ctx, member, apply2) {
  const live = new Live();
  withDatabricks(ctx, member, (scope, databricks) => {
    live.set(apply2(scope, databricks));
    scope.effect(() => () => live.set(void 0));
  });
  return live;
}
function useLive(live) {
  return React.useSyncExternalStore(live.subscribe, live.snapshot);
}
function MissingCore(props) {
  const [message, setMessage] = React.useState();
  const add = async () => {
    const installer = optionalService(props.ctx, "pluginInstaller");
    if (!installer) {
      setMessage("Add it from Settings \u2192 Plugins \u2192 Manage plugins \u2192 Add, using github.com/bkvarda/databricks-buzz-plugins.");
      return;
    }
    const outcome = await installer.requestInstall({ repository: REPOSITORY, reference: "main", path: "plugins/databricks/dist" }).catch(() => "unavailable");
    if (outcome === "unavailable") setMessage("Close any open plugin review and try again.");
  };
  return /* @__PURE__ */ React.createElement(DbxRoot, { style: { padding: 32 } }, /* @__PURE__ */ React.createElement(
    EmptyState,
    {
      title: "Add the Databricks plugin",
      action: /* @__PURE__ */ React.createElement(Button, { variant: "brand", onClick: () => void add() }, "Add Databricks")
    },
    props.feature,
    " uses the Databricks plugin (",
    CORE_PLUGIN_ID,
    ") for sign-in. Add it, or turn it back on in Settings \u2192 Plugins.",
    message && /* @__PURE__ */ React.createElement("p", null, message)
  ));
}

// packages/core/src/ui/data.tsx
function DataTable(props) {
  const { result } = props;
  const rows = result.rows.slice(0, props.maxRows ?? 500);
  const total = result.totalRows ?? result.rows.length;
  return /* @__PURE__ */ React.createElement(Stack, { gap: 6 }, /* @__PURE__ */ React.createElement(
    "div",
    {
      style: {
        overflow: "auto",
        maxHeight: props.maxHeight ?? 320,
        border: "1px solid var(--dbx-border)",
        borderRadius: "var(--dbx-radius)"
      }
    },
    /* @__PURE__ */ React.createElement("table", { className: "dbx-table" }, /* @__PURE__ */ React.createElement("thead", null, /* @__PURE__ */ React.createElement("tr", null, result.columns.map((column) => /* @__PURE__ */ React.createElement("th", { key: column.name, "data-numeric": column.kind === "number", title: column.type }, column.name)))), /* @__PURE__ */ React.createElement("tbody", null, rows.map((row, r) => (
      // biome-ignore lint/suspicious/noArrayIndexKey: rows have no identity
      /* @__PURE__ */ React.createElement("tr", { key: r }, result.columns.map((column, c) => {
        const value = row[c] ?? null;
        return /* @__PURE__ */ React.createElement(
          "td",
          {
            key: column.name,
            "data-numeric": column.kind === "number",
            title: value ?? "null",
            style: value === null ? { color: "var(--dbx-tertiary)", fontStyle: "italic" } : void 0
          },
          formatCell(value, column.kind)
        );
      }))
    ))))
  ), /* @__PURE__ */ React.createElement(Stack, { direction: "row", align: "center", justify: "space-between", gap: 8 }, /* @__PURE__ */ React.createElement(Text, { size: "xs", tone: "subtle" }, rows.length === total ? `${total} ${total === 1 ? "row" : "rows"}` : `Showing ${rows.length} of ${total.toLocaleString()} rows`, result.truncated && rows.length === total ? " (truncated)" : ""), /* @__PURE__ */ React.createElement(CopyButton, { text: toCsv(result), label: "Copy CSV" })));
}
var W = 560;
var H = 220;
var PAD = { top: 12, right: 12, bottom: 28, left: 52 };
function ticks(min, max, count = 4) {
  if (min === max) return [min];
  const span = max - min;
  const step = 10 ** Math.floor(Math.log10(span / count));
  const nice = [1, 2, 2.5, 5, 10].map((m) => m * step).find((s) => span / s <= count) ?? step * 10;
  const start = Math.ceil(min / nice) * nice;
  const out = [];
  for (let value = start; value <= max + nice / 1e3; value += nice) out.push(Number(value.toPrecision(12)));
  return out;
}
function Legend(props) {
  if (props.names.length < 2) return null;
  return /* @__PURE__ */ React.createElement(Stack, { direction: "row", gap: 12, wrap: true }, props.names.map((name, index) => /* @__PURE__ */ React.createElement("span", { key: name, style: { display: "inline-flex", alignItems: "center", gap: 5, fontSize: "0.6875rem", color: "var(--dbx-subtle)" } }, /* @__PURE__ */ React.createElement("span", { style: { width: 8, height: 8, borderRadius: 2, background: CHART_COLORS[index % CHART_COLORS.length] } }), name)));
}
function LineChart(props) {
  const { result, plan } = props;
  const isTime = result.columns[plan.x]?.kind === "time";
  const points = result.rows.map((row) => ({
    x: isTime ? Date.parse(String(row[plan.x])) : Number(row[plan.x]),
    raw: String(row[plan.x] ?? ""),
    ys: plan.series.map((index) => Number(row[index]))
  })).filter((point) => Number.isFinite(point.x)).sort((a, b) => a.x - b.x);
  if (points.length < 2) return null;
  const xs = points.map((point) => point.x);
  const ys = points.flatMap((point) => point.ys.filter(Number.isFinite));
  const [x0, x1] = [Math.min(...xs), Math.max(...xs)];
  const [y0, y1] = [Math.min(0, ...ys), Math.max(...ys)];
  const sx = (x) => PAD.left + (x - x0) / (x1 - x0 || 1) * (W - PAD.left - PAD.right);
  const sy = (y) => H - PAD.bottom - (y - y0) / (y1 - y0 || 1) * (H - PAD.top - PAD.bottom);
  const xTicks = [points[0], points[Math.floor(points.length / 2)], points[points.length - 1]].filter(Boolean);
  return /* @__PURE__ */ React.createElement("svg", { viewBox: `0 0 ${W} ${H}`, role: "img", "aria-label": `Line chart of ${plan.series.map((i) => result.columns[i]?.name).join(", ")}`, style: { width: "100%", height: "auto" } }, ticks(y0, y1).map((tick) => /* @__PURE__ */ React.createElement("g", { key: tick }, /* @__PURE__ */ React.createElement("line", { x1: PAD.left, x2: W - PAD.right, y1: sy(tick), y2: sy(tick), stroke: "var(--dbx-border)" }), /* @__PURE__ */ React.createElement("text", { x: PAD.left - 6, y: sy(tick) + 3, textAnchor: "end", fontSize: "10", fill: "var(--dbx-subtle)" }, formatNumber(tick, "compact")))), xTicks.map((point, index) => /* @__PURE__ */ React.createElement("text", { key: point.raw, x: sx(point.x), y: H - 8, fontSize: "10", fill: "var(--dbx-subtle)", textAnchor: index === 0 ? "start" : index === xTicks.length - 1 ? "end" : "middle" }, isTime ? point.raw.slice(0, 10) : point.raw)), plan.series.map((_, s) => /* @__PURE__ */ React.createElement(
    "polyline",
    {
      key: plan.series[s],
      fill: "none",
      stroke: CHART_COLORS[s % CHART_COLORS.length],
      strokeWidth: "2",
      strokeLinejoin: "round",
      points: points.filter((p) => Number.isFinite(p.ys[s])).map((p) => `${sx(p.x)},${sy(p.ys[s])}`).join(" ")
    }
  )));
}
function BarChart(props) {
  const { result, plan } = props;
  const rows = result.rows.slice(0, 40);
  const values = rows.flatMap((row) => plan.series.map((index) => Number(row[index])).filter(Number.isFinite));
  const max = Math.max(0, ...values);
  const min = Math.min(0, ...values);
  if (plan.horizontal) {
    const rowH = 22;
    const labelW = 150;
    const height = rows.length * rowH * Math.max(1, plan.series.length * 0.6) + 8;
    const band2 = (height - 8) / rows.length;
    const scale = (v) => (v - min) / (max - min || 1) * (W - labelW - 60);
    return /* @__PURE__ */ React.createElement("svg", { viewBox: `0 0 ${W} ${height}`, role: "img", "aria-label": "Bar chart", style: { width: "100%", height: "auto" } }, rows.map((row, r) => {
      const y = 4 + r * band2;
      const label = String(row[plan.x] ?? "null");
      return /* @__PURE__ */ React.createElement("g", { key: `${label}-${r}` }, /* @__PURE__ */ React.createElement("text", { x: labelW - 8, y: y + band2 / 2 + 3, textAnchor: "end", fontSize: "10", fill: "var(--dbx-ink)" }, label.length > 24 ? `${label.slice(0, 23)}\u2026` : label), plan.series.map((index, s) => {
        const value = Number(row[index]);
        const barH = (band2 - 4) / plan.series.length;
        const w = Number.isFinite(value) ? scale(value) - scale(0) : 0;
        return /* @__PURE__ */ React.createElement("g", { key: index }, /* @__PURE__ */ React.createElement("rect", { x: labelW + Math.min(scale(0), scale(0) + w), y: y + s * barH, width: Math.abs(w), height: Math.max(2, barH - 1), rx: "2", fill: CHART_COLORS[s % CHART_COLORS.length] }, /* @__PURE__ */ React.createElement("title", null, `${label}: ${formatNumber(value)}`)), plan.series.length === 1 && /* @__PURE__ */ React.createElement("text", { x: labelW + scale(0) + Math.max(0, w) + 4, y: y + barH / 2 + 3, fontSize: "10", fill: "var(--dbx-subtle)" }, formatNumber(value, "compact")));
      }));
    }));
  }
  const band = (W - PAD.left - PAD.right) / rows.length;
  const sy = (y) => H - PAD.bottom - (y - min) / (max - min || 1) * (H - PAD.top - PAD.bottom);
  return /* @__PURE__ */ React.createElement("svg", { viewBox: `0 0 ${W} ${H}`, role: "img", "aria-label": "Bar chart", style: { width: "100%", height: "auto" } }, ticks(min, max).map((tick) => /* @__PURE__ */ React.createElement("g", { key: tick }, /* @__PURE__ */ React.createElement("line", { x1: PAD.left, x2: W - PAD.right, y1: sy(tick), y2: sy(tick), stroke: "var(--dbx-border)" }), /* @__PURE__ */ React.createElement("text", { x: PAD.left - 6, y: sy(tick) + 3, textAnchor: "end", fontSize: "10", fill: "var(--dbx-subtle)" }, formatNumber(tick, "compact")))), rows.map((row, r) => {
    const label = String(row[plan.x] ?? "null");
    const barW = band * 0.75 / plan.series.length;
    return /* @__PURE__ */ React.createElement("g", { key: `${label}-${r}` }, plan.series.map((index, s) => {
      const value = Number(row[index]);
      const top = sy(Math.max(0, value));
      const h = Math.abs(sy(value) - sy(0));
      return /* @__PURE__ */ React.createElement("rect", { key: index, x: PAD.left + r * band + band * 0.125 + s * barW, y: top, width: Math.max(1, barW - 1), height: Math.max(1, h), rx: "2", fill: CHART_COLORS[s % CHART_COLORS.length] }, /* @__PURE__ */ React.createElement("title", null, `${label}: ${formatNumber(value)}`));
    }), /* @__PURE__ */ React.createElement("text", { x: PAD.left + r * band + band / 2, y: H - 10, fontSize: "10", textAnchor: "middle", fill: "var(--dbx-subtle)" }, label.length > 10 ? `${label.slice(0, 9)}\u2026` : label));
  }));
}
function ResultChart(props) {
  const plan = props.plan ?? planChart(props.result);
  if (plan.type === "none") return null;
  if (plan.type === "kpi")
    return /* @__PURE__ */ React.createElement(Stack, { gap: 2, style: { padding: "8px 2px" } }, /* @__PURE__ */ React.createElement(Text, { size: "xs", tone: "subtle" }, plan.label), /* @__PURE__ */ React.createElement(Text, { size: "xl", weight: 600, style: { fontSize: "1.75rem", fontVariantNumeric: "tabular-nums" } }, formatNumber(plan.value)));
  const names = plan.series.map((index) => props.result.columns[index]?.name ?? "");
  return /* @__PURE__ */ React.createElement(Stack, { gap: 6 }, /* @__PURE__ */ React.createElement(Legend, { names }), plan.type === "line" ? /* @__PURE__ */ React.createElement(LineChart, { result: props.result, plan }) : /* @__PURE__ */ React.createElement(BarChart, { result: props.result, plan }));
}
function ResultView(props) {
  const plan = React.useMemo(() => planChart(props.result), [props.result]);
  const [view, setView] = React.useState(plan.type === "none" ? "table" : "chart");
  if (!props.result.columns.length) return /* @__PURE__ */ React.createElement(Text, { tone: "subtle" }, "The query returned no columns.");
  const canChart = plan.type !== "none";
  return /* @__PURE__ */ React.createElement(Stack, { gap: 8 }, canChart && /* @__PURE__ */ React.createElement(Stack, { direction: "row", gap: 4, align: "center" }, /* @__PURE__ */ React.createElement(Button, { size: "sm", variant: view === "chart" ? "default" : "ghost", onClick: () => setView("chart") }, "Chart"), /* @__PURE__ */ React.createElement(Button, { size: "sm", variant: view === "table" ? "default" : "ghost", onClick: () => setView("table") }, "Table"), props.result.truncated && /* @__PURE__ */ React.createElement(Badge, { tone: "warning" }, "Partial")), view === "chart" && canChart ? /* @__PURE__ */ React.createElement(ResultChart, { result: props.result, plan }) : /* @__PURE__ */ React.createElement(DataTable, { result: props.result, ...props.maxHeight !== void 0 && { maxHeight: props.maxHeight } }));
}

// packages/core/src/ui/markdown.tsx
var SAFE_URL = /^https?:\/\//i;
function renderInline(text, keyPrefix = "i") {
  const nodes = [];
  const pattern = /(\\[\\`*_{}[\]()#+\-.!~|<>$])|(`[^`]+`)|(\*\*[^*]+\*\*)|(__[^_]+__)|(\*[^*\s][^*]*\*)|(\[[^\]]+\]\([^)\s]+\))|(https?:\/\/[^\s)<>]+)/g;
  let last = 0;
  let match;
  let index = 0;
  while (match = pattern.exec(text)) {
    if (match.index > last) nodes.push(text.slice(last, match.index));
    const token = match[0];
    const key = `${keyPrefix}-${index++}`;
    if (token.length === 2 && token.startsWith("\\")) nodes.push(token.slice(1));
    else if (token.startsWith("`")) nodes.push(/* @__PURE__ */ React.createElement("code", { key }, token.slice(1, -1)));
    else if (token.startsWith("**") || token.startsWith("__"))
      nodes.push(/* @__PURE__ */ React.createElement("strong", { key }, renderInline(token.slice(2, -2), key)));
    else if (token.startsWith("*")) nodes.push(/* @__PURE__ */ React.createElement("em", { key }, renderInline(token.slice(1, -1), key)));
    else if (token.startsWith("[")) {
      const label = token.slice(1, token.indexOf("]("));
      const href = token.slice(token.indexOf("](") + 2, -1);
      nodes.push(
        SAFE_URL.test(href) ? /* @__PURE__ */ React.createElement("a", { key, href, target: "_blank", rel: "noreferrer", className: "dbx-link" }, label) : label
      );
    } else
      nodes.push(
        /* @__PURE__ */ React.createElement("a", { key, href: token, target: "_blank", rel: "noreferrer", className: "dbx-link" }, token)
      );
    last = match.index + token.length;
  }
  if (last < text.length) nodes.push(text.slice(last));
  return nodes;
}
var cells = (line) => line.trim().replace(/^\|/, "").replace(/\|$/, "").split("|").map((cell2) => cell2.trim());
function parseBlocks(source) {
  const lines = source.replace(/\r\n?/g, "\n").split("\n");
  const blocks = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i] ?? "";
    if (!line.trim()) {
      i++;
      continue;
    }
    const fence = /^```(\S*)/.exec(line);
    if (fence) {
      const body = [];
      i++;
      while (i < lines.length && !/^```/.test(lines[i] ?? "")) body.push(lines[i++] ?? "");
      i++;
      blocks.push({ type: "code", lang: fence[1] ?? "", code: body.join("\n") });
      continue;
    }
    const heading = /^(#{1,4})\s+(.*)$/.exec(line);
    if (heading) {
      blocks.push({ type: "h", level: heading[1]?.length ?? 1, text: heading[2] ?? "" });
      i++;
      continue;
    }
    if (/^\s*\|.*\|\s*$/.test(line) && /^\s*\|?\s*:?-{2,}/.test(lines[i + 1] ?? "")) {
      const header = cells(line);
      const rows = [];
      i += 2;
      while (i < lines.length && /^\s*\|.*\|\s*$/.test(lines[i] ?? "")) rows.push(cells(lines[i++] ?? ""));
      blocks.push({ type: "table", header, rows });
      continue;
    }
    const bullet = /^\s*[-*+]\s+/;
    const ordered = /^\s*\d+[.)]\s+/;
    if (bullet.test(line) || ordered.test(line)) {
      const type = bullet.test(line) ? "ul" : "ol";
      const marker = type === "ul" ? bullet : ordered;
      const items = [];
      while (i < lines.length && marker.test(lines[i] ?? "")) items.push((lines[i++] ?? "").replace(marker, ""));
      blocks.push({ type, items });
      continue;
    }
    const paragraph = [];
    while (i < lines.length && (lines[i] ?? "").trim() && !/^```|^#{1,4}\s|^\s*[-*+]\s+|^\s*\d+[.)]\s+/.test(lines[i] ?? ""))
      paragraph.push(lines[i++] ?? "");
    blocks.push({ type: "p", text: paragraph.join("\n") });
  }
  return blocks;
}
function Markdown(props) {
  const blocks = React.useMemo(() => parseBlocks(props.source), [props.source]);
  return /* @__PURE__ */ React.createElement("div", { className: "dbx-md", style: { fontSize: props.size === "sm" ? "0.75rem" : "0.8125rem", lineHeight: 1.55 } }, blocks.map((block, index) => {
    const key = `b${index}`;
    switch (block.type) {
      case "p":
        return /* @__PURE__ */ React.createElement("p", { key, style: { whiteSpace: "pre-wrap" } }, renderInline(block.text, key));
      case "h":
        return /* @__PURE__ */ React.createElement("p", { key, style: { fontWeight: 600, fontSize: block.level <= 2 ? "0.9375rem" : void 0 } }, renderInline(block.text, key));
      case "ul":
      case "ol":
        return React.createElement(
          block.type,
          { key },
          block.items.map((item, n) => /* @__PURE__ */ React.createElement("li", { key: `${key}-${n}` }, renderInline(item, `${key}-${n}`)))
        );
      case "code":
        return /* @__PURE__ */ React.createElement("pre", { key }, /* @__PURE__ */ React.createElement("code", null, block.code));
      case "table":
        return /* @__PURE__ */ React.createElement("div", { key, style: { overflow: "auto", margin: "0 0 8px" } }, /* @__PURE__ */ React.createElement("table", { className: "dbx-table" }, /* @__PURE__ */ React.createElement("thead", null, /* @__PURE__ */ React.createElement("tr", null, block.header.map((cell2, n) => /* @__PURE__ */ React.createElement("th", { key: `${key}-h${n}` }, renderInline(cell2))))), /* @__PURE__ */ React.createElement("tbody", null, block.rows.map((row, r) => /* @__PURE__ */ React.createElement("tr", { key: `${key}-r${r}` }, row.map((cell2, n) => /* @__PURE__ */ React.createElement("td", { key: `${key}-r${r}-${n}` }, renderInline(cell2))))))));
    }
    return null;
  }));
}

// plugins/genie/src/chat.tsx
var STEPS = ["FETCHING_METADATA", "FILTERING_CONTEXT", "ASKING_AI", "PENDING_WAREHOUSE", "EXECUTING_QUERY"];
function turnMarkdown(space, turn, link) {
  const parts = [`**${space.title}** \xB7 _${turn.question}_`];
  if (turn.text) parts.push(turn.text);
  if (turn.result?.columns.length) parts.push(toMarkdown(turn.result, 15));
  if (turn.sql) parts.push(`\`\`\`sql
${turn.sql.trim()}
\`\`\``);
  if (link) parts.push(`[Open in Genie](${link})`);
  return parts.join("\n\n");
}
function Progress(props) {
  const index = STEPS.indexOf(props.status);
  return /* @__PURE__ */ React.createElement(Stack, { direction: "row", gap: 10, align: "center" }, /* @__PURE__ */ React.createElement(Spinner, { size: 13 }), /* @__PURE__ */ React.createElement(Text, { tone: "subtle", size: "sm" }, STATUS_LABEL[props.status] ?? "Thinking", "\u2026"), /* @__PURE__ */ React.createElement(Stack, { direction: "row", gap: 3, align: "center", style: { marginLeft: 4 } }, STEPS.map((step, n) => /* @__PURE__ */ React.createElement(
    "span",
    {
      key: step,
      style: {
        width: 14,
        height: 3,
        borderRadius: 2,
        background: n <= index ? "var(--dbx-lava)" : "var(--dbx-border)",
        transition: "background-color 200ms ease"
      }
    }
  ))));
}
function TurnView(props) {
  const { turn } = props;
  const status = turn.message?.status ?? "SUBMITTED";
  const done = TERMINAL.has(status) || Boolean(turn.error);
  return /* @__PURE__ */ React.createElement(Stack, { gap: 10 }, /* @__PURE__ */ React.createElement(Stack, { direction: "row", gap: 8, align: "flex-start" }, /* @__PURE__ */ React.createElement(
    "span",
    {
      "aria-hidden": true,
      style: {
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
        color: "var(--dbx-subtle)"
      }
    },
    "?"
  ), /* @__PURE__ */ React.createElement(Text, { weight: 500, style: { paddingTop: 2 } }, turn.question)), /* @__PURE__ */ React.createElement(
    "div",
    {
      className: "dbx-card",
      style: { padding: props.compact ? 12 : 16, marginLeft: props.compact ? 0 : 30, display: "flex", flexDirection: "column", gap: 12 }
    },
    !done && /* @__PURE__ */ React.createElement(Progress, { status }),
    turn.error && /* @__PURE__ */ React.createElement(Notice, { tone: "danger", title: "Genie couldn't answer" }, turn.error),
    status === "FAILED" && !turn.error && /* @__PURE__ */ React.createElement(Notice, { tone: "danger", title: "Genie couldn't answer" }, turn.message?.error?.error ?? "The request failed."),
    turn.text && /* @__PURE__ */ React.createElement(Markdown, { source: turn.text }),
    turn.result && /* @__PURE__ */ React.createElement(ResultView, { result: turn.result, maxHeight: props.compact ? 200 : 320 }),
    turn.loadingResult && /* @__PURE__ */ React.createElement(Stack, { direction: "row", gap: 8, align: "center" }, /* @__PURE__ */ React.createElement(Spinner, { size: 12 }), /* @__PURE__ */ React.createElement(Text, { tone: "subtle", size: "sm" }, "Loading the result\u2026")),
    done && turn.sql && !turn.result && !turn.loadingResult && props.onLoadResult && /* @__PURE__ */ React.createElement("div", null, /* @__PURE__ */ React.createElement(Button, { size: "sm", onClick: props.onLoadResult }, "Show result")),
    turn.sql && /* @__PURE__ */ React.createElement(Disclosure, { summary: turn.queryTitle ? `SQL \xB7 ${turn.queryTitle}` : "SQL Genie wrote" }, /* @__PURE__ */ React.createElement(CodeView, { code: turn.sql.trim() })),
    done && turn.suggestions.length > 0 && props.onSuggestion && /* @__PURE__ */ React.createElement(Stack, { direction: "row", gap: 6, wrap: true }, turn.suggestions.slice(0, 4).map((suggestion) => /* @__PURE__ */ React.createElement(Button, { key: suggestion, size: "sm", variant: "ghost", onClick: () => props.onSuggestion?.(suggestion), style: { border: "1px solid var(--dbx-border)" } }, suggestion))),
    done && props.actions
  ));
}
function fromMessage(message) {
  const parts = summarize(message);
  return {
    key: messageId(message),
    question: message.content,
    message,
    suggestions: parts.suggestions,
    ...parts.text && { text: parts.text },
    ...parts.sql && { sql: parts.sql },
    ...parts.queryTitle && { queryTitle: parts.queryTitle },
    ...parts.error && { error: parts.error }
  };
}
function useGenieConversation(service, spaceId, initialConversation) {
  const [conversationId, setConversationId] = React.useState(initialConversation);
  const [turns, setTurns] = React.useState([]);
  const [busy, setBusy] = React.useState(false);
  const [historyError, setHistoryError] = React.useState();
  const abort = React.useRef(void 0);
  React.useEffect(() => {
    setTurns([]);
    setConversationId(initialConversation);
    setHistoryError(void 0);
    if (!initialConversation) return;
    const controller = new AbortController();
    void (async () => {
      try {
        const client = await service.ready(controller.signal);
        const response = await client.get(
          `/api/2.0/genie/spaces/${encodeURIComponent(spaceId)}/conversations/${encodeURIComponent(initialConversation)}/messages`,
          { query: { page_size: 50 }, signal: controller.signal }
        );
        const messages = [...response.messages ?? []].map((message) => ({ ...message, conversation_id: initialConversation })).sort((a, b) => (a.created_timestamp ?? 0) - (b.created_timestamp ?? 0));
        if (!controller.signal.aborted) setTurns(messages.map(fromMessage));
      } catch (error) {
        if (!controller.signal.aborted) setHistoryError(describeError(error));
      }
    })();
    return () => controller.abort();
  }, [service, spaceId, initialConversation]);
  React.useEffect(() => () => abort.current?.abort(), []);
  const update = (key, change) => setTurns((current) => current.map((turn) => turn.key === key ? { ...turn, ...change } : turn));
  const loadResult = async (key) => {
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
  const ask = async (question) => {
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
        ...conversationId && { conversationId },
        signal: controller.signal,
        onUpdate: (message) => {
          const id = messageId(message) || current;
          const previous = current;
          setTurns((existing) => existing.map((turn) => turn.key === previous ? { ...turn, key: id, message } : turn));
          current = id;
          if (message.conversation_id) setConversationId(message.conversation_id);
        }
      });
      setConversationId(answer.message.conversation_id);
      update(current, {
        message: answer.message,
        suggestions: answer.suggestions,
        ...answer.text && { text: answer.text },
        ...answer.sql && { sql: answer.sql },
        ...answer.queryTitle && { queryTitle: answer.queryTitle },
        ...answer.result && { result: answer.result },
        ...answer.error && { error: answer.error }
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
    setConversationId(void 0);
  };
  return { turns, busy, ask, reset, loadResult, conversationId, historyError };
}
function Composer(props) {
  const [text, setText] = React.useState("");
  const submit = () => {
    if (!text.trim() || props.busy) return;
    props.onAsk(text);
    setText("");
  };
  return /* @__PURE__ */ React.createElement(
    "form",
    {
      onSubmit: (event) => {
        event.preventDefault();
        submit();
      },
      style: { display: "flex", gap: 8, alignItems: "flex-end" }
    },
    /* @__PURE__ */ React.createElement(
      "textarea",
      {
        className: "dbx-textarea",
        rows: 2,
        value: text,
        autoFocus: props.autoFocus,
        placeholder: props.placeholder ?? "Ask a question about your data",
        onChange: (event) => setText(event.target.value),
        onKeyDown: (event) => {
          if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
            event.preventDefault();
            submit();
          }
        },
        style: { flex: 1, minHeight: 44 },
        "aria-label": "Question for Genie"
      }
    ),
    /* @__PURE__ */ React.createElement(Button, { type: "submit", variant: "primary", disabled: !text.trim() || props.busy }, props.busy ? /* @__PURE__ */ React.createElement(Spinner, { size: 12, label: "Asking" }) : null, "Ask")
  );
}
function GenieChat(props) {
  const { service, space } = props;
  const chat = useGenieConversation(service, space.space_id, props.conversationId);
  const bottom = React.useRef(null);
  React.useEffect(() => {
    bottom.current?.scrollIntoView({ block: "end", behavior: "smooth" });
  }, [chat.turns.length, chat.turns[chat.turns.length - 1]?.message?.status]);
  const link = service.workspaceUrl(Genie.webPath(space.space_id, chat.conversationId));
  return /* @__PURE__ */ React.createElement(Stack, { gap: 16, style: { minHeight: 0, flex: 1 } }, !props.compact && /* @__PURE__ */ React.createElement(Stack, { direction: "row", align: "flex-start", justify: "space-between", gap: 12 }, /* @__PURE__ */ React.createElement(Stack, { gap: 4, style: { minWidth: 0 } }, /* @__PURE__ */ React.createElement(Stack, { direction: "row", gap: 8, align: "center" }, /* @__PURE__ */ React.createElement(DatabricksMark, { size: 16 }), /* @__PURE__ */ React.createElement(Text, { as: "h2", size: "lg", weight: 500 }, space.title), /* @__PURE__ */ React.createElement(Badge, { tone: "brand" }, "Genie")), space.description && /* @__PURE__ */ React.createElement(Text, { tone: "subtle", size: "sm", as: "div", style: { maxWidth: 680 } }, space.description)), /* @__PURE__ */ React.createElement(Stack, { direction: "row", gap: 6 }, chat.turns.length > 0 && /* @__PURE__ */ React.createElement(Button, { variant: "ghost", onClick: chat.reset }, "New chat"), link && /* @__PURE__ */ React.createElement(Button, { variant: "ghost", onClick: () => window.open(link, "_blank", "noopener") }, "Open in Databricks"))), chat.historyError && /* @__PURE__ */ React.createElement(Notice, { tone: "warning", title: "Couldn't load this conversation" }, chat.historyError), /* @__PURE__ */ React.createElement(Stack, { gap: 22, style: { flex: 1 } }, chat.turns.length === 0 && !props.compact && /* @__PURE__ */ React.createElement(Stack, { gap: 10, style: { padding: "24px 0" } }, /* @__PURE__ */ React.createElement(Text, { tone: "subtle" }, "Ask a question in plain language. Genie writes the SQL, runs it with your access, and charts the answer."), /* @__PURE__ */ React.createElement(Stack, { direction: "row", gap: 6, wrap: true }, ["What data can I ask about?", "What are the key metrics here?", "Show the trend over the last 12 months"].map((example) => /* @__PURE__ */ React.createElement(Button, { key: example, size: "sm", variant: "ghost", style: { border: "1px solid var(--dbx-border)" }, onClick: () => void chat.ask(example) }, example)))), chat.turns.map((turn) => /* @__PURE__ */ React.createElement(
    TurnView,
    {
      key: turn.key,
      turn,
      ...props.compact !== void 0 && { compact: props.compact },
      onSuggestion: (question) => void chat.ask(question),
      onLoadResult: () => void chat.loadResult(turn.key),
      actions: /* @__PURE__ */ React.createElement(Stack, { direction: "row", gap: 6 }, /* @__PURE__ */ React.createElement(CopyButton, { text: turnMarkdown(space, turn, link), label: "Copy answer" }), props.answerActions?.(turn))
    }
  )), /* @__PURE__ */ React.createElement("div", { ref: bottom })), /* @__PURE__ */ React.createElement("div", { style: { position: "sticky", bottom: 0, background: "var(--surface-panel, var(--dbx-surface))", paddingTop: 8 } }, /* @__PURE__ */ React.createElement(Composer, { onAsk: (question) => void chat.ask(question), busy: chat.busy, placeholder: `Ask ${space.title}`, autoFocus: !props.compact })));
}

// packages/core/src/api/mcp.ts
var PROTOCOL_VERSION = "2025-06-18";
var McpError = class extends Error {
  constructor(message, code, data) {
    super(message);
    this.code = code;
    this.data = data;
    this.name = "McpError";
  }
};
var gatewayMcpPath = (fullName) => `/ai-gateway/mcp-services/${fullName}`;
var McpClient = class {
  constructor(client, path, query = {}) {
    this.client = client;
    this.path = path;
    this.query = query;
  }
  session;
  initializing;
  nextId = 1;
  toolsCache;
  serverInfo;
  instructions;
  async listTools(signal) {
    if (this.toolsCache && Date.now() - this.toolsCache.at < 5 * 6e4) return this.toolsCache.tools;
    const tools = [];
    let cursor;
    do {
      const page = await this.call("tools/list", cursor ? { cursor } : {}, signal);
      tools.push(...page.tools ?? []);
      cursor = page.nextCursor;
    } while (cursor);
    this.toolsCache = { at: Date.now(), tools };
    return tools;
  }
  callTool(name, args, options = {}) {
    return this.call(
      "tools/call",
      { name, arguments: args, ...options.meta && { _meta: options.meta } },
      options.signal,
      options.timeoutMs
    );
  }
  async readResource(uri, signal) {
    return await this.call("resources/read", { uri }, signal);
  }
  async ensureSession(signal) {
    if (this.session) return;
    this.initializing ??= (async () => {
      const result = await this.send(
        {
          jsonrpc: "2.0",
          id: this.nextId++,
          method: "initialize",
          params: {
            protocolVersion: PROTOCOL_VERSION,
            capabilities: {},
            clientInfo: { name: "databricks-buzz-plugins", version: "0.1.0" }
          }
        },
        signal,
        true
      );
      this.serverInfo = result?.serverInfo;
      this.instructions = result?.instructions;
      await this.send({ jsonrpc: "2.0", method: "notifications/initialized" }, signal).catch(() => {
      });
    })().finally(() => {
      this.initializing = void 0;
    });
    await this.initializing;
  }
  async call(method, params, signal, timeoutMs) {
    await this.ensureSession(signal);
    try {
      return await this.send({ jsonrpc: "2.0", id: this.nextId++, method, params }, signal, false, timeoutMs);
    } catch (error) {
      if (error.status === 404 && this.session) {
        this.session = void 0;
        await this.ensureSession(signal);
        return this.send({ jsonrpc: "2.0", id: this.nextId++, method, params }, signal, false, timeoutMs);
      }
      throw error;
    }
  }
  async send(message, signal, initializing = false, timeoutMs = 12e4) {
    const response = await this.client.request(this.path, {
      method: "POST",
      query: this.query,
      body: message,
      timeoutMs,
      ...signal && { signal },
      headers: {
        Accept: "application/json, text/event-stream",
        ...!initializing && { "MCP-Protocol-Version": PROTOCOL_VERSION },
        ...this.session && { "Mcp-Session-Id": this.session }
      }
    });
    const session = response.headers["mcp-session-id"];
    if (session) this.session = session;
    if (message.id === void 0) return void 0;
    if (response.status === 202) return void 0;
    if (response.status < 200 || response.status >= 300) throw apiError(response);
    const type = response.headers["content-type"] ?? "";
    const payloads = type.includes("text/event-stream") ? parseSse(response.body).map((event) => event.data) : [response.body];
    for (const payload of payloads) {
      let parsed;
      try {
        parsed = JSON.parse(payload);
      } catch {
        continue;
      }
      if (parsed.id !== message.id) continue;
      if (parsed.error)
        throw new McpError(parsed.error.message ?? "MCP error", parsed.error.code, parsed.error.data);
      return parsed.result;
    }
    throw new McpError(`No response to ${message.method}`);
  }
};
function resultText(result) {
  return (result.content ?? []).map((item) => item.type === "text" ? String(item.text) : "").filter(Boolean).join("\n\n");
}
function resultJson(result) {
  if (result.structuredContent !== void 0) return result.structuredContent;
  for (const item of result.content ?? []) {
    if (item.type !== "text") continue;
    const text = String(item.text).trim();
    if (!text.startsWith("{") && !text.startsWith("[")) continue;
    try {
      return JSON.parse(text);
    } catch {
    }
  }
  return void 0;
}

// plugins/genie/src/genie-one.ts
var GENIE_ONE = "system.ai.genie_one_mcp";
var POLL_MS = 3e3;
var MAX_RESULTS = 3;
var cell = (value) => value === null || value === void 0 ? null : typeof value === "object" ? JSON.stringify(value) : String(value);
function toResultSet(result) {
  if (!result.ready || !result.columns?.length) return void 0;
  const rows = (result.rows ?? []).map((row) => row.map(cell));
  const total = result.total_row_count ?? void 0;
  return resultSet(
    result.columns.map((column) => ({ name: column.name, ...column.type_text && { type: column.type_text } })),
    rows,
    {
      ...total !== void 0 && { totalRows: total },
      truncated: Boolean(result.truncated) || total !== void 0 && total > rows.length
    }
  );
}
var stripComments = (markdown) => markdown.replace(/<!--[\s\S]*?--\s*>/g, "").replace(/\n{3,}/g, "\n\n").trim();
function cleanAnswer(text) {
  return stripComments(text).replace(/\s*:citation\[[^\]]*\]/g, "").replace(/\s*\[Query Result\]\([^)\s]*#embed-[^)\s]*\)/g, "").replace(/`([^`]+)`\s*\[\1\]\(/g, "[$1](").replace(/[ \t]+$/gm, "").trim();
}
var sleep = (ms, signal) => new Promise((resolve, reject) => {
  const timer = setTimeout(resolve, ms);
  signal?.addEventListener(
    "abort",
    () => {
      clearTimeout(timer);
      reject(signal.reason);
    },
    { once: true }
  );
});
var GenieOne = class {
  constructor(service) {
    this.service = service;
  }
  clients = /* @__PURE__ */ new Map();
  availability = /* @__PURE__ */ new Map();
  async mcp() {
    const client = await this.service.ready();
    const snapshot = this.service.snapshot();
    const workspaceId = snapshot.status === "connected" ? snapshot.workspaceId ?? snapshot.profile.workspaceId : void 0;
    const key = `${client.host}|${workspaceId ?? ""}`;
    let mcp = this.clients.get(key);
    if (!mcp) {
      mcp = new McpClient(client, gatewayMcpPath(GENIE_ONE), workspaceId ? { o: workspaceId } : {});
      this.clients.set(key, mcp);
    }
    return mcp;
  }
  /** Whether Genie One answers in this workspace for this user. */
  available() {
    const snapshot = this.service.snapshot();
    const key = snapshot.status === "connected" ? snapshot.profile.host : "none";
    let check = this.availability.get(key);
    if (!check) {
      check = this.mcp().then((mcp) => mcp.listTools()).then((tools) => tools.some((tool) => tool.name === "genie_ask")).catch(() => false).then((ok) => {
        if (!ok) this.availability.delete(key);
        return ok;
      });
      this.availability.set(key, check);
    }
    return check;
  }
  async ask(question, options = {}) {
    const { signal } = options;
    const mcp = await this.mcp();
    const asked = await mcp.callTool(
      "genie_ask",
      { question, ...options.conversationId && { conversation_id: options.conversationId } },
      { ...signal && { signal }, timeoutMs: 17e4 }
    );
    if (asked.isError) throw new Error(resultText(asked) || "Genie One couldn't take the question.");
    const started = resultJson(asked) ?? {};
    const conversationId = started.conversation_id ?? options.conversationId ?? "";
    const responseId = started.response_id ?? "";
    if (!conversationId || !responseId) throw new Error("Genie One didn't return a conversation.");
    let state = started;
    let markdown = resultText(asked);
    let unknowns = 0;
    let steps = [];
    const deadline = Date.now() + 10 * 6e4;
    try {
      while (!state.status || state.status === "in_progress" || state.status === "unknown" && unknowns < 5) {
        if (Date.now() > deadline) throw new Error("Genie One didn't finish within 10 minutes.");
        await sleep(POLL_MS, signal);
        const polled = await mcp.callTool(
          "genie_poll_response",
          { conversation_id: conversationId, response_id: responseId },
          { ...signal && { signal }, timeoutMs: 6e4 }
        );
        if (polled.isError) throw new Error(resultText(polled) || "Genie One failed.");
        state = resultJson(polled) ?? { status: "unknown" };
        markdown = resultText(polled);
        unknowns = state.status === "unknown" ? unknowns + 1 : 0;
        if (state.progress_steps?.length) {
          steps = state.progress_steps;
          options.onProgress?.(steps);
        }
      }
    } catch (error) {
      if (signal?.aborted)
        void mcp.callTool("genie_cancel_response", { conversation_id: conversationId }).catch(() => void 0);
      throw error;
    }
    if (state.status === "failed") throw new Error(markdown.trim() || "Genie One couldn't answer that.");
    const items = (state.query_items ?? []).slice(0, MAX_RESULTS);
    const results = (await Promise.all(
      items.map(
        (item) => mcp.callTool(
          "genie_get_query_result",
          { conversation_id: conversationId, response_id: responseId, item_id: item.item_id },
          { ...signal && { signal }, timeoutMs: 6e4 }
        ).then((fetched) => fetched.isError ? void 0 : toResultSet(resultJson(fetched) ?? {})).catch(() => void 0)
      )
    )).filter((result) => result !== void 0);
    return {
      conversationId,
      responseId,
      status: state.status ?? "completed",
      text: (state.final_answer ?? "").trim(),
      markdown: markdown.trim(),
      steps,
      results,
      sql: items.flatMap((item) => item.sql ? [item.sql] : []),
      ...state.deep_link && { deepLink: state.deep_link }
    };
  }
  /** Plain text for agents: the answer (with its tables and links), the SQL and the deep link. */
  format(answer) {
    const lines = ["Genie One", `conversation_id: ${answer.conversationId}`];
    if (answer.status === "incomplete") lines.push("(Genie One stopped before finishing; the answer may be partial.)");
    const text = cleanAnswer(answer.text);
    if (text) lines.push("", text);
    else for (const result of answer.results) lines.push("", toMarkdown(result, 20));
    for (const statement of answer.sql.slice(0, 2)) lines.push("", "SQL Genie One ran:", "```sql", statement.trim(), "```");
    if (answer.deepLink) lines.push("", `[Explore in Databricks](${answer.deepLink})`);
    return lines.join("\n");
  }
};

// plugins/genie/src/genie-one-chat.tsx
function parseStep(raw) {
  const clean = (text) => stripComments(text).replace(/\s*\|.*\|\s*$/s, "").trim();
  const match = /^(Thinking|Running SQL|Query result|[A-Z][\w ]{1,24}):\s*(.*)$/s.exec(raw.trim());
  if (!match) return { kind: "other", text: clean(raw) };
  const [, label = "", rest = ""] = match;
  if (label === "Thinking") return { kind: "thought", text: clean(rest.replace(/^Genie:\s*none\s*[—-]\s*/i, "")) };
  if (label === "Running SQL") return { kind: "sql", text: rest.trim() };
  if (label === "Query result") return { kind: "result", text: clean(rest).replace(/:$/, "") };
  return { kind: "other", text: clean(`${label}: ${rest}`) };
}
var plain = (cell2) => cell2.replace(/\*\*|__|`/g, "").trim();
function answerParts(answer) {
  const text = cleanAnswer(answer.text);
  const lines = text.split("\n");
  const kept = [];
  const tables = [];
  const row = /^\s*\|.*\|\s*$/;
  for (let i = 0; i < lines.length; i++) {
    if (row.test(lines[i] ?? "") && /^\s*\|?\s*:?-{2,}/.test(lines[i + 1] ?? "")) {
      const table = [];
      while (i < lines.length && row.test(lines[i] ?? "")) table.push(lines[i++] ?? "");
      i--;
      tables.push(table);
      continue;
    }
    kept.push(lines[i] ?? "");
  }
  if (!tables.length) return { text, results: answer.results };
  const parsed = answer.results.length ? answer.results : tables.flatMap((table) => {
    const block = parseBlocks(table.join("\n")).find((candidate) => candidate.type === "table");
    if (!block || block.type !== "table") return [];
    return [resultSet(block.header.map((name) => ({ name: plain(name) })), block.rows.map((cells2) => cells2.map((cell2) => plain(cell2) || null)))];
  });
  return { text: kept.join("\n").replace(/\n{3,}/g, "\n\n").trim(), results: parsed };
}
function formatSql(sql) {
  if (sql.includes("\n")) return sql.trim();
  return sql.trim().replace(/\s+(FROM|WHERE|GROUP BY|HAVING|ORDER BY|LIMIT|QUALIFY|UNION ALL|UNION|(?:LEFT |RIGHT |FULL |INNER |CROSS )?JOIN)\s+/gi, (_, clause) => `
${clause.toUpperCase()} `).replace(/^(SELECT\s+)(.+?)(?=\nFROM)/is, (_, select, list) => {
    const items = list.split(/,\s+(?![^()]*\))/);
    return items.length > 2 ? `${select.trim()}
  ${items.join(",\n  ")}` : `${select}${list}`;
  });
}
var seconds = (turn) => Math.max(1, Math.round(((turn.finished ?? Date.now()) - turn.started) / 1e3));
function Timeline(props) {
  const steps = props.steps.map(parseStep);
  return /* @__PURE__ */ React.createElement("ol", { style: { listStyle: "none", margin: 0, padding: 0, display: "flex", flexDirection: "column", gap: 10 } }, steps.map((step, index) => {
    const last = index === steps.length - 1;
    return /* @__PURE__ */ React.createElement("li", { key: `${index}-${step.kind}`, style: { display: "flex", gap: 10, alignItems: "flex-start" } }, /* @__PURE__ */ React.createElement("span", { style: { width: 14, display: "inline-flex", justifyContent: "center", paddingTop: 4, flex: "none" } }, props.live && last ? /* @__PURE__ */ React.createElement(Spinner, { size: 11 }) : /* @__PURE__ */ React.createElement(
      "span",
      {
        "aria-hidden": true,
        style: {
          width: 7,
          height: 7,
          borderRadius: "50%",
          background: step.kind === "sql" ? "var(--dbx-lava)" : "var(--dbx-border-strong)"
        }
      }
    )), /* @__PURE__ */ React.createElement(Stack, { gap: 4, style: { minWidth: 0, flex: 1 } }, /* @__PURE__ */ React.createElement(Text, { size: "xs", tone: "tertiary", weight: 500 }, { thought: "Thinking", sql: "Ran SQL", result: "Result", other: "Step" }[step.kind]), step.kind === "sql" ? /* @__PURE__ */ React.createElement(CodeView, { code: formatSql(step.text), maxHeight: 180, copy: false }) : /* @__PURE__ */ React.createElement(Text, { size: "sm", tone: "subtle", as: "div" }, step.text)));
  }), props.live && !steps.length && /* @__PURE__ */ React.createElement("li", { style: { display: "flex", gap: 10, alignItems: "center" } }, /* @__PURE__ */ React.createElement(Spinner, { size: 11 }), /* @__PURE__ */ React.createElement(Text, { size: "sm", tone: "subtle" }, "Finding the right data\u2026")));
}
function oneTurnMarkdown(turn) {
  const answer = turn.answer;
  if (!answer) return "";
  const parts = [`**Genie One** \xB7 _${turn.question}_`, cleanAnswer(answer.text)];
  if (answer.deepLink) parts.push(`[Explore in Databricks](${answer.deepLink})`);
  return parts.filter(Boolean).join("\n\n");
}
function OneTurnView(props) {
  const { turn } = props;
  const answer = turn.answer;
  const live = !answer && !turn.error;
  const parts = React.useMemo(() => answer ? answerParts(answer) : void 0, [answer]);
  const [, tick] = React.useState(0);
  React.useEffect(() => {
    if (!live) return;
    const timer = setInterval(() => tick((n) => n + 1), 1e3);
    return () => clearInterval(timer);
  }, [live]);
  return /* @__PURE__ */ React.createElement(Stack, { gap: 10 }, /* @__PURE__ */ React.createElement(Text, { weight: 500 }, turn.question), /* @__PURE__ */ React.createElement("div", { className: "dbx-card", style: { padding: props.compact ? 12 : 16, display: "flex", flexDirection: "column", gap: 14 } }, live ? /* @__PURE__ */ React.createElement(Stack, { gap: 10 }, /* @__PURE__ */ React.createElement(Text, { size: "sm", tone: "subtle" }, "Thinking \xB7 ", seconds(turn), "s"), /* @__PURE__ */ React.createElement(Timeline, { steps: turn.steps, live: true })) : turn.steps.length > 0 && /* @__PURE__ */ React.createElement(Disclosure, { summary: `Thought for ${seconds(turn)}s \xB7 ${turn.steps.length} ${turn.steps.length === 1 ? "step" : "steps"}` }, /* @__PURE__ */ React.createElement(Timeline, { steps: turn.steps, live: false })), turn.error && /* @__PURE__ */ React.createElement(Notice, { tone: "danger", title: "Genie One couldn't answer" }, turn.error), answer?.status === "incomplete" && /* @__PURE__ */ React.createElement(Notice, { tone: "warning", title: "Genie One stopped early" }, "The answer may be partial."), parts?.text && /* @__PURE__ */ React.createElement(Markdown, { source: parts.text }), parts && parts.results.length > 0 && // The last query is the one the answer describes; earlier ones are drafts.
  /* @__PURE__ */ React.createElement(ResultView, { result: parts.results[parts.results.length - 1], maxHeight: props.compact ? 200 : 320 }), parts && parts.results.length > 1 && /* @__PURE__ */ React.createElement(Disclosure, { summary: `Earlier results (${parts.results.length - 1})` }, /* @__PURE__ */ React.createElement(Stack, { gap: 12 }, parts.results.slice(0, -1).map((result, index) => /* @__PURE__ */ React.createElement(ResultView, { key: index, result, maxHeight: 240 })))), answer && answer.sql.length > 0 && /* @__PURE__ */ React.createElement(Disclosure, { summary: answer.sql.length === 1 ? "SQL Genie One ran" : `SQL Genie One ran (${answer.sql.length})` }, /* @__PURE__ */ React.createElement(Stack, { gap: 8 }, answer.sql.map((statement, index) => /* @__PURE__ */ React.createElement(CodeView, { key: index, code: formatSql(statement) })))), answer && /* @__PURE__ */ React.createElement(Stack, { direction: "row", gap: 6, wrap: true }, answer.deepLink && /* @__PURE__ */ React.createElement(Button, { size: "sm", onClick: () => window.open(answer.deepLink, "_blank", "noopener") }, "Explore in Databricks"), props.actions)));
}
function useGenieOneConversation(genieOne) {
  const [conversationId, setConversationId] = React.useState();
  const [turns, setTurns] = React.useState([]);
  const [busy, setBusy] = React.useState(false);
  const abort = React.useRef(void 0);
  React.useEffect(() => () => abort.current?.abort(), []);
  const update = (key, change) => setTurns((current) => current.map((turn) => turn.key === key ? { ...turn, ...change } : turn));
  const ask = async (question) => {
    const text = question.trim();
    if (!text || busy) return;
    const controller = new AbortController();
    abort.current = controller;
    const key = `one-${Date.now()}`;
    setTurns((existing) => [...existing, { key, question: text, steps: [], started: Date.now() }]);
    setBusy(true);
    try {
      const answer = await genieOne.ask(text, {
        ...conversationId && { conversationId },
        signal: controller.signal,
        onProgress: (steps) => update(key, { steps: [...steps] })
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
    setTurns((current) => current.map((turn) => turn.answer || turn.error ? turn : { ...turn, error: "Stopped.", finished: Date.now() }));
  };
  const reset = () => {
    abort.current?.abort();
    setBusy(false);
    setTurns([]);
    setConversationId(void 0);
  };
  return { turns, busy, ask, stop, reset, conversationId };
}
var EXAMPLES = ["What data do I have access to?", "Which tables are used the most?", "What changed in the last week?"];
function GenieOneChat(props) {
  const chat = useGenieOneConversation(props.genieOne);
  const bottom = React.useRef(null);
  const last = chat.turns[chat.turns.length - 1];
  React.useEffect(() => {
    bottom.current?.scrollIntoView({ block: "end", behavior: "smooth" });
  }, [chat.turns.length, last?.steps.length, Boolean(last?.answer)]);
  return /* @__PURE__ */ React.createElement(Stack, { gap: 16, style: { minHeight: 0, flex: 1 } }, !props.compact && /* @__PURE__ */ React.createElement(Stack, { direction: "row", align: "flex-start", justify: "space-between", gap: 12 }, /* @__PURE__ */ React.createElement(Stack, { gap: 4, style: { minWidth: 0 } }, /* @__PURE__ */ React.createElement(Stack, { direction: "row", gap: 8, align: "center" }, /* @__PURE__ */ React.createElement(DatabricksMark, { size: 16 }), /* @__PURE__ */ React.createElement(Text, { as: "h2", size: "lg", weight: 500 }, "Genie One"), /* @__PURE__ */ React.createElement(Badge, { tone: "brand" }, "All your data")), /* @__PURE__ */ React.createElement(Text, { tone: "subtle", size: "sm", as: "div", style: { maxWidth: 680 } }, "Ask anything about data you can access in this workspace. Genie One finds the right tables and Genie agents, writes the SQL and runs it as you.")), /* @__PURE__ */ React.createElement(Stack, { direction: "row", gap: 6 }, chat.busy && /* @__PURE__ */ React.createElement(Button, { variant: "ghost", onClick: chat.stop }, "Stop"), chat.turns.length > 0 && /* @__PURE__ */ React.createElement(Button, { variant: "ghost", onClick: chat.reset }, "New chat"))), /* @__PURE__ */ React.createElement(Stack, { gap: 22, style: { flex: 1 } }, chat.turns.length === 0 && !props.compact && /* @__PURE__ */ React.createElement(Stack, { gap: 10, style: { padding: "24px 0" } }, /* @__PURE__ */ React.createElement(Text, { tone: "subtle" }, "Genie One usually answers in under a minute and shows its work as it goes."), /* @__PURE__ */ React.createElement(Stack, { direction: "row", gap: 6, wrap: true }, EXAMPLES.map((example) => /* @__PURE__ */ React.createElement(Button, { key: example, size: "sm", variant: "ghost", style: { border: "1px solid var(--dbx-border)" }, onClick: () => void chat.ask(example) }, example)))), chat.turns.map((turn) => /* @__PURE__ */ React.createElement(
    OneTurnView,
    {
      key: turn.key,
      turn,
      ...props.compact !== void 0 && { compact: props.compact },
      actions: turn.answer && /* @__PURE__ */ React.createElement(React.Fragment, null, /* @__PURE__ */ React.createElement(CopyButton, { text: oneTurnMarkdown(turn), label: "Copy answer" }), props.answerActions?.(turn))
    }
  )), /* @__PURE__ */ React.createElement("div", { ref: bottom })), /* @__PURE__ */ React.createElement("div", { style: { position: "sticky", bottom: 0, background: "var(--surface-panel, var(--dbx-surface))", paddingTop: 8 } }, /* @__PURE__ */ React.createElement(Composer, { onAsk: (question) => void chat.ask(question), busy: chat.busy, placeholder: "Ask Genie One about any of your data", autoFocus: !props.compact })));
}

// plugins/genie/src/page.tsx
var SpacesStore = class {
  constructor(service) {
    this.service = service;
    service.subscribe(() => {
      const snapshot = service.snapshot();
      const host = snapshot.status === "connected" ? snapshot.profile.host : void 0;
      if (host !== this.host) {
        this.host = host;
        this.set({ status: "idle", spaces: [] });
        if (host && this.listeners.size) void this.load();
      }
    });
  }
  state = { status: "idle", spaces: [] };
  listeners = /* @__PURE__ */ new Set();
  host;
  loading;
  snapshot = () => this.state;
  subscribe = (listener) => {
    this.listeners.add(listener);
    if (this.state.status === "idle") void this.load();
    return () => this.listeners.delete(listener);
  };
  async load(force = false) {
    if (!force && this.state.status === "ready") return this.state.spaces;
    if (this.loading && !force) return this.loading;
    this.set({ ...this.state, status: "loading" });
    this.loading = (async () => {
      try {
        const client = await this.service.ready();
        const spaces = await new Genie(client).listSpaces();
        this.set({ status: "ready", spaces });
        return spaces;
      } catch (error) {
        this.set({ status: "error", spaces: [], error: describeError(error) });
        return [];
      } finally {
        this.loading = void 0;
      }
    })();
    return this.loading;
  }
  /** Finds a space by ID or (case-insensitive) title. */
  async find(nameOrId) {
    const needle = nameOrId.trim().toLowerCase();
    const spaces = await this.load();
    return spaces.find((space) => space.space_id.toLowerCase() === needle) ?? spaces.find((space) => space.title.toLowerCase() === needle) ?? spaces.find((space) => space.title.toLowerCase().includes(needle));
  }
  set(state) {
    this.state = state;
    for (const listener of [...this.listeners]) listener();
  }
};
function useSpaces(store) {
  return React.useSyncExternalStore(store.subscribe, store.snapshot);
}
var SELECTED = "genieSpaceId";
var GENIE_ONE_ENTRY = "genie-one";
function useGenieOneAvailable(service, genieOne) {
  const snapshot = useConnection(service);
  const host = snapshot.status === "connected" ? snapshot.profile.host : void 0;
  return useAsync(async () => host ? genieOne.available() : false, [host]).data === true;
}
function useSelection(service, oneAvailable) {
  const [selected, setSelected] = usePreference(service, SELECTED);
  return [selected ?? (oneAvailable ? GENIE_ONE_ENTRY : void 0), setSelected];
}
var rowStyle = {
  display: "block",
  width: "100%",
  textAlign: "left",
  border: 0,
  background: "transparent",
  borderRadius: "var(--radius-row, 6px)",
  padding: "6px 8px",
  cursor: "pointer",
  font: "inherit",
  color: "var(--dbx-ink)"
};
function genieSidebar(service, store, genieOne) {
  return function GenieSidebar(props) {
    const spaces = useSpaces(store);
    const oneAvailable = useGenieOneAvailable(service, genieOne);
    const [selected, setSelected] = useSelection(service, oneAvailable);
    const [query, setQuery] = React.useState("");
    const filtered = spaces.spaces.filter(
      (space) => !query.trim() || `${space.title} ${space.description ?? ""}`.toLowerCase().includes(query.trim().toLowerCase())
    );
    return /* @__PURE__ */ React.createElement("div", { className: "shell-sidebar-default" }, /* @__PURE__ */ React.createElement(DbxRoot, { style: { display: "flex", flexDirection: "column", height: "100%", minHeight: 0 } }, /* @__PURE__ */ React.createElement(Stack, { gap: 8, style: { padding: "12px 10px 8px" } }, /* @__PURE__ */ React.createElement(Stack, { direction: "row", align: "center", justify: "space-between" }, /* @__PURE__ */ React.createElement(Text, { weight: 500 }, "Genie agents"), /* @__PURE__ */ React.createElement(Button, { size: "sm", variant: "ghost", onClick: () => void store.load(true), "aria-label": "Refresh Genie agents", title: "Refresh" }, "\u21BB")), /* @__PURE__ */ React.createElement("input", { className: "dbx-input", placeholder: "Find an agent", value: query, onChange: (event) => setQuery(event.target.value), "aria-label": "Find a Genie agent" })), /* @__PURE__ */ React.createElement("nav", { "aria-label": "Genie agents", style: { flex: 1, overflow: "auto", padding: "0 6px 8px" } }, oneAvailable && /* @__PURE__ */ React.createElement(
      "button",
      {
        type: "button",
        className: "dbx-row",
        "aria-selected": selected === GENIE_ONE_ENTRY,
        onClick: () => setSelected(GENIE_ONE_ENTRY),
        style: { ...rowStyle, marginBottom: 6 }
      },
      /* @__PURE__ */ React.createElement(Stack, { direction: "row", gap: 8, align: "center" }, /* @__PURE__ */ React.createElement(DatabricksMark, { size: 13 }), /* @__PURE__ */ React.createElement(Stack, { gap: 0, style: { minWidth: 0 } }, /* @__PURE__ */ React.createElement(Text, { size: "md" }, "Genie One"), /* @__PURE__ */ React.createElement(Text, { size: "xs", tone: "subtle" }, "Ask across all your data")))
    ), spaces.status === "loading" && /* @__PURE__ */ React.createElement(Stack, { direction: "row", gap: 8, align: "center", style: { padding: 10 } }, /* @__PURE__ */ React.createElement(Spinner, { size: 12 }), /* @__PURE__ */ React.createElement(Text, { tone: "subtle", size: "sm" }, "Loading\u2026")), spaces.status === "error" && /* @__PURE__ */ React.createElement(Text, { tone: "danger", size: "sm", as: "div", style: { padding: 10 } }, spaces.error), spaces.status === "ready" && !filtered.length && /* @__PURE__ */ React.createElement(Text, { tone: "subtle", size: "sm", as: "div", style: { padding: 10 } }, spaces.spaces.length ? "No agents match." : "No Genie agents are shared with you yet."), filtered.map((space) => /* @__PURE__ */ React.createElement(
      "button",
      {
        key: space.space_id,
        type: "button",
        className: "dbx-row",
        "aria-selected": space.space_id === selected,
        onClick: () => setSelected(space.space_id),
        title: space.description,
        style: rowStyle
      },
      /* @__PURE__ */ React.createElement(Text, { size: "md", as: "div", style: { overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" } }, space.title)
    ))), props.children && /* @__PURE__ */ React.createElement("div", { style: { borderTop: "1px solid var(--dbx-border)", padding: 6 } }, props.children)));
  };
}
function geniePage(service, store, genieOne) {
  return function GeniePage(_props) {
    const snapshot = useConnection(service);
    const spaces = useSpaces(store);
    const oneAvailable = useGenieOneAvailable(service, genieOne);
    const [selected] = useSelection(service, oneAvailable);
    const space = spaces.spaces.find((candidate) => candidate.space_id === selected);
    let body;
    if (snapshot.status !== "connected")
      body = /* @__PURE__ */ React.createElement(
        EmptyState,
        {
          title: "Connect Databricks to use Genie",
          action: /* @__PURE__ */ React.createElement(Button, { variant: "brand", onClick: () => service.openSettings() }, "Connect Databricks")
        },
        "Genie answers questions about your data in plain language, with the access you already have."
      );
    else if (selected === GENIE_ONE_ENTRY && oneAvailable) body = /* @__PURE__ */ React.createElement(GenieOneChat, { service, genieOne });
    else if (spaces.status === "error") body = /* @__PURE__ */ React.createElement(Notice, { tone: "danger", title: "Couldn't list Genie agents" }, spaces.error);
    else if (!space)
      body = /* @__PURE__ */ React.createElement(EmptyState, { title: spaces.status === "loading" ? "Loading Genie agents\u2026" : "Choose a Genie agent" }, spaces.status === "ready" && spaces.spaces.length === 0 ? "Nobody has shared a Genie agent with you in this workspace yet. Create one in Databricks, then refresh." : "Pick an agent on the left to start asking questions. Genie agents are curated by your data teams for a topic, like sales or support.");
    else body = /* @__PURE__ */ React.createElement(GenieChat, { key: space.space_id, service, space });
    return /* @__PURE__ */ React.createElement(DbxRoot, { style: { height: "100%", overflow: "auto" } }, /* @__PURE__ */ React.createElement("div", { style: { maxWidth: 920, margin: "0 auto", padding: "24px 28px 16px", minHeight: "100%", display: "flex", flexDirection: "column" } }, body));
  };
}

// plugins/genie/src/conversation.tsx
function composerTool(service, store) {
  return function AskGenie(props) {
    const [open, setOpen] = React.useState(false);
    const root = React.useRef(null);
    React.useEffect(() => {
      if (!open) return;
      const onKey = (event) => {
        if (event.key === "Escape") {
          event.stopPropagation();
          setOpen(false);
          props.focus();
        }
      };
      const onPointer = (event) => {
        if (root.current && !root.current.contains(event.target)) setOpen(false);
      };
      document.addEventListener("keydown", onKey, true);
      document.addEventListener("pointerdown", onPointer, true);
      return () => {
        document.removeEventListener("keydown", onKey, true);
        document.removeEventListener("pointerdown", onPointer, true);
      };
    }, [open, props]);
    return /* @__PURE__ */ React.createElement(DbxRoot, { style: { position: "relative", display: "inline-flex" } }, /* @__PURE__ */ React.createElement("div", { ref: root, style: { display: "contents" } }, /* @__PURE__ */ React.createElement(Button, { icon: true, variant: "ghost", "aria-label": "Ask Genie", title: "Ask Genie about your data", disabled: props.disabled, onClick: () => setOpen(!open) }, /* @__PURE__ */ React.createElement(DatabricksMark, { size: 14 })), open && /* @__PURE__ */ React.createElement(
      "div",
      {
        role: "dialog",
        "aria-label": "Ask Genie",
        style: {
          position: "absolute",
          bottom: "calc(100% + 8px)",
          left: 0,
          width: "min(520px, 80vw)",
          maxHeight: "min(560px, 70vh)",
          overflow: "auto",
          zIndex: 50,
          padding: 14,
          background: "var(--dbx-popover)",
          border: "1px solid var(--dbx-border)",
          borderRadius: "var(--dbx-radius-card)",
          boxShadow: "var(--shadow-panel, 0 8px 28px rgba(0,0,0,0.18))"
        }
      },
      /* @__PURE__ */ React.createElement(
        GeniePicker,
        {
          service,
          store,
          onInsert: (markdown) => {
            if (props.insertText(`${markdown}
`)) {
              setOpen(false);
              props.focus();
            }
          }
        }
      )
    )));
  };
}
function GeniePicker(props) {
  const { service, store } = props;
  const snapshot = useConnection(service);
  const spaces = useSpaces(store);
  const [selected, setSelected] = usePreference(service, "genieSpaceId");
  if (snapshot.status !== "connected")
    return /* @__PURE__ */ React.createElement(EmptyState, { title: "Connect Databricks", action: /* @__PURE__ */ React.createElement(Button, { variant: "brand", onClick: () => service.openSettings() }, "Connect") }, "Sign in once to ask Genie from any conversation.");
  const space = spaces.spaces.find((candidate) => candidate.space_id === selected) ?? spaces.spaces[0];
  return /* @__PURE__ */ React.createElement(Stack, { gap: 12 }, /* @__PURE__ */ React.createElement(Stack, { direction: "row", gap: 8, align: "center" }, /* @__PURE__ */ React.createElement(DatabricksMark, { size: 14 }), /* @__PURE__ */ React.createElement(Text, { weight: 500 }, "Ask Genie"), spaces.status === "loading" && /* @__PURE__ */ React.createElement(Spinner, { size: 12 })), spaces.status === "error" && /* @__PURE__ */ React.createElement(Notice, { tone: "danger" }, spaces.error), spaces.spaces.length > 0 && /* @__PURE__ */ React.createElement("select", { className: "dbx-select", value: space?.space_id ?? "", onChange: (event) => setSelected(event.target.value), "aria-label": "Genie agent" }, spaces.spaces.map((candidate) => /* @__PURE__ */ React.createElement("option", { key: candidate.space_id, value: candidate.space_id }, candidate.title))), spaces.status === "ready" && !spaces.spaces.length && /* @__PURE__ */ React.createElement(Text, { tone: "subtle" }, "No Genie agents are shared with you yet."), space && /* @__PURE__ */ React.createElement(
    GenieChat,
    {
      key: space.space_id,
      service,
      space,
      compact: true,
      answerActions: (turn) => turn.text || turn.result ? /* @__PURE__ */ React.createElement(Button, { size: "sm", variant: "primary", onClick: () => props.onInsert(turnMarkdown(space, turn, service.workspaceUrl(Genie.webPath(space.space_id, turn.message?.conversation_id)))) }, "Insert into message") : null
    }
  ), /* @__PURE__ */ React.createElement(Text, { tone: "tertiary", size: "xs" }, "Answers use your access. Inserting shares the answer with everyone in this conversation."));
}
function genieLinkChip(service, store) {
  return function GenieLink(props) {
    const link = parseGenieUrl(props.url);
    const spaces = useSpaces(store);
    const space = link && spaces.spaces.find((candidate) => candidate.space_id === link.spaceId);
    return /* @__PURE__ */ React.createElement("span", { style: { display: "inline-flex", alignItems: "center", gap: 4 } }, /* @__PURE__ */ React.createElement("span", { "data-dbx": "", style: { display: "inline-flex" } }, /* @__PURE__ */ React.createElement(DatabricksMark, { size: 11 })), /* @__PURE__ */ React.createElement("span", null, "Genie", space ? ` \xB7 ${space.title}` : link?.conversationId ? " conversation" : ""));
  };
}
function geniePanel(service, store) {
  return function GeniePanel(props) {
    const link = React.useMemo(() => parseGenieUrl(props.target), [props.target]);
    const snapshot = useConnection(service);
    const space = useAsync(
      async (signal) => {
        if (!link) return void 0;
        const client = await service.ready(signal);
        if (client.host !== link.host) return "elsewhere";
        return await store.find(link.spaceId) ?? await new Genie(client).getSpace(link.spaceId, signal);
      },
      [props.target, snapshot.status]
    );
    let body;
    if (snapshot.status !== "connected")
      body = /* @__PURE__ */ React.createElement(EmptyState, { title: "Connect Databricks", action: /* @__PURE__ */ React.createElement(Button, { variant: "brand", onClick: () => service.openSettings() }, "Connect") }, "Sign in to chat with this Genie agent.");
    else if (space.loading) body = /* @__PURE__ */ React.createElement(Spinner, null);
    else if (space.error) body = /* @__PURE__ */ React.createElement(Notice, { tone: "danger", title: "Can't open this Genie agent" }, String(space.error.message));
    else if (space.data === "elsewhere") body = /* @__PURE__ */ React.createElement(Notice, { title: "Different workspace" }, "This Genie agent is in ", link?.host.replace("https://", ""), ".");
    else if (space.data)
      body = /* @__PURE__ */ React.createElement(GenieChat, { service, space: space.data, ...link?.conversationId && { conversationId: link.conversationId } });
    else body = /* @__PURE__ */ React.createElement(Text, { tone: "subtle" }, "Not a Genie link.");
    return /* @__PURE__ */ React.createElement(DbxRoot, { style: { padding: "var(--space-panel-inset, 16px)", display: "flex", flexDirection: "column", minHeight: "100%" } }, body);
  };
}

// plugins/genie/src/tools.ts
var AUDIENCE = "Note: these results came from the owner's Databricks access. Everyone in this conversation can read what you post, so share only what this audience should see.";
function formatAnswer(space, answer, link, maxRows) {
  const lines = [`Genie agent: ${space.title} (${space.space_id})`, `conversation_id: ${answer.message.conversation_id}`, `status: ${answer.message.status}`];
  if (answer.error) lines.push(`error: ${answer.error}`);
  if (answer.text) lines.push("", answer.text);
  if (answer.result) lines.push("", toMarkdown(answer.result, maxRows));
  else if (answer.rowCount !== void 0) lines.push("", `(The query returned ${answer.rowCount} rows; the result could not be fetched.)`);
  if (answer.sql) lines.push("", "SQL:", "```sql", answer.sql.trim(), "```");
  if (answer.suggestions.length) lines.push("", `Follow-ups Genie suggests: ${answer.suggestions.slice(0, 3).join(" | ")}`);
  if (link) lines.push("", `Open in Genie: ${link}`);
  lines.push("", AUDIENCE);
  return lines.join("\n");
}
function genieTools(service, store, genieOne) {
  return [
    {
      name: "databricks_genie_list",
      description: "Lists the Databricks Genie agents (formerly Genie spaces) the owner can use. Each answers natural-language questions about a curated set of tables, such as sales or support data. Optionally filter by a search term.",
      inputSchema: schema.object({ search: schema.string("Words to match in the agent's title or description.") }),
      async call(_client, _context, args) {
        const search = stringArg(args, "search", false).toLowerCase();
        const spaces = (await store.load(true)).filter(
          (space) => !search || `${space.title} ${space.description ?? ""}`.toLowerCase().includes(search)
        );
        if (!spaces.length) return search ? `No Genie agents match "${search}".` : "No Genie agents are shared with the owner in this workspace.";
        return spaces.slice(0, 50).map((space) => `- ${space.title} (id ${space.space_id})${space.description ? `: ${space.description.replace(/\s+/g, " ").slice(0, 200)}` : ""}`).join("\n");
      }
    },
    {
      name: "databricks_genie_ask",
      description: "Asks a Databricks Genie agent a question about data and waits for the answer (usually 10\u201360 seconds). Returns Genie's explanation, the result table, the SQL it ran, and a conversation_id: pass that back to ask a follow-up in the same conversation. Use databricks_genie_list to find agents.",
      inputSchema: schema.object(
        {
          agent: schema.string("The Genie agent's id or title."),
          question: schema.string("The question, in plain language."),
          conversation_id: schema.string("Continue an earlier conversation with this agent."),
          max_rows: schema.integer("Rows of the result to include (default 20, max 100).")
        },
        ["agent", "question"]
      ),
      async call(_client, _context, args) {
        const space = await store.find(stringArg(args, "agent"));
        if (!space) throw new Error("No Genie agent matches that id or title. Call databricks_genie_list first.");
        const client = await service.ready();
        const conversationId = stringArg(args, "conversation_id", false);
        const answer = await new Genie(client).answer(space.space_id, stringArg(args, "question"), conversationId ? { conversationId } : {});
        const link = service.workspaceUrl(Genie.webPath(space.space_id, answer.message.conversation_id));
        return formatAnswer(space, answer, link, numberArg(args, "max_rows", 20, 1, 100));
      }
    },
    {
      name: "databricks_genie_one_ask",
      description: "Asks Genie One, Databricks' workspace-wide data assistant, which finds the right data itself (no agent needed). Good when you don't know which Genie agent or table covers a question. Returns the answer and any result table.",
      inputSchema: schema.object(
        {
          question: schema.string("The question, in plain language."),
          conversation_id: schema.string("Continue an earlier Genie One conversation.")
        },
        ["question"]
      ),
      async call(_client, _context, args) {
        const conversationId = stringArg(args, "conversation_id", false);
        const answer = await genieOne.ask(stringArg(args, "question"), conversationId ? { conversationId } : {});
        return `${genieOne.format(answer)}

${AUDIENCE}`;
      }
    }
  ];
}

// plugins/genie/src/index.tsx
var inject = ["react", "pages", "conversation", "panels"];
function apply(ctx) {
  bindReact(ctx.react);
  const live = attach(ctx, { id: "bkvarda.databricks-genie", name: "Databricks Genie" }, (scope, databricks) => {
    const store = new SpacesStore(databricks);
    const genieOne = new GenieOne(databricks);
    scope.conversation.registerTool({ id: "ask-genie", title: "Ask Genie", order: 20, component: composerTool(databricks, store) });
    scope.conversation.registerLink({
      id: "genie-link",
      title: "Genie links",
      matches: (url) => parseGenieUrl(url) !== void 0,
      order: -10,
      component: genieLinkChip(databricks, store)
    });
    scope.panels.register({
      id: "genie",
      title: "Genie",
      matches: (url) => parseGenieUrl(url) !== void 0,
      order: -10,
      keepOpen: true,
      component: geniePanel(databricks, store)
    });
    scope.inject(["agents"], (agents) => {
      for (const tool of genieTools(databricks, store, genieOne)) agents.agents.addTool(tool);
    });
    return {
      page: geniePage(databricks, store, genieOne),
      sidebar: genieSidebar(databricks, store, genieOne)
    };
  });
  ctx.pages.register({
    id: "genie",
    title: "Genie",
    primary: true,
    icon: DATABRICKS_ICON_MONO,
    component: (props) => {
      const runtime = useLive(live);
      return runtime ? /* @__PURE__ */ React.createElement(runtime.page, { ...props }) : /* @__PURE__ */ React.createElement(MissingCore, { ctx, feature: "Databricks Genie" });
    },
    sidebar: (props) => {
      const runtime = useLive(live);
      return runtime ? /* @__PURE__ */ React.createElement(runtime.sidebar, { ...props }) : /* @__PURE__ */ React.createElement("div", { className: "shell-sidebar-default" }, props.children);
    }
  });
}
export {
  apply,
  inject
};
