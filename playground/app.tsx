// Playground: loads the built plugins into a mock Buzz context.
import * as React from "react";
import { createRoot } from "react-dom/client";

type Any = any; // biome-ignore lint: playground glue

const token = new URLSearchParams(location.search).get("token") ?? "";
const PLUGINS = [
  ["databricks", "bkvarda.databricks"],
  ["genie", "bkvarda.databricks-genie"],
  ["sql", "bkvarda.databricks-sql"],
  ["agents", "bkvarda.databricks-agents"],
  ["memory", "bkvarda.databricks-memory"],
  ["lakebase", "bkvarda.databricks-lakebase"],
] as const;

// ── host.spawn over the local bridge ──
const host: Any = {
  runCommand: async () => null,
  request: async () => {
    throw new Error("host.request is not used by these plugins");
  },
  spawn: async (id: string, options: Any = {}) => {
    let stdin = "";
    let started = false;
    let resolveExit: (code: number | null) => void = () => {};
    const exited = new Promise<number | null>((resolve) => (resolveExit = resolve));
    const controller = new AbortController();
    const start = async () => {
      started = true;
      try {
        const response = await fetch(`/spawn?token=${token}`, {
          method: "POST",
          body: JSON.stringify({ id, args: options.args ?? [], env: options.env ?? {}, stdin }),
          signal: controller.signal,
        });
        if (!response.ok || !response.body) {
          options.onStderr?.(await response.text());
          return resolveExit(127);
        }
        const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
        let buffer = "";
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          buffer += value;
          let newline = buffer.indexOf("\n");
          while (newline !== -1) {
            const event = JSON.parse(buffer.slice(0, newline));
            buffer = buffer.slice(newline + 1);
            if (event.type === "stdout") options.onStdout?.(event.data);
            else if (event.type === "stderr") options.onStderr?.(event.data);
            else if (event.type === "exit") resolveExit(event.code);
            newline = buffer.indexOf("\n");
          }
        }
      } catch {
        resolveExit(null);
      }
    };
    return {
      write: async (data: string) => void (stdin += data),
      end: async (data = "") => {
        stdin += data;
        if (!started) void start();
      },
      kill: async () => {
        controller.abort();
        resolveExit(null);
      },
      exited,
    };
  },
};

// ── a tiny Cordis-like registry ──
const services = new Map<string, unknown>();
const serviceListeners = new Set<() => void>();
const registry = {
  pages: [] as Any[],
  cards: [] as Any[],
  links: [] as Any[],
  codeBlocks: [] as Any[],
  tools: [] as Any[],
  panels: [] as Any[],
  agentTools: [] as Any[],
  agentTypes: [] as Any[],
  sources: [] as Any[],
};
const registryListeners = new Set<() => void>();
const bump = () => registryListeners.forEach((listener) => listener());
let navigate: (target: Any) => void = () => {};
const storage = {
  keys: () => Object.keys(localStorage).filter((key) => key.startsWith("agentstore:")).map((key) => key.slice(11)),
  get: (key: string) => localStorage.getItem(`agentstore:${key}`),
  set: async (key: string, value: string | null) => (value === null ? localStorage.removeItem(`agentstore:${key}`) : localStorage.setItem(`agentstore:${key}`, value)),
  add: async (key: string, value: string) => localStorage.getItem(`agentstore:${key}`) ?? (localStorage.setItem(`agentstore:${key}`, value), value),
};
export const posted: { at: number; text: string; via: string }[] = [];
const postedListeners = new Set<() => void>();

