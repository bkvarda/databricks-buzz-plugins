// AI/BI dashboards: what a card for a dashboard link says about it.
import type { DatabricksApiError, DatabricksClient } from "../client";

export type DashboardSummary = Readonly<{
  name: string;
  /** When its current published version was published, if it's published. */
  published?: number;
  /** When its draft last changed, for a dashboard that isn't published. */
  updated?: number;
}>;

const time = (value: string | undefined) => {
  const ms = value ? Date.parse(value) : Number.NaN;
  return Number.isFinite(ms) ? ms : undefined;
};

// By name, not class: each plugin bundles its own copy of the client.
const notFound = (error: unknown) => error instanceof Error && error.name === "DatabricksApiError" && (error as DatabricksApiError).isNotFound;

/**
 * A dashboard's name and age, read as the viewer. Its published version comes
 * first: people who can only view a dashboard can read that, but not the draft.
 * Undefined when the dashboard doesn't exist.
 */
export async function dashboardSummary(client: DatabricksClient, dashboardId: string, signal?: AbortSignal): Promise<DashboardSummary | undefined> {
  const path = `/api/2.0/lakeview/dashboards/${encodeURIComponent(dashboardId)}`;
  let unpublished: unknown;
  try {
    const published = await client.get<{ display_name?: string; revision_create_time?: string }>(`${path}/published`, { signal });
    return { name: published.display_name || "Untitled dashboard", published: time(published.revision_create_time) };
  } catch (error) {
    if (signal?.aborted) throw error;
    unpublished = error;
  }
  try {
    const draft = await client.get<{ display_name?: string; update_time?: string }>(path, { signal });
    return { name: draft.display_name || "Untitled dashboard", updated: time(draft.update_time) };
  } catch (error) {
    if (signal?.aborted || !notFound(error)) throw error;
    // Not found as a draft either: gone, unless the published read said why.
    if (notFound(unpublished)) return undefined;
    throw unpublished;
  }
}
