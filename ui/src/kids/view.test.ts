// @vitest-environment jsdom
import { render } from "lit";
import { describe, expect, it, vi } from "vitest";
import { emptyKidsActivity } from "./activity.ts";
import { renderKidsView, type KidsViewActions, type KidsViewState } from "./view.ts";

const privateDraft = "I want to talk about my school day.";

function readyState(): KidsViewState {
  return {
    page: "chat",
    returnToSolve: false,
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
    dictationQuestion: null,
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
    navigate: vi.fn(),
    activity: {
      start: vi.fn(),
      answer: vi.fn(),
      draft: vi.fn(),
      check: vi.fn(),
      dictate: vi.fn(),
      edit: vi.fn(),
      hint: vi.fn(),
      next: vi.fn(),
      help: vi.fn(),
      retry: vi.fn(),
      chat: vi.fn(),
    },
  };
}

it("opens Today choices and retains the Chat, home, and Solve panels across navigation", () => {
  const root = document.createElement("div");
  const state = readyState();
  state.page = "today";
  state.activity.imageUrl = "blob:private-current-pet";
  const actions = viewActions();
  const paint = () => render(renderKidsView(state, actions), root);
  try {
    paint();
    const home = root.querySelector<HTMLElement>(".kids-home")!;
    const solve = root.querySelector<HTMLElement>(".kids-solve")!;
    const composer = root.querySelector<HTMLTextAreaElement>("#kids-message")!;
    expect(home.hidden).toBe(false);
    expect(solve.hidden).toBe(true);
    expect(root.querySelector("h1#kids-home-title")?.textContent?.trim()).toBe(
      "What shall we do, Child?",
    );
    state.conversation.childName = "";
    paint();
    expect(root.querySelector("h1#kids-home-title")?.textContent?.trim()).toBe("What shall we do?");
    const choices = home.querySelectorAll<HTMLButtonElement>(".kids-home-grid button");
    expect([...choices].map((choice) => choice.disabled)).toEqual([false, true, true, true]);
    for (const choice of [...choices].slice(1)) {
      choice.click();
    }
    expect(actions.navigate).not.toHaveBeenCalled();
    choices[0]!.click();
    expect(actions.navigate).toHaveBeenCalledExactlyOnceWith("solve");
    state.page = "solve";
    paint();
    expect(root.querySelector(".kids-home")).toBe(home);
    expect(root.querySelector(".kids-solve")).toBe(solve);
    expect(home.hidden).toBe(true);
    expect(solve.hidden).toBe(false);
    state.page = "chat";
    state.returnToSolve = true;
    paint();
    expect(root.querySelector("#kids-message")).toBe(composer);
    expect(composer.value).toBe(privateDraft);
    expect(root.querySelector<HTMLElement>(".kids-thread-area")!.hidden).toBe(false);
    root.querySelector<HTMLButtonElement>(".kids-return-solve")!.click();
    expect(actions.navigate).toHaveBeenLastCalledWith("solve");
  } finally {
    render(null, root);
  }
});

it("keeps a mounted useful status and all navigation disabled during a live or finishing call", () => {
  const root = document.createElement("div");
  const state = readyState();
  const actions = viewActions();
  const paint = () => render(renderKidsView(state, actions), root);
  try {
    paint();
    const statusRegion = root.querySelector(".kids-status")!;
    expect(statusRegion.textContent?.trim()).toBe("");
    expect(statusRegion.closest(".kids-thread-content")).not.toBeNull();
    state.conversation.busy = true;
    paint();
    expect(root.querySelector(".kids-status")).toBe(statusRegion);
    expect(statusRegion.classList.contains("kids-sr-only")).toBe(true);
    expect(root.querySelector(".kids-thinking")?.textContent).toBe("Rocky is replying…");
    state.conversation.busy = false;
    state.page = "solve";
    state.returnToSolve = true;
    for (const status of ["listening", "stopping"] as const) {
      state.voice = { status, active: status === "listening", detail: null, entries: [] };
      paint();
      expect(root.querySelector<HTMLElement>(".kids-thread-area")!.hidden).toBe(false);
      for (const button of root.querySelectorAll<HTMLButtonElement>(
        ".kids-page-navigation button",
      )) {
        expect(button.disabled).toBe(true);
        button.click();
      }
      expect(actions.navigate).not.toHaveBeenCalled();
      expect(root.querySelector(".kids-status")).toBe(statusRegion);
      expect(statusRegion.classList.contains("kids-sr-only")).toBe(true);
      expect(statusRegion.textContent?.trim()).toBe(
        status === "listening" ? "I’m listening" : "Finishing our call…",
      );
    }
    state.voice = { status: "idle", active: false, detail: null, entries: [] };
    state.conversation.status = "disconnected";
    paint();
    expect(root.querySelector(".kids-home")).toBeNull();
    expect(root.querySelector(".kids-solve")).toBeNull();
    expect(statusRegion.textContent?.trim()).toBe("Connecting…");
    expect(statusRegion.classList.contains("kids-sr-only")).toBe(false);
    state.connectionError = "Synthetic connection failure";
    paint();
    expect(statusRegion.textContent?.trim()).toBe("Let’s reconnect");
    expect(statusRegion.classList.contains("kids-sr-only")).toBe(true);
  } finally {
    render(null, root);
  }
});

