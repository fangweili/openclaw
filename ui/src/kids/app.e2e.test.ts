import { writeFile } from "node:fs/promises";
/** Browser boundary proof with a synthetic Gateway; no live conversations or providers. */
import path from "node:path";
import { chromium, type Browser } from "playwright";
import { preview, type PreviewServer } from "vite";
import { afterAll, beforeAll, expect, it } from "vitest";
import { createControlUiE2eArtifactDir } from "../test-helpers/control-ui-e2e-artifacts.ts";
import type { MockGatewayWindow } from "../test-helpers/control-ui-e2e-contract.ts";
import { installMockGateway, startControlUiE2eServer } from "../test-helpers/control-ui-e2e.ts";

const sessionKey = "agent:student:kids:student-profile";
const profile = {
  id: "student-profile",
  displayName: "Alex",
  emails: ["student@example.test"],
  avatarMime: null,
  mergedInto: null,
  createdAt: 1,
  updatedAt: 1,
  githubIdentity: null,
  hasAvatar: false,
  role: "student",
  effectiveRole: "student",
};
const roster = {
  defaultId: "student",
  mainKey: "main",
  scope: "per-sender",
  agents: [{ id: "student", identity: { name: "Rocky" } }],
};
let browser: Browser;
let server: PreviewServer;
let baseUrl: string;
let proof: string;
const examples: Array<{ id: string; label: string }> = [];

// Headless Chromium denies Web Push even with a permission grant. Keep this
// fixture deterministic; subscription/delivery behavior has its own owner tests.
function notificationPermissionFixture() {
  Object.defineProperty(Notification, "permission", {
    get: () =>
      sessionStorage.getItem("kids-test-block-notifications") === "1" ? "denied" : "default",
  });
}

beforeAll(async () => {
  server = await preview({
    configFile: path.resolve("ui/vite.kids.config.ts"),
    preview: { host: "127.0.0.1", port: 0, strictPort: false },
  });
  const address = server.httpServer.address();
  if (!address || typeof address === "string") {
    throw new Error("Kids preview did not bind a TCP port");
  }
  baseUrl = `http://127.0.0.1:${address.port}/kids/`;
  proof = createControlUiE2eArtifactDir("kids-app");
  browser = await chromium.launch({
    headless: true,
    args: ["--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream"],
  });
});

afterAll(async () => {
  if (proof) {
    await writeFile(
      path.join(proof, "gallery.html"),
      String.raw`<!doctype html><meta charset="utf-8"><title>Rocky preview</title><style>body{font:16px system-ui;margin:32px;background:#f7f8f5;color:#26372b}main{display:grid;grid-template-columns:repeat(auto-fit,minmax(320px,1fr));gap:28px}section{background:white;padding:20px;border-radius:16px}img{max-width:100%;max-height:750px;object-fit:contain;display:block;margin:auto}textarea{box-sizing:border-box;width:100%;min-height:90px;margin-top:8px}button{padding:12px 20px;margin:16px 0}</style><h1>Rocky for kids</h1><p>Static captures from the real app with synthetic conversations. Feedback stays in this browser.</p><button id="copy">Copy feedback</button><main>${examples.map(({ id, label }) => `<section><h2>${label}</h2><img src="${id}.png" alt="${label}"><label for="${id}">Feedback: ${label}</label><textarea id="${id}"></textarea></section>`).join("")}</main><script>const key='rocky-gallery-feedback-v1';let saved={};try{saved=JSON.parse(localStorage.getItem(key)||'{}')}catch{}for(const field of document.querySelectorAll('textarea')){field.value=saved[field.id]||'';field.oninput=()=>{saved[field.id]=field.value;localStorage.setItem(key,JSON.stringify(saved))}}document.querySelector('#copy').onclick=async()=>{const text=Array.from(document.querySelectorAll('textarea')).map(x=>'## '+x.id+' — '+x.closest('section').querySelector('h2').textContent+'\n'+x.value).join('\n\n');try{await navigator.clipboard.writeText(text);document.querySelector('#copy').textContent='Copied'}catch{const field=document.createElement('textarea');field.value=text;document.body.append(field);field.select();document.execCommand('copy');field.remove()}}</script>`,
    );
  }
  await browser?.close();
  await new Promise<void>((resolve, reject) => {
    server?.httpServer.close((error) => (error ? reject(error) : resolve()));
  });
});

