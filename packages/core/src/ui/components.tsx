import type { CSSProperties, ReactNode } from "react";
import { React } from "../react";
import { DATABRICKS_MARK_PATH, DATABRICKS_MARK_SVG, ensureStyles } from "./theme";

export function DbxRoot(props: {
  children: ReactNode;
  style?: CSSProperties;
  className?: string;
}) {
  ensureStyles();
  return (
    <div data-dbx="" className={props.className} style={props.style}>
      {props.children}
    </div>
  );
}

type IconProps = Omit<React.SVGProps<SVGSVGElement>, "ref"> & { size?: string | number; title?: string };

/**
 * The Databricks mark as a Buzz design-system icon component (for agent types
 * and other host-owned choices): an SVG sized by `size`, centered in a square.
 * Call after `bindReact`.
 */
export function databricksIcon() {
  return React.forwardRef<SVGSVGElement, IconProps>(function DatabricksIcon({ size = "1em", title, color: _color, ...props }, ref) {
    return (
      <svg ref={ref} viewBox="-15.5 0 331 331" width={size} height={size} fill="none" role={title ? "img" : undefined} aria-hidden={title ? undefined : true} {...props}>
        {title && <title>{title}</title>}
        <path fill="#FF3621" d={DATABRICKS_MARK_PATH} />
      </svg>
    );
  });
}

export function DatabricksMark(props: { size?: number; title?: string; /** "current" paints with the text color, e.g. on a Lava button. */ color?: "brand" | "current" }) {
  const size = props.size ?? 16;
  const svg = props.color === "current" ? DATABRICKS_MARK_SVG.replace('fill="#FF3621"', 'fill="currentColor"') : DATABRICKS_MARK_SVG;
  return (
    <span
      role={props.title ? "img" : undefined}
      aria-label={props.title}
      aria-hidden={props.title ? undefined : true}
      style={{ display: "inline-flex", width: size, height: size * 1.1, flex: "none" }}
      // Static, trusted SVG constant; no user content.
      dangerouslySetInnerHTML={{ __html: svg.replace("<svg ", `<svg width="${size}" height="${size * 1.1}" `) }}
    />
  );
}

type ButtonProps = {
  children?: ReactNode;
  onClick?: () => void;
  variant?: "default" | "primary" | "brand" | "ghost" | "danger";
  size?: "sm" | "md";
  disabled?: boolean;
  type?: "button" | "submit";
  title?: string;
  "aria-label"?: string;
  icon?: boolean;
  style?: CSSProperties;
};

export function Button(props: ButtonProps) {
  return (
    <button
      type={props.type ?? "button"}
      className={`dbx-btn${props.icon ? " dbx-icon-btn" : ""}`}
      data-variant={props.variant ?? "default"}
      data-size={props.size ?? "md"}
      disabled={props.disabled}
      onClick={props.onClick}
      title={props.title}
      aria-label={props["aria-label"]}
      style={props.style}
    >
      {props.children}
    </button>
  );
}

export function Spinner(props: { size?: number; label?: string }) {
  const size = props.size ?? 14;
  return (
    <span
      role="status"
      aria-label={props.label ?? "Loading"}
      style={{
        display: "inline-block",
        width: size,
        height: size,
        borderRadius: "50%",
        border: "2px solid var(--dbx-border-strong)",
        borderTopColor: "var(--dbx-lava)",
        animation: "dbx-spin 0.8s linear infinite",
        flex: "none",
      }}
    />
  );
}

export function Stack(props: {
  children: ReactNode;
  gap?: number;
  direction?: "row" | "column";
  align?: CSSProperties["alignItems"];
  justify?: CSSProperties["justifyContent"];
  wrap?: boolean;
  style?: CSSProperties;
}) {
  return (
    <div
      style={{
        display: "flex",
        flexDirection: props.direction ?? "column",
        gap: props.gap ?? 8,
        alignItems: props.align,
        justifyContent: props.justify,
        flexWrap: props.wrap ? "wrap" : undefined,
        minWidth: 0,
        ...props.style,
      }}
    >
      {props.children}
    </div>
  );
}

