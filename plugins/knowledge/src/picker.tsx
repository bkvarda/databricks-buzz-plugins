// A searchable list for choosing one thing (a domain, a schema, a page). Domains
// and schemas can run to hundreds, so the list filters as you type.
import { React } from "@dbx/core/react";
import { Text } from "@dbx/core/ui/components";

export type Choice = Readonly<{ id: string; label: string; detail?: string; disabled?: boolean }>;

export function SearchList(props: {
  label: string;
  choices: readonly Choice[];
  value?: string;
  placeholder?: string;
  emptyText?: string;
  onPick(id: string): void;
}) {
  const [query, setQuery] = React.useState("");
  const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  const shown = props.choices
    .filter((choice) => {
      const text = `${choice.label} ${choice.detail ?? ""}`.toLowerCase();
      return words.every((word) => text.includes(word));
    })
    .slice(0, 200);
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 6, minWidth: 0 }}>
      <input
        className="dbx-input"
        type="search"
        aria-label={`Search ${props.label.toLowerCase()}`}
        placeholder={props.placeholder ?? "Search"}
        value={query}
        onChange={(event) => setQuery(event.target.value)}
      />
      <div
        role="listbox"
        aria-label={props.label}
        style={{ maxHeight: 220, overflowY: "auto", border: "1px solid var(--dbx-border)", borderRadius: "var(--dbx-radius)" }}
      >
        {shown.length ? (
          shown.map((choice) => {
            const selected = choice.id === props.value;
            return (
              <button
                key={choice.id}
                type="button"
                role="option"
                aria-selected={selected}
                disabled={choice.disabled}
                onClick={() => props.onPick(choice.id)}
                style={{
                  display: "flex",
                  width: "100%",
                  justifyContent: "space-between",
                  alignItems: "baseline",
                  gap: 8,
                  padding: "6px 10px",
                  border: 0,
                  background: selected ? "var(--dbx-brand-tint)" : "transparent",
                  color: "var(--dbx-ink)",
                  font: "inherit",
                  textAlign: "left",
                  cursor: choice.disabled ? "default" : "pointer",
                  opacity: choice.disabled ? 0.6 : 1,
                }}
              >
                <span style={{ minWidth: 0, overflowWrap: "anywhere" }}>{choice.label}</span>
                {choice.detail && (
                  <Text size="xs" tone="subtle">
                    {choice.detail}
                  </Text>
                )}
              </button>
            );
          })
        ) : (
          <Text tone="subtle" size="sm" style={{ padding: "8px 10px" }}>
            {props.emptyText ?? "Nothing matches."}
          </Text>
        )}
      </div>
    </div>
  );
}