it("opens only the owned tutor, sends text, hides controls and internal events", async () => {
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
  });
  try {
    await context.addInitScript(notificationPermissionFixture);
    const page = await context.newPage();
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    const gateway = await installMockGateway(page, {
      awaitInitialRoster: false,
      sessionKey,
      operatorScopes: ["operator.sessions.write", "operator.talk"],
      historyMessages: [
        {
          role: "assistant",
          content: [{ type: "text", text: "Hey Alex! What would you like to explore today?" }],
        },
      ],
      methodResponses: {
        "users.self": { profile },
        "agents.list": roster,
        "sessions.create": { key: sessionKey },
        "chat.history": {
          sessionId: "student-session",
          sessionInfo: { sessionId: "student-session", activeLeafEntryId: "initial-leaf" },
          messages: [
            {
              role: "assistant",
              content: [{ type: "text", text: "Hey Alex! What would you like to explore today?" }],
            },
          ],
        },
      },
    });
    await page.goto(`${baseUrl}?agent=other&session=secret`);
    await page
      .getByText("Hey Alex! What would you like to explore today?")
      .waitFor({ timeout: 10_000 })
      .catch(async (error: unknown) => {
        console.info("Kids boot diagnostic", {
          body: await page.locator("body").textContent(),
          errors,
          requests: (await gateway.getRequests()).map((row) => row.method),
        });
        throw error;
      });
    expect(await page.getByRole("heading", { name: "Rocky", exact: true }).count()).toBe(1);
    expect(await page.locator("select").count()).toBe(0);
    expect(await page.getByRole("button", { name: /model|session|settings|tools/i }).count()).toBe(
      0,
    );
    expect((await gateway.getRequests("sessions.create"))[0]?.params).toEqual({
      key: sessionKey,
      agentId: "student",
      displayName: "Rocky",
    });

    await gateway.deferNext("chat.send");
    await page.getByLabel("Message Rocky", { exact: true }).fill("Can we try a fraction puzzle?");
    await page.getByRole("button", { name: "Send message" }).click();
    const request = await gateway.waitForRequest("chat.send");
    const params = request.params as Record<string, unknown>;
    expect(params.sessionKey).toBe(sessionKey);
    expect(params.message).toBe("Can we try a fraction puzzle?");
    expect(params.model).toBeUndefined();
    expect(params.thinkingLevel).toBeUndefined();
    expect(params.deliver).toBe(false);
    const historyCount = await gateway.deferNext("chat.history");
    await gateway.resolveDeferred("chat.send", { runId: params.idempotencyKey, status: "started" });
    await gateway.waitForRequest("chat.history", { after: historyCount });
    const pendingHistory = {
      sessionId: "student-session",
      sessionInfo: { sessionId: "student-session", activeLeafEntryId: "initial-leaf" },
      messages: [
        {
          role: "assistant",
          content: [{ type: "text", text: "Hey Alex! What would you like to explore today?" }],
        },
      ],
      inFlightRun: { runId: params.idempotencyKey },
      pendingInputs: {
        total: 1,
        items: [
          {
            id: "input-1",
            runId: params.idempotencyKey,
            acceptedAt: 1,
            state: "queued",
            message: {
              role: "user",
              content: [{ type: "text", text: "Can we try a fraction puzzle?" }],
              __openclaw: { id: "pending:input-1" },
            },
          },
        ],
      },
    };
    await gateway.setMethodResponse("chat.history", pendingHistory);
    await gateway.resolveDeferred("chat.history", pendingHistory);
    expect(await page.getByText("Can we try a fraction puzzle?", { exact: true }).count()).toBe(1);
    const persistedInput = {
      __openclaw: { id: "input-1", seq: 1, idempotencyKey: String(params.idempotencyKey) },
      role: "user",
      content: [{ type: "text", text: "Can we try a fraction puzzle?" }],
    };
    await gateway.emitGatewayEvent("session.message", {
      sessionKey,
      sessionId: "student-session",
      messageId: "input-1",
      messageSeq: 1,
      message: persistedInput,
    });
    expect(await page.getByText("Can we try a fraction puzzle?", { exact: true }).count()).toBe(1);
    await gateway.emitGatewayEvent("agent", {
      stream: "tool",
      sessionKey,
      data: { text: "PRIVATE TOOL OUTPUT" },
    });
    await gateway.emitGatewayEvent("chat", {
      state: "delta",
      sessionKey,
      runId: params.idempotencyKey,
      message: {
        role: "assistant",
        channel: "analysis",
        content: [{ type: "text", text: "PRIVATE REASONING" }],
      },
    });
    expect(await page.getByText(/PRIVATE TOOL OUTPUT|PRIVATE REASONING/).count()).toBe(0);
    const answer =
      "Absolutely. You have 3/4 of a pizza and share half of it. What fraction of a whole pizza did you share?";
    await gateway.setMethodResponse("chat.history", {
      ...pendingHistory,
      inFlightRun: undefined,
      pendingInputs: { total: 0, items: [] },
      sessionInfo: { sessionId: "student-session", activeLeafEntryId: "reply-1" },
    });
    await gateway.setHistoryMessages([
      persistedInput,
      {
        __openclaw: { id: "reply-1", seq: 2, runId: String(params.idempotencyKey) },
        role: "assistant",
        channel: "final",
        content: [{ type: "text", text: answer }],
      },
    ]);
    await gateway.emitChatFinal({ runId: String(params.idempotencyKey), sessionKey, text: answer });
    await page.getByText(answer).waitFor();
    const timings = await page.evaluate(() =>
      ["rocky.send.accepted", "rocky.send.finished"].map((name) => {
        const entries = performance.getEntriesByName(name, "measure");
        return { count: entries.length, duration: entries[0]?.duration };
      }),
    );
    expect(timings).toEqual([
      { count: 1, duration: expect.any(Number) },
      { count: 1, duration: expect.any(Number) },
    ]);
    expect(timings[1].duration).toBeGreaterThanOrEqual(timings[0].duration!);
    expect(await page.getByText(answer).count()).toBe(1);
    expect(await page.getByText("Can we try a fraction puzzle?", { exact: true }).count()).toBe(1);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    await page.screenshot({ path: path.join(proof, "kids-mobile.png"), fullPage: true });
    examples.push({ id: "kids-mobile", label: "Phone conversation" });
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.screenshot({ path: path.join(proof, "kids-desktop.png"), fullPage: true });
    examples.push({ id: "kids-desktop", label: "Laptop conversation" });
    expect(errors).toEqual([]);
    await page.evaluate(() => sessionStorage.setItem("kids-test-block-notifications", "1"));
    await page.setViewportSize({ width: 390, height: 844 });
    await page.reload();
    await page.getByText("Notifications are blocked.", { exact: false }).waitFor();
    await page.screenshot({ path: path.join(proof, "notifications-blocked.png"), fullPage: true });
    examples.push({ id: "notifications-blocked", label: "Notifications blocked by browser" });

    const beforeServer = await startControlUiE2eServer();
    const beforeContext = await browser.newContext({ viewport: { width: 390, height: 844 } });
    try {
      const before = await beforeContext.newPage();
      await installMockGateway(before, {
        historyMessages: [
          { role: "assistant", content: [{ type: "text", text: "Ready to learn together." }] },
        ],
        models: [],
      });
      await before.goto(`${beforeServer.baseUrl}chat`);
      await before.getByText("Ready to learn together.").waitFor();
      await before.screenshot({ path: path.join(proof, "admin-before.png"), fullPage: true });
      examples.push({ id: "admin-before", label: "Existing Control UI (comparison)" });
    } finally {
      await beforeContext.close();
      await beforeServer.close();
    }
  } finally {
    await context.close();
  }
});

