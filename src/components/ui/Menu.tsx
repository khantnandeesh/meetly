"use client";

import * as Dropdown from "@radix-ui/react-dropdown-menu";
import { Check } from "lucide-react";

export { Dropdown };

/** Strips the noise browsers append to device names, e.g. "(046d:0825)". */
export function deviceLabel(device: MediaDeviceInfo): string {
  return device.label.replace(/\s*\([0-9a-f]{4}:[0-9a-f]{4}\)\s*$/i, "") || "Unnamed device";
}

/** A labelled radio group of media devices for use inside a dropdown menu. */
export function DeviceRadioGroup({
  label,
  icon,
  devices,
  activeId,
  onSelect,
  emptyText,
}: {
  label: string;
  icon?: React.ReactNode;
  devices: MediaDeviceInfo[];
  activeId: string;
  onSelect: (deviceId: string) => void;
  emptyText: string;
}) {
  // "default" is an alias; fall back to the first entry so something is always checked.
  const value = devices.some((d) => d.deviceId === activeId) ? activeId : (devices[0]?.deviceId ?? "");
  return (
    <>
      <Dropdown.Label className="menu-label">
        {icon}
        {label}
      </Dropdown.Label>
      {devices.length === 0 ? (
        <Dropdown.Item disabled className="menu-item">
          {emptyText}
        </Dropdown.Item>
      ) : (
        <Dropdown.RadioGroup value={value} onValueChange={onSelect}>
          {devices.map((device) => (
            <Dropdown.RadioItem key={device.deviceId} value={device.deviceId} className="menu-item pr-10">
              <span className="min-w-0 truncate">{deviceLabel(device)}</span>
              <Dropdown.ItemIndicator className="absolute right-3 text-accent">
                <Check className="size-4" aria-hidden="true" />
              </Dropdown.ItemIndicator>
            </Dropdown.RadioItem>
          ))}
        </Dropdown.RadioGroup>
      )}
    </>
  );
}
