// Databricks Memory: long-term memory for every Buzz agent, kept in Databricks
// managed memory (Lakebase-backed). Entries belong to the signed-in person
// (actor_id is set by this plugin, never by a model), so their memory follows
// them across Buzz agents and any Databricks agents that use the same store.
import type { Context } from "@buzz/author";
import { entryId, Memory, type MemoryEntry, normalizePath, validStoreId } from "@dbx/core/api/memory";
import { type AgentTool, numberArg, schema, stringArg } from "@dbx/core/host-types";
import { bindReact, React } from "@dbx/core/react";
import { type DatabricksService, describeError, useAsync, useConnection, usePreference } from "@dbx/core/service";
import { attach, MissingCore, useLive } from "@dbx/core/suite";
import { ago, Button, DbxRoot, Field, Notice, SectionHeader, Spinner, Stack, Text } from "@dbx/core/ui/components";

export const inject = ["react", "settingsCards"];

export const DEFAULT_STORE = "buzz-agent-memory";
const STORE_PREF = "memoryStore";

async function context(service: DatabricksService) {
  const client = await service.ready();
  const snapshot = service.snapshot();
  if (snapshot.status !== "connected") throw new Error("Databricks is not connected.");
  const store = service.preferences.get<string>(STORE_PREF) ?? DEFAULT_STORE;
  const memory = new Memory(client);
  if (store === DEFAULT_STORE) await ensured(memory, store);
  return { memory, store, actor: snapshot.user.userName };
}

const ensuredStores = new Map<string, Promise<unknown>>();
function ensured(memory: Memory, store: string) {
  let promise = ensuredStores.get(store);
  if (!promise) {
    promise = memory.ensureStore(store, "Long-term memory for Buzz agents (databricks-buzz-plugins).").catch((error) => {
      ensuredStores.delete(store);
      throw error;
    });
    ensuredStores.set(store, promise);
  }
  return promise;
}

const line = (entry: MemoryEntry, excerpt = 300) =>
  `- ${entry.path}${entry.description ? ` — ${entry.description}` : ""}${entry.content ? `\n  ${entry.content.replace(/\s+/g, " ").slice(0, excerpt)}${entry.content.length > excerpt ? "…" : ""}` : ""}`;

