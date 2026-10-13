// @vitest-environment node
import { readSessionMessageSequence } from "@openclaw/gateway-client/browser";
import { describe, expect, it, vi } from "vitest";
import type { ChatHistoryResult } from "../pages/chat/chat-history-snapshot.ts";
import { KidsHistoryWindow, type KidsHistoryPageRequest } from "./history-window.ts";

function page(total: number, end = total, count = 80): ChatHistoryResult {
  const start = Math.max(1, end - count + 1);
  return {
    sessionId: "session-one",
    sessionInfo: {
      key: "agent:student:kids:child-one",
      kind: "direct",
      sessionId: "session-one",
      activeLeafEntryId: `message-${total}`,
    },
    messages: Array.from({ length: Math.max(0, end - start + 1) }, (_, index) => {
      const seq = start + index;
      return { role: "user", content: `Message ${seq}`, __openclaw: { seq, id: `message-${seq}` } };
    }),
    totalMessages: total,
    offset: total - end,
    hasMore: start > 1,
    ...(start > 1 ? { nextOffset: total - start + 1 } : {}),
  };
}

function fixture() {
  const changed = vi.fn();
  const refresh = vi.fn();
  const read = vi.fn(async ({ offset, limit }: KidsHistoryPageRequest) =>
    page(1000, 1000 - offset, limit),
  );
  const owner = new KidsHistoryWindow(read, changed, refresh);
  owner.updateTail(page(1000));
  return { owner, read, changed, refresh };
}

function sequences(owner: KidsHistoryWindow): number[] {
  return (owner.state.messages ?? []).map((message) => readSessionMessageSequence(message)!);
}

