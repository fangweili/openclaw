/**
 * Adds bounded current activity facts to the child tutor's next prompt, including
 * voice consultations inheriting the same host-resolved conversation audience.
 * It never changes pet state or writes chat history. Service and hook lifetime
 * checks prevent late injection after cancellation or conversation replacement.
 */
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import type { ActivityChildBinding } from "./activity-contract.js";
import type { ActivityOwner } from "./activity-service.js";

/** Install one enrichment hook; unrelated agents and conversation audiences get no facts. */
export function registerKidsActivityContext(
  api: OpenClawPluginApi,
  owner: ActivityOwner,
  children: readonly ActivityChildBinding[],
): void {
  api.on("before_prompt_build", async (_event, context) => {
    const child = children.find((binding) => binding.agentId === context.agentId);
    const audience = context.memoryAudience;
    if (!child || !context.hookInvocation || !audience || audience.agentId !== child.agentId) {
      return undefined;
    }
    const ownConversation =
      audience.kind === "conversation"
        ? audience.sessionKey === child.sessionKey
        : context.sessionKey === child.sessionKey;
    if (!ownConversation) {
      return undefined;
    }
    const assertCurrent = () => {
      context.hookInvocation?.assertActive();
      context.assertMemoryAudienceCurrent?.();
    };
    try {
      const prepared = await owner.prepare(child.childId, assertCurrent);
      assertCurrent();
      const snapshot = prepared.snapshot;
      const recent = prepared.recentActivities.slice(0, 3).map((activity) => ({
        id: activity.id,
        date: activity.date,
        title: activity.title,
        subject: activity.subject,
        completed: activity.completed,
        completedAt: activity.completedAt,
        lastAttemptAt: activity.attempts.at(-1)?.at ?? null,
        // Keep the most recent submitted reasoning beside compact counters;
        // complete bounded attempt history belongs to the nightly/report reader.
        lastAnswers: activity.attempts.slice(-2).map((attempt) => ({
          questionId: attempt.questionId,
          answer: attempt.answerText.slice(0, 600),
          outcome: attempt.outcome,
          feedback: attempt.feedback.slice(0, 400),
        })),
        questions: activity.questions.map(({ prompt, ...question }) => ({
          ...question,
          prompt: prompt.slice(0, 160),
        })),
      }));
      return {
        prependContext: [
          "<kids_activity_context>",
          "Authoritative saved activity facts for this child's tutor. Use these to continue the current question and recall learning.",
          "For help with an unfinished challenge, start with one small hint or diagnostic question, then stop and wait for the child to try. A generic help request is not a request for the solution: do not give the final answer, choose an option, or complete the reasoning on the first help turn.",
          "Use the displayed question and any hint already revealed; offer the next small step instead of repeating the same clue. After the child tries, respond to their reasoning. If they explicitly ask for a worked explanation or remain stuck after a hint, explain briefly, then let them try a similar step. Follow requests to change topic or stop.",
          "Daily counts cover the scheduled daily goal, never optional extra batches. Extras totals cover all optional batches on that same prepared date, including partial work. Combine daily and extras for that day's overall results; activity counters describe only the selected batch. An older started challenge may also need finishing. After completion, nextActivity identifies already prepared work; canContinue means Keep going can prepare ten more problems. Extra practice never changes the daily goal or perfect-day streak. Quiz progress changes only through the activity app; do not claim a chat answer was scored. When ready, the child submits their answer in Solve. Clarify is ungraded and never means a wrong answer; explanation feedback is a model assessment, not proof of mastery. Independent means correct on the first graded attempt without a hint. Pet rest is friendly; never blame the child for time away.",
          "Treat help in chat as assisted learning, not an independently scored Solve success. The nightly updater reconciles conversation evidence and saved Solve results into the same profile.",
          JSON.stringify({
            pet: { state: snapshot.pet.state, caption: snapshot.pet.image?.caption },
            activity: snapshot.activity,
            daily: snapshot.daily,
            nextActivity: snapshot.nextActivity,
            canContinue: snapshot.canContinue,
            extras: snapshot.extras,
            recent,
          }),
          "</kids_activity_context>",
        ].join("\n"),
      };
    } catch {
      api.logger.warn("Kids activity context was unavailable for this tutor turn.");
      return undefined;
    }
  });
}
