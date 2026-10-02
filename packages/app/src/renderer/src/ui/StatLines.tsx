/**
 * One affix's stat lines, with each value editable in place.
 *
 * Shared by gear affixes and jewel affixes, which are the same thing wearing different hats: an
 * `AffixRoll` against a tier's roll band, resolved at an item level. Two copies of this would be
 * two ideas about what a typed value means, and the typed value is the whole point — the game's
 * tooltip prints a *number*, never the roll percent behind it, so typing the number you can see
 * is how a real item gets into the planner.
 */

import { parseRolledMod } from "@cte2/engine";
import { modifierLine, statName } from "@cte2/schema";
import type { ReactNode } from "react";

import { resolveValue, useWorld } from "@cte2/view";
import { ValueField, smart } from "./fields.js";

export { resolveValue };

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
