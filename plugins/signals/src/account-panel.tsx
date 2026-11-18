// "Set up account" in a channel's menu: makes the channel an account channel
// in the signals hub. Its tasks are posted there, the team writes how agents
// should handle each kind of work, and agents keep a profile of the account.
// Everything runs as the person opening it; the hub records who changed what.
import type { PanelProps } from "@dbx/core/host-types";
import { React } from "@dbx/core/react";
import { type DatabricksService, describeError, useAsync, useConnection } from "@dbx/core/service";
import { ago, Badge, Button, Card, DbxRoot, Disclosure, Field, Notice, SectionHeader, Spinner, Stack, Text } from "@dbx/core/ui/components";
import { capitalized, MAX_PLAYBOOK, MODES, parsePreferences } from "../app/model";
import type { Task } from "../app/store";
import { type AccountView, chosenHub, HubClient } from "./client";

/** What a new account channel's preferences start as. */
export const PREFERENCES_TEMPLATE = `How agents handle each kind of work: auto (do it and report), draft (prepare it for one of us to send), ask (ask first) or off (no tasks).

- everything: draft
- meeting prep: auto
- tickets: draft
- questions: draft

Anything else you write here is guidance agents follow, for example:
Keep customer replies short. Copy the account owner on anything about pricing.`;

/**
 * The team's playbooks, one per workstream: the config's workstreams first,
 * then any others the team added. An empty playbook is dropped on save.
 */
function Playbooks(props: { workstreams: readonly string[]; value: Record<string, string>; onChange(next: Record<string, string>): void }) {
  const { value, onChange } = props;
  const [adding, setAdding] = React.useState("");
  const known = new Set(props.workstreams.map((name) => name.toLowerCase()));
  const names = [...props.workstreams, ...Object.keys(value).filter((name) => !known.has(name.toLowerCase()))];
  const keyOf = (name: string) => Object.keys(value).find((key) => key.toLowerCase() === name.toLowerCase()) ?? name;
  const add = () => {
    const name = adding.trim();
    if (!name) return;
    if (!names.some((other) => other.toLowerCase() === name.toLowerCase())) onChange({ ...value, [name]: "" });
    setAdding("");
  };
  return (
    <Stack gap={8}>
      {names.length === 0 && <Text size="xs" tone="subtle">No workstreams yet. Add one below (a workstream your rules use, or a rule id).</Text>}
      {names.map((name) => {
        const key = keyOf(name);
        const text = value[key] ?? "";
        return (
          <Disclosure key={name} summary={`${name}${text.trim() ? "" : " (no playbook)"}`}>
            <textarea className="dbx-textarea" rows={6} maxLength={MAX_PLAYBOOK} placeholder={`How you like ${name} done: steps, what to include, tone, who to copy…`} value={text} onChange={(event) => onChange({ ...value, [key]: event.target.value })} />
          </Disclosure>
        );
      })}
      <Stack direction="row" gap={6} align="center">
        <input className="dbx-input" placeholder="Another workstream or rule id" value={adding} onChange={(event) => setAdding(event.target.value)} onKeyDown={(event) => event.key === "Enter" && add()} />
        <Button size="sm" disabled={!adding.trim()} onClick={add}>Add playbook</Button>
      </Stack>
    </Stack>
  );
}

const splitList = (text: string) => text.split(/[,\n]/).map((item) => item.trim()).filter(Boolean);

