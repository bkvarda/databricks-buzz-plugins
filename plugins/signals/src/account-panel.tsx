// "Set up account" in a channel's menu: makes the channel an account channel
// in the signals hub. Its tasks are posted there, the team writes how agents
// should handle each kind of work, and agents keep a profile of the account.
// Everything runs as the person opening it; the hub records who changed what.
import type { Context } from "@buzz/author";
import type { PanelProps } from "@dbx/core/host-types";
import { React } from "@dbx/core/react";
import { type DatabricksService, describeError, useAsync, useConnection } from "@dbx/core/service";
import { ago, Badge, Button, Card, DbxRoot, Disclosure, Field, Notice, SectionHeader, Spinner, Stack, Text } from "@dbx/core/ui/components";
import { capitalized, DEFAULT_MODE, type Mode, MODES, parsePreferences, readWorkstreamActions, type WorkstreamActionsRow } from "../app/model";
import type { Task } from "../app/store";
import { useMembers, useProfiles } from "./board-panel";
import { memberChoices } from "./board-view";
import { type AccountView, chosenHub, HubClient } from "./client";
import { rowSummary, withMode } from "./workstream-actions";
import { AgentsPicker, MODE_LABEL, type RowChange, WorkstreamRow } from "./workstream-rows";

/** What a new account channel's preferences start as. */
export const PREFERENCES_TEMPLATE = `How agents handle each kind of work: auto (do it and report), draft (prepare it for one of us to send), ask (ask first) or off (no tasks).

- everything: draft
- meeting prep: auto

Anything else you write here is guidance agents follow, for example:
Keep customer replies short. Copy the account owner on anything about pricing.`;

const splitList = (text: string) => text.split(/[,\n]/).map((item) => item.trim()).filter(Boolean);

/** Ids as the form shows them: a line per kind, `crm: 0016100000AbCdE, 0016100000FgHiJ`. */
const idsText = (ids: Readonly<Record<string, readonly string[]>> | undefined) => Object.entries(ids ?? {}).map(([kind, values]) => `${kind}: ${values.join(", ")}`).join("\n");
/** The form's ids lines back as kind → ids (the hub checks the kinds). */
const parseIds = (text: string): Record<string, string[]> => {
  const out: Record<string, string[]> = {};
  for (const line of text.split("\n")) {
    const at = line.indexOf(":");
    if (!line.trim()) continue;
    const kind = (at < 0 ? line : line.slice(0, at)).trim();
    out[kind] = [...(out[kind] ?? []), ...(at < 0 ? [] : line.slice(at + 1).split(",").map((id) => id.trim()).filter(Boolean))];
  }
  return out;
};

/** The entry for a name in a map keyed by workstream (or rule id), whatever its case. */
const keyIn = (map: Readonly<Record<string, unknown>>, name: string) => Object.keys(map).find((key) => key.toLowerCase() === name.toLowerCase());
/** A map with one name's entry set (keeping the key's case) or, with undefined, removed. */
function withEntry<T>(map: Readonly<Record<string, T>>, name: string, value: T | undefined): Record<string, T> {
  const key = keyIn(map, name) ?? name;
  const { [key]: _, ...rest } = map;
  return value === undefined ? rest : { ...rest, [key]: value };
}

/** The workstreams setup shows: the hub's, then the ones only this account names, then the ones added here. */
function workstreamNames(configured: readonly string[], ...maps: readonly (readonly string[])[]): string[] {
  const out: string[] = [];
  for (const name of [...configured, ...maps.flat()]) if (name.trim() && name.toLowerCase() !== "everything" && !out.some((other) => other.toLowerCase() === name.toLowerCase())) out.push(name);
  return out;
}

