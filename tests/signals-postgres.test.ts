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
});
