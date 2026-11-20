// Signals: turn events from your own sources (Gmail, Calendar, Drive, Jira,
// Slack, tables) into tasks in your team's Buzz channels, through a signals
// hub (a Databricks App with Lakebase). Every source is off until you turn it
// on here, and is read as you, with your own sign-in to it.
import type { Context } from "@buzz/author";
import type { DatabricksApp } from "@dbx/core/api/apps";
import { bindReact, React } from "@dbx/core/react";
import { type DatabricksService, describeError, useAsync, useConnection, usePreference } from "@dbx/core/service";
import { attach, MissingCore, useLive } from "@dbx/core/suite";
import { ago, Badge, Button, CodeView, DbxRoot, Notice, SectionHeader, Spinner, Stack, Text, openExternal } from "@dbx/core/ui/components";
import { WorkspaceField } from "@dbx/core/ui/workspace";
import { type FollowedService, followWorkspace } from "@dbx/core/workspace-choice";
import type { SourceInfo } from "../app/model";
import { chosenHub, HUB_PREFERENCE, HubClient, lakebaseSnippet, type Onboarding, type SignIn, signInPath, signInState, type SourceState } from "./client";
import { ACCOUNT_INSTRUCTIONS, accountPanel } from "./account-panel";
import { BOARD_PAGE, boardPage, boardPanel, taskPanel, validBoardRoute } from "./board-panel";
import { optionalService } from "@dbx/core/host-types";
import { LiveTasks } from "./live-tasks";
import { type PostMessage, TaskPostCard, ThreadPostCard } from "./post-cards";
import { isTaskPost, parseThreadPost, readTaskTarget } from "./posts";
import { signalsTools } from "./tools";
import { findPollerJob, type PollerJob, setUpPollerJob } from "./poller-job";

export const inject = ["react", "settingsCards", "panels", "pages", "conversation"];

/** In the main connection's preferences: the CLI profile the hub runs in. */
export const WORKSPACE_PREF = "signalsWorkspace";

// Where the hub lives can differ from Buzz's workspace (a demo workspace with
// Lakebase, say), so Signals has its own choice, "Same as Buzz" by default.
function HubWorkspace(props: { main: DatabricksService; service: FollowedService }) {
  const [, setProfile] = usePreference<string>(props.main, WORKSPACE_PREF);
  const profile = props.service.profile();
  return (
    <Stack gap={8}>
      <SectionHeader title="Workspace" description="The workspace your signals hub runs in. Agents' signals tools use it too." />
      <WorkspaceField service={props.main} {...(profile && { profile })} onChange={setProfile} />
    </Stack>
  );
}

function SourceRow(props: { service: DatabricksService; hub: HubClient; info: SourceInfo; state?: SourceState; onChange(sources: SourceState[]): void }) {
  const { service, hub, info, state } = props;
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string>();
  const signIn = useAsync<SignIn | undefined>(async (signal) => (info.service ? signInState(await service.ready(signal), info.service, signal) : undefined), [info.service]);
  const on = state?.enabled === true;
  const toggle = async (enabled: boolean, forget = false) => {
    setBusy(true);
    setError(undefined);
    try {
      props.onChange((await hub.setSource(info.name, enabled, forget)).sources);
    } catch (problem) {
      setError(describeError(problem));
    } finally {
      setBusy(false);
    }
  };
  const loginUrl = info.service ? service.workspaceUrl(signInPath(info.service)) : undefined;
  return (
    <div className="dbx-card" style={{ padding: 12 }}>
      <Stack gap={6}>
        <Stack direction="row" align="center" justify="space-between" gap={10}>
          <Stack gap={2} style={{ minWidth: 0 }}>
            <Stack direction="row" gap={6} align="center">
              <Text weight={500}>{info.label}</Text>
              {on ? <Badge tone="success">On</Badge> : <Badge>Off</Badge>}
              {signIn.data === "needed" && <Badge tone="warning">Not signed in</Badge>}
              {signIn.loading && info.service && <Spinner size={10} />}
            </Stack>
            {info.description && <Text tone="subtle" size="sm">{info.description}</Text>}
            {on && (
              <Text tone="tertiary" size="xs">
                {state?.last_post_at ? `Last read ${ago(state.last_post_at * 1000)} (${state.last_count ?? 0} items)` : "Not read yet: your poller job reads it on its next run."}
              </Text>
            )}
            {on && state?.last_error && <Text tone="danger" size="xs">{state.last_error}</Text>}
          </Stack>
          <Stack direction="row" gap={6} align="center" style={{ flex: "none" }}>
            {signIn.data === "needed" && loginUrl && (
              <Button size="sm" onClick={() => openExternal(loginUrl)}>
                Sign in
              </Button>
            )}
            {on ? (
              <>
                <Button size="sm" disabled={busy} onClick={() => void toggle(false)}>Turn off</Button>
                <Button size="sm" variant="danger" disabled={busy} title="Turn it off and delete what the hub keeps from it" onClick={() => void toggle(false, true)}>Forget</Button>
              </>
            ) : (
              <Button size="sm" variant="brand" disabled={busy || signIn.data === "needed"} onClick={() => void toggle(true)}>
                {busy ? <Spinner size={12} /> : null}Turn on
              </Button>
            )}
          </Stack>
        </Stack>
        {error && <Text tone="danger" size="sm">{error}</Text>}
      </Stack>
    </div>
  );
}

