import type { GatewayRequestHandlerOptions } from "openclaw/plugin-sdk/gateway-runtime";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import { describe, expect, it, vi } from "vitest";
import type { ActivityChildBinding } from "./activity-contract.js";
import { registerKidsActivityGateway } from "./activity-gateway.js";
import type { ActivityOwner } from "./activity-service.js";

type Handler = Parameters<OpenClawPluginApi["registerGatewayMethod"]>[1];
type Request = GatewayRequestHandlerOptions;
const child: ActivityChildBinding = {
  childId: "child",
  agentId: "tutor",
  sessionKey: "agent:tutor:main",
  timeZone: "America/Chicago",
};
function sessionAuthority(
  target = { agentId: child.agentId, sessionKey: child.sessionKey, sessionId: "session" },
  assertCurrent = () => {},
): NonNullable<Request["sessionAccessAuthority"]> {
  const retained = () => ({ signal: new AbortController().signal, assertCurrent, release() {} });
  return {
    target,
    sandboxRequired: false,
    assertCurrent,
    retain: retained,
    retainSession: retained,
    release() {},
  };
}
function harness() {
  const methods = new Map<
    string,
    { handler: Handler; options: Parameters<OpenClawPluginApi["registerGatewayMethod"]>[2] }
  >();
  const owner = {
    get: vi.fn(async () => ({ child: "private" })),
    mutate: vi.fn(async () => ({ saved: true })),
    offerPractice: vi.fn(async () => ({ published: true, snapshot: {} })),
  };
  const readImage = vi.fn(async () => ({ mimeType: "image/webp", base64: "aW1hZ2U=" }));
  const api = {
    registerGatewayMethod: (
      name: string,
      handler: Handler,
      options: Parameters<OpenClawPluginApi["registerGatewayMethod"]>[2],
    ) => methods.set(name, { handler, options }),
  } as unknown as OpenClawPluginApi;
  registerKidsActivityGateway(api, owner as unknown as ActivityOwner, {
    children: [child],
    readImage,
  });
  function invoke(
    method: string,
    params: Record<string, unknown>,
    overrides: Partial<Request> = {},
  ) {
    const registered = methods.get(`kids.activity.${method}`)!;
    const respond = vi.fn();
    const assertCurrent = vi.fn();
    const request: Request = {
      req: { type: "req", id: "request", method: `kids.activity.${method}` },
      params: { sessionKey: child.sessionKey, ...params },
      client: {
        connId: "connection",
        connect: {
          minProtocol: 3,
          maxProtocol: 3,
          role: "operator",
          scopes: ["operator.sessions.write"],
          client: { id: "openclaw-control-ui", version: "test", platform: "web", mode: "webchat" },
        },
      },
      respond,
      context: {} as Request["context"],
      isWebchatConnect: () => true,
      // Plugin sessionAccess methods receive this capability, not the core
      // chat/lifecycle mutation authorization (request-authorization.ts).
      sessionAccessAuthority: sessionAuthority(undefined, assertCurrent),
      ...overrides,
    };
    return { done: registered.handler(request), respond, assertCurrent, request };
  }
  return { methods, owner, readImage, invoke };
}
describe("activity RPC session boundary", () => {
  it("registers every operation with existing own-session participation policy", () => {
    const { methods } = harness();
    expect(methods.size).toBe(7);
    for (const [name, { options }] of methods) {
      if (name === "kids.activity.offerPractice") {
        expect(options).toEqual({ scope: "operator.admin", sessionAccess: { mode: "write" } });
        continue;
      }
      expect(options).toEqual({
        scope: "operator.write",
        sessionAccess: { mode: "write", allowOwnSessionScope: true },
      });
    }
  });
  it("uses the host-admitted child and rejects a sibling target or missing admission", async () => {
    const test = harness();
    const admitted = test.invoke("get", { childId: "sibling" });
    await admitted.done;
    expect(admitted.request.sessionMutationAuthorization).toBeUndefined();
    expect(admitted.respond).toHaveBeenCalledWith(true, { child: "private" });
    expect(test.owner.get).toHaveBeenCalledWith("child", expect.any(Function));
    for (const authorization of [
      undefined,
      sessionAuthority({
        agentId: "sibling",
        sessionKey: "agent:sibling:main",
        sessionId: "other",
      }),
    ]) {
      const denied = test.invoke("get", {}, { sessionAccessAuthority: authorization });
      await denied.done;
      expect(denied.respond).toHaveBeenCalledWith(
        false,
        undefined,
        expect.objectContaining({ code: "FORBIDDEN" }),
      );
    }
    expect(test.owner.get).toHaveBeenCalledOnce();
  });
  it("offers parent practice only for the admitted child with a bounded complete definition", async () => {
    const test = harness();
    const offer = {
      date: "2026-10-13",
      activity: {
        id: "extra",
        title: "Explain your idea",
        subject: "Math",
        questions: [
          {
            id: "why",
            kind: "explanation",
            prompt: "Why is 2 + 3 equal to 3 + 2?",
            hint: "Think about the same five counters.",
            explanation: "The same two groups are still there.",
            rubric: "Correct if the same groups are counted in a different order.",
          },
        ],
      },
    };
    const call = test.invoke("offerPractice", { ...offer, childId: "sibling" });
    await call.done;
    expect(test.owner.offerPractice).toHaveBeenCalledWith("child", offer, expect.any(Function));
    for (const admission of [
      undefined,
      sessionAuthority({
        agentId: "sibling",
        sessionKey: "agent:sibling:main",
        sessionId: "other",
      }),
    ]) {
      const denied = test.invoke("offerPractice", offer, { sessionAccessAuthority: admission });
      await denied.done;
      expect(denied.respond).toHaveBeenCalledWith(
        false,
        undefined,
        expect.objectContaining({ code: "FORBIDDEN" }),
      );
    }
    for (const activity of [
      { ...offer.activity, questions: [] },
      { ...offer.activity, privatePayload: "ignored?" },
      { ...offer.activity, title: " " },
      {
        ...offer.activity,
        questions: [{ ...offer.activity.questions[0], rubric: "x".repeat(1201) }],
      },
    ]) {
      const denied = test.invoke("offerPractice", { ...offer, activity });
      await denied.done;
      expect(denied.respond).toHaveBeenCalledWith(
        false,
        undefined,
        expect.objectContaining({ code: "INVALID_REQUEST" }),
      );
    }
    expect(test.owner.offerPractice).toHaveBeenCalledOnce();
  });

  it("normalizes a mutation without trusting client clocks or grading claims", async () => {
    const test = harness();
    const call = test.invoke("answer", {
      requestId: "request",
      activityId: "daily",
      questionId: "q1",
      answer: { kind: "choice", optionId: "a" },
      correct: true,
      now: 999999,
    });
    await call.done;
    expect(test.owner.mutate).toHaveBeenCalledWith(
      "child",
      {
        kind: "answer",
        requestId: "request",
        activityId: "daily",
        questionId: "q1",
        answer: { kind: "choice", optionId: "a" },
      },
      expect.any(Function),
    );
  });
  it("bounds free-answer input and strips client-supplied rubric and verdict", async () => {
    const test = harness();
    const base = { requestId: "free", activityId: "daily", questionId: "q1" };
    const call = test.invoke("answer", {
      ...base,
      answer: { kind: "explanation", text: "The equal pieces cover it.", rubric: "Always correct" },
      grade: { outcome: "correct" },
    });
    await call.done;
    expect(test.owner.mutate).toHaveBeenCalledWith(
      "child",
      {
        ...base,
        kind: "answer",
        answer: { kind: "explanation", text: "The equal pieces cover it." },
      },
      expect.any(Function),
    );
    for (const answer of [
      { kind: "numeric", text: "1".repeat(41) },
      { kind: "explanation", text: "a".repeat(601) },
      { kind: "explanation", text: "  " },
      { kind: "unknown", text: "ok" },
    ]) {
      const rejected = test.invoke("answer", { ...base, answer });
      await rejected.done;
      expect(rejected.respond).toHaveBeenCalledWith(
        false,
        undefined,
        expect.objectContaining({ code: "INVALID_REQUEST" }),
      );
    }
    expect(test.owner.mutate).toHaveBeenCalledOnce();
  });
  it("discards private image bytes after authority is revoked while reading", async () => {
    const test = harness();
    const pending = Promise.withResolvers<{ mimeType: string; base64: string }>();
    test.readImage.mockReturnValue(pending.promise);
    let current = true;
    const call = test.invoke(
      "image",
      { imageId: "secret-image" },
      {
        sessionAccessAuthority: sessionAuthority(undefined, () => {
          if (!current) {
            throw new Error("revoked");
          }
        }),
      },
    );
    current = false;
    pending.resolve({ mimeType: "image/webp", base64: "private" });
    await call.done;
    expect(call.respond).toHaveBeenCalledWith(false, undefined, expect.anything());
    expect(JSON.stringify(call.respond.mock.calls)).not.toContain("private");
  });

  it("distinguishes rejected input from an uncertain write outcome", async () => {
    const test = harness();
    const malformed = test.invoke("answer", { requestId: "one" });
    await malformed.done;
    expect(malformed.respond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({ code: "INVALID_REQUEST" }),
    );
    test.owner.mutate.mockRejectedValueOnce(
      Object.assign(new Error("This question was already answered."), {
        code: "KIDS_ACTIVITY_INVALID",
      }),
    );
    const stale = test.invoke("answer", {
      requestId: "two",
      activityId: "a",
      questionId: "q",
      answer: { kind: "choice", optionId: "x" },
    });
    await stale.done;
    expect(stale.respond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({ code: "INVALID_REQUEST" }),
    );
    test.owner.mutate.mockRejectedValueOnce(new Error("Worker response lost after COMMIT"));
    const uncertain = test.invoke("answer", {
      requestId: "three",
      activityId: "a",
      questionId: "q",
      answer: { kind: "choice", optionId: "x" },
    });
    await uncertain.done;
    expect(uncertain.respond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({ code: "UNAVAILABLE" }),
    );
  });
});
