/**
 * Owns notifications for one authenticated tutor connection and the /kids/
 * worker. The shared Web Push owner handles subscription identity, VAPID, and
 * rollback; Gateway authorization owns which replies this device may receive.
 * This surface fixes device preferences to private tutor-reply notifications.
 * A focused visible document renews a short connection-local foreground claim;
 * blur/hide/retirement clear it. Failed claims expire without muting offline push.
 * The worker always displays received pushes, as Safari requires.
 *
 * initialize() never prompts. enable() must run directly in a user gesture.
 * dispose() fences new writes immediately and joins accepted operations before
 * the app replaces its connection. Browser subscriptions intentionally survive
 * closing the app; disable() is the explicit unsubscribe operation.
 */
import { raceWithTimeout } from "@openclaw/retry";
import type { WebPushDevicePreferences } from "../../../packages/gateway-protocol/src/schema/push.ts";
import type { GatewayBrowserClient } from "../api/gateway.ts";
import {
  getExistingSubscription,
  reconcileWebPushSubscription,
  subscribeToWebPush,
  unsubscribeFromWebPush,
  type WebPushPreferencesResult,
  type WebPushTarget,
} from "../app/web-push.runtime.ts";
import { t } from "../i18n/index.ts";
import { registerKidsEnglish } from "../i18n/locales/en-kids.ts";
import { isIosBrowserPlatform } from "../lib/browser-platform.ts";
import { formatUiError } from "../lib/format-error.ts";

registerKidsEnglish();

export type KidsNotificationsState = {
  status: "unavailable" | "install-required" | "off" | "enabled" | "blocked" | "working" | "error";
  detail: string | null;
};

/** Wait for this registration, never navigator.serviceWorker.ready's admin worker. */
async function activateKidsWorker(signal: AbortSignal): Promise<ServiceWorkerRegistration> {
  const registration = await raceWithTimeout(
    () => navigator.serviceWorker.register("/kids/sw.js", { scope: "/kids/" }),
    10_000,
    () => {
      throw new Error(t("kids.notifications.workerUnavailable"));
    },
    { signal },
  );
  signal.throwIfAborted();
  if (registration.active?.state === "activated") {
    return registration;
  }
  const worker = registration.installing ?? registration.waiting ?? registration.active;
  if (!worker) {
    throw new Error(t("kids.notifications.workerUnavailable"));
  }
  let observe: () => void = () => undefined;
  try {
    await raceWithTimeout(
      () =>
        new Promise<void>((resolve, reject) => {
          observe = () => {
            if (worker.state === "activated") {
              resolve();
            } else if (worker.state === "redundant") {
              reject(new Error(t("kids.notifications.workerUnavailable")));
            }
          };
          worker.addEventListener("statechange", observe);
          observe();
        }),
      10_000,
      () => {
        throw new Error(t("kids.notifications.workerUnavailable"));
      },
      { signal },
    );
    return registration;
  } finally {
    worker.removeEventListener("statechange", observe);
  }
}

function initialState(): KidsNotificationsState {
  // SAFETY: iOS exposes this optional read-only installation hint.
  const installed = (navigator as Navigator & { standalone?: boolean }).standalone === true;
  if (isIosBrowserPlatform() && !installed) {
    return { status: "install-required", detail: t("kids.notifications.installRequired") };
  }
  if (
    !("serviceWorker" in navigator) ||
    !("PushManager" in globalThis) ||
    !("Notification" in globalThis)
  ) {
    return { status: "unavailable", detail: t("kids.notifications.unavailable") };
  }
  return Notification.permission === "denied"
    ? { status: "blocked", detail: t("kids.notifications.blocked") }
    : { status: "off", detail: null };
}

export class KidsNotifications {
  private snapshot = initialState();
  private readonly lifetime = new AbortController();
  private registration: Promise<ServiceWorkerRegistration> | null = null;
  private operation: Promise<void> | null = null;
  private foregroundEndpoint: string | null = null;
  private foregroundSession: string | null = null;
  private foregroundRevision = 0;
  private foregroundOperation: Promise<void> | null = null;
  private foregroundTimer: ReturnType<typeof setInterval> | null = null;
  private readonly refreshForeground = () => void this.updateForeground();
  private readonly leaveForeground = () => void this.updateForeground(false);

  /** The app supplies the Gateway-authorized tutor and owns connection lifetime. */
  constructor(
    private readonly client: GatewayBrowserClient,
    private readonly agentId: string,
    private readonly sessionKey: string,
    private readonly onState: (state: KidsNotificationsState) => void,
  ) {}

  get state(): KidsNotificationsState {
    return this.snapshot;
  }

  /** Register this app's worker and recover its existing subscription without prompting. */
  initialize(): Promise<void> {
    return this.run(async (target) => {
      const result = await reconcileWebPushSubscription(this.client, target);
      this.lifetime.signal.throwIfAborted();
      if (result.state === "vapid-mismatch") {
        throw new Error(t("kids.notifications.connectionMismatch"));
      }
      if (result.state === "registered") {
        await this.savePrivatePreferences(target);
      } else {
        this.publish({ status: "off", detail: null });
      }
    });
  }

  /** Request browser permission immediately in the user gesture, then enable private replies. */
  enable(): Promise<void> {
    return this.run(async (target) => {
      const result = await subscribeToWebPush(this.client, target);
      this.lifetime.signal.throwIfAborted();
      if (result.state !== "registered") {
        throw new Error(t("kids.notifications.connectionMismatch"));
      }
      await this.savePrivatePreferences(target, true);
    });
  }

