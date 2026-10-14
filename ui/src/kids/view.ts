/**
 * Stateless kids presentation. The app owns drafts, connection, and calls; this
 * view emits intentions and never discovers agents, sessions, or credentials.
 * Message HTML comes only from the shared sanitized Markdown renderer.
 * Retained drafts are visible only while the conversation owner reports ready.
 */
import { html, nothing, svg } from "lit";
import { repeat } from "lit/directives/repeat.js";
import { unsafeHTML } from "lit/directives/unsafe-html.js";
import { strokeIcon } from "../components/icons-tools.ts";
import { toSanitizedMarkdownHtml } from "../components/markdown.ts";
import { t } from "../i18n/index.ts";
import { registerKidsEnglish } from "../i18n/locales/en-kids.ts";
import { renderKidsActivity, type KidsActivityActions } from "./activity-view.ts";
import type { KidsActivityState } from "./activity.ts";
import type { KidsAttachmentState } from "./attachments.ts";
import type { KidsConversationState } from "./conversation.ts";
import { kidsMediaPreview } from "./history-media-view.ts";
import type { KidsHistoryMedia } from "./history-media.ts";
import { renderKidsHome } from "./home-view.ts";
import type { KidsPage } from "./navigation.ts";
import type { KidsNotificationsState } from "./notifications.ts";
import type { KidsVoiceState } from "./voice.ts";

registerKidsEnglish();

export type KidsViewState = {
  activityEnabled: boolean;
  page: KidsPage;
  returnToSolve: boolean;
  activity: KidsActivityState;
  conversation: KidsConversationState;
  voice: KidsVoiceState;
  dictation: { active: boolean; finishing: boolean; detail: string | null };
  dictationQuestion: { activityId: string; questionId: string } | null;
  draft: string;
  draftReady: boolean;
  draftError: string | null;
  connectionError: string | null;
  voiceAllowed: boolean;
  notifications: KidsNotificationsState | null;
  attachments: KidsAttachmentState;
  media?: KidsHistoryMedia;
  awayFromLatest: boolean;
};

export type KidsViewActions = {
  navigate: (page: KidsPage) => void;
  activity: KidsActivityActions;
  draft: (value: string) => void;
  send: () => void;
  attach: (files: readonly File[]) => void;
  removeAttachment: (id: string) => void;
  talk: () => void;
  dictate: () => void;
  retry: () => void;
  notifications: () => void;
  older: () => void;
  newer: () => void;
  latest: () => void;
};

const microphone = strokeIcon(
  svg`<rect x="9" y="2" width="6" height="12" rx="3"/><path d="M5 10v2a7 7 0 0014 0v-2M12 19v3m-3 0h6"/>`,
);
const plus = strokeIcon(svg`<path d="M12 5v14M5 12h14"/>`);
const cross = strokeIcon(svg`<path d="m6 6 12 12M6 18 18 6"/>`);
const arrow = strokeIcon(svg`<path d="M12 19V5m-6 6 6-6 6 6"/>`);
const back = strokeIcon(svg`<path d="M19 12H5m6-6-6 6 6 6"/>`);
const down = strokeIcon(svg`<path d="M12 5v14m-6-6 6 6 6-6"/>`);
const stop = strokeIcon(svg`<rect x="6" y="6" width="12" height="12" rx="2"/>`);

/** Keep sanitized learning links, but never let a reply navigate into gateway applications. */
function messageHtml(text: string): string {
  const sanitized = toSanitizedMarkdownHtml(text, {
    codeBlockChrome: "none",
    remoteImages: false,
    sessionLinks: false,
    fileLinks: false,
  });
  const document = new DOMParser().parseFromString(sanitized, "text/html");
  for (const link of document.querySelectorAll("a[href]")) {
    let target: URL;
    try {
      target = new URL(link.getAttribute("href")!, location.href);
    } catch {
      link.replaceWith(...link.childNodes);
      continue;
    }
    if (target.origin === location.origin || !["https:", "http:"].includes(target.protocol)) {
      link.replaceWith(...link.childNodes);
    } else {
      link.setAttribute("target", "_blank");
      link.setAttribute("rel", "noopener noreferrer");
    }
  }
  return document.body.innerHTML;
}

