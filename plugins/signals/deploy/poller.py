"""Signals poller: reads one person's sources and posts what it finds to the signals hub.

Runs as a scheduled serverless Databricks job owned by that person, so it reads
their sources as them: the Unity Catalog MCP services (system.ai.gmail,
google_calendar, slack, ...) with their own sign-ins, and tables with their own
grants. It keeps no state: the hub says which sources the person turned on and
where each one stopped (its cursor).

    python poller.py --config sources.json [--hub https://<app-url> | --lakebase] [--warehouse <id>] [--dry-run]

How it reaches the hub:

- `--hub` calls the hub app's API. Databricks Apps only take OAuth tokens, so
  this works from a laptop (`databricks auth login`) but not from a job, whose
  token isn't one.
- `--lakebase` (for jobs) writes to the hub's inbox table in Lakebase instead,
  logged in as the job's owner's own Postgres role (a token from
  /api/2.0/postgres/credentials). Row-level security lets each person write
  only rows the hub reads as theirs, and read only their own sources. The hub
  drains the inbox every half minute. Config: `"lakebase": {"endpoint":
  "projects/<p>/branches/<b>/endpoints/<e>", "host": "<endpoint host>",
  "database": "databricks_postgres", "schema": "signals_<app name>"}`. It
  needs `psycopg[binary]` and a Postgres role for the person in the database.

- `hub_auth` in the config (with `--hub`) signs hub calls in with another
  profile than the default client's, for sources in another workspace than
  the hub's: `{"profile": "<name>"}`, a profile in ~/.databrickscfg for the
  hub's workspace. SQL and MCP calls stay on the default client
  (DATABRICKS_CONFIG_PROFILE picks its profile).

The config lists sources (see sources.example.json):

- kind "mcp": a tool of a system.ai MCP service. `args` and `map` are templates:
  "{since}" (the cursor, or `lookback_hours` ago, ISO 8601), "{now}", "{now+7d}",
  "{since_epoch}", and "{field}" for a field of the item being mapped.
  `items` is the path to the list in the tool's JSON result.
  `detail` (optional) fetches each item's full record with another tool of the
  same service and merges it into the item before mapping, for list tools that
  leave fields out (calendar_event_list has no attendees or description):
  {"tool": "calendar_event_get", "args": {"event_id": "{id}"}, "max": 50}.
  A detail call that fails leaves the item as the list gave it.
  `when` ({path: regex}) fetches it only for the items it matches; `named_in`
  (a path) only for items whose field names an account (its name or another
  name, as whole words; the hub serves them with the ids). With `after` (a path
  to the item's time), the versions not read before are read, oldest first.
  The cursor keeps which versions (id and time) were read: one read
  before isn't read or posted again, and one past `max`, or whose read failed,
  isn't posted and is read by a later poll. `max` counts reads tried, failed or
  not; versions never tried go before those that failed, which take turns. A source with `named_in` is
  unavailable (its cursor held) when the account names can't be read.
  `sections` (optional) is for tools that answer with Markdown instead of a JSON
  list (Slack search): {"split": "^### Result \\d+ of \\d+$"} cuts the text at
  `items` into one item per section, and each "Key: value" line starts a field
  (`key` lowercased, spaces as _) that runs until the next one. `keys` (optional)
  lists the only keys that start a field, so a "Note: ..." line inside a
  message's text stays in the text.
- kind "table": a SQL query with :since (the watermark) as a parameter.
  `table` is checked first; a table that isn't there (or can't be read) makes
  the source "unavailable" and it is skipped. The cursor is the largest
  `watermark` column seen.

Account ids: a source that covers every account names the kinds of account ids
it uses, `"ids": ["crm"]`, and gets every account's ids of each kind (set in
the account panel, or `ids` in the hub's config accounts; the hub serves them
at GET /api/ids, and in Lakebase as the account_ids table):

- a table source's query has `:crm`, which becomes bound parameters
  (`:crm_0, :crm_1, ...`), as in `WHERE account_id IN (:crm)`; the ids are
  never pasted into the SQL.
- an mcp source's args have `{crm: <clause with {}>}`, which becomes the clause
  once per id joined by OR, with `\\` and `"` in the id escaped:
  `({jira_customer: cf[10001] ~ "{}"})` -> `(cf[10001] ~ "Acme" OR cf[10001] ~ "Acme Co")`.

When no account has ids of a kind the source uses, it is skipped (reported as
unavailable, with why).

`map` turns an item into an event: external_id, title, url, actor, account,
group_key, occurred_at, and payload (a list of fields, "*" for the whole item,
or an object of specs). A spec is a path ("fields.summary"), a template
("{key}: {fields.summary}"), or {"from": <spec>, "match": <regex>}, which takes
the regex's first group (case-insensitive) and is left out without a match:
{"from": "title", "match": "workspace (\\d+)"}. `match` can be a list of regexes,
tried in order, and `"replace": "\\1:\\2"` builds the value from the groups.
"""

