/**
 * Document owner: one same-origin Gateway connection, one authenticated tutor
 * conversation, and at most one microphone call. Reconnect retires old voice
 * before binding the next verified identity. No URL parameter, shared token,
 * local session selection, or model preference can redirect this surface.
 *
 * Start once; dispose fences callbacks, stops the microphone immediately, joins
 * voice/subscription cleanup, then stops the connection. Drafts stay in memory
 * only and are cleared when the verified profile changes. Completed calls keep
 * text and new calls blocked until saved history supplies the current branch.
 */
import { render } from "lit";
import { roleScopesAllow } from "../../../src/shared/operator-scope-compat.js";
import { GatewayBrowserClient, type GatewayHelloOk } from "../api/gateway.ts";
import { CONTROL_UI_BUILD_INFO } from "../build-info.ts";
import { t } from "../i18n/index.ts";
import { registerKidsEnglish } from "../i18n/locales/en-kids.ts";
import { KidsConversation, type KidsConversationState } from "./conversation.ts";
import { KidsNotifications } from "./notifications.ts";
import { renderKidsView, type KidsViewState } from "./view.ts";
import { KidsVoice, type KidsVoiceState } from "./voice.ts";

registerKidsEnglish();

const idleVoice = (): KidsVoiceState => ({
  status: "idle",
  active: false,
  detail: null,
  entries: [],
});

export class KidsApp {
  private readonly client: GatewayBrowserClient;
  private readonly conversation: KidsConversation;
  private voice: KidsVoice | null = null;
  private notifications: KidsNotifications | null = null;
  private capabilityRetirement: Promise<unknown> = Promise.resolve();
  private generation = 0;
  private started = false;
  private disposed = false;
  private boundSession = "";
  private closing: Promise<void> | null = null;
  private snapshot: KidsViewState;

  /** Construct without network or microphone effects; root must outlive dispose. */
  constructor(private readonly root: HTMLElement) {
    const url = new URL("/", location.href);
    url.protocol = location.protocol === "https:" ? "wss:" : "ws:";
    this.client = new GatewayBrowserClient({
      url: url.href,
      clientVersion: CONTROL_UI_BUILD_INFO.version ?? undefined,
      clientBuildId: CONTROL_UI_BUILD_INFO.buildId,
      scopes: ["operator.sessions.write", "operator.talk"],
      onHello: (hello) => void this.connected(hello),
      onClose: ({ error }) => {
        this.generation += 1;
        this.retireCapabilities();
        this.snapshot.voice = idleVoice();
        this.conversation.disconnect();
        this.snapshot.connectionError = t(error ? "kids.pairingDetail" : "kids.reconnectDetail");
        this.paint();
      },
      onGap: () => void this.conversation.refresh(),
    });
    this.conversation = new KidsConversation(this.client, (conversation) =>
      this.onConversation(conversation),
    );
    this.snapshot = {
      conversation: this.conversation.state,
      voice: idleVoice(),
      draft: "",
      connectionError: null,
      voiceAllowed: false,
      notifications: null,
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

  private async retry(): Promise<void> {
    const generation = ++this.generation;
    this.retireCapabilities();
    this.snapshot.voice = idleVoice();
    this.conversation.disconnect();
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
    if (conversation.sessionKey && conversation.sessionKey !== this.boundSession) {
      this.boundSession = conversation.sessionKey;
      this.snapshot.draft = "";
    }
    this.snapshot.conversation = conversation;
    if (conversation.status === "ready" && !this.notifications) {
      const generation = this.generation;
      this.notifications = new KidsNotifications(
        this.client,
        conversation.agentId,
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
      !draft ||
      this.snapshot.conversation.busy ||
      this.voice?.state.active ||
      this.snapshot.voice.status === "stopping"
    ) {
      return;
    }
    if (await this.conversation.send(draft)) {
      if (this.snapshot.draft.trim() === draft) {
        this.snapshot.draft = "";
      }
      this.paint(true);
    }
  }

  private async talk(): Promise<void> {
    const voice = this.voice;
    if (!voice || !this.snapshot.voiceAllowed || this.snapshot.voice.status === "stopping") {
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
        talk: () => void this.talk(),
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
