/**
 * Document owner: one same-origin Gateway connection, one authenticated tutor
 * conversation, and at most one microphone capture (dictation or a live call). Reconnect retires old voice
 * before binding the next verified identity. No URL parameter, shared token,
 * local session selection, or model preference can redirect this surface.
 *
 * Start once; dispose fences callbacks, stops the microphone immediately, joins
 * voice/subscription cleanup, then stops the connection. Drafts stay in memory
 * only and are cleared when the verified profile changes. Completed calls keep
 * text and new calls blocked until saved history supplies the current branch.
 */
import { GATEWAY_CLIENT_NAMES } from "@openclaw/gateway-client/browser";
import { render } from "lit";
import { roleScopesAllow } from "../../../src/shared/operator-scope-compat.js";
import { GatewayBrowserClient, type GatewayHelloOk } from "../api/gateway.ts";
import { createApplicationConfigCapability } from "../app/config.ts";
import { CONTROL_UI_BUILD_INFO } from "../build-info.ts";
import { t } from "../i18n/index.ts";
import { registerKidsEnglish } from "../i18n/locales/en-kids.ts";
import { insertComposerDictation } from "../pages/chat/composer-dictation.ts";
import { KidsAttachments } from "./attachments.ts";
import { KidsConversation, type KidsConversationState } from "./conversation.ts";
import { KidsDictation } from "./dictation.ts";
import { KidsNotifications } from "./notifications.ts";
import { renderKidsView, type KidsViewState } from "./view.ts";
import { KidsVoice, type KidsVoiceState } from "./voice.ts";

registerKidsEnglish();

const idleDictation = () => ({ active: false, finishing: false, detail: null as string | null });

const idleVoice = (): KidsVoiceState => ({
  status: "idle",
  active: false,
  detail: null,
  entries: [],
});

export class KidsApp {
  private readonly client: GatewayBrowserClient;
  private readonly conversation: KidsConversation;
  private readonly uploads = createApplicationConfigCapability({ resourceBasePath: "" });
  private readonly attachments: KidsAttachments;
  private voice: KidsVoice | null = null;
  private dictation: KidsDictation | null = null;
  private notifications: KidsNotifications | null = null;
  private capabilityRetirement: Promise<unknown> = Promise.resolve();
  private generation = 0;
  private configAbort: AbortController | null = null;
  private started = false;
  private disposed = false;
  private boundSession = "";
  private closing: Promise<void> | null = null;
  private snapshot: KidsViewState;

  /** Construct without network or microphone effects; root must outlive dispose. */
  constructor(private readonly root: HTMLElement) {
    this.attachments = new KidsAttachments(this.uploads, () => {
      if (this.snapshot) {
        this.snapshot.attachments = this.attachments.state;
        this.paint();
      }
    });
    const url = new URL("/", location.href);
    url.protocol = location.protocol === "https:" ? "wss:" : "ws:";
    this.client = new GatewayBrowserClient({
      url: url.href,
      // A private chat client needs canonical device pairing for offline push authority.
      clientName: GATEWAY_CLIENT_NAMES.WEBCHAT_UI,
      clientVersion: CONTROL_UI_BUILD_INFO.version ?? undefined,
      clientBuildId: CONTROL_UI_BUILD_INFO.buildId,
      scopes: ["operator.sessions.write", "operator.talk"],
      onHello: (hello) => void this.connected(hello),
      onClose: ({ error }) => {
        this.generation += 1;
        this.retireCapabilities();
        this.snapshot.voice = idleVoice();
        this.conversation.disconnect();
        this.attachments.disconnect();
        this.snapshot.connectionError = t(error ? "kids.pairingDetail" : "kids.reconnectDetail");
        this.paint();
      },
      onGap: () => void this.conversation.refresh(),
    });
    this.conversation = new KidsConversation(
      this.client,
      (conversation) => this.onConversation(conversation),
      (text, ids) => this.acknowledgedSend(text, ids),
    );
    this.snapshot = {
      conversation: this.conversation.state,
      voice: idleVoice(),
      dictation: idleDictation(),
      draft: "",
      connectionError: null,
      voiceAllowed: false,
      notifications: null,
      attachments: this.attachments.state,
    };
  }

  /** Idempotently activate the document's connection; disposed owners cannot restart. */
  start(): void {
    if (this.started || this.disposed) {
      return;
    }
    this.started = true;
    this.paint();
    this.client.start();
  }

