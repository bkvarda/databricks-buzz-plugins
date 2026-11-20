// Set up account's Workstreams: one row per kind of work. Folded, a row says
// its mode and what agents do; open, it sets the agents that work on it,
// the actions they watch for (each with its trigger; all of them apply),
// what happens when none applies, and the team's playbook.
import { React } from "@dbx/core/react";
import { Button, Stack, Text } from "@dbx/core/ui/components";
import { MAX_ACTION_LABEL, MAX_ACTION_TRIGGER, MAX_ACTIONS, MAX_PLAYBOOK, MODES, type Mode, type WorkstreamAction, type WorkstreamActionsRow } from "../app/model";
import { AssigneeMark, type Profile } from "./board-panel";
import type { Member } from "./board-view";
import { newActionId, retrigger, rowChoices, rowSummary, startRow, toggle } from "./workstream-actions";

/** A mode as a row's menu names it: short enough for a narrow panel. */
export const MODE_LABEL: Record<string, string> = { auto: "Auto · do it", draft: "Draft · prepare it", ask: "Ask · ask first", off: "Off · no tasks" };
const MODE_HINT: Record<string, string> = { auto: "Agents do it and report", draft: "Agents prepare it, a person sends it", ask: "Agents ask before doing anything", off: "No tasks" };

export type RowValue = Readonly<{
  /** Its own mode line, or undefined when it follows the account's `everything` (or the default). */
  mode?: Mode;
  inherited: Mode;
  agents: readonly string[];
  actions?: WorkstreamActionsRow;
  playbook: string;
}>;

export type RowChange = Partial<Readonly<{ mode: Mode | null; agents: readonly string[]; actions: WorkstreamActionsRow | null; playbook: string }>>;

/** Agents picked from the channel's: chips that can be taken off, and a menu to add one. `empty` says what none means. */
export function AgentsPicker(props: { name: string; empty: string; value: readonly string[]; choices: readonly Member[]; profile(key: string): Profile | undefined; onChange(next: readonly string[]): void }) {
  const left = props.choices.filter((member) => member.agent && !props.value.includes(member.key));
  const name = (key: string) => props.profile(key)?.name ?? props.choices.find((member) => member.key === key)?.name ?? `${key.slice(0, 8)}…`;
  return (
    <Stack direction="row" gap={6} align="center" wrap>
      {props.value.length === 0 && <Text size="xs" tone="subtle">{props.empty}</Text>}
      {props.value.map((key) => (
        <span key={key} className="dbx-chip" style={{ display: "inline-flex", alignItems: "center", gap: 4, maxWidth: 200 }}>
          <AssigneeMark assignee={{ kind: "agent", key, label: name(key) }} profile={props.profile} size={14} />
          <span title={name(key)} style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{name(key)}</span>
          <button type="button" aria-label={`Take ${name(key)} off ${props.name}`} onClick={() => props.onChange(props.value.filter((other) => other !== key))} style={{ border: 0, background: "transparent", padding: 0, cursor: "pointer", color: "var(--dbx-tertiary)" }}>×</button>
        </span>
      ))}
      <select className="dbx-input" aria-label={`Add an agent for ${props.name}`} value="" disabled={!left.length || props.value.length >= 10} onChange={(event) => event.target.value && props.onChange([...props.value, event.target.value])} style={{ width: "auto", maxWidth: "100%", fontSize: "0.75rem" }}>
        <option value="">{left.length ? "Add agent…" : "No other agents in this channel"}</option>
        {left.map((member) => <option key={member.key} value={member.key}>{member.name}</option>)}
      </select>
    </Stack>
  );
}

