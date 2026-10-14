// @vitest-environment node
import fs from "node:fs";
import vm from "node:vm";
import { describe, expect, it, vi } from "vitest";

type WorkerEvent = {
  data?: unknown;
  notification?: { close: () => void; data: unknown };
  waitUntil: (completion: Promise<unknown>) => void;
};

function workerFixture(existingUrl = "https://family.example/kids/") {
  const listeners = new Map<string, (event: WorkerEvent) => void>();
  const existing = { url: existingUrl, focus: vi.fn(async () => undefined), postMessage: vi.fn() };
  const showNotification = vi.fn(async () => undefined);
  const clients = {
    claim: vi.fn(async () => undefined),
    matchAll: vi.fn(async () => [existing]),
    openWindow: vi.fn(async () => undefined),
  };
  const context = vm.createContext({
    URL,
    self: {
      location: { origin: "https://family.example" },
      addEventListener: (name: string, callback: (event: WorkerEvent) => void) =>
        listeners.set(name, callback),
      skipWaiting: vi.fn(async () => undefined),
      clients,
      registration: { showNotification },
    },
  });
  new vm.Script(
    fs.readFileSync(new URL("../../kids/public/sw.js", import.meta.url), "utf8"),
  ).runInContext(context);
  return {
    listeners,
    existing,
    clients,
    showNotification,
    async dispatch(name: string, data: Partial<WorkerEvent>) {
      let completion: Promise<unknown> | undefined;
      listeners.get(name)!({
        ...data,
        waitUntil: (value) => {
          completion = value;
        },
      });
      await completion;
    },
  };
}

describe("kids private notification worker", () => {
  it("ignores all incoming content and has no fetch or cache handler", async () => {
    const f = workerFixture();
    await f.dispatch("push", {
      data: {
        title: "private child name",
        body: "private conversation",
        url: "https://untrusted.example/",
      },
    });
    expect(f.showNotification).toHaveBeenCalledWith("Rocky", {
      body: "Rocky has a reply for you",
      icon: "/kids/rocky.svg",
      tag: "rocky-reply",
    });
    expect(f.listeners.has("fetch")).toBe(false);
    expect([...f.listeners.keys()]).toEqual(["install", "activate", "push", "notificationclick"]);
  });

  it.each([
    "https://family.example/kids/",
    "https://family.example/kids/#solve",
    "https://family.example/",
    "https://untrusted.example/kids/",
  ])("opens only the kids destination when an existing window is %s", async (existing) => {
    const f = workerFixture(existing);
    const close = vi.fn();
    await f.dispatch("notificationclick", {
      notification: { close, data: { url: "https://untrusted.example/private" } },
    });
    expect(close).toHaveBeenCalledOnce();
    if (existing.startsWith("https://family.example/kids/")) {
      expect(f.existing.postMessage).toHaveBeenCalledWith({ type: "kids:navigate", hash: "#chat" });
      expect(f.existing.focus).toHaveBeenCalledOnce();
      expect(f.clients.openWindow).not.toHaveBeenCalled();
    } else {
      expect(f.clients.openWindow).toHaveBeenCalledWith("https://family.example/kids/#chat");
      expect(f.existing.focus).not.toHaveBeenCalled();
    }
  });
});
