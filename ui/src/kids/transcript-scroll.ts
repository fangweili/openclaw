/**
 * Owns one kids transcript's scroll position: follow new replies until the reader
 * scrolls away, then preserve visible message positions through history prepends
 * and media/viewport resizing. The caller owns rendering and history requests.
 *
 * Construct without DOM effects, bracket each synchronous render with beforeRender
 * and afterRender, then dispose before removing the app. One ResizeObserver and
 * passive input/scroll listeners live only while a thread is attached. There are
 * no timers or asynchronous jobs; retired observer callbacks cannot affect a new
 * binding. The thread must disable native overflow anchoring, and message elements
 * must carry stable, unique data-message-id values within the content element.
 */

type VisibleAnchor = { id: string; offset: number };

const EDGE_DISTANCE = 100;

export class KidsTranscriptScroll {
  private binding: string | null = null;
  private thread: HTMLElement | null = null;
  private content: HTMLElement | null = null;
  private observer: ResizeObserver | null = null;
  private anchors: VisibleAnchor[] = [];
  private following = true;
  private hasNewer = false;
  private lastPublishedAway = false;
  private position = 0;
  private height = 0;
  private viewport = 0;
  private userScrolling = false;
  private disposed = false;

  /**
   * Callbacks are synchronous; onChange reports transitions, not every scroll.
   * Edge callbacks require user scrolling toward that edge; the caller coalesces
   * page requests. onReachEnd runs only while a historical window has newer rows.
   */
  constructor(
    private readonly onChange: (awayFromLatest: boolean) => void,
    private readonly onReachStart: () => void,
    private readonly onReachEnd: () => void,
  ) {}

  get awayFromLatest(): boolean {
    return !this.following;
  }

  /**
   * Capture the current viewport before the caller updates DOM. A different
   * opaque presentation binding retires listeners and starts at the latest
   * message. The app distinguishes authenticated conversations and Chat/call
   * surfaces; rendering the same binding preserves reading position.
   * hasNewer identifies a historical window whose bottom is not the latest reply.
   * This method never invokes callbacks; read awayFromLatest for the next render.
   */
  beforeRender(binding: string, hasNewer = false): void {
    if (this.disposed) {
      return;
    }
    if (binding !== this.binding) {
      this.detach();
      this.binding = binding;
      this.anchors = [];
      this.following = true;
    } else {
      // Media may have resized before ResizeObserver gets its next delivery.
      this.restorePosition();
    }
    this.hasNewer = hasNewer;
    if (hasNewer) {
      this.following = false;
    }
    this.lastPublishedAway = this.awayFromLatest;
  }

  /**
   * Attach to the rendered scrolling thread and its content, then restore the
   * viewport. Content must remain inside thread and contain all keyed messages.
   * Repeated calls reuse listeners/observer while those elements stay mounted.
   */
  afterRender(thread: HTMLElement, content: HTMLElement): void {
    if (this.disposed) {
      return;
    }
    if (thread !== this.thread || content !== this.content) {
      this.detach();
      this.thread = thread;
      this.content = content;
      thread.addEventListener("scroll", this.onScroll, { passive: true });
      thread.addEventListener("scrollend", this.onScrollEnd, { passive: true });
      thread.addEventListener("wheel", this.onInput, { passive: true });
      thread.addEventListener("touchmove", this.onInput, { passive: true });
      thread.addEventListener("pointerdown", this.onInput, { passive: true });
      thread.addEventListener("keydown", this.onInput);
      const observer = new ResizeObserver(() => {
        if (this.disposed || this.observer !== observer) {
          return;
        }
        this.restorePosition();
      });
      this.observer = observer;
      observer.observe(thread);
      observer.observe(content);
    }
    this.restorePosition();
  }

  /**
   * Instantly reveal the latest message and resume following new replies. The
   * caller must first render the live window (hasNewer=false); historical windows
   * keep their reading position until the caller performs that transition.
   */
  jumpToLatest(): void {
    if (this.disposed || this.hasNewer) {
      return;
    }
    this.userScrolling = false;
    this.anchors = [];
    this.following = true;
    this.publishFollowing();
    this.restorePosition();
  }

  /** Preserve reading position while another tab hides the transcript; reattach afterRender. */
  suspend(): void {
    this.detach();
  }

