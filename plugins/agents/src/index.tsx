// Databricks Agents: two Buzz agent types.
//   Databricks           runs from the owner's Buzz (./types): Genie One, a
//                        Sandbox agent with Buzz's tools, or a custom agent.
//   Databricks (hosted)  runs in its own Databricks Sandbox (./hosted), so it
//                        answers with Buzz closed: Genie, or Claude Code,
//                        Codex or Pi.
import type { Context } from "@buzz/author";
import { bindReact, React } from "@dbx/core/react";
import { attach, MissingCore, useLive } from "@dbx/core/suite";
import { DbxRoot, Notice, Stack, Text } from "@dbx/core/ui/components";
import { registerHostedType } from "./hosted";
import { registerTypes } from "./types";

export const inject = ["react", "agents", "settingsCards"];

export function apply(ctx: Context) {
  bindReact(ctx.react);
  const live = attach(ctx, { id: "bkvarda.databricks-agents", name: "Databricks Agents" }, (scope, databricks) => {
    // Plugin and hosted agent types arrived with the harness kit; an older Buzz has neither.
    const kit = scope.agents.harness;
    if (!kit) return { kit: false };
    registerTypes(scope.agents, kit, databricks);
    const stop = registerHostedType(scope.agents, databricks);
    scope.effect(() => stop);
    return { kit: true };
  });
  ctx.settingsCards.register({
    id: "agents",
    title: "Databricks Agents",
    component: () => {
      const runtime = useLive(live);
      if (!runtime) return <MissingCore ctx={ctx} feature="Databricks Agents" />;
      return (
        <DbxRoot>
          <Stack gap={18}>
            <Stack gap={6}>
              <Text as="h2" size="xl" weight={500}>Databricks Agents</Text>
              <Text tone="subtle">Agents that think on Databricks, with your access and your governance.</Text>
            </Stack>
            {!runtime.kit && (
              <Notice tone="warning" title="Update Buzz to create Databricks agents">
                This version of Buzz doesn't let plugins bring their own agent types yet. Update Buzz (Settings → Buzz → Updates); the Databricks types then appear in Agents.
              </Notice>
            )}
            {[
              [
                "Databricks",
                "Runs from your Buzz, so it answers while Buzz is open on this computer. Genie One for data questions, a Sandbox agent (a Databricks model, or Claude Code, Codex or Pi in its Sandbox) with Buzz's tools and the Databricks tools you pick, or an agent you built on Databricks. Buzz shows it working and can stop it.",
              ],
              [
                "Databricks (hosted)",
                "Runs in your Databricks workspace, in its own Sandbox, so it can answer with Buzz closed. Genie, or Claude Code, Codex or Pi in each harness's guarded mode. Always on, or asleep while Buzz is closed. It can't use Buzz's own tools, and Buzz doesn't show it working.",
              ],
            ].map(([title, body]) => (
              <Stack key={title} gap={2}>
                <Text weight={500}>{title}</Text>
                <Text tone="subtle" size="sm">{body}</Text>
              </Stack>
            ))}
            <Text size="sm">To create one, open <b>Agents</b>, choose <b>New agent</b> and pick <b>Databricks</b> or <b>Databricks (hosted)</b> as the harness.</Text>
          </Stack>
        </DbxRoot>
      );
    },
  });
}
