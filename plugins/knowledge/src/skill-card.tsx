// The databricks-skill card: a draft an agent posted (or a message turned into),
// shown with its fields, an inline editor, a target schema and Publish. The
// editor is shared with the "Make this a skill" dialog. Publish state is kept
// per draft in this plugin, so a card that remounts still says it's published.
import { validSkillId } from "@dbx/core/api/skills";
import { React } from "@dbx/core/react";
import { type DatabricksService, describeError, useConnection, usePreference } from "@dbx/core/service";
import type { SkillCatalog } from "@dbx/core/skill-catalog";
import { Button, DbxRoot, Disclosure, Field, Notice, Stack, Text } from "@dbx/core/ui/components";
import { Markdown } from "@dbx/core/ui/markdown";
import { DEFAULT_SCHEMA_PREF, parseDraft, type SkillDraft, validateDraft, validSchemaName } from "./skill-draft";
import { domainIdOf, isAlreadyExists, type Published, publishDraft, shareSkill, tagDomain } from "./skill-publish";

/** Published drafts, keyed by the text they were drafted as. Lives as long as the plugin. */
const published = new Map<string, Published>();

const OTHER = "__other";

const inputStyle = { width: "100%" } as const;

/** The block an agent posted, as a card. */
export function skillBlock(service: DatabricksService, catalog: SkillCatalog) {
  return function SkillBlock(props: { code: string; language: string }) {
    let draft: SkillDraft | undefined;
    let problem: string | undefined;
    try {
      draft = parseDraft(props.code);
    } catch (failure) {
      problem = describeError(failure);
    }
    return (
      <DbxRoot>
        {draft ? (
          <SkillEditor key={props.code} storeKey={props.code} initial={draft} service={service} catalog={catalog} />
        ) : (
          <Notice tone="warning" title="This skill draft isn't readable yet">
            {problem}
          </Notice>
        )}
      </DbxRoot>
    );
  };
}

