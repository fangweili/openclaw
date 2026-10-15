import { expect, it } from "vitest";
import { authorizeOperatorScopesForMethod } from "../method-scopes.js";
import { normalizeChatSendRequest } from "./chat-send-request.js";
import type { GatewayClient } from "./client-types.js";

it("admits a branch-bound Webchat send with only child scopes", () => {
  const scopes = ["operator.sessions.write", "operator.talk"];
  const child: GatewayClient = {
    connect: {
      minProtocol: 4,
      maxProtocol: 4,
      role: "operator",
      scopes,
      client: { id: "webchat-ui", version: "test", platform: "web", mode: "webchat" },
    },
    authenticatedUserProfile: {
      profileId: "child-one",
      displayName: "Child",
      hasAvatar: false,
      updatedAt: 1,
    },
  };
  // This host contract accepts the public wire shape independently of an app's
  // implementation. App send/reconciliation behavior belongs to its own tests.
  const params = {
    sessionKey: "agent:student:kids:child-one",
    agentId: "student",
    sessionId: "child-session",
    expectedLeafEntryId: "child-leaf",
    message: "Can we practice fractions?",
    idempotencyKey: "child-send",
    deliver: false,
  };
  expect(authorizeOperatorScopesForMethod("chat.send", scopes, params)).toEqual({
    allowed: true,
    sessionScope: "operator.sessions.write",
  });
  expect(normalizeChatSendRequest({ params, client: child })).toMatchObject({
    ok: true,
    value: {
      p: params,
      rawMessage: params.message,
      suppressCommandInterpretation: false,
    },
  });
});
