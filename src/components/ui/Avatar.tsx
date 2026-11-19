const PALETTE = ["#f4b9a3", "#a9d6f5", "#c9b8f7", "#f5d67a", "#9fe0c2", "#f4a9c8"];

/** Stable pastel colour for a participant, derived from their identity. */
export function avatarColor(seed: string): string {
  let hash = 0;
  for (let i = 0; i < seed.length; i++) hash = (hash * 31 + seed.charCodeAt(i)) | 0;
  return PALETTE[Math.abs(hash) % PALETTE.length];
}

export function initials(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return "?";
  const first = Array.from(words[0])[0] ?? "";
  const last = words.length > 1 ? (Array.from(words[words.length - 1])[0] ?? "") : "";
  return (first + last).toUpperCase();
}

export function Avatar({
  name,
  seed,
  className = "size-9 text-sm",
  speaking = false,
}: {
  name: string;
  seed?: string;
  className?: string;
  speaking?: boolean;
}) {
  return (
    <span
      aria-hidden="true"
      className={`grid shrink-0 place-items-center rounded-full font-display font-semibold text-[#16161d] transition-shadow duration-(--dur-base) select-none ${className}`}
      style={{
        background: avatarColor(seed ?? name),
        boxShadow: speaking ? "0 0 0 2px var(--surface), 0 0 0 4px var(--accent)" : undefined,
      }}
    >
      {initials(name)}
    </span>
  );
}
