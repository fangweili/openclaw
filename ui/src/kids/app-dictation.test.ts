// @vitest-environment jsdom
import type { ActivitySnapshot } from "@openclaw/kids-activity-contract";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import type { GatewayBrowserClientOptions } from "../api/gateway.ts";
import { useKidsDraftStoreFixture } from "./app-draft.test-support.ts";
import type { KidsViewActions, KidsViewState } from "./view.ts";

const fixture = vi.hoisted(() => ({
  options: null as GatewayBrowserClientOptions | null,
  state: null as KidsViewState | null,
  actions: null as KidsViewActions | null,
  activityMethods: [] as string[],
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
          features: { methods: fixture.activityMethods },
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
  history.replaceState(null, "", "/");
  vi.useFakeTimers({
    toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"],
  });
  fixture.recorders = [];
  fixture.activityMethods = [];
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
      case "kids.activity.get":
        return {
          now: 1000,
          date: "2026-10-14",
          correctStreak: 0,
          perfectDayStreak: 0,
          extras: { questionsSolved: 0 },
          canContinue: false,
          daily: null,
          nextActivity: null,
          activity: null,
          pet: {
            state: "normal",
            lastInteractionAt: null,
            excitedUntil: null,
            scene: null,
            image: null,
          },
        } satisfies ActivitySnapshot;
      default:
        throw new Error(`Unexpected request: ${method}`);
    }
  });
});
afterEach(() => vi.useRealTimers());

it("restores only a page fragment and accepts same-origin notification navigation without changing tutor", async () => {
  fixture.activityMethods = ["kids.activity.get"];
  history.replaceState(null, "", "#solve");
  const worker = new EventTarget();
  const previous = Object.getOwnPropertyDescriptor(navigator, "serviceWorker");
  Object.defineProperty(navigator, "serviceWorker", { configurable: true, value: worker });
  const app = new KidsApp(document.createElement("div"));
  const notify = (origin: string, hash: string) =>
    worker.dispatchEvent(
      new MessageEvent("message", {
        origin,
        data: { type: "kids:navigate", hash },
      }),
    );
  try {
    app.start();
    await vi.advanceTimersByTimeAsync(0);
    await drafts.settle();
    expect(fixture.state!.page).toBe("solve");
    fixture.actions!.draft("Keep this thought");
    fixture.actions!.navigate("chat");
    expect(location.hash).toBe("#chat");
    expect(fixture.state!.returnToSolve).toBe(true);
    notify("https://untrusted.example", "#today");
    notify(location.origin, "#agent:other:main");
    expect(fixture.state!.page).toBe("chat");
    fixture.actions!.navigate("solve");
    notify(location.origin, "#chat");
    expect(fixture.state!.page).toBe("chat");
    expect(fixture.state!.draft).toBe("Keep this thought");
    expect(fixture.state!.conversation.sessionKey).toBe("agent:student:kids:child-one");
    expect(
      fixture.request.mock.calls.filter(([method]) => method === "sessions.create"),
    ).toHaveLength(1);
    expect(fixture.request.mock.calls.some(([method]) => method === "kids.activity.touch")).toBe(
      false,
    );
    await app.dispose();
    notify(location.origin, "#today");
    expect(location.hash).toBe("#chat");
  } finally {
    await app.dispose();
    if (previous) {
      Object.defineProperty(navigator, "serviceWorker", previous);
    } else {
      Reflect.deleteProperty(navigator, "serviceWorker");
    }
  }
});

