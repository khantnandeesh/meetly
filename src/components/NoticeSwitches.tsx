"use client";

import { Bell, Smile } from "lucide-react";
import { useCallSettings } from "@/lib/useCallSettings";
import { Dropdown } from "./ui/Menu";

/*
 * Two per-viewer switches for the More menu (placement spec, section 4). Each reads and writes
 * the remembered call settings itself, so it can go anywhere inside a Dropdown.Content and the
 * part of the call it affects follows at once.
 */

/** "Chat previews": whether a new message shows as a notification while chat is closed. On unless switched off. */
export function ChatPreviewsSwitch() {
  const [settings, update] = useCallSettings();
  const on = settings.chatPreviews;
  return (
    <Dropdown.CheckboxItem
      checked={on}
      onCheckedChange={(next) => update({ chatPreviews: next })}
      // Stay open: the switch is seen to move.
      onSelect={(event) => event.preventDefault()}
      className="menu-item"
    >
      <Bell className="size-4 shrink-0 text-muted" aria-hidden="true" />
      <span className="min-w-0 flex-1">
        <span className="block font-medium">Chat previews</span>
        <span className="block text-xs text-muted">Show new messages while chat is closed</span>
      </span>
      <span className="switch" data-on={on} aria-hidden="true" />
    </Dropdown.CheckboxItem>
  );
}

/** "Reactions": whether this viewer sees the emoji other people send. On unless switched off. */
export function ReactionsSwitch() {
  const [settings, update] = useCallSettings();
  const on = !settings.reactionsHidden;
  return (
    <Dropdown.CheckboxItem
      checked={on}
      onCheckedChange={(next) => update({ reactionsHidden: !next })}
      // Stay open: the switch is seen to move.
      onSelect={(event) => event.preventDefault()}
      className="menu-item"
    >
      <Smile className="size-4 shrink-0 text-muted" aria-hidden="true" />
      <span className="min-w-0 flex-1">
        <span className="block font-medium">Reactions</span>
        <span className="block text-xs text-muted">Show emoji others send</span>
      </span>
      <span className="switch" data-on={on} aria-hidden="true" />
    </Dropdown.CheckboxItem>
  );
}
