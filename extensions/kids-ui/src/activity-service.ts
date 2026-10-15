/**
 * One restartable service owns the activity worker and accepted calls. Gateway and
 * preparation tools borrow this facade; IDs never grant authority. Stop seals new
 * calls, joins generation and admitted calls, then closes the worker. A restarted
 * owner has a new lifetime, so retained assertions cannot commit into its state.
 */
import path from "node:path";
import type {
  ActivityMutation,
  ActivityResult,
  ActivitySnapshot,
} from "@openclaw/kids-activity-contract";
import type {
  OpenClawPluginApi,
  OpenClawPluginServiceContextV2,
} from "openclaw/plugin-sdk/plugin-entry";
import { resolveRuntimeWorkerUrl } from "openclaw/plugin-sdk/process-runtime";
import {
  openSqliteWorkerStore,
  runSqliteWorkerStoreWrite,
  type SqliteWorkerStore,
} from "openclaw/plugin-sdk/sqlite-runtime";
import type {
  ActivityChildBinding,
  ActivityPreparationContext,
  ActivityPracticeOffer,
  DailyActivityBundle,
} from "./activity-contract.js";
import { gradeActivityExplanation } from "./activity-grading.js";
import type { ActivityStoreOperations, ActivityStoreTarget } from "./activity-store-contract.js";
import { encodeActivityMutation } from "./activity-store-contract.js";
import { activityDate } from "./activity-validation.js";

export type ActivityOwner = {
  /** Reads the public projection; checks caller/service lifetime before and after IO. */
  get(childId: string, assertCurrent: () => void): Promise<ActivitySnapshot>;
  /** Reads bounded private evidence with explicit omission counts for preparation/report jobs. */
  prepare(
    this: void,
    childId: string,
    assertCurrent: () => void,
  ): Promise<ActivityPreparationContext>;
  /** Private lookup of the original three-challenge batch, excluding extra practice; requires job authority. */
  findDaily(
    childId: string,
    date: string,
    assertCurrent: () => void,
  ): Promise<DailyActivityBundle | null>;
  /**
   * Atomically saves evidence, progress, pet clocks, and the request receipt after
   * checking caller authority at commit. A retained request ID replays its original
   * feedback with a fresh snapshot. Domain rejection commits nothing; other failures
   * may follow a commit, so retry the same ID while its receipt is retained.
   */
  mutate(
    childId: string,
    mutation: ActivityMutation,
    assertCurrent: () => void,
  ): Promise<ActivityResult>;
  /**
   * Offer at most one extra one-question activity after today's three are complete.
   * The existing definition is immutable: exact ID/date/content retries are no-ops,
   * even after progress or the date changes. Does not start it or change pet clocks.
   * Requires parent authority, rechecked at commit; retry the exact offer after an
   * uncertain result. New offers for another local date or unfinished days fail.
   */
  offerPractice(
    childId: string,
    offer: ActivityPracticeOffer,
    assertCurrent: () => void,
  ): Promise<{ published: boolean; snapshot: ActivitySnapshot }>;
  /** Atomically accepts three challenges and their mood art for a date; later calls return published:false. */
  publish(bundle: DailyActivityBundle, assertCurrent: () => void): Promise<{ published: boolean }>;
};
type ActiveOwner = {
  store: SqliteWorkerStore<ActivityStoreOperations>;
  databasePath: string;
  signal: AbortSignal;
  cancel: AbortController;
  calls: Set<Promise<unknown>>;
  /** One bounded model call per child; identical in-flight retries share settlement. */
  grades: Map<string, { key: string; operation: Promise<ActivityResult> }>;
};
export type ActivityServiceOptions = {
  children: readonly ActivityChildBinding[];
  /** Activate the generation/media owner only after database admission succeeds. */
  startGeneration?: (context: { stateDir: string; signal: AbortSignal }) => void | Promise<void>;
  /** Cancel and join the generation/media owner before its database is released. */
  stopGeneration?: () => Promise<void>;
  now?: () => number;
};