function mcpFor(extra: Any[] = []) {
  return async (message: Any) => {
    const tools = [
      { name: "send", description: "Posts a message in the conversation. Pass final: true when it is your last message for this turn.", inputSchema: { type: "object", properties: { text: { type: "string" }, final: { type: "boolean" } }, required: ["text"] } },
      ...registry.agentTools.map((tool) => ({ name: tool.name, description: tool.description, inputSchema: tool.inputSchema })),
      ...extra,
    ];
    if (message.method === "tools/list") return { jsonrpc: "2.0", id: message.id, result: { tools } };
    if (message.method === "tools/call") {
      const { name, arguments: args } = message.params;
      try {
        if (name === "send") {
          posted.push({ at: Date.now(), text: String(args.text ?? ""), via: "send tool" });
          postedListeners.forEach((listener) => listener());
          return { jsonrpc: "2.0", id: message.id, result: { content: [{ type: "text", text: "Sent." }] } };
        }
        const tool = registry.agentTools.find((candidate) => candidate.name === name);
        const text = await tool.call({}, {}, args ?? {});
        return { jsonrpc: "2.0", id: message.id, result: { content: [{ type: "text", text: typeof text === "string" ? text : JSON.stringify(text) }] } };
      } catch (error: Any) {
        return { jsonrpc: "2.0", id: message.id, result: { content: [{ type: "text", text: String(error?.message ?? error) }], isError: true } };
      }
    }
    return { jsonrpc: "2.0", id: message.id, result: {} };
  };
}

const kit: Any = {
  conversation: async () => ({ key: "playground/root", channel: "playground", root: "root", topLevel: false, where: "#playground" }),
  systemPrompt: async (_delivery: Any, options: Any) =>
    `You are an agent in Buzz, a chat app, in the channel #playground. Read the event and act. Reply by calling the send tool (final: true for your last message). Be concise.\n\n${options.instructions ?? ""}`,
  turnPrompt: async (delivery: Any) => ({ text: `<buzz-event from="owner">${delivery.trigger.event.content}</buzz-event>`, cursor: String(Date.now()), restore() {} }),
  standalonePrompt: (_agent: Any, text: string) => text,
  tools: () => mcpFor(),
  reply: async (_agent: Any, _conversation: Any, text: string) => {
    posted.push({ at: Date.now(), text, via: "reply" });
    postedListeners.forEach((listener) => listener());
  },
};

function makeCtx(pluginId: string): Any {
  const effects: (() => void)[] = [];
  const ctx: Any = {
    react: React,
    host,
    pluginOwner: { id: pluginId },
    pages: { register: (page: Any) => (registry.pages.push({ ...page, pluginId }), bump()) },
    settingsCards: { register: (card: Any) => (registry.cards.push({ ...card, pluginId }), bump()) },
    panels: { register: (panel: Any) => (registry.panels.push({ ...panel, pluginId }), bump()) },
    conversation: {
      registerLink: (link: Any) => (registry.links.push({ ...link, pluginId }), bump()),
      registerCodeBlock: (block: Any) => (registry.codeBlocks.push({ ...block, pluginId }), bump()),
      registerTool: (tool: Any) => (registry.tools.push({ ...tool, pluginId }), bump()),
      registerMessage: () => {},
      registerMessageAction: () => {},
      registerAccessory: () => {},
      registerCompletion: () => {},
      registerInline: () => {},
      registerAttachment: () => {},
    },
    agents: {
      addTool: (tool: Any) => (registry.agentTools.push({ ...tool, pluginId }), bump()),
      tools: () => registry.agentTools,
      register: (type: Any) => (registry.agentTypes.push({ ...type, pluginId }), bump()),
      addAttentionSource: (source: Any) => (registry.sources.push({ ...source, pluginId }), bump()),
      registerTab: () => {},
      harness: new URLSearchParams(location.search).has("nokit") ? undefined : kit,
      storage,
    },
    navigation: { open: async (target: Any) => (navigate(target), { status: "opened" }) },
    provide(name: string, value: unknown) {
      services.set(name, value);
      serviceListeners.forEach((listener) => listener());
      return () => services.delete(name);
    },
    inject(deps: string[], callback: (scope: Any) => void) {
      let done = false;
      const tryRun = () => {
        if (done || !deps.every((dep) => dep in ctx || services.has(dep))) return;
        done = true;
        const scope = Object.create(ctx);
        for (const dep of deps) if (!(dep in ctx)) Object.defineProperty(scope, dep, { get: () => services.get(dep) });
        callback(scope);
      };
      tryRun();
      if (!done) serviceListeners.add(tryRun);
    },
    effect(fn: () => (() => void) | undefined) {
      const cleanup = fn();
      if (cleanup) effects.push(cleanup);
    },
    reflect: {
      get: (name: string) =>
        name === "navigation"
          ? ctx.navigation
          : name === "pluginInstaller"
            ? { requestInstall: async (source: Any) => (alert(`requestInstall ${JSON.stringify(source)}`), "cancelled") }
            : services.get(name),
    },
  };
  return ctx;
}

