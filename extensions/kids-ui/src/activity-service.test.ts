import type { ActivitySnapshot } from "@openclaw/kids-activity-contract";
import type {
  OpenClawPluginApi,
  OpenClawPluginServiceContextV2,
  OpenClawPluginServiceV2,
} from "openclaw/plugin-sdk/plugin-entry";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ActivityChildBinding } from "./activity-contract.js";
import { registerKidsActivityService } from "./activity-service.js";

const mocks = vi.hoisted(() => ({
  open: vi.fn(),
  execute: vi.fn(),
  close: vi.fn(),
  write: vi.fn(),
}));
vi.mock("openclaw/plugin-sdk/sqlite-runtime", () => ({
  openSqliteWorkerStore: mocks.open,
  runSqliteWorkerStoreWrite: mocks.write,
}));
vi.mock("openclaw/plugin-sdk/process-runtime", () => ({
  resolveRuntimeWorkerUrl: () => new URL("file:///fixture/activity-store.worker.js"),
}));
const child: ActivityChildBinding = {
  childId: "child",
  agentId: "tutor",
  sessionKey: "agent:tutor:main",
  timeZone: "America/Chicago",
};
const snapshot: ActivitySnapshot = {
  now: 0,
  date: "2026-10-13",
  pet: { state: "normal", scene: null, image: null, lastInteractionAt: null, excitedUntil: null },
  correctStreak: 0,
  activity: null,
  daily: null,
  nextActivity: null,
};

function harness(
  options: { startGeneration?: () => Promise<void>; stopGeneration?: () => Promise<void> } = {},
) {
  let service!: OpenClawPluginServiceV2;
  const lifetime = new AbortController();
  const api = {
    registerService: (value: OpenClawPluginServiceV2) => {
      service = value;
    },
  } as unknown as OpenClawPluginApi;
  const owner = registerKidsActivityService(api, {
    children: [child],
    now: () => Date.parse("2026-10-14T02:00:00Z"),
    ...options,
  });
  const context = {
    stateDir: "/fixture",
    scheduler: { signal: lifetime.signal },
  } as OpenClawPluginServiceContextV2;
  return {
    owner,
    start: () => service.start(context),
    stop: () => {
      lifetime.abort();
      return service.stop?.(context);
    },
  };
}
beforeEach(() => {
  vi.clearAllMocks();
  mocks.open.mockResolvedValue({ execute: mocks.execute, close: mocks.close });
  mocks.execute.mockResolvedValue(snapshot);
  mocks.close.mockResolvedValue(undefined);
  mocks.write.mockImplementation(async (store, run, guard) => {
    guard();
    return run(store);
  });
});

describe("activity service lifetime", () => {
  it("does not admit calls before activation and uses the child's date", async () => {
    const service = harness();
    await expect(service.owner.get("child", () => {})).rejects.toThrow("restarting");
    await service.start();
    await service.owner.get("child", () => {});
    expect(mocks.execute).toHaveBeenCalledWith(
      expect.objectContaining({
        input: { childId: "child", date: "2026-10-13", now: Date.parse("2026-10-14T02:00:00Z") },
      }),
      expect.anything(),
    );
    await service.stop();
  });

  it("seals admission and joins accepted calls before closing the worker", async () => {
    const pending = Promise.withResolvers<ActivitySnapshot>();
    const service = harness();
    await service.start();
    mocks.execute.mockReturnValue(pending.promise);
    const read = service.owner.get("child", () => {});
    const rejected = expect(read).rejects.toThrow();
    const stopped = service.stop();
    expect(mocks.close).not.toHaveBeenCalled();
    await expect(service.owner.get("child", () => {})).rejects.toThrow("restarting");
    pending.resolve(snapshot);
    await rejected;
    await stopped;
    expect(mocks.close).toHaveBeenCalledOnce();
  });

  it("joins an opening worker and closes it when stop races startup", async () => {
    const opening = Promise.withResolvers<unknown>();
    mocks.open.mockReturnValue(opening.promise);
    const service = harness();
    const started = service.start();
    let settled = false;
    const stopped = Promise.resolve(service.stop()).then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);
    opening.resolve({ execute: mocks.execute, close: mocks.close });
    await started;
    await stopped;
    expect(mocks.close).toHaveBeenCalledOnce();
    await expect(service.owner.get("child", () => {})).rejects.toThrow("restarting");
  });

  it("cleans up a failed generation activation and discards revoked read results", async () => {
    const failed = harness({
      startGeneration: async () => {
        throw new Error("generation admission failed");
      },
    });
    await expect(failed.start()).rejects.toThrow("generation admission failed");
    expect(mocks.close).toHaveBeenCalledOnce();
    const service = harness();
    await service.start();
    const pending = Promise.withResolvers<ActivitySnapshot>();
    mocks.execute.mockReturnValue(pending.promise);
    let authorized = true;
    const read = service.owner.get("child", () => {
      if (!authorized) {
        throw new Error("revoked");
      }
    });
    authorized = false;
    pending.resolve(snapshot);
    await expect(read).rejects.toThrow("revoked");
    await service.stop();
  });
});
