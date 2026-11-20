"use client";

import { MessageSquare, Pin } from "lucide-react";
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { useChat, useConnectionStatus, usePolls } from "@/lib/rtc/react";
import type { RtcPoll } from "@/lib/rtc/types";
import { playChatMessageSound } from "@/lib/useSounds";
import { useToast } from "./ui/Toaster";

type ChatState = ReturnType<typeof useChat> & {
  seen: number;
  markSeen: (count: number) => void;
  /** Polls live in the chat panel, so they are kept here with it. */
  polls: RtcPoll[];
  /** Open polls you have not voted in and have not yet been shown. */
  pollsWaiting: number;
  markPollsSeen: () => void;
};
const ChatContext = createContext<ChatState | null>(null);

/**
 * Chat lives above the call UI so messages and the unread count survive closing the panel, and
 * in its own context so a new message re-renders the chat button, the panel and nothing else.
 * (The stage must not re-render for every message in a busy 50-person chat.)
 */
export function ChatStore({ children }: { children: React.ReactNode }) {
  const chat = useChat();
  const polls = usePolls();
  const [seen, markSeen] = useState(0);
  const [seenPolls, setSeenPolls] = useState<ReadonlySet<string>>(() => new Set());
  const pollsWaiting = useMemo(
    () => polls.reduce((count, poll) => count + (poll.open && !poll.voted && !seenPolls.has(poll.id) ? 1 : 0), 0),
    [polls, seenPolls],
  );
  const pollIds = polls.map((poll) => poll.id).join("\n");
  const markPollsSeen = useCallback(() => {
    const ids = pollIds ? pollIds.split("\n") : [];
    setSeenPolls((current) => (ids.every((id) => current.has(id)) ? current : new Set(ids)));
  }, [pollIds]);
  const value = useMemo(
    () => ({ ...chat, seen, markSeen, polls, pollsWaiting, markPollsSeen }),
    [chat, seen, polls, pollsWaiting, markPollsSeen],
  );
  return <ChatContext.Provider value={value}>{children}</ChatContext.Provider>;
}

export function useChatStore(): ChatState {
  const state = useContext(ChatContext);
  if (!state) throw new Error("useChatStore must be used inside <ChatStore>");
  return state;
}

/**
 * What is waiting in the chat panel while it is closed: messages that arrived, and each open
 * poll you have not voted in (one each). What was said before you joined is history, not news:
 * it never counts.
 */
export function useUnread(open: boolean): number {
  const { chatMessages, seen, markSeen, pollsWaiting, markPollsSeen } = useChatStore();
  const total = useMemo(() => chatMessages.reduce((count, message) => count + (message.earlier ? 0 : 1), 0), [chatMessages]);
  useEffect(() => {
    if (open) markSeen(total);
  }, [open, total, markSeen]);
  useEffect(() => {
    if (open) markPollsSeen();
  }, [open, markPollsSeen]);
  return open ? 0 : Math.max(0, total - seen) + pollsWaiting;
}

/**
 * Toasts the latest incoming message while the panel is closed, and a message being pinned
 * (with the panel open, the pinned message appearing at its top is the signal). Renders nothing.
 */
export function ChatToasts({ open, onReply }: { open: boolean; onReply: () => void }) {
  const { chatMessages, pinned } = useChatStore();
  const toast = useToast();
  const openNow = useRef(open);
  // By id, not by count: history can arrive after newer messages, and lands in front of them.
  const known = useRef(new Set<string>());
  useEffect(() => {
    openNow.current = open;
    if (open) {
      toast.dismissTag("chat");
      toast.dismissTag("chat-pin");
    }
  }, [open, toast]);
  useEffect(() => {
    const fresh = chatMessages.filter((message) => !known.current.has(message.id));
    for (const message of fresh) known.current.add(message.id);
    if (openNow.current) return;
    const last = fresh.findLast((message) => message.from && !message.from.isLocal && !message.earlier && !message.deleted);
    if (!last) return;
    playChatMessageSound();
    // One chat toast at a time (same tag updates it in place); the badge carries the count.
    toast.push({
      tag: "chat",
      icon: <MessageSquare className="size-5" />,
      title: last.from?.name || "Guest",
      body: last.message,
      duration: 6000,
      action: { label: "Reply", onClick: onReply },
    });
  }, [chatMessages, toast, onReply]);

  // What was pinned when you arrived is waiting in the panel; only a change while you are here is news.
  const pinnedId = pinned?.id ?? null;
  const pinnedText = pinned?.message ?? "";
  // "Arrived" is a moment after connecting: the pin reaches a newcomer just after the call does.
  const connected = useConnectionStatus() === "connected";
  const settled = useRef(false);
  useEffect(() => {
    if (!connected) return;
    const timer = setTimeout(() => {
      settled.current = true;
    }, 2000);
    return () => clearTimeout(timer);
  }, [connected]);
  const lastPinned = useRef<string | null>(null);
  useEffect(() => {
    const before = lastPinned.current;
    lastPinned.current = pinnedId;
    if (!settled.current || before === pinnedId || !pinnedId || openNow.current) return;
    toast.push({
      tag: "chat-pin",
      icon: <Pin className="size-5" />,
      title: "A message was pinned in chat",
      body: pinnedText,
      duration: 6000,
      action: { label: "View", onClick: onReply },
    });
  }, [pinnedId, pinnedText, toast, onReply]);
  return null;
}
