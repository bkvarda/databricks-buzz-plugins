// The search index in Lakebase, as the app's service principal. Databricks
// Apps gives the app a `postgres` resource (PGHOST, PGDATABASE, PGUSER and
// LAKEBASE_ENDPOINT); its password is a Lakebase credential the principal
// asks for with its own token, refreshed before it expires. The principal
// owns the `buzz_search` schema, which it makes on its first start.
//
// Keyword search uses Lakebase Search's BM25 index (`lakebase_text`) when the
// database has it, and Postgres' own full-text index otherwise.
import pg from "pg";
import type { Workspace } from "./sdk";
import type { ChannelRow, Deletion, Edit, MessageRow, Person } from "./index-events";
import { searchTerms } from "./index-events";

/**
 * Each index app has its own schema, which its service principal owns: a
 * schema left by a deleted app belongs to that app's principal, and another
 * app's couldn't write to it.
 */
export const searchSchema = (app: string) => `buzz_search_${(app || "index").toLowerCase().replace(/[^a-z0-9]+/g, "_")}`.slice(0, 63);

export type SearchMode = "bm25" | "postgres";

export type SearchHit = Readonly<{
  id: string;
  channel: string;
  channelName: string;
  author: string;
  authorName?: string;
  root?: string;
  createdAt: number;
  snippet: string;
}>;

export type IndexStats = Readonly<{ messages: number; channels: number; publicChannels: number; backfilled: number; people: number }>;

export class Lakebase {
  private credential?: { token: string; until: number };
  private pool?: pg.Pool;

  constructor(
    private readonly databricks: Workspace,
    private readonly env: NodeJS.ProcessEnv = process.env,
  ) {}

  /** A Lakebase credential for the service principal, refreshed five minutes before it expires. */
  private async password(): Promise<string> {
    if (this.credential && Date.now() < this.credential.until) return this.credential.token;
    const endpoint = this.env.LAKEBASE_ENDPOINT;
    if (!endpoint) throw new Error("LAKEBASE_ENDPOINT isn't set: the app needs a Lakebase database resource, and `LAKEBASE_ENDPOINT` with `valueFrom: postgres` in app.yaml.");
    const reply = await this.databricks.api<{ token?: string; expire_time?: string }>("/api/2.0/postgres/credentials", { body: { endpoint } });
    if (!reply.token) throw new Error("Lakebase didn't give the app a credential.");
    const expires = reply.expire_time ? Date.parse(reply.expire_time) : Date.now() + 60 * 60_000;
    this.credential = { token: reply.token, until: expires - 5 * 60_000 };
    return reply.token;
  }

  db(): pg.Pool {
    if (this.pool) return this.pool;
    const { PGHOST, PGPORT, PGDATABASE, PGUSER } = this.env;
    if (!PGHOST || !PGDATABASE || !PGUSER) throw new Error("PGHOST, PGDATABASE and PGUSER aren't set: give the app a Lakebase database resource.");
    this.pool = new pg.Pool({ host: PGHOST, port: Number(PGPORT || 5432), database: PGDATABASE, user: PGUSER, password: () => this.password(), ssl: true, max: 4, idleTimeoutMillis: 30_000 });
    this.pool.on("error", () => {});
    return this.pool;
  }

  close() {
    void this.pool?.end();
    this.pool = undefined;
  }
}

export class SearchIndex {
  mode: SearchMode = "postgres";
  /** The database's extensions, and why turning on Lakebase Search failed, for the status page. */
  extensions: string[] = [];
  extensionError?: string;

  constructor(
    private readonly lakebase: Lakebase,
    readonly schema: string,
  ) {}

  private query<T extends pg.QueryResultRow = pg.QueryResultRow>(text: string, values: unknown[] = []) {
    return this.lakebase.db().query<T>(text, values);
  }

