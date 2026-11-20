// Stands in for virtual:signals-poller (embedded by scripts/build.mjs) in tests: the real example sources.
import { readFileSync } from "node:fs";
export const POLLER = "# poller.py stub\n";
export const EXAMPLE_SOURCES = readFileSync(new URL("../../plugins/signals/deploy/sources.example.json", import.meta.url), "utf8");
