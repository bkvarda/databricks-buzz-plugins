"""Tests for the poller, with a fake workspace and hub. Run: python3 -m unittest test_poller.py"""

import contextlib
import datetime as dt
import io
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

    def test_detail_merges_each_items_full_record(self):
        class Detailed(FakeWorkspace):
            def mcp(self, service, tool, args):
                self.calls.append(("mcp", service, tool, args))
                if tool == "calendar_event_get":
                    if args["event_id"] == "bad":
                        raise RuntimeError("boom")
                    return {"id": args["event_id"], "attendees": [{"email": "a@globex.io"}], "description": "Agenda"}
                return {"items": [{"id": "e1", "summary": "QBR"}, {"id": "bad", "summary": "B"}, {"id": "e3", "summary": "C"}]}

        source = {"name": "google_calendar", "kind": "mcp", "tool": "calendar_event_list", "detail": {"tool": "calendar_event_get", "args": {"event_id": "{id}"}, "max": 2}, "map": {"external_id": "id", "title": "summary", "payload": ["attendees", "description"]}}
        ws = Detailed([])
        events, _ = poller.poll_source(ws, source, None, None, NOW)
        self.assertEqual(events[0]["payload"], {"attendees": [{"email": "a@globex.io"}], "description": "Agenda"})
        self.assertEqual(events[1]["payload"], {"attendees": None, "description": None})
        self.assertEqual(events[2]["payload"], {"attendees": None, "description": None})
        self.assertEqual([c[2] for c in ws.calls], ["calendar_event_list", "calendar_event_get", "calendar_event_get"])

    def test_to_event_maps_paths_templates_and_payload(self):
        item = {"id": 7, "subject": "Hi", "threadId": "t", "from": "a@b", "start": {"date": "2026-11-18"}}
        clock = {"now": NOW, "since": NOW}
        self.assertEqual(poller.to_event("gmail", item, MAIL["map"], clock), {"source": "gmail", "external_id": "7", "title": "Hi", "group_key": "t", "url": "https://mail/t", "payload": {"from": "a@b"}})
        self.assertEqual(poller.to_event("cal", item, {"external_id": "id", "occurred_at": "{start.dateTime}{start.date}"}, clock)["occurred_at"], "2026-11-18")
        self.assertIsNone(poller.to_event("gmail", {"subject": "no id"}, MAIL["map"], clock))

    def test_sections_turn_markdown_results_into_items(self):
        text = (
            "# Search Results\n\n## Messages (2 results)\n### Result 1 of 2\n"
            "Channel: #ext-globex (ID: C1)\nFrom: Ann <ann@globex.io> (ID: U1) \nMessage_ts: 1795000000.000100\n"
            "Permalink: [link](https://x.slack.com/archives/C1/p1795000000000100)\nText: \n<@U9|Me> can you look?\nNote: still in the text\n"
            "Context after: \n- From: Bob (ID: U2) \n  Message_ts: 1795000001.000200\n  me too\n\n---\n\n"
            "### Result 2 of 2\nChannel: DM (ID: D2)\nText: hi\n\n---\n"
        )
        keys = ["Channel", "From", "Message_ts", "Permalink", "Text", "Context after"]
        items = poller.sections(text, r"^### Result \d+ of \d+\s*$", keys)
        self.assertEqual(len(items), 2)
        self.assertEqual(items[0]["text"], "<@U9|Me> can you look?\nNote: still in the text")
        self.assertEqual(items[0]["message_ts"], "1795000000.000100")
        self.assertEqual(items[0]["context_after"], "- From: Bob (ID: U2)\n  Message_ts: 1795000001.000200\n  me too")
        self.assertEqual(items[1], {"channel": "DM (ID: D2)", "text": "hi"})
        self.assertEqual(poller.sections(text, r"^### Result \d+ of \d+\s*$")[0]["note"], "still in the text")  # without keys, any Key: line
        self.assertEqual(poller.sections(None, "x"), [])

        source = {"name": "slack", "kind": "mcp", "tool": "search", "items": "results", "sections": {"split": r"^### Result \d+ of \d+\s*$", "keys": keys},
                  "map": {"external_id": {"from": "permalink", "match": r"\((https://[^)?]+)"}, "actor": {"from": "from", "match": r"<([^>\s]+@[^>\s]+)>"}, "occurred_at": "message_ts", "payload": ["text"]}}
        events, _ = poller.poll_source(FakeWorkspace([], mcp={"slack": {"results": text}}), source, None, None, NOW)
        self.assertEqual(events, [{"source": "slack", "external_id": "https://x.slack.com/archives/C1/p1795000000000100", "actor": "ann@globex.io", "occurred_at": "1795000000.000100", "payload": {"text": "<@U9|Me> can you look?\nNote: still in the text"}}])

    def test_tool_json(self):
        self.assertEqual(poller.tool_json({"content": [{"type": "text", "text": "not json"}, {"type": "text", "text": '{"items": [1]}'}]}), {"items": [1]})
        self.assertEqual(poller.tool_json({"structuredContent": {"a": 1}}), {"a": 1})


