// Genie inside conversations: a composer tool to ask Genie and insert the
// answer into the draft, plus a chip and a side panel for Genie links.
import type { ComposerToolProps } from "@buzz/author";
import { Genie, parseGenieUrl } from "@dbx/core/api/genie";
import type { PanelProps } from "@dbx/core/host-types";
import { React } from "@dbx/core/react";
import { type DatabricksService, useAsync, useConnection, usePreference } from "@dbx/core/service";
import { Button, DatabricksMark, DbxRoot, EmptyState, Notice, Spinner, Stack, Text } from "@dbx/core/ui/components";
import { GenieChat, turnMarkdown } from "./chat";
import { type GenieChats, OneChat, SpaceChat, useOwnChat } from "./chats";
import type { GenieOne } from "./genie-one";
import { GenieOneChat, oneTurnMarkdown } from "./genie-one-chat";
import { GENIE_ONE_ENTRY, type SpacesStore, useGenieOneAvailable, useSelection, useSpaces } from "./page";

export function composerTool(service: DatabricksService, store: SpacesStore, genieOne: GenieOne) {
  return function AskGenie(props: ComposerToolProps) {
    const [open, setOpen] = React.useState(false);
    const root = React.useRef<HTMLDivElement>(null);
    React.useEffect(() => {
      if (!open) return;
      const onKey = (event: KeyboardEvent) => {
        if (event.key === "Escape") {
          event.stopPropagation();
          setOpen(false);
          props.focus();
        }
      };
      const onPointer = (event: PointerEvent) => {
        if (root.current && !root.current.contains(event.target as Node)) setOpen(false);
      };
      document.addEventListener("keydown", onKey, true);
      document.addEventListener("pointerdown", onPointer, true);
      return () => {
        document.removeEventListener("keydown", onKey, true);
        document.removeEventListener("pointerdown", onPointer, true);
      };
    }, [open, props]);
    return (
      <DbxRoot style={{ position: "relative", display: "inline-flex" }}>
        <div ref={root} style={{ display: "contents" }}>
          <Button
            icon
            variant="ghost"
            aria-label="Ask Genie"
            title="Ask Genie about your data. Only you see the answer until you insert it."
            disabled={props.disabled}
            onClick={() => setOpen(!open)}
          >
            <DatabricksMark size={14} />
          </Button>
          {open && (
            <div
              role="dialog"
              aria-label="Ask Genie"
              style={{
                position: "absolute",
                bottom: "calc(100% + 8px)",
                left: 0,
                width: "min(520px, 80vw)",
                maxHeight: "min(560px, 70vh)",
                overflow: "auto",
                zIndex: 50,
                padding: 14,
                background: "var(--dbx-popover)",
                border: "1px solid var(--dbx-border)",
                borderRadius: "var(--dbx-radius-card)",
                boxShadow: "var(--shadow-panel, 0 8px 28px rgba(0,0,0,0.18))",
              }}
            >
              <GeniePicker
                service={service}
                store={store}
                genieOne={genieOne}
                onInsert={(markdown) => {
                  if (props.insertText(`${markdown}\n`)) {
                    setOpen(false);
                    props.focus();
                  }
                }}
              />
            </div>
          )}
        </div>
      </DbxRoot>
    );
  };
}

