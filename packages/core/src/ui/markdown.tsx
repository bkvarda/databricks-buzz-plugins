// A small, safe Markdown renderer for model and Genie answers. It builds React
// elements directly (never HTML strings), so content cannot inject markup.
// Supported: paragraphs, headings, lists, fenced code, pipe tables, inline
// code, bold, italics and http(s) links.
import type { ReactNode } from "react";
import { React } from "../react";

const SAFE_URL = /^https?:\/\//i;

export function renderInline(text: string, keyPrefix = "i"): ReactNode[] {
  const nodes: ReactNode[] = [];
  const pattern =
    /(\\[\\`*_{}[\]()#+\-.!~|<>$])|(`[^`]+`)|(\*\*[^*]+\*\*)|(__[^_]+__)|(\*[^*\s][^*]*\*)|(\[[^\]]+\]\([^)\s]+\))|(https?:\/\/[^\s)<>]+)/g;
  let last = 0;
  let match: RegExpExecArray | null;
  let index = 0;
  // biome-ignore lint/suspicious/noAssignInExpressions: standard regex loop
  while ((match = pattern.exec(text))) {
    if (match.index > last) nodes.push(text.slice(last, match.index));
    const token = match[0];
    const key = `${keyPrefix}-${index++}`;
    if (token.length === 2 && token.startsWith("\\")) nodes.push(token.slice(1));
    else if (token.startsWith("`")) nodes.push(<code key={key}>{token.slice(1, -1)}</code>);
    else if (token.startsWith("**") || token.startsWith("__"))
      nodes.push(<strong key={key}>{renderInline(token.slice(2, -2), key)}</strong>);
    else if (token.startsWith("*")) nodes.push(<em key={key}>{renderInline(token.slice(1, -1), key)}</em>);
    else if (token.startsWith("[")) {
      const label = token.slice(1, token.indexOf("]("));
      const href = token.slice(token.indexOf("](") + 2, -1);
      nodes.push(
        SAFE_URL.test(href) ? (
          <a key={key} href={href} target="_blank" rel="noreferrer" className="dbx-link">
            {label}
          </a>
        ) : (
          label
        ),
      );
    } else
      nodes.push(
        <a key={key} href={token} target="_blank" rel="noreferrer" className="dbx-link">
          {token}
        </a>,
      );
    last = match.index + token.length;
  }
  if (last < text.length) nodes.push(text.slice(last));
  return nodes;
}

type Block =
  | { type: "p"; text: string }
  | { type: "h"; level: number; text: string }
  | { type: "ul" | "ol"; items: string[] }
  | { type: "code"; lang: string; code: string }
  | { type: "table"; header: string[]; rows: string[][] };

const cells = (line: string) =>
  line
    .trim()
    .replace(/^\|/, "")
    .replace(/\|$/, "")
    .split("|")
    .map((cell) => cell.trim());

export function parseBlocks(source: string): Block[] {
  const lines = source.replace(/\r\n?/g, "\n").split("\n");
  const blocks: Block[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i] ?? "";
    if (!line.trim()) {
      i++;
      continue;
    }
    const fence = /^```(\S*)/.exec(line);
    if (fence) {
      const body: string[] = [];
      i++;
      while (i < lines.length && !/^```/.test(lines[i] ?? "")) body.push(lines[i++] ?? "");
      i++;
      blocks.push({ type: "code", lang: fence[1] ?? "", code: body.join("\n") });
      continue;
    }
    const heading = /^(#{1,4})\s+(.*)$/.exec(line);
    if (heading) {
      blocks.push({ type: "h", level: heading[1]?.length ?? 1, text: heading[2] ?? "" });
      i++;
      continue;
    }
    if (/^\s*\|.*\|\s*$/.test(line) && /^\s*\|?\s*:?-{2,}/.test(lines[i + 1] ?? "")) {
      const header = cells(line);
      const rows: string[][] = [];
      i += 2;
      while (i < lines.length && /^\s*\|.*\|\s*$/.test(lines[i] ?? "")) rows.push(cells(lines[i++] ?? ""));
      blocks.push({ type: "table", header, rows });
      continue;
    }
    const bullet = /^\s*[-*+]\s+/;
    const ordered = /^\s*\d+[.)]\s+/;
    if (bullet.test(line) || ordered.test(line)) {
      const type = bullet.test(line) ? "ul" : "ol";
      const marker = type === "ul" ? bullet : ordered;
      const items: string[] = [];
      while (i < lines.length && marker.test(lines[i] ?? "")) items.push((lines[i++] ?? "").replace(marker, ""));
      blocks.push({ type, items });
      continue;
    }
    const paragraph: string[] = [];
    while (
      i < lines.length &&
      (lines[i] ?? "").trim() &&
      !/^```|^#{1,4}\s|^\s*[-*+]\s+|^\s*\d+[.)]\s+/.test(lines[i] ?? "")
    )
      paragraph.push(lines[i++] ?? "");
    blocks.push({ type: "p", text: paragraph.join("\n") });
  }
  return blocks;
}

export function Markdown(props: { source: string; size?: "sm" | "md" }) {
  const blocks = React.useMemo(() => parseBlocks(props.source), [props.source]);
  return (
    <div className="dbx-md" style={{ fontSize: props.size === "sm" ? "0.75rem" : "0.8125rem", lineHeight: 1.55 }}>
      {blocks.map((block, index) => {
        const key = `b${index}`;
        switch (block.type) {
          case "p":
            return (
              <p key={key} style={{ whiteSpace: "pre-wrap" }}>
                {renderInline(block.text, key)}
              </p>
            );
          case "h":
            return (
              <p key={key} style={{ fontWeight: 600, fontSize: block.level <= 2 ? "0.9375rem" : undefined }}>
                {renderInline(block.text, key)}
              </p>
            );
          case "ul":
          case "ol":
            return React.createElement(
              block.type,
              { key },
              block.items.map((item, n) => <li key={`${key}-${n}`}>{renderInline(item, `${key}-${n}`)}</li>),
            );
          case "code":
            return (
              <pre key={key}>
                <code>{block.code}</code>
              </pre>
            );
          case "table":
            return (
              <div key={key} style={{ overflow: "auto", margin: "0 0 8px" }}>
                <table className="dbx-table">
                  <thead>
                    <tr>
                      {block.header.map((cell, n) => (
                        <th key={`${key}-h${n}`}>{renderInline(cell)}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {block.rows.map((row, r) => (
                      <tr key={`${key}-r${r}`}>
                        {row.map((cell, n) => (
                          <td key={`${key}-r${r}-${n}`}>{renderInline(cell)}</td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            );
        }
        return null;
      })}
    </div>
  );
}
