/**
 * Owns the browser's bounded, memory-only activity projection for one verified
 * conversation. The plugin owns grading, clocks, streaks, and durable progress.
 * Reads and mutations serialize; one uncertain mutation retains its exact ID for
 * explicit retry. A reconnect may recover it only for the same physical session.
 * Foreground Today polls stop on hide, disconnect, or disposal. Every completion
 * is generation-fenced; disposal joins admitted RPCs and releases the pet URL.
 */
import { isGatewayProtocolResponseError } from "@openclaw/gateway-client/browser";
import type {
  ActivityFeedback,
  ActivityMutation,
  ActivityResult,
  ActivitySnapshot,
} from "@openclaw/kids-activity-contract";
import type { GatewayBrowserClient } from "../api/gateway.ts";
import { t } from "../i18n/index.ts";

type FeedbackContext = {
  prompt: string;
  activity: Pick<NonNullable<ActivitySnapshot["activity"]>, "id" | "title" | "subject">;
};

export type KidsActivityState = {
  snapshot: ActivitySnapshot | null;
  loading: boolean;
  busy: boolean;
  error: string | null;
  canRetry: boolean;
  feedback: (ActivityFeedback & FeedbackContext) | null;
  imageUrl: string | null;
  imageError: boolean;
};

type Binding = { sessionKey: string; sessionId: string };
type Pending = {
  binding: Binding;
  mutation: ActivityMutation;
  feedbackContext: FeedbackContext | null;
};
const POLL_MS = 15_000;

/** Construct an empty presentation snapshot without starting work. */
export function emptyKidsActivity(): KidsActivityState {
  return {
    snapshot: null,
    loading: false,
    busy: false,
    error: null,
    canRetry: false,
    feedback: null,
    imageUrl: null,
    imageError: false,
  };
}

export class KidsActivity {
  private binding: Binding | null = null;
  private generation = 0;
  private disposed = false;
  private visible = false;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private work: Promise<void> | null = null;
  private readonly admitted = new Set<Promise<void>>();
  private pending: Pending | null = null;
  private queuedTouch: "chat" | "voice" | null = null;
  private imageId: string | null = null;
  private snapshot = emptyKidsActivity();

  /** The app owns client lifetime and supplies a callback which does not throw. */
  constructor(
    private readonly client: Pick<GatewayBrowserClient, "request">,
    private readonly onState: (state: KidsActivityState) => void,
  ) {
    document.addEventListener("visibilitychange", this.visibilityChanged);
  }

  get state(): KidsActivityState {
    return this.snapshot;
  }

  /** Bind only after verified conversation admission; same binding is a no-op. */
  bind(binding: Binding): void {
    if (this.disposed || this.sameBinding(this.binding, binding)) {
      return;
    }
    this.disconnect();
    this.binding = binding;
    if (this.pending && !this.sameBinding(this.pending.binding, binding)) {
      this.pending = null;
    }
    this.publish({
      canRetry: this.pending !== null,
      error: this.pending ? t("kids.activity.saveFailed") : null,
    });
    if (this.foreground) {
      void this.refresh();
    }
  }

  /** Tab selection only controls polling; opening Today never records interaction. */
  setVisible(visible: boolean): void {
    if (this.visible === visible || this.disposed) {
      return;
    }
    this.visible = visible;
    this.visibilityChanged();
  }

  /** Fence callbacks and erase private presentation immediately; retain one exact retry. */
  disconnect(): void {
    this.generation += 1;
    this.binding = null;
    this.work = null;
    this.queuedTouch = null;
    this.clearTimer();
    this.releaseImage();
    this.snapshot = emptyKidsActivity();
    if (!this.disposed) {
      this.onState(this.snapshot);
    }
  }

  /** Read authoritative progress without waking the pet or altering quiz state. */
  refresh(): Promise<void> {
    if (this.disposed || !this.binding || this.work) {
      return this.work ?? Promise.resolve();
    }
    const binding = this.binding;
    const generation = this.generation;
    this.clearTimer();
    this.publish({ loading: !this.snapshot.snapshot, busy: true });
    return this.run(async () => {
      try {
        const snapshot = await this.client.request<ActivitySnapshot>("kids.activity.get", {
          sessionKey: binding.sessionKey,
        });
        if (this.current(generation)) {
          this.publish({
            snapshot,
            loading: false,
            error: this.pending ? this.snapshot.error : null,
          });
          await this.loadImage(snapshot, generation);
        }
      } catch {
        if (this.current(generation)) {
          this.publish({ loading: false, error: t("kids.activity.loadFailed") });
        }
      }
    }, generation);
  }

  /**
   * Admit one quiz operation from the displayed snapshot. Starting a completed
   * quiz consumes its server-advertised next ID; rapid duplicate taps are no-ops.
   */
  act(kind: "start" | "hint" | "answer", optionId?: string): Promise<void> {
    const data = this.snapshot.snapshot;
    const activity = data?.activity;
    const question = activity?.currentQuestion;
    if (!this.binding || this.work || this.pending || !activity || this.disposed) {
      return Promise.resolve();
    }
    const common = { requestId: crypto.randomUUID(), activityId: activity.id };
    let mutation: ActivityMutation;
    if (kind === "start") {
      const activityId = activity.completed ? data.nextActivity?.id : activity.id;
      if (!activityId) {
        return Promise.resolve();
      }
      mutation = { kind, ...common, activityId };
    } else if (question && kind === "hint") {
      mutation = { kind, ...common, questionId: question.id };
    } else if (question && kind === "answer" && optionId) {
      mutation = { kind, ...common, questionId: question.id, optionId };
    } else {
      return Promise.resolve();
    }
    this.pending = {
      binding: this.binding,
      mutation,
      feedbackContext: {
        prompt: question?.prompt ?? "",
        activity: { id: activity.id, title: activity.title, subject: activity.subject },
      },
    };
    return this.transmit(this.pending);
  }

