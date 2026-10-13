/**
 * Owns a bounded, contiguous history window for one kids conversation connection.
 * The conversation retains authority over the live tail, identity and sending;
 * this owner retains only historical pages and newest-relative paging metadata.
 *
 * updateTail activates/rebinds the owner. One read runs at a time; reader promises
 * belong to the connection, which cancels and joins transport work on shutdown.
 * Latest, identity resets and disposal fence late completions synchronously.
 * Historical reads never adopt branch metadata or pending-input/live-run state.
 * Failed reads retain the current window and are retried by the same direction.
 *
 * Browsing retains at most four pages, 320 projected rows and 1 MiB of serialized
 * message payload, plus one bounded latest-tail reference. Whole opposite-edge
 * pages are evicted, so every discarded interval remains refetchable. A response
 * too large to fit alone fails without publishing a partial page. Each operation
 * makes at most seven reads to rebase concurrent appends or narrow a byte-capped
 * forward interval; continued changes require another explicit reader attempt.
 */
import { prependUniqueNativeMessages } from "../lib/chat/history-message-identity.ts";
import type { ChatHistoryPagination } from "../pages/chat/chat-history-pagination.ts";
import {
  historySessionId,
  resolveChatHistoryPagination,
  type ChatHistoryResult,
} from "../pages/chat/chat-history-snapshot.ts";

type Direction = "older" | "newer";

export type KidsHistoryWindowState = {
  /** Null selects the conversation-owned live projection. Published rows are immutable. */
  messages: unknown[] | null;
  hasOlder: boolean;
  hasNewer: boolean;
  loading: Direction | null;
  error: Direction | null;
};

export type KidsHistoryPageRequest = { offset: number; limit: number; maxBytes: number };

type Page = {
  messages: unknown[];
  /** Inclusive history ordinals, not physical transcriptPosition.rawSeq values. */
  start: number;
  end: number;
  bytes: number;
};

const PAGE_ROWS = 80;
const PAGE_BYTES = 256 * 1024;
const MAX_PAGES = 4;
const MAX_ROWS = PAGE_ROWS * MAX_PAGES;
const MAX_BYTES = PAGE_BYTES * MAX_PAGES;
const MAX_READS = 7;

function pageFrom(
  result: ChatHistoryResult,
  pagination: ChatHistoryPagination,
  offset: number,
): Page | null {
  const total = pagination.totalMessages;
  if (total === undefined) {
    return null;
  }
  const messages = result.messages?.slice() ?? [];
  return {
    messages,
    // nextOffset may deliberately replay a partially returned sibling record.
    // Keep its continuation boundary and let shared identity merging deduplicate.
    start: pagination.hasMore ? total - pagination.nextOffset + 1 : 1,
    end: Math.max(0, total - (result.offset ?? offset)),
    bytes: new TextEncoder().encode(JSON.stringify(messages)).byteLength,
  };
}

function fits(pages: Page[]): boolean {
  return (
    pages.length <= MAX_PAGES &&
    pages.reduce((count, page) => count + page.messages.length, 0) <= MAX_ROWS &&
    pages.reduce((bytes, page) => bytes + page.bytes, 0) <= MAX_BYTES
  );
}

function range(pages: Page[]): { start: number; end: number } {
  return {
    start: Math.min(...pages.map((page) => page.start)),
    end: Math.max(...pages.map((page) => page.end)),
  };
}

export class KidsHistoryWindow {
  private tail: Page | null = null;
  private pages: Page[] | null = null;
  private sessionId: string | null = null;
  private leaf: string | null | undefined;
  private total = 0;
  private generation = 0;
  private disposed = false;
  private olderStopped = false;
  private error: Direction | null = null;
  private operation?: { generation: number; direction: Direction; promise: Promise<void> };

  /**
   * Callbacks run synchronously and may read state. readPage is connection-scoped
   * and must return native chat.history snapshots. onRefreshRequired asks the
   * conversation to replace a stale session/window with authoritative live history.
   */
  constructor(
    private readonly readPage: (request: KidsHistoryPageRequest) => Promise<ChatHistoryResult>,
    private readonly onChange: () => void,
    private readonly onRefreshRequired: () => void,
  ) {}

  /**
   * Capture before queued navigation and compare before admission. Latest,
   * session/window resets and disposal invalidate it; ordinary appends do not.
   */
  get revision(): number {
    return this.generation;
  }

  get state(): KidsHistoryWindowState {
    const bounds = this.pages ? range(this.pages) : this.tail;
    return {
      messages: this.pages
        ? this.pages.reduce<unknown[]>(
            (messages, page) => prependUniqueNativeMessages(messages, page.messages),
            [],
          )
        : null,
      hasOlder: !this.olderStopped && bounds !== null && bounds.start > 1,
      hasNewer: this.pages !== null && bounds !== null && bounds.end < this.total,
      loading: this.operation?.generation === this.generation ? this.operation.direction : null,
      error: this.error,
    };
  }

