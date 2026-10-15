import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { resolveRuntimeWorkerUrl } from "openclaw/plugin-sdk/process-runtime";
import {
  openSqliteWorkerStore,
  runSqliteWorkerStoreWrite,
  type SqliteWorkerStore,
} from "openclaw/plugin-sdk/sqlite-runtime";
import { useAutoCleanupTempDirTracker } from "openclaw/plugin-sdk/test-env";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  ACTIVITY_BORED_MS,
  ACTIVITY_SLEEP_MS,
  type DailyArtworkBundle,
} from "./activity-contract.js";
import type { ActivityStoreOperations } from "./activity-store-contract.js";
import { dailyActivityBundle } from "./activity-test-helpers.js";

const date = "2026-10-13";
const now = Date.parse(`${date}T12:00:00Z`);
let databasePath: string;
let store: SqliteWorkerStore<ActivityStoreOperations>;
const tempDirs = useAutoCleanupTempDirTracker((cleanup) =>
  afterAll(async () => {
    await store?.close();
    cleanup();
  }),
);
const target = (childId: string, localDate = date) => ({
  childId,
  date: localDate,
  now: Date.parse(`${localDate}T12:00:00Z`),
});
function write<K extends "publish" | "publishArtwork" | "mutate" | "publishNext">(
  type: K,
  input: ActivityStoreOperations[K]["input"],
  guard = () => {},
) {
  return runSqliteWorkerStoreWrite(store, (scope) => scope.execute({ type, input }), guard, [
    databasePath,
  ]);
}
function art(
  bundle: DailyArtworkBundle,
  replaceImageId?: string,
  guard = () => {},
  localDate = date,
) {
  return write(
    "publishArtwork",
    { ...target(bundle.childId, localDate), bundle, replaceImageId },
    guard,
  );
}
function goal(childId: string) {
  return write("publish", { ...target(childId), bundle: dailyActivityBundle(childId) });
}
function get(childId: string, localDate = date, elapsed = 0) {
  const input = target(childId, localDate);
  return store.execute({ type: "get", input: { ...input, now: input.now + elapsed } });
}
/** Read exact owned learning rows after awaited writes; this synthetic file has no other callers. */
function learningRows(childId: string) {
  const db = new DatabaseSync(databasePath, { readOnly: true });
  try {
    return Object.fromEntries(
      ["kids_day", "kids_activity", "kids_pet", "kids_request"].map((table) => [
        table,
        db.prepare(`SELECT * FROM ${table} WHERE child_id = ? ORDER BY 1,2`).all(childId),
      ]),
    );
  } finally {
    db.close();
  }
}
beforeAll(async () => {
  databasePath = path.join(tempDirs.make("kids-artwork-"), "activities.sqlite");
  store = await openSqliteWorkerStore<ActivityStoreOperations>({
    moduleUrl: resolveRuntimeWorkerUrl({
      currentModuleUrl: import.meta.url,
      sourceWorkerName: "activity-store.worker",
      distWorkerPath: "extensions/kids-ui/src/activity-store.worker.js",
    }),
    databasePath,
    input: { children: [], now },
  });
});

