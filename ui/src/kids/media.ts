/**
 * Kids media presentation retains labels and opaque artifact identities from
 * the shared transcript projector. Browser sources come only from authorized
 * artifact downloads; transcript paths, URLs, and inline bytes never escape.
 */
import { t } from "../i18n/index.ts";
import { normalizeMessage } from "../lib/chat/message-normalizer.ts";
import { projectMessageMedia } from "../pages/chat/components/chat-message-media.ts";

export type KidsMedia = {
  id: string;
  kind: "image" | "video";
  label: string;
  artifactId?: string;
};

/** Project display facts; the download owner must authorize every artifact in the current session. */
export function projectKidsMedia(message: unknown): KidsMedia[] {
  const { images, attachments } = projectMessageMedia(message, normalizeMessage(message).content);
  return [
    ...images.map((image, index): KidsMedia => ({
      id: `image-${index}`,
      kind: "image",
      label: image.fileName?.trim() || image.alt?.trim() || t("kids.media.photo"),
      artifactId: image.artifactId,
    })),
    ...attachments.flatMap((item, index): KidsMedia[] =>
      item.type === "attachment" && item.attachment.kind === "video"
        ? [
            {
              id: `video-${index}`,
              kind: "video",
              label: item.attachment.label.trim() || t("kids.media.video"),
              artifactId: item.attachment.artifactId,
            },
          ]
        : [],
    ),
  ];
}
