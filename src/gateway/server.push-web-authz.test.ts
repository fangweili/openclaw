import path from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { writeConfigFile } from "../config/config.js";
import { createGatewayConnectionState } from "./server-connection-state.js";
import {
  connectReq,
  CONTROL_UI_CLIENT,
  installGatewayTestHooks,
  openWs,
  rpcReq,
  testState,
  withGatewayServer,
} from "./server.auth.test-helpers.js";
import { withCurrentWebPushAuthority } from "./web-push-authority.js";

// Keep the authenticated router, connection registry, and delivery authority real;
// observe their completion and replace only the external push provider.
const sendPush = vi.hoisted(() => vi.fn(async () => []));
vi.mock("../infra/push-web.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../infra/push-web.js")>()),
  prepareWebPushNotificationSender: async () => sendPush,
}));
vi.mock("./server-connection-state.js", { spy: true });
vi.mock("./web-push-authority.js", { spy: true });

installGatewayTestHooks({ scope: "suite" });
const tempDirs = useAutoCleanupTempDirTracker(afterEach);

test("protects Web Push ownership through authenticated browser RPCs and profile handoff", async () => {
  const origin = "https://control.example.com";
  const auth = {
    mode: "trusted-proxy" as const,
    trustedProxy: {
      userHeader: "x-forwarded-user",
      requiredHeaders: ["x-forwarded-proto"],
      allowLoopback: true,
    },
  };
  testState.gatewayAuth = auth;
  testState.gatewayControlUi = { allowedOrigins: [origin] };
  await writeConfigFile({
    gateway: { auth, trustedProxies: ["127.0.0.1"], controlUi: { allowedOrigins: [origin] } },
  });
  const identities = tempDirs.make("openclaw-push-owners-");
  const endpoint = "https://push.example.test/owner-subscription";
  const keys = { p256dh: "browser-p256dh", auth: "browser-auth" };

  await withGatewayServer(async ({ port }) => {
    const connect = async (email: string, device: string) => {
      const ws = await openWs(port, {
        origin,
        "x-forwarded-for": "203.0.113.50",
        "x-forwarded-proto": "https",
        "x-forwarded-user": email,
      });
      try {
        const response = await connectReq(ws, {
          skipDefaultAuth: true,
          prePairDevice: true,
          scopes: ["operator.sessions.read", "operator.sessions.write"],
          client: CONTROL_UI_CLIENT,
          deviceIdentityPath: path.join(identities, `${device}.sqlite`),
          browserOrigin: origin,
        });
        expect(response.ok, JSON.stringify(response.error)).toBe(true);
        return ws;
      } catch (error) {
        ws.close();
        throw error;
      }
    };
    const owner = await connect("alice@example.com", "first");
    const clients = [owner];
    try {
      const sessionKey = "agent:main:kids:fixture";
      expect(
        (await rpcReq(owner, "sessions.create", { key: sessionKey, agentId: "main" })).ok,
      ).toBe(true);
      expect((await rpcReq(owner, "push.web.subscribe", { endpoint, keys })).ok).toBe(true);
      expect(
        await rpcReq(owner, "push.web.preferences.set", {
          endpoint,
          scope: "device",
          preferences: {
            enabled: true,
            label: "",
            categories: {
              approvalRequested: false,
              agentFinished: true,
              agentQuestion: false,
              humanMentioned: false,
              scheduledTaskFailed: false,
            },
          },
        }),
      ).toMatchObject({ ok: true });
      expect(
        await rpcReq(owner, "push.web.foreground", {
          endpoint,
          sessionKey,
        }),
      ).toMatchObject({ ok: true });
      const runtime = vi.mocked(createGatewayConnectionState).mock.results[0]!.value;
      const deliverReply = async (runId: string) => {
        const delivery = vi.mocked(withCurrentWebPushAuthority);
        const resultIndex = delivery.mock.settledResults.length;
        runtime.broadcast(
          "chat",
          {
            state: "final",
            runId,
            sessionKey,
            message: { role: "assistant", content: "Fixture reply" },
          },
          { agentId: "main", sessionKeys: [sessionKey] },
        );
        await vi.waitFor(() =>
          expect(delivery.mock.settledResults[resultIndex]).toMatchObject({ type: "fulfilled" }),
        );
      };
      await deliverReply("visible-reply");
      expect(sendPush).not.toHaveBeenCalled();
      expect(
        await rpcReq(owner, "push.web.foreground", { endpoint, sessionKey: null }),
      ).toMatchObject({ ok: true });
      await deliverReply("background-reply");
      expect(sendPush).toHaveBeenCalledOnce();
      expect(
        (
          await rpcReq(owner, "push.web.preferences.set", {
            endpoint,
            scope: "device",
            preferences: { enabled: false, label: "Owner browser" },
          })
        ).ok,
      ).toBe(true);
      const otherDevice = await connect("alice@example.com", "second");
      clients.push(otherDevice);
      const otherProfile = await connect("bob@example.com", "first");
      clients.push(otherProfile);
      for (const client of [otherDevice, otherProfile]) {
        for (const method of [
          "push.web.unsubscribe",
          "push.web.preferences.get",
          "push.web.preferences.set",
        ]) {
          expect(
            await rpcReq(client, method, {
              endpoint,
              ...(method.endsWith(".set")
                ? { scope: "device", preferences: { enabled: true, label: "" } }
                : {}),
            }),
          ).toMatchObject({ ok: false, error: { code: "FORBIDDEN" } });
        }
        expect(
          await rpcReq(client, "push.web.subscribe", {
            endpoint,
            keys: { p256dh: "forged-p256dh", auth: "forged-auth" },
          }),
        ).toMatchObject({ ok: false, error: { code: "FORBIDDEN" } });
      }
      expect(await rpcReq(owner, "push.web.preferences.get", { endpoint })).toMatchObject({
        ok: true,
        payload: { durableIdentity: true, device: { enabled: false, label: "Owner browser" } },
      });
      // A real browser account switch retains the subscription material, and
      // transfers ownership without leaking the former account's overrides.
      expect((await rpcReq(otherProfile, "push.web.subscribe", { endpoint, keys })).ok).toBe(true);
      expect(await rpcReq(otherProfile, "push.web.preferences.get", { endpoint })).toMatchObject({
        ok: true,
        payload: { device: { enabled: true, label: "" } },
      });
      expect(await rpcReq(owner, "push.web.unsubscribe", { endpoint })).toMatchObject({
        ok: false,
        error: { code: "FORBIDDEN" },
      });
      expect(await rpcReq(otherProfile, "push.web.unsubscribe", { endpoint })).toMatchObject({
        ok: true,
        payload: { removed: true },
      });
    } finally {
      for (const client of clients) {
        client.close();
      }
    }
  });
});
