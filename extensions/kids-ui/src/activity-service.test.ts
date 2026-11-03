import type { ActivityResult, ActivitySnapshot } from "@openclaw/kids-activity-contract";
import type {
  OpenClawPluginApi,
  OpenClawPluginServiceContextV2,
  OpenClawPluginServiceV2,
} from "openclaw/plugin-sdk/plugin-entry";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ActivityChildBinding } from "./activity-contract.js";
import { ActivityInputError } from "./activity-error.js";
import { registerKidsActivityService } from "./activity-service.js";
import type { ActivityStoreOperations } from "./activity-store-contract.js";
import { legacyActivityBundle } from "./activity-test-helpers.js";

const mocks = vi.hoisted(() => ({
  open: vi.fn(),
  execute: vi.fn(),
  close: vi.fn(),
  write: vi.fn(),
  complete: vi.fn(),
  history: vi.fn(),
}));
vi.mock("openclaw/plugin-sdk/sqlite-runtime", () => ({
  openSqliteWorkerStore: mocks.open,
  runSqliteWorkerStoreWrite: mocks.write,
}));
vi.mock("openclaw/plugin-sdk/process-runtime", () => ({
  resolveRuntimeWorkerUrl: () => new URL("file:///fixture/activity-store.worker.js"),
}));
const child: ActivityChildBinding = {
  childId: "child",
  agentId: "tutor",
  sessionKey: "agent:tutor:main",
  timeZone: "America/Chicago",
};
const snapshot: ActivitySnapshot = {
  now: 0,
  date: "2026-10-13",
  pet: { state: "normal", scene: null, image: null, lastInteractionAt: null, excitedUntil: null },
  correctStreak: 0,
  perfectDayStreak: 0,
  activity: null,
  daily: null,
  nextActivity: null,
  extras: { questionsSolved: 0, firstTryCorrect: 0, hintedQuestions: 0 },
  canContinue: false,
};

function harness(
  options: {
    startGeneration?: () => Promise<void>;
    stopGeneration?: () => Promise<void>;
    now?: () => number;
  } = {},
) {
  let service!: OpenClawPluginServiceV2;
  const lifetime = new AbortController();
  const api = {
    runtime: {
      llm: { complete: mocks.complete },
      gateway: { request: mocks.history },
    },
    registerService: (value: OpenClawPluginServiceV2) => {
      service = value;
    },
  } as unknown as OpenClawPluginApi;
  const owner = registerKidsActivityService(api, {
    children: [child],
    now: () => Date.parse("2026-10-14T02:00:00Z"),
    ...options,
  });
  const context = {
    stateDir: "/fixture",
    scheduler: { signal: lifetime.signal },
  } as OpenClawPluginServiceContextV2;
  return {
    owner,
    start: () => service.start(context),
    stop: () => {
      lifetime.abort();
      return service.stop?.(context);
    },
  };
}
beforeEach(() => {
  vi.clearAllMocks();
  mocks.open.mockResolvedValue({ execute: mocks.execute, close: mocks.close });
  mocks.execute.mockResolvedValue(snapshot);
  mocks.close.mockResolvedValue(undefined);
  mocks.complete.mockResolvedValue({
    text: '{"outcome":"correct","explanation":"You explained the equal pieces."}',
  });
  mocks.history.mockResolvedValue({ messages: [] });
  mocks.write.mockImplementation(async (store, run, guard) => {
    guard();
    return run(store);
  });
});

