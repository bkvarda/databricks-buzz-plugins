// Small marks for our agent types' kinds (the Type picker), drawn in
// Databricks Lava like the Databricks mark beside them in Buzz's Harness menu.
// Components, not elements: React is bound only once a plugin starts.
import { React } from "@dbx/core/react";

const LAVA = "#FF3621";

type IconProps = Readonly<{ size?: number }>;

const svg = (size: number, children: React.ReactNode) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden focusable="false">
    {children}
  </svg>
);

/** Genie: two sparkles. */
export function GenieKindIcon({ size = 20 }: IconProps) {
  return svg(
    size,
    <>
      <path fill={LAVA} d="M10 2.5c.7 4.4 2.8 6.6 7.2 7.3-4.4.7-6.5 2.9-7.2 7.3-.7-4.4-2.8-6.6-7.2-7.3 4.4-.7 6.5-2.9 7.2-7.3Z" />
      <path fill={LAVA} d="M18 14c.35 2 1.3 2.95 3.3 3.3-2 .35-2.95 1.3-3.3 3.3-.35-2-1.3-2.95-3.3-3.3 2-.35 2.95-1.3 3.3-3.3Z" />
    </>,
  );
}

/** Sandbox agent: a terminal. */
export function SandboxKindIcon({ size = 20 }: IconProps) {
  return svg(
    size,
    <>
      <rect x="2.5" y="4" width="19" height="16" rx="3.5" fill={LAVA} />
      <path d="M7 9.25 10 12l-3 2.75M12.5 15h4.5" stroke="#fff" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
    </>,
  );
}

/** Omnigent agent: one hub that brings several agents together. */
export function OmnigentKindIcon({ size = 20 }: IconProps) {
  return svg(
    size,
    <>
      <path d="M12 12V4.5M12 12l6.5 3.75M12 12l-6.5 3.75" stroke={LAVA} strokeWidth="1.8" strokeLinecap="round" />
      <circle cx="12" cy="12" r="3.4" fill={LAVA} />
      <circle cx="12" cy="4" r="2.3" fill={LAVA} />
      <circle cx="18.9" cy="16" r="2.3" fill={LAVA} />
      <circle cx="5.1" cy="16" r="2.3" fill={LAVA} />
    </>,
  );
}

/** Custom agent: building blocks, for an agent built with Agent Bricks, Model Serving or an App. */
export function CustomKindIcon({ size = 20 }: IconProps) {
  return svg(
    size,
    <>
      <rect x="7.25" y="2.75" width="9.5" height="8.5" rx="2" fill={LAVA} />
      <rect x="2.25" y="12.75" width="9.5" height="8.5" rx="2" fill={LAVA} />
      <rect x="12.25" y="12.75" width="9.5" height="8.5" rx="2" fill={LAVA} />
    </>,
  );
}
