# buzz-app.mjs

Buzz for code running as a [Databricks App](https://docs.databricks.com/aws/en/dev-tools/databricks-apps/). It's how an app answers in Buzz as its own identity, the way a Slack app has a bot user.

The identity is made in Buzz: **Agents → New agent → Databricks App** (from the Databricks Agents plugin). The plugin keeps the identity's key in a Unity Catalog secret that only your app's service principal can read, and grants that. Your app reads it with this library, so no key is ever in your code or its settings.

## Use it

1. In Buzz, create a **Databricks App** agent. Choose **Deploy a starter app for me** to get a working app in one step, or **Connect an app you have**.
2. For your own app, copy `buzz-app.mjs` into its code (it has no dependencies; Node 20 or later) and set `BUZZ_IDENTITY_SECRET` in its `app.yaml`. The agent's Settings tab shows the exact lines. The plugin also puts a copy, with an example `app.mjs`, in `/Workspace/Users/<you>/buzz-apps/<app>`.
3. Deploy the app.

```js
import { BuzzApp } from "./buzz-app.mjs";

const app = new BuzzApp();

app.onMention(async (mention, reply) => {
  const stop = reply.typing();
  // Runs as the app's service principal: it reaches only what that principal is granted.
  const me = await app.databricks.api("/api/2.0/preview/scim/v2/Me");
  stop();
  await reply.say(`Hi! I run as ${me.displayName}. You said: ${mention.text}`);
});

app.start();
```

- `mention`: `text` (without mention links), `content`, `author` (pubkey), `channel`, `thread`, `event`.
- `reply`: `say(text)` replies in the thread, `typing()` shows the app typing until you call what it returns, `history()` reads the conversation's earlier messages.
- `app.databricks`: `api(path, { method, body, query })` and `token()` as the service principal; `whoami()`.
- `new BuzzApp({ answers })`: `"everyone"` (the default), `"owner"`, or a list of pubkeys. Without it, the agent's **Answers** setting in Buzz applies.
- It serves a status page on the app's port (`/` and `/api/status`), which the agent's Settings tab in Buzz reads.

- `app.onConnect(handler)` runs once it's signed in to Buzz (what it returns runs when it signs out); `app.query(filters)` and `app.publish(template)` read and write the community as the app; `app.route(path, handler)` serves your own API on its port, with `request.user` from Databricks Apps; `app.describe(fields)` adds to its status page.

[`search-index.mjs`](search-index.mjs) is the Search index template's `app.mjs` (the library, the indexer and its Postgres driver in one file), for deploying by hand: it needs a Lakebase database resource and `LAKEBASE_ENDPOINT` (`valueFrom: postgres`) in `app.yaml`.

Built from [`plugins/agents/app/sdk.ts`](../plugins/agents/app/sdk.ts) and [`indexer.ts`](../plugins/agents/app/indexer.ts) by `npm run build`.
