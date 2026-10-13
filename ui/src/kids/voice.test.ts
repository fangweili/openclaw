// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { useRealtimeTalkMicrophoneFixture } from "../pages/chat/talk/input.test-support.ts";
import type { RealtimeTalkTransportContext } from "../pages/chat/talk/shared.ts";
import { createTestGatewayClient } from "../test-helpers/gateway-client.ts";

const transport = vi.hoisted(() => ({
  contexts: [] as RealtimeTalkTransportContext[],
  start: vi.fn(async () => "ready" as const),
  stop: vi.fn(async () => undefined),
}));

vi.mock("../pages/chat/talk/transport.runtime.ts", () => ({
  createRealtimeTalkTransport: (_session: unknown, context: RealtimeTalkTransportContext) => {
    transport.contexts.push(context);
    return {
      start: async () => {
        context.input.adopt(() => undefined);
        const result = await transport.start();
        context.callbacks.onStatus?.("listening");
        return result;
      },
      stop: () => {
        context.input.stop();
        return transport.stop();
      },
    };
  },
}));

import { KidsVoice } from "./voice.ts";

const sessionKey = "agent:child:main";
const allocation = { provider: "fixture", transport: "webrtc", voiceSessionId: "voice-fixture" };

useRealtimeTalkMicrophoneFixture();

