/** Browser boundary proof with a synthetic Gateway; no live conversations or providers. */
import { readFile } from "node:fs/promises";
import path from "node:path";
import type { ActivitySnapshot } from "@openclaw/kids-activity-contract";
import type { Browser } from "playwright";
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
    const page = await context.newPage();
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
      extras: { questionsSolved: 0 },
      canContinue: false,
      daily: {
        date: "2026-10-13",
        questionTotal: 9,
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
        scope: "daily",
        firstTryCorrect: 0,
        hintedQuestions: 0,
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
    await page.getByRole("button", { name: "Today", exact: true }).click();
    await page.getByRole("button", { name: "Chat with Rocky", exact: true }).click();
    const composer = page.getByLabel("Message Rocky", { exact: true });
    await composer.fill("I found a leaf in the garden.");
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
    await page.getByText("Daily goal · 3 of 9 solved", { exact: true }).waitFor();
    await page.getByRole("button", { name: "Keep going", exact: true }).waitFor();
    await capture("today-complete-ipad", "iPad — continue the saved nine-question day");
    await landscape("complete");
    // Neither revisiting Today nor choosing Chat starts an optional extra.
    await gateway.setMethodResponse("kids.activity.get", completed);
    await page.getByRole("button", { name: "Today", exact: true }).click();
    await page.getByRole("button", { name: "Chat with Rocky", exact: true }).click();
    await composer.waitFor({ state: "visible" });
    expect(await composer.inputValue()).toContain("I found a leaf in the garden.");
    await page.getByRole("button", { name: "Today", exact: true }).click();
    await page.getByRole("button", { name: "Solve", exact: true }).click();
    await page.getByText("Daily goal · 3 of 9 solved", { exact: true }).waitFor();
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
      await page.getByRole("button", { name: "Keep going", exact: true }).click();
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
          selected.canContinue = ordinal === 3;
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
        await page.getByText("Daily goal · 6 of 9 solved", { exact: true }).waitFor();
      }
    }
    await page.getByRole("heading", { name: "You did it, Alex!" }).waitFor();
    await page.getByRole("heading", { name: "Look what you figured out!" }).waitFor();
    await page.getByText("9 questions solved", { exact: true }).waitFor();
    expect(await page.locator(".kids-daily-value").allTextContents()).toEqual(["8", "1", "0"]);
    expect(await page.getByRole("heading", { name: selected.activity!.title }).count()).toBe(0);
    expect(await page.locator(".kids-activity-subject, .kids-activity-count").count()).toBe(0);
    expect(await page.getByRole("progressbar").count()).toBe(0);
    expect(await page.getByRole("button", { name: "Keep going", exact: true }).count()).toBe(1);
    await capture("today-all-done-ipad", "iPad — saved daily goal complete");
    await landscape("daily-recap");
    for (const viewport of [
      { width: 1024, height: 768 },
      { width: 1024, height: 1366 },
    ]) {
      await page.setViewportSize(viewport);
      const recapFrame = await readKidsFrame(page);
      await page.getByRole("button", { name: "Today", exact: true }).click();
      await page.getByText("Daily goal: 9 solved", { exact: true }).waitFor();
      expect(await readKidsFrame(page)).toEqual(recapFrame);
      const id = `home-complete-${viewport.width}-${viewport.height}`;
      await page.screenshot({ path: path.join(proof, `${id}.png`) });
      examples.push({ id, label: "Today — completed Solve opens the saved recap" });
      await page.getByRole("button", { name: "Solve", exact: true }).click();
      await page.locator('.kids-activity-card[aria-busy="false"]').waitFor();
      expect(await readKidsFrame(page)).toEqual(recapFrame);
    }
    await page.setViewportSize({ width: 320, height: 844 });
    const phoneRecapFrame = await readKidsFrame(page);
    expect(
      await page.locator(".kids-solve h1").evaluate((heading) => {
        const text = document.createRange();
        text.selectNodeContents(heading);
        const navigation = document.querySelector(".kids-page-navigation")!.getBoundingClientRect();
        return text.getBoundingClientRect().top >= navigation.bottom;
      }),
    ).toBe(true);
    await capture("today-complete-phone", "Phone — saved daily goal complete");
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    ).toBe(true);
    await page.getByRole("button", { name: "Today", exact: true }).click();
    expect(await readKidsFrame(page)).toEqual(phoneRecapFrame);
    await page.getByRole("button", { name: "Solve", exact: true }).click();
    await page.locator('.kids-activity-card[aria-busy="false"]').waitFor();
    expect(await readKidsFrame(page)).toEqual(phoneRecapFrame);
    await page.getByRole("button", { name: "Today", exact: true }).click();
    await page.getByRole("button", { name: "Chat with Rocky", exact: true }).click();
    await composer.waitFor({ state: "visible" });
    expect(
      await page.evaluate(() => {
        const threadArea = document.querySelector(".kids-thread-area")!.getBoundingClientRect();
        const footer = document.querySelector(".kids-footer")!.getBoundingClientRect();
        return threadArea.top === 0 && Math.abs(footer.bottom - innerHeight) <= 1;
      }),
    ).toBe(true);
    expect(await page.getByRole("button", { name: "Back to Solve", exact: true }).count()).toBe(0);
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
    await page.getByRole("button", { name: "Today", exact: true }).click();
    await page.getByRole("button", { name: "Solve", exact: true }).click();
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
      extras: { questionsSolved: 0 },
      canContinue: false,
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

