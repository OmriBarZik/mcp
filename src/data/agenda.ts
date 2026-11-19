import { CACHE_TTL_MS, FEEDS, FETCH_TIMEOUT_MS, MAX_FEED_BYTES } from "../config.js";
import { buildAgenda } from "./normalize.js";
import { SNAPSHOT } from "./snapshot.js";
import { validateFeeds } from "./validate.js";
import type { Agenda, RawFeeds } from "./types.js";

let cached: { agenda: Agenda; expiresAt: number } | undefined;
let snapshotAgenda: Agenda | undefined;
let inflight: Promise<Agenda> | undefined;

/**
 * The ONLY outbound request this server makes. URLs are compile-time constants
 * (FEEDS); no client input ever reaches a URL, so there is no SSRF surface.
 */
async function fetchJson(url: (typeof FEEDS)[keyof typeof FEEDS]): Promise<unknown> {
  const res = await fetch(url, {
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    headers: { accept: "application/json" },
    redirect: "error", // never follow a redirect to another host
    credentials: "omit",
  });
  if (!res.ok) throw new Error(`upstream responded ${res.status}`);
  if (!(res.headers.get("content-type") ?? "").includes("application/json")) {
    throw new Error("upstream returned non-JSON content");
  }
  const declared = Number(res.headers.get("content-length") ?? 0);
  if (declared > MAX_FEED_BYTES) throw new Error("upstream payload too large");
  const body = await readCapped(res, MAX_FEED_BYTES);
  return JSON.parse(body);
}

async function readCapped(res: Response, maxBytes: number): Promise<string> {
  if (!res.body) return "";
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      throw new Error("upstream payload too large");
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}

/** Fetch both Sessionize feeds. Exported for the snapshot script. */
export async function fetchFeeds(): Promise<RawFeeds> {
  const [grid, speakers] = await Promise.all([fetchJson(FEEDS.grid), fetchJson(FEEDS.speakers)]);
  // Allowlist validation: unknown fields are dropped, malformed data is rejected.
  return validateFeeds({ grid, speakers });
}

export function getSnapshotAgenda(): Agenda {
  snapshotAgenda ??= buildAgenda(validateFeeds(SNAPSHOT.feeds), "snapshot", SNAPSHOT.fetchedAt);
  return snapshotAgenda;
}

/**
 * Returns the agenda: live Sessionize data (cached for CACHE_TTL_MS), falling back
 * to the bundled snapshot if Sessionize is slow or unreachable.
 * Set REVERSIM_OFFLINE=1 to always use the snapshot.
 */
export async function getAgenda(): Promise<Agenda> {
  if (process.env.REVERSIM_OFFLINE === "1") return getSnapshotAgenda();
  if (cached && cached.expiresAt > Date.now()) return cached.agenda;

  inflight ??= (async () => {
    try {
      const feeds = await fetchFeeds();
      const agenda = buildAgenda(feeds, "live", new Date().toISOString());
      cached = { agenda, expiresAt: Date.now() + CACHE_TTL_MS };
      return agenda;
    } catch (err) {
      console.error(`[reversim-mcp] live fetch failed, using snapshot: ${err instanceof Error ? err.message : "unknown error"}`);
      // Keep serving the last good live copy if we have one, otherwise the snapshot.
      const fallback = cached?.agenda ?? getSnapshotAgenda();
      // Retry live again in a minute rather than on every request.
      cached = { agenda: fallback, expiresAt: Date.now() + 60_000 };
      return fallback;
    } finally {
      inflight = undefined;
    }
  })();
  return inflight;
}

/** Test helper. */
export function resetAgendaCache(): void {
  cached = undefined;
  inflight = undefined;
}