// Your poller job logs in to the hub's database as your own Postgres role; this
// says whether you have one, makes it when the hub can, and gives the settings.
function PollerSetup(props: { hub: HubClient; service: DatabricksService }) {
  const { hub, service } = props;
  const looked = useAsync(async (signal) => hub.onboarding(signal), [hub]);
  const [state, setState] = React.useState<Onboarding>();
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string>();
  React.useEffect(() => setState(looked.data), [looked.data]);
  const create = async () => {
    setBusy(true);
    setError(undefined);
    try {
      setState(await hub.createRole());
    } catch (problem) {
      setError(describeError(problem));
    } finally {
      setBusy(false);
    }
  };
  const snippet = state && lakebaseSnippet(state);
  const existing = useAsync(async (signal) => (state ? findPollerJob(await service.ready(signal), state.user, signal) : undefined), [state?.user]);
  const [slackId, setSlackId] = React.useState("");
  const [job, setJob] = React.useState<PollerJob>();
  const [jobBusy, setJobBusy] = React.useState(false);
  const [jobError, setJobError] = React.useState<string>();
  const jobId = job?.jobId ?? existing.data;
  const makeJob = async () => {
    if (!state) return;
    setJobBusy(true);
    setJobError(undefined);
    try {
      setJob(await setUpPollerJob(await service.ready(), state, { ...(slackId.trim() && { slackUserId: slackId.trim() }) }));
    } catch (problem) {
      setJobError(describeError(problem));
    } finally {
      setJobBusy(false);
    }
  };
  const jobUrl = jobId ? service.workspaceUrl(`/jobs/${jobId}`) : undefined;
  return (
    <Stack gap={10}>
      <SectionHeader title="Your poller" description="A job that runs as you reads the sources you turn on and writes what it finds to the hub's database, as your own database role." />
      {looked.loading && <Spinner size={12} />}
      {looked.error && <Notice tone="danger" title="Couldn't check your poller setup">{describeError(looked.error)}</Notice>}
      {state && (
        <div className="dbx-card" style={{ padding: 12 }}>
          <Stack gap={8}>
            <Stack direction="row" align="center" justify="space-between" gap={10}>
              <Stack direction="row" gap={6} align="center">
                <Text weight={500}>Database role</Text>
                {state.role === "waiting" ? <Badge tone="warning">Not set up</Badge> : <Badge tone="success">{state.role === "created" ? "Created" : "Ready"}</Badge>}
              </Stack>
              {state.role === "waiting" && (
                <Button size="sm" variant="brand" disabled={busy} onClick={() => void create()}>
                  {busy ? <Spinner size={12} /> : null}Create my role
                </Button>
              )}
            </Stack>
            <Text tone="subtle" size="sm">{state.role === "waiting" ? (state.waiting?.reason ?? "You don't have a role in the hub's database yet.") : `${state.user} can write to the hub's inbox.`}</Text>
            {state.role === "waiting" && state.waiting?.command && (
              <Stack gap={4}>
                <Text tone="tertiary" size="xs">If the hub can't create it, someone with Can Manage on the database project can run:</Text>
                <CodeView code={state.waiting.command} language="bash" copy />
              </Stack>
            )}
            {error && <Text tone="danger" size="sm">{error}</Text>}
          </Stack>
        </div>
      )}
      {state && state.role !== "waiting" && state.lakebase && (
        <div className="dbx-card" style={{ padding: 12 }}>
          <Stack gap={8}>
            <Stack direction="row" align="center" justify="space-between" gap={10}>
              <Stack direction="row" gap={6} align="center">
                <Text weight={500}>Poller job</Text>
                {existing.loading ? <Spinner size={10} /> : jobId ? <Badge tone="success">Set up</Badge> : <Badge>Not set up</Badge>}
              </Stack>
              <Stack direction="row" gap={6} align="center">
                {jobUrl && <Button size="sm" onClick={() => openExternal(jobUrl)}>Open job</Button>}
                <Button size="sm" variant={jobId ? "default" : "brand"} disabled={jobBusy || existing.loading} onClick={() => void makeJob()}>
                  {jobBusy ? <Spinner size={12} /> : null}{jobId ? "Update my job" : "Create my job"}
                </Button>
              </Stack>
            </Stack>
            <Text tone="subtle" size="sm">
              Puts poller.py and a sources.json with your personal sources (Gmail, Calendar, Drive, Slack, Jira) in <code>{state.folder}</code>, and runs it as you every 15 minutes on serverless. It only reads the sources you turn on above. Shared table sources aren't in it: one job reads those for everyone.
            </Text>
            {!jobId && (
              <Stack direction="row" gap={6} align="center">
                <Text size="sm">Your Slack user id</Text>
                <input className="dbx-input" placeholder="U01ABCDEF (optional; without it, Slack is left out)" value={slackId} onChange={(event) => setSlackId(event.target.value)} style={{ maxWidth: 320 }} />
              </Stack>
            )}
            {job && <Text tone="success" size="sm">{job.created ? "Created your job" : "Updated your job"} and started a first run.{job.keptSources ? " Your sources.json was already there, so it was kept as it is." : ""}</Text>}
            {jobError && <Text tone="danger" size="sm">{jobError}</Text>}
          </Stack>
        </div>
      )}
      {state && snippet && (
        <Stack gap={4}>
          <Text tone="subtle" size="sm">To set it up by hand instead, add this to <code>{state.folder}/sources.json</code>, and have your job run <code>{state.folder}/poller.py</code> with <code>{state.args.join(" ")}</code>:</Text>
          <CodeView code={snippet} language="json" copy />
        </Stack>
      )}
    </Stack>
  );
}

