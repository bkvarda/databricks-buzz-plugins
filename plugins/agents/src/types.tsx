// The Databricks agent type, in three kinds (Sandbox agent, Genie One, custom
// agent). It runs through Buzz's harness kit: the kit
// decides which conversation a mention belongs to (and ignores mentions that
// are not the owner's), builds Buzz's prompts, answers Buzz's tools, and posts
// replies as the agent. Databricks does the thinking.
import type { AgentType, Agents, Delivery, HarnessConversation, HarnessKit } from "@buzz/author";
import type { ComponentType } from "react";
import { Ai, DEFAULT_MODEL, DEFAULT_MODELS, modelLabel } from "@dbx/core/api/ai";
import { Genie } from "@dbx/core/api/genie";
import { answerMarkdown, GenieOne } from "../../genie/src/genie-one";
import { SANDBOX_HOME, Sandboxes } from "@dbx/core/api/sandbox";
import { React } from "@dbx/core/react";
import { databricksIcon } from "@dbx/core/ui/components";
import { RESULT_LANGUAGE, resultBlock } from "@dbx/core/result";
import { type DatabricksService, describeError } from "@dbx/core/service";
import { fromAgentTool, GENIE_ONE_CHOICE, genieLocalTools, mcpLocalTools, normalizeChoices, type ToolChoice } from "./capabilities";
import { type LocalTool, runLoop, trimHistory } from "./loop";
import { sqlTools } from "../../sql/src/tools";
import { SANDBOX_PROMPT, sandboxFor, sandboxTools } from "./sandbox";
import { plainText, Sessions } from "./state";
import { type AgentKind, AgentForm, type CustomAgent, type DatabricksConfig, SettingsTab } from "./ui";

type Tab<C> = NonNullable<AgentType<C>["tabs"]>[number];
type PropsOf<T> = T extends ComponentType<infer P> ? P : never;
type TabProps<C> = PropsOf<Tab<C>["component"]>;
type CreateProps<C> = PropsOf<NonNullable<AgentType<C>["Create"]>>;

const TURN_TIMEOUT_MS = 30 * 60_000;

/** Runs one conversation's turns in order, so saved sessions never race. */
class Queue {
  private tails = new Map<string, Promise<unknown>>();
  private running = new Map<string, AbortController>();
  private listeners = new Set<() => void>();
  run<T>(key: string, work: (signal: AbortSignal) => Promise<T>): Promise<T> {
    const previous = this.tails.get(key) ?? Promise.resolve();
    const next = previous.catch(() => {}).then(async () => {
      const controller = new AbortController();
      this.running.set(key, controller);
      this.notify();
      try {
        return await work(controller.signal);
      } finally {
        if (this.running.get(key) === controller) this.running.delete(key);
        this.notify();
      }
    });
    this.tails.set(key, next);
    return next;
  }
  active(key: string) {
    return this.running.has(key);
  }
  interrupt(key: string) {
    this.running.get(key)?.abort();
  }
  subscribe(listener: () => void) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  private notify() {
    for (const listener of [...this.listeners]) listener();
  }
}

/** The text a mention or wake carries, for agents that want a plain question. */
function deliveredText(delivery: Delivery): string {
  const trigger = delivery.trigger as { type: string; event?: { content?: string }; text?: string };
  if (trigger.type === "mention") return plainText(trigger.event?.content ?? "");
  return trigger.text ?? "";
}

function provider(service: DatabricksService): NonNullable<AgentType["provider"]> {
  return {
    snapshot: () => {
      const status = service.snapshot().status;
      if (status === "connected") return { readiness: "ready" };
      if (status === "checking" || status === "connecting") return { readiness: "checking" };
      return { readiness: "attention", attentionLabel: "Connect Databricks" };
    },
    subscribe: (listener) => service.subscribe(listener),
    check: () => undefined,
    attentionAction: () => service.openSettings(),
    DialogBody: () => null,
  };
}

