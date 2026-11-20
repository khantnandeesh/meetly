import { Check, Link2 } from "lucide-react";

/** The link icon of a copy button, which turns into a tick for a moment once the link is copied. */
export function CopyIcon({ copied, className = "size-4" }: { copied: boolean; className?: string }) {
  return copied ? (
    <Check className={`anim-pop shrink-0 text-accent ${className}`} aria-hidden="true" />
  ) : (
    <Link2 className={`shrink-0 ${className}`} aria-hidden="true" />
  );
}
