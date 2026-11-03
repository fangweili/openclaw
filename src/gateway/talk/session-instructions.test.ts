/**
 * Talk uses the shared bootstrap owner for the selected agent and session. Each
 * case owns isolated workspace files and state; fixture teardown joins SQLite work.
 */
import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { resolveTalkRealtimeProviderInstructions } from "./session-config.js";

describe("Talk realtime workspace instructions", () => {
  it.each(["amber", "indigo"])(
    "loads %s workspace policy for personal and shared calls without inventing a speaker",
    async (agentId) =>
      await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
        const workspaces = {
          amber: state.path("amber"),
          indigo: state.path("indigo"),
        };
        await Promise.all(
          Object.entries(workspaces).map(async ([id, directory]) => {
            await fs.mkdir(directory, { recursive: true });
            await Promise.all([
              fs.writeFile(path.join(directory, "IDENTITY.md"), `Name: ${id} assistant`),
              fs.writeFile(path.join(directory, "USER.md"), `${id}: shared household information.`),
              fs.writeFile(
                path.join(directory, "SOUL.md"),
                `${id}: follow this workspace's handoff policy.`,
              ),
            ]);
          }),
        );
        await fs.writeFile(path.join(state.workspaceDir, "SOUL.md"), "Unselected default policy.");
        const config: OpenClawConfig = {
          agents: {
            defaults: { workspace: state.workspaceDir },
            entries: {
              amber: { workspace: workspaces.amber },
              indigo: { workspace: workspaces.indigo },
            },
          },
        };
        const warn = vi.fn();
        for (const conversation of ["personal:listener", "family"]) {
          const instructions = await resolveTalkRealtimeProviderInstructions({
            config,
            agentId,
            sessionKey: `agent:${agentId}:${conversation}`,
            configuredInstructions: "Speak warmly.",
            warn,
          });
          expect(instructions).toContain("Speak warmly.");
          expect(instructions).toContain(`### IDENTITY.md\nName: ${agentId} assistant`);
          expect(instructions).toContain(`### USER.md\n${agentId}: shared household information.`);
          expect(instructions).toContain(
            `### SOUL.md\n${agentId}: follow this workspace's handoff policy.`,
          );
          expect(instructions).not.toContain("Unselected default policy.");
          expect(instructions).not.toContain(`${agentId === "amber" ? "indigo" : "amber"}:`);
          expect(instructions).not.toContain("authenticated_caller");
          expect(instructions).not.toContain("OpenClaw Talk session context");
          expect(instructions).not.toContain("Delegate requests that depend on personal profile");
        }
        expect(warn).not.toHaveBeenCalled();
      }),
  );
});
