/** Compiled kids microphone flows: live captions and editable dictation. All speech is synthetic. */
import path from "node:path";
import type { ActivitySnapshot } from "@openclaw/kids-activity-contract";
import { afterAll, beforeAll, expect, it } from "vitest";
import { installTalkBrowserFixtures } from "../e2e/browser-talk-start-stop.fixtures.ts";
import { defaultControlUiFeatureMethods } from "../test-helpers/control-ui-e2e-defaults.ts";
import { installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import {
  notificationPermissionFixture,
  profile,
  roster,
  sessionKey,
  startKidsE2e,
} from "./app.e2e.test-support.ts";

let harness: Awaited<ReturnType<typeof startKidsE2e>>;
beforeAll(async () => {
  harness = await startKidsE2e("kids-voice");
});
afterAll(async () => {
  await harness?.close();
});

it("shows speech once, follows the call independently of chat history, and restores saved chat after close", async () => {
  const { browser, baseUrl, proof, examples } = harness;
  const context = await browser.newContext({
    viewport: { width: 1024, height: 768 },
    permissions: ["microphone"],
    reducedMotion: "reduce",
  });
  try {
    await context.addInitScript(notificationPermissionFixture);
    const page = await context.newPage();
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    const relaySessionId = "relay-kids-voice";
    const messages = Array.from({ length: 24 }, (_, index) => ({
      role: "assistant",
      content: [
        {
          type: "text",
          text: `Earlier pattern ${index + 1}. Alex counted groups of three and explained the next number.`,
        },
      ],
      __openclaw: { id: `history-${97 + index}`, seq: 97 + index },
    }));
    const history = () => ({
      sessionId: "student-session",
      sessionInfo: {
        sessionId: "student-session",
        activeLeafEntryId: messages.at(-1)!["__openclaw"].id,
      },
      messages,
      totalMessages: 96 + messages.length,
      offset: 0,
      hasMore: true,
      nextOffset: messages.length,
    });
    const gateway = await installMockGateway(page, {
      awaitInitialRoster: false,
      sessionKey,
      operatorScopes: ["operator.sessions.write", "operator.talk"],
      historyMessages: messages,
      methodResponses: {
        "users.self": { profile },
        "agents.list": roster,
        "sessions.create": { key: sessionKey },
        "chat.history": history(),
        "talk.catalog": {
          realtime: { ready: true, providers: [{ id: "openai", supportsBargeIn: false }] },
        },
        "talk.client.create": {
          provider: "openai",
          transport: "gateway-relay",
          relaySessionId,
          audio: {
            inputEncoding: "pcm16",
            inputSampleRateHz: 16_000,
            outputEncoding: "pcm16",
            outputSampleRateHz: 24_000,
          },
        },
        "talk.session.appendAudio": {},
        "talk.session.close": {},
      },
    });
    await installTalkBrowserFixtures(page);
    await page.goto(`${baseUrl}#chat`);
    await page.getByText(messages.at(-1)!.content[0]!.text, { exact: true }).waitFor();
    const thread = page.locator(".kids-thread");
    const latest = page.getByRole("button", { name: "Jump to latest message", exact: true });
    // Start while reading older chat. Its scroll position must not own the call.
    await thread.evaluate((element) => {
      element.dispatchEvent(new WheelEvent("wheel", { deltaY: -400, bubbles: true }));
      element.scrollTop = Math.floor(element.scrollHeight / 3);
      element.dispatchEvent(new Event("scroll"));
    });
    await latest.waitFor();
    await page.getByRole("button", { name: "Talk to Rocky", exact: true }).click();
    await gateway.waitForRequest("talk.client.create");
    await page.waitForFunction(
      () =>
        (window as Window & { openclawTalkE2eState?: { inputProcessor: unknown } })
          .openclawTalkE2eState?.inputProcessor != null,
    );
    await gateway.emitGatewayEvent("talk.event", { relaySessionId, type: "ready" });

    // The Gateway publishes the same finalized speech to captions and durable chat.
    const speak = async (role: "user" | "assistant", text: string) => {
      const seq = 97 + messages.length;
      const id = `voice:${relaySessionId}:${seq}`;
      await gateway.emitGatewayEvent("talk.event", {
        relaySessionId,
        type: "transcript",
        role,
        text,
        final: true,
        transcriptId: id,
      });
      const message = { role, content: [{ type: "text", text }], __openclaw: { id, seq } };
      messages.push(message);
      await gateway.setMethodResponse("chat.history", history());
      await gateway.emitGatewayEvent("session.message", {
        sessionKey,
        sessionId: "student-session",
        messageId: id,
        messageSeq: seq,
        message,
      });
      await expect.poll(() => page.getByText(text, { exact: true }).count()).toBe(1);
    };
    await speak("user", "Can we explore a number pattern?");
    await speak("assistant", "Yes, Alex. Start with two, then add three each time.");
    expect(await page.locator(".kids-messages").count()).toBe(0);
    expect(await page.getByRole("button", { name: "Earlier messages", exact: true }).count()).toBe(
      0,
    );
    await page.screenshot({ path: path.join(proof, "voice-single-transcript.png") });
    examples.push({
      id: "voice-single-transcript",
      label: "One spoken conversation during the call",
    });

    for (let turn = 1; turn <= 12; turn++) {
      await speak(
        turn % 2 ? "user" : "assistant",
        `Pattern turn ${turn}. We can count groups of three and explain the next number together.`,
      );
    }
    const bottomGap = () =>
      thread.evaluate((element) => element.scrollHeight - element.clientHeight - element.scrollTop);
    await expect.poll(bottomGap).toBeLessThan(2);
    await page.screenshot({ path: path.join(proof, "voice-following.png") });
    examples.push({ id: "voice-following", label: "The call follows new spoken turns" });

    const pageReadCount = async () =>
      (await gateway.getRequests("chat.history")).filter(
        (request) => ((request.params as { offset?: number } | undefined)?.offset ?? 0) > 0,
      ).length;
    const historyReads = await pageReadCount();
    await thread.evaluate((element) => {
      element.dispatchEvent(new WheelEvent("wheel", { deltaY: -400, bubbles: true }));
      element.scrollTop = 0;
      element.dispatchEvent(new Event("scroll"));
    });
    await latest.waitFor();
    const readingPosition = await thread.evaluate((element) => element.scrollTop);
    await speak(
      "assistant",
      "The next number is thirty-eight. Take your time to check the earlier pattern.",
    );
    expect(await thread.evaluate((element) => element.scrollTop)).toBe(readingPosition);
    expect(await latest.isVisible()).toBe(true);
    expect(await pageReadCount()).toBe(historyReads);
    await latest.click();
    await expect.poll(bottomGap).toBeLessThan(2);
    expect(await latest.count()).toBe(0);
    expect(await pageReadCount()).toBe(historyReads);
    await speak("user", "I can see how the pattern grows now.");
    await expect.poll(bottomGap).toBeLessThan(2);

    await gateway.deferNext("talk.session.close");
    const beforeRefresh = await gateway.deferNext("chat.history");
    await page.getByRole("button", { name: "End call", exact: true }).click();
    await gateway.waitForRequest("talk.session.close");
    expect(await page.locator(".kids-captions").isVisible()).toBe(true);
    expect(await page.locator(".kids-messages").count()).toBe(0);
    await gateway.resolveDeferred("talk.session.close");
    await gateway.waitForRequest("chat.history", { after: beforeRefresh });
    expect(await page.locator(".kids-captions").isVisible()).toBe(true);
    await gateway.resolveDeferred("chat.history", history());
    await page.locator(".kids-call").waitFor({ state: "detached" });
    await expect
      .poll(() => page.locator(".kids-messages .kids-message").count())
      .toBe(messages.length);
    expect(await page.getByText("Can we explore a number pattern?", { exact: true }).count()).toBe(
      1,
    );
    expect(await gateway.getRequests("talk.client.transcript")).toHaveLength(0);
    expect(errors).toEqual([]);
  } finally {
    await context.close();
  }
});

it("records dictation into an editable draft and sends only on request", async () => {
  const { browser, baseUrl, proof, examples } = harness;
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
  });
  try {
    await context.addInitScript(notificationPermissionFixture);
    // Observe the actual browser recorder, so finish cannot race microphone startup.
    await context.addInitScript(() => {
      const acquire = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
      navigator.mediaDevices.getUserMedia = async (constraints) => {
        document.documentElement.dataset.microphoneRequested = "true";
        await new Promise<void>((resolve) => {
          window.addEventListener("kids-fixture-grant-microphone", () => resolve(), { once: true });
        });
        return acquire(constraints);
      };
      const NativeRecorder = MediaRecorder;
      window.MediaRecorder = class extends NativeRecorder {
        override start(timeslice?: number) {
          this.addEventListener(
            "start",
            () => {
              document.documentElement.dataset.recorderStarted = "true";
            },
            { once: true },
          );
          super.start(timeslice);
        }
      };
    });
    const page = await context.newPage();
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    const activity: ActivitySnapshot = {
      now: 1000,
      date: "2026-10-13",
      correctStreak: 0,
      perfectDayStreak: 0,
      extras: { questionsSolved: 0 },
      canContinue: false,
      daily: null,
      nextActivity: null,
      activity: null,
      pet: {
        state: "normal",
        scene: null,
        image: null,
        lastInteractionAt: 1000,
        excitedUntil: null,
      },
    };
    const gateway = await installMockGateway(page, {
      awaitInitialRoster: false,
      featureMethods: [...defaultControlUiFeatureMethods, "kids.activity.get"],
      deferredMethods: ["kids.transcribe"],
      sessionKey,
      operatorScopes: ["operator.sessions.write", "operator.talk"],
      methodResponses: {
        "users.self": { profile },
        "agents.list": roster,
        "sessions.create": { key: sessionKey },
        "chat.history": {
          sessionId: "student-session",
          sessionInfo: { sessionId: "student-session", activeLeafEntryId: "leaf-one" },
          messages: [],
        },
        "kids.transcribe": { text: "Can we practice fractions?" },
        "kids.activity.get": activity,
        "kids.activity.touch": { snapshot: activity },
      },
    });
    await page.goto(`${baseUrl}#chat`);
    await page.getByRole("heading", { name: "What’s on your mind?" }).waitFor();
    const composer = page.getByLabel("Message Rocky", { exact: true });
    await composer.focus();
    // Safari button activation can leave the textarea focused. Preserve that
    // starting condition so dictation itself must retire editable focus.
    await page.getByRole("button", { name: "Dictate a message" }).evaluate((button) => {
      (button as HTMLButtonElement).click();
    });
    await page.waitForFunction(
      () => document.documentElement.dataset.microphoneRequested === "true",
    );
    const today = page.getByRole("button", { name: "Today", exact: true });
    const finish = page.getByRole("button", { name: "Finish dictation", exact: true });
    expect(await composer.isDisabled()).toBe(true);
    expect(await composer.evaluate((field) => document.activeElement === field)).toBe(false);
    expect(await today.isDisabled()).toBe(true);
    expect(await today.getAttribute("title")).toBe("Finish dictation before leaving this page.");
    expect(await page.locator(".kids-thread-area").isVisible()).toBe(true);
    expect(await finish.isVisible()).toBe(true);
    await page.evaluate(() => window.dispatchEvent(new Event("kids-fixture-grant-microphone")));
    await page.waitForFunction(() => document.documentElement.dataset.recorderStarted === "true");
    expect(await today.isDisabled()).toBe(true);
    expect(await finish.isVisible()).toBe(true);
    expect(await page.getByRole("button", { name: "Send message" }).isDisabled()).toBe(true);
    expect(
      await page.getByRole("button", { name: "Talk to Rocky", exact: true }).isDisabled(),
    ).toBe(true);
    await page.screenshot({ path: path.join(proof, "dictation-recording.png"), fullPage: true });
    examples.push({ id: "dictation-recording", label: "Recording a message" });
    await page.getByRole("button", { name: "Finish dictation" }).click();
    const request = await gateway.waitForRequest("kids.transcribe");
    expect(request.params).toEqual({
      audioBase64: expect.any(String),
      mimeType: expect.stringMatching(/^audio\/(webm|mp4|ogg)/),
    });
    expect((request.params as { audioBase64: string }).audioBase64.length).toBeGreaterThan(0);
    expect(await today.isDisabled()).toBe(true);
    expect(await today.getAttribute("title")).toBe(
      "Wait for your words to appear before leaving this page.",
    );
    expect(await page.locator(".kids-thread-area").isVisible()).toBe(true);
    expect(await page.locator(".kids-footer").isVisible()).toBe(true);
    const progress = page.getByText("Writing what you said…", { exact: true });
    await progress.waitFor();
    expect(await composer.isDisabled()).toBe(true);
    expect(
      await progress.evaluate((element) => {
        const box = element.getBoundingClientRect();
        return (
          box.top >= 0 &&
          box.bottom <= innerHeight &&
          getComputedStyle(element, "::before").animationName === "kids-dictation-progress"
        );
      }),
    ).toBe(true);
    await page.screenshot({ path: path.join(proof, "dictation-transcribing.png"), fullPage: true });
    examples.push({ id: "dictation-transcribing", label: "Visible transcription wait" });
    await page.setViewportSize({ width: 1024, height: 768 });
    await page.screenshot({
      path: path.join(proof, "dictation-transcribing-landscape.png"),
      fullPage: true,
    });
    examples.push({
      id: "dictation-transcribing-landscape",
      label: "Visible transcription wait on a landscape tablet",
    });
    await page.setViewportSize({ width: 390, height: 844 });
    await gateway.resolveDeferred("kids.transcribe", { text: "Can we practice fractions?" });
    await page.waitForFunction(
      () =>
        document.querySelector<HTMLTextAreaElement>("textarea")?.value ===
        "Can we practice fractions?",
    );
    expect(await today.isEnabled()).toBe(true);
    expect(await composer.isEnabled()).toBe(true);
    expect(await gateway.getRequests("chat.send")).toHaveLength(0);
    await composer.click();
    expect(await composer.evaluate((field) => document.activeElement === field)).toBe(true);
    await composer.press("End");
    await composer.press("Backspace");
    await composer.pressSequentially(" together?");
    await page.screenshot({ path: path.join(proof, "dictation-draft.png"), fullPage: true });
    examples.push({ id: "dictation-draft", label: "Review and edit before sending" });
    await page.getByRole("button", { name: "Send message" }).click();
    const send = await gateway.waitForRequest("chat.send");
    expect(send.params).toMatchObject({
      sessionKey,
      message: "Can we practice fractions together?",
      deliver: false,
    });
    expect(errors).toEqual([]);
  } finally {
    await context.close();
  }
});
