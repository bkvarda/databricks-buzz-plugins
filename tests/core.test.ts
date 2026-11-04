import { describe, expect, it } from "vitest";
import { parseProfiles, parseToken, normalizeHost, isWorkspaceProfile } from "@dbx/core/cli";
import { bodyAndTrailers, curlConfig, curlQuote, endMarker, splitHead } from "@dbx/core/curl";
import { parseSse, SseParser } from "@dbx/core/sse";
import { fromStatement, planChart, resultSet, toMarkdown } from "@dbx/core/result";
import { isReadOnlySql } from "@dbx/core/api/sql";
import { parseWorkspaceUrl } from "@dbx/core/api/workspace";
import { parseGenieUrl, summarize } from "@dbx/core/api/genie";
import { agentText } from "@dbx/core/api/ai";
import { normalizePath, validStoreId } from "@dbx/core/api/memory";
import { parseBlocks } from "@dbx/core/ui/markdown";
import { apiError } from "@dbx/core/client";

describe("curl config", () => {
  it("quotes values so they cannot break out of the config line", () => {
    expect(curlQuote('a"b\\c\nd')).toBe('"a\\"b\\\\c\\nd"');
    const config = curlConfig({
      url: "https://example.cloud.databricks.com/api/2.0/x?y=1",
      method: "POST",
      headers: { Authorization: "Bearer secret" },
      body: '{"q":"say \\"hi\\"\\n"}',
    });
    expect(config).toContain('url = "https://example.cloud.databricks.com/api/2.0/x?y=1"');
    expect(config).toContain('header = "Authorization: Bearer secret"');
    expect(config).toContain("data-raw = ");
    expect(config.split("\n").filter((line) => line.startsWith("url"))).toHaveLength(1);
  });
  it("refuses non-HTTPS URLs, credentials in URLs and header injection", () => {
    expect(() => curlConfig({ url: "http://example.com" })).toThrow(/HTTPS/);
    expect(() => curlConfig({ url: "https://u:p@example.com" })).toThrow(/credentials/);
    expect(() => curlConfig({ url: "https://example.com", headers: { "X-A": "1\r\nurl = x" } })).toThrow(/Invalid header/);
  });
  it("splits the final header block from the body, skipping 100 Continue", () => {
    const raw = "HTTP/1.1 100 Continue\r\n\r\nHTTP/2 201\r\ncontent-type: application/json\r\nMcp-Session-Id: abc\r\n\r\n{\"ok\":true}";
    const split = splitHead(raw);
    expect(split?.head.status).toBe(201);
    expect(split?.head.headers["mcp-session-id"]).toBe("abc");
    expect(split?.rest).toBe('{"ok":true}');
    expect(splitHead("HTTP/2 200\r\ncontent-type: x")).toBeUndefined();
  });
  it("asks curl for the body size after a per-request marker", () => {
    expect(curlConfig({ url: "https://example.com" }, "abc")).toContain('write-out = "\\n--dbx-curl-end-abc %{size_download}\\n"');
    expect(curlConfig({ url: "https://example.com" })).not.toContain("write-out");
  });
  it("cuts HTTP trailers off the body using the reported byte count", () => {
    const body = '{"stdout":"héllo 🧱"}';
    const bytes = new TextEncoder().encode(body).length;
    const text = `${body}grpc-status: 0\r\ngrpc-message: \r\n${endMarker("n1")}${bytes}\n`;
    expect(bodyAndTrailers(text, "n1")).toEqual({ body, trailers: { "grpc-status": "0", "grpc-message": "" } });
    expect(bodyAndTrailers(`${body}${endMarker("n1")}${bytes}\n`, "n1")).toEqual({ body, trailers: {} });
    expect(bodyAndTrailers(`${endMarker("n1")}0\n`, "n1")).toEqual({ body: "", trailers: {} });
    // A body that happens to contain another request's marker is left alone.
    expect(bodyAndTrailers(`x${endMarker("other")}5`, "n1").body).toBe(`x${endMarker("other")}5`);
  });
});

