"""Signals poller: reads one person's sources and posts what it finds to the signals hub.

Runs as a scheduled serverless Databricks job owned by that person, so it reads
their sources as them: the Unity Catalog MCP services (system.ai.gmail,
google_calendar, slack, ...) with their own sign-ins, and tables with their own
grants. It keeps no state: the hub says which sources the person turned on and
where each one stopped (its cursor).

    python poller.py --config sources.json [--hub https://<app-url>] [--warehouse <id>] [--dry-run]

The config lists sources (see sources.example.json):

- kind "mcp": a tool of a system.ai MCP service. `args` and `map` are templates:
  "{since}" (the cursor, or `lookback_hours` ago, ISO 8601), "{now}", "{now+7d}",
  "{since_epoch}", and "{field}" for a field of the item being mapped.
  `items` is the path to the list in the tool's JSON result.
- kind "table": a SQL query with :since (the watermark) as a parameter.
  `table` is checked first; a table that isn't there (or can't be read) makes
  the source "unavailable" and it is skipped. The cursor is the largest
  `watermark` column seen.

`map` turns an item into an event: external_id, title, url, actor, account,
group_key, occurred_at, and payload (a list of fields, or "*" for the whole item).
"""

from __future__ import annotations

import argparse
import datetime as dt
import json
import re
import sys
import time
from typing import Any, Callable, Iterable

PROTOCOL = "2025-06-18"
NOT_SIGNED_IN = -32006
BATCH = 200

# ---------------------------------------------------------------------------
# Templates and mapping (pure; tested without a workspace)


