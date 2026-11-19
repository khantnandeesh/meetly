"use client";

import { useChat } from "@livekit/components-react";
import { MessageSquare } from "lucide-react";
import { createContext, useContext, useEffect, useMemo, useRef, useState } from "react";
import { playChatMessageSound } from "@/lib/useSounds";
import { useToast } from "./ui/Toaster";

type ChatState = ReturnType<typeof useChat> & { seen: number; markSeen: (count: number) => void };
const ChatContext = createContext<ChatState | null>(null);

/**
 * Chat lives above the call UI so messages and the unread count survive closing the panel, and
 * in its own context so a new message re-renders the chat button, the panel and nothing else.
 * (The stage must not re-render for every message in a busy 50-person chat.)
 */
export function ChatStore({ children }: { children: React.ReactNode }) {
  const chat = useChat();
  const [seen, markSeen] = useState(0);
  const value = useMemo(() => ({ ...chat, seen, markSeen }), [chat, seen]);
  return <ChatContext.Provider value={value}>{children}</ChatContext.Provider>;
}

export function useChatStore(): ChatState {
  const state = useContext(ChatContext);
  if (!state) throw new Error("useChatStore must be used inside <ChatStore>");
  return state;
}

/** Messages that arrived while the chat panel was closed. */
export function useUnread(open: boolean): number {
  const { chatMessages, seen, markSeen } = useChatStore();
  const total = chatMessages.length;
  useEffect(() => {
    if (open) markSeen(total);
  }, [open, total, markSeen]);
  return open ? 0 : Math.max(0, total - seen);
}

/** Toasts the latest incoming message while the panel is closed. Renders nothing. */
export function ChatToasts({ open, onReply }: { open: boolean; onReply: () => void }) {
  const { chatMessages } = useChatStore();
  const toast = useToast();
  const openNow = useRef(open);
  const announced = useRef(0);
  useEffect(() => {
    openNow.current = open;
    if (open) toast.dismissTag("chat");
  }, [open, toast]);
  useEffect(() => {
    const fresh = chatMessages.slice(announced.current);
    announced.current = chatMessages.length;
    if (openNow.current) return;
    const last = fresh.findLast((message) => message.from && !message.from.isLocal);
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
  return null;
}
