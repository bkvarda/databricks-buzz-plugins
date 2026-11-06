// "Set up Databricks" in a channel's menu. A linked channel shows its domain,
// schema, skills and Pages, with Unlink. An unlinked one gets the setup form:
// a domain and a skills schema, picked or created, and optional access for a
// group or user. Everything runs as the person opening it.
import type { SkillSchema } from "@dbx/core/skill-catalog";
import { type Domain, domainName, Domains, domainTitle } from "@dbx/core/api/domains";
import { type KnowledgePage, Pages } from "@dbx/core/api/pages";
import { CHANNEL_TAG, DOMAIN_TAG } from "@dbx/core/api/tags";
import type { PanelProps } from "@dbx/core/host-types";
import { React } from "@dbx/core/react";
import { describeError, isApiError, useAsync, useConnection, type DatabricksService } from "@dbx/core/service";
import type { CatalogState, SkillCatalog } from "@dbx/core/skill-catalog";
import { schemaOf } from "@dbx/core/skill-catalog";
import { Badge, Button, Card, CodeView, DbxRoot, Field, Notice, openExternal, SectionHeader, Spinner, Stack, Text } from "@dbx/core/ui/components";
import { listCatalogs, listSchemas } from "./domain-api";
import { type DomainNew, type DomainPick, type SetupResult, type SetupStep, schemaNameFor, setUpChannel, unlinkChannel } from "./channel-setup";
import { PAGES_OFF } from "./page-draft";
import { SearchList } from "./picker";

export function useCatalogState(catalog: SkillCatalog): CatalogState {
  return React.useSyncExternalStore(catalog.subscribe, catalog.snapshot);
}

