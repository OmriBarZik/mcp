import { UserError } from "../errors.js";
import type { Agenda, Session, Speaker } from "../data/types.js";

// ---------------------------------------------------------------------------
// Text matching
// ---------------------------------------------------------------------------

const STOPWORDS = new Set(
  "a an and are as at be by for from how i in into is it its me my of on or our so that the this to we what when with you your want like love interested interest about talks talk sessions session stuff things more also".split(
    " ",
  ),
);

/**
 * Small domain thesaurus: a term on the left also matches the terms on the right.
 * Keeps "llm" finding "AI" talks, "k8s" finding "kubernetes", etc.
 */
const SYNONYMS: Record<string, string[]> = {
  ai: ["llm", "llms", "genai", "agent", "agents", "agentic", "ml", "model", "models"],
  llm: ["ai", "llms", "genai", "model", "models", "gpt"],
  llms: ["llm", "ai", "genai"],
  genai: ["ai", "llm", "llms"],
  ml: ["ai", "machine", "learning", "model", "models", "training"],
  agent: ["agents", "agentic", "ai"],
  agents: ["agent", "agentic", "ai"],
  agentic: ["agent", "agents", "ai"],
  frontend: ["web", "react", "browser", "ui", "css", "javascript", "product"],
  web: ["frontend", "browser", "react"],
  react: ["frontend", "javascript", "web"],
  mobile: ["ios", "android", "app", "native"],
  backend: ["server", "microservices", "api", "database", "distributed", "scale", "infrastructure"],
  infra: ["infrastructure", "cloud", "devops", "platform", "kubernetes"],
  infrastructure: ["infra", "cloud", "platform"],
  devops: ["ops", "infrastructure", "cloud", "ci", "deployment", "kubernetes", "sre"],
  sre: ["production", "incidents", "reliability", "on-call", "monitoring", "observability"],
  k8s: ["kubernetes"],
  kubernetes: ["k8s", "cloud"],
  cloud: ["aws", "gcp", "azure", "infrastructure"],
  security: ["secure", "hacker", "attack", "cyber", "guardrails", "vulnerability"],
  cyber: ["security"],
  data: ["database", "analytics", "pipeline", "dataset"],
  database: ["db", "sql", "postgres", "data"],
  performance: ["fast", "latency", "optimization", "cache", "caches", "scale"],
  testing: ["tests", "qa", "evaluation", "evals"],
  evals: ["evaluation", "evaluating", "judge", "testing"],
  evaluation: ["evals", "evaluating", "judge"],
  career: ["leadership", "management", "growth", "layoff", "skill", "skills", "job"],
  leadership: ["management", "manager", "career", "team", "teams", "culture"],
  management: ["leadership", "manager", "team"],
  culture: ["team", "teams", "people"],
  architecture: ["design", "systems", "microservices", "codebase", "codebases"],
  productivity: ["workflow", "tools", "developer", "experience"],
  rag: ["retrieval", "context", "embeddings", "search"],
  context: ["rag", "prompt", "prompts"],
};

