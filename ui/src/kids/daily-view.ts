/**
 * Shared, stateless presentation of the server's latest prepared day. The plugin
 * owns every count and the current date; neither rendering nor navigation records
 * progress. Home uses the same completion boundary as Solve. Retained answer
 * feedback takes precedence at the Solve caller until the child continues.
 */
import type { ActivitySnapshot } from "@openclaw/kids-activity-contract";
import { html } from "lit";
import { t } from "../i18n/index.ts";
import { formatDateMs } from "../lib/format.ts";

type Daily = NonNullable<ActivitySnapshot["daily"]>;

/** A finished prepared batch is not the current task while an older quiz remains unfinished. */
export function completedKidsDay(snapshot: ActivitySnapshot | null): Daily | null {
  if (!snapshot?.daily) {
    return null;
  }
  const { daily } = snapshot;
  return daily.completed === daily.total && (!snapshot.activity || snapshot.activity.completed)
    ? daily
    : null;
}

function dayLabel(date: string) {
  // A prepared date is a calendar day, not an instant in the browser's timezone.
  return formatDateMs(Date.parse(date), { dateStyle: "medium", timeZone: "UTC" });
}

/** Label old prepared work by its own date instead of calling it today's progress. */
export function renderKidsDailyProgress(daily: Daily, currentDate: string) {
  return html`<p class="kids-activity-daily">
    ${t(
      daily.date === currentDate ? "kids.activity.dailyProgress" : "kids.activity.datedProgress",
      {
        completed: String(daily.completed),
        total: String(daily.total),
        date: dayLabel(daily.date),
      },
    )}
  </p>`;
}

/** Render a completed batch's recorded results; Perfect days is a separate server-owned day streak. */
export function renderKidsDailyRecap(
  daily: Daily,
  currentDate: string,
  perfectDayStreak: number,
  chat: () => void,
) {
  const current = daily.date === currentDate;
  return html`<div class="kids-daily-recap">
    <p class="kids-daily-mark">
      <span aria-hidden="true">✓</span>
      ${current ? t("kids.activity.allDone") : t("kids.daily.completedDate", { date: dayLabel(daily.date) })}
    </p>
    <h2>${t("kids.daily.title")}</h2>
    <p class="kids-daily-summary">
      ${t("kids.daily.summary", {
        challenges: t(daily.total === 1 ? "kids.daily.challengeOne" : "kids.daily.challenges", {
          count: String(daily.total),
        }),
        questions: t(
          daily.questionsSolved === 1 ? "kids.daily.questionOne" : "kids.daily.questions",
          {
            count: String(daily.questionsSolved),
          },
        ),
      })}
    </p>
    <dl class="kids-daily-stats">
      <div>
        <dt>${t("kids.daily.firstTry")}</dt>
        <dd class="kids-daily-value">${daily.firstTryCorrect}</dd>
      </div>
      <div>
        <dt>${t("kids.daily.hints")}</dt>
        <dd class="kids-daily-value">${daily.hintedQuestions}</dd>
      </div>
      <div>
        <dt>${t("kids.daily.perfectDays")}</dt>
        <dd class="kids-daily-value">${perfectDayStreak}</dd>
      </div>
    </dl>
    <div class="kids-daily-footer">
      <p>${t(current ? "kids.daily.nextDay" : "kids.daily.saved")}</p>
      <button class="kids-activity-primary" @click=${chat}>${t("kids.activity.chatAction")}</button>
    </div>
  </div>`;
}