function useRegistry() {
  return React.useSyncExternalStore(
    (listener) => (registryListeners.add(listener), () => registryListeners.delete(listener)),
    () => registry.pages.length + registry.cards.length * 100 + registry.agentTools.length * 10000 + registry.agentTypes.length * 1e6,
  );
}

const CONVERSATION_SAMPLE = `Here's the query for weekly orders:

\`\`\`sql
SELECT date_trunc('week', o_orderdate) AS week, count(*) AS orders, round(sum(o_totalprice), 2) AS revenue
FROM samples.tpch.orders
WHERE o_orderdate >= '1998-01-01'
GROUP BY 1 ORDER BY 1
\`\`\``;

function Shell() {
  useRegistry();
  const [view, setView] = React.useState<string>("settings:0");
  const [dark, setDark] = React.useState(false);
  React.useEffect(() => {
    document.documentElement.classList.toggle("dark", dark);
  }, [dark]);
  navigate = (target) => {
    if (target?.kind === "settings") setView(`settings:${Math.max(0, registry.cards.findIndex((card) => `${card.pluginId}/${card.id}` === target.section))}`);
  };
  const [kind, index] = view.split(":") as [string, string];
  const item = (label: string, key: string) => (
    <button key={key} type="button" onClick={() => setView(key)} style={{ display: "block", width: "100%", textAlign: "left", border: 0, padding: "6px 10px", borderRadius: 6, background: view === key ? "var(--affordance-selected)" : "transparent", color: "var(--text-standard)", font: "inherit", cursor: "pointer" }}>
      {label}
    </button>
  );
  let main: React.ReactNode = null;
  let sidebar: React.ReactNode = null;
  if (kind === "settings") {
    const card = registry.cards[Number(index)];
    if (card) main = <div style={{ maxWidth: "48rem", margin: "0 auto", padding: 32 }}><card.component active={() => true} /></div>;
  } else if (kind === "page") {
    const page = registry.pages[Number(index)];
    if (page) {
      main = <page.component />;
      sidebar = page.sidebar ? <page.sidebar target={{ version: 1, kind: "page" }} /> : null;
    }
  } else if (kind === "conversation") main = <ConversationDemo />;
  else if (kind === "tools") main = <ToolsDemo />;
  else if (kind === "agents") main = <AgentsDemo />;
  else if (kind === "panel") main = <PanelDemo />;
  return (
    <div style={{ display: "grid", gridTemplateColumns: sidebar ? "200px 260px 1fr" : "200px 1fr", height: "100vh", background: "var(--surface-base)" }}>
      <nav style={{ padding: 10, borderRight: "1px solid var(--border-standard)", overflow: "auto", fontSize: 13 }}>
        <div style={{ fontWeight: 600, padding: "6px 10px" }}>Buzz playground</div>
        <label style={{ display: "block", padding: "4px 10px 10px", fontSize: 12 }}>
          <input type="checkbox" checked={dark} onChange={(event) => setDark(event.target.checked)} /> Dark mode
        </label>
        <div style={{ color: "var(--text-subtle)", padding: "8px 10px 2px", fontSize: 11 }}>SETTINGS</div>
        {registry.cards.map((card, n) => item(card.title, `settings:${n}`))}
        <div style={{ color: "var(--text-subtle)", padding: "8px 10px 2px", fontSize: 11 }}>PAGES</div>
        {registry.pages.map((page, n) => item(page.title, `page:${n}`))}
        <div style={{ color: "var(--text-subtle)", padding: "8px 10px 2px", fontSize: 11 }}>CONTRIBUTIONS</div>
        {item("Conversation", "conversation:0")}
        {item("Panels", "panel:0")}
        {item(`Agent tools (${registry.agentTools.length})`, "tools:0")}
        {item(`Agent types (${registry.agentTypes.length})`, "agents:0")}
      </nav>
      {sidebar && <aside style={{ borderRight: "1px solid var(--border-standard)", background: "var(--surface-sidebar, var(--surface-base))", overflow: "hidden" }}>{sidebar}</aside>}
      <main style={{ overflow: "auto", background: "var(--surface-panel)", position: "relative" }}>{main}</main>
    </div>
  );
}

