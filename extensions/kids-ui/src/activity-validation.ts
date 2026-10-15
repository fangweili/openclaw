/** Publication admission shared by generation preflight and the durable owner.
 * Checks model-authored content once per boundary; no provider calls or state. */
import { Type } from "typebox";
import { Check } from "typebox/value";
import type { ActivityDefinition, DailyActivityBundle } from "./activity-contract.js";
import { ActivityInputError } from "./activity-error.js";
import { parseActivityNumber } from "./activity-grading.js";
import type { ActivityStoreTarget } from "./activity-store-contract.js";

const text = (maxLength: number) => Type.String({ minLength: 1, maxLength, pattern: "\\S" });
const questionFields = {
  id: text(80),
  prompt: text(1200),
  hint: text(800),
  explanation: text(1200),
};
const questionSchema = Type.Union([
  Type.Object(
    {
      ...questionFields,
      kind: Type.Literal("choice"),
      options: Type.Array(
        Type.Object({ id: text(80), text: text(500) }, { additionalProperties: false }),
        { minItems: 2, maxItems: 5 },
      ),
      correctOptionId: text(80),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      ...questionFields,
      kind: Type.Literal("numeric"),
      answer: text(40),
      unit: Type.Union([text(40), Type.Null()]),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    { ...questionFields, kind: Type.Literal("explanation"), rubric: text(1200) },
    { additionalProperties: false },
  ),
]);

/** One bounded definition schema serves cron publication and parent-requested practice. */
export function activityDefinitionSchema(questionCount: 1 | 10) {
  return Type.Object(
    {
      id: text(160),
      title: text(160),
      subject: text(80),
      questions: Type.Array(questionSchema, { minItems: questionCount, maxItems: questionCount }),
    },
    { additionalProperties: false },
  );
}
const definitionSchemas = {
  1: activityDefinitionSchema(1),
  10: activityDefinitionSchema(10),
};
/** The requested date fences an operator's offer against a local-midnight rollover. */
export const activityPracticeOfferSchema = Type.Object(
  {
    date: Type.String({ pattern: "^\\d{4}-\\d{2}-\\d{2}$" }),
    activity: definitionSchemas[1],
  },
  { additionalProperties: false },
);

/** Validate bounded fields plus answer relationships before immutable storage. */
export function validateActivityDefinition(
  activity: unknown,
  questionCount: 1 | 10,
): asserts activity is ActivityDefinition {
  if (!Check(definitionSchemas[questionCount], activity)) {
    throw new ActivityInputError(
      `Prepare exactly ${questionCount} complete questions per challenge.`,
    );
  }
  if (
    questionCount === 10 &&
    activity.questions.filter((question) => question.kind === "choice").length > 2
  ) {
    throw new ActivityInputError("Prepare at least eight free-answer questions per batch.");
  }
  const ids = new Set<string>();
  for (const question of activity.questions) {
    if (ids.has(question.id)) {
      throw new ActivityInputError("Each question needs its own ID.");
    }
    ids.add(question.id);
    if (question.kind === "choice") {
      const options = new Set(question.options.map((option) => option.id));
      if (options.size !== question.options.length) {
        throw new ActivityInputError("Each answer option needs its own ID.");
      }
      if (!options.has(question.correctOptionId)) {
        throw new ActivityInputError("The correct answer must name an option.");
      }
    } else if (question.kind === "numeric" && !parseActivityNumber(question.answer)) {
      throw new ActivityInputError("A numeric question needs an exact decimal or fraction.");
    }
  }
}

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
  if (!Array.isArray(bundle.activities) || bundle.activities.length !== 1) {
    throw new Error("Prepare one ten-question batch for the day.");
  }
  validateActivityDefinition(bundle.activities[0], 10);

  if (!bounded(bundle.learningBrief, 8000)) {
    throw new Error("Prepare a bounded teaching brief for the next batch.");
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
