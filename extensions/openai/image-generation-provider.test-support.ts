// Synthetic credentials, endpoints, and Codex stream items for image provider tests.
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import type { ModelProviderConfig } from "openclaw/plugin-sdk/provider-model-shared";

/** Build image-call data without provider I/O; null models an absent image result. */
export function imageItem(
  result: string | null = Buffer.from("codex-image").toString("base64"),
  status?: string,
) {
  return { type: "image_generation_call", result, ...(status ? { status } : {}) };
}

/** Mark an image item done; the response must still reach a terminal event. */
export function done(item = imageItem()) {
  return { type: "response.output_item.done", item };
}

/** Build the authoritative completed-response event for the supplied output items. */
export function completed(output: unknown[] = []) {
  return { type: "response.completed", response: { output } };
}

export function openAIImageConfig(provider: Omit<ModelProviderConfig, "models">): OpenClawConfig {
  return { models: { providers: { openai: { ...provider, models: [] } } } };
}

export function createCodexOAuthAuthStore() {
  return {
    version: 1 as const,
    profiles: {
      "openai:default": {
        type: "oauth" as const,
        provider: "openai",
        access: "codex-access",
        refresh: "codex-refresh",
        expires: Date.now() + 60_000,
      },
    },
  };
}

export function createCodexApiKeyAuthStore() {
  return {
    version: 1 as const,
    profiles: {
      "openai:manual": {
        type: "api_key" as const,
        provider: "openai",
        key: "codex-api-key",
      },
    },
  };
}

export function createCodexTokenAuthStore() {
  return {
    version: 1 as const,
    profiles: {
      "openai:token": {
        type: "token" as const,
        provider: "openai",
        token: "codex-token",
      },
    },
  };
}

export function createMixedCodexAuthStore() {
  return {
    version: 1 as const,
    profiles: {
      ...createCodexTokenAuthStore().profiles,
      ...createCodexApiKeyAuthStore().profiles,
    },
  };
}

export function createMixedOpenAIAuthStore() {
  return {
    version: 1 as const,
    profiles: {
      "openai:chatgpt": {
        type: "oauth" as const,
        provider: "openai",
        access: "codex-access",
        refresh: "codex-refresh",
        expires: Date.now() + 60_000,
      },
      "openai:default": {
        type: "api_key" as const,
        provider: "openai",
        key: "openai-key",
      },
    },
  };
}
