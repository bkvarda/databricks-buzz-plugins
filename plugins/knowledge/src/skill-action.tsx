// "Make this a skill" on a message's ⋯ menu. Buzz mounts a message action's
// component when the menu closes, in the message row, so the editor opens in
// a top-layer modal that the row can't clip. It's prefilled from the message
// and uses the same editor as the draft card.
import { React } from "@dbx/core/react";
import { type DatabricksService, useAsync } from "@dbx/core/service";
import type { SkillCatalog } from "@dbx/core/skill-catalog";
import { Modal, Spinner, Stack, Text } from "@dbx/core/ui/components";
import { draftFromText, type SkillDraft } from "./skill-draft";
import { SkillEditor } from "./skill-card";

/** The fields of a Buzz channel message this action reads. */
type MessageLike = Readonly<{ id: string; channelId: string; content: string }>;

export const hasText = (message: MessageLike) => message.content.trim().length > 0;

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
