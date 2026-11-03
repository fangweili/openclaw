/** Talk keeps finalized speech in its session history without inferring who spoke. */
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

/** Exercises persistence after session authorization, with the original request client. */
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

describe("Talk transcript speaker attribution", () => {
  it.each([
    { name: "ordinary", key: "voice", caller: "caller", owner: undefined, chatType: "direct" },
    {
      name: "personal",
      key: "personal:child",
      caller: "child",
      owner: "child",
      chatType: "direct",
    },
    { name: "shared", key: "family", caller: "robot-account", owner: "child", chatType: "group" },
    { name: "profileless", key: "voice", caller: undefined, owner: "child", chatType: "direct" },
  ] as const)(
    "keeps $name voice history tagless without losing provenance or idempotency",
    async ({ name, key, caller, owner, chatType }) =>
      await withOpenClawTestState({ scenario: "minimal" }, async () => {
        const sessionKey = `agent:main:${key}`;
        const sessionId = `voice-history-${name}`;
        const invokeTranscript = createTranscriptInvoker();
        const client = sharingPolicyClient({ user: caller, displayName: "Connection account" });
        await replaceSessionEntry(
          { agentId: "main", sessionKey },
          {
            sessionId,
            updatedAt: 1,
            chatType,
            ...(owner ? { createdActor: { type: "human", source: "profile", id: owner } } : {}),
          },
        );
        const voiceSessionId = createOrResumeClientVoiceSession({
          agentId: "main",
          sessionKey,
          origin: "client",
        });
        try {
          const params = {
            sessionKey,
            voiceSessionId,
            entryId: "utterance",
            role: "user",
            text: "A spoken answer",
          };
          expect(await invokeTranscript(params, client)).toHaveBeenCalledWith(
            true,
            { ok: true },
            undefined,
          );
          // Replaying the same finalized provider event retains a single history row.
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
          expect(events).toMatchObject([
            {
              event: {
                message: { role: "user", content: [{ type: "text", text: "A spoken answer" }] },
              },
            },
            {
              event: {
                message: {
                  role: "assistant",
                  content: [{ type: "text", text: "A reply" }],
                  api: "realtime",
                  model: "realtime-voice",
                },
              },
            },
          ]);
          expect(events).toHaveLength(2);
          for (const { event } of events) {
            expect(event).toMatchObject({
              message: { provenance: { kind: "realtime_voice", sourceChannel: "talk" } },
            });
            expect(event).not.toHaveProperty("message.__openclaw");
          }
          expect(
            await invokeTranscript(
              { ...params, entryId: "forged", sender: { id: "child" } },
              client,
            ),
          ).toHaveBeenCalledWith(
            false,
            undefined,
            expect.objectContaining({ code: "INVALID_REQUEST" }),
          );
        } finally {
          await closeClientVoiceSession({
            agentId: "main",
            sessionKey,
            voiceSessionId,
            config: {},
          });
        }
      }),
  );
});
