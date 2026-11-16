// A starter Buzz app on Databricks Apps, from the Databricks Agents plugin.
//
// It answers when someone mentions it in Buzz, and says who it runs as: this
// app's own Databricks service principal. Everything it does in Databricks
// runs as that principal, so it can reach only what the principal is granted.
//
// Change what it does below, then redeploy the app (from its Settings tab in
// Buzz, or Deploy in Databricks). buzz-app.mjs handles Buzz itself; see the
// comments at its top.
import { BuzzApp } from "./buzz-app.mjs";

const app = new BuzzApp();

app.onMention(async (mention, reply) => {
  const stopTyping = reply.typing();
  const me = await app.databricks.whoami().catch(() => undefined);
  stopTyping();
  const lines = [
    `Hi! I'm a Databricks App${app.appName ? ` (**${app.appName}**)` : ""}.`,
    me
      ? `I run in ${app.databricks.host.replace(/^https:\/\//, "")} as the service principal **${me.displayName || me.applicationId}** (\`${me.applicationId}\`), so I can reach only what it's granted.`
      : "I run as this app's own Databricks service principal, so I can reach only what it's granted.",
  ];
  if (mention.text) lines.push(`You said: “${mention.text}”`);
  if (process.env.BUZZ_APP_SOURCE) lines.push(`To change what I do, edit \`app.mjs\` in \`${process.env.BUZZ_APP_SOURCE}\` and redeploy me.`);
  await reply.say(lines.join("\n\n"));
});

app.start();