it.each([false, true])(
  "keeps dictation controls visible and Today unavailable (finishing: %s)",
  (finishing) => {
    const root = document.createElement("div");
    const state = readyState();
    const actions = viewActions();
    state.page = "solve";
    state.returnToSolve = true;
    state.dictation = { active: !finishing, finishing, detail: null };
    try {
      render(renderKidsView(state, actions), root);
      const modes = root.querySelector(".kids-page-navigation")!;
      const [today, solve] = modes.querySelectorAll("button");
      expect(solve!.disabled).toBe(true);
      expect(today!.disabled).toBe(true);
      expect(root.querySelector<HTMLElement>(".kids-footer")!.hidden).toBe(false);
      expect(root.querySelector<HTMLButtonElement>(".kids-dictate")!.disabled).toBe(finishing);
      expect(root.querySelector("#kids-navigation-help")?.textContent).toBe(
        finishing
          ? "Wait for your words to appear before leaving this page."
          : "Finish dictation before leaving this page.",
      );
      today!.click();
      expect(actions.navigate).not.toHaveBeenCalled();
    } finally {
      render(null, root);
    }
  },
);

describe("kids draft privacy", () => {
  it.each(["disconnected", "loading", "error"] as const)(
    "hides the retained draft while %s and restores it only for the ready conversation",
    (status) => {
      const root = document.createElement("div");
      const state = readyState();
      state.activity.imageUrl = "blob:private-current-pet";
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
        expect(root.querySelector(".kids-home, .kids-solve")).toBeNull();
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
  it("offers setup only in the Chat footer and removes it completely once enabled", () => {
    const root = document.createElement("div");
    const state = readyState();
    const actions = viewActions();
    try {
      state.notifications = { status: "off", detail: null };
      render(renderKidsView(state, actions), root);
      const footer = root.querySelector<HTMLElement>(".kids-footer")!;
      footer.querySelector<HTMLButtonElement>(".kids-notifications")!.click();
      expect(actions.notifications).toHaveBeenCalledOnce();
      state.page = "today";
      render(renderKidsView(state, actions), root);
      expect(footer.hidden).toBe(true);
      state.page = "chat";
      state.notifications = { status: "working", detail: "Setting up notifications…" };
      render(renderKidsView(state, actions), root);
      expect(footer.hidden).toBe(false);
      const working = footer.querySelector<HTMLButtonElement>(".kids-notifications")!;
      expect(working.disabled).toBe(true);
      working.click();
      expect(actions.notifications).toHaveBeenCalledOnce();
      state.notifications = { status: "enabled", detail: null };
      render(renderKidsView(state, actions), root);
      expect(root.querySelector("button.kids-notifications")).toBeNull();
      expect(root.textContent).not.toContain("Notifications on");
      expect(root.querySelector(".kids-notifications-on")).toBeNull();
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

it("keeps the submitted free answer and live result mounted while checking and receiving clarification", () => {
  const root = document.createElement("div");
  const state = readyState();
  state.page = "solve";
  const question = {
    kind: "explanation" as const,
    id: "q1",
    prompt: "Do equal borders always enclose equal areas?",
    hint: null,
  };
  state.activity.snapshot = {
    now: 1,
    date: "2026-10-14",
    correctStreak: 0,
    daily: null,
    nextActivity: null,
    pet: { state: "normal", scene: null, image: null, lastInteractionAt: null, excitedUntil: null },
    activity: {
      id: "shapes",
      date: "2026-10-14",
      title: "Compare the spaces",
      subject: "Math",
      started: true,
      completed: false,
      currentIndex: 0,
      total: 3,
      currentQuestion: question,
    },
  };
  state.activity.answerDraft = "No. The areas are different.";
  const actions = viewActions();
  const paint = () => render(renderKidsView(state, actions), root);
  try {
    paint();
    const field = root.querySelector<HTMLTextAreaElement>("#kids-answer")!;
    const live = root.querySelector(".kids-answer-result")!;
    expect(field.value).toBe(state.activity.answerDraft);
    field.dispatchEvent(new FocusEvent("focus"));
    expect(actions.activity.edit).toHaveBeenCalledOnce();
    state.activity.answerEditing = true;
    paint();
    field.dispatchEvent(new FocusEvent("blur"));
    expect(root.querySelector(".kids-solve--editing")).not.toBeNull();
    expect(live.textContent?.trim()).toBe("");
    expect(live.classList.contains("kids-answer-result--populated")).toBe(false);
    root
      .querySelector<HTMLFormElement>(".kids-answer")!
      .dispatchEvent(new Event("submit", { cancelable: true }));
    expect(actions.activity.check).toHaveBeenCalledOnce();
    expect(actions.send).not.toHaveBeenCalled();
    state.activity.busy = true;
    state.activity.checking = true;
    state.activity.submission = {
      question,
      answer: { kind: "explanation", text: field.value },
      activity: { id: "shapes", title: "Compare the spaces", subject: "Math" },
    };
    paint();
    expect(root.querySelector("#kids-answer")).toBe(field);
    expect(root.querySelector(".kids-answer-result")).toBe(live);
    expect(live.classList.contains("kids-answer-result--populated")).toBe(true);
    expect(field.readOnly).toBe(true);
    expect(live.textContent).toContain("Rocky is checking");
    state.activity.busy = false;
    state.activity.checking = false;
    state.activity.feedback = {
      questionId: "q1",
      outcome: "clarify",
      independent: true,
      explanation: "How did you compare them?",
    };
    paint();
    expect(field.readOnly).toBe(false);
    expect(field.value).toBe("No. The areas are different.");
    expect(live.textContent).toContain("Tell me a little more.");
    field.value = "No. Their areas are 9 and 24.";
    field.dispatchEvent(new InputEvent("input"));
    expect(actions.activity.draft).toHaveBeenCalledWith(field.value);
    state.activity.answerDraft = field.value;
    state.activity.submission.answer = { kind: "explanation", text: field.value };
    state.activity.feedback.outcome = "correct";
    state.activity.snapshot.activity!.currentQuestion = {
      id: "q2",
      kind: "numeric",
      prompt: "Half of one?",
      unit: "cm",
      hint: null,
    };
    state.activity.answerDraft = "";
    paint();
    expect(field.value).toBe("No. Their areas are 9 and 24.");
    expect(field.readOnly).toBe(true);
    expect(root.querySelector(".kids-solve")?.textContent).not.toContain("Half of one?");
  } finally {
    render(null, root);
  }
});

it("keeps Solve recording controls visible through microphone permission and transcription", () => {
  const root = document.createElement("div");
  const state = readyState();
  state.page = "solve";
  state.dictationQuestion = { activityId: "fractions", questionId: "q1" };
  state.activity.snapshot = {
    now: 1,
    date: "2026-10-14",
    correctStreak: 0,
    daily: null,
    nextActivity: null,
    pet: { state: "normal", scene: null, image: null, lastInteractionAt: null, excitedUntil: null },
    activity: {
      id: "fractions",
      date: "2026-10-14",
      title: "A fraction",
      subject: "Math",
      started: true,
      completed: false,
      currentIndex: 0,
      total: 3,
      currentQuestion: {
        id: "q1",
        kind: "numeric",
        prompt: "Half of one?",
        unit: null,
        hint: null,
      },
    },
  };
  const actions = viewActions();
  try {
    for (const finishing of [false, true]) {
      state.dictation = { active: !finishing, finishing, detail: null };
      render(renderKidsView(state, actions), root);
      expect(root.querySelector<HTMLElement>(".kids-solve")!.hidden).toBe(false);
      expect(root.querySelector<HTMLElement>(".kids-footer")!.hidden).toBe(true);
      expect(root.querySelector<HTMLInputElement>("#kids-answer")!.inputMode).toBe("text");
      expect(root.querySelector<HTMLInputElement>("#kids-answer")!.readOnly).toBe(true);
      expect(root.querySelector<HTMLButtonElement>(".kids-page-navigation button")!.disabled).toBe(
        true,
      );
      const stop = root.querySelector<HTMLButtonElement>(".kids-answer-dictate")!;
      expect(stop.disabled).toBe(finishing);
      expect(stop.getAttribute("aria-label")).toBe("Finish dictation");
    }
  } finally {
    render(null, root);
  }
});
