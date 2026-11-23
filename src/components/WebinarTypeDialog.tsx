"use client";

import * as Dialog from "@radix-ui/react-dialog";
import { ChevronRight, LoaderCircle, Presentation, ServerOff, X } from "lucide-react";
import Link from "next/link";
import { useId } from "react";
import { LIVE_VIEWER_CAP } from "@/lib/live/tree";
import { SERVERLESS_LINE } from "@/lib/live/webinar";

const option =
  "group flex w-full min-w-0 cursor-pointer items-start gap-3 rounded-2xl bg-surface-2 p-4 text-left ring-1 ring-border transition-[background-color,box-shadow] duration-150 ring-inset hover:bg-surface-3 hover:ring-border-strong aria-disabled:cursor-not-allowed aria-disabled:hover:bg-surface-2 aria-disabled:hover:ring-border sm:gap-4";
const tile = "grid size-8 shrink-0 place-items-center rounded-xl sm:size-10";
const chevron = "mt-2.5 hidden size-5 shrink-0 text-faint transition-transform group-hover:translate-x-0.5 sm:block";

/**
 * "New webinar…" on the home page: the choice between the two kinds, each said in one honest line.
 *
 * - Standard: the webinar call (src/lib/useWebinar.ts), whose video goes through the media
 *   provider's servers. Offered only while the server says webinars are on; otherwise it is shown,
 *   disabled, with the reason, so the choice still reads as a choice.
 * - Serverless (beta): Live (/live, packages/overlay), whose video goes browser to browser. Its
 *   limits are said up front: the audience cap, one person on camera, viewers relaying.
 *
 * The focus opens on the first kind that can be chosen, not on Close.
 */
export function WebinarTypeDialog({
  open,
  onOpenChange,
  standardOffered,
  startingStandard,
  onStandard,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  standardOffered: boolean;
  startingStandard: boolean;
  onStandard: () => void;
}) {
  const unavailable = useId();
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="dialog-overlay fixed inset-0 z-50 bg-black/70" />
        <Dialog.Content
          data-webinar-type-dialog
          onOpenAutoFocus={(event) => {
            event.preventDefault();
            (event.currentTarget as HTMLElement).querySelector<HTMLElement>("[data-webinar-type]:not([aria-disabled])")?.focus();
          }}
          className="dialog fixed top-1/2 left-1/2 z-50 flex max-h-[calc(100dvh-2rem)] w-[min(32rem,calc(100vw-2rem))] -translate-x-1/2 -translate-y-1/2 flex-col overflow-hidden rounded-3xl bg-surface shadow-[inset_0_0_0_1px_var(--border-strong),0_30px_80px_-20px_rgb(0_0_0/0.8)]"
        >
          <div className="flex items-center justify-between py-3 pr-3 pl-6">
            <Dialog.Title className="font-display text-xl font-semibold">Start a webinar</Dialog.Title>
            <Dialog.Close className="icon-btn" aria-label="Close">
              <X className="size-5" aria-hidden="true" />
            </Dialog.Close>
          </div>
          <div className="scroll-quiet flex flex-col gap-3 overflow-y-auto px-4 pb-4 sm:px-6 sm:pb-6">
            <Dialog.Description className="mb-1 px-2 text-sm leading-relaxed text-muted sm:px-0">
              You present and everyone else watches. Choose how the video reaches them.
            </Dialog.Description>

            <button
              type="button"
              className={option}
              onClick={standardOffered && !startingStandard ? onStandard : undefined}
              aria-disabled={!standardOffered || startingStandard || undefined}
              aria-describedby={standardOffered ? undefined : unavailable}
              data-webinar-type="standard"
            >
              <span className={`${tile} bg-surface-3 ${standardOffered ? "text-text" : "text-faint"}`} aria-hidden="true">
                {startingStandard ? <LoaderCircle className="anim-spin size-5" /> : <Presentation className="size-[1.125rem] sm:size-5" />}
              </span>
              <span className="flex min-w-0 flex-1 flex-col gap-1">
                <span className={`font-semibold ${standardOffered ? "" : "text-muted"}`}>Standard webinar</span>
                <span className="text-sm leading-snug text-pretty text-muted">Video goes through our video servers. Bring people on stage, with chat, raised hands and polls.</span>
                {!standardOffered && (
                  <span id={unavailable} className="text-sm font-medium text-faint">
                    Switched off on this server right now.
                  </span>
                )}
              </span>
              {standardOffered && <ChevronRight className={chevron} aria-hidden="true" />}
            </button>

            <Link href="/live" className={option} data-webinar-type="serverless">
              <span className={`${tile} bg-accent/12 text-accent`} aria-hidden="true">
                <ServerOff className="size-[1.125rem] sm:size-5" />
              </span>
              <span className="flex min-w-0 flex-1 flex-col gap-1">
                <span className="inline-flex flex-wrap items-center gap-x-2 gap-y-1 font-semibold">
                  Serverless webinar
                  <span className="inline-flex h-5 items-center rounded-md px-1.5 text-[0.6875rem] font-semibold tracking-wide text-accent uppercase ring-1 ring-accent/40 ring-inset">
                    Beta
                  </span>
                </span>
                <span className="text-sm leading-snug text-pretty text-muted">{SERVERLESS_LINE}</span>
                <span className="text-sm leading-snug text-pretty text-faint">
                  Up to {LIVE_VIEWER_CAP} viewers, just you on camera. Viewers’ browsers pass the video on to each other.
                </span>
              </span>
              <ChevronRight className={chevron} aria-hidden="true" />
            </Link>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
