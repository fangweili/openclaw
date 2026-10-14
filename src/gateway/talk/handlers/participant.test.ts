import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { GATEWAY_OWNER_PROFILE_ID } from "../../../../packages/gateway-protocol/src/schema/users.js";
import { awaitGateBeforeSettlement } from "../../../../test/helpers/promise.js";
import type { RunEmbeddedAgentParams } from "../../../agents/embedded-agent-runner/run/params.js";
import type { EmbeddedAgentRunResult } from "../../../agents/embedded-agent-runner/types.js";
import {
  loadSessionEntry,
  readSessionTranscriptMessageEvents,
  replaceSessionEntry,
} from "../../../config/sessions/session-accessor.js";
import type { GatewayOperatorRoleDefinition } from "../../../config/types.gateway.js";
import type { OpenClawConfig } from "../../../config/types.openclaw.js";
import { createEmptyPluginRegistry } from "../../../plugins/registry-empty.js";
import { setActivePluginRegistry } from "../../../plugins/runtime.js";
import type { RealtimeVoiceProviderPlugin } from "../../../plugins/types.js";
import { createDeferredCore } from "../../../shared/deferred.js";
import {
  mergeCanonicalUserProfiles,
  setCanonicalUserProfileRole,
} from "../../../state/user-profile-writes.js";
import { ensureProfileForEmail } from "../../../state/user-profiles.js";
import {
  REALTIME_VOICE_AGENT_CONSULT_TOOL_NAME,
  resolveRealtimeVoiceAgentConsultToolsAllow,
} from "../../../talk/agent-consult-tool.js";
import * as clientVoiceSession from "../../../talk/client-voice-session.js";
import { clientVoiceSessionTesting } from "../../../talk/client-voice-session.test-support.js";
import type {
  RealtimeVoiceBridgeCreateRequest,
  RealtimeVoiceProviderCapabilities,
} from "../../../talk/provider-types.js";
import { makeBridge } from "../../../talk/session-runtime.test-support.js";
import { observeMainThreadSql } from "../../../test-utils/main-thread-sql-spies.test-support.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../../../test-utils/openclaw-test-state.js";
import {
  captureGatewayDeviceRevocation,
  closeGatewayDeviceRevocation,
  invalidateGatewayDeviceRevocation,
} from "../../device-revocation.js";
import { prepareGatewayRecipientProfile } from "../../expected-profile.js";
import { handleGatewayRequest } from "../../server-methods.js";
import * as trustedChat from "../../server-methods/chat-send-handler.js";
import type { GatewayClient, GatewayRequestContext } from "../../server-methods/types.js";
import { sharingPolicyClient } from "../../session-sharing.test-utils.js";
import { drainingRelaySessions } from "../relay/state.js";
import { cleanupTalkConnection } from "../session-registry.js";
import { talkClientHandlers } from "./client.js";
import { talkSessionHandlers } from "./session.js";

const mocks = vi.hoisted(() => ({
  resolveProvider: vi.fn(),
  bootstrap: vi.fn(async () => "Synthetic tutor context."),
  runEmbeddedAgent: vi.fn(
    async (_params: RunEmbeddedAgentParams): Promise<EmbeddedAgentRunResult> => ({
      payloads: [{ text: "Synthetic tutor answer." }],
      meta: { durationMs: 0 },
    }),
  ),
}));

vi.mock("../../../agents/embedded-agent.js", () => ({ runEmbeddedAgent: mocks.runEmbeddedAgent }));
vi.mock("../../../agents/bootstrap-files.js", () => ({
  resolveBootstrapFilesForRun: async () => [],
}));
vi.mock("../../../agents/realtime-bootstrap-context.js", () => ({
  resolveRealtimeVoiceAgentContextInstructions: mocks.bootstrap,
}));
vi.mock("../../../talk/provider-resolver.js", () => ({
  resolveConfiguredRealtimeVoiceProvider: mocks.resolveProvider,
}));
vi.mock("../../../talk/provider-registry.js", () => ({ listRealtimeVoiceProviders: () => [] }));

