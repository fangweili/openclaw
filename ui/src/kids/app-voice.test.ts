// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import type { GatewayBrowserClientOptions } from "../api/gateway.ts";
import { useRealtimeTalkMicrophoneFixture } from "../pages/chat/talk/input.test-support.ts";
import {
  createRealtimeTalkEventEmitter,
  type RealtimeTalkTransportContext,
} from "../pages/chat/talk/shared.ts";
import type { KidsViewActions, KidsViewState } from "./view.ts";

const fixture = vi.hoisted(() => ({
  options: null as GatewayBrowserClientOptions | null,
  state: null as KidsViewState | null,
  actions: null as KidsViewActions | null,
  context: null as RealtimeTalkTransportContext | null,
  request: vi.fn<(method: string, params?: unknown) => Promise<unknown>>(),
  stop: vi.fn<() => Promise<void>>(),
}));

// Keep the app, conversation, microphone and transcript owners real. Replace
// only rendering, the authenticated RPC boundary and the provider transport.
vi.mock("./view.ts", () => ({
  renderKidsView: (state: KidsViewState, actions: KidsViewActions) => {
    fixture.state = { ...state };
    fixture.actions = actions;
    return null;
  },
}));
vi.mock("../api/gateway.ts", async (original) => {
  const actual = await original<typeof import("../api/gateway.ts")>();
  return {
    ...actual,
    GatewayBrowserClient: class extends actual.GatewayBrowserClient {
      constructor(options: GatewayBrowserClientOptions) {
        super(options);
        fixture.options = options;
      }
      override get connected() {
        return true;
      }
      override start(): void {
        fixture.options?.onHello?.({
          type: "hello-ok",
          protocol: 4,
          auth: { role: "operator", scopes: ["operator.sessions.write", "operator.talk"] },
        });
      }
      override async request<T>(method: string, params?: unknown): Promise<T> {
        return (await fixture.request(method, params)) as T;
      }
    },
  };
});
vi.mock("../pages/chat/talk/transport.runtime.ts", () => ({
  createRealtimeTalkTransport: (_session: unknown, context: RealtimeTalkTransportContext) => {
    fixture.context = context;
    return {
      start: async () => {
        context.input.adopt(() => undefined);
        context.callbacks.onStatus?.("listening");
        return "ready";
      },
      stop: () => {
        context.input.stop();
        return fixture.stop();
      },
    };
  },
}));

import { KidsApp } from "./app.ts";

const allocation = {
  provider: "fixture",
  transport: "webrtc" as const,
  voiceSessionId: "voice-one",
};
const history = (leaf: string) => ({
  sessionId: "session-one",
  sessionInfo: { sessionId: "session-one", activeLeafEntryId: leaf },
  messages: [],
});

useRealtimeTalkMicrophoneFixture();
beforeEach(() => {
  vi.useFakeTimers();
  fixture.options = null;
  fixture.state = null;
  fixture.actions = null;
  fixture.context = null;
  fixture.request.mockReset();
  fixture.stop.mockReset().mockResolvedValue(undefined);
});
afterEach(() => vi.useRealTimers());

describe("kids app voice completion", () => {
  it.each(["remote close", "End Call", "provider error", "cleanup error"])(
    "%s drains transcripts and refreshes the branch before admitting the next text",
    async (ending) => {
      const transcript = createDeferred();
      const close = createDeferred();
      const refresh = createDeferred();
      const events: string[] = [];
      let reads = 0;
      fixture.request.mockImplementation(async (method, input) => {
        const params = input as Record<string, unknown>;
        switch (method) {
          case "users.self":
            return { profile: { id: "child-one", displayName: "Child" } };
          case "agents.list":
            return { agents: [{ id: "student", name: "Rocky" }] };
          case "sessions.create":
          case "sessions.messages.subscribe":
          case "sessions.messages.unsubscribe":
            return { key: params.key };
          case "chat.history":
            if (++reads === 1) {
              return history("before-voice");
            }
            events.push("history requested");
            await refresh.promise;
            return history("after-voice");
          case "talk.client.create":
            return allocation;
          case "talk.client.transcript":
            events.push("transcript requested");
            await transcript.promise;
            events.push("transcript saved");
            return { ok: true };
          case "talk.client.close":
            events.push("close requested");
            await close.promise;
            events.push("close settled");
            return { ok: true };
          case "chat.send":
            return { runId: params.idempotencyKey, status: "started" };
          default:
            throw new Error(`Unexpected request: ${method}`);
        }
      });
      const app = new KidsApp(document.createElement("div"));
      try {
        app.start();
        await vi.advanceTimersByTimeAsync(0);
        expect(fixture.state?.conversation.status).toBe("ready");
        fixture.actions!.draft("What should we practice next?");
        fixture.actions!.talk();
        await vi.advanceTimersByTimeAsync(0);
        expect(fixture.state?.voice.status).toBe("listening");
        const context = fixture.context!;
        context.callbacks.onTranscript?.({ role: "assistant", text: "Well done!", final: true });
        if (ending === "provider error") {
          context.callbacks.onStatus?.("error", "Synthetic provider interruption");
        }
        if (ending === "cleanup error") {
          fixture.stop.mockRejectedValueOnce(new Error("Synthetic cleanup failure"));
        }
        if (ending === "End Call") {
          fixture.actions!.talk();
        } else {
          createRealtimeTalkEventEmitter(
            context,
            allocation,
          )({
            type: "session.closed",
            final: true,
            payload: {},
          });
        }
        await vi.advanceTimersByTimeAsync(0);
        expect(fixture.state?.voice.status).toBe("stopping");
        expect(reads).toBe(1);
        expect(events).toEqual(["transcript requested"]);
        fixture.actions!.send();
        expect(fixture.request.mock.calls.some(([method]) => method === "chat.send")).toBe(false);

        transcript.resolve();
        await vi.advanceTimersByTimeAsync(0);
        expect(events).toEqual(["transcript requested", "transcript saved", "close requested"]);
        expect(reads).toBe(1);

        close.resolve();
        await vi.advanceTimersByTimeAsync(0);
        expect(events.at(-1)).toBe("history requested");
        expect(reads).toBe(2);
        expect(fixture.state?.voice.status).toBe("stopping");
        fixture.actions!.send();
        fixture.actions!.talk();
        expect(fixture.request.mock.calls.some(([method]) => method === "chat.send")).toBe(false);
        expect(
          fixture.request.mock.calls.filter(([method]) => method === "talk.client.create"),
        ).toHaveLength(1);

        refresh.resolve();
        await vi.advanceTimersByTimeAsync(0);
        expect(fixture.state?.voice.status).toBe(ending.endsWith("error") ? "error" : "idle");
        expect(reads).toBe(2);
        fixture.actions!.send();
        await vi.advanceTimersByTimeAsync(0);
        expect(fixture.request).toHaveBeenCalledWith(
          "chat.send",
          expect.objectContaining({
            sessionKey: "agent:student:kids:child-one",
            sessionId: "session-one",
            expectedLeafEntryId: "after-voice",
            message: "What should we practice next?",
          }),
        );
      } finally {
        transcript.resolve();
        close.resolve();
        refresh.resolve();
        await app.dispose();
      }
    },
  );
});