function renderLinks(text: string) {
  return text.split(/(https:\/\/\S+)/g).map((part, n) => {
    if (!/^https:\/\//.test(part)) return part;
    const renderer = registry.links.filter((link) => link.matches(part)).sort((a, b) => (a.order ?? 0) - (b.order ?? 0))[0];
    return (
      <a key={n} href={part} style={{ color: "var(--text-link)", textDecoration: "none", padding: "0 2px", borderRadius: 4 }}>
        {renderer ? <renderer.component url={part} /> : part}
      </a>
    );
  });
}

function ConversationDemo() {
  const [text, setText] = React.useState(CONVERSATION_SAMPLE);
  const [draft, setDraft] = React.useState("");
  const blocks = text.split(/```(\w*)\n([\s\S]*?)```/g);
  const parts: React.ReactNode[] = [];
  for (let i = 0; i < blocks.length; i += 3) {
    if (blocks[i]) parts.push(<p key={`t${i}`} style={{ whiteSpace: "pre-wrap", margin: "0 0 8px" }}>{renderLinks(blocks[i] ?? "")}</p>);
    const language = blocks[i + 1];
    const code = blocks[i + 2];
    if (code !== undefined) {
      const block = registry.codeBlocks.find((candidate) => candidate.matches(language ?? ""));
      parts.push(
        <div key={`c${i}`} style={{ border: "1px solid var(--border-standard)", borderRadius: 8, background: "var(--surface-inset)", margin: "4px 0 10px" }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "4px 8px", borderBottom: "1px solid var(--border-standard)", fontSize: 12, color: "var(--text-subtle)" }}>
            <span>{language}</span>
            <span style={{ display: "flex", gap: 6 }}>{block?.action && <block.action code={code} language={language} />}<button type="button">Copy</button></span>
          </div>
          <div style={{ padding: "8px 10px", fontSize: 12, overflow: "auto" }}>{block ? <block.component code={code} language={language} /> : <pre>{code}</pre>}</div>
        </div>,
      );
    }
  }
  return (
    <div style={{ maxWidth: 820, margin: "0 auto", padding: 24 }}>
      <div style={{ display: "flex", gap: 10, alignItems: "flex-start" }}>
        <div style={{ width: 32, height: 32, borderRadius: 8, background: "var(--surface-inset)", flex: "none" }} />
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontWeight: 600, fontSize: 13, marginBottom: 4 }}>alex <span style={{ color: "var(--text-subtle)", fontWeight: 400 }}>9:41 AM</span></div>
          <div style={{ fontSize: 14 }}>{parts}</div>
        </div>
      </div>
      <details style={{ marginTop: 20 }}>
        <summary style={{ fontSize: 12, color: "var(--text-subtle)" }}>Edit message</summary>
        <textarea value={text} onChange={(event) => setText(event.target.value)} rows={10} style={{ width: "100%", fontFamily: "var(--font-mono)" }} />
      </details>
      <div style={{ marginTop: 24, border: "1px solid var(--border-standard)", borderRadius: 12, padding: 10, background: "var(--surface-composer)" }}>
        <textarea value={draft} onChange={(event) => setDraft(event.target.value)} rows={3} placeholder="Message #playground" style={{ width: "100%", border: 0, background: "transparent", color: "inherit", font: "inherit", resize: "vertical" }} />
        <div style={{ display: "flex", gap: 6 }}>
          {registry.tools.map((tool) => (
            <tool.component key={tool.id} session={{}} scope="demo" channelId="playground" disabled={false} recipients={[]} insertText={(value: string) => (setDraft((current) => current + value), true)} insertMention={() => false} insertMentions={() => false} replaceRecipients={() => false} insertResource={() => "unsupported"} focus={() => {}} />
          ))}
        </div>
      </div>
    </div>
  );
}

