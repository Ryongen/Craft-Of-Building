/**
 * What an item is, without opening it.
 *
 * The gear panel lists items by name, rarity and item level, which is enough to tell two rings
 * apart and not enough to choose between them. Finding the ring with the cold resistance on it
 * meant clicking each one in turn and reading the editor — nine clicks to answer a question the
 * game answers by hovering.
 *
 * So hovering a row prints the piece's resolved stat lines, through {@link itemLines} — the same
 * summation the editor's "what this item contributes" box uses, which is the engine's own
 * `collectGear`. A tooltip that disagreed with the panel under it would be worse than none.
 *
 * ## Positioning
 *
 * `position: fixed` against the viewport and rendered into `document.body`, not into the row.
 * The item pool scrolls inside itself and the whole column scrolls inside the tab, so a tooltip
 * parented to a row is clipped by both — which is exactly the case it is needed in, the tenth
 * item down a scrolled list. It flips to the other side of the cursor near the right and bottom
 * edges, the way the tree's own tooltip does.
 *
 * It never takes the pointer (`pointer-events: none`), so it cannot swallow the click that is
 * on its way to the row underneath it.
 */

import type { Item } from "@cte2/schema";
import { gearTypeName, isTwoHanded, uniqueName } from "@cte2/schema";
import { useCallback, useMemo, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";

import { useBuild } from "../state/build-store.js";
import { useWorld } from "../state/snapshot.js";
import { RarityBadge } from "./RarityBadge.js";
import { itemLines } from "./item-stats.js";

/** Roughly what the card measures, for deciding which side of the cursor it goes on. */
const CARD = { width: 320, height: 300 };

type At = { x: number; y: number };

/**
 * Hover handlers for a row, and the card they raise.
 *
 * Returned as props to spread rather than as a wrapper component: the rows this goes on already
 * carry their own click, their own class list and their own children, and wrapping each one in
 * another `div` would change the flex layout they are laid out by.
 */
export function useItemTooltip(item: Item | undefined): {
  props: {
    onMouseEnter: (event: React.MouseEvent) => void;
    onMouseMove: (event: React.MouseEvent) => void;
    onMouseLeave: () => void;
  };
  node: ReactNode;
} {
  const [at, setAt] = useState<At | null>(null);

  const track = useCallback((event: React.MouseEvent) => {
    setAt({ x: event.clientX, y: event.clientY });
  }, []);
  const clear = useCallback(() => setAt(null), []);

  return {
    props: { onMouseEnter: track, onMouseMove: track, onMouseLeave: clear },
    node: at === null || item === undefined ? null : <ItemTooltipCard item={item} at={at} />,
  };
}

function ItemTooltipCard({ item, at }: { item: Item; at: At }): ReactNode {
  const world = useWorld();
  const { snapshot } = world;
  const level = useBuild((s) => s.doc.character.level);

  const lines = useMemo(() => itemLines(snapshot, item, level), [snapshot, item, level]);

  const name =
    item.unique === undefined ? gearTypeName(snapshot, item.base) : uniqueName(snapshot, item.unique);
  // The one rule that makes a tooltip's numbers a lie if it goes unsaid: the engine gives an
  // over-levelled item nothing, so every line above would be zero on this character.
  const aboveLevel = item.itemLevel > level;

  const flipX = at.x > window.innerWidth - CARD.width - 24;
  const flipY = at.y > window.innerHeight - CARD.height;

  return createPortal(
    <div
      className="item-tooltip"
      style={{
        left: flipX ? undefined : at.x + 16,
        right: flipX ? window.innerWidth - at.x + 16 : undefined,
        top: flipY ? undefined : at.y + 16,
        bottom: flipY ? window.innerHeight - at.y + 16 : undefined,
      }}
    >
      <div className="tt-name">{name}</div>
      <div className="row wrap gap-2 mb-2">
        <RarityBadge rarity={item.rarity} />
        <span className="badge">ilvl {item.itemLevel}</span>
        {(item.quality ?? 0) > 0 && <span className="badge">{item.quality}% quality</span>}
        {isTwoHanded(snapshot, item.base) && <span className="badge warn">2H</span>}
        {item.unique !== undefined && (
          <span className="faint text-xs">{gearTypeName(snapshot, item.base)}</span>
        )}
      </div>

      {aboveLevel && (
        <div className="badge bad mb-2">
          above your level — grants nothing until level {item.itemLevel}
        </div>
      )}

      {lines.length === 0 ? (
        <div className="faint text-sm">Grants nothing.</div>
      ) : (
        lines.map((line, index) => (
          <div key={index} className="tt-line">
            {line}
          </div>
        ))
      )}
    </div>,
    document.body,
  );
}
