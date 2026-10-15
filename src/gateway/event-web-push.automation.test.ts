// Canonical cron commits deliver to offline owners under current device/role authority.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import {
  replaceSessionEntry,
  upsertSessionEntryCore,
} from "../config/sessions/session-accessor.js";
import type { GatewayOperatorRoleDefinition } from "../config/types.gateway.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { PairedDevice } from "../infra/device-pairing.js";
import type { BoundWebPushSubscription } from "../infra/push-web.js";
import { commitBackgroundResultToSession } from "../sessions/background-session-result.js";
import {
  onInternalSessionTranscriptUpdate,
  type InternalSessionTranscriptUpdate,
} from "../sessions/transcript-events.js";
import { setUserProfileRole } from "../state/user-profile-writes.worker.js";
import { ensureProfileForEmail } from "../state/user-profiles.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { createEventWebPushDelivery } from "./event-web-push.js";

const mocks = vi.hoisted(() => ({
  subscriptions: [] as BoundWebPushSubscription[],
  paired: [] as PairedDevice[],
  prepare: vi.fn(),
  send: vi.fn(),
}));

vi.mock("../infra/push-web.js", () => ({
  hasBoundWebPushSubscriptions: async () => mocks.subscriptions.length > 0,
  prepareWebPushNotificationSender: mocks.prepare,
  withBoundWebPushSubscriptions: async (
    _stateDir: unknown,
    prepare: (
      subscriptions: BoundWebPushSubscription[],
      assertCurrent: () => void,
    ) => Promise<{ start: () => unknown }>,
  ) => (await prepare(mocks.subscriptions, () => {})).start(),
}));

vi.mock("../infra/device-pairing-worker.js", () => ({
  withCurrentDevicePairingSnapshot: async (
    _stateDir: unknown,
    prepare: (paired: PairedDevice[]) => { start: () => unknown } | undefined,
  ) => prepare(mocks.paired)?.start(),
}));

function subscription(deviceId: string, userProfileId: string): BoundWebPushSubscription {
  const scopes = ["operator.sessions.write"];
  mocks.paired.push({
    deviceId,
    publicKey: deviceId,
    role: "operator",
    roles: ["operator"],
    scopes,
    approvedScopes: scopes,
    tokens: {
      operator: { token: "test-only", role: "operator", scopes, createdAtMs: 1 },
    },
    createdAtMs: 1,
    approvedAtMs: 1,
  });
  return {
    deviceId,
    userProfileId,
    subscriptionId: `subscription-${deviceId}`,
    endpoint: `https://push.example.test/${deviceId}`,
    keys: { p256dh: "test-only", auth: "test-only" },
    createdAtMs: 1,
    updatedAtMs: 1,
    devicePreferences: {
      enabled: true,
      label: "",
      detailLevel: "private",
      categories: {
        agentFinished: true,
        agentQuestion: false,
        humanMentioned: false,
        scheduledTaskFailed: false,
      },
    },
  };
}

async function withCompletion(
  run: (fixture: {
    policy: GatewayOperatorRoleDefinition;
    update: InternalSessionTranscriptUpdate;
    delivery: ReturnType<typeof createEventWebPushDelivery>;
    controller: AbortController;
    ownerId: string;
    otherId: string;
  }) => Promise<void>,
) {
  await withOpenClawTestState({ scenario: "minimal" }, async () => {
    const owner = ensureProfileForEmail("child-owner@example.test");
    const other = ensureProfileForEmail("child-other@example.test");
    setUserProfileRole(owner.id, "student");
    setUserProfileRole(other.id, "student");
    mocks.subscriptions = [subscription("owner", owner.id), subscription("other", other.id)];
    const policy: GatewayOperatorRoleDefinition = {
      scopes: ["operator.sessions.write"],
      sessions: { others: "none" },
      agents: ["main"],
    };
    const cfg: OpenClawConfig = {
      gateway: { roles: { default: "student", definitions: { student: policy } } },
    };
    const sessionKey = "agent:main:kids:owner";
    const generation = { sessionId: "offline-kids-session", lifecycleRevision: "revision-1" };
    await upsertSessionEntryCore(
      { agentId: "main", sessionKey },
      {
        ...generation,
        updatedAt: 1,
        visibility: "shared",
        createdActor: { type: "human", source: "profile", id: owner.id },
      },
    );
    let update: InternalSessionTranscriptUpdate | undefined;
    const unsubscribe = onInternalSessionTranscriptUpdate((event) => {
      update = event;
    });
    try {
      expect(
        await commitBackgroundResultToSession({
          agentId: "main",
          sessionKey,
          expectedGeneration: generation,
          text: "Would you like a one-minute challenge?",
          idempotencyKey: "cron-current-completion:cron:challenge:1000",
          provenance: { kind: "cron", jobId: "challenge", runId: "cron:challenge:1000" },
          config: cfg,
        }),
      ).toMatchObject({ ok: true });
    } finally {
      unsubscribe();
    }
    expect(update?.target?.sessionId).toBe(generation.sessionId);
    await run({
      policy,
      update: update!,
      controller: new AbortController(),
      delivery: createEventWebPushDelivery({ getRuntimeConfig: () => cfg, log: { warn: vi.fn() } }),
      ownerId: owner.id,
      otherId: other.id,
    });
  });
}

