import type { GatewayProtocolRequestOptions } from "@openclaw/gateway-client/browser";
import { expect, it } from "vitest";
import { KidsConversation } from "../../../ui/src/kids/conversation.js";
import { authorizeOperatorScopesForMethod } from "../method-scopes.js";
import { normalizeChatSendRequest } from "./chat-send-request.js";
import type { GatewayClient } from "./client-types.js";

it("admits the kids conversation's actual send payload with only child scopes", async () => {
  const scopes = ["operator.sessions.write", "operator.talk"];
  const child: GatewayClient = {
    connect: {
      minProtocol: 4,
      maxProtocol: 4,
      role: "operator",
      scopes,
      client: {
        id: "openclaw-control-ui",
        version: "test",
        platform: "web",
        mode: "webchat",
      },
    },
    authenticatedUserProfile: {
      profileId: "child-one",
      displayName: "Child",
      hasAvatar: false,
      updatedAt: 1,
    },
  };
  const admissions: ReturnType<typeof normalizeChatSendRequest>[] = [];
  const accepted: string[] = [];
  // Bootstrap is synthetic; send crosses the real production authorization and
  // normalization boundary with the unmodified payload constructed by the UI.
  const client = {
    connected: true,
    connectionGeneration: 1,
    addEventListener: () => () => {},
    async request<T>(
      method: string,
      input?: unknown,
      options?: GatewayProtocolRequestOptions,
    ): Promise<T> {
      const params = input as Record<string, unknown>;
      options?.onSent?.("request");
      if (method === "chat.send") {
        expect(authorizeOperatorScopesForMethod(method, scopes, params)).toEqual({
          allowed: true,
          sessionScope: "operator.sessions.write",
        });
        const admission = normalizeChatSendRequest({ params, client: child });
        admissions.push(admission);
        if (!admission.ok) {
          throw new Error(admission.error);
        }
        return { runId: admission.value.p.idempotencyKey, status: "started" } as T;
      }
      const replies: Record<string, unknown> = {
        "users.self": { profile: { id: "child-one", displayName: "Child" } },
        "agents.list": { agents: [{ id: "student", name: "Rocky" }] },
        "sessions.create": { key: params.key },
        "sessions.messages.subscribe": { key: params.key },
        "sessions.messages.unsubscribe": { key: params.key },
        "chat.history": {
          sessionId: "child-session",
          sessionInfo: { sessionId: "child-session", activeLeafEntryId: "child-leaf" },
          messages: [],
        },
      };
      if (!(method in replies)) {
        throw new Error(`Unexpected request: ${method}`);
      }
      return replies[method] as T;
    },
  };
  const owner = new KidsConversation(
    client,
    () => {},
    (text) => accepted.push(text),
  );
  try {
    await owner.connect({ type: "hello-ok", protocol: 4, auth: { role: "operator", scopes } });
    const sent = await owner.send("Can we practice fractions?");
    expect(admissions[0]?.ok, JSON.stringify(admissions[0])).toBe(true);
    expect(admissions).toMatchObject([
      {
        ok: true,
        value: {
          p: {
            sessionKey: "agent:student:kids:child-one",
            sessionId: "child-session",
            expectedLeafEntryId: "child-leaf",
          },
          rawMessage: "Can we practice fractions?",
          suppressCommandInterpretation: false,
        },
      },
    ]);
    expect(sent).toBe(true);
    expect(accepted).toEqual(["Can we practice fractions?"]);
  } finally {
    await owner.dispose();
  }
});