describe("kids app attachment ownership", () => {
  it("clears only accepted files, preserves later edits, and releases them after a backing-session reset", async () => {
    const admission = createDeferred<unknown>();
    let backing = "session-one";
    let blobId = 0;
    vi.spyOn(URL, "createObjectURL").mockImplementation(() => `blob:app-${++blobId}`);
    const revoke = vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
    class Reader extends EventTarget {
      result: string | null = null;
      abort() {}
      readAsDataURL(file: File) {
        this.result = `data:${file.type};base64,c3ludGhldGlj`;
        this.dispatchEvent(new Event("load"));
      }
    }
    vi.stubGlobal("FileReader", Reader);
    fixture.request.mockImplementation(async (method, input) => {
      const params = input as Record<string, unknown>;
      switch (method) {
        case "users.self":
          return { profile: { id: "child-one", displayName: "Child" } };
        case "agents.list":
          return { agents: [{ id: "student", name: "Rocky" }] };
        case "sessions.create":
        case "sessions.messages.subscribe":
        case "sessions.messages.unsubscribe":
          return { key: params.key };
        case "chat.history":
          return {
            ...history("leaf"),
            sessionId: backing,
            sessionInfo: { sessionId: backing, activeLeafEntryId: "leaf" },
          };
        case "chat.send":
          return admission.promise;
        default:
          throw new Error(`Unexpected request: ${method}`);
      }
    });
    const app = new KidsApp(document.createElement("div"));
    try {
      app.start();
      await vi.advanceTimersByTimeAsync(0);
      fixture.actions!.attach([new File(["synthetic"], "first.png", { type: "image/png" })]);
      fixture.actions!.send();
      expect(fixture.request).toHaveBeenCalledWith(
        "chat.send",
        expect.objectContaining({
          message: "",
          attachments: [expect.objectContaining({ fileName: "first.png" })],
        }),
      );
      fixture.actions!.attach([new File(["synthetic"], "later.mp4", { type: "video/mp4" })]);
      fixture.actions!.draft("A new caption");
      admission.resolve({ status: "started" });
      await vi.advanceTimersByTimeAsync(0);
      expect(fixture.state!.attachments.items.map((item) => item.name)).toEqual(["later.mp4"]);
      expect(fixture.state!.draft).toBe("A new caption");
      expect(revoke).toHaveBeenCalledWith("blob:app-1");
      fixture.options!.onClose!({ code: 1006, reason: "Synthetic disconnect" });
      expect(fixture.state!.conversation.status).toBe("disconnected");
      expect(fixture.state!.attachments.items).toHaveLength(1);
      fixture.options!.onHello!({ type: "hello-ok", protocol: 4 });
      await vi.advanceTimersByTimeAsync(0);
      expect(fixture.state!.draft).toBe("A new caption");
      expect(fixture.state!.attachments.items).toHaveLength(1);
      fixture.options!.onClose!({ code: 1006, reason: "Synthetic disconnect" });
      backing = "session-reset";
      fixture.options!.onHello!({ type: "hello-ok", protocol: 4 });
      await vi.advanceTimersByTimeAsync(0);
      expect(fixture.state!.draft).toBe("");
      expect(fixture.state!.attachments.items).toHaveLength(0);
      expect(revoke).toHaveBeenCalledWith("blob:app-2");
    } finally {
      admission.resolve({ status: "started" });
      await app.dispose();
      vi.restoreAllMocks();
      vi.unstubAllGlobals();
    }
  });
});
