import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { cleanText, safeHttpUrl, safePhotoUrl, validateFeeds } from "../src/data/validate.js";
import { handleMcpHttp, MAX_BODY_BYTES } from "../src/http/handler.js";
import { RateLimiter } from "../src/http/rateLimit.js";

process.env.REVERSIM_OFFLINE = "1";

let server: Server;
let base: string;

beforeAll(async () => {
  server = createServer((req, res) => void handleMcpHttp(req, res));
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => new Promise<void>((r) => server.close(() => r())));

const headers = { "content-type": "application/json", accept: "application/json, text/event-stream" };
const rpc = (method: string, params?: unknown) => JSON.stringify({ jsonrpc: "2.0", id: 1, method, params });

async function post(body: string, extra: Record<string, string> = {}, path = "/mcp") {
  return fetch(`${base}${path}`, { method: "POST", headers: { ...headers, ...extra }, body });
}

describe("HTTP surface", () => {
  it("serves MCP on POST /mcp with security headers", async () => {
    const res = await post(rpc("tools/list"));
    expect(res.status).toBe(200);
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.headers.get("access-control-allow-origin")).toBeNull();
    const body = await res.json();
    const names = body.result.tools.map((t: { name: string }) => t.name);
    expect(names).toEqual(
      expect.arrayContaining(["search_sessions", "recommend_sessions", "build_schedule", "export_calendar"]),
    );
  });

  it("every tool is read-only", async () => {
    const body = await (await post(rpc("tools/list"))).json();
    for (const t of body.result.tools) expect(t.annotations?.readOnlyHint).toBe(true);
  });

  it("rejects other paths, methods, content types, batches and oversized bodies", async () => {
    expect((await post(rpc("tools/list"), {}, "/admin")).status).toBe(404);
    expect((await fetch(`${base}/mcp`)).status).toBe(405);
    expect((await fetch(`${base}/mcp`, { method: "DELETE" })).status).toBe(405);
    expect((await post(rpc("tools/list"), { "content-type": "text/plain" })).status).toBe(415);
    expect((await post("not json")).status).toBe(400);
    expect((await post(`[${rpc("tools/list")}]`)).status).toBe(400);
    expect((await post("x".repeat(MAX_BODY_BYTES + 1))).status).toBe(413);
  });

  it("rejects browser origins that are not allowlisted", async () => {
    expect((await post(rpc("tools/list"), { origin: "https://evil.example" })).status).toBe(403);
    process.env.ALLOWED_ORIGINS = "https://good.example";
    const ok = await post(rpc("tools/list"), { origin: "https://good.example" });
    expect(ok.status).toBe(200);
    expect(ok.headers.get("access-control-allow-origin")).toBe("https://good.example");
    delete process.env.ALLOWED_ORIGINS;
  });

  it("requires the bearer token when MCP_AUTH_TOKEN is set", async () => {
    process.env.MCP_AUTH_TOKEN = "correct-horse";
    try {
      expect((await post(rpc("tools/list"))).status).toBe(401);
      expect((await post(rpc("tools/list"), { authorization: "Bearer wrong" })).status).toBe(401);
      expect((await post(rpc("tools/list"), { authorization: "Bearer correct-horse" })).status).toBe(200);
    } finally {
      delete process.env.MCP_AUTH_TOKEN;
    }
  });

  it("validates tool input and does not leak internals", async () => {
    const res = await post(rpc("tools/call", { name: "get_sessions", arguments: { ids: ["../../etc/passwd"] } }));
    const body = await res.json();
    expect(body.result.isError).toBe(true);
    expect(JSON.stringify(body)).not.toMatch(/at .*\.ts:\d+/); // no stack traces
    const long = await post(rpc("tools/call", { name: "search_sessions", arguments: { query: "a".repeat(5000) } }));
    expect((await long.json()).result.isError).toBe(true);
  });
});

describe("rate limiter", () => {
  it("blocks after the limit and resets after the window", () => {
    const rl = new RateLimiter(2, 1000);
    expect(rl.hit("ip", 0).allowed).toBe(true);
    expect(rl.hit("ip", 1).allowed).toBe(true);
    expect(rl.hit("ip", 2).allowed).toBe(false);
    expect(rl.hit("other", 2).allowed).toBe(true);
    expect(rl.hit("ip", 1001).allowed).toBe(true);
  });
});

describe("upstream data allowlist", () => {
  const feed = {
    grid: [
      {
        date: "2026-11-30T00:00:00",
        secret: "x",
        rooms: [
          {
            id: 1,
            name: "Main hall",
            sessions: [
              {
                id: "1",
                title: "T",
                description: null,
                startsAt: "2026-11-30T10:00:00",
                endsAt: "2026-11-30T10:30:00",
                isServiceSession: false,
                isPlenumSession: false,
                speakers: [{ id: "s", name: "N", email: "private@example.com" }],
                categories: [],
                roomId: 1,
                room: "Main hall",
                questionAnswers: [{ question: "Phone", answer: "050-0000000" }],
              },
            ],
          },
        ],
      },
    ],
    speakers: [],
  };

  it("drops fields we do not intend to expose", () => {
    const out = JSON.stringify(validateFeeds(feed));
    expect(out).not.toContain("private@example.com");
    expect(out).not.toContain("050-0000000");
    expect(out).not.toContain("secret");
  });

  it("rejects malformed payloads", () => {
    expect(() => validateFeeds({ grid: [], speakers: [] })).toThrow();
    expect(() => validateFeeds({ grid: "nope", speakers: [] })).toThrow();
  });

  it("only passes safe links and photos", () => {
    expect(safeHttpUrl("javascript:alert(1)")).toBeUndefined();
    expect(safeHttpUrl("data:text/html,hi")).toBeUndefined();
    expect(safeHttpUrl("https://linkedin.com/in/x")).toBe("https://linkedin.com/in/x");
    expect(safePhotoUrl("https://evil.example/a.jpg")).toBeUndefined();
    expect(safePhotoUrl("https://cdn.sessionize.com/image/a.jpg")).toBe("https://cdn.sessionize.com/image/a.jpg");
  });

  it("strips control and bidi-override characters", () => {
    expect(cleanText("a‮b\u0007c\r\nd")).toBe("abc\nd");
  });
});
