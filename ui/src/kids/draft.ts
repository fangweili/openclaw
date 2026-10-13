/**
 * Owns one verified kids composer's unsent text. The shared composer store owns
 * IndexedDB, expiry, and compare-and-swap writes; this owner adds physical-session
 * isolation and a serialized, coalescing lifecycle. Attachments and uncertain
 * sends belong to their existing memory-only owners. Restoring never sends.
 *
 * Construction is inert. Bind only after authentication resolves a profile-
 * qualified session key and its backing session ID. Until restore settles the
 * composer is not editable. Disconnect hides text immediately, retaining it for
 * that same identity. Rebinding drains an old edit before restoring the newest
 * identity; there is one store operation and at most one pending binding, never
 * an edit queue. One acknowledged restore is retained until its original scope
 * is cleared. Dispose fences callbacks and joins admitted saves and clears.
 *
 * Storage failure or another tab's write leaves local text editable in memory
 * and reports saveError. This owner never retries against an unknown revision
 * or overwrites another tab's draft. The app renders the error; reopening can
 * restore the last successfully saved text under the store's seven-day expiry.
 */
import {
  readDurableComposerDraft,
  writeDurableComposerDraft,
  type DurableComposerDraftScope,
} from "../lib/chat/composer-draft-store.runtime.ts";

export type KidsDraftIdentity = {
  gatewayUrl: string;
  /** Verified key includes the child's profile; never pass an unverified URL hint. */
  sessionKey: string;
  sessionId: string;
};

/** Current visible text and persistence outcome; hidden identities project empty text. */
export type KidsDraftState = {
  text: string;
  ready: boolean;
  saveError: "storage-failed" | "conflict" | null;
};

type Entry = KidsDraftState & {
  scope: DurableComposerDraftScope;
  identity: string;
  revision: number;
  writeId?: string;
  dirty: boolean;
  acceptedText?: string;
};

export class KidsDraft {
  private entry: Entry | null = null;
  private visible = false;
  private disposed = false;
  private worker: Promise<void> | null = null;
  private acknowledgedRestore: Entry | null = null;

  /** The app owns this instance and must join dispose. The callback must not throw. */
  constructor(private readonly onState: (state: KidsDraftState) => void) {}

  /** Returns a detached presentation snapshot; only this owner mutates the draft. */
  get state(): KidsDraftState {
    const entry = this.visible && !this.disposed ? this.entry : null;
    return {
      text: entry?.text ?? "",
      ready: entry?.ready ?? false,
      saveError: entry?.saveError ?? null,
    };
  }

  /**
   * Bind an authenticated identity and join restoration. Repeated same-identity
   * calls preserve current edits. A newer bind supersedes a pending restore;
   * its result cannot publish into this identity. Errors resolve through state.
   */
  bind(identity: KidsDraftIdentity): Promise<void> {
    if (this.disposed) {
      return Promise.resolve();
    }
    const key = JSON.stringify([identity.gatewayUrl, identity.sessionKey, identity.sessionId]);
    if (this.entry?.identity !== key) {
      this.entry = {
        identity: key,
        scope: {
          gatewayOwner: identity.gatewayUrl,
          recoveryScope: `kids:${identity.sessionKey}`,
          scopeKey: `kids-text:v1:${identity.sessionId}`,
        },
        text: "",
        ready: false,
        saveError: null,
        revision: 0,
        dirty: false,
      };
    }
    this.visible = true;
    const restoring = this.work();
    this.publish();
    return restoring;
  }

  /**
   * Replace ready, visible text synchronously and schedule its latest value for
   * saving. Calls before restore, while disconnected, or after disposal are no-ops.
   * Coalescing retains at most one latest edit behind the in-flight write.
   */
  update(text: string): void {
    const entry = this.entry;
    if (!this.visible || this.disposed || !entry?.ready || entry.text === text) {
      return;
    }
    entry.text = text;
    entry.dirty = true;
    void this.work();
    this.publish();
  }

  /**
   * Retire text acknowledged by the current physical session. The conversation
   * owner admits one unresolved send and fences acknowledgements from other
   * sessions before calling this. A ready draft clears synchronously; a pending
   * restore retains one acknowledgment and applies it before publishing text.
   * Newer differing edits survive; whitespace matches the existing send contract.
   * Once admitted, the original scope's clear survives disconnect, rebind, and
   * disposal. Calls while disconnected or after disposal admit no new work.
   */
  accepted(text: string): void {
    const entry = this.entry;
    if (!this.visible || this.disposed || !entry) {
      return;
    }
    if (!entry.ready) {
      entry.acceptedText = text;
      // The conversation cannot send again until this draft is ready. Retain
      // this single receipt even if a newer, unready binding coalesces past it.
      this.acknowledgedRestore = entry;
      return;
    }
    if (entry.text.trim() === text.trim()) {
      this.update("");
    }
  }

  /** Hide unverified text synchronously; pending saves keep their captured identity. */
  disconnect(): void {
    this.visible = false;
    this.publish();
  }

  /** Stop admission/callbacks synchronously, then join accepted I/O. Idempotent. */
  async dispose(): Promise<void> {
    this.disposed = true;
    this.visible = false;
    while (this.worker) {
      await this.worker;
    }
    this.entry = null;
  }

  private publish(): void {
    if (!this.disposed) {
      this.onState(this.state);
    }
  }

  private work(): Promise<void> {
    if (!this.worker) {
      const admitted = this.acknowledgedRestore ?? this.entry;
      this.worker = Promise.resolve().then(() => this.drain(admitted));
    }
    return this.worker;
  }

  private async drain(admitted: Entry | null): Promise<void> {
    let entry = admitted;
    try {
      while (entry) {
        if (!entry.ready) {
          const result = await readDurableComposerDraft(entry.scope);
          if (result.status === "storage-failed") {
            entry.saveError = "storage-failed";
          } else {
            const saved = result.status === "found" ? result.draft : result;
            entry.revision = saved.revision ?? 0;
            entry.writeId = saved.writeId;
            if (result.status === "found") {
              entry.text = result.draft.text;
            }
          }
          entry.ready = true;
          if (entry.acceptedText !== undefined) {
            if (entry.text.trim() === entry.acceptedText.trim()) {
              entry.text = "";
              entry.dirty = true;
            }
            entry.acceptedText = undefined;
            if (this.acknowledgedRestore === entry) {
              this.acknowledgedRestore = null;
            }
          }
          if (entry === this.entry) {
            this.publish();
          }
        }
        while (entry.dirty && !entry.saveError) {
          entry.dirty = false;
          const revision = Math.max(Date.now(), entry.revision + 1);
          const writeId = crypto.randomUUID();
          const result = await writeDurableComposerDraft(
            entry.scope,
            { revision, text: entry.text, attachments: [] },
            { expectedRevision: entry.revision, expectedWriteId: entry.writeId, writeId },
          );
          if (result.status === "persisted") {
            entry.revision = revision;
            entry.writeId = writeId;
          } else {
            // Text-only writes cannot exceed the store's attachment byte limit.
            entry.saveError = result.status === "conflict" ? "conflict" : "storage-failed";
            entry.dirty = true;
            if (entry === this.entry) {
              this.publish();
            }
          }
        }
        if (this.acknowledgedRestore) {
          entry = this.acknowledgedRestore;
        } else if (entry === this.entry || this.disposed) {
          return;
        } else {
          entry = this.entry;
        }
      }
    } finally {
      // Release admission inside the I/O owner's final continuation. A chained
      // promise finalizer leaves a gap that can swallow a newly admitted clear.
      this.worker = null;
    }
  }
}
