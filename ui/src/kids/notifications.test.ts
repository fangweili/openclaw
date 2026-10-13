// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { WebPushDevicePreferences } from "../../../packages/gateway-protocol/src/schema/push.ts";
import { createDeferred } from "../../../test/helpers/promise.js";
import { createTestGatewayClient } from "../test-helpers/gateway-client.ts";
import { KidsNotifications } from "./notifications.ts";

function fixture() {
  let current: PushSubscription | null = null;
  let permission: NotificationPermission = "default";
  let preferences: WebPushDevicePreferences = { enabled: true, label: "" };
  const unsubscribe = vi.fn(async () => {
    current = null;
    return true;
  });
  const subscription = {
    endpoint: "https://push.example.test/kids",
    options: { applicationServerKey: Uint8Array.from([4, 1, 2, 3]).buffer },
    toJSON: () => ({
      endpoint: "https://push.example.test/kids",
      keys: { p256dh: "fixture-key", auth: "fixture-auth" },
    }),
    unsubscribe,
  } as unknown as PushSubscription;
  const subscribe = vi.fn(async () => {
    current = subscription;
    return subscription;
  });
  const registration = {
    active: { state: "activated" },
    pushManager: { getSubscription: vi.fn(async () => current), subscribe },
  } as unknown as ServiceWorkerRegistration;
  const register = vi.fn(async () => registration);
  const getRegistration = vi.fn();
  const requestPermission = vi.fn(async (): Promise<NotificationPermission> => {
    permission = "granted";
    return permission;
  });
  vi.stubGlobal("navigator", {
    userAgent: "Fixture browser",
    platform: "",
    maxTouchPoints: 0,
    serviceWorker: { register, getRegistration },
  });
  vi.stubGlobal("Notification", {
    get permission() {
      return permission;
    },
    requestPermission,
  });
  vi.stubGlobal("PushManager", vi.fn());
  const request = vi.fn(async (method: string, params?: unknown): Promise<unknown> => {
    if (method === "push.web.vapidPublicKey") {
      return { vapidPublicKey: "BAECAw" };
    }
    if (method === "push.web.preferences.get") {
      return { device: preferences };
    }
    if (method === "push.web.preferences.set") {
      preferences = (params as { preferences: WebPushDevicePreferences }).preferences;
    }
    return {};
  });
  const onState = vi.fn();
  const hasFocus = vi.spyOn(document, "hasFocus").mockReturnValue(true);
  vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
  const owner = new KidsNotifications(
    createTestGatewayClient(request),
    "tutor",
    "agent:tutor:kids:fixture",
    onState,
  );
  return {
    owner,
    hasFocus,
    request,
    onState,
    registration,
    register,
    getRegistration,
    requestPermission,
    subscribe,
    unsubscribe,
    subscription,
    existing: (enabled = true) => {
      current = subscription;
      preferences.enabled = enabled;
      permission = "granted";
    },
    deny: () => {
      permission = "denied";
    },
  };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("kids notifications", () => {
  it("prompts within the click and uses only the kids registration with private tutor preferences", async () => {
    const f = fixture();
    try {
      await f.owner.initialize();
      expect(f.owner.state.status).toBe("off");
      expect(f.requestPermission).not.toHaveBeenCalled();
      const enabling = f.owner.enable();
      expect(f.requestPermission).toHaveBeenCalledOnce();
      await enabling;
      expect(f.register).toHaveBeenCalledWith("/kids/sw.js", { scope: "/kids/" });
      expect(f.getRegistration).not.toHaveBeenCalled();
      expect(f.owner.state.status).toBe("enabled");
      expect(f.request).toHaveBeenCalledWith("push.web.preferences.set", {
        endpoint: f.subscription.endpoint,
        scope: "device",
        preferences: {
          enabled: true,
          label: "Rocky",
          detailLevel: "private",
          agentIds: ["tutor"],
          categories: {
            approvalRequested: false,
            agentFinished: true,
            agentQuestion: false,
            humanMentioned: false,
            scheduledTaskFailed: false,
          },
        },
      });
      expect(f.request.mock.calls.some(([method]) => method === "push.web.test")).toBe(false);
      expect(f.unsubscribe).not.toHaveBeenCalled();
    } finally {
      await f.owner.dispose();
    }
  });

  it("reconciles an existing device without prompting or overriding its disabled preference", async () => {
    const f = fixture();
    f.existing(false);
    try {
      await f.owner.initialize();
      expect(f.requestPermission).not.toHaveBeenCalled();
      expect(f.subscribe).not.toHaveBeenCalled();
      expect(f.request).toHaveBeenCalledWith("push.web.subscribe", f.subscription.toJSON());
      expect(f.owner.state.status).toBe("off");
      await f.owner.enable();
      expect(f.owner.state.status).toBe("enabled");
    } finally {
      await f.owner.dispose();
    }
  });

  it("joins a pending foreground claim on disposal without unsubscribing", async () => {
    const f = fixture();
    f.existing();
    const claiming = createDeferred();
    const claim = createDeferred();
    const request = f.request.getMockImplementation()!;
    f.request.mockImplementation(async (method, params) => {
      if (
        method === "push.web.foreground" &&
        (params as { sessionKey: string | null }).sessionKey
      ) {
        claiming.resolve();
        await claim.promise;
      }
      return request(method, params);
    });
    let initialized = false;
    const initializing = f.owner.initialize().then(() => {
      initialized = true;
    });
    let closing: Promise<void> | undefined;
    try {
      await claiming.promise;
      await vi.advanceTimersByTimeAsync(0);
      const readyBeforeClose = initialized;
      expect(f.owner.state.status).toBe("enabled");
      closing = f.owner.dispose();
      claim.resolve();
      await Promise.all([initializing, closing]);
      expect(f.unsubscribe).not.toHaveBeenCalled();
      expect(readyBeforeClose).toBe(true);
      const requests = f.request.mock.calls.map(([method, params]) => ({ method, params }));
      const clear = requests.findIndex(
        ({ method, params }) =>
          method === "push.web.foreground" &&
          (params as { sessionKey: string | null }).sessionKey === null,
      );
      expect(clear).toBeGreaterThanOrEqual(0);
      expect(requests.some(({ method }) => method === "push.web.unsubscribe")).toBe(false);
    } finally {
      claim.resolve();
      await Promise.all([initializing, closing]);
      await f.owner.dispose();
    }
    expect(vi.getTimerCount()).toBe(0);
  });

  it("keeps an on-screen tutor quiet without keyboard focus and restores alerts when hidden", async () => {
    const f = fixture();
    f.existing();
    f.hasFocus.mockReturnValue(false);
    await f.owner.initialize();
    expect(f.request).toHaveBeenCalledWith(
      "push.web.foreground",
      {
        endpoint: f.subscription.endpoint,
        sessionKey: "agent:tutor:kids:fixture",
      },
      expect.anything(),
    );
    f.request.mockClear();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(f.request).toHaveBeenCalledWith(
      "push.web.foreground",
      expect.objectContaining({
        sessionKey: "agent:tutor:kids:fixture",
      }),
      expect.anything(),
    );
    window.dispatchEvent(new Event("blur"));
    await vi.advanceTimersByTimeAsync(0);
    expect(f.request).toHaveBeenLastCalledWith(
      "push.web.foreground",
      {
        endpoint: f.subscription.endpoint,
        sessionKey: "agent:tutor:kids:fixture",
      },
      expect.anything(),
    );
    vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
    document.dispatchEvent(new Event("visibilitychange"));
    await vi.advanceTimersByTimeAsync(0);
    expect(f.request).toHaveBeenLastCalledWith(
      "push.web.foreground",
      {
        endpoint: f.subscription.endpoint,
        sessionKey: null,
      },
      expect.anything(),
    );
    f.request.mockClear();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(f.request).not.toHaveBeenCalled();
    vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
    document.dispatchEvent(new Event("visibilitychange"));
    await vi.advanceTimersByTimeAsync(0);
    expect(f.request).toHaveBeenLastCalledWith(
      "push.web.foreground",
      {
        endpoint: f.subscription.endpoint,
        sessionKey: "agent:tutor:kids:fixture",
      },
      expect.anything(),
    );
    await f.owner.dispose();
    expect(f.request).toHaveBeenLastCalledWith(
      "push.web.foreground",
      {
        endpoint: f.subscription.endpoint,
        sessionKey: null,
      },
      expect.anything(),
    );
    expect(vi.getTimerCount()).toBe(0);
  });

  it("restores alerts for a hidden tab and coalesces a hide during an outstanding claim", async () => {
    const f = fixture();
    f.existing();
    await f.owner.initialize();
    const claimed = createDeferred();
    const release = createDeferred();
    f.request.mockImplementation(async (method) => {
      if (method === "push.web.foreground") {
        claimed.resolve();
        await release.promise;
      }
      return {};
    });
    window.dispatchEvent(new Event("pageshow"));
    await claimed.promise;
    vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
    document.dispatchEvent(new Event("visibilitychange"));
    release.resolve();
    await vi.advanceTimersByTimeAsync(0);
    expect(f.request).toHaveBeenLastCalledWith(
      "push.web.foreground",
      {
        endpoint: f.subscription.endpoint,
        sessionKey: null,
      },
      expect.anything(),
    );
    const before = f.request.mock.calls.length;
    await vi.advanceTimersByTimeAsync(30_000);
    expect(f.request).toHaveBeenCalledTimes(before);
    await f.owner.dispose();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("cancels an outstanding permission prompt before any subscription write", async () => {
    const f = fixture();
    const permission = createDeferred<NotificationPermission>();
    f.requestPermission.mockReturnValue(permission.promise);
    const enabling = f.owner.enable();
    await f.owner.dispose();
    const count = f.onState.mock.calls.length;
    permission.resolve("granted");
    await enabling;
    expect(f.subscribe).not.toHaveBeenCalled();
    expect(f.request).not.toHaveBeenCalled();
    expect(f.onState).toHaveBeenCalledTimes(count);
  });

  it("rolls back a browser allocation granted after disposal and never registers it", async () => {
    const f = fixture();
    const subscribing = createDeferred();
    const allocation = createDeferred<PushSubscription>();
    f.subscribe.mockImplementation(() => {
      subscribing.resolve();
      return allocation.promise;
    });
    const enabling = f.owner.enable();
    await subscribing.promise;
    const disposal = f.owner.dispose();
    allocation.resolve(f.subscription);
    await Promise.all([enabling, disposal]);
    expect(f.unsubscribe).toHaveBeenCalledOnce();
    expect(f.request.mock.calls.some(([method]) => method === "push.web.subscribe")).toBe(false);
  });

  it("fences preference writes when the connection changes during the read", async () => {
    const f = fixture();
    f.existing();
    const reading = createDeferred();
    const prefs = createDeferred();
    f.request.mockImplementation(async (method) => {
      if (method === "push.web.vapidPublicKey") {
        return { vapidPublicKey: "BAECAw" };
      }
      if (method === "push.web.preferences.get") {
        reading.resolve();
        await prefs.promise;
        return { device: { enabled: true, label: "" } };
      }
      return {};
    });
    const initialize = f.owner.initialize();
    await reading.promise;
    const disposal = f.owner.dispose();
    prefs.resolve();
    await Promise.all([initialize, disposal]);
    expect(f.request.mock.calls.some(([method]) => method === "push.web.preferences.set")).toBe(
      false,
    );
  });

  it("shows blocked permission and sanitizes gateway errors", async () => {
    const f = fixture();
    f.requestPermission.mockImplementation(async () => {
      f.deny();
      return "denied";
    });
    await f.owner.enable();
    expect(f.owner.state.status).toBe("blocked");
    expect(f.subscribe).not.toHaveBeenCalled();
    await f.owner.dispose();

    const failed = fixture();
    failed.request.mockRejectedValue(new Error("token=synthetic-private-token"));
    await failed.owner.enable();
    expect(failed.owner.state.status).toBe("error");
    expect(failed.owner.state.detail).not.toContain("synthetic-private-token");
    await failed.owner.dispose();
  });

  it("requires iOS installation before any worker or permission request", async () => {
    const f = fixture();
    Object.defineProperty(navigator, "userAgent", {
      value: "Mozilla/5.0 (iPhone)",
      configurable: true,
    });
    const owner = new KidsNotifications(
      createTestGatewayClient(f.request),
      "tutor",
      "agent:tutor:kids:fixture",
      vi.fn(),
    );
    await owner.initialize();
    await owner.enable();
    expect(owner.state.status).toBe("install-required");
    expect(owner.state.detail).toContain("Home Screen");
    expect(f.register).not.toHaveBeenCalled();
    expect(f.requestPermission).not.toHaveBeenCalled();
    await owner.dispose();
    await f.owner.dispose();
  });

  it("waits for this worker activation and releases its listener when disposed", async () => {
    const f = fixture();
    const worker = Object.assign(new EventTarget(), { state: "installing" });
    const remove = vi.spyOn(worker, "removeEventListener");
    const listen = vi.spyOn(worker, "addEventListener");
    f.register.mockResolvedValue({
      pushManager: f.registration.pushManager,
      active: null,
      installing: worker,
    } as unknown as ServiceWorkerRegistration);
    const initializing = f.owner.initialize();
    await vi.advanceTimersByTimeAsync(0);
    expect(listen).toHaveBeenCalledOnce();
    await f.owner.dispose();
    await initializing;
    expect(remove).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
    expect(f.request).not.toHaveBeenCalled();
  });
});
