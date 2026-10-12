// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveControlUiBuildMismatch } from "../../../src/gateway/server/ws-connection/control-ui-build-admission.js";
import { resolveKidsBuildInfo } from "../../vite.kids.config.ts";
import { buildBrowserGatewayConnectPlan } from "../api/gateway-connect-plan.ts";
import type { GatewayBrowserClientOptions } from "../api/gateway.ts";

const captured = vi.hoisted(() => ({
  options: null as GatewayBrowserClientOptions | null,
  buildInfo: {
    version: "2026.10.1",
    commit: "a".repeat(40),
    builtAt: "2026-10-12T12:00:00.000Z",
    buildId: "fixture-gateway-build",
    commitAt: null,
    branch: null,
    dirty: false,
    release: false,
  },
}));

vi.mock("../build-info.ts", () => ({ CONTROL_UI_BUILD_INFO: captured.buildInfo }));
vi.mock("../api/gateway.ts", async (original) => {
  const actual = await original<typeof import("../api/gateway.ts")>();
  return {
    ...actual,
    GatewayBrowserClient: class extends actual.GatewayBrowserClient {
      constructor(options: GatewayBrowserClientOptions) {
        super(options);
        captured.options = options;
      }
    },
  };
});

import { KidsApp } from "./app.ts";

const sources = () => ({
  env: {},
  now: () => new Date("2026-10-12T13:00:00.000Z"),
  readBuildInfo: () => captured.buildInfo,
  readPackageVersion: () => captured.buildInfo.version,
  readGitCommit: () => captured.buildInfo.commit,
});

afterEach(() => vi.unstubAllGlobals());

describe("kids production build identity", () => {
  it("reuses the built Gateway identity instead of minting a separate UI timestamp", () => {
    expect(resolveKidsBuildInfo(sources())).toMatchObject({
      buildId: captured.buildInfo.buildId,
      version: captured.buildInfo.version,
      commit: captured.buildInfo.commit,
      builtAt: captured.buildInfo.builtAt,
    });
  });

  it.each([
    ["missing Gateway artifact", { readBuildInfo: () => undefined }],
    ["stale source commit", { readGitCommit: () => "b".repeat(40) }],
    ["stale package version", { readPackageVersion: () => "2026.10.2" }],
    ["development sentinel", { readBuildInfo: () => ({ ...captured.buildInfo, buildId: "dev" }) }],
    [
      "explicit stale identity",
      {
        env: {
          GIT_COMMIT: "b".repeat(40),
          OPENCLAW_CONTROL_UI_BUILD_ID: captured.buildInfo.buildId,
          OPENCLAW_BUILD_TIMESTAMP: captured.buildInfo.builtAt,
        },
      },
    ],
  ])("refuses %s before emitting production assets", (_name, changes) => {
    expect(() => resolveKidsBuildInfo({ ...sources(), ...changes })).toThrow("Run pnpm build");
  });

  it("advertises the kids artifact identity through the real connect plan and enforces matching admission", async () => {
    // No browser signing or network is required to exercise build admission.
    vi.stubGlobal("crypto", { randomUUID: () => "fixture-build-request" });
    const app = new KidsApp(document.createElement("div"));
    try {
      const opts = captured.options;
      if (!opts) {
        throw new Error("Kids app did not construct its Gateway client");
      }
      const plan = await buildBrowserGatewayConnectPlan({
        opts,
        connectNonce: "fixture-challenge",
        connectChallengeTs: 1_800_000_000_000,
        generation: 1,
        serverCapabilities: [],
        nativeSignal: new AbortController().signal,
        selectAuth: () => ({}),
        onDeviceIdentityReady: () => undefined,
      });
      expect(plan.params.client).toMatchObject({
        id: "openclaw-control-ui",
        version: captured.buildInfo.version,
        buildId: resolveKidsBuildInfo(sources()).buildId,
      });
      const admission = {
        clientId: plan.params.client.id,
        clientBuildId: plan.params.client.buildId,
        requestHost: "family.example",
        requestOrigin: "https://family.example",
      };
      expect(
        resolveControlUiBuildMismatch({ ...admission, gatewayBuildId: captured.buildInfo.buildId }),
      ).toBeNull();
      expect(
        resolveControlUiBuildMismatch({ ...admission, gatewayBuildId: "different-gateway-build" }),
      ).toEqual({
        clientBuildId: captured.buildInfo.buildId,
        gatewayBuildId: "different-gateway-build",
      });
    } finally {
      await app.dispose();
    }
  });
});
