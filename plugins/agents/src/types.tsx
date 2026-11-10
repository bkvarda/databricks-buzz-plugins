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
import { databricksIcon, Text } from "@dbx/core/ui/components";
import { RESULT_LANGUAGE, resultBlock } from "@dbx/core/result";
import { Skills } from "@dbx/core/api/skills";
import { type DatabricksService, describeError } from "@dbx/core/service";
import { fromAgentTool, GENIE_ONE_CHOICE, genieLocalTools, mcpLocalTools, normalizeChoices, type ToolChoice, toolLabels, workspaceIdOf } from "./capabilities";
import { uploadRunner } from "./runner-upload";
import { genieOneStep, genieStatusStep, rateLimitStep } from "./activity";
import { ActivityLog, type TurnReporter } from "./activity-log";
import { type ActivityTabProps, ActivityView } from "./activity-ui";
import { type LocalTool, runLoop, trimHistory } from "./loop";
import { sqlTools } from "../../sql/src/tools";
import { HARNESS_IDS, RESULT_PROMPT, type HarnessId, harnessAccepts, harnessLabel, harnessModel, isRemote, type RemoteHarness, remoteNote, runRemoteTurn, WORK_DIR } from "./remote";
import { ensureAgentSandbox, SANDBOX_PROMPT, sandboxFor, sandboxTools } from "./sandbox";
import { normalizeSkills, resolveSkills, type SkillApi, skillCatalogFor, skillsNote, skillsSection, skillTools } from "./skills";
import { installSkills } from "./skills-sandbox";
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
    harness: HARNESS_IDS.includes(value.harness as HarnessId) ? (value.harness as HarnessId) : "builtin",
    permissions: value.permissions === "full" ? "full" : "standard",
    model: typeof value.model === "string" && value.model ? value.model : DEFAULT_MODEL,
    instructions: typeof value.instructions === "string" ? value.instructions : "",
    scope: value.scope === "channel" ? "channel" : "thread",
    tools: normalizeChoices(value.tools),
    skills: normalizeSkills(value.skills),
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
  const activity = new ActivityLog(agents.storage);

  /** Wraps a turn: queueing, Stop, failure replies, the working state and its Activity record. */
  function turn(delivery: Delivery, conversation: HarnessConversation, config: DatabricksConfig, work: (signal: AbortSignal, report: TurnReporter) => Promise<void>) {
    delivery.acknowledged?.();
    const key = `${delivery.agent.key}|${conversation.key}`;
    const report = activity.start(delivery, {
      channelId: conversation.channel,
      ...(conversation.root && { root: conversation.root }),
      request: deliveredText(delivery),
      labels: toolLabels(config.tools),
    });
    const done = queue
      .run(key, (signal) => {
        const stop = () => queue.interrupt(key);
        delivery.signal.addEventListener("abort", stop, { once: true });
        delivery.interruptible?.(async () => stop());
        return work(signal, report).finally(() => delivery.signal.removeEventListener("abort", stop));
      })
      .then(
        () => {
          report.end("done");
          return { ok: true as const };
        },
        async (error: unknown) => {
          if ((error as Error)?.name === "AbortError" || (error as { name?: string })?.name === "TimeoutError") {
            report.end("stopped");
            return { ok: true as const, stopped: true as const };
          }
          const message = describeError(error);
          report.end("error", message);
          await kit.reply(delivery.agent, conversation, `I couldn't finish that: ${message}`, { notifyOwner: true }).catch(() => {});
          return { ok: false as const, error: message };
        },
      );
    delivery.workingUntil(done);
  }

  /** The skills an agent has for a turn, in the channel the turn is in. */
  const skillsFor = (config: DatabricksConfig, channelId: string | undefined) => resolveSkills(skillCatalogFor(service, config.profile), normalizeSkills(config.skills), channelId);

  /** A Sandbox agent's tools and instructions for one turn. */
  async function sandboxSetup(delivery: Delivery, config: DatabricksConfig, workspace: DatabricksService, signal: AbortSignal, step?: (state: string) => void, channelId?: string) {
    const on = await sandboxOn(workspace, signal);
    const sandbox = on ? sandboxTools(workspace, delivery.agent.pubkey, delivery.agent.name, step) : [];
    const tools = await databricksTools(service, workspace, config, sandbox, signal);
    const skills = await skillsFor(config, channelId).catch((error: unknown) => ({ skills: [], problems: [describeError(error)] }));
    const skillApi = async (skillSignal: AbortSignal): Promise<SkillApi> => new Skills(await workspace.ready(skillSignal));
    const local = skills.skills.length ? [...tools.local, ...skillTools(skillApi, skills.skills)] : tools.local;
    const instructions = [
      config.instructions.trim(),
      on ? SANDBOX_PROMPT : "Databricks Sandbox isn't turned on in this workspace, so you can't run code or keep files this turn.",
      skillsSection(skills.skills),
      skills.problems.length ? `Skills that didn't load this turn: ${skills.problems.join("; ")}.` : "",
      toolsNote(workspace, service, tools.problems),
    ]
      .filter(Boolean)
      .join("\n\n");
    return { tools: { ...tools, local }, instructions, cwd: on ? `${SANDBOX_HOME}/work` : "~" };
  }

  async function sandboxTurn(delivery: Delivery, config: DatabricksConfig, conversation: HarnessConversation, signal: AbortSignal, report: TurnReporter) {
    const workspace = agentService(service, config.profile);
    const client = await workspace.ready(signal);
    const session = sessions.get(delivery.agent.key, conversation.key);
    const { tools, instructions, cwd } = await sandboxSetup(delivery, config, workspace, signal, (state) => report.tool("sandbox", state), conversation.channel);
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
        onStep: (tool, target) => report.tool(tool, target),
        onThought: (text) => report.thought(text),
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

  /** A Sandbox agent whose harness is Claude Code, Codex or Pi, running in its Sandbox. */
  async function remoteTurn(delivery: Delivery, config: DatabricksConfig, harness: RemoteHarness, conversation: HarnessConversation, signal: AbortSignal, report: TurnReporter) {
    const workspace = agentService(service, config.profile);
    const client = await workspace.ready(signal);
    if (!(await sandboxOn(workspace, signal)))
      throw new Error(`Databricks Sandbox isn't turned on in this workspace, and ${harnessLabel(harness)} runs there. A workspace admin can turn on the Sandbox preview.`);
    const sandbox = await ensureAgentSandbox(workspace, delivery.agent.pubkey, delivery.agent.name, signal, (state) => report.tool("sandbox", state));
    // The agent's Genie and MCP picks reach the harness through the runner bundle's tools bridge.
    const tools = config.tools.length ? { tools: config.tools, ...(workspaceIdOf(workspace) && { workspaceId: workspaceIdOf(workspace) }) } : undefined;
    if (tools) await uploadRunner(sandbox, sandboxFor(delivery.agent.pubkey), signal);
    const session = sessions.get(delivery.agent.key, conversation.key);
    // A session of another harness (or the built-in loop) doesn't carry over: the new one is shown the conversation.
    const continued = session.remote?.harness === harness ? { harness, id: session.remote.id } : undefined;
    // Installed before the harness starts, so it finds them in its skill folders on its own.
    const skills = await skillsFor(config, conversation.channel).catch((error: unknown) => ({ skills: [], problems: [describeError(error)] }));
    const installed = await installSkills({ sandboxes: sandbox, sandbox: sandboxFor(delivery.agent.pubkey), api: new Skills(client), skills: skills.skills, signal }).catch((error: unknown) => ({
      added: [],
      updated: [],
      removed: [],
      unchanged: [],
      problems: [`Couldn't install skills: ${describeError(error)}`],
    }));
    for (const problem of [...skills.problems, ...installed.problems]) report.tool("skills", problem);
    const instructions = [config.instructions.trim(), remoteNote(harness, config.permissions, config.tools), skillsNote(skills.skills), toolsNote(workspace, service, [])].filter(Boolean).join("\n\n");
    const system = await kit.systemPrompt(delivery, { scope: config.scope, cwd: WORK_DIR, instructions, tools: false });
    const prompt = await kit.turnPrompt(delivery, conversation, continued && session.cursor ? { cursor: session.cursor } : {});
    let started = false;
    try {
      const result = await runRemoteTurn({
        sandboxes: sandbox,
        sandbox: sandboxFor(delivery.agent.pubkey),
        harness,
        model: harnessModel(harness, delivery.model ?? config.model),
        permissions: config.permissions,
        ...(continued && { session: continued }),
        prompt: prompt.text,
        system,
        signal,
        ...(tools && { tools }),
        onLaunch: () => (started = true),
        onStep: (tool, target) => report.tool(tool, target),
        onThought: (text) => report.thought(text),
        // Kept as soon as the harness has it, so a failed turn's context isn't lost.
        onSession: (remote) => void sessions.set(delivery.agent.key, conversation.key, { ...sessions.get(delivery.agent.key, conversation.key), remote }),
      });
      await kit.reply(delivery.agent, conversation, result.text);
      await sessions.set(delivery.agent.key, conversation.key, { ...sessions.get(delivery.agent.key, conversation.key), cursor: prompt.cursor, remote: result.session });
    } catch (error) {
      if (!started) prompt.restore();
      throw error;
    }
  }

  async function genieOneTurn(delivery: Delivery, config: DatabricksConfig, conversation: HarnessConversation, signal: AbortSignal, report: TurnReporter) {
    const question = deliveredText(delivery) || "What can I ask you about?";
    const session = sessions.get(delivery.agent.key, conversation.key);
    report.step({ tool: "Asking Genie One", target: question });
    let shown = 0;
    const answer = await genieOneFor(agentService(service, config.profile)).ask(question, {
      ...(session.genieOneConversationId && { conversationId: session.genieOneConversationId }),
      signal,
      // Genie One's own timeline ("Thinking: …", "Running SQL: …"), each step once.
      onProgress: (steps) => {
        for (const line of steps.slice(shown)) report.step(genieOneStep(line));
        shown = Math.max(shown, steps.length);
      },
      // Waits while Databricks rate-limits Genie One; a question asked again starts its timeline over.
      onRetry: (notice) => {
        report.step(rateLimitStep(notice));
        if (notice.restarted) shown = 0;
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

  async function genieSpaceTurn(delivery: Delivery, config: DatabricksConfig, agent: CustomAgent, conversation: HarnessConversation, signal: AbortSignal, report: TurnReporter) {
    const workspace = agentService(service, config.profile);
    const client = await workspace.ready(signal);
    const question = deliveredText(delivery) || "What can I ask you about?";
    const session = sessions.get(delivery.agent.key, conversation.key);
    report.step({ tool: `Asking ${agent.label}`, target: question });
    let status = "";
    const answer = await new Genie(client).answer(agent.target, question, {
      ...(session.genieConversationId && { conversationId: session.genieConversationId }),
      signal,
      onUpdate: (message) => {
        if (message.status === status) return;
        status = message.status;
        report.step(genieStatusStep(agent.label, status));
      },
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

  async function customTurn(delivery: Delivery, config: DatabricksConfig, conversation: HarnessConversation, signal: AbortSignal, report: TurnReporter) {
    const agent = config.custom;
    if (!agent) throw new Error("No agent is chosen yet. My owner can pick one in my Settings.");
    if (agent.kind === "genie") return genieSpaceTurn(delivery, config, agent, conversation, signal, report);
    const client = await agentService(service, config.profile).ready(signal);
    const session = sessions.get(delivery.agent.key, conversation.key);
    const question = deliveredText(delivery);
    const history = session.messages.filter((m): m is { role: "user" | "assistant"; content: string } => (m.role === "user" || m.role === "assistant") && typeof m.content === "string");
    const messages = [...history, { role: "user" as const, content: question || "Hello" }];
    report.step({ tool: `Asking ${agent.label}` });
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
    description: "Runs from your Buzz, so it answers while Buzz is open: Genie One, a Sandbox agent with Buzz's tools and the Databricks tools you pick, or an agent you built on Databricks.",
    provider: provider(service),
    // Genie One needs no setup: it finds the right data across the workspace.
    defaults: () => ({ config: normalizeDatabricks({ kind: "genie-one", tools: [GENIE_ONE_CHOICE] }) }),
    summary: (agent) => summarize(normalizeDatabricks(agent.config)),
    adopt: (carry, config) => ({ ...config, instructions: carry.instructions ?? config.instructions }),
    carry: (config) => (config.instructions.trim() ? { instructions: config.instructions } : {}),
    Create: (props: CreateProps<DatabricksConfig>) => (
      <AgentForm
        service={service}
        config={normalizeDatabricks(props.config)}
        onChange={props.onChange}
        disabled={props.disabled}
        intro={
          <Text tone="subtle" size="sm">
            Runs from your Buzz, so it answers while Buzz is open on this computer, with Buzz's tools. For an agent that answers with Buzz closed, pick Databricks (hosted).
          </Text>
        }
      />
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
      {
        id: "activity",
        title: "Activity",
        role: "activity",
        component: (props: ActivityTabProps) => <LocalActivity log={activity} {...props} />,
      },
    ],
    models: (agent) => {
      const config = normalizeDatabricks(agent.config);
      if (config.kind !== "sandbox") return { current: "", models: [] };
      const current = isRemote(config.harness) ? harnessModel(config.harness, config.model) : config.model;
      const models: { id: string; label: string; efforts: never[] }[] = DEFAULT_MODELS.filter((model) => harnessAccepts(config.harness, model.id)).map((model) => ({ id: model.id, label: model.label, efforts: [] }));
      if (!models.some((model) => model.id === current)) models.unshift({ id: current, label: modelLabel(current), efforts: [] });
      return { current, models };
    },
    sessionControls: {
      scope: (agent) => scopeOf(normalizeDatabricks(agent.config)),
      state: (agent, place) => (queue.active(`${agent.key}|${conversationKey(scopeOf(normalizeDatabricks(agent.config)), place)}`) ? "active" : "idle"),
      async run(agent, place, action) {
        const config = normalizeDatabricks(agent.config);
        const key = conversationKey(scopeOf(config), place);
        if (action === "interrupt") return queue.interrupt(`${agent.key}|${key}`);
        if (action === "new") return sessions.clear(agent.key, key);
        // Claude Code, Codex and Pi manage their own context.
        if (config.kind !== "sandbox" || isRemote(config.harness)) return;
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
      const harness = config.harness;
      turn(delivery, conversation, config, (signal, report) =>
        config.kind === "sandbox"
          ? isRemote(harness)
            ? remoteTurn(delivery, config, harness, conversation, signal, report)
            : sandboxTurn(delivery, config, conversation, signal, report)
          : config.kind === "custom"
            ? customTurn(delivery, config, conversation, signal, report)
            : genieOneTurn(delivery, config, conversation, signal, report),
      );
    },
    async runOnce(standalone) {
      const config = normalizeDatabricks(standalone.delivery.config);
      if (config.kind !== "sandbox") return { ok: false, error: "Watches and timers run on Sandbox agents; Genie One and custom agents answer mentions." };
      if (isRemote(config.harness))
        return { ok: false, error: `Watches and timers run on the Built-in harness for now; ${harnessLabel(config.harness)} answers mentions.` };
      const trigger = standalone.delivery.trigger as { type: string; slug?: string };
      const report = activity.start(standalone.delivery, {
        ...(standalone.delivery.channelId && { channelId: standalone.delivery.channelId }),
        request: trigger.type === "watch" ? `Watch: ${trigger.slug ?? "a matching event"}` : trigger.type === "timer" ? "Timer" : deliveredText(standalone.delivery),
        labels: toolLabels(config.tools),
      });
      try {
        const prompt = await standalone.prompt();
        if (!prompt) {
          report.end("done");
          return { ok: true };
        }
        const workspace = agentService(service, config.profile);
        const client = await workspace.ready(standalone.signal);
        const { tools, instructions } = await sandboxSetup(standalone.delivery, config, workspace, standalone.signal, (state) => report.tool("sandbox", state), standalone.delivery.channelId);
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
          onStep: (tool, target) => report.tool(tool, target),
          onThought: (text) => report.thought(text),
        });
        report.end("done");
        return { ok: true };
      } catch (error) {
        report.end("error", describeError(error));
        return { ok: false, error: describeError(error) };
      }
    },
  };

  agents.register(databricksType);
}

/** The local type's Activity tab: this device's records of the agent's turns, live. */
function LocalActivity(props: ActivityTabProps & { log: ActivityLog }) {
  const turns = React.useSyncExternalStore(
    (listener) => props.log.subscribe(listener),
    () => props.log.turns(props.agent.pubkey),
  );
  return (
    <ActivityView
      turns={turns}
      {...(props.conversation && { conversation: props.conversation })}
      {...(props.openConversation && { openConversation: props.openConversation })}
      {...(props.initialTranscript && { initialTranscript: props.initialTranscript })}
      note={
        <Text tone="tertiary" size="xs">
          What this agent did on this device: each step it took and its thinking, for its last 25 turns.
        </Text>
      }
    />
  );
}

/** One short line under the agent's name. */
export function summarize(config: DatabricksConfig): string {
  const where = config.profile ? [config.profile] : [];
  if (config.kind === "genie-one") return ["Genie One", ...where].join(" · ");
  if (config.kind === "custom") return [config.custom?.label ?? "No agent chosen", ...where].join(" · ");
  if (isRemote(config.harness)) {
    const id = harnessModel(config.harness, config.model);
    const model = DEFAULT_MODELS.find((candidate) => candidate.id === id)?.label ?? modelLabel(id);
    return ["Sandbox", harnessLabel(config.harness), model, ...(config.permissions === "full" ? ["full access"] : []), ...where].join(" · ");
  }
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
