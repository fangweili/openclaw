// @vitest-environment node
import type { GatewayProtocolRequestOptions } from "@openclaw/gateway-client/browser";
import { afterEach, describe, expect, it } from "vitest";
import {
  GatewayProtocolRequestError,
  retainGatewayResponsePayload,
} from "../../../packages/gateway-client/src/protocol-request.js";
import type { GatewayEventFrame, GatewayHelloOk } from "../api/gateway.ts";
import { KidsConversation, type KidsConversationState } from "./conversation.ts";

const hello: GatewayHelloOk = { type: "hello-ok", protocol: 4 };
const sessionKey = "agent:student:kids:child-one";
const textMessage = (role: string, text: string, id: string, extra: object = {}) => ({
  role,
  content: [{ type: "text", text }],
  __openclaw: { id },
  ...extra,
});

// Matches commitBackgroundResultToSession's durable completion, not the
// transcript-only delivery mirror or a foreground model's chat.final event.
const scheduledChallenge = {
  role: "assistant",
  content: [{ type: "text", text: "Today's puzzle: what is half of three quarters?" }],
  api: "openclaw-transcript",
  provider: "openclaw",
  model: "automation-result",
  stopReason: "stop",
  timestamp: 1,
  idempotencyKey: "cron-current-completion:challenge-run",
  openclawAutomation: { kind: "cron", jobId: "daily-challenge", runId: "challenge-run" },
};
const savedChallenge = {
  ...scheduledChallenge,
  __openclaw: { id: "challenge-message", seq: 3 },
};

/** Deterministic RPC boundary; deferred replies can deliberately ignore abort. */
class TestGateway {
  connected = true;
  connectionGeneration = 1;
  calls: Array<{
    method: string;
    params: Record<string, unknown>;
    options?: GatewayProtocolRequestOptions;
  }> = [];
  listeners = new Set<(event: GatewayEventFrame) => void>();
  profileId = "child-one";
  agents = [{ id: "student", name: "Rocky" }];
  history: Record<string, unknown> = {
    sessionId: "session-one",
    sessionInfo: { sessionId: "session-one", activeLeafEntryId: "leaf-one" },
    messages: [textMessage("user", "Hi", "u1"), textMessage("assistant", "Hello!", "a1")],
  };
  override?: (method: string, params: Record<string, unknown>) => Promise<unknown> | undefined;

