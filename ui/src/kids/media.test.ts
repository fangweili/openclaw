import { describe, expect, it } from "vitest";
import { projectKidsMedia } from "./media.ts";

describe("kids transcript media", () => {
  it("retains authorized upload identities without exposing their persisted paths", () => {
    const media = projectKidsMedia({
      role: "user",
      content: "Help with this experiment",
      __openclaw: {
        media: [
          {
            url: "media://inbound/private-photo",
            contentType: "image/png",
            kind: "image",
            fileName: "worksheet.png",
            artifactId: "artifact_transcript_media_photo",
          },
          {
            url: "media://inbound/private-video",
            contentType: "video/mp4",
            kind: "video",
            fileName: "experiment.mp4",
            hydrationSuppressed: true,
            artifactId: "artifact_transcript_media_video",
          },
        ],
      },
    });
    expect(media).toEqual([
      {
        id: "image-0",
        kind: "image",
        label: "worksheet.png",
        artifactId: "artifact_transcript_media_photo",
      },
      {
        id: "video-0",
        kind: "video",
        label: "experiment.mp4",
        artifactId: "artifact_transcript_media_video",
      },
    ]);
  });

  it("keeps optimistic media labels after their local preview is released", () => {
    const message = {
      role: "user",
      content: [
        { type: "image", url: "blob:private-photo", fileName: "page.png" },
        {
          type: "attachment",
          attachment: {
            url: "blob:private-video",
            kind: "video",
            mimeType: "video/mp4",
            label: "clip.mp4",
          },
        },
      ],
    };
    expect(projectKidsMedia(message)).toEqual([
      { id: "image-0", kind: "image", label: "page.png" },
      { id: "video-0", kind: "video", label: "clip.mp4" },
    ]);
  });

  it("retains opaque generated artifact IDs but never inline bytes, remote URLs, or unrelated attachments", () => {
    expect(
      projectKidsMedia({
        role: "assistant",
        content: [
          {
            type: "image",
            artifactId: "private-artifact",
            data: "secret-bytes",
            mimeType: "image/png",
            fileName: "answer.png",
          },
          { type: "image", url: "https://outside.example/tracker.png", alt: "A diagram" },
          {
            type: "attachment",
            attachment: { url: "/private/document", kind: "document", label: "Private document" },
          },
        ],
      }),
    ).toEqual([
      { id: "image-0", kind: "image", label: "answer.png", artifactId: "private-artifact" },
      { id: "image-1", kind: "image", label: "A diagram" },
    ]);
  });

  it("preserves the canonical fact artifact when a hydrated inline image occupies its position", () => {
    const media = projectKidsMedia({
      role: "user",
      content: [{ type: "image", url: "media://inbound/photo", fileName: "page.png" }],
      __openclaw: {
        media: [
          {
            url: "media://inbound/photo",
            kind: "image",
            contentType: "image/png",
            artifactId: "artifact_transcript_media_page",
          },
        ],
      },
    });
    expect(media).toEqual([
      {
        id: "image-0",
        kind: "image",
        label: "page.png",
        artifactId: "artifact_transcript_media_page",
      },
    ]);
  });
});