function SignalsSettings(props: { service: DatabricksService }) {
  const { service } = props;
  const snapshot = useConnection(service);
  // Changes when the workspace chosen above does, so the hub is found again.
  const workspace = "profile" in snapshot ? snapshot.profile.host : undefined;
  const [picked, setPicked] = usePreference<string>(service, HUB_PREFERENCE);
  const hubs = useAsync(async (signal) => chosenHub(service, signal), [snapshot.status, workspace, picked]);
  const app = hubs.data?.app;
  const hub = React.useMemo(() => (app ? new HubClient(service.client()!, app) : undefined), [app?.name, app?.url, snapshot.status, workspace]);
  const [sources, setSources] = React.useState<SourceState[]>();
  const loaded = useAsync(async (signal) => (hub ? hub.sources(signal) : undefined), [hub]);
  React.useEffect(() => setSources(loaded.data?.sources), [loaded.data]);

  if (snapshot.status !== "connected")
    return <Notice title="Connect Databricks" action={<Button variant="brand" onClick={() => service.openSettings()}>Connect</Button>}>Signals reads your sources as you, through your Databricks workspace.</Notice>;
  if (hubs.loading) return <Stack direction="row" gap={8} align="center"><Spinner size={12} /><Text tone="subtle">Looking for a signals hub…</Text></Stack>;
  if (hubs.error) return <Notice tone="danger" title="Couldn't list Databricks Apps">{describeError(hubs.error)}</Notice>;
  if (!app)
    return (
      <Notice title="No signals hub in this workspace">
        A signals hub is a Databricks App with a Lakebase database whose description starts with “{`Signals hub`}”. See the plugin's README for deploying one; then come back here to turn on your sources.
      </Notice>
    );
  const catalog = loaded.data?.catalog ?? [];
  const extra = (sources ?? []).filter((state) => !catalog.some((info) => info.name === state.source)).map((state): SourceInfo => ({ name: state.source, label: state.source }));
  return (
    <Stack gap={20}>
      <Stack gap={8}>
        <SectionHeader
          title="Hub"
          description={<>Tasks are kept in <b>{app.name}</b>{app.url ? "" : " (not running)"}. Your sources are read by a job that runs as you, so the hub only gets what you can read, and only from sources you turn on.</>}
        />
        {(hubs.data?.apps.length ?? 0) > 1 && (
          <select className="dbx-input" value={app.name} onChange={(event) => setPicked(event.target.value)} style={{ maxWidth: 320 }}>
            {hubs.data!.apps.map((found: DatabricksApp) => <option key={found.name} value={found.name}>{found.name}</option>)}
          </select>
        )}
      </Stack>
      <Stack gap={10}>
        <SectionHeader title="Your sources" description="Off until you turn them on. Turning one off stops it; Forget also deletes what the hub keeps from it (tasks others work on stay)." />
        {loaded.loading && <Spinner size={12} />}
        {loaded.error && <Notice tone="danger" title="Couldn't reach the hub">{describeError(loaded.error)}</Notice>}
        {hub && [...catalog, ...extra, { name: "agent", label: "Agents", description: "Events your agents send with signals_event." }].map((info) => (
          <SourceRow key={info.name} service={service} hub={hub} info={info} state={sources?.find((state) => state.source === info.name)} onChange={setSources} />
        ))}
      </Stack>
      {hub && <PollerSetup hub={hub} service={service} />}
    </Stack>
  );
}

