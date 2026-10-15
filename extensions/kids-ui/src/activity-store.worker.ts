/**
 * Sole SQLite owner for published quizzes, grading evidence, idempotency receipts,
 * pet clocks, and the durable perfect-day checkpoint. Runs only in the SQLite broker worker. Admission creates/migrates schema
 * once; all state changes use one synchronous transaction with host authority at
 * BEGIN/COMMIT. Each day owns its scheduled and optional batches. Independent
 * artwork may arrive before or after Solve and never changes progress. New batches contain
 * ten questions; saved legacy definitions retain their original sizes.
 * Completing a quiz offers an explicit next start. An unfinished quiz survives
 * newer days; unstarted old extras cease being offered.
 * Perfect-day credit excludes optional practice and late carryover; its compact
 * checkpoint survives history pruning independently of the pet answer streak.
 * Ninety-day history and the newest 512 receipts are retained. Day-level pruning
 * keeps all definitions while any evidence is recent or a quiz is unfinished.
 */
import fs from "node:fs";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { isDeepStrictEqual } from "node:util";
import type {
  ActivityFeedback,
  ActivityMutation,
  ActivityResult,
  ActivitySnapshot,
} from "@openclaw/kids-activity-contract";
import { configureSqliteConnectionPragmas } from "openclaw/plugin-sdk/plugin-state-runtime";
import {
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
  getNodeSqliteKysely,
  openNodeSqliteDatabase,
  requestSqliteWorkerOperationAdmission,
  runSqliteImmediateTransactionSync,
  type SqliteWorkerBackend,
  type SqliteWorkerCommand,
} from "openclaw/plugin-sdk/sqlite-worker-runtime";
import { ActivityArtworkStore } from "./activity-artwork.worker.js";
import type {
  ActivityDefinition,
  ActivityContinueMutation,
  ActivityDirectMutation,
  ActivityPracticeOffer,
  DailyActivityBundle,
  DailyArtworkBundle,
  ActivityGrade,
} from "./activity-contract.js";
import { ActivityInputError } from "./activity-error.js";
import { gradeActivityAnswer } from "./activity-grading.js";
import { migrateActivityDatabase, type ActivityDatabase } from "./activity-migration.js";
import {
  applyActivityAnswer,
  initialActivityProgress,
  perfectDayStatus,
  readActivityProgress,
  updatePerfectDayCheckpoint,
} from "./activity-progress.js";
import {
  canContinueActivity,
  projectActivityEvidence,
  projectActivitySnapshot,
  readActivity,
  readDay,
  type DayContent,
} from "./activity-read-model.js";
import {
  encodeActivityMutation,
  type ActivityStoreAdmission,
  type ActivityStoreOperations,
  type ActivityStoreTarget,
} from "./activity-store-contract.js";
import { validateActivityDefinition, validateDailyActivityBundle } from "./activity-validation.js";

type PetRow = ActivityDatabase["kids_pet"];
type DayRow = ActivityDatabase["kids_day"];
type ActivityRow = ActivityDatabase["kids_activity"];
const HISTORY_MS = 90 * 24 * 60 * 60_000;

class ActivityDatabaseOwner {
  private readonly query;
  private readonly artwork: ActivityArtworkStore;
  constructor(private readonly db: DatabaseSync) {
    this.query = getNodeSqliteKysely<ActivityDatabase>(db);
    this.artwork = new ActivityArtworkStore(db);
  }

