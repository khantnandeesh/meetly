"use client";

import * as Dialog from "@radix-ui/react-dialog";
import { X } from "lucide-react";

export const SHORTCUTS = [
  { key: "M", action: "Mute or unmute your microphone" },
  { key: "V", action: "Turn your camera on or off" },
  { key: "H", action: "Raise or lower your hand" },
  { key: "C", action: "Open or close chat" },
  { key: "P", action: "Show or hide people" },
  { key: "← →", action: "Previous or next gallery page" },
  { key: "Esc", action: "Close the open panel" },
  { key: "?", action: "Show this list" },
];

export function ShortcutsDialog({
  open,
  onOpenChange,
  enabled,
  onEnabledChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  enabled: boolean;
  onEnabledChange: (enabled: boolean) => void;
}) {
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="dialog-overlay fixed inset-0 z-50 bg-black/70" />
        <Dialog.Content
          aria-describedby={undefined}
          className="dialog fixed top-1/2 left-1/2 z-50 flex max-h-[calc(100dvh-2rem)] w-[min(28rem,calc(100vw-2rem))] -translate-x-1/2 -translate-y-1/2 flex-col overflow-hidden rounded-3xl bg-surface shadow-[inset_0_0_0_1px_var(--border-strong),0_30px_80px_-20px_rgb(0_0_0/0.8)]"
        >
          <div className="flex items-center justify-between py-3 pr-3 pl-6">
            <Dialog.Title className="font-display text-xl font-semibold">Keyboard shortcuts</Dialog.Title>
            <Dialog.Close className="icon-btn" aria-label="Close">
              <X className="size-5" aria-hidden="true" />
            </Dialog.Close>
          </div>
          <dl className={`scroll-quiet flex flex-col overflow-y-auto px-6 transition-opacity ${enabled ? "" : "opacity-45"}`}>
            {SHORTCUTS.map(({ key, action }) => (
              <div key={key} className="flex items-center justify-between gap-4 border-t border-border py-3">
                <dd className="text-[0.9375rem]">{action}</dd>
                <dt>
                  <kbd className="kbd h-7 min-w-7 px-2 text-xs">{key}</kbd>
                </dt>
              </div>
            ))}
          </dl>
          <label className="flex cursor-pointer items-center justify-between gap-4 border-t border-border bg-surface-2/60 px-6 py-4">
            <span>
              <span className="block text-[0.9375rem] font-medium">Single-key shortcuts</span>
              <span className="block text-sm text-muted">Turn off if they clash with your tools.</span>
            </span>
            <input
              type="checkbox"
              role="switch"
              checked={enabled}
              onChange={(e) => onEnabledChange(e.target.checked)}
              className="peer sr-only"
            />
            <span
              aria-hidden="true"
              className="relative h-7 w-12 shrink-0 rounded-full bg-surface-3 transition-colors peer-checked:bg-accent peer-focus-visible:outline-2 peer-focus-visible:outline-offset-2 peer-focus-visible:outline-accent after:absolute after:top-1 after:left-1 after:size-5 after:rounded-full after:bg-white after:transition-transform peer-checked:after:translate-x-5 peer-checked:after:bg-accent-ink"
            />
          </label>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
