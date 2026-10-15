import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { KidsTouchGestures } from "./touch-gestures.ts";

const owners: KidsTouchGestures[] = [];

function fixture(markup = "<p>A fraction puzzle</p>", safari = true) {
  vi.stubGlobal("CSS", { supports: () => safari });
  const root = document.createElement("div");
  root.innerHTML = markup;
  document.body.append(root);
  const target = root.firstElementChild!;
  const owner = new KidsTouchGestures(document);
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
  it("cancels nearby stationary follow-up taps on a message or blank area", () => {
    const { root, target, owner } = fixture();
    owner.start();
    expect(tap(target, 0)).toBe(false);
    expect(tap(target, 150, 105, 104)).toBe(true);
    expect(tap(root, 600)).toBe(false);
    expect(tap(root, 750)).toBe(true);
    const click = new MouseEvent("click", { bubbles: true, cancelable: true });
    target.dispatchEvent(click);
    expect(click.defaultPrevented).toBe(false);
  });

  it.each(["<p>A puzzle</p>", "<button>Solve</button>"])(
    "suppresses every continuation in a rapid burst after its first native tap: %s",
    (markup) => {
      const { target, owner } = fixture(markup);
      owner.start();
      expect([0, 150, 300, 450].map((at) => tap(target, at))).toEqual([false, true, true, true]);
      expect(tap(target, 900)).toBe(false);
    },
  );

  it.each(["<button>Start challenge</button>", "<p>A chat message</p>"])(
    "keeps a same-position tap burst suppressed after navigation replaces the control: %s",
    (nextPage) => {
      const { root, target, owner } = fixture("<button>Solve</button>");
      owner.start();
      expect(tap(target, 0)).toBe(false);
      target.addEventListener("click", () => {
        root.innerHTML = nextPage;
      });
      target.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      expect(tap(root.firstElementChild!, 150)).toBe(true);
      expect(tap(root.firstElementChild!, 300)).toBe(true);
    },
  );

  it("leaves separated taps and long-press selection native", () => {
    const { target, owner } = fixture();
    owner.start();
    expect(tap(target, 0)).toBe(false);
    expect(tap(target, 500)).toBe(false);
    expect(tap(target, 600, 220)).toBe(false);
    expect(tap(target, 700, 220, 100, 600)).toBe(false);
    expect(tap(target, 1350, 220)).toBe(false);
  });

  it.each([
    "<button><span>Solve</span></button>",
    "<button disabled><span>Practice</span></button>",
    "<a href='#story'><span>Read</span></a>",
    "<details><summary><span>Hint</span></summary></details>",
    "<video controls></video>",
    "<audio controls></audio>",
  ])("suppresses the second tap on a control without synthesizing clicks: %s", (markup) => {
    const { root, target, owner } = fixture(markup);
    const touched = root.querySelector("span") ?? target;
    const clicked = vi.fn();
    touched.addEventListener("click", clicked);
    owner.start();
    expect(tap(touched, 0)).toBe(false);
    expect(tap(touched, 150)).toBe(true);
    expect(clicked).not.toHaveBeenCalled();
    const click = new MouseEvent("click", { bubbles: true, cancelable: true });
    touched.dispatchEvent(click);
    expect(click.defaultPrevented).toBe(false);
    expect(clicked).toHaveBeenCalledTimes(1);
  });

  it("allows spatially distinct controls while treating a control's children as one tap area", () => {
    const { root, owner } = fixture(
      "<button><span>Solve</span><small>Ready</small></button><button>Chat</button>",
    );
    owner.start();
    expect(tap(root.querySelector("span")!, 0)).toBe(false);
    expect(tap(root.querySelector("small")!, 150)).toBe(true);
    expect(tap(root.lastElementChild!, 300, 220)).toBe(false);
    expect(tap(root, 450, 340)).toBe(false);
    expect(tap(root.querySelector("span")!, 600, 100)).toBe(false);
  });

  it("observes gestures before descendant bubble handlers and removes protection on disposal", () => {
    const { target, owner } = fixture();
    for (const type of [
      "touchstart",
      "touchmove",
      "touchend",
      "touchcancel",
      "gesturestart",
      "gesturechange",
    ]) {
      target.addEventListener(type, (event) => event.stopPropagation());
    }
    const pinch = (type: string) => {
      const event = new Event(type, { bubbles: true, cancelable: true });
      target.dispatchEvent(event);
      return event.defaultPrevented;
    };
    owner.start();
    expect(tap(target, 0)).toBe(false);
    expect(tap(target, 150)).toBe(true);
    expect(dispatch(target, "touchstart", 200, [touch(target)])).toBe(false);
    expect(dispatch(target, "touchmove", 220, [touch(target, 100, 180)])).toBe(false);
    expect(dispatch(target, "touchend", 240, [touch(target, 100, 180)])).toBe(false);
    expect(tap(target, 260, 100, 180)).toBe(false);
    expect(dispatch(target, "touchstart", 350, [touch(target, 100, 180)])).toBe(false);
    expect(dispatch(target, "touchcancel", 380, [touch(target, 100, 180)])).toBe(false);
    expect(tap(target, 400, 100, 180)).toBe(false);
    expect(pinch("gesturestart")).toBe(true);
    expect(pinch("gesturechange")).toBe(true);
    owner.dispose();
    expect(tap(target, 550, 100, 180)).toBe(false);
    expect(tap(target, 700, 100, 180)).toBe(false);
    expect(pinch("gesturestart")).toBe(false);
    expect(pinch("gesturechange")).toBe(false);
  });

  it("protects the document outside the app root and removes protection on disposal", () => {
    const { owner } = fixture();
    owner.start();
    expect(tap(document.body, 0)).toBe(false);
    expect(tap(document.body, 150)).toBe(true);
    owner.dispose();
    expect(tap(document.body, 400)).toBe(false);
    expect(tap(document.body, 550)).toBe(false);
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
    "<div contenteditable><span>Keep word selection</span></div>",
  ])("preserves rapid native interaction on %s", (markup) => {
    const { target, owner } = fixture(markup);
    owner.start();
    const touched = target.firstElementChild ?? target;
    expect(tap(touched, 0)).toBe(false);
    expect(tap(touched, 150)).toBe(false);
  });

  it("suppresses zoom in both a disclosure control and its plain body", () => {
    const { root, owner } = fixture(
      "<details open><summary><span>Hint</span></summary><p>Try a common denominator.</p></details>",
    );
    owner.start();
    const summaryLabel = root.querySelector("summary span")!;
    expect(tap(summaryLabel, 0)).toBe(false);
    expect(tap(summaryLabel, 150)).toBe(true);
    const body = root.querySelector("p")!;
    expect(tap(body, 600)).toBe(false);
    expect(tap(body, 750)).toBe(true);
  });

  it.each([
    { markup: "<p>Selected words</p><button>Solve</button>", secondCancelled: true },
    {
      markup: "<div contenteditable>Selected words</div><button>Solve</button>",
      secondCancelled: false,
    },
  ])(
    "preserves editing selection without letting plain selection disable app policy: $markup",
    ({ markup, secondCancelled }) => {
      const { root, target, owner } = fixture(markup);
      owner.start();
      const range = document.createRange();
      range.selectNodeContents(target);
      document.getSelection()!.addRange(range);
      expect(tap(target, 0)).toBe(false);
      expect(tap(target, 150)).toBe(secondCancelled);
      expect(document.getSelection()!.toString()).toBe("Selected words");
      const button = root.querySelector("button")!;
      expect(tap(button, 600)).toBe(false);
      expect(tap(button, 750)).toBe(true);
    },
  );

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
