"use client";

import { CalendarPlus, ChevronDown, CircleAlert, Link2, LoaderCircle, Plus, Presentation, Radio } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { HeroArt } from "@/components/HeroArt";
import { FeatureGrid } from "@/components/home/FeatureGrid";
import { JoinForm } from "@/components/JoinForm";
import { ScheduleDialog } from "@/components/ScheduleDialog";
import { Logo } from "@/components/ui/Logo";
import { Dropdown } from "@/components/ui/Menu";
import { useToast } from "@/components/ui/Toaster";
import { generateCode } from "@/lib/code";
import { createMeeting, createWebinar } from "@/lib/rtc/provider";
import { useWebinarsOffered } from "@/lib/webinarSwitch";

export default function Home() {
  const router = useRouter();
  const [starting, setStarting] = useState(false);
  // The menu covers part of the illustration on a phone; its floating message steps aside.
  const [menuOpen, setMenuOpen] = useState(false);

  // The server makes the meeting, with this browser as its host. If it cannot be asked, any new
  // code works as well: the first person into it becomes host instead.
  async function start() {
    setStarting(true);
    router.push(`/${(await createMeeting()) ?? generateCode()}`);
  }

  // A meeting for later is made the same way, so the person planning it is its host. Only the
  // link is shown; nobody is taken into the call.
  // A webinar is made only here, and is one for good: the link cannot become a meeting later.
  // Unlike a meeting, a made-up code will not do, so a failure is said rather than worked around.
  const toast = useToast();
  const webinarsOffered = useWebinarsOffered();
  async function startWebinar() {
    setStarting(true);
    try {
      router.push(`/${await createWebinar()}`);
    } catch (error) {
      setStarting(false);
      toast.push({
        tone: "danger",
        icon: <CircleAlert className="size-5" />,
        title: "Couldn't start the webinar",
        body: error instanceof Error ? error.message : undefined,
      });
    }
  }

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
      </header>

      <main className="mx-auto flex w-full max-w-6xl flex-1 flex-col justify-center gap-16 px-5 pt-8 pb-16 sm:px-8 lg:gap-20">
        <div className="grid items-center gap-x-12 gap-y-16 lg:grid-cols-[minmax(0,1.05fr)_minmax(0,1fr)]">
          <section className="anim-rise flex flex-col gap-8">
            <div className="flex flex-col gap-5">
              <h1 className="font-display text-[clamp(2.5rem,6vw,4.25rem)] leading-[1.02] font-semibold tracking-[-0.03em] text-balance">
                Video meetings, <span className="text-accent">one link</span> away
              </h1>
              <p className="max-w-[34rem] text-lg leading-relaxed text-pretty text-muted">
                Start a meeting and send the link. People join from their browser, with no account and no app.
              </p>
            </div>

            <div className="flex max-w-[34rem] flex-col gap-3 sm:flex-row sm:items-start">
              {/* One tap starts a meeting now; the arrow holds only the ways to have one later. */}
              <div className="flex shrink-0 gap-px">
                <button className="btn btn-primary flex-1 rounded-r-md" onClick={start} disabled={starting || preparing}>
                  {starting ? (
                    <LoaderCircle className="anim-spin size-[1.125rem]" aria-hidden="true" />
                  ) : (
                    <Plus className="size-[1.125rem]" strokeWidth={2.5} aria-hidden="true" />
                  )}
                  New meeting
                </button>
                <Dropdown.Root onOpenChange={setMenuOpen}>
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
                      <Dropdown.Item className="menu-item" onSelect={() => void plan("link")}>
                        <Link2 className="size-4 text-muted" aria-hidden="true" />
                        Get a link for later
                      </Dropdown.Item>
                      <Dropdown.Item className="menu-item" onSelect={() => void plan("schedule")}>
                        <CalendarPlus className="size-4 text-muted" aria-hidden="true" />
                        Schedule…
                      </Dropdown.Item>
                      {webinarsOffered && (
                        <>
                          <div className="menu-sep" />
                          <Dropdown.Item className="menu-item" onSelect={() => void startWebinar()}>
                            <Presentation className="size-4 text-muted" aria-hidden="true" />
                            New webinar
                          </Dropdown.Item>
                        </>
                      )}
                      <div className="menu-sep" />
                      <Dropdown.Item className="menu-item" onSelect={() => router.push("/live")}>
                        <Radio className="size-4 text-muted" aria-hidden="true" />
                        Go live (beta)
                      </Dropdown.Item>
                    </Dropdown.Content>
                  </Dropdown.Portal>
                </Dropdown.Root>
              </div>
              <JoinForm />
            </div>
          </section>

          <div className="anim-rise -mx-1 [animation-delay:120ms] sm:mx-0 sm:px-8 lg:px-0 lg:pl-6">
            <HeroArt quiet={menuOpen} />
          </div>
        </div>

        <FeatureGrid />
      </main>

      <ScheduleDialog code={planned?.code ?? null} mode={planned?.mode} open={planning} onOpenChange={setPlanning} />
    </div>
  );
}
