import fs from "node:fs/promises";
import path from "node:path";
import type { GatewayRequestHandlerOptions } from "openclaw/plugin-sdk/gateway-runtime";
import type { OpenClawConfig, OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import {
  createTestPluginApi,
  createTestPluginServiceScheduler,
} from "openclaw/plugin-sdk/plugin-test-api";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import plugin from "../index.js";

type Runtime = OpenClawPluginApi["runtime"];
type MediaResult = Awaited<ReturnType<Runtime["mediaUnderstanding"]["runFile"]>>;
const audio = {
  audioBase64: Buffer.from("recorded speech").toString("base64"),
  mimeType: "audio/webm",
};
const runFile = vi.fn<Runtime["mediaUnderstanding"]["runFile"]>();
const config: OpenClawConfig = {
  tools: {
    media: { models: [{ provider: "test", model: "transcriber", capabilities: ["audio"] }] },
  },
};
const current = vi.fn(() => config);
let harness: ReturnType<typeof createHarness>;
const providerGates: ReturnType<typeof Promise.withResolvers<MediaResult>>[] = [];

function createHarness() {
  const methods = new Map<
    string,
    {
      handler: Parameters<OpenClawPluginApi["registerGatewayMethod"]>[1];
      options: Parameters<OpenClawPluginApi["registerGatewayMethod"]>[2];
    }
  >();
  const services: Parameters<OpenClawPluginApi["registerService"]>[0][] = [];
  const scheduler = createTestPluginServiceScheduler();
  const api = createTestPluginApi({
    runtime: { config: { current }, mediaUnderstanding: { runFile } } as unknown as Runtime,
    registerGatewayMethod(method, handler, options) {
      methods.set(method, { handler, options });
    },
    registerService(service) {
      services.push(service);
    },
  });
  plugin.register(api);
  const context = { config, stateDir: "/unused", logger: api.logger, scheduler };
  return {
    methods,
    async start() {
      for (const service of services) {
        await service.start(context);
      }
    },
    async stop() {
      scheduler.beginClose();
      for (const service of services) {
        await service.stop?.(context);
      }
      await scheduler.stop();
    },
    invoke(
      params: Record<string, unknown> = audio,
      overrides: Partial<GatewayRequestHandlerOptions> = {},
    ) {
      const registered = methods.get("kids.transcribe");
      if (!registered) {
        throw new Error("kids.transcribe missing");
      }
      const connection = new AbortController();
      const client: NonNullable<GatewayRequestHandlerOptions["client"]> = {
        connId: "test-connection",
        connectionSignal: connection.signal,
        connect: {
          minProtocol: 3,
          maxProtocol: 3,
          role: "operator",
          scopes: ["operator.talk"],
          client: { id: "openclaw-control-ui", version: "test", platform: "web", mode: "webchat" },
        },
      };
      const respond = vi.fn();
      const pending = Promise.resolve(
        registered.handler({
          req: { type: "req", id: "test", method: "kids.transcribe" },
          params,
          client,
          respond,
          context: {} as GatewayRequestHandlerOptions["context"],
          isWebchatConnect: () => true,
          hasCurrentClientAuthority: () => true,
          ...overrides,
        }),
      );
      return { pending, respond, connection, client };
    },
  };
}

function holdProvider() {
  const entered = Promise.withResolvers<string>();
  const result = Promise.withResolvers<MediaResult>();
  providerGates.push(result);
  runFile.mockImplementation(async ({ filePath }) => {
    entered.resolve(filePath);
    return result.promise;
  });
  return { entered: entered.promise, result };
}

beforeEach(async () => {
  runFile.mockReset().mockResolvedValue({ text: "My dictated question" });
  current.mockReset().mockReturnValue(config);
  harness = createHarness();
  await harness.start();
});

afterEach(async () => {
  for (const gate of providerGates.splice(0)) {
    gate.resolve({ text: "cleanup" });
  }
  await harness.stop();
});

describe("kids dictation Gateway boundary", () => {
  it.each(["audio/webm;codecs=opus", "audio/mp4", "audio/ogg"])(
    "transcribes %s privately through configured media understanding",
    async (mimeType) => {
      let recordingPath = "";
      runFile.mockImplementation(async (request) => {
        recordingPath = request.filePath;
        expect(await fs.readFile(recordingPath, "utf8")).toBe("recorded speech");
        expect((await fs.stat(recordingPath)).mode & 0o777).toBe(0o600);
        expect((await fs.stat(path.dirname(recordingPath))).mode & 0o777).toBe(0o700);
        expect(request).toMatchObject({
          capability: "audio",
          timeoutMs: 30_000,
          mime: mimeType.split(";")[0],
          cfg: config,
        });
        expect(request.cfg).not.toBe(config);
        return { text: "  My dictated question  " };
      });
      const { pending, respond } = harness.invoke({ ...audio, mimeType });
      await pending;
      expect(respond).toHaveBeenCalledExactlyOnceWith(true, { text: "My dictated question" });
      await expect(fs.stat(path.dirname(recordingPath))).rejects.toMatchObject({ code: "ENOENT" });
      expect(harness.methods.get("kids.transcribe")?.options).toEqual({
        scope: "operator.talk",
        profileAccess: "independent",
      });
    },
  );

  it.each([
    { name: "missing fields", params: {} },
    { name: "file path", params: { ...audio, filePath: "/private/file" } },
    { name: "session selection", params: { ...audio, sessionKey: "other-child" } },
    { name: "empty audio", params: { ...audio, audioBase64: "" } },
    { name: "invalid alphabet", params: { ...audio, audioBase64: "@@@=" } },
    { name: "noncanonical padding", params: { ...audio, audioBase64: "YR==" } },
    { name: "missing padding", params: { ...audio, audioBase64: "YQ" } },
    { name: "base64 whitespace", params: { ...audio, audioBase64: "YQ==\n" } },
    { name: "unsupported MIME", params: { ...audio, mimeType: "text/plain" } },
    {
      name: "oversized audio",
      params: { ...audio, audioBase64: Buffer.alloc(1024 * 1024 + 1).toString("base64") },
    },
  ])("rejects $name before provider admission", async ({ params }) => {
    const { pending, respond } = harness.invoke(params);
    await pending;
    expect(respond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({ code: "INVALID_REQUEST" }),
    );
    expect(runFile).not.toHaveBeenCalled();
  });

  it("accepts exactly the decoded byte ceiling", async () => {
    runFile.mockImplementation(async ({ filePath }) => {
      expect((await fs.stat(filePath)).size).toBe(1024 * 1024);
      return { text: "Within the limit" };
    });
    const { pending, respond } = harness.invoke({
      ...audio,
      audioBase64: Buffer.alloc(1024 * 1024).toString("base64"),
    });
    await pending;
    expect(respond).toHaveBeenCalledWith(true, { text: "Within the limit" });
  });

  it("requires an authenticated connection without adding broader scope requirements", async () => {
    const { pending, respond } = harness.invoke(audio, { client: null });
    await pending;
    expect(respond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({ code: "FORBIDDEN" }),
    );
    expect(runFile).not.toHaveBeenCalled();
  });

  it("refuses duplicate connection work while retaining bounded capacity", async () => {
    const held = holdProvider();
    const first = harness.invoke();
    await held.entered;
    const duplicate = harness.invoke();
    await duplicate.pending;
    expect(duplicate.respond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({ message: expect.stringContaining("busy") }),
    );
    const others = [1, 2, 3].map((id) =>
      harness.invoke(audio, { client: { ...first.client, connId: `connection-${id}` } }),
    );
    const overflow = harness.invoke(audio, { client: { ...first.client, connId: "overflow" } });
    await overflow.pending;
    expect(overflow.respond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({ message: expect.stringContaining("busy") }),
    );
    held.result.resolve({ text: "Done" });
    await Promise.all([first.pending, ...others.map(({ pending }) => pending)]);
    expect(runFile).toHaveBeenCalledTimes(4);
    const retry = harness.invoke();
    await retry.pending;
    expect(retry.respond).toHaveBeenCalledWith(true, { text: "Done" });
  });

  it.each(["disconnect", "revocation", "invocation cancellation"])(
    "fences %s before provider admission",
    async (reason) => {
      const lifetime = new AbortController();
      let currentAuthority = true;
      const { pending, respond, connection, client } = harness.invoke(audio, {
        signal: lifetime.signal,
        hasCurrentClientAuthority: () => currentAuthority,
      });
      current.mockImplementation(() => {
        if (reason === "disconnect") {
          connection.abort();
        }
        if (reason === "revocation") {
          currentAuthority = false;
          client.invalidated = true;
        }
        if (reason === "invocation cancellation") {
          lifetime.abort();
        }
        return config;
      });
      await pending;
      expect(runFile).not.toHaveBeenCalled();
      expect(respond).toHaveBeenCalledWith(
        false,
        undefined,
        expect.objectContaining({ code: "UNAVAILABLE" }),
      );
    },
  );

  it("keeps the recording until admitted work settles, then discards a disconnected result", async () => {
    const held = holdProvider();
    const request = harness.invoke();
    const filePath = await held.entered;
    request.connection.abort();
    expect(await fs.readFile(filePath, "utf8")).toBe("recorded speech");
    held.result.resolve({ text: "Must not reach the child" });
    await request.pending;
    expect(request.respond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({ code: "UNAVAILABLE" }),
    );
    await expect(fs.stat(path.dirname(filePath))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("closes admission and joins provider work and cleanup on shutdown", async () => {
    const held = holdProvider();
    const request = harness.invoke();
    const filePath = await held.entered;
    let stopped = false;
    const stop = harness.stop().then(() => {
      stopped = true;
    });
    const late = harness.invoke();
    await late.pending;
    expect(late.respond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({ message: expect.stringContaining("restarting") }),
    );
    expect(stopped).toBe(false);
    expect(await fs.readFile(filePath, "utf8")).toBe("recorded speech");
    held.result.resolve({ text: "Old generation" });
    await Promise.all([stop, request.pending]);
    expect(stopped).toBe(true);
    expect(request.respond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({ code: "UNAVAILABLE" }),
    );
    await expect(fs.stat(path.dirname(filePath))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it.each(["failure", "no speech"])(
    "cleans up after %s without leaking provider details",
    async (outcome) => {
      let filePath = "";
      runFile.mockImplementation(async (request) => {
        filePath = request.filePath;
        if (outcome === "failure") {
          throw new Error("private provider credentials and recording text");
        }
        return { text: undefined };
      });
      const { pending, respond } = harness.invoke();
      await pending;
      expect(respond).toHaveBeenCalledWith(
        false,
        undefined,
        expect.objectContaining({
          message: "Couldn't transcribe this recording. Please try again.",
        }),
      );
      await expect(fs.stat(path.dirname(filePath))).rejects.toMatchObject({ code: "ENOENT" });
    },
  );
});