class Extract(unittest.TestCase):
    def test_match_takes_the_first_group_and_drops_misses(self):
        item = {"key": "TKT-9", "fields": {"summary": "Acme: limit increase for workspace 1234 / us-east-1"}}
        mapping = {"external_id": "key", "payload": {"workspace": {"from": "fields.summary", "match": r"workspace (\d+)"}, "region": {"from": "fields.summary", "match": r"/ *([\w.-]+)"}, "other": {"from": "fields.summary", "match": "nope (x)"}}}
        event = poller.to_event("jira", item, mapping, {"now": NOW, "since": NOW})
        self.assertEqual(event["payload"], {"workspace": "1234", "region": "us-east-1", "other": None})
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

    def test_account_ids_bind_into_sql_and_join_into_jql(self):
        class WithIds(FakeWorkspace):
            def hub(self, base, method, path, body=None):
                if path == "/api/ids":
                    self.calls.append(("hub", method, path, body))
                    return {"ids": {"crm": ["001A", "001B"], "jira_customer": ['Acme', 'Acme "Labs"\\x']}}
                return super().hub(base, method, path, body)

            def sql(self, warehouse, statement, parameters):
                self.calls.append(("sql", statement, parameters))
                return []

        table = {**CASES, "ids": ["crm"], "query": "SELECT * FROM main.s.cases WHERE account_id IN (:crm) AND updated_at > :since AND note::string <> ':crmx'"}
        jira = {"name": "jira", "kind": "mcp", "service": "atlassian", "tool": "search", "ids": ["jira_customer"], "args": {"jql": '({jira_customer: cf[1] ~ "{}"}) AND updated >= "{since_date}"'}, "items": "issues", "map": {"external_id": "key"}}
        ws = WithIds([{"source": "table.cases", "enabled": True}, {"source": "jira", "enabled": True}], mcp={"atlassian": {"issues": []}}, tables=["main.s.cases"])
        poller.run(ws, {"sources": [table, jira]}, "https://hub", "wh", log=lambda _: None, now=NOW)
        sql = [c for c in ws.calls if c[0] == "sql"][0]
        # The ids are bound parameters, never part of the statement.
        self.assertEqual(sql[1], "SELECT * FROM main.s.cases WHERE account_id IN (:crm_0, :crm_1) AND updated_at > :since AND note::string <> ':crmx'")
        self.assertEqual(sql[2], {"since": "1970-01-01T00:00:00Z", "crm_0": "001A", "crm_1": "001B"})
        jql = [c for c in ws.calls if c[0] == "mcp"][0][3]["jql"]
        self.assertEqual(jql, '(cf[1] ~ "Acme" OR cf[1] ~ "Acme \\"Labs\\"\\\\x") AND updated >= "2026-11-16"')
        self.assertEqual(len([c for c in ws.calls if c[0] == "hub" and c[2] == "/api/ids"]), 1)

    def test_sources_whose_ids_no_account_has_are_skipped_saying_why(self):
        logged = []
        ws = FakeWorkspace([{"source": "table.cases", "enabled": True}, {"source": "gmail", "enabled": True}], mcp={"gmail": {"items": []}}, tables=["main.s.cases"])
        summary = poller.run(ws, {"sources": [{**CASES, "ids": ["crm"], "query": "SELECT 1 WHERE a IN (:crm)"}, MAIL]}, "https://hub", "wh", log=logged.append, now=NOW)
        self.assertEqual(summary["table.cases"], "unavailable: no account has crm ids yet (add them in the account panel, as `crm: ...`)")
        self.assertIn("table.cases: unavailable: no account has crm ids yet (add them in the account panel, as `crm: ...`)", logged)
        self.assertFalse([c for c in ws.calls if c[0] == "sql"])
        self.assertEqual(summary["gmail"]["events"], 0)  # the others still run

    def test_sources_without_ids_run_as_before_and_ids_read_failures_are_reported(self):
        class Broken(FakeWorkspace):
            def hub(self, base, method, path, body=None):
                if path == "/api/ids":
                    raise RuntimeError("hub /api/ids: HTTP 404")
                return super().hub(base, method, path, body)

        # No source names ids: the hub isn't asked for them, and queries go out unchanged.
        ws = Broken([{"source": "table.cases", "enabled": True}], tables=["main.s.cases"])
        summary = poller.run(ws, {"sources": [CASES]}, "https://hub", "wh", log=lambda _: None, now=NOW)
        self.assertEqual(summary["table.cases"]["events"], 0)
        self.assertEqual([c[1:] for c in ws.calls if c[0] == "sql"], [(CASES["query"], {"since": "1970-01-01T00:00:00Z"})])
        self.assertFalse([c for c in ws.calls if c[0] == "hub" and c[2] == "/api/ids"])
        ws = Broken([{"source": "table.cases", "enabled": True}, {"source": "gmail", "enabled": True}], mcp={"gmail": {"items": []}}, tables=["main.s.cases"])
        summary = poller.run(ws, {"sources": [{**CASES, "ids": ["crm"], "query": "SELECT 1 WHERE a IN (:crm)"}, MAIL]}, "https://hub", "wh", log=lambda _: None, now=NOW)
        self.assertEqual(summary["table.cases"], "unavailable: couldn't read account ids: hub /api/ids: HTTP 404")
        self.assertEqual(summary["gmail"]["events"], 0)

    def test_dry_run_needs_no_hub(self):
        ws = FakeWorkspace([], mcp={"gmail": {"items": [{"id": "m1"}]}})
        summary = poller.run(ws, {"sources": [MAIL]}, None, None, dry_run=True, log=lambda _: None, now=NOW)
        self.assertEqual(summary["gmail"]["events"], 1)
        self.assertFalse([c for c in ws.calls if c[0] == "hub"])

