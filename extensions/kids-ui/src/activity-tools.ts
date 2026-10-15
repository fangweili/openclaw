/**
 * Agent boundary for the activity owner. Only explicitly configured isolated cron
 * jobs discover this tool; child chat cannot generate/publish content or choose a
 * sibling. The host supplies agent/session identity and live invocation authority.
 * Cron owns schedules; this adapter owns no state, files, workers, or timers.
 * Retained calls recheck both service identity and invocation authority after waits.
 */
import type {
  AnyAgentTool,
  OpenClawPluginApi,
  OpenClawPluginToolContext,
} from "openclaw/plugin-sdk/plugin-entry";
import { jsonResult } from "openclaw/plugin-sdk/tool-results";
import { Type } from "typebox";
import { Check } from "typebox/value";
import type { ActivityPreparationContext } from "./activity-contract.js";
import type { ActivityGeneration, ActivityGenerationChild } from "./activity-generation.js";
import { activityDefinitionSchema } from "./activity-validation.js";

type ActivityEvidenceJob = { agentId: string; jobId: string };
type ActivityToolRuntime = {
  generation: ActivityGeneration;
  prepare(childId: string, assertCurrent: () => void): Promise<ActivityPreparationContext>;
};
export type ActivityToolsOptions = {
  children: readonly ActivityGenerationChild[];
  evidenceJobs?: readonly ActivityEvidenceJob[];
  /** Facades may be fresh; generation identity denotes the active service lifetime. */
  getRuntime(): ActivityToolRuntime | null;
};

const text = (maxLength: number) => Type.String({ minLength: 1, maxLength });
const preparationFields = {
  date: Type.String({ pattern: "^\\d{4}-\\d{2}-\\d{2}$" }),
  learningBrief: text(8000),
  activities: Type.Array(activityDefinitionSchema(10), { minItems: 1, maxItems: 1 }),
  normalPrompt: text(3000),
  excitedPrompt: text(1500),
  boredPrompt: text(1500),
  sleepingPrompt: text(1500),
  normalCaption: text(400),
  excitedCaption: text(400),
  boredCaption: text(400),
  sleepingCaption: text(400),
};
/** Match the canonical isolated cron run, never a child-supplied prompt or argument. */
function isJob(context: OpenClawPluginToolContext<2>, agentId: string, jobId: string): boolean {
  const prefix = `agent:${agentId}:cron:${jobId}:run:`;
  if (context.agentId !== agentId || !context.sessionKey?.startsWith(prefix)) {
    return false;
  }
  const run = context.sessionKey.slice(prefix.length);
  return run.length > 0 && !run.includes(":");
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
 * Build the narrow tool surface for an admitted cron identity, or return null.
 * Preparation binds exactly one configured child. Evidence jobs may read configured
 * children but cannot publish. Every effect uses the live host-provided assertion.
 */
function createActivityTool(
  context: OpenClawPluginToolContext<2>,
  options: ActivityToolsOptions,
): AnyAgentTool | null {
  const child = options.children.find((entry) =>
    isJob(context, entry.preparationAgentId ?? entry.agentId, entry.preparationJobId),
  );
  const evidenceReader =
    options.evidenceJobs?.some((entry) => isJob(context, entry.agentId, entry.jobId)) ?? false;
  if (!child && !evidenceReader) {
    return null;
  }
  const evidenceSchema = Type.Object(
    {
      action: Type.Literal("evidence"),
      ...(evidenceReader ? { childId: text(128) } : {}),
    },
    { additionalProperties: false },
  );
  const parameters = child
    ? Type.Union([
        Type.Object({ action: Type.Literal("prepare_context") }, { additionalProperties: false }),
        Type.Object(
          {
            action: Type.Literal("prepare_daily"),
            // The host's supported argument extends its ordinary 90-second tool watchdog.
            timeoutMs: Type.Literal(600_000),
            ...preparationFields,
          },
          { additionalProperties: false },
        ),
        evidenceSchema,
      ])
    : evidenceSchema;

  return {
    name: "kids_activity",
    label: "Kids activity preparation",
    description: child
      ? "Prepare your creation-bound child's ten-problem daily Solve goal and shared pet scene. First prepare_context for recent quiz evidence and previous scenes; read the child's profile, notes and verified conversations separately. prepare_daily accepts one fully solved ten-question activity (at least eight numeric/explanation answers, at most two choice), a dated learningBrief of current level/interests/school context and source coverage for adaptive extra batches, creative directions for normal/excited/bored/sleeping pictures, and brief mood captions. It requires normal/excited artwork, attempts both resting pictures within its remaining budget, and atomically publishes with fixed resting fallbacks when needed. It waits for admitted image calls to settle even if readiness was already published: do not call image_generate separately. A published date is a no-op. No messages are sent. evidence reads the same bounded learning evidence."
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
        // Hooks and direct host invocations can bypass the model-loop validation.
        // Reuse the advertised schema here, before admitting either read or write work.
        if (!Check(parameters, args)) {
          return toolError("Activity arguments do not match this scheduled job's schema.");
        }
        const input = args;
        if (input.action === "prepare_daily") {
          if (!child) {
            return toolError("This job can read evidence only.");
          }
          const { action: _action, timeoutMs: _timeoutMs, ...preparation } = input;
          const result = await runtime.generation.prepareDaily(child.childId, preparation, {
            assertCurrent,
            agentDir: context.agentDir,
          });
          assertCurrent();
          return jsonResult(result);
        }
        let selected = child;
        if (input.action === "evidence" && evidenceReader && input.childId) {
          selected = options.children.find((entry) => entry.childId === input.childId);
        }
        if (
          !selected ||
          (input.action !== "prepare_context" && input.action !== "evidence") ||
          (input.action === "prepare_context" && !child)
        ) {
          return toolError("This job has no matching activity child.");
        }
        const result = await runtime.prepare(selected.childId, assertCurrent);
        assertCurrent();
        return jsonResult({
          childId: selected.childId,
          timeZone: selected.timeZone,
          ...result,
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
