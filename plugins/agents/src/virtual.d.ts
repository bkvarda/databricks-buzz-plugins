/** The hosted agent's runner, bundled for Node by scripts/build.mjs. */
declare module "virtual:agent-runner" {
  export const RUNNER: string;
  export const RUNNER_SHA: string;
}

/** The Buzz App library (buzz-app.mjs) and the starter app, by scripts/build.mjs. */
declare module "virtual:buzz-app" {
  export const SDK: string;
  export const STARTER: string;
  /** The search index template, bundled with its Postgres driver. */
  export const INDEXER: string;
  export const APP_SHA: string;
}
