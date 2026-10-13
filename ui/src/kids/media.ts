/**
 * Kids media presentation admits only metadata from the shared transcript
 * projector. Paths, remote URLs, and inline bytes never become browser sources.
 * Upload previews remain owned by the in-memory draft; accepted history shows
 * the supplied media labels without opening a separate filesystem read surface.
 */
import { t } from "../i18n/index.ts";
import { normalizeMessage } from "../lib/chat/message-normalizer.ts";
import { projectMessageMedia } from "../pages/chat/components/chat-message-media.ts";

export type KidsMedia = {
  id: string;
  kind: "image" | "video";
  label: string;
};

/** Project media labels without exposing filesystem paths, network locations, or inline bytes. */
export function projectKidsMedia(message: unknown): KidsMedia[] {
  const { images, attachments } = projectMessageMedia(message, normalizeMessage(message).content);
  return [
    ...images.map((image, index): KidsMedia => ({
      id: `image-${index}`,
      kind: "image",
      label: image.fileName?.trim() || image.alt?.trim() || t("kids.media.photo"),
    })),
    ...attachments.flatMap((item, index): KidsMedia[] =>
      item.type === "attachment" && item.attachment.kind === "video"
        ? [
            {
              id: `video-${index}`,
              kind: "video",
              label: item.attachment.label.trim() || t("kids.media.video"),
            },
          ]
        : [],
    ),
  ];
}