describe("activity service lifetime", () => {
  it("fences a queued artwork refresh at local midnight and admits its committed acknowledgment", async () => {
    let now = Date.parse("2026-10-14T04:59:59Z");
    const service = harness({ now: () => now });
    await service.start();
    const pending = Promise.withResolvers<{ published: boolean }>();
    mocks.execute.mockReturnValue(pending.promise);
    const artwork = legacyActivityBundle("child");
    const operation = service.owner.publishArtwork(artwork, "old-normal", () => {});
    const guard = mocks.write.mock.calls[0]![2] as () => void;
    expect(guard).not.toThrow();
    now += 2000;
    expect(guard).toThrow("current local date");
    // A commit admitted before midnight remains valid even if its acknowledgment
    // arrives after midnight; only the effect boundary checks the local date.
    pending.resolve({ published: true });
    await expect(operation).resolves.toEqual({ published: true });
    await service.stop();
  });

  it("does not admit calls before activation and uses the child's date", async () => {
    const service = harness();
    await expect(service.owner.get("child", () => {})).rejects.toThrow("restarting");
    await service.start();
    expect(mocks.open).toHaveBeenCalledWith(
      expect.objectContaining({
        input: {
          children: [{ childId: "child", timeZone: "America/Chicago" }],
          now: Date.parse("2026-10-14T02:00:00Z"),
        },
      }),
    );
    await service.owner.get("child", () => {});
    expect(mocks.execute).toHaveBeenCalledWith(
      expect.objectContaining({
        input: { childId: "child", date: "2026-10-13", now: Date.parse("2026-10-14T02:00:00Z") },
      }),
      expect.anything(),
    );
    await service.stop();
  });

  it("seals admission and joins accepted calls before closing the worker", async () => {
    const pending = Promise.withResolvers<ActivitySnapshot>();
    const service = harness();
    await service.start();
    mocks.execute.mockReturnValue(pending.promise);
    const read = service.owner.get("child", () => {});
    const rejected = expect(read).rejects.toThrow();
    const stopped = service.stop();
    expect(mocks.close).not.toHaveBeenCalled();
    await expect(service.owner.get("child", () => {})).rejects.toThrow("restarting");
    pending.resolve(snapshot);
    await rejected;
    await stopped;
    expect(mocks.close).toHaveBeenCalledOnce();
  });

  it("keeps practice publication under the live write guard and joins it before shutdown", async () => {
    const service = harness();
    await service.start();
    const pending = Promise.withResolvers<{ published: boolean; snapshot: ActivitySnapshot }>();
    mocks.execute.mockReturnValue(pending.promise);
    const offer = {
      date: "2026-10-13",
      activity: { id: "practice", title: "Explain", subject: "Math", questions: [question] },
    };
    const caller = vi.fn();
    const operation = service.owner.offerPractice("child", offer, caller);
    const rejected = expect(operation).rejects.toThrow();
    expect(mocks.write).toHaveBeenCalledOnce();
    expect(mocks.execute).toHaveBeenCalledWith({
      type: "offerPractice",
      input: {
        childId: "child",
        date: "2026-10-13",
        now: Date.parse("2026-10-14T02:00:00Z"),
        offer,
      },
    });
    const guard = mocks.write.mock.calls[0]![2] as () => void;
    const stopped = service.stop();
    expect(mocks.close).not.toHaveBeenCalled();
    expect(guard).toThrow();
    pending.resolve({ published: true, snapshot });
    await rejected;
    await stopped;
    expect(caller).toHaveBeenCalled();
    expect(mocks.close).toHaveBeenCalledOnce();
  });

  it("joins an opening worker and closes it when stop races startup", async () => {
    const opening = Promise.withResolvers<unknown>();
    mocks.open.mockReturnValue(opening.promise);
    const service = harness();
    const started = service.start();
    let settled = false;
    const stopped = Promise.resolve(service.stop()).then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);
    opening.resolve({ execute: mocks.execute, close: mocks.close });
    await started;
    await stopped;
    expect(mocks.close).toHaveBeenCalledOnce();
    await expect(service.owner.get("child", () => {})).rejects.toThrow("restarting");
  });

  it("cleans up a failed generation activation and discards revoked read results", async () => {
    const failed = harness({
      startGeneration: async () => {
        throw new Error("generation admission failed");
      },
    });
    await expect(failed.start()).rejects.toThrow("generation admission failed");
    expect(mocks.close).toHaveBeenCalledOnce();
    const service = harness();
    await service.start();
    const pending = Promise.withResolvers<ActivitySnapshot>();
    mocks.execute.mockReturnValue(pending.promise);
    let authorized = true;
    const read = service.owner.get("child", () => {
      if (!authorized) {
        throw new Error("revoked");
      }
    });
    authorized = false;
    pending.resolve(snapshot);
    await expect(read).rejects.toThrow("revoked");
    await service.stop();
  });
});

