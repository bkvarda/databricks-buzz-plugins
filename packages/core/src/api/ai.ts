// Models and agents served by Databricks.
// - Foundation models through AI Gateway (OpenAI-compatible chat completions).
// - Custom agents on Model Serving (Responses / ChatAgent / chat formats) or
//   on Databricks Apps (Agent Runtime), invoked with the user's token.
import type { DatabricksClient } from "../client";

export type ChatRole = "system" | "user" | "assistant" | "tool";

export type ToolCall = Readonly<{
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}>;

export type ChatMessage =
  | Readonly<{ role: "system" | "user"; content: string }>
  | Readonly<{ role: "assistant"; content: string | null; tool_calls?: readonly ToolCall[] }>
  | Readonly<{ role: "tool"; tool_call_id: string; content: string }>;

export type FunctionTool = Readonly<{
  type: "function";
  function: { name: string; description?: string; parameters: Readonly<Record<string, unknown>> };
}>;

export type ChatCompletion = Readonly<{
  id?: string;
  model?: string;
  choices: readonly {
    index?: number;
    finish_reason?: string;
    message: { role: "assistant"; content: string | null | readonly { type: string; text?: string }[]; tool_calls?: readonly ToolCall[] };
  }[];
  usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
}>;

/** A sensible starting list; any endpoint or `system.ai.*` name also works. */
export const DEFAULT_MODELS = [
  { id: "system.ai.claude-sonnet-5-5", label: "Claude Sonnet 5.5" },
  { id: "system.ai.claude-opus-5-5", label: "Claude Opus 5.5" },
  { id: "system.ai.claude-haiku-5-5", label: "Claude Haiku 5.5" },
  { id: "system.ai.gpt-5-6-sol", label: "GPT-5.6 Sol" },
] as const;

export const DEFAULT_MODEL = DEFAULT_MODELS[0].id;

export function messageText(content: ChatCompletion["choices"][number]["message"]["content"]): string {
  if (typeof content === "string") return content;
  if (!content) return "";
  return content.map((part) => part.text ?? "").join("");
}

export class Ai {
  /** Remembers which chat route the workspace answers. */
  private route: "gateway" | "serving" | undefined;

  constructor(private readonly client: DatabricksClient) {}

  async chat(
    request: Readonly<{
      model: string;
      messages: readonly ChatMessage[];
      tools?: readonly FunctionTool[];
      maxTokens?: number;
      temperature?: number;
      signal?: AbortSignal;
    }>,
  ): Promise<ChatCompletion> {
    const body = {
      model: request.model,
      messages: request.messages,
      ...(request.tools?.length && { tools: request.tools, tool_choice: "auto" }),
      max_tokens: request.maxTokens ?? 4096,
      ...(request.temperature !== undefined && { temperature: request.temperature }),
    };
    const init = { timeoutMs: 170_000, ...(request.signal && { signal: request.signal }) };
    if (this.route !== "serving") {
      try {
        const response = await this.client.post<ChatCompletion>("/ai-gateway/mlflow/v1/chat/completions", body, init);
        this.route = "gateway";
        return response;
      } catch (error) {
        const status = (error as { status?: number }).status;
        if (this.route === "gateway" || (status !== 404 && status !== 405)) throw error;
      }
    }
    this.route = "serving";
    if (request.model.startsWith("system.ai."))
      return this.client.post<ChatCompletion>("/serving-endpoints/chat/completions", body, init);
    return this.client.post<ChatCompletion>(
      `/serving-endpoints/${encodeURIComponent(request.model)}/invocations`,
      { ...body, model: undefined },
      init,
    );
  }

  /** Serving endpoints the user can see, with their task. */
  async endpoints(signal?: AbortSignal) {
    const response = await this.client.get<{
      endpoints?: {
        name: string;
        task?: string;
        state?: { ready?: string };
        description?: string;
        config?: { served_entities?: { entity_name?: string; foundation_model?: { display_name?: string } }[] };
        tags?: { key: string; value?: string }[];
      }[];
    }>("/api/2.0/serving-endpoints", signal ? { signal } : {});
    return (response.endpoints ?? []).map((endpoint) => ({
      name: endpoint.name,
      task: endpoint.task ?? "",
      ready: endpoint.state?.ready === "READY",
      description: endpoint.description,
      isAgent: /^agent\//.test(endpoint.task ?? "") || (endpoint.tags ?? []).some((tag) => /agent/i.test(tag.key)),
      isChat: /chat|responses/.test(endpoint.task ?? ""),
      label:
        endpoint.config?.served_entities?.[0]?.foundation_model?.display_name ?? endpoint.name,
    }));
  }

  /**
   * Calls a custom agent with a conversation and returns its reply text.
   * `target` is a serving endpoint name, or an https:// Databricks App URL.
   */
  async invokeAgent(
    target: string,
    messages: readonly { role: "user" | "assistant"; content: string }[],
    options: Readonly<{ task?: string; sessionId?: string; signal?: AbortSignal }> = {},
  ): Promise<{ text: string; raw: unknown }> {
    const init = { timeoutMs: 175_000, ...(options.signal && { signal: options.signal }) };
    if (/^https:\/\//.test(target)) {
      const base = target.replace(/\/+$/, "");
      // Agent Runtime (DurableAgentServer) first, then the MLflow agent server.
      try {
        const raw = await this.client.post(`${base}/api/invocations`, {
          input: messages,
          ...(options.sessionId && { session_id: options.sessionId }),
        }, init);
        return { text: agentText(raw), raw };
      } catch (error) {
        const status = (error as { status?: number }).status;
        if (status !== 404 && status !== 405) throw error;
      }
      const raw = await this.client.post(`${base}/responses`, { input: messages }, init);
      return { text: agentText(raw), raw };
    }
    const path = `/serving-endpoints/${encodeURIComponent(target)}/invocations`;
    const task = options.task ?? "";
    const body = /responses/.test(task)
      ? { input: messages, ...(options.sessionId && { custom_inputs: { session_id: options.sessionId } }) }
      : { messages };
    const raw = await this.client.post(path, body, init);
    return { text: agentText(raw), raw };
  }
}

/** Extracts the reply text from Responses, ChatAgent, chat or plain outputs. */
export function agentText(raw: unknown): string {
  if (typeof raw === "string") return raw;
  if (!raw || typeof raw !== "object") return "";
  const value = raw as Record<string, unknown>;
  if (Array.isArray(value.output)) {
    const texts = (value.output as { type?: string; content?: unknown }[])
      .filter((item) => item.type === "message" || item.content)
      .flatMap((item) =>
        Array.isArray(item.content)
          ? (item.content as { type?: string; text?: string }[]).map((part) => part.text ?? "")
          : typeof item.content === "string"
            ? [item.content]
            : [],
      );
    if (texts.join("").trim()) return texts.join("\n").trim();
  }
  if (typeof value.output_text === "string") return value.output_text;
  if (Array.isArray(value.choices)) {
    const message = (value.choices as { message?: { content?: unknown } }[])[0]?.message;
    if (message) return messageText(message.content as ChatCompletion["choices"][number]["message"]["content"]);
  }
  if (Array.isArray(value.messages)) {
    const last = [...(value.messages as { role?: string; content?: unknown }[])].reverse().find((m) => m.role === "assistant");
    if (typeof last?.content === "string") return last.content;
  }
  if (Array.isArray(value.predictions)) return agentText(value.predictions[0]);
  if (typeof value.content === "string") return value.content;
  return JSON.stringify(raw).slice(0, 4000);
}
