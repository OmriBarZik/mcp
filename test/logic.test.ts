import { describe, expect, it } from "vitest";
import { getSnapshotAgenda } from "../src/data/agenda.js";
import { buildIcs } from "../src/logic/ics.js";
import { buildSchedule, pickNonOverlapping } from "../src/logic/schedule.js";
import { expandTerms, resolveDay, searchSessions } from "../src/logic/search.js";
import { overlaps, toVenueWallTime, venueToUtc } from "../src/logic/time.js";

const agenda = getSnapshotAgenda();

describe("agenda snapshot", () => {
  it("has both days, talks and speakers", () => {
    expect(agenda.days).toEqual(["2026-11-30", "2026-12-01"]);
    expect(agenda.sessions.filter((s) => !s.isService).length).toBeGreaterThan(40);
    expect(agenda.speakers.size).toBeGreaterThan(40);
  });

  it("builds website links with the same slugs the site uses", () => {
    const s = agenda.sessions.find((x) => x.title.startsWith("4+3 Strategies"));
    expect(s?.url).toBe("https://summit2026.reversim.com/session/43-strategies-to-boost-your-caches");
  });

  it("maps Sessionize Frontend to Frontend/Product like the site", () => {
    expect(agenda.tracks).toContain("Frontend/Product");
    expect(agenda.tracks).not.toContain("Frontend");
  });
});

describe("search", () => {
  it("resolves human day names", () => {
    expect(resolveDay("day 2", agenda.days)).toBe("2026-12-01");
    expect(resolveDay("Monday", agenda.days)).toBe("2026-11-30");
    expect(resolveDay("dec 1", agenda.days)).toBe("2026-12-01");
    expect(resolveDay("friday", agenda.days)).toBeUndefined();
  });

  it("expands synonyms with lower weight", () => {
    const terms = expandTerms("llm");
    expect(terms.find((t) => t.term === "llm")?.weight).toBe(1);
    expect(terms.find((t) => t.term === "ai")?.weight).toBeLessThan(1);
  });

  it("finds talks by keyword and filters by track/day", () => {
    const r = searchSessions(agenda, "react native security", {});
    expect(r[0].session.title).toMatch(/React Native/);
    const keynotes = searchSessions(agenda, undefined, { tracks: ["keynote"], day: "day 1" });
    expect(keynotes.every((x) => x.session.track === "Keynote" && x.session.day === "2026-11-30")).toBe(true);
  });

  it("rejects unknown days with a clear message", () => {
    expect(() => searchSessions(agenda, undefined, { day: "someday" })).toThrow(/Unknown day/);
  });
});

describe("schedule", () => {
  it("weighted interval scheduling never overlaps and maximises weight", () => {
    const mk = (id: string, s: string, e: string, weight: number) => ({
      session: { ...agenda.sessions[0], id, startsAt: `2026-11-30T${s}:00`, endsAt: `2026-11-30T${e}:00` },
      weight,
    });
    const picked = pickNonOverlapping([mk("a", "10:00", "11:00", 5), mk("b", "10:30", "11:30", 4), mk("c", "11:00", "12:00", 3)]);
    expect(picked.map((p) => p.session.id)).toEqual(["a", "c"]);
  });

  it("puts must-see sessions first and reports clashes", () => {
    const day1 = agenda.sessions.filter((s) => s.day === "2026-11-30" && !s.isService && !s.isPlenum);
    const a = day1[0];
    const clash = day1.find((s) => s.id !== a.id && overlaps(s, a))!;
    const r = buildSchedule(agenda, { mustSee: [a.id, clash.id], interests: "AI", days: ["day 1"] });
    const ids = r.days[0].entries.map((e) => e.session.id);
    expect(ids).toContain(a.id);
    expect(ids).not.toContain(clash.id);
    expect(r.conflicts.map((c) => c.wanted.id)).toEqual([clash.id]);
    const talks = r.days[0].entries.filter((e) => e.why !== "break").map((e) => e.session);
    for (let i = 0; i < talks.length; i++)
      for (let j = i + 1; j < talks.length; j++) expect(overlaps(talks[i], talks[j])).toBe(false);
  });
});

describe("time & calendar", () => {
  it("converts venue time to UTC (Israel is UTC+2 in Nov/Dec)", () => {
    expect(venueToUtc("2026-11-30T10:00:00").toISOString()).toBe("2026-11-30T08:00:00.000Z");
    expect(toVenueWallTime("2026-11-30T08:15:00Z")).toBe("2026-11-30T10:15:00");
    expect(toVenueWallTime("11:15", "2026-12-01")).toBe("2026-12-01T11:15:00");
  });

  it("produces a valid, folded, escaped ICS", () => {
    const s = agenda.sessions.find((x) => !x.isService)!;
    const ics = buildIcs([{ ...s, title: "Evil; title, with\nnewline" }], new Date("2026-11-01T00:00:00Z"));
    expect(ics.startsWith("BEGIN:VCALENDAR\r\n")).toBe(true);
    expect(ics).toContain("SUMMARY:RS26: Evil\\; title\\, with\\nnewline");
    for (const line of ics.split("\r\n")) expect(Buffer.byteLength(line)).toBeLessThanOrEqual(75);
    expect(ics).not.toMatch(/[^\r]\n/);
  });
});
