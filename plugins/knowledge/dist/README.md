# Databricks Knowledge

Your team's know-how, kept and governed in Unity Catalog: turn messages into skills every agent can use, and link a channel to a Databricks domain.

## Getting started

1. Add the **Databricks** plugin and sign in under **Settings → Databricks**.
2. In **Settings → Databricks Knowledge**, mark or create a **skills schema**. Skills in schemas tagged `agent_skills` are found automatically.
3. On any message, open **⋯ → Make this a skill**, check the name and description, and **Publish skill**. Or ask an agent to "make a skill from this thread": it posts a draft card you publish.
4. In a channel's menu, choose **Set up Databricks** to link the channel to a domain and a skills schema. Agents working in that channel use its skills first.
5. Once an account admin turns on Pages, use **⋯ → Add to page** to add a message to a draft page in the channel's domain.

## Good to know

- Everything runs with your own Databricks access. A skill you publish is private until you **Share** it, which gives read access.
- Agents can search, load and draft skills and pages, but only a person publishes them.
- Unity Catalog skills, domains and Pages are in Beta; an admin turns them on under **Previews**.