from __future__ import annotations

import argparse
import datetime as dt
import hashlib
import json
import re
import sys
import time
import unicodedata
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


def extract(found: Any, pattern: str | list[str], replace: str | None = None) -> Any:
    """The first capture group of `pattern` in `found` (or the whole match), case-insensitive; None without a match.

    `pattern` can be a list, tried in order (the first that matches wins). With
    `replace`, the result is that template with the match's groups in it
    (`\\1:\\2`), for a value made of several parts.
    """
    if found in (None, ""):
        return None
    text = found if isinstance(found, str) else json.dumps(found, default=str)
    for one in [pattern] if isinstance(pattern, str) else pattern:
        match = re.search(one, text, re.I)
        if not match:
            continue
        if replace is not None:
            return match.expand(replace).strip()
        groups = [group for group in match.groups() if group is not None]
        return (groups[0] if groups else match.group(0)).strip()
    return None


_FIELD = re.compile(r"^([A-Z][A-Za-z_ ]{0,30}):[ \t]?(.*)$")


def sections(text: Any, split: str, keys: Iterable[str] | None = None) -> list[dict]:
    """Markdown results as items: the text cut at `split` (a regex for a line), each "Key: value" line a field (only `keys`, when given)."""
    allowed = {key.lower() for key in keys} if keys else None
    if not isinstance(text, str):
        return []
    items = []
    for part in re.split(f"(?m){split}", text)[1:]:
        item: dict[str, str] = {}
        key = None
        for line in part.strip("\n").splitlines():
            if line.strip() == "---":
                continue
            found = _FIELD.match(line)
            if found and allowed is not None and found.group(1).strip().lower() not in allowed:
                found = None
            if found:
                key = found.group(1).strip().lower().replace(" ", "_")
                item[key] = found.group(2).strip()
            elif key:
                item[key] = (item[key] + "\n" + line.rstrip()).strip("\n")
        if item:
            items.append({k: v.strip() for k, v in item.items()})
    return items


def to_event(source: str, item: dict, mapping: dict, clock: dict[str, dt.datetime]) -> dict | None:
    """An item as a hub event, or None without an external_id."""

    def value(spec: Any) -> Any:
        if isinstance(spec, dict) and "match" in spec:
            found = extract(value(spec.get("from", "")), spec["match"], spec.get("replace"))
            # `max`: at most this many characters (long text, like a doc's notes, stays small on the hub).
            return found[: int(spec["max"])] if isinstance(found, str) and spec.get("max") else found
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


# ---------------------------------------------------------------------------
# Account ids in queries


def needed_ids(source: dict, ids: dict[str, list[str]]) -> dict[str, list[str]]:
    """The ids of each kind the source uses; Unavailable when an account has none of a kind."""
    kinds = source.get("ids") or []
    if isinstance(kinds, str):
        kinds = [kinds]
    missing = [kind for kind in kinds if not ids.get(kind)]
    if missing:
        raise Unavailable(f"no account has {', '.join(missing)} ids yet (add them in the account panel, as `{missing[0]}: ...`)")
    return {kind: list(ids[kind]) for kind in kinds}


