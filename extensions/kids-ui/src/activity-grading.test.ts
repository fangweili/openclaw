import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import { describe, expect, it, vi } from "vitest";
import type { ActivityQuestionDefinition } from "./activity-contract.js";
import {
  gradeActivityAnswer,
  gradeActivityExplanation,
  parseActivityNumber,
} from "./activity-grading.js";

const numeric: Extract<ActivityQuestionDefinition, { kind: "numeric" }> = {
  kind: "numeric",
  id: "n",
  prompt: "How much is one half?",
  hint: "Use equal parts.",
  explanation: "These describe the same amount.",
  answer: "1/2",
  unit: null,
};
const explanation: Extract<ActivityQuestionDefinition, { kind: "explanation" }> = {
  kind: "explanation",
  id: "e",
  prompt: "Why does one half equal two quarters?",
  rubric: "Recognizes splitting each half into two equal pieces leaves the amount unchanged.",
  hint: "Think about equal pieces.",
  explanation: "The amount stays the same when pieces are divided.",
};
type Complete = OpenClawPluginApi["runtime"]["llm"]["complete"];
const result = (text: string): Awaited<ReturnType<Complete>> => ({
  text,
  provider: "fixture",
  model: "fixture",
  agentId: "tutor",
  usage: {},
  execution: { mode: "isolated-agent-runtime", owner: { kind: "harness", id: "fixture" } },
  audit: { caller: { kind: "plugin", id: "kids-ui" } },
});

describe("private activity grading", () => {
  it.each(["0.5", ".50", "+2/4", "-1/-2", "5 / 10"])("compares %s as an exact rational", (text) => {
    expect(gradeActivityAnswer(numeric, { kind: "numeric", text }).outcome).toBe("correct");
  });
  it("does not round close decimals or use tolerance", () => {
    expect(
      gradeActivityAnswer(numeric, { kind: "numeric", text: "0.5000000000000001" }).outcome,
    ).toBe("revise");
    expect(
      gradeActivityAnswer(
        { ...numeric, answer: "1/3" },
        { kind: "numeric", text: ".3333333333333" },
      ).outcome,
    ).toBe("revise");
  });
  it.each([
    "",
    "1/0",
    "half",
    "0.5 cm",
    "2**3",
    "1e3",
    "0x10",
    "NaN",
    "Infinity",
    "1.2/4",
    "1".repeat(41),
  ])("leaves malformed numeric %s ungraded", (text) => {
    expect(parseActivityNumber(text)).toBeNull();
    expect(gradeActivityAnswer(numeric, { kind: "numeric", text }).outcome).toBe("clarify");
  });
  it("uses the bound child with one fresh data-only message and no tools or conversation", async () => {
    const complete = vi
      .fn<Complete>()
      .mockResolvedValue(
        result(
          '{"outcome":"correct","explanation":"Yes, the equal pieces still cover the same amount."}',
        ),
      );
    const signal = new AbortController().signal;
    const grade = await gradeActivityExplanation(complete, {
      agentId: "tutor",
      question: explanation,
      text: "I cut each half into two so it stays the same",
      signal,
    });
    expect(grade.outcome).toBe("correct");
    expect(complete).toHaveBeenCalledWith(
      expect.objectContaining({
        agentId: "tutor",
        signal,
        reasoning: "low",
        maxTokens: 256,
        execution: { mode: "isolated-agent-runtime", timeoutMs: 30_000 },
        messages: [
          {
            role: "user",
            content: JSON.stringify({
              question: explanation.prompt,
              rubric: explanation.rubric,
              answer: "I cut each half into two so it stays the same",
            }),
          },
        ],
      }),
    );
    expect(complete.mock.calls[0]![0].systemPrompt).toContain(
      "do not suggest an idea or solving step",
    );
  });
  it.each([
    "not json",
    '{"outcome":"correct","explanation":"ok","rubric":"secret"}',
    '{"outcome":"maybe","explanation":"ok"}',
    '{"outcome":"correct","explanation":""}',
    JSON.stringify({ outcome: "correct", explanation: "x".repeat(401) }),
  ])("rejects malformed provider output without a learning verdict", async (text) => {
    const complete = vi.fn<Complete>().mockResolvedValue(result(text));
    await expect(
      gradeActivityExplanation(complete, {
        agentId: "tutor",
        question: explanation,
        text: "A guess",
        signal: new AbortController().signal,
      }),
    ).rejects.toThrow("could not be checked");
  });
  it("rejects provider timeouts without leaking private errors", async () => {
    const complete = vi.fn<Complete>().mockRejectedValue(new Error("private provider timeout"));
    await expect(
      gradeActivityExplanation(complete, {
        agentId: "tutor",
        question: explanation,
        text: "A guess",
        signal: new AbortController().signal,
      }),
    ).rejects.toThrow("This answer could not be checked. Try again.");
  });
});
