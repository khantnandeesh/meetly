"use client";

import * as Dialog from "@radix-ui/react-dialog";
import { Check, Copy, Gauge, Leaf, SignalLow, X } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { copyText, useCopied, usePresence } from "@/lib/hooks";
import { useCall, useCallQuality, useConnectionStatus } from "@/lib/rtc/react";
import type { CallStats, ConnectionHealth, RtcCall } from "@/lib/rtc/types";
import { deviceClass, sendUsageEvent, sizeBucket } from "@/lib/usage";
import { Tip } from "./ui/Tip";

/** Switches "use less data" on or off. It is the person's choice: nothing here ever turns it on for them. */
export function setDataSaver(call: RtcCall, on: boolean): void {
  void call.setDataSaver(on);
  if (on) sendUsageEvent({ kind: "feature", feature: "data-saver", size: sizeBucket(call.participants().length), device: deviceClass() });
}

/**
 * The one signal that your own connection is the problem: a chip at the top of the stage, where
 * "Reconnecting…" also lives. It appears after the connection has been poor for a while, offers
 * the one switch that helps, and goes when things improve or when it is dismissed (see
 * src/lib/useCallHealth.ts for the timing). No toast, no sound, no repeat. The status lane holds
 * that state and says when to show it: never beside a more important banner (StatusLane.tsx).
 */
export function WeakConnectionNotice({ show, onDismiss }: { show: boolean; onDismiss: () => void }) {
  const call = useCall();
  const { dataSaver } = useCallQuality();
  const presence = usePresence(show);
  if (!presence.mounted) return null;
  return (
    <div
      role={show ? "status" : undefined}
      data-weak-connection
      data-leaving={presence.leaving}
      onAnimationEnd={presence.onAnimationEnd}
      className="anim-pop pointer-events-auto flex max-w-[calc(100%-1.5rem)] items-center gap-1 rounded-2xl bg-[rgb(11_11_15/0.86)] py-1 pr-1 pl-3.5 text-sm font-medium shadow-lg backdrop-blur-md"
    >
      <SignalLow className="size-4 shrink-0 text-warn" aria-hidden="true" />
      {/* A phone has room for three words beside the action; whose connection it is goes to a screen reader either way. */}
      <span className="mr-1.5 shrink-0">
        <span className="max-md:hidden">Your connection is weak</span>
        <span className="md:hidden" aria-hidden="true">
          Weak connection
        </span>
        <span className="sr-only">
          <span className="md:hidden">Your connection is weak</span>. Other people may see and hear you less well.
        </span>
      </span>
      {dataSaver ? (
        <span className="mr-1 shrink-0 text-muted">Using less data</span>
      ) : (
        <button
          className="h-9 shrink-0 cursor-pointer rounded-xl bg-surface-3 px-3 font-semibold text-accent transition-colors hover:bg-(--border-strong) pointer-coarse:h-11"
          onClick={() => setDataSaver(call, true)}
        >
          Use less data
        </button>
      )}
      <button className="icon-btn size-9 hover:bg-surface-3 pointer-coarse:size-11" aria-label="Dismiss" onClick={onDismiss}>
        <X className="size-4" aria-hidden="true" />
      </button>
    </div>
  );
}

/** Shown while "use less data" is on, so it is never on without the person being able to see that it is. */
export function DataSaverBadge({ onOpen, compact = false }: { onOpen: () => void; compact?: boolean }) {
  const { dataSaver } = useCallQuality();
  const presence = usePresence(dataSaver);
  if (!presence.mounted) return null;
  return (
    <Tip label="Using less data. Open connection quality">
      <button
        data-saver-badge
        data-leaving={presence.leaving}
        onAnimationEnd={presence.onAnimationEnd}
        onClick={onOpen}
        aria-label="Using less data. Open connection quality"
        className={`anim-pop inline-flex shrink-0 cursor-pointer items-center gap-1.5 rounded-xl text-[0.8125rem] font-medium text-accent transition-colors hover:bg-surface-2 ${
          compact ? "size-11 justify-center bg-surface-2 active:bg-surface-3" : "h-10 px-2"
        }`}
      >
        <Leaf className="size-4" aria-hidden="true" />
        {!compact && <span className="max-lg:sr-only">Less data</span>}
      </button>
    </Tip>
  );
}

const HEALTH: Record<ConnectionHealth, { label: string; hint: string; tone: string }> = {
  good: { label: "Good", hint: "Others see and hear you clearly.", tone: "text-accent" },
  fair: { label: "Fair", hint: "Your video may drop at times.", tone: "text-text" },
  poor: {
    label: "Weak",
    hint: "Others may see you freeze. Move closer to Wi-Fi, or use less data.",
    tone: "text-warn",
  },
  unknown: { label: "Checking…", hint: "Takes a few seconds.", tone: "text-muted" },
};

const kbps = (value: number | null) => (value === null ? "—" : value >= 1000 ? `${(value / 1000).toFixed(1)} Mbps` : `${value} kbps`);

