// "Set up account" in a channel's menu: makes the channel an account channel
// in the signals hub. Its tasks are posted there, the team writes how agents
// should handle each kind of work, and agents keep a profile of the account.
// Everything runs as the person opening it; the hub records who changed what.
import type { Context } from "@buzz/author";
import type { PanelProps } from "@dbx/core/host-types";
import { React } from "@dbx/core/react";
import { type DatabricksService, describeError, useAsync, useConnection } from "@dbx/core/service";
import type { Live } from "@dbx/core/suite";
import { ago, Badge, Button, DbxRoot, Disclosure, Field, Notice, SectionHeader, Spinner, Stack, Text } from "@dbx/core/ui/components";
import { capitalized, DEFAULT_MODE, type Mode, MODES, parsePreferences, readWorkstreamActions, type WorkstreamActionsRow } from "../app/model";
import type { Task } from "../app/store";
import { type AgentTeam, agentGroups, missingFromChannel, newlyAssigned, type OwnAgent } from "./agent-choices";
import { AssigneeMark, type Profile, useMembers, useProfiles, useRelay } from "./board-panel";
import { memberChoices } from "./board-view";
import { type AccountView, chosenHub, HubClient } from "./client";
import { rowSummary, withMode } from "./workstream-actions";
import { type AgentSource, EveryRow, InheritedMarks, MODE_HINT, MODE_LABEL, type RowChange, WorkstreamRow } from "./workstream-rows";

/** What a new account channel's preferences start as. */
export const PREFERENCES_TEMPLATE = `How agents handle each kind of work: auto (do it and report), draft (prepare it for one of us to send), ask (ask first) or off (no tasks).

- everything: draft
- meeting prep: auto

Anything else you write here is guidance agents follow, for example:
Keep customer replies short. Copy the account owner on anything about pricing.`;

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

/** The viewer's agents and teams, from Buzz's agents service. */
export type OwnAgentsView = Readonly<{
  snapshot(): Readonly<{ agents?: readonly Readonly<{ pubkey: string; name: string; picture?: string; deleting?: true; unfinished?: true }>[]; teams?: readonly AgentTeam[] }>;
  subscribe(listener: () => void): () => void;
}>;

const NO_AGENTS: readonly OwnAgent[] = [];
const NO_TEAMS: readonly AgentTeam[] = [];

/** The viewer's agents (set up, not being deleted) and teams, kept current. */
function useOwnAgents(live: Live<OwnAgentsView> | undefined): { own: readonly OwnAgent[]; teams: readonly AgentTeam[] } {
  const service = React.useSyncExternalStore(live?.subscribe ?? NO_SUBSCRIBE, live?.snapshot ?? NO_SERVICE);
  const [, bump] = React.useReducer((n: number) => n + 1, 0);
  React.useEffect(() => {
    try {
      return service?.subscribe(bump);
    } catch {
      return undefined;
    }
  }, [service]);
  let read: ReturnType<OwnAgentsView["snapshot"]> | undefined;
  try {
    read = service?.snapshot();
  } catch {
    read = undefined;
  }
  const agents = read?.agents;
  const own = React.useMemo(() => (agents ?? NO_AGENTS).filter((agent) => !("deleting" in agent && agent.deleting) && !("unfinished" in agent && agent.unfinished)), [agents]);
  return { own, teams: read?.teams ?? NO_TEAMS };
}
const NO_SUBSCRIBE = () => () => {};
const NO_SERVICE = () => undefined;

const cleanDomain = (text: string) => text.trim().toLowerCase().replace(/^@/, "");

/** `value` with the chips typed in `raw` (split on commas and new lines) added, skipping repeats. */
function withTyped(value: readonly string[], raw: string, clean: (text: string) => string = (text) => text.trim()): readonly string[] {
  const next = [...value];
  for (const item of raw.split(/[,\n]/).map(clean).filter(Boolean)) if (!next.some((other) => other.toLowerCase() === item.toLowerCase())) next.push(item);
  return next.length === value.length ? value : next;
}

