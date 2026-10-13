/**
 * Owns static /kids assets only. The plugin registry owns route lifetime; each
 * request owns a bounded read that closes its file before responding. There is
 * no session state, background work, credential handling, or Gateway authority.
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import path from "node:path";
import { root } from "openclaw/plugin-sdk/file-access-runtime";
import type { OpenClawPluginHttpRouteHandler } from "openclaw/plugin-sdk/plugin-entry";

const MAX_ASSET_BYTES = 8 * 1024 * 1024;
const MIME_TYPES: Readonly<Record<string, string>> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".webmanifest": "application/manifest+json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".webp": "image/webp",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".woff2": "font/woff2",
};

/**
 * Serve one trusted build directory beneath /kids/. Calls are independent and
 * may overlap; the SDK owns containment and file-handle cleanup. No writes or
 * persistent resources occur. Unreadable entry HTML returns 503 (build required);
 * missing, disallowed, oversized, or unsafe assets return 404. GET/HEAD only.
 */
export function createKidsUiHandler(assetsDir: string): OpenClawPluginHttpRouteHandler {
  return async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    if (url.pathname !== "/kids" && !url.pathname.startsWith("/kids/")) {
      return false;
    }
    if (req.method !== "GET" && req.method !== "HEAD") {
      res.setHeader("allow", "GET, HEAD");
      respond(req, res, 405, "text/plain; charset=utf-8", "Method not allowed");
      return true;
    }
    if (url.pathname === "/kids") {
      res.setHeader("location", `/kids/${url.search}`);
      respond(req, res, 308, "text/plain; charset=utf-8", "");
      return true;
    }
    let asset: string;
    try {
      asset = decodeURIComponent(url.pathname.slice("/kids/".length)) || "index.html";
    } catch {
      respond(req, res, 400, "text/plain; charset=utf-8", "Invalid asset path");
      return true;
    }
    const contentType = MIME_TYPES[path.extname(asset)];
    if (!contentType || (path.extname(asset) === ".html" && asset !== "index.html")) {
      respond(req, res, 404, "text/plain; charset=utf-8", "Asset not found");
      return true;
    }
    let body: Buffer;
    try {
      const directory = await root(assetsDir);
      ({ buffer: body } = await directory.read(asset, { maxBytes: MAX_ASSET_BYTES }));
    } catch {
      const entry = asset === "index.html";
      respond(
        req,
        res,
        entry ? 503 : 404,
        "text/plain; charset=utf-8",
        entry ? "Kids Tutor is unavailable. Build and install the app assets." : "Asset not found",
      );
      return true;
    }
    const immutable = /^assets\/[^/]+-[\w-]{8,}\.[\w]+$/.test(asset);
    respond(req, res, 200, contentType, body, immutable);
    return true;
  };
}

function respond(
  req: IncomingMessage,
  res: ServerResponse,
  status: number,
  contentType: string,
  body: string | Buffer,
  immutable = false,
): void {
  res.statusCode = status;
  res.setHeader("content-type", contentType);
  res.setHeader("content-length", String(Buffer.byteLength(body)));
  res.setHeader("cache-control", immutable ? "public, max-age=31536000, immutable" : "no-store");
  res.setHeader("x-content-type-options", "nosniff");
  res.setHeader("referrer-policy", "no-referrer");
  res.setHeader("x-robots-tag", "noindex");
  if (contentType.startsWith("text/html")) {
    res.setHeader(
      "content-security-policy",
      "frame-ancestors 'none'; base-uri 'self'; object-src 'none'",
    );
  }
  res.end(req.method === "HEAD" ? undefined : body);
}
