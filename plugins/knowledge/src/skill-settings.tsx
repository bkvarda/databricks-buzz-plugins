// Settings → Databricks Knowledge, the Skills section: where skills come from,
// the schemas they're found in (tagged or added by hand), making a schema a
// skills schema, the default schema for publishing, and a searchable list of
// skills with their SKILL.md.
import { parseSkillMarkdown, Skills, searchSkills, type SkillRef } from "@dbx/core/api/skills";
import { SKILLS_TAG, Tags } from "@dbx/core/api/tags";
import { React } from "@dbx/core/react";
import { type DatabricksService, describeError, isApiError, useAsync, useConnection, usePreference } from "@dbx/core/service";
import { type SkillSchema, type SkillCatalog, schemaOf } from "@dbx/core/skill-catalog";
import { Button, DbxRoot, Disclosure, Field, Notice, SectionHeader, Spinner, Stack, Text } from "@dbx/core/ui/components";
import { Markdown } from "@dbx/core/ui/markdown";
import { resolveWarehouse } from "@dbx/core/warehouse";
import { DEFAULT_SCHEMA_PREF, validSchemaName } from "./skill-draft";

const LIST_LIMIT = 200;

type Status = Readonly<{ tone: "success" | "danger"; text: string }>;

export function SkillsSettings(props: { service: DatabricksService; catalog: SkillCatalog }) {
  const { service, catalog } = props;
  const connection = useConnection(service);
  const state = React.useSyncExternalStore(catalog.subscribe, catalog.snapshot);
  const [open, setOpen] = React.useState<string>();
  React.useEffect(() => {
    if (connection.status === "connected") void catalog.load();
  }, [connection.status, catalog]);

  if (connection.status !== "connected") {
    return (
      <Stack gap={10}>
        <SectionHeader title="Skills" description="Skills are instructions your agents can search and load." />
        <Notice title="Connect Databricks" action={<Button variant="brand" onClick={() => service.openSettings()}>Connect</Button>}>
          Skills live in your Unity Catalog.
        </Notice>
      </Stack>
    );
  }
  if (open) return <SkillDetail service={service} fullName={open} onBack={() => setOpen(undefined)} />;
  return (
    <Stack gap={20}>
      <Stack gap={6}>
        <SectionHeader
          title="Skills"
          description="Skills come from schemas tagged agent_skills and any you add here. Agents search and load them; people publish them from chat."
          action={
            <Button size="sm" variant="ghost" onClick={() => void catalog.load(true)}>
              Refresh
            </Button>
          }
        />
        {state.status === "loading" && (
          <Stack direction="row" gap={8} align="center">
            <Spinner size={12} />
            <Text tone="subtle" size="sm">
              Looking for skills…
            </Text>
          </Stack>
        )}
        {state.note && (
          <Notice tone="warning" title="Some schemas may be missing">
            {state.note}
          </Notice>
        )}
        {state.error && (
          <Notice tone="danger" title="Couldn't load skills">
            {state.error}
          </Notice>
        )}
      </Stack>
      <SchemasSection service={service} catalog={catalog} schemas={state.schemas} skills={state.skills} />
      <DefaultSchema service={service} schemas={state.schemas} />
      <SkillList skills={state.skills} onOpen={setOpen} />
    </Stack>
  );
}