  /** Idempotently remove listeners and observer; later calls have no effects. */
  dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    this.detach();
    this.anchors = [];
  }

  private readonly onInput = (event: Event): void => {
    if (
      event instanceof KeyboardEvent &&
      !["ArrowUp", "ArrowDown", "PageUp", "PageDown", "Home", "End", " "].includes(event.key)
    ) {
      return;
    }
    this.userScrolling = true;
  };

  private readonly onScrollEnd = (): void => {
    this.userScrolling = false;
  };

  private readonly onScroll = (): void => {
    const thread = this.thread;
    if (!thread || this.disposed) {
      return;
    }
    // Browsers can dispatch a layout-induced scroll before ResizeObserver runs.
    // Such a scroll must neither change follow intent nor request another page.
    if (thread.scrollHeight !== this.height || thread.clientHeight !== this.viewport) {
      this.restorePosition();
      return;
    }
    const position = Math.max(0, thread.scrollTop);
    const binding = this.binding;
    const reachedStart =
      this.userScrolling && position < this.position && position <= EDGE_DISTANCE;
    const reachedEnd =
      this.userScrolling &&
      this.hasNewer &&
      position > this.position &&
      thread.scrollHeight - position - thread.clientHeight <= EDGE_DISTANCE;
    this.position = position;
    this.following =
      !this.hasNewer && thread.scrollHeight - position - thread.clientHeight < EDGE_DISTANCE;
    this.captureAnchors();
    this.publishFollowing();
    // onChange can synchronously render, change binding, or dispose the owner.
    if (!this.disposed && this.thread === thread && this.binding === binding) {
      if (reachedStart) {
        this.onReachStart();
      } else if (reachedEnd) {
        this.onReachEnd();
      }
    }
  };

  private publishFollowing(): void {
    const away = !this.following;
    if (away !== this.lastPublishedAway) {
      this.lastPublishedAway = away;
      this.onChange(away);
    }
  }

  private captureAnchors(): void {
    const thread = this.thread;
    const content = this.content;
    this.anchors = [];
    if (this.following || !thread || !content) {
      return;
    }
    const bounds = thread.getBoundingClientRect();
    const top = bounds.top + thread.clientTop;
    const bottom = top + thread.clientHeight;
    for (const message of content.querySelectorAll<HTMLElement>("[data-message-id]")) {
      const rect = message.getBoundingClientRect();
      if (rect.top >= bottom) {
        break;
      }
      if (rect.bottom > top) {
        this.anchors.push({ id: message.dataset.messageId!, offset: rect.top - top });
      }
    }
  }

  private restorePosition(): void {
    const thread = this.thread;
    const content = this.content;
    if (!thread || !content) {
      return;
    }
    let position = thread.scrollTop;
    if (this.following) {
      position = thread.scrollHeight - thread.clientHeight;
    } else if (this.anchors.length > 0) {
      const messages = [...content.querySelectorAll<HTMLElement>("[data-message-id]")];
      const top = thread.getBoundingClientRect().top + thread.clientTop;
      for (const anchor of this.anchors) {
        const message = messages.find((item) => item.dataset.messageId === anchor.id);
        if (message) {
          position += message.getBoundingClientRect().top - top - anchor.offset;
          break;
        }
      }
    }
    position = Math.max(0, Math.min(position, thread.scrollHeight - thread.clientHeight));
    if (position !== thread.scrollTop) {
      this.userScrolling = false;
      thread.scrollTop = position;
    }
    this.position = thread.scrollTop;
    this.height = thread.scrollHeight;
    this.viewport = thread.clientHeight;
    this.captureAnchors();
  }

  private detach(): void {
    this.observer?.disconnect();
    this.observer = null;
    const thread = this.thread;
    if (thread) {
      thread.removeEventListener("scroll", this.onScroll);
      thread.removeEventListener("scrollend", this.onScrollEnd);
      thread.removeEventListener("wheel", this.onInput);
      thread.removeEventListener("touchmove", this.onInput);
      thread.removeEventListener("pointerdown", this.onInput);
      thread.removeEventListener("keydown", this.onInput);
    }
    this.thread = null;
    this.content = null;
    this.userScrolling = false;
  }
}
