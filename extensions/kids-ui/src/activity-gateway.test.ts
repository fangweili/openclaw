import type { ActivityMutation } from "@openclaw/kids-activity-contract";
import type { GatewayRequestHandlerOptions } from "openclaw/plugin-sdk/gateway-runtime";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import {
  createPluginRegistryFixture,
  registerVirtualTestPlugin,
} from "openclaw/plugin-sdk/plugin-test-contracts";
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
    mutate: vi.fn(
      async (
        _childId: string,
        _mutation: ActivityMutation,
        _assertCurrent: () => void,
        _signal?: AbortSignal,
      ) => ({ saved: true }),
    ),
    offerPractice: vi.fn(async (_child: string, _offer: unknown, _assertCurrent: () => void) => ({
      published: true,
      snapshot: {},
    })),
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
          scopes: method === "offerPractice" ? ["operator.admin"] : ["operator.sessions.write"],
          client: { id: "openclaw-control-ui", version: "test", platform: "web", mode: "webchat" },
        },
      },
      respond,
      context: {} as Request["context"],
      isWebchatConnect: () => true,
      // Plugin sessionAccess methods receive this capability, not the core
      // chat/lifecycle mutation authorization (request-authorization.ts).
      sessionAccessAuthority: sessionAuthority(undefined, assertCurrent),
      signal: new AbortController().signal,
      ...overrides,
    };
    return { done: registered.handler(request), respond, assertCurrent, request };
  }
  return { methods, owner, readImage, invoke };
}
describe("activity RPC session boundary", () => {
  it("registers supported session descriptors through the real plugin registrar", () => {
    const { owner, readImage } = harness();
    const { registry, config } = createPluginRegistryFixture();
    registerVirtualTestPlugin({
      registry,
      config,
      id: "kids-ui",
      name: "Kids activities",
      register(api) {
        registerKidsActivityGateway(api, owner as unknown as ActivityOwner, {
          children: [child],
          readImage,
        });
      },
    });
    const descriptors = registry.registry.gatewayMethodDescriptors;
    expect(descriptors).toHaveLength(8);
    for (const descriptor of descriptors) {
      // The final Gateway registry permits sessionAccess only with this exact
      // scope/profile pair. Parent-only practice adds its live admin guard.
      expect(descriptor).toMatchObject({ scope: "operator.write", profileAccess: "required" });
      expect(descriptor.sessionAccess).toEqual(
        descriptor.name === "kids.activity.offerPractice"
          ? { mode: "write" }
          : { mode: "write", allowOwnSessionScope: true },
      );
      expect(registry.registry.gatewayHandlers[descriptor.name]).toBeTypeOf("function");
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
    for (const scopes of [[], ["operator.write"], ["operator.sessions.write"]]) {
      const denied = test.invoke("offerPractice", offer, {
        client: { ...call.request.client!, connect: { ...call.request.client!.connect, scopes } },
      });
      await denied.done;
      expect(denied.respond).toHaveBeenCalledWith(
        false,
        undefined,
        expect.objectContaining({ code: "FORBIDDEN" }),
      );
    }
    const anonymous = test.invoke("offerPractice", offer, { client: null });
    await anonymous.done;
    expect(anonymous.respond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({ code: "FORBIDDEN" }),
    );
    expect(test.owner.offerPractice).toHaveBeenCalledOnce();

    const pending = Promise.withResolvers<{ published: boolean; snapshot: object }>();
    test.owner.offerPractice.mockReturnValueOnce(pending.promise);
    const revoked = test.invoke("offerPractice", offer);
    const guard = test.owner.offerPractice.mock.calls[1]![2];
    revoked.request.client!.connect.scopes = ["operator.write"];
    expect(guard).toThrow("administrator");
    pending.resolve({ published: true, snapshot: {} });
    await revoked.done;
    expect(revoked.respond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({ code: "UNAVAILABLE" }),
    );
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
      call.request.signal,
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
      call.request.signal,
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
  it("continues only the host-admitted child's predecessor with the exact request signal", async () => {
    const test = harness();
    const signal = new AbortController().signal;
    const call = test.invoke(
      "continue",
      {
        requestId: "continue-request",
        activityId: "completed-batch",
        childId: "sibling",
        sessionKey: "agent:sibling:main",
        date: "2099-01-01",
        model: "client-chosen-model",
        questions: [{ answer: "already correct" }],
        generation: { completed: true },
      },
      { signal },
    );
    await call.done;
    expect(test.owner.mutate).toHaveBeenCalledExactlyOnceWith(
      "child",
      { kind: "continue", requestId: "continue-request", activityId: "completed-batch" },
      expect.any(Function),
      signal,
    );
    expect(call.respond).toHaveBeenCalledWith(true, { saved: true });
  });

  it("rejects continuation without the exact configured host session admission", async () => {
    const test = harness();
    for (const admission of [
      undefined,
      sessionAuthority({
        agentId: "sibling",
        sessionKey: "agent:sibling:main",
        sessionId: "other",
      }),
      sessionAuthority({
        agentId: child.agentId,
        sessionKey: "agent:tutor:other",
        sessionId: "other",
      }),
    ]) {
      const call = test.invoke(
        "continue",
        {
          requestId: "continue-request",
          activityId: "completed-batch",
          sessionKey: child.sessionKey,
        },
        { sessionAccessAuthority: admission },
      );
      await call.done;
      expect(call.respond).toHaveBeenCalledWith(
        false,
        undefined,
        expect.objectContaining({ code: "FORBIDDEN" }),
      );
    }
    expect(test.owner.mutate).not.toHaveBeenCalled();
  });

  it("requires bounded continuation request and predecessor identifiers before invoking the owner", async () => {
    const test = harness();
    for (const key of ["requestId", "activityId"]) {
      for (const value of [undefined, null, 1, "", " ", "a".repeat(181)]) {
        const call = test.invoke("continue", {
          requestId: "continue-request",
          activityId: "completed-batch",
          [key]: value,
        });
        await call.done;
        expect(call.respond).toHaveBeenCalledWith(
          false,
          undefined,
          expect.objectContaining({ code: "INVALID_REQUEST" }),
        );
      }
    }
    expect(test.owner.mutate).not.toHaveBeenCalled();
  });

  it.each(["revocation", "disconnect"])(
    "retains the continuation guard and discards a result after %s",
    async (source) => {
      const test = harness();
      const pending = Promise.withResolvers<{ saved: boolean }>();
      test.owner.mutate.mockReturnValueOnce(pending.promise);
      const controller = new AbortController();
      let current = true;
      const call = test.invoke(
        "continue",
        { requestId: "continue-request", activityId: "completed-batch" },
        {
          signal: controller.signal,
          sessionAccessAuthority: sessionAuthority(undefined, () => {
            if (!current) {
              throw new Error("Child access revoked");
            }
          }),
        },
      );
      const guard = test.owner.mutate.mock.calls[0]![2];
      if (source === "revocation") {
        current = false;
      } else {
        controller.abort(new Error("Browser disconnected"));
      }
      expect(guard).toThrow();
      pending.resolve({ saved: true });
      await call.done;
      expect(call.respond).toHaveBeenCalledExactlyOnceWith(
        false,
        undefined,
        expect.objectContaining({ code: "UNAVAILABLE" }),
      );
    },
  );

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
