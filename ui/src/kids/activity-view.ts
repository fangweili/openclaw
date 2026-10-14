/** Pure Today presentation. Only server snapshots decide progress, mood, and results. */
import { html, nothing } from "lit";
import { repeat } from "lit/directives/repeat.js";
import { t } from "../i18n/index.ts";
import type { KidsActivityState } from "./activity.ts";

export type KidsActivityActions = {
  start: () => void;
  answer: (optionId: string) => void;
  hint: () => void;
  next: () => void;
  help: () => void;
  retry: () => void;
  chat: () => void;
};

/** Render a private snapshot already admitted to the current conversation. */
export function renderKidsActivity(state: KidsActivityState, actions: KidsActivityActions) {
  const data = state.snapshot;
  const activity = data?.activity;
  const question = activity?.currentQuestion;
  const heading = state.feedback?.activity ?? activity;
  const locked = state.busy || state.canRetry || state.error !== null;
  const mood = data?.pet.state ?? "normal";
  return html`<main class="kids-today" aria-label=${t("kids.activity.today")}>
    <section class=${`kids-pet kids-pet--${mood}`} aria-label=${t("kids.activity.pet")}>
      <div class="kids-pet-picture">
        ${
          state.imageUrl
            ? html`<img src=${state.imageUrl} alt=${t(`kids.activity.mood.${mood}`)} />`
            : html`<img class="kids-pet-placeholder" src="/kids/rocky.svg" alt="" />`
        }
      </div>
      <p class="kids-pet-caption" role="status">
        ${data?.pet.image?.caption ?? t("kids.activity.gettingReady")}
      </p>
      ${
        state.imageError
          ? html`<button class="kids-activity-link" @click=${actions.retry}>
              ${t("kids.activity.imageRetry")}
            </button>`
          : nothing
      }
    </section>
    <section
      class="kids-activity-card"
      aria-label=${t("kids.activity.challenge")}
      aria-busy=${state.busy}
    >
      ${
        state.error
          ? html`<div class="kids-activity-notice" role="alert">
              <p>${state.error}</p>
              <button
                class="kids-activity-secondary"
                ?disabled=${state.busy}
                @click=${actions.retry}
              >
                ${t("kids.retry")}
              </button>
            </div>`
          : nothing
      }
      ${
        state.loading && !data
          ? html`<p class="kids-activity-empty" role="status">${t("kids.activity.loading")}</p>`
          : !heading
            ? html`<div class="kids-activity-empty">
                <h2>${t("kids.activity.gettingReady")}</h2>
                <p>${t("kids.activity.empty")}</p>
                <button class="kids-activity-primary" @click=${actions.chat}>
                  ${t("kids.activity.chatAction")}
                </button>
              </div>`
            : html`
                ${
                  !state.feedback && data?.daily
                    ? html`<p class="kids-activity-daily">
                        ${t("kids.activity.dailyProgress", {
                          completed: String(data.daily.completed),
                          total: String(data.daily.total),
                        })}
                      </p>`
                    : nothing
                }
                <div class="kids-activity-heading">
                  <span class="kids-activity-subject">${heading.subject}</span>
                  ${!state.feedback && activity ? html`<span class="kids-activity-count">${t("kids.activity.questionProgress", { completed: String(activity.currentIndex), total: String(activity.total) })}</span>` : nothing}
                </div>
                <h2>${heading.title}</h2>
                ${
                  !state.feedback && activity
                    ? html`<div
                        class="kids-activity-progress"
                        role="progressbar"
                        aria-label=${t("kids.activity.progress")}
                        aria-valuemin="0"
                        aria-valuemax=${activity.total}
                        aria-valuenow=${activity.currentIndex}
                      >
                        ${Array.from({ length: activity.total }, (_, index) => html`<span class=${index < activity.currentIndex ? "is-complete" : ""}></span>`)}
                      </div>`
                    : nothing
                }
                ${
                  state.feedback
                    ? html`<div class="kids-activity-feedback" role="status">
                        <p class="kids-activity-question">${state.feedback.prompt}</p>
                        <h3>
                          ${t(state.feedback.correct ? "kids.activity.correct" : "kids.activity.tryAgain")}
                        </h3>
                        <p>${state.feedback.explanation}</p>
                        <button
                          class="kids-activity-primary"
                          ?disabled=${locked}
                          @click=${actions.next}
                        >
                          ${t(state.feedback.correct ? "kids.activity.next" : "kids.activity.anotherTry")}
                        </button>
                      </div>`
                    : activity?.completed
                      ? html`<div class="kids-activity-complete">
                          <span class="kids-activity-spark" aria-hidden="true">✦</span>
                          <h3>
                            ${t(data?.nextActivity ? "kids.activity.finished" : "kids.activity.allDone")}
                          </h3>
                          <p>${t("kids.activity.finishedDetail")}</p>
                          <div class="kids-activity-actions">
                            ${
                              data?.nextActivity
                                ? html`<button
                                    class="kids-activity-primary"
                                    ?disabled=${locked}
                                    @click=${actions.start}
                                  >
                                    ${t("kids.activity.anotherChallenge")}
                                  </button>`
                                : nothing
                            }
                            <button
                              class=${data?.nextActivity ? "kids-activity-secondary" : "kids-activity-primary"}
                              @click=${actions.chat}
                            >
                              ${t("kids.activity.chatAction")}
                            </button>
                          </div>
                        </div>`
                      : activity && !activity.started
                        ? html`<p class="kids-activity-intro">
                              ${t("kids.activity.invitation", { count: String(activity.total) })}
                            </p>
                            <button
                              class="kids-activity-primary"
                              ?disabled=${locked}
                              @click=${actions.start}
                            >
                              ${t("kids.activity.start")}
                            </button>`
                        : question
                          ? html`<p class="kids-activity-question">${question.prompt}</p>
                              <div
                                class="kids-activity-options"
                                role="group"
                                aria-label=${t("kids.activity.answers")}
                              >
                                ${repeat(
                                  question.options,
                                  (option) => option.id,
                                  (option, index) => html` <button
                                    class="kids-activity-option"
                                    ?disabled=${locked}
                                    @click=${() => actions.answer(option.id)}
                                  >
                                    <span class="kids-activity-letter" aria-hidden="true"
                                      >${String.fromCharCode(65 + index)}</span
                                    ><span>${option.text}</span>
                                  </button>`,
                                )}
                              </div>
                              ${question.hint ? html`<p class="kids-activity-hint" role="status">${question.hint}</p>` : nothing}
                              <div class="kids-activity-actions">
                                ${question.hint ? nothing : html`<button class="kids-activity-secondary" ?disabled=${locked} @click=${actions.hint}>${t("kids.activity.hint")}</button>`}
                                <button
                                  class="kids-activity-link"
                                  ?disabled=${locked}
                                  @click=${actions.help}
                                >
                                  ${t("kids.activity.help")}
                                </button>
                              </div>`
                          : nothing
                }
              `
      }
    </section>
  </main>`;
}
