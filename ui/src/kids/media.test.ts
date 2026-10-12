import { describe, expect, it } from "vitest";
import { projectKidsMedia } from "./media.ts";

describe("kids transcript media", () => {
  it("shows uploaded photo and video labels from canonical persisted facts without exposing references", () => {
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
          },
          {
            url: "media://inbound/private-video",
            contentType: "video/mp4",
            kind: "video",
            fileName: "experiment.mp4",
            hydrationSuppressed: true,
          },
        ],
      },
    });
    expect(media).toEqual([
      { id: "image-0", kind: "image", label: "worksheet.png" },
      { id: "video-0", kind: "video", label: "experiment.mp4" },
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

  it("does not turn inline bytes, remote images, artifacts, or unrelated attachments into read capabilities", () => {
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
      { id: "image-0", kind: "image", label: "answer.png" },
      { id: "image-1", kind: "image", label: "A diagram" },
    ]);
  });
});