function PanelDemo() {
  const [url, setUrl] = React.useState("");
  const [open, setOpen] = React.useState("");
  const panel = open ? registry.panels.filter((candidate) => candidate.matches(open)).sort((a, b) => (a.order ?? 0) - (b.order ?? 0))[0] : undefined;
  return (
    <div style={{ display: "grid", gridTemplateColumns: "1fr 440px", height: "100%" }}>
      <div style={{ padding: 24 }}>
        <p style={{ fontSize: 13 }}>Paste a Databricks URL (Genie room, job run, table) to open its panel:</p>
        <input value={url} onChange={(event) => setUrl(event.target.value)} style={{ width: "100%", padding: 6 }} />
        <button type="button" onClick={() => setOpen(url.trim())} style={{ marginTop: 8 }}>Open panel</button>
        <p style={{ fontSize: 13 }}>{renderLinks(url)}</p>
      </div>
      <div style={{ borderLeft: "1px solid var(--border-standard)", overflow: "auto" }}>{panel ? <panel.component target={open} close={() => setOpen("")} /> : null}</div>
    </div>
  );
}

function ToolsDemo() {
  const [selected, setSelected] = React.useState(0);
  const [args, setArgs] = React.useState("{}");
  const [output, setOutput] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const tool = registry.agentTools[selected];
  return (
    <div style={{ display: "grid", gridTemplateColumns: "280px 1fr", height: "100%" }}>
      <div style={{ borderRight: "1px solid var(--border-standard)", overflow: "auto", padding: 8, fontSize: 12 }}>
        {registry.agentTools.map((candidate, n) => (
          <button key={candidate.name} type="button" onClick={() => (setSelected(n), setArgs("{}"), setOutput(""))} style={{ display: "block", width: "100%", textAlign: "left", border: 0, padding: "5px 8px", borderRadius: 6, background: n === selected ? "var(--affordance-selected)" : "transparent", color: "var(--text-standard)", fontFamily: "var(--font-mono)", cursor: "pointer" }}>
            {candidate.name}
          </button>
        ))}
      </div>
      {tool && (
        <div style={{ padding: 20, display: "flex", flexDirection: "column", gap: 10 }}>
          <div style={{ fontFamily: "var(--font-mono)", fontWeight: 600 }}>{tool.name}</div>
          <div style={{ fontSize: 13, color: "var(--text-subtle)" }}>{tool.description}</div>
          <pre style={{ fontSize: 11, background: "var(--surface-inset)", padding: 8, borderRadius: 6, maxHeight: 160, overflow: "auto" }}>{JSON.stringify(tool.inputSchema, null, 1)}</pre>
          <textarea id="tool-args" value={args} onChange={(event) => setArgs(event.target.value)} rows={4} style={{ fontFamily: "var(--font-mono)" }} />
          <button
            id="tool-run"
            type="button"
            disabled={busy}
            onClick={async () => {
              setBusy(true);
              setOutput("…");
              const started = performance.now();
              try {
                const result = await tool.call({}, {}, JSON.parse(args || "{}"));
                setOutput(`(${Math.round(performance.now() - started)} ms)\n${typeof result === "string" ? result : JSON.stringify(result, null, 1)}`);
              } catch (error: Any) {
                setOutput(`ERROR (${Math.round(performance.now() - started)} ms): ${error?.message ?? error}`);
              } finally {
                setBusy(false);
              }
            }}
          >
            {busy ? "Running…" : "Call tool"}
          </button>
          <pre id="tool-output" style={{ whiteSpace: "pre-wrap", fontSize: 12, background: "var(--surface-inset)", padding: 10, borderRadius: 6 }}>{output}</pre>
        </div>
      )}
    </div>
  );
}

