/**
 * Owns page-zoom suppression for one kids document. CSS handles native touch
 * policy; Safari additionally needs gesture cancellation and, on releases before
 * WebKit 504edb5, a fallback for manipulation's broken double-tap policy.
 *
 * start installs listeners once; dispose removes them synchronously and forgets
 * the current touch and preceding tap. No timers, synthetic clicks, or scrolling
 * are owned here. Ordinary controls/editing and existing selections stay native.
 * On plain chat surfaces only, cancelling a second stationary tap can also
 * suppress double-tap text selection; long-press selection remains untouched.
 */

type Tap = { x: number; y: number; at: number };
type ActiveTouch = Tap & { id: number };

const TAP_INTERVAL_MS = 350;
const TAP_DISTANCE_PX = 30;
const MOVE_DISTANCE_PX = 10;
const NATIVE_CONTROLS =
  "input, textarea, select, button, a, video, audio, summary, [contenteditable]";

export class KidsTouchGestures {
  private started = false;
  private disposed = false;
  private activeTouch: ActiveTouch | null = null;
  private previousTap: Tap | null = null;

  /** Construction has no DOM effects; root and its document must outlive disposal. */
  constructor(private readonly root: HTMLElement) {}

  /** Install once. The tap fallback uses the same Safari feature gate as CSS. */
  start(): void {
    if (this.started || this.disposed) {
      return;
    }
    this.started = true;
    const document = this.root.ownerDocument;
    document.addEventListener("gesturestart", this.preventPageZoom, { passive: false });
    document.addEventListener("gesturechange", this.preventPageZoom, { passive: false });
    if (document.defaultView?.CSS?.supports("-webkit-touch-callout", "none")) {
      this.root.addEventListener("touchstart", this.touchStart, { passive: true });
      this.root.addEventListener("touchmove", this.touchMove, { passive: true });
      this.root.addEventListener("touchend", this.touchEnd, { passive: false });
      this.root.addEventListener("touchcancel", this.reset, { passive: true });
    }
  }

  /** Remove all listeners and retained tap state; idempotent and cannot restart. */
  dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    const document = this.root.ownerDocument;
    document.removeEventListener("gesturestart", this.preventPageZoom);
    document.removeEventListener("gesturechange", this.preventPageZoom);
    this.root.removeEventListener("touchstart", this.touchStart);
    this.root.removeEventListener("touchmove", this.touchMove);
    this.root.removeEventListener("touchend", this.touchEnd);
    this.root.removeEventListener("touchcancel", this.reset);
    this.reset();
  }

  private readonly preventPageZoom = (event: Event): void => event.preventDefault();

  private readonly reset = (): void => {
    this.activeTouch = null;
    this.previousTap = null;
  };

  private readonly touchStart = (event: TouchEvent): void => {
    const target = event.target;
    if (
      event.touches.length !== 1 ||
      !(target instanceof Element) ||
      target.closest(NATIVE_CONTROLS) ||
      this.root.ownerDocument.getSelection()?.isCollapsed === false
    ) {
      this.reset();
      return;
    }
    const touch = event.touches[0]!;
    this.activeTouch = {
      id: touch.identifier,
      x: touch.clientX,
      y: touch.clientY,
      at: event.timeStamp,
    };
  };

  private readonly touchMove = (event: TouchEvent): void => {
    const active = this.activeTouch;
    if (!active || event.touches.length !== 1) {
      this.reset();
      return;
    }
    const touch = event.touches[0]!;
    if (
      touch.identifier !== active.id ||
      Math.hypot(touch.clientX - active.x, touch.clientY - active.y) > MOVE_DISTANCE_PX
    ) {
      this.reset();
    }
  };

  private readonly touchEnd = (event: TouchEvent): void => {
    const active = this.activeTouch;
    this.activeTouch = null;
    if (!active || event.touches.length !== 0 || event.changedTouches.length !== 1) {
      this.previousTap = null;
      return;
    }
    const touch = event.changedTouches[0]!;
    if (
      touch.identifier !== active.id ||
      event.timeStamp - active.at > TAP_INTERVAL_MS ||
      Math.hypot(touch.clientX - active.x, touch.clientY - active.y) > MOVE_DISTANCE_PX ||
      this.root.ownerDocument.getSelection()?.isCollapsed === false
    ) {
      this.previousTap = null;
      return;
    }
    const previous = this.previousTap;
    this.previousTap = { x: touch.clientX, y: touch.clientY, at: event.timeStamp };
    if (
      previous &&
      event.timeStamp - previous.at <= TAP_INTERVAL_MS &&
      Math.hypot(touch.clientX - previous.x, touch.clientY - previous.y) <= TAP_DISTANCE_PX
    ) {
      event.preventDefault();
      this.previousTap = null;
    }
  };
}
