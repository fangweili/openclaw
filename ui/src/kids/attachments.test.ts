// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createApplicationConfigCapability } from "../app/config.ts";
import { KidsAttachments } from "./attachments.ts";

/** Controlled browser I/O: real shared admission/read/payload owners stay in use. */
class ControlledReader extends EventTarget {
  static pending: ControlledReader[] = [];
  result: string | null = null;
  file?: File;
  aborted = false;

  readAsDataURL(file: File): void {
    this.file = file;
    ControlledReader.pending.push(this);
  }
  abort(): void {
    this.aborted = true;
    this.dispatchEvent(new Event("abort"));
  }
  finish(): void {
    this.result = `data:${this.file!.type};base64,c3ludGhldGlj`;
    this.dispatchEvent(new Event("load"));
  }
}

const owners: KidsAttachments[] = [];
const revoke = vi.fn();
beforeEach(() => {
  ControlledReader.pending = [];
  revoke.mockClear();
  vi.stubGlobal("FileReader", ControlledReader);
  let next = 0;
  vi.spyOn(URL, "createObjectURL").mockImplementation(() => `blob:fixture-${++next}`);
  vi.spyOn(URL, "revokeObjectURL").mockImplementation(revoke);
});
afterEach(() => {
  owners.splice(0).forEach((owner) => owner.dispose());
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
function fixture() {
  const config = createApplicationConfigCapability({ resourceBasePath: "" });
  const owner = new KidsAttachments(config, () => {});
  owners.push(owner);
  owner.connected({
    maxPayload: 1024 * 1024,
    attachments: { maxBytes: 1000, maxImageBytes: 1000 },
  });
  owner.bind("agent:student:kids:child", "session-one");
  return { owner, config };
}
const photo = () => new File(["synthetic"], "diagram.png", { type: "image/png" });
const video = () => new File(["synthetic"], "experiment.mp4", { type: "video/mp4" });

describe("kids attachment draft", () => {
  it("uses shared image/video encoding and retires only the acknowledged submission", () => {
    const { owner } = fixture();
    owner.add([photo()]);
    expect(owner.state.reading).toBe(true);
    expect(owner.prepare()).toBeNull();
    ControlledReader.pending[0]!.finish();
    const first = owner.prepare()!;
    expect(first.attachments).toEqual([
      {
        type: "image",
        mimeType: "image/png",
        fileName: "diagram.png",
        origin: "file",
        content: "c3ludGhldGlj",
      },
    ]);
    const photoUrl = owner.state.items[0]!.previewUrl;
    owner.add([video()]);
    ControlledReader.pending[1]!.finish();
    owner.accepted(first.ids);
    expect(owner.state.items.map((item) => item.name)).toEqual(["experiment.mp4"]);
    expect(revoke).toHaveBeenCalledWith(photoUrl);
    expect(owner.prepare()!.attachments[0]).toMatchObject({ type: "file", mimeType: "video/mp4" });
    expect(first.attachments[0]!.content).toBe("c3ludGhldGlj");
  });

  it("cancels reads on disconnect, retains ready bytes only for the same backing session, and fences late completion", () => {
    const { owner } = fixture();
    owner.add([photo(), video()]);
    const [ready, pending] = ControlledReader.pending;
    ready!.finish();
    const held = owner.prepare();
    expect(held).toBeNull();
    const url = owner.state.items[0]!.previewUrl;
    owner.disconnect();
    expect(pending!.aborted).toBe(true);
    pending!.finish();
    expect(owner.state.items).toHaveLength(1);
    owner.bind("agent:student:kids:child", "session-one");
    expect(owner.prepare()!.attachments).toHaveLength(1);
    owner.bind("agent:student:kids:child", "session-reset");
    expect(owner.state.items).toHaveLength(0);
    expect(revoke).toHaveBeenCalledWith(url);
    owner.add([video()]);
    const last = ControlledReader.pending.at(-1)!;
    owner.dispose();
    last.finish();
    expect(last.aborted).toBe(true);
    expect(owner.state.items).toHaveLength(0);
  });

  it("keeps a failed file visible and outside a ready file's submission and acknowledgment", () => {
    const { owner } = fixture();
    owner.add([photo(), video()]);
    const failedId = owner.state.items[1]!.id;
    ControlledReader.pending[0]!.finish();
    ControlledReader.pending[1]!.dispatchEvent(new Event("error"));
    expect(owner.state.reading).toBe(false);
    expect(owner.state.items.map((item) => item.status)).toEqual(["ready", "error"]);

    const submission = owner.prepare()!;
    expect(submission.attachments.map((item) => item.fileName)).toEqual(["diagram.png"]);
    expect(submission.ids).not.toContain(failedId);
    owner.accepted(submission.ids);
    expect(owner.state.items).toEqual([
      expect.objectContaining({ id: failedId, name: "experiment.mp4", status: "error" }),
    ]);
  });

  it("removal cancels its read without disturbing another and disabled uploads retain recovery bytes", () => {
    const { owner, config } = fixture();
    owner.add([photo(), video()]);
    const removed = owner.state.items[0]!.id;
    owner.remove(removed);
    ControlledReader.pending[0]!.finish();
    expect(owner.state.reading).toBe(true);
    ControlledReader.pending[1]!.finish();
    expect(owner.state.items).toHaveLength(1);
    config.current.uploadsEnabled = false;
    expect(owner.prepare()).toBeNull();
    expect(owner.state.error).toMatch(/uploads.*disabled/i);
    config.current.uploadsEnabled = true;
    expect(owner.prepare()!.attachments).toHaveLength(1);
  });
});
