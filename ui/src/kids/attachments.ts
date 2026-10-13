import type { GatewayHelloOk } from "../api/gateway.ts";
/**
 * Owns one memory-only photo/video draft for a verified tutor conversation.
 * Shared chat owners perform admission, bounded reads/resizing, encoding and URL
 * management. This owner controls membership and releases only its own payloads.
 * Disconnect cancels unfinished reads; ready files remain hidden until the same
 * binding is verified. A different backing session or disposal releases all files.
 * Acknowledgment consumes submitted IDs only, preserving later draft additions.
 */
import type { ApplicationConfigCapability } from "../app/config.ts";
import { t } from "../i18n/index.ts";
import { registerKidsEnglish } from "../i18n/locales/en-kids.ts";
import type { ChatAttachment } from "../lib/chat/chat-types.ts";
import { uploadsEnabled } from "../lib/uploads.ts";
import { buildChatApiAttachments } from "../pages/chat/attachment-api.ts";
import {
  getChatAttachmentPreviewUrl,
  releaseChatAttachmentPayloads,
} from "../pages/chat/attachment-payload-store.ts";
import {
  attachmentBatchRejection,
  resolveChatAttachmentLimits,
} from "../pages/chat/components/chat-attachment-admission.ts";
import { ChatAttachmentReadLifecycle } from "../pages/chat/components/chat-attachment-reads.ts";
import { appendChatAttachmentFiles } from "../pages/chat/components/chat-attachments.ts";
import { buildLocalUserMessage } from "../pages/chat/user-message-content.ts";

registerKidsEnglish();

export type KidsAttachmentSubmission = {
  ids: readonly string[];
  content: NonNullable<ReturnType<typeof buildLocalUserMessage>>["content"];
  attachments: NonNullable<ReturnType<typeof buildChatApiAttachments>>;
};
export type KidsAttachmentState = {
  items: readonly {
    id: string;
    name: string;
    kind: "image" | "video";
    status: "reading" | "ready" | "error";
    previewUrl: string | null;
  }[];
  reading: boolean;
  allowed: boolean;
  error: string | null;
};

export class KidsAttachments {
  private files: ChatAttachment[] = [];
  private readonly reads: ChatAttachmentReadLifecycle;
  private policy: GatewayHelloOk["policy"];
  private binding = "";
  private error: string | null = null;
  private disposed = false;

  /** Construct without reads or network effects; notify must not throw. */
  constructor(
    private readonly config: ApplicationConfigCapability,
    private readonly notify: () => void,
  ) {
    this.reads = new ChatAttachmentReadLifecycle(notify);
  }

  /** Present only while the app's authenticated conversation is ready. */
  get state(): KidsAttachmentState {
    return {
      items: this.reads.project(this.files).map(({ attachment, state }) => ({
        id: attachment.id,
        name: attachment.fileName ?? t("kids.attachments.file"),
        kind: attachment.mimeType.startsWith("video/") ? "video" : "image",
        status: state,
        previewUrl: state === "ready" ? getChatAttachmentPreviewUrl(attachment) : null,
      })),
      reading: this.reads.pendingReads > 0,
      allowed: uploadsEnabled(this.config),
      error: this.error,
    };
  }

  /** Install the current Gateway's advertised attachment limits. */
  connected(policy: GatewayHelloOk["policy"]): void {
    this.policy = policy;
  }

  /** Verified logical and backing identity own the draft; rebinding destroys the old draft. */
  bind(sessionKey: string, sessionId: string): void {
    const binding = `${sessionKey}\0${sessionId}`;
    if (binding !== this.binding) {
      this.clear();
      this.binding = binding;
    }
  }

  /** Select photos/videos only; the shared reader retains and reports individual failures. */
  add(files: readonly File[]): void {
    if (this.disposed || !this.binding) {
      return;
    }
    this.error = files.some((file) => !/^(image|video)\//u.test(file.type))
      ? t("kids.attachments.unsupported")
      : null;
    const readSignal = this.reads.readSignal;
    appendChatAttachmentFiles(
      files.filter((file) => /^(image|video)\//u.test(file.type)),
      {
        uploadConfig: this.config,
        attachmentLimits: resolveChatAttachmentLimits(this.policy),
        attachmentReads: this.reads,
        readSignal,
        getAttachments: () => this.files,
        onAttachmentsChange: (attachments) => {
          this.files = attachments;
          this.notify();
        },
        onPendingReadsChange: (delta) => this.reads.updatePending(readSignal, delta),
      },
    );
    this.notify();
  }

  /** Removal cancels a pending read and revokes its preview before notifying the view. */
  remove(id: string): void {
    const entry = this.reads.project(this.files).find((item) => item.attachment.id === id);
    this.files = this.files.filter((attachment) => attachment.id !== id);
    if (entry) {
      this.reads.remove(entry);
      releaseChatAttachmentPayloads([entry.attachment]);
    }
    this.notify();
  }

  /** Freeze encoded bytes once for send/retry; failed validation leaves the draft intact. */
  prepare(): KidsAttachmentSubmission | null {
    if (this.disposed || this.reads.pendingReads) {
      return null;
    }
    this.error =
      this.files.length && !uploadsEnabled(this.config)
        ? t("common.uploadsDisabled")
        : (attachmentBatchRejection(this.files, this.policy) ?? null);
    if (this.error) {
      this.notify();
      return null;
    }
    try {
      return {
        ids: this.files.map(({ id }) => id),
        attachments: buildChatApiAttachments(this.files) ?? [],
        content:
          buildLocalUserMessage({ text: "", attachments: this.files, createdAt: Date.now() })
            ?.content ?? [],
      };
    } catch {
      this.error = t("kids.attachments.failed");
      this.notify();
      return null;
    }
  }

  /** A current conversation's acceptance releases only the submitted payload IDs. */
  accepted(ids: readonly string[]): void {
    const submitted = new Set(ids);
    const removed = this.files.filter(({ id }) => submitted.has(id));
    this.files = this.files.filter(({ id }) => !submitted.has(id));
    releaseChatAttachmentPayloads(removed);
    this.reads.project(this.files);
    this.notify();
  }

  /** Abort unfinished work immediately; retain completed files for the same verified session. */
  disconnect(): void {
    this.reads.abortReads();
  }

  /** Idempotent destruction; shared cancellation fences late FileReader/resize completions. */
  dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    this.clear();
  }

  private clear(): void {
    releaseChatAttachmentPayloads(this.files);
    this.files = [];
    this.reads.abortReads();
    this.error = null;
    this.notify();
  }
}
