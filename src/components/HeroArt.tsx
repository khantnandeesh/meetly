import { Hand, MessageSquare, Mic, MicOff, MonitorUp, PhoneOff, Video } from "lucide-react";
import { initials } from "./ui/Avatar";

const PEOPLE = [
  { name: "Maya Okafor", color: "#9fe0c2", speaking: true, muted: false },
  { name: "Jonas Weber", color: "#f4b9a3", speaking: false, muted: true },
  { name: "Priya Nair", color: "#a9d6f5", speaking: false, muted: false, hand: true },
  { name: "Tomás Leal", color: "#c9b8f7", speaking: false, muted: true },
];

/** Decorative illustration of a call for the home page. Not a screenshot; purely ornamental. */
export function HeroArt({ quiet = false }: { quiet?: boolean }) {
  return (
    <div className="relative mx-auto w-full max-w-[34rem] select-none" aria-hidden="true">
      <div className="rounded-[2rem] bg-surface p-3 shadow-[inset_0_0_0_1px_var(--border),0_40px_80px_-30px_rgb(0_0_0/0.8)]">
        <div className="grid grid-cols-2 gap-2">
          {PEOPLE.map((person) => {
            const color = person.color;
            return (
              <div
                key={person.name}
                className="relative grid aspect-[4/3] place-items-center overflow-hidden rounded-2xl"
                style={{
                  background: `radial-gradient(120% 120% at 50% 0%, color-mix(in srgb, ${color} 20%, var(--surface-2)), var(--surface-2) 70%)`,
                  boxShadow: person.speaking ? "inset 0 0 0 2.5px var(--accent)" : "inset 0 0 0 1px rgb(255 255 255 / 0.05)",
                }}
              >
                <span
                  className="grid size-[34%] place-items-center rounded-full font-display text-[clamp(1rem,3.4vw,1.5rem)] font-semibold text-[#16161d] [aspect-ratio:1] [height:auto]"
                  style={{ background: color }}
                >
                  {initials(person.name)}
                </span>
                {"hand" in person && (
                  // A raised hand shows on the tile, as in a call; it is not a notification.
                  <span className="absolute top-2 left-2 grid size-6 place-items-center rounded-lg bg-accent text-accent-ink">
                    <Hand className="size-3.5" />
                  </span>
                )}
                <span className="chip absolute bottom-2 left-2 h-6 px-1.5 text-[0.6875rem]">
                  {person.speaking ? (
                    <span className="bars text-accent">
                      <i />
                      <i />
                      <i />
                    </span>
                  ) : person.muted ? (
                    <MicOff className="size-3 text-danger-text" />
                  ) : null}
                  {person.name.split(" ")[0]}
                </span>
              </div>
            );
          })}
        </div>
        <div className="mt-3 flex items-center justify-center gap-1.5">
          {[Mic, Video, MonitorUp, Hand].map((Icon, i) => (
            <span
              key={i}
              className={`grid size-9 place-items-center rounded-xl ${i === 3 ? "bg-accent text-accent-ink" : "bg-surface-2 text-text"}`}
            >
              <Icon className="size-4" />
            </span>
          ))}
          <span className="grid h-9 w-12 place-items-center rounded-xl bg-danger text-white">
            <PhoneOff className="size-4" />
          </span>
        </div>
      </div>

      {/* What a message looks like when it arrives: one notification, clear of the controls. It
          steps out of the way of the New meeting menu, which on a phone would cut it in half. */}
      <div
        data-hero-bubble
        data-quiet={quiet || undefined}
        className="anim-float absolute -top-4 -right-3 flex max-w-48 items-start gap-2.5 rounded-2xl bg-surface-2 p-3 text-sm shadow-[inset_0_0_0_1px_var(--border-strong),0_16px_40px_-12px_rgb(0_0_0/0.7)] transition-opacity duration-(--dur-fast) data-quiet:opacity-0 sm:-right-6"
      >
        <MessageSquare className="mt-0.5 size-4 shrink-0 text-accent" />
        <span>
          <span className="block text-xs font-semibold text-muted">Jonas</span>
          Dropping the doc in chat now
        </span>
      </div>
    </div>
  );
}