/**
 * A list typed as chips: Enter, a comma or leaving the box adds what's typed; Backspace in an empty box takes the last one off.
 * The text still in the box (`text`) is held by the form, so saving (⌘↵ in the box, say) takes it too.
 */
function TokenInput(props: { label: string; value: readonly string[]; text: string; placeholder: string; onChange(next: readonly string[]): void; onText(text: string): void; clean?(text: string): string }) {
  const { text, onText: setText } = props;
  const input = React.useRef<HTMLInputElement>(null);
  const add = (raw: string) => {
    const next = withTyped(props.value, raw, props.clean);
    if (next !== props.value) props.onChange(next);
    setText("");
  };
  return (
    <div
      className="dbx-input"
      onClick={() => input.current?.focus()}
      style={{ display: "flex", flexWrap: "wrap", gap: 4, alignItems: "center", padding: "3px 6px", minHeight: 32, cursor: "text" }}
    >
      {props.value.map((item) => (
        <span key={item} className="dbx-chip" title={item}>
          <span>{item}</span>
          <button type="button" aria-label={`Remove ${item}`} onClick={(event) => (event.stopPropagation(), props.onChange(props.value.filter((other) => other !== item)))}>×</button>
        </span>
      ))}
      <input
        ref={input}
        aria-label={props.label}
        placeholder={props.value.length ? "" : props.placeholder}
        value={text}
        onChange={(event) => (/[,\n]/.test(event.target.value) ? add(event.target.value) : setText(event.target.value))}
        onKeyDown={(event) => {
          // ⌘↵ goes on to the form, which saves with what's typed here.
          if (event.key === "Enter" && !event.metaKey && !event.ctrlKey && text.trim()) (event.preventDefault(), add(text));
          else if (event.key === "Backspace" && !text && props.value.length) props.onChange(props.value.slice(0, -1));
        }}
        onBlur={() => text.trim() && add(text)}
        style={{ flex: "1 1 60px", minWidth: 60, border: 0, outline: "none", background: "transparent", font: "inherit", color: "inherit", padding: "3px 2px" }}
      />
    </div>
  );
}

/** One of the form's parts: a heading, a line about it, and its fields. */
function Section(props: { title: string; description?: React.ReactNode; first?: boolean; children: React.ReactNode }) {
  const id = React.useId();
  return (
    <section aria-labelledby={id} style={{ display: "flex", flexDirection: "column", gap: 12, padding: props.first ? "4px 0 20px" : "20px 0", borderTop: props.first ? undefined : "1px solid var(--dbx-border)", minWidth: 0 }}>
      <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
        <Text as="h3" id={id} size="lg" weight={600}>{props.title}</Text>
        {props.description && <Text size="sm" tone="subtle" as="div">{props.description}</Text>}
      </div>
      {props.children}
    </section>
  );
}

