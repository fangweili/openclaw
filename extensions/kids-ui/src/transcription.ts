/**
 * Private dictation uploads for the kids composer. The plugin service owns at most
 * four requests, one per authenticated connection, and each request owns a private
 * temporary recording until media understanding and cleanup settle. No conversation
 * or profile data is read or written. The Gateway owns scope admission; its current
 * authority and the service lifetime fence preparation, runtime admission, and replies.
 * The media SDK owns provider selection/deadlines. It cannot cancel admitted calls,
 * so disconnect discards results and shutdown joins them before releasing files.
 */
import { canonicalizeBase64 } from "openclaw/plugin-sdk/blob-runtime";
import type { OpenClawConfig, OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import { resolvePreferredOpenClawTmpDir, tempWorkspace } from "openclaw/plugin-sdk/temp-path";

const MAX_RECORDING_BYTES = 1024 * 1024;
const MAX_RECORDING_BASE64 = Math.ceil(MAX_RECORDING_BYTES / 3) * 4;
const MAX_ACTIVE_REQUESTS = 4;
const AUDIO_EXTENSIONS = new Map([
  ["audio/webm", "webm"],
  ["audio/mp4", "m4a"],
  ["audio/ogg", "ogg"],
]);

type Recording = { bytes: Buffer; mime: string; extension: string };
type TranscriptionOwner = {
  signal: AbortSignal;
  requests: Map<string, Promise<string>>;
};

function parseRecording(params: Record<string, unknown>): Recording | undefined {
  if (
    Object.keys(params).some((key) => key !== "audioBase64" && key !== "mimeType") ||
    typeof params.audioBase64 !== "string" ||
    params.audioBase64.length > MAX_RECORDING_BASE64 ||
    typeof params.mimeType !== "string"
  ) {
    return undefined;
  }
  const mime = params.mimeType.split(";", 1)[0]?.trim().toLowerCase() ?? "";
  const extension = AUDIO_EXTENSIONS.get(mime);
  const base64 = canonicalizeBase64(params.audioBase64);
  if (!extension || base64 !== params.audioBase64) {
    return undefined;
  }
  const bytes = Buffer.from(base64, "base64");
  return bytes.length > 0 && bytes.length <= MAX_RECORDING_BYTES
    ? { bytes, mime, extension }
    : undefined;
}

/** Registers the request boundary and its restartable, joinable service owner. */
export function registerKidsTranscription(api: OpenClawPluginApi): void {
  let active: TranscriptionOwner | null = null;

  api.registerService({
    id: "kids-ui-transcription",
    apiVersion: 2,
    start({ scheduler }) {
      active = { signal: scheduler.signal, requests: new Map() };
    },
    async stop() {
      const owner = active;
      active = null;
      if (owner) {
        await Promise.allSettled(owner.requests.values());
      }
    },
  });

  api.registerGatewayMethod(
    "kids.transcribe",
    async (options) => {
      const { client, params, respond } = options;
      const owner = active;
      if (!owner || owner.signal.aborted) {
        respond(false, undefined, {
          code: "UNAVAILABLE",
          message: "Dictation is restarting. Try again shortly.",
        });
        return;
      }
      if (!client?.connId) {
        respond(false, undefined, {
          code: "FORBIDDEN",
          message: "Open Rocky and reconnect to use dictation.",
        });
        return;
      }
      const recording = parseRecording(params);
      if (!recording) {
        respond(false, undefined, {
          code: "INVALID_REQUEST",
          message: "Record up to one minute of audio, then try again.",
        });
        return;
      }
      if (owner.requests.has(client.connId) || owner.requests.size >= MAX_ACTIVE_REQUESTS) {
        respond(false, undefined, {
          code: "UNAVAILABLE",
          message: "Dictation is busy. Try again shortly.",
        });
        return;
      }
      const assertCurrent = () => {
        owner.signal.throwIfAborted();
        options.signal?.throwIfAborted();
        client.connectionSignal?.throwIfAborted();
        if (
          active !== owner ||
          client.invalidated ||
          options.hasCurrentClientAuthority?.() === false
        ) {
          throw new Error("Dictation requester is no longer current");
        }
        options.sessionMutationCommitGuard?.();
        options.sessionMutationAuthorization?.assertCurrent();
      };
      const operation = transcribeRecording(api, recording, assertCurrent);
      owner.requests.set(client.connId, operation);
      try {
        const text = await operation;
        assertCurrent();
        respond(true, { text });
      } catch {
        // Provider failures can contain credentials or private recording contents.
        // Only fixed, child-facing messages may cross this boundary.
        respond(false, undefined, {
          code: "UNAVAILABLE",
          message: "Couldn't transcribe this recording. Please try again.",
        });
      } finally {
        owner.requests.delete(client.connId);
      }
    },
    { scope: "operator.talk", profileAccess: "independent" },
  );
}

/** Keeps the owned file alive through provider settlement, including revoked callers. */
async function transcribeRecording(
  api: OpenClawPluginApi,
  recording: Recording,
  assertCurrent: () => void,
): Promise<string> {
  assertCurrent();
  await using workspace = await tempWorkspace({
    rootDir: resolvePreferredOpenClawTmpDir(),
    prefix: "kids-dictation-",
    dirMode: 0o700,
    mode: 0o600,
  });
  assertCurrent();
  const filePath = await workspace.write(`recording.${recording.extension}`, recording.bytes);
  // The media API accepts a mutable config type; cloning preserves the immutable
  // runtime snapshot while handing it an owned, otherwise unchanged copy.
  const cfg = structuredClone(api.runtime.config.current()) as OpenClawConfig;
  assertCurrent();
  const result = await api.runtime.mediaUnderstanding.runFile({
    capability: "audio",
    filePath,
    mime: recording.mime,
    cfg,
    timeoutMs: 30_000,
  });
  assertCurrent();
  const text = result.text?.trim();
  if (!text) {
    throw new Error("No transcript returned");
  }
  return text;
}
