/**
 * Storage replay coverage for retired Talk connection-account author tags. Each
 * test owns isolated synthetic state; the shared fixture joins SQLite work and
 * closes database resources before removing its temporary root.
 */
import { describe, expect, it } from "vitest";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { appendTranscriptMessage, loadTranscriptEvents } from "./session-accessor.js";

describe("Talk author replay compatibility", () => {
  it("replays retired Talk author tags without rewriting accepted rows", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async ({ env }) => {
      const scope = {
        agentId: "main",
        env,
        sessionId: "session-talk-author-cutover",
        sessionKey: "agent:main:talk-author-replay",
      };
      const retiredMetadata = [
        {},
        { senderId: "robot-account" },
        { senderId: "robot-account", senderIdentity: { type: "profile", id: "robot-account" } },
      ];
      for (const [index, metadata] of retiredMetadata.entries()) {
        for (const keyed of [false, true]) {
          const eventId = `voice:cutover:${index}-${keyed}`;
          const message = {
            role: "user",
            content: [{ type: "text", text: "A spoken answer" }],
            provenance: { kind: "realtime_voice", sourceChannel: "talk" },
            ...(keyed ? { idempotencyKey: eventId } : {}),
          };
          const stored = { ...message, timestamp: 10, __openclaw: metadata };
          await appendTranscriptMessage(scope, { eventId, message: stored });
          const original = await loadTranscriptEvents(scope);
          const replayed = await appendTranscriptMessage(scope, {
            eventId,
            message: { ...message, timestamp: 20 },
          });
          expect(replayed).toMatchObject({ appended: false, messageId: eventId, message: stored });
          expect(await loadTranscriptEvents(scope)).toEqual(original);
        }
      }
    });
  });

  it("keeps Talk author cutover replay strict outside the retired fields", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async ({ env }) => {
      const scope = {
        agentId: "main",
        env,
        sessionId: "session-talk-author-conflicts",
        sessionKey: "agent:main:talk-author-replay",
      };
      const message = {
        role: "user",
        content: [{ type: "text", text: "A spoken answer" }],
        provenance: { kind: "realtime_voice", sourceChannel: "talk" },
      };
      const tagged = { ...message, __openclaw: { senderId: "robot-account" } };
      const conflicts = [
        { name: "text", stored: tagged, candidate: { ...message, content: "Changed text" } },
        { name: "role", stored: tagged, candidate: { ...message, role: "assistant" } },
        {
          name: "provenance",
          stored: tagged,
          candidate: { ...message, provenance: { kind: "realtime_voice", sourceChannel: "other" } },
        },
        {
          name: "changed-author",
          stored: tagged,
          candidate: { ...message, __openclaw: { senderId: "another-account" } },
        },
        {
          name: "unrecognized-metadata",
          stored: { ...message, __openclaw: { senderId: "robot-account", futureField: true } },
          candidate: message,
        },
        {
          name: "display-name",
          stored: { ...message, __openclaw: { senderId: "robot-account", senderName: "Caller" } },
          candidate: message,
        },
        {
          name: "other-channel",
          stored: { ...tagged, provenance: { kind: "external_user", sourceChannel: "webchat" } },
          candidate: {
            ...message,
            provenance: { kind: "external_user", sourceChannel: "webchat" },
          },
        },
        {
          name: "assistant",
          stored: { ...tagged, role: "assistant" },
          candidate: { ...message, role: "assistant" },
        },
        { name: "reverse", stored: message, candidate: tagged },
      ];
      for (const { name, stored, candidate } of conflicts) {
        const eventId = `voice:cutover:${name}`;
        await appendTranscriptMessage(scope, { eventId, message: stored });
        const original = await loadTranscriptEvents(scope);
        await expect(
          appendTranscriptMessage(scope, { eventId, message: candidate }),
        ).rejects.toThrow(/conflicts with the admitted message/u);
        expect(await loadTranscriptEvents(scope)).toEqual(original);
      }
    });
  });
});
