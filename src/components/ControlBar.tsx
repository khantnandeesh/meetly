"use client";

import { useMediaDeviceSelect, useRoomContext, useTrackToggle } from "@livekit/components-react";
import { Track } from "livekit-client";
import {
  ChevronUp,
  CircleAlert,
  Ellipsis,
  Hand,
  Keyboard,
  LayoutGrid,
  Link2,
  LoaderCircle,
  MessageSquare,
  Mic,
  MicOff,
  MonitorUp,
  MonitorX,
  PhoneOff,
  Users,
  Video,
  VideoOff,
  Volume2,
} from "lucide-react";
import { useEffect, useState } from "react";
import { useDeviceList } from "@/lib/usePreviewMedia";
import type { CallSettings } from "@/lib/useCallSettings";
import { useUnread } from "./ChatStore";
import { LayoutMenuItems } from "./LayoutMenu";
import { DeviceRadioGroup, Dropdown } from "./ui/Menu";
import { Tip } from "./ui/Tip";
import { useToast } from "./ui/Toaster";

export type Panel = "chat" | "people" | null;

export function ControlBar({
  code,
  phone,
  panel,
  headcount,
  handRaised,
  onToggleHand,
  onTogglePanel,
  onCopyLink,
  onShowShortcuts,
  settings,
  onSettings,
}: {
  code: string;
  phone: boolean;
  panel: Panel;
  headcount: number;
  handRaised: boolean;
  onToggleHand: () => void;
  onTogglePanel: (panel: Exclude<Panel, null>) => void;
  onCopyLink: () => void;
  onShowShortcuts: () => void;
  settings: CallSettings;
  onSettings: (patch: Partial<CallSettings>) => void;
}) {
  const room = useRoomContext();
  const toast = useToast();

  const deviceError = (what: string) => () =>
    toast.push({
      title: `Couldn't start your ${what}`,
      body: "Check your browser's permissions for this site and try again.",
      tone: "danger",
      icon: <CircleAlert className="size-5" />,
      duration: 7000,
    });
  const mic = useTrackToggle({ source: Track.Source.Microphone, onDeviceError: deviceError("microphone") });
  const cam = useTrackToggle({ source: Track.Source.Camera, onDeviceError: deviceError("camera") });
  const share = useTrackToggle({
    source: Track.Source.ScreenShare,
    captureOptions: { audio: true, selfBrowserSurface: "include" },
  });

  const micLabel = mic.enabled ? "Mute microphone" : "Unmute microphone";
  const camLabel = cam.enabled ? "Turn off camera" : "Turn on camera";
  const handLabel = handRaised ? "Lower hand" : "Raise hand";

  const micButton = (
    <Tip label={micLabel} shortcut={phone ? undefined : "M"}>
      <button className="ctrl" data-ctl={mic.enabled ? "on" : "off"} aria-label={micLabel} onClick={() => mic.toggle()}>
        {mic.enabled ? <Mic className="size-5" /> : <MicOff className="size-5" />}
      </button>
    </Tip>
  );
  const camButton = (
    <Tip label={camLabel} shortcut={phone ? undefined : "V"}>
      <button className="ctrl" data-ctl={cam.enabled ? "on" : "off"} aria-label={camLabel} onClick={() => cam.toggle()}>
        {cam.pending ? (
          <LoaderCircle className="anim-spin size-5" />
        ) : cam.enabled ? (
          <Video className="size-5" />
        ) : (
          <VideoOff className="size-5" />
        )}
      </button>
    </Tip>
  );
  const handButton = (
    <Tip label={handLabel} shortcut={phone ? undefined : "H"}>
      <button className="ctrl" data-ctl={handRaised ? "active" : "on"} aria-label={handLabel} onClick={onToggleHand}>
        <Hand className="size-5" />
      </button>
    </Tip>
  );
  const chatButton = <ChatButton open={panel === "chat"} phone={phone} onToggle={onTogglePanel} />;
  const leaveButton = (
    <Tip label="Leave call">
      <button className="ctrl ctrl-danger md:w-16" aria-label="Leave call" onClick={() => room.disconnect()}>
        <PhoneOff className="size-5" />
      </button>
    </Tip>
  );

  const moreMenu = (
    <Dropdown.Root>
      <Tip label="More options" hoverOnly>
        <Dropdown.Trigger className="ctrl" aria-label="More options">
          <Ellipsis className="size-5" />
        </Dropdown.Trigger>
      </Tip>
      <Dropdown.Portal>
        <Dropdown.Content side="top" align={phone ? "end" : "center"} sideOffset={10} collisionPadding={12} className="menu">
          <Dropdown.Item className="menu-item" onSelect={onCopyLink}>
            <Link2 className="size-4 text-muted" aria-hidden="true" />
            Copy meeting link
          </Dropdown.Item>
          {phone ? (
            <>
              <div className="menu-sep" />
              <LayoutMenuItems settings={settings} onChange={onSettings} showTileLimit={false} />
              <div className="menu-sep" />
              <DeviceGroups kinds={["audioinput", "videoinput", "audiooutput"]} />
            </>
          ) : (
            <Dropdown.Item className="menu-item" onSelect={onShowShortcuts}>
              <Keyboard className="size-4 text-muted" aria-hidden="true" />
              Keyboard shortcuts
              <kbd className="kbd ml-auto">?</kbd>
            </Dropdown.Item>
          )}
        </Dropdown.Content>
      </Dropdown.Portal>
    </Dropdown.Root>
  );

  if (phone) {
    return (
      <footer className="px-3 pt-1 pb-[max(0.75rem,env(safe-area-inset-bottom))]">
        <div className="mx-auto flex max-w-md items-center justify-between" role="toolbar" aria-label="Call controls">
          {micButton}
          {camButton}
          {handButton}
          {chatButton}
          {moreMenu}
          {leaveButton}
        </div>
      </footer>
    );
  }

  return (
    <footer className="grid grid-cols-[1fr_auto_1fr] items-center gap-4 px-4 pt-1 pb-4">
      <div className="flex min-w-0 items-center gap-1 text-sm text-muted">
        <Clock />
        <span className="mx-2 h-4 w-px shrink-0 bg-border-strong" aria-hidden="true" />
        <Tip label="Copy meeting link">
          <button
            onClick={onCopyLink}
            aria-label={`Copy meeting link, code ${code}`}
            className="-ml-2 inline-flex h-10 min-w-0 cursor-pointer items-center gap-2 rounded-xl px-2 font-mono text-[0.8125rem] transition-colors hover:bg-surface-2 hover:text-text"
          >
            <span className="truncate">{code}</span>
            <Link2 className="size-4 shrink-0" aria-hidden="true" />
          </button>
        </Tip>
      </div>

      <div className="flex items-center justify-center gap-2" role="toolbar" aria-label="Call controls">
        <div className="ctrl-split">
          {micButton}
          <DeviceMenu label="Audio settings" kinds={["audioinput", "audiooutput"]} off={!mic.enabled} />
        </div>
        <div className="ctrl-split">
          {camButton}
          <DeviceMenu label="Video settings" kinds={["videoinput"]} off={!cam.enabled} />
        </div>
        <Tip label={share.enabled ? "Stop sharing" : "Share screen"}>
          <button
            className="ctrl"
            data-ctl={share.enabled ? "active" : "on"}
            aria-label={share.enabled ? "Stop sharing" : "Share screen"}
            onClick={() => share.toggle()}
          >
            {share.enabled ? <MonitorX className="size-5" /> : <MonitorUp className="size-5" />}
          </button>
        </Tip>
        {handButton}
        {moreMenu}
        <span className="mx-1 h-6 w-px bg-border-strong" aria-hidden="true" />
        {leaveButton}
      </div>

      <div className="flex items-center justify-end gap-2">
        <Dropdown.Root>
          <Tip label="Change layout" hoverOnly>
            <Dropdown.Trigger className="ctrl" aria-label="Change layout">
              <LayoutGrid className="size-5" />
            </Dropdown.Trigger>
          </Tip>
          <Dropdown.Portal>
            <Dropdown.Content side="top" align="end" sideOffset={10} collisionPadding={12} className="menu w-72">
              <LayoutMenuItems settings={settings} onChange={onSettings} showTileLimit />
            </Dropdown.Content>
          </Dropdown.Portal>
        </Dropdown.Root>
        <Tip label="People" shortcut="P">
          <button
            id="toggle-people"
            className="ctrl px-3.5"
                        aria-expanded={panel === "people"}
            aria-label="Show everyone"
            onClick={() => onTogglePanel("people")}
          >
            <Users className="size-5" />
            <span className="text-sm font-semibold tabular-nums">{headcount}</span>
          </button>
        </Tip>
        {chatButton}
      </div>
    </footer>
  );
}

