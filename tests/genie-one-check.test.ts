// Genie One against a fake MCP server: the check behind the Genie page's
// Genie One row (ready, or a reason in words, never a silent "missing"), and
// backing off while Databricks rate-limits it (HTTP 429, an error result, or
// an answer that failed because of a rate limit), within about half a minute.
import { afterEach, describe, expect, it, vi } from "vitest";
import type { DatabricksClient } from "@dbx/core/client";
import type { DatabricksService } from "@dbx/core/service";
import { CHECK_TIMEOUT_MS, GenieOne, RATE_LIMIT_WAITS_MS, type RetryNotice } from "../plugins/genie/src/genie-one";

const HANG = Symbol("hang");
type Call = Readonly<{ method: string; tool?: string; args?: Record<string, unknown> }>;
/** A JSON-RPC result, an HTTP refusal, or no answer at all. */
type Answer = unknown | typeof HANG | Readonly<{ http: number; body: string }>;

const LIMIT_TEXT = "REQUEST_LIMIT_EXCEEDED: Your request was rejected since your organization has exceeded the rate limit.";
const refused = { http: 429, body: JSON.stringify({ error_code: "REQUEST_LIMIT_EXCEEDED", message: "Your request was rejected since your organization has exceeded the rate limit." }) };
const text = (value: string, isError = false) => ({ content: [{ type: "text", text: value }], ...(isError && { isError: true }) });
const json = (value: unknown) => ({ structuredContent: value, content: [{ type: "text", text: JSON.stringify(value) }] });

/** A workspace whose Genie One MCP server answers each list or tool call with `answer(call)`. */
function workspace(answer: (call: Call) => Answer) {
  const calls: Call[] = [];
  const client = {
    host: "https://w.example",
    request: async (_path: string, init: { body: { id?: number; method: string; params?: { name?: string; arguments?: Record<string, unknown> } } }) => {
      const message = init.body;
      if (message.id === undefined) return { status: 202, headers: {}, body: "" };
      const ok = (result: unknown) => ({
        status: 200,
        headers: { "content-type": "application/json", "mcp-session-id": "s1" },
        body: JSON.stringify({ jsonrpc: "2.0", id: message.id, result }),
      });
      if (message.method === "initialize") return ok({ serverInfo: { name: "genie-one" } });
      const call: Call = { method: message.method, ...(message.params?.name && { tool: message.params.name, args: message.params.arguments ?? {} }) };
      calls.push(call);
      const value = answer(call);
      if (value === HANG) return new Promise(() => {});
      if (value && typeof value === "object" && "http" in value) {
        const { http, body } = value as { http: number; body: string };
        return { status: http, headers: {}, body };
      }
      return ok(value);
    },
  } as unknown as DatabricksClient;
  const service = {
    snapshot: () => ({ status: "connected", profile: { host: "https://w.example", name: "p" } }),
    ready: async () => client,
  } as unknown as DatabricksService;
  return { genieOne: new GenieOne(service), calls, lists: () => calls.filter((call) => call.method === "tools/list").length };
}

/** Lets fake time run until `promise` settles, and returns how it settled. */
async function settle<T>(promise: Promise<T>): Promise<{ value?: T; error?: Error }> {
  const outcome = promise.then(
    (value) => ({ value }),
    (error: unknown) => ({ error: error as Error }),
  );
  await vi.runAllTimersAsync();
  return outcome;
}

afterEach(() => vi.useRealTimers());

