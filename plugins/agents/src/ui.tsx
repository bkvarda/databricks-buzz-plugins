// Creation and settings forms for the Databricks agent types.
import { Ai, DEFAULT_MODELS } from "@dbx/core/api/ai";
import { Genie } from "@dbx/core/api/genie";
import { React } from "@dbx/core/react";
import { type DatabricksService, describeError, useAsync, useConnection } from "@dbx/core/service";
import { Button, DbxRoot, Field, Notice, Spinner, Stack, Text } from "@dbx/core/ui/components";

export type DatabricksConfig = {
  model: string;
  instructions: string;
  scope: "thread" | "channel";
  sandbox: boolean;
};
export type GenieConfig = { spaceId: string; spaceTitle: string };
export type EndpointConfig = { target: string; task: string; label: string; instructions: string };

type FormProps<C> = { config: C; onChange(config: C): void; disabled?: boolean };

function NeedsConnection(props: { service: DatabricksService }) {
  const snapshot = useConnection(props.service);
  if (snapshot.status === "connected") return null;
  return (
    <Notice tone="warning" title="Databricks isn't connected" action={<Button size="sm" variant="brand" onClick={() => props.service.openSettings()}>Connect</Button>}>
      These agents run on Databricks with your sign-in.
    </Notice>
  );
}

export function DatabricksForm(props: FormProps<DatabricksConfig> & { service: DatabricksService }) {
  const { config, onChange } = props;
  const endpoints = useAsync(async (signal) => (await new Ai(await props.service.ready(signal)).endpoints(signal)).filter((e) => /chat/.test(e.task) && !e.isAgent), [props.service.snapshot().status]);
  const known = new Set<string>(DEFAULT_MODELS.map((model) => model.id));
  const options = [
    ...DEFAULT_MODELS.map((model) => ({ id: model.id, label: model.label })),
    ...(endpoints.data ?? []).filter((endpoint) => !known.has(endpoint.name)).map((endpoint) => ({ id: endpoint.name, label: `${endpoint.label} (endpoint)` })),
  ];
  if (!options.some((option) => option.id === config.model)) options.unshift({ id: config.model, label: config.model });
  return (
    <DbxRoot>
      <Stack gap={14}>
        <NeedsConnection service={props.service} />
        <Field label="Model" hint="Served by Databricks AI Gateway, billed to your workspace.">
          <select className="dbx-select" disabled={props.disabled} value={config.model} onChange={(event) => onChange({ ...config, model: event.target.value })}>
            {options.map((option) => (
              <option key={option.id} value={option.id}>
                {option.label}
              </option>
            ))}
          </select>
        </Field>
        <label style={{ display: "flex", gap: 10, alignItems: "flex-start", fontSize: "0.8125rem" }}>
          <input type="checkbox" disabled={props.disabled} checked={config.sandbox} onChange={(event) => onChange({ ...config, sandbox: event.target.checked })} style={{ marginTop: 3 }} />
          <span>
            <Text weight={500} as="div">
              Give it a Databricks Sandbox
            </Text>
            <Text tone="subtle" size="sm" as="div">
              Its own Linux machine in Databricks to run code, with a persistent home folder, internet access and the Databricks CLI signed in as you. Created on first use.
            </Text>
          </span>
        </label>
        <Field label="Conversation" hint="Thread: each thread is its own conversation. Channel: one conversation for the whole channel.">
          <select className="dbx-select" disabled={props.disabled} value={config.scope} onChange={(event) => onChange({ ...config, scope: event.target.value as DatabricksConfig["scope"] })}>
            <option value="thread">One per thread</option>
            <option value="channel">One per channel</option>
          </select>
        </Field>
        <Field label="Instructions" hint="Optional. Who it is, what it should focus on, how to answer.">
          <textarea className="dbx-textarea" rows={5} disabled={props.disabled} value={config.instructions} onChange={(event) => onChange({ ...config, instructions: event.target.value })} />
        </Field>
      </Stack>
    </DbxRoot>
  );
}

