/**
 * Admission-only SQLite migration. Version 2 adds explicit question kinds,
 * submitted free answers, ungraded outcomes, and an evidence submission counter
 * inside the existing canonical JSON rows. One synchronous transaction rewrites
 * v1 rows and receipts without changing progress, timestamps, retention, or pet
 * clocks. Failure rolls back the entire migration. Older binaries reject v2;
 * rollback requires the coordinated pre-upgrade database backup.
 */
import type { DatabaseSync } from "node:sqlite";
import type { ActivityFeedback, ActivityMutation } from "@openclaw/kids-activity-contract";
import { runSqliteImmediateTransactionSync } from "openclaw/plugin-sdk/sqlite-worker-runtime";
import type {
  ActivityAttemptEvidence,
  ActivityDefinition,
  ActivityQuestionDefinition,
} from "./activity-contract.js";
import { encodeActivityMutation } from "./activity-store-contract.js";

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

/** Called exactly once on worker admission, with the admitted version and no runtime users. */
export function migrateActivityDatabase(db: DatabaseSync, version: number, schema: string): void {
  if (version === 2) {
    return;
  }
  runSqliteImmediateTransactionSync(db, () => {
    db.exec(schema);
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
    db.exec("PRAGMA user_version = 2");
  });
}
