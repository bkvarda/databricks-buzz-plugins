// The hub's posts in Buzz, read back for the cards that show them. The hub
// writes plain Markdown that agents read in full (app/hub.ts: taskMessage,
// questionMessage, doneMessage, changedMessage…). People get a card instead:
// the parts for them up front, and everything meant for agents folded away.
// Nothing here changes what agents get.

/** A fact the card shows about the source, like "21 attendees · 5 customer". */
export type Fact = Readonly<{ label: string; value: string }>;

/** A default action the hub found triggered (its `**Triggered:**` line): the action, and the model's reason. */
export type Triggered = Readonly<{ label: string; why?: string }>;

export type TaskPost = Readonly<{
  id: number;
  title: string;
  account?: string;
  workstream?: string;
  initiative?: string;
  rule?: string;
  mode?: string;
  /** What the post asked when it was posted (a series question, say); the hub's task has what it asks now. */
  question?: string;
  options: readonly string[];
  source?: TaskSource;
  /** Whether the post asks agents to work on it (it mentions them). */
  asksAgents: boolean;
  /** The workstream's default actions that triggered as it opened. */
  triggered: readonly Triggered[];
  /** When the workstream has default actions and none triggered: what the hub did then (left it tracked, or dismissed it). */
  untriggered?: "dismissed" | "tracked";
}>;

export type TaskSource = Readonly<{
  /** The source's name, like `slack`, `google_calendar` or `table.incident`. */
  kind: string;
  url?: string;
  /** The source's own title, when the task's title says something else (the hub's `Title:` line right under **Source**). */
  title?: string;
  when?: string;
  from?: string;
  where?: string;
  /** A Slack message's own text, or a mail's snippet: what they said, quoted. */
  quote?: string;
  facts: readonly Fact[];
}>;

export type ThreadPost =
  | Readonly<{ kind: "question"; question: string; options: readonly string[]; by: string }>
  | Readonly<{ kind: "update"; title: string; url?: string; changes: readonly Readonly<{ field: string; from: string; to: string }>[]; triggered: readonly Triggered[]; forAgents: boolean; more?: true; reopened?: true }>
  | Readonly<{ kind: "done"; reason: string }>
  | Readonly<{ kind: "nudge"; text: string }>
  | Readonly<{ kind: "answered"; who: string; answer: string; question?: string; forAgents: boolean }>
  | Readonly<{ kind: "status"; text: string }>
  | Readonly<{ kind: "assigned"; text: string; forAgents: boolean }>
  | Readonly<{ kind: "asked"; text: string; forAgents: true }>;

const TASK_LINE = /^📌 \*\*Task (\d+): (.+)\*\*\s*$/u;
const REPLY_HERE = "Reply in this thread to work on it.";
// The reply line of posts that put the source last, right before it (hub.ts TASK_REPLY): everything between the
// **Source** line and it is the source, and what the default actions found and the checklist come before it.
const SOURCE_LAST_REPLY = "Reply in this thread to work on it. Agents update it with the signals_task tools.";
const NPUB = /nostr:npub1[02-9ac-hj-np-z]{58}/g;
/** A person named in a text: a nostr: mention, or the hub's agent:/person: actor. */
const NAMED = /(?:nostr|agent|person):(npub1[02-9ac-hj-np-z]{58})/g;
const OPTIONS = /^Options: (.+)$/;
const CHANGE = /^- \*\*(.+?):\*\* (.*) → (.*)$/;
const TRIGGERED = /^\*\*Triggered:\*\* (.+)$/;
// The hub's two outcomes (hub.ts), matched from the end, so a workstream named "dismissed cases" can't change which.
const UNTRIGGERED = /^No default action for .+ is triggered, so it's (?:(dismissed)\. It opens again if one is|(tracked) with no agent asked)\.$/;

/**
 * The `**Triggered:** <action> — <why>` lines among a post's lines (model.ts
 * triggeredLines). An action's label can't contain "—", so the first " — "
 * ends it; the reason may have anything.
 */
const triggeredIn = (lines: readonly string[]): Triggered[] =>
  lines.flatMap((line) => {
    const found = TRIGGERED.exec(line.trim());
    if (!found) return [];
    const at = found[1]!.indexOf(" — ");
    return [at < 0 ? { label: found[1]!.trim() } : { label: found[1]!.slice(0, at).trim(), why: found[1]!.slice(at + 3).trim() }];
  });

