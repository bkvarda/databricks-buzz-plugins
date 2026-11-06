// The Genie page: a sidebar with Genie One and, folded under a button, a
// searchable list of the person's Genie agents, beside a chat with the
// selected one. The sidebar replaces the conversation sidebar while the page
// is selected, as Buzz pages may.
import type { PageSidebarProps } from "@buzz/author";
import type { PageProps } from "@dbx/core/host-types";
import { Genie, type GenieSpace } from "@dbx/core/api/genie";
import { React } from "@dbx/core/react";
import { type DatabricksService, describeError, useAsync, useConnection, usePreference } from "@dbx/core/service";
import { Button, DatabricksMark, DbxRoot, EmptyState, Notice, Spinner, Stack, Text } from "@dbx/core/ui/components";
import { GenieChat } from "./chat";
import type { GenieChats } from "./chats";
import type { GenieOne } from "./genie-one";
import { GenieOneChat } from "./genie-one-chat";

type SpacesState = { status: "idle" | "loading" | "ready" | "error"; spaces: readonly GenieSpace[]; error?: string };

/** Spaces are shared by the page, sidebar, composer and tools. */
export class SpacesStore {
  private state: SpacesState = { status: "idle", spaces: [] };
  private listeners = new Set<() => void>();
  private host: string | undefined;
  private loading: Promise<readonly GenieSpace[]> | undefined;

  constructor(private readonly service: DatabricksService) {
    service.subscribe(() => {
      const snapshot = service.snapshot();
      const host = snapshot.status === "connected" ? snapshot.profile.host : undefined;
      if (host !== this.host) {
        this.host = host;
        this.set({ status: "idle", spaces: [] });
        if (host && this.listeners.size) void this.load();
      }
    });
  }

  snapshot = () => this.state;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    if (this.state.status === "idle") void this.load();
    return () => this.listeners.delete(listener);
  };

  async load(force = false): Promise<readonly GenieSpace[]> {
    if (!force && this.state.status === "ready") return this.state.spaces;
    if (this.loading && !force) return this.loading;
    this.set({ ...this.state, status: "loading" });
    this.loading = (async () => {
      try {
        const client = await this.service.ready();
        const spaces = await new Genie(client).listSpaces();
        this.set({ status: "ready", spaces });
        return spaces;
      } catch (error) {
        this.set({ status: "error", spaces: [], error: describeError(error) });
        return [];
      } finally {
        this.loading = undefined;
      }
    })();
    return this.loading;
  }

  /** Finds a space by ID or (case-insensitive) title. */
  async find(nameOrId: string): Promise<GenieSpace | undefined> {
    const needle = nameOrId.trim().toLowerCase();
    const spaces = await this.load();
    return (
      spaces.find((space) => space.space_id.toLowerCase() === needle) ??
      spaces.find((space) => space.title.toLowerCase() === needle) ??
      spaces.find((space) => space.title.toLowerCase().includes(needle))
    );
  }

  private set(state: SpacesState) {
    this.state = state;
    for (const listener of [...this.listeners]) listener();
  }
}

export function useSpaces(store: SpacesStore) {
  return React.useSyncExternalStore(store.subscribe, store.snapshot);
}

const SELECTED = "genieSpaceId";
/** The sidebar entry for Genie One (not a space ID). */
export const GENIE_ONE_ENTRY = "genie-one";

/** Whether Genie One answers here, or undefined while checking; rechecked when the workspace changes. */
export function useGenieOneStatus(service: DatabricksService, genieOne: GenieOne): boolean | undefined {
  const snapshot = useConnection(service);
  const host = snapshot.status === "connected" ? snapshot.profile.host : undefined;
  const check = useAsync(async () => (host ? genieOne.available() : false), [host]);
  return check.loading ? undefined : check.data === true;
}

export function useGenieOneAvailable(service: DatabricksService, genieOne: GenieOne) {
  return useGenieOneStatus(service, genieOne) === true;
}

/** The selected entry, defaulting to Genie One when nothing is chosen. */
export function useSelection(service: DatabricksService, oneAvailable: boolean) {
  const [selected, setSelected] = usePreference<string>(service, SELECTED);
  return [selected ?? (oneAvailable ? GENIE_ONE_ENTRY : undefined), setSelected] as const;
}

const rowStyle = {
  display: "block",
  width: "100%",
  textAlign: "left",
  border: 0,
  background: "transparent",
  borderRadius: "var(--radius-row, 6px)",
  padding: "6px 8px",
  cursor: "pointer",
  font: "inherit",
  color: "var(--dbx-ink)",
} as const;

