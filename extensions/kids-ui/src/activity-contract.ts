/** Private publication, evidence, and child-binding contract of the activity owner. */
import type { ActivityOption, ActivitySnapshot } from "@openclaw/kids-activity-contract";

type ActivityQuestion = {
  id: string;
  prompt: string;
  options: ActivityOption[];
  correctOptionId: string;
  hint: string;
  explanation: string;
};
/** An immutable three-question challenge, distinct from its day's shared artwork. */
export type ActivityDefinition = {
  id: string;
  title: string;
  subject: string;
  questions: ActivityQuestion[];
};
/** Atomic publication: exactly three challenges and one normal/excited art pair. */
export type DailyActivityBundle = {
  childId: string;
  date: string;
  activities: ActivityDefinition[];
  scene: NonNullable<ActivitySnapshot["pet"]["scene"]>;
  /** Private creative plan for continuity; describes intended art, not verified image contents. */
  scenePrompt: string;
  stateText: { bored: string; sleeping: string };
};
export type ActivityChildBinding = {
  childId: string;
  agentId: string;
  sessionKey: string;
  timeZone: string;
};
export type ActivityQuestionEvidence = {
  questionId: string;
  prompt: string;
  attempts: number;
  hintUsed: boolean;
  correct: boolean;
  independent: boolean;
};
export type ActivityEvidence = {
  id: string;
  date: string;
  title: string;
  subject: string;
  completed: boolean;
  completedAt: number | null;
  questions: ActivityQuestionEvidence[];
  attempts: ActivityAttemptEvidence[];
  /** Older detailed attempts may be omitted; question counters remain complete. */
  attemptsOmitted: number;
};
export type ActivityAttemptEvidence = {
  id: string;
  at: number;
  activityId: string;
  questionId: string;
  optionId: string;
  answerText: string;
  ordinal: number;
  hintUsed: boolean;
  correct: boolean;
  independent: boolean;
};
export type ActivityPreparationContext = {
  snapshot: ActivitySnapshot;
  recentActivities: ActivityEvidence[];
  activitiesOmitted: number;
  recentScenes: {
    date: string;
    scene: DailyActivityBundle["scene"];
    scenePrompt: string;
    stateText: DailyActivityBundle["stateText"];
  }[];
};

export const ACTIVITY_BORED_MS = 30 * 60_000;
export const ACTIVITY_SLEEP_MS = 2 * 60 * 60_000;
export const ACTIVITY_EXCITED_MS = 2 * 60_000;
export const ACTIVITY_STREAK_TARGET = 3;
