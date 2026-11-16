// Search for Buzz, backed by Lakebase: a page that searches a Buzz search
// index (a Databricks App made with the Databricks Agents plugin's Search
// index template, which reads the community's public channels into Lakebase),
// and the same search as an agent tool. Each search runs as the person
// searching: Databricks Apps signs them in, and they need Can Use on the app.
import type { Context } from "@buzz/author";
import { type BuzzSearchHit, type DatabricksApp, searchApps, searchBuzz } from "@dbx/core/api/apps";
import { type AgentTool, numberArg, optionalService, schema, stringArg } from "@dbx/core/host-types";
import { React } from "@dbx/core/react";
import { type DatabricksService, describeError, useAsync, useConnection, usePreference } from "@dbx/core/service";
import { ago, Button, DbxRoot, EmptyState, Notice, Spinner, Stack, Text } from "@dbx/core/ui/components";
import { useWorkspaceService, WorkspaceField } from "@dbx/core/ui/workspace";

/** The index app picked, and the workspace (a CLI profile; unset is Buzz's own) it's in. The Databricks App type sets both when it makes an index. */
export const SEARCH_APP_PREFERENCE = "buzzSearchApp";
export const SEARCH_PROFILE_PREFERENCE = "buzzSearchProfile";
const CHOSEN = SEARCH_APP_PREFERENCE;

const workspaceFor = (service: DatabricksService) => {
  const profile = service.preferences.get<string>(SEARCH_PROFILE_PREFERENCE);
  return profile && service.forProfile ? service.forProfile(profile) : service;
};

type RelayView = { snapshot(): { viewer?: string; origin?: string } };

/** The index to search in `workspace`: the one picked before, else the only (or a running) one. */
async function chosenIndex(service: DatabricksService, workspace: DatabricksService, signal?: AbortSignal): Promise<{ apps: DatabricksApp[]; app?: DatabricksApp }> {
  const apps = await searchApps(await workspace.ready(signal), signal);
  const picked = service.preferences.get<string>(CHOSEN);
  const app = apps.find((found) => found.name === picked) ?? (apps.length === 1 ? apps[0] : apps.find((found) => found.app_status?.state === "RUNNING"));
  return { apps, ...(app && { app }) };
}

/** `**word**` marks in a snippet as bold text. */
function Snippet(props: { text: string }) {
  const parts = props.text.split("**");
  return (
    <Text size="sm">
      {parts.map((part, n) => (n % 2 ? <b key={n}>{part}</b> : <React.Fragment key={n}>{part}</React.Fragment>))}
    </Text>
  );
}

