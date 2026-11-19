import { UserError } from "../errors.js";
import type { Agenda, Session } from "../data/types.js";
import { applyFilters, expandTerms, scoreSession } from "./search.js";
import { overlaps } from "./time.js";

export interface ScheduleRequest {
  /** Sessions the attendee wants, most important first. */
  mustSee?: string[];
  /** Free-text interests used to fill the remaining slots. */
  interests?: string;
  days?: string[];
  excludeTracks?: string[];
}

export interface ScheduleEntry {
  session: Session;
  why: "requested" | "interest-match" | "plenary" | "break";
  score?: number;
  matched?: string[];
  /** Other talks running at the same time. */
  alternatives: Session[];
}

export interface OpenSlot {
  startsAt: string;
  endsAt: string;
  options: Session[];
}

export interface Conflict {
  wanted: Session;
  clashesWith: Session[];
}

export interface DaySchedule {
  day: string;
  entries: ScheduleEntry[];
  openSlots: OpenSlot[];
}

export interface ScheduleResult {
  days: DaySchedule[];
  conflicts: Conflict[];
  unknownIds: string[];
}

const MUST_SEE_WEIGHT = 10_000;
const PLENARY_WEIGHT = 0.5;

interface Candidate {
  session: Session;
  weight: number;
  why: ScheduleEntry["why"];
  score?: number;
  matched?: string[];
}

/** Classic weighted interval scheduling: maximum total weight of non-overlapping sessions. */
export function pickNonOverlapping<T extends { session: Session; weight: number }>(cands: T[]): T[] {
  const sorted = [...cands].sort(
    (a, b) => a.session.endsAt.localeCompare(b.session.endsAt) || a.session.startsAt.localeCompare(b.session.startsAt),
  );
  const n = sorted.length;
  // prev[j] = number of items (prefix length) that end at or before sorted[j] starts.
  const prev = sorted.map((c, j) => {
    let lo = 0;
    let hi = j;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (sorted[mid].session.endsAt <= c.session.startsAt) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  });
  const best = new Array<number>(n + 1).fill(0);
  for (let j = 1; j <= n; j++) {
    best[j] = Math.max(best[j - 1], sorted[j - 1].weight + best[prev[j - 1]]);
  }
  const picked: T[] = [];
  for (let j = n; j > 0; ) {
    if (sorted[j - 1].weight + best[prev[j - 1]] >= best[j - 1] && sorted[j - 1].weight > 0) {
      picked.push(sorted[j - 1]);
      j = prev[j - 1];
    } else {
      j--;
    }
  }
  return picked.reverse();
}

export function buildSchedule(agenda: Agenda, req: ScheduleRequest): ScheduleResult {
  const mustSee = req.mustSee ?? [];
  const byId = new Map(agenda.sessions.map((s) => [s.id, s]));
  const unknownIds = mustSee.filter((id) => !byId.has(id));
  if (mustSee.length === 0 && !req.interests?.trim()) {
    throw new UserError("Provide mustSee session ids and/or interests to build a schedule.");
  }

  const terms = expandTerms(req.interests ?? "");
  const dayFilter = req.days?.length ? req.days : agenda.days;
  const days: DaySchedule[] = [];
  const conflicts: Conflict[] = [];

  for (const dayInput of dayFilter) {
    const talks = applyFilters(agenda, { day: dayInput, excludeTracks: req.excludeTracks });
    const all = applyFilters(agenda, { day: dayInput, includeService: true });
    const day = all[0]?.day ?? dayInput;

    const candidates: Candidate[] = [];
    for (const s of talks) {
      const priority = mustSee.indexOf(s.id);
      if (priority !== -1) {
        candidates.push({ session: s, weight: MUST_SEE_WEIGHT - priority, why: "requested" });
        continue;
      }
      const sc = scoreSession(s, terms, agenda.speakers);
      if (sc.score > 0) {
        candidates.push({ session: s, weight: sc.score, why: "interest-match", score: sc.score, matched: sc.matched });
      } else if (s.isPlenum) {
        candidates.push({ session: s, weight: PLENARY_WEIGHT, why: "plenary" });
      }
    }
    // A must-see the user explicitly asked for is kept even if its track was excluded.
    for (const id of mustSee) {
      const s = byId.get(id);
      if (s && s.day === day && !candidates.some((c) => c.session.id === id)) {
        candidates.push({ session: s, weight: MUST_SEE_WEIGHT - mustSee.indexOf(id), why: "requested" });
      }
    }

    const chosen = pickNonOverlapping(candidates);
    const chosenSessions = chosen.map((c) => c.session);

    for (const c of candidates) {
      if (c.why === "requested" && !chosenSessions.includes(c.session)) {
        conflicts.push({ wanted: c.session, clashesWith: chosenSessions.filter((s) => overlaps(s, c.session)) });
      }
    }

    const entries: ScheduleEntry[] = chosen.map((c) => ({
      session: c.session,
      why: c.why,
      score: c.score,
      matched: c.matched,
      alternatives: talks.filter((t) => t.id !== c.session.id && overlaps(t, c.session)),
    }));
    for (const s of all) {
      if (s.isService && !chosenSessions.some((c) => overlaps(c, s))) {
        entries.push({ session: s, why: "break", alternatives: [] });
      }
    }
    entries.sort((a, b) => a.session.startsAt.localeCompare(b.session.startsAt));

    // Time slots with talks where nothing was picked.
    const openSlots: OpenSlot[] = [];
    const starts = [...new Set(talks.map((t) => t.startsAt))].sort();
    for (const start of starts) {
      const options = talks.filter((t) => t.startsAt === start);
      if (options.some((o) => chosenSessions.some((c) => overlaps(c, o)))) continue;
      openSlots.push({
        startsAt: start,
        endsAt: options.map((o) => o.endsAt).sort().at(-1)!,
        options,
      });
    }

    days.push({ day, entries, openSlots });
  }

  return { days, conflicts, unknownIds };
}
