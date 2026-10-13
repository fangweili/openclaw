import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { KidsTranscriptScroll } from "./transcript-scroll.ts";

class ResizeObserverDouble implements ResizeObserver {
  static instances: ResizeObserverDouble[] = [];

  constructor(private readonly callback: ResizeObserverCallback) {
    ResizeObserverDouble.instances.push(this);
  }

  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}

  deliver(): void {
    // Deliver even after disconnect to exercise already queued browser callbacks.
    this.callback([], this);
  }
}

type Row = { id: string; height: number };
const owners: KidsTranscriptScroll[] = [];

function fixture() {
  const thread = document.createElement("main");
  const content = document.createElement("div");
  thread.append(content);
  document.body.append(thread);
  let rows: Row[] = Array.from({ length: 10 }, (_, index) => ({ id: `${index}`, height: 100 }));
  let viewport = 200;
  let position = 0;
  const height = () => rows.reduce((sum, row) => sum + row.height, 0);
  Object.defineProperties(thread, {
    clientHeight: { get: () => viewport },
    scrollHeight: { get: height },
    scrollTop: {
      get: () => position,
      set: (value: number) => {
        position = Math.max(0, Math.min(value, height() - viewport));
      },
    },
  });
  thread.getBoundingClientRect = () => new DOMRect(0, 20, 400, viewport);
  function renderRows() {
    content.replaceChildren(
      ...rows.map((row) => {
        const message = document.createElement("article");
        message.dataset.messageId = row.id;
        message.getBoundingClientRect = () => {
          const index = rows.indexOf(row);
          const offset = rows.slice(0, index).reduce((sum, item) => sum + item.height, 0);
          return new DOMRect(0, 20 + offset - position, 400, row.height);
        };
        return message;
      }),
    );
  }
  renderRows();
  const changed = vi.fn();
  const start = vi.fn();
  const end = vi.fn();
  const owner = new KidsTranscriptScroll(changed, start, end);
  owners.push(owner);
  owner.beforeRender("student-session");
  owner.afterRender(thread, content);

  return {
    owner,
    thread,
    content,
    changed,
    start,
    end,
    resize() {
      ResizeObserverDouble.instances.at(-1)!.deliver();
    },
    input() {
      thread.dispatchEvent(new WheelEvent("wheel", { deltaY: -100 }));
    },
    scroll(top: number, userInput = true) {
      if (userInput) {
        thread.dispatchEvent(new WheelEvent("wheel", { deltaY: top - position }));
      }
      thread.scrollTop = top;
      thread.dispatchEvent(new Event("scroll"));
    },
    update(change: (current: Row[]) => Row[], hasNewer = false) {
      owner.beforeRender("student-session", hasNewer);
      rows = change(rows);
      renderRows();
      owner.afterRender(thread, content);
    },
    grow(id: string, extra: number) {
      rows.find((row) => row.id === id)!.height += extra;
    },
    viewport(size: number) {
      viewport = size;
    },
    offset(id: string) {
      const message = [...content.children].find(
        (item) => (item as HTMLElement).dataset.messageId === id,
      )!;
      return message.getBoundingClientRect().top - thread.getBoundingClientRect().top;
    },
  };
}

beforeEach(() => {
  ResizeObserverDouble.instances = [];
  vi.stubGlobal("ResizeObserver", ResizeObserverDouble);
});

afterEach(() => {
  owners.splice(0).forEach((owner) => owner.dispose());
  document.body.replaceChildren();
  vi.unstubAllGlobals();
});

