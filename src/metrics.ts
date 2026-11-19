import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import { waitUntil } from "@vercel/functions";
import { GA_COLLECT_URL, GA_DEBUG_URL, GA_TIMEOUT_MS } from "./config.js";

/**
 * Metrics and usage analytics.
 *
 * Two outputs, both built from the same per-request context:
 *
 * 1. Health: one structured JSON line per HTTP request on stdout (Vercel logs / log drains):
 *    status, duration, MCP method, tool, outcome, data source. Disable with METRICS_LOG=off.
 * 2. Usage: Google Analytics 4 events via the Measurement Protocol, sent after the response
 *    with `waitUntil` so they never slow a reply. Only enabled when GA_MEASUREMENT_ID and
 *    GA_API_SECRET are set.
 *
 * Privacy rules (enforced here and tested in test/metrics.test.ts):
 * - No free text the attendee typed (interests, queries, names) ever leaves the process,
 *   only its length or whether it was present.
 * - No IP addresses, user agents or auth headers.
 * - Session ids are random UUIDs issued by this server; they identify a conversation, not a person.
 * - Only values that come from the public agenda (session ids, track names) or from fixed
 *   vocabularies (tool names, outcomes) are sent as-is.
 */

export type ParamValue = string | number | boolean;
export type Params = Record<string, ParamValue | undefined>;

interface AnalyticsEvent {
  name: string;
  params: Record<string, string | number>;
}

export interface RequestContext {
  requestId: string;
  /** Conversation id (Mcp-Session-Id). Random per request when the client did not send one. */
  sessionId: string;
  /** True when the id came from the client's Mcp-Session-Id header or was issued on initialize. */
  sessionTracked: boolean;
  events: AnalyticsEvent[];
  /** Extra fields for this request's health log line. */
  log: Record<string, ParamValue>;
}

const storage = new AsyncLocalStorage<RequestContext>();

export const SESSION_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export function newSessionId(): string {
  return randomUUID();
}

/** Returns the session id from a client header if it is one we could have issued, else undefined. */
export function parseSessionId(header: string | string[] | undefined): string | undefined {
  const v = (Array.isArray(header) ? header[0] : header)?.trim().toLowerCase();
  return v && SESSION_ID_RE.test(v) ? v : undefined;
}

export function newRequestContext(): RequestContext {
  return { requestId: randomUUID(), sessionId: randomUUID(), sessionTracked: false, events: [], log: {} };
}

export function runWithContext<T>(ctx: RequestContext, fn: () => T): T {
  return storage.run(ctx, fn);
}

export function currentContext(): RequestContext | undefined {
  return storage.getStore();
}

// ---------------------------------------------------------------------------
// GA4 limits: https://developers.google.com/analytics/devguides/collection/protocol/ga4/sending-events
const MAX_EVENTS_PER_POST = 25;
const MAX_PARAMS_PER_EVENT = 25;
const MAX_PARAM_VALUE = 100;
const MAX_EVENTS_PER_REQUEST = 100;
const NAME_RE = /^[a-z][a-z0-9_]{0,39}$/;
/** Names GA reserves (or that we set ourselves per event). */
const RESERVED_PARAM_RE = /^(?:session_id|engagement_time_msec|session_tracked|(?:google|ga|firebase)_.*)$/;

function cleanValue(v: ParamValue): string | number {
  if (typeof v === "number") return Number.isFinite(v) ? v : 0;
  if (typeof v === "boolean") return v ? "true" : "false";
  // Control characters out, GA's value length limit enforced.
  return v.replace(/[\u0000-\u001f\u007f]/g, "").slice(0, MAX_PARAM_VALUE);
}

function cleanParams(params: Params): Record<string, string | number> {
  const out: Record<string, string | number> = {};
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || !NAME_RE.test(k) || RESERVED_PARAM_RE.test(k)) continue;
    if (Object.keys(out).length >= MAX_PARAMS_PER_EVENT - 3) break; // room for session params
    out[k] = cleanValue(v);
  }
  return out;
}

/** Queue a GA event for the current request. No-op outside a request. */
export function trackEvent(name: string, params: Params = {}): void {
  const ctx = currentContext();
  if (!ctx || !NAME_RE.test(name) || ctx.events.length >= MAX_EVENTS_PER_REQUEST) return;
  ctx.events.push({ name, params: cleanParams(params) });
}

/** Add fields to the current request's health log line. */
export function annotateRequest(fields: Params): void {
  const ctx = currentContext();
  if (!ctx) return;
  for (const [k, v] of Object.entries(fields)) if (v !== undefined) ctx.log[k] = v;
}

/** Writes one structured JSON log line (health metrics). */
export function logMetric(type: string, fields: Params): void {
  if (process.env.METRICS_LOG === "off") return;
  const line: Record<string, ParamValue> = { type, ts: new Date().toISOString() };
  for (const [k, v] of Object.entries(fields)) if (v !== undefined) line[k] = v;
  console.log(JSON.stringify(line));
}

// ---------------------------------------------------------------------------
interface GaConfig {
  measurementId: string;
  apiSecret: string;
  debug: boolean;
}

let warnedInvalidConfig = false;