const AddWorkstream = (props: { onAdd(name: string): void }) => {
  const [adding, setAdding] = React.useState("");
  const add = () => {
    if (!adding.trim()) return;
    props.onAdd(adding.trim());
    setAdding("");
  };
  return (
    <form onSubmit={(event) => (event.preventDefault(), add())} style={{ display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap", borderTop: "1px solid var(--dbx-border)", paddingTop: 10 }}>
      <input className="dbx-input" aria-label="Another workstream or rule id" placeholder="Another workstream or rule id" value={adding} maxLength={80} onChange={(event) => setAdding(event.target.value)} style={{ flex: "1 1 180px", minWidth: 0 }} />
      <Button size="sm" type="submit" disabled={!adding.trim()}>Add workstream</Button>
    </form>
  );
};

function Form(props: { ctx: Context; hub: HubClient; channel: { id: string; name: string }; account?: AccountView; workstreams?: readonly string[]; onSaved(account: AccountView): void }) {
  const { hub, channel, account } = props;
  const [name, setName] = React.useState(account?.name ?? channel.name.replace(/[-_]+/g, " "));
  const [aliases, setAliases] = React.useState(account?.aliases.join(", ") ?? "");
  const [domains, setDomains] = React.useState(account?.domains.join(", ") ?? "");
  const [ids, setIds] = React.useState(idsText(account?.ids));
  const [agents, setAgents] = React.useState<readonly string[]>(account?.agents ?? []);
  const [preferences, setPreferences] = React.useState(account?.preferences ?? PREFERENCES_TEMPLATE);
  const [playbooks, setPlaybooks] = React.useState<Record<string, string>>({ ...(account?.playbooks ?? {}) });
  const [workstreamAgents, setWorkstreamAgents] = React.useState<Record<string, readonly string[]>>({ ...(account?.workstream_agents ?? {}) });
  const [actions, setActions] = React.useState<Record<string, WorkstreamActionsRow>>({ ...(account?.workstream_actions ?? {}) });
  const [added, setAdded] = React.useState<readonly string[]>([]);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string>();
  const read = React.useMemo(() => parsePreferences(preferences), [preferences]);
  const members = useMembers(props.ctx, channel.id);
  const named = [...agents, ...Object.values(workstreamAgents).flat()];
  const profile = useProfiles(props.ctx, [...new Set([...members, ...named])]);
  const choices = memberChoices(members, named, [], profile);
  const inherited: Mode = read.modes.everything ?? DEFAULT_MODE;
  const names = workstreamNames(props.workstreams ?? account?.workstreams ?? [], Object.keys(read.modes), Object.keys(actions), Object.keys(workstreamAgents), Object.keys(playbooks), added);
  const change = (workstream: string, next: RowChange) => {
    if (next.mode !== undefined) setPreferences((text) => withMode(text, workstream, next.mode ?? undefined, MODES));
    if (next.agents) setWorkstreamAgents((map) => withEntry(map, workstream, next.agents!.length ? next.agents : undefined));
    if (next.actions !== undefined) setActions((map) => withEntry(map, workstream, next.actions ?? undefined));
    if (next.playbook !== undefined) setPlaybooks((map) => withEntry(map, workstream, next.playbook));
  };
  const save = async () => {
    const checked = readWorkstreamActions(actions);
    if (typeof checked === "string") return setError(checked);
    setBusy(true);
    setError(undefined);
    try {
      const saved = await hub.saveAccount({
        name: account?.name ?? name.trim(),
        ...(account && name.trim() !== account.name && { rename: name.trim() }),
        channel: channel.id,
        aliases: splitList(aliases),
        domains: splitList(domains),
        ids: parseIds(ids),
        agents,
        preferences,
        playbooks: Object.fromEntries(Object.entries(playbooks).filter(([, text]) => text.trim())),
        workstream_agents: Object.fromEntries(Object.entries(workstreamAgents).filter(([, keys]) => keys.length)),
        workstream_actions: checked,
      });
      props.onSaved(saved);
    } catch (problem) {
      setError(describeError(problem));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Card>
      <Stack gap={12}>
        <Field label="Account" hint="As tasks show it. Sources that name the account (a table column, say) match it or one of its other names.">
          <input className="dbx-input" value={name} onChange={(event) => setName(event.target.value)} />
        </Field>
        <Field label="Other names" hint="Comma-separated, e.g. ACME Corp, Acme Inc.">
          <input className="dbx-input" value={aliases} onChange={(event) => setAliases(event.target.value)} />
        </Field>
        <Field label={`${capitalized(account?.labels?.customer ?? "customer")} email domains`} hint="Mail, meetings and mentions from people at these domains open tasks in this channel (with the hub's shared rules). Colleagues' addresses at these domains don't count.">
          <input className="dbx-input" placeholder="example.com" value={domains} onChange={(event) => setDomains(event.target.value)} />
        </Field>
        <Field label="Ids in other systems" hint={<>A line per kind of id, like <code>crm: 0016100000AbCdE</code> or <code>jira_customer: Example, Example Co</code>. Sources that ask for a kind get every account's ids of it, and events that carry one of these ids find this account.</>}>
          <textarea className="dbx-textarea" rows={3} placeholder="crm: 0016100000AbCdE" value={ids} onChange={(event) => setIds(event.target.value)} />
        </Field>
        <Field label="Agents that work on tasks" hint="Agents in this channel. Each new task mentions them (in auto and draft mode), so they start on it in its thread, unless its workstream picks its own agents below.">
          <AgentsPicker name="the account" empty="None yet" value={agents} choices={choices} profile={profile} onChange={setAgents} />
        </Field>
        <Field label="Workstreams" hint="For each kind of work: its mode, the agents that work on it, what they watch for and the team's playbook. Agents check each update against every action you tick and do each one that applies.">
          <div style={{ minWidth: 0 }}>
            <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap", paddingBottom: 10 }}>
              <Text size="xs" tone="subtle" style={{ flex: "1 1 160px" }}>Mode for everything else</Text>
              <select className="dbx-input" aria-label="Mode for everything else" value={read.modes.everything ?? ""} onChange={(event) => setPreferences((text) => withMode(text, "everything", (event.target.value || undefined) as Mode | undefined, MODES))} style={{ width: "auto", maxWidth: "100%", fontSize: "0.75rem" }}>
                <option value="">{`Default (${DEFAULT_MODE})`}</option>
                {MODES.map((mode) => <option key={mode} value={mode}>{MODE_LABEL[mode]}</option>)}
              </select>
            </div>
            {names.length === 0 && <Text size="xs" tone="subtle" as="div" style={{ borderTop: "1px solid var(--dbx-border)", padding: "10px 0" }}>No workstreams yet. Add one below: a workstream your rules use, or a rule id.</Text>}
            {names.map((workstream) => (
              <WorkstreamRow
                key={workstream.toLowerCase()}
                name={workstream}
                value={{
                  ...(read.modes[workstream.toLowerCase()] && { mode: read.modes[workstream.toLowerCase()]! }),
                  inherited,
                  agents: workstreamAgents[keyIn(workstreamAgents, workstream) ?? workstream] ?? [],
                  ...(keyIn(actions, workstream) && { actions: actions[keyIn(actions, workstream)!]! }),
                  playbook: playbooks[keyIn(playbooks, workstream) ?? workstream] ?? "",
                }}
                choices={choices}
                profile={profile}
                defaultOpen={added.some((other) => other.toLowerCase() === workstream.toLowerCase())}
                onChange={(next) => change(workstream, next)}
              />
            ))}
            <AddWorkstream onAdd={(next) => setAdded((list) => [...list, next])} />
          </div>
        </Field>
        <Field label="Team guidance" hint={<>Everything here is guidance agents follow. Lines like <code>meeting prep: auto</code> set a mode, as the workstreams above do; <code>everything:</code> sets the rest. Modes: {MODES.join(", ")}.</>}>
          <textarea className="dbx-textarea" rows={8} value={preferences} onChange={(event) => setPreferences(event.target.value)} />
        </Field>
        {read.problems.map((problem) => <Text key={problem} size="xs" tone="danger">{problem}</Text>)}
        {error && <Text tone="danger" size="sm">{error}</Text>}
        <Stack direction="row" gap={8}>
          <Button variant="brand" disabled={busy || !name.trim()} onClick={() => void save()}>{busy ? <Spinner size={12} /> : null}{account ? "Save" : "Set up account"}</Button>
        </Stack>
      </Stack>
    </Card>
  );
}

function Tasks(props: { hub: HubClient; channel: string }) {
  const tasks = useAsync<Task[]>(async (signal) => props.hub.tasks({ channel: props.channel, open: true, limit: 50 }, signal), [props.channel]);
  if (tasks.loading) return <Spinner label="Loading tasks" />;
  if (tasks.error) return <Notice tone="danger">{describeError(tasks.error)}</Notice>;
  if (!tasks.data?.length) return <Text tone="subtle" size="sm">No open tasks in this channel.</Text>;
  const groups = new Map<string, Task[]>();
  for (const task of tasks.data) {
    const key = task.initiative ? `Initiative: ${task.initiative}` : (task.workstream ?? "Other");
    groups.set(key, [...(groups.get(key) ?? []), task]);
  }
  return (
    <Stack gap={12}>
      {[...groups].map(([group, list]) => (
        <Stack key={group} gap={4}>
          <Text size="sm" weight={500}>{group}</Text>
          {list.map((task) => (
            <Stack key={task.id} direction="row" gap={6} align="center" wrap>
              <Text size="sm">#{task.id} {task.title}</Text>
              <Badge>{task.status}</Badge>
              <Badge tone={task.mode === "auto" ? "success" : "neutral"}>{task.mode}</Badge>
              <Text size="xs" tone="tertiary">{ago(task.last_event_at * 1000)}</Text>
            </Stack>
          ))}
        </Stack>
      ))}
    </Stack>
  );
}

/** The "Set up account" channel panel. */
export function accountPanel(ctx: Context, service: DatabricksService) {
  return function AccountPanel({ channelContext }: PanelProps) {
    const connection = useConnection(service);
    const hubs = useAsync(async (signal) => (connection.status === "connected" ? chosenHub(service, signal) : undefined), [connection.status]);
    const app = hubs.data?.app;
    const hub = React.useMemo(() => (app ? new HubClient(service.client()!, app) : undefined), [app?.name, app?.url]);
    const found = useAsync(async (signal) => (hub && channelContext ? hub.accountLookup({ channel: channelContext.channelId }, signal) : undefined), [hub, channelContext?.channelId]);
    const [saved, setSaved] = React.useState<AccountView>();
    const [editing, setEditing] = React.useState(false);

    let body: React.ReactNode;
    if (!channelContext) body = <Notice>Open this from a channel's menu.</Notice>;
    else if (connection.status !== "connected") body = <Notice title="Connect Databricks" action={<Button variant="brand" onClick={() => service.openSettings()}>Connect</Button>}>Account channels live in your team's signals hub, a Databricks App.</Notice>;
    else if (hubs.loading || found.loading) body = <Spinner label="Looking for this channel's account" />;
    else if (hubs.error || found.error) body = <Notice tone="danger">{describeError((hubs.error ?? found.error)!)}</Notice>;
    else if (!hub) body = <Notice title="No signals hub in this workspace">Deploy one first (see the Signals plugin's README), then set up account channels here.</Notice>;
    else {
      const account = saved ?? found.data?.account ?? undefined;
      const channel = { id: channelContext.channelId, name: channelContext.channelName };
      body =
        !account || editing ? (
          <Form ctx={ctx} hub={hub} channel={channel} {...(account && { account })} workstreams={account?.workstreams ?? found.data?.workstreams ?? []} onSaved={(next) => (setSaved(next), setEditing(false))} />
        ) : (
          <Stack gap={16}>
            {account.warning && <Notice tone="warning">{account.warning}</Notice>}
            <Card>
              <Stack gap={8}>
                <Stack direction="row" gap={8} align="center" justify="space-between">
                  <Text weight={500}>{account.name}</Text>
                  <Button size="sm" onClick={() => setEditing(true)}>Edit</Button>
                </Stack>
                {account.domains.length > 0 && <Text size="sm" tone="subtle">{capitalized(account.labels?.customer ?? "customer")} domains: {account.domains.join(", ")}</Text>}
                {Object.keys(account.ids ?? {}).length > 0 && <Text size="sm" tone="subtle">Ids: {Object.entries(account.ids).map(([kind, values]) => `${kind} ${values.join(", ")}`).join(" · ")}</Text>}
                <Text size="sm" tone="subtle">{account.agents.length ? `${account.agents.length} agent${account.agents.length === 1 ? " works" : "s work"} on new tasks` : "No agents work on new tasks yet"}</Text>
                <Stack direction="row" gap={6} wrap>
                  {Object.entries(account.read.modes).map(([key, mode]) => <Badge key={key}>{`${key}: ${mode}`}</Badge>)}
                </Stack>
                {Object.keys(account.playbooks ?? {}).length > 0 && <Text size="sm" tone="subtle">Playbooks: {Object.keys(account.playbooks).join(", ")}</Text>}
                {Object.keys(account.workstream_agents ?? {}).length > 0 && <Text size="sm" tone="subtle">Own agents: {Object.entries(account.workstream_agents).map(([name, keys]) => `${name} (${keys.length})`).join(", ")}</Text>}
                {Object.keys(account.workstream_actions ?? {}).length > 0 && <Text size="sm" tone="subtle">Actions: {Object.entries(account.workstream_actions).map(([name, row]) => `${name} (${rowSummary(row).replace(/^./, (first) => first.toLowerCase())})`).join(", ")}</Text>}
                {account.updated_by && <Text size="xs" tone="tertiary">Changed by {account.updated_by}{account.updated_at ? ` ${ago(account.updated_at * 1000)}` : ""}</Text>}
              </Stack>
            </Card>
            <Stack gap={8}>
              <SectionHeader title="Open tasks" description="From your team's sources, grouped by initiative and workstream. Work on them in their threads." />
              <Tasks hub={hub} channel={channel.id} />
            </Stack>
            <Disclosure summary="What agents have learned">
              {account.profile ? <Text size="sm" as="div" style={{ whiteSpace: "pre-wrap" }}>{account.profile}</Text> : <Text size="sm" tone="subtle">Nothing yet. Agents add to it as they work on this account's tasks.</Text>}
            </Disclosure>
          </Stack>
        );
    }
    return (
      <DbxRoot>
        <div style={{ padding: 16 }}>
          <Stack gap={16}>
            <SectionHeader title={channelContext ? `Account for #${channelContext.channelName}` : "Account"} description="Tasks for the account are posted here, and agents follow the team's preferences." />
            {body}
          </Stack>
        </div>
      </DbxRoot>
    );
  };
}

/** Every agent's turn: a short pointer to the account tools, so they read the team's preferences first. */
export const ACCOUNT_INSTRUCTIONS = `Signals: when you work on a signals task, or in a channel set up as an account, first call signals_account with the channel id and the task's workstream, and follow its mode for that workstream (auto: do it and report in the task's thread; draft: prepare it for a person to send; ask: ask in the thread first), the team's guidance and the workstream's playbook. Record what you did with signals_task_update. When you learn something lasting about the customer or the team, update the profile with signals_account_learn.`;
