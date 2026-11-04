// The Genie page: a sidebar of the person's Genie agents and a chat with the
// selected one. The sidebar replaces the conversation sidebar while the page
// is selected, as Buzz pages may.
import type { PageSidebarProps } from "@buzz/author";
import type { PageProps } from "@dbx/core/host-types";
import { Genie, type GenieSpace } from "@dbx/core/api/genie";
import { React } from "@dbx/core/react";
import { type DatabricksService, describeError, useAsync, useConnection, usePreference } from "@dbx/core/service";
import { Button, DatabricksMark, DbxRoot, EmptyState, Notice, Spinner, Stack, Text } from "@dbx/core/ui/components";
import { GenieChat } from "./chat";
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

/** Whether Genie One answers here; rechecked when the workspace changes. */
function useGenieOneAvailable(service: DatabricksService, genieOne: GenieOne) {
  const snapshot = useConnection(service);
  const host = snapshot.status === "connected" ? snapshot.profile.host : undefined;
  return useAsync(async () => (host ? genieOne.available() : false), [host]).data === true;
}

/** The selected entry, defaulting to Genie One when nothing is chosen. */
function useSelection(service: DatabricksService, oneAvailable: boolean) {
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

export function genieSidebar(service: DatabricksService, store: SpacesStore, genieOne: GenieOne) {
  return function GenieSidebar(props: PageSidebarProps) {
    const spaces = useSpaces(store);
    const oneAvailable = useGenieOneAvailable(service, genieOne);
    const [selected, setSelected] = useSelection(service, oneAvailable);
    const [query, setQuery] = React.useState("");
    const filtered = spaces.spaces.filter(
      (space) => !query.trim() || `${space.title} ${space.description ?? ""}`.toLowerCase().includes(query.trim().toLowerCase()),
    );
    return (
      <div className="shell-sidebar-default">
        <DbxRoot style={{ display: "flex", flexDirection: "column", height: "100%", minHeight: 0 }}>
          <Stack gap={8} style={{ padding: "12px 10px 8px" }}>
            <Stack direction="row" align="center" justify="space-between">
              <Text weight={500}>Genie agents</Text>
              <Button size="sm" variant="ghost" onClick={() => void store.load(true)} aria-label="Refresh Genie agents" title="Refresh">
                ↻
              </Button>
            </Stack>
            <input className="dbx-input" placeholder="Find an agent" value={query} onChange={(event) => setQuery(event.target.value)} aria-label="Find a Genie agent" />
          </Stack>
          <nav aria-label="Genie agents" style={{ flex: 1, overflow: "auto", padding: "0 6px 8px" }}>
            {oneAvailable && (
              <button
                type="button"
                className="dbx-row"
                aria-selected={selected === GENIE_ONE_ENTRY}
                onClick={() => setSelected(GENIE_ONE_ENTRY)}
                style={{ ...rowStyle, marginBottom: 6 }}
              >
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
            {spaces.status === "loading" && (
              <Stack direction="row" gap={8} align="center" style={{ padding: 10 }}>
                <Spinner size={12} />
                <Text tone="subtle" size="sm">
                  Loading…
                </Text>
              </Stack>
            )}
            {spaces.status === "error" && (
              <Text tone="danger" size="sm" as="div" style={{ padding: 10 }}>
                {spaces.error}
              </Text>
            )}
            {spaces.status === "ready" && !filtered.length && (
              <Text tone="subtle" size="sm" as="div" style={{ padding: 10 }}>
                {spaces.spaces.length ? "No agents match." : "No Genie agents are shared with you yet."}
              </Text>
            )}
            {filtered.map((space) => (
              <button
                key={space.space_id}
                type="button"
                className="dbx-row"
                aria-selected={space.space_id === selected}
                onClick={() => setSelected(space.space_id)}
                title={space.description}
                style={rowStyle}
              >
                <Text size="md" as="div" style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                  {space.title}
                </Text>
              </button>
            ))}
          </nav>
          {props.children && <div style={{ borderTop: "1px solid var(--dbx-border)", padding: 6 }}>{props.children}</div>}
        </DbxRoot>
      </div>
    );
  };
}

export function geniePage(service: DatabricksService, store: SpacesStore, genieOne: GenieOne) {
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
    else if (selected === GENIE_ONE_ENTRY && oneAvailable) body = <GenieOneChat service={service} genieOne={genieOne} />;
    else if (spaces.status === "error") body = <Notice tone="danger" title="Couldn't list Genie agents">{spaces.error}</Notice>;
    else if (!space)
      body = (
        <EmptyState title={spaces.status === "loading" ? "Loading Genie agents…" : "Choose a Genie agent"}>
          {spaces.status === "ready" && spaces.spaces.length === 0
            ? "Nobody has shared a Genie agent with you in this workspace yet. Create one in Databricks, then refresh."
            : "Pick an agent on the left to start asking questions. Genie agents are curated by your data teams for a topic, like sales or support."}
        </EmptyState>
      );
    else body = <GenieChat key={space.space_id} service={service} space={space} />;
    return (
      <DbxRoot style={{ height: "100%", overflow: "auto" }}>
        <div style={{ maxWidth: 920, margin: "0 auto", padding: "24px 28px 16px", minHeight: "100%", display: "flex", flexDirection: "column" }}>{body}</div>
      </DbxRoot>
    );
  };
}
