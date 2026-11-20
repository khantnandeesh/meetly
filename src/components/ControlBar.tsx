"use client";

import {
  Bell,
  Check,
  ChevronUp,
  CircleAlert,
  Ellipsis,
  Hand,
  Keyboard,
  LayoutGrid,
  LoaderCircle,
  LogOut,
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
import { useCopied } from "@/lib/hooks";
import { noteOwnCameraToggle } from "@/lib/ownToggles";
import { useActiveDevice, useCall, useLocalToggle } from "@/lib/rtc/react";
import { useDeviceList } from "@/lib/usePreviewMedia";
import { sounds, type SoundLevel, type SoundName } from "@/lib/sounds";
import type { CallSettings } from "@/lib/useCallSettings";
import { noteOwnMicToggle, useSoundSettings } from "@/lib/useSounds";
import { useUnread } from "./ChatStore";
import { useHost } from "./HostTools";
import { LayoutMenuItems } from "./LayoutMenu";
import { ReactMenu } from "./Reactions";
import { DeviceRadioGroup, Dropdown } from "./ui/Menu";
import { CopyIcon } from "./ui/CopyIcon";
import { Tip } from "./ui/Tip";
import { useToast } from "./ui/Toaster";

export type Panel = "chat" | "people" | null;

export function ControlBar({
  code,
  phone,
  panel,
  headcount,
  handRaised,
  hands,
  onToggleHand,
  reactOpen,
  onReactOpenChange,
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
  /** Large screens: the raised-hands summary, shown beside the people control. */
  hands?: React.ReactNode;
  onToggleHand: () => void;
  /** The reactions strip, opened from here or with R. */
  reactOpen: boolean;
  onReactOpenChange: (open: boolean) => void;
  onTogglePanel: (panel: Exclude<Panel, null>) => void;
  onCopyLink: () => Promise<boolean>;
  onShowShortcuts: () => void;
  settings: CallSettings;
  onSettings: (patch: Partial<CallSettings>) => void;
}) {
  const call = useCall();
  const toast = useToast();
  const copyState = useCopied(onCopyLink);
  const { isHost, waiting, askEnd } = useHost();

  const deviceError = (what: string) => () =>
    toast.push({
      title: `Couldn't start your ${what}`,
      body: "Check your browser's permissions for this site and try again.",
      tone: "danger",
      icon: <CircleAlert className="size-5" />,
      duration: 7000,
    });
  const mic = useLocalToggle("microphone", deviceError("microphone"));
  const cam = useLocalToggle("camera", deviceError("camera"));
  // Dismissing the browser's screen picker is not an error worth a message.
  const share = useLocalToggle("screen_share");

  const micLabel = mic.enabled ? "Mute microphone" : "Unmute microphone";
  const camLabel = cam.enabled ? "Turn off camera" : "Turn on camera";
  const handLabel = handRaised ? "Lower hand" : "Raise hand";

  const micButton = (
    <Tip label={micLabel} shortcut={phone ? undefined : "M"}>
      <button className="ctrl" data-ctl={mic.enabled ? "on" : "off"} aria-label={micLabel}
        onClick={() => {
          noteOwnMicToggle();
          mic.toggle();
        }}
      >
        {mic.enabled ? <Mic className="size-5" /> : <MicOff className="size-5" />}
      </button>
    </Tip>
  );
  const camButton = (
    <Tip label={camLabel} shortcut={phone ? undefined : "V"}>
      <button
        className="ctrl"
        data-ctl={cam.enabled ? "on" : "off"}
        aria-label={camLabel}
        onClick={() => {
          noteOwnCameraToggle();
          cam.toggle();
        }}
      >
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
  const reactButton = (
    <ReactMenu phone={phone} open={reactOpen} onOpenChange={onReactOpenChange} handRaised={handRaised} onToggleHand={onToggleHand} />
  );
  const chatButton = <ChatButton open={panel === "chat"} phone={phone} onToggle={onTogglePanel} />;
  const leaveButton = (
    <Tip label="Leave call">
      <button className="ctrl ctrl-danger max-md:ml-2 md:w-16" aria-label="Leave call" onClick={() => call.disconnect().catch(() => {})}>
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
        <Dropdown.Content
          side="top"
          align={phone ? "end" : "center"}
          sideOffset={10}
          collisionPadding={12}
          className={phone ? "menu menu-tall w-80" : "menu"}
        >
          <Dropdown.Item
            className="menu-item"
            onSelect={(event) => {
              // Stay open for a moment so the confirmation is seen where the tap landed.
              event.preventDefault();
              copyState.copy();
            }}
          >
            <span className="text-muted">
              <CopyIcon copied={copyState.copied} />
            </span>
            <span role="status">{copyState.copied ? "Link copied" : "Copy meeting link"}</span>
          </Dropdown.Item>
          {phone ? (
            <>
              <div className="menu-sep" />
              <LayoutMenuItems settings={settings} onChange={onSettings} showTileLimit={false} />
              <div className="menu-sep" />
              <DeviceGroups kinds={["audioinput", "videoinput", "audiooutput"]} />
              {isHost && (
                <>
                  <div className="menu-sep" />
                  <Dropdown.Item className="menu-item text-danger-text" onSelect={askEnd}>
                    <PhoneOff className="size-4" aria-hidden="true" />
                    End call for everyone
                  </Dropdown.Item>
                </>
              )}
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
          {reactButton}
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
            onClick={copyState.copy}
            aria-label={`Copy meeting link, code ${code}`}
            className="-ml-2 inline-flex h-10 min-w-0 cursor-pointer items-center gap-2 rounded-xl px-2 font-mono text-[0.8125rem] transition-colors hover:bg-surface-2 hover:text-text"
          >
            {/* Both labels share one cell, so the confirmation does not change the button's width. */}
            <span className="grid min-w-0">
              <span className={`col-start-1 row-start-1 truncate ${copyState.copied ? "invisible" : ""}`}>{code}</span>
              <span className={`col-start-1 row-start-1 text-text ${copyState.copied ? "" : "invisible"}`} role="status">
                {copyState.copied ? "Copied" : ""}
              </span>
            </span>
            <CopyIcon copied={copyState.copied} />
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
        {reactButton}
        {moreMenu}
        <span className="mx-1 h-6 w-px bg-border-strong" aria-hidden="true" />
        {isHost ? (
          // Leaving stays one tap for the host too; ending the call for everyone is beside it.
          <div className="ctrl-split">
            {leaveButton}
            <Dropdown.Root>
              <Tip label="More ways to leave" hoverOnly>
                <Dropdown.Trigger className="ctrl ctrl-danger group" aria-label="More ways to leave">
                  <ChevronUp className="size-4 transition-transform group-aria-expanded:rotate-180" />
                </Dropdown.Trigger>
              </Tip>
              <Dropdown.Portal>
                <Dropdown.Content side="top" align="end" sideOffset={10} collisionPadding={12} className="menu">
                  <Dropdown.Item className="menu-item" onSelect={() => call.disconnect().catch(() => {})}>
                    <LogOut className="size-4 text-muted" aria-hidden="true" />
                    Leave call
                  </Dropdown.Item>
                  <Dropdown.Item className="menu-item text-danger-text" onSelect={askEnd}>
                    <PhoneOff className="size-4" aria-hidden="true" />
                    End call for everyone
                  </Dropdown.Item>
                </Dropdown.Content>
              </Dropdown.Portal>
            </Dropdown.Root>
          </div>
        ) : (
          leaveButton
        )}
      </div>

      <div className="flex min-w-0 items-center justify-end gap-2">
        {hands}
        <Dropdown.Root>
          <Tip label="Change layout" hoverOnly>
            <Dropdown.Trigger className="ctrl" aria-label="Change layout">
              <LayoutGrid className="size-5" />
            </Dropdown.Trigger>
          </Tip>
          <Dropdown.Portal>
            <Dropdown.Content side="top" align="end" sideOffset={10} collisionPadding={12} className="menu menu-tall w-80">
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
            {waiting.length > 0 && (
              // Stays for as long as somebody is waiting; the notification is what announces them.
              <span
                className="absolute -top-1.5 -right-1.5 grid h-5 min-w-5 place-items-center rounded-full bg-accent px-1 text-[0.6875rem] font-bold text-accent-ink ring-3 ring-bg"
                data-waiting-count
              >
                {waiting.length > 9 ? "9+" : waiting.length}
                <span className="sr-only"> waiting to join</span>
              </span>
            )}
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
          // Pops in for the first unread message only; after that the number just changes.
          <span
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
  return (
    <>
      {kinds.map((kind, index) => (
        <DeviceGroup key={kind} kind={kind} separated={index > 0} />
      ))}
      {kinds.includes("audiooutput") && <SoundGroup />}
    </>
  );
}

const SOUND_LEVELS: { value: SoundLevel; label: string; hint: string; preview: SoundName }[] = [
  { value: "all", label: "All sounds", hint: "People joining, hands, chat, your mic", preview: "joined" },
  { value: "important", label: "Important only", hint: "Connection, call ended, muted by host", preview: "connected" },
  { value: "off", label: "Off", hint: "No interface sounds", preview: "micOff" },
];

/** How much the interface itself is heard. Choosing a level plays an example of it. */
function SoundGroup() {
  const [settings, update] = useSoundSettings();
  return (
    <>
      <div className="menu-sep" />
      <Dropdown.Label className="menu-label">
        <Bell className="size-3.5" aria-hidden="true" />
        Sounds
      </Dropdown.Label>
      <Dropdown.RadioGroup
        value={settings.level}
        onValueChange={(value) => {
          const level = SOUND_LEVELS.find((entry) => entry.value === value);
          if (!level) return;
          update({ level: level.value });
          // An example of what this level lets through; "Off" answers with silence.
          if (level.value !== "off") sounds.play(level.preview, { preview: true });
        }}
      >
        {SOUND_LEVELS.map((level) => (
          <Dropdown.RadioItem
            key={level.value}
            value={level.value}
            // Stay open: the choice is heard, and can be changed again straight away.
            onSelect={(event) => event.preventDefault()}
            className="menu-item pr-10"
          >
            <span className="min-w-0">
              <span className="block font-medium">{level.label}</span>
              <span className="block text-xs text-muted">{level.hint}</span>
            </span>
            <Dropdown.ItemIndicator className="absolute right-3 text-accent">
              <Check className="size-4" aria-hidden="true" />
            </Dropdown.ItemIndicator>
          </Dropdown.RadioItem>
        ))}
      </Dropdown.RadioGroup>
    </>
  );
}

function DeviceGroup({ kind, separated }: { kind: MediaDeviceKind; separated: boolean }) {
  const meta = DEVICE_META[kind];
  const toast = useToast();
  const devices = useDeviceList(kind, null);
  const call = useCall();
  const activeDeviceId = useActiveDevice(kind);
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
          call.setDevice(kind, id).catch(() =>
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
