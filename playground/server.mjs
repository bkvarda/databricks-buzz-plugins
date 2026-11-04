#!/usr/bin/env node
// Local playground for the Databricks Buzz plugins.
//
// Serves a page that loads the *built* plugin.js artifacts into a mock Buzz
// context (pages, settings, conversation renderers, panels, agent tools) with
// Buzz's real design tokens, and implements `host.spawn` by running only the
// processes the core plugin's manifest declares, exactly as Buzz would. Real
// Databricks calls, real UI, no Buzz build needed.
//
//   npm run playground        → prints http://127.0.0.1:<port>/?token=…
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const token = randomBytes(16).toString("hex");
const manifest = JSON.parse(await readFile(join(root, "plugins/databricks/manifest.json"), "utf8"));
const declared = new Map(manifest.host.processes.map((process) => [process.id, process]));
const port = Number(process.env.PORT ?? 0);

async function bundle() {
  const result = await build({
    entryPoints: [join(root, "playground/app.tsx")],
    bundle: true,
    write: false,
    format: "esm",
    jsx: "automatic",
    target: "es2022",
    tsconfig: join(root, "tsconfig.json"),
    define: { "process.env.NODE_ENV": '"development"' },
    logLevel: "silent",
  });
  return result.outputFiles[0].text;
}

const server = createServer(async (request, response) => {
  const url = new URL(request.url ?? "/", "http://127.0.0.1");
  const send = (status, type, body) => {
    response.writeHead(status, { "Content-Type": type, "Cache-Control": "no-store" });
    response.end(body);
  };
  try {
    if (url.pathname === "/") return send(200, "text/html", await readFile(join(root, "playground/index.html")));
    if (url.pathname === "/buzz-tokens.css") return send(200, "text/css", await readFile(join(root, "playground/buzz-tokens.css")));
    if (url.pathname === "/app.js") return send(200, "text/javascript", await bundle());
    const plugin = /^\/plugins\/([a-z-]+)\/plugin\.js$/.exec(url.pathname);
    if (plugin) return send(200, "text/javascript", await readFile(join(root, "plugins", plugin[1], "dist/plugin.js")));
    if (url.pathname === "/spawn" && request.method === "POST") {
      if (url.searchParams.get("token") !== token) return send(403, "text/plain", "bad token");
      let raw = "";
      for await (const chunk of request) raw += chunk;
      const { id, args = [], env = {}, stdin = "" } = JSON.parse(raw);
      const declaredProcess = declared.get(id);
      if (!declaredProcess) return send(400, "text/plain", `process ${id} is not declared`);
      const childEnv = { ...process.env, PATH: `${process.env.PATH}:/opt/homebrew/bin:${process.env.HOME}/.local/bin` };
      for (const [key, value] of Object.entries(env)) value === null ? delete childEnv[key] : (childEnv[key] = value);
      response.writeHead(200, { "Content-Type": "application/x-ndjson", "Cache-Control": "no-store" });
      const child = spawn(declaredProcess.program, [...(declaredProcess.args ?? []), ...args], { env: childEnv });
      const emit = (event) => response.write(`${JSON.stringify(event)}\n`);
      child.stdout.setEncoding("utf8").on("data", (data) => emit({ type: "stdout", data }));
      child.stderr.setEncoding("utf8").on("data", (data) => emit({ type: "stderr", data }));
      child.on("error", (error) => {
        emit({ type: "stderr", data: String(error.message) });
        emit({ type: "exit", code: 127 });
        response.end();
      });
      child.on("close", (code) => {
        emit({ type: "exit", code });
        response.end();
      });
      request.on("close", () => child.kill("SIGTERM"));
      child.stdin.end(stdin);
      return;
    }
    send(404, "text/plain", "not found");
  } catch (error) {
    send(500, "text/plain", String(error?.stack ?? error));
  }
});

server.listen(port, "127.0.0.1", () => {
  const address = server.address();
  console.log(`Playground: http://127.0.0.1:${address.port}/?token=${token}`);
});
