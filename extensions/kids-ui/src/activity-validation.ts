/** Publication admission shared by generation preflight and the durable owner.
 * Checks model-authored content once per boundary; no provider calls or state. */
import type { DailyActivityBundle } from "./activity-contract.js";
import { parseActivityNumber } from "./activity-grading.js";
import type { ActivityStoreTarget } from "./activity-store-contract.js";

/** Reject malformed model output once, before it becomes immutable trusted quiz content. */
export function validateDailyActivityBundle(
  bundle: DailyActivityBundle,
  target: ActivityStoreTarget,
): void {
  const bounded = (value: unknown, max: number) =>
    typeof value === "string" && value.trim().length > 0 && value.length <= max;
  if (
    bundle.childId !== target.childId ||
    !/^\d{4}-\d{2}-\d{2}$/u.test(bundle.date) ||
    !Number.isFinite(Date.parse(bundle.date)) ||
    new Date(bundle.date).toISOString().slice(0, 10) !== bundle.date ||
    bundle.date < target.date ||
    Date.parse(bundle.date) - Date.parse(target.date) > 2 * 86_400_000
  ) {
    throw new Error("Activity publication has an invalid child or date.");
  }
  if (!Array.isArray(bundle.activities) || bundle.activities.length !== 3) {
    throw new Error("Prepare exactly three challenges for the day.");
  }
  const activityIds = new Set<string>();
  for (const activity of bundle.activities) {
    if (activityIds.has(activity?.id)) {
      throw new Error("Each daily challenge needs its own activity ID.");
    }
    activityIds.add(activity?.id);
    if (
      !bounded(activity?.id, 160) ||
      !bounded(activity.title, 160) ||
      !bounded(activity.subject, 80) ||
      !Array.isArray(activity.questions) ||
      activity.questions.length !== 3
    ) {
      throw new Error("Prepare exactly three complete questions per challenge.");
    }
    const ids = new Set<string>();
    for (const question of activity.questions) {
      if (
        !bounded(question.id, 80) ||
        ids.has(question.id) ||
        !bounded(question.prompt, 1200) ||
        !bounded(question.hint, 800) ||
        !bounded(question.explanation, 1200)
      ) {
        throw new Error("An activity question is incomplete.");
      }
      ids.add(question.id);
      if (question.kind === "choice") {
        if (
          !Array.isArray(question.options) ||
          question.options.length < 2 ||
          question.options.length > 5
        ) {
          throw new Error("A choice question needs two to five options.");
        }
        const options = new Set<string>();
        for (const option of question.options) {
          if (!bounded(option.id, 80) || options.has(option.id) || !bounded(option.text, 500)) {
            throw new Error("An activity option is invalid.");
          }
          options.add(option.id);
        }
        if (!options.has(question.correctOptionId)) {
          throw new Error("The correct answer must name an option.");
        }
      } else if (question.kind === "numeric") {
        if (
          !bounded(question.answer, 40) ||
          !parseActivityNumber(question.answer) ||
          (question.unit !== null && !bounded(question.unit, 40))
        ) {
          throw new Error(
            "A numeric question needs an exact decimal or fraction and an optional unit.",
          );
        }
      } else if (question.kind === "explanation") {
        if (!bounded(question.rubric, 1200)) {
          throw new Error("An explanation question needs a bounded private rubric.");
        }
      } else {
        throw new Error("The question format is unsupported.");
      }
    }
  }
  for (const image of [bundle.scene?.normal, bundle.scene?.excited]) {
    if (!image || !/^[a-zA-Z0-9_-]{1,160}$/u.test(image.imageId) || !bounded(image.caption, 400)) {
      throw new Error("The daily scene is incomplete.");
    }
  }
  for (const imageId of [bundle.restImages?.bored, bundle.restImages?.sleeping]) {
    if (imageId !== undefined && !/^[a-zA-Z0-9_-]{1,160}$/u.test(imageId)) {
      throw new Error("A daily resting image is invalid.");
    }
  }
  if (!bounded(bundle.stateText?.bored, 400) || !bounded(bundle.stateText?.sleeping, 400)) {
    throw new Error("Prepare the resting-state captions.");
  }
  if (!bounded(bundle.scenePrompt, 3000)) {
    throw new Error("Prepare a bounded scene description for tomorrow's continuity.");
  }
}

/** Local calendar date uses the child's configured timezone, never the host timezone. */
export function activityDate(now: number, timeZone: string): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(now));
}
