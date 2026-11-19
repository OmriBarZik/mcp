import type { Agenda, Session } from "./data/types.js";
import { hhmm } from "./logic/time.js";

export function dayLabel(day: string, agenda: Agenda): string {
  const n = agenda.days.indexOf(day) + 1;
  const date = new Date(`${day}T12:00:00Z`).toLocaleDateString("en-US", {
    weekday: "short",
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  });
  return n > 0 ? `Day ${n} (${date})` : date;
}

function truncate(text: string | undefined, max: number): string | undefined {
  if (!text) return undefined;
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1).trimEnd()}…` : flat;
}

/** Compact view used in lists. */
export function brief(s: Session, agenda: Agenda) {
  return {
    id: s.id,
    title: s.title,
    when: `${dayLabel(s.day, agenda)} ${hhmm(s.startsAt)}–${hhmm(s.endsAt)}`,
    room: s.room,
    track: s.track,
    speakers: s.speakers.map((p) => p.name),
  };
}

/** Brief + a shortened abstract, for recommendation candidates. */
export function withAbstract(s: Session, agenda: Agenda, max = 420) {
  return { ...brief(s, agenda), abstract: truncate(s.description, max) };
}

/** Full details, including speaker bios. */
export function full(s: Session, agenda: Agenda) {
  return {
    ...brief(s, agenda),
    startsAt: s.startsAt,
    endsAt: s.endsAt,
    lengthMinutes: s.lengthMinutes,
    isPlenary: s.isPlenum,
    description: s.description,
    url: s.url,
    speakers: s.speakers.map((p) => {
      const sp = agenda.speakers.get(p.id);
      return {
        id: p.id,
        name: p.name,
        tagLine: sp?.tagLine,
        bio: sp?.bio,
        url: sp?.url,
        links: sp?.links,
      };
    }),
  };
}

export function json(value: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }] };
}

export function errorResult(message: string) {
  return { content: [{ type: "text" as const, text: message }], isError: true };
}

export function dataNote(agenda: Agenda): string {
  return agenda.source === "live"
    ? `Live data from Sessionize (fetched ${agenda.fetchedAt}).`
    : `Using the bundled snapshot from ${agenda.fetchedAt} (live Sessionize feed unavailable).`;
}

/** Plain-text agenda, used for the agenda resource. */
export function agendaMarkdown(agenda: Agenda): string {
  const out: string[] = [];
  for (const day of agenda.days) {
    out.push(`## ${dayLabel(day, agenda)}`, "");
    for (const s of agenda.sessions.filter((x) => x.day === day)) {
      const who = s.speakers.map((p) => p.name).join(", ");
      const meta = [s.room, s.track, who].filter(Boolean).join(" · ");
      out.push(`- ${hhmm(s.startsAt)}–${hhmm(s.endsAt)} **${s.title}** (${meta}) [id: ${s.id}]`);
    }
    out.push("");
  }
  return out.join("\n");
}