/**
 * What a task card says about a post's "No default action … is triggered"
 * note. `dismissed`: the hub says now that its workstream's defaults
 * dismissed it (triggers.dismissed), so the card says so. `opening`:
 * anything else (tracked, open again, closed by a person, or not known):
 * the post is a snapshot, so the card says it as how the task opened.
 * Undefined: nothing to say.
 */
export type UntriggeredNote = "dismissed" | "opening";
export function untriggeredNote(post: Pick<TaskPost, "triggered" | "untriggered">, now?: Readonly<{ status: string; byDefaults: boolean }>): UntriggeredNote | undefined {
  if (!post.untriggered || post.triggered.length) return undefined;
  return now?.status === "dismissed" && now.byDefaults ? "dismissed" : "opening";
}

// A meeting follow-up's checklist (store.ts), which a task post has after its source: one or both of these headings,
// each with its "- " items.
const CHECKLIST_HEADS = ["**Action items from the notes for this follow-up** (not the account team's own tasks):", "The account team's items have their own tasks:"];
const isChecklist = (block: readonly string[]) => CHECKLIST_HEADS.includes(block[0]!) && block.length > 1 && block.every((line) => CHECKLIST_HEADS.includes(line) || line.startsWith("- "));

/**
 * Where an older task post's source ends, before `end`. Those posts put the task's checklist and then what its default
 * actions found (Triggered lines, or the no-action sentence) after the source, each as its own paragraph, and the
 * source's Details run to its end. A quote can have paragraphs of its own, so those parts are taken off the end, each
 * at most once and only in that order, rather than cutting at the first blank line. A source whose own text ends just
 * like one of them reads the same, so it loses that paragraph: posts now put the source last instead.
 */
function sourceEnd(lines: readonly string[], start: number, end: number): number {
  let at = end;
  const blank = () => {
    while (at > start + 1 && !lines[at - 1]!.trim()) at--;
  };
  // The last paragraph, from its first line to `at`.
  const paragraph = () => {
    let from = at;
    while (from > start + 1 && lines[from - 1]!.trim()) from--;
    return from;
  };
  blank();
  let from = paragraph();
  const block = lines.slice(from, at).map((line) => line.trim());
  if (block.length && (block.every((line) => TRIGGERED.test(line)) || (block.length === 1 && UNTRIGGERED.test(block[0]!)))) (at = from), blank(), (from = paragraph());
  if (from < at && isChecklist(lines.slice(from, at).map((line) => line.trim()))) (at = from), blank();
  return at;
}

/** Whether a message is a task the hub posted: its first line and the line every task post has. */
export const isTaskPost = (content: string) => TASK_LINE.test(content.split("\n", 1)[0] ?? "") && content.includes(REPLY_HERE);

const splitOptions = (text: string) => text.split(" / ").map((item) => item.trim()).filter(Boolean);

/** A task post's parts, or undefined when it isn't one. */
export function parseTaskPost(content: string): TaskPost | undefined {
  if (!isTaskPost(content)) return undefined;
  const lines = content.split("\n");
  const head = TASK_LINE.exec(lines[0]!)!;
  const meta: Record<string, string> = {};
  let mode: string | undefined;
  let question: string | undefined;
  let options: string[] = [];
  let at = 1;
  for (; at < lines.length; at++) {
    const line = lines[at]!;
    if (!line.trim() || line.startsWith("**Source**") || line.startsWith(REPLY_HERE)) break;
    const asked = /^⏸️ \*\*Needs input:\*\* (.+)$/u.exec(line);
    if (asked) {
      question = asked[1]!.trim();
      const listed = OPTIONS.exec(lines[at + 1] ?? "");
      if (listed) (options = splitOptions(listed[1]!)), at++;
      continue;
    }
    const moded = /^Mode: (\w+)/.exec(line);
    if (moded) {
      mode = moded[1];
      continue;
    }
    for (const part of line.split(" · ")) {
      const pair = /^(Account|Workstream|Initiative|Rule): (.+)$/.exec(part.trim());
      if (pair) meta[pair[1]!.toLowerCase()] = pair[2]!.trim();
    }
  }
  const start = lines.findIndex((line) => line.startsWith("**Source**"));
  // The reply line: the whole line, in posts with the source last (the hub keeps the source from having it), else the
  // first that starts like one.
  const last = lines.findIndex((line) => line.trim() === SOURCE_LAST_REPLY);
  const end = last >= 0 ? last : lines.findIndex((line) => line.startsWith(REPLY_HERE));
  const title = head[2]!.trim();
  const sourceLast = last >= 0;
  const until = end > start ? end : lines.length;
  // Older posts have the source first: where it ends is a guess from the end (sourceEnd).
  const read = start >= 0 ? parseSource(lines.slice(start, sourceLast ? until : sourceEnd(lines, start, until))) : undefined;
  // A fact the title already says (a meeting's summary, say) isn't repeated under it.
  const source = read && { ...read, facts: read.facts.filter((fact) => !title.toLowerCase().includes(fact.value.toLowerCase())) };
  const after = end >= 0 ? lines.slice(end + 1).join("\n") : "";
  // What the default actions found: before the source, or in older posts after it, before "Reply in this thread".
  const middle = lines.slice(at, sourceLast && start >= at ? start : end >= 0 ? end : undefined);
  const outcome = middle.map((line) => UNTRIGGERED.exec(line.trim())).find(Boolean);
  const untriggered = outcome ? (outcome[1] ? "dismissed" : "tracked") : undefined;
  return {
    id: Number(head[1]),
    title,
    ...(meta.account && { account: meta.account }),
    ...(meta.workstream && { workstream: meta.workstream }),
    ...(meta.initiative && { initiative: meta.initiative }),
    ...(meta.rule && { rule: meta.rule }),
    ...(mode && { mode }),
    ...(question && { question }),
    options,
    ...(source && { source }),
    asksAgents: /nostr:npub1/.test(after),
    triggered: triggeredIn(middle),
    ...(untriggered && { untriggered }),
  };
}

