// Signals: Set up account's agent menu (src/agent-choices.ts): grouping by team, search, Add all and who still needs adding to the channel.
import { describe, expect, it } from "vitest";
import { agentGroups, filterGroups, MAX_ROW_AGENTS, missingFromChannel, newlyAssigned, withTeam } from "../plugins/signals/src/agent-choices";

const key = (n: number) => n.toString(16).padStart(64, "0");
const [A, B, C, D, E] = [1, 2, 3, 4, 5].map(key) as [string, string, string, string, string];
const names: Record<string, string> = { [A]: "Genie", [B]: "Poker", [C]: "RemoteAgent", [D]: "Fizz", [E]: "Someone's bot" };
const name = (k: string) => names[k] ?? `${k.slice(0, 8)}…`;

describe("agent menu", () => {
  it("groups by team first, then the channel's other agents, then the viewer's other agents, each agent once", () => {
    const groups = agentGroups({
      channelAgents: [E, A],
      members: [A, B, E],
      own: [{ pubkey: A, name: "Genie" }, { pubkey: B, name: "Poker" }, { pubkey: C, name: "RemoteAgent" }, { pubkey: D, name: "Fizz" }],
      teams: [{ id: "t", name: "Clankers", members: [C, A, "not-a-key", C] }],
      name,
    });
    expect(groups.map((group) => [group.title, group.options.map((option) => [option.name, option.inChannel])])).toEqual([
      ["Clankers", [["RemoteAgent", false], ["Genie", true]]],
      ["Other agents in this channel", [["Someone's bot", true]]],
      ["Your other agents", [["Fizz", false], ["Poker", true]]],
    ]);
    expect(groups[0]!.team).toBe(true);
  });

  it("names the groups plainly without teams, and drops empty ones", () => {
    expect(agentGroups({ channelAgents: [A], members: [A], own: [{ pubkey: A, name: "Genie" }, { pubkey: D, name: "Fizz" }], teams: [{ id: "t", name: "Empty", members: [] }], name }).map((group) => group.title)).toEqual(["In this channel", "Your other agents"]);
    expect(agentGroups({ channelAgents: [], members: [], own: [{ pubkey: D, name: "Fizz" }], teams: [], name }).map((group) => group.title)).toEqual(["Your agents"]);
    expect(agentGroups({ channelAgents: [], members: [], own: [], teams: [], name })).toEqual([]);
  });

  it("searches names and group titles, ignoring a leading @", () => {
    const groups = agentGroups({ channelAgents: [B], members: [B], own: [], teams: [{ id: "t", name: "Clankers", members: [A, C] }], name });
    expect(filterGroups(groups, "@rem").map((group) => group.options.map((option) => option.name))).toEqual([["RemoteAgent"]]);
    expect(filterGroups(groups, "clank").flatMap((group) => group.options.map((option) => option.name))).toEqual(["Genie", "RemoteAgent"]);
    expect(filterGroups(groups, "@")).toEqual(groups);
    expect(filterGroups(groups, "nobody")).toEqual([]);
  });

  it("adds a team after what's picked, without repeats or going past the limit", () => {
    expect(withTeam([B], [A, B, C])).toEqual([B, A, C]);
    const many = Array.from({ length: MAX_ROW_AGENTS - 1 }, (_, n) => key(100 + n));
    expect(withTeam(many, [A, C])).toEqual([...many, A]);
  });

  it("lists picked agents that aren't in the channel once, in the order picked", () => {
    expect(missingFromChannel([[A, C], [C, D], []], [A, B])).toEqual([C, D]);
    expect(missingFromChannel([[A]], [A])).toEqual([]);
  });

  it("finds the agents a save puts on new work, which must join the channel first", () => {
    const saved = { agents: [A], workstream_agents: { tickets: [B] } };
    // Unchanged: nobody new, so an agent that left the channel doesn't hold up an unrelated edit.
    expect(newlyAssigned(saved, { agents: [A], workstream_agents: { tickets: [B] } })).toEqual([]);
    // Workstream names match whatever their case.
    expect(newlyAssigned(saved, { agents: [A], workstream_agents: { Tickets: [B] } })).toEqual([]);
    // An agent already on tickets, newly on questions (which had the account's), is new there.
    expect(newlyAssigned(saved, { agents: [A], workstream_agents: { tickets: [B], questions: [B] } })).toEqual([B]);
    // A new account agent is new for workstreams without their own, but not for tickets.
    expect(newlyAssigned(saved, { agents: [A, C], workstream_agents: { tickets: [B] } })).toEqual([C]);
    // Clearing tickets' own agents hands its tasks to the account's.
    expect(newlyAssigned(saved, { agents: [A], workstream_agents: {} })).toEqual([A]);
    // Taking an agent off isn't assigning anyone.
    expect(newlyAssigned(saved, { agents: [], workstream_agents: { tickets: [B] } })).toEqual([]);
    // A rule's own list goes before its workstream's (the hub's precedence). C, the account's agent, newly on
    // jira-updates: if that rule files under tickets, its tasks had B before, so C is new there.
    const ruled = { agents: [C], workstream_agents: { tickets: [B] } };
    expect(newlyAssigned(ruled, { agents: [C], workstream_agents: { tickets: [B], "jira-updates": [C] } })).toEqual([C]);
    // Clearing a rule's list hands its tasks to its workstream's or the account's: either may be new there.
    expect(newlyAssigned({ agents: [C], workstream_agents: { tickets: [B], "jira-updates": [D] } }, ruled)).toEqual(expect.arrayContaining([B, C]));
    // A new account: everyone picked is new.
    expect(newlyAssigned(undefined, { agents: [A], workstream_agents: { tickets: [D] } })).toEqual([A, D]);
  });
});