const oneLine = { overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" } as const;

function Chevron(props: { open: boolean }) {
  return (
    <svg width="13" height="13" viewBox="0 0 10 10" aria-hidden style={{ flex: "none", transform: props.open ? undefined : "rotate(-90deg)", transition: "transform 120ms" }}>
      <path d="M2 3.5l3 3 3-3" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

const plural = (count: number) => `${count} ${count === 1 ? "agent" : "agents"}`;

export function genieSidebar(service: DatabricksService, store: SpacesStore, genieOne: GenieOne) {
  return function GenieSidebar(props: PageSidebarProps) {
    const spaces = useSpaces(store);
    const oneStatus = useGenieOneStatus(service, genieOne);
    const oneAvailable = oneStatus === true;
    const [selected, setSelected] = useSelection(service, oneAvailable);
    // The agents list stays folded under its button unless Genie One isn't
    // here to show instead.
    const [open, setOpen] = React.useState<boolean>();
    const expanded = open ?? oneStatus === false;
    const [query, setQuery] = React.useState("");
    const trigger = React.useRef<HTMLButtonElement>(null);
    const input = React.useRef<HTMLInputElement>(null);
    const list = React.useRef<HTMLDivElement>(null);
    const current = spaces.spaces.find((space) => space.space_id === selected);
    const needle = query.trim().toLowerCase();
    const filtered = spaces.spaces.filter((space) => !needle || `${space.title} ${space.description ?? ""}`.toLowerCase().includes(needle));
    const close = () => {
      setOpen(false);
      setQuery("");
    };
    const pick = (id: string) => {
      setSelected(id);
      close();
    };
    const summary = current
      ? current.title
      : spaces.status === "error"
        ? "Couldn't list them"
        : spaces.status === "ready"
          ? spaces.spaces.length
            ? plural(spaces.spaces.length)
            : "None shared with you yet"
          : "Loading…";
    const onKeyDown = (event: React.KeyboardEvent) => {
      if (event.key === "Escape") {
        event.stopPropagation();
        close();
        trigger.current?.focus();
        return;
      }
      if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
      event.preventDefault();
      const options = [...(list.current?.querySelectorAll<HTMLButtonElement>("[role=option]") ?? [])];
      const next = options.indexOf(document.activeElement as HTMLButtonElement) + (event.key === "ArrowDown" ? 1 : -1);
      if (next < 0) input.current?.focus();
      else options[Math.min(next, options.length - 1)]?.focus();
    };
    return (
      <div className="shell-sidebar-default">
        <DbxRoot style={{ display: "flex", flexDirection: "column", height: "100%", minHeight: 0 }}>
          <Stack direction="row" align="center" justify="space-between" style={{ padding: "10px 10px 6px 12px" }}>
            <Text weight={500}>Genie</Text>
            <Button size="sm" variant="ghost" onClick={() => void store.load(true)} aria-label="Refresh Genie agents" title="Refresh Genie agents">
              ↻
            </Button>
          </Stack>
          <nav aria-label="Genie" style={{ flex: 1, minHeight: 0, display: "flex", flexDirection: "column", gap: 2, padding: "0 6px 8px" }}>
            {oneAvailable && (
              <button type="button" className="dbx-row" aria-selected={selected === GENIE_ONE_ENTRY} onClick={() => pick(GENIE_ONE_ENTRY)} style={rowStyle}>
                <Stack direction="row" gap={8} align="center">
                  <DatabricksMark size={13} />
                  <Stack gap={0} style={{ minWidth: 0 }}>
                    <Text size="md">Genie One</Text>
                    <Text size="xs" tone="subtle">
                      Ask across all your data
                    </Text>
                  </Stack>
                </Stack>
              </button>
            )}
            <button
              ref={trigger}
              type="button"
              className="dbx-row"
              aria-expanded={expanded}
              aria-controls="dbx-genie-agents"
              aria-selected={Boolean(current)}
              onClick={() => (expanded ? close() : setOpen(true))}
              title={current?.description}
              style={{ ...rowStyle, flex: "none" }}
            >
              <Stack direction="row" gap={8} align="center">
                <Chevron open={expanded} />
                <Stack gap={0} style={{ minWidth: 0, flex: 1 }}>
                  <Text size="md">Genie agents</Text>
                  <Text size="xs" tone="subtle" as="div" style={oneLine}>
                    {summary}
                  </Text>
                </Stack>
                {spaces.status === "loading" && <Spinner size={11} />}
              </Stack>
            </button>
            {expanded && (
              <div
                id="dbx-genie-agents"
                className="dbx-picker"
                onKeyDown={onKeyDown}
                style={{ display: "flex", flexDirection: "column", flex: "0 1 auto", minHeight: 0, margin: "2px 2px 0" }}
              >
                <input
                  ref={input}
                  className="dbx-input"
                  autoFocus={open === true}
                  placeholder="Find an agent"
                  aria-label="Find a Genie agent"
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key !== "Enter" || !filtered[0]) return;
                    event.preventDefault();
                    pick(filtered[0].space_id);
                  }}
                />
                <div ref={list} className="dbx-picker-list" role="listbox" aria-label="Genie agents" style={{ minHeight: 0 }}>
                  {spaces.status === "loading" && !spaces.spaces.length && (
                    <Stack direction="row" gap={8} align="center" style={{ padding: "8px 10px" }}>
                      <Spinner size={12} />
                      <Text tone="subtle" size="sm">
                        Loading…
                      </Text>
                    </Stack>
                  )}
                  {spaces.status === "error" && (
                    <Text tone="danger" size="sm" as="div" style={{ padding: "8px 10px" }}>
                      {spaces.error}
                    </Text>
                  )}
                  {spaces.status === "ready" && !filtered.length && (
                    <Text tone="subtle" size="sm" as="div" style={{ padding: "8px 10px" }}>
                      {spaces.spaces.length ? `Nothing matches “${query.trim()}”.` : "No Genie agents are shared with you yet."}
                    </Text>
                  )}
                  {filtered.map((space) => (
                    <button
                      key={space.space_id}
                      type="button"
                      role="option"
                      className="dbx-picker-option"
                      aria-selected={space.space_id === selected}
                      onClick={() => pick(space.space_id)}
                      title={space.description}
                    >
                      <span className="dbx-picker-check" aria-hidden>
                        {space.space_id === selected ? "✓" : ""}
                      </span>
                      <span className="dbx-picker-text" style={{ ...oneLine, display: "block" }}>
                        {space.title}
                      </span>
                    </button>
                  ))}
                </div>
              </div>
            )}
          </nav>
          {props.children && <div style={{ borderTop: "1px solid var(--dbx-border)", padding: 6 }}>{props.children}</div>}
        </DbxRoot>
      </div>
    );
  };
}

