"""Tests for the poller, with a fake workspace and hub. Run: python3 -m unittest test_poller.py"""

import contextlib
import datetime as dt
import json
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

    def test_detail_only_for_items_its_when_matches_and_match_max_trims(self):
        notes = "Intro\nSummary\nBilling pushed back.\nNext steps\n[Josh Herman] Visit Undisputed: in 2 days.\nDetails\nLong transcript text"

        class Drive(FakeWorkspace):
            def mcp(self, service, tool, args):
                self.calls.append(("mcp", service, tool, args))
                if tool == "google_file_read":
                    return {"metadata": {"title": "x"}, "content": notes}
                return {"items": [{"id": "d1", "name": "Plan.xlsx"}, {"id": "d2", "name": "QBR - Notes by Gemini"}, {"id": "d3", "name": "Sync - Notes by Gemini"}]}

        source = {"name": "google_drive", "kind": "mcp", "tool": "google_drive_list_recent",
                  "detail": {"tool": "google_file_read", "args": {"file_id": "{id}", "file_type": "doc"}, "when": {"name": "Notes by Gemini"}, "max": 1},
                  "map": {"external_id": "id", "title": "name", "payload": {"notes": {"from": "content", "match": r"(?s)(Summary\n.*?)(?:\nDetails\n|$)", "max": 40}}}}
        ws = Drive([])
        events, _ = poller.poll_source(ws, source, None, None, NOW)
        # Only notes docs are read, and `max` counts those: the spreadsheet isn't read and doesn't use up the one read.
        self.assertEqual([c[3] for c in ws.calls if c[2] == "google_file_read"], [{"file_id": "d2", "file_type": "doc"}])
        self.assertEqual(events[1]["payload"]["notes"], "Summary\nBilling pushed back.\nNext steps\n")
        self.assertEqual(len(events[1]["payload"]["notes"]), 40)
        self.assertEqual(events[0]["payload"], {"notes": None})
        self.assertEqual(events[2]["payload"], {"notes": None})
        self.assertFalse(poller.detail_applies({"when": {"name": "Gemini"}}, {"id": "x"}))
        self.assertTrue(poller.detail_applies({}, {"id": "x"}))

    def test_notes_docs_are_read_only_for_meetings_that_name_an_account(self):
        source = {"name": "google_drive", "kind": "mcp", "tool": "list", "detail": {"tool": "read", "args": {"file_id": "{id}"}, "when": {"name": "Notes by Gemini"}, "named_in": "name"}, "map": {"external_id": "id", "title": "name", "payload": {"notes": {"from": "content", "match": "(Summary.*)"}}}}

        class Drive(FakeWorkspace):
            def mcp(self, service, tool, args):
                self.calls.append(("mcp", service, tool, args))
                if tool == "read":
                    return {"content": "Summary: secret"}
                return {"items": [{"id": "h", "name": "Hiring sync - Notes by Gemini"}, {"id": "g", "name": "Globex Corp QBR - Notes by Gemini"}, {"id": "x", "name": "Globexx - Notes by Gemini"}]}

        ws = Drive([])
        events, _ = poller.poll_source(ws, source, None, None, NOW, names=["Globex"])
        self.assertEqual([c[3]["file_id"] for c in ws.calls if c[2] == "read"], ["g"])
        self.assertEqual([e["payload"]["notes"] for e in events], [None, "Summary: secret", None])
        # No account names known (or none read): no doc is read.
        ws = Drive([])
        poller.poll_source(ws, source, None, None, NOW)
        self.assertFalse([c for c in ws.calls if c[2] == "read"])
        self.assertTrue(poller.names_one("QBR – GLOBEX/Initech notes", ["globex"]))
        self.assertFalse(poller.names_one("Globexx", ["Globex"]))

    def test_run_reads_account_names_for_named_in_sources(self):
        class Hub(FakeWorkspace):
            def hub(self, base, method, path, body=None):
                if path == "/api/ids":
                    self.calls.append(("hub", method, path, body))
                    return {"ids": {}, "names": ["Globex"]}
                return super().hub(base, method, path, body)

            def mcp(self, service, tool, args):
                self.calls.append(("mcp", service, tool, args))
                return {"content": "x"} if tool == "read" else {"items": [{"id": "g", "name": "Globex - Notes by Gemini"}]}

        source = {"name": "google_drive", "kind": "mcp", "tool": "list", "detail": {"tool": "read", "args": {}, "named_in": "name"}, "map": {"external_id": "id"}}
        ws = Hub([{"source": "google_drive", "enabled": True}])
        poller.run(ws, {"sources": [source]}, "https://hub", None, log=lambda _: None, now=NOW)
        self.assertEqual([c[2] for c in ws.calls if c[0] == "mcp"], ["list", "read"])

    def test_lakebase_ids_split_out_account_names(self):
        class Cursor:
            def __enter__(self): return self
            def __exit__(self, *a): return False
            def execute(self, *a): pass
            def fetchall(self): return [("_name", "Globex"), ("crm", "001")]

        class Db:
            def cursor(self): return Cursor()

        inbox = poller.LakebaseInbox(None, {"schema": "signals_hub"}, connect=lambda: Db())
        self.assertEqual(inbox.call("GET", "/api/ids"), {"ids": {"crm": ["001"]}, "names": ["Globex"]})

    def test_read_cap_holds_the_cursor_so_later_docs_are_read_and_read_ones_arent_reposted(self):
        docs = [{"id": f"d{n}", "name": f"Globex {n} - Notes by Gemini", "modifiedTime": f"2026-11-17T{n:02d}:00:00Z"} for n in range(1, 12)]

        class Drive(FakeWorkspace):
            def mcp(self, service, tool, args):
                self.calls.append(("mcp", service, tool, args))
                if tool == "read":
                    return {"content": f"Summary\nnotes of {args['file_id']}\nDetails\n"}
                # The same one-day listing, newest first, on every poll.
                return {"items": [{"id": "sheet", "name": "Plan", "modifiedTime": "2026-11-17T05:30:00Z"}] + list(reversed(docs))}

        source = {"name": "google_drive", "kind": "mcp", "tool": "list", "detail": {"tool": "read", "args": {"file_id": "{id}"}, "when": {"name": "Notes by Gemini"}, "named_in": "name", "after": "modifiedTime", "max": 10},
                  "map": {"external_id": "{id}:{modifiedTime}", "title": "name", "payload": {"notes": {"from": "content", "match": "(?s)(Summary.*?)Details"}}}}
        now = dt.datetime(2026, 11, 17, 12, 30, tzinfo=dt.timezone.utc)
        ws = Drive([])
        first, cursor = poller.poll_source(ws, source, None, None, now, names=["Globex"])
        # The ten oldest are read; the eleventh isn't posted, and the cursor stops just before it.
        self.assertEqual([c[3]["file_id"] for c in ws.calls if c[2] == "read"], [f"d{n}" for n in range(1, 11)])
        self.assertEqual(sorted(e["external_id"] for e in first if e["payload"]["notes"]), sorted(f"d{n}:2026-11-17T{n:02d}:00:00Z" for n in range(1, 11)))
        self.assertNotIn("d11:2026-11-17T11:00:00Z", [e["external_id"] for e in first])
        self.assertIn("sheet:2026-11-17T05:30:00Z", [e["external_id"] for e in first])
        self.assertLess(json.loads(cursor)["at"], "2026-11-17T11:00:00Z")
        ws = Drive([])
        second, cursor2 = poller.poll_source(ws, source, cursor, None, now, names=["Globex"])
        # Only the eleventh is read and posted; the ten read before aren't posted again (no version without notes).
        self.assertEqual([c[3]["file_id"] for c in ws.calls if c[2] == "read"], ["d11"])
        self.assertEqual([e["external_id"] for e in second if e["payload"]["notes"] is not None], ["d11:2026-11-17T11:00:00Z"])
        self.assertFalse([e for e in second if e["external_id"].startswith("d") and e["payload"]["notes"] is None])
        self.assertEqual(json.loads(cursor2)["at"], poller.iso(now))
        self.assertEqual(len(json.loads(cursor2)["read"]), 11)
        # A third poll of the same listing reads and posts nothing more.
        ws = Drive([])
        third, _ = poller.poll_source(ws, source, cursor2, None, now, names=["Globex"])
        self.assertFalse([c for c in ws.calls if c[2] == "read"])
        self.assertEqual([e["external_id"] for e in third], ["sheet:2026-11-17T05:30:00Z"])

    def test_a_failed_read_waits_for_the_next_poll(self):
        class Drive(FakeWorkspace):
            def mcp(self, service, tool, args):
                self.calls.append(("mcp", service, tool, args))
                if tool == "read":
                    raise RuntimeError("busy")
                return {"items": [{"id": "d1", "name": "Globex - Notes by Gemini", "modifiedTime": "2026-11-17T09:00:00Z"}]}

        source = {"name": "google_drive", "kind": "mcp", "tool": "list", "detail": {"tool": "read", "args": {}, "named_in": "name", "after": "modifiedTime"}, "map": {"external_id": "id"}}
        events, cursor = poller.poll_source(Drive([]), source, None, None, NOW, names=["Globex"])
        self.assertEqual(events, [])
        self.assertLess(json.loads(cursor)["at"], "2026-11-17T09:00:00Z")
        self.assertEqual(json.loads(cursor)["read"], [])

    def notes_drive(self, listings):
        """A Drive whose listing is listings[n] on poll n (the last one after that)."""
        polls = {"n": 0}

        class Drive(FakeWorkspace):
            def mcp(self, service, tool, args):
                self.calls.append(("mcp", service, tool, args))
                if tool == "read":
                    return {"content": f"Summary\nnotes of {args['file_id']}\nDetails\n"}
                listing = listings[min(polls["n"], len(listings) - 1)]
                polls["n"] += 1
                return {"items": list(listing)}

        source = {"name": "google_drive", "kind": "mcp", "tool": "list", "detail": {"tool": "read", "args": {"file_id": "{id}"}, "when": {"name": "Notes by Gemini"}, "named_in": "name", "after": "modifiedTime", "max": 10},
                  "map": {"external_id": "{id}:{modifiedTime}", "payload": {"notes": {"from": "content", "match": "(?s)(Summary.*?)Details"}}}}
        return Drive([]), source

    def test_read_cap_reaches_every_doc_in_a_burst_within_one_second(self):
        for label, stamp in (("milliseconds apart", lambda n: f"2026-11-17T10:00:00.{n:03d}Z"), ("the same time", lambda n: "2026-11-17T10:00:00Z")):
            docs = [{"id": f"d{n}", "name": f"Globex {n} - Notes by Gemini", "modifiedTime": stamp(n)} for n in range(1, 12)]
            ws, source = self.notes_drive([list(reversed(docs))])
            now = dt.datetime(2026, 11, 17, 12, 0, tzinfo=dt.timezone.utc)
            cursor, posted = None, []
            for _ in range(3):
                events, cursor = poller.poll_source(ws, source, cursor, None, now, names=["Globex"])
                posted += [e["external_id"].split(":")[0] for e in events]
            self.assertEqual(sorted(posted), sorted(f"d{n}" for n in range(1, 12)), label)
            self.assertEqual(sorted(c[3]["file_id"] for c in ws.calls if c[2] == "read"), sorted(f"d{n}" for n in range(1, 12)), label)

    def test_a_doc_listed_late_with_an_older_time_is_still_read(self):
        early = {"id": "d1", "name": "Globex QBR - Notes by Gemini", "modifiedTime": "2026-11-17T11:00:00Z"}
        late = {"id": "d2", "name": "Globex sync - Notes by Gemini", "modifiedTime": "2026-11-17T11:58:00Z"}
        ws, source = self.notes_drive([[early], [late, early]])
        first, cursor = poller.poll_source(ws, source, None, None, dt.datetime(2026, 11, 17, 12, 0, tzinfo=dt.timezone.utc), names=["Globex"])
        self.assertEqual([e["external_id"] for e in first], ["d1:2026-11-17T11:00:00Z"])
        # d2 is first listed after the cursor passed its time: it's read, and d1 isn't posted again.
        second, _ = poller.poll_source(ws, source, cursor, None, dt.datetime(2026, 11, 17, 12, 30, tzinfo=dt.timezone.utc), names=["Globex"])
        self.assertEqual([e["external_id"] for e in second], ["d2:2026-11-17T11:58:00Z"])
        self.assertTrue(second[0]["payload"]["notes"])

    def test_a_new_version_of_a_doc_read_before_is_read_again(self):
        v1 = {"id": "d1", "name": "Globex QBR - Notes by Gemini", "modifiedTime": "2026-11-17T11:00:00Z"}
        v2 = {**v1, "modifiedTime": "2026-11-17T11:40:00Z"}
        ws, source = self.notes_drive([[v1], [v2]])
        _, cursor = poller.poll_source(ws, source, None, None, dt.datetime(2026, 11, 17, 11, 30, tzinfo=dt.timezone.utc), names=["Globex"])
        second, _ = poller.poll_source(ws, source, cursor, None, dt.datetime(2026, 11, 17, 12, 0, tzinfo=dt.timezone.utc), names=["Globex"])
        self.assertEqual([e["external_id"] for e in second], ["d1:2026-11-17T11:40:00Z"])

    def test_failed_reads_count_against_the_cap_and_healthy_docs_still_get_a_turn(self):
        docs = [{"id": f"d{n:02d}", "name": f"Globex {n} - Notes by Gemini", "modifiedTime": f"2026-11-17T10:{n:02d}:00Z"} for n in range(50)]
        broken = {f"d{n:02d}" for n in range(15)}  # the 15 oldest always fail
        outage = {"on": True}

        class Drive(FakeWorkspace):
            def mcp(self, service, tool, args):
                self.calls.append(("mcp", service, tool, args))
                if tool == "read":
                    if outage["on"] or args["file_id"] in broken:
                        raise RuntimeError("busy")
                    return {"content": f"Summary\nnotes of {args['file_id']}\nDetails\n"}
                return {"items": list(docs)}

        _, source = self.notes_drive([])
        now = dt.datetime(2026, 11, 17, 12, 0, tzinfo=dt.timezone.utc)
        reads = lambda ws: [c[3]["file_id"] for c in ws.calls if c[2] == "read"]
        # An outage of the detail service: 50 eligible docs, max 10, so 10 reads are tried, and none is posted.
        ws = Drive([])
        events, cursor = poller.poll_source(ws, source, None, None, now, names=["Globex"])
        self.assertEqual(len(reads(ws)), 10)
        self.assertEqual(events, [])
        self.assertEqual(len(json.loads(cursor)["failed"]), 10)
        # It recovers except for the 15 oldest: the 40 never tried go first, then the failed ones take turns.
        outage["on"] = False
        posted, tried = [], []
        for _ in range(8):
            ws = Drive([])
            events, cursor = poller.poll_source(ws, source, cursor, None, now, names=["Globex"])
            self.assertLessEqual(len(reads(ws)), 10)
            tried += reads(ws)
            posted += [e["external_id"].split(":")[0] for e in events]
        self.assertEqual(sorted(posted), sorted(f"d{n:02d}" for n in range(15, 50)))
        self.assertEqual(len(posted), len(set(posted)))
        self.assertTrue(broken <= set(tried))  # every failing doc is retried, none is left behind
        state = json.loads(cursor)
        self.assertEqual(sorted(state["failed"]), sorted(poller.version_key(d, "modifiedTime") for d in docs if d["id"] in broken))
        self.assertLess(state["at"], "2026-11-17T10:00:00Z")

    def test_the_cursor_keeps_every_read_key_below_capacity(self):
        docs = [{"id": f"d{n:02d}", "name": f"Globex {n} - Notes by Gemini", "modifiedTime": f"2026-11-17T10:{n % 60:02d}:{n // 60:02d}Z"} for n in range(80)]
        ws, source = self.notes_drive([docs])
        now = dt.datetime(2026, 11, 17, 12, 0, tzinfo=dt.timezone.utc)
        cursor = None
        for _ in range(8):
            _, cursor = poller.poll_source(ws, source, cursor, None, now, names=["Globex"])
        self.assertEqual(len(json.loads(cursor)["read"]), 80)
        before = len([c for c in ws.calls if c[2] == "read"])
        events, _ = poller.poll_source(ws, source, cursor, None, now, names=["Globex"])
        self.assertEqual(len([c for c in ws.calls if c[2] == "read"]), before)  # nothing read again
        self.assertEqual(events, [])

    def test_an_old_plain_cursor_still_works(self):
        doc = {"id": "d1", "name": "Globex QBR - Notes by Gemini", "modifiedTime": "2026-11-17T11:00:00Z"}
        ws, source = self.notes_drive([[doc]])
        events, cursor = poller.poll_source(ws, source, "2026-11-17T11:30:00Z", None, dt.datetime(2026, 11, 17, 12, 0, tzinfo=dt.timezone.utc), names=["Globex"])
        self.assertEqual(len(events), 1)
        self.assertEqual(json.loads(cursor)["at"], "2026-11-17T12:00:00Z")

    def test_a_failed_account_lookup_holds_a_named_in_source(self):
        class Hub(FakeWorkspace):
            def hub(self, base, method, path, body=None):
                if path == "/api/ids":
                    raise RuntimeError("hub busy")
                return super().hub(base, method, path, body)

            def mcp(self, service, tool, args):
                self.calls.append(("mcp", service, tool, args))
                return {"items": [{"id": "g", "name": "Globex - Notes by Gemini", "modifiedTime": "2026-11-17T09:00:00Z"}]}

        source = {"name": "google_drive", "kind": "mcp", "tool": "list", "detail": {"tool": "read", "args": {}, "named_in": "name", "after": "modifiedTime"}, "map": {"external_id": "id"}}
        ws = Hub([{"source": "google_drive", "enabled": True, "cursor": "2026-11-17T08:00:00Z"}])
        summary = poller.run(ws, {"sources": [source]}, "https://hub", None, log=lambda _: None, now=NOW)
        self.assertTrue(str(summary["google_drive"]).startswith("unavailable"))
        self.assertFalse([c for c in ws.calls if c[0] == "mcp"])
        posts = [c for c in ws.calls if c[0] == "hub" and c[1] == "POST"]
        self.assertFalse([c for c in posts if c[2] == "/api/events"])
        self.assertFalse([c for c in posts if c[2] == "/api/cursor" and "cursor" in (c[3] or {})])

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