def bind_ids(query: str, ids: dict[str, list[str]]) -> tuple[str, dict[str, str]]:
    """The query with each `:kind` as one bound parameter per id (`:kind_0, :kind_1`), and those parameters."""
    parameters: dict[str, str] = {}
    for kind, values in ids.items():
        names = [f"{kind}_{n}" for n in range(len(values))]
        parameters.update(zip(names, values))
        # `:kind` as a whole name, not part of `::cast` or a longer name.
        query = re.sub(rf"(?<![:\w]):{re.escape(kind)}(?!\w)", ", ".join(f":{name}" for name in names), query)
    return query, parameters


def quoted(value: str) -> str:
    """A value for inside a double-quoted string (JQL's): backslashes and quotes escaped."""
    return value.replace("\\", "\\\\").replace('"', '\\"')


def clause_ids(template: Any, ids: dict[str, list[str]]) -> Any:
    """`{kind: <clause with {}>}` in strings (recursively) as the clause once per id, joined by OR."""
    if isinstance(template, dict):
        return {key: clause_ids(value, ids) for key, value in template.items()}
    if isinstance(template, list):
        return [clause_ids(value, ids) for value in template]
    if not isinstance(template, str) or not ids:
        return template

    def one(match: re.Match) -> str:
        kind, clause = match.group(1), match.group(2)
        if kind not in ids:
            return match.group(0)
        return " OR ".join(clause.replace("{}", quoted(value)) for value in ids[kind])

    return re.sub(r"\{([a-z][a-z0-9_]*):\s?((?:[^{}]|\{\})*)\}", one, template)


def check_hub_auth(settings: Any) -> str | None:
    """What's wrong with a config's `hub_auth`, or None. It's {"profile": "<name>"}."""
    if not isinstance(settings, dict) or set(settings) != {"profile"}:
        return 'hub_auth is {"profile": "<name>"}, a profile in ~/.databrickscfg for the hub\'s workspace'
    if not isinstance(settings["profile"], str) or not settings["profile"]:
        return "hub_auth.profile is a profile name from ~/.databrickscfg"
    return None


def hub_client(settings: dict, make: Callable[..., Any] | None = None) -> Any:
    """The client for hub calls that `hub_auth` describes."""
    problem = check_hub_auth(settings)
    if problem:
        raise SystemExit(problem)
    if make is None:
        from databricks.sdk import WorkspaceClient as make
    try:
        return make(profile=settings["profile"])
    except Exception as error:
        raise RuntimeError(f"hub_auth: couldn't sign in with profile {settings['profile']!r}: {error}") from None


class Workspace:
    """Calls as the job's owner, through the Databricks SDK's auth. `hub_auth` (optional) signs hub calls in as someone else."""

    def __init__(self, client=None, hub_auth: dict | None = None, make_client: Callable[..., Any] | None = None):
        if client is None:
            from databricks.sdk import WorkspaceClient

            client = WorkspaceClient()
        self.client = client
        self.host = client.config.host.rstrip("/")
        self.hub_auth = hub_auth
        self.make_client = make_client
        self.hub_as: Any = None
        import requests

        self.http = requests.Session()

    def headers(self) -> dict:
        return {**self.client.config.authenticate(), "Content-Type": "application/json"}

    def hub_headers(self) -> dict:
        """Headers for a hub call: the default client's, or `hub_auth`'s client's (made on the first call)."""
        if self.hub_auth is None:
            return self.headers()
        if self.hub_as is None:
            self.hub_as = hub_client(self.hub_auth, self.make_client)
        return {**self.hub_as.config.authenticate(), "Content-Type": "application/json"}

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
        response = self.http.request(method, f"{base.rstrip('/')}{path}", headers=self.hub_headers(), json=body, timeout=120)
        if response.status_code >= 400:
            raise RuntimeError(f"hub {path}: HTTP {response.status_code} {response.text[:300]}")
        return response.json()


