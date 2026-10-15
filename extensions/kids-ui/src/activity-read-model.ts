/**
 * Pure read model for the activity database owner. Converts admitted immutable
 * definitions and progress into public snapshots or bounded private evidence.
 * Owns no state, resources, queries or writes; calls are synchronous and borrow
 * their inputs without mutation. The worker supplies one consistent child/day
 * view, including the owning day's required count for carryover and history.
 * Grading keys remain private, and optional practice never changes daily goals.
 */
import type { ActivitySnapshot } from "@openclaw/kids-activity-contract";
import {
  ACTIVITY_BORED_MS,
  ACTIVITY_SLEEP_MS,
  type ActivityDefinition,
  type ActivityEvidence,
  type DailyActivityBundle,
} from "./activity-contract.js";
import type { ActivityDatabase } from "./activity-migration.js";
import {
  projectActivityProgress,
  readActivityProgress,
  visiblePerfectDayStreak,
} from "./activity-progress.js";
import type { ActivityStoreTarget } from "./activity-store-contract.js";

type PetRow = ActivityDatabase["kids_pet"];
type DayRow = ActivityDatabase["kids_day"];
type ActivityRow = ActivityDatabase["kids_activity"];
export type DayContent = Pick<
  DailyActivityBundle,
  "scene" | "scenePrompt" | "stateText" | "restImages" | "learningBrief"
>;
/** Decode immutable content already admitted by the database owner. */
export function readDay(row: DayRow): DayContent {
  // SAFETY: publish() validates day content before its sole immutable write.
  return JSON.parse(row.content) as DayContent;
}
/** Decode an immutable definition already admitted by the database owner. */
export function readActivity(row: ActivityRow): ActivityDefinition {
  // SAFETY: publication paths validate each definition before its immutable write.
  return JSON.parse(row.definition) as ActivityDefinition;
}

/** A continuation never changes an unfinished batch or adds work to a past local day. */
export function canContinueActivity(
  target: ActivityStoreTarget,
  row: ActivityRow | undefined,
  day: DayRow | undefined,
  activities: readonly ActivityRow[],
): boolean {
  return (
    day?.date === target.date &&
    row?.date === target.date &&
    row.activity_id === activities.at(-1)?.activity_id &&
    activities.every((activity) => readActivityProgress(activity).completed)
  );
}

/**
 * Project one consistent owner-selected view without revealing answer keys or
 * unused hints. Activities belong to latest; selected may be unfinished work
 * from an older day and must carry its own required-count boundary.
 */
export function projectActivitySnapshot({
  target,
  pet,
  latest,
  activities,
  selected,
  next,
}: {
  target: ActivityStoreTarget;
  pet: PetRow;
  latest: DayRow | undefined;
  activities: readonly ActivityRow[];
  selected: { row: ActivityRow; requiredCount: number } | undefined;
  next: ActivityRow | undefined;
}): ActivitySnapshot {
  const row = selected?.row;
  const requiredCount = latest?.required_count ?? 0;
  const dayProgress = activities
    .filter((activity) => activity.ordinal < requiredCount)
    .map(readActivityProgress);
  const dayQuestions = dayProgress.flatMap((progress) => progress.questions);
  const extraQuestions = activities
    .filter((activity) => activity.ordinal >= requiredCount)
    .flatMap((activity) => readActivityProgress(activity).questions);
  const idle =
    pet.last_interaction === null
      ? ACTIVITY_SLEEP_MS
      : Math.max(0, target.now - pet.last_interaction);
  const state =
    pet.excited_until !== null && pet.excited_until > target.now
      ? "excited"
      : idle >= ACTIVITY_SLEEP_MS
        ? "sleeping"
        : idle >= ACTIVITY_BORED_MS
          ? "bored"
          : "normal";
  const daily = latest ? readDay(latest) : undefined;
  const currentDay = latest?.date === target.date ? daily : undefined;
  const image =
    state === "bored" || state === "sleeping"
      ? {
          imageId: currentDay?.restImages?.[state] ?? state,
          caption:
            currentDay?.stateText[state] ??
            (state === "sleeping"
              ? "Resting until our next adventure."
              : "Wondering what we will explore next."),
        }
      : (daily?.scene[state] ?? {
          imageId: "reference",
          caption: "Ready for our next adventure.",
        });
  const snapshot: ActivitySnapshot = {
    now: target.now,
    date: target.date,
    pet: {
      state,
      scene: daily?.scene ?? null,
      image,
      lastInteractionAt: pet.last_interaction,
      excitedUntil:
        pet.excited_until !== null && pet.excited_until > target.now ? pet.excited_until : null,
    },
    correctStreak: pet.streak,
    perfectDayStreak: visiblePerfectDayStreak(pet, target.date),
    daily: latest
      ? {
          date: latest.date,
          total: latest.required_count,
          questionTotal: dayQuestions.length,
          completed: dayProgress.filter((progress) => progress.completed).length,
          questionsSolved: dayQuestions.filter((q) => q.correct).length,
          firstTryCorrect: dayQuestions.filter((q) => q.correct && q.attempts === 1).length,
          hintedQuestions: dayQuestions.filter((q) => q.hintUsed).length,
        }
      : null,
    extras: {
      questionsSolved: extraQuestions.filter((q) => q.correct).length,
      firstTryCorrect: extraQuestions.filter((q) => q.correct && q.attempts === 1).length,
      hintedQuestions: extraQuestions.filter((q) => q.hintUsed).length,
    },
    canContinue: canContinueActivity(target, row, latest, activities),
    nextActivity: next ? { id: next.activity_id, title: readActivity(next).title } : null,
    activity: row
      ? projectActivityProgress(
          readActivity(row),
          readActivityProgress(row),
          row.date,
          row.ordinal < selected!.requiredCount ? "daily" : "extra",
        )
      : null,
  };
  return snapshot;
}

/** Question counters are complete; bounded detailed attempts report their omissions explicitly. */
export function projectActivityEvidence(
  row: ActivityRow,
  requiredCount: number,
  attemptLimit: number,
): ActivityEvidence {
  const activity = readActivity(row);
  const progress = readActivityProgress(row);
  const attempts = progress.attempts.slice(-attemptLimit);
  return {
    id: row.activity_id,
    date: row.date,
    scope: row.ordinal < requiredCount ? "daily" : "extra",
    title: activity.title,
    subject: activity.subject,
    completed: progress.completed,
    completedAt: progress.completedAt,
    questions: progress.questions,
    attempts,
    attemptsOmitted: Math.max(0, progress.submissionCount - attempts.length),
  };
}
