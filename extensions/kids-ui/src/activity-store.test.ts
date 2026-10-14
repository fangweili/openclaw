import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { ActivityMutation } from "@openclaw/kids-activity-contract";
import { resolveRuntimeWorkerUrl } from "openclaw/plugin-sdk/process-runtime";
import {
  openSqliteWorkerStore,
  runSqliteWorkerStoreWrite,
  type SqliteWorkerStore,
} from "openclaw/plugin-sdk/sqlite-runtime";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  ACTIVITY_BORED_MS,
  ACTIVITY_EXCITED_MS,
  ACTIVITY_SLEEP_MS,
  type DailyActivityBundle,
} from "./activity-contract.js";
import type { ActivityStoreOperations } from "./activity-store-contract.js";

const timestamp = Date.parse("2026-10-13T12:00:00Z");
const moduleUrl = resolveRuntimeWorkerUrl({
  currentModuleUrl: import.meta.url,
  sourceWorkerName: "activity-store.worker",
  distWorkerPath: "extensions/kids-ui/src/activity-store.worker.js",
});
let directory: string;
let databasePath: string;
let store: SqliteWorkerStore<ActivityStoreOperations>;
const target = (childId: string, now = timestamp, date = "2026-10-13") => ({ childId, now, date });
function bundle(childId: string, date = "2026-10-13"): DailyActivityBundle {
  return {
    childId,
    date,
    activities: [1, 2, 3].map((index) => ({
      id: index === 1 ? `${childId}-${date}` : `${childId}-${date}-${index}`,
      title: `Berry math ${index}`,
      subject: "Math",
      questions: [1, 2, 3].map((id) => ({
        id: `q${id}`,
        prompt: `What is ${id} + 1?`,
        options: [
          { id: "yes", text: `${id + 1}` },
          { id: "no", text: "100" },
        ],
        correctOptionId: "yes",
        hint: "Count one more.",
        explanation: "Adding one moves to the next number.",
      })),
    })),
    scene: {
      normal: { imageId: `normal-${childId}-${date}`, caption: "Ready to explore?" },
      excited: { imageId: `excited-${childId}-${date}`, caption: "We figured it out!" },
    },
    scenePrompt: "Rocky builds a tiny boat from a red maple leaf beside a blue pond.",
    stateText: { bored: "Thinking of our next adventure.", sleeping: "Taking a cozy nap." },
  };
}
function publishBundle(value: DailyActivityBundle, now = timestamp, date = "2026-10-13") {
  return runSqliteWorkerStoreWrite(
    store,
    (scope) =>
      scope.execute({
        type: "publish",
        input: { ...target(value.childId, now, date), bundle: value },
      }),
    () => {},
    [databasePath],
  );
}
function publish(childId: string, date = "2026-10-13") {
  return publishBundle(bundle(childId, date));
}
function mutate(
  childId: string,
  mutation: ActivityMutation,
  now = timestamp,
  date = "2026-10-13",
  guard = () => {},
) {
  return runSqliteWorkerStoreWrite(
    store,
    (scope) =>
      scope.execute({ type: "mutate", input: { ...target(childId, now, date), mutation } }),
    guard,
    [databasePath],
  );
}
function start(childId: string) {
  return mutate(childId, {
    kind: "start",
    requestId: "start",
    activityId: `${childId}-2026-10-13`,
  });
}
function answer(
  childId: string,
  question: number,
  requestId: string,
  optionId = "yes",
  now = timestamp,
) {
  return mutate(
    childId,
    {
      kind: "answer",
      activityId: `${childId}-2026-10-13`,
      questionId: `q${question}`,
      requestId,
      optionId,
    },
    now,
  );
}
function get(childId: string, now = timestamp, date = "2026-10-13") {
  return store.execute({ type: "get", input: target(childId, now, date) });
}

beforeAll(async () => {
  directory = await fs.mkdtemp(path.join(os.tmpdir(), "kids-activity-proof-"));
  databasePath = path.join(directory, "activities.sqlite");
  store = await openSqliteWorkerStore<ActivityStoreOperations>({
    moduleUrl,
    databasePath,
    input: undefined,
  });
});
afterAll(async () => {
  await store?.close();
  await fs.rm(directory, { recursive: true, force: true });
});

