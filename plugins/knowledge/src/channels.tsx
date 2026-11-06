// Channels, domains and Pages: "Set up Databricks" in a channel's menu, the
// channel's agent tools, the databricks-page card and "Add to page", and the
// Settings section. The link lives in Databricks as tags on the channel's
// skills schema, so every member's plugin finds it with one query.
import type { Context } from "@buzz/author";
import type { DatabricksService } from "@dbx/core/service";
import type { SkillCatalog } from "@dbx/core/skill-catalog";
import { channelSetupPanel } from "./channel-panel";
import { channelTools } from "./channel-tools";
import { addToPageAction, pageCodeBlock } from "./page-card";
import { PAGE_LANGUAGE } from "./page-draft";

export { DomainSettings } from "./domain-settings";

export function registerChannels(scope: Context, service: DatabricksService, catalog: SkillCatalog): void {
  scope.panels.register({
    id: "knowledge-channel",
    title: "Databricks",
    // Opened from the channel menu only, never from a link.
    matches: () => false,
    channelMenu: { label: "Set up Databricks", eligible: (channel) => !channel.readOnly && !channel.cached },
    channelPlacement: "side",
    component: channelSetupPanel(service, catalog),
  });
  scope.conversation.registerCodeBlock({
    id: "databricks-page",
    title: "Databricks page",
    matches: (language) => language.trim() === PAGE_LANGUAGE,
    component: pageCodeBlock(service),
  });
  scope.conversation.registerMessageAction(addToPageAction(service, catalog));
  scope.inject(["agents"], (agents: Context) => {
    for (const tool of channelTools(service, catalog)) agents.agents.addTool(tool);
  });
}
