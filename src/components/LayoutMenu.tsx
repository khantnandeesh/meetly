"use client";

import { Check, EyeOff, LayoutGrid, PanelRight, PictureInPicture2, RectangleHorizontal, Sparkles, UserSquare2 } from "lucide-react";
import { TILE_LIMITS, type CallSettings, type LayoutMode, type SelfView } from "@/lib/useCallSettings";
import { Dropdown } from "./ui/Menu";

// Each layout's icon draws it; only "Auto", which an icon cannot draw, keeps a hint.
const LAYOUTS: { value: LayoutMode; label: string; hint?: string; icon: React.ReactNode }[] = [
  { value: "auto", label: "Auto", hint: "Grid or speaker, by size", icon: <Sparkles className="size-4" /> },
  { value: "tiled", label: "Tiled", icon: <LayoutGrid className="size-4" /> },
  { value: "spotlight", label: "Spotlight", icon: <RectangleHorizontal className="size-4" /> },
  { value: "sidebar", label: "Sidebar", icon: <PanelRight className="size-4" /> },
];

const SELF_VIEWS: { value: SelfView; label: string; icon: React.ReactNode }[] = [
  { value: "grid", label: "In the grid", icon: <UserSquare2 className="size-4" /> },
  { value: "float", label: "Floating", icon: <PictureInPicture2 className="size-4" /> },
  { value: "hidden", label: "Hidden", icon: <EyeOff className="size-4" /> },
];

/** Layout, tiles-per-page and self-view choices. Rendered inside a dropdown menu. */
export function LayoutMenuItems({
  settings,
  onChange,
  showTileLimit,
}: {
  settings: CallSettings;
  onChange: (patch: Partial<CallSettings>) => void;
  showTileLimit: boolean;
}) {
  return (
    <>
      <Dropdown.Label className="menu-label">Layout</Dropdown.Label>
      <Dropdown.RadioGroup value={settings.layout} onValueChange={(value) => onChange({ layout: value as LayoutMode })}>
        {LAYOUTS.map((layout) => (
          <Dropdown.RadioItem key={layout.value} value={layout.value} className="menu-item pr-10">
            <span className="text-muted" aria-hidden="true">
              {layout.icon}
            </span>
            <span className="min-w-0">
              <span className="block font-medium">{layout.label}</span>
              {layout.hint && <span className="block text-xs text-muted">{layout.hint}</span>}
            </span>
            <Dropdown.ItemIndicator className="absolute right-3 text-accent">
              <Check className="size-4" aria-hidden="true" />
            </Dropdown.ItemIndicator>
          </Dropdown.RadioItem>
        ))}
      </Dropdown.RadioGroup>

      {showTileLimit && (
        <>
          <div className="menu-sep" />
          <Dropdown.Label className="menu-label">Tiles per page</Dropdown.Label>
          <Dropdown.RadioGroup
            className="grid grid-cols-4 gap-1 px-1.5 pb-1"
            value={String(settings.maxTiles)}
            onValueChange={(value) => onChange({ maxTiles: Number(value) as CallSettings["maxTiles"] })}
          >
            {TILE_LIMITS.map((limit) => (
              <Dropdown.RadioItem
                key={limit}
                value={String(limit)}
                // Keep the menu open so the grid can be seen changing behind it.
                onSelect={(event) => event.preventDefault()}
                className="grid h-10 cursor-pointer place-items-center rounded-xl bg-surface-3/50 font-semibold tabular-nums outline-none data-[highlighted]:bg-surface-3 data-[state=checked]:bg-accent data-[state=checked]:text-accent-ink"
              >
                {limit}
              </Dropdown.RadioItem>
            ))}
          </Dropdown.RadioGroup>
        </>
      )}

      <div className="menu-sep" />
      <Dropdown.Label className="menu-label">Your own video</Dropdown.Label>
      {/* Three short choices side by side, so the whole menu fits without scrolling. */}
      <Dropdown.RadioGroup
        className="grid grid-cols-3 gap-1 px-1.5 pb-1"
        value={settings.selfView}
        onValueChange={(value) => onChange({ selfView: value as SelfView })}
      >
        {SELF_VIEWS.map((view) => (
          <Dropdown.RadioItem
            key={view.value}
            value={view.value}
            className="flex min-h-14 cursor-pointer flex-col items-center justify-center gap-1 rounded-xl bg-surface-3/50 px-1 py-2 text-center text-xs leading-tight font-medium outline-none data-[highlighted]:bg-surface-3 data-[state=checked]:bg-accent data-[state=checked]:text-accent-ink"
          >
            <span aria-hidden="true">{view.icon}</span>
            {view.label}
          </Dropdown.RadioItem>
        ))}
      </Dropdown.RadioGroup>
    </>
  );
}
