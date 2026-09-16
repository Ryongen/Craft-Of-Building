/**
 * The free resistances every character starts with, and loses on the way to 100.
 *
 * A new character is handed +50 to each of fire, cold, lightning and chaos, and the grant
 * steps down by 25 at levels 25, 50 and 75:
 *
 *     int value = 50;
 *     if (data.getLevel() > 24) { value = 25; }
 *     if (data.getLevel() > 49) { value = 0; }
 *     if (data.getLevel() > 74) { value = -25; }
 *     for (Elements ele : Elements.getAllSingle()) {
 *         if (ele != Elements.Physical) {
 *             stats.add(ExactStatData.noScaling(value, ModType.FLAT, new ElementalResist(ele).GUID()));
 *         }
 *     }
 *
 * — PlayerStatUtils.addNewbieElementalResists, called from CachedPlayerStats.java:107.
 *
 * Three things worth writing down, because each is easy to get backwards:
 *
 *  - **It is a bonus that decays, not a penalty that accrues.** The pack's own base stats
 *    already carry `elemental_resist -25` and `chaos_resist -25` (`original_mode_player`), so
 *    the character sheet reads +25 at level 1 and -50 at level 100 with nothing equipped.
 *    Modelling this as "-25 per 25 levels" reproduces the level 100 number and misses level 1
 *    by 50.
 *  - **The steps are `> 24`, not `>= 25`** — and they are sequential `if`s, not `else if`s, so
 *    the last one that matches wins. Level 75 and level 100 get the same -25; there is no
 *    further step.
 *  - **Physical is excluded**, and `getAllSingle()` does not include the aggregates, so this
 *    grants the four single resists directly rather than going through `elemental_resist`.
 *    The net is the same after `code-only-behaviour`'s multi-element expansion, but the
 *    provenance is not: the game shows these as their own context.
 *
 * The one thing that is assumed rather than read: `CompatConfig.get().newbieResists()` gates
 * the whole function, and it is a Forge config rather than a datapack, so no snapshot can see
 * it. The jar default is `false` and two of the three presets set it `true`. Both captured
 * fixtures only reconcile with it **on** — level 1 observes 25 (`50 - 25`) and level 100
 * observes `-25 - 25 + gear` — so it is treated as on here. A pack that turned it off would
 * show every resist 50 high at level 1; if that ever appears in a capture, this is why.
 */

import { SINGLE_ELEMENTS } from "@cte2/schema";

import { context, type Env, type StatContext } from "../context.js";
import { sourceToExact, type ExactMod } from "../modifier.js";

/** The grant at a given level, as the four sequential `if`s resolve it. */
export function newbieResistValue(level: number): number {
  let value = 50;
  if (level > 24) value = 25;
  if (level > 49) value = 0;
  if (level > 74) value = -25;
  return value;
}

export function collectNewbieResists(env: Env): StatContext[] {
  const value = newbieResistValue(env.level);

  const mods: ExactMod[] = SINGLE_ELEMENTS.filter((ele) => ele.name !== "Physical").map((ele) =>
    sourceToExact(
      // `ExactStatData.noScaling` — the grant is the same number at every level. What changes
      // with level is which of the four branches produced it, not how it scales.
      { statId: `${ele.guid}_resist`, type: "FLAT", v1: value, scaleToLvl: false },
      env.level,
      env.index.shapeOf(`${ele.guid}_resist`),
      env.balance,
    ),
  );

  return [context("NEWBIE_RESISTS", "newbie_resists", "character.level", mods)];
}
