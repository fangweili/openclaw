import { once } from "node:events";
import fs from "node:fs/promises";
import { createServer } from "node:http";
import { expectDefined } from "@openclaw/normalization-core";
import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { expect, it, vi } from "vitest";
import type { ArtifactsDownloadResult } from "../../../packages/gateway-protocol/src/index.js";
import { createSolidPngBuffer } from "../../../test/helpers/image-fixtures.js";
import {
  appendTranscriptMessage,
  upsertSessionEntryCore,
} from "../../config/sessions/session-accessor.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { saveMediaBuffer } from "../../media/store.js";
import { ensureProfileForEmail } from "../../state/user-profiles.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { handleArtifactDownloadHttpRequest } from "../artifact-downloads.js";
import { projectChatDisplayMessage } from "../chat-display-projection.js";
import {
  createCoreGatewayMethodDescriptors,
  createGatewayMethodRegistry,
} from "../methods/registry.js";
import { createDirectChatContext } from "../server-chat.agent-events.test-helpers.js";
import { handleGatewayRequest } from "../server-methods.js";
import { sharingPolicyClient } from "../session-sharing.test-utils.js";
import * as readers from "../session-transcript-readers.js";
import { projectTranscriptMediaArtifacts } from "../transcript-media-artifacts.js";
import * as transcriptMedia from "./artifacts-transcript-media.js";
import { artifactsHandlers } from "./artifacts.js";

const registry = createGatewayMethodRegistry(createCoreGatewayMethodDescriptors(artifactsHandlers));

function ids(message: unknown): string[] {
  const media = asOptionalRecord(asOptionalRecord(message)?.["__openclaw"])?.media;
  return Array.isArray(media)
    ? media.flatMap((fact) => {
        const id = asOptionalRecord(fact)?.artifactId;
        return typeof id === "string" ? [id] : [];
      })
    : [];
}

it("projects only positioned inbound media, replacing untrusted IDs and excluding remote/workspace files", () => {
  const message = {
    role: "user",
    content: "Pictures",
    __openclaw: {
      id: "message",
      seq: 1,
      transcriptPosition: { source: "physical-generation", rawSeq: 0 },
      media: [
        { url: "media://inbound/photo.png", contentType: "image/png", artifactId: "forged" },
        { url: "media://inbound/movie.mp4", contentType: "video/mp4" },
        {
          url: "https://outside.example/photo.png",
          contentType: "image/png",
          artifactId: "forged",
        },
        { path: "/private/other.png", contentType: "image/png", artifactId: "forged" },
        { url: "media://inbound/nested/secret.png", contentType: "image/png" },
      ],
    },
  };
  expect(ids(projectTranscriptMediaArtifacts(message))).toHaveLength(2);
  expect(
    ids(projectTranscriptMediaArtifacts(message)).every((id) =>
      id.startsWith("artifact_transcript_media_"),
    ),
  ).toBe(true);
  expect(
    ids(
      projectTranscriptMediaArtifacts({
        ...message,
        __openclaw: { media: message["__openclaw"].media },
      }),
    ),
  ).toEqual([]);
});

