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
  ActivityDefinition,
  ActivityDirectMutation,
  ActivityGrade,
  DailyActivityBundle,
  DailyArtworkBundle,
} from "./activity-contract.js";
import { initialActivityProgress, perfectDayStatus } from "./activity-progress.js";
import type { ActivityStoreOperations } from "./activity-store-contract.js";
import { activityDate } from "./activity-validation.js";

const today = "2026-11-02";
const now = Date.parse("2026-11-02T12:00:00Z");
const timeZone = "America/Chicago";
const moduleUrl = resolveRuntimeWorkerUrl({
  currentModuleUrl: import.meta.url,
  sourceWorkerName: "activity-store.worker",
  distWorkerPath: "extensions/kids-ui/src/activity-store.worker.js",
});
let directory: string;
let databasePath: string;
let store: SqliteWorkerStore<ActivityStoreOperations>;
let originalRows: ReturnType<typeof legacyRows>;
const children = [
  "clean",
  "hint",
  "wrong",
  "late",
  "gap",
  "retention",
  "seed-hint",
  "seed-retry",
  "seed-late",
  "seed-gap",
];
const admission = { children: children.map((childId) => ({ childId, timeZone })), now };

function activity(child: string, date: string, ordinal: number): ActivityDefinition {
  return {
    id: `${child}-${date}-${ordinal}`,
    title: "Number patterns",
    subject: "Math",
    questions: [1, 2, 3].map((id) => ({
      kind: "numeric",
      id: `q${id}`,
      prompt: "What is one half?",
      unit: null,
      answer: "0.5",
      hint: "Think of two equal parts.",
      explanation: "One half is 0.5.",
    })),
  };
}
function bundle(childId: string, date: string): DailyActivityBundle & DailyArtworkBundle {
  return {
    childId,
    date,
    activities: [0, 1, 2].map((ordinal) => activity(childId, date, ordinal)),
    scene: {
      normal: { imageId: "normal", caption: "Ready" },
      excited: { imageId: "excited", caption: "Great" },
    },
    stateText: { bored: "Wondering", sleeping: "Resting" },
    scenePrompt: "Rocky explores number patterns.",
  };
}
const target = (childId: string, date = today) => ({
  childId,
  date,
  now: Date.parse(`${date}T12:00:00Z`),
});
function get(childId: string, date = today) {
  return store.execute({ type: "get", input: target(childId, date) });
}
function mutate(
  childId: string,
  mutation: ActivityDirectMutation,
  date = today,
  grade?: ActivityGrade,
) {
  return runSqliteWorkerStoreWrite(
    store,
    (scope) =>
      scope.execute({ type: "mutate", input: { ...target(childId, date), mutation, grade } }),
    () => {},
    [databasePath],
  );
}
async function finish(childId: string, date = today) {
  for (;;) {
    const snapshot = await get(childId, date);
    const current = snapshot.activity!;
    if (current.completed) {
      if (!snapshot.nextActivity) {
        return snapshot;
      }
      await mutate(
        childId,
        {
          kind: "start",
          requestId: `start-${snapshot.nextActivity.id}`,
          activityId: snapshot.nextActivity.id,
        },
        date,
      );
    } else if (!current.started) {
      await mutate(
        childId,
        { kind: "start", requestId: `start-${current.id}`, activityId: current.id },
        date,
      );
    } else {
      await mutate(
        childId,
        {
          kind: "answer",
          requestId: `answer-${current.id}-${current.currentQuestion!.id}`,
          activityId: current.id,
          questionId: current.currentQuestion!.id,
          answer: { kind: "numeric", text: "1/2" },
        },
        date,
      );
    }
  }
}
/** A real shipped-v2 shape, independent of the candidate's schema declaration. */
function createV2Fixture(db: DatabaseSync) {
  db.exec(`
    CREATE TABLE kids_pet(child_id TEXT PRIMARY KEY,active_id TEXT,last_interaction INTEGER,excited_until INTEGER,streak INTEGER NOT NULL) STRICT;
    CREATE TABLE kids_day(child_id TEXT NOT NULL,date TEXT NOT NULL,created_at INTEGER NOT NULL,content TEXT NOT NULL,PRIMARY KEY(child_id,date)) STRICT;
    CREATE TABLE kids_activity(child_id TEXT NOT NULL,activity_id TEXT NOT NULL,date TEXT NOT NULL,ordinal INTEGER NOT NULL,updated_at INTEGER NOT NULL,definition TEXT NOT NULL,progress TEXT NOT NULL,PRIMARY KEY(child_id,activity_id),UNIQUE(child_id,date,ordinal),FOREIGN KEY(child_id,date) REFERENCES kids_day(child_id,date) ON DELETE CASCADE) STRICT;
    CREATE TABLE kids_request(child_id TEXT NOT NULL,request_id TEXT NOT NULL,created_at INTEGER NOT NULL,input TEXT NOT NULL,feedback TEXT,PRIMARY KEY(child_id,request_id)) STRICT;
    PRAGMA user_version = 2;
  `);
}
function seedDay(
  db: DatabaseSync,
  childId: string,
  date: string,
  state: "complete" | "hint" | "retry" | "late" | "incomplete" = "complete",
) {
  const value = bundle(childId, date);
  const timestamp = Date.parse(`${date}T12:00:00Z`);
  db.prepare("INSERT INTO kids_day VALUES(?,?,?,?)").run(
    childId,
    date,
    timestamp,
    JSON.stringify({
      scene: value.scene,
      stateText: value.stateText,
      scenePrompt: value.scenePrompt,
    }),
  );
  for (const [ordinal, definition] of value.activities.entries()) {
    const progress = initialActivityProgress(definition);
    if (state !== "incomplete") {
      progress.started = true;
      progress.completed = true;
      progress.index = 3;
      // UTC tomorrow is still the correct local date: migration must use child TZ.
      progress.completedAt = Date.parse(`${date}T00:00:00Z`) + 28.5 * 60 * 60_000;
      if (state === "late") {
        progress.completedAt += 86_400_000;
      }
      progress.questions.forEach((q) => {
        q.attempts = 1;
        q.correct = true;
        q.independent = true;
      });
      if (state === "hint") {
        progress.questions[0]!.hintUsed = true;
      }
      if (state === "retry") {
        progress.questions[0]!.attempts = 2;
      }
      progress.submissionCount = 3;
    }
    db.prepare("INSERT INTO kids_activity VALUES(?,?,?,?,?,?,?)").run(
      childId,
      definition.id,
      date,
      ordinal,
      timestamp,
      JSON.stringify(definition),
      JSON.stringify(progress),
    );
  }
}
function legacyRows(db: DatabaseSync) {
  return {
    days: db
      .prepare("SELECT child_id,date,created_at,content FROM kids_day ORDER BY child_id,date")
      .all(),
    activities: db.prepare("SELECT * FROM kids_activity ORDER BY child_id,activity_id").all(),
    pets: db
      .prepare(
        "SELECT child_id,active_id,last_interaction,excited_until,streak FROM kids_pet ORDER BY child_id",
      )
      .all(),
    receipts: db.prepare("SELECT * FROM kids_request ORDER BY child_id,request_id").all(),
  };
}

