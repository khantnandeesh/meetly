"use client";

import * as Tooltip from "@radix-ui/react-tooltip";

/** Tooltip with an optional keyboard-shortcut hint. The child must be focusable. */
export function Tip({
  label,
  shortcut,
  side = "top",
  hoverOnly = false,
  children,
}: {
  label: string;
  shortcut?: string;
  side?: "top" | "bottom" | "left" | "right";
  /** For menu triggers: skip the focus-triggered tooltip, which would reappear when the menu closes. */
  hoverOnly?: boolean;
  children: React.ReactElement;
}) {
  return (
    <Tooltip.Root>
      <Tooltip.Trigger asChild onFocus={hoverOnly ? (event) => event.preventDefault() : undefined}>
        {children}
      </Tooltip.Trigger>
      <Tooltip.Portal>
        <Tooltip.Content side={side} sideOffset={8} collisionPadding={8} className="tooltip">
          {label}
          {shortcut && <kbd className="kbd">{shortcut}</kbd>}
        </Tooltip.Content>
      </Tooltip.Portal>
    </Tooltip.Root>
  );
}
