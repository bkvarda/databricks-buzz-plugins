// Set up account's "Who works on what": one row per kind of work. Each row
// shows its mode and its agents, picked from a menu grouped by team; its
// details set what agents watch for (each action with its trigger; all of
// them apply), what happens when none applies, and the team's playbook.
import { React } from "@dbx/core/react";
import { Button, Stack, Text } from "@dbx/core/ui/components";
import { MAX_ACTION_LABEL, MAX_ACTION_TRIGGER, MAX_ACTIONS, MAX_PLAYBOOK, MODES, type Mode, type WorkstreamAction, type WorkstreamActionsRow } from "../app/model";
import { type AgentGroup, filterGroups, MAX_ROW_AGENTS, withTeam } from "./agent-choices";
import { AssigneeMark, type Profile } from "./board-panel";
import { newActionId, retrigger, rowChoices, rowSummary, startRow, toggle } from "./workstream-actions";

/** A mode as a row's menu names it. */
export const MODE_LABEL: Record<string, string> = { auto: "Auto", draft: "Draft", ask: "Ask", off: "Off" };
/** What each mode does, as one line. */
export const MODE_HINT: Record<string, string> = { auto: "Agents do it and report", draft: "Agents prepare it, a person sends it", ask: "Agents ask before doing anything", off: "No tasks" };

export type RowValue = Readonly<{
  /** Its own mode line, or undefined when it follows the account's `everything` (or the default). */
  mode?: Mode;
  inherited: Mode;
  agents: readonly string[];
  actions?: WorkstreamActionsRow;
  playbook: string;
}>;

export type RowChange = Partial<Readonly<{ mode: Mode | null; agents: readonly string[]; actions: WorkstreamActionsRow | null; playbook: string }>>;

/** What the agent menus need: the groups to offer, names and pictures, and who's in the channel. */
export type AgentSource = Readonly<{
  groups: readonly AgentGroup[];
  profile(key: string): Profile | undefined;
  name(key: string): string;
  inChannel(key: string): boolean;
  channel: string;
}>;

const LINK_BUTTON: React.CSSProperties = { border: 0, background: "transparent", padding: 0, cursor: "pointer", fontSize: "0.75rem" };

/** A compact mode menu: its own mode, or the default it follows. */
export function ModeMenu(props: { label: string; value?: Mode; inherited?: Mode; onChange(next: Mode | null): void }) {
  const shown = props.value ?? props.inherited;
  return (
    <select
      className="dbx-select"
      aria-label={props.label}
      title={shown ? MODE_HINT[shown] : undefined}
      value={props.value ?? ""}
      onChange={(event) => props.onChange((event.target.value || null) as Mode | null)}
      style={{ width: "auto", minHeight: 26, padding: "2px 26px 2px 9px", fontSize: "0.75rem", fontWeight: 500, backgroundPosition: "right 9px center", flex: "none" }}
    >
      {props.inherited && <option value="">{`${MODE_LABEL[props.inherited]} (default)`}</option>}
      {MODES.map((mode) => <option key={mode} value={mode}>{MODE_LABEL[mode]}</option>)}
    </select>
  );
}

/** A picked agent: its picture and name, a mark when it isn't in the channel yet, and a way to take it off. */
function AgentChip(props: { agentKey: string; source: AgentSource; owner: string; onRemove(): void }) {
  const name = props.source.name(props.agentKey);
  const missing = !props.source.inChannel(props.agentKey);
  return (
    <span
      className="dbx-chip"
      title={missing ? `${name} isn't in #${props.source.channel} yet. Saving adds it.` : name}
      style={{ maxWidth: 180, padding: "2px 2px 2px 3px", gap: 5, ...(missing && { borderStyle: "dashed", background: "transparent" }) }}
    >
      <AssigneeMark assignee={{ kind: "agent", key: props.agentKey, label: name }} profile={props.source.profile} size={16} />
      <span>{name}</span>
      {missing && <span aria-hidden style={{ color: "var(--dbx-warning)", fontSize: "0.6875rem" }}>+</span>}
      <button type="button" aria-label={`Take ${name} off ${props.owner}`} onClick={props.onRemove} style={{ fontSize: "0.875rem", padding: "0 4px" }}>×</button>
    </span>
  );
}

