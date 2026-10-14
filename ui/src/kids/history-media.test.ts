import { html, render } from "lit";
// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { downloadArtifact } from "../api/artifact-download.ts";
import type { GatewayBrowserClient } from "../api/gateway.ts";
import { registerKidsEnglish } from "../i18n/locales/en-kids.ts";
import { kidsMediaPreview } from "./history-media-view.ts";
import { KidsHistoryMedia, type KidsMediaPreview } from "./history-media.ts";
import type { KidsMedia } from "./media.ts";

registerKidsEnglish();

vi.mock("../api/artifact-download.ts", async (original) => ({
  ...(await original<typeof import("../api/artifact-download.ts")>()),
  downloadArtifact: vi.fn(),
}));

const scope = {
  agentId: "student",
  sessionKey: "agent:student:kids:one",
  sessionId: "session-one",
};
const photo = {
  id: "image-0",
  kind: "image" as const,
  label: "Diagram",
  artifactId: "artifact_transcript_media_photo",
};
const imageResult = () => ({
  artifact: {
    id: photo.artifactId,
    type: "image",
    title: "Diagram",
    mimeType: "image/png",
    download: { mode: "bytes" as const },
  },
  blob: new Blob(["synthetic image"], { type: "image/png" }),
});

describe("kids history media view", () => {
  it("follows viewport leases, ignores retired observer callbacks, and renders native video controls", async () => {
    const observations: Array<{
      callback: IntersectionObserverCallback;
      target?: Element;
      disconnect: () => void;
    }> = [];
    vi.stubGlobal(
      "IntersectionObserver",
      class {
        private item: (typeof observations)[number];
        constructor(callback: IntersectionObserverCallback) {
          this.item = { callback, disconnect: vi.fn() };
          observations.push(this.item);
        }
        observe(target: Element) {
          this.item.target = target;
        }
        disconnect() {
          this.item.disconnect();
        }
      },
    );
    const visible = (index: number, isIntersecting: boolean) => {
      const observation = observations[index]!;
      observation.callback(
        [{ target: observation.target!, isIntersecting } as IntersectionObserverEntry],
        {} as IntersectionObserver,
      );
    };
    const result = Promise.resolve(imageResult());
    vi.mocked(downloadArtifact).mockReturnValue(result);
    const { owner } = fixture();
    const root = document.createElement("div");
    const draw = (media: KidsMedia = photo) =>
      render(html`<figure>${kidsMediaPreview(owner, media, owner.generation)}</figure>`, root);
    try {
      draw();
      expect(downloadArtifact).not.toHaveBeenCalled();
      visible(0, true);
      await result;
      expect(root.querySelector("img")?.getAttribute("src")).toBe("blob:authorized-image");
      visible(0, false);
      expect(root.querySelector("img")).toBeNull();
      owner.disconnect();
      owner.bind({ ...scope, sessionId: "replacement-session" });
      const video = Promise.resolve({
        artifact: {
          id: "clip",
          type: "video",
          title: "Experiment",
          mimeType: "video/mp4",
          download: { mode: "bytes" as const },
        },
        url: "/api/artifacts/download/connection/ticket",
      });
      vi.mocked(downloadArtifact).mockReturnValue(video);
      draw({ ...photo, kind: "video" });
      expect(observations[0]!.disconnect).toHaveBeenCalled();
      visible(0, true);
      expect(downloadArtifact).toHaveBeenCalledTimes(1);
      visible(1, true);
      await video;
      const element = root.querySelector("video")!;
      expect(element.controls).toBe(true);
      expect(element.preload).toBe("none");
      expect(element.autoplay).toBe(false);
      expect(element.hasAttribute("playsinline")).toBe(true);
      element.dispatchEvent(new Event("error"));
      expect(root.querySelector("video")).toBeNull();
      expect(root.querySelector("button")?.textContent).toBe("Try again");
      expect(downloadArtifact).toHaveBeenCalledTimes(2);
      render(null, root);
      visible(1, true);
      expect(downloadArtifact).toHaveBeenCalledTimes(2);
      expect(observations[1]!.disconnect).toHaveBeenCalled();
    } finally {
      render(null, root);
    }
  });
});
const owners: KidsHistoryMedia[] = [];
const createObjectUrl = vi.fn(() => "blob:authorized-image");
const revokeObjectUrl = vi.fn();