class LakebaseInbox:
    """The hub's API, as far as a poller needs it, through the inbox table in Lakebase."""

    def __init__(self, ws: Workspace, settings: dict, connect: Callable[[], Any] | None = None):
        missing = [key for key in ("endpoint", "host", "schema") if not settings.get(key)]
        if missing and connect is None:
            raise SystemExit("--lakebase needs " + ", ".join(f"lakebase.{key}" for key in missing) + " in the config")
        if not re.fullmatch(r"[a-z_][a-z0-9_]{0,62}", settings.get("schema", "")):
            raise SystemExit(f"lakebase.schema {settings.get('schema')!r} isn't a schema name")
        self.schema = settings["schema"]
        if connect is None:
            import psycopg

            user = ws.client.current_user.me().user_name
            token = ws.client.api_client.do("POST", "/api/2.0/postgres/credentials", body={"endpoint": settings["endpoint"]})["token"]
            self.db = psycopg.connect(host=settings["host"], port=int(settings.get("port", 5432)), dbname=settings.get("database", "databricks_postgres"), user=user, password=token, sslmode="require", autocommit=True)
        else:
            self.db = connect()

    def call(self, method: str, path: str, body: Any = None) -> Any:
        with self.db.cursor() as cursor:
            if (method, path) == ("GET", "/api/ids"):
                cursor.execute(f"SELECT kind, id FROM {self.schema}.account_ids ORDER BY kind, id")
                ids: dict[str, list[str]] = {}
                for kind, value in cursor.fetchall():
                    ids.setdefault(kind, []).append(value)
                # The hub keeps accounts' names there as kind `_name` (an id kind starts with a letter).
                return {"ids": {kind: values for kind, values in ids.items() if kind != "_name"}, "names": ids.get("_name", [])}
            if (method, path) == ("GET", "/api/sources"):
                # Row-level security returns only this person's sources.
                cursor.execute(f"SELECT source, enabled, cursor FROM {self.schema}.sources")
                return {"sources": [{"source": row[0], "enabled": row[1], "cursor": row[2]} for row in cursor.fetchall()]}
            if method == "POST" and path in ("/api/events", "/api/cursor"):
                cursor.execute(f"INSERT INTO {self.schema}.inbox (kind, body) VALUES (%s, %s)", ("events" if path == "/api/events" else "cursor", json.dumps(body, default=str)))
                return {"queued": True}
        raise RuntimeError(f"the inbox can't take {method} {path}")


# ---------------------------------------------------------------------------
# Polling


def name_words(text: str) -> str:
    """Text as its lowercase words, each with a space either side (the hub's whole-word name test)."""
    return " " + " ".join(re.findall(r"[^\W_]+", unicodedata.normalize("NFKD", text.lower()))) + " "


def names_one(value: Any, names: Iterable[str]) -> bool:
    """Whether the text names one of `names` (an account's name or other name) as whole words."""
    if not isinstance(value, str) or not value.strip():
        return False
    text = name_words(value)
    return any(spelled.strip() and spelled in text for spelled in (name_words(name) for name in names))


def detail_applies(detail: dict, item: dict, names: Iterable[str] | None = None) -> bool:
    """Whether `detail` is fetched for this item: every `when` field (a path) matches its pattern (case-insensitive),
    and with `named_in` (a path), that field names an account (`names`; none known reads nothing)."""
    for path, pattern in (detail.get("when") or {}).items():
        value = get_path(item, path)
        if value is None or not re.search(pattern, value if isinstance(value, str) else json.dumps(value, default=str), re.I):
            return False
    if detail.get("named_in") and not names_one(get_path(item, detail["named_in"]), names or ()):
        return False
    return True


def with_detail(ws: Workspace, service: str, detail: dict, item: dict, clock: dict[str, dt.datetime]) -> dict:
    """The item with its full record (from `detail`'s tool) merged in; the item as it was when that fails."""
    try:
        found = ws.mcp(service, detail["tool"], fill(detail.get("args", {}), item, clock))
    except NotSignedIn:
        raise
    except Exception:
        return item
    return {**item, **found} if isinstance(found, dict) else item


READ_KEEP = 150  # 17 characters each: the hub keeps 4,000 of a cursor


