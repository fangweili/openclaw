/**
 * Independent artwork persistence within the activity SQLite worker. This module
 * alone reads/writes kids_art; the worker lends its admitted connection and owns
 * transactions, authority, shutdown and final close. All operations are synchronous;
 * no calls or resources survive the worker. Publish must run inside the caller's
 * guarded transaction. Art dates never create goals or change learning/pet state.
 */
import type { DatabaseSync } from "node:sqlite";
import {
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
  getNodeSqliteKysely,
} from "openclaw/plugin-sdk/sqlite-worker-runtime";
import type { ActivityPreparationContext, DailyArtworkBundle } from "./activity-contract.js";
import { ActivityInputError } from "./activity-error.js";
import type { ActivityDatabase } from "./activity-migration.js";
import type { ActivityStoreTarget } from "./activity-store-contract.js";
import { validateDailyArtworkBundle } from "./activity-validation.js";

type ArtworkRow = ActivityDatabase["kids_art"];
type ArtworkContent = Omit<DailyArtworkBundle, "childId" | "date">;
const HISTORY_MS = 90 * 24 * 60 * 60_000;

function read(row: ArtworkRow): DailyArtworkBundle {
  // SAFETY: admission migration and publish are the only content writers.
  const content = JSON.parse(row.content) as ArtworkContent;
  return { childId: row.child_id, date: row.date, ...content };
}

export class ActivityArtworkStore {
  private readonly query;

  /** Borrow an admitted worker connection until the worker closes; owns no handles. */
  constructor(private readonly db: DatabaseSync) {
    this.query = getNodeSqliteKysely<ActivityDatabase>(db);
  }

  /** Find a child/date regardless of whether Solve has published its daily goal. */
  find(childId: string, date: string): DailyArtworkBundle | null {
    const row = executeSqliteQueryTakeFirstSync(
      this.db,
      this.query
        .selectFrom("kids_art")
        .selectAll()
        .where("child_id", "=", childId)
        .where("date", "=", date),
    );
    return row ? read(row) : null;
  }

  /** Latest usable art excludes future dates; null means the fixed pet is the fallback. */
  latest(target: ActivityStoreTarget): DailyArtworkBundle | null {
    const row = executeSqliteQueryTakeFirstSync(
      this.db,
      this.query
        .selectFrom("kids_art")
        .selectAll()
        .where("child_id", "=", target.childId)
        .where("date", "<=", target.date)
        .orderBy("date", "desc")
        .limit(1),
    );
    return row ? read(row) : null;
  }

  /** Bounded private continuity facts, independent of learning-day publication. */
  recent(target: ActivityStoreTarget): ActivityPreparationContext["recentScenes"] {
    return executeSqliteQuerySync(
      this.db,
      this.query
        .selectFrom("kids_art")
        .selectAll()
        .where("child_id", "=", target.childId)
        .where("date", "<=", target.date)
        .orderBy("date", "desc")
        .limit(14),
    ).rows.map((row) => {
      const art = read(row);
      return {
        date: art.date,
        scene: art.scene,
        scenePrompt: art.scenePrompt,
        stateText: art.stateText,
      };
    });
  }

  /**
   * Requires the worker's guarded write transaction. Ordinary publication is
   * once per date. A refresh compares the old normal image ID and is today-only;
   * stale/missing IDs are no-ops. No other table is touched. Errors roll back with
   * the caller's transaction; after uncertain commit, retain the new image files.
   */
  publish(
    target: ActivityStoreTarget,
    bundle: DailyArtworkBundle,
    replaceImageId?: string,
  ): { published: boolean } {
    validateDailyArtworkBundle(bundle, target);
    if (replaceImageId !== undefined && bundle.date !== target.date) {
      throw new ActivityInputError("Refresh artwork only for the child's current local date.");
    }
    const existing = this.find(target.childId, bundle.date);
    if (existing) {
      if (replaceImageId !== existing.scene.normal.imageId) {
        return { published: false };
      }
    } else if (replaceImageId !== undefined) {
      return { published: false };
    }
    const content: ArtworkContent = {
      scene: bundle.scene,
      scenePrompt: bundle.scenePrompt,
      stateText: bundle.stateText,
      ...(bundle.restImages ? { restImages: bundle.restImages } : {}),
    };
    if (existing) {
      executeSqliteQuerySync(
        this.db,
        this.query
          .updateTable("kids_art")
          .set({ content: JSON.stringify(content) })
          .where("child_id", "=", target.childId)
          .where("date", "=", bundle.date),
      );
    } else {
      executeSqliteQuerySync(
        this.db,
        this.query.insertInto("kids_art").values({
          child_id: target.childId,
          date: bundle.date,
          created_at: target.now,
          content: JSON.stringify(content),
        }),
      );
    }
    this.prune(target);
    return { published: true };
  }

  private prune(target: ActivityStoreTarget): void {
    const latest = this.latest(target);
    if (!latest) {
      return;
    }
    // Retain the latest usable picture even across a long gap in art generation.
    executeSqliteQuerySync(
      this.db,
      this.query
        .deleteFrom("kids_art")
        .where("child_id", "=", target.childId)
        .where("created_at", "<", target.now - HISTORY_MS)
        .where("date", "<", latest.date),
    );
  }
}
