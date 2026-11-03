import { createCapturedPluginRegistration } from "openclaw/plugin-sdk/plugin-test-runtime";
import { expect, it, vi } from "vitest";
import googlePlugin from "./index.js";

const runtime = vi.hoisted(() => ({
  sdkLoads: 0,
  createToken: vi.fn(async () => ({ name: "auth_tokens/browser-session" })),
}));

vi.mock("@google/genai", async (importOriginal) => {
  runtime.sdkLoads += 1;
  return await importOriginal<typeof import("@google/genai")>();
});

vi.mock("./google-genai-runtime.js", () => ({
  createGoogleGenAI: () => ({ authTokens: { create: runtime.createToken } }),
}));

it("advertises video before loading the SDK and preserves capabilities through browser startup", async () => {
  const captured = createCapturedPluginRegistration({ id: "google" });
  googlePlugin.register(captured.api);
  const provider = captured.realtimeVoiceProviders.find((entry) => entry.id === "google");
  if (!provider) {
    throw new Error("Expected the registered Google realtime voice provider");
  }

  expect(runtime.sdkLoads).toBe(0);
  expect(provider.capabilities?.supportsVideoFrames).toBe(true);
  expect(provider.capabilities?.supportsBrowserSession).toBe(true);
  expect(provider.capabilities?.transports).toContain("provider-websocket");

  const session = await provider.createBrowserSession?.({
    providerConfig: { apiKey: "gemini-key" },
    instructions: "Describe the camera view.",
  });
  expect(session).toMatchObject({
    transport: "provider-websocket",
    protocol: "google-live-bidi",
    clientSecret: "auth_tokens/browser-session",
  });
  expect(runtime.createToken).toHaveBeenCalledOnce();
  expect(runtime.sdkLoads).toBe(1);

  const { buildGoogleRealtimeVoiceProvider } = await import("./realtime-voice-provider.js");
  expect(provider.capabilities).toEqual(buildGoogleRealtimeVoiceProvider().capabilities);
});