/** A domain's ID from its `domains/<id>` name, or its own ID. */
const idOf = (domain: Pick<Domain, "name" | "domain_id">) => domain.domain_id ?? domain.name.replace(/^domains\//, "");

const DENIED_LIST = "Listing domains needs the MANAGE DISCOVERY permission. Ask an admin, or create a new domain.";
const STEP_LABEL = { done: "Done", skipped: "Skipped", denied: "Ask an admin", failed: "Failed" } as const;
const STEP_TONE = { done: "success", skipped: "neutral", denied: "warning", failed: "danger" } as const;

function StepList(props: { steps: readonly SetupStep[] }) {
  return (
    <Card>
      <Stack gap={12}>
        <Text weight={500}>Set-up steps</Text>
        {props.steps.map((step) => (
          <Stack key={step.id} gap={4}>
            <Stack direction="row" gap={8} align="center" wrap>
              <Badge tone={STEP_TONE[step.status]}>{STEP_LABEL[step.status]}</Badge>
              <Text size="sm" weight={500}>
                {step.title}
              </Text>
            </Stack>
            {step.detail && (
              <Text size="sm" tone="subtle">
                {step.detail}
              </Text>
            )}
            {step.sql && <CodeView code={step.sql} language="sql" />}
          </Stack>
        ))}
      </Stack>
    </Card>
  );
}

function Linked(props: { service: DatabricksService; catalog: SkillCatalog; state: CatalogState; link: SkillSchema; onUnlinked(): void }) {
  const { service, catalog, state, link } = props;
  const domainId = link.tags[DOMAIN_TAG] || undefined;
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string>();
  const domain = useAsync(async (): Promise<{ domain?: Domain; error?: string }> => {
    if (!domainId) return { error: "No domain is set on this schema." };
    try {
      return { domain: await new Domains(await service.ready()).get(domainName(domainId)) };
    } catch (failure) {
      return { error: isApiError(failure) && failure.isPermission ? "Its details need the MANAGE DISCOVERY permission." : describeError(failure) };
    }
  }, [domainId]);
  const pages = useAsync(async (): Promise<{ on: boolean; list?: KnowledgePage[]; error?: string }> => {
    const api = new Pages(await service.ready());
    if (!(await api.available())) return { on: false };
    if (!domainId) return { on: true, list: [] };
    try {
      return { on: true, list: await api.list({ domain: domainName(domainId) }) };
    } catch (failure) {
      return { on: true, error: describeError(failure) };
    }
  }, [domainId]);
  const skills = state.skills.filter((skill) => schemaOf(skill.fullName) === link.schema);
  const [catalogName, schemaName] = link.schema.split(".") as [string, string];

  const unlink = async () => {
    setBusy(true);
    setError(undefined);
    try {
      await unlinkChannel(await service.ready(), link.schema);
      await catalog.load(true);
      props.onUnlinked();
    } catch (failure) {
      setError(
        isApiError(failure) && failure.isPermission
          ? `Removing the link needs APPLY TAG on ${link.schema}. Ask the schema owner or an admin.`
          : describeError(failure),
      );
    } finally {
      setBusy(false);
    }
  };

  const openSchema = () => {
    const url = service.workspaceUrl(`/explore/data/${catalogName}/${schemaName}`);
    if (url) openExternal(url);
  };

  const d = domain.data?.domain;
  return (
    <Card>
      <Stack gap={14}>
        <Stack gap={4}>
          <Text size="xs" tone="subtle">
            Domain
          </Text>
          {d ? (
            <Stack direction="row" gap={8} align="center" wrap>
              <Text weight={500}>{domainTitle(d)}</Text>
              <Badge tone={d.effective_draft ? "warning" : "success"}>{d.effective_draft ? "Draft" : "Published"}</Badge>
            </Stack>
          ) : domain.loading ? (
            <Spinner label="Loading the domain" />
          ) : (
            <Text size="sm">{domainId}</Text>
          )}
          {d?.description && (
            <Text size="sm" tone="subtle">
              {d.description}
            </Text>
          )}
          {domain.data?.error && (
            <Text size="sm" tone="subtle">
              {domain.data.error}
            </Text>
          )}
        </Stack>

        <Stack gap={4}>
          <Text size="xs" tone="subtle">
            Skills schema
          </Text>
          <Stack direction="row" gap={8} align="center" wrap>
            <Text mono size="sm">
              {link.schema}
            </Text>
            <Button size="sm" variant="ghost" onClick={openSchema}>
              Open in Databricks
            </Button>
          </Stack>
        </Stack>

        <Stack gap={4}>
          <Text size="xs" tone="subtle">
            Skills ({skills.length})
          </Text>
          {skills.length ? (
            skills.slice(0, 50).map((skill) => (
              <Text key={skill.fullName} size="sm">
                <span className="dbx-mono">{skill.fullName.split(".").pop()}</span>
                {skill.description ? ` — ${skill.description}` : ""}
              </Text>
            ))
          ) : (
            <Text size="sm" tone="subtle">
              No skills in this schema yet.
            </Text>
          )}
        </Stack>

        <Stack gap={4}>
          <Text size="xs" tone="subtle">
            Pages
          </Text>
          {pages.loading && <Spinner label="Loading pages" />}
          {pages.data && !pages.data.on && <Text size="sm">{PAGES_OFF}</Text>}
          {pages.data?.error && <Text size="sm" tone="subtle">Couldn't list pages: {pages.data.error}</Text>}
          {pages.data?.on && pages.data.list && (
            <>
              <Text size="sm" tone="subtle">
                {pages.data.list.length ? `${pages.data.list.length} in this domain.` : "None in this domain yet."}
              </Text>
              {pages.data.list.slice(0, 25).map((page) => (
                <Text key={page.name} size="sm">
                  {page.display_name} <span style={{ color: "var(--dbx-subtle)" }}>({page.state === "PUBLISHED" ? "published" : "draft"})</span>
                </Text>
              ))}
            </>
          )}
        </Stack>

        <Stack gap={6}>
          <Text size="sm" tone="subtle">
            Unlinking keeps the domain and the schema. This channel stops using them.
          </Text>
          <Stack direction="row">
            <Button disabled={busy} onClick={() => void unlink()}>
              {busy ? "Unlinking…" : "Unlink channel"}
            </Button>
          </Stack>
          {error && <Notice tone="danger">{error}</Notice>}
        </Stack>
      </Stack>
    </Card>
  );
}

function SetupForm(props: { service: DatabricksService; catalog: SkillCatalog; channel: { id: string; name: string }; onResult(result: SetupResult): void }) {
  const { service, catalog, channel } = props;
  const [domainMode, setDomainMode] = React.useState<"new" | "existing">("new");
  const [domainId, setDomainId] = React.useState("");
  const [title, setTitle] = React.useState(channel.name.replace(/\//g, " ").trim());
  const [description, setDescription] = React.useState("");
  const [parentId, setParentId] = React.useState("");
  const [catalogName, setCatalogName] = React.useState("");
  const [schemaMode, setSchemaMode] = React.useState<"new" | "existing">("new");
  const [schemaPick, setSchemaPick] = React.useState("");
  const [schemaName, setSchemaName] = React.useState(schemaNameFor(channel.name));
  const [principal, setPrincipal] = React.useState("");
  const [running, setRunning] = React.useState(false);
  const [error, setError] = React.useState<string>();

  const domains = useAsync(async () => new Domains(await service.ready()).list(), []);
  const catalogs = useAsync(async () => listCatalogs(await service.ready()), []);
  const schemas = useAsync(async () => (catalogName ? listSchemas(await service.ready(), catalogName) : []), [catalogName]);
  React.useEffect(() => {
    if (!catalogName && catalogs.data?.length) setCatalogName(catalogs.data[0] ?? "");
  }, [catalogs.data, catalogName]);

  const picked = domains.data?.find((domain) => idOf(domain) === domainId);
  const parent = domains.data?.find((domain) => idOf(domain) === parentId);
  const newSchema = schemaName.trim();
  const schemaValid = /^[A-Za-z0-9_]+$/.test(newSchema);
  const canRun =
    !running && !!catalogName && (domainMode === "existing" ? !!picked : title.trim().length > 0) && (schemaMode === "new" ? schemaValid : !!schemaPick);

  const run = async () => {
    setRunning(true);
    setError(undefined);
    try {
      const client = await service.ready();
      const snapshot = service.snapshot();
      const domain: DomainPick | DomainNew =
        domainMode === "existing" && picked
          ? { mode: "existing", id: idOf(picked), tagKey: picked.tag_key, title: domainTitle(picked) }
          : {
              mode: "new",
              title: title.trim(),
              ...(description.trim() && { description: description.trim() }),
              ...(parent && { parent: { id: idOf(parent), tagKey: parent.tag_key } }),
            };
      const result = await setUpChannel(client, {
        channel,
        domain,
        schema: { catalog: catalogName, name: schemaMode === "new" ? newSchema : schemaPick, create: schemaMode === "new" },
        ...(principal.trim() ? { principal: principal.trim() } : {}),
        ...(snapshot.status === "connected" ? { viewer: snapshot.user.userName } : {}),
      });
      props.onResult(result);
      await catalog.load(true);
    } catch (failure) {
      setError(describeError(failure));
    } finally {
      setRunning(false);
    }
  };

  const domainListError = domains.error && (isApiError(domains.error) && domains.error.isPermission ? DENIED_LIST : describeError(domains.error));
  return (
    <Card>
      <Stack gap={16}>
        <Stack gap={8}>
          <Text weight={500}>Domain</Text>
          <Stack direction="row" gap={8} wrap>
            <Button variant={domainMode === "new" ? "primary" : "default"} onClick={() => setDomainMode("new")}>
              Create a domain
            </Button>
            <Button variant={domainMode === "existing" ? "primary" : "default"} onClick={() => setDomainMode("existing")}>
              Use an existing domain
            </Button>
          </Stack>
          {domainMode === "new" ? (
            <Stack gap={10}>
              <Field label="Name" hint="Starts as a draft. Nothing is published.">
                <input className="dbx-input" value={title} onChange={(event) => setTitle(event.target.value)} />
              </Field>
              <Field label="Description (optional)">
                <input className="dbx-input" value={description} onChange={(event) => setDescription(event.target.value)} />
              </Field>
              <Field label="Parent domain (optional)" hint="Creates a subdomain under the parent.">
                <select className="dbx-select" value={parentId} onChange={(event) => setParentId(event.target.value)}>
                  <option value="">No parent</option>
                  {(domains.data ?? []).map((domain) => (
                    <option key={idOf(domain)} value={idOf(domain)}>
                      {domainTitle(domain)}
                    </option>
                  ))}
                </select>
              </Field>
            </Stack>
          ) : domains.loading ? (
            <Spinner label="Loading domains" />
          ) : domainListError ? (
            <Notice tone="warning">{domainListError}</Notice>
          ) : (
            <SearchList
              label="Domains"
              placeholder="Search domains"
              emptyText="No domains yet. Create one instead."
              value={domainId}
              onPick={setDomainId}
              choices={(domains.data ?? []).map((domain) => ({ id: idOf(domain), label: domainTitle(domain), detail: domain.effective_draft ? "Draft" : undefined }))}
            />
          )}
        </Stack>

        <Stack gap={8}>
          <Text weight={500}>Skills schema</Text>
          <Field label="Catalog">
            {catalogs.loading ? (
              <Spinner label="Loading catalogs" />
            ) : catalogs.error ? (
              <Notice tone="warning">{describeError(catalogs.error)}</Notice>
            ) : (
              <select className="dbx-select" value={catalogName} onChange={(event) => setCatalogName(event.target.value)}>
                {(catalogs.data ?? []).map((name) => (
                  <option key={name} value={name}>
                    {name}
                  </option>
                ))}
              </select>
            )}
          </Field>
          <Stack direction="row" gap={8} wrap>
            <Button variant={schemaMode === "new" ? "primary" : "default"} onClick={() => setSchemaMode("new")}>
              Create a schema
            </Button>
            <Button variant={schemaMode === "existing" ? "primary" : "default"} onClick={() => setSchemaMode("existing")}>
              Use an existing schema
            </Button>
          </Stack>
          {schemaMode === "new" ? (
            <Field label="Schema name" hint={newSchema && !schemaValid ? "Use letters, numbers and underscores." : "Creating it needs CREATE SCHEMA on the catalog."}>
              <input className="dbx-input" value={schemaName} onChange={(event) => setSchemaName(event.target.value)} />
            </Field>
          ) : schemas.loading ? (
            <Spinner label="Loading schemas" />
          ) : schemas.error ? (
            <Notice tone="warning">{describeError(schemas.error)}</Notice>
          ) : (
            <SearchList
              label="Schemas"
              placeholder="Search schemas"
              emptyText="No schemas in this catalog."
              value={schemaPick}
              onPick={setSchemaPick}
              choices={(schemas.data ?? []).map((name) => ({ id: name, label: name }))}
            />
          )}
        </Stack>

        <Field label="Who can use the skills (optional)" hint="A group or user. Gives USE SCHEMA and READ VOLUME on the schema, and USE CATALOG if an admin allows it.">
          <input className="dbx-input" value={principal} placeholder="Group or user name" onChange={(event) => setPrincipal(event.target.value)} />
        </Field>

        {error && <Notice tone="danger">{error}</Notice>}
        <Stack direction="row">
          <Button variant="brand" disabled={!canRun} onClick={() => void run()}>
            {running ? "Setting up…" : "Set up"}
          </Button>
        </Stack>
      </Stack>
    </Card>
  );
}

/** The "Set up Databricks" channel panel. */
export function channelSetupPanel(service: DatabricksService, catalog: SkillCatalog) {
  return function ChannelSetupPanel({ channelContext }: PanelProps) {
    const connection = useConnection(service);
    const state = useCatalogState(catalog);
    const [outcome, setOutcome] = React.useState<SetupResult>();
    React.useEffect(() => {
      if (connection.status === "connected") void catalog.load();
    }, [connection.status]);

    if (!channelContext) return <Notice>Open this from a channel's menu.</Notice>;
    if (connection.status !== "connected")
      return (
        <DbxRoot>
          <Notice title="Connect Databricks" action={<Button variant="brand" onClick={() => service.openSettings()}>Connect</Button>}>
            Channels link to Unity Catalog, so Databricks needs to be connected first.
          </Notice>
        </DbxRoot>
      );

    const channel = { id: channelContext.channelId, name: channelContext.channelName };
    // Discovery can lag a moment behind a fresh link, so a result we just wrote counts too.
    const found = state.schemas.find((schema) => schema.tags[CHANNEL_TAG] === channel.id);
    const link: SkillSchema | undefined =
      found ?? (outcome?.linked ? { schema: outcome.schema, tags: { [CHANNEL_TAG]: channel.id, [DOMAIN_TAG]: outcome.domainId ?? "" }, source: "tag" } : undefined);
    const showLinked = !!link && !(outcome && !outcome.linked && !found);

    return (
      <DbxRoot>
        <div style={{ padding: 16 }}>
          <Stack gap={16}>
            <SectionHeader
              title={`Databricks for #${channel.name}`}
              description={showLinked ? "This channel's domain and skills." : "Link this channel to a domain and a skills schema."}
            />
            {state.note && <Notice tone="warning">{state.note}</Notice>}
            {state.status === "error" && <Notice tone="danger" action={<Button onClick={() => void catalog.load(true)}>Try again</Button>}>{state.error}</Notice>}
            {outcome && <StepList steps={outcome.steps} />}
            {!state.at && state.status !== "error" ? (
              <Spinner label="Looking for this channel's schema" />
            ) : showLinked && link ? (
              <Linked service={service} catalog={catalog} state={state} link={link} onUnlinked={() => setOutcome(undefined)} />
            ) : (
              <SetupForm service={service} catalog={catalog} channel={channel} onResult={setOutcome} />
            )}
          </Stack>
        </div>
      </DbxRoot>
    );
  };
}
