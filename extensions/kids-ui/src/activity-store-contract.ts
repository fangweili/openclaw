import type {
  ActivityMutation,
  ActivityResult,
  ActivitySnapshot,
} from "@openclaw/kids-activity-contract";
import type {
  ActivityGrade,
  ActivityPreparationContext,
  ActivityQuestionDefinition,
  DailyActivityBundle,
} from "./activity-contract.js";

export type ActivityStoreTarget = { childId: string; date: string; now: number };
export type ActivityStoreOperations = {
  get: { input: ActivityStoreTarget; output: ActivitySnapshot };
  prepare: { input: ActivityStoreTarget; output: ActivityPreparationContext };
  findDaily: { input: { childId: string; date: string }; output: DailyActivityBundle | null };
  /** Read-only preflight avoids inference on a committed retry; private rubric stays inside the owner. */
  planAnswer: {
    input: ActivityStoreTarget & { mutation: Extract<ActivityMutation, { kind: "answer" }> };
    output:
      | { kind: "replay"; result: ActivityResult }
      | { kind: "grade"; question: Extract<ActivityQuestionDefinition, { kind: "explanation" }> };
  };
  mutate: {
    input: ActivityStoreTarget & { mutation: ActivityMutation; grade?: ActivityGrade };
    output: ActivityResult;
  };
  publish: {
    input: ActivityStoreTarget & { bundle: DailyActivityBundle };
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
    if (mutation.kind !== "start") {
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
