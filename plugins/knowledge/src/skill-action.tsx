// "Make this a skill" on a message: a button in the message's hover toolbar
// (Buzz 0.7.13 and later), or an entry in its ⋯ menu on older Buzz, which
// ignores the toolbar placement. Buzz mounts the action's component in the
// message row, so the editor opens in a top-layer modal that the row can't
// clip. It's prefilled from the message and uses the same editor as the draft
// card.
import { React } from "@dbx/core/react";
import { type DatabricksService, useAsync } from "@dbx/core/service";
import type { SkillCatalog } from "@dbx/core/skill-catalog";
import { Modal, Spinner, Stack, Text } from "@dbx/core/ui/components";
import { draftFromText, type SkillDraft } from "./skill-draft";
import { SkillEditor } from "./skill-card";

/** The fields of a Buzz channel message this action reads. */
type MessageLike = Readonly<{ id: string; channelId: string; content: string }>;

export const hasText = (message: MessageLike) => message.content.trim().length > 0;

/** The toolbar button's icon: an open book with a plus, drawn in the text colour at the host's icon size. */
export function SkillIcon() {
  return (
    <svg viewBox="0 0 24 24" width="1em" height="1em" fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M12 9.5A2.5 2.5 0 0 0 9.5 7H3v11h6a3 3 0 0 1 3 3" />
      <path d="M12 9.5V21" />
      <path d="M12 21a3 3 0 0 1 3-3h6v-7.5" />
      <path d="M12 9.5A2.5 2.5 0 0 1 14.5 7h.5" />
      <path d="M19 1.5v5M16.5 4h5" />
    </svg>
  );
}

export function makeSkillAction(service: DatabricksService, catalog: SkillCatalog) {
  return function MakeSkill(props: { message: MessageLike; close(): void }) {
    const { message, close } = props;
    // The channel's skills schema, if it has one, is where the skill goes.
    const channel = useAsync(
      async () => (await catalog.channel(message.channelId).catch(() => undefined))?.schema,
      [message.channelId],
    );
    const initial: SkillDraft = { ...draftFromText(message.content), files: [], ...(channel.data && { schema: channel.data }) };
    return (
      <Modal title="Make this a skill" onClose={close}>
        {channel.loading ? (
          <Stack direction="row" gap={8} align="center">
            <Spinner size={12} />
            <Text tone="subtle" size="sm">
              Getting the channel's skills schema…
            </Text>
          </Stack>
        ) : (
          <SkillEditor storeKey={`message:${message.id}`} initial={initial} service={service} catalog={catalog} onClose={close} />
        )}
      </Modal>
    );
  };
}