const question = {
  kind: "explanation" as const,
  id: "q",
  prompt: "Why are two halves one whole?",
  rubric: "Two equal parts cover the original whole.",
  hint: "Think of equal pieces.",
  explanation: "They cover the whole.",
};
const mutation = {
  kind: "answer" as const,
  requestId: "answer",
  activityId: "a",
  questionId: "q",
  answer: { kind: "explanation" as const, text: "The pieces cover the whole." },
};
function gradingStore() {
  mocks.execute.mockImplementation(async (command) =>
    command.type === "planAnswer"
      ? { kind: "grade", question }
      : {
          snapshot,
          feedback: {
            questionId: "q",
            outcome: "correct",
            independent: true,
            explanation: "You explained it.",
          },
        },
  );
}

describe("activity explanation lifetime", () => {
  it("deduplicates in-flight requests, bounds a child's grading, and uses their agent", async () => {
    const service = harness();
    await service.start();
    gradingStore();
    const called = Promise.withResolvers<void>();
    const pending = Promise.withResolvers<{ text: string }>();
    mocks.complete.mockImplementation(() => {
      called.resolve();
      return pending.promise;
    });
    const first = service.owner.mutate("child", mutation, () => {});
    await called.promise;
    const duplicate = service.owner.mutate("child", mutation, () => {});
    await expect(
      service.owner.mutate("child", { ...mutation, requestId: "other" }, () => {}),
    ).rejects.toThrow("still being checked");
    expect(mocks.complete).toHaveBeenCalledOnce();
    expect(mocks.complete.mock.calls[0]![0].agentId).toBe("tutor");
    pending.resolve({ text: '{"outcome":"correct","explanation":"You explained the pieces."}' });
    expect(await duplicate).toEqual(await first);
    expect(mocks.write).toHaveBeenCalledOnce();
    await service.stop();
  });

  it("replays committed receipts before inference and rejects failed grading without a write", async () => {
    const service = harness();
    await service.start();
    mocks.execute.mockResolvedValue({ kind: "replay", result: { snapshot } });
    expect(await service.owner.mutate("child", mutation, () => {})).toEqual({ snapshot });
    expect(mocks.complete).not.toHaveBeenCalled();
    expect(mocks.write).not.toHaveBeenCalled();
    gradingStore();
    mocks.complete.mockRejectedValue(new Error("timeout"));
    await expect(service.owner.mutate("child", mutation, () => {})).rejects.toThrow(
      "could not be checked",
    );
    expect(mocks.write).not.toHaveBeenCalled();
    await service.stop();
  });

  it("rechecks caller authority after inference before starting a commit", async () => {
    const service = harness();
    await service.start();
    gradingStore();
    let authorized = true;
    mocks.complete.mockImplementation(async () => {
      authorized = false;
      return { text: '{"outcome":"correct","explanation":"Yes."}' };
    });
    await expect(
      service.owner.mutate("child", mutation, () => {
        if (!authorized) {
          throw new Error("revoked");
        }
      }),
    ).rejects.toThrow("revoked");
    expect(mocks.write).not.toHaveBeenCalled();
    await service.stop();
  });

  it("aborts and joins inference before closing its worker and discards late grades", async () => {
    const service = harness();
    await service.start();
    gradingStore();
    const called = Promise.withResolvers<AbortSignal>();
    const pending = Promise.withResolvers<{ text: string }>();
    mocks.complete.mockImplementation((request) => {
      called.resolve(request.signal);
      return pending.promise;
    });
    const answer = service.owner.mutate("child", mutation, () => {});
    const rejected = expect(answer).rejects.toThrow();
    const signal = await called.promise;
    const stopped = service.stop();
    expect(signal.aborted).toBe(true);
    expect(mocks.close).not.toHaveBeenCalled();
    pending.resolve({ text: '{"outcome":"correct","explanation":"Yes."}' });
    await rejected;
    await stopped;
    expect(mocks.write).not.toHaveBeenCalled();
    expect(mocks.close).toHaveBeenCalledOnce();
  });
});