export function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .split(/[^a-z0-9+#/]+/)
    .flatMap((t) => (t.includes("/") ? [t, ...t.split("/")] : [t]))
    .filter((t) => t.length > 1 && !STOPWORDS.has(t));
}

function stem(t: string): string {
  // Very light stemming so "agents"/"agent", "testing"/"test" line up.
  return t.replace(/(ing|ers|er|es|s)$/, "") || t;
}

interface Term {
  term: string;
  weight: number;
}

/** Turns free-text interests into weighted search terms (original terms weigh more than synonyms). */
export function expandTerms(query: string): Term[] {
  const out = new Map<string, number>();
  for (const t of tokenize(query)) {
    out.set(t, Math.max(out.get(t) ?? 0, 1));
    for (const syn of SYNONYMS[t] ?? []) out.set(syn, Math.max(out.get(syn) ?? 0, 0.4));
  }
  return [...out].map(([term, weight]) => ({ term, weight }));
}

function fieldMatches(fieldTokens: Set<string>, fieldStems: Set<string>, term: string): boolean {
  return fieldTokens.has(term) || fieldStems.has(stem(term));
}

interface Indexed {
  title: [Set<string>, Set<string>];
  track: [Set<string>, Set<string>];
  description: [Set<string>, Set<string>];
  speakers: [Set<string>, Set<string>];
}

const indexCache = new WeakMap<Session, Indexed>();

function index(session: Session, speakers: Map<string, Speaker>): Indexed {
  let idx = indexCache.get(session);
  if (idx) return idx;
  const mk = (text: string): [Set<string>, Set<string>] => {
    const toks = tokenize(text);
    return [new Set(toks), new Set(toks.map(stem))];
  };
  const speakerText = session.speakers
    .map((p) => {
      const sp = speakers.get(p.id);
      return [p.name, sp?.tagLine ?? ""].join(" ");
    })
    .join(" ");
  idx = {
    title: mk(session.title),
    track: mk(session.track ?? ""),
    description: mk(session.description ?? ""),
    speakers: mk(speakerText),
  };
  indexCache.set(session, idx);
  return idx;
}

const FIELD_WEIGHTS: Record<keyof Indexed, number> = {
  title: 3,
  track: 2.5,
  description: 1,
  speakers: 0.75,
};

export interface Scored {
  session: Session;
  score: number;
  matched: string[];
}

export function scoreSession(
  session: Session,
  terms: Term[],
  speakers: Map<string, Speaker>,
): Scored {
  if (session.isService || terms.length === 0) return { session, score: 0, matched: [] };
  const idx = index(session, speakers);
  let score = 0;
  const matched: string[] = [];
  for (const { term, weight } of terms) {
    let termScore = 0;
    for (const field of Object.keys(FIELD_WEIGHTS) as (keyof Indexed)[]) {
      const [toks, stems] = idx[field];
      if (fieldMatches(toks, stems, term)) termScore += FIELD_WEIGHTS[field];
    }
    if (termScore > 0) {
      score += termScore * weight;
      if (weight === 1) matched.push(term);
    }
  }
  return { session, score: Math.round(score * 10) / 10, matched };
}

// ---------------------------------------------------------------------------
// Filters
// ---------------------------------------------------------------------------

export interface SessionFilters {
  day?: string;
  tracks?: string[];
  excludeTracks?: string[];
  room?: string;
  speaker?: string;
  /** "HH:MM", venue-local. Sessions starting at or after this time. */
  startsAfter?: string;
  /** "HH:MM", venue-local. Sessions ending at or before this time. */
  endsBefore?: string;
  includeService?: boolean;
}

/**
 * Accepts "2026-11-30", "day 1", "1", "mon", "monday", "nov 30", "tue", "dec 1"...
 * Returns the YYYY-MM-DD day or undefined if it can't be resolved.
 */
export function resolveDay(input: string, days: string[]): string | undefined {
  const v = input.trim().toLowerCase();
  if (days.includes(v)) return v;
  const n = v.match(/^(?:day\s*)?(\d)$/);
  if (n) return days[Number(n[1]) - 1];
  for (const d of days) {
    const date = new Date(`${d}T12:00:00Z`);
    const weekday = date.toLocaleDateString("en-US", { weekday: "long", timeZone: "UTC" }).toLowerCase();
    const month = date.toLocaleDateString("en-US", { month: "short", timeZone: "UTC" }).toLowerCase();
    const dayNum = String(date.getUTCDate());
    if (v === weekday || v === weekday.slice(0, 3)) return d;
    if (v === `${month} ${dayNum}` || v === `${dayNum} ${month}` || v === d.slice(5)) return d;
  }
  return undefined;
}

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");

export function matchesTrack(session: Session, track: string): boolean {
  if (!session.track) return false;
  const a = norm(session.track);
  const b = norm(track);
  return a === b || a.startsWith(b) || session.track.toLowerCase().split("/").some((p) => norm(p) === b);
}

export function applyFilters(agenda: Agenda, f: SessionFilters): Session[] {
  const day = f.day ? resolveDay(f.day, agenda.days) : undefined;
  if (f.day && !day) {
    throw new UserError(`Unknown day "${f.day}". Conference days: ${agenda.days.join(", ")} (or "day 1"/"day 2").`);
  }
  return agenda.sessions.filter((s) => {
    if (!f.includeService && s.isService) return false;
    if (day && s.day !== day) return false;
    if (f.tracks?.length && !f.tracks.some((t) => matchesTrack(s, t))) return false;
    if (f.excludeTracks?.some((t) => matchesTrack(s, t))) return false;
    if (f.room && norm(s.room) !== norm(f.room)) return false;
    if (f.speaker) {
      const q = f.speaker.toLowerCase();
      if (!s.speakers.some((p) => p.name.toLowerCase().includes(q))) return false;
    }
    if (f.startsAfter && s.startsAt.slice(11, 16) < f.startsAfter) return false;
    if (f.endsBefore && s.endsAt.slice(11, 16) > f.endsBefore) return false;
    return true;
  });
}

/** Free-text search over title, description, track and speakers. */
export function searchSessions(
  agenda: Agenda,
  query: string | undefined,
  filters: SessionFilters,
): Scored[] {
  const candidates = applyFilters(agenda, filters);
  if (!query?.trim()) return candidates.map((session) => ({ session, score: 0, matched: [] }));
  const terms = expandTerms(query);
  return candidates
    .map((s) => scoreSession(s, terms, agenda.speakers))
    .filter((r) => r.score > 0)
    .sort((a, b) => b.score - a.score || a.session.startsAt.localeCompare(b.session.startsAt));
}
