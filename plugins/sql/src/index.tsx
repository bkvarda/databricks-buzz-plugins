// Databricks SQL: run ```sql blocks from conversations with your own access,
// a SQL page with a catalog browser, and governed SQL tools for agents.
import type { Context } from "@buzz/author";
import { bindReact, React } from "@dbx/core/react";
import { attach, MissingCore, useLive } from "@dbx/core/suite";
import { svgDataUri } from "@dbx/core/ui/theme";
import { sqlBlock, sqlBlockAction } from "./codeblock";
import { Editor, sqlPage, sqlSettings, sqlSidebar } from "./page";
import { Runs } from "./runs";
import { sqlTools } from "./tools";

export const inject = ["react", "pages", "conversation", "settingsCards"];

const ICON = svgDataUri(
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><ellipse cx="12" cy="5.5" rx="7.5" ry="3"/><path d="M4.5 5.5v6c0 1.7 3.4 3 7.5 3s7.5-1.3 7.5-3v-6"/><path d="M4.5 11.5v6c0 1.7 3.4 3 7.5 3s7.5-1.3 7.5-3v-6"/></svg>',
);

export function apply(ctx: Context) {
  bindReact(ctx.react);
  const live = attach(ctx, { id: "bkvarda.databricks-sql", name: "Databricks SQL" }, (scope, databricks) => {
    // Runs and the SQL page's statement belong to the plugin, so they're still
    // there when you come back to the page.
    const runs = new Runs(databricks);
    const editor = new Editor(databricks, runs);
    const stopWatching = runs.watchWorkspace();
    const stopSaving = editor.watch();
    scope.effect(() => () => {
      stopWatching();
      stopSaving();
    });
    scope.conversation.registerCodeBlock({
      id: "sql",
      title: "Databricks SQL",
      matches: (language) => /^(sql|databricks-sql|sparksql|spark-sql)$/i.test(language.trim()),
      component: sqlBlock(databricks, runs),
      action: sqlBlockAction(databricks, runs),
    });
    scope.settingsCards.register({ id: "sql", title: "Databricks SQL", component: sqlSettings(databricks) });
    scope.inject(["agents"], (agents: Context) => {
      for (const tool of sqlTools(databricks)) agents.agents.addTool(tool);
    });
    return { page: sqlPage(databricks, editor, runs), sidebar: sqlSidebar(databricks, editor) };
  });

  ctx.pages.register({
    id: "sql",
    title: "SQL",
    primary: true,
    icon: ICON,
    component: (props) => {
      const runtime = useLive(live);
      return runtime ? <runtime.page {...props} /> : <MissingCore ctx={ctx} feature="Databricks SQL" />;
    },
    sidebar: (props) => {
      const runtime = useLive(live);
      return runtime ? <runtime.sidebar {...props} /> : <div className="shell-sidebar-default">{props.children}</div>;
    },
  });
}