it("stops before session creation for a shared or ambiguous login", async () => {
  const context = await browser.newContext();
  try {
    await context.addInitScript(notificationPermissionFixture);
    const page = await context.newPage();
    const gateway = await installMockGateway(page, {
      awaitInitialRoster: false,
      methodResponses: {
        "users.self": { profile },
        "agents.list": { ...roster, agents: [...roster.agents, { id: "another-child" }] },
      },
    });
    await page.goto(baseUrl);
    await page.getByText("Ask a parent to connect your own account to your Rocky tutor.").waitFor();
    expect(await gateway.getRequests("sessions.create")).toEqual([]);
    expect(await page.getByLabel("Message Rocky", { exact: true }).isDisabled()).toBe(true);
    await page.screenshot({ path: path.join(proof, "setup-required.png"), fullPage: true });
    examples.push({ id: "setup-required", label: "Account setup required" });
  } finally {
    await context.close();
  }
});

it("keeps learning links safe and retires a cancelled voice startup", async () => {
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
    permissions: ["microphone"],
  });
  try {
    await context.addInitScript(notificationPermissionFixture);
    const page = await context.newPage();
    const gateway = await installMockGateway(page, {
      awaitInitialRoster: false,
      sessionKey,
      operatorScopes: ["operator.sessions.write", "operator.talk"],
      deferredMethods: ["talk.client.create"],
      methodResponses: {
        "users.self": { profile },
        "agents.list": roster,
        "sessions.create": { key: sessionKey },
        "chat.history": {
          sessionId: "student-session",
          sessionInfo: { sessionId: "student-session", activeLeafEntryId: null },
          messages: [],
        },
      },
    });
    await page.goto(baseUrl);
    await page.getByRole("heading", { name: "What’s on your mind?" }).waitFor();
    await page.screenshot({ path: path.join(proof, "welcome.png"), fullPage: true });
    examples.push({ id: "welcome", label: "First conversation" });
    await page.getByRole("button", { name: "Talk to Rocky" }).click();
    const voiceRequest = await gateway.waitForRequest("talk.client.create");
    expect((voiceRequest.params as Record<string, unknown>).sessionKey).toBe(sessionKey);
    expect((voiceRequest.params as Record<string, unknown>).model).toBeUndefined();
    await page.getByRole("button", { name: "End call" }).waitFor();
    await page.screenshot({ path: path.join(proof, "voice-starting.png"), fullPage: true });
    examples.push({ id: "voice-starting", label: "Starting live voice" });
    await page.getByRole("button", { name: "End call" }).click();
    await gateway.rejectDeferred("talk.client.create", {
      code: "UNAVAILABLE",
      message: "Synthetic cancelled startup",
    });
    await page.getByRole("button", { name: "Talk to Rocky" }).waitFor();

    const text =
      "Let’s work through this together.\n\n[Settings](/settings) · [Another session](/chat/other) · [Learn fractions](https://example.org/fractions)\n\n**One step at a time.**\n\n" +
      "A long learning explanation stays readable on a small phone. ".repeat(25);
    await gateway.setHistoryMessages([
      {
        __openclaw: { id: "long-reply", seq: 1 },
        role: "assistant",
        channel: "final",
        content: [{ type: "text", text }],
      },
    ]);
    await gateway.emitChatFinal({ sessionKey, runId: "external-reply", text });
    await page.getByRole("link", { name: "Learn fractions" }).waitFor();
    expect(await page.getByRole("link", { name: "Settings", exact: true }).count()).toBe(0);
    expect(await page.getByRole("link", { name: "Another session" }).count()).toBe(0);
    expect(await page.getByRole("link", { name: "Learn fractions" }).getAttribute("target")).toBe(
      "_blank",
    );
    await page.setViewportSize({ width: 320, height: 780 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    await page.screenshot({ path: path.join(proof, "long-reply.png"), fullPage: true });
    examples.push({ id: "long-reply", label: "Long reply on a small phone" });
  } finally {
    await context.close();
  }
});