  /** Cancel immediately, then join call/subscription cleanup before dropping RPC transport. */
  dispose(): Promise<void> {
    if (this.closing) {
      return this.closing;
    }
    this.disposed = true;
    this.generation += 1;
    this.retireCapabilities();
    this.attachments.dispose();
    this.closing = Promise.allSettled([
      this.capabilityRetirement,
      this.conversation.dispose(),
    ]).then(() => {
      this.client.stop();
    });
    return this.closing;
  }

  private async connected(hello: GatewayHelloOk): Promise<void> {
    const generation = ++this.generation;
    this.retireCapabilities();
    await this.capabilityRetirement;
    if (this.disposed || generation !== this.generation) {
      return;
    }
    this.attachments.connected(hello.policy);
    this.configAbort = new AbortController();
    void this.uploads.refresh({ signal: this.configAbort.signal }).then(() => {
      if (!this.disposed && generation === this.generation) {
        this.snapshot.attachments = this.attachments.state;
        this.paint();
      }
    });
    this.snapshot.connectionError = null;
    this.snapshot.voice = idleVoice();
    this.snapshot.voiceAllowed = roleScopesAllow({
      role: "operator",
      requestedScopes: ["operator.talk"],
      allowedScopes: hello.auth?.scopes ?? [],
    });
    this.voice = new KidsVoice(this.client, (voice) => void this.onVoice(voice, generation));
    await this.conversation.connect(hello);
  }

  private retireCapabilities(): void {
    this.retireDictation();
    this.configAbort?.abort();
    this.configAbort = null;
    const voice = this.voice;
    this.voice = null;
    if (voice) {
      this.capabilityRetirement = Promise.allSettled([this.capabilityRetirement, voice.dispose()]);
    }
    const notifications = this.notifications;
    this.notifications = null;
    if (notifications) {
      this.capabilityRetirement = Promise.allSettled([
        this.capabilityRetirement,
        notifications.dispose(),
      ]);
    }
    this.snapshot.notifications = null;
  }

  /** Explicit send recovery keeps its original draft; other failures restart the connection. */
  private async retry(): Promise<void> {
    if (this.snapshot.conversation.canRetrySend) {
      const generation = this.generation;
      const sent = await this.conversation.retrySend();
      if (this.disposed || generation !== this.generation || !sent) {
        return;
      }
      this.paint(true);
      return;
    }
    // A second click from the retired notice must not interrupt the first replay.
    if (this.snapshot.conversation.status === "ready") {
      return;
    }
    const generation = ++this.generation;
    this.retireCapabilities();
    this.snapshot.voice = idleVoice();
    this.conversation.disconnect();
    this.attachments.disconnect();
    await this.capabilityRetirement;
    if (this.disposed || generation !== this.generation) {
      return;
    }
    this.client.stop();
    this.snapshot.connectionError = null;
    this.paint();
    this.client.start();
  }

  private onConversation(conversation: KidsConversationState): void {
    if (this.disposed) {
      return;
    }
    this.snapshot.conversation = conversation;
    if (conversation.sessionKey && conversation.sessionId) {
      const binding = `${conversation.sessionKey}\0${conversation.sessionId}`;
      if (binding !== this.boundSession) {
        this.retireDictation();
        this.boundSession = binding;
        this.snapshot.draft = "";
      }
      this.attachments.bind(conversation.sessionKey, conversation.sessionId);
    }
    if (conversation.status === "ready" && !this.notifications) {
      const generation = this.generation;
      this.notifications = new KidsNotifications(
        this.client,
        conversation.agentId,
        conversation.sessionKey,
        (notifications) => {
          if (!this.disposed && generation === this.generation) {
            this.snapshot.notifications = notifications;
            this.paint();
          }
        },
      );
      this.snapshot.notifications = this.notifications.state;
      void this.notifications.initialize();
    }
    this.paint();
  }

  /** Keep the call screen until cleanup and authoritative branch refresh settle. */
  private async onVoice(voice: KidsVoiceState, generation: number): Promise<void> {
    if (this.disposed || generation !== this.generation) {
      return;
    }
    if (this.snapshot.voice.status === "stopping" && voice.status !== "stopping") {
      // Both local and remote close finish here, including failed cleanup. The
      // conversation owner keeps sends disabled if its history read fails.
      await this.conversation.refresh();
      if (this.disposed || generation !== this.generation) {
        return;
      }
    }
    this.snapshot.voice = voice;
    this.paint();
  }