export function searchPage(ctx: Context, service: DatabricksService) {
  const open = (hit: BuzzSearchHit) => {
    const relay = optionalService<RelayView>(ctx, "relay")?.snapshot();
    const navigation = (ctx as unknown as { navigation?: { open(target: unknown): Promise<unknown> } }).navigation;
    if (!relay?.viewer || !relay.origin || !navigation) return false;
    void navigation.open({
      version: 1,
      kind: "conversation",
      scope: { viewer: relay.viewer, communityOrigin: relay.origin },
      channelId: hit.channel,
      messageId: hit.id,
      ...(hit.root && { threadRootId: hit.root, context: "channel" }),
    });
    return true;
  };
  return function SearchPage() {
    const [profile, setProfile] = usePreference<string>(service, SEARCH_PROFILE_PREFERENCE);
    const workspace = useWorkspaceService(service, profile);
    const snapshot = useConnection(workspace);
    const [picked, setPicked] = usePreference<string>(service, CHOSEN);
    const indexes = useAsync((signal) => chosenIndex(service, workspace, signal), [workspace, snapshot.status, picked]);
    const host = snapshot.status === "connected" ? new URL(snapshot.profile.host).hostname : "this workspace";
    const [query, setQuery] = React.useState("");
    const [state, setState] = React.useState<{ loading?: boolean; hits?: BuzzSearchHit[]; error?: string; asked?: string }>({});
    const app = indexes.data?.app;
    const run = async (text: string) => {
      if (!app || !text.trim()) return;
      setState({ loading: true, asked: text });
      try {
        setState({ hits: await searchBuzz(await workspace.ready(), app, text.trim(), 30), asked: text });
      } catch (error) {
        setState({ error: describeError(error), asked: text });
      }
    };
    let body: React.ReactNode;
    if (snapshot.status !== "connected")
      body = profile ? (
        <Text tone="subtle">Waiting for your sign-in to that workspace…</Text>
      ) : (
        <EmptyState title="Connect Databricks" action={<Button variant="brand" onClick={() => service.openSettings()}>Connect</Button>}>
          Search reads a search index in your Databricks workspace.
        </EmptyState>
      );
    else if (indexes.loading && !indexes.data) body = <Stack direction="row" gap={8} align="center"><Spinner /><Text tone="subtle">Finding search indexes…</Text></Stack>;
    else if (indexes.error) body = <Notice tone="danger" title="Couldn't find search indexes">{describeError(indexes.error)}</Notice>;
    else if (!indexes.data?.apps.length)
      body = (
        <EmptyState title={`No search index in ${host}`}>
          If the index is in another workspace, pick it above. An admin makes one in Agents → New agent → Databricks App, with the Search index template; it reads this community's public channels into Lakebase. If there is one, ask its owner to let you use it.
        </EmptyState>
      );
    else
      body = (
        <Stack gap={14}>
          <form
            onSubmit={(event) => {
              event.preventDefault();
              void run(query);
            }}
          >
            <Stack direction="row" gap={8}>
              <input className="dbx-input" style={{ flex: 1 }} autoFocus placeholder="Search public channels" value={query} onChange={(event) => setQuery(event.target.value)} />
              <Button variant="primary" type="submit" disabled={!app || !query.trim() || state.loading}>
                {state.loading ? <Spinner size={11} /> : null}Search
              </Button>
            </Stack>
          </form>
          {indexes.data.apps.length > 1 && (
            <Stack direction="row" gap={8} align="center">
              <Text size="sm" tone="subtle">Index</Text>
              <select className="dbx-select" value={app?.name ?? ""} onChange={(event) => setPicked(event.target.value)}>
                {indexes.data.apps.map((found) => (
                  <option key={found.name} value={found.name}>
                    {found.description?.replace(/^Buzz search index:\s*/, "") || found.name}
                  </option>
                ))}
              </select>
            </Stack>
          )}
          {state.error && <Notice tone="danger">{state.error}</Notice>}
          {state.hits && !state.hits.length && <Text tone="subtle">Nothing in public channels matches “{state.asked}”.</Text>}
          {state.hits?.map((hit) => (
            <button
              key={hit.id}
              type="button"
              className="dbx-card"
              style={{ textAlign: "left", padding: 12, border: "1px solid var(--border-standard, #e5e5e5)", borderRadius: 10, background: "transparent", cursor: "pointer" }}
              onClick={() => {
                if (!open(hit)) setState((current) => ({ ...current, error: "This Buzz can't open messages from plugins; find it in #" + hit.channelName + "." }));
              }}
            >
              <Stack gap={4}>
                <Text size="xs" tone="subtle">
                  #{hit.channelName} · {hit.authorName ?? `${hit.author.slice(0, 8)}…`} · {ago(hit.createdAt * 1000)}
                  {hit.root ? " · in a thread" : ""}
                </Text>
                <Snippet text={hit.snippet} />
              </Stack>
            </button>
          ))}
          <Text size="xs" tone="tertiary">
            Searches public channels only, through {app?.name ?? "the index"}, as you.
          </Text>
        </Stack>
      );
    return (
      <DbxRoot style={{ padding: "var(--space-page-inset, 24px)", maxWidth: 820 }}>
        <Stack gap={16}>
          <Stack gap={4}>
            <Text as="h2" size="xl" weight={500}>Search</Text>
            <Text tone="subtle">Every public channel in this community, searched with Lakebase.</Text>
          </Stack>
          {service.forProfile && (
            <div style={{ maxWidth: 420 }}>
              <WorkspaceField
                service={service}
                {...(profile && { profile })}
                onChange={(next) => {
                  setPicked(undefined);
                  setProfile(next);
                }}
              />
            </div>
          )}
          {body}
        </Stack>
      </DbxRoot>
    );
  };
}

/** The same search for agents. */
export function searchTool(service: DatabricksService): AgentTool {
  return {
    name: "databricks_buzz_search",
    description:
      "Searches this Buzz community's public channels (messages, with channel, author and time) through the Buzz search index in Databricks. Use it to find earlier discussions or decisions. Matches are marked **like this**.",
    inputSchema: schema.object({ query: schema.string("Words to look for."), limit: schema.integer("Results (default 10, max 30).") }, ["query"]),
    async call(_client, _context, args) {
      const query = stringArg(args, "query");
      const workspace = workspaceFor(service);
      const { app, apps } = await chosenIndex(service, workspace);
      if (!app) return apps.length ? "There's more than one search index; the owner picks one on the Search page." : "There's no Buzz search index in the workspace picked on the Search page (an admin makes one with the Databricks App type's Search index template).";
      const hits = await searchBuzz(await workspace.ready(), app, query, numberArg(args, "limit", 10, 1, 30));
      if (!hits.length) return `Nothing in public channels matches “${query}”.`;
      return hits.map((hit) => `- #${hit.channelName} · ${hit.authorName ?? hit.author.slice(0, 8)} · ${new Date(hit.createdAt * 1000).toISOString().slice(0, 16)}Z${hit.root ? " (in a thread)" : ""}: ${hit.snippet}`).join("\n");
    },
  };
}