describe("SSE", () => {
  it("parses events across chunk boundaries", () => {
    const events: { event: string; data: string }[] = [];
    const parser = new SseParser((event) => events.push(event));
    parser.push("event: response.created\ndata: {\"a\"");
    parser.push(":1}\n\n: comment\ndata: line1\r\ndata: line2\r\n\r\n");
    parser.end();
    expect(events).toEqual([
      { event: "response.created", data: '{"a":1}' },
      { event: "message", data: "line1\nline2" },
    ]);
    expect(parseSse('data: {"jsonrpc":"2.0","id":1}')).toHaveLength(1);
  });
});

describe("CLI parsing", () => {
  it("reads profiles and normalizes hosts", () => {
    const profiles = parseProfiles(JSON.stringify({ profiles: [
      { name: "DEFAULT", host: "https://Example.cloud.databricks.com/", auth_type: "databricks-cli", workspace_id: "123", cloud: "aws" },
      { name: "acct", host: "https://accounts.cloud.databricks.com", account_id: "a1" },
      { name: "broken" },
    ] }));
    expect(profiles).toHaveLength(2);
    expect(profiles[0]).toMatchObject({ name: "DEFAULT", host: "https://example.cloud.databricks.com", workspaceId: "123" });
    expect(isWorkspaceProfile(profiles[0]!)).toBe(true);
    expect(isWorkspaceProfile(profiles[1]!)).toBe(false);
    expect(normalizeHost("adb-1.2.azuredatabricks.net")).toBe("https://adb-1.2.azuredatabricks.net");
  });
  it("reads tokens with expiry, expires_in or a default lifetime", () => {
    expect(parseToken('{"access_token":"t","expiry":"2030-01-01T00:00:00Z"}').expiresAt).toBe(Date.parse("2030-01-01T00:00:00Z"));
    expect(parseToken('{"access_token":"t","expires_in":60}', 1000).expiresAt).toBe(61_000);
    expect(() => parseToken('{"token_type":"Bearer"}')).toThrow();
  });
});

describe("results", () => {
  const statement = {
    manifest: { schema: { columns: [{ name: "day", type_text: "DATE" }, { name: "orders", type_text: "BIGINT" }] }, total_row_count: 3 },
    result: { data_array: [["2026-01-01", "10"], ["2026-01-02", "12"], ["2026-01-03", null]] },
  };
  it("infers kinds from types and plans a line chart for time series", () => {
    const result = fromStatement(statement);
    expect(result.columns.map((c) => c.kind)).toEqual(["time", "number"]);
    expect(planChart(result)).toEqual({ type: "line", x: 0, series: [1] });
  });
  it("plans KPI, bar and none", () => {
    expect(planChart(resultSet([{ name: "total" }], [["42"]]))).toMatchObject({ type: "kpi", value: 42 });
    expect(planChart(resultSet([{ name: "region" }, { name: "revenue" }], [["West", "1"], ["East", "2"]]))).toMatchObject({ type: "bar", x: 0 });
    expect(planChart(resultSet([{ name: "a" }, { name: "b" }], [["x", "y"], ["z", "w"]]))).toEqual({ type: "none" });
  });
  it("renders a markdown table with a row note", () => {
    const markdown = toMarkdown(fromStatement(statement), 2);
    expect(markdown).toContain("| day | orders |");
    expect(markdown).toContain("Showing 2 of 3 rows");
  });
});

describe("SQL safety", () => {
  it.each([
    ["SELECT * FROM t", true],
    ["with x as (select 1) select * from x", true],
    ["-- delete\nSELECT update_time FROM t", true],
    ["SELECT 'drop table x'", true],
    ["SHOW TABLES IN main.default", true],
    ["DELETE FROM t", false],
    ["SELECT 1; DROP TABLE t", false],
    ["INSERT INTO t SELECT * FROM s", false],
    ["CREATE TABLE x AS SELECT 1", false],
    ["", false],
  ])("%s → %s", (sql, expected) => expect(isReadOnlySql(sql)).toBe(expected));
});

