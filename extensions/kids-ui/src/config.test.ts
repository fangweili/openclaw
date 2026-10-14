import fs from "node:fs";
import { Check } from "typebox/value";
import { describe, expect, it } from "vitest";
import { parseKidsConfig } from "./config.js";

const child = {
  childId: "student",
  agentId: "tutor",
  sessionKey: "agent:tutor:kids:student-profile",
  timeZone: "America/Chicago",
  preparationJobId: "prepare-student",
};

describe("activity installation authority", () => {
  it("rejects ambiguous or mismatched child owners before activation", () => {
    expect(parseKidsConfig(undefined)).toEqual({});
    expect(parseKidsConfig({ activities: { children: [child] } }).activities?.children).toEqual([
      child,
    ]);
    for (const field of ["childId", "agentId", "sessionKey", "preparationJobId"] as const) {
      const other = {
        ...child,
        childId: "other",
        agentId: "other-tutor",
        sessionKey: "agent:other-tutor:kids:other-profile",
        preparationJobId: "prepare-other",
        [field]: child[field],
      };
      expect(() => parseKidsConfig({ activities: { children: [child, other] } })).toThrow();
    }
    expect(() =>
      parseKidsConfig({ activities: { children: [{ ...child, sessionKey: "agent:other:main" }] } }),
    ).toThrow();
    expect(() =>
      parseKidsConfig({ activities: { children: [{ ...child, timeZone: "not/a-zone" }] } }),
    ).toThrow();
  });

  it("keeps discovery and runtime admission aligned", () => {
    const manifest = JSON.parse(
      fs.readFileSync(new URL("../openclaw.plugin.json", import.meta.url), "utf8"),
    );
    for (const config of [
      {},
      { activities: { children: [child] } },
      { activities: { children: [child], evidenceJobs: [{ agentId: "jobs", jobId: "nightly" }] } },
      { extra: true },
      { activities: { children: [] } },
      { activities: { children: [{ ...child, pet: "rocky" }] } },
      { activities: { children: [{ ...child, preparationJobId: "" }] } },
      { activities: { children: [child], extra: true } },
    ]) {
      const discoveryAccepts = Check(manifest.configSchema, config);
      let runtimeAccepts = true;
      try {
        parseKidsConfig(config);
      } catch {
        runtimeAccepts = false;
      }
      expect(runtimeAccepts).toBe(discoveryAccepts);
    }
  });
});
