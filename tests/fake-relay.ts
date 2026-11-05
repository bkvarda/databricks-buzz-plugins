// A minimal Nostr relay for tests, in Buzz's shapes: HTTP `/events` and
// `/query` with NIP-98 signed requests and the owner's attestation in
// `x-auth-tag` (as agents use it), plus WebSocket with NIP-42 sign-in.
import { createHash, randomBytes } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { Socket } from "node:net";
import { type NostrEvent, verifyEvent } from "nostr-tools/pure";

type Filter = Record<string, unknown>;
type Client = { socket: Socket; challenge: string; authed?: string; subs: Map<string, Filter[]> };

function readFrame(buffer: Buffer): { opcode: number; payload: Buffer; length: number } | undefined {
  if (buffer.length < 2) return undefined;
  const opcode = buffer[0]! & 0x0f;
  const masked = (buffer[1]! & 0x80) !== 0;
  let length = buffer[1]! & 0x7f;
  let offset = 2;
  if (length === 126) {
    if (buffer.length < 4) return undefined;
    length = buffer.readUInt16BE(2);
    offset = 4;
  } else if (length === 127) {
    if (buffer.length < 10) return undefined;
    length = Number(buffer.readBigUInt64BE(2));
    offset = 10;
  }
  const maskAt = offset;
  if (masked) offset += 4;
  if (buffer.length < offset + length) return undefined;
  const payload = Buffer.from(buffer.subarray(offset, offset + length));
  if (masked) for (let i = 0; i < payload.length; i++) payload[i]! ^= buffer[maskAt + (i % 4)]!;
  return { opcode, payload, length: offset + length };
}

function encodeFrame(text: string): Buffer {
  const payload = Buffer.from(text);
  let header: Buffer;
  if (payload.length < 126) header = Buffer.from([0x81, payload.length]);
  else if (payload.length < 65_536) {
    header = Buffer.alloc(4);
    header[0] = 0x81;
    header[1] = 126;
    header.writeUInt16BE(payload.length, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x81;
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(payload.length), 2);
  }
  return Buffer.concat([header, payload]);
}

export function matches(event: NostrEvent, filter: Filter): boolean {
  for (const [key, value] of Object.entries(filter)) {
    if (key === "limit") continue;
    if (key === "ids" && !(value as string[]).includes(event.id)) return false;
    if (key === "authors" && !(value as string[]).includes(event.pubkey)) return false;
    if (key === "kinds" && !(value as number[]).includes(event.kind)) return false;
    if (key === "since" && event.created_at < (value as number)) return false;
    if (key === "until" && event.created_at > (value as number)) return false;
    if (key.startsWith("#")) {
      const name = key.slice(1);
      if (!event.tags.some((tag) => tag[0] === name && (value as string[]).includes(tag[1]!))) return false;
    }
  }
  return true;
}

export type FakeRelay = Readonly<{
  url: string;
  events: NostrEvent[];
  /** Stores an event as if another client published it, and delivers it live. */
  insert(event: NostrEvent): void;
  /** Resolves with the first stored event matching `test`, or rejects after `timeoutMs`. */
  waitFor(test: (event: NostrEvent) => boolean, timeoutMs?: number): Promise<NostrEvent>;
  /** Pubkeys that signed a request (NIP-98) or signed in (NIP-42). */
  signedIn: Set<string>;
  /** The `x-auth-tag` attestations HTTP requests carried. */
  authTags: string[][];
  close(): Promise<void>;
}>;