function diagnostics(provider: string, connection: ConnectionHealth, dataSaver: boolean, stats: CallStats | null): string {
  const video = stats?.sentVideo;
  return [
    "Meetly connection details",
    `Time: ${new Date().toISOString()}`,
    `Provider: ${provider}`,
    `Connection: ${connection}`,
    `Use less data: ${dataSaver ? "on" : "off"}`,
    `Sending: ${kbps(stats?.sentKbps ?? null)}`,
    `Receiving: ${kbps(stats?.receivedKbps ?? null)}`,
    `Camera sent as: ${video ? `${video.width}x${video.height}${video.fps ? ` at ${Math.round(video.fps)} fps` : ""}` : "—"}`,
    `Round trip: ${stats?.roundTripMs == null ? "—" : `${stats.roundTripMs} ms`}`,
    `Loss: ${stats?.lossPercent == null ? "—" : `${stats.lossPercent}%`}`,
    `Browser: ${navigator.userAgent}`,
  ].join("\n");
}

/**
 * "Call quality" from the More menu: how your connection is doing in plain words, the numbers
 * for whoever wants them, the "use less data" switch, and something to paste into a message to
 * whoever is helping. Everything shown is about this browser; nothing is sent anywhere.
 */
export function CallQualityDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const call = useCall();
  const { connection, dataSaver } = useCallQuality();
  const connected = useConnectionStatus() === "connected";
  const [stats, setStats] = useState<CallStats | null>(null);
  useEffect(() => {
    if (!open) return;
    let current = true;
    const measure = () =>
      void call.stats().then((next) => {
        if (current) setStats(next);
      });
    const first = setTimeout(measure, 0);
    const timer = setInterval(measure, 2000);
    return () => {
      current = false;
      clearTimeout(first);
      clearInterval(timer);
    };
  }, [open, call]);
  const copy = useCopied(useCallback(() => copyText(diagnostics(call.provider, connection, dataSaver, stats)), [call, connection, dataSaver, stats]));
  const health = HEALTH[connected ? connection : "unknown"];
  const video = stats?.sentVideo;
  const rows: [string, string][] = [
    ["Sending", kbps(stats?.sentKbps ?? null)],
    ["Receiving", kbps(stats?.receivedKbps ?? null)],
    ["Camera", video ? `${video.width} × ${video.height}${video.fps ? ` · ${Math.round(video.fps)} fps` : ""}` : "—"],
    ["Delay", stats?.roundTripMs == null ? "—" : `${stats.roundTripMs} ms`],
    ["Data lost", stats?.lossPercent == null ? "—" : `${stats.lossPercent}%`],
  ];
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="dialog-overlay fixed inset-0 z-50 bg-black/70" />
        <Dialog.Content
          aria-describedby={undefined}
          data-call-quality
          className="dialog fixed top-1/2 left-1/2 z-50 flex max-h-[calc(100dvh-2rem)] w-[min(28rem,calc(100vw-2rem))] -translate-x-1/2 -translate-y-1/2 flex-col overflow-hidden rounded-3xl bg-surface shadow-[inset_0_0_0_1px_var(--border-strong),0_30px_80px_-20px_rgb(0_0_0/0.8)]"
        >
          <div className="flex items-center justify-between py-3 pr-3 pl-6">
            <Dialog.Title className="font-display text-xl font-semibold">Connection quality</Dialog.Title>
            <Dialog.Close className="icon-btn" aria-label="Close">
              <X className="size-5" aria-hidden="true" />
            </Dialog.Close>
          </div>
          <div className="scroll-quiet flex flex-col overflow-y-auto">
            <div className="flex items-start gap-3.5 px-6 pb-5">
              <span className={`mt-0.5 grid size-11 shrink-0 place-items-center rounded-2xl bg-surface-2 ${health.tone}`}>
                <Gauge className="size-5" aria-hidden="true" />
              </span>
              <p role="status" data-connection={connected ? connection : "unknown"}>
                <span className="block text-sm text-muted">Your connection</span>
                <span className={`block font-display text-xl font-semibold ${health.tone}`}>{health.label}</span>
                <span className="mt-1 block text-sm leading-relaxed text-muted">{health.hint}</span>
              </p>
            </div>
            <dl className="px-6">
              {rows.map(([name, value]) => (
                <div key={name} className="flex items-center justify-between gap-4 border-t border-border py-2.5 text-[0.9375rem]">
                  <dt className="text-muted">{name}</dt>
                  <dd className="font-medium tabular-nums">{value}</dd>
                </div>
              ))}
            </dl>
            <label className="flex cursor-pointer items-center justify-between gap-4 border-t border-border bg-surface-2/60 px-6 py-4">
              <span>
                <span className="block text-[0.9375rem] font-medium">Use less data</span>
                <span className="block text-sm text-muted">Less video. Sound and screens unchanged.</span>
              </span>
              <input
                type="checkbox"
                role="switch"
                checked={dataSaver}
                onChange={(event) => setDataSaver(call, event.target.checked)}
                className="peer sr-only"
              />
              <span
                aria-hidden="true"
                className="relative h-7 w-12 shrink-0 rounded-full bg-surface-3 transition-colors peer-checked:bg-accent peer-focus-visible:outline-2 peer-focus-visible:outline-offset-2 peer-focus-visible:outline-accent after:absolute after:top-1 after:left-1 after:size-5 after:rounded-full after:bg-white after:transition-transform peer-checked:after:translate-x-5 peer-checked:after:bg-accent-ink"
              />
            </label>
            <div className="flex flex-col gap-2 border-t border-border px-6 py-4">
              <button className="btn btn-secondary h-11 rounded-xl text-sm" onClick={copy.copy}>
                {copy.copied ? <Check className="size-4 text-accent" aria-hidden="true" /> : <Copy className="size-4" aria-hidden="true" />}
                <span role="status">{copy.copied ? "Copied" : "Copy connection details"}</span>
              </button>
            </div>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
