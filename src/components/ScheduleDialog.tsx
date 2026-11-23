"use client";

import * as Dialog from "@radix-ui/react-dialog";
import { CalendarPlus, CircleAlert, Download, ExternalLink, X } from "lucide-react";
import { useId, useMemo, useState } from "react";
import {
  DEFAULT_TITLE,
  DURATIONS,
  googleCalendarUrl,
  icsFile,
  icsFileName,
  localDateTime,
  nextHalfHour,
  outlookCalendarUrl,
  toFieldValues,
  type CalendarEvent,
} from "@/lib/calendar";
import { downloadText } from "@/lib/chatExport";
import { copyText, useCopied } from "@/lib/hooks";
import { CopyIcon } from "./ui/CopyIcon";
import { Tip } from "./ui/Tip";

const durationLabel = (minutes: number) =>
  minutes < 60 ? `${minutes} minutes` : minutes === 60 ? "1 hour" : minutes % 60 === 0 ? `${minutes / 60} hours` : `${minutes / 60} hours`.replace(".5", "½");

/**
 * A meeting for later: its link, and a way to put it in a calendar. Meetly keeps nothing of
 * this. The link is made the same way an instant meeting's is and never expires; the title and
 * time go only into the calendar entry, which the person's own calendar creates.
 *
 * `mode` "link" leads with the link and offers the calendar second; "schedule" opens straight
 * on the calendar form; "follow-up" is the same form for the meeting that just ended, offered
 * to its host on the screen after it (never during it: while the meeting runs, the people it
 * would be sent to are in it).
 */