def version_key(item: dict, after: str) -> str:
    """A short key for one version of an item (its id and its time): which versions a poll read is kept in the cursor."""
    return hashlib.sha256(json.dumps([item.get("id"), get_path(item, after)], default=str).encode()).hexdigest()[:16]


def split_cursor(cursor: str | None) -> tuple[str | None, list[str], list[str]]:
    """A cursor's time and, for a source that reads details by version (`detail.after`), the versions it read and
    those whose read failed (least recently failed first)."""
    if cursor and cursor.startswith("{"):
        try:
            data = json.loads(cursor)
            return data.get("at"), [str(key) for key in data.get("read") or []], [str(key) for key in data.get("failed") or []]
        except ValueError:
            return None, [], []
    return cursor, [], []


def detailed(ws: Workspace, source: dict, detail: dict, items: list[dict], clock: dict[str, dt.datetime], read_before: list[str], names: Iterable[str] | None, failed_before: list[str] | None = None) -> tuple[list[dict], list[str], dt.datetime | None, list[str]]:
    """The items with `detail` fetched for those it applies to (at most `max` reads tried), the versions read so far,
    the time of the oldest one left unread (past the cap, or its read failed), and the versions whose read failed.

    Without `after`, the first `max` in the listing's order are read and the rest go as listed. With `after` (a
    path to the item's time), at most `max` reads are tried, failed or not, so an outage of the detail service costs
    one poll `max` calls at most. Versions never tried go first, oldest first, then those whose read failed before,
    least recently failed first, so a doc that keeps failing doesn't keep healthy ones waiting and each failed one
    gets its turn. One read before (it's in the cursor) isn't read or posted again, and one not read (past the cap,
    or its read failed) isn't posted (a version without its details would replace the one with them) and waits.
    Being read is tracked per version, not by time, so a burst within one second, equal times, or a doc that's
    listed late (older than the cursor) are all read in time.
    """
    service = source.get("service", source["name"])
    cap = int(detail.get("max", 50))
    after = detail.get("after")
    if not after:
        fetched, out = 0, []
        for item in items:
            if fetched < cap and detail_applies(detail, item, names):
                fetched += 1
                item = with_detail(ws, service, detail, item, clock)
            out.append(item)
        return out, [], None, []
    def when(item: dict) -> dt.datetime | None:
        value = get_path(item, after)
        return parse_time(value) if isinstance(value, str) else None
    seen = set(read_before)
    failed_rank = {key: n for n, key in enumerate(failed_before or [])}
    eligible = [item for item in items if detail_applies(detail, item, names)]
    keys = [version_key(item, after) for item in eligible]
    oldest = dt.datetime.min.replace(tzinfo=dt.timezone.utc)
    # Never tried first, oldest first (an item without a time after the timed ones, in the listing's order); then
    # the ones that failed before, least recently failed first.
    order = sorted(range(len(eligible)), key=lambda i: (keys[i] in failed_rank, failed_rank.get(keys[i], 0), when(eligible[i]) is None, when(eligible[i]) or oldest, i))
    read: dict[int, dict] = {}
    now_read: list[str] = []
    now_failed: list[str] = []
    tried = 0
    held: dt.datetime | None = None
    def hold(time_: dt.datetime | None) -> None:
        nonlocal held
        if time_ and (held is None or time_ < held):
            held = time_
    for i in order:
        item, key = eligible[i], keys[i]
        if key in seen:
            continue  # read by an earlier poll
        if tried >= cap:
            hold(when(item))
            continue
        tried += 1
        found = with_detail(ws, service, detail, item, clock)
        if found is item:  # the read failed: it waits for a later poll, behind the ones not tried yet
            hold(when(item))
            now_failed.append(key)
            continue
        read[id(item)] = found
        now_read.append(key)
        seen.add(key)
    # Keep the versions the listing still shows (older ones won't come back): read ones newest last, failed ones
    # least recently failed first, READ_KEEP in all (failed ones first, as they're still to read).
    listed = set(keys)
    failed = [key for key in failed_before or [] if key in listed and key not in seen and key not in now_failed] + now_failed
    failed = failed[-READ_KEEP:]
    kept = [key for key in read_before if key in listed and key not in now_read] + now_read
    remaining = READ_KEEP - len(failed)
    kept = kept[-remaining:] if remaining > 0 else []
    chosen = {id(item) for item in eligible}
    return [read[id(item)] if id(item) in read else item for item in items if id(item) not in chosen or id(item) in read], kept, held, failed


