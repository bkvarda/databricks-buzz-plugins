// Genie tools for every Buzz agent. They run as the device owner, so answers
// follow the owner's Unity Catalog access.
import { Genie, type GenieSpace } from "@dbx/core/api/genie";
import { type AgentTool, numberArg, schema, stringArg } from "@dbx/core/host-types";
import { toMarkdown } from "@dbx/core/result";
import type { DatabricksService } from "@dbx/core/service";
import type { GenieOne } from "./genie-one";
import type { SpacesStore } from "./page";

const AUDIENCE =
  "Note: these results came from the owner's Databricks access. Everyone in this conversation can read what you post, so share only what this audience should see.";

export function formatAnswer(
  space: Pick<GenieSpace, "title" | "space_id">,
  answer: Awaited<ReturnType<Genie["answer"]>>,
  link: string | undefined,
  maxRows: number,
): string {
  const lines = [`Genie agent: ${space.title} (${space.space_id})`, `conversation_id: ${answer.message.conversation_id}`, `status: ${answer.message.status}`];
  if (answer.error) lines.push(`error: ${answer.error}`);
  if (answer.text) lines.push("", answer.text);
  if (answer.result) lines.push("", toMarkdown(answer.result, maxRows));
  else if (answer.rowCount !== undefined) lines.push("", `(The query returned ${answer.rowCount} rows; the result could not be fetched.)`);
  if (answer.sql) lines.push("", "SQL:", "```sql", answer.sql.trim(), "```");
  if (answer.suggestions.length) lines.push("", `Follow-ups Genie suggests: ${answer.suggestions.slice(0, 3).join(" | ")}`);
  if (link) lines.push("", `Open in Genie: ${link}`);
  lines.push("", AUDIENCE);
  return lines.join("\n");
}

export function genieTools(service: DatabricksService, store: SpacesStore, genieOne: GenieOne): AgentTool[] {
  return [
    {
      name: "databricks_genie_list",
      description:
        "Lists the Databricks Genie agents (formerly Genie spaces) the owner can use. Each answers natural-language questions about a curated set of tables, such as sales or support data. Optionally filter by a search term.",
      inputSchema: schema.object({ search: schema.string("Words to match in the agent's title or description.") }),
      async call(_client, _context, args) {
        const search = stringArg(args, "search", false).toLowerCase();
        const spaces = (await store.load(true)).filter(
          (space) => !search || `${space.title} ${space.description ?? ""}`.toLowerCase().includes(search),
        );
        if (!spaces.length) return search ? `No Genie agents match "${search}".` : "No Genie agents are shared with the owner in this workspace.";
        return spaces
          .slice(0, 50)
          .map((space) => `- ${space.title} (id ${space.space_id})${space.description ? `: ${space.description.replace(/\s+/g, " ").slice(0, 200)}` : ""}`)
          .join("\n");
      },
    },
    {
      name: "databricks_genie_ask",
      description:
        "Asks a Databricks Genie agent a question about data and waits for the answer (usually 10–60 seconds). Returns Genie's explanation, the result table, the SQL it ran, and a conversation_id: pass that back to ask a follow-up in the same conversation. Use databricks_genie_list to find agents.",
      inputSchema: schema.object(
        {
          agent: schema.string("The Genie agent's id or title."),
          question: schema.string("The question, in plain language."),
          conversation_id: schema.string("Continue an earlier conversation with this agent."),
          max_rows: schema.integer("Rows of the result to include (default 20, max 100)."),
        },
        ["agent", "question"],
      ),
      async call(_client, _context, args) {
        const space = await store.find(stringArg(args, "agent"));
        if (!space) throw new Error("No Genie agent matches that id or title. Call databricks_genie_list first.");
        const client = await service.ready();
        const conversationId = stringArg(args, "conversation_id", false);
        const answer = await new Genie(client).answer(space.space_id, stringArg(args, "question"), conversationId ? { conversationId } : {});
        const link = service.workspaceUrl(Genie.webPath(space.space_id, answer.message.conversation_id));
        return formatAnswer(space, answer, link, numberArg(args, "max_rows", 20, 1, 100));
      },
    },
    {
      name: "databricks_genie_one_ask",
      description:
        "Asks Genie One, Databricks' workspace-wide data assistant, which finds the right data itself (no agent needed). Good when you don't know which Genie agent or table covers a question. Returns the answer and any result table.",
      inputSchema: schema.object(
        {
          question: schema.string("The question, in plain language."),
          conversation_id: schema.string("Continue an earlier Genie One conversation."),
        },
        ["question"],
      ),
      async call(_client, _context, args) {
        const conversationId = stringArg(args, "conversation_id", false);
        const answer = await genieOne.ask(stringArg(args, "question"), conversationId ? { conversationId } : {});
        return `${genieOne.format(answer)}\n\n${AUDIENCE}`;
      },
    },
  ];
}
