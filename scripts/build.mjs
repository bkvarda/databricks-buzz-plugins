#!/usr/bin/env node
// Builds every plugin under plugins/* into plugins/<name>/dist:
//   manifest.json  plugin.js  [README.md]  [icon.png]
// Buzz API v1 loads one self-contained ES module per plugin. React, Cordis and
// @buzz/author come from the host at runtime, so importing them is an error.
import { build } from "esbuild";
import { copyFile, mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const only = process.argv.slice(2);
const rootPackage = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
const plugins = (await readdir(join(root, "plugins"), { withFileTypes: true }))
  .filter((entry) => entry.isDirectory() && (!only.length || only.includes(entry.name)))
  .map((entry) => entry.name)
  .sort();

const hostOnly = {
  name: "host-supplied",
  setup(builder) {
    builder.onResolve({ filter: /^(react|react-dom)(\/.*)?$|^@buzz\/author$|^@deepseek-ai\/cordis(\/.*)?$/ }, (args) => ({
      errors: [{ text: `${args.path} is supplied by Buzz at runtime; use \`import type\` (from ${args.importer})` }],
    }));
  },
};

const exists = (path) => stat(path).then(() => true, () => false);
let failed = false;

// A plugin with a runner/ (the hosted agent's runner, which runs in a
// Databricks Sandbox under Node) gets it bundled for Node and embedded as
// `virtual:agent-runner`, so the plugin can upload it.
async function runnerModule(dir) {
  const entry = join(dir, "runner/main.ts");
  if (!(await exists(entry))) return undefined;
  const result = await build({
    entryPoints: [entry],
    bundle: true,
    format: "esm",
    platform: "node",
    target: "node22",
    minify: true,
    legalComments: "none",
    write: false,
    tsconfig: join(root, "tsconfig.json"),
    banner: { js: "// Databricks Agents runner for Buzz (built by databricks-buzz-plugins). Apache-2.0." },
    logLevel: "silent",
  });
  const code = result.outputFiles[0].text;
  const sha = createHash("sha256").update(code).digest("hex").slice(0, 16);
  return { code, sha };
}

for (const name of plugins) {
  const dir = join(root, "plugins", name);
  const manifestPath = join(dir, "manifest.json");
  if (!(await exists(manifestPath))) continue;
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  const out = join(dir, "dist");
  await rm(out, { recursive: true, force: true });
  await mkdir(out, { recursive: true });
  try {
    const runner = await runnerModule(dir);
    const embed = {
      name: "agent-runner",
      setup(builder) {
        builder.onResolve({ filter: /^virtual:agent-runner$/ }, () => ({ path: "agent-runner", namespace: "virtual" }));
        builder.onLoad({ filter: /.*/, namespace: "virtual" }, () => {
          if (!runner) throw new Error("virtual:agent-runner needs runner/main.ts");
          return { contents: `export const RUNNER = ${JSON.stringify(runner.code)};\nexport const RUNNER_SHA = ${JSON.stringify(runner.sha)};`, loader: "js" };
        });
      },
    };
    const result = await build({
      entryPoints: [join(dir, "src/index.tsx")],
      bundle: true,
      format: "esm",
      platform: "browser",
      target: "es2022",
      jsx: "transform",
      jsxFactory: "React.createElement",
      jsxFragment: "React.Fragment",
      outfile: join(out, "plugin.js"),
      minify: false,
      legalComments: "none",
      treeShaking: true,
      metafile: true,
      tsconfig: join(root, "tsconfig.json"),
      plugins: [hostOnly, embed],
      define: { "process.env.NODE_ENV": '"production"', __PLUGIN_VERSION__: JSON.stringify(rootPackage.version) },
      banner: { js: `// ${manifest.name} (${manifest.id}) — built by databricks-buzz-plugins. Apache-2.0.` },
      logLevel: "silent",
    });
    const output = Object.values(result.metafile.outputs)[0];
    if (output.imports.length) throw new Error(`plugin.js must not import anything: ${output.imports.map((i) => i.path).join(", ")}`);
    if (!output.exports.includes("apply") || !output.exports.includes("inject"))
      throw new Error("plugin.js must export inject and apply(ctx)");
    const code = await readFile(join(out, "plugin.js"), "utf8");
    if (Buffer.byteLength(code) > 8 * 1024 * 1024) throw new Error("plugin.js exceeds Buzz's 8 MiB artifact limit");
    await writeFile(join(out, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
    for (const extra of ["README.md", "icon.png"]) if (await exists(join(dir, extra))) await copyFile(join(dir, extra), join(out, extra));
    console.log(`✓ ${name.padEnd(20)} ${(Buffer.byteLength(code) / 1024).toFixed(1).padStart(7)} KiB  ${manifest.id}${runner ? ` (runner ${(Buffer.byteLength(runner.code) / 1024).toFixed(0)} KiB)` : ""}`);
  } catch (error) {
    failed = true;
    console.error(`✗ ${name}: ${error.message ?? error}`);
    for (const message of error.errors ?? []) console.error(`  ${message.location?.file ?? ""}:${message.location?.line ?? ""} ${message.text}`);
  }
}
process.exit(failed ? 1 : 0);