function GeniePicker(props: { service: DatabricksService; store: SpacesStore; genieOne: GenieOne; onInsert(markdown: string): void }) {
  const { service, store, genieOne } = props;
  const snapshot = useConnection(service);
  const spaces = useSpaces(store);
  const oneAvailable = useGenieOneAvailable(service, genieOne);
  const [selected, setSelected] = useSelection(service, oneAvailable);
  if (snapshot.status !== "connected")
    return (
      <EmptyState title="Connect Databricks" action={<Button variant="brand" onClick={() => service.openSettings()}>Connect</Button>}>
        Sign in once to ask Genie from any conversation.
      </EmptyState>
    );
  const useOne = oneAvailable && (selected === GENIE_ONE_ENTRY || !spaces.spaces.length);
  const space = useOne ? undefined : (spaces.spaces.find((candidate) => candidate.space_id === selected) ?? spaces.spaces[0]);
  const value = useOne ? GENIE_ONE_ENTRY : (space?.space_id ?? "");
  return (
    <Stack gap={12}>
      <Stack direction="row" gap={8} align="center">
        <DatabricksMark size={14} />
        <Text weight={500}>Ask Genie</Text>
        {spaces.status === "loading" && <Spinner size={12} />}
      </Stack>
      {spaces.status === "error" && !oneAvailable && <Notice tone="danger">{spaces.error}</Notice>}
      {(oneAvailable || spaces.spaces.length > 0) && (
        <select className="dbx-select" value={value} onChange={(event) => setSelected(event.target.value)} aria-label="Ask">
          {oneAvailable && <option value={GENIE_ONE_ENTRY}>Genie One · all your data</option>}
          {spaces.spaces.map((candidate) => (
            <option key={candidate.space_id} value={candidate.space_id}>
              {candidate.title}
            </option>
          ))}
        </select>
      )}
      {!oneAvailable && spaces.status === "ready" && !spaces.spaces.length && <Text tone="subtle">No Genie agents are shared with you yet.</Text>}
      {useOne && (
        <OwnGenieOneChat
          genieOne={genieOne}
          compact
          answerActions={(turn) => (
            <Button size="sm" variant="primary" onClick={() => props.onInsert(oneTurnMarkdown(turn))}>
              Insert into message
            </Button>
          )}
        />
      )}
      {space && (
        <OwnGenieChat
          key={space.space_id}
          service={service}
          space={space}
          compact
          answerActions={(turn) =>
            turn.text || turn.result ? (
              <Button size="sm" variant="primary" onClick={() => props.onInsert(turnMarkdown(space, turn, service.workspaceUrl(Genie.webPath(space.space_id, turn.message?.conversation_id))))}>
                Insert into message
              </Button>
            ) : null
          }
        />
      )}
      <Text tone="tertiary" size="xs">
        Only you see this until you insert it. Answers use your access; inserting shares the answer with everyone in this conversation.
      </Text>
    </Stack>
  );
}

export function genieLinkChip(service: DatabricksService, store: SpacesStore) {
  return function GenieLink(props: { url: string }) {
    const link = parseGenieUrl(props.url);
    const spaces = useSpaces(store);
    const space = link && spaces.spaces.find((candidate) => candidate.space_id === link.spaceId);
    return (
      <span style={{ display: "inline-flex", alignItems: "center", gap: 4 }}>
        <span data-dbx="" style={{ display: "inline-flex" }}>
          <DatabricksMark size={11} />
        </span>
        <span>Genie{space ? ` · ${space.title}` : link?.conversationId ? " conversation" : ""}</span>
      </span>
    );
  };
}

// The composer's chats are its own: they stop when it closes, as a draft would.
function OwnGenieOneChat(props: Omit<React.ComponentProps<typeof GenieOneChat>, "chat"> & { genieOne: GenieOne }) {
  const { genieOne, ...rest } = props;
  const chat = useOwnChat(() => new OneChat(genieOne), [genieOne]);
  return <GenieOneChat chat={chat} {...rest} />;
}

function OwnGenieChat(props: Omit<React.ComponentProps<typeof GenieChat>, "chat">) {
  const chat = useOwnChat(() => new SpaceChat(props.service, props.space.space_id), [props.service, props.space.space_id]);
  return <GenieChat chat={chat} {...props} />;
}

export function geniePanel(service: DatabricksService, store: SpacesStore, chats: GenieChats) {
  return function GeniePanel(props: PanelProps) {
    const link = React.useMemo(() => parseGenieUrl(props.target), [props.target]);
    const snapshot = useConnection(service);
    const space = useAsync(
      async (signal) => {
        if (!link) return undefined;
        const client = await service.ready(signal);
        if (client.host !== link.host) return "elsewhere" as const;
        return (await store.find(link.spaceId)) ?? (await new Genie(client).getSpace(link.spaceId, signal));
      },
      [props.target, snapshot.status],
    );
    let body: React.ReactNode;
    if (snapshot.status !== "connected")
      body = (
        <EmptyState title="Connect Databricks" action={<Button variant="brand" onClick={() => service.openSettings()}>Connect</Button>}>
          Sign in to chat with this Genie agent.
        </EmptyState>
      );
    else if (space.loading) body = <Spinner />;
    else if (space.error) body = <Notice tone="danger" title="Can't open this Genie agent">{String(space.error.message)}</Notice>;
    else if (space.data === "elsewhere") body = <Notice title="Different workspace">This Genie agent is in {link?.host.replace("https://", "")}.</Notice>;
    else if (space.data)
      body = <GenieChat service={service} space={space.data} chat={chats.linked(space.data.space_id, link?.conversationId)} />;
    else body = <Text tone="subtle">Not a Genie link.</Text>;
    return <DbxRoot style={{ padding: "var(--space-panel-inset, 16px)", display: "flex", flexDirection: "column", minHeight: "100%" }}>{body}</DbxRoot>;
  };
}