/** Details' keys that say nothing to a person, or that the card shows another way. */
const QUIET = new Set(["channel_id", "context_before", "mimetype", "owners", "text", "from", "thread_ts", "ts", "message_ts", "status", "attendeecount", "recurringeventid", "id", "url", "link", "permalink", "user", "user_id"]);

/** "Hema Ramrakhyani <hema@x.com>" as "Hema Ramrakhyani"; an address alone as itself. */
export const personName = (text: string) => /^\s*"?([^"<]+?)"?\s*<[^>]+>/.exec(text)?.[1]?.trim() ?? text.trim();

/** "inc_status" as "Inc status". */
const label = (key: string) => {
  const words = key.replace(/([a-z])([A-Z])/g, "$1 $2").replace(/[_.-]+/g, " ").trim().toLowerCase();
  return words ? words[0]!.toUpperCase() + words.slice(1) : key;
};

/** Details' "key: value; key: value", split only where a new key starts. */
export function detailPairs(text: string): [string, string][] {
  return text
    .split(/;\s+(?=[A-Za-z_][\w.]*: )/)
    .map((part) => /^([A-Za-z_][\w.]*): ([\s\S]*)$/.exec(part.trim()))
    .filter((found): found is RegExpExecArray => Boolean(found))
    .map((found) => [found[1]!, found[2]!.trim()]);
}