  /** Only acknowledged text or final user speech calls this; concurrent turns coalesce. */
  touch(source: "chat" | "voice"): void {
    if (!this.binding || this.disposed) {
      return;
    }
    this.queuedTouch = source;
    this.flushTouch();
  }

  /** Replay the same uncertain operation, or explicitly retry a failed read/image. */
  retry(): Promise<void> {
    if (!this.binding || this.work || this.disposed) {
      return this.work ?? Promise.resolve();
    }
    if (this.pending && this.sameBinding(this.pending.binding, this.binding)) {
      return this.transmit(this.pending);
    }
    this.imageId = null;
    return this.refresh();
  }

  /** Dismiss acknowledged feedback; the next question already came from the server. */
  continue(): void {
    this.publish({ feedback: null });
  }

  /** Permanently fence results, stop polling, revoke media, and join admitted requests. */
  async dispose(): Promise<void> {
    this.disposed = true;
    document.removeEventListener("visibilitychange", this.visibilityChanged);
    this.disconnect();
    this.pending = null;
    await Promise.allSettled(this.admitted);
  }

  private transmit(pending: Pending): Promise<void> {
    const generation = this.generation;
    this.clearTimer();
    this.publish({ busy: true, error: null, canRetry: false });
    return this.run(async () => {
      try {
        const { kind, ...params } = pending.mutation;
        const result = await this.client.request<ActivityResult>(`kids.activity.${kind}`, {
          sessionKey: pending.binding.sessionKey,
          ...params,
        });
        if (!this.current(generation)) {
          return;
        }
        this.pending = null;
        this.publish({
          snapshot: result.snapshot,
          loading: false,
          error: null,
          ...(result.feedback && pending.feedbackContext
            ? { feedback: { ...result.feedback, ...pending.feedbackContext } }
            : {}),
        });
        await this.loadImage(result.snapshot, generation);
      } catch (error) {
        if (this.current(generation)) {
          const uncertain = !(
            isGatewayProtocolResponseError(error) &&
            ["INVALID_REQUEST", "FORBIDDEN", "NOT_FOUND"].includes(error.code)
          );
          if (!uncertain) {
            this.pending = null;
          }
          this.publish({
            busy: false,
            canRetry: uncertain,
            error: t(uncertain ? "kids.activity.saveFailed" : "kids.activity.changed"),
          });
        }
      }
    }, generation);
  }

  private run(task: () => Promise<void>, generation: number): Promise<void> {
    const work = task().finally(() => {
      this.admitted.delete(work);
      if (this.current(generation) && this.work === work) {
        this.work = null;
        this.publish({ busy: false });
        this.flushTouch();
        this.schedule();
      }
    });
    this.work = work;
    this.admitted.add(work);
    return work;
  }

  private flushTouch(): void {
    if (!this.binding || this.work || this.pending || !this.queuedTouch) {
      return;
    }
    const source = this.queuedTouch;
    this.queuedTouch = null;
    this.pending = {
      binding: this.binding,
      mutation: { kind: "touch", requestId: crypto.randomUUID(), source },
      feedbackContext: null,
    };
    void this.transmit(this.pending);
  }

  private async loadImage(snapshot: ActivitySnapshot, generation: number): Promise<void> {
    const imageId = snapshot.pet.image?.imageId ?? null;
    if (this.imageId === imageId) {
      return;
    }
    this.releaseImage();
    this.imageId = imageId;
    this.publish({ imageUrl: null, imageError: false });
    if (!imageId || !this.binding) {
      return;
    }
    try {
      const image = await this.client.request<{ mimeType: string; base64: string }>(
        "kids.activity.image",
        { sessionKey: this.binding.sessionKey, imageId },
      );
      if (!this.current(generation) || this.imageId !== imageId) {
        return;
      }
      const bytes = Uint8Array.from(atob(image.base64), (character) => character.charCodeAt(0));
      const imageUrl = URL.createObjectURL(new Blob([bytes], { type: image.mimeType }));
      this.publish({ imageUrl });
    } catch {
      if (this.current(generation) && this.imageId === imageId) {
        this.publish({ imageError: true });
      }
    }
  }

  private releaseImage(): void {
    if (this.snapshot.imageUrl) {
      URL.revokeObjectURL(this.snapshot.imageUrl);
    }
    this.imageId = null;
  }

  private get foreground(): boolean {
    return this.visible && document.visibilityState !== "hidden";
  }

  private readonly visibilityChanged = (): void => {
    this.clearTimer();
    if (this.foreground) {
      void this.refresh();
    }
  };

  private schedule(): void {
    if (this.binding && this.foreground && !this.work && !this.disposed) {
      this.clearTimer();
      this.timer = setTimeout(() => {
        this.timer = null;
        void this.refresh();
      }, POLL_MS);
    }
  }

  private clearTimer(): void {
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  private current(generation: number): boolean {
    return !this.disposed && this.binding !== null && generation === this.generation;
  }

  private sameBinding(left: Binding | null, right: Binding): boolean {
    return left?.sessionKey === right.sessionKey && left.sessionId === right.sessionId;
  }

  private publish(update: Partial<KidsActivityState>): void {
    const changedActivity =
      update.snapshot && update.snapshot.activity?.id !== this.snapshot.snapshot?.activity?.id;
    this.snapshot = {
      ...this.snapshot,
      ...update,
      // A fresh answer carries its submitted heading even when the server rolls
      // to today's quiz. Later background activity changes retire that panel.
      ...(changedActivity && !update.feedback ? { feedback: null } : {}),
    };
    if (!this.disposed) {
      this.onState(this.snapshot);
    }
  }
}
