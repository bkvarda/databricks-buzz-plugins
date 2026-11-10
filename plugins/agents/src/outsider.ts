// Databricks agents take requests only from their owner: they work with the
// owner's Databricks access, so someone else's mention isn't a request they
// can take. Rather than going silent, the agent says so once, in that thread,
// tagging the person (so they see it) and the owner (so they know someone
// asked). It runs nothing and reads nothing. One note per person per
// conversation an hour keeps a busy thread, or another agent, from making it
// chatty. Used by the local agent type and the hosted runner.

/** How long after a note one person's mentions in one conversation go without another. */
export const OUTSIDER_QUIET_MS = 60 * 60_000;

export const OUTSIDER_TEXT =
  "Hi! I only take requests from the person who set me up, since I work with their Databricks access, so I can't help with this one. I've let them know you asked.";

type Tags = readonly (readonly string[])[];
type MentionEvent = Readonly<{ id: string; pubkey: string; tags: Tags }>;

/** Whom an agent has told lately, so each person gets one note per conversation in the quiet period. */
export class OutsiderNotes {
  private told = new Map<string, number>();

  constructor(
    private readonly quietMs = OUTSIDER_QUIET_MS,
    private readonly now: () => number = () => Date.now(),
  ) {}

  /** True, and remembered, when this agent hasn't told this person in this conversation lately. */
  take(agent: string, person: string, conversation: string): boolean {
    const now = this.now();
    const key = `${agent}|${person}|${conversation}`;
    const at = this.told.get(key);
    if (at !== undefined && now - at < this.quietMs) return false;
    this.told.set(key, now);
    if (this.told.size > 1000) for (const [old, when] of this.told) if (now - when >= this.quietMs) this.told.delete(old);
    return true;
  }
}

/** The thread a message is in: the root it replies under, or the message itself. */
export function threadRoot(event: MentionEvent): string {
  const tagged = (marker: string) => event.tags.find((tag) => tag[0] === "e" && tag[3] === marker)?.[1];
  return tagged("root") ?? tagged("reply") ?? event.id;
}

/** The note as an unsigned kind 9 message: a reply in the mention's thread, tagging the person and the owner. */
export function outsiderNote(event: MentionEvent, owner: string): Readonly<{ kind: 9; content: string; tags: Tags }> | undefined {
  const channel = event.tags.find((tag) => tag[0] === "h")?.[1];
  if (!channel) return undefined;
  return {
    kind: 9,
    content: OUTSIDER_TEXT,
    tags: [
      ["h", channel],
      ["e", threadRoot(event), "", "reply"],
      ["p", event.pubkey],
      ["p", owner],
    ],
  };
}

/** What the local agent type needs from a delivery to send the note. */
type DeliveryLike = Readonly<{
  trigger: Readonly<{ type: string; event?: MentionEvent }>;
  agent: Readonly<{ pubkey: string; owner: string; publish(event: Readonly<{ kind: number; content: string; tags?: Tags }>): Promise<unknown> }>;
}>;

/**
 * For a delivery the harness kit didn't admit: when it's a mention from
 * someone other than the owner (and not the agent itself), sends the note
 * once per person and conversation in the quiet period. Resolves to whether
 * it sent one; a failure to send is only logged.
 */
export async function noteOutsider(delivery: DeliveryLike, notes: OutsiderNotes): Promise<boolean> {
  const { trigger, agent } = delivery;
  const event = trigger.type === "mention" ? trigger.event : undefined;
  if (!event || event.pubkey === agent.owner || event.pubkey === agent.pubkey) return false;
  const note = outsiderNote(event, agent.owner);
  if (!note) return false;
  const channel = note.tags[0]![1]!;
  if (!notes.take(agent.pubkey, event.pubkey, `${channel}|${threadRoot(event)}`)) return false;
  try {
    await agent.publish(note);
    return true;
  } catch (error) {
    console.warn("A Databricks agent couldn't tell someone it only takes its owner's requests", error);
    return false;
  }
}
