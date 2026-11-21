// Who the account setup's agent menu offers, grouped the way people think of
// their agents: by team first, then the other agents in the channel, then the
// rest of their own agents. Each agent shows once, under its first group.

import { agentsFor } from "../app/model";

/** One of the viewer's own agents, as Buzz's Agents page lists it. */
export type OwnAgent = Readonly<{ pubkey: string; name: string; picture?: string }>;
/** One of the viewer's teams: a name and its agents' pubkeys. */
export type AgentTeam = Readonly<{ id: string; name: string; members: readonly string[] }>;

export type AgentOption = Readonly<{ key: string; name: string; inChannel: boolean }>;
export type AgentGroup = Readonly<{ id: string; title: string; team?: boolean; options: readonly AgentOption[] }>;

/** Most agents one row (or the account) can have; the hub keeps the same limit. */
export const MAX_ROW_AGENTS = 10;

/**
 * The menu's groups: each team (its agents in the order the team lists
 * them), the channel's other agents, then the viewer's other agents. An agent
 * already picked stays in the list, so the menu can show it ticked.
 * `channelAgents` are the channel's members that are agents; `name` names any
 * pubkey (a profile name, else a short key).
 */
export function agentGroups(input: {
  channelAgents: readonly string[];
  members: readonly string[];
  own: readonly OwnAgent[];
  teams: readonly AgentTeam[];
  name(key: string): string;
}): AgentGroup[] {
  const members = new Set(input.members);
  const placed = new Set<string>();
  const ownNames = new Map(input.own.map((agent) => [agent.pubkey, agent.name]));
  const option = (key: string): AgentOption => ({ key, name: ownNames.get(key) || input.name(key), inChannel: members.has(key) });
  const take = (keys: readonly string[]) => {
    const out: AgentOption[] = [];
    for (const key of keys) {
      if (!/^[0-9a-f]{64}$/.test(key) || placed.has(key)) continue;
      placed.add(key);
      out.push(option(key));
    }
    return out;
  };
  const byName = (a: AgentOption, b: AgentOption) => a.name.localeCompare(b.name);
  const groups: AgentGroup[] = [];
  for (const team of input.teams) {
    const options = take(team.members);
    if (options.length) groups.push({ id: `team:${team.id}`, title: team.name, team: true, options });
  }
  const channel = take(input.channelAgents).sort(byName);
  if (channel.length) groups.push({ id: "channel", title: groups.length ? "Other agents in this channel" : "In this channel", options: channel });
  const rest = take(input.own.map((agent) => agent.pubkey)).sort(byName);
  if (rest.length) groups.push({ id: "own", title: groups.length ? "Your other agents" : "Your agents", options: rest });
  return groups;
}

/** The groups keeping only options whose name has every word of `query` (an @ before it is ignored), and groups still holding one. */
export function filterGroups(groups: readonly AgentGroup[], query: string): AgentGroup[] {
  const words = query.replace(/^@/, "").toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return [...groups];
  return groups
    .map((group) => ({ ...group, options: group.options.filter((option) => words.every((word) => option.name.toLowerCase().includes(word) || group.title.toLowerCase().includes(word))) }))
    .filter((group) => group.options.length);
}

/** `value` with a team's agents added after it, in the team's order, without repeats and within MAX_ROW_AGENTS. */
export function withTeam(value: readonly string[], team: readonly string[]): string[] {
  const out = [...value];
  for (const key of team) if (!out.includes(key) && out.length < MAX_ROW_AGENTS) out.push(key);
  return out;
}

/** The picked agents that aren't in the channel yet, each once, in the order picked. */
export function missingFromChannel(picked: readonly (readonly string[])[], members: readonly string[]): string[] {
  const inChannel = new Set(members);
  return [...new Set(picked.flat())].filter((key) => !inChannel.has(key));
}

/** Who works on what, as an account saves it: the account's agents, and workstreams' own (workstream name → keys). */
export type Assignment = Readonly<{ agents: readonly string[]; workstream_agents: Readonly<Record<string, readonly string[]>> }>;

/**
 * The agents a save puts on work they weren't on before. The hub asks these agents to work on open tasks on this save
 * only (handOff), so they have to be in the channel first; agents whose work is unchanged don't.
 *
 * A task's agents come from its rule id's list, else its workstream's, else the account's (agentsFor). The form
 * doesn't know which rules file under which workstreams, so it checks every pairing the lists' names allow, each name
 * as a rule id and as a workstream, and a task matching none: a superset of the hub's tasks, so it never misses one.
 * It can name agents the hub wouldn't hand anything to, so the form asks the hub (HubClient.handOffs) and uses this
 * only when the hub is too old to say.
 */
export function newlyAssigned(before: Assignment | undefined, after: Assignment): string[] {
  const was = { agents: before?.agents ?? [], workstream_agents: before?.workstream_agents ?? {} };
  const names = [...new Set([...Object.keys(was.workstream_agents), ...Object.keys(after.workstream_agents)].map((name) => name.trim().toLowerCase()))];
  const out = new Set<string>();
  for (const rule_id of [undefined, ...names])
    for (const workstream of [undefined, ...names]) {
      const task = { ...(rule_id !== undefined && { rule_id }), workstream: workstream ?? null };
      const old = new Set(agentsFor(was, task));
      for (const key of agentsFor(after, task)) if (!old.has(key)) out.add(key);
    }
  return [...out];
}