const childScopes: GatewayOperatorRoleDefinition["scopes"] = [
  "operator.sessions.write",
  "operator.talk",
];
const capabilities: RealtimeVoiceProviderCapabilities = {
  transports: ["gateway-relay"],
  inputAudioFormats: [{ encoding: "pcm16", sampleRateHz: 24000, channels: 1 }],
  outputAudioFormats: [{ encoding: "pcm16", sampleRateHz: 24000, channels: 1 }],
  supportsToolCalls: false,
};
let state: OpenClawTestState;
let config: OpenClawConfig;
let client: (GatewayClient & { connId: string }) | null;
let controllerCurrent: boolean;
let childId: string;
let adultId: string;
let sessionKey: string;
let request: RealtimeVoiceBridgeCreateRequest | undefined;
let caseNumber = 0;
const sendAudio = vi.fn();
const closeProvider = vi.fn();
const createBridge = vi.fn<NonNullable<RealtimeVoiceProviderPlugin["createBridge"]>>((value) => {
  request = value;
  return makeBridge({ sendAudio, close: closeProvider });
});
const context = {
  getRuntimeConfig: () => config,
  getClientConnIds: () => new Set(["shared-robot"]),
  chatAbortControllers: new Map(),
  broadcastToConnIds: vi.fn(),
  logGateway: { warn: vi.fn() },
} as unknown as GatewayRequestContext;

// The real router supplies all target, role, sharing, schema, and live-authority fences.
async function dispatch(method: string, params: Record<string, unknown>) {
  const respond = vi.fn();
  // WebSocket dispatch releases its request hold after the reply. The admitted
  // call must retain that exact capture to observe later device revocation.
  const authority = captureGatewayDeviceRevocation(
    context,
    { deviceId: client?.connect.device?.id, role: client?.connect.role },
    () => controllerCurrent,
    client?.connectionSignal,
  );
  try {
    await handleGatewayRequest({
      req: { type: "req", id: "participant-test", method, params },
      client,
      context,
      isWebchatConnect: () => false,
      hasCurrentClientAuthority: authority.isCurrent,
      respond,
      extraHandlers: { ...talkSessionHandlers, ...talkClientHandlers },
    });
  } finally {
    authority.release();
  }
  return respond;
}

async function createCall(overrides: Record<string, unknown> = {}) {
  return dispatch("talk.session.create", {
    mode: "realtime",
    transport: "gateway-relay",
    brain: "agent-consult",
    participantProfileId: childId,
    sessionKey,
    ...overrides,
  });
}

function providerRequest(): RealtimeVoiceBridgeCreateRequest {
  if (!request) {
    throw new Error("Expected an admitted realtime provider request");
  }
  return request;
}

beforeAll(async () => {
  state = await createOpenClawTestState({ label: "talk-participant" });
});

beforeEach(async () => {
  caseNumber += 1;
  childId = ensureProfileForEmail(`learner-${caseNumber}@example.test`).id;
  adultId = ensureProfileForEmail(`adult-${caseNumber}@example.test`).id;
  await setCanonicalUserProfileRole(childId, "learner");
  await setCanonicalUserProfileRole(adultId, "adult");
  sessionKey = `agent:tutor:kids:${encodeURIComponent(childId).toLowerCase()}`;
  config = {
    agents: {
      ownership: "explicit",
      entries: { tutor: { workspace: state.workspaceDir, name: "Indigo tutor" }, other: {} },
    },
    talk: { agentId: "tutor" },
    gateway: {
      roles: {
        default: "denied",
        definitions: {
          adult: { agents: "*", sessions: { others: "write" }, scopes: ["operator.admin"] },
          learner: { agents: ["tutor"], sessions: { others: "none" }, scopes: [...childScopes] },
          denied: { agents: [], sessions: { others: "none" }, scopes: [] },
        },
      },
    },
  };
  client = {
    ...sharingPolicyClient({
      user: adultId,
      displayName: "Adult",
      scopes: ["operator.admin"],
      deviceId: "shared-robot-device",
    }),
    connId: "shared-robot",
    connectionSignal: new AbortController().signal,
  };
  prepareGatewayRecipientProfile(client);
  controllerCurrent = true;
  request = undefined;
  vi.clearAllMocks();
  mocks.bootstrap.mockReset().mockResolvedValue("Synthetic tutor context.");
  mocks.runEmbeddedAgent.mockReset().mockResolvedValue({
    payloads: [{ text: "Synthetic tutor answer." }],
    meta: { durationMs: 0 },
  });
  context.chatAbortControllers.clear();
  setActivePluginRegistry(createEmptyPluginRegistry());
  const provider: RealtimeVoiceProviderPlugin = {
    id: "synthetic-voice",
    label: "Synthetic voice",
    capabilities,
    isConfigured: () => true,
    createBridge,
  };
  mocks.resolveProvider.mockReturnValue({
    provider,
    providerConfig: {},
    capabilities: { ...capabilities, handlesAgentConsult: true },
  });
});

