/**
 * Deterministic conversation RPC fixture. Each harness owns its test conversations;
 * callers explicitly register dispose with afterEach to join requests and remove
 * listeners. Deferred overrides may ignore abort to exercise stale completions.
 */
import type { GatewayProtocolRequestOptions } from "@openclaw/gateway-client/browser";
import type { GatewayEventFrame, GatewayHelloOk } from "../api/gateway.ts";
import { KidsConversation, type KidsConversationState } from "./conversation.ts";

export const hello: GatewayHelloOk = { type: "hello-ok", protocol: 4 };
export const sessionKey = "agent:student:kids:child-one";
export const textMessage = (role: string, text: string, id: string, extra: object = {}) => ({
  role,
  content: [{ type: "text", text }],
  __openclaw: { id },
  ...extra,
});

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

/** Creates isolated fixtures and their explicit, asynchronous cleanup owner. */
export function createConversationTestHarness() {
  const owners: KidsConversation[] = [];
  function fixture(onState?: (state: KidsConversationState) => void) {
    const client = new TestGateway();
    const states: KidsConversationState[] = [];
    const accepted: string[] = [];
    const acceptedIds: string[][] = [];
    const owner = new KidsConversation(
      client,
      (state) => {
        states.push(state);
        onState?.(state);
      },
      (text, ids) => {
        accepted.push(text);
        acceptedIds.push([...ids]);
      },
    );
    owners.push(owner);
    return { owner, client, states, accepted, acceptedIds };
  }
  const dispose = async () => {
    await Promise.all(owners.splice(0).map((owner) => owner.dispose()));
  };
  return { fixture, dispose };
}