export function memoryTools(service: DatabricksService): AgentTool[] {
  return [
    {
      name: "databricks_memory_search",
      description:
        "Searches the owner's long-term memory in Databricks (semantic + keyword) and returns the best matching entries. Search before answering questions about the owner's preferences, projects, people or past decisions. This memory is shared by all of the owner's agents.",
      inputSchema: schema.object(
        { query: schema.string("What to look for, in natural language."), limit: schema.integer("Max entries (default 8, max 25).") },
        ["query"],
      ),
      async call(_client, _context, args) {
        const { memory, store, actor } = await context(service);
        const entries = await memory.search(store, actor, stringArg(args, "query"), numberArg(args, "limit", 8, 1, 25));
        return entries.length ? entries.map((entry) => line(entry, 600)).join("\n") : "No matching memories.";
      },
    },
    {
      name: "databricks_memory_read",
      description: "Reads one memory entry by its path, e.g. /preferences/writing-style.md.",
      inputSchema: schema.object({ path: schema.string("The entry's path.") }, ["path"]),
      async call(_client, _context, args) {
        const { memory, store, actor } = await context(service);
        const entry = await memory.get(store, actor, stringArg(args, "path"));
        if (!entry) return `There is no memory at ${normalizePath(stringArg(args, "path"))}.`;
        return `${entry.path}${entry.description ? ` — ${entry.description}` : ""}\n\n${entry.content ?? ""}`;
      },
    },
    {
      name: "databricks_memory_write",
      description:
        "Creates or replaces a memory entry. Use file-like paths that group related facts (/people/alex.md, /projects/q3-launch.md, /preferences/formatting.md) and keep one topic per entry. Rewrite the whole entry when updating it; read it first so nothing is lost. Never store secrets.",
      inputSchema: schema.object(
        {
          path: schema.string("File-like path, e.g. /projects/q3-launch.md"),
          content: schema.string("The complete entry text (Markdown)."),
          description: schema.string("One line describing the entry, used in search results."),
        },
        ["path", "content"],
      ),
      async call(_client, _context, args) {
        const content = stringArg(args, "content");
        if (/(dapi[0-9a-f]{32}|-----BEGIN [A-Z ]*PRIVATE KEY|nsec1[0-9a-z]{20,})/i.test(content)) throw new Error("That looks like a secret; memories must not contain credentials.");
        if (content.length > 32_000) throw new Error("Keep entries under 32,000 characters; split the topic into several entries.");
        const { memory, store, actor } = await context(service);
        const description = stringArg(args, "description", false);
        const entry = await memory.put(store, { actorId: actor, path: stringArg(args, "path"), content, ...(description && { description }) });
        return `Saved ${entry.path ?? normalizePath(stringArg(args, "path"))}.`;
      },
    },
    {
      name: "databricks_memory_list",
      description: "Lists memory entry paths, optionally under a path prefix such as /projects/.",
      inputSchema: schema.object({ prefix: schema.string("Only paths starting with this.") }),
      async call(_client, _context, args) {
        const { memory, store, actor } = await context(service);
        const prefix = stringArg(args, "prefix", false);
        const entries = (await memory.list(store, actor)).filter((entry) => !prefix || entry.path.startsWith(normalizePath(prefix)));
        if (!entries.length) return prefix ? `No memories under ${prefix}.` : "No memories yet.";
        return entries
          .sort((a, b) => a.path.localeCompare(b.path))
          .map((entry) => `- ${entry.path}${entry.description ? ` — ${entry.description}` : ""}`)
          .join("\n");
      },
    },
    {
      name: "databricks_memory_delete",
      description: "Deletes the memory entry at a path. Use when the owner asks to forget something or an entry is wrong.",
      inputSchema: schema.object({ path: schema.string("The entry's path.") }, ["path"]),
      async call(_client, _context, args) {
        const { memory, store, actor } = await context(service);
        const removed = await memory.remove(store, actor, stringArg(args, "path"));
        return removed ? `Deleted ${normalizePath(stringArg(args, "path"))}.` : "There was no entry at that path.";
      },
    },
  ];
}