beforeAll(async () => {
  directory = await fs.mkdtemp(path.join(os.tmpdir(), "kids-perfect-days-"));
  databasePath = path.join(directory, "activities.sqlite");
  const db = new DatabaseSync(databasePath);
  try {
    createV2Fixture(db);
    for (const childId of [...children, "unknown"]) {
      db.prepare("INSERT INTO kids_pet VALUES(?,?,?,?,?)").run(
        childId,
        null,
        now - 1000,
        now + 1000,
        7,
      );
      db.prepare("INSERT INTO kids_request VALUES(?,?,?,?,?)").run(
        childId,
        "old-receipt",
        now - 1000,
        '["touch","old-receipt","chat"]',
        null,
      );
      if (childId === "retention") {
        // Seed 91 consecutive completed local days; old records can survive the
        // time-based retention rule until a later write performs pruning.
        for (let offset = 91; offset >= 1; offset -= 1) {
          const date = new Date(Date.parse(today) - offset * 86_400_000).toISOString().slice(0, 10);
          seedDay(db, childId, date);
        }
      } else if (childId.startsWith("seed-")) {
        seedDay(db, childId, "2026-10-31");
        if (childId !== "seed-gap") {
          seedDay(
            db,
            childId,
            "2026-11-01",
            childId === "seed-hint" ? "hint" : childId === "seed-retry" ? "retry" : "late",
          );
        }
      } else {
        seedDay(db, childId, "2026-10-31");
        seedDay(db, childId, "2026-11-01");
      }
      seedDay(db, childId, today, "incomplete");
    }
    originalRows = legacyRows(db);
  } finally {
    db.close();
  }
  store = await openSqliteWorkerStore<ActivityStoreOperations>({
    moduleUrl,
    databasePath,
    input: admission,
  });
});
afterAll(async () => {
  await store?.close();
  await fs.rm(directory, { recursive: true, force: true });
});

