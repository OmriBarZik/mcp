import { createHash, timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import {
  annotateRequest,
  cleanClientField,
  finishRequest,
  newRequestContext,
  newSessionId,
  parseSessionId,
  runWithContext,
  trackEvent,
  type RequestContext,
} from "../metrics.js";
import { createServer } from "../server.js";
import { RateLimiter } from "./rateLimit.js";

/**
 * Hardened HTTP entry point, shared by the Vercel function and the local dev server.
 *
 * - Only `POST /mcp` with a JSON body is accepted. Everything else gets 404/405/415.
 * - Request bodies are capped (MAX_BODY_BYTES) and read before any MCP parsing.
 * - Stateless: no sessions, no SSE streams, nothing kept between requests.
 * - Optional bearer token (MCP_AUTH_TOKEN), checked in constant time.
 * - Browser `Origin` headers must be on an allowlist (DNS-rebinding / CSRF protection).
 * - Per-IP rate limiting (best effort per instance; pair it with a Vercel Firewall rule).
 * - Strict security headers and no CORS unless an origin is allowlisted.
 * - Analytics session id: issued as `Mcp-Session-Id` on initialize and read back on later
 *   requests. The server keeps no session state; the id is only used to group metrics.
 */

export const MAX_BODY_BYTES = 32 * 1024;

const limiter = new RateLimiter(
  Number(process.env.RATE_LIMIT_PER_MINUTE) > 0 ? Number(process.env.RATE_LIMIT_PER_MINUTE) : 60,
  60_000,
);

function allowedOrigins(): Set<string> {
  return new Set(
    (process.env.ALLOWED_ORIGINS ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
  );
}

const SECURITY_HEADERS: Record<string, string> = {
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
  "Content-Security-Policy": "default-src 'none'; frame-ancestors 'none'",
  "Referrer-Policy": "no-referrer",
  "Cache-Control": "no-store",
  "Cross-Origin-Resource-Policy": "same-origin",
  "Strict-Transport-Security": "max-age=63072000; includeSubDomains",
};

function applySecurityHeaders(res: ServerResponse): void {
  for (const [k, v] of Object.entries(SECURITY_HEADERS)) res.setHeader(k, v);
  res.removeHeader("X-Powered-By");
}

function sendJson(res: ServerResponse, status: number, message: string, extra: Record<string, string> = {}): void {
  if (res.headersSent) return;
  for (const [k, v] of Object.entries(extra)) res.setHeader(k, v);
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json");
  // JSON-RPC shaped error so MCP clients can display it.
  res.end(JSON.stringify({ jsonrpc: "2.0", error: { code: -32000, message }, id: null }));
}

function clientIp(req: IncomingMessage): string {
  // On Vercel, x-forwarded-for is set by the platform edge (client-supplied values are overwritten).
  const fwd = req.headers["x-forwarded-for"];
  const first = (Array.isArray(fwd) ? fwd[0] : fwd)?.split(",")[0]?.trim();
  return first || req.socket?.remoteAddress || "unknown";
}

function sha256(s: string): Buffer {
  return createHash("sha256").update(s).digest();
}

function isAuthorized(req: IncomingMessage): boolean {
  const token = process.env.MCP_AUTH_TOKEN;
  if (!token) return true; // public mode (default): the data is public anyway
  const header = req.headers.authorization ?? "";
  const match = /^Bearer\s+(.+)$/i.exec(header);
  if (!match) return false;
  // Hash both sides so lengths match and comparison is constant-time.
  return timingSafeEqual(sha256(match[1].trim()), sha256(token));
}

async function readBody(req: IncomingMessage): Promise<string> {
  const declared = Number(req.headers["content-length"] ?? 0);
  if (declared > MAX_BODY_BYTES) throw new HttpError(413, "Request body too large");
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const buf = typeof chunk === "string" ? Buffer.from(chunk) : (chunk as Buffer);
    total += buf.length;
    if (total > MAX_BODY_BYTES) throw new HttpError(413, "Request body too large");
    chunks.push(buf);
  }
  return Buffer.concat(chunks).toString("utf8");
}

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

/** MCP method names are short identifiers; anything else is logged as "other". */
function methodName(body: object): string | undefined {
  const m = (body as { method?: unknown }).method;
  if (typeof m !== "string") return undefined;
  return /^[a-z][a-zA-Z/_]{0,60}$/.test(m) ? m : "other";
}

/**
 * Sets the conversation id used for metrics. A fresh one is issued on `initialize`
 * (clients echo it back as Mcp-Session-Id per the MCP spec); later requests reuse the
 * client's id if it is a well-formed UUID. Nothing is stored or validated server-side.
 */
function assignSession(ctx: RequestContext, req: IncomingMessage, res: ServerResponse, body: object, method?: string): void {
  if (method === "initialize") {
    ctx.sessionId = newSessionId();
    ctx.sessionTracked = true;
    res.setHeader("Mcp-Session-Id", ctx.sessionId);
    const params = (body as { params?: { clientInfo?: { name?: unknown; version?: unknown }; protocolVersion?: unknown } })
      .params;
    const client = cleanClientField(params?.clientInfo?.name);
    const fields = {
      client_name: client ?? "unknown",
      client_version: cleanClientField(params?.clientInfo?.version),
      protocol_version: cleanClientField(params?.protocolVersion),
    };
    annotateRequest(fields);
    trackEvent("client_connected", fields);
    return;
  }
  const fromClient = parseSessionId(req.headers["mcp-session-id"]);
  if (fromClient) {
    ctx.sessionId = fromClient;
    ctx.sessionTracked = true;
  }
}

export async function handleMcpHttp(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const ctx = newRequestContext();
  const started = performance.now();
  try {
    await runWithContext(ctx, () => handle(req, res, ctx));
  } finally {
    finishRequest(ctx, res.statusCode, performance.now() - started);
  }
}

async function handle(req: IncomingMessage, res: ServerResponse, ctx: RequestContext): Promise<void> {
  applySecurityHeaders(res);

  try {
    const path = (req.url ?? "/").split("?")[0].replace(/\/+$/, "") || "/";
    if (path !== "/mcp" && path !== "/api/mcp") return sendJson(res, 404, "Not found");

    // Origin check (browsers only send Origin; server-side MCP clients typically don't).
    const origin = req.headers.origin;
    if (origin) {
      if (!allowedOrigins().has(origin)) return sendJson(res, 403, "Origin not allowed");
      res.setHeader("Access-Control-Allow-Origin", origin);
      res.setHeader("Vary", "Origin");
      res.setHeader("Access-Control-Allow-Methods", "POST");
      res.setHeader(
        "Access-Control-Allow-Headers",
        "Content-Type, Authorization, Mcp-Protocol-Version, Mcp-Session-Id",
      );
      res.setHeader("Access-Control-Expose-Headers", "Mcp-Session-Id");
      res.setHeader("Access-Control-Max-Age", "600");
      if (req.method === "OPTIONS") {
        res.statusCode = 204;
        res.end();
        return;
      }
    }

    // Stateless server: no SSE stream (GET) and no sessions to delete (DELETE).
    if (req.method !== "POST") return sendJson(res, 405, "Method not allowed", { Allow: "POST" });

    const limit = limiter.hit(clientIp(req));
    res.setHeader("RateLimit-Limit", String(limit.limit));
    res.setHeader("RateLimit-Remaining", String(limit.remaining));
    if (!limit.allowed) {
      return sendJson(res, 429, "Too many requests", { "Retry-After": String(limit.retryAfterSeconds) });
    }

    if (!isAuthorized(req)) {
      return sendJson(res, 401, "Unauthorized", { "WWW-Authenticate": 'Bearer realm="reversim-mcp"' });
    }

    const contentType = String(req.headers["content-type"] ?? "");
    if (!contentType.toLowerCase().startsWith("application/json")) {
      return sendJson(res, 415, "Content-Type must be application/json");
    }

    const raw = await readBody(req);
    let body: unknown;
    try {
      body = JSON.parse(raw);
    } catch {
      return sendJson(res, 400, "Invalid JSON");
    }
    // One JSON-RPC message per request; batches are not supported.
    if (Array.isArray(body) || typeof body !== "object" || body === null) {
      return sendJson(res, 400, "Expected a single JSON-RPC message");
    }

    const method = methodName(body);
    annotateRequest({ method });
    assignSession(ctx, req, res, body, method);

    const server = createServer();
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined, // stateless
      enableJsonResponse: true, // plain JSON responses, no long-lived streams
    });
    res.on("close", () => {
      void transport.close();
      void server.close();
    });
    await server.connect(transport);
    await transport.handleRequest(req, res, body);
  } catch (err) {
    if (err instanceof HttpError) return sendJson(res, err.status, err.message);
    annotateRequest({ outcome: "internal_error" });
    console.error("[reversim-mcp] request failed:", err instanceof Error ? err.message : "unknown error");
    sendJson(res, 500, "Internal server error");
  }
}