it("rejects Today intents until admitted microphone work has finished", async () => {
  fixture.activityMethods = ["kids.activity.get"];
  const app = new KidsApp(document.createElement("div"));
  try {
    app.start();
    await vi.advanceTimersByTimeAsync(0);
    await drafts.settle();
    expect(fixture.state!.activityEnabled).toBe(true);
    const reads = fixture.request.mock.calls.filter(([method]) => method === "kids.activity.get");
    expect(reads).toHaveLength(1);
    fixture.actions!.navigate("chat");
    fixture.actions!.dictate();
    await vi.advanceTimersByTimeAsync(0);
    fixture.actions!.navigate("today");
    expect(fixture.state!.page).toBe("chat");
    fixture.recorders[0]!.publish({ active: false, finishing: true, detail: null });
    fixture.actions!.navigate("today");
    expect(fixture.state!.page).toBe("chat");
    expect(
      fixture.request.mock.calls.filter(([method]) => method === "kids.activity.get"),
    ).toHaveLength(reads.length);
  } finally {
    await app.dispose();
  }
});

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

it("dictates only into the captured Solve question and retires late speech when another device advances it", async () => {
  fixture.activityMethods = ["kids.activity.get"];
  history.replaceState(null, "", "#solve");
  const current: ActivitySnapshot = {
    now: 1,
    date: "2026-10-14",
    correctStreak: 0,
    perfectDayStreak: 0,
    extras: { questionsSolved: 0 },
    canContinue: false,
    daily: null,
    nextActivity: null,
    pet: { state: "normal", scene: null, image: null, lastInteractionAt: null, excitedUntil: null },
    activity: {
      id: "shapes",
      date: "2026-10-14",
      title: "Compare areas",
      subject: "Math",
      started: true,
      completed: false,
      scope: "daily",
      firstTryCorrect: 0,
      hintedQuestions: 0,
      currentIndex: 0,
      total: 3,
      currentQuestion: { id: "q1", kind: "explanation", prompt: "Are they equal?", hint: null },
    },
  };
  const original = fixture.request.getMockImplementation()!;
  fixture.request.mockImplementation(async (method, params) =>
    method === "kids.activity.get" ? structuredClone(current) : original(method, params),
  );
  const app = new KidsApp(document.createElement("div"));
  try {
    app.start();
    await vi.advanceTimersByTimeAsync(0);
    await drafts.settle();
    fixture.actions!.draft("Unsent chat thought");
    fixture.actions!.activity.draft("No.");
    fixture.actions!.navigate("today");
    fixture.actions!.navigate("chat");
    fixture.actions!.navigate("solve");
    await vi.advanceTimersByTimeAsync(0);
    expect(fixture.state!.activity.answerDraft).toBe("No.");
    fixture.actions!.activity.dictate();
    const first = fixture.recorders.at(-1)!;
    expect(fixture.state!.dictation.active).toBe(true);
    for (const phase of [
      { active: true, finishing: false, detail: null },
      { active: false, finishing: true, detail: null },
    ]) {
      first.publish(phase);
      fixture.actions!.navigate("chat");
      fixture.actions!.navigate("today");
      expect(fixture.state!.page).toBe("solve");
      expect(location.hash).toBe("#solve");
      fixture.actions!.dictate();
      fixture.actions!.activity.check();
      expect(fixture.recorders).toHaveLength(1);
    }
    first.commit("They cover different spaces.");
    first.publish({ active: false, finishing: false, detail: null });
    expect(fixture.state!.activity.answerDraft).toBe("No. They cover different spaces.");
    expect(fixture.state!.draft).toBe("Unsent chat thought");
    expect(
      fixture.request.mock.calls.some(
        ([method]) => method === "kids.activity.answer" || method === "chat.send",
      ),
    ).toBe(false);
    fixture.actions!.activity.dictate();
    const retired = fixture.recorders.at(-1)!;
    current.activity!.currentQuestion!.id = "q2";
    await vi.advanceTimersByTimeAsync(15_000);
    expect(fixture.state!.dictation.active).toBe(false);
    retired.commit("Private words for question one");
    retired.publish({ active: true, finishing: false, detail: "Late error" });
    expect(fixture.state!.activity.answerDraft).toBe("");
    expect(fixture.state!.dictation.detail).toBeNull();
    expect(fixture.state!.draft).toBe("Unsent chat thought");
  } finally {
    await app.dispose();
  }
});
