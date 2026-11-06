// Skills: the agent tools every agent gets, the databricks-skill card, the
// "Make this a skill" message action, and the Settings section. Everything
// runs as the signed-in person; agents draft, people publish.
import type { Context } from "@buzz/author";
import type { DatabricksService } from "@dbx/core/service";
import type { SkillCatalog } from "@dbx/core/skill-catalog";
import { hasText, makeSkillAction } from "./skill-action";
import { skillBlock } from "./skill-card";
import { DRAFT_LANGUAGE } from "./skill-draft";
import { skillTools } from "./skill-tools";

export { SkillsSettings } from "./skill-settings";

export function registerSkills(scope: Context, service: DatabricksService, catalog: SkillCatalog): void {
  scope.conversation.registerCodeBlock({
    id: "skill",
    title: "Databricks skill",
    matches: (language) => language.trim().toLowerCase() === DRAFT_LANGUAGE,
    component: skillBlock(service, catalog),
  });
  scope.conversation.registerMessageAction({
    id: "make-skill",
    title: "Make this a skill",
    matches: (message) => hasText(message),
    component: makeSkillAction(service, catalog),
  });
  scope.inject(["agents"], (agents: Context) => {
    for (const tool of skillTools(service, catalog)) agents.agents.addTool(tool);
  });
}