function parseSource(lines: readonly string[]): TaskSource | undefined {
  const first = /^\*\*Source\*\* \(([^)]+)\)(?::\s*(\S+))?/.exec(lines[0] ?? "");
  if (!first) return undefined;
  const field = (name: string) => lines.find((line) => line.startsWith(`${name}: `))?.slice(name.length + 2).trim();
  const facts: Fact[] = [];
  // Attendees: a count, and how many are the customer's (not a colleague's address at their domain).
  const attendeesAt = lines.findIndex((line) => /^Attendees \(\d+\):/.test(line));
  if (attendeesAt >= 0) {
    const count = Number(/^Attendees \((\d+)\)/.exec(lines[attendeesAt]!)![1]);
    let customers = 0;
    let customerWord: string | undefined;
    for (const line of lines.slice(attendeesAt + 1)) {
      if (!line.startsWith("- ")) break;
      const notes = /\(([^()]*)\)\s*$/.exec(line)?.[1] ?? "";
      const first = notes.split(",")[0]!.trim();
      // The first note names the customer's people ("customer", or a deployment's own word); a twin's note says "-domain address".
      if (first && !/-domain address|organizer|accepted|declined|tentative/.test(first)) (customers++, (customerWord ??= first));
    }
    facts.push({ label: "Attendees", value: `${count}${customers ? ` · ${customers} ${customerWord}` : ""}` });
  }
  const detailsAt = lines.findIndex((line) => line.startsWith("Details: "));
  const details = detailsAt >= 0 ? detailPairs(lines.slice(detailsAt).join("\n").slice("Details: ".length)) : [];
  const detail = (key: string) => details.find(([name]) => name === key)?.[1];
  const quote = detail("text") ?? detail("snippet");
  const fromDetail = detail("from");
  const fromLine = field("From");
  const from = fromDetail && /</.test(fromDetail) ? personName(fromDetail) : fromLine && personName(fromLine);
  const channel = detail("channel");
  const whereLine = field("Where");
  for (const [key, value] of details) {
    if (facts.length >= 4) break;
    if (QUIET.has(key.toLowerCase()) || key === "channel" || key === "snippet") continue;
    // Raw JSON, long text and empty values belong in the full post.
    if (!value || /^[[{]/.test(value) || value.length > 48 || /\n/.test(value) || value === "false" || value === "null") continue;
    facts.push({ label: label(key), value });
  }
  const when = field("When");
  const title = lines[1]?.startsWith("Title: ") ? lines[1].slice(7).trim() : undefined;
  return {
    kind: first[1]!,
    ...(first[2] && { url: first[2] }),
    ...(title && { title }),
    ...(when && { when }),
    ...(from && { from }),
    ...((channel || whereLine) && { where: channel ?? whereLine! }),
    ...(quote && { quote: quote.length > 400 ? `${quote.slice(0, 399).trimEnd()}…` : quote }),
    facts,
  };
}

/** A source's name as people say it. */
export function sourceName(kind: string): string {
  const known: Record<string, string> = { slack: "Slack", gmail: "Gmail", google_calendar: "Calendar", google_drive: "Drive", jira: "Jira", atlassian: "Jira", agent: "Agent" };
  if (known[kind]) return known[kind]!;
  if (kind.startsWith("table.")) return label(kind.slice(6));
  return label(kind);
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/**
 * A source's When, short: an ISO time in the viewer's own time, or a
 * calendar time in its own zone (`2026-11-26 15:00 America/Los_Angeles
 * (GMT-8) → …` as `Nov 26, 15:00 GMT-8`). Anything else as it came.
 */
export function shortWhen(when: string, now = new Date()): string {
  const zoned = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}:\d{2}) \S+ \(([^)]+)\)/.exec(when);
  if (zoned) return `${MONTHS[Number(zoned[2]) - 1]} ${Number(zoned[3])}, ${zoned[4]} ${zoned[5]}`;
  const allDay = /^(\d{4})-(\d{2})-(\d{2}) \(all day\)/.exec(when);
  if (allDay) return `${MONTHS[Number(allDay[2]) - 1]} ${Number(allDay[3])} (all day)`;
  const at = /^\d{4}-\d{2}-\d{2}T/.test(when) ? new Date(when) : undefined;
  if (!at || Number.isNaN(at.getTime())) return when.split(" → ")[0]!;
  const time = at.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  const sameDay = at.toDateString() === now.toDateString();
  return sameDay ? `Today, ${time}` : `${MONTHS[at.getMonth()]} ${at.getDate()}, ${time}`;
}

/** The human part of a reply that ends with a request to agents: up to the line that mentions them. */
function humanPart(content: string): { text: string; forAgents: boolean } {
  const lines = content.split("\n");
  const at = lines.findIndex((line, n) => n > 0 && /^nostr:npub1/.test(line.trim()));
  const text = (at > 0 ? lines.slice(0, at) : lines).join("\n").trim();
  return { text, forAgents: at > 0 || /\*\*For agents:/.test(content) };
}