  /** Disable only this app's browser subscription; do not change user-wide preferences. */
  disable(): Promise<void> {
    return this.run(async (target) => {
      await this.stopForeground();
      await unsubscribeFromWebPush(this.client, target);
      this.publish({ status: "off", detail: null });
    });
  }

  /** Fence new writes and UI callbacks, cancel prompts/activation waits, then join accepted writes. */
  async dispose(): Promise<void> {
    this.lifetime.abort();
    await Promise.all([this.operation, this.stopForeground()]);
  }

  private run(action: (target: WebPushTarget) => Promise<void>): Promise<void> {
    if (
      this.lifetime.signal.aborted ||
      ["unavailable", "install-required", "blocked"].includes(this.snapshot.status)
    ) {
      return Promise.resolve();
    }
    if (this.operation) {
      return this.operation;
    }
    this.publish({ status: "working", detail: null });
    this.registration ??= activateKidsWorker(this.lifetime.signal);
    // Observe failure even if permission is denied before this worker is awaited.
    void this.registration.catch(() => {
      this.registration = null;
    });
    const target = { registration: this.registration, signal: this.lifetime.signal };
    // Call now, not in a promise continuation: Safari permission needs the gesture.
    const operation = action(target)
      .catch((error: unknown) => {
        if (this.lifetime.signal.aborted) {
          return;
        }
        this.publish(
          Notification.permission === "denied"
            ? { status: "blocked", detail: t("kids.notifications.blocked") }
            : { status: "error", detail: formatUiError(error) || t("kids.notifications.failed") },
        );
      })
      .finally(() => {
        this.operation = null;
      });
    this.operation = operation;
    return operation;
  }

  private async savePrivatePreferences(target: WebPushTarget, enabled?: boolean): Promise<void> {
    const subscription = await getExistingSubscription(target);
    this.lifetime.signal.throwIfAborted();
    if (!subscription) {
      throw new Error(t("kids.notifications.failed"));
    }
    const existing = await this.client.request<WebPushPreferencesResult>(
      "push.web.preferences.get",
      {
        endpoint: subscription.endpoint,
      },
    );
    this.lifetime.signal.throwIfAborted();
    const preferences: WebPushDevicePreferences = {
      ...existing.device,
      enabled: enabled ?? existing.device.enabled,
      label: "Rocky",
      detailLevel: "private",
      agentIds: [this.agentId],
      categories: {
        approvalRequested: false,
        agentFinished: true,
        agentQuestion: false,
        humanMentioned: false,
        scheduledTaskFailed: false,
      },
    };
    await this.client.request("push.web.preferences.set", {
      endpoint: subscription.endpoint,
      scope: "device",
      preferences,
    });
    this.lifetime.signal.throwIfAborted();
    this.publish({ status: preferences.enabled ? "enabled" : "off", detail: null });
    if (preferences.enabled) {
      if (!this.foregroundEndpoint) {
        document.addEventListener("visibilitychange", this.refreshForeground);
        window.addEventListener("focus", this.refreshForeground);
        window.addEventListener("blur", this.leaveForeground);
        window.addEventListener("pageshow", this.refreshForeground);
        window.addEventListener("pagehide", this.leaveForeground);
      }
      this.foregroundEndpoint = subscription.endpoint;
      await this.updateForeground();
    } else {
      await this.stopForeground();
    }
  }

  /** Coalesce focus changes behind one bounded request; renewed leases never persist preferences. */
  private updateForeground(
    active = document.visibilityState === "visible" && document.hasFocus(),
  ): Promise<void> {
    if (!this.foregroundEndpoint) {
      return Promise.resolve();
    }
    this.foregroundSession = active && !this.lifetime.signal.aborted ? this.sessionKey : null;
    this.foregroundRevision += 1;
    if (this.foregroundSession && this.foregroundTimer === null) {
      // Gateway ticks arrive every 30s; a 10s renewal keeps abandoned claims below 25s.
      this.foregroundTimer = setInterval(this.refreshForeground, 10_000);
    } else if (!this.foregroundSession && this.foregroundTimer !== null) {
      clearInterval(this.foregroundTimer);
      this.foregroundTimer = null;
    }
    if (this.foregroundOperation) {
      return this.foregroundOperation;
    }
    this.foregroundOperation = (async () => {
      try {
        let sent = -1;
        while (sent !== this.foregroundRevision) {
          sent = this.foregroundRevision;
          try {
            await this.client.request(
              "push.web.foreground",
              {
                endpoint: this.foregroundEndpoint,
                sessionKey: this.foregroundSession,
              },
              { timeoutMs: 5_000 },
            );
          } catch {
            // No persistent mute was written. An unrenewed claim expires on the Gateway.
          }
        }
      } finally {
        this.foregroundOperation = null;
      }
    })();
    return this.foregroundOperation;
  }

  /** Remove document listeners synchronously, clear the lease, and join accepted foreground work. */
  private async stopForeground(): Promise<void> {
    document.removeEventListener("visibilitychange", this.refreshForeground);
    window.removeEventListener("focus", this.refreshForeground);
    window.removeEventListener("blur", this.leaveForeground);
    window.removeEventListener("pageshow", this.refreshForeground);
    window.removeEventListener("pagehide", this.leaveForeground);
    await this.updateForeground(false);
    this.foregroundEndpoint = null;
  }

  private publish(state: KidsNotificationsState): void {
    if (!this.lifetime.signal.aborted) {
      this.snapshot = state;
      this.onState(state);
    }
  }
}