  /** Makes the schema, tables and search index if they aren't there, and says which search it uses. */
  async setup(): Promise<SearchMode> {
    await this.query(`CREATE SCHEMA IF NOT EXISTS ${this.schema}`);
    await this.query(`CREATE TABLE IF NOT EXISTS ${this.schema}.channels (
      id text PRIMARY KEY, name text NOT NULL, about text, type text, public boolean NOT NULL, signer text,
      updated_at bigint NOT NULL, backfill_until bigint, backfilled boolean NOT NULL DEFAULT false, problem text)`);
    await this.query(`CREATE TABLE IF NOT EXISTS ${this.schema}.messages (
      id text PRIMARY KEY, channel text NOT NULL, author text NOT NULL, root text, kind int NOT NULL,
      created_at bigint NOT NULL, edited_at bigint, text text NOT NULL,
      tsv tsvector GENERATED ALWAYS AS (to_tsvector('english', text)) STORED)`);
    await this.query(`CREATE INDEX IF NOT EXISTS messages_channel_time ON ${this.schema}.messages (channel, created_at DESC)`);
    await this.query(`CREATE TABLE IF NOT EXISTS ${this.schema}.edits (target text PRIMARY KEY, author text NOT NULL, text text NOT NULL, at bigint NOT NULL)`);
    await this.query(`CREATE TABLE IF NOT EXISTS ${this.schema}.deleted (id text PRIMARY KEY, author text NOT NULL, by_relay boolean NOT NULL)`);
    await this.query(`CREATE TABLE IF NOT EXISTS ${this.schema}.people (pubkey text PRIMARY KEY, name text NOT NULL, updated_at bigint NOT NULL)`);
    // Lakebase Search, if the database has it (or lets the app turn it on: the extensions may be trusted).
    for (const statement of ["CREATE EXTENSION IF NOT EXISTS lakebase_vector CASCADE", "CREATE EXTENSION IF NOT EXISTS lakebase_text"])
      await this.query(statement).catch((error: Error) => (this.extensionError = error.message));
    const extensions = await this.query<{ extname: string }>(`SELECT extname FROM pg_extension ORDER BY extname`);
    this.extensions = extensions.rows.map((row) => row.extname);
    const bm25 = await this.query(`SELECT 1 FROM pg_am WHERE amname = 'lakebase_bm25'`);
    if (bm25.rowCount) {
      await this.query(`CREATE INDEX IF NOT EXISTS messages_bm25 ON ${this.schema}.messages USING lakebase_bm25 (tsv)`);
      this.mode = "bm25";
    } else {
      await this.query(`CREATE INDEX IF NOT EXISTS messages_tsv ON ${this.schema}.messages USING gin (tsv)`);
      this.mode = "postgres";
    }
    return this.mode;
  }

  /** Searches a tiny table of its own, to show the search works before anything is indexed. */
  async selfCheck(): Promise<string> {
    await this.query(`CREATE TABLE IF NOT EXISTS ${this.schema}.selfcheck (id int PRIMARY KEY, text text NOT NULL, tsv tsvector GENERATED ALWAYS AS (to_tsvector('english', text)) STORED)`);
    await this.query(`INSERT INTO ${this.schema}.selfcheck (id, text) VALUES (1, 'the quarterly revenue report is ready'), (2, 'lunch plans for friday') ON CONFLICT (id) DO NOTHING`);
    if (this.mode === "bm25") {
      await this.query(`CREATE INDEX IF NOT EXISTS selfcheck_bm25 ON ${this.schema}.selfcheck USING lakebase_bm25 (tsv)`);
      const found = await this.query<{ id: number }>(`SELECT id FROM ${this.schema}.selfcheck ORDER BY tsv <@> to_bm25query(to_tsvector('english', $1), '${this.schema}.selfcheck_bm25') LIMIT 1`, ["revenue"]);
      return found.rows[0]?.id === 1 ? "ok (Lakebase Search BM25)" : `unexpected result ${JSON.stringify(found.rows)}`;
    }
    const found = await this.query<{ id: number }>(`SELECT id FROM ${this.schema}.selfcheck WHERE tsv @@ plainto_tsquery('english', $1) ORDER BY ts_rank_cd(tsv, plainto_tsquery('english', $1)) DESC LIMIT 1`, ["revenue"]);
    return found.rows[0]?.id === 1 ? "ok (Postgres full-text search)" : `unexpected result ${JSON.stringify(found.rows)}`;
  }