describe("kids voice owner", () => {
  beforeEach(() => {
    transport.contexts.length = 0;
    transport.start.mockReset().mockResolvedValue("ready");
    transport.stop.mockReset().mockResolvedValue(undefined);
  });

  it("uses gateway defaults and saves ordered speech in the authorized session", async () => {
    const request = vi.fn(async (method: string) =>
      method === "talk.client.create" ? allocation : { ok: true },
    );
    const voice = new KidsVoice(createTestGatewayClient(request), vi.fn());
    try {
      await voice.start(sessionKey);
      expect(request).toHaveBeenCalledWith(
        "talk.client.create",
        { sessionKey, capabilities: ["voice-transcript"] },
        { timeoutMs: 30_000 },
      );
      const callbacks = transport.contexts[0]!.callbacks;
      callbacks.onTranscript?.({ role: "user", text: "Help me with fractions", final: true });
      callbacks.onTranscript?.({ role: "assistant", text: "Let's try one together.", final: true });
      expect(voice.state).toMatchObject({ active: true, status: "listening" });
      expect(voice.state.entries.map((entry) => entry.text)).toEqual([
        "Help me with fractions",
        "Let's try one together.",
      ]);
      await voice.stop();
      expect(
        request.mock.calls.filter(([method]) => method === "talk.client.transcript"),
      ).toHaveLength(2);
      expect(request).toHaveBeenCalledWith(
        "talk.client.close",
        { sessionKey, voiceSessionId: "voice-fixture" },
        expect.objectContaining({ timeoutMs: 30_000 }),
      );
      expect(voice.state).toMatchObject({ active: false, status: "idle" });
    } finally {
      await voice.dispose();
    }
  });

  it.each(["webrtc", "gateway-relay"])(
    "joins a late %s allocation close before allowing connection teardown",
    async (kind) => {
      const creating = createDeferred<unknown>();
      const allocated = createDeferred();
      const closing = createDeferred();
      const closeRequested = createDeferred();
      const request = vi.fn(async (method: string) => {
        if (method === "talk.client.create") {
          allocated.resolve();
          return creating.promise;
        }
        if (method === "talk.client.close" || method === "talk.session.close") {
          closeRequested.resolve();
          await closing.promise;
        }
        return { ok: true };
      });
      const voice = new KidsVoice(createTestGatewayClient(request), vi.fn());
      const starting = voice.start(sessionKey);
      await allocated.promise;
      let stopped = false;
      const stopping = voice.stop().then(() => {
        stopped = true;
      });
      try {
        await expect(voice.start(sessionKey)).rejects.toThrow("closing");
        creating.resolve(
          kind === "webrtc"
            ? allocation
            : {
                provider: "fixture",
                transport: "gateway-relay",
                relaySessionId: "relay-fixture",
              },
        );
        await closeRequested.promise;
        await starting;
        expect(stopped).toBe(false);
        expect(transport.contexts).toHaveLength(0);
        closing.resolve();
        await stopping;
        expect(stopped).toBe(true);
      } finally {
        closing.resolve();
        creating.resolve(allocation);
        await Promise.allSettled([starting, stopping, voice.dispose()]);
      }
    },
  );

  it("cancels a permission prompt without allocating and releases a late microphone", async () => {
    const permission = createDeferred<MediaStream>();
    const prompted = createDeferred();
    const track = Object.assign(new EventTarget(), { stop: vi.fn() });
    vi.spyOn(navigator.mediaDevices, "getUserMedia").mockImplementation(() => {
      prompted.resolve();
      return permission.promise;
    });
    const request = vi.fn(async () => allocation);
    const onState = vi.fn();
    const voice = new KidsVoice(createTestGatewayClient(request), onState);
    const starting = voice.start(sessionKey);
    await prompted.promise;
    await voice.dispose();
    const changes = onState.mock.calls.length;
    permission.resolve({
      getTracks: () => [track],
      getAudioTracks: () => [track],
    } as unknown as MediaStream);
    await starting;
    await Promise.resolve();
    expect(track.stop).toHaveBeenCalledOnce();
    expect(request).not.toHaveBeenCalled();
    expect(onState).toHaveBeenCalledTimes(changes);
    await expect(voice.start(sessionKey)).rejects.toThrow("closing");
  });

  it("joins provisional transport cleanup after startup failure and then permits retry", async () => {
    const closing = createDeferred();
    const stopping = createDeferred();
    const failed = createDeferred();
    transport.start.mockRejectedValueOnce(new Error("Synthetic startup failure"));
    transport.stop.mockImplementationOnce(() => {
      stopping.resolve();
      return closing.promise;
    });
    const request = vi.fn(async (method: string) =>
      method === "talk.client.create" ? allocation : { ok: true },
    );
    const voice = new KidsVoice(createTestGatewayClient(request), (state) => {
      if (state.status === "stopping") {
        failed.resolve();
      }
    });
    const starting = voice.start(sessionKey).catch((error: unknown) => error);
    try {
      await Promise.all([stopping.promise, failed.promise]);
      expect(voice.state).toMatchObject({
        status: "stopping",
        detail: "Synthetic startup failure",
      });
      await expect(voice.start(sessionKey)).rejects.toThrow("closing");
      closing.resolve();
      expect(await starting).toMatchObject({ message: "Synthetic startup failure" });
      expect(request.mock.calls.filter(([method]) => method === "talk.client.close")).toHaveLength(
        1,
      );
      await voice.start(sessionKey);
      expect(voice.state.status).toBe("listening");
    } finally {
      closing.resolve();
      await starting.catch(() => undefined);
      await voice.dispose();
    }
  });

  it("ignores retired call callbacks and prevents overlapping session admission", async () => {
    const request = vi.fn(async (method: string) =>
      method === "talk.client.create" ? allocation : { ok: true },
    );
    const voice = new KidsVoice(createTestGatewayClient(request), vi.fn());
    try {
      await Promise.all([voice.start(sessionKey), voice.start(sessionKey)]);
      expect(request.mock.calls.filter(([method]) => method === "talk.client.create")).toHaveLength(
        1,
      );
      await expect(voice.start("agent:someone-else:main")).rejects.toThrow("Stop voice");
      const retired = transport.contexts[0]!.callbacks;
      await voice.stop();
      await voice.start(sessionKey);
      retired.onStatus?.("error", "stale failure");
      retired.onTranscript?.({ role: "assistant", text: "stale answer", final: true });
      expect(voice.state).toMatchObject({ status: "listening", detail: null, entries: [] });
    } finally {
      await voice.dispose();
    }
  });

  it("redacts provider details and reports cleanup failure without leaking credentials", async () => {
    const request = vi.fn(async (method: string) =>
      method === "talk.client.create" ? allocation : { ok: true },
    );
    const voice = new KidsVoice(createTestGatewayClient(request), vi.fn());
    await voice.start(sessionKey);
    transport.contexts[0]!.callbacks.onStatus?.("error", "token=synthetic-provider-secret");
    expect(voice.state.detail).not.toContain("synthetic-provider-secret");
    transport.stop.mockRejectedValueOnce(new Error("password=synthetic-close-secret"));
    await expect(voice.stop()).rejects.not.toThrow("synthetic-close-secret");
    expect(voice.state).toMatchObject({ status: "error", active: false });
    expect(voice.state.detail).not.toContain("synthetic-close-secret");
    await voice.dispose();
  });

  it("joins the remaining cleanup after one resource fails", async () => {
    vi.useFakeTimers();
    const closing = createDeferred();
    const closeRequested = createDeferred();
    const request = vi.fn(async (method: string) => {
      if (method === "talk.client.create") {
        return allocation;
      }
      if (method === "talk.client.close") {
        closeRequested.resolve();
        await closing.promise;
      }
      return { ok: true };
    });
    const voice = new KidsVoice(createTestGatewayClient(request), vi.fn());
    await voice.start(sessionKey);
    transport.stop.mockRejectedValueOnce(new Error("Synthetic transport close failure"));
    let settled = false;
    const stopping = voice.stop().catch((error: unknown) => {
      settled = true;
      return error;
    });
    try {
      await closeRequested.promise;
      await vi.advanceTimersByTimeAsync(0);
      expect(settled).toBe(false);
      closing.resolve();
      expect(await stopping).toMatchObject({ message: "Synthetic transport close failure" });
    } finally {
      closing.resolve();
      await stopping;
      await voice.dispose();
      vi.useRealTimers();
    }
  });
});