describe("independent artwork persistence", () => {
  it.each([
    { moods: [] },
    { moods: ["bored"] },
    { moods: ["sleeping"] },
    { moods: ["bored", "sleeping"] },
  ] as const)(
    "selects same-day rest art and preserves fixed fallbacks for available moods $moods",
    async ({ moods }) => {
      const childId = `rest-${moods.join("-") || "legacy"}`;
      const value = dailyActivityBundle(childId);
      if (moods.length) {
        value.restImages = {};
        for (const mood of moods) {
          value.restImages[mood] = `${childId}-${mood}`;
        }
      }
      await art(value);
      await write("mutate", {
        ...target(childId),
        mutation: { kind: "touch", requestId: "wake", source: "chat" },
      });
      for (const [mood, elapsed] of [
        ["bored", ACTIVITY_BORED_MS],
        ["sleeping", ACTIVITY_SLEEP_MS],
      ] as const) {
        expect((await get(childId, date, elapsed)).pet.image).toEqual({
          imageId: value.restImages?.[mood] ?? mood,
          caption: value.stateText[mood],
        });
      }
      const saved = await store.execute({
        type: "findArtwork",
        input: { childId, date: value.date },
      });
      const { activities: _activities, learningBrief: _brief, ...artwork } = value;
      expect(saved).toEqual(artwork);
      const tomorrow = await get(childId, "2026-10-14");
      expect(tomorrow.pet.image).toEqual({
        imageId: "sleeping",
        caption: "Resting until our next adventure.",
      });
      expect(tomorrow.pet.scene).toEqual(value.scene);
    },
  );

  it("rejects invalid optional art independently from a ready daily goal", async () => {
    const value = dailyActivityBundle("invalid-rest");
    value.restImages = { bored: "../../private" };
    await goal(value.childId);
    await expect(art(value)).rejects.toThrow("resting image");
    expect((await get(value.childId)).daily?.questionTotal).toBe(10);
    expect((await get(value.childId)).pet.scene).toBeNull();
  });

  it("publishes artwork before or after Solve without creating or changing a daily goal", async () => {
    const artFirst = dailyActivityBundle("art-first");
    await art(artFirst);
    const beforeGoal = await get(artFirst.childId);
    expect(beforeGoal).toMatchObject({
      activity: null,
      daily: null,
      canContinue: false,
      perfectDayStreak: 0,
    });
    expect(beforeGoal.pet.scene).toEqual(artFirst.scene);
    await goal(artFirst.childId);
    const ready = await get(artFirst.childId);
    expect(ready.daily?.questionTotal).toBe(10);
    expect(ready.pet).toEqual(beforeGoal.pet);

    const solveFirst = dailyActivityBundle("solve-first");
    await goal(solveFirst.childId);
    const beforeArt = await get(solveFirst.childId);
    expect(beforeArt.pet.scene).toBeNull();
    const saved = learningRows(solveFirst.childId);
    await art(solveFirst);
    expect(learningRows(solveFirst.childId)).toEqual(saved);
    expect((await get(solveFirst.childId)).daily).toEqual(beforeArt.daily);
    expect((await get(solveFirst.childId)).pet.scene).toEqual(solveFirst.scene);
  });

  it("refreshes art by compare-and-replace while preserving completed goals, extras, clocks and receipts", async () => {
    const childId = "art-refresh";
    const original = dailyActivityBundle(childId);
    await goal(childId);
    await art(original);
    const activityId = original.activities[0]!.id;
    await write("mutate", {
      ...target(childId),
      mutation: { kind: "start", requestId: "start", activityId },
    });
    for (const question of original.activities[0]!.questions) {
      await write("mutate", {
        ...target(childId),
        mutation: {
          kind: "answer",
          requestId: `answer-${question.id}`,
          activityId,
          questionId: question.id,
          answer: { kind: "numeric", text: "1/2" },
        },
      });
    }
    await write("publishNext", {
      ...target(childId),
      generationDate: date,
      mutation: { kind: "continue", requestId: "extra", activityId },
      activity: { ...original.activities[0]!, id: "extra-activity" },
    });
    await write("mutate", {
      ...target(childId),
      mutation: {
        kind: "hint",
        requestId: "hint-extra",
        activityId: "extra-activity",
        questionId: "q1",
      },
    });
    const before = learningRows(childId);
    const refreshed = {
      ...original,
      scene: {
        normal: { imageId: "new-normal", caption: "A new playful moment." },
        excited: { imageId: "new-excited", caption: "A happy leap." },
      },
      restImages: { bored: "new-bored", sleeping: "new-sleeping" },
    };
    expect(await art(refreshed, original.scene.normal.imageId)).toEqual({ published: true });
    expect(learningRows(childId)).toEqual(before);
    const current = await get(childId);
    expect(current.pet.scene).toEqual(refreshed.scene);
    expect(await art(refreshed, original.scene.normal.imageId)).toEqual({ published: false });
    expect(await art(original)).toEqual({ published: false });
    expect(await art(original, "missing-image")).toEqual({ published: false });
    expect(await get(childId)).toEqual(current);
    expect(await art(dailyActivityBundle("missing-art"), "missing-image")).toEqual({
      published: false,
    });
    let admitted = true;
    const revoked = art(original, refreshed.scene.normal.imageId, () => {
      if (!admitted) throw new Error("Revoked artwork authority");
    });
    admitted = false;
    await expect(revoked).rejects.toThrow();
    expect(await get(childId)).toEqual(current);
    await expect(
      art({ ...refreshed, date: "2026-10-14" }, refreshed.scene.normal.imageId),
    ).rejects.toThrow("current local date");
    expect(learningRows(childId)).toEqual(before);
  });

  it("retains the latest usable fallback through gaps and prunes old art independently of Solve", async () => {
    const childId = "art-retention";
    const original = dailyActivityBundle(childId);
    await art(original);
    const future = dailyActivityBundle(childId, "2027-02-02");
    await art(future, undefined, undefined, "2027-02-01");
    expect((await get(childId, "2027-02-01")).pet.scene).toEqual(original.scene);
    const current = dailyActivityBundle(childId, "2027-02-01");
    await art(current, undefined, undefined, "2027-02-01");
    expect(await store.execute({ type: "findArtwork", input: { childId, date } })).toBeNull();
    expect((await get(childId, "2027-02-01")).pet.scene).toEqual(current.scene);
    expect((await get(childId, "2027-02-02")).pet.scene).toEqual(future.scene);
    expect((await get(childId, "2027-02-02")).daily).toBeNull();
  });
});
