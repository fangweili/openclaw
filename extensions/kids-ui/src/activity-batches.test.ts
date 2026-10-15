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
import type {
  ActivityContinueMutation,
  ActivityDefinition,
  ActivityDirectMutation,
  DailyActivityBundle,
} from "./activity-contract.js";
import type { ActivityStoreOperations } from "./activity-store-contract.js";

const date = "2026-10-14";
const now = Date.parse("2026-10-14T17:00:00Z");
let directory: string;
let databasePath: string;
let store: SqliteWorkerStore<ActivityStoreOperations>;
const target = (childId: string, day = date) => ({ childId, date: day, now });

function batch(id: string): ActivityDefinition {
  return {
    id,
    title: "Number detective",
    subject: "Math and reasoning",
    questions: Array.from({ length: 10 }, (_, index) => ({
      id: `q${index + 1}`,
      kind: "numeric",
      prompt: "What is one half as a fraction?",
      answer: "1/2",
      unit: null,
      hint: "Think of two equal parts.",
      explanation: "One of two equal parts is 1/2.",
    })),
  };
}
function daily(childId: string, day = date): DailyActivityBundle {
  return {
    childId,
    date: day,
    activities: [batch(`${childId}-${day}`)],
    learningBrief: "The learner is exploring equivalent fractions; use short written answers.",
    scene: {
      normal: { imageId: "normal", caption: "Ready to explore." },
      excited: { imageId: "excited", caption: "What a discovery!" },
    },
    scenePrompt: "Rocky investigates patterns with a magnifying glass.",
    stateText: { bored: "Wondering about our next adventure.", sleeping: "Taking a nap." },
  };
}
function write<K extends "publish" | "mutate" | "publishNext">(
  type: K,
  input: ActivityStoreOperations[K]["input"],
  assertCurrent = () => {},
) {
  return runSqliteWorkerStoreWrite(
    store,
    (scope) => scope.execute({ type, input }),
    assertCurrent,
    [databasePath],
  );
}
function publish(childId: string, value = daily(childId)) {
  return write("publish", { ...target(childId), bundle: value });
}
function get(childId: string, day = date) {
  return store.execute({ type: "get", input: target(childId, day) });
}
function mutate(childId: string, mutation: ActivityDirectMutation, day = date) {
  return write("mutate", { ...target(childId, day), mutation });
}
function continuation(
  activityId: string,
  requestId = `continue-${activityId}`,
): ActivityContinueMutation {
  return { kind: "continue", activityId, requestId };
}
function plan(childId: string, mutation: ActivityContinueMutation, day = date) {
  return store.execute({ type: "planNext", input: { ...target(childId, day), mutation } });
}
function append(
  childId: string,
  mutation: ActivityContinueMutation,
  activity: ActivityDefinition,
  day = date,
  assertCurrent = () => {},
) {
  return write(
    "publishNext",
    { ...target(childId, day), mutation, activity, generationDate: date },
    assertCurrent,
  );
}
/** Complete the selected batch through real mutations, retaining all graded evidence. */
async function finish(childId: string, day = date) {
  let snapshot = await get(childId, day);
  const activityId = snapshot.activity!.id;
  if (!snapshot.activity!.started) {
    snapshot = (
      await mutate(childId, { kind: "start", activityId, requestId: `start-${activityId}` }, day)
    ).snapshot;
  }
  while (!snapshot.activity!.completed) {
    const questionId = snapshot.activity!.currentQuestion!.id;
    snapshot = (
      await mutate(
        childId,
        {
          kind: "answer",
          activityId,
          questionId,
          requestId: `answer-${activityId}-${questionId}`,
          answer: { kind: "numeric", text: "1/2" },
        },
        day,
      )
    ).snapshot;
  }
  return snapshot;
}
/** Inspect only the synthetic database, with no worker operations outstanding. */
function inspect<T>(read: (db: DatabaseSync) => T): T {
  const db = new DatabaseSync(databasePath);
  try {
    return read(db);
  } finally {
    db.close();
  }
}

