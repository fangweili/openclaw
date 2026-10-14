import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import { describe, expect, it, vi } from "vitest";
import { registerKidsActivityContext } from "./activity-context.js";
import type { ActivityChildBinding, ActivityPreparationContext } from "./activity-contract.js";
import type { ActivityOwner } from "./activity-service.js";

const child: ActivityChildBinding = {
  childId: "child",
  agentId: "tutor",
  sessionKey: "agent:tutor:main",
  timeZone: "America/Chicago",
};
type Context = {
  agentId: string;
  sessionKey: string;
  memoryAudience?:
    | { kind: "conversation"; agentId: string; sessionKey: string; sessionId: string }
    | { kind: "owner-private"; agentId: string };
  hookInvocation?: { assertActive(): void };
  assertMemoryAudienceCurrent?: () => void;
};
type Hook = (event: unknown, context: Context) => Promise<{ prependContext: string } | undefined>;
const prepared: ActivityPreparationContext = {
  snapshot: {
    now: 0,
    date: "2026-10-13",
    pet: {
      state: "normal",
      scene: null,
      image: { imageId: "reference", caption: "Our boat adventure" },
      lastInteractionAt: 0,
      excitedUntil: null,
    },
    correctStreak: 0,
    activity: null,
    daily: null,
    nextActivity: null,
  },
  recentActivities: [],
  recentScenes: [],
  activitiesOmitted: 0,
};
function harness() {
  let hook!: Hook;
  const prepare = vi.fn(async () => prepared);
  const api = {
    on: (_name: string, value: Hook) => {
      hook = value;
    },
    logger: { warn: vi.fn() },
  } as unknown as OpenClawPluginApi;
  registerKidsActivityContext(api, { prepare } as unknown as ActivityOwner, [child]);
  const context: Context = {
    agentId: child.agentId,
    sessionKey: child.sessionKey,
    memoryAudience: {
      kind: "conversation",
      agentId: child.agentId,
      sessionKey: child.sessionKey,
      sessionId: "current",
    },
    hookInvocation: { assertActive: () => {} },
    assertMemoryAudienceCurrent: () => {},
  };
  return {
    prepare,
    call: (overrides: Partial<Context> = {}) => hook({}, { ...context, ...overrides }),
  };
}
describe("activity prompt partition", () => {
  it("enriches the main tutor and voice consultation with the matching inherited audience", async () => {
    const test = harness();
    expect((await test.call())?.prependContext).toContain("Our boat adventure");
    expect(
      (await test.call({ sessionKey: "agent:tutor:voice:consult" }))?.prependContext,
    ).toContain("Our boat adventure");
  });
  it("does not cross another agent, conversation, or missing audience", async () => {
    const test = harness();
    expect(await test.call({ agentId: "sibling" })).toBeUndefined();
    expect(await test.call({ memoryAudience: undefined })).toBeUndefined();
    expect(
      await test.call({
        memoryAudience: {
          kind: "conversation",
          agentId: "tutor",
          sessionKey: "agent:tutor:another",
          sessionId: "other",
        },
      }),
    ).toBeUndefined();
    expect(
      await test.call({
        sessionKey: "agent:tutor:unrelated",
        memoryAudience: { kind: "owner-private", agentId: "tutor" },
      }),
    ).toBeUndefined();
    expect(test.prepare).not.toHaveBeenCalled();
  });
  it("discards context if hook or audience expires while the worker read is pending", async () => {
    const test = harness();
    const deferred = Promise.withResolvers<ActivityPreparationContext>();
    test.prepare.mockReturnValue(deferred.promise);
    let current = true;
    const result = test.call({
      assertMemoryAudienceCurrent: () => {
        if (!current) {
          throw new Error("retired conversation");
        }
      },
    });
    current = false;
    deferred.resolve(prepared);
    expect(await result).toBeUndefined();
  });
});
