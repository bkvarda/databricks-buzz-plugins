// Databricks Agents: one hosted Buzz agent type, "Databricks". Each agent runs
// fully remote in its own Databricks Sandbox (so it answers with the owner's
// laptop off) and is either Genie (Genie One or a Genie agent) or a coding
// harness (Claude Code, Codex or Pi).
import type { Context } from "@buzz/author";
import { bindReact, React } from "@dbx/core/react";
import { attach, MissingCore, useLive } from "@dbx/core/suite";
import { DbxRoot, Notice, Stack, Text } from "@dbx/core/ui/components";
import { registerHostedType } from "./hosted";

export const inject = ["react", "agents", "settingsCards"];

export function apply(ctx: Context) {
  bindReact(ctx.react);
  const live = attach(ctx, { id: "bkvarda.databricks-agents", name: "Databricks Agents" }, (scope, databricks) => {
    // Hosted agent types arrived with the harness kit; an older Buzz has neither.
    if (!scope.agents.harness) return { kit: false };
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
              <Text tone="subtle">Agents that run fully in Databricks, with your access and your governance, and answer with your laptop off.</Text>
            </Stack>
            {!runtime.kit && (
              <Notice tone="warning" title="Update Buzz to create Databricks agents">
                This version of Buzz doesn't let plugins bring hosted agent types yet. Update Buzz (Settings → Buzz → Updates); the Databricks type then appears in Agents.
              </Notice>
            )}
            {[
              ["Genie", "Mention it with a data question anywhere. It answers with Genie One, or one of your Genie agents, as charts and tables, and keeps a Genie conversation per thread."],
              ["Sandbox agent", "Claude Code, Codex or Pi working in its own Databricks Sandbox, with the Databricks CLI signed in as you. It keeps its context between turns and runs in each harness's guarded mode."],
              ["Always on, or sleep when idle", "Each agent's Sandbox either runs all the time, or sleeps when idle and wakes on a schedule (and stays awake while your Buzz is open). A small scheduled job in your workspace keeps it running."],
            ].map(([title, body]) => (
              <Stack key={title} gap={2}>
                <Text weight={500}>{title}</Text>
                <Text tone="subtle" size="sm">{body}</Text>
              </Stack>
            ))}
            <Text size="sm">To create one, open <b>Agents</b>, choose <b>New agent</b> and pick <b>Databricks (hosted)</b> as the harness.</Text>
          </Stack>
        </DbxRoot>
      );
    },
  });
}
