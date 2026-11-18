"""Tests for the poller, with a fake workspace and hub. Run: python3 -m unittest test_poller.py"""

import datetime as dt
import unittest

import poller

NOW = dt.datetime(2026, 11, 17, 12, 0, tzinfo=dt.timezone.utc)


class FakeWorkspace:
    def __init__(self, sources, mcp=None, tables=(), rows=()):
        self.sources = sources
        self.mcp_replies = mcp or {}
        self.tables = set(tables)
        self.rows = list(rows)
        self.calls = []

    def mcp(self, service, tool, args):
        self.calls.append(("mcp", service, tool, args))
        reply = self.mcp_replies[service]
        if isinstance(reply, Exception):
            raise reply
        return reply

    def table_exists(self, name):
        return name in self.tables

    def sql(self, warehouse, statement, parameters):
        self.calls.append(("sql", statement, parameters))
        return [row for row in self.rows if str(row["updated_at"]) > parameters["since"]]

    def hub(self, base, method, path, body=None):
        self.calls.append(("hub", method, path, body))
        if path == "/api/sources":
            return {"sources": self.sources}
        if path == "/api/events":
            return {"new": len(body["events"]), "changed": 0, "same": 0, "created": [1]}
        return {"ok": True}


MAIL = {"name": "gmail", "kind": "mcp", "tool": "gmail_search", "args": {"query": "after:{since_epoch}"}, "map": {"external_id": "id", "title": "subject", "group_key": "threadId", "url": "https://mail/{threadId}", "payload": ["from"]}}
CASES = {"name": "table.cases", "kind": "table", "table": "main.s.cases", "query": "SELECT * FROM main.s.cases WHERE updated_at > :since", "watermark": "updated_at", "map": {"external_id": "case_id", "account": "account_name", "payload": ["status"]}}


class Templates(unittest.TestCase):
    def test_fill_keeps_types_and_offsets(self):
        clock = {"now": NOW, "since": NOW - dt.timedelta(hours=1)}
        self.assertEqual(poller.fill({"a": "{since_epoch}", "b": ["{now+7d}"], "c": "x {since}"}, None, clock), {"a": int((NOW - dt.timedelta(hours=1)).timestamp()), "b": ["2026-11-24T12:00:00Z"], "c": "x 2026-11-17T11:00:00Z"})

    def test_to_event_maps_paths_templates_and_payload(self):
        item = {"id": 7, "subject": "Hi", "threadId": "t", "from": "a@b", "start": {"date": "2026-11-18"}}
        clock = {"now": NOW, "since": NOW}
        self.assertEqual(poller.to_event("gmail", item, MAIL["map"], clock), {"source": "gmail", "external_id": "7", "title": "Hi", "group_key": "t", "url": "https://mail/t", "payload": {"from": "a@b"}})
        self.assertEqual(poller.to_event("cal", item, {"external_id": "id", "occurred_at": "{start.dateTime}{start.date}"}, clock)["occurred_at"], "2026-11-18")
        self.assertIsNone(poller.to_event("gmail", {"subject": "no id"}, MAIL["map"], clock))

    def test_tool_json(self):
        self.assertEqual(poller.tool_json({"content": [{"type": "text", "text": "not json"}, {"type": "text", "text": '{"items": [1]}'}]}), {"items": [1]})
        self.assertEqual(poller.tool_json({"structuredContent": {"a": 1}}), {"a": 1})


class Extract(unittest.TestCase):
    def test_match_takes_the_first_group_and_drops_misses(self):
        item = {"key": "ES-9", "fields": {"summary": "Block: Auto increase for workspace 1234 / claude-sonnet-4"}}
        mapping = {"external_id": "key", "payload": {"workspace": {"from": "fields.summary", "match": r"workspace (\d+)"}, "model": {"from": "fields.summary", "match": r"/ *([\w.-]+)"}, "other": {"from": "fields.summary", "match": "nope (x)"}}}
        event = poller.to_event("jira", item, mapping, {"now": NOW, "since": NOW})
        self.assertEqual(event["payload"], {"workspace": "1234", "model": "claude-sonnet-4", "other": None})
        self.assertEqual(poller.extract("abc", "b"), "b")
        self.assertIsNone(poller.extract(None, "b"))


class FakeCursor:
    def __init__(self, db):
        self.db = db

    def __enter__(self):
        return self

    def __exit__(self, *_):
        return False

    def execute(self, sql, params=()):
        self.db.executed.append((sql, params))

    def fetchall(self):
        return [("gmail", True, "2026-11-17T10:00:00Z"), ("google_calendar", False, None)]


class FakeDb:
    def __init__(self):
        self.executed = []

    def cursor(self):
        return FakeCursor(self)


