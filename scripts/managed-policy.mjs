#!/usr/bin/env node
// Prints a Buzz managed-plugins policy (version 1) recommending the suite at
// the current commit. Buzz requires an exact commit, so generate it per release:
//   node scripts/managed-policy.mjs "Example Org" > managed-plugins.json
import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
const source = process.argv[2] ?? "Databricks plugins";
const commit = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
const reference = execFileSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], { encoding: "utf8" }).trim();
const plugins = readdirSync("plugins").sort().map((folder) => ({
  id: JSON.parse(readFileSync(`plugins/${folder}/manifest.json`, "utf8")).id,
  repository: "https://github.com/bkvarda/databricks-buzz-plugins",
  reference,
  commit,
  path: `plugins/${folder}/dist`,
}));
console.log(JSON.stringify({ version: 1, source, plugins }, null, 2));
