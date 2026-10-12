/**
 * Transient Web Push presentation state belongs to its authenticated connection.
 * A claim quiets only one owned subscription and exact conversation; it never
 * grants delivery access. Requests reserve order before asynchronous ownership
 * checks. Disconnect, revocation, expiry, or replacement makes a claim inert.
 * There are no timers or retained resources: the connection owns destruction.
 */
import type { BoundWebPushSubscription } from "../infra/push-web.js";
import { WEBSOCKET_OPEN_READY_STATE } from "./server-constants.js";
import type { GatewayClient } from "./server-methods/client-types.js";
import type { GatewayWsClient } from "./server/ws-types.js";

const FOREGROUND_LEASE_MS = 25_000;

export type WebPushForegroundState = {
  claim?: {
    subscriptionId: string;
    deviceId: string;
    profileId: string | null;
    sessionKey: string;
    expiresAtMs: number;
  };
};

/** Reserve latest-request order synchronously; only the returned publisher may commit. */
export function prepareWebPushForeground(client: GatewayClient, sessionKey: string | null) {
  const state: WebPushForegroundState = {
    // A background declaration stops suppression before any storage read.
    claim: sessionKey ? client.webPushForeground?.claim : undefined,
  };
  client.webPushForeground = state;
  const expiresAtMs = Date.now() + FOREGROUND_LEASE_MS;
  return (subscription: BoundWebPushSubscription, profileId: string | undefined): void => {
    if (
      client.webPushForeground !== state ||
      client.invalidated ||
      client.connectionSignal?.aborted
    ) {
      return;
    }
    state.claim = sessionKey
      ? {
          subscriptionId: subscription.subscriptionId,
          deviceId: subscription.deviceId,
          profileId: profileId ?? null,
          sessionKey,
          expiresAtMs,
        }
      : undefined;
  };
}

/** Read live claims immediately before provider admission; other endpoints stay eligible. */
export function isWebPushForeground(
  clients: Iterable<GatewayWsClient>,
  subscription: BoundWebPushSubscription,
  profileId: string | null | undefined,
  sessionKeys: readonly string[],
): boolean {
  for (const client of clients) {
    const claim = client.webPushForeground?.claim;
    if (
      claim &&
      !client.invalidated &&
      !client.connectionSignal?.aborted &&
      client.socket.readyState === WEBSOCKET_OPEN_READY_STATE &&
      claim.expiresAtMs > Date.now() &&
      claim.subscriptionId === subscription.subscriptionId &&
      claim.deviceId === subscription.deviceId &&
      claim.deviceId === client.connect.device?.id &&
      claim.profileId === (profileId ?? null) &&
      claim.profileId === (client.authenticatedUserProfile?.profileId ?? null) &&
      sessionKeys.length === 1 &&
      sessionKeys[0] === claim.sessionKey
    ) {
      return true;
    }
  }
  return false;
}