describe("activity worker authority and progress", () => {
  it("keeps child projections separate and never exposes answer keys or unopened hints", async () => {
    await publish("projection");
    const snapshot = await get("projection");
    expect(snapshot.activity?.currentQuestion).toEqual({
      id: "q1",
      prompt: "What is 1 + 1?",
      options: [
        { id: "yes", text: "2" },
        { id: "no", text: "100" },
      ],
      hint: null,
    });
    expect(JSON.stringify(snapshot)).not.toMatch(
      /correctOptionId|explanation|Count one more|scenePrompt|red maple leaf/u,
    );
    expect(snapshot.daily).toEqual({ date: "2026-10-13", total: 3, completed: 0 });
    expect(snapshot.nextActivity).toBeNull();
    expect((await get("other-child")).activity).toBeNull();
  });

  it("atomically grades and replays duplicates without awarding progress twice", async () => {
    await publish("replay");
    await start("replay");
    const first = await answer("replay", 1, "answer-1");
    const duplicate = await answer("replay", 1, "answer-1", "yes", timestamp + 1000);
    expect(duplicate.feedback).toEqual(first.feedback);
    expect(duplicate.snapshot.correctStreak).toBe(1);
    expect(duplicate.snapshot.activity?.currentIndex).toBe(1);
    await expect(answer("replay", 1, "answer-1", "no")).rejects.toThrow("already used");
    await expect(answer("replay", 1, "different-id")).rejects.toThrow("already answered");
    expect((await get("replay")).correctStreak).toBe(1);
  });

  it("counts hinted correct work toward excitement while preserving independent evidence", async () => {
    await publish("hints");
    await start("hints");
    await mutate("hints", {
      kind: "hint",
      activityId: "hints-2026-10-13",
      questionId: "q1",
      requestId: "hint-1",
    });
    expect((await get("hints")).activity?.currentQuestion?.hint).toBe("Count one more.");
    expect((await answer("hints", 1, "a1")).feedback?.independent).toBe(false);
    await answer("hints", 2, "a2");
    await mutate("hints", { kind: "touch", source: "chat", requestId: "chat" });
    const finished = await answer("hints", 3, "a3");
    expect(finished.snapshot.pet.state).toBe("excited");
    expect(finished.snapshot.activity?.completed).toBe(true);
    const context = await store.execute({ type: "prepare", input: target("hints") });
    expect(context.recentActivities[0]?.attempts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "a1",
          at: timestamp,
          optionId: "yes",
          hintUsed: true,
          ordinal: 1,
          independent: false,
        }),
      ]),
    );
    expect(context.recentActivities).toHaveLength(3);
    expect(context.recentScenes).toHaveLength(1);
    expect(context.recentScenes[0]?.scene.normal.caption).toBe("Ready to explore?");
    expect(context.recentScenes[0]?.scenePrompt).toBe(
      "Rocky builds a tiny boat from a red maple leaf beside a blue pond.",
    );
  });

  it("resets streak on a wrong answer and records a correction as assisted", async () => {
    await publish("wrong");
    await start("wrong");
    await answer("wrong", 1, "first");
    const incorrect = await answer("wrong", 2, "wrong", "no");
    expect(incorrect.snapshot.correctStreak).toBe(0);
    expect(incorrect.snapshot.activity?.currentIndex).toBe(1);
    expect(incorrect.snapshot.pet.state).toBe("normal");
    const corrected = await answer("wrong", 2, "correction");
    expect(corrected.feedback).toMatchObject({ correct: true, independent: false });
    expect(corrected.snapshot.correctStreak).toBe(1);
  });

  it("uses server timestamps for sleep and preserves an ongoing celebration during chat", async () => {
    await publish("clocks");
    expect((await start("clocks")).snapshot.pet.state).toBe("sleeping");
    await answer("clocks", 1, "a1");
    await answer("clocks", 2, "a2");
    await answer("clocks", 3, "a3");
    expect(
      (
        await mutate(
          "clocks",
          { kind: "touch", requestId: "voice", source: "voice" },
          timestamp + 1000,
        )
      ).snapshot.pet.state,
    ).toBe("excited");
    expect((await get("clocks", timestamp + ACTIVITY_EXCITED_MS)).pet.state).toBe("normal");
    expect((await get("clocks", timestamp + 1000 + ACTIVITY_BORED_MS)).pet.state).toBe("bored");
    expect((await get("clocks", timestamp + 1000 + ACTIVITY_SLEEP_MS)).pet.state).toBe("sleeping");
    expect(
      (
        await mutate(
          "clocks",
          { kind: "touch", requestId: "wake", source: "chat" },
          timestamp + 1000 + ACTIVITY_SLEEP_MS,
        )
      ).snapshot.pet.state,
    ).toBe("normal");
  });

  it.each([
    { moods: [] },
    { moods: ["bored"] },
    { moods: ["sleeping"] },
    { moods: ["bored", "sleeping"] },
  ] as const)(
    "selects same-day rest art and preserves fixed fallbacks for available moods $moods",
    async ({ moods }) => {
      const childId = `rest-${moods.join("-") || "legacy"}`;
      const value = bundle(childId);
      if (moods.length) {
        value.restImages = {};
        for (const mood of moods) {
          value.restImages[mood] = `${childId}-${mood}`;
        }
      }
      await publishBundle(value);
      await mutate(childId, { kind: "touch", requestId: "wake", source: "chat" });
      for (const [mood, elapsed] of [
        ["bored", ACTIVITY_BORED_MS],
        ["sleeping", ACTIVITY_SLEEP_MS],
      ] as const) {
        expect((await get(childId, timestamp + elapsed)).pet.image).toEqual({
          imageId: value.restImages?.[mood] ?? mood,
          caption: value.stateText[mood],
        });
      }
      const saved = await store.execute({
        type: "findDaily",
        input: { childId, date: value.date },
      });
      expect(saved).toEqual(value);
      const tomorrow = await get(childId, timestamp + 86_400_000, "2026-10-14");
      expect(tomorrow.pet.image).toEqual({
        imageId: "sleeping",
        caption: "Resting until our next adventure.",
      });
      expect(tomorrow.pet.scene).toEqual(value.scene);
    },
  );

  it("rejects invalid optional art before publishing any of the day's challenges", async () => {
    const value = bundle("invalid-rest");
    value.restImages = { bored: "../../private" };
    await expect(publishBundle(value)).rejects.toThrow("resting image");
    expect((await get(value.childId)).activity).toBeNull();
  });

  it("resumes an unfinished day while displaying the new day's scene and refuses replacements", async () => {
    await publish("resume");
    await start("resume");
    await answer("resume", 1, "a1");
    await publish("resume", "2026-10-14");
    expect(await publish("resume")).toEqual({ published: false });
    const tomorrow = await get("resume", timestamp + 86_400_000, "2026-10-14");
    expect(tomorrow.activity?.date).toBe("2026-10-13");
    expect(tomorrow.activity?.currentIndex).toBe(1);
  });

  it("requires explicit ordered starts and finishes exactly three challenges", async () => {
    const childId = "batch";
    await publish(childId);
    const quizzes = bundle(childId).activities;
    await expect(
      mutate(childId, {
        kind: "start",
        requestId: "skip",
        activityId: quizzes[2]!.id,
      }),
    ).rejects.toThrow("activity changed");
    for (const [index, quiz] of quizzes.entries()) {
      const started = await mutate(childId, {
        kind: "start",
        requestId: `start-${index}`,
        activityId: quiz.id,
      });
      expect(started.snapshot.activity?.id).toBe(quiz.id);
      expect(started.snapshot.nextActivity).toBeNull();
      for (const question of quiz.questions) {
        await mutate(childId, {
          kind: "answer",
          requestId: `${quiz.id}-${question.id}`,
          activityId: quiz.id,
          questionId: question.id,
          optionId: "yes",
        });
      }
      const completed = await get(childId);
      expect(completed.activity).toMatchObject({ id: quiz.id, completed: true });
      expect(completed.daily).toEqual({ date: "2026-10-13", total: 3, completed: index + 1 });
      const next = quizzes[index + 1];
      expect(completed.nextActivity).toEqual(next ? { id: next.id, title: next.title } : null);
      // Reading and idempotent receipt replay never start the offered next quiz.
      const replay = await mutate(childId, {
        kind: "answer",
        requestId: `${quiz.id}-q3`,
        activityId: quiz.id,
        questionId: "q3",
        optionId: "yes",
      });
      expect(replay.feedback?.questionId).toBe("q3");
      expect(replay.snapshot).toEqual(completed);
    }
    expect((await get(childId)).correctStreak).toBe(9);
  });

  it("replaces unstarted extras and separates carryover completion from today's counts", async () => {
    const childId = "carry";
    const now = timestamp + 86_400_000;
    await publish(childId);
    await start(childId);
    await answer(childId, 1, "old-q1");
    await publish(childId, "2026-10-14");
    const carry = await get(childId, now, "2026-10-14");
    expect(carry.activity).toMatchObject({ date: "2026-10-13", currentIndex: 1 });
    expect(carry.daily).toEqual({ date: "2026-10-14", total: 3, completed: 0 });
    expect(carry.nextActivity).toBeNull();
    expect(carry.pet.scene?.normal.imageId).toBe(`normal-${childId}-2026-10-14`);
    for (const questionId of ["q2", "q3"]) {
      await mutate(
        childId,
        {
          kind: "answer",
          requestId: `old-${questionId}`,
          activityId: `${childId}-2026-10-13`,
          questionId,
          optionId: "yes",
        },
        now,
        "2026-10-14",
      );
    }
    const current = await get(childId, now, "2026-10-14");
    expect(current.activity).toMatchObject({ date: "2026-10-14", started: false });
    expect(current.daily?.completed).toBe(0);
    await expect(
      mutate(
        childId,
        {
          kind: "start",
          requestId: "old-extra",
          activityId: `${childId}-2026-10-13-2`,
        },
        now,
        "2026-10-14",
      ),
    ).rejects.toThrow("activity changed");
    const replay = await mutate(
      childId,
      {
        kind: "answer",
        requestId: "old-q3",
        activityId: `${childId}-2026-10-13`,
        questionId: "q3",
        optionId: "yes",
      },
      now,
      "2026-10-14",
    );
    expect(replay.feedback?.correct).toBe(true);
    expect(replay.snapshot).toEqual(current);

    await publish("unstarted");
    await publish("unstarted", "2026-10-14");
    expect((await get("unstarted", now, "2026-10-14")).activity?.date).toBe("2026-10-14");
  });

  it("publishes the whole batch atomically and keeps its scene once in evidence", async () => {
    const original = bundle("atomic");
    await publishBundle(original);
    expect(
      await store.execute({ type: "findDaily", input: { childId: "atomic", date: original.date } }),
    ).toEqual(original);
    const collision = bundle("atomic", "2026-10-14");
    collision.activities[2]!.id = original.activities[0]!.id;
    await expect(publishBundle(collision)).rejects.toThrow();
    expect(
      await store.execute({
        type: "findDaily",
        input: { childId: "atomic", date: collision.date },
      }),
    ).toBeNull();
    expect((await get("atomic", timestamp + 86_400_000, "2026-10-14")).daily?.date).toBe(
      original.date,
    );
    await publish("atomic", "2026-10-14");
    const context = await store.execute({
      type: "prepare",
      input: target("atomic", timestamp + 86_400_000, "2026-10-14"),
    });
    expect(context.recentActivities).toHaveLength(6);
    expect(context.recentScenes).toHaveLength(2);
  });

  it("retains a whole unfinished old day and prunes it after its evidence ages out", async () => {
    const childId = "retention";
    await publish(childId);
    await start(childId);
    const future = Date.parse("2027-02-01T12:00:00Z");
    await publishBundle(bundle(childId, "2027-02-01"), future, "2027-02-01");
    expect(
      (await store.execute({ type: "findDaily", input: { childId, date: "2026-10-13" } }))
        ?.activities,
    ).toHaveLength(3);
    for (const questionId of ["q1", "q2", "q3"]) {
      await mutate(
        childId,
        {
          kind: "answer",
          requestId: `finish-${questionId}`,
          activityId: `${childId}-2026-10-13`,
          questionId,
          optionId: "yes",
        },
        future,
        "2027-02-01",
      );
    }
    const later = future + 91 * 86_400_000;
    await mutate(
      childId,
      { kind: "touch", requestId: "prune", source: "chat" },
      later,
      "2027-05-03",
    );
    expect(
      await store.execute({ type: "findDaily", input: { childId, date: "2026-10-13" } }),
    ).toBeNull();
  });

  it("refuses queued work after authority is revoked and leaves state unchanged", async () => {
    await publish("authority");
    await start("authority");
    let current = true;
    const result = answerGuarded();
    current = false;
    await expect(result).rejects.toThrow();
    expect((await get("authority")).activity?.currentIndex).toBe(0);
    function answerGuarded() {
      return mutate(
        "authority",
        {
          kind: "answer",
          requestId: "revoked",
          activityId: "authority-2026-10-13",
          questionId: "q1",
          optionId: "yes",
        },
        timestamp,
        "2026-10-13",
        () => {
          if (!current) {
            throw new Error("revoked");
          }
        },
      );
    }
  });

  it("persists state across worker close and refuses work through a retired store", async () => {
    const before = await get("hints");
    const retired = store;
    await store.close();
    await expect(retired.execute({ type: "get", input: target("hints") })).rejects.toThrow();
    store = await openSqliteWorkerStore<ActivityStoreOperations>({
      moduleUrl,
      databasePath,
      input: undefined,
    });
    expect(await get("hints")).toEqual(before);
  });
});
