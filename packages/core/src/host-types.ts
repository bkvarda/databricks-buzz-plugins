// Host contract types the author entry does not export by name.
import type { AddedTool, Agents, Context, Page, Panel } from "@buzz/author";
import type { ComponentType } from "react";

export type PanelProps = Panel["component"] extends ComponentType<infer P> ? P : never;
export type PageProps = Page["component"] extends ComponentType<infer P> ? P : never;

export type AgentTool = AddedTool;
export type ToolReply = Awaited<ReturnType<AddedTool["call"]>>;
export type AttentionSourceSpec = Parameters<Agents["addAttentionSource"]>[0];

/** Optional host services, read without making them required injections. */
export function optionalService<T>(ctx: Context, name: string): T | undefined {
  try {
    return (ctx as unknown as { reflect?: { get?(name: string): unknown } }).reflect?.get?.(name) as T | undefined;
  } catch {
    return undefined;
  }
}

/** JSON Schema helpers for agent tool inputs. */
export const schema = {
  object(properties: Record<string, unknown>, required: readonly string[] = []) {
    return { type: "object", properties, required, additionalProperties: false } as const;
  },
  string(description: string, extra: Record<string, unknown> = {}) {
    return { type: "string", description, ...extra } as const;
  },
  integer(description: string, extra: Record<string, unknown> = {}) {
    return { type: "integer", description, ...extra } as const;
  },
  boolean(description: string) {
    return { type: "boolean", description } as const;
  },
};

export function stringArg(args: Record<string, unknown>, name: string, required = true): string {
  const value = args[name];
  if (typeof value === "string" && value.trim()) return value.trim();
  if (required) throw new Error(`${name} is required.`);
  return "";
}

export function numberArg(args: Record<string, unknown>, name: string, fallback: number, min: number, max: number): number {
  const value = args[name];
  const parsed = typeof value === "number" ? value : typeof value === "string" ? Number(value) : Number.NaN;
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, Math.round(parsed)));
}
