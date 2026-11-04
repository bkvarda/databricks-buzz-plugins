// Incremental Server-Sent Events parser (WHATWG event-stream format).
// Feed it text chunks as they arrive; it calls `onEvent` once per event.

export type SseEvent = Readonly<{ event: string; data: string; id?: string }>;

export class SseParser {
  private buffer = "";
  private data: string[] = [];
  private event = "";
  private id: string | undefined;

  constructor(private readonly onEvent: (event: SseEvent) => void) {}

  push(chunk: string): void {
    this.buffer += chunk;
    let index = this.buffer.search(/\r\n|\r|\n/);
    while (index !== -1) {
      const line = this.buffer.slice(0, index);
      const newline = this.buffer.startsWith("\r\n", index) ? 2 : 1;
      this.buffer = this.buffer.slice(index + newline);
      this.line(line);
      index = this.buffer.search(/\r\n|\r|\n/);
    }
  }

  /** Dispatches a final event that was not followed by a blank line. */
  end(): void {
    if (this.buffer) this.line(this.buffer);
    this.buffer = "";
    this.line("");
  }

  private line(line: string): void {
    if (line === "") {
      if (this.data.length) {
        this.onEvent({
          event: this.event || "message",
          data: this.data.join("\n"),
          ...(this.id !== undefined && { id: this.id }),
        });
      }
      this.data = [];
      this.event = "";
      return;
    }
    if (line.startsWith(":")) return;
    const colon = line.indexOf(":");
    const field = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? "" : line.slice(colon + 1);
    if (value.startsWith(" ")) value = value.slice(1);
    if (field === "data") this.data.push(value);
    else if (field === "event") this.event = value;
    else if (field === "id") this.id = value;
  }
}

/** Parses a complete event-stream body into its events. */
export function parseSse(body: string): SseEvent[] {
  const events: SseEvent[] = [];
  const parser = new SseParser((event) => events.push(event));
  parser.push(body);
  parser.end();
  return events;
}
