// What the plugins ask of Buzz, and how they behave on older Buzz: manifests
// use only keys Buzz knows (an unknown key makes Buzz refuse the whole
// plugin), installation status is used only where the host has it, and the
// skill action's toolbar placement falls back to the ⋯ menu.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { PluginInstaller } from "@buzz/author";
import { statusMethods } from "@dbx/core/installed";
import { suiteState } from "../plugins/databricks/src/settings";
import { registerSkills } from "../plugins/knowledge/src/skills";

const ROOT = join(__dirname, "..");
// The manifest keys Buzz 0.7.11 and later accept (`updates` arrived in 0.7.11).
const KNOWN_KEYS = new Set(["id", "name", "apiVersion", "description", "updates", "discovery", "host"]);

describe("manifests", () => {
  const plugins = readdirSync(join(ROOT, "plugins")).filter((name) => {
    try {
      readFileSync(join(ROOT, "plugins", name, "manifest.json"));
      return true;
    } catch {
      return false;
    }
  });

  it("covers every plugin in the suite", () => {
    expect(plugins.sort()).toEqual(["agents", "databricks", "genie", "knowledge", "lakebase", "memory", "sql"]);
  });

  it.each(plugins)("%s uses only known keys and turns on update notices", (name) => {
    const manifest = JSON.parse(readFileSync(join(ROOT, "plugins", name, "manifest.json"), "utf8")) as Record<string, unknown>;
    expect(Object.keys(manifest).filter((key) => !KNOWN_KEYS.has(key))).toEqual([]);
    expect(manifest.updates).toEqual({ defaultEnabled: true });
  });
});

describe("installation status", () => {
  const requestInstall = async () => "cancelled" as const;

  it("is absent on hosts without the status methods", () => {
    expect(statusMethods(undefined)).toBeUndefined();
    expect(statusMethods({ requestInstall } as unknown as PluginInstaller)).toBeUndefined();
  });

  it("reads and subscribes through the host's methods", () => {
    const listeners: (() => void)[] = [];
    const installer = {
      requestInstall,
      installed: new Set(["bkvarda.databricks-sql"]),
      getInstallationStatus(id: string) {
        // Called as a method: the host's implementation may rely on `this`.
        return this.installed.has(id) ? ("installed" as const) : ("absent" as const);
      },
      subscribeInstallationStatus(_id: string, listener: () => void) {
        listeners.push(listener);
        return () => listeners.splice(listeners.indexOf(listener), 1);
      },
    };
    const methods = statusMethods(installer as unknown as PluginInstaller)!;
    expect(methods.get("bkvarda.databricks-sql")).toBe("installed");
    expect(methods.get("bkvarda.databricks-genie")).toBe("absent");
    let heard = 0;
    const stop = methods.subscribe("bkvarda.databricks-genie", () => heard++);
    for (const listener of listeners) listener();
    stop();
    expect(heard).toBe(1);
    expect(listeners).toHaveLength(0);
  });

  it("shows an installed plugin that isn't running as off, not as Add", () => {
    expect(suiteState(true, "installed")).toBe("on");
    expect(suiteState(false, "installed")).toBe("off");
    expect(suiteState(false, "absent")).toBe("add");
    expect(suiteState(false, "unavailable")).toBe("add");
    // Hosts that can't say keep offering Add.
    expect(suiteState(false, undefined)).toBe("add");
  });
});

describe("Make this a skill", () => {
  it("sits in the message toolbar with an icon", () => {
    const actions: Record<string, unknown>[] = [];
    const scope = {
      conversation: { registerCodeBlock() {}, registerMessageAction: (action: Record<string, unknown>) => actions.push(action) },
      inject() {},
    };
    registerSkills(scope as never, {} as never, {} as never);
    const action = actions.find((candidate) => candidate.id === "make-skill");
    expect(action).toMatchObject({ title: "Make this a skill", placement: "toolbar" });
    expect(typeof action?.icon).toBe("function");
  });
});
