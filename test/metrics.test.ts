import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { handleMcpHttp } from "../src/http/handler.js";
import {
  buildGaPayloads,
  flushAnalytics,
  gaSessionNumber,
  newRequestContext,
  parseSessionId,
  runWithContext,
  SESSION_ID_RE,
  trackEvent,
} from "../src/metrics.js";

// Free text the attendee types. None of it may ever appear in GA payloads or log lines.
const SECRET = "Zorblax-Quantum-Pickle";

let server: Server;
let base: string;
const realFetch = globalThis.fetch;
let gaCalls: { url: string; body: { client_id: string; events: { name: string; params: Record<string, unknown> }[] } }[];
let gaResponse: () => Promise<Response>;
let logLines: string[];

beforeAll(async () => {
  server = createServer((req, res) => void handleMcpHttp(req, res));
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => new Promise<void>((r) => server.close(() => r())));

beforeEach(() => {
  gaCalls = [];
  logLines = [];
  gaResponse = async () => new Response(null, { status: 204 });
  process.env.GA_MEASUREMENT_ID = "G-TEST1234";
  process.env.GA_API_SECRET = "test_secret_value";
  process.env.METRICS_LOG = "on";
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url.startsWith("https://www.google-analytics.com/")) {
      gaCalls.push({ url, body: JSON.parse(String(init?.body)) });
      return gaResponse();
    }
    return realFetch(input, init);
  });
  vi.spyOn(console, "log").mockImplementation((line: unknown) => void logLines.push(String(line)));
});

afterEach(() => {
  vi.restoreAllMocks();
  delete process.env.GA_MEASUREMENT_ID;
  delete process.env.GA_API_SECRET;
  process.env.METRICS_LOG = "off";
});

const baseHeaders = { "content-type": "application/json", accept: "application/json, text/event-stream" };
let nextId = 1;

async function call(method: string, params: unknown, headers: Record<string, string> = {}) {
  const res = await fetch(`${base}/mcp`, {
    method: "POST",
    headers: { ...baseHeaders, ...headers },
    body: JSON.stringify({ jsonrpc: "2.0", id: nextId++, method, params }),
  });
  const body = await res.json();
  await flushAnalytics();
  return { res, body };
}

async function initialize() {
  const { res } = await call("initialize", {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "claude-ai", version: "0.1.0" },
  });
  return res.headers.get("mcp-session-id")!;
}

const tool = (name: string, args: unknown, sessionId?: string) =>
  call("tools/call", { name, arguments: args }, sessionId ? { "mcp-session-id": sessionId } : {});

const events = () => gaCalls.flatMap((c) => c.body.events.map((e) => ({ ...e, client_id: c.body.client_id })));

