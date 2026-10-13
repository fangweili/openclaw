import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { tempWorkspace, type TempWorkspace } from "openclaw/plugin-sdk/temp-path";
import { createMockIncomingRequest, createMockServerResponse } from "openclaw/plugin-sdk/test-env";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createKidsUiHandler } from "./http.js";

describe("Kids Tutor static route", () => {
  let workspace: TempWorkspace;
  let assetsDir: string;
  let handler: ReturnType<typeof createKidsUiHandler>;

  beforeAll(async () => {
    workspace = await tempWorkspace({ rootDir: os.tmpdir(), prefix: "openclaw-kids-http-" });
    assetsDir = path.join(workspace.dir, "build");
    await fs.mkdir(path.join(assetsDir, "assets"), { recursive: true });
    await fs.writeFile(path.join(assetsDir, "index.html"), "<title>Rocky 🎓</title>");
    await fs.writeFile(
      path.join(assetsDir, "assets/chat-a1b2c3d4.js"),
      "export const app = 'Rocky';",
    );
    await fs.writeFile(
      path.join(assetsDir, "assets/chat-a1b2c3d4.css"),
      ".app { color: inherit; }",
    );
    await fs.writeFile(path.join(assetsDir, "manifest.webmanifest"), '{"name":"Rocky"}');
    await workspace.writeText("outside.js", "must stay private");
    await fs.symlink(path.join(workspace.dir, "outside.js"), path.join(assetsDir, "linked.js"));
    await fs.writeFile(path.join(assetsDir, "large.js"), "");
    await fs.truncate(path.join(assetsDir, "large.js"), 8 * 1024 * 1024 + 1);
    handler = createKidsUiHandler(assetsDir);
  });

  afterAll(async () => {
    await workspace?.cleanup();
  });

  async function request(url: string, method = "GET") {
    const req = createMockIncomingRequest([]);
    req.url = url;
    req.method = method;
    const res = createMockServerResponse();
    const handled = await handler(req, res);
    req.destroy();
    res.req.destroy();
    return { handled, res };
  }

  it("serves entry HTML without caching and preserves GET/HEAD length parity", async () => {
    const get = await request("/kids/");
    const head = await request("/kids/", "HEAD");
    expect(get.handled).toBe(true);
    expect(get.res.statusCode).toBe(200);
    expect(get.res.body?.toString()).toBe("<title>Rocky 🎓</title>");
    expect(get.res.getHeader("content-type")).toBe("text/html; charset=utf-8");
    expect(get.res.getHeader("cache-control")).toBe("no-store");
    expect(get.res.getHeader("x-content-type-options")).toBe("nosniff");
    expect(get.res.getHeader("content-length")).toBe(String(Buffer.byteLength(get.res.body!)));
    expect(head.res.getHeader("content-length")).toBe(get.res.getHeader("content-length"));
    expect(head.res.body).toBeUndefined();
  });

  it("serves build assets with the correct MIME and caches only hashed assets", async () => {
    const js = await request("/kids/assets/chat-a1b2c3d4.js?v=1");
    const css = await request("/kids/assets/chat-a1b2c3d4.css");
    const manifest = await request("/kids/manifest.webmanifest");
    expect(js.res.getHeader("content-type")).toBe("text/javascript; charset=utf-8");
    expect(css.res.getHeader("content-type")).toBe("text/css; charset=utf-8");
    expect(js.res.getHeader("cache-control")).toBe("public, max-age=31536000, immutable");
    expect(manifest.res.getHeader("content-type")).toBe("application/manifest+json; charset=utf-8");
    expect(manifest.res.getHeader("cache-control")).toBe("no-store");
  });

  it("keeps unrelated routes untouched and redirects the base to its canonical directory", async () => {
    expect((await request("/chat")).handled).toBe(false);
    expect((await request("/kids-other")).handled).toBe(false);
    const redirect = await request("/kids?source=home");
    expect(redirect.res.statusCode).toBe(308);
    expect(redirect.res.getHeader("location")).toBe("/kids/?source=home");
  });

  it.each([
    "/kids/%2e%2e%2foutside.js",
    "/kids/%2foutside.js",
    "/kids/linked.js",
    "/kids/large.js",
    "/kids/assets/missing.js",
    "/kids/assets/chat-a1b2c3d4.js.map",
    "/kids/package.json",
    "/kids/src/index.ts",
    "/kids/private.html",
    "/kids/assets/",
  ])("refuses unsafe, missing, oversized, or non-web asset %s", async (url) => {
    const { res } = await request(url);
    expect(res.statusCode).toBe(404);
    expect(res.body).toBe("Asset not found");
  });

  it("rejects malformed escaping and mutations", async () => {
    expect((await request("/kids/%xx.js")).res.statusCode).toBe(400);
    const { res } = await request("/kids/", "POST");
    expect(res.statusCode).toBe(405);
    expect(res.getHeader("allow")).toBe("GET, HEAD");
  });

  it("reports absent builds and recovers when their entry is installed", async () => {
    const recover = createKidsUiHandler(path.join(workspace.dir, "later"));
    const req = createMockIncomingRequest([]);
    req.url = "/kids/";
    req.method = "GET";
    const first = createMockServerResponse();
    await recover(req, first);
    expect(first.statusCode).toBe(503);
    await fs.mkdir(path.join(workspace.dir, "later"));
    await fs.writeFile(path.join(workspace.dir, "later/index.html"), "ready");
    const next = createMockServerResponse();
    await recover(req, next);
    expect(next.statusCode).toBe(200);
    expect(next.body?.toString()).toBe("ready");
    req.destroy();
    first.req.destroy();
    next.req.destroy();
  });
});