function SchemasSection(props: { service: DatabricksService; catalog: SkillCatalog; schemas: readonly SkillSchema[]; skills: readonly SkillRef[] }) {
  const { service, catalog, schemas, skills } = props;
  const [name, setName] = React.useState("");
  const [message, setMessage] = React.useState<Status>();
  const [busy, setBusy] = React.useState(false);
  const counts = React.useMemo(() => {
    const counted = new Map<string, number>();
    for (const skill of skills) counted.set(schemaOf(skill.fullName), (counted.get(schemaOf(skill.fullName)) ?? 0) + 1);
    return counted;
  }, [skills]);

  const add = () => {
    const schema = name.trim();
    if (!validSchemaName(schema)) return setMessage({ tone: "danger", text: "Use catalog.schema, for example main.team_skills." });
    if (catalog.locations().includes(schema) || schemas.some((entry) => entry.schema === schema && entry.source === "tag"))
      return setMessage({ tone: "danger", text: `${schema} is already a skills schema.` });
    catalog.setLocations([...catalog.locations(), schema]);
    setName("");
    setMessage({ tone: "success", text: `Added ${schema}.` });
  };

  const mark = async () => {
    const schema = name.trim();
    if (!validSchemaName(schema)) return setMessage({ tone: "danger", text: "Use catalog.schema, for example main.team_skills." });
    setBusy(true);
    try {
      const client = await service.ready();
      const warehouse = await resolveWarehouse(service);
      const [catalogName, schemaName] = schema.split(".") as [string, string];
      await new Tags(client).tagSchema(warehouse.id, catalogName, schemaName, { [SKILLS_TAG]: "true" });
      setName("");
      setMessage({ tone: "success", text: `Marked ${schema}. It can take a minute to show up here.` });
      void catalog.load(true);
    } catch (failure) {
      setMessage({ tone: "danger", text: describeError(failure) });
    } finally {
      setBusy(false);
    }
  };

  const create = async () => {
    const schema = name.trim();
    if (!validSchemaName(schema)) return setMessage({ tone: "danger", text: "Use catalog.schema, for example main.team_skills." });
    const [catalogName, schemaName] = schema.split(".") as [string, string];
    setBusy(true);
    try {
      const client = await service.ready();
      await client.post("/api/2.1/unity-catalog/schemas", { name: schemaName, catalog_name: catalogName });
      const warehouse = await resolveWarehouse(service);
      await new Tags(client).tagSchema(warehouse.id, catalogName, schemaName, { [SKILLS_TAG]: "true" });
      setName("");
      setMessage({ tone: "success", text: `Created ${schema} as a skills schema. It can take a minute to show up here.` });
      void catalog.load(true);
    } catch (failure) {
      setMessage({ tone: "danger", text: createMessage(failure, catalogName) });
    } finally {
      setBusy(false);
    }
  };

  return (
    <Stack gap={10}>
      <SectionHeader title="Skills schemas" description="Where skills are found. Tagged schemas are found everywhere; added ones are yours on this device." />
      {schemas.length === 0 && <Text tone="subtle" size="sm">No skills schemas yet. Mark an existing schema or create one below.</Text>}
      {schemas.map((entry) => (
        <div key={entry.schema} className="dbx-card" style={{ padding: "10px 12px" }}>
          <Stack direction="row" gap={10} align="center" justify="space-between" wrap>
            <Stack direction="row" gap={8} align="center">
              <Text mono size="sm" weight={500}>
                {entry.schema}
              </Text>
              <Text tone="tertiary" size="xs">
                {entry.source === "tag" ? "Tagged" : "Added"} · {counts.get(entry.schema) ?? 0} skill{(counts.get(entry.schema) ?? 0) === 1 ? "" : "s"}
              </Text>
            </Stack>
            {entry.source === "added" && (
              <Button
                size="sm"
                variant="ghost"
                onClick={() => {
                  catalog.setLocations(catalog.locations().filter((location) => location !== entry.schema));
                  setMessage({ tone: "success", text: `Removed ${entry.schema}.` });
                }}
              >
                Remove
              </Button>
            )}
          </Stack>
        </div>
      ))}
      <Field label="Schema" hint="Add a schema that already has skills, mark an existing schema as a skills schema, or create a new one.">
        <Stack direction="row" gap={8} wrap>
          <input className="dbx-input" value={name} placeholder="catalog.schema" onChange={(event) => setName(event.target.value)} style={{ flex: "1 1 220px", minWidth: 0 }} />
        </Stack>
      </Field>
      <Stack direction="row" gap={8} wrap>
        <Button onClick={add} disabled={busy}>
          Add
        </Button>
        <Button onClick={() => void mark()} disabled={busy}>
          Mark as a skills schema
        </Button>
        <Button onClick={() => void create()} disabled={busy}>
          Create a skills schema
        </Button>
      </Stack>
      {message && (
        <Text tone={message.tone} size="sm">
          {message.text}
        </Text>
      )}
    </Stack>
  );
}

/** Creating a schema needs CREATE SCHEMA on its catalog; say so plainly when that's missing. */
function createMessage(failure: unknown, catalog: string): string {
  if (isApiError(failure) && failure.isPermission)
    return `You need CREATE SCHEMA on ${catalog} to create a schema there. Ask a catalog owner, or mark an existing schema instead.`;
  if (isApiError(failure) && failure.status === 409) return "That schema already exists. Mark it as a skills schema instead.";
  return describeError(failure);
}


