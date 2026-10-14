import type { ActivitySnapshot } from "@openclaw/kids-activity-contract";
import { afterEach, describe, expect, it, vi } from "vitest";
// @vitest-environment jsdom
import {
  GatewayProtocolRequestError,
  retainGatewayResponsePayload,
} from "../../../packages/gateway-client/src/protocol-request.js";
import { registerKidsEnglish } from "../i18n/locales/en-kids.ts";
import {
  createGatewayRequestMock,
  createTestGatewayClient,
} from "../test-helpers/gateway-client.ts";
import { KidsActivity } from "./activity.ts";

registerKidsEnglish();

const binding = { sessionKey: "agent:student:kids:child", sessionId: "session-one" };
const owners: KidsActivity[] = [];

function gatewayError(code: string): GatewayProtocolRequestError {
  const error = new GatewayProtocolRequestError({ code, message: "Synthetic response" });
  retainGatewayResponsePayload(error, {});
  return error;
}

function snapshot(): ActivitySnapshot {
  return {
    now: 1000,
    date: "2026-10-13",
    correctStreak: 0,
    daily: { date: "2026-10-13", total: 3, completed: 0 },
    nextActivity: null,
    pet: { state: "normal", scene: null, image: null, lastInteractionAt: null, excitedUntil: null },
    activity: {
      id: "fractions",
      date: "2026-10-13",
      title: "A curious cake",
      subject: "Math",
      started: true,
      completed: false,
      currentIndex: 0,
      total: 3,
      currentQuestion: {
        id: "q1",
        prompt: "Half of four pieces?",
        hint: null,
        options: [
          { id: "a", text: "Two" },
          { id: "b", text: "Three" },
        ],
      },
    },
  };
}

function setup() {
  const request = createGatewayRequestMock();
  request.mockImplementation(async (method) =>
    method === "kids.activity.get" ? snapshot() : { snapshot: snapshot() },
  );
  const changed = vi.fn();
  const owner = new KidsActivity(createTestGatewayClient(request), changed);
  owners.push(owner);
  owner.bind(binding);
  return { owner, request, changed };
}

