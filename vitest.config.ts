import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: { alias: { "@dbx/core": fileURLToPath(new URL("./packages/core/src", import.meta.url)) } },
  esbuild: { jsx: "transform", jsxFactory: "React.createElement", jsxFragment: "React.Fragment" },
  test: { include: ["tests/**/*.test.ts", "tests/**/*.test.tsx"], testTimeout: 60_000 },
});
