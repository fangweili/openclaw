/** Synthetic immutable definitions for saved schema-3 history and current publication tests. */
import type { DailyActivityBundle } from "./activity-contract.js";

/** The shipped three-by-three format is loaded as history, never republished through today's validator. */
export function legacyActivityBundle(childId: string, date = "2026-10-13"): DailyActivityBundle {
  return {
    childId,
    date,
    activities: [1, 2, 3].map((index) => ({
      id: index === 1 ? `${childId}-${date}` : `${childId}-${date}-${index}`,
      title: `Berry math ${index}`,
      subject: "Math",
      questions: [1, 2, 3].map((id) => ({
        kind: "choice" as const,
        id: `q${id}`,
        prompt: `What is ${id} + 1?`,
        options: [
          { id: "yes", text: `${id + 1}` },
          { id: "no", text: "100" },
        ],
        correctOptionId: "yes",
        hint: "Count one more.",
        explanation: "Adding one moves to the next number.",
      })),
    })),
    scene: {
      normal: { imageId: `normal-${childId}-${date}`, caption: "Ready to explore?" },
      excited: { imageId: `excited-${childId}-${date}`, caption: "We figured it out!" },
    },
    scenePrompt: "Rocky builds a tiny boat from a red maple leaf beside a blue pond.",
    stateText: { bored: "Thinking of our next adventure.", sleeping: "Taking a cozy nap." },
  };
}
/** Candidate-format fixture for real publication validation and atomicity tests. */
export function dailyActivityBundle(childId: string, date = "2026-10-13"): DailyActivityBundle {
  const value = legacyActivityBundle(childId, date);
  const activity = value.activities[0]!;
  activity.questions = Array.from({ length: 10 }, (_, index) => ({
    id: `q${index + 1}`,
    kind: "numeric",
    prompt: "What is half?",
    answer: "1/2",
    unit: null,
    hint: "Think of two equal parts.",
    explanation: "Half is 1/2.",
  }));
  return {
    ...value,
    activities: [activity],
    learningBrief: "Practice fraction relationships and explain short reasoning.",
  };
}
