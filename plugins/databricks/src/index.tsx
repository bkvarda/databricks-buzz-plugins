// Databricks (core): one sign-in for the whole suite.
//
// Provides the `databricks` service to the other Databricks plugins, the
// Settings card where people connect, live chips and a details panel for
// Databricks links, and a few workspace tools for every agent.
import type { Context, Navigation, PluginInstaller } from "@buzz/author";
import { parseWorkspaceUrl } from "@dbx/core/api/workspace";
import { Connection } from "@dbx/core/connection";
import { optionalService } from "@dbx/core/host-types";
import { openPluginDetails } from "@dbx/core/installed";
import { createService } from "@dbx/core/provider";
import { bindReact, React } from "@dbx/core/react";
import { RESULT_LANGUAGE } from "@dbx/core/result";
import { ResultBlock } from "@dbx/core/ui/data";
import { SERVICE_NAME, SETTINGS_SECTION } from "@dbx/core/service";
import { linkChip, panelMatches, workspacePanel } from "./links";
import { ConnectionSettings } from "./settings";
import { coreTools, jobRunSource } from "./tools";

export const inject = ["react", "host", "settingsCards", "conversation", "panels"];

export function apply(ctx: Context) {
  bindReact(ctx.react);
  const connection = new Connection(ctx.host);
  const openSettings = () => {
    const navigation = optionalService<Navigation>(ctx, "navigation");
    void navigation?.open({ version: 1, kind: "settings", section: SETTINGS_SECTION });
  };
  const service = createService(connection, openSettings, (storage) => new Connection(ctx.host, storage, connection.transport));
  ctx.provide(SERVICE_NAME, service);
  void connection.start();

  // Pick up a sign-in done elsewhere (for example `databricks auth login` in a
  // terminal) when the person comes back to Buzz.
  const recheck = () => {
    const status = connection.snapshot().status;
    if (status === "signed-out" || status === "cli-missing") void connection.start();
  };
  ctx.effect(() => {
    globalThis.addEventListener?.("focus", recheck);
    return () => globalThis.removeEventListener?.("focus", recheck);
  });

  ctx.settingsCards.register({
    id: "connection",
    title: "Databricks",
    component: () => (
      <ConnectionSettings
        connection={connection}
        service={service}
        installer={() => optionalService<PluginInstaller>(ctx, "pluginInstaller")}
        openPlugin={(id) => openPluginDetails(ctx, id)}
      />
    ),
  });

  // Query results agents post as `databricks-result` CSV blocks draw as charts.
  ctx.conversation.registerCodeBlock({
    id: "result",
    title: "Databricks results",
    matches: (language) => language === RESULT_LANGUAGE,
    component: ResultBlock,
  });

  ctx.conversation.registerLink({
    id: "workspace",
    title: "Databricks links",
    // Specific to Databricks; plugins that specialize one kind (Genie) use -10.
    matches: (url) => parseWorkspaceUrl(url) !== undefined,
    component: linkChip(service),
  });

  ctx.panels.register({
    id: "workspace",
    title: "Databricks",
    matches: panelMatches,
    keepOpen: true,
    component: workspacePanel(service),
  });

  ctx.inject(["agents"], (scope: Context) => {
    for (const tool of coreTools(service)) scope.agents.addTool(tool);
    scope.agents.addAttentionSource(jobRunSource(service));
  });
}