function MemorySettings(props: { service: DatabricksService }) {
  const { service } = props;
  const snapshot = useConnection(service);
  const [store, setStore] = usePreference<string>(service, STORE_PREF);
  const [draft, setDraft] = React.useState(store ?? DEFAULT_STORE);
  const [query, setQuery] = React.useState("");
  const [submitted, setSubmitted] = React.useState("");
  const [message, setMessage] = React.useState<string>();
  const entries = useAsync(
    async () => {
      const { memory, store: id, actor } = await context(service);
      return submitted ? memory.search(id, actor, submitted, 25) : memory.list(id, actor);
    },
    [snapshot.status, store, submitted],
  );
  const stores = useAsync(async (signal) => new Memory(await service.ready(signal)).stores(signal), [snapshot.status]);
  if (snapshot.status !== "connected")
    return <Notice title="Connect Databricks" action={<Button variant="brand" onClick={() => service.openSettings()}>Connect</Button>}>Memory lives in your Databricks workspace.</Notice>;
  return (
    <Stack gap={24}>
      <Stack gap={6}>
        <Text as="h2" size="xl" weight={500}>Databricks Memory</Text>
        <Text tone="subtle">
          Your agents remember across conversations with Databricks managed memory. Memories belong to {snapshot.user.userName}; every agent you run here shares them.
        </Text>
      </Stack>
      <Stack gap={10}>
        <SectionHeader title="Memory store" description="Use the same store as your Databricks agents to share memory with them." />
        <Field label="Store ID" hint={`Lowercase letters, digits and hyphens. The default, ${DEFAULT_STORE}, is created on first use.`}>
          <Stack direction="row" gap={8}>
            <input className="dbx-input" list="dbx-memory-stores" value={draft} onChange={(event) => setDraft(event.target.value.trim())} style={{ maxWidth: 320 }} />
            <datalist id="dbx-memory-stores">
              {(stores.data ?? []).map((candidate) => {
                const id = candidate.name?.split("/").pop() ?? "";
                return <option key={id} value={id} />;
              })}
            </datalist>
            <Button
              disabled={!validStoreId(draft) || draft === (store ?? DEFAULT_STORE)}
              onClick={() => {
                setStore(draft === DEFAULT_STORE ? undefined : draft);
                setMessage(`Agents now use ${draft}.`);
              }}
            >
              Use store
            </Button>
          </Stack>
        </Field>
        {message && <Text tone="success" size="sm">{message}</Text>}
      </Stack>
      <Stack gap={10}>
        <SectionHeader title="Memories" />
        <form onSubmit={(event) => { event.preventDefault(); setSubmitted(query.trim()); }}>
          <Stack direction="row" gap={8}>
            <input className="dbx-input" placeholder="Search memories" value={query} onChange={(event) => setQuery(event.target.value)} style={{ maxWidth: 420 }} />
            <Button type="submit">Search</Button>
            {submitted && <Button variant="ghost" onClick={() => { setQuery(""); setSubmitted(""); }}>Show all</Button>}
          </Stack>
        </form>
        {entries.loading && <Stack direction="row" gap={8} align="center"><Spinner size={12} /><Text tone="subtle" size="sm">Loading…</Text></Stack>}
        {entries.error && <Notice tone="danger" title="Couldn't read memory">{describeError(entries.error)}</Notice>}
        {!entries.loading && !entries.error && !entries.data?.length && <Text tone="subtle">{submitted ? "Nothing matches." : "No memories yet. Agents save what they learn here."}</Text>}
        {(entries.data ?? []).map((entry) => (
          <div key={entryId(entry) || entry.path} className="dbx-card" style={{ padding: 12 }}>
            <Stack gap={4}>
              <Stack direction="row" align="center" justify="space-between" gap={8}>
                <Text weight={500} mono size="sm">{entry.path}</Text>
                <Stack direction="row" gap={6} align="center">
                  {entry.update_time && <Text tone="tertiary" size="xs">{ago(Date.parse(entry.update_time))}</Text>}
                  <Button
                    size="sm"
                    variant="danger"
                    onClick={async () => {
                      try {
                        const { memory, store: id, actor } = await context(service);
                        await memory.remove(id, actor, entry.path);
                        entries.reload();
                      } catch (error) {
                        setMessage(describeError(error));
                      }
                    }}
                  >
                    Forget
                  </Button>
                </Stack>
              </Stack>
              {entry.description && <Text tone="subtle" size="sm">{entry.description}</Text>}
              {entry.content && <Text size="sm" as="div" style={{ whiteSpace: "pre-wrap", maxHeight: 120, overflow: "hidden" }}>{entry.content}</Text>}
            </Stack>
          </div>
        ))}
      </Stack>
    </Stack>
  );
}

export function apply(ctx: Context) {
  bindReact(ctx.react);
  const live = attach(ctx, { id: "bkvarda.databricks-memory", name: "Databricks Memory" }, (scope, databricks) => {
    scope.inject(["agents"], (agents: Context) => {
      for (const tool of memoryTools(databricks)) agents.agents.addTool(tool);
    });
    return databricks;
  });
  ctx.settingsCards.register({
    id: "memory",
    title: "Databricks Memory",
    component: () => {
      const service = useLive(live);
      return service ? (
        <DbxRoot>
          <MemorySettings service={service} />
        </DbxRoot>
      ) : (
        <MissingCore ctx={ctx} feature="Databricks Memory" />
      );
    },
  });
}
