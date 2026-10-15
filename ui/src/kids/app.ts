/**
 * Document owner: one same-origin Gateway connection, one authenticated tutor
 * conversation, and at most one microphone capture (dictation or a live call). Reconnect retires old voice
 * before binding the next verified identity. No URL parameter, shared token,
 * local session selection, or model preference can redirect this surface.
 *
 * Start once; dispose fences callbacks, stops the microphone immediately, joins
 * voice/subscription/media cleanup and draft saves, then stops the connection.
 * Text drafts restore only for a verified profile and physical session; upload
 * previews remain memory-only. Completed calls keep
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
import { isGatewayMethodAdvertised } from "../lib/gateway-methods.ts";
import { insertComposerDictation } from "../pages/chat/composer-dictation.ts";
import { KidsActivity, emptyKidsActivity } from "./activity.ts";
import { KidsAttachments } from "./attachments.ts";
import { KidsConversation, type KidsConversationState } from "./conversation.ts";
import { KidsDictation } from "./dictation.ts";
import { KidsDraft } from "./draft.ts";
import { KidsHistoryMedia } from "./history-media.ts";
import { parseKidsPage, type KidsPage } from "./navigation.ts";
import { KidsNotifications } from "./notifications.ts";
import { KidsTranscriptScroll } from "./transcript-scroll.ts";
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
  private readonly activity: KidsActivity;
  private readonly uploads = createApplicationConfigCapability({ resourceBasePath: "" });
  private readonly attachments: KidsAttachments;
  private readonly draft: KidsDraft;
  private readonly media: KidsHistoryMedia;
  private readonly transcript: KidsTranscriptScroll;
  private readonly gatewayUrl: string;
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
    this.gatewayUrl = url.href;
    this.draft = new KidsDraft((draft) => {
      this.snapshot.draft = draft.text;
      this.snapshot.draftReady = draft.ready;
      this.snapshot.draftError = draft.saveError ? t("kids.draftNotSaved") : null;
      this.paint();
    });
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
        this.draft.disconnect();
        this.media.disconnect();
        this.snapshot.connectionError = t(error ? "kids.pairingDetail" : "kids.reconnectDetail");
        this.paint();
      },
      onGap: () => void this.conversation.refresh(),
    });
    this.media = new KidsHistoryMedia(this.client);
    this.activity = new KidsActivity(this.client, (activity) => {
      const target = this.snapshot.dictationQuestion;
      if (
        target &&
        (target.activityId !== activity.snapshot?.activity?.id ||
          target.questionId !== activity.snapshot.activity.currentQuestion?.id)
      ) {
        this.retireDictation();
      }
      this.snapshot.activity = activity;
      this.paint();
    });
    this.conversation = new KidsConversation(
      this.client,
      (conversation) => this.onConversation(conversation),
      (text, ids) => this.acknowledgedSend(text, ids),
    );
    this.transcript = new KidsTranscriptScroll(
      (away) => {
        if (!this.disposed && this.snapshot.awayFromLatest !== away) {
          this.snapshot.awayFromLatest = away;
          this.paint();
        }
      },
      () => {
        if (!this.calling) {
          void this.conversation.loadOlder();
        }
      },
      () => {
        if (!this.calling) {
          void this.conversation.loadNewer();
        }
      },
    );
    this.snapshot = {
      page: parseKidsPage(location.hash) ?? "today",
      returnToSolve: false,
      activityEnabled: false,
      activity: emptyKidsActivity(),
      conversation: this.conversation.state,
      voice: idleVoice(),
      dictation: idleDictation(),
      dictationQuestion: null,
      draft: "",
      draftReady: false,
      draftError: null,
      media: this.media,
      connectionError: null,
      voiceAllowed: false,
      notifications: null,
      attachments: this.attachments.state,
      awayFromLatest: false,
    };
  }

  /** Idempotently activate the document's connection; disposed owners cannot restart. */
  start(): void {
    if (this.started || this.disposed) {
      return;
    }
    this.started = true;
    window.addEventListener("hashchange", this.locationChanged);
    navigator.serviceWorker?.addEventListener("message", this.workerMessage);
    this.paint();
    this.client.start();
  }

  /** Cancel immediately, then join call/subscription cleanup before dropping RPC transport. */
  dispose(): Promise<void> {
    if (this.closing) {
      return this.closing;
    }
    this.disposed = true;
    window.removeEventListener("hashchange", this.locationChanged);
    navigator.serviceWorker?.removeEventListener("message", this.workerMessage);
    this.transcript.dispose();
    this.generation += 1;
    this.retireCapabilities();
    this.attachments.dispose();
    this.closing = Promise.allSettled([
      this.capabilityRetirement,
      this.conversation.dispose(),
      this.draft.dispose(),
      this.media.dispose(),
      this.activity.dispose(),
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
    this.snapshot.activityEnabled =
      isGatewayMethodAdvertised({ hello }, "kids.activity.get") === true;
    this.activity.setVisible(this.snapshot.activityEnabled);
    this.snapshot.voice = idleVoice();
    this.snapshot.voiceAllowed = roleScopesAllow({
      role: "operator",
      requestedScopes: ["operator.talk"],
      allowedScopes: hello.auth?.scopes ?? [],
    });
    this.voice = new KidsVoice(
      this.client,
      (voice) => void this.onVoice(voice, generation),
      () => {
        if (!this.disposed && generation === this.generation && this.snapshot.activityEnabled) {
          this.activity.touch("voice");
        }
      },
    );
    await this.conversation.connect(hello);
  }

  private retireCapabilities(): void {
    this.snapshot.activityEnabled = false;
    this.activity.setVisible(false);
    this.activity.disconnect();
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
      this.conversation.returnToLatest();
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
    this.draft.disconnect();
    this.media.disconnect();
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
    if (conversation.status === "ready" && !this.snapshot.activityEnabled) {
      this.snapshot.page = "chat";
      this.writeLocation();
    }
    if (conversation.sessionKey && conversation.sessionId) {
      const binding = `${conversation.sessionKey}\0${conversation.sessionId}`;
      if (binding !== this.boundSession) {
        this.retireDictation();
        this.boundSession = binding;
        this.snapshot.returnToSolve = false;
      }
      if (conversation.status === "ready") {
        if (this.snapshot.activityEnabled) {
          this.activity.bind({
            sessionKey: conversation.sessionKey,
            sessionId: conversation.sessionId,
          });
        }
        this.media.bind({
          agentId: conversation.agentId,
          sessionKey: conversation.sessionKey,
          sessionId: conversation.sessionId,
        });
      }
      this.attachments.bind(conversation.sessionKey, conversation.sessionId);
      if (conversation.status === "ready") {
        // Binding the draft may publish synchronously; media must already belong
        // to this same verified conversation before that render starts reads.
        void this.draft.bind({
          gatewayUrl: this.gatewayUrl,
          sessionKey: conversation.sessionKey,
          sessionId: conversation.sessionId,
        });
      }
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
      !this.draft.state.ready ||
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
    this.conversation.returnToLatest();
    if (attachments && (await this.conversation.send(draft, attachments))) {
      this.paint(true);
    }
  }

  /** A current conversation's acknowledgment consumes only its unchanged original draft. */
  private acknowledgedSend(text: string, ids: readonly string[]): void {
    if (this.disposed) {
      return;
    }
    this.attachments.accepted(ids);
    if (this.snapshot.activityEnabled) {
      this.activity.touch("chat");
    }
    // Conversation publishes its verified binding before acknowledging. The
    // draft owner retains this clear even if storage finishes after disconnect.
    this.draft.accepted(text);
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
        this.conversation.returnToLatest();
        await voice.start(this.snapshot.conversation.sessionKey);
      }
    } catch {
      // The voice owner publishes the redacted, actionable failure.
    }
  }

  /** Capture one chat or question draft. Speech edits that target only and never submits. */
  private async dictate(destination: "chat" | "solve" = "chat"): Promise<void> {
    if (this.disposed || this.snapshot.dictation.finishing) {
      return;
    }
    if (this.dictation?.state.active) {
      if (destination !== (this.snapshot.dictationQuestion ? "solve" : "chat")) {
        return;
      }
      await this.dictation.finish();
      return;
    }
    if (
      this.snapshot.conversation.status !== "ready" ||
      (destination === "chat" && !this.draft.state.ready) ||
      !this.snapshot.voiceAllowed ||
      this.voice?.state.active ||
      this.snapshot.voice.status === "stopping"
    ) {
      return;
    }
    const activity = this.activity.state.snapshot?.activity;
    const question = activity?.currentQuestion;
    if (
      destination === "solve" &&
      (this.snapshot.page !== "solve" ||
        !activity ||
        !question ||
        question.kind === "choice" ||
        this.activity.state.busy ||
        this.activity.state.canRetry ||
        this.activity.state.error ||
        this.activity.state.feedback?.outcome === "correct")
    ) {
      return;
    }
    this.retireDictation();
    const questionTarget =
      destination === "solve" && activity && question
        ? { activityId: activity.id, questionId: question.id }
        : null;
    this.snapshot.dictationQuestion = questionTarget;
    const field = this.root.querySelector<HTMLInputElement | HTMLTextAreaElement>(
      destination === "solve" ? "#kids-answer" : "#kids-message",
    );
    const value = destination === "solve" ? this.activity.state.answerDraft : this.snapshot.draft;
    const target = {
      binding: this.boundSession,
      value,
      start: field?.selectionStart ?? value.length,
      end: field?.selectionEnd ?? value.length,
    };
    if (destination === "solve") {
      this.activity.setEditing(false);
    }
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
        const currentActivity = this.activity.state.snapshot?.activity;
        if (
          questionTarget &&
          (currentActivity?.id !== questionTarget.activityId ||
            currentActivity.currentQuestion?.id !== questionTarget.questionId)
        ) {
          return;
        }
        const currentValue = questionTarget ? this.activity.state.answerDraft : this.snapshot.draft;
        const unchanged = currentValue === target.value;
        const text = insertComposerDictation(
          currentValue,
          transcript,
          unchanged ? target.start : currentValue.length,
          unchanged ? target.end : currentValue.length,
        ).value;
        if (questionTarget) {
          this.activity.updateAnswer(text);
        } else {
          this.draft.update(text);
        }
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
    this.snapshot.dictationQuestion = null;
    if (owner) {
      this.capabilityRetirement = Promise.allSettled([this.capabilityRetirement, owner.dispose()]);
    }
  }

  /** Caption presentation lasts through joined close and the authoritative history refresh. */
  private get calling(): boolean {
    return this.snapshot.voice.active || this.snapshot.voice.status === "stopping";
  }

  private paint(forceScroll = false): void {
    if (this.disposed) {
      return;
    }
    const chat = this.snapshot.conversation;
    const calling = this.calling;
    const showingChat =
      !this.snapshot.activityEnabled ||
      this.snapshot.page === "chat" ||
      calling ||
      (!this.snapshot.dictationQuestion &&
        (this.snapshot.dictation.active || this.snapshot.dictation.finishing));
    if (showingChat) {
      this.transcript.beforeRender(
        `${chat.sessionKey}\0${chat.sessionId}\0${calling ? "voice" : "chat"}`,
        !calling && chat.history.hasNewer,
      );
    }
    this.snapshot.awayFromLatest = this.transcript.awayFromLatest;
    render(
      renderKidsView(this.snapshot, {
        navigate: (page) => this.navigate(page),
        activity: {
          start: () => void this.activity.act("start"),
          answer: (optionId) => void this.activity.act("answer", optionId),
          draft: (text) => this.activity.updateAnswer(text),
          check: () => {
            if (!this.snapshot.dictation.active && !this.snapshot.dictation.finishing) {
              void this.activity.act("answer");
            }
          },
          dictate: () => void this.dictate("solve"),
          edit: () => this.activity.setEditing(true),
          hint: () => void this.activity.act("hint"),
          next: () => this.activity.continue(),
          retry: () => void this.activity.retry(),
          help: () => void this.activityHelp(),
          chat: () => this.navigate("chat"),
        },
        draft: (value) => {
          this.draft.update(value);
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
        older: () => void this.conversation.loadOlder(),
        newer: () => void this.conversation.loadNewer(),
        latest: () => {
          if (!calling) {
            this.conversation.returnToLatest();
          }
          this.paint(true);
        },
        notifications: () => {
          const owner = this.notifications;
          if (owner) {
            void owner.enable();
          }
        },
      }),
      this.root,
    );
    const current = this.root.querySelector<HTMLElement>(".kids-thread");
    const content = this.root.querySelector<HTMLElement>(".kids-thread-content");
    if (current && content && showingChat) {
      this.transcript.afterRender(current, content);
      if (forceScroll) {
        this.transcript.jumpToLatest();
      }
    }
  }

  /** URL fragments select presentation only; no page can redirect the tutor binding. */
  private readonly locationChanged = (): void => {
    this.navigate(parseKidsPage(location.hash) ?? "today");
  };

  /** Only the same-origin kids worker can request a known presentation destination. */
  private readonly workerMessage = (event: MessageEvent): void => {
    const message: unknown = event.data;
    if (
      event.origin !== location.origin ||
      typeof message !== "object" ||
      message === null ||
      !("type" in message) ||
      message.type !== "kids:navigate" ||
      !("hash" in message)
    ) {
      return;
    }
    const page = parseKidsPage(message.hash);
    if (page) {
      this.navigate(page);
    }
  };

  /** Keep the current location reloadable without adding history or private identifiers. */
  private writeLocation(): void {
    if (location.hash === `#${this.snapshot.page}`) {
      return;
    }
    const url = new URL(location.href);
    url.hash = this.snapshot.page;
    history.replaceState(history.state, "", url);
  }

  /** Keep microphone controls visible; ordinary navigation preserves drafts and scroll owners. */
  private navigate(requested: KidsPage): void {
    if (this.disposed) {
      return;
    }
    const page =
      this.snapshot.conversation.status === "ready" && !this.snapshot.activityEnabled
        ? "chat"
        : requested;
    if (
      ((this.snapshot.voice.active || this.snapshot.voice.status === "stopping") &&
        page !== "chat") ||
      ((this.snapshot.dictation.active || this.snapshot.dictation.finishing) &&
        page !== (this.snapshot.dictationQuestion ? "solve" : "chat"))
    ) {
      this.writeLocation();
      return;
    }
    if (page === this.snapshot.page) {
      this.writeLocation();
      return;
    }
    if (page !== "chat") {
      this.transcript.suspend();
    } else {
      this.snapshot.returnToSolve = this.snapshot.page === "solve";
    }
    this.snapshot.page = page;
    this.activity.setEditing(false);
    this.writeLocation();
    this.paint();
    if (page === "solve") {
      void this.activity.refresh();
    }
  }

  /** Record assistance, then draft the same question only if its conversation is still current. */
  private async activityHelp(): Promise<void> {
    const activity = this.activity.state.snapshot?.activity;
    const question = activity?.currentQuestion;
    if (!activity || !question || !this.draft.state.ready) {
      return;
    }
    const generation = this.generation;
    const binding = this.boundSession;
    await this.activity.act("hint");
    const current = this.activity.state;
    if (
      this.disposed ||
      generation !== this.generation ||
      binding !== this.boundSession ||
      this.snapshot.page !== "solve" ||
      !this.draft.state.ready ||
      current.error ||
      current.canRetry ||
      current.snapshot?.activity?.id !== activity.id ||
      current.snapshot.activity.currentQuestion?.id !== question.id ||
      current.snapshot.activity.currentQuestion.hint === null
    ) {
      return;
    }
    const message = t("kids.activity.helpMessage", {
      title: activity.title,
      question: question.prompt,
    });
    this.draft.update([this.snapshot.draft.trim(), message].filter(Boolean).join("\n\n"));
    this.navigate("chat");
    this.root.querySelector<HTMLTextAreaElement>("#kids-message")?.focus();
  }
}
