"use client";

import { useEffect, useState } from "react";
import { elapsedSeconds, formatElapsed, meetingClock, spokenElapsed, timerName } from "@/lib/meetingTime";
import { useCall, useJoinedAt } from "@/lib/rtc/react";
import { Tip } from "./ui/Tip";

type Look = { className: string; tip: boolean };

/**
 * How long the meeting has been running: "23:15", then "1:02:03" past an hour.
 *
 * It counts from when the meeting began, as the server said when you joined (see
 * `RtcCall.meetingStart`), or from when you joined if that could not be known, and is then named
 * "Time since you joined". Nothing is asked of any server while it runs.
 *
 * It is its own component so that each second re-renders this text and nothing around it. A
 * screen reader is not told every second: it is a `timer` that is not live, named in whole minutes.
 * `tip`: pointing at it says what it counts (large screens; a phone has the accessible name only).
 */
export function MeetingTimer({ className = "", tip = false }: { className?: string; tip?: boolean }) {
  const call = useCall();
  const joinedAt = useJoinedAt();
  const clock = meetingClock(call.meetingStart, joinedAt);
  const name = timerName(call.mode, clock?.known ?? true);
  const look = { className, tip };
  // Keyed on its start: a start that becomes known begins a fresh count instead of carrying on.
  return clock ? <Ticking key={clock.from} from={clock.from} name={name} look={look} /> : <Shown seconds={0} name={name} look={look} />;
}

/**
 * The timer in a phone's top bar: small and muted, right after the meeting code. It sits in an
 * `@container` that holds the code too, and when the bar is too full for both (a crowded bar on a
 * narrow phone) it steps out of the way whole, so neither the code nor anything to its right is
 * cut short. The widths are the code button's (a fixed-format code in a monospace face) plus this.
 */
export function PhoneTimer() {
  return <MeetingTimer className="text-xs font-medium text-muted @max-[13rem]:hidden data-[hours=true]:@max-[14.25rem]:hidden" />;
}

function Ticking({ from, name, look }: { from: number; name: string; look: Look }) {
  const [seconds, setSeconds] = useState(() => elapsedSeconds(from, Date.now()));
  useEffect(() => {
    // One timeout at a time, set for the moment the count next turns over, so it neither drifts
    // nor skips a second. A hidden tab's timeouts are slowed by the browser; each one recounts
    // from the start, so the time is right again as soon as anyone looks.
    let timer: ReturnType<typeof setTimeout>;
    const schedule = () => {
      const since = Math.max(0, Date.now() - from);
      timer = setTimeout(() => {
        setSeconds(elapsedSeconds(from, Date.now()));
        schedule();
      }, 1000 - (since % 1000) + 5);
    };
    schedule();
    return () => clearTimeout(timer);
  }, [from]);
  return <Shown seconds={seconds} name={name} look={look} />;
}

function Shown({ seconds, name, look }: { seconds: number; name: string; look: Look }) {
  const text = (
    <span
      role="timer"
      aria-live="off"
      aria-label={spokenElapsed(name, seconds)}
      data-meeting-timer
      // Past an hour it is two characters wider; the bar's room for it is measured on that.
      data-hours={seconds >= 3600}
      className={`shrink-0 tabular-nums ${look.className}`}
    >
      <span aria-hidden="true">{formatElapsed(seconds)}</span>
    </span>
  );
  return look.tip ? <Tip label={name}>{text}</Tip> : text;
}
