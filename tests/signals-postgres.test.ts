// Overlapping writes on a real PostgreSQL (PGlite runs one statement at a time, so it can't show lock waits or deadlocks).
// Runs when SIGNALS_TEST_PG is a connection string to a database it may create schemas in, e.g.
// SIGNALS_TEST_PG=postgres://postgres@localhost:5432/postgres npx vitest run tests/signals-postgres.test.ts
import pg from "pg";
import { afterAll, describe, expect, it } from "vitest";
import type { SignalsConfig } from "../plugins/signals/app/model";
import { type Db, SignalsStore } from "../plugins/signals/app/store";

const URL = process.env.SIGNALS_TEST_PG;

describe.skipIf(!URL)("signals on PostgreSQL: overlapping reply decisions", () => {
  const pool = new pg.Pool({ connectionString: URL, max: 10 });
  afterAll(() => pool.end());
  const db: Db = { query: async (text, values) => ({ rows: (await pool.query(text, values)).rows }) };
  const config: SignalsConfig = {
    version: 1,
    default_channel: "triage",
    rules: [{ id: "mail", sources: ["gmail"], customer_actor: "@globex\\.io$", action: "task", group_by: "group_key", done_when: { by_owner: true } }],
  };

  const prepare = async (schema: string) => {
    await pool.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    const store = new SignalsStore(db, schema);
    await store.setup();
    await store.setSource("alice@x.com", "gmail", true);
    await store.ingest("alice@x.com", [{ source: "gmail", external_id: "seed" }], config);
    await store.ingest("alice@x.com", [{ source: "gmail", external_id: "c1", actor: "ann@globex.io", group_key: "th1", occurred_at: 1795000100 }], config);
    const [task] = await store.tasks({});
    // A saved reply not decided yet (as one a crashed run left).
    const sent = await store.record("alice@x.com", { source: "gmail", external_id: "r1", actor: "alice@x.com", group_key: "th1", occurred_at: 1795000200 });
    await pool.query(`INSERT INTO ${schema}.replies (group_key, event_id, owner, source, at, seen_at, at_us) VALUES ('mail|th1', $1, 'alice@x.com', 'gmail', 1795000200, 1, 1795000200000000)`, [sent.id]);
    const reply = { group: "mail|th1", event: sent.id, owner: "alice@x.com", source: "gmail", title: null, url: null, at: 1795000200, micros: 1795000200_000000 };
    return { store, task: task!, reply };
  };
  const waitFor = async (sql: string, n: number) => {
    for (let i = 0; i < 200; i++) {
      if ((await pool.query(sql)).rows[0].n === n) return;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    throw new Error(`never got ${n}: ${sql}`);
  };
  const waiting = async (count: number) => {
    for (let i = 0; i < 200; i++) {
      const found = await pool.query(`SELECT count(*)::int AS n FROM pg_stat_activity WHERE wait_event_type = 'Lock' AND query LIKE '%handled it themselves%' OR (wait_event_type = 'Lock' AND query LIKE '%WITH kept AS%')`);
      if (found.rows[0].n >= count) return;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    throw new Error(`fewer than ${count} statements waiting`);
  };

  it("decides the same reply twice at once without a deadlock: one closes it, the other finds it done", async () => {
    const { store, task, reply } = await prepare("signals_pg_overlap");
    const holder = await pool.connect();
    try {
      await holder.query("BEGIN");
      await holder.query(`SELECT 1 FROM signals_pg_overlap.tasks WHERE id = $1 FOR UPDATE`, [task.id]);
      const first = store.handled(task.id, reply);
      const second = store.handled(task.id, reply);
      await waiting(2);
      await holder.query("COMMIT");
      const results = await Promise.allSettled([first, second]);
      expect(results.map((result) => result.status)).toEqual(["fulfilled", "fulfilled"]);
      expect(results.filter((result) => result.status === "fulfilled" && result.value).length).toBe(1);
    } finally {
      holder.release();
    }
    expect((await store.task(task.id))!.status).toBe("done");
    const mark = await pool.query(`SELECT applied_at IS NOT NULL AS applied, closed_task FROM signals_pg_overlap.replies`);
    expect(mark.rows).toEqual([{ applied: true, closed_task: String(task.id) }]);
  });

  it("closes nothing when Forget deletes the reply while its decision waits", async () => {
    const { store, task, reply } = await prepare("signals_pg_forget");
    const holder = await pool.connect();
    try {
      await holder.query("BEGIN");
      await holder.query(`SELECT 1 FROM signals_pg_forget.tasks WHERE id = $1 FOR UPDATE`, [task.id]);
      // Forget deletes the events and replies, then waits on the task row too, to work out its times again.
      const forgot = store.setSource("alice@x.com", "gmail", false, undefined, true);
      await waitFor(`SELECT count(*)::int AS n FROM signals_pg_forget.replies`, 0);
      const decided = store.handled(task.id, reply);
      await holder.query("COMMIT");
      expect(await decided).toBeUndefined();
      await forgot;
    } finally {
      holder.release();
    }
    expect((await store.task(task.id))!.status).toBe("open");
  });

  it("works out a task's times from the rows left when two Forgets overlap", async () => {
    const schema = "signals_pg_forget_two";
    await pool.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    const store = new SignalsStore(db, schema);
    await store.setup();
    for (const user of ["alice@x.com", "bob@x.com"]) {
      await store.setSource(user, "gmail", true);
      await store.ingest(user, [{ source: "gmail", external_id: "seed" }], config);
    }
    await store.ingest("alice@x.com", [{ source: "gmail", external_id: "c1", actor: "ann@globex.io", group_key: "th1", occurred_at: 1795000100 }], config);
    const [task] = await store.tasks({});
    // Alice replies at t+200 and Bob at t+300: done, answered at t+300.
    await store.ingest("alice@x.com", [{ source: "gmail", external_id: "r1", actor: "alice@x.com", group_key: "th1", occurred_at: 1795000200 }], config);
    await store.ingest("bob@x.com", [{ source: "gmail", external_id: "r2", actor: "bob@x.com", group_key: "th1", occurred_at: 1795000300 }], config);
    expect((await store.task(task!.id))!.status).toBe("done");
    const holder = await pool.connect();
    try {
      await holder.query("BEGIN");
      await holder.query(`SELECT 1 FROM ${schema}.tasks WHERE id = $1 FOR UPDATE`, [task!.id]);
      // Bob's Forget reads the task's rows while Alice's reply is still there (answered at t+200), then waits for the task.
      // Alice's then deletes hers and reads nothing left, and waits behind it: it must not keep Bob's t+200.
      const bob = store.setSource("bob@x.com", "gmail", false, undefined, true);
      await waitFor(`SELECT count(*)::int AS n FROM pg_stat_activity WHERE wait_event_type = 'Lock' AND query LIKE '%customer_was%'`, 1);
      const alice = store.setSource("alice@x.com", "gmail", false, undefined, true);
      await waitFor(`SELECT count(*)::int AS n FROM pg_stat_activity WHERE wait_event_type = 'Lock' AND query LIKE '%customer_was%'`, 2);
      await holder.query("COMMIT");
      await Promise.all([alice, bob]);
    } finally {
      holder.release();
    }
    expect((await pool.query(`SELECT count(*)::int AS n FROM ${schema}.replies`)).rows[0].n).toBe(0);
    expect((await pool.query(`SELECT customer_us, answered_us FROM ${schema}.tasks WHERE id = $1`, [task!.id])).rows[0]).toEqual({ customer_us: null, answered_us: null });
    // Nothing of either reply is left: a customer message, even an old one, opens it again.
    await store.setSource("carol@x.com", "gmail", true);
    await store.ingest("carol@x.com", [{ source: "gmail", external_id: "seed" }], config);
    await store.ingest("carol@x.com", [{ source: "gmail", external_id: "c2", actor: "ann@globex.io", group_key: "th1", occurred_at: 1795000150 }], config);
    expect((await store.task(task!.id))!.status).toBe("open");
  });
});

describe.skipIf(!URL)("signals on PostgreSQL: meeting action items", () => {
  const pool = new pg.Pool({ connectionString: URL, max: 10 });
  afterAll(() => pool.end());
  const db: Db = { query: async (text, values) => ({ rows: (await pool.query(text, values)).rows }) };
  const config: SignalsConfig = {
    version: 1,
    default_channel: "chan",
    rules: [{ id: "meeting-notes", sources: ["google_drive"], when: { title: "Notes by Gemini" }, account_named_in: "title", action: "task", title: "Follow up: {title}", group_by: "group_key", action_items: {} }],
    accounts: [{ name: "Globex", domains: ["globex.io"] }],
  };

  it("lists the task another post's insert opened while this one waited on it", async () => {
    const schema = "signals_pg_items";
    await pool.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    const store = new SignalsStore(db, schema);
    await store.setup();
    for (const source of ["google_drive", "google_calendar"]) {
      await store.setSource("alice@x.com", source, true);
      await store.ingest("alice@x.com", [{ source, external_id: `seed-${source}` }], config);
    }
    await store.ingest("alice@x.com", [{ source: "google_calendar", external_id: "evt1", payload: { attendees: [{ email: "alice@x.com" }, { email: "ann.lee@x.com", displayName: "Ann Lee" }, { email: "jane@globex.io" }] } }], config);
    const meeting = `https://calendar.google.com/calendar/event?eid=${Buffer.from("evt1 x@x.com").toString("base64url")}`;
    const notes = "Next steps\n[Ann Lee] Send pricing: Send the sheet.\nDetails";
    // Another run is inserting the same item's task and hasn't committed yet.
    const holder = await pool.connect();
    try {
      await holder.query("BEGIN");
      const held = await holder.query(
        `INSERT INTO ${schema}.tasks (rule_id, group_key, title, created_by, created_at, updated_at, last_event_at) VALUES ('meeting-notes/action-item', $1, 'Action: Send pricing: Send the sheet.', 'alice@x.com', 1, 1, 1) RETURNING id`,
        ["meeting-notes/action-item|d1|send pricing|send the sheet"],
      );
      const posting = store.ingest("alice@x.com", [{ source: "google_drive", external_id: "d1:v1", group_key: "d1", title: "Globex QBR - Notes by Gemini", occurred_at: "2026-11-17T10:00:00Z", payload: { notes, meeting } }], config);
      for (let i = 0; i < 200; i++) {
        const found = await pool.query(`SELECT count(*)::int AS n FROM pg_stat_activity WHERE wait_event_type = 'Lock' AND query LIKE '%ON CONFLICT (group_key) DO NOTHING%'`);
        if (found.rows[0].n >= 1) break;
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      await holder.query("COMMIT");
      const result = await posting;
      expect(result.errors).toEqual([]);
      const id = Number(held.rows[0].id);
      const followUp = (await store.tasks({})).find((task) => task.rule_id === "meeting-notes")!;
      expect(followUp.checklist).toContain(`- Task ${id}: [Ann Lee] Send pricing: Send the sheet.`);
      // It didn't open it, so it isn't posted as new from here.
      expect(result.created.map((task) => task.id)).toEqual([followUp.id]);
    } finally {
      holder.release();
    }
  });

  it("holds an inbox post past its tenth failed save, its Drive cursor waiting, and saves it before the cursor moves once the write works", async () => {
    const schema = "signals_pg_inbox";
    await pool.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    const { Hub, INBOX_TRIES, INBOX_HOLD_SECONDS } = await import("../plugins/signals/app/hub");
    let failing = false;
    // Every write, in order, once the write works: to check the event is saved before the cursor moves.
    const writes: string[] = [];
    const flaky: Db = {
      query: async (text, values) => {
        if (text.includes(`INSERT INTO ${schema}.events`) && (values as unknown[] | undefined)?.[2] === "d1:v1") {
          if (failing) throw new Error("write failed");
          writes.push("event");
        }
        if (text.includes(`UPDATE ${schema}.sources SET cursor`)) writes.push("cursor");
        return { rows: (await pool.query(text, values)).rows };
      },
    };
    const store = new SignalsStore(flaky, schema);
    await store.setup();
    const hub = new Hub(store, undefined, { defaultConfig: config });
    for (const source of ["google_drive", "google_calendar"]) {
      await store.setSource("alice@x.com", source, true);
      await store.ingest("alice@x.com", [{ source, external_id: `seed-${source}` }], config);
    }
    await store.setCursor("alice@x.com", "google_drive", "c0");
    writes.length = 0;
    const notes = { source: "google_drive", external_id: "d1:v1", group_key: "d1", title: "Globex QBR - Notes by Gemini", occurred_at: "2026-11-17T10:00:00Z", payload: { notes: "Next steps\n[Ann Lee] Send pricing: Send the sheet.\nDetails" } };
    // As the Lakebase poller posts them: the events, then its cursor.
    await pool.query(`INSERT INTO ${schema}.inbox (owner, kind, body) VALUES ('alice@x.com', 'events', $1), ('alice@x.com', 'cursor', $2)`, [JSON.stringify({ events: [notes] }), JSON.stringify({ source: "google_drive", cursor: "c1" })]);
    const drive = async () => (await pool.query(`SELECT cursor, last_error FROM ${schema}.sources WHERE owner = 'alice@x.com' AND source = 'google_drive'`)).rows[0];
    const saved = async () => (await pool.query(`SELECT count(*)::int AS n FROM ${schema}.events WHERE external_id = 'd1:v1'`)).rows[0].n;
    failing = true;
    for (let n = 1; n <= INBOX_TRIES + 2; n++) {
      expect(await hub.drain()).toEqual({ handled: 0, failed: 1 });
      expect((await drive()).cursor).toBe("c0");
      expect(await saved()).toBe(0);
    }
    expect((await drive()).last_error).toContain(`failed to save ${INBOX_TRIES} times`);
    expect((await pool.query(`SELECT kind, tries, done_at FROM ${schema}.inbox ORDER BY id`)).rows).toEqual([{ kind: "events", tries: INBOX_TRIES, done_at: null }, { kind: "cursor", tries: 0, done_at: null }]);
    // The write works, but the hold isn't past: still held, the cursor still waiting.
    failing = false;
    expect(await hub.drain()).toEqual({ handled: 0, failed: 1 });
    expect(await drive()).toMatchObject({ cursor: "c0" });
    expect(writes).toEqual([]);
    // Past the hold: the event is saved, then the cursor moves.
    await pool.query(`UPDATE ${schema}.inbox SET tried_at = tried_at - $1`, [INBOX_HOLD_SECONDS]);
    expect(await hub.drain()).toEqual({ handled: 2, failed: 0 });
    expect(writes).toEqual(["event", "cursor"]);
    expect(await saved()).toBe(1);
    expect(await drive()).toEqual({ cursor: "c1", last_error: null });
    expect((await pool.query(`SELECT count(*)::int AS n FROM ${schema}.inbox WHERE done_at IS NULL`)).rows[0].n).toBe(0);
  });
  it("opens no follow-up for a notes version a newer one replaces while its follow-up insert waits on the event's row", async () => {
    const schema = "signals_pg_items_latest";
    await pool.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    const holder = await pool.connect();
    let held = false;
    let committed: Promise<void> | undefined;
    // Right before the follow-up's insert: another run records a newer version of the notes and hasn't committed yet.
    const racing: Db = {
      query: async (text, values) => {
        if (!held && text.includes(`INSERT INTO ${schema}.tasks`)) {
          held = true;
          await holder.query("BEGIN");
          await holder.query(`UPDATE ${schema}.events SET versions = versions + 1 WHERE external_id = 'd1'`);
          committed = (async () => {
            for (let i = 0; i < 200; i++) {
              const found = await pool.query(`SELECT count(*)::int AS n FROM pg_stat_activity WHERE wait_event_type = 'Lock' AND query LIKE '%INSERT INTO ${schema}.tasks%'`);
              if (found.rows[0].n >= 1) break;
              await new Promise((resolve) => setTimeout(resolve, 25));
            }
            await holder.query("COMMIT");
          })();
        }
        return { rows: (await pool.query(text, values)).rows };
      },
    };
    const store = new SignalsStore(racing, schema);
    await store.setup();
    const classified: SignalsConfig = { version: 1, default_channel: "triage", rules: [{ id: "meeting-notes", sources: ["google_drive"], when: { title: "Notes by Gemini" }, action: "task", title: "Follow up: {title}", group_by: "group_key", action_items: {}, classify: { question: "Worth a follow-up?", min: 0.5 } }] };
    await store.setSource("alice@x.com", "google_drive", true);
    await store.ingest("alice@x.com", [{ source: "google_drive", external_id: "seed" }], classified);
    try {
      const result = await store.ingest("alice@x.com", [{ source: "google_drive", external_id: "d1", group_key: "d1", title: "Globex QBR - Notes by Gemini", occurred_at: "2026-11-17T10:00:00Z", payload: { notes: "Next steps\n[Ann Lee] Send pricing: Send the sheet.\nDetails" } }], classified, async () => 0.9);
      await committed;
      expect(held).toBe(true);
      expect(result.errors).toEqual([]);
      expect(result.created).toEqual([]);
      expect(await store.tasks({})).toEqual([]);
    } finally {
      holder.release();
    }
  });
  it("opens no stale follow-up from the sweep when a newer revision of the document, under its own id, commits while its insert waits", async () => {
    const schema = "signals_pg_items_revisions";
    await pool.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    const holder = await pool.connect();
    let failOpen = true;
    let sweeping = false;
    let held = false;
    let committed: Promise<void> | undefined;
    const notesRule: SignalsConfig = { version: 1, default_channel: "triage", rules: [{ id: "meeting-notes", sources: ["google_drive"], when: { title: "Notes by Gemini" }, action: "task", title: "Follow up: {title}", group_by: "group_key", action_items: {} }] };
    const racing: Db = {
      query: async (text, values) => {
        if (text.includes(`INSERT INTO ${schema}.tasks`)) {
          if (failOpen) {
            failOpen = false;
            throw new Error("write failed");
          }
          // The sweep's retry of revision 1: another run saves revision 2 (its own id, as the Drive mapping gives) and hasn't committed yet.
          if (sweeping && !held) {
            held = true;
            await holder.query("BEGIN");
            await new SignalsStore({ query: async (q, v) => ({ rows: (await holder.query(q, v)).rows }) }, schema).record("alice@x.com", { source: "google_drive", external_id: "d1:v2", group_key: "d1", title: "Globex QBR - Notes by Gemini", occurred_at: "2026-11-17T11:00:00Z", payload: { notes: "Next steps\n[Jane Doe] Share usage: Share the export.\nDetails" } }, true);
            committed = (async () => {
              for (let i = 0; i < 200; i++) {
                const found = await pool.query(`SELECT count(*)::int AS n FROM pg_stat_activity WHERE wait_event_type = 'Lock' AND query LIKE '%INSERT INTO ${schema}.tasks%'`);
                if (found.rows[0].n >= 1) break;
                await new Promise((resolve) => setTimeout(resolve, 25));
              }
              await holder.query("COMMIT");
            })();
          }
        }
        return { rows: (await pool.query(text, values)).rows };
      },
    };
    const store = new SignalsStore(racing, schema);
    await store.setup();
    await store.setSource("alice@x.com", "google_drive", true);
    await store.ingest("alice@x.com", [{ source: "google_drive", external_id: "seed" }], notesRule);
    try {
      const first = await store.ingest("alice@x.com", [{ source: "google_drive", external_id: "d1:v1", group_key: "d1", title: "Globex QBR - Notes by Gemini", occurred_at: "2026-11-17T10:00:00Z", payload: { notes: "Next steps\n[Ann Lee] Send pricing: Send the sheet.\nDetails" } }], notesRule);
      expect(first.errors.length).toBe(1);
      sweeping = true;
      const swept = await store.pendingItems(notesRule);
      await committed;
      expect(held).toBe(true);
      expect(swept.created).toEqual([]);
      expect(await store.tasks({})).toEqual([]);
    } finally {
      holder.release();
    }
  });
  it("keeps no revision of a document when two people forget their copies of it at once", async () => {
    const schema = "signals_pg_forget_revisions";
    await pool.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    const holder = await pool.connect();
    const store = new SignalsStore({ query: async (text, values) => ({ rows: (await pool.query(text, values)).rows }) }, schema);
    await store.setup();
    const copy = (owner: string, version: string, at: string) =>
      store.record(owner, { source: "google_drive", external_id: `d1:${version}`, group_key: "d1", title: "Globex QBR - Notes by Gemini", occurred_at: at, payload: { notes: "Next steps\nDetails" } }, true);
    await copy("alice@x.com", "v1", "2026-11-17T10:00:00Z");
    await copy("bob@x.com", "v2", "2026-11-17T11:00:00Z");
    expect((await pool.query(`SELECT count(*)::int AS n FROM ${schema}.revisions`)).rows).toEqual([{ n: 1 }]);
    // Alice's Forget deletes her copy (and refreshes the document, seeing Bob's) and hasn't committed yet while Bob's Forget runs.
    let held = false;
    const alice = new SignalsStore({
      query: async (text, values) => {
        if (!held && text.includes(`${schema}.forget_events(`)) {
          held = true;
          await holder.query("BEGIN");
          const rows = (await holder.query(text, values)).rows;
          const bob = store.setSource("bob@x.com", "google_drive", false, undefined, true);
          // Until Bob's Forget is done or waits on a lock Alice's holds.
          let done = false;
          void bob.then(() => (done = true), () => (done = true));
          for (let i = 0; i < 200 && !done; i++) {
            const waiting = await pool.query(`SELECT count(*)::int AS n FROM pg_stat_activity WHERE wait_event_type = 'Lock' AND query LIKE '%${schema}%'`);
            if (waiting.rows[0].n >= 1) break;
            await new Promise((resolve) => setTimeout(resolve, 25));
          }
          await holder.query("COMMIT");
          await bob;
          return { rows };
        }
        return { rows: (await pool.query(text, values)).rows };
      },
    }, schema);
    try {
      await alice.setSource("alice@x.com", "google_drive", false, undefined, true);
      expect(held).toBe(true);
      expect((await pool.query(`SELECT count(*)::int AS n FROM ${schema}.events WHERE source = 'google_drive'`)).rows).toEqual([{ n: 0 }]);
      expect((await pool.query(`SELECT * FROM ${schema}.revisions`)).rows).toEqual([]);
    } finally {
      holder.release();
    }
  });
});
