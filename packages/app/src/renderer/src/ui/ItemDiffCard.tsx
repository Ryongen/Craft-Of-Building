/**
 * What picking this item up would change — to the character, not to the item list.
 *
 * Choosing gear is a comparison and the panel used to make you hold both halves of it in your
 * head: the editor showed what the candidate grants, the paperdoll showed what you are wearing,
 * and working out whether the swap was an upgrade meant reading two lists of thirty lines and
 * subtracting them yourself.
 *
 * ## Why the subtraction was not enough
 *
 * The first version of this card did that subtraction for you — the candidate's resolved stats
 * minus the worn piece's, per stat and per modifier kind. That is a true statement about two
 * items and it is not the question: **what an item grants is not what it is worth.**
 *
 * A chest granting 100 flat dodge is worth 200 dodge on a character carrying +100% increased
 * dodge from the tree, and those 200 points are a different share of a hit at every rating on the
 * curve — 2% here, a tenth of one there. Armour is the same, the resists cap, added flat damage
 * runs through increases and mores and crit before it is a DPS figure, and nothing about any of
 * that is visible in the item's own lines.
 *
 * So the card builds the **document each choice would produce** and runs the whole engine over
 * it, which is what the tree hover and the support gem ranking already do. Every row is therefore
 * a change to the character sheet with every increase already applied, and the five rating stats
 * lead with what they bought: `+2.00% (+200)` is two points of dodge chance, from two hundred
 * points of rating. `DeltaTable` words all of that, so this card, the tree tooltip and the
 * Compare tab cannot disagree about a number or about which way it is good.
 *
 * ## The readings it has to get right
 *
 *  - **An empty position.** Nothing comes off, so the candidate document is the build plus one
 *    piece.
 *  - **A swap.** The worn piece comes out of `doc.gear` and the candidate goes in, so what is
 *    priced is the character afterwards rather than a difference of two stat lists.
 *  - **A position the item is already in.** There is nothing to price it against, so the document
 *    is the build *without* it and the card prices taking it off. That is the only place this app
 *    asks what a slot is worth to the build, and it is not a copy of the window beside it: the
 *    window lists what the piece grants, this says what losing it would cost.
 *
 * ## More than one reading of one item
 *
 * A ring fits either finger, so a candidate ring has two answers and both are true — one card per
 * position, stacked, in the paperdoll's order. Which positions exist is the panel's decision
 * (`showCompare` in `GearPanel`); this only prices them, and `useWhatIfEach` prices the whole set
 * against one baseline in one debounced pass rather than one timer per card.
 *
 * It lives in the Items panel, beside the item window, rather than in the sidebar: the item's own
 * card and the price of the swap are two halves of one decision, and the sidebar is a long way
 * from the row that was clicked.
 */

import { useMemo, type ReactNode } from "react";
import { itemName, type Item } from "@cte2/schema";

import { useBuild } from "../state/build-store.js";
import { useWhatIfEach, type WhatIf } from "../state/compare.js";
import { docWithSwap, useItemCompare, type ComparePosition } from "../state/item-compare.js";
import { useWorld } from "../state/snapshot.js";
import { ComparisonBlock } from "./DeltaTable.js";
import { RarityBadge } from "./RarityBadge.js";

/**
 * Sheet rows past this are folded into a count.
 *
 * This sits beside a thirty-line stat list, and a price list longer than the thing it is pricing
 * stops being a comparison. The list is ranked by how much each stat moved relative to itself, so
 * what is cut is what moved least.
 */
const MAX_STAT_ROWS = 12;

/**
 * Every reading of the selected item, one card each.
 *
 * The candidate documents are built here rather than inside each card, because they are priced
 * together: one baseline, one timer, one engine pass per position. A card is then a renderer for
 * an answer that has already been computed.
 */
export function ItemDiffCard(): ReactNode {
  const item = useItemCompare((s) => s.item);
  const source = useItemCompare((s) => s.source);
  const positions = useItemCompare((s) => s.positions);
  const doc = useBuild((s) => s.doc);

  const candidates = useMemo(() => {
    if (item === null || source === null) return undefined;
    return positions.map((position, i) => ({
      key: String(i),
      doc: position.candidate !== undefined
        ? position.candidate
        : position.worn
        ? // Taking it off: the build without it, and nothing going on. `source` is the removal —
          // a worn position is by definition the entry of `doc.gear` the item already occupies.
          docWithSwap(doc, { source })
        : docWithSwap(doc, { item, source, removeIndex: position.againstIndex }),
    }));
  }, [item, source, positions, doc]);

  const priced = useWhatIfEach(candidates);

  if (item === null || source === null) return null;

  return (
    <>
      {positions.map((position, i) => (
        <CompareCard key={i} item={item} position={position} priced={priced?.get(String(i))} />
      ))}
    </>
  );
}

/**
 * One reading: this item, priced against one place it could sit.
 *
 * `priced` is `undefined` while the debounce is running or when the engine refused the candidate,
 * and the card says so rather than drawing an empty table — a blank list and "nothing changes"
 * are different statements and only one of them is ever true.
 */
function CompareCard({
  item,
  position,
  priced,
}: {
  item: Item;
  position: ComparePosition;
  priced: WhatIf | undefined;
}): ReactNode {
  const { snapshot } = useWorld();
  const { label, against, worn } = position;

  return (
    <div className="item-diff">
      <div className="section-title mt-0">
        {worn ? "Taking this off" : against === undefined ? "Would add" : "Would replace"}
      </div>

      <div className="row wrap gap-2 mb-2">
        <strong className="ellipsis">{itemName(snapshot, item)}</strong>
        <RarityBadge rarity={item.rarity} />
        <span className="badge">ilvl {item.itemLevel}</span>
        <span className="badge good">{label}</span>
      </div>

      {worn ? (
        <div className="faint text-sm mb-2">
          What the build moves by if you unequip it. A line reading <em>better</em> is a stat this
          piece is holding back.
        </div>
      ) : against !== undefined ? (
        <div className="faint text-sm mb-2">
          in place of <strong>{itemName(snapshot, against)}</strong>
        </div>
      ) : (
        <div className="faint text-sm mb-2">Nothing is in it, so nothing comes off.</div>
      )}

      {priced === undefined ? (
        <div className="faint text-sm">Pricing…</div>
      ) : (
        <>
          <ComparisonBlock
            comparison={priced.comparison}
            statLimit={MAX_STAT_ROWS}
            emptyNote={
              worn
                ? "Nothing changes — this piece is contributing nothing, so taking it off costs nothing."
                : "Nothing changes — the character sheet lands in exactly the same place."
            }
          />
          {/*
            Said once per card rather than per row, because it is true of every row: these are
            sheet totals with the tree's increases already in them, not the item's own lines. The
            item's own lines are the card immediately to the left.
          */}
          <div className="faint text-xs mt-2">
            Character totals, after every increase — the rating in brackets is the flat change
            behind it.
          </div>
        </>
      )}
    </div>
  );
}