  private pet(childId: string): PetRow {
    return (
      executeSqliteQueryTakeFirstSync(
        this.db,
        this.query.selectFrom("kids_pet").selectAll().where("child_id", "=", childId),
      ) ?? {
        child_id: childId,
        active_id: null,
        last_interaction: null,
        excited_until: null,
        streak: 0,
        perfect_day_streak: 0,
        last_perfect_date: null,
      }
    );
  }
  private byId(childId: string, id: string): ActivityRow | undefined {
    return executeSqliteQueryTakeFirstSync(
      this.db,
      this.query
        .selectFrom("kids_activity")
        .selectAll()
        .where("child_id", "=", childId)
        .where("activity_id", "=", id),
    );
  }
  private dayActivities(childId: string, date: string): ActivityRow[] {
    return executeSqliteQuerySync(
      this.db,
      this.query
        .selectFrom("kids_activity")
        .selectAll()
        .where("child_id", "=", childId)
        .where("date", "=", date)
        .orderBy("ordinal"),
    ).rows;
  }
  private day(childId: string, date: string): DayRow | undefined {
    return executeSqliteQueryTakeFirstSync(
      this.db,
      this.query
        .selectFrom("kids_day")
        .selectAll()
        .where("child_id", "=", childId)
        .where("date", "=", date),
    );
  }
  private latestDay(target: ActivityStoreTarget): DayRow | undefined {
    return executeSqliteQueryTakeFirstSync(
      this.db,
      this.query
        .selectFrom("kids_day")
        .selectAll()
        .where("child_id", "=", target.childId)
        .where("date", "<=", target.date)
        .orderBy("date", "desc")
        .limit(1),
    );
  }
  private current(
    target: ActivityStoreTarget,
    pet: PetRow,
    latest: ActivityRow[],
  ): ActivityRow | undefined {
    const active = pet.active_id ? this.byId(target.childId, pet.active_id) : undefined;
    if (active && (!readActivityProgress(active).completed || active.date === latest[0]?.date)) {
      return active;
    }
    return latest[0];
  }
  private next(current: ActivityRow | undefined, latest: ActivityRow[]): ActivityRow | undefined {
    if (!current || !readActivityProgress(current).completed || current.date !== latest[0]?.date) {
      return undefined;
    }
    return latest.find(
      (row) => row.ordinal > current.ordinal && !readActivityProgress(row).started,
    );
  }

  /** Read projections never reveal grading keys or hints not yet requested. */
  snapshot(target: ActivityStoreTarget): ActivitySnapshot {
    const pet = this.pet(target.childId);
    const latest = this.latestDay(target);
    const activities = latest ? this.dayActivities(target.childId, latest.date) : [];
    const row = this.current(target, pet, activities);
    const next = this.next(row, activities);
    const activeDay =
      row?.date === latest?.date ? latest : row ? this.day(target.childId, row.date) : undefined;
    return projectActivitySnapshot({
      target,
      pet,
      latest,
      latestArtwork: this.artwork.latest(target),
      activities,
      selected: row ? { row, requiredCount: activeDay!.required_count } : undefined,
      next,
    });
  }

  /** Read bounded private history, teaching context and scene plans with explicit coverage limits. */
  prepare(target: ActivityStoreTarget) {
    const rows = executeSqliteQuerySync(
      this.db,
      this.query
        .selectFrom("kids_activity")
        .innerJoin("kids_day", (join) =>
          join
            .onRef("kids_day.child_id", "=", "kids_activity.child_id")
            .onRef("kids_day.date", "=", "kids_activity.date"),
        )
        .selectAll("kids_activity")
        .select("kids_day.required_count")
        .where("kids_activity.child_id", "=", target.childId)
        .where("kids_activity.updated_at", ">=", target.now - HISTORY_MS)
        .orderBy("kids_activity.updated_at", "desc")
        .orderBy("kids_activity.date", "desc")
        .orderBy("kids_activity.ordinal", "desc")
        .limit(14),
    ).rows;
    const recentActivities = rows.map((row) =>
      projectActivityEvidence(row, row.required_count, 32),
    );
    const recentScenes = this.artwork.recent(target);
    const count =
      executeSqliteQueryTakeFirstSync(
        this.db,
        this.query
          .selectFrom("kids_activity")
          .select((expression) => expression.fn.countAll<number>().as("count"))
          .where("child_id", "=", target.childId)
          .where("updated_at", ">=", target.now - HISTORY_MS),
      )?.count ?? 0;
    const latest = this.latestDay(target);
    return {
      snapshot: this.snapshot(target),
      learningBrief: latest ? (readDay(latest).learningBrief ?? null) : null,
      recentActivities,
      recentScenes,
      activitiesOmitted: Math.max(0, count - rows.length),
    };
  }

  findDaily(childId: string, date: string): DailyActivityBundle | null {
    const row = this.day(childId, date);
    return row
      ? {
          childId,
          date,
          ...readDay(row),
          activities: this.dayActivities(childId, date)
            .filter((activity) => activity.ordinal < row.required_count)
            .map(readActivity),
        }
      : null;
  }
  findArtwork(childId: string, date: string): DailyArtworkBundle | null {
    return this.artwork.find(childId, date);
  }

