import { describe, expect, it, vi } from "vitest";
import type { ActivityChildBinding } from "./activity-contract.js";
import {
  generateNextActivity,
  type NextActivityGenerationApi,
  type NextActivityGenerationPlan,
} from "./activity-next-generation.js";

const child: ActivityChildBinding = {
  childId: "student",
  agentId: "student-tutor",
  sessionKey: "agent:student-tutor:kids:student-profile",
  timeZone: "America/Chicago",
};
const plan: NextActivityGenerationPlan = {
  date: "2026-10-14",
  learningBrief: "Compare equivalent fractions; current school topic is plant growth.",
  history: [],
  historyOmitted: 0,
  previous: {
    id: "completed-batch",
    date: "2026-10-14",
    scope: "daily",
    title: "Equal parts",
    subject: "Math",
    completed: true,
    completedAt: 100,
    questions: [
      {
        questionId: "fraction",
        prompt: "Why do two quarters equal one half?",
        attempts: 2,
        hintUsed: true,
        correct: true,
        independent: false,
      },
    ],
    attempts: [
      {
        id: "attempt",
        at: 99,
        activityId: "completed-batch",
        questionId: "fraction",
        answer: { kind: "explanation", text: "They cover the same area." },
        answerText: "They cover the same area.",
        outcome: "correct",
        feedback: "Yes, the same amount is covered.",
        ordinal: 2,
        hintUsed: true,
        independent: false,
      },
    ],
    attemptsOmitted: 1,
  },
};

function generated(choiceCount = 0) {
  return {
    title: "More discoveries",
    subject: "Math, logic and science",
    questions: Array.from({ length: 10 }, (_, index) =>
      index < choiceCount
        ? {
            kind: "choice",
            prompt: "Which amount equals one half?",
            hint: "Compare equal parts.",
            explanation: "Two quarters cover one half.",
            options: [
              { id: "a", text: "Two quarters" },
              { id: "b", text: "One quarter" },
            ],
            correctOptionId: "a",
          }
        : {
            kind: "numeric",
            prompt: `What is ${index} plus one?`,
            hint: "Count one more.",
            explanation: `One more than ${index} is ${index + 1}.`,
            answer: String(index + 1),
            unit: null,
          },
    ),
  };
}

function completionResult(
  text: string,
): Awaited<ReturnType<NextActivityGenerationApi["runtime"]["llm"]["complete"]>> {
  return {
    text,
    agentId: child.agentId,
    provider: "fixture",
    model: "configured-model",
    usage: {},
    execution: { mode: "isolated-agent-runtime", owner: { kind: "harness", id: "fixture" } },
    audit: { caller: { kind: "plugin", id: "kids-ui" } },
  };
}

function harness(messages: unknown[] = []) {
  const gateway: NextActivityGenerationApi["runtime"]["gateway"] = {
    request: async () => {
      throw new Error("Unexpected unmocked Gateway request");
    },
  };
  const request = vi.spyOn(gateway, "request").mockResolvedValue({ messages });
  const complete = vi
    .fn<NextActivityGenerationApi["runtime"]["llm"]["complete"]>()
    .mockResolvedValue(completionResult(JSON.stringify(generated(2))));
  const api = { runtime: { gateway, llm: { complete } } };
  const cancel = new AbortController();
  let current = true;
  return {
    request,
    complete,
    cancel,
    revoke: () => {
      current = false;
    },
    run: (input = plan) =>
      generateNextActivity(api, child, input, cancel.signal, () => {
        if (!current) {
          throw new Error("Retired caller");
        }
      }),
  };
}

