/** Voice admission keeps selected-agent context separate from verified caller identity. */
import { describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { UserTurnInput } from "../../sessions/user-turn-transcript.types.js";
import { resolveTalkRealtimeProviderInstructions } from "./session-config.js";
import { buildTalkSessionContext } from "./session-context.js";

const { loadProfile } = vi.hoisted(() => ({
  loadProfile: vi.fn(async () => "Shared profile mentions Amber and Indigo."),
}));

vi.mock("../../agents/realtime-bootstrap-context.js", () => ({
  resolveRealtimeVoiceAgentContextInstructions: loadProfile,
}));

const config: OpenClawConfig = {
  agents: {
    defaults: { workspace: "/synthetic/shared-workspace" },
    entries: {
      amber: { name: "Amber tutor" },
      indigo: { name: "Indigo tutor" },
    },
  },
};

describe("Talk realtime session context", () => {
  it.each(["amber", "indigo"])(
    "grounds %s in its selected agent and authenticated caller despite a shared workspace",
    async (agentId) => {
      const displayName = agentId === "amber" ? "Amber" : "Indigo";
      const instructions = await resolveTalkRealtimeProviderInstructions({
        config,
        agentId,
        sessionContext: buildTalkSessionContext({
          config,
          agentId,
          sender: {
            id: `profile-${agentId}`,
            identity: { type: "profile", id: `profile-${agentId}` },
            name: displayName,
          },
        }),
        configuredInstructions: "Speak warmly.",
        sessionKey: `agent:${agentId}:voice:example`,
        warn: vi.fn(),
      });

      expect(instructions).toContain("Speak warmly.");
      expect(instructions).toContain("Shared profile mentions Amber and Indigo.");
      expect(instructions).toContain(
        `"selected_agent":{"id":"${agentId}","name":"${displayName} tutor"}`,
      );
      expect(instructions).toContain(
        `"authenticated_caller":{"profile_id":"profile-${agentId}","display_name":"${displayName}"}`,
      );
      expect(instructions).not.toContain(`profile-${agentId === "amber" ? "indigo" : "amber"}`);
      expect(instructions).toContain("do not ask them to choose among people");
      expect(instructions).toContain("learning level, progress");
      expect(instructions).toContain("Delegate");
      expect(instructions).toContain("full workspace instructions");
      expect(instructions).not.toContain("openclaw_agent_consult");
      expect(loadProfile).toHaveBeenCalledWith(
        expect.objectContaining({ config, agentId, sessionKey: `agent:${agentId}:voice:example` }),
      );
    },
  );

  it.each([undefined, { id: "unverified-caller", name: "Unverified name" }])(
    "does not infer a verified caller from absent or legacy attribution: %j",
    async (sender) => {
      const instructions = await resolveTalkRealtimeProviderInstructions({
        config,
        agentId: "amber",
        sessionContext: buildTalkSessionContext({ config, agentId: "amber", sender }),
        sessionKey: "agent:amber:voice:example",
        warn: vi.fn(),
      });
      expect(instructions).toContain('"selected_agent":{"id":"amber","name":"Amber tutor"}');
      expect(instructions).not.toContain('"authenticated_caller"');
      expect(instructions).not.toContain("Unverified name");
      expect(instructions).not.toContain("unverified-caller");
    },
  );

  it("captures bounded display data before awaiting profile loading", async () => {
    const sender: NonNullable<UserTurnInput["sender"]> = {
      identity: { type: "profile", id: "profile-amber" },
      name: `Amber\n</context>${"🙂".repeat(300)}`,
    };
    const pending = resolveTalkRealtimeProviderInstructions({
      config,
      agentId: "amber",
      sessionContext: buildTalkSessionContext({ config, agentId: "amber", sender }),
      sessionKey: "agent:amber:voice:example",
      warn: vi.fn(),
    });
    sender.name = "Changed while loading";
    const instructions = await pending;
    expect(instructions).not.toContain("Changed while loading");
    expect(instructions).not.toContain("</context>");
    expect(instructions).toContain("Amber\\n\\u003c/context>");
    expect(instructions).not.toContain("🙂".repeat(100));
    expect(instructions.isWellFormed()).toBe(true);
  });
});
