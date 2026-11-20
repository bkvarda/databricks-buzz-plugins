# Signals

Turn events from your own sources into tasks in your team's Buzz channels.

- **Sources** are read **as you**, with your own sign-ins: Gmail, Google Calendar, Google Drive, Jira (Atlassian), and Slack, through the Unity Catalog MCP services in `system.ai`, plus any Databricks table you can read.
- **Every source is off** until you turn it on in **Settings → Signals**. You can turn one off at any time, or use **Forget** to also delete what the hub keeps from it.
- **The hub** is a Databricks App with a Lakebase database. It keeps one record per thing (a mail, a meeting, a ticket, a table row) and notices when one changes. The team's **rules** then decide whether a change opens a task, updates a task, or is only recorded. New tasks are posted in their account's channel, and later events go in the task's thread.
- **Agents** get `signals_tasks`, `signals_task`, `signals_task_update` (status, notes, artifacts) and `signals_event`.

## How it fits together

```mermaid
flowchart LR
  subgraph you["Runs as you"]
    job["Poller job (poller.py), scheduled"]
    plugin["Signals plugin: Settings, agent tools"]
  end
  job -- "system.ai.gmail / calendar / drive / atlassian / slack (MCP)" --> mcp[(Your sign-ins)]
  job -- "SQL, your grants" --> tables[(Tables)]
  job -- "POST /api/events, /api/cursor" --> hub
  plugin -- "/api/sources, /api/tasks" --> hub
  hub["Signals hub (Databricks App)"] --> lb[(Lakebase)]
  hub -- "posts tasks as its Buzz identity" --> buzz[(Buzz channels)]
```

**Why a job and not the app?** An app's on-behalf-of token lasts about six minutes, comes without a refresh token, and only arrives with a request. That makes it fine for the Settings card, but the app can't use it to read your mail at 3am, and its service principal can't use your sign-ins. A scheduled job owned by you runs as you and can.

## Deploy

1. **Build:** `npm run build` writes `plugins/signals/hub/`, which holds `app.mjs` (the hub plus its Postgres driver), `app.yaml`, `signals.config.json` (example rules), `poller.py` and `sources.example.json`.
2. **Hub:**
   1. Create a Databricks App whose description starts with **`Signals hub`**; that's how the plugin finds it.
   2. Give it a Lakebase database resource named `postgres` with *Can connect and create*.
   3. Upload `hub/` and deploy it.
   4. Give the people who'll use it **Can Use** on the app.
   5. To post tasks to Buzz, give it a Buzz identity: in Buzz, go to **Agents → New agent → Databricks App → Connect an app you have** and set `BUZZ_IDENTITY_SECRET` in `app.yaml`.
