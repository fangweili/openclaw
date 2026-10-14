// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { useRealtimeTalkMicrophoneFixture } from "../pages/chat/talk/input.test-support.ts";
import { createTestGatewayClient } from "../test-helpers/gateway-client.ts";
import { KidsDictation } from "./dictation.ts";

/** Models browser recorder ordering: stop() releases recording synchronously,
 * then the browser emits the final audio chunk before its stop event. */
class Recorder extends EventTarget {
  static instances: Recorder[] = [];
  static isTypeSupported = vi.fn((type: string) => type === "audio/webm;codecs=opus");
  state: RecordingState = "inactive";
  mimeType: string;
  flush = true;
  finalAudio = new Blob([new Uint8Array([1, 2, 3])]);
  start = vi.fn(() => {
    this.state = "recording";
  });
  stop = vi.fn(() => {
    this.state = "inactive";
    if (this.flush) {
      queueMicrotask(() => {
        this.audio(this.finalAudio);
        this.dispatchEvent(new Event("stop"));
      });
    }
  });

  constructor(
    readonly stream: MediaStream,
    readonly options: MediaRecorderOptions,
  ) {
    super();
    this.mimeType = options.mimeType!;
    Recorder.instances.push(this);
  }

  audio(data: Blob): void {
    this.dispatchEvent(Object.assign(new Event("dataavailable"), { data }));
  }
}

useRealtimeTalkMicrophoneFixture();

