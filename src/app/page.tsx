"use client";

import { CalendarPlus, ChevronDown, Link2, LoaderCircle, MessagesSquare, MonitorUp, Plus, Video } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { HeroArt } from "@/components/HeroArt";
import { JoinForm } from "@/components/JoinForm";
import { ScheduleDialog } from "@/components/ScheduleDialog";
import { Logo } from "@/components/ui/Logo";
import { Dropdown } from "@/components/ui/Menu";
import { generateCode } from "@/lib/code";
import { createMeeting } from "@/lib/rtc/provider";

const FEATURES = [
  {
    icon: Link2,
    title: "One link, no sign-up",
    body: "Every meeting is a short link. Anyone who has it joins straight from their browser.",
  },
  {
    icon: MonitorUp,
    title: "Share your screen",
    body: "Present a tab, a window or everything. The layout refocuses around what you share.",
  },
  {
    icon: MessagesSquare,
    title: "Chat and raise hands",
    body: "Side messages and a visible hand queue keep bigger calls orderly.",
  },
];

export default function Home() {
  const router = useRouter();
  const [starting, setStarting] = useState(false);

  // The server makes the meeting, with this browser as its host. If it cannot be asked, any new
  // code works as well: the first person into it becomes host instead.
  async function start() {
    setStarting(true);
    router.push(`/${(await createMeeting()) ?? generateCode()}`);
  }

  // A meeting for later is made the same way, so the person planning it is its host. Only the
  // link is shown; nobody is taken into the call.
  const [planned, setPlanned] = useState<{ code: string; mode: "link" | "schedule" } | null>(null);
  const [planning, setPlanning] = useState(false);
  const [preparing, setPreparing] = useState(false);
  async function plan(mode: "link" | "schedule") {
    setPreparing(true);
    const code = (await createMeeting()) ?? generateCode();
    setPreparing(false);
    setPlanned({ code, mode });
    setPlanning(true);
  }

  return (
    <div className="backdrop-glow flex flex-1 flex-col">
      <header className="mx-auto flex w-full max-w-6xl items-center justify-between px-5 py-5 sm:px-8">
        <Logo />
        <span className="hidden items-center gap-2 text-sm text-muted sm:flex">
          <span className="size-1.5 rounded-full bg-accent" aria-hidden="true" />
          Free, and nothing to install
        </span>
      </header>

      <main className="mx-auto flex w-full max-w-6xl flex-1 flex-col justify-center gap-16 px-5 pt-8 pb-16 sm:px-8 lg:gap-20">
        <div className="grid items-center gap-x-12 gap-y-16 lg:grid-cols-[minmax(0,1.05fr)_minmax(0,1fr)]">
          <section className="anim-rise flex flex-col gap-8">
            <div className="flex flex-col gap-5">
              <h1 className="font-display text-[clamp(2.5rem,6vw,4.25rem)] leading-[1.02] font-semibold tracking-[-0.03em] text-balance">
                Video meetings, <span className="text-accent">one link</span> away
              </h1>
              <p className="max-w-[34rem] text-lg leading-relaxed text-pretty text-muted">
                Start a meeting and send the link. Nobody needs an account or an app — they open it and
                they&apos;re in.
              </p>
            </div>

            <div className="flex max-w-[34rem] flex-col gap-3 sm:flex-row sm:items-start">
              {/* One tap still starts a meeting now; the arrow holds the ways to have one later. */}
              <div className="flex shrink-0 gap-px">
                <button className="btn btn-primary flex-1 rounded-r-md" onClick={start} disabled={starting || preparing}>
                  {starting ? (
                    <LoaderCircle className="anim-spin size-[1.125rem]" aria-hidden="true" />
                  ) : (
                    <Plus className="size-[1.125rem]" strokeWidth={2.5} aria-hidden="true" />
                  )}
                  New meeting
                </button>
                <Dropdown.Root>
                  <Dropdown.Trigger
                    className="btn btn-primary group w-11 rounded-l-md px-0"
                    aria-label="More ways to start a meeting"
                    disabled={starting || preparing}
                  >
                    {preparing ? (
                      <LoaderCircle className="anim-spin size-[1.125rem]" aria-hidden="true" />
                    ) : (
                      <ChevronDown className="size-[1.125rem] transition-transform group-aria-expanded:rotate-180" strokeWidth={2.5} aria-hidden="true" />
                    )}
                  </Dropdown.Trigger>
                  <Dropdown.Portal>
                    <Dropdown.Content align="start" sideOffset={8} collisionPadding={12} className="menu min-w-60">
                      <Dropdown.Item className="menu-item" onSelect={start}>
                        <Video className="size-4 text-muted" aria-hidden="true" />
                        Start now
                      </Dropdown.Item>
                      <Dropdown.Item className="menu-item" onSelect={() => void plan("link")}>
                        <Link2 className="size-4 text-muted" aria-hidden="true" />
                        Get a link for later
                      </Dropdown.Item>
                      <Dropdown.Item className="menu-item" onSelect={() => void plan("schedule")}>
                        <CalendarPlus className="size-4 text-muted" aria-hidden="true" />
                        Schedule…
                      </Dropdown.Item>
                    </Dropdown.Content>
                  </Dropdown.Portal>
                </Dropdown.Root>
              </div>
              <JoinForm />
            </div>
          </section>

          <div className="anim-rise px-3 [animation-delay:120ms] sm:px-8 lg:px-0 lg:pl-6">
            <HeroArt />
          </div>
        </div>

        <ul className="anim-rise grid gap-x-10 gap-y-8 border-t border-border pt-10 [animation-delay:200ms] sm:grid-cols-3">
          {FEATURES.map(({ icon: Icon, title, body }) => (
            <li key={title} className="flex gap-4 sm:flex-col">
              <span className="grid size-10 shrink-0 place-items-center rounded-xl bg-surface-2 text-accent shadow-[inset_0_0_0_1px_var(--border)]">
                <Icon className="size-5" aria-hidden="true" />
              </span>
              <div>
                <h2 className="font-semibold">{title}</h2>
                <p className="mt-1 text-[0.9375rem] leading-relaxed text-muted">{body}</p>
              </div>
            </li>
          ))}
        </ul>
      </main>

      <footer className="mx-auto w-full max-w-6xl px-5 pb-8 text-sm text-faint sm:px-8">
        Your camera and microphone stay off until you allow them.
      </footer>

      <ScheduleDialog code={planned?.code ?? null} mode={planned?.mode} open={planning} onOpenChange={setPlanning} />
    </div>
  );
}
