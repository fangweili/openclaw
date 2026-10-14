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

describe("kids conversation media renewal", () => {
  it("refreshes stale upload references on a user-source rewrite before the final reply", async () => {
    const { owner, client } = fixture();
    const photo = (source: string) => ({
      role: "user",
      content: "My experiment",
      __openclaw: {
        id: "photo",
        seq: 1,
        transcriptPosition: { source, rawSeq: 1 },
        media: [
          {
            url: "media://inbound/experiment.png",
            kind: "image",
            contentType: "image/png",
            artifactId: `artifact_transcript_media_${source}`,
          },
        ],
      },
    });
    const user = (source: string) =>
      textMessage("user", "Can you give me a hint?", "question", {
        __openclaw: { id: "question", seq: 2, transcriptPosition: { source, rawSeq: 2 } },
      });
    client.history.messages = [photo("source-one")];
    client.history.totalMessages = 1;
    await owner.connect(hello);
    const reads = () => client.calls.filter((call) => call.method === "chat.history").length;
    const before = reads();
    client.emit("session.message", { sessionKey, message: user("source-one") });
    expect(reads()).toBe(before);
    const started = Promise.withResolvers<void>();
    const response = Promise.withResolvers<unknown>();
    client.override = (method) => {
      if (method === "chat.history") {
        started.resolve();
        return response.promise;
      }
      return undefined;
    };
    client.history.messages = [photo("source-two"), user("source-two")];
    client.history.totalMessages = 2;
    client.emit("session.message", { sessionKey, message: user("source-two") });
    await started.promise;
    expect(reads()).toBe(before + 1);
    response.resolve(client.history);
    await owner.refresh();
    expect(owner.state.messages.map((message) => message.id)).toEqual(["photo", "question"]);
    expect(owner.state.messages[0]?.media[0]?.artifactId).toBe(
      "artifact_transcript_media_source-two",
    );
    expect(client.calls.some((call) => call.method === "chat.send")).toBe(false);
  });

  it("retries a partial media-reference renewal through the history edge without reconnecting", async () => {
    const { owner, client } = fixture();
    let source = "source-one";
    let reads = 0;
    let failAt = 0;
    client.override = (method, params) => {
      if (method !== "chat.history") {
        return undefined;
      }
      reads += 1;
      if (reads === failAt) {
        return Promise.reject(new Error("Connection interrupted during page renewal"));
      }
      const offset = Number(params.offset ?? 0);
      const end = 150 - offset;
      const start = Math.max(1, end - Number(params.limit) + 1);
      return Promise.resolve({
        sessionId: "session-one",
        sessionInfo: { sessionId: "session-one", activeLeafEntryId: "message-150" },
        totalMessages: 150,
        offset,
        hasMore: start > 1,
        ...(start > 1 ? { nextOffset: 150 - start + 1 } : {}),
        messages: Array.from({ length: end - start + 1 }, (_, index) => {
          const seq = start + index;
          return {
            role: "user",
            content: `Message ${seq}`,
            __openclaw: {
              id: `message-${seq}`,
              seq,
              transcriptPosition: { source, rawSeq: seq },
              ...(seq === 1
                ? {
                    media: [
                      {
                        url: "media://inbound/experiment.png",
                        kind: "image",
                        contentType: "image/png",
                        artifactId: `artifact_transcript_media_${source}`,
                      },
                    ],
                  }
                : {}),
            },
          };
        }),
      });
    };
    await owner.connect(hello);
    await owner.loadOlder();
    const before = owner.state.messages.map((message) => message.id);
    expect(before).toHaveLength(150);
    expect(owner.state.history.hasOlder).toBe(false);
    source = "source-two";
    failAt = reads + 3; // Tail succeeds, then only the first retained page succeeds.
    await owner.refresh();
    expect(owner.state.status).toBe("ready");
    expect(owner.state.error).toBeNull();
    expect(owner.state.history.error).toBe("older");
    expect(owner.state.messages.map((message) => message.id)).toEqual(before);
    expect(owner.state.messages[0]?.media[0]?.artifactId).toBe(
      "artifact_transcript_media_source-one",
    );
    // This is the existing history-edge Try again action, even at message one.
    await owner.loadOlder();
    expect(owner.state.history.error).toBeNull();
    expect(owner.state.messages.map((message) => message.id)).toEqual(before);
    expect(owner.state.messages[0]?.media[0]?.artifactId).toBe(
      "artifact_transcript_media_source-two",
    );
    expect(client.calls.filter((call) => call.method === "sessions.create")).toHaveLength(1);
    expect(client.calls.some((call) => call.method === "chat.send")).toBe(false);
  });
});