class ExampleSources(unittest.TestCase):
    """The example sources.json, on items shaped like the real tools' output."""

    def setUp(self):
        import json, os
        with open(os.path.join(os.path.dirname(__file__), "sources.example.json")) as file:
            self.sources = {source["name"]: source for source in json.load(file)["sources"]}

    def slack_events(self, name, permalinks):
        results = "".join(
            f"### Result {i + 1} of {len(permalinks)}\nChannel: #ext-{i} (ID: {channel})\nFrom: Ann <ann@globex.io> (ID: U1)\nMessage_ts: {ts}\nPermalink: [link]({link})\nText: hi\n\n---\n"
            for i, (channel, ts, link) in enumerate(permalinks)
        )
        ws = FakeWorkspace([], mcp={"slack": {"results": results}})
        events, _ = poller.poll_source(ws, self.sources[name], None, None, NOW)
        return ws, events

    def drive_notes(self, content, names=("Globex",)):
        item = {"id": "d1", "name": "Globex QBR - 2026/11/17 - Notes by Gemini", "modifiedTime": "2026-11-17T10:00:00Z", "webViewLink": "https://docs/d1"}

        class Drive(FakeWorkspace):
            def mcp(self, service, tool, args):
                self.calls.append(("mcp", service, tool, args))
                return {"content": content} if tool == "google_file_read" else {"items": [item]}

        ws = Drive([])
        events, _ = poller.poll_source(ws, self.sources["google_drive"], None, None, NOW, names=list(names))
        return ws, events

    def test_google_drive_keeps_summary_and_next_steps_not_the_transcript(self):
        doc = "Meeting Nov 17\nSummary\nBilling pushed back.\x0bMore.\nDecisions\nAligned\nNext steps\n[Ann] Send pricing.\n{heading}\nTRANSCRIPT-MARKER Ann said things\nhttps://calendar.google.com/calendar/event?eid=abc_1"
        for heading in ("Details", "Details:", "Transcript", "Attachments"):
            _, events = self.drive_notes(doc.format(heading=heading))
            notes = events[0]["payload"]["notes"]
            self.assertTrue(notes.startswith("Summary\nBilling pushed back."), heading)
            self.assertIn("[Ann] Send pricing.", notes)
            self.assertNotIn("TRANSCRIPT-MARKER", notes, heading)
            self.assertEqual(events[0]["payload"]["meeting"], "https://calendar.google.com/calendar/event?eid=abc_1")
        # No section after Next steps that it knows: no notes, rather than the transcript.
        _, events = self.drive_notes(doc.format(heading="Notes from the call"))
        self.assertIsNone(events[0]["payload"]["notes"])
        # A meeting whose title names no account isn't read at all.
        ws, events = self.drive_notes(doc.format(heading="Details"), names=("Initech",))
        self.assertFalse([c for c in ws.calls if c[2] == "google_file_read"])
        self.assertIsNone(events[0]["payload"]["notes"])

    def test_slack_sources_use_the_slack_service(self):
        for name in ("slack", "slack.sent"):
            ws, events = self.slack_events(name, [("C1", "1795000000.123456", "https://x.slack.com/archives/C1/p1795000000123456")])
            self.assertEqual(ws.calls[0][1], "slack")
            self.assertEqual(len(events), 1)

    def test_slack_thread_key_is_the_channel_and_the_full_root_ts(self):
        for name in ("slack", "slack.sent"):
            _, events = self.slack_events(name, [
                # A thread's root, and a reply in it (Slack's reply permalinks carry the root as thread_ts, after cid).
                ("C1", "1795000000.123456", "https://x.slack.com/archives/C1/p1795000000123456"),
                ("C1", "1795000300.654321", "https://x.slack.com/archives/C1/p1795000300654321?thread_ts=1795000000.123456&cid=C1"),
                ("C1", "1795000301.000001", "https://x.slack.com/archives/C1/p1795000301000001?cid=C1&thread_ts=1795000000.123456"),
                # Another channel's root in the same second, and another root in the same second of C1.
                ("C2", "1795000000.999999", "https://x.slack.com/archives/C2/p1795000000999999"),
                ("C1", "1795000000.000001", "https://x.slack.com/archives/C1/p1795000000000001"),
            ])
            keys = [event["group_key"] for event in events]
            self.assertEqual(keys, ["C1:1795000000.123456", "C1:1795000000.123456", "C1:1795000000.123456", "C2:1795000000.999999", "C1:1795000000.000001"])
            # The external id is still the message's own permalink, without the query.
            self.assertEqual(events[1]["external_id"], "https://x.slack.com/archives/C1/p1795000300654321")

    def test_sent_mail_is_its_own_source(self):
        self.assertEqual(self.sources["gmail"]["args"]["query"], "in:inbox after:{since_epoch}")
        self.assertNotIn("sent", self.sources["gmail"]["args"]["query"])
        self.assertEqual(self.sources["gmail.sent"]["args"]["query"], "in:sent after:{since_epoch}")
        ws = FakeWorkspace([], mcp={"gmail": {"items": [{"id": "m1", "threadId": "t1", "from": "me@x.com", "subject": "Re: hi"}]}})
        events, _ = poller.poll_source(ws, self.sources["gmail.sent"], None, None, NOW)
        self.assertEqual(ws.calls[0][1], "gmail")
        self.assertEqual(events[0]["group_key"], "t1")

    def test_match_lists_and_replace(self):
        self.assertEqual(poller.extract("a-1 b-2", ["z(\\d)", "b-(\\d)"]), "2")
        self.assertEqual(poller.extract("a-1 b-2", r"a-(\d) b-(\d)", r"\2/\1"), "2/1")
        self.assertIsNone(poller.extract("abc", ["x", "y"]))


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

    def test_the_cursor_stays_when_the_hub_says_events_failed_to_save(self):
        ws = FakeWorkspace(
            [{"source": "gmail", "enabled": True, "cursor": "2026-11-17T10:00:00Z"}],
            mcp={"gmail": {"items": [{"id": "m1", "subject": "Q", "threadId": "t1", "from": "x"}]}},
        )
        ws.hub = lambda base, method, path, body=None: (ws.calls.append(("hub", method, path, body)), {"sources": ws.sources} if path == "/api/sources" else {"new": 0, "retry": True} if path == "/api/events" else {"ok": True})[1]
        summary = poller.run(ws, {"sources": [MAIL]}, "https://hub", None, log=lambda _: None, now=NOW)
        self.assertTrue(summary["gmail"].startswith("failed:"))
        cursors = [c[3] for c in ws.calls if c[0] == "hub" and c[2] == "/api/cursor"]
        self.assertEqual(len(cursors), 1)
        self.assertNotIn("cursor", cursors[0])

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
