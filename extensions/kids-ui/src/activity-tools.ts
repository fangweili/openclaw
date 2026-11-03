/**
 * Creation-bound cron adapters for the activity owner. Solve, artwork, and
 * read-only evidence jobs receive disjoint schemas; child chat receives none.
 * Cron owns frequency, the service owns state and generation, and this adapter
 * owns only bounded argument/result translation. Calls recheck invocation and
 * service lifetime after awaits; no work or mutable state survives a call.
 */
import type {
  AnyAgentTool,
  OpenClawPluginApi,
  OpenClawPluginToolContext,
} from "openclaw/plugin-sdk/plugin-entry";
import { jsonResult } from "openclaw/plugin-sdk/tool-results";
import { Type } from "typebox";
import { Check } from "typebox/value";
import type { ActivityPreparationContext, DailyActivityBundle } from "./activity-contract.js";
import type { ActivityGeneration, ActivityGenerationChild } from "./activity-generation.js";
import { activityDefinitionSchema } from "./activity-validation.js";

type ActivityEvidenceJob = { agentId: string; jobId: string };
type ActivityToolRuntime = {
  generation: ActivityGeneration;
  prepare(childId: string, assertCurrent: () => void): Promise<ActivityPreparationContext>;
  publish(bundle: DailyActivityBundle, assertCurrent: () => void): Promise<{ published: boolean }>;
};
export type ActivityToolsOptions = {
  children: readonly ActivityGenerationChild[];
  evidenceJobs?: readonly ActivityEvidenceJob[];
  /** Facades may be fresh; generation identity denotes the active service lifetime. */
  getRuntime(): ActivityToolRuntime | null;
};

const text = (maxLength: number) => Type.String({ minLength: 1, maxLength });
const dateSchema = Type.String({ pattern: "^\\d{4}-\\d{2}-\\d{2}$" });
const contextSchema = Type.Object(
  { action: Type.Literal("prepare_context") },
  { additionalProperties: false },
);
const solveSchema = Type.Union([
  contextSchema,
  Type.Object(
    {
      action: Type.Literal("prepare_daily"),
      date: dateSchema,
      learningBrief: text(8000),
      activities: Type.Array(activityDefinitionSchema(10), { minItems: 1, maxItems: 1 }),
    },
    { additionalProperties: false },
  ),
]);
const artworkSchema = Type.Union([
  contextSchema,
  Type.Object(
    {
      action: Type.Literal("prepare_art"),
      // The supported host argument extends the ordinary tool watchdog for images.
      timeoutMs: Type.Literal(600_000),
      date: dateSchema,
      replaceImageId: Type.Optional(text(128)),
      normalPrompt: text(3000),
      excitedPrompt: text(1500),
      boredPrompt: text(1500),
      sleepingPrompt: text(1500),
      normalCaption: text(400),
      excitedCaption: text(400),
      boredCaption: text(400),
      sleepingCaption: text(400),
    },
    { additionalProperties: false },
  ),
]);
const evidenceSchema = Type.Object(
  { action: Type.Literal("evidence"), childId: text(128) },
  { additionalProperties: false },
);

/** Match the canonical isolated cron run, never a child-supplied prompt or argument. */
function isJob(context: OpenClawPluginToolContext<2>, agentId: string, jobId: string): boolean {
  const prefix = `agent:${agentId}:cron:${jobId}:run:`;
  if (context.agentId !== agentId || !context.sessionKey?.startsWith(prefix)) {
    return false;
  }
  const run = context.sessionKey.slice(prefix.length);
  return run.length > 0 && !run.includes(":");
}

/**
 * Project the existing evidence owner into short-term creative context. At most
 * twelve attempts from the last 24 hours and three scene plans leave this adapter.
 * Question answers, learning briefs, and lifetime counters are intentionally absent;
 * source and projection omission counts prevent missing evidence implying inactivity.
 */
function artworkContext(context: ActivityPreparationContext) {
  const until = context.snapshot.now;
  const since = until - 24 * 60 * 60_000;
  const attempts = context.recentActivities
    .flatMap((activity) =>
      activity.attempts
        .filter((attempt) => attempt.at >= since && attempt.at <= until)
        .map((attempt) => ({
          at: attempt.at,
          title: activity.title,
          subject: activity.subject,
          outcome: attempt.outcome,
          hintUsed: attempt.hintUsed,
          independent: attempt.independent,
        })),
    )
    .toSorted((left, right) => right.at - left.at);
  return {
    date: context.snapshot.date,
    currentImageId:
      context.recentScenes.find((scene) => scene.date === context.snapshot.date)?.scene.normal
        .imageId ?? null,
    window: { since, until },
    recentAttempts: attempts.slice(0, 12),
    recentScenes: context.recentScenes
      .slice(0, 3)
      .map(({ date, scenePrompt }) => ({ date, scenePrompt })),
    omissions: {
      sourceActivities: context.activitiesOmitted,
      sourceAttempts: context.recentActivities.reduce(
        (count, activity) => count + activity.attemptsOmitted,
        0,
      ),
      windowAttempts: Math.max(0, attempts.length - 12),
      scenes: Math.max(0, context.recentScenes.length - 3),
    },
  };
}