def poll_source(ws: Workspace, source: dict, cursor: str | None, warehouse: str | None, now: dt.datetime, ids: dict[str, list[str]] | None = None, names: Iterable[str] | None = None) -> tuple[list[dict], str]:
    """One source's events since its cursor, and its next cursor. `ids`: every account's ids, by kind; `names`: every account's names and other names."""
    lookback = dt.timedelta(hours=float(source.get("lookback_hours", 24)))
    name = source["name"]
    used = needed_ids(source, ids or {})
    if source["kind"] == "mcp":
        at, read_before, failed_before = split_cursor(cursor)
        since = parse_time(at) or now - lookback
        # Look back a little past the cursor: the hub dedupes, and sources index late.
        since = min(since, now) - dt.timedelta(minutes=float(source.get("overlap_minutes", 10)))
        clock = {"now": now, "since": since}
        data = ws.mcp(source.get("service", name), source["tool"], clause_ids(fill(source.get("args", {}), None, clock), used))
        items = get_path(data, source.get("items", "items")) if source.get("items", "items") else data
        if source.get("sections"):
            items = sections(items, source["sections"].get("split", r"^#+ .*$"), source["sections"].get("keys"))
        items = [item for item in items or [] if isinstance(item, dict)]
        detail = source.get("detail")
        next_cursor = iso(now)
        if detail and detail.get("after"):
            items, read_now, held, failed = detailed(ws, source, detail, items, clock, read_before, names, failed_before)
            # The versions read (and those that failed) go in the cursor; one left unread keeps its time from passing
            # (to the microsecond).
            at_ = min(held - dt.timedelta(microseconds=1), now) if held else now
            state = {"at": at_.astimezone(dt.timezone.utc).isoformat().replace("+00:00", "Z"), "read": read_now}
            if failed:
                state["failed"] = failed
            next_cursor = json.dumps(state, separators=(",", ":"))
        elif detail:
            items, _, _, _ = detailed(ws, source, detail, items, clock, [], names)
        events = [e for e in (to_event(name, item, source.get("map", {}), clock) for item in items) if e]
        return events, next_cursor
    if source["kind"] == "table":
        if not warehouse:
            raise Unavailable("a table source needs --warehouse")
        if source.get("table") and not ws.table_exists(source["table"]):
            raise Unavailable(f"{source['table']} isn't there or you can't read it")
        since = cursor or source.get("start", "1970-01-01T00:00:00Z")
        query, bound = bind_ids(source["query"], used)
        rows = ws.sql(warehouse, query, {"since": since, **bound})
        clock = {"now": now, "since": parse_time(since) or now - lookback}
        events = [e for e in (to_event(name, row, source.get("map", {}), clock) for row in rows) if e]
        watermark = source.get("watermark")
        marks = [str(row[watermark]) for row in rows if watermark and row.get(watermark) is not None]
        return events, max(marks + [since])
    raise Unavailable(f"unknown kind {source['kind']}")


