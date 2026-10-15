/** Real host authorization for the kids plugin's sessionless Solve completion. */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { GatewayOperatorRoleDefinition } from "../../config/types.gateway.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import {
  createContext,
  createOperatorClient,
} from "../../gateway/server-plugin-in-process-dispatch.test-support.js";
import { setUserProfileRole } from "../../state/user-profile-writes.worker.js";
import { ensureProfileForEmail } from "../../state/user-profiles.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import {
  withPluginRuntimeGatewayRequestScope,
  withPluginRuntimePluginScope,
} from "./gateway-request-scope.js";
import { createRuntimeLlm } from "./runtime-llm.runtime.js";
import type { LlmIsolatedAgentRuntimeCompleteParams } from "./types-core.js";

const isolated = vi.hoisted(() =>
  vi.fn<typeof import("../../agents/isolated-completion.js").runIsolatedCompletion>(),
);
vi.mock("../../agents/isolated-completion.js", () => ({ runIsolatedCompletion: isolated }));

const childScopes: GatewayOperatorRoleDefinition["scopes"] = [
  "operator.sessions.write",
  "operator.talk",
];
const model = "test-provider/child-model";
const completion: LlmIsolatedAgentRuntimeCompleteParams = {
  agentId: "child-tutor",
  systemPrompt: "Prepare ten original problems.",
  messages: [{ role: "user", content: "Saved learning evidence." }],
  purpose: "kids-ui.activity-next",
  maxTokens: 8192,
  execution: { mode: "isolated-agent-runtime", timeoutMs: 90_000 },
};
const providerResult = {
  text: "prepared",
  provider: "test-provider",
  model: "child-model",
  owner: { kind: "harness" as const, id: "fixture" },
};

/** Only the provider is stubbed; config selection, plugin policy, and child principal are real. */
async function withChild(
  policy: "allowed" | "agent-denied" | "plugin-model-denied" | "role-model-denied",
  run: (complete: ReturnType<typeof createRuntimeLlm>["complete"]) => Promise<void>,
) {
  await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
    const cfg: OpenClawConfig = {
      agents: {
        defaults: { model: "test-provider/parent-model" },
        entries: { "child-tutor": { model } },
      },
      plugins: {
        entries: {
          "kids-ui": {
            llm: {
              allowAgentIdOverride: policy !== "agent-denied",
              allowedCompletionModels: policy === "plugin-model-denied" ? ["other/model"] : [model],
            },
          },
        },
      },
      gateway: {
        roles: {
          definitions: {
            child: {
              agents: ["child-tutor"],
              scopes: childScopes,
              sessions: { others: "none" },
              modelPolicy: { allow: policy === "role-model-denied" ? ["other/model"] : [model] },
            },
          },
        },
      },
    };
    await state.writeConfig(cfg);
    const profile = ensureProfileForEmail("solve-child@example.test");
    setUserProfileRole(profile.id, "child");
    const context = createContext();
    context.getRuntimeConfig = () => cfg;
    const llm = createRuntimeLlm({ getConfig: () => cfg, authority: { allowComplete: true } });
    await withPluginRuntimeGatewayRequestScope(
      {
        context,
        client: createOperatorClient({ profileId: profile.id, scopes: childScopes }),
        isWebchatConnect: () => true,
      },
      () =>
        withPluginRuntimePluginScope({ pluginId: "kids-ui", pluginOrigin: "bundled" }, () =>
          run(llm.complete),
        ),
    );
  });
}

beforeEach(() => {
  isolated.mockReset();
  isolated.mockResolvedValue(providerResult);
});

describe("kids Solve host completion authority", () => {
  it("uses the child's configured model with own-session scopes and no model override", async () => {
    await withChild("allowed", async (complete) => {
      await expect(complete(completion)).resolves.toMatchObject({
        text: "prepared",
        agentId: "child-tutor",
        provider: "test-provider",
        model: "child-model",
      });
      expect(isolated).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({
          agentId: "child-tutor",
          provider: "test-provider",
          model: "child-model",
          prompt: completion.messages[0].content,
          streamParams: { maxTokens: 8192, temperature: undefined },
          operatorAuthority: expect.objectContaining({ scopes: childScopes }),
          thinkLevel: undefined,
        }),
      );
    });
  });

  it.each(["agent-denied", "plugin-model-denied", "role-model-denied"] as const)(
    "retains %s policy before any provider execution",
    async (policy) => {
      await withChild(policy, async (complete) => {
        await expect(complete(completion)).rejects.toThrow();
        expect(isolated).not.toHaveBeenCalled();
      });
    },
  );

  it("settles cancellation logically without promising physical provider cleanup", async () => {
    await withChild("allowed", async (complete) => {
      const started = Promise.withResolvers<AbortSignal>();
      const provider = Promise.withResolvers<typeof providerResult>();
      isolated.mockImplementation((params) => {
        started.resolve(params.abortSignal!);
        return provider.promise;
      });
      const controller = new AbortController();
      const operation = complete({ ...completion, signal: controller.signal });
      const rejected = expect(operation).rejects.toMatchObject({ code: "LLM_COMPLETION_ABORTED" });
      const signal = await started.promise;
      try {
        controller.abort();
        await rejected;
        expect(signal.aborted).toBe(true);
      } finally {
        provider.resolve(providerResult);
        await provider.promise;
      }
    });
  });
});
