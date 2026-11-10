// Genie chats live in the plugin, not in the page that shows them: a question
// keeps running while you're elsewhere in Buzz, and the chat is still there
// when you come back (Buzz removes a page when you leave it).
//
// The Genie page's chats are also remembered with the suite's preferences, per
// workspace on this device: each Genie agent's open conversation, and Genie
// One's conversation with each turn's response ID. Databricks keeps both, so
// after a restart the page reloads them from there; Genie One has no way to
// list a conversation's turns, so its question, steps and times are kept here.
// A question still running when Buzz closed is picked up again.
import { Genie, type GenieMessage, messageId, summarize, TERMINAL } from "@dbx/core/api/genie";
import { React } from "@dbx/core/react";
import { type DatabricksService, describeError } from "@dbx/core/service";
import type { Turn } from "./chat";
import { type GenieOne, retryLine } from "./genie-one";
import type { OneTurn } from "./genie-one-chat";

/** Preference: Genie agent (space ID) → its open conversation on the Genie page. */
export const CONVERSATIONS = "genieConversations";
/** Preference: the Genie page's Genie One chat. */
export const GENIE_ONE_CHAT = "genieOneChat";
/** Genie One turns remembered, newest kept. */
export const KEEP_ONE_TURNS = 10;
const KEEP_STEPS = 12;

type Listener = () => void;

let turnCount = 0;
/** A key for a new turn, unique even within one millisecond. */
const turnKey = (prefix: string) => `${prefix}-${Date.now()}-${++turnCount}`;

/** A snapshot, a subscription and a setter: what `useSyncExternalStore` reads. */
class Store<S extends object> {
  private listeners = new Set<Listener>();
  constructor(protected state: S) {}
  snapshot = () => this.state;
  subscribe = (listener: Listener) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };
  protected set(change: Partial<S> | ((state: S) => Partial<S>)) {
    this.state = { ...this.state, ...(typeof change === "function" ? change(this.state) : change) };
    for (const listener of [...this.listeners]) listener();
  }
}

export function useChat<S extends object>(chat: Store<S>): S {
  return React.useSyncExternalStore(chat.subscribe, chat.snapshot);
}

/** A chat of the component's own (the composer's), stopped when it goes. */
export function useOwnChat<T extends { dispose(): void }>(create: () => T, deps: React.DependencyList): T {
  const chat = React.useMemo(create, deps);
  React.useEffect(() => () => chat.dispose(), [chat]);
  return chat;
}

// ── A Genie agent ──

export type SpaceChatState = Readonly<{
  conversationId?: string;
  turns: readonly Turn[];
  busy: boolean;
  /** Loading an earlier conversation. */
  loading: boolean;
  historyError?: string;
}>;