describe("workspace URLs", () => {
  const host = "https://acme.cloud.databricks.com";
  it.each([
    [`${host}/jobs/12/runs/34?o=1`, { kind: "run", jobId: "12", runId: "34" }],
    [`${host}/?o=1#job/12/run/34`, { kind: "run", runId: "34" }],
    [`${host}/jobs/12`, { kind: "job", jobId: "12" }],
    [`${host}/pipelines/0123abcd-0123-4567-89ab-0123456789ab`, { kind: "pipeline" }],
    [`${host}/dashboardsv3/0123456789abcdef0123456789abcdef/published`, { kind: "dashboard" }],
    [`${host}/genie/rooms/01ef1234abcd/chats/01ef5678?o=1`, { kind: "genie", spaceId: "01ef1234abcd", conversationId: "01ef5678" }],
    [`${host}/explore/data/main/default/orders`, { kind: "table", fullName: "main.default.orders" }],
  ])("%s", (url, expected) => expect(parseWorkspaceUrl(url)).toMatchObject(expected));
  it("ignores non-workspace hosts", () => {
    expect(parseWorkspaceUrl("https://docs.databricks.com/aws/en/jobs/12")).toBeUndefined();
    expect(parseWorkspaceUrl("https://github.com/jobs/12/runs/34")).toBeUndefined();
    expect(parseGenieUrl(`${host}/genie/rooms/01ef1234abcd`)).toMatchObject({ spaceId: "01ef1234abcd" });
  });
});

describe("Genie and agents", () => {
  it("summarizes a finished Genie message", () => {
    const parts = summarize({
      conversation_id: "c", content: "q", status: "COMPLETED",
      attachments: [
        { text: { content: "Sales rose 4%." } },
        { attachment_id: "a1", query: { query: "SELECT 1", title: "Sales", query_result_metadata: { row_count: 1 } } },
        { suggested_questions: { questions: ["By region?"] } },
      ],
    });
    expect(parts).toMatchObject({ text: "Sales rose 4%.", sql: "SELECT 1", queryAttachmentId: "a1", rowCount: 1, suggestions: ["By region?"] });
  });
  it("extracts agent reply text from each serving format", () => {
    expect(agentText({ output: [{ type: "message", content: [{ type: "output_text", text: "hi" }] }] })).toBe("hi");
    expect(agentText({ choices: [{ message: { content: "chat" } }] })).toBe("chat");
    expect(agentText({ messages: [{ role: "user", content: "q" }, { role: "assistant", content: "a" }] })).toBe("a");
  });
  it("validates memory stores and paths", () => {
    expect(validStoreId("buzz-memory")).toBe(true);
    expect(validStoreId("Buzz")).toBe(false);
    expect(normalizePath("prefs//style.md")).toBe("/prefs/style.md");
    expect(() => normalizePath("/a/../b")).toThrow();
  });
  it("maps Databricks error bodies", () => {
    const error = apiError({ status: 403, headers: {}, body: '{"error_code":"PERMISSION_DENIED","message":"nope"}' });
    expect(error).toMatchObject({ status: 403, errorCode: "PERMISSION_DENIED", message: "nope", isPermission: true });
  });
});

describe("markdown", () => {
  it("parses tables, lists and code", () => {
    const blocks = parseBlocks("Intro **bold**\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\n- one\n- two\n\n```sql\nSELECT 1\n```");
    expect(blocks.map((b) => b.type)).toEqual(["p", "table", "ul", "code"]);
  });
});

describe("column kinds", () => {
  it("treats identifier-like numeric columns as labels, so they chart as categories", () => {
    const result = resultSet([{ name: "pickup_zip", type: "INT" }, { name: "trip_count", type: "BIGINT" }, { name: "avg_fare" }], [["10001", "1227", "10.62"], ["10003", "1181", "10.98"]]);
    expect(result.columns.map((column) => column.kind)).toEqual(["text", "number", "number"]);
    // Fares (~10) and trips (~1,000) don't share an axis; the first measure wins.
    expect(planChart(result)).toMatchObject({ type: "bar", x: 0, series: [1] });
    expect(resultSet([{ name: "order_date", type: "DATE" }], [["2016-01-01"]]).columns[0]?.kind).toBe("time");
  });
});

describe("chart planning for hour columns", () => {
  it("charts an integer hour column as the x-axis", () => {
    const result = resultSet([{ name: "pickup_hour", type: "INT" }, { name: "trips", type: "BIGINT" }, { name: "avg_fare_usd", type: "DOUBLE" }], Array.from({ length: 24 }, (_, h) => [String(h), String(500 + h * 30), "12.5"]));
    expect(planChart(result)).toMatchObject({ type: "line", x: 0, series: [1] });
  });
});