  async channels(rows: readonly ChannelRow[]): Promise<void> {
    if (!rows.length) return;
    await this.query(
      `INSERT INTO ${this.schema}.channels (id, name, about, type, public, signer, updated_at)
       SELECT * FROM unnest($1::text[], $2::text[], $3::text[], $4::text[], $5::boolean[], $6::text[], $7::bigint[])
       ON CONFLICT (id) DO UPDATE SET name = excluded.name, about = excluded.about, type = excluded.type, public = excluded.public, signer = excluded.signer, updated_at = excluded.updated_at
       WHERE excluded.updated_at >= ${this.schema}.channels.updated_at`,
      [rows.map((r) => r.id), rows.map((r) => r.name), rows.map((r) => r.about ?? null), rows.map((r) => r.type ?? null), rows.map((r) => r.public), rows.map((r) => r.signer), rows.map((r) => r.updatedAt)],
    );
  }

  /** Where a channel's history read is up to, and whether it reached the start. */
  async cursor(channel: string): Promise<{ until?: number; done: boolean }> {
    const found = await this.query<{ backfill_until: string | null; backfilled: boolean }>(`SELECT backfill_until, backfilled FROM ${this.schema}.channels WHERE id = $1`, [channel]);
    const row = found.rows[0];
    return { ...(row?.backfill_until && { until: Number(row.backfill_until) }), done: Boolean(row?.backfilled) };
  }

  async setCursor(channel: string, until: number | undefined, done: boolean, problem?: string): Promise<void> {
    await this.query(`UPDATE ${this.schema}.channels SET backfill_until = $2, backfilled = $3, problem = $4 WHERE id = $1`, [channel, until ?? null, done, problem ?? null]);
  }

  /** Adds messages (each once), then applies edits and deletions that arrived before them. */
  async messages(rows: readonly MessageRow[]): Promise<void> {
    if (!rows.length) return;
    const ids = rows.map((r) => r.id);
    await this.query(
      `INSERT INTO ${this.schema}.messages (id, channel, author, root, kind, created_at, text)
       SELECT * FROM unnest($1::text[], $2::text[], $3::text[], $4::text[], $5::int[], $6::bigint[], $7::text[])
       ON CONFLICT (id) DO NOTHING`,
      [ids, rows.map((r) => r.channel), rows.map((r) => r.author), rows.map((r) => r.root ?? null), rows.map((r) => r.kind), rows.map((r) => r.createdAt), rows.map((r) => r.text)],
    );
    await this.query(
      `UPDATE ${this.schema}.messages m SET text = e.text, edited_at = e.at FROM ${this.schema}.edits e
       WHERE m.id = ANY($1) AND e.target = m.id AND e.author = m.author AND (m.edited_at IS NULL OR m.edited_at < e.at)`,
      [ids],
    );
    await this.query(`DELETE FROM ${this.schema}.messages m USING ${this.schema}.deleted d WHERE m.id = ANY($1) AND d.id = m.id AND (d.by_relay OR d.author = m.author)`, [ids]);
  }

  async edit(edit: Edit): Promise<void> {
    await this.query(
      `INSERT INTO ${this.schema}.edits (target, author, text, at) VALUES ($1, $2, $3, $4)
       ON CONFLICT (target) DO UPDATE SET author = excluded.author, text = excluded.text, at = excluded.at WHERE excluded.at > ${this.schema}.edits.at`,
      [edit.target, edit.author, edit.text, edit.at],
    );
    await this.query(`UPDATE ${this.schema}.messages SET text = $3, edited_at = $4 WHERE id = $1 AND author = $2 AND (edited_at IS NULL OR edited_at < $4)`, [edit.target, edit.author, edit.text, edit.at]);
  }