/** Its own component so a new message re-renders this button, not the whole control bar. */
function ChatButton({
  open,
  phone,
  onToggle,
}: {
  open: boolean;
  phone: boolean;
  onToggle: (panel: Exclude<Panel, null>) => void;
}) {
  const unread = useUnread(open);
  return (
    <Tip label="Chat" shortcut={phone ? undefined : "C"}>
      <button
        id="toggle-chat"
        className="ctrl"
        aria-expanded={open}
        aria-label={unread ? `Chat, ${unread} unread` : "Chat"}
        onClick={() => onToggle("chat")}
      >
        <MessageSquare className="size-5" />
        {unread > 0 && (
          <span
            key={unread}
            className="anim-pop absolute -top-1.5 -right-1.5 grid h-5 min-w-5 place-items-center rounded-full bg-accent px-1 text-[0.6875rem] font-bold text-accent-ink ring-3 ring-bg"
            aria-hidden="true"
          >
            {unread > 9 ? "9+" : unread}
          </span>
        )}
      </button>
    </Tip>
  );
}

/* ------------------------------------------------------------- device menus */

const DEVICE_META: Record<MediaDeviceKind, { label: string; empty: string; icon: React.ReactNode }> = {
  audioinput: { label: "Microphone", empty: "No microphone available", icon: <Mic className="size-3.5" aria-hidden="true" /> },
  videoinput: { label: "Camera", empty: "No camera available", icon: <Video className="size-3.5" aria-hidden="true" /> },
  audiooutput: { label: "Speaker", empty: "System default", icon: <Volume2 className="size-3.5" aria-hidden="true" /> },
};

