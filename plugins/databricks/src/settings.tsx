import type { PluginInstaller } from "@buzz/author";
import type { ReactNode } from "react";
import type { Connection } from "@dbx/core/connection";
import type { ProvidedService } from "@dbx/core/provider";
import { React } from "@dbx/core/react";
import { describeError, useAsync, useConnection, usePreference } from "@dbx/core/service";
import { Sql, type Warehouse } from "@dbx/core/api/sql";
import {
  Badge,
  Button,
  Card,
  DatabricksMark,
  DbxRoot,
  Field,
  Notice,
  openExternal,
  SectionHeader,
  Spinner,
  Stack,
  StatusDot,
  Text,
} from "@dbx/core/ui/components";

export const REPOSITORY = "https://github.com/bkvarda/databricks-buzz-plugins";

export const SUITE = [
  { id: "bkvarda.databricks-genie", folder: "genie", name: "Databricks Genie", blurb: "Ask Genie agents questions about your data, with charts. Agents can ask Genie too." },
  { id: "bkvarda.databricks-sql", folder: "sql", name: "Databricks SQL", blurb: "Run SQL from conversations and give agents governed SQL and catalog tools." },
  { id: "bkvarda.databricks-agents", folder: "agents", name: "Databricks Agents", blurb: "Agents powered by Databricks: models, Genie agents, your custom agents and Sandboxes." },
  { id: "bkvarda.databricks-memory", folder: "memory", name: "Databricks Memory", blurb: "Long-term agent memory in Databricks managed memory, shared across your agents." },
  { id: "bkvarda.databricks-lakebase", folder: "lakebase", name: "Lakebase", blurb: "Let agents read operational data from Lakebase Postgres through the Data API." },
  { id: "bkvarda.databricks-knowledge", folder: "knowledge", name: "Databricks Knowledge", blurb: "Unity Catalog skills, domains and Pages: make skills from messages and give every agent your team's skills." },
] as const;

