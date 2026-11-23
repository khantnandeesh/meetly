import Link from "next/link";

/** The Meetly mark: a lowercase "m" drawn as two people side by side. */
export function LogoMark({ className = "size-8" }: { className?: string }) {
  return (
    <svg viewBox="0 0 32 32" className={className} aria-hidden="true">
      <rect width="32" height="32" rx="9" fill="var(--accent)" />
      <path
        d="M8.5 22v-7.5a3.75 3.75 0 0 1 7.5 0V22m0-7.5a3.75 3.75 0 0 1 7.5 0V22"
        fill="none"
        stroke="var(--accent-ink)"
        strokeWidth="3"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

/**
 * `onNavigate`: called when following the logo would navigate within the app (not when it opens a
 * new tab or window); it may call `preventDefault()` to stay, as a live webinar's host does to ask.
 */
export function Logo({ onNavigate }: { onNavigate?: (event: { preventDefault: () => void }) => void } = {}) {
  return (
    <Link
      href="/"
      onNavigate={onNavigate}
      className="inline-flex items-center gap-2.5 rounded-xl py-1 pr-2 font-display text-[1.375rem] font-semibold tracking-tight"
      aria-label="Meetly home"
    >
      <LogoMark />
      <span>Meetly</span>
    </Link>
  );
}