def iso(t: dt.datetime) -> str:
    return t.astimezone(dt.timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def parse_time(value: str | None) -> dt.datetime | None:
    if not value:
        return None
    try:
        if re.fullmatch(r"\d+(\.\d+)?", value):
            return dt.datetime.fromtimestamp(float(value), dt.timezone.utc)
        return dt.datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return None


def get_path(item: Any, path: str) -> Any:
    """`a.b.0.c` into dicts and lists."""
    value = item
    for part in path.split(".") if path else []:
        if isinstance(value, dict):
            value = value.get(part)
        elif isinstance(value, list) and part.isdigit() and int(part) < len(value):
            value = value[int(part)]
        else:
            return None
    return value


_OFFSET = re.compile(r"^now([+-])(\d+)([mhd])$")


def fill(template: Any, item: Any, clock: dict[str, dt.datetime]) -> Any:
    """Fills {since}, {now}, {now+7d}, {since_epoch} and {item.field} in strings (recursively in lists and dicts)."""
    if isinstance(template, dict):
        return {key: fill(value, item, clock) for key, value in template.items()}
    if isinstance(template, list):
        return [fill(value, item, clock) for value in template]
    if not isinstance(template, str):
        return template

    def one(name: str) -> Any:
        if name == "now":
            return iso(clock["now"])
        if name == "since":
            return iso(clock["since"])
        if name == "since_epoch":
            return int(clock["since"].timestamp())
        if name == "since_date":
            return clock["since"].date().isoformat()
        offset = _OFFSET.match(name)
        if offset:
            sign, amount, unit = offset.groups()
            unit_name = {"m": "minutes", "h": "hours", "d": "days"}[unit]
            delta = dt.timedelta(**{unit_name: int(amount)})
            return iso(clock["now"] + delta if sign == "+" else clock["now"] - delta)
        return get_path(item, name)

    whole = re.fullmatch(r"\{([A-Za-z0-9_.+-]+)\}", template)
    if whole:  # keep the value's type ({since_epoch} stays a number)
        return one(whole.group(1))
    return re.sub(r"\{([A-Za-z0-9_.+-]+)\}", lambda m: "" if one(m.group(1)) is None else str(one(m.group(1))), template)


def to_event(source: str, item: dict, mapping: dict, clock: dict[str, dt.datetime]) -> dict | None:
    """An item as a hub event, or None without an external_id."""

    def value(spec: Any) -> Any:
        if isinstance(spec, str) and "{" not in spec:
            return get_path(item, spec)  # a plain path
        return fill(spec, item, clock)

    external = value(mapping.get("external_id", "id"))
    if external in (None, ""):
        return None
    event: dict[str, Any] = {"source": source, "external_id": str(external)}
    for key in ("title", "url", "actor", "account", "group_key", "occurred_at"):
        if key in mapping:
            found = value(mapping[key])
            if found not in (None, ""):
                event[key] = found if key == "occurred_at" and isinstance(found, (int, float)) else str(found)
    payload = mapping.get("payload")
    if payload == "*":
        event["payload"] = item
    elif isinstance(payload, list):
        event["payload"] = {name: get_path(item, name) for name in payload}
    elif isinstance(payload, dict):
        event["payload"] = {name: value(spec) for name, spec in payload.items()}
    return json.loads(json.dumps(event, default=str))


def tool_json(result: dict) -> Any:
    """A tool result's JSON: structuredContent, or the first JSON text block."""
    if result.get("structuredContent") is not None:
        return result["structuredContent"]
    for block in result.get("content") or []:
        text = (block.get("text") or "").strip() if block.get("type") == "text" else ""
        if text[:1] in "{[":
            try:
                return json.loads(text)
            except ValueError:
                continue
    return None


# ---------------------------------------------------------------------------
# Workspace access


class NotSignedIn(Exception):
    pass


class Unavailable(Exception):
    pass


class Workspace:
    """Calls as the job's owner, through the Databricks SDK's auth."""

    def __init__(self, client=None):
        if client is None:
            from databricks.sdk import WorkspaceClient

            client = WorkspaceClient()
        self.client = client
        self.host = client.config.host.rstrip("/")
        import requests

        self.http = requests.Session()

    def headers(self) -> dict:
        return {**self.client.config.authenticate(), "Content-Type": "application/json"}

    def mcp(self, service: str, tool: str, args: dict) -> Any:
        url = f"{self.host}/ai-gateway/mcp-services/system.ai.{service}"
        headers = {**self.headers(), "Accept": "application/json, text/event-stream"}

        def post(message: dict, initializing=False) -> dict:
            h = dict(headers)
            if not initializing:
                h["MCP-Protocol-Version"] = PROTOCOL
            response = self.http.post(url, headers=h, json=message, timeout=120)
            if response.headers.get("mcp-session-id"):
                headers["Mcp-Session-Id"] = response.headers["mcp-session-id"]
            if response.status_code == 401:
                raise NotSignedIn(f"system.ai.{service} rejected the call (HTTP 401)")
            response.raise_for_status()
            text = response.text
            if "text/event-stream" in response.headers.get("content-type", ""):
                text = "\n".join(line[5:].strip() for line in text.splitlines() if line.startswith("data:"))
            reply = json.loads(text) if text.strip() else {}
            error = reply.get("error")
            if error:
                # Not signed in comes back as HTTP 200 with a JSON-RPC error.
                if error.get("code") == NOT_SIGNED_IN or re.search(r"401|not logged in|login first|Credential for user", error.get("message", ""), re.I):
                    raise NotSignedIn(f"Sign in to system.ai.{service}: {self.host}/explore/mcp-services/system/ai/{service}")
                raise RuntimeError(f"system.ai.{service} {tool}: {error.get('message')}")
            return reply.get("result") or {}

        post({"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {"protocolVersion": PROTOCOL, "capabilities": {}, "clientInfo": {"name": "signals-poller", "version": "1"}}}, True)
        self.http.post(url, headers={**headers, "MCP-Protocol-Version": PROTOCOL}, json={"jsonrpc": "2.0", "method": "notifications/initialized"}, timeout=30)
        result = post({"jsonrpc": "2.0", "id": 2, "method": "tools/call", "params": {"name": tool, "arguments": args}})
        if result.get("isError"):
            text = " ".join(block.get("text", "") for block in result.get("content") or [])
            raise RuntimeError(f"system.ai.{service} {tool}: {text[:500]}")
        return tool_json(result)

    def table_exists(self, name: str) -> bool:
        try:
            return bool(self.client.tables.exists(full_name=name).table_exists)
        except Exception:  # no access looks the same as not there
            return False

    def sql(self, warehouse: str, statement: str, parameters: dict) -> list[dict]:
        from databricks.sdk.service.sql import StatementParameterListItem, StatementState

        response = self.client.statement_execution.execute_statement(
            warehouse_id=warehouse,
            statement=statement,
            parameters=[StatementParameterListItem(name=k, value=None if v is None else str(v)) for k, v in parameters.items()],
            wait_timeout="50s",
        )
        while response.status.state in (StatementState.PENDING, StatementState.RUNNING):
            time.sleep(2)
            response = self.client.statement_execution.get_statement(response.statement_id)
        if response.status.state != StatementState.SUCCEEDED:
            raise RuntimeError(response.status.error.message if response.status.error else str(response.status.state))
        columns = [column.name for column in response.manifest.schema.columns]
        rows = [dict(zip(columns, row)) for row in (response.result.data_array or [])]
        chunk = response.result.next_chunk_index
        while chunk is not None:
            part = self.client.statement_execution.get_statement_result_chunk_n(response.statement_id, chunk)
            rows.extend(dict(zip(columns, row)) for row in (part.data_array or []))
            chunk = part.next_chunk_index
        return rows

    def hub(self, base: str, method: str, path: str, body: Any = None) -> Any:
        response = self.http.request(method, f"{base.rstrip('/')}{path}", headers=self.headers(), json=body, timeout=120)
        if response.status_code >= 400:
            raise RuntimeError(f"hub {path}: HTTP {response.status_code} {response.text[:300]}")
        return response.json()


# ---------------------------------------------------------------------------
# Polling


def poll_source(ws: Workspace, source: dict, cursor: str | None, warehouse: str | None, now: dt.datetime) -> tuple[list[dict], str]:
    """One source's events since its cursor, and its next cursor."""
    lookback = dt.timedelta(hours=float(source.get("lookback_hours", 24)))
    name = source["name"]
    if source["kind"] == "mcp":
        since = parse_time(cursor) or now - lookback
        # Look back a little past the cursor: the hub dedupes, and sources index late.
        since = min(since, now) - dt.timedelta(minutes=float(source.get("overlap_minutes", 10)))
        clock = {"now": now, "since": since}
        data = ws.mcp(source.get("service", name), source["tool"], fill(source.get("args", {}), None, clock))
        items = get_path(data, source.get("items", "items")) if source.get("items", "items") else data
        events = [e for e in (to_event(name, item, source.get("map", {}), clock) for item in items or [] if isinstance(item, dict)) if e]
        return events, iso(now)
    if source["kind"] == "table":
        if not warehouse:
            raise Unavailable("a table source needs --warehouse")
        if source.get("table") and not ws.table_exists(source["table"]):
            raise Unavailable(f"{source['table']} isn't there or you can't read it")
        since = cursor or source.get("start", "1970-01-01T00:00:00Z")
        rows = ws.sql(warehouse, source["query"], {"since": since})
        clock = {"now": now, "since": parse_time(since) or now - lookback}
        events = [e for e in (to_event(name, row, source.get("map", {}), clock) for row in rows) if e]
        watermark = source.get("watermark")
        marks = [str(row[watermark]) for row in rows if watermark and row.get(watermark) is not None]
        return events, max(marks + [since])
    raise Unavailable(f"unknown kind {source['kind']}")


def run(ws: Workspace, config: dict, hub: str | None, warehouse: str | None, dry_run=False, log: Callable[[str], None] = print, now: dt.datetime | None = None) -> dict:
    now = now or dt.datetime.now(dt.timezone.utc)
    hub = hub or config.get("hub")
    state = {} if dry_run or not hub else {s["source"]: s for s in ws.hub(hub, "GET", "/api/sources")["sources"]}
    summary: dict[str, Any] = {}
    for source in config.get("sources", []):
        name = source["name"]
        known = state.get(name)
        if not dry_run and not (known and known.get("enabled")):
            summary[name] = "off"
            continue
        try:
            events, cursor = poll_source(ws, source, known.get("cursor") if known else None, warehouse or config.get("warehouse"), now)
        except (NotSignedIn, Unavailable) as error:
            summary[name] = f"unavailable: {error}"
            log(f"{name}: {summary[name]}")
            if not dry_run:
                ws.hub(hub, "POST", "/api/cursor", {"source": name, "error": str(error)})
            continue
        except Exception as error:  # one source failing doesn't stop the others
            summary[name] = f"failed: {error}"
            log(f"{name}: {summary[name]}")
            if not dry_run:
                ws.hub(hub, "POST", "/api/cursor", {"source": name, "error": f"failed: {error}"[:900]})
            continue
        if dry_run:
            summary[name] = {"events": len(events), "sample": events[:3], "cursor": cursor}
            continue
        totals = {"new": 0, "changed": 0, "same": 0, "created": 0}
        for start in range(0, len(events), BATCH):
            reply = ws.hub(hub, "POST", "/api/events", {"events": events[start : start + BATCH]})
            for key in ("new", "changed", "same"):
                totals[key] += reply.get(key, 0)
            totals["created"] += len(reply.get("created", []))
        # The cursor moves only once the hub has the events.
        ws.hub(hub, "POST", "/api/cursor", {"source": name, "cursor": cursor, "error": ""})
        summary[name] = {"events": len(events), **totals}
        log(f"{name}: {summary[name]}")
    return summary


def main(argv: Iterable[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    parser.add_argument("--config", required=True, help="sources JSON (a workspace file or volume path)")
    parser.add_argument("--hub", help="the hub app's URL (or `hub` in the config)")
    parser.add_argument("--warehouse", help="SQL warehouse id, for table sources")
    parser.add_argument("--dry-run", action="store_true", help="poll every source and print, without the hub")
    args = parser.parse_args(list(argv) if argv is not None else None)
    with open(args.config) as file:
        config = json.load(file)
    summary = run(Workspace(), config, args.hub, args.warehouse, args.dry_run)
    print(json.dumps(summary, indent=2, default=str))
    return 0


if __name__ == "__main__":
    sys.exit(main())