function hostLabel(host: string) {
  return host.replace(/^https:\/\//, "");
}

export function ConnectionSettings(props: {
  connection: Connection;
  service: ProvidedService;
  installer: () => PluginInstaller | undefined;
}) {
  const { connection, service } = props;
  const snapshot = useConnection(service);
  const members = React.useSyncExternalStore(service.subscribeMembers, service.members);
  return (
    <DbxRoot>
      <Stack gap={28} style={{ paddingBottom: 32 }}>
        <Stack gap={6}>
          <Stack direction="row" gap={10} align="center">
            <DatabricksMark size={22} />
            <Text as="h2" size="xl" weight={500}>
              Databricks
            </Text>
          </Stack>
          <Text tone="subtle" as="p">
            Connect once and every Databricks plugin, and every agent using Databricks tools, works as you, with your Unity Catalog permissions.
          </Text>
        </Stack>
        <ConnectionGroup connection={connection} snapshot={snapshot} />
        {snapshot.status === "connected" && <DefaultsGroup service={service} />}
        <SuiteGroup installer={props.installer} active={new Set(members.map((member) => member.id))} />
      </Stack>
    </DbxRoot>
  );
}

function ConnectionGroup(props: { connection: Connection; snapshot: ReturnType<Connection["snapshot"]> }) {
  const { connection, snapshot } = props;
  const [error, setError] = React.useState<string>();
  const run = (action: () => Promise<void>) => {
    setError(undefined);
    action().catch((failure: unknown) => setError(describeError(failure)));
  };
  let body: ReactNode;
  switch (snapshot.status) {
    case "checking":
    case "connecting":
      body = (
        <Stack direction="row" gap={10} align="center">
          <Spinner />
          <Text tone="subtle">
            {snapshot.status === "checking" ? "Checking for a Databricks sign-in…" : `Connecting to ${hostLabel(snapshot.profile.host)}…`}
          </Text>
        </Stack>
      );
      break;
    case "unsupported":
      body = <Notice tone="warning" title="Desktop only">{snapshot.message}</Notice>;
      break;
    case "cli-missing":
      body = (
        <Stack gap={12}>
          <Notice
            tone="info"
            title="One-time setup: the Databricks CLI"
            action={
              <Button variant="brand" disabled={snapshot.installing} onClick={() => run(() => connection.installCli())}>
                {snapshot.installing ? <Spinner size={12} label="Installing" /> : null}
                {snapshot.installing ? "Installing…" : "Install Databricks CLI"}
              </Button>
            }
          >
            Sign-in uses the official Databricks CLI, so your browser single sign-on and token refresh are handled by Databricks and shared with your other
            Databricks tools. It installs to ~/.local/bin after a checksum check.
          </Notice>
          {snapshot.error && <Notice tone="danger" title="Install didn't finish">{snapshot.error}</Notice>}
          <Text tone="subtle" size="sm">
            Prefer Homebrew? Run <span className="dbx-mono">brew install databricks/tap/databricks</span>, then{" "}
            <button type="button" className="dbx-link" onClick={() => run(() => connection.start())}>
              check again
            </button>
            .
          </Text>
        </Stack>
      );
      break;
    case "signing-in":
      body = (
        <Card>
          <Stack direction="row" gap={12} align="center" justify="space-between">
            <Stack direction="row" gap={10} align="center">
              <Spinner />
              <Stack gap={2}>
                <Text weight={500}>Finish signing in in your browser</Text>
                <Text tone="subtle" size="sm">
                  {snapshot.host ? `Signing in to ${hostLabel(snapshot.host)}.` : "Sign in with your company account, then choose your workspace."}
                </Text>
              </Stack>
            </Stack>
            <Button variant="ghost" onClick={() => connection.cancelSignIn()}>
              Cancel
            </Button>
          </Stack>
        </Card>
      );
      break;
    case "signed-out":
      body = <SignedOut connection={connection} profiles={snapshot.profiles} error={snapshot.error} run={run} />;
      break;
    case "error":
      body = (
        <Stack gap={12}>
          <Notice
            tone="warning"
            title={`Can't reach ${hostLabel(snapshot.profile.host)}`}
            action={
              <Stack direction="row" gap={6}>
                {snapshot.needsSignIn ? (
                  <Button variant="brand" onClick={() => run(() => connection.reauthenticate())}>
                    Sign in again
                  </Button>
                ) : (
                  <Button onClick={() => run(() => connection.useProfile(snapshot.profile.name))}>Retry</Button>
                )}
                <Button variant="ghost" onClick={() => connection.disconnect()}>
                  Use another
                </Button>
              </Stack>
            }
          >
            {snapshot.message}
          </Notice>
        </Stack>
      );
      break;
    case "connected":
      body = <Connected connection={connection} snapshot={snapshot} run={run} />;
      break;
  }
  return (
    <Stack gap={12}>
      <SectionHeader title="Connection" />
      {body}
      {error && <Notice tone="danger" title="That didn't work">{error}</Notice>}
    </Stack>
  );
}

function SignedOut(props: {
  connection: Connection;
  profiles: readonly { name: string; host: string }[];
  error?: string | undefined;
  run(action: () => Promise<void>): void;
}) {
  const { connection, profiles, run } = props;
  const [url, setUrl] = React.useState("");
  const [profile, setProfile] = React.useState(profiles[0]?.name ?? "");
  return (
    <Stack gap={14}>
      <Card padding={18}>
        <Stack direction="row" gap={14} align="center" justify="space-between" wrap>
          <Stack gap={3} style={{ flex: "1 1 260px" }}>
            <Text weight={500}>Sign in with Databricks</Text>
            <Text tone="subtle" size="sm">
              Opens your browser for single sign-on. You'll pick your workspace there.
            </Text>
          </Stack>
          <Button variant="brand" onClick={() => run(() => connection.signIn())}>
            <DatabricksMark size={13} color="current" />
            Sign in with Databricks
          </Button>
        </Stack>
      </Card>
      {props.error && <Notice tone="danger" title="Sign-in didn't finish">{props.error}</Notice>}
      {profiles.length > 0 && (
        <Stack gap={8}>
          <Text size="sm" weight={500}>
            Or use a profile you already signed in with
          </Text>
          <Stack direction="row" gap={8} align="center">
            <select className="dbx-select" value={profile} onChange={(event) => setProfile(event.target.value)} style={{ maxWidth: 420 }} aria-label="Databricks CLI profile">
              {profiles.map((candidate) => (
                <option key={candidate.name} value={candidate.name}>
                  {candidate.name} — {hostLabel(candidate.host)}
                </option>
              ))}
            </select>
            <Button disabled={!profile} onClick={() => run(() => connection.useProfile(profile))}>
              Use profile
            </Button>
          </Stack>
        </Stack>
      )}
      <form
        onSubmit={(event) => {
          event.preventDefault();
          if (url.trim()) run(() => connection.signIn({ host: url.trim() }));
        }}
      >
        <Stack gap={8}>
          <Field label="Or sign in to a workspace URL" hint="For example https://my-company.cloud.databricks.com">
            <Stack direction="row" gap={8}>
              <input className="dbx-input" value={url} onChange={(event) => setUrl(event.target.value)} placeholder="https://…cloud.databricks.com" style={{ maxWidth: 420 }} />
              <Button type="submit" disabled={!url.trim()}>
                Sign in
              </Button>
            </Stack>
          </Field>
        </Stack>
      </form>
    </Stack>
  );
}

function Connected(props: {
  connection: Connection;
  snapshot: Extract<ReturnType<Connection["snapshot"]>, { status: "connected" }>;
  run(action: () => Promise<void>): void;
}) {
  const { connection, snapshot, run } = props;
  const [switching, setSwitching] = React.useState(false);
  const others = snapshot.profiles.filter((profile) => profile.name !== snapshot.profile.name);
  const url = connection.workspaceUrl("/");
  return (
    <Stack gap={12}>
      <Card>
        <Stack direction="row" gap={12} align="center" justify="space-between" wrap>
          <Stack direction="row" gap={12} align="center" style={{ minWidth: 0 }}>
            <StatusDot tone="success" label="Connected" />
            <Stack gap={2} style={{ minWidth: 0 }}>
              <Text weight={500} style={{ overflow: "hidden", textOverflow: "ellipsis" }}>
                {hostLabel(snapshot.profile.host)}
              </Text>
              <Text tone="subtle" size="sm">
                {snapshot.user.displayName ? `${snapshot.user.displayName} · ` : ""}
                {snapshot.user.userName} · profile <span className="dbx-mono">{snapshot.profile.name}</span>
              </Text>
            </Stack>
          </Stack>
          <Stack direction="row" gap={6}>
            {url && (
              <Button variant="ghost" onClick={() => openExternal(url)}>
                Open workspace
              </Button>
            )}
            <Button onClick={() => setSwitching(!switching)}>{switching ? "Done" : "Switch workspace"}</Button>
          </Stack>
        </Stack>
      </Card>
      {switching && (
        <Card>
          <Stack gap={10}>
            <Text weight={500}>Switch workspace</Text>
            {others.map((profile) => (
              <Stack key={profile.name} direction="row" align="center" justify="space-between" gap={8}>
                <Text size="sm">
                  {hostLabel(profile.host)} <Text tone="tertiary" size="xs" mono>{profile.name}</Text>
                </Text>
                <Button size="sm" onClick={() => run(() => connection.useProfile(profile.name))}>
                  Use
                </Button>
              </Stack>
            ))}
            <Stack direction="row" gap={8}>
              <Button variant="brand" size="sm" onClick={() => run(() => connection.signIn())}>
                Sign in to another workspace
              </Button>
              <Button variant="danger" size="sm" onClick={() => connection.disconnect()}>
                Disconnect
              </Button>
            </Stack>
          </Stack>
        </Card>
      )}
    </Stack>
  );
}

function DefaultsGroup(props: { service: ProvidedService }) {
  const { service } = props;
  const [warehouseId, setWarehouseId] = usePreference<string>(service, "warehouseId");
  const warehouses = useAsync(
    async (signal) => {
      const client = await service.ready(signal);
      return new Sql(client).warehouses(signal);
    },
    [service.snapshot()],
  );
  const list: readonly Warehouse[] = warehouses.data ?? [];
  const automatic = Sql.pick(list);
  return (
    <Stack gap={12}>
      <SectionHeader title="Defaults" description="Used by Genie, SQL and agents unless you choose otherwise." />
      <Field
        label="SQL warehouse"
        hint={warehouses.error ? describeError(warehouses.error) : automatic && !warehouseId ? `Automatic picks ${automatic.name}.` : undefined}
      >
        <select className="dbx-select" style={{ maxWidth: 420 }} value={warehouseId ?? ""} onChange={(event) => setWarehouseId(event.target.value || undefined)} disabled={warehouses.loading}>
          <option value="">Automatic (prefer running serverless)</option>
          {list.map((warehouse) => (
            <option key={warehouse.id} value={warehouse.id}>
              {warehouse.name} · {warehouse.state?.toLowerCase() ?? "unknown"}
              {warehouse.enable_serverless_compute ? " · serverless" : ""}
            </option>
          ))}
        </select>
      </Field>
    </Stack>
  );
}

function SuiteGroup(props: { installer: () => PluginInstaller | undefined; active: ReadonlySet<string> }) {
  const [pending, setPending] = React.useState<string>();
  const [message, setMessage] = React.useState<string>();
  const install = async (folder: string, id: string) => {
    const installer = props.installer();
    if (!installer) {
      setMessage("This version of Buzz can't install plugins from here. Use Settings → Plugins → Manage plugins → Add.");
      return;
    }
    setPending(id);
    setMessage(undefined);
    try {
      const outcome = await installer.requestInstall({ repository: REPOSITORY, reference: "main", path: `plugins/${folder}/dist` });
      if (outcome === "unavailable") setMessage("Close any open plugin review, then try again.");
    } catch (error) {
      setMessage(describeError(error));
    } finally {
      setPending(undefined);
    }
  };
  return (
    <Stack gap={12}>
      <SectionHeader title="Databricks plugins" description="Each adds one part of Databricks to Buzz and uses this connection." />
      <Stack gap={8}>
        {SUITE.map((plugin) => {
          const active = props.active.has(plugin.id);
          return (
            <Card key={plugin.id} padding={14}>
              <Stack direction="row" align="center" justify="space-between" gap={12}>
                <Stack gap={2} style={{ minWidth: 0 }}>
                  <Stack direction="row" gap={8} align="center">
                    <Text weight={500}>{plugin.name}</Text>
                    {active && <Badge tone="success">On</Badge>}
                  </Stack>
                  <Text tone="subtle" size="sm">
                    {plugin.blurb}
                  </Text>
                </Stack>
                {!active && (
                  <Button size="sm" disabled={pending !== undefined} onClick={() => void install(plugin.folder, plugin.id)}>
                    {pending === plugin.id ? "Opening…" : "Add"}
                  </Button>
                )}
              </Stack>
            </Card>
          );
        })}
      </Stack>
      {message && <Notice tone="warning">{message}</Notice>}
    </Stack>
  );
}
