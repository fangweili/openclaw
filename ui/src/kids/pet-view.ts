/** Pure companion presentation; the activity owner retains the only media URL. */
import { html, nothing } from "lit";
import { t } from "../i18n/index.ts";
import type { KidsActivityState } from "./activity.ts";

/** Display admitted art and mood without fetching media or recording interaction. */
export function renderKidsPet(state: KidsActivityState, retry: () => void) {
  const mood = state.snapshot?.pet.state ?? "normal";
  return html`<section class=${`kids-pet kids-pet--${mood}`} aria-label=${t("kids.activity.pet")}>
    <div class="kids-pet-picture">
      <img
        class=${state.imageUrl ? "" : "kids-pet-placeholder"}
        src=${state.imageUrl ?? "/kids/rocky.svg"}
        alt=${state.imageUrl ? t(`kids.activity.mood.${mood}`) : ""}
      />
    </div>
    <p class="kids-pet-caption" role="status">
      ${state.snapshot?.pet.image?.caption ?? t("kids.activity.gettingReady")}
    </p>
    ${state.imageError ? html`<button class="kids-activity-link" @click=${retry}>${t("kids.activity.imageRetry")}</button>` : nothing}
  </section>`;
}