class Lakebase(unittest.TestCase):
    def test_reads_sources_and_queues_events_then_the_cursor(self):
        db = FakeDb()
        inbox = poller.LakebaseInbox(None, {"schema": "signals_hub"}, connect=lambda: db)
        ws = FakeWorkspace([], mcp={"gmail": {"items": [{"id": "m1", "subject": "Q", "threadId": "t1", "from": "x"}]}})
        summary = poller.run(ws, {"sources": [MAIL, {**MAIL, "name": "google_calendar"}]}, None, None, log=lambda _: None, now=NOW, inbox=inbox)
        self.assertEqual(summary, {"gmail": {"events": 1, "queued": 1}, "google_calendar": "off"})
        self.assertFalse([c for c in ws.calls if c[0] == "hub"])
        sql = [s for s, _ in db.executed]
        self.assertEqual(sql[0], "SELECT source, enabled, cursor FROM signals_hub.sources")
        self.assertEqual([p[0] for _, p in db.executed[1:]], ["events", "cursor"])
        self.assertIn('"cursor": "2026-11-17T12:00:00Z"', db.executed[2][1][1])

    def test_checks_its_settings(self):
        with self.assertRaises(SystemExit):
            poller.LakebaseInbox(None, {"schema": "x; drop"}, connect=lambda: FakeDb())
        with self.assertRaises(SystemExit):
            poller.LakebaseInbox(None, {})
        with self.assertRaises(SystemExit):
            poller.run(FakeWorkspace([]), {"sources": []}, None, None, log=lambda _: None, now=NOW)


class Run(unittest.TestCase):
    def test_polls_only_sources_that_are_on_and_moves_cursors_after_posting(self):
        ws = FakeWorkspace(
            [{"source": "gmail", "enabled": True, "cursor": "2026-11-17T10:00:00Z"}, {"source": "google_calendar", "enabled": False}],
            mcp={"gmail": {"items": [{"id": "m1", "subject": "Q", "threadId": "t1", "from": "x"}]}},
        )
        summary = poller.run(ws, {"sources": [MAIL, {**MAIL, "name": "google_calendar"}]}, "https://hub", None, log=lambda _: None, now=NOW)
        self.assertEqual(summary["google_calendar"], "off")
        self.assertEqual(summary["gmail"], {"events": 1, "new": 1, "changed": 0, "same": 0, "created": 1})
        mcp = [c for c in ws.calls if c[0] == "mcp"]
        # The cursor less the 10 minute overlap.
        self.assertEqual(mcp[0][3], {"query": f"after:{int(dt.datetime(2026, 11, 17, 9, 50, tzinfo=dt.timezone.utc).timestamp())}"})
        hub = [c[2:] for c in ws.calls if c[0] == "hub"]
        self.assertEqual([path for path, _ in hub], ["/api/sources", "/api/events", "/api/cursor"])
        self.assertEqual(hub[2][1], {"source": "gmail", "cursor": "2026-11-17T12:00:00Z", "error": ""})

    def test_not_signed_in_and_missing_tables_are_unavailable_and_reported(self):
        ws = FakeWorkspace(
            [{"source": "gmail", "enabled": True}, {"source": "table.cases", "enabled": True}],
            mcp={"gmail": poller.NotSignedIn("Sign in to system.ai.gmail: https://w/explore/mcp-services/system/ai/gmail")},
        )
        summary = poller.run(ws, {"sources": [MAIL, CASES]}, "https://hub", "wh", log=lambda _: None, now=NOW)
        self.assertTrue(summary["gmail"].startswith("unavailable: Sign in to system.ai.gmail"))
        self.assertEqual(summary["table.cases"], "unavailable: main.s.cases isn't there or you can't read it")
        errors = [c[3] for c in ws.calls if c[0] == "hub" and c[2] == "/api/cursor"]
        self.assertEqual([e["source"] for e in errors], ["gmail", "table.cases"])
        self.assertNotIn("cursor", errors[0])

    def test_tables_poll_from_their_watermark(self):
        rows = [{"case_id": "C-1", "account_name": "Acme", "status": "Open", "updated_at": "2026-11-17T09:00:00"}, {"case_id": "C-2", "account_name": "Acme", "status": "Open", "updated_at": "2026-11-17T11:00:00"}]
        ws = FakeWorkspace([{"source": "table.cases", "enabled": True, "cursor": "2026-11-17T10:00:00"}], tables=["main.s.cases"], rows=rows)
        summary = poller.run(ws, {"sources": [CASES]}, "https://hub", "wh", log=lambda _: None, now=NOW)
        self.assertEqual(summary["table.cases"]["events"], 1)
        posted = [c[3] for c in ws.calls if c[0] == "hub" and c[2] == "/api/events"][0]["events"]
        self.assertEqual(posted, [{"source": "table.cases", "external_id": "C-2", "account": "Acme", "payload": {"status": "Open"}}])
        cursor = [c[3] for c in ws.calls if c[0] == "hub" and c[2] == "/api/cursor"][0]
        self.assertEqual(cursor["cursor"], "2026-11-17T11:00:00")

    def test_dry_run_needs_no_hub(self):
        ws = FakeWorkspace([], mcp={"gmail": {"items": [{"id": "m1"}]}})
        summary = poller.run(ws, {"sources": [MAIL]}, None, None, dry_run=True, log=lambda _: None, now=NOW)
        self.assertEqual(summary["gmail"]["events"], 1)
        self.assertFalse([c for c in ws.calls if c[0] == "hub"])


if __name__ == "__main__":
    unittest.main()
