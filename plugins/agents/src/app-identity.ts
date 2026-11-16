// A Buzz App identity, as the plugin keeps it in a Unity Catalog secret and
// the app's library (../app/sdk.ts) reads it: the identity's key, and once
// Buzz has made it, the community, its owner's attestation, its name and
// picture. Only the app's service principal and the person who made it can
// read the secret.

export type Answers = "everyone" | "owner";

export type AppIdentity = {
  v: 1;
  /** The identity's secret key, hex. */
  key: string;
  /** The community, as Buzz names it (`wss://…`). Set once Buzz has made the identity. */
  relay?: string;
  /** The owner's pubkey, and their NIP-OA attestation of this key. */
  owner?: string;
  auth?: string[];
  name?: string;
  picture?: string;
  /** Whose mentions it takes, unless the app's code says otherwise. */
  answers?: Answers;
  /** The app and workspace, for its profile. */
  app?: string;
  workspace?: string;
};

const HEX64 = /^[0-9a-f]{64}$/;

/** The identity in a secret's value, or undefined when it isn't one. */
export function parseIdentity(value: string | undefined): AppIdentity | undefined {
  if (!value) return undefined;
  try {
    const parsed = JSON.parse(value) as Partial<AppIdentity>;
    if (parsed.v !== 1 || typeof parsed.key !== "string" || !HEX64.test(parsed.key)) return undefined;
    return {
      v: 1,
      key: parsed.key,
      ...(typeof parsed.relay === "string" && parsed.relay && { relay: parsed.relay }),
      ...(typeof parsed.owner === "string" && HEX64.test(parsed.owner) && { owner: parsed.owner }),
      ...(Array.isArray(parsed.auth) && parsed.auth.every((part) => typeof part === "string") && { auth: parsed.auth }),
      ...(typeof parsed.name === "string" && parsed.name && { name: parsed.name }),
      ...(typeof parsed.picture === "string" && parsed.picture && { picture: parsed.picture }),
      ...((parsed.answers === "owner" || parsed.answers === "everyone") && { answers: parsed.answers }),
      ...(typeof parsed.app === "string" && parsed.app && { app: parsed.app }),
      ...(typeof parsed.workspace === "string" && parsed.workspace && { workspace: parsed.workspace }),
    };
  } catch {
    return undefined;
  }
}

/** Whether Buzz has finished making it: the app can sign in. */
export const activated = (identity: AppIdentity | undefined): identity is AppIdentity & Required<Pick<AppIdentity, "relay" | "owner" | "auth">> =>
  Boolean(identity?.relay && identity.owner && identity.auth?.length);

/** The secret's name for an app: its schema, and `buzz_<app>` with hyphens as underscores. */
export const identitySecretName = (schema: string, app: string) => `${schema}.buzz_${app.replace(/-/g, "_")}`;

/** What the app's library needs in its environment, in app.yaml form. */
export function appYaml(input: Readonly<{ secret: string; source?: string }>): string {
  return [
    'command: ["node", "app.mjs"]',
    "env:",
    "  - name: BUZZ_IDENTITY_SECRET",
    `    value: "${input.secret}"`,
    ...(input.source ? ["  - name: BUZZ_APP_SOURCE", `    value: "${input.source}"`] : []),
    "",
  ].join("\n");
}
