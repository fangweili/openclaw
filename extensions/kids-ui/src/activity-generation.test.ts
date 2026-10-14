import { mkdir, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { useAutoCleanupTempDirTracker } from "openclaw/plugin-sdk/test-env";
import { optimizeImageToPng } from "openclaw/plugin-sdk/web-media";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { DailyActivityBundle } from "./activity-contract.js";
import {
  createActivityGeneration,
  type ActivityDailyPreparation,
  type ActivityGenerationChild,
  type ActivityGenerationOptions,
} from "./activity-generation.js";

vi.mock("openclaw/plugin-sdk/web-media", () => ({ optimizeImageToPng: vi.fn() }));

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
afterEach(() => vi.useRealTimers());
const child: ActivityGenerationChild = {
  childId: "child-one",
  agentId: "tutor-one",
  sessionKey: "agent:tutor-one:kids:profile-one",
  timeZone: "America/Chicago",
  preparationJobId: "prepare-one",
};
const sibling: ActivityGenerationChild = {
  ...child,
  childId: "child-two",
  agentId: "tutor-two",
  sessionKey: "agent:tutor-two:kids:profile-two",
  preparationJobId: "prepare-two",
};
const input: ActivityDailyPreparation = {
  date: "2026-10-14",
  activities: [1, 2, 3].map((index) => ({
    id: `activity-${index}`,
    title: "A tiny boat",
    subject: "science",
    questions: [1, 2, 3].map((n) => ({
      id: `q${n}`,
      prompt: "Which object floats?",
      options: [
        { id: "a", text: "A cork" },
        { id: "b", text: "A coin" },
      ],
      correctOptionId: "a",
      hint: "Think of a light cork.",
      explanation: "Cork is less dense than water.",
    })),
  })),
  normalPrompt: "Rocky builds a leaf boat after a conversation about floating objects.",
  excitedPrompt: "Rocky raises its arms beside the same boat.",
  boredPrompt: "Rocky rests its chin in its hands beside the little leaf boat.",
  sleepingPrompt: "Rocky curls up peacefully beside the leaf boat.",
  normalCaption: "Ready to launch?",
  excitedCaption: "We figured it out!",
  boredCaption: "Watching the little waves.",
  sleepingCaption: "Dreaming of little boats.",
};
type Runtime = ActivityGenerationOptions["api"]["runtime"];
type GenerationResult = Awaited<ReturnType<Runtime["imageGeneration"]["generate"]>>;
function image(value: string): GenerationResult {
  return {
    provider: "fixture",
    model: "image",
    images: [{ buffer: Buffer.from(value), mimeType: "image/png" }],
    attempts: [],
    ignoredOverrides: [],
  };
}

async function harness() {
  const dir = tempDirs.make("kids-activity-art-");
  const references = path.join(dir, "references");
  await mkdir(references);
  for (const state of ["reference", "bored", "sleeping"]) {
    await writeFile(path.join(references, `rocky-${state}.webp`), `fixed-${state}`);
  }
  const published = new Map<string, DailyActivityBundle>();
  const generate = vi
    .fn<Runtime["imageGeneration"]["generate"]>()
    .mockResolvedValueOnce(image("normal"))
    .mockResolvedValueOnce(image("excited"))
    .mockResolvedValueOnce(image("bored"))
    .mockResolvedValueOnce(image("sleeping"));
  const publish = vi.fn<ActivityGenerationOptions["store"]["publish"]>(async (bundle, guard) => {
    guard();
    published.set(bundle.date, bundle);
    return { published: true };
  });
  const findDaily = vi.fn<ActivityGenerationOptions["store"]["findDaily"]>(
    async (_child, date, guard) => {
      guard();
      return published.get(date) ?? null;
    },
  );
  const config = {};
  const optimize = vi
    .mocked(optimizeImageToPng)
    .mockReset()
    .mockImplementation(async (buffer) => ({
      buffer,
      optimizedSize: buffer.length,
      resizeSide: 1280,
      compressionLevel: 6,
    }));
  const owner = createActivityGeneration({
    api: {
      runtime: {
        config: { current: () => config },
        imageGeneration: { generate },
      },
    },
    children: [child, sibling],
    mediaRoot: path.join(dir, "images"),
    referenceRoot: references,
    store: { findDaily, publish },
    now: () => Date.parse("2026-10-14T12:00:00Z"),
  });
  return { owner, generate, published, publish, findDaily, optimize, config, dir };
}

describe("daily pet artwork owner", () => {
  it("rejects a malformed quiz before spending on image generation", async () => {
    const h = await harness();
    const malformed = structuredClone(input);
    malformed.activities[0]!.questions[0]!.correctOptionId = "missing-option";
    await expect(
      h.owner.prepareDaily(child.childId, malformed, { assertCurrent() {} }),
    ).rejects.toThrow("correct answer");
    expect(h.generate).not.toHaveBeenCalled();
    expect(h.publish).not.toHaveBeenCalled();
    await h.owner.close();
  });

  it("rejects incomplete or duplicate three-by-three batches before provider calls", async () => {
    const h = await harness();
    const missing = structuredClone(input);
    missing.activities.pop();
    const extraQuestion = structuredClone(input);
    extraQuestion.activities[0]!.questions.push(extraQuestion.activities[0]!.questions[0]!);
    const duplicate = structuredClone(input);
    duplicate.activities[1]!.id = duplicate.activities[0]!.id;
    for (const malformed of [missing, extraQuestion, duplicate]) {
      await expect(
        h.owner.prepareDaily(child.childId, malformed, { assertCurrent() {} }),
      ).rejects.toThrow();
    }
    expect(h.generate).not.toHaveBeenCalled();
    expect(h.publish).not.toHaveBeenCalled();
    await h.owner.close();
  });

  it("uses the canonical pet then exact normal artwork, publishes once, and scopes image reads", async () => {
    const h = await harness();
    const authority = { assertCurrent: vi.fn() };
    await expect(h.owner.prepareDaily(child.childId, input, authority)).resolves.toEqual({
      published: true,
      date: input.date,
    });
    expect(h.generate).toHaveBeenCalledTimes(4);
    expect(h.generate.mock.calls[0]?.[0]).toMatchObject({
      cfg: h.config,
      count: 1,
      outputFormat: "png",
      background: "transparent",
      inputImages: [{ buffer: Buffer.from("fixed-reference"), mimeType: "image/webp" }],
    });
    expect(h.generate.mock.calls[0]?.[0]).not.toHaveProperty("modelOverride");
    for (const [request] of h.generate.mock.calls.slice(1)) {
      expect(request.inputImages?.[0]?.buffer).toEqual(Buffer.from("normal"));
      expect(request).toMatchObject({ outputFormat: "png", background: "transparent" });
    }
    const bundle = h.published.get(input.date)!;
    expect(bundle.stateText).toEqual({
      bored: input.boredCaption,
      sleeping: input.sleepingCaption,
    });
    expect(bundle.activities).toEqual(input.activities);
    expect(bundle.scenePrompt).toBe(input.normalPrompt);
    expect(h.optimize).toHaveBeenCalledTimes(4);
    expect(h.optimize).toHaveBeenCalledWith(Buffer.from("normal"), 512 * 1024, {
      sides: [1280, 1024, 768, 512],
    });
    await expect(
      h.owner.readImage(child.childId, bundle.scene.normal.imageId, () => {}),
    ).resolves.toEqual({
      mimeType: "image/png",
      base64: Buffer.from("normal").toString("base64"),
    });
    await expect(
      h.owner.readImage(sibling.childId, bundle.scene.normal.imageId, () => {}),
    ).rejects.toThrow();
    for (const mood of ["bored", "sleeping"] as const) {
      await expect(
        h.owner.readImage(child.childId, bundle.restImages![mood]!, () => {}),
      ).resolves.toEqual({
        mimeType: "image/png",
        base64: Buffer.from(mood).toString("base64"),
      });
      await expect(
        h.owner.readImage(sibling.childId, bundle.restImages![mood]!, () => {}),
      ).rejects.toThrow();
    }
    await expect(h.owner.readImage(child.childId, "../../secret", () => {})).rejects.toThrow(
      "unavailable",
    );
    for (const state of ["reference", "bored", "sleeping"]) {
      for (const binding of [child, sibling]) {
        await expect(h.owner.readImage(binding.childId, state, () => {})).resolves.toEqual({
          mimeType: "image/webp",
          base64: Buffer.from(`fixed-${state}`).toString("base64"),
        });
      }
    }
    await expect(h.owner.prepareDaily(child.childId, input, authority)).resolves.toEqual({
      published: false,
      date: input.date,
    });
    expect(h.generate).toHaveBeenCalledTimes(4);
    await h.owner.close();
  });

  it("does not publish a partial pair or write files when the excited generation fails", async () => {
    const h = await harness();
    h.generate
      .mockReset()
      .mockResolvedValueOnce(image("normal"))
      .mockRejectedValueOnce(new Error("private provider failure"));
    await expect(
      h.owner.prepareDaily(child.childId, input, { assertCurrent() {} }),
    ).rejects.toThrow("private provider failure");
    expect(h.publish).not.toHaveBeenCalled();
    await expect(readdir(path.join(h.dir, "images"))).rejects.toMatchObject({ code: "ENOENT" });
    await h.owner.close();
  });

  it.each([{ failed: ["bored"] }, { failed: ["sleeping"] }, { failed: ["bored", "sleeping"] }])(
    "publishes ready challenges when optional renders fail: $failed",
    async ({ failed }) => {
      const h = await harness();
      h.generate
        .mockReset()
        .mockResolvedValueOnce(image("normal"))
        .mockResolvedValueOnce(image("excited"));
      for (const mood of ["bored", "sleeping"]) {
        if (failed.includes(mood)) {
          h.generate.mockRejectedValueOnce(new Error(`private ${mood} provider failure`));
        } else {
          h.generate.mockResolvedValueOnce(image(mood));
        }
      }
      await expect(
        h.owner.prepareDaily(child.childId, input, { assertCurrent() {} }),
      ).resolves.toEqual({
        published: true,
        date: input.date,
      });
      const bundle = h.published.get(input.date)!;
      expect(bundle.activities).toEqual(input.activities);
      for (const mood of ["bored", "sleeping"] as const) {
        expect(Boolean(bundle.restImages?.[mood])).toBe(!failed.includes(mood));
      }
      expect(h.publish).toHaveBeenCalledTimes(1);
      await h.owner.close();
    },
  );

  it("uses a fixed fallback for invalid optional image output without discarding its sibling", async () => {
    const h = await harness();
    h.optimize.mockImplementation(async (buffer) => ({
      buffer: buffer.toString() === "bored" ? Buffer.alloc(512 * 1024 + 1) : buffer,
      optimizedSize: buffer.length,
      resizeSide: 512,
      compressionLevel: 6,
    }));
    await h.owner.prepareDaily(child.childId, input, { assertCurrent() {} });
    expect(h.published.get(input.date)?.restImages).toEqual({ sleeping: expect.any(String) });
    await h.owner.close();
  });

  it.each([
    { outcome: "success", shutdown: false },
    { outcome: "failure", shutdown: false },
    { outcome: "success", shutdown: true },
  ])(
    "publishes fallbacks at the optional deadline, then joins late $outcome (shutdown=$shutdown)",
    async ({ outcome, shutdown }) => {
      const h = await harness();
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
      const entered = Promise.withResolvers<void>();
      const late = Promise.withResolvers<GenerationResult>();
      const publication = Promise.withResolvers<void>();
      h.generate
        .mockReset()
        .mockResolvedValueOnce(image("normal"))
        .mockResolvedValueOnce(image("excited"))
        .mockResolvedValueOnce(image("bored"))
        .mockImplementationOnce(() => {
          entered.resolve();
          return late.promise;
        });
      h.publish.mockImplementation(async (bundle, guard) => {
        guard();
        h.published.set(bundle.date, bundle);
        publication.resolve();
        return { published: true };
      });
      const operation = h.owner.prepareDaily(child.childId, input, { assertCurrent() {} });
      let finished = false;
      void operation.then(() => {
        finished = true;
      });
      await entered.promise;
      await vi.advanceTimersByTimeAsync(180_000);
      await publication.promise;
      const saved = structuredClone(h.published.get(input.date)!);
      expect(saved.restImages).toEqual({ bored: expect.any(String) });
      expect(h.optimize).toHaveBeenCalledTimes(3);
      expect(vi.getTimerCount()).toBe(0);
      expect(finished).toBe(false);
      let closed = false;
      const closing = shutdown
        ? h.owner.close().then(() => {
            closed = true;
          })
        : undefined;
      await Promise.resolve();
      expect(closed).toBe(false);
      if (outcome === "success") {
        late.resolve(image("too-late"));
      } else {
        late.reject(new Error("late private failure"));
      }
      await expect(operation).resolves.toMatchObject({ published: true });
      await (closing ?? h.owner.close());
      expect(h.published.get(input.date)).toEqual(saved);
      expect(h.publish).toHaveBeenCalledTimes(1);
      expect(h.optimize).toHaveBeenCalledTimes(3);
      const [directory] = await readdir(path.join(h.dir, "images"));
      expect(await readdir(path.join(h.dir, "images", directory!))).toHaveLength(3);
    },
  );

  it.each([500_000, 540_000])(
    "limits optional work to the remaining preparation budget after %sms of required work",
    async (elapsed) => {
      const h = await harness();
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
      h.generate
        .mockReset()
        .mockImplementationOnce(async () => {
          await vi.advanceTimersByTimeAsync(elapsed);
          return image("normal");
        })
        .mockResolvedValue(image("next"));
      await h.owner.prepareDaily(child.childId, input, { assertCurrent() {} });
      expect(h.generate).toHaveBeenCalledTimes(elapsed < 540_000 ? 4 : 2);
      for (const [request] of h.generate.mock.calls.slice(2)) {
        expect(request.timeoutMs).toBe(540_000 - elapsed);
      }
      expect(h.publish).toHaveBeenCalledTimes(1);
      expect(vi.getTimerCount()).toBe(0);
      await h.owner.close();
    },
  );

  it("joins optional siblings and rejects authority loss without publishing fallback work", async () => {
    const h = await harness();
    const entered = Promise.withResolvers<void>();
    const provider = Promise.withResolvers<GenerationResult>();
    let allowed = true;
    h.generate
      .mockReset()
      .mockResolvedValueOnce(image("normal"))
      .mockResolvedValueOnce(image("excited"))
      .mockImplementation(() => {
        entered.resolve();
        return provider.promise;
      });
    const operation = h.owner.prepareDaily(child.childId, input, {
      assertCurrent() {
        if (!allowed) {
          throw new Error("revoked");
        }
      },
    });
    const rejected = expect(operation).rejects.toThrow("revoked");
    await entered.promise;
    allowed = false;
    provider.resolve(image("late"));
    await rejected;
    expect(h.publish).not.toHaveBeenCalled();
    expect(h.optimize).toHaveBeenCalledTimes(2);
    await expect(readdir(path.join(h.dir, "images"))).rejects.toMatchObject({ code: "ENOENT" });
    await h.owner.close();
  });

  it("joins admitted provider work during shutdown and forbids late publication", async () => {
    const h = await harness();
    const entered = Promise.withResolvers<void>();
    const provider = Promise.withResolvers<GenerationResult>();
    h.generate.mockReset().mockImplementation(async () => {
      entered.resolve();
      return provider.promise;
    });
    const operation = h.owner.prepareDaily(child.childId, input, { assertCurrent() {} });
    const rejected = expect(operation).rejects.toThrow("closing");
    await entered.promise;
    expect(() => h.owner.prepareDaily(child.childId, input, { assertCurrent() {} })).toThrow(
      "busy",
    );
    let closed = false;
    const closing = h.owner.close().then(() => {
      closed = true;
    });
    await Promise.resolve();
    expect(closed).toBe(false);
    provider.resolve(image("late"));
    await rejected;
    await closing;
    expect(h.generate).toHaveBeenCalledTimes(1);
    expect(h.publish).not.toHaveBeenCalled();
    await expect(h.owner.readImage(child.childId, "reference", () => {})).rejects.toThrow(
      "closing",
    );
  });

  it("rechecks invocation authority before the second image and retains no revoked work", async () => {
    const h = await harness();
    let allowed = true;
    h.generate.mockReset().mockImplementation(async () => {
      allowed = false;
      return image("revoked");
    });
    await expect(
      h.owner.prepareDaily(child.childId, input, {
        assertCurrent() {
          if (!allowed) {
            throw new Error("revoked");
          }
        },
      }),
    ).rejects.toThrow("revoked");
    expect(h.generate).toHaveBeenCalledTimes(1);
    expect(h.publish).not.toHaveBeenCalled();
    await h.owner.close();
  });

  it("cleans a confirmed losing publication but preserves an uncertain committed pair", async () => {
    const h = await harness();
    h.publish.mockImplementation(async () => ({ published: false }));
    await h.owner.prepareDaily(child.childId, input, { assertCurrent() {} });
    const images = path.join(h.dir, "images");
    const [directory] = await readdir(images);
    expect(await readdir(path.join(images, directory!))).toEqual([]);
    h.generate.mockResolvedValue(image("retry"));
    h.publish.mockImplementation(async (bundle) => {
      h.published.set(bundle.date, bundle);
      throw new Error("lost acknowledgment");
    });
    await expect(
      h.owner.prepareDaily(child.childId, input, { assertCurrent() {} }),
    ).rejects.toThrow("lost acknowledgment");
    expect(await readdir(path.join(images, directory!))).toHaveLength(4);
    await expect(
      h.owner.prepareDaily(child.childId, input, { assertCurrent() {} }),
    ).resolves.toMatchObject({ published: false });
    expect(h.generate).toHaveBeenCalledTimes(8);
    await h.owner.close();
  });

  it("bounds image encoding before publication", async () => {
    const h = await harness();
    h.optimize.mockResolvedValue({
      buffer: Buffer.alloc(512 * 1024 + 1),
      optimizedSize: 512 * 1024 + 1,
      resizeSide: 512,
      compressionLevel: 6,
    });
    await expect(
      h.owner.prepareDaily(child.childId, input, { assertCurrent() {} }),
    ).rejects.toThrow("image limit");
    expect(h.optimize).toHaveBeenCalledTimes(1);
    expect(h.publish).not.toHaveBeenCalled();
    await h.owner.close();
  });
});