const continuation = { kind: "continue" as const, requestId: "next", activityId: "completed" };
const nextBatch = {
  title: "Another ten",
  subject: "Math",
  questions: Array.from({ length: 10 }, (_, index) => ({
    kind: "numeric",
    prompt: `What is ${index} plus one?`,
    hint: "Count one more.",
    explanation: `The sum is ${index + 1}.`,
    answer: String(index + 1),
    unit: null,
  })),
};
const nextBatchText = JSON.stringify(nextBatch);
const nextPlan: Extract<ActivityStoreOperations["planNext"]["output"], { kind: "generate" }> = {
  kind: "generate",
  date: "2026-10-13",
  previous: {
    id: continuation.activityId,
    date: "2026-10-13",
    scope: "daily",
    title: "Equal parts",
    subject: "Math",
    completed: true,
    completedAt: 100,
    questions: [
      {
        questionId: "q1",
        prompt: "How many halves make one whole?",
        attempts: 1,
        hintUsed: false,
        correct: true,
        independent: true,
      },
    ],
    attempts: [],
    attemptsOmitted: 0,
  },
  history: [],
  historyOmitted: 0,
  learningBrief: "Practice equivalent fractions at the child's current level.",
};
type StoreCommand = {
  [K in keyof ActivityStoreOperations]: { type: K; input: ActivityStoreOperations[K]["input"] };
}[keyof ActivityStoreOperations];
const continuedResult: ActivityResult = { snapshot };

/** The worker decides replay/publication; these tests exercise the real service and generator. */
function continuationStore() {
  mocks.complete.mockResolvedValue({ text: nextBatchText });
  mocks.execute.mockImplementation(async (command: StoreCommand) => {
    if (command.type === "planNext") {
      return nextPlan;
    }
    if (command.type === "publishNext") {
      return continuedResult;
    }
    if (command.type === "get") {
      return snapshot;
    }
    throw new Error(`Unexpected continuation command: ${command.type}`);
  });
}

