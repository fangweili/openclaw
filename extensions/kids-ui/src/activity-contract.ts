/** Private publication, evidence, and child-binding contract of the activity owner. */
import type {
  ActivityAnswer,
  ActivityFeedback,
  ActivityOption,
  ActivityMutation,
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
/** One immutable batch; new batches have ten questions, while saved legacy sizes remain valid. */
export type ActivityDefinition = {
  id: string;
  title: string;
  subject: string;
  questions: ActivityQuestionDefinition[];
};
/** One optional extra question for an existing completed local day; never replaces daily work. */
export type ActivityPracticeOffer = { date: string; activity: ActivityDefinition };
/** Atomic daily publication; existing stored bundles may retain legacy activity sizes. */
export type DailyActivityBundle = {
  childId: string;
  date: string;
  activities: ActivityDefinition[];
  /** Bounded private teaching context for extra sets; absent only on older saved days. */
  learningBrief?: string;
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
  /** Derived from the owning day; saved legacy and new optional batches stay distinct. */
  scope: "daily" | "extra";
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
  /** Latest prepared day's teaching context, never exposed in the browser snapshot. */
  learningBrief: string | null;
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

/** Continue owns inference/publication; ordinary worker mutations never receive it. */
export type ActivityContinueMutation = Extract<ActivityMutation, { kind: "continue" }>;
export type ActivityDirectMutation = Exclude<ActivityMutation, { kind: "continue" }>;