it("previews photos and videos, sends without text, and keeps mobile focus on the rounded composer", async () => {
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
    hasTouch: true,
    isMobile: true,
  });
  try {
    await context.addInitScript(notificationPermissionFixture);
    const page = await context.newPage();
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    const gateway = await installMockGateway(page, {
      awaitInitialRoster: false,
      sessionKey,
      operatorScopes: ["operator.sessions.write", "operator.talk"],
      deferredMethods: ["chat.send"],
      methodResponses: {
        "users.self": { profile },
        "agents.list": roster,
        "sessions.create": { key: sessionKey },
        "chat.history": {
          sessionId: "student-session",
          sessionInfo: { sessionId: "student-session", activeLeafEntryId: "leaf-one" },
          messages: [],
        },
      },
    });
    await page.goto(baseUrl);
    const composer = page.getByLabel("Message Rocky", { exact: true });
    await page.getByRole("heading", { name: "What’s on your mind?" }).waitFor();
    await page
      .locator("#kids-files")
      .setInputFiles([
        path.resolve("ui/kids/public/rocky-192.png"),
        path.resolve("ui/src/e2e/fixtures/video-poster.mp4"),
      ]);
    await page.locator(".kids-attachment img").waitFor();
    await page.locator(".kids-attachment video").waitFor();
    await composer.tap();
    expect(await composer.evaluate((element) => getComputedStyle(element).outlineStyle)).toBe(
      "none",
    );
    expect(await composer.evaluate((element) => getComputedStyle(element).boxShadow)).toBe("none");
    expect(
      await page
        .locator(".kids-composer")
        .evaluate((element) => getComputedStyle(element).borderRadius),
    ).toBe("24px");
    expect(
      await page
        .locator(".kids-composer")
        .evaluate((element) => getComputedStyle(element).outlineStyle),
    ).toBe("solid");
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    await page.screenshot({ path: path.join(proof, "media-mobile-focus.png"), fullPage: true });
    examples.push({ id: "media-mobile-focus", label: "Photo and video drafts with mobile focus" });

    await page.getByRole("button", { name: "Remove: rocky-192.png", exact: true }).click();
    expect(await page.locator(".kids-attachment img").count()).toBe(0);
    await page.getByRole("button", { name: "Send message" }).click();
    const request = await gateway.waitForRequest("chat.send");
    const params = request.params as Record<string, unknown>;
    expect(params.message).toBe("");
    expect(params.deliver).toBe(false);
    expect(params.attachments).toEqual([
      expect.objectContaining({
        type: "file",
        mimeType: "video/mp4",
        fileName: "video-poster.mp4",
        content: expect.any(String),
      }),
    ]);
    expect(params.suppressCommandInterpretation).toBeUndefined();
    await page.locator("#kids-files").setInputFiles(path.resolve("ui/kids/public/rocky-192.png"));
    await page.locator(".kids-attachment img").waitFor();
    await composer.fill("My next question");
    await gateway.setHistoryMessages([
      {
        __openclaw: { id: "media-turn", idempotencyKey: String(params.idempotencyKey) },
        role: "user",
        content: [
          {
            type: "attachment",
            attachment: {
              url: "media://inbound/synthetic.mp4",
              kind: "video",
              label: "video-poster.mp4",
              mimeType: "video/mp4",
            },
          },
        ],
      },
      {
        __openclaw: { id: "media-reply" },
        role: "assistant",
        content: [{ type: "text", text: "Let’s look at your experiment together." }],
      },
    ]);
    await gateway.resolveDeferred("chat.send", { runId: params.idempotencyKey, status: "started" });
    await page.getByText("Let’s look at your experiment together.").waitFor();
    expect(await page.locator(".kids-attachment video").count()).toBe(0);
    expect(await page.locator(".kids-attachment img").count()).toBe(1);
    expect(await composer.inputValue()).toBe("My next question");
    expect(await page.locator(".kids-message--user .kids-media-tile").textContent()).toContain(
      "Video",
    );
    expect(await page.locator(".kids-message--user button").count()).toBe(0);
    await page.screenshot({ path: path.join(proof, "media-sent.png"), fullPage: true });
    examples.push({ id: "media-sent", label: "Sent video and later photo draft" });
    await page.getByRole("button", { name: "Add photos or short videos", exact: true }).focus();
    await page.keyboard.press("Tab");
    expect(await composer.evaluate((element) => document.activeElement === element)).toBe(true);
    expect(await composer.evaluate((element) => getComputedStyle(element).outlineStyle)).toBe(
      "none",
    );
    expect(
      await page
        .locator(".kids-composer")
        .evaluate((element) => getComputedStyle(element).outlineStyle),
    ).toBe("solid");
    await page.screenshot({ path: path.join(proof, "media-keyboard-focus.png"), fullPage: true });
    examples.push({ id: "media-keyboard-focus", label: "Accessible rounded keyboard focus" });
    expect(errors).toEqual([]);
  } finally {
    await context.close();
  }
});

