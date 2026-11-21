// The Slack bridge's Settings: the owner's Slack conversations (from their
// own Slack sign-in in Databricks), each with a switch, and where each bridged
// one lives in Buzz. The runner (../runner/slack-bridge.ts) does the bridging.
import { gatewayMcpPath, McpClient, resultText } from "@dbx/core/api/mcp";
import { React } from "@dbx/core/react";
import { type DatabricksService, describeError, useAsync, useConnection } from "@dbx/core/service";
import { Badge, Field, Notice, Spinner, Stack, Text } from "@dbx/core/ui/components";
import type { ConversationStatus } from "../runner/slack-bridge";
import { cachedList } from "./ui";
import { groupName, isPrivateKind, KIND_LABEL, parseListing, parseProfile, SLACK_TOOLS, type SlackConversation, type SlackKind, type SlackListing } from "./slack";

const MAX_PAGES = 10;
const SHOWN = 150;

export type SlackDirectory = Readonly<{ conversations: readonly SlackListing[]; handle?: string; partial: boolean }>;

async function callSlack(service: DatabricksService, tool: string, args: Readonly<Record<string, unknown>>) {
  const result = await new McpClient(await service.ready(), gatewayMcpPath(SLACK_TOOLS)).callTool(tool, args, { timeoutMs: 120_000 });
  const text = resultText(result);
  if (result.isError) throw new Error(text.slice(0, 300) || `Slack's ${tool} failed.`);
  return text;
}

/** Every conversation the owner is in (up to MAX_PAGES pages), and their handle, for naming group DMs. */
export async function loadDirectory(service: DatabricksService, call = callSlack): Promise<SlackDirectory> {
  const profile = parseProfile(await call(service, "slack_read_user_profile", { response_format: "concise" }));
  const conversations: SlackListing[] = [];
  let cursor: string | undefined;
  let pages = 0;
  do {
    const page = parseListing(
      await call(service, "slack_list_user_channels", { types: "public_channel,private_channel,im,mpim", exclude_archived: true, limit: 200, ...(cursor && { cursor }) }),
    );
    conversations.push(...page.conversations);
    cursor = page.cursor;
  } while (cursor && ++pages < MAX_PAGES);
  const named = conversations.map((conversation) => (conversation.kind === "mpim" ? { ...conversation, name: groupName(conversation.name, profile?.handle) } : conversation));
  return { conversations: named, ...(profile && { handle: profile.handle }), partial: Boolean(cursor) };
}

const FILTERS: readonly { id: "all" | "channels" | SlackKind; label: string }[] = [
  { id: "all", label: "Everything" },
  { id: "channels", label: "Channels" },
  { id: "im", label: "DMs" },
  { id: "mpim", label: "Group DMs" },
];

function where(conversation: SlackConversation, status: ConversationStatus | undefined, saved: boolean): string {
  if (!saved) return isPrivateKind(conversation.kind) ? "Save to bridge it into a private Buzz channel." : "Save to bridge it into an open Buzz channel.";
  if (!status?.buzz) return status?.error ? `Not bridged yet: ${status.error}` : "Waiting for the bridge to pick it up.";
  const name = `#${status.buzzName ?? status.buzz}`;
  const role = status.primary ? "your bridge posts there" : "another bridge posts there first; yours fills in when it's asleep and sends your messages";
  const people = status.people && status.people > 1 ? ` · ${status.people} people` : "";
  const join = status.ownerIn === false ? " · you haven't joined it in Buzz yet" : "";
  return `${name} · ${role}${people}${join}${status.error ? ` · last error: ${status.error}` : ""}`;
}