/** The agents a row gets from every workstream's, faded, with who they are on hover. */
export function InheritedMarks(props: { keys: readonly string[]; source: AgentSource; size?: number }) {
  const names = props.keys.map(props.source.name);
  return (
    <span title={`From every workstream: ${names.join(", ")}`} aria-label={`From every workstream: ${names.join(", ")}`} style={{ display: "inline-flex", alignItems: "center", opacity: 0.5, flex: "none" }}>
      {props.keys.slice(0, 4).map((key, at) => (
        <span key={key} aria-hidden style={{ marginLeft: at ? -4 : 0, borderRadius: 6, boxShadow: "0 0 0 2px var(--dbx-surface)", display: "inline-flex" }}>
          <AssigneeMark assignee={{ kind: "agent", key, label: props.source.name(key) }} profile={props.source.profile} size={props.size ?? 18} />
        </span>
      ))}
    </span>
  );
}

/**
 * Agents for a row: chips, and "@ Add agent", which opens a menu grouped by
 * team that you can search (an @ first is fine). Picking ticks or unticks an
 * agent and keeps the menu open; a team's Add all adds the rest of it.
 * Arrow keys move, Enter picks, Escape closes.
 */
export function AgentsPicker(props: { name: string; empty?: string; inherited?: readonly string[]; value: readonly string[]; source: AgentSource; onChange(next: readonly string[]): void }) {
  const [open, setOpen] = React.useState(false);
  const [query, setQuery] = React.useState("");
  const [active, setActive] = React.useState(0);
  const anchor = React.useRef<HTMLDivElement>(null);
  const trigger = React.useRef<HTMLButtonElement>(null);
  const list = React.useId();
  const groups = filterGroups(props.source.groups, query);
  const options = groups.flatMap((group) => group.options);
  const full = props.value.length >= MAX_ROW_AGENTS;
  const close = React.useCallback((refocus: boolean) => {
    setOpen(false);
    setQuery("");
    setActive(0);
    if (refocus) trigger.current?.focus();
  }, []);
  React.useEffect(() => {
    if (!open) return;
    const outside = (event: MouseEvent) => anchor.current && !anchor.current.contains(event.target as Node) && close(false);
    document.addEventListener("mousedown", outside);
    return () => document.removeEventListener("mousedown", outside);
  }, [open, close]);
  React.useEffect(() => {
    if (open) anchor.current?.querySelector<HTMLElement>(`#${CSS.escape(`${list}-${active}`)}`)?.scrollIntoView?.({ block: "nearest" });
  }, [open, active, list]);
  const pick = (key: string) => {
    if (props.value.includes(key)) props.onChange(props.value.filter((other) => other !== key));
    else if (!full) props.onChange([...props.value, key]);
  };
  const keys = (event: React.KeyboardEvent) => {
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      if (options.length) setActive((at) => (at + (event.key === "ArrowDown" ? 1 : options.length - 1)) % options.length);
    } else if (event.key === "Enter") {
      // Not on to the account form: ⌘↵ here picks too, rather than saving without the pick.
      event.preventDefault();
      event.stopPropagation();
      const option = options[Math.min(active, options.length - 1)];
      if (option) pick(option.key);
    } else if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      close(true);
    }
  };
  let index = -1;
  return (
    <div ref={anchor} className="dbx-picker-anchor" style={{ minWidth: 0 }}>
      <div style={{ display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap", minWidth: 0 }}>
        {props.value.map((key) => (
          <AgentChip key={key} agentKey={key} source={props.source} owner={props.name} onRemove={() => props.onChange(props.value.filter((other) => other !== key))} />
        ))}
        {props.value.length === 0 && props.inherited?.length ? <InheritedMarks keys={props.inherited} source={props.source} /> : null}
        {props.value.length === 0 && !props.inherited?.length && props.empty && <Text size="xs" tone="tertiary">{props.empty}</Text>}
        <button
          ref={trigger}
          type="button"
          className="dbx-btn"
          data-variant="ghost"
          data-size="sm"
          aria-haspopup="listbox"
          aria-expanded={open}
          aria-label={`Add an agent to ${props.name}`}
          onClick={() => (open ? close(false) : setOpen(true))}
          style={{ gap: 4, color: "var(--dbx-subtle)", minHeight: 22, padding: "0 6px" }}
        >
          <span aria-hidden style={{ fontWeight: 600 }}>@</span> Add agent
        </button>
      </div>
      {open && (
        <div className="dbx-picker" data-floating="" style={{ minWidth: 240 }} onKeyDown={keys}>
          <input
            className="dbx-input"
            autoFocus
            role="combobox"
            aria-expanded
            aria-controls={list}
            aria-activedescendant={options.length ? `${list}-${Math.min(active, options.length - 1)}` : undefined}
            aria-label={`Search agents for ${props.name}`}
            placeholder="@ Search agents or teams"
            value={query}
            onChange={(event) => (setQuery(event.target.value), setActive(0))}
          />
          <div id={list} className="dbx-picker-list" role="listbox" aria-multiselectable aria-label="Agents" style={{ maxHeight: 280 }}>
            {groups.length === 0 && (
              <Text size="sm" tone="subtle" as="div" style={{ padding: "8px 10px" }}>
                {query ? `No agent matches “${query.replace(/^@/, "")}”.` : "No agents yet. Add one to this channel, or make one on the Agents page."}
              </Text>
            )}
            {groups.map((group) => {
              const rest = group.options.filter((option) => !props.value.includes(option.key));
              return (
                <div key={group.id} role="group" aria-label={group.title}>
                  <div className="dbx-picker-group" style={{ display: "flex", gap: 8, alignItems: "center" }}>
                    <span style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={group.title}>{group.title}</span>
                    {group.team && rest.length > 1 && (
                      <button type="button" className="dbx-link" tabIndex={-1} disabled={full} onMouseDown={(event) => event.preventDefault()} onClick={() => props.onChange(withTeam(props.value, rest.map((option) => option.key)))} style={{ ...LINK_BUTTON, fontSize: "0.6875rem", textTransform: "none", letterSpacing: 0 }}>
                        Add all {rest.length}
                      </button>
                    )}
                  </div>
                  {group.options.map((option) => {
                    const at = ++index;
                    const selected = props.value.includes(option.key);
                    return (
                      <div
                        key={option.key}
                        id={`${list}-${at}`}
                        role="option"
                        aria-selected={selected}
                        aria-disabled={!selected && full}
                        className="dbx-picker-option"
                        data-active={at === Math.min(active, options.length - 1) || undefined}
                        onMouseDown={(event) => event.preventDefault()}
                        onMouseMove={() => at !== active && setActive(at)}
                        onClick={() => pick(option.key)}
                        style={{ alignItems: "center", ...(at === Math.min(active, options.length - 1) && { background: "var(--dbx-inset)" }), ...(!selected && full && { opacity: 0.55, cursor: "default" }) }}
                      >
                        <span className="dbx-picker-check" aria-hidden>{selected ? "✓" : ""}</span>
                        <AssigneeMark assignee={{ kind: "agent", key: option.key, label: option.name }} profile={props.source.profile} size={20} />
                        <span className="dbx-picker-text" style={{ flexDirection: "row", alignItems: "baseline", gap: 6 }}>
                          <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", fontWeight: 500 }} title={option.name}>{option.name}</span>
                        </span>
                        {!option.inChannel && <span className="dbx-picker-meta" style={{ fontFamily: "inherit" }} title={`Saving adds it to #${props.source.channel}`}>Not in channel</span>}
                      </div>
                    );
                  })}
                </div>
              );
            })}
          </div>
          {full && <Text size="xs" tone="subtle" as="div" style={{ padding: "6px 10px", borderTop: "1px solid var(--dbx-border)" }}>{`At most ${MAX_ROW_AGENTS} agents here. Take one off to add another.`}</Text>}
        </div>
      )}
    </div>
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
          // Not a <form>: this sits inside the account form, and a nested form's submit would save (or reload) that one.
          <div role="group" aria-label={`When to ${item.label.toLowerCase()}`} style={{ display: "flex", gap: 6, flexWrap: "wrap", marginTop: 2 }}>
            <input
              ref={input}
              className="dbx-input"
              aria-label={`When to ${item.label.toLowerCase()}`}
              maxLength={MAX_ACTION_TRIGGER}
              value={text}
              onChange={(event) => setText(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Escape") (event.preventDefault(), event.stopPropagation(), close(false));
                // Enter (with or without ⌘) saves the trigger, not the whole account.
                else if (event.key === "Enter") (event.preventDefault(), event.stopPropagation(), text.trim() && close(true));
              }}
              style={{ flex: "1 1 220px", minWidth: 0, fontSize: "0.75rem" }}
            />
            <Button size="sm" disabled={!text.trim()} onClick={() => close(true)}>Save trigger</Button>
            <Button size="sm" variant="ghost" onClick={() => close(false)}>Cancel</Button>
          </div>
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
    // Not a <form>: it sits inside the account form (see ActionLine). Enter, with or without ⌘, adds the action.
    <div
      ref={opener as never}
      role="group"
      aria-label="Add your own action"
      onKeyDown={(event) => {
        if (event.key === "Escape") (event.preventDefault(), event.stopPropagation(), setOpen(false));
        else if (event.key === "Enter" && event.target instanceof HTMLInputElement) (event.preventDefault(), event.stopPropagation(), add());
      }}
      style={{ display: "flex", gap: 6, flexWrap: "wrap", alignItems: "center" }}
    >
      <input ref={first} className="dbx-input" aria-label="What agents do" placeholder="What agents do, e.g. Loop in the CSM" maxLength={MAX_ACTION_LABEL} value={label} onChange={(event) => setLabel(event.target.value.replace(/—/g, "-")) /* the hub's posts set an action's reason after " — " */} style={{ flex: "1 1 160px", minWidth: 0, fontSize: "0.75rem" }} />
      <input className="dbx-input" aria-label="When" placeholder="When, e.g. the customer mentions renewal" maxLength={MAX_ACTION_TRIGGER} value={trigger} onChange={(event) => setTrigger(event.target.value)} style={{ flex: "2 1 220px", minWidth: 0, fontSize: "0.75rem" }} />
      <Button size="sm" disabled={!label.trim() || !trigger.trim()} onClick={add}>Add action</Button>
      <Button size="sm" variant="ghost" onClick={() => setOpen(false)}>Cancel</Button>
    </div>
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
          <Text size="xs" tone="subtle" style={{ flex: "1 1 160px" }}>Agents work every task. Pick what they watch for to have them act only when it matters.</Text>
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
          <Text size="xs" tone="tertiary">Agents check each update against every ticked action.</Text>
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

/** A row's frame: the name and its mode menu on top, then whatever it holds. */
function RowFrame(props: { title: React.ReactNode; subtitle?: React.ReactNode; mode: React.ReactNode; children: React.ReactNode }) {
  return (
    <div style={{ borderTop: "1px solid var(--dbx-border)", padding: "12px 0", minWidth: 0, display: "flex", flexDirection: "column", gap: 8 }}>
      <div style={{ display: "flex", gap: 8, alignItems: "center", minWidth: 0 }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <Text size="md" weight={600} as="div" style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{props.title}</Text>
          {props.subtitle && <Text size="xs" tone="tertiary" as="div">{props.subtitle}</Text>}
        </div>
        {props.mode}
      </div>
      {props.children}
    </div>
  );
}

/** The account's row: the mode and agents every workstream has unless it sets its own. */
export function EveryRow(props: { mode?: Mode; agents: readonly string[]; source: AgentSource; onMode(next: Mode | null): void; onAgents(next: readonly string[]): void; defaultMode: Mode }) {
  return (
    <RowFrame
      title="Every workstream"
      subtitle="Unless a workstream below sets its own"
      mode={<ModeMenu label="Mode for every workstream" value={props.mode} inherited={props.defaultMode} onChange={props.onMode} />}
    >
      <AgentsPicker name="every workstream" empty="No agents: tasks wait for a person" value={props.agents} source={props.source} onChange={props.onAgents} />
    </RowFrame>
  );
}

/** A workstream's row: its name, what it's set to and its mode; its agents; and Details, for what they watch for and its playbook. */
export function WorkstreamRow(props: { name: string; value: RowValue; inheritedAgents: readonly string[]; source: AgentSource; onChange(change: RowChange): void; defaultOpen?: boolean }) {
  const { name, value } = props;
  const [open, setOpen] = React.useState(Boolean(props.defaultOpen));
  const mode = value.mode ?? value.inherited;
  const summary = mode === "off" ? "No tasks" : [value.actions ? rowSummary(value.actions) : undefined, value.playbook.trim() ? "playbook" : undefined].filter(Boolean).join(" · ");
  const panel = `ws-${name}`.replace(/\W+/g, "-");
  return (
    <RowFrame
      title={<span title={name}>{name}</span>}
      {...(summary && { subtitle: <span title={summary}>{summary}</span> })}
      mode={<ModeMenu label={`Mode for ${name}`} value={value.mode} inherited={value.inherited} onChange={(next) => props.onChange({ mode: next })} />}
    >
      <div style={{ display: "flex", gap: 8, alignItems: "flex-start", minWidth: 0 }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          {mode !== "off" && <AgentsPicker name={name} inherited={props.inheritedAgents} value={value.agents} source={props.source} onChange={(agents) => props.onChange({ agents })} />}
        </div>
        <button
          type="button"
          className="dbx-btn"
          data-variant="ghost"
          data-size="sm"
          aria-expanded={open}
          aria-controls={panel}
          aria-label={`Details for ${name}`}
          onClick={() => setOpen(!open)}
          style={{ gap: 4, color: "var(--dbx-subtle)", minHeight: 22, padding: "0 6px", flex: "none" }}
        >
          Details <span aria-hidden style={{ fontSize: "0.625rem" }}>{open ? "▴" : "▾"}</span>
        </button>
      </div>
      {open && (
        <div id={panel} style={{ background: "var(--dbx-inset)", borderRadius: "var(--dbx-radius)", padding: 12, minWidth: 0 }}>
          <Stack gap={14}>
            {mode === "off" ? (
              <Text size="xs" tone="subtle">Mode is off: this kind of work opens no tasks, so there's nothing to watch for.</Text>
            ) : (
              <Actions name={name} {...(value.actions && { value: value.actions })} onChange={(actions) => props.onChange({ actions })} />
            )}
            <Stack gap={4}>
              <Text size="xs" weight={600}>Playbook</Text>
              <textarea className="dbx-textarea" aria-label={`Playbook for ${name}`} rows={3} maxLength={MAX_PLAYBOOK} placeholder={`How you like ${name} done: steps, what to include, tone, who to copy…`} value={value.playbook} onChange={(event) => props.onChange({ playbook: event.target.value })} />
            </Stack>
          </Stack>
        </div>
      )}
    </RowFrame>
  );
}
