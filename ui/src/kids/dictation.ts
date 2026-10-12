/**
 * One reviewable voice draft on one authenticated kids connection. The shared
 * input controller owns microphone acquisition and late permission cleanup;
 * this owner holds the recorder, bounded audio, and one transcription request.
 * It never sends a chat message or chooses a provider. A new recording requires
 * a new owner, so callbacks cannot migrate between tutors or composer drafts.
 *
 * Finish stops capture synchronously, then joins recorder flush and transcription.
 * Hidden/pagehide/disposal discard the recording and fence results immediately.
 * Disposal joins startup and any accepted RPC before the app retires its client.
 * Browser permission itself cannot be dismissed; the shared input owner releases
 * any stream granted after cancellation. All other listeners and buffers end
 * with this owner's single operation; no audio is stored outside memory.
 */
import { raceWithTimeout } from "@openclaw/retry";
import type { GatewayBrowserClient } from "../api/gateway.ts";
import { t } from "../i18n/index.ts";
import { registerKidsEnglish } from "../i18n/locales/en-kids.ts";
import { bytesToBase64 } from "../lib/bytes-base64.ts";
import { formatUiError } from "../lib/format-error.ts";
import { RealtimeTalkInputController } from "../pages/chat/talk/input.ts";

registerKidsEnglish();

const MAX_AUDIO_BYTES = 1024 * 1024;
const RECORDING_MS = 60_000;
const RECORDER_SETTLE_MS = 5_000;
const MIME_TYPES = [
  "audio/webm;codecs=opus",
  "audio/mp4;codecs=mp4a.40.2",
  "audio/mp4",
  "audio/ogg;codecs=opus",
  "audio/ogg",
];

export type KidsDictationState = {
  active: boolean;
  finishing: boolean;
  detail: string | null;
};

export class KidsDictation {
  private readonly cancellation = new AbortController();
  private readonly input = new RealtimeTalkInputController((detail) => this.cancel(detail));
  private started = false;
  private disposed = false;
  private startup: Promise<void> = Promise.resolve();
  private closing: Promise<void> | null = null;
  private recorder: MediaRecorder | null = null;
  private stopped: Promise<void> = Promise.resolve();
  private resolveStopped: (() => void) | null = null;
  private chunks: Blob[] = [];
  private bytes = 0;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private snapshot: KidsDictationState = { active: false, finishing: false, detail: null };

  /** The app owns client lifetime. Callbacks must not throw; commit only edits its captured draft. */
  constructor(
    private readonly client: GatewayBrowserClient,
    private readonly onState: (state: KidsDictationState) => void,
    private readonly onCommit: (text: string) => void,
  ) {}

  get state(): KidsDictationState {
    return this.snapshot;
  }

  /** Start from a user gesture; repeated calls join startup. This owner cannot be reused after stop. */
  start(): Promise<void> {
    if (this.disposed || this.cancellation.signal.aborted || this.closing) {
      return Promise.reject(new Error(t("kids.dictation.failed")));
    }
    if (this.started) {
      return this.startup;
    }
    this.started = true;
    this.startup = this.open();
    return this.startup;
  }

  /**
   * Stop capture immediately and commit one completed transcription, never partial
   * audio. Repeated calls join completion; during permission acquisition this
   * cancels without a request. Operational errors resolve with visible detail.
   */
  finish(): Promise<void> {
    if (this.closing) {
      return this.closing;
    }
    const recorder = this.recorder;
    if (!recorder || this.cancellation.signal.aborted) {
      this.cancel();
      return this.startup;
    }
    clearTimeout(this.timer);
    this.publish({ active: false, finishing: true, detail: null });
    try {
      recorder.stop();
    } catch (error) {
      this.cancel(formatUiError(error));
    }
    this.input.stop();
    this.closing = this.transcribe(recorder);
    return this.closing;
  }

  /** Permanently fence callbacks and stop capture now, then join all admitted work. Idempotent. */
  async dispose(): Promise<void> {
    this.disposed = true;
    this.cancel();
    await this.startup;
    await this.closing;
  }

