/**
 * Exercises admitted Gateway calls through the real Active Memory prompt hook.
 * Embedded dispatch and recall output are synthetic; the prompt fixture carries
 * the admitted tool restrictions and abort signal. Each call owns a temporary
 * plugin registry and joins its cleanup; the invoking suite owns call teardown.
 */
import { expect, vi, type Mock } from "vitest";
import type { RunEmbeddedAgentParams } from "../../../agents/embedded-agent-runner/run/params.js";
import type { EmbeddedAgentRunResult } from "../../../agents/embedded-agent-runner/types.js";
import { resolveAgentHarnessBeforePromptBuildResult } from "../../../agents/harness/prompt-compaction-hook-helpers.js";
import type { OpenClawConfig } from "../../../config/types.openclaw.js";
import {
  getGlobalHookRunner,
  initializeGlobalHookRunner,
} from "../../../plugins/hook-runner-global.js";
import { createPluginRegistry } from "../../../plugins/registry.js";
import { createPluginRegistryOwner, setActivePluginRegistry } from "../../../plugins/runtime.js";
import { createPluginRuntime } from "../../../plugins/runtime/index.js";
import { createPluginRecord } from "../../../plugins/status.test-helpers.js";
import type { OpenClawPluginApi } from "../../../plugins/types.js";
import type { RealtimeVoiceAgentConsultRunner } from "../../../talk/provider-types.js";
import { loadBundledPluginFacade } from "../../../test-utils/bundled-plugin-public-surface.js";

const RECALLED_VOICE_FACT = "You practiced equivalent fractions with a number line.";

/** Owns an isolated plugin registry through the call; disposal joins plugin cleanup. */
async function installVoiceRecallFixture(config: OpenClawConfig) {
  const runtime = createPluginRuntime();
  const recall = vi.fn<typeof runtime.agent.runEmbeddedAgent>(async (params) => {
    params.abortSignal?.throwIfAborted();
    params.onAgentToolResult?.({
      toolName: "memory_search",
      result: { details: { results: [{ text: RECALLED_VOICE_FACT }] } },
      isError: false,
    });
    return { payloads: [{ text: RECALLED_VOICE_FACT }], meta: { durationMs: 0 } };
  });
  Object.defineProperty(runtime.agent, "runEmbeddedAgent", { value: recall });
  Object.defineProperty(runtime.agent, "resolveCliBackendDispatchEligibility", {
    value: () => undefined,
  });
  Object.defineProperty(runtime.config, "current", { value: () => config });
  const logs: string[] = [];
  const log = (message: string) => logs.push(message);
  const registry = createPluginRegistry({
    runtime,
    activateGlobalSideEffects: false,
    logger: { info: log, warn: log, error: log, debug: log },
  });
  const memory = createPluginRecord({
    id: "memory-core",
    kind: "memory",
    memorySlotSelected: true,
  });
  const active = createPluginRecord({ id: "active-memory", origin: "bundled" });
  registry.registry.plugins.push(memory, active);
  registry.createApi(memory, { config }).registerMemoryCapability({
    deterministicRecallToolName: "memory_search",
    supportsPrivateTranscriptRecall: true,
  });
  const plugin = await loadBundledPluginFacade<{
    default: { register: (api: OpenClawPluginApi) => void };
  }>({ pluginId: "active-memory", artifactBasename: "index.js" });
  plugin.default.register(
    registry.createApi(active, {
      config,
      pluginConfig: config.plugins?.entries?.["active-memory"]?.config,
    }),
  );
  const hook = registry.registry.typedHooks.find(
    (entry) => entry.hookName === "before_prompt_build",
  );
  if (!hook) {
    throw new Error("Active Memory did not register its prompt hook");
  }
  const owner = createPluginRegistryOwner(registry.registry);
  setActivePluginRegistry(registry.registry);
  initializeGlobalHookRunner(registry.registry);
  const promptHook = vi.spyOn(hook, "handler");
  return {
    recall,
    logs,
    promptHook,
    close: () => owner.close(),
    /** Exercises the canonical harness prompt owner with the actual admitted recorder. */
    async buildPrompt(params: RunEmbeddedAgentParams) {
      await params.userTurnTranscriptRecorder?.persistApproved();
      const ctx = {
        runId: params.runId,
        agentId: params.agentId,
        sessionKey: params.sessionKey,
        sessionId: params.sessionId,
        workspaceDir: params.workspaceDir,
        messageProvider: params.messageProvider,
        trigger: params.trigger,
        inputProvenance: params.inputProvenance,
      };
      try {
        return await resolveAgentHarnessBeforePromptBuildResult({
          prompt: params.prompt,
          currentUserMessage:
            params.userTurnTranscriptRecorder?.message ??
            (await params.userTurnTranscriptRecorder?.resolveMessage()),
          developerInstructions: params.extraSystemPrompt ?? "",
          messages: [],
          ctx,
          toolAuthority: {
            fingerprint: params.runId,
            activeToolNames: () => params.toolsAllow ?? [],
            assertActive: () => params.abortSignal?.throwIfAborted(),
          },
        });
      } finally {
        await getGlobalHookRunner()?.runAgentEnd({ messages: [], success: true }, ctx);
      }
    },
  };
}

