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
  const context = await browser.newContext({ viewport: { width: 1024, height: 1366 } });
  try {
    await context.addInitScript(notificationPermissionFixture);
    const page = await context.newPage();
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    const capture = async (id: string, label: string) => {
      await page.locator('.kids-activity-card[aria-busy="false"]').waitFor();
      await page.screenshot({ path: path.join(proof, `${id}.png`), fullPage: true });
      examples.push({ id, label });
    };
    const image = await readFile(path.resolve("extensions/kids-ui/pets/rocky-reference.webp"));
    const today: ActivitySnapshot = {
      now: 1000,
      date: "2026-10-13",
      correctStreak: 0,
      daily: { date: "2026-10-13", total: 3, completed: 0 },
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
          id: "q1",
          prompt: "Which leaf would make the steadiest little boat?",
          hint: null,
          options: [
            { id: "broad", text: "A wide, flat leaf" },
            { id: "thin", text: "A thin blade of grass" },
            { id: "torn", text: "A leaf with a big hole" },
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
    const composer = page.getByLabel("Message Rocky", { exact: true });
    await composer.fill("I found a leaf in the garden.");
    const modes = page.getByRole("navigation", { name: "Chat and today's challenges" });
    const modeBounds = await modes.boundingBox();
    expect(
      await modes.getByRole("button", { name: "Chat", exact: true }).getAttribute("aria-current"),
    ).toBe("page");
    for (const name of ["Chat", "Today"]) {
      const bounds = await modes.getByRole("button", { name, exact: true }).boundingBox();
      expect(bounds!.height).toBeGreaterThanOrEqual(44);
      expect(bounds!.width).toBeGreaterThanOrEqual(44);
    }
    const thread = page.locator(".kids-thread");
    await thread.evaluate(
      (element) =>
        new Promise<void>((resolve) => {
          element.addEventListener("scroll", () => resolve(), { once: true });
          element.scrollTop = 400;
        }),
    );
    await page.getByRole("button", { name: "Jump to latest message", exact: true }).waitFor();
    const readingPosition = await thread.evaluate((element) => element.scrollTop);
    await page.screenshot({ path: path.join(proof, "header-chat-ipad.png"), fullPage: true });
    examples.push({
      id: "header-chat-ipad",
      label: "iPad — Chat header while reading earlier messages",
    });
    await page.getByRole("button", { name: "Today", exact: true }).click();
    await page.getByRole("heading", { name: today.activity!.title }).waitFor();
    await page.locator(".kids-pet-picture img[src^='blob:']").waitFor();
    await capture("today-ready-ipad", "iPad — daily scene and saved invitation");
    expect(await modes.boundingBox()).toEqual(modeBounds);
    expect(
      await modes.getByRole("button", { name: "Today", exact: true }).getAttribute("aria-current"),
    ).toBe("page");
    await page.getByRole("button", { name: "Chat", exact: true }).click();
    await composer.waitFor({ state: "visible" });
    expect(await thread.evaluate((element) => element.scrollTop)).toBeCloseTo(readingPosition, 0);
    expect(await composer.inputValue()).toBe("I found a leaf in the garden.");
    await page.getByRole("button", { name: "Today", exact: true }).click();
    await page.getByRole("heading", { name: today.activity!.title }).waitFor();
    expect((await gateway.getRequests("kids.activity.touch")).length).toBe(0);
    const started = structuredClone(today);
    started.activity!.started = true;
    await gateway.setMethodResponse("kids.activity.start", { snapshot: started });
    await page.getByRole("button", { name: "Let's explore", exact: true }).click();
    await page.getByRole("button", { name: "A wide, flat leaf", exact: true }).waitFor();
    expect((await gateway.getRequests("kids.activity.start"))[0]?.params).toMatchObject({
      sessionKey,
      activityId: "leaf-boats",
    });
    const hinted = structuredClone(started);
    hinted.activity!.currentQuestion!.hint = "Think about a shape that spreads out over the water.";
    await gateway.setMethodResponse("kids.activity.hint", { snapshot: hinted });
    await gateway.deferNext("kids.activity.hint");
    await page.getByRole("button", { name: "Help me, Rocky", exact: true }).click();
    const help = await gateway.waitForRequest("kids.activity.hint");
    expect(help.params).toMatchObject({ sessionKey, activityId: "leaf-boats", questionId: "q1" });
    expect(await composer.isVisible()).toBe(false);
    expect(await composer.inputValue()).toBe("I found a leaf in the garden.");
    await gateway.resolveDeferred("kids.activity.hint", { snapshot: hinted });
    await composer.waitFor({ state: "visible" });
    expect(await composer.inputValue()).toContain("I found a leaf in the garden.");
    expect(await composer.inputValue()).toContain(started.activity!.currentQuestion!.prompt);
    expect((await gateway.getRequests("chat.send")).length).toBe(0);
    expect((await gateway.getRequests("sessions.create")).length).toBe(1);
    await gateway.setMethodResponse("kids.activity.get", hinted);
    await page.getByRole("button", { name: "Today", exact: true }).click();
    await page.getByText(hinted.activity!.currentQuestion!.hint!).waitFor();
    await capture("today-hint-ipad", "iPad — a question with an optional hint");
    const answered = structuredClone(hinted);
    answered.correctStreak = 1;
    answered.activity!.currentIndex = 1;
    answered.activity!.currentQuestion = {
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
        correct: true,
        independent: false,
        explanation: "A wide leaf spreads its weight across the water.",
      },
    });
    await page.getByRole("button", { name: "A wide, flat leaf", exact: true }).click();
    await page.getByRole("heading", { name: "You figured it out!" }).waitFor();
    expect(
      await page.getByText(started.activity!.currentQuestion!.prompt, { exact: true }).count(),
    ).toBe(1);
    expect(
      await page.getByText(answered.activity!.currentQuestion!.prompt, { exact: true }).count(),
    ).toBe(0);
    await gateway.setMethodResponse("kids.activity.get", answered);
    await page.getByRole("button", { name: "Chat", exact: true }).click();
    await composer.waitFor({ state: "visible" });
    await page.getByRole("button", { name: "Today", exact: true }).click();
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
        correct: false,
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
    completed.nextActivity = { id: "shadow-play", title: "The moving-shadow mystery" };
    await gateway.setMethodResponse("kids.activity.get", completed);
    await page.getByRole("button", { name: "Chat", exact: true }).click();
    await page.getByRole("button", { name: "Today", exact: true }).click();
    await page.getByRole("heading", { name: "Adventure complete!" }).waitFor();
    expect(await page.locator(".kids-pet--excited").count()).toBe(1);
    await page.getByText("1 of 3 challenges complete", { exact: true }).waitFor();
    await page.getByRole("button", { name: "Another challenge", exact: true }).waitFor();
    await capture("today-complete-ipad", "iPad — choose another challenge or chat");
    // Neither revisiting Today nor choosing Chat starts an optional extra.
    await gateway.setMethodResponse("kids.activity.get", completed);
    await page.getByRole("button", { name: "Chat with Rocky", exact: true }).click();
    await composer.waitFor({ state: "visible" });
    expect(await composer.inputValue()).toContain("I found a leaf in the garden.");
    await page.getByRole("button", { name: "Today", exact: true }).click();
    await page.getByText("1 of 3 challenges complete", { exact: true }).waitFor();
    expect(await gateway.getRequests("kids.activity.start")).toHaveLength(1);
    let selected = completed;
    for (const ordinal of [2, 3]) {
      const offer = selected.nextActivity!;
      selected = structuredClone(started);
      selected.activity!.id = offer.id;
      selected.activity!.title = offer.title;
      selected.daily!.completed = ordinal - 1;
      await gateway.setMethodResponse("kids.activity.start", { snapshot: selected });
      await page.getByRole("button", { name: "Another challenge", exact: true }).click();
      await page.getByRole("heading", { name: offer.title }).waitFor();
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
            correct: true,
            independent: true,
            explanation: "A wide leaf spreads its weight across the water.",
          },
        });
        await page.getByRole("button", { name: "A wide, flat leaf", exact: true }).click();
        await page.getByRole("heading", { name: "You figured it out!" }).waitFor();
        expect(await page.locator(".kids-activity-daily").count()).toBe(0);
        await page.getByRole("button", { name: "Continue", exact: true }).click();
      }
      await page.getByText(`${ordinal} of 3 challenges complete`, { exact: true }).waitFor();
    }
    await page.getByRole("heading", { name: "All done for today!" }).waitFor();
    expect(await page.getByRole("button", { name: "Another challenge", exact: true }).count()).toBe(
      0,
    );
    await capture("today-all-done-ipad", "iPad — all three complete, chat stays available");
    await page.setViewportSize({ width: 320, height: 844 });
    await capture("today-complete-phone", "Phone — all three challenges complete");
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    ).toBe(true);
    for (const name of ["Chat", "Today"]) {
      const bounds = await modes.getByRole("button", { name, exact: true }).boundingBox();
      expect(bounds!.height).toBeGreaterThanOrEqual(44);
      expect(bounds!.width).toBeGreaterThanOrEqual(44);
    }
    const phoneModes = await modes.boundingBox();
    await page.getByRole("button", { name: "Chat", exact: true }).click();
    await composer.waitFor({ state: "visible" });
    expect(await modes.boundingBox()).toEqual(phoneModes);
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
    await page.getByRole("button", { name: "Chat", exact: true }).click();
    await page.getByRole("button", { name: "Today", exact: true }).click();
    await page.getByRole("heading", { name: yesterday.activity!.title }).waitFor();
    await gateway.setMethodResponse("kids.activity.answer", {
      snapshot: nextDay,
      feedback: {
        questionId: "q1",
        correct: true,
        independent: false,
        explanation: "A wide leaf spreads its weight across the water.",
      },
    });
    await page.getByRole("button", { name: "A wide, flat leaf", exact: true }).click();
    await page.getByText("A wide leaf spreads its weight across the water.").waitFor();
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
    await page.getByRole("button", { name: "Today", exact: true }).click();
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
