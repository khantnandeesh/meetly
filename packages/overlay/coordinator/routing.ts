/**
 * What the two entry points share besides the core: how a path names a session, and how to run
 * one call on a core at a time. Pure, so it loads in Node and in a Worker alike.
 *
 * Owner: E-coordinator.
 */

/** `/overlay/v1/rooms/<room><rest>`, where `rest` is "/ws", "/stats", "/end", "/kick", "/tree" or "/metrics". */
export const ROOM_PATH = /^\/overlay\/v1\/rooms\/([^/]{1,192})(\/[a-z]+)$/;

export const HEALTH_PATH = "/overlay/v1/health";

/** A session's name: Meetly's meeting code. At most 64 characters, as tickets and grants allow. */
const ROOM_NAME = /^[A-Za-z0-9._~-]{1,64}$/;

export function parseRoomPath(pathname: string): { room: string; rest: string } | null {
  const match = ROOM_PATH.exec(pathname);
  if (!match) return null;
  let room: string;
  try {
    room = decodeURIComponent(match[1]);
  } catch {
    return null;
  }
  return ROOM_NAME.test(room) ? { room, rest: match[2] } : null;
}

/**
 * A queue of one. The core must never run two calls at once (it awaits its signatures), and
 * events must reach it in the order they happened.
 */
export function createSerial(): <T>(task: () => Promise<T>) => Promise<T> {
  let tail: Promise<unknown> = Promise.resolve();
  return <T>(task: () => Promise<T>): Promise<T> => {
    const run = tail.then(task, task);
    tail = run.catch(() => {});
    return run;
  };
}
