/**
 * Shared registration facts for lazy and eager Google Live providers. Keep this
 * module independent of the Google SDK so admission can inspect capabilities
 * before a session loads its runtime. Consumers treat the metadata as read-only.
 */
import {
  REALTIME_VOICE_AUDIO_FORMAT_G711_ULAW_8KHZ,
  REALTIME_VOICE_AUDIO_FORMAT_PCM16_24KHZ,
  type RealtimeVoiceProviderPlugin,
} from "openclaw/plugin-sdk/realtime-voice-provider";
import { GOOGLE_PREBUILT_VOICES } from "./voice-catalog.js";

export const GOOGLE_REALTIME_DEFAULT_MODEL = "gemini-3.1-flash-live-preview";

export const GOOGLE_REALTIME_VOICE_METADATA = {
  id: "google",
  label: "Google Live Voice",
  defaultModel: GOOGLE_REALTIME_DEFAULT_MODEL,
  voices: GOOGLE_PREBUILT_VOICES,
  autoSelectOrder: 20,
  capabilities: {
    transports: ["provider-websocket", "gateway-relay"],
    inputAudioFormats: [
      REALTIME_VOICE_AUDIO_FORMAT_G711_ULAW_8KHZ,
      REALTIME_VOICE_AUDIO_FORMAT_PCM16_24KHZ,
    ],
    outputAudioFormats: [
      REALTIME_VOICE_AUDIO_FORMAT_G711_ULAW_8KHZ,
      REALTIME_VOICE_AUDIO_FORMAT_PCM16_24KHZ,
    ],
    supportsBrowserSession: true,
    supportsBargeIn: true,
    handlesInputAudioBargeIn: true,
    supportsToolCalls: true,
    supportsVideoFrames: true,
    supportsSessionResumption: true,
  },
} satisfies Pick<
  RealtimeVoiceProviderPlugin,
  "id" | "label" | "defaultModel" | "voices" | "autoSelectOrder" | "capabilities"
>;