describe("kids transcript position", () => {
  it("follows replies and keyboard resizing until the reader leaves, then resumes on Latest", () => {
    const f = fixture();
    expect(f.thread.scrollTop).toBe(800);
    f.update((rows) => [...rows, { id: "reply", height: 100 }]);
    expect(f.thread.scrollTop).toBe(900);
    f.viewport(150);
    f.resize();
    expect(f.thread.scrollTop).toBe(950);

    f.scroll(350);
    f.scroll(300);
    expect(f.changed.mock.calls).toEqual([[true]]);
    f.update((rows) => [...rows, { id: "another-reply", height: 100 }]);
    expect(f.thread.scrollTop).toBe(300);
    expect(f.owner.awayFromLatest).toBe(true);

    f.owner.jumpToLatest();
    expect(f.thread.scrollTop).toBe(1050);
    expect(f.changed.mock.calls).toEqual([[true], [false]]);
    f.update((rows) => [...rows, { id: "last-reply", height: 100 }]);
    expect(f.thread.scrollTop).toBe(1150);
  });

  it("keeps a visible message in place through prepends, removals, and asynchronous media growth", () => {
    const f = fixture();
    f.scroll(350);
    expect(f.offset("3")).toBe(-50);
    f.update((rows) => [{ id: "older", height: 200 }, ...rows]);
    expect(f.thread.scrollTop).toBe(550);
    expect(f.offset("3")).toBe(-50);

    // The first visible message disappears; the next visible one stays put.
    expect(f.offset("4")).toBe(50);
    f.update((rows) => rows.filter((row) => row.id !== "3"));
    expect(f.thread.scrollTop).toBe(450);
    expect(f.offset("4")).toBe(50);

    f.grow("older", 180);
    f.resize();
    expect(f.thread.scrollTop).toBe(630);
    expect(f.offset("4")).toBe(50);
    f.viewport(120);
    f.resize();
    expect(f.offset("4")).toBe(50);
    expect(f.start).not.toHaveBeenCalled();
    expect(f.end).not.toHaveBeenCalled();
  });

  it("preserves the old anchor when a render beats the media resize callback", () => {
    const f = fixture();
    f.scroll(350);
    f.grow("0", 200);
    f.update((rows) => [...rows, { id: "reply", height: 100 }]);
    expect(f.thread.scrollTop).toBe(550);
    expect(f.offset("3")).toBe(-50);
    f.resize();
    expect(f.thread.scrollTop).toBe(550);
  });

  it("requests older history only for upward user scrolling, never scroll compensation", () => {
    const f = fixture();
    f.scroll(50);
    expect(f.start).toHaveBeenCalledTimes(1);
    f.update((rows) => [{ id: "older", height: 200 }, ...rows]);
    f.thread.dispatchEvent(new Event("scroll"));
    f.resize();
    expect(f.start).toHaveBeenCalledTimes(1);

    // A script moving the viewport, without a new input gesture, is not paging.
    f.scroll(0, false);
    expect(f.start).toHaveBeenCalledTimes(1);
    f.scroll(40);
    f.thread.dispatchEvent(new Event("scrollend"));
    f.scroll(20, false);
    expect(f.start).toHaveBeenCalledTimes(1);
    f.thread.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowUp" }));
    f.scroll(0, false);
    expect(f.start).toHaveBeenCalledTimes(2);
  });

  it("does not confuse a historical window's end with the latest reply", () => {
    const f = fixture();
    f.scroll(350);
    f.update((rows) => rows, true);
    f.scroll(760);
    expect(f.end).toHaveBeenCalledTimes(1);
    expect(f.owner.awayFromLatest).toBe(true);
    expect(f.changed.mock.calls).toEqual([[true]]);
    f.owner.jumpToLatest();
    expect(f.thread.scrollTop).toBe(760);

    // Keep the rendered window bounded while advancing toward newer history.
    f.update((rows) => [...rows.slice(2), { id: "next-page", height: 200 }], true);
    expect(f.thread.scrollTop).toBe(560);
    expect(f.offset("7")).toBe(-60);
    f.thread.dispatchEvent(new Event("scroll"));
    expect(f.end).toHaveBeenCalledTimes(1);
    f.update((rows) => rows);
    f.owner.jumpToLatest();
    expect(f.thread.scrollTop).toBe(800);
    expect(f.owner.awayFromLatest).toBe(false);
    expect(f.changed.mock.calls).toEqual([[true], [false]]);
  });

  it("fences layout-induced scrolls before resize delivery and callbacks after rebind/disposal", () => {
    const f = fixture();
    f.scroll(350);
    f.input();
    f.grow("0", 200);
    f.thread.scrollTop = 30;
    f.thread.dispatchEvent(new Event("scroll"));
    expect(f.offset("3")).toBe(-50);
    expect(f.start).not.toHaveBeenCalled();
    const oldObserver = ResizeObserverDouble.instances.at(-1)!;

    f.owner.beforeRender("different-student-session");
    expect(f.owner.awayFromLatest).toBe(false);
    expect(f.changed.mock.calls).toEqual([[true]]);
    f.owner.afterRender(f.thread, f.content);
    expect(f.thread.scrollTop).toBe(1000);
    f.thread.scrollTop = 200;
    oldObserver.deliver();
    expect(f.thread.scrollTop).toBe(200);

    const observer = ResizeObserverDouble.instances.at(-1)!;
    f.owner.dispose();
    f.owner.dispose();
    f.scroll(0);
    observer.deliver();
    f.owner.beforeRender("retired");
    f.owner.afterRender(f.thread, f.content);
    f.owner.jumpToLatest();
    expect(f.thread.scrollTop).toBe(0);
    expect(f.changed.mock.calls).toEqual([[true]]);
    expect(f.start).not.toHaveBeenCalled();
    expect(f.end).not.toHaveBeenCalled();
  });
});
