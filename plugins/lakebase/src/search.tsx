// Search for Buzz, backed by Lakebase: a page that searches a Buzz search
// index (a Databricks App made with the Databricks Agents plugin's Search
// index template, which reads the community's public channels into Lakebase),
// and the same search as an agent tool. Each search runs as the person
// searching: Databricks Apps signs them in, and they need Can Use on the app.
import type { Context } from "@buzz/author";
import { type BuzzSearchHit, type BuzzSearchQuery, type DatabricksApp, searchApps, searchBuzz, searchBuzzQuery, suggestBuzz } from "@dbx/core/api/apps";
import { type AgentTool, numberArg, optionalService, schema, stringArg } from "@dbx/core/host-types";
import { React } from "@dbx/core/react";
import { type DatabricksService, describeError, useAsync, useConnection, usePreference } from "@dbx/core/service";
import { ago, Badge, Button, DbxRoot, EmptyState, Notice, Spinner, Stack, Text } from "@dbx/core/ui/components";
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

export const FILTER_HELP = "Filters: from:@name, to:@name, in:#channel, before:, after:, on: or during: a date (2026-11-03, 2026-11, today), has:link, is:thread. \"Exact phrases\", OR, and -word to leave a word out.";

const day = (seconds: number) => new Date(seconds * 1000).toISOString().slice(0, 10);

/** The filters the index understood, as short labels. */
export function filterLabels(query: BuzzSearchQuery | undefined): string[] {
  if (!query) return [];
  return [
    ...query.from.map((name) => `from ${/^[0-9a-f]{64}$/.test(name) ? `${name.slice(0, 8)}…` : `@${name}`}`),
    ...query.to.map((name) => `to ${/^[0-9a-f]{64}$/.test(name) ? `${name.slice(0, 8)}…` : `@${name}`}`),
    ...query.in.map((channel) => `in #${channel}`),
    ...(query.after !== undefined && query.after > 0 ? [`from ${day(query.after)}`] : []),
    ...(typeof query.before === "number" ? [`before ${day(query.before)}`] : []),
    ...(query.link ? ["has a link"] : []),
    ...(query.thread ? ["in a thread"] : []),
  ];
}

/** A search the page was opened with (route `{ q }`, or a link's `q`). */
export function initialQuery(target: unknown): string {
  const t = target as { kind?: string; route?: { params?: unknown }; params?: Record<string, string> } | undefined;
  const params = t?.kind === "page" ? (t.route?.params as { q?: unknown } | undefined) : t?.params;
  return typeof params?.q === "string" ? params.q : "";
}

/** What's being typed at the caret: a person after @ (or from:/to:), a channel after # (or in:). */
export type Typing = Readonly<{ kind: "people" | "channels"; filter: "from" | "to" | "in"; typed: string; start: number; end: number }>;

