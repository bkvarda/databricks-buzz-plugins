// Dashboard links: a card under the message says which dashboard it is, read
// as the viewer, and Buzz for Mac opens the live dashboard beside the
// conversation in its own browser. Elsewhere, and on Buzz builds without
// cards, links behave as they did.
import * as React from "react";
import { describe, expect, it } from "vitest";
import { dashboardSummary } from "@dbx/core/api/dashboards";
import { DatabricksApiError, type DatabricksClient } from "@dbx/core/client";
import { apply } from "../plugins/databricks/src/index";
import { DASHBOARD_STORAGE, dashboardDetail, isDashboardUrl } from "../plugins/databricks/src/links";

const host = "https://example.cloud.databricks.com";
const id = "0123456789abcdef0123456789abcdef";

type Route = { body?: unknown; status?: number; code?: string };

/** A client answering the dashboard reads; anything unrouted is a 404. */
function client(routes: Record<string, Route>) {
  const calls: string[] = [];
  const fake = {
    async get(path: string) {
      calls.push(path);
      const route = routes[path] ?? { status: 404, code: "RESOURCE_DOES_NOT_EXIST" };
      if (route.status) throw new DatabricksApiError(route.status, route.code, `HTTP ${route.status}`, "");
      return route.body;
    },
  };
  return { client: fake as unknown as DatabricksClient, calls };
}

const draft = `/api/2.0/lakeview/dashboards/${id}`;
const published = `${draft}/published`;

describe("reading a dashboard for its card", () => {
  it("names a published dashboard from its published version, without reading the draft", async () => {
    const { client: c, calls } = client({ [published]: { body: { display_name: "Sales", revision_create_time: "2026-11-10T12:00:00Z" } } });
    expect(await dashboardSummary(c, id)).toEqual({ name: "Sales", published: Date.parse("2026-11-10T12:00:00Z") });
    expect(calls).toEqual([published]);
  });

  it("falls back to the draft for a dashboard that isn't published", async () => {
    const { client: c } = client({ [draft]: { body: { display_name: "Ops", update_time: "2026-11-12T08:00:00Z" } } });
    expect(await dashboardSummary(c, id)).toEqual({ name: "Ops", updated: Date.parse("2026-11-12T08:00:00Z") });
  });

  it("says nothing for a dashboard that doesn't exist", async () => {
    expect(await dashboardSummary(client({}).client, id)).toBeUndefined();
  });

  it("reports why a viewer can't read it", async () => {
    const denied = { status: 403, code: "PERMISSION_DENIED" };
    await expect(dashboardSummary(client({ [published]: denied }).client, id)).rejects.toMatchObject({ isPermission: true });
    await expect(dashboardSummary(client({ [published]: denied, [draft]: denied }).client, id)).rejects.toMatchObject({ isPermission: true });
  });

  it("describes when it was published, or that it isn't", () => {
    const now = Date.parse("2026-11-14T12:00:00Z");
    expect(dashboardDetail({ name: "Sales", published: now - 2 * 86_400_000 }, now)).toBe("Published 2d ago");
    expect(dashboardDetail({ name: "Ops", updated: now - 3 * 3_600_000 }, now)).toBe("Not published · edited 3h ago");
    expect(dashboardDetail({ name: "New" }, now)).toBe("Not published");
  });
});

describe("dashboard links", () => {
  it("covers draft, published, SQL and embed addresses, and nothing else", () => {
    expect(isDashboardUrl(`${host}/dashboardsv3/${id}/published?o=123`)).toBe(true);
    expect(isDashboardUrl(`${host}/sql/dashboardsv3/${id}`)).toBe(true);
    expect(isDashboardUrl(`${host}/embed/dashboardsv3/${id}?o=123`)).toBe(true);
    expect(isDashboardUrl(`${host}/jobs/12/runs/34`)).toBe(false);
    expect(isDashboardUrl(`https://example.com/dashboardsv3/${id}`)).toBe(false);
  });
});

/** The registrations the Databricks plugin makes against a fake Buzz. */
function load(options: { browser?: { available: boolean }; cards?: boolean }) {
  const panels: { id: string; matches(url: string): boolean; component: (props: object) => React.ReactNode }[] = [];
  const cards: { id: string; order?: number; matches(url: string): boolean; component: (props: object) => React.ReactNode }[] = [];
  const View = (props: object) => React.createElement("browser-view", props);
  const services: Record<string, unknown> = { browser: options.browser && { ...options.browser, View } };
  const ctx = {
    react: React,
    host: {},
    settingsCards: { register() {} },
    conversation: {
      registerCodeBlock() {},
      registerLink() {},
      ...(options.cards !== false && { registerLinkPreview: (card: (typeof cards)[number]) => cards.push(card) }),
    },
    panels: { register: (panel: (typeof panels)[number]) => panels.push(panel) },
    provide() {},
    effect() {},
    inject() {},
    reflect: { get: (name: string) => services[name] },
  };
  apply(ctx as never);
  return { panels, cards, View };
}

describe("where dashboards open", () => {
  const url = `${host}/dashboardsv3/${id}/published`;

  it("opens them in Buzz's browser beside the conversation where Buzz has one", () => {
    const { panels, cards, View } = load({ browser: { available: true } });
    const panel = panels.find((candidate) => candidate.matches(url));
    expect(panel?.id).toBe("dashboard");
    // The workspace details panel still takes job and table links.
    expect(panels.find((candidate) => candidate.matches(`${host}/jobs/12/runs/34`))?.id).toBe("workspace");
    const element = panel?.component({ target: url, close() {} }) as React.ReactElement<Record<string, unknown>>;
    expect(element.type).toBe(View);
    expect(element.props).toMatchObject({ url, storage: DASHBOARD_STORAGE, label: "Dashboard" });
    expect(cards).toHaveLength(1);
    expect(cards[0]).toMatchObject({ id: "dashboard", order: -10 });
    expect(cards[0]?.matches(url)).toBe(true);
  });

  it("leaves them to the web browser where Buzz has no browser of its own", () => {
    for (const browser of [undefined, { available: false }]) {
      const { panels, cards } = load({ browser });
      expect(panels.some((candidate) => candidate.matches(url))).toBe(false);
      expect(cards).toHaveLength(1);
    }
  });

  it("still loads on Buzz builds without cards under messages", () => {
    const { panels, cards } = load({ browser: { available: true }, cards: false });
    expect(cards).toHaveLength(0);
    expect(panels.some((candidate) => candidate.id === "dashboard")).toBe(true);
  });
});