  private transaction<T>(run: () => T): T {
    return runSqliteImmediateTransactionSync(this.db, () => {
      requestSqliteWorkerOperationAdmission({ stage: "transaction", facts: undefined });
      const result = run();
      requestSqliteWorkerOperationAdmission({ stage: "commit", facts: undefined });
      return result;
    });
  }

  /** Publish the ten-question daily goal and private teaching context; a saved date is immutable. */
  publish(target: ActivityStoreTarget, bundle: DailyActivityBundle): { published: boolean } {
    validateDailyActivityBundle(bundle, target);
    return this.transaction(() => {
      if (this.findDaily(target.childId, bundle.date)) {
        return { published: false };
      }
      const content: DayContent = {
        learningBrief: bundle.learningBrief,
      };
      executeSqliteQuerySync(
        this.db,
        this.query.insertInto("kids_day").values({
          child_id: target.childId,
          date: bundle.date,
          created_at: target.now,
          content: JSON.stringify(content),
          required_count: bundle.activities.length,
        }),
      );
      executeSqliteQuerySync(
        this.db,
        this.query.insertInto("kids_activity").values(
          bundle.activities.map((activity, ordinal) => ({
            child_id: target.childId,
            activity_id: activity.id,
            date: bundle.date,
            ordinal,
            updated_at: target.now,
            definition: JSON.stringify(activity),
            progress: JSON.stringify(initialActivityProgress(activity)),
          })),
        ),
      );
      this.prune(target);
      return { published: true };
    });
  }

  /** Art shares the same transaction admission/commit guards as learning writes. */
  publishArtwork(target: ActivityStoreTarget, bundle: DailyArtworkBundle, replaceImageId?: string) {
    return this.transaction(() => this.artwork.publish(target, bundle, replaceImageId));
  }

  /**
   * Append one optional question only to a completed current day. The transaction
   * owns both admission and the single remaining ordinal, so concurrent offers
   * cannot exceed the limit. Identical retries never reset progress or selection.
   * Existing rows, receipts, scene art and pet clocks are untouched; no pruning.
   */
  offerPractice(
    target: ActivityStoreTarget,
    offer: ActivityPracticeOffer,
  ): { published: boolean; snapshot: ActivitySnapshot } {
    validateActivityDefinition(offer.activity, 1);
    return this.transaction(() => {
      const day = this.latestDay({ ...target, date: offer.date });
      const existing = this.byId(target.childId, offer.activity.id);
      if (existing) {
        if (
          existing.ordinal !== day?.required_count ||
          existing.date !== offer.date ||
          !isDeepStrictEqual(readActivity(existing), offer.activity)
        ) {
          throw new ActivityInputError("This activity ID is already used for different content.");
        }
        return { published: false, snapshot: this.snapshot(target) };
      }
      if (offer.date !== target.date) {
        throw new ActivityInputError("Offer practice only for the child's current local date.");
      }
      const activities = this.dayActivities(target.childId, offer.date);
      if (
        day?.date !== offer.date ||
        activities.length !== day.required_count ||
        activities.some((row) => !readActivityProgress(row).completed)
      ) {
        throw new ActivityInputError(
          "Finish today's scheduled challenges before offering its one extra practice question.",
        );
      }
      executeSqliteQuerySync(
        this.db,
        this.query.insertInto("kids_activity").values({
          child_id: target.childId,
          activity_id: offer.activity.id,
          date: offer.date,
          ordinal: day.required_count,
          updated_at: target.now,
          definition: JSON.stringify(offer.activity),
          progress: JSON.stringify(initialActivityProgress(offer.activity)),
        }),
      );
      return { published: true, snapshot: this.snapshot(target) };
    });
  }

  /** A receipt is authoritative even after progress moves to a different question. */
  private replay(
    target: ActivityStoreTarget,
    mutation: ActivityMutation,
  ): ActivityResult | undefined {
    const receipt = executeSqliteQueryTakeFirstSync(
      this.db,
      this.query
        .selectFrom("kids_request")
        .selectAll()
        .where("child_id", "=", target.childId)
        .where("request_id", "=", mutation.requestId),
    );
    if (!receipt) {
      return undefined;
    }
    if (receipt.input !== encodeActivityMutation(mutation)) {
      throw new ActivityInputError("This request ID was already used for another action.");
    }
    return {
      snapshot: this.snapshot(target),
      // SAFETY: admission migrates old feedback, then only mutate() writes this typed value.
      ...(receipt.feedback ? { feedback: JSON.parse(receipt.feedback) as ActivityFeedback } : {}),
    };
  }

