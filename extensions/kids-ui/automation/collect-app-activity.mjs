/**
 * Bounded read-only CLI adapter for the host's existing transcript collector.
 * The caller supplies trusted child/session bindings. The Gateway owns identity,
 * activity storage and grading. Each synchronous child read joins its process;
 * no credentials, workers, files, cursors or callbacks survive the call. A failed
 * read returns a fixed coverage warning and must block invitation outreach.
 */
import { spawnSync } from "node:child_process";

/** Read at most eight configured sessions using existing host CLI authentication. */
export function readAppActivity(bindings, { run = spawnSync } = {}) {
  const entries = Object.entries(bindings);
  if (entries.length > 8) {
    throw new Error("too many activity bindings");
  }
  const snapshots = {};
  for (const [childId, sessionKey] of entries) {
    if (typeof sessionKey !== "string" || sessionKey.length > 512) {
      throw new Error("invalid activity binding");
    }
    try {
      const result = run(
        "openclaw",
        [
          "gateway",
          "call",
          "kids.activity.get",
          "--params",
          JSON.stringify({ sessionKey }),
          "--json",
          "--timeout",
          "25000",
        ],
        {
          encoding: "utf8",
          timeout: 30000,
          maxBuffer: 1024 * 1024,
          stdio: ["ignore", "pipe", "pipe"],
        },
      );
      if (result.error || result.status !== 0) {
        throw new Error("activity read failed");
      }
      const raw = result.stdout.slice(result.stdout.indexOf("{"));
      const value = JSON.parse(raw);
      if (
        !value ||
        !value.pet ||
        !Object.hasOwn(value, "activity") ||
        !Number.isFinite(value.now) ||
        typeof value.date !== "string" ||
        (value.pet.lastInteractionAt !== null && !Number.isFinite(value.pet.lastInteractionAt))
      ) {
        throw new Error("invalid activity snapshot");
      }
      snapshots[childId] = { complete: true, snapshot: value };
    } catch {
      snapshots[childId] = { complete: false, warning: "Saved app activity could not be read." };
    }
  }
  return snapshots;
}