  private async open(): Promise<void> {
    try {
      const mimeType =
        typeof MediaRecorder === "undefined"
          ? undefined
          : MIME_TYPES.find((mime) => MediaRecorder.isTypeSupported(mime));
      if (!mimeType) {
        throw new Error(t("kids.dictation.unsupported"));
      }
      const { signal } = this.cancellation;
      document.addEventListener("visibilitychange", this.onVisibility, { signal });
      window.addEventListener("pagehide", this.onPageHide, { signal });
      if (document.visibilityState === "hidden") {
        this.cancel();
        return;
      }
      this.publish({ active: true, finishing: false, detail: null });
      signal.throwIfAborted();
      const stream = await this.input.open(undefined);
      if (signal.aborted) {
        this.input.stop();
        return;
      }
      const recorder = new MediaRecorder(stream, { mimeType, audioBitsPerSecond: 64_000 });
      this.recorder = recorder;
      this.stopped = new Promise((resolve) => {
        this.resolveStopped = resolve;
      });
      recorder.addEventListener("dataavailable", this.onData, { signal });
      recorder.addEventListener("stop", this.onStop, { signal });
      recorder.addEventListener("error", this.onError, { signal });
      recorder.start(1_000);
      this.timer = setTimeout(() => void this.finish(), RECORDING_MS);
    } catch (error) {
      if (!this.cancellation.signal.aborted) {
        this.cancel(formatUiError(error));
      }
    }
  }

  private readonly onData = (event: BlobEvent): void => {
    if (this.bytes + event.data.size > MAX_AUDIO_BYTES) {
      this.cancel(t("kids.dictation.tooLarge"));
      return;
    }
    this.bytes += event.data.size;
    this.chunks.push(event.data);
  };

  private readonly onStop = (): void => {
    this.resolveStopped?.();
    if (!this.snapshot.finishing) {
      this.cancel(t("kids.dictation.failed"));
    }
  };

  private readonly onError = (): void => this.cancel(t("kids.dictation.failed"));
  private readonly onVisibility = (): void => {
    if (document.visibilityState === "hidden") {
      this.cancel();
    }
  };
  private readonly onPageHide = (): void => this.cancel();

  private async transcribe(recorder: MediaRecorder): Promise<void> {
    const { signal } = this.cancellation;
    const timeout = () => {
      throw new Error(t("kids.dictation.failed"));
    };
    try {
      await raceWithTimeout(this.stopped, RECORDER_SETTLE_MS, timeout, { signal });
      signal.throwIfAborted();
      if (this.bytes === 0) {
        throw new Error(t("kids.dictation.noSpeech"));
      }
      const mimeType = recorder.mimeType.split(";", 1)[0]!;
      const audio = new Blob(this.chunks, { type: mimeType });
      this.chunks = [];
      const buffer = await raceWithTimeout(audio.arrayBuffer(), RECORDER_SETTLE_MS, timeout, {
        signal,
      });
      signal.throwIfAborted();
      // The server media owner applies configured per-provider deadlines and
      // fallbacks. A second browser deadline must not discard a valid late result.
      const result = await this.client.request<{ text: string }>(
        "kids.transcribe",
        { audioBase64: bytesToBase64(new Uint8Array(buffer)), mimeType },
        { timeoutMs: null },
      );
      // An accepted request stays joined even after disposal; only its current
      // recording may contribute words to the captured composer draft.
      if (!signal.aborted) {
        const text = result.text.trim();
        if (!text) {
          throw new Error(t("kids.dictation.noSpeech"));
        }
        this.onCommit(text);
        this.publish({ active: false, finishing: false, detail: null });
      }
    } catch (error) {
      if (!signal.aborted) {
        this.publish({ active: false, finishing: false, detail: formatUiError(error) });
      }
    } finally {
      this.cancellation.abort();
      this.input.stop();
      this.recorder = null;
      this.resolveStopped = null;
      this.chunks = [];
      this.bytes = 0;
    }
  }

  /** Cancel synchronously; only dispose joins an RPC already admitted by finish. */
  private cancel(detail: string | null = null): void {
    if (this.cancellation.signal.aborted) {
      return;
    }
    this.cancellation.abort();
    clearTimeout(this.timer);
    this.input.stop();
    let failure = detail;
    if (this.recorder?.state === "recording" || this.recorder?.state === "paused") {
      try {
        this.recorder.stop();
      } catch (error) {
        // Capture is already released. A broken recorder cannot prevent the
        // owner from discarding its buffers and retiring the connection.
        failure ??= formatUiError(error);
      }
    }
    this.recorder = null;
    this.resolveStopped?.();
    this.resolveStopped = null;
    this.chunks = [];
    this.bytes = 0;
    this.publish({ active: false, finishing: false, detail: failure });
  }

  private publish(state: KidsDictationState): void {
    this.snapshot = state;
    if (!this.disposed) {
      this.onState(state);
    }
  }
}
