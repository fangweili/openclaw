/**
 * Admission-only schema, row types and atomic migration; the worker remains the
 * sole runtime owner. Version 2 preserves legacy choices/evidence/receipts while
 * adding free-answer kinds. Version 3 records each day's required activity count
 * and a durable perfect-day checkpoint, seeded once from retained history in the
 * configured child's timezone. Older pruned history receives no initial credit;
 * future streaks survive pruning. Unknown children retain data with zero credit.
 * Version 4 moves mood art into independent child/date rows without changing
 * learning state or image files; a picture no longer establishes a daily goal.
 * Failure rolls back the whole upgrade; older binaries reject the new version.
 */
import type { DatabaseSync } from "node:sqlite";
import type { ActivityFeedback, ActivityMutation } from "@openclaw/kids-activity-contract";
import { runSqliteImmediateTransactionSync } from "openclaw/plugin-sdk/sqlite-worker-runtime";
import type {
  ActivityAttemptEvidence,
  ActivityDefinition,
  ActivityQuestionDefinition,
  DailyActivityBundle,
  DailyArtworkBundle,
} from "./activity-contract.js";
import {
  perfectDayStatus,
  readActivityProgress,
  updatePerfectDayCheckpoint,
  type PerfectDayCheckpoint,
} from "./activity-progress.js";
import { encodeActivityMutation, type ActivityStoreAdmission } from "./activity-store-contract.js";
import { activityDate } from "./activity-validation.js";

type PetRow = {
  child_id: string;
  active_id: string | null;
  last_interaction: number | null;
  excited_until: number | null;
  streak: number;
  perfect_day_streak: number;
  last_perfect_date: string | null;
};
type DayRow = {
  child_id: string;
  date: string;
  created_at: number;
  content: string;
  required_count: number;
};
type ArtworkRow = Omit<DayRow, "required_count">;
type ActivityRow = {
  child_id: string;
  activity_id: string;
  date: string;
  ordinal: number;
  updated_at: number;
  definition: string;
  progress: string;
};
type ReceiptRow = {
  child_id: string;
  request_id: string;
  created_at: number;
  input: string;
  feedback: string | null;
};
/** Admitted canonical rows for worker queries; runtime never probes structure. */
export type ActivityDatabase = {
  kids_pet: PetRow;
  kids_day: DayRow;
  kids_art: ArtworkRow;
  kids_activity: ActivityRow;
  kids_request: ReceiptRow;
};
const SCHEMA = `
  CREATE TABLE IF NOT EXISTS kids_pet (
    child_id TEXT PRIMARY KEY, active_id TEXT, last_interaction INTEGER,
    excited_until INTEGER, streak INTEGER NOT NULL,
    perfect_day_streak INTEGER NOT NULL DEFAULT 0 CHECK(perfect_day_streak >= 0),
    last_perfect_date TEXT
  ) STRICT;
  CREATE TABLE IF NOT EXISTS kids_day (
    child_id TEXT NOT NULL, date TEXT NOT NULL, created_at INTEGER NOT NULL, content TEXT NOT NULL,
    required_count INTEGER NOT NULL DEFAULT 3 CHECK(required_count > 0),
    PRIMARY KEY(child_id,date)
  ) STRICT;
  CREATE TABLE IF NOT EXISTS kids_art (
    child_id TEXT NOT NULL, date TEXT NOT NULL, created_at INTEGER NOT NULL, content TEXT NOT NULL,
    PRIMARY KEY(child_id,date)
  ) STRICT;
  CREATE TABLE IF NOT EXISTS kids_activity (
    child_id TEXT NOT NULL, activity_id TEXT NOT NULL, date TEXT NOT NULL, ordinal INTEGER NOT NULL,
    updated_at INTEGER NOT NULL, definition TEXT NOT NULL, progress TEXT NOT NULL,
    PRIMARY KEY(child_id, activity_id), UNIQUE(child_id,date,ordinal),
    FOREIGN KEY(child_id,date) REFERENCES kids_day(child_id,date) ON DELETE CASCADE
  ) STRICT;
  CREATE TABLE IF NOT EXISTS kids_request (
    child_id TEXT NOT NULL, request_id TEXT NOT NULL, created_at INTEGER NOT NULL,
    input TEXT NOT NULL, feedback TEXT, PRIMARY KEY(child_id,request_id)
  ) STRICT;
  CREATE INDEX IF NOT EXISTS kids_request_age ON kids_request(child_id,created_at);
`;