3. **Rules:** the example `signals.config.json` works for any account a team sets up (see [Rules for every account](#rules-for-every-account)), so a new account needs no rule changes. Edit it before deploying for your own kinds of work. Admins (set with `SIGNALS_ADMINS`) can also `POST /api/config`.
4. **Each person:**
   1. Turn sources on in **Settings → Signals**. If the hub runs in another workspace than Buzz's, pick it under **Workspace** there first; the agent tools follow that choice too.
   2. Create a scheduled job (serverless, every 15 minutes, say) **owned by them** that runs `/Workspace/Users/<email>/signals-poller/poller.py --config /Workspace/Users/<email>/signals-poller/sources.json --lakebase [--warehouse <id>]` (a full path: the job's working directory isn't that folder), with `psycopg[binary]` as a dependency. Give them a Postgres role in the hub's database (Lakebase → Roles → add their Databricks identity). `POST /api/onboard`, as them, creates that role when the hub can (it needs the `databricks_auth` extension in the database and `CREATEROLE` on the app's role). Otherwise it says why and gives the `databricks postgres create-role` command for someone with Can Manage on the project. `GET /api/onboard` only looks. **Settings → Signals → Your poller** does all of this as them: **Create my role**, then **Create my job**, which writes `poller.py` and a `sources.json` (the example's personal `mcp` sources, Slack only if they give their Slack user id, and the hub's `lakebase`) to `/Workspace/Users/<email>/signals-poller`, creates the job "Signals poller (<email>)" (serverless, every 15 minutes, `databricks-sdk` and `psycopg[binary]`) and starts a first run. Running it again (or with a job they made by hand that runs `poller.py` from that folder) updates that job's poller task and `poller.py` but keeps an existing `sources.json`. Shared table sources aren't in it; one job reads those for everyone. Both give the `lakebase` settings for their `sources.json` and the job's arguments.
   3. From a laptop signed in with `databricks auth login`, `--hub <app url>` works too, and replies with what each post did.
   4. Try it first with `--dry-run`, which reads every source and prints the events without the hub.

### How a job reaches the hub

Databricks Apps only take OAuth tokens, and a job's token isn't one, so a job can't call the hub's API. It can log in to Lakebase as its owner, though, so `--lakebase` writes to the hub's **inbox** table instead:

- Each person can insert only `kind` and `body`. The row's `owner` is always their own Postgres role (`current_user`), so a post can't claim to be from someone else.
- Row-level security shows each person only their own inbox rows and only their own `sources` rows (source, enabled, cursor, last post, last error). They can't change either table.
- The hub drains the inbox every 30 seconds, through the same path as `POST /api/events` and `POST /api/cursor`, and deletes handled rows after a week.
- Add to `sources.json`: `"lakebase": {"endpoint": "projects/<p>/branches/<b>/endpoints/<e>", "host": "<endpoint host>", "database": "databricks_postgres", "schema": "signals_<app name>"}`. The schema is on the hub's status page.
- Roles with `BYPASSRLS` (Lakebase project owners) aren't limited by these policies. They can read the database anyway.

### Sources in another workspace

Some tables live only in another workspace than the hub's. Run the poller for those sources from a laptop, as yourself, with two profiles: the default one for the workspace with the tables (SQL and MCP calls), and `hub_auth` for the hub's workspace (every hub call: `/api/sources`, `/api/events`, `/api/cursor`, `/api/ids`).

1. Sign in to both: `databricks auth login --profile <tables profile>` and `databricks auth login --profile <hub profile>`.
2. Give that run its own `sources.json` with only those sources, `"hub": "<app url>"` and `"hub_auth": {"profile": "<hub profile>"}`.
3. Run it, every 15 minutes say (cron or launchd): `DATABRICKS_CONFIG_PROFILE=<tables profile> python poller.py --config sources.json --hub <app url> --warehouse <id in the tables workspace>`.

- Its events are yours, like the ones your job posts: the same sources turned on in **Settings → Signals**, cursors and accounts. A source you post from both places shares one cursor, so give each source to only one of them.
- While the laptop is asleep or offline, those sources pause; the next run picks up from their cursors.
- `hub_auth` works only with `--hub`. With `--lakebase` the poller stops and says so.
- A job can't do this as a service principal. Databricks Apps doesn't send the hub an email for a service principal, so the hub turns its calls away (HTTP 401), and the hub keeps sources per person anyway.

## Rules for every account

The example rules don't name an account. They say "from the customer", and the accounts teams set up in their channels say who the customer is:

- `customer_actor: true`: the event's `actor` is at one of an account's email domains (mail from the customer, a Slack message from a customer address).
- `customer_attendees: true`: the meeting has a real customer among its attendees, at one of an account's domains. A colleague's address at the customer's domain doesn't count (see below).
- `account_named_in: "<field>"`: the field names an account, by its name or one of its other names, as whole words. `payload.channel` finds `ext-globex-team` for Globex, which helps in shared Slack channels where the customer's people show no email; `title` finds a meeting's notes, `Globex sync - Notes by Gemini`.
- `skip_own: true`: skip events whose `actor` is the person whose source sent them, like your own Slack messages.
- `known_account: true`: only events about an account the hub knows, one set up in a channel or a config account, found by its name, other names, ids or domains. An event that names some other company opens nothing, rather than a task in `default_channel`. This suits ticket sources that match loosely, where `Customer ~ "Acme"` can also return "Acme Party Inc".

A rule with one or more of the first three applies when any of them holds. The task then goes to that account, and to its channel. With `true`, these rules apply to every account set up in the panel, and to config accounts with `domains`. They can still be patterns instead (`"customer_attendees": "@example\\.com$"`), which apply only to addresses that match. A rule's `account` still overrides the account it finds.

**Sources that know the account.** A table or ticket source that's about one account should say which in the event's `account` (its `map` has `"account": "account_name"`, say). The account's name or other names (an id from another system works as an other name) then match it, with no rule naming the account. A source's query can cover all your accounts instead of one: select the account column, map it to `account`, and give each account that value as one of its other names. A query that only fits one account (`WHERE account_id = '...'`) means every person edits it for each new account.

**Account ids in queries.** A table or ticket source that reads only your accounts' rows needs their ids, and those differ per account. Give each account its ids in the panel's **Ids in other systems**, a line per kind (`crm: 0016100000AbCdE`, `jira_customer: Example, Example Co`), or as `ids` on a config account (`"ids": {"crm": ["0016100000AbCdE"]}`). A kind is a lowercase name of your choosing. The source then names the kinds it uses, `"ids": ["crm"]`, and the poller fills in every account's ids of each kind, read from the hub (`GET /api/ids`, or the `account_ids` table for jobs that reach it through Lakebase):

- **SQL:** `:crm` in a table source's query becomes one bound parameter per id, so `WHERE account_id IN (:crm)` runs as `IN (:crm_0, :crm_1)`. The ids are never pasted into the statement.
- **Tool args (JQL, say):** `{crm: <clause>}` becomes the clause once per id, joined by `OR`, with `{}` as the id. Backslashes and double quotes in the id are escaped, for use inside a quoted string: `({jira_customer: "Customer" ~ "{}"})` becomes `("Customer" ~ "Example" OR "Customer" ~ "Example Co")`.
- **No ids yet:** when no account has ids of a kind a source uses, the poller skips the source and reports it as unavailable, saying which kind is missing.

Map the source's account column to `account`. An account's ids count as its names, so the event then finds the account by an id, as well as by its name or other names. The example `table.usage` and `jira_customers` sources in `sources.example.json` work this way. With ids, a new account needs only the panel, and no one edits the sources.

**Slack.** The example `slack` source fetches only the messages that mention whoever runs it, so its rule needn't name anyone. Don't put a person's Slack id in a shared rule: it would only match that person's mentions.

## Rules

```json
{
  "version": 1,
  "first_run_seen": true,
  "accounts": [{ "name": "Example Co", "channel": "<buzz channel id>", "aliases": ["Example", "EX-1001"], "domains": ["example.com"] }],
  "rules": [
    { "id": "no-automated-mail", "sources": ["gmail"], "when": { "actor": "noreply" }, "action": "ignore" },
    { "id": "customer-mail", "sources": ["gmail"], "customer_actor": true, "action": "task", "title": "Reply: {title}", "group_by": "group_key" },
    { "id": "cases", "sources": ["table.*"], "when": { "payload.status": ["Awaiting Confirmation"] }, "action": "task", "group_by": "external_id", "stale_after_hours": 72, "nudge": "{external_id} has waited {hours}h" },
    { "id": "auto-increases", "sources": ["table.quota"], "when": { "payload.kind": "auto" }, "action": "update", "group": "quota", "group_by": "payload.workspace" },
    { "id": "quota-requests", "sources": ["table.quota"], "action": "task", "group": "quota", "group_by": "payload.workspace" }
  ]
}
```

- Rules are checked **in order**, and the first match wins.
  - In `when` and `unless`, a string is a case-insensitive regular expression and a list is a set of exact values.
  - Fields are the event's own (`title`, `actor`, `account`, `url`, `group_key`, `external_id`) or `payload.<name>`.
  - All `when` conditions must hold. Any one `unless` condition excludes the event.
- There are three actions:
  - `task` opens or updates the task for the event's group.
  - `update` only adds the event to a task that already exists for its group.
  - `ignore` records the event and does nothing else.
- **Groups:** events with the same `group_by` value share one task, across everyone. `group_by` is a field (`payload.workspace`) or a template (`{payload.workspace}/{payload.region}`; values are trimmed and lowercased, and an event whose fields are all empty is its own group). Rules with the same `group` (default: the rule's id) share tasks, so an `update` rule names the group of the rule that opens them. When two people get the same thread, it becomes one task.
- **First run:** with `first_run_seen` on, a source's first post for a person only records what's already there, so turning a source on doesn't flood the channel.
- **Recurring series:** with `series`, a field or a template naming what makes events one series (a meeting's `payload.recurringEventId`), the team decides once per series and account. The first time a series shows up, its task opens in `ask` mode, so no agent starts, and waits with the question **Always / Just this one / Never**. The series' other events are held until someone answers. **Always** opens the series' tasks from now on, in the team's mode, and asks the account's agents to start on this one. **Just this one** goes ahead with this task only, and the series' next event asks again. **Never** dismisses the task, and the series opens no more tasks. The held events then go through the rules again under the answer. Once answered, the task's first message is edited to show its new mode (or that it was dismissed) without the question; the answer and the agents' request are replies in its thread. An answer that isn't one of the three goes to the agents as input, and the series asks again next time. Events without the field open tasks as usual. The example `customer-meetings` rule uses `"series": "payload.recurringEventId"`, and the calendar source puts `recurringEventId` in the payload.
- **Done by itself:** with `done_when`, the hub marks a rule's open tasks done and says why in the thread. Any one of these finishes a task:
  - `when`: the task's latest event matches these conditions, like a ticket whose `payload.status_category` is `["Done"]`. It's checked as each event comes in, even an event the rule itself skips (a rule with `unless` for resolved tickets still hears that its ticket was resolved). A task whose first event is already finished isn't posted.
  - `after`: an event field holding a time, like a meeting's `payload.end` (ISO 8601, Unix seconds, or a calendar `{dateTime}` or `{date}`). The task is done once that time is `grace_hours` past (default 0).
  - `idle_days`: nothing new on the task (no event, no activity) for that many days. The config's `done_idle_days` does this for every rule's tasks, so nothing stays open forever.
  - `by_owner: true`: someone on the team did the work themselves. An event of the task's group whose `actor` is the person whose source sent it (your reply in the customer's Slack thread, mail you sent in the thread) finishes the task as it comes in, even when the rule skips your own messages. The hub records what you did, with its link, makes you the owner if no one was chosen, takes the agents on it off it, and tells them in the thread to stop. A new message from the customer opens it again, still yours. It's decided by time: a reply closes the task only when it's no older than the customer's latest message on it, and a reply that comes in before the customer's message (sources run in any order) closes the task when it opens, without posting it. Your own messages only reach the hub if a source sends them, and each is its own source to turn on in Settings: `gmail.sent` (mail you sent, `in:sent`; the `gmail` source still reads only your inbox) and `slack.sent` (your Slack messages, `from:<@YOUR_SLACK_USER_ID>`). The example `customer-mail` and `customer-slack` rules use it. The example Slack sources key a thread by its channel and its root message's full `thread_ts` (`C123:1795000000.123456`), from the permalink. A Slack task opened under the earlier key (a second: the root's, or the reply's own when a reply opened it) keeps its thread: a message under the new key joins it when it's the only old task holding a message whose stored permalink names that thread, and every Slack message on it names that same thread. It's left alone otherwise (two threads in one second can't be told apart). A team reply and a customer message are ordered by the full time an event gives (Slack's ts to the microsecond), so a reply sent earlier in the same second doesn't close the task. An event saved before that time was kept uses its own Slack permalink's ts (not `thread_ts`, the root's). A customer message older than any team reply already decided on the task doesn't reopen it. Forgetting a source deletes its stored replies too, and a reply being saved or decided while it's forgotten is dropped and closes nothing. Two decisions of the same reply at once take turns (one closes the task, the other finds it done). `tests/signals-postgres.test.ts` checks these overlaps on a real PostgreSQL when `SIGNALS_TEST_PG` names one.

  `note` says what the thread is told (`{field}` takes an event field). The sweep checks `after` and `idle_days` every few minutes. Tasks still waiting on a question are left open, and a new event reopens a done task as usual, unless that event is itself past done (notes for a meeting that's over). For example, `"done_when": { "after": "payload.end", "note": "the meeting has ended" }` for meeting prep, and `"done_when": { "when": { "payload.status_category": ["Done"] }, "note": "{external_id} is {payload.status}" }` for Jira (map `status_category` from `fields.status.statusCategory.name`, as `sources.example.json` does).
- **Same thing, several people:** tasks are shared, so two people's events with the same group key land on one task. Some sources give each person their own ids for the same thing: each mailbox has its own Gmail thread id for the same mail. `same_as` is a `{field}` template whose value is the same in every copy, like the example `customer-mail` rule's `{actor}|{title}|{occurred_at}` (the sender, the subject and the mail's Date header). When a new group's event matches a task's, that group joins the task, so each person's later replies in their own thread go there too. Every field it names must be there; an event missing one opens its own task.
- **Classify:** with `classify`, a rule that would open a new task first asks a small model whether the event really needs the team. This keeps receipts, schedule changes and FYI mail from becoming tasks. Give a yes/no `question`, and optionally `true` and `false`, saying what each answer means. The model sees only the event's source, subject (`title`), sender (`actor`), and `payload.to`, `snippet`, `description`, `text` and `status`; the Gmail source puts the mail's `snippet` in the payload. An event the model scores below `min` (default 0.7, the probability of yes) is recorded as filtered with its score and opens nothing. `GET /api/filtered` lists the last 14 days of these (`?days=`, `?source=`, `?rule=`, `?limit=`), so you can check what it held back. The tasks board's **Filtered** view shows them for its channel (`?channel=`, the channel the task would have gone to), each with its rule, its score against `min`, and the question. Only new tasks are asked about: a later event in a thread that already has a task updates it unasked. When the model can't answer, the task opens anyway. The hub asks the serving endpoint `databricks-openjev-qwen35-4b` as its service principal, which needs **Can query** on it. `SIGNALS_CLASSIFIER` in `app.yaml` names another endpoint, or `off`. The example `customer-mail` rule asks "Is the sender asking a question, asking for help, or reporting a problem?"
- **Watched fields:** with `watch`, a list of event fields like `["payload.es_status"]`, a later event that changes one of them doesn't just add an "Update:" line. The thread is told what changed (`es_status: Mitigated → Resolved`, with `(none)` for a field that's gone), and the agents on the task are mentioned and asked to go on, with the account's briefing and the playbook of the rule the task is under now. Tasks in `ask` mode, or with no agent on them, get the line without the mention. Rules sharing a `group` can split one kind of work by a field (a case with a resolved ticket, an open one, none): when a later event changes a watched field and matches another `task` rule of the group, the task moves to that rule (and its workstream, if it names one), so its next wake gets that rule's playbook. When no `task` rule of the group applies any more (only an `update` rule does, like a case back to Open) and the task's own rule doesn't either, the wake says the task's rule no longer applies, gives the watched fields' values now and the source event, and gives the workstream's playbook instead of that rule's.
- **Nudges:** with `stale_after_hours`, an open task whose latest event still matches the rule after that many hours gets a nudge in its thread, at most once per period.
- **Accounts:** the account comes from the rule's `account`, then the event's own `account` (matched by name or alias), then the account whose `domains` the actor is at, then the first account whose `when` holds, then the account with the most real customers among a meeting's attendees, and last, with the rule's `account_named_in`, the account that field names. The account's `channel` is where its tasks are posted; tasks without one go to `default_channel`. Config accounts take `domains` like the accounts teams set up: `{ "name": "Example Co", "domains": ["example.com"] }`.

- **Labels:** `labels` sets what your deployment calls things, so the public defaults stay generic. `labels.customer` is the word for the people at an account (default "customer"; say "client"), used in agents' briefings, meeting attendee notes and the account panel. `labels.parties` names who a task from outside sits with on the tasks board, by key: `engineering` and `support` are always there (default "Engineering" and "Support"), and you can rename them or add more. A rule's `party` says which one its tasks sit with; without it, the board shows no party (parties are never guessed from the source's name). With a party, the board also shows the event's `owner` or `assignee`. For example:

  ```json
  "labels": { "customer": "client", "parties": { "support": "Customer Care", "partner": "Partner team" } },
  "rules": [{ "id": "partner-escalations", "sources": ["jira"], "party": "partner", "action": "task" }]
  ```

## Account channels

Open a channel's menu and choose **Set up account** to make it an account channel. You give it:
- **Account:** the name tasks show, plus any other names sources use for it.
- **Customer email domains:** mail, meetings and Slack messages from people at these domains open tasks in this channel, with the example rules. Meetings count when a real customer attends, even when one of your own people organized it.
- **Team preferences:** plain text the team edits whenever it wants.

**Add the hub to the channel.** The hub posts tasks as its own Buzz identity (Signals App, say), so add it to the channel with **Add people**, along with the agents that work on tasks. Until it's a member, tasks open but aren't posted, and the panel shows a warning saying so. The relay shows a channel's member list only to its members, so the warning says the hub most likely isn't one; once a post fails, it gives the relay's reason instead. Saving the account checks again.

Tasks for the account are then posted in this channel. That includes tasks already open that had no channel yet. The panel lists the open tasks, grouped by initiative and workstream. Anyone who can use the hub can set up a channel, and the hub records who changed what. A registered account wins over a config account with the same name.

**Preferences.** A line `<workstream or rule id>: <mode>` sets how agents handle that kind of work, and `everything: <mode>` sets the default (`draft` when nothing says):

```text
- everything: draft
- meeting prep: auto
- tickets: off
Keep customer replies short. Copy the account owner on anything about pricing.
```

| Mode | What agents do |
|---|---|
| `auto` | Do the work and report it in the task's thread. |
| `draft` | Prepare it (a draft doc, a reply) for a person to send. |
| `ask` | Ask in the thread before doing anything. |
| `off` | No new tasks open. Tasks already open still get updates. |

Every other line is guidance that agents follow. A task keeps the mode it had when it opened, and its Buzz message shows it.

**Playbooks.** Beside the preferences, the team can write a playbook for each workstream: how it likes that kind of work done (the steps, what to include, the tone, who to copy). The panel lists the workstreams the rules use, and you can add others, or a rule id for one rule's tasks. An agent working on a task gets only that task's playbook: the one named by its rule id, then by its workstream (any case). It comes in the task's wake under "Playbook for …", and from `signals_account` with `workstream`. An empty playbook is the same as none. `POST /api/account` takes `playbooks` as `{workstream: text}`, which replaces them all (`{}` clears them; leave it out to keep them), with up to 30 of up to 6,000 characters each.

**Agents that work on tasks.** List agents (npubs or hex pubkeys) in the account's setup, and each new task's message mentions them, which wakes them in the task's thread:
- In `auto`, they are asked to do the work and report it.
- In `draft`, they are asked to post a draft for a person to send.
- In `ask` and `off`, nobody is mentioned, and a person starts the work.

**Agents for one kind of work.** Each workstream in the panel (next to its playbook) can name its own agents. Its tasks then mention those agents instead of the account's, so Genie can take meeting prep while another agent takes tickets. A rule id works too, and wins over its workstream, the same way playbooks are found. A workstream without agents uses the account's. Naming agents for a workstream later asks them to pick up its open untouched tasks, as adding an account agent does. `POST /api/account` takes `workstream_agents` as `{workstream: [npub or hex, ...]}`, which replaces them all (`{}` clears them; leave it out to keep them), with up to 10 agents each.

The agents must be members of the channel. The hub needs a Buzz identity to post at all.

Agents don't need the Signals tools for this. The task's message includes what `signals_account` would give them: the account's modes, its customer domains, the team's guidance, the task's playbook and the profile, cut down to fit. Each minute the hub checks the threads of the tasks it asked agents to work on, over the last 7 days. It records an agent's first reply on the task in three ways: as activity, as an artifact (`draft` in draft mode, otherwise `reply`) that links to the message, and by moving an `open` task to `in_progress`. Every link in that reply also becomes an asset on the task, once each, typed by its address: `doc`, `sheet`, `slides`, `form`, `drive`, `pr`, `issue`, `code`, `app`, `dashboard`, `notebook`, `workspace`, `slack` or `link`. A Markdown link's text becomes the asset's title. An artifact added with `signals_task_update` and no kind is typed the same way.

When you add an agent to an account, the hub asks it to pick up the account's open auto and draft tasks from the last 14 days, up to 20 of them, that no agent has replied to yet. It does this with a reply in each task's thread that mentions the agent and carries the account briefing. That reply is the agent's wake. Its first reply is then recorded the same way, and the save's response lists those tasks as `woken`.

Every task's post also shows its latest event: its link, when, who it's from, and where. For calendar events it lists the attendees, with people at the account's domains first and marked `customer`. Your own people often have an address at the customer's domain too. When a customer-domain address belongs to the same person as another attendee (the same name, or an address spelled from it, like `disburgh` for `dane.isburgh`), it is marked as theirs, not as a customer. It shows up to 1,500 characters of the description. It adds a short excerpt of the payload's other fields. A calendar source gets attendees and descriptions with `detail` (see `sources.example.json`), which fetches each event with `calendar_event_get`. Times show in the event's own time zone. A rule can match the attendees, with `when` on `payload.attendees`. For meeting prep, use `customer_attendees` instead, as the example `customer-meetings` rule does with `"customer_attendees": true` (any account's domains) or a pattern for the customer's email addresses. The rule then applies only when the meeting has a real customer: someone at those domains who isn't also another attendee, so a team meeting that invites colleagues' customer-domain addresses doesn't open prep.

**Tasks board.** Open it from a channel's menu (Tasks board). It has two views, and it remembers which one you chose: **List**, one row per task grouped by status (Needs input first), and **Swimlanes**, a column per status. Swimlanes scroll sideways, with ‹ › buttons when some are out of view. Filters narrow the board by status, workstream, assignee and mode, and a search box matches a task's number, title, workstream, initiative and source. Each task shows one assignee: **You** when it waits on your input, otherwise its first owner, otherwise the agent that replied in its thread (or the one asked), otherwise **Unassigned**. A task also shows its workstream, mode, source and icons for the links made for it, leaving out the record of the agent's reply and workspace links, which some agents add to every reply. Click a task to open it in place. That shows the question to answer, its owners with **Assign to…** and an **×** each (the same as in the full view), its source, its latest activity, every link made for it, and what you can do: **Steer** (open its thread), **Add agent**, change its status, or **Dismiss**. **Open** shows the task's full view, like an issue. At the top are its title, where it came from (with a link to the source), the question to answer with its options, and the source's quote and facts. Below that is its **Activity**, read live from its Buzz thread as a timeline. The hub's posts are quiet lines: the task opening, answers, assignments, status changes, source updates and done. Each line folds what the hub wrote for agents under **For agents**. More than three lines in a row fold to the last two, with **Show N earlier updates**. Notes between agents are lines too. Comments are cards. A long one is cut short with **Show more** and has **Copy**, except the newest comment and the agent reply the hub recorded on the task (often the draft it's for), which show in full. **Open thread ↗** opens the thread in Buzz. The sidebar holds its **Status**, **Owners**, details (mode, workstream, initiative, account, when it opened, and its last event, or when a meeting starts), the people on it, every asset and **Dismiss task**. In a narrow view, the sidebar sits above the activity, with the details and assets folded. The box at the end of the activity replies in the task's thread and mentions the agent the task is with, so it picks the reply up. When the task is with you or no one, the reply mentions no one. Where Buzz can't show the thread inside the board, the view links to it instead. **Owners** lists who the task is assigned to, and the agents asked to work on it, each with an **×** to take them off. **Assign to…** picks from the channel's members, agents and people. When the task already has owners, you choose **Reassign** (the current owners come off) or **Add**. The hub posts each change in the task's thread and logs it. An agent assigned is mentioned and asked to work on it, with the account's briefing, and the hub records its next reply. A person assigned is mentioned, and no agent wakes. An agent taken off is told to stop. From then on it isn't mentioned by changes to the task or answers to its questions, the hub doesn't wait on its reply, and saving the account's agents doesn't put it back. Only assigning it again does. Agents assigned by a person aren't joined by agents added to the account later. Clicking a task's assignee mark in the list or a swimlane opens it in place with its owners at the top, so assigning or reassigning takes two clicks. If something in the board fails, it shows the error with **Try again** rather than the tab crashing. Agents can do the same with `signals_task_update` (`assign`, `unassign`), for example to hand a task to another agent. **Open in full window ↗** shows the board as a full-window page, where you can also switch to another account channel.

**Needs input.** When an agent can't go on without a person, it puts the task on hold with a question and, optionally, choices. The task moves to `waiting`, its thread says what's asked, and on the Tasks board it shows **You** as its assignee; open it for the question and a **Provide input** button. The answer (a choice, or your own words) is posted in the task's thread mentioning the agent that asked and the task's other agents, the question comes off, and the task goes back to `in_progress`. The hub then records each agent's next reply on the task, as it recorded its first. Agents with the Signals tools ask with `signals_task_update` (`question`, `options` separated by ` / `). Agents without them, such as remote ones, put a line in their reply in the task's thread:

```text
Needs input: Quote the list price or the discount?
Options: List / Discount
```

The `Options:` line is optional. Moving a waiting task to another status by hand takes its question off. `POST /api/task` takes `{id, question, options?}` to ask and `{id, input}` to answer.

**Agents** get `signals_account` (the account, its preferences and its profile) and `signals_account_learn`, which replaces the profile agents keep of the customer and the team. Every agent turn is told to read the account before working on a task and to record what it learns. That profile is how the channel gets better over time. Agents can also file a task under a workstream or initiative with `signals_task_update`.

## Sources (`sources.json`)

- **`mcp` sources** call a tool of a `system.ai` service.
  - `args` and `map` are templates: `{since}` (the source's cursor, or `lookback_hours` back), `{now}`, `{now+7d}`, `{since_epoch}`, `{since_date}`, and `{field.path}` for a field of the item.
  - `items` is where the list sits in the tool's JSON.
  - `sections` is for tools that answer with Markdown instead of a list, like Slack's search. `{"split": "<regex for a heading line>", "keys": [...]}` cuts the text at `items` into one item per section. Each `Key: value` line starts a field, named in lowercase with `_` for spaces, that runs to the next one. With `keys`, only those keys start a field, so a `Note:` line in a message stays part of its text.
  - The example `google_drive` source lists docs changed in the last day; the example `meeting-notes` rule opens a "Follow up:" task for Gemini notes whose title names an account.
  - The example `slack` source finds messages that mention you. Replace `YOUR_SLACK_USER_ID` with your own id; the `slack_search_public_and_private` tool's description names it ("Current logged in user's user_id is U…").
  - When you aren't signed in, the source is reported as unavailable, with the sign-in link.
- **`table` sources** run a query with a `:since` parameter.
  - `table` is checked first. A table that's missing, or one you can't read, makes the source unavailable instead of failing.
  - The cursor is the largest `watermark` value seen.
- **`map`** turns an item into an event:
  - `external_id` (required)
  - `title`, `url`, `actor`, `account`, `group_key`, `occurred_at`
  - `payload`: a list of fields, `"*"` for the whole item, or an object of specs
  - Any spec can be `{"from": "<path or template>", "match": "<regex>"}`: the regex's first group (case-insensitive), or nothing without a match. For example, `{"from": "fields.summary", "match": "workspace (\\d+)"}` pulls a workspace id out of a ticket title.

The hub keeps each source's cursor. The cursor only moves once the hub has the events.

## Privacy

- The hub only takes events for sources the person turned on. Who sent an event comes from Databricks Apps (`X-Forwarded-Email`), never from the request body.
- Posts to Buzz contain only a task's title, account and links, never a mail's body.
