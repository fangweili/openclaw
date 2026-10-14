/** Real compiled Solve, synthetic grading/transcription; no provider or child data. */
import { readFile } from "node:fs/promises";
import path from "node:path";
import type { ActivitySnapshot } from "@openclaw/kids-activity-contract";
import { afterAll, beforeAll, expect, it } from "vitest";
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
  harness = await startKidsE2e("kids-free-answers");
});
afterAll(async () => {
  await harness?.close();
});

it("checks typed and dictated answers explicitly, keeps feedback editable, and retries the original uncertain answer", async () => {
  const { browser, baseUrl, proof, examples } = harness;
  const context = await browser.newContext({ viewport: { width: 1024, height: 768 } });
  try {
    await context.addInitScript(notificationPermissionFixture);
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
    const image = await readFile(path.resolve("extensions/kids-ui/pets/rocky-reference.webp"));
    const numeric: ActivitySnapshot = {
      now: 1,
      date: "2026-10-14",
      correctStreak: 0,
      daily: { date: "2026-10-14", total: 3, completed: 0 },
      nextActivity: null,
      pet: {
        state: "normal",
        scene: null,
        image: { imageId: "reference", caption: "A little pattern, a big discovery." },
        lastInteractionAt: null,
        excitedUntil: null,
      },
      activity: {
        id: "parts-and-spaces",
        date: "2026-10-14",
        title: "Parts and spaces",
        subject: "Math",
        started: true,
        completed: false,
        currentIndex: 0,
        total: 2,
        currentQuestion: {
          id: "q1",
          kind: "numeric",
          prompt: "Three of four equal pieces are shaded. What fraction is shaded?",
          unit: null,
          hint: null,
        },
      },
    };
    const explanation = structuredClone(numeric);
    explanation.activity!.currentIndex = 1;
    explanation.activity!.currentQuestion = {
      id: "q2",
      kind: "explanation",
      prompt:
        "A rectangle is 9 cm by 1 cm. Another is 6 cm by 4 cm. Do they cover the same area? Explain your thinking.",
      hint: null,
    };
    const gateway = await installMockGateway(page, {
      awaitInitialRoster: false,
      featureMethods: [...defaultControlUiFeatureMethods, "kids.activity.get"],
      deferredMethods: ["kids.transcribe"],
      sessionKey,
      operatorScopes: ["operator.sessions.write", "operator.talk"],
      methodResponses: {
        "users.self": { profile: { ...profile, displayName: "Alexandra" } },
        "agents.list": roster,
        "sessions.create": { key: sessionKey },
        "chat.history": {
          sessionId: "student-session",
          messages: [],
          sessionInfo: { sessionId: "student-session", activeLeafEntryId: "leaf-one" },
        },
        "kids.activity.get": numeric,
        "kids.activity.image": { mimeType: "image/webp", base64: image.toString("base64") },
      },
    });
    const capture = async (id: string, label: string) => {
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
        true,
      );
      await page.screenshot({ path: path.join(proof, `${id}.png`), animations: "disabled" });
      examples.push({ id, label });
    };
    await page.goto(`${baseUrl}#solve`);
    const number = page.getByLabel("Your answer", { exact: true });
    await number.waitFor();
    await page
      .locator('.kids-solve img[src^="blob:"]')
      .evaluate((element: HTMLImageElement) => element.decode());
    await number.fill("3/4");
    await page.getByRole("button", { name: "Today", exact: true }).click();
    await page.getByRole("button", { name: "Chat with Rocky", exact: true }).click();
    await page.getByLabel("Message Rocky", { exact: true }).fill("Keep my chat draft.");
    await page.getByRole("button", { name: "Today", exact: true }).click();
    await page.getByRole("button", { name: "Solve", exact: true }).click();
    expect(await number.inputValue()).toBe("3/4");
    await page.locator('.kids-activity-card[aria-busy="false"]').waitFor();
    await capture("numeric-landscape", "iPad landscape — typed fraction before checking");
    await gateway.deferNext("kids.activity.answer");
    await page.getByRole("button", { name: "Check answer", exact: true }).click();
    const first = await gateway.waitForRequest("kids.activity.answer");
    expect(first.params).toMatchObject({
      sessionKey,
      activityId: "parts-and-spaces",
      questionId: "q1",
      answer: { kind: "numeric", text: "3/4" },
    });
    await page.getByText("Rocky is checking…", { exact: true }).waitFor();
    expect(await number.inputValue()).toBe("3/4");
    await capture(
      "numeric-checking-landscape",
      "iPad landscape — submitted answer stays visible while checking",
    );
    await gateway.setMethodResponse("kids.activity.get", explanation);
    await gateway.resolveDeferred("kids.activity.answer", {
      snapshot: explanation,
      feedback: {
        questionId: "q1",
        outcome: "correct",
        independent: true,
        explanation: "Three of the four equal pieces makes three quarters.",
      },
    });
    await page.getByText("You’ve got it.", { exact: true }).waitFor();
    expect(await number.inputValue()).toBe("3/4");
    expect(
      await page.getByText(explanation.activity!.currentQuestion!.prompt, { exact: true }).count(),
    ).toBe(0);
    await capture(
      "numeric-correct-landscape",
      "iPad landscape — original answer and feedback before Continue",
    );
    await page.getByRole("button", { name: "Continue", exact: true }).click();
    const words = page.getByLabel("Your thinking", { exact: true });
    await words.waitFor();
    await words.focus();
    // The first Say it tap must survive blur without moving before pointer-up.
    await page.getByRole("button", { name: "Say it", exact: true }).click();
    await page.waitForFunction(
      () => document.documentElement.dataset.microphoneRequested === "true",
    );
    expect(await page.getByRole("button", { name: "Today", exact: true }).isDisabled()).toBe(true);
    expect(await page.locator(".kids-solve").isVisible()).toBe(true);
    await page.evaluate(() => window.dispatchEvent(new Event("kids-fixture-grant-microphone")));
    await page.waitForFunction(() => document.documentElement.dataset.recorderStarted === "true");
    await page.getByRole("button", { name: "Finish dictation", exact: true }).click();
    await gateway.waitForRequest("kids.transcribe");
    await page.locator(".kids-solve").getByText("Finishing your words…", { exact: true }).waitFor();
    expect(await page.locator(".kids-footer").isVisible()).toBe(false);
    await gateway.resolveDeferred("kids.transcribe", { text: "No. They are different." });
    await page.waitForFunction(
      () =>
        document.querySelector<HTMLTextAreaElement>("#kids-answer")?.value ===
        "No. They are different.",
    );
    expect(await gateway.getRequests("kids.activity.answer")).toHaveLength(1);
    expect(await gateway.getRequests("chat.send")).toHaveLength(0);
    await page.setViewportSize({ width: 1024, height: 1366 });
    await capture("explanation-portrait", "iPad portrait — dictated words ready to edit or check");
    await gateway.deferNext("kids.activity.answer");
    await page.getByRole("button", { name: "Check answer", exact: true }).click();
    const clarify = await gateway.waitForRequest("kids.activity.answer", { after: 1 });
    await gateway.resolveDeferred("kids.activity.answer", {
      snapshot: explanation,
      feedback: {
        questionId: "q2",
        outcome: "clarify",
        independent: true,
        explanation: "Tell me how you compared the two spaces.",
      },
    });
    await page.getByText("Tell me a little more.", { exact: true }).waitFor();
    expect(await words.inputValue()).toBe("No. They are different.");
    await capture(
      "explanation-clarify-portrait",
      "iPad portrait — clarification keeps the answer editable",
    );
    await words.fill("No. Their areas are 9 and 24 square centimeters.");
    await page.setViewportSize({ width: 320, height: 480 });
    await words.scrollIntoViewIfNeeded();
    expect(await page.locator(".kids-solve .kids-pet").isVisible()).toBe(false);
    await capture(
      "explanation-keyboard-narrow",
      "Narrow reduced viewport with focused answer — desktop keyboard-space simulation",
    );
    await gateway.deferNext("kids.activity.answer");
    await page.getByRole("button", { name: "Check answer", exact: true }).click();
    const uncertain = await gateway.waitForRequest("kids.activity.answer", { after: 2 });
    expect(uncertain.params).not.toMatchObject({
      requestId: (clarify.params as { requestId: string }).requestId,
    });
    await gateway.rejectDeferred("kids.activity.answer", {
      code: "UNAVAILABLE",
      message: "Synthetic checker unavailable",
    });
    await page
      .getByText("Rocky couldn’t check that just now. Your answer is still here—try again.", {
        exact: true,
      })
      .waitFor();
    expect(await words.inputValue()).toBe("No. Their areas are 9 and 24 square centimeters.");
    await page.setViewportSize({ width: 1024, height: 768 });
    await capture(
      "explanation-error-landscape",
      "iPad landscape — failed checking preserves the exact answer",
    );
    await gateway.deferNext("kids.activity.answer");
    await page.getByRole("button", { name: "Try again", exact: true }).click();
    const replay = await gateway.waitForRequest("kids.activity.answer", { after: 3 });
    expect(replay.params).toEqual(uncertain.params);
    const complete = structuredClone(explanation);
    complete.activity!.currentQuestion = null;
    complete.activity!.completed = true;
    complete.activity!.currentIndex = 2;
    complete.daily!.completed = 1;
    await gateway.setMethodResponse("kids.activity.get", complete);
    await gateway.resolveDeferred("kids.activity.answer", {
      snapshot: complete,
      feedback: {
        questionId: "q2",
        outcome: "correct",
        independent: true,
        explanation: "The areas are 9 and 24 square centimeters, so the spaces differ.",
      },
    });
    await page.getByText("You’ve got it.", { exact: true }).waitFor();
    expect(await words.inputValue()).toBe("No. Their areas are 9 and 24 square centimeters.");
    await capture(
      "explanation-correct-landscape",
      "iPad landscape — checked reasoning remains visible",
    );
    await page.getByRole("button", { name: "Continue", exact: true }).click();
    await page.getByRole("heading", { name: "All done for today!", exact: true }).waitFor();
    await page.getByRole("button", { name: "Chat with Rocky", exact: true }).click();
    expect(await page.getByLabel("Message Rocky", { exact: true }).inputValue()).toBe(
      "Keep my chat draft.",
    );
    expect(await gateway.getRequests("chat.send")).toHaveLength(0);
    expect(errors).toEqual([]);
  } finally {
    await context.close();
  }
});
