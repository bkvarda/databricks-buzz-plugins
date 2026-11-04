# Databricks plugins for Buzz

A suite of [Buzz](https://github.com/block/buzz-app) plugins that bring Databricks into conversations and agents: one sign-in, Genie with charts, runnable SQL, Databricks-powered agents with Sandboxes, long-term memory and Lakebase.

| Plugin | What it adds |
| --- | --- |
| **Databricks** (`plugins/databricks`) | One browser sign-in for the whole suite, live status chips and a details panel for Databricks links (jobs, runs, pipelines, tables, dashboards), a job-run Attention source, and workspace tools for every agent. Required by the others. |
| **Databricks Genie** (`plugins/genie`) | A Genie page with **Genie One** (ask across all your data, with a live thinking timeline) and your Genie agents in the sidebar: chat with progress, answer, auto chart, SQL and follow-ups. **Ask Genie** in the composer, Genie link panels, and Genie / Genie One tools for every agent. |
| **Databricks SQL** (`plugins/sql`) | **▶ Run** on every ` ```sql ` block in a conversation, a SQL page with a Unity Catalog browser, and read-only-by-default SQL and catalog tools for agents. |
| **Databricks Agents** (`plugins/agents`) | Three agent types: **Databricks** (a Databricks-served model with Buzz's tools, an optional **Databricks Sandbox**, Genie, and MCP servers picked from your workspace), **Genie** (mention it in any thread; Genie One by default, no setup) and **Databricks custom agent** (Agent Bricks, Model Serving or Databricks Apps). Each agent can work in its own workspace. |
| **Databricks Memory** (`plugins/memory`) | Long-term memory for every agent in Databricks managed memory (Lakebase-backed), shared across your agents and Databricks agents. |
| **Lakebase** (`plugins/lakebase`) | Read access for agents to operational data in Lakebase Postgres through the Data API. Add a project's database in one click from **Settings → Lakebase**. |

## Install

In the Buzz desktop app, open **Settings → Plugins → Manage plugins → Add**, enter `bkvarda/databricks-buzz-plugins`, and pick `plugins/databricks/dist`. Then open **Settings → Databricks**, choose **Sign in with Databricks**, and add the other plugins from the **Databricks plugins** list on that page.

Or open an install link from a terminal (macOS):

```sh
open 'buzz://plugin-install?repository=bkvarda%2Fdatabricks-buzz-plugins&ref=main&path=plugins%2Fdatabricks%2Fdist'
open 'buzz://plugin-install?repository=bkvarda%2Fdatabricks-buzz-plugins&ref=main&path=plugins%2Fgenie%2Fdist'
open 'buzz://plugin-install?repository=bkvarda%2Fdatabricks-buzz-plugins&ref=main&path=plugins%2Fsql%2Fdist'
open 'buzz://plugin-install?repository=bkvarda%2Fdatabricks-buzz-plugins&ref=main&path=plugins%2Fagents%2Fdist'
open 'buzz://plugin-install?repository=bkvarda%2Fdatabricks-buzz-plugins&ref=main&path=plugins%2Fmemory%2Fdist'
open 'buzz://plugin-install?repository=bkvarda%2Fdatabricks-buzz-plugins&ref=main&path=plugins%2Flakebase%2Fdist'
```

An organization can recommend the suite to everyone with a [managed plugins policy](https://github.com/block/buzz-app/blob/main/docs/managed-plugins.md); see [`docs/managed-plugins.example.json`](docs/managed-plugins.example.json).

**Requirements:** the Buzz desktop app. Sandboxes need the **Databricks Sandbox** preview turned on in the workspace. Lakebase reads need the project's Data API turned on and a Postgres role for you, created by a project owner (Settings → Lakebase shows the SQL). Sign-in uses the official [Databricks CLI](https://docs.databricks.com/dev-tools/cli/); if it isn't installed, **Settings → Databricks** installs it for you (checksum-verified, into `~/.local/bin`). The **Databricks Agents** types need a Buzz build that includes the plugin harness kit (`ctx.agents.harness`, block/buzz-app#2364).

## How sign-in works

- **Zero clicks** if you already use the Databricks CLI: your saved profile (or `DEFAULT`) is reused.
- **One click** otherwise: **Sign in with Databricks** opens `login.databricks.com`, where you sign in with your company SSO and pick a workspace. Tokens refresh automatically and live in your OS keychain, shared with your other Databricks tools.
- Only the core **Databricks** plugin has host access. It declares each CLI subcommand it runs (`databricks auth token`, `auth login`, `auth profiles`, `--version`), the installer, and `curl` for HTTPS. Requests and bearer tokens go to curl on stdin, never in process arguments, and curl is limited to HTTPS (`--proto =https`). Every other plugin has no host access and goes through the core plugin's `databricks` service.

## Governance

Everything runs as **you**, with your Unity Catalog permissions. When content is shared into a conversation, these plugins keep that sharing explicit:

- SQL in a message is shared as **SQL, not results**. Each reader's **▶ Run** uses their own access.
- **Ask Genie** shows the answer to you first. It reaches the conversation only when you choose **Insert into message**.
- Link chips and panels read Databricks objects with the viewer's own sign-in.
- Agent tools tell agents that their results come from the owner's access and are visible to everyone in the conversation. SQL from agents is read-only unless you allow writes in **Settings → Databricks SQL**.
- Memory entries are owned by the signed-in person: the plugin sets `actor_id`, never the model.

## Develop

```sh
npm install
npm run check        # typecheck, unit + integration tests, build all plugins into plugins/*/dist
npm run playground   # local playground: the built plugins in a mock Buzz with real Databricks calls
DBX_LIVE_PROFILE=<profile> npx vitest run tests/live.test.ts   # live smoke test against a workspace
```

The live test uses the named Databricks CLI profile, creates and deletes a Sandbox and a memory store, and writes what the APIs returned to `tmp/live-report.json`.

`dist/` folders are committed because Buzz installs prebuilt `manifest.json` + `plugin.js` from Git and never runs builds. Types come from `vendor/buzz-author-*.tgz`, generated from block/buzz-app (see `scripts/update-author-types.sh`). See [`docs/design.md`](docs/design.md) for the architecture and decisions.

## License

Apache-2.0. Not an official Databricks or Block product.