describe("session id", () => {
  it("is issued on initialize and exposed to allowlisted browser origins", async () => {
    const id = await initialize();
    expect(id).toMatch(SESSION_ID_RE);

    process.env.ALLOWED_ORIGINS = "https://good.example";
    try {
      const { res } = await call("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "x", version: "1" } }, { origin: "https://good.example" });
      expect(res.headers.get("access-control-expose-headers")).toContain("Mcp-Session-Id");
    } finally {
      delete process.env.ALLOWED_ORIGINS;
    }
  });

  it("only accepts well-formed UUIDs from clients", () => {
    expect(parseSessionId("8c4f0a5e-3b1d-4c2e-9f6a-1b2c3d4e5f60")).toBe("8c4f0a5e-3b1d-4c2e-9f6a-1b2c3d4e5f60");
    expect(parseSessionId("not-a-uuid")).toBeUndefined();
    expect(parseSessionId("<script>")).toBeUndefined();
    expect(parseSessionId(undefined)).toBeUndefined();
  });

  it("never rejects a request because of the session header (server stays stateless)", async () => {
    const { res, body } = await tool("get_conference_info", {}, "garbage");
    expect(res.status).toBe(200);
    expect(body.result.isError).toBeUndefined();
    const unknown = await tool("get_conference_info", {}, "8c4f0a5e-3b1d-4c2e-9f6a-1b2c3d4e5f60");
    expect(unknown.res.status).toBe(200);
  });
});

describe("Google Analytics", () => {
  it("groups a whole conversation under one client_id and session", async () => {
    const sid = await initialize();
    await tool("recommend_sessions", { interests: `LLM agents ${SECRET}` }, sid);
    const sched = await tool("build_schedule", { mustSee: ["1273185"], interests: SECRET }, sid);
    const ids = JSON.parse(sched.body.result.content[0].text).sessionIds as string[];
    await tool("export_calendar", { sessionIds: ids.slice(0, 3) }, sid);

    const all = events();
    expect(new Set(all.map((e) => e.client_id))).toEqual(new Set([sid]));
    expect(new Set(all.map((e) => e.params.session_id))).toEqual(new Set([gaSessionNumber(sid)]));
    const names = all.map((e) => e.name);
    expect(names[0]).toBe("client_connected");
    expect(names).toEqual(expect.arrayContaining(["tool_call", "schedule_built", "calendar_exported", "session_selected"]));

    const connected = all.find((e) => e.name === "client_connected")!;
    expect(connected.params).toMatchObject({ client_name: "claude-ai", client_version: "0.1.0", session_tracked: "true" });

    const exported = all.filter((e) => e.name === "session_selected" && e.params.source === "export_calendar");
    expect(exported.map((e) => e.params.talk_id)).toEqual(ids.slice(0, 3));
    const mustSee = all.filter((e) => e.name === "session_selected" && e.params.source === "must_see");
    expect(mustSee.map((e) => e.params.talk_id)).toEqual(["1273185"]);

    for (const c of gaCalls) {
      expect(c.url).toMatch(/^https:\/\/www\.google-analytics\.com\/mp\/collect\?measurement_id=G-TEST1234&api_secret=/);
      for (const e of c.body.events) expect(Number(e.params.engagement_time_msec)).toBeGreaterThan(0);
    }
  });

  it("never sends free text, IPs or unknown values", async () => {
    const sid = await initialize();
    await tool("search_sessions", { query: SECRET, tracks: [SECRET], day: SECRET }, sid);
    await tool("search_sessions", { query: SECRET, tracks: ["AI/ML"] }, sid);
    await tool("recommend_sessions", { interests: SECRET, role: SECRET, avoid: SECRET }, sid);
    await tool("find_speakers", { name: SECRET, query: SECRET }, sid);
    await tool("get_sessions", { ids: ["99999999"] }, sid);
    await call("prompts/get", { name: "plan_my_reversim", arguments: { about_me: SECRET } }, { "mcp-session-id": sid });

    const payloads = JSON.stringify(gaCalls);
    expect(payloads).not.toContain(SECRET);
    expect(payloads).not.toContain("127.0.0.1");
    expect(payloads).not.toContain("99999999");
    expect(logLines.join("\n")).not.toContain(SECRET);
    expect(logLines.join("\n")).not.toContain("127.0.0.1");

    const noResults = events().filter((e) => e.name === "search_no_results");
    expect(noResults.length).toBeGreaterThan(0);
    // An unknown day is a user error, a known track is passed through.
    expect(events().some((e) => e.name === "tool_call" && e.params.outcome === "user_error")).toBe(true);
    expect(events().some((e) => e.params.track === "AI/ML")).toBe(true);
    expect(events().some((e) => e.name === "prompt_used" && e.params.has_about_me === "true")).toBe(true);
  });

  it("marks requests without a session header as untracked, with a fresh client_id each time", async () => {
    await tool("get_conference_info", {});
    await tool("get_conference_info", {});
    const all = events();
    expect(all).toHaveLength(2);
    expect(all[0].client_id).not.toBe(all[1].client_id);
    expect(all.every((e) => e.params.session_tracked === "false")).toBe(true);
  });

  it("sends nothing when GA is not configured, or misconfigured", async () => {
    delete process.env.GA_API_SECRET;
    await initialize();
    await tool("get_conference_info", {});
    process.env.GA_API_SECRET = "bad secret with spaces";
    vi.spyOn(console, "error").mockImplementation(() => {});
    await tool("get_conference_info", {});
    expect(gaCalls).toHaveLength(0);
  });

  it("GA failures never affect the response", async () => {
    gaResponse = async () => {
      throw new Error("network down");
    };
    const { res, body } = await tool("get_conference_info", {});
    expect(res.status).toBe(200);
    expect(body.result.isError).toBeUndefined();
    expect(logLines.some((l) => JSON.parse(l).type === "ga_error")).toBe(true);
  });

  it("splits large batches into GA's 25-events-per-request limit", () => {
    const ctx = newRequestContext();
    runWithContext(ctx, () => {
      for (let i = 0; i < 60; i++) trackEvent("session_selected", { talk_id: String(i), session_id: "spoofed" });
      trackEvent("Bad-Name", {}); // invalid names are dropped
      trackEvent("x", { long: "y".repeat(500), "bad key": "z" });
    });
    const payloads = buildGaPayloads(ctx, 12) as { events: { params: Record<string, unknown> }[] }[];
    expect(payloads.map((p) => p.events.length)).toEqual([25, 25, 11]);
    const last = payloads[2].events.at(-1)!;
    expect(String(last.params.long)).toHaveLength(100);
    expect(last.params).not.toHaveProperty("bad key");
    // Reserved GA params can't be overridden by event params.
    expect(payloads[0].events[0].params.session_id).toBe(gaSessionNumber(ctx.sessionId));
  });
});

describe("health log", () => {
  it("writes one JSON line per request with status, method, tool and outcome", async () => {
    const sid = await initialize();
    await tool("search_sessions", { query: "kubernetes" }, sid);
    await fetch(`${base}/nope`, { method: "POST", headers: baseHeaders, body: "{}" });
    await flushAnalytics();

    const lines = logLines.map((l) => JSON.parse(l)).filter((l) => l.type === "request");
    expect(lines).toHaveLength(3);
    expect(lines[0]).toMatchObject({ method: "initialize", status: 200, session: sid, client_name: "claude-ai" });
    expect(lines[1]).toMatchObject({
      method: "tools/call",
      tool: "search_sessions",
      outcome: "ok",
      data_source: "snapshot",
      status: 200,
      session: sid,
    });
    expect(lines[1].duration_ms).toBeGreaterThanOrEqual(0);
    expect(lines[2]).toMatchObject({ status: 404, session_tracked: false });
    expect(lines[2]).not.toHaveProperty("session");
  });

  it("can be turned off", async () => {
    process.env.METRICS_LOG = "off";
    await tool("get_conference_info", {});
    expect(logLines).toHaveLength(0);
  });
});