/** "+ Add workstream", which becomes a box for its name. */
const AddWorkstream = (props: { onAdd(name: string): void }) => {
  const [open, setOpen] = React.useState(false);
  const [adding, setAdding] = React.useState("");
  const opener = React.useRef<HTMLButtonElement>(null);
  const was = React.useRef(false);
  React.useEffect(() => {
    if (!open && was.current) opener.current?.focus();
    was.current = open;
  }, [open]);
  if (!open)
    return (
      <div style={{ borderTop: "1px solid var(--dbx-border)", paddingTop: 12 }}>
        <button ref={opener} type="button" className="dbx-btn" data-variant="ghost" data-size="sm" onClick={() => setOpen(true)} style={{ color: "var(--dbx-subtle)" }}>+ Add workstream</button>
      </div>
    );
  const add = () => {
    if (!adding.trim()) return;
    props.onAdd(adding.trim());
    setAdding("");
    setOpen(false);
  };
  return (
    // Not a <form>: it sits inside the account form. Enter, with or without ⌘, adds the workstream.
    <div
      role="group"
      aria-label="Add a workstream"
      onKeyDown={(event) => {
        if (event.key === "Escape") (event.preventDefault(), event.stopPropagation(), setOpen(false));
        else if (event.key === "Enter" && event.target instanceof HTMLInputElement) (event.preventDefault(), event.stopPropagation(), add());
      }}
      style={{ display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap", borderTop: "1px solid var(--dbx-border)", paddingTop: 12 }}
    >
      <input className="dbx-input" autoFocus aria-label="Workstream or rule id" placeholder="A workstream your rules use, or a rule id" value={adding} maxLength={80} onChange={(event) => setAdding(event.target.value)} style={{ flex: "1 1 180px", minWidth: 0 }} />
      <Button size="sm" disabled={!adding.trim()} onClick={add}>Add</Button>
      <Button size="sm" variant="ghost" onClick={() => setOpen(false)}>Cancel</Button>
    </div>
  );
};

/** The agent menus' groups and names: the viewer's teams and agents, and the channel's agents. */
function useAgentSource(ctx: Context, live: Live<OwnAgentsView> | undefined, channel: { id: string; name: string }, named: readonly string[]): AgentSource & { members: readonly string[] } {
  const members = useMembers(ctx, channel.id);
  const { own, teams } = useOwnAgents(live);
  const keys = [...new Set([...members, ...named, ...own.map((agent) => agent.pubkey), ...teams.flatMap((team) => team.members)])];
  const profiles = useProfiles(ctx, keys);
  const ownBy = new Map(own.map((agent) => [agent.pubkey, agent]));
  const profile = (key: string): Profile | undefined => {
    const found = profiles(key);
    const mine = ownBy.get(key);
    return mine ? { name: found?.name ?? mine.name, ...((found?.picture ?? mine.picture) && { picture: found?.picture ?? mine.picture }), agent: true } : found;
  };
  const name = (key: string) => profile(key)?.name ?? `${key.slice(0, 8)}…`;
  const choices = memberChoices(members, [], [], profile);
  const inChannel = new Set(members);
  return {
    members,
    groups: agentGroups({ channelAgents: choices.filter((member) => member.agent).map((member) => member.key), members, own, teams, name }),
    profile,
    name,
    inChannel: (key) => inChannel.has(key),
    channel: channel.name,
  };
}

type FormProps = { ctx: Context; agents?: Live<OwnAgentsView>; hub: HubClient; channel: { id: string; name: string }; account?: AccountView; workstreams?: readonly string[]; onSaved(account: AccountView, warning?: string): void; onCancel?(): void };

function Form(props: FormProps) {
  const { hub, channel, account } = props;
  const [name, setName] = React.useState(account?.name ?? channel.name.replace(/[-_]+/g, " "));
  const [aliases, setAliases] = React.useState<readonly string[]>(account?.aliases ?? []);
  const [domains, setDomains] = React.useState<readonly string[]>(account?.domains ?? []);
  const [aliasText, setAliasText] = React.useState("");
  const [domainText, setDomainText] = React.useState("");
  const [ids, setIds] = React.useState(idsText(account?.ids));
  const [agents, setAgents] = React.useState<readonly string[]>(account?.agents ?? []);
  const [preferences, setPreferences] = React.useState(account?.preferences ?? PREFERENCES_TEMPLATE);
  const [playbooks, setPlaybooks] = React.useState<Record<string, string>>({ ...(account?.playbooks ?? {}) });
  const [workstreamAgents, setWorkstreamAgents] = React.useState<Record<string, readonly string[]>>({ ...(account?.workstream_agents ?? {}) });
  const [actions, setActions] = React.useState<Record<string, WorkstreamActionsRow>>({ ...(account?.workstream_actions ?? {}) });
  const [added, setAdded] = React.useState<readonly string[]>([]);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string>();
  const [discarding, setDiscarding] = React.useState(false);
  const read = React.useMemo(() => parsePreferences(preferences), [preferences]);
  const source = useAgentSource(props.ctx, props.agents, channel, [...agents, ...Object.values(workstreamAgents).flat()]);
  const writes = useRelay(props.ctx).session?.channelWrites;
  const inherited: Mode = read.modes.everything ?? DEFAULT_MODE;
  const names = workstreamNames(props.workstreams ?? account?.workstreams ?? [], Object.keys(read.modes), Object.keys(actions), Object.keys(workstreamAgents), Object.keys(playbooks), added);
  // What's still typed in a chip box counts: saving takes it.
  const typedAliases = withTyped(aliases, aliasText);
  const typedDomains = withTyped(domains, domainText, cleanDomain);
  const state = JSON.stringify([name, typedAliases, typedDomains, ids, agents, preferences, playbooks, workstreamAgents, actions]);
  const [initial] = React.useState(state);
  const dirty = state !== initial;
  const change = (workstream: string, next: RowChange) => {
    if (next.mode !== undefined) setPreferences((text) => withMode(text, workstream, next.mode ?? undefined, MODES));
    if (next.agents) setWorkstreamAgents((map) => withEntry(map, workstream, next.agents!.length ? next.agents : undefined));
    if (next.actions !== undefined) setActions((map) => withEntry(map, workstream, next.actions ?? undefined));
    if (next.playbook !== undefined) setPlaybooks((map) => withEntry(map, workstream, next.playbook));
  };
  const save = async () => {
    if (busy || !name.trim()) return;
    const checked = readWorkstreamActions(actions);
    if (typeof checked === "string") return setError(checked);
    setBusy(true);
    setError(undefined);
    try {
      const keptAgents = Object.fromEntries(Object.entries(workstreamAgents).filter(([, keys]) => keys.length));
      // Into the channel first, so the agents saving wakes on open tasks can see their threads. The hub asks newly
      // assigned agents to work on open tasks only on the save that assigns them, so nothing is saved until they're in.
      // An agent whose assignment is unchanged (taken out of the channel since) is added again if it can be, but
      // doesn't hold up the rest of the edit.
      const missing = missingFromChannel([agents, ...Object.values(keptAgents)], source.members);
      // The hub says which agents this save hands open tasks to. A hub too old to say: every agent the lists could
      // newly put on a task (newlyAssigned), which may hold up a save the hub wouldn't hand anything off on.
      const fresh = new Set(
        missing.length
          ? await hub.handOffs({ name: account?.name ?? name.trim(), channel: channel.id, agents, workstream_agents: keptAgents }).catch(() =>
              newlyAssigned(account && { agents: account.agents ?? [], workstream_agents: account.workstream_agents ?? {} }, { agents, workstream_agents: keptAgents }),
            )
          : [],
      );
      const problem = await addToChannel(writes, channel, missing.filter((key) => fresh.has(key)), source.name, "first");
      if (problem) return setError(problem);
      const notice = await addToChannel(writes, channel, missing.filter((key) => !fresh.has(key)), source.name, "anyway");
      const saved = await hub.saveAccount({
        name: account?.name ?? name.trim(),
        ...(account && name.trim() !== account.name && { rename: name.trim() }),
        channel: channel.id,
        aliases: typedAliases,
        domains: typedDomains,
        ids: parseIds(ids),
        agents,
        preferences,
        playbooks: Object.fromEntries(Object.entries(playbooks).filter(([, text]) => text.trim())),
        workstream_agents: keptAgents,
        workstream_actions: checked,
      });
      props.onSaved(saved, notice);
    } catch (problem) {
      setError(describeError(problem));
    } finally {
      setBusy(false);
    }
  };
  const missing = missingFromChannel([agents, ...Object.values(workstreamAgents)], source.members);
  return (
    <form
      onSubmit={(event) => (event.preventDefault(), void save())}
      onKeyDown={(event) => event.key === "Enter" && (event.metaKey || event.ctrlKey) && (event.preventDefault(), void save())}
      style={{ display: "flex", flexDirection: "column", minWidth: 0 }}
    >
      <Section first title="Account" description="How sources recognize this customer.">
        <Field label="Name">
          <input className="dbx-input" value={name} onChange={(event) => setName(event.target.value)} />
        </Field>
        <div style={{ display: "flex", flexDirection: "column", gap: 4, minWidth: 0 }}>
          <Text size="sm" weight={500}>Other names</Text>
          <TokenInput label="Other names" placeholder="Acme Corp, Acme Inc" value={aliases} onChange={setAliases} text={aliasText} onText={setAliasText} />
        </div>
        <div style={{ display: "flex", flexDirection: "column", gap: 4, minWidth: 0 }}>
          <Text size="sm" weight={500}>{`${capitalized(account?.labels?.customer ?? "customer")} email domains`}</Text>
          <TokenInput label="Email domains" placeholder="example.com" value={domains} onChange={setDomains} text={domainText} onText={setDomainText} clean={cleanDomain} />
          <Text size="xs" tone="subtle" as="div">Mail, meetings and mentions from these domains open tasks here.</Text>
        </div>
        <Disclosure summary={`Ids in other systems${Object.keys(parseIds(ids)).length ? ` (${Object.keys(parseIds(ids)).length})` : ""}`}>
          <Field label="Ids" hint={<>A line per kind, like <code>crm: 0016100000AbCdE</code>. Events carrying one of these ids find this account.</>}>
            <textarea className="dbx-textarea" rows={3} placeholder="crm: 0016100000AbCdE" value={ids} onChange={(event) => setIds(event.target.value)} />
          </Field>
        </Disclosure>
      </Section>

      <Section title="Who works on what" description="Each kind of work's mode and agents. New tasks mention their agents in the thread.">
        <div style={{ minWidth: 0, marginTop: -4 }}>
          <EveryRow
            {...(read.modes.everything && { mode: read.modes.everything })}
            defaultMode={DEFAULT_MODE}
            agents={agents}
            source={source}
            onMode={(mode) => setPreferences((text) => withMode(text, "everything", mode ?? undefined, MODES))}
            onAgents={setAgents}
          />
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
              inheritedAgents={agents}
              source={source}
              defaultOpen={added.some((other) => other.toLowerCase() === workstream.toLowerCase())}
              onChange={(next) => change(workstream, next)}
            />
          ))}
          <AddWorkstream onAdd={(next) => setAdded((list) => [...list, next])} />
        </div>
        {missing.length > 0 && (
          <Notice>{`${listNames(missing.map(source.name))} ${missing.length === 1 ? "isn't" : "aren't"} in #${channel.name} yet. Saving adds ${missing.length === 1 ? "it" : "them"}, so ${missing.length === 1 ? "it sees its" : "they see their"} tasks.`}</Notice>
        )}
      </Section>

      <Section title="Team guidance" description="Agents read this before every task. Mode lines, like meeting prep: auto, follow the menus above.">
        <textarea className="dbx-textarea" aria-label="Team guidance" rows={7} value={preferences} onChange={(event) => setPreferences(event.target.value)} />
        {read.problems.map((problem) => <Text key={problem} size="xs" tone="danger">{problem}</Text>)}
      </Section>

      <div style={{ position: "sticky", bottom: 0, zIndex: 2, display: "flex", gap: 8, alignItems: "center", padding: "12px 0", marginTop: 4, borderTop: "1px solid var(--dbx-border)", background: "var(--dbx-surface)" }}>
        {discarding ? (
          <>
            <Text size="sm" style={{ flex: "1 1 0", minWidth: 0 }}>Discard changes?</Text>
            <Button variant="danger" onClick={() => props.onCancel?.()}>Discard</Button>
            <Button variant="ghost" onClick={() => setDiscarding(false)}>Keep editing</Button>
          </>
        ) : (
          <>
            <div role={error ? "alert" : "status"} style={{ flex: "1 1 0", minWidth: 0 }}>
              <Text size="xs" tone={error ? "danger" : "tertiary"}>{error ?? (dirty ? "Unsaved changes" : account && !missing.length ? "No changes yet" : "")}</Text>
            </div>
            {props.onCancel && <Button variant="ghost" disabled={busy} onClick={() => (dirty ? setDiscarding(true) : props.onCancel!())}>Cancel</Button>}
            <Button variant="brand" type="submit" disabled={busy || !name.trim() || (Boolean(account) && !dirty && !missing.length)} title="Save (⌘↵)">
              {busy ? <Spinner size={12} /> : null}
              {account ? "Save changes" : "Set up account"}
            </Button>
          </>
        )}
      </div>
    </form>
  );
}

