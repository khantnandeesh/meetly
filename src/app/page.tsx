"use client";

import { CalendarPlus, ChevronDown, CircleAlert, Globe, Link2, LoaderCircle, Plus, Presentation, UserRoundX } from "lucide-react";
import { useRouter } from "next/navigation";
import { useLayoutEffect, useRef, useState } from "react";
import { HeroArt } from "@/components/HeroArt";
import { FeatureGrid } from "@/components/home/FeatureGrid";
import { JoinForm } from "@/components/JoinForm";
import { ScheduleDialog } from "@/components/ScheduleDialog";
import { Fact, Facts } from "@/components/ui/Fact";
import { Logo } from "@/components/ui/Logo";
import { Dropdown } from "@/components/ui/Menu";
import { useToast } from "@/components/ui/Toaster";
import { WebinarTypeDialog } from "@/components/WebinarTypeDialog";
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
  // "New webinar…" first asks which kind (WebinarTypeDialog): standard, through the media
  // provider, which the server may have switched off; or serverless (beta), browser to browser.
  const toast = useToast();
  const webinarsOffered = useWebinarsOffered();
  const [choosingWebinar, setChoosingWebinar] = useState(false);
  const moreWays = useRef<HTMLButtonElement>(null);
  // Leaving this page hides it (Cache Components keep it in an <Activity>) rather than unmounting
  // it, and a dialog left open, or still closing, stays in the document: the Toaster takes it for
  // one that has the person's attention and holds every notice back on the next page, the call
  // included. So the chooser closes as the page goes: before Standard's push, on Serverless's
  // link (WebinarTypeDialog), and here for any other way out (Back).
  useLayoutEffect(() => () => setChoosingWebinar(false), []);
  async function startWebinar() {
    setStarting(true);
    try {
      const code = await createWebinar();
      setChoosingWebinar(false);
      router.push(`/${code}`);
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
              <Facts className="text-muted">
                <Fact icon={<Globe />} label="In the browser" detail="People join from their browser. Nothing to install." />
                <Fact icon={<UserRoundX />} label="No account" detail="Nobody signs up, you included." />
              </Facts>
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
                    ref={moreWays}
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
                        Link for later
                      </Dropdown.Item>
                      <Dropdown.Item className="menu-item" onSelect={() => void plan("schedule")}>
                        <CalendarPlus className="size-4 text-muted" aria-hidden="true" />
                        Schedule…
                      </Dropdown.Item>
                      <div className="menu-sep" />
                      <Dropdown.Item className="menu-item" onSelect={() => setChoosingWebinar(true)}>
                        <Presentation className="size-4 text-muted" aria-hidden="true" />
                        New webinar…
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
      {/* Mounted only while open, so it leaves the document the moment it closes: its exit
          animation never ends on a page that is being hidden (see the useLayoutEffect above). */}
      {choosingWebinar && (
        <WebinarTypeDialog
          open
          onOpenChange={setChoosingWebinar}
          standardOffered={webinarsOffered}
          startingStandard={starting}
          onStandard={() => void startWebinar()}
          returnFocus={moreWays}
        />
      )}
    </div>
  );
}
