// Buzz supplies React as `ctx.react`; plugins must not bundle their own copy.
// Every plugin calls `bindReact(ctx.react)` first thing in `apply`, before any
// component renders. JSX in this repository compiles to `React.createElement`
// against this live binding (see scripts/build.mjs).
import type * as ReactNamespace from "react";

export type ReactInstance = typeof ReactNamespace;

// biome-ignore lint/style/useConst: assigned once by bindReact at activation.
export let React: ReactInstance = undefined as unknown as ReactInstance;

export function bindReact(instance: ReactInstance): void {
  React = instance;
}