it("keeps the daily goal complete while Keep going prepares, retries, and opens adaptive extra batches", async () => {
  const context = await browser.newContext({
    viewport: { width: 1024, height: 1366 },
    reducedMotion: "reduce",
  });
  try {
    await context.addInitScript(notificationPermissionFixture);
    const page = await context.newPage();
    const daily: ActivitySnapshot = {
      now: 1,
      date: "2026-10-14",
      correctStreak: 10,
      perfectDayStreak: 4,
      daily: {
        date: "2026-10-14",
        total: 1,
        completed: 1,
        questionTotal: 10,
        questionsSolved: 10,
        firstTryCorrect: 10,
        hintedQuestions: 0,
      },
      extras: { questionsSolved: 0 },
      canContinue: true,
      nextActivity: null,
      pet: {
        state: "normal",
        scene: null,
        image: { imageId: "reference", caption: "Ready for another discovery." },
        lastInteractionAt: 1,
        excitedUntil: null,
      },
      activity: {
        id: "daily-ten",
        date: "2026-10-14",
        title: "Ten little discoveries",
        subject: "Math",
        scope: "daily",
        firstTryCorrect: 10,
        hintedQuestions: 0,
        started: true,
        completed: true,
        currentIndex: 10,
        total: 10,
        currentQuestion: null,
      },
    };
    const image = await readFile(path.resolve("extensions/kids-ui/pets/rocky-reference.webp"));
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
          messages: [],
          sessionInfo: { sessionId: "student-session", activeLeafEntryId: "leaf-one" },
        },
        "kids.activity.get": daily,
        "kids.activity.image": { mimeType: "image/webp", base64: image.toString("base64") },
      },
    });
    const capture = async (id: string, label: string) => {
      await page.screenshot({ path: path.join(proof, `${id}.png`), animations: "disabled" });
      examples.push({ id, label });
    };
    await page.goto(`${baseUrl}#solve`);
    const card = page.locator(".kids-solve .kids-activity-card");
    await card.getByText("10 questions solved", { exact: true }).waitFor();
    await page
      .locator('.kids-solve img[src^="blob:"]')
      .evaluate((element: HTMLImageElement) => element.decode());
    await page.locator('.kids-activity-card[aria-busy="false"]').waitFor();
    const frame = await readKidsFrame(page);
    const pet = await page.locator(".kids-solve .kids-pet-picture img").getAttribute("src");
    expect(await gateway.getRequests("kids.activity.continue")).toHaveLength(0);
    await capture("daily-ten-complete-ipad", "iPad — ten-question daily goal complete");
    await gateway.deferNext("kids.activity.continue");
    await card.getByRole("button", { name: "Keep going", exact: true }).click();
    const first = await gateway.waitForRequest("kids.activity.continue");
    expect(first.params).toMatchObject({ sessionKey, activityId: "daily-ten" });
    await card
      .getByRole("button", { name: "Preparing your next problems…", exact: true })
      .waitFor();
    expect(await card.locator("button").count()).toBe(1);
    expect(await readKidsFrame(page)).toEqual(frame);
    await capture(
      "next-batch-preparing-ipad",
      "iPad — preparing keeps the completed results visible",
    );
    await gateway.rejectDeferred("kids.activity.continue", {
      code: "UNAVAILABLE",
      message: "Synthetic generation failure",
    });
    await card.getByRole("button", { name: "Try again", exact: true }).waitFor();
    expect(await card.locator("button").count()).toBe(1);
    expect(await card.locator(".kids-daily-recap").count()).toBe(1);
    await capture(
      "next-batch-retry-ipad",
      "iPad — generation failure preserves progress and one retry action",
    );
    const extra = structuredClone(daily);
    extra.canContinue = false;
    extra.activity = {
      ...daily.activity!,
      id: "extra-one",
      title: "A new pattern puzzle",
      scope: "extra",
      firstTryCorrect: 0,
      hintedQuestions: 0,
      completed: false,
      currentIndex: 0,
      currentQuestion: {
        id: "q1",
        kind: "choice",
        prompt: "What comes after 2, 4, 6?",
        hint: null,
        options: [
          { id: "eight", text: "8" },
          { id: "nine", text: "9" },
        ],
      },
    };
    await gateway.deferNext("kids.activity.continue");
    await card.getByRole("button", { name: "Try again", exact: true }).click();
    const retry = await gateway.waitForRequest("kids.activity.continue", { after: 1 });
    expect(retry.params).toEqual(first.params);
    await gateway.setMethodResponse("kids.activity.get", extra);
    await gateway.resolveDeferred("kids.activity.continue", { snapshot: extra });
    await card.getByText(extra.activity.currentQuestion!.prompt, { exact: true }).waitFor();
    expect(await page.getByRole("button", { name: "Let's explore", exact: true }).count()).toBe(0);
    expect(await readKidsFrame(page)).toEqual(frame);
    expect(await page.locator(".kids-solve .kids-pet-picture img").getAttribute("src")).toBe(pet);
    await page.setViewportSize({ width: 1024, height: 768 });
    await capture("extra-batch-landscape", "iPad landscape — next ten questions begin immediately");
    await page.reload();
    await card.getByText(extra.activity.currentQuestion!.prompt, { exact: true }).waitFor();
    // The mock request log is page-owned; reopening must issue no new generation.
    expect(await gateway.getRequests("kids.activity.continue")).toHaveLength(0);
    await page.getByRole("button", { name: "Today", exact: true }).click();
    await page
      .getByText("Daily goal: 10 solved · Continue extra practice", { exact: true })
      .waitFor();
    const almost = structuredClone(extra);
    almost.activity!.currentIndex = 9;
    almost.activity!.currentQuestion!.id = "q10";
    almost.extras.questionsSolved = 9;
    await gateway.setMethodResponse("kids.activity.get", almost);
    await page.getByRole("button", { name: "Solve", exact: true }).click();
    await card.getByText("Questions: 9 of 10", { exact: true }).waitFor();
    const finished = structuredClone(almost);
    finished.activity!.completed = true;
    finished.activity!.currentIndex = 10;
    finished.activity!.currentQuestion = null;
    finished.activity!.firstTryCorrect = 7;
    finished.activity!.hintedQuestions = 2;
    finished.extras.questionsSolved = 10;
    finished.canContinue = true;
    await gateway.setMethodResponse("kids.activity.answer", {
      snapshot: finished,
      feedback: {
        questionId: "q10",
        outcome: "correct",
        independent: true,
        explanation: "Each step adds two.",
      },
    });
    await card.getByRole("button", { name: "8", exact: true }).click();
    await card.getByText("Each step adds two.", { exact: true }).waitFor();
    await gateway.setMethodResponse("kids.activity.get", finished);
    await card.getByRole("button", { name: "Continue", exact: true }).click();
    await card.locator(".kids-daily-mark", { hasText: "Extra practice complete!" }).waitFor();
    await card.getByRole("heading", { name: "This extra batch", exact: true }).waitFor();
    expect(await card.locator(".kids-daily-value").allTextContents()).toEqual(["7", "2", "4"]);
    expect(await card.locator("button").count()).toBe(1);
    await capture(
      "extra-batch-complete-landscape",
      "iPad landscape — extra results keep the perfect-day streak unchanged",
    );
    const extraFrame = await readKidsFrame(page);
    await page.getByRole("button", { name: "Today", exact: true }).click();
    await page.getByText("Daily goal: 10 solved · 10 extra solved", { exact: true }).waitFor();
    expect(await readKidsFrame(page)).toEqual(extraFrame);
    await capture("home-extra-complete-landscape", "Today — fixed daily goal plus extra practice");
    await page.getByRole("button", { name: "Solve", exact: true }).click();
    await page.locator('.kids-activity-card[aria-busy="false"]').waitFor();
    const second = structuredClone(extra);
    second.activity!.id = "extra-two";
    second.extras.questionsSolved = 10;
    await gateway.setMethodResponse("kids.activity.continue", { snapshot: second });
    await card.getByRole("button", { name: "Keep going", exact: true }).click();
    const another = await gateway.waitForRequest("kids.activity.continue");
    expect(another.params).toMatchObject({
      activityId: "extra-one",
      requestId: expect.any(String),
    });
    await card.getByText(second.activity!.currentQuestion!.prompt, { exact: true }).waitFor();
  } finally {
    await context.close();
  }
});