const HUB_AUTHORS_KEY = "signals.hubAuthors";

/**
 * The hub's posts as cards: a task where it's posted, and the hub's replies in
 * its thread. Replies are only taken from authors seen posting a task, so an
 * agent's own "Update:" stays as it wrote it.
 */
function registerPosts(ctx: Context, scope: Context, databricks: DatabricksService) {
  const live = new LiveTasks(databricks);
  const authors = new Set<string>();
  try {
    for (const key of JSON.parse(globalThis.localStorage?.getItem(HUB_AUTHORS_KEY) ?? "[]") as unknown[]) if (typeof key === "string") authors.add(key);
  } catch {
    // Learned again from the next task post.
  }
  const remember = (author: string) => {
    if (authors.has(author)) return;
    authors.add(author);
    try {
      globalThis.localStorage?.setItem(HUB_AUTHORS_KEY, JSON.stringify([...authors].slice(-20)));
    } catch {
      // Kept for this session only.
    }
  };
  const openBoard = (channel: string) => {
    const navigation = optionalService<{ open(target: unknown): Promise<unknown> }>(ctx, "navigation");
    void navigation?.open({ version: 1, kind: "page", pluginId: "bkvarda.databricks-signals", pageId: BOARD_PAGE, route: { version: 1, params: { channel } } });
  };
  scope.panels.register({ id: "task", title: "Task", matches: (target: string) => readTaskTarget(target) !== undefined, component: taskPanel(ctx, live) });
  scope.conversation.registerMessage({
    id: "task-post",
    title: "Signals task",
    matches: (message: PostMessage) => {
      if (!isTaskPost(message.content)) return false;
      remember(message.authorId);
      return true;
    },
    component: (props: { message: PostMessage; canOpen(target: string): boolean; open(target: string): boolean }) => <TaskPostCard ctx={ctx} live={live} message={props.message} canOpen={props.canOpen} open={props.open} openBoard={openBoard} />,
  });
  scope.conversation.registerMessage({
    id: "task-reply",
    title: "Signals update",
    matches: (message: PostMessage) => Boolean(message.threadRootId) && authors.has(message.authorId) && parseThreadPost(message.content) !== undefined,
    component: (props: { message: PostMessage }) => <ThreadPostCard ctx={ctx} live={live} message={props.message} />,
  });
}

export function apply(ctx: Context) {
  bindReact(ctx.react);
  const live = attach(ctx, { id: "bkvarda.databricks-signals", name: "Signals" }, (scope, main) => {
    // "Same as Buzz" unless chosen in Settings; the card and tools follow it.
    const databricks = followWorkspace(main, WORKSPACE_PREF);
    scope.inject(["agents"], (agents: Context) => {
      for (const tool of signalsTools(databricks)) agents.agents.addTool(tool);
      // Hosts without addInstructions still have the tools, whose descriptions say the same.
      (agents.agents as { addInstructions?(input: { id: string; text: string }): void }).addInstructions?.({ id: "accounts", text: ACCOUNT_INSTRUCTIONS });
    });
    scope.panels.register({
      id: "account",
      title: "Account",
      // Opened from the channel menu only, never from a link.
      matches: () => false,
      channelMenu: { label: "Set up account", eligible: (channel) => !channel.readOnly && !channel.cached },
      channelPlacement: "side",
      component: accountPanel(databricks),
    });
    scope.panels.register({
      id: "board",
      title: "Tasks board",
      matches: () => false,
      channelMenu: { label: "Tasks board", eligible: (channel) => !channel.cached },
      channelPlacement: "tab",
      component: boardPanel(ctx, databricks),
    });
    registerPosts(ctx, scope, databricks);
    return { main, databricks, BoardPage: boardPage(ctx, databricks) };
  });
  // The tasks board in a full-window page, opened from the channel tab (with the channel) or from search (pick an account).
  ctx.pages.register({
    id: BOARD_PAGE,
    title: "Tasks board",
    layout: "workspace",
    route: { version: 1, validate: validBoardRoute },
    component: (props) => {
      const runtime = useLive(live);
      return runtime ? <runtime.BoardPage {...(props.navigation && { navigation: props.navigation })} /> : <MissingCore ctx={ctx} feature="Tasks board" />;
    },
  });
  ctx.settingsCards.register({
    id: "signals",
    title: "Signals",
    component: () => {
      const runtime = useLive(live);
      return runtime ? (
        <DbxRoot>
          <Stack gap={24}>
            <HubWorkspace main={runtime.main} service={runtime.databricks} />
            <SignalsSettings service={runtime.databricks} />
          </Stack>
        </DbxRoot>
      ) : (
        <MissingCore ctx={ctx} feature="Signals" />
      );
    },
  });
}
