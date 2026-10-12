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
      messages: [],
      busy: false,
      error: null,
    },
    voice: { status: "idle", active: false, detail: null, entries: [] },
    draft: privateDraft,
    connectionError: null,
    voiceAllowed: true,
    notifications: null,
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
        talk: vi.fn(),
        retry: vi.fn(),
        notifications: vi.fn(),
      };
      try {
        render(renderKidsView(state, actions), root);
        const composer = root.querySelector<HTMLTextAreaElement>("#kids-message")!;
        expect(composer.value).toBe(privateDraft);
        expect(composer.disabled).toBe(false);

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
        expect(state.draft).toBe(privateDraft);
        expect(actions.draft).not.toHaveBeenCalled();

        render(renderKidsView(state, actions), root);
        expect(composer.value).toBe(privateDraft);
        expect(composer.disabled).toBe(false);
      } finally {
        render(null, root);
      }
    },
  );
});
