// The community relay over HTTP, as Buzz's own agent processes use it
// (src/buzz-mcp/node.ts in buzz-app): every request is NIP-98 signed by the
// agent and carries the owner's NIP-OA attestation in `x-auth-tag`, which is
// how the relay admits an agent key. Mentions arrive by polling `/query`.
import { createHash, randomUUID } from "node:crypto";
import { type EventTemplate, finalizeEvent, type NostrEvent } from "nostr-tools/pure";

export type Filter = Readonly<Record<string, unknown>>;

const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");

export class HttpRelay {
  readonly base: string;
  /** True once a request has gone through; false after one fails. */
  ready = false;
  private watching = new Set<ReturnType<typeof setTimeout>>();
  private closed = false;

  constructor(
    readonly url: string,
    private readonly secretKey: Uint8Array,
    private readonly authTag: readonly string[],
    private readonly log: (line: string) => void,
  ) {
    this.base = url.replace(/^ws/, "http").replace(/\/+$/, "");
  }

  sign(template: EventTemplate): NostrEvent {
    return finalizeEvent(template, this.secretKey);
  }

  private async post(path: string, body: string): Promise<unknown> {
    const url = `${this.base}${path}`;
    const auth = this.sign({ kind: 27235, created_at: Math.floor(Date.now() / 1000), content: "", tags: [["u", url], ["method", "POST"], ["payload", sha256(body)], ["nonce", randomUUID()]] });
    const response = await fetch(url, {
      method: "POST",
      headers: {
        authorization: `Nostr ${Buffer.from(JSON.stringify(auth)).toString("base64")}`,
        "content-type": "application/json",
        "x-auth-tag": JSON.stringify(this.authTag),
      },
      body,
      signal: AbortSignal.timeout(20_000),
    });
    const text = await response.text();
    if (!response.ok) {
      this.ready = false;
      throw Object.assign(new Error(`${response.status} ${text.slice(0, 300)}`.trim()), { status: response.status });
    }
    this.ready = true;
    return JSON.parse(text);
  }

  /** Publishes as the agent, with the owner's attestation (and `ms` on channel messages, as Buzz does). */
  async publish(template: EventTemplate): Promise<NostrEvent> {
    const tags = template.tags.filter((tag) => tag[0] !== "auth" && tag[0] !== "ms");
    if (tags.some((tag) => tag[0] === "h")) tags.push(["ms", String(Date.now() % 1000)]);
    tags.push([...this.authTag]);
    const event = this.sign({ ...template, tags });
    const reply = (await this.post("/events", JSON.stringify(event))) as { accepted?: boolean; message?: string };
    if (!reply.accepted && !reply.message?.startsWith("duplicate")) throw new Error(reply.message || "The community refused the event.");
    return event;
  }

  async query(filters: readonly Filter[]): Promise<NostrEvent[]> {
    if (!filters.length) return [];
    const events = await this.post("/query", JSON.stringify(filters));
    return Array.isArray(events) ? (events as NostrEvent[]) : [];
  }

  /**
   * Polls `filter` for new events every `intervalMs`, from `since` on, each
   * event once. A refused or failed poll backs off; a rate limit waits as long
   * as the relay asks.
   */
  watch(filter: Filter, since: number, onEvent: (event: NostrEvent) => void, intervalMs = 3000): () => void {
    const seen = new Set<string>();
    let from = since;
    let failures = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const tick = async () => {
      if (this.closed) return;
      let delay = intervalMs;
      try {
        // Overlap a few seconds: events can share a second or arrive late.
        const events = await this.query([{ ...filter, since: from - 5 }]);
        failures = 0;
        for (const event of events.sort((a, b) => a.created_at - b.created_at)) {
          if (seen.has(event.id)) continue;
          seen.add(event.id);
          from = Math.max(from, event.created_at);
          onEvent(event);
        }
        if (seen.size > 2000) for (const id of [...seen].slice(0, 1000)) seen.delete(id);
      } catch (error) {
        const message = (error as Error).message ?? String(error);
        const retry = /retry in (\d+)s/.exec(message);
        delay = retry ? Number(retry[1]) * 1000 : Math.min(60_000, intervalMs * 2 ** ++failures);
        this.log(`poll failed (${message.slice(0, 160)}); next in ${Math.round(delay / 1000)}s`);
      }
      if (!this.closed) {
        timer = setTimeout(() => void tick(), delay);
        this.watching.add(timer);
      }
    };
    void tick();
    return () => {
      if (timer) clearTimeout(timer);
    };
  }

  close() {
    this.closed = true;
    for (const timer of this.watching) clearTimeout(timer);
  }
}