describe("durable perfect calendar days", () => {
  it("splits shipped schema-3 art while preserving brief, optional work and the existing streak", async () => {
    const file = path.join(directory, "schema-three.sqlite");
    const fixture = new DatabaseSync(file);
    const childId = "schema-three";
    let before: ReturnType<typeof legacyRows>;
    let pet: unknown;
    let artwork: Record<string, unknown>;
    try {
      createV2Fixture(fixture);
      seedDay(fixture, childId, today);
      fixture.exec(`
        ALTER TABLE kids_day ADD COLUMN required_count INTEGER NOT NULL DEFAULT 1 CHECK(required_count > 0);
        ALTER TABLE kids_pet ADD COLUMN perfect_day_streak INTEGER NOT NULL DEFAULT 0;
        ALTER TABLE kids_pet ADD COLUMN last_perfect_date TEXT;
        PRAGMA user_version = 3;
      `);
      fixture
        .prepare("INSERT INTO kids_pet VALUES(?,?,?,?,?,?,?)")
        .run(childId, null, now, now + 1000, 7, 9, today);
      fixture
        .prepare("INSERT INTO kids_request VALUES(?,?,?,?,?)")
        .run(childId, "receipt", now, '["touch","receipt","chat"]', null);
      const day = fixture.prepare("SELECT content FROM kids_day").get()!;
      artwork = {
        ...JSON.parse(String(day.content)),
        restImages: { bored: "rest-bored", sleeping: "rest-sleeping" },
      };
      fixture
        .prepare("UPDATE kids_day SET content=?")
        .run(JSON.stringify({ ...artwork, learningBrief: "Keep the existing teaching context." }));
      before = legacyRows(fixture);
      pet = fixture.prepare("SELECT * FROM kids_pet").all();
    } finally {
      fixture.close();
    }
    const migrated = await openSqliteWorkerStore<ActivityStoreOperations>({
      moduleUrl,
      databasePath: file,
      input: { children: [{ childId, timeZone }], now },
    });
    try {
      const goal = await migrated.execute({ type: "findDaily", input: { childId, date: today } });
      expect(goal?.learningBrief).toBe("Keep the existing teaching context.");
      expect(goal?.activities).toHaveLength(1);
      const art = await migrated.execute({ type: "findArtwork", input: { childId, date: today } });
      expect(art).toEqual({ childId, date: today, ...artwork });
      const context = await migrated.execute({ type: "prepare", input: target(childId) });
      expect(
        context.recentActivities.filter((evidence) => evidence.scope === "extra"),
      ).toHaveLength(2);
      expect(context.snapshot.perfectDayStreak).toBe(9);
    } finally {
      await migrated.close();
    }
    const check = new DatabaseSync(file, { readOnly: true });
    try {
      const after = legacyRows(check);
      expect({ ...after, days: undefined }).toEqual({ ...before, days: undefined });
      expect(after.days).toEqual(
        before.days.map((row) =>
          Object.assign({}, row, {
            content: JSON.stringify({ learningBrief: "Keep the existing teaching context." }),
          }),
        ),
      );
      expect(check.prepare("SELECT * FROM kids_pet").all()).toEqual(pet);
      expect(check.prepare("SELECT required_count FROM kids_day").get()?.required_count).toBe(1);
      expect(check.prepare("PRAGMA user_version").get()?.user_version).toBe(4);
    } finally {
      check.close();
    }
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
          at: now,
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
    createV2Fixture(fixture);
    fixture.exec("PRAGMA user_version = 1");
    try {
      const daily = bundle("legacy", today);
      fixture.prepare("INSERT INTO kids_day VALUES(?,?,?,?)").run(
        "legacy",
        daily.date,
        now,
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
          now,
          JSON.stringify(oldDefinition),
          JSON.stringify(oldProgress),
        );
      fixture
        .prepare("INSERT INTO kids_pet VALUES(?,?,?,?,?)")
        .run("legacy", oldDefinition.id, now, null, 1);
      fixture.prepare("INSERT INTO kids_request VALUES(?,?,?,?,?)").run(
        "legacy",
        "legacy-answer",
        now,
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
      input: { children: [], now },
    });
    try {
      const context = await migrated.execute({ type: "prepare", input: target("legacy") });
      expect(context.snapshot).toMatchObject({
        correctStreak: 1,
        pet: { lastInteractionAt: now },
        activity: { started: true, currentIndex: 1, currentQuestion: { id: "q2", kind: "choice" } },
      });
      expect(context.recentActivities[0]?.questions).toEqual(oldProgress.questions);
      expect(context.recentActivities[0]?.attempts[0]).toMatchObject({
        answer: { kind: "choice", optionId: "yes" },
        outcome: "correct",
        at: now,
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
      expect(check.prepare("PRAGMA user_version").get()?.user_version).toBe(4);
    } finally {
      check.close();
    }
    const reopened = await openSqliteWorkerStore<ActivityStoreOperations>({
      moduleUrl,
      databasePath: file,
      input: { children: [], now },
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
        .run("legacy", "broken", today, 1, now, "not-json", JSON.stringify(oldProgress));
      damaged.exec("PRAGMA user_version = 1");
    } finally {
      damaged.close();
    }
    await expect(
      openSqliteWorkerStore<ActivityStoreOperations>({
        moduleUrl,
        databasePath: file,
        input: { children: [], now },
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

  it("migrates v2 without changing quiz/evidence/receipts/pet clocks and seeds only known local history", async () => {
    const db = new DatabaseSync(databasePath, { readOnly: true });
    try {
      expect(db.prepare("PRAGMA user_version").get()?.user_version).toBe(4);
      expect(db.prepare("PRAGMA quick_check").get()?.quick_check).toBe("ok");
      const migrated = legacyRows(db);
      expect({ ...migrated, days: undefined }).toEqual({ ...originalRows, days: undefined });
      expect(migrated.days).toEqual(
        originalRows.days.map((row) => Object.assign({}, row, { content: "{}" })),
      );
      const art = db
        .prepare("SELECT child_id,date,created_at,content FROM kids_art ORDER BY child_id,date")
        .all();
      expect(
        art.map((row) => Object.assign({}, row, { content: JSON.parse(String(row.content)) })),
      ).toEqual(
        originalRows.days.map((row) =>
          Object.assign({}, row, { content: JSON.parse(String(row.content)) }),
        ),
      );
      expect(db.prepare("SELECT DISTINCT required_count FROM kids_day").all()).toEqual([
        { required_count: 3 },
      ]);
    } finally {
      db.close();
    }
    expect((await get("clean")).perfectDayStreak).toBe(2);
    expect((await get("unknown")).perfectDayStreak).toBe(0);
    for (const childId of ["seed-hint", "seed-retry", "seed-late", "seed-gap"]) {
      expect((await get(childId)).perfectDayStreak).toBe(0);
    }
    const progress = [0, 1].map((ordinal) =>
      initialActivityProgress(activity("count", today, ordinal)),
    );
    for (const item of progress) {
      item.completed = true;
      item.questions.forEach((q) => {
        q.correct = true;
        q.attempts = 1;
      });
    }
    expect(perfectDayStatus(progress, 2)).toBe("perfect");
    expect(perfectDayStatus(progress, 3)).toBe("incomplete");
  });

  it("awards once after the entire day; clarification/replay and optional practice do not spoil it", async () => {
    const childId = "clean";
    const activityId = activity(childId, today, 0).id;
    await mutate(childId, { kind: "start", requestId: "start-clean", activityId });
    const unclear: ActivityDirectMutation = {
      kind: "answer",
      requestId: "unclear",
      activityId,
      questionId: "q1",
      answer: { kind: "numeric", text: "perhaps half" },
    };
    expect((await mutate(childId, unclear)).feedback?.outcome).toBe("clarify");
    expect((await mutate(childId, unclear)).snapshot.perfectDayStreak).toBe(2);
    const complete = await finish(childId);
    expect(complete.perfectDayStreak).toBe(3);
    expect(complete.correctStreak).toBe(16);
    expect((await mutate(childId, unclear)).snapshot.perfectDayStreak).toBe(3);
    const extra = activity(childId, today, 3);
    extra.questions = extra.questions.slice(0, 1);
    await runSqliteWorkerStoreWrite(
      store,
      (scope) =>
        scope.execute({
          type: "offerPractice",
          input: { ...target(childId), offer: { date: today, activity: extra } },
        }),
      () => {},
      [databasePath],
    );
    await mutate(childId, { kind: "start", requestId: "start-extra", activityId: extra.id });
    const hint = await mutate(childId, {
      kind: "hint",
      requestId: "hint-extra",
      activityId: extra.id,
      questionId: "q1",
    });
    expect(hint.snapshot.perfectDayStreak).toBe(3);
    const wrong = await mutate(childId, {
      kind: "answer",
      requestId: "wrong-extra",
      activityId: extra.id,
      questionId: "q1",
      answer: { kind: "numeric", text: "4" },
    });
    expect(wrong.snapshot.perfectDayStreak).toBe(3);
    expect(wrong.snapshot.correctStreak).toBe(0);
  });

  it("immediately clears today's streak for a scheduled hint or wrong answer, even after later correction", async () => {
    for (const childId of ["hint", "wrong"]) {
      const activityId = activity(childId, today, 0).id;
      await mutate(childId, { kind: "start", requestId: "start", activityId });
      const mutation: ActivityDirectMutation =
        childId === "hint"
          ? { kind: "hint", requestId: "disqualify", activityId, questionId: "q1" }
          : {
              kind: "answer",
              requestId: "disqualify",
              activityId,
              questionId: "q1",
              answer: { kind: "numeric", text: "8" },
            };
      expect((await mutate(childId, mutation)).snapshot.perfectDayStreak).toBe(0);
      expect((await finish(childId)).perfectDayStreak).toBe(0);
    }
  });

  it("expires unfinished and missing calendar days at local midnight and never credits late carryover", async () => {
    // November 1 is a 25-hour local day; using now-minus-24h would miss boundaries.
    expect(activityDate(Date.parse("2026-11-03T05:59:59Z"), timeZone)).toBe(today);
    expect(activityDate(Date.parse("2026-11-03T06:00:00Z"), timeZone)).toBe("2026-11-03");
    expect((await get("gap", today)).perfectDayStreak).toBe(2);
    expect((await get("gap", "2026-11-03")).perfectDayStreak).toBe(0);
    expect((await get("gap", "2026-11-04")).perfectDayStreak).toBe(0);
    const childId = "late";
    const activityId = activity(childId, today, 0).id;
    await mutate(childId, { kind: "start", requestId: "start", activityId });
    expect((await finish(childId, "2026-11-03")).perfectDayStreak).toBe(0);
    expect((await get(childId, today)).perfectDayStreak).toBe(2);
  });

  it("continues a streak beyond retained history and restart while distinguishing new daily goals", async () => {
    expect((await get("retention")).perfectDayStreak).toBe(91);
    const complete = await finish("retention");
    expect(complete.perfectDayStreak).toBe(92);
    const firstDate = new Date(Date.parse(today) - 91 * 86_400_000).toISOString().slice(0, 10);
    expect(
      await store.execute({ type: "findDaily", input: { childId: "retention", date: firstDate } }),
    ).toBeNull();
    await store.close();
    store = await openSqliteWorkerStore<ActivityStoreOperations>({
      moduleUrl,
      databasePath,
      input: { children: [], now },
    });
    expect(await get("retention")).toEqual(complete);
    const tomorrow = "2026-11-03";
    await runSqliteWorkerStoreWrite(
      store,
      (scope) =>
        scope.execute({
          type: "publish",
          input: {
            ...target("retention", tomorrow),
            bundle: {
              ...bundle("retention", tomorrow),
              learningBrief: "Fraction relationships at the child's current level.",
              activities: [
                {
                  ...activity("retention", tomorrow, 0),
                  questions: Array.from({ length: 10 }, (_, index) => ({
                    ...activity("retention", tomorrow, 0).questions[0]!,
                    id: `q${index + 1}`,
                  })),
                },
              ],
            },
          },
        }),
      () => {},
      [databasePath],
    );
    expect((await finish("retention", tomorrow)).perfectDayStreak).toBe(93);
    await store.close();
    const saved = new DatabaseSync(databasePath, { readOnly: true });
    try {
      // The historical count stays three; only the new ten-question day uses one
      // activity. An old schema-2 binary cannot safely infer this new day's goal.
      expect(
        saved
          .prepare("SELECT required_count FROM kids_day WHERE child_id = ? AND date = ?")
          .get("retention", today)?.required_count,
      ).toBe(3);
      expect(
        saved
          .prepare("SELECT required_count FROM kids_day WHERE child_id = ? AND date = ?")
          .get("retention", tomorrow)?.required_count,
      ).toBe(1);
      expect(saved.prepare("PRAGMA user_version").get()?.user_version).toBe(4);
      expect(saved.prepare("PRAGMA quick_check").get()?.quick_check).toBe("ok");
    } finally {
      saved.close();
    }
    store = await openSqliteWorkerStore<ActivityStoreOperations>({
      moduleUrl,
      databasePath,
      input: admission,
    });
  });
});
