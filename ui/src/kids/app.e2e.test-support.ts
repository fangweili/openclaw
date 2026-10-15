/** Shared synthetic identity, compiled-app preview, and retained visual-proof lifecycle. */
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { chromium, type Page } from "playwright";
import { preview } from "vite";
import { createControlUiE2eArtifactDir } from "../test-helpers/control-ui-e2e-artifacts.ts";

export const sessionKey = "agent:student:kids:student-profile";
export const profile = {
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
export const roster = {
  defaultId: "student",
  mainKey: "main",
  scope: "per-sender",
  agents: [{ id: "student", identity: { name: "Rocky" } }],
};
// Headless Chromium denies Web Push even with a permission grant. Keep this
// fixture deterministic; subscription/delivery behavior has its own owner tests.
export function notificationPermissionFixture() {
  Object.defineProperty(Notification, "permission", {
    get: () =>
      sessionStorage.getItem("kids-test-block-notifications") === "1" ? "denied" : "default",
  });
}

/** Measure visible art and panel anchors at scroll-top with reduced motion enabled. */
export async function readKidsFrame(page: Page) {
  return page.locator(".kids-today:not([hidden])").evaluate((element) => {
    const pet = element.querySelector(".kids-pet-picture img")!.getBoundingClientRect();
    const panel = element
      .querySelector(".kids-home-content, .kids-activity-card")!
      .getBoundingClientRect();
    return {
      pet: { x: pet.x, y: pet.y, width: pet.width, height: pet.height },
      panel: { x: panel.x, y: panel.y, width: panel.width },
    };
  });
}

/** Start one suite-owned browser and preview; callers close contexts before joining close(). */
export async function startKidsE2e(scope: string) {
  const server = await preview({
    configFile: path.resolve("ui/vite.kids.config.ts"),
    preview: { host: "127.0.0.1", port: 0, strictPort: false },
  });
  const closeServer = () =>
    new Promise<void>((resolve, reject) => {
      server.httpServer.close((error) => (error ? reject(error) : resolve()));
    });
  try {
    const address = server.httpServer.address();
    if (!address || typeof address === "string") {
      throw new Error("Kids preview did not bind a TCP port");
    }
    const proof = createControlUiE2eArtifactDir(scope);
    const examples: Array<{ id: string; label: string }> = [];
    const browser = await chromium.launch({
      headless: true,
      args: ["--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream"],
    });
    let closing: Promise<void> | null = null;
    return {
      browser,
      proof,
      examples,
      baseUrl: `http://127.0.0.1:${address.port}/kids/`,
      /** Write all captured proof and join both resources even if one cleanup fails. */
      close() {
        closing ??= Promise.allSettled([
          writeFile(
            path.join(proof, "gallery.html"),
            String.raw`<!doctype html><meta charset="utf-8"><title>Rocky preview</title><style>body{font:16px system-ui;margin:32px;background:#f7f8f5;color:#26372b}main{display:grid;grid-template-columns:repeat(auto-fit,minmax(320px,1fr));gap:28px}section{background:white;padding:20px;border-radius:16px}img{max-width:100%;max-height:750px;object-fit:contain;display:block;margin:auto}textarea{box-sizing:border-box;width:100%;min-height:90px;margin-top:8px}button{padding:12px 20px;margin:16px 0}</style><h1>Rocky for kids</h1><p>Static captures from the real app with synthetic conversations. Feedback stays in this browser.</p><button id="copy">Copy feedback</button><main>${examples.map(({ id, label }) => `<section><h2>${label}</h2><img src="${id}.png" alt="${label}"><label for="${id}">Feedback: ${label}</label><textarea id="${id}"></textarea></section>`).join("")}</main><script>const key=${JSON.stringify(`rocky-${scope}-feedback-v1`)};let saved={};try{saved=JSON.parse(localStorage.getItem(key)||'{}')}catch{}for(const field of document.querySelectorAll('textarea')){field.value=saved[field.id]||'';field.oninput=()=>{saved[field.id]=field.value;localStorage.setItem(key,JSON.stringify(saved))}}document.querySelector('#copy').onclick=async()=>{const text=Array.from(document.querySelectorAll('textarea')).map(x=>'## '+x.id+' — '+x.closest('section').querySelector('h2').textContent+'\n'+x.value).join('\n\n');try{await navigator.clipboard.writeText(text);document.querySelector('#copy').textContent='Copied'}catch{const field=document.createElement('textarea');field.value=text;document.body.append(field);field.select();document.execCommand('copy');field.remove()}}</script>`,
          ),
          browser.close(),
          closeServer(),
        ]).then((results) => {
          const failed = results.filter((result) => result.status === "rejected");
          if (failed.length) {
            throw new AggregateError(
              failed.map((result) => result.reason),
              "Kids E2E cleanup failed",
            );
          }
        });
        return closing;
      },
    };
  } catch (error) {
    try {
      await closeServer();
    } catch (cleanupError) {
      throw new AggregateError([error, cleanupError], "Kids E2E startup and cleanup failed", {
        cause: cleanupError,
      });
    }
    throw error;
  }
}
