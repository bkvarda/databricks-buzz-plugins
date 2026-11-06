// Databricks Knowledge: Unity Catalog skills, domains and Pages in Buzz.
//
// - Skills (./skills): tools that let every agent search and load skills, a
//   "Make this a skill" message action, and a draft card an agent can post
//   for a person to publish.
// - Channels (./channels): "Set up Databricks" in a channel's menu, linking
//   it to a domain and a skills schema; "Add to page" and page drafts once
//   Pages is on.
//
// Everything runs as the signed-in person. Agents draft; people publish.
import type { Context } from "@buzz/author";
import { bindReact, React } from "@dbx/core/react";
import { SkillCatalog } from "@dbx/core/skill-catalog";
import { followWorkspace } from "@dbx/core/workspace-choice";
import { attach, MissingCore, useLive } from "@dbx/core/suite";
import { DbxRoot, Stack } from "@dbx/core/ui/components";
import { DomainSettings, registerChannels } from "./channels";
import { registerSkills, SkillsSettings } from "./skills";
import { WAREHOUSE_PREF, WORKSPACE_PREF, WorkspaceSettings } from "./workspace-settings";

export const inject = ["react", "conversation", "panels", "settingsCards"];

export function apply(ctx: Context) {
  bindReact(ctx.react);
  const live = attach(ctx, { id: "bkvarda.databricks-knowledge", name: "Databricks Knowledge" }, (scope, main) => {
    // "Same as Buzz" unless chosen in Settings; everything below follows it.
    const databricks = followWorkspace(main, WORKSPACE_PREF);
    const catalog = new SkillCatalog(databricks, { warehousePref: WAREHOUSE_PREF });
    registerSkills(scope, databricks, catalog);
    registerChannels(scope, databricks, catalog);
    return { main, databricks, catalog };
  });
  ctx.settingsCards.register({
    id: "knowledge",
    title: "Databricks Knowledge",
    component: () => {
      const runtime = useLive(live);
      return runtime ? (
        <DbxRoot>
          <Stack gap={24}>
            <WorkspaceSettings main={runtime.main} service={runtime.databricks} catalog={runtime.catalog} />
            <SkillsSettings service={runtime.databricks} catalog={runtime.catalog} />
            <DomainSettings service={runtime.databricks} catalog={runtime.catalog} />
          </Stack>
        </DbxRoot>
      ) : (
        <MissingCore ctx={ctx} feature="Databricks Knowledge" />
      );
    },
  });
}
