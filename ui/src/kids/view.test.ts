// @vitest-environment jsdom
import { render } from "lit";
import { describe, expect, it, vi } from "vitest";
import { renderKidsView, type KidsViewActions, type KidsViewState } from "./view.ts";

const privateDraft = "I want to talk about my school day.";

function readyState(): KidsViewState {
  return {
    conversation: {
      status: "ready",
      childName: "Child",
      agentId: "student",
      sessionKey: "agent:student:kids:child-one",
      sessionId: "session-one",
      messages: [],
      busy: false,
      canRetrySend: false,
      error: null,
    },
    voice: { status: "idle", active: false, detail: null, entries: [] },
    dictation: { active: false, finishing: false, detail: null },
    draft: privateDraft,
    draftReady: true,
    draftError: null,
    connectionError: null,
    voiceAllowed: true,
    notifications: null,
    attachments: {
      items: [
        {
          id: "photo-one",
          name: "Private diagram.png",
          kind: "image",
          status: "ready",
          previewUrl: "blob:private-photo",
        },
      ],
      reading: false,
      allowed: true,
      error: null,
    },
  };
}

describe("kids draft privacy", () => {
  it.each(["disconnected", "loading", "error"] as const)(
    "hides the retained draft while %s and restores it only for the ready conversation",
    (status) => {
      const root = document.createElement("div");
      const state = readyState();
      const actions: KidsViewActions = {
        draft: vi.fn(),
        send: vi.fn(),
        attach: vi.fn(),
        removeAttachment: vi.fn(),
        talk: vi.fn(),
        dictate: vi.fn(),
        retry: vi.fn(),
        notifications: vi.fn(),
      };
      try {
        render(renderKidsView(state, actions), root);
        const composer = root.querySelector<HTMLTextAreaElement>("#kids-message")!;
        expect(composer.value).toBe(privateDraft);
        expect(composer.disabled).toBe(false);
        expect(root.querySelector(".kids-attachment img")?.getAttribute("src")).toBe(
          "blob:private-photo",
        );

        render(
          renderKidsView(
            {
              ...state,
              conversation: {
                ...state.conversation,
                status,
                error: status === "error" ? "This account cannot open a tutor." : null,
              },
            },
            actions,
          ),
          root,
        );
        expect(composer.value).toBe("");
        expect(composer.disabled).toBe(true);
        expect(root.textContent).not.toContain(privateDraft);
        expect(root.querySelector(".kids-attachment")).toBeNull();
        expect(root.querySelector("openclaw-toast-host")).toBeNull();
        expect(root.textContent).not.toContain("Private diagram.png");
        expect(state.draft).toBe(privateDraft);
        expect(actions.draft).not.toHaveBeenCalled();

        render(renderKidsView(state, actions), root);
        expect(composer.value).toBe(privateDraft);
        expect(composer.disabled).toBe(false);
        expect(root.querySelector(".kids-attachment img")?.getAttribute("src")).toBe(
          "blob:private-photo",
        );
      } finally {
        render(null, root);
      }
    },
  );
});

describe("kids media composer", () => {
  it("admits attachment-only send and delegates selection/removal without exposing navigation", () => {
    const root = document.createElement("div");
    const state = readyState();
    state.draft = "";
    const actions: KidsViewActions = {
      draft: vi.fn(),
      send: vi.fn(),
      attach: vi.fn(),
      removeAttachment: vi.fn(),
      talk: vi.fn(),
      dictate: vi.fn(),
      retry: vi.fn(),
      notifications: vi.fn(),
    };
    try {
      render(renderKidsView(state, actions), root);
      const send = root.querySelector<HTMLButtonElement>(".kids-send")!;
      expect(send.disabled).toBe(false);
      root
        .querySelector<HTMLFormElement>("form")!
        .dispatchEvent(new Event("submit", { cancelable: true }));
      expect(actions.send).toHaveBeenCalledOnce();
      const input = root.querySelector<HTMLInputElement>("#kids-files")!;
      expect(input.accept).toBe("image/*,video/*");
      expect(input.multiple).toBe(true);
      const file = new File(["synthetic"], "clip.mp4", { type: "video/mp4" });
      Object.defineProperty(input, "files", { value: [file] });
      input.dispatchEvent(new Event("change"));
      expect(actions.attach).toHaveBeenCalledWith([file]);
      root.querySelector<HTMLButtonElement>(".kids-remove-attachment")!.click();
      expect(actions.removeAttachment).toHaveBeenCalledWith("photo-one");
      state.attachments.reading = true;
      render(renderKidsView(state, actions), root);
      expect(send.disabled).toBe(true);
    } finally {
      render(null, root);
    }
  });
});

describe("kids notification control", () => {
  it("offers setup when off and shows a noninteractive status once enabled", () => {
    const root = document.createElement("div");
    const state = readyState();
    const actions: KidsViewActions = {
      draft: vi.fn(),
      send: vi.fn(),
      attach: vi.fn(),
      removeAttachment: vi.fn(),
      talk: vi.fn(),
      dictate: vi.fn(),
      retry: vi.fn(),
      notifications: vi.fn(),
    };
    try {
      state.notifications = { status: "off", detail: null };
      render(renderKidsView(state, actions), root);
      root.querySelector<HTMLButtonElement>(".kids-notifications")!.click();
      expect(actions.notifications).toHaveBeenCalledOnce();
      state.notifications = { status: "enabled", detail: null };
      render(renderKidsView(state, actions), root);
      expect(root.querySelector("button.kids-notifications")).toBeNull();
      const status = root.querySelector<HTMLElement>(".kids-notifications-on")!;
      expect(status.textContent).toContain("Notifications on");
      status.click();
      expect(actions.notifications).toHaveBeenCalledOnce();
    } finally {
      render(null, root);
    }
  });
});