/** "A", "A and B", "A, B and C". */
const listNames = (names: readonly string[]) => (names.length < 2 ? (names[0] ?? "") : `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`);

/**
 * Adds picked agents that aren't in the channel, so they see their tasks. Returns what to tell the person when it couldn't:
 * `first`, before saving (nothing is saved), or `anyway`, after saving the rest of the edit.
 */
async function addToChannel(writes: { addAgents?(channelId: string, keys: readonly string[]): Promise<void> } | undefined, channel: { id: string; name: string }, keys: readonly string[], name: (key: string) => string, when: "first" | "anyway"): Promise<string | undefined> {
  if (!keys.length) return undefined;
  const who = listNames(keys.map(name));
  const them = keys.length === 1 ? "it" : "them";
  if (!writes?.addAgents) return when === "first" ? `Add ${who} to #${channel.name} from the channel's members, then save.` : `Saved. Add ${who} to #${channel.name} from the channel's members, so ${keys.length === 1 ? "it sees its" : "they see their"} tasks.`;
  try {
    await writes.addAgents(channel.id, keys);
    return undefined;
  } catch (problem) {
    const why = describeError(problem).replace(/\.$/, "");
    return when === "first"
      ? `Not saved: ${who} couldn't be added to #${channel.name} (${why}). Try again, or add ${them} from the channel's members.`
      : `Saved, but ${who} couldn't be added to #${channel.name} (${why}). Add ${them} from the channel's members, so ${keys.length === 1 ? "it sees its" : "they see their"} tasks.`;
  }
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
    <Stack gap={14}>
      {[...groups].map(([group, list]) => (
        <Stack key={group} gap={2}>
          <Text size="xs" weight={600} tone="subtle" style={{ textTransform: "uppercase", letterSpacing: "0.03em" }}>{group}</Text>
          {list.map((task) => (
            <div key={task.id} style={{ display: "flex", gap: 8, alignItems: "baseline", minWidth: 0, padding: "3px 0" }}>
              <Text size="xs" tone="tertiary" style={{ flex: "none", fontVariantNumeric: "tabular-nums" }}>#{task.id}</Text>
              <Text size="sm" style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}><span title={task.title}>{task.title}</span></Text>
              <Text size="xs" tone="tertiary" style={{ flex: "none" }}>{ago(task.last_event_at * 1000)}</Text>
            </div>
          ))}
        </Stack>
      ))}
    </Stack>
  );
}