type LegacyDayContent = Omit<DailyArtworkBundle, "childId" | "date"> &
  Pick<DailyActivityBundle, "learningBrief">;
type LegacyQuestion = Omit<Extract<ActivityQuestionDefinition, { kind: "choice" }>, "kind">;
type LegacyDefinition = Omit<ActivityDefinition, "questions"> & { questions: LegacyQuestion[] };
type LegacyAttempt = Omit<ActivityAttemptEvidence, "answer" | "outcome" | "feedback"> & {
  optionId: string;
  correct: boolean;
};
type LegacyProgress = { questions: { attempts: number }[]; attempts: LegacyAttempt[] };
type LegacyFeedback = Omit<ActivityFeedback, "outcome"> & { correct: boolean };
type LegacyMutation =
  | Exclude<ActivityMutation, { kind: "answer" }>
  | (Omit<Extract<ActivityMutation, { kind: "answer" }>, "answer"> & { optionId: string });

/**
 * Bootstrap only: stream retained days in calendar order using immutable original
 * counts. Full question counters survive evidence truncation. A closed unfinished
 * day or a late completion breaks the chain; a clean unfinished today does not.
 * No previously pruned history is inferred. Only existing pet checkpoints change.
 */
function seedPerfectDays(db: DatabaseSync, admission: ActivityStoreAdmission): void {
  const days = db.prepare(
    "SELECT date, required_count FROM kids_day WHERE child_id = ? AND date <= ? ORDER BY date",
  );
  const activities = db.prepare(
    "SELECT progress FROM kids_activity WHERE child_id = ? AND date = ? AND ordinal < ? ORDER BY ordinal",
  );
  const save = db.prepare(
    "UPDATE kids_pet SET perfect_day_streak = ?, last_perfect_date = ? WHERE child_id = ?",
  );
  for (const child of admission.children) {
    const today = activityDate(admission.now, child.timeZone);
    const checkpoint: PerfectDayCheckpoint = { perfect_day_streak: 0, last_perfect_date: null };
    for (const row of days.iterate(child.childId, today)) {
      const date = String(row.date);
      const progress = activities
        .all(child.childId, date, row.required_count!)
        .map((activity) => readActivityProgress({ progress: String(activity.progress) }));
      let status = perfectDayStatus(progress, Number(row.required_count));
      const lateCompletion = progress.some(
        (activity) =>
          activity.completed &&
          (activity.completedAt === null ||
            activityDate(activity.completedAt, child.timeZone) !== date),
      );
      if (lateCompletion || (date < today && status === "incomplete")) {
        status = "imperfect";
      }
      updatePerfectDayCheckpoint(checkpoint, date, status);
    }
    save.run(checkpoint.perfect_day_streak, checkpoint.last_perfect_date, child.childId);
  }
}

