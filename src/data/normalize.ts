import slug from "slug";
import { CONFERENCE } from "../config.js";
import { cleanText as clean, safeHttpUrl, safePhotoUrl } from "./validate.js";
import type {
  Agenda,
  RawFeeds,
  RawGridSession,
  RawSpeaker,
  Session,
  Speaker,
} from "./types.js";

/** Same track naming the website uses (Sessionize "Frontend" is shown as "Frontend/Product"). */
export function resolveTrack(s: Pick<RawGridSession, "categories">): string | undefined {
  const item = s.categories?.find((c) => c.name === "Track")?.categoryItems?.[0];
  if (!item) return undefined;
  return item.name === "Frontend" ? "Frontend/Product" : item.name;
}

function minutesBetween(a: string, b: string): number {
  return Math.round((Date.parse(b) - Date.parse(a)) / 60000);
}


function toSession(raw: RawGridSession): Session {
  return {
    id: String(raw.id),
    title: clean(raw.title) ?? "(untitled)",
    description: clean(raw.description),
    startsAt: raw.startsAt,
    endsAt: raw.endsAt,
    day: raw.startsAt.slice(0, 10),
    lengthMinutes: minutesBetween(raw.startsAt, raw.endsAt),
    room: clean(raw.room) ?? "TBA",
    track: resolveTrack(raw),
    speakers: raw.speakers.map((p) => ({ id: p.id, name: clean(p.name) ?? "" })),
    isService: raw.isServiceSession,
    isPlenum: raw.isPlenumSession,
    url: raw.isServiceSession ? undefined : `${CONFERENCE.website}/session/${slug(raw.title)}`,
  };
}

function toSpeaker(raw: RawSpeaker): Speaker {
  return {
    id: raw.id,
    name: clean(raw.fullName) ?? "",
    tagLine: clean(raw.tagLine),
    bio: clean(raw.bio),
    photo: safePhotoUrl(raw.profilePicture),
    links: (raw.links ?? []).flatMap((l) => {
      const url = safeHttpUrl(l.url);
      return url ? [{ title: clean(l.title) ?? "Link", url }] : [];
    }),
    sessionIds: (raw.sessions ?? []).map((s) => String(s.id)),
    url: `${CONFERENCE.website}/speaker/${slug(raw.fullName)}`,
  };
}

const ROOM_ORDER = ["Main hall", "A2+A3", "A4+A5", "Dining Hall", "Entrance"];

export function buildAgenda(
  feeds: RawFeeds,
  source: Agenda["source"],
  fetchedAt: string,
): Agenda {
  const byId = new Map<string, Session>();
  for (const day of feeds.grid) {
    for (const room of day.rooms) {
      for (const raw of room.sessions) {
        // A session spanning several rooms appears once per room; keep the first.
        if (!byId.has(String(raw.id))) byId.set(String(raw.id), toSession(raw));
      }
    }
  }
  const sessions = [...byId.values()].sort(
    (a, b) =>
      a.startsAt.localeCompare(b.startsAt) ||
      roomRank(a.room) - roomRank(b.room) ||
      a.title.localeCompare(b.title),
  );

  const speakers = new Map<string, Speaker>();
  for (const raw of feeds.speakers) speakers.set(raw.id, toSpeaker(raw));
  // Speakers that appear on the grid but not in the speakers feed still get an entry.
  for (const s of sessions) {
    for (const p of s.speakers) {
      if (!speakers.has(p.id)) {
        speakers.set(p.id, {
          id: p.id,
          name: p.name,
          links: [],
          sessionIds: [],
          url: `${CONFERENCE.website}/speaker/${slug(p.name)}`,
        });
      }
      const sp = speakers.get(p.id)!;
      if (!sp.sessionIds.includes(s.id)) sp.sessionIds.push(s.id);
    }
  }

  const uniq = (xs: (string | undefined)[]) =>
    [...new Set(xs.filter((x): x is string => !!x))];

  return {
    sessions,
    speakers,
    days: uniq(sessions.map((s) => s.day)).sort(),
    tracks: uniq(sessions.map((s) => s.track)).sort(),
    rooms: uniq(sessions.map((s) => s.room)).sort((a, b) => roomRank(a) - roomRank(b)),
    fetchedAt,
    source,
  };
}

function roomRank(room: string): number {
  const i = ROOM_ORDER.indexOf(room);
  return i === -1 ? ROOM_ORDER.length : i;
}