export async function fakeRelay(): Promise<FakeRelay> {
  const events: NostrEvent[] = [];
  const clients = new Set<Client>();
  const signedIn = new Set<string>();
  const authTags: string[][] = [];
  const server: Server = createServer((request, response) => {
    let body = "";
    request.on("data", (chunk: Buffer) => (body += chunk));
    request.on("end", () => {
      const reply = (status: number, value: unknown) => {
        response.writeHead(status, { "content-type": "application/json" });
        response.end(JSON.stringify(value));
      };
      const header = String(request.headers.authorization ?? "");
      let auth: NostrEvent | undefined;
      try {
        auth = header.startsWith("Nostr ") ? (JSON.parse(Buffer.from(header.slice(6), "base64").toString("utf8")) as NostrEvent) : undefined;
      } catch {}
      const tag = (name: string) => auth?.tags.find((t) => t[0] === name)?.[1];
      const signed =
        auth &&
        verifyEvent(auth) &&
        auth.kind === 27235 &&
        tag("u") === `http://${request.headers.host}${request.url}` &&
        tag("method") === "POST" &&
        tag("payload") === createHash("sha256").update(body).digest("hex");
      if (!signed) return reply(401, { accepted: false, message: "auth-required: bad NIP-98 signature" });
      const attestation = request.headers["x-auth-tag"];
      if (typeof attestation !== "string") return reply(403, { accepted: false, message: "restricted: not a relay member" });
      signedIn.add(auth!.pubkey);
      authTags.push(JSON.parse(attestation) as string[]);
      if (request.url === "/events") {
        const event = JSON.parse(body) as NostrEvent;
        if (!verifyEvent(event)) return reply(400, { accepted: false, message: "invalid: bad signature" });
        events.push(event);
        deliver(event);
        return reply(200, { accepted: true, event_id: event.id });
      }
      if (request.url === "/query") {
        const found: NostrEvent[] = [];
        for (const filter of JSON.parse(body) as Filter[]) {
          const matching = events.filter((event) => matches(event, filter)).sort((a, b) => b.created_at - a.created_at);
          found.push(...matching.slice(0, typeof filter.limit === "number" ? filter.limit : undefined));
        }
        return reply(200, found);
      }
      reply(404, { message: "not found" });
    });
  });
  let url = "";
  const send = (client: Client, message: unknown[]) => client.socket.writable && client.socket.write(encodeFrame(JSON.stringify(message)));
  const deliver = (event: NostrEvent) => {
    for (const client of clients) for (const [id, filters] of client.subs) if (filters.some((filter) => matches(event, filter))) send(client, ["EVENT", id, event]);
  };
  const handle = (client: Client, text: string) => {
    let message: unknown[];
    try {
      message = JSON.parse(text);
    } catch {
      return;
    }
    const [type] = message as [string];
    if (type === "AUTH") {
      const event = message[1] as NostrEvent;
      const ok =
        verifyEvent(event) &&
        event.kind === 22242 &&
        event.tags.some((t) => t[0] === "challenge" && t[1] === client.challenge) &&
        event.tags.some((t) => t[0] === "relay" && t[1] === url);
      if (ok) {
        client.authed = event.pubkey;
        signedIn.add(event.pubkey);
      }
      send(client, ["OK", event.id, ok, ok ? "" : "auth-required: bad sign-in"]);
    } else if (type === "EVENT") {
      const event = message[1] as NostrEvent;
      if (!client.authed) return send(client, ["OK", event.id, false, "auth-required: sign in first"]);
      if (!verifyEvent(event)) return send(client, ["OK", event.id, false, "invalid: bad signature"]);
      events.push(event);
      send(client, ["OK", event.id, true, ""]);
      deliver(event);
    } else if (type === "REQ") {
      const [, id, ...filters] = message as [string, string, ...Filter[]];
      if (!client.authed) return send(client, ["CLOSED", id, "auth-required: sign in first"]);
      client.subs.set(id, filters);
      for (const filter of filters) {
        const found = events.filter((event) => matches(event, filter)).sort((a, b) => b.created_at - a.created_at);
        for (const event of found.slice(0, typeof filter.limit === "number" ? filter.limit : undefined)) send(client, ["EVENT", id, event]);
      }
      send(client, ["EOSE", id]);
    } else if (type === "CLOSE") {
      client.subs.delete(String(message[1]));
    }
  };
  server.on("upgrade", (request, socket: Socket) => {
    const accept = createHash("sha1").update(`${request.headers["sec-websocket-key"]}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest("base64");
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
    const client: Client = { socket, challenge: randomBytes(16).toString("hex"), subs: new Map() };
    clients.add(client);
    send(client, ["AUTH", client.challenge]);
    let buffer = Buffer.alloc(0);
    socket.on("data", (chunk: Buffer) => {
      buffer = Buffer.concat([buffer, chunk]);
      for (;;) {
        const frame = readFrame(buffer);
        if (!frame) break;
        buffer = buffer.subarray(frame.length);
        if (frame.opcode === 8) return void socket.end();
        if (frame.opcode === 1) handle(client, frame.payload.toString("utf8"));
      }
    });
    const drop = () => clients.delete(client);
    socket.on("close", drop);
    socket.on("error", drop);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  url = `ws://127.0.0.1:${typeof address === "object" && address ? address.port : 0}`;
  return {
    url,
    events,
    signedIn,
    authTags,
    insert(event) {
      events.push(event);
      deliver(event);
    },
    waitFor(test, timeoutMs = 10_000) {
      return new Promise((resolve, reject) => {
        const started = Date.now();
        const look = () => {
          const found = events.find(test);
          if (found) return resolve(found);
          if (Date.now() - started > timeoutMs) return reject(new Error("timed out waiting for an event"));
          setTimeout(look, 50);
        };
        look();
      });
    },
    close: () =>
      new Promise<void>((resolve) => {
        for (const client of clients) client.socket.destroy();
        server.close(() => resolve());
      }),
  };
}