afterEach(async () => {
  cleanupTalkConnection("shared-robot", context.logGateway);
  await Promise.all(
    [...drainingRelaySessions].map(
      (session) => session.closing?.completion ?? session.voiceSessionClose ?? Promise.resolve(),
    ),
  );
  clientVoiceSessionTesting.reset();
  setActivePluginRegistry(createEmptyPluginRegistry());
});

afterAll(async () => {
  closeGatewayDeviceRevocation(context);
  await state.cleanup();
});

describe("adult-selected Talk participant through Gateway authorization", () => {
  it("binds the child's conversation, attribution, prompt, and consult limits without parent authority", async () => {
    const response = await createCall();
    expect(response).toHaveBeenCalledWith(
      true,
      expect.objectContaining({
        participant: { profileId: childId, agentId: "tutor", sessionKey },
      }),
      undefined,
    );
    const { sessionId } = response.mock.calls[0]![1] as { sessionId: string };
    const entry = loadSessionEntry({ agentId: "tutor", sessionKey });
    expect(entry?.createdActor).toMatchObject({ type: "human", id: childId });
    const provider = providerRequest();
    expect(provider.instructions).toContain(childId);
    expect(provider.instructions).not.toContain(adultId);
    expect(provider.instructions).toContain('"administrator_selected_participant":');
    expect(provider.instructions).not.toContain('"authenticated_caller":');
    expect(provider.instructions).toContain('"selected_agent":{"id":"tutor"');
    provider.onReady?.();
    provider.onTranscript?.("user", "My favorite color is blue.", true);
    await expect(provider.runAgentConsult!({ prompt: "What color do I like?" })).resolves.toEqual({
      text: "Synthetic tutor answer.",
    });
    expect(mocks.runEmbeddedAgent).toHaveBeenCalledWith(
      expect.objectContaining({
        agentId: "tutor",
        sessionKey,
        senderId: childId,
        senderIsOwner: false,
        toolsAllow: resolveRealtimeVoiceAgentConsultToolsAllow("safe-read-only"),
      }),
    );
    const consult = mocks.runEmbeddedAgent.mock.calls[0]![0];
    expect(consult.extraSystemPrompt).toContain(childId);
    expect(consult.extraSystemPrompt).not.toContain(adultId);
    expect(await dispatch("talk.session.close", { sessionId })).toHaveBeenCalledWith(
      true,
      { ok: true },
      undefined,
    );
    const transcript = readSessionTranscriptMessageEvents({
      agentId: "tutor",
      sessionId: entry!.sessionId,
    });
    expect(transcript[0]?.event).toHaveProperty("message.__openclaw.senderIdentity", {
      type: "profile",
      id: childId,
    });
    expect(closeProvider).toHaveBeenCalledOnce();
  });

  it.each(["anonymous", "profileless-admin", "non-admin", "synthetic", "stale"] as const)(
    "rejects %s controller access before creating a provider or child session",
    async (kind) => {
      if (kind === "anonymous") {
        client = null;
      } else if (kind === "profileless-admin") {
        client = { ...sharingPolicyClient({ scopes: ["operator.admin"] }), connId: "shared-robot" };
      } else if (kind === "non-admin") {
        client = {
          ...sharingPolicyClient({ user: childId, scopes: childScopes }),
          connId: "shared-robot",
        };
        prepareGatewayRecipientProfile(client);
      } else if (kind === "synthetic") {
        client!.internal = { syntheticClient: true };
      } else {
        controllerCurrent = false;
      }
      expect(await createCall()).toHaveBeenCalledWith(
        false,
        undefined,
        expect.objectContaining({ code: expect.any(String) }),
      );
      expect(createBridge).not.toHaveBeenCalled();
      expect(loadSessionEntry({ agentId: "tutor", sessionKey })).toBeUndefined();
    },
  );

  it.each([
    { name: "gateway owner", profile: GATEWAY_OWNER_PROFILE_ID },
    { name: "unknown profile", profile: "unavailable-profile" },
    { name: "another agent", key: "agent:other:kids:" },
    { name: "another conversation", key: "agent:tutor:main" },
    { name: "a main alias", key: "main" },
    { name: "another child's conversation", key: "agent:tutor:kids:someone-else" },
  ])("rejects $name as the selected child target", async ({ profile, key }) => {
    expect(
      await createCall({
        ...(profile ? { participantProfileId: profile } : {}),
        ...(key ? { sessionKey: key.endsWith(":") ? `${key}${childId}` : key } : {}),
      }),
    ).toHaveBeenCalledWith(false, undefined, expect.objectContaining({ code: expect.any(String) }));
    expect(createBridge).not.toHaveBeenCalled();
  });

  it.each<Partial<GatewayOperatorRoleDefinition>>([
    { agents: "*" },
    { agents: ["tutor", "other"] },
    { agents: ["retired"] },
    { scopes: ["operator.admin"] },
    { scopes: ["operator.sessions.write"] },
    { sessions: { others: "write" } },
  ])("rejects a profile without the required child role boundary: %j", async (change) => {
    Object.assign(config.gateway!.roles!.definitions.learner!, change);
    expect(await createCall()).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({ code: expect.any(String) }),
    );
    expect(createBridge).not.toHaveBeenCalled();
  });

  it("does not silently follow a merged profile selection", async () => {
    await mergeCanonicalUserProfiles(childId, ensureProfileForEmail("successor@example.test").id);
    expect(await createCall()).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({ code: expect.any(String) }),
    );
    expect(createBridge).not.toHaveBeenCalled();
  });

  it("cannot use the adult's access to enter another person's session at the expected child key", async () => {
    await replaceSessionEntry(
      { agentId: "tutor", sessionKey },
      {
        sessionId: "another-persons-conversation",
        updatedAt: 1,
        createdActor: { type: "human", source: "profile", id: adultId },
      },
    );
    expect(await createCall()).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({ code: expect.any(String) }),
    );
    expect(createBridge).not.toHaveBeenCalled();
    expect(loadSessionEntry({ agentId: "tutor", sessionKey })?.createdActor?.id).toBe(adultId);
  });

  it("keeps ordinary caller identity when no participant was selected", async () => {
    const response = await createCall({
      participantProfileId: undefined,
      sessionKey: "agent:tutor:ordinary",
    });
    expect(response).toHaveBeenCalledWith(true, expect.any(Object), undefined);
    expect(response.mock.calls[0]![1]).not.toHaveProperty("participant");
    expect(providerRequest().instructions).toContain(adultId);
    expect(providerRequest().instructions).not.toContain(childId);
    expect(
      loadSessionEntry({ agentId: "tutor", sessionKey: "agent:tutor:ordinary" })?.createdActor,
    ).toMatchObject({ type: "human", id: adultId });
  });

  it.each(["child role", "controller", "required sandbox"] as const)(
    "rechecks %s authority after awaited context loading before creating the child session",
    async (change) => {
      const started = createDeferredCore();
      const release = createDeferredCore<string>();
      mocks.bootstrap.mockImplementationOnce(async () => {
        started.resolve();
        return release.promise;
      });
      const pending = createCall();
      try {
        await awaitGateBeforeSettlement(
          started.promise,
          pending,
          "Participant admission settled before context loading",
        );
        if (change === "child role") {
          await setCanonicalUserProfileRole(childId, "denied");
        } else if (change === "required sandbox") {
          config.gateway!.roles!.definitions.learner!.sandbox = "required";
        } else {
          controllerCurrent = false;
        }
      } finally {
        release.resolve("Synthetic tutor context.");
      }
      expect(await pending).toHaveBeenCalledWith(
        false,
        undefined,
        expect.objectContaining({ code: expect.any(String) }),
      );
      expect(createBridge).not.toHaveBeenCalled();
      expect(loadSessionEntry({ agentId: "tutor", sessionKey })).toBeUndefined();
    },
  );

  it("checks the selected participant for audio chunks without main-thread SQLite", async () => {
    const response = await createCall();
    expect(response).toHaveBeenCalledWith(true, expect.any(Object), undefined);
    const { sessionId } = response.mock.calls[0]![1] as { sessionId: string };
    providerRequest().onReady?.();
    const sql = observeMainThreadSql();
    try {
      sql.calibrate();
      for (const timestamp of [0, 20, 40]) {
        expect(
          await dispatch("talk.session.appendAudio", {
            sessionId,
            audioBase64: "AAA=",
            timestamp,
          }),
        ).toHaveBeenCalledWith(true, { ok: true }, undefined);
      }
      expect(sendAudio).toHaveBeenCalledTimes(3);
      sql.expectIdle();
    } finally {
      sql.restore();
    }
  });

  it("rejects client-forwarded consults on a selected relay before session or administrator chat side effects", async () => {
    const response = await createCall();
    expect(response).toHaveBeenCalledWith(true, expect.any(Object), undefined);
    const { sessionId } = response.mock.calls[0]![1] as { sessionId: string };
    providerRequest().onReady?.();
    expect(client!.connect.scopes).toEqual(["operator.admin"]);
    const ensure = vi.spyOn(clientVoiceSession, "ensureClientVoiceAgentSessionEntry");
    const chat = vi
      .spyOn(trustedChat, "handleTrustedInternalChatSend")
      .mockImplementation(async ({ respond }) => {
        respond(true, { status: "started", runId: "unexpected-administrator-consult" }, undefined);
      });
    try {
      expect(
        await dispatch("talk.client.toolCall", {
          sessionKey,
          relaySessionId: sessionId,
          voiceSessionId: sessionId,
          callId: "forwarded-consult",
          name: REALTIME_VOICE_AGENT_CONSULT_TOOL_NAME,
          args: { question: "Read another person's workspace." },
        }),
      ).toHaveBeenCalledWith(
        false,
        undefined,
        expect.objectContaining({ code: "INVALID_REQUEST" }),
      );
      expect(ensure).not.toHaveBeenCalled();
      expect(chat).not.toHaveBeenCalled();
      expect(mocks.runEmbeddedAgent).not.toHaveBeenCalled();
    } finally {
      ensure.mockRestore();
      chat.mockRestore();
    }
  });

  it.each(["child role", "session generation"] as const)(
    "refuses new audio and consultations after %s changes but still lets the controller close",
    async (change) => {
      const response = await createCall();
      expect(response).toHaveBeenCalledWith(true, expect.any(Object), undefined);
      const { sessionId } = response.mock.calls[0]![1] as { sessionId: string };
      providerRequest().onReady?.();
      if (change === "child role") {
        await setCanonicalUserProfileRole(childId, "denied");
      } else {
        await replaceSessionEntry(
          { agentId: "tutor", sessionKey },
          {
            sessionId: "replacement-generation",
            updatedAt: 2,
            createdActor: { type: "human", source: "profile", id: childId },
          },
        );
      }
      expect(
        await dispatch("talk.session.appendAudio", { sessionId, audioBase64: "AAA=" }),
      ).toHaveBeenCalledWith(
        false,
        undefined,
        expect.objectContaining({ code: expect.any(String) }),
      );
      await expect(providerRequest().runAgentConsult!({ prompt: "Continue." })).rejects.toThrow();
      expect(sendAudio).not.toHaveBeenCalled();
      expect(mocks.runEmbeddedAgent).not.toHaveBeenCalled();
      expect(await dispatch("talk.session.close", { sessionId })).toHaveBeenCalledWith(
        true,
        { ok: true },
        undefined,
      );
      expect(closeProvider).toHaveBeenCalledOnce();
    },
  );

  it("retains the creating request's device revocation after its WebSocket dispatch releases the request", async () => {
    const response = await createCall();
    expect(response).toHaveBeenCalledWith(true, expect.any(Object), undefined);
    const { sessionId } = response.mock.calls[0]![1] as { sessionId: string };
    providerRequest().onReady?.();
    invalidateGatewayDeviceRevocation(context, "shared-robot-device", "operator");
    await expect(providerRequest().runAgentConsult!({ prompt: "Continue." })).rejects.toThrow();
    expect(
      await dispatch("talk.session.appendAudio", { sessionId, audioBase64: "AAA=" }),
    ).toHaveBeenCalledWith(false, undefined, expect.objectContaining({ code: expect.any(String) }));
    expect(sendAudio).not.toHaveBeenCalled();
    expect(mocks.runEmbeddedAgent).not.toHaveBeenCalled();
    // Cleanup still owns the provider even though its selected participant lease
    // has lost the authority to admit any more work.
    cleanupTalkConnection("shared-robot", context.logGateway);
    const completions = [...drainingRelaySessions]
      .map((session) => session.closing?.completion)
      .filter((completion) => completion !== undefined);
    await Promise.all(completions);
    expect(closeProvider).toHaveBeenCalledOnce();
  });
});
