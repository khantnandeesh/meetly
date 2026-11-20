/**
 * Where reactions go once they arrive, kept outside React so a burst of them re-renders only the
 * few elements that show one (the same reasoning as ChatStore: the stage must not re-render
 * because somebody clapped).
 *
 * One signal per reaction: if the sender's tile is in front of you the emoji pops on that tile;
 * if it is not (another gallery page, the "+N more" cell, Spotlight) it rises in a lane at the
 * stage's bottom-left with their first name. Never both. Nothing is stored and nothing sounds.
 */

/** How long a reaction stays on a tile, and how long a lane entry takes to rise and fade. */
export const REACTION_SHOW_MS = 3000;
/** At most this many entries in the lane; past it, same-emoji reactions merge into "×N". */
export const LANE_LIMIT = 12;
/** Screen readers hear about reactions at most this often. */
export const ANNOUNCE_EVERY_MS = 3000;

export type LaneEntry = {
  id: number;
  emoji: string;
  /** Who sent it, or empty once several people's reactions were merged into this entry. */
  name: string;
  count: number;
};

export type TileReaction = { emoji: string; id: number };

/** Adds one reaction to the lane. Pure: returns the next lane. */
export function addToLane(lane: LaneEntry[], entry: Omit<LaneEntry, "count">, limit: number = LANE_LIMIT): LaneEntry[] {
  if (lane.length < limit) return [...lane, { ...entry, count: 1 }];
  // Full: fold it into the newest entry showing the same emoji, which then speaks for a crowd.
  const same = lane.findLastIndex((other) => other.emoji === entry.emoji);
  if (same === -1) return [...lane.slice(1), { ...entry, count: 1 }];
  return lane.map((other, index) => (index === same ? { ...other, name: "", count: other.count + 1 } : other));
}

/** "Maya reacted 👏", "Maya and Sam reacted", "Maya and 4 others reacted 👏". */
export function describeReactions(batch: { name: string; emoji: string }[]): string {
  if (batch.length === 0) return "";
  const names = Array.from(new Set(batch.map((entry) => entry.name)));
  const emojis = new Set(batch.map((entry) => entry.emoji));
  const who =
    names.length === 1
      ? names[0]
      : names.length === 2
        ? `${names[0]} and ${names[1]}`
        : `${names[0]} and ${names.length - 1} others`;
  return `${who} reacted${emojis.size === 1 ? ` ${batch[0].emoji}` : ""}`;
}

type Listener = () => void;

export function createReactionStore(schedule: (run: () => void, ms: number) => unknown = setTimeout) {
  let nextId = 1;
  let lane: LaneEntry[] = [];
  let announcement = "";
  let pending: { name: string; emoji: string }[] = [];
  let announcing = false;
  const tiles = new Map<string, TileReaction>();
  const listeners = new Map<string, Set<Listener>>();

  const notify = (channel: string) => listeners.get(channel)?.forEach((listener) => listener());
  const subscribe = (channel: string) => (listener: Listener) => {
    let set = listeners.get(channel);
    if (!set) listeners.set(channel, (set = new Set()));
    set.add(listener);
    return () => {
      set.delete(listener);
    };
  };

  const announce = () => {
    announcing = false;
    if (pending.length === 0) return;
    announcement = describeReactions(pending);
    pending = [];
    notify("announce");
    // The next batch waits its turn, so the region changes at most once per interval.
    announcing = true;
    schedule(announce, ANNOUNCE_EVERY_MS);
  };

  return {
    /**
     * A reaction arrived. `onTile` says whether the sender's tile is in view right now; `name`
     * is how the lane and the announcement call them.
     */
    add(identity: string, name: string, emoji: string, onTile: boolean): void {
      const id = nextId++;
      if (onTile) {
        tiles.set(identity, { emoji, id });
        notify(`tile:${identity}`);
        schedule(() => {
          if (tiles.get(identity)?.id !== id) return;
          tiles.delete(identity);
          notify(`tile:${identity}`);
        }, REACTION_SHOW_MS);
      } else {
        lane = addToLane(lane, { id, emoji, name });
        notify("lane");
      }
      pending.push({ name, emoji });
      if (!announcing) {
        announcing = true;
        // A moment to gather a burst into one sentence.
        schedule(announce, 400);
      }
    },
    /** A lane entry finished rising. */
    drop(id: number): void {
      if (!lane.some((entry) => entry.id === id)) return;
      lane = lane.filter((entry) => entry.id !== id);
      notify("lane");
    },
    clear(): void {
      lane = [];
      pending = [];
      announcement = "";
      const shown = Array.from(tiles.keys());
      tiles.clear();
      shown.forEach((identity) => notify(`tile:${identity}`));
      notify("lane");
      notify("announce");
    },
    lane: () => lane,
    announcement: () => announcement,
    tile: (identity: string): TileReaction | undefined => tiles.get(identity),
    subscribeLane: subscribe("lane"),
    subscribeAnnouncement: subscribe("announce"),
    subscribeTile: (identity: string) => subscribe(`tile:${identity}`),
  };
}

export type ReactionStore = ReturnType<typeof createReactionStore>;

/** One call at a time, so one store. */
export const reactions = createReactionStore();
