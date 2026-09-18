/**
 * One affix's stat lines, with each value editable in place.
 *
 * Shared by gear affixes and jewel affixes, which are the same thing wearing different hats: an
 * `AffixRoll` against a tier's roll band, resolved at an item level. Two copies of this would be
 * two ideas about what a typed value means, and the typed value is the whole point — the game's
 * tooltip prints a *number*, never the roll percent behind it, so typing the number you can see
 * is how a real item gets into the planner.
 */

import type { Snapshot } from "@cte2/extractor";
import {
  balance,
  parseRolledMod,
  parseSourceMod,
  rollToExact,
  sourceToExact,
  statIndex,
} from "@cte2/engine";
import { modifierLine, statName } from "@cte2/schema";
import type { ReactNode } from "react";

import { useWorld } from "../state/snapshot.js";
import { ValueField, smart } from "./fields.js";

/**
 * The value one modifier resolves to at a roll percent, through the engine rather than beside
 * it.
 *
 * `rollToExact` is what `collectGear` calls, so a number rendered with this cannot disagree
 * with the character sheet. It needs the stat's shape (for its scaling class) and the balance
 * curves, both of which memoise on the snapshot, so building them per call is cheap.
 *
 * **Two modifier shapes reach here**, and reading only the first is how a socketed gem came to
 * render "Heal Strength 0" beside an item whose own preview said +9:
 *
 *   - `{ min, max }` — an affix, a base stat, a rune, a runeword. It interpolates at the roll.
 *   - `{ v1, scale_to_lvl }` — a **gem**, and every other fixed modifier. `Gem.getFor(fam)`
 *     returns `OptScaleExactStat`s and `toExactStat(lvl)` takes no percent at all, which is
 *     exactly why the gem row says "fixed — a gem does not roll".
 *
 * `sourceToExact` is what `socketStats` calls for the second, so the two cannot disagree either.
 */
export function resolveValue(
  snapshot: Snapshot,
  mod: Record<string, unknown>,
  rollPercent: number,
  itemLevel: number,
): number | undefined {
  const index = statIndex(snapshot);
  const rolled = parseRolledMod(mod);
  if (rolled !== undefined) {
    return rollToExact(rolled, rollPercent, itemLevel, index.shapeOf(rolled.statId), balance(snapshot)).value;
  }
  const fixed = parseSourceMod(mod);
  if (fixed === undefined) return undefined;
  return sourceToExact(fixed, itemLevel, index.shapeOf(fixed.statId), balance(snapshot)).value;
}

/**
 * One editable stat line: the name, the level-scaled value, and the modifier's own wording.
 *
 * Typing in the box solves back to a roll percent — see `ValueField`. A fixed-value modifier
 * (`v1` rather than `min`/`max`) has no roll to solve for, so it renders as text.
 */
export function StatLines({
  mods,
  rollPercent,
  band,
  itemLevel,
  onRoll,
}: {
  mods: readonly Record<string, unknown>[];
  rollPercent: number;
  band: { min: number; max: number };
  itemLevel: number;
  onRoll: ((rollPercent: number) => void) | undefined;
}): ReactNode {
  const { snapshot } = useWorld();

  return (
    <>
      {mods.map((mod, index) => {
        const rolled = parseRolledMod(mod);
        const valueAt = (percent: number): number =>
          resolveValue(snapshot, mod, percent, itemLevel) ?? 0;
        const statId = typeof mod["stat"] === "string" ? mod["stat"] : undefined;

        /*
         * `MORE` and `PERCENT` are marked, `FLAT` is not.
         *
         * The stat name alone is ambiguous exactly where it matters most: the Critical Strikes
         * Augment grants `+1 Crit Chance` and `+36% Increased Crit Chance`, which rendered as
         * two rows both reading "Crit Chance" with two unrelated numbers beside them. The full
         * wording is on the hover, where there is room for it; this is the one glyph that tells
         * the rows apart at a glance.
         */
        const type = String(mod["type"] ?? "FLAT").toUpperCase();
        const marker = type === "PERCENT" ? " %" : type === "MORE" ? " ×" : "";

        return (
          <div key={index} className="stat-line">
            <span className="label" title={modifierLine(snapshot, mod, rollPercent)}>
              {statId === undefined ? (
                modifierLine(snapshot, mod, rollPercent)
              ) : (
                <>
                  {statName(snapshot, statId)}
                  {marker !== "" && <span className="faint">{marker}</span>}
                </>
              )}
            </span>
            {rolled === undefined || onRoll === undefined ? (
              <span className="num">{smart(valueAt(rollPercent))}</span>
            ) : (
              <ValueField
                rollPercent={rollPercent}
                min={band.min}
                max={band.max}
                valueAt={valueAt}
                onChange={onRoll}
              />
            )}
          </div>
        );
      })}
    </>
  );
}
