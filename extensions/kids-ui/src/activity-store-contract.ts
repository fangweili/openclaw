import type {
  ActivityMutation,
  ActivityResult,
  ActivitySnapshot,
} from "@openclaw/kids-activity-contract";
import type {
  ActivityGrade,
  ActivityContinueMutation,
  ActivityDirectMutation,
  ActivityDefinition,
  ActivityEvidence,
  ActivityPreparationContext,
  ActivityPracticeOffer,
  ActivityQuestionDefinition,
  DailyActivityBundle,
  DailyArtworkBundle,
} from "./activity-contract.js";

/** Admission-only migration context; never grants runtime mutation authority. */
export type ActivityStoreAdmission = {
  children: readonly { childId: string; timeZone: string }[];
  now: number;
};
export type ActivityStoreTarget = { childId: string; date: string; now: number };
export type ActivityStoreOperations = {
  get: { input: ActivityStoreTarget; output: ActivitySnapshot };
  prepare: { input: ActivityStoreTarget; output: ActivityPreparationContext };
  findDaily: { input: { childId: string; date: string }; output: DailyActivityBundle | null };
  findArtwork: { input: { childId: string; date: string }; output: DailyArtworkBundle | null };
  /** Read-only preflight avoids inference on a committed retry; private rubric stays inside the owner. */
  planAnswer: {
    input: ActivityStoreTarget & { mutation: Extract<ActivityMutation, { kind: "answer" }> };
    output:
      | { kind: "replay"; result: ActivityResult }
      | { kind: "grade"; question: Extract<ActivityQuestionDefinition, { kind: "explanation" }> };
  };
  mutate: {
    input: ActivityStoreTarget & { mutation: ActivityDirectMutation; grade?: ActivityGrade };
    output: ActivityResult;
  };
  /** Read-only preflight: a successor is authoritative even after its request receipt expires. */
  planNext: {
    input: ActivityStoreTarget & { mutation: ActivityContinueMutation };
    output:
      | { kind: "replay"; result: ActivityResult }
      | {
          kind: "generate";
          date: string;
          previous: ActivityEvidence;
          history: ActivityEvidence[];
          historyOmitted: number;
          learningBrief: string | null;
        };
  };
  /**
   * Append and select/start the generator's already-validated ten-question
   * definition once; rechecks date, predecessor and authority at commit.
   */
  publishNext: {
    input: ActivityStoreTarget & {
      mutation: ActivityContinueMutation;
      generationDate: string;
      activity: ActivityDefinition;
    };
    output: ActivityResult;
  };
  offerPractice: {
    input: ActivityStoreTarget & { offer: ActivityPracticeOffer };
    output: { published: boolean; snapshot: ActivitySnapshot };
  };
  publish: {
    input: ActivityStoreTarget & { bundle: DailyActivityBundle };
    output: { published: boolean };
  };
  /** Publish once, or compare-and-replace today's art by its existing normal image ID. */
  publishArtwork: {
    input: ActivityStoreTarget & { bundle: DailyArtworkBundle; replaceImageId?: string };
    output: { published: boolean };
  };
};

/** Stable semantic request identity, independent of caller object property order. */
export function encodeActivityMutation(mutation: ActivityMutation): string {
  const fields = [mutation.kind, mutation.requestId];
  if (mutation.kind === "touch") {
    fields.push(mutation.source);
  } else {
    fields.push(mutation.activityId);
    if (mutation.kind !== "start" && mutation.kind !== "continue") {
      fields.push(mutation.questionId);
    }
    if (mutation.kind === "answer") {
      fields.push(
        mutation.answer.kind,
        mutation.answer.kind === "choice" ? mutation.answer.optionId : mutation.answer.text,
      );
    }
  }
  return JSON.stringify(fields);
}
