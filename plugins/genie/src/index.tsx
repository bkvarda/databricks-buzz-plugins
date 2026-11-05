// Databricks Genie: ask Genie agents (formerly Genie spaces) and Genie One
// about your data — on a page, from the composer, from Genie links, and as
// tools every Buzz agent can use.
import type { Context } from "@buzz/author";
import { parseGenieUrl } from "@dbx/core/api/genie";
import { bindReact, React } from "@dbx/core/react";
import { attach, MissingCore, useLive } from "@dbx/core/suite";
import { DATABRICKS_ICON_MONO } from "@dbx/core/ui/theme";
import { GenieChats } from "./chats";
import { composerTool, genieLinkChip, geniePanel } from "./conversation";
import { GenieOne } from "./genie-one";
import { geniePage, genieSidebar, SpacesStore } from "./page";
import { genieTools } from "./tools";

export const inject = ["react", "pages", "conversation", "panels"];

export function apply(ctx: Context) {
  bindReact(ctx.react);
  const live = attach(ctx, { id: "bkvarda.databricks-genie", name: "Databricks Genie" }, (scope, databricks) => {
    const store = new SpacesStore(databricks);
    const genieOne = new GenieOne(databricks);
    // Chats outlive the page: a question keeps running while you're elsewhere.
    const chats = new GenieChats(databricks, genieOne);
    scope.effect(() => () => chats.dispose());
    scope.conversation.registerTool({ id: "ask-genie", title: "Ask Genie", order: 20, component: composerTool(databricks, store, genieOne) });
    scope.conversation.registerLink({
      id: "genie-link",
      title: "Genie links",
      matches: (url) => parseGenieUrl(url) !== undefined,
      order: -10,
      component: genieLinkChip(databricks, store),
    });
    scope.panels.register({
      id: "genie",
      title: "Genie",
      matches: (url) => parseGenieUrl(url) !== undefined,
      order: -10,
      keepOpen: true,
      component: geniePanel(databricks, store, chats),
    });
    scope.inject(["agents"], (agents: Context) => {
      for (const tool of genieTools(databricks, store, genieOne)) agents.agents.addTool(tool);
    });
    return {
      page: geniePage(databricks, store, genieOne, chats),
      sidebar: genieSidebar(databricks, store, genieOne),
    };
  });

  ctx.pages.register({
    id: "genie",
    title: "Genie",
    primary: true,
    icon: DATABRICKS_ICON_MONO,
    component: (props) => {
      const runtime = useLive(live);
      return runtime ? <runtime.page {...props} /> : <MissingCore ctx={ctx} feature="Databricks Genie" />;
    },
    sidebar: (props) => {
      const runtime = useLive(live);
      return runtime ? <runtime.sidebar {...props} /> : <div className="shell-sidebar-default">{props.children}</div>;
    },
  });
}
