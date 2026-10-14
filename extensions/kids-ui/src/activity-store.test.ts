import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
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
  type ActivityGrade,
  type ActivityPracticeOffer,
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
        kind: "choice" as const,
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
  grade?: ActivityGrade,
) {
  return runSqliteWorkerStoreWrite(
    store,
    (scope) =>
      scope.execute({ type: "mutate", input: { ...target(childId, now, date), mutation, grade } }),
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
      answer: { kind: "choice", optionId },
    },
    now,
  );
}
function get(childId: string, now = timestamp, date = "2026-10-13") {
  return store.execute({ type: "get", input: target(childId, now, date) });
}

function practice(childId: string): ActivityPracticeOffer {
  return {
    date: "2026-10-13",
    activity: {
      id: `${childId}-practice`,
      title: "Explain your idea",
      subject: "Math",
      questions: [
        {
          kind: "explanation",
          id: "why",
          prompt: "Why is 2 + 3 equal to 3 + 2?",
          hint: "Think about the same five counters.",
          explanation: "The same two groups are still there.",
          rubric: "Correct if the same groups are counted in a different order.",
        },
      ],
    },
  };
}
function offerPractice(
  childId: string,
  offer = practice(childId),
  guard = () => {},
  date = "2026-10-13",
) {
  return runSqliteWorkerStoreWrite(
    store,
    (scope) =>
      scope.execute({
        type: "offerPractice",
        input: { ...target(childId, timestamp, date), offer },
      }),
    guard,
    [databasePath],
  );
}
/** Exercise the real sequential child flow, including explicit starts between challenges. */
async function completeDay(childId: string) {
  for (const activity of bundle(childId).activities) {
    await mutate(childId, {
      kind: "start",
      activityId: activity.id,
      requestId: `start-${activity.id}`,
    });
    for (const question of activity.questions) {
      await mutate(childId, {
        kind: "answer",
        activityId: activity.id,
        questionId: question.id,
        requestId: `answer-${activity.id}-${question.id}`,
        answer: { kind: "choice", optionId: "yes" },
      });
    }
  }
}
/** Byte-level inspection of only this synthetic fixture, proving existing rows stay untouched. */
function savedRows(childId: string) {
  const db = new DatabaseSync(databasePath, { readOnly: true });
  try {
    return {
      pet: db.prepare("SELECT * FROM kids_pet WHERE child_id = ?").all(childId),
      day: db.prepare("SELECT * FROM kids_day WHERE child_id = ?").all(childId),
      activities: db
        .prepare("SELECT * FROM kids_activity WHERE child_id = ? ORDER BY ordinal")
        .all(childId),
      receipts: db
        .prepare("SELECT * FROM kids_request WHERE child_id = ? ORDER BY request_id")
        .all(childId),
    };
  } finally {
    db.close();
  }
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
  it("offers one optional question without changing any completed work, artwork or pet clocks", async () => {
    const childId = "practice-preservation";
    await publish(childId);
    await completeDay(childId);
    const before = savedRows(childId);
    const offered = await offerPractice(childId);
    expect(offered.published).toBe(true);
    expect(offered.snapshot.daily).toEqual({ date: "2026-10-13", total: 4, completed: 3 });
    expect(offered.snapshot.nextActivity).toEqual({
      id: `${childId}-practice`,
      title: "Explain your idea",
    });
    expect(offered.snapshot.activity?.id).toBe(bundle(childId).activities[2]?.id);
    expect(JSON.stringify(offered.snapshot)).not.toContain("rubric");
    const after = savedRows(childId);
    expect({ ...after, activities: after.activities.slice(0, 3) }).toEqual(before);
    expect(after.activities).toHaveLength(4);
    const originalBatch = await store.execute({
      type: "findDaily",
      input: { childId, date: "2026-10-13" },
    });
    expect(originalBatch).toEqual(bundle(childId));
    expect(await publish(childId)).toEqual({ published: false });
    const opened = await mutate(childId, {
      kind: "start",
      activityId: `${childId}-practice`,
      requestId: "open-practice",
    });
    expect(opened.snapshot.activity).toMatchObject({
      total: 1,
      started: true,
      currentQuestion: { kind: "explanation", id: "why", hint: null },
    });
    const answered = await mutate(
      childId,
      {
        kind: "answer",
        activityId: `${childId}-practice`,
        questionId: "why",
        requestId: "explain",
        answer: { kind: "explanation", text: "The same groups are counted in another order." },
      },
      timestamp,
      "2026-10-13",
      () => {},
      { outcome: "correct", explanation: "Exactly: the same groups." },
    );
    expect(answered.snapshot.daily?.completed).toBe(4);
    const complete = savedRows(childId);
    const offer = practice(childId);
    // Equivalent JSON objects may arrive with a different property order.
    const retry = {
      date: offer.date,
      activity: {
        questions: offer.activity.questions,
        subject: offer.activity.subject,
        title: offer.activity.title,
        id: offer.activity.id,
      },
    };
    expect((await offerPractice(childId, retry)).published).toBe(false);
    expect((await offerPractice(childId, retry, () => {}, "2026-10-14")).published).toBe(false);
    expect(savedRows(childId)).toEqual(complete);
    const evidence = await store.execute({ type: "prepare", input: target(childId) });
    expect(
      evidence.recentActivities.find((activity) => activity.id === offer.activity.id)?.attempts,
    ).toEqual([
      expect.objectContaining({
        answerText: "The same groups are counted in another order.",
        outcome: "correct",
        independent: true,
      }),
    ]);
  });

  it("refuses missing, incomplete, stale, malformed or conflicting practice offers atomically", async () => {
    const childId = "practice-refusal";
    await expect(offerPractice(childId)).rejects.toThrow("three challenges");
    await publish(childId);
    const initial = savedRows(childId);
    await expect(offerPractice(childId)).rejects.toThrow("three challenges");
    expect(savedRows(childId)).toEqual(initial);
    await completeDay(childId);
    const completed = savedRows(childId);
    const offer = practice(childId);
    await expect(offerPractice(childId, { ...offer, date: "2026-10-14" })).rejects.toThrow(
      "current local date",
    );
    await expect(
      offerPractice(childId, { ...offer, activity: { ...offer.activity, questions: [] } }),
    ).rejects.toThrow("complete questions");
    await expect(
      offerPractice(childId, {
        ...offer,
        activity: {
          ...offer.activity,
          questions: [
            {
              id: "number",
              kind: "numeric",
              prompt: "What is one half?",
              answer: "about half",
              unit: null,
              hint: "Try a fraction.",
              explanation: "One half is 1/2.",
            },
          ],
        },
      }),
    ).rejects.toThrow("exact decimal or fraction");
    expect(savedRows(childId)).toEqual(completed);
    await offerPractice(childId);
    const saved = savedRows(childId);
    await expect(
      offerPractice(childId, { ...offer, activity: { ...offer.activity, title: "Changed" } }),
    ).rejects.toThrow("different content");
    await expect(
      offerPractice(childId, { ...offer, activity: { ...offer.activity, id: "another-extra" } }),
    ).rejects.toThrow("one extra");
    expect(savedRows(childId)).toEqual(saved);
  });

  it("serializes competing offers and rechecks authority before committing", async () => {
    const childId = "practice-race";
    await publish(childId);
    await completeDay(childId);
    const before = savedRows(childId);
    let current = true;
    const rejected = offerPractice(childId, practice(childId), () => {
      if (!current) {
        throw new Error("revoked");
      }
    });
    current = false;
    await expect(rejected).rejects.toThrow();
    expect(savedRows(childId)).toEqual(before);
    const offer = practice(childId);
    const results = await Promise.allSettled([
      offerPractice(childId, offer),
      offerPractice(childId, offer),
      offerPractice(childId, { ...offer, activity: { ...offer.activity, id: "competing-extra" } }),
    ]);
    expect(
      results
        .filter((result) => result.status === "fulfilled")
        .map((result) => result.value.published)
        .toSorted(),
    ).toEqual([false, true]);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
    expect((await get(childId)).daily).toEqual({ date: "2026-10-13", total: 4, completed: 3 });
    expect(savedRows(childId).activities).toHaveLength(4);
  });

  it("keeps child projections separate and never exposes answer keys or unopened hints", async () => {
    await publish("projection");
    const snapshot = await get("projection");
    expect(snapshot.activity?.currentQuestion).toEqual({
      id: "q1",
      kind: "choice",
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
          answer: { kind: "choice", optionId: "yes" },
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
    expect(corrected.feedback).toMatchObject({ outcome: "correct", independent: false });
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
          answer: { kind: "choice", optionId: "yes" },
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
        answer: { kind: "choice", optionId: "yes" },
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
          answer: { kind: "choice", optionId: "yes" },
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
        answer: { kind: "choice", optionId: "yes" },
      },
      now,
      "2026-10-14",
    );
    expect(replay.feedback?.outcome).toBe("correct");
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
          answer: { kind: "choice", optionId: "yes" },
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
          answer: { kind: "choice", optionId: "yes" },
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

  it("keeps exact numeric and explanation evidence atomic without treating clarification as wrong", async () => {
    const childId = "free";
    const value = bundle(childId);
    const questions = value.activities[0]!.questions;
    questions[0] = {
      kind: "numeric",
      id: "q1",
      prompt: "What is half as a decimal?",
      answer: "1/2",
      unit: null,
      hint: "Use equal parts.",
      explanation: "Half is 0.5.",
    };
    questions[1] = {
      kind: "explanation",
      id: "q2",
      prompt: "Why do equal halves make a whole?",
      rubric: "Both original equal pieces cover the whole.",
      hint: "Think about covering.",
      explanation: "They cover the original whole.",
    };
    questions[2] = { ...questions[1], id: "q3" };
    await publishBundle(value);
    await start(childId);
    expect((await get(childId)).activity?.currentQuestion).toEqual({
      kind: "numeric",
      id: "q1",
      prompt: questions[0].prompt,
      unit: null,
      hint: null,
    });
    const numeric: ActivityMutation = {
      kind: "answer",
      requestId: "numeric-invalid",
      activityId: value.activities[0]!.id,
      questionId: "q1",
      answer: { kind: "numeric", text: "half" },
    };
    const invalid = await mutate(childId, numeric);
    expect(invalid.feedback?.outcome).toBe("clarify");
    const correct = await mutate(childId, {
      ...numeric,
      requestId: "numeric",
      answer: { kind: "numeric", text: "2/4" },
    });
    expect(correct.feedback).toMatchObject({ outcome: "correct", independent: true });
    expect(JSON.stringify(correct.snapshot)).not.toMatch(/rubric|Both original|correctOptionId/u);
    const submission = {
      kind: "answer" as const,
      requestId: "clarify",
      activityId: value.activities[0]!.id,
      questionId: "q2",
      answer: { kind: "explanation" as const, text: "Because it does" },
    };
    const plan = await store.execute({
      type: "planAnswer",
      input: { ...target(childId), mutation: submission },
    });
    expect(plan).toMatchObject({ kind: "grade", question: { rubric: questions[1].rubric } });
    const clarify: ActivityGrade = {
      outcome: "clarify",
      explanation: "Can you explain what you mean by it?",
    };
    const clarified = await mutate(childId, submission, timestamp, "2026-10-13", () => {}, clarify);
    expect(clarified.snapshot.correctStreak).toBe(1);
    expect(clarified.snapshot.activity?.currentIndex).toBe(1);
    expect(
      await store.execute({
        type: "planAnswer",
        input: { ...target(childId), mutation: submission },
      }),
    ).toMatchObject({ kind: "replay", result: { feedback: { outcome: "clarify" } } });
    const answered = await mutate(
      childId,
      {
        ...submission,
        requestId: "explain",
        answer: { kind: "explanation", text: "Both pieces cover the same whole" },
      },
      timestamp,
      "2026-10-13",
      () => {},
      { outcome: "correct", explanation: "You explained the equal pieces." },
    );
    expect(answered.feedback).toMatchObject({ outcome: "correct", independent: true });
    const third = { ...submission, questionId: "q3", requestId: "third" };
    await store.execute({ type: "planAnswer", input: { ...target(childId), mutation: third } });
    await mutate(childId, {
      kind: "hint",
      requestId: "hint-after-plan",
      activityId: submission.activityId,
      questionId: "q3",
    });
    const hinted = await mutate(childId, third, timestamp, "2026-10-13", () => {}, {
      outcome: "correct",
      explanation: "You explained it.",
    });
    expect(hinted.feedback?.independent).toBe(false);
    // A different request cannot commit the old plan after another answer advanced progress.
    await expect(
      mutate(childId, { ...third, requestId: "stale-grade" }, timestamp, "2026-10-13", () => {}, {
        outcome: "correct",
        explanation: "Late",
      }),
    ).rejects.toThrow("already complete");
    const context = await store.execute({ type: "prepare", input: target(childId) });
    const evidence = context.recentActivities.find((entry) => entry.id === submission.activityId)!;
    expect(evidence.attempts).toHaveLength(5);
    expect(evidence.attemptsOmitted).toBe(0);
    expect(evidence.questions.map((entry) => entry.attempts)).toEqual([1, 1, 1]);
    expect(evidence.attempts[2]).toMatchObject({
      outcome: "clarify",
      answerText: "Because it does",
      ordinal: 0,
    });
  });

  it("migrates version-one questions, evidence and receipts once while preserving saved progress", async () => {
    const file = path.join(directory, "legacy.sqlite");
    const fixture = new DatabaseSync(file);
    const oldQuestion = {
      id: "q1",
      prompt: "One plus one?",
      options: [
        { id: "yes", text: "2" },
        { id: "no", text: "3" },
      ],
      correctOptionId: "yes",
      hint: "Count on.",
      explanation: "One plus one is two.",
    };
    const oldDefinition = {
      id: "legacy-activity",
      title: "Adding",
      subject: "Math",
      questions: [oldQuestion, { ...oldQuestion, id: "q2" }, { ...oldQuestion, id: "q3" }],
    };
    const oldProgress = {
      started: true,
      completed: false,
      completedAt: null,
      index: 1,
      questions: oldDefinition.questions.map((q, index) => ({
        questionId: q.id,
        prompt: q.prompt,
        attempts: index === 0 ? 1 : 0,
        hintUsed: false,
        correct: index === 0,
        independent: index === 0,
      })),
      attempts: [
        {
          id: "legacy-answer",
          at: timestamp,
          activityId: oldDefinition.id,
          questionId: "q1",
          optionId: "yes",
          answerText: "2",
          ordinal: 1,
          hintUsed: false,
          correct: true,
          independent: true,
        },
      ],
    };
    const oldFeedback = {
      questionId: "q1",
      correct: true,
      independent: true,
      explanation: oldQuestion.explanation,
    };
    fixture.exec(`
      CREATE TABLE kids_pet(child_id TEXT PRIMARY KEY,active_id TEXT,last_interaction INTEGER,excited_until INTEGER,streak INTEGER NOT NULL) STRICT;
      CREATE TABLE kids_day(child_id TEXT NOT NULL,date TEXT NOT NULL,created_at INTEGER NOT NULL,content TEXT NOT NULL,PRIMARY KEY(child_id,date)) STRICT;
      CREATE TABLE kids_activity(child_id TEXT NOT NULL,activity_id TEXT NOT NULL,date TEXT NOT NULL,ordinal INTEGER NOT NULL,updated_at INTEGER NOT NULL,definition TEXT NOT NULL,progress TEXT NOT NULL,PRIMARY KEY(child_id,activity_id),UNIQUE(child_id,date,ordinal),FOREIGN KEY(child_id,date) REFERENCES kids_day(child_id,date) ON DELETE CASCADE) STRICT;
      CREATE TABLE kids_request(child_id TEXT NOT NULL,request_id TEXT NOT NULL,created_at INTEGER NOT NULL,input TEXT NOT NULL,feedback TEXT,PRIMARY KEY(child_id,request_id)) STRICT;
      PRAGMA user_version = 1;
    `);
    try {
      const daily = bundle("legacy");
      fixture.prepare("INSERT INTO kids_day VALUES(?,?,?,?)").run(
        "legacy",
        daily.date,
        timestamp,
        JSON.stringify({
          scene: daily.scene,
          stateText: daily.stateText,
          scenePrompt: daily.scenePrompt,
        }),
      );
      fixture
        .prepare("INSERT INTO kids_activity VALUES(?,?,?,?,?,?,?)")
        .run(
          "legacy",
          oldDefinition.id,
          daily.date,
          0,
          timestamp,
          JSON.stringify(oldDefinition),
          JSON.stringify(oldProgress),
        );
      fixture
        .prepare("INSERT INTO kids_pet VALUES(?,?,?,?,?)")
        .run("legacy", oldDefinition.id, timestamp, null, 1);
      fixture.prepare("INSERT INTO kids_request VALUES(?,?,?,?,?)").run(
        "legacy",
        "legacy-answer",
        timestamp,
        JSON.stringify({
          kind: "answer",
          requestId: "legacy-answer",
          activityId: oldDefinition.id,
          questionId: "q1",
          optionId: "yes",
        }),
        JSON.stringify(oldFeedback),
      );
    } finally {
      fixture.close();
    }
    const migrated = await openSqliteWorkerStore<ActivityStoreOperations>({
      moduleUrl,
      databasePath: file,
      input: undefined,
    });
    try {
      const context = await migrated.execute({ type: "prepare", input: target("legacy") });
      expect(context.snapshot).toMatchObject({
        correctStreak: 1,
        pet: { lastInteractionAt: timestamp },
        activity: { started: true, currentIndex: 1, currentQuestion: { id: "q2", kind: "choice" } },
      });
      expect(context.recentActivities[0]?.questions).toEqual(oldProgress.questions);
      expect(context.recentActivities[0]?.attempts[0]).toMatchObject({
        answer: { kind: "choice", optionId: "yes" },
        outcome: "correct",
        at: timestamp,
      });
      const replay = await runSqliteWorkerStoreWrite(
        migrated,
        (scope) =>
          scope.execute({
            type: "mutate",
            input: {
              ...target("legacy"),
              mutation: {
                kind: "answer",
                requestId: "legacy-answer",
                activityId: oldDefinition.id,
                questionId: "q1",
                answer: { kind: "choice", optionId: "yes" },
              },
            },
          }),
        () => {},
        [file],
      );
      expect(replay.feedback).toEqual({
        questionId: "q1",
        outcome: "correct",
        independent: true,
        explanation: oldQuestion.explanation,
      });
      expect(replay.snapshot.activity?.currentIndex).toBe(1);
    } finally {
      await migrated.close();
    }
    const check = new DatabaseSync(file);
    try {
      expect(check.prepare("PRAGMA user_version").get()?.user_version).toBe(2);
    } finally {
      check.close();
    }
    const reopened = await openSqliteWorkerStore<ActivityStoreOperations>({
      moduleUrl,
      databasePath: file,
      input: undefined,
    });
    try {
      expect((await reopened.execute({ type: "get", input: target("legacy") })).correctStreak).toBe(
        1,
      );
    } finally {
      await reopened.close();
    }
    // A malformed later row must not leave an earlier row half-migrated.
    const damaged = new DatabaseSync(file);
    try {
      damaged
        .prepare("UPDATE kids_activity SET definition = ?, progress = ?")
        .run(JSON.stringify(oldDefinition), JSON.stringify(oldProgress));
      damaged
        .prepare("INSERT INTO kids_activity VALUES(?,?,?,?,?,?,?)")
        .run(
          "legacy",
          "broken",
          "2026-10-13",
          1,
          timestamp,
          "not-json",
          JSON.stringify(oldProgress),
        );
      damaged.exec("PRAGMA user_version = 1");
    } finally {
      damaged.close();
    }
    await expect(
      openSqliteWorkerStore<ActivityStoreOperations>({
        moduleUrl,
        databasePath: file,
        input: undefined,
      }),
    ).rejects.toThrow();
    const rolledBack = new DatabaseSync(file);
    try {
      expect(rolledBack.prepare("PRAGMA user_version").get()?.user_version).toBe(1);
      expect(
        JSON.parse(
          String(
            rolledBack
              .prepare("SELECT definition FROM kids_activity WHERE activity_id = ?")
              .get(oldDefinition.id)?.definition,
          ),
        ),
      ).toEqual(oldDefinition);
    } finally {
      rolledBack.close();
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
