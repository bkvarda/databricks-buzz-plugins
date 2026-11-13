# Databricks Agents

Create Buzz agents that run on Databricks: a Databricks-served model with its own Sandbox, a Genie agent you can mention, or an agent you built with Agent Bricks.

## Getting started

1. Add the **Databricks** plugin and sign in under **Settings → Databricks**.
2. Open **Agents**, choose **New agent**, and pick **Databricks**, **Genie** or **Databricks custom agent** as the harness.
3. For a Databricks agent, choose a model and turn on **Give it a Databricks Sandbox** to let it run code in Databricks.
4. Mention the agent in a conversation. Add **Databricks Genie**, **SQL** and **Memory** to give it more tools.
5. Under **Skills**, pick Unity Catalog skills for it, or whole skills schemas. It also uses the skills of the channel it's working in. Claude Code, Codex and Pi get them as their own skills.

Your agents take requests only from you, because they work with your Databricks access. When someone else mentions one, it tells them so in their thread, once an hour per conversation, and tags you so you know they asked.

## Agents that answer with Buzz closed

Pick **Databricks (hosted)** as the harness. Each one gets its own Databricks Sandbox, so it keeps answering after you close Buzz. Choose what answers:

- **Genie**: Genie One, or one of your Genie agents.
- **Sandbox agent**: Claude Code, Codex or Pi, working in the agent's Sandbox.
- **Omnigent agent**: an Omnigent agent (Claude Code, Codex, Pi, Polly or Debby) on a Sandbox that Omnigent runs. Each conversation becomes an Omnigent session in your workspace, which you can open and continue at `<workspace>/omnigent`. Your workspace needs the Omnigent preview. To use Omnigent in a different workspace, pick that workspace's CLI profile under **Workspace**. Databricks tools and skills aren't added to Omnigent agents yet.