export function typingAt(text: string, caret: number): Typing | undefined {
  const before = text.slice(0, caret);
  const person = /(^|\s)(?:(from|to):\s*@?|@)([^\s@#"]*)$/i.exec(before);
  if (person) {
    const start = person.index + person[1]!.length;
    return { kind: "people", filter: (person[2]?.toLowerCase() as "from" | "to" | undefined) ?? "from", typed: person[3] ?? "", start, end: caret };
  }
  const channel = /(^|\s)(?:in:\s*#?|#)([^\s#"]*)$/i.exec(before);
  if (channel) {
    const start = channel.index + channel[1]!.length;
    return { kind: "channels", filter: "in", typed: channel[2] ?? "", start, end: caret };
  }
  return undefined;
}

/** The text with what was being typed replaced by the chosen filter, and where the caret goes. */
export function chooseSuggestion(text: string, typing: Typing, value: string): { text: string; caret: number } {
  const token = typing.kind === "people" ? `${typing.filter}:@${/\s/.test(value) ? `"${value}"` : value}` : `in:#${value}`;
  const after = text.slice(typing.end).replace(/^\S*/, "");
  const next = `${text.slice(0, typing.start)}${token} ${after.replace(/^\s+/, "")}`;
  return { text: next, caret: typing.start + token.length + 1 };
}

type Suggestion = Readonly<{ key: string; label: string; detail?: string; value: string }>;

/** The search box, with Slack-style suggestions for people (@) and channels (#). */
function SearchBox(props: { workspace: DatabricksService; app?: DatabricksApp; value: string; onChange(value: string): void; onSearch(value: string): void; busy?: boolean }) {
  const input = React.useRef<HTMLInputElement>(null);
  const [typing, setTyping] = React.useState<Typing>();
  const [items, setItems] = React.useState<Suggestion[]>([]);
  const [active, setActive] = React.useState(0);
  const app = props.app;
  React.useEffect(() => {
    if (!typing || !app) return setItems([]);
    const controller = new AbortController();
    const timer = setTimeout(() => {
      void props.workspace
        .ready()
        .then(async (client) =>
          typing.kind === "people"
            ? (await suggestBuzz(client, app, "people", typing.typed, controller.signal)).map((p) => ({ key: p.pubkey, label: p.name, detail: `@${p.handle}`, value: p.handle }))
            : (await suggestBuzz(client, app, "channels", typing.typed, controller.signal)).map((c) => ({ key: c.id, label: `#${c.name}`, value: c.name })),
        )
        .then(
          (found) => {
            if (controller.signal.aborted) return;
            setItems(found);
            setActive(0);
          },
          () => setItems([]),
        );
    }, 120);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [typing?.kind, typing?.typed, typing?.filter, app?.name]);
  const refresh = (text: string, caret: number) => setTyping(typingAt(text, caret));
  const choose = (item: Suggestion) => {
    if (!typing) return;
    const next = chooseSuggestion(props.value, typing, item.value);
    props.onChange(next.text);
    setTyping(undefined);
    setItems([]);
    requestAnimationFrame(() => {
      input.current?.focus();
      input.current?.setSelectionRange(next.caret, next.caret);
    });
  };
  const open = Boolean(typing && items.length);
  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        if (open) return choose(items[active]!);
        props.onSearch(props.value);
      }}
    >
      <Stack direction="row" gap={8}>
        <div style={{ position: "relative", flex: 1 }}>
          <input
            ref={input}
            className="dbx-input"
            style={{ width: "100%" }}
            autoFocus
            role="combobox"
            aria-expanded={open}
            aria-autocomplete="list"
            placeholder="Search public channels, e.g. from:@sam in:#general launch"
            value={props.value}
            onChange={(event) => {
              props.onChange(event.target.value);
              refresh(event.target.value, event.target.selectionStart ?? event.target.value.length);
            }}
            onClick={(event) => refresh(event.currentTarget.value, event.currentTarget.selectionStart ?? 0)}
            onBlur={() => setTimeout(() => setTyping(undefined), 150)}
            onKeyDown={(event) => {
              if (!open) return;
              if (event.key === "ArrowDown" || event.key === "ArrowUp") {
                event.preventDefault();
                setActive((n) => (n + (event.key === "ArrowDown" ? 1 : items.length - 1)) % items.length);
              } else if (event.key === "Tab") {
                event.preventDefault();
                choose(items[active]!);
              } else if (event.key === "Escape") {
                event.preventDefault();
                setTyping(undefined);
              }
            }}
          />
          {open && (
            <div
              role="listbox"
              style={{ position: "absolute", top: "calc(100% + 4px)", left: 0, right: 0, zIndex: 10, background: "var(--surface-raised, var(--background, #fff))", border: "1px solid var(--border-standard, #e5e5e5)", borderRadius: 10, boxShadow: "0 8px 24px rgba(0,0,0,0.12)", padding: 4, maxHeight: 320, overflowY: "auto" }}
            >
              <Text size="xs" tone="tertiary" style={{ padding: "4px 8px" }}>
                {typing!.kind === "people" ? (typing!.filter === "to" ? "Mentioning" : "From") : "In"}
              </Text>
              {items.map((item, n) => (
                <div
                  key={item.key}
                  role="option"
                  aria-selected={n === active}
                  onMouseDown={(event) => {
                    event.preventDefault();
                    choose(item);
                  }}
                  onMouseEnter={() => setActive(n)}
                  style={{ padding: "6px 8px", borderRadius: 6, cursor: "pointer", display: "flex", gap: 8, alignItems: "baseline", background: n === active ? "var(--surface-hover, rgba(0,0,0,0.05))" : "transparent" }}
                >
                  <Text size="sm">{item.label}</Text>
                  {item.detail && (
                    <Text size="xs" tone="subtle">
                      {item.detail}
                    </Text>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
        <Button variant="primary" type="submit" disabled={!app || !props.value.trim() || props.busy}>
          {props.busy ? <Spinner size={11} /> : null}Search
        </Button>
      </Stack>
    </form>
  );
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
  return function SearchPage(props: { navigation?: { target: unknown } }) {
    const [profile, setProfile] = usePreference<string>(service, SEARCH_PROFILE_PREFERENCE);
    const workspace = useWorkspaceService(service, profile);
    const snapshot = useConnection(workspace);
    const [picked, setPicked] = usePreference<string>(service, CHOSEN);
    const indexes = useAsync((signal) => chosenIndex(service, workspace, signal), [workspace, snapshot.status, picked]);
    const host = snapshot.status === "connected" ? new URL(snapshot.profile.host).hostname : "this workspace";
    const opened = initialQuery(props.navigation?.target);
    const [query, setQuery] = React.useState(opened);
    const [state, setState] = React.useState<{ loading?: boolean; hits?: BuzzSearchHit[]; understood?: BuzzSearchQuery; old?: boolean; error?: string; asked?: string }>({});
    const app = indexes.data?.app;
    const run = async (text: string) => {
      if (!app || !text.trim()) return;
      setState({ loading: true, asked: text });
      try {
        const found = await searchBuzzQuery(await workspace.ready(), app, text.trim(), 30);
        setState({ hits: found.results, ...(found.query && { understood: found.query }), ...(!found.query && { old: true }), asked: text });
      } catch (error) {
        setState({ error: describeError(error), asked: text });
      }
    };
    // Opened with a search (a link, or the shortcut with one): run it once the index is found.
    const ran = React.useRef(false);
    React.useEffect(() => {
      if (ran.current || !app || !opened) return;
      ran.current = true;
      void run(opened);
    }, [app?.name]);
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
          <SearchBox workspace={workspace} {...(app && { app })} value={query} onChange={setQuery} onSearch={(text) => void run(text)} {...(state.loading && { busy: true })} />
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
          <Text size="xs" tone="tertiary">{FILTER_HELP}</Text>
          {filterLabels(state.understood).length > 0 && (
            <Stack direction="row" gap={6} style={{ flexWrap: "wrap" }}>
              {filterLabels(state.understood).map((label) => (
                <Badge key={label}>{label}</Badge>
              ))}
              {state.understood?.text && <Text size="sm" tone="subtle">and “{state.understood.text}”</Text>}
            </Stack>
          )}
          {state.old && (
            <Notice tone="warning" title="This index runs older code">
              It searched every word, filters included, as text. Its owner's Buzz updates it on its own once the Databricks Agents plugin is updated; Deploy again in its Settings tab does it now.
            </Notice>
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
      "Searches this Buzz community's public channels (messages, with channel, author and time) through the Buzz search index in Databricks. Use it to find earlier discussions or decisions. Takes Slack's filters: from:@name, to:@name, in:#channel, before:/after:/on:/during: a date (YYYY-MM-DD, YYYY-MM, today), has:link, is:thread, plus \"phrases\", OR and -word. Matches are marked **like this**.",
    inputSchema: schema.object({ query: schema.string("Words and filters, e.g. from:@sam in:#general after:2026-11-01 launch plan."), limit: schema.integer("Results (default 10, max 30).") }, ["query"]),
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
