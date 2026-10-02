import type { Snapshot } from "@cte2/extractor";
import { balance, parseRolledMod, parseSourceMod, rollToExact, sourceToExact, statIndex } from "@cte2/engine";

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
