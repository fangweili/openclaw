// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import type { GatewayBrowserClientOptions } from "../api/gateway.ts";
import { useKidsDraftStoreFixture } from "./app-draft.test-support.ts";
import type { KidsViewActions, KidsViewState } from "./view.ts";

const fixture = vi.hoisted(() => ({
  options: null as GatewayBrowserClientOptions | null,
  state: null as KidsViewState | null,
  actions: null as KidsViewActions | null,
  recorders: [] as Array<{
    commit: (text: string) => void;
    publish: (state: KidsViewState["dictation"]) => void;
  }>,
  request: vi.fn<(method: string, params?: unknown) => Promise<unknown>>(),
  cleanup: vi.fn<() => Promise<void>>(),
}));

// The real app and conversation own routing and drafts. The recording boundary
// deliberately emits late callbacks after disposal to exercise the app's fence.
vi.mock("./view.ts", () => ({
  renderKidsView: (state: KidsViewState, actions: KidsViewActions) => {
    fixture.state = { ...state };
    fixture.actions = actions;
    return null;
  },
}));
vi.mock("./dictation.ts", () => ({
  KidsDictation: class {
    state = { active: false, finishing: false, detail: null };
    constructor(
      _client: unknown,
      publish: (state: KidsViewState["dictation"]) => void,
      commit: (text: string) => void,
    ) {
      fixture.recorders.push({
        commit,
        publish: (state) => {
          Object.assign(this.state, state);
          publish(state);
        },
      });
    }
    async start() {
      fixture.recorders.at(-1)!.publish({ ...this.state, active: true });
    }
    async finish() {
      fixture.recorders.at(-1)!.publish({ ...this.state, active: false });
    }
    dispose() {
      return fixture.cleanup();
    }
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
      override start() {
        fixture.options!.onHello!({
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

import { KidsApp } from "./app.ts";

const drafts = useKidsDraftStoreFixture();
beforeEach(() => {
  vi.useFakeTimers({
    toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"],
  });
  fixture.recorders = [];
  fixture.cleanup.mockReset().mockResolvedValue(undefined);
  fixture.request.mockReset().mockImplementation(async (method, input) => {
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
          sessionId: "session-one",
          sessionInfo: { sessionId: "session-one", activeLeafEntryId: "leaf" },
          messages: [],
        };
      case "chat.send":
        return { runId: params.idempotencyKey, status: "started" };
      default:
        throw new Error(`Unexpected request: ${method}`);
    }
  });
});
afterEach(() => vi.useRealTimers());

it("inserts speech into the current draft without sending, and excludes simultaneous live voice", async () => {
  const app = new KidsApp(document.createElement("div"));
  try {
    app.start();
    await vi.advanceTimersByTimeAsync(0);
    await drafts.settle();
    fixture.actions!.draft("Help with");
    fixture.actions!.dictate();
    await vi.advanceTimersByTimeAsync(0);
    fixture.actions!.talk();
    fixture.actions!.send();
    expect(
      fixture.request.mock.calls.some(
        ([method]) => method === "talk.client.create" || method === "chat.send",
      ),
    ).toBe(false);
    // Preserve a newer edit if an async transcription result arrives afterward.
    fixture.actions!.draft("Can we practice");
    fixture.recorders[0]!.commit("fractions?");
    fixture.recorders[0]!.publish({ active: false, finishing: false, detail: null });
    expect(fixture.state!.draft).toBe("Can we practice fractions?");
    expect(fixture.request.mock.calls.some(([method]) => method === "chat.send")).toBe(false);
    fixture.actions!.send();
    await vi.advanceTimersByTimeAsync(0);
    expect(fixture.request).toHaveBeenCalledWith(
      "chat.send",
      expect.objectContaining({
        message: "Can we practice fractions?",
        sessionKey: "agent:student:kids:child-one",
      }),
    );
  } finally {
    await app.dispose();
  }
});

it("joins recording retirement before reconnect and rejects old draft callbacks", async () => {
  const closing = createDeferred();
  fixture.cleanup.mockReturnValueOnce(closing.promise);
  const app = new KidsApp(document.createElement("div"));
  try {
    app.start();
    await vi.advanceTimersByTimeAsync(0);
    await drafts.settle();
    fixture.actions!.draft("Keep my draft");
    fixture.actions!.dictate();
    await vi.advanceTimersByTimeAsync(0);
    const old = fixture.recorders[0]!;
    fixture.options!.onClose!({ code: 1006, reason: "Synthetic reconnect", willRetry: true });
    fixture.options!.onHello!({
      type: "hello-ok",
      protocol: 4,
      auth: { role: "operator", scopes: ["operator.sessions.write", "operator.talk"] },
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(fixture.request.mock.calls.filter(([method]) => method === "users.self")).toHaveLength(
      1,
    );
    old.commit("Old private speech");
    expect(fixture.state!.draft).toBe("");
    closing.resolve();
    await vi.advanceTimersByTimeAsync(0);
    expect(fixture.request.mock.calls.filter(([method]) => method === "users.self")).toHaveLength(
      2,
    );
    await drafts.settle();
    expect(fixture.state!.draft).toBe("Keep my draft");
    fixture.actions!.draft("New draft");
    old.commit("Old private speech");
    old.publish({ active: true, finishing: false, detail: "Old error" });
    expect(fixture.state!.draft).toBe("New draft");
    expect(fixture.state!.dictation.active).toBe(false);
    expect(fixture.state!.dictation.detail).toBeNull();
  } finally {
    closing.resolve();
    await app.dispose();
  }
});
