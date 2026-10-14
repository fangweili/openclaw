// @vitest-environment jsdom
import { render } from "lit";
import { describe, expect, it, vi } from "vitest";
import { emptyKidsActivity } from "./activity.ts";
import { renderKidsView, type KidsViewActions, type KidsViewState } from "./view.ts";

const privateDraft = "I want to talk about my school day.";

function readyState(): KidsViewState {
  return {
    tab: "chat",
    activityEnabled: true,
    activity: emptyKidsActivity(),
    conversation: {
      status: "ready",
      childName: "Child",
      agentId: "student",
      sessionKey: "agent:student:kids:child-one",
      sessionId: "session-one",
      messages: [],
      busy: false,
      canRetrySend: false,
      history: { hasOlder: false, hasNewer: false, loading: null, error: null },
      error: null,
    },
    voice: { status: "idle", active: false, detail: null, entries: [] },
    dictation: { active: false, finishing: false, detail: null },
    awayFromLatest: false,
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

function viewActions(): KidsViewActions {
  return {
    draft: vi.fn(),
    send: vi.fn(),
    attach: vi.fn(),
    removeAttachment: vi.fn(),
    talk: vi.fn(),
    dictate: vi.fn(),
    retry: vi.fn(),
    notifications: vi.fn(),
    older: vi.fn(),
    newer: vi.fn(),
    latest: vi.fn(),
    tab: vi.fn(),
    activity: {
      start: vi.fn(),
      answer: vi.fn(),
      hint: vi.fn(),
      next: vi.fn(),
      help: vi.fn(),
      retry: vi.fn(),
      chat: vi.fn(),
    },
  };
}

it("keeps useful header status and a stable switch without idle branding or interrupting calls", () => {
  const root = document.createElement("div");
  const state = readyState();
  const actions = viewActions();
  const paint = () => render(renderKidsView(state, actions), root);
  try {
    paint();
    expect(root.querySelector("header img")).toBeNull();
    const statusRegion = root.querySelector(".kids-status")!;
    expect(statusRegion.textContent?.trim()).toBe("");
    const modes = root.querySelector("header nav")!;
    const [chat, today] = modes.querySelectorAll("button");
    expect(chat!.getAttribute("aria-current")).toBe("page");
    today!.click();
    expect(actions.tab).toHaveBeenCalledExactlyOnceWith("today");
    state.tab = "today";
    paint();
    expect(root.querySelector("header nav")).toBe(modes);
    expect(today!.getAttribute("aria-current")).toBe("page");
    for (const status of ["listening", "stopping"] as const) {
      state.voice = { status, active: status === "listening", detail: null, entries: [] };
      paint();
      expect(root.querySelector("header nav")).toBe(modes);
      expect(chat!.getAttribute("aria-current")).toBe("page");
      expect(today!.disabled).toBe(true);
      expect(root.querySelector("#kids-today-voice-help")?.textContent).toBe(
        "Finish your call to open Today.",
      );
      today!.click();
      expect(actions.tab).toHaveBeenCalledTimes(1);
      expect(actions.talk).not.toHaveBeenCalled();
      expect(root.querySelector(".kids-status")).toBe(statusRegion);
      expect(statusRegion.textContent?.trim()).toBe(
        status === "listening" ? "I’m listening" : "Finishing our call…",
      );
    }
    state.voice = { status: "idle", active: false, detail: null, entries: [] };
    paint();
    expect(today!.disabled).toBe(false);
    expect(today!.getAttribute("aria-current")).toBe("page");
    expect(root.querySelector(".kids-status")).toBe(statusRegion);
    expect(statusRegion.textContent?.trim()).toBe("");
    state.conversation.busy = true;
    paint();
    expect(root.querySelector(".kids-status")).toBe(statusRegion);
    expect(statusRegion.textContent?.trim()).toBe("Rocky is replying…");
    state.activityEnabled = false;
    state.conversation.busy = false;
    state.conversation.status = "disconnected";
    paint();
    expect(root.querySelector("header nav")).toBeNull();
    expect(root.querySelector("header img")).toBeNull();
    expect(statusRegion.textContent?.trim()).toBe("Connecting…");
    state.connectionError = "Synthetic connection failure";
    paint();
    expect(statusRegion.textContent?.trim()).toBe("Let’s reconnect");
  } finally {
    render(null, root);
  }
});

describe("kids draft privacy", () => {
  it.each(["disconnected", "loading", "error"] as const)(
    "hides the retained draft while %s and restores it only for the ready conversation",
    (status) => {
      const root = document.createElement("div");
      const state = readyState();
      const actions = viewActions();
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
    const actions = viewActions();
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
    const actions = viewActions();
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

it("keeps filtered empty history traversable and offers Latest without changing the draft", () => {
  const root = document.createElement("div");
  const state = readyState();
  state.conversation.history = { hasOlder: true, hasNewer: true, loading: null, error: null };
  state.awayFromLatest = true;
  const actions = viewActions();
  try {
    render(renderKidsView(state, actions), root);
    const edges = root.querySelectorAll<HTMLButtonElement>(".kids-history-status button");
    expect([...edges].map((button) => button.textContent?.trim())).toEqual([
      "Earlier messages",
      "Newer messages",
    ]);
    edges.item(0).click();
    edges.item(1).click();
    root.querySelector<HTMLButtonElement>(".kids-latest")!.click();
    expect(actions.older).toHaveBeenCalledOnce();
    expect(actions.newer).toHaveBeenCalledOnce();
    expect(actions.latest).toHaveBeenCalledOnce();
    expect(actions.draft).not.toHaveBeenCalled();
    expect(root.querySelector<HTMLTextAreaElement>("textarea")!.value).toBe(privateDraft);
    state.conversation.history.loading = "older";
    render(renderKidsView(state, actions), root);
    expect(root.querySelector<HTMLButtonElement>(".kids-history-status button")!.disabled).toBe(
      true,
    );
  } finally {
    render(null, root);
  }
});
