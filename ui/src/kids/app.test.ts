// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { GatewayBrowserClientOptions } from "../api/gateway.ts";
import * as store from "../lib/chat/composer-draft-store.runtime.ts";
import { useKidsDraftStoreFixture } from "./app-draft.test-support.ts";
import type { KidsConversationState } from "./conversation.ts";
import { KidsDraft } from "./draft.ts";

const boundary = vi.hoisted(() => ({
  update: (_state: KidsConversationState) => {},
  accepted: (_text: string) => {},
  retry: vi.fn<() => Promise<boolean>>(),
  start: vi.fn(),
  options: null as GatewayBrowserClientOptions | null,
}));

vi.mock("../api/gateway.ts", () => ({
  GatewayBrowserClient: class {
    constructor(options: GatewayBrowserClientOptions) {
      boundary.options = options;
    }
    start = boundary.start;
    stop() {}
  },
}));
vi.mock("./conversation.ts", () => ({
  KidsConversation: class {
    state = {
      status: "disconnected",
      messages: [],
      history: { hasOlder: false, hasNewer: false, loading: null, error: null },
    };
    constructor(
      _client: unknown,
      onState: (state: KidsConversationState) => void,
      onAccepted: (text: string) => void,
    ) {
      boundary.update = onState;
      boundary.accepted = onAccepted;
    }
    retrySend = boundary.retry;
    returnToLatest() {}
    disconnect() {
      boundary.update({ ...ready, status: "disconnected" });
    }
    async dispose() {}
  },
}));
vi.mock("./notifications.ts", () => ({
  KidsNotifications: class {
    state = null;
    async initialize() {}
    async dispose() {}
  },
}));
vi.mock("./voice.ts", () => ({ KidsVoice: vi.fn() }));

import { KidsApp } from "./app.ts";

const drafts = useKidsDraftStoreFixture();
const ready: KidsConversationState = {
  childName: "Child",
  agentId: "student",
  sessionKey: "agent:student:kids:child-one",
  sessionId: "session-one",
  status: "ready",
  busy: false,
  canRetrySend: false,
  history: { hasOlder: false, hasNewer: false, loading: null, error: null },
  messages: [],
  error: null,
};

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      disconnect() {}
    },
  );
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.clearAllMocks();
  vi.clearAllTimers();
  vi.useRealTimers();
});

function type(composer: HTMLTextAreaElement, text: string) {
  composer.value = text;
  composer.dispatchEvent(new Event("input", { bubbles: true }));
}

describe("kids send recovery action", () => {
  it.each([false, true])(
    "clears only the original acknowledged draft (edited: %s)",
    async (edited) => {
      const root = document.createElement("div");
      const app = new KidsApp(root);
      try {
        app.start();
        boundary.update(ready);
        await drafts.settle();
        const composer = root.querySelector<HTMLTextAreaElement>("#kids-message")!;
        type(composer, "Original question");
        boundary.update({ ...ready, busy: true, canRetrySend: true, error: "Please try again." });
        expect(root.querySelector(".kids-thinking")).toBeNull();
        expect(composer.disabled).toBe(false);
        expect(root.querySelector<HTMLButtonElement>(".kids-send")!.disabled).toBe(true);
        expect(root.querySelector<HTMLButtonElement>(".kids-talk")!.disabled).toBe(true);
        const result = Promise.withResolvers<boolean>();
        boundary.retry.mockReturnValue(result.promise);
        root.querySelector<HTMLButtonElement>(".kids-notice button")!.click();
        expect(boundary.retry).toHaveBeenCalledTimes(1);
        if (edited) {
          type(composer, "A new thought");
        }
        boundary.accepted("Original question");
        result.resolve(true);
        await result.promise;
        await drafts.settle();
        expect(composer.value).toBe(edited ? "A new thought" : "");
        expect(boundary.start).toHaveBeenCalledTimes(1);
      } finally {
        await app.dispose();
      }
    },
  );
});