/** A reply the hub posts in a task's thread, or undefined for one it doesn't know. */
export function parseThreadPost(content: string): ThreadPost | undefined {
  const lines = content.split("\n");
  const first = lines[0] ?? "";
  const asked = /^⏸️ \*\*Needs input\*\* \(asked by (.+?)\): (.+)$/u.exec(first);
  if (asked) {
    const listed = OPTIONS.exec(lines[1] ?? "");
    return { kind: "question", by: asked[1]!.trim(), question: asked[2]!.trim(), options: listed ? splitOptions(listed[1]!) : [] };
  }
  const done = /^✅ Done: (.+?)\.?(?: \(Set its status on the Tasks board if it isn't\.\))?$/u.exec(first);
  if (done) return { kind: "done", reason: done[1]!.trim() };
  if (first.startsWith("⏰ ")) return { kind: "nudge", text: first.slice(2).trim() };
  // An update, or (when actions it triggered opened the task again) its "↩️ Open again" with them.
  const update = /^Update: (.+)$/.exec(first) ?? (TRIGGERED.test((lines[2] ?? "").trim()) ? /^↩️ Open again: (.+)$/u.exec(first) : null);
  if (update) {
    const link = /^\[(.+)\]\((\S+)\)$/.exec(update[1]!.trim());
    const changes = lines.slice(1).map((line) => CHANGE.exec(line)).filter((found): found is RegExpExecArray => Boolean(found)).map((found) => ({ field: found[1]!, from: found[2]!, to: found[3]! }));
    const human = humanPart(content);
    const shown = human.text.split("\n");
    // Anything people read that the line doesn't show (a meeting's checklist, say): the card offers the message.
    const more = shown.slice(1).some((line) => line.trim() && !TRIGGERED.test(line.trim()) && !CHANGE.test(line));
    return { kind: "update", title: link ? link[1]! : update[1]!.trim(), ...(link && { url: link[2]! }), changes, triggered: triggeredIn(shown), forAgents: human.forAgents, ...(more && { more: true as const }), ...(!first.startsWith("Update:") && { reopened: true as const }) };
  }
  // "nostr:npub… Brandon answered: X\n\n> the question\n\nPlease go on…"
  const answered = /^(?:nostr:npub1\S+\s+)*(.+?) answered: (.+)$/.exec(first);
  if (answered) {
    const quoted = lines.find((line) => line.startsWith("> "))?.slice(2).trim();
    return { kind: "answered", who: answered[1]!.trim(), answer: answered[2]!.trim(), ...(quoted && { question: quoted }), forAgents: /^nostr:npub1/.test(first) };
  }
  const status = /^(.+?) set this to \*\*(\w[\w ]*)\*\*/.exec(first);
  if (status && lines.length === 1) return { kind: "status", text: first };
  if (first.startsWith("👤 ")) {
    const part = humanPart(content);
    return { kind: "assigned", text: part.text.slice(2).trim(), forAgents: part.forAgents };
  }
  // A request to agents (asked by someone, handed off after agents changed): who and why, the rest for them.
  const ask = /^((?:nostr:npub1\S+\s*)+)(.+?)(?::| asked you to work on this task)/.exec(first);
  if (ask && /work on this task|no agent has worked on this task|you've been named|you've been added/.test(first)) {
    const asker = /^(?:nostr:npub1\S+\s*)+(.+?) asked you to work on this task/.exec(first)?.[1];
    return { kind: "asked", text: asker ? `${asker} asked agents to work on it` : "Agents were asked to work on it", forAgents: true };
  }
  return undefined;
}

/**
 * A Markdown text as one plain line, for a short preview: links and images as
 * their text (a link cut off mid-URL too), no formatting marks, and nostr:npub…
 * mentions as @Name, or a short npub when no name is known. The hub's activity
 * names people as agent:npub… and person:npub…; those read as @Name too.
 */
export function plainLine(text: string, name: (npub: string) => string | undefined = () => undefined): string {
  return text
    .split("\n")
    .filter((line) => !/^\s*(?:```|~~~)/.test(line))
    .map((line) => line.replace(/^\s{0,3}(?:#{1,6}\s+|>\s?|[-*+]\s+(?:\[[ xX]\]\s+)?|\d+[.)]\s+)/, ""))
    .join(" ")
    .replace(/!?\[([^\]\n]*)\]\([^)\s]*(?:\s+"[^"]*")?\)?/g, "$1")
    .replace(/<((?:https?|mailto):[^>\s]+)>/g, "$1")
    .replace(NAMED, (_found, npub: string) => `@${name(npub) ?? `${npub.slice(0, 12)}…`}`)
    .replace(/`([^`]+)`/g, "$1")
    .replace(/(\*\*|__|~~)(?=\S)(.+?)(?<=\S)\1/g, "$2")
    .replace(/(^|[^\w*])\*(?=\S)([^*]+?)(?<=\S)\*(?!\w)/g, "$1$2")
    .replace(/\*\*/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/** The agents a post mentions, as npubs, once each. */
export const mentionedNpubs = (content: string) => [...new Set((content.match(NPUB) ?? []).map((found) => found.slice(6)))];

/** The task panel's target: a channel's task, by id. */
export const taskTarget = (channel: string, id: number) => `signals-task:${channel}:${id}`;
export function readTaskTarget(target: string): { channel: string; id: number } | undefined {
  const found = /^signals-task:([^:\s]+):(\d+)$/.exec(target);
  return found ? { channel: found[1]!, id: Number(found[2]) } : undefined;
}

