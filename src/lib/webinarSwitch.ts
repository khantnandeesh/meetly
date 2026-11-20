"use client";

import { useEffect, useState } from "react";

/**
 * Whether the home page offers "New webinar". The page is static, so it asks the server, which
 * reads `MEETLY_WEBINARS_ENABLED` at that moment: switching webinars off hides the item at once,
 * without a rebuild. Until the answer comes, and if the server cannot be asked, it is not
 * offered: an item that appears and then vanishes, or one that can only fail, would be wrong.
 */
export async function webinarsOffered(): Promise<boolean> {
  try {
    const response = await fetch("/api/meeting", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "webinars" }),
      cache: "no-store",
    });
    const data = response.ok ? ((await response.json()) as { enabled?: unknown }) : null;
    return data?.enabled === true;
  } catch {
    return false;
  }
}

/** `webinarsOffered()` as a hook: false until the server says yes. */
export function useWebinarsOffered(): boolean {
  const [offered, setOffered] = useState(false);
  useEffect(() => {
    let current = true;
    void webinarsOffered().then((answer) => {
      if (current) setOffered(answer);
    });
    return () => {
      current = false;
    };
  }, []);
  return offered;
}
