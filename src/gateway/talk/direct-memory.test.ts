import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { resolveTalkDirectMemoryTool } from "./direct-memory.js";
import type { PreparedTalkSessionTarget } from "./session-target.types.js";

const mocks = vi.hoisted(() => ({
  toolResolutionImported: vi.fn(),
  resolveGatewayScopedTools: vi.fn(),
}));

vi.mock("../tool-resolution.js", () => {
  mocks.toolResolutionImported();
  return { resolveGatewayScopedTools: mocks.resolveGatewayScopedTools };
});

const config = {} as OpenClawConfig;
const target: PreparedTalkSessionTarget = {
  agentId: "family",
  sessionKey: "family-client-alias",
  canonicalKey: "agent:family:voice:test",
  storePath: "/test/family/sessions.json",
};
const parameters = {
  type: "object",
  properties: { query: { type: "string" }, corpus: { type: "string", enum: ["sessions"] } },
  required: ["query"],
};
const execute = vi.fn();
const memoryTool = {
  name: "memory_search",
  description: "Canonical registered search description.",
  parameters,
  execute,
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.resolveGatewayScopedTools.mockReturnValue({ tools: [memoryTool] });
});

describe("Talk direct memory declaration", () => {
  it("does not load or resolve the standalone tool surface for a Talk-only caller", async () => {
    const result = await resolveTalkDirectMemoryTool({
      config,
      target,
      scopes: ["operator.talk", "operator.read"],
      assertCurrent: vi.fn(),
    });

    expect(result).toBeUndefined();
    expect(mocks.toolResolutionImported).not.toHaveBeenCalled();
    expect(mocks.resolveGatewayScopedTools).not.toHaveBeenCalled();
  });

  it.each([
    { scopes: ["operator.write"], senderIsOwner: false },
    { scopes: ["operator.admin"], senderIsOwner: true },
  ])("uses standalone invocation authority for $scopes", async ({ scopes, senderIsOwner }) => {
    const assertCurrent = vi.fn();
    const clientCaps = ["voice-test"];
    await resolveTalkDirectMemoryTool({ config, target, scopes, clientCaps, assertCurrent });

    expect(mocks.resolveGatewayScopedTools).toHaveBeenCalledWith({
      cfg: config,
      agentId: target.agentId,
      sessionKey: target.canonicalKey,
      senderIsOwner,
      clientCaps,
      conversationReadOrigin: "delegated",
      surface: "http",
      assertInvocationCurrent: assertCurrent,
    });
    expect(assertCurrent).toHaveBeenCalled();
  });

  it("copies the registered declaration without keeping an executable tool", async () => {
    const result = await resolveTalkDirectMemoryTool({
      config,
      target,
      scopes: ["operator.write"],
      assertCurrent: vi.fn(),
    });

    expect(result).toEqual({
      type: "function",
      name: memoryTool.name,
      description: memoryTool.description,
      parameters,
    });
    expect(result?.parameters).toBe(parameters);
    expect(result).not.toHaveProperty("execute");
    expect(execute).not.toHaveBeenCalled();
  });

  it("omits memory when the canonical policy or registration does not expose it", async () => {
    mocks.resolveGatewayScopedTools.mockReturnValue({
      tools: [
        { ...memoryTool, name: "memory_get" },
        { ...memoryTool, name: "exec" },
      ],
    });
    const result = await resolveTalkDirectMemoryTool({
      config,
      target,
      scopes: ["operator.write"],
      assertCurrent: vi.fn(),
    });

    expect(result).toBeUndefined();
    expect(execute).not.toHaveBeenCalled();
  });

  it.each([
    { type: "string" },
    { type: "object", properties: [] },
    { type: "object", properties: {}, required: [false] },
  ])("omits a schema the voice transport cannot represent: %j", async (invalidParameters) => {
    mocks.resolveGatewayScopedTools.mockReturnValue({
      tools: [{ ...memoryTool, parameters: invalidParameters }],
    });
    expect(
      await resolveTalkDirectMemoryTool({
        config,
        target,
        scopes: ["operator.write"],
        assertCurrent: vi.fn(),
      }),
    ).toBeUndefined();
  });

  it("rejects authority that becomes stale while the resolver module is loading", async () => {
    let current = true;
    const assertCurrent = () => {
      if (!current) {
        throw new Error("request authority changed");
      }
    };
    const pending = resolveTalkDirectMemoryTool({
      config,
      target,
      scopes: ["operator.write"],
      assertCurrent,
    });
    current = false;

    await expect(pending).rejects.toThrow("request authority changed");
    expect(mocks.resolveGatewayScopedTools).not.toHaveBeenCalled();
  });

  it("does not publish a declaration after tool construction invalidates authority", async () => {
    let current = true;
    mocks.resolveGatewayScopedTools.mockImplementationOnce(() => {
      current = false;
      return { tools: [memoryTool] };
    });
    const pending = resolveTalkDirectMemoryTool({
      config,
      target,
      scopes: ["operator.write"],
      assertCurrent: () => {
        if (!current) {
          throw new Error("request authority changed");
        }
      },
    });

    await expect(pending).rejects.toThrow("request authority changed");
    expect(execute).not.toHaveBeenCalled();
  });
});