export function ScheduleDialog({
  code,
  mode = "schedule",
  open,
  onOpenChange,
}: {
  /** The meeting to schedule. Null while there is none (the dialog is closed). */
  code: string | null;
  mode?: Mode;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  return (
    <Dialog.Root open={open && code !== null} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="dialog-overlay fixed inset-0 z-50 bg-black/70" />
        <Dialog.Content
          aria-describedby={undefined}
          data-schedule-dialog
          className="dialog fixed top-1/2 left-1/2 z-50 flex max-h-[calc(100dvh-2rem)] w-[min(30rem,calc(100vw-2rem))] -translate-x-1/2 -translate-y-1/2 flex-col overflow-hidden rounded-3xl bg-surface shadow-[inset_0_0_0_1px_var(--border-strong),0_30px_80px_-20px_rgb(0_0_0/0.8)]"
        >
          <div className="flex items-center justify-between py-3 pr-3 pl-6">
            <Dialog.Title className="font-display text-xl font-semibold">
              {mode === "link" ? "Your link for later" : mode === "follow-up" ? "Schedule a follow-up" : "Schedule a meeting"}
            </Dialog.Title>
            <Dialog.Close className="icon-btn" aria-label="Close">
              <X className="size-5" aria-hidden="true" />
            </Dialog.Close>
          </div>
          {/* Mounted with the dialog, so the form starts from "now" each time it opens. */}
          {code !== null && <ScheduleForm code={code} mode={mode} />}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

type Mode = "link" | "schedule" | "follow-up";

function ScheduleForm({ code, mode }: { code: string; mode: Mode }) {
  const link = `${window.location.origin}/${code}`;
  // A follow-up is most often the same meeting a week on, so that is where it starts.
  const [initial] = useState(() => {
    const start = nextHalfHour();
    if (mode === "follow-up") start.setDate(start.getDate() + 7);
    return toFieldValues(start);
  });
  const [opened] = useState(() => Date.now());
  const [title, setTitle] = useState("");
  const [date, setDate] = useState(initial.date);
  const [time, setTime] = useState(initial.time);
  const [minutes, setMinutes] = useState<number>(30);
  const [planning, setPlanning] = useState(mode !== "link");
  const titleId = useId();
  const dateId = useId();
  const timeId = useId();
  const lengthId = useId();
  const errorId = useId();
  const copy = useCopied(() => copyText(link));

  const start = useMemo(() => localDateTime(date, time), [date, time]);
  // A minute's grace: "now" is a fair time to schedule for.
  const problem = !start ? "Choose a date and a start time." : start.getTime() < opened - 60_000 ? "That time has passed. Choose a later one." : null;
  const event: CalendarEvent | null = start && !problem ? { title: title.trim() || DEFAULT_TITLE, start, minutes, link } : null;
  const zone = useMemo(() => Intl.DateTimeFormat().resolvedOptions().timeZone, []);

  const calendars: { name: string; href?: string }[] = [
    { name: "Google Calendar", href: event ? googleCalendarUrl(event) : undefined },
    { name: "Outlook.com", href: event ? outlookCalendarUrl(event, "personal") : undefined },
    { name: "Microsoft 365", href: event ? outlookCalendarUrl(event, "work") : undefined },
  ];

  return (
    <div className="scroll-quiet flex flex-col gap-5 overflow-y-auto px-6 pb-6">
      <div className="flex flex-col gap-2">
        <p className="text-sm text-muted">{mode === "follow-up" ? "Same link. Never expires." : "Never expires."}</p>
        <button
          type="button"
          onClick={copy.copy}
          data-meeting-link={link}
          className="btn btn-secondary h-12 w-full justify-between rounded-xl bg-surface-2 px-3.5 text-sm"
        >
          <span className="min-w-0 truncate font-mono font-medium">{link.replace(/^https?:\/\//, "")}</span>
          <span className="inline-flex shrink-0 items-center gap-1.5 text-accent" role="status">
            <CopyIcon copied={copy.copied} />
            {copy.copied ? "Copied" : "Copy link"}
          </span>
        </button>
      </div>

      {!planning ? (
        <button type="button" className="btn btn-secondary" onClick={() => setPlanning(true)}>
          <CalendarPlus className="size-[1.125rem]" aria-hidden="true" />
          Add to calendar…
        </button>
      ) : (
        <>
          <div className="flex flex-col gap-4 border-t border-border pt-5">
            <div className="flex flex-col gap-2">
              <label htmlFor={titleId} className="text-sm font-medium text-muted">
                Title
              </label>
              <input
                id={titleId}
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                placeholder={DEFAULT_TITLE}
                maxLength={120}
                autoComplete="off"
                className="field"
              />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="flex min-w-0 flex-col gap-2">
                <label htmlFor={dateId} className="text-sm font-medium text-muted">
                  Date
                </label>
                <input
                  id={dateId}
                  type="date"
                  value={date}
                  onChange={(e) => setDate(e.target.value)}
                  aria-invalid={problem ? true : undefined}
                  aria-describedby={problem ? errorId : undefined}
                  className="field px-3"
                />
              </div>
              <div className="flex min-w-0 flex-col gap-2">
                <label htmlFor={timeId} className="text-sm font-medium text-muted">
                  Starts
                </label>
                <input
                  id={timeId}
                  type="time"
                  value={time}
                  onChange={(e) => setTime(e.target.value)}
                  aria-invalid={problem ? true : undefined}
                  aria-describedby={problem ? errorId : undefined}
                  className="field px-3"
                />
              </div>
            </div>
            <div className="flex flex-col gap-2">
              <label htmlFor={lengthId} className="text-sm font-medium text-muted">
                Length
              </label>
              <select id={lengthId} value={minutes} onChange={(e) => setMinutes(Number(e.target.value))} className="field cursor-pointer">
                {DURATIONS.map((value) => (
                  <option key={value} value={value}>
                    {durationLabel(value)}
                  </option>
                ))}
              </select>
            </div>
            {problem ? (
              <p id={errorId} role="alert" className="anim-fade flex items-start gap-2 text-sm text-danger-text">
                <CircleAlert className="mt-px size-4 shrink-0" aria-hidden="true" />
                {problem}
              </p>
            ) : (
              <p className="text-sm text-faint">Time zone: {zone.replace(/_/g, " ")}</p>
            )}
          </div>

          <div className="grid gap-2 sm:grid-cols-2" role="group" aria-label="Add to a calendar">
            {calendars.map(({ name, href }) => (
              // Real links, not window.open: nothing for a pop-up blocker to block.
              <a
                key={name}
                href={href}
                target="_blank"
                rel="noopener noreferrer"
                aria-disabled={href ? undefined : true}
                className="btn btn-secondary min-w-0 justify-between px-4"
              >
                <span className="min-w-0 truncate">{name}</span>
                <ExternalLink className="size-4 text-muted" aria-hidden="true" />
              </a>
            ))}
            <Tip label="For Apple Calendar, Outlook for desktop and most calendar apps">
              <button
                type="button"
                className="btn btn-secondary min-w-0 justify-between px-4"
                disabled={!event}
                onClick={() => {
                  if (event) downloadText(icsFileName(event), icsFile(event), "text/calendar");
                }}
              >
                <span className="min-w-0 truncate">Download .ics</span>
                <Download className="size-4 text-muted" aria-hidden="true" />
              </button>
            </Tip>
          </div>
          <p className="text-sm text-faint">Meetly sends no invitations. Your calendar does.</p>
        </>
      )}
    </div>
  );
}