  addEventListener(listener: (event: GatewayEventFrame) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async request<T>(
    method: string,
    input?: unknown,
    options?: GatewayProtocolRequestOptions,
  ): Promise<T> {
    const params = input as Record<string, unknown>;
    this.calls.push({ method, params, options });
    options?.onSent?.("request");
    const override = this.override?.(method, params);
    if (override) {
      return (await override) as T;
    }
    const responses: Record<string, unknown> = {
      "users.self": { profile: { id: this.profileId, displayName: "Child" } },
      "agents.list": { agents: this.agents },
      "sessions.create": { key: params.key },
      "sessions.messages.subscribe": { key: params.key },
      "sessions.messages.unsubscribe": { key: params.key },
      "chat.history": this.history,
      "chat.send": { runId: params.idempotencyKey, status: "started" },
    };
    if (!(method in responses)) {
      throw new Error(`Unexpected request: ${method}`);
    }
    return responses[method] as T;
  }

  emit(event: string, payload: Record<string, unknown>): void {
    for (const listener of this.listeners) {
      listener({ type: "event", event, payload });
    }
  }
}

const owners: KidsConversation[] = [];
function fixture() {
  const client = new TestGateway();
  const states: KidsConversationState[] = [];
  const accepted: string[] = [];
  const owner = new KidsConversation(
    client,
    (state) => states.push(state),
    (text) => accepted.push(text),
  );
  owners.push(owner);
  return { owner, client, states, accepted };
}
afterEach(async () => {
  await Promise.all(owners.splice(0).map((owner) => owner.dispose()));
});

describe("kids conversation", () => {
  it("binds verified identity to the sole agent and sends against the displayed branch", async () => {
    const { owner, client } = fixture();
    await owner.connect(hello);
    expect(owner.state).toMatchObject({
      status: "ready",
      childName: "Child",
      agentId: "student",
      sessionKey,
    });
    expect(client.calls.find((call) => call.method === "sessions.create")?.params).toEqual({
      key: sessionKey,
      agentId: "student",
      displayName: "Rocky",
    });
    expect(client.calls.find((call) => call.method === "chat.history")?.params).toMatchObject({
      limit: 80,
      maxBytes: 262144,
    });
    await expect(owner.send("  Can we practice?  ")).resolves.toBe(true);
    expect(client.calls.find((call) => call.method === "chat.send")?.params).toEqual({
      sessionKey,
      agentId: "student",
      sessionId: "session-one",
      expectedLeafEntryId: "leaf-one",
      message: "Can we practice?",
      idempotencyKey: expect.any(String),
      deliver: false,
    });
  });

  it.each(["shared", "none", "multiple"])(
    "refuses %s identity access before session creation",
    async (kind) => {
      const { owner, client } = fixture();
      if (kind === "shared") {
        client.profileId = "gateway-owner";
      }
      if (kind === "none") {
        client.agents = [];
      }
      if (kind === "multiple") {
        client.agents.push({ id: "another-child", name: "Rocky" });
      }
      await owner.connect(hello);
      expect(owner.state.status).toBe("error");
      expect(owner.state.sessionKey).toBe("");
      expect(client.calls.some((call) => call.method === "sessions.create")).toBe(false);
    },
  );

  it("discards a late identity response before it can create the previous child's session", async () => {
    const { owner, client } = fixture();
    const oldIdentity = Promise.withResolvers<unknown>();
    client.override = (method) => (method === "users.self" ? oldIdentity.promise : undefined);
    const oldConnect = owner.connect(hello);
    owner.disconnect();
    client.connectionGeneration += 1;
    client.profileId = "child-two";
    client.override = undefined;
    await owner.connect(hello);
    oldIdentity.resolve({ profile: { id: "child-one", displayName: "Old Child" } });
    await oldConnect;
    expect(owner.state.sessionKey).toBe("agent:student:kids:child-two");
    expect(client.calls.filter((call) => call.method === "sessions.create")).toHaveLength(1);
  });

  it("shows only user messages and finished replies, never thinking, tools, commentary, or deltas", async () => {
    const { owner, client, states } = fixture();
    client.history.messages = [
      textMessage("user", "What is 7 × 8?", "u1"),
      textMessage("assistant", "Checking a tool", "activity", {
        stopReason: "toolUse",
        content: [
          { type: "text", text: "Checking a tool" },
          { type: "toolCall", name: "calculator" },
        ],
      }),
      textMessage("assistant", "Let me think", "commentary", { phase: "commentary" }),
      textMessage("toolResult", "Private tool output", "tool"),
      { role: "assistant", content: [{ type: "thinking", thinking: "Private reasoning" }] },
      {
        role: "assistant",
        content: [
          {
            type: "text",
            text: "Private commentary",
            textSignature: JSON.stringify({ v: 1, phase: "commentary" }),
          },
          {
            type: "text",
            text: "7 × 8 = 56.",
            textSignature: JSON.stringify({ v: 1, phase: "final_answer" }),
          },
        ],
        __openclaw: { id: "final" },
      },
    ];
    await owner.connect(hello);
    expect(owner.state.messages.map((message) => message.text)).toEqual([
      "What is 7 × 8?",
      "7 × 8 = 56.",
    ]);
    client.emit("chat", {
      sessionKey,
      runId: "run",
      state: "delta",
      message: textMessage("assistant", "Unfinished partial answer", "partial"),
    });
    client.emit("session.message", {
      sessionKey,
      message: textMessage("assistant", "Calling calculator", "tool-call", {
        content: [
          { type: "text", text: "Calling calculator" },
          { type: "toolCall", name: "calculator" },
        ],
      }),
    });
    expect(owner.state.busy).toBe(true);
    expect(owner.state.messages).toHaveLength(2);
    const final = textMessage("assistant", "Your turn!", "next-final", { phase: "final_answer" });
    client.history.messages = [...(client.history.messages as unknown[]), final];
    client.emit("session.message", { sessionKey, message: final, runId: "run" });
    client.emit("chat", { sessionKey, runId: "run", state: "final", message: final });
    await owner.refresh();
    expect(owner.state.messages.map((message) => message.text)).toEqual([
      "What is 7 × 8?",
      "7 × 8 = 56.",
      "Your turn!",
    ]);
    expect(JSON.stringify(states)).not.toMatch(
      /Private|Unfinished|Calling calculator|Checking a tool|Let me think/,
    );
  });

  it("ignores other children and late history after disconnect", async () => {
    const { owner, client } = fixture();
    await owner.connect(hello);
    client.emit("session.message", {
      sessionKey: "agent:other:main",
      message: textMessage("assistant", "Other child", "other"),
    });
    expect(owner.state.messages).toHaveLength(2);
    const delayed = Promise.withResolvers<unknown>();
    client.override = (method) => (method === "chat.history" ? delayed.promise : undefined);
    const pending = owner.refresh();
    owner.disconnect();
    delayed.resolve(client.history);
    await pending;
    expect(owner.state).toMatchObject({
      status: "disconnected",
      messages: [],
      sessionKey: "",
      childName: "",
    });
  });

  it("uses durable history for an unkeyed final event without creating a provisional duplicate", async () => {
    const { owner, client } = fixture();
    await owner.connect(hello);
    const answer = textMessage("assistant", "Same answer", "answer-one", {
      stopReason: "toolUse",
      __openclaw: { id: "answer-one", runId: "run-one", seq: 3 },
    });
    client.history.messages = [...(client.history.messages as unknown[]), answer];
    client.emit("chat", {
      sessionKey,
      state: "final",
      runId: "run-one",
      message: { role: "assistant", content: [{ type: "text", text: "Same answer" }] },
    });
    await owner.refresh();
    expect(owner.state.messages.filter((message) => message.text === "Same answer")).toHaveLength(
      1,
    );
    client.history.messages = [
      ...(client.history.messages as unknown[]),
      textMessage("assistant", "Same answer", "answer-two"),
    ];
    await owner.refresh();
    expect(owner.state.messages.filter((message) => message.text === "Same answer")).toHaveLength(
      2,
    );
  });

  it("loads an offline scheduled challenge from durable history on reconnect", async () => {
    const { owner, client } = fixture();
    await owner.connect(hello);
    owner.disconnect();
    client.connectionGeneration += 1;
    client.history.messages = [...(client.history.messages as unknown[]), savedChallenge];
    client.history.sessionInfo = {
      sessionId: "session-one",
      activeLeafEntryId: "challenge-message",
    };

    await owner.connect(hello);

    expect(owner.state).toMatchObject({ status: "ready", busy: false, error: null });
    expect(owner.state.messages.at(-1)).toEqual({
      id: "challenge-message",
      role: "assistant",
      text: scheduledChallenge.content[0]!.text,
    });
    expect(client.calls.some((call) => call.method === "chat.send")).toBe(false);
    await expect(owner.send("I think it is three eighths.")).resolves.toBe(true);
    expect(client.calls.find((call) => call.method === "chat.send")?.params).toMatchObject({
      sessionKey,
      sessionId: "session-one",
      expectedLeafEntryId: "challenge-message",
    });
  });

  it("shows a subscribed challenge without chat.final and reconciles replay with saved history", async () => {
    const { owner, client } = fixture();
    await owner.connect(hello);
    expect(
      client.calls.find((call) => call.method === "sessions.messages.subscribe")?.params,
    ).toMatchObject({ key: sessionKey, agentId: "student" });
    const readCount = client.calls.filter((call) => call.method === "chat.history").length;
    const refreshed = Promise.withResolvers<unknown>();
    client.override = (method) => (method === "chat.history" ? refreshed.promise : undefined);
    const envelope = {
      key: sessionKey,
      agentId: "student",
      sessionId: "session-one",
      messageId: "challenge-message",
      messageSeq: 3,
      message: scheduledChallenge,
    };

    client.emit("session.message", envelope);
    client.emit("session.message", envelope);

    // The subscription itself must present the completed challenge; the held
    // read proves this does not depend on a chat.final or history polling.
    expect(owner.state).toMatchObject({ status: "ready", busy: false, error: null });
    expect(owner.state.messages.filter((message) => message.id === "challenge-message")).toEqual([
      { id: "challenge-message", role: "assistant", text: scheduledChallenge.content[0]!.text },
    ]);
    expect(client.calls.filter((call) => call.method === "chat.history")).toHaveLength(
      readCount + 1,
    );
    client.history.messages = [...(client.history.messages as unknown[]), savedChallenge];
    client.history.sessionInfo = {
      sessionId: "session-one",
      activeLeafEntryId: "challenge-message",
    };
    refreshed.resolve(client.history);
    await owner.refresh();

    expect(owner.state.busy).toBe(false);
    expect(
      owner.state.messages.filter((message) => message.id === "challenge-message"),
    ).toHaveLength(1);
    expect(client.calls.some((call) => call.method === "chat.send")).toBe(false);
  });

  it.each(["session.message", "chat.final"])(
    "waits for the branch refreshed by %s before admitting one concurrent reply",
    async (event) => {
      const { owner, client } = fixture();
      await owner.connect(hello);
      const refreshed = Promise.withResolvers<unknown>();
      client.override = (method) => (method === "chat.history" ? refreshed.promise : undefined);
      if (event === "session.message") {
        client.emit("session.message", {
          key: sessionKey,
          messageId: "challenge-message",
          messageSeq: 3,
          message: scheduledChallenge,
        });
        expect(owner.state.busy).toBe(false);
      } else {
        client.emit("chat", {
          sessionKey,
          runId: "challenge-run",
          state: "final",
          message: scheduledChallenge,
        });
      }
      const firstSend = owner.send("Three eighths?");
      const concurrentSend = owner.send("Another answer");
      expect(client.calls.some((call) => call.method === "chat.send")).toBe(false);
      client.history.messages = [...(client.history.messages as unknown[]), savedChallenge];
      client.history.sessionInfo = {
        sessionId: "session-one",
        activeLeafEntryId: "challenge-message",
      };

      refreshed.resolve(client.history);

      await expect(Promise.all([firstSend, concurrentSend])).resolves.toEqual([true, false]);
      const sends = client.calls.filter((call) => call.method === "chat.send");
      expect(sends).toHaveLength(1);
      expect(sends[0]!.params).toMatchObject({
        sessionKey,
        sessionId: "session-one",
        expectedLeafEntryId: "challenge-message",
        message: "Three eighths?",
      });
    },
  );

  it("does not admit a waiting reply into the next authenticated conversation", async () => {
    const { owner, client } = fixture();
    await owner.connect(hello);
    const refreshed = Promise.withResolvers<unknown>();
    client.override = (method) => (method === "chat.history" ? refreshed.promise : undefined);
    const oldHistory = owner.refresh();
    const waitingSend = owner.send("Answer for the old child");
    owner.disconnect();
    client.connectionGeneration += 1;
    client.profileId = "child-two";
    client.override = undefined;
    await owner.connect(hello);
    refreshed.resolve(client.history);
    await oldHistory;

    await expect(waitingSend).resolves.toBe(false);
    expect(owner.state.sessionKey).toBe("agent:student:kids:child-two");
    expect(client.calls.some((call) => call.method === "chat.send")).toBe(false);
  });

  it.each(["cancelled", "interrupted"])(
    "retains %s input without pretending Rocky is still replying",
    async (state) => {
      const { owner, client } = fixture();
      client.history.pendingInputs = {
        total: 1,
        queuedCount: 0,
        items: [
          {
            id: "pending-one",
            state,
            acceptedAt: 1,
            message: textMessage("user", "Unfinished question", "pending-one"),
          },
        ],
      };
      await owner.connect(hello);
      expect(owner.state.status).toBe("ready");
      expect(owner.state.busy).toBe(false);
      expect(owner.state.error).toMatch(/message did not finish/i);
      expect(owner.state.messages.some((message) => message.text === "Unfinished question")).toBe(
        true,
      );
      expect(client.calls.some((call) => call.method === "chat.send")).toBe(false);
      await expect(owner.send("Try a different question")).resolves.toBe(true);
    },
  );

  it("keeps queued work busy even when it is outside the bounded pending page", async () => {
    const { owner, client } = fixture();
    client.history.pendingInputs = { total: 21, queuedCount: 1, items: [] };
    await owner.connect(hello);
    expect(owner.state.busy).toBe(true);
    await expect(owner.send("Wait for the queued question")).resolves.toBe(false);
  });

  it("blocks duplicate sends after a transport uncertainty and reconciles the original receipt", async () => {
    const { owner, client, accepted } = fixture();
    await owner.connect(hello);
    client.override = (method) =>
      method === "chat.send" ? Promise.reject(new Error("Socket failed")) : undefined;
    await expect(owner.send("Practice fractions")).resolves.toBe(false);
    expect(owner.state.busy).toBe(true);
    await expect(owner.send("Practice fractions")).resolves.toBe(false);
    const sends = client.calls.filter((call) => call.method === "chat.send");
    expect(sends).toHaveLength(1);
    const runId = sends[0]!.params.idempotencyKey;
    expect(client.calls.at(-1)?.params.inputRunIds).toEqual([runId]);
    owner.disconnect();
    client.connectionGeneration += 1;
    client.history.inputReceipts = [{ runId, state: "consumed", consumedByEventId: "input-event" }];
    client.history.messages = [
      textMessage("user", "Practice fractions", "persisted", { idempotencyKey: runId }),
    ];
    await owner.connect(hello);
    expect(owner.state.busy).toBe(false);
    expect(owner.state.messages.map((message) => message.text)).toEqual(["Practice fractions"]);
    expect(client.calls.filter((call) => call.method === "chat.send")).toHaveLength(1);
    expect(accepted).toEqual(["Practice fractions"]);
    await owner.refresh();
    expect(accepted).toEqual(["Practice fractions"]);
  });

  it("settles a retry waiting on history when that read proves the original receipt", async () => {
    const { owner, client, accepted } = fixture();
    await owner.connect(hello);
    client.override = (method) =>
      method === "chat.send" ? Promise.reject(new Error("Socket failed")) : undefined;
    await owner.send("Original question");
    const runId = client.calls.find((call) => call.method === "chat.send")!.params.idempotencyKey;
    const history = Promise.withResolvers<unknown>();
    client.override = (method) => (method === "chat.history" ? history.promise : undefined);
    const refreshing = owner.refresh();
    const retry = owner.retrySend();
    history.resolve({ ...client.history, inputReceipts: [{ runId, state: "consumed" }] });
    await refreshing;
    await expect(retry).resolves.toBe(true);
    expect(accepted).toEqual(["Original question"]);
    expect(client.calls.filter((call) => call.method === "chat.send")).toHaveLength(1);
    expect(owner.state).toMatchObject({ busy: false, canRetrySend: false });
  });

  it("explicitly retries a missing receipt once per click with the original fenced payload", async () => {
    const { owner, client } = fixture();
    await owner.connect(hello);
    client.override = (method) =>
      method === "chat.send" ? Promise.reject(new Error("Lost admission response")) : undefined;
    await expect(owner.send("Practice fractions")).resolves.toBe(false);
    const original = client.calls.find((call) => call.method === "chat.send")!.params;
    expect(owner.state.canRetrySend).toBe(true);

    owner.disconnect();
    client.connectionGeneration += 1;
    // The history moved, but a replay must retain the original admission fence.
    client.history.sessionInfo = { sessionId: "session-one", activeLeafEntryId: "later-leaf" };
    await owner.connect(hello);
    await owner.refresh();
    expect(client.calls.filter((call) => call.method === "chat.send")).toHaveLength(1);
    const held = Promise.withResolvers<unknown>();
    client.override = (method) => (method === "chat.send" ? held.promise : undefined);
    const retry = owner.retrySend();
    await expect(owner.retrySend()).resolves.toBe(false);
    expect(owner.state.canRetrySend).toBe(false);
    expect(client.calls.findLast((call) => call.method === "chat.send")!.params).toEqual(original);
    held.reject(new Error("Another transport failure"));
    await expect(retry).resolves.toBe(false);
    expect(owner.state.canRetrySend).toBe(true);
    await owner.refresh();
    expect(client.calls.filter((call) => call.method === "chat.send")).toHaveLength(2);

    // Gateway chat-send-pending-inputs.test.ts proves this same-ID contract
    // returns the durable cached receipt without dispatching a second run.
    client.override = (method) =>
      method === "chat.send"
        ? Promise.resolve({ runId: original.idempotencyKey, status: "ok" })
        : undefined;
    await expect(owner.retrySend()).resolves.toBe(true);
    expect(
      client.calls.filter((call) => call.method === "chat.send").map((call) => call.params),
    ).toEqual([original, original, original]);
    expect(owner.state).toMatchObject({ busy: false, canRetrySend: false, error: null });
    await expect(owner.retrySend()).resolves.toBe(false);
  });

  it("keeps receipt-proven acceptance when its concurrent retry loses the wire response", async () => {
    const { owner, client, accepted } = fixture();
    await owner.connect(hello);
    client.override = (method) =>
      method === "chat.send" ? Promise.reject(new Error("Socket failed")) : undefined;
    await owner.send("Original question");
    const runId = client.calls.find((call) => call.method === "chat.send")!.params.idempotencyKey;
    const wire = Promise.withResolvers<unknown>();
    client.override = (method) => (method === "chat.send" ? wire.promise : undefined);
    const retry = owner.retrySend();
    client.history.inputReceipts = [{ runId, state: "consumed" }];
    await owner.refresh();
    wire.reject(new Error("Lost response"));
    await expect(retry).resolves.toBe(true);
    expect(accepted).toEqual(["Original question"]);
    expect(owner.state).toMatchObject({ busy: false, canRetrySend: false, error: null });
    expect(client.calls.filter((call) => call.method === "chat.send")).toHaveLength(2);
  });

  it.each(["profile", "agent", "session"])(
    "never replays an unresolved message after the verified %s changes",
    async (changed) => {
      const { owner, client } = fixture();
      await owner.connect(hello);
      client.override = (method) =>
        method === "chat.send" ? Promise.reject(new Error("Socket failed")) : undefined;
      await owner.send("Private original message");
      owner.disconnect();
      client.connectionGeneration += 1;
      if (changed === "profile") {
        client.profileId = "child-two";
      }
      if (changed === "agent") {
        client.agents = [{ id: "other-student", name: "Rocky" }];
      }
      if (changed === "session") {
        client.history.sessionId = "replacement-session";
        client.history.sessionInfo = { sessionId: "replacement-session", activeLeafEntryId: null };
      }
      await owner.connect(hello);
      expect(owner.state).toMatchObject({ busy: false, canRetrySend: false });
      await expect(owner.retrySend()).resolves.toBe(false);
      expect(
        owner.state.messages.some((message) => message.text === "Private original message"),
      ).toBe(false);
      expect(client.calls.filter((call) => call.method === "chat.send")).toHaveLength(1);
    },
  );

  it("retains explicit recovery when a retired connection acknowledges its old send", async () => {
    const { owner, client } = fixture();
    await owner.connect(hello);
    const admission = Promise.withResolvers<unknown>();
    client.override = (method) => (method === "chat.send" ? admission.promise : undefined);
    const sending = owner.send("Original question");
    const original = client.calls.find((call) => call.method === "chat.send")!.params;
    owner.disconnect();
    client.connectionGeneration += 1;
    client.override = undefined;
    await owner.connect(hello);
    admission.resolve({ runId: original.idempotencyKey, status: "started" });
    await expect(sending).resolves.toBe(false);
    expect(owner.state.canRetrySend).toBe(true);
    await expect(owner.retrySend()).resolves.toBe(true);
    expect(client.calls.findLast((call) => call.method === "chat.send")!.params).toEqual(original);
  });

  it("keeps the original branch fence on retry and accepts an authoritative rejection", async () => {
    const { owner, client } = fixture();
    await owner.connect(hello);
    client.override = (method) =>
      method === "chat.send" ? Promise.reject(new Error("Lost before admission")) : undefined;
    await owner.send("Original question");
    const original = client.calls.find((call) => call.method === "chat.send")!.params;
    client.history.sessionInfo = { sessionId: "session-one", activeLeafEntryId: "later-leaf" };
    await owner.refresh();
    const rejection = new GatewayProtocolRequestError({
      code: "INVALID_REQUEST",
      message: "stale branch",
    });
    retainGatewayResponsePayload(rejection, {});
    client.override = (method) => (method === "chat.send" ? Promise.reject(rejection) : undefined);
    await expect(owner.retrySend()).resolves.toBe(false);
    expect(client.calls.findLast((call) => call.method === "chat.send")!.params).toEqual(original);
    expect(owner.state).toMatchObject({ busy: false, canRetrySend: false });
    expect(owner.state.messages.some((message) => message.text === "Original question")).toBe(
      false,
    );
    client.override = undefined;
    await expect(owner.send("A fresh question")).resolves.toBe(true);
    const fresh = client.calls.findLast((call) => call.method === "chat.send")!.params;
    expect(fresh.expectedLeafEntryId).toBe("later-leaf");
    expect(fresh.idempotencyKey).not.toBe(original.idempotencyKey);
  });

  it("retires a retry awaiting history when the identity changes", async () => {
    const { owner, client } = fixture();
    await owner.connect(hello);
    client.override = (method) =>
      method === "chat.send" ? Promise.reject(new Error("Socket failed")) : undefined;
    await owner.send("Private original message");
    const history = Promise.withResolvers<unknown>();
    client.override = (method) => (method === "chat.history" ? history.promise : undefined);
    const refreshing = owner.refresh();
    const retry = owner.retrySend();
    owner.disconnect();
    client.connectionGeneration += 1;
    client.profileId = "child-two";
    client.override = undefined;
    await owner.connect(hello);
    history.resolve(client.history);
    await refreshing;
    await expect(retry).resolves.toBe(false);
    expect(client.calls.filter((call) => call.method === "chat.send")).toHaveLength(1);
    expect(owner.state.sessionKey).toBe("agent:student:kids:child-two");
  });

  it("removes a definitively rejected optimistic input and makes a fresh branch available", async () => {
    const { owner, client } = fixture();
    await owner.connect(hello);
    const rejection = new GatewayProtocolRequestError({
      code: "INVALID_REQUEST",
      message: "stale branch",
    });
    retainGatewayResponsePayload(rejection, {});
    client.override = (method) => (method === "chat.send" ? Promise.reject(rejection) : undefined);
    client.history.sessionInfo = { sessionId: "session-one", activeLeafEntryId: "new-leaf" };
    await expect(owner.send("Will fail")).resolves.toBe(false);
    expect(owner.state.messages.some((message) => message.text === "Will fail")).toBe(false);
    client.override = undefined;
    await expect(owner.send("Try the new branch")).resolves.toBe(true);
    expect(
      client.calls.findLast((call) => call.method === "chat.send")?.params.expectedLeafEntryId,
    ).toBe("new-leaf");
  });

  it("joins unsubscribe on dispose and removes all callbacks", async () => {
    const { owner, client, states } = fixture();
    await owner.connect(hello);
    const released = Promise.withResolvers<unknown>();
    client.override = (method) =>
      method === "sessions.messages.unsubscribe" ? released.promise : undefined;
    const disposing = owner.dispose();
    expect(owner.dispose()).toBe(disposing);
    expect(client.listeners.size).toBe(0);
    const stateCount = states.length;
    client.emit("chat", { sessionKey, runId: "late", state: "delta" });
    expect(states).toHaveLength(stateCount);
    expect(client.calls.at(-1)?.method).toBe("sessions.messages.unsubscribe");
    released.resolve({ key: sessionKey });
    await disposing;
    expect(owner.state.status).toBe("disconnected");
  });
});