function gaConfig(): GaConfig | undefined {
  const measurementId = process.env.GA_MEASUREMENT_ID?.trim();
  const apiSecret = process.env.GA_API_SECRET?.trim();
  if (!measurementId || !apiSecret) return undefined;
  if (!/^G-[A-Z0-9]{4,20}$/.test(measurementId) || !/^[A-Za-z0-9_-]{8,128}$/.test(apiSecret)) {
    if (!warnedInvalidConfig) {
      warnedInvalidConfig = true;
      console.error("[reversim-mcp] GA_MEASUREMENT_ID / GA_API_SECRET look invalid; analytics disabled");
    }
    return undefined;
  }
  return { measurementId, apiSecret, debug: process.env.GA_DEBUG === "1" };
}

/**
 * GA groups events into sessions by a numeric `session_id`. We derive a stable one from the
 * conversation's UUID (first 48 bits, always a safe integer).
 */
export function gaSessionNumber(sessionId: string): number {
  return Number.parseInt(sessionId.replace(/-/g, "").slice(0, 12), 16);
}

export function buildGaPayloads(ctx: RequestContext, engagementMs: number): object[] {
  const sessionParams = {
    session_id: gaSessionNumber(ctx.sessionId),
    engagement_time_msec: Math.max(1, Math.round(engagementMs)),
    session_tracked: ctx.sessionTracked ? "true" : "false",
  };
  const payloads: object[] = [];
  for (let i = 0; i < ctx.events.length; i += MAX_EVENTS_PER_POST) {
    payloads.push({
      client_id: ctx.sessionId,
      events: ctx.events.slice(i, i + MAX_EVENTS_PER_POST).map((e) => ({
        name: e.name,
        params: { ...e.params, ...sessionParams },
      })),
    });
  }
  return payloads;
}

const pending = new Set<Promise<void>>();

async function postToGa(cfg: GaConfig, payload: object, requestId: string): Promise<void> {
  // The URL is a compile-time constant; only our own (validated) env config goes in the query.
  const base = cfg.debug ? GA_DEBUG_URL : GA_COLLECT_URL;
  const url = `${base}?measurement_id=${encodeURIComponent(cfg.measurementId)}&api_secret=${encodeURIComponent(cfg.apiSecret)}`;
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(GA_TIMEOUT_MS),
      redirect: "error",
      credentials: "omit",
    });
    if (cfg.debug) {
      logMetric("ga_debug", { rid: requestId, status: res.status, validation: (await res.text()).slice(0, 2000) });
    } else if (!res.ok) {
      logMetric("ga_error", { rid: requestId, status: res.status });
    }
  } catch (err) {
    logMetric("ga_error", { rid: requestId, error: err instanceof Error ? err.name : "unknown" });
  }
}

function sendToGa(ctx: RequestContext, engagementMs: number): void {
  if (ctx.events.length === 0) return;
  const cfg = gaConfig();
  if (!cfg) return;
  const work = Promise.all(buildGaPayloads(ctx, engagementMs).map((p) => postToGa(cfg, p, ctx.requestId))).then(
    () => undefined,
  );
  pending.add(work);
  void work.finally(() => pending.delete(work));
  // On Vercel this keeps the function alive until GA has the events; elsewhere it is a no-op.
  try {
    waitUntil(work);
  } catch {
    // not running on Vercel
  }
}

/** Called once per HTTP request, after the response is written. */
export function finishRequest(ctx: RequestContext, status: number, durationMs: number): void {
  logMetric("request", {
    rid: ctx.requestId,
    session: ctx.sessionTracked ? ctx.sessionId : undefined,
    session_tracked: ctx.sessionTracked,
    status,
    duration_ms: Math.round(durationMs),
    ...ctx.log,
  });
  sendToGa(ctx, durationMs);
}

/** Waits for in-flight GA sends. For tests and graceful shutdown. */
export async function flushAnalytics(): Promise<void> {
  await Promise.all([...pending]);
}

// ---------------------------------------------------------------------------
// Tool-level helpers

export type ToolOutcome = "ok" | "user_error" | "internal_error";

export interface ToolInsight {
  /** Number of useful results. 0 also emits `search_no_results`. */
  resultCount?: number;
  /** Extra GA params. Must not contain free text typed by the attendee. */
  params?: Params;
  /** Sessions the attendee picked or looked at (ids must exist in the agenda). */
  selected?: { source: string; ids: string[] };
  /** Extra milestone events (e.g. schedule_built) for GA funnels / key events. */
  milestones?: { name: string; params?: Params }[];
}

export function recordToolCall(
  tool: string,
  outcome: ToolOutcome,
  durationMs: number,
  dataSource: string | undefined,
  insight: ToolInsight = {},
): void {
  annotateRequest({ tool, outcome, data_source: dataSource, result_count: insight.resultCount });
  trackEvent("tool_call", {
    tool,
    outcome,
    duration_ms: Math.round(durationMs),
    data_source: dataSource,
    result_count: insight.resultCount,
    ...insight.params,
  });
  if (outcome !== "ok") return;
  if (insight.resultCount === 0) trackEvent("search_no_results", { tool, ...insight.params });
  for (const m of insight.milestones ?? []) trackEvent(m.name, m.params);
  if (insight.selected) {
    for (const [rank, id] of insight.selected.ids.entries()) {
      trackEvent("session_selected", { talk_id: id, source: insight.selected.source, rank: rank + 1 });
    }
  }
}

/** Client name/version from `initialize`: keep a conservative character set and length. */
export function cleanClientField(v: unknown): string | undefined {
  if (typeof v !== "string") return undefined;
  const s = v.replace(/[^A-Za-z0-9 ._@/+()-]/g, "").trim().slice(0, 60);
  return s || undefined;
}
