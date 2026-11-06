// The databricks-page card: a page draft an agent posted (or a message someone
// wants as a page), with a preview and "Add as draft". Adding is the person's
// own action in Pages; agents only ever post the block.
import { Domains, domainName, domainTitle } from "@dbx/core/api/domains";
import { Pages } from "@dbx/core/api/pages";
import { CHANNEL_TAG, DOMAIN_TAG } from "@dbx/core/api/tags";
import { React } from "@dbx/core/react";
import type { MessageAction } from "@buzz/author";
import { type DatabricksService, describeError, useAsync } from "@dbx/core/service";
import type { SkillCatalog } from "@dbx/core/skill-catalog";
import { Button, Card, DbxRoot, Field, Modal, Notice, Spinner, Stack, Text } from "@dbx/core/ui/components";
import { Markdown } from "@dbx/core/ui/markdown";
import { addDraft, type DraftResult, PAGE_WARNING, PAGES_OFF, type PageBlock, pageBlockCode, parsePageBlock, titleFrom } from "./page-draft";
import { SearchList } from "./picker";

/** Drafts added from this device, by block text, so a reopened card says so. */
const added = new Map<string, DraftResult>();

export function PageDraftCard(props: { service: DatabricksService; code: string; block: PageBlock; onClose?(): void }) {
  const { service, code, block } = props;
  const [, refresh] = React.useState(0);
  const saved = added.get(code);
  const id = React.useId();
  const [title, setTitle] = React.useState(block.title);
  const [target, setTarget] = React.useState<"new" | "existing">(block.page ? "existing" : "new");
  const [page, setPage] = React.useState(block.page ?? "");
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string>();

  const pagesOn = useAsync(async () => new Pages(await service.ready()).available(), []);
  const available = pagesOn.data;
  const pages = useAsync(
    async (signal) => (available ? new Pages(await service.ready()).list({ domain: block.domain, signal }) : []),
    [available, block.domain],
  );
  const domain = useAsync(async () => {
    if (block.domain_title) return block.domain_title;
    try {
      return domainTitle(await new Domains(await service.ready()).get(block.domain));
    } catch {
      return block.domain.replace(/^domains\//, "");
    }
  }, [block.domain, block.domain_title]);
  const domainLabel = domain.data ?? block.domain_title ?? block.domain.replace(/^domains\//, "");

  const add = async () => {
    setBusy(true);
    setError(undefined);
    try {
      const client = await service.ready();
      const result = await addDraft(client, { ...block, title: title.trim() || block.title }, target === "existing" ? { page } : {}, crypto.randomUUID());
      added.set(code, result);
      refresh((n) => n + 1);
    } catch (failure) {
      setError(describeError(failure));
    } finally {
      setBusy(false);
    }
  };

  return (
    <DbxRoot>
      <Card padding={14}>
        <Stack gap={12}>
          <Stack gap={2}>
            <Text size="xs" tone="subtle">
              Databricks page draft · {domainLabel}
            </Text>
            {saved ? (
              <Text as="h3" size="md" weight={500}>
                {saved.title}
              </Text>
            ) : (
              <Field label="Title" id={`${id}-title`}>
                <input id={`${id}-title`} className="dbx-input" value={title} onChange={(event) => setTitle(event.target.value)} />
              </Field>
            )}
          </Stack>

          <div style={{ maxHeight: 320, overflow: "auto", minWidth: 0 }}>
            <Markdown source={block.body} size="sm" />
          </div>

          {saved && (
            <Notice tone="success" title="Added as a draft">
              {saved.mode === "created" ? `New draft page “${saved.title}”.` : `Added to “${saved.title}”.`} Publishing happens in Databricks.
            </Notice>
          )}

          {!saved && pagesOn.loading && <Spinner label="Checking Pages" />}
          {!saved && available === false && <Notice title="Pages is off">{PAGES_OFF}</Notice>}
          {!saved && pagesOn.error && <Notice tone="warning">Couldn't check Pages: {describeError(pagesOn.error)}</Notice>}

          {!saved && available && (
            <Stack gap={10}>
              <Stack gap={6}>
                <Text size="sm" weight={500}>
                  Where it goes
                </Text>
                <label style={{ display: "flex", gap: 8, alignItems: "center", cursor: "pointer" }}>
                  <input type="radio" name={`${id}-target`} checked={target === "new"} onChange={() => setTarget("new")} />
                  <Text size="sm">New draft page</Text>
                </label>
                <label style={{ display: "flex", gap: 8, alignItems: "center", cursor: "pointer" }}>
                  <input type="radio" name={`${id}-target`} checked={target === "existing"} onChange={() => setTarget("existing")} />
                  <Text size="sm">Add to an existing page</Text>
                </label>
              </Stack>
              {target === "existing" && (
                <>
                  {pages.loading && <Spinner label="Loading pages" />}
                  {pages.error && <Notice tone="warning">Couldn't list pages: {describeError(pages.error)}</Notice>}
                  {pages.data && (
                    <SearchList
                      label="Pages"
                      placeholder="Search pages"
                      emptyText="No draft pages in this domain yet."
                      value={page}
                      onPick={setPage}
                      choices={pages.data.map((item) => ({
                        id: item.name,
                        label: item.display_name,
                        detail: item.state === "PUBLISHED" ? "Published" : "Draft",
                        disabled: item.state === "PUBLISHED",
                      }))}
                    />
                  )}
                </>
              )}
              <Text size="xs" tone="subtle">
                {PAGE_WARNING}
              </Text>
              {error && <Notice tone="danger">{error}</Notice>}
              <Stack direction="row" gap={8} align="center">
                <Button variant="brand" disabled={busy || (target === "existing" && !page) || !title.trim()} onClick={() => void add()}>
                  {busy ? "Adding…" : "Add as draft"}
                </Button>
                {props.onClose && <Button onClick={props.onClose}>Close</Button>}
              </Stack>
            </Stack>
          )}
          {saved && props.onClose && (
            <Stack direction="row">
              <Button onClick={props.onClose}>Close</Button>
            </Stack>
          )}
        </Stack>
      </Card>
    </DbxRoot>
  );
}

/** The ```databricks-page code block: a card when it's a valid draft, the code when it isn't. */
export function pageCodeBlock(service: DatabricksService) {
  return function PageCodeBlock({ code }: { code: string; language: string }) {
    const block = parsePageBlock(code);
    if (!block)
      return (
        <DbxRoot>
          <Notice tone="warning" title="This page draft isn't valid">
            It needs a title, a body and a domain. Ask for the draft again.
          </Notice>
        </DbxRoot>
      );
    return <PageDraftCard service={service} code={code} block={block} />;
  };
}

/** The channel's domain, from the catalog's cached state. Starts a load when there's none yet. */
export function linkedDomainId(catalog: SkillCatalog, channelId: string): string | undefined {
  // Deferred: this runs while Buzz renders the menu, and a load updates the catalog.
  if (catalog.snapshot().status !== "loading") queueMicrotask(() => void catalog.load());
  return catalog.snapshot().schemas.find((schema) => schema.tags[CHANNEL_TAG] === channelId)?.tags[DOMAIN_TAG] || undefined;
}

/** A message as Buzz passes it to a message action. */
type Message = Parameters<MessageAction["matches"]>[0];

/** "Add to page" in a message's menu, for messages in a channel that's linked to a domain. */
export function addToPageAction(service: DatabricksService, catalog: SkillCatalog) {
  return {
    id: "add-to-page",
    title: "Add to page",
    matches: (message: Message) => message.content.trim().length > 0 && !!linkedDomainId(catalog, message.channelId),
    component: function AddToPage({ message, close }: { message: Message; close(): void }) {
      const domainId = linkedDomainId(catalog, message.channelId);
      // Mounted when the ⋯ menu closes, in the message row: a top-layer modal the row can't clip.
      if (!domainId)
        return (
          <Modal title="Add to page" onClose={close}>
            <Notice>This channel isn't linked to a domain any more.</Notice>
          </Modal>
        );
      const block: PageBlock = { title: titleFrom(message.content), body: message.content, domain: domainName(domainId) };
      return (
        <Modal title="Add to page" onClose={close}>
          <PageDraftCard service={service} code={pageBlockCode(block)} block={block} onClose={close} />
        </Modal>
      );
    },
  };
}
