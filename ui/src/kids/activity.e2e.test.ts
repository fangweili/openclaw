/** Browser boundary proof with a synthetic Gateway; no live conversations or providers. */
import { readFile } from "node:fs/promises";
import path from "node:path";
import type { ActivitySnapshot } from "@openclaw/kids-activity-contract";
import type { Browser, Locator } from "playwright";
import { afterAll, beforeAll, expect, it } from "vitest";
import { defaultControlUiFeatureMethods } from "../test-helpers/control-ui-e2e-defaults.ts";
import { installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import {
  notificationPermissionFixture,
  profile,
  readKidsFrame,
  roster,
  sessionKey,
  startKidsE2e,
} from "./app.e2e.test-support.ts";

let browser: Browser;
let baseUrl: string;
let proof: string;
let examples: Array<{ id: string; label: string }>;
let harness: Awaited<ReturnType<typeof startKidsE2e>> | undefined;

beforeAll(async () => {
  harness = await startKidsE2e("kids-activities");
  ({ browser, baseUrl, proof, examples } = harness);
});
afterAll(async () => {
  await harness?.close();
});

it("keeps saved activities beside chat, grades through the server, and carries a question into the existing draft", async () => {
  const context = await browser.newContext({
    viewport: { width: 1024, height: 1366 },
    reducedMotion: "reduce",
  });
  try {
    await context.addInitScript(notificationPermissionFixture);
    // Exercise Safari's event fallback in Chromium; this does not prove native iPad zoom.
    await context.addInitScript(() => {
      const supports = CSS.supports.bind(CSS);
      Object.defineProperty(CSS, "supports", {
        value: (property: string, value?: string) =>
          property === "-webkit-touch-callout" && value === "none"
            ? true
            : value === undefined
              ? supports(property)
              : supports(property, value),
      });
    });
    const page = await context.newPage();
    const doubleTap = async (target: Locator, cancelsSecond = true) => {
      const prevented = await target.evaluate((element) => {
        element.dispatchEvent(new TouchEvent("touchcancel", { bubbles: true }));
        const bounds = element.getBoundingClientRect();
        const finger = new Touch({
          identifier: 1,
          target: element,
          clientX: bounds.left + 8,
          clientY: bounds.top + 8,
        });
        return [1000, 1150].map((at) => {
          const start = new TouchEvent("touchstart", {
            bubbles: true,
            cancelable: true,
            touches: [finger],
            changedTouches: [finger],
          });
          Object.defineProperty(start, "timeStamp", { value: at });
          element.dispatchEvent(start);
          const end = new TouchEvent("touchend", {
            bubbles: true,
            cancelable: true,
            touches: [],
            changedTouches: [finger],
          });
          Object.defineProperty(end, "timeStamp", { value: at + 30 });
          element.dispatchEvent(end);
          return end.defaultPrevented;
        });
      });
      expect(prevented).toEqual([false, cancelsSecond]);
    };
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    const capture = async (id: string, label: string) => {
      await page.locator('.kids-activity-card[aria-busy="false"]').waitFor();
      await page
        .locator(".kids-solve .kids-pet-picture img")
        .evaluate((element: HTMLImageElement) => element.decode());
      await page.screenshot({ path: path.join(proof, `${id}.png`), fullPage: true });
      examples.push({ id, label });
    };
    // Check usable viewport space, rather than mirroring CSS column sizes.
    const landscape = async (state: string) => {
      for (const viewport of [
        { width: 1024, height: 768 },
        { width: 1180, height: 820 },
        { width: 1366, height: 1024 },
        { width: 1024, height: 650 },
      ]) {
        await page.setViewportSize(viewport);
        const id = `today-${state}-landscape-${viewport.width}-${viewport.height}`;
        await page.screenshot({ path: path.join(proof, `${id}.png`), animations: "disabled" });
        examples.push({ id, label: `Landscape ${viewport.width} × ${viewport.height} — ${state}` });
        const layout = await page.locator(".kids-solve").evaluate((element) => {
          const pet = element.querySelector(".kids-pet")!.getBoundingClientRect();
          const card = element.querySelector(".kids-activity-card")!.getBoundingClientRect();
          const bounds = element.getBoundingClientRect();
          return {
            sideBySide: pet.right <= card.left,
            clearOfNavigation:
              document.querySelector(".kids-page-navigation")!.getBoundingClientRect().bottom <=
              Math.min(pet.top, card.top),
            visible: card.top >= bounds.top && card.bottom <= bounds.bottom,
            verticalOverflow: element.scrollHeight - element.clientHeight,
            horizontalOverflow: element.scrollWidth - element.clientWidth,
            targets: Array.from(element.querySelectorAll("button")).every(
              (button) => button.getBoundingClientRect().height >= 44,
            ),
          };
        });
        expect(layout.sideBySide).toBe(true);
        expect(layout.clearOfNavigation).toBe(true);
        expect(layout.visible).toBe(true);
        expect(layout.verticalOverflow).toBeLessThanOrEqual(1);
        expect(layout.horizontalOverflow).toBeLessThanOrEqual(1);
        expect(layout.targets).toBe(true);
      }
      await page.setViewportSize({ width: 1024, height: 1366 });
    };
    const image = await readFile(path.resolve("extensions/kids-ui/pets/rocky-reference.webp"));
    const today: ActivitySnapshot = {
      now: 1000,
      date: "2026-10-13",
      correctStreak: 0,
      perfectDayStreak: 0,
      daily: {
        date: "2026-10-13",
        total: 3,
        completed: 0,
        questionsSolved: 0,
        firstTryCorrect: 0,
        hintedQuestions: 0,
      },
      nextActivity: null,
      pet: {
        state: "normal",
        lastInteractionAt: 1000,
        excitedUntil: null,
        scene: null,
        image: {
          imageId: "fixture-pet",
          caption: "A tiny boat, a big question. Shall we explore?",
        },
      },
      activity: {
        id: "leaf-boats",
        date: "2026-10-13",
        title: "The leaf-boat adventure",
        subject: "Science",
        started: false,
        completed: false,
        currentIndex: 0,
        total: 3,
        currentQuestion: {
          kind: "choice",
          id: "q1",
          prompt: "Which leaf would make the steadiest little boat?",
          hint: null,
          options: [
            { id: "broad", text: "A wide, flat leaf" },
            { id: "thin", text: "A thin blade of grass" },
            { id: "torn", text: "A leaf with a big hole" },
            { id: "curled", text: "A tightly curled leaf" },
          ],
        },
      },
    };
    const gateway = await installMockGateway(page, {
      awaitInitialRoster: false,
      featureMethods: [...defaultControlUiFeatureMethods, "kids.activity.get"],
      sessionKey,
      operatorScopes: ["operator.sessions.write", "operator.talk"],
      methodResponses: {
        "users.self": { profile },
        "agents.list": roster,
        "sessions.create": { key: sessionKey },
        "chat.history": {
          sessionId: "student-session",
          messages: Array.from({ length: 24 }, (_, index) => ({
            __openclaw: { id: `discovery-${index}` },
            role: "assistant",
            content: [
              {
                type: "text",
                text: `Garden discovery ${index + 1}\n\nA broad leaf spreads its weight across the water. What shape would you like to try next?`,
              },
            ],
          })),
          sessionInfo: { sessionId: "student-session", activeLeafEntryId: "leaf-one" },
        },
        "kids.activity.get": today,
        "kids.activity.image": { mimeType: "image/webp", base64: image.toString("base64") },
      },
    });
    await page.goto(baseUrl);
    await page.getByRole("heading", { name: "What shall we do, Alex?" }).waitFor();
    const home = page.getByRole("main", { name: "Today", exact: true });
    const homePet = home.locator('img[src^="blob:"]');
    await homePet.waitFor();
    await homePet.evaluate((element: HTMLImageElement) => element.decode());
    await doubleTap(home.locator(".kids-home-solve strong"));
    await doubleTap(home);
    await doubleTap(page.locator("body"));
    for (const name of ["Practice", "Create", "Finish"]) {
      expect(
        await home.getByRole("button", { name: `${name}, coming later`, exact: true }).isDisabled(),
      ).toBe(true);
    }
    expect((await gateway.getRequests("kids.activity.touch")).length).toBe(0);
    for (const viewport of [
      { width: 1024, height: 1366 },
      { width: 1024, height: 768 },
      { width: 1180, height: 820 },
      { width: 320, height: 844 },
    ]) {
      await page.setViewportSize(viewport);
      const id = `home-${viewport.width}-${viewport.height}`;
      await page.screenshot({ path: path.join(proof, `${id}.png`), animations: "disabled" });
      examples.push({ id, label: `Today home — ${viewport.width} × ${viewport.height}` });
      const layout = await home.evaluate((element) => {
        const title = element.querySelector("h1")!.getBoundingClientRect();
        const pet = element.querySelector(".kids-pet")!.getBoundingClientRect();
        const cards = element.querySelector(".kids-home-content")!.getBoundingClientRect();
        const bounds = element.getBoundingClientRect();
        return {
          overflow: element.scrollWidth - element.clientWidth,
          centered: Math.abs((title.left + title.right) / 2 - (bounds.left + bounds.right) / 2),
          aboveBoth: title.bottom <= pet.top && title.bottom <= cards.top,
          stageCenter: Math.abs((title.top + cards.bottom) / 2 - innerHeight / 2),
          greetingGap: cards.top - title.bottom,
        };
      });
      expect(layout.overflow).toBeLessThanOrEqual(1);
      expect(layout.centered).toBeLessThanOrEqual(1);
      expect(layout.aboveBoth).toBe(true);
      if (viewport.width > viewport.height) {
        expect(layout.stageCenter).toBeLessThanOrEqual(2);
        expect(layout.greetingGap).toBeGreaterThanOrEqual(40);
      }
      const homeFrame = await readKidsFrame(page);
      await page.getByRole("button", { name: "Solve", exact: true }).click();
      await page.locator('.kids-activity-card[aria-busy="false"]').waitFor();
      expect(await readKidsFrame(page)).toEqual(homeFrame);
      const solveId = `solve-frame-${viewport.width}-${viewport.height}`;
      await capture(solveId, `Matching Solve frame — ${viewport.width} × ${viewport.height}`);
      await page.getByRole("button", { name: "Today", exact: true }).click();
      expect(await readKidsFrame(page)).toEqual(homeFrame);
    }
    await page.setViewportSize({ width: 1024, height: 1366 });
    await page.getByRole("button", { name: "Solve", exact: true }).click();
    await page.getByRole("heading", { name: today.activity!.title }).waitFor();
    await page.reload();
    await page.getByRole("heading", { name: today.activity!.title }).waitFor();
    expect(new URL(page.url()).hash).toBe("#solve");
    await page.locator('.kids-solve img[src^="blob:"]').waitFor();
    const currentPet = await page.locator(".kids-solve .kids-pet-picture img").getAttribute("src");
    await doubleTap(page.locator(".kids-solve .kids-activity-card"));
    await doubleTap(page.getByRole("button", { name: "Let's explore", exact: true }));
    await page.getByRole("button", { name: "Today", exact: true }).click();
    await page.getByRole("button", { name: "Chat with Rocky", exact: true }).click();
    const composer = page.getByLabel("Message Rocky", { exact: true });
    await composer.fill("I found a leaf in the garden.");
    await doubleTap(page.locator(".kids-message-content").first());
    await doubleTap(page.locator(".kids-thread"));
    await doubleTap(page.getByRole("button", { name: "Send message", exact: true }));
    await doubleTap(composer, false);
    expect(
      await composer.evaluate((element) =>
        ["gesturestart", "gesturechange"].map((type) => {
          const pinch = new Event(type, { bubbles: true, cancelable: true });
          element.dispatchEvent(pinch);
          return pinch.defaultPrevented;
        }),
      ),
    ).toEqual([true, true]);
    expect(await composer.inputValue()).toBe("I found a leaf in the garden.");
    expect(await page.getByRole("button", { name: "Back to Solve", exact: true }).count()).toBe(0);
    const thread = page.locator(".kids-thread");
    expect(
      await thread.evaluate((element) => {
        element.scrollTop = 0;
        const first = element.querySelector(".kids-message")!.getBoundingClientRect();
        const navigation = document.querySelector(".kids-page-navigation")!.getBoundingClientRect();
        return first.top >= navigation.bottom;
      }),
    ).toBe(true);
    await thread.evaluate(
      (element) =>
        new Promise<void>((resolve) => {
          element.addEventListener("scroll", () => resolve(), { once: true });
          element.scrollTop = 400;
        }),
    );
    await page.getByRole("button", { name: "Jump to latest message", exact: true }).waitFor();
    const readingPosition = await thread.evaluate((element) => element.scrollTop);
    // Long history scrolls inside the transcript, including its hidden speaker labels.
    expect(readingPosition).toBe(400);
    expect(
      await thread.evaluate((element) => ({
        hasHistoryOverflow: element.scrollHeight > element.clientHeight,
        bodyHeight: document.body.scrollHeight,
        shellHeight: document.querySelector(".kids-shell")!.scrollHeight,
        viewportHeight: window.innerHeight,
      })),
    ).toEqual({
      hasHistoryOverflow: true,
      bodyHeight: 1366,
      shellHeight: 1366,
      viewportHeight: 1366,
    });
    await page.screenshot({ path: path.join(proof, "chat-navigation-ipad.png"), fullPage: true });
    examples.push({
      id: "chat-navigation-ipad",
      label: "iPad — floating Chat navigation while reading earlier messages",
    });
    await page.getByRole("button", { name: "Today", exact: true }).click();
    await page.getByRole("button", { name: "Solve", exact: true }).click();
    await page.getByRole("heading", { name: today.activity!.title }).waitFor();
    expect(await page.locator(".kids-solve .kids-pet-picture img").getAttribute("src")).toBe(
      currentPet,
    );
    await capture("solve-ready-ipad", "iPad — daily scene and saved Solve invitation");
    // Home and Chat retain their own state; choosing Solve does not start a quiz.
    await page.getByRole("button", { name: "Today", exact: true }).click();
    await page.getByRole("button", { name: "Chat with Rocky", exact: true }).click();
    expect(await thread.evaluate((element) => element.scrollTop)).toBeCloseTo(readingPosition, 0);
    expect(await composer.inputValue()).toBe("I found a leaf in the garden.");
    await page.getByRole("button", { name: "Today", exact: true }).click();
    await page.getByRole("button", { name: "Solve", exact: true }).click();
    expect((await gateway.getRequests("kids.activity.touch")).length).toBe(0);
    const started = structuredClone(today);
    started.activity!.started = true;
    await gateway.deferNext("kids.activity.start");
    await page.getByRole("button", { name: "Let's explore", exact: true }).click();
    const start = await gateway.waitForRequest("kids.activity.start");
    expect(start.params).toMatchObject({
      sessionKey,
      activityId: "leaf-boats",
    });
    // Reads reflect the mutation only after the server receives it. In
    // particular, the refresh on entering Solve must still show the invitation.
    await gateway.setMethodResponse("kids.activity.get", started);
    await gateway.resolveDeferred("kids.activity.start", { snapshot: started });
    await page.getByRole("button", { name: "A wide, flat leaf", exact: true }).waitFor();
    await page.screenshot({
      path: path.join(proof, "today-question-portrait.png"),
      animations: "disabled",
    });
    examples.push({ id: "today-question-portrait", label: "Portrait — four-answer challenge" });
    await landscape("question");
    const hinted = structuredClone(started);
    hinted.activity!.currentQuestion!.hint = "Think about a shape that spreads out over the water.";
    await gateway.setMethodResponse("kids.activity.hint", { snapshot: hinted });
    await gateway.deferNext("kids.activity.hint");
    await page.getByRole("button", { name: "Talk it through", exact: true }).click();
    const help = await gateway.waitForRequest("kids.activity.hint");
    expect(help.params).toMatchObject({ sessionKey, activityId: "leaf-boats", questionId: "q1" });
    expect(await composer.isVisible()).toBe(false);
    expect(await composer.inputValue()).toBe("I found a leaf in the garden.");
    await gateway.resolveDeferred("kids.activity.hint", { snapshot: hinted });
    await composer.waitFor({ state: "visible" });
    expect(await composer.inputValue()).toContain("I found a leaf in the garden.");
    expect(await composer.inputValue()).toContain(started.activity!.currentQuestion!.prompt);
    expect(await composer.inputValue()).toContain(
      "Give me one small hint and let me try before you explain the answer.",
    );
    expect((await gateway.getRequests("chat.send")).length).toBe(0);
    expect((await gateway.getRequests("sessions.create")).length).toBe(1);
    await gateway.setMethodResponse("kids.activity.get", hinted);
    await page.getByRole("button", { name: "Back to Solve", exact: true }).click();
    await page.getByText(hinted.activity!.currentQuestion!.hint!).waitFor();
    await capture("today-hint-ipad", "iPad — a question with an optional hint");
    await landscape("hint");
    const answered = structuredClone(hinted);
    answered.correctStreak = 1;
    answered.activity!.currentIndex = 1;
    answered.activity!.currentQuestion = {
      kind: "choice",
      id: "q2",
      prompt: "What might help your leaf boat stay balanced?",
      hint: null,
      options: [
        { id: "middle", text: "Put a small pebble in the middle" },
        { id: "edge", text: "Put a big pebble on the edge" },
      ],
    };
    await gateway.setMethodResponse("kids.activity.answer", {
      snapshot: answered,
      feedback: {
        questionId: "q1",
        outcome: "correct",
        independent: false,
        explanation: "A wide leaf spreads its weight across the water.",
      },
    });
    await page.getByRole("button", { name: "A wide, flat leaf", exact: true }).click();
    await page.getByRole("heading", { name: "You figured it out!" }).waitFor();
    await gateway.setMethodResponse("kids.activity.get", answered);
    await landscape("feedback");
    expect(
      await page.getByText(started.activity!.currentQuestion!.prompt, { exact: true }).count(),
    ).toBe(1);
    expect(
      await page.getByText(answered.activity!.currentQuestion!.prompt, { exact: true }).count(),
    ).toBe(0);
    await page.evaluate(() => {
      location.hash = "#chat";
    });
    await composer.waitFor({ state: "visible" });
    await page.getByRole("button", { name: "Back to Solve", exact: true }).click();
    await page.getByRole("heading", { name: "You figured it out!" }).waitFor();
    expect(
      await page.getByText(started.activity!.currentQuestion!.prompt, { exact: true }).count(),
    ).toBe(1);
    await page.getByRole("button", { name: "Continue", exact: true }).click();
    await page.getByText(answered.activity!.currentQuestion!.prompt, { exact: true }).waitFor();
    await capture("today-progress-ipad", "iPad — saved progress on the next question");
    await gateway.setMethodResponse("kids.activity.answer", {
      snapshot: answered,
      feedback: {
        questionId: "q2",
        outcome: "revise",
        independent: true,
        explanation: "An uneven load can tip a boat. Let's try another arrangement.",
      },
    });
    await page.getByRole("button", { name: "Put a big pebble on the edge", exact: true }).click();
    await page.getByRole("heading", { name: "Let's look at it together" }).waitFor();
    await capture("today-retry-ipad", "iPad — friendly feedback after a wrong answer");
    await page.getByRole("button", { name: "Try this question again", exact: true }).click();
    const completed = structuredClone(answered);
    completed.correctStreak = 3;
    completed.pet.state = "excited";
    completed.pet.excitedUntil = 121000;
    completed.pet.image!.caption = "Three discoveries! A tiny victory dance for our boat explorer.";
    completed.activity!.currentIndex = 3;
    completed.activity!.completed = true;
    completed.activity!.currentQuestion = null;
    completed.daily!.completed = 1;
    completed.daily!.questionsSolved = 3;
    completed.daily!.firstTryCorrect = 2;
    completed.daily!.hintedQuestions = 1;
    completed.nextActivity = { id: "shadow-play", title: "The moving-shadow mystery" };
    // Another device can finish the current challenge while this one is in Chat.
    await page.evaluate(() => {
      location.hash = "#chat";
    });
    await composer.waitFor({ state: "visible" });
    await gateway.setMethodResponse("kids.activity.get", completed);
    await page.getByRole("button", { name: "Back to Solve", exact: true }).click();
    await page.getByRole("heading", { name: "Adventure complete!" }).waitFor();
    expect(await page.locator(".kids-solve .kids-pet--excited").count()).toBe(1);
    await page.getByText("1 of 3 challenges complete", { exact: true }).waitFor();
    await page.getByRole("button", { name: "Another challenge", exact: true }).waitFor();
    await capture("today-complete-ipad", "iPad — choose another challenge or chat");
    await landscape("complete");
    // Neither revisiting Today nor choosing Chat starts an optional extra.
    await gateway.setMethodResponse("kids.activity.get", completed);
    await page.getByRole("button", { name: "Chat with Rocky", exact: true }).click();
    await composer.waitFor({ state: "visible" });
    expect(await composer.inputValue()).toContain("I found a leaf in the garden.");
    await page.getByRole("button", { name: "Back to Solve", exact: true }).click();
    await page.getByText("1 of 3 challenges complete", { exact: true }).waitFor();
    expect(await gateway.getRequests("kids.activity.start")).toHaveLength(1);
    let selected = completed;
    for (const ordinal of [2, 3]) {
      const offer = selected.nextActivity!;
      selected = structuredClone(started);
      selected.activity!.id = offer.id;
      selected.activity!.title = offer.title;
      selected.daily!.completed = ordinal - 1;
      selected.daily!.questionsSolved = (ordinal - 1) * 3;
      selected.daily!.firstTryCorrect = selected.daily!.questionsSolved - 1;
      selected.daily!.hintedQuestions = 1;
      await gateway.setMethodResponse("kids.activity.start", { snapshot: selected });
      await page.getByRole("button", { name: "Another challenge", exact: true }).click();
      await page.getByRole("heading", { name: offer.title }).waitFor();
      await gateway.setMethodResponse("kids.activity.get", selected);
      expect((await gateway.getRequests("kids.activity.start"))[ordinal - 1]?.params).toMatchObject(
        {
          sessionKey,
          activityId: offer.id,
        },
      );
      for (let index = 0; index < 3; index += 1) {
        const submitted = selected.activity!.currentQuestion!;
        selected = structuredClone(selected);
        selected.activity!.currentIndex = index + 1;
        selected.daily!.questionsSolved += 1;
        selected.daily!.firstTryCorrect += 1;
        selected.correctStreak = selected.daily!.questionsSolved;
        selected.activity!.completed = index === 2;
        selected.activity!.currentQuestion =
          index === 2
            ? null
            : {
                ...submitted,
                id: `q${index + 2}`,
                prompt: `Boat question ${index + 2}`,
              };
        if (index === 2) {
          selected.daily!.completed = ordinal;
          selected.nextActivity =
            ordinal === 2 ? { id: "garden-patterns", title: "The garden-pattern puzzle" } : null;
        }
        await gateway.setMethodResponse("kids.activity.answer", {
          snapshot: selected,
          feedback: {
            questionId: submitted.id,
            outcome: "correct",
            independent: true,
            explanation: "A wide leaf spreads its weight across the water.",
          },
        });
        await page.getByRole("button", { name: "A wide, flat leaf", exact: true }).click();
        await page.getByRole("heading", { name: "You figured it out!" }).waitFor();
        await gateway.setMethodResponse("kids.activity.get", selected);
        expect(await page.locator(".kids-activity-daily").count()).toBe(0);
        expect(await page.locator(".kids-daily-recap").count()).toBe(0);
        await page.getByRole("button", { name: "Continue", exact: true }).click();
      }
      if (ordinal === 2) {
        await page.getByText("2 of 3 challenges complete", { exact: true }).waitFor();
      }
    }
    await page.getByRole("heading", { name: "You did it, Alex!" }).waitFor();
    await page.getByRole("heading", { name: "Look what you figured out!" }).waitFor();
    await page.getByText("3 challenges · 9 questions solved", { exact: true }).waitFor();
    expect(await page.locator(".kids-daily-value").allTextContents()).toEqual(["8", "1", "0"]);
    expect(await page.getByRole("heading", { name: selected.activity!.title }).count()).toBe(0);
    expect(await page.locator(".kids-activity-subject, .kids-activity-count").count()).toBe(0);
    expect(await page.getByRole("progressbar").count()).toBe(0);
    expect(await page.getByRole("button", { name: "Another challenge", exact: true }).count()).toBe(
      0,
    );
    await capture("today-all-done-ipad", "iPad — all three complete, chat stays available");
    await landscape("daily-recap");
    for (const viewport of [
      { width: 1024, height: 768 },
      { width: 1024, height: 1366 },
    ]) {
      await page.setViewportSize(viewport);
      const recapFrame = await readKidsFrame(page);
      await page.getByRole("button", { name: "Today", exact: true }).click();
      await page.getByText("Today complete · See how you did", { exact: true }).waitFor();
      expect(await readKidsFrame(page)).toEqual(recapFrame);
      const id = `home-complete-${viewport.width}-${viewport.height}`;
      await page.screenshot({ path: path.join(proof, `${id}.png`) });
      examples.push({ id, label: "Today — completed Solve opens the saved recap" });
      await page.getByRole("button", { name: "Solve", exact: true }).click();
      await page.locator('.kids-activity-card[aria-busy="false"]').waitFor();
      expect(await readKidsFrame(page)).toEqual(recapFrame);
    }
    await page.setViewportSize({ width: 320, height: 844 });
    await capture("today-complete-phone", "Phone — all three challenges complete");
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    ).toBe(true);
    await page.getByRole("button", { name: "Chat with Rocky", exact: true }).click();
    await composer.waitFor({ state: "visible" });
    expect(
      await page.evaluate(() => {
        const threadArea = document.querySelector(".kids-thread-area")!.getBoundingClientRect();
        const footer = document.querySelector(".kids-footer")!.getBoundingClientRect();
        return threadArea.top === 0 && Math.abs(footer.bottom - innerHeight) <= 1;
      }),
    ).toBe(true);
    expect(await page.getByRole("button", { name: "Back to Solve", exact: true }).isVisible()).toBe(
      true,
    );
    // Completing a retained quiz can reveal today's prepared invitation in the
    // same reply. Its explanation still belongs under the submitted quiz heading.
    const yesterday = structuredClone(hinted);
    yesterday.activity!.date = "2026-10-12";
    yesterday.activity!.title = "Yesterday's leaf-boat adventure";
    yesterday.activity!.currentIndex = 2;
    const nextDay = structuredClone(today);
    nextDay.activity!.id = "fresh-discovery";
    nextDay.activity!.title = "Today's fresh discovery";
    await gateway.setMethodResponse("kids.activity.get", yesterday);
    await page.setViewportSize({ width: 1024, height: 1366 });
    await page.getByRole("button", { name: "Back to Solve", exact: true }).click();
    await page.getByRole("heading", { name: yesterday.activity!.title }).waitFor();
    await gateway.setMethodResponse("kids.activity.answer", {
      snapshot: nextDay,
      feedback: {
        questionId: "q1",
        outcome: "correct",
        independent: false,
        explanation: "A wide leaf spreads its weight across the water.",
      },
    });
    await page.getByRole("button", { name: "A wide, flat leaf", exact: true }).click();
    await page.getByText("A wide leaf spreads its weight across the water.").waitFor();
    await gateway.setMethodResponse("kids.activity.get", nextDay);
    expect(await page.getByRole("heading", { name: yesterday.activity!.title }).count()).toBe(1);
    expect(await page.getByRole("heading", { name: nextDay.activity!.title }).count()).toBe(0);
    expect(await page.getByRole("progressbar").count()).toBe(0);
    expect(await page.locator(".kids-activity-daily").count()).toBe(0);
    await capture(
      "today-rollover-feedback-ipad",
      "iPad — yesterday's final answer keeps its explanation",
    );
    await page.getByRole("button", { name: "Continue", exact: true }).click();
    await page.getByRole("heading", { name: nextDay.activity!.title }).waitFor();
    await page.getByRole("button", { name: "Let's explore", exact: true }).waitFor();
    expect(await page.getByRole("heading", { name: yesterday.activity!.title }).count()).toBe(0);
    expect(errors).toEqual([]);
  } finally {
    await context.close();
  }
});

