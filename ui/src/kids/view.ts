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
import type { KidsConversationState } from "./conversation.ts";
import type { KidsNotificationsState } from "./notifications.ts";
import type { KidsVoiceState } from "./voice.ts";

registerKidsEnglish();

export type KidsViewState = {
  conversation: KidsConversationState;
  voice: KidsVoiceState;
  draft: string;
  connectionError: string | null;
  voiceAllowed: boolean;
  notifications: KidsNotificationsState | null;
};

export type KidsViewActions = {
  draft: (value: string) => void;
  send: () => void;
  talk: () => void;
  retry: () => void;
  notifications: () => void;
};

const microphone = strokeIcon(
  svg`<rect x="9" y="2" width="6" height="12" rx="3"/><path d="M5 10v2a7 7 0 0014 0v-2M12 19v3m-3 0h6"/>`,
);
const arrow = strokeIcon(svg`<path d="M12 19V5m-6 6 6-6 6 6"/>`);
const stop = strokeIcon(svg`<rect x="6" y="6" width="12" height="12" rx="2"/>`);
const bell = strokeIcon(svg`<path d="M18 8a6 6 0 00-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9M10 21h4"/>`);

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

/** Render only supplied, authorized data. All actions remain owned by the app. */
export function renderKidsView(state: KidsViewState, actions: KidsViewActions) {
  const { conversation: chat, voice } = state;
  const calling = voice.active || voice.status === "stopping";
  const ready = chat.status === "ready";
  const error = state.connectionError ?? chat.error;
  const status = calling
    ? t(`kids.voice.${voice.status}`)
    : chat.busy
      ? t("kids.thinking")
      : ready
        ? t("kids.here")
        : t("kids.connecting");
  return html`
    <div class="kids-shell">
      <header class="kids-header">
        <div class="kids-identity">
          <img class="kids-avatar" src="/kids/rocky.svg" alt="" />
          <div>
            <h1>${t("kids.name")}</h1>
            <p class="kids-status" role="status">${error ? t("kids.unavailable") : status}</p>
          </div>
        </div>
        <div class="kids-header-actions">
          ${chat.childName ? html`<span class="kids-child">${chat.childName}</span>` : nothing}
          ${state.notifications ? html`<button class="kids-notifications" aria-label=${t(state.notifications.status === "enabled" ? "kids.notifications.disable" : "kids.notifications.enable")} aria-pressed=${state.notifications.status === "enabled"} ?disabled=${state.notifications.status === "working"} @click=${actions.notifications}>${bell}</button>` : nothing}
        </div>
      </header>
      <main class="kids-thread" aria-label=${t("kids.conversation")}>
        ${
          error
            ? html`<section class="kids-notice" role="alert">
                ${!ready ? html`<h2>${t("kids.connectionTitle")}</h2>` : nothing}
                <p>${error}</p>
                ${!ready ? html`<button @click=${actions.retry}>${t("kids.retry")}</button>` : nothing}
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
        <div class="kids-messages" role="log" aria-live="polite" aria-relevant="additions text">
          ${repeat(
            chat.messages,
            (message) => message.id,
            (message) => html`
              <article class=${`kids-message kids-message--${message.role}`}>
                <span class="kids-message-label"
                  >${message.role === "user" ? t("kids.you") : t("kids.name")}</span
                >
                <div class="kids-message-content">${unsafeHTML(messageHtml(message.text))}</div>
              </article>
            `,
          )}
          ${chat.busy && !calling ? html`<p class="kids-thinking">${t("kids.thinking")}</p>` : nothing}
        </div>
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
                      html`<p>
                        <strong>${entry.role === "user" ? t("kids.you") : t("kids.name")}</strong>
                        ${entry.text}
                      </p>`,
                  )}
                </div>
              </section>`
            : nothing
        }
        ${voice.detail ? html`<p class="kids-voice-notice" role="status">${voice.detail}</p>` : nothing}
        ${ready && !state.voiceAllowed ? html`<p class="kids-voice-notice">${t("kids.voiceUnavailable")}</p>` : nothing}
        ${state.notifications?.detail ? html`<p class="kids-voice-notice" role="status">${state.notifications.detail}</p>` : nothing}
      </main>
      <footer class="kids-footer">
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
                <form
                  class="kids-composer"
                  @submit=${(event: SubmitEvent) => {
                    event.preventDefault();
                    actions.send();
                  }}
                >
                  <label class="kids-sr-only" for="kids-message">${t("kids.message")}</label>
                  <textarea
                    id="kids-message"
                    rows="1"
                    maxlength="16000"
                    placeholder=${t("kids.placeholder")}
                    .value=${ready ? state.draft : ""}
                    ?disabled=${!ready}
                    @input=${(event: InputEvent) => actions.draft((event.target as HTMLTextAreaElement).value)}
                    @keydown=${(event: KeyboardEvent) => {
                      if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
                        event.preventDefault();
                        actions.send();
                      }
                    }}
                  ></textarea>
                  <button
                    class="kids-send"
                    type="submit"
                    aria-label=${t("kids.send")}
                    ?disabled=${!ready || chat.busy || !state.draft.trim()}
                  >
                    ${arrow}
                  </button>
                </form>
                <button
                  class="kids-talk"
                  ?disabled=${!ready || chat.busy || !state.voiceAllowed}
                  @click=${actions.talk}
                >
                  ${microphone}<span>${t("kids.talk")}</span>
                </button>
              `
        }
      </footer>
    </div>
  `;
}
