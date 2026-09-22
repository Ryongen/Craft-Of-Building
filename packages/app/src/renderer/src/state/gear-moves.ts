/**
 * Putting gear on and taking it off, as pure functions over the document.
 *
 * One module, because three things have to agree on what a click does: the store that performs
 * it, the swap preview that prices it while the pointer hovers, and the compare card beside the
 * editor. When each built its own document the preview could price a swap the click would not
 * perform — Ring 2's list used to preview replacing Ring 2 and then take off Ring 1.
 *
 * ## Worn twice is one item
 *
 * A ring can fill both ring slots, and a weapon that can be dual wielded can fill both hands, as
 * **one** item carrying `mirrored` (see `Item.mirrored`). So a place on the paperdoll is not an
 * entry of `doc.gear` but an entry plus which of its places — {@link WornAt}. Taking off one half
 * of a mirrored item leaves the other half worn; nothing is copied, so nothing can pile up or
 * drift apart.
 */

import type { BuildDoc, Item } from "@cte2/schema";

/** One place something is worn in. */
export type WornAt = {
  /** The entry of `doc.gear`. */
  index: number;
  /** The second place of a `mirrored` item — the other ring slot, or the offhand. */
  mirror: boolean;
  /**
   * Whether the entry is a weapon. Decides where a mirrored weapon stays when its mainhand half
   * comes off: in the offhand, which is where the half left behind was.
   */
  weapon: boolean;
};

/** What arrives in a place. */
export type Arrival =
  /** A benched piece, into the offhand when `offhand` is set. */
  | { from: "pool"; index: number; offhand: boolean }
  /** `doc.gear[index]`, worn in its second place as well. */
  | { from: "mirror"; index: number };

export type Move = { vacate?: WornAt | undefined; put?: Arrival | undefined };

/** The item as it sits on the bench: which hand, and whether it is worn twice, are not its own. */
export function benched(item: Item): Item {
  const { offhand: _offhand, mirrored: _mirrored, ...rest } = item;
  return rest;
}

/**
 * The document after `move`, and the entry of `doc.gear` the arrival ended up in.
 *
 * The place is emptied first and filled second, which is what makes "choose X in Ring 2" one
 * edit: Ring 2's occupant goes to the bench (or, if it was the mirror of Ring 1, simply stops
 * being worn twice), then X arrives.
 */
export function applyMove(doc: BuildDoc, move: Move): { doc: BuildDoc; at: number | undefined } {
  let gear = [...(doc.gear ?? [])];
  let pool = [...(doc.itemPool ?? [])];
  let removed: number | undefined;

  const leaving = move.vacate === undefined ? undefined : gear[move.vacate.index];
  if (move.vacate !== undefined && leaving !== undefined) {
    const { index, mirror, weapon } = move.vacate;
    if (leaving.mirrored === true) {
      // One of two places empties and the item stays in the other. A weapon losing its mainhand
      // half is left holding only the offhand one.
      const { mirrored: _mirrored, offhand: _offhand, ...once } = leaving;
      gear[index] = !mirror && weapon ? { ...once, offhand: true } : once;
    } else {
      gear = gear.filter((_, i) => i !== index);
      pool = [...pool, benched(leaving)];
      removed = index;
    }
  }

  let at: number | undefined;
  const put = move.put;
  if (put?.from === "pool") {
    const arriving = pool[put.index];
    if (arriving !== undefined) {
      pool = pool.filter((_, i) => i !== put.index);
      gear = [...gear, put.offhand ? { ...benched(arriving), offhand: true } : benched(arriving)];
      at = gear.length - 1;
    }
  } else if (put?.from === "mirror") {
    // The vacated entry may have sat before this one, in which case everything after it moved up.
    const index = removed !== undefined && removed < put.index ? put.index - 1 : put.index;
    const item = gear[index];
    if (item !== undefined) {
      const { offhand: _offhand, ...plain } = item;
      gear[index] = { ...plain, mirrored: true };
      at = index;
    }
  }

  return { doc: withLists(doc, gear, pool), at };
}

/** `gear` and `itemPool` set, and dropped when empty — what a hand-written document looks like. */
function withLists(doc: BuildDoc, gear: Item[], pool: Item[]): BuildDoc {
  const next: BuildDoc = { ...doc, gear, itemPool: pool };
  if (gear.length === 0) delete next.gear;
  if (pool.length === 0) delete next.itemPool;
  return next;
}