export function GenieForm(props: FormProps<GenieConfig> & { service: DatabricksService }) {
  const { config, onChange } = props;
  const spaces = useAsync(async (signal) => new Genie(await props.service.ready(signal)).listSpaces(signal), [props.service.snapshot().status]);
  React.useEffect(() => {
    const first = spaces.data?.[0];
    if (!config.spaceId && first) onChange({ spaceId: first.space_id, spaceTitle: first.title });
  }, [spaces.data, config.spaceId, onChange]);
  return (
    <DbxRoot>
      <Stack gap={14}>
        <NeedsConnection service={props.service} />
        <Field label="Genie agent" hint="Mention this Buzz agent with a data question; it answers with Genie's explanation, a table and the SQL. Each thread keeps its own Genie conversation for follow-ups.">
          {spaces.loading ? (
            <Stack direction="row" gap={8} align="center">
              <Spinner size={12} />
              <Text tone="subtle" size="sm">
                Loading Genie agents…
              </Text>
            </Stack>
          ) : spaces.error ? (
            <Text tone="danger" size="sm">
              {describeError(spaces.error)}
            </Text>
          ) : (
            <select
              className="dbx-select"
              disabled={props.disabled}
              value={config.spaceId}
              onChange={(event) => {
                const space = spaces.data?.find((candidate) => candidate.space_id === event.target.value);
                onChange({ spaceId: event.target.value, spaceTitle: space?.title ?? "" });
              }}
            >
              {!config.spaceId && <option value="">Choose a Genie agent</option>}
              {(spaces.data ?? []).map((space) => (
                <option key={space.space_id} value={space.space_id}>
                  {space.title}
                </option>
              ))}
            </select>
          )}
        </Field>
      </Stack>
    </DbxRoot>
  );
}

export function EndpointForm(props: FormProps<EndpointConfig> & { service: DatabricksService }) {
  const { config, onChange } = props;
  const endpoints = useAsync(async (signal) => (await new Ai(await props.service.ready(signal)).endpoints(signal)).filter((e) => e.isAgent || /responses|chat/.test(e.task)), [props.service.snapshot().status]);
  const isApp = /^https:\/\//.test(config.target);
  return (
    <DbxRoot>
      <Stack gap={14}>
        <NeedsConnection service={props.service} />
        <Field label="Agent endpoint" hint="Agent Bricks agents, Knowledge Assistants, supervisors and custom agents you deployed to Model Serving.">
          <select
            className="dbx-select"
            disabled={props.disabled || endpoints.loading}
            value={isApp ? "" : config.target}
            onChange={(event) => {
              const endpoint = endpoints.data?.find((candidate) => candidate.name === event.target.value);
              onChange({ ...config, target: event.target.value, task: endpoint?.task ?? "", label: endpoint?.label ?? event.target.value });
            }}
          >
            <option value="">{endpoints.loading ? "Loading…" : "Choose an endpoint"}</option>
            {(endpoints.data ?? []).map((endpoint) => (
              <option key={endpoint.name} value={endpoint.name}>
                {endpoint.name}
                {endpoint.task ? ` · ${endpoint.task}` : ""}
                {endpoint.ready ? "" : " · not ready"}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Or a Databricks App URL" hint="For agents deployed on Databricks Apps (Agent Runtime), e.g. https://my-agent-123.aws.databricksapps.com">
          <input
            className="dbx-input"
            disabled={props.disabled}
            value={isApp ? config.target : ""}
            placeholder="https://…databricksapps.com"
            onChange={(event) => onChange({ ...config, target: event.target.value.trim(), task: "app", label: "Databricks App" })}
          />
        </Field>
      </Stack>
    </DbxRoot>
  );
}

/** A settings tab: the type's form with an explicit Save. */
export function SettingsTab<C>(props: {
  service: DatabricksService;
  config: C;
  save(config: C): Promise<void>;
  Form(props: FormProps<C> & { service: DatabricksService }): React.ReactNode;
  note?: React.ReactNode;
}) {
  const [draft, setDraft] = React.useState(props.config);
  const [state, setState] = React.useState<{ saving?: boolean; error?: string; saved?: boolean }>({});
  const dirty = JSON.stringify(draft) !== JSON.stringify(props.config);
  return (
    <DbxRoot style={{ padding: "4px 0 24px" }}>
      <Stack gap={16}>
        <props.Form service={props.service} config={draft} onChange={setDraft} disabled={state.saving} />
        {props.note}
        {state.error && <Notice tone="danger">{state.error}</Notice>}
        <Stack direction="row" gap={8} justify="flex-end" align="center">
          {state.saved && !dirty && (
            <Text tone="success" size="sm">
              Saved
            </Text>
          )}
          <Button variant="ghost" disabled={!dirty || state.saving} onClick={() => setDraft(props.config)}>
            Revert
          </Button>
          <Button
            variant="primary"
            disabled={!dirty || state.saving}
            onClick={() => {
              setState({ saving: true });
              props.save(draft).then(
                () => setState({ saved: true }),
                (error: unknown) => setState({ error: describeError(error) }),
              );
            }}
          >
            {state.saving ? "Saving…" : "Save"}
          </Button>
        </Stack>
      </Stack>
    </DbxRoot>
  );
}