/** Edge controls also keep filtered, non-scrolling history pages traversable. */
function historyEdge(
  state: KidsConversationState,
  actions: KidsViewActions,
  edge: "older" | "newer",
) {
  const statusClass =
    edge === "newer" ? "kids-history-status kids-history-status--newer" : "kids-history-status";
  if (state.history.loading === edge) {
    return html`<p class=${statusClass} role="status">${t(`kids.history.${edge}`)}</p>`;
  }
  if (state.history.error === edge) {
    return html`<div class=${statusClass} role="status">
      <span>${t("kids.history.failed")}</span>
      <button type="button" @click=${edge === "older" ? actions.older : actions.newer}>
        ${t("kids.retry")}
      </button>
    </div>`;
  }
  return (edge === "older" ? state.history.hasOlder : state.history.hasNewer)
    ? html`<div class=${statusClass}>
        <button
          type="button"
          ?disabled=${state.history.loading !== null}
          @click=${edge === "older" ? actions.older : actions.newer}
        >
          ${t(`kids.history.${edge}Action`)}
        </button>
      </div>`
    : nothing;
}

/** Render only supplied, authorized data. All actions remain owned by the app. */
export function renderKidsView(state: KidsViewState, actions: KidsViewActions) {
  const { conversation: chat, voice } = state;
  const calling = voice.active || voice.status === "stopping";
  const ready = chat.status === "ready";
  const composerReady = ready && state.draftReady;
  const dictating = state.dictation.active || state.dictation.finishing;
  const error = state.connectionError ?? chat.error;
  const page =
    !ready || !state.activityEnabled || calling
      ? "chat"
      : dictating
        ? state.dictationQuestion
          ? "solve"
          : "chat"
        : state.page;
  const todayUnavailable = calling
    ? t("kids.activity.finishCall")
    : state.dictation.finishing
      ? t("kids.activity.waitForDictation")
      : dictating
        ? t("kids.activity.finishDictation")
        : null;
  // Keep the empty idle live region mounted so its first useful update is announced.
  const status = error
    ? t("kids.unavailable")
    : calling
      ? t(`kids.voice.${voice.status}`)
      : chat.busy
        ? t("kids.thinking")
        : !ready
          ? t("kids.connecting")
          : null;
  return html`
    <div
      class=${`kids-shell${state.activityEnabled && page !== "today" ? " kids-shell--with-navigation" : ""}`}
    >
      <h1 class="kids-sr-only" ?hidden=${page === "today"}>${t("kids.name")}</h1>
      ${
        state.activityEnabled && page !== "today"
          ? html`<nav class="kids-page-navigation" aria-label=${t("kids.home.navigation")}>
                <button
                  type="button"
                  aria-describedby=${todayUnavailable ? "kids-navigation-help" : nothing}
                  title=${todayUnavailable ?? nothing}
                  ?disabled=${!ready || calling || dictating}
                  @click=${() => actions.navigate("today")}
                >
                  <span aria-hidden="true">${back}</span>${t("kids.activity.today")}
                </button>
                ${
                  page === "chat" && state.returnToSolve
                    ? html`<button
                        class="kids-return-solve"
                        type="button"
                        aria-describedby=${todayUnavailable ? "kids-navigation-help" : nothing}
                        title=${todayUnavailable ?? nothing}
                        ?disabled=${!ready || calling || dictating}
                        @click=${() => actions.navigate("solve")}
                      >
                        ${t("kids.home.backToSolve")}
                      </button>`
                    : nothing
                }
              </nav>
              ${todayUnavailable ? html`<span id="kids-navigation-help" class="kids-sr-only">${todayUnavailable}</span>` : nothing}`
          : nothing
      }
      ${
        ready && state.activityEnabled
          ? html`
              ${renderKidsHome(state.activity, chat.childName, actions.navigate, actions.activity.retry, page !== "today")}
              ${renderKidsActivity(
                state.activity,
                actions.activity,
                {
                  dictation: state.dictationQuestion
                    ? state.dictation
                    : { active: false, finishing: false, detail: null },
                  allowed:
                    state.voiceAllowed &&
                    !calling &&
                    (!dictating || state.dictationQuestion !== null),
                },
                page !== "solve",
              )}
            `
          : nothing
      }
      <div class="kids-thread-area" ?hidden=${page !== "chat"}>
        <main class="kids-thread" aria-label=${t("kids.conversation")}>
          <div class="kids-thread-content">
            <p class=${`kids-status${ready || error ? " kids-sr-only" : ""}`} role="status">
              ${status ?? nothing}
            </p>
            ${
              error
                ? html`<section class="kids-notice" role="alert">
                    ${!ready ? html`<h2>${t("kids.connectionTitle")}</h2>` : nothing}
                    <p>${error}</p>
                    ${!ready || chat.canRetrySend ? html`<button @click=${actions.retry}>${t("kids.retry")}</button>` : nothing}
                  </section>`
                : nothing
            }
            ${
              ready && chat.messages.length === 0 && !calling
                ? html`<section class="kids-welcome">
                    <img src="/kids/rocky.svg" alt="" />
                    <h2>${t("kids.welcome")}</h2>
                    <p>${t("kids.welcomeDetail")}</p>
                  </section>`
                : nothing
            }
            ${ready ? historyEdge(chat, actions, "older") : nothing}
            <div class="kids-messages" role="log" aria-live="polite" aria-relevant="additions text">
              ${repeat(
                chat.messages,
                (message) => message.id,
                (message) => html`
                  <article
                    class=${`kids-message kids-message--${message.role}`}
                    data-message-id=${message.id}
                  >
                    <span class="kids-sr-only"
                      >${message.role === "user" ? t("kids.you") : t("kids.name")}:
                    </span>
                    ${message.text ? html`<div class="kids-message-content">${unsafeHTML(messageHtml(message.text))}</div>` : nothing}
                    <div class="kids-message-media">
                      ${message.media.map((media) =>
                        media.artifactId && state.media && ready
                          ? html`<figure class="kids-media-preview">
                              ${kidsMediaPreview(state.media, media, state.media.generation)}
                            </figure>`
                          : html`<span class="kids-media-tile"
                              ><span class="kids-sr-only">${media.label}: </span
                              >${t(`kids.media.${media.kind === "image" ? "photo" : "video"}`)}</span
                            >`,
                      )}
                    </div>
                  </article>
                `,
              )}
              ${chat.busy && !chat.canRetrySend && !calling ? html`<p class="kids-thinking">${t("kids.thinking")}</p>` : nothing}
            </div>
            ${ready ? historyEdge(chat, actions, "newer") : nothing}
            ${
              calling
                ? html` <section class="kids-call" aria-label=${t("kids.liveVoice")}>
                    <div class="kids-call-orb" aria-hidden="true">${microphone}</div>
                    <h2>${status}</h2>
                    <p>${t("kids.voiceHint")}</p>
                    <div class="kids-captions" role="log" aria-live="polite">
                      ${repeat(
                        voice.entries,
                        (entry) => entry.id,
                        (entry) =>
                          html`<div class=${`kids-message kids-message--${entry.role}`}>
                            <span class="kids-sr-only"
                              >${entry.role === "user" ? t("kids.you") : t("kids.name")}:
                            </span>
                            <div class="kids-message-content">${entry.text}</div>
                          </div>`,
                      )}
                    </div>
                  </section>`
                : nothing
            }
            ${voice.detail ? html`<p class="kids-voice-notice" role="status">${voice.detail}</p>` : nothing}
            ${ready && !state.voiceAllowed ? html`<p class="kids-voice-notice">${t("kids.voiceUnavailable")}</p>` : nothing}
            ${state.notifications?.detail ? html`<p class="kids-voice-notice" role="status">${state.notifications.detail}</p>` : nothing}
          </div>
        </main>
        ${
          ready && state.awayFromLatest
            ? html`<button
                class="kids-latest"
                type="button"
                aria-label=${t("kids.history.jumpLatest")}
                @click=${actions.latest}
              >
                ${down}<span>${t("kids.history.latest")}</span>
              </button>`
            : nothing
        }
      </div>
      <footer class="kids-footer" ?hidden=${page !== "chat"}>
        ${
          state.notifications && state.notifications.status !== "enabled"
            ? html`<button
                class="kids-notifications"
                type="button"
                ?disabled=${state.notifications.status === "working"}
                @click=${actions.notifications}
              >
                ${t(state.notifications.status === "working" ? "kids.notifications.working" : "kids.notifications.enable")}
              </button>`
            : nothing
        }
        ${
          calling
            ? html`
                <button
                  class="kids-end-call"
                  ?disabled=${voice.status === "stopping"}
                  @click=${actions.talk}
                >
                  ${stop} ${t("kids.endCall")}
                </button>
              `
            : html`
                <div class="kids-compose-area">
                  ${ready && state.draftError ? html`<p class="kids-attachment-error" role="status">${state.draftError}</p>` : nothing}
                  ${
                    ready && state.attachments.items.length
                      ? html` <div
                          class="kids-attachments"
                          aria-label=${t("kids.attachments.selected")}
                        >
                          ${repeat(
                            state.attachments.items,
                            (item) => item.id,
                            (item) => html`
                              <div class="kids-attachment">
                                ${
                                  item.previewUrl
                                    ? item.kind === "image"
                                      ? html`<img src=${item.previewUrl} alt=${item.name} />`
                                      : html`<video
                                          src=${item.previewUrl}
                                          controls
                                          playsinline
                                          preload="metadata"
                                          aria-label=${item.name}
                                        ></video>`
                                    : html`<span class="kids-attachment-status" role="status"
                                        >${t(item.status === "error" ? "kids.attachments.failed" : "kids.attachments.reading")}</span
                                      >`
                                }
                                <button
                                  class="kids-remove-attachment"
                                  type="button"
                                  aria-label=${`${t("kids.attachments.remove")}: ${item.name}`}
                                  @click=${() => actions.removeAttachment(item.id)}
                                >
                                  ${cross}
                                </button>
                              </div>
                            `,
                          )}
                        </div>`
                      : nothing
                  }
                  ${ready && state.attachments.error ? html`<p class="kids-attachment-error" role="alert">${state.attachments.error}</p>` : nothing}
                  ${ready && dictating ? html`<p class="kids-dictation-status" role="status">${state.dictation.finishing ? t("kids.dictation.finishing") : t("kids.dictation.listening")}</p>` : nothing}
                  ${ready && !state.dictationQuestion && state.dictation.detail ? html`<p class="kids-attachment-error" role="alert">${state.dictation.detail}</p>` : nothing}
                  <form
                    class="kids-composer"
                    @submit=${(event: SubmitEvent) => {
                      event.preventDefault();
                      actions.send();
                    }}
                  >
                    <input
                      id="kids-files"
                      type="file"
                      accept="image/*,video/*"
                      multiple
                      hidden
                      ?disabled=${!ready || !state.attachments.allowed}
                      @change=${(event: Event) => {
                        const input = event.currentTarget as HTMLInputElement;
                        const files = Array.from(input.files ?? []);
                        input.value = "";
                        actions.attach(files);
                      }}
                    />
                    <button
                      class="kids-attach"
                      type="button"
                      aria-label=${t("kids.attachments.add")}
                      ?disabled=${!ready || !state.attachments.allowed}
                      @click=${(event: Event) => (event.currentTarget as HTMLElement).closest("form")?.querySelector<HTMLInputElement>("#kids-files")?.click()}
                    >
                      ${plus}
                    </button>
                    <label class="kids-sr-only" for="kids-message">${t("kids.message")}</label>
                    <textarea
                      id="kids-message"
                      rows="1"
                      maxlength="16000"
                      placeholder=${t("kids.placeholder")}
                      .value=${ready ? state.draft : ""}
                      ?disabled=${!composerReady}
                      ?readonly=${dictating}
                      @input=${(event: InputEvent) => actions.draft((event.target as HTMLTextAreaElement).value)}
                      @keydown=${(event: KeyboardEvent) => {
                        if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
                          event.preventDefault();
                          actions.send();
                        }
                      }}
                    ></textarea>
                    <button
                      class="kids-dictate"
                      type="button"
                      aria-label=${t(dictating ? "kids.dictation.stop" : "kids.dictation.start")}
                      aria-pressed=${dictating}
                      ?disabled=${!composerReady || !state.voiceAllowed || state.dictation.finishing}
                      @click=${actions.dictate}
                    >
                      ${dictating ? stop : microphone}
                    </button>
                    <button
                      class="kids-send"
                      type="submit"
                      aria-label=${t("kids.send")}
                      ?disabled=${!composerReady || dictating || chat.busy || state.attachments.reading || (!state.draft.trim() && !state.attachments.items.some((item) => item.status === "ready"))}
                    >
                      ${arrow}
                    </button>
                  </form>
                </div>
                <button
                  class="kids-talk"
                  ?disabled=${!ready || dictating || chat.busy || !state.voiceAllowed}
                  @click=${actions.talk}
                >
                  ${microphone}<span>${t("kids.talk")}</span>
                </button>
              `
        }
      </footer>
      ${ready ? html`<openclaw-toast-host></openclaw-toast-host>` : nothing}
    </div>
  `;
}