function DeviceMenu({ label, kinds, off }: { label: string; kinds: MediaDeviceKind[]; off: boolean }) {
  return (
    <Dropdown.Root>
      <Tip label={label} hoverOnly>
        <Dropdown.Trigger className="ctrl group" data-off={off} aria-label={label}>
          <ChevronUp className="size-4 transition-transform group-aria-expanded:rotate-180" />
        </Dropdown.Trigger>
      </Tip>
      <Dropdown.Portal>
        <Dropdown.Content side="top" align="start" sideOffset={10} collisionPadding={12} className="menu">
          <DeviceGroups kinds={kinds} />
        </Dropdown.Content>
      </Dropdown.Portal>
    </Dropdown.Root>
  );
}

/** Mounted only while a menu is open, so device lists are always fresh. */
function DeviceGroups({ kinds }: { kinds: MediaDeviceKind[] }) {
  return kinds.map((kind, index) => <DeviceGroup key={kind} kind={kind} separated={index > 0} />);
}

function DeviceGroup({ kind, separated }: { kind: MediaDeviceKind; separated: boolean }) {
  const meta = DEVICE_META[kind];
  const toast = useToast();
  const devices = useDeviceList(kind, null);
  const { activeDeviceId, setActiveMediaDevice } = useMediaDeviceSelect({ kind, requestPermissions: false });
  // Browsers that can't route audio output simply list no speakers; skip the group.
  if (kind === "audiooutput" && devices.length === 0) return null;
  return (
    <>
      {separated && <div className="menu-sep" />}
      <DeviceRadioGroup
        label={meta.label}
        icon={meta.icon}
        devices={devices}
        activeId={activeDeviceId}
        emptyText={meta.empty}
        onSelect={(id) =>
          setActiveMediaDevice(id).catch(() =>
            toast.push({
              title: `Couldn't switch ${meta.label.toLowerCase()}`,
              tone: "danger",
              icon: <CircleAlert className="size-5" />,
            }),
          )
        }
      />
    </>
  );
}

function Clock() {
  const [now, setNow] = useState<Date | null>(null);
  useEffect(() => {
    const tick = () => setNow(new Date());
    const first = setTimeout(tick, 0);
    const timer = setInterval(tick, 10_000);
    return () => {
      clearTimeout(first);
      clearInterval(timer);
    };
  }, []);
  return (
    <time className="shrink-0 font-medium tabular-nums">
      {now ? now.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }) : " "}
    </time>
  );
}
