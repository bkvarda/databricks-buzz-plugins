// Page drafts: the ```databricks-page block an agent posts (JSON), and adding
// it to a domain's Pages as a draft. Agents never write pages themselves; a
// person adds the draft from the card, as themselves.
import type { DatabricksClient } from "@dbx/core/client";
import { Pages, pageName } from "@dbx/core/api/pages";

/** Fence language for a page draft in a message. */
export const PAGE_LANGUAGE = "databricks-page";

export const PAGE_WARNING = "Pages may be copied to other regions and aren't encrypted with your company's keys, so don't include personal data.";
export const PAGES_OFF = "Pages isn't turned on in this workspace. An account admin turns it on under Previews.";

export type PageBlock = Readonly<{
  title: string;
  body: string;
  /** `domains/<id>`: where the page goes. */
  domain: string;
  /** For people reading the card without the domain's details. */
  domain_title?: string;
  /** `pages/<id>`: the page the draft is meant to go into, if one was named. */
  page?: string;
}>;

/** The JSON inside the fence; the card renders it. */
export const pageBlockCode = (block: PageBlock) => JSON.stringify(block, null, 2);

/** The whole fenced block an agent posts. */
export const pageBlockFence = (block: PageBlock) => `\`\`\`${PAGE_LANGUAGE}\n${pageBlockCode(block)}\n\`\`\``;

/** Reads a block's JSON, or undefined when it isn't a page draft. */
export function parsePageBlock(code: string): PageBlock | undefined {
  let value: unknown;
  try {
    value = JSON.parse(code);
  } catch {
    return undefined;
  }
  if (!value || typeof value !== "object") return undefined;
  const block = value as Record<string, unknown>;
  if (typeof block.title !== "string" || !block.title.trim()) return undefined;
  if (typeof block.body !== "string" || !block.body.trim()) return undefined;
  if (typeof block.domain !== "string" || !/^domains\/[^/\s]+$/.test(block.domain)) return undefined;
  const page = typeof block.page === "string" && block.page.trim() ? pageName(block.page.trim()) : undefined;
  return {
    title: block.title.trim(),
    body: block.body,
    domain: block.domain,
    ...(typeof block.domain_title === "string" && block.domain_title && { domain_title: block.domain_title }),
    ...(page && { page }),
  };
}

/** A title from a message: its first line, without Markdown heading marks. */
export function titleFrom(text: string): string {
  const first = text.split("\n").map((line) => line.replace(/^[#>\s*-]+/, "").trim()).find(Boolean) ?? "";
  const title = first.length > 80 ? `${first.slice(0, 77)}…` : first;
  return title || "Untitled page";
}

export type DraftResult = Readonly<{ page: string; title: string; mode: "created" | "appended" }>;

/**
 * Adds a draft to Pages: a new draft page in the block's domain, or a section
 * at the end of an existing draft. Published pages aren't changed here; that
 * needs Page Manager, so the person publishes those in Databricks.
 */
export async function addDraft(client: DatabricksClient, block: PageBlock, target: Readonly<{ page?: string }>, requestId?: string): Promise<DraftResult> {
  const pages = new Pages(client);
  if (!target.page) {
    const created = await pages.create({ domain: block.domain, display_name: block.title, body: block.body, state: "DRAFT" }, requestId);
    return { page: created.name, title: created.display_name || block.title, mode: "created" };
  }
  const existing = await pages.get(target.page);
  if (existing.state === "PUBLISHED") throw new Error("That page is published. Pick a draft page, or start a new draft.");
  await pages.append(existing.name, `### ${block.title}\n\n${block.body.trim()}`);
  return { page: existing.name, title: existing.display_name, mode: "appended" };
}
