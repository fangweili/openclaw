import { kindFromMime } from "@openclaw/media-core/mime";
/**
 * Uploaded media references are projections of exact persisted transcript slots.
 * They carry no file authority: artifact downloads authorize the session, recover
 * that same physical row, then open only its canonical inbound-store entry.
 * Nothing is persisted here; optimistic rows and outside/remote sources have no ID.
 */
import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { readPersistedMediaFacts, type MediaFact } from "../media/media-facts.js";
import { buildInboundMediaUriFromPath, parseInboundMediaUri } from "../media/media-reference.js";
import {
  createTranscriptArtifactId,
  parseTranscriptArtifactId,
} from "./transcript-image-artifacts.js";

const PREFIX = "artifact_transcript_media_";

/** Decode only this reference family; malformed IDs cannot select a file. */
export function parseTranscriptMediaArtifactId(id: string) {
  return parseTranscriptArtifactId(id, PREFIX);
}

function inboundMedia(fact: MediaFact | undefined) {
  const kind = fact?.kind ?? kindFromMime(fact?.contentType);
  const source = fact?.path ?? fact?.url;
  if (!fact || (kind !== "image" && kind !== "video") || !source) {
    return undefined;
  }
  try {
    const inbound = parseInboundMediaUri(buildInboundMediaUriFromPath(source) ?? source);
    return inbound ? { fact, kind, mediaId: inbound.id } : undefined;
  } catch {
    return undefined;
  }
}

/** Decorate canonical history without trusting IDs supplied by a stored message. */
export function projectTranscriptMediaArtifacts(message: unknown): unknown {
  const record = asOptionalRecord(message);
  const metadata = asOptionalRecord(record?.["__openclaw"]);
  if (!record || !Array.isArray(metadata?.media)) {
    return message;
  }
  const facts = readPersistedMediaFacts(record);
  const media = metadata.media.map((raw, index) => {
    const { artifactId: _ignored, ...fact } = asOptionalRecord(raw) ?? {};
    const artifactId =
      inboundMedia(facts?.[index]) && createTranscriptArtifactId(record, index, PREFIX);
    return artifactId ? { ...fact, artifactId } : fact;
  });
  return { ...record, __openclaw: { ...metadata, media } };
}

/** Recover a reference only from the identical stored row/generation and slot. */
export function resolveTranscriptMediaArtifact(message: unknown, artifactId: string) {
  const reference = parseTranscriptMediaArtifactId(artifactId);
  const record = asOptionalRecord(message);
  if (
    !reference ||
    !record ||
    createTranscriptArtifactId(record, reference.contentIndex, PREFIX) !== artifactId
  ) {
    return undefined;
  }
  return inboundMedia(readPersistedMediaFacts(record)?.[reference.contentIndex]);
}