export function turnFromMessage(message: GenieMessage): Turn {
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

export class SpaceChat extends Store<SpaceChatState> {
  private asking: AbortController | undefined;
  private history: AbortController | undefined;
  /** Disposed: it no longer saves (its workspace may have changed). */
  private gone = false;

  constructor(
    private readonly service: DatabricksService,
    readonly spaceId: string,
    conversationId?: string,
    /** Told the conversation this chat continues, or undefined after New chat. */
    private readonly remember?: (conversationId: string | undefined) => void,
  ) {
    super({ turns: [], busy: false, loading: false, ...(conversationId && { conversationId }) });
    if (conversationId) void this.reopen(conversationId);
  }

  private update(key: string, change: Partial<Turn>) {
    this.set((state) => ({ turns: state.turns.map((turn) => (turn.key === key ? { ...turn, ...change } : turn)) }));
  }

  private continues(conversationId: string | undefined) {
    if (!conversationId || conversationId === this.state.conversationId) return;
    this.set({ conversationId });
    if (!this.gone) this.remember?.(conversationId);
  }

  /** Loads an earlier conversation, follows a question still running in it,
   * and shows the latest answer's result. */
  private async reopen(conversationId: string) {
    const controller = new AbortController();
    this.history = controller;
    this.set({ loading: true });
    try {
      const client = await this.service.ready(controller.signal);
      const response = await client.get<{ messages?: GenieMessage[] }>(
        `/api/2.0/genie/spaces/${encodeURIComponent(this.spaceId)}/conversations/${encodeURIComponent(conversationId)}/messages`,
        { query: { page_size: 50 }, signal: controller.signal },
      );
      if (controller.signal.aborted) return;
      const messages = [...(response.messages ?? [])]
        .map((message) => ({ ...message, conversation_id: conversationId }))
        .sort((a, b) => (a.created_timestamp ?? 0) - (b.created_timestamp ?? 0));
      this.set({ turns: messages.map(turnFromMessage), loading: false });
      const last = messages[messages.length - 1];
      if (last && !TERMINAL.has(last.status)) await this.follow(last, controller);
      const latest = this.state.turns[this.state.turns.length - 1];
      if (latest?.sql && !latest.result && !controller.signal.aborted) await this.loadResult(latest.key);
    } catch (error) {
      if (!controller.signal.aborted) this.set({ loading: false, historyError: describeError(error) });
    } finally {
      if (this.history === controller) this.history = undefined;
    }
  }

  /** Waits for a question asked before Buzz last closed. */
  private async follow(message: GenieMessage, controller: AbortController) {
    const key = messageId(message);
    this.asking = controller;
    this.set({ busy: true });
    try {
      const client = await this.service.ready(controller.signal);
      const genie = new Genie(client);
      const settled = await genie.wait(this.spaceId, message, (update) => this.update(key, { message: update }), controller.signal);
      this.update(key, turnFromMessage(settled));
      const attachment = summarize(settled).queryAttachmentId;
      if (settled.status === "COMPLETED" && attachment) this.update(key, { result: await genie.result(this.spaceId, settled, attachment, controller.signal) });
    } catch (error) {
      if (!controller.signal.aborted) this.update(key, { error: describeError(error) });
    } finally {
      if (this.asking === controller) this.set({ busy: false });
    }
  }

  async loadResult(key: string) {
    const turn = this.state.turns.find((candidate) => candidate.key === key);
    const message = turn?.message;
    const attachment = message && summarize(message).queryAttachmentId;
    if (!message || !attachment) return;
    this.update(key, { loadingResult: true });
    try {
      const client = await this.service.ready();
      const result = await new Genie(client).result(this.spaceId, message, attachment);
      this.update(key, { result, loadingResult: false });
    } catch (error) {
      this.update(key, { loadingResult: false, error: describeError(error) });
    }
  }

  async ask(question: string) {
    const text = question.trim();
    if (!text || this.state.busy) return;
    this.asking?.abort();
    const controller = new AbortController();
    this.asking = controller;
    let current = turnKey("pending");
    this.set((state) => ({ turns: [...state.turns, { key: current, question: text, suggestions: [] }], busy: true }));
    try {
      const client = await this.service.ready(controller.signal);
      const answer = await new Genie(client).answer(this.spaceId, text, {
        ...(this.state.conversationId && { conversationId: this.state.conversationId }),
        signal: controller.signal,
        onUpdate: (message) => {
          const previous = current;
          current = messageId(message) || current;
          this.update(previous, { key: current, message });
          this.continues(message.conversation_id);
        },
      });
      this.continues(answer.message.conversation_id);
      this.update(current, {
        message: answer.message,
        suggestions: answer.suggestions,
        ...(answer.text && { text: answer.text }),
        ...(answer.sql && { sql: answer.sql }),
        ...(answer.queryTitle && { queryTitle: answer.queryTitle }),
        ...(answer.result && { result: answer.result }),
        ...(answer.error && { error: answer.error }),
      });
    } catch (error) {
      if (!controller.signal.aborted) this.update(current, { error: describeError(error) });
    } finally {
      if (this.asking === controller) this.set({ busy: false });
    }
  }

  /** New chat: forgets this conversation (Databricks keeps it). */
  reset() {
    this.halt();
    this.set({ turns: [], busy: false, loading: false, conversationId: undefined, historyError: undefined });
    if (!this.gone) this.remember?.(undefined);
  }

  private halt() {
    this.asking?.abort();
    this.history?.abort();
  }

  dispose() {
    this.gone = true;
    this.halt();
  }
}

// ── Genie One ──

export type OneChatState = Readonly<{ conversationId?: string; turns: readonly OneTurn[]; busy: boolean }>;

/** A Genie One turn as remembered: Genie One gives its answer back by response ID. */
export type SavedOneTurn = Readonly<{
  question: string;
  responseId?: string;
  steps?: readonly string[];
  started: number;
  finished?: number;
  error?: string;
}>;
export type SavedOneChat = Readonly<{ conversationId: string; turns: readonly SavedOneTurn[] }>;

const clip = (text: string, max: number) => (text.length > max ? `${text.slice(0, max - 1)}…` : text);

/**
 * What to remember of a chat: its newest turns, without answers or results.
 * A turn Genie One has (it has a response ID) is remembered without an error
 * of ours, unless you stopped it: a request cut off as Buzz closes fails, and
 * after a restart Genie One gives back the answer, or its own error.
 */
export function saveOneChat(state: OneChatState): SavedOneChat | undefined {
  if (!state.conversationId) return undefined;
  return {
    conversationId: state.conversationId,
    turns: state.turns.slice(-KEEP_ONE_TURNS).map((turn) => {
      const askAgain = Boolean(turn.responseId && turn.error && !turn.answer && !turn.stopped);
      return {
        question: clip(turn.question, 2000),
        started: turn.started,
        ...(turn.responseId && { responseId: turn.responseId }),
        ...(turn.steps.length && { steps: turn.steps.slice(-KEEP_STEPS).map((step) => clip(step, 300)) }),
        ...(turn.finished && !askAgain && { finished: turn.finished }),
        ...(turn.error && !askAgain && { error: clip(turn.error, 300) }),
      };
    }),
  };
}

export class OneChat extends Store<OneChatState> {
  private asking: AbortController | undefined;
  private reopening: AbortController | undefined;
  /** Disposed: it no longer saves (its workspace may have changed). */
  private gone = false;

  constructor(
    private readonly genieOne: GenieOne,
    saved?: SavedOneChat,
    private readonly remember?: (chat: SavedOneChat | undefined) => void,
  ) {
    super({ turns: [], busy: false, ...(saved && { conversationId: saved.conversationId }) });
    if (saved?.turns.length) void this.reopen(saved);
  }

  private save() {
    if (!this.gone) this.remember?.(saveOneChat(this.state));
  }

  private update(key: string, change: Partial<OneTurn>) {
    this.set((state) => ({ turns: state.turns.map((turn) => (turn.key === key ? { ...turn, ...change } : turn)) }));
  }

  /** Shows the remembered turns, then gets each answer back from Genie One, newest first. */
  private async reopen(saved: SavedOneChat) {
    const controller = new AbortController();
    this.reopening = controller;
    const turns: OneTurn[] = saved.turns.map((turn, index) => ({
      key: `saved-${index}-${turn.started}`,
      question: turn.question,
      steps: turn.steps ?? [],
      started: turn.started,
      ...(turn.finished && { finished: turn.finished }),
      ...(turn.responseId && { responseId: turn.responseId }),
      ...(turn.error ? { error: turn.error } : turn.responseId ? { reopening: true } : { error: "This question didn't reach Genie One." }),
    }));
    const unfinished = turns.some((turn) => turn.reopening && !turn.finished);
    this.set({ turns, busy: unfinished });
    try {
      for (const turn of [...turns].reverse()) {
        if (!turn.reopening || !turn.responseId) continue;
        try {
          const answer = await this.genieOne.response(saved.conversationId, turn.responseId, {
            signal: controller.signal,
            onProgress: (steps) => this.update(turn.key, { steps: [...steps] }),
          });
          this.update(turn.key, {
            answer,
            reopening: false,
            steps: answer.steps.length ? [...answer.steps] : turn.steps,
            finished: turn.finished ?? Date.now(),
          });
        } catch (error) {
          if (controller.signal.aborted) return;
          this.update(turn.key, { reopening: false, error: `Couldn't get this answer back from Genie One: ${describeError(error)}`, finished: turn.finished ?? Date.now() });
        }
        if (!turn.finished) this.save();
      }
    } finally {
      if (this.reopening === controller) {
        this.reopening = undefined;
        if (unfinished) this.set({ busy: false });
      }
    }
  }

  async ask(question: string) {
    const text = question.trim();
    if (!text || this.state.busy) return;
    const controller = new AbortController();
    this.asking = controller;
    const key = turnKey("one");
    this.set((state) => ({ turns: [...state.turns, { key, question: text, steps: [], started: Date.now() }], busy: true }));
    let steps: readonly string[] = [];
    try {
      const answer = await this.genieOne.ask(text, {
        ...(this.state.conversationId && { conversationId: this.state.conversationId }),
        signal: controller.signal,
        onStarted: ({ conversationId, responseId }) => {
          this.set({ conversationId });
          this.update(key, { responseId });
          this.save();
        },
        onProgress: (next) => {
          steps = next;
          this.update(key, { steps: [...next] });
        },
        // A wait while Databricks rate-limits Genie One shows as the latest step; a question asked again starts over.
        onRetry: (notice) => {
          if (notice.restarted) steps = [];
          this.update(key, { steps: [...steps, retryLine(notice)] });
        },
      });
      this.set({ conversationId: answer.conversationId });
      this.update(key, { answer, steps: [...answer.steps], finished: Date.now() });
    } catch (error) {
      if (!controller.signal.aborted) this.update(key, { error: describeError(error), finished: Date.now() });
    } finally {
      if (this.asking === controller) this.set({ busy: false });
      this.save();
    }
  }

  stop() {
    this.asking?.abort();
    this.reopening?.abort();
    this.set((state) => ({
      busy: false,
      turns: state.turns.map((turn) => (turn.answer || turn.error ? turn : { ...turn, reopening: false, stopped: true, error: "Stopped.", finished: Date.now() })),
    }));
    this.save();
  }

  /** New chat: forgets this conversation (Databricks keeps it). */
  reset() {
    this.halt();
    this.set({ turns: [], busy: false, conversationId: undefined });
    if (!this.gone) this.remember?.(undefined);
  }

  private halt() {
    this.asking?.abort();
    this.reopening?.abort();
  }

  dispose() {
    this.gone = true;
    this.halt();
  }
}

// ── The plugin's chats ──

const hostOf = (service: DatabricksService) => {
  const snapshot = service.snapshot();
  return snapshot.status === "connected" ? snapshot.profile.host : undefined;
};

/** Every chat the Genie plugin shows, for as long as the plugin runs. A
 * workspace change starts them all over. */
export class GenieChats {
  private spaces = new Map<string, SpaceChat>();
  private one: OneChat | undefined;
  private host: string | undefined;
  private readonly stopWatching: () => void;

  constructor(
    private readonly service: DatabricksService,
    private readonly genieOne: GenieOne,
  ) {
    this.host = hostOf(service);
    this.stopWatching = service.subscribe(() => {
      const host = hostOf(service);
      if (host === this.host) return;
      this.host = host;
      this.clear();
    });
  }

  /** The Genie page's chat with a Genie agent: it reopens the conversation it had. */
  space(spaceId: string): SpaceChat {
    const key = `page|${spaceId}`;
    let chat = this.spaces.get(key);
    if (!chat) {
      const prefs = this.service.preferences;
      const saved = prefs.get<Record<string, string>>(CONVERSATIONS)?.[spaceId];
      chat = new SpaceChat(this.service, spaceId, saved, (conversationId) => {
        const next = { ...(prefs.get<Record<string, string>>(CONVERSATIONS) ?? {}) };
        if (conversationId) next[spaceId] = conversationId;
        else delete next[spaceId];
        prefs.set(CONVERSATIONS, Object.keys(next).length ? next : undefined);
      });
      this.spaces.set(key, chat);
    }
    return chat;
  }

  /** A chat opened from a Genie link: kept while Buzz runs, not remembered. */
  linked(spaceId: string, conversationId?: string): SpaceChat {
    const key = `link|${spaceId}|${conversationId ?? ""}`;
    let chat = this.spaces.get(key);
    if (!chat) {
      chat = new SpaceChat(this.service, spaceId, conversationId);
      this.spaces.set(key, chat);
    }
    return chat;
  }

  /** The Genie page's Genie One chat: it reopens the conversation it had. */
  genieOneChat(): OneChat {
    if (!this.one) {
      const prefs = this.service.preferences;
      const saved = prefs.get<SavedOneChat>(GENIE_ONE_CHAT);
      this.one = new OneChat(this.genieOne, saved?.conversationId ? saved : undefined, (chat) => prefs.set(GENIE_ONE_CHAT, chat));
    }
    return this.one;
  }

  private clear() {
    for (const chat of this.spaces.values()) chat.dispose();
    this.one?.dispose();
    this.spaces.clear();
    this.one = undefined;
  }

  dispose() {
    this.stopWatching();
    this.clear();
  }
}
