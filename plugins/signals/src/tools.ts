// Agent tools for the signals hub: read tasks, work on them, and send events.
// They run as the owner (their Databricks sign-in), so the hub knows who acted.
import { type AgentTool, numberArg, schema, stringArg } from "@dbx/core/host-types";
import type { DatabricksService } from "@dbx/core/service";
import { capitalized, MODES, playbookFor, TASK_STATUSES } from "../app/model";
import type { Task } from "../app/store";
import { chosenHub, HubClient } from "./client";

async function hub(service: DatabricksService): Promise<HubClient> {
  const { apps, app } = await chosenHub(service);
  if (!app) throw new Error(apps.length ? "Several signals hubs exist; the owner picks one in Settings → Signals." : "There's no signals hub in this workspace yet (Settings → Signals says how to deploy one).");
  return new HubClient(await service.ready(), app);
}

const line = (task: Task) => `- #${task.id} [${task.status}, ${task.mode}] ${task.title}${task.question ? ` · needs input: ${task.question}${task.options?.length ? ` (${task.options.join(" / ")})` : ""}` : ""}${task.account ? ` · ${task.account}` : ""}${task.workstream ? ` · ${task.workstream}` : ""}${task.initiative ? ` · initiative ${task.initiative}` : ""} · ${task.event_count} event${task.event_count === 1 ? "" : "s"}, last ${new Date(task.last_event_at * 1000).toISOString().slice(0, 16)}Z`;

