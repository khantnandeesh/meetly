import type RealtimeKitClient from "@cloudflare/realtimekit";
import type { RTKParticipant, StageStatus } from "@cloudflare/realtimekit";
import { notice } from "./shared";
import type { CallMode, HostAction, ParticipantRole } from "./types";

/**
 * Webinars on RealtimeKit, in the browser: RealtimeKit's own stage (`meeting.stage`).
 *
 * Who may publish is RealtimeKit's to enforce: the audience holds the webinar viewer preset,
 * whose microphone, camera and screen are "can request", so nothing of theirs is sent until the
 * stage lets them on. Each person has a stage status:
 *
 * - OFF_STAGE: watching.
 * - REQUESTED_TO_JOIN_STAGE: asked to come up. Meetly does not use this; a raised hand is
 *   Meetly's own, as in a meeting.
 * - ACCEPTED_TO_JOIN_STAGE: the host invited them (`grantAccess`), and they have not answered.
 *   This is `stageInvite`. Saying yes is `stage.join()`, which is when anything is sent.
 * - ON_STAGE: speaking; a tile for everyone.
 *
 * The host's preset may join the stage directly; the adapter does so for them on joining.
 *
 * Nothing here asks RealtimeKit who is in the meeting: statuses come with the participants the
 * SDK already announced and with their `stageStatusUpdate` events.
 */

type Meeting = RealtimeKitClient;

/** What someone who is not the host is, from their stage status. */
export function stageRole(mode: CallMode, status: StageStatus | undefined): ParticipantRole {
  if (mode !== "webinar") return "speaker";
  return status === "ON_STAGE" ? "speaker" : "viewer";
}

/** What `act` needs from the adapter. */
export type StageContext = {
  /** Your identity, as everyone sees it. */
  self: string;
  /** The SDK's participant for an identity, if they are here. */
  peerOf(identity: string): RTKParticipant | undefined;
  /** Asks our server whether you may (host or co-host, and a webinar). Rejects with a sentence fit to show. */
  authorize(): Promise<unknown>;
};

export class RealtimeKitStage {
  /**
   * You said "Not now" to an invitation. RealtimeKit's docs do not say what `stage.leave()` does
   * to an invitation not yet taken up, so your answer is also kept here, until your status moves.
   */
  private declined = false;
  private last: StageStatus | undefined;
  private readonly mode: CallMode;
  private readonly onChange: () => void;

  constructor(mode: CallMode, onChange: () => void) {
    this.mode = mode;
    this.onChange = onChange;
  }

  /** You have been invited on stage and have not answered. */
  invited(meeting: Meeting | null, host: boolean): boolean {
    return this.mode === "webinar" && !host && !this.declined && meeting?.stage?.status === "ACCEPTED_TO_JOIN_STAGE";
  }

  /**
   * Follows your own stage status once you are in. The host goes straight on stage; anyone
   * else who leaves it stops sending (the stage has already stopped it reaching anyone).
   */
  watch(meeting: Meeting, host: () => boolean, on: (source: unknown, event: string, fn: (status: StageStatus) => void) => void): void {
    if (this.mode !== "webinar" || !meeting.stage) return;
    this.last = meeting.stage.status;
    on(meeting.stage, "stageStatusUpdate", (status: StageStatus) => {
      if (status === this.last) return;
      const was = this.last;
      this.last = status;
      this.declined = false;
      if (was === "ON_STAGE" && !host()) void stopSending(meeting);
      this.onChange();
    });
  }

  /** On joining: the host takes the stage, which their preset allows without asking. */
  joined(meeting: Meeting, host: boolean): Promise<void> {
    if (this.mode !== "webinar" || !host || !meeting.stage || meeting.stage.status === "ON_STAGE") return Promise.resolve();
    return meeting.stage.join();
  }

  /**
   * Carries out `{ action: "stage" }`.
   *
   * - For yourself: "Join stage" (`on`) takes up an invitation; "Not now" and "Back to audience"
   *   (`!on`) leave. Nobody else's leave is needed, so our server is not asked.
   * - For someone else (host, and co-hosts whose preset allows it): our server says whether you
   *   may, then the stage is changed: `grantAccess` to invite, `kick` for someone on stage,
   *   `denyAccess` to take back an invitation they have not answered.
   */
  async act(meeting: Meeting, action: Extract<HostAction, { action: "stage" }>, context: StageContext): Promise<void> {
    if (this.mode !== "webinar" || !meeting.stage) throw new Error("Only a webinar has a stage.");
    const stage = meeting.stage;
    if (action.identity === context.self) {
      if (action.on) {
        if (stage.status !== "ACCEPTED_TO_JOIN_STAGE" || this.declined) throw new Error("The invitation to speak has been withdrawn.");
        await stage.join();
        return;
      }
      if (stage.status === "ACCEPTED_TO_JOIN_STAGE") this.declined = true;
      await stopSending(meeting);
      await stage.leave();
      this.onChange();
      return;
    }
    // Co-hosts join with the audience's preset, which cannot change the stage.
    if (!meeting.self.permissions?.acceptStageRequests) throw notice("Only the host can invite people to speak in this webinar.");
    await context.authorize();
    const peer = context.peerOf(action.identity);
    if (!peer) throw new Error("That person may have already left.");
    if (action.on) await stage.grantAccess([peer.userId]);
    else if (peer.stageStatus === "ON_STAGE") await stage.kick([peer.userId]);
    else await stage.denyAccess([peer.userId]);
  }
}

/** Switches off whatever you are sending, quietly: leaving the stage has already stopped it reaching anyone. */
async function stopSending(meeting: Meeting): Promise<void> {
  const self = meeting.self;
  const ignore = () => {};
  if (self.audioEnabled) await Promise.resolve(self.disableAudio()).catch(ignore);
  if (self.videoEnabled) await Promise.resolve(self.disableVideo()).catch(ignore);
  if (self.screenShareEnabled) await Promise.resolve(self.disableScreenShare()).catch(ignore);
}