it("shows recoverable Today loading and failure states while chat remains usable", async () => {
  const context = await browser.newContext({ viewport: { width: 1024, height: 1366 } });
  try {
    await context.addInitScript(notificationPermissionFixture);
    const page = await context.newPage();
    const gateway = await installMockGateway(page, {
      awaitInitialRoster: false,
      featureMethods: [...defaultControlUiFeatureMethods, "kids.activity.get"],
      sessionKey,
      operatorScopes: ["operator.sessions.write", "operator.talk"],
      deferredMethods: ["kids.activity.get"],
      methodResponses: {
        "users.self": { profile },
        "agents.list": roster,
        "sessions.create": { key: sessionKey },
        "chat.history": {
          sessionId: "student-session",
          messages: [],
          sessionInfo: { sessionId: "student-session", activeLeafEntryId: "leaf-one" },
        },
      },
    });
    await page.goto(baseUrl);
    await page.getByRole("button", { name: "Solve", exact: true }).click();
    await gateway.waitForRequest("kids.activity.get");
    await page.getByText("Opening your adventure…", { exact: true }).waitFor();
    await page.screenshot({ path: path.join(proof, "today-loading-ipad.png"), fullPage: true });
    examples.push({ id: "today-loading-ipad", label: "iPad — loading the private daily activity" });
    await gateway.rejectDeferred("kids.activity.get", {
      code: "UNAVAILABLE",
      message: "Fixture temporarily unavailable",
    });
    await page.getByText("Your adventure could not load.", { exact: false }).waitFor();
    await page.screenshot({ path: path.join(proof, "today-error-ipad.png"), fullPage: true });
    examples.push({
      id: "today-error-ipad",
      label: "iPad — recoverable activity failure; chat stays available",
    });
    const empty: ActivitySnapshot = {
      now: 1000,
      date: "2026-10-13",
      correctStreak: 0,
      perfectDayStreak: 0,
      daily: null,
      nextActivity: null,
      activity: null,
      pet: {
        state: "sleeping",
        image: null,
        scene: null,
        lastInteractionAt: null,
        excitedUntil: null,
      },
    };
    await gateway.setMethodResponse("kids.activity.get", empty);
    await page.getByRole("button", { name: "Try again", exact: true }).click();
    await page.getByRole("heading", { name: "A little adventure is on its way" }).waitFor();
    await page.screenshot({ path: path.join(proof, "today-empty-ipad.png"), fullPage: true });
    examples.push({ id: "today-empty-ipad", label: "iPad — no daily quiz prepared yet" });
    await page.getByRole("button", { name: "Chat with Rocky", exact: true }).click();
    await page.getByLabel("Message Rocky", { exact: true }).fill("Let's talk about boats.");
    expect(await page.getByRole("button", { name: "Send message", exact: true }).isEnabled()).toBe(
      true,
    );
    expect((await gateway.getRequests("kids.activity.touch")).length).toBe(0);
  } finally {
    await context.close();
  }
});