it("serves owned persisted uploads with scoped grants and ranges, rejecting cross-session, forged and retired reads", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async () => {
    const profile = ensureProfileForEmail("student-media@example.test");
    const sibling = ensureProfileForEmail("sibling-media@example.test");
    const controller = new AbortController();
    const client = {
      ...sharingPolicyClient({ user: profile.id, scopes: ["operator.sessions.write"] }),
      connId: "student-media-reader",
      connectionSignal: controller.signal,
    };
    const clients = new Set([client]);
    const cfg = {
      gateway: {
        roles: {
          default: "student",
          definitions: {
            student: {
              sessions: { others: "none" as "none" | "view" },
              agents: ["main"],
              scopes: ["operator.sessions.write"],
            },
          },
        },
      },
    } satisfies OpenClawConfig;
    const context = createDirectChatContext({ getRuntimeConfig: () => cfg });
    const scope = {
      agentId: "main",
      sessionKey: "agent:main:student-media",
      sessionId: "student-media",
    };
    const entry = {
      sessionId: scope.sessionId,
      updatedAt: 1,
      visibility: "draft" as const,
      createdActor: { type: "human" as const, source: "profile" as const, id: profile.id },
    };
    await upsertSessionEntryCore(scope, entry);
    const png = createSolidPngBuffer(12, 8, { r: 10, g: 90, b: 140 });
    // Minimal ISO BMFF signature is enough to prove byte transport without a codec/provider.
    const video = Buffer.from(
      "00000018667479706d703432000000006d70343269736f6d0000000866726565",
      "hex",
    );
    const photo = await saveMediaBuffer(png, "image/png");
    const clip = await saveMediaBuffer(video, "video/mp4");
    const message = {
      role: "user",
      content: "Look at my experiment",
      __openclaw: {
        media: [
          { path: photo.path, contentType: "image/png", fileName: "experiment.png" },
          {
            url: `media://inbound/${clip.id}`,
            contentType: "video/mp4",
            fileName: "experiment.mp4",
          },
        ],
      },
    };
    const appended = await appendTranscriptMessage(scope, { eventId: "same-message-id", message });
    const stored = await readers.readSessionMessageByIdAsync(scope, appended.messageId);
    const [photoId, videoId] = ids(projectChatDisplayMessage(stored.message));
    expect(photoId).toBeDefined();
    expect(videoId).toBeDefined();
    const download = async (artifactId: string, sessionKey = scope.sessionKey) => {
      let result: { ok: boolean; payload?: ArtifactsDownloadResult; error?: unknown } | undefined;
      await handleGatewayRequest({
        context,
        client,
        methodRegistry: registry,
        req: {
          type: "req",
          id: "media",
          method: "artifacts.download",
          params: { sessionKey, agentId: "main", artifactId, transport: "http" },
        },
        isWebchatConnect: () => false,
        respond(ok, payload, error) {
          result = { ok, payload: payload as ArtifactsDownloadResult, error };
        },
      });
      return expectDefined(result, "artifact response");
    };
    const server = createServer((req, res) => {
      void handleArtifactDownloadHttpRequest(req, res, { clients, basePath: "" }).catch(() => {
        res.statusCode = 500;
        res.end();
      });
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("HTTP fixture did not bind");
    }
    const origin = `http://127.0.0.1:${address.port}`;
    const grant = async (id: string) => {
      const result = await download(id);
      expect(result.ok).toBe(true);
      return expectDefined(result.payload?.url, "download grant");
    };
    try {
      const imageUrl = await grant(photoId!);
      const image = await fetch(origin + imageUrl);
      expect(image.status).toBe(200);
      expect(Buffer.from(await image.arrayBuffer())).toEqual(png);
      const videoUrl = await grant(videoId!);
      const range = await fetch(origin + videoUrl, { headers: { Range: "bytes=4-11" } });
      expect(range.status).toBe(206);
      expect(range.headers.get("content-range")).toBe(`bytes 4-11/${video.length}`);
      expect(Buffer.from(await range.arrayBuffer())).toEqual(video.subarray(4, 12));
      const head = await fetch(origin + videoUrl, { method: "HEAD" });
      expect(head.status).toBe(200);
      expect(head.headers.get("content-length")).toBe(String(video.length));
      const other = {
        ...scope,
        sessionKey: "agent:main:sibling-media",
        sessionId: "sibling-media",
      };
      await upsertSessionEntryCore(other, {
        ...entry,
        sessionId: other.sessionId,
        createdActor: { ...entry.createdActor, id: sibling.id },
      });
      await appendTranscriptMessage(other, { eventId: "same-message-id", message });
      expect((await download(photoId!, other.sessionKey)).ok).toBe(false);
      const forged = photoId!.replace(/.$/, photoId!.endsWith("A") ? "B" : "A");
      expect((await download(forged)).ok).toBe(false);
      // A grant opens the admitted immutable store object, never a replaced path.
      await fs.rename(clip.path, `${clip.path}.old`);
      await fs.writeFile(clip.path, video);
      expect((await fetch(origin + videoUrl)).status).toBe(404);
      // The same read owner rechecks sharing when a permitted viewer loses access.
      cfg.gateway.roles.definitions.student.sessions.others = "view";
      await upsertSessionEntryCore(other, {
        ...entry,
        sessionId: other.sessionId,
        visibility: "shared",
        createdActor: { ...entry.createdActor, id: sibling.id },
      });
      const otherStored = await readers.readSessionMessageByIdAsync(other, "same-message-id");
      const otherId = ids(projectChatDisplayMessage(otherStored.message))[0]!;
      const otherGrant = await download(otherId, other.sessionKey);
      expect(otherGrant.ok).toBe(true);
      const read = readers.readSessionMessagesPageWithStatsAsync;
      const spy = vi
        .spyOn(readers, "readSessionMessagesPageWithStatsAsync")
        .mockImplementationOnce(async (...args) => {
          const page = await read(...args);
          await upsertSessionEntryCore(other, {
            sessionId: other.sessionId,
            updatedAt: 2,
            visibility: "draft",
          });
          return page;
        });
      expect((await download(otherId, other.sessionKey)).ok).toBe(false);
      spy.mockRestore();
      expect((await fetch(origin + otherGrant.payload!.url)).status).toBe(404);

      // A completed grant must still be authorized when its RPC continuation
      // publishes metadata. Revoke sharing after the real helper allocates it.
      await upsertSessionEntryCore(other, {
        sessionId: other.sessionId,
        updatedAt: 3,
        visibility: "shared",
      });
      const prepareDownload = transcriptMedia.downloadTranscriptMediaArtifact;
      let prepared: Awaited<ReturnType<typeof prepareDownload>>;
      const completion = vi
        .spyOn(transcriptMedia, "downloadTranscriptMediaArtifact")
        .mockImplementationOnce(async (...args) => {
          prepared = await prepareDownload(...args);
          await upsertSessionEntryCore(other, {
            sessionId: other.sessionId,
            updatedAt: 4,
            visibility: "draft",
          });
          return prepared;
        });
      try {
        const revoked = await download(otherId, other.sessionKey);
        expect(prepared).toBeDefined();
        expect(revoked).toMatchObject({ ok: false, payload: undefined });
      } finally {
        completion.mockRestore();
      }
      cfg.gateway.roles.definitions.student.sessions.others = "none";
      const replacement = { ...scope, sessionId: "replacement-media" };
      await upsertSessionEntryCore(replacement, { ...entry, sessionId: replacement.sessionId });
      await appendTranscriptMessage(replacement, { eventId: "same-message-id", message });
      expect((await download(photoId!)).ok).toBe(false);
      expect((await fetch(origin + imageUrl)).status).toBe(404);
      const newer = await readers.readSessionMessageByIdAsync(replacement, "same-message-id");
      const currentId = ids(projectChatDisplayMessage(newer.message))[0]!;
      expect(currentId).not.toBe(photoId);
      const currentUrl = await grant(currentId);
      controller.abort();
      expect((await fetch(origin + currentUrl)).status).toBe(404);
    } finally {
      controller.abort();
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    }
  });
});
