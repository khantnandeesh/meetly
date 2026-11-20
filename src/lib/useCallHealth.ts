"use client";

import { useCallback, useEffect, useState } from "react";
import { HEALTH_START, dismissHealth, stepHealth } from "./callHealth";
import { useCallQuality, useConnectionStatus } from "./rtc/react";

/** Whether to show the "weak connection" notice right now, and the way to dismiss it. The timing is in ./callHealth.ts. */
export function useCallHealth(): { weak: boolean; dismiss: () => void } {
  const { connection } = useCallQuality();
  // While reconnecting, "Reconnecting…" is the signal; a second one would say the same thing.
  const poor = useConnectionStatus() === "connected" && connection === "poor";
  const [state, setState] = useState(HEALTH_START);
  useEffect(() => {
    const step = () => setState((current) => stepHealth(current, Date.now(), poor));
    const first = setTimeout(step, 0);
    // The clock only runs while there is something to wait for.
    const timer = poor || state.shown ? setInterval(step, 1000) : undefined;
    return () => {
      clearTimeout(first);
      clearInterval(timer);
    };
  }, [poor, state.shown]);
  const dismiss = useCallback(() => setState(dismissHealth(Date.now())), []);
  return { weak: state.shown, dismiss };
}