describe("next Solve batch generation", () => {
  it("uses the installed child, exact saved learning evidence and host-owned identifiers", async () => {
    const test = harness();
    const activity = await test.run();
    expect(test.request).toHaveBeenCalledExactlyOnceWith(
      "chat.history",
      { sessionKey: child.sessionKey, limit: 40 },
      { timeoutMs: 5000 },
    );
    expect(test.complete).toHaveBeenCalledOnce();
    const params = test.complete.mock.calls[0]![0];
    expect(params).toEqual({
      agentId: child.agentId,
      messages: [{ role: "user", content: expect.any(String) }],
      systemPrompt: expect.any(String),
      purpose: "kids-ui.activity-next",
      execution: { mode: "isolated-agent-runtime", timeoutMs: 90_000 },
      maxTokens: 8192,
      signal: test.cancel.signal,
    });
    expect(JSON.parse(params.messages[0]!.content)).toMatchObject({
      date: plan.date,
      learningBrief: plan.learningBrief,
      previousBatch: plan.previous,
    });
    expect(params.systemPrompt).toContain("UNSCORED context");
    expect(params.systemPrompt).toContain("do not jump levels based on speed or one answer");
    expect(activity.questions).toHaveLength(10);
    expect(new Set([activity.id, ...activity.questions.map((question) => question.id)]).size).toBe(
      11,
    );
    expect(activity.questions.filter((question) => question.kind !== "choice")).toHaveLength(8);
  });

  it("keeps saved human/voice text and final replies, excluding internal work and synthetic inputs", async () => {
    const test = harness([
      {
        role: "user",
        content: "We planted beans at school.",
        provenance: { kind: "external_user" },
        __openclaw: { id: "spoken-input", recordTimestampMs: 12 },
      },
      { role: "assistant", content: [{ type: "thinking", thinking: "private thought" }] },
      { role: "toolResult", content: "private tool output" },
      { role: "user", display: false, content: "private hidden context" },
      { role: "user", excludeFromContext: true, content: "private excluded context" },
      {
        role: "user",
        provenance: { kind: "internal_system", sourceTool: "cron" },
        content: "private cron instructions",
      },
      {
        role: "user",
        provenance: { kind: "inter_session" },
        content: "private forwarded instructions",
      },
      { role: "assistant", senderSession: { key: "other" }, content: "private forwarded reply" },
      { role: "assistant", phase: "commentary", content: "private progress" },
      { role: "assistant", stopReason: "error", content: "private failure" },
      { role: "assistant", stopReason: "toolUse", content: "private tool planning" },
      {
        role: "assistant",
        content: [
          {
            type: "text",
            text: "private signed commentary",
            textSignature: '{"v":1,"phase":"commentary"}',
          },
          { type: "text", text: "What do you predict the roots will do?" },
          { type: "image", data: "private image bytes" },
        ],
        __openclaw: { id: "reply", recordTimestampMs: 13 },
      },
      { role: "user", content: "Maybe grow downward?" },
    ]);
    await test.run();
    const prompt = test.complete.mock.calls[0]![0].messages[0]!.content;
    expect(prompt).not.toContain("private");
    expect(JSON.parse(prompt).unscoredRecentConversation).toEqual({
      coverage: "recent-tail",
      textTruncated: false,
      messages: [
        {
          role: "user",
          text: "We planted beans at school.",
          id: "spoken-input",
          at: 12,
          attribution: "external-user",
        },
        {
          role: "assistant",
          text: "What do you predict the roots will do?",
          id: "reply",
          at: 13,
          attribution: "tutor",
        },
        { role: "user", text: "Maybe grow downward?", attribution: "unspecified" },
      ],
    });
  });

  it("bounds optional conversation context to the newest text and records truncation", async () => {
    const test = harness(
      Array.from({ length: 40 }, (_, index) => ({
        role: "user",
        content: `${index}: ${"x".repeat(3000)}`,
      })),
    );
    await test.run();
    const context = JSON.parse(
      test.complete.mock.calls[0]![0].messages[0]!.content,
    ).unscoredRecentConversation;
    expect(context.textTruncated).toBe(true);
    expect(context.messages.at(-1).text).toMatch(/^39: /u);
    expect(
      context.messages.reduce(
        (total: number, message: { text: string }) => total + message.text.length,
        0,
      ),
    ).toBe(12_000);
  });

  it("uses saved evidence after optional history failure without inventing a missing brief", async () => {
    const test = harness();
    test.request.mockRejectedValue(new Error("History is temporarily unavailable"));
    await test.run({ ...plan, learningBrief: null });
    expect(JSON.parse(test.complete.mock.calls[0]![0].messages[0]!.content)).toMatchObject({
      learningBrief: null,
      previousBatch: plan.previous,
      unscoredRecentConversation: { coverage: "unavailable", messages: [] },
    });
  });

  it("retains older batch counters and marks bounded answer and prompt coverage", async () => {
    const test = harness();
    const older = {
      ...plan.previous,
      id: "older-batch",
      scope: "extra" as const,
      questions: plan.previous.questions.map((question) => ({
        ...question,
        prompt: "p".repeat(400),
      })),
      attempts: [...plan.previous.attempts, ...plan.previous.attempts, ...plan.previous.attempts],
    };
    await test.run({ ...plan, history: [older], historyOmitted: 7 });
    const input = JSON.parse(test.complete.mock.calls[0]![0].messages[0]!.content);
    expect(input.previousBatch).toEqual(plan.previous);
    expect(input.olderBatchesOmitted).toBe(7);
    expect(input.olderBatches[0]).toMatchObject({
      id: "older-batch",
      scope: "extra",
      questions: [{ attempts: 2, hintUsed: true, independent: false, promptTruncated: true }],
      attemptsOmitted: 2,
    });
    expect(input.olderBatches[0].recentAnswers).toHaveLength(2);
  });

  it.each(["FORBIDDEN", "UNAUTHORIZED", "INVALID_REQUEST"])(
    "does not treat %s as an optional history gap",
    async (code) => {
      const test = harness();
      const error = Object.assign(new Error("Access rejected"), { code });
      test.request.mockRejectedValue(error);
      await expect(test.run()).rejects.toBe(error);
      expect(test.complete).not.toHaveBeenCalled();
    },
  );

  it.each(["abort", "revoke"])("fences %s while optional history is awaiting", async (cause) => {
    const test = harness();
    const history = Promise.withResolvers<unknown>();
    test.request.mockReturnValue(history.promise);
    const operation = test.run();
    if (cause === "abort") {
      test.cancel.abort(new Error("Cancelled"));
    } else {
      test.revoke();
    }
    history.reject(new Error("Read interrupted"));
    await expect(operation).rejects.toThrow(cause === "abort" ? "Cancelled" : "Retired caller");
    expect(test.complete).not.toHaveBeenCalled();
  });

  it("does not return a late batch after cancellation during generation", async () => {
    const test = harness();
    const dispatched = Promise.withResolvers<void>();
    const completion =
      Promise.withResolvers<
        Awaited<ReturnType<NextActivityGenerationApi["runtime"]["llm"]["complete"]>>
      >();
    test.complete.mockImplementation(() => {
      dispatched.resolve();
      return completion.promise;
    });
    const operation = test.run();
    await dispatched.promise;
    test.cancel.abort(new Error("Cancelled"));
    completion.resolve(completionResult(JSON.stringify(generated())));
    await expect(operation).rejects.toThrow("Cancelled");
  });

  it.each([
    ["too many choices", () => generated(3)],
    ["wrong question count", () => ({ ...generated(), questions: generated().questions.slice(1) })],
    ["unexpected top-level field", () => ({ ...generated(), childId: "sibling" })],
    ["model-controlled activity identity", () => ({ ...generated(), id: "existing-batch" })],
    [
      "model-controlled question identity",
      () => ({
        ...generated(),
        questions: generated().questions.map((question) =>
          Object.assign(question, { id: "existing-question" }),
        ),
      }),
    ],
    [
      "invalid exact answer",
      () => ({
        ...generated(),
        questions: generated().questions.map((question) =>
          Object.assign(question, { answer: "1/0" }),
        ),
      }),
    ],
  ] as const)("rejects %s before publication", async (_name, output) => {
    const test = harness();
    test.complete.mockResolvedValue(completionResult(JSON.stringify(output())));
    const operation = test.run();
    await expect(operation).rejects.toThrow("Rocky couldn't prepare more problems");
    await expect(operation).rejects.not.toHaveProperty("code");
  });

  it.each(["not JSON", "🪨".repeat(21_000)])(
    "rejects malformed or oversized output",
    async (text) => {
      const test = harness();
      test.complete.mockResolvedValue(completionResult(text));
      await expect(test.run()).rejects.toThrow("Rocky couldn't prepare more problems");
    },
  );
});
