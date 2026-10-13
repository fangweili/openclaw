/**
 * Owns media reads for one verified kids conversation. Mounted previews lease a
 * source only while near the viewport; at most two downloads run concurrently.
 * The shared artifact API owns authorization and HTTP/inline delivery. Images
 * retain object URLs; videos use short-lived same-origin grants and native
 * range playback, without copying the video into browser memory.
 *
 * Bind after identity verification. Disconnect/rebind retires every lease,
 * aborts reads, and revokes image URLs synchronously. Dispose also joins reads
 * before the app stops its Gateway client. Failed media retries only on request.
 */
import { downloadArtifact, isHttpArtifactDownloadUrl } from "../api/artifact-download.ts";
import type { GatewayBrowserClient } from "../api/gateway.ts";
import { isManagedOutgoingMediaSource } from "../pages/chat/components/chat-message-attachment-availability.ts";
import type { KidsMedia } from "./media.ts";

export type KidsMediaScope = { agentId: string; sessionKey: string; sessionId: string };
export type KidsMediaPreview =
  | { status: "idle" | "loading" | "error" }
  | { status: "ready"; url: string };

/** A mounted preview owns this lease and must release it when removed. */
export type KidsMediaLease = {
  setVisible(visible: boolean): void;
  retry(): void;
  failed(): void;
  release(): void;
};

type Entry = {
  media: KidsMedia;
  visible: boolean;
  state: KidsMediaPreview;
  changed: (state: KidsMediaPreview) => void;
  abort?: AbortController;
  objectUrl?: string;
};

const IMAGE_MIME = /^image\/(?:png|jpeg|gif|webp|avif)$/u;

export class KidsHistoryMedia {
  private scope?: KidsMediaScope;
  private readonly host: {
    connected: boolean;
    client: GatewayBrowserClient;
    connectionEpoch: number;
  };
  private readonly entries = new Set<Entry>();
  private readonly queue = new Set<Entry>();
  private readonly reads = new Set<Promise<void>>();
  private disposed = false;

  /** Construction has no network effects; the app keeps client alive through dispose. */
  constructor(client: GatewayBrowserClient) {
    this.host = { connected: false, client, connectionEpoch: 0 };
  }

  /** Renderers use this fence to replace leases after reconnect or session reset. */
  get generation(): number {
    return this.host.connectionEpoch;
  }

  /** Bind verified session identity; repeating the same live binding is a no-op. */
  bind(scope: KidsMediaScope): void {
    if (
      this.disposed ||
      (this.scope?.agentId === scope.agentId &&
        this.scope.sessionKey === scope.sessionKey &&
        this.scope.sessionId === scope.sessionId)
    ) {
      return;
    }
    this.disconnect();
    this.scope = { ...scope };
    this.host.connected = true;
  }

  /** Retire old authority immediately; no pending completion may publish afterward. */
  disconnect(): void {
    this.host.connected = false;
    this.host.connectionEpoch += 1;
    this.scope = undefined;
    for (const entry of this.entries) {
      this.release(entry);
      entry.changed({ status: "idle" });
    }
  }

  /** Stop admission, invalidate resources, then join all bounded artifact requests. */
  async dispose(): Promise<void> {
    this.disposed = true;
    this.disconnect();
    await Promise.all(this.reads);
  }

  /** Create an initially hidden lease. Visibility starts reads; hiding releases its source. */
  acquire(media: KidsMedia, changed: (state: KidsMediaPreview) => void): KidsMediaLease {
    const entry: Entry = { media, visible: false, state: { status: "idle" }, changed };
    if (this.scope && !this.disposed && media.artifactId) {
      this.entries.add(entry);
    }
    return {
      setVisible: (visible) => {
        if (!this.entries.has(entry) || visible === entry.visible) {
          return;
        }
        entry.visible = visible;
        if (visible) {
          this.enqueue(entry);
        } else {
          this.cancel(entry);
          this.publish(entry, { status: "idle" });
        }
      },
      retry: () => {
        if (entry.state.status === "error") {
          this.enqueue(entry);
        }
      },
      failed: () => {
        if (this.entries.has(entry) && entry.state.status === "ready") {
          this.cancel(entry);
          this.publish(entry, { status: "error" });
        }
      },
      release: () => this.release(entry),
    };
  }

  private publish(entry: Entry, state: KidsMediaPreview): void {
    entry.state = state;
    entry.changed(state);
  }

  private cancel(entry: Entry): void {
    this.queue.delete(entry);
    entry.abort?.abort();
    entry.abort = undefined;
    if (entry.objectUrl) {
      URL.revokeObjectURL(entry.objectUrl);
      entry.objectUrl = undefined;
    }
  }

  private release(entry: Entry): void {
    this.entries.delete(entry);
    this.cancel(entry);
  }

  private enqueue(entry: Entry): void {
    if (!this.entries.has(entry) || !entry.visible || !this.scope) {
      return;
    }
    this.publish(entry, { status: "loading" });
    this.queue.add(entry);
    this.pump();
  }

  private pump(): void {
    while (this.scope && this.reads.size < 2 && this.queue.size) {
      const entry = this.queue.values().next().value!;
      this.queue.delete(entry);
      const task = this.load(entry, this.scope).finally(() => {
        this.reads.delete(task);
        this.pump();
      });
      this.reads.add(task);
    }
  }

  private async load(entry: Entry, scope: KidsMediaScope): Promise<void> {
    const abort = new AbortController();
    entry.abort = abort;
    const current = () => this.entries.has(entry) && entry.abort === abort && !abort.signal.aborted;
    try {
      const result = await downloadArtifact(
        this.host,
        {
          sessionKey: scope.sessionKey,
          agentId: scope.agentId,
          artifactId: entry.media.artifactId!,
        },
        abort.signal,
      );
      if (!current()) {
        return;
      }
      const mime = result?.artifact.mimeType?.split(";", 1)[0]?.trim().toLowerCase() ?? "";
      const authorizedUrl =
        result?.url &&
        (isHttpArtifactDownloadUrl(result.url) || isManagedOutgoingMediaSource(result.url))
          ? result.url
          : undefined;
      let url: string | undefined;
      if (entry.media.kind === "image" && IMAGE_MIME.test(mime)) {
        if (result?.blob && IMAGE_MIME.test(result.blob.type)) {
          entry.objectUrl = URL.createObjectURL(result.blob);
          url = entry.objectUrl;
        } else if (result?.encoding === "base64" && result.data) {
          url = `data:${mime};base64,${result.data}`;
        } else {
          url = authorizedUrl;
        }
      } else if (entry.media.kind === "video" && mime.startsWith("video/")) {
        url = authorizedUrl;
      }
      this.publish(entry, url ? { status: "ready", url } : { status: "error" });
    } catch {
      if (current()) {
        this.publish(entry, { status: "error" });
      }
    }
  }
}
