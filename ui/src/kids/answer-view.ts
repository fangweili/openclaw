/** Pure free-answer form. Dictation only edits; the activity owner submits and grades. */
import {
  ACTIVITY_EXPLANATION_MAX_LENGTH,
  ACTIVITY_NUMERIC_MAX_LENGTH,
  type ActivityQuestion,
} from "@openclaw/kids-activity-contract";
import { html, nothing, svg } from "lit";
import { strokeIcon } from "../components/icons-tools.ts";
import { t } from "../i18n/index.ts";
import type { KidsActivityState } from "./activity.ts";
import type { KidsDictationState } from "./dictation.ts";

export type KidsAnswerInput = { dictation: KidsDictationState; allowed: boolean };
export type KidsAnswerActions = {
  draft: (text: string) => void;
  check: () => void;
  dictate: () => void;
  edit: () => void;
  next: () => void;
};
const microphone = strokeIcon(
  svg`<rect x="9" y="2" width="6" height="12" rx="3"/><path d="M5 10v2a7 7 0 0014 0v-2M12 19v3m-4 0h8"/>`,
);
const stop = strokeIcon(svg`<rect x="6" y="6" width="12" height="12" rx="2"/>`);

/** Preserve the submitted answer on screen; all feedback is server supplied. */
export function renderKidsAnswer(
  question: Exclude<ActivityQuestion, { kind: "choice" }>,
  state: KidsActivityState,
  input: KidsAnswerInput,
  actions: KidsAnswerActions,
) {
  const { dictation } = input;
  const recording = dictation.active || dictation.finishing;
  const correct = state.feedback?.outcome === "correct";
  const retained = state.submission?.answer;
  const value =
    (state.checking || state.canRetry || correct) && retained && retained.kind !== "choice"
      ? retained.text
      : state.answerDraft;
  const locked = state.busy || state.canRetry || state.error !== null || recording;
  return html`<form
    class="kids-answer"
    @submit=${(event: SubmitEvent) => {
      event.preventDefault();
      if (!locked && !correct && value.trim()) {
        (event.currentTarget as HTMLFormElement)
          .querySelector<HTMLInputElement | HTMLTextAreaElement>(".kids-answer-input")
          ?.blur();
        actions.check();
      }
    }}
  >
    <label for="kids-answer" class="kids-answer-label"
      >${t(question.kind === "numeric" ? "kids.answer.numberLabel" : "kids.answer.explanationLabel")}</label
    >
    ${
      question.kind === "numeric"
        ? html`<div class="kids-answer-number">
            <input
              id="kids-answer"
              class="kids-answer-input"
              inputmode="text"
              autocomplete="off"
              maxlength=${ACTIVITY_NUMERIC_MAX_LENGTH}
              aria-describedby=${question.unit ? "kids-answer-unit" : nothing}
              .value=${value}
              @focus=${actions.edit}
              ?readonly=${state.checking || state.canRetry || correct || recording}
              @input=${(event: InputEvent) => actions.draft((event.target as HTMLInputElement).value)}
            />
            ${question.unit ? html`<span id="kids-answer-unit">${question.unit}</span>` : nothing}
          </div>`
        : html`<textarea
              id="kids-answer"
              class="kids-answer-input"
              rows="3"
              maxlength=${ACTIVITY_EXPLANATION_MAX_LENGTH}
              placeholder=${t("kids.answer.placeholder")}
              .value=${value}
              @focus=${actions.edit}
              ?readonly=${state.checking || state.canRetry || correct || recording}
              @input=${(event: InputEvent) => actions.draft((event.target as HTMLTextAreaElement).value)}
            ></textarea>
            ${!correct ? html`<p class="kids-answer-note">${t("kids.answer.note")}</p>` : nothing}`
    }
    <div
      class=${state.checking || state.feedback ? "kids-answer-result kids-answer-result--populated" : "kids-answer-result"}
      role="status"
    >
      ${
        state.checking
          ? html`<strong>${t("kids.answer.checking")}</strong
              ><span>${t("kids.answer.stillHere")}</span>`
          : state.feedback
            ? html`<strong>${t(`kids.answer.${state.feedback.outcome}`)}</strong
                ><span>${state.feedback.explanation}</span>`
            : nothing
      }
    </div>
    ${recording ? html`<p class="kids-dictation-status" role="status">${t(dictation.finishing ? "kids.dictation.finishing" : "kids.dictation.listening")}</p>` : nothing}
    ${dictation.detail ? html`<p class="kids-attachment-error" role="alert">${dictation.detail}</p>` : nothing}
    ${state.answerError ? html`<p class="kids-attachment-error" role="alert">${state.answerError}</p>` : nothing}
    <div class="kids-answer-actions">
      ${
        !correct
          ? html`<button
                type="button"
                class="kids-answer-dictate"
                ?disabled=${!input.allowed || dictation.finishing || (!recording && locked)}
                aria-label=${t(recording ? "kids.dictation.stop" : "kids.answer.say")}
                aria-pressed=${recording}
                @click=${actions.dictate}
              >
                ${recording ? stop : microphone}<span
                  >${t(recording ? "kids.dictation.stop" : "kids.answer.say")}</span
                ></button
              ><button
                type="submit"
                class="kids-activity-primary"
                ?disabled=${locked || !value.trim()}
              >
                ${t(state.checking ? "kids.answer.checkingButton" : "kids.answer.check")}
              </button>`
          : html`<button
              type="button"
              class="kids-activity-primary"
              ?disabled=${locked}
              @click=${actions.next}
            >
              ${t("kids.activity.next")}
            </button>`
      }
    </div>
  </form>`;
}
