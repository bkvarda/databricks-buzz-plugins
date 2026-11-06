// A plugin's own workspace and warehouse choices: the followed service switches
// with the choice, and on Automatic the skills catalog moves past warehouses
// the person can see but not use.
import { describe, expect, it } from "vitest";
import type { DatabricksClient } from "@dbx/core/client";
import type { DatabricksService } from "@dbx/core/service";
import { SkillCatalog } from "@dbx/core/skill-catalog";
import { followWorkspace } from "@dbx/core/workspace-choice";

const WAREHOUSES = [
  { id: "locked", name: "Shared serverless", state: "RUNNING", enable_serverless_compute: true },
  { id: "mine", name: "My warehouse", state: "STOPPED" },
];

/** A workspace whose statements fail on warehouses in `refuse`. */
function workspace(host: string, refuse: readonly string[] = []) {
  const used: string[] = [];
  const client = {
    host,
    workspaceId: undefined,
    get: async (path: string) => {
      if (path === "/api/2.0/sql/warehouses") return { warehouses: WAREHOUSES };
      throw Object.assign(new Error(`no route for ${path}`), { status: 404 });
    },
    post: async (path: string, body: { warehouse_id: string }) => {
      if (path !== "/api/2.0/sql/statements") throw new Error(`no route for ${path}`);
      used.push(body.warehouse_id);
      if (refuse.includes(body.warehouse_id)) throw new Error("You don't have access: Permission denied: insufficient permissions on the requested warehouse");
      return { statement_id: "s", status: { state: "SUCCEEDED" }, manifest: { schema: { columns: [] } }, result: { data_array: [] } };
    },
  } as unknown as DatabricksClient;
  const prefs = new Map<string, unknown>();
  const listeners = new Set<() => void>();
  const prefListeners = new Set<() => void>();
  const service = {
    version: 1,
    snapshot: () => ({ status: "connected", profile: { host, name: host }, user: { userName: "me" } }),
    subscribe: (listener: () => void) => (listeners.add(listener), () => listeners.delete(listener)),
    client: () => client,
    ready: async () => client,
    workspaceUrl: (path: string) => `${host}${path}`,
    profiles: () => [],
    openSettings() {},
    signIn: async () => {},
    preferences: {
      get: (name: string) => prefs.get(name),
      set(name: string, value: unknown) {
        if (value === undefined) prefs.delete(name);
        else prefs.set(name, value);
        for (const listener of [...prefListeners]) listener();
      },
      subscribe: (listener: () => void) => (prefListeners.add(listener), () => prefListeners.delete(listener)),
    },
  } as unknown as DatabricksService;
  return { service, used, prefs };
}

describe("the skills catalog's warehouse", () => {
  it("skips a warehouse that refuses the person, and remembers the one that worked", async () => {
    const lab = workspace("https://w.example", ["locked"]);
    const catalog = new SkillCatalog(lab.service, { warehousePref: "knowledgeWarehouse" });
    const state = await catalog.load();
    expect(state.note).toBeUndefined();
    expect(state.warehouse?.name).toBe("My warehouse");
    expect(lab.used).toEqual(["locked", "mine"]);
    await catalog.load(true);
    expect(lab.used.slice(2)).toEqual(["mine"]);
  });

  it("uses only the chosen warehouse, and says so when it refuses", async () => {
    const lab = workspace("https://w.example", ["locked"]);
    lab.prefs.set("knowledgeWarehouse", "locked");
    const state = await new SkillCatalog(lab.service, { warehousePref: "knowledgeWarehouse" }).load();
    expect(lab.used).toEqual(["locked"]);
    expect(state.note).toMatch(/insufficient permissions/);
  });

  it("explains when every warehouse refuses", async () => {
    const lab = workspace("https://w.example", ["locked", "mine"]);
    const state = await new SkillCatalog(lab.service).load();
    expect(state.note).toMatch(/None of the SQL warehouses tried let you run queries/);
  });
});

describe("a plugin's own workspace", () => {
  it("follows the chosen profile, with that workspace's own preferences", () => {
    const main = workspace("https://main.example");
    const other = workspace("https://other.example");
    const mainService = { ...main.service, forProfile: (profile: string) => (profile === "other" ? other.service : main.service) } as DatabricksService;
    const followed = followWorkspace(mainService, "knowledgeWorkspace");
    let notified = 0;
    followed.subscribe(() => notified++);
    const host = () => (followed.snapshot() as { profile: { host: string } }).profile.host;
    expect(host()).toBe("https://main.example");
    expect(followed.profile()).toBeUndefined();

    followed.setProfile("other");
    expect(host()).toBe("https://other.example");
    expect(notified).toBe(1);
    followed.preferences.set("knowledgeWarehouse", "mine");
    expect(other.prefs.get("knowledgeWarehouse")).toBe("mine");
    expect(main.prefs.get("knowledgeWarehouse")).toBeUndefined();
    expect(main.prefs.get("knowledgeWorkspace")).toBe("other");

    followed.setProfile(undefined);
    expect(host()).toBe("https://main.example");
    expect(notified).toBe(2);
  });
});
