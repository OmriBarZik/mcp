export const CONFERENCE = {
  name: "Reversim Summit 2026",
  shortName: "RS26",
  dates: "Nov 30 – Dec 1, 2026",
  website: "https://summit2026.reversim.com",
  registrationUrl: "https://ti.to/reversim-summit/2026/",
  timezone: "Asia/Jerusalem",
  language: "All sessions are conducted in Hebrew",
} as const;

const SESSIONIZE_EVENT = "1saptwag";
export const FEEDS = {
  grid: `https://sessionize.com/api/v2/${SESSIONIZE_EVENT}/view/GridSmart`,
  speakers: `https://sessionize.com/api/v2/${SESSIONIZE_EVENT}/view/Speakers`,
} as const;

/** How long live data is reused before re-fetching. */
export const CACHE_TTL_MS = 10 * 60 * 1000;
/** Per-request timeout for the live feeds; on timeout we serve the snapshot. */
export const FETCH_TIMEOUT_MS = 4000;
/** Hard cap on each upstream feed (current feeds are ~100–250 KB). */
export const MAX_FEED_BYTES = 3 * 1024 * 1024;

/**
 * Google Analytics 4 Measurement Protocol (usage analytics, off unless GA_MEASUREMENT_ID and
 * GA_API_SECRET are set). Fixed URLs: nothing a client sends is ever part of them.
 */
export const GA_COLLECT_URL = "https://www.google-analytics.com/mp/collect";
export const GA_DEBUG_URL = "https://www.google-analytics.com/debug/mp/collect";
/** GA sends happen after the response; this only bounds how long the function stays alive. */
export const GA_TIMEOUT_MS = 2000;
