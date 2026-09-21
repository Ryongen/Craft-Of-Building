/**
 * "Where does this come from", as a card under the pointer.
 *
 * The drill-downs — the Damage tab's layer trace and the sidebar's stat breakdown — bottom out in
 * rows that name a source and a number: `Attack Damage +3.00%`, three of them under `Talents (4)`.
 * Naming it was as far as they went, and for a tree node that is not far enough: this pack repeats
 * a perk id at many positions in the grid, so those three rows are three *different* nodes and
 * nothing on screen said which. `mod-source.ts` resolves the document path behind each row; this
 * draws what it found.
 *
 * ## Four cards, three of them already written
 *
 * Gear and jewels get `ItemWindow` and `JewelWindow`, the same cards the paperdoll has always
 * shown. Support gems, Augments and skills get `GemWindow` / `SpellWindow`. Only the tree needed
 * something new — {@link PerkPeek} — and even that is the Tree tab's own renderer pointed at a
 * small canvas, because `draw` already takes a viewport and a transform and `centreOn` already
 * computes the second from a cell.
 *
 * ## What it costs
 *
 * Nothing until hovered: `useHoverCard` only calls the render function while the pointer is on the
 * row. `treeGraph` and `treeGrid` are both `WeakMap`-cached per snapshot, so the mini map is one
 * canvas paint of a dozen visible cells and no parsing at all.
 */

import type { Snapshot } from "@cte2/extractor";
import {
  TREE_KEYS,
  gearRarity,
  nodeKey,
  perkName,
  treeGraph,
  type NodeKey,
  type TreeCoord,
  type TreeKey,
} from "@cte2/schema";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";

import { useBuild } from "../state/build-store.js";
import { useDerived } from "../state/derived.js";
import { useWorld } from "../state/snapshot.js";
import { floatingStyle, useHoverCard, type At } from "./HoverCard.js";
import { ItemWindow, JewelWindow } from "./ItemTooltip.js";
import { GemWindow, SpellWindow } from "./SpellTooltip.js";
import { auraCard, effectCard, spellCard, supportGemCard } from "./spell-stats.js";
import { provenanceOf, type Provenance } from "./mod-source.js";
import type { ModContribution } from "../state/derived.js";
import { IconCache } from "../panels/tree/icons.js";
import { CELL, centreOn, draw } from "../panels/tree/render.js";

/** The mini map's viewport, in pixels. */
const PEEK = { width: 264, height: 184 };

/**
 * Close, but not so close that the node has nothing around it.
 *
 * The question a provenance card answers is "which node is this", so a thumbnail of the whole
 * tree — 138 x 173 cells — is useless: it is a smear. But the first attempt went too far the
 * other way at 1.4x, which framed four cells and therefore exactly one perk, since the cells
 * between perks are connector art. The node was unmistakable and completely unplaceable.
 *
 * At 0.75 the frame holds about eight cells, which is two or three perks and the wires between
 * them — enough of a shape to recognise when you go looking for it on the Tree tab.
 */
const PEEK_SCALE = 0.75;

/** The crosshair, one cell wide, derived so it cannot drift out of step with the zoom. */
const RING = CELL * PEEK_SCALE;

const CARD = { width: 300, height: 260 };

/**
 * Hover handlers for one modifier row, and the card they raise.
 *
 * Returns inert handlers and a null card where the row has nothing to point at — the six context
 * kinds that are properties of the character itself. The caller can read `has` to decide whether
 * to make the row look interactive at all.
 */
export function useProvenance(mod: ModContribution): {
  props: Record<string, unknown>;
  has: boolean;
  node: ReactNode;
} {
  const doc = useBuild((s) => s.doc);
  const found = useMemo(() => provenanceOf(doc, mod), [doc, mod]);
  const card = useHoverCard(
    found === undefined ? undefined : (at: At) => <ProvenanceCard found={found} at={at} />,
  );
  return { props: card.props, has: found !== undefined, node: card.node };
}