/** Register only a version-2 tool factory; the service remains its separate lifecycle owner. */
export function registerActivityTools(
  api: Pick<OpenClawPluginApi, "registerTool">,
  options: ActivityToolsOptions,
): void {
  api.registerTool(
    { contextVersion: 2, create: (context) => createActivityTool(context, options) },
    { name: "kids_activity" },
  );
}

/**
 * Bind one admitted cron role at creation, or return null. Configuration admission
 * has rejected colliding identities. Solve/art bind one child; evidence jobs may
 * select configured children. Every effect uses the live host-provided assertion.
 */
function createActivityTool(
  context: OpenClawPluginToolContext<2>,
  options: ActivityToolsOptions,
): AnyAgentTool | null {
  const solveChild = options.children.find((entry) =>
    isJob(context, entry.preparationAgentId ?? entry.agentId, entry.preparationJobId),
  );
  const artChild = options.children.find(
    (entry) =>
      entry.artworkJobId &&
      isJob(context, entry.preparationAgentId ?? entry.agentId, entry.artworkJobId),
  );
  const evidenceReader =
    options.evidenceJobs?.some((entry) => isJob(context, entry.agentId, entry.jobId)) ?? false;
  if (!solveChild && !artChild && !evidenceReader) {
    return null;
  }
  const parameters = solveChild ? solveSchema : artChild ? artworkSchema : evidenceSchema;
  return {
    name: "kids_activity",
    label: artChild ? "Kids artwork preparation" : "Kids activity preparation",
    description: solveChild
      ? "Prepare only your creation-bound child's ten-problem daily Solve goal. First prepare_context for recent quiz evidence; read the child's profile, notes and verified conversations separately. prepare_daily accepts one fully solved ten-question activity (at least eight numeric/explanation answers, at most two choice) and a dated learningBrief for adaptive extra batches. It atomically publishes without waiting for artwork. A published date is a no-op. No artwork generation or messages are permitted."
      : artChild
        ? "Prepare only your creation-bound child's Rocky artwork. First prepare_context for the current date/image, a bounded last-24-hour activity summary and three recent scene plans. Omission counts mean missing evidence is not inactivity. Read a small recent conversation slice and verified current school/event information separately; do not read the learning profile for artwork. Give relevant holidays/events an appropriate costume or theme, with recent interactions supplying playful context; do not use weather. prepare_art requires four mood prompts/captions and timeoutMs 600000. It generates normal/excited and attempts bored/sleeping, using fixed resting fallbacks if needed. Do not call image_generate separately. Existing art is a no-op unless an explicit refresh supplies currentImageId as replaceImageId; stale IDs publish nothing. No questions, learning updates or messages are permitted."
        : "Read saved quiz attempts, support used and dated scene history for a configured child. This read-only evidence supplements transcripts and notes; do not count the same activity twice. No generation, publication or delivery is permitted.",
    parameters,
    execute: async (_toolCallId, args, signal) => {
      const runtime = options.getRuntime();
      if (!runtime) {
        return toolError("Activities are restarting. Retry this scheduled job later.");
      }
      const assertCurrent = () => {
        context.assertInvocationCurrent();
        signal?.throwIfAborted();
        if (options.getRuntime()?.generation !== runtime.generation) {
          throw new Error("The activity service changed.");
        }
      };
      try {
        assertCurrent();
        // Direct host invocations can bypass model-loop validation. Reuse this
        // role's advertised schema before admitting either read or write work.
        if (!Check(parameters, args)) {
          return toolError("Activity arguments do not match this scheduled job's schema.");
        }
        if (args.action === "prepare_daily" && solveChild) {
          const { action: _action, ...preparation } = args;
          const result = await runtime.publish(
            { childId: solveChild.childId, ...preparation },
            assertCurrent,
          );
          assertCurrent();
          return jsonResult({ ...result, date: args.date });
        }
        if (args.action === "prepare_art" && artChild) {
          const { action: _action, timeoutMs: _timeoutMs, ...preparation } = args;
          const result = await runtime.generation.prepareArtwork(artChild.childId, preparation, {
            assertCurrent,
            agentDir: context.agentDir,
          });
          assertCurrent();
          return jsonResult(result);
        }
        const selected =
          args.action === "evidence"
            ? options.children.find((entry) => entry.childId === args.childId)
            : (solveChild ?? artChild);
        if (!selected) {
          return toolError("This job has no matching activity child.");
        }
        const result = await runtime.prepare(selected.childId, assertCurrent);
        assertCurrent();
        return jsonResult({
          childId: selected.childId,
          timeZone: selected.timeZone,
          ...(artChild ? artworkContext(result) : result),
        });
      } catch {
        // Provider/config failures can contain private paths, prompts or secrets.
        return toolError(
          "Activity preparation or evidence collection failed. Previous saved activities remain valid. Retry the scheduled job after checking its service status; do not claim publication or send a replacement challenge.",
        );
      }
    },
  };
}

function toolError(message: string) {
  return { ...jsonResult({ error: message }), isError: true };
}
