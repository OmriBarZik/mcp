import { CONFERENCE } from "../config.js";
import type { Session } from "../data/types.js";
import { venueToUtc } from "./time.js";

function icsDate(d: Date): string {
  return d.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
}

function escape(text: string): string {
  return text.replace(/\\/g, "\\\\").replace(/\n/g, "\\n").replace(/[,;]/g, (m) => `\\${m}`);
}

/** Folds lines to 75 octets as required by RFC 5545. */
function fold(line: string): string {
  const bytes = Buffer.from(line, "utf8");
  if (bytes.length <= 75) return line;
  const out: string[] = [];
  let current = "";
  let currentBytes = 0;
  for (const ch of line) {
    const len = Buffer.byteLength(ch, "utf8");
    const limit = out.length === 0 ? 75 : 74; // continuation lines start with a space
    if (currentBytes + len > limit) {
      out.push(current);
      current = "";
      currentBytes = 0;
    }
    current += ch;
    currentBytes += len;
  }
  out.push(current);
  return out.join("\r\n ");
}

export function buildIcs(sessions: Session[], now = new Date()): string {
  const lines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//Reversim Summit 2026 MCP//EN",
    "CALSCALE:GREGORIAN",
    "METHOD:PUBLISH",
    `X-WR-CALNAME:${escape(`${CONFERENCE.shortName} – my schedule`)}`,
    `X-WR-TIMEZONE:${CONFERENCE.timezone}`,
  ];
  for (const s of sessions) {
    const speakers = s.speakers.map((p) => p.name).join(", ");
    const desc = [
      speakers && `Speakers: ${speakers}`,
      s.track && `Track: ${s.track}`,
      s.url,
      s.description,
    ]
      .filter(Boolean)
      .join("\n\n");
    lines.push(
      "BEGIN:VEVENT",
      `UID:${s.id}@summit2026.reversim.com`,
      `DTSTAMP:${icsDate(now)}`,
      `DTSTART:${icsDate(venueToUtc(s.startsAt))}`,
      `DTEND:${icsDate(venueToUtc(s.endsAt))}`,
      `SUMMARY:${escape(`${CONFERENCE.shortName}: ${s.title}`)}`,
      `LOCATION:${escape(`${s.room} – ${CONFERENCE.name}`)}`,
      `DESCRIPTION:${escape(desc)}`,
      ...(s.url ? [`URL:${s.url}`] : []),
      "BEGIN:VALARM",
      "ACTION:DISPLAY",
      "TRIGGER:-PT5M",
      `DESCRIPTION:${escape(s.title)}`,
      "END:VALARM",
      "END:VEVENT",
    );
  }
  lines.push("END:VCALENDAR");
  return lines.map(fold).join("\r\n") + "\r\n";
}