/** Called exactly once on worker admission, with the admitted version and no runtime users. */
export function migrateActivityDatabase(
  db: DatabaseSync,
  version: number,
  admission: ActivityStoreAdmission,
): void {
  if (version === 4) {
    return;
  }
  runSqliteImmediateTransactionSync(db, () => {
    db.exec(SCHEMA);
    if (version === 1) {
      const update = db.prepare(
        "UPDATE kids_activity SET definition = ?, progress = ? WHERE child_id = ? AND activity_id = ?",
      );
      for (const row of db
        .prepare("SELECT child_id, activity_id, definition, progress FROM kids_activity")
        .all()) {
        // SAFETY: schema-v1 publication and the previous worker owned these JSON fields.
        const definition = JSON.parse(String(row.definition)) as LegacyDefinition;
        const progress = JSON.parse(String(row.progress)) as LegacyProgress;
        const migrated: ActivityDefinition = {
          ...definition,
          questions: definition.questions.map((question) => ({ ...question, kind: "choice" })),
        };
        const attempts: ActivityAttemptEvidence[] = progress.attempts.map(
          ({ optionId, correct, ...attempt }) => ({
            ...attempt,
            answer: { kind: "choice", optionId },
            outcome: correct ? "correct" : "revise",
            feedback: correct
              ? definition.questions.find((question) => question.id === attempt.questionId)!
                  .explanation
              : "Not quite. Try again, or ask for a hint.",
          }),
        );
        update.run(
          JSON.stringify(migrated),
          JSON.stringify({
            ...progress,
            attempts,
            submissionCount: progress.questions.reduce(
              (total, question) => total + question.attempts,
              0,
            ),
          }),
          row.child_id!,
          row.activity_id!,
        );
      }
      const receipt = db.prepare(
        "UPDATE kids_request SET input = ?, feedback = ? WHERE child_id = ? AND request_id = ?",
      );
      for (const row of db
        .prepare("SELECT child_id, request_id, input, feedback FROM kids_request")
        .all()) {
        // SAFETY: previous mutate() serialized typed mutations and feedback together.
        const old = JSON.parse(String(row.input)) as LegacyMutation;
        const mutation: ActivityMutation =
          old.kind === "answer"
            ? {
                kind: "answer",
                requestId: old.requestId,
                activityId: old.activityId,
                questionId: old.questionId,
                answer: { kind: "choice", optionId: old.optionId },
              }
            : old;
        let feedback: ActivityFeedback | null = null;
        if (row.feedback !== null) {
          const { correct, ...previous } = JSON.parse(String(row.feedback)) as LegacyFeedback;
          feedback = { ...previous, outcome: correct ? "correct" : "revise" };
        }
        receipt.run(
          encodeActivityMutation(mutation),
          feedback ? JSON.stringify(feedback) : null,
          row.child_id!,
          row.request_id!,
        );
      }
    }
    if (version > 0 && version < 3) {
      // Shipped schemas 1 and 2 always published exactly three scheduled activities;
      // ordinal 3 was exclusively optional parent practice.
      db.exec(`
        ALTER TABLE kids_day ADD COLUMN required_count INTEGER NOT NULL DEFAULT 3 CHECK(required_count > 0);
        ALTER TABLE kids_pet ADD COLUMN perfect_day_streak INTEGER NOT NULL DEFAULT 0 CHECK(perfect_day_streak >= 0);
        ALTER TABLE kids_pet ADD COLUMN last_perfect_date TEXT;
      `);
      seedPerfectDays(db, admission);
    }
    // Schemas 1–3 stored art and the learning brief together. Move only artwork;
    // quiz/progress/clock/receipt rows and all other day columns remain untouched.
    const insertArtwork = db.prepare(
      "INSERT INTO kids_art(child_id,date,created_at,content) VALUES(?,?,?,?)",
    );
    const updateDay = db.prepare("UPDATE kids_day SET content=? WHERE child_id=? AND date=?");
    for (const row of db.prepare("SELECT child_id,date,created_at,content FROM kids_day").all()) {
      // SAFETY: previously admitted publication owned this persisted object.
      const content = JSON.parse(String(row.content)) as LegacyDayContent;
      const { scene, scenePrompt, stateText, restImages, ...learning } = content;
      insertArtwork.run(
        row.child_id!,
        row.date!,
        row.created_at!,
        JSON.stringify({
          scene,
          scenePrompt,
          stateText,
          ...(restImages ? { restImages } : {}),
        }),
      );
      updateDay.run(JSON.stringify(learning), row.child_id!, row.date!);
    }
    db.exec("PRAGMA user_version = 4");
  });
}