function fixture() {
  const owner = new KidsHistoryMedia({} as GatewayBrowserClient);
  owners.push(owner);
  owner.bind(scope);
  const states: KidsMediaPreview[] = [];
  const lease = owner.acquire(photo, (state) => states.push(state));
  return { owner, lease, states };
}

beforeEach(() => {
  vi.mocked(downloadArtifact).mockReset();
  createObjectUrl.mockClear();
  revokeObjectUrl.mockClear();
  vi.stubGlobal("location", new URL("https://school.example/kids/"));
  vi.stubGlobal(
    "URL",
    class extends URL {
      static override createObjectURL = createObjectUrl;
      static override revokeObjectURL = revokeObjectUrl;
    },
  );
});

afterEach(async () => {
  await Promise.all(owners.splice(0).map((owner) => owner.dispose()));
  vi.unstubAllGlobals();
});

describe("kids history media owner", () => {
  it("loads only visible authorized photos and releases their source offscreen before reopening", async () => {
    const result = Promise.resolve(imageResult());
    vi.mocked(downloadArtifact).mockReturnValue(result);
    const { owner, lease, states } = fixture();
    expect(downloadArtifact).not.toHaveBeenCalled();
    lease.setVisible(true);
    await result;
    expect(downloadArtifact).toHaveBeenCalledWith(
      expect.objectContaining({ connected: true }),
      { sessionKey: scope.sessionKey, agentId: scope.agentId, artifactId: photo.artifactId },
      expect.any(AbortSignal),
    );
    expect(states.at(-1)).toEqual({ status: "ready", url: "blob:authorized-image" });
    lease.setVisible(false);
    expect(revokeObjectUrl).toHaveBeenCalledWith("blob:authorized-image");
    expect(states.at(-1)).toEqual({ status: "idle" });
    owner.disconnect();
    owner.bind(scope);
    const next = owner.acquire(photo, (state) => states.push(state));
    next.setVisible(true);
    await result;
    expect(downloadArtifact).toHaveBeenCalledTimes(2);
    expect(states.at(-1)?.status).toBe("ready");
  });

  it("bounds reads to two and drops queued media that leaves the viewport", async () => {
    const pending = [
      Promise.withResolvers<ReturnType<typeof imageResult>>(),
      Promise.withResolvers<ReturnType<typeof imageResult>>(),
    ];
    vi.mocked(downloadArtifact)
      .mockReturnValueOnce(pending[0]!.promise)
      .mockReturnValueOnce(pending[1]!.promise);
    const { owner, lease } = fixture();
    lease.setVisible(true);
    owner.acquire({ ...photo, artifactId: "second" }, () => {}).setVisible(true);
    const third = owner.acquire({ ...photo, artifactId: "third" }, () => {});
    third.setVisible(true);
    expect(downloadArtifact).toHaveBeenCalledTimes(2);
    third.setVisible(false);
    pending.forEach((read) => read.resolve(imageResult()));
    await Promise.all(pending.map((read) => read.promise));
    expect(downloadArtifact).toHaveBeenCalledTimes(2);
  });

  it.each(["disconnect", "rebind", "dispose"] as const)(
    "fences late completions after %s and joins disposal",
    async (action) => {
      const pending = Promise.withResolvers<ReturnType<typeof imageResult>>();
      vi.mocked(downloadArtifact).mockReturnValue(pending.promise);
      const { owner, lease, states } = fixture();
      lease.setVisible(true);
      const signal = vi.mocked(downloadArtifact).mock.calls[0]![2]!;
      let disposed = false;
      const closing =
        action === "dispose"
          ? owner.dispose().then(() => {
              disposed = true;
            })
          : undefined;
      if (action === "disconnect") {
        owner.disconnect();
      }
      if (action === "rebind") {
        owner.bind({
          agentId: "other",
          sessionKey: "agent:other:kids:two",
          sessionId: "session-two",
        });
      }
      expect(signal.aborted).toBe(true);
      expect(disposed).toBe(false);
      pending.resolve(imageResult());
      await pending.promise;
      await closing;
      expect(states.some((state) => state.status === "ready")).toBe(false);
      expect(createObjectUrl).not.toHaveBeenCalled();
      lease.setVisible(false);
      lease.setVisible(true);
      expect(downloadArtifact).toHaveBeenCalledTimes(1);
      if (action === "dispose") {
        expect(disposed).toBe(true);
      }
    },
  );

  it("uses a validated video grant without fetching video bytes and retries only on request", async () => {
    const result = Promise.resolve({
      artifact: {
        id: "clip",
        type: "video",
        title: "Experiment",
        mimeType: "video/mp4",
        download: { mode: "bytes" as const },
      },
      url: "/api/artifacts/download/connection/ticket",
    });
    vi.mocked(downloadArtifact).mockReturnValue(result);
    const { owner } = fixture();
    const states: KidsMediaPreview[] = [];
    const lease = owner.acquire({ ...photo, kind: "video", artifactId: "clip" }, (state) =>
      states.push(state),
    );
    lease.setVisible(true);
    await result;
    expect(states.at(-1)).toEqual({
      status: "ready",
      url: "/api/artifacts/download/connection/ticket",
    });
    expect(createObjectUrl).not.toHaveBeenCalled();
    lease.failed();
    expect(states.at(-1)).toEqual({ status: "error" });
    expect(downloadArtifact).toHaveBeenCalledTimes(1);
    lease.retry();
    await result;
    expect(downloadArtifact).toHaveBeenCalledTimes(2);
    expect(states.at(-1)?.status).toBe("ready");
  });

  it.each([
    [
      "image",
      "image/png",
      "/api/chat/media/outgoing/agent%3Astudent%3Akids%3Aone/diagram/full?mediaTicket=synthetic",
    ],
    [
      "video",
      "video/mp4",
      "/api/chat/media/outgoing/agent%3Astudent%3Akids%3Aone/clip/full?mediaTicket=synthetic",
    ],
    ["image", "image/png", "/api/artifacts/download/connection/ticket"],
  ] as const)(
    "renders authorized %s URL delivery from the artifact owner",
    async (kind, mimeType, url) => {
      const result = Promise.resolve({
        artifact: { ...imageResult().artifact, type: kind, mimeType },
        url,
      });
      vi.mocked(downloadArtifact).mockReturnValue(result);
      const { owner } = fixture();
      const states: KidsMediaPreview[] = [];
      owner.acquire({ ...photo, kind }, (state) => states.push(state)).setVisible(true);
      await result;
      expect(states.at(-1)).toEqual({ status: "ready", url });
      expect(createObjectUrl).not.toHaveBeenCalled();
    },
  );

  it("rejects arbitrary returned video URLs and non-raster image content", async () => {
    const result = Promise.resolve({
      artifact: {
        id: "bad",
        type: "video",
        title: "Rejected",
        mimeType: "video/mp4",
        download: { mode: "url" as const },
      },
      url: "https://outside.example/tracker",
    });
    vi.mocked(downloadArtifact).mockReturnValue(result);
    const { owner } = fixture();
    const states: KidsMediaPreview[] = [];
    owner.acquire({ ...photo, kind: "video" }, (state) => states.push(state)).setVisible(true);
    await result;
    expect(states.at(-1)).toEqual({ status: "error" });
    const svg = Promise.resolve({
      ...imageResult(),
      artifact: { ...imageResult().artifact, mimeType: "image/svg+xml" },
    });
    vi.mocked(downloadArtifact).mockReturnValue(svg);
    owner.acquire(photo, (state) => states.push(state)).setVisible(true);
    await svg;
    expect(states.at(-1)).toEqual({ status: "error" });
    expect(createObjectUrl).not.toHaveBeenCalled();
  });
});