  /** Re-read the same continuation boundary for inference admission and final commit. */
  private nextBoundary(
    target: ActivityStoreTarget,
    mutation: ActivityContinueMutation,
  ):
    | { kind: "replay"; result: ActivityResult }
    | { kind: "generate"; previous: ActivityRow; day: DayRow } {
    const replay = this.replay(target, mutation);
    if (replay) {
      return { kind: "replay", result: replay };
    }
    const previous = this.byId(target.childId, mutation.activityId);
    const day = previous ? this.day(target.childId, previous.date) : undefined;
    if (
      !previous ||
      !day ||
      previous.ordinal < day.required_count - 1 ||
      !readActivityProgress(previous).completed
    ) {
      throw new ActivityInputError("Finish the current batch before preparing more problems.");
    }
    const activities = this.dayActivities(target.childId, previous.date);
    if (activities.some((activity) => activity.ordinal === previous.ordinal + 1)) {
      return { kind: "replay", result: { snapshot: this.snapshot(target) } };
    }
    const latest = this.latestDay(target);
    const current = this.current(target, this.pet(target.childId), activities);
    if (
      current?.activity_id !== previous.activity_id ||
      !canContinueActivity(target, previous, latest, activities)
    ) {
      throw new ActivityInputError(
        "Continue the current day's completed batch. Refresh and try again.",
      );
    }
    return { kind: "generate", previous, day };
  }

  /**
   * Read-only generation admission. The immutable predecessor/successor ordering
   * survives receipt pruning and makes retries from another device safe. Never
   * infer while holding a transaction; publication repeats boundary admission.
   */
  planNext(
    target: ActivityStoreTarget,
    mutation: ActivityContinueMutation,
  ): ActivityStoreOperations["planNext"]["output"] {
    const boundary = this.nextBoundary(target, mutation);
    if (boundary.kind === "replay") {
      return boundary;
    }
    const { previous, day } = boundary;
    const prepared = this.prepare(target);
    const previousIncluded = prepared.recentActivities.some(
      (activity) => activity.id === previous.activity_id,
    );
    return {
      kind: "generate",
      date: previous.date,
      previous: projectActivityEvidence(previous, day.required_count, 256),
      history: prepared.recentActivities.filter((activity) => activity.id !== previous.activity_id),
      historyOmitted: Math.max(0, prepared.activitiesOmitted - (previousIncluded ? 0 : 1)),
      learningBrief: readDay(day).learningBrief ?? null,
    };
  }

  /**
   * Accept the generator's validated ten-question definition; recheck fresh
   * progress/date and authority, then append and start it with its receipt
   * atomically. An existing successor wins every race;
   * neither a late model result nor an uncertain retry can replace it.
   */
  publishNext(
    target: ActivityStoreTarget,
    mutation: ActivityContinueMutation,
    generationDate: string,
    activity: ActivityDefinition,
  ): ActivityResult {
    return this.transaction(() => {
      const plan = this.nextBoundary(target, mutation);
      if (plan.kind === "replay") {
        return plan.result;
      }
      if (generationDate !== plan.previous.date) {
        throw new ActivityInputError(
          "The day changed while preparing problems. Refresh and try again.",
        );
      }
      const previous = plan.previous;
      const progress = initialActivityProgress(activity);
      progress.started = true;
      executeSqliteQuerySync(
        this.db,
        this.query.insertInto("kids_activity").values({
          child_id: target.childId,
          activity_id: activity.id,
          date: previous.date,
          ordinal: previous.ordinal + 1,
          updated_at: target.now,
          definition: JSON.stringify(activity),
          progress: JSON.stringify(progress),
        }),
      );
      const pet = this.pet(target.childId);
      pet.active_id = activity.id;
      executeSqliteQuerySync(
        this.db,
        this.query
          .insertInto("kids_pet")
          .values(pet)
          .onConflict((conflict) => conflict.column("child_id").doUpdateSet(pet)),
      );
      executeSqliteQuerySync(
        this.db,
        this.query.insertInto("kids_request").values({
          child_id: target.childId,
          request_id: mutation.requestId,
          created_at: target.now,
          input: encodeActivityMutation(mutation),
          feedback: null,
        }),
      );
      this.prune(target);
      return { snapshot: this.snapshot(target) };
    });
  }