describe("kids app durable draft acknowledgements", () => {
  it.each([false, true])(
    "reconciles a reconnect receipt after restore without losing a newer draft (edited: %s)",
    async (edited) => {
      const saved = new KidsDraft(() => {});
      const gatewayUrl = new URL("/", location.href);
      gatewayUrl.protocol = location.protocol === "https:" ? "wss:" : "ws:";
      await saved.bind({
        gatewayUrl: gatewayUrl.href,
        sessionKey: ready.sessionKey!,
        sessionId: ready.sessionId!,
      });
      saved.update(edited ? "A newer unsent question" : "Accepted question");
      await saved.dispose();

      const actualRead = store.readDurableComposerDraft;
      const restore = Promise.withResolvers<void>();
      const started = Promise.withResolvers<void>();
      vi.spyOn(store, "readDurableComposerDraft").mockImplementationOnce(async (scope) => {
        started.resolve();
        await restore.promise;
        return actualRead(scope);
      });
      const root = document.createElement("div");
      const app = new KidsApp(root);
      try {
        app.start();
        boundary.update(ready);
        await started.promise;
        const composer = root.querySelector<HTMLTextAreaElement>("#kids-message")!;
        expect(composer.disabled).toBe(true);
        boundary.accepted("Accepted question");
        restore.resolve();
        await drafts.settle();
        expect(composer.value).toBe(edited ? "A newer unsent question" : "");
        expect(composer.disabled).toBe(false);
        await app.dispose();

        const reopenedRoot = document.createElement("div");
        const reopened = new KidsApp(reopenedRoot);
        try {
          reopened.start();
          boundary.update(ready);
          await drafts.settle();
          expect(reopenedRoot.querySelector<HTMLTextAreaElement>("#kids-message")!.value).toBe(
            edited ? "A newer unsent question" : "",
          );
        } finally {
          await reopened.dispose();
        }
      } finally {
        restore.resolve();
        await app.dispose();
      }
    },
  );

  it("retires an accepted draft across disconnect without clearing the next identity's text", async () => {
    const root = document.createElement("div");
    const app = new KidsApp(root);
    const actualWrite = store.writeDurableComposerDraft;
    const released = Promise.withResolvers<void>();
    const started = Promise.withResolvers<void>();
    try {
      app.start();
      boundary.update(ready);
      await drafts.settle();
      const composer = root.querySelector<HTMLTextAreaElement>("#kids-message")!;
      vi.spyOn(store, "writeDurableComposerDraft").mockImplementationOnce(async (...args) => {
        started.resolve();
        await released.promise;
        return actualWrite(...args);
      });
      type(composer, "Same words");
      await started.promise;
      boundary.accepted("Same words");
      boundary.options!.onClose!({ code: 1006, reason: "Synthetic reconnect", willRetry: true });
      expect(composer.value).toBe("");
      expect(composer.disabled).toBe(true);
      boundary.update({
        ...ready,
        sessionKey: "agent:student:kids:other-child",
        sessionId: "other-session",
      });
      released.resolve();
      await drafts.settle();
      type(composer, "Same words");
      expect(composer.value).toBe("Same words");
      boundary.update(ready);
      await drafts.settle();
      expect(composer.value).toBe("");
    } finally {
      released.resolve();
      await app.dispose();
    }
  });

  it("clears a receipt admitted during restoration even when the app immediately closes", async () => {
    const gatewayUrl = new URL("/", location.href);
    gatewayUrl.protocol = location.protocol === "https:" ? "wss:" : "ws:";
    const saved = new KidsDraft(() => {});
    await saved.bind({
      gatewayUrl: gatewayUrl.href,
      sessionKey: ready.sessionKey!,
      sessionId: ready.sessionId!,
    });
    saved.update("Already accepted");
    await saved.dispose();
    const actualRead = store.readDurableComposerDraft;
    const released = Promise.withResolvers<void>();
    const started = Promise.withResolvers<void>();
    vi.spyOn(store, "readDurableComposerDraft").mockImplementationOnce(async (scope) => {
      started.resolve();
      await released.promise;
      return actualRead(scope);
    });
    const app = new KidsApp(document.createElement("div"));
    try {
      app.start();
      boundary.update(ready);
      await started.promise;
      boundary.accepted("Already accepted");
      boundary.options!.onClose!({ code: 1006, reason: "Synthetic disconnect", willRetry: true });
      const closing = app.dispose();
      released.resolve();
      await closing;
      const reopenedRoot = document.createElement("div");
      const reopened = new KidsApp(reopenedRoot);
      try {
        reopened.start();
        boundary.update(ready);
        await drafts.settle();
        expect(reopenedRoot.querySelector<HTMLTextAreaElement>("#kids-message")!.value).toBe("");
      } finally {
        await reopened.dispose();
      }
    } finally {
      released.resolve();
      await app.dispose();
    }
  });
});
