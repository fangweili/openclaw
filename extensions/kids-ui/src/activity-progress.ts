/**
 * Pure canonical progress and perfect-day rules shared by admission and the
 * SQLite worker. Owns no state, resources, timers or I/O. The worker persists
 * progress/checkpoints atomically; migration uses the same rules on retained
 * history. Calendar arithmetic operates on local date identities, not elapsed
 * hours, so daylight-saving changes cannot skip or duplicate a day.
 */
import type { ActivitySnapshot } from "@openclaw/kids-activity-contract";
import type {
  ActivityAttemptEvidence,
  ActivityDefinition,
  ActivityQuestionEvidence,
} from "./activity-contract.js";

export type ActivityProgress = {
  started: boolean;
  completed: boolean;
  completedAt: number | null;
  index: number;
  questions: ActivityQuestionEvidence[];
  attempts: ActivityAttemptEvidence[];
  submissionCount: number;
};
export type PerfectDayCheckpoint = {
  perfect_day_streak: number;
  last_perfect_date: string | null;
};
type PerfectDayStatus = "incomplete" | "imperfect" | "perfect";

/** Decode only canonical JSON admitted/migrated by the owning activity worker. */
export function readActivityProgress(row: { progress: string }): ActivityProgress {
  // SAFETY: publication, migration and mutations are the sole typed writers.
  return JSON.parse(row.progress) as ActivityProgress;
}
/** Creates fresh mutable evidence for a validated immutable definition. */
export function initialActivityProgress(activity: ActivityDefinition): ActivityProgress {
  return {
    started: false,
    completed: false,
    completedAt: null,
    index: 0,
    attempts: [],
    submissionCount: 0,
    questions: activity.questions.map((q) => ({
      questionId: q.id,
      prompt: q.prompt,
      attempts: 0,
      hintUsed: false,
      correct: false,
      independent: false,
    })),
  };
}

/** Project the child's current progress without private grading keys or unrevealed hints. */
export function projectActivityProgress(
  activity: ActivityDefinition,
  progress: ActivityProgress,
  date: string,
): NonNullable<ActivitySnapshot["activity"]> {
  const question = progress.completed ? undefined : activity.questions[progress.index];
  return {
    id: activity.id,
    date,
    title: activity.title,
    subject: activity.subject,
    started: progress.started,
    completed: progress.completed,
    currentIndex: progress.index,
    total: activity.questions.length,
    currentQuestion: question
      ? {
          id: question.id,
          prompt: question.prompt,
          ...(question.kind === "choice"
            ? { kind: "choice" as const, options: question.options }
            : question.kind === "numeric"
              ? { kind: "numeric" as const, unit: question.unit }
              : { kind: "explanation" as const }),
          hint: progress.questions[progress.index]?.hintUsed ? question.hint : null,
        }
      : null,
  };
}

/** Requires valid YYYY-MM-DD calendar identity, independent of the child's UTC offset. */
function previousDate(date: string): string {
  const previous = new Date(`${date}T00:00:00.000Z`);
  previous.setUTCDate(previous.getUTCDate() - 1);
  return previous.toISOString().slice(0, 10);
}

/**
 * Evaluate only originally scheduled activities. A hint or wrong graded attempt
 * permanently disqualifies that day. Clarification leaves attempts unchanged.
 * Missing activities cannot qualify; completion timestamps are checked by the
 * migration caller, while runtime awards only in the scheduled day's mutation.
 */
export function perfectDayStatus(
  progress: readonly ActivityProgress[],
  requiredCount: number,
): PerfectDayStatus {
  if (
    progress.some((activity) =>
      activity.questions.some(
        (q) => q.hintUsed || q.attempts > 1 || (q.attempts === 1 && !q.correct),
      ),
    )
  ) {
    return "imperfect";
  }
  return progress.length === requiredCount &&
    progress.every(
      (activity) =>
        activity.completed && activity.questions.every((q) => q.correct && q.attempts === 1),
    )
    ? "perfect"
    : "incomplete";
}

/** Read-only expiry: a clean unfinished today preserves yesterday until local midnight. */
export function visiblePerfectDayStreak(checkpoint: PerfectDayCheckpoint, date: string): number {
  return checkpoint.last_perfect_date === date ||
    checkpoint.last_perfect_date === previousDate(date)
    ? checkpoint.perfect_day_streak
    : 0;
}

/**
 * Update caller-owned checkpoint in place; the caller owns transaction/rollback.
 * Only the current scheduled date may be awarded at runtime. Migration feeds
 * retained days in ascending order. Same-date replay never increments twice.
 */
export function updatePerfectDayCheckpoint(
  checkpoint: PerfectDayCheckpoint,
  date: string,
  status: PerfectDayStatus,
): void {
  if (status === "imperfect") {
    checkpoint.perfect_day_streak = 0;
    checkpoint.last_perfect_date = null;
  } else if (status === "perfect" && checkpoint.last_perfect_date !== date) {
    checkpoint.perfect_day_streak =
      (checkpoint.last_perfect_date === previousDate(date) ? checkpoint.perfect_day_streak : 0) + 1;
    checkpoint.last_perfect_date = date;
  }
}
