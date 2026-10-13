/**
 * Lit adapter for one history media lease. The mounted figure owns visibility
 * observation and releases its lease when disconnected, replaced, or rebound.
 * It renders only sources authorized by KidsHistoryMedia and never starts a
 * video automatically. Decode/expired-grant failures require an explicit retry.
 */
import { html, nothing } from "lit";
import { AsyncDirective } from "lit/async-directive.js";
import { directive, type ChildPart } from "lit/directive.js";
import { t } from "../i18n/index.ts";
import type { KidsHistoryMedia, KidsMediaLease, KidsMediaPreview } from "./history-media.ts";
import type { KidsMedia } from "./media.ts";

class KidsMediaPreviewDirective extends AsyncDirective {
  private owner?: KidsHistoryMedia;
  private media?: KidsMedia;
  private generation?: number;
  private host?: Element;
  private observer?: IntersectionObserver;
  private lease?: KidsMediaLease;
  private state: KidsMediaPreview = { status: "idle" };

  override render(_owner: KidsHistoryMedia, _media: KidsMedia, _generation: number) {
    return this.content();
  }

  override update(
    part: ChildPart,
    [owner, media, generation]: [KidsHistoryMedia, KidsMedia, number],
  ) {
    const changed =
      owner !== this.owner ||
      generation !== this.generation ||
      media.artifactId !== this.media?.artifactId ||
      media.kind !== this.media?.kind;
    this.host = part.parentNode instanceof Element ? part.parentNode : undefined;
    this.owner = owner;
    this.media = media;
    this.generation = generation;
    if (changed) {
      this.stop();
      this.start();
    }
    return this.content();
  }

  protected override disconnected(): void {
    this.stop();
  }

  protected override reconnected(): void {
    this.start();
  }

  private start(): void {
    if (!this.owner || !this.media || !this.host || !this.isConnected) {
      return;
    }
    const lease = this.owner.acquire(this.media, (state) => {
      this.state = state;
      this.setValue(this.content());
    });
    this.lease = lease;
    if (typeof IntersectionObserver === "undefined") {
      lease.setVisible(true);
      return;
    }
    this.observer = new IntersectionObserver(
      (entries) => {
        if (this.lease === lease) {
          lease.setVisible(entries.some((entry) => entry.isIntersecting));
        }
      },
      { rootMargin: "120px" },
    );
    this.observer.observe(this.host);
  }

  private stop(): void {
    this.observer?.disconnect();
    this.observer = undefined;
    this.lease?.release();
    this.lease = undefined;
    this.state = { status: "idle" };
  }

  private content() {
    if (!this.media) {
      return nothing;
    }
    if (this.state.status === "ready") {
      return this.media.kind === "image"
        ? html`<img
            src=${this.state.url}
            alt=${this.media.label}
            decoding="async"
            @error=${() => this.lease?.failed()}
          />`
        : html`<video
            src=${this.state.url}
            controls
            playsinline
            preload="none"
            aria-label=${this.media.label}
            @error=${() => this.lease?.failed()}
          ></video>`;
    }
    return html`<span class="kids-media-placeholder" role="status">
      ${t(this.state.status === "error" ? "kids.media.unavailable" : "kids.media.loading")}
      ${this.state.status === "error" ? html`<button type="button" @click=${() => this.lease?.retry()}>${t("kids.retry")}</button>` : nothing}
    </span>`;
  }
}

export const kidsMediaPreview = directive(KidsMediaPreviewDirective);
