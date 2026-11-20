"use client";

import { Hand, LogOut, MessageSquare, Users } from "lucide-react";
import { badgeCount, shortCount } from "@/lib/counts";
import { useCopied } from "@/lib/hooks";
import { useCall } from "@/lib/rtc/react";
import { useUnread } from "./ChatStore";
import { ReactMenu } from "./Reactions";
import { CopyIcon } from "./ui/CopyIcon";
import { Tip } from "./ui/Tip";

export type ViewerPanel = "chat" | "people" | null;

/**
 * The webinar audience's controls: Raise hand, React, Leave. There is no microphone, camera or
 * screen to offer, so none is shown, not even switched off.
 *
 * On a desktop the bar is laid out as the meeting's is, so nothing moves when someone is brought
 * on stage: the left cluster says what is going on ("● Live · N watching") and holds the link, as
 * the clock and the link do in a meeting; Chat sits on the right, in the meeting's panel place,
 * and its badge counts new messages and polls waiting for a vote. A co-host, who moderates from
 * the audience, also has People there.
 */
export function ViewerControlBar({
  phone,
  code,
  watching,
  handRaised,
  onToggleHand,
  reactOpen,
  onReactOpenChange,
  panel,
  onTogglePanel,
  moderating,
  onCopyLink,
}: {
  phone: boolean;
  code: string;
  watching: number;
  handRaised: boolean;
  onToggleHand: () => void;
  reactOpen: boolean;
  onReactOpenChange: (open: boolean) => void;
  panel: ViewerPanel;
  onTogglePanel: (panel: Exclude<ViewerPanel, null>) => void;
  /** A co-host: the People panel is theirs too. */
  moderating: boolean;
  onCopyLink: () => Promise<boolean>;
}) {
  const call = useCall();
  const copy = useCopied(onCopyLink);
  const handLabel = handRaised ? "Lower hand" : "Raise hand";
  const hand = (
    <Tip label={handLabel}>
      <button className="ctrl" data-ctl={handRaised ? "active" : "on"} aria-label={handLabel} aria-pressed={handRaised} onClick={onToggleHand}>
        <Hand className="size-5" />
      </button>
    </Tip>
  );
  // The hand has its own button here, so the strip is the plain one even on a phone.
  const react = <ReactMenu phone={false} open={reactOpen} onOpenChange={onReactOpenChange} handRaised={handRaised} onToggleHand={onToggleHand} />;
  const leave = (
    <Tip label="Leave webinar">
      <button className="ctrl ctrl-danger md:w-16" aria-label="Leave webinar" onClick={() => call.disconnect().catch(() => {})}>
        <LogOut className="size-5" />
      </button>
    </Tip>
  );
  const chat = <ChatToggle open={panel === "chat"} onToggle={() => onTogglePanel("chat")} />;

  if (phone) {
    return (
      <footer data-viewer-bar className="px-3 pt-1 pb-[max(0.75rem,env(safe-area-inset-bottom))]">
        <div className="mx-auto flex max-w-xs items-center justify-between" role="toolbar" aria-label="Webinar controls">
          {hand}
          {react}
          {chat}
          {leave}
        </div>
      </footer>
    );
  }
  return (
    <footer data-viewer-bar className="grid grid-cols-[minmax(0,1fr)_auto_minmax(max-content,1fr)] items-center gap-4 px-4 pt-1 pb-4">
      <div className="flex min-w-0 items-center gap-1 text-sm text-muted">
        <LiveCount watching={watching} />
        <span className="mx-2 h-4 w-px shrink-0 bg-border-strong" aria-hidden="true" />
        <Tip label="Copy webinar link">
          <button
            onClick={copy.copy}
            aria-label={`Copy webinar link, code ${code}`}
            className="-ml-2 inline-flex h-10 min-w-0 cursor-pointer items-center gap-2 rounded-xl px-2 font-mono text-[0.8125rem] transition-colors hover:bg-surface-2 hover:text-text"
          >
            <span className="grid min-w-0">
              <span className={`col-start-1 row-start-1 truncate ${copy.copied ? "invisible" : ""}`}>{code}</span>
              <span className={`col-start-1 row-start-1 text-text ${copy.copied ? "" : "invisible"}`} role="status">
                {copy.copied ? "Copied" : ""}
              </span>
            </span>
            <CopyIcon copied={copy.copied} />
          </button>
        </Tip>
      </div>
      <div className="flex items-center justify-center gap-2" role="toolbar" aria-label="Webinar controls">
        {hand}
        {react}
        <span className="mx-1 h-6 w-px bg-border-strong" aria-hidden="true" />
        {leave}
      </div>
      <div className="flex justify-end gap-2">
        {moderating && <PeopleToggle open={panel === "people"} onToggle={() => onTogglePanel("people")} />}
        {chat}
      </div>
    </footer>
  );
}

/** "● Live · 250 watching", or on a phone's top bar "● Live · 250". */
export function LiveCount({ watching, compact = false }: { watching: number; compact?: boolean }) {
  return (
    <p data-live className={`inline-flex shrink-0 items-center gap-2 font-medium text-text ${compact ? "chip h-9 px-3 text-sm" : ""}`}>
      <span className="size-2 rounded-full bg-danger" aria-hidden="true" />
      <span className="font-semibold">Live</span>
      <span className="text-muted" aria-hidden="true">
        ·
      </span>
      <span className="tabular-nums" data-watching>
        {compact ? (
          <>
            <span aria-hidden="true">{shortCount(watching)}</span>
            <span className="sr-only">{watching.toLocaleString("en-US")} watching</span>
          </>
        ) : (
          `${watching.toLocaleString("en-US")} watching`
        )}
      </span>
    </p>
  );
}

function ChatToggle({ open, onToggle }: { open: boolean; onToggle: () => void }) {
  // New messages and polls waiting for your vote: polls are reached through Chat.
  const unread = useUnread(open);
  return (
    <Tip label="Chat">
      <button id="toggle-chat" className="ctrl" aria-expanded={open} aria-label={unread ? `Chat, ${unread} unread` : "Chat"} onClick={onToggle}>
        <MessageSquare className="size-5" />
        {unread > 0 && (
          <span
            data-chat-badge
            className="anim-pop absolute -top-1.5 -right-1.5 grid h-5 min-w-5 place-items-center rounded-full bg-accent px-1 text-[0.6875rem] font-bold text-accent-ink ring-3 ring-bg"
            aria-hidden="true"
          >
            {badgeCount(unread)}
          </span>
        )}
      </button>
    </Tip>
  );
}

export function PeopleToggle({ open, onToggle }: { open: boolean; onToggle: () => void }) {
  return (
    <Tip label="People">
      <button id="toggle-people" className="ctrl" aria-expanded={open} aria-label="People" onClick={onToggle}>
        <Users className="size-5" />
      </button>
    </Tip>
  );
}
