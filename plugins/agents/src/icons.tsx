// Small marks for our agent types' kinds (the Type picker): our own, drawn in
// Databricks Lava like the Databricks mark beside them in Buzz's Harness menu,
// and Omnigent's logo for Omnigent agents.
// Components, not elements: React is bound only once a plugin starts.
import { React } from "@dbx/core/react";
import { svgDataUri } from "@dbx/core/ui/theme";
import { OMNIGENT_LOGO_SVG } from "./omnigent-logo";

const OMNIGENT_LOGO = svgDataUri(OMNIGENT_LOGO_SVG);

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

/** Omnigent agent: Omnigent's own logo. */
export function OmnigentKindIcon({ size = 20 }: IconProps) {
  return <img src={OMNIGENT_LOGO} width={size} height={size} alt="" aria-hidden draggable={false} style={{ display: "block" }} />;
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
