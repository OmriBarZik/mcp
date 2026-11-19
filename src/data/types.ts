// ---------------------------------------------------------------------------
// Raw Sessionize API shapes (only the fields we use).
// Feeds: https://sessionize.com/api/v2/1saptwag/view/{GridSmart,Speakers}
// ---------------------------------------------------------------------------

export interface RawCategory {
  id: number;
  name: string;
  categoryItems: { id: number; name: string }[];
}

export interface RawGridSession {
  id: string;
  title: string;
  description: string | null;
  /** Venue-local wall time without an offset, e.g. "2026-11-30T10:20:00". */
  startsAt: string;
  endsAt: string;
  isServiceSession: boolean;
  isPlenumSession: boolean;
  speakers: { id: string; name: string }[];
  categories: RawCategory[];
  roomId: number;
  room: string;
}

export interface RawGridDay {
  date: string;
  rooms: { id: number; name: string; sessions: RawGridSession[] }[];
}

export interface RawSpeaker {
  id: string;
  fullName: string;
  bio: string | null;
  tagLine: string | null;
  profilePicture: string | null;
  links: { title: string; url: string; linkType: string }[];
  sessions: { id: string | number; name: string }[];
}

export interface RawFeeds {
  grid: RawGridDay[];
  speakers: RawSpeaker[];
}

// ---------------------------------------------------------------------------
// Normalized model exposed by the server.
// ---------------------------------------------------------------------------

export interface Speaker {
  id: string;
  name: string;
  tagLine?: string;
  bio?: string;
  photo?: string;
  links: { title: string; url: string }[];
  sessionIds: string[];
  url: string;
}

export interface Session {
  id: string;
  title: string;
  description?: string;
  /** Venue-local time (Asia/Jerusalem), ISO without offset. */
  startsAt: string;
  endsAt: string;
  /** YYYY-MM-DD */
  day: string;
  lengthMinutes: number;
  room: string;
  /** "AI/ML", "Craft", "Frontend/Product", "Ignites", "Keynote" — undefined for breaks. */
  track?: string;
  speakers: { id: string; name: string }[];
  /** Breaks, registration, opening words etc. */
  isService: boolean;
  /** Everyone is in one room for this slot. */
  isPlenum: boolean;
  /** Absent for service sessions, which have no page on the site. */
  url?: string;
}

export interface Agenda {
  sessions: Session[];
  speakers: Map<string, Speaker>;
  days: string[];
  tracks: string[];
  rooms: string[];
  fetchedAt: string;
  source: "live" | "snapshot";
}