export function geniePage(service: DatabricksService, store: SpacesStore, genieOne: GenieOne, chats: GenieChats) {
  return function GeniePage(_props: PageProps) {
    const snapshot = useConnection(service);
    const spaces = useSpaces(store);
    const oneAvailable = useGenieOneAvailable(service, genieOne);
    const [selected] = useSelection(service, oneAvailable);
    const space = spaces.spaces.find((candidate) => candidate.space_id === selected);
    let body: React.ReactNode;
    if (snapshot.status !== "connected")
      body = (
        <EmptyState
          title="Connect Databricks to use Genie"
          action={
            <Button variant="brand" onClick={() => service.openSettings()}>
              Connect Databricks
            </Button>
          }
        >
          Genie answers questions about your data in plain language, with the access you already have.
        </EmptyState>
      );
    else if (selected === GENIE_ONE_ENTRY && oneAvailable) body = <GenieOneChat chat={chats.genieOneChat()} />;
    else if (spaces.status === "error") body = <Notice tone="danger" title="Couldn't list Genie agents">{spaces.error}</Notice>;
    else if (!space)
      body = (
        <EmptyState title={spaces.status === "loading" ? "Loading Genie agents…" : "Choose a Genie agent"}>
          {spaces.status === "ready" && spaces.spaces.length === 0
            ? "Nobody has shared a Genie agent with you in this workspace yet. Create one in Databricks, then refresh."
            : "Open Genie agents on the left and pick one to start asking questions. Genie agents are curated by your data teams for a topic, like sales or support."}
        </EmptyState>
      );
    else body = <GenieChat key={space.space_id} service={service} space={space} chat={chats.space(space.space_id)} />;
    return (
      <DbxRoot style={{ height: "100%", overflow: "auto" }}>
        <div style={{ maxWidth: 920, margin: "0 auto", padding: "24px 28px 16px", minHeight: "100%", display: "flex", flexDirection: "column" }}>{body}</div>
      </DbxRoot>
    );
  };
}