/** A draft: its fields, the target schema, and publishing it as the signed-in person. */
export function SkillEditor(props: {
  storeKey: string;
  initial: SkillDraft;
  service: DatabricksService;
  catalog: SkillCatalog;
  /** Set in the dialog; the card has no close button. */
  onClose?: () => void;
}) {
  const { storeKey, initial, service, catalog, onClose } = props;
  const connection = useConnection(service);
  const snapshot = React.useSyncExternalStore(catalog.subscribe, catalog.snapshot);
  const [defaultSchema] = usePreference<string>(service, DEFAULT_SCHEMA_PREF);
  const [draft, setDraft] = React.useState<SkillDraft>(initial);
  const [editing, setEditing] = React.useState(false);
  const [schema, setSchema] = React.useState(initial.schema ?? defaultSchema ?? "");
  const [otherSchema, setOtherSchema] = React.useState(false);
  const [result, setResult] = React.useState<Published | undefined>(() => published.get(storeKey));
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string>();
  const [replaceable, setReplaceable] = React.useState(false);
  const [principal, setPrincipal] = React.useState("");
  const [shareError, setShareError] = React.useState<string>();
  const [sharing, setSharing] = React.useState(false);

  React.useEffect(() => {
    if (connection.status === "connected") void catalog.load();
  }, [connection.status, catalog]);

  const known = snapshot.schemas.map((entry) => entry.schema);
  const choices = [...known, ...(schema && !known.includes(schema) ? [schema] : [])];
  const selected = otherSchema ? OTHER : schema;
  const connected = connection.status === "connected";

  const update = (fields: Partial<SkillDraft>) => {
    setDraft((current) => ({ ...current, ...fields }));
    setReplaceable(false);
  };

  const publish = async (replace: boolean) => {
    const problem = validateDraft(draft) ?? (validSchemaName(schema) ? undefined : "Choose the schema to publish into, as catalog.schema.");
    if (problem) {
      setError(problem);
      return;
    }
    setBusy(true);
    setError(undefined);
    setReplaceable(false);
    try {
      const next = await publishDraft(service, catalog, draft, schema, { replace });
      published.set(storeKey, next);
      setResult(next);
    } catch (failure) {
      setReplaceable(isAlreadyExists(failure));
      setError(describeError(failure));
    } finally {
      setBusy(false);
    }
  };

  const share = async () => {
    const who = principal.trim();
    if (!result || !who) return;
    setSharing(true);
    setShareError(undefined);
    try {
      await shareSkill(service, result.fullName, who);
      const next = { ...result, shared: [...result.shared, who] };
      published.set(storeKey, next);
      setResult(next);
      setPrincipal("");
    } catch (failure) {
      setShareError(describeError(failure));
    } finally {
      setSharing(false);
    }
  };

  const retryDomain = async () => {
    if (!result) return;
    try {
      const domainId = domainIdOf(catalog, result.schema);
      if (!domainId) return;
      const next = { ...result, domain: await tagDomain(await service.ready(), result.fullName, domainId) };
      published.set(storeKey, next);
      setResult(next);
    } catch (failure) {
      setShareError(describeError(failure));
    }
  };

  if (result) {
    return (
      <Stack gap={14}>
        <Notice tone="success" title={`${result.created ? "Published" : "Replaced"} ${result.fullName}`}>
          {result.created ? "Agents can find and load it now." : "The existing skill now has this content."}
        </Notice>
        {result.domain?.status === "tagged" && <Text tone="subtle" size="sm">Tagged with the domain tag {result.domain.tag}.</Text>}
        {result.domain?.status === "failed" && (
          <Notice
            tone="warning"
            title="Not tagged with the domain"
            action={
              <Button size="sm" onClick={() => void retryDomain()}>
                Try again
              </Button>
            }
          >
            {result.domain.error}
          </Notice>
        )}
        <Stack gap={8}>
          <Text weight={500} size="sm">
            Share it
          </Text>
          <Text tone="subtle" size="sm">
            Only you can see it until you share it. Sharing gives read access to a person or group.
          </Text>
          <Stack direction="row" gap={8} align="center" wrap>
            <input
              className="dbx-input"
              aria-label="Person or group"
              placeholder="Email or group name"
              value={principal}
              onChange={(event) => setPrincipal(event.target.value)}
              style={{ flex: "1 1 220px", minWidth: 0 }}
            />
            <Button disabled={!principal.trim() || sharing} onClick={() => void share()}>
              {sharing ? "Sharing…" : "Share"}
            </Button>
          </Stack>
          {result.shared.length > 0 && <Text size="sm" tone="subtle">Shared with {result.shared.join(", ")}.</Text>}
          {shareError && (
            <Notice tone="danger" title="Couldn't share it">
              {shareError}
            </Notice>
          )}
        </Stack>
        {onClose && (
          <Stack direction="row" justify="flex-end">
            <Button variant="primary" onClick={onClose}>
              Done
            </Button>
          </Stack>
        )}
      </Stack>
    );
  }

  return (
    <Stack gap={14}>
      {!connected && (
        <Notice
          title="Connect Databricks to publish"
          action={
            <Button size="sm" onClick={() => service.openSettings()}>
              Connect
            </Button>
          }
        >
          A skill is published to Unity Catalog as you.
        </Notice>
      )}
      {editing ? (
        <Stack gap={12}>
          <Field label="Name" hint="Lowercase letters, digits, hyphens and underscores. Up to 64 characters.">
            <input className="dbx-input dbx-mono" value={draft.name} onChange={(event) => update({ name: event.target.value.trim() })} style={inputStyle} />
            {draft.name && !validSkillId(draft.name) && (
              <Text tone="danger" size="xs">
                That name won't work; use lowercase letters, digits, hyphens and underscores.
              </Text>
            )}
          </Field>
          <Field label="Description" hint="One sentence on when an agent should use it.">
            <textarea className="dbx-textarea" rows={2} value={draft.description} onChange={(event) => update({ description: event.target.value })} style={inputStyle} />
          </Field>
          <Field label="Instructions" hint="Markdown. Write it so an agent can follow it alone.">
            <textarea className="dbx-textarea dbx-mono" rows={12} value={draft.instructions} onChange={(event) => update({ instructions: event.target.value })} style={inputStyle} />
          </Field>
        </Stack>
      ) : (
        <Stack gap={6}>
          <Text weight={600} mono>
            {draft.name}
          </Text>
          <Text tone="subtle">{draft.description}</Text>
          <Disclosure summary="Instructions">
            <Markdown source={draft.instructions} />
          </Disclosure>
        </Stack>
      )}
      {draft.files.length > 0 && (
        <Text size="xs" tone="subtle" mono>
          Files: {draft.files.map((file) => file.path).join(", ")}
        </Text>
      )}
      <Field label="Publish to" hint={schema ? undefined : "Pick a schema. Schemas you've set up as skills schemas are listed."}>
        <Stack direction="row" gap={8} wrap>
          <select
            className="dbx-select"
            aria-label="Target schema"
            value={selected}
            onChange={(event) => {
              const next = event.target.value;
              setOtherSchema(next === OTHER);
              setSchema(next === OTHER ? "" : next);
            }}
            style={{ flex: "1 1 240px", minWidth: 0 }}
          >
            <option value="">Choose a schema</option>
            {choices.map((name) => (
              <option key={name} value={name}>
                {name}
              </option>
            ))}
            <option value={OTHER}>Other…</option>
          </select>
          {otherSchema && (
            <input
              className="dbx-input"
              aria-label="catalog.schema"
              placeholder="catalog.schema"
              value={schema}
              onChange={(event) => setSchema(event.target.value.trim())}
              style={{ flex: "1 1 200px", minWidth: 0 }}
            />
          )}
        </Stack>
      </Field>
      {error && (
        <Notice tone="danger" title={replaceable ? "That name is taken" : "Couldn't publish it"}>
          {error}
        </Notice>
      )}
      <Stack direction="row" gap={8} align="center" justify="space-between" wrap>
        <Button variant="ghost" size="sm" onClick={() => setEditing((value) => !value)}>
          {editing ? "Done editing" : "Edit"}
        </Button>
        <Stack direction="row" gap={8} align="center">
          {onClose && (
            <Button variant="ghost" onClick={onClose}>
              Cancel
            </Button>
          )}
          {replaceable && (
            <Button disabled={busy} onClick={() => void publish(true)}>
              Replace it
            </Button>
          )}
          <Button variant="primary" disabled={busy || !connected} onClick={() => void publish(false)}>
            {busy ? "Publishing…" : "Publish skill"}
          </Button>
        </Stack>
      </Stack>
    </Stack>
  );
}