export function SlackConversationsField(props: {
  service: DatabricksService;
  value: readonly SlackConversation[];
  saved: readonly SlackConversation[];
  status?: readonly ConversationStatus[];
  onChange(value: SlackConversation[]): void;
  openChannel?(channel: string): void;
  disabled?: boolean;
}) {
  const connection = useConnection(props.service).status;
  const directory = useAsync(() => cachedList(props.service, "slack-directory", () => loadDirectory(props.service)), [props.service, connection]);
  const [query, setQuery] = React.useState("");
  const [filter, setFilter] = React.useState<(typeof FILTERS)[number]["id"]>("all");
  const chosen = new Map(props.value.map((conversation) => [conversation.id, conversation]));
  const saved = new Set(props.saved.map((conversation) => conversation.id));
  const statusOf = new Map((props.status ?? []).map((status) => [status.id, status]));
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  const fits = (conversation: SlackConversation) =>
    (filter === "all" || (filter === "channels" ? conversation.kind === "public" || conversation.kind === "private" : conversation.kind === filter)) &&
    words.every((word) => conversation.name.toLowerCase().includes(word) || conversation.id.toLowerCase() === word);
  const others = (directory.data?.conversations ?? []).filter((conversation) => !chosen.has(conversation.id) && fits(conversation));
  const toggle = (conversation: SlackConversation, on: boolean) => {
    const { id, name, kind } = conversation;
    props.onChange(on ? [...props.value, { id, name, kind }] : props.value.filter((item) => item.id !== id));
  };
  const row = (conversation: SlackConversation, on: boolean) => {
    const status = statusOf.get(conversation.id);
    return (
      <label key={conversation.id} style={{ display: "flex", gap: 10, alignItems: "flex-start", padding: "7px 10px", borderBottom: "1px solid var(--dbx-border)", cursor: props.disabled ? "default" : "pointer" }}>
        <input type="checkbox" checked={on} disabled={props.disabled} onChange={(event) => toggle(conversation, event.target.checked)} style={{ marginTop: 3 }} />
        <Stack gap={2}>
          <Stack direction="row" gap={6} align="center" wrap>
            <Text size="sm" weight={500}>
              {conversation.kind === "public" || conversation.kind === "private" ? `#${conversation.name}` : conversation.name}
            </Text>
            <Badge tone={isPrivateKind(conversation.kind) ? "neutral" : "brand"}>{KIND_LABEL[conversation.kind]}</Badge>
          </Stack>
          {on && (
            <Text size="xs" tone={status?.error ? "warning" : "tertiary"}>
              {where(conversation, status, saved.has(conversation.id))}
              {status?.buzz && props.openChannel ? " · " : ""}
              {status?.buzz && props.openChannel && (
                <a
                  href="#"
                  onClick={(event) => {
                    event.preventDefault();
                    props.openChannel!(status.buzz!);
                  }}
                >
                  {status.ownerIn === false ? "Open and join" : "Open"}
                </a>
              )}
            </Text>
          )}
        </Stack>
      </label>
    );
  };
  return (
    <Stack gap={10}>
      <Field
        label="Slack conversations"
        hint="Each one you turn on gets a Buzz channel. Public Slack channels go to open Buzz channels that everyone who bridges them shares. Private channels, DMs and group DMs go to a private Buzz channel of your own, with only you in it; someone else in the conversation who bridges it gets their own. Anyone you add to yours reads the Slack conversation, so add only people who are in it on Slack."
      >
        <Stack direction="row" gap={8}>
          <input className="dbx-input" style={{ flex: 1 }} placeholder="Search your Slack" value={query} disabled={props.disabled} onChange={(event) => setQuery(event.target.value)} />
          <select className="dbx-select" value={filter} disabled={props.disabled} onChange={(event) => setFilter(event.target.value as typeof filter)}>
            {FILTERS.map((choice) => (
              <option key={choice.id} value={choice.id}>
                {choice.label}
              </option>
            ))}
          </select>
        </Stack>
      </Field>
      {directory.error && (
        <Notice tone="warning" title="Couldn't read your Slack">
          {describeError(directory.error)}. The bridge reads Slack through your own Slack sign-in in this Databricks workspace; sign in to Slack there (for example by using Slack in Genie), then reopen this tab.
        </Notice>
      )}
      <div style={{ border: "1px solid var(--dbx-border)", borderRadius: 8, maxHeight: 420, overflow: "auto" }}>
        {props.value.length > 0 && (
          <>
            <div style={{ padding: "6px 10px", background: "var(--dbx-surface-raised, transparent)" }}>
              <Text size="xs" tone="subtle" weight={600}>
                Bridged · {props.value.length}
              </Text>
            </div>
            {props.value.map((conversation) => row(conversation, true))}
          </>
        )}
        <div style={{ padding: "6px 10px" }}>
          <Text size="xs" tone="subtle" weight={600}>
            {directory.loading && !directory.data ? "Reading your Slack…" : `Your Slack · ${others.length}${directory.data?.partial ? "+" : ""}`}
          </Text>
        </div>
        {directory.loading && !directory.data && (
          <div style={{ padding: 12 }}>
            <Spinner size={12} />
          </div>
        )}
        {others.slice(0, SHOWN).map((conversation) => row(conversation, false))}
        {others.length > SHOWN && (
          <div style={{ padding: "8px 10px" }}>
            <Text size="xs" tone="tertiary">
              {others.length - SHOWN} more; search to find them.
            </Text>
          </div>
        )}
      </div>
    </Stack>
  );
}