export function signalsTools(service: DatabricksService): AgentTool[] {
  return [
    {
      name: "signals_tasks",
      description: "Lists tasks from the signals hub (events from people's Gmail, Calendar, Jira, tables… turned into tasks by the team's rules). Filter by account, channel (a Buzz channel id) or status; open only by default.",
      inputSchema: schema.object({
        account: schema.string("Account name."),
        channel: schema.string("Buzz channel id the tasks are posted in."),
        workstream: schema.string("Workstream, e.g. meeting prep."),
        initiative: schema.string("Initiative."),
        status: schema.string(`One of ${TASK_STATUSES.join(", ")}.`),
        all: { type: "boolean", description: "Include done and dismissed tasks." },
        limit: schema.integer("Max tasks (default 30, max 200)."),
      }),
      async call(_client, _context, args) {
        const client = await hub(service);
        const tasks = await client.tasks({
          open: !args.all && !args.status,
          ...(stringArg(args, "account", false) && { account: stringArg(args, "account") }),
          ...(stringArg(args, "channel", false) && { channel: stringArg(args, "channel") }),
          ...(stringArg(args, "status", false) && { status: stringArg(args, "status") }),
          ...(stringArg(args, "workstream", false) && { workstream: stringArg(args, "workstream") }),
          ...(stringArg(args, "initiative", false) && { initiative: stringArg(args, "initiative") }),
          limit: numberArg(args, "limit", 30, 1, 200),
        });
        return tasks.length ? tasks.map(line).join("\n") : "No tasks match.";
      },
    },
    {
      name: "signals_task",
      description: "Reads one signals task: what it is, the events behind it (with links), what's been done and the artifacts made for it.",
      inputSchema: schema.object({ id: schema.integer("Task id.") }, ["id"]),
      async call(_client, _context, args) {
        const detail = await (await hub(service)).task(numberArg(args, "id", 0, 0, Number.MAX_SAFE_INTEGER));
        return [
          line(detail.task),
          "",
          "Events (newest first):",
          ...detail.events.map((event) => `- ${event.source} ${event.title ?? event.external_id}${event.url ? ` <${event.url}>` : ""}${event.actor ? ` from ${event.actor}` : ""}`),
          "",
          "Activity:",
          ...detail.activities.map((activity) => `- ${new Date(activity.at * 1000).toISOString().slice(0, 16)}Z ${activity.actor}: ${activity.text}`),
          ...(detail.artifacts.length ? ["", "Artifacts:", ...detail.artifacts.map((artifact) => `- ${artifact.kind}: ${artifact.title ?? artifact.url} <${artifact.url}>`)] : []),
        ].join("\n");
      },
    },
    {
      name: "signals_task_update",
      description: "Works on a signals task: set its status, add a note of what was done, file it under a workstream or initiative, link an artifact (a draft doc, a demo, a PR), or ask for a person's input (question and options: the task waits, and their answer comes to its thread mentioning you). Its Buzz thread gets status changes, questions and artifacts.",
      inputSchema: schema.object(
        {
          id: schema.integer("Task id."),
          status: schema.string(`One of ${TASK_STATUSES.join(", ")}.`),
          note: schema.string("What was done, or why the status changed."),
          workstream: schema.string("File it under this workstream (\"\" clears it)."),
          initiative: schema.string("File it under this initiative (\"\" clears it)."),
          artifact_url: schema.string("A link to something made for the task."),
          artifact_title: schema.string("The artifact's title."),
          artifact_kind: schema.string("doc, demo, code, email draft… (default link)."),
          question: schema.string("Needs input: what you need a person to tell you. The task waits until they answer in its thread or on the Tasks board."),
          options: schema.string("The question's choices, separated by \" / \" (optional)."),
          input: schema.string("Answers the task's question (as a person would)."),
          verdict: schema.string("For a candidate a fan_out rule opened (a feature for one account): qualified, disqualified (also marks it done) or unsure. Put why in note."),
          assign: schema.string("Makes them its owners: npubs (agents) or emails (people), separated by commas. An agent assigned is asked in the thread to work on it."),
          unassign: schema.string("Takes them off it: npubs or emails, separated by commas. An agent taken off is told in the thread to stop, and isn't woken by the task again. Assign another and unassign yourself to hand it off."),
        },
        ["id"],
      ),
      async call(_client, _context, args) {
        const url = stringArg(args, "artifact_url", false);
        const detail = await (await hub(service)).updateTask({
          id: numberArg(args, "id", 0, 0, Number.MAX_SAFE_INTEGER),
          ...(stringArg(args, "status", false) && { status: stringArg(args, "status") }),
          ...(stringArg(args, "note", false) && { note: stringArg(args, "note") }),
          ...(typeof args.workstream === "string" && { workstream: args.workstream }),
          ...(typeof args.initiative === "string" && { initiative: args.initiative }),
          ...(stringArg(args, "question", false) && { question: stringArg(args, "question"), ...(stringArg(args, "options", false) && { options: stringArg(args, "options").split(/\s+\/\s+|\s*\|\s*|\s*;\s*/).filter(Boolean) }) }),
          ...(stringArg(args, "input", false) && { input: stringArg(args, "input") }),
          ...(stringArg(args, "verdict", false) && { verdict: stringArg(args, "verdict") }),
          ...(stringArg(args, "assign", false) && { assign: owners(stringArg(args, "assign")) }),
          ...(stringArg(args, "unassign", false) && { unassign: owners(stringArg(args, "unassign")) }),
          ...(url && { artifact: { url, ...(stringArg(args, "artifact_title", false) && { title: stringArg(args, "artifact_title") }), ...(stringArg(args, "artifact_kind", false) && { kind: stringArg(args, "artifact_kind") }) } }),
        });
        return `Updated: ${line(detail.task)}`;
      },
    },
    {
      name: "signals_account",
      description: `Reads an account channel's setup in the signals hub: the account, its team's preferences (how agents handle each kind of work: ${MODES.join(", ")}, plus their guidance), the team's playbook for a workstream (how they like that work done), and the profile agents keep of the account, its team and its people. Read it before working on a task in that channel, with the task's workstream, and follow it.`,
      inputSchema: schema.object({ channel: schema.string("The Buzz channel id."), name: schema.string("Or the account's name."), workstream: schema.string("The task's workstream (or rule id), for its playbook.") }),
      async call(_client, _context, args) {
        const channel = stringArg(args, "channel", false);
        const name = stringArg(args, "name", false);
        const workstream = stringArg(args, "workstream", false);
        if (!channel && !name) throw new Error("Give channel or name.");
        const account = await (await hub(service)).account({ ...(channel && { channel }), ...(name && { name }) });
        if (!account) return "No account is set up for that. Someone in the channel can set one up from its menu: Set up account.";
        const modes = Object.entries(account.read.modes);
        const names = Object.keys(account.playbooks ?? {});
        const playbook = workstream ? playbookFor(account.playbooks, { rule_id: workstream, workstream }) : undefined;
        const playbookText = workstream
          ? playbook
            ? [`Playbook for ${playbook.key} (how the team likes this done; follow it):`, playbook.text]
            : [`No playbook for ${workstream}${names.length ? ` (the team has playbooks for ${names.join(", ")})` : ""}.`]
          : names.length
            ? [`Playbooks: ${names.join(", ")}. Read the one for your task's workstream with workstream.`]
            : [];
        return [
          `Account: ${account.name}${account.aliases.length ? ` (also ${account.aliases.join(", ")})` : ""}${account.channel ? ` · channel ${account.channel}` : ""}`,
          account.domains.length ? `${capitalized(account.labels?.customer ?? "customer")} domains: ${account.domains.join(", ")}` : "",
          Object.keys(account.ids ?? {}).length ? `Ids: ${Object.entries(account.ids).map(([kind, values]) => `${kind} ${values.join(", ")}`).join("; ")}` : "",
          "",
          `Modes (default draft): ${modes.length ? modes.map(([key, mode]) => `${key}: ${mode}`).join("; ") : "none set"}`,
          "- auto: do the work and report it in the task's thread. draft: prepare it (a draft doc, a reply) for a person to send. ask: ask in the thread before doing anything. off: no tasks.",
          "",
          "Team guidance:",
          account.read.guidance || "(none)",
          "",
          ...playbookText,
          ...(playbookText.length ? [""] : []),
          "Profile (what agents have learned; update it with signals_account_learn):",
          account.profile || "(empty)",
        ]
          .filter((part, index, all) => part !== "" || all[index - 1] !== "")
          .join("\n");
      },
    },
    {
      name: "signals_account_learn",
      description: "Updates the profile agents keep of an account: what you learned about the customer, the account team, how they like to work, open initiatives. Send the whole new profile (short Markdown sections; at most 16,000 characters), not only what's new: read it first with signals_account. Never put secrets or a mail's body in it.",
      inputSchema: schema.object({ channel: schema.string("The account channel's Buzz id."), name: schema.string("Or the account's name."), profile: schema.string("The new profile.") }, ["profile"]),
      async call(_client, _context, args) {
        const client = await hub(service);
        const channel = stringArg(args, "channel", false);
        const name = stringArg(args, "name", false);
        const account = await client.account({ ...(channel && { channel }), ...(name && { name }) });
        if (!account) throw new Error("No account is set up for that channel yet.");
        const saved = await client.saveAccount({ name: account.name, profile: stringArg(args, "profile") });
        return `Saved the profile of ${saved.name} (${saved.profile.length} characters).`;
      },
    },
    {
      name: "signals_event",
      description: "Sends an event to the signals hub as the owner, for a source they turned on (or `agent`, which the owner turns on in Settings → Signals). The team's rules decide whether it opens or updates a task; the same external_id with the same content is recorded once.",
      inputSchema: schema.object(
        {
          source: schema.string("Source name, e.g. agent."),
          external_id: schema.string("The thing's own id at the source."),
          title: schema.string("What happened."),
          url: schema.string("A link to it."),
          account: schema.string("The account it's about."),
          group_key: schema.string("Events with the same group key share a task."),
          payload: { type: "object", description: "Fields the rules can match on." },
        },
        ["source", "external_id", "title"],
      ),
      async call(_client, _context, args) {
        const event = Object.fromEntries(Object.entries(args).filter(([key, value]) => ["source", "external_id", "title", "url", "account", "group_key", "payload"].includes(key) && value !== undefined && value !== ""));
        const reply = await (await hub(service)).events([event]);
        if (reply.errors.length) throw new Error(reply.errors.map((error) => error.error).join("; "));
        if (reply.skipped) return `Skipped: the owner hasn't turned on the source ${String(args.source)} in Settings → Signals.`;
        return reply.created.length ? `Opened task #${reply.created.join(", #")}.` : reply.updated.length ? `Added to task #${reply.updated.join(", #")}.` : reply.same ? "Already recorded; nothing changed." : "Recorded; no rule makes it a task.";
      },
    },
  ];
}

/** Owners from a tool argument: npubs or hex pubkeys are agents, emails people. */
function owners(text: string): { key: string; kind: "agent" | "person" }[] {
  return text.split(/[\s,]+/).filter(Boolean).map((key) => ({ key, kind: key.includes("@") ? "person" : "agent" }));
}
