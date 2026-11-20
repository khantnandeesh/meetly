/**
 * Calendar links for a meeting that happens later. Nothing is stored or sent by Meetly: each
 * function only puts the title, the time and the meeting link into a form a calendar accepts,
 * and the person's own calendar does the rest (the invitation, the reminder).
 *
 * Every time that leaves here is in UTC, so it means the same instant whatever time zone the
 * calendar, or anyone invited, is in.
 */

export type CalendarEvent = {
  title: string;
  start: Date;
  /** Length in minutes. */
  minutes: number;
  /** The meeting's address, e.g. https://example.com/abc-defg-hij. */
  link: string;
};

export const DEFAULT_TITLE = "Meetly meeting";
export const DURATIONS = [15, 30, 45, 60, 90, 120] as const;

const pad = (n: number, width = 2) => String(n).padStart(width, "0");

export const endOf = (event: CalendarEvent) => new Date(event.start.getTime() + event.minutes * 60_000);

/** 20261120T140000Z: the "basic" UTC form iCalendar and Google use. */
export function utcBasic(date: Date): string {
  return (
    `${pad(date.getUTCFullYear(), 4)}${pad(date.getUTCMonth() + 1)}${pad(date.getUTCDate())}` +
    `T${pad(date.getUTCHours())}${pad(date.getUTCMinutes())}${pad(date.getUTCSeconds())}Z`
  );
}

/** 2026-11-20T14:00:00Z: the form Outlook's links take. */
export function utcExtended(date: Date): string {
  return `${date.toISOString().slice(0, 19)}Z`;
}

/**
 * The instant a date and a time of day typed into the form mean, in the time zone of the
 * browser they were typed in. Null if they are not a real date and time.
 *
 * A time the clocks skip (02:30 on the night they go forward) becomes the time an hour later,
 * which is what the wall clock shows then; a time that happens twice (when they go back) is the
 * first of the two.
 */
export function localDateTime(date: string, time: string): Date | null {
  const d = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  const t = /^(\d{2}):(\d{2})$/.exec(time);
  if (!d || !t) return null;
  const [year, month, day, hour, minute] = [d[1], d[2], d[3], t[1], t[2]].map(Number);
  if (month < 1 || month > 12 || day < 1 || day > 31 || hour > 23 || minute > 59) return null;
  const result = new Date(year, month - 1, day, hour, minute, 0, 0);
  // 31 February rolls over into March: not a date anyone meant.
  if (result.getFullYear() !== year || result.getMonth() !== month - 1 || result.getDate() !== day) return null;
  return result;
}

/** The values a date field and a time field need to show `date`, in the browser's time zone. */
export function toFieldValues(date: Date): { date: string; time: string } {
  return {
    date: `${pad(date.getFullYear(), 4)}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`,
    time: `${pad(date.getHours())}:${pad(date.getMinutes())}`,
  };
}

/** The next half hour that is at least a few minutes away: a sensible start to offer. */
export function nextHalfHour(now: Date = new Date()): Date {
  const slot = 30 * 60_000;
  return new Date(Math.ceil((now.getTime() + 5 * 60_000) / slot) * slot);
}

const describe = (event: CalendarEvent) => `Join the meeting: ${event.link}\n\nIt opens in the browser. No account or app is needed.`;

/** Spaces as %20, never "+": Outlook shows a plus sign as a plus sign. */
const query = (params: Record<string, string>) =>
  Object.entries(params)
    .map(([key, value]) => `${key}=${encodeURIComponent(value)}`)
    .join("&");

/** Opens Google Calendar's "new event" form, filled in. */
export function googleCalendarUrl(event: CalendarEvent): string {
  return `https://calendar.google.com/calendar/render?${query({
    action: "TEMPLATE",
    text: event.title,
    dates: `${utcBasic(event.start)}/${utcBasic(endOf(event))}`,
    details: describe(event),
    location: event.link,
  })}`;
}

/**
 * Opens Outlook on the web's "new event" form, filled in. Personal accounts (outlook.com,
 * hotmail) live at outlook.live.com; work and school accounts at outlook.office.com.
 */
export function outlookCalendarUrl(event: CalendarEvent, account: "personal" | "work" = "personal"): string {
  const host = account === "work" ? "outlook.office.com" : "outlook.live.com";
  return `https://${host}/calendar/0/deeplink/compose?${query({
    path: "/calendar/action/compose",
    rru: "addevent",
    subject: event.title,
    startdt: utcExtended(event.start),
    enddt: utcExtended(endOf(event)),
    allday: "false",
    // One line: Outlook treats the body as HTML and would run separate lines together.
    body: `Join the meeting: ${event.link}`,
    location: event.link,
  })}`;
}

/* --------------------------------------------------------------------- .ics */

/** Text values escape backslash, semicolon, comma and line breaks (RFC 5545, 3.3.11). */
export function icsText(value: string): string {
  return value
    .replace(/\\/g, "\\\\")
    .replace(/;/g, "\\;")
    .replace(/,/g, "\\,")
    .replace(/\r\n|\r|\n/g, "\\n");
}

/** Lines are at most 75 bytes; longer ones continue on the next line after a space (RFC 5545, 3.1). */
export function icsFold(line: string): string {
  const encoder = new TextEncoder();
  if (encoder.encode(line).length <= 75) return line;
  const parts: string[] = [];
  let current = "";
  let bytes = 0;
  for (const character of line) {
    const size = encoder.encode(character).length;
    // Continuation lines start with a space, which counts towards their 75.
    if (bytes + size > (parts.length === 0 ? 75 : 74)) {
      parts.push(current);
      current = "";
      bytes = 0;
    }
    current += character;
    bytes += size;
  }
  parts.push(current);
  return parts.join("\r\n ");
}

/**
 * An iCalendar file with the one event, for Apple Calendar, desktop Outlook and anything else
 * that opens .ics. It carries a reminder ten minutes before.
 */
export function icsFile(event: CalendarEvent, now: Date = new Date()): string {
  const code = event.link.split("/").pop() || "meeting";
  let host = "meetly";
  try {
    host = new URL(event.link).hostname || host;
  } catch {
    // Not an absolute address: the plain name will do for the id.
  }
  const lines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//Meetly//Meeting link//EN",
    "CALSCALE:GREGORIAN",
    "METHOD:PUBLISH",
    "BEGIN:VEVENT",
    `UID:${code}-${utcBasic(event.start)}@${host}`,
    `DTSTAMP:${utcBasic(now)}`,
    `DTSTART:${utcBasic(event.start)}`,
    `DTEND:${utcBasic(endOf(event))}`,
    `SUMMARY:${icsText(event.title)}`,
    `DESCRIPTION:${icsText(describe(event))}`,
    `LOCATION:${icsText(event.link)}`,
    `URL:${event.link}`,
    "BEGIN:VALARM",
    "ACTION:DISPLAY",
    `DESCRIPTION:${icsText(event.title)}`,
    "TRIGGER:-PT10M",
    "END:VALARM",
    "END:VEVENT",
    "END:VCALENDAR",
  ];
  return `${lines.map(icsFold).join("\r\n")}\r\n`;
}

export function icsFileName(event: CalendarEvent): string {
  const name = event.title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
  return `${name || "meeting"}.ics`;
}