/** One action: its tick, its label and its trigger, which the team can reword. */
function ActionLine(props: { workstream: string; item: WorkstreamAction; ticked: boolean; custom: boolean; onTick(on: boolean): void; onTrigger(text: string): void }) {
  const { item } = props;
  const [editing, setEditing] = React.useState(false);
  const [text, setText] = React.useState(item.trigger);
  const edit = React.useRef<HTMLButtonElement>(null);
  const input = React.useRef<HTMLInputElement>(null);
  const reopened = React.useRef(false);
  React.useEffect(() => {
    if (editing) input.current?.focus();
    else if (reopened.current) edit.current?.focus();
    reopened.current = false;
  }, [editing]);
  const close = (save: boolean) => {
    if (save && text.trim() && text.trim() !== item.trigger) props.onTrigger(text);
    if (!save) setText(item.trigger);
    reopened.current = true;
    setEditing(false);
  };
  const id = `${props.workstream}-${item.id}`.replace(/\W+/g, "-");
  return (
    <div style={{ display: "flex", gap: 8, alignItems: "flex-start", minWidth: 0 }}>
      <input id={id} type="checkbox" checked={props.ticked} onChange={(event) => props.onTick(event.target.checked)} style={{ marginTop: 3, flex: "none" }} />
      <div style={{ minWidth: 0, flex: 1 }}>
        <label htmlFor={id} style={{ cursor: "pointer" }}>
          <Text size="sm" weight={500} tone={props.ticked ? undefined : "subtle"}>{item.label}</Text>
          {props.custom && <Text size="xs" tone="tertiary"> · your own</Text>}
        </label>
        {item.always ? (
          <Text size="xs" tone="tertiary" as="div">When: always, on every task</Text>
        ) : editing ? (
          <form onSubmit={(event) => (event.preventDefault(), close(true))} style={{ display: "flex", gap: 6, flexWrap: "wrap", marginTop: 2 }}>
            <input
              ref={input}
              className="dbx-input"
              aria-label={`When to ${item.label.toLowerCase()}`}
              maxLength={MAX_ACTION_TRIGGER}
              value={text}
              onChange={(event) => setText(event.target.value)}
              onKeyDown={(event) => event.key === "Escape" && (event.preventDefault(), event.stopPropagation(), close(false))}
              style={{ flex: "1 1 220px", minWidth: 0, fontSize: "0.75rem" }}
            />
            <Button size="sm" type="submit" disabled={!text.trim()}>Save trigger</Button>
            <Button size="sm" variant="ghost" onClick={() => close(false)}>Cancel</Button>
          </form>
        ) : (
          <div style={{ display: "flex", gap: 6, alignItems: "baseline", minWidth: 0 }}>
            <Text size="xs" tone="tertiary" style={{ minWidth: 0, flex: 1, overflowWrap: "anywhere" }}>When: {item.trigger}</Text>
            <button ref={edit} type="button" className="dbx-link" aria-label={`Edit when to ${item.label.toLowerCase()}`} onClick={() => (setText(item.trigger), setEditing(true))} style={{ border: 0, background: "transparent", padding: 0, cursor: "pointer", fontSize: "0.75rem", flex: "none" }}>Edit</button>
          </div>
        )}
      </div>
    </div>
  );
}

/** The team's own action: a label and when it applies. */
function AddAction(props: { onAdd(label: string, trigger: string): void; disabled: boolean }) {
  const [open, setOpen] = React.useState(false);
  const [label, setLabel] = React.useState("");
  const [trigger, setTrigger] = React.useState("");
  const opener = React.useRef<HTMLButtonElement>(null);
  const first = React.useRef<HTMLInputElement>(null);
  const was = React.useRef(false);
  React.useEffect(() => {
    if (open) first.current?.focus();
    else if (was.current) opener.current?.parentElement?.querySelector<HTMLButtonElement>("button[data-add-action]")?.focus();
    was.current = open;
  }, [open]);
  if (!open)
    return (
      <span ref={opener as never}>
        <button type="button" data-add-action className="dbx-link" disabled={props.disabled} title={props.disabled ? `A workstream has at most ${MAX_ACTIONS} actions` : undefined} onClick={() => setOpen(true)} style={{ border: 0, background: "transparent", padding: 0, cursor: "pointer", fontSize: "0.75rem" }}>+ Add action</button>
      </span>
    );
  const add = () => {
    if (!label.trim() || !trigger.trim()) return;
    props.onAdd(label.trim(), trigger.trim());
    setLabel("");
    setTrigger("");
    setOpen(false);
  };
  return (
    <form ref={opener as never} onSubmit={(event) => (event.preventDefault(), add())} onKeyDown={(event) => event.key === "Escape" && (event.preventDefault(), event.stopPropagation(), setOpen(false))} style={{ display: "flex", gap: 6, flexWrap: "wrap", alignItems: "center" }}>
      <input ref={first} className="dbx-input" aria-label="What agents do" placeholder="What agents do, e.g. Loop in the CSM" maxLength={MAX_ACTION_LABEL} value={label} onChange={(event) => setLabel(event.target.value)} style={{ flex: "1 1 160px", minWidth: 0, fontSize: "0.75rem" }} />
      <input className="dbx-input" aria-label="When" placeholder="When, e.g. the customer mentions renewal" maxLength={MAX_ACTION_TRIGGER} value={trigger} onChange={(event) => setTrigger(event.target.value)} style={{ flex: "2 1 220px", minWidth: 0, fontSize: "0.75rem" }} />
      <Button size="sm" type="submit" disabled={!label.trim() || !trigger.trim()}>Add action</Button>
      <Button size="sm" variant="ghost" onClick={() => setOpen(false)}>Cancel</Button>
    </form>
  );
}