  async deletion(deletion: Deletion): Promise<void> {
    await this.query(
      `INSERT INTO ${this.schema}.deleted (id, author, by_relay) SELECT unnest($1::text[]), $2, $3 ON CONFLICT (id) DO NOTHING`,
      [deletion.targets, deletion.author, deletion.byRelay],
    );
    await this.query(`DELETE FROM ${this.schema}.messages WHERE id = ANY($1) AND ($3 OR author = $2)`, [deletion.targets, deletion.author, deletion.byRelay]);
  }

  async people(rows: readonly Person[]): Promise<void> {
    if (!rows.length) return;
    await this.query(
      `INSERT INTO ${this.schema}.people (pubkey, name, updated_at) SELECT * FROM unnest($1::text[], $2::text[], $3::bigint[])
       ON CONFLICT (pubkey) DO UPDATE SET name = excluded.name, updated_at = excluded.updated_at WHERE excluded.updated_at > ${this.schema}.people.updated_at`,
      [rows.map((r) => r.pubkey), rows.map((r) => r.name), rows.map((r) => r.updatedAt)],
    );
  }

  /** Of these authors, the ones without a name yet. */
  async unnamed(authors: readonly string[]): Promise<string[]> {
    if (!authors.length) return [];
    const found = await this.query<{ pubkey: string }>(`SELECT pubkey FROM ${this.schema}.people WHERE pubkey = ANY($1)`, [authors]);
    const known = new Set(found.rows.map((row) => row.pubkey));
    return authors.filter((author) => !known.has(author));
  }

  /** The best matches in public channels: by BM25 with Lakebase Search, else Postgres' own ranking. */
  async search(query: string, limit = 20): Promise<SearchHit[]> {
    const terms = searchTerms(query);
    if (!terms) return [];
    const rank =
      this.mode === "bm25"
        ? { score: `m.tsv <@> to_bm25query(to_tsvector('english', $1), '${this.schema}.messages_bm25')`, order: "ASC" }
        : { score: `ts_rank_cd(m.tsv, plainto_tsquery('english', $1))`, order: "DESC" };
    const found = await this.query<{ id: string; channel: string; channel_name: string; author: string; author_name: string | null; root: string | null; created_at: string; snippet: string }>(
      `SELECT m.id, m.channel, c.name AS channel_name, m.author, p.name AS author_name, m.root, m.created_at,
         ts_headline('english', m.text, plainto_tsquery('english', $1), 'MaxFragments=1,MaxWords=30,MinWords=10,StartSel=**,StopSel=**') AS snippet,
         ${rank.score} AS score
       FROM ${this.schema}.messages m
       JOIN ${this.schema}.channels c ON c.id = m.channel AND c.public
       LEFT JOIN ${this.schema}.people p ON p.pubkey = m.author
       WHERE m.tsv @@ plainto_tsquery('english', $1)
       ORDER BY score ${rank.order}, m.created_at DESC
       LIMIT $2`,
      [terms, Math.max(1, Math.min(50, limit))],
    );
    return found.rows.map((row) => ({
      id: row.id,
      channel: row.channel,
      channelName: row.channel_name,
      author: row.author,
      ...(row.author_name && { authorName: row.author_name }),
      ...(row.root && { root: row.root }),
      createdAt: Number(row.created_at),
      snippet: row.snippet,
    }));
  }

  async stats(): Promise<IndexStats> {
    const found = await this.query<Record<string, string>>(`SELECT
      (SELECT count(*) FROM ${this.schema}.messages) AS messages,
      (SELECT count(*) FROM ${this.schema}.channels) AS channels,
      (SELECT count(*) FROM ${this.schema}.channels WHERE public) AS public_channels,
      (SELECT count(*) FROM ${this.schema}.channels WHERE public AND backfilled) AS backfilled,
      (SELECT count(*) FROM ${this.schema}.people) AS people`);
    const row = found.rows[0] ?? {};
    return { messages: Number(row.messages ?? 0), channels: Number(row.channels ?? 0), publicChannels: Number(row.public_channels ?? 0), backfilled: Number(row.backfilled ?? 0), people: Number(row.people ?? 0) };
  }
}
