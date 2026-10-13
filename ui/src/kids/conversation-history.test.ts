// @vitest-environment node
import { afterEach, describe, expect, it } from "vitest";
import {
  createConversationTestHarness,
  hello,
  sessionKey,
  textMessage,
} from "./conversation.test-support.ts";

const { fixture, dispose } = createConversationTestHarness();
afterEach(dispose);

describe("kids history browsing", () => {
  function historyPage(total: number, offset = 0) {
    const end = total - offset;
    const start = Math.max(0, end - 80);
    return {
      sessionId: "session-one",
      sessionInfo: {
        sessionId: "session-one",
        ...(offset === 0 ? { activeLeafEntryId: `leaf-${total}` } : {}),
      },
      offset,
      totalMessages: total,
      hasMore: start > 0,
      ...(start > 0 ? { nextOffset: total - start } : {}),
      messages: Array.from({ length: end - start }, (_, index) => {
        const seq = start + index + 1;
        return textMessage("assistant", `Question ${seq}`, `row-${seq}`, {
          __openclaw: { id: `row-${seq}`, seq },
        });
      }),
    };
  }

  it("keeps historical pages separate from live branch and send admission", async () => {
    const { owner, client } = fixture();
    client.history = historyPage(400);
    client.override = (method, params) =>
      method === "chat.history" && params.offset !== undefined
        ? Promise.resolve(historyPage(400, params.offset as number))
        : undefined;
    await owner.connect(hello);
    await owner.loadOlder();
    expect(owner.state.messages).toHaveLength(160);
    expect(owner.state.messages[0]?.id).toBe("row-241");
    expect(owner.state.history).toMatchObject({ hasOlder: true, hasNewer: false });
    owner.returnToLatest();
    expect(owner.state.messages).toHaveLength(80);
    expect(await owner.send("Use my current conversation")).toBe(true);
    expect(client.calls.find((call) => call.method === "chat.send")?.params).toMatchObject({
      sessionKey,
      sessionId: "session-one",
      expectedLeafEntryId: "leaf-400",
    });
  });

  it("keeps a refresh invalidation delivered as the previous tail read settles", async () => {
    let triggerReply = false;
    const { owner, client } = fixture((state) => {
      if (triggerReply && state.status === "ready") {
        triggerReply = false;
        queueMicrotask(() => {
          client.history = historyPage(401);
          client.emit("session.message", {
            sessionKey,
            sessionId: "session-one",
            message: (client.history.messages as unknown[]).at(-1),
          });
        });
      }
    });
    client.history = historyPage(400);
    await owner.connect(hello);
    triggerReply = true;
    await owner.refresh();
    await owner.send("Answer the latest question");
    expect(client.calls.find((call) => call.method === "chat.send")?.params).toMatchObject({
      sessionId: "session-one",
      expectedLeafEntryId: "leaf-401",
    });
  });

  it("joins paging before a tail refresh and preserves browsing when a reply arrives", async () => {
    const { owner, client } = fixture();
    client.history = historyPage(400);
    await owner.connect(hello);
    const page = Promise.withResolvers<unknown>();
    client.override = (method, params) =>
      method === "chat.history" && params.offset !== undefined ? page.promise : undefined;
    const older = owner.loadOlder();
    expect(owner.state.history.loading).toBe("older");
    const refreshing = owner.refresh();
    const newest = owner.loadNewer();
    await Promise.resolve();
    expect(client.calls.filter((call) => call.method === "chat.history")).toHaveLength(2);
    client.history = historyPage(401);
    client.override = (method, params) =>
      method === "chat.history" && params.offset !== undefined
        ? Promise.resolve(historyPage(401, params.offset as number))
        : undefined;
    page.resolve(historyPage(400, 80));
    await older;
    await refreshing;
    // A queued newer request is permitted only after the authoritative tail.
    await newest;
    const reads = client.calls.filter((call) => call.method === "chat.history");
    expect(reads[2]?.params.offset).toBeUndefined();
    expect(owner.state.messages[0]?.id).toBe("row-241");
    expect(owner.state.history.error).toBeNull();
    owner.returnToLatest();
    expect(owner.state.messages.at(-1)?.id).toBe("row-401");
    expect(owner.state.history.hasNewer).toBe(false);
  });

  it.each(["latest", "backing-session", "leaf-replacement", "shrink", "window-reset"] as const)(
    "retires browsing queued behind refresh when %s changes",
    async (change) => {
      const { owner, client } = fixture();
      client.history = historyPage(400);
      await owner.connect(hello);
      const tail = Promise.withResolvers<unknown>();
      const started = Promise.withResolvers<void>();
      client.override = (method, params) => {
        if (method !== "chat.history") {
          return undefined;
        }
        if (params.offset !== undefined) {
          return Promise.resolve(historyPage(400, params.offset as number));
        }
        started.resolve();
        return tail.promise;
      };
      const refreshing = owner.refresh();
      await started.promise;
      const older = owner.loadOlder();
      if (change === "latest") {
        owner.returnToLatest();
      } else {
        const replacement = {
          ...historyPage(change === "shrink" ? 399 : 400),
          ...(change === "window-reset" ? { windowReset: true } : {}),
        };
        if (change === "backing-session") {
          replacement.sessionId = "replacement-session";
          replacement.sessionInfo.sessionId = "replacement-session";
        } else if (change === "leaf-replacement") {
          replacement.sessionInfo.activeLeafEntryId = "replacement-leaf";
        }
        client.history = replacement;
      }
      tail.resolve(client.history);
      await Promise.all([refreshing, older]);
      expect(
        client.calls.filter(
          (call) => call.method === "chat.history" && call.params.offset !== undefined,
        ),
      ).toHaveLength(0);
      expect(owner.state.messages).toHaveLength(80);
      expect(owner.state.history.loading).toBeNull();
    },
  );
});