  /** Resolve current mutable progress afresh; never carry a pre-inference snapshot into commit. */
  private currentMutation(
    target: ActivityStoreTarget,
    mutation: Exclude<ActivityDirectMutation, { kind: "touch" }>,
    pet: PetRow,
  ) {
    const latest = this.latestDay(target);
    const activities = latest ? this.dayActivities(target.childId, latest.date) : [];
    const current = this.current(target, pet, activities);
    const next = mutation.kind === "start" ? this.next(current, activities) : undefined;
    const row = next?.activity_id === mutation.activityId ? next : current;
    if (!row || row.activity_id !== mutation.activityId) {
      throw new ActivityInputError(
        "This activity changed. Refresh and continue the current activity.",
      );
    }
    const activity = readActivity(row);
    const progress = readActivityProgress(row);
    if (progress.completed) {
      throw new ActivityInputError("This activity is already complete.");
    }
    const question = activity.questions[progress.index];
    const evidence = progress.questions[progress.index];
    if (!question || !evidence) {
      throw new ActivityInputError("This activity cannot continue.");
    }
    if (mutation.kind !== "start" && question.id !== mutation.questionId) {
      throw new ActivityInputError(
        "This question was already answered. Continue the current question.",
      );
    }
    if (mutation.kind !== "start" && !progress.started) {
      throw new ActivityInputError("Start the activity first.");
    }
    if (mutation.kind === "answer" && mutation.answer.kind !== question.kind) {
      throw new ActivityInputError("This answer does not match the current question.");
    }
    return { row, activity, progress, question, evidence, day: latest, dayActivities: activities };
  }

  /** Read-only inference admission. A completed retry never starts another model call. */
  planAnswer(
    target: ActivityStoreTarget,
    mutation: Extract<ActivityMutation, { kind: "answer" }>,
  ): ActivityStoreOperations["planAnswer"]["output"] {
    const replay = this.replay(target, mutation);
    if (replay) {
      return { kind: "replay", result: replay };
    }
    const { question } = this.currentMutation(target, mutation, this.pet(target.childId));
    if (question.kind !== "explanation") {
      throw new ActivityInputError("This question does not need explanation grading.");
    }
    return { kind: "grade", question };
  }

  /** Commit a fresh grade, evidence, progress and receipt together after final host authority. */
  mutate(
    target: ActivityStoreTarget,
    mutation: ActivityDirectMutation,
    preparedGrade?: ActivityGrade,
  ): ActivityResult {
    return this.transaction(() => {
      const replay = this.replay(target, mutation);
      if (replay) {
        return replay;
      }
      const pet = this.pet(target.childId);
      let feedback: ActivityFeedback | undefined;
      if (mutation.kind !== "touch") {
        const { row, activity, progress, question, evidence, day, dayActivities } =
          this.currentMutation(target, mutation, pet);
        progress.started = true;
        pet.active_id = row.activity_id;
        if (mutation.kind === "hint") {
          evidence.hintUsed = true;
        }
        if (mutation.kind === "answer") {
          const grade =
            question.kind === "explanation"
              ? preparedGrade
              : gradeActivityAnswer(question, mutation.answer);
          if (!grade) {
            throw new ActivityInputError("This answer has not been checked yet.");
          }
          feedback = applyActivityAnswer(activity, progress, pet, mutation, grade, target.now);
        }
        executeSqliteQuerySync(
          this.db,
          this.query
            .updateTable("kids_activity")
            .set({ progress: JSON.stringify(progress), updated_at: target.now })
            .where("child_id", "=", target.childId)
            .where("activity_id", "=", row.activity_id),
        );
        // Only today's scheduled work can affect the day checkpoint. Older
        // carryover and optional practice never award or disqualify a day.
        if (
          day?.date === target.date &&
          row.date === target.date &&
          row.ordinal < day.required_count
        ) {
          updatePerfectDayCheckpoint(
            pet,
            target.date,
            perfectDayStatus(
              dayActivities
                .filter((candidate) => candidate.ordinal < day.required_count)
                .map((candidate) =>
                  candidate.activity_id === row.activity_id
                    ? progress
                    : readActivityProgress(candidate),
                ),
              day.required_count,
            ),
          );
        }
      }
      if (mutation.kind !== "start") {
        pet.last_interaction = target.now;
      }
      executeSqliteQuerySync(
        this.db,
        this.query
          .insertInto("kids_pet")
          .values(pet)
          .onConflict((conflict) => conflict.column("child_id").doUpdateSet(pet)),
      );
      executeSqliteQuerySync(
        this.db,
        this.query.insertInto("kids_request").values({
          child_id: target.childId,
          request_id: mutation.requestId,
          created_at: target.now,
          input: encodeActivityMutation(mutation),
          feedback: feedback ? JSON.stringify(feedback) : null,
        }),
      );
      this.prune(target);
      return { snapshot: this.snapshot(target), ...(feedback ? { feedback } : {}) };
    });
  }

