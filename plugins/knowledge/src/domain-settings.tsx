// Settings: the channels linked to domains, whether Pages is on, and who can
// do what. Linking happens from a channel's menu, not here.
import { type Domain, Domains, domainTitle } from "@dbx/core/api/domains";
import { Pages } from "@dbx/core/api/pages";
import { CHANNEL_TAG, DOMAIN_TAG, SKILLS_TAG } from "@dbx/core/api/tags";
import { React } from "@dbx/core/react";
import { type DatabricksService, describeError, isApiError, useAsync, useConnection } from "@dbx/core/service";
import type { SkillCatalog } from "@dbx/core/skill-catalog";
import { Button, Card, DbxRoot, Notice, SectionHeader, Spinner, Stack, Text } from "@dbx/core/ui/components";
import { PAGES_OFF } from "./page-draft";
import { useCatalogState } from "./channel-panel";

export function DomainSettings(props: { service: DatabricksService; catalog: SkillCatalog }) {
  const { service, catalog } = props;
  const connection = useConnection(service);
  const state = useCatalogState(catalog);
  const connected = connection.status === "connected";

  React.useEffect(() => {
    if (connected) void catalog.load();
  }, [connected]);

  const domains = useAsync(async (): Promise<{ list?: Domain[]; error?: string }> => {
    try {
      return { list: await new Domains(await service.ready()).list() };
    } catch (failure) {
      return { error: isApiError(failure) && failure.isPermission ? "Listing domains needs the MANAGE DISCOVERY permission." : describeError(failure) };
    }
  }, [connected]);
  const pagesOn = useAsync(async () => (connected ? new Pages(await service.ready()).available() : false), [connected]);

  if (!connected) return <Notice>Connect Databricks to see which channels are linked to domains.</Notice>;

  const linked = state.schemas.filter((schema) => schema.tags[CHANNEL_TAG]);
  const titleOf = (id: string | undefined) => {
    if (!id) return "No domain";
    const domain = domains.data?.list?.find((item) => (item.domain_id ?? item.name.replace(/^domains\//, "")) === id);
    return domain ? domainTitle(domain) : id;
  };

  return (
    <DbxRoot>
      <Stack gap={12}>
        <SectionHeader
          title="Channels and domains"
          description="Each channel links to one domain and one skills schema. Link a channel from its menu: Set up Databricks."
          action={
            <Button size="sm" variant="ghost" onClick={() => void catalog.load(true)}>
              Refresh
            </Button>
          }
        />
        {state.status === "loading" && <Spinner label="Looking for linked channels" />}
        {state.note && <Notice tone="warning">{state.note}</Notice>}
        {linked.length ? (
          <Card padding={0}>
            {linked.map((schema, index) => (
              <div
                key={schema.schema}
                style={{ padding: "10px 14px", borderTop: index ? "1px solid var(--dbx-border)" : undefined, display: "flex", flexDirection: "column", gap: 2 }}
              >
                <Text size="sm" weight={500}>
                  #{schema.tags[SKILLS_TAG] || schema.tags[CHANNEL_TAG]}
                </Text>
                <Text size="xs" tone="subtle">
                  {titleOf(schema.tags[DOMAIN_TAG])} · {schema.schema}
                </Text>
              </div>
            ))}
          </Card>
        ) : (
          state.status !== "loading" && (
            <Text tone="subtle" size="sm">
              No channels are linked yet.
            </Text>
          )
        )}
        {domains.data?.error && <Notice tone="warning">{domains.data.error} Domains show by ID here.</Notice>}

        <Stack gap={6}>
          <Text size="sm" weight={500}>
            Pages
          </Text>
          <Text size="sm" tone="subtle">
            {pagesOn.loading ? "Checking…" : pagesOn.data ? "Pages is on. Drafts go in from a channel's messages or agent drafts." : PAGES_OFF}
          </Text>
        </Stack>

        <Stack gap={4}>
          <Text size="sm" weight={500}>
            Who can do what
          </Text>
          <Text size="sm" tone="subtle">
            Domains: listing needs MANAGE DISCOVERY. Creating one also needs its governed tag policy.
          </Text>
          <Text size="sm" tone="subtle">
            Schemas: creating one needs CREATE SCHEMA on the catalog. Tagging needs APPLY TAG.
          </Text>
          <Text size="sm" tone="subtle">
            Pages: anyone who can see a domain can add a draft. Publishing needs Page Manager or Domain Admin.
          </Text>
        </Stack>
      </Stack>
    </DbxRoot>
  );
}