it("records dictation into an editable draft and sends only on request", async () => {
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
  });
  try {
    await context.addInitScript(notificationPermissionFixture);
    // Observe the actual browser recorder, so finish cannot race microphone startup.
    await context.addInitScript(() => {
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
    const gateway = await installMockGateway(page, {
      awaitInitialRoster: false,
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
      },
    });
    await page.goto(baseUrl);
    await page.getByRole("heading", { name: "What’s on your mind?" }).waitFor();
    await page.getByRole("button", { name: "Dictate a message" }).click();
    await page.waitForFunction(() => document.documentElement.dataset.recorderStarted === "true");
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
    const composer = page.getByLabel("Message Rocky", { exact: true });
    await page.waitForFunction(
      () =>
        document.querySelector<HTMLTextAreaElement>("textarea")?.value ===
        "Can we practice fractions?",
    );
    expect(await gateway.getRequests("chat.send")).toHaveLength(0);
    await composer.fill("Can we practice fractions together?");
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

it("reopens media and unsent text without changing tutor or notification settings", async () => {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
  try {
    await context.addInitScript(() => {
      Object.defineProperty(Notification, "permission", { get: () => "granted" });
      const subscription = {
        endpoint: "https://push.example.test/kids",
        options: { applicationServerKey: Uint8Array.from([4, 1, 2, 3]).buffer },
        toJSON: () => ({
          endpoint: "https://push.example.test/kids",
          keys: { p256dh: "fixture-key", auth: "fixture-auth" },
        }),
      };
      Object.defineProperty(navigator, "serviceWorker", {
        value: {
          register: async () => ({
            active: { state: "activated" },
            pushManager: { getSubscription: async () => subscription },
          }),
        },
      });
    });
    const page = await context.newPage();
    const media = [
      {
        id: "artifact_transcript_media_photo",
        kind: "image",
        mime: "image/png",
        name: "My photo",
        path: "ui/kids/public/rocky-192.png",
      },
      {
        id: "artifact_transcript_media_video",
        kind: "video",
        mime: "video/mp4",
        name: "My experiment",
        path: "ui/src/e2e/fixtures/video-poster.mp4",
      },
      {
        id: "artifact_transcript_image_answer",
        kind: "image",
        mime: "image/png",
        name: "Rocky's diagram",
        path: "ui/kids/public/rocky-192.png",
      },
    ];
    for (const item of media) {
      await page.route(`**/api/artifacts/download/fixture/${item.id}`, (route) =>
        route.fulfill({
          path: path.resolve(item.path),
          contentType: item.mime,
          headers: { "content-disposition": "attachment" },
        }),
      );
    }
    const messages = [
      {
        role: "user",
        content: [{ type: "text", text: "Here is my experiment." }],
        __openclaw: {
          id: "upload-one",
          media: media.slice(0, 2).map((item) => ({
            kind: item.kind,
            contentType: item.mime,
            fileName: item.name,
            url: `media://inbound/${item.id}`,
            artifactId: item.id,
          })),
        },
      },
      {
        role: "assistant",
        channel: "final",
        __openclaw: { id: "answer-one" },
        content: [
          {
            type: "image",
            artifactId: media[2].id,
            mimeType: "image/png",
            fileName: media[2].name,
          },
        ],
      },
    ];
    const gateway = await installMockGateway(page, {
      awaitInitialRoster: false,
      sessionKey,
      operatorScopes: ["operator.sessions.write", "operator.talk"],
      historyMessages: messages,
      methodResponses: {
        "users.self": { profile },
        "agents.list": roster,
        "sessions.create": { key: sessionKey },
        "chat.history": {
          sessionId: "student-session",
          sessionInfo: { sessionId: "student-session", activeLeafEntryId: "answer-one" },
          messages,
        },
        "artifacts.download": {
          cases: media.map((item) => ({
            match: { artifactId: item.id, sessionKey, agentId: "student" },
            response: {
              artifact: { id: item.id, type: item.kind, mimeType: item.mime },
              url: `/api/artifacts/download/fixture/${item.id}`,
            },
          })),
        },
        "push.web.vapidPublicKey": { vapidPublicKey: "BAECAw" },
        "push.web.preferences.get": { device: { enabled: true, label: "Rocky" } },
      },
    });
    await page.goto(baseUrl);
    const diagram = page.getByRole("img", { name: "Rocky's diagram", exact: true });
    await diagram.waitFor();
    await diagram.evaluate((element: HTMLImageElement) => element.decode());
    expect(
      await page
        .locator(".kids-thread")
        .evaluate((element) => element.scrollHeight - element.clientHeight - element.scrollTop),
    ).toBeLessThan(4);
    // Browse older media after checking the latest reply stays visible as it loads.
    await page.locator(".kids-message--user .kids-media-preview").first().scrollIntoViewIfNeeded();
    const image = page.getByRole("img", { name: "My photo", exact: true });
    await image.waitFor();
    await image.evaluate((element: HTMLImageElement) => element.decode());
    const video = page.locator(".kids-media-preview video");
    await video.waitFor();
    expect(await video.getAttribute("preload")).toBe("none");
    expect(await video.getAttribute("autoplay")).toBeNull();
    await video.evaluate(async (element: HTMLVideoElement) => {
      element.muted = true;
      await element.play();
      element.pause();
      if (!element.videoWidth) {
        throw new Error("The saved video did not decode");
      }
    });
    const status = page.locator(".kids-notifications-on");
    await status.waitFor();
    await status.click();
    expect(await page.getByRole("button", { name: /notifications/i }).count()).toBe(0);
    expect(await gateway.getRequests("push.web.unsubscribe")).toHaveLength(0);
    const composer = page.getByLabel("Message Rocky", { exact: true });
    await composer.fill("Can we try a different experiment tomorrow?");
    // Read after the input task's microtasks have admitted the write. IndexedDB
    // orders this read behind it; no sleep or draft implementation test hook.
    const saved = await page.evaluate(async () => {
      const opening = indexedDB.open("openclaw-control-ui");
      const db = await new Promise<IDBDatabase>((resolve, reject) => {
        opening.addEventListener("success", () => resolve(opening.result));
        opening.addEventListener("error", () =>
          reject(opening.error ?? new Error("Cannot open the draft database")),
        );
      });
      try {
        const read = db.transaction("composerDrafts").objectStore("composerDrafts").getAll();
        return await new Promise<string[]>((resolve, reject) => {
          read.addEventListener("success", () => resolve(read.result.map((draft) => draft.text)));
          read.addEventListener("error", () =>
            reject(read.error ?? new Error("Cannot read saved drafts")),
          );
        });
      } finally {
        db.close();
      }
    });
    expect(saved).toContain("Can we try a different experiment tomorrow?");
    await page.reload();
    await composer.waitFor();
    await page.waitForFunction(
      () =>
        document.querySelector<HTMLTextAreaElement>("#kids-message")?.value ===
        "Can we try a different experiment tomorrow?",
    );
    await page.getByRole("img", { name: "Rocky's diagram", exact: true }).waitFor();
    expect(await gateway.getRequests("chat.send")).toHaveLength(0);
    expect(await gateway.getRequests("push.web.unsubscribe")).toHaveLength(0);
    await page.screenshot({ path: path.join(proof, "media-history-draft.png"), fullPage: true });
    examples.push({
      id: "media-history-draft",
      label: "Saved media, restored draft, notifications on",
    });
  } finally {
    await context.close();
  }
});

it("pages a long conversation without moving the reader and returns to the latest reply", async () => {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
  try {
    await context.addInitScript(notificationPermissionFixture);
    const page = await context.newPage();
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    const exchange = [
      "You have 3/4 of a pizza. If you share half, how much of the whole pizza did you share?",
      "I think I shared 3/8.",
      "Yes! Each quarter becomes two eighths. Three of those eighths went to your friend.",
      "Can we use a number line for the next one?",
      "Let's mark 0, 1/2, and 1. Where would you put 3/4?",
      "Halfway between 1/2 and 1!",
    ];
    const messages = Array.from({ length: 600 }, (_, index) => ({
      role: index % 2 === 0 ? "assistant" : "user",
      content: [{ type: "text", text: exchange[index % exchange.length] }],
      __openclaw: { id: `history-${index + 1}`, seq: index + 1 },
    }));
    const historyPage = (offset: number, limit: number) => {
      const end = Math.max(0, messages.length - offset);
      const start = Math.max(0, end - limit);
      return {
        sessionId: "student-session",
        sessionInfo: {
          sessionId: "student-session",
          ...(offset === 0 ? { activeLeafEntryId: messages.at(-1)!["__openclaw"].id } : {}),
        },
        messages: messages.slice(start, end),
        totalMessages: messages.length,
        offset,
        hasMore: start > 0,
        nextOffset: messages.length - start,
      };
    };
    const gateway = await installMockGateway(page, {
      awaitInitialRoster: false,
      heldMethods: ["connect"],
      sessionKey,
      operatorScopes: ["operator.sessions.write", "operator.talk"],
      methodResponses: {
        "users.self": { profile },
        "agents.list": roster,
        "sessions.create": { key: sessionKey },
      },
    });
    await page.goto(baseUrl);
    await gateway.waitForRequest("connect");
    const serveHistory = async () => {
      await page.evaluate((entries) => {
        const fixture = (window as MockGatewayWindow).openclawControlUiE2eGateway;
        if (!fixture) {
          throw new Error("Kids history fixture is not installed");
        }
        fixture.setRequestHandler("chat.history", ({ params, respond }) => {
          const { offset = 0, limit = 80 } = params as { offset?: number; limit?: number };
          const end = Math.max(0, entries.length - offset);
          const start = Math.max(0, end - limit);
          respond({
            sessionId: "student-session",
            sessionInfo: {
              sessionId: "student-session",
              ...(offset === 0 ? { activeLeafEntryId: entries.at(-1)!["__openclaw"].id } : {}),
            },
            messages: entries.slice(start, end),
            totalMessages: entries.length,
            offset,
            hasMore: start > 0,
            nextOffset: entries.length - start,
          });
        });
      }, messages);
    };
    await serveHistory();
    await gateway.resolveDeferred("connect");
    const thread = page.locator(".kids-thread");
    const latest = page.getByRole("button", { name: "Jump to latest message" });
    await page.locator('[data-message-id="history-600"]').waitFor();
    expect(await page.locator(".kids-message").count()).toBe(80);
    expect(await latest.count()).toBe(0);
    const composer = page.getByLabel("Message Rocky", { exact: true });
    const draft = "Can we try a number line together?";
    await composer.fill(draft);

    const visibleAnchor = () =>
      thread.evaluate((element) => {
        const top = element.getBoundingClientRect().top;
        const row = [...element.querySelectorAll<HTMLElement>("[data-message-id]")].find(
          (message) => message.getBoundingClientRect().bottom > top,
        );
        if (!row) {
          throw new Error("No visible transcript message to anchor");
        }
        return { id: row.dataset.messageId!, offset: row.getBoundingClientRect().top - top };
      });
    const expectAnchor = async (anchor: { id: string; offset: number }) => {
      const offset = await page.locator(`[data-message-id="${anchor.id}"]`).evaluate((row) => {
        const scroll = row.closest(".kids-thread")!;
        return row.getBoundingClientRect().top - scroll.getBoundingClientRect().top;
      });
      expect(Math.abs(offset - anchor.offset)).toBeLessThan(2);
    };
    const expectBoundedRows = async () => {
      const ids = await page
        .locator(".kids-message")
        .evaluateAll((rows) => rows.map((row) => (row as HTMLElement).dataset.messageId));
      expect(ids.length).toBeLessThanOrEqual(320);
      expect(new Set(ids).size).toBe(ids.length);
      return ids;
    };

    // Hold each page while measuring the actual wheel-driven reading position.
    // Older pages omit branch authority, just like positive-offset Gateway reads.
    for (let pageNumber = 1; pageNumber <= 5; pageNumber += 1) {
      const after = await gateway.deferNext("chat.history");
      await thread.hover();
      await page.mouse.wheel(0, -100_000);
      const request = await gateway.waitForRequest("chat.history", { after });
      expect(request.params).toMatchObject({
        sessionKey,
        offset: pageNumber * 80,
        limit: 80,
        maxBytes: 256 * 1024,
      });
      await page.getByText("Loading earlier messages…", { exact: true }).waitFor();
      const anchor = await visibleAnchor();
      await gateway.resolveDeferred("chat.history", historyPage(pageNumber * 80, 80));
      await page.locator(`[data-message-id="history-${521 - pageNumber * 80}"]`).waitFor();
      await page
        .getByText("Loading earlier messages…", { exact: true })
        .waitFor({ state: "hidden" });
      await expectAnchor(anchor);
      const ids = await expectBoundedRows();
      expect(ids.length).toBe(Math.min(320, (pageNumber + 1) * 80));
    }
    await latest.waitFor();
    expect(await composer.inputValue()).toBe(draft);
    expect(await page.locator('[data-message-id="history-600"]').count()).toBe(0);

    // Programmatic positioning does not admit another page. At the historical
    // bottom, Latest must leave the forward paging button visible and tappable.
    await thread.evaluate((element) => {
      element.scrollTop = element.scrollHeight;
    });
    const newer = page.getByRole("button", { name: "Newer messages", exact: true });
    await newer.waitFor();
    const edgeBounds = await newer.boundingBox();
    const latestBounds = await latest.boundingBox();
    expect(edgeBounds).not.toBeNull();
    expect(latestBounds).not.toBeNull();
    expect(edgeBounds!.y + edgeBounds!.height).toBeLessThanOrEqual(latestBounds!.y);
    expect(
      await newer.evaluate((button) => {
        const bounds = button.getBoundingClientRect();
        return button.contains(
          document.elementFromPoint(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2),
        );
      }),
    ).toBe(true);
    await thread.evaluate(
      (element) =>
        new Promise<void>((resolve) => {
          element.addEventListener("scroll", () => resolve(), { once: true });
          element.scrollTop = element.scrollHeight - element.clientHeight - 200;
        }),
    );

    // Reverse direction after eviction: fetch the adjacent newer page, not the
    // live tail, and retain the exact visible row while the opposite edge trims.
    const newerAfter = await gateway.deferNext("chat.history");
    await thread.hover();
    await page.mouse.wheel(0, 100_000);
    const newerRequest = await gateway.waitForRequest("chat.history", { after: newerAfter });
    expect(newerRequest.params).toMatchObject({ offset: 80, limit: 80 });
    await page.getByText("Loading newer messages…", { exact: true }).waitFor();
    const beforeNewer = await visibleAnchor();
    await gateway.resolveDeferred("chat.history", historyPage(80, 80));
    await page.locator('[data-message-id="history-520"]').waitFor();
    await page.getByText("Loading newer messages…", { exact: true }).waitFor({ state: "hidden" });
    await expectAnchor(beforeNewer);
    const browsingIds = await expectBoundedRows();
    expect(browsingIds[0]).toBe("history-201");
    expect(browsingIds.at(-1)).toBe("history-520");

    const reply = {
      role: "assistant",
      content: [
        { type: "text", text: "Your next challenge is ready: place 5/8 on a number line." },
      ],
      __openclaw: { id: "history-601", seq: 601 },
    };
    messages.push(reply);
    await serveHistory();
    const refreshAfter = await gateway.deferNext("chat.history");
    const beforeReply = await visibleAnchor();
    await gateway.emitGatewayEvent("session.message", {
      sessionKey,
      sessionId: "student-session",
      messageId: reply["__openclaw"].id,
      messageSeq: reply["__openclaw"].seq,
      message: reply,
    });
    await gateway.waitForRequest("chat.history", { after: refreshAfter });
    await gateway.resolveDeferred("chat.history", historyPage(0, 80));
    await expectAnchor(beforeReply);
    expect(await expectBoundedRows()).toEqual(browsingIds);
    expect(await page.getByText(reply.content[0].text, { exact: true }).count()).toBe(0);
    expect(await composer.inputValue()).toBe(draft);
    await page.screenshot({ path: path.join(proof, "history-latest-mobile.png"), fullPage: true });
    examples.push({ id: "history-latest-mobile", label: "Reading earlier messages with Latest" });

    await latest.click();
    await page.getByText(reply.content[0].text, { exact: true }).waitFor();
    await latest.waitFor({ state: "hidden" });
    const tailIds = await expectBoundedRows();
    expect(tailIds).toHaveLength(80);
    expect(tailIds[0]).toBe("history-522");
    expect(tailIds.at(-1)).toBe("history-601");
    expect(
      await thread.evaluate(
        (element) => element.scrollHeight - element.clientHeight - element.scrollTop,
      ),
    ).toBeLessThan(2);
    expect(await composer.inputValue()).toBe(draft);
    expect(await gateway.getRequests("chat.send")).toHaveLength(0);
    // Browsing old pages cannot replace the live branch used by the next send.
    await gateway.deferNext("chat.send");
    await page.getByRole("button", { name: "Send message" }).click();
    const send = await gateway.waitForRequest("chat.send");
    expect(send.params).toMatchObject({
      message: draft,
      sessionId: "student-session",
      expectedLeafEntryId: "history-601",
    });
    expect(errors).toEqual([]);
  } finally {
    await context.close();
  }
});
