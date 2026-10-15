/** Today is a small launch surface; durable work stays with the existing owners. */
import { html, svg } from "lit";
import { strokeIcon } from "../components/icons-tools.ts";
import { t } from "../i18n/index.ts";
import type { KidsActivityState } from "./activity.ts";
import { completedKidsDay } from "./daily-view.ts";
import type { KidsPage } from "./navigation.ts";
import { renderKidsPet } from "./pet-view.ts";

const chat = strokeIcon(
  svg`<path d="M21 11.5a8.4 8.4 0 01-.9 3.8 8.5 8.5 0 01-7.6 4.7 8.4 8.4 0 01-3.8-.9L3 21l1.9-5.7a8.4 8.4 0 01-.9-3.8 8.5 8.5 0 014.7-7.6 8.4 8.4 0 013.8-.9h.5a8.5 8.5 0 018 8z"/>`,
);
const arrow = strokeIcon(svg`<path d="M5 12h14m-6-6 6 6-6 6"/>`);
const solve = strokeIcon(
  svg`<path d="M8 3h4a2 2 0 114 0h4v5a2 2 0 110 4v8h-8a2 2 0 110-4H8v4H3v-8a2 2 0 110-4V3h5z"/>`,
);
const practice = strokeIcon(
  svg`<path d="M9 18V5l12-2v13M9 8l12-2"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/>`,
);
const create = strokeIcon(
  svg`<path d="M12 3a9 9 0 100 18h1.5a1.5 1.5 0 001.1-2.5 1.5 1.5 0 011.1-2.5H17a4 4 0 004-4 9 9 0 00-9-9z"/><circle cx="7.5" cy="10" r=".5"/><circle cx="10" cy="6.5" r=".5"/><circle cx="15" cy="7" r=".5"/>`,
);
const finish = strokeIcon(svg`<circle cx="12" cy="12" r="9"/><path d="m8 12 3 3 5-6"/>`);

/**
 * Render the admitted conversation name only; an empty name gets a generic title.
 * Keep this panel mounted while authorized so native scrolling survives navigation.
 */
export function renderKidsHome(
  activity: KidsActivityState,
  childName: string,
  navigate: (page: KidsPage) => void,
  retry: () => void,
  hidden: boolean,
) {
  const completed = completedKidsDay(activity.snapshot);
  const todayComplete = completed !== null && completed.date === activity.snapshot?.date;
  const selected = activity.snapshot?.activity;
  const daily = activity.snapshot?.daily;
  const dailySolved = String(daily?.questionsSolved ?? 0);
  const extras = activity.snapshot?.extras.questionsSolved ?? 0;
  const detail = activity.preparing
    ? t("kids.activity.preparing")
    : todayComplete
      ? selected?.scope === "extra" && !selected.completed
        ? t("kids.home.solveExtraResume", { count: dailySolved })
        : extras > 0
          ? t("kids.home.solveExtraComplete", { daily: dailySolved, extra: String(extras) })
          : t("kids.home.solveComplete", { count: dailySolved })
      : selected?.started && !selected.completed && selected.date !== activity.snapshot?.date
        ? t("kids.home.solveResume")
        : daily && daily.date === activity.snapshot?.date
          ? t("kids.home.solveProgress", {
              completed: String(daily.questionsSolved),
              total: String(daily.questionTotal),
            })
          : t("kids.home.solveDetail");
  return html`<main
    class="kids-today kids-home"
    aria-label=${t("kids.activity.today")}
    ?hidden=${hidden}
  >
    <h1 class="kids-page-title kids-home-title" id="kids-home-title">
      ${childName ? t("kids.home.personalTitle", { name: childName }) : t("kids.home.title")}
    </h1>
    ${renderKidsPet(activity, retry)}
    <section class="kids-home-content" aria-labelledby="kids-home-title">
      <button
        class="kids-home-chat"
        aria-label=${t("kids.activity.chatAction")}
        @click=${() => navigate("chat")}
      >
        <span class="kids-home-icon" aria-hidden="true">${chat}</span>
        <span class="kids-home-card-copy"
          ><strong>${t("kids.activity.chatAction")}</strong
          ><span>${t("kids.home.chatDetail")}</span></span
        >
        <span class="kids-home-arrow" aria-hidden="true">${arrow}</span>
      </button>
      <div class="kids-home-grid">
        <button
          class="kids-home-card kids-home-solve"
          aria-label=${t("kids.home.solve")}
          @click=${() => navigate("solve")}
        >
          <span class="kids-home-card-top"
            ><span aria-hidden="true">${solve}</span
            ><span aria-hidden="true">${todayComplete ? finish : arrow}</span></span
          >
          <strong>${t("kids.home.solve")}</strong><span class="kids-home-detail">${detail}</span>
        </button>
        ${(
          [
            ["practice", practice],
            ["create", create],
            ["finish", finish],
          ] as const
        ).map(
          ([key, icon]) => html`
            <button
              class="kids-home-card"
              disabled
              aria-label=${t("kids.home.unavailable", { name: t(`kids.home.${key}`) })}
            >
              <span class="kids-home-card-top"
                ><span aria-hidden="true">${icon}</span
                ><span class="kids-home-soon">${t("kids.home.comingLater")}</span></span
              >
              <strong>${t(`kids.home.${key}`)}</strong
              ><span class="kids-home-detail">${t(`kids.home.${key}Detail`)}</span>
            </button>
          `,
        )}
      </div>
    </section>
  </main>`;
}
