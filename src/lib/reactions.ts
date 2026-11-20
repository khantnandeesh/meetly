/**
 * Where reactions go once they arrive, kept outside React so a burst of them re-renders only the
 * few elements that show one (the same reasoning as ChatStore: the stage must not re-render
 * because somebody clapped).
 *
 * One signal per reaction: if the sender's tile is in front of you the emoji pops on that tile;
 * if it is not (another gallery page, the "+N more" cell, Spotlight) it rises in a lane at the
 * stage's bottom-left, above the speaker's name label. Never both. Nothing is stored and nothing
 * sounds.
 *
 * The lane is kept short, because every row of it covers somebody's video: at most four rows on a
 * large screen and three on a phone. In a small meeting each row is one person's reaction with
 * their first name ("🎉 Maya"). In a bigger one, or once the lane is full, reactions with the same
 * emoji share a row whose count climbs ("👏 ×37"), so six emoji never need more than six rows.
 * From 200 people the lane shows counts only: one name picked out of a crowd that size says
 * nothing about the room.
 */

/** How long a reaction stays on a tile, and how long a lane row stays after its last reaction. */
export const REACTION_SHOW_MS = 3000;
/** Rows in the lane on a large screen, and on a phone, whose stage is about half as tall. */
export const LANE_LIMIT = 4;
export const PHONE_LANE_LIMIT = 3;
/** Above this many people every reaction joins the row for its emoji, even with room to spare. */
export const GROUP_ABOVE = 10;
/** From this many people the lane and the announcements carry counts only, never names. */
export const NAMELESS_FROM = 200;
/** Screen readers hear about reactions at most this often. */
export const ANNOUNCE_EVERY_MS = 3000;

export type LaneEntry = {
  id: number;
  emoji: string;
  /** Who sent it, or empty once several people's reactions share this row (or names are off). */
  name: string;
  count: number;
  /** The id of the latest reaction in this row: the row with the oldest is the first to make room. */
  touched: number;
  /** When the row appeared, in ms. */
  since: number;
};

export type TileReaction = { emoji: string; id: number };

export type LaneRules = {
  /** The most rows the lane may hold. */
  limit: number;
  /** How many people are in the meeting. */
  people: number;
  /** The time now, in ms; without it every row may make room. */
  now?: number;
};

/**
 * A row stays at least this long before it can make room for another emoji. Without it, a flood
 * spread evenly over six emoji and four rows would replace a row with every reaction (the row
 * that changed longest ago is always the next emoji to arrive), and the lane would flicker
 * instead of counting. A reaction that finds no room is still announced; it just has no row.
 */
export const ROW_STAYS_MS = 1000;

const SMALL_MEETING: LaneRules = { limit: LANE_LIMIT, people: 0 };

/**
 * Adds one reaction to the lane. Pure: returns the next lane.
 *
 * The lane is kept oldest first and drawn from the bottom up, so a new row appears on top and the
 * rows already on screen stay where they are. A row whose count grows keeps its place.
 */
export function addToLane(
  lane: LaneEntry[],
  entry: Omit<LaneEntry, "count" | "touched" | "since">,
  rules: LaneRules = SMALL_MEETING,
): LaneEntry[] {
  const now = rules.now ?? Infinity;
  const full = lane.length >= rules.limit;
  // In a bigger meeting, or once the lane is full, a reaction joins the row already showing its emoji.
  if (rules.people > GROUP_ABOVE || full) {
    const same = lane.findLastIndex((other) => other.emoji === entry.emoji);
    if (same !== -1) {
      return lane.map((other, index) => (index === same ? { ...other, name: "", count: other.count + 1, touched: entry.id } : other));
    }
  }
  const row = { ...entry, name: rules.people >= NAMELESS_FROM ? "" : entry.name, count: 1, touched: entry.id, since: rules.now ?? 0 };
  if (!full) return [...lane, row];
  // Full, and no row shows this emoji: of the rows that have been up long enough, the one that
  // changed longest ago makes room.
  let stalest = -1;
  lane.forEach((other, index) => {
    if (now - other.since >= ROW_STAYS_MS && (stalest === -1 || other.touched < lane[stalest].touched)) stalest = index;
  });
  if (stalest === -1) return lane;
  return [...lane.slice(0, stalest), ...lane.slice(stalest + 1), row];
}

/** Keeps the `limit` rows that changed most recently, in their order. */
function trimLane(lane: LaneEntry[], limit: number): LaneEntry[] {
  if (lane.length <= limit) return lane;
  const cutoff = lane.map((entry) => entry.touched).sort((a, b) => b - a)[limit - 1];
  return lane.filter((entry) => entry.touched >= cutoff);
}

/**
 * "Maya reacted 👏", "Maya and Sam reacted", "Maya and 4 others reacted 👏". Without names (a
 * meeting of 200 or more): "12 reactions 👏".
 */
export function describeReactions(batch: { name: string; emoji: string }[], named = true): string {
  if (batch.length === 0) return "";
  const emojis = new Set(batch.map((entry) => entry.emoji));
  if (!named) return `${batch.length === 1 ? "1 reaction" : `${batch.length} reactions`}${emojis.size === 1 ? ` ${batch[0].emoji}` : ""}`;
  const names = Array.from(new Set(batch.map((entry) => entry.name)));
  const who =
    names.length === 1
      ? names[0]
      : names.length === 2
        ? `${names[0]} and ${names[1]}`
        : `${names[0]} and ${names.length - 1} others`;
  return `${who} reacted${emojis.size === 1 ? ` ${batch[0].emoji}` : ""}`;
}

type Listener = () => void;

export function createReactionStore(schedule: (run: () => void, ms: number) => unknown = setTimeout, clock: () => number = Date.now) {
  let nextId = 1;
  let lane: LaneEntry[] = [];
  let announcement = "";
  let pending: { name: string; emoji: string }[] = [];
  let announcing = false;
  let rules = SMALL_MEETING;
  let room = Infinity;
  const tiles = new Map<string, TileReaction>();
  const listeners = new Map<string, Set<Listener>>();

  const notify = (channel: string) => listeners.get(channel)?.forEach((listener) => listener());
  const current = (): LaneRules => ({ limit: Math.max(1, Math.min(rules.limit, room)), people: rules.people, now: clock() });
  /** A lane longer than the limit now allows sheds its stalest rows at once. */
  const fitLane = () => {
    const trimmed = trimLane(lane, current().limit);
    if (trimmed === lane) return;
    lane = trimmed;
    notify("lane");
  };
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
    announcement = describeReactions(pending, rules.people < NAMELESS_FROM);
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
        lane = addToLane(lane, { id, emoji, name }, current());
        notify("lane");
      }
      pending.push({ name, emoji });
      if (!announcing) {
        announcing = true;
        // A moment to gather a burst into one sentence.
        schedule(announce, 400);
      }
    },
    /** How many rows the lane may hold (4, or 3 on a phone) and how big the meeting is; the feed keeps these current. */
    setRules(next: LaneRules): void {
      rules = next;
      fitLane();
    },
    /**
     * How many rows fit above the name label without reaching the tile above it (a dense
     * gallery's tiles can be shorter than four rows). The lane measures this; the limit is then
     * whichever is smaller.
     */
    setRoom(rows: number): void {
      if (rows === room) return;
      room = rows;
      fitLane();
    },
    /** A lane row finished leaving. */
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
