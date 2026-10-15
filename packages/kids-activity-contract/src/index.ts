/**
 * Public data-only wire contract for kids activity clients and the owning plugin.
 * No runtime state, I/O, or extension dependencies live here. The server alone
 * grades answers and projects progress: snapshots omit grading keys and private
 * preparation evidence. Image IDs still require authenticated session authority.
 */
export type ActivityOption = { id: string; text: string };
/** Input bounds shared with rendering; the server remains the admission owner. */
export const ACTIVITY_NUMERIC_MAX_LENGTH = 40;
export const ACTIVITY_EXPLANATION_MAX_LENGTH = 600;
/** Only display fields cross the child boundary; answer keys and rubrics stay private. */
export type ActivityQuestion = { id: string; prompt: string; hint: string | null } & (
  | { kind: "choice"; options: ActivityOption[] }
  | { kind: "numeric"; unit: string | null }
  | { kind: "explanation" }
);
/** Numbers accept a signed decimal or integer fraction; units belong outside the input. */
export type ActivityAnswer =
  | { kind: "choice"; optionId: string }
  | { kind: "numeric" | "explanation"; text: string };
type ActivityImage = { imageId: string; caption: string };
type ActivityPetState = "normal" | "bored" | "sleeping" | "excited";
/** Current server projection; reading it never wakes the pet or starts a quiz. */
export type ActivitySnapshot = {
  now: number;
  date: string;
  pet: {
    state: ActivityPetState;
    scene: { normal: ActivityImage; excited: ActivityImage } | null;
    image: ActivityImage | null;
    lastInteractionAt: number | null;
    excitedUntil: number | null;
  };
  /** Consecutive graded correct activity answers across days; hints/clarification do not reset it. */
  correctStreak: number;
  /** Consecutive local days completed first try without hints; excludes optional practice. */
  perfectDayStreak: number;
  /** Counts for the latest prepared day, excluding any resumed older challenge. */
  daily: {
    date: string;
    total: number;
    completed: number;
    /** Questions eventually answered correctly, including corrected answers and extra practice. */
    questionsSolved: number;
    /** Correct on the first graded attempt, including hints; clarification is ungraded. */
    firstTryCorrect: number;
    /** Distinct questions whose hint was opened, regardless of repeated requests. */
    hintedQuestions: number;
  } | null;
  /** Offered only after completion; start with this ID explicitly to advance. */
  nextActivity: { id: string; title: string } | null;
  activity: {
    id: string;
    date: string;
    title: string;
    subject: string;
    started: boolean;
    completed: boolean;
    currentIndex: number;
    total: number;
    currentQuestion: ActivityQuestion | null;
  } | null;
};
/** Graded outcome for the submitted question, which may differ from the fresh snapshot. */
export type ActivityFeedback = {
  questionId: string;
  /** Clarification is ungraded: it never counts wrong or advances progress. */
  outcome: "correct" | "revise" | "clarify";
  independent: boolean;
  explanation: string;
};
/** Retries replay original feedback with the latest saved snapshot. */
export type ActivityResult = { snapshot: ActivitySnapshot; feedback?: ActivityFeedback };
/** Reuse requestId for uncertain retries; different inputs under that ID are rejected. */
export type ActivityMutation =
  | { kind: "start"; requestId: string; activityId: string }
  | {
      kind: "answer";
      requestId: string;
      activityId: string;
      questionId: string;
      answer: ActivityAnswer;
    }
  | { kind: "hint"; requestId: string; activityId: string; questionId: string }
  | { kind: "touch"; requestId: string; source: "chat" | "voice" };