/** Watch for and Otherwise, or a way to start them. */
function Actions(props: { name: string; value?: WorkstreamActionsRow; onChange(next: WorkstreamActionsRow | null): void }) {
  const { name, value } = props;
  const box = React.useRef<HTMLDivElement>(null);
  // Choose actions and Stop using actions swap what's shown: move focus to what replaced the button.
  const moved = React.useRef(false);
  const set = Boolean(value);
  React.useEffect(() => {
    if (!moved.current) return;
    moved.current = false;
    box.current?.querySelector<HTMLElement>(set ? "input[type=checkbox], button[data-add-action]" : "button")?.focus();
  }, [set]);
  if (!value)
    return (
      <div ref={box}>
        <Stack direction="row" gap={8} align="center" wrap>
          <Text size="xs" tone="subtle">Not set up: agents work every task.</Text>
          <Button size="sm" onClick={() => ((moved.current = true), props.onChange(startRow(name)))} title="Start with the usual actions for this kind of work">Choose actions</Button>
        </Stack>
      </div>
    );
  const choices = rowChoices(name, value);
  const group = `${name}-otherwise`.replace(/\W+/g, "-");
  return (
    <div ref={box}>
      <Stack gap={10}>
        <Stack gap={6}>
          <Text size="xs" weight={600}>Watch for</Text>
          <Text size="xs" tone="tertiary">Agents check each update against every ticked action and do each one that applies.</Text>
          {choices.map((choice) => (
            <ActionLine
              key={choice.action.id}
              workstream={name}
              item={choice.action}
              ticked={choice.ticked}
              custom={choice.custom}
              onTick={(on) => props.onChange(toggle(name, value, choice.action, on))}
              onTrigger={(text) => props.onChange(retrigger(name, value, choice.action, text))}
            />
          ))}
          {choices.length === 0 && <Text size="xs" tone="subtle">No usual actions for this kind of work. Add your own.</Text>}
          <AddAction disabled={value.watch.length >= MAX_ACTIONS} onAdd={(label, trigger) => props.onChange(toggle(name, value, { id: newActionId(label, value, name), label, trigger }, true))} />
        </Stack>
        <fieldset style={{ border: 0, margin: 0, padding: 0, minWidth: 0 }}>
          <legend style={{ padding: 0 }}><Text size="xs" weight={600}>Otherwise</Text></legend>
          <Stack gap={4} style={{ marginTop: 4 }}>
            {(["track", "dismiss"] as const).map((option) => (
              <label key={option} style={{ display: "inline-flex", gap: 6, alignItems: "baseline", cursor: "pointer" }}>
                <input type="radio" name={group} checked={value.otherwise === option} onChange={() => props.onChange({ ...value, otherwise: option })} />
                <span>
                  <Text size="sm">{option === "track" ? "Track" : "Dismiss"}</Text>
                  <Text size="xs" tone="tertiary"> {option === "track" ? "· keep it open, no agents" : "· record it and fold it away; it reopens if a trigger applies later"}</Text>
                </span>
              </label>
            ))}
          </Stack>
        </fieldset>
        <div>
          <button type="button" className="dbx-link" onClick={() => ((moved.current = true), props.onChange(null))} style={{ border: 0, background: "transparent", padding: 0, cursor: "pointer", fontSize: "0.75rem", color: "var(--dbx-tertiary)" }} title="Agents work every task again, as before">Stop using actions</button>
        </div>
      </Stack>
    </div>
  );
}