/**
 * The same card, for a row that names an exile effect directly rather than through a modifier.
 *
 * The mob's mitigation rows are the case that needs it: `TargetOrigin` prints "Banner of the
 * Piercing Gale −16.80" off `target.origins`, which is not a `ModContribution` and has no
 * context type to resolve — it is the debuff's id and the number it took off the mob. That row
 * is where a reader asks what else the banner does, and it was the one row on the trace with
 * the answer three panels away.
 */
export function useEffectProvenance(effectId: string | undefined): {
  props: Record<string, unknown>;
  node: ReactNode;
} {
  const card = useHoverCard(
    effectId === undefined ? undefined : (at: At) => <EffectCard id={effectId} at={at} />,
  );
  return { props: card.props, node: card.node };
}

function ProvenanceCard({ found, at }: { found: Provenance; at: At }): ReactNode {
  const { snapshot } = useWorld();
  const doc = useBuild((s) => s.doc);
  const level = doc.character.level;

  switch (found.kind) {
    case "item": {
      const item = doc.gear?.[found.index];
      return item === undefined ? null : <ItemWindow item={item} floating at={at} />;
    }
    case "jewel": {
      const jewel = doc.jewels?.[found.index];
      return jewel === undefined ? null : <JewelWindow jewel={jewel} floating at={at} />;
    }
    case "perk":
      return <PerkPeek tree={found.tree} coord={found.coord} perkId={found.perkId} at={at} />;
    case "gem": {
      const card = supportGemCard(snapshot, found.id, {
        rollPercent: bandedRoll(snapshot, found.rollPercent, found.rarity),
        characterLevel: level,
      });
      return card === undefined ? null : <GemWindow card={card} floating at={at} />;
    }
    case "aura": {
      const card = auraCard(snapshot, found.id, {
        rollPercent: bandedRoll(snapshot, found.rollPercent, found.rarity),
        characterLevel: level,
      });
      return card === undefined ? null : <GemWindow card={card} floating at={at} />;
    }
    case "effect":
      return <EffectCard id={found.id} at={at} />;
    case "spell": {
      const skill = doc.skills?.[found.skillIndex];
      const card = spellCard(snapshot, found.id, {
        // The card's own ranks, rather than the Skills tab's resolved ones: this is a hover on a
        // stat row and threading the whole rank derivation through it would mean recomputing the
        // sheet to draw a tooltip. A pinned level is exact; without one the declared level is the
        // honest thing to show and the Skills tab is one click away for the resolved rank.
        level: skill?.level ?? 1,
        natural: 20,
        ceiling: 20,
        characterLevel: level,
      });
      return card === undefined ? null : <SpellWindow card={card} floating at={at} />;
    }
  }
}

/**
 * The roll a gem's card is priced at, floored into its rarity's band.
 *
 * `gemRoll` in the engine does exactly this before it interpolates the stats the sheet was built
 * from, and the card has to agree with it or the hover contradicts the row it came off. A gem
 * with no recorded percent is not a 0% gem: `SkillGemBlueprint` draws the percent from the
 * rarity's `stat_percents` and never leaves it, so a mythic is at least 86 and a card showing
 * its bands at their minimum describes an item the game cannot make.
 */
function bandedRoll(
  snapshot: Snapshot,
  rollPercent: number | undefined,
  rarity: string | undefined,
): number {
  if (rollPercent !== undefined) return rollPercent;
  if (rarity === undefined) return 0;
  return gearRarity(snapshot, rarity)?.statPercents.min ?? 0;
}

/**
 * One exile effect, at the roll and the stack count this build has it up at.
 *
 * A component rather than a call in the switch because those two numbers are not in the
 * document — they are `EffectState`, which the engine resolves once per recompute and every
 * other view of a buff already reads. Deriving them here instead would be a second answer to
 * "how strong is this buff", and the first one is on the Effects card two panels away.
 *
 * An effect the state has never heard of still gets a card, at 100%: that is a row from a sheet
 * that was computed with it, so it is up — the state simply does not offer it as a toggle.
 */