function AgentsDemo() {
  const [selected, setSelected] = React.useState(0);
  const type = registry.agentTypes[selected];
  const [config, setConfig] = React.useState<Any>(() => type?.defaults().config);
  const [prompt, setPrompt] = React.useState("What were the top 3 order priorities by revenue in samples.tpch.orders? Use SQL.");
  const [steps, setSteps] = React.useState<string[]>([]);
  const [state, setState] = React.useState("");
  React.useSyncExternalStore((listener) => (postedListeners.add(listener), () => postedListeners.delete(listener)), () => posted.length);
  React.useEffect(() => setConfig(type?.defaults().config), [type]);
  if (!type) return <div style={{ padding: 24 }}>No agent types registered (is the harness kit available?).</div>;
  const run = async () => {
    setSteps([]);
    setState("running");
    let work: Promise<Any> = Promise.resolve();
    const controller = new AbortController();
    await type.run({
      trigger: { type: "mention", event: { content: prompt } },
      channelId: "playground",
      agent: { key: "playground-agent", pubkey: "f".repeat(64), name: "Playground agent", owner: "0".repeat(64) },
      config,
      signal: controller.signal,
      workingUntil: (done: Promise<Any>) => (work = done),
      step: (tool: string, target?: string) => setSteps((current) => [...current, `${tool}${target ? ` · ${target}` : ""}`]),
      acknowledged: () => {},
      ignored: () => setState("ignored"),
      interruptible: () => {},
      current: () => true,
    });
    const outcome = await work;
    setState(JSON.stringify(outcome));
  };
  return (
    <div style={{ padding: 24, maxWidth: 900, display: "flex", flexDirection: "column", gap: 14 }}>
      <div style={{ display: "flex", gap: 6 }}>
        {registry.agentTypes.map((candidate, n) => (
          <button key={candidate.id} type="button" onClick={() => setSelected(n)} style={{ fontWeight: n === selected ? 600 : 400 }}>
            {candidate.title}
          </button>
        ))}
      </div>
      <div style={{ fontSize: 13, color: "var(--text-subtle)" }}>{type.description}</div>
      <div style={{ border: "1px solid var(--border-standard)", borderRadius: 12, padding: 16 }}>{type.Create && <type.Create config={config} onChange={setConfig} disabled={false} />}</div>
      <textarea id="agent-prompt" value={prompt} onChange={(event) => setPrompt(event.target.value)} rows={3} />
      <button id="agent-run" type="button" onClick={() => void run()}>Mention the agent</button>
      <div id="agent-state" style={{ fontSize: 12 }}>{state}</div>
      <ol style={{ fontSize: 12, color: "var(--text-subtle)" }}>{steps.map((step, n) => <li key={n}>{step}</li>)}</ol>
      <div id="agent-posted">
        {posted.map((message) => (
          <div key={message.at} style={{ border: "1px solid var(--border-standard)", borderRadius: 10, padding: 12, marginBottom: 8, whiteSpace: "pre-wrap", fontSize: 13 }}>
            <div style={{ fontSize: 11, color: "var(--text-subtle)" }}>posted via {message.via}</div>
            {message.text}
          </div>
        ))}
      </div>
    </div>
  );
}

async function main() {
  for (const [folder, id] of PLUGINS) {
    try {
      const module = await import(/* @vite-ignore */ `/plugins/${folder}/plugin.js`);
      module.apply(makeCtx(id));
    } catch (error) {
      console.error(`Plugin ${id} failed to activate`, error);
    }
  }
  createRoot(document.getElementById("root")!).render(<Shell />);
}
void main();
