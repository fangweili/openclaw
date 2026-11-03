/**
 * Exercises real Talk dispatch and persistence with a synthetic provider. Each
 * case owns isolated state and joins its browser/relay call cleanup before the
 * shared fixture closes databases and removes the temporary root.
 */
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { describe, expect, it, vi } from "vitest";
import { loadSessionEntry } from "../../../config/sessions/session-accessor.js";
import type { OpenClawConfig } from "../../../config/types.openclaw.js";
import { ensureProfileForEmail } from "../../../state/user-profiles.js";
import { closeClientVoiceSession } from "../../../talk/client-voice-session.js";
import { makeBridge } from "../../../talk/session-runtime.test-support.js";
import { withOpenClawTestState } from "../../../test-utils/openclaw-test-state.js";
import { handleGatewayRequest } from "../../server-methods.js";
import type { GatewayClient } from "../../server-methods/types.js";
import { createGatewayRequestContext } from "../../server-request-context.js";
import { makeContextParams } from "../../server-request-context.test-support.js";
import { drainingRelaySessions } from "../relay/state.js";
import { cleanupTalkConnection } from "../session-registry.js";
import { talkClientHandlers } from "./client.js";
import { talkSessionHandlers } from "./session.js";

const { resolveProvider } = vi.hoisted(() => ({ resolveProvider: vi.fn() }));
vi.mock("../../../talk/provider-resolver.js", () => ({
  resolveConfiguredRealtimeVoiceProvider: resolveProvider,
}));

/** Owns one call's real dispatcher/storage lifecycle; only the provider boundary is stubbed. */
async function withTalkCreation(
  transport: "browser" | "relay",
  check: (fixture: {
    client: GatewayClient;
    dispatch: () => Promise<ReturnType<typeof vi.fn>>;
    readSession: () => ReturnType<typeof loadSessionEntry>;
  }) => Promise<void>,
) {
  await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
    const sessionKey = "agent:main:creator-profile";
    const config: OpenClawConfig = {
      agents: { entries: { main: { workspace: state.workspaceDir } } },
      plugins: { enabled: false },
      talk: { realtime: { provider: "synthetic-review" } },
    };
    const client: GatewayClient = {
      connId: "pending-talk-creator",
      authenticatedUserId: "review-user@github",
      connect: {
        role: "operator",
        scopes: ["operator.talk"],
        client: { id: "test", version: "1", platform: "test", mode: "test" },
        minProtocol: 1,
        maxProtocol: 1,
      },
    };
    const capabilities = { transports: ["webrtc", "gateway-relay"], supportsToolCalls: false };
    resolveProvider.mockReset().mockReturnValue({
      provider: {
        id: "synthetic-review",
        label: "Synthetic review provider",
        isConfigured: () => true,
        capabilities,
        createBrowserSession: async () => ({
          provider: "synthetic-review",
          transport: "webrtc",
          clientSecret: "synthetic-offer",
          offerUrl: "/synthetic/offer",
        }),
        createBridge: () => makeBridge(),
      },
      providerConfig: {},
      capabilities,
    });
    const context = createGatewayRequestContext(makeContextParams());
    context.getRuntimeConfig = () => config;
    context.getCommittedRuntimeConfig = () => config;
    context.getClientConnIds = () => new Set([client.connId!]);
    const voiceSessionIds = new Set<string>();
    const dispatch = async () => {
      const method = transport === "browser" ? "talk.client.create" : "talk.session.create";
      const params = {
        sessionKey,
        provider: "synthetic-review",
        transport: transport === "browser" ? "webrtc" : "gateway-relay",
      };
      const respond = vi.fn();
      await handleGatewayRequest({
        req: { type: "req", id: "talk-create", method, params },
        client,
        context,
        isWebchatConnect: () => false,
        respond,
        extraHandlers: { ...talkClientHandlers, ...talkSessionHandlers },
      });
      const payload = respond.mock.calls.at(-1)?.[1];
      if (
        transport === "browser" &&
        isRecord(payload) &&
        typeof payload.voiceSessionId === "string"
      ) {
        voiceSessionIds.add(payload.voiceSessionId);
      }
      return respond;
    };
    try {
      await check({
        client,
        dispatch,
        readSession: () => loadSessionEntry({ agentId: "main", sessionKey }),
      });
    } finally {
      for (const voiceSessionId of voiceSessionIds) {
        await closeClientVoiceSession({ agentId: "main", sessionKey, voiceSessionId, config });
      }
      cleanupTalkConnection(client.connId!, context.logGateway);
      await Promise.all(
        [...drainingRelaySessions].map(
          (session) =>
            session.closing?.completion ?? session.voiceSessionClose ?? Promise.resolve(),
        ),
      );
    }
  });
}

describe.each(["browser", "relay"] as const)("%s Talk session creator", (transport) => {
  it("hydrates the identified connection before persisting the session creator", async () => {
    await withTalkCreation(transport, async ({ client, dispatch, readSession }) => {
      const profile = ensureProfileForEmail("talk-creator@example.test");
      client.authenticatedGitHubIdentitySync = vi.fn(async () => {
        await Promise.resolve();
        client.authenticatedUserProfile = {
          profileId: profile.id,
          displayName: null,
          hasAvatar: false,
          updatedAt: profile.updatedAt,
        };
        return { profileId: profile.id, updatedAt: profile.updatedAt };
      });
      expect(await dispatch()).toHaveBeenCalledWith(true, expect.any(Object), undefined);
      expect(readSession()?.createdActor).toEqual({
        type: "human",
        source: "profile",
        id: profile.id,
      });
      expect(client.authenticatedGitHubIdentitySync).toHaveBeenCalledOnce();
    });
  });

  it("retries failed identity hydration before allocating a provider or creating the session", async () => {
    await withTalkCreation(transport, async ({ client, dispatch, readSession }) => {
      const profile = ensureProfileForEmail("retried-talk-creator@example.test");
      client.authenticatedGitHubIdentitySync = vi
        .fn()
        .mockRejectedValueOnce(new Error("synthetic identity failure"))
        .mockImplementationOnce(async () => {
          client.authenticatedUserProfile = {
            profileId: profile.id,
            displayName: null,
            hasAvatar: false,
            updatedAt: profile.updatedAt,
          };
          return { profileId: profile.id, updatedAt: profile.updatedAt };
        });
      expect(await dispatch()).toHaveBeenCalledWith(
        false,
        undefined,
        expect.objectContaining({
          code: "UNAVAILABLE",
          retryable: true,
          details: { code: "AUTHENTICATED_PROFILE_UNAVAILABLE" },
        }),
      );
      expect(resolveProvider).not.toHaveBeenCalled();
      expect(readSession()).toBeUndefined();
      expect(await dispatch()).toHaveBeenCalledWith(true, expect.any(Object), undefined);
      expect(readSession()?.createdActor).toEqual({
        type: "human",
        source: "profile",
        id: profile.id,
      });
      expect(client.authenticatedGitHubIdentitySync).toHaveBeenCalledTimes(2);
    });
  });

  it("continues to support connections without a user profile", async () => {
    await withTalkCreation(transport, async ({ client, dispatch, readSession }) => {
      delete client.authenticatedUserId;
      expect(await dispatch()).toHaveBeenCalledWith(true, expect.any(Object), undefined);
      expect(readSession()?.createdActor).toEqual({ type: "human", source: "unknown" });
    });
  });
});