export function Text(props: {
  children: ReactNode;
  tone?: "standard" | "subtle" | "tertiary" | "danger" | "success" | "warning" | "brand";
  size?: "xs" | "sm" | "md" | "lg" | "xl";
  weight?: 400 | 500 | 600;
  as?: "p" | "span" | "div" | "h2" | "h3" | "h4";
  mono?: boolean;
  style?: CSSProperties;
  id?: string;
}) {
  const color = {
    standard: "var(--dbx-ink)",
    subtle: "var(--dbx-subtle)",
    tertiary: "var(--dbx-tertiary)",
    danger: "var(--dbx-danger)",
    success: "var(--dbx-success)",
    warning: "var(--dbx-warning)",
    brand: "var(--dbx-lava-text)",
  }[props.tone ?? "standard"];
  const fontSize = { xs: "0.6875rem", sm: "0.75rem", md: "0.8125rem", lg: "0.9375rem", xl: "1.125rem" }[
    props.size ?? "md"
  ];
  const Tag = props.as ?? "span";
  return React.createElement(
    Tag,
    {
      id: props.id,
      className: props.mono ? "dbx-mono" : undefined,
      style: {
        margin: 0,
        color,
        fontSize,
        fontWeight: props.weight ?? (Tag.startsWith("h") ? 500 : 400),
        lineHeight: 1.45,
        ...props.style,
      },
    },
    props.children,
  );
}

export function Card(props: {
  children: ReactNode;
  padding?: number | string;
  style?: CSSProperties;
}) {
  return (
    <div className="dbx-card" style={{ padding: props.padding ?? 16, ...props.style }}>
      {props.children}
    </div>
  );
}

/**
 * Opens a web page in the person's browser. Buzz's desktop opener sends
 * clicks on `target="_blank"` links to the default browser but never sees
 * `window.open`, so this clicks such a link. In a plain browser it opens a tab.
 */
export function openExternal(url: string, doc: Document = document): void {
  const link = doc.createElement("a");
  link.href = url;
  link.target = "_blank";
  link.rel = "noreferrer";
  link.style.display = "none";
  doc.body.appendChild(link);
  link.click();
  link.remove();
}

export function Notice(props: {
  tone?: "info" | "warning" | "danger" | "success";
  title?: ReactNode;
  children?: ReactNode;
  action?: ReactNode;
}) {
  const tone = props.tone ?? "info";
  const accent = {
    info: "var(--dbx-border-strong)",
    warning: "var(--dbx-warning)",
    danger: "var(--dbx-danger)",
    success: "var(--dbx-success)",
  }[tone];
  return (
    <div
      role={tone === "danger" ? "alert" : "status"}
      style={{
        display: "flex",
        gap: 12,
        alignItems: "flex-start",
        justifyContent: "space-between",
        padding: "10px 12px",
        borderRadius: "var(--dbx-radius)",
        border: "1px solid var(--dbx-border)",
        background: "var(--dbx-inset)",
        boxShadow: `inset 3px 0 0 ${accent}`,
      }}
    >
      <Stack gap={2} style={{ minWidth: 0 }}>
        {props.title && (
          <Text weight={500} size="md">
            {props.title}
          </Text>
        )}
        {props.children && (
          <Text tone="subtle" size="sm" as="div">
            {props.children}
          </Text>
        )}
      </Stack>
      {props.action && <div style={{ flex: "none" }}>{props.action}</div>}
    </div>
  );
}

export function EmptyState(props: {
  title: ReactNode;
  children?: ReactNode;
  action?: ReactNode;
  mark?: boolean;
}) {
  return (
    <Stack
      align="center"
      gap={10}
      style={{ textAlign: "center", padding: "40px 24px", maxWidth: 420, margin: "0 auto" }}
    >
      {props.mark !== false && <DatabricksMark size={28} />}
      <Text as="h3" size="lg" weight={500}>
        {props.title}
      </Text>
      {props.children && (
        <Text tone="subtle" as="div">
          {props.children}
        </Text>
      )}
      {props.action}
    </Stack>
  );
}

export function Badge(props: {
  children: ReactNode;
  tone?: "neutral" | "brand" | "success" | "warning" | "danger";
  title?: string;
}) {
  const tone = props.tone ?? "neutral";
  const color = {
    neutral: "var(--dbx-subtle)",
    brand: "var(--dbx-lava-text)",
    success: "var(--dbx-success)",
    warning: "var(--dbx-warning)",
    danger: "var(--dbx-danger)",
  }[tone];
  return (
    <span
      title={props.title}
      style={{
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
        whiteSpace: "nowrap",
      }}
    >
      {props.children}
    </span>
  );
}

export function StatusDot(props: {
  tone: "success" | "warning" | "danger" | "neutral" | "active";
  label: string;
}) {
  const color = {
    success: "var(--dbx-success)",
    warning: "var(--dbx-warning)",
    danger: "var(--dbx-danger)",
    neutral: "var(--dbx-tertiary)",
    active: "var(--dbx-lava)",
  }[props.tone];
  return (
    <span
      role="img"
      aria-label={props.label}
      title={props.label}
      style={{
        display: "inline-block",
        width: 8,
        height: 8,
        borderRadius: "50%",
        background: color,
        flex: "none",
        animation: props.tone === "active" ? "dbx-pulse 1.4s ease-in-out infinite" : undefined,
      }}
    />
  );
}

