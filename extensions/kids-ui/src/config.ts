/**
 * Installation-time activity bindings. The host validates the manifest shape;
 * this parser additionally rejects ambiguous child/session owners and invalid
 * time zones before any service is activated. Empty configuration keeps chat
 * and dictation available without creating an activity database.
 */
import { z } from "zod";

const identifier = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[a-zA-Z0-9_-]+$/);
const child = z.strictObject({
  childId: identifier,
  agentId: identifier,
  sessionKey: z.string().min(1).max(512),
  timeZone: z.string().min(1).max(100),
  preparationJobId: identifier,
  preparationAgentId: identifier.optional(),
  artworkJobId: identifier.optional(),
});

/** Serializable shape shared by the manifest and runtime configuration parser. */
const kidsConfigSchema = z.strictObject({
  activities: z
    .strictObject({
      children: z.array(child).min(1).max(8),
      evidenceJobs: z
        .array(z.strictObject({ agentId: identifier, jobId: identifier }))
        .max(8)
        .optional(),
    })
    .optional(),
});

export type KidsConfig = z.infer<typeof kidsConfigSchema>;

/** Validate once at plugin registration; never infer identities from browser inputs. */
export function parseKidsConfig(value: unknown): KidsConfig {
  const config = kidsConfigSchema.parse(value ?? {});
  const children = config.activities?.children ?? [];
  // A cron invocation receives exactly one role; a read-only job cannot acquire
  // publication authority through a second binding with the same host identity.
  const jobIdentities = new Set<string>();
  const admitJob = (agentId: string, jobId: string) => {
    const identity = `${agentId}:${jobId}`;
    if (jobIdentities.has(identity)) {
      throw new Error("kids-ui activity jobs require distinct agent and job identities.");
    }
    jobIdentities.add(identity);
  };
  for (const field of ["childId", "agentId", "sessionKey", "preparationJobId"] as const) {
    if (new Set(children.map((entry) => entry[field])).size !== children.length) {
      throw new Error(`kids-ui activities require a unique ${field} for each child.`);
    }
  }
  for (const entry of children) {
    Intl.DateTimeFormat("en", { timeZone: entry.timeZone });
    if (!entry.sessionKey.startsWith(`agent:${entry.agentId}:`)) {
      throw new Error("kids-ui activity sessions must belong to their configured tutor agent.");
    }
    admitJob(entry.preparationAgentId ?? entry.agentId, entry.preparationJobId);
    if (entry.artworkJobId) {
      admitJob(entry.preparationAgentId ?? entry.agentId, entry.artworkJobId);
    }
  }
  for (const entry of config.activities?.evidenceJobs ?? []) {
    admitJob(entry.agentId, entry.jobId);
  }
  return config;
}