function expectContiguous(owner: KidsHistoryWindow): number[] {
  const actual = sequences(owner);
  expect(actual.length).toBeLessThanOrEqual(320);
  expect(actual).toEqual(Array.from({ length: actual.length }, (_, index) => actual[0]! + index));
  return actual;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe("kids bounded history window", () => {
  it("visits all history in both directions while retaining a bounded contiguous window", async () => {
    const { owner, read, changed } = fixture();
    expect(changed).not.toHaveBeenCalled();
    expect(owner.state).toEqual({
      messages: null,
      hasOlder: true,
      hasNewer: false,
      loading: null,
      error: null,
    });
    const visited = new Set<number>();
    while (owner.state.hasOlder) {
      await owner.loadOlder();
      for (const seq of expectContiguous(owner)) {
        visited.add(seq);
      }
    }
    expect(visited.size).toBe(1000);
    expect(sequences(owner)[0]).toBe(1);
    expect(owner.state.hasNewer).toBe(true);
    while (owner.state.hasNewer) {
      await owner.loadNewer();
      expectContiguous(owner);
    }
    expect(sequences(owner).at(-1)).toBe(1000);
    expect(owner.state.hasOlder).toBe(true);
    expect(read.mock.calls.length).toBeLessThan(30);
    expect(
      read.mock.calls.every(([request]) => request.limit === 80 && request.maxBytes === 262144),
    ).toBe(true);
    owner.returnToLatest();
    expect(owner.state.messages).toBeNull();
    expect(owner.state.hasNewer).toBe(false);
  });

  it("narrows a forward read until a byte-limited response joins without a gap", async () => {
    const { owner, read } = fixture();
    for (let index = 0; index < 4; index += 1) {
      await owner.loadOlder();
    }
    expect(sequences(owner).at(-1)).toBe(920);
    read.mockClear();
    read.mockImplementation(async ({ offset }) => page(1000, 1000 - offset, 5));
    await owner.loadNewer();
    expect(read.mock.calls.map(([request]) => request.offset)).toEqual([0, 40, 60, 70, 75]);
    expect(expectContiguous(owner).at(-1)).toBe(925);
    expect(owner.state.error).toBeNull();
  });

  it.each(["older", "newer"] as const)(
    "rebases %s offsets after a concurrent append",
    async (direction) => {
      const { owner, read } = fixture();
      if (direction === "newer") {
        for (let index = 0; index < 4; index += 1) {
          await owner.loadOlder();
        }
      }
      read.mockClear();
      read.mockImplementation(async ({ offset, limit }) => page(1001, 1001 - offset, limit));
      await (direction === "older" ? owner.loadOlder() : owner.loadNewer());
      expect(read.mock.calls.map(([request]) => request.offset)).toEqual(
        direction === "older" ? [80, 81] : [0, 1],
      );
      expectContiguous(owner);
      expect(sequences(owner).at(-1)).toBe(1000);
      expect(owner.state.hasNewer).toBe(true);
    },
  );

  it("bounds append-race retries and preserves a retryable live tail", async () => {
    const { owner, read } = fixture();
    let total = 1000;
    read.mockImplementation(async ({ offset, limit }) => {
      total += 1;
      return page(total, total - offset, limit);
    });
    await owner.loadOlder();
    expect(read).toHaveBeenCalledTimes(7);
    expect(owner.state).toMatchObject({
      messages: null,
      error: "older",
      loading: null,
      hasOlder: true,
    });
    read.mockImplementation(async ({ offset, limit }) => page(total, total - offset, limit));
    await owner.loadOlder();
    expect(expectContiguous(owner)[0]).toBe(841);
    expect(owner.state.error).toBeNull();
  });

  it("keeps browsing through an appended tail and leaf advance", async () => {
    const { owner, changed } = fixture();
    await owner.loadOlder();
    const before = owner.state.messages;
    changed.mockClear();
    owner.updateTail(page(1001));
    expect(owner.state.messages).toEqual(before);
    expect(owner.state.hasNewer).toBe(true);
    expect(changed).not.toHaveBeenCalled();
    owner.returnToLatest();
    expect(owner.state.messages).toBeNull();
  });

  it("does not invalidate an earlier page snapshot when a newer tail arrives in flight", async () => {
    const { owner, read, refresh } = fixture();
    const pending = deferred<ChatHistoryResult>();
    read.mockReturnValueOnce(pending.promise);
    const loading = owner.loadOlder();
    owner.updateTail(page(1001));
    pending.resolve(page(1000, 920));
    await loading;
    expect(expectContiguous(owner)[0]).toBe(841);
    expect(owner.state.hasNewer).toBe(true);
    expect(refresh).not.toHaveBeenCalled();
  });

  it("joins opposite-direction attempts and exposes edge-specific retry state", async () => {
    const { owner, read } = fixture();
    const pending = deferred<ChatHistoryResult>();
    read.mockReturnValueOnce(pending.promise);
    const older = owner.loadOlder();
    expect(owner.loadNewer()).toBe(older);
    expect(owner.loadOlder()).toBe(older);
    expect(owner.whenIdle()).toBe(older);
    expect(owner.state.loading).toBe("older");
    pending.resolve(page(1000, 920));
    await older;
    expect(read).toHaveBeenCalledTimes(1);
    const before = owner.state.messages;
    read.mockRejectedValueOnce(new Error("disconnected"));
    await owner.loadOlder();
    expect(owner.state.messages).toEqual(before);
    expect(owner.state.error).toBe("older");
    await owner.loadOlder();
    expect(owner.state.error).toBeNull();
    expect(expectContiguous(owner)[0]).toBe(761);
  });

  it.each(["latest", "dispose", "identity", "window-reset", "shrink", "leaf-replace"] as const)(
    "fences an in-flight read after %s",
    async (change) => {
      const { owner, read, changed, refresh } = fixture();
      const pending = deferred<ChatHistoryResult>();
      read.mockReturnValueOnce(pending.promise);
      const loading = owner.loadOlder();
      if (change === "latest") {
        owner.returnToLatest();
      } else if (change === "dispose") {
        owner.dispose();
      } else {
        const replacement = page(change === "shrink" ? 900 : 1000);
        if (change === "identity") {
          replacement.sessionId = "session-two";
          replacement.sessionInfo!.sessionId = "session-two";
        } else if (change === "window-reset") {
          replacement.windowReset = true;
        } else if (change === "leaf-replace") {
          replacement.sessionInfo!.activeLeafEntryId = "replacement-leaf";
        }
        owner.updateTail(replacement);
      }
      changed.mockClear();
      expect(owner.whenIdle()).toBe(loading);
      pending.resolve(page(1000, 920));
      await loading;
      expect(owner.state.messages).toBeNull();
      expect(owner.state.loading).toBeNull();
      expect(changed).not.toHaveBeenCalled();
      expect(refresh).not.toHaveBeenCalled();
    },
  );

  it.each(["identity", "window-reset", "shrink"] as const)(
    "requests live refresh instead of merging a %s page",
    async (change) => {
      const { owner, read, refresh } = fixture();
      await owner.loadOlder();
      const result = page(change === "shrink" ? 900 : 1000, 840);
      if (change === "identity") {
        result.sessionId = "session-two";
        result.sessionInfo!.sessionId = "session-two";
      } else if (change === "window-reset") {
        result.windowReset = true;
      }
      read.mockResolvedValueOnce(result);
      await owner.loadOlder();
      expect(owner.state.messages).toBeNull();
      expect(owner.state.error).toBe("older");
      expect(refresh).toHaveBeenCalledTimes(1);
    },
  );

  it("preserves projected siblings and removes overlapping page occurrences", async () => {
    const { owner, read } = fixture();
    const sibling = { role: "assistant", content: "A second projection", __openclaw: { seq: 921 } };
    const tail = page(1000);
    tail.messages!.splice(1, 0, sibling);
    tail.nextOffset = 79;
    owner.updateTail(tail);
    const older = page(1000, 921);
    // Replay a partially returned boundary row as the native API does.
    older.messages!.push(sibling);
    read.mockResolvedValueOnce(older);
    await owner.loadOlder();
    expect(read.mock.calls[0]![0].offset).toBe(79);
    expect(
      owner.state.messages?.filter((message) => readSessionMessageSequence(message) === 921),
    ).toHaveLength(2);
    expect(owner.state.messages).toHaveLength(160);
  });

  it("advances empty projected pages using raw continuation metadata", async () => {
    const { owner, read } = fixture();
    const hidden = page(1000, 920, 160);
    hidden.messages = [];
    read.mockResolvedValueOnce(hidden);
    await owner.loadOlder();
    await owner.loadOlder();
    expect(read.mock.calls.map(([request]) => request.offset)).toEqual([80, 240]);
    expect(owner.state.hasOlder).toBe(true);
  });

  it("stops nonadvancing older pagination until Latest resets the attempt", async () => {
    const { owner, read } = fixture();
    read.mockResolvedValueOnce({ ...page(1000, 920), nextOffset: 80, messages: [] });
    await owner.loadOlder();
    await owner.loadOlder();
    expect(read).toHaveBeenCalledTimes(1);
    expect(owner.state.hasOlder).toBe(false);
    owner.returnToLatest();
    expect(owner.state.hasOlder).toBe(true);
  });

  it("evicts whole opposite-edge pages when projected sibling count exceeds the row budget", async () => {
    const { owner, read } = fixture();
    read.mockImplementation(async ({ offset, limit }) => {
      const result = page(1000, 1000 - offset, limit);
      result.messages!.push({
        role: "assistant",
        content: "Sibling",
        __openclaw: { seq: 1000 - offset },
      });
      return result;
    });
    for (let index = 0; index < 4; index += 1) {
      await owner.loadOlder();
    }
    expect(owner.state.messages).toHaveLength(243);
    expect(owner.state.hasNewer).toBe(true);
    expect(sequences(owner)[0]).toBe(601);
    expect(sequences(owner).at(-1)).toBe(840);
  });

  it.each(["rows", "bytes"] as const)(
    "rejects an individually oversized %s page without discarding the window",
    async (bound) => {
      const { owner, read } = fixture();
      await owner.loadOlder();
      const before = owner.state.messages;
      const oversized = page(1000, 840, bound === "rows" ? 321 : 80);
      if (bound === "bytes") {
        oversized.messages = [{ role: "user", content: "x".repeat(1024 * 1024) }];
      }
      read.mockResolvedValueOnce(oversized);
      await owner.loadOlder();
      expect(owner.state.messages).toEqual(before);
      expect(owner.state.error).toBe("older");
    },
  );
});