# ---------------------------------------------------------------------------
# hub_auth: a separate client for hub calls


class FakeConfig:
    def __init__(self, name, host="https://default.example.com", fail=None):
        self.name, self.host, self.fail = name, host, fail

    def authenticate(self):
        if self.fail:
            raise RuntimeError(self.fail)
        return {"Authorization": f"Bearer {self.name}"}


class FakeClient:
    def __init__(self, name, **kwargs):
        self.config = FakeConfig(name)
        self.kwargs = kwargs


class FakeHttp:
    def __init__(self, status=200, text='{"sources": []}'):
        self.requests, self.status, self.text = [], status, text

    def request(self, method, url, headers=None, json=None, timeout=None):
        self.requests.append((method, url, headers, json))
        reply = type("Reply", (), {})()
        reply.status_code, reply.text, reply.headers = self.status, self.text, {}
        reply.raise_for_status = lambda: None
        reply.json = lambda: __import__("json").loads(self.text)
        return reply

    def post(self, url, headers=None, json=None, timeout=None):
        return self.request("POST", url, headers, json, timeout)


PROFILE = {"profile": "buzz-lakebase-lab"}


def workspace(hub_auth=None, make=None, http=None):
    made = []

    def make_client(**kwargs):
        made.append(kwargs)
        return FakeClient("hub", **kwargs)

    ws = poller.Workspace(FakeClient("default"), hub_auth=hub_auth, make_client=make or make_client)
    ws.http = http or FakeHttp()
    return ws, made