function Form(props: { hub: HubClient; channel: { id: string; name: string }; account?: AccountView; workstreams?: readonly string[]; onSaved(account: AccountView): void }) {
  const { hub, channel, account } = props;
  const [name, setName] = React.useState(account?.name ?? channel.name.replace(/[-_]+/g, " "));
  const [aliases, setAliases] = React.useState(account?.aliases.join(", ") ?? "");
  const [domains, setDomains] = React.useState(account?.domains.join(", ") ?? "");
  const [agents, setAgents] = React.useState(account?.agents.join(", ") ?? "");
  const [preferences, setPreferences] = React.useState(account?.preferences ?? PREFERENCES_TEMPLATE);
  const [playbooks, setPlaybooks] = React.useState<Record<string, string>>({ ...(account?.playbooks ?? {}) });
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string>();
  const read = React.useMemo(() => parsePreferences(preferences), [preferences]);
  const save = async () => {
    setBusy(true);
    setError(undefined);
    try {
      const saved = await hub.saveAccount({
        name: account?.name ?? name.trim(),
        ...(account && name.trim() !== account.name && { rename: name.trim() }),
        channel: channel.id,
        aliases: splitList(aliases),
        domains: splitList(domains),
        agents: splitList(agents),
        preferences,
        playbooks: Object.fromEntries(Object.entries(playbooks).filter(([, text]) => text.trim())),
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
        <Field label={`${capitalized(account?.labels?.customer ?? "customer")} email domains`} hint="Mail and meetings from people at these domains go to this channel's tasks.">
          <input className="dbx-input" placeholder="example.com" value={domains} onChange={(event) => setDomains(event.target.value)} />
        </Field>
        <Field label="Agents that work on tasks" hint="Their npubs or hex pubkeys, comma-separated. Each new task mentions them (in auto and draft mode), so they start on it in its thread. They must be members of this channel.">
          <input className="dbx-input" placeholder="npub1…" value={agents} onChange={(event) => setAgents(event.target.value)} />
        </Field>
        <Field label="Team preferences" hint={<>Lines like <code>meeting prep: auto</code> set how agents handle that workstream (or rule); <code>everything:</code> sets the rest. Modes: {MODES.join(", ")}. Every other line is guidance agents follow.</>}>
          <textarea className="dbx-textarea" rows={12} value={preferences} onChange={(event) => setPreferences(event.target.value)} />
        </Field>
        <Stack direction="row" gap={6} wrap align="center">
          <Text size="xs" tone="subtle">Reads as:</Text>
          {Object.entries(read.modes).length ? Object.entries(read.modes).map(([key, mode]) => <Badge key={key} tone={mode === "off" ? "neutral" : mode === "auto" ? "success" : "warning"}>{`${key}: ${mode}`}</Badge>) : <Text size="xs" tone="subtle">no modes (everything is draft)</Text>}
        </Stack>
        {read.problems.map((problem) => <Text key={problem} size="xs" tone="danger">{problem}</Text>)}
        <Field label="Playbooks" hint="How your team likes each kind of work done. An agent working on a task gets only its workstream's playbook (or its rule's, when one is named by the rule id).">
          <Playbooks workstreams={props.workstreams ?? account?.workstreams ?? []} value={playbooks} onChange={setPlaybooks} />
        </Field>
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
export function accountPanel(service: DatabricksService) {
  return function AccountPanel({ channelContext }: PanelProps) {
    const connection = useConnection(service);
    const hubs = useAsync(async (signal) => (connection.status === "connected" ? chosenHub(service, signal) : undefined), [connection.status]);
    const app = hubs.data?.app;
    const hub = React.useMemo(() => (app ? new HubClient(service.client()!, app) : undefined), [app?.name, app?.url]);
    const found = useAsync(async (signal) => (hub && channelContext ? hub.account({ channel: channelContext.channelId }, signal) : undefined), [hub, channelContext?.channelId]);
    const [saved, setSaved] = React.useState<AccountView>();
    const [editing, setEditing] = React.useState(false);

    let body: React.ReactNode;
    if (!channelContext) body = <Notice>Open this from a channel's menu.</Notice>;
    else if (connection.status !== "connected") body = <Notice title="Connect Databricks" action={<Button variant="brand" onClick={() => service.openSettings()}>Connect</Button>}>Account channels live in your team's signals hub, a Databricks App.</Notice>;
    else if (hubs.loading || found.loading) body = <Spinner label="Looking for this channel's account" />;
    else if (hubs.error || found.error) body = <Notice tone="danger">{describeError((hubs.error ?? found.error)!)}</Notice>;
    else if (!hub) body = <Notice title="No signals hub in this workspace">Deploy one first (see the Signals plugin's README), then set up account channels here.</Notice>;
    else {
      const account = saved ?? found.data ?? undefined;
      const channel = { id: channelContext.channelId, name: channelContext.channelName };
      body =
        !account || editing ? (
          <Form hub={hub} channel={channel} {...(account && { account })} onSaved={(next) => (setSaved(next), setEditing(false))} />
        ) : (
          <Stack gap={16}>
            <Card>
              <Stack gap={8}>
                <Stack direction="row" gap={8} align="center" justify="space-between">
                  <Text weight={500}>{account.name}</Text>
                  <Button size="sm" onClick={() => setEditing(true)}>Edit</Button>
                </Stack>
                {account.domains.length > 0 && <Text size="sm" tone="subtle">{capitalized(account.labels?.customer ?? "customer")} domains: {account.domains.join(", ")}</Text>}
                <Text size="sm" tone="subtle">{account.agents.length ? `${account.agents.length} agent${account.agents.length === 1 ? "" : "s"} work on new tasks` : "No agents work on new tasks yet"}</Text>
                <Stack direction="row" gap={6} wrap>
                  {Object.entries(account.read.modes).map(([key, mode]) => <Badge key={key}>{`${key}: ${mode}`}</Badge>)}
                </Stack>
                {Object.keys(account.playbooks ?? {}).length > 0 && <Text size="sm" tone="subtle">Playbooks: {Object.keys(account.playbooks).join(", ")}</Text>}
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