/** Registration is inert until service start; the facade always addresses its live generation. */
export function registerKidsActivityService(
  api: OpenClawPluginApi,
  options: ActivityServiceOptions,
): ActivityOwner {
  let active: ActiveOwner | null = null;
  let starting: Promise<void> | undefined;
  const bindings = new Map(options.children.map((binding) => [binding.childId, binding]));
  const now = options.now ?? Date.now;
  async function activate({ stateDir, scheduler }: OpenClawPluginServiceContextV2): Promise<void> {
    const databasePath = path.join(stateDir, "plugins", "kids-ui", "activities.sqlite");
    const store = await openSqliteWorkerStore<ActivityStoreOperations>({
      moduleUrl: resolveRuntimeWorkerUrl({
        currentModuleUrl: import.meta.url,
        sourceWorkerName: "activity-store.worker",
        distWorkerPath: "extensions/kids-ui/src/activity-store.worker.js",
      }),
      databasePath,
      input: {
        children: options.children.map(({ childId, timeZone }) => ({ childId, timeZone })),
        now: now(),
      },
    });
    if (scheduler.signal.aborted) {
      await store.close();
      return;
    }
    const cancel = new AbortController();
    active = {
      store,
      databasePath,
      cancel,
      signal: AbortSignal.any([scheduler.signal, cancel.signal]),
      calls: new Set(),
      grades: new Map(),
    };
    try {
      await options.startGeneration?.({ stateDir, signal: scheduler.signal });
    } catch (error) {
      const owner = active;
      active = null;
      owner?.cancel.abort();
      try {
        await options.stopGeneration?.();
      } finally {
        await Promise.allSettled(owner?.calls ?? []);
        await store.close();
      }
      throw error;
    }
  }
  api.registerService({
    id: "kids-ui-activities",
    apiVersion: 2,
    start(context) {
      starting = activate(context);
      return starting;
    },
    async stop() {
      const owner = active;
      active = null;
      owner?.cancel.abort();
      try {
        await options.stopGeneration?.();
      } finally {
        await starting?.catch(() => {});
        if (owner) {
          await Promise.allSettled(owner.calls);
          await owner.store.close();
        }
      }
    },
  });

  async function run<K extends keyof ActivityStoreOperations>(
    childId: string,
    type: K,
    input: (target: ActivityStoreTarget) => ActivityStoreOperations[K]["input"],
    assertCaller: () => void,
    writes = false,
  ): Promise<ActivityStoreOperations[K]["output"]> {
    const owner = active;
    const child = bindings.get(childId);
    if (!owner || owner.signal.aborted) {
      throw new Error("Activities are restarting. Try again shortly.");
    }
    if (!child) {
      throw new Error("This tutor does not have activities configured.");
    }
    if (owner.calls.size >= 32) {
      throw new Error("Activities are busy. Try again shortly.");
    }
    const assertCurrent = () => {
      owner.signal.throwIfAborted();
      if (active !== owner) {
        throw new Error("Activity service retired.");
      }
      assertCaller();
    };
    assertCurrent();
    const timestamp = now();
    const command = {
      type,
      input: input({ childId, date: activityDate(timestamp, child.timeZone), now: timestamp }),
    };
    const operation = writes
      ? runSqliteWorkerStoreWrite(owner.store, (scope) => scope.execute(command), assertCurrent, [
          owner.databasePath,
        ])
      : owner.store.execute(command, { signal: owner.signal });
    owner.calls.add(operation);
    try {
      const result = await operation;
      assertCurrent();
      return result;
    } finally {
      owner.calls.delete(operation);
    }
  }

  /**
   * Inference never holds a SQLite write transaction. Admission bounds each child
   * to one call, replays committed receipts before inference, and tracks the whole
   * operation through final authority-checked commit. Cancellation joins the SDK
   * call before the service releases its worker; no grade can enter a new lifetime.
   */
  async function mutate(
    childId: string,
    mutation: ActivityMutation,
    assertCaller: () => void,
  ): Promise<ActivityResult> {
    if (mutation.kind !== "answer" || mutation.answer.kind !== "explanation") {
      return run(childId, "mutate", (target) => ({ ...target, mutation }), assertCaller, true);
    }
    const owner = active;
    const child = bindings.get(childId);
    if (!owner || owner.signal.aborted || !child) {
      throw new Error("Activities are restarting. Try again shortly.");
    }
    const assertCurrent = () => {
      owner.signal.throwIfAborted();
      if (active !== owner) {
        throw new Error("Activity service retired.");
      }
      assertCaller();
    };
    assertCurrent();
    const key = encodeActivityMutation(mutation);
    const pending = owner.grades.get(childId);
    if (pending) {
      if (pending.key !== key) {
        throw new Error("Your previous answer is still being checked. Try again shortly.");
      }
      const result = await pending.operation;
      assertCurrent();
      return result;
    }
    if (owner.calls.size >= 32) {
      throw new Error("Activities are busy. Try again shortly.");
    }
    const text = mutation.answer.text;
    const operation = (async () => {
      const plan = await run(
        childId,
        "planAnswer",
        (target) => ({ ...target, mutation }),
        assertCurrent,
      );
      if (plan.kind === "replay") {
        return plan.result;
      }
      assertCurrent();
      const grade = await gradeActivityExplanation((params) => api.runtime.llm.complete(params), {
        agentId: child.agentId,
        question: plan.question,
        text,
        signal: owner.signal,
      });
      assertCurrent();
      return run(
        childId,
        "mutate",
        (target) => ({ ...target, mutation, grade }),
        assertCurrent,
        true,
      );
    })();
    owner.grades.set(childId, { key, operation });
    owner.calls.add(operation);
    try {
      return await operation;
    } finally {
      owner.grades.delete(childId);
      owner.calls.delete(operation);
    }
  }
  return {
    get: (childId, assertCurrent) => run(childId, "get", (target) => target, assertCurrent),
    prepare: (childId, assertCurrent) => run(childId, "prepare", (target) => target, assertCurrent),
    findDaily: (childId, date, assertCurrent) =>
      run(childId, "findDaily", () => ({ childId, date }), assertCurrent),
    mutate,
    offerPractice: (childId, offer, assertCurrent) =>
      run(childId, "offerPractice", (target) => ({ ...target, offer }), assertCurrent, true),
    publish: (bundle, assertCurrent) =>
      run(bundle.childId, "publish", (target) => ({ ...target, bundle }), assertCurrent, true),
  };
}
