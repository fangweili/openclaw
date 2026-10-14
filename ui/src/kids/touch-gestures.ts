/**
 * Owns page-zoom suppression for one kids document. CSS handles native touch
 * policy; Safari additionally needs gesture cancellation and, on releases before
 * WebKit 504edb5, a fallback for manipulation's broken double-tap policy.
 *
 * start installs listeners once; dispose removes them synchronously and forgets
 * the current touch and preceding tap. No timers, synthetic clicks, or scrolling
 * are owned here. The first tap stays native; a second stationary tap on the
 * same control or plain surface is cancelled, including duplicate activation.
 * Different controls, editing, existing selections, and long presses stay native.
 * Cancelling a plain-surface double-tap also suppresses double-tap text selection.
 */

type Tap = { x: number; y: number; at: number; control: Element | null };
type ActiveTouch = Tap & { id: number };

const TAP_INTERVAL_MS = 350;
const TAP_DISTANCE_PX = 30;
const MOVE_DISTANCE_PX = 10;
const EDITING_CONTROLS = "input, textarea, select, [contenteditable]";
const TAP_CONTROLS = "button, a, video, audio, summary";

export class KidsTouchGestures {
  private started = false;
  private disposed = false;
  private activeTouch: ActiveTouch | null = null;
  private previousTap: Tap | null = null;

  /** Construction has no DOM effects; the document must outlive disposal. */
  constructor(private readonly document: Document) {}

  /** Install once. The tap fallback uses the same Safari feature gate as CSS. */
  start(): void {
    if (this.started || this.disposed) {
      return;
    }
    this.started = true;
    const document = this.document;
    document.addEventListener("gesturestart", this.preventPageZoom, { passive: false });
    document.addEventListener("gesturechange", this.preventPageZoom, { passive: false });
    if (document.defaultView?.CSS?.supports("-webkit-touch-callout", "none")) {
      document.addEventListener("touchstart", this.touchStart, { passive: true });
      document.addEventListener("touchmove", this.touchMove, { passive: true });
      document.addEventListener("touchend", this.touchEnd, { passive: false });
      document.addEventListener("touchcancel", this.reset, { passive: true });
    }
  }

  /** Remove all listeners and retained tap state; idempotent and cannot restart. */
  dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    const document = this.document;
    document.removeEventListener("gesturestart", this.preventPageZoom);
    document.removeEventListener("gesturechange", this.preventPageZoom);
    document.removeEventListener("touchstart", this.touchStart);
    document.removeEventListener("touchmove", this.touchMove);
    document.removeEventListener("touchend", this.touchEnd);
    document.removeEventListener("touchcancel", this.reset);
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
      target.closest(EDITING_CONTROLS) ||
      this.document.getSelection()?.isCollapsed === false
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
      control: target.closest(TAP_CONTROLS),
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
      this.document.getSelection()?.isCollapsed === false
    ) {
      this.previousTap = null;
      return;
    }
    const previous = this.previousTap;
    this.previousTap = {
      x: touch.clientX,
      y: touch.clientY,
      at: event.timeStamp,
      control: active.control,
    };
    if (
      previous &&
      previous.control === active.control &&
      event.timeStamp - previous.at <= TAP_INTERVAL_MS &&
      Math.hypot(touch.clientX - previous.x, touch.clientY - previous.y) <= TAP_DISTANCE_PX
    ) {
      event.preventDefault();
      this.previousTap = null;
    }
  };
}
