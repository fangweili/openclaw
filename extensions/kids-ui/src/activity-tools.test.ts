import { readFileSync } from "node:fs";
import type {
  OpenClawPluginApi,
  OpenClawPluginToolContext,
} from "openclaw/plugin-sdk/plugin-entry";
import { describe, expect, it, vi } from "vitest";
import type { ActivityPreparationContext } from "./activity-contract.js";
import type {
  ActivityDailyPreparation,
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
  // The host discovers and admits registrations from the manifest before calling factories.
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
};
const sibling: ActivityGenerationChild = {
  ...child,
  childId: "child-two",
  agentId: "tutor-two",
  sessionKey: "agent:tutor-two:kids:profile-two",
  preparationJobId: "prepare-two",
};
const evidence: ActivityPreparationContext = {
  snapshot: {
    now: 1,
    date: "2026-10-14",
    pet: {
      state: "sleeping",
      scene: null,
      image: null,
      lastInteractionAt: null,
      excitedUntil: null,
    },
    correctStreak: 0,
    activity: null,
    daily: null,
    nextActivity: null,
  },
  recentActivities: [],
  recentScenes: [],
  activitiesOmitted: 0,
};
const daily: ActivityDailyPreparation = {
  date: "2026-10-14",
  activities: [1, 2, 3].map((index) => ({
    id: `daily-${index}`,
    title: "Equal pieces",
    subject: "fractions",
    questions: [1, 2, 3].map((n) => ({
      id: `q${n}`,
      prompt: "One of two equal pieces is called what?",
      options: [
        { id: "half", text: "A half" },
        { id: "quarter", text: "A quarter" },
      ],
      correctOptionId: "half",
      hint: "Count how many equal pieces make the whole.",
      explanation: "Two equal halves make one whole.",
    })),
  })),
  normalPrompt: "Rocky looks at two equal leaf pieces.",
  excitedPrompt: "Rocky celebrates beside the same pieces.",
  normalCaption: "Ready to explore?",
  excitedCaption: "What a discovery!",
  boredCaption: "Thinking about tiny puzzles.",
  sleepingCaption: "Dreaming of leaves.",
};

function harness() {
  const prepare = vi.fn<ActivityToolRuntime["prepare"]>().mockResolvedValue(evidence);
  const prepareDaily = vi
    .fn<ActivityGeneration["prepareDaily"]>()
    .mockResolvedValue({ published: true, date: "2026-10-14" });
  const runtime: ActivityToolRuntime = {
    prepare,
    generation: { prepareDaily, readImage: vi.fn(), close: vi.fn() },
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
  return {
    prepare,
    prepareDaily,
    runtime,
    options,
    context,
    retire: (replacement: ActivityToolRuntime | null = null) => {
      current = replacement;
    },
  };
}

describe("activity cron tool authority", () => {
  it("is absent from child chats, unrelated cron jobs, and suffix lookalikes", () => {
    const h = harness();
    for (const sessionKey of [
      child.sessionKey,
      "agent:tutor-one:cron:unrelated:run:run-one",
      "agent:tutor-one:cron:prepare-one:run:",
      "agent:tutor-one:cron:prepare-one:run:run-one:child",
    ]) {
      expect(registeredTool({ ...h.context, sessionKey }, h.options)).toBeNull();
    }
    expect(registeredTool({ ...h.context, agentId: sibling.agentId }, h.options)).toBeNull();
  });

  it("binds preparation and evidence to the configured child", async () => {
    const h = harness();
    const tool = registeredTool(h.context, h.options)!;
    await tool.execute("call-one", { action: "prepare_context" });
    expect(h.prepare).toHaveBeenLastCalledWith(child.childId, expect.any(Function));
    await tool.execute("call-two", { action: "evidence" });
    expect(h.prepare).toHaveBeenLastCalledWith(child.childId, expect.any(Function));
    const result = await tool.execute("call-three", {
      action: "prepare_daily",
      ...daily,
    });
    expect(h.prepareDaily).toHaveBeenCalledWith(
      child.childId,
      expect.objectContaining({ date: "2026-10-14" }),
      expect.objectContaining({ assertCurrent: expect.any(Function) }),
    );
    expect(result.details).toEqual({ published: true, date: "2026-10-14" });
  });

  it("rejects malformed or forged direct arguments before accessing the owner", async () => {
    const h = harness();
    const tool = registeredTool(h.context, h.options)!;
    for (const args of [
      { action: "evidence", childId: sibling.childId },
      { action: "prepare_daily", ...daily, childId: sibling.childId },
      { action: "prepare_daily", date: daily.date },
      { action: "prepare_daily", ...daily, excitedPrompt: "x".repeat(1501) },
      { action: "prepare_daily", ...daily, activities: daily.activities.slice(0, 2) },
      {
        action: "prepare_daily",
        ...daily,
        activities: daily.activities.map((activity) => ({
          ...activity,
          questions: activity.questions.slice(0, 2),
        })),
      },
      null,
    ]) {
      const result = await tool.execute("invalid", args);
      expect(result.details).toEqual({
        error: "Activity arguments do not match this scheduled job's schema.",
      });
    }
    expect(h.prepare).not.toHaveBeenCalled();
    expect(h.prepareDaily).not.toHaveBeenCalled();
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
    const result = await tool.execute("prepare-denied", { action: "prepare_daily" });
    expect(result.details).toEqual({
      error: "Activity arguments do not match this scheduled job's schema.",
    });
    expect(h.prepareDaily).not.toHaveBeenCalled();
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
    const context = await tool.execute("context", { action: "prepare_context" });
    expect(context.details).toMatchObject({ childId: child.childId, ...evidence });
    const publication = await tool.execute("publication", {
      action: "prepare_daily",
      ...daily,
    });
    expect(publication.details).toEqual({ published: true, date: "2026-10-14" });
    expect(h.prepareDaily).toHaveBeenCalledOnce();
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