/** A saved account's "Who works on what", read-only: each workstream's mode, agents and what they watch for. */
function Workload(props: { account: AccountView; source: AgentSource }) {
  const { account, source } = props;
  const everything: Mode = account.read.modes.everything ?? DEFAULT_MODE;
  const names = workstreamNames(account.workstreams ?? [], Object.keys(account.read.modes), Object.keys(account.workstream_actions ?? {}), Object.keys(account.workstream_agents ?? {}), Object.keys(account.playbooks ?? {}));
  const rows = [
    { name: "Every workstream", mode: everything, own: Boolean(account.read.modes.everything), agents: account.agents, detail: "Unless a workstream sets its own" },
    ...names.map((workstream) => {
      const own = account.read.modes[workstream.toLowerCase()];
      const mode = own ?? everything;
      const actionsKey = keyIn(account.workstream_actions ?? {}, workstream);
      const agentsKey = keyIn(account.workstream_agents ?? {}, workstream);
      const playbook = keyIn(account.playbooks ?? {}, workstream);
      return {
        name: workstream,
        mode,
        own: Boolean(own),
        agents: agentsKey ? account.workstream_agents[agentsKey]! : [],
        detail: mode === "off" ? "No tasks" : [actionsKey ? rowSummary(account.workstream_actions[actionsKey]) : undefined, playbook && account.playbooks[playbook]?.trim() ? "playbook" : undefined].filter(Boolean).join(" · "),
      };
    }),
  ];
  return (
    <div role="list" style={{ minWidth: 0 }}>
      {rows.map((row, index) => (
        <div role="listitem" key={row.name} style={{ display: "flex", gap: 10, alignItems: "center", padding: "9px 0", borderTop: index ? "1px solid var(--dbx-border)" : undefined, minWidth: 0 }}>
          <div style={{ flex: 1, minWidth: 0 }}>
            <Text size="md" weight={index ? 500 : 600} as="div" style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}><span title={row.name}>{row.name}</span></Text>
            {row.detail && <Text size="xs" tone="tertiary" as="div" style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}><span title={row.detail}>{row.detail}</span></Text>}
          </div>
          {row.mode !== "off" && (
            <span style={{ display: "inline-flex", flex: "none" }} title={row.agents.length ? row.agents.map(source.name).join(", ") : index ? "Every workstream's agents" : "No agents"}>
              {row.agents.slice(0, 4).map((key, at) => (
                <span key={key} style={{ marginLeft: at ? -4 : 0, borderRadius: 6, boxShadow: "0 0 0 2px var(--dbx-surface)", display: "inline-flex" }}>
                  <AssigneeMark assignee={{ kind: "agent", key, label: source.name(key) }} profile={source.profile} size={20} />
                </span>
              ))}
              {row.agents.length > 4 && <Text size="xs" tone="tertiary" style={{ marginLeft: 4 }}>+{row.agents.length - 4}</Text>}
              {!row.agents.length && index > 0 && account.agents.length > 0 && <InheritedMarks keys={account.agents} source={source} size={20} />}
            </span>
          )}
          <span style={{ flex: "none", width: 52, textAlign: "right" }} title={MODE_HINT[row.mode]}>
            <Badge tone={row.mode === "auto" ? "success" : "neutral"}>{MODE_LABEL[row.mode]}</Badge>
          </span>
        </div>
      ))}
    </div>
  );
}

