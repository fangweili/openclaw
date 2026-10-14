import type {
  ActivityMutation,
  ActivityResult,
  ActivitySnapshot,
} from "@openclaw/kids-activity-contract";
import type { ActivityPreparationContext, DailyActivityBundle } from "./activity-contract.js";

export type ActivityStoreTarget = { childId: string; date: string; now: number };
export type ActivityStoreOperations = {
  get: { input: ActivityStoreTarget; output: ActivitySnapshot };
  prepare: { input: ActivityStoreTarget; output: ActivityPreparationContext };
  findDaily: { input: { childId: string; date: string }; output: DailyActivityBundle | null };
  mutate: { input: ActivityStoreTarget & { mutation: ActivityMutation }; output: ActivityResult };
  publish: {
    input: ActivityStoreTarget & { bundle: DailyActivityBundle };
    output: { published: boolean };
  };
};
