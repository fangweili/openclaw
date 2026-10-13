// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import type { KidsConversationState } from "./conversation.ts";

const boundary = vi.hoisted(() => ({
  update: (_state: KidsConversationState) => {},
  accepted: (_text: string) => {},
  retry: vi.fn<() => Promise<boolean>>(),
  start: vi.fn(),
}));

vi.mock("../api/gateway.ts", () => ({
  GatewayBrowserClient: class {
    start = boundary.start;
    stop() {}
  },
}));
vi.mock("./conversation.ts", () => ({
  KidsConversation: class {
    state = { status: "disconnected", messages: [] };
    constructor(
      _client: unknown,
      onState: (state: KidsConversationState) => void,
      onAccepted: (text: string) => void,
    ) {
      boundary.update = onState;
      boundary.accepted = onAccepted;
    }
    retrySend = boundary.retry;
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

afterEach(() => vi.clearAllMocks());

describe("kids send recovery action", () => {
  it.each([false, true])(
    "clears only the original acknowledged draft (edited: %s)",
    async (edited) => {
      const root = document.createElement("div");
      const app = new KidsApp(root);
      const ready: KidsConversationState = {
        childName: "Child",
        agentId: "student",
        sessionKey: "agent:student:kids:child-one",
        status: "ready",
        busy: false,
        canRetrySend: false,
        messages: [],
        error: null,
      };
      try {
        app.start();
        boundary.update(ready);
        const composer = root.querySelector<HTMLTextAreaElement>("#kids-message")!;
        composer.value = "Original question";
        composer.dispatchEvent(new Event("input", { bubbles: true }));
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
          composer.value = "A new thought";
          composer.dispatchEvent(new Event("input", { bubbles: true }));
        }
        boundary.accepted("Original question");
        result.resolve(true);
        await result.promise;
        expect(composer.value).toBe(edited ? "A new thought" : "");
        expect(boundary.start).toHaveBeenCalledTimes(1);
      } finally {
        await app.dispose();
      }
    },
  );
});
