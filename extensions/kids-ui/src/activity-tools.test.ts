import { readFileSync } from "node:fs";
import type {
  OpenClawPluginApi,
  OpenClawPluginToolContext,
} from "openclaw/plugin-sdk/plugin-entry";
import { describe, expect, it, vi } from "vitest";
import type { ActivityPreparationContext, DailyActivityBundle } from "./activity-contract.js";
import type {
  ActivityArtworkPreparation,
  ActivityGeneration,
  ActivityGenerationChild,
} from "./activity-generation.js";
import { registerActivityTools, type ActivityToolsOptions } from "./activity-tools.js";

type ActivityToolRuntime = NonNullable<ReturnType<ActivityToolsOptions["getRuntime"]>>;
const manifest = JSON.parse(
  readFileSync(new URL("../openclaw.plugin.json", import.meta.url), "utf8"),
) as { contracts?: { tools?: string[] } };

/** Exercise discovery through the real public registration boundary. */
function registeredTool(context: OpenClawPluginToolContext<2>, options: ActivityToolsOptions) {
  const registerTool = vi.fn<OpenClawPluginApi["registerTool"]>();
  registerActivityTools({ registerTool }, options);
  expect(manifest.contracts?.tools).toContain(registerTool.mock.calls[0]?.[1]?.name);
  const factory = registerTool.mock.calls[0]?.[0];
  if (!factory || typeof factory === "function" || !("contextVersion" in factory)) {
    throw new Error("Expected the registered version-2 activity tool factory");
  }
  const tool = factory.create(context);
  if (Array.isArray(tool)) {
    throw new Error("Expected exactly one activity tool");
  }
  return tool ?? null;
}

const child: ActivityGenerationChild = {
  childId: "child-one",
  agentId: "tutor-one",
  sessionKey: "agent:tutor-one:kids:profile-one",
  timeZone: "America/Chicago",
  preparationJobId: "prepare-one",
  artworkJobId: "art-one",
};
const sibling: ActivityGenerationChild = {
  ...child,
  childId: "child-two",
  agentId: "tutor-two",
  sessionKey: "agent:tutor-two:kids:profile-two",
  preparationJobId: "prepare-two",
  preparationAgentId: "preparer",
  artworkJobId: "art-two",
};
const evidence: ActivityPreparationContext = {
  snapshot: {
    now: Date.parse("2026-10-14T15:00:00Z"),
    date: "2026-10-14",
    pet: {
      state: "sleeping",
      scene: null,
      image: null,
      lastInteractionAt: null,
      excitedUntil: null,
    },
    correctStreak: 0,
    perfectDayStreak: 0,
    activity: null,
    daily: null,
    nextActivity: null,
    canContinue: false,
    extras: { questionsSolved: 0, firstTryCorrect: 0, hintedQuestions: 0 },
  },
  recentActivities: [],
  recentScenes: [],
  activitiesOmitted: 0,
  learningBrief: "Private long-term learning context",
};
const daily: Omit<DailyActivityBundle, "childId"> = {
  date: "2026-10-14",
  learningBrief: "Dated synthetic learner: practicing equal parts with support.",
  activities: [1].map((index) => ({
    id: `daily-${index}`,
    title: "Equal pieces",
    subject: "fractions",
    questions: Array.from({ length: 10 }, (_, n) => ({
      kind: "numeric" as const,
      id: `q${n}`,
      prompt: "How many equal halves make one whole?",
      answer: "2",
      unit: null,
      hint: "Count how many equal pieces make the whole.",
      explanation: "Two equal halves make one whole.",
    })),
  })),
};
const artwork: ActivityArtworkPreparation = {
  date: daily.date,
  normalPrompt: "Rocky looks at two equal leaf pieces.",
  excitedPrompt: "Rocky celebrates beside the same pieces.",
  boredPrompt: "Rocky daydreams beside the leaf pieces.",
  sleepingPrompt: "Rocky naps beside the leaf pieces.",
  normalCaption: "Ready to explore?",
  excitedCaption: "What a discovery!",
  boredCaption: "Thinking about tiny puzzles.",
  sleepingCaption: "Dreaming of leaves.",
};
const prepareRequest = { action: "prepare_daily", ...daily };
const artworkRequest = { action: "prepare_art", timeoutMs: 600_000, ...artwork };

function harness() {
  const prepare = vi.fn<ActivityToolRuntime["prepare"]>().mockResolvedValue(evidence);
  const publish = vi.fn<ActivityToolRuntime["publish"]>().mockResolvedValue({ published: true });
  const prepareArtwork = vi
    .fn<ActivityGeneration["prepareArtwork"]>()
    .mockResolvedValue({ published: true, date: "2026-10-14" });
  const runtime: ActivityToolRuntime = {
    prepare,
    publish,
    generation: { prepareArtwork, readImage: vi.fn(), close: vi.fn() },
  };
  let current: ActivityToolRuntime | null = runtime;
  const options = {
    children: [child, sibling],
    evidenceJobs: [{ agentId: "jobs", jobId: "nightly" }],
    getRuntime: () => current,
  };
  const context: OpenClawPluginToolContext<2> = {
    agentId: child.agentId,
    sessionKey: "agent:tutor-one:cron:prepare-one:run:run-one",
    assertInvocationCurrent: vi.fn(),
  };
  const artContext = { ...context, sessionKey: "agent:tutor-one:cron:art-one:run:run-one" };
  return {
    prepare,
    publish,
    prepareArtwork,
    runtime,
    options,
    context,
    artContext,
    retire: (replacement: ActivityToolRuntime | null = null) => {
      current = replacement;
    },
  };
}

