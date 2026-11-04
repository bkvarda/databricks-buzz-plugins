// Databricks Agents: Buzz agents that think on Databricks.
//   Databricks — a Databricks-served model with Buzz's tools and an optional Sandbox
//   Genie      — a Genie agent you can mention in any conversation
//   Custom     — your Agent Bricks / Model Serving / Databricks Apps agent
import type { Context } from "@buzz/author";
import { bindReact, React } from "@dbx/core/react";
import { attach, MissingCore, useLive } from "@dbx/core/suite";
import { DbxRoot, Notice, Stack, Text } from "@dbx/core/ui/components";
import { registerTypes } from "./types";

export const inject = ["react", "agents", "settingsCards"];

export function apply(ctx: Context) {
  bindReact(ctx.react);
  const live = attach(ctx, { id: "bkvarda.databricks-agents", name: "Databricks Agents" }, (scope, databricks) => {
    const kit = scope.agents.harness;
    if (!kit) return { kit: false };
    registerTypes(scope.agents, kit, databricks);
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
              <Text tone="subtle">Agents that run their models on Databricks, with your access and your governance.</Text>
            </Stack>
            {!runtime.kit && (
              <Notice tone="warning" title="Update Buzz to create Databricks agents">
                This version of Buzz doesn't let plugins bring their own agent types yet. Update Buzz (Settings → Buzz → Updates); the Databricks types then appear in Agents.
              </Notice>
            )}
            {[
              ["Databricks", "A model served by Databricks (Claude, GPT and others through AI Gateway) using Buzz's tools plus every Databricks tool you've added: Genie, SQL, memory. Turn on a Databricks Sandbox to give it a Linux machine in Databricks to run code."],
              ["Genie", "Mention it with a data question in any conversation. It answers with one of your Genie agents and keeps a Genie conversation per thread."],
              ["Databricks custom agent", "Brings an agent you built on Databricks — Agent Bricks, Model Serving or Databricks Apps — into Buzz conversations."],
            ].map(([title, body]) => (
              <Stack key={title} gap={2}>
                <Text weight={500}>{title}</Text>
                <Text tone="subtle" size="sm">{body}</Text>
              </Stack>
            ))}
            <Text size="sm">To create one, open <b>Agents</b>, choose <b>New agent</b> and pick a Databricks harness.</Text>
          </Stack>
        </DbxRoot>
      );
    },
  });
}