afterEach(async () => {
  await Promise.all(owners.splice(0).map((owner) => owner.dispose()));
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("kids activity ownership", () => {
  it("starts the offered next challenge once and retains that target through an uncertain retry", async () => {
    const { owner, request } = setup();
    const completed = snapshot();
    completed.activity!.completed = true;
    completed.activity!.currentQuestion = null;
    completed.daily!.completed = 1;
    completed.nextActivity = { id: "leaf-boats", title: "A floating leaf" };
    request.mockResolvedValueOnce(completed);
    await owner.refresh();
    expect(request.mock.calls.every(([method]) => method === "kids.activity.get")).toBe(true);
    let reject!: (reason: Error) => void;
    request.mockReturnValueOnce(
      new Promise((_, fail) => {
        reject = fail;
      }),
    );
    const starting = owner.act("start");
    await owner.act("start");
    const original = request.mock.calls.find(([method]) => method === "kids.activity.start");
    expect(original?.[1]).toMatchObject({ activityId: "leaf-boats" });
    reject(new Error("Connection closed after submission"));
    await starting;
    expect(owner.state.canRetry).toBe(true);
    owner.disconnect();
    owner.bind(binding);
    const later = structuredClone(completed);
    later.nextActivity = { id: "shadow-play", title: "A moving shadow" };
    request.mockResolvedValueOnce(later);
    await owner.refresh();
    request.mockResolvedValueOnce({ snapshot: later });
    await owner.retry();
    expect(request.mock.calls.filter(([method]) => method === "kids.activity.start")).toEqual([
      original,
      original,
    ]);
    later.nextActivity = null;
    later.daily!.completed = 3;
    request.mockResolvedValueOnce(later);
    await owner.refresh();
    await owner.act("start");
    expect(request.mock.calls.filter(([method]) => method === "kids.activity.start")).toHaveLength(
      2,
    );
  });

  it.each(["transport", "UNAVAILABLE"])(
    "keeps the same answer ID after %s, across reconnect, without passive replay",
    async (failure) => {
      const { owner, request } = setup();
      await owner.refresh();
      request.mockRejectedValueOnce(
        failure === "transport" ? new Error("Socket closed") : gatewayError(failure),
      );
      await owner.act("answer", "a");
      const original = request.mock.calls.find(([method]) => method === "kids.activity.answer");
      expect(owner.state.canRetry).toBe(true);
      owner.disconnect();
      expect(owner.state.snapshot).toBeNull();
      owner.bind(binding);
      expect(owner.state.error).toContain("Try again");
      await owner.refresh();
      expect(
        request.mock.calls.filter(([method]) => method === "kids.activity.answer"),
      ).toHaveLength(1);
      await owner.retry();
      expect(request.mock.calls.filter(([method]) => method === "kids.activity.answer")).toEqual([
        original,
        original,
      ]);
      expect(owner.state.canRetry).toBe(false);
    },
  );

  it("refreshes a definitively rejected stale question instead of replaying that answer", async () => {
    const { owner, request } = setup();
    await owner.refresh();
    request.mockRejectedValueOnce(gatewayError("INVALID_REQUEST"));
    await owner.act("answer", "a");
    expect(owner.state.canRetry).toBe(false);
    expect(owner.state.error).toContain("changed");
    const updated = snapshot();
    updated.activity!.currentIndex = 1;
    updated.activity!.currentQuestion!.id = "q2";
    request.mockResolvedValueOnce(updated);
    await owner.retry();
    expect(owner.state.snapshot?.activity?.currentQuestion?.id).toBe("q2");
    expect(owner.state.error).toBeNull();
    expect(request.mock.calls.filter(([method]) => method === "kids.activity.answer")).toHaveLength(
      1,
    );
  });

  it("hides retired responses and drops an uncertain operation on physical-session replacement", async () => {
    const { owner, request } = setup();
    let release!: (value: ActivitySnapshot) => void;
    request.mockReturnValueOnce(
      new Promise((resolve) => {
        release = resolve;
      }),
    );
    const loading = owner.refresh();
    owner.disconnect();
    owner.bind({ ...binding, sessionId: "session-two" });
    release(snapshot());
    await loading;
    expect(owner.state.snapshot).toBeNull();
    await owner.refresh();
    request.mockRejectedValueOnce(new Error("lost"));
    await owner.act("answer", "a");
    owner.disconnect();
    owner.bind({ ...binding, sessionId: "session-three" });
    await owner.retry();
    expect(request.mock.calls.filter(([method]) => method === "kids.activity.answer")).toHaveLength(
      1,
    );
    expect(owner.state.canRetry).toBe(false);
  });

  it("polls only while the app is visible and never treats opening or polling as interaction", async () => {
    vi.useFakeTimers();
    const { owner, request } = setup();
    expect(request).not.toHaveBeenCalled();
    owner.setVisible(true);
    await owner.refresh();
    await vi.advanceTimersByTimeAsync(15_000);
    expect(request).toHaveBeenCalledTimes(2);
    owner.setVisible(false);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(request).toHaveBeenCalledTimes(2);
    expect(request.mock.calls.every(([method]) => method === "kids.activity.get")).toBe(true);
  });

  it("serializes a turn behind grading and keeps feedback only for the same activity", async () => {
    const { owner, request } = setup();
    await owner.refresh();
    let release!: (value: unknown) => void;
    request.mockReturnValueOnce(
      new Promise((resolve) => {
        release = resolve;
      }),
    );
    const answering = owner.act("answer", "a");
    owner.touch("chat");
    owner.touch("voice");
    await owner.act("answer", "b");
    expect(request).toHaveBeenCalledTimes(2);
    release({
      snapshot: snapshot(),
      feedback: {
        questionId: "q1",
        correct: true,
        independent: true,
        explanation: "Four divided into two equal groups gives two.",
      },
    });
    await answering;
    await owner.refresh();
    expect(request.mock.calls.filter(([method]) => method === "kids.activity.touch")).toHaveLength(
      1,
    );
    expect(owner.state.feedback?.prompt).toBe("Half of four pieces?");
    expect(owner.state.feedback?.correct).toBe(true);
    const nextDay = snapshot();
    nextDay.activity!.id = "tomorrows-puzzle";
    request.mockResolvedValueOnce(nextDay);
    await owner.refresh();
    expect(owner.state.feedback).toBeNull();
  });

  it("retains the submitted quiz feedback when its final answer reveals today's activity", async () => {
    const { owner, request } = setup();
    const yesterday = snapshot();
    yesterday.activity!.date = "2026-10-12";
    yesterday.activity!.currentIndex = 2;
    yesterday.activity!.currentQuestion!.id = "q3";
    request.mockResolvedValueOnce(yesterday);
    await owner.refresh();
    const today = snapshot();
    today.activity!.id = "fresh-discovery";
    today.activity!.title = "Today's fresh discovery";
    today.activity!.started = false;
    request.mockResolvedValueOnce({
      snapshot: today,
      feedback: {
        questionId: "q3",
        correct: true,
        independent: true,
        explanation: "Four divided into two equal groups gives two.",
      },
    });
    await owner.act("answer", "a");
    expect(owner.state.snapshot?.activity?.id).toBe("fresh-discovery");
    expect(owner.state.feedback).toMatchObject({
      prompt: "Half of four pieces?",
      activity: { id: "fractions", title: "A curious cake", subject: "Math" },
      explanation: "Four divided into two equal groups gives two.",
    });
    request.mockResolvedValueOnce(today);
    await owner.refresh();
    expect(owner.state.feedback?.activity.id).toBe("fractions");
    owner.continue();
    expect(owner.state.feedback).toBeNull();
    expect(owner.state.snapshot?.activity?.title).toBe("Today's fresh discovery");
  });

  it("releases private picture URLs and discards late media on disconnect", async () => {
    const create = vi.fn(() => "blob:private-pet");
    const revoke = vi.fn();
    vi.stubGlobal(
      "URL",
      class extends URL {
        static override createObjectURL = create;
        static override revokeObjectURL = revoke;
      },
    );
    const { owner, request } = setup();
    const scene = snapshot();
    scene.pet.image = { imageId: "opaque-image", caption: "Ready to explore" };
    request
      .mockResolvedValueOnce(scene)
      .mockResolvedValueOnce({ mimeType: "image/webp", base64: "YQ==" });
    await owner.refresh();
    expect(owner.state.imageUrl).toBe("blob:private-pet");
    owner.disconnect();
    expect(revoke).toHaveBeenCalledWith("blob:private-pet");
    expect(owner.state.imageUrl).toBeNull();
    owner.bind(binding);
    let release!: (value: unknown) => void;
    let imageStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      imageStarted = resolve;
    });
    request.mockResolvedValueOnce(scene).mockImplementationOnce(() => {
      imageStarted();
      return new Promise((resolve) => {
        release = resolve;
      });
    });
    const reading = owner.refresh();
    await started;
    owner.disconnect();
    release({ mimeType: "image/webp", base64: "YQ==" });
    await reading;
    expect(create).toHaveBeenCalledTimes(1);
    expect(owner.state.imageUrl).toBeNull();
    vi.unstubAllGlobals();
  });
});
