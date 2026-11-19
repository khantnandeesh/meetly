"use client";

import type { ReceivedChatMessage } from "@livekit/components-react";
import { ArrowDown, LoaderCircle, MessagesSquare, SendHorizontal } from "lucide-react";
import { memo, useEffect, useMemo, useRef, useState } from "react";
import { useChatStore } from "./ChatStore";
import { Avatar } from "./ui/Avatar";

const GROUP_WINDOW_MS = 5 * 60_000;
const URL_PATTERN = /(https?:\/\/[^\s<]+[^\s<.,:;"')\]!?])/g;

type Group = { key: string; own: boolean; name: string; seed: string; time: number; messages: ReceivedChatMessage[] };

/** Consecutive messages from one person within a few minutes share a single header. */
function groupMessages(messages: ReceivedChatMessage[]): Group[] {
  const groups: Group[] = [];
  for (const message of messages) {
    const seed = message.from?.identity ?? "unknown";
    const last = groups[groups.length - 1];
    const previous = last?.messages[last.messages.length - 1];
    if (last && previous && last.seed === seed && message.timestamp - previous.timestamp < GROUP_WINDOW_MS) {
      last.messages.push(message);
    } else {
      groups.push({
        key: message.id,
        own: message.from?.isLocal ?? false,
        name: message.from?.name || "Guest",
        seed,
        time: message.timestamp,
        messages: [message],
      });
    }
  }
  return groups;
}

function formatTime(timestamp: number): string {
  return new Date(timestamp).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}

function Linkified({ text }: { text: string }) {
  return text.split(URL_PATTERN).map((part, i) =>
    i % 2 === 1 ? (
      <a key={i} href={part} target="_blank" rel="noopener noreferrer" className="underline underline-offset-2 hover:text-accent">
        {part}
      </a>
    ) : (
      part
    ),
  );
}

/**
 * Memoised on the group's identity and length: a new message re-renders only the group it lands
 * in, and `content-visibility` lets the browser skip layout for groups scrolled out of view.
 */
const MessageGroup = memo(
  function MessageGroup({ group, entering }: { group: Group; count: number; entering?: string }) {
    return (
      <div
        className={`flex shrink-0 gap-2.5 [contain-intrinsic-size:auto_4.5rem] [content-visibility:auto] ${group.own ? "flex-row-reverse" : ""}`}
      >
        {!group.own && <Avatar name={group.name} seed={group.seed} className="mt-5.5 size-8 text-xs" />}
        <div className={`flex min-w-0 flex-col gap-1 ${group.own ? "items-end" : "items-start"}`}>
          <p className="flex max-w-full items-baseline gap-1.5 px-1 text-xs text-muted">
            <span className="truncate font-semibold text-text">{group.own ? "You" : group.name}</span>
            <time className="shrink-0" dateTime={new Date(group.time).toISOString()}>
              {formatTime(group.time)}
            </time>
          </p>
          {group.messages.map((message) => (
            <p
              key={message.id}
              className={`${message.id === entering ? "anim-msg" : ""} max-w-full rounded-2xl px-3.5 py-2 text-[0.9375rem] leading-snug break-words whitespace-pre-wrap ${
                group.own
                  ? "rounded-tr-md bg-[color-mix(in_srgb,var(--accent)_20%,var(--surface-2))]"
                  : "rounded-tl-md bg-surface-2"
              }`}
            >
              <Linkified text={message.message} />
            </p>
          ))}
        </div>
      </div>
    );
  },
  (a, b) => a.group.key === b.group.key && a.count === b.count && a.entering === b.entering,
);

export function ChatPanel({ autoFocus }: { autoFocus: boolean }) {
  const { chatMessages, send, isSending } = useChatStore();
  const [draft, setDraft] = useState("");
  const [failed, setFailed] = useState(false);
  const [atBottom, setAtBottom] = useState(true);
  const [countAtBottom, setCountAtBottom] = useState(chatMessages.length);
  const listRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const stick = useRef(true);
  // History is simply there when the panel opens; only a message that arrives afterwards slides
  // in, and only at conversational pace. In a flood (many a second) nothing animates.
  const [liveFrom] = useState(() => Date.now());
  const newest = chatMessages[chatMessages.length - 1];
  const before = chatMessages[chatMessages.length - 2];
  const entering =
    newest && newest.timestamp >= liveFrom && (!before || newest.timestamp - before.timestamp > 400)
      ? newest.id
      : undefined;

  const groups = useMemo(() => groupMessages(chatMessages), [chatMessages]);
  const count = chatMessages.length;
  const newBelow = atBottom ? 0 : Math.max(0, count - countAtBottom);

  // Follow the conversation unless the reader has scrolled up to look at history.
  // Done in an animation frame so a burst of messages costs one layout, not one each.
  useEffect(() => {
    const frame = requestAnimationFrame(() => {
      const list = listRef.current;
      if (list && stick.current) list.scrollTop = list.scrollHeight;
    });
    return () => cancelAnimationFrame(frame);
  }, [count]);

  function onScroll() {
    const list = listRef.current;
    if (!list) return;
    const bottom = list.scrollHeight - list.scrollTop - list.clientHeight < 48;
    stick.current = bottom;
    setAtBottom(bottom);
    if (bottom) setCountAtBottom(count);
  }

  function scrollToBottom() {
    const list = listRef.current;
    list?.scrollTo({ top: list.scrollHeight, behavior: "smooth" });
  }

  function resize() {
    const input = inputRef.current;
    if (!input) return;
    input.style.height = "auto";
    input.style.height = `${Math.min(input.scrollHeight, 128)}px`;
  }

  async function submit(event?: React.FormEvent) {
    event?.preventDefault();
    const text = draft.trim();
    if (!text || isSending) return;
    setDraft("");
    setFailed(false);
    stick.current = true;
    requestAnimationFrame(resize);
    try {
      await send(text);
    } catch {
      setDraft(text);
      setFailed(true);
    }
  }

  return (
    <>
      <div className="relative flex min-h-0 flex-1 flex-col">
        <div
          ref={listRef}
          onScroll={onScroll}
          role="log"
          aria-label="Conversation"
          tabIndex={0}
          className="scroll-quiet flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-4 py-4"
        >
          {count === 0 ? (
            <div className="m-auto flex max-w-60 flex-col items-center gap-3 pb-6 text-center">
              <span className="grid size-12 place-items-center rounded-2xl bg-surface-2 text-muted">
                <MessagesSquare className="size-6" aria-hidden="true" />
              </span>
              <p className="font-semibold">No messages yet</p>
              <p className="text-sm leading-relaxed text-muted">
                Messages are visible to everyone in the call and disappear when it ends.
              </p>
            </div>
          ) : (
            groups.map((group, index) => (
              <MessageGroup
                key={group.key}
                group={group}
                count={group.messages.length}
                entering={index === groups.length - 1 ? entering : undefined}
              />
            ))
          )}
        </div>

        {newBelow > 0 && (
          <button
            onClick={scrollToBottom}
            className="anim-pop absolute bottom-3 left-1/2 inline-flex h-9 -translate-x-1/2 cursor-pointer items-center gap-1.5 rounded-full bg-accent px-3.5 text-sm font-semibold text-accent-ink shadow-lg"
          >
            <ArrowDown className="size-4" aria-hidden="true" />
            {newBelow} new {newBelow === 1 ? "message" : "messages"}
          </button>
        )}
      </div>

      <form onSubmit={submit} className="border-t border-border p-3 pb-[max(0.75rem,env(safe-area-inset-bottom))]">
        {failed && (
          <p role="alert" className="px-1 pb-2 text-sm text-danger-text">
            That didn&apos;t send. Check your connection and try again.
          </p>
        )}
        <div className="flex items-end gap-2 rounded-[1.375rem] bg-surface-2 p-1.5 pl-4 shadow-[inset_0_0_0_1px_var(--border)] transition-shadow focus-within:shadow-[inset_0_0_0_1px_var(--accent),0_0_0_3px_color-mix(in_srgb,var(--accent)_22%,transparent)]">
          <textarea
            ref={inputRef}
            data-autofocus={autoFocus || undefined}
            value={draft}
            onChange={(e) => {
              setDraft(e.target.value);
              resize();
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault();
                submit();
              }
            }}
            rows={1}
            placeholder="Message everyone"
            aria-label="Message"
            maxLength={2000}
            enterKeyHint="send"
            className="scroll-quiet max-h-32 min-w-0 flex-1 resize-none self-center bg-transparent py-2 text-[0.9375rem] leading-snug outline-none placeholder:text-faint"
          />
          <button
            type="submit"
            aria-label="Send"
            disabled={isSending || !draft.trim()}
            className="grid size-10 shrink-0 cursor-pointer place-items-center rounded-2xl bg-accent text-accent-ink transition-[background-color,opacity,transform] hover:bg-(--accent-hover) active:scale-(--scale-press) disabled:cursor-not-allowed disabled:bg-surface-3 disabled:text-faint"
          >
            {isSending ? (
              <LoaderCircle className="anim-spin size-[1.125rem]" aria-hidden="true" />
            ) : (
              <SendHorizontal className="size-[1.125rem]" aria-hidden="true" />
            )}
          </button>
        </div>
      </form>
    </>
  );
}
