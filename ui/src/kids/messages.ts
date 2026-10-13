/**
 * Pure kids transcript presentation: selects child messages and finished tutor
 * replies, then projects their text and supported media without mutating inputs.
 * Shared text/media extractors own content interpretation. This module owns no
 * resources, session authority, ordering, custody, async work or cached state;
 * the conversation supplies the selected transcript and stable display IDs.
 */
import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { isToolCallContentType } from "../../../src/chat/tool-content.js";
import { resolveAssistantMessagePhase } from "../../../src/shared/chat-message-content.js";
import { extractText } from "../lib/chat/message-extract.ts";
import { isVisibleChatHistoryMessage } from "../lib/chat/message-visibility.ts";
import { projectKidsMedia, type KidsMedia } from "./media.ts";

export type KidsMessage = {
  id: string;
  role: "user" | "assistant";
  text: string;
  media: readonly KidsMedia[];
};

/** Selects child-visible text/media; hides tools, commentary and failed/aborted replies. */
export function visibleMessage(message: unknown): boolean {
  const record = asOptionalRecord(message);
  const role = record?.role;
  if (
    (role !== "user" && role !== "assistant") ||
    record?.display === false ||
    !isVisibleChatHistoryMessage(message)
  ) {
    return false;
  }
  // Tool-bearing turns are activity. A pure-text final may legitimately inherit
  // a toolUse stop reason. The shared extractor owns explicit final/commentary
  // precedence and removes thinking, envelopes, and internal runtime context.
  return (
    (role === "user" ||
      (record?.stopReason !== "error" &&
        record?.stopReason !== "aborted" &&
        (!Array.isArray(record?.content) ||
          !record.content.some((part) => isToolCallContentType(asOptionalRecord(part)?.type))))) &&
    (Boolean(extractText(message)?.trim()) ||
      (resolveAssistantMessagePhase(message) !== "commentary" &&
        projectKidsMedia(message).length > 0))
  );
}

/** Project supplied rows in order; hidden rows are omitted and inputs remain unchanged. */
export function projectKidsMessages(
  display: readonly { id: string; message: unknown }[],
): KidsMessage[] {
  const messages: KidsMessage[] = [];
  for (const entry of display) {
    const role = asOptionalRecord(entry.message)?.role;
    if ((role !== "user" && role !== "assistant") || !visibleMessage(entry.message)) {
      continue;
    }
    messages.push({
      id: entry.id,
      role,
      text: extractText(entry.message)?.trim() ?? "",
      media: projectKidsMedia(entry.message),
    });
  }
  return messages;
}
