/** Synthetic recipient/transport fixtures; the suite owns mock reset and Date.now restoration. */
import { vi } from "vitest";
import type { BoundWebPushSubscription } from "../infra/push-web.js";
import type { GatewayWsClient } from "./server/ws-types.js";
import { prepareWebPushForeground } from "./web-push-foreground.js";

/** Build one independent private push registration without persistent state. */
export function boundSubscription(
  deviceId: string,
  userProfileId: string | null = null,
): BoundWebPushSubscription {
  return {
    subscriptionId: `subscription-${deviceId}`,
    endpoint: `https://push.example.test/${deviceId}`,
    keys: { p256dh: `p256dh-${deviceId}`, auth: `auth-${deviceId}` },
    createdAtMs: 1,
    updatedAtMs: 1,
    deviceId,
    userProfileId,
    devicePreferences: {
      enabled: true,
      label: "",
      detailLevel: "identified",
      categories: {
        agentFinished: true,
        agentQuestion: true,
        humanMentioned: true,
        scheduledTaskFailed: true,
      },
    },
  };
}

/** Pairing facts used by the real delivery authorization path. */
export function pairedOperator(deviceId: string, scopes = ["operator.read"]) {
  return {
    deviceId,
    roles: ["operator"],
    role: "operator",
    scopes,
    approvedScopes: scopes,
    tokens: {
      operator: { token: `token-${deviceId}`, role: "operator", scopes },
    },
  };
}

/** Admit a synthetic foreground claim, then apply the named connection lifecycle state. */
export function foregroundBrowser(own: BoundWebPushSubscription, state: string): GatewayWsClient {
  const closed = new AbortController();
  const client: GatewayWsClient = {
    connId: "foreground-browser",
    usesSharedGatewayAuth: false,
    connectionSignal: closed.signal,
    socket: {
      readyState: 1,
      bufferedAmount: 0,
      send: vi.fn(),
      close: vi.fn(),
      terminate: vi.fn(),
      on: vi.fn(),
      off: vi.fn(),
      once: vi.fn(),
    },
    connect: {
      minProtocol: 1,
      maxProtocol: 1,
      client: { id: "webchat", mode: "webchat", version: "test", platform: "web" },
      device: {
        id: "browser-device",
        publicKey: "test",
        signature: "test",
        signedAt: 0,
        nonce: "test",
      },
      role: "operator",
      scopes: ["operator.read"],
    },
    authenticatedUserProfile: {
      profileId: "owner",
      displayName: null,
      hasAvatar: false,
      avatarRevision: "",
      updatedAt: 0,
    },
  };
  const now = vi.spyOn(Date, "now").mockReturnValue(100_000);
  prepareWebPushForeground(client, "agent:tutor:kids:fixture")(
    state === "different endpoint" ? { ...own, subscriptionId: "different-subscription" } : own,
    "owner",
  );
  if (state === "background") {
    prepareWebPushForeground(client, null)(own, "owner");
  }
  if (state === "expired") {
    now.mockReturnValue(125_000);
  }
  if (state === "disconnected") {
    closed.abort();
  }
  if (state === "revoked") {
    client.invalidated = true;
  }
  if (state === "profile replaced") {
    client.authenticatedUserProfile!.profileId = "replacement";
  }
  return client;
}
