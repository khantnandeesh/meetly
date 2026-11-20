"use client";

import {
  ArrowDown,
  CircleAlert,
  Copy,
  Download,
  Ellipsis,
  LoaderCircle,
  MessagesSquare,
  Pin,
  PinOff,
  SendHorizontal,
  Trash2,
} from "lucide-react";
import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { saveChat } from "@/lib/chatExport";
import { copyText } from "@/lib/hooks";
import { useCall } from "@/lib/rtc/react";
import { CHAT_MAX_LENGTH } from "@/lib/rtc/shared";
import type { RtcChatMessage } from "@/lib/rtc/types";
import { useChatStore } from "./ChatStore";
import { useHost } from "./HostTools";
import { PollsSection } from "./Polls";
import { Avatar } from "./ui/Avatar";
import { Dropdown } from "./ui/Menu";
import { Tip } from "./ui/Tip";
import { useToast } from "./ui/Toaster";

const GROUP_WINDOW_MS = 5 * 60_000;
const URL_PATTERN = /(https?:\/\/[^\s<]+[^\s<.,:;"')\]!?])/g;
/** How long a finger rests on a message before its menu opens. */
const LONG_PRESS_MS = 450;

type Group = { key: string; own: boolean; name: string; seed: string; time: number; earlier: boolean; messages: RtcChatMessage[] };

/**
 * Consecutive messages from one person within a few minutes share a single header. What was
 * said before you joined never shares a group with what came after, so the line between the two
 * falls between groups.
 */
function groupMessages(messages: RtcChatMessage[]): Group[] {
  const groups: Group[] = [];
  for (const message of messages) {
    const seed = message.from?.identity ?? "unknown";
    const earlier = !!message.earlier;
    const last = groups[groups.length - 1];
    const previous = last?.messages[last.messages.length - 1];
    if (last && previous && last.seed === seed && last.earlier === earlier && message.timestamp - previous.timestamp < GROUP_WINDOW_MS) {
      last.messages.push(message);
    } else {
      groups.push({
        key: message.id,
        own: message.from?.isLocal ?? false,
        name: message.from?.name || "Guest",
        seed,
        time: message.timestamp,
        earlier,
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

type Actions = {
  canPin: boolean;
  pinnedId: string | null;
  onPin: (id: string | null) => void;
  onDelete: (id: string) => void;
  onCopy: (text: string) => void;
};

/**
 * One message and its menu: copy for everyone, delete for its author, pin for the host and
 * co-hosts. With a mouse the menu button appears beside the message; on touch a long press opens
 * the same menu. Either way the button is there for a keyboard or a screen reader.
 */
function MessageRow({ message, own, entering, actions }: { message: RtcChatMessage; own: boolean; entering: boolean; actions: Actions }) {
  const [open, setOpen] = useState(false);
  const press = useRef<{ timer: ReturnType<typeof setTimeout>; x: number; y: number } | null>(null);
  const cancelPress = () => {
    if (press.current) clearTimeout(press.current.timer);
    press.current = null;
  };
  useEffect(() => cancelPress, []);

  if (message.deleted) {
    return (
      <p data-chat-message={message.id} data-deleted className="max-w-full rounded-2xl px-3.5 py-2 text-[0.9375rem] leading-snug text-faint italic shadow-[inset_0_0_0_1px_var(--border)]">
        Message deleted
      </p>
    );
  }

  const pinned = actions.pinnedId === message.id;
  return (
    <div className={`group/msg flex max-w-full items-center gap-1 ${own ? "flex-row-reverse" : ""}`}>
      <p
        data-chat-message={message.id}
        onPointerDown={(event) => {
          if (event.pointerType === "mouse") return;
          cancelPress();
          press.current = { timer: setTimeout(() => setOpen(true), LONG_PRESS_MS), x: event.clientX, y: event.clientY };
        }}
        onPointerUp={cancelPress}
        onPointerMove={(event) => {
          // A resting finger trembles; a scroll travels.
          const start = press.current;
          if (start && Math.hypot(event.clientX - start.x, event.clientY - start.y) > 10) cancelPress();
        }}
        onPointerCancel={cancelPress}
        onContextMenu={(event) => {
          // A long press also asks for the system's own menu; ours is the one that opens.
          if (open) event.preventDefault();
        }}
        className={`${entering ? "anim-msg" : ""} min-w-0 rounded-2xl px-3.5 py-2 text-[0.9375rem] leading-snug break-words whitespace-pre-wrap ${
          own ? "rounded-tr-md bg-[color-mix(in_srgb,var(--accent)_20%,var(--surface-2))]" : "rounded-tl-md bg-surface-2"
        }`}
      >
        {pinned && <Pin className="mr-1.5 mb-0.5 inline size-3.5 text-accent" aria-label="Pinned" />}
        <Linkified text={message.message} />
      </p>
      <Dropdown.Root open={open} onOpenChange={setOpen}>
        <Dropdown.Trigger
          aria-label="Message actions"
          className="icon-btn size-8 shrink-0 rounded-lg opacity-0 transition-opacity group-hover/msg:opacity-100 focus-visible:opacity-100 data-[state=open]:opacity-100 pointer-coarse:pointer-events-none"
        >
          <Ellipsis className="size-4" aria-hidden="true" />
        </Dropdown.Trigger>
        <Dropdown.Portal>
          <Dropdown.Content side="bottom" align={own ? "end" : "start"} sideOffset={4} collisionPadding={12} className="menu min-w-48">
            <Dropdown.Item className="menu-item" onSelect={() => actions.onCopy(message.message)}>
              <Copy className="size-4 text-muted" aria-hidden="true" />
              Copy text
            </Dropdown.Item>
            {actions.canPin && (
              <Dropdown.Item className="menu-item" onSelect={() => actions.onPin(pinned ? null : message.id)}>
                {pinned ? <PinOff className="size-4 text-muted" aria-hidden="true" /> : <Pin className="size-4 text-muted" aria-hidden="true" />}
                {pinned ? "Unpin for everyone" : "Pin for everyone"}
              </Dropdown.Item>
            )}
            {own && (
              <Dropdown.Item className="menu-item text-danger-text" onSelect={() => actions.onDelete(message.id)}>
                <Trash2 className="size-4" aria-hidden="true" />
                Delete for everyone
              </Dropdown.Item>
            )}
          </Dropdown.Content>
        </Dropdown.Portal>
      </Dropdown.Root>
    </div>
  );
}

/**
 * Memoised on what it shows: a new message re-renders only the group it lands in, and
 * `content-visibility` lets the browser skip layout for groups scrolled out of view.
 */
const MessageGroup = memo(
  function MessageGroup({ group, entering, actions }: { group: Group; stamp: string; entering?: string; actions: Actions }) {
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
            <MessageRow key={message.id} message={message} own={group.own} entering={message.id === entering} actions={actions} />
          ))}
        </div>
      </div>
    );
  },
  (a, b) => a.group.key === b.group.key && a.stamp === b.stamp && a.entering === b.entering && a.actions === b.actions,
);

/** The message a host put above the conversation. Everyone sees it; the host and co-hosts can take it down. */
function PinnedMessage({ message, canUnpin, onUnpin }: { message: RtcChatMessage; canUnpin: boolean; onUnpin: () => void }) {
  return (
    <div
      data-pinned-message={message.id}
      className="anim-fade mx-3 mb-1 flex shrink-0 items-start gap-2.5 rounded-xl bg-[color-mix(in_srgb,var(--accent)_9%,var(--surface-2))] py-2.5 pr-2 pl-3 shadow-[inset_0_0_0_1px_color-mix(in_srgb,var(--accent)_28%,var(--border))]"
    >
      <Pin className="mt-0.5 size-4 shrink-0 text-accent" aria-hidden="true" />
      <div className="min-w-0 flex-1">
        <p className="text-xs text-muted">
          <span className="sr-only">Pinned message from </span>
          <span className="font-semibold text-text">{message.from?.isLocal ? "You" : message.from?.name || "Guest"}</span>
          <span aria-hidden="true"> · pinned</span>
        </p>
        <p className="mt-0.5 line-clamp-4 text-sm leading-snug break-words whitespace-pre-wrap">
          <Linkified text={message.message} />
        </p>
      </div>
      {canUnpin && (
        <Tip label="Unpin for everyone" side="left">
          <button className="icon-btn size-8 rounded-lg" aria-label="Unpin for everyone" onClick={onUnpin}>
            <PinOff className="size-4" aria-hidden="true" />
          </button>
        </Tip>
      )}
    </div>
  );
}

/** Saves the conversation so far as a text file. Lives in the chat panel's header. */
export function SaveChatButton({ code }: { code: string }) {
  const { chatMessages, pinned } = useChatStore();
  const empty = !chatMessages.some((message) => !message.deleted);
  return (
    <Tip label={empty ? "Nothing to save yet" : "Save chat as a text file"} side="bottom">
      <button
        className={`icon-btn ${empty ? "cursor-default opacity-45 hover:bg-transparent hover:text-muted" : ""}`}
        aria-label="Save chat"
        aria-disabled={empty || undefined}
        onClick={() => {
          if (!empty) saveChat(code, chatMessages, pinned);
        }}
      >
        <Download className="size-5" aria-hidden="true" />
      </button>
    </Tip>
  );
}

export function ChatPanel({ autoFocus }: { autoFocus: boolean }) {
  const call = useCall();
  const toast = useToast();
  const { canModerate } = useHost();
  const { chatMessages, pinned, send, remove, isSending } = useChatStore();
  const [draft, setDraft] = useState("");
  const [failed, setFailed] = useState<string | null>(null);
  const [atBottom, setAtBottom] = useState(true);
  const listRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const stick = useRef(true);
  // What is there when the panel opens is simply there; only a message that arrives afterwards
  // slides in, and only at conversational pace. In a flood (many a second) nothing animates.
  const newest = chatMessages[chatMessages.length - 1];
  const before = chatMessages[chatMessages.length - 2];
  const [newestAtOpen] = useState(() => newest?.id);
  const entering =
    newest && !newest.earlier && newest.id !== newestAtOpen && (!before || newest.timestamp - before.timestamp > 400)
      ? newest.id
      : undefined;

  const groups = useMemo(() => groupMessages(chatMessages), [chatMessages]);
  const count = chatMessages.length;
  // History landing above does not count as "new messages below".
  const live = useMemo(() => chatMessages.reduce((n, message) => n + (message.earlier ? 0 : 1), 0), [chatMessages]);
  const [liveAtBottom, setLiveAtBottom] = useState(live);
  const newBelow = atBottom ? 0 : Math.max(0, live - liveAtBottom);
  const lastEarlier = groups.findLastIndex((group) => group.earlier);

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
    if (bottom) setLiveAtBottom(live);
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
    setFailed(null);
    stick.current = true;
    requestAnimationFrame(resize);
    try {
      await send(text);
    } catch (error) {
      setDraft(text);
      setFailed(error instanceof Error && error.message ? error.message : "That didn't send. Check your connection and try again.");
    }
  }

  const problem = useCallback(
    (title: string, error: unknown) =>
      toast.push({
        tag: "chat-error",
        tone: "danger",
        icon: <CircleAlert className="size-5" />,
        title,
        body: error instanceof Error ? error.message : undefined,
      }),
    [toast],
  );
  const pin = useCallback(
    (id: string | null) => {
      call.moderate({ action: "pin", messageId: id }).catch((error) => problem(id ? "Couldn't pin that message" : "Couldn't unpin the message", error));
    },
    [call, problem],
  );
  const pinnedId = pinned?.id ?? null;
  const actions = useMemo<Actions>(
    () => ({
      canPin: canModerate,
      pinnedId,
      onPin: pin,
      onDelete: (id) => {
        remove(id).catch((error) => problem("Couldn't delete that message", error));
      },
      onCopy: (text) => {
        void copyText(text).then((ok) => {
          if (!ok) problem("Couldn't copy the message", undefined);
        });
      },
    }),
    [canModerate, pinnedId, pin, remove, problem],
  );

  return (
    <>
      <PollsSection />
      {pinned && <PinnedMessage message={pinned} canUnpin={canModerate} onUnpin={() => pin(null)} />}
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
                Everyone in the meeting sees messages, including people who join later. To keep them, save the chat before you leave.
              </p>
            </div>
          ) : (
            groups.map((group, index) => (
              <div key={group.key} className="contents">
                <MessageGroup
                  group={group}
                  // Everything that changes how the group looks: its messages, and which are deleted or pinned.
                  stamp={group.messages.map((message) => `${message.id}${message.deleted ? "x" : ""}${message.id === pinnedId ? "p" : ""}`).join()}
                  entering={index === groups.length - 1 ? entering : undefined}
                  actions={actions}
                />
                {index === lastEarlier && (
                  <p
                    role="separator"
                    data-earlier-divider
                    className="flex shrink-0 items-center gap-3 text-xs font-medium text-faint before:h-px before:flex-1 before:bg-border after:h-px after:flex-1 after:bg-border"
                  >
                    You joined here
                  </p>
                )}
              </div>
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
            {failed}
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
            maxLength={CHAT_MAX_LENGTH}
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
