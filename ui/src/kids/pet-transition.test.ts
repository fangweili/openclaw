// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { KidsPetTransition } from "./pet-transition.ts";

const animations: Array<{
  finished: ReturnType<typeof Promise.withResolvers<void>>;
  cancel: ReturnType<typeof vi.fn>;
}> = [];
const motion = Object.assign(new EventTarget(), { matches: false });

beforeEach(() => {
  animations.length = 0;
  motion.matches = false;
  vi.stubGlobal("matchMedia", () => motion);
  // jsdom has no animation engine; keep its async completion boundary explicit.
  Object.defineProperty(HTMLImageElement.prototype, "animate", {
    configurable: true,
    value: () => {
      const finished = Promise.withResolvers<void>();
      const cancel = vi.fn();
      animations.push({ finished, cancel });
      return { finished: finished.promise, cancel };
    },
  });
});
afterEach(() => {
  Reflect.deleteProperty(HTMLImageElement.prototype, "animate");
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function scene() {
  const root = document.createElement("div");
  const header = document.createElement("img");
  const hero = document.createElement("img");
  const scroller = document.createElement("main");
  scroller.className = "kids-today";
  scroller.append(hero);
  header.dataset.kidsPet = "header";
  hero.dataset.kidsPet = "hero";
  header.src = hero.src = "blob:private-current-scene";
  vi.spyOn(header, "getBoundingClientRect").mockReturnValue(new DOMRect(80, 24, 46, 46));
  vi.spyOn(hero, "getBoundingClientRect").mockReturnValue(new DOMRect(200, 180, 255, 255));
  root.append(header);
  document.body.append(root);
  const owner = new KidsPetTransition(root);
  return {
    root,
    header,
    hero,
    scroller,
    owner,
    today: () => owner.move(() => root.append(scroller)),
    chat: () => owner.move(() => scroller.remove()),
    close: () => {
      owner.dispose();
      root.remove();
    },
  };
}

it("moves the real image both ways and a retired completion cannot stop a newer move", async () => {
  const fixture = scene();
  try {
    fixture.today();
    expect(fixture.root.querySelectorAll("img")).toHaveLength(2);
    expect(fixture.hero.classList.contains("kids-pet-in-transit")).toBe(true);
    expect(fixture.header.classList.contains("kids-pet-obscured")).toBe(true);
    fixture.owner.reconcile();
    expect(animations[0]!.cancel).not.toHaveBeenCalled();
    fixture.chat();
    expect(animations[0]!.cancel).toHaveBeenCalledOnce();
    expect(fixture.root.querySelectorAll("img")).toHaveLength(1);
    expect(fixture.header.classList.contains("kids-pet-in-transit")).toBe(true);
    expect(fixture.header.classList.contains("kids-pet-obscured")).toBe(false);
    fixture.root.dispatchEvent(new Event("scroll"));
    expect(animations[1]!.cancel).not.toHaveBeenCalled();
    animations[0]!.finished.resolve();
    await Promise.resolve();
    expect(fixture.header.classList.contains("kids-pet-in-transit")).toBe(true);
    animations[1]!.finished.resolve();
    await Promise.resolve();
    expect(fixture.header.className).toBe("");
    expect(fixture.header.style.length).toBe(0);
    expect(fixture.hero.className).toBe("");
    expect(fixture.hero.style.length).toBe(0);
  } finally {
    fixture.close();
  }
});

it.each(["image", "resize", "scroll", "visibility", "motion", "dispose"] as const)(
  "immediately restores normal presentation when %s retires a move",
  async (reason) => {
    const fixture = scene();
    try {
      fixture.today();
      if (reason === "image") {
        fixture.header.src = fixture.hero.src = "blob:new-authorized-scene";
        fixture.owner.reconcile();
      } else if (reason === "resize") {
        window.dispatchEvent(new Event("resize"));
      } else if (reason === "scroll") {
        fixture.scroller.dispatchEvent(new Event("scroll"));
      } else if (reason === "visibility") {
        document.dispatchEvent(new Event("visibilitychange"));
      } else if (reason === "motion") {
        motion.matches = true;
        motion.dispatchEvent(new Event("change"));
      } else {
        fixture.owner.dispose();
      }
      expect(animations[0]!.cancel).toHaveBeenCalledOnce();
      expect(fixture.root.querySelector(".kids-pet-in-transit, .kids-pet-obscured")).toBeNull();
      expect(fixture.hero.style.length).toBe(0);
      animations[0]!.finished.resolve();
      await Promise.resolve();
      expect(fixture.root.querySelector(".kids-pet-in-transit, .kids-pet-obscured")).toBeNull();
    } finally {
      fixture.close();
    }
  },
);

it("changes pages immediately without animation when reduced motion is requested", () => {
  const fixture = scene();
  motion.matches = true;
  try {
    fixture.today();
    expect(fixture.root.contains(fixture.hero)).toBe(true);
    fixture.chat();
    expect(fixture.root.contains(fixture.hero)).toBe(false);
    expect(animations).toHaveLength(0);
    expect(fixture.header.className).toBe("");
  } finally {
    fixture.close();
  }
});
