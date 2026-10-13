import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { KidsTouchGestures } from "./touch-gestures.ts";

const owners: KidsTouchGestures[] = [];

function fixture(markup = "<p>A fraction puzzle</p>", safari = true) {
  vi.stubGlobal("CSS", { supports: () => safari });
  const root = document.createElement("div");
  root.innerHTML = markup;
  document.body.append(root);
  const target = root.firstElementChild!;
  const owner = new KidsTouchGestures(root);
  owners.push(owner);
  return { root, target, owner };
}

function touch(target: Element, x = 100, y = 100, id = 1): Touch {
  return {
    identifier: id,
    target,
    clientX: x,
    clientY: y,
    screenX: x,
    screenY: y,
    pageX: x,
    pageY: y,
    radiusX: 1,
    radiusY: 1,
    rotationAngle: 0,
    force: 1,
  };
}

function dispatch(target: Element, type: string, at: number, touches: Touch[]) {
  const ending = type === "touchend" || type === "touchcancel";
  const event = new TouchEvent(type, {
    bubbles: true,
    cancelable: true,
    touches: ending ? [] : touches,
    changedTouches: touches,
  });
  Object.defineProperty(event, "timeStamp", { value: at });
  target.dispatchEvent(event);
  return event.defaultPrevented;
}

function tap(target: Element, at: number, x = 100, y = 100, duration = 30) {
  const finger = touch(target, x, y);
  expect(dispatch(target, "touchstart", at, [finger])).toBe(false);
  return dispatch(target, "touchend", at + duration, [finger]);
}

beforeEach(() => document.getSelection()?.removeAllRanges());
afterEach(() => {
  owners.splice(0).forEach((owner) => owner.dispose());
  document.getSelection()?.removeAllRanges();
  document.body.replaceChildren();
  vi.unstubAllGlobals();
});

describe("kids Safari touch gestures", () => {
  it("cancels only the second nearby stationary tap on a message or blank area", () => {
    const { root, target, owner } = fixture();
    owner.start();
    expect(tap(target, 0)).toBe(false);
    expect(tap(target, 150, 105, 104)).toBe(true);
    expect(tap(root, 500)).toBe(false);
    expect(tap(root, 650)).toBe(true);
    const click = new MouseEvent("click", { bubbles: true, cancelable: true });
    target.dispatchEvent(click);
    expect(click.defaultPrevented).toBe(false);
  });

  it("leaves separated taps and long-press selection native", () => {
    const { target, owner } = fixture();
    owner.start();
    expect(tap(target, 0)).toBe(false);
    expect(tap(target, 500)).toBe(false);
    expect(tap(target, 600, 220)).toBe(false);
    expect(tap(target, 700, 220, 100, 600)).toBe(false);
    expect(tap(target, 1350, 220)).toBe(false);
  });

  it("does not interpret a scroll or cancelled touch as the first tap of a pair", () => {
    const { target, owner } = fixture();
    owner.start();
    expect(tap(target, 0)).toBe(false);
    expect(dispatch(target, "touchstart", 100, [touch(target)])).toBe(false);
    expect(dispatch(target, "touchmove", 120, [touch(target, 100, 180)])).toBe(false);
    expect(dispatch(target, "touchend", 140, [touch(target, 100, 180)])).toBe(false);
    expect(tap(target, 180, 100, 180)).toBe(false);
    expect(dispatch(target, "touchstart", 250, [touch(target, 100, 180)])).toBe(false);
    expect(dispatch(target, "touchcancel", 270, [touch(target, 100, 180)])).toBe(false);
    expect(tap(target, 300, 100, 180)).toBe(false);
  });

  it("retires a candidate when another finger joins, without cancelling touch scrolling", () => {
    const { target, owner } = fixture();
    owner.start();
    expect(tap(target, 0)).toBe(false);
    expect(dispatch(target, "touchstart", 100, [touch(target)])).toBe(false);
    expect(dispatch(target, "touchstart", 110, [touch(target), touch(target, 120, 100, 2)])).toBe(
      false,
    );
    expect(dispatch(target, "touchend", 150, [touch(target)])).toBe(false);
    expect(tap(target, 200)).toBe(false);
  });

  it.each([
    "<textarea>Keep word selection</textarea>",
    "<input value='Keep typing'>",
    "<select><option>A choice</option></select>",
    "<button><span>Send</span></button>",
    "<a href='#story'><span>Read</span></a>",
    "<video controls></video>",
    "<audio controls></audio>",
    "<div contenteditable><span>Keep word selection</span></div>",
  ])("preserves rapid native interaction on %s", (markup) => {
    const { target, owner } = fixture(markup);
    owner.start();
    const touched = target.firstElementChild ?? target;
    expect(tap(touched, 0)).toBe(false);
    expect(tap(touched, 150)).toBe(false);
  });

  it("keeps disclosure controls native while suppressing zoom in their plain body", () => {
    const { root, owner } = fixture(
      "<details open><summary><span>Hint</span></summary><p>Try a common denominator.</p></details>",
    );
    owner.start();
    const summaryLabel = root.querySelector("summary span")!;
    expect(tap(summaryLabel, 0)).toBe(false);
    expect(tap(summaryLabel, 150)).toBe(false);
    const body = root.querySelector("p")!;
    expect(tap(body, 500)).toBe(false);
    expect(tap(body, 650)).toBe(true);
  });

  it("leaves existing text selection gestures native", () => {
    const { target, owner } = fixture();
    owner.start();
    const range = document.createRange();
    range.selectNodeContents(target);
    document.getSelection()!.addRange(range);
    expect(tap(target, 0)).toBe(false);
    expect(tap(target, 150)).toBe(false);
  });

  it("does not install the tap fallback on other engines", () => {
    const { target, owner } = fixture(undefined, false);
    owner.start();
    expect(tap(target, 0)).toBe(false);
    expect(tap(target, 150)).toBe(false);
  });

  it("owns pinch cancellation and removes all gesture effects on disposal", () => {
    const { target, owner } = fixture();
    const pinch = () => {
      const event = new Event("gesturechange", { bubbles: true, cancelable: true });
      target.dispatchEvent(event);
      return event.defaultPrevented;
    };
    expect(pinch()).toBe(false);
    owner.start();
    owner.start();
    expect(pinch()).toBe(true);
    expect(tap(target, 0)).toBe(false);
    owner.dispose();
    owner.dispose();
    expect(tap(target, 150)).toBe(false);
    expect(tap(target, 250)).toBe(false);
    expect(pinch()).toBe(false);
    owner.start();
    expect(tap(target, 350)).toBe(false);
    expect(pinch()).toBe(false);
  });
});
