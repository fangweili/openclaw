/**
 * Pure display reconciliation for canonical input custody. The caller owns its
 * projection, custody page, and lifetime; these helpers perform no I/O or writes.
 * Gateway row run IDs retire local optimistic sources. Only canonical user IDs
 * replace custody display; equal text never establishes identity. Immutable
 * transcript arrays are weakly indexed for repeated renders without retention.
 */
import {
  readSessionMessageIdentity,
  type SessionProjectionState,
} from "@openclaw/gateway-client/browser";
import { asNullableRecord } from "@openclaw/normalization-core/record-coerce";
import type { ChatPendingInputsPage } from "../../../../packages/gateway-protocol/src/schema/logs-chat.js";
import type { ChatQueueItem } from "./chat-types.ts";

// History arrays are replaced, never mutated; index each once, not per scroll render.
const userIdentities = new WeakMap<
  readonly unknown[],
  { userIds: Set<string>; sendKeys: Set<string> }
>();

/**
 * Selects distinct local, accepted, and queued collections without changing their
 * order or inputs. `messages` must be immutable. Canonical user IDs replace
 * custody; row run IDs or durable send keys suppress local queue copies. Hidden
 * nonqueued custody is omitted; queued rows remain available to the queue owner.
 */
export function selectChatInputDisplay(
  messages: readonly unknown[],
  queue: readonly ChatQueueItem[],
  inputs: ChatPendingInputsPage["items"],
) {
  let identities = userIdentities.get(messages);
  if (!identities) {
    identities = { userIds: new Set(), sendKeys: new Set() };
    for (const message of messages) {
      const identity = readSessionMessageIdentity(message);
      if (identity?.role === "user") {
        if (identity.id) {
          identities.userIds.add(identity.id);
        }
        if (identity.idempotencyKey) {
          identities.sendKeys.add(identity.idempotencyKey);
        }
      }
    }
    userIdentities.set(messages, identities);
  }
  const { userIds, sendKeys } = identities;
  const accepted = new Set(inputs.map((input) => input.runId));
  return {
    queue: queue.filter(
      (item) =>
        !item.sendRunId ||
        (!accepted.has(item.sendRunId) &&
          !sendKeys.has(item.sendRunId) &&
          !sendKeys.has(`${item.sendRunId}:user`)),
    ),
    pendingInputs: inputs.filter(
      (input) =>
        !userIds.has(input.id) &&
        !input.queued &&
        asNullableRecord(input.message)?.display !== false,
    ),
    queuedInputs: inputs.filter((input) => !userIds.has(input.id) && input.queued),
  };
}

/**
 * Returns a projection without optimistic user entries proven accepted by a
 * custody row or receipt. Durable entries are never removed, and no match returns
 * the original projection. The caller owns publication and acceptance authority.
 */
export function retirePendingUserEntries(
  projection: SessionProjectionState,
  acceptedRunIds: ReadonlySet<string>,
): SessionProjectionState {
  const entries = projection.entries.filter(
    (entry) =>
      !(
        entry.pending &&
        entry.identity?.role === "user" &&
        entry.identity.id === null &&
        entry.identity.sequence === null &&
        acceptedRunIds.has(entry.pendingRunId ?? "")
      ),
  );
  return entries.length === projection.entries.length
    ? projection
    : { ...projection, entries, messages: entries.map((entry) => entry.message) };
}
