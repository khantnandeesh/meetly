import { randomUUID } from "node:crypto";
import { isValidCode } from "./code";
import { liveKitCaller, parseRoomMeta, roomService, updateMeta } from "./host.server";
import type { Pass } from "./pass.server";
import { addStoredPoll, castStoredVote, storedVotesOf, type PollError } from "./pollStore";
import { POLL_ID, checkNewPoll } from "./rtc/shared";

/**
 * Polls on LiveKit builds, by way of this server.
 *
 * LiveKit has no polls and this app has no storage, so a poll lives where the rest of the
 * meeting's record does: in the room's metadata, which only the API secret can write and which
 * LiveKit hands to everyone in the call, including whoever joins later. A browser cannot write
 * it, so it cannot add a vote, change a count or start a poll except by asking here:
 *
 * - `create`: the caller's token says who they are; the record says whether that is the host or
 *   a co-host. Nobody else may.
 * - `vote`: the caller must be in the call right now. One vote per identity, and per browser
 *   (see ./pollStore.ts). Voting again for the same option is accepted and changes nothing,
 *   which is what lets a client repeat a vote it cannot find in the record.
 * - `mine`: which polls this browser has already voted in, for a client that was reloaded.
 *
 * Ending a poll is a host action (`closePoll` in ./host.server.ts).
 *
 * Known limits, all from the record being read, changed and written back with no lock outside
 * this process: two votes that reach two server instances in the same instant can lose one of
 * them. The voter's client notices its vote missing from the record and sends it again. Someone
 * who joins from a second browser, or a private window, is a second person as far as anyone can
 * tell, and has a second vote.
 */

export type PollResult = { status: 200; data: Record<string, unknown> } | PollError | { status: 502; error: string };

const NOT_IN_CALL = { status: 403, error: "Join the meeting to use polls." } as const;
const HOSTS_ONLY = { status: 403, error: "Only the host and co-hosts can start a poll." } as const;

export async function liveKitPoll(token: unknown, body: Record<string, unknown>, passFor: (room: string) => Pass): Promise<PollResult> {
  const secret = process.env.LIVEKIT_API_SECRET ?? "";
  const service = roomService();
  // The token says who is asking, and the room confirms they are in it at this moment.
  const caller = typeof token === "string" ? await liveKitCaller(token) : null;
  if (!service || !secret || !caller || !isValidCode(caller.room)) return NOT_IN_CALL;
  const { room, identity, name } = caller;
  const earlier = () => passFor(room).ids;

  try {
    switch (body.action) {
      case "create": {
        const poll = checkNewPoll(body);
        if (typeof poll === "string") return { status: 400, error: poll };
        let refused: PollError | null = null;
        const next = await updateMeta(service, room, (meta) => {
          // Read from the record at the moment of writing, not from anything the caller says.
          if (meta.host !== identity && !meta.cohosts?.includes(identity)) {
            refused = HOSTS_ONLY;
            return meta;
          }
          const polls = addStoredPoll(meta.polls ?? [], poll, name, randomUUID().replace(/-/g, "").slice(0, 12), Date.now());
          if (!Array.isArray(polls)) {
            refused = polls;
            return meta;
          }
          return { ...meta, polls };
        });
        if (refused) return refused;
        return next ? { status: 200, data: {} } : NOT_IN_CALL;
      }
      case "vote": {
        const pollId = typeof body.pollId === "string" && POLL_ID.test(body.pollId) ? body.pollId : "";
        if (!pollId) return { status: 400, error: "Invalid request." };
        let outcome: ReturnType<typeof castStoredVote> | null = null;
        await updateMeta(service, room, (meta) => {
          const result = castStoredVote(meta.polls ?? [], pollId, body.option, { identity, earlier: earlier() }, room, secret);
          outcome = result;
          return result.status === 200 && result.polls ? { ...meta, polls: result.polls } : meta;
        });
        const result = outcome as ReturnType<typeof castStoredVote> | null;
        if (!result) return NOT_IN_CALL;
        return result.status === 200 ? { status: 200, data: { key: result.key, option: body.option } } : result;
      }
      case "mine": {
        const [existing] = await service.listRooms([room]);
        if (!existing) return { status: 200, data: { votes: {} } };
        const polls = parseRoomMeta(existing.metadata).polls ?? [];
        return { status: 200, data: { votes: storedVotesOf(polls, [...earlier(), identity], room, secret) } };
      }
    }
    return { status: 400, error: "Invalid request." };
  } catch (error) {
    console.error("Poll request failed", error);
    return { status: 502, error: "That didn't work. Try again." };
  }
}