/** Checks native admission, recall injection, and cancellation at the fixture's prompt boundary. */
export async function expectNativeVoiceMemoryRecall({
  config,
  transport,
  dispatch,
  getConsult,
  runEmbeddedAgent,
}: {
  config: OpenClawConfig;
  transport: "browser" | "relay";
  dispatch: (method: string, params: Record<string, unknown>) => Promise<unknown>;
  getConsult: () => RealtimeVoiceAgentConsultRunner | undefined;
  runEmbeddedAgent: Mock<(params: RunEmbeddedAgentParams) => Promise<EmbeddedAgentRunResult>>;
}) {
  config.memory = { search: { rememberAcrossConversations: true } };
  config.plugins = {
    entries: {
      "active-memory": {
        enabled: true,
        config: { agents: ["other"], model: "synthetic/recall", persistTranscripts: false },
      },
    },
  };
  const fixture = await installVoiceRecallFixture(config);
  try {
    const respond = await dispatch(
      transport === "browser" ? "talk.client.create" : "talk.session.create",
      {
        sessionKey: "main",
        mode: "realtime",
        transport: transport === "browser" ? "webrtc" : "gateway-relay",
        brain: "agent-consult",
        ...(transport === "browser" ? { capabilities: ["gateway-control-v1"] } : {}),
      },
    );
    expect(respond).toHaveBeenCalledWith(true, expect.any(Object), undefined);
    runEmbeddedAgent.mockImplementationOnce(async (params) => {
      const built = await fixture.buildPrompt(params);
      expect(fixture.promptHook).toHaveBeenCalledOnce();
      expect(fixture.promptHook.mock.calls[0]?.[0]).toMatchObject({
        currentUserMessageId: params.userTurnTranscriptRecorder?.message?.idempotencyKey,
      });
      expect(built.prompt, fixture.logs.join("\n")).toContain(RECALLED_VOICE_FACT);
      expect(built.prompt).toContain("What did I practice yesterday?");
      expect(params.toolsAllow).toEqual([
        "read",
        "web_search",
        "web_fetch",
        "x_search",
        "memory_search",
        "memory_get",
      ]);
      return { payloads: [{ text: "Recalled practice." }], meta: { durationMs: 0 } };
    });
    await expect(getConsult()!({ prompt: "What did I practice yesterday?" })).resolves.toEqual({
      text: "Recalled practice.",
    });
    expect(fixture.recall).toHaveBeenCalledOnce();
    expect(fixture.recall.mock.calls[0]?.[0]).toMatchObject({
      agentId: "voice",
      trigger: "manual",
      toolsAllow: ["memory_search"],
      conversationRecall: {
        anchorSessionKey: "agent:voice:main",
        scope: "same-agent-private",
        corpus: "sessions",
      },
    });
    // Recall may finish after the user cancels. Its private context must not
    // cross the existing prompt authority boundary after that cancellation.
    const controller = new AbortController();
    const completeRecall = fixture.recall.getMockImplementation()!;
    fixture.recall.mockImplementationOnce(async (params) => {
      const result = await completeRecall(params);
      controller.abort(new Error("Voice request cancelled"));
      return result;
    });
    runEmbeddedAgent.mockImplementationOnce(async (params) => {
      const built = await fixture.buildPrompt(params);
      expect(built.prompt).not.toContain(RECALLED_VOICE_FACT);
      params.abortSignal?.throwIfAborted();
      throw new Error("Cancelled voice request reached model dispatch");
    });
    await expect(
      getConsult()!({ prompt: "What else did I practice yesterday?", signal: controller.signal }),
    ).rejects.toThrow("Realtime voice agent consult cancelled");
    expect(fixture.recall).toHaveBeenCalledTimes(2);
  } finally {
    await fixture.close();
  }
}