function AccountSummary(props: { ctx: Context; agents?: Live<OwnAgentsView>; hub: HubClient; channel: { id: string; name: string }; account: AccountView; notice?: string; onEdit(): void }) {
  const { account } = props;
  const source = useAgentSource(props.ctx, props.agents, props.channel, [...account.agents, ...Object.values(account.workstream_agents ?? {}).flat()]);
  const facts = [...account.domains, ...(account.aliases.length ? [`also ${account.aliases.join(", ")}`] : [])].join(" · ");
  return (
    <Stack gap={0}>
      {account.warning && <div style={{ paddingBottom: 12 }}><Notice tone="warning">{account.warning}</Notice></div>}
      {props.notice && <div style={{ paddingBottom: 12 }}><Notice tone="warning">{props.notice}</Notice></div>}
      <div style={{ display: "flex", gap: 12, alignItems: "flex-start", paddingBottom: 16, minWidth: 0 }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <Text as="h2" size="xl" weight={600} style={{ overflowWrap: "anywhere" }}>{account.name}</Text>
          {facts && <Text size="sm" tone="subtle" as="div" style={{ overflowWrap: "anywhere" }}>{facts}</Text>}
          {account.updated_by && <Text size="xs" tone="tertiary" as="div" style={{ marginTop: 2 }}>Changed by {account.updated_by}{account.updated_at ? ` ${ago(account.updated_at * 1000)}` : ""}</Text>}
        </div>
        <Button size="sm" onClick={props.onEdit}>Edit</Button>
      </div>
      <Section title="Who works on what">
        <Workload account={account} source={source} />
      </Section>
      <Section title="Open tasks" description="Work on them in their threads.">
        <Tasks hub={props.hub} channel={props.channel.id} />
      </Section>
      <Section title="What agents have learned">
        {account.profile ? <Text size="sm" as="div" style={{ whiteSpace: "pre-wrap" }}>{account.profile}</Text> : <Text size="sm" tone="subtle">Nothing yet. Agents add to it as they work on this account's tasks.</Text>}
      </Section>
    </Stack>
  );
}

/** The "Set up account" channel panel. */
export function accountPanel(ctx: Context, service: DatabricksService, agents?: Live<OwnAgentsView>) {
  return function AccountPanel({ channelContext }: PanelProps) {
    const connection = useConnection(service);
    const hubs = useAsync(async (signal) => (connection.status === "connected" ? chosenHub(service, signal) : undefined), [connection.status]);
    const app = hubs.data?.app;
    const hub = React.useMemo(() => (app ? new HubClient(service.client()!, app) : undefined), [app?.name, app?.url]);
    const found = useAsync(async (signal) => (hub && channelContext ? hub.accountLookup({ channel: channelContext.channelId }, signal) : undefined), [hub, channelContext?.channelId]);
    const [saved, setSaved] = React.useState<{ account: AccountView; notice?: string }>();
    const [editing, setEditing] = React.useState(false);

    let body: React.ReactNode;
    let editingNow = false;
    if (!channelContext) body = <Notice>Open this from a channel's menu.</Notice>;
    else if (connection.status !== "connected") body = <Notice title="Connect Databricks" action={<Button variant="brand" onClick={() => service.openSettings()}>Connect</Button>}>Account channels live in your team's signals hub, a Databricks App.</Notice>;
    else if (hubs.loading || found.loading) body = <Spinner label="Looking for this channel's account" />;
    else if (hubs.error || found.error) body = <Notice tone="danger">{describeError((hubs.error ?? found.error)!)}</Notice>;
    else if (!hub) body = <Notice title="No signals hub in this workspace">Deploy one first (see the Signals plugin's README), then set up account channels here.</Notice>;
    else {
      const account = saved?.account ?? found.data?.account ?? undefined;
      const channel = { id: channelContext.channelId, name: channelContext.channelName };
      editingNow = !account || editing;
      body = editingNow ? (
        <Form
          ctx={ctx}
          {...(agents && { agents })}
          hub={hub}
          channel={channel}
          {...(account && { account, onCancel: () => setEditing(false) })}
          workstreams={account?.workstreams ?? found.data?.workstreams ?? []}
          onSaved={(next, notice) => (setSaved({ account: next, ...(notice && { notice }) }), setEditing(false))}
        />
      ) : (
        <AccountSummary ctx={ctx} {...(agents && { agents })} hub={hub} channel={channel} account={account!} {...(saved?.notice && { notice: saved.notice })} onEdit={() => setEditing(true)} />
      );
    }
    const accountName = saved?.account.name ?? found.data?.account?.name;
    return (
      <DbxRoot>
        <div style={{ padding: "16px 16px 0" }}>
          {editingNow && (
            <div style={{ paddingBottom: 16 }}>
              <Text as="h2" size="xl" weight={600}>{accountName ? `Edit ${accountName}` : `Set up #${channelContext?.channelName ?? "channel"}`}</Text>
              <Text size="sm" tone="subtle" as="div">{accountName ? `Tasks for this account post in #${channelContext?.channelName}.` : "Make this channel an account: its tasks post here, and agents follow what you set."}</Text>
            </div>
          )}
          {!editingNow && !channelContext && <SectionHeader title="Account" />}
          <div style={{ paddingBottom: editingNow ? 0 : 16 }}>{body}</div>
        </div>
      </DbxRoot>
    );
  };
}

/** Every agent's turn: a short pointer to the account tools, so they read the team's preferences first. */
export const ACCOUNT_INSTRUCTIONS = `Signals: when you work on a signals task, or in a channel set up as an account, first call signals_account with the channel id and the task's workstream, and follow its mode for that workstream (auto: do it and report in the task's thread; draft: prepare it for a person to send; ask: ask in the thread first), the team's guidance and the workstream's playbook. Record what you did with signals_task_update. When you learn something lasting about the customer or the team, update the profile with signals_account_learn.`;
