/**
 * Owns one short DOM-only move between Rocky's header thumbnail and Today hero.
 * The app owns navigation and authorized image URLs; this owner never clones an
 * image, reads media, or owns media URLs. It temporarily positions the
 * real destination image above the scroller, then restores its normal styles.
 *
 * Construction has no effects. move brackets one synchronous app render. Rapid
 * navigation cancels the preceding move; image replacement, layout/visibility or
 * reduced-motion changes cancel it too. dispose cancels synchronously before the
 * app revokes media or removes DOM. Completion callbacks cannot alter a later move.
 */

type Flight = {
  target: HTMLImageElement;
  other: HTMLImageElement | null;
  animation: Animation;
  motion: MediaQueryList;
  source: string | null;
  scroller: Element | null;
};

const GEOMETRY = ["left", "top", "width", "height"] as const;

export class KidsPetTransition {
  private flight: Flight | null = null;
  private disposed = false;

  /** root and its document must remain alive until disposal. */
  constructor(private readonly root: HTMLElement) {}

  /** Render navigation exactly once, with optional motion between admitted images. */
  move(render: () => void): void {
    if (this.disposed) {
      return;
    }
    const source = this.currentImage();
    const from = source?.getBoundingClientRect();
    this.cancel();
    render();
    const target = this.currentImage();
    if (!source || !target || source === target || !from?.width || !from.height) {
      return;
    }
    const motion = window.matchMedia("(prefers-reduced-motion: reduce)");
    const to = target.getBoundingClientRect();
    if (
      motion.matches ||
      document.visibilityState === "hidden" ||
      !to.width ||
      !to.height ||
      source.getAttribute("src") !== target.getAttribute("src")
    ) {
      return;
    }
    const other =
      target.dataset.kidsPet === "hero"
        ? this.root.querySelector<HTMLImageElement>('[data-kids-pet="header"]')
        : null;
    for (const property of GEOMETRY) {
      target.style.setProperty(`--kids-pet-${property}`, `${to[property]}px`);
    }
    target.classList.add("kids-pet-in-transit");
    other?.classList.add("kids-pet-obscured");
    const animation = target.animate(
      [
        {
          transform: `translate(${from.left - to.left}px, ${from.top - to.top}px) scale(${from.width / to.width}, ${from.height / to.height})`,
        },
        { transform: "none" },
      ],
      { duration: 440, easing: "cubic-bezier(.22,.75,.2,1)" },
    );
    const flight = {
      target,
      other,
      animation,
      motion,
      source: target.getAttribute("src"),
      scroller: target.closest(".kids-today"),
    };
    this.flight = flight;
    window.addEventListener("resize", this.cancel);
    document.addEventListener("visibilitychange", this.cancel);
    flight.scroller?.addEventListener("scroll", this.cancel, { passive: true });
    motion.addEventListener("change", this.cancel);
    const finish = () => {
      if (this.flight === flight) {
        this.cancel();
      }
    };
    void animation.finished.then(finish, finish);
  }

  /** After every render, retire motion if its image was removed or replaced. */
  reconcile(): void {
    const flight = this.flight;
    if (
      flight &&
      (flight.target !== this.currentImage() || flight.target.getAttribute("src") !== flight.source)
    ) {
      this.cancel();
    }
  }

  /** Restore owned styles/listeners immediately; safe before media revocation. */
  readonly cancel = (): void => {
    const flight = this.flight;
    if (!flight) {
      return;
    }
    this.flight = null;
    flight.animation.cancel();
    flight.target.classList.remove("kids-pet-in-transit");
    flight.other?.classList.remove("kids-pet-obscured");
    for (const property of GEOMETRY) {
      flight.target.style.removeProperty(`--kids-pet-${property}`);
    }
    window.removeEventListener("resize", this.cancel);
    document.removeEventListener("visibilitychange", this.cancel);
    flight.scroller?.removeEventListener("scroll", this.cancel);
    flight.motion.removeEventListener("change", this.cancel);
  };

  /** Permanently stop motion; no pending completion can restore a private image. */
  dispose(): void {
    this.disposed = true;
    this.cancel();
  }

  private currentImage(): HTMLImageElement | null {
    return (
      this.root.querySelector<HTMLImageElement>('[data-kids-pet="hero"]') ??
      this.root.querySelector<HTMLImageElement>('[data-kids-pet="header"]')
    );
  }
}
