"use client";

import { Hand, LogOut, MessageSquare } from "lucide-react";
import { useCall } from "@/lib/rtc/react";
import { useUnread } from "./ChatStore";
import { ReactMenu } from "./Reactions";
import { Tip } from "./ui/Tip";

/**
 * The webinar audience's controls: Raise hand, React, Leave. There is no microphone, camera or
 * screen to offer, so none is shown, not even switched off. Chat sits apart on the right, as the
 * panel toggles do in a meeting: it opens the conversation, which the audience reads.
 */
export function ViewerControlBar({
  phone,
  handRaised,
  onToggleHand,
  reactOpen,
  onReactOpenChange,
  chatOpen,
  onToggleChat,
}: {
  phone: boolean;
  handRaised: boolean;
  onToggleHand: () => void;
  reactOpen: boolean;
  onReactOpenChange: (open: boolean) => void;
  chatOpen: boolean;
  onToggleChat: () => void;
}) {
  const call = useCall();
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
  const chat = <ChatToggle open={chatOpen} onToggle={onToggleChat} />;

  if (phone) {
    return (
      <footer className="px-3 pt-1 pb-[max(0.75rem,env(safe-area-inset-bottom))]">
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
    <footer className="grid grid-cols-[1fr_auto_1fr] items-center gap-4 px-4 pt-1 pb-4">
      <span />
      <div className="flex items-center justify-center gap-2" role="toolbar" aria-label="Webinar controls">
        {hand}
        {react}
        <span className="mx-1 h-6 w-px bg-border-strong" aria-hidden="true" />
        {leave}
      </div>
      <div className="flex justify-end">{chat}</div>
    </footer>
  );
}

function ChatToggle({ open, onToggle }: { open: boolean; onToggle: () => void }) {
  const unread = useUnread(open);
  return (
    <Tip label="Chat">
      <button id="toggle-chat" className="ctrl" aria-expanded={open} aria-label={unread ? `Chat, ${unread} unread` : "Chat"} onClick={onToggle}>
        <MessageSquare className="size-5" />
        {unread > 0 && (
          <span
            className="anim-pop absolute -top-1.5 -right-1.5 grid h-5 min-w-5 place-items-center rounded-full bg-accent px-1 text-[0.6875rem] font-bold text-accent-ink ring-3 ring-bg"
            aria-hidden="true"
          >
            {unread > 99 ? "99+" : unread}
          </span>
        )}
      </button>
    </Tip>
  );
}
