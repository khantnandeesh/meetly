"use client";

import { Tip } from "./Tip";

/**
 * An icon and two or three words, with the full sentence in a tooltip (on hover and on keyboard
 * focus) and for screen readers. For facts a screen would otherwise explain in a paragraph
 * (docs/UI-WRITING.md). Render inside a `<ul>`: see `Facts`.
 */
export function Fact({ icon, label, detail }: { icon: React.ReactNode; label: string; detail: string }) {
  return (
    <Tip label={detail}>
      <li tabIndex={0} className="-mx-1 inline-flex min-w-0 cursor-default items-center gap-1.5 rounded-lg px-1 text-sm" data-fact>
        <span className="shrink-0 text-accent [&>svg]:size-4" aria-hidden="true">
          {icon}
        </span>
        <span className="min-w-0">{label}</span>
        <span className="sr-only">: {detail}</span>
      </li>
    </Tip>
  );
}

/** A row of `Fact`s that wraps on a narrow screen. */
export function Facts({ children, label, className = "" }: { children: React.ReactNode; label?: string; className?: string }) {
  return (
    <ul className={`flex flex-wrap gap-x-4 gap-y-2 ${className}`} aria-label={label}>
      {children}
    </ul>
  );
}