function DefaultSchema(props: { service: DatabricksService; schemas: readonly SkillSchema[] }) {
  const { service, schemas } = props;
  const [value, setValue] = usePreference<string>(service, DEFAULT_SCHEMA_PREF);
  const names = schemas.map((entry) => entry.schema);
  return (
    <Field label="Publish skills to" hint="The schema a new skill goes to when its channel has none. Each draft still shows the schema before you publish.">
      <select className="dbx-select" aria-label="Default schema" value={value ?? ""} onChange={(event) => setValue(event.target.value || undefined)} style={{ maxWidth: 360 }}>
        <option value="">Ask each time</option>
        {names.map((name) => (
          <option key={name} value={name}>
            {name}
          </option>
        ))}
        {value && !names.includes(value) && <option value={value}>{value}</option>}
      </select>
    </Field>
  );
}

function SkillList(props: { skills: readonly SkillRef[]; onOpen(fullName: string): void }) {
  const [query, setQuery] = React.useState("");
  const matches = query.trim() ? searchSkills(props.skills, query, LIST_LIMIT) : props.skills.slice(0, LIST_LIMIT);
  return (
    <Stack gap={10}>
      <SectionHeader
        title="Skills"
        description={props.skills.length ? `${props.skills.length} in your skills schemas.` : undefined}
      />
      <input className="dbx-input" placeholder="Search skills" aria-label="Search skills" value={query} onChange={(event) => setQuery(event.target.value)} style={{ maxWidth: 420 }} />
      {!props.skills.length && <Text tone="subtle" size="sm">No skills yet. Publish one from a message, or ask an agent to draft one.</Text>}
      {query.trim() && !matches.length && <Text tone="subtle" size="sm">Nothing matches.</Text>}
      {matches.map((skill) => (
        <button
          key={skill.fullName}
          type="button"
          onClick={() => props.onOpen(skill.fullName)}
          className="dbx-card"
          style={{ padding: "10px 12px", textAlign: "left", cursor: "pointer", font: "inherit", color: "inherit" }}
        >
          <Stack gap={2}>
            <Text mono size="sm" weight={500}>
              {skill.fullName}
            </Text>
            {skill.description && (
              <Text tone="subtle" size="sm">
                {skill.description}
              </Text>
            )}
          </Stack>
        </button>
      ))}
      {props.skills.length > LIST_LIMIT && !query.trim() && (
        <Text tone="tertiary" size="xs">
          Showing the first {LIST_LIMIT}. Search for the rest.
        </Text>
      )}
    </Stack>
  );
}

function SkillDetail(props: { service: DatabricksService; fullName: string; onBack(): void }) {
  const { service, fullName, onBack } = props;
  const detail = useAsync(
    async (signal) => {
      const skills = new Skills(await service.ready(signal));
      const [text, files] = await Promise.all([skills.read(fullName, "SKILL.md", signal), skills.files(fullName, signal)]);
      return { parsed: parseSkillMarkdown(text), files: files.filter((path) => path !== "SKILL.md") };
    },
    [service, fullName],
  );
  return (
    <DbxRoot>
      <Stack gap={14}>
        <div>
          <Button size="sm" variant="ghost" onClick={onBack}>
            ← All skills
          </Button>
        </div>
        <Stack gap={4}>
          <Text mono weight={600}>
            {fullName}
          </Text>
          {detail.data?.parsed.description && <Text tone="subtle">{detail.data.parsed.description}</Text>}
        </Stack>
        {detail.loading && (
          <Stack direction="row" gap={8} align="center">
            <Spinner size={12} />
            <Text tone="subtle" size="sm">
              Loading…
            </Text>
          </Stack>
        )}
        {detail.error && (
          <Notice tone="danger" title="Couldn't read this skill">
            {describeError(detail.error)}
          </Notice>
        )}
        {detail.data && <Markdown source={detail.data.parsed.body} />}
        {detail.data && (
          <Disclosure summary={`Other files (${detail.data.files.length})`}>
            {detail.data.files.length ? (
              <Stack gap={2}>
                {detail.data.files.map((path) => (
                  <Text key={path} mono size="sm">
                    {path}
                  </Text>
                ))}
              </Stack>
            ) : (
              <Text tone="subtle" size="sm">
                This skill has only SKILL.md.
              </Text>
            )}
          </Disclosure>
        )}
      </Stack>
    </DbxRoot>
  );
}
