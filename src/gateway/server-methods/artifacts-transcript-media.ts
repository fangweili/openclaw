import { readFileWindowFully } from "@openclaw/fs-safe/advanced";
/**
 * Bridges a transcript-owned upload to the existing connection-owned artifact
 * grant. Session access owns identity, sharing and physical generation; the
 * media store owns containment. Grants retain facts, never file descriptors or
 * bytes. Each HTTP read rechecks membership, opens the same immutable file, and
 * transfers videos to the HTTP stream owner. Images stay bounded by upload policy
 * for the existing thumbnail owner. Failure closes the file before propagating.
 */
import { detectMime, kindFromMime } from "@openclaw/media-core/mime";
import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import type {
  ArtifactsGetParams,
  ArtifactSummary,
} from "../../../packages/gateway-protocol/src/index.js";
import { openMediaFile } from "../../media/store.js";
import {
  canCreateArtifactDownload,
  createArtifactDownload,
  type ArtifactDownloadReadResult,
} from "../artifact-download-grants.js";
import { resolveChatAttachmentPolicy } from "../chat-attachment-policy.js";
import { resolveByteResponse } from "../http-byte-range.js";
import { MAX_PAYLOAD_BYTES } from "../server-constants.js";
import { readSessionMessagesPageWithStatsAsync } from "../session-transcript-readers.js";
import {
  parseTranscriptMediaArtifactId,
  resolveTranscriptMediaArtifact,
} from "../transcript-media-artifacts.js";
import { resolveMessageRunId } from "./artifacts-content.js";
import { prepareArtifactSessionRead } from "./artifacts-session-read.js";
import type { ArtifactSessionAccess } from "./artifacts-session-resolution.js";

type Opened = Awaited<ReturnType<typeof openMediaFile>>;
function identity(opened: Opened): string {
  const { dev, ino, size, mtimeMs, ctimeMs } = opened.stat;
  return JSON.stringify([dev, ino, size, mtimeMs, ctimeMs]);
}

/**
 * Prepare a grant for an exact persisted upload in the authorized session.
 * The caller must assertCurrent after awaiting this result and immediately before
 * publishing response; sharing or the backing session may change while awaiting.
 */
export async function downloadTranscriptMediaArtifact(
  query: ArtifactsGetParams,
  access: ArtifactSessionAccess & {
    assertCurrent: () => void;
    detach: (release: () => void) => void;
  },
) {
  const reference = parseTranscriptMediaArtifactId(query.artifactId);
  if (!reference || !canCreateArtifactDownload(access.client)) {
    return undefined;
  }
  const selected = await prepareArtifactSessionRead(query, access);
  if (!selected?.scope) {
    return undefined;
  }
  const scope = selected.scope;
  const assertCurrent = () => {
    access.assertCurrent();
    selected.assertCurrent();
  };
  const recover = async () => {
    assertCurrent();
    const page = await readSessionMessagesPageWithStatsAsync(scope, {
      offset: 0,
      beforeSeq: reference.messageSeq + 1,
      maxMessages: 1,
      maxBytes: MAX_PAYLOAD_BYTES - 4096,
      allowOversizedFirst: true,
    });
    assertCurrent();
    const message = asOptionalRecord(page.messages[0]);
    if (
      !message ||
      (query.messageRole && message.role !== query.messageRole) ||
      (query.runId && resolveMessageRunId(message) !== query.runId)
    ) {
      return undefined;
    }
    return resolveTranscriptMediaArtifact(message, query.artifactId);
  };
  const media = await recover();
  if (!media) {
    return undefined;
  }
  const maxBytes = resolveChatAttachmentPolicy(access.getRuntimeConfig()).maxBytes;
  let artifact: ArtifactSummary;
  let digest: string;
  {
    await using opened = await openMediaFile(media.mediaId, "inbound", maxBytes).catch(() => null);
    if (!opened) {
      return undefined;
    }
    const bytes = Buffer.alloc(Math.min(opened.stat.size, 8192));
    await readFileWindowFully(opened.handle, bytes, 0);
    const mimeType = await detectMime({ buffer: bytes, filePath: media.mediaId });
    assertCurrent();
    if (kindFromMime(mimeType) !== media.kind || mimeType === "image/svg+xml") {
      return undefined;
    }
    digest = identity(opened);
    artifact = {
      id: query.artifactId,
      type: media.kind,
      title: media.fact.fileName ?? (media.kind === "image" ? "Photo" : "Video"),
      mimeType,
      sizeBytes: opened.stat.size,
      sessionKey: selected.sessionKey,
      messageSeq: reference.messageSeq,
      source: "session-transcript",
      download: { mode: "url" },
    };
  }
  const download = createArtifactDownload({
    client: access.client,
    prepared: { artifact, digest },
    assertCurrent,
    release: selected.release,
    read: async (request): Promise<ArtifactDownloadReadResult | undefined> => {
      const current = await recover();
      if (current?.mediaId !== media.mediaId) {
        return undefined;
      }
      const opened = await openMediaFile(media.mediaId, "inbound", maxBytes).catch(() => null);
      if (!opened) {
        return undefined;
      }
      let transferred = false;
      try {
        assertCurrent();
        if (identity(opened) !== request.expectedDigest) {
          return undefined;
        }
        const response = resolveByteResponse({
          file: opened.stat,
          method: request.method,
          request: { headers: request.headers, headersDistinct: {} },
        });
        if (
          request.method === "HEAD" ||
          response.kind === "unsatisfiable" ||
          response.kind === "not-modified"
        ) {
          return { artifact, response };
        }
        if (media.kind === "video") {
          transferred = true;
          return { artifact, response, file: opened.handle };
        }
        const body = new Uint8Array(response.contentLength);
        const read = await readFileWindowFully(
          opened.handle,
          Buffer.from(body.buffer, body.byteOffset, body.byteLength),
          response.kind === "partial" ? response.range.start : 0,
        );
        if (read !== body.byteLength) {
          return undefined;
        }
        assertCurrent();
        return { artifact, response, body };
      } finally {
        if (!transferred) {
          await opened[Symbol.asyncDispose]();
        }
      }
    },
  });
  access.detach(selected.release);
  return { response: { artifact, ...download }, assertCurrent };
}
