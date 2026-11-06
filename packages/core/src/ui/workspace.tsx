// Choosing a Databricks workspace: "Same as Buzz", another CLI profile, or a
// new browser sign-in, plus how that workspace's sign-in is doing. Shared by
// the agents form and plugins with their own workspace setting.
import type { ConnectionSnapshot } from "../connection";
import { React } from "../react";
import { type DatabricksService, describeError, useConnection } from "../service";
import { Button, Field, Notice, Spinner, Stack, Text } from "./components";

const hostname = (host: string) => new URL(host).hostname;
const ADD = "__add__";

/** The service for a CLI profile, or the main one when there's none. */
export function useWorkspaceService(service: DatabricksService, profile: string | undefined): DatabricksService {
  return React.useMemo(() => (profile && service.forProfile ? service.forProfile(profile) : service), [service, profile]);
}

/** The browser is open for sign-in; the form waits, as Settings → Databricks does. */
export function BrowserWait(props: { service: DatabricksService; host?: string }) {
  const { cancelSignIn } = props.service;
  return (
    <Stack direction="row" gap={8} align="center" justify="space-between">
      <Stack direction="row" gap={6} align="center">
        <Spinner size={11} />
        <Text tone="subtle" size="sm">
          Finish signing in in your browser{props.host ? ` (${hostname(props.host)})` : ""}.
        </Text>
      </Stack>
      {cancelSignIn && (
        <Button size="sm" variant="ghost" onClick={() => cancelSignIn()}>
          Cancel
        </Button>
      )}
    </Stack>
  );
}

/**
 * How a workspace connection (an agent's, a plugin's) is doing. An expired or missing
 * sign-in gets a button that runs the CLI's browser sign-in for that profile
 * (`databricks auth login --profile …`), the same flow as Settings.
 */
export function WorkspaceStatus(props: { service: DatabricksService; snapshot: ConnectionSnapshot }) {
  const { service, snapshot } = props;
  const signIn = (label: string) =>
    service.reauthenticate ? (
      <Button size="sm" variant="brand" onClick={() => void service.reauthenticate!()}>
        {label}
      </Button>
    ) : undefined;
  switch (snapshot.status) {
    case "checking":
    case "connecting":
      return (
        <Stack direction="row" gap={6} align="center">
          <Spinner size={11} />
          <Text tone="subtle" size="sm">Connecting…</Text>
        </Stack>
      );
    case "signing-in":
      return <BrowserWait service={service} {...(snapshot.host && { host: snapshot.host })} />;
    case "connected":
      return (
        <Text tone="subtle" size="sm">
          Signed in to {hostname(snapshot.profile.host)} as {snapshot.user.userName}.
        </Text>
      );
    case "error":
      return (
        <Notice tone="warning" action={signIn(snapshot.needsSignIn ? "Sign in again" : "Sign in")}>
          {snapshot.needsSignIn ? "Your sign-in to this workspace has expired." : snapshot.message}
        </Notice>
      );
    case "signed-out":
      return (
        <Notice tone="warning" action={signIn("Sign in")}>
          {snapshot.error ?? "You're not signed in to this workspace."}
        </Notice>
      );
    default:
      return null;
  }
}

export function WorkspaceField(props: { service: DatabricksService; profile?: string; onChange(profile: string | undefined): void; disabled?: boolean }) {
  const main = useConnection(props.service);
  const workspace = useWorkspaceService(props.service, props.profile);
  const current = useConnection(workspace);
  const [adding, setAdding] = React.useState(false);
  const [url, setUrl] = React.useState("");
  const [state, setState] = React.useState<{ busy?: boolean; error?: string }>({});
  if (!props.service.forProfile) return null;
  const host = (snapshot: typeof main) => ("profile" in snapshot ? new URL(snapshot.profile.host).hostname : undefined);
  const profiles = props.service.profiles();
  const mainName = main.status === "connected" ? main.profile.name : undefined;
  const signIn = async () => {
    setState({ busy: true });
    try {
      const profile = await props.service.addWorkspace!(url.trim() ? { host: url.trim() } : {});
      props.onChange(profile === mainName ? undefined : profile);
      setAdding(false);
      setUrl("");
      setState({});
    } catch (error) {
      setState({ error: describeError(error) });
    }
  };
  return (
    <Field label="Workspace" hint="Uses your Databricks CLI sign-in for that workspace.">
      <Stack gap={8}>
        <select
          className="dbx-select"
          disabled={props.disabled}
          value={adding ? ADD : (props.profile ?? "")}
          onChange={(event) => {
            const value = event.target.value;
            if (value === ADD) return setAdding(true);
            setAdding(false);
            props.onChange(value && value !== mainName ? value : undefined);
          }}
        >
          <option value="">Same as Buzz{host(main) ? ` · ${host(main)}` : ""}</option>
          {profiles
            .filter((profile) => profile.name !== mainName)
            .map((profile) => (
              <option key={profile.name} value={profile.name}>
                {profile.name} · {new URL(profile.host).hostname}
              </option>
            ))}
          <option value={ADD}>Sign in to another workspace…</option>
        </select>
        {adding && (
          <Stack direction="row" gap={8} align="center">
            <input className="dbx-input" placeholder="https://… (blank to choose in the browser)" value={url} onChange={(event) => setUrl(event.target.value)} style={{ flex: 1 }} />
            <Button variant="brand" disabled={state.busy} onClick={() => void signIn()}>
              {state.busy ? <Spinner size={12} /> : null}Sign in
            </Button>
          </Stack>
        )}
        {state.busy && <Text tone="subtle" size="sm">Finish signing in in your browser.</Text>}
        {state.error && <Text tone="danger" size="sm">{state.error}</Text>}
        {props.profile && !adding && <WorkspaceStatus service={workspace} snapshot={current} />}
      </Stack>
    </Field>
  );
}