describe("activity continuation lifetime", () => {
  it("replays the saved successor without reading context, inference, or another write", async () => {
    const service = harness();
    await service.start();
    mocks.execute.mockResolvedValue({ kind: "replay", result: continuedResult });
    expect(await service.owner.mutate("child", continuation, () => {})).toEqual(continuedResult);
    expect(mocks.complete).not.toHaveBeenCalled();
    expect(mocks.history).not.toHaveBeenCalled();
    expect(mocks.write).not.toHaveBeenCalled();
    expect(mocks.execute).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "planNext",
        input: expect.objectContaining({ mutation: continuation }),
      }),
      expect.anything(),
    );
    await service.stop();
  });

  it("joins different request IDs for one predecessor and publishes only once", async () => {
    const service = harness();
    await service.start();
    continuationStore();
    const called = Promise.withResolvers<void>();
    const pending = Promise.withResolvers<{ text: string }>();
    mocks.complete.mockImplementation(() => {
      called.resolve();
      return pending.promise;
    });
    const first = service.owner.mutate("child", continuation, () => {});
    await called.promise;
    const second = service.owner.mutate(
      "child",
      { ...continuation, requestId: "other-device" },
      () => {},
    );
    await expect(
      service.owner.mutate(
        "child",
        { ...continuation, activityId: "different-predecessor" },
        () => {},
      ),
    ).rejects.toThrow("still being prepared");
    expect(mocks.complete).toHaveBeenCalledOnce();
    expect(mocks.write).not.toHaveBeenCalled();
    pending.resolve({ text: nextBatchText });
    expect(await second).toEqual(await first);
    expect(mocks.execute.mock.calls.map(([command]) => command.type)).toEqual([
      "planNext",
      "planNext",
      "planNext",
      "publishNext",
    ]);
    expect(mocks.write).toHaveBeenCalledOnce();
    const published = mocks.execute.mock.calls[3]![0];
    expect(published.input).toMatchObject({
      mutation: continuation,
      generationDate: nextPlan.date,
    });
    expect(published.input.activity.questions).toHaveLength(10);
    await service.stop();
  });

  it("checks each request receipt before joining an in-flight continuation", async () => {
    const service = harness();
    await service.start();
    continuationStore();
    const called = Promise.withResolvers<void>();
    const pending = Promise.withResolvers<{ text: string }>();
    mocks.complete.mockImplementation(() => {
      called.resolve();
      return pending.promise;
    });
    const first = service.owner.mutate("child", continuation, () => {});
    await called.promise;
    mocks.execute.mockImplementation(async (command: StoreCommand) => {
      if (command.type === "planNext") {
        expect(command.input.mutation.requestId).toBe("conflicting-receipt");
        throw new ActivityInputError("This request ID belongs to a different operation.");
      }
      if (command.type === "publishNext") {
        return continuedResult;
      }
      throw new Error("Unexpected command");
    });
    await expect(
      service.owner.mutate(
        "child",
        { ...continuation, requestId: "conflicting-receipt" },
        () => {},
      ),
    ).rejects.toThrow("different operation");
    expect(mocks.complete).toHaveBeenCalledOnce();
    expect(mocks.write).not.toHaveBeenCalled();
    pending.resolve({ text: nextBatchText });
    expect(await first).toEqual(continuedResult);
    expect(mocks.execute.mock.calls.map(([command]) => command.type)).toEqual([
      "planNext",
      "planNext",
      "publishNext",
    ]);
    await service.stop();
  });

  it("releases failed or invalid generation for the same-ID retry without writing a batch", async () => {
    const service = harness();
    await service.start();
    continuationStore();
    mocks.complete.mockRejectedValueOnce(new Error("Provider unavailable"));
    await expect(service.owner.mutate("child", continuation, () => {})).rejects.toThrow(
      "Provider unavailable",
    );
    expect(mocks.write).not.toHaveBeenCalled();
    mocks.complete.mockResolvedValueOnce({
      text: JSON.stringify({ ...nextBatch, questions: nextBatch.questions.slice(1) }),
    });
    await expect(service.owner.mutate("child", continuation, () => {})).rejects.toThrow(
      "Rocky couldn't prepare more problems",
    );
    expect(mocks.write).not.toHaveBeenCalled();
    expect(await service.owner.mutate("child", continuation, () => {})).toEqual(continuedResult);
    expect(mocks.complete).toHaveBeenCalledTimes(3);
    expect(mocks.execute.mock.calls.map(([command]) => command.type)).toEqual([
      "planNext",
      "planNext",
      "planNext",
      "publishNext",
    ]);
    expect(mocks.write).toHaveBeenCalledOnce();
    await service.stop();
  });

  it("lets a surviving joiner retry its same mutation after the initiator disconnects", async () => {
    const service = harness();
    await service.start();
    continuationStore();
    const initiator = new AbortController();
    const survivor = new AbortController();
    const retryMutation = { ...continuation, requestId: "surviving-device" };
    const called = Promise.withResolvers<AbortSignal>();
    const pending = Promise.withResolvers<{ text: string }>();
    mocks.complete.mockImplementationOnce((params) => {
      called.resolve(params.signal);
      return pending.promise;
    });
    const first = service.owner.mutate("child", continuation, () => {}, initiator.signal);
    const firstRejected = expect(first).rejects.toThrow("Initiating device disconnected");
    const signal = await called.promise;
    const joined = service.owner.mutate("child", retryMutation, () => {}, survivor.signal);
    const joinedRejected = expect(joined).rejects.toThrow("Initiating device disconnected");
    const disconnected = new Error("Initiating device disconnected");
    initiator.abort(disconnected);
    expect(signal.aborted).toBe(true);
    pending.reject(disconnected);
    await Promise.all([firstRejected, joinedRejected]);
    expect(survivor.signal.aborted).toBe(false);
    expect(mocks.complete).toHaveBeenCalledOnce();
    expect(mocks.write).not.toHaveBeenCalled();

    await expect(
      service.owner.mutate("child", retryMutation, () => {}, survivor.signal),
    ).resolves.toEqual(continuedResult);
    expect(mocks.complete).toHaveBeenCalledTimes(2);
    expect(mocks.write).toHaveBeenCalledOnce();
    expect(mocks.execute.mock.calls.map(([command]) => command.type)).toEqual([
      "planNext",
      "planNext",
      "planNext",
      "publishNext",
    ]);
    expect(mocks.execute.mock.calls[3]![0].input.mutation).toEqual(retryMutation);
    await service.stop();
  });

  it.each(["request", "service"])(
    "aborts from %s and awaits the public completion promise before releasing the worker",
    async (source) => {
      const service = harness();
      await service.start();
      continuationStore();
      const request = new AbortController();
      const called = Promise.withResolvers<AbortSignal>();
      const pending = Promise.withResolvers<{ text: string }>();
      mocks.complete.mockImplementation((params) => {
        called.resolve(params.signal);
        return pending.promise;
      });
      const operation = service.owner.mutate("child", continuation, () => {}, request.signal);
      const rejected = expect(operation).rejects.toThrow();
      const signal = await called.promise;
      if (source === "request") {
        request.abort(new Error("Browser disconnected"));
        expect(signal.aborted).toBe(true);
        expect(mocks.close).not.toHaveBeenCalled();
      }
      const stopped = service.stop();
      expect(signal.aborted).toBe(true);
      expect(mocks.close).not.toHaveBeenCalled();
      await expect(service.owner.mutate("child", continuation, () => {})).rejects.toThrow(
        "restarting",
      );
      pending.resolve({ text: nextBatchText });
      await rejected;
      await stopped;
      expect(mocks.write).not.toHaveBeenCalled();
      expect(mocks.execute.mock.calls.map(([command]) => command.type)).toEqual(["planNext"]);
      expect(mocks.close).toHaveBeenCalledOnce();
    },
  );

  it.each(["after inference", "at commit"])(
    "rechecks authority %s before publishing",
    async (phase) => {
      const service = harness();
      await service.start();
      continuationStore();
      let current = true;
      if (phase === "after inference") {
        mocks.complete.mockImplementation(async () => {
          current = false;
          return { text: nextBatchText };
        });
      } else {
        mocks.write.mockImplementation(async (_store, _run, guard) => {
          current = false;
          guard();
        });
      }
      await expect(
        service.owner.mutate("child", continuation, () => {
          if (!current) {
            throw new Error("Child access revoked");
          }
        }),
      ).rejects.toThrow("Child access revoked");
      expect(mocks.execute.mock.calls.map(([command]) => command.type)).toEqual(["planNext"]);
      await service.stop();
    },
  );

  it("rejects generation that finishes after the child's local midnight", async () => {
    let now = Date.parse("2026-10-14T04:59:59Z");
    const service = harness({ now: () => now });
    await service.start();
    continuationStore();
    mocks.complete.mockImplementation(async () => {
      now = Date.parse("2026-10-14T05:00:00Z");
      return { text: nextBatchText };
    });
    mocks.execute.mockImplementation(async (command: StoreCommand) => {
      if (command.type === "planNext") {
        expect(command.input.date).toBe("2026-10-13");
        return nextPlan;
      }
      throw new Error("Unexpected command");
    });
    await expect(service.owner.mutate("child", continuation, () => {})).rejects.toThrow(
      "day changed",
    );
    expect(mocks.complete).toHaveBeenCalledOnce();
    expect(mocks.execute.mock.calls.map(([command]) => command.type)).toEqual(["planNext"]);
    await service.stop();
  });

  it("rechecks the local day after publication waits for write admission", async () => {
    let now = Date.parse("2026-10-14T04:59:59Z");
    const service = harness({ now: () => now });
    await service.start();
    continuationStore();
    const queued = Promise.withResolvers<void>();
    const admit = Promise.withResolvers<void>();
    mocks.write.mockImplementation(async (store, run, guard) => {
      queued.resolve();
      await admit.promise;
      guard();
      return run(store);
    });
    const operation = service.owner.mutate("child", continuation, () => {});
    const rejected = expect(operation).rejects.toThrow();
    await queued.promise;
    now = Date.parse("2026-10-14T05:00:00Z");
    admit.resolve();
    await rejected;
    expect(mocks.complete).toHaveBeenCalledOnce();
    expect(mocks.execute.mock.calls.map(([command]) => command.type)).toEqual(["planNext"]);
    await service.stop();
  });

  it("returns an admitted publication when its acknowledgment arrives after local midnight", async () => {
    let now = Date.parse("2026-10-14T04:59:59Z");
    const service = harness({ now: () => now });
    await service.start();
    continuationStore();
    const committed = Promise.withResolvers<void>();
    const acknowledge = Promise.withResolvers<void>();
    mocks.write.mockImplementation(async (store, run, guard) => {
      guard();
      const result = await run(store);
      committed.resolve();
      await acknowledge.promise;
      return result;
    });
    const operation = service.owner.mutate("child", continuation, () => {});
    await committed.promise;
    now = Date.parse("2026-10-14T05:00:00Z");
    acknowledge.resolve();
    await expect(operation).resolves.toEqual(continuedResult);
    expect(mocks.write).toHaveBeenCalledOnce();
    expect(mocks.execute.mock.calls.map(([command]) => command.type)).toEqual([
      "planNext",
      "publishNext",
    ]);
    expect(mocks.execute.mock.calls[1]![0].input).toMatchObject({
      date: "2026-10-13",
      generationDate: "2026-10-13",
    });
    await service.stop();
  });
});
