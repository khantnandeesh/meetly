"use client";

import { Hourglass } from "lucide-react";
import { useEffect } from "react";
import { useCall } from "@/lib/rtc/react";
import { limitWarningText } from "@/lib/webinarLimit";
import { useToast } from "./ui/Toaster";

const TAG = "webinar-limit";
/** Long enough to be read and acted on (wrap up, tell the audience), short of staying in the way. */
const SHOWN_MS = 15_000;

/**
 * Tells the host and co-hosts of a free webinar that it is about to reach its time limit, with
 * roughly how long is left at the current rate. The call only has a warning for them (see
 * `limitWarning` in src/lib/rtc/types.ts), once per session. It is about what is happening to
 * the host's own webinar, so it is a "you" notification. Renders nothing itself.
 */
export function LimitNotice() {
  const call = useCall();
  const toast = useToast();
  useEffect(() => {
    const show = () => {
      const warning = call.limitWarning;
      if (!warning) return toast.dismissTag(TAG);
      toast.push({
        priority: "you",
        tag: TAG,
        icon: <Hourglass className="size-5" />,
        title: limitWarningText(warning.endsAt, Date.now()),
        duration: SHOWN_MS,
      });
    };
    if (call.limitWarning) show();
    return call.on("limitWarning", show);
  }, [call, toast]);
  return null;
}