const schemaError = { error: "Activity arguments do not match this scheduled job's schema." };

describe("activity cron tool authority", () => {
  it("is absent from child chats, unrelated cron jobs, and suffix lookalikes", () => {
    const h = harness();
    for (const sessionKey of [
      child.sessionKey,
      "agent:tutor-one:cron:unrelated:run:run-one",
      "agent:tutor-one:cron:prepare-one:run:",
      "agent:tutor-one:cron:prepare-one:run:run-one:child",
      "agent:tutor-one:cron:art-one:run:run-one:child",
    ]) {
      expect(registeredTool({ ...h.context, sessionKey }, h.options)).toBeNull();
    }
    expect(registeredTool({ ...h.context, agentId: sibling.agentId }, h.options)).toBeNull();
    expect(registeredTool({ ...h.artContext, agentId: sibling.agentId }, h.options)).toBeNull();
    for (const jobId of ["prepare-two", "art-two"]) {
      expect(
        registeredTool(
          { ...h.context, agentId: "preparer", sessionKey: `agent:preparer:cron:${jobId}:run:one` },
          h.options,
        ),
      ).not.toBeNull();
      expect(
        registeredTool(
          {
            ...h.context,
            agentId: sibling.agentId,
            sessionKey: `agent:${sibling.agentId}:cron:${jobId}:run:one`,
          },
          h.options,
        ),
      ).toBeNull();
    }
  });

  it("publishes only the bound child's Solve goal without artwork or an image timeout", async () => {
    const h = harness();
    const tool = registeredTool(h.context, h.options)!;
    const context = await tool.execute("context", { action: "prepare_context" });
    expect(context.details).toMatchObject({ childId: child.childId, ...evidence });
    const result = await tool.execute("publish", prepareRequest);
    expect(h.publish).toHaveBeenCalledWith(
      { childId: child.childId, ...daily },
      expect.any(Function),
    );
    expect(h.prepareArtwork).not.toHaveBeenCalled();
    expect(result.details).toEqual({ published: true, date: "2026-10-14" });
  });

  it("rejects malformed, forged and artwork arguments on Solve jobs", async () => {
    const h = harness();
    const tool = registeredTool(h.context, h.options)!;
    for (const args of [
      { action: "evidence", childId: sibling.childId },
      { ...prepareRequest, childId: sibling.childId },
      { action: "prepare_daily", date: daily.date },
      { ...prepareRequest, timeoutMs: 600_000 },
      { ...prepareRequest, ...artwork },
      artworkRequest,
      { ...prepareRequest, activities: [] },
      {
        ...prepareRequest,
        activities: daily.activities.map((activity) => ({
          ...activity,
          questions: activity.questions.slice(0, 2),
        })),
      },
      null,
    ]) {
      expect((await tool.execute("invalid", args)).details).toEqual(schemaError);
    }
    expect(h.prepare).not.toHaveBeenCalled();
    expect(h.publish).not.toHaveBeenCalled();
    expect(h.prepareArtwork).not.toHaveBeenCalled();
  });

  it("gives artwork jobs bounded short-term evidence without teaching context", async () => {
    const h = harness();
    const now = evidence.snapshot.now;
    h.prepare.mockResolvedValue({
      ...evidence,
      activitiesOmitted: 3,
      recentActivities: [
        {
          id: "batch-one",
          date: daily.date,
          scope: "daily",
          title: "Leaf puzzles",
          subject: "fractions",
          completed: false,
          completedAt: null,
          questions: [],
          attemptsOmitted: 4,
          attempts: Array.from({ length: 22 }, (_, n) => ({
            id: `attempt-${n}`,
            at: n === 20 ? now - 24 * 60 * 60_000 - 1 : n === 21 ? now + 1 : now - n,
            activityId: "batch-one",
            questionId: `q${n}`,
            answer: { kind: "numeric" as const, text: "Private answer" },
            answerText: "Private answer",
            outcome: "correct" as const,
            feedback: "Private feedback",
            ordinal: 1,
            hintUsed: false,
            independent: true,
          })),
        },
      ],
      recentScenes: Array.from({ length: 5 }, (_, n) => ({
        date: n === 0 ? daily.date : `2026-10-${13 - n}`,
        scene: {
          normal: { imageId: `normal-${n}`, caption: "Hi" },
          excited: { imageId: `excited-${n}`, caption: "Yay" },
        },
        scenePrompt: `Scene ${n}`,
        stateText: { bored: "Resting", sleeping: "Napping" },
      })),
    });
    const result = await registeredTool(h.artContext, h.options)!.execute("art-context", {
      action: "prepare_context",
    });
    expect(result.details).toMatchObject({
      childId: child.childId,
      date: daily.date,
      currentImageId: "normal-0",
      window: { since: now - 24 * 60 * 60_000, until: now },
      omissions: { sourceActivities: 3, sourceAttempts: 4, windowAttempts: 8, scenes: 2 },
      recentAttempts: Array.from({ length: 12 }, (_, n) => ({
        at: now - n,
        title: "Leaf puzzles",
        subject: "fractions",
        outcome: "correct",
        hintUsed: false,
        independent: true,
      })),
      recentScenes: [0, 1, 2].map((n) => ({ scenePrompt: `Scene ${n}` })),
    });
    expect(result.details).not.toHaveProperty("snapshot");
    expect(result.details).not.toHaveProperty("learningBrief");
    expect(JSON.stringify(result)).not.toContain("Private");
  });

  it("binds art publication and explicit refresh without granting Solve authority", async () => {
    const h = harness();
    const tool = registeredTool(h.artContext, h.options)!;
    const result = await tool.execute("art", {
      ...artworkRequest,
      replaceImageId: "previous-image",
    });
    expect(h.prepareArtwork).toHaveBeenCalledWith(
      child.childId,
      { ...artwork, replaceImageId: "previous-image" },
      expect.objectContaining({ assertCurrent: expect.any(Function) }),
    );
    expect(result.details).toEqual({ published: true, date: daily.date });
    for (const args of [
      prepareRequest,
      { action: "evidence", childId: sibling.childId },
      { ...artworkRequest, childId: sibling.childId },
      { ...artworkRequest, learningBrief: "Forbidden" },
      { ...artworkRequest, timeoutMs: 90_000 },
      { ...artworkRequest, excitedPrompt: "x".repeat(1501) },
      { ...artworkRequest, sleepingPrompt: "" },
    ]) {
      expect((await tool.execute("invalid", args)).details).toEqual(schemaError);
    }
    expect(h.publish).not.toHaveBeenCalled();
    expect(h.prepareArtwork).toHaveBeenCalledOnce();
  });

  it("allows configured evidence jobs to read either child but never prepare", async () => {
    const h = harness();
    const context = {
      ...h.context,
      agentId: "jobs",
      sessionKey: "agent:jobs:cron:nightly:run:run-one",
    };
    const tool = registeredTool(context, h.options)!;
    await tool.execute("read-one", { action: "evidence", childId: sibling.childId });
    expect(h.prepare).toHaveBeenCalledWith(sibling.childId, expect.any(Function));
    for (const request of [prepareRequest, artworkRequest, { action: "prepare_context" }]) {
      expect((await tool.execute("denied", request)).details).toEqual(schemaError);
    }
    expect(h.publish).not.toHaveBeenCalled();
    expect(h.prepareArtwork).not.toHaveBeenCalled();
    await tool.execute("unknown-denied", { action: "evidence", childId: "unknown" });
    expect(h.prepare).toHaveBeenCalledTimes(1);
  });

  it("accepts fresh runtime facades for the same owned generation", async () => {
    const h = harness();
    h.options.getRuntime = () => ({ ...h.runtime });
    h.prepare.mockImplementation(async (_childId, assertCurrent) => {
      assertCurrent();
      return evidence;
    });
    const tool = registeredTool(h.context, h.options)!;
    expect((await tool.execute("context", { action: "prepare_context" })).details).toMatchObject({
      childId: child.childId,
      ...evidence,
    });
    expect((await tool.execute("publication", prepareRequest)).details).toEqual({
      published: true,
      date: daily.date,
    });
    expect(h.publish).toHaveBeenCalledOnce();
  });

  it.each(["stops", "restarts"])(
    "discards results when the service %s during evidence collection",
    async (state) => {
      const h = harness();
      const pending = Promise.withResolvers<ActivityPreparationContext>();
      h.prepare.mockReturnValue(pending.promise);
      const operation = registeredTool(h.context, h.options)!.execute("call", {
        action: "prepare_context",
      });
      h.retire(
        state === "stops" ? null : { ...h.runtime, generation: { ...h.runtime.generation } },
      );
      pending.resolve(evidence);
      const result = await operation;
      expect(result.details).toMatchObject({ error: expect.stringContaining("failed") });
      expect(JSON.stringify(result)).not.toContain("recentActivities");
    },
  );

  it("checks live invocation authority and redacts provider diagnostics", async () => {
    const h = harness();
    h.context.assertInvocationCurrent = () => {
      throw new Error("private authorization diagnostic");
    };
    const result = await registeredTool(h.context, h.options)!.execute("call", {
      action: "prepare_context",
    });
    expect(h.prepare).not.toHaveBeenCalled();
    expect(JSON.stringify(result)).not.toContain("private authorization diagnostic");
    expect(result.details).toMatchObject({
      error: expect.stringContaining("Previous saved activities remain valid"),
    });
  });
});
