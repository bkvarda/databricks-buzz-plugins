// Databricks (bkvarda.databricks) — built by databricks-buzz-plugins. Apache-2.0.

// packages/core/src/api/workspace.ts
var DATABRICKS_HOST = /(^|\.)(cloud\.databricks\.com|azuredatabricks\.net|gcp\.databricks\.com|databricks\.com)$/i;
function isDatabricksHost(hostname) {
  return DATABRICKS_HOST.test(hostname) && !/^(www|docs|community|login|accounts|marketplace)\./i.test(hostname);
}
function parseWorkspaceUrl(raw) {
  let url;
  try {
    url = new URL(raw);
  } catch {
    return void 0;
  }
  if (url.protocol !== "https:" || !isDatabricksHost(url.hostname)) return void 0;
  const host = url.origin;
  const route = `${url.pathname}${url.hash.startsWith("#") ? `/${url.hash.slice(1)}` : ""}`;
  let m;
  if ((m = /\/jobs\/(\d+)\/runs\/(\d+)/.exec(route)) || (m = /\/job\/(\d+)\/run\/(\d+)/.exec(route)))
    return { kind: "run", host, jobId: m[1], runId: m[2] };
  if (m = /\/jobs\/runs\/(\d+)/.exec(route)) return { kind: "run", host, runId: m[1] };
  if ((m = /\/jobs\/(\d+)(?:\/|$|\?)/.exec(route)) || (m = /\/job\/(\d+)$/.exec(route))) return { kind: "job", host, jobId: m[1] };
  if (m = /\/pipelines\/([0-9a-f-]{36})(?:\/updates\/([0-9a-f-]{36}))?/.exec(route))
    return { kind: "pipeline", host, pipelineId: m[1], ...m[2] && { updateId: m[2] } };
  if ((m = /\/(?:sql\/)?dashboardsv3\/([0-9a-f]{32})/.exec(route)) || (m = /\/dashboards\/([0-9a-f]{32})/.exec(route)))
    return { kind: "dashboard", host, dashboardId: m[1] };
  if (m = /\/genie\/rooms\/([\w-]+)(?:\/chats\/([\w-]+))?/.exec(route))
    return { kind: "genie", host, spaceId: m[1], ...m[2] && { conversationId: m[2] } };
  if ((m = /\/editor\/notebooks\/(\d+)/.exec(route)) || (m = /\/notebook\/(\d+)/.exec(route)))
    return { kind: "notebook", host, notebookId: m[1] };
  if ((m = /\/sql\/editor\/([0-9a-f-]{36})/.exec(route)) || (m = /\/queries\/([0-9a-f-]{36})/.exec(route)))
    return { kind: "query", host, queryId: m[1] };
  if (m = /\/apps\/([a-z0-9-]+)/.exec(route)) return { kind: "app", host, name: m[1] };
  if (m = /\/explore\/data\/([^/]+)\/([^/]+)\/([^/?#]+)/.exec(route))
    return { kind: "table", host, fullName: [m[1], m[2], m[3]].map((part) => decodeURIComponent(part)).join(".") };
  if (url.pathname === "/" || url.pathname === "") return { kind: "workspace", host };
  return void 0;
}
var LINK_LABEL = {
  job: "Job",
  run: "Job run",
  pipeline: "Pipeline",
  dashboard: "Dashboard",
  notebook: "Notebook",
  query: "SQL query",
  genie: "Genie",
  app: "App",
  table: "Table",
  workspace: "Workspace"
};
var finished = /* @__PURE__ */ new Set(["TERMINATED", "SKIPPED", "INTERNAL_ERROR"]);
function runTone(status) {
  if (!status.done) return "active";
  if (status.result === "SUCCESS") return "success";
  if (status.result === "CANCELED" || status.result === "SKIPPED") return "neutral";
  if (status.result === "SUCCESS_WITH_FAILURES") return "warning";
  return "danger";
}
function runLabel(status) {
  if (!status.done) return { PENDING: "Pending", QUEUED: "Queued", RUNNING: "Running", TERMINATING: "Finishing", BLOCKED: "Blocked", WAITING: "Waiting" }[status.lifecycle] ?? status.lifecycle.toLowerCase();
  return { SUCCESS: "Succeeded", FAILED: "Failed", TIMEDOUT: "Timed out", CANCELED: "Cancelled", SKIPPED: "Skipped", SUCCESS_WITH_FAILURES: "Succeeded with failures", UPSTREAM_FAILED: "Upstream failed" }[status.result ?? ""] ?? (status.result ?? "Finished").toLowerCase();
}
var Jobs = class {
  constructor(client) {
    this.client = client;
  }
  async run(runId, signal) {
    const run = await this.client.get("/api/2.2/jobs/runs/get", { query: { run_id: runId }, ...signal && { signal } });
    const lifecycle = run.state?.life_cycle_state ?? run.status?.state ?? "UNKNOWN";
    const result = run.state?.result_state ?? (run.status?.state === "TERMINATED" ? run.status.termination_details?.code : void 0);
    return {
      runId: String(run.run_id),
      ...run.job_id !== void 0 && { jobId: String(run.job_id) },
      name: run.run_name ?? `Run ${run.run_id}`,
      lifecycle,
      ...result && { result },
      ...(run.state?.state_message || run.status?.termination_details?.message) && {
        message: run.state?.state_message || run.status?.termination_details?.message
      },
      ...run.start_time && { startTime: run.start_time },
      ...run.end_time && { endTime: run.end_time },
      ...run.run_page_url && { url: run.run_page_url },
      done: finished.has(lifecycle),
      tasks: (run.tasks ?? []).map((task) => ({
        key: task.task_key,
        lifecycle: task.state?.life_cycle_state ?? "",
        ...task.state?.result_state && { result: task.state.result_state },
        ...task.state?.state_message && { message: task.state.state_message }
      }))
    };
  }
  async job(jobId, signal) {
    const job = await this.client.get(
      "/api/2.2/jobs/get",
      { query: { job_id: jobId }, ...signal && { signal } }
    );
    const runs = await this.client.get("/api/2.2/jobs/runs/list", { query: { job_id: jobId, limit: 1 }, ...signal && { signal } }).catch(() => ({ runs: [] }));
    const latest = runs.runs?.[0];
    return {
      jobId: String(job.job_id),
      name: job.settings?.name ?? `Job ${job.job_id}`,
      latest: latest ? await this.run(String(latest.run_id), signal).catch(() => void 0) : void 0
    };
  }
  runNow(jobId) {
    return this.client.post("/api/2.2/jobs/run-now", { job_id: Number(jobId) });
  }
  async pipeline(pipelineId, signal) {
    const pipeline = await this.client.get(`/api/2.0/pipelines/${encodeURIComponent(pipelineId)}`, signal ? { signal } : {});
    return {
      name: pipeline.name ?? "Pipeline",
      state: pipeline.state ?? "UNKNOWN",
      latest: pipeline.latest_updates?.[0]
    };
  }
};

// packages/core/src/process.ts
var DesktopOnlyError = class extends Error {
  constructor() {
    super("This needs the Buzz desktop app.");
    this.name = "DesktopOnlyError";
  }
};
var ProcessError = class extends Error {
  constructor(message, code, stdout, stderr) {
    super(message);
    this.code = code;
    this.stdout = stdout;
    this.stderr = stderr;
    this.name = "ProcessError";
  }
};
async function runProcess(host, id, options = {}) {
  if (!host.spawn) throw new DesktopOnlyError();
  options.signal?.throwIfAborted();
  let stdout = "";
  let stderr = "";
  const child = await host.spawn(id, {
    ...options.args && { args: options.args },
    ...options.env && { env: options.env },
    onStdout(data) {
      stdout += data;
      options.onStdout?.(data);
    },
    onStderr(data) {
      stderr += data;
      options.onStderr?.(data);
    }
  });
  let timedOut = false;
  const kill = () => void child.kill().catch(() => {
  });
  const timer = options.timeoutMs === void 0 ? void 0 : setTimeout(() => {
    timedOut = true;
    kill();
  }, options.timeoutMs);
  options.signal?.addEventListener("abort", kill, { once: true });
  try {
    await child.end(options.input ?? "").catch(() => {
    });
    const code = await child.exited;
    options.signal?.throwIfAborted();
    if (timedOut)
      throw new ProcessError("Timed out", code, stdout, stderr);
    return { code, stdout, stderr };
  } finally {
    if (timer) clearTimeout(timer);
    options.signal?.removeEventListener("abort", kill);
  }
}

// packages/core/src/cli.ts
var CLI_PROCESSES = {
  version: "cli-version",
  profiles: "cli-profiles",
  token: "cli-token",
  login: "cli-login",
  install: "cli-install"
};
var CliMissingError = class extends Error {
  constructor() {
    super("The Databricks CLI is not installed.");
    this.name = "CliMissingError";
  }
};
var SignInRequiredError = class extends Error {
  constructor(message = "Sign in to Databricks again.") {
    super(message);
    this.name = "SignInRequiredError";
  }
};
var EXPIRY_MARGIN_MS = 3 * 6e4;
var DEFAULT_LIFETIME_MS = 30 * 6e4;
var missingProgram = (error) => /no such file|not found|cannot find|os error 2|enoent/i.test(String(error));
function signInNeeded(stderr) {
  return /refresh token|invalid_grant|re-?auth|auth login|no token|cache|expired|not found in cache|cannot find/i.test(
    stderr
  );
}
function parseProfiles(stdout) {
  const parsed = JSON.parse(stdout);
  return (parsed.profiles ?? []).flatMap((raw) => {
    const name = typeof raw.name === "string" ? raw.name : void 0;
    const host = typeof raw.host === "string" ? raw.host : void 0;
    if (!name || !host) return [];
    const text = (key) => typeof raw[key] === "string" && raw[key] ? raw[key] : void 0;
    const profile = { name, host: normalizeHost(host) };
    const authType = text("auth_type");
    const workspaceId = text("workspace_id");
    const accountId = text("account_id");
    const cloud = text("cloud");
    if (authType) profile.authType = authType;
    if (workspaceId) profile.workspaceId = workspaceId;
    if (accountId) profile.accountId = accountId;
    if (cloud) profile.cloud = cloud;
    return [profile];
  });
}
function parseToken(stdout, now = Date.now()) {
  const parsed = JSON.parse(stdout);
  if (typeof parsed.access_token !== "string" || !parsed.access_token)
    throw new Error("The Databricks CLI returned no access token.");
  const expiry = typeof parsed.expiry === "string" ? Date.parse(parsed.expiry) : Number.NaN;
  const expiresAt = Number.isFinite(expiry) ? expiry : typeof parsed.expires_in === "number" ? now + parsed.expires_in * 1e3 : now + DEFAULT_LIFETIME_MS;
  return { accessToken: parsed.access_token, expiresAt };
}
function normalizeHost(host) {
  const trimmed = host.trim().replace(/\/+$/, "");
  const withScheme = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
  const url = new URL(withScheme);
  return `https://${url.host.toLowerCase()}`;
}
var isWorkspaceProfile = (profile) => !/^https:\/\/accounts(\.[a-z-]+)?\.(cloud\.)?databricks\.(com|net)|^https:\/\/accounts\.azuredatabricks\.net/i.test(
  profile.host
);
var DatabricksCli = class {
  constructor(host) {
    this.host = host;
  }
  tokens = /* @__PURE__ */ new Map();
  pending = /* @__PURE__ */ new Map();
  /** The installed CLI version, or undefined when it is not installed. */
  async version() {
    try {
      const result = await runProcess(this.host, CLI_PROCESSES.version, {
        timeoutMs: 15e3
      });
      if (result.code !== 0) return void 0;
      return /v?(\d+\.\d+\.\d+)/.exec(result.stdout)?.[1] ?? result.stdout.trim();
    } catch (error) {
      if (missingProgram(error)) return void 0;
      throw error;
    }
  }
  async profiles() {
    const result = await this.run(CLI_PROCESSES.profiles, [], 2e4);
    if (result.code !== 0)
      throw new Error(result.stderr.trim() || "Could not read profiles.");
    return parseProfiles(result.stdout || '{"profiles":[]}');
  }
  /** A current access token; refreshes it through the CLI when needed. */
  token(target, options = {}) {
    const key = target.profile;
    const cached = this.tokens.get(key);
    if (!options.force && cached && cached.expiresAt - EXPIRY_MARGIN_MS > Date.now())
      return Promise.resolve(cached);
    const inFlight = this.pending.get(key);
    if (inFlight && !options.force) return inFlight;
    const request = (async () => {
      const args = ["--profile", target.profile];
      if (options.force) args.push("--force-refresh");
      const result = await this.run(CLI_PROCESSES.token, args, 6e4);
      if (result.code !== 0) {
        this.tokens.delete(key);
        const message = result.stderr.trim();
        if (signInNeeded(message)) throw new SignInRequiredError();
        throw new Error(message || "Could not get a Databricks token.");
      }
      const token = parseToken(result.stdout);
      this.tokens.set(key, token);
      return token;
    })().finally(() => this.pending.delete(key));
    this.pending.set(key, request);
    return request;
  }
  forget(target) {
    this.tokens.delete(target.profile);
  }
  /**
   * Browser sign-in. Without a host, the CLI opens login.databricks.com,
   * where the person signs in and picks their workspace; the profile then
   * records it. Resolves once the browser flow finishes.
   */
  async login(target, signal) {
    const args = ["--profile", target.profile];
    if (target.host) args.push("--host", normalizeHost(target.host));
    if (target.scopes) args.push("--scopes", target.scopes);
    const result = await this.run(CLI_PROCESSES.login, args, 15 * 6e4, signal);
    this.tokens.delete(target.profile);
    if (result.code !== 0) {
      throw new Error(
        result.stderr.trim().split("\n").pop() || "Sign-in did not finish."
      );
    }
  }
  /** Installs the CLI into ~/.local/bin after verifying its checksum. */
  async install(signal) {
    const result = await runProcess(this.host, CLI_PROCESSES.install, {
      timeoutMs: 5 * 6e4,
      ...signal && { signal }
    });
    if (result.code !== 0)
      throw new ProcessError(
        result.stderr.trim() || "Installing the Databricks CLI failed.",
        result.code,
        result.stdout,
        result.stderr
      );
    return result.stdout.trim();
  }
  async run(id, args, timeoutMs, signal) {
    try {
      return await runProcess(this.host, id, {
        args,
        timeoutMs,
        ...signal && { signal },
        // Never let the CLI open an interactive prompt or a pager.
        env: { DATABRICKS_CLI_PAGER: null, PAGER: "cat" }
      });
    } catch (error) {
      if (missingProgram(error)) throw new CliMissingError();
      throw error;
    }
  }
};

// packages/core/src/sse.ts
var SseParser = class {
  constructor(onEvent) {
    this.onEvent = onEvent;
  }
  buffer = "";
  data = [];
  event = "";
  id;
  push(chunk) {
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
  end() {
    if (this.buffer) this.line(this.buffer);
    this.buffer = "";
    this.line("");
  }
  line(line) {
    if (line === "") {
      if (this.data.length) {
        this.onEvent({
          event: this.event || "message",
          data: this.data.join("\n"),
          ...this.id !== void 0 && { id: this.id }
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
};

// packages/core/src/client.ts
var USER_AGENT = "databricks-buzz-plugins/0.1.0";
var DatabricksApiError = class extends Error {
  constructor(status, errorCode, message, body) {
    super(message);
    this.status = status;
    this.errorCode = errorCode;
    this.body = body;
    this.name = "DatabricksApiError";
  }
  get isPermission() {
    return this.status === 403 || this.errorCode === "PERMISSION_DENIED";
  }
  get isNotFound() {
    return this.status === 404 || this.errorCode === "RESOURCE_DOES_NOT_EXIST" || this.errorCode === "NOT_FOUND";
  }
  get isFeatureDisabled() {
    return this.errorCode === "FEATURE_DISABLED" || this.errorCode === "NOT_IMPLEMENTED" || /not enabled|feature.*disabled|preview/i.test(this.message);
  }
};
function apiError(response) {
  let code;
  let message = `Databricks returned HTTP ${response.status}`;
  try {
    const parsed = JSON.parse(response.body);
    code = parsed.error_code ?? (typeof parsed.error === "object" ? parsed.error?.code : void 0);
    message = parsed.message ?? (typeof parsed.error === "object" ? parsed.error?.message : parsed.error) ?? parsed.error_description ?? message;
  } catch {
    const text = response.body.trim();
    if (text && text.length < 400 && !text.startsWith("<")) message = text;
  }
  return new DatabricksApiError(response.status, code, message, response.body);
}
var IDEMPOTENT = /* @__PURE__ */ new Set(["GET", "HEAD", "PUT", "DELETE"]);
var sleep = (ms, signal) => new Promise((resolve, reject) => {
  const timer = setTimeout(resolve, ms);
  signal?.addEventListener(
    "abort",
    () => {
      clearTimeout(timer);
      reject(signal.reason);
    },
    { once: true }
  );
});
var DatabricksClient = class {
  constructor(options) {
    this.options = options;
    this.host = options.host.replace(/\/+$/, "");
    this.workspaceId = options.workspaceId;
  }
  host;
  workspaceId;
  url(path, query) {
    const url = new URL(
      /^https:\/\//.test(path) ? path : `${this.host}${path.startsWith("/") ? "" : "/"}${path}`
    );
    for (const [key, value] of Object.entries(query ?? {}))
      if (value !== void 0) url.searchParams.set(key, String(value));
    return url.toString();
  }
  /** Raw request; never throws for HTTP status. */
  async request(path, init = {}, onBody) {
    const method = init.method ?? (init.body === void 0 ? "GET" : "POST");
    const body = init.body === void 0 ? void 0 : typeof init.body === "string" ? init.body : JSON.stringify(init.body);
    const send = async (force) => {
      const token = await this.options.token({ force });
      return this.options.transport({
        url: this.url(path, init.query),
        method,
        headers: {
          Authorization: `Bearer ${token}`,
          "User-Agent": this.options.userAgent ?? USER_AGENT,
          Accept: "application/json",
          ...body !== void 0 && { "Content-Type": "application/json" },
          ...this.workspaceId && {
            "X-Databricks-Workspace-Id": this.workspaceId
          },
          ...init.headers
        },
        ...body !== void 0 && { body },
        ...init.timeoutMs !== void 0 && { timeoutMs: init.timeoutMs },
        ...init.signal && { signal: init.signal },
        ...onBody && { onBody }
      });
    };
    let response = await send(false);
    if (response.status === 401) response = await send(true);
    for (let attempt = 0; attempt < 3 && (response.status === 429 || response.status === 503) && IDEMPOTENT.has(method) && !onBody; attempt++) {
      const retryAfter = Number(response.headers["retry-after"]);
      await sleep(
        Number.isFinite(retryAfter) && retryAfter > 0 ? Math.min(retryAfter * 1e3, 2e4) : 500 * 2 ** attempt + Math.random() * 250,
        init.signal
      );
      response = await send(false);
    }
    return response;
  }
  async json(path, init = {}) {
    const response = await this.request(path, init);
    if (response.status < 200 || response.status >= 300) throw apiError(response);
    if (!response.body.trim()) return {};
    return JSON.parse(response.body);
  }
  get(path, init = {}) {
    return this.json(path, { ...init, method: "GET" });
  }
  post(path, body, init = {}) {
    return this.json(path, { ...init, method: "POST", body: body ?? {} });
  }
  /** Streams an SSE response. Resolves with the final HTTP response. */
  async stream(path, init, onEvent) {
    const parser = new SseParser(onEvent);
    let ok = true;
    const response = await this.request(
      path,
      {
        ...init,
        headers: { Accept: "text/event-stream", ...init.headers }
      },
      (chunk) => {
        if (ok) parser.push(chunk);
      }
    );
    if (response.status < 200 || response.status >= 300) {
      ok = false;
      throw apiError(response);
    }
    parser.end();
    return response;
  }
};

// packages/core/src/curl.ts
var TransportError = class extends Error {
  constructor(message, code) {
    super(message);
    this.code = code;
    this.name = "TransportError";
  }
};
var DEFAULT_TIMEOUT_MS = 6e4;
function curlQuote(value) {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n").replace(/\r/g, "\\r").replace(/\t/g, "\\t").replace(/\v/g, "\\v")}"`;
}
var HEADER_NAME = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;
var endMarker = (nonce) => `
--dbx-curl-end-${nonce} `;
function curlConfig(request, nonce) {
  const url = new URL(request.url);
  if (url.protocol !== "https:")
    throw new TransportError("Only HTTPS URLs are allowed", null);
  if (url.username || url.password)
    throw new TransportError("URLs must not contain credentials", null);
  const lines = [
    `url = ${curlQuote(url.toString())}`,
    `request = ${curlQuote(request.method ?? (request.body === void 0 ? "GET" : "POST"))}`,
    `max-time = ${Math.ceil((request.timeoutMs ?? DEFAULT_TIMEOUT_MS) / 1e3)}`,
    `connect-timeout = 15`,
    // Suppress `Expect: 100-continue`, so one header block precedes the body.
    `header = "Expect:"`
  ];
  for (const [name, value] of Object.entries(request.headers ?? {})) {
    if (!HEADER_NAME.test(name) || /[\r\n]/.test(value))
      throw new TransportError(`Invalid header ${name}`, null);
    lines.push(`header = ${curlQuote(`${name}: ${value}`)}`);
  }
  if (nonce) lines.push(`write-out = ${curlQuote(`${endMarker(nonce)}%{size_download}
`)}`);
  if (request.method === "HEAD") lines.push("head");
  if (request.body !== void 0) {
    lines.push(`data-raw = ${curlQuote(request.body)}`);
  }
  return `${lines.join("\n")}
`;
}
function splitHead(text) {
  let remaining = text;
  for (; ; ) {
    const match = /\r?\n\r?\n/.exec(remaining);
    if (!match) return void 0;
    const block = remaining.slice(0, match.index);
    remaining = remaining.slice(match.index + match[0].length);
    const [statusLine = "", ...lines] = block.split(/\r?\n/);
    const status = Number(/^HTTP\/[\d.]+\s+(\d{3})/.exec(statusLine)?.[1]);
    if (!Number.isFinite(status)) return void 0;
    if (status >= 100 && status < 200) continue;
    const headers = {};
    for (const line of lines) {
      const colon = line.indexOf(":");
      if (colon <= 0) continue;
      headers[line.slice(0, colon).trim().toLowerCase()] = line.slice(colon + 1).trim();
    }
    return { head: { status, headers }, rest: remaining };
  }
}
var parseHeaderLines = (text) => {
  const headers = {};
  for (const line of text.split(/\r?\n/)) {
    const colon = line.indexOf(":");
    if (colon > 0) headers[line.slice(0, colon).trim().toLowerCase()] = line.slice(colon + 1).trim();
  }
  return headers;
};
function bodyAndTrailers(text, nonce) {
  const marker = endMarker(nonce);
  const at = text.lastIndexOf(marker);
  if (at < 0) return { body: text, trailers: {} };
  const payload = text.slice(0, at);
  const size = Number(/^(\d+)/.exec(text.slice(at + marker.length))?.[1]);
  if (!Number.isFinite(size)) return { body: payload, trailers: {} };
  const bytes = new TextEncoder().encode(payload);
  if (bytes.length <= size) return { body: payload, trailers: {} };
  const decoder = new TextDecoder();
  return { body: decoder.decode(bytes.slice(0, size)), trailers: parseHeaderLines(decoder.decode(bytes.slice(size))) };
}
var nonceOf = () => {
  const bytes = new Uint8Array(9);
  globalThis.crypto.getRandomValues(bytes);
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
};
function curlTransport(host, processId = "curl") {
  return async (request) => {
    if (!host.spawn) throw new DesktopOnlyError();
    request.signal?.throwIfAborted();
    const nonce = nonceOf();
    const config = curlConfig(request, nonce);
    const holdBack = endMarker(nonce).length + 24;
    let raw = "";
    let stderr = "";
    let head;
    let body = "";
    let emitted = 0;
    const emit = (final) => {
      if (!request.onBody) return;
      const ready = final ?? body.slice(0, Math.max(0, body.length - holdBack));
      if (ready.length > emitted) {
        request.onBody(ready.slice(emitted));
        emitted = ready.length;
      }
    };
    const child = await host.spawn(processId, {
      onStdout(data) {
        if (head) {
          body += data;
          emit(void 0);
          return;
        }
        raw += data;
        const split = splitHead(raw);
        if (!split) return;
        head = split.head;
        raw = "";
        body += split.rest;
        emit(void 0);
      },
      onStderr(data) {
        stderr += data;
      }
    });
    const kill = () => void child.kill().catch(() => {
    });
    request.signal?.addEventListener("abort", kill, { once: true });
    try {
      await child.end(config);
      const code = await child.exited;
      request.signal?.throwIfAborted();
      if (!head) {
        const message = stderr.trim().replace(/^curl:\s*/, "") || `curl exited with ${code ?? "a signal"}`;
        throw new TransportError(message, code);
      }
      const clean = bodyAndTrailers(body, nonce);
      emit(clean.body);
      return { status: head.status, headers: { ...clean.trailers, ...head.headers }, body: clean.body };
    } finally {
      request.signal?.removeEventListener("abort", kill);
    }
  };
}

// packages/core/src/connection.ts
var browserStorage = {
  get: (key) => {
    try {
      return globalThis.localStorage?.getItem(key) ?? null;
    } catch {
      return null;
    }
  },
  set: (key, value) => {
    try {
      if (value === null) globalThis.localStorage?.removeItem(key);
      else globalThis.localStorage?.setItem(key, value);
    } catch {
    }
  }
};
var SELECTION_KEY = "bkvarda.databricks.connection.v1";
var BUZZ_PROFILE = "buzz";
var Connection = class {
  constructor(host, storage = browserStorage, transport) {
    this.host = host;
    this.storage = storage;
    this.cli = new DatabricksCli(host);
    this.transport = transport ?? curlTransport(host);
  }
  state = { status: "checking" };
  listeners = /* @__PURE__ */ new Set();
  profiles = [];
  current;
  login;
  generation = 0;
  cli;
  transport;
  snapshot = () => this.state;
  subscribe = (listener) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };
  /** The client for the connected workspace, or undefined. */
  client() {
    return this.state.status === "connected" ? this.current?.client : void 0;
  }
  /** Resolves with a client once connected; rejects if it cannot connect. */
  async ready(signal, timeoutMs = 2e4) {
    const settled = () => {
      const s = this.state.status;
      return s !== "checking" && s !== "connecting";
    };
    if (!settled())
      await new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          stop();
          resolve();
        }, timeoutMs);
        const stop = this.subscribe(() => {
          if (!settled()) return;
          clearTimeout(timer);
          stop();
          resolve();
        });
        signal?.addEventListener("abort", () => {
          clearTimeout(timer);
          stop();
          reject(signal.reason);
        });
      });
    const client = this.client();
    if (client) return client;
    throw new NotConnectedError(this.state);
  }
  async start() {
    const generation = ++this.generation;
    this.set({ status: "checking" });
    if (!this.host.spawn) {
      this.set({ status: "unsupported", message: "Databricks plugins need the Buzz desktop app." });
      return;
    }
    try {
      const version = await this.cli.version();
      if (generation !== this.generation) return;
      if (!version) {
        this.set({ status: "cli-missing" });
        return;
      }
      await this.reloadProfiles();
      if (generation !== this.generation) return;
      const saved = this.savedProfile();
      const candidate = (saved && this.profiles.find((profile) => profile.name === saved)) ?? (saved ? void 0 : this.profiles.find((profile) => profile.name === "DEFAULT"));
      if (candidate && isWorkspaceProfile(candidate)) {
        await this.connect(candidate, { silent: !saved });
        return;
      }
      this.set({ status: "signed-out", profiles: this.workspaceProfiles() });
    } catch (error) {
      if (generation !== this.generation) return;
      if (error instanceof CliMissingError) this.set({ status: "cli-missing" });
      else if (error instanceof DesktopOnlyError)
        this.set({ status: "unsupported", message: error.message });
      else this.set({ status: "signed-out", profiles: this.workspaceProfiles(), error: String(error.message ?? error) });
    }
  }
  /** Uses an existing CLI profile. */
  async useProfile(name) {
    await this.reloadProfiles();
    const profile = this.profiles.find((candidate) => candidate.name === name);
    if (!profile) throw new Error(`No profile named ${name}`);
    await this.connect(profile, { silent: false });
  }
  /**
   * Browser sign-in. With a host, signs in to that workspace; without one,
   * login.databricks.com lets the person pick a workspace.
   */
  async signIn(options = {}) {
    this.login?.abort();
    const controller = new AbortController();
    this.login = controller;
    const host = options.host ? normalizeHost(options.host) : void 0;
    const name = options.profile ?? (host ? this.profiles.find((profile) => profile.host === host)?.name ?? this.freshProfileName(host) : this.freshProfileName());
    this.set({ status: "signing-in", profiles: this.workspaceProfiles(), ...host && { host } });
    try {
      await this.cli.login({ profile: name, ...host && { host } }, controller.signal);
      await this.reloadProfiles();
      const profile = this.profiles.find((candidate) => candidate.name === name);
      if (!profile) throw new Error("Sign-in finished, but no profile was saved.");
      await this.connect(profile, { silent: false });
    } catch (error) {
      if (controller.signal.aborted) {
        this.set({ status: "signed-out", profiles: this.workspaceProfiles() });
        return;
      }
      this.set({
        status: "signed-out",
        profiles: this.workspaceProfiles(),
        error: error.message ?? String(error)
      });
    } finally {
      if (this.login === controller) this.login = void 0;
    }
  }
  cancelSignIn() {
    this.login?.abort();
  }
  /** Signs in again to the current profile's workspace. */
  async reauthenticate() {
    const profile = this.state.status === "connected" || this.state.status === "error" ? this.state.profile : void 0;
    if (!profile) return this.signIn();
    return this.signIn({ host: profile.host, profile: profile.name });
  }
  /** Forgets the selection on this device. The CLI keeps its sign-in. */
  disconnect() {
    this.generation++;
    this.storage.set(SELECTION_KEY, null);
    this.current = void 0;
    this.set({ status: "signed-out", profiles: this.workspaceProfiles() });
  }
  async installCli() {
    this.set({ status: "cli-missing", installing: true });
    try {
      await this.cli.install();
      await this.start();
    } catch (error) {
      this.set({ status: "cli-missing", error: error.message ?? String(error) });
    }
  }
  /** A Databricks web URL in the connected workspace. */
  workspaceUrl(path) {
    if (this.state.status !== "connected") return void 0;
    const url = new URL(path, this.state.profile.host);
    const workspaceId = this.state.workspaceId ?? this.state.profile.workspaceId;
    if (workspaceId && !url.searchParams.has("o")) url.searchParams.set("o", workspaceId);
    return url.toString();
  }
  async connect(profile, options) {
    const generation = ++this.generation;
    this.set({ status: "connecting", profile });
    const client = new DatabricksClient({
      host: profile.host,
      ...profile.workspaceId && { workspaceId: profile.workspaceId },
      transport: this.transport,
      token: async (tokenOptions) => (await this.cli.token({ profile: profile.name }, tokenOptions)).accessToken
    });
    try {
      const response = await client.request("/api/2.0/preview/scim/v2/Me", {
        query: { attributes: "id,userName,displayName" },
        timeoutMs: 3e4
      });
      if (generation !== this.generation) return;
      if (response.status === 401 || response.status === 403)
        throw new SignInRequiredError("Your Databricks sign-in has expired.");
      if (response.status < 200 || response.status >= 300)
        throw new Error(`Databricks returned HTTP ${response.status}`);
      const me = JSON.parse(response.body);
      const workspaceId = response.headers["x-databricks-org-id"] ?? profile.workspaceId;
      const routed = workspaceId && workspaceId !== profile.workspaceId ? new DatabricksClient({
        host: profile.host,
        workspaceId,
        transport: this.transport,
        token: async (tokenOptions) => (await this.cli.token({ profile: profile.name }, tokenOptions)).accessToken
      }) : client;
      this.current = { profile, client: routed };
      this.storage.set(SELECTION_KEY, JSON.stringify({ profile: profile.name }));
      this.set({
        status: "connected",
        profile,
        user: {
          userName: me.userName ?? "unknown",
          ...me.id && { id: me.id },
          ...me.displayName && { displayName: me.displayName }
        },
        ...workspaceId && { workspaceId },
        profiles: this.workspaceProfiles()
      });
    } catch (error) {
      if (generation !== this.generation) return;
      const needsSignIn = error instanceof SignInRequiredError;
      if (options.silent) {
        this.set({ status: "signed-out", profiles: this.workspaceProfiles() });
        return;
      }
      this.set({
        status: "error",
        profile,
        profiles: this.workspaceProfiles(),
        message: needsSignIn ? "Your Databricks sign-in has expired." : error.message ?? String(error),
        needsSignIn
      });
    }
  }
  async reloadProfiles() {
    this.profiles = await this.cli.profiles();
  }
  workspaceProfiles() {
    return this.profiles.filter(isWorkspaceProfile);
  }
  savedProfile() {
    try {
      const saved = JSON.parse(this.storage.get(SELECTION_KEY) ?? "null");
      return typeof saved?.profile === "string" ? saved.profile : void 0;
    } catch {
      return void 0;
    }
  }
  freshProfileName(host) {
    const base = host ? `${BUZZ_PROFILE}-${new URL(host).hostname.split(".")[0]?.replace(/[^a-z0-9-]/gi, "-").toLowerCase()}` : BUZZ_PROFILE;
    const taken = new Set(this.profiles.map((profile) => profile.name));
    if (!taken.has(base)) return base;
    for (let n = 2; ; n++) if (!taken.has(`${base}-${n}`)) return `${base}-${n}`;
  }
  set(state) {
    this.state = state;
    for (const listener of [...this.listeners]) listener();
  }
};
var NotConnectedError = class extends Error {
  constructor(snapshot) {
    super(
      snapshot.status === "cli-missing" ? "Databricks isn't set up yet: install the Databricks CLI in Settings \u2192 Databricks." : snapshot.status === "error" && snapshot.needsSignIn ? "The Databricks sign-in expired. Sign in again in Settings \u2192 Databricks." : "Not connected to Databricks. Connect in Settings \u2192 Databricks."
    );
    this.snapshot = snapshot;
    this.name = "NotConnectedError";
  }
};

// packages/core/src/host-types.ts
function optionalService(ctx, name) {
  try {
    return ctx.reflect?.get?.(name);
  } catch {
    return void 0;
  }
}
var schema = {
  object(properties, required = []) {
    return { type: "object", properties, required, additionalProperties: false };
  },
  string(description, extra = {}) {
    return { type: "string", description, ...extra };
  },
  integer(description, extra = {}) {
    return { type: "integer", description, ...extra };
  },
  boolean(description) {
    return { type: "boolean", description };
  }
};
function stringArg(args, name, required = true) {
  const value = args[name];
  if (typeof value === "string" && value.trim()) return value.trim();
  if (required) throw new Error(`${name} is required.`);
  return "";
}

// packages/core/src/react.ts
var React = void 0;
function bindReact(instance) {
  React = instance;
}

// packages/core/src/service.ts
var SERVICE_NAME = "databricks";
var CORE_PLUGIN_ID = "bkvarda.databricks";
var SETTINGS_SECTION = `${CORE_PLUGIN_ID}/connection`;
function createPreferences(scope, storage = browserStorage) {
  const listeners = /* @__PURE__ */ new Set();
  const key = () => `bkvarda.databricks.prefs.v1:${scope()}`;
  const read = () => {
    try {
      return JSON.parse(storage.get(key()) ?? "{}") ?? {};
    } catch {
      return {};
    }
  };
  const notify = () => {
    for (const listener of [...listeners]) listener();
  };
  return {
    get: (name) => read()[name],
    set(name, value) {
      const next = { ...read() };
      if (value === void 0 || value === null) delete next[name];
      else next[name] = value;
      storage.set(key(), JSON.stringify(next));
      notify();
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    notify
  };
}
function useConnection(service) {
  return React.useSyncExternalStore(service.subscribe, service.snapshot);
}
function usePreference(service, name) {
  const value = React.useSyncExternalStore(
    service.preferences.subscribe,
    () => JSON.stringify(service.preferences.get(name) ?? null)
  );
  const parsed = React.useMemo(() => JSON.parse(value), [value]);
  return [parsed ?? void 0, (next) => service.preferences.set(name, next)];
}
function useAsync(load, key) {
  const [state, setState] = React.useState({ loading: true });
  const [nonce, setNonce] = React.useState(0);
  React.useEffect(() => {
    const controller = new AbortController();
    setState((previous) => ({ ...previous, loading: true }));
    load(controller.signal).then(
      (data) => {
        if (!controller.signal.aborted) setState({ data, loading: false });
      },
      (error) => {
        if (!controller.signal.aborted)
          setState({ error: error instanceof Error ? error : new Error(String(error)), loading: false });
      }
    );
    return () => controller.abort();
  }, [...key, nonce]);
  return { ...state, reload: () => setNonce((n) => n + 1) };
}
function isApiError(error) {
  return error instanceof Error && error.name === "DatabricksApiError";
}
function describeError(error) {
  if (isApiError(error)) {
    if (error.isPermission) return `You don't have access: ${error.message}`;
    if (error.isFeatureDisabled) return `This isn't enabled in your workspace: ${error.message}`;
    return error.message;
  }
  if (error instanceof Error) return error.message;
  return String(error);
}

// packages/core/src/provider.ts
function createService(connection, openSettings) {
  const scope = () => {
    const snapshot = connection.snapshot();
    return snapshot.status === "connected" ? snapshot.profile.host : "none";
  };
  const preferences = createPreferences(scope);
  connection.subscribe(preferences.notify);
  const members = /* @__PURE__ */ new Map();
  const memberListeners = /* @__PURE__ */ new Set();
  let memberList = [];
  const notifyMembers = () => {
    memberList = [...members.values()].sort((a, b) => a.name.localeCompare(b.name));
    for (const listener of [...memberListeners]) listener();
  };
  return {
    version: 1,
    snapshot: connection.snapshot,
    subscribe: connection.subscribe,
    client: () => connection.client(),
    ready: (signal) => connection.ready(signal),
    workspaceUrl: (path) => connection.workspaceUrl(path),
    profiles: () => {
      const snapshot = connection.snapshot();
      return "profiles" in snapshot ? snapshot.profiles : [];
    },
    openSettings,
    signIn: () => connection.signIn(),
    preferences,
    announce(member) {
      members.set(member.id, member);
      notifyMembers();
      return () => {
        if (members.get(member.id) === member) {
          members.delete(member.id);
          notifyMembers();
        }
      };
    },
    members: () => memberList,
    subscribeMembers(listener) {
      memberListeners.add(listener);
      return () => memberListeners.delete(listener);
    }
  };
}

// packages/core/src/result.ts
var NUMERIC_TYPES = /^(tinyint|smallint|int|integer|bigint|long|short|byte|float|double|real|decimal|numeric)/i;
var TIME_TYPES = /^(date|timestamp)/i;
var IDENTIFIER = /(^|_)(id|ids|zip|zipcode|zip_code|postal_code|postcode|code|key|year|fiscal_year|phone)$/i;
function kindOf(type, sample, name = "") {
  if (IDENTIFIER.test(name) && !TIME_TYPES.test(type ?? "") && !/^bool/i.test(type ?? "")) return "text";
  if (type) {
    if (NUMERIC_TYPES.test(type)) return "number";
    if (TIME_TYPES.test(type)) return "time";
    if (/^bool/i.test(type)) return "boolean";
    if (/^(string|varchar|char|binary|array|map|struct|interval)/i.test(type)) return "text";
  }
  const values = sample.filter((value) => value !== null && value !== "");
  if (!values.length) return "text";
  if (values.every((value) => /^-?\d+(\.\d+)?([eE][+-]?\d+)?$/.test(value))) return "number";
  if (values.every((value) => /^\d{4}-\d{2}(-\d{2})?([T ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?)?$/.test(value)))
    return "time";
  return "text";
}
function resultSet(columns, rows, extra = {}) {
  return {
    columns: columns.map((column, index) => ({
      name: column.name,
      ...column.type && { type: column.type },
      kind: kindOf(
        column.type,
        rows.slice(0, 50).map((row) => row[index] ?? null),
        column.name
      )
    })),
    rows,
    ...extra
  };
}
function fromStatement(response) {
  const columns = (response.manifest?.schema?.columns ?? []).map((column) => ({
    name: column.name,
    type: column.type_text ?? column.type_name ?? ""
  }));
  const rows = response.result?.data_array ?? [];
  const total = response.manifest?.total_row_count;
  return resultSet(columns, rows, {
    ...total !== void 0 && { totalRows: total },
    truncated: Boolean(response.manifest?.truncated) || total !== void 0 && total > rows.length
  });
}
var compact = new Intl.NumberFormat(void 0, { notation: "compact", maximumFractionDigits: 1 });
var precise = new Intl.NumberFormat(void 0, { maximumFractionDigits: 2 });
function formatNumber(value, style = "precise") {
  if (!Number.isFinite(value)) return String(value);
  if (style === "compact" && Math.abs(value) >= 1e4) return compact.format(value);
  return precise.format(value);
}
function formatCell(value, kind) {
  if (value === null) return "null";
  if (kind === "number") {
    const parsed = Number(value);
    if (Number.isFinite(parsed) && Math.abs(parsed) < 1e15) return formatNumber(parsed);
  }
  if (kind === "time" && /T00:00:00(\.000)?(Z)?$/.test(value)) return value.slice(0, 10);
  return value;
}
function toCsv(result) {
  const quote = (value) => value === null ? "" : /[",\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
  return [
    result.columns.map((column) => quote(column.name)).join(","),
    ...result.rows.map((row) => row.map(quote).join(","))
  ].join("\n");
}

// packages/core/src/api/sql.ts
var StatementError = class extends Error {
  constructor(message, statementId, state) {
    super(message);
    this.statementId = statementId;
    this.state = state;
    this.name = "StatementError";
  }
};
var RUNNING = /* @__PURE__ */ new Set(["PENDING", "RUNNING"]);
var Sql = class {
  constructor(client) {
    this.client = client;
  }
  async warehouses(signal) {
    const response = await this.client.get("/api/2.0/sql/warehouses", signal ? { signal } : {});
    return response.warehouses ?? [];
  }
  /** The best default: running serverless, any serverless, running, first. */
  static pick(warehouses) {
    const score = (w) => (w.enable_serverless_compute || w.warehouse_type === "SERVERLESS" ? 2 : 0) + (w.state === "RUNNING" ? 1 : 0);
    return [...warehouses].sort((a, b) => score(b) - score(a))[0];
  }
  /** Runs a statement and waits for its first result chunk. */
  async execute(statement, options) {
    const signal = options.signal;
    let response = await this.client.post(
      "/api/2.0/sql/statements",
      {
        statement,
        warehouse_id: options.warehouseId,
        wait_timeout: "30s",
        on_wait_timeout: "CONTINUE",
        disposition: "INLINE",
        format: "JSON_ARRAY",
        row_limit: options.rowLimit ?? 1e3,
        ...options.catalog && { catalog: options.catalog },
        ...options.schema && { schema: options.schema }
      },
      { timeoutMs: 45e3, ...signal && { signal } }
    );
    options.onStatement?.(response.statement_id);
    const deadline = Date.now() + (options.timeoutMs ?? 5 * 6e4);
    const cancel = () => void this.cancel(response.statement_id).catch(() => {
    });
    signal?.addEventListener("abort", cancel, { once: true });
    try {
      let delay = 750;
      while (RUNNING.has(response.status?.state ?? "")) {
        if (Date.now() > deadline) {
          cancel();
          throw new StatementError("The query took too long and was cancelled.", response.statement_id, "CANCELED");
        }
        await new Promise((resolve) => setTimeout(resolve, delay));
        signal?.throwIfAborted();
        delay = Math.min(3e3, delay * 1.5);
        response = await this.client.get(
          `/api/2.0/sql/statements/${encodeURIComponent(response.statement_id)}`,
          signal ? { signal } : {}
        );
      }
    } finally {
      signal?.removeEventListener("abort", cancel);
    }
    const state = response.status?.state;
    if (state !== "SUCCEEDED")
      throw new StatementError(
        response.status?.error?.message ?? `The query ended as ${state ?? "unknown"}.`,
        response.statement_id,
        state
      );
    return { statementId: response.statement_id, result: fromStatement(response) };
  }
  cancel(statementId) {
    return this.client.post(`/api/2.0/sql/statements/${encodeURIComponent(statementId)}/cancel`, {});
  }
  catalogs(signal) {
    return this.client.get("/api/2.1/unity-catalog/catalogs", signal ? { signal } : {}).then((response) => response.catalogs ?? []);
  }
  schemas(catalog, signal) {
    return this.client.get("/api/2.1/unity-catalog/schemas", {
      query: { catalog_name: catalog },
      ...signal && { signal }
    }).then((response) => response.schemas ?? []);
  }
  tables(catalog, schema2, signal) {
    return this.client.get(
      "/api/2.1/unity-catalog/tables",
      { query: { catalog_name: catalog, schema_name: schema2, max_results: 200 }, ...signal && { signal } }
    ).then((response) => response.tables ?? []);
  }
  table(fullName, signal) {
    return this.client.get(`/api/2.1/unity-catalog/tables/${encodeURIComponent(fullName)}`, signal ? { signal } : {});
  }
};

// packages/core/src/ui/theme.ts
var BRAND = {
  lava: "#FF3621",
  lavaStrong: "#E5301D",
  navy: "#0B2026",
  oat: "#F9F7F4",
  oatMedium: "#EEEDE9",
  green: "#00A972",
  amber: "#FBB300",
  blue: "#4462C9",
  teal: "#1B5162"
};
var STYLE_ID = "dbx-buzz-plugins-style-v1";
var STYLESHEET = `
[data-dbx] {
  --dbx-lava: ${BRAND.lava};
  --dbx-lava-strong: ${BRAND.lavaStrong};
  --dbx-lava-text: #C4290F;
  --dbx-brand-tint: rgba(255, 54, 33, 0.08);
  --dbx-brand-tint-strong: rgba(255, 54, 33, 0.16);
  --dbx-ink: var(--text-standard, #0F0F0F);
  --dbx-subtle: var(--text-subtle, #5D6670);
  --dbx-tertiary: var(--text-tertiary, var(--text-subtle, #7A828A));
  --dbx-border: var(--border-standard, #E4E2DD);
  --dbx-border-strong: var(--border-prominent, #C4CCD6);
  --dbx-surface: var(--surface-panel, #FFFFFF);
  --dbx-inset: var(--surface-inset, #F6F5F2);
  --dbx-popover: var(--surface-popover, #FFFFFF);
  --dbx-success: var(--text-success, #00804F);
  --dbx-warning: var(--text-warning, #9A6A00);
  --dbx-danger: var(--text-danger, #C4290F);
  --dbx-chart-1: #FF3621; --dbx-chart-2: #4462C9; --dbx-chart-3: #00A972;
  --dbx-chart-4: #FBB300; --dbx-chart-5: #FF7033; --dbx-chart-6: #003159;
  --dbx-chart-7: #A0AEC0; --dbx-chart-8: #98102A;
  --dbx-radius: var(--radius-control, 8px);
  --dbx-radius-card: var(--radius-card, 12px);
  color: var(--dbx-ink);
}
.dark [data-dbx] {
  --dbx-lava-text: #FF7A66;
  --dbx-brand-tint: rgba(255, 90, 71, 0.14);
  --dbx-brand-tint-strong: rgba(255, 90, 71, 0.24);
  --dbx-chart-6: #6FA8BA; --dbx-chart-8: #E0607A;
}
[data-dbx] *, [data-dbx] *::before, [data-dbx] *::after { box-sizing: border-box; }
[data-dbx] .dbx-btn {
  display: inline-flex; align-items: center; justify-content: center; gap: 6px;
  min-height: 28px; padding: 0 12px; border-radius: var(--dbx-radius);
  border: 1px solid transparent; font: inherit; font-size: 0.8125rem; font-weight: 500;
  cursor: pointer; white-space: nowrap; transition: background-color 120ms ease, border-color 120ms ease;
  background: var(--affordance-subtle, #EFEFEF); color: var(--dbx-ink);
}
[data-dbx] .dbx-btn:hover:not(:disabled) { background: var(--affordance-subtle-hover, #E5E5E5); }
[data-dbx] .dbx-btn:focus-visible { outline: 2px solid var(--border-focus, #4462C9); outline-offset: 2px; }
[data-dbx] .dbx-btn:disabled { cursor: default; opacity: 0.55; }
[data-dbx] .dbx-btn[data-variant="primary"] { background: var(--affordance-prominent, #0F0F0F); color: var(--text-on-prominent, #FFF); }
[data-dbx] .dbx-btn[data-variant="primary"]:hover:not(:disabled) { background: var(--affordance-prominent-hover, #2A2A2A); }
[data-dbx] .dbx-btn[data-variant="brand"] { background: var(--dbx-lava-strong); color: #FFFFFF; }
[data-dbx] .dbx-btn[data-variant="brand"]:hover:not(:disabled) { background: #C4290F; }
[data-dbx] .dbx-btn[data-variant="ghost"] { background: transparent; }
[data-dbx] .dbx-btn[data-variant="ghost"]:hover:not(:disabled) { background: var(--affordance-subtle-hover, #EFEFEF); }
[data-dbx] .dbx-btn[data-variant="danger"] { background: transparent; color: var(--dbx-danger); border-color: var(--dbx-border); }
[data-dbx] .dbx-btn[data-size="sm"] { min-height: 24px; padding: 0 8px; font-size: 0.75rem; }
[data-dbx] .dbx-icon-btn { padding: 0; width: 28px; }
[data-dbx] .dbx-input, [data-dbx] .dbx-select, [data-dbx] .dbx-textarea {
  width: 100%; font: inherit; font-size: 0.8125rem; color: var(--dbx-ink);
  background: var(--surface-composer, var(--dbx-surface)); border: 1px solid var(--dbx-border);
  border-radius: var(--dbx-radius); padding: 6px 10px; min-height: 30px;
}
[data-dbx] .dbx-textarea { resize: vertical; line-height: 1.45; }
[data-dbx] .dbx-input:focus, [data-dbx] .dbx-select:focus, [data-dbx] .dbx-textarea:focus {
  outline: none; border-color: var(--border-focus, #4462C9); box-shadow: 0 0 0 1px var(--border-focus, #4462C9);
}
[data-dbx] .dbx-card { background: var(--dbx-surface); border: 1px solid var(--dbx-border); border-radius: var(--dbx-radius-card); }
[data-dbx] .dbx-row:hover { background: var(--affordance-row-hover, var(--affordance-subtle-hover, #F2F2F2)); }
[data-dbx] .dbx-row[aria-selected="true"] { background: var(--affordance-selected, var(--affordance-subtle, #EDEDED)); }
[data-dbx] .dbx-mono { font-family: var(--font-mono, ui-monospace, SFMono-Regular, Menlo, monospace); }
[data-dbx] .dbx-table { border-collapse: separate; border-spacing: 0; width: 100%; font-size: 0.75rem; }
[data-dbx] .dbx-table th { position: sticky; top: 0; z-index: 1; background: var(--dbx-inset); text-align: left; font-weight: 500; color: var(--dbx-subtle); }
[data-dbx] .dbx-table th, [data-dbx] .dbx-table td { padding: 5px 10px; border-bottom: 1px solid var(--dbx-border); white-space: nowrap; max-width: 320px; overflow: hidden; text-overflow: ellipsis; }
[data-dbx] .dbx-table td[data-numeric="true"], [data-dbx] .dbx-table th[data-numeric="true"] { text-align: right; font-variant-numeric: tabular-nums; }
[data-dbx] .dbx-table tbody tr:hover td { background: var(--affordance-row-hover, rgba(127,127,127,0.06)); }
[data-dbx] .dbx-link { color: var(--text-link, #2272B4); text-decoration: none; cursor: pointer; background: none; border: 0; padding: 0; font: inherit; }
[data-dbx] .dbx-link:hover { text-decoration: underline; }
[data-dbx] .dbx-md a.dbx-link { text-decoration: underline; text-decoration-color: color-mix(in srgb, currentColor 40%, transparent); text-underline-offset: 2px; }
[data-dbx] .dbx-md a.dbx-link:hover { text-decoration-color: currentColor; }
[data-dbx] .dbx-md p { margin: 0 0 8px; }
[data-dbx] .dbx-md p:last-child { margin-bottom: 0; }
[data-dbx] .dbx-md ul, [data-dbx] .dbx-md ol { margin: 0 0 8px; padding-left: 20px; }
[data-dbx] .dbx-md code { font-family: var(--font-mono, ui-monospace, monospace); font-size: 0.92em; background: var(--dbx-inset); padding: 1px 4px; border-radius: 4px; }
[data-dbx] .dbx-md pre { background: var(--dbx-inset); padding: 10px 12px; border-radius: var(--dbx-radius); overflow: auto; }
[data-dbx] .dbx-md pre code { background: none; padding: 0; }
@keyframes dbx-spin { to { transform: rotate(360deg); } }
@keyframes dbx-pulse { 0%, 100% { opacity: 0.35; } 50% { opacity: 1; } }
@media (prefers-reduced-motion: reduce) { [data-dbx] * { animation-duration: 0s !important; transition: none !important; } }
`;
function ensureStyles(doc = globalThis.document) {
  if (!doc || doc.getElementById(STYLE_ID)) return;
  const style = doc.createElement("style");
  style.id = STYLE_ID;
  style.textContent = STYLESHEET;
  doc.head.appendChild(style);
}
var DATABRICKS_MARK_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 300 331" fill="none"><path fill="#FF3621" d="M283.923 136.449L150.144 213.624L6.88995 131.168L0 134.982V194.844L150.144 281.115L283.923 204.234V235.926L150.144 313.1L6.88995 230.644L0 234.458V244.729L150.144 331L300 244.729V184.867L293.11 181.052L150.144 263.215L16.0766 186.334V154.643L150.144 231.524L300 145.253V86.2713L292.536 81.8697L150.144 163.739L22.9665 90.9663L150.144 17.8998L254.641 78.055L263.828 72.773V65.4371L150.144 0L0 86.2713V95.6613L150.144 181.933L283.923 104.758V136.449Z"/></svg>`;
var DATABRICKS_MARK_MONO_SVG = DATABRICKS_MARK_SVG.replace(
  'fill="#FF3621"',
  'fill="currentColor"'
);
var svgDataUri = (svg) => `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`;
var DATABRICKS_ICON = svgDataUri(DATABRICKS_MARK_SVG);
var DATABRICKS_ICON_MONO = svgDataUri(DATABRICKS_MARK_MONO_SVG);

// packages/core/src/ui/components.tsx
function DbxRoot(props) {
  ensureStyles();
  return /* @__PURE__ */ React.createElement("div", { "data-dbx": "", className: props.className, style: props.style }, props.children);
}
function DatabricksMark(props) {
  const size = props.size ?? 16;
  const svg = props.color === "current" ? DATABRICKS_MARK_SVG.replace('fill="#FF3621"', 'fill="currentColor"') : DATABRICKS_MARK_SVG;
  return /* @__PURE__ */ React.createElement(
    "span",
    {
      role: props.title ? "img" : void 0,
      "aria-label": props.title,
      "aria-hidden": props.title ? void 0 : true,
      style: { display: "inline-flex", width: size, height: size * 1.1, flex: "none" },
      dangerouslySetInnerHTML: { __html: svg.replace("<svg ", `<svg width="${size}" height="${size * 1.1}" `) }
    }
  );
}
function Button(props) {
  return /* @__PURE__ */ React.createElement(
    "button",
    {
      type: props.type ?? "button",
      className: `dbx-btn${props.icon ? " dbx-icon-btn" : ""}`,
      "data-variant": props.variant ?? "default",
      "data-size": props.size ?? "md",
      disabled: props.disabled,
      onClick: props.onClick,
      title: props.title,
      "aria-label": props["aria-label"],
      style: props.style
    },
    props.children
  );
}
function Spinner(props) {
  const size = props.size ?? 14;
  return /* @__PURE__ */ React.createElement(
    "span",
    {
      role: "status",
      "aria-label": props.label ?? "Loading",
      style: {
        display: "inline-block",
        width: size,
        height: size,
        borderRadius: "50%",
        border: "2px solid var(--dbx-border-strong)",
        borderTopColor: "var(--dbx-lava)",
        animation: "dbx-spin 0.8s linear infinite",
        flex: "none"
      }
    }
  );
}
function Stack(props) {
  return /* @__PURE__ */ React.createElement(
    "div",
    {
      style: {
        display: "flex",
        flexDirection: props.direction ?? "column",
        gap: props.gap ?? 8,
        alignItems: props.align,
        justifyContent: props.justify,
        flexWrap: props.wrap ? "wrap" : void 0,
        minWidth: 0,
        ...props.style
      }
    },
    props.children
  );
}
function Text(props) {
  const color = {
    standard: "var(--dbx-ink)",
    subtle: "var(--dbx-subtle)",
    tertiary: "var(--dbx-tertiary)",
    danger: "var(--dbx-danger)",
    success: "var(--dbx-success)",
    warning: "var(--dbx-warning)",
    brand: "var(--dbx-lava-text)"
  }[props.tone ?? "standard"];
  const fontSize = { xs: "0.6875rem", sm: "0.75rem", md: "0.8125rem", lg: "0.9375rem", xl: "1.125rem" }[props.size ?? "md"];
  const Tag = props.as ?? "span";
  return React.createElement(
    Tag,
    {
      className: props.mono ? "dbx-mono" : void 0,
      style: {
        margin: 0,
        color,
        fontSize,
        fontWeight: props.weight ?? (Tag.startsWith("h") ? 500 : 400),
        lineHeight: 1.45,
        ...props.style
      }
    },
    props.children
  );
}
function Card(props) {
  return /* @__PURE__ */ React.createElement("div", { className: "dbx-card", style: { padding: props.padding ?? 16, ...props.style } }, props.children);
}
function Notice(props) {
  const tone = props.tone ?? "info";
  const accent = {
    info: "var(--dbx-border-strong)",
    warning: "var(--dbx-warning)",
    danger: "var(--dbx-danger)",
    success: "var(--dbx-success)"
  }[tone];
  return /* @__PURE__ */ React.createElement(
    "div",
    {
      role: tone === "danger" ? "alert" : "status",
      style: {
        display: "flex",
        gap: 12,
        alignItems: "flex-start",
        justifyContent: "space-between",
        padding: "10px 12px",
        borderRadius: "var(--dbx-radius)",
        border: "1px solid var(--dbx-border)",
        background: "var(--dbx-inset)",
        boxShadow: `inset 3px 0 0 ${accent}`
      }
    },
    /* @__PURE__ */ React.createElement(Stack, { gap: 2, style: { minWidth: 0 } }, props.title && /* @__PURE__ */ React.createElement(Text, { weight: 500, size: "md" }, props.title), props.children && /* @__PURE__ */ React.createElement(Text, { tone: "subtle", size: "sm", as: "div" }, props.children)),
    props.action && /* @__PURE__ */ React.createElement("div", { style: { flex: "none" } }, props.action)
  );
}
function EmptyState(props) {
  return /* @__PURE__ */ React.createElement(
    Stack,
    {
      align: "center",
      gap: 10,
      style: { textAlign: "center", padding: "40px 24px", maxWidth: 420, margin: "0 auto" }
    },
    props.mark !== false && /* @__PURE__ */ React.createElement(DatabricksMark, { size: 28 }),
    /* @__PURE__ */ React.createElement(Text, { as: "h3", size: "lg", weight: 500 }, props.title),
    props.children && /* @__PURE__ */ React.createElement(Text, { tone: "subtle", as: "div" }, props.children),
    props.action
  );
}
function Badge(props) {
  const tone = props.tone ?? "neutral";
  const color = {
    neutral: "var(--dbx-subtle)",
    brand: "var(--dbx-lava-text)",
    success: "var(--dbx-success)",
    warning: "var(--dbx-warning)",
    danger: "var(--dbx-danger)"
  }[tone];
  return /* @__PURE__ */ React.createElement(
    "span",
    {
      title: props.title,
      style: {
        display: "inline-flex",
        alignItems: "center",
        gap: 4,
        padding: "1px 7px",
        borderRadius: 999,
        fontSize: "0.6875rem",
        fontWeight: 500,
        lineHeight: 1.6,
        color,
        background: tone === "brand" ? "var(--dbx-brand-tint)" : "var(--dbx-inset)",
        border: "1px solid var(--dbx-border)",
        whiteSpace: "nowrap"
      }
    },
    props.children
  );
}
function StatusDot(props) {
  const color = {
    success: "var(--dbx-success)",
    warning: "var(--dbx-warning)",
    danger: "var(--dbx-danger)",
    neutral: "var(--dbx-tertiary)",
    active: "var(--dbx-lava)"
  }[props.tone];
  return /* @__PURE__ */ React.createElement(
    "span",
    {
      role: "img",
      "aria-label": props.label,
      title: props.label,
      style: {
        display: "inline-block",
        width: 8,
        height: 8,
        borderRadius: "50%",
        background: color,
        flex: "none",
        animation: props.tone === "active" ? "dbx-pulse 1.4s ease-in-out infinite" : void 0
      }
    }
  );
}
function Field(props) {
  return /* @__PURE__ */ React.createElement("label", { style: { display: "flex", flexDirection: "column", gap: 4, minWidth: 0 }, htmlFor: props.id }, /* @__PURE__ */ React.createElement(Text, { size: "sm", weight: 500 }, props.label), props.children, props.hint && /* @__PURE__ */ React.createElement(Text, { size: "xs", tone: "subtle", as: "div" }, props.hint));
}
function SectionHeader(props) {
  return /* @__PURE__ */ React.createElement("div", { style: { display: "flex", alignItems: "flex-end", justifyContent: "space-between", gap: 12 } }, /* @__PURE__ */ React.createElement(Stack, { gap: 2 }, /* @__PURE__ */ React.createElement(Text, { as: "h3", size: "md", weight: 500 }, props.title), props.description && /* @__PURE__ */ React.createElement(Text, { tone: "subtle", size: "sm", as: "div" }, props.description)), props.action);
}
function CopyButton(props) {
  const [copied, setCopied] = React.useState(false);
  return /* @__PURE__ */ React.createElement(
    Button,
    {
      size: "sm",
      variant: "ghost",
      onClick: () => {
        void navigator.clipboard?.writeText(props.text).then(() => {
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        });
      }
    },
    copied ? "Copied" : props.label ?? "Copy"
  );
}
function ago(ms, now = Date.now()) {
  const s = Math.max(0, Math.round((now - ms) / 1e3));
  if (s < 45) return "just now";
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.round(h / 24)}d ago`;
}

// packages/core/src/ui/data.tsx
function DataTable(props) {
  const { result } = props;
  const rows = result.rows.slice(0, props.maxRows ?? 500);
  const total = result.totalRows ?? result.rows.length;
  return /* @__PURE__ */ React.createElement(Stack, { gap: 6 }, /* @__PURE__ */ React.createElement(
    "div",
    {
      style: {
        overflow: "auto",
        maxHeight: props.maxHeight ?? 320,
        border: "1px solid var(--dbx-border)",
        borderRadius: "var(--dbx-radius)"
      }
    },
    /* @__PURE__ */ React.createElement("table", { className: "dbx-table" }, /* @__PURE__ */ React.createElement("thead", null, /* @__PURE__ */ React.createElement("tr", null, result.columns.map((column) => /* @__PURE__ */ React.createElement("th", { key: column.name, "data-numeric": column.kind === "number", title: column.type }, column.name)))), /* @__PURE__ */ React.createElement("tbody", null, rows.map((row, r) => (
      // biome-ignore lint/suspicious/noArrayIndexKey: rows have no identity
      /* @__PURE__ */ React.createElement("tr", { key: r }, result.columns.map((column, c) => {
        const value = row[c] ?? null;
        return /* @__PURE__ */ React.createElement(
          "td",
          {
            key: column.name,
            "data-numeric": column.kind === "number",
            title: value ?? "null",
            style: value === null ? { color: "var(--dbx-tertiary)", fontStyle: "italic" } : void 0
          },
          formatCell(value, column.kind)
        );
      }))
    ))))
  ), /* @__PURE__ */ React.createElement(Stack, { direction: "row", align: "center", justify: "space-between", gap: 8 }, /* @__PURE__ */ React.createElement(Text, { size: "xs", tone: "subtle" }, rows.length === total ? `${total} ${total === 1 ? "row" : "rows"}` : `Showing ${rows.length} of ${total.toLocaleString()} rows`, result.truncated && rows.length === total ? " (truncated)" : ""), /* @__PURE__ */ React.createElement(CopyButton, { text: toCsv(result), label: "Copy CSV" })));
}

// plugins/databricks/src/links.tsx
var statusCache = /* @__PURE__ */ new Map();
function sameWorkspace(service, link) {
  const snapshot = service.snapshot();
  return snapshot.status === "connected" && snapshot.profile.host === link.host;
}
async function chipStatus(service, link) {
  const client = service.client();
  if (!client || !sameWorkspace(service, link)) return void 0;
  const jobs = new Jobs(client);
  if (link.kind === "run") {
    const run = await jobs.run(link.runId);
    return { label: runLabel(run), tone: runTone(run), title: run.name };
  }
  if (link.kind === "job") {
    const job = await jobs.job(link.jobId);
    return job.latest ? { label: runLabel(job.latest), tone: runTone(job.latest), title: `${job.name} \u2014 latest run` } : { label: job.name, tone: "neutral" };
  }
  if (link.kind === "pipeline") {
    const pipeline = await jobs.pipeline(link.pipelineId);
    const state = pipeline.latest?.state ?? pipeline.state;
    const tone = /FAILED/.test(state) ? "danger" : /COMPLETED|IDLE/.test(state) ? "success" : /RUNNING|INITIALIZING|SETTING_UP|WAITING/.test(state) ? "active" : "neutral";
    return { label: state.toLowerCase().replace(/_/g, " "), tone, title: pipeline.name };
  }
  return void 0;
}
function cachedStatus(service, link, url) {
  const hit = statusCache.get(url);
  if (hit && Date.now() - hit.at < 2e4) return hit.value;
  const value = chipStatus(service, link).catch(() => void 0);
  statusCache.set(url, { at: Date.now(), value });
  return value;
}
function linkChip(service) {
  return function DatabricksLink(props) {
    const link = React.useMemo(() => parseWorkspaceUrl(props.url), [props.url]);
    const snapshot = useConnection(service);
    const [status, setStatus] = React.useState();
    React.useEffect(() => {
      if (!link || snapshot.status !== "connected") return;
      let live = true;
      const load = () => void cachedStatus(service, link, props.url).then((value) => {
        if (live) setStatus(value);
      });
      load();
      const timer = setInterval(() => {
        if (status?.tone === "active") {
          statusCache.delete(props.url);
          load();
        }
      }, 3e4);
      return () => {
        live = false;
        clearInterval(timer);
      };
    }, [link, props.url, snapshot.status, status?.tone]);
    if (!link) return /* @__PURE__ */ React.createElement(React.Fragment, null, props.url);
    const label = link.kind === "table" ? link.fullName : link.kind === "workspace" ? link.host.replace(/^https:\/\//, "").split(".")[0] : LINK_LABEL[link.kind];
    return /* @__PURE__ */ React.createElement("span", { style: { display: "inline-flex", alignItems: "center", gap: 4, verticalAlign: "baseline" }, title: status?.title }, /* @__PURE__ */ React.createElement("span", { "data-dbx": "", style: { display: "inline-flex", alignItems: "center" } }, /* @__PURE__ */ React.createElement(DatabricksMark, { size: 11 })), /* @__PURE__ */ React.createElement("span", null, label), status && /* @__PURE__ */ React.createElement("span", { "data-dbx": "", style: { display: "inline-flex", alignItems: "center", gap: 4 } }, /* @__PURE__ */ React.createElement(StatusDot, { tone: status.tone, label: status.label }), /* @__PURE__ */ React.createElement("span", { style: { fontSize: "0.85em", opacity: 0.85 } }, status.label)));
  };
}
var panelMatches = (url) => {
  const link = parseWorkspaceUrl(url);
  return link?.kind === "run" || link?.kind === "job" || link?.kind === "pipeline" || link?.kind === "table";
};
function RunDetails(props) {
  const { run } = props;
  return /* @__PURE__ */ React.createElement(Stack, { gap: 12 }, /* @__PURE__ */ React.createElement(Stack, { direction: "row", gap: 8, align: "center" }, /* @__PURE__ */ React.createElement(StatusDot, { tone: runTone(run), label: runLabel(run) }), /* @__PURE__ */ React.createElement(Text, { weight: 500 }, runLabel(run)), run.startTime && /* @__PURE__ */ React.createElement(Text, { tone: "subtle", size: "sm" }, "started ", ago(run.startTime), run.endTime ? ` \xB7 took ${Math.max(1, Math.round((run.endTime - run.startTime) / 1e3))}s` : "")), run.message && /* @__PURE__ */ React.createElement(Notice, { tone: runTone(run) === "danger" ? "danger" : "info" }, run.message), run.tasks.length > 0 && /* @__PURE__ */ React.createElement(Stack, { gap: 4 }, /* @__PURE__ */ React.createElement(Text, { size: "sm", weight: 500 }, "Tasks"), run.tasks.map((task) => {
    const tone = runTone({ ...run, lifecycle: task.lifecycle, result: task.result, done: ["TERMINATED", "SKIPPED", "INTERNAL_ERROR"].includes(task.lifecycle) });
    return /* @__PURE__ */ React.createElement(Stack, { key: task.key, direction: "row", gap: 8, align: "center" }, /* @__PURE__ */ React.createElement(StatusDot, { tone, label: task.result ?? task.lifecycle }), /* @__PURE__ */ React.createElement(Text, { size: "sm", mono: true }, task.key), /* @__PURE__ */ React.createElement(Text, { size: "xs", tone: "subtle" }, (task.result ?? task.lifecycle).toLowerCase()));
  })));
}
function workspacePanel(service) {
  return function DatabricksPanel(props) {
    const link = React.useMemo(() => parseWorkspaceUrl(props.target), [props.target]);
    const snapshot = useConnection(service);
    const state = useAsync(
      async (signal) => {
        if (!link) return void 0;
        const client = await service.ready(signal);
        if (!sameWorkspace(service, link)) return { kind: "elsewhere" };
        const jobs = new Jobs(client);
        if (link.kind === "run") return { kind: "run", run: await jobs.run(link.runId, signal) };
        if (link.kind === "job") return { kind: "job", job: await jobs.job(link.jobId, signal) };
        if (link.kind === "pipeline") return { kind: "pipeline", pipeline: await jobs.pipeline(link.pipelineId, signal) };
        if (link.kind === "table") {
          const sql = new Sql(client);
          const table = await sql.table(link.fullName, signal);
          return { kind: "table", table };
        }
        return void 0;
      },
      [props.target, snapshot.status]
    );
    let body;
    if (snapshot.status !== "connected")
      body = /* @__PURE__ */ React.createElement(EmptyState, { title: "Connect Databricks", action: /* @__PURE__ */ React.createElement(Button, { variant: "brand", onClick: () => service.openSettings() }, "Connect") }, "Sign in to see live details for Databricks links.");
    else if (state.loading && !state.data) body = /* @__PURE__ */ React.createElement(Stack, { direction: "row", gap: 8, align: "center" }, /* @__PURE__ */ React.createElement(Spinner, null), /* @__PURE__ */ React.createElement(Text, { tone: "subtle" }, "Loading\u2026"));
    else if (state.error) body = /* @__PURE__ */ React.createElement(Notice, { tone: "danger", title: "Couldn't load this" }, describeError(state.error));
    else if (state.data?.kind === "elsewhere")
      body = /* @__PURE__ */ React.createElement(Notice, { title: "Different workspace" }, "This link is in ", link?.host.replace("https://", ""), "; you're connected to another workspace.");
    else if (state.data?.kind === "run")
      body = /* @__PURE__ */ React.createElement(Stack, { gap: 12 }, /* @__PURE__ */ React.createElement(Text, { as: "h3", size: "lg", weight: 500 }, state.data.run.name), /* @__PURE__ */ React.createElement(RunDetails, { run: state.data.run }));
    else if (state.data?.kind === "job")
      body = /* @__PURE__ */ React.createElement(Stack, { gap: 12 }, /* @__PURE__ */ React.createElement(Text, { as: "h3", size: "lg", weight: 500 }, state.data.job.name), state.data.job.latest ? /* @__PURE__ */ React.createElement(RunDetails, { run: state.data.job.latest }) : /* @__PURE__ */ React.createElement(Text, { tone: "subtle" }, "No runs yet."));
    else if (state.data?.kind === "pipeline")
      body = /* @__PURE__ */ React.createElement(Stack, { gap: 8 }, /* @__PURE__ */ React.createElement(Text, { as: "h3", size: "lg", weight: 500 }, state.data.pipeline.name), /* @__PURE__ */ React.createElement(Badge, null, (state.data.pipeline.latest?.state ?? state.data.pipeline.state).toLowerCase()));
    else if (state.data?.kind === "table") {
      const table = state.data.table;
      body = /* @__PURE__ */ React.createElement(Stack, { gap: 10 }, /* @__PURE__ */ React.createElement(Text, { as: "h3", size: "lg", weight: 500, mono: true }, table.full_name), table.comment && /* @__PURE__ */ React.createElement(Text, { tone: "subtle" }, table.comment), /* @__PURE__ */ React.createElement(
        DataTable,
        {
          result: resultSet(
            [{ name: "column" }, { name: "type" }, { name: "comment" }],
            (table.columns ?? []).map((column) => [column.name, column.type_text ?? "", column.comment ?? ""])
          )
        }
      ));
    } else body = /* @__PURE__ */ React.createElement(Text, { tone: "subtle" }, "Nothing to show for this link.");
    return /* @__PURE__ */ React.createElement(DbxRoot, { style: { padding: "var(--space-panel-inset, 16px)" } }, /* @__PURE__ */ React.createElement(Stack, { gap: 14 }, body, /* @__PURE__ */ React.createElement(Stack, { direction: "row", gap: 8 }, /* @__PURE__ */ React.createElement(Button, { variant: "ghost", onClick: () => window.open(props.target, "_blank", "noopener") }, "Open in Databricks"), /* @__PURE__ */ React.createElement(Button, { variant: "ghost", onClick: () => state.reload() }, "Refresh"))));
  };
}

// plugins/databricks/src/settings.tsx
var REPOSITORY = "https://github.com/bkvarda/databricks-buzz-plugins";
var SUITE = [
  { id: "bkvarda.databricks-genie", folder: "genie", name: "Databricks Genie", blurb: "Ask Genie agents questions about your data, with charts. Agents can ask Genie too." },
  { id: "bkvarda.databricks-sql", folder: "sql", name: "Databricks SQL", blurb: "Run SQL from conversations and give agents governed SQL and catalog tools." },
  { id: "bkvarda.databricks-agents", folder: "agents", name: "Databricks Agents", blurb: "Agents powered by Databricks: models, Genie agents, your custom agents and Sandboxes." },
  { id: "bkvarda.databricks-memory", folder: "memory", name: "Databricks Memory", blurb: "Long-term agent memory in Databricks managed memory, shared across your agents." },
  { id: "bkvarda.databricks-lakebase", folder: "lakebase", name: "Lakebase", blurb: "Let agents read operational data from Lakebase Postgres through the Data API." }
];
function hostLabel(host) {
  return host.replace(/^https:\/\//, "");
}
function ConnectionSettings(props) {
  const { connection, service } = props;
  const snapshot = useConnection(service);
  const members = React.useSyncExternalStore(service.subscribeMembers, service.members);
  return /* @__PURE__ */ React.createElement(DbxRoot, null, /* @__PURE__ */ React.createElement(Stack, { gap: 28, style: { paddingBottom: 32 } }, /* @__PURE__ */ React.createElement(Stack, { gap: 6 }, /* @__PURE__ */ React.createElement(Stack, { direction: "row", gap: 10, align: "center" }, /* @__PURE__ */ React.createElement(DatabricksMark, { size: 22 }), /* @__PURE__ */ React.createElement(Text, { as: "h2", size: "xl", weight: 500 }, "Databricks")), /* @__PURE__ */ React.createElement(Text, { tone: "subtle", as: "p" }, "Connect once and every Databricks plugin, and every agent using Databricks tools, works as you, with your Unity Catalog permissions.")), /* @__PURE__ */ React.createElement(ConnectionGroup, { connection, snapshot }), snapshot.status === "connected" && /* @__PURE__ */ React.createElement(DefaultsGroup, { service }), /* @__PURE__ */ React.createElement(SuiteGroup, { installer: props.installer, active: new Set(members.map((member) => member.id)) })));
}
function ConnectionGroup(props) {
  const { connection, snapshot } = props;
  const [error, setError] = React.useState();
  const run = (action) => {
    setError(void 0);
    action().catch((failure) => setError(describeError(failure)));
  };
  let body;
  switch (snapshot.status) {
    case "checking":
    case "connecting":
      body = /* @__PURE__ */ React.createElement(Stack, { direction: "row", gap: 10, align: "center" }, /* @__PURE__ */ React.createElement(Spinner, null), /* @__PURE__ */ React.createElement(Text, { tone: "subtle" }, snapshot.status === "checking" ? "Checking for a Databricks sign-in\u2026" : `Connecting to ${hostLabel(snapshot.profile.host)}\u2026`));
      break;
    case "unsupported":
      body = /* @__PURE__ */ React.createElement(Notice, { tone: "warning", title: "Desktop only" }, snapshot.message);
      break;
    case "cli-missing":
      body = /* @__PURE__ */ React.createElement(Stack, { gap: 12 }, /* @__PURE__ */ React.createElement(
        Notice,
        {
          tone: "info",
          title: "One-time setup: the Databricks CLI",
          action: /* @__PURE__ */ React.createElement(Button, { variant: "brand", disabled: snapshot.installing, onClick: () => run(() => connection.installCli()) }, snapshot.installing ? /* @__PURE__ */ React.createElement(Spinner, { size: 12, label: "Installing" }) : null, snapshot.installing ? "Installing\u2026" : "Install Databricks CLI")
        },
        "Sign-in uses the official Databricks CLI, so your browser single sign-on and token refresh are handled by Databricks and shared with your other Databricks tools. It installs to ~/.local/bin after a checksum check."
      ), snapshot.error && /* @__PURE__ */ React.createElement(Notice, { tone: "danger", title: "Install didn't finish" }, snapshot.error), /* @__PURE__ */ React.createElement(Text, { tone: "subtle", size: "sm" }, "Prefer Homebrew? Run ", /* @__PURE__ */ React.createElement("span", { className: "dbx-mono" }, "brew install databricks/tap/databricks"), ", then", " ", /* @__PURE__ */ React.createElement("button", { type: "button", className: "dbx-link", onClick: () => run(() => connection.start()) }, "check again"), "."));
      break;
    case "signing-in":
      body = /* @__PURE__ */ React.createElement(Card, null, /* @__PURE__ */ React.createElement(Stack, { direction: "row", gap: 12, align: "center", justify: "space-between" }, /* @__PURE__ */ React.createElement(Stack, { direction: "row", gap: 10, align: "center" }, /* @__PURE__ */ React.createElement(Spinner, null), /* @__PURE__ */ React.createElement(Stack, { gap: 2 }, /* @__PURE__ */ React.createElement(Text, { weight: 500 }, "Finish signing in in your browser"), /* @__PURE__ */ React.createElement(Text, { tone: "subtle", size: "sm" }, snapshot.host ? `Signing in to ${hostLabel(snapshot.host)}.` : "Sign in with your company account, then choose your workspace."))), /* @__PURE__ */ React.createElement(Button, { variant: "ghost", onClick: () => connection.cancelSignIn() }, "Cancel")));
      break;
    case "signed-out":
      body = /* @__PURE__ */ React.createElement(SignedOut, { connection, profiles: snapshot.profiles, error: snapshot.error, run });
      break;
    case "error":
      body = /* @__PURE__ */ React.createElement(Stack, { gap: 12 }, /* @__PURE__ */ React.createElement(
        Notice,
        {
          tone: "warning",
          title: `Can't reach ${hostLabel(snapshot.profile.host)}`,
          action: /* @__PURE__ */ React.createElement(Stack, { direction: "row", gap: 6 }, snapshot.needsSignIn ? /* @__PURE__ */ React.createElement(Button, { variant: "brand", onClick: () => run(() => connection.reauthenticate()) }, "Sign in again") : /* @__PURE__ */ React.createElement(Button, { onClick: () => run(() => connection.useProfile(snapshot.profile.name)) }, "Retry"), /* @__PURE__ */ React.createElement(Button, { variant: "ghost", onClick: () => connection.disconnect() }, "Use another"))
        },
        snapshot.message
      ));
      break;
    case "connected":
      body = /* @__PURE__ */ React.createElement(Connected, { connection, snapshot, run });
      break;
  }
  return /* @__PURE__ */ React.createElement(Stack, { gap: 12 }, /* @__PURE__ */ React.createElement(SectionHeader, { title: "Connection" }), body, error && /* @__PURE__ */ React.createElement(Notice, { tone: "danger", title: "That didn't work" }, error));
}
function SignedOut(props) {
  const { connection, profiles, run } = props;
  const [url, setUrl] = React.useState("");
  const [profile, setProfile] = React.useState(profiles[0]?.name ?? "");
  return /* @__PURE__ */ React.createElement(Stack, { gap: 14 }, /* @__PURE__ */ React.createElement(Card, { padding: 18 }, /* @__PURE__ */ React.createElement(Stack, { direction: "row", gap: 14, align: "center", justify: "space-between", wrap: true }, /* @__PURE__ */ React.createElement(Stack, { gap: 3, style: { flex: "1 1 260px" } }, /* @__PURE__ */ React.createElement(Text, { weight: 500 }, "Sign in with Databricks"), /* @__PURE__ */ React.createElement(Text, { tone: "subtle", size: "sm" }, "Opens your browser for single sign-on. You'll pick your workspace there.")), /* @__PURE__ */ React.createElement(Button, { variant: "brand", onClick: () => run(() => connection.signIn()) }, /* @__PURE__ */ React.createElement(DatabricksMark, { size: 13, color: "current" }), "Sign in with Databricks"))), props.error && /* @__PURE__ */ React.createElement(Notice, { tone: "danger", title: "Sign-in didn't finish" }, props.error), profiles.length > 0 && /* @__PURE__ */ React.createElement(Stack, { gap: 8 }, /* @__PURE__ */ React.createElement(Text, { size: "sm", weight: 500 }, "Or use a profile you already signed in with"), /* @__PURE__ */ React.createElement(Stack, { direction: "row", gap: 8, align: "center" }, /* @__PURE__ */ React.createElement("select", { className: "dbx-select", value: profile, onChange: (event) => setProfile(event.target.value), style: { maxWidth: 420 }, "aria-label": "Databricks CLI profile" }, profiles.map((candidate) => /* @__PURE__ */ React.createElement("option", { key: candidate.name, value: candidate.name }, candidate.name, " \u2014 ", hostLabel(candidate.host)))), /* @__PURE__ */ React.createElement(Button, { disabled: !profile, onClick: () => run(() => connection.useProfile(profile)) }, "Use profile"))), /* @__PURE__ */ React.createElement(
    "form",
    {
      onSubmit: (event) => {
        event.preventDefault();
        if (url.trim()) run(() => connection.signIn({ host: url.trim() }));
      }
    },
    /* @__PURE__ */ React.createElement(Stack, { gap: 8 }, /* @__PURE__ */ React.createElement(Field, { label: "Or sign in to a workspace URL", hint: "For example https://my-company.cloud.databricks.com" }, /* @__PURE__ */ React.createElement(Stack, { direction: "row", gap: 8 }, /* @__PURE__ */ React.createElement("input", { className: "dbx-input", value: url, onChange: (event) => setUrl(event.target.value), placeholder: "https://\u2026cloud.databricks.com", style: { maxWidth: 420 } }), /* @__PURE__ */ React.createElement(Button, { type: "submit", disabled: !url.trim() }, "Sign in"))))
  ));
}
function Connected(props) {
  const { connection, snapshot, run } = props;
  const [switching, setSwitching] = React.useState(false);
  const others = snapshot.profiles.filter((profile) => profile.name !== snapshot.profile.name);
  const url = connection.workspaceUrl("/");
  return /* @__PURE__ */ React.createElement(Stack, { gap: 12 }, /* @__PURE__ */ React.createElement(Card, null, /* @__PURE__ */ React.createElement(Stack, { direction: "row", gap: 12, align: "center", justify: "space-between", wrap: true }, /* @__PURE__ */ React.createElement(Stack, { direction: "row", gap: 12, align: "center", style: { minWidth: 0 } }, /* @__PURE__ */ React.createElement(StatusDot, { tone: "success", label: "Connected" }), /* @__PURE__ */ React.createElement(Stack, { gap: 2, style: { minWidth: 0 } }, /* @__PURE__ */ React.createElement(Text, { weight: 500, style: { overflow: "hidden", textOverflow: "ellipsis" } }, hostLabel(snapshot.profile.host)), /* @__PURE__ */ React.createElement(Text, { tone: "subtle", size: "sm" }, snapshot.user.displayName ? `${snapshot.user.displayName} \xB7 ` : "", snapshot.user.userName, " \xB7 profile ", /* @__PURE__ */ React.createElement("span", { className: "dbx-mono" }, snapshot.profile.name)))), /* @__PURE__ */ React.createElement(Stack, { direction: "row", gap: 6 }, url && /* @__PURE__ */ React.createElement(Button, { variant: "ghost", onClick: () => window.open(url, "_blank", "noopener") }, "Open workspace"), /* @__PURE__ */ React.createElement(Button, { onClick: () => setSwitching(!switching) }, switching ? "Done" : "Switch workspace")))), switching && /* @__PURE__ */ React.createElement(Card, null, /* @__PURE__ */ React.createElement(Stack, { gap: 10 }, /* @__PURE__ */ React.createElement(Text, { weight: 500 }, "Switch workspace"), others.map((profile) => /* @__PURE__ */ React.createElement(Stack, { key: profile.name, direction: "row", align: "center", justify: "space-between", gap: 8 }, /* @__PURE__ */ React.createElement(Text, { size: "sm" }, hostLabel(profile.host), " ", /* @__PURE__ */ React.createElement(Text, { tone: "tertiary", size: "xs", mono: true }, profile.name)), /* @__PURE__ */ React.createElement(Button, { size: "sm", onClick: () => run(() => connection.useProfile(profile.name)) }, "Use"))), /* @__PURE__ */ React.createElement(Stack, { direction: "row", gap: 8 }, /* @__PURE__ */ React.createElement(Button, { variant: "brand", size: "sm", onClick: () => run(() => connection.signIn()) }, "Sign in to another workspace"), /* @__PURE__ */ React.createElement(Button, { variant: "danger", size: "sm", onClick: () => connection.disconnect() }, "Disconnect")))));
}
function DefaultsGroup(props) {
  const { service } = props;
  const [warehouseId, setWarehouseId] = usePreference(service, "warehouseId");
  const warehouses = useAsync(
    async (signal) => {
      const client = await service.ready(signal);
      return new Sql(client).warehouses(signal);
    },
    [service.snapshot()]
  );
  const list = warehouses.data ?? [];
  const automatic = Sql.pick(list);
  return /* @__PURE__ */ React.createElement(Stack, { gap: 12 }, /* @__PURE__ */ React.createElement(SectionHeader, { title: "Defaults", description: "Used by Genie, SQL and agents unless you choose otherwise." }), /* @__PURE__ */ React.createElement(
    Field,
    {
      label: "SQL warehouse",
      hint: warehouses.error ? describeError(warehouses.error) : automatic && !warehouseId ? `Automatic picks ${automatic.name}.` : void 0
    },
    /* @__PURE__ */ React.createElement("select", { className: "dbx-select", style: { maxWidth: 420 }, value: warehouseId ?? "", onChange: (event) => setWarehouseId(event.target.value || void 0), disabled: warehouses.loading }, /* @__PURE__ */ React.createElement("option", { value: "" }, "Automatic (prefer running serverless)"), list.map((warehouse) => /* @__PURE__ */ React.createElement("option", { key: warehouse.id, value: warehouse.id }, warehouse.name, " \xB7 ", warehouse.state?.toLowerCase() ?? "unknown", warehouse.enable_serverless_compute ? " \xB7 serverless" : "")))
  ));
}
function SuiteGroup(props) {
  const [pending, setPending] = React.useState();
  const [message, setMessage] = React.useState();
  const install = async (folder, id) => {
    const installer = props.installer();
    if (!installer) {
      setMessage("This version of Buzz can't install plugins from here. Use Settings \u2192 Plugins \u2192 Manage plugins \u2192 Add.");
      return;
    }
    setPending(id);
    setMessage(void 0);
    try {
      const outcome = await installer.requestInstall({ repository: REPOSITORY, reference: "main", path: `plugins/${folder}/dist` });
      if (outcome === "unavailable") setMessage("Close any open plugin review, then try again.");
    } catch (error) {
      setMessage(describeError(error));
    } finally {
      setPending(void 0);
    }
  };
  return /* @__PURE__ */ React.createElement(Stack, { gap: 12 }, /* @__PURE__ */ React.createElement(SectionHeader, { title: "Databricks plugins", description: "Each adds one part of Databricks to Buzz and uses this connection." }), /* @__PURE__ */ React.createElement(Stack, { gap: 8 }, SUITE.map((plugin) => {
    const active = props.active.has(plugin.id);
    return /* @__PURE__ */ React.createElement(Card, { key: plugin.id, padding: 14 }, /* @__PURE__ */ React.createElement(Stack, { direction: "row", align: "center", justify: "space-between", gap: 12 }, /* @__PURE__ */ React.createElement(Stack, { gap: 2, style: { minWidth: 0 } }, /* @__PURE__ */ React.createElement(Stack, { direction: "row", gap: 8, align: "center" }, /* @__PURE__ */ React.createElement(Text, { weight: 500 }, plugin.name), active && /* @__PURE__ */ React.createElement(Badge, { tone: "success" }, "On")), /* @__PURE__ */ React.createElement(Text, { tone: "subtle", size: "sm" }, plugin.blurb)), !active && /* @__PURE__ */ React.createElement(Button, { size: "sm", disabled: pending !== void 0, onClick: () => void install(plugin.folder, plugin.id) }, pending === plugin.id ? "Opening\u2026" : "Add")));
  })), message && /* @__PURE__ */ React.createElement(Notice, { tone: "warning" }, message));
}

// plugins/databricks/src/tools.ts
var SOURCE_ID = "job-run";
function runIdFrom(args) {
  const url = typeof args.url === "string" ? args.url : typeof args.run_url === "string" ? args.run_url : "";
  if (url) {
    const link = parseWorkspaceUrl(url);
    if (link?.kind === "run") return link.runId;
    throw new Error("That URL is not a Databricks job run link.");
  }
  const id = String(args.run_id ?? "").trim();
  if (!/^\d+$/.test(id)) throw new Error("Give a job run URL or a numeric run_id.");
  return id;
}
function describeRun(run, url) {
  const lines = [`${run.name}: ${runLabel(run)}${run.message ? ` \u2014 ${run.message}` : ""}`];
  if (run.startTime) lines.push(`Started ${new Date(run.startTime).toISOString()}${run.endTime ? `, ended ${new Date(run.endTime).toISOString()}` : ""}.`);
  for (const task of run.tasks) lines.push(`- ${task.key}: ${(task.result ?? task.lifecycle).toLowerCase()}${task.message ? ` (${task.message})` : ""}`);
  if (url ?? run.url) lines.push(`Run: ${url ?? run.url}`);
  return lines.join("\n");
}
function coreTools(service) {
  return [
    {
      name: "databricks_workspace",
      description: "Shows which Databricks workspace this device is signed in to, as whom, and the default SQL warehouse. Use it before other databricks_* tools when unsure whether Databricks is connected.",
      inputSchema: schema.object({}),
      async call() {
        const snapshot = service.snapshot();
        if (snapshot.status !== "connected")
          return "Databricks is not connected on this device. Ask the owner to sign in under Settings \u2192 Databricks.";
        const warehouse = service.preferences.get("warehouseId");
        return [
          `Workspace: ${snapshot.profile.host}`,
          `Signed in as: ${snapshot.user.userName}${snapshot.user.displayName ? ` (${snapshot.user.displayName})` : ""}`,
          `Default SQL warehouse: ${warehouse ?? "automatic"}`,
          "Data access follows this user's Unity Catalog permissions. Anything you post is visible to everyone in the conversation, so share query results only where the audience should see them."
        ].join("\n");
      }
    },
    {
      name: "databricks_job_status",
      description: 'Reads the status of a Databricks job run (state, result, failed tasks and messages). Pass the run URL or run_id. To be woken when a run finishes, add an Attention source watch with provider "bkvarda.databricks/job-run" and config {"run_url": "<url>"}.',
      inputSchema: schema.object({
        url: schema.string("A Databricks job run URL, e.g. https://<workspace>/jobs/123/runs/456"),
        run_id: schema.string("The numeric run ID, when you have no URL.")
      }),
      async call(_client, _context, args) {
        const client = await service.ready();
        const run = await new Jobs(client).run(runIdFrom(args));
        return describeRun(run);
      }
    },
    {
      name: "databricks_api_get",
      description: "Read-only escape hatch: performs a GET against any Databricks REST API path in the signed-in workspace (for example /api/2.1/unity-catalog/tables/main.default.orders or /api/2.2/jobs/list) and returns the JSON, truncated to 20,000 characters. Prefer the specific databricks_* tools when one fits.",
      inputSchema: schema.object(
        {
          path: schema.string("API path starting with /api/"),
          query: { type: "object", description: "Query parameters as string values.", additionalProperties: { type: "string" } }
        },
        ["path"]
      ),
      async call(_client, _context, args) {
        const path = stringArg(args, "path");
        if (!/^\/api\/[\w./:@-]+$/.test(path) || path.includes(".."))
          throw new Error("path must be a plain /api/... path without a query string.");
        const query = args.query && typeof args.query === "object" ? args.query : {};
        const client = await service.ready();
        const body = await client.get(path, { query });
        const text = JSON.stringify(body, null, 1);
        return text.length > 2e4 ? `${text.slice(0, 2e4)}
\u2026 (truncated)` : text;
      }
    }
  ];
}
function jobRunSource(service) {
  return {
    id: SOURCE_ID,
    description: "Wakes the agent when a Databricks job run finishes, with its result and any failed tasks.",
    configExample: { run_url: "https://<workspace>/jobs/123/runs/456" },
    present: (watch) => {
      const url = typeof watch.config.run_url === "string" ? watch.config.run_url : void 0;
      const runId = url ? parseWorkspaceUrl(url) : void 0;
      return {
        type: "Databricks job run",
        ...runId?.kind === "run" && { target: `Run ${runId.runId}` },
        ...url && { link: { href: url, title: "Open in Databricks" } }
      };
    },
    async run({ watch, signal, emit }) {
      const config = watch.config;
      const runId = runIdFrom(config);
      const url = typeof config.run_url === "string" ? config.run_url : void 0;
      let failures = 0;
      while (!signal.aborted) {
        try {
          const client = await service.ready(signal);
          const run = await new Jobs(client).run(runId, signal);
          failures = 0;
          if (run.done) {
            emit(`The Databricks job run you were watching finished.
${describeRun(run, url)}`);
            return;
          }
        } catch (error) {
          if (signal.aborted) return;
          if (++failures >= 20) {
            emit(`Stopped watching Databricks run ${runId}: ${error.message ?? error}`);
            return;
          }
        }
        await new Promise((resolve) => {
          const timer = setTimeout(resolve, 3e4);
          signal.addEventListener("abort", () => {
            clearTimeout(timer);
            resolve();
          }, { once: true });
        });
      }
    }
  };
}

// plugins/databricks/src/index.tsx
var inject = ["react", "host", "settingsCards", "conversation", "panels"];
function apply(ctx) {
  bindReact(ctx.react);
  const connection = new Connection(ctx.host);
  const openSettings = () => {
    const navigation = optionalService(ctx, "navigation");
    void navigation?.open({ version: 1, kind: "settings", section: SETTINGS_SECTION });
  };
  const service = createService(connection, openSettings);
  ctx.provide(SERVICE_NAME, service);
  void connection.start();
  const recheck = () => {
    const status = connection.snapshot().status;
    if (status === "signed-out" || status === "cli-missing") void connection.start();
  };
  ctx.effect(() => {
    globalThis.addEventListener?.("focus", recheck);
    return () => globalThis.removeEventListener?.("focus", recheck);
  });
  ctx.settingsCards.register({
    id: "connection",
    title: "Databricks",
    component: () => /* @__PURE__ */ React.createElement(
      ConnectionSettings,
      {
        connection,
        service,
        installer: () => optionalService(ctx, "pluginInstaller")
      }
    )
  });
  ctx.conversation.registerLink({
    id: "workspace",
    title: "Databricks links",
    // Specific to Databricks; plugins that specialize one kind (Genie) use -10.
    matches: (url) => parseWorkspaceUrl(url) !== void 0,
    component: linkChip(service)
  });
  ctx.panels.register({
    id: "workspace",
    title: "Databricks",
    matches: panelMatches,
    keepOpen: true,
    component: workspacePanel(service)
  });
  ctx.inject(["agents"], (scope) => {
    for (const tool of coreTools(service)) scope.agents.addTool(tool);
    scope.agents.addAttentionSource(jobRunSource(service));
  });
}
export {
  apply,
  inject
};
