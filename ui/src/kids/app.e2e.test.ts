import { writeFile } from "node:fs/promises";
/** Browser boundary proof with a synthetic Gateway; no live conversations or providers. */
import path from "node:path";
import { chromium, type Browser } from "playwright";
import { preview, type PreviewServer } from "vite";
import { afterAll, beforeAll, expect, it } from "vitest";
import { createControlUiE2eArtifactDir } from "../test-helpers/control-ui-e2e-artifacts.ts";
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

    await page.getByLabel("Message Rocky", { exact: true }).fill("Can we try a fraction puzzle?");
    await page.getByRole("button", { name: "Send message" }).click();
    const request = await gateway.waitForRequest("chat.send");
    const params = request.params as Record<string, unknown>;
    expect(params.sessionKey).toBe(sessionKey);
    expect(params.message).toBe("Can we try a fraction puzzle?");
    expect(params.model).toBeUndefined();
    expect(params.thinkingLevel).toBeUndefined();
    expect(params.deliver).toBe(false);
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
    await gateway.setHistoryMessages([
      {
        __openclaw: { id: "input-1", seq: 1, idempotencyKey: String(params.idempotencyKey) },
        role: "user",
        content: [{ type: "text", text: "Can we try a fraction puzzle?" }],
      },
      {
        __openclaw: { id: "reply-1", seq: 2, runId: String(params.idempotencyKey) },
        role: "assistant",
        channel: "final",
        content: [{ type: "text", text: answer }],
      },
    ]);
    await gateway.emitChatFinal({ runId: String(params.idempotencyKey), sessionKey, text: answer });
    await page.getByText(answer).waitFor();
    expect(await page.getByText(answer).count()).toBe(1);
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
