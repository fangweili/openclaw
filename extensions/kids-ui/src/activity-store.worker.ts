/**
 * Sole SQLite owner for published quizzes, grading evidence, idempotency receipts,
 * pet clocks, and the durable perfect-day checkpoint. Runs only in the SQLite broker worker. Admission creates/migrates schema
 * once; all state changes use one synchronous transaction with host authority at
 * BEGIN/COMMIT. Each day owns three daily quizzes, at most one parent-requested
 * practice question, and immutable mood artwork; quiz progress is independent.
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
import {
  ACTIVITY_BORED_MS,
  ACTIVITY_EXCITED_MS,
  ACTIVITY_SLEEP_MS,
  ACTIVITY_STREAK_TARGET,
  type ActivityDefinition,
  type ActivityPracticeOffer,
  type ActivityEvidence,
  type DailyActivityBundle,
  type ActivityGrade,
} from "./activity-contract.js";
import { ActivityInputError } from "./activity-error.js";
import { gradeActivityAnswer } from "./activity-grading.js";
import { migrateActivityDatabase, type ActivityDatabase } from "./activity-migration.js";
import {
  initialActivityProgress,
  perfectDayStatus,
  projectActivityProgress,
  readActivityProgress,
  updatePerfectDayCheckpoint,
  visiblePerfectDayStreak,
} from "./activity-progress.js";
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
type DayContent = Pick<DailyActivityBundle, "scene" | "scenePrompt" | "stateText" | "restImages">;
const HISTORY_MS = 90 * 24 * 60 * 60_000;

function readDay(row: DayRow): DayContent {
  // SAFETY: publish() validates day content before its sole immutable write.
  return JSON.parse(row.content) as DayContent;
}
function readActivity(row: ActivityRow): ActivityDefinition {
  // SAFETY: publication paths validate each definition before its immutable write.
  return JSON.parse(row.definition) as ActivityDefinition;
}

class ActivityDatabaseOwner {
  private readonly query;
  constructor(private readonly db: DatabaseSync) {
    this.query = getNodeSqliteKysely<ActivityDatabase>(db);
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
    const dayProgress = activities.map(readActivityProgress);
    const dayQuestions = dayProgress.flatMap((progress) => progress.questions);
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
            total: activities.length,
            completed: dayProgress.filter((progress) => progress.completed).length,
            questionsSolved: dayQuestions.filter((q) => q.correct).length,
            firstTryCorrect: dayQuestions.filter((q) => q.correct && q.attempts === 1).length,
            hintedQuestions: dayQuestions.filter((q) => q.hintUsed).length,
          }
        : null,
      nextActivity: next ? { id: next.activity_id, title: readActivity(next).title } : null,
      activity: row
        ? projectActivityProgress(readActivity(row), readActivityProgress(row), row.date)
        : null,
    };
    return snapshot;
  }

  prepare(target: ActivityStoreTarget) {
    const rows = executeSqliteQuerySync(
      this.db,
      this.query
        .selectFrom("kids_activity")
        .selectAll()
        .where("child_id", "=", target.childId)
        .where("updated_at", ">=", target.now - HISTORY_MS)
        .orderBy("updated_at", "desc")
        .orderBy("date", "desc")
        .orderBy("ordinal", "asc")
        .limit(14),
    ).rows;
    const recentActivities: ActivityEvidence[] = rows.map((row) => {
      const activity = readActivity(row);
      const progress = readActivityProgress(row);
      return {
        id: row.activity_id,
        date: row.date,
        title: activity.title,
        subject: activity.subject,
        completed: progress.completed,
        completedAt: progress.completedAt,
        questions: progress.questions,
        attempts: progress.attempts.slice(-32),
        attemptsOmitted: Math.max(
          0,
          progress.submissionCount - Math.min(32, progress.attempts.length),
        ),
      };
    });
    const recentScenes = executeSqliteQuerySync(
      this.db,
      this.query
        .selectFrom("kids_day")
        .selectAll()
        .where("child_id", "=", target.childId)
        .where("date", "<=", target.date)
        .orderBy("date", "desc")
        .limit(14),
    ).rows.map((row) => {
      const day = readDay(row);
      return {
        date: row.date,
        scene: day.scene,
        scenePrompt: day.scenePrompt,
        stateText: day.stateText,
      };
    });
    const count =
      executeSqliteQueryTakeFirstSync(
        this.db,
        this.query
          .selectFrom("kids_activity")
          .select((expression) => expression.fn.countAll<number>().as("count"))
          .where("child_id", "=", target.childId)
          .where("updated_at", ">=", target.now - HISTORY_MS),
      )?.count ?? 0;
    return {
      snapshot: this.snapshot(target),
      recentActivities,
      recentScenes,
      activitiesOmitted: Math.max(0, count - rows.length),
    };
  }

  findDaily(childId: string, date: string): DailyActivityBundle | null {
    const row = executeSqliteQueryTakeFirstSync(
      this.db,
      this.query
        .selectFrom("kids_day")
        .selectAll()
        .where("child_id", "=", childId)
        .where("date", "=", date),
    );
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

  private transaction<T>(run: () => T): T {
    return runSqliteImmediateTransactionSync(this.db, () => {
      requestSqliteWorkerOperationAdmission({ stage: "transaction", facts: undefined });
      const result = run();
      requestSqliteWorkerOperationAdmission({ stage: "commit", facts: undefined });
      return result;
    });
  }

  /** Publish the day and all three definitions together; a saved date is immutable. */
  publish(target: ActivityStoreTarget, bundle: DailyActivityBundle): { published: boolean } {
    validateDailyActivityBundle(bundle, target);
    return this.transaction(() => {
      if (this.findDaily(target.childId, bundle.date)) {
        return { published: false };
      }
      const content: DayContent = {
        scene: bundle.scene,
        scenePrompt: bundle.scenePrompt,
        stateText: bundle.stateText,
        ...(bundle.restImages ? { restImages: bundle.restImages } : {}),
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

  /** Resolve current mutable progress afresh; never carry a pre-inference snapshot into commit. */
  private currentMutation(
    target: ActivityStoreTarget,
    mutation: Exclude<ActivityMutation, { kind: "touch" }>,
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
    mutation: ActivityMutation,
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
          const answer = mutation.answer;
          const grade =
            question.kind === "explanation"
              ? preparedGrade
              : gradeActivityAnswer(question, mutation.answer);
          if (!grade) {
            throw new ActivityInputError("This answer has not been checked yet.");
          }
          const correct = grade.outcome === "correct";
          if (grade.outcome !== "clarify") {
            evidence.attempts += 1;
            evidence.correct = correct;
            evidence.independent = correct && evidence.attempts === 1 && !evidence.hintUsed;
          }
          progress.submissionCount += 1;
          progress.attempts.push({
            id: mutation.requestId,
            at: target.now,
            activityId: row.activity_id,
            questionId: question.id,
            answer: mutation.answer,
            answerText:
              answer.kind === "choice" && question.kind === "choice"
                ? question.options.find((option) => option.id === answer.optionId)!.text
                : answer.kind === "choice"
                  ? ""
                  : answer.text,
            outcome: grade.outcome,
            feedback: grade.explanation,
            ordinal: evidence.attempts,
            hintUsed: evidence.hintUsed,
            independent: correct && evidence.independent,
          });
          progress.attempts = progress.attempts.slice(-256);
          feedback = {
            questionId: question.id,
            outcome: grade.outcome,
            independent: correct && evidence.independent,
            explanation: grade.explanation,
          };
          if (grade.outcome !== "clarify") {
            pet.streak = correct ? pet.streak + 1 : 0;
            if (!correct) {
              pet.excited_until = null;
            }
          }
          if (correct) {
            progress.index += 1;
            progress.completed = progress.index === activity.questions.length;
            if (progress.completed) {
              progress.completedAt = target.now;
            }
            if (pet.streak % ACTIVITY_STREAK_TARGET === 0) {
              pet.excited_until = target.now + ACTIVITY_EXCITED_MS;
            }
          }
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
    // Keep each day as one publication: its scene and all three definitions live
    // together, including while any quiz has recent evidence or is still active.
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
    if (typeof version !== "number" || version > 3) {
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
          case "planAnswer":
            return owner.planAnswer(command.input, command.input.mutation);
          case "mutate":
            return owner.mutate(command.input, command.input.mutation, command.input.grade);
          case "publish":
            return owner.publish(command.input, command.input.bundle);
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