describe("canonical automation Web Push", () => {
  beforeEach(() => {
    mocks.paired = [];
    mocks.subscriptions = [];
    mocks.send.mockReset().mockResolvedValue([]);
    mocks.prepare.mockReset().mockResolvedValue(mocks.send);
  });
  afterEach(() => vi.restoreAllMocks());

  it("sends an offline canonical commit only to its owner and coalesces concurrent/repeated publications", async () => {
    await withCompletion(async ({ update, delivery, controller }) => {
      await Promise.all([
        delivery.deliverAutomationCompletion(update, controller.signal),
        delivery.deliverAutomationCompletion(update, controller.signal),
      ]);
      await delivery.deliverAutomationCompletion(update, controller.signal);
      expect(mocks.send).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({
          subscriptions: [mocks.subscriptions[0]],
          payload: expect.objectContaining({
            body: "An agent completed its response.",
            renotify: false,
          }),
        }),
      );
    });
  });

  it("rejects forged provenance, missing storage identity and an uncommitted message", async () => {
    await withCompletion(async ({ update, delivery, controller }) => {
      const message = update.message as Record<string, unknown>;
      for (const changed of [
        { message: { ...message, provider: "provider-model" } },
        {
          message: {
            ...message,
            openclawAutomation: { kind: "cron", jobId: "wrong", runId: "cron:challenge:1000" },
          },
        },
        { messageId: "never-committed" },
        { target: { ...update.target!, storePath: undefined } },
      ]) {
        await delivery.deliverAutomationCompletion({ ...update, ...changed }, controller.signal);
      }
      expect(mocks.send).not.toHaveBeenCalled();
      await delivery.deliverAutomationCompletion(update, controller.signal);
      expect(mocks.send).toHaveBeenCalledOnce();
    });
  });

  it.each(["agent", "role", "device", "owner", "generation", "abort"] as const)(
    "rechecks %s authority after sender preparation yields",
    async (change) => {
      await withCompletion(async ({ policy, update, delivery, controller, otherId }) => {
        const entered = createDeferred();
        const ready = createDeferred<typeof mocks.send>();
        mocks.prepare.mockImplementationOnce(() => {
          entered.resolve();
          return ready.promise;
        });
        const pending = delivery.deliverAutomationCompletion(update, controller.signal);
        await entered.promise;
        if (change === "agent") {
          policy.agents = [];
        }
        if (change === "role") {
          policy.scopes = [];
        }
        if (change === "device") {
          mocks.paired = [];
        }
        if (change === "abort") {
          controller.abort();
        }
        if (change === "owner") {
          await replaceSessionEntry(
            { agentId: "main", sessionKey: update.target!.sessionKey },
            {
              sessionId: "replacement-session",
              updatedAt: Date.now(),
              createdActor: { type: "human", source: "profile", id: otherId },
            },
          );
        }
        if (change === "generation") {
          await upsertSessionEntryCore(
            { agentId: "main", sessionKey: update.target!.sessionKey },
            { lifecycleRevision: "revision-2" },
          );
        }
        ready.resolve(mocks.send);
        await pending;
        expect(mocks.send).not.toHaveBeenCalled();
      });
    },
  );
});
