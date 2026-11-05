// Genie chats and the SQL page keep their state in the plugin and reopen it
// after a restart: Genie conversations by ID, Genie One turns by response ID,
// and the SQL page's last run by statement ID.
import { describe, expect, it } from "vitest";
import type { DatabricksClient } from "@dbx/core/client";
import type { DatabricksService } from "@dbx/core/service";
import { Sql } from "@dbx/core/api/sql";
import { CONVERSATIONS, GENIE_ONE_CHAT, GenieChats, KEEP_ONE_TURNS, OneChat, type SavedOneChat, saveOneChat } from "../plugins/genie/src/chats";
import type { GenieOne, GenieOneAnswer } from "../plugins/genie/src/genie-one";
import { Editor, SQL_LAST_RUN, SQL_TEXT, type SavedRun } from "../plugins/sql/src/page";
import { Runs } from "../plugins/sql/src/runs";

type Route = (method: string, path: string, body?: unknown) => unknown;

function fakeClient(route: Route): DatabricksClient {
  const answer = async (method: string, path: string, body?: unknown) => {
    const value = route(method, path, body);
    if (value instanceof Error) throw value;
    if (value === undefined) throw Object.assign(new Error(`no route for ${method} ${path}`), { status: 404 });
    return value;
  };
  return { host: "https://w.example", get: (path: string) => answer("GET", path), post: (path: string, body?: unknown) => answer("POST", path, body) } as unknown as DatabricksClient;
}

/** A connected service whose preferences outlive it, as they do across restarts. */
function fakeService(route: Route, saved = new Map<string, unknown>()) {
  const listeners = new Set<() => void>();
  let host = "https://w.example";
  const client = fakeClient(route);
  const service = {
    version: 1,
    snapshot: () => ({ status: "connected", profile: { host, name: "p" }, user: { userName: "me" } }),
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    client: () => client,
    ready: async () => client,
    workspaceUrl: (path: string) => `${host}${path}`,
    preferences: {
      get: (name: string) => (saved.has(`${host}|${name}`) ? structuredClone(saved.get(`${host}|${name}`)) : undefined),
      set: (name: string, value: unknown) => (value === undefined ? saved.delete(`${host}|${name}`) : saved.set(`${host}|${name}`, structuredClone(value))),
      subscribe: () => () => {},
    },
  } as unknown as DatabricksService;
  return {
    service,
    saved,
    pref: (name: string) => saved.get(`${host}|${name}`),
    switchTo(next: string) {
      host = next;
      for (const listener of [...listeners]) listener();
    },
  };
}

const until = async (check: () => boolean, ms = 3000) => {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error("timed out");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
};

const answerFor = (responseId: string, text: string, steps: string[] = []): GenieOneAnswer => ({
  conversationId: "conv-1",
  responseId,
  status: "completed",
  text,
  markdown: text,
  steps,
  results: [],
  sql: [],
});

