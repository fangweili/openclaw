import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
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
  type DailyArtworkBundle,
  type ActivityDirectMutation,
  type ActivityGrade,
  type ActivityPracticeOffer,
} from "./activity-contract.js";
import { initialActivityProgress } from "./activity-progress.js";
import type { ActivityStoreOperations } from "./activity-store-contract.js";
import { dailyActivityBundle, legacyActivityBundle } from "./activity-test-helpers.js";

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
function publishNewBundle(value: DailyActivityBundle, now = timestamp, date = "2026-10-13") {
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
function publishArtwork(
  value: DailyArtworkBundle,
  replaceImageId?: string,
  guard = () => {},
  date = "2026-10-13",
) {
  const { childId, scene, scenePrompt, stateText, restImages } = value;
  const bundle = {
    childId,
    date: value.date,
    scene,
    scenePrompt,
    stateText,
    ...(restImages ? { restImages } : {}),
  };
  return runSqliteWorkerStoreWrite(
    store,
    (scope) =>
      scope.execute({
        type: "publishArtwork",
        input: { ...target(childId, timestamp, date), bundle, replaceImageId },
      }),
    guard,
    [databasePath],
  );
}
/** Seed migrated legacy-size days; current publication admits only new ten-question goals. */
function seedLegacyBundle(value: DailyActivityBundle & DailyArtworkBundle, now = timestamp) {
  const db = new DatabaseSync(databasePath);
  try {
    if (
      db
        .prepare("SELECT 1 FROM kids_day WHERE child_id = ? AND date = ?")
        .get(value.childId, value.date)
    ) {
      return Promise.resolve({ published: false });
    }
    db.exec("BEGIN IMMEDIATE");
    try {
      const { childId, date, activities, learningBrief, ...artwork } = value;
      db.prepare(
        "INSERT INTO kids_day(child_id,date,created_at,content,required_count) VALUES(?,?,?,?,?)",
      ).run(childId, date, now, JSON.stringify({ learningBrief }), activities.length);
      db.prepare("INSERT INTO kids_art(child_id,date,created_at,content) VALUES(?,?,?,?)").run(
        childId,
        date,
        now,
        JSON.stringify(artwork),
      );
      const insert = db.prepare("INSERT INTO kids_activity VALUES(?,?,?,?,?,?,?)");
      for (const [ordinal, activity] of activities.entries()) {
        insert.run(
          childId,
          activity.id,
          date,
          ordinal,
          now,
          JSON.stringify(activity),
          JSON.stringify(initialActivityProgress(activity)),
        );
      }
      db.exec("COMMIT");
      return Promise.resolve({ published: true });
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  } finally {
    db.close();
  }
}
function seedLegacyDay(childId: string, date = "2026-10-13") {
  return seedLegacyBundle(legacyActivityBundle(childId, date));
}
function mutate(
  childId: string,
  mutation: ActivityDirectMutation,
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
  for (const activity of legacyActivityBundle(childId).activities) {
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
    input: { children: [], now: timestamp },
  });
});
afterAll(async () => {
  await store?.close();
  await fs.rm(directory, { recursive: true, force: true });
});

