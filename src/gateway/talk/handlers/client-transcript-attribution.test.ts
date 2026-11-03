import { describe, expect, it, vi } from "vitest";
import {
  readSessionTranscriptMessageEvents,
  replaceSessionEntry,
} from "../../../config/sessions/session-accessor.js";
import {
  closeClientVoiceSession,
  createOrResumeClientVoiceSession,
} from "../../../talk/client-voice-session.js";
import { withOpenClawTestState } from "../../../test-utils/openclaw-test-state.js";
import type { GatewayRequestHandlerOptions } from "../../server-methods/types.js";
import { createGatewayRequestContext } from "../../server-request-context.js";
import { makeContextParams } from "../../server-request-context.test-support.js";
import { sharingPolicyClient } from "../../session-sharing.test-utils.js";
import { talkClientHandlers } from "./client.js";

const sessionKey = "agent:main:voice-attribution";
const sessionId = "voice-attribution";

/** Each scenario shares a complete request context while supplying its caller per request. */
function createTranscriptInvoker() {
  const context = createGatewayRequestContext(makeContextParams());
  context.getRuntimeConfig = () => ({});
  return async function invokeTranscript(
    params: Record<string, unknown>,
    client: GatewayRequestHandlerOptions["client"],
  ) {
    const respond = vi.fn();
    await talkClientHandlers["talk.client.transcript"]?.({
      req: { type: "req", id: "transcript", method: "talk.client.transcript", params },
      isWebchatConnect: () => false,
      params,
      respond,
      client,
      context,
    });
    return respond;
  };
}

describe("authenticated voice transcript attribution", () => {
  it.each(["child", "parent", "synthetic", "profileless"] as const)(
    "attributes %s voice to the authenticated caller and never to the session owner",
    async (caller) =>
      await withOpenClawTestState({ scenario: "minimal" }, async () => {
        const invokeTranscript = createTranscriptInvoker();
        const client = sharingPolicyClient(
          caller === "profileless" ? {} : { user: caller, displayName: "Caller" },
        );
        if (caller === "synthetic") {
          client.internal = { syntheticClient: true };
        }
        await replaceSessionEntry(
          { agentId: "main", sessionKey },
          {
            sessionId,
            updatedAt: 1,
            createdActor: { type: "human", source: "profile", id: "child" },
          },
        );
        const voiceSessionId = createOrResumeClientVoiceSession({
          agentId: "main",
          sessionKey,
          origin: "client",
        });
        const params = {
          sessionKey,
          voiceSessionId,
          entryId: "speaker",
          role: "user",
          text: "A spoken answer",
        };
        expect(await invokeTranscript(params, client)).toHaveBeenCalledWith(
          true,
          { ok: true },
          undefined,
        );
        // A lost-response replay from the same person survives mutable profile labels.
        if (client.authenticatedUserProfile) {
          client.authenticatedUserProfile.displayName = "Renamed caller";
        }
        expect(await invokeTranscript(params, client)).toHaveBeenCalledWith(
          true,
          { ok: true },
          undefined,
        );
        // A replay with different attribution conflicts rather than relabeling the author.
        expect(
          await invokeTranscript(params, sharingPolicyClient({ user: "retrying-reader" })),
        ).toHaveBeenCalledWith(
          false,
          undefined,
          expect.objectContaining({ code: "INVALID_REQUEST" }),
        );
        expect(await invokeTranscript(params, client)).toHaveBeenCalledWith(
          true,
          { ok: true },
          undefined,
        );
        expect(
          await invokeTranscript(
            { ...params, entryId: "reply", role: "assistant", text: "A reply" },
            client,
          ),
        ).toHaveBeenCalledWith(true, { ok: true }, undefined);
        const events = readSessionTranscriptMessageEvents({ agentId: "main", sessionId });
        expect(events).toHaveLength(2);
        const event = events[0]?.event;
        expect(event).toMatchObject({
          message: { provenance: { kind: "realtime_voice", sourceChannel: "talk" } },
        });
        if (caller === "profileless") {
          expect(event).not.toHaveProperty("message.__openclaw");
        } else {
          expect(event).toHaveProperty("message.__openclaw.senderId", caller);
          if (caller === "synthetic") {
            expect(event).not.toHaveProperty("message.__openclaw.senderIdentity");
          } else {
            expect(event).toHaveProperty("message.__openclaw.senderIdentity", {
              type: "profile",
              id: caller,
            });
          }
        }
        expect(event).not.toHaveProperty("message.__openclaw.senderName");
        expect(event).not.toHaveProperty("message.__openclaw.senderUsername");
        expect(events[1]?.event).not.toHaveProperty("message.__openclaw");
        expect(
          await invokeTranscript({ ...params, entryId: "forged", sender: { id: "child" } }, client),
        ).toHaveBeenCalledWith(
          false,
          undefined,
          expect.objectContaining({ code: "INVALID_REQUEST" }),
        );
        await closeClientVoiceSession({ agentId: "main", sessionKey, voiceSessionId, config: {} });
      }),
  );
});
