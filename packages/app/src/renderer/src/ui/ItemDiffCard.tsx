/**
 * What picking this item up would change.
 *
 * Choosing gear is a comparison and the panel used to make you hold both halves of it in your
 * head: the editor showed what the candidate grants, the paperdoll showed what you are wearing,
 * and working out whether the swap was an upgrade meant reading two lists of thirty lines and
 * subtracting them yourself.
 *
 * So selecting an item prices it against what is already in its slot. Green is better and red is
 * worse — and better is `minus_is_good` applied rather than the sign of the change, because 38
 * stats in this pack improve as they fall. That rule lives in `diffItems`, beside the stat
 * totals it reads, so this and the delta tables elsewhere in the app cannot disagree about which
 * way a cooldown points.
 *
 * ## The three cases it has to read correctly
 *
 *  - **An empty slot.** Nothing comes off, so every line is a gain. The card says the slot is
 *    empty rather than pretending there was a zero-stat item there.
 *  - **A swap.** Both items' contributions are resolved and subtracted per stat and per modifier
 *    kind, so "+40 Armor" and "+40% Armor" never cancel each other out.
 *  - **The item already worn.** There is nothing to price — selecting your own boots is not a
 *    swap — so it shows what they contribute instead of a diff of the item against itself.
 */

import type { ReactNode } from "react";
import { gearTypeName, uniqueName, type Item } from "@cte2/schema";

import { useBuild } from "../state/build-store.js";
import { useItemCompare } from "../state/item-compare.js";
import { useWorld } from "../state/snapshot.js";
import { RarityBadge } from "./RarityBadge.js";
import { deltaText, diffItems, itemLines } from "./item-stats.js";

/** Rows past this are folded into a count. A sidebar is not the place for eighty of them. */
const MAX_ROWS = 24;

export function ItemDiffCard(): ReactNode {
  const world = useWorld();
  const { snapshot } = world;
  const level = useBuild((s) => s.doc.character.level);
  const item = useItemCompare((s) => s.item);
  const against = useItemCompare((s) => s.against);
  const where = useItemCompare((s) => s.where);
  const slotLabel = useItemCompare((s) => s.slotLabel);

  if (item === null) return null;

  const name = itemName(world.snapshot, item);
  // A worn item is not a candidate for its own slot, so the honest reading is its contribution
  // rather than a diff of nothing.
  const worn = where === "gear";
  const deltas = worn ? [] : diffItems(snapshot, against ?? undefined, item, level);
  const lines = worn ? itemLines(snapshot, item, level) : [];
  const shown = deltas.slice(0, MAX_ROWS);
  const hidden = deltas.length - shown.length;

  const gains = deltas.filter((d) => d.good).length;
  const losses = deltas.length - gains;

  return (
    <div className="item-diff">
      <div className="section-title mt-0">
        {worn ? "Equipped" : against === null ? "Would add" : "Would replace"}
      </div>

      <div className="row wrap gap-2 mb-2">
        <strong className="ellipsis">{name}</strong>
        <RarityBadge rarity={item.rarity} />
        <span className="badge">ilvl {item.itemLevel}</span>
        {slotLabel !== null && <span className="badge good">{slotLabel}</span>}
      </div>

      {!worn && against !== null && (
        <div className="faint text-sm mb-2">
          in place of <strong>{itemName(world.snapshot, against)}</strong>
        </div>
      )}
      {!worn && against === null && (
        <div className="faint text-sm mb-2">
          Its slot is empty, so everything below is a gain.
        </div>
      )}

      {worn ? (
        lines.length === 0 ? (
          <div className="faint text-sm">Grants nothing.</div>
        ) : (
          lines.map((line, index) => (
            <div key={index} className="tt-line">
              {line}
            </div>
          ))
        )
      ) : deltas.length === 0 ? (
        <div className="faint text-sm">
          Nothing changes — the two grant the same stats at the same values.
        </div>
      ) : (
        <>
          <div className="row gap-3 mb-2 text-sm">
            <span className="delta-change up">{gains} better</span>
            <span className="delta-change down">{losses} worse</span>
          </div>
          <div className="item-diff-table">
            {shown.map((delta) => (
              <div key={delta.key} className="item-diff-row">
                <span className="delta-label ellipsis" title={delta.statId}>
                  {delta.label}
                </span>
                <span
                  className={`delta-change ${delta.good ? "up" : "down"}`}
                  title={`${delta.from} → ${delta.to}`}
                >
                  {deltaText(delta)}
                </span>
              </div>
            ))}
          </div>
          {hidden > 0 && <div className="faint text-sm mt-1">and {hidden} more</div>}
        </>
      )}
    </div>
  );
}

/** A unique is known by its own name; everything else by its base. */
function itemName(snapshot: Parameters<typeof gearTypeName>[0], item: Item): string {
  return item.unique === undefined
    ? gearTypeName(snapshot, item.base)
    : uniqueName(snapshot, item.unique);
}