describe("Genie One check", () => {
  it("is ready when Genie One offers genie_ask, and views share one check", async () => {
    const { genieOne, lists } = workspace(() => ({ tools: [{ name: "genie_ask" }, { name: "genie_poll_response" }] }));
    expect(await genieOne.check()).toEqual({ ok: true });
    expect(await genieOne.available()).toBe(true);
    expect(lists()).toBe(1);
  });

  it("says Genie One isn't set up when its server isn't there", async () => {
    const { genieOne } = workspace(() => ({
      http: 404,
      body: JSON.stringify({ error_code: "RESOURCE_DOES_NOT_EXIST", message: "MCP service system.ai.genie_one_mcp does not exist." }),
    }));
    const result = await genieOne.check();
    expect(result.ok).toBe(false);
    expect(!result.ok && result.reason).toMatch(/^Genie One isn't set up in this workspace\. .*does not exist/);
  });

  it("gives up after the deadline instead of checking forever", async () => {
    vi.useFakeTimers();
    const { genieOne } = workspace(() => HANG);
    const pending = genieOne.check();
    await vi.advanceTimersByTimeAsync(CHECK_TIMEOUT_MS);
    expect(await pending).toEqual({ ok: false, reason: `Genie One didn't answer within ${CHECK_TIMEOUT_MS / 1000} seconds.` });
  });

  it("rides out a short rate limit, and says Genie One is busy when it lasts", async () => {
    vi.useFakeTimers();
    const once = [refused, refused];
    const brief = workspace(() => once.shift() ?? { tools: [{ name: "genie_ask" }] });
    expect((await settle(brief.genieOne.check())).value).toEqual({ ok: true });

    const lasting = workspace(() => refused);
    const result = (await settle(lasting.genieOne.check())).value;
    expect(result).toMatchObject({ ok: false, busy: true, reason: expect.stringMatching(/rate-limiting Genie One/) });
  });

  it("doesn't remember a failure, and Try again asks Genie One again for every view", async () => {
    const answers = [{ http: 503, body: "busy" }, { tools: [] }, { tools: [{ name: "genie_ask" }] }];
    const { genieOne, lists } = workspace(() => answers.shift());
    expect((await genieOne.check()).ok).toBe(false);
    // A failure isn't kept: the next look asks again.
    expect(await genieOne.check()).toEqual({ ok: false, reason: "Genie One answered, but without its question tool (genie_ask)." });
    expect(lists()).toBe(2);

    let heard = 0;
    const stop = genieOne.subscribeChecks(() => heard++);
    const before = genieOne.checkRevision();
    genieOne.recheck();
    expect(heard).toBe(1);
    expect(genieOne.checkRevision()).not.toBe(before);
    stop();

    // The MCP client caches its tool list; Try again drops it, so this asks the server.
    expect(await genieOne.check()).toEqual({ ok: true });
    expect(lists()).toBe(3);
  });
});

describe("Genie One rate limits", () => {
  const started = json({ conversation_id: "c1", response_id: "r1", status: "in_progress" });
  const answered = json({ conversation_id: "c1", response_id: "r1", status: "completed", final_answer: "42 orders." });

  it("waits and asks again when the question is refused (HTTP 429 or an error result)", async () => {
    vi.useFakeTimers();
    const asks: Answer[] = [refused, text(LIMIT_TEXT, true), started];
    const { genieOne, calls } = workspace((call) => (call.tool === "genie_ask" ? asks.shift() : answered));
    const notices: RetryNotice[] = [];
    const { value } = await settle(genieOne.ask("How many orders?", { onRetry: (notice) => notices.push(notice) }));
    expect(value?.text).toBe("42 orders.");
    expect(calls.filter((call) => call.tool === "genie_ask")).toHaveLength(3);
    expect(notices.map((notice) => [notice.attempt, notice.restarted])).toEqual([
      [1, false],
      [2, false],
    ]);
    // Each wait is its step's time, give or take 20%.
    notices.forEach((notice, n) => {
      expect(notice.waitMs).toBeGreaterThanOrEqual(RATE_LIMIT_WAITS_MS[n]! * 0.8);
      expect(notice.waitMs).toBeLessThanOrEqual(RATE_LIMIT_WAITS_MS[n]! * 1.2);
    });
  });

  it("keeps polling through a rate-limited poll", async () => {
    vi.useFakeTimers();
    const polls: Answer[] = [refused, answered];
    const { genieOne } = workspace((call) => (call.tool === "genie_ask" ? started : polls.shift()));
    const notices: RetryNotice[] = [];
    const { value } = await settle(genieOne.ask("How many orders?", { onRetry: (notice) => notices.push(notice) }));
    expect(value?.text).toBe("42 orders.");
    expect(notices).toHaveLength(1);
  });

  it("asks again in the same conversation when the answer failed because of a rate limit", async () => {
    vi.useFakeTimers();
    const failed = json({ conversation_id: "c1", response_id: "r1", status: "failed" });
    const polls: Answer[] = [{ ...failed, content: [{ type: "text", text: "REQUEST_LIMIT_EXCEEDED: Unity Catalog is rate-limiting requests for your organization; this is transient, please retry after a short backoff." }] }, answered];
    const { genieOne, calls } = workspace((call) => (call.tool === "genie_ask" ? started : polls.shift()));
    const notices: RetryNotice[] = [];
    const { value } = await settle(genieOne.ask("How many orders?", { onRetry: (notice) => notices.push(notice) }));
    expect(value?.text).toBe("42 orders.");
    const asks = calls.filter((call) => call.tool === "genie_ask");
    expect(asks).toHaveLength(2);
    expect(asks[1]!.args).toMatchObject({ question: "How many orders?", conversation_id: "c1" });
    expect(notices.map((notice) => notice.restarted)).toEqual([true]);
  });

  it("stops after about half a minute and passes on what Databricks said", async () => {
    vi.useFakeTimers();
    const { genieOne, calls } = workspace(() => refused);
    const notices: RetryNotice[] = [];
    const { error } = await settle(genieOne.ask("How many orders?", { onRetry: (notice) => notices.push(notice) }));
    expect(error?.message).toMatch(/exceeded the rate limit/);
    expect(calls.filter((call) => call.tool === "genie_ask")).toHaveLength(RATE_LIMIT_WAITS_MS.length + 1);
    const waited = notices.reduce((sum, notice) => sum + notice.waitMs, 0);
    expect(waited).toBeLessThanOrEqual(RATE_LIMIT_WAITS_MS.reduce((a, b) => a + b, 0) * 1.2);
    expect(waited).toBeGreaterThan(20_000);
  });

  it("doesn't retry other failures", async () => {
    const { genieOne, calls } = workspace((call) => (call.tool === "genie_ask" ? text("Genie One isn't enabled for this user.", true) : answered));
    await expect(genieOne.ask("How many orders?")).rejects.toThrow("Genie One isn't enabled for this user.");
    expect(calls.filter((call) => call.tool === "genie_ask")).toHaveLength(1);
  });

  it("stops waiting at once when the person presses Stop", async () => {
    vi.useFakeTimers();
    const { genieOne, calls } = workspace(() => refused);
    const controller = new AbortController();
    const outcome = genieOne.ask("How many orders?", { signal: controller.signal, onRetry: () => controller.abort() }).then(
      () => "answered",
      (error: Error) => error.name,
    );
    await vi.advanceTimersByTimeAsync(10);
    expect(await outcome).toBe("AbortError");
    expect(calls.filter((call) => call.tool === "genie_ask")).toHaveLength(1);
  });
});