function EffectCard({ id, at }: { id: string; at: At }): ReactNode {
  const { snapshot } = useWorld();
  const doc = useBuild((s) => s.doc);
  const derived = useDerived();

  const option = derived.effects.options.find((o) => o.id === id);
  const card = effectCard(snapshot, id, {
    rollPercent: option?.rollPercent ?? 100,
    stacks: option?.stacks ?? 1,
    characterLevel: doc.character.level,
  });
  return card === undefined ? null : <GemWindow card={card} floating at={at} />;
}

/**
 * One tree node, with enough of its neighbourhood around it to be found again.
 *
 * The canvas is the Tree tab's `draw` at a fixed transform — no panning, no hover, nothing
 * allocatable — so a node here is drawn with the same art, the same allocated gold and the same
 * connectors it has on the tab itself. Anything else would be a second picture of the tree that
 * could drift from the first.
 *
 * The crosshair is this card's own: `draw` marks the node it is told is hovered, and "hovered" is
 * not what this is saying. The ring says *this one*, at a cell the pointer is nowhere near.
 */
function PerkPeek({
  tree,
  coord,
  perkId,
  at,
}: {
  tree: TreeKey;
  coord: TreeCoord;
  perkId: string;
  at: At;
}): ReactNode {
  const world = useWorld();
  const doc = useBuild((s) => s.doc);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  // Bumped when an icon finishes decoding, to repaint with it. The cache is per card, which is
  // fine: it is a handful of textures and the browser has them cached after the first hover.
  const [loaded, setLoaded] = useState(0);
  const icons = useMemo(
    () => new IconCache((path) => world.icon(path), () => setLoaded((n) => n + 1)),
    [world],
  );

  const graph = useMemo(() => treeGraph(world.snapshot, TREE_KEYS[tree]), [world.snapshot, tree]);

  /** Every cell this build has taken in this tree, so the map shades them as the tab does. */
  const allocated = useMemo(() => {
    const keys = new Set<NodeKey>();
    for (const [row, col] of doc.tree?.[tree] ?? []) keys.add(nodeKey(row, col));
    return keys;
  }, [doc.tree, tree]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (canvas === null || graph === undefined) return;
    const ctx = canvas.getContext("2d");
    if (ctx === null) return;

    /*
      The device pixel ratio goes into the *transform*, not onto the context.

      `draw` resets the context matrix itself before it paints the background, so a ratio set
      here would be thrown away on the first line of it and the map would render at a quarter
      resolution on a HiDPI screen. Scaling the viewport and the zoom together is equivalent and
      survives the reset: the same cells stay in frame, drawn at twice the pixels.
    */
    const ratio = window.devicePixelRatio || 1;
    const width = PEEK.width * ratio;
    const height = PEEK.height * ratio;
    canvas.width = width;
    canvas.height = height;

    draw(ctx, width, height, centreOn(coord[0], coord[1], width, height, PEEK_SCALE * ratio), {
      graph,
      texture: (path) => icons.get(path),
      allocated,
      // Everything this build has taken is drawn as taken; nothing here is allocatable, so the
      // three-way status the tab uses to dim unreachable branches has nothing to say.
      status: () => "connected",
      pending: new Set(),
      doomed: new Set(),
      highlighted: new Set(),
      hover: null,
      pickStart: false,
    });
  }, [graph, coord, allocated, icons, loaded]);

  return (
    <div className="item-window tt-perk floating" style={floatingStyle(at, CARD)}>
      <div className="tt-header">
        <div className="tt-title-container">
          <div className="tt-title" title={perkId}>
            {perkName(world.snapshot, perkId)}
          </div>
          <div className="tt-subtitle">
            {TREE_LABEL[tree]} · row {coord[0]}, column {coord[1]}
          </div>
        </div>
      </div>

      <div className="tt-divider" />

      <div className="perk-peek" style={{ width: PEEK.width, height: PEEK.height }}>
        <canvas ref={canvasRef} style={{ width: PEEK.width, height: PEEK.height }} />
        <span
          className="perk-peek-ring"
          style={{ width: RING, height: RING, margin: `${-RING / 2}px 0 0 ${-RING / 2}px` }}
        />
      </div>
    </div>
  );
}

const TREE_LABEL: Record<TreeKey, string> = {
  talents: "Talents",
  ascendancy: "Ascendancy",
  atlas: "Atlas",
};