class HubAuth(unittest.TestCase):
    def test_without_hub_auth_hub_calls_use_the_default_client_as_before(self):
        ws, made = workspace()
        ws.hub("https://hub", "GET", "/api/sources")
        self.assertEqual(ws.http.requests, [("GET", "https://hub/api/sources", {"Authorization": "Bearer default", "Content-Type": "application/json"}, None)])
        self.assertEqual(made, [])

    def test_a_profile_signs_hub_calls_in_with_that_profile(self):
        ws, made = workspace({"profile": "buzz-lakebase-lab"})
        ws.hub("https://hub", "POST", "/api/cursor", {"source": "x"})
        ws.hub("https://hub", "GET", "/api/ids")
        self.assertEqual(made, [{"profile": "buzz-lakebase-lab"}])  # made once
        self.assertEqual([r[2]["Authorization"] for r in ws.http.requests], ["Bearer hub", "Bearer hub"])

    def test_hub_calls_use_the_hub_client_and_sql_and_mcp_the_default(self):
        ws, _ = workspace(PROFILE)
        ws.hub("https://hub", "GET", "/api/sources")
        self.assertEqual(ws.headers()["Authorization"], "Bearer default")  # what mcp() sends
        self.assertEqual(ws.client.config.name, "default")  # what sql() and table_exists() use
        self.assertEqual(ws.hub_as.config.name, "hub")
        ws.http = FakeHttp(text='{"result": {"content": [{"type": "text", "text": "{\\"items\\": []}"}]}}')
        ws.mcp("gmail", "gmail_search", {})
        self.assertTrue(all(r[2]["Authorization"] == "Bearer default" for r in ws.http.requests))
        self.assertTrue(ws.http.requests[0][1].startswith("https://default.example.com/"))

    def test_bad_hub_auth_says_what_it_takes(self):
        for bad in ["x", {}, {"profile": "p", "host": "https://h"}, {"host": "https://h", "secret_scope": "s", "client_id_key": "a", "client_secret_key": "b"}]:
            self.assertIn('hub_auth is {"profile"', poller.check_hub_auth(bad), bad)
        self.assertIn("hub_auth.profile", poller.check_hub_auth({"profile": ""}))
        self.assertIsNone(poller.check_hub_auth(PROFILE))

    def test_a_profile_that_cant_sign_in_says_which(self):
        def fail(**kwargs):
            raise ValueError("profile not found")

        ws, _ = workspace(PROFILE, make=fail)
        with self.assertRaises(RuntimeError) as caught:
            ws.hub("https://hub", "GET", "/api/ids")
        self.assertIn("couldn't sign in with profile 'buzz-lakebase-lab'", str(caught.exception))
        self.assertEqual(ws.http.requests, [])


class Main(unittest.TestCase):
    def run_main(self, config, *flags):
        import json as j
        import os
        import tempfile

        made = {}

        class Recorder:
            def __init__(self, client=None, hub_auth=None, make_client=None):
                made["hub_auth"] = hub_auth

        path = os.path.join(tempfile.mkdtemp(), "sources.json")
        with open(path, "w") as file:
            j.dump(config, file)
        real_workspace, real_inbox, real_run = poller.Workspace, poller.LakebaseInbox, poller.run
        poller.Workspace = Recorder
        poller.LakebaseInbox = lambda ws, settings: ("inbox", settings)
        poller.run = lambda ws, config, hub, warehouse, dry_run, inbox=None: made.update(inbox=inbox, hub=hub) or {}
        try:
            with contextlib.redirect_stdout(io.StringIO()):
                poller.main(["--config", path, *flags])
        finally:
            poller.Workspace, poller.LakebaseInbox, poller.run = real_workspace, real_inbox, real_run
        return made

    def test_the_lakebase_job_config_runs_as_before(self):
        lakebase = {"endpoint": "projects/p/branches/b/endpoints/e", "host": "h", "schema": "signals_x"}
        made = self.run_main({"sources": [MAIL], "lakebase": lakebase}, "--lakebase")
        self.assertEqual(made, {"hub_auth": None, "inbox": ("inbox", lakebase), "hub": None})

    def test_hub_auth_goes_to_the_workspace(self):
        made = self.run_main({"sources": [CASES], "hub_auth": PROFILE}, "--hub", "https://hub")
        self.assertEqual(made["hub_auth"], PROFILE)
        self.assertIsNone(made["inbox"])

    def test_lakebase_with_hub_auth_says_to_use_hub(self):
        with self.assertRaises(SystemExit) as caught:
            self.run_main({"sources": [CASES], "hub_auth": PROFILE, "lakebase": {}}, "--lakebase")
        self.assertIn("Use --hub instead", str(caught.exception))

    def test_bad_hub_auth_stops_before_anything_runs(self):
        with self.assertRaises(SystemExit) as caught:
            self.run_main({"sources": [CASES], "hub_auth": {"profile": ""}}, "--hub", "https://hub")
        self.assertIn("hub_auth.profile", str(caught.exception))



if __name__ == "__main__":
    unittest.main()
