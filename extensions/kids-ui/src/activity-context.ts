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
        // Detailed attempt evidence belongs to the nightly/report reader. A
        // tutor turn needs compact learning facts beside the full current quiz.
        questions: activity.questions.map(({ prompt, ...question }) => ({
          ...question,
          prompt: prompt.slice(0, 160),
        })),
      }));
      return {
        prependContext: `<kids_activity_context>\nAuthoritative saved activity facts for this child's tutor. Use these to continue the current question and recall learning. Daily counts cover only the latest batch; an older started challenge may also need finishing. After completion offer another challenge only when nextActivity exists, otherwise chat. Quiz progress changes only through the activity app; do not claim a chat answer was scored. Independent means correct on the first attempt without a hint. Pet rest is friendly; never blame the child for time away.\n${JSON.stringify({ pet: { state: snapshot.pet.state, caption: snapshot.pet.image?.caption }, activity: snapshot.activity, daily: snapshot.daily, nextActivity: snapshot.nextActivity, recent })}\n</kids_activity_context>`,
      };
    } catch {
      api.logger.warn("Kids activity context was unavailable for this tutor turn.");
      return undefined;
    }
  });
}