/** A workstream's row. */
export function WorkstreamRow(props: { name: string; value: RowValue; choices: readonly Member[]; profile(key: string): Profile | undefined; onChange(change: RowChange): void; defaultOpen?: boolean }) {
  const { name, value } = props;
  const [open, setOpen] = React.useState(Boolean(props.defaultOpen));
  const mode = value.mode ?? value.inherited;
  const agentNames = value.agents.map((key) => props.profile(key)?.name ?? props.choices.find((member) => member.key === key)?.name).filter(Boolean);
  const summary = [mode === "off" ? "No tasks" : rowSummary(value.actions), agentNames.length ? agentNames.join(", ") : undefined, value.playbook.trim() ? "playbook" : undefined].filter(Boolean).join(" · ");
  const panel = `ws-${name}`.replace(/\W+/g, "-");
  return (
    <div style={{ borderTop: "1px solid var(--dbx-border)", padding: "10px 0", minWidth: 0 }}>
      <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap", minWidth: 0 }}>
        <button
          type="button"
          aria-expanded={open}
          aria-controls={panel}
          onClick={() => setOpen(!open)}
          style={{ display: "flex", gap: 6, alignItems: "baseline", flex: "1 1 200px", minWidth: 0, border: 0, background: "transparent", padding: 0, cursor: "pointer", textAlign: "left", color: "inherit", fontFamily: "inherit" }}
        >
          <span aria-hidden style={{ color: "var(--dbx-tertiary)", fontSize: "0.75rem", width: 10, flex: "none" }}>{open ? "▾" : "▸"}</span>
          <span style={{ minWidth: 0 }}>
            <Text size="sm" weight={600} style={{ overflowWrap: "anywhere" }}>{name}</Text>
            <Text size="xs" tone="tertiary" as="div" style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}><span title={summary}>{summary}</span></Text>
          </span>
        </button>
        <select
          className="dbx-input"
          aria-label={`Mode for ${name}`}
          title={MODE_HINT[mode]}
          value={value.mode ?? ""}
          onChange={(event) => props.onChange({ mode: (event.target.value || null) as Mode | null })}
          style={{ width: "auto", maxWidth: "100%", fontSize: "0.75rem", flex: "none" }}
        >
          <option value="">{`Default (${value.inherited})`}</option>
          {MODES.map((option) => <option key={option} value={option}>{MODE_LABEL[option]}</option>)}
        </select>
      </div>
      {open && (
        <div id={panel} style={{ paddingLeft: 16, marginTop: 10 }}>
          <Stack gap={12}>
            {mode === "off" ? (
              <Text size="xs" tone="subtle">Mode is off: this kind of work opens no tasks, so there's nothing for agents to do.</Text>
            ) : (
              <>
                <Stack gap={4}>
                  <Text size="xs" weight={600}>Agents</Text>
                  <AgentsPicker name={name} empty="The account's agents" value={value.agents} choices={props.choices} profile={props.profile} onChange={(agents) => props.onChange({ agents })} />
                </Stack>
                <Actions name={name} {...(value.actions && { value: value.actions })} onChange={(actions) => props.onChange({ actions })} />
              </>
            )}
            <Stack gap={4}>
              <Text size="xs" weight={600}>Playbook</Text>
              <textarea className="dbx-textarea" aria-label={`Playbook for ${name}`} rows={4} maxLength={MAX_PLAYBOOK} placeholder={`How you like ${name} done: steps, what to include, tone, who to copy…`} value={value.playbook} onChange={(event) => props.onChange({ playbook: event.target.value })} />
            </Stack>
          </Stack>
        </div>
      )}
    </div>
  );
}
