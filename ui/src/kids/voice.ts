/**
 * One child's current voice call. The app supplies an authenticated connection
 * and its authorized tutor session; the shared Talk owner controls microphone,
 * provider selection, transcript persistence, and transport cleanup. This module
 * owns only call admission and the bounded captions shown by the kids surface.
 *
 * Stop fences callbacks immediately, cancels microphone acquisition, and joins
 * startup and Talk cleanup before the app may replace its connection or tutor.
 * Browser permission prompts cannot be dismissed programmatically; the shared
 * input owner releases any microphone granted after cancellation.
 * Requires a secure browser context, microphone permission, operator.talk scope,
 * and a configured, ready Talk provider on the Gateway. No provider credentials
 * or model choices belong to this module.
 */
import type { GatewayBrowserClient } from "../api/gateway.ts";
import { formatUiError, formatUiExternalText } from "../lib/format-error.ts";
import {
  createRealtimeTalkConversationState,
  orderRealtimeTalkConversation,
  updateRealtimeTalkConversation,
  type RealtimeTalkConversationEntry,
} from "../pages/chat/talk/conversation.ts";
import { RealtimeTalkSession } from "../pages/chat/talk/session.ts";
import type { RealtimeTalkStatus } from "../pages/chat/talk/shared.ts";

export type KidsVoiceState = {
  status: RealtimeTalkStatus | "stopping";
  active: boolean;
  detail: string | null;
  /** Provisional current-call captions. Saved chat history remains authoritative. */
  entries: readonly RealtimeTalkConversationEntry[];
};

type Call = {
  key: string;
  session: RealtimeTalkSession;
  startup: Promise<void>;
  accepting: boolean;
};

export class KidsVoice {
  private call: Call | null = null;
  private closing: Promise<void> | null = null;
  private disposed = false;
  private conversation = createRealtimeTalkConversationState();
  private snapshot: KidsVoiceState = {
    status: "idle",
    active: false,
    detail: null,
    entries: [],
  };

  /** The app owns client lifetime; callbacks must not throw or mutate snapshots. */
  constructor(
    private readonly client: GatewayBrowserClient,
    private readonly onState: (state: KidsVoiceState) => void,
    private readonly onUserTurn: () => void = () => {},
  ) {}

  get state(): KidsVoiceState {
    return this.snapshot;
  }

  /**
   * Start only from a user gesture, using the app's already authorized session.
   * Duplicate starts of the same call join startup. A different session, pending
   * stop, or disposed owner rejects without allocating resources. Startup errors
   * are visible in state and reject after cleanup; retry starts a fresh call.
   */
  async start(sessionKey: string): Promise<void> {
    if (this.disposed || this.closing) {
      throw new Error("Voice is closing. Try again when it has stopped.");
    }
    if (this.call) {
      if (this.call.key !== sessionKey) {
        throw new Error("Stop voice before changing conversations.");
      }
      return this.call.startup;
    }
    this.conversation = createRealtimeTalkConversationState();
    const current = () => this.call === call && call.accepting && !this.disposed;
    const finish = () => void this.stop().catch(() => undefined);
    const session = new RealtimeTalkSession(
      this.client,
      sessionKey,
      {
        onStatus: (status, detail) => {
          if (!current()) {
            return;
          }
          if (status === "idle") {
            finish();
            return;
          }
          this.publish({ status, detail: formatUiExternalText(detail) || null });
        },
        onInputNotice: (detail) => {
          if (current()) {
            this.publish({ detail: formatUiExternalText(detail) });
          }
        },
        onTranscript: (entry) => {
          if (current()) {
            this.conversation = updateRealtimeTalkConversation(this.conversation, entry);
            this.publish({ entries: this.conversation.entries });
            // The shared transcript owner already deduplicates accepted finals;
            // provisional caption boundaries are not speech admission authority.
            if (entry.role === "user" && entry.final && entry.text.trim()) {
              this.onUserTurn();
            }
          }
        },
        onTranscriptOrder: (orders) => {
          if (current()) {
            this.conversation = orderRealtimeTalkConversation(this.conversation, orders);
            this.publish({ entries: this.conversation.entries });
          }
        },
        onTalkEvent: (event) => {
          if (current() && event.type === "session.closed") {
            finish();
          }
        },
      },
      {},
      { supportsVoiceSelection: false },
    );
    const call: Call = { key: sessionKey, session, startup: Promise.resolve(), accepting: true };
    this.call = call;
    this.publish({ status: "connecting", active: true, detail: null, entries: [] });
    call.startup = session.start();
    try {
      await call.startup;
    } catch (error) {
      if (current()) {
        this.publish({ status: "error", detail: formatUiError(error) });
        await this.stop();
        // oxlint-disable-next-line preserve-caught-error -- Raw provider causes may contain credentials.
        throw new Error(formatUiError(error));
      }
      // Stop owns cancellation and its cleanup result, including a late startup
      // failure. It must not reopen an error panel after the child has left.
    }
  }

  /**
   * Idempotently cancel this call and await startup plus provider/transcript
   * cleanup. Microphone capture stops synchronously. Cleanup failure rejects and
   * stays visible; the app may then disconnect, but must not claim a saved call.
   * Every admitted stop publishes stopping, then idle or error only after all
   * cleanup settles. A prior call error remains visible after successful cleanup.
   */
  stop(): Promise<void> {
    if (this.closing) {
      return this.closing;
    }
    const call = this.call;
    if (!call) {
      return Promise.resolve();
    }
    call.accepting = false;
    const callError = this.snapshot.status === "error" ? this.snapshot : null;
    this.publish({ status: "stopping", active: false, detail: callError?.detail ?? null });
    const stopping = call.session.stop();
    this.closing = (async () => {
      try {
        // A late create response still owns its allocation. Join startup before
        // the second stop so the shared owner can include that allocation's close.
        const results = await Promise.allSettled([stopping, call.startup]);
        await call.session.stop();
        if (results[0].status === "rejected") {
          throw results[0].reason;
        }
        this.publish({ status: callError ? "error" : "idle", detail: callError?.detail ?? null });
      } catch (error) {
        this.publish({ status: "error", detail: formatUiError(error) });
        // oxlint-disable-next-line preserve-caught-error -- Raw provider causes may contain credentials.
        throw new Error(formatUiError(error));
      } finally {
        this.call = null;
        this.closing = null;
      }
    })();
    return this.closing;
  }

  /** Permanently reject new calls and suppress callbacks, then join stop. */
  dispose(): Promise<void> {
    this.disposed = true;
    return this.stop();
  }

  private publish(update: Partial<KidsVoiceState>): void {
    this.snapshot = { ...this.snapshot, ...update };
    if (!this.disposed) {
      this.onState(this.snapshot);
    }
  }
}