  private async send(): Promise<void> {
    const draft = this.snapshot.draft.trim();
    if (
      this.snapshot.conversation.status !== "ready" ||
      this.snapshot.conversation.busy ||
      this.snapshot.attachments.reading ||
      this.snapshot.dictation.active ||
      this.snapshot.dictation.finishing ||
      this.voice?.state.active ||
      this.snapshot.voice.status === "stopping"
    ) {
      return;
    }
    const attachments = this.attachments.prepare();
    if (attachments && (await this.conversation.send(draft, attachments))) {
      this.paint(true);
    }
  }

  /** A current conversation's acknowledgment consumes only its unchanged original draft. */
  private acknowledgedSend(text: string, ids: readonly string[]): void {
    if (!this.disposed) {
      this.attachments.accepted(ids);
    }
    if (!this.disposed && this.snapshot.draft.trim() === text) {
      this.snapshot.draft = "";
      this.paint();
    }
  }

  private async talk(): Promise<void> {
    const voice = this.voice;
    if (
      !voice ||
      !this.snapshot.voiceAllowed ||
      this.snapshot.voice.status === "stopping" ||
      this.snapshot.dictation.active ||
      this.snapshot.dictation.finishing
    ) {
      return;
    }
    try {
      if (voice.state.active) {
        await voice.stop();
      } else if (this.snapshot.conversation.sessionKey && !this.snapshot.conversation.busy) {
        await voice.start(this.snapshot.conversation.sessionKey);
      }
    } catch {
      // The voice owner publishes the redacted, actionable failure.
    }
  }

  /** Dictation edits only the current draft; it never sends or creates a tutor turn. */
  private async dictate(): Promise<void> {
    if (this.disposed || this.snapshot.dictation.finishing) {
      return;
    }
    if (this.dictation?.state.active) {
      await this.dictation.finish();
      return;
    }
    if (
      this.snapshot.conversation.status !== "ready" ||
      !this.snapshot.voiceAllowed ||
      this.voice?.state.active ||
      this.snapshot.voice.status === "stopping"
    ) {
      return;
    }
    this.retireDictation();
    const field = this.root.querySelector<HTMLTextAreaElement>("#kids-message");
    const target = {
      binding: this.boundSession,
      value: this.snapshot.draft,
      start: field?.selectionStart ?? this.snapshot.draft.length,
      end: field?.selectionEnd ?? this.snapshot.draft.length,
    };
    const generation = this.generation;
    const current = () =>
      !this.disposed && generation === this.generation && this.dictation === owner;
    const owner = new KidsDictation(
      this.client,
      (state) => {
        if (current()) {
          this.snapshot.dictation = state;
          this.paint();
        }
      },
      (transcript) => {
        if (!current() || target.binding !== this.boundSession) {
          return;
        }
        // Preserve an edit made while transcription was pending; never replay
        // the captured draft over newer text.
        const unchanged = this.snapshot.draft === target.value;
        this.snapshot.draft = insertComposerDictation(
          this.snapshot.draft,
          transcript,
          unchanged ? target.start : this.snapshot.draft.length,
          unchanged ? target.end : this.snapshot.draft.length,
        ).value;
        this.paint();
      },
    );
    this.dictation = owner;
    await owner.start();
  }

  /** Fence draft callbacks, stop capture now, and join remote cleanup before transport retirement. */
  private retireDictation(): void {
    const owner = this.dictation;
    this.dictation = null;
    this.snapshot.dictation = idleDictation();
    if (owner) {
      this.capabilityRetirement = Promise.allSettled([this.capabilityRetirement, owner.dispose()]);
    }
  }

  private paint(forceScroll = false): void {
    if (this.disposed) {
      return;
    }
    const thread = this.root.querySelector<HTMLElement>(".kids-thread");
    const nearBottom =
      !thread || thread.scrollHeight - thread.scrollTop - thread.clientHeight < 100;
    render(
      renderKidsView(this.snapshot, {
        draft: (value) => {
          this.snapshot.draft = value;
          this.paint();
        },
        send: () => void this.send(),
        attach: (files) => {
          if (this.snapshot.conversation.status === "ready" && !this.disposed) {
            this.attachments.add(files);
          }
        },
        removeAttachment: (id) => this.attachments.remove(id),
        talk: () => void this.talk(),
        dictate: () => void this.dictate(),
        retry: () => void this.retry(),
        notifications: () => {
          const owner = this.notifications;
          if (owner) {
            void (owner.state.status === "enabled" ? owner.disable() : owner.enable());
          }
        },
      }),
      this.root,
    );
    const current = this.root.querySelector<HTMLElement>(".kids-thread");
    if (current && (forceScroll || nearBottom)) {
      current.scrollTop = current.scrollHeight;
    }
  }
}
