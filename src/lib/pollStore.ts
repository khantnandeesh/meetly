import { createHmac } from "node:crypto";
import { tally, type StoredPoll } from "./rtc/shared";
import { POLL_LIMITS, type NewPoll } from "./rtc/types";

/**
 * The rules for polls on LiveKit builds, as plain functions over the list the meeting's record
 * holds. Nothing here talks to LiveKit: ./polls.server.ts reads the record, applies one of these
 * and writes the result back. Server only (it signs with the API secret).
 *
 * One vote per person means, without accounts: one per identity our server minted, and one per
 * browser, since the browser's signed pass lists the identities it has held in this meeting.
 */

/** Most votes one poll takes. The record is sent to everyone on every change, so it has a ceiling. */
export const MAX_VOTERS = 150;
/** Finished polls kept for people to look back at; older ones are dropped. */
const KEEP_CLOSED = 5;

export type PollError = { status: 400 | 403 | 404 | 409; error: string };

/**
 * What stands for a voter in the record. In a named poll it is their identity, which every
 * client can match to a person. In an anonymous one it is a keyed hash that only our server can
 * compute: enough to refuse a second vote, useless for finding out whose the first was.
 */
export function voterKey(poll: Pick<StoredPoll, "id" | "a">, room: string, identity: string, secret: string): string {
  if (!poll.a) return identity;
  return createHmac("sha256", `meetly-poll:${secret}`).update(`${room}\n${poll.id}\n${identity}`).digest("base64url").slice(0, 12);
}

/** The list with one more poll on it, or why not. `poll` has already been through `checkNewPoll`. */
export function addStoredPoll(polls: StoredPoll[], poll: NewPoll, by: string, id: string, now: number): StoredPoll[] | PollError {
  const open = polls.filter((existing) => !existing.c);
  if (open.length >= POLL_LIMITS.open) {
    return { status: 409, error: `There are already ${POLL_LIMITS.open} polls open. End one first.` };
  }
  const closed = polls.filter((existing) => existing.c).slice(-KEEP_CLOSED);
  const kept = polls.filter((existing) => !existing.c || closed.includes(existing));
  return [...kept, { id, q: poll.question, o: poll.options, ...(poll.anonymous ? { a: 1 as const } : {}), by, at: now, v: {} }];
}

export type VoteOutcome = PollError | { status: 200; polls: StoredPoll[] | null; key: string };

/**
 * Counts `identity`'s vote. `earlier` are identities the same browser held before (from its
 * signed pass): a vote under any of them is this person's vote too. Asking again for the vote
 * already counted is fine and changes nothing (`polls: null`); asking for a different one is not.
 */
export function castStoredVote(
  polls: StoredPoll[],
  pollId: string,
  option: unknown,
  voter: { identity: string; earlier: string[] },
  room: string,
  secret: string,
): VoteOutcome {
  const poll = polls.find((entry) => entry.id === pollId);
  if (!poll) return { status: 404, error: "That poll is no longer there." };
  if (poll.c || !poll.v) return { status: 409, error: "That poll has ended." };
  if (typeof option !== "number" || !Number.isInteger(option) || option < 0 || option >= poll.o.length) {
    return { status: 400, error: "That isn't one of the options." };
  }
  const key = voterKey(poll, room, voter.identity, secret);
  if (key in poll.v) {
    return poll.v[key] === option ? { status: 200, polls: null, key } : { status: 409, error: "You've already voted in this poll." };
  }
  for (const identity of voter.earlier) {
    if (identity !== voter.identity && voterKey(poll, room, identity, secret) in poll.v) {
      return { status: 409, error: "You've already voted in this poll." };
    }
  }
  if (Object.keys(poll.v).length >= MAX_VOTERS) return { status: 409, error: "This poll can't take any more votes." };
  const voted: StoredPoll = { ...poll, v: { ...poll.v, [key]: option } };
  return { status: 200, polls: polls.map((entry) => (entry === poll ? voted : entry)), key };
}

/** The list with that poll closed: its counts kept, its voters dropped. Null if there is no such poll. */
export function closeStoredPoll(polls: StoredPoll[], pollId: string): StoredPoll[] | null {
  const poll = polls.find((entry) => entry.id === pollId);
  if (!poll) return null;
  if (poll.c) return polls;
  const { v: _voters, ...rest } = poll;
  void _voters;
  return polls.map((entry) => (entry === poll ? { ...rest, c: tally(poll) } : entry));
}

/** Which open polls any of `identities` has voted in, with the choice and the key it is recorded under. */
export function storedVotesOf(
  polls: StoredPoll[],
  identities: string[],
  room: string,
  secret: string,
): Record<string, { option: number; key: string }> {
  const mine: Record<string, { option: number; key: string }> = {};
  for (const poll of polls) {
    if (!poll.v) continue;
    for (const identity of identities) {
      const key = voterKey(poll, room, identity, secret);
      if (key in poll.v) mine[poll.id] = { option: poll.v[key], key };
    }
  }
  return mine;
}