def run(ws: Workspace, config: dict, hub: str | None, warehouse: str | None, dry_run=False, log: Callable[[str], None] = print, now: dt.datetime | None = None, inbox: LakebaseInbox | None = None) -> dict:
    """Polls the sources that are on. Reaches the hub at its URL, or through `inbox`."""
    now = now or dt.datetime.now(dt.timezone.utc)
    hub = hub or config.get("hub")
    if not dry_run and not hub and not inbox:
        raise SystemExit("Say where the hub is: --hub <app url> (or `hub` in the config), or --lakebase")

    def call(method: str, path: str, body: Any = None) -> Any:
        return inbox.call(method, path, body) if inbox else ws.hub(hub, method, path, body)

    state = {} if dry_run else {s["source"]: s for s in call("GET", "/api/sources")["sources"]}
    summary: dict[str, Any] = {}
    ids: dict[str, list[str]] = {}
    names: list[str] = []
    ids_error = ""
    on = [s for s in config.get("sources", []) if dry_run or (state.get(s["name"]) or {}).get("enabled")]
    wanted = [s for s in on if s.get("ids") or (s.get("detail") or {}).get("named_in")]
    if wanted and (hub or inbox):
        try:
            known_ids = call("GET", "/api/ids")
            ids, names = known_ids.get("ids") or {}, known_ids.get("names") or []
        except Exception as error:  # the sources that need ids are skipped, saying why
            ids_error = f"couldn't read account ids: {error}"[:600]
            log(ids_error)
    for source in config.get("sources", []):
        name = source["name"]
        known = state.get(name)
        if not dry_run and not (known and known.get("enabled")):
            summary[name] = "off"
            continue
        try:
            if ids_error and (source.get("ids") or (source.get("detail") or {}).get("named_in")):
                raise Unavailable(ids_error)
            events, cursor = poll_source(ws, source, known.get("cursor") if known else None, warehouse or config.get("warehouse"), now, ids, names)
        except (NotSignedIn, Unavailable) as error:
            summary[name] = f"unavailable: {error}"
            log(f"{name}: {summary[name]}")
            if not dry_run:
                call("POST", "/api/cursor", {"source": name, "error": str(error)})
            continue
        except Exception as error:  # one source failing doesn't stop the others
            summary[name] = f"failed: {error}"
            log(f"{name}: {summary[name]}")
            if not dry_run:
                call("POST", "/api/cursor", {"source": name, "error": f"failed: {error}"[:900]})
            continue
        if dry_run:
            summary[name] = {"events": len(events), "sample": events[:3], "cursor": cursor}
            continue
        totals = {"queued": 0} if inbox else {"new": 0, "changed": 0, "same": 0, "created": 0}
        for start in range(0, len(events), BATCH):
            reply = call("POST", "/api/events", {"events": events[start : start + BATCH]})
            if inbox:  # the hub handles it within a minute
                totals["queued"] += len(events[start : start + BATCH])
                continue
            for key in ("new", "changed", "same"):
                totals[key] += reply.get(key, 0)
            totals["created"] += len(reply.get("created", []))
        # The cursor moves only once the hub has the events (the inbox keeps them in order).
        call("POST", "/api/cursor", {"source": name, "cursor": cursor, "error": ""})
        summary[name] = {"events": len(events), **totals}
        log(f"{name}: {summary[name]}")
    return summary


def main(argv: Iterable[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    parser.add_argument("--config", required=True, help="sources JSON (a workspace file or volume path)")
    parser.add_argument("--hub", help="the hub app's URL (or `hub` in the config)")
    parser.add_argument("--lakebase", action="store_true", help="reach the hub through its inbox in Lakebase (for jobs; see `lakebase` in the config)")
    parser.add_argument("--warehouse", help="SQL warehouse id, for table sources")
    parser.add_argument("--dry-run", action="store_true", help="poll every source and print, without the hub")
    args = parser.parse_args(list(argv) if argv is not None else None)
    with open(args.config) as file:
        config = json.load(file)
    hub_auth = config.get("hub_auth")
    if hub_auth is not None:
        problem = check_hub_auth(hub_auth)
        if problem:
            raise SystemExit(problem)
        if args.lakebase:
            raise SystemExit("hub_auth is for calling the hub app (--hub <app url>, or `hub` in the config); --lakebase writes to the hub's inbox as the job's owner and can't use it. Use --hub instead.")
    ws = Workspace(hub_auth=hub_auth)
    inbox = LakebaseInbox(ws, config.get("lakebase") or {}) if args.lakebase and not args.dry_run else None
    summary = run(ws, config, args.hub, args.warehouse, args.dry_run, inbox=inbox)
    print(json.dumps(summary, indent=2, default=str))
    return 0


if __name__ == "__main__":
    # Only exit on failure: a Databricks job counts any SystemExit, even 0, as a failed task.
    code = main()
    if code:
        sys.exit(code)
