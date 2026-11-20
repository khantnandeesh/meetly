import type { RtcChatMessage } from "./rtc/types";

/**
 * The conversation as a plain text file, for "Save chat". Nothing is uploaded: the text is put
 * together in the browser from the messages it already holds, and saved by the browser.
 */

const pad = (n: number) => String(n).padStart(2, "0");

/** "2026-11-20 14:03" in `timeZone` (the browser's own when not given). */
function stamp(time: number | Date, timeZone?: string): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(time);
  const part = (type: string) => parts.find((entry) => entry.type === type)?.value ?? "";
  return `${part("year")}-${part("month")}-${part("day")} ${part("hour")}:${part("minute")}`;
}

/**
 * One line per message: "[date time] Name: text". Further lines of a message are indented, so a
 * name at the start of a line is always a real author and never something somebody typed.
 * Times are in the saver's own time zone, which the header names.
 */
export function formatChat(
  code: string,
  messages: RtcChatMessage[],
  options: { now?: Date; timeZone?: string; pinned?: RtcChatMessage | null } = {},
): string {
  const now = options.now ?? new Date();
  const timeZone = options.timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
  const name = (message: RtcChatMessage) => (message.from?.name || "Guest").replace(/[\r\n]+/g, " ");
  const body = (text: string) => text.replace(/\r\n?/g, "\n").split("\n").join("\r\n    ");
  const lines = [
    "Meetly chat",
    `Meeting: ${code}`,
    `Saved: ${stamp(now, timeZone)} (${timeZone})`,
    `Messages: ${messages.filter((message) => !message.deleted).length}`,
  ];
  const pinned = options.pinned;
  if (pinned && !pinned.deleted) lines.push(`Pinned: ${name(pinned)}: ${body(pinned.message)}`);
  lines.push("");
  for (const message of messages) {
    const text = message.deleted ? "(message deleted)" : body(message.message);
    lines.push(`[${stamp(message.timestamp, timeZone)}] ${name(message)}: ${text}`);
  }
  return `${lines.join("\r\n")}\r\n`;
}

export function chatFileName(code: string, now: Date = new Date()): string {
  const date = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}`;
  return `meetly-chat-${code}-${date}.txt`;
}

/** Hands `text` to the browser as a download. */
export function downloadText(filename: string, text: string, type = "text/plain"): void {
  // The byte-order mark makes older Windows editors read the file as UTF-8.
  const bom = type === "text/plain" ? "﻿" : "";
  const url = URL.createObjectURL(new Blob([bom, text], { type: `${type};charset=utf-8` }));
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

export function saveChat(code: string, messages: RtcChatMessage[], pinned?: RtcChatMessage | null): void {
  downloadText(chatFileName(code), formatChat(code, messages, { pinned }));
}
