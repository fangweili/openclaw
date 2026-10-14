/** Private publication, evidence, and child-binding contract of the activity owner. */
import type {
  ActivityAnswer,
  ActivityFeedback,
  ActivityOption,
  ActivitySnapshot,
} from "@openclaw/kids-activity-contract";

export type ActivityQuestionDefinition = {
  id: string;
  prompt: string;
  hint: string;
  explanation: string;
} & (
  | { kind: "choice"; options: ActivityOption[]; correctOptionId: string }
  | { kind: "numeric"; answer: string; unit: string | null }
  | { kind: "explanation"; rubric: string }
);
/** Private grading verdict; never supplied by the browser. */
export type ActivityGrade = Pick<ActivityFeedback, "outcome" | "explanation">;
/** An immutable three-question challenge, distinct from its day's shared artwork. */
export type ActivityDefinition = {
  id: string;
  title: string;
  subject: string;
  questions: ActivityQuestionDefinition[];
};
/** Atomic publication: three challenges, required normal/excited art, optional daily rest art. */
export type DailyActivityBundle = {
  childId: string;
  date: string;
  activities: ActivityDefinition[];
  scene: NonNullable<ActivitySnapshot["pet"]["scene"]>;
  /** Absent in older batches or after optional rendering failure; use the fixed pose. */
  restImages?: { bored?: string; sleeping?: string };
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
  answer: ActivityAnswer;
  answerText: string;
  outcome: ActivityFeedback["outcome"];
  feedback: string;
  ordinal: number;
  hintUsed: boolean;
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
