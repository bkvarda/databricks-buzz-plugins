// While a hosted agent works on a mention it shows as typing there, to
// everyone in the channel on every device: Buzz on a phone, or a teammate's
// desktop, only shows an agent working while it types. This is what Buzz's
// own agents send (src/features/agents/typing.ts in buzz-app): a kind 20002
// event, signed as the agent, every 3 seconds; clients show it for 8. Clients
// drop it when the agent replies, or a few seconds after the last pulse.
import type { EventTemplate } from "nostr-tools/pure";
import type { Conversation } from "./buzz";

/** Clients show a pulse for 8 s, so one every 3 s keeps it steady. */
export const TYPING_PULSE_MS = 3_000;
/** A turn that never settles stops looking busy after this long. */
const LONGEST_MS = 30 * 60_000;
/** Refused pulses in a row that mean the community won't take them. */
const FAILURES = 3;

/** Typing where the reply to `event` goes: its thread, or the channel itself for a Solo chat. */
export function typingTemplate(conversation: Conversation, event: Readonly<{ id: string }>): EventTemplate {
  const root = conversation.root;
  return {
    kind: 20002,
    created_at: Math.floor(Date.now() / 1000),
    content: "",
    tags: [["h", conversation.channel], ...(conversation.topLevel ? [] : [...(root === event.id ? [] : [["e", root, "", "root"]]), ["e", event.id, "", "reply"]])],
  };
}

/** Typing pulses by conversation, each shared by the turns typing there. */
export class Typing {
  private readonly pulses = new Map<string, { turns: number; stop: () => void }>();

  constructor(
    private readonly publish: (template: EventTemplate) => Promise<unknown>,
    private readonly log: (line: string) => void,
  ) {}

  /** Starts typing for a turn; the returned function ends it (the pulse stops once no turn there types). */
  start(conversation: Conversation, event: Readonly<{ id: string }>): () => void {
    const key = conversation.topLevel ? conversation.channel : conversation.key;
    let shared = this.pulses.get(key);
    if (!shared) {
      const created = { turns: 0, stop: () => {} };
      created.stop = this.pulse(conversation, event, () => {
        if (this.pulses.get(key) === created) this.pulses.delete(key);
      });
      this.pulses.set(key, created);
      shared = created;
    }
    const joined = shared;
    joined.turns++;
    let ended = false;
    return () => {
      if (ended) return;
      ended = true;
      if (--joined.turns === 0) joined.stop();
    };
  }

  private pulse(conversation: Conversation, event: Readonly<{ id: string }>, ended: () => void): () => void {
    const started = Date.now();
    let sending = false;
    let failed = 0;
    const stop = () => {
      clearInterval(timer);
      ended();
    };
    const send = () => {
      if (Date.now() - started >= LONGEST_MS) return stop();
      // A slow community gets the next pulse once this one is answered.
      if (sending) return;
      sending = true;
      this.publish(typingTemplate(conversation, event)).then(
        () => {
          sending = false;
          failed = 0;
        },
        (error: Error) => {
          sending = false;
          // Typing never breaks the turn it decorates. A blip skips a pulse; a community that keeps refusing gets no more.
          if (++failed < FAILURES) return;
          stop();
          this.log(`stopped showing typing in ${conversation.key}: ${error.message}`);
        },
      );
    };
    const timer = setInterval(send, TYPING_PULSE_MS);
    timer.unref?.();
    send();
    return stop;
  }
}