  /**
   * Adopt an authoritative tail; input message objects must remain immutable.
   * Ordinary appends update paging totals without moving the reader. Physical
   * session changes, explicit resets, shrinking history, and same-size leaf
   * replacement retire browsing. The caller owns any additional reset evidence
   * and publishes this synchronous state change; this method does not notify.
   */
  updateTail(result: ChatHistoryResult): void {
    if (this.disposed) {
      return;
    }
    const sessionId = historySessionId(result);
    const pagination = resolveChatHistoryPagination(result);
    const total = pagination.totalMessages ?? 0;
    const leaf = result.sessionInfo?.activeLeafEntryId;
    if (
      sessionId !== this.sessionId ||
      result.windowReset === true ||
      total < this.total ||
      (total === this.total && this.leaf !== undefined && leaf !== undefined && leaf !== this.leaf)
    ) {
      this.retireWindow();
    }
    this.sessionId = sessionId;
    this.leaf = leaf;
    this.total = total;
    const tail = pageFrom(result, pagination, 0);
    this.tail = sessionId && tail && fits([tail]) ? tail : null;
  }

  /** Join the current operation, or prepend one contiguous older page. */
  loadOlder(): Promise<void> {
    return this.start("older");
  }

  /** Join the current operation, or refill toward the live tail without a gap. */
  loadNewer(): Promise<void> {
    return this.start("newer");
  }

  /**
   * Join the outstanding read, including a retired read. The connection uses
   * this before authoritative tail refresh and after aborting on shutdown.
   */
  whenIdle(): Promise<void> {
    return this.operation?.promise ?? Promise.resolve();
  }

  /** Immediately return rendering to the live projection and fence pending reads. */
  returnToLatest(): void {
    if (this.disposed) {
      return;
    }
    this.retireWindow();
    this.onChange();
  }

  /**
   * Release retained pages and fence callbacks; idempotent and nonblocking.
   * The connection owner must cancel/join its readPage transport promises.
   */
  dispose(): void {
    this.disposed = true;
    this.retireWindow();
    this.tail = null;
  }

  private retireWindow(): void {
    this.generation += 1;
    this.pages = null;
    this.olderStopped = false;
    this.error = null;
  }

  private current(generation: number): boolean {
    return !this.disposed && generation === this.generation;
  }

  private start(direction: Direction): Promise<void> {
    if (this.disposed) {
      return Promise.resolve();
    }
    // Even a retired read remains connection-owned until it settles. Never
    // accumulate abandoned reads when the reader repeatedly changes direction.
    if (this.operation) {
      return this.operation.promise;
    }
    const state = this.state;
    if (direction === "older" ? !state.hasOlder : !state.hasNewer) {
      return Promise.resolve();
    }
    const generation = this.generation;
    this.error = null;
    const promise = this.load(direction, generation)
      .catch(() => {
        if (this.current(generation)) {
          this.error = direction;
        }
      })
      .finally(() => {
        this.operation = undefined;
        if (this.current(generation)) {
          this.onChange();
        }
      });
    this.operation = { generation, direction, promise };
    this.onChange();
    return promise;
  }

  private async load(direction: Direction, generation: number): Promise<void> {
    const pages = this.pages ?? (this.tail ? [this.tail] : []);
    if (pages.length === 0) {
      return;
    }
    const bounds = range(pages);
    let stride = PAGE_ROWS;
    for (let attempt = 0; attempt < MAX_READS; attempt += 1) {
      const end =
        direction === "older" ? bounds.start - 1 : Math.min(this.total, bounds.end + stride);
      const requestedTotal = this.total;
      const offset = Math.max(0, requestedTotal - end);
      const result = await this.readPage({ offset, limit: PAGE_ROWS, maxBytes: PAGE_BYTES });
      if (!this.current(generation)) {
        return;
      }
      const pagination = resolveChatHistoryPagination(result);
      const total = pagination.totalMessages;
      if (
        result.windowReset === true ||
        historySessionId(result) !== this.sessionId ||
        (total !== undefined && total < requestedTotal)
      ) {
        this.retireWindow();
        this.tail = null;
        this.error = direction;
        this.onChange();
        this.onRefreshRequired();
        return;
      }
      const page = pageFrom(result, pagination, offset);
      if (!page || total === undefined || !fits([page])) {
        break;
      }
      this.total = Math.max(this.total, total);
      if (page.end !== end) {
        // An append changed the newest-relative offset. Reissue against the
        // returned total; publishing this page could skip an adjacent interval.
        continue;
      }
      if (direction === "older") {
        if (page.start >= bounds.start) {
          this.olderStopped = true;
          return;
        }
      } else if (page.start > bounds.end + 1) {
        stride = Math.max(1, Math.floor(stride / 2));
        continue;
      }
      const next = direction === "older" ? [page, ...pages] : [...pages, page];
      while (!fits(next)) {
        if (direction === "older") {
          next.pop();
        } else {
          next.shift();
        }
      }
      this.pages = next;
      this.olderStopped = false;
      return;
    }
    this.error = direction;
  }
}