describe("kids reviewable dictation owner", () => {
  const owners: KidsDictation[] = [];
  function create(request = vi.fn(async () => ({ text: "Help with fractions" }))) {
    const onState = vi.fn();
    const onCommit = vi.fn();
    const owner = new KidsDictation(createTestGatewayClient(request), onState, onCommit);
    owners.push(owner);
    return { owner, request, onState, onCommit };
  }

  beforeEach(() => {
    Recorder.instances = [];
    Recorder.isTypeSupported
      .mockReset()
      .mockImplementation((type) => type === "audio/webm;codecs=opus");
    vi.stubGlobal("MediaRecorder", Recorder);
    vi.stubGlobal("document", Object.assign(new EventTarget(), { visibilityState: "visible" }));
    vi.stubGlobal("window", new EventTarget());
  });

  afterEach(async () => {
    await Promise.all(owners.splice(0).map((owner) => owner.dispose()));
    vi.useRealTimers();
  });

  it("commits one complete draft after recorder flush and never sends a chat message", async () => {
    const { owner, request, onCommit } = create();
    const starting = owner.start();
    expect(owner.start()).toBe(starting);
    await starting;
    const recorder = Recorder.instances[0]!;
    const stopTrack = vi.spyOn(recorder.stream.getTracks()[0]!, "stop");
    recorder.flush = false;
    recorder.audio(new Blob([new Uint8Array([1, 2])]));
    expect(owner.state).toMatchObject({ active: true, finishing: false });
    const finishing = owner.finish();
    expect(owner.finish()).toBe(finishing);
    expect(stopTrack).toHaveBeenCalledOnce();
    expect(request).not.toHaveBeenCalled();
    expect(onCommit).not.toHaveBeenCalled();
    recorder.audio(new Blob([new Uint8Array([3])]));
    recorder.dispatchEvent(new Event("stop"));
    await finishing;
    expect(request).toHaveBeenCalledExactlyOnceWith(
      "kids.transcribe",
      { audioBase64: "AQID", mimeType: "audio/webm" },
      { timeoutMs: null },
    );
    expect(onCommit).toHaveBeenCalledExactlyOnceWith("Help with fractions");
    expect(owner.state).toEqual({ active: false, finishing: false, detail: null });
  });

  it("cancels pending microphone permission without requesting transcription and stops a late stream", async () => {
    const permission = createDeferred<MediaStream>();
    const track = Object.assign(new EventTarget(), { stop: vi.fn() });
    vi.spyOn(navigator.mediaDevices, "getUserMedia").mockReturnValue(permission.promise);
    const { owner, request, onCommit } = create();
    const starting = owner.start();
    expect(owner.state).toMatchObject({ active: true, finishing: false });
    await owner.finish();
    await starting;
    permission.resolve({
      getTracks: () => [track],
      getAudioTracks: () => [track],
    } as unknown as MediaStream);
    await permission.promise;
    expect(track.stop).toHaveBeenCalledOnce();
    expect(Recorder.instances).toHaveLength(0);
    expect(request).not.toHaveBeenCalled();
    expect(onCommit).not.toHaveBeenCalled();
  });

  it("joins an accepted transcription after disposal while fencing its result", async () => {
    const response = createDeferred<{ text: string }>();
    const accepted = createDeferred();
    const { owner, onCommit, onState } = create(
      vi.fn(() => {
        accepted.resolve();
        return response.promise;
      }),
    );
    await owner.start();
    const finishing = owner.finish();
    await accepted.promise;
    let disposed = false;
    const disposing = owner.dispose().then(() => {
      disposed = true;
    });
    const stateCount = onState.mock.calls.length;
    await Promise.resolve();
    expect(disposed).toBe(false);
    response.resolve({ text: "Words from the retired child" });
    await Promise.all([finishing, disposing]);
    expect(onCommit).not.toHaveBeenCalled();
    expect(onState).toHaveBeenCalledTimes(stateCount);
  });

  it.each(["visibilitychange", "pagehide"])(
    "discards recording on %s without affecting the draft",
    async (event) => {
      const { owner, request, onCommit } = create();
      await owner.start();
      const recorder = Recorder.instances[0]!;
      const stopTrack = vi.spyOn(recorder.stream.getTracks()[0]!, "stop");
      if (event === "visibilitychange") {
        Object.defineProperty(document, "visibilityState", { value: "hidden" });
        document.dispatchEvent(new Event(event));
      } else {
        window.dispatchEvent(new Event(event));
      }
      await owner.finish();
      expect(stopTrack).toHaveBeenCalledOnce();
      expect(owner.state.active).toBe(false);
      expect(request).not.toHaveBeenCalled();
      expect(onCommit).not.toHaveBeenCalled();
    },
  );

  it("keeps microphone permission focus changes recording and supports Safari's MP4 format", async () => {
    Recorder.isTypeSupported.mockImplementation((type) => type === "audio/mp4");
    const { owner, request } = create();
    await owner.start();
    window.dispatchEvent(new Event("blur"));
    expect(owner.state.active).toBe(true);
    await owner.finish();
    expect(request).toHaveBeenCalledWith(
      "kids.transcribe",
      expect.objectContaining({ mimeType: "audio/mp4" }),
      expect.anything(),
    );
  });

  it("rejects oversized audio without transcribing a partial recording", async () => {
    const { owner, request, onCommit } = create();
    await owner.start();
    Recorder.instances[0]!.audio(new Blob([new Uint8Array(1024 * 1024 + 1)]));
    await owner.finish();
    expect(owner.state).toMatchObject({
      active: false,
      finishing: false,
      detail: expect.any(String),
    });
    expect(request).not.toHaveBeenCalled();
    expect(onCommit).not.toHaveBeenCalled();
  });

  it("automatically finishes after one minute and leaves an editable transcription", async () => {
    vi.useFakeTimers();
    const { owner, onCommit } = create();
    await owner.start();
    await vi.advanceTimersByTimeAsync(60_000);
    await owner.finish();
    expect(onCommit).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("bounds a recorder that never flushes without uploading incomplete audio", async () => {
    vi.useFakeTimers();
    const { owner, request } = create();
    await owner.start();
    Recorder.instances[0]!.flush = false;
    const finishing = owner.finish();
    await vi.advanceTimersByTimeAsync(5_000);
    await finishing;
    expect(owner.state).toMatchObject({
      active: false,
      finishing: false,
      detail: expect.any(String),
    });
    expect(request).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(["track-ended", "recorder-error"])(
    "stops and reports %s without uploading audio",
    async (failure) => {
      const { owner, request } = create();
      await owner.start();
      const recorder = Recorder.instances[0]!;
      if (failure === "track-ended") {
        recorder.stream.getTracks()[0]!.dispatchEvent(new Event("ended"));
      } else {
        recorder.dispatchEvent(new Event("error"));
      }
      await owner.finish();
      expect(owner.state).toMatchObject({
        active: false,
        finishing: false,
        detail: expect.any(String),
      });
      expect(request).not.toHaveBeenCalled();
    },
  );

  it("preserves the draft when the provider fails or returns no words", async () => {
    for (const response of [
      Promise.reject(new Error("Transcription unavailable")),
      Promise.resolve({ text: "  " }),
    ]) {
      const { owner, onCommit } = create(vi.fn(() => response));
      await owner.start();
      await owner.finish();
      expect(onCommit).not.toHaveBeenCalled();
      expect(owner.state.detail).toBeTruthy();
    }
  });

  it("fails before requesting microphone access when recording is unsupported", async () => {
    Recorder.isTypeSupported.mockReturnValue(false);
    const getUserMedia = vi.spyOn(navigator.mediaDevices, "getUserMedia");
    const { owner, request } = create();
    await owner.start();
    expect(getUserMedia).not.toHaveBeenCalled();
    expect(owner.state.detail).toBeTruthy();
    expect(request).not.toHaveBeenCalled();
  });
});
