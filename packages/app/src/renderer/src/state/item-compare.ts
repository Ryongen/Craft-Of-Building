/**
 * The item being looked at, and every place it could sit.
 *
 * A store rather than a prop, because the component that fills it and the card that reads it are
 * different: the gear panel knows which item you picked and where it could go, and
 * `ItemDiffCard` prices it.
 *
 * ## Why a list of positions rather than one slot
 *
 * Not every slot is singular. A character wears two rings and a candidate ring fits either, so
 * "what would this replace?" has two answers and both of them are true — price it against Ring 1
 * and the answer is one swap, price it against Ring 2 and it is another. A helmet has one
 * position and the list has one entry, which is the shape the single-slot version used to have.
 *
 * `against` on a position is `undefined` for an empty one, which is the commonest case in a fresh
 * build: nothing is coming off, so every line of the candidate is a gain. The diff reads the same
 * either way, which is why it is one component and not two.
 *
 * ## Why the indices are here and not just the items
 *
 * The card used to price a swap by subtracting one item's resolved stats from the other's, which
 * is a true statement about the two items and not the one anybody is asking about: a piece
 * granting 100 flat dodge is worth 200 on a character carrying +100% increased dodge, and worth a
 * different share of a hit at every armour rating. So the card builds the **document** each
 * choice would produce and runs the engine over it, and building a document needs to know which
 * entry of `doc.gear` gives way and where the candidate is coming from — not merely what those
 * items contain.
 *
 * Nothing here is part of the build document. Selecting an item to look at is not an edit, must
 * not land in the undo stack, and must not mark the build dirty — which is the other reason
 * this is its own store rather than a field on `useBuild`.
 */

import type { BuildDoc, Item } from "@cte2/schema";
import { create } from "zustand";

/** Where an item lives in the document. The gear panel's own `ItemRef`, restated for the store. */
export type ItemSource = { where: "gear" | "pool"; index: number };

/** One place the selected item could sit, and what is in it now. */
export type ComparePosition = {
  /** The paperdoll's own label for it — "Ring 2", "Weapon". */
  label: string;
  /** What occupies it today, or `undefined` when it is empty. */
  against: Item | undefined;
  /** `against`'s index in `doc.gear`, so the candidate document can take it off. */
  againstIndex: number | undefined;
  /** The one position the item itself is already in. */
  worn: boolean;
  /**
   * The document this choice produces, when the gear panel built it — through `applyMove`, the
   * same function the click runs. Absent, the card falls back to {@link docWithSwap}.
   */
  candidate?: BuildDoc;
};

type ItemCompareState = {
  /** The item the editor is open on, or `null` when nothing is selected. */
  item: Item | null;
  /** Where that item lives, so a candidate document does not end up wearing it twice. */
  source: ItemSource | null;
  /** Every place that item could go, in the paperdoll's order. Empty when nothing is selected. */
  positions: readonly ComparePosition[];
  show: (next: {
    item: Item;
    source: ItemSource;
    positions: readonly ComparePosition[];
  }) => void;
  clear: () => void;
};

export const useItemCompare = create<ItemCompareState>((set) => ({
  item: null,
  source: null,
  positions: [],
  show: ({ item, source, positions }) => set({ item, source, positions }),
  clear: () => set({ item: null, source: null, positions: [] }),
}));

/**
 * The document one swap would produce.
 *
 * The whole reason the card can answer "what would this be worth" rather than "what does this
 * contain". A stat an item grants is not what it is worth: 100 flat dodge on a character with
 * +100% increased dodge is 200 dodge, and 200 dodge is a different share of a hit at every
 * armour rating. The only honest way to price a piece is to compute the character that has it —
 * which is the rule `state/compare.ts` is built on, applied here to gear.
 *
 * Three things come out of `gear`, and the third is the one that is easy to miss:
 *
 *  - whatever the position holds (`removeIndex`), because that is what gives way;
 *  - the candidate itself when it is **already worn somewhere** (`source`), because otherwise a
 *    ring moved from one finger to the other would be counted on both;
 *  - nothing else — `itemPool` is left alone, since a benched item reaches no stat (`collectGear`
 *    is called on `doc.gear` and only on `doc.gear`).
 *
 * Indices are resolved against the original list and removed together, so the caller never has to
 * think about one removal shifting the other.
 */
export function docWithSwap(
  doc: BuildDoc,
  options: {
    /** The piece going on. Omitted, the slot is simply emptied — which prices taking it off. */
    item?: Item | undefined;
    /** Where that piece lives now, so it is not worn twice. */
    source?: ItemSource | undefined;
    /** Which entry of `doc.gear` comes off. */
    removeIndex?: number | undefined;
  },
): BuildDoc {
  const drop = new Set<number>();
  if (options.removeIndex !== undefined) drop.add(options.removeIndex);
  if (options.source?.where === "gear") drop.add(options.source.index);

  const gear = (doc.gear ?? []).filter((_, i) => !drop.has(i));
  if (options.item !== undefined) gear.push(options.item);
  return { ...doc, gear };
}
