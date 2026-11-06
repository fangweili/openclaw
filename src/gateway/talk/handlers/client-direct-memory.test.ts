/**
 * Direct-memory and local-tool declarations through the real client-create handler.
 * Provider/bootstrap and persistent voice I/O are stubbed; session authorization,
 * tool projection and native control ownership remain real. Each case joins its
 * control owner and releases voice/legacy bindings before mocks are reset.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../../config/types.openclaw.js";
import type { RealtimeVoiceProviderPlugin } from "../../../plugins/types.js";
import type { RealtimeVoiceTool } from "../../../talk/provider-types.js";
import type {
  GatewayClient,
  GatewayRequestContext,
  GatewayRequestHandlerOptions,
} from "../../server-methods/types.js";
import { resolveSessionMutationAuthorization } from "../../session-sharing.js";
import { closeTalkClientGatewayControlSession } from "../client-gateway-control.js";
import { unregisterTalkVoiceSession } from "../voice-selection.js";
import { createTalkClient } from "./client-create.js";
import { forgetLegacyVoiceBinding } from "./client-legacy-voice-bindings.js";
import { expectRespondError, expectRespondOk, mockCallArg } from "./responses.test-support.js";

const mocks = vi.hoisted(() => ({
  resolveConfiguredRealtimeVoiceProvider: vi.fn(),
  resolveGatewayScopedTools: vi.fn<() => { tools: RealtimeVoiceTool[] }>(),
}));

vi.mock("../../../talk/provider-resolver.js", () => ({
  resolveConfiguredRealtimeVoiceProvider: mocks.resolveConfiguredRealtimeVoiceProvider,
}));
vi.mock("../../../agents/realtime-bootstrap-context.js", () => ({
  resolveRealtimeVoiceAgentContextInstructions: async () => "Synthetic agent voice context.",
}));
vi.mock("../session-history.js", () => ({ readTalkRealtimeInitialItems: async () => [] }));
vi.mock("../../tool-resolution.js", () => ({
  resolveGatewayScopedTools: mocks.resolveGatewayScopedTools,
}));
vi.mock("../../../talk/client-voice-session.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../talk/client-voice-session.js")>()),
  closeStaleClientVoiceSessions: async () => 0,
  closeClientVoiceSession: async () => undefined,
  createOrResumeClientVoiceSession: () => "voice-test",
  ensureClientVoiceAgentSessionEntry: async () => "session-main",
}));

const config: OpenClawConfig = {};
const context = {
  getRuntimeConfig: () => config,
  getClientConnIds: () => new Set(["conn-1"]),
  chatAbortControllers: new Map(),
  broadcastToConnIds: vi.fn(),
  logGateway: { warn: vi.fn() },
} as unknown as GatewayRequestContext;

function createBrowserSessionMock() {
  return vi.fn<NonNullable<RealtimeVoiceProviderPlugin["createBrowserSession"]>>(async () => ({
    provider: "openai",
    transport: "webrtc",
    clientSecret: "synthetic-offer",
  }));
}

function createBrowserProvider(
  createBrowserSession: NonNullable<RealtimeVoiceProviderPlugin["createBrowserSession"]>,
) {
  return { id: "openai", label: "Synthetic voice", isConfigured: () => true, createBrowserSession };
}

/** Invoke admitted creation without booting a Gateway or allocating a real provider. */
async function callTalkHandler(
  method: "talk.client.create",
  options: {
    params: Record<string, unknown>;
    client: { connId: string; connect: { scopes: string[] } };
    respond: GatewayRequestHandlerOptions["respond"];
  },
) {
  const client = options.client as GatewayClient;
  const admission = resolveSessionMutationAuthorization({
    client,
    context,
    method,
    requestParams: options.params,
  });
  if (admission.error) {
    options.respond(false, undefined, admission.error);
    return;
  }
  await createTalkClient({
    req: { type: "req", id: "direct-memory-create", method },
    ...options,
    client,
    isWebchatConnect: () => false,
    context,
    // Persistent row creation is stubbed; storage-target fences have separate tests.
    sessionMutationAuthorization: admission.authorization && {
      ...admission.authorization,
      assertTargetCurrent: vi.fn(),
    },
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.resolveGatewayScopedTools.mockReturnValue({ tools: [] });
});

afterEach(async () => {
  await closeTalkClientGatewayControlSession({
    voiceSessionId: "voice-test",
    sessionKey: "main",
    connId: "conn-1",
  });
  unregisterTalkVoiceSession("voice-test", "conn-1", "main");
  forgetLegacyVoiceBinding("conn-1", "main", "voice-test");
});

const localTool: RealtimeVoiceTool = {
  type: "function",
  name: "end_conversation",
  description: "End the client's conversation after the caller says goodbye.",
  parameters: { type: "object", properties: {} },
};

describe("talk.client.create direct memory declarations", () => {
  it.each([
    {
      name: "legacy client",
      capabilities: [],
      scopes: ["operator.write"],
      allowed: true,
      native: false,
      expected: false,
    },
    {
      name: "opted-in authorized client",
      capabilities: ["direct-memory-search"],
      scopes: ["operator.write"],
      allowed: true,
      native: false,
      expected: true,
    },
    {
      name: "authorized client with local tools",
      capabilities: ["direct-memory-search"],
      scopes: ["operator.write"],
      allowed: true,
      native: false,
      expected: true,
      localTools: [localTool],
    },
    {
      name: "Talk-only client",
      capabilities: ["direct-memory-search"],
      scopes: ["operator.talk", "operator.read"],
      allowed: true,
      native: false,
      expected: false,
    },
    {
      name: "memory denied by tool policy",
      capabilities: ["direct-memory-search"],
      scopes: ["operator.write"],
      allowed: false,
      native: false,
      expected: false,
    },
    {
      name: "native delegation",
      capabilities: ["direct-memory-search"],
      scopes: ["operator.write"],
      allowed: true,
      native: true,
      expected: false,
    },
  ])(
    "advertises direct memory only for $name",
    async ({ capabilities, scopes, allowed, native, expected, localTools }) => {
      const memoryTool: RealtimeVoiceTool = {
        type: "function",
        name: "memory_search",
        description: "The registered search contract.",
        parameters: {
          type: "object",
          properties: { query: { type: "string" } },
          required: ["query"],
        },
      };
      mocks.resolveGatewayScopedTools.mockReturnValue({ tools: allowed ? [memoryTool] : [] });
      const createBrowserSession = createBrowserSessionMock();
      const provider = {
        ...createBrowserProvider(createBrowserSession),
        capabilities: { supportsToolCalls: true, handlesAgentConsult: native },
      };
      mocks.resolveConfiguredRealtimeVoiceProvider.mockReturnValue({
        provider,
        providerConfig: {},
        capabilities: provider.capabilities,
      });
      const respond = vi.fn();
      await callTalkHandler("talk.client.create", {
        params: { sessionKey: "main", capabilities, ...(localTools ? { localTools } : {}) },
        client: { connId: "conn-1", connect: { scopes } },
        respond,
      });
      expectRespondOk(respond);
      const input = mockCallArg(createBrowserSession) as Record<string, unknown>;
      const tools = input.tools as RealtimeVoiceTool[];
      expect(tools.some((tool) => tool.name === "memory_search")).toBe(expected);
      if (localTools) {
        expect(tools).toContainEqual(localTool);
      }
      if (expected) {
        expect(tools).toContainEqual(memoryTool);
        expect(input.instructions).toContain(
          "call memory_search directly instead of openclaw_agent_consult",
        );
        expect(input.instructions).toContain('corpus="sessions"');
      } else {
        expect(input.instructions).not.toContain(
          "call memory_search directly instead of openclaw_agent_consult",
        );
      }
      if (capabilities.length === 0 || native || !scopes.includes("operator.write")) {
        expect(mocks.resolveGatewayScopedTools).not.toHaveBeenCalled();
      }
    },
  );
});

describe("talk.client.create local declarations", () => {
  it.each(["google", "openai"])(
    "passes local tools and unchanged Gateway instructions to %s credential creation",
    async (providerId) => {
      const createBrowserSession = createBrowserSessionMock();
      createBrowserSession.mockResolvedValue(
        providerId === "google"
          ? {
              provider: providerId,
              transport: "provider-websocket",
              protocol: "google-live-bidi",
              websocketUrl: "wss://example.invalid/live",
              audio: {
                inputEncoding: "pcm16",
                inputSampleRateHz: 16_000,
                outputEncoding: "pcm16",
                outputSampleRateHz: 24_000,
              },
              clientSecret: "synthetic-offer",
            }
          : { provider: providerId, transport: "webrtc", clientSecret: "synthetic-offer" },
      );
      const provider = {
        ...createBrowserProvider(createBrowserSession),
        id: providerId,
        capabilities: { supportsToolCalls: true },
      };
      mocks.resolveConfiguredRealtimeVoiceProvider.mockReturnValue({
        provider,
        providerConfig: {},
        capabilities: provider.capabilities,
      });
      const client = { connId: "conn-1", connect: { scopes: ["operator.talk", "operator.read"] } };
      const baseline = vi.fn();
      await callTalkHandler("talk.client.create", {
        params: { sessionKey: "main" },
        client,
        respond: baseline,
      });
      expectRespondOk(baseline);
      const before = mockCallArg(createBrowserSession) as Record<string, unknown>;
      createBrowserSession.mockClear();

      const respond = vi.fn();
      await callTalkHandler("talk.client.create", {
        params: { sessionKey: "main", localTools: [localTool] },
        client,
        respond,
      });
      expectRespondOk(respond);
      const after = mockCallArg(createBrowserSession) as Record<string, unknown>;
      expect(after.tools).toEqual([...(before.tools as RealtimeVoiceTool[]), localTool]);
      expect(after.instructions).toBe(before.instructions);
      expect(mocks.resolveGatewayScopedTools).not.toHaveBeenCalled();
    },
  );

  it.each([
    {
      name: "native delegation",
      capabilities: { supportsToolCalls: true, handlesAgentConsult: true },
    },
    { name: "no function calls", capabilities: { supportsToolCalls: false } },
    {
      name: "Gateway control",
      capabilities: { supportsToolCalls: true, supportsGatewayControl: true },
      requested: ["gateway-control-v1"],
    },
  ])(
    "rejects local execution with $name before provider creation",
    async ({ capabilities, requested }) => {
      const createBrowserSession = createBrowserSessionMock();
      mocks.resolveConfiguredRealtimeVoiceProvider.mockReturnValue({
        provider: createBrowserProvider(createBrowserSession),
        providerConfig: {},
        capabilities,
      });
      const respond = vi.fn();
      await callTalkHandler("talk.client.create", {
        params: { sessionKey: "main", localTools: [localTool], capabilities: requested ?? [] },
        client: { connId: "conn-1", connect: { scopes: ["operator.talk"] } },
        respond,
      });
      expectRespondError(respond, { code: "INVALID_REQUEST" });
      expect(createBrowserSession).not.toHaveBeenCalled();
    },
  );

  it.each([
    { name: "duplicate", localTools: [localTool, localTool] },
    ...["openclaw_agent_consult", "openclaw_agent_control", "describe_view", "memory_search"].map(
      (name) => ({ name, localTools: [{ ...localTool, name }] }),
    ),
    {
      name: "oversized UTF-8 schema",
      localTools: [
        {
          ...localTool,
          parameters: {
            type: "object",
            properties: { text: { type: "string", description: "界".repeat(11_000) } },
          },
        },
      ],
    },
  ])("rejects $name metadata before minting credentials", async ({ localTools }) => {
    const createBrowserSession = createBrowserSessionMock();
    mocks.resolveConfiguredRealtimeVoiceProvider.mockReturnValue({
      provider: createBrowserProvider(createBrowserSession),
      providerConfig: {},
      capabilities: { supportsToolCalls: true },
    });
    const respond = vi.fn();
    await callTalkHandler("talk.client.create", {
      params: { sessionKey: "main", localTools },
      client: { connId: "conn-1", connect: { scopes: ["operator.talk"] } },
      respond,
    });
    expectRespondError(respond, { code: "INVALID_REQUEST" });
    expect(createBrowserSession).not.toHaveBeenCalled();
  });
});
