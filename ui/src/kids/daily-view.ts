/**
 * Stateless daily-goal and selected-batch presentation. The plugin owns every
 * count and the current date. Optional work never changes daily completion;
 * its recap uses only that activity's counters. Retained answer feedback takes
 * precedence at the Solve caller until the child continues.
 */
import type { ActivitySnapshot } from "@openclaw/kids-activity-contract";
import { html, nothing, type TemplateResult } from "lit";
import { t } from "../i18n/index.ts";
import { formatDateMs } from "../lib/format.ts";

type Daily = NonNullable<ActivitySnapshot["daily"]>;
type Recap = Pick<Daily, "date" | "questionsSolved" | "firstTryCorrect" | "hintedQuestions"> & {
  scope: "daily" | "extra";
};

/** The immutable scheduled goal stays complete even while extra practice is unfinished. */
export function completedKidsDay(snapshot: ActivitySnapshot | null): Daily | null {
  if (!snapshot?.daily) {
    return null;
  }
  const { daily } = snapshot;
  return daily.completed === daily.total ? daily : null;
}

/** Only the selected finished batch has a recap; old multi-part days finish as one daily goal. */
export function completedKidsBatch(snapshot: ActivitySnapshot | null): Recap | null {
  const activity = snapshot?.activity;
  if (!activity?.completed) {
    return null;
  }
  if (activity.scope === "extra") {
    return {
      scope: "extra",
      date: activity.date,
      questionsSolved: activity.currentIndex,
      firstTryCorrect: activity.firstTryCorrect,
      hintedQuestions: activity.hintedQuestions,
    };
  }
  const daily = completedKidsDay(snapshot);
  return daily?.date === activity.date ? { ...daily, scope: "daily" } : null;
}

function dayLabel(date: string) {
  // A prepared date is a calendar day, not an instant in the browser's timezone.
  return formatDateMs(Date.parse(date), { dateStyle: "medium", timeZone: "UTC" });
}

/** Keep scheduled progress separate from extra practice and an older selected carryover. */
export function renderKidsActivityProgress(snapshot: ActivitySnapshot) {
  const { daily, activity } = snapshot;
  if (!activity) {
    return nothing;
  }
  if (activity.date !== snapshot.date) {
    return html`<p class="kids-activity-daily">
      ${t("kids.activity.continuingDate", { date: dayLabel(activity.date) })}
    </p>`;
  }
  if (activity.scope === "extra") {
    return html`<p class="kids-activity-daily">${t("kids.activity.extraPractice")}</p>`;
  }
  if (!daily) {
    return nothing;
  }
  return html`<p class="kids-activity-daily">
    ${t(
      daily.date === snapshot.date ? "kids.activity.dailyProgress" : "kids.activity.datedProgress",
      {
        completed: String(daily.questionsSolved),
        total: String(daily.questionTotal),
        date: dayLabel(daily.date),
      },
    )}
  </p>`;
}

/** Render recorded batch results; the caller supplies the single completion action. */
export function renderKidsRecap(
  recap: Recap,
  currentDate: string,
  perfectDayStreak: number,
  action: TemplateResult | typeof nothing,
) {
  const current = recap.date === currentDate;
  return html`<div class="kids-daily-recap">
    <p class="kids-daily-mark">
      <span aria-hidden="true">✓</span>
      ${
        current
          ? t(recap.scope === "daily" ? "kids.activity.allDone" : "kids.daily.extraComplete")
          : t("kids.daily.completedDate", { date: dayLabel(recap.date) })
      }
    </p>
    <h2>${t(recap.scope === "extra" ? "kids.daily.extraTitle" : "kids.daily.title")}</h2>
    <p class="kids-daily-summary">
      ${t(recap.questionsSolved === 1 ? "kids.daily.questionOne" : "kids.daily.questions", {
        count: String(recap.questionsSolved),
      })}
    </p>
    <dl class="kids-daily-stats">
      <div>
        <dt>${t("kids.daily.firstTry")}</dt>
        <dd class="kids-daily-value">${recap.firstTryCorrect}</dd>
      </div>
      <div>
        <dt>${t("kids.daily.hints")}</dt>
        <dd class="kids-daily-value">${recap.hintedQuestions}</dd>
      </div>
      <div>
        <dt>${t("kids.daily.perfectDays")}</dt>
        <dd class="kids-daily-value">${perfectDayStreak}</dd>
      </div>
    </dl>
    <div class="kids-daily-footer">${action}</div>
  </div>`;
}