describe("activity worker authority and progress", () => {
  it("offers one optional question without changing any completed work, artwork or pet clocks", async () => {
    const childId = "practice-preservation";
    await seedLegacyDay(childId);
    await completeDay(childId);
    const before = savedRows(childId);
    const offered = await offerPractice(childId);
    expect(offered.published).toBe(true);
    expect(offered.snapshot.daily).toEqual({
      date: "2026-10-13",
      total: 3,
      questionTotal: 9,
      completed: 3,
      questionsSolved: 9,
      firstTryCorrect: 9,
      hintedQuestions: 0,
    });
    expect(offered.snapshot.nextActivity).toEqual({
      id: `${childId}-practice`,
      title: "Explain your idea",
    });
    expect(offered.snapshot.activity?.id).toBe(legacyActivityBundle(childId).activities[2]?.id);
    expect(JSON.stringify(offered.snapshot)).not.toContain("rubric");
    const after = savedRows(childId);
    expect({ ...after, activities: after.activities.slice(0, 3) }).toEqual(before);
    expect(after.activities).toHaveLength(4);
    const originalBatch = await store.execute({
      type: "findDaily",
      input: { childId, date: "2026-10-13" },
    });
    expect(originalBatch).toEqual({
      childId,
      date: "2026-10-13",
      activities: legacyActivityBundle(childId).activities,
    });
    expect(await publishNewBundle(dailyActivityBundle(childId))).toEqual({ published: false });
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
    expect(answered.snapshot.daily).toEqual({
      date: "2026-10-13",
      total: 3,
      questionTotal: 9,
      completed: 3,
      questionsSolved: 9,
      firstTryCorrect: 9,
      hintedQuestions: 0,
    });
    expect(answered.snapshot.extras).toEqual({
      questionsSolved: 1,
      firstTryCorrect: 1,
      hintedQuestions: 0,
    });
    expect(answered.snapshot.activity).toMatchObject({
      scope: "extra",
      firstTryCorrect: 1,
      hintedQuestions: 0,
    });
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
    expect(evidence.recentActivities.map((activity) => activity.scope)).toEqual([
      "extra",
      "daily",
      "daily",
      "daily",
    ]);
    // Historical classification must use its owning day's legacy count, not today's new count.
    await publishNewBundle(dailyActivityBundle(childId, "2026-10-14"));
    const historical = await store.execute({
      type: "prepare",
      input: target(childId, timestamp, "2026-10-14"),
    });
    expect(historical.recentActivities.map(({ id, scope }) => ({ id, scope }))).toEqual([
      { id: dailyActivityBundle(childId, "2026-10-14").activities[0]!.id, scope: "daily" },
      ...evidence.recentActivities.map(({ id, scope }) => ({ id, scope })),
    ]);
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
    await expect(offerPractice(childId)).rejects.toThrow("scheduled challenges");
    await seedLegacyDay(childId);
    const initial = savedRows(childId);
    await expect(offerPractice(childId)).rejects.toThrow("scheduled challenges");
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
    await seedLegacyDay(childId);
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
        .toSorted((a, b) => Number(a) - Number(b)),
    ).toEqual([false, true]);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
    expect((await get(childId)).daily).toEqual({
      date: "2026-10-13",
      total: 3,
      questionTotal: 9,
      completed: 3,
      questionsSolved: 9,
      firstTryCorrect: 9,
      hintedQuestions: 0,
    });
    expect(savedRows(childId).activities).toHaveLength(4);
  });

  it("keeps child projections separate and never exposes answer keys or unopened hints", async () => {
    await seedLegacyDay("projection");
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
    expect(snapshot.daily).toEqual({
      date: "2026-10-13",
      total: 3,
      questionTotal: 9,
      completed: 0,
      questionsSolved: 0,
      firstTryCorrect: 0,
      hintedQuestions: 0,
    });
    expect(snapshot.nextActivity).toBeNull();
    expect((await get("other-child")).activity).toBeNull();
  });

  it("atomically grades and replays duplicates without awarding progress twice", async () => {
    await seedLegacyDay("replay");
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
    await seedLegacyDay("hints");
    await start("hints");
    await mutate("hints", {
      kind: "hint",
      activityId: "hints-2026-10-13",
      questionId: "q1",
      requestId: "hint-1",
    });
    const repeatedHint = await mutate("hints", {
      kind: "hint",
      activityId: "hints-2026-10-13",
      questionId: "q1",
      requestId: "hint-again",
    });
    expect(repeatedHint.snapshot.daily).toMatchObject({
      questionsSolved: 0,
      firstTryCorrect: 0,
      hintedQuestions: 1,
    });
    expect((await get("hints")).activity?.currentQuestion?.hint).toBe("Count one more.");
    expect((await answer("hints", 1, "a1")).feedback?.independent).toBe(false);
    await answer("hints", 2, "a2");
    await mutate("hints", { kind: "touch", source: "chat", requestId: "chat" });
    const finished = await answer("hints", 3, "a3");
    expect(finished.snapshot.pet.state).toBe("excited");
    expect(finished.snapshot.activity?.completed).toBe(true);
    expect(finished.snapshot.daily).toMatchObject({
      questionsSolved: 3,
      firstTryCorrect: 3,
      hintedQuestions: 1,
    });
    const context = await store.execute({ type: "prepare", input: target("hints") });
    expect(
      context.recentActivities.find((activity) => activity.id === "hints-2026-10-13")?.attempts,
    ).toEqual(
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
    await seedLegacyDay("wrong");
    await start("wrong");
    await answer("wrong", 1, "first");
    const incorrect = await answer("wrong", 2, "wrong", "no");
    expect(incorrect.snapshot.correctStreak).toBe(0);
    expect(incorrect.snapshot.activity?.currentIndex).toBe(1);
    expect(incorrect.snapshot.pet.state).toBe("normal");
    const corrected = await answer("wrong", 2, "correction");
    expect(corrected.feedback).toMatchObject({ outcome: "correct", independent: false });
    expect(corrected.snapshot.correctStreak).toBe(1);
    expect(corrected.snapshot.daily).toMatchObject({
      questionsSolved: 2,
      firstTryCorrect: 1,
      hintedQuestions: 0,
    });
  });

  it("uses server timestamps for sleep and preserves an ongoing celebration during chat", async () => {
    await seedLegacyDay("clocks");
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

  it("resumes an unfinished day while displaying the new day's scene and refuses replacements", async () => {
    await seedLegacyDay("resume");
    await start("resume");
    await answer("resume", 1, "a1");
    await seedLegacyDay("resume", "2026-10-14");
    expect(await publishNewBundle(dailyActivityBundle("resume"))).toEqual({ published: false });
    const tomorrow = await get("resume", timestamp + 86_400_000, "2026-10-14");
    expect(tomorrow.activity?.date).toBe("2026-10-13");
    expect(tomorrow.activity?.currentIndex).toBe(1);
  });

  it("requires explicit ordered starts and finishes exactly three challenges", async () => {
    const childId = "batch";
    await seedLegacyDay(childId);
    const quizzes = legacyActivityBundle(childId).activities;
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
      expect(completed.daily).toEqual({
        date: "2026-10-13",
        total: 3,
        questionTotal: 9,
        completed: index + 1,
        questionsSolved: (index + 1) * 3,
        firstTryCorrect: (index + 1) * 3,
        hintedQuestions: 0,
      });
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
    await seedLegacyDay(childId);
    await start(childId);
    await answer(childId, 1, "old-q1");
    await seedLegacyDay(childId, "2026-10-14");
    const carry = await get(childId, now, "2026-10-14");
    expect(carry.activity).toMatchObject({ date: "2026-10-13", currentIndex: 1 });
    expect(carry.daily).toEqual({
      date: "2026-10-14",
      total: 3,
      questionTotal: 9,
      completed: 0,
      questionsSolved: 0,
      firstTryCorrect: 0,
      hintedQuestions: 0,
    });
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
    expect(current.daily).toEqual(carry.daily);
    expect(current.correctStreak).toBe(3);
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

    await seedLegacyDay("unstarted");
    await seedLegacyDay("unstarted", "2026-10-14");
    expect((await get("unstarted", now, "2026-10-14")).activity?.date).toBe("2026-10-14");
  });

  it("publishes the whole batch atomically and keeps its scene once in evidence", async () => {
    const original = dailyActivityBundle("atomic");
    await publishNewBundle(original);
    await publishArtwork(original);
    expect(
      await store.execute({ type: "findDaily", input: { childId: "atomic", date: original.date } }),
    ).toEqual({
      childId: original.childId,
      date: original.date,
      activities: original.activities,
      learningBrief: original.learningBrief,
    });
    const collision = dailyActivityBundle("atomic", "2026-10-14");
    collision.activities[0]!.id = original.activities[0]!.id;
    await expect(publishNewBundle(collision)).rejects.toThrow();
    expect(
      await store.execute({
        type: "findDaily",
        input: { childId: "atomic", date: collision.date },
      }),
    ).toBeNull();
    expect((await get("atomic", timestamp + 86_400_000, "2026-10-14")).daily?.date).toBe(
      original.date,
    );
    const next = dailyActivityBundle("atomic", "2026-10-14");
    await publishNewBundle(next);
    await publishArtwork(next);
    const context = await store.execute({
      type: "prepare",
      input: target("atomic", timestamp + 86_400_000, "2026-10-14"),
    });
    expect(context.recentActivities).toHaveLength(2);
    expect(context.recentScenes).toHaveLength(2);
  });

  it("retains a whole unfinished old day and prunes it after its evidence ages out", async () => {
    const childId = "retention";
    await seedLegacyDay(childId);
    await start(childId);
    const future = Date.parse("2027-02-01T12:00:00Z");
    await seedLegacyBundle(legacyActivityBundle(childId, "2027-02-01"), future);
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
    await seedLegacyDay("authority");
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
    const value = legacyActivityBundle(childId);
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
    await seedLegacyBundle(value);
    await start(childId);
    expect((await get(childId)).activity?.currentQuestion).toEqual({
      kind: "numeric",
      id: "q1",
      prompt: questions[0].prompt,
      unit: null,
      hint: null,
    });
    const numeric: ActivityDirectMutation = {
      kind: "answer",
      requestId: "numeric-invalid",
      activityId: value.activities[0]!.id,
      questionId: "q1",
      answer: { kind: "numeric", text: "half" },
    };
    const invalid = await mutate(childId, numeric);
    expect(invalid.feedback?.outcome).toBe("clarify");
    expect(invalid.snapshot.daily).toMatchObject({
      questionsSolved: 0,
      firstTryCorrect: 0,
      hintedQuestions: 0,
    });
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
    expect(clarified.snapshot.daily).toEqual(correct.snapshot.daily);
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
    expect(hinted.snapshot.daily).toMatchObject({
      questionsSolved: 3,
      firstTryCorrect: 3,
      hintedQuestions: 1,
    });
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

  it("persists state across worker close and refuses work through a retired store", async () => {
    const before = await get("hints");
    const retired = store;
    await store.close();
    await expect(retired.execute({ type: "get", input: target("hints") })).rejects.toThrow();
    store = await openSqliteWorkerStore<ActivityStoreOperations>({
      moduleUrl,
      databasePath,
      input: { children: [], now: timestamp },
    });
    expect(await get("hints")).toEqual(before);
  });
});
