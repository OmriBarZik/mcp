import { UserError } from "../errors.js";
import { CONFERENCE } from "../config.js";

/** Current wall-clock time at the venue as "YYYY-MM-DDTHH:MM:SS". */
export function venueNow(date = new Date()): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: CONFERENCE.timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date);
  const get = (t: string) => parts.find((p) => p.type === t)!.value;
  return `${get("year")}-${get("month")}-${get("day")}T${get("hour")}:${get("minute")}:${get("second")}`;
}

/** Offset of the venue timezone from UTC (ms) at a given instant. */
function venueOffsetMs(instant: number): number {
  const wall = venueNow(new Date(instant));
  return Date.parse(`${wall}Z`) - Math.floor(instant / 1000) * 1000;
}

/** Converts a venue wall-time ISO string (no offset) to a UTC Date. */
export function venueToUtc(wall: string): Date {
  const asUtc = Date.parse(`${wall.length === 16 ? `${wall}:00` : wall}Z`);
  let t = asUtc - venueOffsetMs(asUtc);
  // Second pass handles the rare case where the offset differs across the guess.
  t = asUtc - venueOffsetMs(t);
  return new Date(t);
}

/**
 * Accepts an ISO timestamp with offset/Z (an instant), a venue wall time
 * ("2026-11-30T11:15"), or "HH:MM" (combined with `day`). Returns venue wall time.
 */
export function toVenueWallTime(input: string, day?: string): string {
  const v = input.trim();
  if (/^\d{1,2}:\d{2}$/.test(v)) {
    if (!day) throw new UserError(`Time "${v}" needs a day.`);
    return `${day}T${v.padStart(5, "0")}:00`;
  }
  if (/[zZ]$|[+-]\d{2}:?\d{2}$/.test(v)) {
    const d = new Date(v);
    if (Number.isNaN(d.getTime())) throw new UserError(`Invalid time "${v}".`);
    return venueNow(d);
  }
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?$/.test(v)) return v.length === 16 ? `${v}:00` : v;
  throw new UserError(`Could not understand time "${v}". Use ISO (2026-11-30T11:15) or HH:MM with a day.`);
}

export const hhmm = (wall: string) => wall.slice(11, 16);

export function overlaps(a: { startsAt: string; endsAt: string }, b: { startsAt: string; endsAt: string }): boolean {
  return a.startsAt < b.endsAt && b.startsAt < a.endsAt;
}