describe("Genie One chats", () => {
  it("remembers each turn's response ID and gets the answers back after a restart", async () => {
    const { service, pref, saved } = fakeService(() => undefined);
    const asked: string[] = [];
    const genieOne = {
      async ask(question: string, options: Parameters<GenieOne["ask"]>[1] = {}) {
        asked.push(`${question}|${options.conversationId ?? ""}`);
        const responseId = `r${asked.length}`;
        options.onStarted?.({ conversationId: "conv-1", responseId });
        options.onProgress?.(["Thinking: finding the trips table", "Running SQL: SELECT COUNT(*)"]);
        return answerFor(responseId, `answer ${asked.length}`, ["Thinking: finding the trips table", "Running SQL: SELECT COUNT(*)"]);
      },
      async response(conversationId: string, responseId: string) {
        expect(conversationId).toBe("conv-1");
        // The server no longer has the steps once a response is done.
        return answerFor(responseId, `answer again ${responseId}`);
      },
    } as unknown as GenieOne;

    const chats = new GenieChats(service, genieOne);
    const chat = chats.genieOneChat();
    expect(chats.genieOneChat()).toBe(chat);
    await chat.ask("How many trips?");
    await chat.ask("And the average fare?");
    expect(asked).toEqual(["How many trips?|", "And the average fare?|conv-1"]);

    const remembered = pref(GENIE_ONE_CHAT) as SavedOneChat;
    expect(remembered.conversationId).toBe("conv-1");
    expect(remembered.turns.map((turn) => [turn.question, turn.responseId, turn.steps?.length])).toEqual([
      ["How many trips?", "r1", 2],
      ["And the average fare?", "r2", 2],
    ]);
    expect(JSON.stringify(remembered)).not.toContain("answer 1");

    // A restart: new chats, the same preferences.
    const restarted = new GenieChats(fakeService(() => undefined, saved).service, genieOne).genieOneChat();
    expect(restarted.snapshot().turns.map((turn) => turn.question)).toEqual(["How many trips?", "And the average fare?"]);
    await until(() => restarted.snapshot().turns.every((turn) => turn.answer));
    const turns = restarted.snapshot().turns;
    expect(turns.map((turn) => turn.answer?.text)).toEqual(["answer again r1", "answer again r2"]);
    expect(turns[0]!.steps).toHaveLength(2);
    expect(turns.every((turn) => !turn.reopening && turn.finished)).toBe(true);
    expect(restarted.snapshot().conversationId).toBe("conv-1");
  });

  it("follows a question still running when Buzz closed, and says when an answer is gone", async () => {
    const saved: SavedOneChat = {
      conversationId: "conv-1",
      turns: [
        { question: "old", responseId: "gone", started: 1, finished: 2 },
        { question: "running", responseId: "r9", started: 3 },
      ],
    };
    let release!: () => void;
    const genieOne = {
      async response(_conversation: string, responseId: string) {
        if (responseId === "gone") throw new Error("response_id gone not found");
        await new Promise<void>((resolve) => (release = resolve));
        return answerFor(responseId, "done now");
      },
    } as unknown as GenieOne;
    let remembered: SavedOneChat | undefined;
    const chat = new OneChat(genieOne, saved, (value) => (remembered = value));
    expect(chat.snapshot().busy).toBe(true);
    await until(() => Boolean(release));
    release();
    await until(() => !chat.snapshot().busy);
    const [old, running] = chat.snapshot().turns;
    expect(running!.answer?.text).toBe("done now");
    expect(old!.error).toMatch(/Couldn't get this answer back from Genie One/);
    expect(remembered?.turns[1]?.finished).toBeGreaterThan(3);
  });

  it("asks Genie One again for a turn our side failed, but not one you stopped", () => {
    const saved = saveOneChat({
      conversationId: "c",
      busy: false,
      turns: [
        { key: "a", question: "cut off", steps: [], started: 1, finished: 2, responseId: "r1", error: "curl exited with a signal" },
        { key: "b", question: "stopped", steps: [], started: 3, finished: 4, responseId: "r2", error: "Stopped.", stopped: true },
        { key: "c", question: "never sent", steps: [], started: 5, finished: 6, error: "offline" },
      ],
    })!;
    expect(saved.turns.map((turn) => [turn.question, turn.error ?? null, turn.finished ?? null])).toEqual([
      ["cut off", null, null],
      ["stopped", "Stopped.", 4],
      ["never sent", "offline", 6],
    ]);
  });

  it("keeps only the newest turns", () => {
    const turns = Array.from({ length: KEEP_ONE_TURNS + 5 }, (_, index) => ({ key: `${index}`, question: `q${index}`, steps: [], started: index, responseId: `r${index}` }));
    const saved = saveOneChat({ conversationId: "c", turns, busy: false })!;
    expect(saved.turns).toHaveLength(KEEP_ONE_TURNS);
    expect(saved.turns[0]!.question).toBe("q5");
    expect(saveOneChat({ turns, busy: false })).toBeUndefined();
  });
});

describe("Genie agent chats", () => {
  const message = (id: string, content: string, conversation = "c1") => ({
    message_id: id,
    conversation_id: conversation,
    content,
    status: "COMPLETED",
    created_timestamp: Number(id.slice(1)),
    attachments: [{ attachment_id: `a-${id}`, query: { query: "SELECT 1 AS n" } }, { text: { content: `answer to ${content}` } }],
  });
  const route: Route = (method, path) => {
    if (method === "POST" && path.endsWith("/start-conversation")) return { conversation_id: "c1", message_id: "m1", message: message("m1", "first") };
    if (method === "POST" && path.endsWith("/conversations/c1/messages")) return message("m2", "second");
    if (method === "GET" && path.endsWith("/conversations/c1/messages")) return { messages: [message("m2", "second"), message("m1", "first")] };
    if (method === "GET" && path.endsWith("/query-result"))
      return { statement_response: { manifest: { schema: { columns: [{ name: "n", type_text: "INT" }] }, total_row_count: 1 }, result: { data_array: [["1"]] } } };
    return undefined;
  };

  it("reopens each agent's conversation after a restart, with the latest result", async () => {
    const { service, saved, pref } = fakeService(route);
    const chats = new GenieChats(service, {} as GenieOne);
    const chat = chats.space("s1");
    expect(chats.space("s1")).toBe(chat);
    await chat.ask("first");
    await chat.ask("second");
    expect(pref(CONVERSATIONS)).toEqual({ s1: "c1" });
    expect(chat.snapshot().turns.map((turn) => turn.text)).toEqual(["answer to first", "answer to second"]);

    // A link panel's chat is its own and isn't remembered.
    chats.linked("s1", "c1");
    expect(pref(CONVERSATIONS)).toEqual({ s1: "c1" });

    const reopened = new GenieChats(fakeService(route, saved).service, {} as GenieOne).space("s1");
    expect(reopened.snapshot().loading).toBe(true);
    await until(() => Boolean(reopened.snapshot().turns[1]?.result));
    const turns = reopened.snapshot().turns;
    expect(turns.map((turn) => turn.question)).toEqual(["first", "second"]);
    expect(turns[0]!.result).toBeUndefined();
    expect(turns[1]!.result?.rows).toEqual([["1"]]);

    reopened.reset();
    expect(fakeService(route, saved).pref(CONVERSATIONS)).toBeUndefined();
  });

  it("starts over in another workspace, and an old chat doesn't save there", async () => {
    let finish!: (value: unknown) => void;
    const slow: Route = (method, path) => (method === "POST" && path.endsWith("/start-conversation") ? new Promise((resolve) => (finish = resolve)) : route(method, path));
    const fake = fakeService((method, path, body) => slow(method, path, body));
    const chats = new GenieChats(fake.service, {} as GenieOne);
    const chat = chats.space("s1");
    const asking = chat.ask("first");
    await until(() => Boolean(finish));
    fake.switchTo("https://other.example");
    finish({ conversation_id: "c1", message_id: "m1", message: message("m1", "first") });
    await asking;
    expect(chats.space("s1")).not.toBe(chat);
    expect(fake.pref(CONVERSATIONS)).toBeUndefined();
  });
});

describe("the SQL page", () => {
  const succeeded = (id: string) => ({
    statement_id: id,
    status: { state: "SUCCEEDED" },
    manifest: { schema: { columns: [{ name: "n", type_text: "INT" }] }, total_row_count: 1 },
    result: { data_array: [["42"]] },
  });

  it("gets a statement's result back by ID, waiting for one still running", async () => {
    let polls = 0;
    const sql = new Sql(
      fakeClient((method, path) => {
        if (path.endsWith("/s-run")) return polls++ ? succeeded("s-run") : { statement_id: "s-run", status: { state: "RUNNING" } };
        if (path.endsWith("/s-closed")) return { statement_id: "s-closed", status: { state: "CLOSED" } };
        return undefined;
      }),
    );
    const { result } = await sql.resume("s-run");
    expect(result.rows).toEqual([["42"]]);
    expect(polls).toBe(2);
    await expect(sql.resume("s-closed")).rejects.toThrow(/no longer keeps this result/);
    await expect(sql.resume("s-missing")).rejects.toThrow(/no longer keeps this result/);
  });

  it("keeps the statement and last run, and shows them again after a restart", async () => {
    const route: Route = (method, path, body) => {
      if (path === "/api/2.0/sql/warehouses") return { warehouses: [{ id: "w1", name: "Serverless", state: "RUNNING", enable_serverless_compute: true }] };
      if (method === "POST" && path === "/api/2.0/sql/statements") {
        expect((body as { statement: string }).statement).toBe("SELECT 42 AS n");
        return succeeded("s1");
      }
      if (method === "GET" && path.endsWith("/statements/s1")) return succeeded("s1");
      return undefined;
    };
    const { service, saved, pref } = fakeService(route);
    const runs = new Runs(service);
    const editor = new Editor(service, runs);
    editor.watch();
    editor.restore();
    editor.set("SELECT 42 AS n");
    editor.execute(editor.snapshot().text);
    await until(() => runs.get("SELECT 42 AS n")?.status === "done");
    // Leaving the page and coming back reads the same editor.
    expect(editor.snapshot().shown).toBe("SELECT 42 AS n");
    expect((pref(SQL_LAST_RUN) as SavedRun).statementId).toBe("s1");
    await until(() => pref(SQL_TEXT) === "SELECT 42 AS n");

    const restarted = fakeService(route, saved).service;
    const runsAgain = new Runs(restarted);
    const editorAgain = new Editor(restarted, runsAgain);
    editorAgain.restore();
    expect(editorAgain.snapshot()).toEqual({ text: "SELECT 42 AS n", shown: "SELECT 42 AS n" });
    await until(() => runsAgain.get("SELECT 42 AS n")?.status === "done");
    const run = runsAgain.get("SELECT 42 AS n");
    expect(run?.status === "done" && run.result.rows).toEqual([["42"]]);
    expect(run?.status === "done" && run.warehouse).toBe("Serverless");
  });

  it("keeps what was typed before the saved statement loaded", () => {
    const saved = new Map<string, unknown>([["https://w.example|sqlText", "SELECT 'saved'"]]);
    const { service } = fakeService(() => undefined, saved);
    const editor = new Editor(service, new Runs(service));
    editor.set("SELECT 'typed'");
    editor.restore();
    expect(editor.snapshot().text).toBe("SELECT 'typed'");
  });

  it("forgets runs when the workspace changes", async () => {
    const fake = fakeService((method, path) =>
      path === "/api/2.0/sql/warehouses" ? { warehouses: [{ id: "w1", name: "W" }] } : method === "POST" ? succeeded("s1") : undefined,
    );
    const runs = new Runs(fake.service);
    runs.watchWorkspace();
    await runs.run("SELECT 1");
    expect(runs.get("SELECT 1")?.status).toBe("done");
    fake.switchTo("https://other.example");
    expect(runs.get("SELECT 1")).toBeUndefined();
  });
});
