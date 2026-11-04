// Saved sessions, one per agent and conversation, in Buzz's agent storage.
import type { Agents } from "@buzz/author";
import type { ChatMessage } from "@dbx/core/api/ai";

export type Session = {
  /** The harness kit's opaque cursor for what this session has been shown. */
  cursor?: string;
  messages: ChatMessage[];
  /** Genie agents keep Genie's own conversation per Buzz conversation. */
  genieConversationId?: string;
  updatedAt: number;
};

const PREFIX = "bkvarda.databricks-agents.v1";

export class Sessions {
  constructor(private readonly storage: Agents["storage"]) {}

  private key(agent: string, conversation: string) {
    return `${PREFIX}:${agent}:${conversation}`;
  }

  get(agent: string, conversation: string): Session {
    try {
      const raw = this.storage.get(this.key(agent, conversation));
      const parsed = raw ? (JSON.parse(raw) as Session) : undefined;
      if (parsed && Array.isArray(parsed.messages)) return parsed;
    } catch {
      // An unreadable session starts over.
    }
    return { messages: [], updatedAt: 0 };
  }

  async set(agent: string, conversation: string, session: Session): Promise<void> {
    await this.storage.set(this.key(agent, conversation), JSON.stringify({ ...session, updatedAt: Date.now() }));
  }

  async clear(agent: string, conversation: string): Promise<void> {
    await this.storage.set(this.key(agent, conversation), null);
  }

  /** Every conversation key saved for an agent, newest first. */
  list(agent: string): { conversation: string; session: Session }[] {
    const prefix = `${PREFIX}:${agent}:`;
    return this.storage
      .keys()
      .filter((key) => key.startsWith(prefix))
      .map((key) => ({ conversation: key.slice(prefix.length), session: this.get(agent, key.slice(prefix.length)) }))
      .sort((a, b) => b.session.updatedAt - a.session.updatedAt);
  }
}

/** The text of a mention, without mention links, for agents that need a plain question. */
export function plainText(content: string): string {
  return content
    .replace(/\[([^\]]*)\]\(nostr:[^)]+\)/g, "")
    .replace(/nostr:(npub|nprofile|note|nevent)1[0-9a-z]+/g, "")
    .replace(/^\s*@\S+\s*/, "")
    .replace(/[ \t]+/g, " ")
    .trim();
}