const conversationKey = (scope: "thread" | "channel", place: { channelId: string; root?: string }) =>
  scope === "thread" && place.root ? `${place.channelId}/${place.root}` : place.channelId;

const KIND_IDS: readonly AgentKind[] = ["sandbox", "genie-one", "custom"];

function normalizeCustom(value: unknown): CustomAgent | undefined {
  const agent = (value ?? {}) as Partial<CustomAgent>;
  if (!agent.kind || !["endpoint", "app", "genie"].includes(agent.kind) || typeof agent.target !== "string" || !agent.target) return undefined;
  if (agent.kind === "app" && !/^https:\/\//.test(agent.target)) return undefined;
  return {
    kind: agent.kind,
    target: agent.target,
    label: typeof agent.label === "string" && agent.label ? agent.label : agent.target,
    ...(typeof agent.task === "string" && agent.task && { task: agent.task }),
  };
}

export function normalizeDatabricks(config: unknown): DatabricksConfig {
  const value = (config ?? {}) as Partial<DatabricksConfig>;
  const custom = normalizeCustom(value.custom);
  // Agents saved before kinds existed were model agents.
  const kind = KIND_IDS.includes(value.kind as AgentKind) ? (value.kind as AgentKind) : typeof value.model === "string" && value.model ? "sandbox" : "genie-one";
  return {
    kind,
    model: typeof value.model === "string" && value.model ? value.model : DEFAULT_MODEL,
    instructions: typeof value.instructions === "string" ? value.instructions : "",
    scope: value.scope === "channel" ? "channel" : "thread",
    tools: normalizeChoices(value.tools),
    ...(typeof value.profile === "string" && value.profile && { profile: value.profile }),
    ...(custom && { custom }),
  };
}

/** The service for an agent: its own workspace profile, or Buzz's connection. */
export function agentService(service: DatabricksService, profile: string | undefined): DatabricksService {
  return profile && service.forProfile ? service.forProfile(profile) : service;
}

/**
 * Local tools for a Databricks agent and which Buzz tools to hide: an agent
 * on another workspace gets SQL, Genie and MCP bound to that workspace and
 * doesn't see the Buzz workspace's Databricks tools (memory still follows the
 * owner).
 */
async function databricksTools(
  service: DatabricksService,
  workspace: DatabricksService,
  config: DatabricksConfig,
  sandbox: LocalTool[],
  signal: AbortSignal,
): Promise<{ local: LocalTool[]; buzzFilter(name: string): boolean; problems: string[] }> {
  const same = workspace === service;
  const choices: readonly ToolChoice[] = config.tools;
  const genieOne = choices.some((choice) => choice.kind === "genie-one");
  const mcp = await mcpLocalTools(workspace, choices, signal);
  const local = [...sandbox, ...genieLocalTools(workspace, choices), ...mcp.tools, ...(same ? [] : sqlTools(workspace).map(fromAgentTool))];
  return {
    local,
    problems: mcp.problems,
    buzzFilter: (name) => {
      if (genieOne && name === "databricks_genie_one_ask") return false;
      if (!same && name.startsWith("databricks_") && !name.startsWith("databricks_memory_")) return false;
      return true;
    },
  };
}

/** How a Databricks agent shows data: Buzz draws result blocks as charts. */
export const RESULT_PROMPT = [
  "To show a query result or other table, put it in a fenced code block with the language",
  `\`${RESULT_LANGUAGE}\` whose body is CSV with a header row (up to 200 rows; quote values that contain commas).`,
  "Buzz draws it as an interactive chart with a table view, so you can chart data; don't say you can't.",
  "Put the label column (such as a date or category) first and the numeric columns after it, unformatted (no $ or thousands separators).",
].join(" ");

function toolsNote(workspace: DatabricksService, service: DatabricksService, problems: readonly string[]): string {
  const lines: string[] = [RESULT_PROMPT];
  if (workspace !== service) {
    const snapshot = workspace.snapshot();
    const host = snapshot.status === "connected" ? snapshot.profile.host : "another workspace";
    lines.push(`Your Databricks tools (SQL, Genie, MCP servers, Sandbox) work in ${host}, not the workspace Buzz is connected to.`);
  }
  if (problems.length) lines.push(`These tool servers didn't answer this turn, so their tools are missing: ${problems.join("; ")}.`);
  return lines.join("\n");
}

export function registerTypes(agents: Agents, kit: HarnessKit, service: DatabricksService) {
  // Buzz draws a type's icon in its harness choices; any SVG component works.
  const icon = databricksIcon() as unknown as AgentType["icon"];
  const genieOnes = new WeakMap<DatabricksService, GenieOne>();
  const genieOneFor = (workspace: DatabricksService) => {
    let found = genieOnes.get(workspace);
    if (!found) genieOnes.set(workspace, (found = new GenieOne(workspace)));
    return found;
  };
  // Whether Sandbox is on, per workspace, checked at most every 10 minutes.
  const sandboxChecks = new WeakMap<DatabricksService, { at: number; on: Promise<boolean> }>();
  const sandboxOn = (workspace: DatabricksService, signal: AbortSignal) => {
    const known = sandboxChecks.get(workspace);
    if (known && Date.now() - known.at < 10 * 60_000) return known.on;
    const on = workspace.ready(signal).then((client) => new Sandboxes(client).available(signal)).catch(() => true);
    sandboxChecks.set(workspace, { at: Date.now(), on });
    return on;
  };
  const sessions = new Sessions(agents.storage);
  const queue = new Queue();

  /** Wraps a turn: queueing, Stop, failure replies and the working state. */
  function turn(delivery: Delivery, conversation: HarnessConversation, work: (signal: AbortSignal) => Promise<void>) {
    delivery.acknowledged?.();
    const key = `${delivery.agent.key}|${conversation.key}`;
    const done = queue
      .run(key, (signal) => {
        const stop = () => queue.interrupt(key);
        delivery.signal.addEventListener("abort", stop, { once: true });
        delivery.interruptible?.(async () => stop());
        return work(signal).finally(() => delivery.signal.removeEventListener("abort", stop));
      })
      .then(
        () => ({ ok: true as const }),
        async (error: unknown) => {
          if ((error as Error)?.name === "AbortError" || (error as { name?: string })?.name === "TimeoutError")
            return { ok: true as const, stopped: true as const };
          const message = describeError(error);
          await kit.reply(delivery.agent, conversation, `I couldn't finish that: ${message}`, { notifyOwner: true }).catch(() => {});
          return { ok: false as const, error: message };
        },
      );
    delivery.workingUntil(done);
  }

  /** A Sandbox agent's tools and instructions for one turn. */
  async function sandboxSetup(delivery: Delivery, config: DatabricksConfig, workspace: DatabricksService, signal: AbortSignal, step?: (state: string) => void) {
    const on = await sandboxOn(workspace, signal);
    const sandbox = on ? sandboxTools(workspace, delivery.agent.pubkey, delivery.agent.name, step) : [];
    const tools = await databricksTools(service, workspace, config, sandbox, signal);
    const instructions = [
      config.instructions.trim(),
      on ? SANDBOX_PROMPT : "Databricks Sandbox isn't turned on in this workspace, so you can't run code or keep files this turn.",
      toolsNote(workspace, service, tools.problems),
    ]
      .filter(Boolean)
      .join("\n\n");
    return { tools, instructions, cwd: on ? `${SANDBOX_HOME}/work` : "~" };
  }

  async function sandboxTurn(delivery: Delivery, config: DatabricksConfig, conversation: HarnessConversation, signal: AbortSignal) {
    const workspace = agentService(service, config.profile);
    const client = await workspace.ready(signal);
    const session = sessions.get(delivery.agent.key, conversation.key);
    const { tools, instructions, cwd } = await sandboxSetup(delivery, config, workspace, signal, (state) => delivery.step?.("sandbox", state));
    const system = await kit.systemPrompt(delivery, { scope: config.scope, cwd, instructions, tools: true });
    const prompt = await kit.turnPrompt(delivery, conversation, session.cursor ? { cursor: session.cursor } : {});
    const ai = new Ai(client);
    let answered = false;
    try {
      const result = await runLoop({
        model: delivery.model ?? config.model,
        system,
        history: session.messages,
        prompt: prompt.text,
        buzz: kit.tools(delivery.agent, conversation),
        buzzFilter: tools.buzzFilter,
        local: tools.local,
        chat: async (request) => {
          const completion = await ai.chat(request);
          answered = true;
          return completion;
        },
        signal,
        onStep: (tool, target) => delivery.step?.(tool, target),
      });
      if (!result.posted && result.text.trim()) await kit.reply(delivery.agent, conversation, result.text.trim());
      await sessions.set(delivery.agent.key, conversation.key, {
        ...session,
        cursor: prompt.cursor,
        messages: trimHistory([...session.messages, ...result.messages]),
      });
    } catch (error) {
      if (!answered) prompt.restore();
      throw error;
    }
  }

  async function genieOneTurn(delivery: Delivery, config: DatabricksConfig, conversation: HarnessConversation, signal: AbortSignal) {
    const question = deliveredText(delivery) || "What can I ask you about?";
    const session = sessions.get(delivery.agent.key, conversation.key);
    delivery.step?.("genie", "Genie One");
    const answer = await genieOneFor(agentService(service, config.profile)).ask(question, {
      ...(session.genieOneConversationId && { conversationId: session.genieOneConversationId }),
      signal,
      onProgress: (steps) => {
        const last = steps[steps.length - 1] ?? "";
        delivery.step?.("genie", /^Running SQL/.test(last) ? "running SQL" : /^Query result/.test(last) ? "reading the result" : "thinking");
      },
    });
    const parts: string[] = [];
    // Tables go out as result blocks, which Buzz draws as charts.
    const text = answerMarkdown(answer);
    if (text) parts.push(text);
    if (answer.status === "incomplete") parts.push("_Genie One stopped early; this may be partial._");
    const sql = answer.sql[answer.sql.length - 1];
    if (sql) parts.push(`\`\`\`sql\n${sql.trim()}\n\`\`\``);
    if (answer.deepLink) parts.push(`[Explore in Databricks](${answer.deepLink})`);
    await kit.reply(delivery.agent, conversation, parts.join("\n\n") || "Genie One had no answer.");
    await sessions.set(delivery.agent.key, conversation.key, { ...session, genieOneConversationId: answer.conversationId });
  }

  async function genieSpaceTurn(delivery: Delivery, config: DatabricksConfig, agent: CustomAgent, conversation: HarnessConversation, signal: AbortSignal) {
    const workspace = agentService(service, config.profile);
    const client = await workspace.ready(signal);
    const question = deliveredText(delivery) || "What can I ask you about?";
    const session = sessions.get(delivery.agent.key, conversation.key);
    delivery.step?.("genie", agent.label);
    const answer = await new Genie(client).answer(agent.target, question, {
      ...(session.genieConversationId && { conversationId: session.genieConversationId }),
      signal,
      onUpdate: (message) => delivery.step?.("genie", message.status.toLowerCase().replace(/_/g, " ")),
    });
    const link = workspace.workspaceUrl(Genie.webPath(agent.target, answer.message.conversation_id));
    const parts: string[] = [];
    if (answer.text) parts.push(answer.text);
    if (answer.result?.columns.length) parts.push(resultBlock(answer.result));
    if (answer.sql) parts.push(`\`\`\`sql\n${answer.sql.trim()}\n\`\`\``);
    if (answer.message.status !== "COMPLETED") parts.push(`Genie stopped with status ${answer.message.status}${answer.error ? `: ${answer.error}` : ""}.`);
    if (answer.suggestions.length) parts.push(`_You could also ask:_ ${answer.suggestions.slice(0, 3).map((q) => `“${q}”`).join(" · ")}`);
    if (link) parts.push(`[Open in Genie](${link})`);
    await kit.reply(delivery.agent, conversation, parts.join("\n\n") || "Genie had no answer.");
    await sessions.set(delivery.agent.key, conversation.key, { ...session, genieConversationId: answer.message.conversation_id });
  }

  async function customTurn(delivery: Delivery, config: DatabricksConfig, conversation: HarnessConversation, signal: AbortSignal) {
    const agent = config.custom;
    if (!agent) throw new Error("No agent is chosen yet. My owner can pick one in my Settings.");
    if (agent.kind === "genie") return genieSpaceTurn(delivery, config, agent, conversation, signal);
    const client = await agentService(service, config.profile).ready(signal);
    const session = sessions.get(delivery.agent.key, conversation.key);
    const question = deliveredText(delivery);
    const history = session.messages.filter((m): m is { role: "user" | "assistant"; content: string } => (m.role === "user" || m.role === "assistant") && typeof m.content === "string");
    const messages = [...history, { role: "user" as const, content: question || "Hello" }];
    delivery.step?.("agent", agent.label);
    const reply = await new Ai(client).invokeAgent(agent.target, messages, {
      task: agent.kind === "app" ? "app" : (agent.task ?? ""),
      sessionId: `${delivery.agent.pubkey.slice(0, 16)}-${conversation.key}`,
      signal,
    });
    await kit.reply(delivery.agent, conversation, reply.text || "(The agent returned no text.)");
    await sessions.set(delivery.agent.key, conversation.key, {
      ...session,
      messages: trimHistory([...messages, { role: "assistant", content: reply.text }], 60_000, 40),
    });
  }

  const scopeOf = (config: DatabricksConfig) => (config.kind === "sandbox" ? config.scope : "thread");

  // ── One Databricks type: a Sandbox agent, Genie One, or a custom agent ──
  const databricksType: AgentType<DatabricksConfig> = {
    id: "databricks",
    icon,
    title: "Databricks",
    description: "Genie One for data questions, a Sandbox agent with a Databricks model and the tools you pick, or an agent you built on Databricks.",
    provider: provider(service),
    // Genie One needs no setup: it finds the right data across the workspace.
    defaults: () => ({ config: normalizeDatabricks({ kind: "genie-one", tools: [GENIE_ONE_CHOICE] }) }),
    summary: (agent) => summarize(normalizeDatabricks(agent.config)),
    adopt: (carry, config) => ({ ...config, instructions: carry.instructions ?? config.instructions }),
    carry: (config) => (config.instructions.trim() ? { instructions: config.instructions } : {}),
    Create: (props: CreateProps<DatabricksConfig>) => (
      <AgentForm service={service} config={normalizeDatabricks(props.config)} onChange={props.onChange} disabled={props.disabled} />
    ),
    tabs: [
      {
        id: "settings",
        title: "Settings",
        role: "settings",
        component: (props: TabProps<DatabricksConfig>) => (
          <SettingsTab
            service={service}
            config={normalizeDatabricks(props.agent.config)}
            save={props.save}
            Form={AgentForm}
            note={normalizeDatabricks(props.agent.config).kind === "sandbox" ? <SandboxNote service={service} pubkey={props.agent.pubkey} /> : null}
          />
        ),
      },
    ],
    models: (agent) => {
      const config = normalizeDatabricks(agent.config);
      if (config.kind !== "sandbox") return { current: "", models: [] };
      const models: { id: string; label: string; efforts: never[] }[] = DEFAULT_MODELS.map((model) => ({ id: model.id, label: model.label, efforts: [] }));
      if (!models.some((model) => model.id === config.model)) models.unshift({ id: config.model, label: modelLabel(config.model), efforts: [] });
      return { current: config.model, models };
    },
    sessionControls: {
      scope: (agent) => scopeOf(normalizeDatabricks(agent.config)),
      state: (agent, place) => (queue.active(`${agent.key}|${conversationKey(scopeOf(normalizeDatabricks(agent.config)), place)}`) ? "active" : "idle"),
      async run(agent, place, action) {
        const config = normalizeDatabricks(agent.config);
        const key = conversationKey(scopeOf(config), place);
        if (action === "interrupt") return queue.interrupt(`${agent.key}|${key}`);
        if (action === "new") return sessions.clear(agent.key, key);
        if (config.kind !== "sandbox") return;
        const session = sessions.get(agent.key, key);
        await sessions.set(agent.key, key, { ...session, messages: trimHistory(session.messages, 20_000, 12) });
      },
      subscribe: (listener) => queue.subscribe(listener),
    },
    timeoutMs: TURN_TIMEOUT_MS,
    async run(delivery) {
      const config = normalizeDatabricks(delivery.config);
      const conversation = await kit.conversation(delivery, scopeOf(config));
      if (!conversation) {
        delivery.ignored?.();
        return;
      }
      turn(delivery, conversation, (signal) =>
        config.kind === "sandbox"
          ? sandboxTurn(delivery, config, conversation, signal)
          : config.kind === "custom"
            ? customTurn(delivery, config, conversation, signal)
            : genieOneTurn(delivery, config, conversation, signal),
      );
    },
    async runOnce(standalone) {
      const config = normalizeDatabricks(standalone.delivery.config);
      if (config.kind !== "sandbox") return { ok: false, error: "Watches and timers run on Sandbox agents; Genie One and custom agents answer mentions." };
      try {
        const prompt = await standalone.prompt();
        if (!prompt) return { ok: true };
        const workspace = agentService(service, config.profile);
        const client = await workspace.ready(standalone.signal);
        const { tools, instructions } = await sandboxSetup(standalone.delivery, config, workspace, standalone.signal);
        const system = await kit.systemPrompt(standalone.delivery, { scope: config.scope, cwd: "~", instructions, tools: true });
        const ai = new Ai(client);
        await runLoop({
          model: config.model,
          system,
          history: [],
          prompt,
          buzz: kit.tools(standalone.delivery.agent),
          buzzFilter: tools.buzzFilter,
          local: tools.local,
          chat: (request) => ai.chat(request),
          signal: standalone.signal,
          onStep: (tool, target) => standalone.delivery.step?.(tool, target),
        });
        return { ok: true };
      } catch (error) {
        return { ok: false, error: describeError(error) };
      }
    },
  };

  agents.register(databricksType);
}

/** One short line under the agent's name. */
export function summarize(config: DatabricksConfig): string {
  const where = config.profile ? [config.profile] : [];
  if (config.kind === "genie-one") return ["Genie One", ...where].join(" · ");
  if (config.kind === "custom") return [config.custom?.label ?? "No agent chosen", ...where].join(" · ");
  const model = DEFAULT_MODELS.find((candidate) => candidate.id === config.model)?.label ?? modelLabel(config.model);
  const tools = config.tools.length ? [`${config.tools.length} ${config.tools.length === 1 ? "tool" : "tools"}`] : [];
  return ["Sandbox", model, ...tools, ...where].join(" · ");
}

function SandboxNote(props: { service: DatabricksService; pubkey: string }) {
  const url = props.service.workspaceUrl("/compute/sandboxes");
  return (
    <div data-dbx="" style={{ fontSize: "0.75rem", color: "var(--dbx-subtle)" }}>
      Sandbox <span className="dbx-mono">{sandboxFor(props.pubkey)}</span> belongs to you in Databricks. It runs up to 24 hours per start and keeps{" "}
      <span className="dbx-mono">{SANDBOX_HOME}</span>.{" "}
      {url && (
        <a className="dbx-link" href={url} target="_blank" rel="noreferrer">
          Manage sandboxes
        </a>
      )}
    </div>
  );
}

export const __test = { deliveredText, conversationKey, React };
