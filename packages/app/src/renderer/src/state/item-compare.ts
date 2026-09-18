/**
 * The item being looked at, and the one it would replace.
 *
 * A store rather than a prop, because the two ends are in different trees: the gear panel knows
 * which item you picked, and the sidebar — which is `app.tsx`'s, not the panel's, and survives
 * every tab switch — is where there is room to price it. Threading a callback from one to the
 * other would make every panel that is not the gear panel carry a prop it has no use for.
 *
 * `against` is deliberately allowed to be `undefined` while `item` is set. That is the empty
 * slot case and it is the commonest one in a fresh build: nothing is coming off, so every line
 * of the candidate is a gain. The diff reads the same either way, which is why it is one
 * component and not two.
 *
 * Nothing here is part of the build document. Selecting an item to look at is not an edit, must
 * not land in the undo stack, and must not mark the build dirty — which is the other reason
 * this is its own store rather than a field on `useBuild`.
 */

import type { Item } from "@cte2/schema";
import { create } from "zustand";

type ItemCompareState = {
  /** The item the editor is open on, or `null` when nothing is selected. */
  item: Item | null;
  /** What is worn in that item's slot today, when it is not this item itself. */
  against: Item | null;
  /** How the candidate relates to the character: already worn, or still on the bench. */
  where: "gear" | "pool" | null;
  /** The slot's label, for the heading — "Ring 2" rather than "ring". */
  slotLabel: string | null;
  show: (next: {
    item: Item;
    against: Item | undefined;
    where: "gear" | "pool";
    slotLabel: string | undefined;
  }) => void;
  clear: () => void;
};

export const useItemCompare = create<ItemCompareState>((set) => ({
  item: null,
  against: null,
  where: null,
  slotLabel: null,
  show: ({ item, against, where, slotLabel }) =>
    set({
      item,
      against: against ?? null,
      where,
      slotLabel: slotLabel ?? null,
    }),
  clear: () => set({ item: null, against: null, where: null, slotLabel: null }),
}));