beforeAll(async () => {
  directory = await fs.mkdtemp(path.join(os.tmpdir(), "kids-batches-"));
  databasePath = path.join(directory, "activities.sqlite");
  store = await openSqliteWorkerStore<ActivityStoreOperations>({
    moduleUrl: resolveRuntimeWorkerUrl({
      currentModuleUrl: import.meta.url,
      sourceWorkerName: "activity-store.worker",
      distWorkerPath: "extensions/kids-ui/src/activity-store.worker.js",
    }),
    databasePath,
    input: { children: [], now },
  });
});
afterAll(async () => {
  await store?.close();
  await fs.rm(directory, { recursive: true, force: true });
});

describe("adaptive ten-question batches", () => {
  it("fixes the daily goal while any number of extra batches use the preceding result", async () => {
    const childId = "continuing";
    await publish(childId);
    const completed = await finish(childId);
    expect(completed).toMatchObject({
      daily: {
        total: 1,
        completed: 1,
        questionTotal: 10,
        questionsSolved: 10,
        firstTryCorrect: 10,
      },
      extras: { questionsSolved: 0, firstTryCorrect: 0, hintedQuestions: 0 },
      perfectDayStreak: 1,
      canContinue: true,
      activity: { scope: "daily", total: 10, firstTryCorrect: 10, hintedQuestions: 0 },
    });
    let previousId = completed.activity!.id;
    for (let ordinal = 1; ordinal <= 2; ordinal += 1) {
      const mutation = continuation(previousId);
      const prepared = await plan(childId, mutation);
      expect(prepared).toMatchObject({
        kind: "generate",
        date,
        learningBrief: daily(childId).learningBrief,
        previous: {
          id: previousId,
          scope: ordinal === 1 ? "daily" : "extra",
          completed: true,
          attemptsOmitted: 0,
        },
      });
      if (prepared.kind !== "generate") {
        throw new Error("Expected generation plan");
      }
      expect(prepared.previous.questions).toHaveLength(10);
      expect(prepared.previous.attempts).toHaveLength(10);
      expect(prepared.history.map((activity) => activity.id)).not.toContain(previousId);
      expect(prepared.history).toHaveLength(ordinal - 1);
      expect(prepared.historyOmitted).toBe(0);
      const id = `${childId}-extra-${ordinal}`;
      const opened = await append(childId, mutation, batch(id));
      expect(opened.snapshot).toMatchObject({
        activity: {
          id,
          scope: "extra",
          started: true,
          currentIndex: 0,
          currentQuestion: { id: "q1" },
        },
        canContinue: false,
      });
      expect(opened.snapshot.daily).toEqual(completed.daily);
      const finished = await finish(childId);
      expect(finished.daily).toEqual(completed.daily);
      expect(finished.extras.questionsSolved).toBe(ordinal * 10);
      expect(finished.canContinue).toBe(true);
      expect(finished.perfectDayStreak).toBe(1);
      previousId = id;
    }
    const evidence = await store.execute({ type: "prepare", input: target(childId) });
    expect(evidence.learningBrief).toBe(daily(childId).learningBrief);
    expect(evidence.recentActivities.map(({ id, scope }) => ({ id, scope }))).toEqual([
      { id: "continuing-extra-2", scope: "extra" },
      { id: "continuing-extra-1", scope: "extra" },
      { id: daily(childId).activities[0]!.id, scope: "daily" },
    ]);
    expect(evidence.recentActivities.flatMap((activity) => activity.attempts)).toHaveLength(30);
    expect(JSON.stringify(completed)).not.toContain("learningBrief");
    expect(inspect((db) => db.prepare("PRAGMA user_version").get()?.user_version)).toBe(3);
  });

  it("serializes two devices and replays a predecessor even after its receipt expires", async () => {
    const childId = "race";
    await publish(childId);
    const finished = await finish(childId);
    const mutation = continuation(finished.activity!.id);
    const [first, second] = await Promise.all([
      append(childId, mutation, batch("race-first")),
      append(childId, { ...mutation, requestId: "other-device" }, batch("race-second")),
    ]);
    expect(first.snapshot.activity?.id).toBe(second.snapshot.activity?.id);
    expect(
      inspect(
        (db) =>
          db.prepare("SELECT count(*) AS count FROM kids_activity WHERE child_id = ?").get(childId)
            ?.count,
      ),
    ).toBe(2);
    const before = await get(childId);
    // Simulate the receipt owner's documented pruning boundary without 512 unrelated calls.
    inspect((db) =>
      db
        .prepare("DELETE FROM kids_request WHERE child_id = ? AND input LIKE ?")
        .run(childId, '["continue",%'),
    );
    expect(await plan(childId, { ...mutation, requestId: "after-pruning" })).toEqual({
      kind: "replay",
      result: { snapshot: before },
    });
    expect((await append(childId, mutation, batch("must-not-append"))).snapshot).toEqual(before);
    expect((await plan(childId, mutation, "2026-10-15")).kind).toBe("replay");
  });

  it("rejects incomplete, stale, foreign, colliding or revoked publication without partial state", async () => {
    const childId = "admission";
    await publish(childId);
    const activityId = daily(childId).activities[0]!.id;
    const mutation = continuation(activityId);
    await expect(plan(childId, mutation)).rejects.toThrow("Finish");
    await finish(childId);
    const before = await get(childId);
    await expect(plan("another-child", mutation)).rejects.toThrow("Finish");
    await expect(append(childId, mutation, batch(activityId))).rejects.toThrow();
    expect(await get(childId)).toEqual(before);
    await expect(append(childId, mutation, batch("stale"), "2026-10-15")).rejects.toThrow(
      "current day",
    );
    expect(await get(childId)).toEqual(before);
    let current = true;
    const canceled = append(childId, mutation, batch("canceled"), date, () => {
      if (!current) {
        throw new Error("Revoked");
      }
    });
    current = false;
    await expect(canceled).rejects.toThrow();
    expect(await get(childId)).toEqual(before);
    await mutate(childId, { kind: "touch", source: "chat", requestId: "occupied" });
    await expect(plan(childId, { ...mutation, requestId: "occupied" })).rejects.toThrow(
      "already used",
    );
  });

  it("totals every extra batch's hints and corrected answers without changing the daily goal", async () => {
    const childId = "extra-evidence";
    await publish(childId);
    const dailyResult = await finish(childId);
    const id = "extra-evidence-next";
    await append(childId, continuation(dailyResult.activity!.id), batch(id));
    await mutate(childId, { kind: "hint", activityId: id, questionId: "q1", requestId: "hint" });
    await mutate(childId, {
      kind: "answer",
      activityId: id,
      questionId: "q1",
      requestId: "wrong",
      answer: { kind: "numeric", text: "3" },
    });
    const done = await finish(childId);
    expect(done.daily).toEqual(dailyResult.daily);
    expect(done.extras).toEqual({ questionsSolved: 10, firstTryCorrect: 9, hintedQuestions: 1 });
    expect(done.perfectDayStreak).toBe(1);
    expect(done.activity).toMatchObject({ scope: "extra", firstTryCorrect: 9, hintedQuestions: 1 });
    const prepared = await plan(childId, continuation(id));
    expect(prepared).toMatchObject({
      kind: "generate",
      previous: {
        questions: [
          expect.objectContaining({
            questionId: "q1",
            attempts: 2,
            hintUsed: true,
            independent: false,
          }),
          ...Array.from({ length: 9 }, () => expect.anything()),
        ],
      },
    });
    if (prepared.kind !== "generate") {
      throw new Error("Expected generation plan");
    }
    expect(prepared.previous.attempts[0]).toMatchObject({
      answerText: "3",
      outcome: "revise",
      hintUsed: true,
    });
    const secondId = "extra-evidence-second";
    await append(childId, continuation(id), batch(secondId));
    for (const requestId of ["second-hint", "second-hint-again"]) {
      await mutate(childId, {
        kind: "hint",
        activityId: secondId,
        questionId: "q1",
        requestId,
      });
    }
    const clarified = await mutate(childId, {
      kind: "answer",
      activityId: secondId,
      questionId: "q1",
      requestId: "second-clarification",
      answer: { kind: "numeric", text: "half" },
    });
    expect(clarified.feedback?.outcome).toBe("clarify");
    expect(clarified.snapshot.extras).toEqual({
      questionsSolved: 10,
      firstTryCorrect: 9,
      hintedQuestions: 2,
    });
    const secondDone = await finish(childId);
    expect(secondDone.extras).toEqual({
      questionsSolved: 20,
      firstTryCorrect: 19,
      hintedQuestions: 2,
    });
    expect(secondDone.activity).toMatchObject({ firstTryCorrect: 10, hintedQuestions: 1 });

    const thirdId = "extra-evidence-third";
    await append(childId, continuation(secondId), batch(thirdId));
    await mutate(childId, {
      kind: "hint",
      activityId: thirdId,
      questionId: "q1",
      requestId: "third-hint",
    });
    await mutate(childId, {
      kind: "answer",
      activityId: thirdId,
      questionId: "q1",
      requestId: "third-answer",
      answer: { kind: "numeric", text: "1/2" },
    });
    const partial = await get(childId);
    expect(partial.extras).toEqual({
      questionsSolved: 21,
      firstTryCorrect: 20,
      hintedQuestions: 3,
    });
    expect(partial.activity).toMatchObject({
      id: thirdId,
      completed: false,
      currentIndex: 1,
      firstTryCorrect: 1,
      hintedQuestions: 1,
    });
    expect(partial.daily).toEqual(dailyResult.daily);
    expect(partial.perfectDayStreak).toBe(1);
  });

  it("preserves an unfinished extra across a new day and then resumes the new daily goal", async () => {
    const childId = "carry-extra";
    await publish(childId);
    const done = await finish(childId);
    await append(childId, continuation(done.activity!.id), batch("carry-extra-batch"));
    await mutate(childId, {
      kind: "answer",
      activityId: "carry-extra-batch",
      questionId: "q1",
      requestId: "first-extra",
      answer: { kind: "numeric", text: "1/2" },
    });
    await publish(childId, daily(childId, "2026-10-15"));
    const tomorrow = await get(childId, "2026-10-15");
    expect(tomorrow.activity).toMatchObject({
      id: "carry-extra-batch",
      date,
      scope: "extra",
      currentIndex: 1,
    });
    expect(tomorrow.daily).toMatchObject({
      date: "2026-10-15",
      questionTotal: 10,
      questionsSolved: 0,
    });
    expect(tomorrow.extras).toEqual({ questionsSolved: 0, firstTryCorrect: 0, hintedQuestions: 0 });
    const history = await store.execute({ type: "prepare", input: target(childId, "2026-10-15") });
    expect(history.recentActivities.map(({ id, scope }) => ({ id, scope }))).toEqual([
      { id: daily(childId, "2026-10-15").activities[0]!.id, scope: "daily" },
      { id: "carry-extra-batch", scope: "extra" },
      { id: daily(childId).activities[0]!.id, scope: "daily" },
    ]);
    // Finishing the carryover switches selection to the new day, so finish only its remaining questions.
    for (let index = 2; index <= 10; index += 1) {
      await mutate(
        childId,
        {
          kind: "answer",
          activityId: "carry-extra-batch",
          questionId: `q${index}`,
          requestId: `carry-${index}`,
          answer: { kind: "numeric", text: "1/2" },
        },
        "2026-10-15",
      );
    }
    expect((await get(childId, "2026-10-15")).activity).toMatchObject({
      scope: "daily",
      started: false,
      date: "2026-10-15",
    });
  });

  it("admits only complete mostly-free ten-question batches and bounded teaching context", async () => {
    const childId = "validation";
    const value = daily(childId);
    for (const invalid of [
      { ...value, learningBrief: undefined },
      { ...value, learningBrief: "x".repeat(8001) },
      {
        ...value,
        activities: [
          { ...value.activities[0]!, questions: value.activities[0]!.questions.slice(0, 9) },
        ],
      },
    ]) {
      await expect(publish(childId, invalid)).rejects.toThrow();
      expect((await get(childId)).daily).toBeNull();
    }
    const mixed = daily(childId);
    for (let index = 0; index < 3; index += 1) {
      mixed.activities[0]!.questions[index] = {
        id: `q${index + 1}`,
        kind: "choice",
        prompt: "Which equals one half?",
        options: [
          { id: "half", text: "1/2" },
          { id: "whole", text: "1" },
        ],
        correctOptionId: "half",
        hint: "Think of two equal parts.",
        explanation: "One of two equal parts is half.",
      };
    }
    await expect(publish(childId, mixed)).rejects.toThrow("eight free-answer");
    mixed.activities[0]!.questions[2] = value.activities[0]!.questions[2]!;
    await publish(childId, mixed);
    expect((await get(childId)).daily?.questionTotal).toBe(10);
  });
});