export function Field(props: { label: string; hint?: ReactNode; children: ReactNode; id?: string }) {
  return (
    <label style={{ display: "flex", flexDirection: "column", gap: 4, minWidth: 0 }} htmlFor={props.id}>
      <Text size="sm" weight={500}>
        {props.label}
      </Text>
      {props.children}
      {props.hint && (
        <Text size="xs" tone="subtle" as="div">
          {props.hint}
        </Text>
      )}
    </label>
  );
}

export function SectionHeader(props: { title: ReactNode; description?: ReactNode; action?: ReactNode }) {
  return (
    <div style={{ display: "flex", alignItems: "flex-end", justifyContent: "space-between", gap: 12 }}>
      <Stack gap={2}>
        <Text as="h3" size="md" weight={500}>
          {props.title}
        </Text>
        {props.description && (
          <Text tone="subtle" size="sm" as="div">
            {props.description}
          </Text>
        )}
      </Stack>
      {props.action}
    </div>
  );
}

export function CopyButton(props: { text: string; label?: string }) {
  const [copied, setCopied] = React.useState(false);
  return (
    <Button
      size="sm"
      variant="ghost"
      onClick={() => {
        void navigator.clipboard?.writeText(props.text).then(() => {
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        });
      }}
    >
      {copied ? "Copied" : (props.label ?? "Copy")}
    </Button>
  );
}

export function CodeView(props: { code: string; language?: string; maxHeight?: number; copy?: boolean }) {
  return (
    <div style={{ position: "relative" }}>
      <pre
        className="dbx-mono"
        style={{
          margin: 0,
          padding: "10px 12px",
          background: "var(--dbx-inset)",
          border: "1px solid var(--dbx-border)",
          borderRadius: "var(--dbx-radius)",
          fontSize: "0.75rem",
          lineHeight: 1.5,
          overflow: "auto",
          maxHeight: props.maxHeight ?? 260,
          whiteSpace: "pre",
        }}
      >
        <code>{props.code}</code>
      </pre>
      {props.copy !== false && (
        <div style={{ position: "absolute", top: 4, right: 4 }}>
          <CopyButton text={props.code} />
        </div>
      )}
    </div>
  );
}

export function Disclosure(props: { summary: ReactNode; children: ReactNode; defaultOpen?: boolean }) {
  return (
    <details open={props.defaultOpen}>
      <summary style={{ cursor: "pointer", fontSize: "0.75rem", color: "var(--dbx-subtle)", userSelect: "none" }}>
        {props.summary}
      </summary>
      <div style={{ marginTop: 8 }}>{props.children}</div>
    </details>
  );
}

/**
 * A modal in the browser's top layer (a native <dialog> opened with
 * showModal), so no message row, scroller or transform around the component
 * that opens it can clip or move it: plugins get no portal. Escape or the
 * close button dismisses it; a click outside doesn't, so edits aren't lost.
 */
export function Modal(props: { title: string; onClose(): void; children: ReactNode }) {
  const ref = React.useRef<HTMLDialogElement>(null);
  const onClose = React.useRef(props.onClose);
  onClose.current = props.onClose;
  React.useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (!dialog.open) {
      if (typeof dialog.showModal === "function") dialog.showModal();
      else dialog.setAttribute("open", "");
    }
    const cancel = (event: Event) => {
      event.preventDefault();
      onClose.current();
    };
    dialog.addEventListener("cancel", cancel);
    return () => {
      dialog.removeEventListener("cancel", cancel);
      if (dialog.open && typeof dialog.close === "function") dialog.close();
    };
  }, []);
  ensureStyles();
  return (
    <dialog ref={ref} className="dbx-modal" aria-label={props.title}>
      <DbxRoot style={{ padding: 20, overflow: "auto" }}>
        <Stack gap={14}>
          <Stack direction="row" justify="space-between" align="center" gap={8}>
            <Text as="h2" size="xl" weight={500}>
              {props.title}
            </Text>
            <Button variant="ghost" size="sm" aria-label="Close" onClick={() => onClose.current()}>
              ✕
            </Button>
          </Stack>
          {props.children}
        </Stack>
      </DbxRoot>
    </dialog>
  );
}

/** Formats relative age like "2m ago". */
export function ago(ms: number, now = Date.now()) {
  const s = Math.max(0, Math.round((now - ms) / 1000));
  if (s < 45) return "just now";
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.round(h / 24)}d ago`;
}