  private prune(target: ActivityStoreTarget): void {
    const pet = this.pet(target.childId);
    // Retain the goal and all batches while evidence is recent or work unfinished.
    const recentDates = this.query
      .selectFrom("kids_activity")
      .select("date")
      .where("child_id", "=", target.childId)
      .where("updated_at", ">=", target.now - HISTORY_MS);
    let history = this.query
      .deleteFrom("kids_day")
      .where("child_id", "=", target.childId)
      .where("created_at", "<", target.now - HISTORY_MS)
      .where("date", "not in", recentDates);
    const active = pet.active_id ? this.byId(target.childId, pet.active_id) : undefined;
    if (active && !readActivityProgress(active).completed) {
      history = history.where("date", "!=", active.date);
    }
    executeSqliteQuerySync(this.db, history);
    const retained = this.query
      .selectFrom("kids_request")
      .select("request_id")
      .where("child_id", "=", target.childId)
      .orderBy("created_at", "desc")
      .orderBy("request_id", "desc")
      .limit(512);
    executeSqliteQuerySync(
      this.db,
      this.query
        .deleteFrom("kids_request")
        .where("child_id", "=", target.childId)
        .where("request_id", "not in", retained),
    );
  }
}

/** Broker admission owns this connection until joined close; no module-global handles. */
export function createSqliteWorkerBackend(
  input: ActivityStoreAdmission,
  context: { databasePath: string },
): SqliteWorkerBackend<ActivityStoreOperations> {
  fs.mkdirSync(path.dirname(context.databasePath), { recursive: true, mode: 0o700 });
  const db = openNodeSqliteDatabase(context.databasePath);
  let maintenance: ReturnType<typeof configureSqliteConnectionPragmas> | undefined;
  try {
    fs.chmodSync(context.databasePath, 0o600);
    maintenance = configureSqliteConnectionPragmas(db, {
      databasePath: context.databasePath,
      databaseLabel: "kids activities",
      foreignKeys: true,
      synchronous: "NORMAL",
      checkpointIntervalMs: 0,
      busyTimeoutMs: 5000,
    });
    const version = db.prepare("PRAGMA user_version").get()?.user_version;
    if (typeof version !== "number" || version > 4) {
      throw new Error("Activities database needs a newer plugin version.");
    }
    migrateActivityDatabase(db, version, input);
    const owner = new ActivityDatabaseOwner(db);
    return {
      execute(command: SqliteWorkerCommand<ActivityStoreOperations>) {
        switch (command.type) {
          case "get":
            return owner.snapshot(command.input);
          case "prepare":
            return owner.prepare(command.input);
          case "findDaily":
            return owner.findDaily(command.input.childId, command.input.date);
          case "findArtwork":
            return owner.findArtwork(command.input.childId, command.input.date);
          case "planAnswer":
            return owner.planAnswer(command.input, command.input.mutation);
          case "planNext":
            return owner.planNext(command.input, command.input.mutation);
          case "publishNext":
            return owner.publishNext(
              command.input,
              command.input.mutation,
              command.input.generationDate,
              command.input.activity,
            );
          case "mutate":
            return owner.mutate(command.input, command.input.mutation, command.input.grade);
          case "publish":
            return owner.publish(command.input, command.input.bundle);
          case "publishArtwork":
            return owner.publishArtwork(
              command.input,
              command.input.bundle,
              command.input.replaceImageId,
            );
          case "offerPractice":
            return owner.offerPractice(command.input, command.input.offer);
          default:
            throw new Error("Unsupported activity operation.");
        }
      },
      close() {
        try {
          maintenance?.close();
        } finally {
          db.close();
        }
      },
    };
  } catch (error) {
    try {
      maintenance?.close();
    } finally {
      db.close();
    }
    throw error;
  }
}
